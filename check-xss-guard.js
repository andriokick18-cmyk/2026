#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🛡️ GUARDA CONTRA innerHTML SEM ESCAPE — roda no `npm run check`

   Motivo (auditoria de segurança, 10/09/2026): a disciplina de escapar
   HTML neste projeto é 100% manual — cada `innerHTML=` que monta HTML com
   dado dinâmico precisa lembrar de chamar esc(...) em volta do que vem de
   fora (nome, e-mail, currículo, nota do admin, texto de vaga...).

   🔁 v205 LOTE 23 — A GUARDA JULGA CADA `${...}`, NÃO A INSTRUÇÃO INTEIRA.
   A versão anterior considerava uma instrução `.innerHTML=` segura assim
   que UM esc() aparecesse em qualquer ponto dela. Isso mascarava vizinhos
   crus: foi exatamente assim que o `${icon}` (campo livre do perfil) passou
   batido até o v177-FIX2 — o `${names}` ao lado tinha esc(), então a
   instrução inteira era dada por boa. A fraqueza ficou registrada como
   risco conhecido e agora foi corrigida: cada expressão interpolada é
   julgada SOZINHA.

   RÉGUA (uma expressão é segura quando):
     • passa por esc(...) / escAttr(...) / _vfAttr(...)  → escapadores;
     • é número/booleano/`null`/string LITERAL (texto estático no código);
     • termina em .toLocaleString()/.toLocaleDateString()/.toLocaleTimeString()/
       .toFixed()/.length  → formatação numérica ou de data;
     • é chamada de uma função da lista SAFE_FNS abaixo (cada uma com o
       porquê, por ASSINATURA de função, não por linha);
     • é um operador cujos ramos EMITIDOS são todos seguros:
       `a ? b : c` (a condição não é emitida), `a || b`, `a ?? b`,
       `a && b` (só o último é emitido quando tudo é verdadeiro),
       `a + b` (os dois são emitidos);
     • template ANINHADO dentro da expressão não conta — os `${}` dele são
       extraídos e julgados à parte, um a um.
   Qualquer outra coisa é reprovada — inclusive variável que guarda HTML já
   montado (`const badge=esc(p.icon)`), porque sem parser não dá pra provar
   de onde veio. Esses casos entram na ALLOWLIST, por ASSINATURA da
   EXPRESSÃO, com o motivo escrito.

   A chave da allowlist é a ASSINATURA (sha256 curto do texto normalizado
   da expressão), NUNCA "arquivo:linha": uma linha nova em qualquer lugar
   do arquivo desloca todas as de baixo e transformaria a allowlist em
   entradas mortas em silêncio. Por conteúdo, só uma edição de VERDADE na
   própria expressão invalida a entrada — que é o comportamento certo
   (força reler o trecho mudado).
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const crypto = require("crypto");

const sigOf = (txt) => crypto.createHash("sha256").update(txt.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);

// Troca tudo fora de <script>...</script> por espaços (preservando as
// quebras de linha reais) — só o miolo dos scripts sobrevive com texto de
// verdade, então o número de linha calculado bate com o .html real e o HTML
// solto da página nunca é confundido com código.
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
  ["index.html", scriptsDe(fs.readFileSync("index.html", "utf8"))],
  ["h2b-extras-user.js", fs.readFileSync("h2b-extras-user.js", "utf8")],
];

// ── Funções que GERAM HTML seguro ou devolvem valor sem HTML ─────────────
// Indexadas por ASSINATURA (nome + o que a função faz), conferidas lendo o
// corpo de cada uma. Acrescentar aqui exige a mesma leitura.
const SAFE_FNS = {
  "esc(x)":                      "escapador oficial do front (& < > \" ')",
  "escAttr(x)":                  "escapador para contexto de atributo",
  "_vfAttr(v)":                  "JSON.stringify + escapa & \" < — valor de filtro dentro de onclick",
  "brl(n)":                      "(+n||0).toFixed(2) — número, nunca texto",
  "t(chave)":                    "dicionário LANG_DICT estático do próprio código",
  "planNomePedido(p)":           "mapa PLAN_NAMES fixo (nome do plano comprado)",
  "planBadgeHTML(u)":            "badge de plano montado de vip.manualExpires/autoExpires (datas)",
  "planLabelAtivo(u)":           "rótulo derivado dos 2 relógios do VIP — texto fixo",
  "vfResumoCurto(ctx)":          "contagem de filtros + textos do LANG_DICT",
  "_warmupBadgeHTML(sent,cap)":  "só 2 números interpolados (selo 🌱 de aquecimento)",
  "_srcCntHtml(s)":              "só contagens via toLocaleString (card de planilha)",
};
const SAFE_FN_NAMES = Object.keys(SAFE_FNS).map((k) => k.slice(0, k.indexOf("(")));

// ── ALLOWLIST por assinatura da EXPRESSÃO ────────────────────────────────
// Revisão completa de 19/09/2026 (v205 LOTE 23): as 405 expressões
// interpoladas dentro de innerHTML/insertAdjacentHTML do front foram lidas
// uma a uma. 31 ocorrências que carregavam DADO (vaga do DOL, nome/emoji/
// visto de planilha, hora do log, limite digitado pelo admin, nome de
// plano, chave Pix, ícone de categoria, chave de filtro, status de pedido,
// item do ticker da landing) ganharam esc() de verdade no app.js. As
// abaixo foram confirmadas seguras, com o motivo por grupo. Pra adicionar
// uma entrada nova: rode `node check-xss-guard.js`, copie a ASSINATURA que
// aparece na falha (não invente uma) e escreva o porquê.
const ALLOWLIST = new Set([
  // ── (a) NÚMERO puro (índice de laço, contador, limite, id numérico) ──
  "app.js:de7d1b721a1e", // i           — índice do laço de títulos/corpos do perfil
  "app.js:4a73096daa33", // i+1         — idem, rótulo "Título N"
  "app.js:8d6876183d55", // c.idx       — índice numérico do currículo no banco
  "app.js:1b16b1df538b", // n           — contagem de perfis/documentos
  "app.js:ed6cb1efc1c0", // nSubj       — quantos assuntos o perfil tem
  "app.js:1d9312d0bef2", // nBody       — quantos corpos de e-mail o perfil tem
  "app.js:91deec60a4dd", // sentInSheet — quantas vagas desta planilha já foram enviadas
  "app.js:df1c4628a937", // l.attachCount — nº de anexos do log de envio
  "app.js:fb60deeaa62c", // l.attempt   — nº da tentativa no log de envio
  "app.js:2eae9ac1a541", // ls.sent     — estatística de log (número)
  "app.js:4dbcfe033494", // ls.skip     — idem
  "app.js:57cbfe1484c2", // ls.dup      — idem
  "app.js:08de5ee5c152", // ls.failed   — idem
  "app.js:66d163110bac", // U.autoLimit — limite do plano (número do servidor)
  "app.js:592d4da957b7", // autoLimit   — U.autoLimit??0
  "app.js:3e3dd1415feb", // _activeSenders — Math.min(3,…) de contas conectadas
  "app.js:e420a546da53", // _perGmail   — Math.ceil(autoLimit/_activeSenders)
  "app.js:b497f4bbeb5a", // sentToday   — soma de envios de hoje
  "app.js:8fbd42ad079a", // rem         — envios manuais restantes hoje
  "app.js:8e35c2cd3bf6", // q           — auto.queueSize||0 (tamanho da fila)
  "app.js:fb5f3bbed7eb", // lim.manual  — PLAN_LIMITS_NEW vindo de /api/planos
  "app.js:ad68a9e3d0f1", // lim.auto    — idem
  "app.js:7543906e65be", // c.dias      — período do plano (30/60/90/365)
  "app.js:61ace1c5c832", // p.id        — id de perfil gerado pelo próprio front
  "app.js:c1ad34e47692", // profiles[0]?.id||"" — idem
  // ── (b) CONSTANTE INTERNA: mapa/array fixo escrito no próprio código ──
  "app.js:0230c6b1d833", // ctx          — literal "manual" | "auto"
  "app.js:1303c06b0b01", // type         — literal "resume" | "cover"
  "app.js:3485639faf15", // pl           — item de ['vip','vipro','doublepro']
  "app.js:84a47f61dd34", // em           — emojis[l.status]||"•" (mapa fixo)
  "app.js:d01419571c23", // statusClass  — "ls-"+status saneado por regex
  "app.js:e4df544e40b3", // horaColor    — cor CSS de um ternário de literais
  "app.js:c94acca2d50c", // visaCor      — '#10b981' | '#3b82f6'
  "app.js:9ed9d8bdc83b", // visaBg       — rgba() literal
  "app.js:bbf61802a3f9", // visaIcon     — 'ti-plant-2' | 'ti-snowflake'
  "app.js:3b64db95cb55", // bb           — regra CSS de borda, literal
  "app.js:2c15ca9fb8e6", // avatars[i%avatars.length] — array fixo de emojis
  "app.js:b2547aa06de5", // stars        — "★".repeat(n)+"☆".repeat(n)
  "app.js:253acf57ed10", // step.bg      — gradiente literal do "próximo passo"
  "app.js:cafc0dc05c66", // step.bd      — cor literal
  "app.js:e92bac897f1c", // step.icon    — emoji literal
  "app.js:f81da9ea3a2e", // step.ic      — cor literal
  "app.js:f272749f4b1d", // step.title   — t('ns*_t') do dicionário
  "app.js:998e50e59cb2", // step.sub     — t('ns*_s') do dicionário
  "app.js:d720a5d17175", // step.cta     — t('ns*_c') do dicionário
  "app.js:cb0e464b3b0d", // acts[step.act] — snippet de navegação fixo (sv('...'))
  "app.js:e4237121ac34", // DIAS_LBL[c.dias]||c.dias+'d' — mapa fixo + número
  "app.js:0f5a4674714a", // dias===365?'1 ano':dias+' dias' — literais + número
  "app.js:25034e933c84", // q._now?"▶ AGORA":(i+1)+"ª fila" — literais + número
  "app.js:a5729180afb8", // dataStr?dataStr+" ":"" — data do log (dd/mm/aaaa)
  "app.js:fefbdb67a3b2", // dt           — new Date(...).toLocaleDateString("pt-BR")
  // ── (c) VARIÁVEL QUE JÁ GUARDA HTML ESCAPADO/ESTÁTICO ────────────────
  //   (o esc() foi aplicado na ATRIBUIÇÃO, algumas linhas acima; sem
  //    parser a guarda não enxerga isso — cada uma conferida lendo o
  //    trecho onde é montada)
  "app.js:959a45d44e6f", // de          — ` <small>${esc(t(...))}</small>` ou ""
  "app.js:b3ca0b199c8a", // cur         — card do radar, todo esc() por dentro
  "app.js:a20d906cc7b0", // _corpo      — esc(`…`) na atribuição
  "app.js:26e88c94e52f", // vtTag       — ternário entre 2 <span> literais
  "app.js:c35b21d6ca39", // pdf         — p.pdfName?esc(p.pdfName):literal
  "app.js:8805cdea2b19", // badge       — esc(p.icon||"📄")
  "app.js:71c682142c67", // filtrosLbl  — vfResumoCurto("manual")
  "app.js:3120f839bf6e", // _statusLine — ternário de literais do card de sender
  "app.js:e66b31701f8f", // _statusColor— cor CSS literal
  "app.js:5d445bd8392c", // _warmupBadge— _warmupBadgeHTML(…) ou ""
  "app.js:33795b7f5667", // nameLine    — esc(displayName)+esc(location)
  "app.js:d1a8b4e16a82", // manualBadge — badge montado de lim.manual (número)
  "app.js:2b5976368a75", // autoBadge   — idem
  "app.js:405d13f03182", // emailBadge  — HTML fixo de "1 Gmail"/"2 Gmails"
  "app.js:f4cfc51e2413", // planLbl     — esc(planNomePedido(p.plano))+dias
  "app.js:663fe9d615bd", // cor         — stLbl(p)[1], cor CSS literal
  "app.js:3f14db6ed200", // bg          — stLbl(p)[2], rgba() literal
  "app.js:333419389923", // lbl         — stLbl(p)[0], t(...) ou esc(p.status)
  "app.js:ddc6e2b224d0", // sub         — stLbl(p)[3], já com esc(motivoCancelamento)
  "app.js:7163c67187d6", // compLinha   — IIFE que só devolve HTML com esc(t(...))
  // ── (d) .map(...).join("") cujo corpo já escapa cada campo ───────────
  "app.js:24c969bf60de", // profiles.map(…) — esc(icon)/esc(cats)/esc(name) por dentro (v177-FIX2/v198)
  "app.js:fdbd747a1e70", // (porPlano[pl]||[]).map(…) — só número/DIAS_LBL/brl por dentro
  "app.js:a7d180300b97", // _vfChipList("manual").map(c2=>esc(c2.lbl)).join(" · ")||esc(t('radar_all'))
]);

// ── Extração: as instruções que escrevem HTML ────────────────────────────
function statements(src) {
  const out = [];
  const re = /\.innerHTML\s*=(?!=)|\.outerHTML\s*=(?!=)|insertAdjacentHTML\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 0, inSQ = false, inDQ = false, inTpl = false, ex = 0;
    const startLine = src.slice(0, m.index).split("\n").length;
    while (i < src.length) {
      const c = src[i];
      if (inSQ) { if (c === "\\") { i += 2; continue; } if (c === "'") inSQ = false; i++; continue; }
      if (inDQ) { if (c === "\\") { i += 2; continue; } if (c === '"') inDQ = false; i++; continue; }
      if (inTpl) {
        if (c === "\\") { i += 2; continue; }
        if (ex === 0) {
          if (c === "`") { inTpl = false; i++; continue; }
          if (c === "$" && src[i + 1] === "{") { ex = 1; i += 2; continue; }
          i++; continue;
        }
        if (c === "{") ex++; else if (c === "}") ex--;
        i++; continue;
      }
      if (c === "'") { inSQ = true; i++; continue; }
      if (c === '"') { inDQ = true; i++; continue; }
      if (c === "`") { inTpl = true; i++; continue; }
      if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
      if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; i++; continue; }
      if (c === ";" && depth === 0) break;
      i++;
      if (i - m.index > 12000) break; // trava — instrução absurdamente longa
    }
    out.push({ line: startLine, stmt: src.slice(m.index, i) });
  }
  return out;
}

// Toda expressão ${...} em QUALQUER nível de template dentro do texto.
function exprsDe(txt) {
  const out = [];
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'" || c === '"') { const q = c; i++; while (i < txt.length) { if (txt[i] === "\\") { i += 2; continue; } if (txt[i] === q) { i++; break; } if (txt[i] === "\n") break; i++; } continue; }
    if (c !== "`") { i++; continue; }
    i++;
    while (i < txt.length) {
      if (txt[i] === "\\") { i += 2; continue; }
      if (txt[i] === "`") { i++; break; }
      if (txt[i] === "$" && txt[i + 1] === "{") {
        i += 2; const ini = i; let dep = 1;
        while (i < txt.length && dep > 0) {
          const ch = txt[i];
          if (ch === "\\") { i += 2; continue; }
          if (ch === "'" || ch === '"') { const q = ch; i++; while (i < txt.length) { if (txt[i] === "\\") { i += 2; continue; } if (txt[i] === q) { i++; break; } i++; } continue; }
          if (ch === "`") { // template aninhado — pula equilibrado (os ${} dele são recolhidos na recursão)
            i++; let d2 = 0;
            while (i < txt.length) {
              if (txt[i] === "\\") { i += 2; continue; }
              if (txt[i] === "`" && d2 === 0) { i++; break; }
              if (txt[i] === "$" && txt[i + 1] === "{") { d2++; i += 2; continue; }
              if (txt[i] === "}" && d2 > 0) { d2--; i++; continue; }
              i++;
            }
            continue;
          }
          if (ch === "{") dep++; else if (ch === "}") dep--;
          if (dep > 0) i++;
        }
        const e = txt.slice(ini, i);
        out.push(e);
        out.push(...exprsDe(e));
        i++; continue;
      }
      i++;
    }
  }
  return out;
}

// ── Julgamento de UMA expressão ──────────────────────────────────────────
function semTemplates(e) { // template aninhado vira "" — seus ${} são julgados à parte
  let out = "", i = 0;
  while (i < e.length) {
    const c = e[i];
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === "'" || c === '"') { const q = c; out += c; i++; while (i < e.length) { out += e[i]; if (e[i] === "\\") { out += e[i + 1] || ""; i += 2; continue; } if (e[i] === q) { i++; break; } i++; } continue; }
    if (c === "`") {
      i++; let d = 0;
      while (i < e.length) {
        if (e[i] === "\\") { i += 2; continue; }
        if (e[i] === "`" && d === 0) { i++; break; }
        if (e[i] === "$" && e[i + 1] === "{") { d++; i += 2; continue; }
        if (e[i] === "}" && d > 0) { d--; i++; continue; }
        i++;
      }
      out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}
function tiraParens(e) {
  e = e.trim();
  while (e.startsWith("(") && e.endsWith(")")) {
    let d = 0, ok = true;
    for (let i = 0; i < e.length; i++) { const c = e[i]; if (c === "(") d++; else if (c === ")") { d--; if (d === 0 && i < e.length - 1) { ok = false; break; } } }
    if (!ok) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}
function topSplit(e, op) {
  const parts = []; let d = 0, buf = "", i = 0;
  while (i < e.length) {
    const c = e[i];
    if (c === "'" || c === '"') { const q = c; buf += c; i++; while (i < e.length) { buf += e[i]; if (e[i] === "\\") { buf += e[i + 1] || ""; i += 2; continue; } if (e[i] === q) { i++; break; } i++; } continue; }
    if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--;
    if (d === 0 && e.startsWith(op, i) && !(op === "+" && (e[i + 1] === "+" || e[i - 1] === "+"))) { parts.push(buf); buf = ""; i += op.length; continue; }
    buf += c; i++;
  }
  parts.push(buf);
  return parts;
}
function topIndex(e, ch) {
  let d = 0, i = 0;
  while (i < e.length) {
    const c = e[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < e.length) { if (e[i] === "\\") { i += 2; continue; } if (e[i] === q) { i++; break; } i++; } continue; }
    if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--;
    if (d === 0 && c === ch) {
      if (ch === "?" && (e[i + 1] === "." || e[i + 1] === "?")) { i += 2; continue; }
      if (ch === ":" && e[i + 1] === ":") { i += 2; continue; }
      return i;
    }
    i++;
  }
  return -1;
}
const ESCAPADORES = /^(esc|escAttr|_vfAttr|Number|parseInt|parseFloat|Math\.[A-Za-z]+|JSON\.stringify)\s*\(/;
const FORMATADORES = /\.(length|toLocaleString\([^()]*\)|toLocaleDateString\([^()]*\)|toLocaleTimeString\([^()]*\)|toFixed\(\d*\))$/;

function seguro(eRaw) {
  const e = tiraParens(semTemplates(eRaw).trim());
  if (!e) return true;
  const q = topIndex(e, "?");
  if (q >= 0) { // ternário: a condição não é emitida
    const resto = e.slice(q + 1);
    const c = topIndex(resto, ":");
    if (c >= 0) return seguro(resto.slice(0, c)) && seguro(resto.slice(c + 1));
  }
  const ou = topSplit(e, "||"); if (ou.length > 1) return ou.every(seguro);
  const nn = topSplit(e, "??"); if (nn.length > 1) return nn.every(seguro);
  const ee = topSplit(e, "&&"); if (ee.length > 1) return seguro(ee[ee.length - 1]); // só o último é emitido inteiro
  const so = topSplit(e, "+"); if (so.length > 1) return so.every(seguro);
  if (/^-?\d+(\.\d+)?$/.test(e)) return true;
  if (/^(true|false|null|undefined)$/.test(e)) return true;
  if (/^(['"])[\s\S]*\1$/.test(e)) return true; // string literal (estática no código)
  if (FORMATADORES.test(e)) return true;
  if (ESCAPADORES.test(e) && e.endsWith(")")) return true;
  for (const fn of SAFE_FN_NAMES)
    if (new RegExp("^" + fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(").test(e) && e.endsWith(")")) return true;
  return false;
}

let falhas = 0, total = 0;
for (const [nome, src] of ALVOS) {
  for (const { line, stmt } of statements(src)) {
    for (const expr of exprsDe(stmt)) {
      total++;
      if (seguro(expr)) continue;
      const chave = `${nome}:${sigOf(expr)}`;
      if (ALLOWLIST.has(chave)) continue;
      falhas++;
      console.error(`❌ ${chave} (linha ${line}): \${${semTemplates(expr).replace(/\s+/g, " ").slice(0, 120)}} chega CRU no innerHTML`);
    }
  }
}

if (falhas) {
  console.error(`\n${falhas} de ${total} expressões interpoladas em innerHTML chegam sem escape.`);
  console.error(`Escolha UM dos caminhos:`);
  console.error(`  (a) se for dado de fora (usuário, vaga do DOL, planilha, admin, arquivo):`);
  console.error(`      envolva a EXPRESSÃO com esc(...) — ex.: \${esc(job.title)};`);
  console.error(`  (b) se a expressão só produz número/texto fixo/HTML já escapado, adicione`);
  console.error(`      "arquivo:ASSINATURA" (a chave impressa acima, copiada — nunca inventada)`);
  console.error(`      na ALLOWLIST de check-xss-guard.js, com um comentário dizendo POR QUÊ;`);
  console.error(`  (c) se for uma função nova que gera HTML seguro, registre-a em SAFE_FNS`);
  console.error(`      com a ASSINATURA dela e o motivo (depois de LER o corpo da função).`);
  console.error(`Em (b) e (c), a allowlist é indexada por ASSINATURA da expressão, nunca por "arquivo:linha"`);
  console.error(`(entrada por linha nasce morta e envelhece a cada edição). Nunca desative a guarda.`);
  process.exit(1);
}
console.log(`✅ check-xss-guard: as ${total} expressões interpoladas em innerHTML/insertAdjacentHTML passam por escape, formatação numérica, texto fixo ou allowlist revisada.`);
