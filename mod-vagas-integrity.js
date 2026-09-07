/* ═══════════════════════════════════════════════════════════════════════
   🔒 mod-vagas-integrity.js — Integridade de Vagas por ETA Case Number

   REGRA DE NEGÓCIO (pedido do dono, 07/07/2026):
     1 vaga = 1 ETA Case Number único. O case number é o ID da vaga, do
     mesmo jeito que um CPF identifica uma pessoa — nunca pode haver duas
     linhas com o mesmo case number numa planilha publicada, e a contagem
     de "quantas vagas tem" é SEMPRE a contagem de case numbers distintos,
     nunca a contagem crua de linhas/registros baixados da fonte.

   POR QUE ISSO EXISTIA COMO BUG:
     O bot de coleta (_runDolBuildBot, server.js) pagina a API do DOL com
     $skip/$top sobre um dataset que muda ao vivo (novos casos entram o
     tempo todo, ordenado por dhTimestamp desc). Isso é o cenário clássico
     de "offset pagination sobre dado mutante": o mesmo registro pode
     aparecer em duas páginas diferentes se novos itens empurrarem os já
     vistos. Sem dedupe, isso vira vaga duplicada na planilha publicada
     (achado real: h2a_jun2026_compact.json tinha 5000 linhas para apenas
     4964 case numbers únicos — 36 duplicados).

   O QUE ESTE MÓDULO GARANTE (usado por build-sheets.js E server.js):
     - dedupeVagas(): nunca perde dado — quando o mesmo case number
       aparece 2x, MESCLA os dois registros (mantém o mais completo,
       preenche os campos vazios com o outro) em vez de simplesmente
       descartar um dos dois ou empilhar os dois.
     - verifyIntegrity(): checagem final antes de gravar/publicar —
       se sobrar duplicata ou linha sem case number, quem chamou DEVE
       abortar o save (nunca publicar uma planilha "suja").
     - buildManifest(): um "recibo" (hash da lista ordenada de case
       numbers + contagem) salvo ao lado do arquivo da planilha. Serve
       pra provar depois — sem precisar reprocessar nada — que "quantas
       vagas foram baixadas" é EXATAMENTE "quantas foram publicadas":
       mesmo conjunto de case numbers, não só mesmo tamanho de array.

   Contrato: sem dependências externas, só `crypto` nativo do Node — pode
   ser usado tanto pelo processo standalone (build-sheets.js) quanto pelo
   processo do servidor (server.js) sem duplicar a lógica em dois lugares.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("crypto");

const DISCARD_STATUSES = ["denied", "withdrawn", "invalidated"];

function normCase(c) {
  return String(c || "").trim().toUpperCase();
}

// Pontua a "completude" de um registro de vaga — usado só para decidir,
// quando o MESMO case number aparece 2x, qual versão vira a "base" do
// merge (a de maior pontuação). Ter email conta muito (é o que permite
// candidatura); status não-descartável conta; e cada campo preenchido
// soma 1 ponto (mais dado > menos dado).
function scoreRecord(rec) {
  if (!rec || typeof rec !== "object") return 0;
  let score = 0;
  const emailish = rec.e || rec.apply_email || rec.employer_email;
  if (emailish && String(emailish).includes("@")) score += 10;
  const st = String(rec.st || rec.case_status || "").toLowerCase();
  if (st && !DISCARD_STATUSES.some((d) => st.includes(d))) score += 5;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) score += 1;
  }
  return score;
}

// Mescla dois registros do MESMO case number: a "base" é o de maior score;
// qualquer campo vazio na base é preenchido com o valor do outro registro.
// Nunca perde um dado que já tinha sido capturado por qualquer um dos dois.
function mergeRecords(a, b) {
  const baseIsA = scoreRecord(a) >= scoreRecord(b);
  const base = baseIsA ? a : b;
  const extra = baseIsA ? b : a;
  const out = { ...base };
  for (const k of Object.keys(extra)) {
    const cur = out[k];
    const isEmpty = cur === "" || cur === null || cur === undefined || (Array.isArray(cur) && cur.length === 0);
    if (isEmpty && extra[k] !== "" && extra[k] !== null && extra[k] !== undefined) {
      out[k] = extra[k];
    }
  }
  return out;
}

// Deduplica um array de vagas pelo campo de ETA case number (default "c").
// Linhas sem case number são descartadas (não são "vaga" — não têm ID).
// Retorna o array já limpo (1 linha por case number) + estatísticas.
function dedupeVagas(rows, opts = {}) {
  const field = opts.caseField || "c";
  const map = new Map();
  const order = [];
  const duplicateCases = [];
  let semCase = 0;

  for (const r of rows || []) {
    const cn = normCase(r && r[field]);
    if (!cn) { semCase++; continue; }
    if (map.has(cn)) {
      map.set(cn, mergeRecords(map.get(cn), r));
      duplicateCases.push(cn);
    } else {
      map.set(cn, r);
      order.push(cn);
    }
  }

  const out = order.map((cn) => {
    const rec = { ...map.get(cn) };
    rec[field] = cn; // garante o case number normalizado (maiúsculo, sem espaço) na saída
    return rec;
  });

  return {
    rows: out,
    uniqueCount: out.length,
    totalIn: (rows || []).length,
    duplicatesMerged: duplicateCases.length,
    duplicateCases,
    rowsWithoutCase: semCase,
  };
}

// Confere que um array JÁ ESTÁ limpo — 1 linha por case number, todas com
// case number. Uso: guarda final, logo antes de gravar em disco ou marcar
// uma planilha como publicada para os usuários.
function verifyIntegrity(rows, opts = {}) {
  const field = opts.caseField || "c";
  const seen = new Set();
  const dups = [];
  let semCase = 0;

  for (const r of rows || []) {
    const cn = normCase(r && r[field]);
    if (!cn) { semCase++; continue; }
    if (seen.has(cn)) dups.push(cn);
    seen.add(cn);
  }

  return {
    ok: dups.length === 0 && semCase === 0,
    totalRows: (rows || []).length,
    uniqueCaseCount: seen.size,
    duplicateCases: dups,
    rowsWithoutCase: semCase,
  };
}

// Gera o "recibo" de integridade de uma planilha: hash determinístico da
// lista ORDENADA de case numbers + contagens. Dois arquivos com o mesmo
// hash têm, garantidamente, o mesmo CONJUNTO de vagas (não só o mesmo
// tamanho) — é isso que permite provar "baixei N, publiquei N, e são as
// mesmas N" sem ter que comparar arquivo inteiro campo a campo.
function buildManifest(rows, opts = {}) {
  const field = opts.caseField || "c";
  const cases = (rows || [])
    .map((r) => normCase(r && r[field]))
    .filter(Boolean)
    .sort();
  const hash = crypto.createHash("sha256").update(cases.join("|")).digest("hex");
  return {
    generatedAt: new Date().toISOString(),
    uniqueCaseCount: cases.length,
    totalRows: (rows || []).length,
    caseListHash: hash,
    ...(opts.extra || {}),
  };
}

module.exports = {
  normCase,
  scoreRecord,
  mergeRecords,
  dedupeVagas,
  verifyIntegrity,
  buildManifest,
};
