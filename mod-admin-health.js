/* ═══════════════════════════════════════════════════════════════════════
   🩺 src/routes/admin-health.js — Fase 1 · Módulo 5 (extraído À MÃO)
   Grupo coeso: 7 rotas de saúde/operação do admin.
   Por que à mão e não mecânico: o bloco admin completo tem ~780 símbolos
   externos — regex ali é "risco puro" (lição da própria KB). Rotas saem
   do monólito em grupos pequenos, com ctx explícito e corpo idêntico.

   Contrato: createAdminHealthRouter(ctx) → async (req,res,pathname) →
   true se tratou a rota, false para o server seguir o fluxo normal.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

function createAdminHealthRouter(ctx){
  const { getSess, getUser, isAdminVip, isAdminEmail, json, readBody,
          DB_USERS, DB_AUTO, DB_PEDIDOS, getAutoJob, setAutoJob,
          sendNotifEmail, storageInfo,
          queueSanitizerRun, healthSentinelRun, pendingOrderAlert } = ctx;

  return async function handleAdminHealthRoutes(req, res, pathname){

    // ── M01: Health summary rápido ───────────────────────────
    if(pathname==="/api/admin/health-summary"&&req.method==="GET"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."}),true;
      const now=Date.now();
      const users=Object.values(DB_USERS()||{});
      const authErrUsers=Object.entries(DB_AUTO()||{}).filter(([,j])=>j?.status==="paused_auth_error").map(([e])=>e);
      const pendCriticos=(DB_PEDIDOS()||[]).filter(pd=>pd.status==="pendente"&&(now-(pd.createdAt||0))>24*3600_000);
      const vipExpiring=users.filter(u=>{const exp=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);return exp>0&&exp>now&&exp<now+3*86400_000;});
      json(res,200,{ok:true,score:authErrUsers.length===0&&pendCriticos.length===0?100:Math.max(60,100-authErrUsers.length*5-pendCriticos.length*10),authErrCount:authErrUsers.length,pedidosCriticos:pendCriticos.length,vipExpiring:vipExpiring.length,totalUsers:users.length,activeAuto:Object.values(DB_AUTO()||{}).filter(j=>j?.active).length,timestamp:now});
      return true;
    }

    // ── Diagnóstico do storage engine (Fase 4) ────────────────
    if(pathname==="/api/admin/storage-info"&&req.method==="GET"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."}),true;
      json(res,200,{ok:true,storage:storageInfo()});
      return true;
    }

    // ── 🩺 HEALTH SENTINEL: relatório vivo ────────────────────
    if(pathname==="/api/admin/health-sentinel"&&req.method==="GET"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."}),true;
      json(res,200,{ok:true,report:global._healthSentinel||{}});
      return true;
    }

    // ── 🩺 Execução manual da varredura ───────────────────────
    if(pathname==="/api/admin/health-sentinel/run"&&req.method==="POST"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."}),true;
      try{
        if(typeof queueSanitizerRun==="function")queueSanitizerRun();
        if(typeof healthSentinelRun==="function")await healthSentinelRun();
        if(typeof pendingOrderAlert==="function")await pendingOrderAlert();
        console.log(`[health-sentinel] ▶️ Execução manual por ${s.user_email}`);
        json(res,200,{ok:true,report:global._healthSentinel});
      }catch(e){json(res,500,{error:e.message});}
      return true;
    }

    // ── 🔓 Libera 1 job preso em paused_no_vip (caso-a-caso — KB-860) ──
    if(pathname==="/api/admin/health-sentinel/release-no-vip"&&req.method==="POST"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."}),true;
      let b={};try{b=JSON.parse((await readBody(req))||"{}");}catch{json(res,400,{error:"Body inválido."});return true;}
      const email=(b.email||"").trim().toLowerCase();
      const job=getAutoJob(email);
      if(!job||job.status!=="paused_no_vip"){json(res,404,{error:"Job não está em paused_no_vip."});return true;}
      setAutoJob(email,{...job,status:"inativo"}); // NÃO reativa envio — só destrava para o usuário poder ativar
      console.log(`[health-sentinel] 🔓 ${s.user_email} liberou paused_no_vip de ${email} (status→inativo, sem auto-start)`);
      json(res,200,{ok:true,email,novoStatus:"inativo"});
      return true;
    }

    // ── M02: Notificar TODOS com auth_error de uma vez ───────
    if(pathname==="/api/admin/notify-all-auth-error"&&req.method==="POST"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."}),true;
      const authErrEmails=Object.entries(DB_AUTO()||{}).filter(([,j])=>j?.status==="paused_auth_error").map(([e])=>e);
      let sent=0;const failed=[];
      for(const email of authErrEmails){
        try{await sendNotifEmail(email,"auth_error");sent++;await new Promise(r=>setTimeout(r,2000));}
        catch(e){failed.push(email);}
      }
      console.log(`[admin] notify-all-auth-error: ${sent} enviados, ${failed.length} falhas por ${s.user_email}`);
      json(res,200,{ok:true,sent,failed,total:authErrEmails.length});
      return true;
    }

    // ── M03: Log de ações admin ───────────────────────────────
    if(!global._adminActionLog)global._adminActionLog=[];
    if(pathname==="/api/admin/action-log"&&req.method==="GET"){
      const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."}),true;
      if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."}),true;
      json(res,200,{ok:true,log:global._adminActionLog.slice(0,100)});
      return true;
    }

    return false; // não é rota deste grupo — server segue o fluxo
  };
}

module.exports = { createAdminHealthRouter };
