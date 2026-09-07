/* ═══════════════════════════════════════════════════════════════
   H2BApply ADMIN EXTRAS v1.0 — Camada de melhorias (painel admin)
   Autocontido. 10 melhorias + 10 novas ferramentas para TODAS as views
   (Dashboard, Usuários, Pedidos, Pagantes, VIP, Planilhas, Ranking,
   Incidentes, Sugestões, Notificações, Códigos, Robô Contábil, etc.)
   ═══════════════════════════════════════════════════════════════ */
(function(){
"use strict";
const LS=(k,v)=>{ if(v===undefined){try{return JSON.parse(localStorage.getItem("hxa_"+k));}catch(e){return null;}} localStorage.setItem("hxa_"+k,JSON.stringify(v)); };
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const T=(m,t)=>{ try{ if(typeof toast==="function"){toast(m,t||"ok");return;} }catch(e){} console.log(m); };

const css=document.createElement("style");
css.textContent=`
#hxa-bar{position:fixed;top:8px;right:10px;z-index:9700;display:flex;gap:6px;align-items:center;background:rgba(15,23,42,.85);backdrop-filter:blur(6px);border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:5px 8px;color:#e2e8f0;font-size:12px}
#hxa-bar button{background:rgba(99,102,241,.25);border:1px solid rgba(99,102,241,.4);color:#c7d2fe;border-radius:8px;padding:4px 8px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit}
#hxa-bar button:hover{background:rgba(99,102,241,.45)}
#hxa-clock{font-weight:800;font-variant-numeric:tabular-nums}
#hxa-search-wrap{position:fixed;top:52px;right:10px;z-index:9700;display:none}
#hxa-search{width:260px;padding:9px 12px;border-radius:10px;border:1px solid rgba(99,102,241,.5);background:#0f172a;color:#fff;font-size:13px;font-family:inherit;box-shadow:0 8px 30px rgba(0,0,0,.4)}
#hxa-count{position:fixed;top:96px;right:10px;z-index:9700;background:#0f172a;color:#94a3b8;font-size:11px;font-weight:700;padding:3px 10px;border-radius:8px;display:none;border:1px solid rgba(148,163,184,.25)}
#hxa-panel{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9800;display:none;align-items:center;justify-content:center}
#hxa-panel.open{display:flex}
#hxa-modal{background:#111827;color:#e5e7eb;border:1px solid rgba(148,163,184,.25);border-radius:16px;width:min(560px,94vw);max-height:84vh;overflow:auto;padding:18px}
#hxa-modal h3{margin:0 0 10px;font-size:16px}
#hxa-modal textarea,#hxa-modal input{width:100%;box-sizing:border-box;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:9px;padding:9px;font:inherit;font-size:13px;margin-bottom:8px}
.hxa-btn{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:9px;padding:8px 14px;font-weight:800;font-size:12px;cursor:pointer;font-family:inherit}
.hxa-btn.sec{background:#374151}
.hxa-todo{display:flex;gap:8px;align-items:center;background:#1f2937;border:1px solid #374151;border-radius:9px;padding:8px 10px;margin-bottom:6px;font-size:13px}
.hxa-todo.done span{text-decoration:line-through;opacity:.5}
body.hxa-compact table td,body.hxa-compact table th{padding-top:3px!important;padding-bottom:3px!important;font-size:12px!important}
body.hxa-zebra tbody tr:nth-child(even){background:rgba(99,102,241,.06)!important}
th.hxa-sortable{cursor:pointer;user-select:none}
th.hxa-sortable:hover{text-decoration:underline}
@media print{ #hxa-bar,#hxa-search-wrap,#hxa-count,#hxa-panel{display:none!important} }
`;
document.head.appendChild(css);

/* ═══ Barra fixa de ferramentas admin ═══ */
const bar=document.createElement("div");
bar.id="hxa-bar";
bar.innerHTML=`<span id="hxa-clock">--:--</span>
<button id="hxa-b-search" title="Filtrar tabela visível (/)">🔍</button>
<button id="hxa-b-csv" title="Exportar tabela visível p/ CSV">CSV</button>
<button id="hxa-b-json" title="Exportar tabela visível p/ JSON">JSON</button>
<button id="hxa-b-print" title="Imprimir view atual">🖨️</button>
<button id="hxa-b-refresh" title="Atualização automática">⟳ <span id="hxa-ar">off</span></button>
<button id="hxa-b-sentinel" title="Relatório de saúde (Health Sentinel)">🩺</button>
<button id="hxa-b-more" title="Mais ferramentas">⚙️</button>`;
document.body.appendChild(bar);

/* ═══ MELHORIA 1: Relógio + tempo de sessão ═══ */
const t0=Date.now();
setInterval(()=>{
  const now=new Date();
  const mins=Math.floor((Date.now()-t0)/60000);
  $("#hxa-clock").textContent=now.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})+" · "+mins+"min";
},5000);

/* helpers de tabela */
function visibleTable(){
  return $$("table").find(t=>t.offsetParent!==null && t.rows.length>1) || $$("table").find(t=>t.offsetParent!==null);
}
function tableToRows(t){
  return Array.from(t.rows).map(r=>Array.from(r.cells).map(c=>c.innerText.trim().replace(/\s+/g," ")));
}

/* ═══ NOVA 1: Filtro rápido em qualquer tabela visível ═══ */
const sw=document.createElement("div"); sw.id="hxa-search-wrap";
sw.innerHTML=`<input id="hxa-search" placeholder="Filtrar linhas da tabela visível... (ESC fecha)"/>`;
document.body.appendChild(sw);
const cnt=document.createElement("div"); cnt.id="hxa-count"; document.body.appendChild(cnt);
function openSearch(){ sw.style.display="block"; $("#hxa-search").focus(); }
$("#hxa-b-search").onclick=openSearch;
$("#hxa-search").addEventListener("input",e=>{
  const q=e.target.value.toLowerCase(); const t=visibleTable(); if(!t)return;
  let shown=0,total=0;
  Array.from(t.tBodies[0]?.rows||[]).forEach(r=>{ total++;
    const ok=!q||r.innerText.toLowerCase().includes(q);
    r.style.display=ok?"":"none"; if(ok)shown++;
  });
  cnt.style.display="block"; cnt.textContent=shown+" / "+total+" linhas";
});
$("#hxa-search").addEventListener("keydown",e=>{ if(e.key==="Escape"){e.target.value="";e.target.dispatchEvent(new Event("input"));sw.style.display="none";cnt.style.display="none";} });

/* ═══ NOVA 2 & 3: Exportar tabela p/ CSV e JSON ═══ */
function download(name,content,mime){
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type:mime}));a.download=name;a.click();
}
$("#hxa-b-csv").onclick=()=>{
  const t=visibleTable(); if(!t){T("Nenhuma tabela visível","err");return;}
  const rows=tableToRows(t).map(r=>r.map(c=>'"'+c.replace(/"/g,'""')+'"').join(";")).join("\n");
  download("h2b-admin-"+Date.now()+".csv","\ufeff"+rows,"text/csv");T("CSV exportado ✅");
};
$("#hxa-b-json").onclick=()=>{
  const t=visibleTable(); if(!t){T("Nenhuma tabela visível","err");return;}
  const rows=tableToRows(t); const head=rows[0]||[];
  const objs=rows.slice(1).map(r=>Object.fromEntries(head.map((h,i)=>[h||("col"+i),r[i]||""])));
  download("h2b-admin-"+Date.now()+".json",JSON.stringify(objs,null,2),"application/json");T("JSON exportado ✅");
};

/* ═══ NOVA 4: Impressão limpa ═══ */
$("#hxa-b-print").onclick=()=>window.print();

/* ═══ NOVA 5: Auto-refresh da view atual ═══ */
let arTimer=null;
$("#hxa-b-refresh").onclick=()=>{
  if(arTimer){clearInterval(arTimer);arTimer=null;$("#hxa-ar").textContent="off";T("Auto-refresh desligado");return;}
  arTimer=setInterval(()=>{
    const active=$$(".nav-item.active,[class*='nav'] .active,.sidebar .active").find(x=>x.onclick||x.getAttribute("onclick"));
    if(active)active.click();
  },60000);
  $("#hxa-ar").textContent="60s"; T("Auto-refresh a cada 60s ligado ⟳");
};

/* ═══ MELHORIA 2: Ordenação clicável nos cabeçalhos ═══ */
document.addEventListener("click",e=>{
  const th=e.target.closest("th"); if(!th)return;
  const table=th.closest("table"); if(!table||!table.tBodies[0])return;
  if(!th.classList.contains("hxa-sortable"))return;
  const idx=Array.from(th.parentNode.children).indexOf(th);
  const dir=th.dataset.dir==="asc"?"desc":"asc"; th.dataset.dir=dir;
  const rows=Array.from(table.tBodies[0].rows);
  rows.sort((a,b)=>{
    const A=(a.cells[idx]?.innerText||"").trim(), B=(b.cells[idx]?.innerText||"").trim();
    const nA=parseFloat(A.replace(/[^\d.,-]/g,"").replace(",", ".")), nB=parseFloat(B.replace(/[^\d.,-]/g,"").replace(",","."));
    let r=(!isNaN(nA)&&!isNaN(nB))?nA-nB:A.localeCompare(B,"pt-BR");
    return dir==="asc"?r:-r;
  });
  rows.forEach(r=>table.tBodies[0].appendChild(r));
  T("Ordenado por: "+th.innerText.trim()+" ("+dir+")");
});
setInterval(()=>{ $$("table th").forEach(th=>th.classList.add("hxa-sortable")); },3000);

/* ═══ MELHORIA 3: Duplo clique em célula copia o conteúdo ═══ */
document.addEventListener("dblclick",e=>{
  const td=e.target.closest("td"); if(!td)return;
  const txt=td.innerText.trim(); if(!txt)return;
  navigator.clipboard.writeText(txt).then(()=>T("Copiado: "+(txt.length>40?txt.slice(0,40)+"…":txt)));
});

/* ═══ MELHORIA 4: ESC fecha modais visíveis ═══ */
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  const p=$("#hxa-panel"); if(p&&p.classList.contains("open")){p.classList.remove("open");return;}
  $$("[id*='modal'],[class*='modal'],[id$='-overlay']").forEach(m=>{
    if(m.offsetParent!==null && getComputedStyle(m).position==="fixed"){
      const btn=m.querySelector("[onclick*='close'],[onclick*='Close'],[onclick*='fechar']");
      if(btn)btn.click();
    }
  });
});

/* ═══ MELHORIA 5: Atalho "/" abre filtro, "r" atualiza ═══ */
document.addEventListener("keydown",e=>{
  if(["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName))return;
  if(e.key==="/"){e.preventDefault();openSearch();}
  if(e.key.toLowerCase()==="r"&&!e.ctrlKey&&!e.metaKey){const a=$$(".nav-item.active,.sidebar .active")[0];if(a){a.click();T("View atualizada ⟳");}}
});

/* ═══ MELHORIA 6: Offline indicator ═══ */
window.addEventListener("offline",()=>{bar.style.borderColor="#ef4444";bar.style.boxShadow="0 0 0 2px rgba(239,68,68,.5)";T("📡 Sem conexão!","err");});
window.addEventListener("online",()=>{bar.style.borderColor="rgba(148,163,184,.25)";bar.style.boxShadow="none";T("Conexão OK ✅");});

/* ═══ Painel "Mais ferramentas" ═══ */
const panel=document.createElement("div"); panel.id="hxa-panel";
panel.innerHTML=`<div id="hxa-modal">
 <div style="display:flex;justify-content:space-between;align-items:center"><h3>⚙️ Ferramentas Admin</h3><button class="hxa-btn sec" id="hxa-close">Fechar</button></div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
  <button class="hxa-btn" id="hxa-t-compact">📏 Modo compacto</button>
  <button class="hxa-btn" id="hxa-t-zebra">🦓 Listras nas tabelas</button>
  <button class="hxa-btn" id="hxa-t-backup">💾 Backup localStorage</button>
  <button class="hxa-btn" id="hxa-t-clearfilters">🧹 Limpar filtros</button>
 </div>
 <h3 style="font-size:14px">📝 Notas do Admin (auto-salvas)</h3>
 <textarea id="hxa-notes" rows="4" placeholder="Anotações internas, pendências, contatos..."></textarea>
 <h3 style="font-size:14px;margin-top:12px">✅ Tarefas do Admin</h3>
 <div style="display:flex;gap:6px"><input id="hxa-todo-in" placeholder="Nova tarefa... (Enter)"/><button class="hxa-btn" id="hxa-todo-add">+</button></div>
 <div id="hxa-todo-list" style="margin-top:8px"></div>
</div>`;
document.body.appendChild(panel);
panel.addEventListener("click",e=>{if(e.target===panel)panel.classList.remove("open");});
$("#hxa-close").onclick=()=>panel.classList.remove("open");
$("#hxa-b-more").onclick=()=>{panel.classList.add("open");$("#hxa-notes").value=LS("notes")||"";renderTodos();};

/* ═══ NOVA 6: Modo compacto (densidade de tabela) ═══ */
$("#hxa-t-compact").onclick=()=>{document.body.classList.toggle("hxa-compact");LS("compact",document.body.classList.contains("hxa-compact"));T("Densidade alterada");};
if(LS("compact"))document.body.classList.add("hxa-compact");

/* ═══ NOVA 7: Zebra striping ═══ */
$("#hxa-t-zebra").onclick=()=>{document.body.classList.toggle("hxa-zebra");LS("zebra",document.body.classList.contains("hxa-zebra"));T("Listras alternadas alternadas 🦓");};
if(LS("zebra"))document.body.classList.add("hxa-zebra");

/* ═══ NOVA 8: Backup do localStorage do admin ═══ */
$("#hxa-t-backup").onclick=()=>{
  const d={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);d[k]=localStorage.getItem(k);}
  download("h2b-admin-backup-"+new Date().toISOString().slice(0,10)+".json",JSON.stringify(d,null,2),"application/json");
  T("Backup do painel baixado 💾");
};

/* ═══ NOVA 9: Limpar todos os filtros de tabela ═══ */
$("#hxa-t-clearfilters").onclick=()=>{
  $$("table tbody tr").forEach(r=>r.style.display="");
  const s=$("#hxa-search"); if(s){s.value="";} cnt.style.display="none"; sw.style.display="none";
  T("Filtros limpos 🧹");
};

/* ═══ NOVA 10: Notas + tarefas persistentes do admin ═══ */
$("#hxa-notes").addEventListener("input",e=>LS("notes",e.target.value));
function renderTodos(){
  const l=LS("todos")||[]; const box=$("#hxa-todo-list"); box.innerHTML="";
  l.forEach((t,i)=>{
    const d=document.createElement("div"); d.className="hxa-todo"+(t.done?" done":"");
    d.innerHTML=`<input type="checkbox" ${t.done?"checked":""}/><span style="flex:1">${t.text.replace(/</g,"&lt;")}</span><button class="hxa-btn sec" style="padding:3px 8px">✕</button>`;
    d.querySelector("input").onchange=e2=>{const L=LS("todos");L[i].done=e2.target.checked;LS("todos",L);renderTodos();};
    d.querySelector("button").onclick=()=>{const L=LS("todos");L.splice(i,1);LS("todos",L);renderTodos();};
    box.appendChild(d);
  });
  if(!l.length)box.innerHTML="<div style='font-size:12px;opacity:.5'>Nenhuma tarefa.</div>";
}
function addTodo(){
  const v=$("#hxa-todo-in").value.trim(); if(!v)return;
  const l=LS("todos")||[]; l.push({text:v,done:false}); LS("todos",l);
  $("#hxa-todo-in").value=""; renderTodos();
}
$("#hxa-todo-add").onclick=addTodo;
$("#hxa-todo-in").addEventListener("keydown",e=>{if(e.key==="Enter")addTodo();});

/* ═══ MELHORIAS 7-10: rel seguro em links, persistência da view,
       realce de hover em linhas, aviso de tarefas pendentes ═══ */
setInterval(()=>{ $$("a[target='_blank']:not([rel])").forEach(a=>a.rel="noopener noreferrer"); },5000);
const hoverCss=document.createElement("style");
hoverCss.textContent="tbody tr:hover{background:rgba(99,102,241,.10)!important;transition:background .1s}";
document.head.appendChild(hoverCss);
setTimeout(()=>{ const l=(LS("todos")||[]).filter(t=>!t.done); if(l.length)T("✅ Você tem "+l.length+" tarefa(s) admin pendente(s) — clique em ⚙️"); },3500);

/* ═══ NOVA 11: 🩺 Health Sentinel — relatório de saúde ao vivo ═══ */
const sPanel=document.createElement("div"); sPanel.id="hxa-panel-s"; sPanel.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9800;display:none;align-items:center;justify-content:center";
sPanel.innerHTML=`<div id="hxa-modal" style="width:min(680px,94vw)">
 <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
  <h3>🩺 Health Sentinel</h3>
  <div style="display:flex;gap:6px">
   <button class="hxa-btn" id="hxa-s-run">▶️ Rodar agora</button>
   <button class="hxa-btn sec" id="hxa-s-close">Fechar</button>
  </div>
 </div>
 <div id="hxa-s-body" style="font-size:13px;line-height:1.6;margin-top:10px">Carregando...</div>
</div>`;
document.body.appendChild(sPanel);
sPanel.addEventListener("click",e=>{if(e.target===sPanel)sPanel.style.display="none";});
$("#hxa-s-close").onclick=()=>sPanel.style.display="none";
function renderSentinel(r){
  const li=(a,f)=>a&&a.length?("<ul style='margin:4px 0;padding-left:18px'>"+a.slice(0,15).map(f).join("")+(a.length>15?`<li>… +${a.length-15}</li>`:"")+"</ul>"):" <b style='color:#4ade80'>nenhum ✅</b>";
  const tokenBlock = r.adminToken
    ? (r.adminToken.ok
        ? `<div style="background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.4);border-radius:9px;padding:7px 10px;margin:8px 0;font-size:12px">🔑 Token do admin: <b style="color:#4ade80">OK</b> (via ${r.adminToken.via}) — notificações do sistema funcionando</div>`
        : `<div style="background:rgba(239,68,68,.15);border:1.5px solid #ef4444;border-radius:9px;padding:8px 10px;margin:8px 0;font-size:12.5px">🚨 <b style="color:#f87171">TOKEN DO ADMIN QUEBRADO</b> — TODAS as notificações do sistema estão mudas!<br><span style="opacity:.8">${r.adminToken.error||""} → Faça login no app com a conta admin para restaurar.</span></div>`)
    : "";
  const sheetsBlock = (r.planilhas&&r.planilhas.length)
    ? `<p><b>📋 Planilhas de vagas</b><ul style='margin:4px 0;padding-left:18px'>${r.planilhas.map(p=>`<li>${p.planilha}: ${p.comEmail}/${p.vagas} com e-mail (${p.pct}%) · enriquecida ${p.ultimoEnriquecimento}${p.alerta?` <b style='color:#fbbf24'>${p.alerta}</b>`:" ✅"}</li>`).join("")}</ul></p>` : "";
  const finBlock = `<p><b>🔄 Filas concluídas há >3 dias (${(r.finishedIdle||[]).length})</b> — candidatos a recarregar${li(r.finishedIdle,x=>`<li>${x.email} · concluído ${x.desde} · visto há ${x.diasInativo}d</li>`)}</p>`;
  $("#hxa-s-body").innerHTML=`
   <div style="opacity:.7;font-size:11px">Última varredura: ${r.lastRun?new Date(r.lastRun).toLocaleString("pt-BR"):"—"} · execuções: ${r.runs||0}</div>
   ${tokenBlock}${sheetsBlock}${finBlock}
   <p><b>⚠️ VIP ativo com robô parado (${(r.vipDesync||[]).length})</b>${li(r.vipDesync,x=>`<li>${x.email} — ${x.status} · token ${x.tokenOk?"✅":"❌"} · ${x.diasRestantes}d de VIP</li>`)}</p>
   <p><b>⏳ VIP expirando em ≤3 dias (${(r.vipExpiring||[]).length})</b>${li(r.vipExpiring,x=>`<li>${x.email} — expira ${x.expiraEm} (${x.plano})</li>`)}</p>
   <p><b>💳 Pedidos pendentes >6h (${(r.pedidosPendentes||[]).length})</b>${li(r.pedidosPendentes,x=>`<li>${x.email} — ${x.plano} R$${x.valor||"?"} · ${x.horasPendente}h</li>`)}</p>
   <p><b>📄 VIPs ativos sem CV (${(r.vipsSemCv||[]).length})</b>${li(r.vipsSemCv,x=>`<li>${x.email} (${x.plano})</li>`)}</p>
   <p><b>🧑‍💼 VIPs ativos sem PERFIL de currículo (${(r.vipsSemPerfil||[]).length})</b> — pagam mas o robô não consegue trabalhar${li(r.vipsSemPerfil,x=>`<li>${x.email} (${x.plano})</li>`)}</p>
   <p><b>🔒 Jobs presos em paused_no_vip (${(r.pausedNoVip||[]).length})</b> — decidir caso a caso${(r.pausedNoVip||[]).length?"<ul style='margin:4px 0;padding-left:18px'>"+r.pausedNoVip.slice(0,15).map(x=>`<li>${x.email} · desde ${x.desde} · fila ${x.fila} <button class='hxa-btn sec' style='padding:2px 8px;font-size:10px' onclick=\"fetch('/api/admin/health-sentinel/release-no-vip',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${x.email}'})}).then(r=>r.json()).then(d=>alert(d.ok?'Liberado! Status agora: inativo (usuário pode reativar)':'Erro: '+(d.error||'')))\">🔓 Liberar</button></li>`).join("")+"</ul>":" <b style='color:#4ade80'>nenhum ✅</b>"}</p>
   <p><b>🧹 Fila sanitizada:</b> ${r.filaSanitizada?.removidos||0} itens inválidos/duplicados removidos no total${r.filaSanitizada?.ultimaLimpeza?" · última limpeza "+new Date(r.filaSanitizada.ultimaLimpeza).toLocaleString("pt-BR"):""}</p>
   <p><b>📧 Notificações enviadas na última varredura:</b> ${(r.notificados||[]).length}</p>`;
}
async function loadSentinel(run){
  sPanel.style.display="flex"; $("#hxa-s-body").textContent=run?"Executando varredura...":"Carregando...";
  try{
    const res=await fetch(run?"/api/admin/health-sentinel/run":"/api/admin/health-sentinel",{method:run?"POST":"GET",credentials:"include"});
    const d=await res.json();
    if(!d.ok){$("#hxa-s-body").textContent="Erro: "+(d.error||res.status);return;}
    renderSentinel(d.report||{});
  }catch(e){$("#hxa-s-body").textContent="Falha ao consultar o servidor: "+e.message;}
}
$("#hxa-b-sentinel").onclick=()=>loadSentinel(false);
$("#hxa-s-run").onclick=()=>loadSentinel(true);

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

console.log("[H2B Admin Extras] Camada de melhorias do admin carregada ✅");
})();
