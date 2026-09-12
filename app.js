/* H2BApply app.js — v116: todo o JS do corpo do index.html extraído pra cá.
   MOTIVO (medido): 1,3MB de JS inline eram re-interpretados A CADA abertura
   (HTML nunca é cacheado por causa do cookie de sessão) = ~14s de tela
   travada em celular mediano. Externo + defer: pinta rápido e o navegador
   cacheia/valida por ETag. A ORDEM dos blocos é a mesma do HTML original. */

/* ═══ bloco extraído ═══ */

function esc(s){if(!s&&s!==0)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
// v168 (bug real, auditoria 08/09/2026): valor em reais formatado com toFixed(2)
// puro (ponto decimal, "R$ 150.00") em 2 telas de doação (card Minha Conta,
// lista Minhas doações) — inconsistente com o resto do MESMO fluxo (a
// calculadora de doação já formatava certo com .replace('.',',')). Helper
// único pra nunca mais divergir.
const brl=n=>(+n||0).toFixed(2).replace('.',',');

// ═══════════════════════════════════════════
//  ESTADO
// ═══════════════════════════════════════════
const g = s => document.querySelector(s);

let U={connected:false,email:"",name:"",picture:"",isAdmin:false,plan:"free",vip:null,todaySentManual:0,manualLimit:20,manualRemaining:20,todaySentAuto:0,autoLimit:10,autoRemaining:10,autoEnabled:true,autoJob:null,autoStats:{sent:0,failed:0},onboarded:false};
let CFG={name:"",country:"Brazil",phone:"",city:"",language:"pt-BR",subject:"",body:""};
let DOCS=[],activeResIdx=null,activeCovIdx=null;
// v27: EMPREGADORES BLOQUEADOS (enviados + fila do robô) — fonte única pro
// front inteiro saber se uma vaga é nova de verdade. Regra do dono: usuário
// nunca se preocupa com duplicado; a vaga se identifica sozinha.
let _empSent=new Set(),_empQueued=new Set();
async function loadEmpregadoresBloqueados(){
  try{
    const d=await fetch("/api/sent-emails",{credentials:"include"}).then(r=>r.json());
    if(d.ok){_empSent=new Set(d.sent||[]);_empQueued=new Set(d.queued||[]);}
  }catch(e){}
}
// null = livre | "sent" = já enviada | "queued" = na fila do robô
function empregadorStatus(email){
  const e=String(email||"").toLowerCase().trim();
  if(!e)return null;
  if(_empSent.has(e))return "sent";
  if(_empQueued.has(e))return "queued";
  return null;
}
let JOBS=[],HIST=[],APPLIED=new Set();

// ── Sistema de filtro de vagas ──
var _sentJan=new Set(),_sentJul=new Set(),_sentSeasonal=new Set(),_sentAll=new Set(),_sentLoaded=false;

async function _loadSentIds(){
  try{
    var r=await fetch("/api/sent-ids",{credentials:"include"});
    if(!r.ok)return;
    var d=await r.json();
    _sentJan=new Set(d.jan2026||[]);
    _sentJul=new Set(d.jul2025||[]);
    _sentSeasonal=new Set(d.seasonal||[]);
    // FIX "volta pra estaca zero": conjunto GLOBAL por case number — vale para
    // TODA planilha (H-2A, jul2026 futura...). Antes só jan2026/jul2025 escondiam
    // enviadas; nas outras abas a vaga reaparecia e o clique dava "já enviada".
    _sentAll=new Set(d.all||[]);
    if(!_sentAll.size){[..._sentJan,..._sentJul].forEach(function(c){_sentAll.add(c);});} // compat servidor antigo
    _sentLoaded=true;
  }catch(e){}
}
function _isSent(cn,sheet){
  if(!cn)return false;
  if(_sentAll.has(cn))return true; // case number é único — enviado é enviado em qualquer aba
  if(sheet==="jan2026")return _sentJan.has(cn);
  if(sheet==="jul2025")return _sentJul.has(cn);
  return false;
}
function _isSentSeasonal(id){return _sentSeasonal.has(id);}
function _inAuto(cn){
  return _autoQueueIds.has(cn)||_autoQueueIds.has("s_"+cn)||
         [..._autoQueueIds].some(function(id){return id===cn;});
}

let _autoQueueIds=new Set(); // IDs de vagas na fila automática (ocultas do manual)
let selJob=null,curJob=null;
let _currentModalJob=null; // alias para curJob — atualizado por openModal
let skip=0,total=0,loading=false,done=false;
let tab="seasonal";
let sJobs=[],sTotal=0,sSkip=0,sDone=false,sLoading=false;
let sCache={};
let fQ="",fState="",fType="all",fStat="all",fSort="random",fWage=0,fWorkers=0,fCat="all";
let fGrupos=[]; // Filtro por Grupo (randomização H-2B) — exclusivo Double Pro (MANUAL)
let fEtaStatus=""; // Filtro por Status DOL — exclusivo Double Pro (MANUAL)
// ── Estado dos filtros do AUTOMÁTICO (mesmo modelo do manual) ──
let afTitles=[];      // cargos exatos escolhidos no wizard
let afGrupos=[];      // grupos A–H (Double Pro)
let afEtaStatus="";   // status DOL (Double Pro)
let autoSelectedProfileId=null; // perfil/currículo escolhido no Passo 3
let curView="jobs",histTab="all";
let autoInterval=null;
let _autoCountdown=null;
let autoResIdx=null,autoCovIdx=null;
let autoSelectedSrc=null,autoSelectedCat="all",autoSelectedCats=[];
let sheetCats={};
// Logs
let logSkip=0,logTotal=0,logDone=false;
const LOG_PAGE=50;

// ═══════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════
addEventListener("DOMContentLoaded",async()=>{
  // Injeta planilhas extras publicadas (H-2A, Julho...) nos seletores.
  setTimeout(()=>{ try{ loadDynamicSheets(); }catch(e){} }, 1500);
  // ── Banner offline ─────────────────────────────────────────
  const _offBanner=g("#offline-banner");
  function _updateOnlineStatus(){
    if(_offBanner){_offBanner.style.display=navigator.onLine?"none":"flex";}
    if(!navigator.onLine)toast("📶 Sem conexão com a internet","r");
  }
  window.addEventListener("online",()=>{_updateOnlineStatus();toast("✅ Conexão restaurada","g");});
  window.addEventListener("offline",_updateOnlineStatus);
  if(!navigator.onLine&&_offBanner)_offBanner.style.display="flex";
  const ps=new URLSearchParams(location.search);
  const err=ps.get("err");
  // v157: os erros multi-servidor (conta_outro_srv/srv_lotado) morreram no
  // v156 — o servidor nunca mais os emite; sobrou só o tratamento genérico.
  if(err){
    const el=g("#login-err");
    if(el){
      el.style.display="block";
      el.style.padding="10px 14px";
      el.style.background="rgba(239,68,68,.15)";
      el.style.border="1px solid rgba(239,68,68,.4)";
      el.style.borderRadius="10px";
      el.style.fontWeight="600";
      el.textContent="⚠️ "+err;
      setTimeout(()=>el.scrollIntoView({behavior:"smooth",block:"center"}),300);
    }
    // FIX (2026-07-09): #login-err só existe na tela de LOGIN. Usuário logado
    // (ex.: erro ao conectar Gmail Extra) voltava do Google e não via NADA —
    // parecia que o botão simplesmente não funcionava. Guarda a mensagem pra
    // mostrar como alerta dentro do app assim que ele carregar.
    window._pendingErrMsg=err;
    history.replaceState({},"","/");
  }
  if(ps.get("ok"))history.replaceState({},"","/");
  // 🔒 v172 (ORDEM DO DONO, 11/09/2026): volta do /oauth/connect-send (sucesso
  // ou erro) sempre carrega &tab=, pra devolver a pessoa exatamente onde ela
  // estava tentando enviar (Automático/Manual/Planos), nunca perdida na Home.
  const _csTab=ps.get("tab");
  const _gmailConnected=ps.get("gmailConnected")==="1";
  if(_csTab||_gmailConnected){
    history.replaceState({},"","/");
    window._pendingTab=_csTab||null;
    window._pendingGmailConnected=_gmailConnected;
  }
  await checkStatus();
  setInterval(function(){fetch("/api/warmup",{credentials:"include"}).catch(function(){});},4*60*1000);
});

async function checkStatus(){
  // Esconde landing enquanto verifica sessão (evita flash para usuário já logado)
  const _land=g("#landing");if(_land)_land.style.visibility="hidden";
  try{
    const r=await fetch("/api/status",{credentials:"include"});const d=await r.json();
    if(_land)_land.style.visibility="";
    if(d.connected){
      U={connected:true,email:d.email,name:d.name||d.email,picture:d.picture||"",isAdmin:!!d.isAdmin,plan:d.plan||"free",vip:d.vip||null,todaySentManual:d.todaySentManual||0,manualLimit:d.manualLimit||20,manualRemaining:(d.manualRemaining??20),todaySentAuto:d.todaySentAuto||0,autoLimit:d.autoLimit||10,autoRemaining:(d.autoRemaining??10),autoEnabled:true,autoJob:d.autoJob||null,autoStats:d.autoStats||{sent:0,failed:0},onboarded:!!d.onboarded,profiles:d.profiles||[],senderEmails:d.senderEmails||[],senderMax:d.senderMax||1,adminSettings:d.adminSettings||null,totalSent:d.totalSent||0,totalManual:d.totalManual||0,totalAutoHist:d.totalAutoHist||0,totalReplies:d.totalReplies||0,
  // Novos campos
  whatsapp:d.whatsapp||"",rankName:d.rankName||"",appAvatarId:d.appAvatarId||"",h2bProfile:d.h2bProfile||{},phone:d.phone||"",serverId:d.serverId||1,publicProfile:d.publicProfile||{},
  // 🔒 v172 (ORDEM DO DONO, 11/09/2026): gate de envio — plano pago ativo E
  // Gmail conectado (/oauth/connect-send), nunca antes disso.
  gmailConnected:!!d.gmailConnected,needsPlan:!!d.needsPlan};
      // 🌐 v149c (dono, 20/08: "tira aquele negócio de qual servidor você
      // está, agora só tem 1 server!") — os selos "Servidor N" do drawer e
      // do perfil foram removidos junto com a era multi-servidor.
      // v55 — MODO SÓ-ENVIO (Servidor 3): este servidor só pede o escopo de
      // ENVIAR do Gmail — não lê caixa de entrada de ninguém. A aba Respostas
      // (e todo atalho pra ela) some, e se ela estiver aberta, volta pra Home.
      if(d.sendOnly){
        U.sendOnly=true;
        try{
          document.querySelectorAll("[onclick*=\"sv('respostas')\"]").forEach(el=>{el.style.display='none';});
          if(typeof curView!=="undefined"&&curView==="respostas")sv("home");
        }catch(e){}
      }
      UPROFILES=d.profiles||[];if(U)U.profiles=UPROFILES;
      CFG={name:d.name||"",country:d.country||"Brazil",phone:d.phone||"",city:d.city||"",language:d.language||"pt-BR",subject:d.settings?.subject||"",body:d.settings?.body||""};
      DOCS=d.cvs||[];
      // Só redefine activeResIdx se ainda não foi definido (evita sobrescrever seleção do usuário)
      if(activeResIdx===null) activeResIdx=DOCS.filter(c=>(c.cvType||"resume")==="resume").slice(-1)[0]?.idx||null;
      if(d.readEmailIds?.length)_loadReadStateFromServer(d.readEmailIds);
      // Restore language from server preference — v86: normaliza 'pt-BR'→'pt'
      // (a preferência era salva com o código de região e nunca casava com a
      // chave de 2 letras do dicionário, então nunca era aplicada).
      if(d.language){
        const dl=String(d.language).slice(0,2).toLowerCase();
        if(LANG_DICT[dl] && _curLang!==dl){
          _curLang = dl;
          try{localStorage.setItem('h2b_lang',dl);}catch{}
        }
      }
      showApp();syncData();checkAdminMsg();_loadSentIds();
      // Verificar se veio do add-sender (admin) e ir para aba admin
      const _senderAdded=sessionStorage.getItem("senderAdded");
      if(_senderAdded){sessionStorage.removeItem("senderAdded");setTimeout(()=>{sv("profile");switchProfileTab("admin");toast("Gmail "+_senderAdded+" conectado ✓","g");},400);}
      const _senderReauthed=sessionStorage.getItem("senderReauthed");
      if(_senderReauthed){sessionStorage.removeItem("senderReauthed");setTimeout(()=>{sv("profile");switchProfileTab("admin");toast("Gmail "+_senderReauthed+" reconectado e reativado ✓","g");},400);}
      // Erro que voltou por ?err= com o usuário LOGADO (ex.: falha ao conectar
      // Gmail Extra) — mostra com destaque e leva pra tela certa. Antes o erro
      // ia parar num elemento da tela de login que o logado nunca vê.
      if(window._pendingErrMsg){
        const _pe=window._pendingErrMsg; window._pendingErrMsg=null;
        const _isSender=/gmail|email|sender|limite de \d+ e?-?mails/i.test(_pe);
        setTimeout(()=>{
          if(window._pendingTab){sv(window._pendingTab);window._pendingTab=null;}
          else if(_isSender){sv("profile");}
          toast("⚠️ "+_pe,"r",9000);
          try{alert("⚠️ "+_pe);}catch(e){}
        },600);
      }
      // 🔒 v172: voltou de /oauth/connect-send com sucesso — devolve a pessoa
      // pra aba de onde ela tentou enviar, já pronta pra mandar candidaturas.
      if(window._pendingGmailConnected){
        window._pendingGmailConnected=false;
        const _pt=window._pendingTab;window._pendingTab=null;
        setTimeout(()=>{
          if(_pt)sv(_pt);
          toast("✅ Gmail conectado — já pode enviar candidaturas!","g",6000);
        },600);
      }
      // Apply language AFTER showApp so all elements exist
      setTimeout(applyLang, 100);
      // Dispara setup automático de push após login (com delay para app carregar)
      setTimeout(()=>_autoPushSetup().catch(()=>{}), 1500);
    }else{showLanding();}
  }catch(e){console.warn("[boot]",e);showLanding();}
}
function showLanding(){const ld=g("#landing");ld.style.visibility="";ld.style.display="flex";g("#app").style.display="none";const sf=g("#site-footer");if(sf)sf.style.display="flex";try{maybeShowServerSelect();}catch(e){}}

// ═══════════════════════════════════════════
//  ENTRADA NA LANDING (v157: era de 1 servidor só — o seletor de servidores,
//  os cards de bloqueio "conta em outro servidor"/"lotado" e o atalho
//  multi-servidor do admin foram REMOVIDOS; sobrou só o realce do CTA)
// ═══════════════════════════════════════════
function maybeShowServerSelect(){
  // Link antigo com ?entrar=1: NÃO abre o login sozinho (v949) — a landing
  // SEMPRE aparece; só rola até o botão de entrada e o destaca.
  try{
    const ps=new URLSearchParams(location.search);
    if(ps.get("entrar")==="1"){
      try{sessionStorage.setItem("h2bSrvSeen","1");}catch(e){}
      try{history.replaceState({},"","/");}catch(e){}
      setTimeout(()=>{try{_pulseLandingCTA();}catch(e){}},600);
      return;
    }
  }catch(e){}
  // v949 (ordem do dono): visitante deslogado VÊ A LANDING PAGE.
  // Nada de card de login automático por cima — a pessoa conhece o produto
  // e clica ELA MESMA em "Entrar" ou "Criar conta" quando quiser.
}
// Destaca o botão principal de entrada da landing (usado no ?entrar=1)
function _pulseLandingCTA(){
  const btn=document.querySelector(".ln-cta-btn");
  if(!btn) return;
  btn.scrollIntoView({behavior:"smooth",block:"center"});
  btn.style.transition="box-shadow .3s";
  let n=0;const iv=setInterval(()=>{
    btn.style.boxShadow=(n%2===0)?"0 0 0 6px rgba(59,130,246,.45),0 16px 50px rgba(59,130,246,.5)":"";
    if(++n>=6){clearInterval(iv);btn.style.boxShadow="";}
  },450);
}
// ═══════════════════════════════════════════
//  CARD DE ENTRADA (auth gate) — Login / Criar conta por cima da landing
// ═══════════════════════════════════════════
let _agIntent="login",_agUser="",_agBusy=false;
function openAuthGate(step,intent){
  const ov=g("#auth-gate"); if(!ov) return;
  // FIX mobile: o gate precisa ser filho direto do <body> — dentro do #landing
  // o position:fixed quebra em alguns navegadores e o card não cobre a tela.
  if(ov.parentElement!==document.body)document.body.appendChild(ov);
  ov.classList.add("open");
  document.documentElement.classList.add("ag-lock"); // trava a rolagem da página atrás
  if(intent){_agIntent=intent;gaEvent(intent==="signup"?"sign_up_intent":"login_intent",{method:"password"});}
  agRender(step||"choice");
}
function closeAuthGate(){
  const ov=g("#auth-gate"); if(ov)ov.classList.remove("open");
  document.documentElement.classList.remove("ag-lock");
}
function agBack(){ agRender("choice"); }
function agRender(step,data){
  const body=g("#ag-body"),back=g("#ag-back"); if(!body) return;
  if(back)back.style.display=step==="choice"?"none":"flex";
  if(step==="choice"){
    body.innerHTML=`
      <div class="ag-title">Bem-vindo(a)! 👋</div>
      <div class="ag-sub">Candidate-se automaticamente a centenas de vagas H-2B e H-2A nos Estados Unidos.</div>
      <button class="ag-btn primario" onclick="_agIntent='login';agRender('login')"><i class="ti ti-login"></i> Já tenho conta — Entrar</button>
      <button class="ag-btn verde" onclick="_agIntent='signup';agRender('signup')"><i class="ti ti-user-plus"></i> Criar conta grátis</button>`;
    return;
  }
  // 🔒 ordem do dono, 12/09/2026: login/cadastro viraram usuário+senha —
  // zero ligação com Google na landing (login normal nunca fez sentido
  // consumir 1 das 100 vagas de teste do OAuth só pra "olhar o site").
  if(step==="login"){
    let _savedUser=""; try{ _savedUser=localStorage.getItem("h2bLastUser")||""; }catch(e){}
    if(!_agUser && _savedUser) _agUser=_savedUser;
    body.innerHTML=`
      <div class="ag-title">Entrar na sua conta</div>
      <div class="ag-sub">Digite seu nome de usuário e senha.</div>
      <input class="ag-input" id="ag-l-user" type="text" inputmode="email" autocapitalize="off" autocomplete="username" placeholder="Nome de usuário" value="${esc(_agUser)}" onkeydown="if(event.key==='Enter'){const p=g('#ag-l-pass');if(p)p.focus();}">
      <input class="ag-input" id="ag-l-pass" type="password" autocomplete="current-password" placeholder="Senha" onkeydown="if(event.key==='Enter')agSubmitLogin()">
      <div class="ag-err" id="ag-err"></div>
      <button class="ag-btn primario" id="ag-submit" onclick="agSubmitLogin()">Entrar <i class="ti ti-arrow-right"></i></button>
      <button class="ag-btn fantasma" onclick="_agIntent='signup';agRender('signup')"><i class="ti ti-user-plus"></i> Não tenho conta — Criar agora</button>`;
    setTimeout(()=>{const i=g(_agUser?"#ag-l-pass":"#ag-l-user");if(i)i.focus();},150);
    return;
  }
  if(step==="signup"){
    body.innerHTML=`
      <div class="ag-title">Criar conta grátis</div>
      <div class="ag-sub">Sem cartão, sem e-mail pra conectar aqui — só os dados abaixo. Dá pra editar tudo depois no seu perfil.</div>
      <div class="ag-grid2">
        <input class="ag-input" id="ag-s-nome" type="text" placeholder="Nome" autocomplete="given-name">
        <input class="ag-input" id="ag-s-sobrenome" type="text" placeholder="Sobrenome" autocomplete="family-name">
      </div>
      <input class="ag-input" id="ag-s-nasc" type="date" autocomplete="bday">
      <div class="ag-grid2">
        <input class="ag-input" id="ag-s-cidade" type="text" placeholder="Cidade" autocomplete="address-level2">
        <input class="ag-input" id="ag-s-estado" type="text" placeholder="Estado" autocomplete="address-level1">
      </div>
      <input class="ag-input" id="ag-s-pais" type="text" placeholder="País" autocomplete="country-name" value="Brasil">
      <div class="ag-grid2">
        <input class="ag-input" id="ag-s-tel" type="tel" placeholder="Telefone" autocomplete="tel">
        <input class="ag-input" id="ag-s-whats" type="tel" placeholder="WhatsApp" autocomplete="tel">
      </div>
      <div style="height:1px;background:rgba(255,255,255,.12);margin:4px 0 12px"></div>
      <input class="ag-input" id="ag-s-user" type="text" inputmode="email" autocapitalize="off" placeholder="Escolha um nome de usuário" autocomplete="username" onkeydown="if(event.key==='Enter'){const p=g('#ag-s-pass');if(p)p.focus();}">
      <input class="ag-input" id="ag-s-pass" type="password" placeholder="Crie uma senha (pode ser só números)" autocomplete="new-password" onkeydown="if(event.key==='Enter')agSubmitSignup()">
      <div class="ag-sub" style="margin-top:-4px;font-size:12px">Depois de criar a conta você completa currículo, carta e assunto de e-mail — <strong style="color:rgba(255,255,255,.8)">pode editar tudo isso quando quiser</strong>, o cadastro não precisa sair perfeito agora.</div>
      <div class="ag-err" id="ag-err"></div>
      <button class="ag-btn verde" id="ag-submit" onclick="agSubmitSignup()">Criar minha conta <i class="ti ti-arrow-right"></i></button>
      <button class="ag-btn fantasma" onclick="_agIntent='login';agRender('login')"><i class="ti ti-login"></i> Já tenho conta — Entrar</button>`;
    setTimeout(()=>{const i=g("#ag-s-nome");if(i)i.focus();},150);
    return;
  }
}
async function agSubmitLogin(){
  if(_agBusy)return;
  const uEl=g("#ag-l-user"),pEl=g("#ag-l-pass"),err=g("#ag-err"),btn=g("#ag-submit");
  const username=(uEl?uEl.value:"").toLowerCase().trim(),senha=pEl?pEl.value:"";
  const showErr=m=>{if(err){err.style.display="block";err.textContent=m;}};
  if(err)err.style.display="none";
  if(!username||!senha){showErr("⚠️ Preencha usuário e senha.");return;}
  _agUser=username;_agBusy=true;
  try{ localStorage.setItem("h2bLastUser",username); }catch(e){}
  if(btn){btn.disabled=true;btn.innerHTML='<span class="spin"></span> Entrando…';}
  try{
    const r=await fetch("/api/login",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password:senha})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Usuário ou senha inválidos.");
    gaEvent("login",{method:"password"});
    location.reload();
  }catch(e){
    _agBusy=false;
    if(btn){btn.disabled=false;btn.innerHTML='Entrar <i class="ti ti-arrow-right"></i>';}
    showErr("⚠️ "+(e.message||"Não foi possível entrar. Tente de novo."));
  }
}
function agSubmitSignup(){
  if(_agBusy)return;
  const val=sel=>{const e=g(sel);return e?e.value.trim():"";};
  const nome=val("#ag-s-nome"),sobrenome=val("#ag-s-sobrenome");
  const username=val("#ag-s-user").toLowerCase(),senha=(g("#ag-s-pass")||{}).value||"";
  const err=g("#ag-err");
  const showErr=m=>{if(err){err.style.display="block";err.textContent=m;}};
  if(err)err.style.display="none";
  if(!nome||!sobrenome){showErr("⚠️ Preencha nome e sobrenome.");return;}
  if(!/^[a-z0-9_.]{3,30}$/.test(username)){showErr("⚠️ Nome de usuário: 3 a 30 letras, números, ponto ou underline — sem espaço, sem @.");return;}
  if(senha.length<4){showErr("⚠️ A senha precisa ter pelo menos 4 caracteres.");return;}
  const payload={
    username,password:senha,nome,sobrenome,
    dataNascimento:val("#ag-s-nasc"),cidade:val("#ag-s-cidade"),estado:val("#ag-s-estado"),
    pais:val("#ag-s-pais")||"Brasil",telefone:val("#ag-s-tel"),whatsapp:val("#ag-s-whats"),
  };
  const btn=g("#ag-submit");
  const doSubmit=async()=>{
    _agBusy=true;
    if(btn){btn.disabled=true;btn.innerHTML='<span class="spin"></span> Criando conta…';}
    try{
      const r=await fetch("/api/cadastro",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||"Erro ao criar conta.");
      try{ localStorage.setItem("h2bLastUser",username); }catch(e){}
      gaEvent("sign_up",{method:"password"});
      location.reload();
    }catch(e){
      _agBusy=false;
      if(btn){btn.disabled=false;btn.innerHTML='Criar minha conta <i class="ti ti-arrow-right"></i>';}
      showErr("⚠️ "+(e.message||"Não foi possível criar a conta. Tente de novo."));
    }
  };
  showTerms(doSubmit);
}
function renderOnboardChecklist(){/* removido */}

// Chamada a cada vez que perfis ou docs mudarem — garante que o checklist some imediatamente
function refreshOnboardChecklist(){/* removido */}
function showApp(){
  g("#landing").style.display="none";g("#app").style.display="flex";
  // Oculta footer da landing ao logar (bottom-nav substitui)
  const sf=g("#site-footer");if(sf)sf.style.display="none";
  renderHdr();renderSidebar();
  if(U.isAdmin){const e=g("#sb-admin-sec");if(e)e.style.display="block";const da=g("#d-admin");if(da)da.style.display="block";const mm=g("#mm-admin-link");if(mm)mm.style.display="flex";}
  _initAdminTab();
  loadTabCounts();
  // Abre na HOME após login (não direto em Vagas)
  history.replaceState({view:"home"},"",location.pathname+location.search);
  sv("home");
  // v27: carrega o conjunto de empregadores bloqueados (enviados + fila)
  setTimeout(loadEmpregadoresBloqueados,800);
  // Mensagem de boas-vindas: APENAS no primeiro login verdadeiro (onboarded===false)
  // Após configurar perfil + upload de CV, o servidor persiste onboarded=true e nunca mais exibe
  // Mensagem de boas-vindas removida
  if(U.autoJob?.active){
    startAutoPolling();updateAutoDot(true);
    // FIX: carrega IDs da fila automática para ocultar vagas do manual ao abrir o app
    fetch("/api/auto/status",{credentials:"include"}).then(r=>r.json()).then(d=>{
      _autoQueueIds=new Set(d.autoQueueIds||[]);
      _syncAutoQueueVisibility();
    }).catch(()=>{});
  }
  // Profile subtab counts (600ms delay)
  setTimeout(()=>{
    const cnt=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false).length;
    const b=g("#ptab-profiles-cnt");if(b){b.style.display=cnt?"":"none";b.textContent=cnt;}
  },600);
  // Onboarding check (1.5s delay)
  setTimeout(checkShowOnboarding, 1500);
  // WhatsApp obrigatório: verificar após 2s (depois do onboarding)
  // Só mostra se o usuário JÁ passou pelo onboarding mas não tem número
  setTimeout(()=>{
    // Não mostrar se o onboarding estiver aberto
    const obOverlay = g('#onboarding-overlay');
    if(obOverlay && obOverlay.style.display === 'flex') return;
    checkWppRequired();
  }, 2500);
  // Mostra checklist de onboarding se incompleto
  
  // Intercepta botão Voltar Android — nunca vai para landing
  window.addEventListener("popstate",(e)=>{
    if(!U.connected){return;}// sessão encerrada, não interfere
    // Se o modal do Automático estiver aberto, o botão Voltar só fecha o modal
    // (não navega pra outra tela nem sai do app).
    const autoOv=g("#auto-modal-overlay");
    if(autoOv && autoOv.style.display==="block"){
      if(typeof closeAutoModal==="function")closeAutoModal(true);
      return;
    }
    const v=e.state?.view||"home";
    if(v==="home"){
      // Impede sair do app ao pressionar Voltar na Home
      history.pushState({view:"home"},"",location.pathname+location.search);
    }
    // Navega para a view correta sem empurrar novo estado
    curView=v;
    VIEWS.forEach(id=>{const ve=g("#v-"+id);if(ve)ve.classList.toggle("gone",id!==v);const si=g("#si-"+id);if(si)si.classList.toggle("active",id===v);const bn=g("#bn-"+id);if(bn)bn.classList.toggle("active",id===v);});const bnMore=g("#bn-more");if(bnMore)bnMore.classList.toggle("active",BN_MORE_VIEWS.includes(v));
    if(v==="home")renderHome();
    if(v!=="jobs")closeMobDetail();
  });
}

async function checkAdminMsg(){
  try{const r=await fetch("/api/my-message",{credentials:"include"});const d=await r.json();if(d.message){const bar=g("#admin-msg-bar");const txt=g("#admin-msg-text");if(bar&&txt){txt.textContent="💬 "+d.message.text;bar.classList.remove("gone");}}}catch{}
}
function dismissAdminMsg(){g("#admin-msg-bar")?.classList.add("gone");}

// ═══════════════════════════════════════════
//  HEADER / SIDEBAR
// ═══════════════════════════════════════════
function getPlanLabel(p){return{free:"Free",vip:"⭐ VIP",pro:"🤖 Pro",vipro:"⭐🤖 VIPro",doublepro:"💎 DoublePro"}[p]||"Free";}
function getPlanClass(p){return{free:"tgr",vip:"tb",pro:"tp",vipro:"tb",doublepro:"tb"}[p]||"tgr";}

// ── Dias restantes a partir de um timestamp ──────
function daysLeft(ts){if(!ts)return-1;const d=Math.ceil((ts-Date.now())/86400000);return Math.max(0,d);}

// ── Gera HTML do badge com dias restantes ────────
function planBadgeHTML(){
  const v=U.vip;
  const now=Date.now();
  const hasManual=v?.manualExpires&&v.manualExpires>now;
  const hasAuto=v?.autoExpires&&v.autoExpires>now;
  if(!hasManual&&!hasAuto)return`<span class="tag tgr" style="font-size:10px">Grátis</span>`;
  const ml=hasManual?daysLeft(v.manualExpires):-1;
  const al=hasAuto?daysLeft(v.autoExpires):-1;
  const urgent=d=>d>=0&&d<=5;
  const col=d=>urgent(d)?"var(--red)":d<=14?"var(--amber)":"var(--green)";
  let html="";
  if(hasManual)html+=`<span class="tag" style="background:var(--bluel);color:${col(ml)};border-color:${col(ml)};font-size:10px;white-space:nowrap">⭐ VIP ${ml} dia${ml===1?"":"s"}</span> `;
  if(hasAuto)html+=`<span class="tag" style="background:var(--purplel);color:${col(al)};border-color:${col(al)};font-size:10px;white-space:nowrap">🤖 Pro ${al} dia${al===1?"":"s"}</span>`;
  return html;
}

// ── Renderiza card de status completo na tela Planos ──
function renderPlanStatusCard(){
  const el=g("#plan-status-card");if(!el)return;
  const v=U.vip;const now=Date.now();
  const hasManual=v?.manualExpires&&v.manualExpires>now;
  const hasAuto=v?.autoExpires&&v.autoExpires>now;
  // 👤 2.0-P6 ("minha conta em 5 segundos"): o card aparece pra TODO MUNDO —
  // usuário Grátis antes não via NADA aqui e ficava sem saber onde está.
  const ml=hasManual?daysLeft(v.manualExpires):-1;
  const al=hasAuto?daysLeft(v.autoExpires):-1;
  const urgent=d=>d>=0&&d<=5;
  const warn=d=>d>=0&&d<=14;
  function row(icon,label,days,expires){
    const pct=Math.min(100,Math.max(4,Math.round(days/30*100)));
    const clr=urgent(days)?"var(--red)":warn(days)?"var(--amber)":"var(--green)";
    const bg=urgent(days)?"var(--redl)":warn(days)?"var(--amberl)":"var(--greenl)";
    const border=urgent(days)?"var(--redb)":warn(days)?"var(--amberb)":"var(--greenb)";
    const urgentBanner=urgent(days)?`<div style="font-size:11px;font-weight:700;color:var(--red);margin-top:4px;animation:pulse 1s ease-in-out infinite">⚠️ ${esc(t('mc_15'))} ${days} dia${days===1?"":"s"}! ${esc(t('mc_14'))}</div>`:"";
    return`<div style="background:${bg};border:1.5px solid ${border};border-radius:var(--r);padding:12px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-weight:800;font-size:13px">${icon} ${label}</div>
        <div style="font-size:22px;font-weight:900;color:${clr};line-height:1">${days}<span style="font-size:12px;font-weight:600"> dia${days===1?"":"s"}</span></div>
      </div>
      <div style="background:rgba(0,0,0,.08);border-radius:20px;height:6px;overflow:hidden;margin-bottom:4px">
        <div style="width:${pct}%;height:100%;background:${clr};border-radius:20px;transition:width .4s"></div>
      </div>
      <div style="font-size:11px;color:var(--t2)">Expira em: <strong>${new Date(expires).toLocaleDateString("pt-BR",{day:"2-digit",month:"long",year:"numeric"})}</strong></div>
      ${urgentBanner}
    </div>`;
  }
  let html=`<div style="background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rl);padding:16px">
    <div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;margin-bottom:10px;letter-spacing:.5px">👤 ${esc(t('mc_1'))}</div>`;
  if(hasManual)html+=row("⭐","VIP Manual",ml,v.manualExpires);
  if(hasAuto)html+=row("🤖","Pro Automático",al,v.autoExpires);
  if(!hasManual&&!hasAuto){
    html+=`<div style="background:var(--glass);border:1.5px solid var(--border2);border-radius:var(--r);padding:12px 14px;margin-bottom:8px">
      <div style="font-weight:800;font-size:13px">🆓 ${esc(t('mc_2'))} — ${U.manualLimit||10} ${esc(t('mc_3'))}</div>
      <div style="font-size:11px;color:var(--t3);margin-top:3px">${esc(t('mc_12'))}</div>
    </div>`;
  }
  html+=`<div id="mc-pedido" style="font-size:11.5px;color:var(--t3);margin-top:8px"></div>
  </div>`;
  el.innerHTML=html;
  el.style.display="block";
  _mcUltimoPedido();
}
// 👤 2.0-P6: status do ÚLTIMO pedido direto no card — a pessoa sabe na hora
// se está aguardando o admin, se o plano já foi ativado ou se foi cancelado.
// v170 (retirada do sistema de diamantes): vocabulário 100% de PEDIDO DE
// PLANO — nunca mais "doação"/"💎 na conta".
async function _mcUltimoPedido(){
  const box=g("#mc-pedido");if(!box)return;
  try{
    const d=await fetch("/api/pedidos",{credentials:"include"}).then(r=>r.json());
    // admin recebe a lista completa — filtra pros pedidos DELE mesmo
    // 💼 MC5-P2: o campo do pedido é createdAt (criadoEm não existia — a
    // data nunca aparecia); e 'pago' NÃO é 'plano ativo' (a ativação só
    // roda no 'ativo') — status honesto próprio pra não mentir pro usuário.
    const meus=(d.pedidos||[]).filter(p=>p.userEmail===U.email).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!meus.length){box.textContent=t('mc_11');return;}
    const p=meus[0];
    const stMap={pendente:["🕐",t('mc_8'),"var(--amber)"],pago:["💰",t('mc_13'),"#2563eb"],ativo:["✅",t('mc_9'),"var(--green)"],cancelado:["❌",t('mc_10'),"var(--red)"]};
    const st2=stMap[String(p.status||"").toLowerCase()]||["ℹ️",String(p.status||"?"),"var(--t3)"];
    box.innerHTML=`${esc(t('mc_7'))} <strong>R$ ${brl(p.valorTotal)}</strong> · <span style="color:${st2[2]};font-weight:700">${st2[0]} ${esc(st2[1])}</span>${p.createdAt?` · ${new Date(p.createdAt).toLocaleDateString('pt-BR')}`:''}`;
  }catch(e){box.textContent="";}
}

function renderHdr(){
  // Avatar no header
  const av=g("#hdr-av");
  if(av){
    if(U.picture)av.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"><span id="hdr-av-dot" style="display:none;position:absolute;bottom:0;right:0;width:10px;height:10px;background:#4ade80;border:2px solid var(--surface);border-radius:50%"></span>`;
    else av.textContent=(U.name||"?")[0].toUpperCase();
  }
  // Avatar no bottom nav
  const bnAv=g("#bn-av");
  if(bnAv){
    if(U.picture)bnAv.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else bnAv.innerHTML=`<i class="ti ti-user-circle"></i>`;
  }
  // Botão Planos no header
  const plansBtn=g("#hdr-plans-btn");
  if(plansBtn){
    plansBtn.style.display="flex";
    if(U.plan&&U.plan!=="free"){
      const planNames={vip:"⭐ VIP",vipro:"🤖 VIPro",doublepro:"💎 DoublePro"};
      const label=planNames[U.plan]||U.plan.toUpperCase();
      g("#hdr-plans-label").textContent=label;
      plansBtn.style.background="linear-gradient(135deg,#059669,#10b981)";
    } else {
      g("#hdr-plans-label").textContent="💎 Planos";
      plansBtn.style.background="linear-gradient(135deg,#4f46e5,#7c3aed)";
    }
  }
  updateLimChip();
}
function updateLimChip(){
  const c=g("#hdr-lim");if(!c)return;
  if(U.autoJob?.active){c.className="lchip lc-a";c.innerHTML="🤖 Auto <strong>ON</strong>";}
  else if(U.manualRemaining===0){c.className="lchip lc-x";c.innerHTML="🔒 Limite atingido";}
  else if(U.manualRemaining<=3){c.className="lchip lc-w";c.innerHTML=`⚠️ ${U.manualRemaining} restantes`;}
  else{
    const planLabel={free:"Free",vip:"⭐VIP",pro:"🤖Pro",vipro:"⭐Pro",doublepro:"💎DoublePro"}[U.plan]||"Free";
    c.className="lchip lc-ok";c.innerHTML=`${planLabel} · ${U.manualRemaining} envios`;
  }
}
function updateAutoDot(on){
  // v171: os alvos de #bnd-auto/#bn-auto/#sb-auto-dot (botão central
  // "Automático" elevado no bottom nav antigo + um dot decorativo na
  // sidebar) já não existem no HTML há tempos — nunca davam erro (g() é
  // null-safe) mas eram 3 linhas mortas; a nav mobile hoje só abre o
  // Automático pelo item "Mais" (openAutoModal()), e o destaque na
  // sidebar já é 100% coberto por .is-active (texto+ícone verde) abaixo.
  const sba=g("#sb-auto-btn");if(sba)sba.classList.toggle("is-active",on);
  // Dot verde no avatar do header quando automático ligado
  const hdrDot=g("#hdr-av-dot");if(hdrDot)hdrDot.style.display=on?"block":"none";
}
function renderSidebar(){
  const sbp=g("#sb-prof");if(sbp)sbp.style.display="block";
  const sba=g("#sb-av");if(sba){if(U.picture)sba.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;else sba.textContent=(U.name||"?")[0].toUpperCase();}
  if(g("#sb-name"))g("#sb-name").textContent=U.name;if(g("#sb-email"))g("#sb-email").textContent=U.email;
  const spb=g("#sb-plan-badge");if(spb)spb.innerHTML=planBadgeHTML();
  // Card "Seja VIP" no rodapé da sidebar — só pra quem ainda é free (layout do print)
  const vipCard=g("#sb-vip-card");if(vipCard)vipCard.style.display=(U.plan==="free"||!U.plan)?"block":"none";
}
function toggleTheme(){
  var root = document.documentElement;
  var isDark = root.getAttribute('data-theme') === 'dark';
  var newTheme = isDark ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  localStorage.setItem('h2b_theme', newTheme);
  updateThemeUI();
}

function updateThemeUI(){
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  // Update drawer button
  var icon = document.getElementById('theme-icon');
  var label = document.getElementById('theme-label');
  var iconSb = document.getElementById('theme-icon-sidebar');
  var labelSb = document.getElementById('theme-label-sidebar');
  var iconClass = isDark ? 'ti ti-sun' : 'ti ti-moon-stars';
  var labelText = isDark ? 'Modo claro' : 'Modo escuro';
  if(icon) icon.className = iconClass;
  if(label) label.textContent = labelText;
  if(iconSb) iconSb.className = iconClass;
  if(labelSb) labelSb.textContent = labelText;
  // Update meta theme-color
  var meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.content = isDark ? '#0d0f1a' : '#4f46e5';
}

// v118: aviso das regras novas pros CONTRATOS ANTIGOS (1x por sessão)
function _avisoRegrasPlanos(){
  try{
    if(!U||!U.planRulesNotice)return;
    if(sessionStorage.getItem('h2b_prn'))return;
    sessionStorage.setItem('h2b_prn','1');
    toast(U.planRulesNotice,'g');
  }catch(e){}
}
setInterval(_avisoRegrasPlanos,7000);
// Initialize UI after DOM ready
document.addEventListener('DOMContentLoaded', function(){updateThemeUI();});

// ═══════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════
const VIEWS=["home","jobs","logs","profile","auto","plans","tutorial","settings","hist"];
// v171: views que só existem dentro do sheet "Mais" (sem botão #bn-<id> próprio
// no bottom-nav de 5 itens) — o loop de destaque abaixo precisa acender #bn-more
// pra elas, senão o bottom-nav inteiro fica sem nenhum ícone ativo.
const BN_MORE_VIEWS=["plans","tutorial","settings"];
function sv(v,...args){
  // ── "auto" abre modal em vez da view ──
  if(v==="auto"){if(typeof openAutoModal==="function"){openAutoModal();return;}}
  curView=v;
  // Scroll to top ao mudar de aba
  const appEl=g("#app");if(appEl)appEl.scrollTop=0;window.scrollTo(0,0);
  // v166: #bn-profile virou o botão real "Meu Perfil" do bottom-nav (era o
  // botão do drawer/menu removido em reconstrução anterior, por isso antes
  // NUNCA podia ficar "active" — forçar isso agora apagaria o destaque do
  // item certo assim que o loop abaixo o marcasse ativo).
  VIEWS.forEach(id=>{const ve=g("#v-"+id);if(ve)ve.classList.toggle("gone",id!==v);const si=g("#si-"+id);if(si)si.classList.toggle("active",id===v);const bn=g("#bn-"+id);if(bn)bn.classList.toggle("active",id===v);});const bnMore=g("#bn-more");if(bnMore)bnMore.classList.toggle("active",BN_MORE_VIEWS.includes(v));
  if(v==="jobs"){setTimeout(loadLugares,400);updateManualSendGate();}if(v==="plans"){try{loadPlanos();}catch(e){}}if(v==="profile"){loadProfile();loadTplView();setTimeout(()=>{_loadSoundPref();renderSoundSelector();},100);}

  if(v==="auto"){loadAutoView();if(U.autoJob?.active)startAutoPolling();}
  if(v==="logs"){logSkip=0;logTotal=0;logDone=false;loadLogs();}
  if(v==="plans")renderPlanStatusCard();
  if(v==="home")renderHome();
  if(v==="hist"){renderHist();}
  if(v==="tutorial"){loadTutorial();}
  if(v==="settings"){_populateSettingsView();}
  if(v!=="jobs")closeMobDetail();
  // ── Popula campos da aba "Eu" ao abrir perfil ──
  if(v==="profile"){
    setTimeout(()=>{
      const nameEl=g("#cfg-name");if(nameEl&&!nameEl.value)nameEl.value=CFG.name||U.name||"";
      const countryEl=g("#cfg-country");if(countryEl&&!countryEl.value)countryEl.value=CFG.country||U.country||"Brazil";
      const phoneEl=g("#cfg-phone");if(phoneEl&&!phoneEl.value)phoneEl.value=CFG.phone||U.phone||"";
      const cityEl=g("#cfg-city");if(cityEl&&!cityEl.value)cityEl.value=CFG.city||U.city||"";
      
      switchProfileTab("me");
      _updateProfileTabCount();
    },50);
  }
  // Empurra estado no histórico do browser para o botão Voltar funcionar
  if(v!=="home")history.pushState({view:v},"",location.pathname+location.search);
}

// ═══════════════════════════════════════════
//  SOURCE TABS + DYNAMIC CATEGORIES
// ═══════════════════════════════════════════
function setTab(t){
  fGrupos=[];fEtaStatus="";
  tab=t;fCat="all";
  fTitles=[];_titlesTax=null;
  setTimeout(loadLugares,250); // v114: recarrega sugestões de estado/cidade da planilha nova
  _masterFiltersSyncBadge();
  // FIX: resetar filtros que não existem nas planilhas para não contaminar os resultados
  if(t!=="seasonal"){fWage=0;fWorkers=0;const fw=g("#f-wage");if(fw)fw.value="";const wk=g("#f-workers");if(wk)wk.value="";const fc=g("#f-city");if(fc)fc.value="";}
  // v22: planilhas agora suportam ordenação real (random/desc/wage/start via
  // modal de filtros) — só reseta o que a planilha NÃO entende (asc do seasonal)
  if(t!=="seasonal"&&!["random","desc","wage","start","match"].includes(fSort)){setSort("random");}
  document.querySelectorAll(".stab").forEach(b=>b.classList.remove("active"));
  g("#stab-"+t)?.classList.add("active");
  g("#jlist").innerHTML="";g("#lmore").innerHTML="";
  const _existing=document.getElementById("sheet-filter-warn");if(_existing)_existing.remove();
  g("#jd-empty")?.classList.remove("gone");g("#jd-content").style.display="none";closeMobDetail();
  if(t==="seasonal"){
    g("#cat-chips-jobs").innerHTML="";
    loadJobs(true);
  } else {
    sSkip=0;sTotal=0;sDone=false;sJobs=[];sLoading=false;
    g("#jlist").innerHTML=mkSkels(6);
    loadSheetCategories(t);
    // Sincronizar autoQueueIds e sentIds ANTES de carregar vagas
    var _doLoad=function(){loadSheetMeta(true);};
    var _pending=2;
    var _done=function(){if(--_pending===0)_doLoad();};
    // Carregar IDs do automático
    if(U&&U.autoJob&&U.autoJob.active){
      fetch("/api/auto/status",{credentials:"include"})
        .then(function(r){return r.json();})
        .then(function(d){_autoQueueIds=new Set(d.autoQueueIds||[]);_done();})
        .catch(_done);
    } else {_autoQueueIds=new Set();_done();}
    // Carregar IDs enviados
    if(!_sentLoaded){
      _loadSentIds().then(_done).catch(_done);
    } else {_done();}
  }
}

async function loadSheetCategories(sheet){
  try{
    const r=await fetch(`/api/sheet-categories?sheet=${sheet}`,{credentials:"include"});
    const d=await r.json();
    sheetCats[sheet]=d.categories||[];
    renderCatChips(sheet);
  }catch{}
  _ensureCatLabels(); // v167: fonte única de nomes de categoria (ver abaixo)
}
// v167 (revisão 07/09/2026): dicionário COMPLETO de categorias (CATEGORY_LABELS
// do servidor, ~30 chaves incl. H-2A) — antes só era buscado dentro do wizard
// do automático (renderWizardCats), então quem nunca abria o automático nunca
// tinha window._catLabels preenchido e getOccupationCategoryByKey caía sempre
// no fallback parcial. Agora também carrega ao trocar de aba de planilha
// (uso normal da lista manual). Idempotente — só busca 1x por sessão.
let _catLabelsLoading=null;
function _ensureCatLabels(){
  if(window._catLabels||_catLabelsLoading)return _catLabelsLoading;
  _catLabelsLoading=fetch("/api/category-groups",{credentials:"include"})
    .then(r=>r.json())
    .then(d=>{window._catGroups=d.groups||[];window._catLabels=d.labels||{};})
    .catch(()=>{window._catGroups=window._catGroups||[];window._catLabels=window._catLabels||{};});
  return _catLabelsLoading;
}

function renderCatChips(sheet){
  const cats=sheetCats[sheet]||[];const el=g("#cat-chips-jobs");if(!el)return;
  el.innerHTML=[
    `<button class="cat-chip on" data-cat="all" onclick="selectTabCat('all')">Todas (${cats.reduce((s,c)=>s+c.count,0).toLocaleString()})</button>`,
    ...cats.map(c=>`<button class="cat-chip" data-cat="${c.key}" onclick="selectTabCat('${c.key}')">${c.label} (${c.count.toLocaleString()})</button>`)
  ].join("");
}

function selectTabCat(cat){
  fCat=cat;document.querySelectorAll("#cat-chips-jobs .cat-chip").forEach(b=>b.classList.toggle("on",b.dataset.cat===cat));
  fTitles=[];_masterFiltersSyncBadge(); // categoria rápida e cargo específico não se misturam
  sSkip=0;sDone=false;sJobs=[];loadSheetMeta(true);
}

// ═══════════════════════════════════════════
//  🔍 MODAL MASTER DE FILTROS (redesign completo — substitui a barra
//  espalhada de chips/selects por 1 botão único que abre 1 janela com
//  TUDO dentro: cargo específico, categoria, tipo/status, localização,
//  salário, qtd vagas, e os filtros Double Pro (Grupo/Status).
// ═══════════════════════════════════════════
let fTitles=[]; // títulos exatos selecionados (lowercase) + opcionalmente "__outros__"
let _titlesTax=null; // cache da taxonomia já buscada (por sheet)


// ── Contexto do modal: "jobs" (Envio Manual) ou "auto" (wizard do Automático) ──
// MESMO modal, MESMO pensamento: os controles físicos são compartilhados e o
// estado de cada contexto é trocado ao abrir/fechar (snapshot por contexto).
let _mfCtx="jobs";
let _mfGrupos=[];        // grupos marcados AGORA no modal (do ctx ativo)
// v22-FILTROS: meses de início marcados no modal (mesmo padrão dual-contexto
// dos grupos) + estado dos meses aplicados por contexto
let _mfBeginMonths=[];
let fBeginMonths=[],afBeginMonths=[];
const _MF_MONTH_LABELS=["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
function _mfRenderMonths(){
  const row=g("#mf-months-row");if(!row)return;
  row.innerHTML=_MF_MONTH_LABELS.map((lb,i)=>{
    const m=i+1,sel=_mfBeginMonths.includes(m);
    return `<button onclick="mfToggleMonth(${m})" style="padding:6px 12px;border-radius:20px;border:2px solid ${sel?"var(--blue)":"var(--border2)"};background:${sel?"rgba(37,99,235,.12)":"var(--sf2)"};color:${sel?"var(--blue)":"var(--t2)"};font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">${lb}</button>`;
  }).join("");
}
function mfToggleMonth(m){
  const i=_mfBeginMonths.indexOf(m);if(i>=0)_mfBeginMonths.splice(i,1);else _mfBeginMonths.push(m);
  _mfBeginMonths.sort((a,b)=>a-b);_mfRenderMonths();mfOnChange();
}
// v22-FILTROS: multi-estado — #f-state (hidden) guarda "FLORIDA,TEXAS";
// o select #f-state-add só adiciona; chips removem.
function _mfStates(){return (g("#f-state")?.value||"").split(",").map(s=>s.trim()).filter(Boolean);}
function _mfRenderStateChips(){
  const box=g("#f-state-chips");if(!box)return;
  const sts=_mfStates();
  if(!sts.length){box.style.display="none";box.innerHTML="";return;}
  box.style.display="flex";
  box.innerHTML=sts.map(st=>`<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(37,99,235,.1);border:1.5px solid rgba(37,99,235,.35);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:700;color:var(--blue)">📍 ${esc(st)}<button onclick="mfRemoveState('${esc(st)}')" style="background:none;border:none;cursor:pointer;color:var(--blue);padding:0;line-height:1;font-size:14px;font-weight:800">×</button></span>`).join("");
}
function mfAddState(v){
  const sel=g("#f-state-add");if(sel)sel.value="";
  v=String(v||"").trim();if(!v)return;
  const sts=_mfStates();if(sts.includes(v))return;
  sts.push(v);const h=g("#f-state");if(h)h.value=sts.join(",");
  _mfRenderStateChips();mfOnChange();
}
function mfRemoveState(v){
  const sts=_mfStates().filter(s=>s!==v);
  const h=g("#f-state");if(h)h.value=sts.join(",");
  _mfRenderStateChips();mfOnChange();
}
const _mfCtxState={jobs:null,auto:null};
let _mfFacets={};        // cache de facetas (status/grupos reais) por planilha
function _mfIsDP(){return !!(U.isAdmin||U.plan==="doublepro");}
function _mfCapture(){return{state:g("#f-state")?.value||"",city:g("#f-city")?.value||"",wage:g("#f-wage")?.value||"",workers:g("#f-workers")?.value||"",titles:[...fTitles],grupos:[..._mfGrupos],dolStatus:g("#mf-dol-status")?.value||"",beginMonths:[..._mfBeginMonths],sort:g("#mf-sort")?.value||"random"};}
function _mfLoad(st){st=st||{};const fs2=g("#f-state");if(fs2)fs2.value=st.state||"";const fc=g("#f-city");if(fc)fc.value=st.city||"";const fw=g("#f-wage");if(fw)fw.value=st.wage||"";const fk=g("#f-workers");if(fk)fk.value=st.workers||"";fTitles=[...(st.titles||[])];_mfGrupos=[...(st.grupos||[])];const ds=g("#mf-dol-status");if(ds)ds.value=st.dolStatus||"";_mfBeginMonths=[...(st.beginMonths||[])];const ms=g("#mf-sort");if(ms)ms.value=st.sort||"random";_mfRenderGrupos();_mfRenderMonths();_mfRenderStateChips();}
function mfOnChange(){_masterFiltersSyncBadge();if(_mfCtx==="jobs")applyF();}

const _MF_GRUPO_COLORS={A:"#10b981",B:"#f59e0b",C:"#3b82f6",D:"#ef4444",E:"#8b5cf6",F:"#06b6d4",G:"#ec4899",H:"#6b7280"};
function _mfRenderGrupos(){
  const row=g("#mf-grupos-row");if(!row)return;
  const facets=_mfFacets[_mfCurrentSheet()]||{grupos:[]};
  const counts={};(facets.grupos||[]).forEach(x=>{counts[x.g]=x.count;});
  row.innerHTML=["A","B","C","D","E","F","G","H"].map(gk=>{
    const sel=_mfGrupos.includes(gk);const c=_MF_GRUPO_COLORS[gk]||"#6b7280";const cnt=counts[gk];
    return `<button onclick="mfToggleGrupo('${gk}')" style="padding:6px 12px;border-radius:20px;border:2px solid ${sel?c:"var(--border2)"};background:${sel?c+"22":"var(--sf2)"};color:${sel?c:"var(--t2)"};font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">${gk}${cnt?` <span style="opacity:.65;font-size:10px;font-weight:700">${cnt.toLocaleString()}</span>`:""}</button>`;
  }).join("");
}
function mfToggleGrupo(gk){
  const i=_mfGrupos.indexOf(gk);if(i>=0)_mfGrupos.splice(i,1);else _mfGrupos.push(gk);
  _mfRenderGrupos();mfOnChange();
  // No manual, grupo aplica ao vivo como os demais
  if(_mfCtx==="jobs"){fGrupos=[..._mfGrupos];sSkip=0;sDone=false;sJobs=[];loadSheetMeta(true);renderJobsFilterChips();}
}
function _mfCurrentSheet(){return _mfCtx==="auto"?(autoSelectedSrc||""):tab;}
async function _mfLoadFacets(sheetKey){
  if(!sheetKey||_mfFacets[sheetKey])return;
  try{const r=await fetch(`/api/sheet-facets?sheet=${sheetKey}`,{credentials:"include"});const d=await r.json();if(d.ok)_mfFacets[sheetKey]=d;}catch{}
}
function _mfFillStatusSelect(sheetKey){
  const sel=g("#mf-dol-status");if(!sel)return;
  const cur=sel.value;const facets=_mfFacets[sheetKey]||{statuses:[]};
  sel.innerHTML='<option value="">Todos os status</option>'+(facets.statuses||[]).map(s=>`<option value="${esc(s.v)}">${esc(s.v)} (${s.count.toLocaleString()})</option>`).join("");
  sel.value=cur||"";if(sel.value!==(cur||""))sel.value="";
}
// v166: contagem por estado no select "➕ Adicionar estado…" (ex.: "FLORIDA
// (312)") — reaproveita a mesma faceta leve já buscada p/ status/grupo
// (/api/sheet-facets, 1 chamada por abertura do modal, cacheada por sheet).
// Sem faceta (aba "Vagas ao Vivo") devolve a lista simples de sempre.
function _mfFillStateSelect(sheetKey){
  const sel=g("#f-state-add");if(!sel)return;
  const facets=sheetKey?(_mfFacets[sheetKey]||null):null;
  const counts=new Map((facets?.states||[]).map(s=>[s.v,s.count]));
  [...sel.options].forEach(opt=>{
    if(!opt.value)return; // placeholder "➕ Adicionar estado…"
    const base=opt.dataset.stName||opt.value;
    opt.dataset.stName=base;
    // v167 (revisão 07/09/2026): <option> sem atributo value="" explícito no
    // HTML deriva .value do TEXTO exibido — sobrescrever só o textContent
    // (sem opt.value=base) fazia o valor real virar "FLORIDA (312)" assim
    // que a contagem carregava, e mfAddState(this.value) gravava essa string
    // poluída em #f-state — o filtro de estado nunca mais batia (comparação
    // exata contra r.s) e zerava a lista de vagas em silêncio.
    opt.value=base;
    if(!counts.size){opt.textContent=base;opt.disabled=false;return;}
    const n=counts.get(base)||0;
    opt.textContent=`${base} (${n.toLocaleString()})`;
    opt.disabled=n===0;
  });
}

async function openMasterFilters(ctx){
  ctx=ctx==="auto"?"auto":"jobs";
  if(ctx==="auto"&&!autoSelectedSrc){toast("Escolha a fonte das vagas primeiro (Passo 1)","r");return;}
  const ov=g("#master-filters-overlay");if(!ov)return;
  // Troca de contexto: guarda o estado do ctx atual e carrega o do novo
  if(ctx!==_mfCtx){_mfCtxState[_mfCtx]=_mfCapture();_mfCtx=ctx;
    if(ctx==="auto"&&!_mfCtxState.auto){_mfCtxState.auto={state:g("#af-state")?.value||"",city:g("#af-city")?.value||"",wage:g("#af-min-wage")?.value||"",workers:g("#af-min-workers")?.value||"",titles:[...afTitles],grupos:[...afGrupos],dolStatus:afEtaStatus,beginMonths:[...afBeginMonths]};}
    _mfLoad(_mfCtxState[ctx]);
  } else if(ctx==="auto"){
    _mfLoad(_mfCtxState.auto||{titles:[...afTitles],grupos:[...afGrupos],dolStatus:afEtaStatus,state:g("#af-state")?.value||"",city:g("#af-city")?.value||"",wage:g("#af-min-wage")?.value||"",workers:g("#af-min-workers")?.value||"",beginMonths:[...afBeginMonths]});
  }
  ov.classList.remove("gone");
  const sheetKey=_mfCurrentSheet();
  const isSheet=ctx==="auto"?true:(tab!=="seasonal");
  // v22: ordenação só faz sentido na LISTA do manual (a fila do automático é
  // embaralhada de propósito); mês de início só quando a planilha TEM datas
  const sortSec=g("#mf-sort-section");if(sortSec)sortSec.style.display=(ctx==="jobs"&&isSheet)?"":"none";
  const moSec=g("#mf-months-section");
  if(moSec){
    if(!isSheet){moSec.style.display="none";}
    else{
      moSec.style.display="";_mfRenderMonths();
      _mfLoadFacets(sheetKey).then(()=>{
        const f=_mfFacets[sheetKey];
        if(f&&f.datedCount===0){moSec.style.display="none";_mfBeginMonths=[];}
      });
    }
  }
  // v166: contagem por estado no select "➕ Adicionar estado…" — só planilha
  // (a aba "Vagas ao Vivo" não tem facetas agregadas, sem chamada nova pesada)
  if(isSheet)_mfLoadFacets(sheetKey).then(()=>_mfFillStateSelect(sheetKey));
  else _mfFillStateSelect(null);
  const cityWrap=g("#f-city");if(cityWrap)cityWrap.style.display=isSheet?"":"none";
  const tSec=g("#mf-type-section");if(tSec)tSec.style.display=isSheet?"none":"";
  // Categoria rápida: no automático ela já vive no wizard — esconde aqui
  const catSec=g("#mf-cat-section");if(catSec)catSec.style.display=ctx==="auto"?"none":"";
  // 💎 Seção Double Pro: só faz sentido em planilha; bloqueada p/ não-DP
  const dpSec=g("#mf-dp-section");
  if(dpSec){
    dpSec.style.display=isSheet?"":"none";
    const isDP=_mfIsDP();
    const lock=g("#mf-dp-lock");if(lock)lock.style.display=isDP?"none":"block";
    const grRow=g("#mf-grupos-row");if(grRow)grRow.style.display=isDP?"flex":"none";
    const dsSel=g("#mf-dol-status");if(dsSel)dsSel.style.display=isDP?"":"none";
    if(isSheet&&isDP){_mfLoadFacets(sheetKey).then(()=>{_mfFillStatusSelect(sheetKey);_mfRenderGrupos();});}
  }
  const titlesSec=g("#mf-titles-section");if(titlesSec)titlesSec.style.display=isSheet?"":"none";
  if(isSheet){
    const searchEl=g("#titles-filter-search");if(searchEl)searchEl.value="";
    if(!_titlesTax||_titlesTax._sheet!==sheetKey){
      g("#titles-filter-list").innerHTML='<div style="text-align:center;padding:20px;color:var(--t3)"><span class="spin"></span></div>';
      try{
        const r=await fetch(`/api/sheet-titles?sheet=${sheetKey}`,{credentials:"include"});
        const d=await r.json();
        _titlesTax={_sheet:sheetKey,titulos:d.titulos||[],outros:d.outros||{count:0,titulos:[]}};
      }catch(e){
        g("#titles-filter-list").innerHTML='<div style="text-align:center;padding:20px;color:var(--red)">Erro ao carregar cargos. Tente de novo.</div>';
      }
    }
    renderTitlesFilterList();
  }
  _masterFiltersSyncBadge();
}

function renderTitlesFilterList(){
  if(!_titlesTax)return;
  const q=(g("#titles-filter-search")?.value||"").trim().toLowerCase();
  const list=_titlesTax.titulos.filter(t=>!q||t.title.toLowerCase().includes(q));
  const selectedSet=new Set(fTitles);
  let html=list.map(t=>{
    const key=t.title.toLowerCase();
    const checked=selectedSet.has(key)?"checked":"";
    const safeKey=key.replace(/"/g,"&quot;");
    return `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:7px 4px;cursor:pointer;border-bottom:1px solid var(--border)">
      <input type="checkbox" data-titlekey="${safeKey}" onchange="toggleTitleChip(this.dataset.titlekey,this.checked)" ${checked} style="width:16px;height:16px;flex-shrink:0">
      <span style="flex:1">${t.title}</span>
      <span style="color:var(--t3);font-size:11px;font-weight:700">${t.count.toLocaleString()}</span>
    </label>`;
  }).join("");
  const outros=_titlesTax.outros||{count:0,titulos:[]};
  if(outros.count>0 && (!q || "outros".includes(q))){
    const checked=selectedSet.has("__outros__")?"checked":"";
    const tip=(outros.titulos||[]).slice(0,40).join(", ").replace(/"/g,"&quot;");
    html+=`<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:9px 4px;cursor:pointer;background:rgba(124,58,237,.06);border-radius:8px;margin-top:6px" title="${tip}">
      <input type="checkbox" data-titlekey="__outros__" onchange="toggleTitleChip('__outros__',this.checked)" ${checked} style="width:16px;height:16px;flex-shrink:0">
      <span style="flex:1">📦 Outros <span style="color:var(--t3);font-weight:400">(${outros.titulos.length} cargos isolados, ≤3 vagas cada)</span></span>
      <span style="color:var(--t3);font-size:11px;font-weight:700">${outros.count.toLocaleString()}</span>
    </label>`;
  }
  g("#titles-filter-list").innerHTML=html||'<div style="text-align:center;padding:30px;color:var(--t3)">Nenhum cargo encontrado.</div>';
  const allCb=g("#titles-filter-all");if(allCb)allCb.checked=fTitles.length===0;
  _masterFiltersSyncBadge();
}

function toggleTitleChip(key,checked){
  if(checked){ if(!fTitles.includes(key)) fTitles.push(key); }
  else { fTitles=fTitles.filter(k=>k!==key); }
  const allCb=g("#titles-filter-all");if(allCb)allCb.checked=fTitles.length===0;
  _masterFiltersSyncBadge();
}

function toggleAllTitles(checked){
  if(checked){ fTitles=[]; renderTitlesFilterList(); }
  else { const allCb=g("#titles-filter-all");if(allCb)allCb.checked=true; } // sem nenhum título marcado = "todas" também
}

// Conta quantas dimensões de filtro estão ativas agora (pra mostrar no badge)
function _countActiveFilters(){
  let n=0;
  if(fTitles.length)n++;
  if(fCat&&fCat!=="all")n++;
  if((g("#f-state")?.value||""))n++;
  if((g("#f-city")?.value||"").trim())n++;
  if(parseFloat(g("#f-wage")?.value||0))n++;
  if(parseInt(g("#f-workers")?.value||0))n++;
  if(_mfBeginMonths.length)n++;
  if(_mfCtx==="jobs"){if(fGrupos&&fGrupos.length)n++;if(fEtaStatus)n++;}
  else{if(_mfGrupos.length)n++;if((g("#mf-dol-status")?.value||""))n++;}
  if(typeof fType!=="undefined"&&fType!=="all")n++;
  if(typeof fStat!=="undefined"&&fStat!=="all")n++;
  return n;
}

function _masterFiltersSyncBadge(){
  const n=_countActiveFilters();
  const badge=g("#master-filters-badge");
  if(badge){ if(n){badge.style.display="";badge.textContent=String(n);}else{badge.style.display="none";} }
  const applyCount=g("#master-filters-apply-count");
  if(applyCount)applyCount.textContent=n?`(${n})`:"";
}

function applyMasterFilters(){
  if(_mfCtx==="auto"){
    // Captura o estado do modal e grava no estado do AUTOMÁTICO
    const st=_mfCapture();
    _mfCtxState.auto=st;
    afTitles=[...st.titles];afGrupos=[...st.grupos];afEtaStatus=st.dolStatus||"";
    afBeginMonths=[...(st.beginMonths||[])]; // v22: mês de início no automático
    const set=(id,v)=>{const el=g(id);if(el)el.value=v;};
    set("#af-state",st.state);set("#af-city",st.city);
    set("#af-min-wage",st.wage);set("#af-min-workers",st.workers);
    closeMasterFilters(); // devolve os controles ao estado do manual
    renderAutoFilterChips();_syncAutoFiltersBadge();refreshAutoFilterCount();
    return;
  }
  // MANUAL (comportamento original + grupos/status + v22: meses/ordenação)
  // ⚠️ QA 11/09: faltava reler estado/salário/trabalhadores do DOM (só o
  // automático via _mfCapture() fazia isso) — "Limpar tudo" limpava os
  // campos na tela mas "Aplicar" continuava buscando com os valores
  // antigos guardados nos globais fState/fWage/fWorkers.
  fState=g("#f-state")?.value||"";
  fWage=parseFloat(g("#f-wage")?.value||0)||0;
  fWorkers=parseInt(g("#f-workers")?.value||0)||0;
  fGrupos=[..._mfGrupos];fEtaStatus=g("#mf-dol-status")?.value||"";
  fBeginMonths=[..._mfBeginMonths];fSort=g("#mf-sort")?.value||"random";
  closeMasterFilters();
  if(fTitles.length){ fCat="all"; document.querySelectorAll("#cat-chips-jobs .cat-chip").forEach(b=>b.classList.toggle("on",b.dataset.cat==="all")); }
  _masterFiltersSyncBadge();renderJobsFilterChips();
  if(tab==="seasonal"){ loadJobs(true); }
  else { sSkip=0;sDone=false;sJobs=[]; loadSheetMeta(true); }
}

function clearAllFilters(){
  fTitles=[];_mfGrupos=[];_mfBeginMonths=[];
  const msrt=g("#mf-sort");if(msrt)msrt.value="random";
  _mfRenderMonths();
  const fs=g("#f-state");if(fs)fs.value="";
  _mfRenderStateChips();
  const fc=g("#f-city");if(fc)fc.value="";
  const fw=g("#f-wage");if(fw)fw.value="";
  const fwk=g("#f-workers");if(fwk)fwk.value="";
  const ds=g("#mf-dol-status");if(ds)ds.value="";
  if(_mfCtx==="jobs"){
    fCat="all";fGrupos=[];fEtaStatus="";
    document.querySelectorAll("#cat-chips-jobs .cat-chip").forEach(b=>b.classList.toggle("on",b.dataset.cat==="all"));
  }
  _mfRenderGrupos();renderTitlesFilterList();_masterFiltersSyncBadge();
}

function closeMasterFilters(){
  g("#master-filters-overlay")?.classList.add("gone");
  if(_mfCtx==="auto"){_mfCtx="jobs";_mfLoad(_mfCtxState.jobs||{});}
}

// ═══════════════════════════════════════════════════════════════
//  CHIPS DE FILTROS ATIVOS — manual e automático (mesmo modelo)
// ═══════════════════════════════════════════════════════════════
function _chip(label,onclick,color){
  color=color||"var(--purple)";
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--sf2);border:1.5px solid ${color}44;border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:${color}">${label}<button onclick="${onclick}" style="background:none;border:none;cursor:pointer;color:${color};padding:0;line-height:1;font-size:13px;font-weight:800;margin-left:2px">×</button></span>`;
}

function renderJobsFilterChips(){
  const box=g("#jobs-filter-chips");if(!box)return;
  const chips=[];
  if(fTitles.length)chips.push(_chip(`🏷️ ${fTitles.length} cargo(s)`,"mfClearJobsDim('titles')"));
  if(fCat&&fCat!=="all"){
    // v167 (revisão 07/09/2026): mostrava a CHAVE crua da categoria
    // (ex.: "equipment_op") em vez do rótulo traduzido que o próprio chip
    // de categoria já usa (sheetCats[tab], vindo de /api/sheet-categories) —
    // único ponto do fluxo de filtros que ficava fora da tradução.
    const _cl=(sheetCats[tab]||[]).find(c=>c.key===fCat);
    chips.push(_chip(`📂 ${esc(_cl?_cl.label:fCat)}`,"mfClearJobsDim('cat')"));
  }
  const st=g("#f-state")?.value||"";if(st)chips.push(_chip(`📍 ${esc(st)}`,"mfClearJobsDim('state')","var(--blue)"));
  const ci=(g("#f-city")?.value||"").trim();if(ci)chips.push(_chip(`🏙️ ${esc(ci)}`,"mfClearJobsDim('city')","var(--blue)"));
  const wg=parseFloat(g("#f-wage")?.value||0);if(wg)chips.push(_chip(`💰 $${wg}+/h`,"mfClearJobsDim('wage')","var(--green)"));
  const wk=parseInt(g("#f-workers")?.value||0);if(wk)chips.push(_chip(`👥 ${wk}+ vagas`,"mfClearJobsDim('workers')","var(--green)"));
  if(fGrupos.length)chips.push(_chip(`💎 Grupo ${fGrupos.join(",")}`,"mfClearJobsDim('grupos')","#d97706"));
  if(fEtaStatus)chips.push(_chip(`📶 ${esc(fEtaStatus.slice(0,22))}`,"mfClearJobsDim('status')","#d97706"));
  if(fBeginMonths.length)chips.push(_chip(`📅 Início: ${fBeginMonths.map(m=>_MF_MONTH_LABELS[m-1]).join(", ")}`,"mfClearJobsDim('months')","var(--blue)"));
  if(fSort&&fSort!=="random"&&tab!=="seasonal")chips.push(_chip(`↕️ ${fSort==="wage"?"Maior salário":fSort==="start"?"Começa cedo":fSort==="match"?"🎯 Melhor pra mim":"Recentes"}`,"mfClearJobsDim('sort')","var(--purple)"));
  if(!chips.length){box.style.display="none";box.innerHTML="";return;}
  box.style.display="flex";
  box.innerHTML=chips.join("")+`<button onclick="mfClearJobsDim('all')" style="background:none;border:1px solid var(--border2);border-radius:20px;padding:3px 10px;font-size:11px;color:var(--t3);cursor:pointer;font-family:inherit">Limpar tudo</button>`;
}
function mfClearJobsDim(dim){
  if(dim==="titles"||dim==="all")fTitles=[];
  if(dim==="cat"||dim==="all"){fCat="all";document.querySelectorAll("#cat-chips-jobs .cat-chip").forEach(b=>b.classList.toggle("on",b.dataset.cat==="all"));}
  if(dim==="state"||dim==="all"){const el=g("#f-state");if(el)el.value="";}
  if(dim==="city"||dim==="all"){const el=g("#f-city");if(el)el.value="";}
  if(dim==="wage"||dim==="all"){const el=g("#f-wage");if(el)el.value="";}
  if(dim==="workers"||dim==="all"){const el=g("#f-workers");if(el)el.value="";}
  if(dim==="grupos"||dim==="all"){fGrupos=[];if(_mfCtx==="jobs")_mfGrupos=[];}
  if(dim==="status"||dim==="all"){fEtaStatus="";const ds=g("#mf-dol-status");if(ds&&_mfCtx==="jobs")ds.value="";}
  if(dim==="months"||dim==="all"){fBeginMonths=[];if(_mfCtx==="jobs"){_mfBeginMonths=[];_mfRenderMonths();}}
  if(dim==="sort"||dim==="all"){fSort="random";const ms=g("#mf-sort");if(ms)ms.value="random";}
  if(dim==="state"||dim==="all")_mfRenderStateChips();
  _mfRenderGrupos();renderTitlesFilterList?.();
  applyF();renderJobsFilterChips();
}

function renderAutoFilterChips(){
  const box=g("#auto-filter-chips");if(!box)return;
  const chips=[];
  if(afTitles.length)chips.push(_chip(`🏷️ ${afTitles.length} cargo(s)`,"mfClearAutoDim('titles')"));
  const st=g("#af-state")?.value||"";if(st)chips.push(_chip(`📍 ${esc(st)}`,"mfClearAutoDim('state')","var(--blue)"));
  const ci=(g("#af-city")?.value||"").trim();if(ci)chips.push(_chip(`🏙️ ${esc(ci)}`,"mfClearAutoDim('city')","var(--blue)"));
  const wg=parseFloat(g("#af-min-wage")?.value||0);if(wg)chips.push(_chip(`💰 $${wg}+/h`,"mfClearAutoDim('wage')","var(--green)"));
  const wk=parseInt(g("#af-min-workers")?.value||0);if(wk)chips.push(_chip(`👥 ${wk}+ vagas`,"mfClearAutoDim('workers')","var(--green)"));
  if(afGrupos.length)chips.push(_chip(`💎 Grupo ${afGrupos.join(",")}`,"mfClearAutoDim('grupos')","#d97706"));
  if(afEtaStatus)chips.push(_chip(`📶 ${esc(afEtaStatus.slice(0,22))}`,"mfClearAutoDim('status')","#d97706"));
  if(afBeginMonths.length)chips.push(_chip(`📅 Início: ${afBeginMonths.map(m=>_MF_MONTH_LABELS[m-1]).join(", ")}`,"mfClearAutoDim('months')","var(--blue)"));
  if(!chips.length){box.innerHTML="";return;}
  box.innerHTML=chips.join("")+`<button onclick="mfClearAutoDim('all')" style="background:none;border:1px solid var(--border2);border-radius:20px;padding:3px 10px;font-size:11px;color:var(--t3);cursor:pointer;font-family:inherit">Limpar tudo</button>`;
}
function mfClearAutoDim(dim){
  const set=(id,v)=>{const el=g(id);if(el)el.value=v;};
  if(dim==="titles"||dim==="all")afTitles=[];
  if(dim==="state"||dim==="all")set("#af-state","");
  if(dim==="city"||dim==="all")set("#af-city","");
  if(dim==="wage"||dim==="all")set("#af-min-wage","");
  if(dim==="workers"||dim==="all")set("#af-min-workers","");
  if(dim==="grupos"||dim==="all")afGrupos=[];
  if(dim==="status"||dim==="all")afEtaStatus="";
  if(dim==="months"||dim==="all")afBeginMonths=[];
  _mfCtxState.auto=null; // snapshot invalidado — será remontado do estado real
  renderAutoFilterChips();_syncAutoFiltersBadge();refreshAutoFilterCount();
}
function _syncAutoFiltersBadge(){
  let c=0;
  if(afTitles.length)c++;
  if((g("#af-state")?.value||""))c++;
  if((g("#af-city")?.value||"").trim())c++;
  if(parseFloat(g("#af-min-wage")?.value||0))c++;
  if(parseInt(g("#af-min-workers")?.value||0))c++;
  if(afGrupos.length)c++;
  if(afEtaStatus)c++;
  const b=g("#auto-filters-badge");
  if(b){if(c){b.style.display="";b.textContent=String(c);}else b.style.display="none";}
}

// Contagem ao vivo: quantas vagas sobram com TODOS os filtros do automático
let _afCountSeq=0;
async function refreshAutoFilterCount(){
  const box=g("#af-filter-count");if(!box)return;
  if(!autoSelectedSrc){box.style.display="none";return;}
  const seq=++_afCountSeq;
  const p=new URLSearchParams({sheet:autoSelectedSrc,skip:0,top:1,hideSent:"1"});
  const st=g("#af-state")?.value||"";const ci=(g("#af-city")?.value||"").trim();
  const wg=parseFloat(g("#af-min-wage")?.value||"0")||0;const wk=parseInt(g("#af-min-workers")?.value||"0")||0;
  if(st)p.append("state",st);if(ci)p.append("city",ci);
  if(wg>0)p.append("minWage",String(wg));if(wk>0)p.append("minWorkers",String(wk));
  if(autoSelectedCats&&autoSelectedCats.length)p.append("category",autoSelectedCats.join(","));
  if(afTitles.length)p.append("titles",afTitles.join(","));
  if(afGrupos.length)p.append("grupos",afGrupos.join(","));
  if(afEtaStatus)p.append("dolStatus",afEtaStatus);
  if(afBeginMonths.length)p.append("beginMonth",afBeginMonths.join(",")); // v22
  box.style.display="block";box.innerHTML='<span class="spin spin-sm"></span> Contando vagas...';
  try{
    const r=await fetch("/api/sheet-meta?"+p,{credentials:"include"});const d=await r.json();
    if(seq!==_afCountSeq)return; // resposta antiga — descarta
    const t=d.total||0;
    box.innerHTML=t>0?`✅ <strong>${t.toLocaleString()}</strong> vaga(s) encontradas com esses filtros`:`⚠️ <span style="color:var(--amber)">Nenhuma vaga com esses filtros — afrouxe algum critério.</span>`;
  }catch{if(seq===_afCountSeq)box.style.display="none";}
}

// ═══════════════════════════════════════════════════════════════
//  PASSO 3 DO WIZARD — escolha do currículo (perfil)
// ═══════════════════════════════════════════════════════════════
// v19 (dono, 15/07): tipo de visto da vaga no frontend — espelho do servidor
function _jobVisaTypeFront(jOrSrc){
  if(typeof jOrSrc==="string"){const s=jOrSrc.toLowerCase();if(s.includes("h2a"))return"h2a";if(s&&s!=="seasonal"&&s!=="manual")return"h2b";return null;}
  const v=String(jOrSrc?.visa||jOrSrc?.visaType||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(v.includes("H2A"))return"h2a";
  if(v.includes("H2B"))return"h2b";
  return null;
}
function renderAutoProfileCards(){
  const el=g("#auto-profile-cards");if(!el)return;
  const profiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false&&p.allowAuto!==false);
  if(!profiles.length){
    el.innerHTML=`<div style="font-size:12px;color:var(--t3);padding:8px 0">Nenhum perfil disponível para o automático. <span style="color:var(--blue);cursor:pointer;font-weight:700" onclick="sv('profile');setTimeout(()=>{switchProfileTab('profiles');setTimeout(openProfileEditor,200)},100)">Criar perfil →</span></div>`;
    autoSelectedProfileId=null;return;
  }
  // v19: a fonte escolhida no Passo 1 define o tipo — planilha H-2A usa o
  // perfil H-2A; H-2B usa o H-2B. Pré-seleciona o do tipo certo.
  const srcVt=_jobVisaTypeFront(autoSelectedSrc||"");
  const matching=srcVt?profiles.find(p=>(p.visaType||"h2b")===srcVt):null;
  const last=localStorage.getItem("h2b_lastAutoProfile");
  if(matching){
    autoSelectedProfileId=matching.id;
  } else if(!autoSelectedProfileId||!profiles.some(p=>p.id===autoSelectedProfileId)){
    autoSelectedProfileId=(profiles.find(p=>p.id===last)||profiles.find(p=>p.isFavorite)||profiles[0]).id;
  }
  const _warnMissing=(srcVt&&!matching)
    ?`<div style="font-size:11px;color:var(--amber);background:var(--amberl);border:1px solid var(--amberb);border-radius:8px;padding:7px 10px;margin-bottom:4px">⚠️ Essas vagas são <strong>${srcVt==="h2a"?"H-2A":"H-2B"}</strong> e você ainda não tem um perfil ${srcVt==="h2a"?"H-2A":"H-2B"} — vai usar o perfil existente. <span style="color:var(--blue);cursor:pointer;font-weight:700" onclick="sv('profile');setTimeout(()=>{switchProfileTab('profiles');setTimeout(()=>openProfileEditor(null,'${srcVt}'),200)},100)">Criar perfil ${srcVt==="h2a"?"H-2A":"H-2B"} →</span></div>`:"";
  el.innerHTML=_warnMissing+profiles.map(p=>{
    const sel=p.id===autoSelectedProfileId;
    const vt=(p.visaType||"h2b");
    const vtTag=vt==="h2a"?'<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:5px;background:rgba(16,185,129,.15);color:#059669;margin-left:4px">H-2A</span>':'<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:5px;background:rgba(37,99,235,.12);color:#2563eb;margin-left:4px">H-2B</span>';
    const _mismatch=srcVt&&vt!==srcVt&&matching; // existe o perfil do tipo certo, este é do outro tipo
    const nSubj=(p.subjects||[p.subject]).filter(Boolean).length;
    const nBody=(p.emailBodies||[p.body]).filter(Boolean).length;
    const hasPdf=!!(p.pdfName||p.resumeIdx!=null);
    const pdf=p.pdfName?esc(p.pdfName):(p.resumeIdx!=null?"currículo vinculado":`<span style="color:var(--red)">sem currículo!</span>`);
    return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:2px solid ${sel?"var(--purple)":"var(--border2)"};border-radius:10px;cursor:${_mismatch?"not-allowed":"pointer"};background:${sel?"var(--purplel)":"var(--sf2)"};transition:all .15s;${_mismatch?"opacity:.45":""}" ${_mismatch?`title="Essas vagas são ${srcVt==="h2a"?"H-2A":"H-2B"} — o sistema usa o perfil ${srcVt==="h2a"?"H-2A":"H-2B"} automaticamente"`:`onclick="selectAutoProfile('${p.id}')"`}>
      <input type="radio" name="auto-prf" value="${p.id}" ${sel?"checked":""} ${_mismatch?"disabled":""} style="accent-color:var(--purple);pointer-events:none">
      <span style="font-size:20px">${p.icon||"🎯"}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}${vtTag}${p.isFavorite?" ⭐":""}</div>
        <div style="font-size:10.5px;color:var(--t3);margin-top:1px">📄 ${pdf} · ${nSubj} assunto(s) · ${nBody} corpo(s)${!hasPdf?"":""}</div>
      </div>
      ${sel?'<i class="ti ti-circle-check-filled" style="color:var(--purple);font-size:18px"></i>':""}
    </label>`;
  }).join("");
}
function selectAutoProfile(id){
  autoSelectedProfileId=id;
  try{localStorage.setItem("h2b_lastAutoProfile",id);}catch{}
  renderAutoProfileCards();
}


async function loadTabCounts(){
  for(const sh of["jan2026","jul2025","h2a-jun2026"]){
    const scId = sh==="jan2026"?"jan":sh==="jul2025"?"jul":"h2a";
    try{const r=await fetch(`/api/sheet-meta?sheet=${sh}&skip=0&top=1`,{credentials:"include"});const d=await r.json();const el=g("#sc-"+scId);if(el&&d.total)el.textContent=d.total>999?Math.round(d.total/1000)+"k":String(d.total);}catch{}
  }
}

// ═══════════════════════════════════════════
//  JOBS (Seasonal)
// ═══════════════════════════════════════════
let stmr;
function onSearch(){clearTimeout(stmr);stmr=setTimeout(()=>{const q=g("#q").value.trim();if(q!==fQ){fQ=q;if(tab==="seasonal")loadJobs(true);else{sSkip=0;sDone=false;sJobs=[];loadSheetMeta(true);}}},350);}
function applyF(){fState=g("#f-state")?.value||"";fWage=parseFloat(g("#f-wage")?.value||0);fWorkers=parseInt(g("#f-workers")?.value||0);fBeginMonths=[..._mfBeginMonths];fSort=g("#mf-sort")?.value||fSort;_masterFiltersSyncBadge();renderJobsFilterChips();if(tab==="seasonal")loadJobs(true);else{sSkip=0;sDone=false;sJobs=[];g("#jlist").innerHTML="";loadSheetMeta(true);}}
function setType(t){fType=t;["all","agri","nonag"].forEach(k=>g("#ft-"+k)?.classList.remove("on"));const m={all:"ft-all",agricultural:"ft-agri","non-agricultural":"ft-nonag"};g("#"+m[t])?.classList.add("on");_masterFiltersSyncBadge();if(tab==="seasonal")loadJobs(true);}
function setStat(s){fStat=s;g("#fs-all")?.classList.toggle("on",s==="all");g("#fs-active")?.classList.toggle("on",s==="active");_masterFiltersSyncBadge();if(tab==="seasonal")loadJobs(true);}
/* v114: seletores sugestivos de lugar ao lado da busca. As listas vêm de
   /api/lugares (estados/cidades REAIS da planilha atual + regiões
   turísticas). Escolheu estado → vira chip de estado (mfAddState, mesmo
   fluxo do modal); escolheu cidade/região → preenche #f-city e aplica. */
let _lugaresTab=null,_lugaresData=null;
async function loadLugares(){
  try{
    if(_lugaresTab===tab)return;
    const d=await fetch("/api/lugares?sheet="+encodeURIComponent(tab),{credentials:"include"}).then(r=>r.json());
    if(!d.ok)return;
    _lugaresTab=tab;
    _lugaresData=d; // v119: alimenta as sugestões instantâneas da busca (#q-sug)
    const de=g("#dl-estados");if(de)de.innerHTML=(d.estados||[]).map(e=>`<option value="${esc(e.n)}">${e.q} vagas</option>`).join("");
    const dc=g("#dl-cidades");if(dc)dc.innerHTML=
      (d.regioes||[]).map(r=>`<option value="${esc(r)}">região</option>`).join("")+
      (d.cidades||[]).map(c=>`<option value="${esc(c.n)}">${esc(c.e||"")} · ${c.q} vaga${c.q>1?"s":""}</option>`).join("");
  }catch(e){}
}
function qEstadoPick(v){
  v=String(v||"").trim();if(!v)return;
  // aceita parcial: "mass" → MASSACHUSETTS (primeira opção que contém)
  const op=[...(g("#dl-estados")?.options||[])].map(o=>o.value);
  const alvo=op.find(o=>o.toLowerCase()===v.toLowerCase())||op.find(o=>o.toLowerCase().includes(v.toLowerCase()));
  if(!alvo){toast("Estado não encontrado nesta planilha","r");return;}
  const el=g("#q-estado");if(el)el.value="";
  if(typeof mfAddState==="function")mfAddState(alvo);else{const fs2=g("#f-state");if(fs2)fs2.value=alvo;}
  applyF();
  toast("📍 "+alvo+" filtrado","g");
}
function qCidadePick(v){
  v=String(v||"").trim();
  const fc=g("#f-city");if(fc)fc.value=v;
  applyF();
  if(v)toast("🏙️ Filtrando por "+v,"g");
}
/* ═══ 🔎 v119: SUGESTÕES INSTANTÂNEAS ao digitar na busca de vagas ═══
   Padrão de mercado (Indeed/LinkedIn, guias Baymard/UX Mag): dropdown
   agrupado com rótulos, no máx ~9 itens, trecho digitado em destaque,
   navegação por setas + Enter, Esc fecha. Dados 100% locais (o índice
   já veio no /api/lugares — zero requisição por tecla). */
const _normSug=s=>String(s||"").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/["'‘’`´]/g,"").replace(/[^a-z0-9@.\s]+/g," ").replace(/\s+/g," ").trim();
let _sugIdx=-1,_sugItems=[];
function _sugHi(nome,ql){
  const n=_normSug(nome);const i=n.indexOf(ql);
  if(i<0)return esc(nome);
  // mapeia o trecho normalizado de volta pro texto original (mesmo tamanho aprox.)
  return esc(nome.slice(0,i))+"<b>"+esc(nome.slice(i,i+ql.length))+"</b>"+esc(nome.slice(i+ql.length));
}
function qSugInput(){
  const box=g("#q-sug");if(!box)return;
  const ql=_normSug(g("#q")?.value||"");
  if(ql.length<2||!_lugaresData){qSugClose();return;}
  const d=_lugaresData;
  const pick=(arr,cap)=>{
    const st=[],inc=[];
    for(const it of (arr||[])){
      const n=_normSug(it.n||it);
      if(n.startsWith(ql))st.push(it);else if(n.includes(ql))inc.push(it);
      if(st.length>=cap)break;
    }
    return st.concat(inc).slice(0,cap);
  };
  const grupos=[
    {lbl:t('sug_companies'),ico:"ti-building",kind:"empresa",itens:pick(d.empresas,3)},
    {lbl:t('sug_roles'),ico:"ti-briefcase",kind:"cargo",itens:pick(d.cargos,2)},
    {lbl:t('sug_cities'),ico:"ti-map-pin",kind:"cidade",itens:pick(d.cidades,2)},
    {lbl:t('sug_regions'),ico:"ti-beach",kind:"cidade",itens:pick((d.regioes||[]).map(r=>({n:r})),1)},
    {lbl:t('sug_states'),ico:"ti-map",kind:"estado",itens:pick(d.estados,1)},
  ].filter(gp=>gp.itens.length);
  _sugItems=[];_sugIdx=-1;
  if(!grupos.length){qSugClose();return;}
  let html="";
  for(const gp of grupos){
    html+=`<div class="q-sug-grp">${esc(gp.lbl)}</div>`;
    for(const it of gp.itens){
      const idx=_sugItems.length;
      _sugItems.push({kind:gp.kind,v:it.n});
      const meta=it.q?`${Number(it.q).toLocaleString("pt-BR")} ${t('sug_jobs')}`+(it.e?` · ${esc(it.e)}`:""):(it.e?esc(it.e):"");
      html+=`<div class="q-sug-it" data-i="${idx}" role="option" onmousedown="event.preventDefault();qSugPick(${idx})"><i class="ti ${gp.ico}"></i><span>${_sugHi(it.n,ql)}</span>${meta?`<span class="q-sug-meta">${meta}</span>`:""}</div>`;
    }
  }
  box.innerHTML=html;box.classList.add("open");
  g("#q")?.setAttribute("aria-expanded","true");
}
function qSugPick(i){
  const it=_sugItems[i];if(!it)return;
  qSugClose();
  if(it.kind==="estado"){const el=g("#q");if(el)el.value="";fQ="";qEstadoPick(it.v);return;}
  if(it.kind==="cidade"){const el=g("#q");if(el)el.value="";fQ="";qCidadePick(it.v);return;}
  // empresa/cargo → vira a própria busca, na hora (sem esperar o debounce)
  const el=g("#q");if(el)el.value=it.v;
  clearTimeout(stmr);fQ=it.v;
  if(tab==="seasonal")loadJobs(true);else{sSkip=0;sDone=false;sJobs=[];loadSheetMeta(true);}
}
function qSugKey(ev){
  const box=g("#q-sug");if(!box||!box.classList.contains("open")){if(ev.key==="Escape")qSugClose();return;}
  if(ev.key==="ArrowDown"||ev.key==="ArrowUp"){
    ev.preventDefault();
    _sugIdx+=(ev.key==="ArrowDown"?1:-1);
    if(_sugIdx<0)_sugIdx=_sugItems.length-1;
    if(_sugIdx>=_sugItems.length)_sugIdx=0;
    [...box.querySelectorAll(".q-sug-it")].forEach(el=>el.classList.toggle("on",+el.dataset.i===_sugIdx));
    box.querySelector(".q-sug-it.on")?.scrollIntoView({block:"nearest"});
  }else if(ev.key==="Enter"&&_sugIdx>=0){ev.preventDefault();qSugPick(_sugIdx);}
  else if(ev.key==="Escape"){qSugClose();}
}
function qSugClose(){const box=g("#q-sug");if(box){box.classList.remove("open");box.innerHTML="";}_sugIdx=-1;_sugItems=[];g("#q")?.setAttribute("aria-expanded","false");}
function qSugBlur(){setTimeout(qSugClose,160);}

/* 📡 v134: RADAR DE VAGAS (aprovado pelo dono) — salva os filtros atuais e
   o servidor avisa por push quando entrar vaga nova que combina (máx 1/dia). */
async function radarModal(){
  let r=null;try{const d=await fetch("/api/radar",{credentials:"include"}).then(x=>x.json());r=d.radar;}catch(e){}
  const ov=document.createElement("div");
  ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)";
  const cur=r?`<div style="background:var(--sf2);border:1.5px solid var(--border2);border-radius:12px;padding:12px;margin-bottom:12px;font-size:13px">
      <b>📡 ${esc(t('radar_active'))}</b><br>
      <span style="color:var(--t2)">${[r.q&&("🔎 "+esc(r.q)),(r.estados||[]).length?("📍 "+r.estados.map(esc).join(", ")):"",r.cidade&&("🏙️ "+esc(r.cidade))].filter(Boolean).join(" · ")||esc(t('radar_all'))}</span>
      <div style="font-size:11px;color:var(--t3);margin-top:4px">🔔 ${(r.totalAvisos||0)} ${esc(t('radar_alerts'))}</div>
      <button class="btn btn-danger btn-sm" style="margin-top:8px" onclick="radarRemove();this.closest('div[style*=fixed]').remove()">🗑️ ${esc(t('radar_off'))}</button>
    </div>`:"";
  ov.innerHTML=`<div style="background:var(--sf);border-radius:18px;padding:22px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25)">
    <div style="font-size:17px;font-weight:800;margin-bottom:6px">📡 ${esc(t('radar_title'))}</div>
    <div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:12px">${esc(t('radar_sub'))}</div>
    ${cur}
    <button class="btn btn-primary" style="width:100%" onclick="radarCreate();this.closest('div[style*=fixed]').remove()">📡 ${esc(t('radar_create'))}</button>
    <button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="this.closest('div[style*=fixed]').remove()">${esc(t('cancel'))}</button>
  </div>`;
  ov.addEventListener("click",e=>{if(e.target===ov)ov.remove();});
  document.body.appendChild(ov);
}
async function radarCreate(){
  const payload={estados:fState?[fState]:[],cidade:(g("#f-city")?.value||"").trim(),q:(g("#q")?.value||fQ||"").trim(),categoria:""};
  try{
    const d=await fetch("/api/radar",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}).then(x=>x.json());
    if(d.ok){toast("📡 "+t('radar_created'),"g");try{_autoPushSetup().catch(()=>{});}catch(e){}}
    else toast(d.error||"Erro","r");
  }catch(e){toast("❌ "+e.message,"r");}
}
async function radarRemove(){
  try{await fetch("/api/radar",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({remove:true})});toast(t('radar_removed'),"g");}catch(e){}
}

/* ⭐ v134: FUNIL — limite diário atingido = mostrar o que ele está perdendo
   e o link pra assinar um plano a 1 clique. No máx 1x por dia (não vira
   perseguição). v170: linguagem de assinatura direta, sem diamante. */
function limitUpsell(){
  try{const day=new Date().toISOString().slice(0,10);if(localStorage.getItem("h2b_upsell")===day)return;localStorage.setItem("h2b_upsell",day);}catch(e){}
  const rest=(typeof total!=="undefined"&&total>1)?total:null;
  const ov=document.createElement("div");
  ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)";
  ov.innerHTML=`<div style="background:var(--sf);border-radius:18px;padding:24px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center">
    <div style="font-size:40px;margin-bottom:6px">⭐</div>
    <div style="font-size:17px;font-weight:800;margin-bottom:8px">${esc(t('upsell_title'))}</div>
    <div style="font-size:13.5px;color:var(--t2);line-height:1.55;margin-bottom:16px">${rest?esc(t('upsell_left')).replace("{n}",rest.toLocaleString("pt-BR")):esc(t('upsell_left_generic'))}</div>
    <button class="btn btn-primary" style="width:100%" onclick="this.closest('div[style*=fixed]').remove();sv('plans')">⭐ ${esc(t('upsell_cta'))}</button>
    <button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="this.closest('div[style*=fixed]').remove()">${esc(t('upsell_later'))}</button>
  </div>`;
  ov.addEventListener("click",e=>{if(e.target===ov)ov.remove();});
  document.body.appendChild(ov);
}

function setSort(s){fSort=s;const _mf=g("#mf-sort");if(_mf&&[..._mf.options].some(o=>o.value===s))_mf.value=s;["rand:random","match:match","wage:wage","start:start","desc:desc"].forEach(p=>{const[i,v]=p.split(":");g("#so-"+i)?.classList.toggle("on",s===v);});renderJobsFilterChips();if(tab==="seasonal")loadJobs(true);else{sSkip=0;sDone=false;sJobs=[];loadSheetMeta(true);}}

const PAGE=25;
async function loadJobs(reset=false){
  if(loading)return;if(reset){skip=0;total=0;done=false;JOBS=[];g("#jlist").innerHTML=mkSkels(6);g("#lmore").innerHTML="";}
  if(done)return;loading=true;if(!reset)g("#lmore").innerHTML=`<div style="padding:14px;text-align:center"><span class="spin"></span></div>`;
  try{
    const p=new URLSearchParams({skip,top:PAGE});if(fQ)p.append("q",fQ);if(fState)p.append("state",fState);if(fType!=="all")p.append("jobType",fType);if(fStat!=="all")p.append("jobStatus",fStat);if(fSort!=="desc")p.append("sort",fSort);
    if(fWage>0)p.append("minWage",String(fWage));if(fWorkers>0)p.append("minWorkers",String(fWorkers));
    const r=await fetch("/api/jobs?"+p,{credentials:"include"});const d=await r.json();
    let jobs=d.jobs||[]; // wage/workers já filtrados pelo servidor
    if(reset)g("#jlist").innerHTML="";
    var _sj=jobs.filter(function(j){return !_isSentSeasonal(j.id)&&!(typeof empregadorStatus==="function"&&empregadorStatus(j.email));});
    if(!_sj.length&&!JOBS.length){done=true;g("#lmore").innerHTML=`<div style="padding:14px;text-align:center;font-size:13px;color:var(--t3)">Nenhuma vaga encontrada.</div>`;}
    else if(_sj.length){_sj.forEach(function(j){JOBS.push(j);g("#jlist").insertAdjacentHTML("beforeend",mkCard(j));});skip+=d.jobs.length;total=d.total||JOBS.length;if(d.jobs.length<PAGE){done=true;g("#lmore").innerHTML="";}else g("#lmore").innerHTML=`<div style="padding:14px;text-align:center"><button class="btn btn-secondary btn-sm" onclick="loadJobs()">Carregar mais</button></div>`;}
    // v90: número no formato pt-BR (16.277, não 16,277) e sem o selo técnico
    // "cache" — jargão de depuração que não diz nada pro usuário.
    const cnt=g("#jcount");if(cnt)cnt.innerHTML=`<strong>${total.toLocaleString("pt-BR")}</strong> vaga${total!==1?"s":""}`;
    const sib=g("#sib-jobs");if(sib){sib.style.display="";sib.textContent=total>999?"999+":String(total);}
  }catch(e){g("#lmore").innerHTML=`<div style="padding:14px;text-align:center;font-size:13px;color:var(--red)">Erro. <span style="cursor:pointer;text-decoration:underline" onclick="loadJobs()">Tentar novamente</span></div>`;}
  finally{loading=false;} // FIX: always libera lock
}

// ═══════════════════════════════════════════
//  SHEET JOBS
// ═══════════════════════════════════════════
async function loadSheetMeta(reset=false){
  if(sLoading)return;sLoading=true;if(!reset)g("#lmore").innerHTML=`<div style="padding:14px;text-align:center"><span class="spin"></span></div>`;
  let _jobsToEnrich=[];
  try{
    const fCity=g("#f-city")?.value.trim()||"";
    const p=new URLSearchParams({sheet:tab,skip:sSkip,top:PAGE,sort:fSort,hideSent:"1"});if(fQ)p.append("q",fQ);if(fState)p.append("state",fState);if(fCat&&fCat!=="all")p.append("category",fCat);
    if(fTitles.length)p.append("titles",fTitles.join(","));
    // FIX WAGE: mandar filtro de salário e vagas pro servidor (não filtrar no frontend por lote)
    if(fWage>0)p.append("minWage",String(fWage));if(fWorkers>0)p.append("minWorkers",String(fWorkers));
    if(fCity)p.append("city",fCity);
    if(fGrupos.length)p.append("grupos",fGrupos.join(","));
    if(fEtaStatus)p.append("dolStatus",fEtaStatus);
    if(fBeginMonths.length)p.append("beginMonth",fBeginMonths.join(",")); // v22
    const r=await fetch("/api/sheet-meta?"+p,{credentials:"include"});const d=await r.json();
    if(reset)g("#jlist").innerHTML="";
    if(!d.jobs?.length){sDone=true;g("#lmore").innerHTML=`<div style="padding:14px;text-align:center;font-size:13px;color:var(--t3)">${sJobs.length?"Sem mais vagas.":"Nenhuma vaga encontrada."}</div>`;}
    else{
      // Filtrar vagas já enviadas e as que estão no automático — por NÚMERO
      // e também por E-MAIL do empregador (v38: a regra do dono é por e-mail;
      // o servidor já corta via hideSent, esta é a cinta local)
      var _fj=d.jobs.filter(function(j){
        var cn=j.caseNum||j.id||"";
        if(_isSent(cn,tab)||_inAuto(cn))return false;
        if(j.email&&typeof empregadorStatus==="function"&&empregadorStatus(j.email))return false;
        return true;
      });
      var _removed=d.jobs.length-_fj.length;
      if(_removed>0&&reset){
        // Mostrar aviso de vagas removidas
        var _existing=document.getElementById("sheet-filter-warn");
        if(_existing)_existing.remove();
        var _bar=document.createElement("div");
        _bar.id="sheet-filter-warn";
        _bar.style.cssText="background:#fffbeb;border:1.5px solid #fde68a;border-radius:10px;padding:10px 14px;margin:10px 14px 0;font-size:12px;color:#92400e;display:flex;gap:8px;align-items:center";
        var _inAutoCount=[..._autoQueueIds].filter(function(id){return id&&id.length>3;}).length;
        var _msg=_inAutoCount>0
          ? _inAutoCount+" vaga"+(_inAutoCount!==1?"s":"")+" na fila do automático foram removidas desta listagem para evitar duplicatas."
          : _removed+" vaga"+(_removed!==1?"s enviadas foram removidas":' enviada foi removida')+" desta listagem.";
        _bar.innerHTML="<i class='ti ti-info-circle' style='font-size:15px;color:#f59e0b;flex-shrink:0'></i><span>"+_msg+"</span><button onclick='this.parentElement.remove()' style='background:none;border:none;cursor:pointer;color:#92400e;font-size:18px;padding:0;margin-left:auto;flex-shrink:0'>×</button>";
        var _jl=document.getElementById("jlist");if(_jl&&_jl.parentElement)_jl.parentElement.insertBefore(_bar,_jl);
      }
      _fj.forEach(function(j){sJobs.push(j);g("#jlist").insertAdjacentHTML("beforeend",mkSheetCard(j));});
      sSkip+=d.jobs.length;sTotal=d.total||sJobs.length;_jobsToEnrich=d.jobs;
      if(d.jobs.length<PAGE){sDone=true;g("#lmore").innerHTML="";}else g("#lmore").innerHTML=`<div style="padding:14px;text-align:center"><button class="btn btn-secondary btn-sm" onclick="loadSheetMeta()">Carregar mais</button></div>`;
    }
    const cnt=g("#jcount");if(cnt){
      const sentInSheet=HIST.filter(h=>h.sheetSource===tab||h.source===tab).length;
      const inAutoQueue=[..._autoQueueIds].length;
      const remaining=Math.max(0,sTotal-sentInSheet);
      // v90: nome REAL da planilha ativa (antes: ternário fixo que mostrava
      // "Jul 2025" pra qualquer outra planilha, e com as estações invertidas)
      const sheetLabel=_sheetLabelFor(tab);
      const wageFilter=fWage>0?` · <span style="font-size:11px;color:var(--green);font-weight:700">💰 ≥$${fWage}/h</span>`:"";
      const stateFilter=fState?` · <span style="font-size:11px;color:var(--blue)">📍 ${fState}</span>`:"";
      cnt.innerHTML=`<strong>${remaining.toLocaleString("pt-BR")}</strong> restantes · <span style="font-size:11px;color:var(--t3)">${sentInSheet>0?`<span style="color:var(--green)">✅ ${sentInSheet} enviadas</span> de ${sTotal.toLocaleString("pt-BR")}`:sTotal.toLocaleString("pt-BR")+` vagas`}</span> · <span style="font-size:11px;color:var(--blue)">${sheetLabel}</span>${wageFilter}${stateFilter}`;
    }
    const sib=g("#sib-jobs");if(sib){sib.style.display="";sib.textContent=sTotal>999?"999+":String(sTotal);}
  }catch(e){g("#lmore").innerHTML=`<div style="padding:14px;text-align:center;font-size:13px;color:var(--red)">Erro. <span style="cursor:pointer;text-decoration:underline" onclick="loadSheetMeta()">Tentar novamente</span></div>`;}
  finally{
    // FIX: always libera o lock — evita loading infinito em caso de erro ou timeout
    sLoading=false;
  }
  // Enriquece cards em background APÓS liberar sLoading (não bloqueia novos loads)
  if(_jobsToEnrich.length){
    const _snapTab=tab;
    for(let i=0;i<_jobsToEnrich.length;i+=10){
      if(tab!==_snapTab)break; // usuário trocou de aba — cancela enrich
      enrichSheet(_jobsToEnrich.slice(i,i+10));
      if(i+10<_jobsToEnrich.length)await new Promise(r=>setTimeout(r,200));
    }
  }
}

// Atualiza o contador de vagas restantes na aba ativa (chama após envio)
function updSheetCounter(){
  if(tab==="seasonal"){
    const total=JOBS.length;const sent=HIST.filter(h=>!h.sheetSource).length;
    const cnt=g("#jcount");if(cnt)cnt.innerHTML=`<strong>${total.toLocaleString("pt-BR")}</strong> vagas`;
    return;
  }
  const cnt=g("#jcount");if(!cnt||!sTotal)return;
  const sentInSheet=HIST.filter(h=>h.sheetSource===tab).length;
  const remaining=Math.max(0,sTotal-sentInSheet);
  const sheetLabel=_sheetLabelFor(tab); // v90: nome real da planilha ativa
  cnt.innerHTML=`<strong>${remaining.toLocaleString("pt-BR")}</strong> restantes · <span style="font-size:11px;color:var(--t3)">${sentInSheet>0?`<span style="color:var(--green)">${sentInSheet} enviadas</span> de ${sTotal.toLocaleString("pt-BR")}`:sTotal.toLocaleString("pt-BR")+` total`}</span> · <span style="font-size:11px;color:var(--blue)">${sheetLabel}</span>`;
}

function mkSheetCard(j){
  const iid="s_"+j.id.replace(/[^a-zA-Z0-9]/g,"_");
  // O servidor agora retorna: visa, active, title (occupation), category, state, start, workers, wage
  const jobTitle=j.title||j.occupation||j.company||"–";
  const catInfo=getOccupationCategoryByKey(j.category, jobTitle);
  const isApplied=APPLIED.has(j.id);

  // Monta tags completas com dados que já vêm do servidor
  const statusTag=j.active!==undefined
    ?(j.active
      ?'<span class="tag tg"><i class="ti ti-check" style="font-size:9px"></i>Ativa</span>'
      :'<span class="tag tr"><i class="ti ti-x" style="font-size:9px"></i>Inativa</span>')
    :"";
  const visaTag=j.visa
    ?`<span class="tag ${j.visa==="H-2A"?"ta":"tb"}">${j.visa}</span>`
    :'<span class="tag tb">H-2B</span>';
  const stateLbl=j.state&&j.state!=="–"?`<span class="tag tgr"><i class="ti ti-map-pin" style="font-size:9px"></i>${esc(j.state)}</span>`:"";
  const dateLbl=j.start&&j.start!=="–"?`<span class="tag ta"><i class="ti ti-calendar" style="font-size:9px"></i>${esc(j.start)}</span>`:"";
  const wageLbl=j.wage&&j.wage!=="–"?`<span class="tag tg">${esc(j.wage)}</span>`:"";
  const wkTag=j.workers&&j.workers>0?`<span class="tag tgr">👥 ${j.workers} vagas</span>`:"";

  const _inAutoQ=_autoQueueIds.has(j.id)||_autoQueueIds.has(j.caseNum);
  return`<div class="jcard${isApplied||_inAutoQ?" applied":""}" id="jcard-${iid}" onclick="selSheetJob('${esc(j.id)}')"${(isApplied||_inAutoQ)?' style="display:none"':""}>
    <div class="jcard-cat-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;padding-right:26px">
      <span class="jcard-cat-badge" id="jctg-cat-${iid}"><i class="ti ${catInfo.icon}" style="font-size:9px"></i> ${catInfo.name}</span>
      ${j.wage&&j.wage!=="–"?`<span style="font-size:12px;font-weight:800;color:#10b981">💰 ${esc(j.wage)}</span>`:""}
    </div>
    <div class="jcard-title" id="jct-${iid}">${esc(jobTitle)}</div>
    <div class="jcard-co" id="jcc-${iid}"><i class="ti ti-building" style="font-size:9px"></i>${esc(j.company||"–")} · <i class="ti ti-map-pin" style="font-size:9px"></i>${j.city&&j.city!=="–"?esc(j.city)+", ":""}${esc(j.state||"–")}</div>
    <div class="jcard-tags" id="jctg-${iid}">${statusTag}${visaTag}${stateLbl}${wkTag}${dateLbl}${wageLbl}</div>
    ${j.url?`<a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:rgba(59,130,246,.7);text-decoration:none;margin-top:3px"><i class="ti ti-external-link" style="font-size:9px"></i>Ver vaga DOL</a>`:""}
  </div>`;
}

// ══ Occupation category resolver ══
// v166 (Ordem 6f — público 100% brasileiro): nomes traduzidos pra PT, com o
// MESMO sentido dos rótulos de CATEGORY_LABELS (server.js) — pra não ter 2
// traduções divergentes da mesma categoria entre o badge do card e o chip
// de filtro. Ícones Tabler mantidos (já funcionam, sem risco de regressão
// visual — só o texto mudou).
const OCC_MAP=[
  {keys:["landscape","landscap","lawn","garden","groundskee","turf","horticultur","nursery","tree"],icon:"ti-leaf",name:"Jardim/Paisagismo"},
  {keys:["harvest","farm","agricultural","crop","plant","tobacco","pickle","cucumber","fruit","vegetable","orchard","berry","grape","mushroom"],icon:"ti-plant-2",name:"Fazenda/Agrícola"},
  {keys:["construction","carpenter","concrete","drywaller","mason","roofer","ironwork","electrician","plumber","welder","builder","pipefitter"],icon:"ti-building-factory-2",name:"Construção"},
  {keys:["housekeeper","housekeepin","hotel","motel","resort","room attend","laundry","linen"],icon:"ti-bed",name:"Hotelaria/Limpeza"},
  {keys:["seafood","crab","lobster","fish","shrimp","clam","oyster","scallop","blue crab","dungeness"],icon:"ti-fish",name:"Frutos do Mar"},
  {keys:["golf","greenskeep","caddie","fairway"],icon:"ti-golf",name:"Campo de Golfe"},
  {keys:["amusement","theme park","ride operat","carnival","fair"],icon:"ti-mood-happy",name:"Parque de Diversões"},
  {keys:["forest","timber","logging","reforestat","tree planting","sawmill"],icon:"ti-trees",name:"Florestal"},
  {keys:["lifeguard","swim","pool attendant","aquatic"],icon:"ti-swimming",name:"Salva-vidas"},
  {keys:["food prep","cook","kitchen","dishwasher","restaurant","cafeteria","food service","prep cook","line cook","food preparation"],icon:"ti-chef-hat",name:"Alimentação"},
  {keys:["cleaner","janitor","custodian","sanitation","maid"],icon:"ti-vacuum-cleaner",name:"Limpeza"},
  {keys:["driver","chauffeur","truck","delivery","transport"],icon:"ti-truck",name:"Motorista"},
  {keys:["ski","snowboard","winter","mountain","resort"],icon:"ti-snowflake",name:"Estação de Esqui"},
  {keys:["packer","packag","assembly","production","manufactur","process"],icon:"ti-box",name:"Produção/Embalagem"},
  {keys:["cashier","retail","sale","store","market"],icon:"ti-shopping-bag",name:"Varejo"},
];
function getOccupationCategory(title){
  if(!title)return{icon:"ti-briefcase",name:"Outros"};
  const tl=title.toLowerCase();
  for(const cat of OCC_MAP){if(cat.keys.some(k=>tl.includes(k)))return{icon:cat.icon,name:cat.name};}
  return{icon:"ti-briefcase",name:"Outros"};
}
function getOccupationCategoryByKey(catKey, title){
  // v167 (revisão 07/09/2026): o keyMap local só cobria 10 das ~30 chaves
  // reais (faltava TODA a família H-2A — crop/equipment_op/livestock/... —
  // e food/driver/ski/cleaning do H-2B), então ~80-100% das vagas dessas
  // categorias caíam no fallback por palavra-chave (getOccupationCategory)
  // e mostravam um nome DIFERENTE do chip de filtro (que usa CATEGORY_LABELS
  // via /api/category-groups) — ex.: "Ag Equipment Operator" virava "Outros"
  // no card mas "🚜 Operador de Máquinas" no chip. Fonte única agora: o mesmo
  // dicionário do servidor (window._catLabels, carregado por _ensureCatLabels
  // ao trocar de aba — nunca precisa do wizard do automático pra existir).
  const iconMap={
    landscape:"ti-leaf",construction:"ti-building-factory-2",housekeeper:"ti-bed",
    housekeeping:"ti-bed",seafood:"ti-fish",farm:"ti-plant-2",golf:"ti-golf",
    amusement:"ti-mood-happy",forest:"ti-trees",lifeguard:"ti-swimming",
  };
  const dictLabel=catKey&&window._catLabels&&window._catLabels[catKey]&&window._catLabels[catKey].label;
  if(dictLabel)return{icon:iconMap[catKey]||"ti-briefcase",name:dictLabel};
  // Dicionário do servidor ainda não carregou (raríssimo — 1ª fração de
  // segundo da 1ª visita) — mesmo fallback parcial de sempre, nunca pior.
  const keyMap={
    landscape:{icon:"ti-leaf",name:"Jardim/Paisagismo"},
    construction:{icon:"ti-building-factory-2",name:"Construção"},
    housekeeper:{icon:"ti-bed",name:"Hotelaria/Limpeza"},
    housekeeping:{icon:"ti-bed",name:"Hotelaria/Limpeza"},
    seafood:{icon:"ti-fish",name:"Frutos do Mar"},
    farm:{icon:"ti-plant-2",name:"Fazenda/Agrícola"},
    golf:{icon:"ti-golf",name:"Campo de Golfe"},
    amusement:{icon:"ti-mood-happy",name:"Parque de Diversões"},
    forest:{icon:"ti-trees",name:"Florestal"},
    lifeguard:{icon:"ti-swimming",name:"Salva-vidas"},
  };
  if(catKey&&keyMap[catKey])return keyMap[catKey];
  // Fall back to title-based detection (so "Food Preparation Workers" gets chef hat)
  return getOccupationCategory(title||"");
}

async function enrichSheet(cards){
  // Enriquece com dados do DOL — inclui vagas fromSheet:true (DOL estava offline antes)
  const toF=cards.filter(c=>!sCache[c.id]||sCache[c.id].fromSheet).map(c=>c.id);if(!toF.length)return;
  try{const r=await fetch("/api/sheet-batch",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({cases:toF.slice(0,10)})});const d=await r.json();for(const[cn,job]of Object.entries(d.jobs||{})){if(job&&!job.fromSheet){// DOL respondeu com dados reais — substitui cache local
  sCache[cn]=job;updSheetCard(cn,job);}}}catch{}
}

function updSheetCard(cn,job){
  const iid="s_"+cn.replace(/[^a-zA-Z0-9]/g,"_");
  const te=g("#jct-"+iid);const ce=g("#jcc-"+iid);const tge=g("#jctg-"+iid);const catEl=g("#jctg-cat-"+iid);const card=g("#jcard-"+iid);
  if(te)te.textContent=job.title||job.occupation||job.company||te.textContent;
  if(ce)ce.innerHTML=`<i class="ti ti-building" style="font-size:9px"></i>${esc(job.company)} · <i class="ti ti-map-pin" style="font-size:9px"></i>${esc(job.state)}`;
  // Update category badge with real title
  if(catEl){
    const catInfo=getOccupationCategoryByKey(job.category,job.title||job.occupation||"");
    catEl.innerHTML=`<i class="ti ${catInfo.icon}" style="font-size:9px"></i> ${catInfo.name}`;
  }
  if(tge)tge.innerHTML=`${job.active?'<span class="tag tg"><i class="ti ti-check" style="font-size:9px"></i>Ativa</span>':'<span class="tag tr"><i class="ti ti-x" style="font-size:9px"></i>Inativa</span>'}<span class="tag ${job.visa==="H-2A"?"ta":"tb"}">${esc(job.visa||"H-2B")}</span>${job.wage&&job.wage!=="–"?`<span class="tag tg">${esc(job.wage)}</span>`:""}<span class="tag tgr"><i class="ti ti-map-pin" style="font-size:9px"></i>${esc(job.state)}</span>${job.workers>1?`<span class="tag tgr">${job.workers}×</span>`:""}${job.start&&job.start!=="–"?`<span class="tag ta"><i class="ti ti-calendar" style="font-size:9px"></i>${esc(job.start)}</span>`:""}`;
  if(card&&APPLIED.has(cn))card.style.display="none";
  // 🧹 v38 (dono, 22/07): e-mail descoberto no enriquecimento pertence a
  // empregador JÁ contatado → o card some NA HORA (a regra é por e-mail do
  // empregador; o filtro do servidor não alcança vaga que ainda estava sem
  // e-mail na planilha — esta varredura fecha essa corrida).
  if(job&&job.email)_sweepContactedCard(cn,job.email);
}

// 🧹 GUARDA-RAIZ anti-duplicado (dono, 22/07/2026): "se a pessoa enviou,
// essa vaga não aparece mais pra ela". Empregador já contatado (enviado OU
// na fila do automático) → vaga varrida da lista no instante em que o
// e-mail é conhecido — antes do clique quando der, no clique quando não.
function _sweepContactedCard(cn,email){
  const st=(typeof empregadorStatus==="function")?empregadorStatus(email):null;
  if(!st)return null;
  const card=g("#jcard-s_"+String(cn).replace(/[^a-zA-Z0-9]/g,"_"));
  if(card&&card.style.display!=="none")card.style.display="none";
  return st;
}
// Mostra a vaga OU varre o card e explica — retorna true se mostrou.
function _showJobOrSweep(cn,j){
  const st=_sweepContactedCard(cn,j&&j.email);
  if(!st){selJob=j;showDetail(mkDetailHTML(j));return true;}
  selJob=null;
  const msg=st==="sent"
    ?"Você já enviou candidatura pra essa empresa — a vaga foi removida da sua lista. (Ela só volta se você resetar os enviados.)"
    :"Essa empresa está na fila do seu envio automático — o robô cuida dela. Vaga removida da sua lista.";
  toast(st==="sent"?"🧹 Já enviada — vaga removida da lista.":"🤖 Na fila do automático — vaga removida.","au");
  showDetail(`<div class="jd-content"><div class="alert al-green" style="margin-top:8px"><i class="ti ti-check"></i><div>${msg}</div></div></div>`);
  return false;
}

async function selSheetJob(cn){
  document.querySelectorAll(".jcard").forEach(c=>c.classList.remove("active"));
  g("#jcard-s_"+cn.replace(/[^a-zA-Z0-9]/g,"_"))?.classList.add("active");
  const loading=`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px;color:var(--t3)"><span class="spin spin-lg"></span><div style="font-size:13px;font-weight:600">Carregando detalhes...</div></div>`;
  showDetail(loading);
  // 1) Cache em memória — mais rápido (v38: com guarda de empregador contatado)
  if(sCache[cn]){_showJobOrSweep(cn,sCache[cn]);return;}
  // 2) Já temos o email em sJobs (vem do /api/sheet-meta com email da planilha local)
  //    Usa imediatamente sem esperar o DOL — compatível com DOL offline
  const localMeta=sJobs.find(x=>x.id===cn||x.caseNum===cn);
  if(localMeta&&localMeta.email){
    const j={...localMeta,fromSheet:true};
    sCache[cn]=j;
    if(!_showJobOrSweep(cn,j))return; // varrida — não enriquece nem abre
    // Tenta enriquecer em background com dados extras do DOL (não bloqueia envio)
    fetch(`/api/sheet-detail?case=${encodeURIComponent(cn)}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{if(d.job){sCache[cn]={...j,...d.job,email:d.job.email||j.email};updSheetCard(cn,sCache[cn]);}}).catch(()=>{});
    return;
  }
  // 3) Fallback: tenta buscar no servidor (que agora usa planilha local primeiro)
  try{
    const r=await fetch(`/api/sheet-detail?case=${encodeURIComponent(cn)}`,{credentials:"include"});const d=await r.json();
    if(d.job){sCache[cn]=d.job;updSheetCard(cn,d.job);_showJobOrSweep(cn,d.job);}
    else if(localMeta){
      // notFound no DOL mas temos dados locais — usa o que temos
      const j={...localMeta,fromSheet:true};sCache[cn]=j;_showJobOrSweep(cn,j);
    } else {
      const meta=localMeta||{};showDetail(`<div class="jd-content"><div style="font-size:15px;font-weight:800;margin-bottom:8px">${esc(meta.company||cn)}</div><div class="alert al-amber"><i class="ti ti-alert-triangle"></i><div>Vaga não encontrada no portal. Tente novamente em alguns minutos.<br><strong>Case:</strong> ${esc(cn)}</div></div></div>`);
    }
  }catch(e){
    // Erro de rede (DOL offline) — se tiver dados locais usa, senão mostra erro
    if(localMeta){const j={...localMeta,fromSheet:true};sCache[cn]=j;_showJobOrSweep(cn,j);}
    else{showDetail(`<div class="jd-content"><div class="alert al-red"><i class="ti ti-alert-circle"></i>Erro ao carregar vaga: ${esc(e.message)}</div></div>`);}
  }
}

// ═══════════════════════════════════════════
//  CARD + DETAIL
// ═══════════════════════════════════════════
function mkCard(j){
  const ap=APPLIED.has(j.id),_inAQ=_autoQueueIds.has(j.id)||_autoQueueIds.has(j.caseNum);
  // Occupation category detection with icons
  const catInfo=getOccupationCategory(j.title||"");
  // 🎯 v82: match score (0-100) — encaixe da vaga com o perfil do candidato.
  // null = sem perfil ainda (visitante ou perfil não preenchido) — some, não mostra 0%.
  const _mCor=j.matchScore>=70?"tg":j.matchScore>=40?"ta":"tr";
  const matchBadge=j.matchScore!=null?`<span class="tag ${_mCor}" title="${esc((j.matchWhy||[]).join(" · ")||"combinação com seu perfil")}"><i class="ti ti-target-arrow" style="font-size:9px"></i>${j.matchScore}%</span>`:"";
  return`<div class="jcard${(ap||_inAQ)?" applied":""}" id="jcard-${j.id}" onclick="selJob2('${j.id}')"${(ap||_inAQ)?' style="display:none"':""}
    <div class="jcard-cat-row">
      <span class="jcard-cat-badge"><i class="ti ${catInfo.icon}" style="font-size:9px"></i> ${catInfo.name}</span>
      ${matchBadge}
    </div>
    <div class="jcard-title">${esc(j.title)}</div>
    <div class="jcard-co"><i class="ti ti-building" style="font-size:9px"></i>${esc(j.company)}</div>
    <div class="jcard-tags">
      ${j.active?'<span class="tag tg"><i class="ti ti-check" style="font-size:9px"></i>Ativa</span>':'<span class="tag tr"><i class="ti ti-x" style="font-size:9px"></i>Inativa</span>'}
      <span class="tag ${j.visa==="H-2A"?"ta":"tb"}">${j.visa==="H-2A"?"H-2A":"H-2B"}</span>
      <span class="tag tgr"><i class="ti ti-map-pin" style="font-size:9px"></i>${esc(j.state)}</span>
      ${j.wage&&j.wage!=="–"?`<span class="tag tg">${esc(j.wage)}</span>`:""}
      ${j.workers>1?`<span class="tag ta">${j.workers}×</span>`:""}
      ${ap?'<span class="tag tp">✓</span>':""}
    </div>
  </div>`;
}

function selJob2(id){
  const j=JOBS.find(x=>x.id===id);if(!j)return;
  selJob=j;document.querySelectorAll(".jcard").forEach(c=>c.classList.remove("active"));g("#jcard-"+id)?.classList.add("active");
  showDetail(mkDetailHTML(j));
}

// v91 (reestruturação parte 4): data ISO → dd/mm/aaaa pro público brasileiro
function _fmtDataBR(v){const m=String(v||"").match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}/${m[2]}/${m[1]}`:String(v||"");}
function mkDetailHTML(j){
  // v91: campo sem dado NÃO vira traço feio ("–, TENNESSEE", "– → –",
  // "null posição(ões)") — ou mostra o dado de verdade, ou a caixa some.
  const _local=[j.city,j.state].filter(x=>x&&x!=="–").join(", ");
  const _temIni=j.start&&j.start!=="–", _temFim=j.end&&j.end!=="–";
  const _periodo=_temIni||_temFim?`${_temIni?_fmtDataBR(j.start):"A definir"} → ${_temFim?_fmtDataBR(j.end):"A definir"}`:"";
  const _nWk=parseInt(j.workers,10)||0;
  return`<div class="jd-content">
    <div class="jd-title">${esc(j.title)}</div>
    <div class="jd-co"><i class="ti ti-building"></i>${esc(j.company)}</div>
    <div class="jd-tags">
      ${j.active?'<span class="tag tg"><i class="ti ti-circle-check"></i>Ativa</span>':'<span class="tag tr">Inativa</span>'}
      <span class="tag ${j.visa==="H-2A"?"ta":"tb"}">${j.visa==="H-2A"?"🌾 H-2A Agrícola":"🔧 H-2B Não-Agrícola"}</span>
      ${APPLIED.has(j.id)?'<span class="tag tp"><i class="ti ti-check"></i>Enviado</span>':""}
    </div>
    ${j.matchScore!=null?`<div class="alert ${j.matchScore>=70?"al-green":j.matchScore>=40?"al-amber":"al-red"}" style="margin-top:8px"><i class="ti ti-target-arrow"></i><strong>${j.matchScore}% de encaixe com seu perfil</strong>${(j.matchWhy||[]).length?`<div style="font-size:11.5px;margin-top:3px;opacity:.85">${esc(j.matchWhy.join(" · "))}</div>`:""}</div>`:""}
    <div class="info-grid">
      <div class="info-box"><div class="info-lbl">Salário</div><div class="info-val">${esc(j.wage&&j.wage!=="–"?j.wage:"A combinar")}</div></div>
      ${_local?`<div class="info-box"><div class="info-lbl">Local</div><div class="info-val">${esc(_local)}</div></div>`:""}
      ${_local?`<div class="info-box" style="grid-column:1/-1;padding:0;border-color:rgba(52,211,153,.4)"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([j.company,j.addr,j.city,j.state].filter(x=>x&&x!=="–").join(", "))}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:9px;padding:12px 14px;color:#34d399;font-weight:800;font-size:13.5px;text-decoration:none"><i class="ti ti-map-pin-filled" style="font-size:18px"></i>Ver localização no Google Maps<i class="ti ti-external-link" style="margin-left:auto;font-size:14px;opacity:.7"></i></a></div>`:""}
      ${_nWk>0?`<div class="info-box"><div class="info-lbl">Vagas</div><div class="info-val">${_nWk} ${_nWk>1?"vagas":"vaga"}</div></div>`:""}
      ${_periodo?`<div class="info-box"><div class="info-lbl">Período</div><div class="info-val" style="font-size:12px">${esc(_periodo)}</div></div>`:""}
      ${j.phone?`<div class="info-box"><div class="info-lbl">📞 Telefone</div><div class="info-val" style="font-size:12px"><a href="tel:${esc(j.phone)}" style="color:var(--blue)">${esc(j.phone)}</a></div></div>`:""}
      ${j.email&&j.hasEmail?`<div class="info-box"><div class="info-lbl">📧 Email</div><div class="info-val" style="font-size:11px;word-break:break-all"><a href="mailto:${esc(j.email)}" style="color:var(--green)">${esc(j.email)}</a></div></div>`:""}
      ${j.hours?`<div class="info-box"><div class="info-lbl">⏰ Horas/semana</div><div class="info-val">${esc(j.hours)}h</div></div>`:""}
      ${j.schedule?`<div class="info-box"><div class="info-lbl">🕐 Horário</div><div class="info-val" style="font-size:12px">${esc(j.schedule)}</div></div>`:""}
      ${j.fullTime?`<div class="info-box"><div class="info-lbl">💼 Regime</div><div class="info-val">Tempo Integral</div></div>`:""}
      ${j.wageInfo?`<div class="info-box" style="grid-column:1/-1"><div class="info-lbl">💰 Info salarial</div><div class="info-val" style="font-size:11px">${esc(j.wageInfo)}</div></div>`:""}
      ${j.addr?`<div class="info-box" style="grid-column:1/-1"><div class="info-lbl">📍 Endereço do worksite</div><div class="info-val" style="font-size:12px">${esc(j.addr)}${j.zip?" — "+esc(j.zip):""}</div></div>`:""}
      ${j.soc||j.socTitle?`<div class="info-box"><div class="info-lbl">🏷️ Classificação SOC</div><div class="info-val" style="font-size:11px">${esc(j.soc||"")} ${esc(j.socTitle||"")}</div></div>`:""}
      ${j.req?`<div class="info-box" style="grid-column:1/-1"><div class="info-lbl">⚠️ Requisitos especiais</div><div class="info-val" style="font-size:11px;line-height:1.5">${esc(j.req)}</div></div>`:""}
      ${j.caseNum?`<div class="info-box"><div class="info-lbl">🔑 Nº do Caso (ETA)</div><div class="info-val" style="font-size:11px;font-family:monospace">${esc(j.caseNum)}</div></div>`:""}
      ${j.website?`<div class="info-box"><div class="info-lbl">🌐 Site empresa</div><div class="info-val"><a href="${esc(j.website)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue);font-size:11px">${esc(j.website)}</a></div></div>`:""}
      ${j.url?`<div class="info-box" style="grid-column:1/-1"><div class="info-lbl">🔗 Vaga oficial DOL</div><div class="info-val"><a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer" style="color:#818cf8;font-size:12px;display:flex;align-items:center;gap:4px;font-weight:700"><i class="ti ti-external-link"></i>${esc(j.url)}</a></div></div>`:""}
      ${j.desc?`<div class="info-box" style="grid-column:1/-1"><div class="info-lbl">📋 Funções da vaga <span class="vaga-desc-status" style="font-weight:400;text-transform:none"></span></div><div class="info-val vaga-desc-txt" data-case="${esc(j.caseNum||j.id||"")}" style="font-size:12px;line-height:1.7;white-space:pre-wrap;background:rgba(0,0,0,.2);border-radius:8px;padding:10px">${esc(j.desc)}</div></div>`:""}
    </div>
    <div class="jd-acts">
      ${j.hasEmail?`<button class="btn btn-primary" onclick="openModal('${j.id}')"><i class="ti ti-send"></i> Candidatar-se</button>`:`<div style="font-size:13px;color:var(--t3);padding:9px 13px;background:var(--sf2);border-radius:var(--r);border:1.5px solid var(--border)"><i class="ti ti-alert-triangle"></i> Sem e-mail direto</div>`}
      ${j.url?`<a class="btn btn-secondary" href="https://${j.url.replace(/^https?:\/\//,"")}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i></a>`:""}
    </div>
  </div>`;
}

function showDetail(html){
  qSugClose(); // ⚠️ QA 11/09: sem isso, o dropdown de sugestões de busca (z-index 90) ficava aberto por cima do painel de detalhe mobile (z-index 60) e podia roubar o primeiro toque do usuário
  const dc=g("#jd-content");const de=g("#jd-empty");
  if(dc&&de){de.classList.add("gone");dc.style.display="block";dc.innerHTML=html;}
  const mc=g("#mob-detail-content");if(mc)mc.innerHTML=html;
  g("#mob-detail")?.classList.add("show");
}
function closeMobDetail(){g("#mob-detail")?.classList.remove("show");}

// ═══════════════════════════════════════════
//  MODAL CANDIDATURA
// ═══════════════════════════════════════════
async function openModal(jobId){
  const j=JOBS.find(x=>x.id===String(jobId))||sCache[jobId]||null;
  if(!j)return;
  // 🔒 v172 (ORDEM DO DONO, 11/09/2026): "o site vai ser só pra pessoas
  // pagantes usarem" — plano ativo primeiro (senão manualLimit é 0 e cai
  // aqui igual a quem já esgotou o limite do dia, mas a mensagem certa é
  // outra), Gmail conectado depois. Servidor confere tudo de novo em
  // /api/send de qualquer forma — isto é só pra não deixar a pessoa se
  // perder escrevendo o e-mail inteiro pra descobrir só no fim que não pode.
  if(!U.isAdmin&&U.needsPlan){sv("plans");toast("⚠️ Você precisa de um plano ativo pra enviar candidaturas.","r",7000);return;}
  if(U.manualRemaining<=0){sv("plans");toast("Limite diário atingido. Assine um plano para mais envios.","r");return;}
  if(!U.gmailConnected){toast("⚠️ Conecte seu Gmail antes de enviar candidaturas.","r",7000);connectGmailForSending("jobs");return;}
  // Verifica se tem perfil (busca fresca para evitar falso negativo)
  let _profiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false);
  if(!_profiles.length){
    try{const _pr=await fetch("/api/profiles",{credentials:"include"}).then(r=>r.json());UPROFILES=_pr.profiles||[];if(U)U.profiles=UPROFILES;_profiles=UPROFILES.filter(p=>p.active!==false);}catch{}
  }
  if(!_profiles.length){
    if(confirm("Você precisa criar um perfil de currículo antes de candidatar.\nDeseja criar agora?")){
      sv("profile");
      setTimeout(()=>{switchProfileTab("profiles");setTimeout(openProfileEditor,200);},100);
    }
    return;
  }
  // Verifica currículo — só bloqueia se NENHUM perfil tem PDF vinculado
  const hasCvInProfiles=_profiles.some(p=>p.resumeIdx||p.cvs?.some(c=>c.cvType==="resume"));
  const hasCvInDocs=DOCS.some(c=>(c.cvType||"resume")==="resume");
  if(!hasCvInProfiles&&!hasCvInDocs){
    if(confirm("Você não tem currículo enviado.\nDeseja ir para os Perfis para vincular um PDF?")){
      sv("profile");
      setTimeout(()=>{switchProfileTab("profiles");setTimeout(openProfileEditor,200);},100);
    }
    return;
  }

  curJob=j;_currentModalJob=j;
  g("#m-title").textContent="Enviar Candidatura";
  g("#m-sub").textContent=j.company||"–";
  // Painel info da vaga
  const ti=g("#m-job-title");if(ti)ti.textContent=j.title||j.company||"–";
  const di=g("#m-job-details");
  if(di){
    const pts=[];
    if(j.company)pts.push(`<span style="display:flex;align-items:center;gap:3px"><i class="ti ti-building" style="font-size:11px;opacity:.6"></i>${esc(j.company)}</span>`);
    if(j.city||j.state)pts.push(`<span style="display:flex;align-items:center;gap:3px"><i class="ti ti-map-pin" style="font-size:11px;opacity:.6"></i>${esc([j.city,j.state].filter(Boolean).join(", "))}</span>`);
    if(j.wage&&j.wage!=="–")pts.push(`<span style="color:var(--green);font-weight:700;display:flex;align-items:center;gap:2px"><i class="ti ti-currency-dollar" style="font-size:11px"></i>${esc(j.wage)}</span>`);
    if(j.visa)pts.push(`<span class="tag ${j.visa==="H-2A"?"ta":"tb"}" style="font-size:10px;padding:1px 6px">${esc(j.visa)}</span>`);
    if(j.caseNum)pts.push(`<span style="font-family:monospace;font-size:10px;opacity:.5">${esc(j.caseNum)}</span>`);
    di.innerHTML=pts.join("");
  }
  const toEl=g("#m-to");if(toEl)toEl.value=j.email||"";
  g("#m-warn").innerHTML="";
  // Popular seletor "Enviar por" (só aparece se houver 2+ e-mails conectados)
  try{
    const sBox=g("#m-sender-box"),sSel=g("#m-sender");
    const extras=(U.senderEmails||[]).filter(x=>x.active!==false&&!x.tokenExpired);
    if(sBox&&sSel){
      if(extras.length){
        const saved=(()=>{try{return localStorage.getItem("h2b_manual_sender")}catch(e){return null}})();
        const opts=[{email:U.email,lbl:U.email+" (principal)"},...extras.map(x=>({email:x.email,lbl:x.email}))];
        sSel.innerHTML=opts.map(o=>`<option value="${esc(o.email)}" ${saved===o.email?"selected":""}>${esc(o.lbl)}</option>`).join("");
        sBox.style.display="block";
      } else { sBox.style.display="none"; }
    }
  }catch(e){}
  const pct=Math.min(100,Math.round((U.todaySentManual/U.manualLimit)*100));
  const col=pct>=80?"var(--red)":pct>=60?"var(--amber)":"var(--green)";
  g("#m-lim-lbl").textContent=t('manual_today');
  g("#m-lim-num").textContent=`${U.todaySentManual}/${U.manualLimit}`;
  g("#m-lbar").style.cssText=`width:${pct}%;background:${col}`;
  buildModalProfileSlots(j);
  buildCvSlots();
  /* v22: ai-btn removido */
  g("#m-sending").style.display="none";g("#m-send").disabled=false;
  g("#modal").classList.remove("gone");
}


function buildModalProfileSlots(j){
  const el=g("#m-profile-slots");if(!el)return;
  // Sempre usa UPROFILES (mais atualizado) com fallback para U.profiles
  const profiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false);
  if(!profiles.length){
    // 2026-07: sem perfil, deixa em branco em vez de preencher com texto pronto —
    // o aviso abaixo já manda a pessoa criar o perfil (com os textos dela mesma).
    el.innerHTML=`<div style="padding:10px 0;font-size:12px;color:var(--t3)">Você ainda não tem um perfil configurado. <span style="color:var(--blue);cursor:pointer;font-weight:700" onclick="closeModal();sv('profile');setTimeout(()=>{switchProfileTab('profiles');setTimeout(openMyProfile,200)},100)">Criar meu perfil →</span></div>`;
    const subjEl=g("#m-subj");if(subjEl)subjEl.value="";
    const bodyEl=g("#m-body");if(bodyEl)bodyEl.value="";
    return;
  }
  // Auto-seleciona o perfil mais adequado
  const jcat=(j.category||"other").toLowerCase();
  // v19 (dono, 15/07): O TIPO DE VISTO DA VAGA MANDA — vaga H-2A vai com o
  // perfil H-2A, vaga H-2B com o perfil H-2B. Só depois: categoria → favorito → normal → 1º
  const jvt=_jobVisaTypeFront(j);
  const _mPool=profiles.filter(p=>p.allowManual!==false);
  const _mSrc=_mPool.length?_mPool:profiles;
  const auto=(jvt?_mSrc.find(p=>(p.visaType||"h2b")===jvt):null)
           ||_mSrc.find(p=>(p.categories||[]).includes(jcat))
           ||_mSrc.find(p=>p.isFavorite)
           ||_mSrc.find(p=>p.isGeneral||!(p.categories||[]).length)
           ||_mSrc[0];
  window._modalSelProfileId=auto?.id||null;
  // Aviso quando a vaga é de um tipo e o usuário não tem perfil desse tipo
  const _missingTypeWarn=(jvt&&!profiles.some(p=>(p.visaType||"h2b")===jvt))
    ?`<div style="font-size:11px;color:var(--amber);background:var(--amberl);border:1px solid var(--amberb);border-radius:8px;padding:7px 10px;margin-bottom:6px">⚠️ Esta vaga é <strong>${jvt==="h2a"?"H-2A":"H-2B"}</strong> e você ainda não tem um perfil ${jvt==="h2a"?"H-2A":"H-2B"}. Vai usar o perfil existente — ou <span style="color:var(--blue);cursor:pointer;font-weight:700" onclick="closeModal();sv('profile');setTimeout(()=>{switchProfileTab('profiles');setTimeout(()=>openProfileEditor(null,'${jvt}'),200)},100)">crie o perfil ${jvt==="h2a"?"H-2A":"H-2B"} agora →</span></div>`:"";
  el.innerHTML=_missingTypeWarn+profiles.map(p=>{
    const sel=p.id===(auto&&auto.id);
    const badge=p.icon||"📄";
    const vtTag=(p.visaType||"h2b")==="h2a"?'<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:5px;background:rgba(16,185,129,.15);color:#059669;margin-left:4px">H-2A</span>':'<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:5px;background:rgba(37,99,235,.12);color:#2563eb;margin-left:4px">H-2B</span>';
    const cats=(p.categories||[]).slice(0,2).join(", ")||"Todas as vagas";
    const nSubj=(p.subjects||[p.subject]).filter(Boolean).length;
    return`<label class="cv-slot${sel?" sel":""}" style="margin-bottom:5px;cursor:pointer;padding:10px 12px" onclick="applyModalProfileById('${p.id}',true)">
      <input type="radio" name="m-prf" value="${p.id}" ${sel?"checked":""} style="accent-color:var(--blue)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${badge} ${esc(p.name)}${vtTag}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:1px">${p.pdfName?"📄 "+esc(p.pdfName)+" · ":""}${esc(cats)} · ${nSubj} assunto(s)</div>
      </div>
    </label>`;
  }).join("");
  if(auto)applyModalProfileById(auto.id,false);
}


// Escolhe uma variante aleatória do array (2026-07: envio manual agora varia
// assunto/corpo igual ao automático já fazia — antes sempre pegava a versão
// [0], então reenviar manualmente para várias empresas saía com o texto
// sempre idêntico, mesmo quando o perfil tinha várias versões cadastradas).
function _pickVariant(arr){if(!arr||!arr.length)return null;return arr[Math.floor(Math.random()*arr.length)];}

function applyModalProfileById(pid,updateSlots){
  // 🔧 FIX (cliente 03/07): usa a MESMA fonte que renderModalProfiles (UPROFILES primeiro).
  // Antes usava U.profiles primeiro — se as duas listas divergissem, o perfil renderizado
  // não era encontrado aqui e o currículo/assunto não carregavam ("não existe no seu perfil").
  const profiles=(UPROFILES.length?UPROFILES:U.profiles||[]);
  const p=profiles.find(x=>x.id===pid);if(!p||!curJob)return;
  window._modalSelProfileId=pid;
  if(updateSlots){
    document.querySelectorAll("#m-profile-slots .cv-slot").forEach(s=>s.classList.remove("sel"));
    const lbl=document.querySelector(`#m-profile-slots input[value="${pid}"]`);
    if(lbl)lbl.closest(".cv-slot").classList.add("sel");
  }
  const subjs=(p.subjects&&p.subjects.length)?p.subjects:[p.subject].filter(Boolean);
  const bodies=(p.emailBodies&&p.emailBodies.length)?p.emailBodies:[p.body].filter(Boolean);
  const s=_pickVariant(subjs)||CFG.subject||"";
  const b=_pickVariant(bodies)||CFG.body||"";
  const subjEl=g("#m-subj");if(subjEl)subjEl.value=fill(s,curJob);
  const bodyEl=g("#m-body");if(bodyEl)bodyEl.value=fill(b,curJob);
  // 🔧 FIX (cliente 03/07): usar != null (idx 0 é válido) e, se o perfil tem currículo,
  // garantir que ele esteja em DOCS para o modal conseguir anexar.
  // v167 (bug real, auditoria 08/09/2026): faltava o "else{activeResIdx=null;}"
  // que a cover já tinha (comentário v20 abaixo, corrigido por uma reclamação
  // real idêntica com carta). Perfil escolhido de propósito como "sem
  // currículo, só carta" (resumeIdx:null — configuração válida) deixava
  // activeResIdx GRUDADO no currículo do ÚLTIMO perfil usado na sessão (às
  // vezes do OUTRO tipo de visto) — a vaga saía com o currículo errado.
  if(p.resumeIdx!=null){
    activeResIdx=p.resumeIdx;
    // Se o CV do perfil não está na lista DOCS (cache dessincronizado), injeta a partir do perfil
    if(!DOCS.some(c=>c.idx===p.resumeIdx)&&p.pdfName){DOCS.push({idx:p.resumeIdx,name:p.pdfName,size:p.pdfSize||0,cvType:"resume"});}
  } else {
    activeResIdx=null;
  }
  // v20 (reclamação real, 07/2026): a cover do perfil manda SEMPRE — inclusive
  // quando é "Nenhuma" (coverIdx null). Antes o null deixava o activeCovIdx
  // "grudado" no valor anterior (ex.: cover do perfil H-2A), e a carta errada
  // saía em toda candidatura manual.
  if(p.coverIdx!=null){
    activeCovIdx=p.coverIdx;
    if(!DOCS.some(c=>c.idx===p.coverIdx)&&p.coverName){DOCS.push({idx:p.coverIdx,name:p.coverName,size:p.coverSize||0,cvType:"cover"});}
  } else {
    activeCovIdx=null;
  }
  if(updateSlots)buildCvSlots();
}

function buildCvSlots(){
  manualCdSync(); // v120: o pill do cooldown acompanha toda abertura do modal de envio
  // Deduplica por idx
  const seen=new Set();
  const dedup=arr=>arr.filter(c=>{if(seen.has(c.idx))return false;seen.add(c.idx);return true;});
  seen.clear();
  const res=dedup(DOCS.filter(c=>(c.cvType||"resume")==="resume"));
  seen.clear();
  const cov=dedup(DOCS.filter(c=>c.cvType==="cover"));
  const mkSlots=(arr,type,curIdx)=>{
    if(!arr.length)return`<div style="font-size:12px;color:var(--t3);padding:6px 0">Nenhum ${type==="resume"?"currículo":"cover letter"}. <span style="color:var(--blue);cursor:pointer;font-weight:600" onclick="closeModal();sv('profile')">Adicionar →</span></div>`;
    return[`<label class="cv-slot${curIdx===null?" sel":""}"><input type="radio" name="${type}" value="none" ${curIdx===null?"checked":""} style="accent-color:var(--blue)"> Não enviar</label>`,...arr.map(c=>`<label class="cv-slot${curIdx===c.idx?" sel":""}"><input type="radio" name="${type}" value="${c.idx}" ${curIdx===c.idx?"checked":""} style="accent-color:var(--blue)"><i class="ti ti-${type==="resume"?"file-type-pdf":"file-description"}" style="color:${type==="resume"?"var(--red)":"var(--purple)"}"></i><span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></label>`)].join("");
  };
  const rs=g("#m-res-slots");if(rs){rs.innerHTML=mkSlots(res,"resume",activeResIdx);rs.querySelectorAll("input[name='resume']").forEach(r=>r.addEventListener("change",()=>{rs.querySelectorAll(".cv-slot").forEach(s=>s.classList.remove("sel"));r.closest(".cv-slot")?.classList.add("sel");activeResIdx=r.value==="none"?null:parseInt(r.value,10);}));}
  const cs=g("#m-cov-slots");if(cs){cs.innerHTML=mkSlots(cov,"cover",activeCovIdx);cs.querySelectorAll("input[name='cover']").forEach(r=>r.addEventListener("change",()=>{cs.querySelectorAll(".cv-slot").forEach(s=>s.classList.remove("sel"));r.closest(".cv-slot")?.classList.add("sel");activeCovIdx=r.value==="none"?null:parseInt(r.value,10);}));}
}

function closeModal(){g("#modal").classList.add("gone");curJob=null;_currentModalJob=null;const ms=g("#m-sending");const mb=g("#m-send");if(ms)ms.style.display="none";if(mb)mb.disabled=false;} // FIX: reseta estado do botão ao fechar

/* ═══ ⏱️ v120 (ORDEM DO DONO, 05/08): cooldown do MANUAL é editável ═══
   O 1 min entre envios manuais continua sendo o PADRÃO, mas o usuário vê
   um botão no modal de envio e pode desligar — aceitando por escrito que
   o Gmail dele tem MUITA chance de ser bloqueado pra sempre se enviar
   rápido demais. Religar é 1 clique. O AUTOMÁTICO não tem escolha:
   7 minutos sempre (proteção do sistema, não é preferência). */
function manualCdSync(){
  const el=g("#m-cd-pill");if(!el)return;
  const off=U&&U.manualCdOff===true;
  el.innerHTML=off
    ?`⚠️ ${esc(t('cd_off_lbl'))} · <u>${esc(t('cd_reactivate'))}</u>`
    :`⏱️ ${esc(t('cd_on_lbl'))} · <u>${esc(t('cd_change'))}</u>`;
  el.style.color=off?"var(--amber)":"var(--t3)";
}
async function _manualCdSave(off){
  try{
    const r=await fetch("/api/settings",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({manualCdOff:off})});
    const d=await r.json();if(!d.ok&&!r.ok)throw new Error(d.error||"erro");
    U.manualCdOff=off;if(off)window._manualCdUntil=0;
    manualCdSync();
    toast(off?t('cd_toast_off'):t('cd_toast_on'),off?"r":"g");
  }catch(e){toast("❌ "+(e.message||"Erro ao salvar"),"r");}
}
function manualCdModal(){
  if(U&&U.manualCdOff===true){_manualCdSave(false);return;}
  const ov=document.createElement("div");
  ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)";
  ov.innerHTML=`<div style="background:var(--sf);border-radius:18px;padding:22px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25)">
    <div style="font-size:17px;font-weight:800;margin-bottom:8px">⚠️ ${esc(t('cd_modal_title'))}</div>
    <div style="font-size:13.5px;color:var(--t2);line-height:1.5;margin-bottom:12px">${esc(t('cd_modal_body'))}</div>
    <label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:14px">
      <input type="checkbox" id="cd-agree" style="margin-top:2px;width:17px;height:17px;flex:none" onchange="g('#cd-off-btn').disabled=!this.checked">
      <span>${esc(t('cd_modal_agree'))}</span>
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">${esc(t('cd_modal_keep'))}</button>
      <button class="btn" id="cd-off-btn" disabled style="background:var(--red);color:#fff" onclick="this.closest('div[style*=fixed]').remove();_manualCdSave(true)">${esc(t('cd_modal_off'))}</button>
    </div>
  </div>`;
  ov.addEventListener("click",e=>{if(e.target===ov)ov.remove();});
  document.body.appendChild(ov);
}
async function doSend(){
  const j=curJob;
  const to=(g("#m-to")?.value||"").trim()||(j&&j.email)||"";
  // v27: aviso ANTES do clique chegar no servidor (que continua sendo a trava real)
  const _est=empregadorStatus(to);
  if(_est==="sent"){g("#m-warn").innerHTML='<div class="alert al-red" style="margin-top:8px"><i class="ti ti-alert-circle"></i><span>✅ Você JÁ enviou para esta empresa — o sistema bloqueia duplicados automaticamente.</span></div>';_sweepContactedCard(j?.caseNum||j?.id||"",to);return;}
  if(_est==="queued"){g("#m-warn").innerHTML='<div class="alert al-red" style="margin-top:8px"><i class="ti ti-robot"></i><span>🤖 Esta empresa está na fila do seu envio automático — o robô vai enviar sozinho.</span></div>';_sweepContactedCard(j?.caseNum||j?.id||"",to);return;}
  const subj=(g("#m-subj")?.value||"").trim();
  const msg=(g("#m-body")?.value||"").trim();
  const warn=s=>{g("#m-warn").innerHTML=`<div class="alert al-red" style="margin-top:8px"><i class="ti ti-alert-circle"></i><span>${esc(s)}</span></div>`;};
  if(!to)return warn("E-mail da vaga não encontrado. Feche e tente novamente.");
  if(!subj)return warn("Selecione um perfil para preencher o assunto.");
  if(!msg)return warn("Selecione um perfil para preencher a mensagem.");
  // e-mail de envio escolhido (se houver seletor); lembra a escolha
  const senderSel=g("#m-sender");
  const chosenSender=senderSel&&senderSel.value&&senderSel.value!==U.email?senderSel.value:undefined;
  if(senderSel&&senderSel.value){try{localStorage.setItem("h2b_manual_sender",senderSel.value);}catch(e){}}
  g("#m-sending").style.display="flex";g("#m-send").disabled=true;g("#m-warn").innerHTML="";
  try{
    const pl={to,subject:subj,message:msg,fromName:CFG.name||U.name||"H2BApply",
      jobId:j?.id,jobTitle:j?.title||subj,company:j?.company||"",
      // v13: campos para jobSnapshot completo no servidor
      city:j?.city||"",state:j?.state||"",wage:j?.wage||"",visa:j?.visa||j?.visaType||"",
      start:j?.start||"",end:j?.end||"",workers:j?.workers||null,
      desc:(j?.desc||"").slice(0,500),category:j?.category||"",caseNum:j?.caseNum||j?.id||"",
      sheetSource:(tab!=="seasonal"?tab:undefined),
      senderEmail:chosenSender,
      resumeIdx:(activeResIdx!=null?activeResIdx:undefined),coverIdx:(activeCovIdx!=null?activeCovIdx:undefined)};
    // v118: 1 envio manual por minuto — bloqueio local instantâneo (o servidor
    // é quem manda de verdade; isto só evita a viagem à toa e dá contagem viva)
    if(!U.isAdmin&&U.manualCdOff!==true&&window._manualCdUntil&&Date.now()<window._manualCdUntil){
      const _lf=Math.ceil((window._manualCdUntil-Date.now())/1000);
      g("#m-sending").style.display="none";g("#m-send").disabled=false;
      toast(`⏳ Espere ${_lf}s pro próximo envio manual (1 por minuto).`,"r");
      return;
    }
    const r=await fetch("/api/send",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(pl)});const d=await r.json();
    // FIX: mostra TODOS os erros de forma visível — esconde spinner e reabilita botão ANTES de mostrar
    if(!d.ok){
      g("#m-sending").style.display="none";g("#m-send").disabled=false;
      const errMsg=d.error||"Erro ao enviar. Tente novamente.";
      warn(errMsg);
      // Rola para o topo do modal body para mostrar o aviso
      const modalBd=g("#modal")?.querySelector(".mbody");if(modalBd)modalBd.scrollTop=0;
      // Toast adicional para garantir visibilidade no celular
      if(typeof d.cooldownLeft==="number")window._manualCdUntil=Date.now()+d.cooldownLeft*1000; // v118
      if(d.alreadySent)toast("⚠️ Você já enviou para esta empresa.","r");
      else if(d.inAutoQueue)toast("🤖 Esta empresa está na fila automática.","r");
      else if(d.duplicate)toast("⚠️ Envio em andamento. Aguarde.","r");
      else if(d.limitReached){toast("📊 Limite diário atingido.","r");if(!U.isAdmin)limitUpsell();} // ⭐ v134: funil
      else toast("❌ "+errMsg.slice(0,80),"r");
      return;
    }
    U.todaySentManual=d.todaySent||U.todaySentManual+1;U.manualRemaining=typeof d.remaining==="number"?d.remaining:Math.max(0,(U.manualLimit||20)-U.todaySentManual);U.manualLimit=d.dailyLimit||U.manualLimit;
    rlRecordSend(); // registra o horário do envio p/ detecção de envio muito rápido
    if(!U.isAdmin&&U.manualCdOff!==true)window._manualCdUntil=Date.now()+60000; // v118: 1/min (v120: respeita a escolha do usuário)
    closeModal();
    if(j?.id){
      APPLIED.add(j.id);
        if(tab==="seasonal")_sentSeasonal.add(j.id);
        else if(j.caseNum||j.id)_sentAll.add(j.caseNum||j.id); // qualquer planilha
      // Seasonal card: fade out e some
      const sc=g("#jcard-"+j.id);
      if(sc){sc.style.transition="opacity .3s ease";sc.style.opacity="0";setTimeout(()=>{sc.style.display="none";sc.style.opacity="";sc.style.transition="";},320);}
      // Sheet card: fade out e some
      const iid="s_"+(j.id||"").replace(/[^a-zA-Z0-9]/g,"_");
      const shc=g("#jcard-"+iid);
      if(shc){shc.style.transition="opacity .3s ease";shc.style.opacity="0";setTimeout(()=>{shc.style.display="none";shc.style.opacity="";shc.style.transition="";updSheetCounter();},320);}
      else{updSheetCounter();}
      // v27 (reclamação real): o dedup de verdade é por EMPREGADOR (e-mail) —
      // some TAMBÉM com as vagas irmãs do mesmo empregador que já estão na
      // tela (o servidor já corta nas próximas páginas via hideSent=1).
      try{
        const _sentTo=(to||"").toLowerCase().trim();
        if(_sentTo)_empSent.add(_sentTo); // v27: bloqueio imediato no front inteiro
        if(_sentTo&&Array.isArray(sJobs)){
          for(const sj of sJobs){
            if(sj&&sj.id!==j.id&&(sj.email||"").toLowerCase().trim()===_sentTo){
              _sentAll.add(sj.caseNum||sj.id);
              const sid2="s_"+(sj.id||"").replace(/[^a-zA-Z0-9]/g,"_");
              const el2=g("#jcard-"+sid2)||g("#jcard-"+sj.id);
              if(el2){el2.style.transition="opacity .3s ease";el2.style.opacity="0";setTimeout(()=>{el2.style.display="none";},320);}
            }
          }
        }
      }catch(e){}
      closeMobDetail();
    }
    g("#suc-sub").textContent=`Enviado para ${to}`;g("#suc-rem").textContent=`Restam ${U.manualRemaining} envios manuais hoje`;g("#success-overlay").style.display="flex";
    HIST.unshift({appId:d.appId,jobId:j?.id,job:j?.title||subj,company:j?.company||"",to,date:new Date().toLocaleString("pt-BR"),type:"manual",sheetSource:(tab!=="seasonal"?tab:undefined),caseNum:j?.caseNum||j?.id||"",threadId:d.threadId,msgId:d.messageId,jobSnapshot:{title:j?.title,company:j?.company,city:j?.city,state:j?.state,wage:j?.wage,visa:j?.visa||j?.visaType,start:j?.start,end:j?.end,desc:j?.desc,sourceEmail:to}});
    updHistBadge();updateLimChip();
    window._sheetAvail={}; // enviou mais uma — disponibilidade do wizard mudou
    if(curView==="home")renderHome(); // FIX: atualiza stats da home após envio
  }catch(e){g("#m-sending").style.display="none";g("#m-send").disabled=false;warn(e.message);}
}

function closeSuccessOverlay(goHist){
  g("#success-overlay").style.display="none";closeModal();closeMobDetail();
  if(goHist)sv("hist");
  rlMaybeWarn(); // checa ritmo de envio DEPOIS de fechar a tela de sucesso
}

// ═══════════════════════════════════════════
//  ENVIO RÁPIDO DEMAIS — aviso anti-spam/bloqueio Gmail (V-ratelimit)
//  Regra: 50 envios manuais em menos de 10 minutos dispara o aviso.
// ═══════════════════════════════════════════
const RL_MAX_SENDS=50, RL_WINDOW_MS=10*60*1000, RL_SNOOZE_MS=10*60*1000;
function _rlKey(){return "h2b_rl_times_"+(U?.email||"anon");}
function _rlSnoozeKey(){return "h2b_rl_snooze_"+(U?.email||"anon");}
function rlGetTimes(){
  try{const raw=localStorage.getItem(_rlKey());const arr=raw?JSON.parse(raw):[];
    const cutoff=Date.now()-RL_WINDOW_MS;
    return arr.filter(t=>t>cutoff);
  }catch(e){return [];}
}
function rlRecordSend(){
  const times=rlGetTimes();times.push(Date.now());
  try{localStorage.setItem(_rlKey(),JSON.stringify(times));}catch(e){}
}
function rlMaybeWarn(){
  const times=rlGetTimes();
  if(times.length<RL_MAX_SENDS)return;
  let snoozeUntil=0;
  try{snoozeUntil=parseInt(localStorage.getItem(_rlSnoozeKey())||"0",10);}catch(e){}
  if(Date.now()<snoozeUntil)return; // já avisado recentemente, não repete a cada envio
  g("#rl-warn-count").textContent=times.length;
  g("#rl-warn-ov").classList.add("show");
}
function rlContinueAnyway(){
  // Usuário assume o risco — não avisa de novo por 10 min, deixa enviar normal
  try{localStorage.setItem(_rlSnoozeKey(),String(Date.now()+RL_SNOOZE_MS));}catch(e){}
  g("#rl-warn-ov").classList.remove("show");
}
function rlChooseWait(){
  g("#rl-warn-ov").classList.remove("show");
  try{localStorage.setItem(_rlSnoozeKey(),String(Date.now()+RL_SNOOZE_MS));}catch(e){}
}

// ═══════════════════════════════════════════
//  AVALIAÇÕES REAIS (substituem depoimentos fixos na landing)
// ═══════════════════════════════════════════
let _reviewStarVal=0;
function reviewSetStar(v){
  _reviewStarVal=v;
  document.querySelectorAll(".review-star").forEach(el=>{
    el.textContent=(parseInt(el.dataset.v,10)<=v)?"★":"☆";
    el.style.color=(parseInt(el.dataset.v,10)<=v)?"#f59e0b":"";
  });
}
async function openReviewModal(){
  g("#review-ov").classList.add("show");
  g("#review-form-wrap").style.display="";
  g("#review-status-wrap").style.display="none";
  g("#review-err").style.display="none";
  try{
    const r=await fetch("/api/reviews/mine",{credentials:"include"});
    const d=await r.json();
    if(d.ok && d.reviews && d.reviews.length){
      const last=d.reviews[0];
      if(last.status==="pending"||last.status==="approved"){
        g("#review-form-wrap").style.display="none";
        g("#review-status-wrap").style.display="";
        if(last.status==="pending"){
          g("#review-status-icon").textContent="⏳";
          g("#review-status-title").textContent="Avaliação em análise";
          g("#review-status-txt").textContent="Recebemos sua avaliação e ela está sendo revisada por um admin antes de aparecer na página inicial. Obrigado por compartilhar sua experiência!";
        }else{
          g("#review-status-icon").textContent="✅";
          g("#review-status-title").textContent="Avaliação publicada!";
          g("#review-status-txt").textContent="Sua avaliação já está aprovada e pode aparecer na página inicial do H2BApply. Obrigado!";
        }
        return;
      }
    }
  }catch(e){/* se falhar, apenas mostra o formulário normalmente */}
  _reviewStarVal=0;
  reviewSetStar(0);
  g("#review-text").value="";
  g("#review-name").value="";
  g("#review-location").value="";
}
async function submitReview(){
  const text=g("#review-text").value.trim();
  const displayName=g("#review-name").value.trim();
  const location=g("#review-location").value.trim();
  const errEl=g("#review-err");
  errEl.style.display="none";
  if(text.length<15){errEl.textContent="Conte um pouco mais — mínimo 15 caracteres.";errEl.style.display="";return;}
  if(!_reviewStarVal){errEl.textContent="Escolha uma nota de 1 a 5 estrelas.";errEl.style.display="";return;}
  const btn=g("#review-submit-btn");btn.disabled=true;const oldHtml=btn.innerHTML;btn.innerHTML='<span class="spin spin-sm"></span>';
  try{
    const r=await fetch("/api/reviews",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,rating:_reviewStarVal,displayName,location})});
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||"Erro ao enviar avaliação.");
    gaEvent("review_submitted",{rating:_reviewStarVal});
    toast("Avaliação enviada — obrigado! ⭐","g");
    g("#review-form-wrap").style.display="none";
    g("#review-status-wrap").style.display="";
    g("#review-status-icon").textContent="⏳";
    g("#review-status-title").textContent="Avaliação enviada!";
    g("#review-status-txt").textContent="Um admin vai revisar antes de publicar na página inicial. Obrigado por compartilhar sua experiência!";
  }catch(e){errEl.textContent=e.message;errEl.style.display="";}
  btn.disabled=false;btn.innerHTML=oldHtml;
}

// ── Convite automático p/ avaliar, 1x, após marco de X candidaturas enviadas ──
const REVIEW_PROMPT_THRESHOLD=10;
let _reviewPromptChecked=false;
function _reviewInviteDismissKey(){return "h2b_review_invite_dismissed_"+(U?.email||"anon");}
async function maybePromptReview(totalSent){
  if(_reviewPromptChecked)return; // já checou nesta sessão (renderHome roda várias vezes)
  if(!U||!U.email)return;
  if((totalSent||0)<REVIEW_PROMPT_THRESHOLD)return;
  let dismissed=false;
  try{dismissed=localStorage.getItem(_reviewInviteDismissKey())==="1";}catch(e){}
  if(dismissed)return;
  _reviewPromptChecked=true;
  try{
    const r=await fetch("/api/reviews/mine",{credentials:"include"});
    const d=await r.json();
    if(d.ok&&d.reviews&&d.reviews.length)return; // já avaliou (ou está com uma pendente/rejeitada) — não insiste
    g("#review-invite-title").textContent=`Você já enviou ${(totalSent||0).toLocaleString("pt-BR")} candidaturas!`;
    g("#review-invite-ov").classList.add("show");
  }catch(e){/* falha silenciosa — não interrompe o uso do app */}
}
function reviewInviteAccept(){
  g("#review-invite-ov").classList.remove("show");
  try{localStorage.setItem(_reviewInviteDismissKey(),"1");}catch(e){}
  openReviewModal();
}
function reviewInviteDismiss(){
  g("#review-invite-ov").classList.remove("show");
  try{localStorage.setItem(_reviewInviteDismissKey(),"1");}catch(e){}
}

// v22 (ordem do dono): aiCover() removida junto com o /api/generate-cover.

// fill() definida abaixo com suporte a {email}

// ═══════════════════════════════════════════
//  PROFILE / TEMPLATE
// ═══════════════════════════════════════════
function loadProfile(){
  g("#cfg-name").value=CFG.name||U.name||"";g("#cfg-country").value=CFG.country||"Brazil";g("#cfg-phone").value=CFG.phone||"";g("#cfg-city").value=CFG.city||"";
  // v168: removida a escrita em #pstat-total-stats — a aba "Números"
  // (gamificação) foi excluída por completo do Perfil.
  // Novos campos
  const wEl=g("#cfg-whatsapp");if(wEl)wEl.value=U.whatsapp||"";
  // ── Gmail Extra: mostrar seção conforme plano ──
  _renderProfileSenderSection();
  g("#p-name")&&(g("#p-name").textContent=U.name);g("#p-email")&&(g("#p-email").textContent=U.email);
  // Novos IDs do hero do perfil redesenhado
  const _pnl=g("#prof-name-lbl");if(_pnl)_pnl.textContent=U.name||"–";
  const _pel=g("#prof-email-lbl");if(_pel)_pel.textContent=U.email||"–";
  // Stats rápidos — v92: Manual/Auto/Total. Antes: o card Auto lia
  // U.totalAutoSent (campo que NÃO EXISTE — o certo é totalAutoHist) e
  // ficava sempre em 0; e o 3º card era "Respostas" (U.totalReplies),
  // impossível de contar num app só-envio.
  const _pss=g("#prof-stat-sent");if(_pss)_pss.textContent=(U.totalManual||0).toLocaleString("pt-BR");
  const _psa=g("#prof-stat-auto");if(_psa)_psa.textContent=(U.totalAutoHist||0).toLocaleString("pt-BR");
  const _psr=g("#prof-stat-replies");if(_psr)_psr.textContent=(U.totalSent||0).toLocaleString("pt-BR");
  // Badges do plano
  const _pb=g("#prof-plan-badges");
  if(_pb){const pl=U.plan||"free";const planColors={free:"rgba(255,255,255,.15)",vip:"rgba(167,139,250,.4)",vipro:"rgba(99,102,241,.4)",doublepro:"rgba(250,204,21,.35)",pro:"rgba(6,182,212,.4)"};const planLabels={free:"Free",vip:"⭐ VIP",vipro:"⭐🤖 VIPro",doublepro:"🚀 DoublePro",pro:"🤖 Pro"};_pb.innerHTML=`<span style="background:${planColors[pl]||"rgba(255,255,255,.15)"};border:1px solid rgba(255,255,255,.25);border-radius:99px;padding:2px 10px;font-size:10px;font-weight:700;color:#fff">${planLabels[pl]||pl}</span>`+(U.vip?.manualExpires&&U.vip.manualExpires>Date.now()?`<span style="background:rgba(52,211,153,.25);border:1px solid rgba(52,211,153,.4);border-radius:99px;padding:2px 10px;font-size:10px;font-weight:700;color:#6ee7b7">${Math.ceil((U.vip.manualExpires-Date.now())/86400000)}d restantes</span>`:"");}
  _initAdminTab(); // Mostrar/ocultar aba admin conforme perfil do usuário
  const pav=g("#pav");if(pav){if(U.picture){pav.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;object-fit:cover">`;pav.style.cssText="width:60px;height:60px;border-radius:50%;overflow:hidden;border:3px solid rgba(255,255,255,.3);flex-shrink:0";}else{pav.textContent=(U.name||"?")[0].toUpperCase();}}
  const ppb=g("#p-plan-badge");if(ppb)ppb.innerHTML=planBadgeHTML();
}
function _renderProfileSenderSection(){
  const secVip=document.getElementById("profile-sender-section");
  const secFree=document.getElementById("profile-sender-free");
  const addBtn=document.getElementById("profile-add-sender-btn");
  const limitMsg=document.getElementById("profile-sender-limit-msg");
  const listEl=document.getElementById("profile-sender-list");
  if(!secVip||!secFree) return;

  const isPaid=U.plan&&U.plan!=="free";
  const senderMax=U.senderMax||1; // total permitido (principal + extras)
  const senders=U.senderEmails||[];
  const totalSenders=1+senders.length; // 1 = email principal

  if(!isPaid){
    secVip.style.display="none";
    secFree.style.display="block";
    return;
  }
  secVip.style.display="block";
  secFree.style.display="none";

  // Renderizar lista de emails extras conectados
  if(listEl){
    if(senders.length===0){
      listEl.innerHTML='<div style="font-size:12px;color:var(--t3);padding:4px 0">Nenhum Gmail extra conectado ainda.</div>';
    } else {
      listEl.innerHTML=senders.map(s=>{
        // 🛡️ v73: status real da conta — bloqueada (suspensão do Google
        // detectada) tem prioridade sobre token expirado/aquecimento.
        const _statusLine=s.blocked
          ?`⛔ Bloqueada — ${s.blockedReason==="suspended"?"o Google suspendeu esta conta":"envio desativado nesta conta"}. Reconecte pra tentar de novo.`
          :(s.tokenExpired||s.active===false)?"⚠️ Precisa reconectar"
          :"✅ Conectado";
        const _statusColor=s.blocked?"var(--red)":(s.tokenExpired||s.active===false)?"var(--red)":"var(--green)";
        // Selo de aquecimento (proteção anti-bloqueio p/ conta recém-conectada)
        const _warmupBadge=(!s.blocked&&!s.tokenExpired&&s.active!==false&&s.warmupCap!=null)
          ?`<div style="font-size:9.5px;color:#d97706;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:2px 6px;margin-top:3px;display:inline-block">🌱 Aquecendo — ${s.sentToday||0}/${s.warmupCap} hoje (proteção anti-bloqueio)</div>`
          :"";
        return`
        <div style="display:flex;align-items:center;gap:8px;background:var(--sf2);border:1px solid var(--border);border-radius:8px;padding:9px 12px">
          <i class="ti ti-mail" style="color:var(--blue);font-size:14px"></i>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;color:var(--t1);word-break:break-all">${esc(s.email)}</div>
            <div style="font-size:10px;color:${_statusColor}">${_statusLine}</div>
            ${_warmupBadge}
          </div>
          ${(s.tokenExpired||s.active===false||s.blocked)?`<button onclick="location.href='/oauth/add-sender?reauth=1'" style="background:var(--blue);border:none;cursor:pointer;color:#fff;padding:5px 10px;border-radius:7px;font-size:11px;font-weight:800" title="Reconectar este Gmail"><i class="ti ti-refresh"></i> Reconectar</button>`:""}
          <button onclick="_removeSenderEmail('${esc(s.email)}')" style="background:none;border:none;cursor:pointer;color:var(--red);padding:4px" title="Remover">
            <i class="ti ti-trash" style="font-size:14px"></i>
          </button>
        </div>`;}).join("");
    }
  }

  // Botão adicionar
  if(addBtn){
    const canAdd=totalSenders<senderMax;
    addBtn.style.display=canAdd?"":"none";
  }
  if(limitMsg){
    const atLimit=totalSenders>=senderMax&&senders.length>0;
    limitMsg.style.display=atLimit?"block":"none";
  }
}

async function _removeSenderEmail(email){
  if(!confirm("Remover o Gmail extra "+email+"?")) return;
  try{
    const r=await fetch("/api/sender/"+encodeURIComponent(email),{method:"DELETE",credentials:"include"});
    const d=await r.json();
    if(d.ok){
      U.senderEmails=(U.senderEmails||[]).filter(s=>s.email!==email);
      _renderProfileSenderSection();
      toast("Gmail extra removido","g");
    } else toast(d.error||"Erro ao remover","r");
  }catch(e){toast("Erro: "+e.message,"r");}
}

async function saveProfile(){
  CFG.name=g("#cfg-name").value.trim();CFG.country=g("#cfg-country").value.trim();CFG.phone=g("#cfg-phone").value.trim();CFG.city=g("#cfg-city").value.trim();
  const newWhatsapp=(g("#cfg-whatsapp")?.value||"").trim();
  // Feedback visual no botão durante salvamento
  const saveBtn=document.querySelector("[onclick='saveProfile()']")||document.querySelector('[onclick="saveProfile()"]');
  const origHtml=saveBtn?saveBtn.innerHTML:"";
  if(saveBtn){saveBtn.disabled=true;saveBtn.innerHTML='<i class="ti ti-loader" style="animation:spin 1s linear infinite"></i> Salvando...';}
  try{
    const body={name:CFG.name,country:CFG.country,phone:CFG.phone,city:CFG.city,language:CFG.language};
    if(newWhatsapp)body.whatsapp=newWhatsapp;
    const r=await fetch("/api/settings",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.ok){
      // Feedback sucesso no botão
      if(saveBtn){saveBtn.innerHTML='<i class="ti ti-check"></i> Dados salvos!';}
      setTimeout(()=>{if(saveBtn){saveBtn.disabled=false;saveBtn.innerHTML=origHtml||'<i class="ti ti-check"></i> Salvar dados';}},2200);
      toast("✅ Dados salvos com sucesso!","g");
      U.name=CFG.name||U.name;U.whatsapp=newWhatsapp||U.whatsapp;
      renderHdr();renderSidebar();
    } else {
      if(saveBtn){saveBtn.disabled=false;saveBtn.innerHTML=origHtml;}
      throw new Error(d.error);
    }
  }catch(e){
    if(saveBtn){saveBtn.disabled=false;saveBtn.innerHTML=origHtml;}
    toast("❌ Erro ao salvar: "+e.message,"r");
  }
}

// ═══════════════════════════════════════════
//  SISTEMA DE TEMPLATES & PERFIS
// ═══════════════════════════════════════════
// v22 (ORDEM DO DONO, 21/07/2026): NENHUM texto padrão. Os ~20 templates
// prontos, o assunto/corpo "de fábrica" e as sugestões de assunto foram
// removidos — candidatura é escrita pelo próprio usuário, sempre. As
// constantes ficam vazias pra não quebrar quem as referencia.
const DEFAULT_SUBJECT="";
const DEFAULT_BODY="";
const SUBJ_SUGGESTIONS=[];
const BUILTIN_TEMPLATES=[];

let UTPL=[],UPROFILES=[],tplCurId=null,tplCurBuiltin=false,
    tplCatFilter="all",pickerCatFilter="all",
    tplPickerTarget="manual",editingProfileId=null;

// v167 (bug real, auditoria 08/09/2026): {categoria} era oferecida como botão
// clicável no editor de perfil (index.html, "① Assuntos"/"④ Corpos") mas
// NENHUM dos dois motores de envio (este fill() no manual, fillTpl() no
// servidor pro automático) sabia essa chave — quem usava mandava o texto
// LITERAL "{categoria}" pro empregador de verdade. getOccupationCategoryByKey
// é a MESMA fonte que o chip de filtro/card de vaga já usa (window._catLabels,
// via /api/category-groups) — nunca um rótulo divergente.
const fill=(tpl,j)=>(tpl||"")
  .replace(/{vaga}/g,    j?.title||j?.job||"")
  .replace(/{empresa}/g, j?.company||"")
  .replace(/{categoria}/g,getOccupationCategoryByKey(j?.category,j?.title||j?.job)?.name||"")
  .replace(/{nome}/g,    CFG.name||U?.name||"")
  .replace(/{pais}/g,    CFG.country||"Brazil")
  .replace(/{telefone}/g,CFG.phone||"")
  .replace(/{email}/g,   U?.email||"")
  .replace(/{cidade}/g,  j?.city||j?.cidade||"")
  .replace(/{estado}/g,  j?.state||j?.estado||"")
  .replace(/{city}/g,    j?.city||j?.cidade||"")
  .replace(/{state}/g,   j?.state||j?.estado||"")
  .replace(/{wage}/g,    j?.wage||"")
  .replace(/{salario}/g, j?.wage||"")
  .replace(/{inicio}/g,  j?.start||j?.beginDate||"")
  .replace(/{start}/g,   j?.start||j?.beginDate||"");

async function loadTplView(){
  try{
    const [tr,pr]=await Promise.all([
      fetch("/api/templates",{credentials:"include"}).then(r=>r.json()),
      fetch("/api/profiles",{credentials:"include"}).then(r=>r.json()),
    ]);
    UTPL=tr.templates||[];
    UPROFILES=pr.profiles||[];
  }catch{}
  renderTplList();
  renderProfiles();
  _buildSubjSugg();
}
function loadTpl(){loadTplView();}

function switchTplTab(tab){
  // Legacy function - tpl view removed, perfis now in profile tab
  if(tab==="perfis")sv("profile");
  const m=g("#tpl-tab-modelos"),p=g("#tpl-tab-perfis");
  if(m)m.classList.toggle("gone",tab!=="modelos");
  if(p)p.classList.toggle("gone",tab!=="perfis");
  g("#tab-modelos").classList.toggle("on",tab==="modelos");
  g("#tab-perfis").classList.toggle("on",tab==="perfis");
}

function tplNewAction(){
  tplCurId=null;tplCurBuiltin=false;
  g("#tpl-editor-title").textContent="Novo Modelo";
  g("#tpl-name").value="";g("#tpl-subj").value=DEFAULT_SUBJECT;g("#tpl-body").value=DEFAULT_BODY;
  g("#tpl-cat").value="general";
  g("#tpl-del-btn").classList.add("gone");
  g("#tpl-editor").classList.remove("gone");
  g("#tpl-editor").scrollIntoView({behavior:"smooth",block:"start"});
}

function setTplCat(cat){
  tplCatFilter=cat;
  document.querySelectorAll("[data-tcat]").forEach(b=>b.classList.toggle("on",b.dataset.tcat===cat));
  renderTplList();
}

function renderTplList(){
  const q=(g("#tpl-search")?.value||"").toLowerCase();
  const all=[...BUILTIN_TEMPLATES.map(t=>({...t,_builtin:true})),...UTPL.map(t=>({...t,_builtin:false}))];
  const filtered=all.filter(t=>{
    if(tplCatFilter!=="all"&&t.category!==tplCatFilter)return false;
    if(q&&!t.name.toLowerCase().includes(q)&&!t.body.toLowerCase().includes(q))return false;
    return true;
  });
  const list=g("#tpl-list");if(!list)return;
  if(!filtered.length){list.innerHTML='<div class="empty-state"><i class="ti ti-template"></i><p>Nenhum modelo encontrado</p></div>';return;}
  const catIcons={general:"✉️",hospitality:"🏨",construction:"🔨",landscape:"🌿",cleaning:"🧹",restaurant:"🍽️",warehouse:"📦",farm:"🌾",other:"📝"};
  list.innerHTML=filtered.map(t=>`
    <div class="tpl-card${t.id===tplCurId?" sel":""}${t._builtin?" builtin":""}" onclick="selectTpl('${t.id}',${t._builtin})">
      <div class="tpl-card-icon">${catIcons[t.category]||"✉️"}</div>
      <div style="flex:1;min-width:0">
        <div class="tpl-card-name">${esc(t.name)}</div>
        <div class="tpl-card-sub">${esc((t.body||"").slice(0,60))}…</div>
      </div>
      ${t._builtin?'<span class="tpl-tag">built-in</span>':t.id===CFG._defaultTplId?'<span class="tpl-tag default">padrão</span>':''}
    </div>`).join("");
}

function selectTpl(id,isBuiltin){
  const t=isBuiltin?BUILTIN_TEMPLATES.find(x=>x.id===id):UTPL.find(x=>x.id===id);
  if(!t)return;
  tplCurId=id;tplCurBuiltin=isBuiltin;
  g("#tpl-editor-title").textContent=isBuiltin?"Modelo Built-in (somente leitura)":"Editar Modelo";
  g("#tpl-name").value=t.name;
  g("#tpl-subj").value=t.subject||"";
  g("#tpl-body").value=t.body||"";
  g("#tpl-cat").value=t.category||"general";
  g("#tpl-del-btn").classList.toggle("gone",isBuiltin);
  g("#tpl-name").readOnly=isBuiltin;
  g("#tpl-body").readOnly=isBuiltin;
  g("#tpl-subj").readOnly=isBuiltin;
  g("#tpl-editor").classList.remove("gone");
  renderTplList();
  updateTplPreview();
  g("#tpl-editor").scrollIntoView({behavior:"smooth",block:"start"});
}

function closeTplEditor(){g("#tpl-editor").classList.add("gone");tplCurId=null;tplCurBuiltin=false;renderTplList();}

function insertTplVar(v){
  const f=g("#tpl-body");if(!f)return;
  const s=f.selectionStart,e=f.selectionEnd;
  f.value=f.value.slice(0,s)+v+f.value.slice(e);
  f.selectionStart=f.selectionEnd=s+v.length;f.focus();
  updateTplPreview();
}
function insertVar(v){insertTplVar(v);}

function toggleTplPreview(){
  const box=g("#tpl-preview-box");if(!box)return;
  const open=box.classList.toggle("gone");
  g("#tpl-prev-btn").textContent=open?"Preview ▾":"Preview ▴";
  if(!open)updateTplPreview();
}

function updateTplPreview(){
  const box=g("#tpl-preview-box");if(!box||box.classList.contains("gone"))return;
  const body=g("#tpl-body")?.value||"";
  box.textContent=fill(body,{title:"{vaga}",company:"{empresa}"});
}

function _buildSubjSugg(){
  const box=g("#tpl-subj-sugg");if(!box)return;
  box.innerHTML=SUBJ_SUGGESTIONS.map(s=>`<span class="tpl-var" style="cursor:pointer" onclick="g('#tpl-subj').value='${s.replace(/'/g,"\\'")}'">${esc(s)}</span>`).join("");
}

function toggleSubjSugg(){
  const box=g("#tpl-subj-sugg");if(!box)return;
  box.classList.toggle("gone");
  box.style.display=box.classList.contains("gone")?"none":"flex";
}

async function saveEditedTpl(){
  if(tplCurBuiltin){dupEditedTpl();return;}
  const name=g("#tpl-name")?.value?.trim();
  const body=g("#tpl-body")?.value?.trim();
  if(!name||!body){toast("Nome e mensagem obrigatórios","r");return;}
  const tpl={id:tplCurId||undefined,name,subject:g("#tpl-subj")?.value||"",body,category:g("#tpl-cat")?.value||"general"};
  try{
    const r=await fetch("/api/templates/save",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(tpl)});
    const d=await r.json();if(!d.ok)throw new Error(d.error);
    tplCurId=d.template.id;tplCurBuiltin=false;
    const idx=UTPL.findIndex(t=>t.id===d.template.id);
    if(idx>=0)UTPL[idx]=d.template;else UTPL.unshift(d.template);
    renderTplList();toast("Modelo salvo ✓","g");
  }catch(e){toast("Erro: "+e.message,"r");}
}

// v18-SEC: setTplAsDefault() removida — não tinha nenhum botão chamando-a
// (código morto/órfão), mas gravava direto em /api/settings SEM passar pela
// validação de mínimo-3 do /api/profiles/save, um caminho não vigiado pra
// definir um assunto/corpo padrão genérico pra conta inteira.

async function dupEditedTpl(){
  const name=(g("#tpl-name")?.value||"Cópia")+" (cópia)";
  const body=g("#tpl-body")?.value||"";
  const subj=g("#tpl-subj")?.value||"";
  const cat=g("#tpl-cat")?.value||"general";
  try{
    const r=await fetch("/api/templates/save",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,subject:subj,body,category:cat})});
    const d=await r.json();if(!d.ok)throw new Error(d.error);
    UTPL.unshift(d.template);tplCurId=d.template.id;tplCurBuiltin=false;
    renderTplList();toast("Duplicado ✓","g");
  }catch(e){toast("Erro: "+e.message,"r");}
}

async function delEditedTpl(){
  if(!tplCurId||tplCurBuiltin)return;
  if(!confirm("Excluir este modelo?"))return;
  try{
    await fetch("/api/templates/delete",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:tplCurId})});
    UTPL=UTPL.filter(t=>t.id!==tplCurId);
    closeTplEditor();toast("Excluído","g");
  }catch(e){toast("Erro: "+e.message,"r");}
}

function applyTplTo(target,tpl){
  const t=tpl||(tplCurBuiltin?BUILTIN_TEMPLATES.find(x=>x.id===tplCurId):UTPL.find(x=>x.id===tplCurId));
  if(!t){toast("Selecione um modelo primeiro","r");return;}
  if(target==="manual"){
    const subj=g("#m-subj"),body=g("#m-body");
    if(subj)subj.value=fill(t.subject||DEFAULT_SUBJECT,_currentModalJob);
    if(body)body.value=fill(t.body,_currentModalJob);
    closeModal();
  }else if(target==="auto"){
    const body=g("#af-body");
    if(body)body.value=fill(t.body,null);
    toast("Modelo aplicado ✓","g");
  }
}

// ── TEMPLATE PICKER ─────────────────────────────────
function openTplPickerFor(target){
  tplPickerTarget=target;
  pickerCatFilter="all";
  document.querySelectorAll("[data-pcat]").forEach(b=>b.classList.toggle("on",b.dataset.pcat==="all"));
  if(g("#picker-search"))g("#picker-search").value="";
  renderPickerList();
  g("#tpl-picker-overlay").classList.remove("gone");
}
function closeTplPicker(){g("#tpl-picker-overlay").classList.add("gone");}

function setPickerCat(cat){
  pickerCatFilter=cat;
  document.querySelectorAll("[data-pcat]").forEach(b=>b.classList.toggle("on",b.dataset.pcat===cat));
  renderPickerList();
}

function renderPickerList(){
  const q=(g("#picker-search")?.value||"").toLowerCase();
  const all=[...BUILTIN_TEMPLATES.map(t=>({...t,_builtin:true})),...UTPL.map(t=>({...t,_builtin:false}))];
  const filtered=all.filter(t=>{
    if(pickerCatFilter!=="all"&&t.category!==pickerCatFilter)return false;
    if(q&&!t.name.toLowerCase().includes(q))return false;
    return true;
  });
  const list=g("#picker-list");if(!list)return;
  if(!filtered.length){list.innerHTML='<div class="empty-state" style="padding:24px"><i class="ti ti-template"></i><p>Nenhum modelo</p></div>';return;}
  list.innerHTML=filtered.map(t=>`
    <div class="tpl-card${t._builtin?" builtin":""}" onclick="pickTemplate('${t.id}',${t._builtin})" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div class="tpl-card-name">${esc(t.name)}</div>
        <div class="tpl-card-sub">${esc((t.subject||"").slice(0,60))}</div>
      </div>
      ${t._builtin?'<span class="tpl-tag">built-in</span>':''}
    </div>`).join("");
}

function pickTemplate(id,isBuiltin){
  const t=isBuiltin?BUILTIN_TEMPLATES.find(x=>x.id===id):UTPL.find(x=>x.id===id);
  if(!t)return;
  closeTplPicker();
  if(tplPickerTarget==="manual"){
    const subj=g("#m-subj"),body=g("#m-body");
    if(subj)subj.value=fill(t.subject||DEFAULT_SUBJECT,_currentModalJob);
    if(body)body.value=fill(t.body,_currentModalJob);
  }else if(tplPickerTarget==="auto"){
    const body=g("#af-body");
    if(body)body.value=fill(t.body,null);
    toast("Modelo aplicado ✓","g");
  }else if(tplPickerTarget==="profile"){
    // Adiciona ao editor de perfil (peBodies/peSubjects)
    if(peBodies.length>=10){toast("Máximo de 10 corpos","r");return;}
    peBodies.push(t.body||"");peRenderBodies();
    if(peSubjects.length===0&&t.subject){peSubjects.push(t.subject);peRenderSubjects();}
    toast("Modelo adicionado ao perfil ✓","g");
  }
}

// v18-FIX: openProfilePickerFor()/applyProfileQuick() removidas — eram um
// seletor "escolher entre vários perfis" da era multi-perfil (pré-redesign
// de perfil único). Sem nenhum botão chamando-as (código órfão) e sem sentido
// hoje: UPROFILES nunca tem mais que 1 item.

// ── PROFILE PDF state ──────────────────────────────
let profilePdfBase64=null,profilePdfName=null,profilePdfSize=0;
let peSubjects=[],peBodies=[];
// v15: índices ativos de currículo/cover selecionados na lista da conta
let _peResIdx=null,_peCoverIdx=null;

// ── Helpers: mostrar/esconder área de upload de currículo ──
function _peShowResUpload(){
  const wrap=g("#pe-res-upload-wrap");if(wrap)wrap.style.display="block";
  const card=g("#pe-res-active-card");if(card)card.style.display="none";
  const cur=g("#pe-pdf-current");if(cur)cur.style.display="none";
}
function _peHideResUpload(){
  const wrap=g("#pe-res-upload-wrap");if(wrap)wrap.style.display="none";
}
function _peShowCoverUpload(){
  const wrap=g("#pe-cover-upload-wrap");if(wrap)wrap.style.display="block";
  const card=g("#pe-cover-active-card");if(card)card.style.display="none";
  const cur=g("#pe-cover-current");if(cur)cur.style.display="none";
}
function _peHideCoverUpload(){
  const wrap=g("#pe-cover-upload-wrap");if(wrap)wrap.style.display="none";
}

function clearProfilePdf(){
  profilePdfBase64=null;profilePdfName=null;profilePdfSize=0;
  const cur=g("#pe-pdf-current");if(cur)cur.style.display="none";
  const inp=g("#pe-pdf-input");if(inp)inp.value="";
  // Se não há activeCard visível, mostra a área de upload novamente
  const card=g("#pe-res-active-card");
  if(!card||card.style.display==="none") _peShowResUpload();
}

// Remove o currículo vinculado via resumeIdx (card verde "ativo")
function peRemoveResume(){
  _peResIdx=null;
  profilePdfBase64=null;profilePdfName=null;profilePdfSize=0;
  const card=g("#pe-res-active-card");if(card)card.style.display="none";
  const cur=g("#pe-pdf-current");if(cur)cur.style.display="none";
  // Desmarca qualquer radio selecionado nos slots
  document.querySelectorAll('input[name="pe-res"]').forEach(r=>{r.checked=(r.value==="");});
  _peShowResUpload();
  toast("Currículo removido deste perfil. Selecione outro ou faça upload.","g");
}

function handleProfilePdfDrop(e){e.preventDefault();const f=e.dataTransfer?.files?.[0];if(f)readProfilePdfFile(f);const lbl=g("#pe-pdf-drop");if(lbl)lbl.style.borderColor="";}
function handleProfilePdfSelect(e){const f=e.target?.files?.[0];if(f)readProfilePdfFile(f);}
async function readProfilePdfFile(f){
  if(!f.name.toLowerCase().endsWith(".pdf")&&f.type!=="application/pdf"){toast("Apenas arquivos .pdf","r");return;}
  // Auditoria 10/09/2026: o servidor (/api/cv/upload) recusa currículo acima
  // de ~5MB (base64 até 7_000_000 chars) — este 10MB permitia escolher um
  // arquivo que SEMPRE ia falhar no upload real, sem avisar na hora certa.
  if(f.size>5*1024*1024){toast("Currículo maior que 5MB","r");return;}
  if(f.size<1000){toast("Arquivo muito pequeno ou corrompido","r");return;}
  try{const arr=await f.slice(0,5).arrayBuffer();const sig=new Uint8Array(arr);if(!(sig[0]===0x25&&sig[1]===0x50&&sig[2]===0x44&&sig[3]===0x46)){toast("Arquivo inválido: não é um PDF real","r");return;}}catch{}
  const rd=new FileReader();
  rd.onload=ev=>{
    const b64=ev.target.result.split(",")[1];
    profilePdfBase64=b64;profilePdfName=f.name;profilePdfSize=f.size;
    // Limpa seleção de slot (novo upload substitui qualquer seleção anterior)
    _peResIdx=null;
    document.querySelectorAll('input[name="pe-res"]').forEach(r=>{r.checked=(r.value==="");});
    const card=g("#pe-res-active-card");if(card)card.style.display="none";
    const cur=g("#pe-pdf-current"),nm=g("#pe-pdf-name");
    if(nm)nm.textContent=f.name+" ("+Math.round(f.size/1024)+"KB)";
    if(cur)cur.style.display="flex";
    _peHideResUpload();
  };
  rd.onerror=()=>toast("Erro ao ler o arquivo PDF","r");
  rd.readAsDataURL(f);
}

// ── Ícone do perfil ──
let _peIcon="🎯";
function peToggleIconPicker(){
  const p=g("#pe-icon-picker");if(p)p.style.display=p.style.display==="none"?"block":"none";
}
function peSelectIcon(icon){
  _peIcon=icon;
  const btn=g("#pe-icon-btn");if(btn)btn.textContent=icon;
  const hid=g("#pe-icon");if(hid)hid.value=icon;
  const p=g("#pe-icon-picker");if(p)p.style.display="none";
}

// ── Cover Letter helpers ──
let profileCoverBase64=null,profileCoverName=null,profileCoverSize=0;

function clearProfileCover(){
  profileCoverBase64=null;profileCoverName=null;profileCoverSize=0;
  const cur=g("#pe-cover-current");if(cur)cur.style.display="none";
  const inp=g("#pe-cover-input");if(inp)inp.value="";
  const card=g("#pe-cover-active-card");
  if(!card||card.style.display==="none") _peShowCoverUpload();
}

// Remove a cover letter vinculada via coverIdx (card roxo "ativo")
function peRemoveCover(){
  _peCoverIdx=null;
  profileCoverBase64=null;profileCoverName=null;profileCoverSize=0;
  const card=g("#pe-cover-active-card");if(card)card.style.display="none";
  const cur=g("#pe-cover-current");if(cur)cur.style.display="none";
  document.querySelectorAll('input[name="pe-cover"]').forEach(r=>{r.checked=(r.value==="");});
  _peShowCoverUpload();
  toast("Cover Letter removida deste perfil.","g");
}

function handleProfileCoverDrop(e){e.preventDefault();const f=e.dataTransfer?.files?.[0];if(f)readProfileCoverFile(f);const lbl=g("#pe-cover-drop");if(lbl)lbl.style.borderColor="";}
function handleProfileCoverSelect(e){const f=e.target?.files?.[0];if(f)readProfileCoverFile(f);}
async function readProfileCoverFile(f){
  if(!f.name.toLowerCase().endsWith(".pdf")&&f.type!=="application/pdf"){toast("Apenas arquivos .pdf","r");return;}
  // Auditoria 10/09/2026: o servidor (/api/cv/upload) recusa carta acima de
  // ~3MB (base64 até 4_200_000 chars) — este 10MB permitia escolher um
  // arquivo que SEMPRE ia falhar no upload real, sem avisar na hora certa.
  if(f.size>3*1024*1024){toast("Carta maior que 3MB","r");return;}
  const rd=new FileReader();
  rd.onload=ev=>{
    const b64=ev.target.result.split(",")[1];
    profileCoverBase64=b64;profileCoverName=f.name;profileCoverSize=f.size;
    // Limpa seleção de slot
    _peCoverIdx=null;
    document.querySelectorAll('input[name="pe-cover"]').forEach(r=>{r.checked=(r.value==="");});
    const card=g("#pe-cover-active-card");if(card)card.style.display="none";
    const cur=g("#pe-cover-current"),nm=g("#pe-cover-name");
    if(nm)nm.textContent=f.name+" ("+Math.round(f.size/1024)+"KB)";
    if(cur)cur.style.display="flex";
    _peHideCoverUpload();
  };
  rd.onerror=()=>toast("Erro ao ler Cover Letter","r");
  rd.readAsDataURL(f);
}



// Tipos de perfil foram REMOVIDOS — todo perfil é normal. Stub mantido por segurança.
function peOnTypeChange(){}

// U4 (11/07): quando o servidor está reiniciando (deploy do Render), a resposta
// vem como página HTML (502) e o JSON.parse explodia na cara do usuário com
// "Unexpected token '<', <!DOCTYPE... is not valid JSON". Agora: mensagem clara.
async function jsonSafe(r){
  const txt=await r.text();
  try{return JSON.parse(txt);}
  catch{
    if(r.status===401)throw new Error("Sessão expirada — faça login novamente.");
    throw new Error("⚠️ O servidor está reiniciando (atualização em andamento). Aguarde ~30 segundos e tente novamente — nada foi perdido.");
  }
}

// ── Subjects helpers ──
function peRenderSubjects(){
  const list=g("#pe-subjects-list"),empty=g("#pe-subjects-empty"),lbl=g("#pe-subj-count-lbl");
  if(!list)return;
  const cnt=peSubjects.length;
  if(lbl)lbl.textContent=cnt+" assunto"+(cnt!==1?"s":"")+(cnt<3&&cnt>0?" ⚠️ (mín. 3)":"");
  if(!cnt){if(empty)empty.style.display="block";list.innerHTML="";g("#pe-subj-preview-wrap").style.display="none";return;}
  if(empty)empty.style.display="none";
  list.innerHTML=peSubjects.map((s,i)=>`
    <div style="display:flex;gap:6px;align-items:center">
      <input class="input" style="flex:1;font-size:13px" value="${esc(s)}" oninput="peSubjects[${i}]=this.value;peUpdateSubjPreview()" placeholder="Assunto do e-mail. Use {vaga}, {empresa}, {nome}">
      <button aria-label="Remover assunto" title="Remover assunto" onclick="peRemoveSubject(${i})" style="background:var(--redb);color:var(--red);border:1px solid var(--redb);border-radius:6px;padding:5px 8px;cursor:pointer;font-size:13px;flex-shrink:0"><i class="ti ti-trash"></i></button>
    </div>`).join("");
  peUpdateSubjPreview();
  // Indicador de mínimo
  const warn=g("#pe-subjects-warn");
  if(warn)warn.style.display=cnt>0&&cnt<3?"flex":"none";
}
function peAddSubject(){
  if(peSubjects.length>=10){toast("Máximo de 10 assuntos","r");return;}
  peSubjects.push("");peRenderSubjects();
  const inputs=g("#pe-subjects-list").querySelectorAll("input");
  if(inputs.length)inputs[inputs.length-1].focus();
}
function peRemoveSubject(i){peSubjects.splice(i,1);peRenderSubjects();}
// v18-FIX: peAddSubjectModel() removida — só existia pra alimentar os botões
// de "assunto pronto" que já foram tirados da tela (ver comentário no HTML).
function peInsertSubjVar(v){
  const inputs=g("#pe-subjects-list").querySelectorAll("input");
  const last=inputs[inputs.length-1];if(!last)return;
  const s=last.selectionStart,e=last.selectionEnd;
  last.value=last.value.slice(0,s)+v+last.value.slice(e);
  last.selectionStart=last.selectionEnd=s+v.length;
  peSubjects[peSubjects.length-1]=last.value;
  peRenderSubjects();
}
function peUpdateSubjPreview(){
  const wrap=g("#pe-subj-preview-wrap"),txt=g("#pe-subj-preview-text");if(!wrap||!txt)return;
  const s=peSubjects[0];if(!s){wrap.style.display="none";return;}
  wrap.style.display="block";
  txt.textContent=s.replace(/{vaga}/g,"Landscape Worker").replace(/{empresa}/g,"Green Gardens LLC").replace(/{nome}/g,U.name||"João Silva").replace(/{categoria}/g,"Landscape");
}

// ── Bodies helpers ──
function peRenderBodies(){
  const list=g("#pe-bodies-list"),empty=g("#pe-bodies-empty"),lbl=g("#pe-body-count-lbl");
  if(!list)return;
  const cnt=peBodies.length;
  if(lbl)lbl.textContent=cnt+" corpo"+(cnt!==1?"s":"")+(cnt<3&&cnt>0?" ⚠️ (mín. 3)":"");
  if(!cnt){if(empty)empty.style.display="block";list.innerHTML="";return;}
  if(empty)empty.style.display="none";
  list.innerHTML=peBodies.map((b,i)=>`
    <div style="background:var(--sf2);border:1.5px solid var(--border);border-radius:10px;padding:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="width:20px;height:20px;background:var(--blue);color:#fff;border-radius:50%;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center">${i+1}</span>
          <span style="font-size:12px;font-weight:700;color:var(--t2)">Versão ${i+1}</span>
        </div>
        <button aria-label="Remover texto" title="Remover texto" onclick="peRemoveBody(${i})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:13px"><i class="ti ti-trash"></i></button>
      </div>
      <textarea class="input" rows="4" style="font-size:12px;resize:vertical;font-family:monospace" oninput="peBodies[${i}]=this.value" placeholder="Corpo do e-mail. Use {nome}, {vaga}, {empresa}, {pais}, {telefone}">${esc(b)}</textarea>
    </div>`).join("");
  // Indicador de mínimo
  const warn=g("#pe-bodies-warn");
  if(warn)warn.style.display=cnt>0&&cnt<3?"flex":"none";
}
function peAddBody(){
  if(peBodies.length>=10){toast("Máximo de 10 corpos","r");return;}
  peBodies.push("");peRenderBodies();
}
function peRemoveBody(i){peBodies.splice(i,1);peRenderBodies();}
// v18-FIX: PE_BODY_MODELS/peAddBodyModel removidos — eram os 7 corpos de
// e-mail genéricos "prontos" que alimentavam os botões de 1-clique já
// tirados da tela (ver comentário no HTML, seção "④ Corpos de E-mail").

// ── RENDERIZAR PERFIS (lista) ────────────────────────────────
// PERFIL ÚNICO (2026-07): não existe mais "vários perfis por tipo de vaga" —
// cada usuário tem exatamente 1 perfil, usado em todas as candidaturas. A
// lista virou, na prática, um cartão único (sem Duplicar/Ativar/Excluir —
// não fazem sentido quando só existe 1 perfil e ele precisa estar sempre ativo).
// v19 (dono, 15/07/2026): 1 perfil POR TIPO DE VISTO — até 2 (H-2B + H-2A).
// A vaga manda: H-2A envia com o perfil H-2A, H-2B com o H-2B. Criar o
// segundo é opcional — o usuário escolhe.
function _profileCardHTML(p){
  const subjects=p.subjects||[];
  const bodies=p.emailBodies||[];
  const hasPdf=!!(p.pdfName||p.resumeIdx!=null);
  const vt=(p.visaType||"h2b");
  const vtTag=vt==="h2a"?'<span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:6px;background:rgba(16,185,129,.15);color:#059669;margin-left:6px">🌾 H-2A</span>':'<span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:6px;background:rgba(37,99,235,.12);color:#2563eb;margin-left:6px">🏨 H-2B</span>';
  return `<div class="profile-card">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px">
        <div style="width:38px;height:38px;border-radius:10px;background:var(--sf2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${p.icon||"🎯"}</div>
        <div style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:800">${esc(p.name)}</span>${vtTag}
          ${p.desc?`<div style="font-size:11px;color:var(--t2);margin-top:2px">${esc(p.desc)}</div>`:""}
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
            <span style="font-size:10px;background:var(--sf2);border:1px solid var(--border);border-radius:5px;padding:2px 7px;color:${subjects.length>=3?"var(--green)":"var(--amber)"}"><i class="ti ti-mail"></i> ${subjects.length} assunto${subjects.length!==1?"s":""}${subjects.length<3?" ⚠️":""}</span>
            <span style="font-size:10px;background:var(--sf2);border:1px solid var(--border);border-radius:5px;padding:2px 7px;color:${bodies.length>=3?"var(--green)":"var(--amber)"}"><i class="ti ti-file-text"></i> ${bodies.length} corpo${bodies.length!==1?"s":""}${bodies.length<3?" ⚠️":""}</span>
            ${hasPdf?`<span style="font-size:10px;color:var(--red);background:var(--redl);border:1px solid var(--redb);border-radius:5px;padding:2px 7px"><i class="ti ti-file-type-pdf"></i> PDF</span>`:`<span style="font-size:10px;color:var(--amber);background:var(--amberl);border:1px solid var(--amberb);border-radius:5px;padding:2px 7px">⚠️ Sem PDF</span>`}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button onclick="openProfileEditor('${p.id}')" class="btn btn-secondary btn-xs"><i class="ti ti-pencil"></i> Editar</button>
        ${UPROFILES.length>1?`<button onclick="deleteProfile('${p.id}')" class="btn btn-xs" style="color:var(--red);border:1px solid var(--redb);background:var(--redl)"><i class="ti ti-trash"></i> Excluir</button>`:""}
      </div>
    </div>`;
}
function _createTypeBtnHTML(vt){
  const isA=vt==="h2a";
  return `<button onclick="openProfileEditor(null,'${vt}')" style="display:flex;align-items:center;gap:10px;width:100%;background:${isA?"rgba(16,185,129,.06)":"rgba(37,99,235,.05)"};border:1.5px dashed ${isA?"rgba(16,185,129,.4)":"rgba(37,99,235,.35)"};border-radius:14px;padding:14px;cursor:pointer;font-family:inherit;text-align:left;margin-top:8px">
    <div style="width:38px;height:38px;border-radius:10px;background:${isA?"rgba(16,185,129,.12)":"rgba(37,99,235,.1)"};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${isA?"🌾":"🏨"}</div>
    <div style="flex:1">
      <div style="font-size:13px;font-weight:800;color:${isA?"#059669":"#2563eb"}">➕ Criar perfil ${isA?"H-2A (agricultura)":"H-2B (hotelaria, construção...)"}</div>
      <div style="font-size:11px;color:var(--t3);margin-top:2px">Opcional — as vagas ${isA?"H-2A":"H-2B"} vão usar este perfil automaticamente</div>
    </div>
  </button>`;
}
function renderProfiles(){
  const list=g("#profile-list");if(!list)return;
  const createBtn=g("#profile-create-btn");
  if(!UPROFILES.length){
    list.innerHTML=`<div class="empty-state"><i class="ti ti-user-circle"></i><p>Nenhum perfil criado ainda</p><small>Você pode ter até 2 perfis: um pra vagas <strong>H-2B</strong> (hotelaria, construção, paisagismo...) e um pra vagas <strong>H-2A</strong> (agricultura). Cada vaga usa automaticamente o perfil do tipo dela. Comece criando o que você mais usa — o outro é opcional.</small></div>`
      +_createTypeBtnHTML("h2b")+_createTypeBtnHTML("h2a");
    if(createBtn)createBtn.innerHTML=`<i class="ti ti-plus" style="font-size:16px"></i> Criar Meu Perfil`;
    return;
  }
  if(createBtn)createBtn.innerHTML=`<i class="ti ti-pencil" style="font-size:16px"></i> Editar Meu Perfil`;
  const hasB=UPROFILES.some(p=>(p.visaType||"h2b")==="h2b");
  const hasA=UPROFILES.some(p=>(p.visaType||"h2b")==="h2a");
  list.innerHTML=UPROFILES.map(_profileCardHTML).join("")
    +(!hasB?_createTypeBtnHTML("h2b"):"")
    +(!hasA?_createTypeBtnHTML("h2a"):"");
}

// v19: botão principal da aba — se não existe nenhum perfil, PERGUNTA primeiro
// qual tipo criar (H-2B ou H-2A); se já existe, abre o primeiro pra edição
// (os cards da lista têm botão próprio de editar/criar o outro tipo).
function openMyProfile(){
  if(UPROFILES.length){openProfileEditor(UPROFILES[0].id);return;}
  showVisaTypeChooser();
}
function showVisaTypeChooser(){
  const old=document.getElementById("vt-chooser");if(old)old.remove();
  const ov=document.createElement("div");
  ov.id="vt-chooser";
  ov.className="overlay"; // ⚠️ QA 11/09: sem isso o guard outroModalAberto do tour não via este popup como modal aberto e deixava o tour cobrir/travar os cliques nele
  ov.style.cssText="position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)";
  ov.innerHTML=`<div style="background:var(--surface);border-radius:20px;padding:22px;max-width:420px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.35)">
    <div style="font-size:16px;font-weight:900;margin-bottom:4px">Qual tipo de perfil você quer criar?</div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:14px;line-height:1.5">Cada vaga usa o perfil do tipo dela. Você pode criar os dois — um de cada.</div>
    <button onclick="document.getElementById('vt-chooser').remove();openProfileEditor(null,'h2b')" style="display:flex;align-items:center;gap:12px;width:100%;background:rgba(37,99,235,.06);border:1.5px solid rgba(37,99,235,.35);border-radius:14px;padding:14px;cursor:pointer;font-family:inherit;text-align:left;margin-bottom:8px">
      <span style="font-size:26px">🏨</span>
      <div><div style="font-size:14px;font-weight:800;color:#2563eb">Perfil H-2B</div><div style="font-size:11px;color:var(--t3)">Hotelaria, construção, paisagismo, restaurantes...</div></div>
    </button>
    <button onclick="document.getElementById('vt-chooser').remove();openProfileEditor(null,'h2a')" style="display:flex;align-items:center;gap:12px;width:100%;background:rgba(16,185,129,.06);border:1.5px solid rgba(16,185,129,.4);border-radius:14px;padding:14px;cursor:pointer;font-family:inherit;text-align:left;margin-bottom:10px">
      <span style="font-size:26px">🌾</span>
      <div><div style="font-size:14px;font-weight:800;color:#059669">Perfil H-2A</div><div style="font-size:11px;color:var(--t3)">Agricultura, fazendas, colheita, trabalho rural...</div></div>
    </button>
    <button onclick="document.getElementById('vt-chooser').remove()" style="width:100%;background:none;border:none;color:var(--t3);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;padding:6px">Cancelar</button>
  </div>`;
  ov.addEventListener("click",e=>{if(e.target===ov)ov.remove();});
  document.body.appendChild(ov);
}

// ── ABRIR EDITOR ────────────────────────────────
// v19: segundo parâmetro = tipo de visto ao CRIAR ('h2b'|'h2a'). Ao editar,
// o tipo vem do próprio perfil e não muda (1 perfil por tipo).
let editingVisaType="h2b";

// ══ v143: RASCUNHO DO EDITOR DE PERFIL (caso real: Keyla, Servidor 3) ══
// Achado real: o servidor derruba TODAS as sessões de login sempre que o
// processo reinicia (decisão deliberada do dono, KB-078 — "toda vez que eu
// fizer deploy quero que deslogue todos"). Servidor 3 é a FONTE e recebe
// deploy a cada commit, então reinicia com frequência — quem está no meio
// de escrever um perfil novo (assuntos/corpos de e-mail, o trabalho mais
// chato de digitar do site) recebe "Sessão expirada" e perde tudo. NÃO
// mexemos na decisão de segurança (ela continua valendo) — só garantimos
// que o TEXTO nunca se perde: autosave local a cada digitação, restaurado
// sozinho na próxima vez que a pessoa abrir o mesmo perfil (mesmo depois
// de relogar). Guardado só no aparelho (localStorage), nunca no servidor.
// v167 (bug real, auditoria 08/09/2026): a chave não tinha e-mail nenhum —
// num aparelho compartilhado (comum: pai/filho, LAN house, etc.), o rascunho
// digitado pela conta A aparecia PRÉ-PREENCHIDO no editor da conta B ao
// trocar de login (o confirm() de restauração só comparava editingProfileId,
// nunca o dono do dado). Escopado por e-mail agora — cada conta só vê o
// próprio rascunho.
function _peDraftKey(vt){return "h2b_pe_draft_"+(vt==="h2a"?"h2a":"h2b")+"_"+(U?.email||"anon");}
let _peDraftTimer=null;
function _peCollectDraft(){
  return{
    name:g("#pe-name")?.value||"",
    desc:g("#pe-desc")?.value||"",
    subjects:[...(g("#pe-subjects-list")?.querySelectorAll("input")||[])].map(i=>i.value),
    bodies:[...(g("#pe-bodies-list")?.querySelectorAll("textarea")||[])].map(t=>t.value),
    editingProfileId:editingProfileId||null,
    savedAt:Date.now(),
  };
}
function _peSaveDraftNow(){
  try{
    const d=_peCollectDraft();
    const temAlgo=d.name||d.desc||d.subjects.some(Boolean)||d.bodies.some(Boolean);
    if(!temAlgo){localStorage.removeItem(_peDraftKey(editingVisaType));return;}
    localStorage.setItem(_peDraftKey(editingVisaType),JSON.stringify(d));
  }catch(e){}
}
function _peScheduleDraft(){clearTimeout(_peDraftTimer);_peDraftTimer=setTimeout(_peSaveDraftNow,500);}
function _peClearDraft(vt){try{localStorage.removeItem(_peDraftKey(vt||editingVisaType));}catch(e){}}
function _peLoadDraft(vt){
  try{
    const raw=localStorage.getItem(_peDraftKey(vt));
    if(!raw)return null;
    const d=JSON.parse(raw);
    if(!d||Date.now()-(d.savedAt||0)>7*86400_000){localStorage.removeItem(_peDraftKey(vt));return null;} // rascunho não fica eterno
    return d;
  }catch(e){return null;}
}
// Delegação: 1 listener no modal cobre todos os campos, mesmo os que
// nascem dinamicamente (assuntos/corpos são adicionados/removidos em runtime).
document.addEventListener("DOMContentLoaded",()=>{
  const ov=document.getElementById("profile-editor-overlay");
  if(ov)ov.addEventListener("input",()=>{if(!ov.classList.contains("gone"))_peScheduleDraft();});
});

function openProfileEditor(id,visaType){
  editingProfileId=id||null;
  const p=id?UPROFILES.find(x=>x.id===id):null;
  editingVisaType=p?(p.visaType||"h2b"):(visaType==="h2a"?"h2a":"h2b");
  clearProfilePdf();
  clearProfileCover();
  const _vtLbl=editingVisaType==="h2a"?"🌾 H-2A":"🏨 H-2B";
  g("#pe-title").textContent=p?`Editar Perfil ${_vtLbl}`:`Novo Perfil ${_vtLbl}`;
  g("#pe-name").value=p?.name||"";
  g("#pe-desc").value=p?.desc||"";
  // Ícone
  const icon=p?.icon||"🎯";
  _peIcon=icon;
  const iconBtn=g("#pe-icon-btn");if(iconBtn)iconBtn.textContent=icon;
  const iconHid=g("#pe-icon");if(iconHid)iconHid.value=icon;
  const iconPicker=g("#pe-icon-picker");if(iconPicker)iconPicker.style.display="none";

  const actCb=g("#pe-active");if(actCb)actCb.checked=p?p.active!==false:true;
  const favCb=g("#pe-favorite");if(favCb)favCb.checked=!!p?.isFavorite;
  const manualCb=g("#pe-allow-manual");if(manualCb)manualCb.checked=p?.allowManual!==false;
  const autoCb=g("#pe-allow-auto");if(autoCb)autoCb.checked=p?.allowAuto!==false;
  const rotSubj=g("#pe-rotate-subj");if(rotSubj)rotSubj.checked=p?.rotateSubjects!==false;
  const rotBody=g("#pe-rotate-body");if(rotBody)rotBody.checked=p?.rotateBodies!==false;
  const delay=g("#pe-delay-random");if(delay)delay.checked=p?.randomDelay!==false;


  // Subjects
  peSubjects=p?.subjects?.length?[...p.subjects]:(p?.subject?[p.subject]:[]);
  peRenderSubjects();

  // Bodies
  peBodies=p?.emailBodies?.length?[...p.emailBodies]:(p?.body?[p.body]:[]);
  peRenderBodies();

  // Categorias
  const pCats=p?.categories||[];
  document.querySelectorAll('input[name="pe-cat"]').forEach(cb=>{cb.checked=pCats.includes(cb.value);});

  // Planilhas
  const pSheets=p?.sheets||[];
  document.querySelectorAll('input[name="pe-sheet"]').forEach(cb=>{cb.checked=pSheets.includes(cb.value);});

  // ── PDFs: inicializa estado e mostra cards corretos ───────
  // Reseta tudo primeiro
  profilePdfName="";profilePdfBase64="";profilePdfSize=0;
  profileCoverName="";profileCoverBase64="";profileCoverSize=0;
  _peResIdx=null; _peCoverIdx=null;

  // Currículo vinculado via resumeIdx (seleção da conta)
  if(p?.resumeIdx!=null){
    const cvMeta=DOCS.find(c=>c.idx===p.resumeIdx);
    _peResIdx=p.resumeIdx;
    const nm=cvMeta?.name||(p.pdfName||"Currículo vinculado");
    const nameEl=g("#pe-res-active-name");if(nameEl)nameEl.textContent=nm;
    const card=g("#pe-res-active-card");if(card)card.style.display="flex";
    const wrap=g("#pe-res-upload-wrap");if(wrap)wrap.style.display="none";
  } else if(p?.pdfName){
    // PDF antigo via upload direto (legado: pdfName sem resumeIdx)
    profilePdfName=p.pdfName;profilePdfBase64="__existing__";profilePdfSize=p.pdfSize||0;
    const nm=g("#pe-pdf-name");if(nm)nm.textContent=p.pdfName;
    const cur=g("#pe-pdf-current");if(cur)cur.style.display="flex";
    const wrap=g("#pe-res-upload-wrap");if(wrap)wrap.style.display="none";
  } else {
    // Sem nenhum PDF — mostra área de upload
    const wrap=g("#pe-res-upload-wrap");if(wrap)wrap.style.display="block";
  }

  // Cover Letter vinculada via coverIdx
  if(p?.coverIdx!=null){
    const cvMeta=DOCS.find(c=>c.idx===p.coverIdx);
    _peCoverIdx=p.coverIdx;
    const nm=cvMeta?.name||(p.coverName||"Cover Letter vinculada");
    const nameEl=g("#pe-cover-active-name");if(nameEl)nameEl.textContent=nm;
    const card=g("#pe-cover-active-card");if(card)card.style.display="flex";
    const wrap=g("#pe-cover-upload-wrap");if(wrap)wrap.style.display="none";
  } else if(p?.coverName){
    // Cover antiga via upload direto (legado)
    profileCoverName=p.coverName;profileCoverBase64="__existing__";profileCoverSize=p.coverSize||0;
    const nm=g("#pe-cover-name");if(nm)nm.textContent=p.coverName;
    const cur=g("#pe-cover-current");if(cur)cur.style.display="flex";
    const wrap=g("#pe-cover-upload-wrap");if(wrap)wrap.style.display="none";
  } else {
    // Sem nenhuma cover — mostra área de upload
    const wrap=g("#pe-cover-upload-wrap");if(wrap)wrap.style.display="block";
  }

  // Slots de currículo
  const delBtn=g("#pe-del-btn");if(delBtn)delBtn.style.display=p?"inline-flex":"none";

  _pePopulateResumeSlots();
  _pePopulateCoverSlots();

  // v143: rascunho salvo localmente (sessão caiu no meio de um perfil
  // deste MESMO tipo de visto e do MESMO perfil — nunca mistura rascunho
  // de um perfil com outro) — pergunta antes de sobrescrever o que já tem.
  const _draft=_peLoadDraft(editingVisaType);
  if(_draft&&_draft.editingProfileId===(editingProfileId||null)){
    const _temTexto=_draft.name||_draft.desc||_draft.subjects.some(Boolean)||_draft.bodies.some(Boolean);
    if(_temTexto&&confirm(t('pe_draft_confirm'))){
      if(_draft.name)g("#pe-name").value=_draft.name;
      if(_draft.desc)g("#pe-desc").value=_draft.desc;
      if(_draft.subjects.some(Boolean)){peSubjects=_draft.subjects.filter(Boolean);peRenderSubjects();}
      if(_draft.bodies.some(Boolean)){peBodies=_draft.bodies.filter(Boolean);peRenderBodies();}
      toast(t('pe_draft_restored'),"g");
    }
  }

  g("#profile-editor-overlay").classList.remove("gone");
}

// ⚠️ QA 11/09: extraídas de dentro de openProfileEditor() pra ficarem
// CHAMÁVEIS também depois de excluir um PDF (deleteCvFromAccount chamava
// peRenderResumeSlots/peRenderCoverSlots, que nunca existiram — a exclusão
// no servidor funcionava, mas o front caía no catch e mostrava "Erro de
// conexão" em cima do toast de sucesso, com a lista do modal desatualizada).
function _pePopulateResumeSlots(){
  const resSlots=g("#pe-res-slots");
  if(!resSlots)return;
  const res=DOCS.filter(c=>(c.cvType||"resume")==="resume");
  if(!res.length){resSlots.innerHTML='<div style="font-size:11px;color:var(--t3)">Nenhum currículo na conta. <span style="color:var(--blue);cursor:pointer" onclick="closeProfileEditor();sv(\'profile\');setTimeout(()=>switchProfileTab(\'profiles\'),100)">Adicionar →</span></div>';}
  else{
    resSlots.innerHTML=[
      `<label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;padding:6px 8px;border-radius:7px;border:1.5px solid var(--border);background:var(--sf2)"><input type="radio" name="pe-res" value="" style="accent-color:var(--purple)"> <span style="color:var(--t2)">Nenhum</span></label>`,
      ...res.map(c=>`<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:7px;border:1.5px solid var(--border);background:var(--sf2)"><label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;flex:1;min-width:0"><input type="radio" name="pe-res" value="${c.idx}" style="accent-color:var(--blue)"><i class="ti ti-file-type-pdf" style="color:var(--red);flex-shrink:0"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></label><button onclick="deleteCvFromAccount(${c.idx},'resume')" title="Excluir PDF" style="background:#fee2e2;border:1.5px solid #fca5a5;color:#dc2626;border-radius:6px;padding:4px 6px;font-size:11px;cursor:pointer;flex-shrink:0;line-height:1"><i class='ti ti-trash'></i></button></div>`)
    ].join("");
    // Marca o selecionado atual
    const curVal=_peResIdx!=null?String(_peResIdx):"";
    resSlots.querySelectorAll('input[name="pe-res"]').forEach(r=>{
      r.checked=(r.value===curVal);
      r.addEventListener("change",()=>{
        const val=r.value;
        if(!val){
          // "Nenhum" — remove ativo
          _peResIdx=null;
          const card=g("#pe-res-active-card");if(card)card.style.display="none";
          const cur2=g("#pe-pdf-current");if(cur2)cur2.style.display="none";
          profilePdfBase64=null;profilePdfName=null;profilePdfSize=0;
        } else {
          // Selecionou um PDF da conta
          _peResIdx=parseInt(val,10);
          profilePdfBase64=null;profilePdfName=null;profilePdfSize=0;
          const cur2=g("#pe-pdf-current");if(cur2)cur2.style.display="none";
          const cvMeta=DOCS.find(c=>c.idx===_peResIdx);
          const nm=cvMeta?.name||"Currículo";
          const nameEl=g("#pe-res-active-name");if(nameEl)nameEl.textContent=nm;
          const card=g("#pe-res-active-card");if(card)card.style.display="flex";
          _peHideResUpload();
        }
      });
    });
  }
}
function _pePopulateCoverSlots(){
  const coverSlots=g("#pe-cover-slots");
  if(!coverSlots)return;
  const covers=DOCS.filter(c=>c.cvType==="cover");
  if(!covers.length){coverSlots.innerHTML='<div style="font-size:11px;color:var(--t3)">Nenhuma cover letter na conta. <span style="color:var(--blue);cursor:pointer" onclick="closeProfileEditor();sv(\'profile\');setTimeout(()=>switchProfileTab(\'profiles\'),100)">Adicionar →</span></div>';}
  else{
    coverSlots.innerHTML=[
      `<label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;padding:6px 8px;border-radius:7px;border:1.5px solid var(--border);background:var(--sf2)"><input type="radio" name="pe-cover" value="" style="accent-color:var(--purple)"> <span style="color:var(--t2)">Nenhuma</span></label>`,
      ...covers.map(c=>`<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:7px;border:1.5px solid var(--border);background:var(--sf2)"><label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;flex:1;min-width:0"><input type="radio" name="pe-cover" value="${c.idx}" style="accent-color:var(--purple)"><i class="ti ti-file-description" style="color:var(--purple);flex-shrink:0"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></label><button onclick="deleteCvFromAccount(${c.idx},'cover')" title="Excluir PDF" style="background:#fee2e2;border:1.5px solid #fca5a5;color:#dc2626;border-radius:6px;padding:4px 6px;font-size:11px;cursor:pointer;flex-shrink:0;line-height:1"><i class='ti ti-trash'></i></button></div>`)
    ].join("");
    const curCovVal=_peCoverIdx!=null?String(_peCoverIdx):"";
    coverSlots.querySelectorAll('input[name="pe-cover"]').forEach(r=>{
      r.checked=(r.value===curCovVal);
      r.addEventListener("change",()=>{
        const val=r.value;
        if(!val){
          _peCoverIdx=null;
          const card=g("#pe-cover-active-card");if(card)card.style.display="none";
          const cur2=g("#pe-cover-current");if(cur2)cur2.style.display="none";
          profileCoverBase64=null;profileCoverName=null;profileCoverSize=0;
        } else {
          _peCoverIdx=parseInt(val,10);
          profileCoverBase64=null;profileCoverName=null;profileCoverSize=0;
          const cur2=g("#pe-cover-current");if(cur2)cur2.style.display="none";
          const cvMeta=DOCS.find(c=>c.idx===_peCoverIdx);
          const nm=cvMeta?.name||"Cover Letter";
          const nameEl=g("#pe-cover-active-name");if(nameEl)nameEl.textContent=nm;
          const card=g("#pe-cover-active-card");if(card)card.style.display="flex";
          _peHideCoverUpload();
        }
      });
    });
  }
}

function closeProfileEditor(){
  g("#profile-editor-overlay").classList.add("gone");
  editingProfileId=null;
  clearProfilePdf();clearProfileCover();
  _peResIdx=null;_peCoverIdx=null;
  const card=g("#pe-res-active-card");if(card)card.style.display="none";
  const ccard=g("#pe-cover-active-card");if(ccard)ccard.style.display="none";
  peSubjects=[];peBodies=[];
  const iconPicker=g("#pe-icon-picker");if(iconPicker)iconPicker.style.display="none";
}

// ── SALVAR PERFIL ────────────────────────────────

async function deleteCvFromAccount(idx, cvType){
  var label=cvType==="resume"?"currículo":"cover letter";
  if(!confirm("Excluir este "+label+" da conta? Esta ação não pode ser desfeita."))return;
  try{
    var r=await fetch("/api/cv/delete",{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idx:idx})});
    var d=await r.json();
    if(d.ok){
      toast("PDF excluído com sucesso","g");
      // Recarregar lista de PDFs
      var cvs=(U.cvs||[]).filter(function(c){return c.idx!==idx;});
      U.cvs=cvs;
      DOCS=DOCS.filter(function(c){return c.idx!==idx;});
      if(_peResIdx===idx)_peResIdx=null;
      if(_peCoverIdx===idx)_peCoverIdx=null;
      _pePopulateResumeSlots();
      _pePopulateCoverSlots();
    } else {
      toast(d.error||"Erro ao excluir PDF","r");
    }
  }catch(e){toast("Erro de conexão","r");}
}

// v143: mensagem clara quando a sessão caiu (servidor reiniciou) em vez do
// erro cru — e garante o rascunho salvo NA HORA, não espera o debounce.
// v167 (auditoria 08/09/2026): "Não autenticado." é a mensagem 401 padrão de
// 100+ rotas do servidor (só 9 rotas, como /api/cv/upload, mandam a frase
// "Sessão expirada" com sessionExpired:true) — /api/profiles/save é uma das
// que NÃO manda, então reabrir um perfil já existente e clicar Salvar depois
// da sessão cair (o caminho mais comum: sem PDF novo, cai direto nessa rota)
// mostrava o toast cru "Erro: Não autenticado." em vez do aviso amigável.
// Detecção ampliada aqui, no cliente, cobre as duas frases de uma vez — sem
// precisar caçar e alinhar a mensagem em cada rota do servidor.
function _sessionDroppedMsg(e){
  return /sess[aã]o expirada|n[aã]o autenticado/i.test(String(e?.message||e||""));
}
function _peSessionMsg(prefix,e){
  if(_sessionDroppedMsg(e)){
    _peSaveDraftNow();
    return t('pe_session_lost');
  }
  return prefix+": "+String(e?.message||e||"");
}
async function saveProfileFromEditor(){
  _peSaveDraftNow(); // v143: snapshot garantido no instante do clique em Salvar
  const name=g("#pe-name")?.value?.trim();
  if(!name){toast("Nome obrigatório","r");return;}

  // Coleta subjects do DOM
  const subjInputs=g("#pe-subjects-list")?.querySelectorAll("input")||[];
  peSubjects=[...subjInputs].map(i=>i.value.trim()).filter(Boolean);
  const uniqueSubj=[...new Set(peSubjects)];
  peSubjects=uniqueSubj;

  if(!peSubjects.length){toast("Adicione pelo menos 1 assunto","r");return;}
  if(peSubjects.length<3){
    g("#pe-subjects-warn").style.display="flex";
    toast("⚠️ Mínimo 3 assuntos para evitar spam","r");return;
  }
  g("#pe-subjects-warn").style.display="none";

  // Coleta bodies do DOM
  const bodyTAs=g("#pe-bodies-list")?.querySelectorAll("textarea")||[];
  peBodies=[...bodyTAs].map(t=>t.value.trim()).filter(Boolean);

  if(!peBodies.length){toast("Adicione pelo menos 1 corpo de e-mail","r");return;}
  if(peBodies.length<3){
    g("#pe-bodies-warn").style.display="flex";
    toast("⚠️ Mínimo 3 corpos para evitar spam","r");return;
  }
  g("#pe-bodies-warn").style.display="none";

  const categories=[...document.querySelectorAll('input[name="pe-cat"]:checked')].map(cb=>cb.value);
  const sheets=[...document.querySelectorAll('input[name="pe-sheet"]:checked')].map(cb=>cb.value);
  const selRes=document.querySelector('input[name="pe-res"]:checked');
  const resumeIdx=_peResIdx!=null?_peResIdx:(selRes?.value?parseInt(selRes.value,10):null);
  const selCover=document.querySelector('input[name="pe-cover"]:checked');
  const coverIdx=_peCoverIdx!=null?_peCoverIdx:(selCover?.value?parseInt(selCover.value,10):null);
  // VALIDAÇÃO: pelo menos 1 dos 2 (currículo OU carta) — mesma regra do
  // servidor e do README ("pelo menos um dos dois"). Bloquear com carta
  // já anexada e nenhum currículo era falso-negativo.
  const hasResumePdf=profilePdfBase64&&profilePdfBase64!=="__none__";
  const hasResumeLinked=resumeIdx!=null;
  const hasCoverPdf=profileCoverBase64&&profileCoverBase64!=="__none__";
  const hasCoverLinked=coverIdx!=null;
  if(!hasResumePdf&&!hasResumeLinked&&!hasCoverPdf&&!hasCoverLinked){
    toast("⚠️ Adicione um Currículo (PDF) ou uma Carta de Apresentação antes de salvar o perfil!","r");
    // Destacar a área de upload
    const drop=document.getElementById("pe-pdf-drop");
    if(drop){drop.style.borderColor="#ef4444";drop.style.background="#fef2f2";setTimeout(()=>{drop.style.borderColor="";drop.style.background="";},3000);}
    // Scroll até o campo
    const wrap=document.getElementById("pe-res-upload-wrap");
    if(wrap)wrap.scrollIntoView({behavior:"smooth",block:"center"});
    return;
  }

  const prf={
    id:editingProfileId||undefined,
    name,
    desc:g("#pe-desc")?.value?.trim()||"",
    icon:g("#pe-icon")?.value||_peIcon||(editingVisaType==="h2a"?"🌾":"🎯"),
    type:"normal",
    visaType:editingVisaType, // v19: 1 perfil por tipo de visto
    active:g("#pe-active")?.checked!==false,
    isFavorite:!!g("#pe-favorite")?.checked,
    isGeneral:categories.length===0, // sem categorias = perfil normal, serve para tudo
    allowManual:g("#pe-allow-manual")?.checked!==false,
    allowAuto:g("#pe-allow-auto")?.checked!==false,
    rotateSubjects:true,
    rotateBodies:true,
    randomDelay:true,
    subjects:peSubjects,
    emailBodies:peBodies,
    subject:peSubjects[0]||"",
    body:peBodies[0]||"",
    categories,sheets,resumeIdx,coverIdx,
  };

  // v167 (bug real, auditoria 08/09/2026): o botão só desabilitava DEPOIS dos
  // uploads de PDF/cover (que têm await) — um duplo-clique real disparava 2
  // execuções concorrentes completas da função (2 uploads + 2 saves). Agora
  // desabilita ANTES de qualquer await, assim que as validações síncronas
  // passam — igual ao caminho sem upload novo, que já estava protegido.
  const saveBtn=g("#pe-save-btn");if(saveBtn){saveBtn.disabled=true;saveBtn.innerHTML='<span class="spin spin-sm"></span> Salvando...';}
  const _peResetSaveBtn=()=>{if(saveBtn){saveBtn.disabled=false;saveBtn.innerHTML='<i class="ti ti-check"></i> Salvar Perfil';}};

  // Upload PDF se novo
  if(profilePdfBase64&&profilePdfBase64!=="__existing__"){
    try{
      const r=await fetch("/api/cv/upload",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({base64:profilePdfBase64,name:profilePdfName,cvType:"resume"})});
      const d=await jsonSafe(r);
      if(d.ok){prf.resumeIdx=d.cv.idx;prf.pdfName=d.cv.name;prf.pdfSize=d.cv.size;}
      else throw new Error(d.error);
    }catch(e){_peResetSaveBtn();toast(_peSessionMsg("Erro upload PDF",e),"r");return;}
  }else if(profilePdfBase64==="__existing__"&&editingProfileId){
    const existing=UPROFILES.find(x=>x.id===editingProfileId);
    if(existing?.pdfName){prf.pdfName=existing.pdfName;prf.pdfSize=existing.pdfSize||0;}
  }

  // Upload Cover Letter se nova
  if(profileCoverBase64&&profileCoverBase64!=="__existing__"){
    try{
      const r=await fetch("/api/cv/upload",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({base64:profileCoverBase64,name:profileCoverName,cvType:"cover"})});
      const d=await jsonSafe(r);
      if(d.ok){prf.coverIdx=d.cv.idx;prf.coverName=d.cv.name;prf.coverSize=d.cv.size;}
      else throw new Error(d.error);
    }catch(e){_peResetSaveBtn();toast(_peSessionMsg("Erro upload Cover Letter",e),"r");return;}
  }else if(profileCoverBase64==="__existing__"&&editingProfileId){
    const existing=UPROFILES.find(x=>x.id===editingProfileId);
    if(existing?.coverName){prf.coverName=existing.coverName;prf.coverSize=existing.coverSize||0;}
  }
  try{
    const r=await fetch("/api/profiles/save",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(prf)});
    const d=await jsonSafe(r);if(!d.ok)throw new Error(d.error);
    const idx=UPROFILES.findIndex(x=>x.id===d.profile.id);
    if(idx>=0)UPROFILES[idx]=d.profile;else UPROFILES.unshift(d.profile);
    U.profiles=UPROFILES;
    U.connected=true; // garante que U está populated
    _peClearDraft(editingVisaType); // v143: salvou de verdade, rascunho não serve mais
    closeProfileEditor();
    renderProfiles();
    refreshOnboardChecklist();
    // Atualiza view de auto se estiver aberta
    if(g("#v-auto")&&!g("#v-auto").classList.contains("gone")){
      loadAutoView();
    }
    toast("✅ Perfil salvo com sucesso!","g");
  }catch(e){
    toast(_peSessionMsg("Erro",e),"r");
  }finally{
    if(saveBtn){saveBtn.disabled=false;saveBtn.innerHTML='<i class="ti ti-check"></i> Salvar Perfil';}
  }
}

async function deleteProfile(id){
  if(!id||!confirm("Excluir este perfil? Esta ação não pode ser desfeita."))return;
  try{
    await fetch("/api/profiles/delete",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
    UPROFILES=UPROFILES.filter(p=>p.id!==id);U.profiles=UPROFILES;
    closeProfileEditor();renderProfiles();toast("Perfil excluído","g");
  }catch(e){toast("Erro: "+e.message,"r");}
}

// v18-FIX: duplicateProfile() removida — no sistema de perfil único (1 por
// pessoa), o backend (/api/profiles/save) sempre reaproveita o id do perfil
// existente, então "duplicar" só renomeava o próprio perfil da pessoa e
// mostrava um falso "Perfil duplicado ✓". Não existe mais esse conceito.

async function toggleProfileStatus(id){
  const p=UPROFILES.find(x=>x.id===id);if(!p)return;
  try{
    // v21: endpoint dedicado — o save exigia mínimo de 3 assuntos/corpos e
    // impedia até DESATIVAR um perfil legado incompleto
    const r=await fetch("/api/profiles/toggle",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,active:p.active===false})});
    const d=await jsonSafe(r);if(!d.ok)throw new Error(d.error);
    const idx=UPROFILES.findIndex(x=>x.id===d.profile.id);
    if(idx>=0)UPROFILES[idx]=d.profile;U.profiles=UPROFILES;
    renderProfiles();toast(d.profile.active?"Perfil ativado ✓":"Perfil desativado","g");
  }catch(e){toast("Erro: "+e.message,"r");}
}

// Intercepta quando o picker de templates seleciona para usar no perfil
const _origPickTemplate=typeof pickTemplate==="function"?pickTemplate:null;
// v18-FIX: pickTemplateForProfile() removida — era outro caminho (órfão, sem
// botão chamando) que despejava um corpo de e-mail ENLATADO direto no perfil,
// o oposto do que foi pedido: perfil só com texto escrito pela própria pessoa.

// v18-FIX: useMyTpl() removida — escrevia num elemento #af-body que nem
// existe mais no HTML (sobra do wizard de automático pré-redesign) e caía no
// boilerplate DEFAULT_BODY como fallback.

// v167 (auditoria 08/09/2026): openModalFromHist() removida — código morto,
// zero callers no repo inteiro (o botão real de "Candidatar-se" usa
// openModal(jobId), que já escolhe o perfil certo por tipo de visto via
// applyModalProfileById). Além de morta, tinha um bug congelado (usava
// sempre UPROFILES[0], sem checar o tipo de visto da vaga) que teria
// reintroduzido a classe de bug "perfil errado" se algum dia fosse religada.

function updHistBadge(){const n=HIST.length;const b=g("#sib-hist");if(b){b.style.display=n?"":"none";b.textContent=String(n);}const bd=g("#bnd-hist");if(bd)bd.style.display=n?"block":"none";}

async function doClearHist(ovEl){
  ovEl?.remove();
  APPLIED.clear();HIST=[];
  updHistBadge();
  // v38-FIX (caça ativa, 22/07): o reset limpava o SERVIDOR e os cards
  // visíveis, mas DEIXAVA os conjuntos de bloqueio da sessão — _empSent
  // (por e-mail do empregador, usado pela varredura e pelo modal) e
  // _sentAll/_sentJan/_sentJul/_sentSeasonal (por número da vaga, usados
  // pelo filtro da lista). Resultado real: logo após resetar, as vagas
  // voltavam… e SUMIAM de novo na primeira varredura, ou bloqueavam no
  // clique — o CONTRÁRIO da regra ("resetou, tudo volta"). Agora o reset
  // zera os conjuntos locais, espera o servidor limpar e re-sincroniza.
  _empSent=new Set();
  _sentAll=new Set();_sentJan=new Set();_sentJul=new Set();_sentSeasonal=new Set();
  window._sheetAvail={}; // contagens pessoais do wizard recalculam do zero
  sCache={}; // detalhes cacheados podem re-mostrar sem medo — servidor decide
  // Faz todas as vagas reaparecerem na lista
  document.querySelectorAll(".jcard").forEach(c=>{
    if(c.style.display==="none"||c.classList.contains("applied")){
      c.style.display="";c.style.opacity="1";c.classList.remove("applied");
    }
  });
  // Atualiza contador da planilha
  updSheetCounter();
  toast("Resetado — todas as vagas voltaram à lista ✓","g");
  try{await fetch("/api/history/clear",{method:"POST",credentials:"include"});}catch{}
  // Re-sincroniza com o servidor JÁ LIMPO (a fila do automático, se existir,
  // CONTINUA bloqueando — correto: ela ainda vai enviar) e recarrega a lista
  // pra paginação/contagem virem do servidor sem os cortes antigos.
  try{if(typeof loadEmpregadoresBloqueados==="function")loadEmpregadoresBloqueados();}catch{}
  try{if(typeof _loadSentIds==="function"){_sentLoaded=false;_loadSentIds();}}catch{}
  try{if(typeof tab!=="undefined"&&tab!=="seasonal"){sSkip=0;sDone=false;sJobs=[];loadSheetMeta(true);}}catch{}
}

// 🔄 Reset direto da aba AUTOMÁTICO (dono, 18/07/2026): cliente no WhatsApp
// não achava o reset — ele ficava só na aba Enviados. Mesmo fluxo/endpoint
// (/api/history/clear: limpa histórico + trava anti-duplicata DB_SENT), com
// confirmação explicando o efeito: TODAS as empresas ficam liberadas para
// receber de novo e a fila do automático volta a encher.
function confirmResetAuto(){
  const n=HIST.length;
  const ov=document.createElement("div");
  ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)";
  ov.innerHTML=`<div style="background:#fff;border-radius:18px;padding:24px;max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);animation:fadeScale .18s ease">
    <div style="font-size:32px;text-align:center;margin-bottom:8px">🔄</div>
    <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:6px;color:#0f172a">Resetar enviados do automático?</div>
    <div style="font-size:13px;color:#475569;text-align:center;margin-bottom:10px;line-height:1.6">${n?`Remove <strong>${n} candidatura${n!==1?"s":""}</strong> do histórico e libera`:`Libera`} <strong>todas as empresas</strong> para receber de novo — a fila do automático volta a encher.</div>
    <div style="background:#fef9c3;border:1.5px solid #fde047;border-radius:10px;padding:10px 12px;font-size:12px;color:#713f12;margin-bottom:16px;display:flex;align-items:flex-start;gap:7px"><i class="ti ti-alert-triangle" style="flex-shrink:0;margin-top:1px"></i><span>O automático poderá <strong>enviar de novo para as mesmas empresas</strong>. Use quando a fila zerou e você quer se recandidatar a tudo.</span></div>
    <div style="display:flex;gap:8px">
      <button onclick="this.closest('div[style]').remove()" class="btn btn-secondary" style="flex:1">Cancelar</button>
      <button onclick="doResetAuto(this.closest('div[style]'))" class="btn btn-danger" style="flex:2"><i class="ti ti-refresh"></i> Sim, resetar</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click",e=>{if(e.target===ov)ov.remove();});
}
async function doResetAuto(ovEl){
  await doClearHist(ovEl);
  toast("Agora toque em 🤖 Começar Envio Automático para recomeçar a fila","g");
}

// ═══════════════════════════════════════════
//  ENVIADAS — lista + Reset (mesmo endpoint/motor do reset acima:
//  /api/history/clear via doClearHist, nunca uma 2ª lógica)
// ═══════════════════════════════════════════
let _histTab="all";
function setHistTab(tab){
  _histTab=tab;
  ["all","manual","auto"].forEach(t=>{const b=g("#ht-"+t);if(b)b.classList.toggle("on",t===tab);});
  renderHist();
}
function confirmClearHist(){
  const n=HIST.length;
  const ov=document.createElement("div");
  ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)";
  ov.innerHTML=`<div style="background:#fff;border-radius:18px;padding:24px;max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);animation:fadeScale .18s ease">
    <div style="font-size:32px;text-align:center;margin-bottom:8px">🔄</div>
    <div style="font-size:17px;font-weight:800;text-align:center;margin-bottom:6px;color:#0f172a">Resetar candidaturas enviadas?</div>
    <div style="font-size:13px;color:#475569;text-align:center;margin-bottom:10px;line-height:1.6">${n?`Apaga <strong>${n} candidatura${n!==1?"s":""}</strong> do seu histórico e`:`Apaga o histórico e`} libera <strong>todas as vagas</strong> pra você se candidatar de novo.</div>
    <div style="background:#fef9c3;border:1.5px solid #fde047;border-radius:10px;padding:10px 12px;font-size:12px;color:#713f12;margin-bottom:16px;display:flex;align-items:flex-start;gap:7px"><i class="ti ti-alert-triangle" style="flex-shrink:0;margin-top:1px"></i><span>Use quando quiser recomeçar do zero (ex.: nova temporada). Não dá pra desfazer.</span></div>
    <div style="display:flex;gap:8px">
      <button onclick="this.closest('div[style]').remove()" class="btn btn-secondary" style="flex:1">Cancelar</button>
      <button onclick="doClearHist(this.closest('div[style]')).then(()=>renderHist())" class="btn btn-danger" style="flex:2"><i class="ti ti-refresh"></i> Sim, resetar</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click",e=>{if(e.target===ov)ov.remove();});
}
function renderHist(){
  const box=g("#hist-list");if(!box)return;
  const q=(g("#hist-search")?.value||"").trim().toLowerCase();
  let items=HIST.filter(h=>_histTab==="all"||h.type===_histTab);
  if(q)items=items.filter(h=>(h.company||"").toLowerCase().includes(q)||(h.job||"").toLowerCase().includes(q)||(h.to||"").toLowerCase().includes(q));
  const sum=g("#hist-summary");
  if(sum)sum.textContent=items.length?`${items.length} candidatura${items.length!==1?"s":""}`+(q||_histTab!=="all"?" encontrada"+(items.length!==1?"s":""):"")+".":"";
  if(!items.length){
    box.innerHTML=`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;gap:12px;text-align:center;color:var(--t3)">
      <i class="ti ti-send" style="font-size:40px;opacity:.35"></i>
      <div style="font-size:14px;font-weight:700;color:var(--text)">Nenhuma candidatura ainda</div>
      <div style="font-size:12.5px;line-height:1.5">Suas candidaturas enviadas (manuais e automáticas) aparecem aqui.</div>
    </div>`;
    return;
  }
  box.innerHTML=items.map(h=>{
    const isAuto=h.type==="auto";
    return `<div style="display:flex;align-items:center;gap:11px;padding:11px 4px;border-bottom:1px solid var(--border)">
      <div style="width:36px;height:36px;border-radius:10px;background:${isAuto?"var(--purplel,#ede9fe)":"var(--bluel,#dbeafe)"};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${isAuto?"🤖":"✈️"}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.job||"–")}</div>
        <div style="font-size:11.5px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.company||"")}${h.to?" · "+esc(h.to):""}</div>
      </div>
      <div style="font-size:10.5px;color:var(--t3);white-space:nowrap;flex-shrink:0">${esc(h.date||"")}</div>
    </div>`;
  }).join("");
}

// ═══════════════════════════════════════════
//  LOGS AUTOMÁTICO
// ═══════════════════════════════════════════
let allLogsData=[];
async function loadLogs(reset=true){
  if(reset){logSkip=0;logDone=false;allLogsData=[];}
  if(logDone)return;
  const status=g("#log-status")?.value||"";const category=g("#log-category")?.value||"";const q=g("#log-q")?.value||"";
  try{
    const p=new URLSearchParams({skip:logSkip,top:LOG_PAGE});if(status)p.append("status",status);if(category)p.append("category",category);if(q)p.append("q",q);
    const r=await fetch("/api/auto-logs?"+p,{credentials:"include"});const d=await r.json();
    allLogsData=[...allLogsData,...(d.logs||[])];logTotal=d.total||0;logSkip+=d.logs?.length||0;
    if(!d.logs?.length||logSkip>=logTotal)logDone=true;
    renderLogs();updateLogStats();
    const lm=g("#log-more");if(lm)lm.style.display=!logDone&&logTotal>logSkip?"block":"none";
  }catch(e){const el=g("#log-list");if(el)el.innerHTML=`<div style="padding:20px;text-align:center;color:var(--red)">Erro ao carregar logs</div>`;}
}
function loadMoreLogs(){loadLogs(false);}

function renderLogs(){
  const el=g("#log-list");if(!el)return;
  if(!allLogsData.length){el.innerHTML='<div class="empty-state" style="padding:28px 0"><i class="ti ti-list-details"></i><div style="font-size:14px;font-weight:600;color:var(--t2)">'+esc(t('logs_none'))+'</div><div style="font-size:13px;color:var(--t3)">'+esc(t('logs_none_s'))+'</div></div>';return;}
  const emojis={enviado:"✅",falhou:"❌",duplicado:"🔁",pausado:"⏸",cancelado:"🚫",sistema:"ℹ️",pulado:"⏭",limite:"📊",erro_anexo:"📎"};
  el.innerHTML=allLogsData.map((l,i)=>{
    const statusClass="ls-"+(l.status||"sistema").replace(/[^a-z]/g,"");
    const em=emojis[l.status]||"•";
    const hora=l.hour||(l.date||"").split(" ")[1]||"";
    const dataStr=(l.date||"").split(" ")[0]||"";
    const senderShort=l.senderEmail?(l.senderEmail.split("@")[0]):"";
    const wage=l.wage&&l.wage!=="–"?l.wage:"";
    const local=[l.city,l.state].filter(Boolean).join(", ");
    const perfil=l.profileUsed||"";
    const assunto=l.subjectUsed||"";
    const horaColor=l.status==="enviado"?"var(--green)":l.status==="falhou"?"var(--red)":l.status==="duplicado"?"var(--amber)":"var(--t3)";
    return`<div class="log-entry" onclick="openLogDetail(${i})" style="padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer" role="button" tabindex="0">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span class="log-status ${statusClass}" style="flex-shrink:0;margin-top:1px">${em} ${esc(l.status||"–")}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px">
            <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.company||l.jobTitle||"–")}</div>
            <div style="font-size:10px;color:${horaColor};white-space:nowrap;flex-shrink:0;font-weight:700">${dataStr?dataStr+" ":""}<span style="color:${horaColor}">${hora}</span></div>
          </div>
          ${(l.jobTitle&&l.jobTitle!==l.company)?`<div style="font-size:11px;color:var(--t2);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-briefcase" style="font-size:10px"></i> ${esc(l.jobTitle)}</div>`:""}
          ${l.to?`<div style="font-size:11px;color:var(--blue);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-mail" style="font-size:10px"></i> ${esc(l.to)}</div>`:""}
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
            ${senderShort?`<span style="background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.25);border-radius:8px;padding:1px 6px;font-size:10px;font-weight:700;color:#7c3aed"><i class="ti ti-send" style="font-size:9px"></i> ${esc(senderShort)}</span>`:""}
            ${local?`<span style="background:rgba(37,99,235,.1);border:1px solid rgba(37,99,235,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--blue)"><i class="ti ti-map-pin" style="font-size:9px"></i> ${esc(local)}</span>`:""}
            ${wage?`<span style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--green);font-weight:700">${esc(wage)}</span>`:""}
            ${l.category&&l.category!=="other"?`<span style="background:var(--sf2);border:1px solid var(--border);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--t2)">${esc(l.category)}</span>`:""}
            ${l.source?`<span style="background:rgba(37,99,235,.08);border:1px solid rgba(37,99,235,.18);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--blue)">${esc(l.source)}</span>`:""}
            ${perfil?`<span style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:#d97706">📋 ${esc(perfil.slice(0,18))}</span>`:""}
            ${l.attachCount>0?`<span style="background:var(--sf2);border:1px solid var(--border);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--t2)">📎 ${l.attachCount}</span>`:""}
            ${l.attempt>1?`<span style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--red)">tentativa ${l.attempt}</span>`:""}
            ${l.caseNum?`<span style="background:var(--sf2);border:1px solid var(--border);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--t3);font-family:monospace">${esc(l.caseNum.slice(0,14))}</span>`:""}
          </div>
          ${assunto?`<div style="font-size:10px;color:var(--t3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-quote" style="font-size:9px"></i> ${esc(assunto.slice(0,70))}${assunto.length>70?"…":""}</div>`:""}
          ${l.error?`<div style="font-size:11px;color:var(--red);margin-top:3px;line-height:1.4"><i class="ti ti-alert-circle" style="font-size:10px"></i> ${esc(l.error.slice(0,150))}</div>`:""}
        </div>
      </div>
    </div>`;
  }).join("");
}

function openLogDetail(idx){ _openLogDetailImpl(allLogsData[idx]); }
let _recentLogsData=[];
function openRecentLogDetail(idx){ _openLogDetailImpl(_recentLogsData[idx]); }
function _openLogDetailImpl(l){
  if(!l)return;
  const emojis={enviado:"✅",falhou:"❌",duplicado:"🔁",pausado:"⏸",cancelado:"🚫",sistema:"ℹ️",pulado:"⏭",limite:"📊",erro_anexo:"📎"};
  const em=emojis[l.status]||"•";
  g("#ld-title").textContent=em+" "+(l.jobTitle||l.company||"Detalhes do envio");
  g("#ld-company").textContent=l.company||"–";
  const local=[l.city,l.state].filter(Boolean).join(", ");
  const rows=[
    ["Status", (l.status||"–")],
    ["Data/hora", [(l.date||"").split(" ")[0],l.hour||(l.date||"").split(" ")[1]].filter(Boolean).join(" · ")],
    ["Vaga", l.jobTitle||""],
    ["Empresa", l.company||""],
    ["E-mail destino", l.to||""],
    ["Enviado por (Gmail)", l.senderEmail||""],
    ["Localização", local],
    ["Salário", l.wage&&l.wage!=="–"?l.wage:""],
    ["Categoria", l.category&&l.category!=="other"?l.category:""],
    ["Fonte da planilha", l.source||""],
    ["Perfil de currículo usado", l.profileUsed||""],
    ["Assunto do e-mail", l.subjectUsed||""],
    ["Anexos", l.attachCount?String(l.attachCount):""],
    ["Nº de tentativas", l.attempt?String(l.attempt):""],
    ["Case number (DOL)", l.caseNum||""],
    ["ID interno", l.appId||""],
  ].filter(([,v])=>v);
  let html=rows.map(([k,v])=>`
    <div style="display:flex;flex-direction:column;gap:2px;padding-bottom:8px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;color:var(--t3);font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(k)}</div>
      <div style="font-size:13px;color:var(--text);word-break:break-word">${esc(String(v))}</div>
    </div>`).join("");
  if(l.error){
    html+=`<div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:10px;padding:10px 12px">
      <div style="font-size:10px;color:var(--red);font-weight:700;text-transform:uppercase;margin-bottom:3px">Detalhe do erro</div>
      <div style="font-size:13px;color:var(--text);line-height:1.4">${esc(l.error)}</div>
    </div>`;
  }
  g("#ld-body").innerHTML=html||'<div style="color:var(--t3);font-size:13px">Sem detalhes adicionais.</div>';
  g("#log-detail-overlay").style.display="flex";
}
function closeLogDetail(){const ov=g("#log-detail-overlay");if(ov)ov.style.display="none";}

function updateLogStats(){
  const logs=allLogsData;
  const sent=logs.filter(l=>l.status==="enviado").length;
  const failed=logs.filter(l=>l.status==="falhou").length;
  const dup=logs.filter(l=>l.status==="duplicado").length;
  const skip=logs.filter(l=>l.status==="pulado").length;
  const rate=sent+failed>0?Math.round(sent/(sent+failed)*100):0;
  const s=g("#log-stat-sent");const f=g("#log-stat-failed");const d=g("#log-stat-dup");const sk=g("#log-stat-skip");const rr=g("#log-stat-rate");
  if(s)s.textContent=sent;if(f)f.textContent=failed;if(d)d.textContent=dup;if(sk)sk.textContent=skip;
  if(rr){rr.textContent=rate+"%";rr.style.color=rate>=80?"var(--green)":rate>=50?"var(--amber)":"var(--red)";}
  const sb=g("#sib-logs");if(sb&&failed>0){sb.style.display="";sb.textContent=String(failed);}
}

async function exportLogs(){
  try{const r=await fetch("/api/auto-logs/export",{credentials:"include"});const blob=await r.blob();const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="h2b_logs_"+new Date().toISOString().slice(0,10)+".csv";a.click();toast("CSV exportado ✓","g");}catch(e){toast("Erro: "+e.message,"r");}
}
async function clearLogs(){if(!confirm("Limpar todos os logs?"))return;try{const r=await fetch("/api/auto-logs",{method:"DELETE",credentials:"include"});const d=await r.json();if(d.ok){allLogsData=[];renderLogs();updateLogStats();toast("Logs limpos","r");}else throw new Error(d.error);}catch(e){toast("Erro: "+e.message,"r");}}

// ═══════════════════════════════════════════
//  AUTO SEND — WIZARD
// ═══════════════════════════════════════════
function loadAutoView(){
  updateAutoUI();_updateAutoFreeBanner();buildAutoDocSlots();
  loadTabCounts();
  if(autoSelectedSrc)renderWizardCats(autoSelectedSrc);
  recalcInterval();
  // Renderiza painel de perfis no topo da view auto
  _renderAutoProfilesPanel();
}

// Painel de perfis — compacto, dentro do modal auto
let _autoPanelExpanded=false;

async function _renderAutoProfilesPanel(){
  const panel=g("#auto-profiles-panel");if(!panel)return;
  // Sempre busca perfis frescos do servidor
  try{
    const pr=await fetch("/api/profiles",{credentials:"include"}).then(r=>r.json());
    UPROFILES=pr.profiles||[];
    if(U)U.profiles=UPROFILES;
  }catch(e){console.warn("[_renderAutoProfilesPanel] falha ao buscar perfis:",e.message);}
  const profiles=UPROFILES.filter(p=>p.active!==false);

  if(!profiles.length){
    panel.innerHTML=`<div style="background:var(--redl);border:1.5px solid var(--redb);border-radius:var(--r);padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px">
      <i class="ti ti-alert-triangle" style="font-size:18px;color:var(--red);flex-shrink:0"></i>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:800;color:var(--red)">Nenhum perfil criado</div>
        <div style="font-size:11px;color:var(--red);opacity:.8">Crie um perfil antes de iniciar o envio automático</div>
      </div>
      <button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="closeAutoModal();sv('profile');setTimeout(()=>{switchProfileTab('profiles');setTimeout(openProfileEditor,200)},100)">
        <i class="ti ti-plus"></i> Criar
      </button>
    </div>`;
    return;
  }

  const hasGeneral=true; // conceito de perfil geral removido — todo perfil serve para qualquer vaga
  const names=profiles.slice(0,3).map(p=>p.name).join(", ")+(profiles.length>3?` +${profiles.length-3}`:"");

  panel.innerHTML=`
    <div style="background:var(--surface);border:1.5px solid ${hasGeneral?"var(--border)":"var(--amberb)"};border-radius:var(--r);margin-bottom:10px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer" onclick="_toggleAutoPanel()">
        <i class="ti ti-user-circle" style="font-size:16px;color:${hasGeneral?"var(--green)":"var(--amber)"}"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${hasGeneral?"✅":"⚠️"} ${profiles.length} perfil(s): ${esc(names)}
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button onclick="event.stopPropagation();closeAutoModal();sv('profile');setTimeout(()=>switchProfileTab('profiles'),100)" class="btn btn-xs btn-secondary" style="padding:3px 8px;font-size:10px"><i class="ti ti-settings"></i></button>
          <i class="ti ti-chevron-${_autoPanelExpanded?"up":"down"}" id="auto-panel-chevron" style="font-size:14px;color:var(--t3)"></i>
        </div>
      </div>
      <div id="auto-panel-detail" style="display:${_autoPanelExpanded?"block":"none"};border-top:1px solid var(--border);padding:10px 12px">
        ${profiles.map(p=>{
          const ok=(p.subjects?.length>0||p.subject)&&(p.emailBodies?.length>0||p.body);
          const icon=p.icon||"🎯";
          const cats=(p.categories||[]).slice(0,2).join(", ")||"Todas";
          return`<div style="display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px">
            <span>${icon}</span>
            <div style="flex:1;min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div><div style="color:var(--t3)">${cats}</div></div>
            <i class="ti ${ok?"ti-check":"ti-alert-triangle"}" style="color:${ok?"var(--green)":"var(--amber)"};font-size:13px"></i>
          </div>`;
        }).join("")}
        <button class="btn btn-secondary btn-sm w100" style="margin-top:8px" onclick="closeAutoModal();sv('profile');setTimeout(()=>{switchProfileTab('profiles');setTimeout(()=>openProfileEditor('${profiles[0]?.id||""}'),200)},100)"><i class="ti ti-edit"></i> Editar Perfil</button>
      </div>
    </div>`;
}

function _toggleAutoPanel(){
  _autoPanelExpanded=!_autoPanelExpanded;
  const det=g("#auto-panel-detail");const chev=g("#auto-panel-chevron");
  if(det)det.style.display=_autoPanelExpanded?"block":"none";
  if(chev){chev.classList.toggle("ti-chevron-down",!_autoPanelExpanded);chev.classList.toggle("ti-chevron-up",_autoPanelExpanded);}
}


function buildAutoDocSlots(){
  // Inicializa com o resume padrão se ainda não selecionado
  if(autoResIdx===null&&activeResIdx!==null) autoResIdx=activeResIdx;
  if(autoCovIdx===null&&activeCovIdx!==null) autoCovIdx=activeCovIdx;
  const res=DOCS.filter(c=>(c.cvType||"resume")==="resume");const cov=DOCS.filter(c=>c.cvType==="cover");
  const mk=(arr,type,curIdx,elId)=>{const el=g(elId);if(!el)return;if(!arr.length){el.innerHTML=`<div style="font-size:12px;color:var(--t3);padding:6px 0">Nenhum ${type==="resume"?"resume":"cover letter"}. <span style="color:var(--blue);cursor:pointer;font-weight:600" onclick="sv('profile')">Adicionar →</span></div>`;return;}el.innerHTML=[`<label class="cv-slot${curIdx===null?" sel":""}"><input type="radio" name="a${type}" value="none" ${curIdx===null?"checked":""} style="accent-color:var(--purple)"> Não enviar</label>`,...arr.map(c=>`<label class="cv-slot${curIdx===c.idx?" sel":""}"><input type="radio" name="a${type}" value="${c.idx}" ${curIdx===c.idx?"checked":""} style="accent-color:var(--purple)"><i class="ti ti-${type==="resume"?"file-type-pdf":"file-description"}" style="color:${type==="resume"?"var(--red)":"var(--purple)"}"></i><span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></label>`)].join("");el.querySelectorAll(`input[name='a${type}']`).forEach(r=>r.addEventListener("change",()=>{el.querySelectorAll(".cv-slot").forEach(s=>s.classList.remove("sel"));r.closest(".cv-slot")?.classList.add("sel");if(type==="resume"){autoResIdx=r.value==="none"?null:parseInt(r.value,10);}else{autoCovIdx=r.value==="none"?null:parseInt(r.value,10);}}));};
  mk(res,"resume",activeResIdx,"#af-res-slots");mk(cov,"cover",activeCovIdx,"#af-cov-slots");
}

// ── Planilhas DINÂMICAS: injeta as extras publicadas (ex.: H-2A, Julho) nos
// seletores Manual e Automático, mantendo as fixas. Faz QUALQUER planilha nova
// aparecer sozinha — basta publicar/upar. selectSource já funciona
// genérico com qualquer chave.
// v90 (reestruturação parte 3): mapa chave→nome/emoji de TODAS as planilhas
// (alimentado pelo /api/sheets-list) — o contador de vagas usa isso pra
// mostrar o nome CERTO da planilha ativa (antes era um ternário fixo que
// mostrava "Jul 2025" pra qualquer planilha nova/H-2A/histórica).
let _sheetNameMap={};
function _sheetLabelFor(key){
  const m=_sheetNameMap[key];
  if(m)return `${m.emoji||'📋'} ${m.name}`;
  return key==='jan2026'?'☀️ Jan 2026':key==='jul2025'?'❄️ Jul 2025':(key==='h2a-jun2026'||key==='h2ajun2026')?'🌾 H-2A':String(key||'');
}
async function loadDynamicSheets(){
  try{
    const r=await fetch('/api/sheets-list',{credentials:'include'});
    const d=await r.json();
    if(!d.ok||!Array.isArray(d.sheets))return;
    d.sheets.forEach(s=>{_sheetNameMap[s.key]={name:s.name,emoji:s.emoji};});
    // v-home: total de vagas disponíveis pro card de stats (soma de todas as planilhas)
    window._sheetsTotalCount=d.sheets.reduce((a,s)=>a+(s.count||0),0);
    const sjEl=document.getElementById('home-stat-jobs');
    if(sjEl)sjEl.textContent=window._sheetsTotalCount.toLocaleString('pt-BR');
    // Contagem PESSOAL nos botões fixos do Automático (jan/jul/h2a):
    // mostra o que AINDA dá pra enviar (desconta o que o usuário já enviou),
    // em vez do total bruto da planilha que confundia ("já enviei 2.200, por
    // que ainda aparece tudo?").
    const _srcCntHtml=(s)=>{
      if(typeof s.available!=='number') return (s.count||0).toLocaleString('pt-BR')+' vagas';
      // v94: "0 disponíveis" em verde era sinal trocado. Dois casos distintos:
      // planilha SEM contatos ainda (governo não liberou) → âmbar honesto;
      // usuário já enviou pra todas → verde de conquista.
      if(s.available===0){
        if((s.withEmail||0)===0) return `<span style="color:#d97706;font-weight:700">⏳ contatos em breve</span><br><span style="font-size:9.5px;opacity:.75">${(s.count||0).toLocaleString('pt-BR')} vagas aguardando o governo liberar os e-mails</span>`;
        if(s.sent>0) return `<span style="color:var(--green);font-weight:700">✅ você já enviou pra todas!</span><br><span style="font-size:9.5px;opacity:.75">${s.sent.toLocaleString('pt-BR')} enviadas de ${(s.count||0).toLocaleString('pt-BR')}</span>`;
      }
      const disp=`<strong style="color:var(--green)">${s.available.toLocaleString('pt-BR')}</strong> disponíveis`;
      return s.sent>0 ? `${disp}<br><span style="font-size:9.5px;opacity:.75">✅ ${s.sent.toLocaleString('pt-BR')} já enviadas · ${(s.count||0).toLocaleString('pt-BR')} no total</span>` : disp;
    };
    d.sheets.forEach(s=>{
      const id=s.key==='jan2026'?'src-jan-cnt':s.key==='jul2025'?'src-jul-cnt':s.key==='h2a-jun2026'?'src-h2a-cnt':null;
      if(id){const el=document.getElementById(id);if(el)el.innerHTML=_srcCntHtml(s);}
    });
    // injeta só planilhas que NÃO estão fixas no HTML (jan2026/jul2025/h2a-jun2026 já existem)
    const extras=d.sheets.filter(s=>!['jan2026','jul2025','h2a-jun2026'].includes(s.key));
    if(!extras.length)return;
    // AUTO — #source-btns
    const sb=document.getElementById('source-btns');
    if(sb){
      extras.forEach(s=>{
        if(sb.querySelector(`[data-src="${s.key}"]`))return;
        const visaCor=s.visa==='H-2A'?'#10b981':'#3b82f6';
        const visaBg =s.visa==='H-2A'?'rgba(16,185,129,.18)':'rgba(59,130,246,.18)';
        const btn=document.createElement('button');
        btn.className='source-btn'; btn.dataset.src=s.key;
        btn.setAttribute('onclick',`selectSource('${s.key}')`);
        btn.innerHTML=`<div class="source-btn-icon">${s.emoji||'📋'}</div>`+
          `<div class="source-btn-label"><strong>${s.name}</strong> `+
          `<span style="display:inline-block;font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;background:${visaBg};color:${visaCor};margin-left:3px;vertical-align:middle">${s.visa}</span></div>`+
          `<div class="source-btn-count">${_srcCntHtml(s)}</div>`;
        sb.appendChild(btn);
      });
    }
    // MANUAL — aba principal (.stabs, onde o usuário navega vagas de verdade).
    const stabsRow=document.getElementById('stabs-row');
    if(stabsRow){
      extras.forEach(s=>{
        if(document.getElementById('stab-'+s.key))return; // já existe (evita duplicar)
        const visaIcon=s.visa==='H-2A'?'ti-plant-2':'ti-snowflake';
        const visaCor =s.visa==='H-2A'?'#10b981':'#3b82f6';
        const btn=document.createElement('button');
        btn.className='stab'; btn.id='stab-'+s.key;
        btn.style.marginTop='8px';
        btn.setAttribute('onclick',`setTab('${s.key}')`);
        btn.innerHTML=`<i class="ti ${visaIcon}" style="color:${visaCor}"></i><strong>${s.name}</strong><span class="stab-cnt">${(s.count||0).toLocaleString('pt-BR')}</span>`;
        stabsRow.appendChild(btn);
      });
    }
    // v51 (dono, 25/07): a H-2B mais NOVA (d.sheets[0].latest, decidido pelo
    // servidor) vai pra PRIMEIRA posição (esquerda) e ganha o selo MAIS NOVA
    // em todos os seletores. Quando a lista de janeiro sair, migra sozinho.
    // v94 (reestruturação parte 7): se a mais nova AINDA não tem nenhum
    // contato (recém-saída do governo, "Pending Processing" — 0 emails),
    // recomendá-la engana o usuário: o robô iniciado nela não envia NADA.
    // Nesse estado ela ganha o selo honesto "⏳ EM BREVE" e NÃO rouba a
    // primeira posição; assim que os contatos saírem (withEmail>0), o selo
    // "⭐ MAIS NOVA" e a posição voltam sozinhos.
    const latest=(d.sheets||[]).find(s2=>s2.latest);
    if(latest){
      const prontaPraUso=(latest.withEmail||0)>0;
      const selo=prontaPraUso?'sheet-latest':'sheet-soon';
      const _mkFirst=(el)=>{if(!prontaPraUso)return;if(el&&el.parentElement&&el.parentElement.firstElementChild!==el)el.parentElement.insertBefore(el,el.parentElement.firstElementChild);};
      const bAuto=document.querySelector(`#source-btns [data-src="${latest.key}"]`);
      if(bAuto){bAuto.classList.add(selo);_mkFirst(bAuto);}
      const stab=document.getElementById('stab-'+latest.key)||document.querySelector(`#stabs-row [data-src="${latest.key}"]`);
      if(stab){stab.classList.add(selo);stab.style.marginTop='10px';_mkFirst(stab);}
    }
  }catch(e){
    console.warn('[sheets-list]',e.message);
    // v117 (incidente real, print de usuário 02/08: "não aparece a aba de
    // inverno 2026 no automático"): se o fetch falha (ex.: app aberto no
    // exato momento de um deploy/restart do servidor), a planilha dinâmica
    // sumia do grid e os contadores ficavam em "–" até reabrir o modal.
    // Agora re-tenta sozinho com recuo (8s, 16s... até 5x) — a aba volta
    // assim que o servidor responder, sem o usuário fazer nada.
    window._ldsRetry=(window._ldsRetry||0)+1;
    if(window._ldsRetry<=5)setTimeout(()=>{try{loadDynamicSheets();}catch(_e){}},8000*window._ldsRetry);
  }
}

function selectSource(src){
  autoSelectedSrc=src;autoSelectedCat="all";autoSelectedCats=[];
  // Cargos são por planilha — troca de fonte limpa o filtro de cargos e o snapshot do modal
  afTitles=[];_mfCtxState.auto=null;
  renderAutoFilterChips();_syncAutoFiltersBadge();refreshAutoFilterCount();
  document.querySelectorAll(".source-btn").forEach(b=>b.classList.toggle("sel",b.dataset.src===src));
  // Unlock step 2
  unlockWizardStep(2);
  // Load categories for this source
  renderWizardCats(src);
  // v19: a fonte define o tipo de visto — re-renderiza o Passo 3 pra
  // pré-selecionar o perfil do tipo certo (H-2A ↔ H-2B)
  renderAutoProfileCards();
}

async function renderWizardCats(src){
  const cats=sheetCats[src];if(!cats){
    try{const r=await fetch(`/api/sheet-categories?sheet=${src}`,{credentials:"include"});const d=await r.json();sheetCats[src]=d.categories||[];}catch{sheetCats[src]=[];}
  }
  await _ensureCatLabels();
  // Disponibilidade PESSOAL por categoria (desconta o que este usuário já
  // enviou). Se falhar, cai nos totais globais — nunca quebra o wizard.
  if(!window._sheetAvail) window._sheetAvail={};
  if(!window._sheetAvail[src]){
    try{const r=await fetch(`/api/my-availability?sheet=${src}`,{credentials:"include"});const d=await r.json();if(d.ok)window._sheetAvail[src]=d;}catch{}
  }
  const avail=window._sheetAvail[src]||null;
  const el=g("#auto-cat-chips");if(!el)return;
  const catData=sheetCats[src]||[];
  // cnt(): quantas vagas desta categoria AINDA estão disponíveis pro usuário
  const cnt=(key,globalCount)=>avail?(avail.byCategory[key]||0):globalCount;
  const totalAll=avail?avail.available:catData.reduce((s,c)=>s+c.count,0);
  const groups=window._catGroups||[];
  // Build individual category chips
  const catMap={};catData.forEach(c=>{catMap[c.key]=c;});
  let html=`<button class="cat-chip-sel sel" data-cat="all" onclick="selectCat('all')">🌐 Todos (${totalAll.toLocaleString()})</button>`;
  // Add group chips
  groups.forEach(g_=>{
    const groupTotal=g_.cats.reduce((s,k)=>s+cnt(k,catMap[k]?.count||0),0);
    if(groupTotal>0){
      const catsKey=g_.cats.join(",");
      html+=`<button class="cat-chip-sel cat-chip-group" data-cat="${catsKey}" data-group="${g_.key}" onclick="selectCat('${catsKey}')" style="border-color:${g_.color}22;background:${g_.color}11;color:${g_.color}">${g_.label} <span style="opacity:.7;font-size:10px">(${groupTotal.toLocaleString()})</span></button>`;
    }
  });
  // Add individual chips (categorias 100% já enviadas somem — não tem o que enviar nelas)
  catData.forEach(c=>{
    const n=cnt(c.key,c.count);
    if(avail&&n<=0)return;
    html+=`<button class="cat-chip-sel" data-cat="${c.key}" onclick="selectCat('${c.key}')">${c.label} (${n.toLocaleString()})</button>`;
  });
  // Resumo pessoal: quanto já foi enviado dessa fonte
  if(avail&&avail.sent>0){
    html+=`<div style="flex-basis:100%;font-size:11px;color:var(--t3);padding-top:4px">✅ Você já enviou para <strong>${avail.sent.toLocaleString()}</strong> empresa(s) desta fonte — elas não entram na fila de novo.</div>`;
  }
  el.innerHTML=html;
  // Reapply selection
  document.querySelectorAll("#auto-cat-chips .cat-chip-sel").forEach(b=>b.classList.toggle("sel",b.dataset.cat===autoSelectedCat));
  unlockWizardStep(25);renderAutoProfileCards();
}

function selectCat(cat){
  if(cat==="all"){
    // "Todos" limpa a seleção
    autoSelectedCats=[];
    autoSelectedCat="all";
  } else {
    // Toggle neste chip
    const idx=autoSelectedCats.indexOf(cat);
    if(idx>=0){autoSelectedCats.splice(idx,1);}
    else{autoSelectedCats.push(cat);}
    autoSelectedCat=autoSelectedCats.length===0?"all":autoSelectedCats.join(",");
  }
  // Atualiza visuais dos chips
  document.querySelectorAll("#auto-cat-chips .cat-chip-sel").forEach(b=>{
    if(b.dataset.cat==="all"){
      b.classList.toggle("sel", autoSelectedCats.length===0);
    } else {
      b.classList.toggle("sel", autoSelectedCats.includes(b.dataset.cat));
    }
  });
  // Mostra lista acumulativa
  renderCatSelectedList();
  updateFilterCount();refreshAutoFilterCount();
  // Aviso de categoria ativa
  const warn=g("#af-cat-warning");const warnLbl=g("#af-cat-warning-label");
  if(warn&&warnLbl){
    if(autoSelectedCats.length>0){
      warn.style.display="flex";
      warnLbl.textContent=autoSelectedCats.join(", ");
    } else {
      warn.style.display="none";
    }
  }
}

function renderCatSelectedList(){
  let box=g("#auto-cat-selected-list");
  if(!box){
    const wrap=g("#auto-cat-chips")?.parentElement;
    if(wrap){
      box=document.createElement("div");
      box.id="auto-cat-selected-list";
      box.style.cssText="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;";
      wrap.appendChild(box);
    }
  }
  if(!box)return;
  if(autoSelectedCats.length===0){box.innerHTML="";return;}
  const catLabels=window._catLabels||{};
  box.innerHTML=`<span style="font-size:11px;color:var(--t2);font-weight:600;align-self:center">Selecionadas:</span>`+
    autoSelectedCats.map(c=>{
      const lbl=catLabels[c]?.label||c;
      return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--purplel);border:1px solid var(--purpleb);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:var(--purple)">
        ${esc(lbl)} <button onclick="selectCat('${c}')" style="background:none;border:none;cursor:pointer;color:var(--purple);padding:0;line-height:1;font-size:13px;font-weight:800;margin-left:2px">×</button>
      </span>`;
    }).join("")+
    `<button onclick="selectCat('all')" style="background:var(--sf2);border:1px solid var(--border2);border-radius:20px;padding:3px 10px;font-size:11px;color:var(--t3);cursor:pointer;font-family:inherit">Limpar tudo</button>`;
}

function unlockWizardStep(n){
  const ws=g("#ws-"+n);if(ws)ws.classList.remove("locked");
  const wn=g("#ws-n-"+n);if(wn){wn.className="wizard-step-n active";}
}

// useMyTpl definida acima

function setQuickWage(v){
  const inp=g("#af-min-wage");const slider=g("#af-wage-slider");const lbl=g("#af-slider-val");
  if(inp)inp.value=v||"";
  if(slider)slider.value=v||0;
  if(lbl)lbl.textContent=v?"$"+v+"/h":"$0/h";
  ["0","15","18","20","25"].forEach(x=>{
    const b=g("#wq-"+x);
    if(b){b.style.background=String(v)===x||(x==="0"&&!v)?"var(--purplel)":"var(--sf2)";
    b.style.borderColor=String(v)===x||(x==="0"&&!v)?"var(--purpleb)":"var(--border2)";
    b.style.color=String(v)===x||(x==="0"&&!v)?"var(--purple)":"var(--t2)";}
  });
  updateFilterCount?.();
}
function syncWageSlider(val){
  const inp=document.getElementById('af-min-wage');if(inp)inp.value=val>0?val:'';
  updateFilterCount();
}

async function updateFilterCount(){
  const minWage=parseFloat(document.getElementById('af-min-wage')?.value||'0')||0;
  const slider=document.getElementById('af-wage-slider');if(slider)slider.value=minWage||0;
  const badge=document.getElementById('af-wage-count-badge'),feedback=document.getElementById('af-wage-feedback');
  if(!autoSelectedSrc){if(badge)badge.style.display='none';if(feedback)feedback.style.display='none';return;}
  if(minWage>0){
    try{
      const state=document.getElementById('af-state')?.value||'';
      const hasEmail=document.getElementById('af-has-email')?.value||'';
      // IMPORTANTE: buscar SEMPRE sem filtro de categoria para mostrar total real
      // O filtro de categoria reduz demais — usuário precisa ver o universo real
      const cityVal=document.getElementById('af-city')?.value.trim()||'';
      const minWorkersVal=parseInt(document.getElementById('af-min-workers')?.value||'0')||0;
      const rAll=await fetch('/api/count-jobs?sheet='+autoSelectedSrc+'&minWage='+minWage+'&state='+encodeURIComponent(state)+'&hasEmail='+hasEmail+(cityVal?'&city='+encodeURIComponent(cityVal):''),{credentials:'include'});
      const dAll=await rAll.json();
      // Se tem categoria selecionada, busca também o total da categoria
      const cat=autoSelectedCat||'all';
      let filteredCat=dAll.filtered||0;
      if(cat&&cat!=='all'){
        const rCat=await fetch('/api/count-jobs?sheet='+autoSelectedSrc+'&minWage='+minWage+'&state='+encodeURIComponent(state)+'&category='+cat+'&hasEmail='+hasEmail+(cityVal?'&city='+encodeURIComponent(cityVal):''),{credentials:'include'});
        const dCat=await rCat.json();
        filteredCat=dCat.filtered||0;
      }
      const totalGeral=dAll.total||0;
      const filteredGeral=dAll.filtered||0;
      if(badge){
        badge.style.display='flex';
        badge.textContent=filteredGeral.toLocaleString()+' vagas acima de $'+minWage.toFixed(0)+'/h';
      }
      if(feedback){
        feedback.style.display='block';
        const tot=document.getElementById('af-total-count'),cnt=document.getElementById('af-wage-count'),thr=document.getElementById('af-wage-threshold');
        if(tot)tot.textContent=totalGeral.toLocaleString();
        if(cnt)cnt.textContent=filteredGeral.toLocaleString();
        if(thr)thr.textContent='$'+minWage.toFixed(2);
        // Se tem categoria selecionada, mostrar também o filtro por categoria
        const extra=document.getElementById('af-wage-feedback');
        if(extra&&cat&&cat!=='all'&&filteredCat!==filteredGeral){
          extra.innerHTML='Das <strong id="af-total-count">'+totalGeral.toLocaleString()+'</strong> vagas totais, <strong id="af-wage-count" style="color:var(--green)">'+filteredGeral.toLocaleString()+'</strong> têm salário acima de <strong id="af-wage-threshold">$'+minWage.toFixed(2)+'</strong>/h · <span style="color:var(--blue)">'+filteredCat.toLocaleString()+' na categoria selecionada</span>';
        }
      }
    }catch(e){if(badge)badge.style.display='none';if(feedback)feedback.style.display='none';}
  }else{if(badge)badge.style.display='none';if(feedback)feedback.style.display='none';}
}

// ── recalcInterval: mostra previsão correta de 5-6 min ──────────
function recalcInterval(){
  // 🎯 v172b (ordem do dono, 12/09/2026): admin não é mais "sem limite" —
  // 450/dia por e-mail conectado, com o padrão de intervalo em 5min (300s).
  // U.autoLimit já vem do servidor somando 450 por sender (getAutoLimit).
  const autoLimit=U.isAdmin?(U.autoLimit||450):(U.autoLimit||10);
  const el=g("#interval-main"),sub=g("#interval-sub");
  if(U.isAdmin){
    const extraSenders=(U.senderEmails||[]).filter(s=>s&&s.active!==false&&!s.tokenExpired&&!s.blocked).length;
    const activeSenders=Math.min(6,Math.max(1,1+extraSenders));
    const baseSecs=U.adminSettings?.intervalSecs||300;
    const secs=Math.round(baseSecs/activeSenders);
    const mins=Math.floor(secs/60);const secsR=secs%60;
    const intLbl=mins>0?(secsR>0?`${mins}min ${secsR}s`:`${mins}min`):`${secs}s`;
    if(el)el.textContent=`⚡ Admin: 1 e-mail a cada ${intLbl}${activeSenders>1?` (${activeSenders} Gmails revezando)`:""} (configurável)`;
    if(sub)sub.textContent=`Seu limite: ${autoLimit} e-mails/dia (450 por Gmail conectado). Configure o intervalo na aba Admin do Perfil.`;
  } else {
    // Cada Gmail extra conectado (e com token válido) divide o intervalo pela
    // metade — o robô revezar entre as contas, então o ritmo GERAL acelera
    // sem aumentar o risco de bloqueio de nenhuma conta individual (cada
    // conta continua recebendo 1 e-mail a cada 5-6min, só que são 2 contas).
    const extraSenders=(U.senderEmails||[]).filter(s=>s&&s.active!==false&&!s.tokenExpired&&!s.blocked).length;
    const activeSenders=Math.min(3,Math.max(1,1+extraSenders));
    const avgMin=5.5/activeSenders;
    const totalMin=Math.round(autoLimit*avgMin);
    const h=Math.floor(totalMin/60),m=totalMin%60;
    const dur=h>0?(m>0?`${h}h ${m}min`:`${h}h`):`${m}min`;
    if(el)el.textContent=activeSenders>1?`⏱️ 1 e-mail a cada ${(5/activeSenders).toFixed(1)}–${(6/activeSenders).toFixed(1)} minutos (${activeSenders} Gmails revezando)`:"⏱️ 1 e-mail a cada 5–6 minutos";
    if(sub)sub.textContent=`Seu limite: ${autoLimit} e-mails/dia → ~${dur} por dia para concluir`;
  }
}

// ══════════════════════════════════════════════════════
//  MODAL PRÉ-INÍCIO
// ══════════════════════════════════════════════════════
function openPreflightModal(){
  // 🔒 v172 (ORDEM DO DONO, 11/09/2026): "o site vai ser só pra pessoas
  // pagantes usarem" — checagem client-side ANTES do preflight (o servidor
  // recusa de qualquer forma em /api/auto/start, isto é só pra não fazer a
  // pessoa preencher o wizard inteiro pra descobrir na hora H que não pode).
  if(!U.isAdmin&&(U.autoLimit||0)<=0){
    toast("⚠️ Você precisa de um plano com envio automático (VIPro ou DoublePro) pra usar o robô.","r",7000);
    sv("plans");return;
  }
  if(!U.gmailConnected){
    toast("⚠️ Conecte seu Gmail antes de ligar o envio automático.","r",7000);
    connectGmailForSending("auto");return;
  }
  if(!autoSelectedSrc){toast("Escolha a fonte das vagas! (Passo 1)","r");g("#ws-1")?.scrollIntoView({behavior:"smooth"});return;}
  const activeProfiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false);
  if(!activeProfiles.length){toast("Crie pelo menos 1 perfil ativo antes de iniciar!","r");sv('profile');return;}

  const autoLimit=U.autoLimit||10;
  const limit=10000;
  const daysNeeded=Math.ceil(limit/autoLimit);
  // Gmails extras conectados dividem o intervalo (o robô reveza entre contas) —
  // mesma lógica do backend (mod-engine-core.js: createCalcSmartInterval).
  const _extraSenders=(U.senderEmails||[]).filter(s=>s&&s.active!==false&&!s.tokenExpired&&!s.blocked).length;
  const _activeSenders=Math.min(3,Math.max(1,1+_extraSenders));
  const avgMinPf=5.5/_activeSenders;
  const minPerDay=Math.round(autoLimit*avgMinPf);
  const hpd=Math.floor(minPerDay/60),mpd=minPerDay%60;
  const durPerDay=hpd>0?(mpd>0?`${hpd}h${mpd}min`:`${hpd}h`):`${mpd}min`;
  const intervalLbl=_activeSenders>1?`${(5/_activeSenders).toFixed(1)}–${(6/_activeSenders).toFixed(1)} min`:"5–6 min";

  // Contagem HONESTA no lugar do antigo "Auto": disponibilidade PESSOAL da
  // fonte (já buscada no Passo 2 via /api/my-availability). "~" porque os
  // filtros avançados (cargo, estado...) só são aplicados na hora do início.
  const _pfAvail=window._sheetAvail?.[autoSelectedSrc]||null;
  let _pfN=null;
  if(_pfAvail){
    if(autoSelectedCats&&autoSelectedCats.length){
      const _pfKeys=new Set(autoSelectedCats.flatMap(c=>String(c).split(",")));
      _pfN=[..._pfKeys].reduce((s,k)=>s+(_pfAvail.byCategory?.[k]||0),0);
    }else{
      _pfN=_pfAvail.available;
    }
  }
  g("#pf-count").textContent=(_pfN!=null&&isFinite(_pfN))?"~"+_pfN.toLocaleString("pt-BR"):"–";
  g("#pf-duration").textContent=durPerDay;
  if(g("#pf-interval"))g("#pf-interval").textContent=intervalLbl;
  g("#pf-subtitle").textContent=_activeSenders>1?`${autoLimit} e-mails/dia • intervalo ${intervalLbl} (${_activeSenders} Gmails revezando) • servidor sempre ligado`:`${autoLimit} e-mails/dia • intervalo 5–6 min • servidor sempre ligado`;

  // Aviso Gmail com os números REAIS do usuário (limite oficial do Google:
  // 500 e-mails por janela móvel de 24h por conta; exceder repetido pode
  // travar a conta por até 24h — support.google.com/mail/answer/22839)
  const _gw=g("#pf-gmail-warning");
  if(_gw){
    const _perGmail=Math.ceil(autoLimit/_activeSenders);
    _gw.innerHTML=`<strong>⚠️ Limite do Google:</strong> cada Gmail aceita até <strong>500 e-mails por janela de 24h</strong> — insistir acima disso pode travar a conta por 1 dia. Seu automático envia até <strong>${autoLimit}/dia</strong>${_activeSenders>1?` revezando entre <strong>${_activeSenders} Gmails</strong> (~${_perGmail} por conta)`:""}, dentro do limite. Só lembre: envios manuais do mesmo Gmail contam nessa mesma janela.`;
  }

  // Pre-fill horário
  const sh=g("#af-start-h")?.value||"8";
  const eh=g("#af-end-h")?.value||"20";
  if(g("#pf-sh"))g("#pf-sh").value=sh;
  if(g("#pf-eh"))g("#pf-eh").value=eh;


  // REESTRUTURADO: mostra o perfil/currículo ESCOLHIDO no Passo 3
  const profilesList=g("#pf-profiles-list");
  if(profilesList){
    const selP=activeProfiles.find(p=>p.id===autoSelectedProfileId)||activeProfiles.find(p=>p.isFavorite)||activeProfiles[0];
    if(!selP){
      profilesList.innerHTML=`<div style="color:var(--red);font-weight:700;font-size:12px">⚠️ Nenhum perfil ativo! Crie um perfil na aba Perfis.</div>`;
    }else{
      autoSelectedProfileId=selP.id;
      const nSubj=(selP.subjects||[selP.subject]).filter(Boolean).length;
      const nBody=(selP.emailBodies||[selP.body]).filter(Boolean).length;
      const pdf=selP.pdfName?esc(selP.pdfName):(selP.resumeIdx!=null?"currículo vinculado":`<span style="color:var(--red)">⚠️ sem currículo</span>`);
      profilesList.innerHTML=`<div style="display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid #bfdbfe;border-radius:10px;padding:10px 12px">
        <span style="font-size:22px">${selP.icon||"🎯"}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:800;color:#1e3a8a">${esc(selP.name)}${selP.isFavorite?" ⭐":""}</div>
          <div style="font-size:11px;color:#374151;margin-top:1px">📄 ${pdf} · ${nSubj} assunto(s) · ${nBody} corpo(s)</div>
        </div>
        <button onclick="closePreflight()" style="background:none;border:1px solid #bfdbfe;border-radius:8px;color:#1e40af;font-size:10px;font-weight:700;padding:4px 8px;cursor:pointer;font-family:inherit">Trocar</button>
      </div>`;
    }
  }

  // Reset para "agora"
  const radNow=document.querySelector('input[name="pf-when"][value="now"]');
  if(radNow){radNow.checked=true;}
  g("#pf-sched-box").style.display="none";
  pfUpdatePreview();
  g("#pf-overlay").classList.remove("gone");
}

function closePreflight(){g("#pf-overlay").classList.add("gone");}

function pfToggleWhen(){
  const val=document.querySelector('input[name="pf-when"]:checked')?.value||"now";
  g("#pf-sched-box").style.display=val==="schedule"?"block":"none";
  // Visual feedback on labels
  const nowLbl=g("#pf-opt-now");const schedLbl=g("#pf-opt-sched");
  if(nowLbl){nowLbl.style.background=val==="now"?"var(--greenl)":"var(--sf2)";nowLbl.style.borderColor=val==="now"?"var(--green)":"var(--border2)";nowLbl.style.borderWidth=val==="now"?"2px":"1.5px";}
  if(schedLbl){schedLbl.style.background=val==="schedule"?"var(--bluel)":"var(--sf2)";schedLbl.style.borderColor=val==="schedule"?"var(--blue)":"var(--border2)";schedLbl.style.borderWidth=val==="schedule"?"2px":"1.5px";}
  pfUpdatePreview();
}

function pfUpdatePreview(){
  const el=g("#pf-preview");if(!el)return;
  const val=document.querySelector('input[name="pf-when"]:checked')?.value||"now";
  if(val==="now"){el.textContent="🟢 Inicia agora e envia sem parar. Reseta à meia-noite e continua automaticamente.";el.style.color="var(--green)";return;}
  const sh=parseInt(g("#pf-sh")?.value||8,10);
  const eh=parseInt(g("#pf-eh")?.value||20,10);
  const nowH=new Date().getHours();
  const nowM=new Date().getMinutes();
  if(nowH>=sh&&nowH<eh){
    el.textContent="✅ Dentro da janela — começa imediatamente";el.style.color="var(--green)";
  }else if(nowH<sh){
    const diffM=(sh-nowH)*60-nowM;
    const h=Math.floor(diffM/60),m=diffM%60;
    el.textContent=`⏰ Começa em ~${h>0?h+"h ":""}${m}min (às ${String(sh).padStart(2,"0")}:00)`;el.style.color="var(--amber)";
  }else{
    el.textContent=`⏰ Fora do horário — começa amanhã às ${String(sh).padStart(2,"0")}:00`;el.style.color="var(--amber)";
  }
}

async function confirmStartAuto(){
  const val=document.querySelector('input[name="pf-when"]:checked')?.value||"now";
  let startH,endH;
  if(val==="schedule"){
    startH=parseInt(g("#pf-sh")?.value||8,10);
    endH=parseInt(g("#pf-eh")?.value||20,10);
    if(g("#af-start-h"))g("#af-start-h").value=String(startH);
    if(g("#af-end-h"))g("#af-end-h").value=String(endH);
    closePreflight();
    await startAuto(startH,endH,"schedule");
  }else{
    // MODO AGORA: sem janela de horário — envia 24/7, reseta à meia-noite
    startH=0; endH=24; // irrelevante no modo now, mas enviamos valores neutros
    closePreflight();
    await startAuto(startH,endH,"now");
  }
}

// ══════════════════════════════════════════════════════
//  START AUTO — v12
//  Envia case numbers ao servidor → servidor busca emails
//  Isso evita falha do DOL API no browser (CORS/rate limit)
// ══════════════════════════════════════════════════════
async function startAuto(overrideStartH, overrideEndH, _mode="now"){
  if(!autoSelectedSrc){toast("Escolha a fonte das vagas! (Passo 1)","r");g("#ws-1")?.scrollIntoView({behavior:"smooth"});return;}
  const activeProfiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false);
  if(!activeProfiles.length){toast("Crie pelo menos 1 perfil ativo antes de iniciar!","r");return;}

  // ── VALIDAÇÃO: WhatsApp obrigatório para automático ──────────────
  const _wppRaw=U.whatsapp||CFG?.phone||"";
  const _wppNum=_wppRaw.replace(/\D/g,"");
  if(!_wppNum||_wppNum.length<8){
    toast("📱 WhatsApp obrigatório para usar o automático","r");
    setTimeout(()=>{
      if(confirm("⚠️ Cadastre seu WhatsApp antes de usar o Envio Automático.\n\nIsso permite que as empresas americanas entrem em contato com você diretamente.\n\nDeseja cadastrar agora?")){
        if(typeof closeAutoModal==="function")closeAutoModal();
        sv("profile");
        setTimeout(()=>{if(typeof switchProfileTab==="function")switchProfileTab("me");},300);
      }
    },200);
    return;
  }
  const nowH=new Date().getHours();
  const limit=10000;
  const state=g("#af-state")?.value||"";
  const keyword=g("#af-kw")?.value.trim()||"";
  const minWage=parseFloat(g("#af-min-wage")?.value||"0")||0;
  const hasEmail=g("#af-has-email")?.value||"";
  // startH/endH: vindos do modal preflight ou do wizard
  const startH=overrideStartH!==undefined?overrideStartH:parseInt(g("#af-start-h")?.value||8,10);
  const endH  =overrideEndH  !==undefined?overrideEndH  :parseInt(g("#af-end-h")?.value||20,10);
  const btn=g("#auto-start-btn");
  btn.disabled=true;
  btn.innerHTML='<span class="spin spin-sm"></span><span>Carregando vagas...</span>';
  try{
    btn.innerHTML='<span class="spin spin-sm"></span><span>Buscando vagas...</span>';
    const allCases=[];const caseMeta={};
    let sk=0;const pageSize=50;
    while(allCases.length<limit){
      const p=new URLSearchParams({sheet:autoSelectedSrc,skip:sk,top:Math.min(pageSize,limit-allCases.length),hideSent:"1"});
      if(state)p.append("state",state);
      if(keyword)p.append("q",keyword);
      if(autoSelectedCats&&autoSelectedCats.length>0)p.append("category",autoSelectedCats.join(","));else if(autoSelectedCat&&autoSelectedCat!=="all")p.append("category",autoSelectedCat);
      if(minWage>0)p.append("minWage",String(minWage));
      if(hasEmail==="yes")p.append("hasEmail","1");
      const cityFilter=g("#af-city")?.value.trim()||"";
      const minWorkersFilter=parseInt(g("#af-min-workers")?.value||"0")||0;
      if(cityFilter)p.append("city",cityFilter);
      if(minWorkersFilter>0)p.append("minWorkers",String(minWorkersFilter));
      // Filtros do modal único — iguais ao Envio Manual
      if(afTitles.length)p.append("titles",afTitles.join(","));
      if(afGrupos.length)p.append("grupos",afGrupos.join(","));
      if(afEtaStatus)p.append("dolStatus",afEtaStatus);
      if(afBeginMonths.length)p.append("beginMonth",afBeginMonths.join(",")); // v22
      const r=await fetch("/api/sheet-meta?"+p,{credentials:"include"});
      const d=await r.json();
      if(!d.jobs?.length)break;
      d.jobs.forEach(j=>{allCases.push(j.id);caseMeta[j.id]={
        company:j.company,state:j.state,category:j.category||"other",
        // v13: campos extras para snapshot completo
        title:j.title||j.occupation||"",
        city:j.city||"",
        wage:j.wage||"",
        visa:j.visa||(j.jobType==="agricultural"?"H-2A":j.jobType==="non-agricultural"?"H-2B":""),
        start:j.start||"",
        end:j.end||"",
        workers:j.workers||null,
        desc:(j.desc||"").slice(0,300),
        caseNum:j.id
      };});
      sk+=d.jobs.length;
      if(d.jobs.length<pageSize)break;
      btn.innerHTML=`<span class="spin spin-sm"></span><span>${allCases.length} vagas encontradas...</span>`;
    }
    if(!allCases.length){
      toast("Nenhuma vaga encontrada com esses filtros.","r");
      btn.disabled=false;btn.innerHTML='<i class="ti ti-rocket" style="font-size:22px"></i><span>🤖 Começar Envio Automático</span>';
      return;
    }

    btn.innerHTML=`<span class="spin spin-sm"></span><span>Iniciando envio de ${allCases.length} vagas...</span>`;
    // v15-FIX: Determina resumeIdx/coverIdx com fallback inteligente
    // Prioridade: autoResIdx (escolha explícita no painel auto) →
    //             activeResIdx (currículo "padrão") →
    //             resumeIdx do primeiro perfil ativo →
    //             primeiro PDF em DOCS
    // REESTRUTURADO: o perfil escolhido no Passo 3 tem prioridade máxima
    const _selAutoProfile=activeProfiles.find(p=>p.id===autoSelectedProfileId)||null;
    let _resumeIdx = (_selAutoProfile&&_selAutoProfile.resumeIdx!=null) ? _selAutoProfile.resumeIdx
                   : (autoResIdx !== null && autoResIdx !== undefined) ? autoResIdx
                   : (activeResIdx !== null && activeResIdx !== undefined) ? activeResIdx
                   : null;
    // v20 (reclamação real, 07/2026): se o usuário escolheu um perfil no
    // Passo 3, a cover DELE manda SEMPRE — coverIdx null é "Nenhuma" (escolha
    // explícita), não "pegue qualquer uma". Sem perfil escolhido, só entra
    // cover escolhida explicitamente no painel — nunca a de outro perfil.
    let _coverIdx  = _selAutoProfile ? (_selAutoProfile.coverIdx!=null?_selAutoProfile.coverIdx:null)
                   : (autoCovIdx !== null && autoCovIdx !== undefined) ? autoCovIdx
                   : (activeCovIdx !== null && activeCovIdx !== undefined) ? activeCovIdx
                   : null;
    // Fallback: pega resumeIdx de algum perfil ativo
    if (_resumeIdx == null) {
      const prfWithCv = activeProfiles.find(pr => pr.resumeIdx != null);
      if (prfWithCv) _resumeIdx = prfWithCv.resumeIdx;
    }
    // Fallback final: primeiro PDF tipo "resume" em DOCS
    if (_resumeIdx == null && typeof DOCS !== "undefined" && Array.isArray(DOCS)) {
      const firstRes = DOCS.find(d => (d.cvType||"resume") === "resume");
      if (firstRes) _resumeIdx = firstRes.idx;
    }

    const resp=await fetch("/api/auto/start",{
      method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        cases:allCases,
        caseMeta,
        resumeIdx: _resumeIdx,
        coverIdx:  _coverIdx,
        source:autoSelectedSrc,
        category:autoSelectedCat||"all",
        startH,
        endH,
        mode:_mode,
        senders:getSelectedAutoSenders(),
        profileId:autoSelectedProfileId||null,
        filters:{state,keyword,limit,category:autoSelectedCat,minWage,hasEmail,titles:afTitles,grupos:afGrupos,dolStatus:afEtaStatus,beginMonths:afBeginMonths,city:(g("#af-city")?.value||"").trim(),minWorkers:parseInt(g("#af-min-workers")?.value||"0")||0}
      })
    });
    const data=await resp.json();
    if(!data.ok){
      // v15-FIX: mensagem mais clara para erro de PDF faltando
      if (data.pdfMissing) {
        const debug = data.debug || {};
        let extraInfo = "";
        if (debug.cvsRegistered > 0 && debug.cvsOnDisk === 0) {
          extraInfo = " Seus PDFs foram registrados mas não estão no disco do servidor — faça upload novamente.";
        } else if (debug.profilesActive > 0 && debug.profilesWithResume === 0 && debug.cvsRegistered === 0) {
          extraInfo = " Vá em Perfis e vincule um PDF (currículo) ao seu perfil de currículo.";
        }
        throw new Error((data.error || "Currículo não encontrado") + extraInfo);
      }
      throw new Error(data.error||"Erro ao iniciar");
    }

    U.autoJob={active:true,status:"sending",queueSize:data.queueSize,source:autoSelectedSrc,originalCount:data.queueSize};
    window._sheetAvail={}; // fila nova = disponibilidade mudou; recalcula na próxima abertura
    // v19-FIX: robô estava marcado como "ligado" no servidor mas o timer de
    // envio tinha morrido (ex.: servidor reiniciou) — o backend detectou e
    // religou sozinho. Avisa o usuário com clareza em vez de deixar parecer
    // um início normal, e sai cedo (o fluxo de "nova fila" abaixo não se aplica).
    if(data.healed){
      _autoQueueIds=new Set();
      try{const _as=await fetch("/api/auto/status",{credentials:"include"}).then(r=>r.json());_autoQueueIds=new Set(_as.autoQueueIds||[]);}catch{}
      _syncAutoQueueVisibility();
      updateLimChip();updateAutoDot(true);updateAutoUI();startAutoPolling();
      setTimeout(()=>{const lv=g("#auto-live-section");const wz=g("#auto-wizard");if(lv)lv.style.display="block";if(wz)wz.style.display="none";if(typeof loadAutoLogs==="function")loadAutoLogs();},100);
      toast(`🔧 Seu robô estava travado (parado sem avisar) — reiniciei ele agora. ${data.queueSize} vaga(s) na fila.`,"g");
      btn.disabled=false;
      btn.innerHTML='<i class="ti ti-rocket" style="font-size:22px"></i><span>🤖 Começar Envio Automático</span>';
      return;
    }
    if(data.skippedAlreadySent>0){
      toast(`🧹 ${data.skippedAlreadySent.toLocaleString()} vaga(s) já enviadas antes ficaram de fora — fila só com vagas novas: ${data.queueSize.toLocaleString()}`,"g");
    }
    // v23: fila tem vagas de um tipo de visto sem perfil correspondente — avisa
    if(data.visaWarning&&data.visaWarning.message){
      setTimeout(()=>toast(data.visaWarning.message,"r"),1200);
    }
    // FIX-3: popula _autoQueueIds imediatamente ao iniciar para ocultar do manual
    if(data.queueIds&&data.queueIds.length){_autoQueueIds=new Set(data.queueIds);}else{try{const _as=await fetch("/api/auto/status",{credentials:"include"}).then(r=>r.json());_autoQueueIds=new Set(_as.autoQueueIds||[]);}catch{}}
    loadEmpregadoresBloqueados(); // v27: fila nova entra no bloqueio de todas as telas
    _syncAutoQueueVisibility(); // FIX: oculta vagas do manual imediatamente
    U.autoJob={...U.autoJob,mode:_mode};
    updateLimChip();updateAutoDot(true);updateAutoUI();startAutoPolling();
    // Fecha o wizard e abre direto o painel de monitoramento
    setTimeout(()=>{const lv=g("#auto-live-section");const wz=g("#auto-wizard");if(lv)lv.style.display="block";if(wz)wz.style.display="none";if(typeof loadAutoLogs==="function")loadAutoLogs();
      renderPushAsk("auto-push-ask","Seu robô trabalha com o app fechado — ative as notificações pra ele te avisar do progresso e se parar por algum motivo.");},100);
    const msg=_mode==="now"
      ?`🟢 Enviando agora! Contínuo até zerar a fila.`
      :(nowH>=startH&&nowH<endH
        ?`🟢 Enviando agora! Para às ${String(endH).padStart(2,"0")}:00`
        :`⏰ Aguarda ${String(startH).padStart(2,"0")}:00 para iniciar`);
    toast(`✅ ${data.queueSize} vagas na fila! ${msg}`,"g");

  }catch(e){
    toast("Erro: "+e.message,"r");
    console.error("[startAuto]",e);
  }
  btn.disabled=false;
  btn.innerHTML='<i class="ti ti-rocket" style="font-size:22px"></i><span>🤖 Começar Envio Automático</span>';
}

async function pauseAuto(){try{await fetch("/api/auto/pause",{method:"POST",credentials:"include"});U.autoJob={...U.autoJob,active:false,status:"paused"};updateAutoUI();updateLimChip();toast("Pausado","au");}catch(e){toast("Erro","r");}}
async function resumeAuto(){try{await fetch("/api/auto/resume",{method:"POST",credentials:"include"});U.autoJob={...U.autoJob,active:true,status:"resuming"};updateAutoUI();updateLimChip();startAutoPolling();toast("Retomado ✓","g");}catch(e){toast("Erro","r");}}
async function stopAuto(){
  setTimeout(async function(){await _loadSentIds();if(tab!=="seasonal")loadSheetMeta(true);},600);
if(!confirm("Parar o envio completamente?"))return;try{await fetch("/api/auto/stop",{method:"POST",credentials:"include"});U.autoJob=null;_autoQueueIds=new Set();_syncAutoQueueVisibility();clearInterval(autoInterval);autoInterval=null;if(_autoCountdown){clearInterval(_autoCountdown);_autoCountdown=null;}updateAutoUI();updateAutoDot(false);updateLimChip();toast("Parado","r");// Recarrega perfis do servidor para garantir que não sumiram
try{const pr=await fetch("/api/profiles",{credentials:"include"}).then(r=>r.json());UPROFILES=pr.profiles||[];if(U)U.profiles=UPROFILES;}catch{}
}catch(e){toast("Erro","r");}}

// FIX: oculta/mostra cards de vagas com base em _autoQueueIds (sincroniza UI após auto iniciar/parar)
function _syncAutoQueueVisibility(){
  try{
    // Sheet cards: vagas nas abas jan2026/jul2025
    document.querySelectorAll(".jcard[id^='jcard-s_']").forEach(card=>{
      const cn=card.id.replace("jcard-s_","").replace(/_/g,"."); // restaura pontos
      // Tenta também com underscore original (IDs com formato diferente)
      const inQ=_autoQueueIds.has(cn)||_autoQueueIds.has("s_"+cn);
      if(inQ&&card.style.display!=="none"){card.style.display="none";}
      else if(!inQ&&APPLIED.has(cn)){card.style.display="none";}
      else if(!inQ&&!APPLIED.has(cn)&&card.style.display==="none"){card.style.display="";}
    });
    // Seasonal cards
    document.querySelectorAll(".jcard[id^='jcard-']:not([id^='jcard-s_'])").forEach(card=>{
      const jid=card.id.replace("jcard-","");
      const inQ=_autoQueueIds.has(jid);
      if(inQ&&!APPLIED.has(jid)){card.style.display="none";}
      else if(!inQ&&!APPLIED.has(jid)&&card.style.display==="none"){card.style.display="";}
    });
  }catch{}
}

function startAutoPolling(){if(autoInterval)clearInterval(autoInterval);autoInterval=setInterval(pollAutoStatus,5000);}

// v19-FIX: "Envio Automático" deixou de ser uma view própria (curView="auto")
// e virou um MODAL (#auto-modal-overlay) faz tempo — mas o polling ainda
// checava curView==="auto" pra decidir se repinta a tela. Como abrir o
// automático agora chama openAutoModal() (que NUNCA seta curView="auto" —
// só empilha {modal:"auto"} no history), essa condição ficou permanentemente
// falsa. Resultado prático: o fetch a cada 5s continuava atualizando U.autoJob
// em memória (por isso "Próxima candidatura" às vezes aparecia certa quando o
// modal era reaberto), mas a TELA (banner de status, contador de enviados,
// lista de Últimos Envios) nunca repintava sozinha — parecia travado em
// "Retomando..." pra sempre até a pessoa atualizar a página manualmente.
// Fix: checar se o modal está de fato visível, não uma view que não existe mais.
function _isAutoModalOpen(){return g("#auto-modal-overlay")?.style.display==="block";}

async function pollAutoStatus(){
  if(curView!=="auto"&&!_isAutoModalOpen()&&!U.autoJob?.active)return;
  try{
    const r=await fetch("/api/auto/status",{credentials:"include"});const d=await r.json();
    // Detectar mudança de status para mostrar toast
    const _prevStatus=U.autoJob?.status;
    if(d.job)U.autoJob={...d.job};else U.autoJob=null;
    // FIX: fila zerada + ativo = concluído (server pode demorar até detectar)
    if(U.autoJob&&U.autoJob.active&&(U.autoJob.queueSize===0||U.autoJob.queueSize===null)){
      U.autoJob={...U.autoJob,status:"finished",active:false};
    }
    // Toast para status importantes que mudaram
    if(U.autoJob?.status!==_prevStatus){
      if(U.autoJob?.status==="paused_no_vip")toast("⛔ Automático pausado — plano expirou. Renove seu plano em Planos.","r");
      if(U.autoJob?.status==="paused_auth_error")toast("🔑 Automático pausado — erro de autenticação. Faça login novamente.","r");
      if(U.autoJob?.status==="finished"&&_prevStatus!=="finished"){const _frases=["🎉 "+t('fq1'),"🏆 "+t('fq2'),"✅ "+t('fq3')+" 🇺🇸","🚀 "+t('fq4')];toast(_frases[Math.floor(Math.random()*_frases.length)],"g");}
    }
    U.todaySentAuto=d.todayAuto||0;U.autoLimit=d.autoLimit||10;U.autoStats=d.stats||{sent:0,failed:0};
    // FIX-3: Atualiza set de vagas na fila automática para ocultar do manual
    _autoQueueIds=new Set(d.autoQueueIds||[]);
    _syncAutoQueueVisibility(); // FIX: sincroniza cards visualmente
    const _autoVisible=curView==="auto"||_isAutoModalOpen();
    if(_autoVisible){updateAutoUI();_updateAutoFreeBanner();}
    if(curView==="home")renderHome(); // FIX: atualiza stats auto na home
    updateAutoDot(d.job?.active||false);updateLimChip();renderSidebar();
    // v67: prévia da fila + intervalo (pro card de próximas e a ETA)
    window._autoQueuePreview=d.queuePreview||[];
    window._autoIntervalSecs=d.intervalSecs||330;
    // Update recent logs in dashboard
    if(_autoVisible&&d.recentLogs?.length)renderRecentLogs(d.recentLogs);
    // v67: faixa-resumo de TODO o histórico do robô (não só os 15 visíveis)
    const _chips=g("#auto-log-chips");
    if(_autoVisible&&_chips&&d.logStats){
      const ls=d.logStats;const chip=(txt,bg,bd,cor)=>`<span style="background:${bg};border:1px solid ${bd};border-radius:9px;padding:3px 9px;font-size:10.5px;font-weight:700;color:${cor}">${txt}</span>`;
      _chips.style.display="flex";
      _chips.innerHTML=chip(`✅ ${ls.sent} enviados`,"rgba(16,185,129,.1)","rgba(16,185,129,.25)","var(--green)")
        +chip(`⏭ ${ls.skip} puladas`,"var(--sf2)","var(--border)","var(--t2)")
        +chip(`🔁 ${ls.dup} duplicadas`,"rgba(245,158,11,.1)","rgba(245,158,11,.25)","#d97706")
        +(ls.failed?chip(`❌ ${ls.failed} falhas`,"rgba(239,68,68,.08)","rgba(239,68,68,.25)","var(--red)"):"");
    }
    if(!d.job?.active&&autoInterval&&!d.job){clearInterval(autoInterval);autoInterval=null;
      _autoQueueIds=new Set(); // limpa quando auto para
    }
  }catch{}
}

function renderRecentLogs(logs){
  const el=g("#auto-recent-logs");if(!el)return;
  _recentLogsData=logs||[];
  if(!logs.length){el.innerHTML='<div style="padding:12px 14px;font-size:13px;color:var(--t3)">Nenhum envio ainda...</div>';return;}
  const emojis={enviado:"✅",falhou:"❌",duplicado:"🔁",pausado:"⏸",sistema:"ℹ️",cancelado:"🚫",pulado:"⏭",limite:"📊"};
  el.innerHTML=logs.map((l,i)=>{
    const em=emojis[l.status]||"•";
    const statusClass="ls-"+(l.status||"sistema");
    // Hora: preferir l.hour, senão extrair do l.date
    const hora=l.hour||(l.date||"").split(" ")[1]||"";
    // Sender: qual Gmail enviou
    const senderShort=l.senderEmail?(l.senderEmail.split("@")[0]):"";
    // Salário
    const wage=l.wage&&l.wage!=="–"?l.wage:"";
    // Local
    const local=[l.city,l.state].filter(Boolean).join(", ");
    // Perfil usado
    const perfil=l.profileUsed||"";
    // Assunto
    const assunto=l.subjectUsed||"";
    // Status enviado: cor verde no horário
    const horaColor=l.status==="enviado"?"var(--green)":l.status==="falhou"?"var(--red)":l.status==="duplicado"?"var(--amber)":"var(--t3)";
    return`<div class="log-entry" onclick="openRecentLogDetail(${i})" style="padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface);cursor:pointer" role="button" tabindex="0">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span class="log-status ${statusClass}" style="flex-shrink:0;margin-top:1px">${em} ${esc(l.status||"–")}</span>
        <div style="flex:1;min-width:0">
          <!-- Linha 1: empresa + horário -->
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px">
            <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.company||l.jobTitle||"–")}</div>
            <div style="font-size:11px;font-weight:700;color:${horaColor};white-space:nowrap;flex-shrink:0">${hora}</div>
          </div>
          <!-- Linha 2: vaga/título -->
          ${(l.jobTitle&&l.jobTitle!==l.company)?`<div style="font-size:11px;color:var(--t2);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-briefcase" style="font-size:10px"></i> ${esc(l.jobTitle)}</div>`:""}
          <!-- Linha 3: email destino -->
          ${l.to?`<div style="font-size:11px;color:var(--blue);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-mail" style="font-size:10px"></i> ${esc(l.to)}</div>`:""}
          <!-- Linha 4: sender + local + salário -->
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
            ${senderShort?`<span style="background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.25);border-radius:8px;padding:1px 6px;font-size:10px;font-weight:700;color:#7c3aed"><i class="ti ti-send" style="font-size:9px"></i> ${esc(senderShort)}</span>`:""}
            ${local?`<span style="background:rgba(37,99,235,.1);border:1px solid rgba(37,99,235,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--blue)"><i class="ti ti-map-pin" style="font-size:9px"></i> ${esc(local)}</span>`:""}
            ${wage?`<span style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--green);font-weight:700">${esc(wage)}</span>`:""}
            ${l.category&&l.category!=="other"?`<span style="background:var(--sf2);border:1px solid var(--border);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--t2)">${esc(l.category)}</span>`:""}
            ${perfil?`<span style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:1px 6px;font-size:10px;color:#d97706">📋 ${esc(perfil.slice(0,18))}</span>`:""}
            ${l.attachCount>0?`<span style="background:var(--sf2);border:1px solid var(--border);border-radius:8px;padding:1px 6px;font-size:10px;color:var(--t2)">📎 ${l.attachCount} anexo${l.attachCount>1?"s":""}</span>`:""}
          </div>
          <!-- Linha 5: assunto (truncado) -->
          ${assunto?`<div style="font-size:10px;color:var(--t3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-quote" style="font-size:9px"></i> ${esc(assunto.slice(0,60))}${assunto.length>60?"…":""}</div>`:""}
          <!-- Erro se houver -->
          ${l.error?`<div style="font-size:11px;color:var(--red);margin-top:3px;line-height:1.4"><i class="ti ti-alert-circle" style="font-size:10px"></i> ${esc(l.error.slice(0,120))}</div>`:""}
        </div>
      </div>
    </div>`;
  }).join("");
}

async function loadAutoLogs(){
  try{
    const r=await fetch("/api/auto-logs?top=15",{credentials:"include"});
    if(!r.ok)return;
    const d=await r.json();
    if(d.logs&&d.logs.length)renderRecentLogs(d.logs);
  }catch{}
}

// Atualiza o banner de limite na tela auto conforme o plano do usuário
// 🔒 v172 (ORDEM DO DONO, 11/09/2026): mesmo gate do automático, só que pra
// aba de envio Manual — mesma régua, "a pessoa não pode se perder".
function updateManualSendGate(){
  const el=g("#manual-send-gate");if(!el)return;
  // 🔒 v172: admin pula a trava de PLANO (isVipActive(admin)=true sempre),
  // mas NÃO pula a de Gmail conectado — sem isso o admin ficava sem CTA
  // nenhum caso nunca tivesse passado por /oauth/connect-send (login não
  // dá mais gmail.send de graça pra ninguém, admin incluso).
  if((!U.isAdmin&&!U.needsPlan&&U.gmailConnected)||(U.isAdmin&&U.gmailConnected)){el.style.display="none";return;}
  el.style.display="flex";
  if(!U.isAdmin&&U.needsPlan){
    el.innerHTML='<i class="ti ti-lock"></i> Você precisa de um plano ativo pra enviar candidaturas <button onclick="sv(\'plans\')" style="margin-left:auto;background:#fff;border:1.5px solid currentColor;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:800;cursor:pointer;color:inherit">Ver planos</button>';
    el.style.background="rgba(239,68,68,.1)";el.style.border="1.5px solid rgba(239,68,68,.35)";el.style.color="#dc2626";
  } else {
    el.innerHTML='<i class="ti ti-mail-exclamation"></i> Conecte seu Gmail pra começar a enviar <button onclick="connectGmailForSending(\'jobs\')" style="margin-left:auto;background:#fff;border:1.5px solid currentColor;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:800;cursor:pointer;color:inherit">Conectar Gmail</button>';
    el.style.background="rgba(245,158,11,.12)";el.style.border="1.5px solid rgba(245,158,11,.4)";el.style.color="#b45309";
  }
}

// 🔒 v172 (ORDEM DO DONO, 11/09/2026): "não vai ter mais essa de dez envio
// manual e dez automático grátis" — 3 estados possíveis, nesta ordem:
// (1) sem plano com automático → assinar; (2) tem plano mas nunca conectou
// o Gmail → conectar (só aqui, gmail.send é pedido); (3) tudo certo → mostra
// o limite normal do plano.
function _updateAutoFreeBanner(){
  const lbl=g("#auto-free-note-lbl");if(!lbl)return;
  // 🔒 v172: admin pula a trava de PLANO, mas NÃO a de Gmail conectado —
  // mesmo motivo do updateManualSendGate acima.
  if(U.isAdmin&&!U.gmailConnected){
    lbl.innerHTML='<i class="ti ti-mail-exclamation"></i> <strong>Conecte seu Gmail</strong> (Perfil → Admin) pra poder enviar <button onclick="connectGmailForSending(\'auto\')" style="margin-left:6px;background:#fff;border:1.5px solid currentColor;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:800;cursor:pointer;color:inherit">Conectar Gmail</button>';
    lbl.style.background="rgba(245,158,11,.12)";lbl.style.borderColor="rgba(245,158,11,.4)";lbl.style.color="#b45309";
  } else if(U.isAdmin){
    lbl.innerHTML='<i class="ti ti-shield"></i> <strong>Admin</strong> — Envios ilimitados · Intervalo personalizado';
    lbl.style.background="rgba(245,158,11,.15)";lbl.style.borderColor="rgba(245,158,11,.4)";lbl.style.color="#d97706";
  } else if((U.autoLimit||0)<=0){
    lbl.innerHTML='<i class="ti ti-lock"></i> <strong>Plano necessário</strong> — assine VIPro ou DoublePro pra usar o automático <button onclick="sv(\'plans\')" style="margin-left:6px;background:#fff;border:1.5px solid currentColor;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:800;cursor:pointer;color:inherit">Ver planos</button>';
    lbl.style.background="rgba(239,68,68,.1)";lbl.style.borderColor="rgba(239,68,68,.35)";lbl.style.color="#dc2626";
  } else if(!U.gmailConnected){
    lbl.innerHTML='<i class="ti ti-mail-exclamation"></i> <strong>Conecte seu Gmail</strong> pra começar a enviar <button onclick="connectGmailForSending(\'auto\')" style="margin-left:6px;background:#fff;border:1.5px solid currentColor;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:800;cursor:pointer;color:inherit">Conectar Gmail</button>';
    lbl.style.background="rgba(245,158,11,.12)";lbl.style.borderColor="rgba(245,158,11,.4)";lbl.style.color="#b45309";
  } else if(U.plan==="doublepro"){
    lbl.innerHTML=`<i class="ti ti-crown"></i> <strong>DoublePro</strong> — ${U.autoLimit} envios/dia com 2 Gmails`;
    lbl.style.background="rgba(99,102,241,.1)";lbl.style.borderColor="rgba(99,102,241,.3)";lbl.style.color="#4f46e5";
  } else {
    lbl.innerHTML=`<i class="ti ti-star"></i> <strong>VIPro</strong> — ${U.autoLimit} envios/dia automático`;
    lbl.style.background="rgba(139,92,246,.1)";lbl.style.borderColor="rgba(139,92,246,.3)";lbl.style.color="#7c3aed";
  }
}

function updateAutoUI(){
  const j=U.autoJob;const active=j?.active;const has=!!j&&j.status!=="finished";
  const live=g("#auto-live-section");const wizard=g("#auto-wizard");
  if(live)live.style.display=has?"block":"none";
  if(wizard)wizard.style.display=has?"none":"block";

  if(!has)return;

  // Status banner
  const banner=g("#auto-status-banner");const txt=g("#auto-status-text");const sub=g("#auto-status-sub");
  // v39 (caça ativa, 22/07): mapa COMPLETO de status — antes, os status de
  // FALHA (auth_error, token revogado, rate-limit do Google, fila
  // recarregada...) apareciam como CÓDIGO CRU EM INGLÊS pro usuário leigo,
  // justo nos momentos em que ele mais precisava de instrução. Cada falha
  // agora tem rótulo claro em PT + a linha de baixo diz O QUE FAZER.
  // 🌐 i18n Etapa 5: o texto dinâmico mais visto do app fala as 3 línguas
  const statusLabels={starting:t('st_starting'),sending:t('st_sending'),paused:t('st_paused'),
    paused_no_session:t('st_no_session'),finished:t('st_finished'),resuming:t('st_resuming'),
    recovering:t('st_resuming'),recovered:t('st_resuming'),refilled:t('st_refilled'),
    waiting_interval:t('st_wait_interval'),waiting_hour:t('st_wait_hour'),
    waiting_limit:t('st_wait_limit'),
    waiting_rate_limit:t('st_wait_rate'),
    paused_auth_error:t('st_auth_err'),
    paused_token_revoked:t('st_token_revoked'),
    paused_no_refresh_token:t('st_no_refresh'),
    paused_corrupt_queue:t('st_corrupt'),
    paused_no_vip:t('st_paused')};
  const statusHints={
    paused_auth_error:t('hint_auth_err'),
    paused_token_revoked:t('hint_token_revoked'),
    paused_no_refresh_token:t('hint_no_refresh'),
    paused_no_session:t('hint_no_session'),
    paused_corrupt_queue:t('hint_corrupt'),
    waiting_rate_limit:t('hint_rate')};
  if(banner){banner.className="auto-status-banner "+(active?"asb-sending":j.status==="finished"?"asb-done":"asb-paused");}
  if(txt)txt.textContent=statusLabels[j.status]||("⏸ "+(j.status||"–"));

  // Next send countdown — roda em tempo real (atualiza a cada 1s)
  // v39: waiting_rate_limit também tem nextSendAt — agora mostra contagem
  if(_autoCountdown){clearInterval(_autoCountdown);_autoCountdown=null;}
  if(j.nextSendAt&&(j.status==="waiting_interval"||j.status==="waiting_hour"||j.status==="waiting_limit"||j.status==="waiting_rate_limit")&&sub){
    const updateCountdown=()=>{
      const left=Math.max(0,Math.round((j.nextSendAt-Date.now())/1000));
      if(left===0){sub.textContent=t('cd_soon');if(_autoCountdown){clearInterval(_autoCountdown);_autoCountdown=null;}return;}
      const label=j.status==="waiting_interval"?t('cd_next'):j.status==="waiting_hour"?t('cd_starts'):t('cd_resumes');
      sub.textContent=`${label} ${Math.floor(left/60)}:${String(left%60).padStart(2,"0")}`;
    };
    updateCountdown();
    _autoCountdown=setInterval(updateCountdown,1000);
  } else if(sub)sub.textContent=statusHints[j.status]||"";

  // Dashboard
  const stats=U.autoStats||{};
  const sent=stats.sent||U.todaySentAuto||0;const failed=stats.failed||0;
  const qs=j.queueSize||0;const orig=j.originalCount||1;
  const pct=orig>0?Math.min(100,Math.round(((orig-qs)/orig)*100)):0;
  const el=(id,val)=>{const e=g(id);if(e)e.textContent=val;};
  el("#dash-sent",sent);el("#dash-failed",failed);el("#dash-queue",qs.toLocaleString());
  // Admin: mostrar "∞ (enviados hoje)" em vez de X/9999
  if(U.isAdmin&&U.autoLimit>=9999){
    el("#dash-limit",U.todaySentAuto+" hoje");
    const lbl=g("#dash-limit-lbl");if(lbl)lbl.textContent="Enviados hoje";
  } else {
    el("#dash-limit",`${U.todaySentAuto}/${U.autoLimit}`);
    const lbl=g("#dash-limit-lbl");if(lbl)lbl.textContent="Limite diário";
  }
  el("#dash-pct",pct+"%");
  const prog=g("#dash-prog");if(prog)prog.style.width=pct+"%";
  // Labels da barra de progresso melhorada
  const sentLbl=g("#dash-prog-sent-lbl");if(sentLbl)sentLbl.textContent=`${(orig-qs).toLocaleString()} de ${orig.toLocaleString()} enviados`;
  const daysLbl=g("#dash-prog-days-lbl");if(daysLbl){
    const _lim=U.autoLimit||10;const _daysEst=_lim>0&&qs>0?Math.ceil(qs/_lim):null;
    daysLbl.textContent=_daysEst&&_daysEst>0?`~${_daysEst} dia${_daysEst>1?"s":""} restante${_daysEst>1?"s":""}`:qs===0?"✅ Concluído!":"";
  }

  // Info extra para admin: intervalo e sender
  const extraInfo=g("#auto-extra-info");
  if(extraInfo&&U.isAdmin){
    extraInfo.style.display="flex";
    const secs=U.adminSettings?.intervalSecs||300;
    const mins=Math.floor(secs/60);const secsR=secs%60;
    const intLbl=mins>0?(secsR>0?`⏱ ${mins}min ${secsR}s/envio`:`⏱ ${mins}min/envio`):`⚡ ${secs}s/envio`;
    const intBadge=g("#auto-interval-badge");if(intBadge)intBadge.textContent=intLbl;
    const senders=(U.senderEmails||[]).filter(s=>s.active!==false);
    const senderBadge=g("#auto-sender-badge");
    if(senderBadge)senderBadge.textContent=senders.length>0?`📧 ${senders.length+1} Gmails ativos`:"📧 1 Gmail";
  } else if(extraInfo){extraInfo.style.display="none";}

  // v67: PRÓXIMAS candidaturas (agora + até 3 seguintes) e ETA da fila.
  // ETA = vagas restantes × intervalo real (admin usa o seu; usuário, ~5,5min).
  const njc=g("#next-job-card");const njl=g("#next-jobs-list");const _eta=g("#next-eta");
  const _prev=window._autoQueuePreview||[];
  if(active&&(j.currentJob||_prev.length)){
    if(njc)njc.classList.add("show");
    if(_eta){
      const _iv=window._autoIntervalSecs||330;
      const _rest=(j.queueSize||0)*_iv*1000;
      if(_rest>0){
        const _fim=new Date(Date.now()+_rest);
        const _dias=_rest>86400000?` (+${Math.floor(_rest/86400000)}d)`:"";
        _eta.textContent=`termina ≈ ${_fim.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}${_dias}`;
      } else _eta.textContent="";
    }
    if(njl){
      const _rows=[];
      if(j.currentJob)_rows.push({company:j.currentJob.company,title:j.currentJob.title,to:j.currentJob.to,state:j.currentJob.state,_now:1});
      for(const q of _prev){ if(!_rows.some(r=>r.to===q.to)) _rows.push(q); }
      njl.innerHTML=_rows.slice(0,4).map((q,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;${i>0?"border-top:1px dashed var(--border);":""}">
        <span style="flex-shrink:0;font-size:10.5px;font-weight:800;color:${q._now?"var(--green)":"var(--t3)"};min-width:44px">${q._now?"▶ AGORA":(i+1)+"ª fila"}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.title||q.company||"–")}</div>
          <div style="font-size:10.5px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.company||"")}${q.state?" · "+esc(q.state):""}${q.to?" · "+esc(q.to):""}</div>
        </div>
      </div>`).join("");
    }
  }
  else{if(njc)njc.classList.remove("show");}

  // Buttons
  const pb=g("#auto-pause-btn");const rb=g("#auto-resume-btn");const sb=g("#auto-stop-btn");
  if(pb)pb.style.display=active&&j.status!=="finished"?"inline-flex":"none";
  if(rb)rb.style.display=has&&!active&&j.status!=="finished"?"inline-flex":"none";
  if(sb)sb.style.display=has&&j.status!=="finished"?"inline-flex":"none";
}

// ═══════════════════════════════════════════
//  SYNC / AUTH
// ═══════════════════════════════════════════
async function syncData(){
  try{
    const[hR,stR]=await Promise.all([fetch("/api/history",{credentials:"include"}),fetch("/api/status",{credentials:"include"})]);
    if(hR.ok){const d=await hR.json();if(d.history?.length){HIST=d.history;HIST.forEach(h=>{if(h.jobId)APPLIED.add(h.jobId);});updHistBadge();}}
    // FIX-3: carrega IDs em fila automática para ocultar do envio manual
    if(U.autoJob?.active){try{const _as=await fetch("/api/auto/status",{credentials:"include"}).then(r=>r.json());_autoQueueIds=new Set(_as.autoQueueIds||[]);}catch{}}
    // Atualiza senderEmails e adminSettings do servidor
    if(stR&&stR.ok){try{const sd=await stR.json();if(sd.connected){U.senderEmails=sd.senderEmails||[];U.adminSettings=sd.adminSettings||U.adminSettings;U.manualLimit=sd.manualLimit||U.manualLimit;U.autoLimit=sd.autoLimit||U.autoLimit;U.manualRemaining=sd.manualRemaining??U.manualRemaining;U.autoRemaining=sd.autoRemaining??U.autoRemaining;U.autoJob=sd.autoJob||U.autoJob;updateLimChip();}}catch{}}
  }catch{}
}
// 🔒 v172 (ORDEM DO DONO, 11/09/2026): pedido SEPARADO do login — só existe
// pra quem JÁ tem plano pago ativo (o servidor confere de novo e barra quem
// não tem). fromTab devolve a pessoa pra onde ela estava tentando enviar.
// v172c (12/09/2026): passa pelo aviso obrigatório (showGmailConnectWarnModal)
// antes de ir pro Google — é a conta que vira e-mail de envio PRA SEMPRE.
function connectGmailForSending(fromTab){
  showGmailConnectWarnModal(fromTab);
}
async function loadPublicStats(){
  try{
    const r=await fetch("/api/public-stats");const d=await r.json();
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=(v||0).toLocaleString("pt-BR");};
    set("ps-users",d.totalUsers);set("ps-today",d.todaySent);set("ps-auto-today",d.todayAuto);
    set("ps-total",d.totalSent);set("ps-total-auto",d.totalAuto);set("ps-vip",d.vipUsers);
  }catch{}
}
document.addEventListener("DOMContentLoaded",()=>{loadPublicStats();setInterval(loadPublicStats,30000);loadPublicReviews();});

// Avaliações reais (aprovadas por admin) na landing — substitui depoimentos fixos
async function loadPublicReviews(){
  try{
    const r=await fetch("/api/reviews/public");
    const d=await r.json();
    const grid=document.getElementById("ln-proof-grid");
    const section=document.getElementById("ln-proof-section");
    if(!grid||!section)return;
    if(!d.ok||!d.reviews||!d.reviews.length){section.style.display="none";return;}
    const avatars=["🙂","🌟","🏨","🌿","🤠","🧑‍🌾","👷","🍳"];
    const shown=d.reviews.slice(0,9);
    grid.innerHTML=shown.map((rv,i)=>{
      const stars="★".repeat(rv.rating||5)+"☆".repeat(5-(rv.rating||5));
      const nameLine=esc(rv.displayName||"Usuário")+(rv.location?" — "+esc(rv.location):"");
      return `<div class="ln-proof-card">
        <div class="ln-proof-quote">"${esc(rv.text)}"</div>
        <div class="ln-proof-author">
          <div class="ln-proof-av">${avatars[i%avatars.length]}</div>
          <div>
            <div class="ln-proof-name">${nameLine}</div>
            <div class="ln-proof-stars">${stars}</div>
          </div>
        </div>
      </div>`;
    }).join("");
    section.style.display="";
    // v18-SEO: aggregateRating + review no JSON-LD já existente (SoftwareApplication)
    // — só roda quando existem avaliações reais aprovadas (mesma condição que
    // mostra a seção visível), e usa EXATAMENTE os mesmos dados/textos que
    // aparecem na tela, pra nunca ficar descolado do que o usuário vê (regra
    // do Google: dado estruturado tem que bater com o conteúdo visível).
    try{
      const ldEl=document.getElementById("ld-software-app");
      if(ldEl && d.totalApproved>0){
        const ld=JSON.parse(ldEl.textContent);
        ld.aggregateRating={
          "@type":"AggregateRating",
          "ratingValue":String(d.avgRating||5),
          "reviewCount":String(d.totalApproved),
          "bestRating":"5",
          "worstRating":"1"
        };
        ld.review=shown.map(rv=>({
          "@type":"Review",
          "reviewRating":{"@type":"Rating","ratingValue":String(rv.rating||5),"bestRating":"5","worstRating":"1"},
          "author":{"@type":"Person","name":rv.displayName||"Usuário H2BApply"},
          "reviewBody":rv.text
        }));
        ldEl.textContent=JSON.stringify(ld);
      }
    }catch(e){/* falha silenciosa — nunca deixa o schema quebrar a página */}
  }catch(e){/* falha silenciosa — seção some se algo der errado */}
}
async function doLogout(){
  // v167 (bug real, auditoria 08/09/2026): rascunhos locais (editor de perfil
  // + onboarding) são escopados por e-mail, mas em aparelho compartilhado é
  // mais seguro limpar os desta conta ao sair — nunca sobra resquício pro
  // próximo login usar por engano. Roda ANTES de zerar U (precisa do e-mail).
  try{["h2b","h2a"].forEach(vt=>{try{localStorage.removeItem(_peDraftKey(vt));localStorage.removeItem(_obDraftKey(vt));}catch(e){}});}catch(e){}
  await fetch("/api/disconnect",{credentials:"include"});U={connected:false};clearInterval(autoInterval);showLanding();
}
// v167: achado E2E CRÍTICO — depois da reestruturação v166 (nav reduzida a
// 3 destinos) nenhum botão da interface chamava mais doLogout(); usuário
// não tinha como sair da conta / trocar de Gmail no mesmo aparelho. Botão
// vive na aba "Eu" (Meu Perfil) — único lugar visitado tanto pela sidebar
// quanto pela bottom-nav mobile — com confirm() no mesmo padrão das outras
// ações destrutivas/de sessão do site.
function confirmLogout(){if(!confirm(t('logout_confirm')||"Sair da sua conta?"))return;doLogout();}

// ── Configurações: deletar a própria conta ──────────────────────────────
function _populateSettingsView(){
  const avEl=g("#set-av"), nameEl=g("#set-name"), emailEl=g("#set-email");
  if(nameEl) nameEl.textContent=U.name||"–";
  if(emailEl) emailEl.textContent=U.email||"–";
  if(avEl){
    if(U.picture){ avEl.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;object-fit:cover">`; }
    else { avEl.textContent=(U.name||U.email||"?")[0].toUpperCase(); }
  }
}
// ── Configurações: baixar meus dados (LGPD art. 18, V — portabilidade) ──
async function downloadMyData(){
  const btn=g("#btn-baixar-dados");
  if(btn){ btn.disabled=true; btn.dataset.orig=btn.innerHTML; btn.innerHTML=`<span class="spin spin-sm"></span> Preparando...`; }
  try{
    const r=await fetch("/api/account/export",{credentials:"include"});
    if(!r.ok){ const d=await r.json().catch(()=>({})); throw new Error(d.error||("HTTP "+r.status)); }
    const blob=await r.blob();
    const cd=r.headers.get("Content-Disposition")||"";
    const m=cd.match(/filename="([^"]+)"/);
    const fname=m?m[1]:`h2bapply-meus-dados-${new Date().toISOString().slice(0,10)}.json`;
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download=fname;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast("Seus dados foram baixados ✓","g");
  }catch(e){
    toast("Erro ao baixar: "+e.message,"r");
  }finally{
    if(btn){ btn.disabled=false; btn.innerHTML=btn.dataset.orig||`<i class="ti ti-download"></i> Baixar meus dados`; }
  }
}
function openDeleteAccountModal(){ g("#del-acc-m")?.classList.remove("gone"); }
function closeDeleteAccountModal(){ g("#del-acc-m")?.classList.add("gone"); }
async function confirmDeleteAccount(){
  const btn=g("#del-acc-confirm-btn");
  if(btn){ btn.disabled=true; btn.textContent="Deletando..."; }
  try{
    const r=await fetch("/api/account/delete",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});
    const d=await r.json();
    if(d.ok){
      closeDeleteAccountModal();
      toast("Conta deletada. Você pode voltar quando quiser fazendo login de novo.","g");
      U={connected:false};
      clearInterval(autoInterval);
      setTimeout(showLanding,800);
    } else {
      toast("Erro: "+(d.error||"tente de novo"),"r");
      if(btn){ btn.disabled=false; btn.textContent="Sim, deletar"; }
    }
  }catch(e){
    toast("Erro de rede: "+e.message,"r");
    if(btn){ btn.disabled=false; btn.textContent="Sim, deletar"; }
  }
}


// ═══════════════════════════════════════════
//  BANNER / TOAST
// ═══════════════════════════════════════════

// ── Desktop: arrastar com mouse + scroll do wheel nas barras horizontais
// (aba de categorias/planilhas, tabs da caixa de entrada, ranking, chips) ──
(function(){
  const HSCROLL_SEL='.stabs, .inbox-tabs, .rank-tabs, .cat-chips-row, #ia-suggestions';
  let dragEl=null,startX=0,startScroll=0,moved=false;
  function findScroller(t){return t&&t.closest?t.closest(HSCROLL_SEL):null;}
  document.addEventListener("mousedown",(e)=>{
    const el=findScroller(e.target);if(!el)return;
    dragEl=el;startX=e.pageX;startScroll=el.scrollLeft;moved=false;
    el.classList.add("hscroll-dragging");
  });
  document.addEventListener("mousemove",(e)=>{
    if(!dragEl)return;
    const dx=e.pageX-startX;
    if(Math.abs(dx)>3)moved=true;
    dragEl.scrollLeft=startScroll-dx;
  });
  function endDrag(){if(dragEl)dragEl.classList.remove("hscroll-dragging");dragEl=null;}
  document.addEventListener("mouseup",endDrag);
  document.addEventListener("mouseleave",endDrag);
  document.addEventListener("click",(e)=>{
    if(moved&&findScroller(e.target)){e.stopPropagation();e.preventDefault();moved=false;}
  },true);
  document.addEventListener("wheel",(e)=>{
    const el=findScroller(e.target);if(!el)return;
    if(el.scrollWidth>el.clientWidth&&Math.abs(e.deltaY)>Math.abs(e.deltaX)){
      el.scrollLeft+=e.deltaY;e.preventDefault();
    }
  },{passive:false});
})();
function showBanner(t,html,action){const b=g("#banner");if(!b)return;const cm={blue:"al-blue",amber:"al-amber",green:"al-green",red:"al-red"};b.className=`banner ${cm[t]||"al-blue"}`;const actionBtn=action?`<button onclick="${action}" style="margin-left:8px;background:rgba(26,86,219,.15);border:1.5px solid var(--blueb);color:var(--blue);border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit">${action.includes("profile")?"Configurar →":"Ver →"}</button>`:"";b.innerHTML=`<i class="ti ti-info-circle" style="font-size:15px;flex-shrink:0"></i><span style="flex:1">${html}</span>${actionBtn}<button aria-label="Fechar" title="Fechar" onclick="this.parentElement.classList.add('gone')" style="margin-left:6px;background:none;border:none;cursor:pointer;opacity:.6;font-size:18px;padding:0 2px;flex-shrink:0"><i class="ti ti-x"></i></button>`;b.classList.remove("gone");}
function toast(msg,type=""){const w=g("#tw");const el=document.createElement("div");el.className="t"+(type?" "+type:"");el.textContent=msg;w.appendChild(el);requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add("show")));setTimeout(()=>{el.classList.remove("show");setTimeout(()=>el.remove(),300);},2800);}

// ═══════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════
function mkSkels(n){return Array(n).fill(0).map(()=>`<div style="padding:11px 12px;border-bottom:1px solid var(--border)"><div class="skel" style="height:13px;width:70%;margin-bottom:5px"></div><div class="skel" style="height:11px;width:50%;margin-bottom:5px"></div><div style="display:flex;gap:5px"><div class="skel" style="height:17px;width:50px;border-radius:20px"></div><div class="skel" style="height:17px;width:40px;border-radius:20px"></div></div></div>`).join("");}

// Infinite scroll
const obs=new IntersectionObserver(entries=>{if(!entries[0].isIntersecting)return;if(tab==="seasonal"&&!loading&&!done)loadJobs();else if(tab!=="seasonal"&&!sLoading&&!sDone)loadSheetMeta();},{threshold:0.1,rootMargin:"200px"});
addEventListener("DOMContentLoaded",()=>{
  const s=document.createElement("div");s.id="scroll-sentinel";
  const lm=g("#lmore");if(lm&&lm.parentNode){lm.parentNode.insertBefore(s,lm.nextSibling);obs.observe(s);}
  // Fix viewport height on mobile
  const setVH=()=>document.documentElement.style.setProperty("--dvh",window.innerHeight*0.01+"px");
  setVH();window.addEventListener("resize",setVH);
});

// ══════════════════════════════════════════════════
//  PWA — Service Worker + Ícones + Banner de Instalação
// ══════════════════════════════════════════════════

// Ícones do PWA são arquivos PNG estáticos (icon-192.png, icon-512.png etc.)
// servidos direto pelo servidor — nada de canvas nem interceptação pelo SW.

// Registro do Service Worker
if("serviceWorker" in navigator){
  window.addEventListener("load",()=>{
    navigator.serviceWorker.register("/sw.js",{scope:"/"})
      .then(reg=>{
        console.debug("[PWA] SW registrado:",reg.scope);
        reg.addEventListener("updatefound",()=>{
          const nw=reg.installing;
          if(!nw)return;
          nw.addEventListener("statechange",()=>{
            if(nw.state==="installed"&&navigator.serviceWorker.controller){
              // Há atualização disponível — exibe toast suave
              toast("Atualização disponível — recarregue ↻","");
            }
          });
        });
      })
      .catch(err=>console.warn("[PWA] SW falhou:",err));
  });
}

// ══════════════════════════════════════════
//  PWA INSTALL — FAB fixo (sempre visível)
// ══════════════════════════════════════════
let _deferredPrompt=null;

(function(){
  const s=document.createElement("style");
  s.textContent=`
  #pwa-fab{position:fixed;bottom:calc(72px + env(safe-area-inset-bottom));right:16px;z-index:9990;display:none;flex-direction:column;align-items:center;gap:4px;animation:pwaFabIn .35s cubic-bezier(.34,1.56,.64,1) both}
  #pwa-fab.visible{display:flex}
  @keyframes pwaFabIn{from{opacity:0;transform:scale(.4) translateY(24px)}to{opacity:1;transform:none}}
  #pwa-fab-btn{width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#1e3a8a,#1a56db);box-shadow:0 4px 22px rgba(26,86,219,.5);display:flex;align-items:center;justify-content:center;color:#fff;font-size:23px;transition:transform .18s,box-shadow .18s;position:relative}
  #pwa-fab-btn:hover{transform:scale(1.09);box-shadow:0 8px 32px rgba(26,86,219,.6)}
  #pwa-fab-btn:active{transform:scale(.94)}
  #pwa-fab-pulse{position:absolute;inset:-5px;border-radius:50%;border:2.5px solid rgba(26,86,219,.45);animation:pwaFabPulse 2.2s ease-out infinite}
  @keyframes pwaFabPulse{0%{transform:scale(1);opacity:1}100%{transform:scale(1.65);opacity:0}}
  #pwa-fab-label{font-size:10px;font-weight:700;color:#1a56db;background:#fff;padding:2px 8px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.15);white-space:nowrap;font-family:'DM Sans',sans-serif}
  #pwa-fab-tooltip{position:absolute;right:62px;bottom:50%;transform:translateY(50%);background:#0f172a;color:#fff;font-family:'DM Sans',sans-serif;border-radius:14px;padding:12px 16px;white-space:nowrap;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;opacity:0;transition:opacity .2s;font-size:13px;min-width:190px;display:flex;flex-direction:column;gap:3px}
  #pwa-fab-tooltip.show{opacity:1;pointer-events:auto}
  #pwa-fab-tooltip strong{font-size:13px;font-weight:800}
  #pwa-fab-tooltip small{font-size:11px;color:#94a3b8;line-height:1.5}
  #pwa-fab-tip-btn{margin-top:10px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;width:100%;font-family:'DM Sans',sans-serif;transition:opacity .15s}
  #pwa-fab-tip-btn:hover{opacity:.9}
  `;
  document.head.appendChild(s);
})();

function _createInstallFab(){
  if(document.getElementById("pwa-fab"))return;
  const fab=document.createElement("div");
  fab.id="pwa-fab";
  fab.innerHTML=`
    <div id="pwa-fab-tooltip">
      <strong>📲 Instalar H2BApply</strong>
      <small>Adicione à tela inicial<br>Funciona mesmo sem internet</small>
      <button id="pwa-fab-tip-btn">Instalar agora</button>
    </div>
    <button id="pwa-fab-btn" title="Instalar H2BApply">
      <span id="pwa-fab-pulse"></span>
      <i class="ti ti-download"></i>
    </button>
    <span id="pwa-fab-label">Instalar</span>
  `;
  document.body.appendChild(fab);
  const btn=document.getElementById("pwa-fab-btn");
  const tip=document.getElementById("pwa-fab-tooltip");
  btn.addEventListener("click",e=>{e.stopPropagation();tip.classList.toggle("show");});
  document.addEventListener("click",()=>tip.classList.remove("show"));
  document.getElementById("pwa-fab-tip-btn").addEventListener("click",async e=>{
    e.stopPropagation();
    tip.classList.remove("show");
    if(!_deferredPrompt){toast("Menu do navegador → 'Adicionar à tela inicial'","");return;}
    _deferredPrompt.prompt();
    const{outcome}=await _deferredPrompt.userChoice;
    _deferredPrompt=null;
    if(outcome==="accepted"){hideInstallFab();toast("Instalando... 🚀","g");}
  });
}
/* v110 (dono, 02/08): botão flutuante de instalar REMOVIDO ("não pode ficar
   sempre incomodando") — o caminho agora é a aba "Baixar App" na sidebar e
   no MENU ☰ (installAppClick). showInstallFab virou no-op de propósito:
   os listeners de beforeinstallprompt/appinstalled continuam capturando o
   _deferredPrompt, só não pintam mais nada flutuando. */
function showInstallFab(){}
function hideInstallFab(){}
async function installAppClick(){
  try{
    if(_deferredPrompt){
      _deferredPrompt.prompt();
      const c=await _deferredPrompt.userChoice;
      if(c&&c.outcome==="accepted")_deferredPrompt=null;
      return;
    }
  }catch(e){}
  const isIos=/iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone=window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches;
  if(standalone||window.navigator.standalone){toast("✅ O app já está instalado neste aparelho!","g");return;}
  toast(isIos?'📲 No iPhone: botão Compartilhar → "Adicionar à Tela de Início"':'📲 No Chrome: menu ⋮ → "Instalar aplicativo" (ou "Adicionar à tela inicial")',"g");
}
function showInstallBanner(){showInstallFab();}
function hideInstallBanner(){hideInstallFab();}

window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  _deferredPrompt=e;
  showInstallFab();
});
window.addEventListener("appinstalled",()=>{
  _deferredPrompt=null;
  hideInstallFab();
  toast("App instalado com sucesso! 🎉","g");
});
// iOS (não dispara beforeinstallprompt)
setTimeout(()=>{
  try{
    const isIos=/iphone|ipad|ipod/i.test(navigator.userAgent);
    if(isIos&&!window.navigator.standalone)showInstallFab();
  }catch{}
},2500);

// ── Estado de leitura persistido localmente E no servidor ──
// (v-2026: a lista/detalhe de inbox foi removida junto com a aba Respostas —
// GMAIL_SEND_ONLY no servidor nunca devolve e-mails reais — mas o servidor
// ainda manda readEmailIds no /api/status e esse estado local é mesclado
// nele no login; mantido só por isso.)
let _READ_IDS = new Set();
function _loadReadState(){
  try{const r=JSON.parse(localStorage.getItem("h2b-inbox-read")||"[]");_READ_IDS=new Set(r);}catch{}
}
function _loadReadStateFromServer(serverIds){
  // Chamado após login com os IDs do servidor — mescla com localStorage
  if(Array.isArray(serverIds)&&serverIds.length){
    serverIds.forEach(id=>_READ_IDS.add(id));
    _saveReadState(); // persiste o merge no localStorage também
  }
}
function _saveReadState(){try{localStorage.setItem("h2b-inbox-read",JSON.stringify([..._READ_IDS]));}catch{}}

function dismissNotifBanner(){
  localStorage.setItem("h2b-notif-banner-dismissed","1");
  const b=g("#inbox-notif-banner");if(b)b.style.display="none";
}

// v36: convite de push nos MOMENTOS de maior motivação (ligou o robô /
// enviou o pedido) — o banner antigo só vivia na aba Respostas, e todos os
// avisos importantes (robô parou, plano ativado, renovação, notícia) são
// push. Só aparece se a permissão ainda não foi decidida (default), e o
// clique é gesto do usuário (exigência dos navegadores).
function renderPushAsk(elId,msg){
  const el=g("#"+elId);if(!el)return;
  if(!("Notification" in window)||Notification.permission!=="default"){el.style.display="none";return;}
  el.style.display="block";
  el.innerHTML=`<div style="background:linear-gradient(135deg,#eff6ff,#e0e7ff);border:1.5px solid var(--blueb);border-radius:12px;padding:11px 13px;display:flex;align-items:center;gap:10px;margin:10px 0">
    <div style="font-size:20px;flex-shrink:0">🔔</div>
    <div style="flex:1;font-size:12px;color:var(--t2);line-height:1.45">${msg}</div>
    <button onclick="requestPushPermission();g('#${elId}').style.display='none'" style="background:var(--blue);color:#fff;border:none;border-radius:9px;padding:8px 12px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;flex-shrink:0">Ativar</button>
  </div>`;
}

async function requestPushPermission(){
  if(!("Notification" in window)){toast("Seu navegador não suporta notificações","r");return;}
  const p=await Notification.requestPermission().catch(()=>"denied");
  if(p==="granted"){
    _notifEnabled=true;try{localStorage.setItem("h2b-notif","1");}catch{}
    dismissNotifBanner();
    _renderNotifToggle();
    playPlaneSound();
    toast("🔔 Notificações ativadas! Você será avisado de confirmação de comprovante, status do automático e novidades.","g");
    // Testa notificação imediatamente
    try{new Notification("✅ H2BApply",{body:"Notificações ativadas! Você será avisado de confirmação de comprovante, status do automático e novidades.",icon:"/icon-192.png",tag:"h2b-test"});}catch{}
  }else if(p==="denied"){
    toast("Permissão negada. Ative manualmente nas configurações do navegador.","r");
  }
}

// ── Modal Envio Automático ──────────────────────────────
// ── Seleção de e-mails de envio no wizard do Automático ──────────────────
// Mostra principal + extras conectados; padrão: todos marcados. O rodízio no
// servidor alterna 1 a 1 SÓ entre os marcados (se o principal for desmarcado,
// ele nunca é usado — caso de conta principal bloqueada pelo Gmail).
function renderAutoSenders(){
  const box=g("#auto-senders-box"), list=g("#auto-senders-list");
  if(!box||!list) return;
  const extras=(U.senderEmails||[]).filter(s=>s.active!==false);
  const all=[{email:U.email,principal:true},...extras.map(s=>({email:s.email,principal:false,tokenExpired:!!s.tokenExpired}))];
  if(all.length<2){ box.style.display="none"; window._autoSenders=null; return; }
  box.style.display="block";
  list.innerHTML=all.map((s,i)=>`
    <label style="display:flex;align-items:center;gap:9px;background:var(--sf);border:1px solid var(--border2);border-radius:9px;padding:9px 11px;cursor:pointer">
      <input type="checkbox" class="auto-sender-chk" value="${esc(s.email)}" ${s.tokenExpired?"":"checked"} style="width:16px;height:16px;accent-color:#7c3aed">
      <span style="flex:1;min-width:0;font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.email)}</span>
      ${s.principal?'<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:5px;background:rgba(124,58,237,.15);color:#a78bfa">PRINCIPAL</span>':''}
      ${s.tokenExpired?'<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:5px;background:rgba(239,68,68,.15);color:#f87171">RECONECTAR</span>':''}
    </label>`).join("");
}
function getSelectedAutoSenders(){
  const chks=document.querySelectorAll(".auto-sender-chk:checked");
  if(!chks.length) return null;
  const sel=[...chks].map(c=>c.value);
  const extras=(U.senderEmails||[]).filter(s=>s.active!==false);
  // se marcou todos, não precisa mandar (comportamento padrão)
  if(sel.length===1+extras.length) return null;
  return sel;
}

let _autoModalHistoryPushed=false;
function _autoModalPushHistory(){
  // Empurra um estado de histórico ao abrir o modal, assim o botão Voltar do
  // Android/navegador fecha o modal em vez de sair do app ou trocar de tela.
  if(_autoModalHistoryPushed)return;
  _autoModalHistoryPushed=true;
  try{history.pushState({view:curView,modal:"auto"},"",location.pathname+location.search);}catch(e){}
}
async function openAutoModal(){
  // ── Se envio já está ativo: abre direto o painel de monitoramento ──
  if(U.autoJob && U.autoJob.active){
    const ov=g("#auto-modal-overlay");if(!ov)return;
    ov.style.display="block";
    document.body.style.overflow="hidden";
    _autoModalPushHistory();
    ov.addEventListener("touchmove",_autoModalTouchStop,{passive:false});
    setTimeout(()=>{
      updateAutoUI();
      if(typeof loadAutoLogs==="function")loadAutoLogs();
    },50);
    return;
  }

  // ── Sempre busca perfis frescos do servidor antes de verificar pré-requisitos ──
  try{ loadDynamicSheets(); }catch(e){}
  try{ renderAutoSenders(); }catch(e){}
  try{
    const pr=await fetch("/api/profiles",{credentials:"include"}).then(r=>r.json());
    UPROFILES=pr.profiles||[];
    if(U)U.profiles=UPROFILES;
  }catch(e){console.warn("[openAutoModal] falha ao buscar perfis:",e.message);}

  const profiles=UPROFILES.filter(p=>p.active!==false);
  const hasCv=DOCS.some(c=>(c.cvType||"resume")==="resume");

  if(profiles.length===0){
    if(confirm("Para usar o Envio Automático você precisa criar ao menos um perfil de currículo.\n\nDeseja criar agora?")){
      sv("profile");
      setTimeout(()=>{switchProfileTab("profiles");setTimeout(openProfileEditor,200);},100);
    }
    return;
  }
  // Verifica currículo — só bloqueia se NENHUM perfil tem PDF e DOCS também está vazio
  const _hasCvInProfiles=profiles.some(p=>p.resumeIdx||p.cvs?.some(c=>c.cvType==="resume"));
  if(!hasCv&&!_hasCvInProfiles){
    if(confirm("Você não tem currículo enviado. O envio automático precisa de um currículo vinculado a um perfil.\n\nDeseja criar/editar um perfil agora?")){
      sv("profile");
      setTimeout(()=>{switchProfileTab("profiles");setTimeout(openProfileEditor,200);},100);
    }
    return;
  }

  const ov=g("#auto-modal-overlay");if(!ov)return;
  ov.style.display="block";
  document.body.style.overflow="hidden";
  _autoModalPushHistory();
  // Mostra aviso Gmail apenas com 1 conta e se usuário não dispensou
  const warnEl=g("#gmail-risk-warn");
  if(warnEl){
    const numSenders=(U.senderEmails||[]).filter(s=>s.active!==false).length;
    const dismissed=localStorage.getItem("h2b-gmail-warn-dismissed")==="1";
    warnEl.style.display=(numSenders<1&&!dismissed)?"block":"none";
  }
  setTimeout(()=>{
    if(typeof loadAutoView==="function")loadAutoView();
    else if(typeof _renderAutoProfilesPanel==="function")_renderAutoProfilesPanel();
  },50);
  ov.addEventListener("touchmove",_autoModalTouchStop,{passive:false});
}

function _autoModalTouchStop(e){
  const inner=g("#auto-modal-inner");
  if(inner&&inner.contains(e.target))return; // permite scroll interno
  e.preventDefault();
}
function closeAutoModal(fromBack){
  const ov=g("#auto-modal-overlay");if(!ov)return;
  ov.style.display="none";
  document.body.style.overflow="";
  ov.removeEventListener("touchmove",_autoModalTouchStop);
  // Se fechou pelo X/clique fora (não pelo botão Voltar), consome o estado
  // empurrado no histórico pra não deixar uma entrada "fantasma" pra trás.
  if(_autoModalHistoryPushed){
    _autoModalHistoryPushed=false;
    if(!fromBack){try{history.back();}catch(e){}}
  }
  // Resetar estado visual para não mostrar dados antigos na próxima abertura
  const prog=g("#rc-prog2")||g("#rc-prog");if(prog)prog.style.display="none";
  const fill=g("#rc-prog-fill");if(fill)fill.style.width="0%";
  // Ocultar o banner gmail ao fechar (será reavaliado ao reabrir)
  const warn=g("#gmail-risk-warn");if(warn)warn.style.display="none";
}
// ── Interceptação sv("auto") → modal: consolidada na função sv() original ──

// ── Render Home ───────────────────────────────────────────
// ── Guia inteligente "Próximo passo" na home (aditivo, falha em silêncio) ──
// v89 (reestruturação parte 2 — Home): o subtítulo do hero era texto fixo
// ("Pronto para enviar candidaturas hoje?"). Agora mostra o STATUS REAL do
// usuário — robô trabalhando, quantas já enviou hoje, ou quantos envios
// ainda tem — informação de verdade em vez de enfeite. Falha em silêncio.
function renderHeroStatus(){
  try{
    const el=g("#home-hero-status");if(!el||!U.connected)return;
    const auto=U.autoJob;
    if(auto&&auto.active){
      const q=auto.queueSize||0;
      el.innerHTML=`🤖 Seu robô está <b style="color:#fff">trabalhando agora</b>${q?` — ${q} vaga${q>1?'s':''} na fila`:''}.`;
      return;
    }
    const sentToday=(U.todaySentManual||0)+(U.todaySentAuto||0);
    if(sentToday>0){
      el.innerHTML=`✅ Você já enviou <b style="color:#fff">${sentToday} candidatura${sentToday>1?'s':''}</b> hoje. Continue assim!`;
      return;
    }
    const rem=(U.manualRemaining!=null?U.manualRemaining:0);
    if(rem>0){
      el.innerHTML=`Você tem <b style="color:#fff">${rem} envio${rem>1?'s':''}</b> disponíve${rem>1?'is':'l'} hoje. Bora se candidatar? 🚀`;
      return;
    }
    el.textContent="Bem-vindo(a) de volta! Pronto para enviar muitas candidaturas hoje?";
  }catch(e){}
}
function renderNextStep(){
  const box=g("#home-next-step");if(!box)return;
  if(!U.connected){box.style.display="none";return;}
  const profiles=(UPROFILES&&UPROFILES.length?UPROFILES:(U.profiles||[])).filter(p=>p&&p.active!==false);
  const hasProfile=profiles.length>0;
  const hasCv = profiles.some(p=>p.resumeIdx||(p.cvs&&p.cvs.some(c=>c.cvType==="resume"))) || (typeof DOCS!=="undefined"&&DOCS&&DOCS.some(c=>(c.cvType||"resume")==="resume"));
  const sentToday=U.todaySentManual||0;
  const autoActive=!!(U.autoJob&&U.autoJob.active);
  let step=null;
  if(!hasProfile){
    step={icon:"📝",ic:"var(--blue)",bg:"linear-gradient(135deg,#eff6ff,#dbeafe)",bd:"var(--blueb)",title:t('ns1_t'),sub:t('ns1_s'),cta:t('ns1_c'),act:"goProfile"};
  } else if(!hasCv){
    step={icon:"📎",ic:"#d97706",bg:"linear-gradient(135deg,#fffbeb,#fef3c7)",bd:"#fcd34d",title:t('ns2_t'),sub:t('ns2_s'),cta:t('ns2_c'),act:"goProfile"};
  } else if(sentToday===0 && !autoActive){
    step={icon:"🚀",ic:"var(--green)",bg:"linear-gradient(135deg,#ecfdf5,#d1fae5)",bd:"var(--greenb)",title:t('ns3_t'),sub:t('ns3_s'),cta:t('ns3_c'),act:"goJobs"};
  } else if(U.plan==="free" && (U.manualRemaining||0)<=0){
    step={icon:"⭐",ic:"var(--purple)",bg:"linear-gradient(135deg,#f5f3ff,#ede9fe)",bd:"var(--purpleb)",title:t('ns4_t'),sub:t('ns4_s'),cta:t('ns4_c'),act:"goPlans"};
  } else if(U.plan!=="free" && !autoActive){
    step={icon:"🤖",ic:"var(--purple)",bg:"linear-gradient(135deg,#f5f3ff,#ede9fe)",bd:"var(--purpleb)",title:t('ns5_t'),sub:t('ns5_s'),cta:t('ns5_c'),act:"goAuto"};
  }
  if(!step){box.style.display="none";box.innerHTML="";return;}
  const acts={goProfile:"sv('profile');setTimeout(function(){try{switchProfileTab('profiles')}catch(e){}},120)",goJobs:"sv('jobs')",goPlans:"sv('plans')",goAuto:"sv('auto')"};
  box.style.display="block";
  box.innerHTML=`<div style="background:${step.bg};border:1.5px solid ${step.bd};border-radius:14px;padding:13px 14px;display:flex;align-items:center;gap:12px">
    <div style="width:42px;height:42px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;font-size:21px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.06)">${step.icon}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:10px;font-weight:800;color:${step.ic};text-transform:uppercase;letter-spacing:.05em;margin-bottom:1px">Próximo passo</div>
      <div style="font-size:14px;font-weight:800;color:var(--text);line-height:1.25">${step.title}</div>
      <div style="font-size:11.5px;color:var(--t2);line-height:1.35;margin-top:2px">${step.sub}</div>
    </div>
    <button onclick="${acts[step.act]}" style="background:${step.ic};color:#fff;border:none;border-radius:10px;padding:9px 13px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">${step.cta} →</button>
  </div>`;
}
// ── Card "pedido em análise" (2026-07) ──────────────────────────────────
// Antes: depois de mandar o comprovante, a única confirmação era uma tela
// que aparecia uma vez e sumia — se a pessoa fechasse o app e voltasse depois,
// não tinha mais nenhum lembrete de que o pagamento estava sendo revisado.
// A ativação continua manual (analisada por Andrio/Diego), então isso não
// acelera a aprovação — só deixa claro, sempre que a pessoa abrir o app, que
// o pedido está na fila e não foi esquecido. Cache simples em memória
// (_pendingOrderCache) pra não bater na API toda hora que a Home renderiza.
let _pendingOrderCache=undefined; // undefined=ainda não checou, null=checou e não tem pendente, obj=pendente
async function renderPendingOrderCard(){
  const box=g("#home-pending-order");if(!box)return;
  if(!U.connected){box.style.display="none";return;}
  if(_pendingOrderCache===undefined){
    box.style.display="none"; // evita "flash" enquanto busca
    try{
      const r=await fetch("/api/pedidos",{credentials:"include"});
      const d=await jsonSafe(r);
      const pend=(d?.pedidos||[]).find(p=>p.status==="pendente");
      _pendingOrderCache=pend||null;
    }catch(e){_pendingOrderCache=null;}
    if(curView==="home")renderPendingOrderCard(); // reexibe já com o dado (se ainda na Home)
    return;
  }
  if(!_pendingOrderCache){box.style.display="none";return;}
  const p=_pendingOrderCache;
  const planLbl={vip:"VIP Manual",vipro:"VIPro",doublepro:"DoublePro"}[p.plano]||p.plano||"seu pedido";
  const dt=p.createdAt?new Date(p.createdAt).toLocaleDateString("pt-BR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"";
  box.style.display="block";
  box.innerHTML=`<div style="background:linear-gradient(135deg,#fffbeb,#fef3c7);border:1.5px solid #fcd34d;border-radius:14px;padding:13px 14px;display:flex;align-items:center;gap:12px">
    <div style="width:42px;height:42px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;font-size:21px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.06)">⏳</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:10px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1px">Pedido em análise</div>
      <div style="font-size:14px;font-weight:800;color:var(--text);line-height:1.25">${esc(planLbl)} em revisão</div>
      <div style="font-size:11.5px;color:var(--t2);line-height:1.35;margin-top:2px">Enviado ${dt?"em "+dt:"recentemente"} · confirmação após revisão do admin · dúvidas: WhatsApp no rodapé</div>
    </div>
  </div>`;
}
// ══ ATIVIDADE RECENTE — últimos envios reais do HIST (nunca inventa: sem histórico, mostra o vazio honesto) ══
function renderHomeActivity(){
  const box=g("#home-activity-list");if(!box)return;
  const items=(HIST||[]).slice(0,5);
  if(!items.length){box.innerHTML=`<div style="font-size:12px;color:var(--t3);padding:10px 2px">Suas próximas candidaturas e novidades aparecem aqui.</div>`;return;}
  box.innerHTML=items.map((h,i)=>{
    const isAuto=h.type==="auto";
    const bb=i===items.length-1?"":"border-bottom:1px solid var(--border)";
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 2px;${bb}">
      <div style="width:32px;height:32px;border-radius:9px;background:${isAuto?"var(--purplel,#ede9fe)":"var(--greenl,#dcfce7)"};display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0">${isAuto?"🤖":"✈️"}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.job||"–")}${h.company?" · "+esc(h.company):""}</div>
        <div style="font-size:10.5px;color:var(--t3);margin-top:1px">${esc(h.date||"")}</div>
      </div>
    </div>`;
  }).join("");
}
function renderHome(){
  _showWelcome();
  try{renderHeroStatus();}catch(e){}
  try{renderHomeActivity();}catch(e){}
  try{renderNextStep();}catch(e){}
  try{renderPendingOrderCard();}catch(e){}
  // Stats — Vagas Disponíveis (cache de loadDynamicSheets) + Empresas Contatadas (HIST únicas)
  const sj=g("#home-stat-jobs");
  if(sj)sj.textContent=typeof window._sheetsTotalCount==="number"?window._sheetsTotalCount.toLocaleString("pt-BR"):"–";
  const sc=g("#home-stat-companies");
  if(sc){const uniq=new Set(HIST.map(h=>(h.company||"").trim().toLowerCase()).filter(Boolean));sc.textContent=uniq.size.toLocaleString("pt-BR");}
  const st2=g("#home-stat-total");if(st2)st2.textContent=(U.totalSent||HIST.length||0).toLocaleString("pt-BR");
  const sa2=g("#home-stat-auto");if(sa2)sa2.textContent=String(U.todaySentAuto??0);

  // ── Banner VIP expirando — DESATIVADO a pedido do Andrio (28/06/2026) ──
  // Estava fixo no topo (position:fixed) cobrindo o header → "atrapalhando".
  // A renovação continua disponível pela aba "Planos" e pelo card da Home,
  // então remover esta barra não tira o caminho de renovar. Para reativar,
  // basta restaurar o bloco de _daysLeft<=3 que estava aqui.
  const _vipBanner=g("#vip-expiry-banner");
  if(_vipBanner) _vipBanner.style.display="none";

  // Saudação por hora
  const hr=new Date().getHours();
  const gr=hr>=6&&hr<12?t('greet_m'):hr>=12&&hr<18?t('greet_t'):hr>=18?t('greet_n'):t('greet_d'); // 🌐 Etapa 1
  const gEl=g("#home-greeting");const nEl=g("#home-name");
  if(gEl)gEl.textContent=gr;
  if(nEl)nEl.textContent=U.name||U.email||"–";
  // Avatar
  const av=g("#home-avatar");if(av){if(U.picture){av.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;object-fit:cover">`;}else{av.textContent=(U.name||"?")[0].toUpperCase();}}
  // Atualizar avatar na bottom nav
  const bnAv=g("#bn-av");if(bnAv){if(U.picture){bnAv.innerHTML=`<img alt="" referrerpolicy="no-referrer" src="${esc(U.picture)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;}else{bnAv.innerHTML=`<span style="font-size:13px;font-weight:800;color:#fff">${esc((U.name||"?")[0].toUpperCase())}</span>`;}}
  // Badge do plano
  const planRow=g("#home-plan-row");if(planRow){
    let badges=planBadgeHTML();
    if(U.autoJob?.active)badges+=` <span class="tag" style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);color:var(--purple);border-color:var(--purpleb);font-size:10px;white-space:nowrap;animation:pulse 2s infinite">🤖 Auto Ativo</span>`;
    planRow.innerHTML=badges;
  }
  // Label plano em conta — layout do print usa subtítulo fixo; o nome do plano
  // já aparece no badge do hero (planBadgeHTML), então não sobrescreve mais.
  maybePromptReview(U.totalSent||HIST.length||0);
  // Card Auto
  const ac=g("#home-auto-card");const at=g("#home-auto-title");const as=g("#home-auto-sub");const ai=g("#home-auto-icon");
  if(ac){
    // v167: cor do card SEMPRE via classe (.finished/.inactive), nunca mais
    // style.background inline — uma classe antiga nunca deixa background
    // inline "grudado" pra trás, e o CSS (que já é !important) tem como
    // vencer de verdade em qualquer estado, incl. o "concluído" (verde).
    ac.style.background="";
    if(U.autoJob?.active){
      ac.className="home-auto-card";
      const qSz=U.autoJob.queueSize||0;
      const sentToday=U.todaySentAuto||0;
      const statusTxt=U.autoJob.status==="waiting_interval"?"⏳ Aguardando intervalo...":
                      U.autoJob.status==="sending"?"📤 Enviando agora...":
                      U.autoJob.status==="waiting_limit"?"📊 Limite atingido, retoma meia-noite":
                      "🟢 Ativo";
      if(at)at.textContent="🟢 Auto Ativo — "+statusTxt;
      if(as)as.textContent=`✅ ${sentToday} enviados hoje · 📬 ${qSz} na fila`;
      if(ai)ai.textContent="🤖";
    }else if(U.autoJob?.status==="finished"){
      ac.className="home-auto-card finished";
      if(at)at.textContent="✅ Envio Concluído!";
      if(as)as.textContent=`${U.autoJob.originalCount||0} vagas processadas. Toque para reiniciar.`;
      if(ai)ai.textContent="✅";
    }else{
      ac.className="home-auto-card inactive";
      if(at){at.textContent="🤖 Inicie o seu Automático";at.style.color="#fff";}
      if(as){as.innerHTML="Envie currículos enquanto você trabalha. Não garantimos a vaga — mas garantimos que seu currículo <strong>chegue ao empregador</strong>.";as.style.color="rgba(255,255,255,.92)";}
      if(ai)ai.textContent="🤖";
    }
  }
}

// ── Notificações ──────────────────────────────────────────
let _notifEnabled=false;
let _lastUnreadCount=-1;

function _loadNotifState(){
  try{_notifEnabled=localStorage.getItem("h2b-notif")==="1";}catch{}
  _renderNotifToggle();
}

function _renderNotifToggle(){
  const btn=g("#notif-toggle-btn");const dot=g("#notif-toggle-dot");const msg=g("#notif-status-msg");
  if(!btn)return;
  btn.style.background=_notifEnabled?"#057a55":"var(--border2)";
  if(dot)dot.style.transform=_notifEnabled?"translateX(24px)":"translateX(0)";
  if(msg){
    // v-2026: o site é só-envio (GMAIL_SEND_ONLY) e não lê a caixa de entrada
    // de ninguém — este alerta é só de comprovante/automático/novidades, nunca de
    // resposta de empregador (isso ficava contraditório com o texto fixo do
    // card, que já avisa "não avisamos quando a empresa responde").
    if(_notifEnabled){msg.style.color="var(--green)";msg.textContent="🛫 Ativado! Você será avisado de confirmação de comprovante, status do automático e novidades.";}
    else{msg.style.color="var(--t3)";msg.textContent="Toque para ativar alertas de confirmação de comprovante, status do automático e novidades.";}
  }
}


// ── Sons de notificação (6 opções) ──────────────────────────────
const SOUNDS = {
  aviao: { label: "✈️ Avião", desc: "Som de decolagem" }, // ⚠️ literal de propósito: t() aqui roda ANTES do LANG_DICT existir (TDZ) e mataria o app — a tradução é feita na hora de renderizar (_sndLabel/_sndDesc)
  ping:  { label: "🔔 Ping",  desc: "Sino suave" },
  chime: { label: "🎵 Chime", desc: "Melodia" },
  alert: { label: "📣 Alerta", desc: "Urgente" },
  suave: { label: "🌊 Suave",  desc: "Suave" },
  retro: { label: "👾 Retro",  desc: "Game" },
};
let _selectedSound = "aviao";
// 🌐 v137: tradução PREGUIÇOSA dos sons (na renderização, nunca no load)
function _sndLabel(key,s){return key==="aviao"?("✈️ "+t('snd_plane')):s.label;}
function _sndDesc(key,s){return key==="aviao"?t('snd_plane_d'):s.desc;}

function _loadSoundPref(){try{_selectedSound=localStorage.getItem("h2b-sound")||"aviao";}catch{}}
function _saveSoundPref(s){try{localStorage.setItem("h2b-sound",s);}catch{}}

function playNotifSound(soundKey){
  const s = soundKey || _selectedSound;
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const now=ctx.currentTime;
    if(s==="aviao"){
      // Som de avião original
      const osc=ctx.createOscillator();const gn=ctx.createGain();
      osc.connect(gn);gn.connect(ctx.destination);osc.type="sawtooth";
      osc.frequency.setValueAtTime(90,now);osc.frequency.linearRampToValueAtTime(300,now+0.7);osc.frequency.linearRampToValueAtTime(160,now+1.1);
      gn.gain.setValueAtTime(0,now);gn.gain.linearRampToValueAtTime(0.07,now+0.1);gn.gain.linearRampToValueAtTime(0.1,now+0.5);gn.gain.linearRampToValueAtTime(0,now+1.2);
      osc.start(now);osc.stop(now+1.2);
      const o2=ctx.createOscillator();const g2=ctx.createGain();o2.connect(g2);g2.connect(ctx.destination);
      o2.type="sine";o2.frequency.setValueAtTime(480,now+0.3);o2.frequency.linearRampToValueAtTime(900,now+0.85);
      g2.gain.setValueAtTime(0,now+0.3);g2.gain.linearRampToValueAtTime(0.05,now+0.5);g2.gain.linearRampToValueAtTime(0,now+1.1);
      o2.start(now+0.3);o2.stop(now+1.1);
    }else if(s==="ping"){
      // Sino suave — dois toques
      [0,0.35].forEach((t,i)=>{
        const o=ctx.createOscillator();const gn=ctx.createGain();o.connect(gn);gn.connect(ctx.destination);
        o.type="sine";o.frequency.value=880+(i*200);
        gn.gain.setValueAtTime(0.15,now+t);gn.gain.exponentialRampToValueAtTime(0.001,now+t+0.6);
        o.start(now+t);o.stop(now+t+0.7);
      });
    }else if(s==="chime"){
      // Melodia ascendente (dó ré mi)
      [261.6,329.6,392,523.3].forEach((freq,i)=>{
        const o=ctx.createOscillator();const gn=ctx.createGain();o.connect(gn);gn.connect(ctx.destination);
        o.type="triangle";o.frequency.value=freq;
        gn.gain.setValueAtTime(0.12,now+i*0.18);gn.gain.exponentialRampToValueAtTime(0.001,now+i*0.18+0.5);
        o.start(now+i*0.18);o.stop(now+i*0.18+0.6);
      });
    }else if(s==="alert"){
      // Urgente — bip duplo forte
      [0,0.2].forEach(t=>{
        const o=ctx.createOscillator();const gn=ctx.createGain();o.connect(gn);gn.connect(ctx.destination);
        o.type="square";o.frequency.value=1200;
        gn.gain.setValueAtTime(0.12,now+t);gn.gain.exponentialRampToValueAtTime(0.001,now+t+0.15);
        o.start(now+t);o.stop(now+t+0.18);
      });
    }else if(s==="suave"){
      // Suave — onda senoidal lenta
      const o=ctx.createOscillator();const gn=ctx.createGain();o.connect(gn);gn.connect(ctx.destination);
      o.type="sine";o.frequency.setValueAtTime(440,now);o.frequency.linearRampToValueAtTime(660,now+0.8);
      gn.gain.setValueAtTime(0,now);gn.gain.linearRampToValueAtTime(0.08,now+0.15);gn.gain.linearRampToValueAtTime(0,now+1.0);
      o.start(now);o.stop(now+1.1);
    }else if(s==="retro"){
      // Game — beep retrô
      [800,600,900,700].forEach((freq,i)=>{
        const o=ctx.createOscillator();const gn=ctx.createGain();o.connect(gn);gn.connect(ctx.destination);
        o.type="square";o.frequency.value=freq;
        gn.gain.setValueAtTime(0.07,now+i*0.12);gn.gain.exponentialRampToValueAtTime(0.001,now+i*0.12+0.1);
        o.start(now+i*0.12);o.stop(now+i*0.12+0.12);
      });
    }
  }catch(e){console.warn("Audio:",e);}
}

// Alias para manter compatibilidade
function playPlaneSound(){playNotifSound("aviao");}

// Renderiza seletor de sons na tela de Perfil
function renderSoundSelector(){
  const el=g("#sound-selector-wrap");if(!el)return;
  el.innerHTML=`<div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:8px">🎵 ${t('snd_title')}</div>
  <div class="sound-selector">
    ${Object.entries(SOUNDS).map(([key,s])=>`
      <button class="sound-option${_selectedSound===key?" selected":""}" onclick="selectSound('${key}')" id="sound-opt-${key}">
        <span class="sound-option-icon">${_sndLabel(key,s).split(" ")[0]}</span>
        <span class="sound-option-label">${_sndLabel(key,s).split(" ").slice(1).join(" ")}</span>
      </button>
    `).join("")}
  </div>`;
}
function selectSound(key){
  _selectedSound=key;_saveSoundPref(key);
  document.querySelectorAll(".sound-option").forEach(b=>b.classList.remove("selected"));
  g("#sound-opt-"+key)?.classList.add("selected");
  playNotifSound(key);
  toast(`${_sndLabel(key,SOUNDS[key])} ${t('snd_sel')}`,"g");
}

// ══════════════════════════════════════════════════════════
//  NOTIFICAÇÕES LOCAIS (Notification API do navegador)
//  v-2026: não existe backend de Web Push real nesta reconstrução (sem
//  rotas /api/push/*, sem lib web-push, sem VAPID configurado) — o alerta
//  funciona só enquanto o app está aberto/conectado (som + Notification()
//  local de comprovante/automático/novidades). Removido o subsistema de
//  subscription VAPID que só chamava rotas inexistentes no servidor.
// ══════════════════════════════════════════════════════════

// Hook: quando notificações são ativadas/desativadas
// ══════════════════════════════════════════════════════════
//  AUTO-REQUEST DE NOTIFICAÇÃO NO PRIMEIRO LOGIN
//  Solicita permissão automaticamente ao entrar pela 1ª vez,
//  de forma não-intrusiva. Compatível com Android e desktop.
// ══════════════════════════════════════════════════════════

// Chave usada para controle por conta (não por navegador)
function _pushPromptKey() {
  return "h2b-push-prompted-" + (U.email || "anon");
}
function _hasPushBeenPrompted() {
  try { return localStorage.getItem(_pushPromptKey()) === "1"; } catch { return false; }
}
function _markPushPrompted() {
  try { localStorage.setItem(_pushPromptKey(), "1"); } catch {}
}

// Solicita permissão de notificação (local — sem backend de push real)
async function _autoPushSetup() {
  if (!("Notification" in window)) return;
  if (!U.connected) return;

  // Se já foi solicitado para esta conta, não pergunta de novo
  if (_hasPushBeenPrompted()) return;

  // Aguarda um momento para o app estar completamente carregado
  await new Promise(r => setTimeout(r, 2500));
  if (!U.connected) return; // verificação dupla

  _markPushPrompted(); // marca imediatamente para não re-solicitar

  // Se já foi concedido em sessão anterior, só sincroniza o estado local
  if (Notification.permission === "granted") {
    _notifEnabled = true;
    try { localStorage.setItem("h2b-notif", "1"); } catch {}
    _renderNotifToggle();
    return;
  }

  // Se explicitamente negado, não re-solicita
  if (Notification.permission === "denied") return;

  // Solicita permissão via modal nativo do SO (primeiro login)
  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      _notifEnabled = true;
      try { localStorage.setItem("h2b-notif", "1"); } catch {}
      _renderNotifToggle();
      dismissNotifBanner();
      // Pequena confirmação visual, não intrusiva
      toast("🛫 Notificações ativadas! Você será avisado de confirmação de comprovante, status do automático e novidades.", "g");
    } else {
      // Usuário negou — respeita a decisão, não volta a perguntar
      console.debug("[push] Permissão negada pelo usuário.");
    }
  } catch (err) {
    console.warn("[push] requestPermission error:", err.message);
  }
}

// ── Ouve mensagens do Service Worker (ex: navigate do notificationclick) ──
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "navigate" && msg.url) {
      // Navega para a tela indicada pela notificação
      const url = new URL(msg.url, location.origin);
      const tab = url.searchParams.get("tab") || url.pathname.replace("/", "") || "";
      if (tab) {
        setTimeout(() => {
          sv(tab);
          // Se foi para respostas, toca o som selecionado
          if (tab === "respostas" && msg.sound) playNotifSound(msg.sound);
        }, 200);
      }
    }
  });
}


// ══════════════════════════════════════════════════════════
//  PRIMEIRO LOGIN — mensagem de boas-vindas única
//  Controlada por U.onboarded (persistido no banco).
//  Após completar perfil + CV, /api/onboard é chamado
//  e onboarded=true nunca mais exibe a mensagem.
// ══════════════════════════════════════════════════════════
function _showFirstLoginWelcome() {
  // Mostra modal de boas-vindas em vez de apenas banner
  setTimeout(() => {
    // Verifica novamente (pode ter sido onboarded na mesma sessão)
    if (U.onboarded) return;
    // Mostra o banner informativo persistente
    showBanner(
      "blue",
      "👋 Bem-vindo ao <strong>H2BApply</strong>! Configure seu <strong>Perfil</strong> e envie seu <strong>Currículo (PDF)</strong> para começar.",
      "sv('profile')"
    );
  }, 900);
}

// ── Inicialização ─────────────────────────────────────────
_loadReadState();
_loadNotifState();
_loadSoundPref();
// Solicita push no primeiro login (executado após checkStatus carregar U)
setTimeout(()=>{ if(U.connected) _autoPushSetup().catch(()=>{}); }, 1000);

// (Captura de ?ref= removida — programa de indicação encerrado, KB-059)

;
/* ═══ bloco extraído ═══ */

/* ════ PATCH SCRIPT: Auto demo + Login fixes ════ */

// ── Login modal: já corrigido nativamente, patch removido ──

// ── Inject auto demo after the "como funciona" section ──
(function injectAutoDemo() {
  function buildDemo() {
    const howSection = document.querySelector('.ln-section.ln-how');
    if (!howSection || document.getElementById('auto-demo-injected')) return;

    const demo = document.createElement('div');
    demo.id = 'auto-demo-injected';
    demo.className = 'auto-demo-section';
    demo.innerHTML = `
      <div class="auto-demo-inner">
        <div style="text-align:center;margin-bottom:32px">
          <div class="auto-demo-label">✨ Veja em ação</div>
          <h2 class="auto-demo-title">O automático trabalhando por você</h2>
          <p class="auto-demo-sub">Em loop contínuo, 24 horas por dia, enquanto você dorme</p>
        </div>
        <div class="demo-stage">
          <!-- Phone mockup -->
          <div class="demo-phone" id="demo-phone">
            <div class="demo-phone-notch"></div>
            <!-- Frame 1: Vagas -->
            <div class="demo-frame active" id="df1">
              <div class="df-header"><span>🔍</span> Vagas disponíveis</div>
              <div class="df-job-list">
                <div class="df-jcard" id="dj1">
                  <div class="df-jcard-title">Landscaper / Gardener</div>
                  <div class="df-jcard-co">Green Valley Inc — FL, USA</div>
                </div>
                <div class="df-jcard" id="dj2">
                  <div class="df-jcard-title">Housekeeper / Resort</div>
                  <div class="df-jcard-co">Marriott Hotels — FL, USA</div>
                </div>
                <div class="df-jcard" id="dj3" style="opacity:0.4">
                  <div class="df-jcard-title">Farm Worker H-2A</div>
                  <div class="df-jcard-co">Sunrise Farms — CA, USA</div>
                </div>
              </div>
            </div>
            <!-- Frame 2: Compondo email -->
            <div class="demo-frame" id="df2">
              <div class="df-header"><span>✍️</span> Compondo candidatura</div>
              <div class="df-email-area">
                <div class="df-email-field">
                  <div class="df-email-label">PARA</div>
                  <div class="df-typing-text" id="dt-to">hr@greenvalley.com</div>
                </div>
                <div class="df-email-field">
                  <div class="df-email-label">ASSUNTO</div>
                  <div class="df-typing-text" id="dt-sub">Application – Landscaper H-2B</div>
                </div>
                <div class="df-email-field" style="flex:1">
                  <div class="df-email-label">MENSAGEM</div>
                  <div class="df-typing-text" id="dt-body">Hello! My name is João Silva, I'm from Brazil and I'm very interested in the Landscaper position...</div>
                </div>
                <div class="df-send-flash" id="df-send-btn">
                  <span>🚀</span> Enviando candidatura...
                </div>
              </div>
            </div>
            <!-- Frame 3: Enviado! -->
            <div class="demo-frame" id="df3">
              <div class="df-header"><span>✅</span> Candidatura enviada!</div>
              <div class="df-success-screen">
                <div class="df-success-icon">✓</div>
                <div class="df-success-count" id="demo-count">247</div>
                <div class="df-success-lbl">candidaturas enviadas hoje</div>
                <div class="df-success-ticker" id="demo-ticker"></div>
              </div>
            </div>
            <!-- Cursor -->
            <div class="demo-cursor" id="demo-cursor" style="top:60px;left:40px;opacity:0"></div>
          </div>
          <!-- Stats aside -->
          <div class="demo-stats-aside">
            <div class="demo-stat-card">
              <div class="demo-stat-num" id="demo-live-count">0</div>
              <div class="demo-stat-lbl">candidaturas automáticas agora</div>
            </div>
            <div class="demo-feats-list">
              <div class="demo-feat">
                <div class="demo-feat-icon" style="background:rgba(16,185,129,0.15);color:#10b981">🤖</div>
                <span>Funciona com o celular desligado</span>
              </div>
              <div class="demo-feat">
                <div class="demo-feat-icon" style="background:rgba(59,130,246,0.15);color:#60a5fa">📧</div>
                <span>Envia pelo seu próprio Gmail</span>
              </div>
              <div class="demo-feat">
                <div class="demo-feat-icon" style="background:rgba(245,158,11,0.15);color:#fbbf24">🛡️</div>
                <span>Anti-duplicata inteligente</span>
              </div>
              <div class="demo-feat">
                <div class="demo-feat-icon" style="background:rgba(139,92,246,0.15);color:#a78bfa">🎯</div>
                <span>Nota de compatibilidade em cada vaga</span>
              </div>
            </div>
            <button class="ln-cta-btn" onclick="openAuthGate('choice')" style="font-size:14px;padding:12px 20px;width:100%">
              <i class="ti ti-bolt" style="font-size:18px"></i>
              Ativar o automático agora
            </button>
          </div>
        </div>
      </div>
    `;
    howSection.insertAdjacentElement('afterend', demo);
    startDemoAnimation();
  }

  function startDemoAnimation() {
    let step = 0;
    const frames = ['df1','df2','df3'];
    let counter = 247;
    let liveCounter = 0;

    // Animate live counter
    const liveEl = document.getElementById('demo-live-count');
    function animLive() {
      if (!liveEl) return;
      liveCounter = Math.floor(Math.random() * 40) + 150;
      liveEl.textContent = liveCounter.toLocaleString('pt-BR');
      setTimeout(animLive, 2000 + Math.random() * 3000);
    }
    animLive();

    function showFrame(idx) {
      frames.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', i === idx);
      });
    }

    function runCursor(x, y, delay) {
      return new Promise(resolve => {
        setTimeout(() => {
          const cursor = document.getElementById('demo-cursor');
          if (cursor) {
            cursor.style.opacity = '1';
            cursor.style.left = x + 'px';
            cursor.style.top = y + 'px';
          }
          setTimeout(resolve, 350);
        }, delay);
      });
    }

    function typeText(elId, delay) {
      return new Promise(resolve => {
        setTimeout(() => {
          const el = document.getElementById(elId);
          if (el) {
            el.style.width = '0';
            el.classList.add('typing');
            setTimeout(() => {
              el.classList.remove('typing');
              el.style.width = '100%';
              resolve();
            }, 1300);
          } else { resolve(); }
        }, delay);
      });
    }

    async function phase1() {
      showFrame(0);
      const cursor = document.getElementById('demo-cursor');
      if (cursor) cursor.style.opacity = '0';
      await new Promise(r => setTimeout(r, 800));

      // Cursor moves to first job
      await runCursor(30, 90, 200);
      await runCursor(30, 95, 300);
      await new Promise(r => setTimeout(r, 400));

      // Highlight first card
      const dj1 = document.getElementById('dj1');
      if (dj1) {
        dj1.style.background = 'rgba(37,99,235,0.2)';
        dj1.style.borderColor = 'rgba(37,99,235,0.4)';
        dj1.style.transition = 'all 0.3s';
      }
      await new Promise(r => setTimeout(r, 600));
    }

    async function phase2() {
      showFrame(1);
      const cursor = document.getElementById('demo-cursor');
      if (cursor) { cursor.style.opacity = '1'; cursor.style.left = '40px'; cursor.style.top = '70px'; }

      // Reset typing texts
      ['dt-to','dt-sub','dt-body'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.width = '0'; el.classList.remove('typing'); }
      });
      const sendBtn = document.getElementById('df-send-btn');
      if (sendBtn) { sendBtn.classList.remove('visible'); }

      await new Promise(r => setTimeout(r, 200));
      await typeText('dt-to', 0);
      await typeText('dt-sub', 300);
      await typeText('dt-body', 400);

      // Show send button
      await new Promise(r => setTimeout(r, 400));
      await runCursor(110, 220, 0);
      if (sendBtn) sendBtn.classList.add('visible');
      await new Promise(r => setTimeout(r, 800));
    }

    async function phase3() {
      showFrame(2);
      counter++;
      const countEl = document.getElementById('demo-count');
      if (countEl) countEl.textContent = counter.toLocaleString('pt-BR');

      const ticker = document.getElementById('demo-ticker');
      if (ticker) {
        const items = [
          { icon: '✅', text: 'Green Valley Inc — enviado!' },
          { icon: '📧', text: 'hr@greenvalley.com' },
          { icon: '⚡', text: 'Próxima vaga em 2 min...' },
        ];
        ticker.innerHTML = '';
        items.forEach((item, i) => {
          const div = document.createElement('div');
          div.className = 'df-tick';
          div.style.animationDelay = (i * 0.15) + 's';
          div.innerHTML = `<span>${item.icon}</span><span>${item.text}</span>`;
          ticker.appendChild(div);
        });
      }
      await new Promise(r => setTimeout(r, 2200));

      // Reset dj1 highlight
      const dj1 = document.getElementById('dj1');
      if (dj1) { dj1.style.background = ''; dj1.style.borderColor = ''; }
    }

    async function loop() {
      try {
        await phase1();
        await phase2();
        await phase3();
      } catch(e) {}
      setTimeout(loop, 500);
    }

    setTimeout(loop, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildDemo);
  } else {
    buildDemo();
  }
})();

// ── Home stat counts — updated via renderHome() which already handles this ──

console.debug('[H2BApply Patch] ✅ Login, demo animações aplicadas');

;
/* ═══ bloco extraído ═══ */

var _gwmTimer=null;
// Arma (ou re-arma) a leitura obrigatória: 7s de contagem + checkbox antes de liberar o botão.
// SEMPRE que o modal #gwm for exibido, esta função DEVE ser chamada — é ela que inicia o timer.
function _gwmArm(){
  var ck=document.getElementById("gwm-check");if(ck)ck.checked=false;
  var t=7,btn=document.getElementById("gwm-ok");
  if(btn){btn.disabled=true;btn.style.background="#cbd5e1";btn.style.cursor="not-allowed";btn.innerHTML='Leia acima… <span id="gwm-timer">7</span>s';}
  var el=document.getElementById("gwm-timer");
  clearInterval(_gwmTimer);
  window._gwmTimeOk=false;
  _gwmTimer=setInterval(function(){
    t--;if(el)el.textContent=String(t);
    if(t<=0){clearInterval(_gwmTimer);_gwmTimer=null;window._gwmTimeOk=true;gwmUpdateBtn();}
  },1000);
}
// 🔒 ordem do dono, 12/09/2026: este modal não é mais sobre LOGIN (login
// virou usuário+senha, sem Google nenhum) — é sobre CONECTAR o Gmail de
// ENVIO (/oauth/connect-send), que ainda passa pela tela de consentimento
// real do Google (com o aviso de app não-verificado) e continua exigindo
// o aceite de que o e-mail escolhido é permanente.
var _cgfsFromTab="plans";
function showGmailConnectWarnModal(fromTab){
  _cgfsFromTab=fromTab||"plans";
  fetch("/api/warmup",{credentials:"include"}).catch(function(){});
  var m=document.getElementById("gwm");
  // 🔒 se o modal de aviso obrigatório não existir na página (HTML velho em
  // cache, id renomeado por engano), NUNCA pular direto pro Google sem
  // consentimento — isso é o exato risco que este modal existe pra evitar.
  // Falha visível + recarrega a página (pega a versão nova do HTML) em vez
  // de seguir em silêncio.
  if(!m){toast("⚠️ Não foi possível carregar o aviso de conexão do Gmail. Atualizando a página…","r",5000);setTimeout(function(){location.reload();},1200);return;}
  m.style.display="flex";
  _gwmArm();
}
function gwmUpdateBtn(){
  var btn=document.getElementById("gwm-ok"),ck=document.getElementById("gwm-check");
  if(!btn)return;
  // Defesa em profundidade: se o modal foi exibido por algum caminho que NÃO armou o timer
  // (_gwmTimeOk ainda undefined e nenhum timer rodando), arma agora em vez de travar para sempre.
  if(window._gwmTimeOk===undefined&&!_gwmTimer){_gwmArm();return;}
  var ok=window._gwmTimeOk&&ck&&ck.checked;
  btn.disabled=!ok;
  if(ok){btn.style.background="linear-gradient(135deg,#4f46e5,#7c3aed)";btn.style.cursor="pointer";btn.innerHTML="✅ Entendi — Conectar Gmail";}
  else if(window._gwmTimeOk){btn.style.background="#cbd5e1";btn.style.cursor="not-allowed";btn.innerHTML="Marque a caixinha acima ☝️";}
}
function gwmGo(){
  var ck=document.getElementById("gwm-check");
  if(!window._gwmTimeOk||!ck||!ck.checked)return;
  document.getElementById("gwm").style.display="none";
  gaEvent("gmail_connect_send_start",{fromTab:_cgfsFromTab});
  location.href="/oauth/connect-send?from="+encodeURIComponent(_cgfsFromTab);
}

;
/* ═══ bloco extraído ═══ */

var _termsChecked=false,_termsScrolled=false,_termsCallback=null;
function showTerms(callback){
  try{
    // Verificar sessionStorage (válido para esta sessão do browser)
    var sessionFlag = sessionStorage.getItem("h2b_terms_session");
    if(sessionFlag === "accepted"){if(callback)callback();return;}
    // Aceitar v3 OU v2 (não forçar quem já aceitou versão anterior)
    for(var key of ["h2b_terms_v3","h2b_terms_v2","h2b_terms_v1"]){
      var a = localStorage.getItem(key);
      if(a){
        try{
          var d=JSON.parse(a);
          // v3: válido 30 dias. v2/v1: válido 365 dias (respeitar aceite antigo)
          var maxAge = key==="h2b_terms_v3" ? 30*86400000 : 365*86400000;
          if(d.accepted && d.ts && (Date.now()-d.ts) < maxAge){
            sessionStorage.setItem("h2b_terms_session","accepted");
            if(callback)callback();return;
          }
        }catch(e2){}
      }
    }
  }catch(e){}
  _termsCallback=callback||null;_termsChecked=false;_termsScrolled=false;
  var chk=document.getElementById("terms-checkbox");if(chk)chk.checked=false;
  var btn=document.getElementById("terms-accept");if(btn)btn.classList.remove("active");
  var hint=document.getElementById("terms-scroll-hint");if(hint)hint.style.display="";
  var row=document.getElementById("terms-check-row");if(row)row.style.opacity=".5";
  var overlay=document.getElementById("terms-overlay");if(overlay)overlay.style.display="flex";
  var body=document.getElementById("terms-body");
  if(body){
    body.scrollTop=0;
    _termsScrolled=true;
    var h=document.getElementById("terms-scroll-hint");if(h)h.style.display="none";
    var r=document.getElementById("terms-check-row");if(r)r.style.opacity="1";
  }
}
function termsToggleCheck(){
  // Sempre habilitar — scroll não é obrigatório
  _termsScrolled = true;
  // Ler estado REAL do checkbox para evitar dessincronização
  var chk=document.getElementById("terms-checkbox");
  if(chk) _termsChecked = chk.checked = !chk.checked;
  else _termsChecked = !_termsChecked;
  var btn=document.getElementById("terms-accept");
  if(btn){
    if(_termsChecked){
      btn.classList.add("active");
      btn.style.cursor="pointer";
      btn.style.pointerEvents="auto";
    } else {
      btn.classList.remove("active");
      btn.style.cursor="not-allowed";
    }
  }
  // Remover hint de rolagem se ainda existir
  var hint=document.getElementById("terms-scroll-hint");
  if(hint) hint.style.display="none";
  var row=document.getElementById("terms-check-row");
  if(row) row.style.opacity="1";
}
function termsAccept(){
  // Aceitar independente de _termsChecked — ler estado real do checkbox
  var chk=document.getElementById("terms-checkbox");
  if(chk && chk.checked) _termsChecked=true;
  if(!_termsChecked){
    // Forçar aceite com um clique extra — marcar e ativar
    _termsChecked=true;
    if(chk) chk.checked=true;
    var btn=document.getElementById("terms-accept");
    if(btn) btn.classList.add("active");
  }
  try{
    localStorage.setItem("h2b_terms_v3",JSON.stringify({
      accepted:true,ts:Date.now(),date:new Date().toISOString(),version:"3.0",
      ua:navigator.userAgent.slice(0,200)
    }));
    sessionStorage.setItem("h2b_terms_session","accepted");
    fetch("/api/accept-terms",{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({version:"3.0",ts:Date.now()})
    }).catch(function(){});
  }catch(e){}
  var overlay=document.getElementById("terms-overlay");if(overlay)overlay.style.display="none";
  if(_termsCallback)_termsCallback();
  _termsCallback=null;
}
function termsDecline(){
  var overlay=document.getElementById("terms-overlay");if(overlay)overlay.style.display="none";
  _termsCallback=null;
  if(typeof toast==="function")toast("Você precisa aceitar os Termos para usar a H2BApply.","r");
}
/* ═══ bloco extraído ═══ */

var _tip=null;
function showTip(el,html){
  if(_tip){_tip.remove();_tip=null;}
  var t=document.createElement("div");
  t.className="tip-box";t.innerHTML=html;
  document.body.appendChild(t);_tip=t;
  var r=el.getBoundingClientRect(),tw=260;
  var top=r.top>150?r.top-8-120:r.bottom+8;
  var left=Math.min(Math.max(r.left-tw/2+r.width/2,8),window.innerWidth-tw-8);
  t.style.cssText+="top:"+top+"px;left:"+left+"px;width:"+tw+"px;position:fixed";
  setTimeout(function(){document.addEventListener("click",function _hd(){if(_tip){_tip.remove();_tip=null;}document.removeEventListener("click",_hd);},{once:true});},50);
}

// Banner boas-vindas (1ª vez)
function _showWelcome(){
  try{if(localStorage.getItem("h2b_ok"))return;}catch(e){}
  // v88 (reestruturação parte 1 — Home): o checklist de "primeiros passos"
  // só faz sentido pra quem AINDA não começou. Usuário ESTABELECIDO (já tem
  // perfil ativo E já enviou pelo menos 1 candidatura) tem a Home limpa —
  // sem esse card repetindo o que o Tour e o guia "Como usar" já explicam.
  // Quem ainda não enviou (mesmo com perfil) continua vendo o guia rápido.
  try{
    var _profs=((typeof UPROFILES!=="undefined"&&UPROFILES.length)?UPROFILES:((U&&U.profiles)||[])).filter(function(p){return p&&p.active!==false;});
    var _estabelecido=_profs.length>0 && (U&&(U.totalSent||0)>0);
    if(_estabelecido){try{localStorage.setItem("h2b_ok","1");}catch(e){} return;}
  }catch(e){}
  var hdr=document.querySelector(".home-header");
  if(!hdr||document.getElementById("h2b-welcome"))return;
  var b=document.createElement("div");
  b.id="h2b-welcome";
  b.style.cssText="margin:12px 14px 0;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-radius:14px;padding:16px;position:relative";
  var close=document.createElement("button");
  close.style.cssText="position:absolute;top:8px;right:10px;background:none;border:none;color:rgba(255,255,255,.8);font-size:20px;cursor:pointer;padding:0;line-height:1";
  close.textContent="×";
  close.onclick=function(){b.remove();try{localStorage.setItem("h2b_ok","1");}catch(e){}};
  b.appendChild(close);
  // 🌐 v137: checklist com data-i18n — se a língua trocar DEPOIS do banner
  // nascer (boot pode renderizar antes da preferência do servidor chegar),
  // o applyLang() retraduz sozinho em vez de deixar PT preso na tela.
  var steps=[["hs1",t('hs1')],["hs2",t('hs2')],["hs3",t('hs3')],["hs4",t('hs4')]];
  var inner=document.createElement("div");
  inner.innerHTML="<div style='font-size:15px;font-weight:800;margin-bottom:10px'>🚀 <span data-i18n='hs_t'>"+t('hs_t')+"</span></div><div style='display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.55'>"+
    steps.map(function(s,i){return "<div style='display:flex;gap:8px'><span style='background:rgba(255,255,255,.25);border-radius:50%;width:20px;height:20px;min-width:20px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800'>"+(i+1)+"</span><span data-i18n='"+s[0]+"'>"+s[1]+"</span></div>";}).join("")+
    "</div>";
  b.appendChild(inner);
  hdr.insertAdjacentElement("afterend",b);
}

;
/* ═══ bloco extraído ═══ */

let _tourIdx=0,_tourN=0;
function _tourSlides(){return document.querySelectorAll("#tour-track .tour-slide");}
function _tourRender(){
  const dots=g("#tour-dots");if(dots)dots.innerHTML=Array.from({length:_tourN},(_,i)=>`<span class="tour-dot${i===_tourIdx?" on":""}" onclick="tourGo(${i})" style="cursor:pointer"></span>`).join("");
  const pv=g("#tour-prev");if(pv)pv.style.visibility=_tourIdx>0?"visible":"hidden";
  const nx=g("#tour-next");if(nx){if(_tourIdx>=_tourN-1){nx.textContent="Concluir ✓";nx.onclick=closeTour;}else{nx.textContent="Avançar →";nx.onclick=()=>tourGo(_tourIdx+1);}}
}
function tourGo(i){
  const tk=g("#tour-track");if(!tk)return;
  _tourIdx=Math.max(0,Math.min(_tourN-1,i));
  tk.scrollTo({left:_tourIdx*tk.clientWidth,behavior:"smooth"});
  _tourRender();
}
function openTour(){
  const ov=g("#tour-overlay");if(!ov)return;
  _tourN=_tourSlides().length;_tourIdx=0;
  ov.classList.remove("gone");
  const tk=g("#tour-track");if(tk){tk.scrollTo({left:0});tk.onscroll=()=>{const i=Math.round(tk.scrollLeft/Math.max(1,tk.clientWidth));if(i!==_tourIdx){_tourIdx=i;_tourRender();}};}
  _tourRender();
  try{localStorage.setItem("h2b_tour_v1","1");}catch(e){}
}
function closeTour(){g("#tour-overlay")?.classList.add("gone");}
// 📖 v160 — Central de Tutoriais (aba Tutorial): busca local sobre os 28
// passo a passos — sem acento/caixa, casa no título e nas palavras-chave
// (data-kw). Buscando, os que casam já abrem sozinhos; limpou, tudo fecha.
// O conteúdo editorial (28 partes + 29 fotos) mora em /tutorial-conteudo e só
// baixa quando a aba abre — o index fica leve e a catraca de tradução das
// views continua zerada (conteúdo longo em PT é a mesma classe do /como-usar).
let _tutLoaded=false;
async function loadTutorial(){
  if(_tutLoaded)return;
  const box=g("#tut-conteudo");if(!box)return;
  try{
    const r=await fetch("/tutorial-conteudo",{cache:"no-cache"});
    if(!r.ok)throw new Error("HTTP "+r.status);
    box.innerHTML=await r.text();
    _tutLoaded=true;
    tutFiltra();
  }catch(e){
    box.innerHTML='<div style="text-align:center;color:#b45309;font-size:13px;padding:26px 16px">⚠️ Não deu pra carregar os tutoriais agora. Confira a internet e abra a aba de novo.</div>';
  }
}
function _tutNorm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");}
function tutFiltra(){
  const q=_tutNorm(g("#tut-busca")?.value).trim();
  let vis=0;
  document.querySelectorAll("#v-tutorial .tut-d").forEach(d=>{
    const hay=_tutNorm((d.querySelector("summary")?.textContent||"")+" "+(d.getAttribute("data-kw")||""));
    const mostra=!q||hay.includes(q);
    d.classList.toggle("tut-oculto",!mostra);
    if(mostra)vis++;
    if(q&&mostra)d.open=true;else if(!q)d.open=false;
  });
  document.querySelectorAll("#v-tutorial .tut-bloco").forEach(b=>{
    const tem=[...b.querySelectorAll(".tut-d")].some(d=>!d.classList.contains("tut-oculto"));
    b.classList.toggle("tut-oculto",!tem);
  });
  g("#tut-vazio")?.classList.toggle("tut-oculto",vis>0);
}
// Auto-abre UMA vez após o login — nunca por cima do onboarding/termos
setTimeout(function(){
  try{
    if(localStorage.getItem("h2b_tour_v1"))return;
    if(typeof U==="undefined"||!U.connected)return;
    const ob=document.getElementById("onboarding-overlay");
    if(ob&&ob.style.display==="flex")return; // onboarding na frente — o tour fica pra próxima visita
    const to=document.getElementById("terms-overlay");
    if(to&&to.style.display==="flex")return;
    // v167 (bug real, auditoria 08/09/2026): #tour-overlay tem z-index:998,
    // MUITO acima do z-index:200 genérico de TODOS os outros modais (.overlay
    // — inclui #profile-editor-overlay, #modal de vaga, etc). Sem esta checagem,
    // o tour abria em cima do editor de perfil (ex.: usuário editando no
    // celular quando os 3.5s batem) e cobria a tela inteira, deixando o botão
    // "Salvar Perfil" fisicamente inclicável até o usuário achar o X do tour —
    // sem perder o texto, mas travando o salvamento sem explicação nenhuma.
    const outroModalAberto=[...document.querySelectorAll(".overlay")].some(el=>el.id!=="tour-overlay"&&!el.classList.contains("gone"));
    // Como openTour() só marca h2b_tour_v1 quando roda de verdade, pular aqui
    // não perde o tour pra sempre — ele volta a tentar na próxima visita.
    if(outroModalAberto)return;
    openTour();
  }catch(e){}
},3500);

;
/* ═══ bloco extraído ═══ */

// ════════════════════════════════════════════════════
//  NOVA FUNCIONALIDADES v14+
// ════════════════════════════════════════════════════

// ── Profile: seções da tela única (v168) ──
// A Perfil virou UMA TELA SÓ (ordem do dono) — sem sub-abas alternadas por
// display:none/block. Esta função foi MANTIDA com a mesma assinatura porque
// ~20 lugares no app inteiro chamam switchProfileTab('profiles'|'admin'|'me')
// de fora da Perfil (Home, tour, callback de Gmail extra, modais de "criar
// perfil"...) — em vez de recriar cada call site, ela agora (a) dispara a
// mesma renderização que a seção precisa (renderProfiles/renderAdminTab, que
// já existiam) e (b) rola a tela até a seção certa com scrollIntoView.
function switchProfileTab(tab){
  // "docs" e "stats" não existem mais (docs virou parte de "profiles";
  // stats — aba "Números", gamificação — foi removida por completo no v168)
  if(tab==="docs"||tab==="stats") tab="profiles";
  if(tab==="profiles"){
    // v52-FIX: chamava uma função de nome antigo que não existia mais
    // (renomeada pra renderProfiles num refactor) — todo clique estourava
    // ReferenceError e o contador da seção nunca atualizava.
    renderProfiles();
    _updateProfileTabCount();
  } else if(tab==="admin"){
    renderAdminTab();
    const det=g("#pf-admin-details");if(det)det.open=true;
  }
  const secId=tab==="profiles"?"pf-sec-profiles":tab==="admin"?"pf-sec-admin":"pf-sec-me";
  const sec=g("#"+secId);
  if(sec)sec.scrollIntoView({behavior:"smooth",block:"start"});
}

// ═══════════════════════════════════════════
//  PAINEL ADMIN — ABA EXCLUSIVA
// ═══════════════════════════════════════════
let _adminSettings = {}; // cache local das configurações admin

function renderAdminTab(){
  if(!U.isAdmin)return;
  // Mostrar a seção (v168: virou seção da tela única, não mais aba)
  const sec=g("#pf-sec-admin");
  if(sec)sec.style.display="";
  // 🔒 v172: admin também precisa de /oauth/connect-send pra ter gmail.send —
  // login parou de conceder isso automaticamente pra TODO MUNDO. Sem card
  // visível aqui, o admin não teria como saber que precisa conectar (e o
  // aviso de "pedido novo" por e-mail simplesmente nunca sairia).
  const mgCard=g("#adm-mygmail-card");
  if(mgCard)mgCard.style.display=U.gmailConnected?"none":"block";
  // Carregar settings do servidor se ainda não carregamos
  _loadAdminSettings();
}

async function _loadAdminSettings(){
  try{
    const r=await fetch("/api/admin/my-settings",{credentials:"include"});
    const d=await r.json();
    if(d.ok){
      _adminSettings=d.adminSettings||{};
      U.adminSettings=_adminSettings; // sincroniza com U global
      _renderAdminForm();
    }
  }catch(e){console.warn("[admin-tab]",e.message);}
}

function _renderAdminForm(){
  // Intervalo — 🎯 v172b (ordem do dono, 12/09/2026): padrão do admin virou
  // 5min (300s), não 3min (180s) — o mesmo default usado pelo servidor
  // (mod-engine-core.js) quando adminSettings.intervalSecs não foi customizado.
  const inp=g("#adm-interval");
  if(inp)inp.value=_adminSettings.intervalSecs||300;
  updateAdminIntervalLabel();
  // Senders
  _renderAdminSenders();
}

function updateAdminIntervalLabel(){
  const inp=g("#adm-interval");const lbl=g("#adm-interval-label");
  if(!inp||!lbl)return;
  const v=parseInt(inp.value)||300;
  const mins=Math.floor(v/60);const secs=v%60;
  let txt=mins>0?`${mins} min`:"";if(secs>0)txt+=(txt?" ":"")+`${secs} seg`;
  // v172b: 300s (5min) é o padrão recomendado agora — cai em "Normal", não
  // mais em "Conservador" (o limiar subiu de 300 pra 600 de propósito).
  lbl.textContent=v<60?"⚡ Ultra-rápido ("+txt+"/envio)"
    :v<180?"🚀 Rápido ("+txt+"/envio)"
    :v<600?"✅ Normal ("+txt+"/envio)"
    :"🐢 Conservador ("+txt+"/envio)";
}

function setAdminInterval(secs){
  const inp=g("#adm-interval");
  if(inp){inp.value=secs;updateAdminIntervalLabel();}
}

function _renderAdminSenders(){
  const senders=U.senderEmails||[];
  const max=U.adminSettings?.maxSenders||5;
  // Contagem
  const cntEl=g("#adm-sender-count");
  if(cntEl)cntEl.textContent=senders.length+"/"+max;
  // Botão adicionar
  const addBtn=g("#adm-add-sender-btn");
  if(addBtn)addBtn.style.display=senders.length>=max?"none":"";
  // Lista de senders
  const listEl=g("#adm-sender-list");
  if(!listEl)return;
  if(!senders.length){
    listEl.innerHTML=`<div style="font-size:12px;color:var(--t3)">Nenhum Gmail extra conectado ainda. Adicione abaixo.</div>`;
  } else {
    listEl.innerHTML=senders.map(s=>`
      <div style="background:var(--sf2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:var(--blue);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:800;flex-shrink:0">${esc(s.label||s.email).slice(0,1).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.email)}</div>
          <div style="font-size:10px;color:var(--t3);display:flex;align-items:center;gap:4px">
            ${s.tokenExpired?'<span style="color:var(--red)">⚠️ Token expirado</span>':s.blocked?'<span style="color:var(--red)">🚫 Bloqueado</span>':'<span style="color:var(--green)">✓ Ativo</span>'}
          </div>
        </div>
        <button onclick="removeSenderAdmin('${esc(s.email)}')" style="background:none;border:none;color:var(--t3);cursor:pointer;padding:4px;font-size:16px" title="Remover"><i class="ti ti-trash" style="font-size:15px"></i></button>
      </div>`).join("");
  }
  // Limites por sender
  _renderAdminSenderLimits(senders);
}

function _renderAdminSenderLimits(senders){
  const limEl=g("#adm-sender-limits-list");
  if(!limEl)return;
  const allEmails=[U.email,...(senders||[]).map(s=>s.email)];
  const currentLimits=_adminSettings.senderLimits||{};
  if(allEmails.length<1){
    limEl.innerHTML=`<div style="font-size:12px;color:var(--t3)">Adicione Gmails acima para configurar limites</div>`;
    return;
  }
  limEl.innerHTML=allEmails.map(em=>`
    <div style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(em)}</div>
      <input class="input" id="adm-lim-${esc(em.replace(/[@.]/g,'_'))}" type="number" inputmode="decimal" min="1" max="999" placeholder="400" value="${currentLimits[em]||''}" style="width:70px;font-size:12px;padding:5px 8px">
      <span style="font-size:10px;color:var(--t3)">/dia</span>
    </div>`).join("");
}

async function removeSenderAdmin(email){
  if(!confirm("Remover "+email+"?"))return;
  try{
    const r=await fetch("/api/sender/"+encodeURIComponent(email),{method:"DELETE",credentials:"include"});
    if(r.ok){toast("Gmail removido","g");await syncData();_renderAdminSenders();}
    else toast("Erro: "+(await r.json()).error,"r");
  }catch(e){toast("Erro: "+e.message,"r");}
}

async function saveAdminSettings(){
  const inpSecs=g("#adm-interval");
  const secs=inpSecs?Math.max(30,parseInt(inpSecs.value)||300):300;
  // Coletar limites por sender
  const allEmails=[U.email,...(U.senderEmails||[]).map(s=>s.email)];
  const senderLimits={};
  allEmails.forEach(em=>{
    const key="adm-lim-"+em.replace(/[@.]/g,'_');
    const inp=g("#"+key);
    const v=inp?parseInt(inp.value):0;
    if(v>0&&v<=9999)senderLimits[em]=v;
  });
  try{
    const r=await fetch("/api/admin/my-settings",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({intervalSecs:secs,senderLimits})});
    const d=await r.json();
    if(d.ok){
      _adminSettings=d.adminSettings;
      U.adminSettings=d.adminSettings;
      toast("Configurações admin salvas ✓","g");
      const st=g("#adm-save-status");
      if(st){st.style.display="block";setTimeout(()=>st.style.display="none",3000);}
      updateAdminIntervalLabel();
    } else toast("Erro: "+d.error,"r");
  }catch(e){toast("Erro: "+e.message,"r");}
}

// Exibir seção admin se usuário é admin (chamado após syncData; v168: era
// o botão da sub-aba #ptab-admin, agora é a seção #pf-sec-admin inteira)
function _initAdminTab(){
  const sec=g("#pf-sec-admin");
  if(!sec)return;
  sec.style.display=U.isAdmin?"":"none";
}

function _updateProfileTabCount(){
  const cnt=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false).length;
  const b=g("#ptab-profiles-cnt");
  if(b){b.style.display=cnt?"inline-block":"none";b.textContent=cnt;}
}


// ── Docs Tab Rendering ──
function renderDocsTab(){
  // Sempre usa DOCS (atualizado em tempo real)
  const allDocs = DOCS && DOCS.length ? DOCS : (U.cvs||[]);
  const resumes = allDocs.filter(c=>(c.cvType||"resume")==="resume");
  const covers  = allDocs.filter(c=>c.cvType==="cover");

  // Contador
  const rc=g("#docs-resume-count"); if(rc)rc.textContent=resumes.length+"/10";
  const cc=g("#docs-cover-count");  if(cc)cc.textContent=covers.length+"/10";

  const mkCard=(c,type)=>`
    <div style="display:flex;align-items:center;gap:10px;background:var(--sf2);border:1.5px solid var(--border);border-radius:var(--r);padding:10px 12px">
      <div style="width:36px;height:36px;border-radius:8px;background:${type==="cover"?"var(--purplel)":"var(--redl)"};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="ti ti-file-type-pdf" style="font-size:18px;color:${type==="cover"?"var(--purple)":"var(--red)"}"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</div>
        <div style="font-size:10px;color:var(--t3)">${c.size?Math.round(c.size/1024)+"KB ·":""} ${c.date?new Date(c.date).toLocaleDateString("pt-BR"):""}</div>
      </div>
      <button aria-label="Excluir arquivo" title="Excluir arquivo" onclick="deleteDocFile(${c.idx},'${esc(c.name).replace(/'/g,"\\'")}','${type}')" 
        style="background:var(--redl);border:1px solid var(--redb);color:var(--red);border-radius:6px;padding:5px 8px;cursor:pointer;font-size:12px;flex-shrink:0">
        <i class="ti ti-trash"></i>
      </button>
    </div>`;

  const rl=g("#docs-resume-list");
  if(rl)rl.innerHTML=resumes.length?resumes.map(c=>mkCard(c,"resume")).join(""):`<div style="font-size:13px;color:var(--t3);padding:8px 0;text-align:center">Nenhum currículo enviado ainda</div>`;

  const cl=g("#docs-cover-list");
  if(cl)cl.innerHTML=covers.length?covers.map(c=>mkCard(c,"cover")).join(""):`<div style="font-size:13px;color:var(--t3);padding:8px 0;text-align:center">Nenhuma cover letter enviada ainda</div>`;
}


async function deleteDocFile(idx, name, type){
  if(!confirm('Excluir "'+name+'"?'))return;
  try{
    const r=await fetch("/api/cv/"+idx,{method:"DELETE",credentials:"include"});
    const d=await r.json();
    if(d.ok){
      DOCS=DOCS.filter(c=>c.idx!==idx);
      if(activeResIdx===idx) activeResIdx=DOCS.filter(c=>(c.cvType||"resume")==="resume").slice(-1)[0]?.idx||null;
      renderDocsTab();
      toast("Arquivo excluído","r");
    } else throw new Error(d.error);
  }catch(e){toast("Erro: "+e.message,"r");}
}
async function uploadCvFromDocs(input, cvType){
  const file=input.files[0]; if(!file)return;
  if(file.size>10*1024*1024){toast("Arquivo muito grande (máx 10MB)","r");input.value="";return;}
  toast("Enviando "+file.name+"...","");
  const b64=await new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result.split(",")[1]);
    r.onerror=rej;
    r.readAsDataURL(file);
  });
  try{
    const r=await fetch("/api/cv/upload",{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({base64:b64,name:file.name,cvType})});
    const d=await jsonSafe(r);
    if(d.ok){
      // Adiciona ao DOCS global (deduplica por idx)
      DOCS=DOCS.filter(c=>c.idx!==d.cv.idx);
      DOCS.push(d.cv);
      // Atualiza activeResIdx se for resume
      if(cvType==="resume"&&activeResIdx===null) activeResIdx=d.cv.idx;
      renderDocsTab();
      toast(cvType==="resume"?"Currículo enviado ✓":"Cover letter enviada ✓","g");
    } else throw new Error(d.error);
  }catch(e){toast("Erro: "+e.message,"r");}
  input.value="";
}


// v168: renderStatsTab()/shareStats() REMOVIDAS junto com a aba "Números"
// do Perfil (gamificação — resquício que não devia ter sobrevivido a esta
// reconstrução). Confirmado por grep que nenhum outro lugar do app chamava
// as duas funções antes de apagar.



// ── Follow-up reminder on home ── (função consolidada abaixo, em BLOCO 4)

// Patch syncData to run follow-up check — consolidado: chamada adicionada diretamente em syncData

// ── Blacklist de empresas ──
let BLACKLIST_EMAILS=new Set(JSON.parse(localStorage.getItem("h2b_blacklist")||"[]"));
function blacklistCompany(emailAddr, companyName){
  if(!confirm("Nunca mais enviar para "+companyName+"?"))return;
  BLACKLIST_EMAILS.add(emailAddr.toLowerCase());
  try{localStorage.setItem("h2b_blacklist",JSON.stringify([...BLACKLIST_EMAILS]));}catch{}
  toast("Empresa bloqueada: "+companyName,"r");
}
function isBlacklisted(email){return BLACKLIST_EMAILS.has((email||"").toLowerCase());}

// ── Navegação de profile: lógica consolidada na função sv() original ──


console.debug("[v14+] Novas funcionalidades carregadas: pipeline, templates, stats, docs, follow-up, blacklist");

// ════════════════════════════════════════════════════
//  BLOCO 4: ONBOARDING + FAQ + MELHORIAS
// ════════════════════════════════════════════════════

// ── FAQ toggle ──────────────────────────────────────
function toggleFaq(el){
  const isOpen=el.classList.contains("open");
  document.querySelectorAll(".faq-item").forEach(f=>f.classList.remove("open"));
  if(!isOpen)el.classList.add("open");
}

// ── Onboarding Wizard ────────────────────────────────
// v166 (dono, 07/09/2026 — reconstrução do wizard): sequência nova
// "1"→"1b"→"h2b"→"h2a"→"tut"→"5". O onboarding deixou de ser 100%
// pulável — "Pular tudo" (obSkipAll) foi REMOVIDO de propósito: hoje dava
// pra terminar o wizard inteiro com ZERO perfis criados, e sem perfil o
// app não sabe pra quais vagas candidatar ninguém. Cada perfil (H-2B/H-2A)
// continua individualmente pulável, mas o GATE em obAdvanceFromH2a() (ver
// abaixo) barra a saída do passo "h2a" enquanto o usuário tiver 0 perfis
// no total — aí sim é impossível chegar no tutorial/final sem 1 perfil.
let _obStep=1;

function showOnboarding(){
  const ov=g("#onboarding-overlay");if(!ov)return;
  // Pré-preenche dados do Google
  const nameEl=g("#ob-name");if(nameEl&&!nameEl.value)nameEl.value=CFG.name||U.name||"";
  const phoneEl=g("#ob-phone");if(phoneEl&&!phoneEl.value)phoneEl.value=CFG.phone||U.whatsapp||"";
  const emailDisp=g("#ob-email-display");if(emailDisp)emailDisp.value=U.email||"";
  const ageEl=g("#ob-age");if(ageEl&&!ageEl.value&&U.age)ageEl.value=U.age;
  const cityEl=g("#ob-city");if(cityEl&&!cityEl.value)cityEl.value=CFG.city||"";
  obRenderVtSubjects("h2b");obRenderVtBodies("h2b");
  obRenderVtSubjects("h2a");obRenderVtBodies("h2a");
  _obRestoreDraft("h2b");_obRestoreDraft("h2a"); // v167: rascunho de sessão caída
  ov.style.display="flex";
  _goObStep(1);
}

function skipOnboarding(){
  const ov=g("#onboarding-overlay");if(ov)ov.style.display="none";
  try{localStorage.setItem("h2b_onboarded","1");}catch{}
  // Marca no SERVIDOR também (não só localStorage) — sem isso o flag
  // U.onboarded fica false até o próximo /api/onboard oportunista de
  // checkShowOnboarding, e outro aparelho/sessão do mesmo usuário podia
  // ver o wizard de novo antes disso acontecer.
  fetch("/api/onboard",{method:"POST",credentials:"include"}).then(()=>{U.onboarded=true;}).catch(()=>{});
}

function finishOnboarding(){
  skipOnboarding();
  toast("🎉 Bem-vindo ao H2BApply! Comece a candidatar agora.","g");
}

const OB_ALL=["1","1b","h2b","h2a","tut","5"];

function _goObStep(n){
  _obStep=n;
  OB_ALL.forEach(i=>{const s=g("#ob-step-"+i);if(s)s.style.display=(String(i)===String(n))?"block":"none";});
  const idx=OB_ALL.findIndex(i=>String(i)===String(n));
  const total=OB_ALL.length;
  const prog=g("#ob-progress");if(prog)prog.style.width=(((idx+1)/total)*100)+"%";
  const lbl=g("#ob-step-label");if(lbl)lbl.textContent="Passo "+(idx+1)+" de "+total;
}

function obNext(from){
  const idx=OB_ALL.findIndex(i=>String(i)===String(from));
  if(idx>=0&&idx<OB_ALL.length-1)_goObStep(OB_ALL[idx+1]);
}

async function obSavePersonal(){
  const name=(g("#ob-name")?.value||"").trim();
  const phone=(g("#ob-phone")?.value||"").trim();
  const city=(g("#ob-city")?.value||"").trim();
  const country=(g("#ob-country")?.value||"").trim()||"Brazil";
  const age=parseInt(g("#ob-age")?.value||"0");

  if(!name){toast("Informe seu nome completo","r");g("#ob-name")?.focus();return;}
  if(!phone){toast("Informe seu WhatsApp","r");g("#ob-phone")?.focus();return;}
  if(!city){toast("Informe sua cidade","r");g("#ob-city")?.focus();return;}
  if(!age||age<18||age>80){toast("Informe uma idade válida (18-80)","r");g("#ob-age")?.focus();return;}

  try{
    const r=await fetch("/api/settings",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name,phone,whatsapp:phone,city,country,age,language:CFG.language||"pt-BR"})});
    const d=await r.json();
    if(d.ok){
      CFG.name=name;CFG.phone=phone;CFG.city=city;CFG.country=country;
      U.name=name;U.phone=phone;U.whatsapp=phone;U.age=age;
      const nameEl2=g("#cfg-name");if(nameEl2)nameEl2.value=name;
      const phoneEl2=g("#cfg-phone");if(phoneEl2)phoneEl2.value=phone;
      const cityEl2=g("#cfg-city");if(cityEl2)cityEl2.value=city;
      renderHdr();renderSidebar();
      toast("Dados salvos ✓","g");
    }
  }catch(e){console.warn("[ob] save personal",e);}
  _goObStep("1b");
}

// ── Estado local do perfil H2B (v166: SEM histórico de visto) ───────────
// Removido por ordem do dono (07/09/2026): "já esteve nos EUA antes?" e
// "já teve H2B antes? quantas temporadas?" saíram do onboarding — ficam
// só englishLevel/preferredArea/hasDriverLicense/availability.
const _obH2B={englishLevel:"none",hasDriverLicense:false,avatar:""};

function obToggleEng(level){
  _obH2B.englishLevel=level;
  ["none","basic","intermediate","advanced"].forEach(l=>{const b=g("#ob-eng-"+l);if(b)b.classList.toggle("on",l===level);});
}
function obToggleCnh(val){
  const on=val==="yes";_obH2B.hasDriverLicense=on;
  const y=g("#ob-cnh-yes"),n=g("#ob-cnh-no");
  if(y)y.classList.toggle("on",on);if(n)n.classList.toggle("on",!on);
}
async function obSaveH2BProfile(){
  _obH2B.preferredArea=g("#ob-h2b-area")?.value||"landscape";
  _obH2B.availability=g("#ob-avail")?.value||"immediate";
  try{
    await fetch("/api/settings",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({h2bProfile:{englishLevel:_obH2B.englishLevel,preferredArea:_obH2B.preferredArea,hasDriverLicense:_obH2B.hasDriverLicense,availability:_obH2B.availability}})});
    U.h2bProfile={...(U.h2bProfile||{}),..._obH2B};
  }catch(e){console.warn("[ob] h2b save",e);}
  _goObStep("h2b");
}

// ── Perfis por tipo de visto (H-2B/H-2A) — v166 ──────────────────────────
// Cada visto tem seu próprio conjunto de assuntos/corpos/documentos, criado
// de forma independente (a pessoa pode pular um dos dois). Sem texto padrão
// pré-preenchido (regra permanente, 2026-07): caixas sempre em branco, só
// placeholder de exemplo — nunca value real. Documento fica em memória
// (base64) até o clique em "Salvar Perfil", quando é enviado pro
// POST /api/cv/upload e o idx retornado alimenta resumeIdx/coverIdx do
// POST /api/profiles/save — o BUG CRÍTICO do wizard antigo (perfil sempre
// nascia com resumeIdx/coverIdx nulos e o servidor recusava com 400) foi
// corrigido aqui: nunca salvamos um perfil novo sem mandar pelo menos um
// dos dois idx.
const _obPrf={
  h2b:{subjects:["","",""],bodies:["","",""],res:null,cov:null},
  h2a:{subjects:["","",""],bodies:["","",""],res:null,cov:null},
};

// ══ v167: RASCUNHO DO ONBOARDING (bug real achado em auditoria, 08/09/2026)
// ══ — mesma proteção que o editor de perfil completo (_peSaveDraftNow, regra
// 13t do CLAUDE.md) já tem contra sessão caindo no meio da digitação (KB-078:
// todo restart/deploy derruba o login de propósito), mas que faltava aqui —
// e este é justamente o PRIMEIRO formulário que todo usuário novo preenche
// (gate obrigatório: onboarding não termina com 0 perfis). Sem isso, cair a
// sessão no meio dos 3+ assuntos/corpos apagava tudo, e o próprio erro
// genérico (jsonSafe) mentia "nada foi perdido". Escopado por e-mail (mesmo
// bug de vazamento entre contas que existia no editor completo) — nunca
// guarda o PDF em base64 (só o nome, pra avisar; o arquivo é pequeno reanexar).
function _obDraftKey(vt){return "h2b_ob_draft_"+vt+"_"+(U?.email||"anon");}
let _obDraftTimer=null;
function _obSaveDraftNow(vt){
  try{
    const d=_obPrf[vt];if(!d)return;
    const temAlgo=d.subjects.some(Boolean)||d.bodies.some(Boolean)||d.res||d.cov;
    if(!temAlgo){localStorage.removeItem(_obDraftKey(vt));return;}
    localStorage.setItem(_obDraftKey(vt),JSON.stringify({subjects:d.subjects,bodies:d.bodies,resName:d.res?.name||null,covName:d.cov?.name||null,savedAt:Date.now()}));
  }catch(e){}
}
function _obScheduleDraft(vt){clearTimeout(_obDraftTimer);_obDraftTimer=setTimeout(()=>_obSaveDraftNow(vt),500);}
function _obClearDraft(vt){try{localStorage.removeItem(_obDraftKey(vt));}catch(e){}}
function _obLoadDraft(vt){
  try{
    const raw=localStorage.getItem(_obDraftKey(vt));if(!raw)return null;
    const d=JSON.parse(raw);
    if(!d||Date.now()-(d.savedAt||0)>7*86400_000){localStorage.removeItem(_obDraftKey(vt));return null;} // rascunho não fica eterno
    return d;
  }catch(e){return null;}
}
// Restaura silenciosamente (sem confirm — ao contrário do editor completo,
// aqui nunca existe perfil já salvo pra sobrescrever: onboarding só roda
// pra quem ainda não tem perfil daquele tipo, então não há o que perder).
function _obRestoreDraft(vt){
  const d=_obLoadDraft(vt);
  if(!d)return;
  const temTexto=(d.subjects||[]).some(Boolean)||(d.bodies||[]).some(Boolean);
  if(!temTexto&&!d.resName&&!d.covName)return;
  if(Array.isArray(d.subjects)&&d.subjects.length>=3)_obPrf[vt].subjects=d.subjects.slice(0,10);
  if(Array.isArray(d.bodies)&&d.bodies.length>=3)_obPrf[vt].bodies=d.bodies.slice(0,10);
  obRenderVtSubjects(vt);obRenderVtBodies(vt);
  if(d.resName||d.covName){
    toast("📝 Recuperamos o texto que você tinha digitado — reanexe o PDF ("+(d.resName||d.covName)+") pra concluir","g");
  }else{
    toast("📝 Recuperamos o texto que você tinha digitado antes da sessão cair","g");
  }
}
const _OB_SUBJ_PLACEHOLDERS=[
  "Ex: Application for {vaga} position – {nome}",
  "Ex: Interested in the {vaga} opening at {empresa}",
  "Ex: {nome} — candidatura para {vaga}",
];
const _OB_BODY_HINTS=[
  "Apresente-se e diga que viu a vaga de {vaga} na {empresa}. Ex: \"Dear Hiring Manager, my name is {nome} and I am very interested in the {vaga} position...\"",
  "Fale da sua disponibilidade e experiência. Ex: \"I am available to start immediately and have experience in similar roles...\"",
  "Um jeito mais direto de se apresentar. Ex: \"Hello, I would like to apply for {vaga}. I am hard-working and reliable...\"",
];
function obRenderVtSubjects(vt){
  const c=g("#ob-"+vt+"-subjects-list");if(!c)return;
  const arr=_obPrf[vt].subjects;
  c.innerHTML=arr.map((v,i)=>`<div style="display:flex;gap:6px;align-items:center">
    <input class="input" type="text" value="${(v||"").replace(/"/g,"&quot;")}" placeholder="${_OB_SUBJ_PLACEHOLDERS[i%_OB_SUBJ_PLACEHOLDERS.length]}" oninput="_obPrf['${vt}'].subjects[${i}]=this.value;_obScheduleDraft('${vt}')" style="flex:1">
    ${arr.length>3?`<button type="button" onclick="obRemoveVtSubject('${vt}',${i})" title="Remover" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:20px;line-height:1;padding:2px 6px">×</button>`:""}
  </div>`).join("");
}
function obAddVtSubject(vt){if(_obPrf[vt].subjects.length>=10){toast("Máximo 10 assuntos","r");return;}_obPrf[vt].subjects.push("");obRenderVtSubjects(vt);}
function obRemoveVtSubject(vt,i){if(_obPrf[vt].subjects.length<=3){toast("Mínimo 3 assuntos","r");return;}_obPrf[vt].subjects.splice(i,1);obRenderVtSubjects(vt);}
function obRenderVtBodies(vt){
  const c=g("#ob-"+vt+"-bodies-list");if(!c)return;
  const arr=_obPrf[vt].bodies;
  c.innerHTML=arr.map((v,i)=>`<div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
      <span style="font-size:10px;font-weight:700;color:var(--t3);text-transform:uppercase">Versão ${i+1}</span>
      ${arr.length>3?`<button type="button" onclick="obRemoveVtBody('${vt}',${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit">Remover</button>`:""}
    </div>
    <textarea class="input" style="min-height:70px;font-size:12px" placeholder="${_OB_BODY_HINTS[i%_OB_BODY_HINTS.length]}" oninput="_obPrf['${vt}'].bodies[${i}]=this.value;_obScheduleDraft('${vt}')">${esc(v||"")}</textarea>
  </div>`).join("");
}
function obAddVtBody(vt){if(_obPrf[vt].bodies.length>=10){toast("Máximo 10 corpos de email","r");return;}_obPrf[vt].bodies.push("");obRenderVtBodies(vt);}
function obRemoveVtBody(vt,i){if(_obPrf[vt].bodies.length<=3){toast("Mínimo 3 corpos de email","r");return;}_obPrf[vt].bodies.splice(i,1);obRenderVtBodies(vt);}

// Upload de currículo/carta (kind: "res"|"cov") fica só em memória (base64)
// até o Salvar — mesmo padrão adiado usado pelo editor de perfil completo.
async function obPickDoc(vt,kind,input){
  const file=input.files[0];if(!file)return;
  const isCov=kind==="cov";
  const maxSize=isCov?3*1024*1024:5*1024*1024;
  if(file.size>maxSize){toast(isCov?"Carta maior que 3MB":"Currículo maior que 5MB","r");input.value="";return;}
  let b64;
  try{b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=rej;r.readAsDataURL(file);});}
  catch{toast("Não foi possível ler o arquivo","r");input.value="";return;}
  _obPrf[vt][kind]={base64:b64,name:file.name};
  const badge=g("#ob-"+vt+"-"+kind+"-badge");const nameEl=g("#ob-"+vt+"-"+kind+"-name");
  if(badge)badge.style.display="flex";
  if(nameEl)nameEl.textContent="✓ "+file.name;
  input.value="";
  _obSaveDraftNow(vt); // v167: nome do arquivo entra no rascunho na hora (nunca o base64)
}

async function obSaveVisaProfile(vt){
  _obSaveDraftNow(vt); // v167: snapshot garantido no instante do clique em Salvar
  // v167 (bug real, auditoria 08/09/2026): a validação daqui era só .filter(Boolean),
  // SEM deduplicar — 3 assuntos IDÊNTICOS passavam aqui mas o servidor deduplica
  // com Set antes de contar (server.js /api/profiles/save) e rejeitava com 400
  // DEPOIS de já ter gasto 1 upload de currículo (rate-limitado a 10/hora). Agora
  // deduplica igual ao editor de perfil completo (saveProfileFromEditor) e ao
  // servidor — as 3 validações sempre concordam.
  const subjRaw=_obPrf[vt].subjects.map(s=>(s||"").trim()).filter(Boolean);
  const bodyRaw=_obPrf[vt].bodies.map(b=>(b||"").trim()).filter(Boolean);
  const subjects=[...new Set(subjRaw)];
  const emailBodies=[...new Set(bodyRaw)];
  // v168 (bug real, "cliente clica em Salvar e não acontece nada" — 22/09/2026,
  // print do Diego com 3 assuntos IDÊNTICOS "H-2B Worker Available"): a
  // validação já bloqueava certo (regra 7 do CLAUDE.md: nunca deixar sair
  // texto igual de todo mundo), mas o ÚNICO aviso era um toast de 2,8s — em
  // aparelho real, fácil de não notar (o botão volta ao normal, nada muda na
  // tela, PARECE que "não fez nada"). Agora, igual ao editor de perfil
  // completo (#pe-subjects-warn), fica um aviso PERSISTENTE na tela — só some
  // quando o problema é corrigido de verdade — e a mensagem distingue "faltam
  // textos" de "os textos são iguais" (o caso real do cliente).
  const subjWarn=g("#ob-"+vt+"-subjects-warn"),subjWarnTxt=g("#ob-"+vt+"-subjects-warn-txt");
  const bodyWarn=g("#ob-"+vt+"-bodies-warn"),bodyWarnTxt=g("#ob-"+vt+"-bodies-warn-txt");
  const pdfWarn=g("#ob-"+vt+"-pdf-warn");
  if(subjects.length<3){
    if(subjWarnTxt)subjWarnTxt.textContent=subjRaw.length<3?"Faltam assuntos — escreva pelo menos 3.":"Os assuntos não podem ser todos iguais — mude o texto de cada um.";
    if(subjWarn){subjWarn.style.display="flex";subjWarn.scrollIntoView({behavior:"smooth",block:"center"});}
    toast("⚠️ Mínimo 3 assuntos DIFERENTES entre si","r");
    return;
  }
  if(subjWarn)subjWarn.style.display="none";
  if(emailBodies.length<3){
    if(bodyWarnTxt)bodyWarnTxt.textContent=bodyRaw.length<3?"Faltam corpos de e-mail — escreva pelo menos 3.":"Os corpos não podem ser todos iguais — mude o texto de cada um.";
    if(bodyWarn){bodyWarn.style.display="flex";bodyWarn.scrollIntoView({behavior:"smooth",block:"center"});}
    toast("⚠️ Mínimo 3 corpos de e-mail DIFERENTES entre si","r");
    return;
  }
  if(bodyWarn)bodyWarn.style.display="none";
  if(!_obPrf[vt].res&&!_obPrf[vt].cov){
    if(pdfWarn){pdfWarn.style.display="flex";pdfWarn.scrollIntoView({behavior:"smooth",block:"center"});}
    toast("⚠️ Anexe pelo menos um currículo ou uma carta de apresentação a este perfil","r");
    return;
  }
  if(pdfWarn)pdfWarn.style.display="none";
  const label=vt==="h2a"?"Salvar Perfil H-2A →":"Salvar Perfil H-2B →";
  const btn=g("#ob-btn-"+vt);
  if(btn){btn.disabled=true;btn.innerHTML='<span class="spin spin-sm"></span> Salvando...';}
  try{
    let resumeIdx=null,coverIdx=null;
    if(_obPrf[vt].res){
      const r=await fetch("/api/cv/upload",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({base64:_obPrf[vt].res.base64,name:_obPrf[vt].res.name,cvType:"resume"})});
      const d=await jsonSafe(r);if(!d.ok)throw new Error(d.error);
      resumeIdx=d.cv.idx;DOCS=DOCS.filter(c=>c.idx!==d.cv.idx);DOCS.push(d.cv);if(activeResIdx==null)activeResIdx=d.cv.idx;
    }
    if(_obPrf[vt].cov){
      const r=await fetch("/api/cv/upload",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({base64:_obPrf[vt].cov.base64,name:_obPrf[vt].cov.name,cvType:"cover"})});
      const d=await jsonSafe(r);if(!d.ok)throw new Error(d.error);
      coverIdx=d.cv.idx;DOCS=DOCS.filter(c=>c.idx!==d.cv.idx);DOCS.push(d.cv);if(activeCovIdx==null)activeCovIdx=d.cv.idx;
    }
    // NUNCA deixe resumeIdx e coverIdx os dois ausentes — é exatamente o bug
    // que fazia POST /api/profiles/save devolver 400 num perfil novo.
    const prf={name:vt==="h2a"?"Perfil H-2A":"Perfil H-2B",type:"normal",visaType:vt,isGeneral:true,active:true,subjects,emailBodies,categories:[],icon:vt==="h2a"?"🌾":"🎯",resumeIdx,coverIdx};
    const r2=await fetch("/api/profiles/save",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(prf)});
    const d2=await jsonSafe(r2);if(!d2.ok)throw new Error(d2.error);
    UPROFILES=[...UPROFILES.filter(p=>(p.visaType||"h2b")!==vt),d2.profile];
    U.profiles=UPROFILES;
    _updateProfileTabCount?.();
    _obClearDraft(vt); // v167: salvou de verdade, rascunho não serve mais
    toast("Perfil "+(vt==="h2a"?"H-2A":"H-2B")+" salvo ✓","g");
    if(btn){btn.disabled=false;btn.innerHTML=label;}
    if(vt==="h2b"){
      // Perfil H-2B acabou de ser salvo com sucesso — se o gate tinha barrado
      // antes (0 perfis) e o usuário voltou aqui pra resolver, o aviso
      // vermelho não pode continuar na tela mentindo que ainda falta perfil.
      const warn=g("#ob-gate-warn");if(warn)warn.style.display="none";
      _goObStep("h2a");
    }else await obAdvanceFromH2a();
  }catch(e){
    if(btn){btn.disabled=false;btn.innerHTML=label;}
    // v167: sessão caiu (deploy/restart, KB-078) — o rascunho JÁ estava salvo
    // (chamada incondicional no topo da função), mas sem isso o usuário via só
    // "Erro: Não autenticado." sem entender o que fazer nem saber que o texto
    // não sumiu.
    toast(_sessionDroppedMsg(e)?t('pe_session_lost'):("Erro: "+e.message),"r");
  }
}

function obSkipVisaProfile(vt){
  if(vt==="h2b"){_goObStep("h2a");return;}
  obAdvanceFromH2a();
}

// GATE OBRIGATÓRIO (v166): não deixa sair do passo "h2a" (nem salvando nem
// pulando) enquanto o usuário tiver ZERO perfis no total — confere via
// GET /api/status (fonte de verdade real, não só o estado local) porque é
// exatamente essa checagem que impede alguém de terminar o onboarding sem
// nenhum perfil criado (a brecha que "Pular tudo" abria antes).
async function obAdvanceFromH2a(){
  let count=null;
  try{
    const r=await fetch("/api/status",{credentials:"include"});
    const d=await jsonSafe(r);
    if(Array.isArray(d.profiles))count=d.profiles.length;
  }catch(e){console.warn("[ob] gate status",e);}
  if(count===null)count=(UPROFILES||[]).filter(p=>p.active!==false).length; // rede falhou: usa o estado local (já teria vindo do próprio save)
  const warn=g("#ob-gate-warn");
  if(count<1){
    const msg="Você precisa completar pelo menos um perfil (H-2B ou H-2A) para continuar — sem isso o app não sabe pra quais vagas te candidatar.";
    toast(msg,"r");
    if(warn){warn.textContent="⚠️ "+msg;warn.style.display="block";}
    _goObStep("h2a"); // fica no h2a (onde o aviso vive) — impossível seguir pro tutorial com 0 perfis
    return;
  }
  if(warn)warn.style.display="none";
  _goObStep("tut");
}

// Checa se deve mostrar onboarding (só na primeira vez — usuários realmente novos)
function checkShowOnboarding(){
  try{
    // Não mostrar onboarding se os termos ainda estão pendentes
    var termsOverlay = document.getElementById("terms-overlay");
    if(termsOverlay && termsOverlay.style.display === "flex") return;
    if(!sessionStorage.getItem("h2b_terms_session")) return;
    // 1. Servidor já marcou como onboarded → nunca mostrar
    if(U.onboarded)return;
    // 2. localStorage local já marcado → nunca mostrar
    if(localStorage.getItem("h2b_onboarded"))return;
    // 3. Usuário já tem perfis criados → não precisa do onboarding, marcar como concluído
    const hasProfiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false).length>0;
    if(hasProfiles){
      try{localStorage.setItem("h2b_onboarded","1");}catch{}
      // Persiste no servidor para não pedir de novo em outros dispositivos
      fetch("/api/onboard",{method:"POST",credentials:"include"}).catch(()=>{});
      return;
    }
    // 4. Usuário já tem documentos (PDF) → também não precisa do onboarding básico
    if(DOCS.length>0){
      try{localStorage.setItem("h2b_onboarded","1");}catch{}
      fetch("/api/onboard",{method:"POST",credentials:"include"}).catch(()=>{});
      return;
    }
    // 5. Usuário realmente novo: sem perfis, sem docs, sem onboarding → mostrar
    setTimeout(showOnboarding,800);
  }catch{}
}

// ── Preview antes de iniciar automático ─────────────
function showAutoPreview(){
  const profiles=(UPROFILES.length?UPROFILES:U.profiles||[]).filter(p=>p.active!==false);
  const src=autoSelectedSrc||"jan2026";
  const cats=autoSelectedCats&&autoSelectedCats.length?autoSelectedCats.join(", "):"Todas";
  const minW=document.getElementById("af-min-wage")?.value||"0";
  const state=document.getElementById("af-state")?.value||"Todos";
  const profile=profiles[0];
  const box=document.createElement("div");
  box.style.cssText="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)";
  box.onclick=function(e){if(e.target===box)box.remove();}
  box.innerHTML=`<div style="background:var(--surface);border-radius:20px;width:100%;max-width:400px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.4)">
    <div style="background:linear-gradient(135deg,#050d1f,#1e1b4b);padding:16px 20px;color:#fff">
      <div style="font-size:16px;font-weight:800;margin-bottom:2px">🚀 Confirmar Envio Automático</div>
      <div style="font-size:12px;opacity:.7">Revise antes de iniciar</div>
    </div>
    <div style="padding:16px 20px">
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="color:var(--t3)">Fonte de vagas</span><strong>${src==="jan2026"?"☀️ Jan/2026 — Verão":"❄️ Jul/2025 — Inverno"}</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="color:var(--t3)">Categorias</span><strong>${cats}</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="color:var(--t3)">Estado</span><strong>${state}</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="color:var(--t3)">Salário mínimo</span><strong>${minW?("$"+minW+"/h"):"Qualquer"}</strong></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0"><span style="color:var(--t3)">Perfil</span><strong>${profile?esc(profile.name):"–"}</strong></div>
      </div>
      <div style="background:var(--bluel);border:1px solid var(--blueb);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--blue);margin-bottom:14px;display:flex;gap:7px;align-items:flex-start">
        <i class="ti ti-info-circle" style="flex-shrink:0;margin-top:1px"></i>
        O sistema enviará automaticamente enquanto você trabalha. Pode pausar a qualquer momento.
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="this.closest('div[style*=fixed]').remove()" class="btn btn-secondary" style="flex:1">Cancelar</button>
        <button onclick="this.closest('div[style*=fixed]').remove();startAuto()" class="btn btn-primary" style="flex:2"><i class="ti ti-rocket"></i> Iniciar Agora</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(box);
}

// ── Score de email ────────────────────────────────────
function scoreEmailBody(body){
  if(!body)return 0;
  let score=0;
  if(body.length>100)score+=20;
  if(body.includes("{nome}"))score+=15;
  if(body.includes("{vaga}"))score+=15;
  if(body.includes("{empresa}"))score+=10;
  if(body.includes("Dear"))score+=10;
  if(body.includes("Best regards"))score+=10;
  if(body.length>200)score+=10;
  if(/[A-Z]/.test(body[0]))score+=5;
  if(body.split("\n").length>3)score+=5;
  return Math.min(100,score);
}

function renderEmailScore(body,containerId){
  const el=g("#"+containerId);if(!el)return;
  const score=scoreEmailBody(body);
  const color=score>=80?"var(--green)":score>=50?"var(--amber)":"var(--red)";
  const label=score>=80?"Excelente":score>=50?"Bom":"Fraco";
  el.innerHTML=`<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
    <div style="flex:1;height:4px;background:var(--sf3);border-radius:2px"><div style="width:${score}%;height:100%;background:${color};border-radius:2px;transition:width .3s"></div></div>
    <span style="color:${color};font-weight:700;font-size:10px">${label} (${score})</span>
  </div>`;
}

console.debug("[v14+] Onboarding, FAQ, Preview Auto, Follow-up, Score carregados");

/* ═══════════════════════════════════════════════════════════
   ═══ v15: SOCIAL + ENVIO VALIDATOR
   ═══════════════════════════════════════════════════════════ */
(function(){
  "use strict";

  // ── 15.A: Social — Instagram tracking + modal opcional ──
  const SOCIAL_INVITE_KEY = "h2b_social_invite_v1";
  const SOCIAL_FOLLOW_KEY = "h2b_social_followed_v1";

  // Lê estado de "já viu"/"já seguiu" de forma segura
  function _getSocialState(){
    try {
      return {
        seen: localStorage.getItem(SOCIAL_INVITE_KEY) === "1",
        followed: localStorage.getItem(SOCIAL_FOLLOW_KEY) === "1"
      };
    } catch { return { seen:false, followed:false }; }
  }
  function _setSocialSeen(){ try{ localStorage.setItem(SOCIAL_INVITE_KEY,"1"); }catch{} }
  function _setSocialFollowed(){ try{ localStorage.setItem(SOCIAL_FOLLOW_KEY,"1"); }catch{} }

  // Função global de tracking — chamada nos botões Seguir
  window.trackFollow = function(who){
    _setSocialFollowed();
    // Telemetria simples: console + atributo data para ouvir analytics externos
    try {
      console.debug("[social] follow:", who);
      document.dispatchEvent(new CustomEvent("h2bapply:social-follow", { detail:{ who, at:new Date().toISOString() } }));
    } catch {}
  };

  // Função global de fechar modal opcional
  window.closeSocialInvite = function(){
    const el = document.getElementById("social-invite");
    if (el) {
      el.style.animation = "socialPop .25s reverse";
      setTimeout(()=>{ el.hidden = true; el.style.animation = ""; }, 240);
    }
    _setSocialSeen();
  };

  // Mostra o modal opcional após delay no landing (sem bloquear)
  function _maybeShowSocialInvite(){
    const landing = document.getElementById("landing");
    if (!landing || landing.style.display === "none") return; // só em landing visível
    const { seen, followed } = _getSocialState();
    if (seen || followed) return; // não incomodar
    const el = document.getElementById("social-invite");
    if (!el) return;
    // Espera 8s para não atrapalhar o usuário entrando
    setTimeout(()=>{
      const stillOnLanding = landing.style.display !== "none";
      if (stillOnLanding && el.hidden) {
        el.hidden = false;
      }
    }, 8000);
  }

  // Helper: dispara ao DOMReady (ou imediato se já carregado)
  function _onReady(fn){
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once:true });
    } else fn();
  }
  _onReady(_maybeShowSocialInvite);

  // Esconde o convite quando o usuário logar (#landing some)
  // Usa MutationObserver leve no display do landing
  _onReady(()=>{
    const landing = document.getElementById("landing");
    if (!landing) return;
    const obs = new MutationObserver(()=>{
      const el = document.getElementById("social-invite");
      if (!el) return;
      const visible = landing.style.display !== "none";
      if (!visible && !el.hidden) el.hidden = true;
    });
    obs.observe(landing, { attributes:true, attributeFilter:["style"] });
  });

  // ═══════════════════════════════════════════════════════════
  // 15.B: VALIDADOR VISUAL DE ENVIO (PDF + Cover)
  // ═══════════════════════════════════════════════════════════
  // Renderiza dentro do modal de envio (#modal) um pequeno bloco
  // que indica em tempo real quais anexos serão enviados.
  // Não modifica o fluxo de envio — só dá feedback ao usuário.

  function _findSendModal(){
    return document.getElementById("modal");
  }

  // Lê estado atual dos documentos selecionados
  function _getActiveDocs(){
    const out = { resume:null, cover:null };
    try {
      if (typeof DOCS !== "undefined" && Array.isArray(DOCS)) {
        if (typeof activeResIdx !== "undefined" && activeResIdx) {
          out.resume = DOCS.find(c => c.idx === activeResIdx) || null;
        } else {
          // fallback: primeiro resume
          out.resume = DOCS.find(c => (c.cvType||"resume") === "resume") || null;
        }
        if (typeof activeCovIdx !== "undefined" && activeCovIdx) {
          out.cover = DOCS.find(c => c.idx === activeCovIdx) || null;
        }
      }
    } catch {}
    return out;
  }

  function _renderSendValidator(){
    const modal = _findSendModal();
    if (!modal) return;
    if (modal.classList.contains("gone")) return;

    // Procura container para inserir (depois de #m-warn ou antes de #m-sending)
    let host = modal.querySelector("#send-validator");
    if (!host) {
      const warn = modal.querySelector("#m-warn");
      const sending = modal.querySelector("#m-sending");
      const anchor = warn || sending;
      if (!anchor) return; // modal sem layout esperado, abortar silencioso
      host = document.createElement("div");
      host.id = "send-validator";
      host.className = "send-validation";
      anchor.parentNode.insertBefore(host, anchor);
    }

    const { resume, cover } = _getActiveDocs();
    const rows = [];

    if (resume) {
      rows.push(`
        <div class="send-validation-row is-ok">
          <i class="ti ti-file-type-pdf"></i>
          <span>Currículo:</span>
          <span class="send-validation-name" title="${_esc(resume.name)}">${_esc(resume.name)}</span>
        </div>`);
    } else {
      rows.push(`
        <div class="send-validation-row is-err">
          <i class="ti ti-alert-triangle"></i>
          <span><strong>Nenhum currículo PDF selecionado.</strong> Vá em <strong>Currículos</strong> e vincule um PDF ao seu perfil.</span>
        </div>`);
    }

    if (cover) {
      rows.push(`
        <div class="send-validation-row is-ok">
          <i class="ti ti-file-description"></i>
          <span>Cover Letter:</span>
          <span class="send-validation-name" title="${_esc(cover.name)}">${_esc(cover.name)}</span>
        </div>`);
    } else {
      rows.push(`
        <div class="send-validation-row is-warn">
          <i class="ti ti-info-circle"></i>
          <span>Sem Cover Letter anexada — o currículo será enviado mesmo assim.</span>
        </div>`);
    }

    host.innerHTML = rows.join("");
  }

  function _esc(s){
    return String(s||"")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  // Observa o modal: se sair de "gone", renderiza o validador
  _onReady(()=>{
    const modal = _findSendModal();
    if (!modal) return;
    const obs = new MutationObserver(()=>{
      if (!modal.classList.contains("gone")) {
        // Pequeno delay para garantir que outros scripts terminaram o setup
        setTimeout(_renderSendValidator, 60);
      }
    });
    obs.observe(modal, { attributes:true, attributeFilter:["class"] });

    // Também reage a mudanças nos slots de perfil (perfil pode trocar resume/cover)
    document.addEventListener("click", (e)=>{
      const t = e.target;
      if (!t) return;
      const isSlotClick = (t.closest && (t.closest(".cv-slot") || t.closest("[onclick*='applyProfileQuick']") || t.closest("[onclick*='applyModalProfileById']")));
      if (isSlotClick && modal && !modal.classList.contains("gone")) {
        setTimeout(_renderSendValidator, 90);
      }
    }, true);
  });

  // ═══════════════════════════════════════════════════════════
  // 15.C: PRÉ-CHECK no doSend (não-bloqueante, só warning)
  // ═══════════════════════════════════════════════════════════
  // Envolve doSend original para avisar caso não haja resume.
  // Se não houver, deixa o servidor decidir (continua o envio),
  // mas mostra um warning UX claro antes.
  _onReady(()=>{
    if (typeof window.doSend !== "function") return;
    const _originalDoSend = window.doSend;
    window.doSend = async function(){
      const { resume } = _getActiveDocs();
      if (!resume) {
        // Mostra warning visual mas não bloqueia (o servidor fará o resto)
        const warn = document.getElementById("m-warn");
        if (warn) {
          warn.innerHTML = `<div class="alert al-amber" style="margin-top:8px"><i class="ti ti-alert-circle"></i><span>Atenção: nenhum currículo PDF está selecionado. Recomendamos enviar um currículo antes de continuar.</span></div>`;
        }
        // Pequeno delay para o usuário ler o warning
        await new Promise(r => setTimeout(r, 600));
      }
      return _originalDoSend.apply(this, arguments);
    };
    console.debug("[v15] doSend wrapped com pré-check de anexos");
  });

  console.debug("[v15] Social + Send Validator carregados");
})();

// ══════════════════════════════════════════════════════════
//  SISTEMA DE IDIOMA (PT / EN / ES) — v19
// ══════════════════════════════════════════════════════════
const LANG_DICT = {
  pt: {
    "h_faq_gone":"Vagas somem do manual em dois casos: (1) voc\u00ea j\u00e1 enviou candidatura para aquela empresa, ou (2) aquela vaga est\u00e1 na fila do autom\u00e1tico. Isso \u00e9 correto \u2014 evita enviar duas vezes para a mesma empresa.", // 🌐 v137b
    "ns1_t":"Crie seu perfil de candidatura","ns1_s":"\u00c9 o que vai nos e-mails para as empresas. Leva 1 minuto.","ns1_c":"Criar perfil","ns2_t":"Anexe seu curr\u00edculo (PDF)","ns2_s":"Sem curr\u00edculo anexado, suas candidaturas n\u00e3o saem.","ns2_c":"Anexar","ns3_t":"Tudo pronto! Comece a se candidatar","ns3_s":"Seu perfil est\u00e1 completo. Envie sua primeira candidatura de hoje.","ns3_c":"Buscar vagas","ns4_t":"Voc\u00ea atingiu o limite de hoje","ns4_s":"Vire VIP e envie at\u00e9 100 candidaturas por dia.","ns4_c":"Ver planos","ns5_t":"Ative o Envio Autom\u00e1tico","ns5_s":"Deixe o sistema enviar candidaturas enquanto voc\u00ea trabalha.","ns5_c":"Ativar","logs_none":"Nenhum log ainda","logs_none_s":"Os logs aparecem aqui quando voc\u00ea usar o Envio Autom\u00e1tico","notif_none_unread":"Nenhuma notifica\u00e7\u00e3o n\u00e3o lida \ud83c\udf89","notif_none":"Nenhuma notifica\u00e7\u00e3o por enquanto","snd_plane":"Avi\u00e3o","snd_plane_d":"Som de decolagem","sug_hero":"Sua ideia pode virar uma funcionalidade! Mande sua sugest\u00e3o para a equipe do H2BApply.","sc_vagas":"\ud83d\udcbc Sobre as vagas", // 🌐 v137: dinâmicos da varredura E2E
    "g_1":"Envio Autom\u00e1tico","g_2":"Configure e deixe o sistema trabalhar por voc\u00ea","g_3":"/m\u00eas","g_4":"Autom\u00e1tico + Manual","g_5":"M\u00e1ximo desempenho","g_6":"Atalhos R\u00e1pidos","g_7":"Curr\u00edculos","g_8":"M\u00eas","g_11":"N\u00fameros","g_12":"\ud83c\udde7\ud83c\uddf7 Portugu\u00eas","g_14":"(at\u00e9 600 caracteres)","g_15":"(at\u00e9 400 caracteres)","g_16":"(at\u00e9 300 caracteres)","g_17":"Ajuda o sistema a encontrar vagas certas pra voc\u00ea","g_18":"J\u00e1 foi aos EUA?","g_19":"\u274c N\u00e3o","g_20":"\ud83d\udde3\ufe0f N\u00edvel de ingl\u00eas","g_21":"\ud83d\udcd6 B\u00e1sico","g_22":"\ud83c\udf1f Avan\u00e7.","g_23":"\ud83c\udf3f \u00c1rea preferida","g_24":"\ud83c\udfd7\ufe0f Constru\u00e7\u00e3o","g_25":"\ud83e\udd9e Frutos do mar","g_26":"\ud83d\udcc5 1 m\u00eas","g_27":"Notifica\u00e7\u00f5es","g_28":"\ud83d\udeeb Alertas do H2BApply","g_29":"Toque no bot\u00e3o para ativar","g_30":"seu curr\u00edculo (PDF)","g_31":"texto do e-mail","g_32":"at\u00e9 2 perfis: um H-2B e um H-2A","g_33":"Anexa seu curr\u00edculo PDF em cada candidatura","g_34":"Define o texto do e-mail em ingl\u00eas","g_35":"Essencial para o Envio Autom\u00e1tico funcionar","g_36":"Curr\u00edculo usado:","g_37":"\ud83d\udcc8 \u00daltimos 7 dias","g_38":"Configura\u00e7\u00f5es exclusivas de administrador","g_39":"Sem expira\u00e7\u00e3o \u00b7 200 manual + 200 auto/dia \u00b7 Prioridade m\u00e1xima","g_40":"segundos entre cada envio","g_41":"3min (padr\u00e3o)","g_42":"Adicione Gmails acima para configurar limites","g_43":"\u00b7 invis\u00edvel para usu\u00e1rios","g_44":"Aten\u00e7\u00e3o:","g_45":"1 Gmail \u00fanico","g_46":"responsabilidade do usu\u00e1rio","g_47":"Os mesmos filtros do Envio Manual \u2014 cargo, local, sal\u00e1rio, grupo e mais","g_48":"Categoria r\u00e1pida (detectada automaticamente)","g_49":"vagas pra voc\u00ea","g_50":"\ud83c\udfaf Seu perfil ser\u00e1 usado em todos os envios:","g_51":"\u25b6 Come\u00e7ar agora","g_52":"Envia sem parar 24/7. Reseta \u00e0 meia-noite e continua at\u00e9 zerar a fila.","g_53":"\ud83d\udd50 Agendar hor\u00e1rio","g_54":"Envia das X \u00e0s Y horas todo dia. Fora do hor\u00e1rio fica pausado.","g_55":"Iniciar \u00e0s","g_56":"Parar \u00e0s","g_62":"Pagamento via PIX","g_63":"*obrigat\u00f3rio","g_64":"Print da confirmação do Pix do seu pagamento","g_65":"Toque para selecionar o comprovante","g_66":"JPG, PNG, PDF \u2014 m\u00e1x 5MB","g_67":"at\u00e9 24h","g_68":"Para d\u00favidas, entre em contato:","g_69":"1 empresa confirmar = voc\u00ea est\u00e1 nos EUA \u2708\ufe0f","g_72":"Aprenda a usar o sistema do zero, passo a passo","g_73":"\ud83d\udccb O que voc\u00ea vai aprender:","g_74":"Resposta da empresa","g_75":"D\u00favidas Comuns","g_76":"Configurar seu Perfil","g_77":"Fa\u00e7a isso ANTES de enviar qualquer candidatura","g_78":"pa\u00eds","g_79":"Aba \"Perfis de Curr\u00edculo\" \u2014 Configurar curr\u00edculo e modelo","g_80":"upload do seu curr\u00edculo em PDF","g_81":"Sem curr\u00edculo, o perfil n\u00e3o \u00e9 salvo.","g_82":"assuntos e corpos de e-mail","g_83":"M\u00ednimo 3 varia\u00e7\u00f5es de cada.","g_84":"Seu perfil est\u00e1 configurado. Agora voc\u00ea pode enviar candidaturas.","g_85":"Envio Manual de Candidaturas","g_86":"Voc\u00ea escolhe cada vaga e envia uma por uma","g_87":"Escolha a planilha de vagas","g_88":"Mais vagas dispon\u00edveis.","g_89":"Como encontrar vagas para voc\u00ea","g_90":"Clique em uma vaga para ver os detalhes","g_91":"Veja o e-mail da empresa e as informa\u00e7\u00f5es da vaga","g_92":"O e-mail com seu curr\u00edculo \u00e9 enviado automaticamente!","g_93":"somem da lista","g_94":"Envio Autom\u00e1tico 24h","g_95":"O sistema envia enquanto voc\u00ea dorme","g_96":"\ud83e\udd16 O que \u00e9 o Envio Autom\u00e1tico?","g_97":"\"Envio Autom\u00e1tico\"","g_98":"quantidade de vagas","g_99":"\"Iniciar Autom\u00e1tico\"","g_100":"\u26a0\ufe0f Aten\u00e7\u00e3o:","g_101":"somem do envio manual","g_102":"A resposta cai direto no SEU Gmail","g_103":"seu pr\u00f3prio Gmail","g_104":"Abra o e-mail da empresa direto no seu Gmail","g_105":"Digite sua resposta em ingl\u00eas e envie \u2014 \u00e9 um e-mail seu, como qualquer outro","g_106":"\ud83d\udca1 Dica de resposta r\u00e1pida:","g_107":"Envie mais candidaturas por dia","g_108":"Gr\u00e1tis","g_109":"VIP · R$100/mês","g_110":"VIPro · R$150/mês","g_111":"DoublePro · R$250/mês","g_112":"\ud83c\udf81 Como ganhar VIP gr\u00e1tis:","g_113":"1 dia VIP Manual","g_114":"C\u00f3digos promocionais","g_115":"D\u00favidas Frequentes","g_116":"Respostas r\u00e1pidas para perguntas comuns","g_117":"N\u00e3o.","g_118":"Ainda com d\u00favidas?","g_119":"Assista aos v\u00eddeos explicativos no YouTube ou fale pelo Instagram","g_128":"desaparecer de qualquer lugar p\u00fablico","g_129":"fazer login novamente com o mesmo e-mail","g_130":"m\u00ednimo 10 caracteres","g_131":"Autom\u00e1tico","g_132":"Vaga n\u00e3o identificada","g_133":"\ud83d\udcc5 Dispon\u00edvel","g_134":"\u2753 D\u00favida","g_135":"Constru\u00e7\u00e3o","g_136":"Dep\u00f3sito","g_137":"\ud83c\udff7\ufe0f Cargo espec\u00edfico","g_138":"\ud83d\udcc2 Categoria r\u00e1pida","g_139":"\ud83c\udf0e Tipo de visto","g_140":"\ud83d\udcf6 Status da vaga","g_141":"Grupo de Randomiza\u00e7\u00e3o","g_142":"\u2014 pode escolher v\u00e1rios estados","g_143":"\ud83d\udcb0 Sal\u00e1rio m\u00ednimo","g_144":"\ud83d\udc65 Qtd. vagas m\u00edn.","g_145":"\u2014 pode marcar v\u00e1rios","g_146":"\ud83c\udfb2 Aleat\u00f3rio (padr\u00e3o)","g_147":"\ud83c\udfaf Melhor pra voc\u00ea primeiro","g_148":"\ud83d\udcb0 Maior sal\u00e1rio primeiro","g_149":"\ud83d\udcc5 Come\u00e7a mais cedo primeiro","g_150":"Este perfil ser\u00e1 usado nos envios manuais e autom\u00e1ticos","g_151":"curr\u00edculo (PDF)","g_152":"\u2460 Informa\u00e7\u00f5es B\u00e1sicas","g_153":"\u00cdcone","g_154":"Escolha um \u00edcone para o perfil:","g_155":"\u2461 Curr\u00edculo &amp; Cover Letter (PDF)","g_156":"\ud83d\udcc4 Curr\u00edculo (PDF)","g_157":"\u2705 Curr\u00edculo vinculado a este perfil","g_158":"\ud83d\udce4 Novo arquivo \u2014 ser\u00e1 enviado ao salvar","g_159":"Clique ou arraste um PDF para fazer upload","g_160":"M\u00e1x. 5MB","g_161":"ou escolha da sua conta","g_162":"Carta de apresenta\u00e7\u00e3o \u2014 n\u00e3o obrigat\u00f3ria, mas aumenta as chances de resposta.","g_163":"apenas nas vagas do tipo de visto deste perfil","g_164":"\u2462 Assuntos do E-mail","g_165":"M\u00ednimo 3","g_166":"Vari\u00e1veis:","g_167":"\u2463 Corpos de E-mail","g_168":"\u2699\ufe0f Vari\u00e1veis \u2014 clique para copiar:","g_169":"3 corpos de e-mail","g_170":"Selecione as categorias para as quais este perfil ser\u00e1 usado automaticamente","g_171":"\u2464 Configura\u00e7\u00e3o","g_172":"Prote\u00e7\u00f5es sempre ativas:","g_173":"n\u00e3o podem ser desativados","g_174":"Not\u00edcias","g_186":"Cada perfil de curr\u00edculo tem o curr\u00edculo vinculado diretamente.","g_187":"O envio autom\u00e1tico sempre usa o PDF do perfil correto \u2014 sem confus\u00e3o.","g_190":"Crie seu primeiro Perfil de Curr\u00edculo para","g_191":"come\u00e7ar a enviar candidaturas","g_204":"S\u00f3 precisa estar logado uma vez.","g_212":". É por ela que conferimos o seu pagamento.","g_221":"No topo da tela de Envio Manual voc\u00ea v\u00ea 3 abas:","g_229":"10 autom\u00e1ticos/dia","g_230":"sem autom\u00e1tico","g_231":"100 autom\u00e1ticos/dia","g_233":"Por que minhas vagas sumiram do manual?","g_234":"O autom\u00e1tico parou. O que fa\u00e7o?","g_235":"Recebi um e-mail em ingl\u00eas. O que fa\u00e7o?","g_175":"Toque em qualquer candidatura para ver detalhes,","g_176":". O bot\u00e3o","g_177":"apaga tudo e faz as vagas voltarem para a lista (\u00fatil para recandidatar-se).","g_178":"Quem já tem um plano ativo pode conectar um Gmail extra para reduzir risco de spam.","g_179":"\ud83c\udfad Escolha seu avatar","g_180":"\ud83d\udca1 O que voc\u00ea escrever aqui aparece quando algu\u00e9m","g_181":"\ud83d\udc64 Sobre voc\u00ea","g_182":"\ud83d\udcbc Experi\u00eancias de trabalho","g_183":"\ud83d\udcac O que voc\u00ea acha do H2BApply?","g_184":"\ud83d\udcbe Salve com o bot\u00e3o","g_185":"no fim da p\u00e1gina.","g_188":". Voc\u00ea pode ter","g_189":"o perfil que voc\u00ea escolher no Passo 3 do assistente","g_192":"Estat\u00edsticas","g_193":"Gmails de envio","g_194":"10 envios GR\u00c1TIS/dia para todos!","g_195":"Enviar muitos emails com","g_196":"pode gerar bloqueio tempor\u00e1rio pelo Google. Recomendamos adicionar","g_197":"para distribuir os envios. O risco de bloqueio \u00e9 de","g_198":"\ud83d\udcec Pr\u00f3ximas candidaturas","g_199":"\u2014 Ver\u00e3o","g_200":"\u26a0\ufe0f Filtro de categoria ativo:","g_201":"\u2014 isso limita as vagas! Para ver todas, clique em \"Todos\" acima.","g_202":"O envio alterna","g_203":"O autom\u00e1tico zerou a fila? Resetar enviados","g_205":"Hor\u00e1rio (Bras\u00edlia)","g_207":"🧾 Meus pedidos","g_210":"📸 Comprovante do pagamento","g_211":"📅 Data em que você pagou","g_213":"), seu plano é ativado","g_214":"Preencha seu","g_215":"(escreva \"Brazil\" em ingl\u00eas),","g_216":"com c\u00f3digo do pa\u00eds (+55 85 99999-9999) e","g_217":"D\u00ea um","g_218":"para o perfil. Ex: \"Meu Perfil Principal\" ou \"Landscape\"","g_219":"(obrigat\u00f3rio). Clique na \u00e1rea pontilhada ou arraste o arquivo.","g_220":"no final da tela.","g_222":"\u2014 Vagas de Ver\u00e3o nos EUA (temporada principal H-2B).","g_223":"\u2014 Vagas de Inverno. Menos vagas, mas ainda v\u00e1lidas.","g_224":"Clique no bot\u00e3o verde","g_225":"Vagas j\u00e1 enviadas","g_226":"que quer colocar no autom\u00e1tico","g_227":"As vagas que voc\u00ea coloca no autom\u00e1tico","g_228":"O H2BApply N\u00c3O l\u00ea nem guarda sua caixa de entrada \u2014 cada candidatura sai do","g_232":"ao se cadastrar (autom\u00e1tico)","g_236":"Se pedir documentos, entre em contato com um despachante de vistos.","g_237":"nas vari\u00e1veis de ambiente do servidor para ativar.","g_239":"Configura\u00e7\u00f5es","g_239b":"Sess\u00e3o","g_239c":"Mais","tut_center":"Central de Tutoriais","settings_adv":"Configura\u00e7\u00f5es avan\u00e7adas","g_240":"Enviar sugest\u00e3o ou ideia pros desenvolvedores","g_241":"Zona de perigo","g_242":"Sugest\u00f5es para os Devs","g_243":"Nova Sugest\u00e3o","g_244":"Sua sugest\u00e3o","g_245":"Fique de olho no","g_246":"para novidades!","g_247":"\ud83d\udc8e Grupo de Randomiza\u00e7\u00e3o","g_248":"\u00e9 exclusivo do plano","g_249":"\ud83d\udccd Localiza\u00e7\u00e3o","g_250":"\ud83d\udcc5 M\u00eas de in\u00edcio da vaga","g_251":"Nome do perfil","g_252":"Descri\u00e7\u00e3o","g_253":"para evitar bloqueio por spam.","g_255":"para evitar spam.","g_256":"Planilhas compat\u00edveis","g_257":"Categorias de vaga", // 🌐 v136: varredura final (auto)
    "gu_t":"Como o H2BApply usa sua conta Google","gu_b":"Pedimos <strong>uma única permissão</strong> do Google: enviar e-mails pelo seu Gmail (<code style=\"background:rgba(255,255,255,.08);padding:1px 6px;border-radius:5px\">gmail.send</code>) — usada exclusivamente para enviar as candidaturas de emprego que <strong>você mesmo escreve e autoriza</strong>. O H2BApply <strong>nunca lê, nunca armazena e nunca acessa sua caixa de entrada</strong>. As respostas dos empregadores chegam direto no seu próprio Gmail. Você pode revogar o acesso a qualquer momento em myaccount.google.com.","gu_l":"Leia nossa Política de Privacidade completa →", // ✅ v145: transparência do uso da conta Google (verificação OAuth)
    "pe_draft_confirm":"📝 Achamos um rascunho salvo deste perfil (sua sessão deve ter caído antes de salvar). Restaurar o texto?","pe_draft_restored":"📝 Rascunho restaurado","pe_session_lost":"🔒 Sua sessão caiu (o servidor reiniciou) — seu texto JÁ ESTÁ SALVO aqui no aparelho. Faça login de novo e abra este perfil de novo que ele volta sozinho.", // 📝 v143: rascunho do editor de perfil (caso Keyla)
    "au_t":"Regra de conta única — leia antes de entrar","au_b":"Cada pessoa pode ter UMA conta no H2BApply. Criar uma segunda conta — mesmo com outro e-mail — pode causar BAN PERMANENTE das duas contas, sem devolução de nada. Lembre-se: o nome no seu currículo é sempre o mesmo, e o sistema cruza nome, telefone e aparelho sozinho — conta duplicada é fácil de detectar. As vagas de acesso são limitadas: use sempre o MESMO usuário e nunca crie uma segunda conta.","au_f":"✅ 1 pessoa = 1 conta = todos os seus envios e dias de VIP sempre juntos e seguros.", // ⚠️ v149: regra de conta única (ordem do dono)
    "mc_1":"Minha Conta","mc_13":"Comprovante recebido — aguardando confirmação","mc_14":"Renove seu plano na aba Planos.","mc_15":"ATENÇÃO: expira em","mp_pend":"⏳ Em análise","mp_pago":"💰 Pagamento recebido — aguardando confirmação","mp_canc":"✖ Cancelado","mp_canc_sub":"Se achar que foi engano, chame no WhatsApp","mp_motivo":"Motivo","mp_ileg":"⚠️ Não conseguimos ler seu comprovante — reenvie uma foto nítida.","mp_ok":"✅ Comprovante conferido pelo robô","mp_analise":"🔍 Comprovante em análise","mp_reenviar":"📤 Reenviar comprovante","mp_media":"confirmação média real","mp_sub24":"Analisamos e confirmamos — você recebe notificação","mp_vertodos":"ver todos", "mc_2":"Plano Grátis","mc_3":"envios manuais por dia","mc_7":"🧾 Último pedido:","mc_8":"aguardando confirmação do admin","mc_9":"confirmado — plano ativado","mc_10":"cancelado","mc_11":"Você ainda não fez nenhum pedido.","mc_12":"Assine um plano quando quiser para aumentar seu limite diário.", // 👤 2.0-P6: Minha Conta em 5s (v170: sem sistema de diamantes)
    "tut_t":"Central de Tutoriais","tut_s":"20 passo a passos com fotos reais — tudo o que dá pra fazer no H2BApply, explicado tela por tela","tut_ph":"🔍 O que você quer aprender? Ex.: currículo, automático, planos...","tut_v":"Nada encontrado com essa palavra — tente outro termo (ex.: \"enviar\", \"plano\", \"perfil\").","tut_load":"⏳ Carregando os tutoriais...", // 📖 v160
    "consent_title":"☑️ Antes de continuar","consent_b1":"É um serviço digital pago de automação de envio — o H2BApply nunca escreve o e-mail por você; o conteúdo enviado é sempre seu.","consent_b2":"O preço mostrado agora é o valor final a pagar.","consent_b3":"Depois de pagar via PIX, envie o comprovante e continue logado na mesma conta até a confirmação — automática quando bate, e sempre conferida pela nossa equipe.","consent_b4":"O risco de bloqueio da conta Gmail é do Google (terceiro), não do H2BApply — dá pra reduzir usando mais de uma conta de envio.","consent_b5":"Você pode acompanhar o status do seu pedido a qualquer momento na aba 🧾 Meus pedidos.","consent_check":"Li e entendo como o programa funciona e o que estou pagando.","consent_terms_link":"Ver Termos completos →","consent_required_msg":"Marque que você leu e entende antes de continuar.","consent_choose_plan":"Escolha um plano e o período antes de continuar.","plan_step1_title":"Escolha seu plano e período","plan_step1_intro":"Você paga <strong>diretamente</strong> pelo plano escolhido — sem moeda intermediária. Veja os limites de cada plano, escolha o período e o preço final aparece na hora, antes de pagar.","plan_calc_empty":"Escolha um plano e o período","plan_error_load":"Não deu pra carregar os planos.","plan_try_again":"Tentar de novo", // 💎 v170: compra direta de plano — consentimento informado (CEO mode, 09/09/2026)
    "pv_title":"Vagas pra você","pv_all":"Ver todas","pv_apply":"Candidatar","pv_apply_t":"Candidatar a esta vaga","pv_w1":"categoria que você prefere","pv_w2":"dentro do que seu perfil mira","pv_w3":"estado do seu perfil","pv_w4":"pede experiência e você já tem","pv_w5":"aceita quem está começando","pv_w6":"pede experiência que você ainda não tem","pv_w7":"pede inglês avançado","pv_w8":"não exige inglês avançado","pv_w9":"seu inglês avançado é diferencial aqui", // 🎯 v139: Vagas pra você (Home)
    "snd_title":"Som de nova resposta","snd_sel":"selecionado!","hs_t":"Bem-vindo ao H2BApply!","hs1":"Vá em <strong>Perfil → Perfis de Email</strong> e configure seu currículo","hs2":"Acesse <strong>Envio Manual</strong> para escolher vagas e candidatar","hs3":"Ative o <strong>Envio Automático</strong> para candidaturas 24h no piloto automático","hs4":"As respostas caem direto no <strong>seu próprio Gmail</strong> — fique de olho por lá","fq1":"Fila concluída! Você aplicou para todas as vagas.","fq2":"🏆 Fila concluída! Aguarde as respostas chegarem.","fq3":"Todas as candidaturas enviadas! O sucesso está a caminho.","fq4":"Fila zerada! Você deu um grande passo hoje.","h_faq_qty_q":"Quantos e-mails devo enviar por dia?","h_faq_qty":"Quanto mais melhor — mas com qualidade. O sistema tem proteção anti-spam. No plano gratuito são 20 manuais + 10 automáticos por dia. Com VIP Manual são 100 manuais por dia. Com VIPro são 100 + 100 por dia. Com DoublePro (2 Gmails) são 200 + 200 por dia. Enviar para muitas empresas aumenta suas chances.","h_faq_reply":"Abra o e-mail direto no seu Gmail e leia. Se a empresa perguntar se você está disponível, responda: <em>\"Yes, I am available to start on the requested date.\"</em> Se pedir documentos, entre em contato com um despachante de vistos.","h_faq_visa":"<strong>Isso garante emprego ou visto? Não.</strong> O H2BApply é uma ferramenta que envia e-mails para você. A decisão de te contratar é do empregador. A decisão do visto é do consulado americano. Quanto mais candidaturas você enviar, maiores as chances de receber uma oferta.","g_258":"Já pagou antes? É só enviar o mesmo comprovante na tela de planos — sem pagar de novo.","g_259":"Digite o nome da empresa, um e-mail recebido, o ETA case number, o cargo ou o estado para encontrar todas as vagas correspondentes","g_260":"Adicione um segundo Gmail. O automático distribui os envios entre os dois emails, reduzindo risco de spam.","g_261":"Os e-mails sairão com o currículo e os textos do perfil escolhido no Passo 3 — assuntos e corpos alternam automaticamente contra spam.","g_262":"O sistema rotaciona entre os assuntos e corpos de e-mail cadastrados para evitar parecer spam. Quer ajustar algo? Toque em \"Trocar\" acima.","g_263":"Escreva seu nome exatamente como está no passaporte. Se o nome estiver errado, pode causar problemas com o empregador.","g_264":"É como um robô que trabalha por você. Você configura uma vez e ele fica enviando candidaturas sozinho, mesmo com seu celular desligado.","g_265":"Verifique na aba Home se o automático ainda aparece como ativo. Se parou, pode ter atingido o limite diário do seu plano — ele reinicia automaticamente no dia seguinte à meia-noite.","g_266":"Nenhum assunto ainda. Escreva pelo menos 3 variações suas em \"+ Adicionar\" — use as variáveis acima pra personalizar automaticamente.","g_267":"Nenhum corpo de e-mail ainda. Escreva pelo menos 3 variações suas em \"+ Adicionar\" — use as variáveis acima pra personalizar automaticamente.","g_268":"Perfil único: seu perfil serve automaticamente para qualquer vaga, de qualquer planilha.","g_269":"⚙️ Filtros avançados","g_270":"Você escreve os textos — o H2BApply nunca preenche isso por você, só entrega.","g_271":"escritos por você","g_272":"as suas versões, escritas por você","g_273":"Máx. 3MB", // 🌐 v137c: sons/boas-vindas/extrato/FAQ + 11 textos longos da varredura
    // Nav
    "home":"Home","manual":"Manual","search":"Pesquisar","auto":"Auto","responses":"Respostas",
    // Sidebar
    "notifications":"Notificações","plans":"💎 Planos","profile":"Perfil","admin":"Painel Admin","logout":"Sair","logout_confirm":"Sair da sua conta? Você pode entrar de novo a qualquer momento com o mesmo e-mail do Google.", // v167: botão de sair (achado E2E crítico)
    // Home
    "auto_title":"Envio Automático","auto_sub":"Toque para configurar e iniciar",
    "shortcuts":"Atalhos Rápidos","today":"Hoje","account":"Conta","latest_replies":"Últimas Respostas",
    "manual":"Manual","search":"Pesquisar","responses":"Respostas","auto_lbl":"Automático","total_sends":"Total","profile_lbl":"Perfil",
    "plans_rewards":"Planos & Recompensas",
    "sent_apps":"Candidaturas Enviadas","me":"Eu","profiles":"Currículos","seasonal_jobs":"Vagas ao Vivo",
    // Plans
    "plan_free":"Plano Free","plan_vip":"Plano VIP","plan_pro":"Plano Pro","plan_vipro":"Plano VIPro","plan_doublepro":"Plano DoublePro",
    "roi_calc":"Calculadora de Resultados","roi_if":"Se apenas 1% das empresas responder positivamente:","roi_cta":"Basta 1 empresa confirmar → você está nos EUA ✈️",
    // Jobs
    "all_states":"Todos estados","salary":"Salário","qty_jobs":"Qtd vagas",
    // v119: sugestões instantâneas da busca
    "sug_companies":"Empresas","sug_roles":"Cargos","sug_cities":"Cidades","sug_regions":"Regiões","sug_states":"Estados","sug_jobs":"vagas",
    "extra_gmail":"Gmail Extra para Envios","upgrade_to_enable":"Assine um plano para ativar.","tap_to_pick":"(toque para escolher)","search_btn":"Buscar",
    // 📡⭐ v134 — Radar de Vagas + funil do limite
    "radar_btn":"📡 Radar","radar_title":"Radar de Vagas","radar_sub":"Salve os filtros de agora (busca, estado, cidade) e receba um aviso no celular quando entrar vaga NOVA que combina — no máximo 1 aviso por dia.",
    "radar_create":"Criar radar com os filtros atuais","radar_active":"Seu radar está LIGADO","radar_off":"Desligar radar",
    "radar_all":"Todas as vagas novas","radar_alerts":"aviso(s) já enviados","radar_created":"Radar ligado! Você será avisado quando entrar vaga nova que combina.","radar_removed":"Radar desligado.",
    "upsell_title":"Seu limite de hoje acabou — as vagas não esperam","upsell_left":"Ainda restam {n} vagas disponíveis HOJE que você não vai alcançar no plano atual. Assine um plano e continue agora mesmo — comprovante conferido, plano ativado.",
    "upsell_left_generic":"Amanhã o limite volta — mas as melhores vagas de hoje já terão recebido outros candidatos. Assine um plano e continue agora.",
    "upsell_cta":"Ver planos e assinar","upsell_later":"Continuar amanhã de graça",
    // 🌐 Etapa 5 do i18n — status dinâmicos do robô
    "st_starting":"🟡 Iniciando...","st_sending":"🟢 Enviando...","st_paused":"⏸ Pausado",
    "st_no_session":"⚠️ Faça login novamente","st_finished":"✅ Concluído","st_resuming":"🟢 Retomando...",
    "st_refilled":"🔄 Fila recarregada — enviando...","st_wait_interval":"⏳ Aguardando intervalo...","st_wait_hour":"⏳ Aguardando horário...",
    "st_wait_limit":"📊 Limite diário atingido","st_wait_rate":"⏳ O Google pediu uma pausa — retomamos sozinhos",
    "st_auth_err":"⛔ Pausado — reconecte seu Gmail","st_token_revoked":"🔐 Acesso Google revogado — faça login de novo",
    "st_no_refresh":"🔐 Faça login de novo para reativar","st_corrupt":"❌ Fila com problema — reinicie o automático",
    "hint_auth_err":"Abra Configurações e conecte sua conta Google de novo — sua fila continua salva.",
    "hint_token_revoked":"Saia e faça login com o Google de novo — sua fila continua salva.",
    "hint_no_refresh":"Faça login com o Google de novo — sua fila continua salva.",
    "hint_no_session":"Entre de novo com o Google — sua fila continua salva.",
    "hint_corrupt":"Toque em Parar e inicie o automático de novo.",
    "hint_rate":"Proteção normal do Gmail contra spam — nada a fazer, o robô retoma sozinho.",
    "cd_soon":"Enviando em instantes...","cd_next":"Próximo envio em","cd_starts":"Inicia em","cd_resumes":"Retoma em",
    // 🌐 Etapa 4 do i18n — Perfil/Planos/Ranking/Configurações
    "personal_data":"Dados Pessoais","full_name":"Nome completo *","country":"País","required_lbl":"OBRIGATÓRIO",
    
    
    
    "plans_title":"Planos H2BApply","plans_sub":"Escolha um plano, pague via PIX e envie o comprovante",
    "plans_note":"Comprovante conferido automaticamente • Confirmação final sempre por um admin",
    
    "contact_data":"Seus dados de contato","contact_sub":"Para ativarmos seu plano e entrar em contato",
    "order_summary":"📋 Resumo do pedido","notes_lbl":"Observações",
        "settings_sub":"Sua conta, sua privacidade.","your_account":"Sua conta","how_works":"💡 Como funciona?",
    "sug_step1":"Escreva sua sugestão e clique em enviar","sug_step2":"A equipe recebe e analisa todas as sugestões",
    "sug_step3":"As mais pedidas viram funcionalidades nas próximas atualizações","sug_sent":"📋 Suas sugestões enviadas",
    // 🌐 Etapa 3 do i18n — Automático/Notificações
    "auto_cfg_sub":"Configure uma vez. O sistema envia enquanto você trabalha.",
    "in_queue":"Na fila","daily_limit":"Limite diário","queue_progress":"Progresso da fila","last_sends":"Últimos envios",
    "auto_src_title":"Escolha a fonte das vagas","auto_src_sub":"Selecione de onde puxar as vagas",
    "auto_cv_title":"Qual currículo usar?","auto_cv_sub":"Os e-mails sairão com o currículo e os textos deste perfil",
    "auto_start_btn":"🤖 Começar Envio Automático","auto_confirm_btn":"🚀 Confirmar Envio Automático",
    "auto_when":"Quando começar?","auto_bg_ok":"✅ Funciona com app fechado!",
    "notif_sub":"Avisos e atualizações do sistema",
    // 🌐 Etapa 2 do i18n — Vagas/Pesquisa/modal de envio
    "sort_rand":"🔀 Aleatório","sort_match":"🎯 Melhor pra mim","sort_wage":"💰 Maior salário","sort_start":"🗓️ Começa logo","sort_recent":"Recentes",
    "q_ph":"Cargo, empresa...","q_state_ph":"📍 Estado…","q_city_ph":"🏙️ Cidade…","f_city_ph":"🏙️ Cidade ou região — ex.: Martha´s Vineyard, Key West…",
    "manual_today":"Envios manuais hoje","send_by":"📧 Enviar por","send_profile":"📋 Perfil de envio","resume_lbl":"📄 Currículo",
    "cancel":"Cancelar","send_btn":"Enviar","sending":"Enviando...","optional_lbl":"(opcional)","add_new":"+ Adicionar",
    "logs_auto_title":"📋 Logs do Envio Automático","logs_auto_sub":"Histórico completo de todos os envios automáticos",
    // 🌐 Etapa 1 do i18n profissional (12/08)
    "home_welcome":"Bem-vindo(a) de volta! Pronto para enviar muitas candidaturas hoje?",
    "home_hero_badge":"Vagas sazonais em todo os EUA","home_hero_h1a":"Trabalhe nos EUA","home_hero_h1b":"com mais oportunidades",
    "home_stat_jobs":"Vagas Disponíveis","home_stat_companies":"Empresas Contatadas","home_stat_emails":"E-mails Enviados",
    "home_activity_title":"Atividade Recente","home_tips_title":"Dicas para mais respostas",
    "home_tip1":"Use um currículo em inglês claro e objetivo.","home_tip2":"Envie para muitas vagas — o volume aumenta suas chances.",
    "home_tip3":"Personalize a carta de apresentação.","home_tip4":"Mantenha seu perfil sempre atualizado.","home_tip5":"Verifique sua caixa de spam.",
    "home_tip_quote":"Disciplina hoje, oportunidades amanhã.",
    "home_auto_b1":"Envia pra várias vagas por dia","home_auto_b3":"Nunca repete uma candidatura","home_auto_b4":"Funciona 24h — você não precisa ficar online","home_auto_cta":"Iniciar Envio Automático",
    "home_man_b1":"Pesquise e filtre as vagas","home_man_b4":"Envie quando estiver pronto",
    "manual_send_title":"Envio Manual","manual_send_sub":"Busque vagas e envie candidaturas agora",
    "plans_send_title":"💎 Planos","plans_send_sub":"Assine um plano e turbine seus envios", // 🌐 v166: 3º CTA da Home
    "home_cv_tip":"Mantenha seu currículo sempre atualizado.","home_cv_tip_link":"Editar currículo →", // 🌐 v166: dica discreta da Home
    "inicio":"Início","auto_send":"Envio Automático","manual_send":"Envio Manual",
    "bn_jobs":"Vagas","bn_more":"Mais","bn_more_title":"Mais opções","bn_auto":"Envio Automático","bn_tutorial":"Central de Tutoriais","bn_settings":"Configurações", // 📱 v171: bottom-nav de 5 itens (era 3 — Enviadas/Vagas não tinham acesso direto no mobile)
    "sent_tab":"Enviadas","download_app":"Baixar App",
    "hist_short":"Enviadas","saved_short":"Salvas",
    "greet_m":"👋 Bom dia,","greet_t":"👋 Boa tarde,","greet_n":"👋 Boa noite,","greet_d":"👋 Madrugada,",
    // v126: aba Vagas Salvas
    "saved_jobs":"Vagas Salvas","saved_ok":"Vaga salva!","saved_removed":"Removida das salvas",
    "saved_empty":"Nenhuma vaga salva","saved_empty_sub":"Toque no 🔖 de qualquer vaga para guardá-la aqui",
    "saved_remove":"Remover dos salvos","saved_already_sent":"já enviada","saved_no_email":"Esta vaga não tem e-mail — abra o link do DOL",
    "saved_apply_title":"Candidatar-se",
    // v120: cooldown do manual editável
    "cd_on_lbl":"Proteção: 1 min entre envios manuais","cd_change":"alterar",
    "cd_off_lbl":"Proteção de 1 min DESLIGADA","cd_reactivate":"reativar",
    "cd_modal_title":"Desligar a proteção de 1 minuto?",
    "cd_modal_body":"O intervalo de 1 minuto entre envios manuais protege a sua conta. Enviar muitos e-mails rápido demais faz o Google marcar sua conta como spam — e o seu Gmail tem MUITA chance de ser BLOQUEADO PARA SEMPRE. O envio automático não muda: continua 1 a cada 7 minutos.",
    "cd_modal_agree":"Entendo o risco: meu Gmail pode ser bloqueado para sempre, e a responsabilidade é minha.",
    "cd_modal_keep":"Manter proteção","cd_modal_off":"Desligar mesmo assim",
    "cd_toast_off":"⚠️ Proteção de 1 min desligada — cuidado com o ritmo!","cd_toast_on":"✅ Proteção de 1 min reativada",
    "all":"Todas","all_f":"Todas","active_f":"✅ Ativas","random":"🔀 Aleatório","recent":"Recentes","oldest":"Antigas",
    "select_job":"Selecione uma vaga","select_job_sub":"Clique para ver os detalhes e candidatar-se",
    "back_jobs":"Voltar às vagas","job_search_ph":"Cargo, empresa, estado...",
    // History
    "hist_title":"Candidaturas Enviadas","hist_search_ph":"Buscar empresa, cargo ou e-mail...","hist_banner":"Suas candidaturas, sempre à mão",
    "hist_info":"O botão Reset apaga tudo e faz as vagas voltarem para a lista (útil para recandidatar-se).","home_footer_tag":"Mais que um sistema. É o seu próximo passo.",
    // Search
    "search_jobs":"Buscar Vagas","search_sub":"Busca em todas as fontes: Seasonal, Jan 2026, Jul 2025",
    "search_ph":"Empresa, e-mail, ETA case number, cargo, estado...","clear":"Limpar",
    "all_sources":"Todas as fontes","sent":"Enviadas",
    "search_anything":"Pesquise qualquer coisa",
    "search_hint":"Digite o nome da empresa, um e-mail recebido, o ETA case number, o cargo ou o estado",
    // Responses
    "all_inbox":"Todos","unread":"Não lidas","favorites":"Favoritos","this_week":"Esta semana",
    "enable_notif":"Ativar notificações","enable_notif_sub":"Receba avisos de confirmação de comprovante, status do automático e novidades — mesmo com o app fechado",
    "activate":"Ativar","inbox_search_ph":"Buscar empresa, assunto...","notif_short":"Notif",
    "reply_alert":"Alerta de nova resposta","reply_alert_sub":"Som + aviso de confirmação de comprovante, status do automático e novidades (o site não lê e-mail — não avisamos quando a empresa responde)",
    "pipe_responded":"Respondeu","pipe_positive":"Interesse","pipe_interview":"Entrevista","pipe_offer":"Oferta",
    // Ranking
    
    
    // Profile
    "full_name":"Nome completo *","country":"País","city":"Cidade",
    "full_name_ph":"Seu nome completo","country_ph":"Brazil","save_data":"Salvar dados",
    "tap_to_enable":"Toque no botão para ativar","new_profile":"Criar Novo Perfil",
    "email_profiles":"Perfis de Currículo","profiles_desc":"Cada perfil define o assunto, o corpo do e-mail e o currículo a usar. O sistema escolhe o perfil certo para cada vaga automaticamente.",
    "no_profiles":"Nenhum perfil criado","no_profiles_sub":"Crie seu primeiro perfil para começar a enviar",
    "total_sent":"Total enviados","companies_lbl":"🏢 Empresas","states_lbl":"🗺️ Estados",
    "last_7days":"Últimos 7 dias","top_states":"Top Estados","share_stats":"Compartilhar resultado",
    // Auto
    "auto_hero_sub":"Configure uma vez. O sistema envia enquanto você trabalha.",
    "auto_free":"10 envios GRÁTIS/dia para todos!",
    "ws1_title":"Escolha a fonte das vagas","ws1_sub":"Selecione de onde puxar as vagas",
    "ws2_title":"Filtros (opcional)","summer":"Verão","winter":"Inverno",
    "service_type":"Tipo de serviço (detectado automaticamente)",
    "state_opt":"Estado (opcional)","only_with_email":"Somente vagas com e-mail",
    "min_salary":"Salário mínimo por hora (USD)","any_salary":"Qualquer","with_email_only":"Só com e-mail",
    "all_ready":"Tudo pronto? Inicie agora!","start_auto":"🤖 Começar Envio Automático",
    "sent_lbl":"Enviados","failed":"Falhas","in_queue":"Na fila","daily_limit":"Limite diário",
    "progress":"Progresso","next_app":"Próxima candidatura",
    "pause":"Pausar","resume":"Retomar","stop":"Parar","latest_sends":"Últimos envios",
    // Preflight
    "confirm_auto":"Confirmar Envio Automático","jobs_in_queue":"vagas na fila",
    "est_time":"tempo estimado","between_emails":"entre e-mails",
    "start_now":"Começar agora","start_now_sub":"1º e-mail sai em segundos. Usa a janela já configurada.",
    "schedule":"Agendar horário","schedule_sub":"Começa e para em horário que você escolher (BRT).",
    "schedule_time":"Horário (Brasília)","start_at":"Iniciar às","stop_at":"Parar às",
    "cancel":"Cancelar","confirm_start":"Confirmar e Iniciar",
    "gmail_limit_title":"Limite Gmail","works_closed":"Funciona com app fechado!",
    "only_login_once":"Só precisa estar logado uma vez.",
    "when_start":"Quando começar?","how_profiles_used":"Como seus perfis serão usados:",
    // Notifications
    "notif_sub":"Avisos e atualizações do sistema","notif_unread":"Não lidas","notif_all":"Todas",
    // Logs
    "logs":"Logs",
    // Send modal
    "send_title":"Enviar Candidatura","send_profile":"Perfil de envio","send_btn":"Enviar",
    // General
    "loading":"Carregando...","error":"Erro","retry":"Tentar novamente","save":"Salvar",
    "close":"Fechar","send":"Enviar","delete":"Excluir","edit":"Editar","back":"Voltar",
    // Sys notif
    "sys_notif_label":"Aviso do Sistema","sys_notif_ok":"✅ Li e entendi","sys_notif_all":"🔔 Ver todas notificações",
  },
  en: {
    "h_faq_gone":"Jobs disappear from manual in two cases: (1) you already applied to that company, or (2) that job is in the auto queue. That's correct \u2014 it prevents emailing the same company twice.", // 🌐 v137b
    "ns1_t":"Create your application profile","ns1_s":"It's what goes in the emails to companies. Takes 1 minute.","ns1_c":"Create profile","ns2_t":"Attach your resume (PDF)","ns2_s":"Without a resume attached, your applications won't go out.","ns2_c":"Attach","ns3_t":"All set! Start applying","ns3_s":"Your profile is complete. Send your first application today.","ns3_c":"Find jobs","ns4_t":"You hit today's limit","ns4_s":"Go VIP and send up to 100 applications a day.","ns4_c":"See plans","ns5_t":"Turn on Auto Send","ns5_s":"Let the system send applications while you work.","ns5_c":"Turn on","logs_none":"No logs yet","logs_none_s":"Logs show up here once you use Auto Send","notif_none_unread":"No unread notifications \ud83c\udf89","notif_none":"No notifications for now","snd_plane":"Airplane","snd_plane_d":"Takeoff sound","sug_hero":"Your idea can become a feature! Send your suggestion to the H2BApply team.","sc_vagas":"\ud83d\udcbc About the jobs", // 🌐 v137: dinâmicos da varredura E2E
    "g_1":"Auto Send","g_2":"Set it up and let the system work for you","g_3":"/mo","g_4":"Auto + Manual","g_5":"Maximum performance","g_6":"Quick Access","g_7":"Resumes","g_8":"Month","g_11":"Stats","g_12":"\ud83c\udde7\ud83c\uddf7 Portugu\u00eas","g_14":"(up to 600 characters)","g_15":"(up to 400 characters)","g_16":"(up to 300 characters)","g_17":"Helps the system find the right jobs for you","g_18":"Ever been to the USA?","g_19":"\u274c No","g_20":"\ud83d\udde3\ufe0f English level","g_21":"\ud83d\udcd6 Basic","g_22":"\ud83c\udf1f Advanced","g_23":"\ud83c\udf3f Preferred area","g_24":"\ud83c\udfd7\ufe0f Construction","g_25":"\ud83e\udd9e Seafood","g_26":"\ud83d\udcc5 1 month","g_27":"Notifications","g_28":"\ud83d\udeeb H2BApply alerts","g_29":"Tap the button to enable","g_30":"your resume (PDF)","g_31":"the email text","g_32":"up to 2 profiles: one H-2B and one H-2A","g_33":"Attaches your PDF resume to every application","g_34":"Sets the email text in English","g_35":"Essential for Auto Send to work","g_36":"Resume used:","g_37":"\ud83d\udcc8 Last 7 days","g_38":"Admin-only settings","g_39":"No expiration \u00b7 200 manual + 200 auto/day \u00b7 Top priority","g_40":"seconds between each send","g_41":"3min (default)","g_42":"Add Gmails above to set limits","g_43":"\u00b7 invisible to users","g_44":"Warning:","g_45":"1 single Gmail","g_46":"user's responsibility","g_47":"Same filters as Manual Send \u2014 role, location, pay, group and more","g_48":"Quick category (auto-detected)","g_49":"jobs for you","g_50":"\ud83c\udfaf Your profile will be used in every send:","g_51":"\u25b6 Start now","g_52":"Sends non-stop 24/7. Resets at midnight and keeps going until the queue is empty.","g_53":"\ud83d\udd50 Schedule hours","g_54":"Sends from X to Y o'clock every day. Outside that window it pauses.","g_55":"Start at","g_56":"Stop at","g_62":"Payment via PIX","g_63":"*required","g_64":"Screenshot of your PIX payment confirmation","g_65":"Tap to select the receipt","g_66":"JPG, PNG, PDF \u2014 max 5MB","g_67":"within 24h","g_68":"Questions? Contact us:","g_69":"1 company saying yes = you're in the USA \u2708\ufe0f","g_72":"Learn the system from scratch, step by step","g_73":"\ud83d\udccb What you'll learn:","g_74":"Company reply","g_75":"Common Questions","g_76":"Set Up Your Profile","g_77":"Do this BEFORE sending any application","g_78":"country","g_79":"\"Resume Profiles\" tab \u2014 set up resume and template","g_80":"upload your resume as PDF","g_81":"Without a resume, the profile won't save.","g_82":"email subjects and bodies","g_83":"At least 3 variations of each.","g_84":"Your profile is set. You can now send applications.","g_85":"Manual Application Sending","g_86":"You pick each job and send one by one","g_87":"Choose the job sheet","g_88":"More jobs available.","g_89":"How to find jobs for you","g_90":"Click a job to see the details","g_91":"See the company's email and the job info","g_92":"The email with your resume is sent automatically!","g_93":"disappear from the list","g_94":"24h Auto Send","g_95":"The system sends while you sleep","g_96":"\ud83e\udd16 What is Auto Send?","g_97":"\"Auto Send\"","g_98":"number of jobs","g_99":"\"Start Auto\"","g_100":"\u26a0\ufe0f Warning:","g_101":"disappear from manual sending","g_102":"Replies land straight in YOUR Gmail","g_103":"your own Gmail","g_104":"Open the company's email right in your Gmail","g_105":"Type your reply in English and send \u2014 it's your own email, like any other","g_106":"\ud83d\udca1 Quick reply tip:","g_107":"Send more applications per day","g_108":"Free","g_109":"VIP · $100/mo","g_110":"VIPro · $150/mo","g_111":"DoublePro · $250/mo","g_112":"\ud83c\udf81 How to earn free VIP:","g_113":"1 day of VIP Manual","g_114":"Promo codes","g_115":"FAQ","g_116":"Quick answers to common questions","g_117":"No.","g_118":"Still have questions?","g_119":"Watch the explainer videos on YouTube or reach out on Instagram","g_128":"disappear from anywhere public","g_129":"log in again with the same email","g_130":"at least 10 characters","g_131":"Auto","g_132":"Job not identified","g_133":"\ud83d\udcc5 Available","g_134":"\u2753 Question","g_135":"Construction","g_136":"Warehouse","g_137":"\ud83c\udff7\ufe0f Specific role","g_138":"\ud83d\udcc2 Quick category","g_139":"\ud83c\udf0e Visa type","g_140":"\ud83d\udcf6 Job status","g_141":"Randomization Group","g_142":"\u2014 you can pick several states","g_143":"\ud83d\udcb0 Minimum wage","g_144":"\ud83d\udc65 Min. openings","g_145":"\u2014 you can check several","g_146":"\ud83c\udfb2 Random (default)","g_147":"\ud83c\udfaf Best for you first","g_148":"\ud83d\udcb0 Highest pay first","g_149":"\ud83d\udcc5 Earliest start first","g_150":"This profile will be used for manual and automatic sends","g_151":"resume (PDF)","g_152":"\u2460 Basic Info","g_153":"Icon","g_154":"Pick an icon for the profile:","g_155":"\u2461 Resume &amp; Cover Letter (PDF)","g_156":"\ud83d\udcc4 Resume (PDF)","g_157":"\u2705 Resume linked to this profile","g_158":"\ud83d\udce4 New file \u2014 will upload when you save","g_159":"Click or drag a PDF to upload","g_160":"Max 5MB","g_161":"or pick one from your account","g_162":"Cover letter \u2014 optional, but boosts reply chances.","g_163":"only for jobs matching this profile's visa type","g_164":"\u2462 Email Subjects","g_165":"At least 3","g_166":"Variables:","g_167":"\u2463 Email Bodies","g_168":"\u2699\ufe0f Variables \u2014 click to copy:","g_169":"3 email bodies","g_170":"Select the categories this profile will be used for automatically","g_171":"\u2464 Settings","g_172":"Always-on protections:","g_173":"cannot be turned off","g_174":"News","g_175":"Tap any application to see details,","g_176":". The","g_177":"button wipes everything and puts the jobs back on the list (handy to re-apply).","g_178":"Anyone with an active plan can connect an extra Gmail to lower spam risk.","g_179":"\ud83c\udfad Pick your avatar","g_180":"\ud83d\udca1 Whatever you write here shows up when someone","g_181":"\ud83d\udc64 About you","g_182":"\ud83d\udcbc Work experience","g_183":"\ud83d\udcac What do you think of H2BApply?","g_184":"\ud83d\udcbe Save with the button","g_185":"at the bottom of the page.","g_186":"Each resume profile has its resume linked directly.","g_187":"Auto send always uses the right profile's PDF \u2014 no mix-ups.","g_188":". You can have","g_189":"the profile you pick in Step 3 of the wizard","g_190":"Create your first Resume Profile to","g_191":"start sending applications","g_192":"Statistics","g_193":"Sending Gmails","g_194":"10 FREE sends/day for everyone!","g_195":"Sending many emails with","g_196":"can trigger a temporary block by Google. We recommend adding","g_197":"to spread the sends. The block risk is","g_198":"\ud83d\udcec Upcoming applications","g_199":"\u2014 Summer","g_200":"\u26a0\ufe0f Category filter on:","g_201":"\u2014 that limits the jobs! To see all, click \"All\" above.","g_202":"Sending alternates","g_203":"Auto queue hit zero? Reset sent","g_204":"You only need to be logged in once.","g_205":"Time (Bras\u00edlia)","g_207":"🧾 My orders","g_210":"📸 Payment receipt","g_211":"📅 Date you paid","g_212":". That's how we verify your payment.","g_213":"), your plan is activated","g_214":"Fill in your","g_215":"(write \"Brazil\" in English),","g_216":"with country code (+55 85 99999-9999) and","g_217":"Give a","g_218":"name to the profile. E.g. \"My Main Profile\" or \"Landscape\"","g_219":"(required). Click the dotted area or drag the file.","g_220":"at the bottom of the screen.","g_221":"At the top of the Manual Send screen you'll see 3 tabs:","g_222":"\u2014 Summer jobs in the USA (main H-2B season).","g_223":"\u2014 Winter jobs. Fewer, but still valid.","g_224":"Click the green button","g_225":"Jobs already sent","g_226":"you want to add to auto","g_227":"The jobs you put on auto","g_228":"H2BApply does NOT read or store your inbox \u2014 every application goes out from your","g_229":"10 auto/day","g_230":"no auto","g_231":"100 auto/day","g_232":"on signup (automatic)","g_233":"Why did my jobs vanish from manual?","g_234":"Auto stopped. What do I do?","g_235":"I got an email in English. What do I do?","g_236":"If they ask for documents, contact a visa agent.","g_237":"in the server's environment variables to enable.","g_239":"Settings","g_239b":"Session","g_239c":"More","tut_center":"Tutorial Center","settings_adv":"Advanced settings","g_240":"Send a suggestion or idea to the devs","g_241":"Danger zone","g_242":"Suggestions for the Devs","g_243":"New Suggestion","g_244":"Your suggestion","g_245":"Keep an eye on","g_246":"for news!","g_247":"\ud83d\udc8e Randomization Group","g_248":"is exclusive to the plan","g_249":"\ud83d\udccd Location","g_250":"\ud83d\udcc5 Job start month","g_251":"Profile name","g_252":"Description","g_253":"to avoid spam blocks.","g_255":"to avoid spam.","g_256":"Compatible sheets","g_257":"Job categories", // 🌐 v136: varredura final (auto)
    "gu_t":"How H2BApply uses your Google account","gu_b":"We request <strong>a single permission</strong> from Google: sending e-mails through your Gmail (<code style=\"background:rgba(255,255,255,.08);padding:1px 6px;border-radius:5px\">gmail.send</code>) — used exclusively to send the job application e-mails that <strong>you yourself write and authorize</strong>. H2BApply <strong>never reads, never stores and never accesses your inbox</strong>. Employer replies arrive directly in your own Gmail. You can revoke access at any time at myaccount.google.com.","gu_l":"Read our full Privacy Policy →", // ✅ v145: transparência do uso da conta Google (verificação OAuth)
    "pe_draft_confirm":"📝 We found a saved draft of this profile (your session must have dropped before saving). Restore the text?","pe_draft_restored":"📝 Draft restored","pe_session_lost":"🔒 Your session dropped (the server restarted) — your text is ALREADY SAVED on this device. Log in again and reopen this profile to get it back.", // 📝 v143: rascunho do editor de perfil (caso Keyla)
    "au_t":"One-account rule — read before signing in","au_b":"Each person may have ONE H2BApply account. Creating a second account — even with a different e-mail — can lead to a PERMANENT BAN of both accounts, with nothing refunded. Remember: the name on your resume is always the same, and the system cross-checks name, phone and device on its own — a duplicate account is easy to detect. Access spots are limited: always use the SAME username and never create a second account.","au_f":"✅ 1 person = 1 account = all your sends and VIP days always together and safe.", // ⚠️ v149: regra de conta única (ordem do dono)
    "mc_1":"My Account","mc_13":"Receipt received — awaiting confirmation","mc_14":"Renew your plan in the Plans tab.","mc_15":"ATTENTION: expires in","mp_pend":"⏳ Under review","mp_pago":"💰 Payment received — awaiting confirmation","mp_canc":"✖ Cancelled","mp_canc_sub":"If you think it was a mistake, message us on WhatsApp","mp_motivo":"Reason","mp_ileg":"⚠️ We could not read your receipt — resend a clear photo.","mp_ok":"✅ Receipt verified by the robot","mp_analise":"🔍 Receipt under review","mp_reenviar":"📤 Resend receipt","mp_media":"real average confirmation","mp_sub24":"We review and confirm — you will get a notification","mp_vertodos":"see all", "mc_2":"Free Plan","mc_3":"manual sends per day","mc_7":"🧾 Last order:","mc_8":"awaiting admin confirmation","mc_9":"confirmed — plan activated","mc_10":"cancelled","mc_11":"You haven't placed any orders yet.","mc_12":"Subscribe to a plan anytime to raise your daily limit.", // 👤 2.0-P6 (v170: no more diamond system)
    "tut_t":"Tutorials Center","tut_s":"20 step-by-step guides with real screenshots — everything you can do on H2BApply, screen by screen","tut_ph":"🔍 What do you want to learn? E.g.: resume, automatic, plans...","tut_v":"Nothing found — try another word (e.g. \"send\", \"plan\", \"profile\").","tut_load":"⏳ Loading tutorials...", // 📖 v160
    "consent_title":"☑️ Before you continue","consent_b1":"This is a paid digital application-sending automation service — H2BApply never writes the e-mail for you; the content sent is always your own.","consent_b2":"The price shown now is the final amount to pay.","consent_b3":"After paying via PIX, send the receipt and stay signed in on the same account until confirmation — automatic when it matches, and always checked by our team.","consent_b4":"The risk of your Gmail account being blocked belongs to Google (a third party), not H2BApply — you can lower it by using more than one sending account.","consent_b5":"You can check your order status anytime in the 🧾 My orders tab.","consent_check":"I have read and understand how the program works and what I'm paying for.","consent_terms_link":"See full Terms →","consent_required_msg":"Check that you've read and understood before continuing.","consent_choose_plan":"Choose a plan and the period before continuing.","plan_step1_title":"Choose your plan and period","plan_step1_intro":"You pay <strong>directly</strong> for the plan you choose — no middleman currency. See each plan's limits, pick the period, and the final price shows right away, before you pay.","plan_calc_empty":"Choose a plan and the period","plan_error_load":"Couldn't load the plans.","plan_try_again":"Try again", // 💎 v170: compra direta de plano — consentimento informado (CEO mode, 09/09/2026)
    "pv_title":"Jobs for you","pv_all":"See all","pv_apply":"Apply","pv_apply_t":"Apply to this job","pv_w1":"category you prefer","pv_w2":"matches what your profile targets","pv_w3":"your profile's state","pv_w4":"asks for experience and you have it","pv_w5":"open to beginners","pv_w6":"asks for experience you don't have yet","pv_w7":"asks for advanced English","pv_w8":"doesn't require advanced English","pv_w9":"your advanced English stands out here", // 🎯 v139: Vagas pra você (Home)
    "snd_title":"New reply sound","snd_sel":"selected!","hs_t":"Welcome to H2BApply!","hs1":"Go to <strong>Profile → Email Profiles</strong> and set up your resume","hs2":"Open <strong>Manual Send</strong> to pick jobs and apply","hs3":"Turn on <strong>Auto Send</strong> for 24/7 applications on autopilot","hs4":"Replies land straight in <strong>your own Gmail</strong> — keep an eye there","fq1":"Queue finished! You applied to every job.","fq2":"🏆 Queue done! Now wait for the replies.","fq3":"All applications sent! Success is on the way.","fq4":"Queue cleared! You took a big step today.","h_faq_qty_q":"How many emails should I send per day?","h_faq_qty":"The more the better — with quality. The system has anti-spam protection. On the free plan it's 20 manual + 10 automatic per day. With VIP Manual it's 100 manual per day. With VIPro it's 100 + 100 per day. With DoublePro (2 Gmails) it's 200 + 200 per day. Applying to many companies increases your chances.","h_faq_reply":"Open the email right in your Gmail and read it. If the company asks whether you are available, reply: <em>\"Yes, I am available to start on the requested date.\"</em> If they ask for documents, contact a visa agent.","h_faq_visa":"<strong>Does this guarantee a job or visa? No.</strong> H2BApply is a tool that sends emails for you. Hiring is the employer's decision. The visa is the US consulate's decision. The more applications you send, the higher your chances of getting an offer.","g_258":"Already paid before? Just send the same receipt on the plans screen — no need to pay again.","g_259":"Type the company name, an email you received, the ETA case number, the job title or the state to find all matching jobs","g_260":"Add a second Gmail. The auto-sender splits applications between both emails, reducing spam risk.","g_261":"Emails go out with the resume and texts of the profile chosen in Step 3 — subjects and bodies rotate automatically against spam.","g_262":"The system rotates through your saved email subjects and bodies to avoid looking like spam. Want to adjust something? Tap \"Change\" above.","g_263":"Write your name exactly as it appears in your passport. A wrong name can cause problems with the employer.","g_264":"It's like a robot working for you. You set it up once and it keeps applying on its own, even with your phone off.","g_265":"Check the Home tab to see if the auto-sender still shows as active. If it stopped, it may have hit your plan's daily limit — it restarts automatically the next day at midnight.","g_266":"No subjects yet. Write at least 3 variations of your own in \"+ Add\" — use the variables above to personalize automatically.","g_267":"No email bodies yet. Write at least 3 variations of your own in \"+ Add\" — use the variables above to personalize automatically.","g_268":"Single profile: your profile is automatically used for any job, from any sheet.","g_269":"⚙️ Advanced filters","g_270":"You write the texts — H2BApply never fills this in for you, it only delivers.","g_271":"written by you","g_272":"your own versions, written by you","g_273":"Max 3MB", // 🌐 v137c: sons/boas-vindas/extrato/FAQ + 11 textos longos da varredura
    "home":"Home","manual":"Manual","search":"Search","auto":"Auto","responses":"Replies",
    "notifications":"Notifications","plans":"💎 Plans","profile":"Profile","admin":"Admin Panel","logout":"Logout","logout_confirm":"Log out of your account? You can sign back in anytime with the same Google email.",
    "auto_title":"Auto Send","auto_sub":"Tap to configure and start",
    "shortcuts":"Quick Access","today":"Today","account":"Account","latest_replies":"Latest Replies",
    "auto_lbl":"Auto","total_sends":"Total","profile_lbl":"Profile",
    "plans_rewards":"Plans & Rewards",
    "sent_apps":"Applications Sent","me":"Me","profiles":"Resumes","seasonal_jobs":"Seasonal Jobs",
    "plan_free":"Free Plan","plan_vip":"VIP Plan","plan_pro":"Pro Plan","plan_vipro":"VIPro Plan",
    
    
    "roi_calc":"Results Calculator","roi_if":"If only 1% of companies reply positively:","roi_cta":"Just 1 company confirms → you're in the USA ✈️",
    "all_states":"All states","salary":"Salary","qty_jobs":"# Positions",
    "sug_companies":"Companies","sug_roles":"Job titles","sug_cities":"Cities","sug_regions":"Regions","sug_states":"States","sug_jobs":"jobs",
    "extra_gmail":"Extra Gmail for Sending","upgrade_to_enable":"Subscribe to a plan to enable it.","tap_to_pick":"(tap to choose)","search_btn":"Search",
    "radar_btn":"📡 Radar","radar_title":"Job Radar","radar_sub":"Save your current filters (search, state, city) and get a phone alert when a NEW matching job arrives — at most 1 alert per day.",
    "radar_create":"Create radar with current filters","radar_active":"Your radar is ON","radar_off":"Turn radar off",
    "radar_all":"All new jobs","radar_alerts":"alert(s) sent so far","radar_created":"Radar on! You'll be alerted when a new matching job arrives.","radar_removed":"Radar off.",
    "upsell_title":"Today's limit is gone — jobs won't wait","upsell_left":"There are still {n} jobs available TODAY that you can't reach on your current plan. Subscribe to a plan and keep going right now — receipt confirmed, plan activated.",
    "upsell_left_generic":"The limit resets tomorrow — but today's best jobs will already have other applicants. Subscribe to a plan and keep going now.",
    "upsell_cta":"See plans & subscribe","upsell_later":"Continue free tomorrow",
    "st_starting":"🟡 Starting...","st_sending":"🟢 Sending...","st_paused":"⏸ Paused",
    "st_no_session":"⚠️ Please log in again","st_finished":"✅ Done","st_resuming":"🟢 Resuming...",
    "st_refilled":"🔄 Queue refilled — sending...","st_wait_interval":"⏳ Waiting interval...","st_wait_hour":"⏳ Waiting scheduled time...",
    "st_wait_limit":"📊 Daily limit reached","st_wait_rate":"⏳ Google asked for a break — we resume on our own",
    "st_auth_err":"⛔ Paused — reconnect your Gmail","st_token_revoked":"🔐 Google access revoked — log in again",
    "st_no_refresh":"🔐 Log in again to reactivate","st_corrupt":"❌ Queue issue — restart auto send",
    "hint_auth_err":"Open Settings and connect your Google account again — your queue is safe.",
    "hint_token_revoked":"Sign out and log in with Google again — your queue is safe.",
    "hint_no_refresh":"Log in with Google again — your queue is safe.",
    "hint_no_session":"Log in with Google again — your queue is safe.",
    "hint_corrupt":"Tap Stop and start auto send again.",
    "hint_rate":"Normal Gmail anti-spam protection — nothing to do, the robot resumes on its own.",
    "cd_soon":"Sending any moment...","cd_next":"Next send in","cd_starts":"Starts in","cd_resumes":"Resumes in",
    "personal_data":"Personal Info","full_name":"Full name *","country":"Country","required_lbl":"REQUIRED",
    
    
    
    "plans_title":"H2BApply Plans","plans_sub":"Choose a plan, pay via PIX and send the receipt",
    "plans_note":"Receipt checked automatically • Final confirmation always by an admin",
    
    "contact_data":"Your contact info","contact_sub":"So we can activate your plan and reach you",
    "order_summary":"📋 Order summary","notes_lbl":"Notes",
        "settings_sub":"Your account, your privacy.","your_account":"Your account","how_works":"💡 How does it work?",
    "sug_step1":"Write your suggestion and hit send","sug_step2":"The team reads and reviews every suggestion",
    "sug_step3":"The most requested ones become features in upcoming updates","sug_sent":"📋 Your submitted suggestions",
    "auto_cfg_sub":"Set it up once. The system sends while you work.",
    "in_queue":"In queue","daily_limit":"Daily limit","queue_progress":"Queue progress","last_sends":"Latest sends",
    "auto_src_title":"Choose the job source","auto_src_sub":"Pick where to pull jobs from",
    "auto_cv_title":"Which resume to use?","auto_cv_sub":"Emails go out with this profile's resume and texts",
    "auto_start_btn":"🤖 Start Auto Send","auto_confirm_btn":"🚀 Confirm Auto Send",
    "auto_when":"When to start?","auto_bg_ok":"✅ Works with the app closed!",
    "notif_sub":"System alerts and updates",
    "sort_rand":"🔀 Random","sort_match":"🎯 Best for me","sort_wage":"💰 Highest pay","sort_start":"🗓️ Starts soon","sort_recent":"Recent",
    "q_ph":"Job title, company...","q_state_ph":"📍 State…","q_city_ph":"🏙️ City…","f_city_ph":"🏙️ City or region — e.g. Martha´s Vineyard, Key West…",
    "manual_today":"Manual sends today","send_by":"📧 Send from","send_profile":"📋 Sending profile","resume_lbl":"📄 Resume",
    "cancel":"Cancel","send_btn":"Send","sending":"Sending...","optional_lbl":"(optional)","add_new":"+ Add",
    "logs_auto_title":"📋 Auto Send Logs","logs_auto_sub":"Full history of every automatic send",
    "home_welcome":"Welcome back! Ready to send lots of applications today?",
    "home_hero_badge":"Seasonal jobs across the USA","home_hero_h1a":"Work in the USA","home_hero_h1b":"with more opportunities",
    "home_stat_jobs":"Jobs Available","home_stat_companies":"Companies Contacted","home_stat_emails":"Emails Sent",
    "home_activity_title":"Recent Activity","home_tips_title":"Tips for more replies",
    "home_tip1":"Use a clear, objective English resume.","home_tip2":"Apply to many jobs — volume raises your chances.",
    "home_tip3":"Personalize your cover letter.","home_tip4":"Keep your profile always up to date.","home_tip5":"Check your spam folder.",
    "home_tip_quote":"Discipline today, opportunities tomorrow.",
    "home_auto_b1":"Applies to several jobs a day","home_auto_b3":"Never repeats an application","home_auto_b4":"Works 24h — you don't need to stay online","home_auto_cta":"Start Auto Send",
    "home_man_b1":"Search and filter jobs","home_man_b4":"Send when you're ready",
    "manual_send_title":"Manual Send","manual_send_sub":"Find jobs and apply right now",
    "plans_send_title":"💎 Plans","plans_send_sub":"Subscribe to a plan and power up your applications", // 🌐 v166: Home 3rd CTA
    "home_cv_tip":"Keep your resume up to date.","home_cv_tip_link":"Edit resume →", // 🌐 v166: Home subtle tip
    "inicio":"Home","auto_send":"Auto Send","manual_send":"Manual Send",
    "bn_jobs":"Jobs","bn_more":"More","bn_more_title":"More options","bn_auto":"Auto Send","bn_tutorial":"Tutorials Center","bn_settings":"Settings",
    "sent_tab":"Sent","download_app":"Get the App",
    "hist_short":"Sent","saved_short":"Saved",
    "greet_m":"👋 Good morning,","greet_t":"👋 Good afternoon,","greet_n":"👋 Good evening,","greet_d":"👋 Late night,",
    "saved_jobs":"Saved Jobs","saved_ok":"Job saved!","saved_removed":"Removed from saved",
    "saved_empty":"No saved jobs","saved_empty_sub":"Tap the 🔖 on any job to keep it here",
    "saved_remove":"Remove from saved","saved_already_sent":"already sent","saved_no_email":"This job has no email — open the DOL link",
    "saved_apply_title":"Apply",
    "cd_on_lbl":"Protection: 1 min between manual sends","cd_change":"change",
    "cd_off_lbl":"1-min protection is OFF","cd_reactivate":"turn back on",
    "cd_modal_title":"Turn off the 1-minute protection?",
    "cd_modal_body":"The 1-minute gap between manual sends protects your account. Sending too many emails too fast makes Google flag your account as spam — your Gmail has a HIGH chance of being BLOCKED FOREVER. Auto-send doesn't change: still 1 every 7 minutes.",
    "cd_modal_agree":"I understand the risk: my Gmail can be blocked forever, and the responsibility is mine.",
    "cd_modal_keep":"Keep protection","cd_modal_off":"Turn off anyway",
    "cd_toast_off":"⚠️ 1-min protection turned off — watch your pace!","cd_toast_on":"✅ 1-min protection back on",
    "all":"All","all_f":"All","active_f":"✅ Active","random":"🔀 Random","recent":"Recent","oldest":"Oldest",
    "select_job":"Select a job","select_job_sub":"Click to see details and apply",
    "back_jobs":"Back to jobs","job_search_ph":"Position, company, state...",
    "hist_title":"Applications Sent","hist_search_ph":"Search company, position or email...","hist_banner":"Your applications, always at hand",
    "hist_info":"The Reset button clears everything and returns jobs to the list (useful to reapply).","home_footer_tag":"More than a system. It's your next step.",
    "search_jobs":"Search Jobs","search_sub":"Search across all sources: Seasonal, Jan 2026, Jul 2025",
    "search_ph":"Company, email, ETA case number, position, state...","clear":"Clear",
    "all_sources":"All sources","sent":"Sent",
    "search_anything":"Search for anything",
    "search_hint":"Type the company name, a received email, the ETA case number, position or state",
    "all_inbox":"All","unread":"Unread","favorites":"Favorites","this_week":"This week",
    "enable_notif":"Enable notifications","enable_notif_sub":"Get alerts for receipt confirmation, auto-send status and news — even with the app closed",
    "activate":"Enable","inbox_search_ph":"Search company, subject...","notif_short":"Notif",
    "reply_alert":"New reply alert","reply_alert_sub":"Sound + alert for receipt confirmation, auto-send status and news (the site never reads your inbox — we can't tell you when a company replies)",
    "pipe_responded":"Responded","pipe_positive":"Interested","pipe_interview":"Interview","pipe_offer":"Offer",
    
    
    "full_name":"Full name *","country":"Country","city":"City",
    "full_name_ph":"Your full name","country_ph":"Brazil","save_data":"Save data",
    "tap_to_enable":"Tap the button to enable","new_profile":"Create New Profile",
    "email_profiles":"Email Profiles","profiles_desc":"Each profile defines the subject, email body and resume to use. The system automatically picks the right profile for each job.",
    "no_profiles":"No profiles created","no_profiles_sub":"Create your first profile to start sending",
    "total_sent":"Total sent","companies_lbl":"🏢 Companies","states_lbl":"🗺️ States",
    "last_7days":"Last 7 days","top_states":"Top States","share_stats":"Share results",
    "auto_hero_sub":"Set up once. The system sends while you work.",
    "auto_free":"10 FREE sends/day for everyone!",
    "ws1_title":"Choose job source","ws1_sub":"Select where to pull jobs from",
    "ws2_title":"Filters (optional)","summer":"Summer","winter":"Winter",
    "service_type":"Service type (auto-detected)",
    "state_opt":"State (optional)","only_with_email":"Only jobs with email",
    "min_salary":"Minimum hourly salary (USD)","any_salary":"Any","with_email_only":"With email only",
    "all_ready":"All set? Start now!","start_auto":"🤖 Start Auto Send",
    "sent_lbl":"Sent","failed":"Failed","in_queue":"In queue","daily_limit":"Daily limit",
    "progress":"Progress","next_app":"Next application",
    "pause":"Pause","resume":"Resume","stop":"Stop","latest_sends":"Latest sends",
    "confirm_auto":"Confirm Auto Send","jobs_in_queue":"jobs in queue",
    "est_time":"estimated time","between_emails":"between emails",
    "start_now":"Start now","start_now_sub":"1st email goes out in seconds. Uses the configured window.",
    "schedule":"Schedule time","schedule_sub":"Starts and stops at a time you choose (BRT).",
    "schedule_time":"Schedule (Brasília time)","start_at":"Start at","stop_at":"Stop at",
    "cancel":"Cancel","confirm_start":"Confirm & Start",
    "gmail_limit_title":"Gmail Limit","works_closed":"Works with app closed!",
    "only_login_once":"Only needs to be logged in once.",
    "when_start":"When to start?","how_profiles_used":"How your profiles will be used:",
    "notif_sub":"System alerts and updates","notif_unread":"Unread","notif_all":"All",
    "logs":"Logs",
    "send_title":"Send Application","send_profile":"Send profile","send_btn":"Send",
    "loading":"Loading...","error":"Error","retry":"Try again","save":"Save",
    "close":"Close","send":"Send","delete":"Delete","edit":"Edit","back":"Back",
    "sys_notif_label":"System Notice","sys_notif_ok":"✅ Got it","sys_notif_all":"🔔 View all notifications",
  },
  es: {
    "h_faq_gone":"Los empleos desaparecen del manual en dos casos: (1) ya te postulaste a esa empresa, o (2) ese empleo est\u00e1 en la cola del autom\u00e1tico. Es correcto \u2014 evita escribir dos veces a la misma empresa.", // 🌐 v137b
    "ns1_t":"Crea tu perfil de postulaci\u00f3n","ns1_s":"Es lo que va en los correos a las empresas. Toma 1 minuto.","ns1_c":"Crear perfil","ns2_t":"Adjunta tu curr\u00edculum (PDF)","ns2_s":"Sin curr\u00edculum adjunto, tus postulaciones no salen.","ns2_c":"Adjuntar","ns3_t":"\u00a1Todo listo! Empieza a postularte","ns3_s":"Tu perfil est\u00e1 completo. Env\u00eda tu primera postulaci\u00f3n hoy.","ns3_c":"Buscar empleos","ns4_t":"Alcanzaste el l\u00edmite de hoy","ns4_s":"Hazte VIP y env\u00eda hasta 100 postulaciones al d\u00eda.","ns4_c":"Ver planes","ns5_t":"Activa el Env\u00edo Autom\u00e1tico","ns5_s":"Deja que el sistema env\u00ede postulaciones mientras trabajas.","ns5_c":"Activar","logs_none":"Sin registros todav\u00eda","logs_none_s":"Los registros aparecen aqu\u00ed cuando uses el Env\u00edo Autom\u00e1tico","notif_none_unread":"Ninguna notificaci\u00f3n sin leer \ud83c\udf89","notif_none":"Ninguna notificaci\u00f3n por ahora","snd_plane":"Avi\u00f3n","snd_plane_d":"Sonido de despegue","sug_hero":"\u00a1Tu idea puede volverse una funci\u00f3n! Env\u00eda tu sugerencia al equipo de H2BApply.","sc_vagas":"\ud83d\udcbc Sobre los empleos", // 🌐 v137: dinâmicos da varredura E2E
    "g_1":"Env\u00edo Autom\u00e1tico","g_2":"Configura y deja que el sistema trabaje por ti","g_3":"/mes","g_4":"Autom\u00e1tico + Manual","g_5":"M\u00e1ximo rendimiento","g_6":"Accesos R\u00e1pidos","g_7":"Curr\u00edculums","g_8":"Mes","g_11":"N\u00fameros","g_12":"\ud83c\udde7\ud83c\uddf7 Portugu\u00eas","g_14":"(hasta 600 caracteres)","g_15":"(hasta 400 caracteres)","g_16":"(hasta 300 caracteres)","g_17":"Ayuda al sistema a encontrar los empleos correctos para ti","g_18":"\u00bfYa fuiste a EE.UU.?","g_19":"\u274c No","g_20":"\ud83d\udde3\ufe0f Nivel de ingl\u00e9s","g_21":"\ud83d\udcd6 B\u00e1sico","g_22":"\ud83c\udf1f Avanzado","g_23":"\ud83c\udf3f \u00c1rea preferida","g_24":"\ud83c\udfd7\ufe0f Construcci\u00f3n","g_25":"\ud83e\udd9e Mariscos","g_26":"\ud83d\udcc5 1 mes","g_27":"Notificaciones","g_28":"\ud83d\udeeb Alertas de H2BApply","g_29":"Toca el bot\u00f3n para activar","g_30":"tu curr\u00edculum (PDF)","g_31":"el texto del correo","g_32":"hasta 2 perfiles: uno H-2B y uno H-2A","g_33":"Adjunta tu curr\u00edculum PDF en cada postulaci\u00f3n","g_34":"Define el texto del correo en ingl\u00e9s","g_35":"Esencial para que el Env\u00edo Autom\u00e1tico funcione","g_36":"Curr\u00edculum usado:","g_37":"\ud83d\udcc8 \u00daltimos 7 d\u00edas","g_38":"Configuraci\u00f3n exclusiva de administrador","g_39":"Sin expiraci\u00f3n \u00b7 200 manual + 200 auto/d\u00eda \u00b7 Prioridad m\u00e1xima","g_40":"segundos entre cada env\u00edo","g_41":"3min (predeterminado)","g_42":"Agrega Gmails arriba para configurar l\u00edmites","g_43":"\u00b7 invisible para los usuarios","g_44":"Atenci\u00f3n:","g_45":"1 solo Gmail","g_46":"responsabilidad del usuario","g_47":"Los mismos filtros del Env\u00edo Manual \u2014 puesto, lugar, salario, grupo y m\u00e1s","g_48":"Categor\u00eda r\u00e1pida (detectada autom\u00e1ticamente)","g_49":"empleos para ti","g_50":"\ud83c\udfaf Tu perfil se usar\u00e1 en todos los env\u00edos:","g_51":"\u25b6 Empezar ahora","g_52":"Env\u00eda sin parar 24/7. Se reinicia a medianoche y sigue hasta vaciar la cola.","g_53":"\ud83d\udd50 Programar horario","g_54":"Env\u00eda de X a Y horas cada d\u00eda. Fuera del horario queda en pausa.","g_55":"Iniciar a las","g_56":"Parar a las","g_62":"Pago vía PIX","g_63":"*obligatorio","g_64":"Captura de la confirmación del PIX de tu pago","g_65":"Toca para seleccionar el comprobante","g_66":"JPG, PNG, PDF \u2014 m\u00e1x 5MB","g_67":"hasta 24h","g_68":"\u00bfDudas? Cont\u00e1ctanos:","g_69":"1 empresa que confirme = est\u00e1s en EE.UU. \u2708\ufe0f","g_72":"Aprende el sistema desde cero, paso a paso","g_73":"\ud83d\udccb Lo que vas a aprender:","g_74":"Respuesta de la empresa","g_75":"Preguntas Comunes","g_76":"Configurar tu Perfil","g_77":"Haz esto ANTES de enviar cualquier postulaci\u00f3n","g_78":"pa\u00eds","g_79":"Pesta\u00f1a \"Perfiles de Curr\u00edculum\" \u2014 configurar curr\u00edculum y plantilla","g_80":"sube tu curr\u00edculum en PDF","g_81":"Sin curr\u00edculum, el perfil no se guarda.","g_82":"asuntos y cuerpos de correo","g_83":"M\u00ednimo 3 variaciones de cada uno.","g_84":"Tu perfil est\u00e1 listo. Ya puedes enviar postulaciones.","g_85":"Env\u00edo Manual de Postulaciones","g_86":"Eliges cada empleo y env\u00edas uno por uno","g_87":"Elige la planilla de empleos","g_88":"M\u00e1s empleos disponibles.","g_89":"C\u00f3mo encontrar empleos para ti","g_90":"Haz clic en un empleo para ver los detalles","g_91":"Ve el correo de la empresa y la informaci\u00f3n del empleo","g_92":"\u00a1El correo con tu curr\u00edculum se env\u00eda autom\u00e1ticamente!","g_93":"desaparecen de la lista","g_94":"Env\u00edo Autom\u00e1tico 24h","g_95":"El sistema env\u00eda mientras duermes","g_96":"\ud83e\udd16 \u00bfQu\u00e9 es el Env\u00edo Autom\u00e1tico?","g_97":"\"Env\u00edo Autom\u00e1tico\"","g_98":"cantidad de empleos","g_99":"\"Iniciar Autom\u00e1tico\"","g_100":"\u26a0\ufe0f Atenci\u00f3n:","g_101":"desaparecen del env\u00edo manual","g_102":"La respuesta cae directo en TU Gmail","g_103":"tu propio Gmail","g_104":"Abre el correo de la empresa directo en tu Gmail","g_105":"Escribe tu respuesta en ingl\u00e9s y env\u00eda \u2014 es un correo tuyo, como cualquier otro","g_106":"\ud83d\udca1 Tip de respuesta r\u00e1pida:","g_107":"Env\u00eda m\u00e1s postulaciones por d\u00eda","g_108":"Gratis","g_109":"VIP · R$100/mes","g_110":"VIPro · R$150/mes","g_111":"DoublePro · R$250/mes","g_112":"\ud83c\udf81 C\u00f3mo ganar VIP gratis:","g_113":"1 d\u00eda de VIP Manual","g_114":"C\u00f3digos promocionales","g_115":"Preguntas Frecuentes","g_116":"Respuestas r\u00e1pidas a preguntas comunes","g_117":"No.","g_118":"\u00bfTodav\u00eda con dudas?","g_119":"Mira los videos explicativos en YouTube o escr\u00edbenos por Instagram","g_128":"desaparecer de cualquier lugar p\u00fablico","g_129":"iniciar sesi\u00f3n de nuevo con el mismo correo","g_130":"m\u00ednimo 10 caracteres","g_131":"Autom\u00e1tico","g_132":"Empleo no identificado","g_133":"\ud83d\udcc5 Disponible","g_134":"\u2753 Duda","g_135":"Construcci\u00f3n","g_136":"Dep\u00f3sito","g_137":"\ud83c\udff7\ufe0f Puesto espec\u00edfico","g_138":"\ud83d\udcc2 Categor\u00eda r\u00e1pida","g_139":"\ud83c\udf0e Tipo de visa","g_140":"\ud83d\udcf6 Estado del empleo","g_141":"Grupo de Randomizaci\u00f3n","g_142":"\u2014 puedes elegir varios estados","g_143":"\ud83d\udcb0 Salario m\u00ednimo","g_144":"\ud83d\udc65 M\u00edn. de puestos","g_145":"\u2014 puedes marcar varios","g_146":"\ud83c\udfb2 Aleatorio (predeterminado)","g_147":"\ud83c\udfaf Mejor para ti primero","g_148":"\ud83d\udcb0 Mayor salario primero","g_149":"\ud83d\udcc5 Empieza antes primero","g_150":"Este perfil se usar\u00e1 en los env\u00edos manuales y autom\u00e1ticos","g_151":"curr\u00edculum (PDF)","g_152":"\u2460 Informaci\u00f3n B\u00e1sica","g_153":"\u00cdcono","g_154":"Elige un \u00edcono para el perfil:","g_155":"\u2461 Curr\u00edculum &amp; Cover Letter (PDF)","g_156":"\ud83d\udcc4 Curr\u00edculum (PDF)","g_157":"\u2705 Curr\u00edculum vinculado a este perfil","g_158":"\ud83d\udce4 Archivo nuevo \u2014 se subir\u00e1 al guardar","g_159":"Haz clic o arrastra un PDF para subirlo","g_160":"M\u00e1x. 5MB","g_161":"o elige uno de tu cuenta","g_162":"Carta de presentaci\u00f3n \u2014 opcional, pero aumenta las respuestas.","g_163":"solo en empleos del tipo de visa de este perfil","g_164":"\u2462 Asuntos del Correo","g_165":"M\u00ednimo 3","g_166":"Variables:","g_167":"\u2463 Cuerpos de Correo","g_168":"\u2699\ufe0f Variables \u2014 clic para copiar:","g_169":"3 cuerpos de correo","g_170":"Selecciona las categor\u00edas para las que este perfil se usar\u00e1 autom\u00e1ticamente","g_171":"\u2464 Configuraci\u00f3n","g_172":"Protecciones siempre activas:","g_173":"no se pueden desactivar","g_174":"Noticias","g_175":"Toca cualquier postulaci\u00f3n para ver detalles,","g_176":". El bot\u00f3n","g_177":"borra todo y devuelve los empleos a la lista (\u00fatil para volver a postularte).","g_178":"Quien ya tiene un plan activo puede conectar un Gmail extra para reducir el riesgo de spam.","g_179":"\ud83c\udfad Elige tu avatar","g_180":"\ud83d\udca1 Lo que escribas aqu\u00ed aparece cuando alguien","g_181":"\ud83d\udc64 Sobre ti","g_182":"\ud83d\udcbc Experiencia laboral","g_183":"\ud83d\udcac \u00bfQu\u00e9 opinas de H2BApply?","g_184":"\ud83d\udcbe Guarda con el bot\u00f3n","g_185":"al final de la p\u00e1gina.","g_186":"Cada perfil tiene su curr\u00edculum vinculado directamente.","g_187":"El autom\u00e1tico siempre usa el PDF del perfil correcto \u2014 sin confusiones.","g_188":". Puedes tener","g_189":"el perfil que elijas en el Paso 3 del asistente","g_190":"Crea tu primer Perfil de Curr\u00edculum para","g_191":"empezar a enviar postulaciones","g_192":"Estad\u00edsticas","g_193":"Gmails de env\u00edo","g_194":"\u00a110 env\u00edos GRATIS/d\u00eda para todos!","g_195":"Enviar muchos correos con","g_196":"puede generar un bloqueo temporal de Google. Recomendamos agregar","g_197":"para distribuir los env\u00edos. El riesgo de bloqueo es de","g_198":"\ud83d\udcec Pr\u00f3ximas postulaciones","g_199":"\u2014 Verano","g_200":"\u26a0\ufe0f Filtro de categor\u00eda activo:","g_201":"\u2014 \u00a1eso limita los empleos! Para ver todos, haz clic en \"Todos\" arriba.","g_202":"El env\u00edo alterna","g_203":"\u00bfEl autom\u00e1tico vaci\u00f3 la cola? Restablecer enviados","g_204":"Solo necesitas iniciar sesi\u00f3n una vez.","g_205":"Horario (Bras\u00edlia)","g_207":"🧾 Mis pedidos","g_210":"📸 Comprobante del pago","g_211":"📅 Fecha en que pagaste","g_212":". Con ella verificamos tu pago.","g_213":"), tu plan se activa","g_214":"Completa tu","g_215":"(escribe \"Brazil\" en ingl\u00e9s),","g_216":"con c\u00f3digo de pa\u00eds (+55 85 99999-9999) y","g_217":"Dale un","g_218":"nombre al perfil. Ej: \"Mi Perfil Principal\" o \"Landscape\"","g_219":"(obligatorio). Haz clic en el \u00e1rea punteada o arrastra el archivo.","g_220":"al final de la pantalla.","g_221":"En la parte superior del Env\u00edo Manual ver\u00e1s 3 pesta\u00f1as:","g_222":"\u2014 Empleos de verano en EE.UU. (temporada principal H-2B).","g_223":"\u2014 Empleos de invierno. Menos, pero a\u00fan v\u00e1lidos.","g_224":"Haz clic en el bot\u00f3n verde","g_225":"Empleos ya enviados","g_226":"que quieras poner en autom\u00e1tico","g_227":"Los empleos que pones en autom\u00e1tico","g_228":"H2BApply NO lee ni guarda tu bandeja de entrada \u2014 cada postulaci\u00f3n sale de tu","g_229":"10 autom\u00e1ticos/d\u00eda","g_230":"sin autom\u00e1tico","g_231":"100 autom\u00e1ticos/d\u00eda","g_232":"al registrarte (autom\u00e1tico)","g_233":"\u00bfPor qu\u00e9 mis empleos desaparecieron del manual?","g_234":"El autom\u00e1tico par\u00f3. \u00bfQu\u00e9 hago?","g_235":"Recib\u00ed un correo en ingl\u00e9s. \u00bfQu\u00e9 hago?","g_236":"Si piden documentos, contacta a un gestor de visas.","g_237":"en las variables de entorno del servidor para activar.","g_239":"Configuraci\u00f3n","g_239b":"Sesi\u00f3n","g_239c":"M\u00e1s","tut_center":"Centro de Tutoriales","settings_adv":"Configuraci\u00f3n avanzada","g_240":"Enviar una sugerencia o idea a los devs","g_241":"Zona de peligro","g_242":"Sugerencias para los Devs","g_243":"Nueva Sugerencia","g_244":"Tu sugerencia","g_245":"Mantente atento a","g_246":"\u00a1para novedades!","g_247":"\ud83d\udc8e Grupo de Randomizaci\u00f3n","g_248":"es exclusivo del plan","g_249":"\ud83d\udccd Ubicaci\u00f3n","g_250":"\ud83d\udcc5 Mes de inicio del empleo","g_251":"Nombre del perfil","g_252":"Descripci\u00f3n","g_253":"para evitar bloqueos por spam.","g_255":"para evitar spam.","g_256":"Planillas compatibles","g_257":"Categor\u00edas de empleo", // 🌐 v136: varredura final (auto)
    "gu_t":"Cómo H2BApply usa tu cuenta de Google","gu_b":"Pedimos <strong>un único permiso</strong> de Google: enviar correos por tu Gmail (<code style=\"background:rgba(255,255,255,.08);padding:1px 6px;border-radius:5px\">gmail.send</code>) — usado exclusivamente para enviar las postulaciones de empleo que <strong>tú mismo escribes y autorizas</strong>. H2BApply <strong>nunca lee, nunca almacena y nunca accede a tu bandeja de entrada</strong>. Las respuestas de los empleadores llegan directo a tu propio Gmail. Puedes revocar el acceso en cualquier momento en myaccount.google.com.","gu_l":"Lee nuestra Política de Privacidad completa →", // ✅ v145: transparência do uso da conta Google (verificação OAuth)
    "pe_draft_confirm":"📝 Encontramos un borrador guardado de este perfil (tu sesión debió caerse antes de guardar). ¿Restaurar el texto?","pe_draft_restored":"📝 Borrador restaurado","pe_session_lost":"🔒 Tu sesión se cayó (el servidor se reinició) — tu texto YA ESTÁ GUARDADO en este dispositivo. Inicia sesión de nuevo y vuelve a abrir este perfil para recuperarlo.", // 📝 v143: rascunho do editor de perfil (caso Keyla)
    "au_t":"Regla de cuenta única — lee antes de entrar","au_b":"Cada persona puede tener UNA cuenta en H2BApply. Crear una segunda cuenta — incluso con otro e-mail — puede causar un BAN PERMANENTE de las dos cuentas, sin devolución de nada. Recuerda: el nombre en tu currículum es siempre el mismo, y el sistema cruza nombre, teléfono y dispositivo por sí solo — una cuenta duplicada es fácil de detectar. Los cupos de acceso son limitados: usa siempre el MISMO usuario y nunca crees una segunda cuenta.","au_f":"✅ 1 persona = 1 cuenta = todos tus envíos y días de VIP siempre juntos y seguros.", // ⚠️ v149: regra de conta única (ordem do dono)
    "mc_1":"Mi Cuenta","mc_13":"Comprobante recibido — esperando confirmación","mc_14":"Renueva tu plan en la pestaña Planes.","mc_15":"ATENCIÓN: expira en","mp_pend":"⏳ En revisión","mp_pago":"💰 Pago recibido — esperando confirmación","mp_canc":"✖ Cancelado","mp_canc_sub":"Si crees que fue un error, escríbenos por WhatsApp","mp_motivo":"Motivo","mp_ileg":"⚠️ No pudimos leer tu comprobante — reenvía una foto nítida.","mp_ok":"✅ Comprobante verificado por el robot","mp_analise":"🔍 Comprobante en revisión","mp_reenviar":"📤 Reenviar comprobante","mp_media":"confirmación media real","mp_sub24":"Revisamos y confirmamos — recibirás una notificación","mp_vertodos":"ver todos", "mc_2":"Plan Gratis","mc_3":"envíos manuales por día","mc_7":"🧾 Último pedido:","mc_8":"esperando confirmación del admin","mc_9":"confirmado — plan activado","mc_10":"cancelado","mc_11":"Aún no hiciste ningún pedido.","mc_12":"Cambia a un plan cuando quieras para aumentar tu límite diario.", // 👤 2.0-P6 (v170: sin sistema de diamantes)
    "tut_t":"Central de Tutoriales","tut_s":"20 guías paso a paso con fotos reales — todo lo que puedes hacer en H2BApply, pantalla por pantalla","tut_ph":"🔍 ¿Qué quieres aprender? Ej.: currículum, automático, planes...","tut_v":"Nada encontrado — prueba otra palabra (ej. \"enviar\", \"plan\", \"perfil\").","tut_load":"⏳ Cargando los tutoriales...", // 📖 v160
    "consent_title":"☑️ Antes de continuar","consent_b1":"Es un servicio digital pago de automatización de envío — H2BApply nunca escribe el correo por ti; el contenido enviado siempre es tuyo.","consent_b2":"El precio mostrado ahora es el valor final a pagar.","consent_b3":"Después de pagar vía PIX, envía el comprobante y sigue conectado en la misma cuenta hasta la confirmación — automática cuando coincide, y siempre revisada por nuestro equipo.","consent_b4":"El riesgo de bloqueo de la cuenta Gmail es de Google (tercero), no de H2BApply — se reduce usando más de una cuenta de envío.","consent_b5":"Puedes revisar el estado de tu pedido en cualquier momento en la pestaña 🧾 Mis pedidos.","consent_check":"Leí y entiendo cómo funciona el programa y qué estoy pagando.","consent_terms_link":"Ver Términos completos →","consent_required_msg":"Marca que leíste y entendiste antes de continuar.","consent_choose_plan":"Elige un plan y el período antes de continuar.","plan_step1_title":"Elige tu plan y período","plan_step1_intro":"Pagas <strong>directamente</strong> por el plan elegido — sin moneda intermediaria. Mira los límites de cada plan, elige el período y el precio final aparece al instante, antes de pagar.","plan_calc_empty":"Elige un plan y el período","plan_error_load":"No se pudieron cargar los planes.","plan_try_again":"Intentar de nuevo", // 💎 v170: compra direta de plano — consentimento informado (CEO mode, 09/09/2026)
    "pv_title":"Vacantes para ti","pv_all":"Ver todas","pv_apply":"Postular","pv_apply_t":"Postular a esta vacante","pv_w1":"categoría que prefieres","pv_w2":"dentro de lo que tu perfil busca","pv_w3":"estado de tu perfil","pv_w4":"pide experiencia y tú ya la tienes","pv_w5":"acepta principiantes","pv_w6":"pide experiencia que aún no tienes","pv_w7":"pide inglés avanzado","pv_w8":"no exige inglés avanzado","pv_w9":"tu inglés avanzado es un diferencial aquí", // 🎯 v139: Vagas pra você (Home)
    "snd_title":"Sonido de nueva respuesta","snd_sel":"¡seleccionado!","hs_t":"¡Bienvenido a H2BApply!","hs1":"Ve a <strong>Perfil → Perfiles de Email</strong> y configura tu currículum","hs2":"Entra en <strong>Envío Manual</strong> para elegir vacantes y postularte","hs3":"Activa el <strong>Envío Automático</strong> para postulaciones 24h en piloto automático","hs4":"Las respuestas llegan directo a <strong>tu propio Gmail</strong> — mantente atento allí","fq1":"¡Cola terminada! Te postulaste a todas las vacantes.","fq2":"🏆 ¡Cola terminada! Espera a que lleguen las respuestas.","fq3":"¡Todas las postulaciones enviadas! El éxito está en camino.","fq4":"¡Cola vaciada! Diste un gran paso hoy.","h_faq_qty_q":"¿Cuántos correos debo enviar por día?","h_faq_qty":"Cuantos más, mejor — pero con calidad. El sistema tiene protección anti-spam. En el plan gratuito son 20 manuales + 10 automáticos por día. Con VIP Manual son 100 manuales por día. Con VIPro son 100 + 100 por día. Con DoublePro (2 Gmails) son 200 + 200 por día. Postularte a muchas empresas aumenta tus chances.","h_faq_reply":"Abre el correo directo en tu Gmail y léelo. Si la empresa pregunta si estás disponible, responde: <em>\"Yes, I am available to start on the requested date.\"</em> Si piden documentos, contacta a un gestor de visas.","h_faq_visa":"<strong>¿Esto garantiza empleo o visa? No.</strong> H2BApply es una herramienta que envía correos por ti. Contratarte es decisión del empleador. La visa es decisión del consulado americano. Cuantas más postulaciones envíes, mayores las chances de recibir una oferta.","g_258":"¿Ya pagaste antes? Solo envía el mismo comprobante en la pantalla de planes — sin pagar de nuevo.","g_259":"Escribe el nombre de la empresa, un correo recibido, el ETA case number, el puesto o el estado para encontrar todas las vacantes correspondientes","g_260":"Agrega un segundo Gmail. El automático reparte los envíos entre los dos correos, reduciendo el riesgo de spam.","g_261":"Los correos salen con el currículum y los textos del perfil elegido en el Paso 3 — asuntos y cuerpos alternan automáticamente contra el spam.","g_262":"El sistema rota entre los asuntos y cuerpos de correo guardados para no parecer spam. ¿Quieres ajustar algo? Toca \"Cambiar\" arriba.","g_263":"Escribe tu nombre exactamente como está en tu pasaporte. Un nombre equivocado puede causar problemas con el empleador.","g_264":"Es como un robot que trabaja por ti. Lo configuras una vez y sigue postulando solo, incluso con tu celular apagado.","g_265":"Verifica en la pestaña Home si el automático sigue activo. Si se detuvo, puede haber alcanzado el límite diario de tu plan — se reinicia automáticamente al día siguiente a medianoche.","g_266":"Aún no hay asuntos. Escribe al menos 3 variaciones tuyas en \"+ Agregar\" — usa las variables de arriba para personalizar automáticamente.","g_267":"Aún no hay cuerpos de correo. Escribe al menos 3 variaciones tuyas en \"+ Agregar\" — usa las variables de arriba para personalizar automáticamente.","g_268":"Perfil único: tu perfil sirve automáticamente para cualquier vacante, de cualquier planilla.","g_269":"⚙️ Filtros avanzados","g_270":"Tú escribes los textos — H2BApply nunca los completa por ti, solo entrega.","g_271":"escritos por ti","g_272":"tus propias versiones, escritas por ti","g_273":"Máx. 3MB", // 🌐 v137c: sons/boas-vindas/extrato/FAQ + 11 textos longos da varredura
    "home":"Inicio","manual":"Manual","search":"Buscar","auto":"Auto","responses":"Respuestas",
    "notifications":"Notificaciones","plans":"💎 Planes","profile":"Perfil","admin":"Panel Admin","logout":"Salir","logout_confirm":"¿Cerrar sesión de tu cuenta? Puedes volver a entrar cuando quieras con el mismo correo de Google.",
    "auto_title":"Envío Automático","auto_sub":"Toca para configurar e iniciar",
    "shortcuts":"Accesos Rápidos","today":"Hoy","account":"Cuenta","latest_replies":"Últimas Respuestas",
    "auto_lbl":"Automático","total_sends":"Total","profile_lbl":"Perfil",
    "plans_rewards":"Planes & Recompensas",
    "sent_apps":"Postulaciones Enviadas","me":"Yo","profiles":"Currículums","seasonal_jobs":"Empleos en Vivo",
    "plan_free":"Plan Gratuito","plan_vip":"Plan VIP","plan_pro":"Plan Pro","plan_vipro":"Plan VIPro",
    "roi_calc":"Calculadora de Resultados","roi_if":"Si solo el 1% de las empresas responde positivamente:","roi_cta":"¡Solo 1 empresa confirma → estás en los EUA! ✈️",
    "all_states":"Todos los estados","salary":"Salario","qty_jobs":"# Puestos",
    "sug_companies":"Empresas","sug_roles":"Puestos","sug_cities":"Ciudades","sug_regions":"Regiones","sug_states":"Estados","sug_jobs":"empleos",
    "extra_gmail":"Gmail Extra para Envíos","upgrade_to_enable":"Suscríbete a un plan para activarlo.","tap_to_pick":"(toca para elegir)","search_btn":"Buscar",
    "radar_btn":"📡 Radar","radar_title":"Radar de Empleos","radar_sub":"Guarda tus filtros actuales (búsqueda, estado, ciudad) y recibe un aviso en el celular cuando llegue un empleo NUEVO que combine — máximo 1 aviso al día.",
    "radar_create":"Crear radar con los filtros actuales","radar_active":"Tu radar está ENCENDIDO","radar_off":"Apagar radar",
    "radar_all":"Todos los empleos nuevos","radar_alerts":"aviso(s) enviados","radar_created":"¡Radar encendido! Te avisaremos cuando llegue un empleo nuevo que combine.","radar_removed":"Radar apagado.",
    "upsell_title":"Tu límite de hoy se acabó — los empleos no esperan","upsell_left":"Aún quedan {n} empleos disponibles HOY que no alcanzarás con tu plan actual. Suscríbete a un plan y sigue ahora mismo — comprobante confirmado, plan activado.",
    "upsell_left_generic":"El límite vuelve mañana — pero los mejores empleos de hoy ya tendrán otros candidatos. Suscríbete a un plan y sigue ahora.",
    "upsell_cta":"Ver planes y suscribirse","upsell_later":"Seguir gratis mañana",
    "st_starting":"🟡 Iniciando...","st_sending":"🟢 Enviando...","st_paused":"⏸ Pausado",
    "st_no_session":"⚠️ Inicia sesión de nuevo","st_finished":"✅ Completado","st_resuming":"🟢 Reanudando...",
    "st_refilled":"🔄 Cola recargada — enviando...","st_wait_interval":"⏳ Esperando intervalo...","st_wait_hour":"⏳ Esperando horario...",
    "st_wait_limit":"📊 Límite diario alcanzado","st_wait_rate":"⏳ Google pidió una pausa — reanudamos solos",
    "st_auth_err":"⛔ Pausado — reconecta tu Gmail","st_token_revoked":"🔐 Acceso Google revocado — inicia sesión de nuevo",
    "st_no_refresh":"🔐 Inicia sesión de nuevo para reactivar","st_corrupt":"❌ Problema en la cola — reinicia el automático",
    "hint_auth_err":"Abre Configuración y conecta tu cuenta Google de nuevo — tu cola sigue guardada.",
    "hint_token_revoked":"Cierra sesión y entra con Google de nuevo — tu cola sigue guardada.",
    "hint_no_refresh":"Entra con Google de nuevo — tu cola sigue guardada.",
    "hint_no_session":"Entra con Google de nuevo — tu cola sigue guardada.",
    "hint_corrupt":"Toca Parar e inicia el automático de nuevo.",
    "hint_rate":"Protección anti-spam normal de Gmail — nada que hacer, el robot reanuda solo.",
    "cd_soon":"Enviando en instantes...","cd_next":"Próximo envío en","cd_starts":"Inicia en","cd_resumes":"Reanuda en",
    "personal_data":"Datos Personales","full_name":"Nombre completo *","country":"País","required_lbl":"OBLIGATORIO",
    
    
    
    "plans_title":"Planes H2BApply","plans_sub":"Elige un plan, paga vía PIX y envía el comprobante",
    "plans_note":"Comprobante verificado automáticamente • Confirmación final siempre por un admin",
    
    "contact_data":"Tus datos de contacto","contact_sub":"Para activar tu plan y contactarte",
    "order_summary":"📋 Resumen del pedido","notes_lbl":"Observaciones",
        "settings_sub":"Tu cuenta, tu privacidad.","your_account":"Tu cuenta","how_works":"💡 ¿Cómo funciona?",
    "sug_step1":"Escribe tu sugerencia y pulsa enviar","sug_step2":"El equipo recibe y analiza todas las sugerencias",
    "sug_step3":"Las más pedidas se vuelven funciones en próximas actualizaciones","sug_sent":"📋 Tus sugerencias enviadas",
    "auto_cfg_sub":"Configura una vez. El sistema envía mientras trabajas.",
    "in_queue":"En cola","daily_limit":"Límite diario","queue_progress":"Progreso de la cola","last_sends":"Últimos envíos",
    "auto_src_title":"Elige la fuente de empleos","auto_src_sub":"Selecciona de dónde tomar los empleos",
    "auto_cv_title":"¿Qué currículum usar?","auto_cv_sub":"Los correos salen con el currículum y los textos de este perfil",
    "auto_start_btn":"🤖 Iniciar Envío Automático","auto_confirm_btn":"🚀 Confirmar Envío Automático",
    "auto_when":"¿Cuándo empezar?","auto_bg_ok":"¡✅ Funciona con la app cerrada!",
    "notif_sub":"Avisos y novedades del sistema",
    "sort_rand":"🔀 Aleatorio","sort_match":"🎯 Mejor para mí","sort_wage":"💰 Mayor salario","sort_start":"🗓️ Empieza pronto","sort_recent":"Recientes",
    "q_ph":"Puesto, empresa...","q_state_ph":"📍 Estado…","q_city_ph":"🏙️ Ciudad…","f_city_ph":"🏙️ Ciudad o región — ej.: Martha´s Vineyard, Key West…",
    "manual_today":"Envíos manuales hoy","send_by":"📧 Enviar desde","send_profile":"📋 Perfil de envío","resume_lbl":"📄 Currículum",
    "cancel":"Cancelar","send_btn":"Enviar","sending":"Enviando...","optional_lbl":"(opcional)","add_new":"+ Añadir",
    "logs_auto_title":"📋 Registros del Envío Automático","logs_auto_sub":"Historial completo de todos los envíos automáticos",
    "home_welcome":"¡Bienvenido(a) de nuevo! ¿Listo para enviar muchas postulaciones hoy?",
    "home_hero_badge":"Empleos de temporada en todo EE. UU.","home_hero_h1a":"Trabaja en EE. UU.","home_hero_h1b":"con más oportunidades",
    "home_stat_jobs":"Vacantes Disponibles","home_stat_companies":"Empresas Contactadas","home_stat_emails":"Correos Enviados",
    "home_activity_title":"Actividad Reciente","home_tips_title":"Consejos para más respuestas",
    "home_tip1":"Usa un currículum en inglés claro y objetivo.","home_tip2":"Postúlate a muchas vacantes — el volumen aumenta tus chances.",
    "home_tip3":"Personaliza tu carta de presentación.","home_tip4":"Mantén tu perfil siempre actualizado.","home_tip5":"Revisa tu carpeta de spam.",
    "home_tip_quote":"Disciplina hoy, oportunidades mañana.",
    "home_auto_b1":"Envía a varias vacantes por día","home_auto_b3":"Nunca repite una postulación","home_auto_b4":"Funciona 24h — no necesitas estar en línea","home_auto_cta":"Iniciar Envío Automático",
    "home_man_b1":"Busca y filtra las vacantes","home_man_b4":"Envía cuando estés listo",
    "manual_send_title":"Envío Manual","manual_send_sub":"Busca empleos y postúlate ahora",
    "plans_send_title":"💎 Planes","plans_send_sub":"Suscríbete a un plan y potencia tus postulaciones", // 🌐 v166: 3er CTA de Home
    "home_cv_tip":"Mantén tu currículum siempre actualizado.","home_cv_tip_link":"Editar currículum →", // 🌐 v166: aviso discreto de Home
    "inicio":"Inicio","auto_send":"Envío Automático","manual_send":"Envío Manual",
    "bn_jobs":"Empleos","bn_more":"Más","bn_more_title":"Más opciones","bn_auto":"Envío Automático","bn_tutorial":"Centro de Tutoriales","bn_settings":"Configuración",
    "sent_tab":"Enviadas","download_app":"Descargar App",
    "hist_short":"Enviadas","saved_short":"Guardadas",
    "greet_m":"👋 Buenos días,","greet_t":"👋 Buenas tardes,","greet_n":"👋 Buenas noches,","greet_d":"👋 Madrugada,",
    "saved_jobs":"Empleos Guardados","saved_ok":"¡Empleo guardado!","saved_removed":"Quitado de guardados",
    "saved_empty":"Ningún empleo guardado","saved_empty_sub":"Toca el 🔖 de cualquier empleo para guardarlo aquí",
    "saved_remove":"Quitar de guardados","saved_already_sent":"ya enviada","saved_no_email":"Este empleo no tiene email — abre el enlace del DOL",
    "saved_apply_title":"Postularse",
    "cd_on_lbl":"Protección: 1 min entre envíos manuales","cd_change":"cambiar",
    "cd_off_lbl":"Protección de 1 min APAGADA","cd_reactivate":"reactivar",
    "cd_modal_title":"¿Apagar la protección de 1 minuto?",
    "cd_modal_body":"El intervalo de 1 minuto entre envíos manuales protege tu cuenta. Enviar demasiados correos muy rápido hace que Google marque tu cuenta como spam — tu Gmail tiene MUCHA probabilidad de ser BLOQUEADO PARA SIEMPRE. El envío automático no cambia: sigue 1 cada 7 minutos.",
    "cd_modal_agree":"Entiendo el riesgo: mi Gmail puede ser bloqueado para siempre, y la responsabilidad es mía.",
    "cd_modal_keep":"Mantener protección","cd_modal_off":"Apagar de todos modos",
    "cd_toast_off":"⚠️ Protección de 1 min apagada — ¡cuidado con el ritmo!","cd_toast_on":"✅ Protección de 1 min reactivada",
    "all":"Todas","all_f":"Todas","active_f":"✅ Activas","random":"🔀 Aleatorio","recent":"Recientes","oldest":"Antiguas",
    "select_job":"Selecciona un empleo","select_job_sub":"Toca para ver detalles y postularte",
    "back_jobs":"Volver a empleos","job_search_ph":"Cargo, empresa, estado...",
    "hist_title":"Postulaciones Enviadas","hist_search_ph":"Buscar empresa, cargo o email...","hist_banner":"Tus postulaciones, siempre a la mano",
    "hist_info":"El botón Reset borra todo y devuelve los empleos a la lista (útil para volver a postularte).","home_footer_tag":"Más que un sistema. Es tu próximo paso.",
    "search_jobs":"Buscar Empleos","search_sub":"Busca en todas las fuentes: Seasonal, Jan 2026, Jul 2025",
    "search_ph":"Empresa, email, ETA case number, cargo, estado...","clear":"Limpiar",
    "all_sources":"Todas las fuentes","sent":"Enviadas",
    "search_anything":"Busca cualquier cosa",
    "search_hint":"Escribe el nombre de la empresa, un email recibido, el ETA case number, el cargo o el estado",
    "all_inbox":"Todos","unread":"No leídas","favorites":"Favoritos","this_week":"Esta semana",
    "enable_notif":"Activar notificaciones","enable_notif_sub":"Recibe avisos de confirmación de comprobante, estado del automático y novedades — incluso con la app cerrada",
    "activate":"Activar","inbox_search_ph":"Buscar empresa, asunto...","notif_short":"Notif",
    "reply_alert":"Alerta de nueva respuesta","reply_alert_sub":"Sonido + aviso de confirmación de comprobante, estado del automático y novedades (el sitio no lee tu correo — no avisamos cuando la empresa responde)",
    "pipe_responded":"Respondió","pipe_positive":"Interesado","pipe_interview":"Entrevista","pipe_offer":"Oferta",
    
    
    "full_name":"Nombre completo *","country":"País","city":"Ciudad",
    "full_name_ph":"Tu nombre completo","country_ph":"Brazil","save_data":"Guardar datos",
    "tap_to_enable":"Toca el botón para activar","new_profile":"Crear Nuevo Perfil",
    "email_profiles":"Perfiles de Email","profiles_desc":"Cada perfil define el asunto, el cuerpo del email y el currículum a usar. El sistema elige automáticamente el perfil correcto para cada empleo.",
    "no_profiles":"Sin perfiles creados","no_profiles_sub":"Crea tu primer perfil para empezar a enviar",
    "total_sent":"Total enviados","companies_lbl":"🏢 Empresas","states_lbl":"🗺️ Estados",
    "last_7days":"Últimos 7 días","top_states":"Top Estados","share_stats":"Compartir resultado",
    "auto_hero_sub":"Configura una vez. El sistema envía mientras trabajas.",
    "auto_free":"¡10 envíos GRATIS/día para todos!",
    "ws1_title":"Elige la fuente de empleos","ws1_sub":"Selecciona de dónde tomar los empleos",
    "ws2_title":"Filtros (opcional)","summer":"Verano","winter":"Invierno",
    "service_type":"Tipo de servicio (detectado automáticamente)",
    "state_opt":"Estado (opcional)","only_with_email":"Solo empleos con email",
    "min_salary":"Salario mínimo por hora (USD)","any_salary":"Cualquiera","with_email_only":"Solo con email",
    "all_ready":"¿Todo listo? ¡Empieza ahora!","start_auto":"🤖 Comenzar Envío Automático",
    "sent_lbl":"Enviados","failed":"Fallos","in_queue":"En cola","daily_limit":"Límite diario",
    "progress":"Progreso","next_app":"Próxima postulación",
    "pause":"Pausar","resume":"Reanudar","stop":"Detener","latest_sends":"Últimos envíos",
    "confirm_auto":"Confirmar Envío Automático","jobs_in_queue":"empleos en cola",
    "est_time":"tiempo estimado","between_emails":"entre emails",
    "start_now":"Empezar ahora","start_now_sub":"El 1er email sale en segundos. Usa la ventana configurada.",
    "schedule":"Programar horario","schedule_sub":"Empieza y para a la hora que elijas (BRT).",
    "schedule_time":"Horario (Brasília)","start_at":"Iniciar a las","stop_at":"Parar a las",
    "cancel":"Cancelar","confirm_start":"Confirmar e Iniciar",
    "gmail_limit_title":"Límite Gmail","works_closed":"¡Funciona con la app cerrada!",
    "only_login_once":"Solo necesita estar conectado una vez.",
    "when_start":"¿Cuándo empezar?","how_profiles_used":"Cómo se usarán tus perfiles:",
    "notif_sub":"Avisos y actualizaciones del sistema","notif_unread":"No leídas","notif_all":"Todas",
    "logs":"Registros",
    "send_title":"Enviar Postulación","send_profile":"Perfil de envío","send_btn":"Enviar",
    "loading":"Cargando...","error":"Error","retry":"Intentar de nuevo","save":"Guardar",
    "close":"Cerrar","send":"Enviar","delete":"Eliminar","edit":"Editar","back":"Volver",
    "sys_notif_label":"Aviso del Sistema","sys_notif_ok":"✅ Entendido","sys_notif_all":"🔔 Ver todas las notificaciones",
  }

};
let _curLang = (()=>{
  // v86 (dono, 01/08 — "site 100% bom pros olhos do usuário"): público é
  // 100% brasileiro, então o padrão é SEMPRE português. Só sai do PT se a
  // pessoa TROCOU de propósito pra EN/ES (escolha guardada no aparelho) —
  // nunca mais cai em inglês só porque o navegador do celular está em inglês.
  // Normaliza 'pt-BR'→'pt', 'en-US'→'en' etc. (a preferência salva no servidor
  // era gravada como 'pt-BR' e nunca batia com a chave 'pt' do dicionário).
  try{
    const saved=(localStorage.getItem('h2b_lang')||'').slice(0,2).toLowerCase();
    if(['pt','en','es'].includes(saved))return saved;
  }catch(e){}
  return'pt';
})();

function t(key){ return (LANG_DICT[_curLang]||LANG_DICT.pt)[key] || (LANG_DICT.pt[key]) || key; }

function applyLang(){
  document.documentElement.lang = _curLang==='pt'?'pt-BR':_curLang==='es'?'es':'en';

  // Lang button
  const lbl=document.getElementById('lang-label');
  if(lbl) lbl.textContent=_curLang.toUpperCase();
  const _fl=document.getElementById('lang-flag');
  if(_fl)_fl.textContent=({pt:"🇧🇷",en:"🇺🇸",es:"🇲🇽"})[_curLang]||"🇧🇷";
  // 🌐 Etapa 1 do i18n profissional (dono, 12/08): VARREDURA AUTOMÁTICA —
  // qualquer elemento com data-i18n / data-i18n-ph / data-i18n-title é
  // traduzido sozinho pelo dicionário. Nunca mais depender de lista manual
  // de elementos; marcou no HTML, traduziu. (t() cai no PT se faltar chave.)
  document.querySelectorAll("[data-i18n]").forEach(el=>{const v=t(el.getAttribute("data-i18n"));if(v)el.innerHTML=v;});
  document.querySelectorAll("[data-i18n-ph]").forEach(el=>{const v=t(el.getAttribute("data-i18n-ph"));if(v)el.placeholder=v;});
  document.querySelectorAll("[data-i18n-title]").forEach(el=>{const v=t(el.getAttribute("data-i18n-title"));if(v){el.title=v;el.setAttribute("aria-label",v);}});
  document.querySelectorAll('.lang-opt').forEach(b=>b.classList.toggle('active',b.dataset.lang===_curLang));

  // ── BOTTOM NAV — v171: 5 destinos (Início/Vagas/Enviadas/Perfil/Mais) —
  // v166 tinha reduzido a 3 (Início/Perfil/Planos) e deixado Vagas/Enviadas
  // sem NENHUM acesso de 1 toque no mobile (só via cards da Home). Vagas e
  // Enviadas usam data-i18n direto no HTML (varredura automática acima);
  // os 2 que não tinham (bn-profile/bn-more) continuam via _si().
  _si('bn-home','span',t('inicio'));
  _si('bn-profile','span',t('profile'));
  _si('bn-more','span',t('bn_more'));

  // ── SIDEBAR — v166: idem (Manual/Currículos/Automático saíram do topo) ──
  _sbItem('si-saved',t('saved_jobs')); // v126
  // 🌐 Etapa 1: sidebar 100% coberta (itens que ficavam de fora)
  _sbItem('si-home',t('inicio'));
  _sbItem('si-hist',t('sent_tab'));
  _sbItem('si-app',t('download_app'));
  _sbItem('si-plans',t('plans'));
  _sbItem('si-profile',t('profile'));

  // ── HOME ──
  _st('home-auto-title',t('auto_title'));
  _st('home-auto-sub',t('auto_sub'));

  // ── JOBS VIEW ──
  _sPlaceholder('q',t('job_search_ph'));
  _sText('f-state','option',0,t('all_states'));
  _sText('f-wage','option',0,t('salary'));
  _sText('f-workers','option',0,t('qty_jobs'));
  // Filter buttons
  _sBtnText('ft-all',t('all'));_sBtnText('fs-all',t('all_f'));_sBtnText('fs-active',t('active_f'));
  _sBtnText('so-rand',t('random'));_sBtnText('so-desc',t('recent'));
  // Job detail empty state
  const jdEmpty=document.getElementById('jd-empty');
  if(jdEmpty){
    const ds=jdEmpty.querySelectorAll('div');
    if(ds[0])ds[0].textContent=t('select_job');
    if(ds[1])ds[1].textContent=t('select_job_sub');
  }
  // Back button
  const mobBack=document.querySelector('.mob-back span');
  if(mobBack) mobBack.textContent=t('back_jobs');

  // ── HISTORY ──
  _sInnerHTML('v-hist',''); // Don't wipe, just update specific parts
  document.querySelectorAll('#v-hist .view-scroll>div:first-child>div:first-child').forEach(el=>{
    if(el.textContent.match(/Candidaturas|Applications|Postulaciones/)) el.textContent=t('hist_title');
  });
  _sBtnText('ht-all',t('all'));_sBtnText('ht-manual',t('manual'));
  _sPlaceholder('hist-search',t('hist_search_ph'));
  // Hist info box text
  _sFirstSpan('#v-hist .al-blue span, #v-hist [style*="info-circle"] + span',t('hist_info'));

  // ── RESPONSES ──
  document.querySelectorAll('#v-respostas [style*="font-size:16px"]').forEach(el=>{
    if(el.textContent.match(/Respostas|Replies|Respuestas/)){
      const ic=el.querySelector('i'); el.textContent=' '+t('responses'); if(ic)el.prepend(ic);
    }
  });
  // Stat labels in responses
  document.querySelectorAll('#v-respostas [style*="text-transform:uppercase"]').forEach(el=>{
    const txt=el.textContent.trim();
    if(txt==='Respostas'||txt==='Replies'||txt==='Respuestas') el.textContent=t('responses');
    else if(txt==='Total') el.textContent='Total';
    else if(txt==='Não lidas'||txt==='Unread'||txt==='No leídas') el.textContent=t('unread');
    else if(txt==='Favoritos'||txt==='Favorites'||txt==='Favoritos') el.textContent=t('favorites');
  });
  // Inbox tabs
  _sTabBtn('imtab-replies',t('responses'),'ti-arrow-back-up');
  _sTabBtn('imtab-all',t('all_inbox'),'ti-inbox');
  _sTabBtn('imtab-pipeline','Pipeline','ti-layout-kanban');
  // Inbox filters
  _sBtnText('ibf-all',t('all'));
  _sBtnTextKeepEmoji('ibf-unread','🔴 '+t('unread'));
  _sBtnTextKeepEmoji('ibf-starred','⭐ '+t('favorites'));
  _sBtnTextKeepEmoji('ibf-new','🆕 '+t('this_week'));
  // Notification banner
  document.querySelectorAll('#inbox-notif-banner div').forEach(el=>{
    if(el.textContent.match(/Ativar notificações|Enable notifications|Activar notificaciones/)) el.textContent=t('enable_notif');
    if(el.textContent.match(/Seja avisado|Be notified|Recibe avisos/)) el.textContent=t('enable_notif_sub');
  });
  const notifActivateBtn=document.querySelector('#inbox-notif-banner button:first-of-type');
  if(notifActivateBtn && notifActivateBtn.textContent.match(/Ativar|Activate|Activar/)) notifActivateBtn.textContent=t('activate');
  _sPlaceholder('inbox-search',t('inbox_search_ph'));
  // Inbox bulk bar
  _si('inbox-notif-tab-label','',t('notif_short'));
  // Pipeline columns
  _sPipeCol('pipe-responded','💬 '+t('pipe_responded'));
  _sPipeCol('pipe-positive','🟢 '+t('pipe_positive'));
  _sPipeCol('pipe-interview','📅 '+t('pipe_interview'));
  _sPipeCol('pipe-offer','🎉 '+t('pipe_offer'));
  // Inbox notification panel
  document.querySelectorAll('#inbox-notif-panel div').forEach(el=>{
    if(el.textContent.match(/Alerta de nova resposta|New reply alert|Alerta de nueva respuesta/)) el.textContent='🛫 '+t('reply_alert');
    if(el.textContent.match(/Som \+ aviso|Sound \+ alert|Sonido \+ aviso/)) el.textContent=t('reply_alert_sub');
  });

  // ── PROFILE (v168: virou tela única — #ptab-content-me/profiles/stats
  // eram os ids das antigas sub-abas; hoje são #pf-sec-me/#pf-sec-profiles.
  // "stats" (Números) foi removida por completo, junto com seu bloco de
  // tradução aqui embaixo.) ──
  _st('stab-seasonal-lbl',t('seasonal_jobs'));
  // Personal data section
  document.querySelectorAll('#pf-sec-me label').forEach(el=>{
    const txt=el.textContent.trim();
    if(txt.match(/Nome completo|Full name|Nombre completo/)) el.textContent=t('full_name');
    else if(txt==='País'||txt==='Country'||txt==='País') el.textContent=t('country');
    else if(txt==='Cidade'||txt==='City'||txt==='Ciudad') el.textContent=t('city');
    else if(txt==='WhatsApp') el.textContent='WhatsApp';
  });
  _sPlaceholder('cfg-name',t('full_name_ph'));
  _sPlaceholder('cfg-country',t('country_ph'));
  // Save button
  document.querySelectorAll('#pf-sec-me .btn-primary').forEach(b=>{
    if(b.textContent.match(/Salvar dados|Save data|Guardar datos/)){
      const ic=b.querySelector('i'); b.textContent=' '+t('save_data'); if(ic)b.prepend(ic);
    }
  });
  // Notification section
  document.querySelectorAll('#pf-sec-me [style*="text-transform:uppercase"]').forEach(el=>{
    if(el.textContent.match(/Notif/i)){
      const ic=el.querySelector('i'); el.textContent=' '+t('notifications'); if(ic)el.prepend(ic);
    }
  });
  document.querySelectorAll('#pf-sec-me [style*="font-size:13px;font-weight:700"]').forEach(el=>{
    if(el.textContent.match(/Alerta|Alert/)) el.textContent='🛫 '+t('reply_alert');
  });
  document.querySelectorAll('#pf-sec-me [style*="font-size:11px;color:var(--t2)"]').forEach(el=>{
    if(el.textContent.match(/Som \+ aviso|Sound|Sonido/)) el.textContent=t('reply_alert_sub');
  });
  _st('notif-status-msg',t('tap_to_enable'));
  // Profiles section
  document.querySelectorAll('#pf-sec-profiles .btn-primary').forEach(b=>{
    if(b.textContent.match(/Criar Novo|Create New|Crear Nuevo/)){
      const ic=b.querySelector('i'); b.textContent=' '+t('new_profile'); if(ic)b.prepend(ic);
    }
  });
  document.querySelectorAll('#pf-sec-profiles [style*="font-size:16px"]').forEach(el=>{
    if(el.textContent.match(/Perfis de Currículo|Email Profiles|Perfiles de Email/)){
      const ic=el.querySelector('i'); el.textContent=' '+t('email_profiles'); if(ic)el.prepend(ic);
    }
  });
  document.querySelectorAll('#pf-sec-profiles [style*="font-size:12px;color:var(--t2)"]').forEach(el=>{
    if(el.textContent.match(/Cada perfil define|Each profile defines|Cada perfil define/)) el.textContent=t('profiles_desc');
  });
  // Empty profile state
  document.querySelectorAll('#profile-list .empty-state p').forEach(el=>{
    if(el.textContent.match(/Nenhum perfil|No profiles|Sin perfiles/)) el.textContent=t('no_profiles');
  });
  document.querySelectorAll('#profile-list .empty-state small').forEach(el=>{
    if(el.textContent.match(/Crie seu primeiro|Create your first|Crea tu primer/)) el.textContent=t('no_profiles_sub');
  });

  // ── AUTO MODAL ──
  document.querySelectorAll('.auto-hero-title').forEach(el=>{
    const ic=el.querySelector('i'); el.textContent=' '+t('auto_title'); if(ic)el.prepend(ic);
  });
  document.querySelectorAll('.auto-hero-sub').forEach(el=>{
    el.textContent=t('auto_hero_sub');
  });
  // 🔒 v172: .auto-free-note deixou de ser rótulo estático (i18n) — agora é
  // dinâmico (_updateAutoFreeBanner: plano/Gmail/limite), então NÃO
  // sobrescreve mais aqui (isto apagaria o botão Ver planos/Conectar Gmail).
  _updateAutoFreeBanner();
  // Wizard steps
  document.querySelectorAll('.wizard-step-title').forEach((el,i)=>{
    if(i===0) el.textContent=t('ws1_title');
    else if(i===1) el.textContent=t('ws2_title');
  });
  document.querySelectorAll('.wizard-step-sub').forEach((el,i)=>{
    if(i===0) el.textContent=t('ws1_sub');
  });
  // Source buttons
  document.querySelectorAll('.source-btn-label').forEach(el=>{
    if(el.innerHTML.match(/Verão|Summer|Verano/)) el.innerHTML='<strong>Jan 2026</strong> — '+t('summer');
    else if(el.innerHTML.match(/Inverno|Winter|Invierno/)) el.innerHTML='<strong>Jul 2025</strong> — '+t('winter');
  });
  // Filter step labels
  document.querySelectorAll('#ws-2 label').forEach(el=>{
    const txt=el.textContent.trim();
    if(txt.match(/Tipo de serviço|Service type|Tipo de servicio/)) el.textContent=t('service_type');
    else if(txt.match(/Estado|State/)) el.textContent=t('state_opt');
    else if(txt.match(/Somente vagas|Only jobs|Solo empleos/)) el.textContent=t('only_with_email');
    else if(txt.match(/Salário mínimo|Min salary|Salario mínimo/)) el.textContent='💰 '+t('min_salary');
  });
  document.querySelectorAll('#af-state option:first-child').forEach(el=>el.textContent=t('all'));
  document.querySelectorAll('#af-has-email option').forEach((el,i)=>{
    if(i===0) el.textContent=t('all_f');
    else if(i===1) el.textContent=t('with_email_only');
  });
  // Wage buttons
  _sBtnText('wq-0',t('any_salary'));
  // Start section
  document.querySelectorAll('[style*="Tudo pronto"]').forEach(el=>{
    if(el.textContent.match(/Tudo pronto|All set|Todo listo/)) el.textContent='🚀 '+t('all_ready');
  });
  document.querySelectorAll('.auto-start-mega span').forEach(el=>{
    el.textContent=t('start_auto');
  });
  // Dashboard labels
  document.querySelectorAll('.auto-dash-lbl').forEach((el,i)=>{
    const labels=[t('sent_lbl'),t('failed'),t('in_queue'),t('daily_limit')];
    if(labels[i]) el.textContent=labels[i];
  });
  document.querySelectorAll('#auto-progress-wrap [style*="font-weight:700"]').forEach(el=>{
    if(el.id==='auto-prog-label') el.textContent=t('progress');
  });
  document.querySelectorAll('.next-job-title').forEach(el=>el.textContent='📬 '+t('next_app'));
  // Controls
  document.querySelectorAll('#auto-pause-btn').forEach(b=>{const ic=b.querySelector('i');b.textContent=' '+t('pause');if(ic)b.prepend(ic);});
  document.querySelectorAll('#auto-resume-btn').forEach(b=>{const ic=b.querySelector('i');b.textContent=' '+t('resume');if(ic)b.prepend(ic);});
  document.querySelectorAll('#auto-stop-btn').forEach(b=>{const ic=b.querySelector('i');b.textContent=' '+t('stop');if(ic)b.prepend(ic);});
  document.querySelectorAll('#auto-live-section [style*="text-transform:uppercase"]').forEach(el=>{
    if(el.textContent.match(/Últimos envios|Latest sends|Últimos envíos/)) el.textContent=t('latest_sends');
  });
  // Progress labels
  document.querySelectorAll('#dash-pct').forEach(()=>{});
  document.querySelectorAll('[id="auto-progress-wrap"] span').forEach(el=>{
    if(el.textContent==='✅ ') return;
    if(el.nextElementSibling?.id==='auto-prog-sent') el.textContent='✅ ';
  });

  // ── PREFLIGHT MODAL ──
  document.querySelectorAll('#pf-overlay .modal [style*="font-size:16px"]').forEach(el=>{
    if(el.textContent.match(/Confirmar Envio|Confirm Auto|Confirmar Envío/)){
      el.textContent='🚀 '+t('confirm_auto');
    }
  });
  document.querySelectorAll('#pf-overlay [style*="10px;color:var(--t2)"]').forEach(el=>{
    const txt=el.textContent.trim();
    if(txt.match(/vagas na fila|jobs in queue|empleos en cola/)) el.textContent=t('jobs_in_queue');
    else if(txt.match(/tempo estimado|estimated time|tiempo estimado/)) el.textContent=t('est_time');
    else if(txt.match(/entre e-mails|between emails|entre emails/)) el.textContent=t('between_emails');
  });
  document.querySelectorAll('#pf-opt-now [style*="font-weight:700"]').forEach(el=>{
    if(el.textContent.match(/Começar agora|Start now|Empezar ahora/)) el.textContent='▶ '+t('start_now');
  });
  document.querySelectorAll('#pf-opt-now [style*="font-size:11px"]').forEach(el=>{
    el.textContent=t('start_now_sub');
  });
  document.querySelectorAll('#pf-opt-sched [style*="font-weight:700"]').forEach(el=>{
    if(el.textContent.match(/Agendar|Schedule|Programar/)) el.textContent='🕐 '+t('schedule');
  });
  document.querySelectorAll('#pf-opt-sched [style*="font-size:11px"]').forEach(el=>{
    el.textContent=t('schedule_sub');
  });
  document.querySelectorAll('#pf-sched-box [style*="margin-bottom:8px"]').forEach(el=>{
    if(el.textContent.match(/Horário|Schedule time|Horario/)){
      const ic=el.querySelector('i'); el.textContent=' '+t('schedule_time'); if(ic)el.prepend(ic);
    }
  });
  document.querySelectorAll('#pf-sched-box label').forEach(el=>{
    if(el.textContent.match(/Iniciar às|Start at|Iniciar a/)) el.textContent=t('start_at');
    else if(el.textContent.match(/Parar às|Stop at|Parar a/)) el.textContent=t('stop_at');
  });
  document.querySelectorAll('#pf-overlay .btn-secondary').forEach(b=>{
    if(b.textContent.match(/Cancelar|Cancel/)) b.textContent=t('cancel');
  });
  document.querySelectorAll('#pf-overlay .btn-auto').forEach(b=>{
    const ic=b.querySelector('i'); b.textContent=' '+t('confirm_start'); if(ic)b.prepend(ic);
  });
  // Preflight alerts
  document.querySelectorAll('#pf-overlay .al-amber strong').forEach(el=>{
    if(el.textContent.match(/Limite Gmail|Gmail Limit|Límite Gmail/)) el.textContent='⚠️ '+t('gmail_limit_title');
  });
  document.querySelectorAll('#pf-overlay .al-green strong').forEach(el=>{
    if(el.textContent.match(/Funciona com app fechado|Works with app closed|Funciona con app cerrado/)) el.textContent='✅ '+t('works_closed');
  });
  document.querySelectorAll('#pf-overlay .al-green em').forEach(el=>{
    if(el.textContent.match(/Só precisa|Only need|Solo necesita/)) el.textContent=t('only_login_once');
  });
  document.querySelectorAll('#pf-overlay [style*="font-size:12px;font-weight:700"]').forEach(el=>{
    if(el.textContent.match(/Quando começar|When to start|Cuándo empezar/)) el.textContent=t('when_start');
  });
  document.querySelectorAll('#pf-profiles-info [style*="font-weight:700"]').forEach(el=>{
    if(el.textContent.match(/Como seus perfis|How your profiles|Cómo sus perfiles/)) el.textContent='🎯 '+t('how_profiles_used');
  });

  // ROI calculator
  document.querySelectorAll('#v-plans [style*="font-size:14px;font-weight:800"]').forEach(el=>{
    if(el.textContent.match(/Calculadora|Calculator|Calculadora/)){
      const ic=el.querySelector('i'); el.textContent=' '+t('roi_calc'); if(ic)el.prepend(ic);
    }
  });
  document.querySelectorAll('#v-plans [style*="font-size:12px;color:#166534"]').forEach(el=>{
    if(el.textContent.match(/Se apenas|If only|Si solo/)) el.textContent=t('roi_if');
  });
  document.querySelectorAll('#v-plans [style*="font-size:11px;color:#166534"]').forEach(el=>{
    if(el.textContent.match(/Basta 1 empresa|Just 1 company|Solo 1 empresa/)) el.textContent=t('roi_cta');
  });

  // ── LOGS VIEW ──
  document.querySelectorAll('#v-logs [style*="font-size:16px"]').forEach(el=>{
    if(el.textContent.match(/Logs|Log/)){
      const ic=el.querySelector('i'); el.textContent=' '+t('logs'); if(ic)el.prepend(ic);
    }
  });

  // ── SEND MODAL ──
  _st('m-title',window._sendModalDefaultTitle||t('send_title'));
  document.querySelectorAll('#m-modal label').forEach(el=>{
    if(el.textContent.match(/Perfil de envio|Send profile|Perfil de envío/)) el.textContent='📋 '+t('send_profile');
  });
  document.querySelectorAll('#m-send-btn').forEach(b=>{
    if(!b.disabled){ const ic=b.querySelector('i'); if(!ic||b.textContent.trim()!==t('send_btn')){ b.textContent=' '+t('send_btn'); if(ic)b.prepend(ic); }}
  });

  // Save lang to server if logged in
  if(window.U?.connected){
    fetch('/api/settings',{method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({language:_curLang})}).catch(()=>{});
  }

  window.dispatchEvent(new CustomEvent('h2b:langchange',{detail:{lang:_curLang}}));
}

// ── Helper functions ──
function _st(id,txt){const el=document.getElementById(id);if(el)el.textContent=txt;}
function _setTxt(id,txt){_st(id,txt);}
function _si(id,sel,txt){const el=document.getElementById(id);if(!el)return;const t=sel?el.querySelector(sel):el;if(t)t.textContent=txt;}
function _sbItem(id,txt){const el=document.getElementById(id);if(!el)return;const ic=el.querySelector('i'),b=el.querySelector('.sb-badge');el.textContent='';if(ic)el.appendChild(ic);el.appendChild(document.createTextNode(txt));if(b)el.appendChild(b);}
function _sTabBtn(id,txt,icon){const el=document.getElementById(id);if(!el)return;const badge=el.querySelector('.inbox-tab-badge');const ic=el.querySelector('i');el.textContent=' '+txt;if(ic)el.prepend(ic);if(badge)el.appendChild(badge);}
function _sBtnText(id,txt){const el=document.getElementById(id);if(!el)return;const ic=el.querySelector('i');if(ic){el.textContent=' '+txt;el.prepend(ic);}else el.textContent=txt;}
function _sBtnTextKeepEmoji(id,txt){const el=document.getElementById(id);if(el)el.textContent=txt;}
function _sPlaceholder(id,txt){const el=document.getElementById(id);if(el)el.placeholder=txt;}
function _sSection(sel,pt,en,es,txt){document.querySelectorAll(sel).forEach(el=>{if(el.textContent.trim()===pt||el.textContent.trim()===en||el.textContent.trim()===es)el.textContent=txt;});}
function _sTextNode(sel,pt,en,es,txt){document.querySelectorAll(sel).forEach(el=>{const d=el.querySelector('div:nth-child(2)>div:first-child');if(d&&(d.textContent===pt||d.textContent===en||d.textContent===es))d.textContent=txt;});}
function _sTextNodeSub(sel,pt,en,es,txt){document.querySelectorAll(sel).forEach(el=>{const d=el.querySelector('[style*="font-size:11px"]');if(d&&(d.textContent===pt||d.textContent===en||d.textContent===es))d.textContent=txt;});}
function _sInnerHTML(id,html){const el=document.getElementById(id);if(el&&html)el.innerHTML=html;}
function _sFirstSpan(sel,txt){const el=document.querySelector(sel);if(el)el.textContent=txt;} // FIX: função usada em L16778 (troca de idioma) nunca tinha sido definida — quebrava a atualização de i18n em cascata
function _sText(id,tag,idx,txt){const el=document.getElementById(id);if(!el)return;const items=el.querySelectorAll(tag);if(items[idx])items[idx].textContent=txt;}
function _sPipeCol(id,txt){const el=document.getElementById(id);if(!el)return;const hdr=el.querySelector('.pipeline-col-hdr');if(hdr){const cnt=hdr.querySelector('.pipeline-cnt');hdr.textContent=txt+' ';if(cnt)hdr.appendChild(cnt);}}

// Apply language on load
document.addEventListener('DOMContentLoaded',()=>{ setTimeout(applyLang, 300); });
if(document.readyState!=='loading') setTimeout(applyLang,400);

console.debug("[v19] Language system (PT/EN/ES) loaded");

// ══════════════════════════════════════════════════════════
//  💎 COMPRA DIRETA DE PLANO (v170 — dono, 09/09/2026: "retire todo
//  sistema de diamantes... reestruture pra pessoa conseguir comprar")
// ══════════════════════════════════════════════════════════
// O sistema de diamantes (saldo, troca, upgrade por diferença, doação
// entre amigos, missões) foi retirado por completo — regra da casa
// "🚫 INDICAÇÃO PREMIADA — NUNCA" também proíbe qualquer coisa parecida
// com recompensa por convidar/transferir, então essa peça não volta.
// Fluxo novo: a pessoa escolhe PLANO + PERÍODO, o preço em R$ vem
// SEMPRE de GET /api/planos (nunca hardcoded — regra 13o), ela confirma
// que leu e entende o consentimento (clickwrap, ver seção 12 dos Termos
// em server.js) e só DEPOIS vê a chave Pix. POST /api/pedido manda
// {tipo:'plano',plano,dias,consentimento:true,...} — o servidor
// recalcula o valor sozinho e ignora qualquer valorTotal do cliente.
// v43 (ordem do dono, 23/07/2026): InfinitePay REMOVIDA — todo pagamento é
// Pix pro PicPay do Andrio (chave 53981453496), em qualquer plano/período.
// 2026-07: consolidado numa chave só (telefone do Andrio) — antes o combo
// mostrava a chave/e-mail do Jesus (jesuscristh@jim.com), removido a pedido.
const PIX_KEY = '53981453496'; // Andrio — única chave Pix usada em todo o sistema
const PIX_NAME = 'Andrio Kickhofel';

let _planComp64 = null; // base64 do comprovante
let _planCompType = 'image/jpeg';

// window._planosData (cache de /api/planos), window._planoEscolhido
// ('vip'|'vipro'|'doublepro') e window._diasEscolhido (30|60|90|365) —
// inicializados aqui pra nunca ficarem undefined antes de loadPlanos()
// rodar (checkStatus() não lê mais diamante nenhum do /api/status).
window._planosData = window._planosData || null;
window._planoEscolhido = window._planoEscolhido || null;
window._diasEscolhido = window._diasEscolhido || null;

// Carrega a fonte ÚNICA de preço/limites (GET /api/planos, pública) toda
// vez que a aba Planos abre. Falha de rede nunca deixa a tela quebrada em
// silêncio — mostra um card com "tentar de novo" (mesmo padrão dos outros
// loads do app).
async function loadPlanos(){
  const box=g('#plan-select'); if(!box)return;
  box.innerHTML=`<div style="text-align:center;padding:20px"><span class="spin"></span></div>`;
  try{
    const r=await fetch('/api/planos',{credentials:'include'});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'?');
    window._planosData=d;
    _renderPlanosUI(d);
    _planStep1Sync();
  }catch(e){
    box.innerHTML=`<div style="background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rl);padding:14px;text-align:center;font-size:12px;color:var(--red)">${esc(t('plan_error_load'))} <span style="text-decoration:underline;cursor:pointer;font-weight:700" onclick="loadPlanos()">${esc(t('plan_try_again'))}</span></div>`;
  }
}

// Seletor de plano+período — 3 cards (VIP/VIPro/DoublePro), cada um com
// os limites REAIS vindos de d.limites e os preços REAIS de d.precos.
// Nunca texto fixo de limite/preço — sempre desta fonte (mesma classe de
// bug 13o que o v168 já corrigiu no extrato de diamantes).
function _renderPlanosUI(d){
  const box=g('#plan-select'); if(!box||!d)return;
  const NOME={vip:'⭐ VIP Manual',vipro:'🤖 VIPro',doublepro:'💎 DoublePro'};
  const DIAS_LBL={30:'30 dias',60:'60 dias',90:'90 dias',365:'1 ano'};
  const porPlano={};
  (d.precos||[]).forEach(p=>{(porPlano[p.plano]=porPlano[p.plano]||[]).push(p);});
  Object.keys(porPlano).forEach(pl=>porPlano[pl].sort((a,b)=>a.dias-b.dias));
  const sel=window._planoEscolhido, selDias=window._diasEscolhido;
  box.innerHTML=['vip','vipro','doublepro'].map(pl=>{
    const lim=(d.limites||{})[pl]||{};
    const partes=[];
    if(lim.manual)partes.push(lim.manual+' manuais/dia');
    if(lim.auto)partes.push(lim.auto+' automáticas/dia');
    const descLim=partes.length?partes.join(' + '):'';
    const isSel=sel===pl;
    return `<div style="background:var(--surface);border:2px solid ${isSel?'var(--blue)':'var(--border2)'};border-radius:var(--rl);padding:14px;margin-bottom:10px;${isSel?'box-shadow:0 0 0 3px rgba(37,99,235,.14)':''}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div style="font-size:14.5px;font-weight:800">${NOME[pl]}</div>
        ${isSel?'<span style="font-size:10px;font-weight:800;color:var(--blue);background:var(--bluel);border-radius:8px;padding:3px 8px">✓</span>':''}
      </div>
      <div style="font-size:11.5px;color:var(--t3);margin-bottom:10px">${esc(descLim)}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px">
        ${(porPlano[pl]||[]).map(c=>{
          const chSel=isSel&&selDias===c.dias;
          return `<button type="button" class="btn ${chSel?'btn-primary':'btn-secondary'}" style="justify-content:center;font-size:12.5px;padding:10px 6px" onclick="selectPlanoDias('${pl}',${c.dias})">${DIAS_LBL[c.dias]||c.dias+'d'} · R$ ${brl(c.valorTotal)}</button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

// Escolha de plano+período — marca a seleção, atualiza o resumo de preço
// (reaproveita #plan-calc/#calc-desc/#calc-total que já existiam) e
// sincroniza o botão de continuar (gated pelo consentimento também).
function selectPlanoDias(plano,dias){
  window._planoEscolhido=plano;
  window._diasEscolhido=dias;
  if(window._planosData)_renderPlanosUI(window._planosData);
  _planStep1Sync();
}
function _updatePlanCalcResumo(){
  const cDesc=g('#calc-desc'),cTotal=g('#calc-total');
  const pl=window._planoEscolhido,dias=window._diasEscolhido;
  if(!pl||!dias){ if(cDesc)cDesc.textContent=t('plan_calc_empty'); if(cTotal)cTotal.textContent='—'; return; }
  const NOME={vip:'⭐ VIP Manual',vipro:'🤖 VIPro',doublepro:'💎 DoublePro'};
  const row=(window._planosData?.precos||[]).find(p=>p.plano===pl&&p.dias===dias);
  const total=row?row.valorTotal:0;
  if(cDesc)cDesc.textContent=`${NOME[pl]||pl} · ${dias===365?'1 ano':dias+' dias'}`;
  if(cTotal)cTotal.textContent='R$ '+brl(total);
}
// Clickwrap (achado de pesquisa de UX — gesto duplo: marcar + clicar é o
// padrão juridicamente mais defensável): o botão de continuar do Passo 1
// só libera com plano+período escolhidos E o checkbox de consentimento
// marcado. Nunca pré-marcado, nunca destravado por atalho.
function _planStep1Sync(){
  _updatePlanCalcResumo();
  const btn=g('#plan-step1-continue-btn');
  if(btn){
    const ok=!!(window._planoEscolhido&&window._diasEscolhido)&&!!g('#plan-consent-check')?.checked;
    btn.disabled=!ok;
  }
}

function goToPlanStep2() {
  const plano=window._planoEscolhido,dias=window._diasEscolhido;
  if(!plano||!dias){ toast(t('consent_choose_plan'),'r'); return; }
  if(!g('#plan-consent-check')?.checked){ toast(t('consent_required_msg'),'r'); return; }

  const row=(window._planosData?.precos||[]).find(p=>p.plano===plano&&p.dias===dias);
  const total=row?row.valorTotal:0;
  const NOME={vip:'⭐ VIP Manual',vipro:'🤖 VIPro',doublepro:'💎 DoublePro'};
  gaEvent('checkout_step2',{plan:plano,dias,value:total,currency:'BRL'});

  const nameInp=g('#plan-form-name');
  if(nameInp && !nameInp.value) nameInp.value=U.name||'';
  const wppInp=g('#plan-form-wpp');
  if(wppInp && !wppInp.value) wppInp.value=U.phone||'';

  const sc=g('#plan-summary-content');
  if(sc) sc.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;font-size:14px">
    <div><strong>${NOME[plano]||plano}</strong> · ${dias===365?'1 ano':dias+' dias'}</div>
    <div style="font-weight:800;color:var(--green);font-size:18px">R$ ${brl(total)}</div>
  </div><div style="font-size:11px;color:var(--t3);margin-top:4px">O valor exato é sempre conferido pelo servidor — este é o preço oficial da tabela.</div>`;

  // Pagamento único — Pix pro PicPay do Andrio (v43), agora pagamento direto.
  const payEl=g('#plan-payment-links');
  if(payEl){
    payEl.innerHTML=`<div style="background:linear-gradient(135deg,rgba(16,185,129,.1),rgba(5,150,105,.06));border:1.5px solid rgba(16,185,129,.35);border-radius:12px;padding:14px">
      <div style="font-size:13px;font-weight:800;color:var(--green);margin-bottom:10px;display:flex;align-items:center;gap:6px">
        📱 Pagar via Pix (PicPay) — ${NOME[plano]||plano} · ${dias===365?'1 ano':dias+' dias'}
      </div>
      <div style="background:rgba(0,0,0,.2);border-radius:8px;padding:10px;margin-bottom:10px">
        <div style="font-size:11px;color:var(--t3);margin-bottom:4px">Chave Pix (telefone) — PicPay:</div>
        <div style="font-size:16px;font-weight:800;color:var(--green);letter-spacing:.5px;word-break:break-all">${PIX_KEY}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:4px">Titular: <strong style="color:var(--text)">${PIX_NAME}</strong></div>
      </div>
      <button class="btn btn-success w100" onclick="navigator.clipboard.writeText('${PIX_KEY}');toast('Chave Pix copiada ✓','g')" style="margin-bottom:10px;font-size:14px;padding:12px">
        <i class="ti ti-copy"></i> Copiar chave Pix
      </button>
      <div style="background:rgba(16,185,129,.12);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:var(--green)">R$ ${brl(total)}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:2px">${NOME[plano]||plano} · ${dias===365?'1 ano':dias+' dias'}</div>
      </div>
      <div style="font-size:11px;color:var(--t3);margin-top:8px;text-align:center">
        Pague por QUALQUER banco ou pelo app do PicPay usando a chave acima. Depois envie o comprovante abaixo — seu pedido é analisado assim que o comprovante chegar.
      </div>
    </div>`;
  }

  g('#plan-step-1').style.display = 'none';
  g('#plan-step-2').style.display = 'block';
  const _roi=g('#plan-roi-calc'); if(_roi)_roi.style.display = 'none';
  // Trava a data de pagamento em até hoje (não dá pra escolher data futura)
  try { const _pe = g('#plan-form-pago-em'); if(_pe){ _pe.max = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10); } } catch(e){}
  window.scrollTo(0, 0);
}

function goToPlanStep1() {
  g('#plan-step-1').style.display = 'block';
  g('#plan-step-2').style.display = 'none';
  const _roi=g('#plan-roi-calc'); if(_roi)_roi.style.display = '';
}

// 💼 MC5-P1 item 9: comprovante de IMAGEM é RE-ENCODADO no aparelho (canvas
// → JPEG ~1600px) antes de subir — mata HEIC de iPhone (que o robô de
// leitura não entende), derruba fotos de 5MB pra ~200KB e padroniza o mime.
// PDF passa direto (o robô agora lê PDF também). Qualquer falha = arquivo
// cru como sempre foi (fail-open, nunca trava o envio do pedido).
function _compComprovante(file){
  return new Promise((resolve)=>{
    try{
      if(!file.type||!file.type.startsWith('image/'))return resolve(null);
      const rd=new FileReader();
      rd.onload=()=>{const im=new Image();
        im.onload=()=>{try{
          const MAX=1600;let w=im.width,h=im.height;
          if(w>MAX||h>MAX){const k=Math.min(MAX/w,MAX/h);w=Math.round(w*k);h=Math.round(h*k);}
          const cv=document.createElement('canvas');cv.width=w;cv.height=h;
          cv.getContext('2d').drawImage(im,0,0,w,h);
          const out=cv.toDataURL('image/jpeg',0.82);
          resolve(out&&out.length>100?out:null);
        }catch(e){resolve(null);}};
        im.onerror=()=>resolve(null);
        im.src=rd.result;};
      rd.onerror=()=>resolve(null);
      rd.readAsDataURL(file);
    }catch(e){resolve(null);}
  });
}
async function handleComprovante(ev) {
  const file = ev.target.files[0];
  if(!file) return;
  const _ehImg=(file.type||'').startsWith('image/');
  // imagem grande ainda passa (a compressão resolve); PDF mantém o teto de 5MB
  if(file.size > (_ehImg?15:5) * 1024 * 1024) { toast('Arquivo muito grande (máx ' + (_ehImg?'15':'5') + 'MB)', 'r'); return; }
  const _comp = _ehImg ? await _compComprovante(file) : null;
  if(!_comp && file.size > 5 * 1024 * 1024) { toast('Arquivo muito grande (máx 5MB)', 'r'); return; }
  const _aplica = (dataUrl, mime, kb) => {
    _planComp64 = dataUrl.split(',')[1]; // só o base64
    _planCompType = mime;
    const img = g('#comp-img-preview');
    const preview = g('#comp-preview');
    const ph = g('#comp-placeholder');
    if(img && _ehImg) {
      img.src = dataUrl;
      if(preview) preview.style.display = 'block';
      if(ph) ph.style.display = 'none';
    } else {
      if(ph) ph.innerHTML = '<i class="ti ti-file-check" style="font-size:32px;color:var(--green);display:block;margin-bottom:8px"></i><div style="font-size:13px;font-weight:700;color:var(--green)">Comprovante PDF selecionado</div><div style="font-size:11px;color:var(--t3)">' + esc(file.name) + '</div>';
    }
    const cs = g('#comp-status');
    if(cs) { cs.style.display = 'block'; cs.innerHTML = '<div style="font-size:12px;color:var(--green);font-weight:700">✅ ' + esc(file.name) + ' (' + kb.toFixed(0) + ' KB)</div>'; }
    const dropArea = g('#comp-drop-area');
    if(dropArea) dropArea.style.borderColor = 'var(--green)';
  };
  if(_comp) { _aplica(_comp, 'image/jpeg', (_comp.length*0.75)/1024); return; }
  const reader = new FileReader();
  reader.onload = e => _aplica(e.target.result, file.type || 'image/jpeg', file.size/1024);
  reader.readAsDataURL(file);
}

async function submitPlanOrder() {
  // v170: envia pedido de PLANO DIRETO (tipo:'plano') — o servidor
  // recalcula o preço oficial (plano+dias) e IGNORA qualquer valor mandado
  // pelo cliente. consentimento:true só vai se o checkbox estiver marcado
  // — sem isso o front nem tenta a chamada (o backend também recusa, 400).
  const plano=window._planoEscolhido, dias=window._diasEscolhido;
  const name = g('#plan-form-name')?.value.trim() || '';
  const wpp = g('#plan-form-wpp')?.value.trim() || '';
  const phone = g('#plan-form-phone')?.value.trim() || '';
  const city = g('#plan-form-city')?.value.trim() || '';
  const state = g('#plan-form-state')?.value.trim() || '';
  const nota = g('#plan-form-nota')?.value.trim() || '';
  const statusEl = g('#plan-submit-status');
  const btn = g('#plan-submit-btn');

  if(!plano||!dias) { toast('Volte e escolha o plano e o período', 'r'); return; }
  if(!g('#plan-consent-check')?.checked) { toast(t('consent_required_msg'), 'r'); return; }
  if(!name) { toast('Preencha seu nome', 'r'); return; }
  if(!wpp) { toast('Preencha o WhatsApp', 'r'); return; }
  if(!city) { toast('Preencha a cidade', 'r'); return; }
  if(!_planComp64) { toast('Adicione o comprovante do pagamento', 'r'); g('#comp-drop-area').style.borderColor = 'var(--red)'; return; }

  const pagoEmVal = g('#plan-form-pago-em')?.value;
  if(!pagoEmVal) { toast('Informe a data em que você pagou (a mesma do comprovante)', 'r'); g('#plan-form-pago-em')?.focus(); return; }
  const pagoEmTs = new Date(pagoEmVal + 'T12:00:00').getTime();
  if(isNaN(pagoEmTs)) { toast('Data inválida', 'r'); return; }
  if(pagoEmTs > Date.now() + 86400000) { toast('A data não pode ser no futuro', 'r'); return; }

  const row=(window._planosData?.precos||[]).find(p=>p.plano===plano&&p.dias===dias);
  const total = row?row.valorTotal:0;
  const NOME={vip:'⭐ VIP Manual',vipro:'🤖 VIPro',doublepro:'💎 DoublePro'};

  if(btn) { btn.disabled = true; btn.innerHTML = '<span class="spin spin-sm"></span> Enviando...'; }
  if(statusEl) { statusEl.style.display = 'block'; statusEl.innerHTML = '<div style="font-size:12px;color:var(--t3)">Enviando pedido...</div>'; }

  try {
    const r = await fetch('/api/pedido', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'plano', plano, dias, consentimento: true, userName: name, userWhatsapp: wpp, userPhone: phone, userCity: city, userState: state, nota, comprovante: _planComp64, comprovanteType: _planCompType, pagoEm: pagoEmTs }),
    });
    const d = await r.json();
    if(d.ok) {
      g('#plan-step-2').style.display = 'none';
      g('#plan-step-done').style.display = 'block';
      const _roi2=g('#plan-roi-calc'); if(_roi2)_roi2.style.display = 'none';
      const dTitle = g('#plan-done-title'), dMsg = g('#plan-done-msg');
      if(d.duplicado) {
        if(dTitle) dTitle.textContent = 'Você já tem um pedido!';
        if(dMsg) dMsg.innerHTML = esc(d.message || 'Você já tem um pedido em análise.') + '<br><strong>Para dúvidas, entre em contato:</strong>';
        toast('ℹ️ ' + (d.message || 'Você já tem um pedido em análise.'), 'au');
      } else {
        gaEvent('purchase_order_submitted',{plan:plano,dias,value:total,currency:'BRL'});
        if(dTitle) dTitle.textContent = 'Pedido enviado! 🎉';
        // Promessa HONESTA de prazo: mediana REAL das últimas confirmações
        // (vinda de /api/planos), NUNCA um número fixo inventado tipo "24h".
        const med=window._planosData?.medianaAprovacaoHoras;
        const medTxt=(typeof med==="number"&&med>0)
          ?('normalmente em <strong>~'+(med<1?Math.max(1,Math.round(med*60))+' minutos':String(med).replace('.',',')+'h')+'</strong>')
          :'assim que possível';
        if(dMsg) dMsg.innerHTML = 'Recebemos seu pedido e o comprovante.<br>Um admin confirma manualmente — '+medTxt+' — e assim que confirmado, seu <strong>'+(NOME[plano]||plano)+'</strong> é ativado. Avisamos por notificação!<br><strong>Para dúvidas, entre em contato:</strong>';
        toast('✅ Pedido enviado! Aguarde a confirmação.', 'g');
      }
      renderPushAsk('plan-push-ask','Quer saber NA HORA em que seu plano for ativado? Ative as notificações.');
      _pendingOrderCache=undefined;
      _mpLoaded=false;

    } else {
      if(statusEl) statusEl.innerHTML = '<div style="font-size:12px;color:var(--red)">Erro: ' + esc(d.error||'?') + '</div>';
      if(btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Enviar pedido'; }
    }
  } catch(e) {
    if(statusEl) statusEl.innerHTML = '<div style="font-size:12px;color:var(--red)">Erro: ' + esc(e.message) + '</div>';
    if(btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Enviar pedido'; }
  }
}

// ── 🧾 MEUS PAGAMENTOS (v32) — histórico do cliente DENTRO de Planos ────────
// Espelho da Conferência do admin, do lado do cliente: cada pedido com status
// honesto. Mata o "paguei, cadê?" no WhatsApp. /api/pedidos já devolve só os
// pedidos do próprio usuário (sem a imagem do comprovante — lista leve).
let _mpLoaded=false;
async function toggleMeusPagamentos(){
  const box=g("#meus-pagamentos");if(!box)return;
  if(box.style.display!=="none"){box.style.display="none";return;}
  box.style.display="block";
  if(!_mpLoaded)await loadMeusPagamentos();
}
async function loadMeusPagamentos(){
  const box=g("#meus-pagamentos");if(!box)return;
  box.innerHTML=`<div style="text-align:center;padding:14px"><span class="spin"></span></div>`;
  try{
    const r=await fetch("/api/pedidos",{credentials:"include"});
    const d=await r.json();
    const peds=(d.pedidos||[]).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    _mpLoaded=true;
    // v170: renderer da ERA COMPRA DIRETA — status em vocabulário de pedido
    // de plano, mediana REAL de confirmação no lugar do "24h" fixo, motivo
    // do cancelamento visível e status do comprovante (com reenvio em 1
    // toque quando ilegível). Pedidos LEGADOS que ainda tenham tipo
    // "doacao" no banco (importados/antigos, de antes do v170) mostram só
    // o valor em R$, sem inventar conversão pra diamante — o crédito de
    // 💎 não existe mais.
    const _med=window._planosData?.medianaAprovacaoHoras;
    const _medTxt=(typeof _med==="number"&&_med>0)?(t('mp_media')+": ~"+(_med<1?Math.max(1,Math.round(_med*60))+"min":String(_med).replace(".",",")+"h")):t('mp_sub24');
    const stLbl=(p)=>{
      if(p.status==="pendente"&&p.autoAtivado)return["⚡ Liberado provisório","#d97706","rgba(245,158,11,.12)","Comprovante conferido pelo robô — plano já liberado; confirmação final da equipe pendente"];
      if(p.status==="pendente")return[t('mp_pend'),"#d97706","rgba(245,158,11,.12)",_medTxt];
      if(p.status==="pago")return[t('mp_pago'),"#2563eb","rgba(37,99,235,.1)",""];
      if(p.status==="ativo")return["✅ Ativo","#059669","rgba(16,185,129,.12)",p.ativadoEm?("✔ "+new Date(p.ativadoEm).toLocaleDateString("pt-BR")):""];
      if(p.status==="cancelado")return[t('mp_canc'),"#dc2626","rgba(239,68,68,.1)",p.motivoCancelamento?(t('mp_motivo')+": "+esc(p.motivoCancelamento)):t('mp_canc_sub')];
      return[esc(p.status||"?"),"var(--t3)","var(--sf2)",""];
    };
    if(!peds.length){
      box.innerHTML=`<div style="font-size:12px;color:var(--t3);text-align:center;padding:10px">Nenhum pedido por aqui ainda.</div>`;
      return;
    }
    box.innerHTML=peds.map(p=>{
      const[lbl,cor,bg,sub]=stLbl(p);
      const ehLegadoDoacao=p.tipo==="doacao"||p.plano==="doacao"; // legado pré-v170, sem conversão pra 💎
      const planLbl=ehLegadoDoacao
        ?"🧾 Pedido (legado)"
        :((({vip:"⭐ VIP Manual",vipro:"🤖 VIPro",doublepro:"💎 DoublePro"})[p.plano]||esc(p.plano||"?"))+" · "+(parseInt(p.dias,10)||"?")+"d");
      const dt=p.createdAt?new Date(p.createdAt).toLocaleDateString("pt-BR"):"–";
      const compLinha=(()=>{
        if(p.status!=="pendente")return "";
        const cs=p.comprovanteStatus;
        if(cs==="ilegivel"||cs==="sem")return `<div style="font-size:11px;color:#d97706;margin-top:4px">${esc(t('mp_ileg'))} <span style="text-decoration:underline;cursor:pointer;font-weight:700" onclick="mpReenviarComprovante('${esc(p.id)}')">${esc(t('mp_reenviar'))}</span></div>`;
        if(cs==="ok")return `<div style="font-size:11px;color:var(--green);margin-top:4px">${esc(t('mp_ok'))}</div>`;
        if(cs==="analise"||cs==="aguardando")return `<div style="font-size:11px;color:var(--t3);margin-top:4px">${esc(t('mp_analise'))}</div>`;
        return "";
      })();
      return`<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px">
            <div style="font-size:13px;font-weight:700">${planLbl}</div>
            <div style="font-size:11px;color:var(--t3)">${dt} · #${esc((p.id||"").slice(-8).toUpperCase())}</div>
          </div>
          <div style="font-size:14px;font-weight:800;color:var(--green)">R$ ${brl(p.valorTotal)}</div>
          <span style="font-size:10.5px;font-weight:800;color:${cor};background:${bg};border-radius:8px;padding:3px 8px">${lbl}</span>
        </div>
        ${sub?`<div style="font-size:11px;color:var(--t3);margin-top:4px">${sub}</div>`:""}
        ${compLinha}
      </div>`;
    }).join("");
  }catch(e){
    box.innerHTML=`<div style="font-size:12px;color:var(--red);text-align:center;padding:10px">Erro ao carregar. <span style="text-decoration:underline;cursor:pointer" onclick="loadMeusPagamentos()">Tentar de novo</span></div>`;
  }
}

// 💼 MC5-P2 item 5: reenviar comprovante de um pedido pendente — abre o
// seletor, comprime no aparelho (mesmo helper do envio) e SUBSTITUI no
// servidor (rota do dono do pedido; hash e leitura recalculados na hora).
function mpReenviarComprovante(pid){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='image/*,application/pdf';
  inp.onchange=async()=>{
    const file=inp.files&&inp.files[0];if(!file)return;
    const _ehImg=(file.type||'').startsWith('image/');
    if(file.size>(_ehImg?15:5)*1024*1024){toast('Arquivo muito grande','r');return;}
    let b64=null,mime=file.type||'image/jpeg';
    const comp=_ehImg?await _compComprovante(file):null;
    if(comp){b64=comp.split(',')[1];mime='image/jpeg';}
    else{
      if(file.size>5*1024*1024){toast('Arquivo muito grande (máx 5MB)','r');return;}
      b64=await new Promise((res,rej)=>{const rd=new FileReader();rd.onload=()=>res(rd.result.split(',')[1]);rd.onerror=rej;rd.readAsDataURL(file);});
    }
    try{
      const r=await fetch('/api/pedido/'+encodeURIComponent(pid)+'/comprovante',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({comprovante:b64,comprovanteType:mime})}).then(x=>x.json());
      if(!r.ok)throw new Error(r.error||'?');
      toast('📤 Comprovante atualizado — vamos reler agora','g');
      _mpLoaded=false;loadMeusPagamentos();
    }catch(e){toast('Erro: '+e.message,'r');}
  };
  inp.click();
}

// ════════════════════════════════════════════════════════════
//  WHATSAPP OBRIGATÓRIO
//  Verifica se o usuário tem WhatsApp cadastrado.
//  Se não tiver, exibe card que bloqueia gentilmente o app
//  até ele informar o número. Salva no servidor automaticamente.
// ════════════════════════════════════════════════════════════
function checkWppRequired(){
  // Só checar se usuário está conectado e não é admin
  if(!U.connected) return;
  if(U.isAdmin) return;
  // Não mostrar se os termos ainda não foram aceitos
  var termsOverlay = document.getElementById("terms-overlay");
  if(termsOverlay && termsOverlay.style.display === "flex") return;
  // Não mostrar se o sessionStorage não tem flag de termos aceitos
  if(!sessionStorage.getItem("h2b_terms_session")) return;
  // Verificar se já tem WhatsApp ou telefone
  const hasWpp = (U.whatsapp||'').trim().length > 5;
  const hasPhone = (U.phone||'').trim().length > 5;
  if(hasWpp || hasPhone){
    // Já tem número — garantir que o overlay não está aparecendo
    const ov = g('#wpp-required-overlay');
    if(ov) ov.style.display = 'none';
    return;
  }
  // Não tem número — mostrar o card
  const ov = g('#wpp-required-overlay');
  if(ov){
    ov.style.display = 'flex';
    setTimeout(()=>{ const inp = g('#wpp-required-input'); if(inp) inp.focus(); }, 300);
  }
}

async function wppRequiredSave(){
  const inp = g('#wpp-required-input');
  const errEl = g('#wpp-required-error');
  const btn = g('#wpp-required-btn');
  if(!inp) return;

  const raw = inp.value.trim();
  // Validação simples: mínimo 8 dígitos numéricos
  const digits = raw.replace(/\D/g,'');
  if(digits.length < 8){
    if(errEl){ errEl.style.display='block'; errEl.textContent='Informe um número válido (mínimo 8 dígitos)'; }
    inp.style.borderColor = 'rgba(248,113,113,.6)';
    inp.focus();
    return;
  }
  if(errEl) errEl.style.display = 'none';
  if(btn){ btn.disabled=true; btn.innerHTML='<span>⏳</span> Salvando...'; }

  try{
    const r = await fetch('/api/settings',{
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ whatsapp: raw, phone: raw })
    });
    const d = await r.json();
    if(d.ok){
      // Atualizar U em memória
      U.whatsapp = raw;
      U.phone = raw;
      CFG.phone = raw;
      // Atualizar campo do perfil se estiver visível
      const phoneEl = g('#cfg-phone');
      if(phoneEl) phoneEl.value = raw;
      const wppEl = g('#cfg-whatsapp');
      if(wppEl) wppEl.value = raw;
      // Fechar overlay
      const ov = g('#wpp-required-overlay');
      if(ov) ov.style.display = 'none';
      // Toast de sucesso
      toast('📱 WhatsApp salvo com sucesso!', 'g');
    } else {
      if(errEl){ errEl.style.display='block'; errEl.textContent = d.error || 'Erro ao salvar. Tente novamente.'; }
      if(btn){ btn.disabled=false; btn.innerHTML='<span>💬</span> Salvar e continuar'; }
    }
  }catch(e){
    if(errEl){ errEl.style.display='block'; errEl.textContent='Erro de conexão. Tente novamente.'; }
    if(btn){ btn.disabled=false; btn.innerHTML='<span>💬</span> Salvar e continuar'; }
  }
}

const _origSv = typeof sv === 'function' ? sv : null;

;