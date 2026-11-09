#!/usr/bin/env node
/* Valida blocos traduzidos: node tools/i18n-validate.js 001 [002 ...]  (ou "all") */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
let ids = process.argv.slice(2);
if (ids[0] === "all" || !ids.length) ids = fs.readdirSync(path.join(ROOT, "i18n", "todo")).map(f => f.match(/chunk-(\d+)/)[1]);
let bad = 0;
for (const id of ids) {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n", "todo", `chunk-${id}.json`), "utf8"));
  for (const lang of ["en", "es"]) {
    const f = path.join(ROOT, "i18n", lang, `chunk-${id}.json`);
    if (!fs.existsSync(f)) { console.log(`✗ ${lang}/${id}: arquivo não existe`); bad++; continue; }
    let o; try { o = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.log(`✗ ${lang}/${id}: JSON inválido — ${e.message}`); bad++; continue; }
    for (const k of Object.keys(src)) {
      const v = o[k];
      if (typeof v !== "string" || !v.trim()) { console.log(`✗ ${lang}/${id}: falta tradução de «${k.slice(0, 60)}»`); bad++; continue; }
      const n1 = (k.match(/\{#\}/g) || []).length, n2 = (v.match(/\{#\}/g) || []).length;
      const s1 = (k.match(/\{\*\}/g) || []).length, s2 = (v.match(/\{\*\}/g) || []).length;
      if (s1 !== s2) { console.log(`✗ ${lang}/${id}: {*} ${s1}≠${s2} em «${k.slice(0, 50)}» → «${v.slice(0, 50)}»`); bad++; }
      if (n1 !== n2) { console.log(`✗ ${lang}/${id}: {#} ${n1}≠${n2} em «${k.slice(0, 50)}» → «${v.slice(0, 50)}»`); bad++; }
    }
    for (const k of Object.keys(o)) if (!(k in src)) { console.log(`✗ ${lang}/${id}: chave que não existe no original «${k.slice(0, 50)}»`); bad++; }
  }
}
console.log(bad ? `${bad} problema(s)` : `blocos ${ids.join(",")}: OK`);
process.exit(bad ? 1 : 0);
