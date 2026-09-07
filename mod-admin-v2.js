/* ═══════════════════════════════════════════════════════════════════════
   ⛃ mod-admin-v2.js — BACKUP DO SISTEMA (rotas /api/admin/v2/backup/*)
   ─────────────────────────────────────────────────────────────────────────
   Contrato modular do projeto (inalterado):

     createAdminV2Router(ctx) → async (req,res,pathname) →
       true  = rota tratada
       false = server segue o fluxo normal

   HISTÓRICO (dono, 18/07/2026): este módulo nasceu como backend do painel
   admin-v2.html ("Central de Comando", v932) com 18 rotas — dashboard,
   edição universal de usuário, correção de pagamento, bots, IA, logs,
   financeiro, relatórios, config. O painel V2 foi abandonado (toda a
   evolução real — fonte canônica, trilha do financeiro, acerto único —
   aconteceu no painel clássico /admin), mas as rotas continuavam expostas:
   user/edit e payment/fix-value eram uma SEGUNDA PORTA para editar dinheiro
   e conceder admin, sem as proteções novas do fluxo oficial
   (POST /api/admin/financeiro: motivo obrigatório, trilha em
   DB_FINANCEIRO.alteracoes, revisão da IA, rollback se a gravação falhar).
   Ficou só o que o painel clássico realmente usa: BACKUP (snapshot manual
   de /data, listagem e restore) + a auditoria permanente dessas ações
   em /data/audit_v2.json (quem, quando, o quê, IP, dispositivo).
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

function createAdminV2Router(ctx){
  const { getSess, getUser, isAdminVip, json, readBody, DATA_DIR } = ctx;

  /* ───────────────────────── Auditoria permanente ───────────────────── */
  const AUDIT_FILE = path.join(DATA_DIR, "audit_v2.json");
  let DB_AUDIT = [];
  try{ DB_AUDIT = JSON.parse(fs.readFileSync(AUDIT_FILE,"utf8")); if(!Array.isArray(DB_AUDIT)) DB_AUDIT=[]; }catch{ DB_AUDIT=[]; }
  let _auditTimer=null;
  function persistAudit(){
    clearTimeout(_auditTimer);
    _auditTimer=setTimeout(()=>{ try{
      const tmp=AUDIT_FILE+".tmp";
      fs.writeFileSync(tmp,JSON.stringify(DB_AUDIT));
      fs.renameSync(tmp,AUDIT_FILE);
    }catch(e){ console.warn("[audit-v2]",e.message); } },300);
  }
  function clientIp(req){
    return (req.headers["x-forwarded-for"]||"").split(",")[0].trim() || req.socket?.remoteAddress || "?";
  }
  function audit(req, entry){
    const rec = {
      id: crypto.randomBytes(6).toString("hex"),
      ts: Date.now(),
      admin: entry.admin || "?",
      sessionEmail: entry.sessionEmail || "",
      action: entry.action || "edit",
      target: entry.target || "",
      field: entry.field || "",
      oldValue: entry.oldValue===undefined ? null : entry.oldValue,
      newValue: entry.newValue===undefined ? null : entry.newValue,
      reason: entry.reason || "",
      note: entry.note || "",
      ip: clientIp(req),
      device: (req.headers["user-agent"]||"").slice(0,180),
    };
    DB_AUDIT.push(rec);
    persistAudit();
    return rec;
  }

  /* ─────────────────────────── Helpers ──────────────────────────────── */
  function requireAdmin(req,res){
    const s=getSess(req);
    if(!s?.user_email){ json(res,401,{error:"Não autenticado. Faça login pelo app e volte."}); return null; }
    const u=getUser(s.user_email);
    if(!isAdminVip(u)){ json(res,403,{error:"Acesso restrito a administradores."}); return null; }
    return s;
  }
  async function body(req){ try{ return JSON.parse((await readBody(req))||"{}"); }catch{ return null; } }

  /* ═══════════════════════════ ROUTER ════════════════════════════════ */
  return async function handleAdminV2Routes(req,res,pathname){
    if(!pathname.startsWith("/api/admin/v2/")) return false;
    const s=requireAdmin(req,res); if(!s) return true;
    const route=pathname.slice("/api/admin/v2/".length);
    const now=Date.now();

    /* ── BACKUP ─────────────────────────────────────────────────────── */
    const BK_DIR=path.join(DATA_DIR,"backups");
    if(route==="backup/list"&&req.method==="GET"){
      let list=[]; try{ list=fs.readdirSync(BK_DIR).filter(d=>/^\d{4}-/.test(d)).sort().reverse().map(d=>{const p=path.join(BK_DIR,d);let files=[];try{files=fs.readdirSync(p);}catch{}return{name:d,files:files.length};}); }catch{}
      json(res,200,{ok:true,backups:list.slice(0,60)}); return true;
    }
    if(route==="backup/create"&&req.method==="POST"){
      const b=await body(req)||{};
      const adminName=(b.adminName||"").trim();
      if(!adminName){json(res,400,{error:"Informe o nome do administrador responsável."});return true;}
      try{
        const stamp=new Date(now-3*3600_000).toISOString().replace(/[:T]/g,"-").slice(0,19);
        const dir=path.join(BK_DIR,stamp); fs.mkdirSync(dir,{recursive:true});
        let n=0;
        for(const f of fs.readdirSync(DATA_DIR)){
          if(!f.endsWith(".json"))continue;
          try{fs.copyFileSync(path.join(DATA_DIR,f),path.join(dir,f));n++;}catch{}
        }
        // v27-FIX (ensaio de restauração): os PDFs dos usuários vivem em cvs/
        // (desde a v21 não estão mais dentro do users.json) — backup sem eles
        // restaurava contas SEM currículo. Agora a pasta vai junto.
        try{
          const cvsDir=path.join(DATA_DIR,"cvs");
          if(fs.existsSync(cvsDir)){fs.cpSync(cvsDir,path.join(dir,"cvs"),{recursive:true});n+=fs.readdirSync(cvsDir).length;}
        }catch{}
        audit(req,{admin:adminName,sessionEmail:s.user_email,action:"backup_create",target:"sistema",field:"backup",newValue:stamp,note:`${n} arquivos`});
        json(res,200,{ok:true,name:stamp,files:n});
      }catch(e){json(res,500,{error:e.message});}
      return true;
    }
    if(route==="backup/restore"&&req.method==="POST"){
      const b=await body(req); if(!b){json(res,400,{error:"Body inválido."});return true;}
      const adminName=(b.adminName||"").trim();
      if(!adminName||b.confirm!=="RESTAURAR"){json(res,400,{error:'Envie adminName e confirm:"RESTAURAR".'});return true;}
      const name=String(b.name||"").replace(/[^0-9\-]/g,"");
      const dir=path.join(BK_DIR,name);
      if(!name||!fs.existsSync(dir)){json(res,404,{error:"Backup não encontrado."});return true;}
      try{
        // segurança: snapshot automático antes de restaurar
        const pre=path.join(BK_DIR,"pre-restore-"+Date.now());fs.mkdirSync(pre,{recursive:true});
        for(const f of fs.readdirSync(DATA_DIR))if(f.endsWith(".json"))try{fs.copyFileSync(path.join(DATA_DIR,f),path.join(pre,f));}catch{}
        let n=0;
        for(const f of fs.readdirSync(dir)){
          const src=path.join(dir,f);
          try{
            if(f==="cvs"&&fs.statSync(src).isDirectory()){fs.cpSync(src,path.join(DATA_DIR,"cvs"),{recursive:true});n++;continue;}
            fs.copyFileSync(src,path.join(DATA_DIR,f));n++;
          }catch{}
        }
        // v27-FIX (ARMADILHA DO SQLITE): com o storage SQLite ativo, o boot lê
        // do h2bapply.db e IGNORA os JSONs restaurados — o restore ficava
        // silenciosamente inútil. Apagar o .db força o boot a re-importar dos
        // JSONs restaurados (comportamento nativo do storage: 1ª vez importa).
        for(const dbf of ["h2bapply.db","h2bapply.db-wal","h2bapply.db-shm"]){
          try{fs.unlinkSync(path.join(DATA_DIR,dbf));}catch{}
        }
        audit(req,{admin:adminName,sessionEmail:s.user_email,action:"backup_restore",target:"sistema",field:"backup",newValue:name,note:`${n} arquivos restaurados (PDFs inclusos) + SQLite resetado pra re-importar; reinicie o servidor`});
        json(res,200,{ok:true,restored:n,aviso:"Arquivos restaurados (PDFs inclusos) e SQLite preparado pra re-importar. REINICIE o servidor para concluir."});
      }catch(e){json(res,500,{error:e.message});}
      return true;
    }

    json(res,404,{error:"Rota v2 desconhecida: "+route});
    return true;
  };
}

module.exports={createAdminV2Router};
