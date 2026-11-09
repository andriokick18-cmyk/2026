#!/usr/bin/env node
/* Extrator de textos traduzíveis do H2BApply (dev tool, roda local).
   Uso:  node tools/i18n-extract.js            → relatório de cobertura
         node tools/i18n-extract.js --chunks   → grava i18n/todo/chunk-NNN.json com o que falta traduzir
   Normalização (a MESMA do runtime em i18n.js): espaços colapsados; sequências de dígitos viram {#}. */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const HTML_FILES = ["index.html","tutorial-conteudo.html","aprenda-conteudo.html","guia.html","como-usar.html","empresas-que-patrocinam-visto-h2b.html","h2b-e-golpe.html","h2bapply-funciona.html","quanto-custa-o-visto-h2b.html","quanto-ganha-h2b.html"];
const JS_FILES = ["app.js","h2b-extras-user.js","server.js"];
const norm = s => String(s).replace(/\s+/g, " ").trim().replace(/\d+(?:[.,]\d+)*/g, "{#}");
const PT_HINT = /[ãõçáéíóúâêôà]|\b(de|da|do|dos|das|em|para|com|que|não|você|seu|sua|uma|um|por|ou|ao|os|as|no|na|se|é|já|mais|vaga|vagas|plano|envio|conta|senha|erro|aguarde|tente|clique|sem|todo|toda)\b/i;
const looksText = (t, semHint) => {
  if (t.length < 3 || t.length > 2500) return false;
  if (!/[A-Za-zÀ-ú]{3}/.test(t)) return false;
  if (/^(https?:|\/[A-Za-z]|#[A-Za-z0-9_-]|\.[A-Za-z0-9_-]|data:|[a-z0-9_-]+\.(js|css|png|jpg|svg|json))/i.test(t)) return false;
  if (!semHint && /[{};=<>]|=>|\$\{|function\b|\bvar\b|\bconst\b|\blet\b/.test(t.replace(/\{#\}|\{\*\}/g, ""))) return false; // (em HTML ; e = são pontuação normal)
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(t) || /^[a-z0-9_]+$/.test(t)) return false; // identificadores
  return semHint ? true : PT_HINT.test(t);
};
const decEnt = x => String(x).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
function htmlStrings(h) {
  // remoção SEQUENCIAL (a que aparece primeiro vence): comentário pode conter <style>/<script> e script pode conter "<!--"
  { let o = "", i = 0; const re = /<!--|<script\b|<style\b/gi; let m;
    while ((m = re.exec(h))) {
      o += h.slice(i, m.index); const k = m[0].toLowerCase();
      const fim = k === "<!--" ? h.indexOf("-->", m.index + 4) : h.toLowerCase().indexOf(k === "<style" ? "</style>" : "</script>", m.index);
      const len = k === "<!--" ? 3 : k === "<style" ? 8 : 9;
      i = fim < 0 ? h.length : fim + len; re.lastIndex = i;
    }
    h = o + h.slice(i); }
  const out = new Set();
  for (const m of h.matchAll(/>([^<>]+)</g)) { const t = norm(decEnt(m[1])); if (looksText(t, true)) out.add(t); }
  for (const m of h.matchAll(/\b(?:placeholder|title|aria-label|alt|value|content)="([^"]+)"/g)) { const t = norm(decEnt(m[1])); if (looksText(t, true)) out.add(t); }
  return out;
}
// Leitor de JS (sem dependência): devolve os literais de string/template ignorando comentários e regex literals.
function jsLiterals(src) {
  const out = []; let i = 0; const n = src.length;
  function code(stopAtBrace) {
    let depth = 0, prev = ";";
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") { const q = c, st = i + 1; i++; while (i < n && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } out.push({ body: src.slice(st, i), idx: st - 1, tpl: false }); i++; prev = q; continue; }
      if (c === "`") { template(); prev = "`"; continue; }
      if (c === "/" && /[(,=:\[!&|?{};]/.test(prev)) { i++; let cls = false; while (i < n && src[i] !== "\n") { if (src[i] === "\\") { i += 2; continue; } if (src[i] === "[") cls = true; else if (src[i] === "]") cls = false; else if (src[i] === "/" && !cls) break; i++; } i++; while (/[a-z]/.test(src[i] || "")) i++; prev = "/"; continue; }
      if (stopAtBrace) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) { i++; return; } depth--; } }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  function template() {
    const st = i + 1; i++;
    while (i < n && src[i] !== "`") { if (src[i] === "\\") { i += 2; continue; } if (src[i] === "$" && src[i + 1] === "{") { i += 2; code(true); continue; } i++; }
    out.push({ body: src.slice(st, i), idx: st - 1, tpl: true }); i++;
  }
  code(false);
  return out;
}
function jsStrings(src, soUsuario) {
  const out = new Set();
  // app.js: os blocos en:/es: do LANG_DICT já são traduções (não são fonte em português) — fora da extração
  let ex0 = -1, ex1 = -1; const dI = src.indexOf("const LANG_DICT = {");
  if (dI >= 0) { const e0 = src.indexOf("\n  en:", dI); const dE = src.indexOf("\n};", dI); if (e0 > 0 && dE > e0) { ex0 = e0; ex1 = dE; } }
  for (const L of jsLiterals(src)) {
    if (ex0 >= 0 && L.idx > ex0 && L.idx < ex1) continue;
    let body = L.body;
    if (body === undefined || body.length < 3) continue;
    if (soUsuario) { // server.js: só o que chega na tela do usuário (mensagens de erro/aviso e páginas HTML), nunca log interno
      const antes = src.slice(Math.max(0, L.idx - 16), L.idx);
      const msgCampo = /(?:error|erro|msg|message|aviso|hint|detalhe|motivo|titulo|title|nav|h1|h2|desc|descricao|lead|intro|label|texto|cta|subtitulo|resumo|rotulo|pergunta|resposta|q|a)\s*:\s*$/.test(antes);
      const paginaHtml = /<(p|li|h[1-6]|td|th|button|label|summary|a|span|div|strong|b|em|small|nav|section|header|footer|title|option)\b/.test(body);
      // frase com variável embutida (ex.: `Calculado a partir de ${n} vagas…`) que vira texto de página; log interno começa com [tag] ou emoji de log
      const fraseDinamica = L.tpl && /\$\{/.test(L.body) && L.body.length >= 30 && !/^\s*(\[|console|🚨|⚠️|✅|❌|🔐)/.test(L.body) && PT_HINT.test(L.body) && !/\bconsole\.|\bthrow\b|=>/.test(L.body);
      if (!msgCampo && !paginaHtml && !fraseDinamica) continue;
    }
    // decodifica escapes do JS antes de qualquer outra coisa: \u00e9, \u{1F600}, \xe9, \n
    body = body.replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    body = body.replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1");
    const temTag = /<\/?(?:p|li|ul|ol|h[1-6]|div|span|a|b|strong|em|small|button|label|td|th|tr|nav|section|header|footer|summary|option|i|br)\b/i.test(body); // texto dentro de HTML montado no JS = conteúdo de tela (sem filtro de palavras)
    // atributos de texto dentro de HTML montado no JS (aria-label, title, placeholder, alt)
    for (const am of body.matchAll(/\b(?:placeholder|title|aria-label|alt)=(?:"([^"]+)"|'([^']+)')/g)) {
      const t = norm((am[1] || am[2]).replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "{*}")).replace(/\{\*\}(?:\s*\{\*\})+/g, "{*}");
      if (looksText(t.replace(/\{\*\}/g, " ").trim().length > 2 ? t : "")) out.add(t);
    }
    // separa em fragmentos por tags HTML; ${expr} vira {*} dentro do mesmo texto
    const frags = body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "\u0001").split(/<[^>]*>/);
    for (const f of frags) {
      const comStar = f.replace(/\u0001/g, "{*}");
      const t = norm(comStar.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")).replace(/\{\*\}(?:\s*\{\*\})+/g, "{*}");
      if (looksText(t.replace(/\{\*\}/g, " ").trim().length > 2 ? t : "", temTag)) out.add(t);
    }
  }
  // "a " + expr + " b"  (concatenação) → "a {*} b"
  const cat = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1\s*\+\s*([A-Za-z_$][\w$.\[\]()?:'" ]{0,40}?)\s*\+\s*(["'])((?:\\.|(?!\4)[^\\\n])*)\4/g;
  let c; while ((c = cat.exec(src))) {
    if (soUsuario) { const antes = src.slice(Math.max(0, c.index - 16), c.index); if (!/(?:error|erro|msg|message|aviso|hint|detalhe|motivo|titulo)\s*:\s*$/.test(antes)) continue; }
    const t = norm((c[2] + "{*}" + c[5]).replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1").replace(/<[^>]*>/g, " "));
    if (/[A-Za-zÀ-ú]{3}/.test(t.replace(/\{\*\}/g, " ")) && looksText(t.replace(/\{\*\}/g, "x"))) out.add(t);
  }
  return out;
}
function collect() {
  const all = new Map(); // texto → [arquivos]
  const add = (set, f) => set.forEach(t => { if (!all.has(t)) all.set(t, new Set()); all.get(t).add(f); });
  for (const f of HTML_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) add(htmlStrings(fs.readFileSync(p, "utf8")), f); }
  for (const f of JS_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) add(jsStrings(fs.readFileSync(p, "utf8"), f === "server.js"), f); }
  return all;
}
function loadCat(lang) {
  const o = {}; const dir = path.join(ROOT, "i18n", lang);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort()) Object.assign(o, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  return o;
}
// Páginas que o SERVIDOR monta/reescreve (o texto final difere do arquivo-fonte): extraídas do HTML renderizado.
const ROTAS_RENDERIZADAS = ["/", "/aprenda", "/guia", "/como-usar", "/termos", "/privacidade", "/contato", "/excluir-conta", "/google-data-usage",
  "/empresas-que-patrocinam-visto-h2b", "/h2b-e-golpe", "/h2bapply-funciona", "/quanto-custa-o-visto-h2b", "/quanto-ganha-h2b", "/vagas-h2b", "/vagas-h2b/texas", "/vagas-h2b/florida"];
async function renderedCollect(base, into) {
  const all = into || new Map(); const vistos = new Set();
  const add = (html, f) => htmlStrings(html).forEach(t => { if (!all.has(t)) all.set(t, new Set()); all.get(t).add(f); });
  const fila = [...ROTAS_RENDERIZADAS];
  while (fila.length) {
    const r = fila.shift(); if (vistos.has(r)) continue; vistos.add(r);
    try { const res = await fetch(base + r); if (!res.ok) continue; const html = await res.text(); add(html, "render:" + r);
      if (r === "/aprenda" || r.startsWith("/aprenda/")) for (const m of html.matchAll(/href="(\/aprenda\/[a-z0-9-]+)"/g)) if (!vistos.has(m[1])) fila.push(m[1]);
    } catch (e) {}
  }
  return all;
}
module.exports = { collect, loadCat, norm, htmlStrings, renderedCollect, ROTAS_RENDERIZADAS };
if (require.main === module) (async () => {
  const all = collect(); const ri = process.argv.indexOf("--rendered"); if (ri > 0) await renderedCollect(process.argv[ri + 1], all); const en = Object.assign({}, require("./i18n-build.js").seed("en"), loadCat("en")), es = Object.assign({}, require("./i18n-build.js").seed("es"), loadCat("es"));
  const faltaEn = [...all.keys()].filter(k => !en[k]), faltaEs = [...all.keys()].filter(k => !es[k]);
  const chars = [...all.keys()].reduce((n, k) => n + k.length, 0);
  console.log(`textos únicos: ${all.size} (${chars} caracteres) · sem EN: ${faltaEn.length} · sem ES: ${faltaEs.length}`);
  if (process.argv.includes("--chunks")) {
    const dir = path.join(ROOT, "i18n", "todo"); fs.mkdirSync(dir, { recursive: true });
    const fi = process.argv.indexOf("--from"); const start = fi > 0 ? parseInt(process.argv[fi + 1], 10) : 1; // numeração continua: nunca sobrescreve bloco antigo
    const keys = [...new Set([...faltaEn, ...faltaEs])]; const N = 150;
    for (let i = 0; i < keys.length; i += N) { const o = {}; keys.slice(i, i + N).forEach(k => { o[k] = [...all.get(k)].join(", "); }); fs.writeFileSync(path.join(dir, `chunk-${String(start + i / N).padStart(3, "0")}.json`), JSON.stringify(o, null, 1)); }
    console.log(`chunks gravados: ${Math.ceil(keys.length / N)}`);
  }
})();
