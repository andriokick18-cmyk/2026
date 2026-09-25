/* ═══════════════════════════════════════════════════════════════════════
   🩺 src/sentinel.js — Fase 1 · Módulo 3 (extraído do server.js)
   Health Sentinel com INJEÇÃO DE DEPENDÊNCIAS: initSentinel(ctx) recebe
   getters para o estado vivo do servidor (DB_* podem ser reatribuídos no
   boot, por isso getters e não referências). Este é o MOLDE para extrair
   os demais módulos com estado (watchdogs, engine).
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

function initSentinel(ctx){
// ══════════════════════════════════════════════════════════════════════════
//  🩺 HEALTH SENTINEL v1.0 — Módulo de saúde automática (Auditoria 03/07/2026)
//  Resolve os achados da auditoria Gemini:
//   1. VIP ativo com robô inativo/finished/pausado (dessincronização) → notifica
//   2. VIP expirando em ≤3 dias → lembrete de renovação automático
//   3. Pedido de plano pendente há >6h → alerta por e-mail ao ADMIN
//   4. Fila com e-mails inválidos (caso 7532x) → sanitização periódica
//   5. VIPs ativos sem CV cadastrado → listados no relatório do admin
//  Autocontido: só usa helpers já existentes. Nada do código antigo é alterado.
// ══════════════════════════════════════════════════════════════════════════





// Relatório vivo consultável pelo painel admin
global._healthSentinel = {
  lastRun: 0, runs: 0,
  vipDesync: [], vipExpiring: [], pedidosPendentes: [],
  filaSanitizada: { removidos: 0, ultimaLimpeza: 0, detalhes: [] },
  vipsSemCv: [], notificados: []
};

// ── 1+2. Watchdog de dessincronização VIP↔robô + lembrete de renovação ─────
async function healthSentinelRun(){
  const S = global._healthSentinel;
  const now = Date.now();
  S.lastRun = now; S.runs++;
  S.vipDesync = []; S.vipExpiring = []; S.vipsSemCv = [];
  const notified = [];

  for(const [email, u] of Object.entries(ctx.DB_USERS()||{})){
    if(!u || !ctx.isVipActive(u)) continue;
    const exp = Math.max(u.vip?.manualExpires||0, u.vip?.autoExpires||0);
    // v318 (auditoria contínua) — este módulo reimplementava "dias restantes"
    // com Math.ceil((exp-now)/86400000), o EXATO bug que o v237p já tinha
    // varrido e trocado por diasRestantesCanonico() (dia CIVIL em BRT, nunca
    // fração de milissegundo) em 8 outros lugares de server.js/app.js. Este
    // arquivo escapou da varredura por ser um módulo separado (injeção de
    // dependências via initSentinel(ctx)) — nunca tinha o helper no ctx.
    const diasRestantes = exp>now ? Math.max(0, ctx.diasRestantesCanonico(exp, now)) : 0;
    const job = ctx.getAutoJob(email);
    // v18-FIX: antes "!job.active" sozinho já bastava pra disparar "robô
    // quebrado, faça login de novo" — inclusive quando a PRÓPRIA pessoa pausou
    // deliberadamente (/api/auto/pause → active:false,status:"paused") ou o
    // admin parou manualmente (status:"parado_admin"). O regex de status
    // genuinamente quebrado abaixo nunca chegava a ser o critério decisivo,
    // porque "!job.active" já cobria (e disparava falso-positivo para) TODOS
    // os casos de pausa, inclusive as intencionais. Agora só conta como
    // desync real quando não há job nenhum ou o status é um dos que realmente
    // significam "quebrado" (não uma pausa escolhida por alguém).
    // 🚨 v177-FIX (auditoria 14/09/2026): o regex nunca incluía os 3 status
    // reais que o server.js de fato atribui a robô quebrado por auth —
    // paused_no_session (sessão expirou), paused_oauth_expired (watchdog) e
    // paused_account_suspended (conta Google suspensa) — só o antigo
    // "paused_no_refresh_token", que nenhuma rota usa mais. Um VIP pagante
    // com o automático morto por qualquer um desses 3 motivos era invisível
    // pra S.vipDesync/healthSentinelRun: nenhum push, nenhum alerta ao
    // admin, ninguém do time via o caso — dinheiro pago, robô parado, em
    // silêncio, potencialmente por semanas (regra 15: "admin = dinheiro
    // primeiro").
    const jobParado = !job ||
      /^(inativo|finished|paused_auth_error|paused_token_revoked|paused_no_refresh_token|paused_no_session|paused_oauth_expired|paused_account_suspended)$/.test(job.status||"");
    const tokenOk = !!(u.cached_access_token && u.cached_token_expiry && now < u.cached_token_expiry);
    const diasInativo = Math.round((now-(u.lastSeenAt||0))/86400000);

    // 1) VIP com robô parado (a dessincronização da auditoria)
    if(jobParado && diasInativo <= 30){
      S.vipDesync.push({ email, nome:u.name||"", plano:u.vip?.plan||"vip",
        status: job?.status||"sem_job", tokenOk, diasRestantes, diasInativo });
      // Notifica no máx. 1x/22h (cooldown já embutido no sendNotifEmail)
      try{ await ctx.sendNotifEmail(email, "vip_desync"); notified.push({email,tipo:"vip_desync"}); }catch(e){}
      // v18-FIX: fallback por push — sendNotifEmail está bloqueado pelo
      // kill-switch de e-mail do dono; push é um canal separado, não contorna
      // a decisão dele, só evita que o pagante fique 100% sem aviso.
      if(ctx.pushToUser)ctx.pushToUser(email,{type:"vip_desync",title:"🤖 Seu robô está parado",body:"Seu plano está ativo mas o envio automático parou. Abra o H2BApply pra reativar.",icon:"/icon-192.png"}).catch(()=>{});
      await new Promise(r=>setTimeout(r,1500));
    }

    // 2) VIP expirando em ≤3 dias → lembrete de renovação
    if(exp>now && exp < now + 3*86400_000 && diasInativo <= 45){
      S.vipExpiring.push({ email, nome:u.name||"", plano:u.vip?.plan||"vip",
        expiraEm:new Date(exp).toISOString().slice(0,10), diasRestantes });
      try{ await ctx.sendNotifEmail(email, "vip_expiring"); notified.push({email,tipo:"vip_expiring"}); }catch(e){}
      if(ctx.pushToUser)ctx.pushToUser(email,{type:"vip_expiring",title:"⏳ Seu plano expira em breve",body:"Renove pra não perder o envio automático.",icon:"/icon-192.png"}).catch(()=>{});
      await new Promise(r=>setTimeout(r,1500));
    }

    // 5) VIP ativo sem CV cadastrado → relatório (sem spam por e-mail)
    if(!(u.cvs||[]).length) S.vipsSemCv.push({ email, nome:u.name||"", plano:u.vip?.plan||"vip" });

    // 6) VIP ativo sem PERFIL de currículo → robô não consegue trabalhar (paga e não usa)
    if(!(u.profiles||[]).length){
      (S.vipsSemPerfil=S.vipsSemPerfil||[]).push({ email, nome:u.name||"", plano:u.vip?.plan||"vip" });
      if(diasInativo <= 15){ // só usuários recentes — não incomoda quem abandonou
        try{ await ctx.sendNotifEmail(email, "no_profile"); notified.push({email,tipo:"no_profile"}); }catch(e){}
        if(ctx.pushToUser)ctx.pushToUser(email,{type:"no_profile",title:"🚗 Seu robô está sem motorista",body:"Falta criar seu Perfil de Currículo pra ele começar a enviar candidaturas.",icon:"/icon-192.png"}).catch(()=>{});
        await new Promise(r=>setTimeout(r,1500));
      }
    }
  }

  // 7) Jobs presos em paused_no_vip (estado legado ou revogação de trial).
  //    LIÇÃO KB-860: NÃO resetar automaticamente (pode ser punição intencional).
  //    Apenas listar para o admin decidir caso a caso (rota release-no-vip).
  S.pausedNoVip = Object.entries(ctx.DB_AUTO()||{})
    .filter(([,j])=>j?.status==="paused_no_vip")
    .map(([e,j])=>({ email:e, desde: j.finishedAt?new Date(j.finishedAt).toISOString().slice(0,10):"?", fila:(j.queue||[]).length }));
  // 8) 🔑 CANAL DE E-MAIL DO SISTEMA.
  //    v183 LOTE 1: até aqui o vigia media a saúde das notificações pelo
  //    GMAIL PESSOAL do ADMIN_EMAIL — canal que deixou de ser o principal no
  //    v175: quem manda código de cadastro, código de senha e aviso de pedido
  //    é a CONTA DE NOTIFICAÇÕES (mod-notif). Pior: desde o v172c/v177-FIX a
  //    conta do admin vive sob o USERNAME reservado, então getUser(ADMIN_EMAIL)
  //    é null e o bloco gritava a cada 6h que o token do admin estava
  //    quebrado e as notificações "mudas", pintando de vermelho a linha
  //    de "Últimas ações dos
  //    robôs" — treinando o dono a ignorar justamente o log onde o alarme de
  //    verdade aparece. Agora o ALARME é sobre a conta de notificações; o
  //    Gmail pessoal do admin continua medido, mas como RESERVA (é o que o
  //    pendingOrderAlert abaixo usa), em nível informativo.
  S.notif = { ok:false };
  try{ S.notif={ ok: typeof ctx.notifConectada==="function" ? !!ctx.notifConectada() : false }; }
  catch(e){ S.notif={ ok:false, error:e.message }; }
  if(!S.notif.ok) console.error("[health-sentinel] 🚨 Conta de NOTIFICAÇÕES desconectada — códigos de cadastro, recuperação de senha e aviso de pedido novo NÃO saem. Conecte em Admin → Notificações.");

  S.adminToken = { ok:false, via:null, error:null };
  try{
    const adminSess = Object.entries(ctx.sessions()).find(([,x])=>x.user_email===ctx.ADMIN_EMAIL&&x.access_token);
    if(adminSess){ S.adminToken={ok:true,via:"sessão",error:null}; }
    else{
      const au=ctx.getUser(ctx.ADMIN_EMAIL);
      if(au?.refresh_token){ await ctx.refreshTokenForUser(ctx.ADMIN_EMAIL); S.adminToken={ok:true,via:"refresh_token",error:null}; }
      else S.adminToken={ok:false,via:null,error:"Admin sem sessão e sem refresh_token"};
    }
  }catch(e){ S.adminToken={ok:false,via:null,error:e.message}; }
  if(!S.adminToken.ok) console.warn(`[health-sentinel] ℹ️ Gmail pessoal do admin não conectado — a RESERVA do aviso de pedido e o alerta de pedido pendente deste vigia não saem por esse canal; o canal principal é a conta de notificações (${S.notif.ok?"conectada":"TAMBÉM desconectada"}).`);

  // 9) 📋 MONITOR DE PLANILHAS — "parado porque terminou" ≠ "dados envelhecendo"
  //    🚨 v199 LOTE 18: este bloco NUNCA rodou. `typeof getSheet==="function"`
  //    testava uma global `getSheet` que não existe dentro do módulo (a função
  //    chega por injeção, em `ctx.getSheet`), então TODA planilha caía no
  //    `null` do ternário e `S.planilhas` era SEMPRE [] — o resumo do vigia
  //    dizia "0 planilha(s) com alerta" mesmo com uma planilha envelhecida ou
  //    sem e-mail nenhum. Junto vinham 2 verdades paralelas: a lista de
  //    planilhas era montada aqui à mão (sem a H-2A built-in, sem tirar
  //    rascunho) e "enriquecida" era medida só por e-mail, enquanto desde o
  //    v182 LOTE 8 "completa" é a lista única CAMPOS_ESSENCIAIS
  //    (e-mail + cidade + datas + descrição). Agora a lista vem da MESMA
  //    função que o robô de frescor usa (planilhas publicadas) e o progresso
  //    da MESMA `progressoPlanilha` do painel.
  S.planilhas = [];
  try{
    const keys = typeof ctx.planilhasPublicadas==="function"
      ? (ctx.planilhasPublicadas()||[])
      : ["jan2026","jul2025","h2a-jun2026",...Object.keys(ctx.SHEET_EXTRAS()||{})];
    for(const k of [...new Set(keys)]){
      const sheet=(typeof ctx.getSheet==="function")?ctx.getSheet(k):null;
      if(!Array.isArray(sheet)||!sheet.length) continue;
      const prog=(typeof ctx.progressoPlanilha==="function")?ctx.progressoPlanilha(sheet):null;
      const withEmail=sheet.filter(r=>r.e&&String(r.e).includes("@")).length;
      const pct=Math.round(withEmail/sheet.length*100);
      const pctCompletas=prog?Math.round(prog.completas/sheet.length*100):null;
      const meta=(ctx.DB_SHEETS_META()||{})[k]||{};
      const idadeDias=meta.enrichedAt?Math.round((now-meta.enrichedAt)/86400000):null;
      S.planilhas.push({ planilha:k, vagas:sheet.length, comEmail:withEmail, pct, pctCompletas,
        pendentes: prog?prog.pendentes:null,
        ultimoEnriquecimento: meta.enrichedAt?new Date(meta.enrichedAt).toISOString().slice(0,10):"nunca",
        // Sem e-mail é o alarme nº1 (sem contato não existe candidatura); só
        // depois vem "o robô ainda não completou" e o envelhecimento.
        alerta: pct<90 ? "⚠️ <90% com e-mail"
          : (pctCompletas!==null&&pctCompletas<50 ? "🧩 <50% completas (robô ainda alimentando)"
          : (idadeDias!==null&&idadeDias>30 ? "🕰️ enriquecimento >30 dias" : null)) });
    }
  }catch(e){ console.warn("[health-sentinel] planilhas:",e.message); }

  // 10) 🔄 RE-ENGAJAMENTO "FINISHED" — fila vazia há >3 dias, usuário ativo ≤14d
  S.finishedIdle = [];
  for(const [email, job] of Object.entries(ctx.DB_AUTO()||{})){
    if(job?.status!=="finished") continue;
    const desde=job.finishedAt||0;
    if(!desde || now-desde < 3*86400_000) continue;
    const u=ctx.getUser(email); if(!u) continue;
    const diasInativo=Math.round((now-(u.lastSeenAt||0))/86400000);
    S.finishedIdle.push({ email, nome:u.name||"", desde:new Date(desde).toISOString().slice(0,10), diasInativo });
    const lastRefill=(global._refillNotifiedAt=global._refillNotifiedAt||{})[email]||0;
    if(diasInativo<=14 && now-lastRefill > 7*86400_000){
      try{ await ctx.sendNotifEmail(email,"refill"); global._refillNotifiedAt[email]=now; notified.push({email,tipo:"refill"}); }catch(e){}
      await new Promise(r=>setTimeout(r,1500));
    }
  }

  S.notificados = notified.slice(-100);

  // 📜 Log unificado (aba "Logs dos Robôs" no admin) — 1 linha-resumo por
  // execução, sem spammar 1 linha por usuário.
  try{
    if(typeof ctx.botLog==="function"){
      const alertasPlanilha=(S.planilhas||[]).filter(p=>p.alerta).length;
      ctx.botLog('sentinel','Health Sentinel',
        `Rodou: ${S.vipDesync.length} VIP c/ robô parado, ${S.vipExpiring.length} expirando em breve, `+
        `${(S.vipsSemPerfil||[]).length} sem perfil, ${S.finishedIdle.length} p/ reengajar, `+
        `${alertasPlanilha} planilha(s) com alerta, ${notified.length} notificação(ões) enviada(s), `+
        `conta de notificações: ${S.notif?.ok?'ok':'🚨 DESCONECTADA'}`+
        `${S.adminToken?.ok?'':' · Gmail pessoal do admin: não conectado (reserva)'}`,
        // v183 LOTE 1: o que torna a linha VERMELHA é o canal que realmente
        // manda e-mail hoje (mod-notif), não o Gmail pessoal do admin.
        S.notif?.ok?'info':'error');
    }
  }catch(e){}

  // 🧹 Higiene de memória (varredura total 03/07): poda os mapas de cooldown
  // que crescem 1 chave por usuário/evento para sempre (vazamento lento).
  try{
    const prune=(obj,maxAgeMs)=>{ if(!obj)return; const cut=now-maxAgeMs; for(const k of Object.keys(obj)){ if((obj[k]||0)<cut) delete obj[k]; } };
    prune(ctx.cooldownMaps?.notifSentAt?.(), 7*86400_000);
    prune(ctx.cooldownMaps?.authErrNotifiedAt?.(), 7*86400_000);
    prune(typeof _pedAlertSent!=="undefined"?_pedAlertSent:null, 14*86400_000);
    prune(global._refillNotifiedAt, 30*86400_000);
  }catch(e){}
  if(S.vipDesync.length||S.vipExpiring.length)
    console.log(`[health-sentinel] 🩺 desync:${S.vipDesync.length} expirando:${S.vipExpiring.length} semCV:${S.vipsSemCv.length} notificados:${notified.length}`);
}
setInterval(()=>healthSentinelRun().catch(e=>console.error("[health-sentinel]",e.message)), 6*60*60*1000); // a cada 6h
setTimeout(()=>healthSentinelRun().catch(()=>{}), 90*1000); // primeira varredura 90s após boot

// ── 3. Alerta ao ADMIN de pedido pendente há >6h ────────────────────────────
const _pedAlertSent = ctx.pedAlertSentInit || {}; // {pedidoId: ts} — V951: persistido em disco (sobrevive a deploy)
async function pendingOrderAlert(){
  const now = Date.now();
  const pend = (ctx.DB_PEDIDOS()||[]).filter(p=>p.status==="pendente" && (now-(p.createdAt||0))>6*3600_000);
  // 🐛 v309 (achado de auditoria contínua): pedido só tem `userEmail` (nunca
  // `.email` — confirmado em server.js, onde o objeto nasce). p.email era
  // sempre undefined aqui — o painel admin via "undefined" no lugar do
  // cliente em pedidosPendentes, e o e-mail de alerta aos admins (assunto E
  // corpo) saía com "Usuário: undefined", inútil pra identificar quem
  // aprovar. Desde sempre quebrado, silencioso — nenhum teste checava esse
  // campo.
  global._healthSentinel.pedidosPendentes = pend.map(p=>({
    id:p.id, email:p.userEmail, plano:p.plano, valor:p.valorTotal||p.valor,
    horasPendente: Math.round((now-(p.createdAt||0))/3600_000)
  }));
  if(!pend.length) return;
  // 🐛 BUG REAL (achado em auditoria, 12/09/2026): esta rotina só tentava
  // ctx.ADMIN_EMAIL e dava `break` no loop INTEIRO se não achasse token —
  // se o admin principal ficasse com o Gmail desconectado, TODOS os pedidos
  // pendentes da rodada (não só o atual) paravam de ser alertados, em
  // silêncio, pra sempre (até alguém notar sozinho e reconectar). Mesmo
  // fallback de 3 níveis já usado no aviso de "pedido novo" (server.js,
  // rota /api/pedido) — resolvido UMA vez por rodada, fora do loop de
  // pedidos, e avisando TODOS os admins (ADMIN_EMAILS), não só o principal.
  let adminToken=null, adminTokenFrom=null;
  const sessAll=Object.values(ctx.sessions()||{});
  const primarySess=sessAll.find(s=>s.user_email===ctx.ADMIN_EMAIL&&s.access_token);
  if(primarySess) adminToken=primarySess.access_token, adminTokenFrom=ctx.ADMIN_EMAIL;
  if(!adminToken){ try{ const t=await ctx.refreshTokenForUser(ctx.ADMIN_EMAIL); if(t){ adminToken=t; adminTokenFrom=ctx.ADMIN_EMAIL; } }catch{} }
  if(!adminToken){
    for(const ae of ctx.ADMIN_EMAILS||[]){
      if(ae===ctx.ADMIN_EMAIL) continue;
      const se=sessAll.find(s=>s.user_email===ae&&s.access_token);
      if(se){ adminToken=se.access_token; adminTokenFrom=ae; break; }
      try{ const t=await ctx.refreshTokenForUser(ae); if(t){ adminToken=t; adminTokenFrom=ae; break; } }catch{}
    }
  }
  if(!adminToken){ console.warn("[health-sentinel] ⚠️ NENHUM admin com token válido — alerta de pedido pendente NÃO enviado nesta rodada. Reconecte o Gmail admin."); return; }
  for(const p of pend){
    if(_pedAlertSent[p.id] && now-_pedAlertSent[p.id] < 12*3600_000) continue; // realerta a cada 12h
    const horas=Math.round((now-(p.createdAt||0))/3600_000);
    let algumEnviado=false;
    for(const toEmail of (ctx.ADMIN_EMAILS||[ctx.ADMIN_EMAIL])){
      try{
        const raw=ctx.buildMime({ to:toEmail, subject:`🔔 [H2BApply] Pedido pendente há ${horas}h — ${p.userEmail} (${p.plano})`,
          fromName:"H2BApply Sentinel 🩺", fromEmail:adminTokenFrom,
          text:`Pedido aguardando aprovação:\n\nUsuário: ${p.userEmail}\nPlano: ${p.plano}\nValor: R$ ${p.valorTotal||p.valor||"?"}\nPendente há: ${horas} horas\nID: ${p.id}\n\nAprove no painel admin → Pedidos para não perder a conversão.` });
        const {status}=await ctx.httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",
          headers:{"Authorization":"Bearer "+adminToken,"Content-Type":"application/json"}},{raw});
        if(status===200) algumEnviado=true;
      }catch(e){ console.warn("[health-sentinel] alerta pedido:",e.message); }
    }
    if(algumEnviado){ _pedAlertSent[p.id]=now; console.log(`[health-sentinel] 📧 Admin(s) alertado(s): pedido ${p.id} pendente ${horas}h`); }
    await new Promise(r=>setTimeout(r,2000));
  }
}
setInterval(()=>pendingOrderAlert().catch(e=>console.error("[health-sentinel/pedidos]",e.message)), 60*60*1000); // a cada 1h
setTimeout(()=>pendingOrderAlert().catch(()=>{}), 2*60*1000);

// ── 4. Sanitizador de fila: remove e-mails inválidos conhecidos + duplicatas
//      em massa (caso stevenson.eros 7532x da auditoria) ─────────────────────
function queueSanitizerRun(){
  const S = global._healthSentinel.filaSanitizada;
  const invalid = new Set(Object.keys(ctx.DB_INVALID_EMAILS()||{}).map(e=>e.toLowerCase()));
  let totalRemoved = 0; const detalhes=[];
  for(const [email, job] of Object.entries(ctx.DB_AUTO()||{})){
    if(!Array.isArray(job?.queue) || !job.queue.length) continue;
    const before = job.queue.length;
    const seen = Object.create(null); // dedup: mantém no máx. 2 ocorrências do mesmo destino
    const clean = job.queue.filter(item=>{
      const to = String(item?.to||"").toLowerCase();
      if(!to) return true;
      if(invalid.has(to)) return false;                 // e-mail já marcado inválido/bounce
      seen[to]=(seen[to]||0)+1;
      return seen[to] <= 2;                             // corta repetição em massa (7532x)
    });
    const removed = before - clean.length;
    if(removed > 0){
      ctx.setAutoJob(email, { queue: clean });
      totalRemoved += removed;
      detalhes.push({ usuario: email, removidos: removed, filaAntes: before, filaDepois: clean.length });
      console.log(`[health-sentinel] 🧹 Fila de ${email}: ${removed} itens inválidos/duplicados removidos (${before}→${clean.length})`);
    }
  }
  if(totalRemoved>0){
    S.removidos += totalRemoved; S.ultimaLimpeza = Date.now();
    S.detalhes = detalhes.concat(S.detalhes).slice(0,50);
  }
}
setInterval(()=>{ try{queueSanitizerRun();}catch(e){console.error("[health-sentinel/fila]",e.message);} }, 2*60*60*1000); // a cada 2h
setTimeout(()=>{ try{queueSanitizerRun();}catch(e){} }, 3*60*1000);

console.log("[health-sentinel] 🩺 Módulo carregado: desync VIP↔robô, lembrete de renovação, alerta de pedidos, sanitização de fila.");

  return { healthSentinelRun, pendingOrderAlert, queueSanitizerRun, getPedAlertSent: ()=>_pedAlertSent };
}
module.exports = { initSentinel };
