#!/usr/bin/env node
/**
 * build-sheets.js — H2BApply v36
 * Baixa os Data Feeds H-2B e H-2A do DOL, filtra, enriquece e salva os compact JSONs.
 * Rode: node build-sheets.js
 * Cron:  0 2 * * * node /app/build-sheets.js >> /var/log/build-sheets.log 2>&1
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔒 V36 (07/07/2026) — CORREÇÃO CRÍTICA DE CONTAGEM, pedido do dono:
 * "a quantidade de vagas são a quantidade de ETA case number diferentes".
 *
 * O que mudou:
 *  (1) DEDUPE POR ETA CASE NUMBER logo após o download — o feed do DOL pode
 *      conter o MESMO case number 2x dentro do MESMO download (achado real
 *      em h2a_jun2026_compact.json: 5000 linhas para só 4964 case numbers
 *      únicos). Agora, se o mesmo case aparecer mais de uma vez, os
 *      registros são MESCLADOS (nunca perde dado, nunca duplica linha) via
 *      mod-vagas-integrity.js — o mesmo módulo usado pelo bot de coleta do
 *      admin (server.js), então a regra nunca diverge entre os dois caminhos.
 *  (2) SEM LIMITE ARTIFICIAL — a planilha final tem EXATAMENTE a quantidade
 *      de vagas que existirem de verdade na fonte (se vier 8 mil, fica 8
 *      mil; se vier 2 mil, fica 2 mil). O que faltava era garantir que
 *      "quantidade" = "case numbers únicos", não "linhas brutas do feed".
 *  (3) MANIFESTO DE INTEGRIDADE — ao lado de cada *_compact.json agora é
 *      gravado um *_compact.manifest.json com a contagem exata de vagas
 *      únicas e um hash da lista de case numbers. Prova, a qualquer
 *      momento, que "o que foi baixado" é EXATAMENTE "o que foi publicado".
 *  (4) GUARDA FINAL — antes de gravar em disco, roda verifyIntegrity() como
 *      último cinto-de-segurança: se por algum motivo sobrar duplicata, o
 *      script ABORTA o salvamento e mantém o arquivo anterior intacto.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";
const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const zlib   = require("zlib");
const os     = require("os");
const { dedupeVagas, verifyIntegrity, buildManifest } = require("./mod-vagas-integrity.js");
// 💵 v316 — unidade do salário reaproveitada de mod-planilhas.js (fonte única
// desde o v182 LOTE 8: "nunca duplicar"). Sem require circular de verdade —
// mod-planilhas.js só toca build-sheets.js dentro de função (runDolColeta/
// runH2aNovasCycle), nunca no topo do módulo.
const { unidadeSalario } = require("./mod-planilhas.js");

// ─── Configuração ─────────────────────────────────────────────────────────────
const OUT_DIR = path.join(__dirname);
const OUT_JAN = path.join(OUT_DIR, "jan2026_compact.json");
const OUT_JUL = path.join(OUT_DIR, "jul2025_compact.json");

// DOL Seasonal Jobs Data Hub — feeds ZIP com JSON interno
const DOL_BASE = "https://api.seasonaljobs.dol.gov/datahub-search/sjCaseData/zip";

// Datas a baixar (ISO YYYY-MM-DD) — o feed inclui casos dos 20 dias anteriores à data
// jan = H-2B (temporários não-agrícolas) — data recente
// jul = H-2A (agrícolas) — data referência verão 2025
function getFeedUrl(type, dateStr) {
  return `${DOL_BASE}/${type}/${dateStr}`;
}

// ─── Mapa de categorias: título → categoria ────────────────────────────────
const JOB_TITLE_TO_CAT = {
  // Food & Bar
  bartender:"food", barman:"food", barmaid:"food",
  "bar back":"food", barback:"food",
  cook:"food", "line cook":"food", "prep cook":"food", "head cook":"food",
  chef:"food", "sous chef":"food", "executive chef":"food",
  dishwasher:"food", "dish washer":"food",
  waiter:"food", waitress:"food", server:"food", "food server":"food",
  busser:"food", busperson:"food",
  barista:"food", baker:"food",
  "food service":"food", "food prep":"food", "food preparation":"food",
  "kitchen helper":"food", "kitchen worker":"food",
  host:"food", hostess:"food",
  // Driver
  driver:"driver", "truck driver":"driver", "cdl driver":"driver",
  "delivery driver":"driver", "bus driver":"driver",
  chauffeur:"driver", courier:"driver",
  "forklift operator":"driver", "forklift driver":"driver",
  "equipment operator":"driver",
  // Landscape
  landscaper:"landscape", "landscape worker":"landscape",
  "landscape laborer":"landscape", "lawn care":"landscape",
  groundskeeper:"landscape", "grounds keeper":"landscape",
  gardener:"landscape", "irrigation technician":"landscape",
  "tree trimmer":"landscape", arborist:"landscape",
  "sod installer":"landscape", mulcher:"landscape",
  // Construction
  carpenter:"construction", electrician:"construction",
  plumber:"construction", welder:"construction",
  roofer:"construction", mason:"construction",
  laborer:"construction", "general laborer":"construction",
  painter:"construction", drywaller:"construction",
  "concrete worker":"construction", "paving worker":"construction",
  "hvac technician":"construction",
  // Housekeeper / Hotel
  housekeeper:"housekeeper", maid:"housekeeper",
  "room attendant":"housekeeper", "hotel cleaner":"housekeeper",
  "front desk":"housekeeper", bellman:"housekeeper",
  "night auditor":"housekeeper", "laundry attendant":"housekeeper",
  // Cleaning
  janitor:"cleaning", custodian:"cleaning",
  "office cleaner":"cleaning", "building cleaner":"cleaning",
  "sanitation worker":"cleaning", "janitorial":"cleaning",
  // Warehouse
  "warehouse worker":"warehouse", picker:"warehouse",
  packer:"warehouse", "picker packer":"warehouse",
  "shipping clerk":"warehouse", "receiving clerk":"warehouse",
  "order picker":"warehouse", "stock clerk":"warehouse",
  // Seafood
  "seafood processor":"seafood", "fish processor":"seafood",
  "crab picker":"seafood", "oyster shucker":"seafood",
  "shrimp peeler":"seafood", "fish cutter":"seafood",
  // Farm / H-2A
  "farm worker":"farm", farmhand:"farm", "field worker":"farm",
  harvester:"farm", "harvest worker":"farm",
  "greenhouse worker":"farm", "dairy worker":"farm",
  "poultry worker":"farm", "crop worker":"farm",
  // Golf
  greenskeeper:"golf", "golf course worker":"golf",
  caddie:"golf", "golf attendant":"golf",
  // Lifeguard / Pool
  lifeguard:"lifeguard", "pool attendant":"lifeguard",
  "aquatic staff":"lifeguard", "swim instructor":"lifeguard",
  // Amusement
  "ride operator":"amusement", "camp counselor":"amusement",
  "carnival worker":"amusement", "recreation worker":"amusement",
  // Forest
  "timber worker":"forest", "tree planter":"forest",
  "reforestation worker":"forest", "logging worker":"forest",
  // Ski
  "ski instructor":"ski", "lift operator":"ski",
  "snow groomer":"ski", "ski patrol":"ski",
  "snowboard instructor":"ski",
};

const CATEGORY_KEYWORDS = {
  landscape:    ["landscape","lawn","turf","grass","grounds","mowing","garden","tree","arborist","nursery","sod","irrigation","mulch","shrub"],
  construction: ["construction","concrete","masonry","roofing","gutter","excavat","paving","asphalt","electrical","plumb","hvac","demolit","contractor","builder"],
  housekeeper:  ["hotel","resort","hospitality","inn","lodge","motel","housekeeper","laundry","maid"],
  seafood:      ["seafood","fish","crab","lobster","oyster","shrimp","vessel","marine","aqua","shellfish"],
  farm:         ["farm","agri","crop","harvest","orchard","ranch","dairy","livestock","poultry"],
  golf:         ["golf","country club"],
  amusement:    ["amusement","carnival","fair","theme park","waterpark","camp"],
  forest:       ["forest","timber","logging","reforestation"],
  lifeguard:    ["lifeguard","pool","aquatic","swim"],
  food:         ["restaurant","grill","tavern","cantina","bistro","brewpub","cafeteria","diner","foodservice","food service","bartend","catering"],
  driver:       ["trucking","transport","delivery","logistics","courier","freight","shipping","cdl"],
  cleaning:     ["cleaning service","janitorial","custodial","sanitation","housecleaning"],
  warehouse:    ["warehouse","distribution","fulfillment","logistics center","storage","distribution center"],
  ski:          ["ski ","snowboard","winter resort","mountain resort"],
};

function detectCategoryFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase().trim();
  // Exact match first
  if (JOB_TITLE_TO_CAT[t]) return JOB_TITLE_TO_CAT[t];
  // Partial match
  for (const [kw, cat] of Object.entries(JOB_TITLE_TO_CAT)) {
    if (t.includes(kw) || kw.includes(t)) return cat;
  }
  return null;
}

function detectCategoryFromEmployer(name) {
  if (!name) return "other";
  const n = name.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => n.includes(k))) return cat;
  }
  return "other";
}

function detectCategoryBest(title, employer) {
  return detectCategoryFromTitle(title) || detectCategoryFromEmployer(employer) || "other";
}

// ═══ 🌾 v338 (achado de auditoria contínua — raiz do bug do v332) ═══
// detectCategoryBest() acima só conhece a taxonomia H-2B — o v332
// (server.js) já tinha diagnosticado isso ("build-sheets.js#detectCategoryBest
// ... também só conhece a mesma taxonomia H-2B") mas só corrigiu os 2
// CHAMADORES de toCompact() em mod-planilhas.js (runDolColeta/
// runH2aNovasCycle), sobrescrevendo c.k DEPOIS da chamada — nunca a
// PRÓPRIA toCompact(), a função que categoriza TODA vaga nova, aqui neste
// arquivo. Isso deixava 2 buracos: (1) o build/main() standalone deste
// arquivo (buildSheet("h2a",...) — o cron do cabeçalho, ou "node
// build-sheets.js" manual) nunca ganhava a correção; (2) qualquer chamador
// FUTURO de bs.toCompact() que esquecesse de repetir a sobrescrita
// herdaria o mesmo bug calado. Corrigido na RAIZ: toCompact() agora decide
// o categorizador pelo `visa` que ela mesma já calcula (prefixo do case
// number), a MESMA régua H2A_CATEGORY_RULES de server.js copiada aqui
// (não há módulo compartilhado sem carregar o servidor inteiro — NUNCA
// deixar divergir das regras de server.js). As sobrescritas em
// mod-planilhas.js continuam existindo como defesa em profundidade
// (idempotentes — recalculam o mesmo valor), nunca removidas por causa
// disso.
const _catH2ARegexCache = new Map();
const _normTituloH2A = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
function _chaveInteiraH2A(texto, chave) {
  let re = _catH2ARegexCache.get(chave);
  if (!re) { re = new RegExp("(?:^| )" + chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, " ") + "s?(?: |$)"); _catH2ARegexCache.set(chave, re); }
  return re.test(texto);
}
const H2A_CATEGORY_RULES = [
  ["sheepherder", ["sheepherder", "goatherder", "goat sheepherder", "sheep herder", "cattleherder", "cattle herder", "range herder", "livestock herder", "stocker herder", "calver stocker"]],
  ["mechanic", ["mechanic", "equipment mechanic", "service technician", "installation maintenance and repair", "maintenance and repair worker"]],
  ["ironworker", ["structural steel worker", "ironworker", "iron worker"]],
  ["carpenter", ["carpenter", "carpenter helper"]],
  ["fence", ["fence installer", "fence builder", "fencer"]],
  ["equipment_op", ["equipment operator", "ag equipment operator", "agricultural equipment operator", "harvest equipment operator", "harvest eq operator"]],
  ["truck_driver", ["truck driver", "cdl driver"]],
  ["driver", ["shuttle driver", "chauffeur", "bus driver", "van driver", "field walker"]],
  ["grader_sorter", ["grader", "sorter", "grader sorter"]],
  ["packer", ["packer", "packaging worker", "packers and packagers", "bag stacker"]],
  ["cook", ["cook", "camp cook", "cafeteria"]],
  ["meat", ["butcher", "slaughter", "meat processing", "meat cutter"]],
  ["inspector", ["inspector"]],
  ["supervisor", ["supervisor", "crew leader", "crew boss", "farm manager"]],
  ["irrigation", ["irrigator", "irrigation worker", "irrigation laborer"]],
  ["nursery", ["nursery worker", "greenhouse worker", "plant nursery"]],
  ["construction", ["construction laborer", "construction worker", "framer", "farm construction", "farm facility construction", "const labor"]],
  ["logging", ["logging worker", "timber worker", "forestry worker", "reforestation"]],
  ["livestock", ["livestock", "dairy", "cattle", "rancher", "ranch worker", "ranch hand", "beekeeper", "poultry", "hog", "swine", "hydroponic"]],
];
function detectCategoryH2A(titulo) {
  const t = _normTituloH2A(titulo);
  if (t) for (const [cat, frases] of H2A_CATEGORY_RULES) {
    for (const frase of frases) { if (_chaveInteiraH2A(t, frase)) return cat; }
  }
  return "crop";
}

// ─── Filtros de qualidade ───────────────────────────────────────────────────
const DISCARD_STATUSES = ["denied","withdrawn","invalidated"];

function shouldDiscard(rec) {
  // Tem URL de aplicação → candidato só pode aplicar pelo site, não por email
  if (rec.apply_url && rec.apply_url.trim() && rec.apply_url !== "N/A") return true;
  // Sem email nenhum → impossível aplicar
  const email = (rec.apply_email && rec.apply_email !== "N/A") ? rec.apply_email
              : (rec.employer_email && rec.employer_email !== "N/A") ? rec.employer_email : "";
  if (!email || !email.includes("@")) return true;
  // Status descartável
  const st = (rec.case_status || "").toLowerCase();
  if (DISCARD_STATUSES.some(d => st.includes(d))) return true;
  return false;
}

function toCompact(rec) {
  const email = (rec.apply_email && rec.apply_email !== "N/A") ? rec.apply_email.trim()
              : (rec.employer_email && rec.employer_email !== "N/A") ? rec.employer_email.trim() : "";
  const title = (rec.job_title || "").trim();
  const employer = (rec.employer_business_name || rec.employer_trade_name || "").trim();
  const state = (rec.worksite_state || rec.employer_state || "").toUpperCase().trim();
  const wage = rec.basic_rate_from ? String(parseFloat(rec.basic_rate_from).toFixed(2)) : "";
  // 💵 v316 — auditoria contínua achou este toCompact() (usado de verdade por
  // runDolColeta/runH2aNovasCycle em mod-planilhas.js) com uma cópia BUGADA e
  // mais velha do mapeamento que o v182 LOTE 8 já tinha corrigido em
  // mod-planilhas.js: só tratava "Month" (perdendo Week/Bi-Weekly/Year/Piece
  // Rate — todos viravam "hora" na régua única de salário) e, pro próprio
  // "Month", gravava "mês" em vez do código canônico "mo" — wageHora()
  // (mod-filtros.js) confere com un.startsWith("mo"), então "mês" NUNCA
  // batia e o valor mensal também caía errado no fallback genérico de hora.
  // Reusa unidadeSalario() — nunca uma 3ª tabela duplicada.
  const wunit = unidadeSalario(rec.pay_range_desc) || "h";
  const workers = parseInt(rec.total_positions || 0) || 0;
  const caseNum = (rec.case_number || rec.case_id || "").trim();
  const visa = caseNum.startsWith("H-300") ? "H-2A"
             : caseNum.startsWith("H-400") ? "H-2B"
             : (rec.visa_class || "H-2B");

  const city = (rec.worksite_city || rec.employer_city || "").trim();
  const beginDate = (rec.begin_date || rec.start_date || "").slice(0, 10);
  const endDate   = (rec.end_date || rec.expiration_date || "").slice(0, 10);
  // 🌾 v338: categorizador pelo VISTO que a própria função já calculou —
  // ver comentário acima de H2A_CATEGORY_RULES.
  const category = visa === "H-2A" ? detectCategoryH2A(title) : detectCategoryBest(title, employer);
  return {
    c:  caseNum,
    t:  title,
    n:  employer,
    s:  state,
    ci: city,          // cidade
    d:  beginDate,     // data início
    de: endDate,       // data fim
    e:  email,
    w:  wage,
    wunit,
    wk: workers,
    k:  category,
    visa,
    st: (rec.case_status || "").trim(),
  };
}

// ─── Download helpers ──────────────────────────────────────────────────────
function download(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "H2BApply-BuildSheets/1.0" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

async function downloadAndParse(url) {
  console.log(`  ↓ GET ${url}`);
  const buf = await download(url);
  // Detect if gzip/zip
  let data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // gzip
    data = zlib.gunzipSync(buf);
  } else if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP — extrair primeiro arquivo JSON usando unzip nativo
    const tmpZip = path.join(os.tmpdir(), `dol_feed_${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, buf);
    const { execSync } = require("child_process");
    // v121d (bug real em produção, 08/08: "spawnSync /bin/sh ENOBUFS" nos 6
    // feeds da bimestral): o maxBuffer padrão do execSync é 1MB e o JSON
    // descompactado do feed H-2A passa fácil disso — TODA extração de feed
    // precisa do maxBuffer alto, senão o download morre depois de baixar.
    const EXEC_MAX = 512 * 1024 * 1024;
    try {
      const list = execSync(`unzip -Z1 "${tmpZip}"`, { maxBuffer: EXEC_MAX }).toString().trim().split("\n");
      const jsonFile = list.find(f => f.endsWith(".json") || f.endsWith(".JSON"));
      if (!jsonFile) throw new Error("No JSON inside ZIP");
      const jsonBuf = execSync(`unzip -p "${tmpZip}" "${jsonFile.trim()}"`, { maxBuffer: EXEC_MAX });
      data = jsonBuf;
    } finally {
      try { fs.unlinkSync(tmpZip); } catch(_) {}
    }
  } else {
    data = buf;
  }
  return JSON.parse(data.toString("utf8"));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function buildSheet(type, dateStr, outFile, label) {
  console.log(`\n[${label}] Baixando feed ${type} para ${dateStr}...`);
  const url = getFeedUrl(type, dateStr);
  let raw;
  try {
    raw = await downloadAndParse(url);
  } catch(e) {
    console.error(`  ❌ Falha no download: ${e.message}`);
    console.log(`  ↩ Mantendo arquivo existente: ${outFile}`);
    return false;
  }

  // O feed pode ser um array diretamente ou ter propriedade com o array
  const records = Array.isArray(raw) ? raw
    : (raw.data || raw.results || raw.items || raw.cases || []);

  console.log(`  📥 ${records.length} registros brutos`);

  // ── 🔑 DEDUPE POR ETA CASE NUMBER (a vaga é o case number, não a linha) ──
  // O feed usa "case_number" (ou, em versões antigas, "case_id"). Normaliza
  // num campo próprio (_cn) só para o dedupe funcionar independente de qual
  // dos dois nomes veio nesta resposta específica do DOL.
  for (const rec of records) {
    rec._cn = (rec.case_number || rec.case_id || "").trim().toUpperCase();
  }
  const { rows: uniqueRecords, uniqueCount, totalIn, duplicatesMerged, rowsWithoutCase } =
    dedupeVagas(records, { caseField: "_cn" });
  console.log(`  🔑 ${totalIn} registros brutos → ${uniqueCount} ETA Case Numbers únicos`
    + (duplicatesMerged ? ` (${duplicatesMerged} duplicados mesclados, nenhum dado perdido)` : "")
    + (rowsWithoutCase ? ` — ${rowsWithoutCase} registro(s) sem case number descartado(s)` : ""));

  let discarded = 0;
  const compact = [];
  for (const rec of uniqueRecords) {
    if (shouldDiscard(rec)) { discarded++; continue; }
    compact.push(toCompact(rec));
  }

  console.log(`  ✅ ${compact.length} vagas válidas (${discarded} descartadas por regra de qualidade)`);

  // Validação mínima: se retornou menos de 10 vagas válidas, algo está errado
  // (API pode ter retornado estrutura diferente ou estar com problemas).
  // Isto é um PISO de sanidade contra resposta quebrada da API — nunca um
  // teto: a planilha final sempre reflete a quantidade REAL de vagas únicas
  // encontradas na fonte, seja ela 2 mil ou 8 mil.
  if (compact.length < 10) {
    console.error(`  ❌ ABORTANDO salvamento: apenas ${compact.length} vagas válidas — suspeito de resposta inválida da API`);
    console.log(`  ↩ Mantendo arquivo existente intacto: ${outFile}`);
    return false;
  }

  // ── 🔒 GUARDA FINAL — nunca publicar planilha com duplicata ──
  const check = verifyIntegrity(compact, { caseField: "c" });
  if (!check.ok) {
    console.error(`  ❌ ABORTANDO salvamento: guarda de integridade encontrou ${check.duplicateCases.length} case number(s) duplicado(s) e/ou ${check.rowsWithoutCase} linha(s) sem case number MESMO APÓS o dedupe — isto não deveria acontecer; revisar mod-vagas-integrity.js.`);
    console.log(`  ↩ Mantendo arquivo existente intacto: ${outFile}`);
    return false;
  }

  // Distribuição de categorias
  const catCount = {};
  compact.forEach(r => { catCount[r.k] = (catCount[r.k] || 0) + 1; });
  const sorted = Object.entries(catCount).sort((a, b) => b[1] - a[1]);
  console.log(`  📊 Categorias:`);
  sorted.forEach(([k, v]) => console.log(`     ${k.padEnd(14)} ${v}`));

  fs.writeFileSync(outFile, JSON.stringify(compact));
  console.log(`  💾 Salvo: ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);

  // ── 🧾 MANIFESTO — recibo de integridade ao lado do arquivo ──
  // Prova, sem reprocessar nada, que "baixado" === "publicado": mesma
  // quantidade E mesmo conjunto exato de ETA case numbers.
  const manifestFile = outFile.replace(/\.json$/, ".manifest.json");
  const manifest = buildManifest(compact, {
    caseField: "c",
    extra: { feedUrl: url, feedType: type, feedDate: dateStr, label },
  });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`  🧾 Manifesto: ${manifestFile} (${manifest.uniqueCaseCount} vagas únicas, hash ${manifest.caseListHash.slice(0, 12)}…)`);

  return true;
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log(" H2BApply — build-sheets.js v36 (dedupe por ETA case number)");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════");

  // Data atual para o feed H-2B (NOA últimos 20 dias)
  const today = new Date().toISOString().slice(0, 10);
  // Para H-2A, usa data atual também
  const julDate = today;

  let ok1 = await buildSheet("h2b", today, OUT_JAN, "H-2B jan2026");
  let ok2 = await buildSheet("h2a", julDate, OUT_JUL, "H-2A jul2025");

  console.log("\n═══════════════════════════════════════════");
  if (ok1 && ok2) {
    console.log(" ✅ Build concluído com sucesso!");
  } else {
    console.log(" ⚠️  Build concluído com avisos (verifique erros acima)");
  }
  console.log("═══════════════════════════════════════════\n");
}

// v35: quando importado pelo server.js (bot de coleta do admin), exporta os
// helpers e NÃO roda o main — o mesmo caminho de download/formato serve o
// cron standalone E o botão do painel, sem duplicar lógica.
if (require.main === module) {
  main().catch(e => {
    console.error("ERRO FATAL:", e);
    process.exit(1);
  });
}
module.exports = { DOL_BASE, downloadAndParse, toCompact, shouldDiscard, detectCategoryBest, detectCategoryH2A };
