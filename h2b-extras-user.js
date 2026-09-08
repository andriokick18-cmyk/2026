/* ═══════════════════════════════════════════════════════════════
   H2BApply EXTRAS v1.0 — Camada de melhorias (usuário)
   Autocontido, não altera funções existentes. Injetado no index.html.
   10 melhorias + 11 novas funcionalidades. Tudo client-side/localStorage.
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
/* v-2026: o botão flutuante tinha sido escondido com a promessa de que o
   hub Extras passaria a morar no "MENU ☰" — mas esta reconstrução enxuta
   nunca teve esse menu (navegação reduzida a Início/Perfil/Planos), então
   as 6 ferramentas (notas, lembretes, calculadora, backup etc.) ficavam
   inacessíveis pra quem não sabia do atalho de teclado X (e inacessíveis
   de vez no celular, sem teclado). Restaurado como botão flutuante. */
#hx-fab{position:fixed;right:14px;bottom:100px;width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;cursor:pointer;z-index:480;display:flex;align-items:center;justify-content:center;font-size:21px;box-shadow:0 4px 16px rgba(99,102,241,.45)}
#hx-fab:active{transform:scale(.92)}
#hx-fab .hx-badge{position:absolute;top:-3px;right:-3px;background:#ef4444;color:#fff;font-size:9px;font-weight:800;min-width:16px;height:16px;border-radius:8px;display:none;align-items:center;justify-content:center;padding:0 4px}
#hx-top{position:fixed;right:14px;bottom:180px;width:40px;height:40px;border-radius:50%;background:rgba(30,41,59,.85);color:#fff;border:none;cursor:pointer;z-index:9490;display:none;align-items:center;justify-content:center;font-size:17px;backdrop-filter:blur(4px)}
#hx-panel{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9600;display:none}
#hx-panel.open{display:flex;align-items:flex-end;justify-content:center}
#hx-sheet{background:var(--surface,#fff);width:100%;max-width:560px;max-height:86dvh;border-radius:20px 20px 0 0;overflow-y:auto;padding:16px 16px 28px;animation:hxUp .22s ease}
[data-theme="dark"] #hx-sheet{background:#1c1f35;color:#e2e8f0}
@keyframes hxUp{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}
.hx-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
.hx-tool{background:var(--sf2,#f1f5f9);border:1px solid var(--border,#e2e8f0);border-radius:14px;padding:12px 6px;text-align:center;cursor:pointer;font-size:11px;font-weight:700;color:inherit;transition:transform .12s}
[data-theme="dark"] .hx-tool{background:#252a45;border-color:#33395c}
.hx-tool:active{transform:scale(.95)}
.hx-tool .ic{font-size:22px;display:block;margin-bottom:5px}
.hx-sub{display:none;margin-top:14px}
.hx-sub.open{display:block}
.hx-sub h4{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:6px}
.hx-sub textarea,.hx-sub input,.hx-sub select{width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid var(--border,#cbd5e1);font:inherit;font-size:13px;background:var(--sf2,#f8fafc);color:inherit;margin-bottom:8px}
[data-theme="dark"] .hx-sub textarea,[data-theme="dark"] .hx-sub input,[data-theme="dark"] .hx-sub select{background:#252a45;border-color:#33395c;color:#e2e8f0}
.hx-btn{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit}
.hx-btn.sec{background:var(--sf3,#e2e8f0);color:inherit}
[data-theme="dark"] .hx-btn.sec{background:#33395c}
.hx-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;background:var(--sf2,#f8fafc);border:1px solid var(--border,#e2e8f0);margin-bottom:6px;font-size:13px}
[data-theme="dark"] .hx-item{background:#252a45;border-color:#33395c}
.hx-item.due{border-color:#ef4444;background:rgba(239,68,68,.08)}
.hx-clockrow{display:flex;gap:8px;flex-wrap:wrap}
.hx-clock{flex:1;min-width:100px;text-align:center;background:var(--sf2,#f1f5f9);border-radius:12px;padding:10px 4px;border:1px solid var(--border,#e2e8f0)}
[data-theme="dark"] .hx-clock{background:#252a45;border-color:#33395c}
.hx-clock b{font-size:17px;display:block}
.hx-clock span{font-size:10px;opacity:.7;font-weight:700}
body.hx-focus .banner, body.hx-focus footer, body.hx-focus #install-banner{display:none!important}
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
  const sheet=$("#hx-panel"); if(sheet&&sheet.classList.contains("open")){closePanel();return;}
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
  if(e.key.toLowerCase()==="x"){openPanel();}
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

/* ═══ MELHORIA 9: Tamanho de fonte acessível (persistente) ═══ */
function applyFont(){ const f=LS("fontScale")||100; document.documentElement.style.fontSize=f+"%"; }
applyFont();

/* ═══════════ PAINEL EXTRAS (hub das novas funcionalidades) ═══════════ */
const fab=document.createElement("button");
fab.id="hx-fab"; fab.innerHTML="✨<span class='hx-badge' id='hx-fab-badge'></span>"; fab.title="Extras H2BApply (atalho: X)";
fab.onclick=openPanel; document.body.appendChild(fab);

const panel=document.createElement("div");
panel.id="hx-panel";
panel.innerHTML=`<div id="hx-sheet">
 <div style="display:flex;align-items:center;justify-content:space-between">
  <h3 style="margin:0;font-size:16px">✨ Extras H2BApply</h3>
  <button class="hx-btn sec" onclick="window.hxClose()">Fechar</button>
 </div>
 <div class="hx-grid">
  <button class="hx-tool" data-sub="notes"><span class="ic">📝</span>Bloco de Notas</button>
  <button class="hx-tool" data-sub="remind"><span class="ic">⏰</span>Lembretes<br>Follow-up</button>
  <button class="hx-tool" data-sub="clock"><span class="ic">🇺🇸</span>Horário EUA</button>
  <button class="hx-tool" data-sub="calc"><span class="ic">💵</span>Salário USD→BRL</button>
  <button class="hx-tool" data-sub="backup"><span class="ic">💾</span>Backup / Restaurar</button>
  <button class="hx-tool" id="hx-t-theme"><span class="ic">🌙</span>Tema Claro/Escuro</button>
  <button class="hx-tool" id="hx-t-focus"><span class="ic">🎯</span>Modo Foco</button>
  <button class="hx-tool" id="hx-t-share"><span class="ic">📲</span>Compartilhar App</button>
  <button class="hx-tool" id="hx-t-fminus"><span class="ic">🔡</span>Fonte A−</button>
  <button class="hx-tool" id="hx-t-fplus"><span class="ic">🔠</span>Fonte A+</button>
  <button class="hx-tool" data-sub="tips"><span class="ic">⌨️</span>Atalhos</button>
 </div>

 <div class="hx-sub" id="hx-sub-notes">
  <h4>📝 Bloco de Notas (salvo automaticamente)</h4>
  <textarea id="hx-notes" rows="7" placeholder="Anote contatos de empresas, senhas de portais, ideias..."></textarea>
  <button class="hx-btn sec" id="hx-notes-copy">Copiar tudo</button>
 </div>

 <div class="hx-sub" id="hx-sub-remind">
  <h4>⏰ Lembretes de Follow-up</h4>
  <input id="hx-r-text" placeholder="Ex: Reenviar e-mail para Ocean Resort"/>
  <input id="hx-r-date" type="date"/>
  <button class="hx-btn" id="hx-r-add">Adicionar lembrete</button>
  <div id="hx-r-list" style="margin-top:10px"></div>
 </div>

 <div class="hx-sub" id="hx-sub-clock">
  <h4>🇺🇸 Horário nos EUA agora (melhor janela para ligar/enviar: 9h–17h local)</h4>
  <div class="hx-clockrow" id="hx-clocks"></div>
 </div>

 <div class="hx-sub" id="hx-sub-calc">
  <h4>💵 Calculadora de Salário</h4>
  <input id="hx-c-wage" type="number" step="0.5" placeholder="Salário por hora em USD (ex: 15)"/>
  <input id="hx-c-hours" type="number" placeholder="Horas por semana (ex: 40)" value="40"/>
  <input id="hx-c-rate" type="number" step="0.01" placeholder="Cotação do dólar (ex: 5.40)"/>
  <button class="hx-btn" id="hx-c-go">Calcular</button>
  <div id="hx-c-out" style="margin-top:10px;font-size:13px;font-weight:700"></div>
 </div>

 <div class="hx-sub" id="hx-sub-backup">
  <h4>💾 Backup dos seus dados locais</h4>
  <p style="font-size:12px;opacity:.75;margin:4px 0 10px">Baixa notas, lembretes, rascunhos e preferências salvos neste aparelho. Útil ao trocar de celular.</p>
  <button class="hx-btn" id="hx-b-down">⬇️ Baixar backup (.json)</button>
  <div style="height:8px"></div>
  <input type="file" id="hx-b-file" accept=".json"/>
  <button class="hx-btn sec" id="hx-b-up">⬆️ Restaurar backup</button>
 </div>

 <div class="hx-sub" id="hx-sub-tips">
  <h4>⌨️ Atalhos de teclado</h4>
  <div style="font-size:13px;line-height:2">
   <b>1–3</b> troca de aba · <b>/</b> foca a busca · <b>T</b> alterna tema · <b>X</b> abre Extras · <b>ESC</b> fecha janelas · <b>duplo clique</b> na busca limpa o campo
  </div>
 </div>
</div>`;
document.body.appendChild(panel);
panel.addEventListener("click",e=>{ if(e.target===panel)closePanel(); });

function openPanel(){ panel.classList.add("open"); renderReminders(); renderClocks(); const n=$("#hx-notes"); n.value=LS("notes")||""; }
function closePanel(){ panel.classList.remove("open"); }
window.hxClose=closePanel;

/* sub-navegação */
$$("#hx-panel .hx-tool[data-sub]").forEach(b=>b.addEventListener("click",()=>{
  const id="hx-sub-"+b.dataset.sub;
  $$("#hx-panel .hx-sub").forEach(s=>s.classList.toggle("open",s.id===id&&!s.classList.contains("open")));
  const t=document.getElementById(id); if(t&&t.classList.contains("open"))t.scrollIntoView({behavior:"smooth",block:"nearest"});
}));

/* ═══ NOVA 1: Bloco de notas persistente ═══ */
$("#hx-notes").addEventListener("input",e=>LS("notes",e.target.value));
$("#hx-notes-copy").onclick=()=>{navigator.clipboard.writeText($("#hx-notes").value||"").then(()=>T("Notas copiadas ✅"));};

/* ═══ NOVA 2: Lembretes de follow-up com aviso ═══ */
function renderReminders(){
  const list=LS("reminders")||[]; const box=$("#hx-r-list"); box.innerHTML="";
  const today=new Date().toISOString().slice(0,10); let due=0;
  list.sort((a,b)=>(a.date||"").localeCompare(b.date||"")).forEach((r,i)=>{
    const isDue=r.date&&r.date<=today; if(isDue)due++;
    const d=document.createElement("div"); d.className="hx-item"+(isDue?" due":"");
    d.innerHTML=`<span style="flex:1">${isDue?"🔔 ":""}<b>${(r.date||"").split("-").reverse().join("/")}</b> — ${r.text.replace(/</g,"&lt;")}</span><button class="hx-btn sec" style="padding:4px 10px" data-i="${i}">✓</button>`;
    d.querySelector("button").onclick=()=>{const l=LS("reminders")||[];l.splice(i,1);LS("reminders",l);renderReminders();T("Lembrete concluído ✅");};
    box.appendChild(d);
  });
  if(!list.length)box.innerHTML="<div style='font-size:12px;opacity:.6'>Nenhum lembrete. Crie um para não esquecer de dar follow-up nas vagas!</div>";
  const badge=$("#hx-fab-badge"); badge.style.display=due?"flex":"none"; badge.textContent=due;
}
$("#hx-r-add").onclick=()=>{
  const t=$("#hx-r-text").value.trim(), d=$("#hx-r-date").value;
  if(!t){T("Escreva o lembrete","err");return;}
  const l=LS("reminders")||[]; l.push({text:t,date:d}); LS("reminders",l);
  $("#hx-r-text").value=""; renderReminders(); T("Lembrete criado ⏰");
};
setTimeout(renderReminders,2000); setInterval(renderReminders,120000);

/* ═══ NOVA 3: Relógio dos fusos dos EUA ═══ */
function renderClocks(){
  const zones=[["Nova York","America/New_York"],["Chicago","America/Chicago"],["Denver","America/Denver"],["Los Angeles","America/Los_Angeles"]];
  const box=$("#hx-clocks"); box.innerHTML="";
  zones.forEach(([n,z])=>{
    const t=new Intl.DateTimeFormat("pt-BR",{hour:"2-digit",minute:"2-digit",timeZone:z}).format(new Date());
    const h=+new Intl.DateTimeFormat("en",{hour:"numeric",hour12:false,timeZone:z}).format(new Date());
    const ok=h>=9&&h<17;
    box.insertAdjacentHTML("beforeend",`<div class="hx-clock"><b>${t}</b><span>${n} ${ok?"🟢":"🔴"}</span></div>`);
  });
}
setInterval(()=>{ if(panel.classList.contains("open"))renderClocks(); },30000);

/* ═══ NOVA 4: Calculadora USD→BRL ═══ */
$("#hx-c-go").onclick=()=>{
  const w=+$("#hx-c-wage").value, h=+$("#hx-c-hours").value||40, r=+$("#hx-c-rate").value;
  if(!w||!r){T("Preencha salário e cotação","err");return;}
  const week=w*h, month=week*4.33, ot=w*1.5;
  $("#hx-c-out").innerHTML=`Semana: <b>$${week.toFixed(0)}</b> (R$ ${(week*r).toFixed(0)})<br>Mês (~4,33 sem): <b>$${month.toFixed(0)}</b> (R$ ${(month*r).toFixed(0)})<br>Hora extra (1.5x): <b>$${ot.toFixed(2)}/h</b>`;
  LS("calcRate",r);
};
const savedRate=LS("calcRate"); if(savedRate)setTimeout(()=>{$("#hx-c-rate").value=savedRate;},500);

/* ═══ NOVA 6: Backup/restauração de dados locais ═══ */
$("#hx-b-down").onclick=()=>{
  const data={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);data[k]=localStorage.getItem(k);}
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="h2bapply-backup-"+new Date().toISOString().slice(0,10)+".json";a.click();
  T("Backup baixado 💾");
};
$("#hx-b-up").onclick=()=>{
  const f=$("#hx-b-file").files[0]; if(!f){T("Escolha o arquivo .json","err");return;}
  const rd=new FileReader();
  rd.onload=()=>{ try{ const d=JSON.parse(rd.result); Object.entries(d).forEach(([k,v])=>localStorage.setItem(k,v)); T("Backup restaurado ✅ Recarregando..."); setTimeout(()=>location.reload(),1200);}catch(e){T("Arquivo inválido","err");} };
  rd.readAsText(f);
};

/* ═══ NOVA 7: Tema pelo painel ═══ */
$("#hx-t-theme").onclick=toggleTheme;

/* ═══ NOVA 8: Modo foco ═══ */
$("#hx-t-focus").onclick=()=>{ document.body.classList.toggle("hx-focus"); const on=document.body.classList.contains("hx-focus"); LS("focus",on); T(on?"🎯 Modo foco ATIVADO":"Modo foco desativado"); };
if(LS("focus"))document.body.classList.add("hx-focus");

/* ═══ NOVA 9: Compartilhar app (WhatsApp / share nativo) ═══ */
$("#hx-t-share").onclick=()=>{
  const url=location.origin, txt="Estou usando o H2BApply para conseguir vagas H-2B nos EUA! 🇺🇸 "+url;
  if(navigator.share){navigator.share({title:"H2BApply",text:txt,url}).catch(()=>{});}
  else window.open("https://wa.me/?text="+encodeURIComponent(txt),"_blank","noopener");
};

/* ═══ NOVA 10: Controle de fonte A− / A+ ═══ */
$("#hx-t-fminus").onclick=()=>{const f=Math.max(85,(LS("fontScale")||100)-5);LS("fontScale",f);applyFont();T("Fonte: "+f+"%");};
$("#hx-t-fplus").onclick=()=>{const f=Math.min(130,(LS("fontScale")||100)+5);LS("fontScale",f);applyFont();T("Fonte: "+f+"%");};

/* ═══ NOVA 11: Aviso de lembrete vencido ao abrir o app ═══ */
setTimeout(()=>{
  const today=new Date().toISOString().slice(0,10);
  const due=(LS("reminders")||[]).filter(r=>r.date&&r.date<=today);
  if(due.length)T("🔔 Você tem "+due.length+" follow-up(s) pendente(s)! Toque em ✨","err");
},4000);


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
