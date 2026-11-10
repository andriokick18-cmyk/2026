/* H2BApply — tradutor do site inteiro (PT padrão · EN · ES).
   Carregado SÍNCRONO no <head> de todas as páginas públicas e do app. Lê o idioma escolhido (localStorage "h2b_lang"),
   baixa o catálogo /i18n/<lang>.json (texto em português → tradução) e traduz tudo: textos, placeholder/title/aria-label/alt,
   título da página, alert/confirm e TUDO que o JavaScript do site inserir depois (MutationObserver, antes de pintar).
   Regra de número: sequências de dígitos viram {#} na chave e voltam na ordem. Sem tradução = fica em português (nunca quebra). */
(function () {
  "use strict";
  var KEY = "h2b_lang", LANGS = ["pt", "en", "es"], lang = "pt";
  try {
    var q = /[?&]lang=(pt|en|es)\b/.exec(location.search);
    if (q) {
      localStorage.setItem(KEY, q[1]);
      // o parâmetro vale UMA vez: sai da URL, senão ele sobrescreveria o botão de idioma a cada recarga
      try { var u = location.search.replace(/([?&])lang=(pt|en|es)\b&?/, "$1").replace(/[?&]$/, ""); history.replaceState(null, "", location.pathname + u + location.hash); } catch (e2) {}
    }
    var s = localStorage.getItem(KEY); if (LANGS.indexOf(s) >= 0) lang = s;
  } catch (e) {}
  window.H2B_LANG = lang;
  window.H2B_LOCALE = { pt: "pt-BR", en: "en-US", es: "es-419" }[lang]; // locale para Intl/toLocale*String (horas 12h nos EUA)
  document.documentElement.lang = lang === "pt" ? "pt-BR" : lang;
  var NAMES = { pt: "Português", en: "English", es: "Español" }, FLAG = { pt: "🇧🇷", en: "🇺🇸", es: "🌎" };

  function setLang(l) {
    try { localStorage.setItem(KEY, l); } catch (e) {}
    try { fetch("/api/settings", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: l }) }).catch(function () {}); } catch (e) {}
    location.reload();
  }
  window.H2B_setLang = setLang;

  function pill() {
    if (document.getElementById("h2b-lang")) return;
    var st = document.createElement("style");
    st.textContent = "#h2b-lang{position:fixed;right:12px;bottom:86px;z-index:99990;font:600 13px/1 system-ui,sans-serif}@media(min-width:900px){#h2b-lang{bottom:16px}}" +
      "#h2b-lang button.h2b-lb{display:flex;align-items:center;gap:6px;padding:9px 12px;border-radius:999px;border:1px solid rgba(0,0,0,.25);background:#fff;color:#111;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer}" +
      "#h2b-lang .h2b-lm{display:none;position:absolute;right:0;bottom:44px;background:#fff;color:#111;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden;min-width:150px}" +
      "#h2b-lang.open .h2b-lm{display:block}#h2b-lang .h2b-lm button{display:block;width:100%;text-align:left;padding:11px 14px;border:0;background:none;color:#111;font:inherit;cursor:pointer}" +
      "#h2b-lang .h2b-lm button:hover,#h2b-lang .h2b-lm button.on{background:#eef2ff}html.i18n-wait body{visibility:hidden}";
    document.head.appendChild(st);
    var d = document.createElement("div"); d.id = "h2b-lang"; d.setAttribute("translate", "no");
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "h2b-lb"; btn.setAttribute("aria-label", "Language / Idioma / Idioma");
    btn.innerHTML = "🌐 " + lang.toUpperCase() + " ▾";
    var menu = document.createElement("div"); menu.className = "h2b-lm";
    LANGS.forEach(function (l) { var b = document.createElement("button"); b.type = "button"; if (l === lang) b.className = "on"; b.textContent = FLAG[l] + "  " + NAMES[l]; b.onclick = function () { if (l === lang) { d.classList.remove("open"); return; } setLang(l); }; menu.appendChild(b); });
    btn.onclick = function (e) { e.stopPropagation(); d.classList.toggle("open"); };
    document.addEventListener("click", function () { d.classList.remove("open"); });
    d.appendChild(btn); d.appendChild(menu); document.body.appendChild(d);
  }

  var cat = null, SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 }, ATTRS = ["placeholder", "title", "aria-label", "alt"];
  var wild = null, wcache = {}, wn = 0;
  function buildWild() {
    wild = [];
    Object.keys(cat).forEach(function (k) {
      if (k.indexOf("{*}") < 0) return;
      var types = [], re = k.split(/(\{\*\}|\{#\})/).map(function (p) {
        if (p === "{*}") { types.push(p); return "(.+?)"; }
        if (p === "{#}") { types.push(p); return "(\\d+(?:[.,]\\d+)*)"; }
        return p.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
      }).join("");
      var anchor = ""; k.split(/\{\*\}|\{#\}/).forEach(function (p) { if (p.trim().length > anchor.length) anchor = p.trim(); });
      try { wild.push({ re: new RegExp("^" + re + "$"), anchor: anchor, types: types, t: cat[k] }); } catch (e) {}
    });
    wild.sort(function (a, b) { return b.anchor.length - a.anchor.length; });
  }
  function trWild(core) {
    if (wild === null) buildWild();
    if (!wild.length) return undefined;
    if (wcache[core] !== undefined) return wcache[core] || undefined;
    var out = false;
    for (var i = 0; i < wild.length; i++) {
      var w = wild[i]; if (w.anchor && core.indexOf(w.anchor) < 0) continue;
      var m = w.re.exec(core); if (!m) continue;
      var st = [], nm = [];
      w.types.forEach(function (ty, gi) { if (ty === "{*}") st.push(tr(m[gi + 1])); else nm.push(m[gi + 1]); });
      var si = 0, ni = 0;
      out = w.t.replace(/\{\*\}|\{#\}/g, function (x) { return x === "{*}" ? (st[si] !== undefined ? st[si++] : "") : (nm[ni] !== undefined ? nm[ni++] : ""); });
      break;
    }
    if (wn++ > 4000) { wcache = {}; wn = 0; }
    wcache[core] = out;
    return out || undefined;
  }
  // Texto = [prefixo sem letras: "2. ", "🔎 ", "• "] + frase + [sufixo sem letras]: traduz só a frase e recoloca o resto.
  function tr(raw) {
    var r = trCore(raw); if (r !== raw || typeof raw !== "string" || !cat) return r;
    var core = raw.trim(), m = /^([^A-Za-zÀ-ÿ]+)([A-Za-zÀ-ÿ][\s\S]*[A-Za-zÀ-ÿ?!.:)])([^A-Za-zÀ-ÿ]*)$/.exec(core);
    if (m && m[2] !== core) { var inner = trCore(m[2]); if (inner !== m[2]) return raw.slice(0, raw.indexOf(core)) + m[1] + inner + m[3] + raw.slice(raw.indexOf(core) + core.length); }
    return raw;
  }
  function trCore(raw) {
    if (!cat || typeof raw !== "string") return raw;
    var core = raw.trim(); if (!core || core.length > 2600) return raw;
    var nums = [], key = core.replace(/\s+/g, " ").replace(/\d+(?:[.,]\d+)*/g, function (m) { nums.push(m); return "{#}"; });
    var t = cat[key];
    if (t === undefined) {
      var w = trWild(core.replace(/\s+/g, " "));
      if (w === undefined) return raw;
      return raw.slice(0, raw.indexOf(core)) + w + raw.slice(raw.indexOf(core) + core.length);
    }
    var i = 0; t = t.replace(/\{#\}/g, function () { return nums[i] !== undefined ? nums[i++] : ""; });
    return raw.slice(0, raw.indexOf(core)) + t + raw.slice(raw.indexOf(core) + core.length);
  }
  // ── Formato regional: o site gera datas/números no padrão BRASILEIRO; em EN/ES converte para o padrão do idioma escolhido ──
  //   EN: 12/25/2026 · December 25, 2026 · 9,240 · R$ 300.00      ES: 25/12/2026 · 25 de diciembre de 2026 · 9.240 · R$ 300,00
  var PT_MES = { janeiro: 1, fevereiro: 2, "março": 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
  var PT_ABR = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  var EN_M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var EN_A = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var ES_M = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  var ES_A = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  var RE_MES = "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";
  function mesNome(i) { return lang === "en" ? EN_M[i - 1] : ES_M[i - 1]; }
  function loc(t) {
    if (lang === "pt" || typeof t !== "string" || t.length < 3) return t;
    if (!/\d/.test(t) && !new RegExp("(" + RE_MES + ")", "i").test(t)) return t;
    // texto de vaga/descrição do DOL já vem em inglês com datas e números dos EUA: não mexe
    if ((t.match(/\b(the|and|will|you|of|to|for|is|are|with|have|must)\b/gi) || []).length >= 3) return t;
    var r = t;
    // "25 de dezembro de 2026" / "25 de dezembro"
    r = r.replace(new RegExp("\\b(\\d{1,2}) de (" + RE_MES + ")(?: de (\\d{4}))?", "gi"), function (m, d, mes, y) {
      var i = PT_MES[mes.toLowerCase().replace("ç", "ç")] || PT_MES[mes.toLowerCase().replace("ç", "c")]; if (!i) return m;
      return lang === "en" ? mesNome(i) + " " + (+d) + (y ? ", " + y : "") : (+d) + " de " + mesNome(i) + (y ? " de " + y : "");
    });
    // "9 de nov." / "9 de nov"
    r = r.replace(/\b(\d{1,2}) de (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b\.?/gi, function (m, d, ab) {
      var i = PT_ABR[ab.toLowerCase()]; return lang === "en" ? EN_A[i - 1] + " " + (+d) : (+d) + " " + ES_A[i - 1];
    });
    // mês por extenso sozinho ("em dezembro", "janeiro de 2027")
    r = r.replace(new RegExp("\\b(" + RE_MES + ")( de (\\d{4}))?\\b", "gi"), function (m, mes, rest, y) {
      var i = PT_MES[mes.toLowerCase()] || PT_MES[mes.toLowerCase().replace("ç", "c")]; if (!i) return m;
      return lang === "en" ? mesNome(i) + (y ? " " + y : "") : mesNome(i) + (y ? " de " + y : "");
    });
    if (lang === "en") {
      // datas dd/mm/aaaa (padrão BR) → mm/dd/aaaa; se o 2º número passa de 12 já está no padrão dos EUA
      r = r.replace(/(^|[^\d\/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d\/])/g, function (m, p, a, b, y) { return (+b > 12 || +a > 31) ? m : p + b + "/" + a + "/" + y; });
      // dinheiro: R$ 1.234,50 → R$ 1,234.50 ; R$ 300,00 → R$ 300.00
      r = r.replace(/(R\$|US\$)\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?(?![\d,])/g, function (m, cur, int, dec) { return cur + " " + int.replace(/\./g, ",") + (dec ? "." + dec : ""); });
      // milhar com ponto: 9.240 → 9,240 (não mexe em telefone 555.123.4567 nem versão 1.2.3)
      r = r.replace(/(^|[^\d.,])(\d{1,3}(?:\.\d{3})+)(,\d+)?(?![\d.])/g, function (m, p, n, dec) { return p + n.replace(/\./g, ",") + (dec ? "." + dec.slice(1) : ""); });
      // percentual/hora com vírgula decimal: 12,5% → 12.5%
      r = r.replace(/(\d),(\d{1,2})(?=\s?%)/g, "$1.$2");
    }
    return r;
  }
  window.H2B_loc = loc;
  function okEl(el) { for (var n = el; n && n.nodeType === 1; n = n.parentNode) { if (SKIP[n.tagName] || n.hasAttribute("translate") && n.getAttribute("translate") === "no" || n.isContentEditable) return false; } return true; }
  function doText(n) { if (n.__i18n === n.nodeValue) return; var v = loc(tr(n.nodeValue)); if (v !== n.nodeValue) { n.nodeValue = v; } n.__i18n = n.nodeValue; }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) { var a = ATTRS[i]; if (el.hasAttribute && el.hasAttribute(a)) { var o = el.getAttribute(a), v = loc(tr(o)); if (v !== o) el.setAttribute(a, v); } }
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type || "") && el.value) { var vv = tr(el.value); if (vv !== el.value) el.value = vv; }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (root.parentNode && okEl(root.parentNode)) doText(root); return; }
    if (root.nodeType !== 1 || !okEl(root)) return;
    doAttrs(root);
    var w = document.createTreeWalker(root, 5, { acceptNode: function (n) { if (n.nodeType === 1) return SKIP[n.tagName] ? 2 : 1; return 1; } }), n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) { if (okEl(n.parentNode)) doText(n); } else doAttrs(n); }
  }
  function head() {
    var t = tr(document.title); if (t !== document.title) document.title = t;
    var m = document.querySelector('meta[name="description"]'); if (m) { var c = m.getAttribute("content"), v = tr(c); if (v !== c) m.setAttribute("content", v); }
  }
  function start() {
    walk(document.body); head();
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === "childList") { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
        else if (m.type === "characterData") { if (m.target.parentNode && okEl(m.target.parentNode)) doText(m.target); }
        else if (m.type === "attributes") { if (okEl(m.target)) doAttrs(m.target); }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    ["alert", "confirm", "prompt"].forEach(function (f) { var o = window[f]; window[f] = function (m, d) { return o.call(window, loc(tr(String(m))), d); }; });
  }
  window.H2B_tr = tr;

  function boot() {
    pill();
    if (lang === "pt") return;
    var shown = false, reveal = function () { if (shown) return; shown = true; document.documentElement.classList.remove("i18n-wait"); };
    document.documentElement.classList.add("i18n-wait");
    setTimeout(reveal, 2500); // nunca deixa a tela escondida se o catálogo falhar
    fetch("/i18n/" + lang + ".json", { credentials: "omit" }).then(function (r) { return r.json(); }).then(function (c) { cat = c; start(); reveal(); }).catch(reveal);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
