/* ═══════════════════════════════════════════════════════════════
   H2BApply EXTRAS v1.0 — Camada de melhorias (usuário)
   Autocontido, não altera funções existentes. Injetado no index.html.
   8 melhorias de UX. Tudo client-side/localStorage.
   ═══════════════════════════════════════════════════════════════ */
(function(){
"use strict";
const LS = (k,v)=>{ if(v===undefined){ try{return JSON.parse(localStorage.getItem("hx_"+k));}catch(e){return null;} } localStorage.setItem("hx_"+k, JSON.stringify(v)); };
const $ = s=>document.querySelector(s);
const $$ = s=>Array.from(document.querySelectorAll(s));
const T = (msg,type)=>{ try{ if(typeof toast==="function"){toast(msg,type||"");return;} }catch(e){} const d=document.createElement("div");d.textContent=msg;d.style.cssText="position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:10px 18px;border-radius:24px;font-size:13px;font-weight:700;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,.35)";document.body.appendChild(d);setTimeout(()=>d.remove(),2600); };

/* ─── CSS do módulo ─── */
const css = document.createElement("style");
css.textContent = `
#hx-top{position:fixed;right:14px;bottom:180px;width:40px;height:40px;border-radius:50%;background:rgba(30,41,59,.85);color:#fff;border:none;cursor:pointer;z-index:9490;display:none;align-items:center;justify-content:center;font-size:17px;backdrop-filter:blur(4px)}
#hx-offline{position:fixed;top:0;left:0;right:0;background:#ef4444;color:#fff;text-align:center;font-size:12px;font-weight:800;padding:5px;z-index:99998;display:none}
`;
document.head.appendChild(css);

/* ═══ MELHORIA 1: Indicador offline/online ═══ */
const off = document.createElement("div");
off.id="hx-offline"; off.textContent="📡 Sem conexão — algumas funções podem não funcionar";
document.body.appendChild(off);
window.addEventListener("offline",()=>{off.style.display="block";});
window.addEventListener("online",()=>{off.style.display="none";T("Conexão restabelecida ✅","ok");});

/* ═══ MELHORIA 2: ESC fecha overlays/modais visíveis ═══ */
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  $$(".resp-modal-overlay,.modal-ov,.overlay,[id$='-overlay']").forEach(m=>{
    if(m.offsetParent!==null && !m.classList.contains("gone")){
      const btn=m.querySelector("[onclick*='close'],[onclick*='Close']");
      if(btn){btn.click();}else{m.classList.add("gone");}
    }
  });
});

/* ═══ MELHORIA 3: Botão "voltar ao topo" ═══ */
const topBtn=document.createElement("button");
topBtn.id="hx-top"; topBtn.innerHTML="↑"; topBtn.title="Voltar ao topo";
topBtn.onclick=()=>{const a=$("#app");if(a)a.scrollTo({top:0,behavior:"smooth"});window.scrollTo({top:0,behavior:"smooth"});};
document.body.appendChild(topBtn);
const scrollWatch=()=>{const a=$("#app");const y=(a?a.scrollTop:0)+window.scrollY;topBtn.style.display=y>600?"flex":"none";};
setInterval(scrollWatch,700);

/* ═══ MELHORIA 4: Autosave de rascunhos em textareas ═══ */
document.addEventListener("input",e=>{
  const el=e.target;
  if(el.tagName==="TEXTAREA" && el.id){ LS("draft_"+el.id, el.value); }
},true);
window.addEventListener("load",()=>{ setTimeout(()=>{
  $$("textarea[id]").forEach(el=>{ const d=LS("draft_"+el.id); if(d && !el.value){ el.value=d; } });
},1500); });

/* ═══ MELHORIA 5: Atalhos de teclado ═══ */
document.addEventListener("keydown",e=>{
  if(["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName))return;
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const map={"1":"jobs","2":"profile","3":"plans"}; // v-2026: "4"/"5" apontavam pra "hist"/"saved", views que não existem mais nesta reconstrução (apagavam a tela inteira) — removidas
  if(map[e.key] && typeof sv==="function"){sv(map[e.key]);T("Aba: "+map[e.key]);}
  if(e.key==="/"){e.preventDefault();const s=$$("input[type='search'],input[placeholder*='uscar'],input[placeholder*='earch']").find(i=>i.offsetParent);if(s)s.focus();}
  if(e.key.toLowerCase()==="t"){toggleTheme();}
});
function toggleTheme(){
  const cur=document.documentElement.getAttribute("data-theme");
  const next=cur==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme",next);
  LS("theme",next); T(next==="dark"?"🌙 Modo escuro":"☀️ Modo claro");
}
const savedTheme=LS("theme"); if(savedTheme){document.documentElement.setAttribute("data-theme",savedTheme);}

/* ═══ MELHORIA 6: Duplo clique em input de busca limpa o campo ═══ */
document.addEventListener("dblclick",e=>{
  const el=e.target;
  if(el.tagName==="INPUT"&&(el.type==="search"||/uscar|earch|iltr/i.test(el.placeholder||""))){el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));T("Busca limpa");}
});

/* ═══ MELHORIA 7: Persistência da última aba visitada ═══ */
const _sv = window.sv;
if(typeof _sv==="function"){ window.sv=function(v,...a){ LS("lastView",v); return _sv(v,...a); }; }

/* ═══ MELHORIA 8: Segurança em links externos ═══ */
setInterval(()=>{ $$("a[target='_blank']:not([rel])").forEach(a=>a.rel="noopener noreferrer"); },4000);


/* ═══════════════════════════════════════════════════════════════
   🛡️ BLINDAGEM VISUAL — ícones e fotos nunca mais quebram
   Problema real (03/07): CDN de ícones falhou → todos os glifos sumiram;
   fotos do Google (lh3.googleusercontent) davam 403 sem referrerpolicy.
   Camadas: 1) detecta fonte de ícones ausente e injeta CDN reserva;
   2) se ainda falhar, mapeia ícones essenciais para emojis (nunca fica vazio);
   3) toda <img> ganha no-referrer + retry + avatar de iniciais gerado local.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  /* ── CAMADA 1+2: ÍCONES ── */
  function iconFontLoaded(){
    try{ return document.fonts && document.fonts.check('1em "tabler-icons"'); }catch(e){ return true; }
  }
  const EMOJI_MAP = {
    "search":"🔍","send":"📤","mail":"✉️","mail-opened":"📬","user":"👤","users":"👥",
    "settings":"⚙️","home":"🏠","file-cv":"📄","file-text":"📄","file-type-pdf":"📄",
    "rocket":"🚀","trophy":"🏆","bell":"🔔","gift":"🎁","diamond":"💎","crown":"👑",
    "check":"✔️","x":"✖️","trash":"🗑️","refresh":"🔄","chevron-right":"›","chevron-left":"‹",
    "chevron-down":"⌄","chevron-up":"⌃","plus":"＋","minus":"−","alert-circle":"⚠️",
    "info-circle":"ℹ️","brand-google":"🔵","brand-whatsapp":"💬","calendar":"📅",
    "clock":"🕐","map-pin":"📍","building":"🏢","currency-dollar":"💲","briefcase":"💼",
    "star":"⭐","heart":"❤️","eye":"👁️","download":"⬇️","upload":"⬆️","link":"🔗",
    "lock":"🔒","lock-open":"🔓","logout":"🚪","login":"🔑","language":"🌐",
    "robot":"🤖","chart-bar":"📊","list":"📋","edit":"✏️","pencil":"✏️","copy":"📋",
    "share":"📲","phone":"📞","world":"🌍","flag":"🚩","filter":"🧮","menu-2":"☰",
    "dots":"⋯","arrow-right":"→","arrow-left":"←","circle-check":"✅","player-play":"▶️",
  };
  let fallbackCssInjected=false, emojiMode=false;
  function injectFallbackCdn(){
    if(fallbackCssInjected)return; fallbackCssInjected=true;
    const l=document.createElement("link"); l.rel="stylesheet";
    l.href="https://unpkg.com/@tabler/icons-webfont@3.29.0/dist/tabler-icons.min.css";
    document.head.appendChild(l);
    console.warn("[visual] CDN primário de ícones falhou — carregando reserva (unpkg)");
    setTimeout(()=>{ if(!iconFontLoaded()) enableEmojiIcons(); }, 4000);
  }
  function enableEmojiIcons(){
    if(emojiMode)return; emojiMode=true;
    console.warn("[visual] Fonte de ícones indisponível — ativando modo emoji (nunca fica vazio)");
    const rules=Object.entries(EMOJI_MAP).map(([k,v])=>`.ti-${k}::before{content:"${v}" !important;font-family:inherit !important}`).join("\n");
    const st=document.createElement("style");
    st.textContent=`.ti::before{font-family:inherit}\n${rules}\n.ti:not([class*="ti-"])::before{content:"•"}`;
    document.head.appendChild(st);
  }
  function checkIcons(){
    if(iconFontLoaded())return;
    injectFallbackCdn();
  }
  if(document.readyState==="complete") setTimeout(checkIcons,2500);
  else window.addEventListener("load",()=>setTimeout(checkIcons,2500));
  // Re-checa quando volta online (CDN pode ter falhado por rede)
  window.addEventListener("online",()=>setTimeout(checkIcons,1500));

  /* ── CAMADA 3: FOTOS/AVATARES ── */
  function initialsAvatar(seed){
    const ch=(String(seed||"?").trim()[0]||"?").toUpperCase();
    const colors=["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"];
    const bg=colors[(ch.charCodeAt(0)||63)%colors.length];
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="${bg}"/><text x="40" y="53" font-family="Arial,sans-serif" font-size="36" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
  }
  // Proativo: no-referrer em toda foto externa (Google 403 fix)
  function shieldImg(img){
    if(img.dataset.hxShield)return;
    img.dataset.hxShield="1";
    const src=img.getAttribute("src")||"";
    if(/googleusercontent|unavatar|googleapis|gravatar/.test(src)){
      img.referrerPolicy="no-referrer";
    }
  }
  new MutationObserver(muts=>{
    muts.forEach(m=>m.addedNodes.forEach(n=>{
      if(n.tagName==="IMG")shieldImg(n);
      else if(n.querySelectorAll)n.querySelectorAll("img").forEach(shieldImg);
    }));
  }).observe(document.documentElement,{childList:true,subtree:true});
  document.querySelectorAll("img").forEach(shieldImg);
  // Reativo: erro em qualquer <img> → 1 retry sem referrer → avatar de iniciais
  document.addEventListener("error",e=>{
    const img=e.target;
    if(!img||img.tagName!=="IMG")return;
    if(img.dataset.hxAvDone)return;
    const tries=+(img.dataset.hxAvTry||0);
    const src=img.getAttribute("src")||"";
    if(tries===0 && /^https?:/.test(src) && !img.referrerPolicy){
      img.dataset.hxAvTry="1"; img.referrerPolicy="no-referrer";
      const s=src; img.src=""; img.src=s; // força nova tentativa
      return;
    }
    // Fallback final: avatar de iniciais (gerado localmente, nunca falha)
    img.dataset.hxAvDone="1";
    const seed=img.alt||img.title||img.closest("[data-name]")?.dataset.name||
      (img.closest("div,li,td")?.textContent||"").trim()||"?";
    img.src=initialsAvatar(seed);
    img.style.objectFit="cover";
  },true); // capture: pega erros de qualquer img, mesmo criadas depois
  window.hxInitialsAvatar=initialsAvatar;
  console.log("[visual] 🛡️ Blindagem visual ativa (ícones 3 camadas + avatares com fallback)");
})();

console.log("[H2B Extras] Camada de melhorias do usuário carregada ✅");
})();
