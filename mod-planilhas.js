/* ═══════════════════════════════════════════════════════════════════════
   📋 mod-planilhas.js — ALIMENTAÇÃO AUTOMÁTICA DAS PLANILHAS (v174, 13/09/2026)
   Ordem do dono: "as planilhas devem ser alimentadas, igual elas já são hoje,
   com todas as informações de cada vaga — esse sistema você pode trazer do
   h2bapply.com antigo, ele coletava as informações automaticamente da
   planilha e deixava organizado".

   Portado do site antigo (New-repository, congelado no v151) — mesmas regras
   de casa (13, 13p, 13p2, KB-078), mesmos nomes de estado/log, com injeção
   de dependências (padrão mod-sentinel/mod-cerebro). 5 robôs:
   • ENRIQUECIMENTO (_runEnrichBot/autoEnrichCycle): pra cada ETA case number
     sem e-mail, consulta a API do DOL e preenche e-mail, cidade, datas,
     nº de vagas, telefone, salário, SOC, descrição, horas, URL… Educado
     com o DOL (1 vaga por vez, backoff em 403/429, rotação de User-Agent),
     salva no disco a CADA vaga (sobrevive a deploy), retoma de onde parou.
   • FRESCOR (_runFreshCycle): confere status/datas/salário das vagas JÁ
     completas das planilhas mais recentes (H-2B mais nova + H-2A), lote
     limitado, uma planilha por ciclo.
   • VAGAS NOVAS H-2A (_runH2aNovasCycle): 2x/dia baixa o feed h2a do dia,
     ENTRA vaga ativa nova (nunca duplica) e SAI inativa (negada/retirada/
     temporada encerrada) — trava anti-catástrofe se >50% sumiria de uma vez.
   • COLETA DO DOL (_runDolColeta): baixa feeds ZIP do datahub, dedupa por
     case number, filtro de qualidade, integridade, salva em RASCUNHO
     (publicar é do admin — KB-078) ou auto-publica quando autorizado.
   • PLANILHAS DO MÊS (_runPlanilhaMensal → H-2A e H-2B): todo mês nasce a
     "H-2A <Mês> <Ano>" (auto-publica acima do mínimo — exceção autorizada
     por escrito, 13p) e a "H-2B <Mês> <Ano>" (SEMPRE rascunho — 13p2).
   Todo robô: erro só loga e avisa admin por push — nunca derruba o servidor;
   planilha anterior fica intacta se a coleta falhar.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

function createPlanilhas(deps) {
  const {
    fs, path, DATA_DIR, SHEETS_DIR, SHEETS_META_FILE,
    getSheet,            // (key) → rows (jan2026/jul2025/h2a-jun2026/extras)
    getSheetH2A, setSheetH2A,
    getExtras,           // () → SHEET_EXTRAS (objeto vivo)
    getMeta,             // () → DB_SHEETS_META (objeto vivo)
    enrichBot,           // objeto de estado do bot (server.js: _enrichBot)
    enrichLog,           // (msg,type) → log do bot + botLog
    saveSheet,           // (key, rows) → grava planilha (atômico, /data)
    httpsReq,            // ({hostname,path,method,headers}) → {status,body}
    botLog, pushToUser, ADMIN_EMAILS,
    detectCategory, dedupe, verify, manifest,
    notificarRadares, latestH2bKey,
    isTest,              // true no npm test (TEST_LOGIN_TOKEN) — agendadores desligados
  } = deps;

  const saveMeta = () => { try { fs.writeFileSync(SHEETS_META_FILE, JSON.stringify(getMeta(), null, 2)); } catch (e) { console.warn("[planilhas] meta não gravado:", e.message); } };
  const hoje = () => new Date().toISOString().slice(0, 10);
  const DEAD_ST = /denied|withdrawn|invalidat|expired|cancel/i;
  const DOL_HDR = () => ({ "Accept": "application/json", "Accept-Encoding": "gzip", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Cache-Control": "no-cache", "Referer": "https://seasonaljobs.dol.gov/" });

  // ══════════════════════════════════════════════════════════════════════
  //  🤖 BOT DE ENRIQUECIMENTO — 1 vaga por vez na API do DOL
  // ══════════════════════════════════════════════════════════════════════
  const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  ];
  // Aplica na linha da planilha TUDO que a página do seasonaljobs mostra.
  function aplicarDolNaLinha(row, dol) {
    row.ci = (dol.worksite_city || dol.employer_city || row.ci || "").trim();
    row.st_ab = (dol.worksite_state || dol.employer_state || row.st_ab || "").trim();
    row.addr = (dol.worksite_address || dol.employer_address || row.addr || "").trim();
    row.zip = (dol.worksite_postal_code || dol.employer_postal_code || row.zip || "").trim();
    row.d = (dol.begin_date || dol.start_date || row.d || "").slice(0, 10);
    row.de = (dol.end_date || dol.expiration_date || row.de || "").slice(0, 10);
    row.wk = parseInt(dol.total_positions || dol.nbr_workers_requested || 0) || row.wk || 0;
    row.w = row.w || (dol.basic_rate_from ? String(parseFloat(dol.basic_rate_from).toFixed(2)) : "");
    row.wmax = dol.basic_rate_to ? String(parseFloat(dol.basic_rate_to).toFixed(2)) : (row.wmax || "");
    row.wunit = row.wunit || (dol.pay_range_desc === "Month" ? "mo" : "h");
    row.winfo = (dol.wage_offer_description || dol.additional_wage_information || row.winfo || "").slice(0, 300);
    row.ph = String(dol.apply_phone || dol.employer_phone || row.ph || "").replace(/[^0-9+()\- ]/g, "").trim();
    row.ph2 = String(dol.employer_phone || row.ph2 || "").replace(/[^0-9+()\- ]/g, "").trim();
    row.site = (dol.employer_website || dol.apply_url || row.site || "").trim();
    row.s = (dol.worksite_state || dol.employer_state || row.s || "").toUpperCase().trim();
    if (dol.job_title) row.t = String(dol.job_title).trim();
    row.n = (dol.employer_business_name || dol.employer_trade_name || row.n || "").trim();
    row.st = (dol.case_status || row.st || "").trim();
    row.soc = (dol.soc_code || dol.onet_code || row.soc || "").trim();
    row.socT = (dol.soc_title || row.socT || "").trim();
    if (dol.job_duties) row.desc = String(dol.job_duties).replace(/\*\*[^*]+\*\*/g, "").trim().slice(0, 1500);
    row.exp = dol.experience_required === "Yes" ? 1 : 0;
    row.req = (dol.special_requirements || row.req || "").slice(0, 400);
    row.hrs = dol.nbr_hours_per_week ? String(dol.nbr_hours_per_week) : (row.hrs || "");
    row.sched = (dol.work_schedule || row.sched || "").trim();
    row.ft = dol.full_time_position === "Yes" ? "sim" : (row.ft || "");
    row.url = `https://seasonaljobs.dol.gov/jobs/${row.c}`;
    row.visa = String(row.c || "").startsWith("H-300") ? "H-2A" : String(row.c || "").startsWith("H-400") ? "H-2B" : (row.visa || "H-2B");
    const emails = [dol.apply_email, dol.employer_email, dol.employer_poc_email, dol.attorney_agent_email, dol.employer_contact_email]
      .map(e => String(e || "").trim().toLowerCase()).filter(e => e && e.includes("@") && !e.startsWith("n/a"));
    if (!row.e && emails.length) row.e = emails[0];
    return emails;
  }

  async function runEnrichBot(sheetKey, resume = false) {
    if (enrichBot.running && !resume) { enrichLog("Bot já está rodando", "warn"); return; }
    const sheet = getSheet(sheetKey);
    if (!sheet || !sheet.length) { enrichLog(`Planilha não encontrada: ${sheetKey}`, "error"); return; }
    // ponto de retomada REAL pelo disco: quantas já têm e-mail
    const alreadyDone = sheet.filter(r => r.e && String(r.e).includes("@")).length;
    const startIdx = resume ? Math.max(0, alreadyDone > 0 ? alreadyDone - 5 : 0) : 0;
    enrichBot.running = true; enrichBot.sheetKey = sheetKey; enrichBot.total = sheet.length; enrichBot.done = startIdx;
    enrichBot.ok = resume ? alreadyDone : 0; enrichBot.noEmail = resume ? (enrichBot.noEmail || 0) : 0; enrichBot.errors = resume ? (enrichBot.errors || 0) : 0;
    enrichBot.startedAt = (resume && enrichBot.startedAt) ? enrichBot.startedAt : Date.now();
    enrichBot.log = resume ? enrichBot.log : []; enrichBot.savedAt = null;
    enrichLog(`📌 Ponto de retomada: ${startIdx}/${sheet.length} (${alreadyDone} vagas já têm email no disco)`, "info");
    enrichLog(`🚀 Bot iniciado: ${sheet.length} vagas — planilha "${sheetKey}"${resume ? ` (retomando de ${startIdx})` : ""}`, "ok");
    enrichLog("🔍 Buscando: email, cidade, datas, workers, telefone, funções, URL", "info");
    let uaIdx = Math.floor(Math.random() * USER_AGENTS.length);
    const getHDR = () => { uaIdx = (uaIdx + 1) % USER_AGENTS.length; return { ...DOL_HDR(), "User-Agent": USER_AGENTS[uaIdx], "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", "Pragma": "no-cache", "Origin": "https://seasonaljobs.dol.gov", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-site" }; };
    let interDelay = 800, consecutive403 = 0;
    for (let i = startIdx; i < sheet.length; i++) {
      if (!enrichBot.running) break;
      const row = sheet[i]; const cn = String(row.c || "").toUpperCase(); enrichBot.done = i + 1;
      // pula quem JÁ está completo (e-mail + cidade) — nunca gasta DOL à toa
      if (row.e && String(row.e).includes("@") && row.ci && !resume) { enrichBot.ok++; continue; }
      let attempt = 0, processed = false;
      while (attempt < 6 && !processed && enrichBot.running) {
        if (attempt > 0) {
          const waitMs = Math.min(15000 * Math.pow(2, attempt - 1), 240000);
          enrichLog(`⏳ [${i + 1}/${sheet.length}] ${cn} — retry ${attempt}/5, aguardando ${Math.round(waitMs / 1000)}s...`, "warn");
          await new Promise(r => setTimeout(r, waitMs));
          if (!enrichBot.running) break;
        }
        attempt++;
        try {
          const params = new URLSearchParams({ "api-version": "2020-06-30" });
          params.append("$filter", `case_number eq '${row.c}'`); params.append("$top", "1");
          const { status, body } = await httpsReq({ hostname: "api.seasonaljobs.dol.gov", path: "/datahub/?" + params, method: "GET", headers: getHDR() });
          if (status === 200) {
            consecutive403 = 0; if (interDelay > 800) interDelay = Math.max(800, interDelay - 300);
            const raw = body?.value || body?.results || body?.data || (Array.isArray(body) ? body : []);
            const dol = raw[0] || null; processed = true;
            if (dol) {
              const tinhaEmail = !!row.e;
              aplicarDolNaLinha(row, dol);
              if (!tinhaEmail && row.e) enrichLog(`📧 [${i + 1}/${sheet.length}] ${cn}: email → ${row.e}`, "ok");
              enrichBot.ok++;
              if (!row.e || !String(row.e).includes("@")) { enrichBot.noEmail++; enrichLog(`⚠️ [${i + 1}/${sheet.length}] ${cn} SEM EMAIL | ${(row.t || "?").slice(0, 40)} | ${row.ci || row.s || "?"}`, "warn"); }
              else enrichLog(`✅ [${i + 1}/${sheet.length}] ${cn} | ${(row.t || "?").slice(0, 35)} | ${row.ci || "?"}, ${row.s || "?"} | $${row.w || "?"}/h | ${row.e}`, "info");
            } else { enrichBot.errors++; enrichLog(`❌ [${i + 1}/${sheet.length}] ${cn} — não encontrado no DOL`, "warn"); }
          } else if (status === 403 || status === 429) {
            consecutive403++; interDelay = Math.min(3000 + consecutive403 * 500, 8000);
            enrichLog(`🚫 [${i + 1}/${sheet.length}] ${cn} — HTTP ${status} (bloqueio DOL, tentativa ${attempt}/5, delay→${interDelay}ms)`, "warn");
          } else { processed = true; enrichBot.errors++; enrichLog(`⚠️ [${i + 1}/${sheet.length}] ${cn} — DOL retornou HTTP ${status}`, "warn"); }
        } catch (e) {
          if (attempt < 6) enrichLog(`🔌 [${i + 1}/${sheet.length}] ${cn} — erro de rede (retry ${attempt}/5): ${e.message}`, "warn");
          else { processed = true; enrichBot.errors++; enrichLog(`❌ [${i + 1}/${sheet.length}] ${cn} — falhou após 5 tentativas: ${e.message}`, "error"); }
        }
      }
      if (!processed && enrichBot.running) { enrichBot.errors++; enrichLog(`❌ [${i + 1}/${sheet.length}] ${cn} — desistindo após 5 tentativas (DOL bloqueando)`, "error"); }
      saveSheet(sheetKey, sheet); enrichBot.savedAt = Date.now();
      if (enrichBot.done % 10 === 0) enrichLog(`💾 [${enrichBot.done}/${sheet.length}] ${Math.round((enrichBot.done / sheet.length) * 100)}% — ok:${enrichBot.ok} semEmail:${enrichBot.noEmail} delay:${interDelay}ms`, "ok");
      await new Promise(r => setTimeout(r, interDelay));
    }
    enrichBot.done = sheet.length; enrichBot.running = false;
    saveSheet(sheetKey, sheet); enrichBot.savedAt = Date.now();
    const meta = getMeta();
    if (!meta[sheetKey]) meta[sheetKey] = { name: sheetKey };
    meta[sheetKey].enriched = enrichBot.ok; meta[sheetKey].enrichedAt = Date.now(); meta[sheetKey].enrichedTotal = enrichBot.total;
    saveMeta();
    const semEmail = sheet.filter(r => !r.e || !String(r.e).includes("@")).length;
    enrichLog(`🏁 CONCLUÍDO! ok:${enrichBot.ok} | semEmail:${semEmail} | erros:${enrichBot.errors}`, "ok");
  }

  // Ciclo autônomo: toda planilha com vaga SEM e-mail entra na fila do bot
  // (progresso REAL pelo disco, nunca por carimbo — deploy no meio não mente).
  async function autoEnrichCycle() {
    if (enrichBot.running) return;
    if (isTest) { console.log("[auto-enrich] 🧪 modo teste — o DOL não é alcançável no sandbox; enriquecimento só em produção"); return; }
    const keys = ["jan2026", "jul2025", ...Object.keys(getExtras())];
    for (const sheetKey of keys) {
      if (enrichBot.running) break;
      const sheet = getSheet(sheetKey); if (!sheet || !sheet.length) continue;
      const withEmail = sheet.filter(r => r.e && String(r.e).includes("@")).length;
      const withoutEmail = sheet.length - withEmail;
      const meta = getMeta();
      if (withoutEmail === 0) {
        if (!meta[sheetKey]) meta[sheetKey] = { name: sheetKey };
        meta[sheetKey].enrichedAt = Date.now(); meta[sheetKey].enriched = withEmail; meta[sheetKey].enrichedTotal = sheet.length;
        saveMeta();
        console.log(`[auto-enrich] ${sheetKey}: ✅ 100% completo (${withEmail}/${sheet.length}) — nada a fazer`);
        continue;
      }
      const resume = withEmail > 0;
      console.log(`[auto-enrich] 🚀 ${sheetKey}: ${withoutEmail} pendentes (${Math.round((withEmail / sheet.length) * 100)}% completo)`);
      await runEnrichBot(sheetKey, resume).catch(e => console.error(`[auto-enrich] ${sheetKey}:`, e.message));
      if (keys.indexOf(sheetKey) < keys.length - 1) await new Promise(r => setTimeout(r, 60000)); // pausa entre planilhas
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  🔄 FRESCOR — status/datas/salário das vagas já completas (planilhas recentes)
  // ══════════════════════════════════════════════════════════════════════
  const freshBot = { running: false, sheetKey: null, checked: 0, changed: 0, lastRunAt: null };
  function aplicarFrescor(row, dol) {
    const before = JSON.stringify([row.st, row.d, row.de, row.w, row.wk, row.e]);
    if (dol.case_status) row.st = String(dol.case_status).trim();
    const d = (dol.begin_date || dol.start_date || ""); if (d) row.d = String(d).slice(0, 10);
    const de = (dol.end_date || dol.expiration_date || ""); if (de) row.de = String(de).slice(0, 10);
    const wk = parseInt(dol.total_positions || dol.nbr_workers_requested || 0); if (wk) row.wk = wk;
    if (dol.basic_rate_from) row.w = String(parseFloat(dol.basic_rate_from).toFixed(2));
    if (!row.e) {
      const ems = [dol.apply_email, dol.employer_email, dol.employer_poc_email, dol.attorney_agent_email, dol.employer_contact_email]
        .map(e => String(e || "").trim().toLowerCase()).filter(e => e && e.includes("@") && !e.startsWith("n/a"));
      if (ems.length) row.e = ems[0];
    }
    return JSON.stringify([row.st, row.d, row.de, row.w, row.wk, row.e]) !== before;
  }
  async function runFreshCycle() {
    if (enrichBot.running || freshBot.running) return; // enriquecimento tem prioridade
    const keys = [...new Set([latestH2bKey(), "h2a-jun2026"].filter(Boolean))];
    const meta = getMeta();
    let pick = null, oldest = Infinity;
    for (const k of keys) { const arr = getSheet(k); if (!arr || !arr.length) continue; const at = meta[k]?.freshAt || 0; if (at < oldest) { oldest = at; pick = k; } }
    if (!pick) return;
    const sheet = getSheet(pick);
    const cands = sheet.filter(r => r.c && r.e && String(r.e).includes("@"));
    cands.sort((a, b) => ((a.d ? 1 : 0) - (b.d ? 1 : 0)) || ((a.fq || 0) - (b.fq || 0)));
    const batch = cands.slice(0, 120);
    if (!batch.length) { if (!meta[pick]) meta[pick] = { name: pick }; meta[pick].freshAt = Date.now(); saveMeta(); return; }
    freshBot.running = true; freshBot.sheetKey = pick; freshBot.checked = 0; freshBot.changed = 0;
    botLog("planilha-fresca", "Planilha Sempre Fresca", `🚀 ${pick}: conferindo ${batch.length} vaga(s) no DOL (status/datas/salário)`, "info");
    let delay = 1500, errs = 0;
    try {
      for (const row of batch) {
        if (!freshBot.running || enrichBot.running) break;
        try {
          const params = new URLSearchParams({ "api-version": "2020-06-30" });
          params.append("$filter", `case_number eq '${row.c}'`); params.append("$top", "1");
          const { status, body } = await httpsReq({ hostname: "api.seasonaljobs.dol.gov", path: "/datahub/?" + params, method: "GET", headers: DOL_HDR() });
          if (status === 200) {
            const dol = (body?.value || body?.results || body?.data || [])[0] || null;
            if (dol && aplicarFrescor(row, dol)) freshBot.changed++;
            row.fq = Date.now(); freshBot.checked++; errs = 0; delay = Math.max(1500, delay - 200);
          } else if (status === 403 || status === 429) {
            errs++; delay = Math.min(60_000, delay * 2);
            botLog("planilha-fresca", "Planilha Sempre Fresca", `🚫 DOL bloqueou (HTTP ${status}) — desacelerando pra ${Math.round(delay / 1000)}s`, "warn");
          } else { errs++; row.fq = Date.now(); freshBot.checked++; }
          if (errs >= 6) { botLog("planilha-fresca", "Planilha Sempre Fresca", `⛔ ${errs} erros seguidos — parando este ciclo (volta no próximo)`, "warn"); break; }
        } catch (e) { errs++; if (errs >= 6) break; }
        await new Promise(r => setTimeout(r, delay));
      }
    } finally {
      freshBot.running = false; freshBot.lastRunAt = Date.now();
      if (freshBot.checked > 0) {
        try { saveSheet(pick, sheet); } catch (e) { botLog("planilha-fresca", "Planilha Sempre Fresca", `❌ erro ao salvar: ${e.message}`, "error"); }
        if (!meta[pick]) meta[pick] = { name: pick }; meta[pick].freshAt = Date.now(); saveMeta();
        botLog("planilha-fresca", "Planilha Sempre Fresca", `✅ ${pick}: ${freshBot.checked} conferida(s), ${freshBot.changed} atualizada(s) de verdade`, freshBot.changed ? "ok" : "info");
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  📥 COLETA "Nova Planilha do DOL" — feed ZIP do datahub → rascunho/publicada
  // ══════════════════════════════════════════════════════════════════════
  const dolColeta = { running: false, log: [], startedAt: 0, finishedAt: 0, key: null, count: 0, error: null, progress: 0 };
  function dcLog(msg, type) {
    dolColeta.log.push({ t: Date.now(), msg: String(msg).slice(0, 300), type: type || "info" });
    if (dolColeta.log.length > 200) dolColeta.log = dolColeta.log.slice(-200);
    console.log("[coleta]", msg);
  }
  async function runDolColeta({ visa, sheetKey, sheetName, beginFrom, beginTo, feedDates, visaStrict, autoPublishMin, publishedBy }) {
    dolColeta.running = true; dolColeta.log = []; dolColeta.startedAt = Date.now();
    dolColeta.finishedAt = 0; dolColeta.key = sheetKey; dolColeta.count = 0; dolColeta.error = null; dolColeta.progress = 0;
    try {
      const bs = require("./build-sheets.js");
      const base = (process.env.DOL_FEED_BASE || bs.DOL_BASE).replace(/\/$/, "");
      const type = visa === "H-2A" ? "h2a" : "h2b";
      const datas = (Array.isArray(feedDates) && feedDates.length ? feedDates : [hoje()]).slice(0, 8);
      dcLog(`🚀 Coleta iniciada: ${sheetName} (${visa}) — ${datas.length} feed(s): ${datas.join(", ")}`);
      const records = []; let feedsOk = 0, feedsDone = 0;
      for (const feedDate of datas) {
        const url = `${base}/${type}/${feedDate}`;
        try {
          const raw = await bs.downloadAndParse(url);
          const recs = Array.isArray(raw) ? raw : (raw.data || raw.results || raw.items || raw.cases || []);
          records.push(...recs); feedsOk++;
          dcLog(`📥 feed ${feedDate}: ${recs.length} registros brutos`);
        } catch (e) { dcLog(`⚠️ feed ${feedDate} falhou (${e.message}) — seguindo com os demais`, "warn"); }
        feedsDone++; dolColeta.progress = Math.round((feedsDone / datas.length) * 70);
        if (datas.length > 1) await new Promise(r => setTimeout(r, process.env.DOL_FEED_BASE ? 50 : 8000)); // educado com o DOL
      }
      if (!feedsOk) throw new Error("nenhum feed do DOL respondeu — nada foi salvo");
      dcLog(`📦 ${records.length} registros brutos no total (${feedsOk}/${datas.length} feeds ok)`);
      for (const rec of records) rec._cn = String(rec.case_number || rec.case_id || "").trim().toUpperCase();
      const { rows: uniq, uniqueCount, duplicatesMerged } = dedupe(records, { caseField: "_cn" });
      dcLog(`🔑 ${uniqueCount} ETA case numbers únicos${duplicatesMerged ? ` (${duplicatesMerged} duplicados mesclados, nenhum dado perdido)` : ""}`);
      let descartadas = 0, foraJanela = 0, outroVisto = 0; const compact = [];
      for (const rec of uniq) {
        if (bs.shouldDiscard(rec)) { descartadas++; continue; }
        const c = bs.toCompact(rec);
        if (visaStrict && String(c.visa || "").toUpperCase() !== visa) { outroVisto++; continue; }
        if (beginFrom && c.d && c.d < beginFrom) { foraJanela++; continue; }
        if (beginTo && c.d && c.d > beginTo) { foraJanela++; continue; }
        if (!c.k) c.k = detectCategory(`${c.n || ""} ${c.t || ""}`);
        compact.push(c);
      }
      dcLog(`✅ ${compact.length} vagas válidas (${descartadas} sem e-mail/qualidade${foraJanela ? `, ${foraJanela} fora da janela de datas` : ""}${outroVisto ? `, ${outroVisto} de outro visto` : ""})`);
      if (compact.length < 10) throw new Error(`só ${compact.length} vagas válidas — resposta suspeita do DOL, NADA foi salvo (planilha anterior intacta)`);
      dolColeta.progress = 85;
      const check = verify(compact, { caseField: "c" });
      if (!check.ok) throw new Error("guarda de integridade achou duplicata após o dedupe — NADA foi salvo");
      compact.forEach(r => { r._sheet = sheetKey; });
      if (!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHEETS_DIR, sheetKey + ".json"), JSON.stringify(compact));
      try { fs.writeFileSync(path.join(SHEETS_DIR, sheetKey + ".manifest.json"), JSON.stringify(manifest(compact, { caseField: "c", extra: { feedDates: datas, visa, sheetName } }), null, 2)); } catch { }
      getExtras()[sheetKey] = compact;
      const autoPub = typeof autoPublishMin === "number" && compact.length >= autoPublishMin;
      getMeta()[sheetKey] = { name: sheetName, key: sheetKey, emoji: visa === "H-2A" ? "🌾" : "📋", file: sheetKey + ".json", published: autoPub, visaType: visa,
        count: compact.length, uniqueCaseCount: compact.length, source: "coleta-feed", uploaded: Date.now(), ...(autoPub ? { publishedAt: Date.now(), publishedBy: publishedBy || "robô" } : {}) };
      saveMeta();
      dolColeta.count = compact.length; dolColeta.progress = 100;
      const comEmail = compact.filter(r => r.e && String(r.e).includes("@")).length;
      if (autoPub) { dcLog(`📢 Planilha PUBLICADA automaticamente: ${compact.length} vagas (${comEmail} com e-mail) — já disponível no Manual e no Automático.`); notificarRadares(compact, `Planilha nova ${sheetName}`).catch(() => { }); }
      else if (typeof autoPublishMin === "number") dcLog(`⚠️ Só ${compact.length} vagas válidas (mínimo pra publicar sozinho: ${autoPublishMin}) — ficou em RASCUNHO, revise no painel.`, "warn");
      else dcLog(`💾 Planilha salva em RASCUNHO: ${compact.length} vagas (${comEmail} já com e-mail). Revise e clique PUBLICAR pra liberar aos usuários.`);
      dcLog("🤖 O Enriquecimento automático completa os campos que faltarem (roda sozinho).");
    } catch (e) { dolColeta.error = e.message; dcLog(`❌ ${e.message}`, "error"); }
    dolColeta.running = false; dolColeta.finishedAt = Date.now();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  📅 PLANILHAS DO MÊS — núcleo único (H-2A auto-publica · H-2B rascunho)
  // ══════════════════════════════════════════════════════════════════════
  const H2A_BIM_FILE = path.join(DATA_DIR, "h2a_bimestral.json");
  const H2B_MEN_FILE = path.join(DATA_DIR, "h2b_mensal.json");
  const lerEstado = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { return {}; } };
  let DB_H2A_BIM = lerEstado(H2A_BIM_FILE), DB_H2B_MEN = lerEstado(H2B_MEN_FILE);
  const MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  async function runPlanilhaMensal(cfg, trigger, force, background) {
    if (dolColeta.running) return { ok: false, error: "já existe uma coleta rodando — tente de novo em alguns minutos" };
    const now = new Date(); const st0 = cfg.getState();
    if (!force && st0.lastRunAt) {
      const last = new Date(st0.lastRunAt);
      const meses = (now.getUTCFullYear() * 12 + now.getUTCMonth()) - (last.getUTCFullYear() * 12 + last.getUTCMonth());
      if (meses < 1) return { ok: false, skipped: true, error: `ainda não venceu — a deste mês (${st0.lastKey || "?"}) já foi gerada; a próxima sai sozinha no mês que vem` };
    }
    const key = `${cfg.prefix}-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!force && getMeta()[key]) return { ok: false, skipped: true, error: `planilha ${key} já existe` };
    const nome = `${cfg.visa} ${MESES_PT[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const feedDates = []; for (let i = 0; i < 6; i++) feedDates.push(new Date(now.getTime() - i * 18 * 86400_000).toISOString().slice(0, 10));
    botLog(cfg.botId, cfg.botNome, `${cfg.emoji} Montando "${nome}" (${trigger || "agendado"}): 6 feeds cobrindo 90 dias${cfg.autoPublish ? `, mínimo pra publicar sozinho: ${cfg.minPub} vagas` : " — fica em RASCUNHO pro admin revisar"}`, "info");
    const depois = async () => {
      if (dolColeta.error) {
        botLog(cfg.botId, cfg.botNome, `⚠️ Coleta da "${nome}" falhou: ${dolColeta.error} — nada foi salvo, tenta no próximo ciclo.`, "warn");
        for (const ae of ADMIN_EMAILS) pushToUser(ae, { type: "generic", title: `⚠️ Planilha "${nome}" falhou na coleta`, body: `${String(dolColeta.error).slice(0, 120)} — o robô tenta de novo em 12h, ou gere agora no painel.`, icon: "/icon-192.png", url: "/admin" }).catch(() => { });
        return { ok: false, error: dolColeta.error, key, nome };
      }
      const publicada = getMeta()[key]?.published === true;
      cfg.setState({ lastKey: key, lastRunAt: Date.now(), lastCount: dolColeta.count, lastPublished: publicada, lastTrigger: String(trigger || "") });
      botLog(cfg.botId, cfg.botNome, publicada
        ? `✅ "${nome}" no ar: ${dolColeta.count} vagas dos últimos 90 dias, publicada automaticamente (Manual + Automático). Próxima sai sozinha no mês que vem.`
        : cfg.autoPublish ? `⚠️ "${nome}" coletou só ${dolColeta.count} vagas (mínimo ${cfg.minPub}) — ficou em RASCUNHO pro admin revisar.`
          : `📝 "${nome}" pronta: ${dolColeta.count} vagas dos últimos 90 dias em RASCUNHO — revise e clique PUBLICAR no painel. Próxima sai sozinha no mês que vem.`, publicada ? "ok" : "warn");
      for (const ae of ADMIN_EMAILS) pushToUser(ae, { type: "generic",
        title: publicada ? `${cfg.emoji} Planilha "${nome}" publicada!` : cfg.autoPublish ? `⚠️ Planilha "${nome}" precisa de revisão` : `${cfg.emoji} Planilha "${nome}" pronta pra publicar`,
        body: publicada ? `${dolColeta.count} vagas ${cfg.visa} dos últimos 90 dias já no ar pro pessoal usar no Manual e no Automático.`
          : cfg.autoPublish ? `Coletou só ${dolColeta.count} vagas (mínimo ${cfg.minPub}) — ficou em rascunho, revise no painel.`
            : `${dolColeta.count} vagas ${cfg.visa} dos últimos 90 dias em rascunho — revise e clique PUBLICAR no painel.`,
        icon: "/icon-192.png", url: "/admin" }).catch(() => { });
      return { ok: true, key, nome, count: dolColeta.count, published: publicada };
    };
    const promessa = runDolColeta({ visa: cfg.visa, sheetKey: key, sheetName: nome, feedDates, visaStrict: true, ...(cfg.autoPublish ? { autoPublishMin: cfg.minPub } : {}), publishedBy: cfg.publishedBy })
      .then(depois).catch(e => { console.error(`[${cfg.botId}]`, e.message); return { ok: false, error: e.message, key, nome }; });
    if (background) return { ok: true, started: true, key, nome, minPub: cfg.minPub };
    return await promessa;
  }
  async function runH2aMensal(trigger, force, background) {
    return runPlanilhaMensal({ visa: "H-2A", prefix: "h2a", emoji: "🌾", botId: "h2a-bimestral", botNome: "Planilha H-2A Mensal",
      autoPublish: true, minPub: Math.max(5, parseInt(process.env.H2A_BIM_MIN_PUBLICAR || "200", 10) || 200), publishedBy: "robô-bimestral",
      getState: () => DB_H2A_BIM, setState: (st) => { DB_H2A_BIM = st; try { fs.writeFileSync(H2A_BIM_FILE, JSON.stringify(st, null, 2)); } catch { } } }, trigger, force, background);
  }
  async function runH2bMensal(trigger, force, background) {
    return runPlanilhaMensal({ visa: "H-2B", prefix: "h2b", emoji: "🧊", botId: "h2b-mensal", botNome: "Planilha H-2B Mensal",
      autoPublish: false, minPub: null, publishedBy: "robô-mensal",
      getState: () => DB_H2B_MEN, setState: (st) => { DB_H2B_MEN = st; try { fs.writeFileSync(H2B_MEN_FILE, JSON.stringify(st, null, 2)); } catch { } } }, trigger, force, background);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  🌾 VAGAS NOVAS H-2A — planilha H-2A sempre completa (entra nova, sai inativa)
  // ══════════════════════════════════════════════════════════════════════
  const h2aNovasBot = { running: false, lastRunAt: null, lastError: null, lastAdded: 0, totalAdded: 0, lastRemoved: 0, totalRemoved: 0, runs: 0 };
  async function runH2aNovasCycle(trigger) {
    if (h2aNovasBot.running) return { ok: false, error: "já rodando" };
    h2aNovasBot.running = true; h2aNovasBot.lastError = null;
    try {
      const bs = require("./build-sheets.js");
      const base = (process.env.DOL_FEED_BASE || bs.DOL_BASE).replace(/\/$/, "");
      const url = `${base}/h2a/${hoje()}`;
      botLog("h2a-novas", "Vagas Novas H-2A", `🌾 Conferindo vagas H-2A novas no DOL (${trigger || "agendado"})`, "info");
      const raw = await bs.downloadAndParse(url);
      const records = Array.isArray(raw) ? raw : (raw.data || raw.results || raw.items || raw.cases || []);
      for (const rec of records) rec._cn = String(rec.case_number || rec.case_id || "").trim().toUpperCase();
      const { rows: uniq } = dedupe(records, { caseField: "_cn" });
      let SHEET_H2A = getSheetH2A();
      const have = new Set(SHEET_H2A.map(r => String(r.c || "").trim().toUpperCase()));
      let descartadas = 0, jaTinha = 0, outroVisto = 0; const novas = [];
      for (const rec of uniq) {
        if (bs.shouldDiscard(rec)) { descartadas++; continue; }
        const c = bs.toCompact(rec);
        if (String(c.visa || "").toUpperCase() !== "H-2A") { outroVisto++; continue; }
        if (have.has(String(c.c || "").trim().toUpperCase())) { jaTinha++; continue; }
        if (!c.k) c.k = detectCategory(`${c.n || ""} ${c.t || ""}`);
        novas.push(c);
      }
      // sai inativa: (a) o feed traz o case com status morto → atualiza; (b) temporada acabou.
      const feedByCase = new Map(); for (const rec of uniq) feedByCase.set(String(rec._cn || ""), rec);
      let atualizadas = 0;
      for (const r of SHEET_H2A) {
        const rec = feedByCase.get(String(r.c || "").trim().toUpperCase()); if (!rec) continue;
        const c = bs.toCompact(rec);
        if (c.st && c.st !== r.st) { r.st = c.st; atualizadas++; }
        if (c.d && c.d !== r.d) r.d = c.d;
        if (c.de && c.de !== r.de) r.de = c.de;
      }
      const _hoje = hoje(); const antes = SHEET_H2A.length;
      const vivas = SHEET_H2A.filter(r => !DEAD_ST.test(String(r.st || "")) && !(r.de && /^\d{4}-\d{2}-\d{2}$/.test(r.de) && r.de < _hoje));
      let removidas = antes - vivas.length;
      if (removidas > antes * 0.5) { botLog("h2a-novas", "Vagas Novas H-2A", `🛡️ ${removidas} de ${antes} vagas dariam como inativas de uma vez — suspeito de dado quebrado, NENHUMA foi removida neste ciclo.`, "warn"); removidas = 0; }
      else if (removidas > 0) { SHEET_H2A = vivas; setSheetH2A(SHEET_H2A); }
      if (novas.length) {
        const chk = verify([...SHEET_H2A, ...novas], { caseField: "c" });
        if (!chk.ok) throw new Error(`integridade: duplicata após o merge (${chk.duplicateCases.length}) — NADA foi salvo`);
        SHEET_H2A.push(...novas);
        notificarRadares(novas, "Vagas novas H-2A").catch(() => { });
      }
      if (novas.length || removidas > 0 || atualizadas > 0) {
        saveSheet("h2a-jun2026", SHEET_H2A);
        botLog("h2a-novas", "Vagas Novas H-2A", `✅ Planilha sincronizada: +${novas.length} nova(s), −${removidas} inativa(s) retirada(s), ${atualizadas} status atualizado(s) — total ${SHEET_H2A.length}. (${jaTinha} do feed já estavam, ${descartadas} sem e-mail/qualidade)`, "ok");
        console.log(`[h2a-novas] ✅ +${novas.length} novas, -${removidas} inativas, ${atualizadas} atualizadas (total ${SHEET_H2A.length})`);
      } else botLog("h2a-novas", "Vagas Novas H-2A", `💤 Nada mudou desta vez (${jaTinha} do feed já estavam na planilha, ${descartadas} sem e-mail/qualidade).`, "info");
      h2aNovasBot.lastAdded = novas.length; h2aNovasBot.totalAdded += novas.length;
      h2aNovasBot.lastRemoved = removidas; h2aNovasBot.totalRemoved += removidas;
      h2aNovasBot.runs++; h2aNovasBot.lastRunAt = Date.now();
      return { ok: true, added: novas.length, removidas, atualizadas, jaTinha, descartadas, outroVisto, total: SHEET_H2A.length };
    } catch (e) {
      h2aNovasBot.lastError = e.message; h2aNovasBot.lastRunAt = Date.now();
      botLog("h2a-novas", "Vagas Novas H-2A", `⚠️ ${e.message} (planilha atual intacta — tenta de novo no próximo ciclo)`, "warn");
      return { ok: false, error: e.message };
    } finally { h2aNovasBot.running = false; }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ⏰ AGENDADORES — o pipeline se mantém sozinho (desligado no npm test:
  //  o sandbox não alcança o DOL e cada robô é provado pelas rotas com o
  //  feed falso; mesma filosofia da autonomia do Cérebro)
  // ══════════════════════════════════════════════════════════════════════
  const timers = [];
  function iniciarAgendadores() {
    if (isTest) { console.log("[planilhas] 🧪 modo teste — agendadores dos robôs de planilha desligados (disparo só por rota)"); return false; }
    const T = (ms, fn, nome) => timers.push(setTimeout(() => fn().catch(e => console.error(`[${nome}] boot erro:`, e.message)), ms));
    const I = (ms, fn, nome) => timers.push(setInterval(() => fn().catch(e => console.error(`[${nome}] ciclo erro:`, e.message)), ms));
    T(15_000, autoEnrichCycle, "auto-enrich"); I(12 * 3600_000, autoEnrichCycle, "auto-enrich"); I(30 * 60_000, autoEnrichCycle, "auto-enrich-watchdog");
    T(5 * 60_000, runFreshCycle, "planilha-fresca"); I(6 * 3600_000, runFreshCycle, "planilha-fresca");
    T(2 * 60_000, () => runH2aNovasCycle("boot"), "h2a-novas"); I(12 * 3600_000, () => runH2aNovasCycle("agendado"), "h2a-novas");
    T(8 * 60_000, () => runH2aMensal("boot"), "h2a-mensal"); I(12 * 3600_000, () => runH2aMensal("agendado"), "h2a-mensal");
    T(20 * 60_000, () => runH2bMensal("boot"), "h2b-mensal"); timers.push(setTimeout(() => I(12 * 3600_000, () => runH2bMensal("agendado"), "h2b-mensal"), 20 * 60_000));
    console.log("[planilhas] ⏰ robôs agendados: enriquecimento (15s, 12h, vigia 30min) · frescor (5min, 6h) · vagas novas H-2A (2min, 12h) · H-2A do mês (8min, 12h) · H-2B do mês (20min, 12h)");
    return true;
  }

  // Painel: TUDO numa chamada (estado de cada robô + últimas rodadas)
  function statusPainel() {
    return {
      enrich: { running: enrichBot.running, sheetKey: enrichBot.sheetKey, done: enrichBot.done, total: enrichBot.total, ok: enrichBot.ok, noEmail: enrichBot.noEmail, errors: enrichBot.errors, savedAt: enrichBot.savedAt, startedAt: enrichBot.startedAt },
      fresh: { ...freshBot },
      h2aNovas: { ...h2aNovasBot, totalPlanilha: (getSheetH2A() || []).length },
      coleta: { running: dolColeta.running, key: dolColeta.key, count: dolColeta.count, error: dolColeta.error, progress: dolColeta.progress, startedAt: dolColeta.startedAt, finishedAt: dolColeta.finishedAt },
      mensalH2a: DB_H2A_BIM, mensalH2b: DB_H2B_MEN,
      agendado: !isTest,
    };
  }

  return { runEnrichBot, autoEnrichCycle, runFreshCycle, freshBot, dolColeta, runDolColeta, runPlanilhaMensal, runH2aMensal, runH2bMensal,
    getEstadoH2a: () => DB_H2A_BIM, getEstadoH2b: () => DB_H2B_MEN, runH2aNovasCycle, h2aNovasBot, iniciarAgendadores, statusPainel, aplicarDolNaLinha, aplicarFrescor };
}

module.exports = { createPlanilhas };
