#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🔍 GUARDA CONTRA FUNÇÕES DUPLICADAS — roda no `npm run check`
   Motivo (histórico real do projeto): cópias byte-idênticas de funções
   top-level (aprovarPedido, cancelarPedido, marcarPago...) já mascararam
   um bloco <script> INTEIRO quebrado no admin — o painel "funcionava"
   porque a cópia de outro bloco sobrescrevia a área morta.

   O que ele pega: DUAS declarações `function nome(...)` na coluna 0 do
   mesmo arquivo (a segunda sobrescreve a primeira em silêncio).
   O que ele ignora de propósito:
     - funções aninhadas/indentadas (escopo local, sem conflito);
     - wrappers intencionais (`const _orig = window.x; window.x = ...`) —
       padrão de extensão usado no index/admin.
   Sai com código 1 se achar duplicata. Zero dependências.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");

const scriptsDe = (html) => {
  let out = "";
  const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out += m[1] + "\n";
  return out;
};

const ALVOS = [
  ["server.js", fs.readFileSync("server.js", "utf8")],
  ["index.html", scriptsDe(fs.readFileSync("index.html", "utf8"))],
  ["admin.html", scriptsDe(fs.readFileSync("admin.html", "utf8"))],
  ["h2b-extras-user.js", fs.readFileSync("h2b-extras-user.js", "utf8")],
  ["h2b-extras-admin.js", fs.readFileSync("h2b-extras-admin.js", "utf8")],
];

let falhas = 0;
for (const [nome, src] of ALVOS) {
  const vistos = {};
  // Só coluna 0: declaração top-level de verdade (indentada = escopo local)
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const fn = m[1];
    vistos[fn] = (vistos[fn] || 0) + 1;
  }
  const dups = Object.entries(vistos).filter(([, n]) => n > 1);
  if (dups.length) {
    falhas++;
    console.error(`❌ ${nome}: função(ões) top-level declaradas mais de uma vez:`);
    dups.forEach(([fn, n]) => console.error(`   ${n}x function ${fn}(...)  ← a última sobrescreve as anteriores em silêncio`));
  }
}

if (falhas) {
  console.error("\nRemova as cópias mortas (mantenha a definição que vale) antes de commitar.");
  process.exit(1);
}
console.log("✅ check-duplicates: nenhuma função top-level duplicada.");
