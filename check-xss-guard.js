#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🛡️ GUARDA CONTRA innerHTML SEM ESCAPE — roda no `npm run check`
   Motivo (auditoria de segurança, 10/09/2026): a disciplina de escapar
   HTML hoje é 100% manual — cada `innerHTML=` que monta HTML com dado
   dinâmico precisa lembrar de chamar esc(...) em volta do que vem de
   fora (nome, e-mail, currículo, nota do admin...). Nada barrava um
   `innerHTML=` NOVO de esquecer o esc() e abrir uma XSS. Esta guarda
   não tenta ser um linter completo de JS (o projeto não tem parser de
   verdade, e não vamos adicionar dependência só pra isso) — ela pega o
   caso mais perigoso e mais fácil de detectar sem parser: uma atribuição
   a `.innerHTML` cujo texto INTEIRO da instrução não contém NENHUMA
   chamada a esc(...), mas interpola dado dinâmico (`${...}`) dentro de
   um template literal. Isso pega exatamente a classe de erro real (um
   innerHTML novo, sem nenhum esc() em lugar nenhum da instrução).

   Falso positivo esperado: innerHTML que só interpola número/ícone/
   texto fixo (nada vindo de fora) não precisa de esc(). Pra esses casos
   confirmados manualmente como seguros, adicione a linha (não o
   conteúdo) a ALLOWLIST_LINHAS abaixo, com um comentário dizendo por
   quê — nunca desative a guarda inteira pra silenciar 1 caso.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const crypto = require("crypto");

// Assinatura ESTÁVEL do conteúdo da instrução (espaços colapsados + sha256
// curto) — NUNCA o número de linha: uma linha nova inserida em qualquer
// lugar do arquivo desloca toda linha abaixo dela, e uma allowlist por
// linha quebra silenciosamente toda vez (aconteceu de verdade escrevendo
// esta guarda — uma função nova acrescentada mais acima invalidou 14
// entradas da allowlist na hora). Por conteúdo, só uma edição de VERDADE
// na própria instrução invalida a entrada — o que é o comportamento certo
// (força reler o trecho mudado).
const sigOf = (stmt) => crypto.createHash("sha256").update(stmt.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);

// Troca tudo fora de <script>...</script> por espaços (preservando as
// quebras de linha reais, nunca removendo caractere nenhum) — só o miolo
// dos scripts sobrevive com texto de verdade, então (a) o número de linha
// calculado bate com o .html real e (b) HTML embutido em template literal
// DENTRO do script (ex.: `<div>${esc(x)}</div>`) nunca é tocado — só o que
// está de fato fora de <script>...</script> vira espaço em branco.
const scriptsDe = (html) => {
  const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  let out = "", cursor = 0, m;
  while ((m = re.exec(html))) {
    out += blank(html.slice(cursor, m.index));
    const full = m[0], body = m[1];
    const bodyStart = full.indexOf(body);
    out += blank(full.slice(0, bodyStart)) + body + blank(full.slice(bodyStart + body.length));
    cursor = m.index + full.length;
  }
  out += blank(html.slice(cursor));
  return out;
};

const ALVOS = [
  ["app.js", fs.readFileSync("app.js", "utf8")],
  ["admin.html", scriptsDe(fs.readFileSync("admin.html", "utf8"))],
  ["h2b-extras-user.js", fs.readFileSync("h2b-extras-user.js", "utf8")],
];

// Cada entrada: "arquivo:assinatura" (sigOf do texto da instrução, NUNCA
// linha — ver comentário acima) confirmado manualmente como seguro
// (interpola só número/ícone/texto fixo — nada vindo de fora). Motivo
// registrado aqui em vez de espalhar comentário no meio do código.
// Revisão de 10/09/2026 (auditoria de segurança) — os 46 achados originais
// desta guarda foram lidos 1 a 1: 6 interpolavam dado real do usuário e
// ganharam esc() de verdade no app.js (email/rótulo de Gmail extra, foto
// de perfil do Google, nome de perfil de vaga, template de corpo de
// e-mail salvo) — os 40 abaixo foram confirmados seguros. Pra adicionar
// uma entrada nova: rode `node check-xss-guard.js`, copie a assinatura que
// aparece na falha (não invente uma).
const ALLOWLIST = new Set([
  // Só número (contagem/limite/dias/score) interpolado — nada de texto:
  "app.js:98b41cf16bcb", "app.js:b53d107f68e1", "app.js:2b7dd6f1e9f8", "app.js:a8c376c9c226", "app.js:65087d84f8fe",
  "app.js:480178d813df", "app.js:39fb917ed5c4", "app.js:e0c3e8be68bb", "app.js:dc811363e8a2", "app.js:f384dc715f29",
  "app.js:09ce6f37c941", "app.js:8c3e83eb18e0", "app.js:03f1c9fdd571", "app.js:bec1a605c6d4", "app.js:755e1aeff07d",
  "app.js:a4361d354957", "app.js:a0477b4280d4", "app.js:1002f7586e81", "app.js:31544df75aa5", "app.js:7a6d66aafffa",
  "app.js:9de316c2d76c", "app.js:70c36d55e956", "app.js:b9649532e42f", "app.js:caaa4d3f7604", "app.js:aae8a8e4e135",
  "app.js:5084ad234267", "app.js:316f7a6a8b90", "app.js:c9a8ca4d8df9", "app.js:b196106b8127",
  // Só ícone/cor/rótulo de um mapa INTERNO fixo (categorias, planos, sons,
  // estado de visto) indexado por chave — nunca texto livre de fora:
  "app.js:515a1087ca52", "app.js:ca018fab6d78", "app.js:3f1ea2b0702e",
  // Nome/emoji de PLANILHA — só admin cria/nomeia planilha (coleta/
  // publish), nunca usuário comum; mesmo padrão de confiança que o resto
  // do painel admin já usa sem esc() pra dado que só o admin escreve:
  "app.js:2560ebdd2120", "app.js:548f87170d4f",
  // Texto 100% estático hardcoded no próprio call site (confirmado lendo
  // TODOS os call sites da função) — nenhum caminho de código hoje passa
  // dado dinâmico por aqui:
  "app.js:0d8902f0867a", "app.js:3e7fbdeb7fbd", "app.js:57e78b86fe9c",
  // Preço/plano/chave Pix — vêm de PLANO_PRECO_TAB/PIX_KEY (constantes do
  // servidor, nunca texto do usuário) via NOME[]/brl():
  "app.js:30d315c9b1e7", "app.js:ea351ac57b38",
  // Demo estático da landing (ticker de exemplo, array hardcoded) e valor
  // de atributo já escapado à mão pro contexto de atributo (troca só a
  // aspa, que é o único caractere que quebraria esse atributo):
  "app.js:ba4553714a88", "app.js:39a9b3b1c3d0",
  // Contador "N restantes/enviadas de M" (loadSheetMeta/updSheetCounter,
  // fix v172e): só números (remaining/sentInSheet/sTrueTotal via
  // toLocaleString) + nome/emoji de planilha (sheetLabel/_sheetLabelFor —
  // mesma categoria "só admin nomeia planilha" já confiada acima):
  "app.js:2c4e258286b0", "app.js:9c25a1550942",
]);

function extractInnerHTMLStatements(src) {
  const out = [];
  const re = /\.innerHTML\s*=(?!=)/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let depth = 0, inSQ = false, inDQ = false, inTpl = false, exprDepth = 0;
    const startLine = src.slice(0, m.index).split("\n").length;
    while (i < src.length) {
      const c = src[i];
      if (inSQ) { if (c === "\\") { i += 2; continue; } if (c === "'") inSQ = false; i++; continue; }
      if (inDQ) { if (c === "\\") { i += 2; continue; } if (c === '"') inDQ = false; i++; continue; }
      if (inTpl) {
        if (c === "\\") { i += 2; continue; }
        if (exprDepth === 0) {
          if (c === "`") { inTpl = false; i++; continue; }
          if (c === "$" && src[i + 1] === "{") { exprDepth = 1; i += 2; continue; }
          i++; continue;
        } else {
          if (c === "{") { exprDepth++; i++; continue; }
          if (c === "}") { exprDepth--; i++; continue; }
          i++; continue;
        }
      }
      if (c === "'") { inSQ = true; i++; continue; }
      if (c === '"') { inDQ = true; i++; continue; }
      if (c === "`") { inTpl = true; i++; continue; }
      if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
      if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; i++; continue; }
      if (c === ";" && depth === 0) break;
      i++;
      if (i - m.index > 6000) break; // trava de segurança — instrução absurdamente longa
    }
    out.push({ line: startLine, stmt: src.slice(m.index, i) });
  }
  return out;
}

let falhas = 0;
for (const [nome, src] of ALVOS) {
  const statements = extractInnerHTMLStatements(src);
  for (const { line, stmt } of statements) {
    const temInterpolacaoDinamica = /\$\{/.test(stmt);
    const temEsc = /\besc\s*\(/.test(stmt);
    if (temInterpolacaoDinamica && !temEsc) {
      const chave = `${nome}:${sigOf(stmt)}`;
      if (ALLOWLIST.has(chave)) continue;
      falhas++;
      console.error(`❌ ${chave} (linha ${line}): .innerHTML= interpola \${...} mas NENHUM esc() aparece na instrução inteira`);
      console.error(`   ${stmt.slice(0, 160).replace(/\s+/g, " ")}${stmt.length > 160 ? "…" : ""}`);
    }
  }
}

if (falhas) {
  console.error(`\n${falhas} innerHTML sem nenhum esc() na instrução. Ou (a) envolva o dado dinâmico com esc(...), ou`);
  console.error(`(b) se for confirmado que só interpola número/ícone/texto fixo, adicione "arquivo:linha" na`);
  console.error(`ALLOWLIST de check-xss-guard.js com o motivo — nunca desative a guarda inteira.`);
  process.exit(1);
}
console.log("✅ check-xss-guard: todo innerHTML= com interpolação dinâmica passa por esc() em algum ponto da instrução.");
