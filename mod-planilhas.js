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
   • v208 (dono, 19/09/2026) — O ROBÔ DE FRESCOR FOI RETIRADO. Regra nova do
     produto: cada vaga é enriquecida UMA ÚNICA VEZ pelo ETA Case Number e
     fica pronta pra sempre — nunca mais reconsultada, nunca marcada como
     inativa/expirada. Reconferir vaga já completa contrariava isso. Ver
     docs/H2BAPPLY_PRODUCT_RULES.md 7b e docs/DECISIONS.md (19/09/2026).
   • VAGAS NOVAS H-2A (_runH2aNovasCycle): baixa o feed h2a do dia, ENTRA
     vaga ativa nova (nunca duplica) e SAI inativa (negada/retirada/temporada
     encerrada) — trava anti-catástrofe se >50% sumiria de uma vez.
   • COLETA DO DOL (_runDolColeta): baixa feeds ZIP do datahub, dedupa por
     case number, filtro de qualidade, integridade, salva em RASCUNHO
     (publicar é do admin — KB-078) ou auto-publica quando autorizado.
   • PLANILHAS DO MÊS (_runPlanilhaMensal → H-2A e H-2B): monta a
     "H-2A <Mês> <Ano>" (auto-publica acima do mínimo — exceção autorizada
     por escrito, 13p) e a "H-2B <Mês> <Ano>" (SEMPRE rascunho — 13p2).
   Todo robô: erro só loga e avisa admin por push — nunca derruba o servidor;
   planilha anterior fica intacta se a coleta falhar.

   • v217 (dono, 19/09/2026 — "eu resumi o programa todo para nao gastar...
     robos só precisa 2 vezes por ano quando entrar planilha nova. e nao
     mais que isso"): NENHUM destes 4 robôs roda mais SOZINHO. O DOL só
     publica temporada nova (cap H-2B de abril e de outubro) poucas vezes
     por ano — não há razão de negócio pra bater no DOL o dia inteiro pra
     manter uma planilha "fresca" que não muda entre uma temporada e outra.
     `iniciarAgendadores()` não registra mais nenhum timer automático;
     cada robô continua 100% funcional, mas só roda quando o ADMIN clica
     (aba Planilhas & Robôs) — ele sabe quando saiu temporada nova. A ÚNICA
     exceção que continua automática é o enriquecimento disparado 3s depois
     de um UPLOAD manual de planilha (server.js) — é parte do MESMO clique
     do admin, não um agendador. Objetivo do site (ordem do dono): apenas
     funcionar, enviar, cadastrar e vender — nenhuma dessas 4 depende de
     robô de vaga rodando sozinho. PROIBIDO reintroduzir agendamento
     RECORRENTE (T()/I() em iniciarAgendadores) sem ordem EXPRESSA e NOVA
     do dono. Ver docs/DECISIONS.md (19/09/2026).

   • v282 (dono, 24/09/2026 — achado ao vivo: Julho 2026 só com 1.267 de
     2.625 vagas liberadas, porque ninguém tinha clicado Enriquecer desde
     o v217. "eu preciso que todas as vagas sempre estejam disponível com
     um e-mail disponível... depois do deploy, automaticamente... eu não
     quero clicar em nada... isso não pode falhar"): 2ª exceção automática,
     bem mais estreita que o vigia de 30min que o v217 matou. server.js
     dispara autoEnrichCycle() (função já existia, só não era mais chamada
     sozinha) UMA VEZ, ~15s depois de CADA boot — e como este repo publica
     a cada commit, todo deploy já é um recheck natural. autoEnrichCycle()
     sai rápido se não houver nada pendente; se houver, processa a fila por
     IMPACTO (sem e-mail primeiro) até esvaziar ou o PRÓXIMO deploy
     interromper (retoma pelo disco). Nunca um setInterval — o boot dispara
     UMA corrida, não um relógio. Ver docs/DECISIONS.md (24/09/2026).
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// 🧩 v182 LOTE 8 — O CRITÉRIO DE CONCLUSÃO É "TEM O QUE A TELA USA".
// Até aqui o robô dava uma planilha por "100% completa" só porque toda linha
// tinha E-MAIL — e era exatamente por isso que jan2026 e jul2025 (11.446 vagas,
// a maior parte do acervo) nunca ganhariam cidade, datas nem descrição: saíam
// da fila no primeiro `if`, e o ponto de retomada do próprio bot também era "a
// primeira linha SEM e-mail". Agora o critério é a lista abaixo — os campos que
// a TELA e os FILTROS usam de verdade. Uma lista SÓ, nunca espalhada pelo
// arquivo: quem quiser exigir mais um campo mexe aqui e o robô inteiro (fila,
// retomada, laço e painel) passa a cobrá-lo junto.
const CAMPOS_ESSENCIAIS = [
  { campo: "e",    rotulo: "sem e-mail",         ok: (r) => !!(r.e && String(r.e).includes("@")) },
  { campo: "ci",   rotulo: "sem cidade",         ok: (r) => !!String(r.ci || "").trim() },
  { campo: "d",    rotulo: "sem data de início", ok: (r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.d || "")) },
  { campo: "de",   rotulo: "sem data de fim",    ok: (r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.de || "")) },
  { campo: "desc", rotulo: "sem descrição",      ok: (r) => String(r.desc || "").trim().length > 0 },
];
const linhaCompleta = (r) => { const x = r || {}; for (const c of CAMPOS_ESSENCIAIS) if (!c.ok(x)) return false; return true; };
const temEmailLinha = (r) => !!(r && r.e && String(r.e).includes("@"));
// ── 🕊️ v195 LOTE 14: parar de reconsultar o vazio ──────────────────────────
// O vigia de 30min recolocava na fila, PRA SEMPRE, toda linha que o DOL já
// tinha respondido (200) sem ter o que dar — a jul2026 inteira (2.625 linhas,
// zero e-mail) era reperguntada ao governo a cada meia hora, de graça, com o
// IP que os 5 robôs e as "Vagas ao Vivo" compartilham.
// `row.eq` = quando o DOL foi perguntado e não acrescentou o que falta. A
// janela é curta DE PROPÓSITO (60h, dentro das 48-72h): e-mail que aparece no
// DOL é vaga candidatável, e uma semana de cegueira custaria candidatura real.
const EQ_JANELA_MS = 60 * 3600_000;
const consultadaRecente = (r) => { const t = Number(r && r.eq); return Number.isFinite(t) && t > 0 && (Date.now() - t) < EQ_JANELA_MS; };
// "Pendente AGORA" = falta campo essencial E não foi perguntada há pouco. É o
// que decide o que o ROBÔ faz; o PAINEL continua contando a linha como
// pendente de verdade (ela é), só sabendo que está aguardando o DOL.
const linhaPendenteAgora = (r) => !linhaCompleta(r) && !consultadaRecente(r);
// Progresso REAL de uma planilha (o painel mostra isto, não "100%").
function progressoPlanilha(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const faltando = {}; for (const c of CAMPOS_ESSENCIAIS) faltando[c.campo] = 0;
  let completas = 0, semEmail = 0, aguardandoDol = 0, semEmailAgora = 0;
  for (const r of arr) {
    let ok = true;
    for (const c of CAMPOS_ESSENCIAIS) if (!c.ok(r || {})) { faltando[c.campo]++; ok = false; }
    if (ok) completas++;
    else if (consultadaRecente(r)) aguardandoDol++;   // perguntado há pouco: fora da fila, nunca escondido
    if (!temEmailLinha(r)) { semEmail++; if (!consultadaRecente(r)) semEmailAgora++; }
  }
  const pendentes = arr.length - completas;
  return { total: arr.length, completas, pendentes, semEmail, faltando,
    aguardandoDol, pendentesAgora: pendentes - aguardandoDol, semEmailAgora };
}
// "6.930 sem cidade · 6.930 sem descrição" — frase humana do que falta.
const faltasTexto = (prog) => CAMPOS_ESSENCIAIS
  .filter((c) => (prog.faltando[c.campo] || 0) > 0)
  .map((c) => `${prog.faltando[c.campo].toLocaleString("pt-BR")} ${c.rotulo}`).join(" · ");

// 💵 v182 LOTE 8 — UNIDADE DO SALÁRIO DE VERDADE. `pay_range_desc` do DOL vinha
// mapeado só pra "Month"; TUDO o mais era gravado como HORA, então um salário
// semanal de $800 virava $4,62/h na régua única do filtro (wageHora) e no
// sort=wage. Os ramos de semana/dia/ano de mod-filtros.js eram código morto
// para o dado que este repo produz (100% "h" nas 3 planilhas H-2B).
const PAY_UNIT = {
  hour: "h", hourly: "h", hr: "h",
  week: "w", weekly: "w",
  "bi-weekly": "bw", biweekly: "bw", "bi weekly": "bw", fortnightly: "bw",
  month: "mo", monthly: "mo",
  year: "y", yearly: "y", annual: "y", annually: "y",
  "piece rate": "pr", piece: "pr", "piece-rate": "pr",
  day: "d", daily: "d",
};
const unidadeSalario = (desc) => PAY_UNIT[String(desc || "").trim().toLowerCase()] || "";

// 🧰 v182 LOTE 8 — `exp` É MESES DE EXPERIÊNCIA (regra da casa desde o v179),
// e o robô gravava `experience_required === "Yes" ? 1 : 0`: toda vaga que ele
// tocasse perdia o número de meses e virava "1", destruindo linha a linha o
// dado que sustenta o filtro "não exige experiência" — o de maior valor do
// site. Daqui não dá pra confirmar o nome exato do campo numérico na resposta
// real do DOL (o sandbox não alcança a API), então a leitura é DEFENSIVA:
// aceita os nomes plausíveis publicados pelo datahub e, se nenhum vier, o
// Sim/Não vai pra `expReq` e o `exp` numérico existente NUNCA é sobrescrito
// (o filtro fica com 2 degraus honestos em vez de 4 — nunca com dado falso).
const CAMPOS_EXP_MESES = ["experience_months", "experience_required_months", "months_experience", "experience_req_months", "exp_months"];
function mesesExperiencia(dol) {
  for (const campo of CAMPOS_EXP_MESES) {
    const v = dol ? dol[campo] : undefined;
    if (v === undefined || v === null || v === "") continue;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 600) return n;
  }
  return null;
}

// ── 🌾 v968: PURO (sem I/O) — a regra da janela rolante da planilha H-2A ──────
// O ETA case number H-300-YYDDD-NNNNNN carrega a DATA DE PROTOCOLO (ano + dia
// do ano): é a régua oficial e sempre presente de "quão recente é a vaga" —
// vale também pras linhas antigas da planilha, que nunca tiveram campo de data.
const H2A_JANELA_PADRAO = Math.max(100, Math.min(20000, parseInt(process.env.H2A_JANELA_MAX || "5000", 10) || 5000));
const ISO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const DEAD_ST_H2A = /denied|withdrawn|invalidat|expired|cancel/i;
function dataDoCaso(caseNumber) {
  const m = /^H-300-(\d{2})(\d{3})-/i.exec(String(caseNumber || "").trim()); if (!m) return "";
  const ano = 2000 + Number(m[1]), doy = Number(m[2]); if (doy < 1 || doy > 366) return "";
  const d = new Date(Date.UTC(ano, 0, 1) + (doy - 1) * 86400_000);
  return d.getUTCFullYear() === ano ? d.toISOString().slice(0, 10) : "";
}
const h2aMorta = (r, hojeISO) => DEAD_ST_H2A.test(String((r && r.st) || "")) || !!(r && ISO_DIA.test(String(r.de || "")) && r.de < hojeISO);
// Quem sai primeiro quando falta lugar: inativa/encerrada → protocolo mais antigo → temporada que começa antes.
const chaveDespejoH2a = (r, hojeISO) => (h2aMorta(r, hojeISO) ? "0" : "1") + "|" + (dataDoCaso(r.c) || "0000-00-00") + "|" + (ISO_DIA.test(String(r.d || "")) ? r.d : "0000-00-00") + "|" + String(r.c || "");
function mesclarJanelaH2a(atual, novas, { cap, hoje }) {
  const todas = [...(atual || []), ...(novas || [])]; const excesso = todas.length - cap;
  if (excesso <= 0) return { rows: todas, despejadas: [] };
  const ord = todas.map(r => [chaveDespejoH2a(r, hoje), r]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const despejadas = ord.slice(0, excesso).map(x => x[1]); const fora = new Set(despejadas);
  return { rows: todas.filter(r => !fora.has(r)), despejadas };
}

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
    detectCategory, detectCategoryH2A, dedupe, verify, manifest,
    limparCidade,        // v182: régua ÚNICA de limpeza de cidade (server.js, ao lado do mapa de estados)
    registrarVagasNovasNoRadar,
    isTest,              // true no npm test (TEST_LOGIN_TOKEN) — agendadores desligados
  } = deps;

  const saveMeta = () => { try { fs.writeFileSync(SHEETS_META_FILE, JSON.stringify(getMeta(), null, 2)); } catch (e) { console.warn("[planilhas] meta não gravado:", e.message); } };
  const hoje = () => new Date().toISOString().slice(0, 10);
  // 🗓️ v207 (caso real, sábado 19/09/2026 — "HTTP 404 for .../zip/h2a/2026-09-19"):
  // o DOL gera o arquivo do dia à meia-noite do horário do Leste dos EUA e nem
  // todo dia tem arquivo (fim de semana/feriado); hoje() é UTC, então entre
  // 00:00 e ~05:00 UTC o arquivo "de hoje" ainda nem existe. Um 404 aqui NÃO é
  // falha do robô — é "o DOL ainda não publicou": a régua é tentar os dias
  // anteriores até achar o arquivo mais recente. Qualquer outro erro (403,
  // 5xx, rede) continua estourando — esse sim é falha de verdade. Nunca
  // inventa dado: ou baixa um arquivo real do DOL ou reporta o erro.
  const feedDatas = (desde, dias) => { const out = []; const t0 = Date.parse(desde + "T12:00:00Z"); for (let i = 0; i < dias; i++) out.push(new Date(t0 - i * 86400_000).toISOString().slice(0, 10)); return out; };
  async function baixarFeedComFallback(bs, base, type, { desde, dias = 7, onPulo } = {}) {
    const datas = feedDatas(desde || hoje(), dias);
    for (let i = 0; i < datas.length; i++) {
      const url = `${base}/${type}/${datas[i]}`;
      try { const raw = await bs.downloadAndParse(url); return { raw, data: datas[i], pulados: i }; }
      catch (e) {
        if (!/HTTP 404\b/.test(String(e.message))) throw e;
        if (onPulo) onPulo(datas[i]);
        if (i < datas.length - 1) await new Promise(r => setTimeout(r, process.env.DOL_FEED_BASE ? 20 : 2500)); // educado com o DOL
      }
    }
    throw new Error(`o DOL não publicou o arquivo ${type} de nenhum dos últimos ${dias} dias (${datas[datas.length - 1]} a ${datas[0]}) — o site oficial pode estar sem atualização ou fora do ar`);
  }
    const DOL_HDR = () => ({ "Accept": "application/json", "Accept-Encoding": "gzip", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Cache-Control": "no-cache", "Referer": "https://seasonaljobs.dol.gov/" });

  // 🌐 v182 LOTE 8 — A BASE DA API DO DOL NUMA CONSTANTE SÓ. O enriquecimento e
  // o frescor batiam no hostname fixo `api.seasonaljobs.dol.gov`, o que deixava
  // os 2 robôs INEXERCITÁVEIS no npm test (o sandbox não alcança o DOL — a
  // única "prova" era ler o código). `DOL_API_BASE` aponta pro feed falso no
  // teste; em produção o padrão é EXATAMENTE a URL de sempre (mesmo caminho,
  // mesmos headers, mesmo ritmo). Base http:// (só local/teste) usa o módulo
  // http nativo, porque o httpsReq injetado é https puro.
  const DOL_API_BASE = String(process.env.DOL_API_BASE || "https://api.seasonaljobs.dol.gov/datahub/");
  const _dolLocal = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(DOL_API_BASE);
  // Ritmo com o DOL: INTOCADO em produção (o dono autorizou o robô levar
  // semanas). Só encolhe quando a base é local — não há governo do outro lado.
  const RITMO = { enrich: _dolLocal ? 20 : 800 };
  function _dolReqOpts(caseNumber) {
    const params = new URLSearchParams({ "api-version": "2020-06-30" });
    params.append("$filter", `case_number eq '${caseNumber}'`); params.append("$top", "1");
    let u; try { u = new URL(DOL_API_BASE); } catch { u = new URL("https://api.seasonaljobs.dol.gov/datahub/"); }
    return { u, caminho: (u.pathname || "/") + "?" + params.toString() };
  }
  function _httpJson(u, caminho, headers) {
    return new Promise((resolve, reject) => {
      const http = require("http");
      const r = http.request({ hostname: u.hostname, port: u.port || 80, path: caminho, method: "GET", headers }, (resp) => {
        let b = ""; resp.on("data", (c) => (b += c));
        resp.on("end", () => { let body = b; try { body = JSON.parse(b); } catch { } resolve({ status: resp.statusCode, body }); });
      });
      r.on("error", reject);
      r.setTimeout(15000, () => { r.destroy(); reject(new Error("Timeout")); });
      r.end();
    });
  }
  // UMA vaga do DOL pelo ETA case number — a mesma pergunta dos 2 robôs.
  async function dolApiCase(caseNumber, headers) {
    const { u, caminho } = _dolReqOpts(caseNumber);
    if (u.protocol === "http:") return _httpJson(u, caminho, headers);
    return httpsReq({ hostname: u.hostname, path: caminho, method: "GET", headers });
  }

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
    // 🧹 v182: cidade passa pela régua ÚNICA de limpeza (CEP, sigla de estado,
    // "Mailing:", número de rua, CAIXA ALTA) — a sujeira da fonte virava chip
    // clicável que não é lugar nenhum. Vale também pro que já estava na linha.
    row.ci = limparCidade(dol.worksite_city || dol.employer_city || row.ci || "");
    row.st_ab = (dol.worksite_state || dol.employer_state || row.st_ab || "").trim();
    row.addr = (dol.worksite_address || dol.employer_address || row.addr || "").trim();
    row.zip = (dol.worksite_postal_code || dol.employer_postal_code || row.zip || "").trim();
    row.d = (dol.begin_date || dol.start_date || row.d || "").slice(0, 10);
    row.de = (dol.end_date || dol.expiration_date || row.de || "").slice(0, 10);
    row.wk = parseInt(dol.total_positions || dol.nbr_workers_requested || 0) || row.wk || 0;
    row.w = row.w || (dol.basic_rate_from ? String(parseFloat(dol.basic_rate_from).toFixed(2)) : "");
    row.wmax = dol.basic_rate_to ? String(parseFloat(dol.basic_rate_to).toFixed(2)) : (row.wmax || "");
    // 💵 v182: a unidade publicada pelo DOL MANDA (Hour/Week/Bi-Weekly/Month/
    // Year/Piece Rate). Antes tudo que não fosse "Month" era gravado como HORA
    // — inclusive o "h" errado herdado da planilha compacta, que ficava pra
    // sempre porque o código só preenchia quando o campo estava vazio.
    const _un = unidadeSalario(dol.pay_range_desc);
    row.wunit = _un || row.wunit || "h";
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
    // 🧰 v182: MESES quando o DOL publica o número; senão só o Sim/Não em
    // `expReq` — um `exp` numérico já conhecido NUNCA é sobrescrito.
    const _meses = mesesExperiencia(dol);
    if (_meses !== null) row.exp = _meses;
    if (dol.experience_required !== undefined && dol.experience_required !== null && String(dol.experience_required) !== "") {
      row.expReq = /^(y|s|1|true)/i.test(String(dol.experience_required).trim()) ? "sim" : "nao";
    }
    row.req = (dol.special_requirements || row.req || "").slice(0, 400);
    row.hrs = dol.nbr_hours_per_week ? String(dol.nbr_hours_per_week) : (row.hrs || "");
    row.sched = (dol.work_schedule || row.sched || "").trim();
    row.ft = dol.full_time_position === "Yes" ? "sim" : (row.ft || "");
    row.url = `https://seasonaljobs.dol.gov/jobs/${row.c}`;
    row.visa = String(row.c || "").startsWith("H-300") ? "H-2A" : String(row.c || "").startsWith("H-400") ? "H-2B" : (row.visa || "H-2B");
    // 🌾 v334 (achado de auditoria contínua): o enriquecimento troca row.t
    // (linha acima) quando o título do DOL diverge do que já estava na
    // planilha, mas nunca recalculava row.k — a categoria ficava presa no
    // valor antigo pra sempre, e h2a-jun2026 é justamente a ÚNICA planilha
    // que o self-heal de boot (recategorizeAllSheets, server.js) exclui de
    // propósito (dataset original já vem categorizado à mão). Recalcular
    // aqui, no mesmo lugar que já está mexendo na linha, fecha a lacuna sem
    // reabrir o que a exclusão do self-heal evita (nunca reprocessa a
    // planilha inteira "de graça" — só a linha que o robô já está tocando).
    row.k = row.visa === "H-2A" ? detectCategoryH2A(row.t) : detectCategory(row.t, row.n);
    const emails = [dol.apply_email, dol.employer_email, dol.employer_poc_email, dol.attorney_agent_email, dol.employer_contact_email]
      .map(e => String(e || "").trim().toLowerCase()).filter(e => e && e.includes("@") && !e.startsWith("n/a"));
    if (!row.e && emails.length) row.e = emails[0];
    return emails;
  }

  async function runEnrichBot(sheetKey, resume = false) {
    if (enrichBot.running && !resume) { enrichLog("Bot já está rodando", "warn"); return; }
    const sheet = getSheet(sheetKey);
    if (!sheet || !sheet.length) { enrichLog(`Planilha não encontrada: ${sheetKey}`, "error"); return; }
    // Ponto de retomada REAL pelo disco: começa na PRIMEIRA linha PENDENTE
    // (v174c — o "contagem − 5" do site antigo só funcionava quando os buracos
    // estavam no fim; na H-2A as vagas incompletas estão espalhadas e o bot
    // pulava quase todas). v182 LOTE 8: "pendente" deixou de ser "sem e-mail" e
    // passou a ser "falta algum CAMPO ESSENCIAL" — senão jan2026/jul2025 (100%
    // de e-mail, 0% de cidade/descrição) começavam no fim da planilha e o bot
    // não tinha o que fazer. Linha completa é pulada no laço de qualquer jeito
    // — nunca gasta chamada ao DOL à toa.
    const alreadyDone = sheet.filter(linhaCompleta).length;
    // v195 LOTE 14: retomar na primeira linha que o robô REALMENTE vai tratar
    // — linha perguntada ao DOL há pouco é pulada de qualquer jeito.
    const primeiraPendente = sheet.findIndex(linhaPendenteAgora);
    const startIdx = resume && primeiraPendente > 0 ? primeiraPendente : 0;
    enrichBot.running = true; enrichBot.sheetKey = sheetKey; enrichBot.total = sheet.length; enrichBot.done = startIdx;
    enrichBot.ok = resume ? alreadyDone : 0; enrichBot.noEmail = resume ? (enrichBot.noEmail || 0) : 0; enrichBot.errors = resume ? (enrichBot.errors || 0) : 0;
    enrichBot.aguardando = resume ? (enrichBot.aguardando || 0) : 0;
    enrichBot.startedAt = (resume && enrichBot.startedAt) ? enrichBot.startedAt : Date.now();
    enrichBot.log = resume ? enrichBot.log : []; enrichBot.savedAt = null;
    enrichLog(`📌 Ponto de retomada: ${startIdx}/${sheet.length} (${alreadyDone} vagas já completas no disco — e-mail, cidade, datas e descrição)`, "info");
    enrichLog(`🚀 Bot iniciado: ${sheet.length} vagas — planilha "${sheetKey}"${resume ? ` (retomando de ${startIdx})` : ""}`, "ok");
    enrichLog("🔍 Buscando: email, cidade, datas, workers, telefone, funções, URL", "info");
    let uaIdx = Math.floor(Math.random() * USER_AGENTS.length);
    const getHDR = () => { uaIdx = (uaIdx + 1) % USER_AGENTS.length; return { ...DOL_HDR(), "User-Agent": USER_AGENTS[uaIdx], "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", "Pragma": "no-cache", "Origin": "https://seasonaljobs.dol.gov", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-site" }; };
    let interDelay = RITMO.enrich, consecutive403 = 0;
    for (let i = startIdx; i < sheet.length; i++) {
      if (!enrichBot.running) break;
      const row = sheet[i]; const cn = String(row.c || "").toUpperCase(); enrichBot.done = i + 1;
      // pula quem JÁ está completo (todos os CAMPOS_ESSENCIAIS) — nunca gasta DOL à toa
      if (linhaCompleta(row)) { enrichBot.ok++; continue; }
      // v195 LOTE 14: e pula quem o DOL já respondeu sem ter o que dar, até a
      // janela de 60h passar — era isto que fazia o vigia de 30min reperguntar
      // a planilha inteira pro governo, pra sempre, sem NENHUMA linha mudar.
      if (consultadaRecente(row)) { enrichBot.aguardando++; continue; }
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
          const { status, body } = await dolApiCase(row.c, getHDR());
          if (status === 200) {
            consecutive403 = 0; if (interDelay > RITMO.enrich) interDelay = Math.max(RITMO.enrich, interDelay - 300);
            const raw = body?.value || body?.results || body?.data || (Array.isArray(body) ? body : []);
            const dol = raw[0] || null; processed = true;
            if (dol) {
              const tinhaEmail = !!row.e;
              aplicarDolNaLinha(row, dol);
              if (!tinhaEmail && row.e) enrichLog(`📧 [${i + 1}/${sheet.length}] ${cn}: email → ${row.e}`, "ok");
              enrichBot.ok++;
              // O DOL respondeu: se AINDA falta campo essencial, é porque ele
              // não tem — carimba a linha e só volta a perguntar depois da
              // janela. Sem o carimbo, o vigia de 30min reperguntava sempre.
              if (!linhaCompleta(row)) row.eq = Date.now();
              // ⚠️ v195 LOTE 14: "SEM EMAIL" vira RESUMO no fim do ciclo — uma
              // linha de log por vaga engolia o ring de 1500 do botLog inteiro
              // (frescor, mensal e sentinela sumiam por baixo).
              if (!row.e || !String(row.e).includes("@")) enrichBot.noEmail++;
              else enrichLog(`✅ [${i + 1}/${sheet.length}] ${cn} | ${(row.t || "?").slice(0, 35)} | ${row.ci || "?"}, ${row.s || "?"} | $${row.w || "?"}/h | ${row.e}`, "info");
            } else { enrichBot.errors++; row.eq = Date.now(); enrichLog(`❌ [${i + 1}/${sheet.length}] ${cn} — não encontrado no DOL`, "warn"); }
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
    const prog = progressoPlanilha(sheet);
    meta[sheetKey].enriched = enrichBot.ok; meta[sheetKey].enrichedAt = Date.now(); meta[sheetKey].enrichedTotal = enrichBot.total;
    meta[sheetKey].completas = prog.completas; meta[sheetKey].pendentes = prog.pendentes;
    saveMeta();
    enrichLog(`🏁 CONCLUÍDO! ${prog.completas}/${prog.total} completas | ${prog.pendentes} pendente(s)${prog.pendentes ? ` (${faltasTexto(prog)})` : ""} | erros:${enrichBot.errors}`, "ok");
    // Resumo do que o DOL não tem (1 linha por CICLO, nunca por vaga) e do que
    // ficou de molho até a janela de reconsulta abrir.
    if (enrichBot.noEmail || prog.aguardandoDol) {
      enrichLog(`⚠️ ${enrichBot.noEmail} vaga(s) continuam SEM E-MAIL no DOL nesta rodada · ${prog.aguardandoDol} linha(s) aguardando a janela de ${Math.round(EQ_JANELA_MS / 3600_000)}h pra serem reperguntadas${enrichBot.aguardando ? ` (${enrichBot.aguardando} pulada(s) neste ciclo por isso)` : ""}`, "warn");
    }
  }

  // 📋 v182 LOTE 8 — FILA DO ENRIQUECIMENTO POR IMPACTO, com o progresso REAL
  // de cada planilha (nunca por carimbo — deploy no meio não mente). Ordem:
  // (1) vaga SEM E-MAIL primeiro, porque sem contato não existe candidatura —
  //     é a prioridade nº1 da casa e já era a régua do v174c; é isso que põe a
  //     jul2026 (2.625 linhas, ZERO e-mail) na frente de todas;
  // (2) desempate por quantas linhas estão PENDENTES (faltando qualquer campo
  //     essencial) — jan2026 (9.240) antes de jul2025 (2.206).
  // Mesma função que o painel usa pra mostrar o progresso: uma verdade só.
  function filaEnriquecimento() {
    return ["jan2026", "jul2025", "h2a-jun2026", ...Object.keys(getExtras() || {})]
      .filter((k, i, a) => a.indexOf(k) === i)
      .map(k => ({ k, ...progressoPlanilha(getSheet(k) || []) }))
      .filter(x => x.total > 0)
      // v195 LOTE 14: a ordem é pelo que o robô PODE fazer agora — linha
      // carimbada (DOL já respondeu sem ter o que dar) não empurra planilha
      // nenhuma pra frente da fila enquanto a janela não abre.
      .sort((a, b) => (b.semEmailAgora - a.semEmailAgora) || (b.pendentesAgora - a.pendentesAgora) || (b.pendentes - a.pendentes));
  }

  // Ciclo autônomo: toda planilha com linha PENDENTE entra na fila do bot.
  async function autoEnrichCycle() {
    if (enrichBot.running) return;
    if (isTest) { console.log("[auto-enrich] 🧪 modo teste — o DOL não é alcançável no sandbox; enriquecimento só em produção"); return; }
    const fila = filaEnriquecimento();
    for (const item of fila) {
      if (enrichBot.running) break;
      const sheetKey = item.k;
      const sheet = getSheet(sheetKey); if (!sheet || !sheet.length) continue;
      const meta = getMeta();
      if (!meta[sheetKey]) meta[sheetKey] = { name: sheetKey };
      meta[sheetKey].completas = item.completas; meta[sheetKey].pendentes = item.pendentes;
      // v195 LOTE 14: nada a fazer = nada PENDENTE AGORA. Planilha cujas
      // pendências estão todas carimbadas (o DOL já disse que não tem) sai do
      // ciclo em vez de ser varrida de novo a cada 30min.
      if (item.pendentesAgora <= 0) {
        meta[sheetKey].enrichedAt = Date.now(); meta[sheetKey].enriched = item.completas; meta[sheetKey].enrichedTotal = item.total;
        saveMeta();
        console.log(`[auto-enrich] ${sheetKey}: ✅ ${item.completas}/${item.total} completas${item.aguardandoDol ? ` · ${item.aguardandoDol} aguardando a janela de reconsulta do DOL` : ""} — nada a fazer`);
        continue;
      }
      saveMeta();
      console.log(`[auto-enrich] 🚀 ${sheetKey}: ${item.pendentesAgora} pendente(s) de ${item.total} — ${faltasTexto(item)}`);
      await runEnrichBot(sheetKey, item.completas > 0).catch(e => console.error(`[auto-enrich] ${sheetKey}:`, e.message));
      if (fila.indexOf(item) < fila.length - 1) await new Promise(r => setTimeout(r, 60000)); // pausa entre planilhas
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  📋 PLANILHAS PUBLICADAS — fonte única da lista que o vigia de saúde e o
  //  admin usam pra saber "quais planilhas existem de verdade pro usuário"
  //  (rascunho fica de fora — ninguém se candidata a ele). Nome antigo era
  //  `planilhasParaFrescor`; o frescor saiu (v208), a lista continua útil.
  // ═════════════════════════════════════════════════════════════════
  function planilhasPublicadas() {
    const meta = getMeta();
    const extras = Object.keys(getExtras() || {}).filter(k => meta[k]?.published !== false);
    return [...new Set(["jan2026", "jul2025", "h2a-jun2026", ...extras])]
      .filter(k => { const a = getSheet(k); return Array.isArray(a) && a.length; });
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
    if (h2aNovasBot.running) { dolColeta.error = "a planilha H-2A está sendo atualizada agora — tente de novo em alguns minutos (dois downloads do DOL ao mesmo tempo estouram a memória)"; dcLog(`⏳ ${dolColeta.error}`, "warn"); return; }
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
        try {
          // v207: data planejada sem arquivo no DOL (404) → usa o arquivo mais próximo pra trás (até 3 dias)
          const { raw, data: usada } = await baixarFeedComFallback(bs, base, type, { desde: feedDate, dias: 4, onPulo: d => dcLog(`📭 feed ${d} não existe no DOL (404) — tentando o dia anterior`) });
          const recs = Array.isArray(raw) ? raw : (raw.data || raw.results || raw.items || raw.cases || []);
          records.push(...recs); feedsOk++;
          dcLog(`📥 feed ${feedDate}${usada !== feedDate ? ` (usado o arquivo de ${usada})` : ""}: ${recs.length} registros brutos`);
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
        // 🌾 v332: bs.toCompact() SEMPRE devolve algo em c.k (detectCategoryBest
        // do build-sheets.js tem fallback "other" — nunca vazio), então este
        // `if(!c.k)` nunca disparava, nem pra H-2B nem pra H-2A. Pior: mesmo
        // se disparasse, detectCategory() (a função canônica de H-2B) também
        // não conhece a taxonomia H-2A. H-2A usa SEMPRE detectCategoryH2A()
        // aqui (nunca confia no c.k que toCompact() já atribuiu, que é da
        // taxonomia errada).
        if (String(c.visa || "").toUpperCase() === "H-2A") c.k = detectCategoryH2A(c.t);
        else if (!c.k) c.k = detectCategory(c.t, c.n);
        compact.push(c);
      }
      dcLog(`✅ ${compact.length} vagas válidas (${descartadas} sem e-mail/qualidade${foraJanela ? `, ${foraJanela} fora da janela de datas` : ""}${outroVisto ? `, ${outroVisto} de outro visto` : ""})`);
      // 🚨 v177-FIX7 (auditoria 14/09/2026): a mensagem culpava SEMPRE o DOL,
      // mesmo quando quem descartou quase tudo foi a janela de datas que o
      // PRÓPRIO admin configurou na coleta manual — ele ia procurar problema
      // no lado de fora em vez de alargar o filtro. Agora o erro nomeia a
      // causa real quando o filtro é o responsável pela maioria dos cortes.
      if (compact.length < 10) {
        const _culpaJanela = foraJanela > 0 && foraJanela >= (descartadas + outroVisto);
        throw new Error(_culpaJanela
          ? `só ${compact.length} vagas válidas — ${foraJanela} ficaram FORA da janela de datas que você escolheu (início entre ${beginFrom || "—"} e ${beginTo || "—"}). Alargue ou tire o filtro de datas e rode de novo. NADA foi salvo (planilha anterior intacta)`
          : `só ${compact.length} vagas válidas — resposta suspeita do DOL, NADA foi salvo (planilha anterior intacta)`);
      }
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
      if (autoPub) { dcLog(`📢 Planilha PUBLICADA automaticamente: ${compact.length} vagas (${comEmail} com e-mail) — já disponível no Manual e no Automático.`); registrarVagasNovasNoRadar(compact, `Planilha nova ${sheetName}`).catch(() => { }); }
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
    if (dolColeta.running || h2aNovasBot.running) return { ok: false, error: "já existe uma coleta rodando — tente de novo em alguns minutos" };
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
  //  🌾 PLANILHA H-2A — JANELA ROLANTE DE 5.000 VAGAS (v968, dono, 10/10/2026)
  //  "A planilha do H2A sempre tem que estar alimentada. Pelo menos duas
  //  vezes no mês, tem que ter um agendamento para ela iniciar sozinha...
  //  sempre vai ter 5 mil vagas. É obrigatório tirar as vagas mais velhas e
  //  colocar as mais recentes." Reestrutura o antigo "Vagas novas H-2A":
  //   1) baixa os feeds do Seasonal Jobs (os MESMOS arquivos do Download de
  //      Dados do site oficial) cobrindo desde a última rodada;
  //   2) compara por ETA case number com a planilha — quem já está nela é
  //      IGNORADO (só tem o status/data atualizado); só entra o que não tinha;
  //   3) tira primeiro o inativo/encerrado e, se passar do teto, as MAIS
  //      ANTIGAS (data de protocolo, que o próprio case number carrega);
  //   4) carimba quando atualizou, pro card "Atualizada em" do usuário.
  //  Só ADICIONA e tira pra dar lugar — nunca esvazia a planilha.
  // ══════════════════════════════════════════════════════════════════════
  const H2A_ROLL_FILE = path.join(DATA_DIR, "h2a_rolling.json");
  let DB_H2A_ROLL = lerEstado(H2A_ROLL_FILE);
  const gravarRoll = (patch) => { DB_H2A_ROLL = { ...DB_H2A_ROLL, ...patch }; try { fs.writeFileSync(H2A_ROLL_FILE, JSON.stringify(DB_H2A_ROLL, null, 2)); } catch (e) { console.warn("[h2a-roll] estado não gravado:", e.message); } };
  const h2aCap = (opts) => (isTest && opts && Number(opts.cap) > 0) ? Math.floor(Number(opts.cap)) : H2A_JANELA_PADRAO;
  const h2aIntervaloMs = () => Math.max(1, parseInt(process.env.H2A_INTERVALO_DIAS || "14", 10) || 14) * 86400_000;
  const h2aDevido = (agora = Date.now()) => !DB_H2A_ROLL.lastOkAt || agora >= (DB_H2A_ROLL.nextRunAt || 0);
  const h2aNovasBot = { running: false, lastRunAt: null, lastError: null, lastAdded: 0, totalAdded: 0, lastRemoved: 0, totalRemoved: 0, lastEvicted: 0, totalEvicted: 0, runs: 0 };
  async function runH2aNovasCycle(trigger, opts) {
    if (h2aNovasBot.running) return { ok: false, error: "já rodando" };
    if (dolColeta.running) return { ok: false, error: "já existe uma coleta rodando — tente de novo em alguns minutos" };
    h2aNovasBot.running = true; h2aNovasBot.lastError = null;
    const LOG = (m, t) => botLog("h2a-novas", "Planilha H-2A (5.000 mais recentes)", m, t || "info");
    try {
      const bs = require("./build-sheets.js");
      const base = (process.env.DOL_FEED_BASE || bs.DOL_BASE).replace(/\/$/, "");
      const cap = h2aCap(opts); const agora = Date.now(); const _hoje = hoje();
      let SHEET_H2A = getSheetH2A();
      const antesTotal = SHEET_H2A.length;
      // Quanto do passado cobrir: planilha cheia e rodada recente → só o que saiu
      // desde então (+21 dias de folga, cada feed enxerga ~20 dias pra trás);
      // primeira vez ou planilha abaixo do teto → até 126 dias pra ENCHER.
      const diasDesde = DB_H2A_ROLL.lastOkAt ? Math.ceil((agora - DB_H2A_ROLL.lastOkAt) / 86400_000) : Infinity;
      const encher = !DB_H2A_ROLL.lastOkAt || antesTotal < cap * 0.95;
      const cobrir = encher ? 126 : Math.min(126, diasDesde + 21);
      const nFeeds = Math.max(1, Math.min(8, Math.ceil(cobrir / 18)));
      LOG(`🌾 Conferindo o Seasonal Jobs (${trigger || "agendado"}): planilha com ${antesTotal} vagas, teto ${cap}; olhando ${cobrir} dias (${nFeeds} feed${nFeeds > 1 ? "s" : ""})`);
      const have = new Set(SHEET_H2A.map(r => String(r.c || "").trim().toUpperCase()));
      const statusDoFeed = new Map();   // TODO case do feed (inclusive negado/retirado) → status/datas mais novos
      const candidatas = new Map();     // só o que a planilha ainda NÃO tem e passa na qualidade
      let descartadas = 0, outroVisto = 0, feedsOk = 0, feedsFalharam = 0, brutos = 0; const usados = new Set();
      for (let i = 0; i < nFeeds; i++) {
        const planejada = new Date(Date.parse(_hoje + "T12:00:00Z") - i * 18 * 86400_000).toISOString().slice(0, 10);
        try {
          const { raw, data: dataFeed, pulados } = await baixarFeedComFallback(bs, base, "h2a", { desde: planejada, dias: i === 0 ? 7 : 4, onPulo: d => LOG(`📭 O DOL ainda não publicou o arquivo de ${d} — tentando o dia anterior`) });
          if (pulados) LOG(`📅 Usando o arquivo de ${dataFeed} (o mais recente que o DOL publicou)`);
          if (usados.has(dataFeed)) continue; usados.add(dataFeed);
          const recs = Array.isArray(raw) ? raw : (raw.data || raw.results || raw.items || raw.cases || []);
          brutos += recs.length; feedsOk++;
          for (const rec of recs) {
            const cn = String(rec.case_number || rec.case_id || "").trim().toUpperCase(); if (!cn) continue;
            if (!statusDoFeed.has(cn)) statusDoFeed.set(cn, { st: (rec.case_status || "").trim(), d: (rec.begin_date || rec.start_date || "").slice(0, 10), de: (rec.end_date || rec.expiration_date || "").slice(0, 10) });
            if (have.has(cn) || candidatas.has(cn)) continue;
            if (bs.shouldDiscard(rec)) { descartadas++; continue; }
            const c = bs.toCompact(rec);
            if (String(c.visa || "").toUpperCase() !== "H-2A") { outroVisto++; continue; }
            if (h2aMorta(c, _hoje)) { descartadas++; continue; }   // temporada já encerrada / status morto: não ocupa lugar da viva
            // categorizador PRÓPRIO do H-2A (v332): c.k de toCompact é da taxonomia H-2B.
            c.k = detectCategoryH2A(c.t); candidatas.set(cn, c);
          }
        } catch (e) {
          if (i === 0) throw e;   // sem o feed mais recente não há rodada: erro honesto, planilha intacta
          feedsFalharam++;
          LOG(`⚠️ feed de ${planejada} falhou (${e.message}) — seguindo com os demais`, "warn");
        }
        if (i < nFeeds - 1) await new Promise(r => setTimeout(r, process.env.DOL_FEED_BASE ? 20 : 8000)); // educado com o DOL
      }
      // (a) quem já está na planilha só tem status/datas atualizados — NUNCA reentra
      let atualizadas = 0, jaTinha = 0;
      for (const r of SHEET_H2A) {
        const f = statusDoFeed.get(String(r.c || "").trim().toUpperCase()); if (!f) continue; jaTinha++;
        if (f.st && f.st !== r.st) { r.st = f.st; atualizadas++; }
        if (f.d && f.d !== r.d) r.d = f.d;
        if (f.de && f.de !== r.de) r.de = f.de;
      }
      // (b) inativo (negado/retirado/inválido) ou temporada encerrada SAI — com a trava anti-catástrofe
      const vivas = SHEET_H2A.filter(r => !h2aMorta(r, _hoje));
      let removidas = antesTotal - vivas.length;
      if (removidas > antesTotal * 0.5) { LOG(`🛡️ ${removidas} de ${antesTotal} vagas dariam como inativas de uma vez — suspeito de dado quebrado, NENHUMA foi removida por inatividade neste ciclo (as mais velhas ainda saem só se faltar lugar).`, "warn"); removidas = 0; }
      else if (removidas > 0) SHEET_H2A = vivas;
      // (c) entra o novo; (d) passou do teto? saem as MAIS ANTIGAS (inativas primeiro)
      const novas = [...candidatas.values()];
      const { rows: finais, despejadas } = mesclarJanelaH2a(SHEET_H2A, novas, { cap, hoje: _hoje });
      const chk = verify(finais, { caseField: "c" });
      if (!chk.ok) throw new Error(`integridade: duplicata após o merge (${chk.duplicateCases.length}) — NADA foi salvo`);
      const despSet = new Set(despejadas.map(r => r.c));
      const novasQueFicaram = novas.filter(c => !despSet.has(c.c));
      const mudou = novasQueFicaram.length || despejadas.length || removidas > 0 || atualizadas > 0;
      if (mudou || h2aNovasBot.pendenteGravar) {
        // IN PLACE de propósito: o robô de Enriquecimento segura a REFERÊNCIA do array por horas e
        // regrava ele inteiro a cada vaga — trocar o array deixaria ele sobrescrevendo a planilha nova com a velha.
        const viva = getSheetH2A(); viva.splice(0, viva.length, ...finais); setSheetH2A(viva);
        if (saveSheet("h2a-jun2026", viva) === false) { h2aNovasBot.pendenteGravar = true; throw new Error("não consegui gravar a planilha H-2A no disco — nova tentativa já agendada (a memória já está atualizada)"); }
        h2aNovasBot.pendenteGravar = false;
        // 📡 só avisa o Radar do que é NOVO de verdade (protocolado nas últimas 3 semanas) — o preenchimento do começo não é "vaga nova"
        const corte = new Date(Date.parse(_hoje + "T12:00:00Z") - 21 * 86400_000).toISOString().slice(0, 10);
        registrarVagasNovasNoRadar(novasQueFicaram.filter(c => dataDoCaso(c.c) >= corte), "Vagas novas H-2A").catch(() => { });
      }
      SHEET_H2A = getSheetH2A();
      const maisRecente = finais.reduce((m, r) => { const d = dataDoCaso(r.c); return d > m ? d : m; }, "");
      const total = finais.length;
      LOG(mudou
        ? `✅ Planilha H-2A atualizada: +${novasQueFicaram.length} nova(s), −${removidas} inativa(s), −${despejadas.length} mais antiga(s) pra caber o teto de ${cap}, ${atualizadas} status atualizado(s) — total ${total}. (${jaTinha} do feed já estavam na planilha e foram ignoradas, ${descartadas} sem e-mail/qualidade.)`
        : `💤 Nada mudou desta vez (${jaTinha} do feed já estavam na planilha, ${descartadas} sem e-mail/qualidade). Planilha com ${total} vagas.`, mudou ? "ok" : "info");
      console.log(`[h2a-novas] ✅ +${novasQueFicaram.length} novas, -${removidas} inativas, -${despejadas.length} antigas, ${atualizadas} atualizadas (total ${total})`);
      h2aNovasBot.lastAdded = novasQueFicaram.length; h2aNovasBot.totalAdded += novasQueFicaram.length;
      h2aNovasBot.lastRemoved = removidas; h2aNovasBot.totalRemoved += removidas;
      h2aNovasBot.lastEvicted = despejadas.length; h2aNovasBot.totalEvicted += despejadas.length;
      h2aNovasBot.runs++; h2aNovasBot.lastRunAt = agora; h2aNovasBot.retries = 0; h2aNovasBot.proximaTentativa = null;
      // Pediu pra ENCHER (1ª vez / abaixo do teto) mas só parte dos feeds respondeu: não agenda 14 dias —
      // volta em 6h (o relógio de 3h pega), no máximo 3 vezes seguidas; depois segue o ciclo normal.
      const parcial = encher && feedsFalharam > 0 && (DB_H2A_ROLL.parciaisSeguidas || 0) < 3;
      if (parcial) LOG(`⚠️ Só ${feedsOk} de ${nFeeds} feeds responderam — a planilha ainda não encheu; o robô tenta de novo em ~6 horas.`, "warn");
      gravarRoll({ lastOkAt: agora, lastRunAt: agora, nextRunAt: agora + (parcial ? 6 * 3600_000 : h2aIntervaloMs()), parciaisSeguidas: parcial ? (DB_H2A_ROLL.parciaisSeguidas || 0) + 1 : 0, lastAdded: novasQueFicaram.length, lastRemoved: removidas, lastEvicted: despejadas.length,
        total, cap, maisRecente, feeds: feedsOk, brutos, runs: (DB_H2A_ROLL.runs || 0) + 1, lastTrigger: String(trigger || ""), lastError: null, falhasSeguidas: 0 });
      // as vagas que acabaram de entrar vêm do feed (e-mail, cargo, datas, salário); descrição/telefone/endereço completa o Enriquecimento — sozinho, 1 vaga por vez
      if (!isTest && novasQueFicaram.length) autoEnrichCycle().catch(e => console.warn("[h2a-novas] enriquecimento pós-rodada:", e.message));
      return { ok: true, added: novasQueFicaram.length, removidas, evicted: despejadas.length, atualizadas, jaTinha, descartadas, outroVisto, total, cap };
    } catch (e) {
      h2aNovasBot.lastError = e.message; h2aNovasBot.lastRunAt = Date.now();
      // v207: nunca fica preso em "⚠️ Erro" — re-tenta sozinho em 1 hora (até 3 vezes seguidas;
      // depois o relógio de 3h do agendador volta a tentar). Planilha atual SEMPRE intacta.
      const tentativa = trigger === "retry" ? (h2aNovasBot.retries || 0) + 1 : 1;
      h2aNovasBot.retries = tentativa;
      const falhas = (DB_H2A_ROLL.falhasSeguidas || 0) + 1;
      gravarRoll({ lastRunAt: Date.now(), lastError: String(e.message).slice(0, 300), falhasSeguidas: falhas });
      if (tentativa <= 3) {
        h2aNovasBot.proximaTentativa = Date.now() + 3600_000;
        if (!isTest) { const t = setTimeout(() => runH2aNovasCycle("retry").catch(() => { }), 3600_000); if (t.unref) t.unref(); }
      } else h2aNovasBot.proximaTentativa = null;
      LOG(`⚠️ ${e.message} (planilha atual intacta — ${tentativa <= 3 ? "nova tentativa automática em 1 hora" : "3 tentativas seguidas falharam; o agendador tenta de novo em até 3 horas"})`, "warn");
      if (falhas === 3 && !isTest) for (const ae of ADMIN_EMAILS) pushToUser(ae, { type: "generic", title: "⚠️ Planilha H-2A não atualizou", body: `${String(e.message).slice(0, 110)} — o robô continua tentando sozinho.`, icon: "/icon-192.png", url: "/admin" }).catch(() => { });
      return { ok: false, error: e.message, proximaTentativa: h2aNovasBot.proximaTentativa };
    } finally { h2aNovasBot.running = false; }
  }
  // Card "Atualizada em" (usuário) e painel (admin): uma leitura só do estado persistido.
  function h2aJanelaInfo() {
    const s = DB_H2A_ROLL;
    return { atualizadoEm: s.lastOkAt || null, novas: s.lastAdded || 0, despejadas: s.lastEvicted || 0, proxima: s.nextRunAt || null, maisRecente: s.maisRecente || null, janela: s.cap || H2A_JANELA_PADRAO };
  }
  // ⏰ AGENDADOR DA H-2A — autorizado EXPRESSAMENTE pelo dono (10/10/2026), exceção
  // ao v217 só pra esta planilha. Sem estado (primeiro deploy) roda ~90s depois do boot;
  // depois, a cada 14 dias (estado em /data sobrevive a deploy). O relógio de 3h só
  // olha "venceu?" — não bate no DOL sem necessidade. Desligado no npm test.
  function iniciarAgendadorH2a() {
    if (isTest) { console.log("[h2a-roll] 🧪 modo teste — agendador da H-2A desligado (disparo só por rota)"); return false; }
    const tick = (origem) => {
      if (!h2aDevido() || h2aNovasBot.running || dolColeta.running) return;
      if (h2aNovasBot.proximaTentativa && Date.now() < h2aNovasBot.proximaTentativa) return;   // a re-tentativa de 1h já está armada
      console.log(`[h2a-roll] ⏰ venceu (${origem}) — ${DB_H2A_ROLL.lastOkAt ? "ciclo de " + Math.round(h2aIntervaloMs() / 86400_000) + " dias" : "primeira busca desde o deploy"}`);
      runH2aNovasCycle(DB_H2A_ROLL.lastOkAt ? "agendado" : "primeira-vez").catch(e => console.warn("[h2a-roll]", e.message));
    };
    const t1 = setTimeout(() => tick("boot"), 90_000); if (t1.unref) t1.unref();
    const t2 = setInterval(() => tick("relógio"), 3 * 3600_000); if (t2.unref) t2.unref();
    console.log(`[h2a-roll] ⏰ agendador ligado: ${DB_H2A_ROLL.lastOkAt ? "próxima busca em " + new Date(DB_H2A_ROLL.nextRunAt || 0).toISOString() : "nunca rodou — primeira busca ~90s após o boot"}`);
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ⏰ AGENDADORES RECORRENTES — DESLIGADOS DE PROPÓSITO (v217, dono,
  //  19/09/2026). O DOL só publica temporada nova poucas vezes por ano —
  //  nenhum destes 4 robôs (enriquecimento, vagas novas H-2A, H-2A do mês,
  //  H-2B do mês) roda mais SOZINHO POR RELÓGIO (setInterval/vigia). Ainda
  //  rodam por CLIQUE do admin (aba Planilhas & Robôs) — rotas
  //  /api/admin/enrich/start, /api/admin/sheet/coleta-start,
  //  /api/admin/sheet/h2a-bimestral-run, /api/admin/sheet/h2b-mensal-run,
  //  /api/admin/sheet/h2a-novas-run — E, desde o v282 (dono, 24/09/2026 —
  //  "eu não quero clicar em nada... isso não pode falhar"), por UM disparo
  //  automático de enriquecimento a CADA BOOT/deploy (server.js, logo depois
  //  da chamada de iniciarAgendadores() abaixo, chamando autoEnrichCycle()
  //  direto) — nunca um setInterval, só um setTimeout de boot que sai rápido
  //  quando não há nada pendente. PROIBIDO reintroduzir T()/I() (timer
  //  RECORRENTE) AQUI DENTRO desta função sem ordem EXPRESSA e NOVA do
  //  dono — o hook de boot do v282 mora fora, de propósito, pra essa guarda
  //  continuar provando algo de verdade.
  // ══════════════════════════════════════════════════════════════════════
  function iniciarAgendadores() {
    console.log(isTest
      ? "[planilhas] 🧪 modo teste — robôs de planilha são manuais (disparo só por rota), como em produção desde o v217"
      : "[planilhas] ⏰ robôs de planilha são 100% MANUAIS (v217, 19/09/2026) — sem timer automático; use a aba Planilhas & Robôs quando o DOL publicar temporada nova");
    return false;
  }

  // Painel: TUDO numa chamada (estado de cada robô + últimas rodadas)
  function statusPainel() {
    return {
      enrich: { running: enrichBot.running, sheetKey: enrichBot.sheetKey, done: enrichBot.done, total: enrichBot.total, ok: enrichBot.ok, noEmail: enrichBot.noEmail, aguardando: enrichBot.aguardando || 0, errors: enrichBot.errors, savedAt: enrichBot.savedAt, startedAt: enrichBot.startedAt },
      // 📋 v182 LOTE 8: o progresso REAL de cada planilha, na MESMA ordem em que
      // o robô vai atacá-las (e pela MESMA função que ele usa) — o painel
      // mostrava "100%" pra planilha que não tem cidade nem descrição nenhuma.
      enrichFila: filaEnriquecimento().slice(0, 8),
      h2aNovas: { ...h2aNovasBot, totalPlanilha: (getSheetH2A() || []).length, ...h2aJanelaInfo(), devido: h2aDevido(), agendadorLigado: !isTest },
      // 🚨 v177-FIX2 (auditoria 14/09/2026): faltava `published` — o admin.html
      // sempre mostrava "em rascunho, publique abaixo" mesmo DEPOIS de clicar
      // "Publicar pros usuários" com sucesso, porque esse campo nunca existia
      // aqui (o publish só grava em getMeta()[key], objeto separado do
      // dolColeta em memória). Mesma leitura já usada em coleta-publish (367).
      coleta: { running: dolColeta.running, key: dolColeta.key, count: dolColeta.count, error: dolColeta.error, progress: dolColeta.progress, startedAt: dolColeta.startedAt, finishedAt: dolColeta.finishedAt, published: dolColeta.key ? (getMeta()[dolColeta.key]?.published === true) : false },
      mensalH2a: DB_H2A_BIM, mensalH2b: DB_H2B_MEN,
      // v217: nunca mais "agendado" — nenhum robô de planilha roda por
      // relógio, nem em produção. O painel (admin.html) já sabia mostrar
      // "Só manual" pra este campo falso; só passou a valer sempre.
      agendado: false,
    };
  }

  return { runEnrichBot, autoEnrichCycle, filaEnriquecimento, planilhasPublicadas, dolColeta, runDolColeta, runPlanilhaMensal, runH2aMensal, runH2bMensal,
    getEstadoH2a: () => DB_H2A_BIM, getEstadoH2b: () => DB_H2B_MEN, runH2aNovasCycle, h2aNovasBot, h2aJanelaInfo, h2aDevido, iniciarAgendadorH2a, iniciarAgendadores, statusPainel, aplicarDolNaLinha };
}

module.exports = { createPlanilhas, dataDoCaso, mesclarJanelaH2a, CAMPOS_ESSENCIAIS, linhaCompleta, progressoPlanilha, unidadeSalario, mesesExperiencia };
