#!/usr/bin/env node
/* Monta i18n/en.json e i18n/es.json (o que o navegador baixa) a partir de:
   (1) o dicionário antigo LANG_DICT do app.js (sementes — pt→en/es por fragmento de texto) e
   (2) i18n/<lang>/*.json (blocos traduzidos: { "texto em português normalizado": "tradução" }).
   Os blocos vencem a semente. Uso: node tools/i18n-build.js */
"use strict";
const fs = require("fs"), path = require("path");
const { norm, loadCat } = require("./i18n-extract.js");
const ROOT = path.join(__dirname, "..");
function langDict() {
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const a = src.indexOf("const LANG_DICT = {"); if (a < 0) return null;
  const b = src.indexOf("\n};", a);
  try { return new Function("return (" + src.slice(a + "const LANG_DICT = ".length, b + 2) + ")")(); } catch (e) { console.warn("LANG_DICT não avaliável:", e.message); return null; }
}
const frags = v => String(v).split(/<[^>]*>/).map(norm).filter(x => /[A-Za-zÀ-ú]{2}/.test(x));
function seed(lang) {
  const d = langDict(), out = {}; if (!d || !d.pt || !d[lang]) return out;
  for (const k of Object.keys(d.pt)) {
    const p = frags(d.pt[k]), t = frags(d[lang][k] || "");
    if (p.length && p.length === t.length) p.forEach((x, i) => { if (t[i] && x !== t[i]) out[x] = t[i]; });
  }
  return out;
}
if (require.main === module) {
  for (const lang of ["en", "es"]) {
    const cat = Object.assign({}, seed(lang), loadCat(lang));
    fs.writeFileSync(path.join(ROOT, "i18n", lang + ".json"), JSON.stringify(cat));
    console.log(lang + ": " + Object.keys(cat).length + " entradas → i18n/" + lang + ".json");
  }
}
module.exports = { seed };
