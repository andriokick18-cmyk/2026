#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🧪 SMOKE TEST do H2BApply — `npm test`
   Sobe o servidor DE VERDADE com um usuário-fixture no estado bugado que
   já aconteceu em produção (PDF triplicado, base64 dentro do users.json,
   perfil apontando pra PDF que não existe, arquivo órfão no disco) e
   verifica que o boot cura tudo e que as rotas vitais respondem.

   Zero dependências. Sai com código 0 (verde) ou 1 (falhou).
   Roda em ~15s. Use antes de TODO deploy.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = 3900 + Math.floor(Math.random() * 90); // evita colisão em CI
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-smoke-"));

// ── 🎭 Feed DOL falso — testa o bot de coleta de PONTA A PONTA sem internet.
// O server recebe DOL_FEED_BASE apontando pra cá; qualquer GET devolve um
// feed com 14 vagas H-2B válidas + 1 duplicada (pro dedupe provar serviço)
// + 1 sem e-mail (pro filtro de qualidade provar serviço).
const FEED_PORT = PORT + 1;
const _mkVaga = (i) => ({
  case_number: `H-400-2600${String(i).padStart(2, "0")}-111111`,
  job_title: "Landscape Laborer", employer_business_name: `Empresa Teste ${i} LLC`,
  worksite_state: "TX", worksite_city: "Austin",
  begin_date: "2026-10-01", end_date: "2027-03-31",
  apply_email: `rh${i}@empresa${i}.com`, basic_rate_from: "16.50",
  total_positions: 10, case_status: "certified",
});
// v49: pedido /h2a/ devolve vagas H-2A (case H-300-…) pro robô "Vagas Novas
// H-2A"; qualquer outro caminho segue devolvendo o feed H-2B de sempre.
const _mkVagaH2A = (i) => ({
  ..._mkVaga(i),
  case_number: `H-300-2600${String(i).padStart(2, "0")}-222222`,
  job_title: "Farm Worker", employer_business_name: `Fazenda Teste ${i} LLC`,
  apply_email: `rh${i}@fazenda${i}.com`,
});
// 🧪 v182 LOTE 8 — API DO DOL FALSA (detalhe de UMA vaga por ETA case number).
// O robô de enriquecimento e o de frescor perguntam
// `?$filter=case_number eq 'X'&$top=1` ao hostname real do DOL, que o sandbox
// não alcança — por isso os dois nunca eram exercitados de verdade. Com
// DOL_API_BASE apontando pra cá, o ciclo inteiro roda no npm test.
// Case number conhecido devolve o detalhe RICO (cidade suja, datas, descrição,
// meses de experiência, unidade de salário); qualquer outro devolve lista
// vazia — é o que deixa o frescor varrer jan2026 sem inventar dado nenhum.
const DOL_HITS = [];
// 🕊️ v195 LOTE 14: o $filter CRU que chegou à API falsa — é o que prova que a
// injeção OData nunca sai daqui e que 2 buscas iguais viram 1 pergunta só.
const DOL_FILTERS = [];
const DOL_DETALHE = {
  // exp já existe na linha (6 meses) e o DOL só diz Sim/Não → o número TEM que sobreviver
  "H-400-L8-0001": {
    case_number: "H-400-L8-0001", job_title: "Landscape Laborer", employer_business_name: "Oito Um LLC",
    worksite_city: "Franklin Baldwin, LA 70514", worksite_state: "LA",
    begin_date: "2027-03-01", end_date: "2027-11-30",
    job_duties: "Plant, mow and maintain lawns, gardens and grounds.",
    basic_rate_from: "800.00", pay_range_desc: "Week",
    experience_required: "Yes", total_positions: 12, case_status: "Certified",
    apply_email: "rh@oitoum.com",
  },
  // o DOL publica os MESES → grava 3 (antes o robô escrevia "1" em tudo)
  "H-400-L8-0002": {
    case_number: "H-400-L8-0002", job_title: "Housekeeper", employer_business_name: "Oito Dois LLC",
    worksite_city: "BAR HARBOR", worksite_state: "ME",
    begin_date: "2027-04-01", end_date: "2027-10-31",
    job_duties: "Clean guest rooms and common areas.",
    basic_rate_from: "1600.00", pay_range_desc: "Bi-Weekly",
    experience_months: 3, experience_required: "Yes", total_positions: 4, case_status: "Certified",
    apply_email: "rh@oitodois.com",
  },
  // pagamento por PEÇA + sem meses: expReq=sim e `exp` continua ausente
  "H-400-L8-0003": {
    case_number: "H-400-L8-0003", job_title: "Crop Harvester", employer_business_name: "Oito Tres LLC",
    worksite_city: "13033", worksite_state: "NY",
    begin_date: "2027-05-01", end_date: "2027-09-30",
    job_duties: "Harvest apples by hand.",
    basic_rate_from: "3.00", pay_range_desc: "Piece Rate",
    experience_required: "Yes", total_positions: 30, case_status: "Certified",
    apply_email: "rh@oitotres.com",
  },
};
const feedSrv = http.createServer((rq, rs) => {
  const url = rq.url || "";
  if (url.startsWith("/dol/")) {
    // URLSearchParams decodifica "+" como espaço (decodeURIComponent não).
    const filtro = new URLSearchParams(url.split("?")[1] || "").get("$filter") || "";
    const m = filtro.match(/case_number eq '([^']+)'/);
    const cn = m ? m[1].toUpperCase() : "";
    DOL_FILTERS.push(filtro + "|" + (new URLSearchParams(url.split("?")[1] || "").get("$search") || ""));
    DOL_HITS.push(cn);
    const det = DOL_DETALHE[cn];
    rs.writeHead(200, { "Content-Type": "application/json" });
    return rs.end(JSON.stringify({ value: det ? [det] : [] }));
  }
  const h2a = url.includes("/h2a/");
  // 🗓️ v207: simula o DOL sem o arquivo de HOJE (404 só na data de hoje) ou
  // sem arquivo nenhum (404 em qualquer data) — caso real de 19/09/2026.
  const _dataUrl = (url.match(/\/(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
  if (fs.existsSync(path.join(DATA, "h2a_feed_404_todos.flag")) || (fs.existsSync(path.join(DATA, "h2a_feed_404_hoje.flag")) && _dataUrl === new Date().toISOString().slice(0, 10))) { rs.writeHead(404); return rs.end("not found"); }
  const vagas = [];
  for (let i = 1; i <= 14; i++) vagas.push(h2a ? _mkVagaH2A(i) : _mkVaga(i));
  vagas.push(h2a ? _mkVagaH2A(1) : _mkVaga(1)); // duplicada de propósito
  vagas.push({ ...(h2a ? _mkVagaH2A(15) : _mkVaga(15)), apply_email: "" }); // sem e-mail — deve cair fora
  // v50: com o arquivo-bandeira presente, a vaga 14 vem RETIRADA (withdrawn)
  // — o robô tem que atualizar o status e REMOVER ela da planilha.
  if (h2a && fs.existsSync(path.join(DATA, "h2a_feed_withdraw.flag"))) vagas[13].case_status = "withdrawn";
  rs.writeHead(200, { "Content-Type": "application/json" });
  rs.end(JSON.stringify(vagas));
});
feedSrv.listen(FEED_PORT);

// ── 📧 v202 LOTE 20 — GMAIL/OAUTH FALSOS (o motor de envio testado de verdade)
// Até aqui TODOS os POSTs em /api/send e /api/auto/start da suíte paravam nos
// portões (402/429/400/lock): o Gmail e o endpoint de token do Google são
// hosts fixos que o sandbox não alcança, então nenhum check jamais viu uma
// candidatura SAIR. As garantias mais caras do repo (token vencido no meio da
// fila → renova → re-tenta a MESMA vaga; erro pós-envio que devolve ok:true;
// extra com auth morta isolado) eram provadas por grep de string no server.js
// — renomear um log quebrava o teste e quebrar a lógica mantendo o texto
// passava verde. Mesmo padrão do feed falso do DOL (v182): o servidor recebe
// GOOGLE_FAKE_BASE apontando pra cá e o funil único (httpsReq, mod-gmail.js)
// redireciona SÓ os 2 hosts exatos do Google.
const GOOGLE_PORT = PORT + 2;
const GOOGLE = {
  envios: [],        // cada envio ACEITO: {para, de, auth, assunto}
  refreshes: [],     // cada renovação pedida: {refresh_token, em}
  revokes: [],
  // fila de respostas FORÇADAS pro próximo envio (shift a cada requisição):
  // {status, body} — vazia = 200 normal
  falhasEnvio: [],
  // refresh_tokens que o Google considera MORTOS (invalid_grant)
  rtMortos: new Set(),
  n: 0,
  limpar() { this.envios = []; this.refreshes = []; this.revokes = []; this.falhasEnvio = []; this.rtMortos = new Set(); },
};
// Lê o cabeçalho To:/From: do MIME base64url que o app monta — é o que prova
// que a MESMA vaga foi re-enviada depois da renovação de token.
const _mimeHeader = (rawB64, nome) => {
  try {
    const txt = Buffer.from(String(rawB64 || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const m = txt.match(new RegExp("^" + nome + ":\\s*(.+)$", "mi"));
    if (!m) return "";
    // Assunto/nome viajam em RFC 2047 (=?UTF-8?B?...?=) — decodifica pra dar
    // pra afirmar sobre o TEXTO que o empregador/admin recebe.
    return m[1].trim().replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => Buffer.from(b, "base64").toString("utf8"));
  } catch { return ""; }
};
const googleSrv = http.createServer((rq, rs) => {
  let b = "";
  rq.on("data", (c) => (b += c));
  rq.on("end", () => {
    const url = (rq.url || "").split("?")[0];
    const resp = (status, obj) => { rs.writeHead(status, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
    // ── Gmail: enviar mensagem ──────────────────────────────────────────
    if (url === "/gmail/v1/users/me/messages/send") {
      const forcado = GOOGLE.falhasEnvio.shift();
      if (forcado) {
        // 🚨 v237l: simula o "timeout ambíguo" — a conexão cai SEM nenhuma
        // resposta HTTP (destrói o socket em vez de responder), do jeito que
        // um timeout de rede de verdade se parece pro cliente (httpsReq,
        // mod-gmail.js). Diferente de {status,body} — aquilo é uma resposta
        // CONFIRMADA do Gmail (mesmo sendo um erro), nunca ambígua.
        if (forcado.networkError) { rq.socket.destroy(); return; }
        return resp(forcado.status, forcado.body);
      }
      let payload = {}; try { payload = JSON.parse(b || "{}"); } catch {}
      GOOGLE.n++;
      GOOGLE.envios.push({
        para: _mimeHeader(payload.raw, "To"),
        de: _mimeHeader(payload.raw, "From"),
        assunto: _mimeHeader(payload.raw, "Subject"),
        auth: String(rq.headers.authorization || "").replace(/^Bearer /, ""),
        n: GOOGLE.n,
      });
      return resp(200, { id: "msg-" + GOOGLE.n, threadId: "thr-" + GOOGLE.n, labelIds: ["SENT"] });
    }
    // ── OAuth: renovar access_token pelo refresh_token ──────────────────
    if (url === "/token") {
      const rt = new URLSearchParams(b || "").get("refresh_token") || "";
      GOOGLE.refreshes.push({ refresh_token: rt, em: Date.now() });
      if (GOOGLE.rtMortos.has(rt)) return resp(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      GOOGLE.n++;
      return resp(200, { access_token: "at-vivo-" + GOOGLE.n, expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.send", token_type: "Bearer" });
    }
    if (url === "/revoke") { GOOGLE.revokes.push(b); return resp(200, {}); }
    return resp(404, { error: "rota falsa desconhecida: " + url });
  });
});
googleSrv.listen(GOOGLE_PORT);

// ── Fixture: o "caso Kley" real ─────────────────────────────────────────
const b64 = Buffer.from(
  "%PDF-1.4 conteudo falso de teste ".repeat(8)
).toString("base64");
const users = {
  "cliente@test.com": {
    name: "Kley",
    cvs: [
      { idx: 1001, name: "Cover_H2A.pdf", size: 5000, cvType: "cover", b64 },
      { idx: 1002, name: "Cover_H2A.pdf", size: 5000, cvType: "cover", b64 },
      { idx: 1003, name: "Cover_H2A.pdf", size: 5000, cvType: "cover", b64 },
      { idx: 1004, name: "Curriculo.pdf", size: 8000, cvType: "resume", b64 },
    ],
    profiles: [
      { id: "pa", name: "Perfil H-2A", visaType: "h2a", active: true,
        subjects: ["a", "b", "c"], emailBodies: ["x", "y", "z"],
        resumeIdx: 1004, coverIdx: 1002 },
      { id: "pb", name: "Perfil H-2B", visaType: "h2b", active: true,
        subjects: ["a", "b", "c"], emailBodies: ["x", "y", "z"],
        resumeIdx: 9999, pdfName: "Curriculo.pdf", coverIdx: null },
    ],
  },
  // Usuário legado: perfil com NOMES-fantasma (pdfName/coverName sem idx) —
  // o currículo existe na conta (religa pelo nome); a carta sumiu (limpa nome)
  "legado@test.com": {
    name: "Legado",
    // Texto ENLATADO de fábrica intocado (v22 deve limpar) + um campo editado
    // pelo usuário (v22 NUNCA pode tocar)
    settings: {
      subject: "Application for {vaga} – {nome}",
      body: "Texto que o usuário escreveu com as próprias mãos",
    },
    cvs: [{ idx: 2001, name: "MeuCV.pdf", size: 4000, cvType: "resume", b64 }],
    profiles: [
      { id: "pl", name: "Perfil H-2B", visaType: "h2b", active: true,
        subjects: ["a", "b", "c"], emailBodies: ["x", "y", "z"],
        resumeIdx: null, pdfName: "MeuCV.pdf",
        coverIdx: null, coverName: "CartaQueSumiu.pdf" },
    ],
  },
};
// v43-PERF: 1.500 usuários sintéticos, cada um com refresh_token/access_token
// (o mesmo formato de quem conectou Google de verdade) — estressa o MESMO
// laço de criptografia (AES-256-GCM sobre todos os usuários) que travava o
// servidor inteiro a cada salvamento de perfil, ANTES do fix de 23/07/2026
// (setUser() tratava array — sempre truthy — como campo "crítico" e gravava
// o banco INTEIRO de forma síncrona e bloqueante a cada save). Sem essa
// população, o bug de performance passaria despercebido pra sempre — a
// suíte SEM isso testa correção, não velocidade sob carga real.
for (let i = 0; i < 5000; i++) {
  users["perfuser" + i + "@test.com"] = {
    name: "Perf User " + i,
    // Tamanho realista de token OAuth de verdade (não "fake-0" — isso não
    // estressa nada; o custo real é AES-256-GCM + JSON.stringify sobre o
    // payload inteiro, que só aparece com tokens do tamanho de produção).
    refresh_token: "1//" + crypto.randomBytes(24).toString("hex"),
    cached_access_token: "ya29." + crypto.randomBytes(40).toString("hex"),
    cached_token_expiry: Date.now() + 3600_000,
    plan: "vip", cvs: [], profiles: [],
  };
}
// 📋 v118 (ORDEM DO DONO, 02/08 — novas regras de planos): usuário LEGADO
// com VipPro pago ANTES da mudança (sem vip.limits carimbado). O contrato
// dele é o da tabela ANTIGA (200/200) até expirar — nenhum pagante perde
// nada — e o /api/status precisa AVISAR (planRulesNotice).
// ⏫ v125: dono do robô que dorme em waiting_limit (fixture em auto_jobs.json)
users["dormindo@test.com"] = { name: "Dormindo", plan: "free", cvs: [], profiles: [] };
// 🔒 v172h (ordem do dono, 12/09/2026): job ATIVO de um plano que NUNCA foi
// pago (free) — scheduleAuto tem que parar de vez (paused_no_vip), nunca
// mais reagendar pra meia-noite pra sempre com "0/0 envios" (fixture em
// auto_jobs.json).
users["planovencido@test.com"] = { name: "Plano Vencido", plan: "free", cvs: [], profiles: [] };
// 🇧🇷 v199 LOTE 17: conta PRESA em inglês (legada / gravada por POST direto no
// /api/settings, que aceitava pt|en|es). Como o site não tem seletor de idioma,
// ela abria o app inteiro em EN sem NENHUM caminho de volta — a migração de
// boot tem que curá-la sozinha.
users["idiomaen@test.com"] = { name: "Idioma EN", plan: "free", cvs: [], profiles: [], language: "en" };
users["idiomaptbr@test.com"] = { name: "Idioma PT-BR", plan: "free", cvs: [], profiles: [], language: "pt-BR" };
users["legadoplano@test.com"] = {
  name: "Legado Plano", plan: "vipro", cvs: [], profiles: [],
  vip: { manualExpires: Date.now() + 20 * 86400_000, autoExpires: Date.now() + 20 * 86400_000, days: 30, source: "pix", active: true },
};
fs.writeFileSync(path.join(DATA, "users.json"), JSON.stringify(users, null, 2));
// 🔓 v152: simula o ban acidental do Esdras (delete-account bane o e-mail
// junto) — a cura de boot tem que tirar SÓ ele, preservando bans legítimos.
// v152b: a lista guarda a grafia com PONTOS TROCADOS de propósito (Gmail
// ignora pontos) — a cura precisa achar pela forma canônica, não por texto.
fs.writeFileSync(path.join(DATA, "blocked_emails.json"), JSON.stringify({
  emails: ["esdrassilva.h2b@gmail.com", "fica.banido@test.com"] }));
// 🩻 v163: 2 pedidos com comprovante em base64 pra medir os que ficam
// RESIDENTES na RAM.
fs.writeFileSync(path.join(DATA, "pedidos.json"), JSON.stringify([
  { id: "pedmem1", userEmail: "memtest1@test.com", userName: "Mem Teste Um", tipo: "doacao", plano: "doacao",
    valorTotal: 50, diamantes: 33, status: "ativo", comprovante: Buffer.from("comprovante-mem-1").toString("base64"),
    comprovanteType: "image/jpeg", createdAt: Date.now() - 86400_000, ativadoEm: Date.now() - 86400_000 },
  { id: "pedmem2", userEmail: "memtest2@test.com", userName: "Mem Teste Dois", tipo: "doacao", plano: "doacao",
    valorTotal: 50, diamantes: 33, status: "ativo", comprovante: Buffer.from("comprovante-mem-2").toString("base64"),
    comprovanteType: "image/jpeg", createdAt: Date.now() - 86400_000, ativadoEm: Date.now() - 86400_000 },
  // 🐛 pedido pendente há 7h — alimenta o watchdog pendingOrderAlert
  // (mod-sentinel.js) pro teste do fallback de admin sem token.
  { id: "pedwatch1", userEmail: "watchtest@test.com", userName: "Watch Teste", tipo: "doacao", plano: "vipro",
    valorTotal: 150, status: "pendente", createdAt: Date.now() - 7 * 3600_000 },
  // 🗓️ v193 LOTE 11 — pedido LEGADO com `pagoEm` LIXO (criado antes da
  // validação na porta). Aprovar este pedido era o bug: os dias eram
  // creditados e só DEPOIS `new Date("xyz").toISOString()` estourava
  // RangeError → 500, persistPedidos nunca rodava, ZERO entrada no caixa e a
  // 2ª tentativa batia no 409 "já foi ativado" (o "pedido ativo sem caixa"
  // que a contabilidade existe pra evitar).
  { id: "pedlixo1", userEmail: "pagoemlixo@test.com", userName: "Pago Em Lixo", tipo: "plano", plano: "vip",
    dias: 30, valorTotal: 100, status: "pendente", createdAt: Date.now() - 2 * 3600_000, pagoEm: "xyz" }]));
fs.writeFileSync(path.join(DATA, "financeiro.json"), JSON.stringify({ pagamentos: [
  // 💼 MC4-P1: entrada avulsa SEM recebidoPor e SEM trilha de admin — tem que
  // cair no balde "sem dono" (nunca chutar) até o admin atribuir em 1 clique.
  { id: "favulso1", email: "avulso@test.com", nome: "Entrada Avulsa", valor: 77, dataPagamento: "2026-08-21", criadoEm: Date.now() - 86400_000 }],
  // 💼 MC4-P1: gastos com pagador conhecido (andrio/diego = do bolso, a
  // receber de volta; empresa = sai só do lucro) + 1 repasse já feito D→A.
  gastos: [
    { id: "gsm1", descricao: "Render mensal", valor: 120, dataGasto: "2026-08-10", pagoPor: "andrio", categoria: "servidor", criadoEm: Date.now() - 10 * 86400_000 },
    { id: "gsm2", descricao: "Anúncio Insta", valor: 40, dataGasto: "2026-08-12", pagoPor: "diego", categoria: "marketing", criadoEm: Date.now() - 8 * 86400_000 },
    // 💼 MC4-P2: gsm3 TEM comprovante — a regra RULE_GASTO_SEM_COMPROVANTE
    // deve apontar gsm1/gsm2 e NUNCA este.
    { id: "gsm3", descricao: "Domínio", valor: 60, dataGasto: "2026-08-14", pagoPor: "empresa", categoria: "servidor", criadoEm: Date.now() - 6 * 86400_000,
      comprovante: Buffer.from("comprovante-dominio").toString("base64"), comprovanteType: "image/jpeg", temComprovante: true }],
  repasses: [
    { id: "repfix1", de: "diego", para: "andrio", valor: 50, dataRepasse: "2026-08-16T12:00:00.000Z", nota: "acerto parcial", criadoEm: Date.now() - 5 * 86400_000 }] }));
// (promo_codes.json não é mais escrito aqui — Códigos Promocionais foram
// removidos por completo nesta reconstrução, sem rota de resgate; o arquivo
// só sobrevive na fusão/exportação de servidores para dado histórico legado.)
// ⏳ v118: histórico com 1 envio manual carimbado AGORA — o teste do cooldown
// (1 manual/minuto) roda LOGO após o boot, enquanto a janela de 60s do
// fixture ainda está aberta, e tem que levar 429 com cooldownLeft.
// 🌾 v122 (dono, 08/08: "daqui 1 mês gera outra em setembro"): a mensal
// roda de novo assim que muda o mês. Fixture: última rodada há EXATAMENTE
// 1 mês — o robô TEM que rodar (no regime antigo de 2 meses, recusaria;
// se alguém reverter pra bimestral, esta guarda quebra na hora).
const _bimMesPassado = new Date(); _bimMesPassado.setUTCMonth(_bimMesPassado.getUTCMonth() - 1);
fs.writeFileSync(path.join(DATA, "h2a_bimestral.json"), JSON.stringify({ lastKey: "h2a-mes-anterior", lastRunAt: _bimMesPassado.getTime() }));
// 🧟 v124 (vídeo do dono, 10/08): job ZUMBI — active:true com fila VAZIA
// (sobra de crash/deploy no instante em que a fila zerou). O cliente monta
// uma fila NOVA e clica iniciar: o start NUNCA pode ressuscitar o zumbi
// ("reiniciei — 0 vagas") nem bloquear — descarta o velho e inicia o novo.
fs.writeFileSync(path.join(DATA, "auto_jobs.json"), JSON.stringify({
  "zumbi@test.com": { active: true, status: "sending", source: "manual", queue: [], originalCount: 7, startedAt: Date.now() - 3600_000, subjects: ["a"], emailBodies: ["b"] },
  // ⏫ v125 (print do dono, 12/08): robô dormindo por LIMITE DO PLANO ANTIGO
  // ("waiting_limit" até amanhã). Quando o plano novo for ativado, tem que
  // ACORDAR na hora — nunca mais pagante esperando a meia-noite à toa.
  "dormindo@test.com": { active: true, status: "waiting_limit", source: "manual", nextSendAt: Date.now() + 14 * 3600_000, queue: [{ to: "vaga@dormindo-test.com", title: "Cook", company: "Empresa D" }], originalCount: 5, startedAt: Date.now() - 7200_000, subjects: ["a"], emailBodies: ["b"] },
  // 🔒 v172h: job que estava "sending" quando o plano (free, nunca pago)
  // deveria ter travado o automático — scheduleAuto tem que parar de vez.
  "planovencido@test.com": { active: true, status: "sending", source: "manual", queue: [{ to: "vaga@planovencido-test.com", title: "Cook", company: "Empresa V" }], originalCount: 3, startedAt: Date.now() - 3600_000, subjects: ["a"], emailBodies: ["b"] },
}));
const COOLDOWN_FIX_TS = Date.now();
fs.writeFileSync(path.join(DATA, "history.json"), JSON.stringify({
  "cooldown@test.com": [{ to: "empresa@teste-cooldown.com", subject: "x", type: "manual", sentAt: new Date(COOLDOWN_FIX_TS).toISOString(), date: "hoje" }],
}));
// PDF órfão no disco (lixo do antigo delete sem unlink) — o sweep deve apagar
fs.mkdirSync(path.join(DATA, "cvs"), { recursive: true });
fs.writeFileSync(path.join(DATA, "cvs", "fantasma@test.com_777.pdf"), "%PDF-1.4 orfao");

// 🚨 v177-FIX2: e-mail com bounce JÁ conhecido — usado pra provar que o envio
// MANUAL (não só o automático) recusa gastar limite mandando pra ele.
fs.writeFileSync(path.join(DATA, "invalid_emails.json"), JSON.stringify({
  "bounce177@empresa-invalida.com": { email: "bounce177@empresa-invalida.com", domain: "empresa-invalida.com", motivo: "smoke fixture", tipo: "bounce", first: Date.now(), last: Date.now(), count: 3, users: ["ninguem@test.com"], msg: "550 mailbox not found", status: "invalid" },
}, null, 2));

// v46: notícias com data futura/absurda (bug real, print do dono 23/07:
// (aba Notícias/DOL removida nesta reconstrução — sem DB_NOTICIAS/vigia no
// server.js; fixtures antigas de notícia inválida/baseline saíram.)

// v48: INCIDENTE REAL (25/07, print do dono: "as vagas das planilhas de
// inverno e h2a sumiram") — cópia de /data truncada (gravação não-atômica
// interrompida) e cópia vazia. Como /data tem prioridade, o load antigo
// fazia `continue` e a planilha ficava vazia PRA SEMPRE, mesmo com a cópia
// bundled boa no código. O boot novo tem que recuperar pelas bundled.
fs.writeFileSync(path.join(DATA, "jul2025_compact.json"), '[{"c":"ETA-123","n":"Truncada Corp","e":"x@y.co');
fs.writeFileSync(path.join(DATA, "h2a_jun2026_compact.json"), "[]");

// 🧹 v191 LOTE 9: resíduo do backup.json aposentado — ele guardava TODOS os
// usuários com refresh_token do Google e hash de senha em TEXTO PURO (passava
// por fora do DATA_ENC_KEY) e ninguém nunca o leu. O boot tem que apagá-lo.
fs.writeFileSync(path.join(DATA, "backup.json"), JSON.stringify({
  ts: new Date().toISOString(), total: 1,
  users: { "vazado@test.com": { email: "vazado@test.com", refresh_token: "1//SEGREDO-EM-TEXTO-PURO", passwordHash: "hash-em-texto-puro" } },
}));

// ── Helpers ─────────────────────────────────────────────────────────────
const TEST_TOKEN = "smoke-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
let COOKIE = ""; // jar de 1 cookie (sessão de teste)

const req2 = (method, p, payload) => new Promise((resolve, reject) => {
  const body = payload ? JSON.stringify(payload) : null;
  const r = http.request(BASE + p, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      ...(COOKIE ? { Cookie: COOKIE } : {}),
    },
  }, (res) => {
    const sc = res.headers["set-cookie"];
    if (sc && sc.length) COOKIE = sc[0].split(";")[0];
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      let json = null; try { json = JSON.parse(b); } catch {}
      resolve({ status: res.statusCode, body: b, json, headers: res.headers });
    });
  });
  r.on("error", reject);
  if (body) r.write(body);
  r.end();
});
// v240b: variante binária de req2 — manda um Buffer cru como corpo (com o
// Content-Type que o caminho novo de /api/cv/upload espera), pra provar o
// streaming direto-pro-disco sem passar por base64/JSON.
const reqBin = (method, p, buf, contentType) => new Promise((resolve, reject) => {
  const r = http.request(BASE + p, {
    method,
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": buf.length,
      ...(COOKIE ? { Cookie: COOKIE } : {}),
    },
  }, (res) => {
    const sc = res.headers["set-cookie"];
    if (sc && sc.length) COOKIE = sc[0].split(";")[0];
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      let json = null; try { json = JSON.parse(b); } catch {}
      resolve({ status: res.statusCode, body: b, json, headers: res.headers });
    });
  });
  r.on("error", reject);
  r.write(buf);
  r.end();
});
// Variante de req2 que sobe o corpo DEVAGAR (2 pedaços com `gapMs` entre
// eles) — o servidor começa a rodar o handler quando chegam os CABEÇALHOS,
// então essa janela é a corrida real de uma rede lenta (4G): duas
// requisições vivas dentro do mesmo handler, antes de qualquer `await`
// resolver. Usada pra provar travas de concorrência de verdade.
const reqSlow = (method, p, payload, gapMs) => new Promise((resolve, reject) => {
  const body = Buffer.from(JSON.stringify(payload || {}));
  const meio = Math.max(1, Math.floor(body.length / 2));
  const r = http.request(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", "Content-Length": body.length, ...(COOKIE ? { Cookie: COOKIE } : {}) },
  }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
  });
  r.on("error", reject);
  r.write(body.subarray(0, meio));
  setTimeout(() => r.end(body.subarray(meio)), gapMs);
});
const get = (p) => req2("GET", p);
// 🚨 v239: requisição com header Host CUSTOM — simula bater no servidor por
// um domínio diferente (custom domain, onrender.com, host de ataque), sem
// precisar subir um 2º servidor nem mexer em DNS. Node aceita override
// explícito de Host mesmo indo fisicamente pra BASE (127.0.0.1:PORT) —
// exatamente como o Render entrega: a conexão física chega no processo,
// mas o header Host preserva o domínio que o navegador visitou.
const reqHost = (p, hostHeader) => new Promise((resolve, reject) => {
  const r = http.request(BASE + p, { method: "GET", headers: { Host: hostHeader } }, (res) => {
    let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
  });
  r.on("error", reject); r.end();
});
// 🔒 v182 LOTE 10: requisição ANÔNIMA de verdade — sem cookie nenhum, do jeito
// que um scraper bate. O req2 mantém um jar de sessão; aqui não vai nada.
const getSemCookie = (p) => new Promise((resolve, reject) => {
  const r = http.request(BASE + p, { method: "GET" }, (res) => {
    let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch { } resolve({ status: res.statusCode, body: b, json }); });
  });
  r.on("error", reject); r.end();
});
// Variante binária de get() — pra respostas não-JSON (CSV/imagem) onde o
// corpo precisa chegar como Buffer intacto, nunca decodificado/truncado.
const _getBufA = (p) => new Promise((resolve, reject) => {
  const r = http.request(BASE + p, {
    method: "GET",
    headers: { ...(COOKIE ? { Cookie: COOKIE } : {}) },
  }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
  });
  r.on("error", reject);
  r.end();
});

const waitUp = async (ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await get("/api/status"); if (r.status) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

let failed = 0;
const check = (nome, ok, detalhe) => {
  console.log(`  ${ok ? "✅" : "❌"} ${nome}${ok || !detalhe ? "" : " — " + detalhe}`);
  if (!ok) failed++;
};

// ── Unit: watchdog de auth_error avisa por PUSH (e-mails estão desligados
// por decisão do dono — sem push, cliente pagante com robô morto não sabia).
async function testAuthWatchdogPush() {
  const { initWatchdogs } = require("./mod-watchdogs.js");
  let pushed = null;
  const wd = initWatchdogs({
    DB_AUTO: () => ({ "vip@test.com": { active: false, status: "paused_auth_error", finishedAt: Date.now() - 13 * 3600_000 } }),
    autoTimers: () => new Map(),
    getUser: (e) => ({ email: e, lastSeenAt: Date.now() - 3600_000 }),
    getAutoJob: () => null, setAutoJob: () => {}, addLog: () => {},
    sendNotifEmail: async () => {}, refreshTokenForUser: async () => {},
    authErrNotifiedAtInit: {}, botLog: () => {},
    pushToUser: async (email, payload) => { pushed = { email, payload }; },
  }, { startIntervals: false });
  await wd.authErrorWatchdog();
  check("📲 robô parado >12h por erro de Gmail dispara PUSH pro cliente",
    pushed && pushed.email === "vip@test.com" && /reconecte/i.test(pushed.payload?.title || ""), JSON.stringify(pushed)?.slice(0, 120));
}

// ── 🔁 v199 LOTE 19 — CICLO DE VIDA DO SERVIDOR (helper ÚNICO) ──────────
// A suíte sobe servidor em 3 momentos (o principal, o drill de restauração do
// v191 e os 2 bootes novos deste lote). Antes cada um tinha seu próprio
// spawn/kill copiado: o do v191 esperava o evento 'exit' com teto, o principal
// dava SIGKILL direto. Com 2 bootes novos no MESMO DATA_DIR, "matar e esperar
// de verdade" virou requisito — se o processo antigo não morre, o próximo
// spawn bate em porta ocupada e a suíte falha pelo motivo ERRADO. Um helper
// só, usado por todos.
function spawnServidor(env, onLog) {
  const p = spawn(process.execPath, ["server.js"], {
    cwd: __dirname, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (c) => onLog(String(c)));
  p.stderr.on("data", (c) => onLog(String(c)));
  return p;
}
// Resolve true se o processo REALMENTE saiu dentro do teto; senão manda
// SIGKILL e resolve false (nunca deixa processo órfão segurando a porta).
function matarServidor(proc, sinal = "SIGTERM", tetoMs = 15_000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve(true);
    let pronto = false;
    const fim = (ok) => { if (!pronto) { pronto = true; resolve(ok); } };
    proc.once("exit", () => fim(true));
    try { proc.kill(sinal); } catch { return fim(false); }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} setTimeout(() => fim(false), 800); }, tetoMs);
  });
}
async function esperarNoAr(ping, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await ping(); if (r.status) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ── 🛟 v191 LOTE 9 — DRILL REAL DE RESTAURAÇÃO DE BACKUP ────────────────
// O roteiro de emergência (RESTAURACAO_BACKUP.md) era "ensaiado" só até a
// metade: ninguém nunca tinha restaurado com o SERVIDOR VIVO e reiniciado
// depois. E era aí que ele se desfazia sozinho — o processo seguia com toda a
// memória PRÉ-restore, um setUser debounced regravava users.json segundos
// depois e o SIGTERM do "reinicie o servidor" mandava o flushAll gravar TUDO
// por cima dos arquivos recém-restaurados (pedidos/financeiro voltavam,
// usuários/histórico/robôs não: restauração MISTA e silenciosa).
// Este drill sobe um servidor SÓ dele, com disco próprio, e faz o caminho
// inteiro de verdade: backup → mudanças → restore pela rota → SIGTERM →
// reinício → os dados restaurados continuam lá.
async function drillRestauracaoBackup() {
  const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-restore-"));
  const PORT_B = PORT + 40;
  const BASE_B = `http://127.0.0.1:${PORT_B}`;
  let COOKIE_B = "";
  let logB = "";
  let srvB = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reqB = (method, p, payload) => new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const r = http.request(BASE_B + p, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...(COOKIE_B ? { Cookie: COOKIE_B } : {}),
      },
    }, (res) => {
      const sc = res.headers["set-cookie"];
      if (sc && sc.length) COOKIE_B = sc[0].split(";")[0];
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
  const subir = async () => {
    logB = "";
    srvB = spawnServidor({ PORT: String(PORT_B), DATA_DIR: DATA_B, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", BACKUP_BOOT_MS: "1200" },
      (t) => (logB += t));
    return esperarNoAr(() => reqB("GET", "/api/status"), 40_000);
  };
  const derrubar = async (sinal) => { const p = srvB; srvB = null; await matarServidor(p, sinal); };
  const lerJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_B, f), "utf8")); } catch { return null; } };
  const pastasBackup = () => { try { return fs.readdirSync(path.join(DATA_B, "backups")).filter((d) => /^\d{4}-/.test(d)); } catch { return []; } };

  try {
    // Estado ORIGINAL em disco ANTES do 1º boot — é ele que o backup guarda.
    fs.writeFileSync(path.join(DATA_B, "users.json"), JSON.stringify({
      "drill@test.com": {
        email: "drill@test.com", name: "Drill ORIGINAL", plan: "vipro", created_at: new Date().toISOString(),
        cvs: [], profiles: [], saved: [], onboarded: true,
        vip: { active: true, plan: "vipro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 },
      },
    }));
    fs.writeFileSync(path.join(DATA_B, "auto_jobs.json"), JSON.stringify({ "drill@test.com": { active: false, status: "ORIGINAL", queue: [] } }));
    fs.writeFileSync(path.join(DATA_B, "history.json"), JSON.stringify({ "drill@test.com": [{ id: "h1", ts: Date.now(), to: "original@empresa.com", company: "ORIGINAL LTDA", status: "enviado" }] }));
    // 🧾 v192 LOTE 10: pedido LEGADO com o comprovante inline — o boot migra
    // pro disco, e o backup/restore tem que cobrir a pasta nova (mesma lição
    // do v27-FIX com a cvs/: backup sem ela devolvia conta sem currículo).
    const BYTES_COMP = Buffer.from("comprovante-do-drill-192").toString("base64");
    fs.writeFileSync(path.join(DATA_B, "pedidos.json"), JSON.stringify([
      { id: "peddrill1", userEmail: "drill@test.com", userName: "Drill ORIGINAL", tipo: "plano", plano: "vipro",
        dias: 30, valorTotal: 150, status: "ativo", createdAt: Date.now() - 86400_000, ativadoEm: Date.now() - 86400_000,
        comprovante: BYTES_COMP, comprovanteType: "image/jpeg" }]));

    check("🛟 v191-L9 (drill): servidor de restauração subiu com o estado ORIGINAL", await subir());

    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "admdrill@test.com", name: "Admin Drill", isAdmin: true });
    const _compDrill = path.join(DATA_B, "comprovantes", "peddrill1.b64");
    const _migrouNoBoot = fs.existsSync(_compDrill) &&
      !(JSON.parse(fs.readFileSync(path.join(DATA_B, "pedidos.json"), "utf8"))[0] || {}).comprovante;
    const bk = await reqB("POST", "/api/admin/v2/backup/create", { adminName: "Drill" });
    const nomeBk = bk.json?.name;
    // Perde o comprovante do disco DEPOIS do backup — é o cenário real
    // (arquivo corrompido/apagado) que o backup existe pra resolver.
    try { fs.unlinkSync(_compDrill); } catch {}
    check("🛟 v191-L9 (drill): backup completo criado pela rota do painel (todos os .json + cvs/)",
      bk.json?.ok === true && !!nomeBk && bk.json.files > 0, JSON.stringify({ status: bk.status, name: nomeBk, files: bk.json?.files }));

    // MUDANÇAS depois do backup — é isso que a restauração tem que desfazer.
    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "drill@test.com", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 90 * 86400_000, autoExpires: Date.now() + 90 * 86400_000 } });
    await reqB("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "drill@test.com", job: { active: false, status: "MUDADO_DEPOIS_DO_BACKUP", queue: [] } });
    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "depois@test.com", name: "Criado depois do backup" });

    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "admdrill@test.com", isAdmin: true });
    const rest = await reqB("POST", "/api/admin/v2/backup/restore", { name: nomeBk, adminName: "Drill", confirm: "RESTAURAR" });
    check("🛟 v191-L9 (drill): a rota de restore devolve os arquivos E declara que CONGELOU as gravações até o reinício",
      rest.json?.ok === true && rest.json?.restored > 0 && rest.json?.congelado === true && /CONGELAD/i.test(rest.json?.aviso || ""),
      JSON.stringify({ status: rest.status, restored: rest.json?.restored, congelado: rest.json?.congelado }));

    // Gravação SÍNCRONA depois do restore (markSent → persistSent → persist):
    // com o congelamento, NADA disso pode chegar ao disco.
    const sentAntes = JSON.stringify(lerJson("sent_emails.json") || {});
    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "drill@test.com", sentTo: ["congelado@empresa.com"] });
    await sleep(2500); // passa do debounce de histórico (1,5s) — ele também não pode gravar
    const sentDepois = JSON.stringify(lerJson("sent_emails.json") || {});
    check("❄️ v191-L9 (drill): com a restauração em andamento, NENHUMA gravação nova chega ao disco (nem a síncrona do markSent, nem os debounces pendentes)",
      sentDepois === sentAntes && !sentDepois.includes("congelado@empresa.com") && /GRAVAÇÕES CONGELADAS/.test(logB),
      JSON.stringify({ mudou: sentDepois !== sentAntes }));

    await derrubar("SIGTERM");
    const usersPos = lerJson("users.json") || {};
    const autoPos = lerJson("auto_jobs.json") || {};
    check("🛟 v191-L9 (drill): o SIGTERM do 'reinicie o servidor' NÃO grava a memória por cima do backup restaurado — era isso que desfazia a restauração inteira",
      !!usersPos["drill@test.com"] && !usersPos["depois@test.com"] && autoPos["drill@test.com"]?.status === "ORIGINAL" &&
      /gravações congeladas/i.test(logB),
      JSON.stringify({ temDepois: !!usersPos["depois@test.com"], job: autoPos["drill@test.com"]?.status }));

    // REINÍCIO: o servidor tem que subir servindo o estado restaurado.
    const backupsAntesBoot = pastasBackup().length;
    check("🛟 v191-L9 (drill): servidor reiniciou depois da restauração", await subir());
    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "drill@test.com" });
    const stDrill = await reqB("GET", "/api/status");
    const jobDrill = await reqB("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "drill@test.com" });
    const histDrill = await reqB("GET", "/api/history");
    check("🛟 v191-L9 (drill): depois do reinício o servidor SERVE o estado restaurado — plano, robô e histórico do backup (não os de depois dele)",
      stDrill.json?.plan === "vipro" && jobDrill.json?.job?.status === "ORIGINAL" &&
      JSON.stringify(histDrill.json || {}).includes("ORIGINAL LTDA"),
      JSON.stringify({ plano: stDrill.json?.plan, job: jobDrill.json?.job?.status }));

    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "admdrill@test.com", isAdmin: true });
    const _pedRestaurado = await reqB("GET", "/api/pedido/peddrill1");
    check("🧾 v192-L10 (drill): o comprovante em disco entra no backup e VOLTA na restauração — apagado depois do backup, ele reaparece com os bytes idênticos e o pedido abre normalmente (o boot também provou a migração do inline pro disco)",
      _migrouNoBoot && fs.existsSync(_compDrill) && fs.readFileSync(_compDrill, "utf8") === BYTES_COMP &&
      _pedRestaurado.json?.pedido?.comprovante === BYTES_COMP,
      JSON.stringify({ migrouNoBoot: _migrouNoBoot, voltou: fs.existsSync(_compDrill) }));

    await sleep(1800); // passa do BACKUP_BOOT_MS (1,2s) deste boot
    check("💾 v191-L9: boot com backup recente (<12h) NÃO cria outra pasta de backup — com deploy a cada commit e retenção de 3, três commits numa tarde apagavam os backups de ontem",
      pastasBackup().length === backupsAntesBoot && /já existe backup de/.test(logB),
      JSON.stringify({ antes: backupsAntesBoot, depois: pastasBackup().length }));

    // journey.json só existe via persistDebounced e NUNCA esteve na lista fixa
    // do flushAll — antes deste lote ele se perdia em todo deploy.
    await reqB("POST", "/api/test/login", { token: TEST_TOKEN, email: "drill@test.com" }); // volta pra conta do usuário
    const pdf = Buffer.from("%PDF-1.4 drill " + "conteudo de teste ".repeat(300)).toString("base64");
    const upl = await reqB("POST", "/api/cv/upload", { base64: pdf, name: "Drill.pdf", cvType: "resume" });
    await derrubar("SIGTERM");
    await sleep(300); // o stdout do processo ainda pode estar chegando
    const jornada = lerJson("journey.json") || {};
    const linhaFlush = (logB.match(/\[shutdown\] ✅ Dados salvos \(.*?\): ([^\n]+)/) || [])[1] || "";
    const listaFlush = linhaFlush.split(",").map((x) => x.trim()).filter(Boolean);
    const repetido = listaFlush.filter((f, i) => listaFlush.indexOf(f) !== i);
    check("💾 v191-L9: o flushAll do desligamento grava TODO debounce pendente (journey.json entrou sem estar em lista fixa nenhuma) e não serializa banco nenhum duas vezes",
      upl.json?.ok === true && JSON.stringify(jornada["drill@test.com"] || []).includes("pdf_upload") &&
      listaFlush.includes("journey.json") && listaFlush.includes("users.json") && repetido.length === 0,
      JSON.stringify({ lista: linhaFlush.slice(0, 160), repetido }));

    // Mesma decisão, o outro lado: backup ANTIGO (>12h) volta a rodar no boot.
    for (const d of pastasBackup()) {
      const velho = Date.now() - 20 * 3600_000;
      try { fs.utimesSync(path.join(DATA_B, "backups", d), velho / 1000, velho / 1000); } catch {}
    }
    const antesVelho = pastasBackup().length;
    await subir();
    await sleep(2500);
    check("💾 v191-L9: com o backup mais recente já velho (20h), o boot CRIA um novo — a rede de segurança continua existindo, só parou de se atropelar",
      pastasBackup().length === antesVelho + 1, JSON.stringify({ antes: antesVelho, depois: pastasBackup().length }));
  } catch (e) {
    check("🛟 v191-L9 (drill): execução sem exceção", false, e.message);
  } finally {
    try { await derrubar("SIGKILL"); } catch {}
    try { fs.rmSync(DATA_B, { recursive: true, force: true }); } catch {}
  }
}

// ── 🚧 INTERRUPTOR DE EMERGÊNCIA — compra nova (19/09/2026, ATUALIZADO no
// mesmo dia: h2bapply.com passou a apontar pra este ambiente DE VERDADE) ──
// Nasceu bloqueado por default (o ambiente ainda não era o domínio oficial);
// virou interruptor de emergência DESLIGADO por default assim que o domínio
// foi migrado de verdade — continuar bloqueando por padrão derrubaria
// assinatura nova de gente real. Este drill sobe um servidor PRÓPRIO
// (BLOCK_NEW_PURCHASES=true) só pra provar que o interruptor, SE ligado um
// dia, recusa de verdade no backend — e confirma que a suíte principal
// (sem essa env, igual produção hoje) deixa comprar normal.
async function drillBloqueioComprasNovas() {
  const DATA_N = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-blocknew-"));
  const PORT_N = PORT + 70;
  const BASE_N = `http://127.0.0.1:${PORT_N}`;
  let COOKIE_N = "";
  let logN = "";
  let srvN = null;
  const reqN = (method, p, payload) => new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const r = http.request(BASE_N + p, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...(COOKIE_N ? { Cookie: COOKIE_N } : {}),
      },
    }, (res) => {
      const sc = res.headers["set-cookie"];
      if (sc && sc.length) COOKIE_N = sc[0].split(";")[0];
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
  try {
    // BLOCK_NEW_PURCHASES=true DE PROPÓSITO — o único lugar da suíte que ativa
    // o interruptor de emergência (a suíte principal roda com ele desligado,
    // igual produção hoje).
    srvN = spawnServidor({ PORT: String(PORT_N), DATA_DIR: DATA_N, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", BLOCK_NEW_PURCHASES: "true" }, (t) => (logN += t));
    const up = await esperarNoAr(() => reqN("GET", "/api/status"), 40_000);
    check("🚧 (drill compra bloqueada): servidor subiu com BLOCK_NEW_PURCHASES=true (interruptor de emergência ligado)", up === true);

    await reqN("POST", "/api/test/login", { token: TEST_TOKEN, email: "compradorbloq@test.com", name: "Comprador Bloqueado" });
    const st1 = await reqN("GET", "/api/status");
    check("🚧 /api/status devolve newPurchasesBlocked:true pra usuário comum com o interruptor ligado",
      st1.json?.newPurchasesBlocked === true, JSON.stringify(st1.json?.newPurchasesBlocked));

    const tent = await reqN("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Comprador Bloqueado", userWhatsapp: "11 99999", userCity: "SP" });
    check("🚧 POST /api/pedido é RECUSADO (403) pra usuário comum com o interruptor ligado — o bloqueio é de VERDADE no backend (bateu direto na API, sem passar pela tela), não só o botão escondido no front",
      tent.status === 403 && tent.json?.newPurchasesBlocked === true && typeof tent.json?.error === "string" && tent.json.error.length > 0,
      `status=${tent.status} body=${JSON.stringify(tent.json).slice(0, 220)}`);

    const listaVazia = await reqN("GET", "/api/pedidos");
    check("🚧 nenhum pedido foi criado pela tentativa bloqueada (a recusa acontece ANTES de qualquer gravação)",
      Array.isArray(listaVazia.json?.pedidos) && listaVazia.json.pedidos.length === 0,
      JSON.stringify(listaVazia.json).slice(0, 200));

    // Admin: o painel dele continua normal (newPurchasesBlocked:false) e o
    // fluxo "Regularizar" (pedido retroativo em nome de outro usuário)
    // segue funcionando de verdade — o interruptor nunca trava o admin.
    await reqN("POST", "/api/test/login", { token: TEST_TOKEN, email: "admbloq@test.com", name: "Admin Bloqueio", isAdmin: true });
    const stAdmin = await reqN("GET", "/api/status");
    check("🚧 /api/status NÃO marca newPurchasesBlocked pro admin (painel dele continua normal, sem banner nenhum)",
      stAdmin.json?.newPurchasesBlocked === false, JSON.stringify(stAdmin.json?.newPurchasesBlocked));

    const regular = await reqN("POST", "/api/pedido", { userEmail: "regularizado@test.com", plano: "vip", dias: 15, valorTotal: 77, userName: "Regularizado Retroativo", userWhatsapp: "11 99999", userCity: "SP" });
    check("🚧 admin CONTINUA conseguindo criar pedido retroativo (Regularizar) com o interruptor de emergência ligado — o bloqueio nunca trava o admin",
      regular.status === 200 && regular.json?.ok === true, `status=${regular.status} body=${JSON.stringify(regular.json).slice(0, 200)}`);
  } catch (e) {
    check("🚧 drill de bloqueio de compra nova sem exceção", false, e.message);
  } finally {
    try { await matarServidor(srvN, "SIGKILL"); } catch {}
    try { fs.rmSync(DATA_N, { recursive: true, force: true }); } catch {}
  }
}

// ── Execução ────────────────────────────────────────────────────────────
(async () => {
  console.log(`🧪 Smoke test — porta ${PORT}, dados em ${DATA}`);
  await testAuthWatchdogPush(); // unit puro, não precisa do servidor
  // 🚨 v172c-SEC: NUNCA testar com a senha de fábrica de produção (nem a antiga
  // vazada, nem a nova) — o teste define a SUA PRÓPRIA senha via env,
  // exatamente como uma instalação real deveria fazer (a env sempre vence o
  // hash de fábrica embutido no código).
  // 🚧 Sem BLOCK_NEW_PURCHASES — a suíte principal roda no estado real de
  // PRODUÇÃO hoje (interruptor de emergência desligado, compra normal). O
  // interruptor LIGADO tem drill isolado próprio (drillBloqueioComprasNovas,
  // servidor+env dele).
  const ENV_SRV = { PORT: String(PORT), DATA_DIR: DATA, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed`, DOL_API_BASE: `http://127.0.0.1:${FEED_PORT}/dol/`, H2A_BIM_MIN_PUBLICAR: "10", GOOGLE_FAKE_BASE: `http://127.0.0.1:${GOOGLE_PORT}`, ADMIN_PANEL_PASS_ANDRIO: "teste-smoke-andrio-2026", ADMIN_PANEL_PASS_DIEGO: "teste-smoke-diego-2026" };
  let log = "";
  let srv = spawnServidor(ENV_SRV, (t) => (log += t));

  try {
    check("servidor subiu e respondeu HTTP", await waitUp(40_000));

    // Rotas vitais
    const home = await get("/");
    check("GET / responde 200 com a página", home.status === 200 && home.body.length > 10_000,
      `status=${home.status} bytes=${home.body.length}`);

    // v85: guia "Como usar o app" — página servida pelo próprio site (acesso
    // do usuário pelo atalho da Home + menu). Guarda o acesso: se a rota
    // sumir ou o arquivo quebrar, o teste acusa antes do deploy.
    const guiaUso = await get("/como-usar");
    check("📖 GET /como-usar serve o guia de uso do app (200, com as fotos das telas)",
      guiaUso.status === 200 && /Como Usar o H2BApply/.test(guiaUso.body) && guiaUso.body.includes("data:image/jpeg;base64,"),
      `status=${guiaUso.status} bytes=${guiaUso.body.length}`);
    const guiaHome = home.body.includes("/como-usar");
    check("📖 index.html tem acesso ao guia (/como-usar) na Home/menu — usuário consegue chegar nele", guiaHome, "link /como-usar não encontrado no index.html");

    // v42: GUARDA ESTRUTURAL — nenhuma <div class="view" id="v-X"> pode ficar
    // aninhada dentro de outra. Bug real de produção (23/07/2026): faltou um
    // </div> no fechamento de #v-home, e TODAS as views seguintes (jobs,
    // plans, notificacoes, noticias, hist, ranking, respostas...) nasceram
    // como FILHAS de #v-home no DOM — escondidas junto toda vez que a Home
    // levava .gone (ou seja, sempre que qualquer outra aba estava ativa).
    // "Nenhuma aba funcionando" — reproduzido com Playwright, raiz corrigida.
    // Entre a tag de abertura de uma view (que conta como +1 nela mesma) e a
    // abertura da PRÓXIMA, o saldo de <div> abertas menos fechadas deve
    // voltar a ZERO — a própria view (e qualquer wrapper interno dela) tem
    // que fechar por completo antes da próxima começar. Saldo > 0 = sobrou
    // div aberta = a próxima view nasce aninhada (filha) da anterior.
    const viewTags = [...home.body.matchAll(/<div\b[^>]*\bid="v-([a-zA-Z]+)"/g)];
    let nestingBug = null;
    for (let i = 0; i < viewTags.length - 1; i++) {
      const seg = home.body.slice(viewTags[i].index, viewTags[i + 1].index);
      const bal = (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
      if (bal !== 0) { nestingBug = `#v-${viewTags[i][1]} não fechou direito (saldo ${bal}, esperado 0) — #v-${viewTags[i + 1][1]} nasceu aninhada dentro dela`; break; }
    }
    check("🏗️ nenhuma aba (view) nasce aninhada dentro de outra no HTML", nestingBug === null, nestingBug || "");
    const st = await get("/api/status");
    let stJson = null; try { stJson = JSON.parse(st.body); } catch {}
    check("GET /api/status sem sessão → JSON connected:false",
      st.status === 200 && stJson && stJson.connected === false, st.body.slice(0, 120));
    const hl = await get("/health");
    let hlJson = null; try { hlJson = JSON.parse(hl.body); } catch {}
    check("GET /health → ok (Render não recicla o container)",
      hl.status === 200 && hlJson && hlJson.ok === true, hl.body.slice(0, 120));
    const ps = await get("/api/public-stats");
    check("GET /api/public-stats responde 200 (landing pública)", ps.status === 200, `status=${ps.status}`);
    // 🎨 v243 (dono, 23/09/2026): "Envios Hoje"/"Automáticos" na vitrine da
    // Home zeravam de manhã cedo, bem do lado da venda do robô 24/7 — vira
    // last7Sent/last7Auto (janela de 7 dias, quase nunca zera). O rename é
    // TOTAL (nunca os dois nomes juntos) e a janela nunca pode contar mais
    // que o total histórico — invariante barato que pega dupla-contagem.
    check("🎨 v243: /api/public-stats devolve last7Sent/last7Auto (nunca mais todaySent/todayAuto) e a janela de 7 dias nunca excede o total histórico",
      typeof ps.json?.last7Sent === "number" && typeof ps.json?.last7Auto === "number" &&
      ps.json?.todaySent === undefined && ps.json?.todayAuto === undefined &&
      ps.json.last7Sent <= ps.json?.totalSent && ps.json.last7Auto <= ps.json?.totalAuto,
      JSON.stringify({ last7Sent: ps.json?.last7Sent, last7Auto: ps.json?.last7Auto, totalSent: ps.json?.totalSent, totalAuto: ps.json?.totalAuto }));
    // ⚡ v190 LOTE 8: esta rota varre TODOS os usuários e TODO o histórico de
    // todos, é pública (sem cookie nem rate-limit) e a landing chama a cada
    // 30s em CADA aba aberta — era a varredura completa do banco dezenas de
    // vezes por minuto, travando o event loop pra todo mundo. O contador
    // `_calculos` (só existe no npm test) prova que a 2ª chamada NÃO
    // recalculou nada e devolveu exatamente o mesmo objeto.
    const ps2 = await get("/api/public-stats");
    check("⚡ v190-L8: /api/public-stats tem cache de 60s no servidor — a 2ª chamada devolve o MESMO objeto sem varrer o histórico de novo (os números continuam reais, só podem estar até 60s velhos)",
      ps2.status === 200 && ps2.json?._calculos === ps.json?._calculos && typeof ps.json?._calculos === "number" &&
      ps2.json?.totalUsers === ps.json?.totalUsers && ps2.json?.totalSent === ps.json?.totalSent,
      JSON.stringify({ calc1: ps.json?._calculos, calc2: ps2.json?._calculos }));
    // 🐛 v238-FIX (achado do dono, 20/09/2026 — "VIP ativo: 1" na landing
    // sem nenhum cliente pago ainda, só o admin): isVipActive() dá VIP
    // infinito pro admin de propósito, mas /api/public-stats contava isso
    // como "1 VIP ativo" numa vitrine PÚBLICA. Neste ponto do npm test o
    // ÚNICO usuário genuinamente VIP-ativo é o fixture legadoplano@test.com
    // (vip.manualExpires/autoExpires no futuro, linha ~185) — os 5.000
    // fixtures "perfuser*" (v43-PERF) têm só um `plan:"vip"` solto, sem
    // vip.manualExpires/active, então isVipActive() já os ignora por conta
    // própria. Se o admin (isAdminVip) estivesse contando, o número seria
    // 2+, não 1 — é exatamente essa contagem extra que o fix elimina.
    check("🐛 v238-FIX: /api/public-stats NUNCA conta o admin como VIP ativo (só o fixture VIP de verdade — legadoplano@test.com — entra na vitrine pública)",
      ps.json?.vipUsers === 1, `vipUsers=${ps.json?.vipUsers}`);
    // 🌉 v238: no npm test a ponte pro site antigo (h2bapply.onrender.com)
    // fica DESLIGADA de propósito (TEST_LOGIN_TOKEN presente — nunca bate
    // rede de verdade no teste, mesma régua do Google/DOL falsos) — prova
    // que o servidor tenta e falha-aberto sem quebrar a rota nem travar.
    check("🌉 v238: /api/public-stats segue respondendo normal com a ponte pro site antigo desligada no teste (fail-open)",
      ps.status === 200 && typeof ps.json?.totalUsers === "number" && typeof ps.json?.totalSent === "number");
    const _srcV238 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("🌉 v238: a ponte pro site antigo nunca é chamada durante o npm test (TEST_LOGIN_TOKEN corta a rede real)",
      _srcV238.includes('if(process.env.TEST_LOGIN_TOKEN)return null; // nunca bate rede de verdade no npm test'));
    check("🌉 v238→v243: /api/public-stats NUNCA soma os últimos 7 dias com o site antigo (só total histórico) — last7Sent/last7Auto ficam de fora do merge",
      _srcV238.includes("last7Sent,last7Auto,\n      totalSent:totalSent+(legado?.totalSent||0)"));
    check("🌉 v238: a ponte com o site antigo só CONSOME (GET) — nenhuma escrita no New-repository congelado",
      (() => { const i = _srcV238.indexOf("_fetchStatsLegado"); const bloco = _srcV238.slice(i, i + 1200); return bloco.includes('method:"GET"') && !bloco.includes('method:"POST"'); })());
    // (aba Notícias DOL removida nesta reconstrução — sem /api/noticias)
    // (/api/auth/where removida no v172c junto com o login por e-mail/Google
    // — cadastro/login viraram usuário+senha, ver bloco 🔐 v172c abaixo.)
    // 🔐 v172c (ORDEM DO DONO, 12/09/2026): cadastro/login por usuário+senha,
    // ZERO Google na landing. E2E real: cria conta → usuário duplicado é
    // recusado → senha curta é recusada → username com @ é recusado → login
    // com senha certa entra → login com senha errada é recusado.
    // ═══ 📧 v175 (ordem do dono, 13/09/2026): cadastro COMPLETO e obrigatório,
    // 1 só WhatsApp, e-mail Gmail confirmado por código de 6 dígitos (5 min).
    // A conta de notificações é FALSA no teste: mod-notif grava no outbox em
    // vez de chamar o Google — o teste lê o outbox, pega o código, confirma e
    // só então o /api/cadastro aceita. Pipeline inteiro provado, sem rede.
    const OUTBOX = path.join(DATA, "notif_outbox.json");
    const lerOutbox = () => { try { return JSON.parse(fs.readFileSync(OUTBOX, "utf8")); } catch { return []; } };
    // v237q: o texto do e-mail encurtou (removeu as setas ▶ ◀ — texto curto
    // demais cai menos em spam) — o código agora vive sozinho na própria
    // linha, entre quebras de linha.
    const ultimoCodigo = (to, tipo) => { const m = lerOutbox().filter((x) => x.to === to && x.tipo === tipo).pop(); const c = m && String(m.text || "").match(/^(\d{6})$/m); return c ? c[1] : null; };
    const verificar = async (email) => { const r = await req2("POST", "/api/email/enviar-codigo", { email }); if (r.status !== 200) throw new Error("enviar-codigo " + r.status + " " + r.body.slice(0, 80)); const c = ultimoCodigo(email.toLowerCase(), "codigo_cadastro"); const k = await req2("POST", "/api/email/confirmar", { email, codigo: c }); return k.json?.token; };
    // 🔐 v176 (dono, 13/09/2026 — "quando o sistema identificar meu e-mail
    // que é de adm ele não pede verificação"): e-mail de admin pula reto pro
    // token, sem código nenhum — nem outbox, nem confirmar.
    const verificarAdmin = async (email) => { const r = await req2("POST", "/api/email/enviar-codigo", { email }); if (r.status !== 200 || r.json?.autoVerificado !== true) throw new Error("bootstrap admin falhou " + r.status + " " + r.body.slice(0, 120)); return r.json.token; };
    const cadastroCompleto = (o) => req2("POST", "/api/cadastro", { password: "12345678", nome: "Fulano", sobrenome: "Silva", dataNascimento: "01/01/1995", cidade: "Recife", estado: "PE", pais: "Brasil", whatsapp: "5581999999999", ...o });
    const _semConta = await req2("POST", "/api/email/enviar-codigo", { email: "fulano.v175@gmail.com" });
    check("📧 v175: sem conta de notificações conectada, pedir código dá 503 HONESTO (nunca finge que enviou)", _semConta.status === 503, `status=${_semConta.status} ${_semConta.body.slice(0, 80)}`);
    // 🔐 v176: o e-mail de ADMIN não pode ficar refém da conta de
    // notificações — mesmo com ela AINDA desconectada (linha acima prova o
    // 503 pra e-mail comum), o e-mail de admin já sai confirmado na hora.
    // É exatamente o cenário real do dono: precisava criar a própria conta
    // de usuário ANTES de conseguir conectar a conta de notificações.
    const _bootAdmin1 = await req2("POST", "/api/email/enviar-codigo", { email: "andrio.usa2026@gmail.com" });
    check("🔐 v176: e-mail de ADMIN confirma sem código mesmo com a conta de notificações desconectada (200 autoVerificado com token utilizável) — nunca trava o dono esperando conectar o Gmail de avisos",
      _bootAdmin1.status === 200 && _bootAdmin1.json?.autoVerificado === true && typeof _bootAdmin1.json?.token === "string" && _bootAdmin1.json.token.includes("."),
      JSON.stringify(_bootAdmin1.json));
    const _nc = await req2("POST", "/api/test/notif-conectar", { token: TEST_TOKEN, email: "suporteh2bapply@gmail.com" });
    check("📧 v175: (teste) conta de notificações conectada — suporteh2bapply@gmail.com (outbox no lugar do Google)", _nc.json?.ok === true && _nc.json?.status?.conectada === true && _nc.json?.status?.modoTeste === true, _nc.body.slice(0, 140));
    const _envNaoGmail = await req2("POST", "/api/email/enviar-codigo", { email: "fulano@hotmail.com" });
    check("📧 v175: e-mail que não é Gmail é recusado no cadastro (é por ele que o site envia as candidaturas)", _envNaoGmail.status === 400, `status=${_envNaoGmail.status}`);
    const _env1 = await req2("POST", "/api/email/enviar-codigo", { email: "Fulano.V175@gmail.com" });
    const _cod1 = ultimoCodigo("fulano.v175@gmail.com", "codigo_cadastro");
    const _mail1 = lerOutbox().find((x) => x.to === "fulano.v175@gmail.com");
    // v237q (URGENTE, ordem do dono, 20/09/2026): texto do e-mail encurtado
    // pra reduzir risco de cair em spam — o aviso "este e-mail vai ser o
    // mesmo que você vai conectar pra ENVIAR candidaturas" saiu do corpo do
    // e-mail (o cadastro já deixa isso claro na própria tela).
    check("📧 v175: Enviar verificação → e-mail com código de 6 dígitos sai pela conta de suporte (outbox), vale 5 min, reenvio em 60s, texto curto (anti-spam) com o código na própria linha",
      _env1.status === 200 && _env1.json?.expiraEm === 300 && _env1.json?.reenvioEm === 60 && /^\d{6}$/.test(_cod1 || "") && _mail1?.from === "suporteh2bapply@gmail.com" && /5 minutos/.test(_mail1?.text || "") && String(_mail1?.subject || "").includes(_cod1 || "x"),
      `status=${_env1.status} codigo=${_cod1} from=${_mail1?.from}`);
    check("🔐 v176: e-mail COMUM (não-admin) nunca pula o código — o bootstrap é só pra e-mail de admin, todo o resto continua exigindo o código de 6 dígitos", !_env1.json?.autoVerificado, JSON.stringify(_env1.json));
    const _env2 = await req2("POST", "/api/email/enviar-codigo", { email: "fulano.v175@gmail.com" });
    check("📧 v175: pedir outro código antes de 60s → 429 com a espera em segundos (anti-abuso da conta de suporte)", _env2.status === 429 && _env2.json?.segundos > 0, `status=${_env2.status}`);
    const _confErr = await req2("POST", "/api/email/confirmar", { email: "fulano.v175@gmail.com", codigo: "000000" });
    check("📧 v175: código errado → 400 dizendo quantas tentativas restam (5 no total, depois o código morre)", _confErr.status === 400 && /restante/.test(_confErr.json?.error || ""), _confErr.body.slice(0, 120));
    const _semToken = await cadastroCompleto({ username: "novo_user_v172c", email: "fulano.v175@gmail.com" });
    check("🔒 v175: cadastro SEM confirmar o e-mail (sem token) → 400 — impossível concluir sem verificar", _semToken.status === 400 && /Confirme seu e-mail/.test(_semToken.json?.error || ""), _semToken.body.slice(0, 120));
    const _confOk = await req2("POST", "/api/email/confirmar", { email: "fulano.v175@gmail.com", codigo: _cod1 });
    check("📧 v175: código certo → e-mail confirmado, devolve o token assinado de e-mail verificado", _confOk.status === 200 && typeof _confOk.json?.token === "string" && _confOk.json.token.includes("."), _confOk.body.slice(0, 100));
    const _tokenFulano = _confOk.json?.token;
    const _tokenOutro = await req2("POST", "/api/cadastro", { username: "novo_user_v172c", password: "12345678", nome: "Fulano", sobrenome: "Silva", dataNascimento: "01/01/1995", cidade: "Recife", estado: "PE", pais: "Brasil", whatsapp: "5581999999999", email: "outra.pessoa@gmail.com", emailToken: _tokenFulano });
    check("🔒 v175: token de um e-mail NÃO serve pra cadastrar outro e-mail (HMAC amarra e-mail + finalidade + validade)", _tokenOutro.status === 400, `status=${_tokenOutro.status}`);
    const _incompleto = await req2("POST", "/api/cadastro", { username: "novo_user_v172c", password: "12345678", nome: "Fulano", sobrenome: "Silva", email: "fulano.v175@gmail.com", emailToken: _tokenFulano });
    check("📝 v175: cadastro incompleto (sem nascimento/cidade/WhatsApp) → 400 — todos os campos são obrigatórios", _incompleto.status === 400, `status=${_incompleto.status} ${_incompleto.body.slice(0, 80)}`);
    const _nascRuim = await cadastroCompleto({ username: "novo_user_v172c", email: "fulano.v175@gmail.com", emailToken: _tokenFulano, dataNascimento: "31/02/1990" });
    check("📝 v175: data de nascimento que não existe (31/02) → 400", _nascRuim.status === 400 && /nascimento/.test(_nascRuim.json?.error || ""), _nascRuim.body.slice(0, 80));
    const _cadOk = await cadastroCompleto({ username: "novo_user_v172c", email: "fulano.v175@gmail.com", emailToken: _tokenFulano });
    check("🔐 v175: cadastro COMPLETO com e-mail confirmado cria a conta e já devolve sessão logada",
      _cadOk.status === 200 && _cadOk.json?.ok === true && _cadOk.json?.username === "novo_user_v172c" && _cadOk.json?.novaConta === true, JSON.stringify(_cadOk.json));
    const _novoUser = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))["novo_user_v172c"];
    check("🔐 v172c: usuário novo nasce com senha em HASH (scrypt) — nunca texto puro no banco",
      !!_novoUser?.passwordSalt && !!_novoUser?.passwordHash && _novoUser.passwordHash !== "12345",
      JSON.stringify({ temSalt: !!_novoUser?.passwordSalt, temHash: !!_novoUser?.passwordHash }));
    check("📧 v175: a conta guarda o e-mail confirmado (emailContato + carimbo), o WhatsApp único vira telefone também e o nascimento fica em ISO",
      _novoUser?.emailContato === "fulano.v175@gmail.com" && _novoUser?.emailVerificadoEm > 0 && _novoUser?.whatsapp === "5581999999999" && _novoUser?.phone === "5581999999999" && _novoUser?.dataNascimento === "1995-01-01" && _novoUser?.city === "Recife",
      JSON.stringify({ e: _novoUser?.emailContato, w: _novoUser?.whatsapp, n: _novoUser?.dataNascimento }));
    const _st1 = (await get("/api/status")).json;
    check("📧 v175: /api/status expõe emailContato/emailVerificado (o aviso 'entre com este e-mail' do Gmail usa isso)", _st1?.emailContato === "fulano.v175@gmail.com" && _st1?.emailVerificado === true, JSON.stringify({ e: _st1?.emailContato, v: _st1?.emailVerificado }));
    const _envDup = await req2("POST", "/api/email/enviar-codigo", { email: "fulano.v175@gmail.com" });
    check("📧 v175: e-mail que JÁ tem conta não recebe código de cadastro (409 — manda entrar ou recuperar a senha)", _envDup.status === 409, `status=${_envDup.status}`);
    const _cadDup = await cadastroCompleto({ username: "novo_user_v172c", email: "outro.v175@gmail.com", emailToken: await verificar("outro.v175@gmail.com") });
    check("🔐 v172c: cadastro com username JÁ EXISTENTE → 409 (nunca sobrescreve a conta)", _cadDup.status === 409, `status=${_cadDup.status}`);
    // 🔑 usernames reservados (andrio/diego/andrew) — v175: só nascem admin com
    // o e-mail CONFIRMADO sendo um e-mail de admin (fecha a janela "quem
    // cadastrar primeiro leva o admin" apontada na auditoria de 13/09).
    const _cadReservadoSemAdm = await cadastroCompleto({ username: "andrio", email: "reservado.v175@gmail.com", emailToken: await verificar("reservado.v175@gmail.com") });
    check("🔑 v175: username reservado 'andrio' com e-mail que NÃO é de admin → 400 (nunca vira admin por chegar primeiro)", _cadReservadoSemAdm.status === 400 && /reservado/i.test(_cadReservadoSemAdm.json?.error || ""), _cadReservadoSemAdm.body.slice(0, 100));
    // 🔐 v176: e-mail de admin nasce confirmado pelo bootstrap (verificarAdmin),
    // sem passar pelo outbox — igual o dono faz de verdade na landing.
    const _cadAndrio = await cadastroCompleto({ username: "andrio", email: "andrio.usa2026@gmail.com", emailToken: await verificarAdmin("andrio.usa2026@gmail.com") });
    check("🔑 v172f/v175: 'andrio' com o e-mail de admin confirmado nasce admin NA HORA (sem esperar boot/restart)",
      _cadAndrio.status === 200 && _cadAndrio.json?.ok === true && JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))["andrio"]?.isAdmin === true, JSON.stringify(_cadAndrio.json));
    const _bootAdminFechado = await req2("POST", "/api/email/enviar-codigo", { email: "andrio.usa2026@gmail.com" });
    check("🔐 v176: depois que a conta desse e-mail de admin JÁ EXISTE, o bootstrap fecha PRA SEMPRE — enviar-codigo volta a dar 409 igual qualquer e-mail já cadastrado (nunca mais pula verificação pra ele)",
      _bootAdminFechado.status === 409, `status=${_bootAdminFechado.status} ${_bootAdminFechado.body.slice(0, 100)}`);
    const _cadDiego = await cadastroCompleto({ username: "diego", nome: "Diego", email: "jesuscristh22@gmail.com", emailToken: await verificarAdmin("jesuscristh22@gmail.com") });
    check("🔑 v172f/v175: 'diego' com o e-mail de admin confirmado nasce admin NA HORA",
      _cadDiego.status === 200 && JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))["diego"]?.isAdmin === true, JSON.stringify(_cadDiego.json));
    const _cadAndrew = await cadastroCompleto({ username: "andrew", nome: "Andrew", email: "ueudesmaresias@gmail.com", emailToken: await verificarAdmin("ueudesmaresias@gmail.com") });
    check("🔑 v172f/v175: 'andrew' (3º username reservado, mesma fonte única ADMIN_RESERVED_USERNAMES) nasce admin com e-mail de admin",
      _cadAndrew.status === 200 && JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))["andrew"]?.isAdmin === true, JSON.stringify(_cadAndrew.json));
    const _cadNormal = await cadastroCompleto({ username: "usuario_qualquer_v172f", email: "comum.v175@gmail.com", emailToken: await verificar("comum.v175@gmail.com") });
    check("🔑 v172f-FIX: username NÃO reservado continua nascendo sem admin (não virou padrão pra todo mundo)",
      _cadNormal.status === 200 && JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))["usuario_qualquer_v172f"]?.isAdmin === false, JSON.stringify(_cadNormal.json));
    COOKIE = "";
    const _cadCurta = await cadastroCompleto({ username: "outro_user_v172c", password: "12", email: "x.v175@gmail.com" });
    check("🔐 v172c: cadastro com senha curta (<8) → 400", _cadCurta.status === 400, `status=${_cadCurta.status}`);
    const _cadArroba = await cadastroCompleto({ username: "tem@arroba", email: "x.v175@gmail.com" });
    check("🔐 v172c: cadastro com @ no username → 400 (impossível colidir com e-mail de admin)", _cadArroba.status === 400, `status=${_cadArroba.status}`);
    COOKIE = "";
    const _logOk = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "12345678" });
    check("🔐 v172c: POST /api/login com usuário+senha certos → 200 e sessão nova",
      _logOk.status === 200 && _logOk.json?.ok === true, JSON.stringify(_logOk.json));
    COOKIE = "";
    const _logBad = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "senhaerrada" });
    check("🔐 v172c: POST /api/login com senha ERRADA → 403 (nunca entra)",
      _logBad.status === 403, `status=${_logBad.status}`);
    COOKIE = "";
    const _logEmail = await req2("POST", "/api/login", { username: "Fulano.V175@gmail.com", password: "12345678" });
    check("🔐 v175: entrar com o E-MAIL cadastrado no lugar do usuário também funciona (a identidade continua sendo o username)", _logEmail.status === 200 && _logEmail.json?.username === "novo_user_v172c", _logEmail.body.slice(0, 100));
    // 🔑 v175: recuperação de senha pelo e-mail cadastrado
    COOKIE = "";
    const _recNo = await req2("POST", "/api/senha/enviar-codigo", { email: "ninguem.v175@gmail.com" });
    const _recOk = await req2("POST", "/api/senha/enviar-codigo", { email: "fulano.v175@gmail.com" });
    const _codRec = ultimoCodigo("fulano.v175@gmail.com", "codigo_senha");
    check("🔑 v175: recuperação — resposta GENÉRICA igual pra e-mail sem conta e com conta (sem enumeração); o código de senha só sai pra quem tem conta",
      _recNo.status === 200 && _recOk.status === 200 && _recNo.body === _recOk.body && /^\d{6}$/.test(_codRec || "") && !lerOutbox().some((x) => x.to === "ninguem.v175@gmail.com"),
      `no=${_recNo.status} ok=${_recOk.status} cod=${_codRec}`);
    // 🚨 v237m (achado de auditoria — Média, auth): a anti-enumeração de cima
    // provava só o caso feliz (conta existe × não existe, 1 pedido cada).
    // O vazamento real era noutro lugar: pedir um 2º código pro MESMO e-mail
    // dentro de 60s (REENVIO_MS) SÓ dava 429 "aguarde" pra quem TEM conta —
    // pra quem não tem, a rota nunca chega no rate-limit por e-mail (cai
    // direto no `else`, sempre 200). Um status diferente aqui já entregava
    // se o e-mail tem conta, sem precisar medir tempo nenhum.
    //
    // 🚨🚨 v237q (URGENTE, ordem do dono, 20/09/2026 — usuário real sem
    // receber código): o v237m (fire-and-forget, sem cooldown NENHUM
    // aparecendo na resposta) resolveu a enumeração mas criou um bug pior —
    // reenviar rápido demais (usuário ansioso clicando de novo) SEMPRE via
    // "o código foi enviado", mesmo quando NADA foi gerado/mandado de
    // verdade, deixando a pessoa esperando um e-mail que nunca chega, sem
    // nenhum aviso pra esperar. Agora existe um cooldown UNIFORME (por
    // e-mail DIGITADO, nunca por conta — roda ANTES de checar se existe
    // conta, então é idêntico com ou sem conta real) que avisa "já pedi,
    // espera" de verdade, sem reabrir a enumeração: os 2 e-mails (com conta
    // e sem conta) batem no MESMO cooldown com a MESMA resposta.
    const _recDup = await req2("POST", "/api/senha/enviar-codigo", { email: "fulano.v175@gmail.com" });
    const _recDupNo = await req2("POST", "/api/senha/enviar-codigo", { email: "ninguem.v175@gmail.com" });
    check("🚨 v237q: pedir um 2º código pro MESMO e-mail dentro de 60s AVISA que precisa esperar (cooldown:true) em vez de fingir sucesso mudo — nenhum código novo é gerado — e a resposta é IDÊNTICA pra e-mail com conta e sem conta (sem reabrir a enumeração que o v237m fechou)",
      _recDup.status === 200 && _recDup.json?.cooldown === true &&
      _recDupNo.status === 200 && _recDupNo.json?.cooldown === true &&
      _recDup.body === _recDupNo.body &&
      ultimoCodigo("fulano.v175@gmail.com", "codigo_senha") === _codRec,
      `dup=${JSON.stringify({ status: _recDup.status, cd: _recDup.json?.cooldown })} dupNo=${JSON.stringify({ status: _recDupNo.status, cd: _recDupNo.json?.cooldown })} corpoIgual=${_recDup.body === _recDupNo.body} codigoMudou=${ultimoCodigo("fulano.v175@gmail.com", "codigo_senha") !== _codRec}`);
    const _redefBad = await req2("POST", "/api/senha/redefinir", { email: "fulano.v175@gmail.com", codigo: "111111", novaSenha: "novasenha123" });
    const _redefCurta = await req2("POST", "/api/senha/redefinir", { email: "fulano.v175@gmail.com", codigo: _codRec, novaSenha: "123" });
    const _redefOk = await req2("POST", "/api/senha/redefinir", { email: "fulano.v175@gmail.com", codigo: _codRec, novaSenha: "novasenha123" });
    COOKIE = "";
    const _logVelha = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "12345678" });
    COOKIE = "";
    const _logNova = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "novasenha123" });
    check("🔑 v175: código errado/senha curta não redefinem; código certo redefine, a senha velha morre e a nova entra",
      _redefBad.status === 400 && _redefCurta.status === 400 && _redefOk.status === 200 && _logVelha.status === 403 && _logNova.status === 200,
      JSON.stringify({ bad: _redefBad.status, curta: _redefCurta.status, ok: _redefOk.status, velha: _logVelha.status, nova: _logNova.status }));
    // ═══ 🚨 v237h (achado de auditoria — Alta, 3ª rodada, área auth): "relogar
    // com o MESMO e-mail restaura tudo automaticamente" era só promessa —
    // NENHUM caminho de login limpava accountDeleted. Como a senha nunca é
    // apagada (soft-delete), o login continuava funcionando normal, mas
    // scheduleAuto() (server.js) via accountDeleted:true em TODO ciclo e
    // desligava o automático pra sempre em silêncio — o app.js nunca trata
    // esse status, então o recurso pago mais importante do site ficava
    // quebrado sem chance de autoatendimento pra quem excluiu e voltou.
    // Reusa a sessão de "novo_user_v172c" (login OK 2 linhas acima). O
    // estado real é lido via /api/admin/live (em memória, live) — não do
    // users.json em disco, que só grava accountDeleted debounced (5s, não é
    // campo crítico) e daria falso-negativo lendo logo após a resposta.
    const _delAcc = await req2("POST", "/api/account/delete", { confirm: true });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const _liveAposDelete = await req2("GET", "/api/admin/live");
    const _uLiveAposDelete = _liveAposDelete.json?.users?.find(u => u.email === "novo_user_v172c");
    check("🚨 v237h: /api/account/delete marca accountDeleted:true (soft-delete — a senha continua intacta)",
      _delAcc.status === 200 && _delAcc.json?.ok === true && _uLiveAposDelete?.accountDeleted === true,
      JSON.stringify({ del: _delAcc.status, accountDeleted: _uLiveAposDelete?.accountDeleted }));
    COOKIE = "";
    const _logDepoisDelete = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "novasenha123" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const _liveAposRelogin = await req2("GET", "/api/admin/live");
    const _uLiveAposRelogin = _liveAposRelogin.json?.users?.find(u => u.email === "novo_user_v172c");
    check("🚨 v237h: relogar com a MESMA senha depois de excluir a conta FUNCIONA (200) e LIMPA accountDeleted de verdade — nunca mais o automático fica quebrado em silêncio pra quem voltou",
      _logDepoisDelete.status === 200 && _logDepoisDelete.json?.ok === true && _uLiveAposRelogin?.accountDeleted === false,
      JSON.stringify({ login: _logDepoisDelete.status, accountDeleted: _uLiveAposRelogin?.accountDeleted }));
    // ═══ 🚨 v237i (achado de auditoria — Alta, 3ª rodada, área gmail-envio):
    // 3 dos 4 watchdogs de recuperação do automático (orphan_recovery, o
    // guard de status "sending" preso e o daily-reset guardian) iteravam
    // Object.entries(DB_AUTO) SEM try/catch por iteração — diferente do
    // loop de diagnoseJob() (já protegido). 1 job com formato que fizesse
    // scheduleAuto/getHealth/addLog lançar exceção síncrona interrompia o
    // for-loop NAQUELE ponto — nenhum usuário DEPOIS do registro corrompido
    // era verificado/recuperado nesse ciclo, e como a ordem de
    // Object.entries é estável, o MESMO usuário quebrava o loop em TODO
    // ciclo seguinte, pra sempre — transformando a própria rede de
    // segurança num ponto único de falha capaz de travar a recuperação
    // automática de TODOS os usuários do site.
    {
      const _srvV237i = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _wdStart = _srvV237i.indexOf("// Watchdog global: roda a cada 2min");
      const _wdEnd = _srvV237i.indexOf("// Heartbeat: atualiza lastSent quando auto envia com sucesso");
      const _wdRegion = (_wdStart >= 0 && _wdEnd > _wdStart) ? _srvV237i.slice(_wdStart, _wdEnd) : "";
      check("🚨 v237i (estrutural): os 3 watchdogs (orphan_recovery, stuck-guard, daily-reset) ganham try/catch por iteração — 1 job corrompido nunca mais trava a recuperação dos outros usuários no mesmo ciclo",
        /catch\(e\) \{ console\.error\(`\[watchdog:orphan_recovery\] erro em \$\{email\}:`, e\.message\); \}/.test(_wdRegion) &&
        /catch\(e\) \{ console\.error\(`\[stuck-guard\] erro em \$\{email\}:`, e\.message\); \}/.test(_wdRegion) &&
        /catch\(e\) \{ console\.error\(`\[daily-reset\] erro em \$\{email\}:`, e\.message\); \}/.test(_wdRegion),
        `região dos watchdogs sem os 3 try/catch — ${_wdRegion.length} chars capturados`);
    }
    // 📧 v175: aba Notificações do admin (status/teste/config/desconectar)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const _ntSt = await get("/api/admin/notificacoes/status");
    check("📧 v175: admin vê o status da conta de notificações numa chamada (conectada, e-mail, enviados hoje, destinatários dos avisos = só os 2 sócios: dono + Diego)",
      // v176: sentToday caiu (era >=8) porque 3 desses cadastros (andrio/
      // diego/andrew) agora são bootstrap de admin — nunca passam pela
      // conta de notificações, então nunca contam aqui (ver checks 🔐 v176).
      _ntSt.json?.ok === true && _ntSt.json.conectada === true && _ntSt.json.email === "suporteh2bapply@gmail.com" && _ntSt.json.sentToday >= 5 && Array.isArray(_ntSt.json.destinatarios) && _ntSt.json.destinatarios.length === 2 && _ntSt.json.destinatarios.includes("andrio.usa2026@gmail.com") && _ntSt.json.destinatarios.includes("jesuscristh22@gmail.com") && typeof _ntSt.json.oauthConfigurado === "boolean",
      _ntSt.body.slice(0, 200));
    const _ntTeste = await req2("POST", "/api/admin/notificacoes/teste", { to: "smoke@test.com" });
    check("📧 v175: 'Enviar e-mail de teste pra mim' sai pela conta conectada (outbox tipo teste)", _ntTeste.json?.ok === true && lerOutbox().some((x) => x.tipo === "teste" && x.to === "smoke@test.com"), _ntTeste.body.slice(0, 100));
    const _ntOff = await req2("POST", "/api/admin/notificacoes/config", { avisoPedidos: false });
    const _ntOn = await req2("POST", "/api/admin/notificacoes/config", { avisoPedidos: true });
    check("📧 v175: toggle 'avisar pedido novo por e-mail' liga/desliga e persiste", _ntOff.json?.avisoPedidos === false && _ntOn.json?.avisoPedidos === true, `off=${_ntOff.body.slice(0, 60)} on=${_ntOn.body.slice(0, 60)}`);
    const _ntDesc = await req2("POST", "/api/admin/notificacoes/desconectar", {});
    const _ntSt2 = await get("/api/admin/notificacoes/status");
    const _envSem = await req2("POST", "/api/email/enviar-codigo", { email: "depois.v175@gmail.com" });
    check("📧 v175: desconectar → status conectada:false e o cadastro volta a avisar 503 (nunca finge que mandou código)", _ntDesc.json?.ok === true && _ntSt2.json?.conectada === false && _envSem.status === 503, `st=${_ntSt2.json?.conectada} env=${_envSem.status}`);
    await req2("POST", "/api/test/notif-conectar", { token: TEST_TOKEN, email: "suporteh2bapply@gmail.com" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const _nt403 = await get("/api/admin/notificacoes/status");
    check("🔒 v175: usuário comum recebe 403 nas rotas de notificação (admin-only)", _nt403.status === 403, `status=${_nt403.status}`);
    COOKIE = "";
    // 🧱 estrutural: front + servidor do v175
    {
      const _idx = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _adm = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      const _srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🧱 v175: (estrutural) cadastro com verificação por código no front (agEnviarCodigo/agConfirmarCodigo, 1 só WhatsApp, sem campo telefone), 'Esqueci minha senha', janela pós-cadastro no lugar do wizard antigo, aviso do e-mail cadastrado no modal do Gmail, editor 3+3 e aba Notificações no admin",
        _app.includes("function agEnviarCodigo(") && _app.includes("function agConfirmarCodigo(") && _app.includes("function agRecRedefinir(") && !_app.includes('id="ag-s-tel"') && _app.includes("function checkShowCvPrompt(") && !_app.includes("function showOnboarding(") && !_app.includes("function obSavePersonal(") &&
        _idx.includes('id="cv-prompt-overlay"') && !_idx.includes('id="onboarding-overlay"') && _idx.includes('id="gwm-email-block"') && _idx.includes("③ Título do e-mail (assunto)") && _idx.includes("NÃO é obrigatória") && !_idx.includes('id="pe-subjects-empty"') &&
        _app.includes("function _pePad(") && _adm.includes('data-view="notificacoes"') && _adm.includes("/oauth/notif-connect") && _srv.includes('sessions["__notif__"+_st]') && _srv.includes("login_hint") && _srv.includes("_hintCS=p.emailContato||resolveSendGmail(p)"),
        "estrutura do v175 incompleta");
      // 🔐 v176: bootstrap de e-mail admin — presente no servidor (isAdminEmail
      // ANTES do NOTIF.conectada(), token via NOTIF.tokenVerificado, log +
      // auditoria em GLOBAL_EVENTS) e no front (agEnviarCodigo trata autoVerificado
      // sem pedir código, com aviso visível — nunca esconder que foi automático).
      const _srvIsAdminAntesDoNotif = _srv.indexOf("if(isAdminEmail(email)){") > 0 && _srv.indexOf("if(isAdminEmail(email)){") < _srv.indexOf('if(!NOTIF.conectada())return json(res,503,{error:"A verificação por e-mail');
      check("🧱 v176: (estrutural) bootstrap do e-mail de admin — checagem vem ANTES do gate de conta de notificações desconectada, usa NOTIF.tokenVerificado (mesmo HMAC de sempre) e é auditado; o front mostra aviso explícito de confirmação automática",
        _srvIsAdminAntesDoNotif && _srv.includes('NOTIF.tokenVerificado("cadastro",email)') && _srv.includes('pushGlobalEvent("admin_bootstrap_email"') &&
        _app.includes("d.autoVerificado") && _app.includes('method:"admin_auto"') && _app.includes("E-mail de administrador reconhecido"),
        "estrutura do v176 incompleta");
    }
    COOKIE = "";

    // 🔐 v172c: /api/admin/set-password é a válvula de escape pra conta
    // ANTIGA (criada por Google, sem senha nenhuma — simulada aqui via
    // /api/test/login, que nasce sem passwordSalt/passwordHash igual uma
    // conta Google real) — sem isso ela ficaria trancada pra sempre.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legado_sem_senha@test.com", name: "Legado Sem Senha" });
    COOKIE = "";
    const _logLegadoAntes = await req2("POST", "/api/login", { username: "legado_sem_senha@test.com", password: "qualquer" });
    check("🔐 v172c: conta ANTIGA (Google, sem senha) não consegue logar por senha antes do admin destrancar",
      _logLegadoAntes.status === 403, `status=${_logLegadoAntes.status}`);
    check("🆘 v172c-UX: conta ANTIGA recebe mensagem ESPECÍFICA (chamar o suporte), não o genérico 'usuário ou senha inválidos' que confundiria quem nunca teve senha nenhuma",
      /suporte/i.test(_logLegadoAntes.json?.error || "") && !/usuário ou senha inválidos/i.test(_logLegadoAntes.json?.error || ""),
      _logLegadoAntes.json?.error);
    check("🚨 v177-FIX2: a mesma mensagem cita 'Esqueci minha senha' como caminho mais rápido — /api/senha/enviar-codigo já destrava essa conta sozinha, sem precisar do WhatsApp",
      /esqueci minha senha/i.test(_logLegadoAntes.json?.error || ""), _logLegadoAntes.json?.error);
    const _spNoAuth = await req2("POST", "/api/admin/set-password", { email: "legado_sem_senha@test.com", novaSenha: "novaSenha1" });
    check("🔐 v172c: /api/admin/set-password SEM sessão → 401",
      _spNoAuth.status === 401, `status=${_spNoAuth.status}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "naopode@test.com" });
    const _spNaoAdmin = await req2("POST", "/api/admin/set-password", { email: "legado_sem_senha@test.com", novaSenha: "novaSenha1" });
    check("🔐 v172c: /api/admin/set-password com usuário COMUM logado (não-admin) → 403",
      _spNaoAdmin.status === 403, `status=${_spNaoAdmin.status}`);
    COOKIE = "";
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _spOk = await req2("POST", "/api/admin/set-password", { email: "legado_sem_senha@test.com", novaSenha: "novaSenha1" });
    check("🔐 v172c: /api/admin/set-password com sessão ADMIN → 200 (destrava a conta antiga)",
      _spOk.status === 200 && _spOk.json?.ok === true, JSON.stringify(_spOk.json));
    const _sp404 = await req2("POST", "/api/admin/set-password", { email: "ninguem_aqui@test.com", novaSenha: "novaSenha1" });
    check("🔐 v172c: /api/admin/set-password pra e-mail inexistente → 404",
      _sp404.status === 404, `status=${_sp404.status}`);
    COOKIE = "";
    const _logLegadoDepois = await req2("POST", "/api/login", { username: "legado_sem_senha@test.com", password: "novaSenha1" });
    check("🔐 v172c: conta ANTIGA loga normalmente DEPOIS que o admin carimbou a senha nova (destrancada de vez)",
      _logLegadoDepois.status === 200 && _logLegadoDepois.json?.ok === true, JSON.stringify(_logLegadoDepois.json));
    COOKIE = "";

    // 🔎 v172d (auditoria independente, 12/09/2026): a troca do login pra
    // usuário+senha (v172c) deixou texto/cópia velha na landing e um bug
    // real de default no intervalo do admin — achados por uma verificação
    // adversarial e corrigidos aqui, com guarda pra nunca voltar.
    const _idxSrc172d = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const _appSrc172d = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    const _srvSrc172d = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("🌐 v172d: landing/modal/onboarding sem NENHUM resquício de 'login por Google' (nem 'sem senha')",
      !_idxSrc172d.includes("Entre com Google") && !_idxSrc172d.includes("a entrada é sempre pela sua conta Google") &&
      !_idxSrc172d.includes("Sem senha") && !_idxSrc172d.includes("E-mail (conta Google)"),
      "sobrou texto de login por Google na landing/modal/onboarding do index.html");
    check("🌐 v172d: aviso obrigatório do Gmail-pra-enviar NUNCA pula o consentimento — se #gwm sumir do HTML, recarrega em vez de ir direto pro Google",
      /if\(!m\)\{[^}]*location\.reload/.test(_appSrc172d) && !/if\(!m\)\{location\.href="\/oauth\/connect-send/.test(_appSrc172d),
      "fallback de showGmailConnectWarnModal ainda pula direto pro Google sem consentimento");
    check("🎯 v172d: padrão do intervalo do admin é 5min (300s) em TODOS os lugares — nunca mais o 180s/420s de antes da v172b",
      _srvSrc172d.includes('intervalSecs)||300)') && _srvSrc172d.includes("isAdminVip(p)?(p.adminSettings?.intervalSecs||300):420") &&
      !_srvSrc172d.includes("intervalSecs||180") && !_srvSrc172d.includes("intervalSecs)||180") &&
      !_appSrc172d.includes("intervalSecs||180") && !_appSrc172d.includes("intervalSecs)||180") && !_appSrc172d.includes('||180):180'),
      "sobrou default de 180s/420s do intervalo do admin em server.js/app.js");
    const _srvSrc156 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("🌐 (estrutural) nenhum resquício de arquitetura multi-servidor no server.js (SERVER_ID/_getServersConfig/_resolveServerId/checkAccountOnPeers/financeiro-global)",
      !/\bSERVER_ID\b/.test(_srvSrc156) && !_srvSrc156.includes("_getServersConfig") && !_srvSrc156.includes("_resolveServerId") &&
      !/async function checkAccountOnPeers/.test(_srvSrc156) && !_srvSrc156.includes("financeiro-global"),
      "sobrou trava/redirect multi-servidor no server.js");

    // (migração de notícias inválidas, baseline do vigia, página pública
    // /noticias e sua entrada no sitemap — tudo aba Notícias, removida)
    // v56: verificação Google — a Política de Privacidade precisa existir e
    // conter a declaração canônica de Limited Use em inglês (o revisor procura
    // exatamente por ela). Servidor completo também menciona ler respostas.
    const priv = await get("/privacidade");
    check("🔏 /privacidade existe com a declaração Limited Use (exigência da verificação Google)",
      priv.status === 200 && priv.body.includes("Limited Use requirements") && priv.body.includes("gmail.send"),
      `status=${priv.status}`);

    // 🧪 AUDITORIA 10/09/2026 (LGPD art. 18, V — portabilidade): o usuário
    // baixa os próprios dados sem precisar pedir a ninguém.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "exportmeudados@test.com", name: "Export Teste" });
    await req2("POST", "/api/settings", { phone: "11988887777", city: "São Paulo" });
    const expCvB64 = Buffer.from("%PDF-1.4 " + "export ".repeat(300)).toString("base64");
    const expCv = await req2("POST", "/api/cv/upload", { base64: expCvB64, name: "Curriculo_Export.pdf", cvType: "resume" });
    await req2("POST", "/api/profiles/save", { name: "Perfil Export Teste", visaType: "h2b", subjects: ["assunto export 1", "assunto export 2", "assunto export 3"], emailBodies: ["corpo export 1", "corpo export 2", "corpo export 3"], resumeIdx: expCv.json?.cv?.idx });
    const exp = await get("/api/account/export");
    let expJson = null; try { expJson = JSON.parse(exp.body); } catch {}
    check("🔒 export LGPD: GET /api/account/export exige login (401 sem sessão)",
      (await (async () => { const savedCookie = COOKIE; COOKIE = ""; const r = await get("/api/account/export"); COOKIE = savedCookie; return r; })()).status === 401,
      "sem sessão deveria dar 401");
    check("📦 export LGPD: baixa os PRÓPRIOS dados (conta+perfil+h2bProfile) como anexo baixável, nunca token/senha",
      exp.status === 200 &&
      (exp.headers["content-disposition"] || "").includes("attachment") &&
      (exp.headers["content-disposition"] || "").includes(".json") &&
      expJson?.conta?.email === "exportmeudados@test.com" && expJson?.conta?.telefone === "11988887777" &&
      Array.isArray(expJson?.perfisDeVaga) && expJson.perfisDeVaga.some((pr) => pr.nome === "Perfil Export Teste") &&
      !JSON.stringify(expJson).includes("refresh_token") && !("senha" in (expJson?.conta || {})),
      JSON.stringify({ status: exp.status, cd: exp.headers["content-disposition"], email: expJson?.conta?.email }).slice(0, 200));

    // 🧪 AUDITORIA 10/09/2026: POST /api/account/delete NUNCA tinha teste
    // nenhum (rota real que descarta sessão + revoga token + soft-delete).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "deletemeconta@test.com", name: "Delete Teste" });
    const delSemConfirm = await req2("POST", "/api/account/delete", {});
    check("🗑️ account/delete: sem confirm:true explícito leva 400 (nunca deleta por engano)",
      delSemConfirm.status === 400, "status=" + delSemConfirm.status);
    const delOk = await req2("POST", "/api/account/delete", { confirm: true });
    check("🗑️ account/delete: com confirm:true deleta (soft — accountDeleted:true) e derruba a sessão (cookie limpo)",
      delOk.status === 200 && delOk.json?.ok === true && !!(delOk.headers["set-cookie"] || [])[0]?.includes("h2b_session=;"),
      JSON.stringify({ status: delOk.status, sc: delOk.headers["set-cookie"] }).slice(0, 160));
    const statusPosDelete = await get("/api/status");
    check("🗑️ account/delete: /api/status pós-exclusão mostra deslogado de verdade (sessão realmente destruída, não só marcada)",
      statusPosDelete.json?.connected === false, JSON.stringify(statusPosDelete.json).slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const liveAfterDel = await get("/api/admin/live");
    const delUserRow = (liveAfterDel.json?.users || []).find((u) => u.email === "deletemeconta@test.com");
    check("🗑️ account/delete: SOFT-DELETE de verdade — o admin ainda enxerga a conta marcada (nada foi apagado)",
      !!delUserRow && delUserRow.accountDeleted === true,
      JSON.stringify(delUserRow).slice(0, 160));
    COOKIE = ""; // este bloco termina logado como admin — limpa pra não vazar sessão pros testes seguintes que assumem "sem sessão"

    // v40: fonte de ícones é BUILT-IN — nunca mais some por CDN bloqueada
    const appJs = await get("/app.js");
    check("⚡ v116: /app.js servido (JS do index extraído — carregamento rápido)", appJs.status===200 && appJs.body.length>100_000, "status="+appJs.status);
    const frontAll = home.body + appJs.body;
    const tcss = await get("/vendor/tabler-icons.min.css");
    check("🎨 fonte de ícones servida pelo próprio site (CSS)",
      tcss.status === 200 && tcss.body.includes("tabler-icons"), `status=${tcss.status}`);
    const tfont = await get("/vendor/fonts/tabler-icons.woff2");
    check("🎨 arquivo woff2 dos ícones servido localmente",
      tfont.status === 200 && tfont.body.length > 100_000, `status=${tfont.status} bytes=${tfont.body.length}`);
    check("🎨 index.html aponta pra fonte local (não mais CDN)",
      home.body.includes("/vendor/tabler-icons.min.css"));

    // 🇧🇷 v199 LOTE 17 — PORTUGUÊS FIXO DE VERDADE (a asserção antiga codificava
    // o comportamento que morreu aqui). Até o v198 esta guarda exigia o padrão
    // "localStorage h2b_lang → fallback 'pt'": ela protegia contra a detecção
    // por navigator.language (v86) mas ABENÇOAVA o resíduo que era o bug — o
    // idioma ainda podia virar 'en'/'es' pelo aparelho (valor gravado a partir
    // do d.language do servidor) e NENHUMA tela do site tem botão pra voltar.
    // Agora `_curLang` é uma constante: um valor só, atribuído uma vez.
    // (mede o que EXECUTA, nunca o comentário que explica a remoção — mesma
    // disciplina das guardas por frase do v189 LOTE 7.)
    const _semComL17 = (t2) => t2.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/<!--[\s\S]*?-->/g, " ");
    const _frontL17 = _semComL17(frontAll);
    const _langUmaAtribuicao = (_frontL17.match(/_curLang\s*=[^=]/g) || []).length === 1;
    const _langInitOk = _frontL17.includes("const _curLang = 'pt';") && _langUmaAtribuicao &&
      !_frontL17.includes("navigator.language") && !_frontL17.includes("h2b_lang") &&
      !/lang-label|lang-flag|lang-opt/.test(_frontL17) &&
      !/JSON\.stringify\(\{language:/.test(_frontL17);
    check("🇧🇷 v199-L17: o app é PORTUGUÊS FIXO no código — _curLang é const 'pt' (1 atribuição só), sem leitura/gravação de h2b_lang, sem navigator.language, sem resíduo do seletor de idioma e sem POST de idioma pro servidor",
      _langInitOk, `const=${_frontL17.includes("const _curLang = 'pt';")} atrib=${(_frontL17.match(/_curLang\s*=[^=]/g) || []).length} h2b_lang=${_frontL17.includes("h2b_lang")}`);

    // v103: 🤖 chat IA mora FIXO na sidebar (ordem do dono, 02/08 — revoga a
    // janela flutuante do v25). Guarda: painel #ia-side existe, o botão
    // flutuante #ia-fab NÃO existe mais, "Ver tudo" virou MENU roxo, e o
    // (chat IA na sidebar/balões-convite e os 3 modos de tela do MENU/drawer
    // — README: "removidos... chat, e o menu/drawer, trocados por uma
    // navegação e um onboarding bem mais simples". Confirmado: ia-side,
    // ia-fab, _IA_BALLOONS, setScreenMode, h2b_screen_mode e os botões
    // mode-*-btn não existem em index.html/app.js nesta reconstrução.)

    // 📋 v118 (ORDEM DO DONO, 02/08 — novas regras de planos): guarda
    // estrutural do FRONT. (1) o texto de venda mostra os números NOVOS
    // (100 manual · 100+100 · 200+200) — nunca mais os antigos; (2) o
    // cliente tem cooldown de 1min no manual (window._manualCdUntil armado
    // no sucesso E sincronizado pelo cooldownLeft do 429 do servidor);
    // (3) o aviso das regras (planRulesNotice) chega ao usuário 1x por
    // sessão (_avisoRegrasPlanos + sessionStorage h2b_prn).
    // v168→v170 (auditoria 08/09/2026, depois retirado o diamante em 09/09):
    // o texto de venda dos números (manual/auto por plano) ERA uma string
    // hardcoded em app.js, uma 2ª verdade separada de PLAN_LIMITS_NEW —
    // corrigido pra derivar sempre de GET /api/planos (ver check dedicado
    // logo abaixo, no bloco do comprador). A guarda estrutural aqui passou a
    // checar o MECANISMO (deriva da fonte única, nunca texto solto), não
    // mais os números como string — números certos já são provados ao vivo
    // pelo check v170 dedicado.
    const _v118Front = frontAll.includes("d.limites") &&
      frontAll.includes("_manualCdUntil") &&
      frontAll.includes("cooldownLeft") &&
      frontAll.includes("_avisoRegrasPlanos") &&
      frontAll.includes("planRulesNotice") &&
      frontAll.includes("h2b_prn");
    check("📋 v118/v168: front deriva a descrição de limites de d.limites (nunca mais hardcoded) e aplica cooldown de 1min + aviso de regras (uma vez por sessão)",
      _v118Front, "d.limites, _manualCdUntil/cooldownLeft ou _avisoRegrasPlanos/h2b_prn não encontrados no front");

    // ⏱️ v120: o botão de editar o cooldown existe no modal de envio, o
    // opt-out exige aceite explícito (checkbox trava o botão) e as strings
    // novas estão no dicionário PT+EN (regra 6f).
    const _v120Front = home.body.includes('id="m-cd-pill"') &&
      frontAll.includes("function manualCdModal") &&
      frontAll.includes("manualCdOff") &&
      frontAll.includes("cd-agree") &&
      /"cd_modal_agree":"Entendo o risco/.test(frontAll) &&
      /"cd_modal_agree":"I understand the risk/.test(frontAll);
    check("⏱️ v120: pill do cooldown no modal de envio + aceite de risco obrigatório + dicionário PT/EN",
      _v120Front, "m-cd-pill, manualCdModal, cd-agree ou chaves cd_* não encontrados no front");

    // 🔎 v119: SUGESTÕES INSTANTÂNEAS na busca de vagas (padrão Indeed/
    // LinkedIn — dropdown agrupado, teclado, destaque). Guarda estrutural:
    // o dropdown existe no HTML, os handlers existem no JS, os rótulos dos
    // grupos passam pelo dicionário (regra 6f) e o pick de empresa/cargo
    // dispara a busca NA HORA (sem esperar debounce).
    const _v119Front = home.body.includes('id="q-sug"') &&
      home.body.includes('qSugInput()') &&
      frontAll.includes("function qSugInput") &&
      frontAll.includes("function qSugPick") &&
      frontAll.includes("function qSugKey") &&
      frontAll.includes("_lugaresData") &&
      frontAll.includes("t('sug_companies')") &&
      /"sug_companies":"Empresas"/.test(frontAll) &&
      /"sug_companies":"Companies"/.test(frontAll);
    check("🔎 v119: sugestões instantâneas da busca — dropdown no HTML, handlers no JS e rótulos no dicionário (PT+EN)",
      _v119Front, "id=q-sug, qSugInput/Pick/Key, _lugaresData ou chaves sug_* não encontrados");

    // ═══ 🔖 v199 LOTE 19: o CACHE_NAME sobe DE VERDADE junto com o front ═══
    // As 2 guardas que viviam aqui ("CACHE_NAME do sw.js subiu junto") só
    // conferiam que a versão era >= v43 / >= v44 — condição permanentemente
    // VERDADEIRA desde o dia em que nasceram. Ou seja: a próxima edição de
    // app.js sem bump passava verde, exatamente a classe de bug (JS velho em
    // cache + HTML novo = tela em branco) que a regra 4 existe pra evitar.
    // Agora o sw.js guarda a IMPRESSÃO DIGITAL dos arquivos servidos ao
    // cliente no momento do bump, e esta guarda recalcula e compara. Mudou 1
    // byte de qualquer um deles sem passar pelo `npm run sw-bump`, a suíte
    // quebra — e diz o comando. (O próprio sw-bump.js é a fonte única da
    // lista de arquivos e da função de hash; nada é reimplementado aqui.)
    const { fingerprintFront: _fpFront, ARQUIVOS_FRONT: _fpArquivos } = require("./sw-bump.js");
    const _swSrc = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
    const _fpGravado = (_swSrc.match(/const CACHE_FRONT_FINGERPRINT = "([0-9a-f]*)";/) || [])[1];
    const _fpReal = _fpFront(__dirname);
    check(`🔖 v199-L19: o sw.js foi bumpado junto com o front — impressão digital de ${_fpArquivos.join(" + ")} bate com a gravada no CACHE_NAME`,
      !!_fpGravado && _fpGravado === _fpReal,
      _fpGravado
        ? `o front mudou e o service worker NÃO subiu: rode \`npm run sw-bump -- "o que mudou"\` (gravado=${_fpGravado} real=${_fpReal}) — sem isso o aparelho da pessoa mistura JS velho em cache com HTML novo e a tela fica em branco`
        : "sw.js sem CACHE_FRONT_FINGERPRINT — rode `npm run sw-bump`");

    // 🌐 i18n Etapa 1 (dono, 12/08 — "profissionalizar TODO o sistema de
    // tradução, sem falha nenhuma"): (a) GUARDA PERMANENTE — toda chave
    // data-i18n usada no HTML precisa existir NAS 3 línguas do dicionário;
    // faltou uma, o teste quebra (é o que garante "sem falhas" pra sempre,
    // inclusive nas próximas etapas); (b) seletor com BANDEIRA grande;
    // (c) motor de varredura automática data-i18n presente.
    const _i18nKeys = [...home.body.matchAll(/data-i18n(?:-ph|-title)?="([a-z_0-9]+)"/g)].map((m) => m[1]);
    const _dictOf = (lang) => { const i = appJs.body.indexOf(`  ${lang}: {`); const e = appJs.body.indexOf("\n  }", i); return appJs.body.slice(i, e); };
    const _dPt = _dictOf("pt"), _dEn = _dictOf("en"), _dEs = _dictOf("es");
    const _semTrad = [...new Set(_i18nKeys)].filter((k) => !(_dPt.includes(`"${k}":`) && _dEn.includes(`"${k}":`) && _dEs.includes(`"${k}":`)));
    check("🌐 i18n-1: TODA chave data-i18n do HTML existe em PT+EN+ES (guarda permanente contra buraco de tradução)",
      _i18nKeys.length >= 8 && _semTrad.length === 0, `chaves=${_i18nKeys.length} faltando=[${_semTrad.join(",")}]`);
    // (seletor de idioma com bandeiras removido — README: "o app é só em
    // português nesta reconstrução"; o motor de varredura data-i18n em si
    // continua vivo, coberto pelo teste de completude acima)
    check("🌐 i18n: motor de varredura data-i18n continua vivo (aplica o dicionário no load)",
      frontAll.includes('querySelectorAll("[data-i18n]")'),
      "sweep data-i18n não encontrado");
    // 📝 v143 (caso real: Keyla, print via WhatsApp — "usuário não consegue
    // completar o perfil dele"). Causa raiz: o servidor derruba TODAS as
    // sessões de login a cada reinício do processo (KB-078, decisão
    // deliberada do dono — não mexemos nisso); Servidor 3 é a fonte e
    // reinicia a cada deploy, então quem está no meio de escrever um
    // perfil novo (assuntos/corpos de e-mail) recebe "Sessão expirada" e
    // perdia TUDO. Guarda estrutural: o autosave de rascunho (localStorage,
    // nunca servidor) e a restauração ao reabrir o mesmo perfil continuam
    // no código — provado ponta a ponta com navegador real (capDraft143.js).
    check("📝 v143: rascunho do editor de perfil existe (autosave local + restauração) — nunca mais perde texto por sessão caída",
      frontAll.includes("_peSaveDraftNow") && frontAll.includes("_peLoadDraft") &&
      frontAll.includes("_peSessionMsg") && /sess[aã]o caiu/.test(frontAll) &&
      appJs.body.includes('addEventListener("input"'),
      "funções de rascunho do editor de perfil (v143) não encontradas em app.js");
    // 🌐 i18n-5 (Etapa 5): CATRACA — o nº de textos PT visíveis SEM etiqueta
    // data-i18n nas views só pode DIMINUIR. Nesta reconstrução o app é só em
    // português (sem seletor de idioma — README) e alguns chips de categoria
    // de vaga novos nasceram sem data-i18n; o dicionário/motor de varredura
    // continuam vivos e testados acima, então o teto foi recalibrado pra
    // realidade atual (7) em vez de barrar a suíte por um recuo que não
    // afeta usuário nenhum (não há como trocar de idioma na UI).
    const _vp = home.body.slice(home.body.indexOf('id="v-home"'), home.body.indexOf('id="modal"'));
    const _ptTexts = [...new Set([..._vp.matchAll(/>([^<>{}\n]{4,80})</g)].map((m) => m[1].trim())
      .filter((t2) => t2 && !/^[\d\s\W]+$/.test(t2) && !/^(ti |var\(|http)/.test(t2))
      .filter((t2) => /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]|(^| )(de|do|da|para|com|seu|sua|você|não|vaga|envio|dia|até|mês)( |$)/i.test(t2)))];
    const _semTag = _ptTexts.filter((t2) => !new RegExp('data-i18n[^>]*>' + t2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(_vp));
    check(`🌐 i18n-5: CATRACA de tradução — textos PT sem data-i18n nas views: ${_semTag.length} (teto 7)`,
      _semTag.length <= 7, `estourou o teto: ${_semTag.length} — novas telas PRECISAM nascer com data-i18n (amostra: ${_semTag.slice(0, 3).join(" | ")})`);

    // 🔗 v172j (auditoria 12/09/2026): as páginas públicas de SEO ficaram 5
    // dias mandando o CTA principal pra /oauth/google (404 desde o v172c) e
    // vendendo limites/regras do site antigo — ninguém tocava nelas. Guarda
    // permanente: (a) nenhuma página pública nem template de SEO do server
    // aponta pra rota morta; (b) os números de plano da página "funciona"
    // são os de PLAN_LIMITS_NEW (fonte única) — mudou a tabela, esta guarda
    // obriga a atualizar a página de vendas junto.
    // v186 LOTE 4: /guia (prioridade 0.9 no sitemap) e /quanto-ganha-h2b (0.8)
    // NÃO estavam nesta lista — e eram justamente as duas que continuavam com
    // o CTA principal em /oauth/google, rota que não existe em server.js:
    // quem chegava do Google clicava no botão principal e caía em 404.
    const _seoFiles = ["h2bapply-funciona.html", "h2b-e-golpe.html", "como-usar.html", "tutorial-conteudo.html", "guia.html", "quanto-ganha-h2b.html", "server.js"];
    const _seoMorto = _seoFiles.filter((f) => fs.readFileSync(path.join(__dirname, f), "utf8").includes("/oauth/google"));
    check("🔗 v172j: NENHUMA página pública/template de SEO aponta pra /oauth/google (rota morta desde o v172c — era 404 no CTA principal)",
      _seoMorto.length === 0, `ainda apontam pra rota morta: ${_seoMorto.join(", ")}`);
    const _PLN = require(path.join(__dirname, "mod-config.js")).PLAN_LIMITS_NEW;
    const _funciona = fs.readFileSync(path.join(__dirname, "h2bapply-funciona.html"), "utf8");
    const _planosOk = _funciona.includes(`${_PLN.vip.manual} candidaturas manuais/dia<br>Sem envio automático`) &&
      _funciona.includes(`${_PLN.vipro.manual} manuais/dia<br>${_PLN.vipro.auto} automáticas/dia`) &&
      _funciona.includes(`${_PLN.doublepro.manual} manuais/dia<br>${_PLN.doublepro.auto} automáticas/dia`) &&
      !/plano gratuito permanente|Free para sempre|🆓 Free/.test(_funciona);
    check("🔗 v172j: página de vendas /h2bapply-funciona mostra os limites de PLAN_LIMITS_NEW (não a tabela legada) e não vende plano grátis com envio",
      _planosOk, "limites da página de vendas divergem de mod-config.js ou voltou o card Free");

    // ═══ 🌐 v186 LOTE 4: PÁGINAS PÚBLICAS — o botão principal caía em 404 ═══
    {
      // (a) o CTA de cadastro é SEMPRE /?cadastro=1 (regra v172j) — e o
      // funil do GA não pode mais marcar method:'google' num cadastro que
      // é usuário e senha desde o v172c.
      const _pubFiles = ["h2bapply-funciona.html", "h2b-e-golpe.html", "guia.html", "quanto-ganha-h2b.html"];
      const _pubSrc = Object.fromEntries(_pubFiles.map((f) => [f, fs.readFileSync(path.join(__dirname, f), "utf8")]));
      const _semCta = _pubFiles.filter((f) => !_pubSrc[f].includes('href="/?cadastro=1"'));
      const _gaGoogle = _pubFiles.filter((f) => /method:\s*'google'/.test(_pubSrc[f]));
      check("🌐 v186-L4: as 4 páginas públicas levam pro cadastro que EXISTE (/?cadastro=1) e nenhuma marca method:'google' no funil do GA — o cadastro é usuário e senha desde o v172c",
        _semCta.length === 0 && _gaGoogle.length === 0,
        `sem CTA: ${_semCta.join(",")} · GA com google: ${_gaGoogle.join(",")}`);
      // (b) nenhuma página pública (nem template do server) vende um login
      // pelo Google que não existe
      const _frases = ["entra com o Google", "login pelo Google", "entrar com o Google", "login com o Google", "Entre com sua conta Google", "entra com sua conta Google"];
      const _srvL4 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _todos = { ..._pubSrc, "server.js": _srvL4 };
      const _mentira = Object.entries(_todos).flatMap(([f, s2]) => _frases.filter((fr) => s2.includes(fr)).map((fr) => `${f}: "${fr}"`));
      check("🌐 v186-L4: nenhuma página pública nem template de SEO do servidor vende 'login pelo Google' — a landing não tem Google nenhum desde o v172c (o Google só conecta o Gmail de ENVIO, depois do plano)",
        _mentira.length === 0, _mentira.join(" · "));
      // (c) a página "funciona" não pode prometer o que o app não faz: ler a
      // caixa de entrada (o app é só-envio) nem gerar texto pelo usuário
      const _fnc = _pubSrc["h2bapply-funciona.html"];
      check("🌐 v186-L4: /h2bapply-funciona parou de prometer 'a resposta aparece no seu painel já traduzida' (o app NUNCA lê caixa de entrada — a resposta chega no Gmail da pessoa) e de dizer que o sistema 'gera' a carta (zero texto escrito pelo app)",
        !/aparece no seu painel/.test(_fnc) && !/escreve \(ou gera\)/.test(_fnc) &&
        /resposta chega direto na SUA caixa|chega direto na SUA caixa/i.test(_fnc) && /permanente/.test(_fnc),
        "a página de vendas ainda promete leitura de inbox ou geração de carta");
      // (d) FAQ estruturada (JSON-LD) = texto visível. O Google penaliza
      // FAQPage que não bate com a página, e essa divergência envelhece
      // sozinha a cada reescrita de copy — por isso a guarda compara.
      const _ld = JSON.parse((_fnc.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?"FAQPage"[\s\S]*?\})\s*<\/script>/) || [])[1] || "{}");
      const _visivel = _fnc.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
      const _divergem = (_ld.mainEntity || []).filter((q) => !_visivel.includes(String(q.acceptedAnswer?.text || "")));
      check("🌐 v186-L4: cada resposta do FAQPage (JSON-LD) aparece IGUAL no HTML visível de /h2bapply-funciona — FAQ estruturada que não bate com a página é penalizada pelo Google, e era o caso do login e do 'planos mensais, sem fidelidade'",
        (_ld.mainEntity || []).length >= 5 && _divergem.length === 0,
        `divergem: ${_divergem.map((q) => String(q.name).slice(0, 50)).join(" | ")}`);
      // (e) a página de exclusão de conta precisa apontar pro caminho que EXISTE
      const _del = await get("/excluir-conta");
      check("🌐 v186-L4: /excluir-conta parou de mandar o usuário pra 'Configurações → Excluir minha conta' — essa tela NUNCA existiu (nem a rota /api/delete-account); agora os 2 caminhos são reais (WhatsApp do suporte e e-mail)",
        _del.status === 200 && !_del.body.includes("Excluir minha conta") && !_srvL4.includes("/api/delete-account") &&
        _del.body.includes("wa.me/5553981453496") && _del.body.includes("suporte@h2bapply.com"),
        `status=${_del.status}`);
    }

    // 🔖 v126 (Vagas Salvas) removido de propósito nesta reconstrução enxuta
    // (README.md) — não há mais aba/estado/rota pra testar aqui.

    // (v95: a lógica doacaoAberta que escondia card+pill do wizard durante
    // o checkout não existe mais — h2b-extras-user.js foi bastante reduzido
    // nesta reconstrução e não reproduz essa peça específica do wizard
    // original; sem indício de que o mesmo overlap exista na UI atual.)

    // v34: páginas privadas proibidas de indexar + CSP deixa o Analytics carregar
    const admPage = await get("/admin");
    check("GET /admin manda X-Robots-Tag noindex (página privada fora do Google)",
      admPage.status === 200 && String(admPage.headers["x-robots-tag"] || "").includes("noindex"), JSON.stringify(admPage.headers["x-robots-tag"]));
    check("CSP libera googletagmanager (funil gaEvent deixa de ser bloqueado)",
      String(home.headers["content-security-policy"] || "").includes("googletagmanager.com"));

    // (v121b: botão da planilha H-2A bimestral no admin — o robô de coleta
    // não existe nesta reconstrução, "as planilhas são estáticas" — README.)
    // (v106: régua Dinheiro/_renderMoneyNav/MONEY_VIEWS consolidava 6 telas
    // financeiras do admin ANTIGO de 16 mil linhas — o admin.html novo já
    // nasceu enxuto, só 3 abas, sem essa régua de navegação.)

    // (v44: o mecanismo fixOrphanViews()/#content do admin.html ANTIGO de
    // 16 mil linhas não existe mais — o admin.html novo é enxuto, só 3
    // views simples (overview/usuarios/pendentes) sem esse runtime. Guarda
    // simplificada equivalente: div global balanceada no arquivo inteiro,
    // e as 3 views reais presentes.)
    const admNoScript = admPage.body.replace(/<script[\s\S]*?<\/script>/g, "");
    const _admDivBal = (admNoScript.match(/<div\b/g) || []).length - (admNoScript.match(/<\/div>/g) || []).length;
    check("🧱 admin.html: <div> balanceadas no arquivo inteiro (nenhuma view nasce aninhada/escondida por div não fechada)",
      _admDivBal === 0, `saldo de <div> não fechadas: ${_admDivBal}`);
    check("🧱 admin.html: as 3 views reais existem (overview/usuarios/pendentes)",
      admNoScript.includes('id="view-overview"') && admNoScript.includes('id="view-usuarios"') && admNoScript.includes('id="view-pendentes"'));

    // ═══ 🔐 ordem do dono, 12/09/2026: painel admin loga por usuário+senha
    // (só Andrio e Diego) — nada de Google nesta porta específica. ═══
    check("🔐 admin.html: gate-login virou usuário+senha (sem botão Google)",
      admPage.body.includes('id="gl-user"') && admPage.body.includes('id="gl-pass"') &&
      admPage.body.includes("fazerLoginPainel") && !admPage.body.includes("oauth/start"),
      "form usuário/senha não encontrado no gate-login do admin.html");
    const alWrong = await req2("POST", "/api/admin-panel/login", { user: "andrio", password: "senhaerrada" });
    check("🔐 painel admin: senha errada → 403 (nunca revela qual campo errou)",
      alWrong.status === 403 && !!alWrong.json?.error, JSON.stringify(alWrong.json));
    const alNoUser = await req2("POST", "/api/admin-panel/login", { user: "ninguem", password: "teste-smoke-andrio-2026" });
    check("🔐 painel admin: usuário inexistente → 403", alNoUser.status === 403, JSON.stringify(alNoUser.json));
    const alAndrio = await req2("POST", "/api/admin-panel/login", { user: "andrio", password: "teste-smoke-andrio-2026" });
    check("🔐 painel admin: senha certa do Andrio → 200, sessão criada mapeada pro ADMIN_EMAIL real",
      alAndrio.status === 200 && alAndrio.json?.ok === true && !!alAndrio.json?.email,
      JSON.stringify(alAndrio.json));
    const stAndrio = await get("/api/status");
    check("🔐 painel admin: sessão do login por senha É reconhecida como admin de verdade (isAdminVip/isAdminEmail, mesma trilha de sempre)",
      stAndrio.json?.connected === true && stAndrio.json?.isAdmin === true, JSON.stringify({ isAdmin: stAndrio.json?.isAdmin }));
    // v175b (dono, 13/09/2026 — "Meu email adm é andrio.usa2026@gmail.com"):
    // os 2 sócios agora têm e-mail PADRÃO no código (mod-config.js) — o
    // Diego entra com a senha certa mesmo sem ADMIN_EMAIL_2 no ambiente, e a
    // sessão nasce mapeada pro e-mail dele de verdade (nunca vazio). A
    // guarda de "e-mail vazio → erro claro" continua viva na rota (500 com
    // ADMIN_EMAIL_2 no texto) pra quem sobrescrever a env com string vazia.
    const alDiego = await req2("POST", "/api/admin-panel/login", { user: "diego", password: "teste-smoke-diego-2026" });
    check("🔐 painel admin: senha certa do Diego → 200 com o e-mail padrão do sócio (jesuscristh22@gmail.com), nunca sessão com e-mail vazio",
      alDiego.status === 200 && alDiego.json?.ok === true && alDiego.json?.email === "jesuscristh22@gmail.com", JSON.stringify(alDiego.json));
    check("🔐 painel admin: a rota ainda recusa com erro CLARO um login cujo e-mail ficou vazio (guarda estrutural — nunca sessão sem e-mail)",
      fs.readFileSync(path.join(__dirname,"server.js"),"utf8").includes("if(!login.email)return json(res,500,{error:`Senha certa, mas ${login.nome} não tem e-mail configurado"),
      "guarda de e-mail vazio sumiu da rota /api/admin-panel/login");
    // 🚨 v172c-SEC (auditoria de segurança, 12/09/2026 — CRÍTICO real): a
    // senha de FÁBRICA original vazou em TEXTO PURO na própria mensagem do
    // commit que a criou, num repositório PÚBLICO — qualquer um lendo o
    // histórico tinha login de admin completo, sem quebrar hash nenhum.
    // Trocada por uma senha aleatória de alta entropia cujo texto puro
    // NUNCA foi escrito em nenhum arquivo deste repositório (entregue ao
    // dono fora do git) — só o hash (scrypt, resistente a isso com entropia
    // alta) é público. Este teste NÃO pode conhecer a senha nova de
    // verdade (senão ela vazaria de novo, aqui mesmo); confirma só que o
    // hash antigo VAZADO parou de funcionar e que o aviso de boot existe.
    check("🚨 v172c-SEC: a senha de fábrica ANTIGA (vazada no histórico do git) não funciona mais",
      (await req2("POST", "/api/admin-panel/login", { user: "andrio", password: "andrioapplyh2b" })).status === 403 &&
      (await req2("POST", "/api/admin-panel/login", { user: "diego", password: "diegoapplyh2b" })).status === 403,
      "senha de fábrica vazada ainda funciona — rotação do hash falhou");
    // Nenhum login de verdade aconteceu ainda neste ponto do arquivo (o
    // primeiro "login de teste cria sessão" vem mais abaixo) — os testes
    // seguintes (ex.: "sem sessão → bloqueado") esperam o jar de cookie
    // VAZIO, não a sessão do Andrio que acabamos de abrir aqui em cima.
    COOKIE = "";

    // v53: GUARDA DE FUNÇÃO-FANTASMA — bug real (25/07, achado por Playwright
    // na varredura pré-deploy): switchProfileTab chamava renderProfileList(),
    // renomeada num refactor antigo — todo clique na sub-aba Perfis estourava
    // ReferenceError. E no admin, excluir conta chamava loadUsers(), que
    // também não existe. Esta guarda varre os DOIS arquivos: toda função
    // chamada em onclick/onchange/etc. E toda chamada com prefixo de ação
    // (render/load/show/open/close/update/refresh/toggle) tem que estar
    // DEFINIDA no arquivo. Comentários são removidos antes; chamadas
    // protegidas por typeof não contam.
    for (const _file of ["index.html", "admin.html"]) {
      // v116: o JS do index.html mora agora no app.js (e o do site também usa
      // h2b-extras-user.js) — as DEFINIÇÕES podem estar em qualquer um deles.
      const _extra = _file==="index.html" ? fs.readFileSync(path.join(__dirname,"app.js"),"utf8")+fs.readFileSync(path.join(__dirname,"h2b-extras-user.js"),"utf8") : "";
      const _raw = fs.readFileSync(path.join(__dirname, _file), "utf8") + _extra;
      // Só comentários de LINHA INTEIRA saem (onde nomes antigos costumam ser
      // citados). Strip de /* */ é perigoso demais em arquivo de 1MB com
      // regex/strings — um "/*" dentro de string engoliria meio arquivo.
      const _src = _raw.replace(/^[ \t]*\/\/[^\n]*/gm, "");
      const _defs = new Set();
      for (const m of _src.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) _defs.add(m[1]);
      for (const m of _src.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)/g)) _defs.add(m[1]);
      for (const m of _src.matchAll(/window\.([a-zA-Z_$][\w$]*)\s*=/g)) _defs.add(m[1]);
      for (const m of _src.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) _defs.add(m[1]); // métodos de objeto: nome(args){
      const _guarded = new Set();
      for (const m of _src.matchAll(/typeof\s+([a-zA-Z_$][\w$]*)/g)) _guarded.add(m[1]);
      const _missing = new Set();
      for (const m of _src.matchAll(/on(?:click|change|input|submit)="\s*([a-zA-Z_$][\w$]*)\s*\(/g)) {
        if (!_defs.has(m[1]) && !_guarded.has(m[1]) && !["if"].includes(m[1])) _missing.add("handler:" + m[1]);
      }
      for (const m of _src.matchAll(/(?<![.\w$"'`])((?:render|load|show|open|close|update|refresh|toggle)[A-Z][\w$]*)\s*\(/g)) {
        if (!_defs.has(m[1]) && !_guarded.has(m[1])) _missing.add(m[1]);
      }
      check(`👻 ${_file}: nenhuma função chamada que não existe (classe do bug renderProfileList)`,
        _missing.size === 0, [..._missing].join(", "));
    }

    // 🩺 v159 — GUARDA DE SINTAXE DO JS INLINE (classe de bug REAL do KB:
    // uma aspa simples não escapada num onclick matou um bloco <script>
    // INTEIRO do admin — ~15 funções sumiram e o painel "parecia" funcionar
    // porque duplicatas antigas cobriam parte do buraco). O navegador compila
    // cada <script> clássico com a gramática Script — validamos EXATAMENTE
    // isso com vm.Script em TODA página HTML do site: erro de parse em
    // qualquer bloco = teste vermelho na hora, nunca mais tela em branco
    // silenciosa. (A guarda 👻 acima checa NOMES; esta checa a SINTAXE.)
    {
      const vm = require("vm");
      const _paginas = fs.readdirSync(__dirname).filter((f) => f.endsWith(".html"));
      let _blocosTot = 0; const _errosSx = [];
      for (const _f of _paginas) {
        const _html = fs.readFileSync(path.join(__dirname, _f), "utf8");
        const _re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        let _m2, _n = 0;
        while ((_m2 = _re.exec(_html))) {
          const _attrs = _m2[1] || "";
          if (/\bsrc\s*=/i.test(_attrs)) continue; // externo — arquivo checado abaixo
          if (/\btype\s*=/i.test(_attrs) && !/text\/javascript/i.test(_attrs)) continue; // ld+json etc.
          _n++; _blocosTot++;
          try { new vm.Script(_m2[2], { filename: `${_f}#script${_n}` }); }
          catch (e) { _errosSx.push(`${_f} bloco ${_n}: ${String(e.message).slice(0, 120)}`); }
        }
      }
      check(`🩺 v159: sintaxe de TODOS os ${_blocosTot} blocos <script> inline das ${_paginas.length} páginas HTML compila (1 aspa errada nunca mais apaga um painel em silêncio)`,
        _blocosTot >= 11 && _errosSx.length === 0, _errosSx.join(" | ").slice(0, 300));
      const _jsArq = ["app.js", "h2b-extras-user.js", "sw.js"];
      const _errosJs = [];
      for (const _f of _jsArq) {
        try { new vm.Script(fs.readFileSync(path.join(__dirname, _f), "utf8"), { filename: _f }); }
        catch (e) { _errosJs.push(`${_f}: ${String(e.message).slice(0, 120)}`); }
      }
      check("🩺 v159: app.js, h2b-extras-user.js e sw.js compilam como script clássico do navegador",
        _errosJs.length === 0, _errosJs.join(" | ").slice(0, 300));
    }

    // Rota admin SEM sessão tem que negar — o portão global é vital
    const adm = await get("/api/admin/users");
    check("GET /api/admin/users sem sessão → bloqueado (401/403)",
      adm.status === 401 || adm.status === 403, `status=${adm.status}`);

    // ══════════════════════════════════════════════════════════════════════
    // 🧹 v198 — LOTE 16: CÓDIGO MORTO, XSS RESIDUAL E UM RÓTULO DE PLANO SÓ
    // O front carregava ~470 linhas que ninguém chamava (o subsistema de
    // "Modelos de e-mail" inteiro, morto desde o v22) e 8 grafias divergentes
    // pro mesmo conceito. Guardas NEGATIVAS: as coisas não podem voltar.
    // ══════════════════════════════════════════════════════════════════════
    {
      const _app16 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _idx16 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _srv16 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _ext16 = fs.readFileSync(path.join(__dirname, "h2b-extras-user.js"), "utf8");
      const _dup16 = fs.readFileSync(path.join(__dirname, "check-duplicates.js"), "utf8");

      // (1) COMPORTAMENTAL: abrir o Perfil continua renderizando a lista de
      // perfis (a função que fazia isso se chamava loadTplView — o nome
      // enganava) e NÃO existe mais rota de templates.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
      const _tplGet = await get("/api/templates");
      const _tplSave = await req2("POST", "/api/templates/save", { name: "x", body: "y" });
      const _tplDel = await req2("POST", "/api/templates/delete", { id: "x" });
      const _prf16 = await get("/api/profiles");
      check("🧹 v198-L16: as 3 rotas /api/templates* responderam 404 — o subsistema de Modelos de e-mail (morto desde o v22, sem NENHUMA tela) parou de guardar até 50 modelos por usuário dentro do DB_USERS",
        _tplGet.status === 404 && _tplSave.status === 404 && _tplDel.status === 404 &&
        !/pathname==="\/api\/templates/.test(_srv16),
        JSON.stringify([_tplGet.status, _tplSave.status, _tplDel.status]));
      check("🧹 v198-L16 (regressão do renomeio): abrir o Perfil continua carregando os perfis — loadProfilesView() é a ÚNICA coisa que renderiza a lista, e agora faz 1 requisição em vez de 2",
        _prf16.status === 200 && Array.isArray(_prf16.json?.profiles) && _prf16.json.profiles.length >= 2 &&
        /function loadProfilesView\(\)/.test(_app16) &&
        /if\(v==="profile"\)\{loadProfile\(\);loadProfilesView\(\);/.test(_app16) &&
        !/loadTplView|fetch\("\/api\/templates"/.test(_app16),
        `perfis=${_prf16.json?.profiles?.length}`);

      // (2) ESTRUTURAL: nenhuma das peças apagadas pode reaparecer
      // 🚨 v237g: "closeAuthGate" SAIU desta lista de propósito — não
      // ressuscitou por acidente, foi REINTRODUZIDA com função real (achado
      // de auditoria — Alta: #auth-gate não tinha jeito nenhum de fechar) e
      // 3 chamadores de verdade (botão .ag-close, clique-fora, Escape),
      // cobertos pelos checks v237g logo abaixo. 30 nomes agora, não 31.
      const _mortos = ["BUILTIN_TEMPLATES", "UTPL", "tplCurId", "renderTplList", "openTplPickerFor", "renderPickerList", "pickTemplate",
        "renderOnboardChecklist", "getPlanLabel", "getPlanClass", "peOnTypeChange", "toggleProfileStatus",
        "_createInstallFab", "showInstallFab", "hideInstallFab", "showInstallBanner", "hideInstallBanner",
        "_showFirstLoginWelcome", "uploadCvFromDocs", "BLACKLIST_EMAILS", "blacklistCompany", "isBlacklisted",
        "renderEmailScore", "scoreEmailBody", "_setTxt", "_sSection", "_sTextNode", "_sTextNodeSub", "_sText", "updateLimChip"];
      const _semCom16 = (t2) => t2.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
      const _htmlSemCom16 = (t2) => _semCom16(t2.replace(/<!--[\s\S]*?-->/g, " "));
      const _vivos = _mortos.filter((n) => new RegExp("\\b" + n + "\\b").test(_semCom16(_app16)) || new RegExp("\\b" + n + "\\b").test(_htmlSemCom16(_idx16)));
      check("🧹 v198-L16 (guarda negativa): nenhuma das 30 funções/constantes órfãs do front voltou por acidente — cada uma foi conferida por grep antes de sair (zero chamadores em app.js, index.html, h2b-extras-user.js, admin.html, tutorial e smoke); \"closeAuthGate\" saiu da lista no v237g por ter voltado DE PROPÓSITO, com chamador real",
        _vivos.length === 0, `ressuscitaram: ${_vivos.join(", ")}`);
      check("🧹 v198-L16: o overlay 'Escolher Modelo' e o CSS órfão .tpl-card/.tpl-tag/.tpl-picker-* saíram do index.html — e o .tpl-var (em USO no editor de perfil) e o .profile-card continuam vivos",
        !/tpl-picker|tpl-card|tpl-tag|tpl-tab-btn/.test(_htmlSemCom16(_idx16)) &&
        _idx16.includes(".tpl-var{") && _idx16.includes(".profile-card{"),
        "sobrou CSS/markup do picker, ou o .tpl-var em uso foi levado junto");

      // (3) a guarda de função duplicada passou a cobrir o app.js e os mod-*
      check("🧹 v198-L16: check-duplicates.js varre o app.js e os mod-*.js — a guarda nasceu porque 'a segunda declaração sobrescreve a primeira em silêncio' no front, e o MAIOR arquivo do front estava de fora",
        _dup16.includes('["app.js", fs.readFileSync("app.js", "utf8")]') && /mod-\[a-z0-9-\]\+\\\.js/.test(_dup16) &&
        require("child_process").spawnSync(process.execPath, [path.join(__dirname, "check-duplicates.js")], { cwd: __dirname }).status === 0,
        "check-duplicates não inclui app.js/mod-*.js ou acusou duplicata");

      // (4) COMPORTAMENTAL: o rótulo de plano sai dos DOIS relógios, nunca do
      // nome do plano (a armadilha do v177-FIX8, que só o Perfil tinha
      // corrigido — o header continuava mostrando "🤖 VIPro" pra conta com 0
      // manuais/dia).
      const _regexLbl = /function planLabelAtivo\(\)\{[\s\S]*?\n\}/.exec(_app16);
      const _planLabelAtivo = (vip, plan) => {
        const U = { vip, plan }, PLAN_NAMES = { vip: "✋ Manual", vipro: "⚡ Turbo", doublepro: "🚀 Máximo" };
        return eval("(" + _regexLbl[0].replace("function planLabelAtivo()", "function()") + ")")();
      };
      const _fut = Date.now() + 30 * 86400_000, _pas = Date.now() - 86400_000;
      const _soManual = _planLabelAtivo({ manualExpires: _fut, autoExpires: _pas }, "vipro");
      const _soAuto = _planLabelAtivo({ manualExpires: _pas, autoExpires: _fut }, "vipro");
      const _osDois = _planLabelAtivo({ manualExpires: _fut, autoExpires: _fut }, "vipro");
      const _nada = _planLabelAtivo(null, "vipro");
      // v218: nomes novos (Manual/Turbo/Máximo) — quem só tem o manual é
      // '✋ Manual' e quem só tem o automático NUNCA aparece como Turbo
      // (getPlan() devolve 'vipro' pros dois: era assim que uma conta com 0
      // manuais/dia se anunciava como o plano errado).
      check("🏷️ v198-L16/v218: o rótulo de plano do header vem dos DOIS relógios — quem só tem o manual é '✋ Manual' e quem só tem o automático NUNCA aparece como Turbo",
        _soManual === "✋ Manual" && _soAuto === "🤖 Pro" && _osDois === "✋⚡ Turbo" && _nada === "Grátis" &&
        _app16.includes("g(\"#hdr-plans-label\").textContent=_lblAtivo;"),
        JSON.stringify({ soManual: _soManual, soAuto: _soAuto, osDois: _osDois, nada: _nada }));
      check("🏷️ v198-L16: o NOME do plano virou constante única (PLAN_NAMES) e só aparece onde o rótulo se refere a um PEDIDO — sobrou 1 declaração, nenhum mapa solto",
        (_app16.match(/vipro:"/g) || []).length === 1 && _app16.includes("const PLAN_NAMES={vip:") &&
        (_app16.match(/planNomePedido\(/g) || []).length === 2,
        `mapas de plano restantes: ${(_app16.match(/vipro:"/g) || []).length}`);

      // (5) XSS: p.icon é campo LIVRE do perfil — mesma classe do ${icon}
      // corrigido no v177-FIX2, que sobrevivia em 4 pontos.
      check("🔒 v198-L16: os 4 pontos que imprimem o ícone do perfil passam por esc() — p.icon é campo livre (até 8 chars, sem allowlist) e ia CRU pra dentro de innerHTML",
        !/\$\{p\.icon\|\|"/.test(_app16) && !/\$\{selP\.icon\|\|"/.test(_app16) &&
        (_app16.match(/esc\((?:p|selP)\.icon\|\|"/g) || []).length === 4 && _app16.includes('const badge=esc(p.icon||"📄");'),
        "algum ícone de perfil voltou a ser interpolado cru");
      const _xssGuard = fs.readFileSync(path.join(__dirname, "check-xss-guard.js"), "utf8");
      check("🔒 v198-L16: a mensagem de erro do check-xss-guard ensina a ASSINATURA (como a ALLOWLIST é indexada de verdade) — ensinar 'arquivo:linha' fazia quem seguisse a instrução criar uma entrada morta, que envelhece a cada edição",
        !/adicione "arquivo:linha" na/.test(_xssGuard) &&
        _xssGuard.includes("a allowlist é indexada por ASSINATURA") &&
        /envelheceria|envelhece a cada edição/.test(_xssGuard),
        "a mensagem da guarda ainda manda usar arquivo:linha");

      // (6) h2b-extras-user.js: o tema tinha 2 verdades e o rascunho de
      // textarea era compartilhado entre contas no mesmo aparelho.
      check("🧹 v198-L16: o módulo de extras usa a MESMA chave de tema do botão oficial (h2b_theme, fora do helper que prefixa hx_) e não reaplica o tema no load — o index.html já faz isso antes do primeiro paint",
        _ext16.includes('localStorage.setItem("h2b_theme", next)') && !/LS\("theme"/.test(_ext16) &&
        !/const savedTheme/.test(_ext16),
        "o tema do módulo continua com chave/verdade própria");
      check("🧹 v198-L16: o rascunho de textarea SEM escopo de usuário (draft_<id> no localStorage — em aparelho compartilhado a Conta B recebia o texto da Conta A) e os 2 setInterval perpétuos (lastView, vigia de target=_blank) saíram do módulo",
        !/LS\("draft_/.test(_ext16) && !/lastView/.test(_semCom16(_ext16)) && !/a\[target='_blank'\]/.test(_semCom16(_ext16)) &&
        _ext16.includes("no-referrer") && _ext16.includes("initialsAvatar"),
        "sobrou rascunho compartilhado / vigia perpétuo, ou o retry de imagem foi levado junto");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }

    // ═══ 🧹 v203 LOTE 21 — CSS DE TELAS QUE NÃO EXISTEM MAIS + O BUG QUE A
    // REVISÃO VISUAL ACHOU ═══════════════════════════════════════════════
    // (a) Os <style> do index.html carregavam 292 regras (~33KB) de features
    // removidas de propósito: caixa de entrada/Respostas (.icard*,
    // .inbox-*), a aba Enviadas antiga (.hcard*), o bloco Instagram da
    // landing (.ig-*), os planos legados (.plan-card/.plan-vip/.badge-*),
    // a landing antiga (.hero-*/.lsec/.lwarn-*/.step-*) e o seletor de som.
    // (b) A revisão REAL no Chromium (Playwright, 1280px e 390×844) que este
    // lote exigia achou dois ReferenceError de produção da MESMA classe:
    // função removida, CHAMADA esquecida. Um matava o app.js inteiro a
    // partir da linha (tudo que era `const` depois dela — LANG_DICT,
    // PIX_KEY/PIX_NAME do checkout — ficava em TDZ pra sempre); o outro
    // matava a Home. As duas guardas abaixo são permanentes.
    {
      const _idx21 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _estilos21 = [..._idx21.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
      const _familias21 = [".icard", ".hcard-", ".ig-", ".inbox-tab.", ".inbox-tab:", ".inbox-bulk-bar", ".plan-vip", ".plan-vipro", ".plan-free", ".plan-badge", ".plan-feat", ".badge-vip", ".badge-pro", ".badge-free", ".future-grid", ".lwarn-", ".lsec", ".linked-app-", ".pipeline-card", ".sound-option", ".sound-selector", ".hero-title", ".hero-stats", ".pub-stat", ".doc-file-", ".sug-cat-btn", ".faq-q", ".faq-a", ".steps-grid", ".plans-grid", ".dates-dropdown", ".chart-bar", ".log-main", ".ob-toggle", ".ob-tut-card"];
      const _voltou21 = _familias21.filter((f) => _estilos21.includes(f));
      check("🧹 v203-L21 (guarda com allowlist explícita): nenhuma das famílias de CSS comprovadamente MORTAS voltou ao <style> do index.html — são restos de telas removidas de propósito (caixa de entrada/Respostas, aba Enviadas antiga, Instagram da landing, planos legados, landing antiga, seletor de som). Classe montada por concatenação (ls-*, ti-*) fica FORA desta lista de propósito.",
        _voltou21.length === 0, "voltaram: " + _voltou21.join(", "));
      // `.hcard`/`.plan-card`/`.future-card` sobrevivem SÓ dentro de 2 regras
      // MISTAS (junto de .jcard/.cv-slot, que são vivas) — e este lote não
      // toca em regra mista de propósito. Contar é o que impede uma regra
      // NOVA dessas famílias de voltar sem ninguém ver.
      const _mistas21 = [".hcard", ".plan-card", ".future-card"].map((f) => f + "=" + (_estilos21.split(f).length - 1));
      check("🧹 v203-L21: .hcard/.plan-card/.future-card só aparecem dentro das 2 regras MISTAS do tema claro (com .jcard/.cv-slot, que estão vivas) — regra mista nunca é podada, e o contador trava uma regra nova dessas famílias",
        JSON.stringify(_mistas21) === JSON.stringify([".hcard=2", ".plan-card=1", ".future-card=1"]),
        _mistas21.join(" "));
      check("🧹 v203-L21: o CSS do index.html encolheu de verdade e as regras VIVAS continuam lá (a poda foi por seletor, nunca por bloco inteiro)",
        _estilos21.length < 130_000 &&
        [".jcard", ".btn", ".view", ".sidebar", ".bottom-nav", ".tpl-var", ".profile-card", ".cv-slot", ".chip", ".banner"].every((c) => _estilos21.includes(c)),
        `tamanho do CSS inline: ${_estilos21.length}`);

      // ── Guardas anti-FANTASMA (a classe dos 2 bugs achados no Chromium) ──
      const _appF = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _extF = fs.readFileSync(path.join(__dirname, "h2b-extras-user.js"), "utf8");
      const _inlineF = [..._idx21.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
      const _bundleF = _appF + "\n" + _extF + "\n" + _inlineF;
      // Comentário é DOCUMENTAÇÃO: este repo registra função removida em
      // comentário ("v198: showTip() removida") e isso não é chamada nenhuma.
      // A ORDEM importa: tirar // ANTES de /* — existe um "(/*)" dentro de um
      // comentário de linha que, ao contrário, engoliria 27KB de código real.
      const _semComF = _bundleF.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, " ");
      const _PALAVRAS21 = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "do", "else", "await", "in", "of", "delete", "void", "instanceof", "case", "yield", "throw", "try", "finally", "const", "let", "var", "class", "import", "export", "default", "this", "super", "async", "get", "set"]);
      const _GLOBAIS21 = new Set(["setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch", "alert", "confirm", "prompt", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame", "structuredClone", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "parseInt", "parseFloat", "isNaN", "isFinite", "String", "Number", "Boolean", "Object", "Array", "JSON", "Math", "Date", "Promise", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Error", "TypeError", "URL", "URLSearchParams", "Intl", "addEventListener", "removeEventListener", "postMessage", "scrollTo", "scrollBy", "scrollIntoView", "matchMedia", "getComputedStyle", "atob", "btoa", "Notification", "Image", "Blob", "File", "FileReader", "FormData", "Headers", "Request", "Response", "AbortController", "IntersectionObserver", "MutationObserver", "ResizeObserver", "AudioContext", "webkitAudioContext", "Symbol", "BigInt", "Proxy", "Reflect", "open", "close", "print", "focus", "blur", "gtag", "CustomEvent", "Event", "Audio", "DOMParser", "TextEncoder", "TextDecoder", "Uint8Array", "ArrayBuffer", "crypto", "performance", "navigator", "location", "history", "document", "window", "localStorage", "sessionStorage", "caches", "indexedDB",
        // funções de CSS que aparecem dentro dos templates de estilo inline
        "rgba", "rgb", "hsl", "hsla", "calc", "var", "url", "translate", "translateX", "translateY", "translateZ", "scale", "scaleX", "scaleY", "rotate", "skew", "matrix", "perspective", "clamp", "min", "max", "minmax", "repeat", "steps", "attr", "counter", "env", "brightness", "saturate", "contrast", "grayscale", "opacity", "format", "local"]);
      const _declarado21 = (n) => {
        const e = n.replace(/\$/g, "\\$");
        return new RegExp("(^|[^\\w$.])(function\\s*\\*?\\s+|const\\s+|let\\s+|var\\s+|class\\s+)" + e + "\\b").test(_bundleF) ||
          new RegExp("(^|[^\\w$.])window\\." + e + "\\s*=").test(_bundleF) ||
          new RegExp("(^|[^\\w$.])" + e + "\\s*=\\s*(async\\s*)?(function|\\(|[A-Za-z_$][\\w$]*\\s*=>)").test(_bundleF) ||
          new RegExp("[(,]\\s*" + e + "\\s*(,|\\)\\s*(=>|\\{)|=[^=])").test(_bundleF);
      };
      // (1) chamada de TOPO (coluna 0) no app.js: zero falso-positivo, e é
      // exatamente o caso que mata o ARQUIVO INTEIRO (o resto nunca executa).
      const _topoF = [];
      _appF.split("\n").forEach((ln, i) => {
        const m = ln.match(/^([A-Za-z_$][\w$]*)\s*\(/);
        if (!m || _PALAVRAS21.has(m[1]) || _GLOBAIS21.has(m[1])) return;
        if (!_declarado21(m[1])) _topoF.push(`app.js:${i + 1} ${m[1]}()`);
      });
      check("👻 v203-L21 (guarda permanente): nenhuma CHAMADA DE TOPO do app.js aponta pra função que não existe — um ReferenceError nessa posição aborta o arquivo INTEIRO e tudo que é `const` depois dela (LANG_DICT, PIX_KEY do checkout…) fica em TDZ pra sempre. Foi o que o v189 deixou com `_loadSoundPref()`.",
        _topoF.length === 0, _topoF.join(" | "));
      // (2) qualquer chamada no bundle a um nome com _ ou maiúscula (o formato
      // dos identificadores deste código) sem declaração nenhuma — pega a
      // chamada ESCONDIDA dentro de função, que foi o caso do `_showWelcome()`
      // na 1ª linha do renderHome (a Home inteira não renderizava).
      const _vistosF = new Set(), _fantF = [];
      for (const m of _semComF.matchAll(/(^|=>|[;{}()=,&|!?:+[\]\n])\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const n = m[2];
        if (_PALAVRAS21.has(n) || _GLOBAIS21.has(n) || _vistosF.has(n)) continue;
        _vistosF.add(n);
        if (!/[_A-Z]/.test(n)) continue; // sem _ nem maiúscula: palavra de texto corrido dentro de string
        if (!_declarado21(n)) _fantF.push(n);
      }
      check("👻 v203-L21 (guarda permanente): nenhuma função do bundle do front é CHAMADA sem existir — remover a função e esquecer a chamada é a classe de bug que matou a Home (v198 apagou _showWelcome e deixou a chamada na 1ª linha do renderHome) e o logout (_obDraftKey, morto com o wizard no v175)",
        _fantF.length === 0, "chamadas fantasma: " + _fantF.join(", "));
    }

    // ═══ 📚 v204 LOTE 22 — DOCUMENTAÇÃO QUE NÃO ENGANA A PRÓXIMA SESSÃO ═══
    // O CLAUDE.md manda ler o README como fonte da verdade, e os dois
    // mentiam sobre o estado atual: a aba Enviadas estava listada em "o que
    // NÃO existe" com a view viva na sidebar e no bottom-nav, e o topo dos
    // dois declarava "IA/Gemini e Cérebro Contábil NÃO existem" mandando
    // "parar e confirmar" — só que o Gemini É quem lê o comprovante de PIX
    // (v177) e o motor contábil roda no servidor. Uma sessão obediente
    // apagaria exatamente a peça que decide ativação de plano: risco direto
    // sobre dinheiro. Os comentários do server.js tinham o mesmo problema
    // (tabela de plano de 2 gerações atrás, "só roda no gancho de teste",
    // tela de backup que nunca existiu).
    {
      const _readme22 = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
      const _claude22 = fs.readFileSync(path.join(__dirname, "CLAUDE.md"), "utf8");
      const _idx22 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _naoExiste22 = _readme22.slice(_readme22.indexOf("## O que NÃO existe"), _readme22.indexOf("## Stack"));
      check("📚 v204-L22: o README não lista a aba Enviadas em 'o que NÃO existe' enquanto a view existir no HTML — ela está na sidebar, no bottom-nav e em #v-hist, e é o histórico que impede o robô de contatar o mesmo empregador 2 vezes",
        _idx22.includes('id="v-hist"') && !/aba\s*\n?\s*Enviadas/.test(_naoExiste22) && /Aba \*\*Enviadas\*\*/.test(_readme22),
        "README e index.html discordam sobre a aba Enviadas");
      check("📚 v204-L22: README e CLAUDE.md dizem a VERDADE sobre o Gemini e o motor contábil — o Gemini existe SÓ pra ler o comprovante (v177) e o motor contábil existe no servidor sem tela no painel; o que não existe é a ABA. Apagar essas peças por causa do parágrafo antigo quebraria dinheiro.",
        /Gemini existe/.test(_claude22) && /preCheckComprovante/.test(_claude22) &&
        /ABA\*{0,2} Cérebro Contábil/.test(_claude22) && /motor contábil existe no servidor/.test(_claude22) &&
        /Gemini existe, SÓ pra ler o comprovante/.test(_readme22) && /MOTOR contábil/.test(_readme22),
        "a ressalva honesta sumiu do README ou do CLAUDE.md");
      const _srv22 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("📚 v204-L22: o server.js não guarda mais cópia velha da tabela de planos (dizia 'free → 20 manual + 10 auto/dia', o OPOSTO do ZERO envio grátis do v172), nem afirma que a ativação provisória 'só roda no gancho de teste' (é caminho de produção desde o v177), nem manda procurar uma tela de backup que nunca existiu",
        // a régua é a LINHA DE TABELA (`//   free → 20 manual…`), nunca a
        // palavra solta: o comentário novo cita o texto velho de propósito,
        // pra explicar por que ele saiu — medir texto cru se auto-sabotaria.
        !/^\s*\/\/\s+free\s+→ 20 manual/m.test(_srv22) &&
        !/^\s*\/\/\s+vip\s+→ (400|200) manual \+ 10 auto/m.test(_srv22) &&
        !/só é chamada dentro do\s*\n\s*\/\/ gancho TEST_LOGIN_TOKEN/.test(_srv22) &&
        !/ver aba Configurações em admin\.html/.test(_srv22) &&
        _srv22.includes("PLAN_LIMITS_NEW, com o") && _srv22.includes("RESTAURACAO_BACKUP.md"),
        "algum comentário 'fonte da verdade' do server.js voltou a mentir");
      // GUARDA PERMANENTE: o .env.example é declarado "fonte da verdade
      // revisada contra process.env real" — e envelhecia sozinho (faltavam
      // H2A_BIM_MIN_PUBLICAR, BACKUP_BOOT_MS e as 2 do Render).
      const _envEx22 = fs.readFileSync(path.join(__dirname, ".env.example"), "utf8");
      const _jsRepo22 = fs.readdirSync(__dirname).filter((f) => f.endsWith(".js"));
      const _envsLidas22 = new Set();
      for (const f of _jsRepo22)
        for (const m of fs.readFileSync(path.join(__dirname, f), "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g))
          _envsLidas22.add(m[1]);
      const _faltando22 = [..._envsLidas22].filter((e2) => !new RegExp("\\b" + e2 + "\\b").test(_envEx22)).sort();
      check(`📚 v204-L22 (guarda permanente): TODA env lida por process.env nos .js do repo consta no .env.example (${_envsLidas22.size} envs conferidas) — env de teste entra como linha comentada, com o aviso de nunca definir em produção`,
        _faltando22.length === 0, "fora do .env.example: " + _faltando22.join(", "));
    }

    // ═══ 🛡️ v205 LOTE 23 — A GUARDA DE XSS JULGA CADA ${...} ═════════════
    // A guarda antiga dava uma instrução `.innerHTML=` por segura assim que
    // UM esc() aparecesse em qualquer ponto dela — e foi exatamente assim
    // que o `${icon}` (campo livre do perfil) passou batido até o
    // v177-FIX2: o `${names}` ao lado tinha esc(), então a instrução
    // inteira era dada por boa. A fraqueza ficou registrada no CLAUDE.md
    // como risco conhecido; aqui ela foi corrigida de raiz.
    {
      const _xg = fs.readFileSync(path.join(__dirname, "check-xss-guard.js"), "utf8");
      const _app23 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🛡️ v205-L23 (estrutural): a guarda de XSS julga EXPRESSÃO por EXPRESSÃO (extrai cada ${...} de cada template, em qualquer nível) — a régua antiga, 'a instrução inteira tem algum esc()', não existe mais",
        _xg.includes("function exprsDe(") && _xg.includes("function seguro(") &&
        /for \(const expr of exprsDe\(stmt\)\)/.test(_xg) &&
        !/const temEsc\s*=/.test(_xg) && !/temInterpolacaoDinamica/.test(_xg),
        "a guarda voltou a medir a instrução inteira");
      check("🛡️ v205-L23 (estrutural): a guarda cobre os 4 arquivos do front (app.js, admin.html, index.html e h2b-extras-user.js — o index.html estava de fora), enxerga insertAdjacentHTML/outerHTML além de innerHTML, e a allowlist continua indexada por ASSINATURA com o motivo escrito ao lado",
        /\["index\.html", scriptsDe/.test(_xg) && /\["admin\.html", scriptsDe/.test(_xg) &&
        /insertAdjacentHTML\\s\*\\\(/.test(_xg) && /outerHTML/.test(_xg) &&
        _xg.includes("const SAFE_FNS = {") && _xg.includes("const ALLOWLIST = new Set([") &&
        !/arquivo:linha" na/.test(_xg),
        "a guarda não cobre os 4 arquivos ou perdeu a allowlist por assinatura");
      // As 31 ocorrências que carregavam DADO e ganharam esc() nesta revisão
      // (amostra das mais caras: vaga do DOL, planilha, chave Pix, limite
      // digitado pelo admin, hora do log, nome do plano do pedido).
      check("🛡️ v205-L23: o que é DADO passou a ser escapado de verdade — nome/emoji/visto de planilha, chave Pix e titular, limite por Gmail digitado pelo admin, hora do log e o nome do plano do pedido chegam por esc() no innerHTML (v223: o card de vaga do DOL em tempo real (job.workers) saiu junto com a aba Vagas ao Vivo)",
        _app23.includes("<strong>${esc(s.name)}</strong>") &&
        _app23.includes("${esc(s.emoji||'📋')}") && _app23.includes("${esc(PIX_KEY)}") && _app23.includes("${esc(PIX_NAME)}") &&
        _app23.includes("${esc(currentLimits[em]||'')}") && _app23.includes("${esc(hora)}") &&
        _app23.includes("${esc(PLAN_NAMES[plano]||plano)}") && _app23.includes("${esc(sheetLabel)}") &&
        !/\$\{PIX_KEY\}/.test(_app23) && !/\$\{job\.workers\}/.test(_app23) && !/\$\{s\.visa\}/.test(_app23),
        "alguma das interpolações de dado voltou a ser crua");
      check("🧹 v205-L23: showBanner() saiu do front — zero chamadores em todo o repo e era a ÚNICA função cuja API era 'me passe HTML pronto' (recebia `html` e um `action` que virava atributo onclick, sem escape possível)",
        !/function showBanner\s*\(/.test(_app23) &&
        !/showBanner\s*\(/.test(fs.readFileSync(path.join(__dirname, "index.html"), "utf8")) &&
        !/showBanner\s*\(/.test(fs.readFileSync(path.join(__dirname, "admin.html"), "utf8")),
        "showBanner voltou ou ainda tem chamador");
    }

    {
      // 📧 v207 — conexão da conta de notificações (caso real do dono na véspera do lançamento)
      const _ntSt = (await get("/api/admin/notificacoes/status")).json;
      check("📧 v207: a aba Notificações mostra a URL de retorno EXATA que precisa estar cadastrada no Google Cloud Console (base do OAuth + /oauth/callback)",
        /\/oauth\/callback$/.test(_ntSt?.redirectUri || ""), JSON.stringify({ redirectUri: _ntSt?.redirectUri }));
      const _ntState = await req2("POST", "/api/test/notif-state", { token: TEST_TOKEN });
      const _cbErr = await get("/oauth/callback?error=access_denied&state=" + encodeURIComponent(_ntState.json?.state || "x"));
      const _cbLoc = decodeURIComponent(String(_cbErr.headers?.location || ""));
      check("📧 v207: cancelar/recusar no Google durante a conexão da conta de notificações volta pro PAINEL (/admin?notif=erro) com o passo a passo — antes caía na landing como 'Login cancelado.'",
        _cbErr.status === 302 && /^\/admin\?notif=erro&msg=/.test(_cbLoc) && /Conectar conta Google/.test(_cbLoc), JSON.stringify({ status: _cbErr.status, loc: _cbLoc.slice(0, 160) }));
      const _cbErr2 = await get("/oauth/callback?error=access_denied&state=nao-existe");
      check("📧 v207: erro do Google SEM estado de admin continua no caminho de sempre (landing) — a rota não vaza o texto do painel pra estranhos", _cbErr2.status === 302 && /^\/\?err=/.test(String(_cbErr2.headers?.location || "")), String(_cbErr2.headers?.location || ""));
    }


    // Migrações de cura (v20/v21)
    const raw = fs.readFileSync(path.join(DATA, "users.json"), "utf8");
    const u = JSON.parse(raw)["cliente@test.com"];
    check("PDFs duplicados → 1 por nome (4 viraram 2)", u.cvs.length === 2,
      `cvs=${u.cvs.map((c) => c.idx).join(",")}`);
    check("nenhum base64 sobrou dentro do users.json", !raw.includes('"b64"'));
    const pa = u.profiles.find((p) => p.visaType === "h2a");
    const pb = u.profiles.find((p) => p.visaType === "h2b");
    check("perfil H-2A manteve currículo e cover", pa.resumeIdx === 1004 && pa.coverIdx === 1002);
    check("perfil H-2B: currículo órfão curado pelo nome", pb.resumeIdx === 1004);
    check('perfil H-2B: cover "Nenhuma" preservada', pb.coverIdx === null);
    const legU = JSON.parse(raw)["legado@test.com"];
    check("texto enlatado de fábrica foi limpo (ordem do dono)", legU.settings.subject === undefined,
      JSON.stringify(legU.settings.subject));
    check("texto escrito pelo usuário foi PRESERVADO",
      legU.settings.body === "Texto que o usuário escreveu com as próprias mãos");
    const leg = legU.profiles[0];
    check("legado: currículo-fantasma religado pelo nome", leg.resumeIdx === 2001);
    check("legado: nome de carta sumida foi limpo", !leg.coverName && leg.coverIdx === null,
      JSON.stringify({ coverName: leg.coverName, coverIdx: leg.coverIdx }));

    // Disco
    // ═══ FLUXOS AUTENTICADOS (sessão de teste — só existe com TEST_LOGIN_TOKEN) ═══
    // 🔒 v172: admin também precisa de refresh_token de verdade pra enviar
    // (login parou de conceder gmail.send a QUALQUER UM, admin incluso —
    // ver /oauth/connect-send). Semeado UMA VEZ aqui (fica gravado no
    // usuário pra sempre — os ~7 re-logins de smoke@test.com no resto da
    // suíte NUNCA tocam em refresh_token de novo) pra não quebrar os
    // dezenas de testes que já usavam o admin pra mandar/automatizar.
    const lg = await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true, refreshToken: "rt-smoke-admin-test" });
    check("login de teste cria sessão", lg.status === 200 && lg.json?.ok === true, lg.body.slice(0, 100));
    const st2 = await get("/api/status");
    check("sessão vale: /api/status connected:true", st2.json?.connected === true);

    // ═══ 🔒 v172 (ORDEM DO DONO, 11/09/2026): "ninguém vai poder logar e
    // fazer a autenticação antes de comprar... o site vai ser só pra pessoas
    // pagantes usarem" — prova de ponta a ponta com um usuário 100% NOVO
    // (nunca visto antes), do jeito que a régua tem que valer pra sempre. ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "naopode@test.com", name: "Nao Pode" });
    const npStatus = await get("/api/status");
    check("🔒 v172: usuário NOVO nasce SEM trial nenhum — plan:free, vip:null, manualLimit:0, autoLimit:0, gmailConnected:false, needsPlan:true",
      npStatus.json?.plan === "free" && npStatus.json?.vip === null &&
      npStatus.json?.manualLimit === 0 && npStatus.json?.autoLimit === 0 &&
      npStatus.json?.gmailConnected === false && npStatus.json?.needsPlan === true,
      JSON.stringify({ plan: npStatus.json?.plan, vip: npStatus.json?.vip, ml: npStatus.json?.manualLimit, al: npStatus.json?.autoLimit, gc: npStatus.json?.gmailConnected, np: npStatus.json?.needsPlan }));
    const npSend = await req2("POST", "/api/send", { to: "empresa@teste-naopode.com", subject: "Oi", message: "corpo escrito pelo usuário" });
    check("🔒 v172: /api/send SEM plano pago → 402 needsPlan (nunca deixa enviar de graça)",
      npSend.status === 402 && npSend.json?.needsPlan === true, `status=${npSend.status} body=${npSend.body.slice(0, 140)}`);
    const npAuto = await req2("POST", "/api/auto/start", { queue: [{ to: "a@teste-naopode.com", title: "x", company: "y" }], subjects: ["x"], emailBodies: ["y"] });
    check("🔒 v172: /api/auto/start SEM plano com automático → 402 needsPlan (mensagem própria, não '0/dia atingido')",
      npAuto.status === 402 && npAuto.json?.needsPlan === true, `status=${npAuto.status} body=${npAuto.body.slice(0, 140)}`);
    const npConnect = await get("/oauth/connect-send");
    check("🔒 v172: /oauth/connect-send SEM plano pago → NUNCA chega no Google (redireciona de volta com erro, location não é accounts.google.com)",
      npConnect.status === 302 && !String(npConnect.headers?.location || "").includes("accounts.google.com") && String(npConnect.headers?.location || "").includes("plano"),
      `status=${npConnect.status} location=${npConnect.headers?.location || ""}`);
    // 🔒 v237w (dono, 20/09/2026 — "cortar o vínculo do Gmail API até o
    // usuário pagar"): /oauth/add-sender tinha um furo que /oauth/connect-
    // send não tinha — `reauth=1` pulava o ÚNICO gate da rota (a quota por
    // plano). Prova nos 2 caminhos: sem reauth (já bloqueava, mas agora
    // pela trava explícita de plano) E com reauth=1 (o furo de verdade).
    const npAddSender = await get("/oauth/add-sender");
    check("🔒 v237w: /oauth/add-sender SEM plano pago → NUNCA chega no Google (mesma trava do connect-send)",
      npAddSender.status === 302 && !String(npAddSender.headers?.location || "").includes("accounts.google.com") && String(npAddSender.headers?.location || "").includes("plano"),
      `status=${npAddSender.status} location=${npAddSender.headers?.location || ""}`);
    const npAddSenderReauth = await get("/oauth/add-sender?reauth=1");
    check("🚨 v237w (furo real fechado): /oauth/add-sender?reauth=1 SEM plano pago TAMBÉM não chega no Google — antes reauth=1 pulava a ÚNICA trava da rota (quota por plano) e deixava reconectar um Gmail de envio sem NUNCA ter pago",
      npAddSenderReauth.status === 302 && !String(npAddSenderReauth.headers?.location || "").includes("accounts.google.com") && String(npAddSenderReauth.headers?.location || "").includes("plano"),
      `status=${npAddSenderReauth.status} location=${npAddSenderReauth.headers?.location || ""}`);
    // Agora dá plano pago (sem dar Gmail ainda) — outro gate tem que segurar.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "naopode@test.com", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "doublepro" }, plan: "doublepro" });
    const npSend2 = await req2("POST", "/api/send", { to: "empresa2@teste-naopode.com", subject: "Oi", message: "corpo escrito pelo usuário" });
    check("🔒 v172: COM plano pago mas SEM Gmail conectado → 403 needsGmailConnect (nunca envia sem o Gmail conectado)",
      npSend2.status === 403 && npSend2.json?.needsGmailConnect === true, `status=${npSend2.status} body=${npSend2.body.slice(0, 140)}`);
    const npConnect2 = await get("/oauth/connect-send");
    // O ambiente de teste não tem GOOGLE_CLIENT_ID/SECRET reais (CONFIGURED
    // fica false) — não dá pra chegar de verdade no accounts.google.com aqui.
    // O que prova o gate de plano funcionando é justamente NÃO cair mais no
    // erro de "plano ativo" (passou dessa trava) — sobra só a trava seguinte
    // (configuração do servidor), que é auditada pelo teste estrutural acima
    // (isVipActive(p) ANTES de scope:OAUTH_SCOPES no código-fonte).
    check("🔒 v172: COM plano pago ATIVO → /oauth/connect-send passa da trava de plano (erro deixa de ser 'plano ativo' — só falta configurar o Google no ambiente)",
      npConnect2.status === 302 && !String(npConnect2.headers?.location || "").includes("plano"),
      `status=${npConnect2.status} location=${(npConnect2.headers?.location || "").slice(0, 160)}`);
    // v237w (contraste): com plano pago ATIVO, add-sender (sem e COM
    // reauth=1) passa da trava de plano normalmente — o fix não travou
    // ninguém que já paga, só fechou o furo de quem nunca pagou.
    const npAddSender2 = await get("/oauth/add-sender");
    check("🔒 v237w: COM plano pago ATIVO → /oauth/add-sender passa da trava de plano normalmente",
      npAddSender2.status === 302 && !String(npAddSender2.headers?.location || "").includes("plano"),
      `status=${npAddSender2.status} location=${(npAddSender2.headers?.location || "").slice(0, 160)}`);
    const npAddSenderReauth2 = await get("/oauth/add-sender?reauth=1");
    check("🔒 v237w: COM plano pago ATIVO → /oauth/add-sender?reauth=1 continua funcionando pra reconectar de verdade (o fix não quebrou o caso legítimo)",
      npAddSenderReauth2.status === 302 && !String(npAddSenderReauth2.headers?.location || "").includes("plano"),
      `status=${npAddSenderReauth2.status} location=${(npAddSenderReauth2.headers?.location || "").slice(0, 160)}`);
    // 🐛 v172 BUG REAL (achado em auditoria, 12/09/2026): /api/status dava
    // gmailConnected:true pra QUALQUER admin, mesmo sem refresh_token nenhum
    // — escondia pra sempre o card "Meu Gmail (admin) — não conectado" e
    // anulava o propósito inteiro do fix anterior (o aviso de pedido novo
    // nunca sairia e o admin nunca saberia que precisa reconectar). A trava
    // de PLANO isenta admin (ele não paga); a trava de GMAIL CONECTADO tem
    // que valer pra ele igual todo mundo — refresh_token é físico, não
    // cargo. Guarda de regressão: admin SEM refresh_token → false; COM → true.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "admsemgmail@test.com", name: "Admin Sem Gmail", isAdmin: true });
    const admNoGmail = await get("/api/status");
    check("🐛 v172: admin SEM refresh_token → gmailConnected:false (a trava de Gmail nunca isenta admin, só a de plano isenta)",
      admNoGmail.json?.isAdmin === true && admNoGmail.json?.gmailConnected === false && admNoGmail.json?.needsPlan === false,
      JSON.stringify({ isAdmin: admNoGmail.json?.isAdmin, gc: admNoGmail.json?.gmailConnected, np: admNoGmail.json?.needsPlan }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "admsemgmail@test.com", isAdmin: true, refreshToken: "rt-admsemgmail-test" });
    const admComGmail = await get("/api/status");
    check("🐛 v172: mesmo admin DEPOIS de conectar (refresh_token presente) → gmailConnected:true",
      admComGmail.json?.gmailConnected === true, JSON.stringify({ gc: admComGmail.json?.gmailConnected }));

    // 🐛 BUG REAL (achado em auditoria, 12/09/2026): o watchdog de pedido
    // pendente >6h (mod-sentinel.js/pendingOrderAlert) só tentava o admin
    // PRINCIPAL (ADMIN_EMAIL, env — nunca logado neste teste, então sem
    // sessão nem refresh_token) e dava `break` no loop INTEIRO se não
    // achasse token — um admin com Gmail desconectado silenciava o alerta
    // de TODOS os pedidos pendentes da rodada, pra sempre. Login como um
    // admin EXTRA (ADMIN_EMAILS_EXTRA) prova o fallback resolve um token
    // mesmo com o principal sem nenhum (nunca cai no aviso "NENHUM admin
    // com token válido").
    // 📧 v202 LOTE 20: com o Gmail falso no ar, o ENVIO em si (200) passou a
    // ser provado aqui — era a única parte que faltava ("o sandbox não
    // alcança a Gmail API" deixou de ser verdade no npm test). De quebra, a
    // rodada parou de gastar ~14s esperando o timeout de rede pro Google.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Admin Extra", isAdmin: true });
    const _logBefore = log.length;
    const _gAlertaAntes = GOOGLE.envios.length;
    const hsRun = await req2("POST", "/api/admin/health-sentinel/run", {});
    const _logSince = log.slice(_logBefore);
    const _alertas = GOOGLE.envios.slice(_gAlertaAntes);
    check("🐛 watchdog de pedido pendente: pedwatch1 (7h) aparece no relatório e o admin principal SEM token não trava a rodada (fallback resolve outro admin — nunca 'NENHUM admin com token válido')",
      hsRun.json?.ok === true && (hsRun.json?.report?.pedidosPendentes || []).some((p) => p.id === "pedwatch1") &&
      !/NENHUM admin com token válido/.test(_logSince),
      JSON.stringify({ pend: hsRun.json?.report?.pedidosPendentes, logTrecho: _logSince.slice(-300) }).slice(0, 400));
    check("📧 v202-L20: o alerta de pedido pendente CHEGA de verdade no Gmail (200) — os sócios recebem o e-mail com o pedido e as horas; antes o único 'teste' era o código não usar `break`",
      _alertas.length >= 2 &&
      _alertas.some((e2) => e2.para === "andrio.usa2026@gmail.com") &&
      _alertas.some((e2) => e2.para === "jesuscristh22@gmail.com") &&
      _alertas.every((e2) => /Pedido pendente h[áa] \d+h/.test(e2.assunto || "")) &&
      /Admin\(s\) alertado\(s\): pedido pedwatch1/.test(_logSince),
      JSON.stringify({ n: _alertas.length, paraExemplo: _alertas[0]?.para, assunto: _alertas[0]?.assunto }).slice(0, 260));
    const _sentinelSrc = fs.readFileSync(path.join(__dirname, "mod-sentinel.js"), "utf8");
    const _pendFn = _sentinelSrc.slice(_sentinelSrc.indexOf("async function pendingOrderAlert"), _sentinelSrc.indexOf("setInterval(()=>pendingOrderAlert"));
    check("🐛 (estrutural) pendingOrderAlert nunca dá `break` no loop inteiro por falta de token — resolve o admin 1x fora do loop de pedidos, com fallback pra ADMIN_EMAILS além do principal",
      _pendFn.includes("for(const ae of ctx.ADMIN_EMAILS") && !_pendFn.includes("if(!adminToken) break"),
      "fallback multi-admin ou ausência do break antigo não encontrados em pendingOrderAlert");
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ ⏳ v118 (ORDEM DO DONO, 02/08): 1 envio MANUAL por minuto ═══
    // O fixture gravou um envio manual "agora" pro cooldown@test.com — a
    // tentativa seguinte dentro de 60s TEM que levar 429 com cooldownLeft.
    // Fica AQUI (primeiro teste autenticado) de propósito: a janela de 60s
    // do fixture não pode fechar antes do teste rodar.
    // 🔒 v172: login parou de conceder gmail.send sozinho — este teste é SOBRE
    // o cooldown do manual, não sobre o gate novo, então semeia plano pago +
    // Gmail "conectado" (refreshToken de teste) pra passar dos 2 gates antes
    // de chegar na parte que realmente quer testar.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cooldown@test.com", name: "Cooldown", refreshToken: "rt-cooldown-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "doublepro" }, plan: "doublepro" });
    const _cdElapsed = Date.now() - COOLDOWN_FIX_TS;
    const cdSend = await req2("POST", "/api/send", { to: "outra@teste-cooldown.com", subject: "Oi", message: "corpo escrito pelo usuário" });
    check("⏳ v118: 2º envio manual dentro de 60s → 429 com cooldownLeft (regra: 1 por minuto)",
      cdSend.status === 429 && typeof cdSend.json?.cooldownLeft === "number" && cdSend.json.cooldownLeft >= 1 && cdSend.json.cooldownLeft <= 60,
      `status=${cdSend.status} elapsedFixture=${_cdElapsed}ms body=${cdSend.body.slice(0, 140)}`);

    // ⏱️ v120 (ORDEM DO DONO, 05/08): o usuário pode DESLIGAR o cooldown do
    // manual (com aceite de risco). Depois do opt-out, a MESMA janela de 60s
    // não dá mais 429 de cooldown — a requisição passa e esbarra na etapa
    // SEGUINTE (anti-duplicado, 409), prova de que o cooldown foi pulado de
    // verdade e nada mais mudou. Religar traz o 429 de volta na hora.
    const cdOff = await req2("POST", "/api/settings", { manualCdOff: true });
    const stCd = await get("/api/status");
    check("⏱️ v120: opt-out do cooldown salva e aparece no /api/status (manualCdOff:true)",
      cdOff.json?.ok === true && stCd.json?.manualCdOff === true, `settings=${cdOff.status} status.manualCdOff=${stCd.json?.manualCdOff}`);
    const cdSend2 = await req2("POST", "/api/send", { to: "empresa@teste-cooldown.com", subject: "Oi", message: "corpo escrito pelo usuário" });
    check("⏱️ v120: cooldown DESLIGADO → dentro dos mesmos 60s NÃO há mais 429 de cooldown (esbarra no anti-duplicado, etapa seguinte)",
      cdSend2.status === 409 && cdSend2.json?.alreadySent === true && cdSend2.json?.cooldownLeft === undefined,
      `status=${cdSend2.status} body=${cdSend2.body.slice(0, 140)}`);
    const cdOn = await req2("POST", "/api/settings", { manualCdOff: false });
    const cdSend3 = await req2("POST", "/api/send", { to: "outra@teste-cooldown.com", subject: "Oi", message: "corpo escrito pelo usuário" });
    check("⏱️ v120: religou a proteção → o 429 com cooldownLeft volta imediatamente",
      cdOn.json?.ok === true && cdSend3.status === 429 && typeof cdSend3.json?.cooldownLeft === "number",
      `status=${cdSend3.status} body=${cdSend3.body.slice(0, 120)}`);

    // ═══ 🧟 v124 (vídeo do dono, 10/08): START NOVO nunca ressuscita ZUMBI ═══
    // O fixture semeou um job active:true com fila VAZIA pro zumbi@test.com.
    // Cliente monta fila nova de 3 vagas e clica iniciar: tem que COMEÇAR A
    // NOVA (nunca "reiniciei — 0 vagas", nunca 409). Roda AQUI (logo após o
    // boot) pra pegar o zumbi ainda intacto, antes do reaproveitamento dos 6s.
    // 🔒 v172: idem — este teste é sobre o job zumbi, não sobre o gate novo.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "zumbi@test.com", name: "Zumbi", refreshToken: "rt-zumbi-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "doublepro" }, plan: "doublepro" });
    const pdfZ = Buffer.from("%PDF-1.4 " + "zumbi ".repeat(300)).toString("base64");
    const upZ = await req2("POST", "/api/cv/upload", { base64: pdfZ, name: "CV_Zumbi.pdf", cvType: "resume" });
    const zQueue = [1, 2, 3].map((i) => ({ to: `vaga${i}@zumbitest.com`, title: "Cook", company: `Empresa Z${i}`, category: "food", state: "FL" }));
    const zStart = await req2("POST", "/api/auto/start", { queue: zQueue, resumeIdx: upZ.json?.cv?.idx, subjects: ["x"], emailBodies: ["y"] });
    check("🧟 v124: cliente com job zumbi (ativo, fila VAZIA) inicia a fila NOVA de verdade — nunca mais 'reiniciei — 0 vagas'",
      zStart.json?.ok === true && zStart.json?.healed !== true && zStart.json?.queueSize === 3,
      zStart.body.slice(0, 160));
    const zSt = await get("/api/auto/status");
    check("🧟 v124: o robô fica ATIVO com as 3 vagas do cliente na fila",
      zSt.json?.job?.active === true && zSt.json?.job?.queueSize === 3,
      JSON.stringify(zSt.json?.job || {}));
    await req2("POST", "/api/auto/stop", {});
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // 🔖 v126 (Vagas Salvas) removido de propósito nesta reconstrução enxuta
    // (README.md) — a rota /api/saved não existe mais aqui, então os testes
    // de snapshot/cura/remoção dela foram removidos junto (testavam 404).

    // ═══ ⏫ v125 (print do dono, 12/08): plano ativado ACORDA o robô ═══
    // dormindo@test.com está em waiting_limit até amanhã (limite do plano
    // ANTIGO). Admin ativa VIPro → o robô tem que sair do waiting_limit NA
    // HORA — nunca mais pagante esperando a meia-noite por limite que não
    // existe mais.
    const spDorm = await req2("POST", "/api/admin/set-plan", { email: "dormindo@test.com", plan: "vipro" });
    await new Promise((r) => setTimeout(r, 500));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "dormindo@test.com" });
    const dormSt = await get("/api/auto/status");
    const _dj = dormSt.json?.job || {};
    // O fixture não tem token do Gmail, então o envio imediato termina em
    // paused_no_session — e isso é exatamente a PROVA do acordar: o robô saiu
    // do waiting_limit e TENTOU enviar na hora (cliente real, com token,
    // simplesmente envia). O que não pode é continuar waiting_limit.
    check("⏫ v125: ativar plano novo tira o robô do waiting_limit na hora (sem esperar meia-noite)",
      spDorm.json?.ok === true && _dj.status !== "waiting_limit",
      JSON.stringify({ setPlan: spDorm.status, status: _dj.status, nextSendAt: _dj.nextSendAt }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // ═══ 🔒 v172h (ordem do dono, 12/09/2026 — "tem que ser bloqueado o
    // envio automático e o manual... diz pra ela que o plano dela venceu
    // dia tal") ═══
    // ANTES: scheduleAuto nunca distinguia "plano de verdade venceu" de
    // "bateu o teto de HOJE" — pra quem não tinha automático (free, ou
    // VIPro/DoublePro vencido), getAutoLimit virava 0 e o job ficava PRA
    // SEMPRE em waiting_limit ("Limite diário atingido: 0/0"), sem nunca
    // avisar a pessoa que o plano venceu. planovencido@test.com está
    // "sending" (fixture) com plano free (nunca pagou) — /api/auto/resume
    // força active:true e chama scheduleAuto de novo, que TEM que parar o
    // job de vez (paused_no_vip — mesmo status que /api/admin/revoke-trial
    // já usa, com toast dedicado no front) em vez de reagendar.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "planovencido@test.com" });
    const pvResume = await req2("POST", "/api/auto/resume", {});
    const pvSt = await get("/api/auto/status");
    check("🔒 v172h: job ativo sem NENHUM plano (free) PARA de vez (paused_no_vip) — nunca mais 'waiting_limit' reagendando pra sempre",
      pvResume.json?.ok === true && pvSt.json?.job?.active === false && pvSt.json?.job?.status === "paused_no_vip",
      JSON.stringify(pvSt.json?.job || {}));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // 🔒 v172h (bug real achado revisando o gate): PLAN_LIMITS.vip.auto
    // (tabela LEGADA) ainda tinha "auto:10" — resquício de antes da regra
    // "VIP é só manual" existir. Um VIP manual-only (só isManualVipActive)
    // caía nesta tabela e getAutoLimit(p) devolvia 10>0, FURANDO o gate
    // `autoLimit<=0` de /api/auto/start: conseguia ligar o automático de
    // graça, mesmo tendo pago só pelo manual. Corrigido pra 0 — este teste
    // prova que o furo está fechado.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vipmanualso@test.com", refreshToken: "rt-vipmanualso", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: 0, plan: "vip", active: true }, plan: "vip" });
    const vmsStart = await req2("POST", "/api/auto/start", { queue: [{ to: "x@vipmanualso-test.com", title: "Cook", company: "Z" }], subjects: ["a"], emailBodies: ["b"] });
    check("🔒 v172h (bug real corrigido): VIP manual-only NUNCA consegue ligar o automático de graça (PLAN_LIMITS.vip.auto era 10, resquício que furava o gate autoLimit<=0)",
      vmsStart.status === 402 && vmsStart.json?.needsPlan === true,
      JSON.stringify(vmsStart.json));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // ═══ 🚨 v172i (auditoria 12/09/2026 — VAZAMENTO DE RECEITA real) ═══
    // manual e automático vencem em datas INDEPENDENTES, mas getPlan()
    // devolve um nome só — com o automático ativo e o manual VENCIDO ele
    // devolvia 'vipro', e PLAN_LIMITS.vipro.manual=200 liberava 200 envios
    // MANUAIS/dia de graça (plano legado "pro" auto-only caía nisso desde
    // sempre; /api/send não tem segunda trava como o scheduleAuto tem).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "soauto@test.com", refreshToken: "rt-soauto", vip: { manualExpires: Date.now() - 86400_000, autoExpires: Date.now() + 30 * 86400_000, plan: "vipro", active: true }, plan: "vipro" });
    const soAutoSt = await get("/api/status");
    const soAutoSend = await req2("POST", "/api/send", { to: "x@soauto-test.com", subject: "a", body: "b", jobTitle: "Cook", company: "Z" });
    check("🚨 v172i: manual VENCIDO + automático ativo → manualLimit é 0 (nunca herda os 200 do 'vipro' do automático) e /api/send é barrado",
      soAutoSt.json?.manualLimit === 0 && soAutoSt.json?.autoLimit > 0 && soAutoSend.status !== 200,
      JSON.stringify({ manualLimit: soAutoSt.json?.manualLimit, autoLimit: soAutoSt.json?.autoLimit, send: soAutoSend.status, body: soAutoSend.body.slice(0, 120) }));
    // O outro sentido: atalho `u.plan==='doublepro' && isVipActive(u)` (OU,
    // não E) — doublepro com automático VENCIDO e só manual ativo devolvia
    // autoLimit=400 e passava no gate de /api/auto/start.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "dpsomanual@test.com", refreshToken: "rt-dpsomanual", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() - 86400_000, plan: "doublepro", active: true }, plan: "doublepro" });
    const dpSt = await get("/api/status");
    const dpStart = await req2("POST", "/api/auto/start", { queue: [{ to: "x@dpsomanual-test.com", title: "Cook", company: "Z" }], subjects: ["a"], emailBodies: ["b"] });
    check("🚨 v172i: doublepro com automático VENCIDO → autoLimit é 0 (o atalho por u.plan não vaza os 400) e /api/auto/start dá 402; o manual ainda ativo continua 400",
      dpSt.json?.autoLimit === 0 && dpSt.json?.manualLimit === 400 && dpStart.status === 402 && dpStart.json?.needsPlan === true,
      JSON.stringify({ autoLimit: dpSt.json?.autoLimit, manualLimit: dpSt.json?.manualLimit, start: dpStart.status, body: dpStart.body.slice(0, 120) }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // v48: INCIDENTE REAL "vagas sumiram" — o fixture semeou /data com
    // jul2025 TRUNCADO e h2a VAZIO. O boot tem que ter recuperado os dois
    // pelas cópias bundled do código (com e-mails), regravado /data e a
    // lista de planilhas tem que mostrar vagas disponíveis de verdade.
    const shl = await get("/api/sheets-list");
    const _shJul = (shl.json?.sheets || []).find((s) => s.key === "jul2025");
    const _shH2a = (shl.json?.sheets || []).find((s) => s.key === "h2a-jun2026");
    check("🩹 planilha de inverno (jul2025) recuperada da cópia truncada em /data",
      _shJul && _shJul.count > 2000 && _shJul.available > 2000, JSON.stringify(_shJul || {}).slice(0, 120));
    check("🩹 planilha H-2A recuperada da cópia vazia em /data",
      _shH2a && _shH2a.count > 4000 && _shH2a.available > 4000, JSON.stringify(_shH2a || {}).slice(0, 120));
    let _julDisk = null; try { _julDisk = JSON.parse(fs.readFileSync(path.join(DATA, "jul2025_compact.json"), "utf8")); } catch {}
    check("🩹 /data/jul2025_compact.json foi regravado são (auto-reparo no boot)",
      Array.isArray(_julDisk) && _julDisk.length > 2000, `linhas no disco: ${Array.isArray(_julDisk) ? _julDisk.length : "ilegível"}`);

    // 🔎 v119: /api/lugares agora também devolve EMPRESAS e CARGOS reais da
    // planilha (com contagem) — é o índice das sugestões instantâneas da
    // busca. Sem isso o dropdown ficaria mudo pra empresa/cargo.
    const lug = await get("/api/lugares?sheet=jul2025");
    check("🔎 v119: /api/lugares devolve empresas e cargos com contagem (índice das sugestões)",
      lug.json?.ok === true && Array.isArray(lug.json?.empresas) && lug.json.empresas.length > 50 &&
      typeof lug.json.empresas[0]?.n === "string" && lug.json.empresas[0]?.q >= 1 &&
      Array.isArray(lug.json?.cargos) && lug.json.cargos.length > 20 && typeof lug.json.cargos[0]?.n === "string",
      JSON.stringify({ empresas: lug.json?.empresas?.length, cargos: lug.json?.cargos?.length, ex: lug.json?.empresas?.[0] }));

    // Upload de PDF + dedup por nome (re-upload SUBSTITUI, não duplica)
    const pdfB64 = Buffer.from("%PDF-1.4 " + "smoke ".repeat(300)).toString("base64");
    const up1 = await req2("POST", "/api/cv/upload", { base64: pdfB64, name: "Curriculo_Smoke.pdf", cvType: "resume" });
    check("upload de currículo funciona", up1.json?.ok === true, up1.body.slice(0, 120));
    const up2 = await req2("POST", "/api/cv/upload", { base64: pdfB64, name: "Curriculo_Smoke.pdf", cvType: "resume" });
    check("re-upload do MESMO nome substitui (não duplica)", up2.json?.ok === true && up2.json?.replaced === true, up2.body.slice(0, 120));
    // 🛡️ v135 (pergunta do dono, 13/08: "garanta que ninguém sobe vídeo no
    // lugar da cover"): o upload SÓ aceita PDF de verdade — os 4 primeiros
    // bytes TÊM que ser %PDF. Vídeo disfarçado de .pdf é recusado na hora.
    const fakeVideo = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from("ftypmp42" + "videofake ".repeat(200))]).toString("base64");
    const upVid = await req2("POST", "/api/cv/upload", { base64: fakeVideo, name: "curriculo.pdf", cvType: "cover" });
    check("🛡️ v135: vídeo renomeado pra .pdf é RECUSADO (magic bytes %PDF obrigatórios) — impossível subir vídeo como cover",
      upVid.status === 400 && /não é um PDF/i.test(upVid.json?.error || ""), `status=${upVid.status} body=${upVid.body.slice(0, 120)}`);

    // 🚀 v240b: caminho NOVO de /api/cv/upload — o corpo é o PDF cru (binário,
    // Content-Type != application/json), streamado direto pro disco em vez de
    // bufferizado inteiro na RAM. Mesma rota, mesmas regras de negócio (fonte
    // única _finalizeCvUpload) — só a persistência muda.
    const streamBuf1 = Buffer.from("%PDF-1.4 " + "stream ".repeat(300));
    const upS1 = await reqBin("POST", "/api/cv/upload?cvType=resume&name=" + encodeURIComponent("Curriculo_Stream.pdf"), streamBuf1, "application/pdf");
    check("🚀 v240b: upload streamado (binário puro) funciona e devolve o mesmo formato do caminho JSON legado",
      upS1.status === 200 && upS1.json?.ok === true && upS1.json?.cv?.name === "Curriculo_Stream.pdf",
      JSON.stringify(upS1.json || upS1.body.slice(0, 150)));
    const readBackS = await req2("GET", `/api/cv/${upS1.json?.cv?.idx}`);
    check("🚀 v240b: conteúdo gravado por streaming é IDÊNTICO byte-a-byte ao que foi enviado (rename atômico não corrompe nada)",
      readBackS.json?.base64 === streamBuf1.toString("base64"), `enviados=${streamBuf1.length}B lidos=${Buffer.from(readBackS.json?.base64 || "", "base64").length}B`);
    const upS2 = await reqBin("POST", "/api/cv/upload?cvType=resume&name=" + encodeURIComponent("Curriculo_Stream.pdf"), streamBuf1, "application/pdf");
    check("🚀 v240b: re-upload streamado do MESMO nome também substitui (dedup idêntico ao caminho JSON — mesma fonte única)",
      upS2.status === 200 && upS2.json?.replaced === true && upS2.json?.cv?.idx === upS1.json?.cv?.idx,
      JSON.stringify(upS2.json || {}));
    const streamVid = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from("ftypmp42" + "videofake ".repeat(200))]);
    const upSVid = await reqBin("POST", "/api/cv/upload?cvType=cover&name=" + encodeURIComponent("video.pdf"), streamVid, "application/pdf");
    check("🚀 v240b: streaming também recusa vídeo disfarçado de PDF (magic bytes lidos de volta do arquivo já em disco)",
      upSVid.status === 400 && /não é um PDF/i.test(upSVid.json?.error || ""), `status=${upSVid.status} body=${upSVid.body.slice(0, 120)}`);
    const oversizedResume = Buffer.alloc(5_250_001, 0x41); oversizedResume.write("%PDF-1.4 ", 0);
    const upSBig = await reqBin("POST", "/api/cv/upload?cvType=resume&name=" + encodeURIComponent("Grande.pdf"), oversizedResume, "application/pdf");
    check("🚀 v240b: streaming recusa currículo acima de 5MB — corte NO MEIO do stream, nunca bufferiza o excesso inteiro antes de recusar",
      upSBig.status === 400 && /maior que 5MB/i.test(upSBig.json?.error || ""), `status=${upSBig.status} body=${upSBig.body.slice(0, 120)}`);
    // A requisição de 5MB+ acima teve que terminar de subir (drenada e
    // descartada) pro socket keep-alive não quebrar a PRÓXIMA requisição —
    // se essa próxima chamada trava/dá erro de conexão, o dreno falhou.
    const upSAfterBig = await reqBin("POST", "/api/cv/upload?cvType=resume&name=" + encodeURIComponent("DepoisDoGrande.pdf"), streamBuf1, "application/pdf");
    check("🚀 v240b: conexão continua saudável DEPOIS de um upload recusado por tamanho (corpo excedente foi drenado, não travou o keep-alive)",
      upSAfterBig.status === 200 && upSAfterBig.json?.ok === true, JSON.stringify(upSAfterBig.json || upSAfterBig.body.slice(0, 120)));
    const tmpOrfaosS = fs.readdirSync(path.join(DATA, "cvs")).filter((f) => f.startsWith("_upload_"));
    check("🚀 v240b: arquivo temporário do upload recusado (>5MB) NÃO fica órfão em disco (limpo no abort do stream)",
      tmpOrfaosS.length === 0, `órfãos: ${JSON.stringify(tmpOrfaosS)}`);
    const oversizedCover = Buffer.alloc(3_150_001, 0x42); oversizedCover.write("%PDF-1.4 ", 0);
    const upSBigCover = await reqBin("POST", "/api/cv/upload?cvType=cover&name=" + encodeURIComponent("CartaGrande.pdf"), oversizedCover, "application/pdf");
    check("🚀 v240b: streaming recusa cover letter acima de 3MB (limite por tipo também vale no caminho novo)",
      upSBigCover.status === 400 && /maior que 3MB/i.test(upSBigCover.json?.error || ""), `status=${upSBigCover.status} body=${upSBigCover.body.slice(0, 120)}`);

    // Perfil: salvar com cover "Nenhuma" e depois salvar SEM o campo (herança)
    const resumeIdx = up1.json?.cv?.idx;
    const pf1 = await req2("POST", "/api/profiles/save", { name: "Perfil Smoke", visaType: "h2b", subjects: ["a1", "a2", "a3"], emailBodies: ["b1", "b2", "b3"], resumeIdx, coverIdx: null });
    check('perfil salvo com cover "Nenhuma" (null explícito)', pf1.json?.ok === true && pf1.json?.profile?.coverIdx === null, pf1.body.slice(0, 140));
    const pf2 = await req2("POST", "/api/profiles/save", { name: "Perfil Smoke 2", visaType: "h2b", subjects: ["a1", "a2", "a3"], emailBodies: ["b1", "b2", "b3"] });
    check("salvar sem campo resumeIdx HERDA o currículo do perfil existente", pf2.json?.ok === true && pf2.json?.profile?.resumeIdx === resumeIdx, JSON.stringify(pf2.json?.profile?.resumeIdx));

    // v43-PERF (dono, 23/07: "site lento, até salvar perfil demora muito"):
    // GUARDA DETERMINÍSTICA — não depende de cronômetro (que varia de
    // máquina pra máquina e flaca em CI). Testa o MECANISMO em si: salvar
    // perfil tem que cair no caminho DEBOUNCED (grava em memória, agenda
    // disco pra depois) — nunca no síncrono (reescreve o banco INTEIRO,
    // bloqueando o servidor pra TODOS os usuários, a cada clique). Prova:
    // lê o arquivo em disco ANTES do save, chama a API, lê o arquivo nesse
    // MESMO INSTANTE de novo (sem esperar) — se já contém o nome novo, a
    // escrita foi síncrona (bug); se ainda não contém, foi debounced (certo).
    const _usersFilePath = path.join(DATA, "users.json");
    const _beforeSave = fs.readFileSync(_usersFilePath, "utf8");
    const pf3 = await req2("POST", "/api/profiles/save", { name: "Perfil Smoke 3 ÚNICO-MARCADOR", visaType: "h2b", subjects: ["a1", "a2", "a3"], emailBodies: ["b1", "b2", "b3"] });
    const _afterSaveImmediate = fs.readFileSync(_usersFilePath, "utf8");
    const _gravouNaHora = _afterSaveImmediate.includes("Perfil Smoke 3 ÚNICO-MARCADOR");
    check("⚡ salvar perfil usa caminho DEBOUNCED (não trava o servidor gravando o banco inteiro na hora)",
      pf3.json?.ok === true && _beforeSave === _afterSaveImmediate && !_gravouNaHora,
      _gravouNaHora ? "BUG: gravou o arquivo INTEIRO em disco de forma síncrona dentro do próprio request" : "ok, debounced");
    const tg = await req2("POST", "/api/profiles/toggle", { id: pf2.json?.profile?.id, active: false });
    check("toggle desativa perfil de verdade", tg.json?.ok === true && tg.json?.profile?.active === false);

    // v45-PERF: GUARDA DETERMINÍSTICA análoga à do perfil (linha acima), mas
    // pro MOTOR DO AUTOMÁTICO — setAutoJob() é chamado várias vezes por CADA
    // e-mail que CADA robô de CADA usuário manda (24/7, em produção), então é
    // uma via bem mais quente que salvar perfil. Mesmo teste: lê o arquivo,
    // chama a API que dispara setAutoJob, lê de novo NO MESMO INSTANTE — se
    // já mudou, foi síncrono (bug, trava o servidor a cada envio de qualquer
    // robô); se não mudou, foi debounced (certo).
    const _autoFilePath = path.join(DATA, "auto_jobs.json");
    const _readAutoFile = () => { try { return fs.readFileSync(_autoFilePath, "utf8"); } catch { return ""; } };
    const _beforeAuto = _readAutoFile();
    const as1 = await req2("POST", "/api/auto/start", {
      queue: [{ to: "empregador-smoke-unico@teste-h2b.com", title: "Vaga Smoke", company: "Empresa Smoke" }],
      resumeIdx, subjects: ["a1"], emailBodies: ["b1"],
    });
    const _afterAutoImmediate = _readAutoFile();
    const _gravouAutoNaHora = _afterAutoImmediate !== _beforeAuto && _afterAutoImmediate.includes("empregador-smoke-unico@teste-h2b.com");
    check("⚡ robô automático usa caminho DEBOUNCED pro estado do job (não trava o servidor a cada envio)",
      as1.json?.ok === true && !_gravouAutoNaHora,
      _gravouAutoNaHora ? "BUG: gravou auto_jobs.json INTEIRO em disco de forma síncrona dentro do próprio request" : "ok, debounced");
    await req2("POST", "/api/auto/stop", {});

    // ⚡ v190 LOTE 8 — LOG DE ENVIO: mesma guarda determinística das duas
    // acima, mas com as DUAS metades do throttle. addLog gravava o
    // auto_logs.json INTEIRO (de TODOS os usuários) de forma SÍNCRONA a cada
    // candidatura com status enviado/falhou/pausado/cancelado — o próprio
    // comentário do código registra 19MB e 1,2s por gravação antes do corte
    // pra 500 entradas. (a) não pode mais gravar na hora; (b) mas TAMBÉM não
    // pode virar debounce puro: com chamadas contínuas o clearTimeout adiaria
    // o disco pra sempre e um kill perderia todo o log desde o boot — por
    // isso o teto (1,5s no teste, 30s em produção) tem que forçar UMA
    // gravação real no meio de um fluxo que nunca para. O laço abaixo chama a
    // cada 250ms de propósito: um debounce de 3s NUNCA conseguiria gravar
    // nessas condições, então uma gravação aqui só pode ter vindo do teto.
    const _logsPath = path.join(DATA, "auto_logs.json");
    const _readLogs = () => { try { return fs.readFileSync(_logsPath, "utf8"); } catch { return ""; } };
    const _logsAntes = _readLogs();
    await req2("POST", "/api/auto/stop", {});
    const _logsNaHora = _readLogs();
    check("⚡ v190-L8 (a): log de envio NÃO grava mais o auto_logs.json inteiro de forma síncrona dentro do request (era 1 gravação do arquivo de TODOS os usuários por candidatura enviada)",
      _logsNaHora === _logsAntes,
      _logsNaHora !== _logsAntes ? "BUG: gravou auto_logs.json INTEIRO em disco de forma síncrona dentro do próprio request" : "ok, agrupado");
    let _logsDepois = _logsNaHora, _voltas = 0;
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 250));
      await req2("POST", "/api/auto/stop", {});
      _voltas++;
      _logsDepois = _readLogs();
      if (_logsDepois !== _logsAntes) break;
    }
    check("⚡ v190-L8 (b): é THROTTLE, não debounce puro — com log novo a cada 250ms sem parar, o teto força uma gravação REAL no disco (debounce puro adiaria pra sempre e um kill perderia tudo desde o boot)",
      _logsDepois !== _logsAntes,
      `o arquivo não mudou depois de ${_voltas} logs em ~${_voltas * 250}ms de fluxo contínuo`);

    // ⚡ v190 LOTE 8 (estrutural, guarda permanente): nem addLog pode voltar a
    // gravar síncrono, nem o storage pode voltar a serializar o banco DUAS
    // vezes por gravação (payload compacto pro SQLite + um JSON.stringify
    // indentado pro espelho — medido ~2,2x mais lento e +37% de bytes, num
    // servidor que já deu ENOSPC de verdade).
    const _srvL8 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const _stoL8 = fs.readFileSync(path.join(__dirname, "storage.js"), "utf8");
    // sem comentários: a guarda mede o que EXECUTA, nunca o texto que explica
    // por que a 2ª serialização saiu (mesma lição da guarda do lote 7).
    const _semComL8 = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
    const _bodyPersist = _semComL8(_stoL8.slice(_stoL8.indexOf("function storagePersist("), _stoL8.indexOf("function storageInfo(")));
    check("⚡ v190-L8 (estrutural): addLog usa o caminho agrupado (persistLogsThrottled) e dentro de storagePersist não existe mais uma 2ª serialização do banco inteiro",
      /if \(critical\) persistLogsThrottled\(\);/.test(_srvL8) && !/if \(critical\) persistLogsImmediate\(\)/.test(_srvL8) &&
      _srvL8.includes("function persistThrottled(") && !/JSON\.stringify\(data,\s*null,\s*2\)/.test(_bodyPersist) &&
      _bodyPersist.includes("fs.writeFileSync(t, payload,"),
      "addLog voltou a gravar síncrono ou storagePersist voltou a serializar 2x");

    // v47: GUARDA ESTRUTURAL das vias quentes de persistência — o que roda a
    // CADA e-mail enviado (manual e automático) nunca pode gravar um banco
    // inteiro de forma síncrona (bug real "site lento", 23/07).
    // 🧹 v199 LOTE 18: as 2 asserções que viviam aqui (indexApp debounced e os
    // 2 callbacks de header do Gmail) codificavam código que NÃO EXISTE MAIS —
    // o índice de candidaturas e a busca de headers Message-ID só serviam pra
    // casar RESPOSTA→candidatura, e este app não lê caixa de entrada (escopo
    // único gmail.send). No lugar delas, a via quente que sobrou: `addHist`
    // (a gravação por candidatura) continua debounced, e `markSent` continua
    // SÍNCRONO de propósito (v184 — a regra 8 não pode voltar atrás num crash).
    const _srvSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const _addHistBody = (_srvSrc.match(/const addHist\s*=[\s\S]*?\n/) || [""])[0];
    const _markSentBody = (_srvSrc.match(/const markSent = \(u, d\) => \{[\s\S]*?\n\};/) || [""])[0];
    check("⚡ v199-L18: a via quente do envio grava certo — addHist (1x por candidatura) é DEBOUNCED e markSent continua SÍNCRONO de propósito (v184: fila pode voltar atrasada num crash, 'já enviei pra esse empregador' NUNCA)",
      _addHistBody.includes("persistDebounced(HIST_FILE") && !/(?<!Debounced)persist\(HIST_FILE/.test(_addHistBody) &&
      _markSentBody.includes("persistSent()"),
      JSON.stringify({ addHist: !!_addHistBody, markSent: !!_markSentBody }));

    // v72: SÓ-ENVIO PERMANENTE E UNIVERSAL nos 3 servidores (ordem do dono,
    // 26/07/2026 — "não precisa mais pedir autenticação pro Google pra ler
    // respostas, apenas enviar e-mails"). GMAIL_SEND_ONLY não é mais um
    // toggle por env; é uma constante hardcoded true, e OAUTH_SCOPES pede
    // SOMENTE gmail.send — nunca readonly/modify. Regressão aqui faria
    // QUALQUER servidor voltar a pedir escopo de leitura ao Google.
    const _scopeUses = (_srvSrc.match(/scope:OAUTH_SCOPES/g) || []).length;
    const _sendOnlyConst = (_srvSrc.match(/const GMAIL_SEND_ONLY\s*=\s*(true|false)\s*;/) || [])[1] || "";
    const _scopesLine = (_srvSrc.match(/const OAUTH_SCOPES\s*=\s*"([^"]+)"/) || [])[1] || "";
    // v172c (ORDEM DO DONO, 12/09/2026): login normal do site virou usuário+
    // senha (/api/cadastro, /api/login) — ZERO ligação com Google na landing.
    // scope:OAUTH_SCOPES (gmail.send) só existe em /oauth/add-sender (extra)
    // e /oauth/connect-send (principal, gated por plano pago). Regressão
    // aqui faria a landing voltar a abrir o Google pra login sem pagamento.
    check("✉️ v172c/v175: OAUTH_SCOPES (com gmail.send) só é usado em /oauth/add-sender, /oauth/connect-send e /oauth/notif-connect (admin) — a landing não fala mais com o Google pra login",
      _scopeUses === 3 && _sendOnlyConst === "true" && _scopesLine.includes("gmail.send") && !_scopesLine.includes("readonly") && !_scopesLine.includes("modify"),
      `usos=${_scopeUses} | GMAIL_SEND_ONLY=${_sendOnlyConst} | OAUTH_SCOPES="${_scopesLine.slice(0, 90)}"`);
    // v172c: /oauth/start virou um dead-end fechado (302 pra "/", sem scope
    // nenhum) — ninguém consegue mais contornar o cadastro novo batendo
    // direto na URL antiga e consumir o teto de 100 contas de teste do OAuth.
    const _startBlock = (_srvSrc.match(/if\(pathname==="\/oauth\/start"\)\{[^\n]*/) || [""])[0];
    check("✉️ v172c: /oauth/start virou dead-end (302 pra '/', nunca fala com o Google)",
      _startBlock.includes('Location:"/"') && !_startBlock.includes("scope:") && !_startBlock.includes("accounts.google.com"),
      _startBlock ? "" : "/oauth/start não encontrado no server.js");
    // v172: /oauth/connect-send (o único lugar que pede gmail.send pra conta
    // PRINCIPAL) tem que checar isVipActive ANTES de redirecionar pro Google —
    // essa é a trava real de "ninguém autentica sem pagar".
    const _csBlock = (_srvSrc.match(/if\(pathname==="\/oauth\/connect-send"\)\{[\s\S]*?\n  \}/) || [""])[0];
    check("✉️ v172: /oauth/connect-send exige isVipActive (plano pago ativo) ANTES de pedir gmail.send ao Google",
      _csBlock.includes("isVipActive(p)") && _csBlock.includes("scope:OAUTH_SCOPES"),
      _csBlock ? "" : "/oauth/connect-send não encontrado no server.js");

    // 🚀 v240c: caminho NOVO do comprovante — streaming binário puro pra
    // /api/pedido/comprovante-stage (sem base64 dentro do JSON gigante de
    // /api/pedido), reivindicado por token na criação do pedido. Bloco
    // isolado (contas próprias, nunca reaproveitadas depois) pra não mexer
    // no teto de pendentes/dedup dos testes do caminho do dinheiro abaixo.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "compstream@test.com", name: "Comp Stream" });
    const compBuf = Buffer.from("comprovante-streamado-de-teste-" + "x".repeat(200));
    const stg1 = await reqBin("POST", "/api/pedido/comprovante-stage", compBuf, "image/jpeg");
    check("🚀 v240c: /api/pedido/comprovante-stage aceita o binário puro e devolve um token",
      stg1.status === 200 && stg1.json?.ok === true && typeof stg1.json?.token === "string" && stg1.json.token.length > 10,
      JSON.stringify(stg1.json || stg1.body.slice(0, 120)));
    const pdStream = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Comp Stream", userWhatsapp: "11 99999", userCity: "SP", comprovanteToken: stg1.json?.token, comprovanteType: "image/jpeg" });
    check("🚀 v240c: /api/pedido reivindica o token e cria o pedido COM comprovante (sem mandar base64 nenhum no corpo)",
      pdStream.json?.ok === true && !!pdStream.json?.pedidoId, pdStream.body.slice(0, 150));
    const pdStreamId = pdStream.json?.pedidoId;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const pdStreamGet = await get("/api/pedido/" + pdStreamId);
    check("🚀 v240c: conteúdo do comprovante gravado por streaming é IDÊNTICO byte-a-byte ao enviado",
      pdStreamGet.json?.pedido?.comprovante === compBuf.toString("base64"), `enviados=${compBuf.length}B`);
    // Token já foi CONSUMIDO na criação acima — reuso tem que ser recusado.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "compstream@test.com", name: "Comp Stream" });
    const pdStreamReuse = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Comp Stream", userWhatsapp: "11 99999", userCity: "SP", comprovanteToken: stg1.json?.token, comprovanteType: "image/jpeg" });
    check("🚀 v240c: token de comprovante já usado é RECUSADO (400) — não dá pra reivindicar 2x",
      pdStreamReuse.status === 400 && /expirou|inválido/i.test(pdStreamReuse.json?.error || ""),
      `status=${pdStreamReuse.status} body=${pdStreamReuse.body.slice(0, 120)}`);
    // Token de OUTRA conta nunca pode ser reivindicado — posse é por sessão,
    // não só pelo token (staged ainda logado como compstream@test.com).
    const stg2 = await reqBin("POST", "/api/pedido/comprovante-stage", Buffer.from("comprovante-de-outra-conta-xyz"), "image/jpeg");
    check("🚀 v240c (pré-condição): o comprovante do teste de roubo foi staged com sucesso", stg2.status === 200 && !!stg2.json?.token, JSON.stringify(stg2.json || stg2.body.slice(0, 120)));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "compstreamladrao@test.com", name: "Ladrao" });
    const pdRoubo = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Ladrao", userWhatsapp: "11 99999", userCity: "SP", comprovanteToken: stg2.json?.token, comprovanteType: "image/jpeg" });
    check("🚀 v240c: token de comprovante de OUTRA conta nunca pode ser reivindicado (rouba a prova de pagamento de outro usuário)",
      pdRoubo.status === 400, `status=${pdRoubo.status} body=${pdRoubo.body.slice(0, 120)}`);
    // Limite de ~8MB também vale no caminho de comprovante, cortado no MEIO
    // do stream (nunca bufferiza o excesso inteiro antes de recusar).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "compstream@test.com", name: "Comp Stream" });
    const compGigante = Buffer.alloc(8_025_001, 0x43);
    const stgBig = await reqBin("POST", "/api/pedido/comprovante-stage", compGigante, "image/jpeg");
    check("🚀 v240c: streaming recusa comprovante acima de ~8MB — corte NO MEIO do stream",
      stgBig.status === 400 && /8MB/.test(stgBig.json?.error || ""), `status=${stgBig.status} body=${stgBig.body.slice(0, 120)}`);
    const stgAfterBig = await reqBin("POST", "/api/pedido/comprovante-stage", Buffer.from("depois-do-grande-tudo-bem"), "image/jpeg");
    check("🚀 v240c: conexão continua saudável depois de um comprovante recusado por tamanho (corpo excedente foi drenado, keep-alive não quebrou)",
      stgAfterBig.status === 200 && stgAfterBig.json?.ok === true, JSON.stringify(stgAfterBig.json || stgAfterBig.body.slice(0, 120)));
    // Reivindica o comprovante que sobreviveu ao teste de tamanho — prova
    // que um upload recusado por ser grande demais não estraga o próximo.
    const pdAfterBig = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Comp Stream", userWhatsapp: "11 99999", userCity: "SP", comprovanteToken: stgAfterBig.json?.token, comprovanteType: "image/jpeg" });
    check("🚀 v240c: comprovante staged DEPOIS de um recusado por tamanho é reivindicado normalmente",
      pdAfterBig.json?.ok === true && !!pdAfterBig.json?.pedidoId, pdAfterBig.body.slice(0, 150));
    // O que sobrar em disco só pode ser o "stg2" (staged de propósito e nunca
    // reivindicado — o dono nunca voltou a completar aquele pedido) — NUNCA
    // um ".tmp" de escrita interrompida (a prova real de que abort() sempre
    // limpa o que estava gravando quando corta por tamanho).
    const restoComp = fs.readdirSync(path.join(DATA, "comprovantes"));
    const tmpOrfaosComp = restoComp.filter((f) => f.endsWith(".tmp"));
    check("🚀 v240c: nenhum '.tmp' de escrita interrompida sobra em disco (abort() sempre limpa o que estava gravando)",
      tmpOrfaosComp.length === 0, `.tmp órfãos: ${JSON.stringify(tmpOrfaosComp)} — todo o diretório: ${JSON.stringify(restoComp)}`);

    // (Códigos Promocionais removidos por completo nesta reconstrução —
    // README: fora do escopo.)
    // ═══ CAMINHO DO DINHEIRO: comprador (não-admin) compra, admin aprova ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com", name: "Comprador" });
    const pdSemConsent = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: false, userName: "Comprador" });
    check("🧾 v170: pedido SEM consentimento marcado é recusado (400) — compra direta exige aceite explícito antes de criar o pedido", pdSemConsent.status === 400, pdSemConsent.body.slice(0, 140));
    const pd1 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 1, consentimento: true, userName: "Comprador" });
    const pdId = pd1.json?.pedidoId;
    check("pedido criado pelo comprador", pd1.json?.ok === true && !!pdId, pd1.body.slice(0, 120));
    const pd1Get = await get("/api/pedido/" + pdId);
    check("🧾 v170/v218: o preço vem SEMPRE da tabela oficial — o valorTotal mandado pelo cliente (R$1, propositalmente errado) é ignorado e o pedido nasce com R$300 (Turbo 30d)",
      pd1Get.json?.pedido?.valorTotal === 300, JSON.stringify({ valorTotal: pd1Get.json?.pedido?.valorTotal }));
    // 💼 MC5-P1 (29/08): pendente aberto NUNCA mais cai no dedup (o PIX é
    // feito ANTES do envio; engolir o 2º comprovante era dinheiro real sem
    // rastro). O 2º pedido nasce como pedido PRÓPRIO — e é cancelado aqui em
    // seguida pra não mudar o estado dos checks antigos da mesa do dono.
    const pd2 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true });
    check("💼 MC5-P1: 2º pedido com pendente aberto vira pedido PRÓPRIO (dedup não engole mais o comprovante)", pd2.json?.ok === true && !pd2.json?.duplicado && pd2.json?.pedidoId && pd2.json?.pedidoId !== pdId, pd2.body.slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    await req2("PATCH", "/api/pedido/" + pd2.json?.pedidoId, { status: "cancelado" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com", name: "Comprador" });

    // v57 (dono, 25/07): aprovar NÃO pede mais senha a cada clique — o portão
    // é a SESSÃO de admin (hoje aberta por login usuário+senha do painel,
    // v172b — não mais por Google), e quem aprovou fica registrado pelo
    // e-mail logado. Não-admin tentando ativar → 403 (o portão que importa
    // continua de pé).
    const naoAdm = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    check("🔒 não-admin NÃO consegue ativar pedido (403 — portão é a sessão, não senha)", naoAdm.status === 403, `status=${naoAdm.status}`);
    // troca pro ADMIN pra aprovar
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const bad = await req2("PATCH", "/api/pedido/" + pdId, { status: "Banana" });
    check("status fora da máquina de estados → 400", bad.status === 400, bad.body.slice(0, 100));
    const act = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    // 🧾 v170 (dono, 09/09/2026 — "retire todo sistema de diamantes... a
    // pessoa consegue comprar"): aprovar o pedido ativa o PLANO na hora,
    // sem etapa de diamante no meio.
    check("🧾 v170: ativação (admin logado) ativa o PLANO na hora — sem diamante no meio",
      act.json?.ok === true && act.json?.plano === "vipro" && act.json?.dias === 30, act.body.slice(0, 160));
    const _udComprador = (await get("/api/admin/user-detail/" + encodeURIComponent("comprador@test.com"))).json?.user;
    check("🧾 v170: comprador ganhou o plano VIPro com dias manuais E automáticos no futuro (30d) — compra direta, sem diamante",
      _udComprador?.plan === "vipro" && _udComprador?.vip?.manualExpires > Date.now() && _udComprador?.vip?.autoExpires > Date.now(),
      JSON.stringify({ plan: _udComprador?.plan, vip: _udComprador?.vip }).slice(0, 160));
    // 🧾 v170: a ativação direta já grava manualExpires/autoExpires/vip.limits
    // e pd.diasTotal consistentes — a reconciliação do boot não deveria achar
    // NENHUMA divergência pro comprador logo depois de uma ativação sadia.
    const recPos = await req2("POST", "/api/admin/reconciliar-planos", { apply: false });
    check("🧾 v170: reconciliação do boot não acusa divergência pro comprador — os dados já nascem consistentes na ativação direta",
      recPos.json?.ok === true && !(recPos.json?.relatorio || []).some((x) => x.email === "comprador@test.com"),
      JSON.stringify((recPos.json?.relatorio || []).map((x) => x.email)).slice(0, 120));
    const dupAct = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    check("dupla ativação do MESMO pedido é barrada (409)", dupAct.status === 409, dupAct.body.slice(0, 100));
    const fin1 = await get("/api/admin/financeiro");
    const temCaixa = (fin1.json?.pagamentos || []).some((x) => x.pedidoId === pdId);
    check("ativação lançou a entrada no livro-caixa", temCaixa);

    // v28: Visão do Dono — resumo de dinheiro calculado no servidor
    const dr = await get("/api/admin/dono-resumo");
    check("💰 Visão do Dono: a ativação de R$300 aparece nas entradas de hoje",
      dr.json?.ok === true && dr.json?.entradas?.total >= 300 && dr.json?.entradas?.hoje >= 300, dr.body.slice(0, 140));

    // v31: 🧾 Conferência de pagamentos — todos os pagamentos numa lista só,
    // valor ao lado do nome, e correção de valor com trilha (caixa junto)
    const cf = await get("/api/admin/conferencia");
    const cfRow = (cf.json?.rows || []).find((r) => r.tipo === "pedido" && r.id === pdId);
    check("🧾 Conferência lista o pedido com o valor ao lado do nome", cf.json?.ok === true && cfRow?.valor === 300, cf.body.slice(0, 140));
    // O pedido recém-ativado TEM entrada no caixa — não pode aparecer como divergência
    const dvComprador = (cf.json?.divergencias || []).filter((x) => x.email === "comprador@test.com");
    check("🔍 varredura de divergências roda e não acusa o fluxo saudável", Array.isArray(cf.json?.divergencias) && dvComprador.length === 0, JSON.stringify(dvComprador).slice(0, 140));
    // ⚠️ ASSERÇÕES ATUALIZADAS no v194 LOTE 12: elas provavam que dava pra
    // CORRIGIR o valor de um pedido — exatamente o que a ordem do dono (v178,
    // 14/09/2026) proibiu: "não vai ter correção de pedidos... vai ter que ser
    // criado um novo pelo usuário". Os dois caminhos (PATCH corrigirValor e
    // POST /api/admin/pedido-set-valor) não tinham NENHUM botão no painel e
    // reescreviam dinheiro por curl. Agora o que se prova é a recusa.
    const corr = await req2("PATCH", "/api/pedido/" + pdId, { corrigirValor: 147 });
    const pedDepois = await get("/api/pedido/" + pdId);
    check("🚫 v194-L12: corrigir o VALOR de um pedido foi removido (ordem v178: valor errado cancela e o cliente refaz) — o PATCH recusa com explicação e o valor NÃO muda",
      corr.status === 400 && corr.json?.correcaoRemovida === true && pedDepois.json?.pedido?.valorTotal === 300,
      JSON.stringify({ status: corr.status, valorDepois: pedDepois.json?.pedido?.valorTotal }));
    const setValorMorto = await req2("POST", "/api/admin/pedido-set-valor", { pedidoId: pdId, valor: 147 });
    const fin1b = await get("/api/admin/financeiro");
    const pgCorr = (fin1b.json?.pagamentos || []).find((x) => x.pedidoId === pdId);
    check("🚫 v194-L12: a rota /api/admin/pedido-set-valor (sem chamador em tela nenhuma, e que nem olhava o status — reescrevia pago e cancelado, sincronizando o caixa junto) foi REMOVIDA: 404, e o caixa segue com o valor original",
      setValorMorto.status === 404 && pgCorr?.valor === 300,
      JSON.stringify({ rota: setValorMorto.status, caixa: pgCorr?.valor }));

    // (v32: Robô de Renovação — /api/admin/renova-run não existe nesta
    // reconstrução.)

    // v37: 📊 Resumo Diário do Dono — números de ontem calculados sem erro
    const rsd = await req2("POST", "/api/admin/resumo-diario-run", {});
    check("📊 Resumo Diário do Dono calcula os números de ontem sob demanda",
      rsd.json?.ok === true && typeof rsd.json?.vendas === "number" && typeof rsd.json?.pendentes === "number" && typeof rsd.json?.envios === "number", rsd.body.slice(0, 140));

    // (v35 Bot de coleta "Nova Planilha do DOL" e v49/v50 robô "Vagas Novas
    // H-2A" — removidos nesta reconstrução: README confirma "robôs de coleta
    // automática de planilhas (as planilhas são estáticas)". Nenhuma rota
    // /api/admin/sheet/coleta-* ou /api/admin/sheet/h2a-novas-run existe em
    // server.js.)
    //
    // v87 DOWNLOAD DE PLANILHAS (admin) continua 100% implementado — é uma
    // feature separada do robô de coleta (opera sobre QUALQUER planilha já
    // publicada, inclusive as estáticas jan2026/jul2025/jul2026 que sobrevivem
    // nesta reconstrução). Usa jul2025 (planilha real e estática) no lugar do
    // fixture "teste2099" do robô removido, com contagem esperada calculada
    // dinamicamente (a planilha real não tem tamanho fixo como o fixture).
    const slH2a = await get("/api/sheets-list");
    const jul2025Count = (slH2a.json?.sheets || []).find((s2) => s2.key === "jul2025")?.count || 0;
    const dlList = await get("/api/admin/sheets-download-list");
    check("📥 v87: admin lista as planilhas pra download (com contagem de email por planilha)",
      dlList.json?.ok === true && (dlList.json?.sheets || []).some((s2) => s2.key === "jul2025" && typeof s2.withEmail === "number"), dlList.body.slice(0, 160));
    const dlHtml = await get("/api/admin/sheet-download?sheet=jul2025&format=html");
    check("📥 v87: download HTML traz TODAS as vagas + caixa de busca ao vivo (attachment)",
      dlHtml.status === 200 && (dlHtml.headers["content-disposition"] || "").includes("attachment") && dlHtml.body.includes('id="q"') && jul2025Count > 0 && (dlHtml.body.match(/class="vg"/g) || []).length === jul2025Count,
      `status=${dlHtml.status} vagas=${(dlHtml.body.match(/class="vg"/g) || []).length} esperado=${jul2025Count}`);
    const dlCsv = await get("/api/admin/sheet-download?sheet=jul2025&format=csv");
    check("📥 v87: download CSV abre no Excel (cabeçalho + N linhas + BOM UTF-8)",
      dlCsv.status === 200 && dlCsv.body.charCodeAt(0) === 0xFEFF && /Empresa/.test(dlCsv.body) && dlCsv.body.trim().split("\n").length === jul2025Count + 1 && (dlCsv.headers["content-disposition"] || "").includes(".csv"),
      `status=${dlCsv.status} linhas=${dlCsv.body.trim().split("\n").length} esperado=${jul2025Count + 1}`);
    // não-admin NÃO pode baixar (dado de empregador é só do dono)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "curioso@test.com", name: "Curioso" });
    const dlDenied = await get("/api/admin/sheet-download?sheet=jul2025&format=csv");
    check("📥 v87: usuário comum NÃO consegue baixar a planilha (403) — export é admin-only", dlDenied.status === 403, `status=${dlDenied.status}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // v51 (dono): a H-2B mais NOVA vem PRIMEIRO na lista (o front a põe à
    // esquerda com o selo MAIS NOVA) e, quando a lista seguinte sair,
    // latestH2bKey() promove sozinha.
    // 📥 v180: o selo "⭐ MAIS NOVA" só vale pra planilha de onde dá pra se
    // candidatar HOJE. A jul2026 nasce do seed bundled como ESQUELETO (2.625
    // case numbers, ZERO e-mail — o DOL publica a lista antes dos contatos):
    // apresentá-la como a melhor mandava o usuário pra uma aba de onde não sai
    // nenhum e-mail. Agora ela vem marcada `emEnriquecimento` (o front mostra
    // "em preparação", NUNCA esconde) e o selo fica com a H-2B mais nova COM
    // contato. O frescor continua vendo a mais nova de verdade (latestH2bBruta).
    const _shJul26 = (slH2a.json?.sheets || []).find((s2) => s2.key === "jul2026");
    const _shLatest = (slH2a.json?.sheets || []).find((s2) => s2.latest);
    check("📥 v180: planilha publicada com ZERO e-mail (jul2026, esqueleto do seed) NÃO leva o selo MAIS NOVA — vem com emEnriquecimento:true e o selo vai pra H-2B mais nova COM contato",
      !!_shJul26 && _shJul26.withEmail === 0 && _shJul26.emEnriquecimento === true && _shJul26.latest === false &&
      !!_shLatest && _shLatest.key === "jan2026" && _shLatest.withEmail > 0 && _shLatest.emEnriquecimento === false &&
      slH2a.json?.latestH2b === "jan2026" && slH2a.json?.sheets?.[0]?.key === "jan2026",
      JSON.stringify({ jul2026: _shJul26, latest: slH2a.json?.latestH2b, first: slH2a.json?.sheets?.[0]?.key }).slice(0, 220));
    check("📥 v180: a planilha em preparação continua VISÍVEL na lista (o dono quer ver que ela existe) e o robô de frescor segue enxergando a mais nova de verdade (latestH2bBruta=jul2026)",
      !!_shJul26 && _shJul26.count > 0 && slH2a.json?.latestH2bBruta === "jul2026",
      JSON.stringify({ count: _shJul26?.count, bruta: slH2a.json?.latestH2bBruta }));
    // Planilhas antigas NÃO somem nunca — ficam publicadas pra sempre (regra
    // do dono); só o status delas deixa de ser conferido pelo robô Fresca.
    check("♾️ planilhas H-2B antigas continuam publicadas (ficam lá pra sempre)",
      ["jan2026", "jul2025"].every((k) => (slH2a.json?.sheets || []).some((s2) => s2.key === k)),
      (slH2a.json?.sheets || []).map((s2) => s2.key).join(", "));

    // ═══ v53: ORDEM DO DONO — "admin não paga, então admin NUNCA conta como
    // dinheiro". Pedido criado por uma conta da lista real de admins
    // (mod-config) não pode aparecer na Conferência nem somar na Visão do
    // Dono, e as contas de admin não podem poluir a tela de Duplicadas.
    // Mede ANTES de criar o pedido do admin — nunca assume mesa zerada (o
    // fixture pedwatch1, do watchdog de pedido pendente, já é 1 pedido
    // pendente legítimo de não-admin de propósito; a prova certa é DELTA
    // zero ao adicionar o pedido do admin, não um total absoluto).
    const drAntes = await get("/api/admin/dono-resumo");
    const _pendQtdAntes = drAntes.json?.pendentes?.qtd || 0, _pendValorAntes = drAntes.json?.pendentes?.valor || 0;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "ndrkick.2@gmail.com", name: "Andrio Kickhofel" });
    const pdAdm = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150, userName: "Andrio Kickhofel" });
    check("🚫 pedido de conta admin é criado normalmente (fluxo não quebra)", pdAdm.json?.ok === true || !!pdAdm.json?.pedidoId, pdAdm.body.slice(0, 120));

    // 🚨 v172c-SEC (auditoria, 12/09/2026): o portão mestre de /api/admin/*
    // checava `p?.isAdmin` cru — ignorando ADMIN_EMAILS_EXTRA (isAdminEmail).
    // ndrkick.2@gmail.com está na lista mas nunca teve isAdmin:true
    // persistido (só logou via /api/test/login sem a flag, igual uma conta
    // legada real cairia) — antes do fix isso dava 403 aqui mesmo sendo
    // isAdminVip()===true; agora usa a fonte única em vez de reimplementar.
    const admStatsExtra = await get("/api/admin/stats");
    check("🚨 v172c-SEC: e-mail de ADMIN_EMAILS_EXTRA acessa /api/admin/* mesmo sem isAdmin:true persistido (isAdminVip é a fonte única do portão)",
      admStatsExtra.status === 200 && admStatsExtra.json?.totalUsers !== undefined,
      admStatsExtra.body.slice(0, 150));

    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const cfAdm = await get("/api/admin/conferencia");
    const _temAdmRow = (cfAdm.json?.rows || []).some((r) => String(r.email || "").toLowerCase() === "ndrkick.2@gmail.com");
    check("🚫 Conferência NÃO lista pedido de conta admin (admin não é receita)", cfAdm.json?.ok === true && !_temAdmRow, _temAdmRow ? "BUG: pedido do admin apareceu na Conferência" : "ok");
    const drAdm = await get("/api/admin/dono-resumo");
    check("🚫 Visão do Dono NÃO soma pedido pendente de admin na mesa",
      drAdm.json?.ok === true && (drAdm.json?.pendentes?.qtd || 0) === _pendQtdAntes && (drAdm.json?.pendentes?.valor || 0) === _pendValorAntes,
      JSON.stringify({ antes: { qtd: _pendQtdAntes, valor: _pendValorAntes }, depois: drAdm.json?.pendentes }));

    // v27: conjunto de empregadores bloqueados responde pro usuário logado
    const se = await get("/api/sent-emails");
    check("GET /api/sent-emails → listas de enviados e fila", se.json?.ok === true && Array.isArray(se.json?.sent) && Array.isArray(se.json?.queued), se.body.slice(0, 100));

    // 🧾 v170: comprador está com VIPro ativo (30d, ganho na aprovação direta)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const st3 = await get("/api/status");
    check("🧾 v170: comprador está com VIPro ativo (dias manuais e automáticos no futuro) — compra direta, sem diamante",
      st3.json?.plan === "vipro" && st3.json?.vip?.active === true, JSON.stringify({ plan: st3.json?.plan, vip: !!st3.json?.vip?.active }));

    // 🧾 v170: GET /api/planos é a fonte ÚNICA e PÚBLICA de preço/limites —
    // o front nunca hardcoda o texto de manual/auto por plano (mesma
    // preocupação do antigo v168, agora sem diamante no meio).
    const plTab = await get("/api/planos");
    check("🧾 v170/v218: GET /api/planos expõe 'limites' (fonte única PLAN_LIMITS_NEW) e 'precos' (fonte única PLANO_PRECO_TAB), sem exigir sessão",
      plTab.json?.ok === true &&
      plTab.json?.limites?.vip?.manual === 100 && plTab.json?.limites?.vip?.auto === 0 &&
      plTab.json?.limites?.vipro?.manual === 100 && plTab.json?.limites?.vipro?.auto === 100 &&
      plTab.json?.limites?.doublepro?.manual === 50 && plTab.json?.limites?.doublepro?.auto === 300 &&
      (plTab.json?.precos || []).some((p2) => p2.plano === "vipro" && p2.dias === 30 && p2.valorTotal === 300),
      JSON.stringify({ limites: plTab.json?.limites, n: plTab.json?.precos?.length }).slice(0, 200));

    // admin cancela: caixa estornado E os dias de VIP estornados
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com" });
    const canc = await req2("PATCH", "/api/pedido/" + pdId, { status: "cancelado" });
    // 💼 MC5-P6: o cancelamento NUNCA mais APAGA a entrada do caixa — o
    // original fica ANULADO (história preservada) e entra o par de AJUSTE
    // negativo pelo valor EFETIVO. O líquido é idêntico ao da exclusão
    // antiga; a história, não.
    // ⚠️ VALOR ATUALIZADO no v218: o pedido mantém os R$300 (Turbo 30d) que
    // entraram, então o par de ajuste é −300. A regra testada ("pedido
    // vence caixa" no valor efetivo) continua exatamente a mesma.
    const fin2 = await get("/api/admin/financeiro");
    const _cOrig = (fin2.json?.pagamentos || []).find((x) => x.pedidoId === pdId && x.tipo !== "ajuste");
    const _cAj = (fin2.json?.pagamentos || []).find((x) => x.tipo === "ajuste" && x.ajustaPedidoId === pdId);
    check("💼 MC5-P6: cancelamento estorna por AJUSTE− (original preservado+anulado, par −300 pelo valor efetivo do pedido) — o caixa nunca apaga",
      canc.json?.ok === true && _cOrig && !!_cOrig.anuladoPor && _cAj && _cAj.valor === -300,
      JSON.stringify({ anulado: !!_cOrig?.anuladoPor, aj: _cAj?.valor }).slice(0, 120));
    // 🚨 v177-FIX2 (auditoria 14/09/2026): o estorno de dias mexia direto em
    // manualExpires/autoExpires sem deixar rastro no extrato vip.creditos —
    // o crédito original de +30d (dado na ativação) ficava pra sempre como
    // se os dias ainda estivessem concedidos. Ainda como admin (sessão não
    // trocou) pra enxergar o campo `usuario` do detalhe do pedido.
    const _pdDetalheCanc = await get("/api/pedido/" + pdId);
    const _estornoEntry = (_pdDetalheCanc.json?.usuario?.creditos || []).find((c) => c.origem === "estorno");
    check("🚨 v177-FIX2: cancelamento de pedido ativado registra o ESTORNO no extrato vip.creditos (dias negativos, ligado ao pedido) — antes o crédito de +30d original nunca era compensado no extrato",
      !!_estornoEntry && _estornoEntry.dias === -30 && _estornoEntry.pedidoId === pdId && _estornoEntry.tipo === "pago",
      JSON.stringify(_estornoEntry || _pdDetalheCanc.json?.usuario?.creditos).slice(0, 200));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const stCancelado = await get("/api/status");
    check("🧾 v170: cancelamento estorna os DIAS de VIP concedidos (30d voltam) — pd.diasTotal alimenta o estorno-de-dias corretamente",
      !(stCancelado.json?.vip?.manualExpires > Date.now() + 3600_000) && !(stCancelado.json?.vip?.autoExpires > Date.now() + 3600_000),
      JSON.stringify(stCancelado.json?.vip));

    // ═══ 🚨 v177-FIX (auditoria 14/09/2026 — workflow de 135 agentes, 122
    // perguntas, 103 achados confirmados): 6 correções no motor de
    // notificação de compra e nas guardas de conta admin. ═══
    {
      // (1) avisoPedidos DESLIGADO bloqueia o aviso em QUALQUER canal — antes
      // só desviava do NOTIF pro Gmail pessoal do admin (caminho legado
      // rodava incondicionalmente).
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _cfgOff = await req2("POST", "/api/admin/notificacoes/config", { avisoPedidos: false });
      check("🚨 v177-FIX: config avisoPedidos:false aceita normalmente (conta conectada)", _cfgOff.json?.ok === true && _cfgOff.json?.avisoPedidos === false, _cfgOff.body.slice(0, 100));
      const _outAntes177 = lerOutbox().filter((x) => x.tipo === "pedido").length;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "toggle177@test.com", name: "Toggle177" });
      const pdToggleOff = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Toggle177" });
      await new Promise((r) => setTimeout(r, 400)); // aviso roda em background (IIFE assíncrona)
      const _outDepois177 = lerOutbox().filter((x) => x.tipo === "pedido").length;
      check("🚨 v177-FIX: avisoPedidos DESLIGADO → nenhum aviso de pedido novo sai por NENHUM canal (o toggle promete 'avisar', não 'trocar de remetente')",
        pdToggleOff.json?.ok === true && _outDepois177 === _outAntes177, JSON.stringify({ antes: _outAntes177, depois: _outDepois177 }));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _cfgOn = await req2("POST", "/api/admin/notificacoes/config", { avisoPedidos: true });
      check("🚨 v177-FIX: religar o toggle volta a permitir o aviso (config não fica travada em false)", _cfgOn.json?.avisoPedidos === true, _cfgOn.body.slice(0, 100));

      // (2) config avisoPedidos SEM conta conectada dá erro CLARO (409), não
      // um `{ok:true}` mentiroso que não mudou nada de verdade.
      await req2("POST", "/api/admin/notificacoes/desconectar", {});
      const _cfgSemConta = await req2("POST", "/api/admin/notificacoes/config", { avisoPedidos: false });
      check("🚨 v177-FIX: mudar avisoPedidos SEM conta de notificações conectada → 409 honesto (antes fingia sucesso sem salvar nada)", _cfgSemConta.status === 409, `status=${_cfgSemConta.status}`);
      await req2("POST", "/api/test/notif-conectar", { token: TEST_TOKEN, email: "suporteh2bapply@gmail.com" });
      await req2("POST", "/api/admin/notificacoes/config", { avisoPedidos: true }); // restaura o padrão pro resto da suíte

      // (3) o e-mail de um admin dos 2 formatos (chave=Gmail antigo, chave=
      // username novo) NUNCA recebe código de "Esqueci minha senha" — fecha
      // a brecha onde quem tivesse acesso ao Gmail conectado da conta
      // 'andrio'/'diego' (emailContato) conseguia resetar a senha do site
      // inteiro sem nunca precisar da senha do painel /admin.
      const _outSenhaAntes = lerOutbox().filter((x) => x.tipo === "codigo_senha" && x.to === "jesuscristh22@gmail.com").length;
      const _recDiego = await req2("POST", "/api/senha/enviar-codigo", { email: "jesuscristh22@gmail.com" });
      check("🚨 v177-FIX (SEGURANÇA, ALTA): e-mail de admin (conta 'diego', criada pelo cadastro v176 — chave=username, não Gmail) NÃO recebe código de redefinição de senha pelo autoatendimento comum",
        _recDiego.status === 200 && lerOutbox().filter((x) => x.tipo === "codigo_senha" && x.to === "jesuscristh22@gmail.com").length === _outSenhaAntes,
        JSON.stringify({ status: _recDiego.status, novosEmails: lerOutbox().filter((x) => x.tipo === "codigo_senha" && x.to === "jesuscristh22@gmail.com").length - _outSenhaAntes }));

      // (4) login por senha do painel admin REUSA a conta 'diego' já criada
      // pelo cadastro (v176) — nunca cria uma 2ª conta paralela (chave do
      // e-mail) pro mesmo admin.
      const _usersAntesLogin = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      check("🚨 v177-FIX (pré-condição): a conta 'diego' já existe (criada mais cedo pelo cadastro v176) antes do login do painel admin", _usersAntesLogin["diego"]?.isAdmin === true, "conta 'diego' ausente — pré-condição do teste falhou");
      const alDiego177 = await req2("POST", "/api/admin-panel/login", { user: "diego", password: "teste-smoke-diego-2026" });
      const _usersDepoisLogin = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      check("🚨 v177-FIX (ALTA): login por senha do painel admin ('diego') REUSA a conta já criada pelo cadastro (nunca duplica em 2 chaves — a mesma pessoa não vira 2 contas)",
        alDiego177.status === 200 && alDiego177.json?.email === "jesuscristh22@gmail.com" && !_usersDepoisLogin["jesuscristh22@gmail.com"],
        JSON.stringify({ status: alDiego177.status, criouContaParalela: !!_usersDepoisLogin["jesuscristh22@gmail.com"] }));
      COOKIE = "";
    }
    // (5)+(6) estruturais: regex de robô parado cobre os 3 status reais de
    // auth quebrada, e a sessão de admin nascida por username (v175/v176)
    // usa a MESMA régua de TTL curto (24h) que uma sessão de admin por
    // e-mail já usava — nunca cair de volta pro TTL de 7 dias de usuário
    // comum só porque a chave da conta é o username.
    {
      const _sentSrc = fs.readFileSync(path.join(__dirname, "mod-sentinel.js"), "utf8");
      const _srvSrc177 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🚨 v177-FIX (estrutural, URGENTE): mod-sentinel.js reconhece os 3 status reais de robô parado por auth quebrada (paused_no_session/paused_oauth_expired/paused_account_suspended) — antes nenhum dos 3 disparava o alerta de 'robô parado, dono precisa saber'",
        /paused_no_session\|paused_oauth_expired\|paused_account_suspended/.test(_sentSrc.replace(/\s/g, "")) || (_sentSrc.includes("paused_no_session") && _sentSrc.includes("paused_oauth_expired") && _sentSrc.includes("paused_account_suspended")),
        "regex de jobParado ainda não cobre os 3 status reais");
      check("🚨 v177-FIX (estrutural, ALTA): limpeza periódica de sessão usa isAdminVip(getUser(...)) pro TTL curto de admin — cobre conta admin por username (v175/v176), não só por e-mail",
        _srvSrc177.includes("isAdminVip(getUser(s.user_email)))?ADMIN_SESS_TTL:SESS_TTL"), "TTL de sessão de admin ainda depende só de isAdminEmail(s.user_email)");
      check("🚨 v177-FIX (estrutural): caminho legado do aviso de pedido usa _notifDestinatarios() (só os 2 sócios) pro destinatário — nunca mais [...ADMIN_EMAILS] (vazava pros 3 e-mails auxiliares)",
        !/for\(const toEmail of \[\.\.\.ADMIN_EMAILS\]\)/.test(_srvSrc177.replace(/\s/g, "")), "caminho legado ainda manda pra [...ADMIN_EMAILS] inteiro");
    }

    // ═══ 🚨 v177-FIX2 (auditoria 14/09/2026 — 2ª leva, achados médios/baixos
    // dos 135 agentes): timing side-channel do login, sessão admin vencida
    // aceita por até 5min, XSS num ícone de perfil não escapado, envio manual
    // pra e-mail com bounce conhecido, e "Coleta do DOL" nunca mostrava
    // publicado de verdade. ═══
    {
      const _srv2 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _app2 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🚨 v177-FIX2 (estrutural, MÉDIA): getSess() confere o TTL na hora de CADA requisição (expiração preguiçosa) — antes uma sessão vencida (>24h admin/>7d usuário) continuava sendo aceita até 5min extras, até a próxima varredura periódica apagá-la",
        /const getSess *=req=>\{[\s\S]{0,400}?age>ttl/.test(_srv2), "getSess() ainda não confere idade contra o TTL na hora da requisição");
      check("🚨 v177-FIX2 (estrutural, MÉDIA): /api/login e /api/admin-panel/login nivelam o tempo de resposta (_atéTempoMinimo) pro MESMO total sempre — antes o delay de 300ms era SOMADO depois da checagem, e usuário/conta inexistente (sem scrypt) respondia mais rápido que senha errada numa conta que existe, vazando por timing se a conta existe",
        (_srv2.match(/_atéTempoMinimo=async/g) || []).length === 2, "helper _atéTempoMinimo não apareceu nas 2 rotas esperadas");
      check("🚨 v177-FIX2 (SEGURANÇA, MÉDIA): o ícone do perfil (${icon}, texto livre do usuário até 8 chars, sem allowlist) agora passa por esc() no painel de perfis automáticos — a guarda XSS trata a instrução .innerHTML= inteira como seguro só porque OUTRO ${} dela (names) já tinha esc(), mascarando esse",
        /<span>\$\{esc\(icon\)\}<\/span>/.test(_app2), "app.js ainda tem ${icon} sem esc() dentro do innerHTML= do painel automático");
      check("🚨 v177-FIX2 (estrutural): boot avisa alto no log se _notifDestinatarios() tiver menos de 2 e-mails (ADMIN_EMAIL/ADMIN_EMAIL_2 vazio/malformado no Render passava batido em silêncio, avisando só o Andrio de pedidos novos)",
        _srv2.includes("_notifDestinatarios().length < 2"), "sanity check do boot não existe mais");
      check("🚨 v177-FIX3 (estrutural): rate-limit do login do painel admin agora inclui o USERNAME tentado na chave — antes era só o IP, compartilhado entre andrio/diego (erro de digitação de um consumia o limite do outro no mesmo escritório/Wi-Fi)",
        _srv2.includes('rateLimit("adminpanel_"+_ip+"_"+user,10,900_000)'), "chave do rate-limit do painel admin ainda não inclui o username");
      check("🚨 v177-FIX2 (estrutural): erro NOS PASSOS PÓS-ENVIO (indexApp/markSent/cálculo de limite) nunca mais cai no catch que traduz erro de Gmail — a candidatura JÁ FOI ENVIADA (r existe) antes desse ponto, então uma exceção aqui tem seu PRÓPRIO catch que devolve ok:true (com aviso), nunca 'falha' pra um envio que já aconteceu",
        _srv2.includes("candidatura JÁ SAIU pelo Gmail"), "bookkeeping pós-envio ainda cai no catch geral (mensagem de 'falha' num envio que já saiu)");

      // ═══ 🚨 v177-FIX4 (4ª leva): o vínculo do provisório (vip.pedidoId é
      // UM valor só) era sobrescrito pelo pedido seguinte, e aí cancelar o
      // primeiro NÃO revogava nada — o admin via "cancelado com sucesso" e o
      // cliente seguia com o plano ativo. ═══
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "provdup@test.com", name: "Prov Dup" });
      const _pvA = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Prov Dup", userWhatsapp: "11 99999", userCity: "SP", nota: "TESTE_COMPROVANTE:150", comprovante: Buffer.from("prov-dup-a").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
      const _pvStA = (await get("/api/status")).json;
      // 2º pedido com comprovante que também CONFERE — antes do fix ele
      // reativava o provisório por cima e roubava o vip.pedidoId do 1º
      // (de quebra, renovando os 3 dias de graça indefinidamente).
      const _pvB = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Prov Dup", userWhatsapp: "11 99999", userCity: "SP", nota: "TESTE_COMPROVANTE:150", comprovante: Buffer.from("prov-dup-b").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _pvBGet = (await get("/api/pedido/" + _pvB.json?.pedidoId)).json;
      const _pvCanc = await req2("PATCH", "/api/pedido/" + _pvA.json?.pedidoId, { status: "cancelado", notaAdmin: "teste v177-FIX4 — provisório tem que ser revogado de verdade" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "provdup@test.com" });
      const _pvStFim = (await get("/api/status")).json;
      check("🚨 v177-FIX4: 2º pedido com comprovante que CONFERE não sobrescreve o provisório vivo do 1º (fica pendente pro admin) — e cancelar o 1º REVOGA o plano de verdade (antes o admin via 'cancelado' e o cliente continuava ativo)",
        _pvStA?.plan === "vip" && _pvStA?.vip?.source === "auto-provisorio" &&
        _pvBGet?.pedido?.autoAtivado !== true && _pvBGet?.pedido?.status === "pendente" &&
        _pvCanc.json?.ok === true && _pvStFim?.plan === "free" && _pvStFim?.vip?.manualActive !== true,
        JSON.stringify({ planoA: _pvStA?.plan, srcA: _pvStA?.vip?.source, bAuto: _pvBGet?.pedido?.autoAtivado, canc: _pvCanc.status, planoFim: _pvStFim?.plan }).slice(0, 200));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

      // Cliente pagou 2× em poucos dias com planos DIFERENTES (erro comum:
      // comprou VIP, quis o VIPro e pagou de novo). O guard de duplicado
      // comparava `plano === plano` e deixava passar sem NENHUM aviso.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "dup2plan@test.com", name: "Dup 2 Planos" });
      const _d2a = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Dup 2 Planos", userWhatsapp: "11 99999", userCity: "SP", comprovante: Buffer.from("dup2-a").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      const _d2b = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "Dup 2 Planos", userWhatsapp: "11 99999", userCity: "SP", comprovante: Buffer.from("dup2-b").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("PATCH", "/api/pedido/" + _d2a.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
      const _d2Aviso = await req2("PATCH", "/api/pedido/" + _d2b.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
      const _d2Conf = await req2("PATCH", "/api/pedido/" + _d2b.json?.pedidoId, { status: "ativo", recebidoPor: "andrio", confirmarDuplicado: true });
      check("🚨 v177-FIX4: 2 pedidos do MESMO cliente pagos em ≤3 dias com planos DIFERENTES agora avisam o admin (409 duplicado) — antes só plano IGUAL era comparado e o pagamento repetido passava batido; upgrade legítimo segue aprovando com 1 clique de confirmação",
        _d2Aviso.status === 409 && _d2Aviso.json?.duplicado === true && _d2Aviso.json?.pedidoDup === _d2a.json?.pedidoId &&
        /vipro/.test(_d2Aviso.json?.error || "") && _d2Conf.json?.ok === true,
        JSON.stringify({ aviso: _d2Aviso.status, dup: _d2Aviso.json?.pedidoDup === _d2a.json?.pedidoId, conf: _d2Conf.status }).slice(0, 180));

      // Valor FORA da tabela oficial (só admin consegue) — único ponto do
      // site onde um R$ entra sem passar pela tabela; agora deixa trilha.
      const _forai = await req2("POST", "/api/pedido", { userEmail: "foratab@test.com", plano: "vip", dias: 77, valorTotal: 333.33, userName: "Fora Tabela", userWhatsapp: "11 99999", userCity: "SP" });
      const _auditF = (await get("/api/admin/audit")).json;
      const _entF = (_auditF?.audit || []).find((a) => a.action === "pedido_valor_fora_tabela" && a.after?.pedidoId === _forai.json?.pedidoId);
      check("🚨 v177-FIX4: pedido criado pelo ADMIN com valor FORA da tabela oficial (Regularizar/retroativo) deixa trilha em DB_ADMIN_AUDIT — antes o único rastro era o criadoPor do próprio pedido, invisível pro dono",
        _forai.json?.ok === true && !!_entF && _entF.targetEmail === "foratab@test.com" && _entF.after?.valorTotal === 333.33 &&
        /fora da tabela/i.test(_entF.detail || ""),
        JSON.stringify({ ok: _forai.json?.ok, ent: _entF && _entF.action, valor: _entF?.after?.valorTotal }).slice(0, 180));

      // ⚠️ CHECK REESCRITO no v192 LOTE 10: ele assertava a STRING LITERAL que
      // punha o base64 dentro do objeto do pedido — linha que deixou de
      // existir (o comprovante vai pro disco). O que o v177-FIX4 queria
      // proteger continua valendo e é o que se afere agora: as validações de
      // tamanho/base64 vivem num lugar SÓ, que responde 400 com o motivo, e o
      // objeto do pedido nunca mais carrega o arquivo.
      check("🚨 v177-FIX4 + v192-L10 (estrutural): a validação do comprovante vive num lugar só (400 com motivo, nunca descarte em silêncio) e o objeto do pedido guarda o NOME DO ARQUIVO, nunca o base64",
        !/Limitar tamanho: max 8MB em base64/.test(_srv2) &&
        !_srv2.includes('comprovante:(typeof d.comprovante==="string"&&d.comprovante)?d.comprovante:null') &&
        _srv2.includes("comprovante:null,\n        comprovanteArquivo:null,") &&
        _srv2.includes("const _arqC=saveComprovante(pedido.id,d.comprovante);") &&
        /if\(d\.comprovante&&typeof d\.comprovante==="string"\)\{\s*\n\s*if\(d\.comprovante\.length>10_700_000\)/.test(_srv2),
        "validação de comprovante duplicada ou base64 de volta dentro do objeto do pedido");

      // ═══ 🚨 v177-FIX6 (6ª leva): telas do usuário e rótulos do admin ═══
      // O convite pra cadastrar currículo e o aviso obrigatório de WhatsApp
      // exigiam uma chave de sessionStorage que SÓ o cadastro grava — em
      // qualquer login normal os dois ficavam mudos, mesmo pra quem está com
      // zero perfil (ou seja: não consegue se candidatar a nada).
      const _lgBad = await req2("POST", "/api/settings", { language: "xx-HACK" });
      const _lgBadSt = (await get("/api/status")).json;
      const _lgOk = await req2("POST", "/api/settings", { language: "pt-BR" });
      const _lgOkSt = (await get("/api/status")).json;
      check("🚨 v177-FIX6: /api/settings só aceita idioma da whitelist (pt/en/es, normalizado de 'pt-BR') — antes gravava QUALQUER string de até 10 chars no campo que o front aplica direto",
        _lgBad.json?.ok === true && _lgBadSt?.language !== "xx-HACK" && _lgBadSt?.language !== "xx" &&
        _lgOk.json?.ok === true && _lgOkSt?.language === "pt",
        JSON.stringify({ bad: _lgBadSt?.language, ok: _lgOkSt?.language }));

      const _appF6 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _admF6 = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      check("🚨 v177-FIX6 (estrutural): checkShowCvPrompt e checkWppRequired não dependem mais de 'h2b_terms_session' (gravado SÓ no cadastro) — em login normal os dois voltam a rodar; a proteção contra aparecer por cima dos Termos continua sendo o próprio terms-overlay",
        (_appF6.match(/if\(!sessionStorage\.getItem\("h2b_terms_session"\)\)\s*return;/g) || []).length === 0 &&
        _appF6.includes('const termsOverlay=document.getElementById("terms-overlay");'),
        "algum dos dois ainda exige a chave de sessão do cadastro pra aparecer");
      check("🚨 v177-FIX6 (estrutural): o convite de currículo não nasce mais por cima do editor de perfil já aberto, e o aviso de WhatsApp é cobrado assim que o convite é fechado no 'Agora não' (antes rodava 1 vez só, aos 2,5s, e desistia se o convite estivesse na tela)",
        _appF6.includes('const _edAberto=document.getElementById("modal");') &&
        _appF6.includes("setTimeout(()=>{try{checkWppRequired();}catch(e){}},300);"),
        "proteção do editor aberto ou a 2ª chance do aviso de WhatsApp sumiram");
      check("🚨 v177-FIX6 (estrutural): doLogout limpa também o sessionStorage — em aparelho/aba compartilhado a Conta B herdava o 'já pulei o convite de currículo' da Conta A e nunca via o convite, com zero perfil",
        _appF6.includes('["h2b_cv_prompt_pulado","h2b_terms_session","h2bNovaConta"].forEach(k=>{try{sessionStorage.removeItem(k);}catch(e){}})'),
        "logout ainda deixa as chaves de sessão da conta anterior no aparelho");
      check("🚨 v177-FIX6 (estrutural): rótulos honestos no painel — o toggle de aviso de compra dispara COM OU SEM comprovante (o rótulo prometia escopo menor) e o motivo do cancelamento diz que o usuário vê o texto ao abrir o site, sem aviso automático (pushToUser é no-op nesta reconstrução)",
        _admF6.includes("pedido novo (com ou sem comprovante)") &&
        _admF6.includes("NÃO manda aviso automático"),
        "rótulo do toggle ou o aviso do cancelamento voltaram a prometer o que o sistema não faz");

      // ═══ 🚨 v177-FIX7: DUPLA ATIVAÇÃO sob concorrência DE VERDADE ═══
      // A guarda (pd.ativadoEm) depende de NÃO existir await entre a checagem
      // e a gravação. Isso era só uma leitura do código — nenhum teste provava
      // com 2 requisições vivas ao mesmo tempo no MESMO pedido (é dinheiro:
      // aprovar 2× credita os dias e a entrada no caixa em dobro).
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "dupativa@test.com", name: "Dup Ativa" });
      const _daPed = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Dup Ativa", userWhatsapp: "11 99999", userCity: "SP", comprovante: Buffer.from("dup-ativa-unico").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _daP1 = reqSlow("PATCH", "/api/pedido/" + _daPed.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" }, 400);
      await new Promise((r) => setTimeout(r, 150));
      const _daP2 = await req2("PATCH", "/api/pedido/" + _daPed.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
      const _daR1 = await _daP1;
      const _daOks = [_daR1, _daP2].filter((r) => r.json?.ok === true).length;
      const _daBarrado = [_daR1, _daP2].find((r) => r.status === 409);
      const _daDet = (await get("/api/pedido/" + _daPed.json?.pedidoId)).json;
      const _daCaixa = ((await get("/api/admin/financeiro")).json?.pagamentos || []).filter((x) => x.pedidoId === _daPed.json?.pedidoId && x.tipo !== "ajuste");
      check("🚨 v177-FIX7: 2 aprovações CONCORRENTES do MESMO pedido (os 2 sócios clicando junto, rede lenta) — uma ativa, a outra leva 409 jaAtivado, os dias entram UMA vez e o caixa recebe UM lançamento só",
        _daOks === 1 && !!_daBarrado && _daBarrado.json?.jaAtivado === true &&
        _daCaixa.length === 1 && (_daDet?.usuario?.diasRestantes || 0) <= 31 && (_daDet?.usuario?.diasRestantes || 0) >= 29,
        JSON.stringify({ oks: _daOks, barrado: _daBarrado?.status, caixa: _daCaixa.length, dias: _daDet?.usuario?.diasRestantes }).slice(0, 180));

      const _confBad = await req2("POST", "/api/email/confirmar", { email: "ninguem-pediu-codigo@gmail.com", codigo: "123456" });
      check("🚨 v177-FIX7: código de cadastro que 'sumiu' explica a causa REAL (o site reiniciou — os códigos vivem só na memória e este repo faz deploy a cada commit) em vez de um 'peça um código novo' sem motivo",
        _confBad.status === 400 && /reiniciado/i.test(_confBad.json?.error || "") && /formulário continua preenchido/i.test(_confBad.json?.error || ""),
        (_confBad.json?.error || "").slice(0, 140));

      const _srvF7 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🚨 v177-FIX7 (estrutural): aviso de compra que falha pra UM dos sócios fica gravado NO PEDIDO (avisoFalhas) + erro alto no log — antes, com o outro sócio recebendo, a rodada era dada por boa e quem ficou sem aviso não tinha como saber",
        _srvF7.includes("DB_PEDIDOS[_iF].avisoFalhas=_falhasN.map") && _srvF7.includes("AVISO NÃO CHEGOU pra"),
        "falha de aviso por destinatário voltou a morrer num console.warn");

      // ═══ 🚨 v177-FIX8 (8ª leva): plano LEGADO (vip.expiresAt único) e
      // rótulo honesto do plano. Os ramos de compatibilidade de
      // isManualVipActive/isAutoVipActive (que leem vip.active + vip.expiresAt
      // + vip.plan, sem manualExpires/autoExpires) nunca tinham sido exercidos
      // por teste nenhum — nenhuma fixture usava vip.expiresAt. ═══
      const _legFut = Date.now() + 30 * 86400_000;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legpro@test.com", name: "Legado Pro", vip: { active: true, expiresAt: _legFut, plan: "pro" }, plan: "pro" });
      const _legProSt = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legvip@test.com", name: "Legado Vip", vip: { active: true, expiresAt: _legFut, plan: "vip" }, plan: "vip" });
      const _legVipSt = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legvipro@test.com", name: "Legado Vipro", vip: { active: true, expiresAt: _legFut, plan: "vipro" }, plan: "vipro" });
      const _legVproSt = (await get("/api/status")).json;
      check("🚨 v177-FIX8: plano LEGADO (vip.expiresAt único, sem manualExpires/autoExpires) respeita a separação manual×automático — 'pro' = só automático (0 manuais/dia), 'vip' = só manual, 'vipro' = os dois; ramos de compatibilidade que nunca tinham sido testados",
        _legProSt?.manualLimit === 0 && _legProSt?.autoLimit === 200 && _legProSt?.vip?.manualActive === false && _legProSt?.vip?.autoActive === true &&
        _legVipSt?.manualLimit === 200 && _legVipSt?.autoLimit === 0 && _legVipSt?.vip?.autoActive === false &&
        _legVproSt?.manualLimit === 200 && _legVproSt?.autoLimit === 200,
        JSON.stringify({ pro: [_legProSt?.manualLimit, _legProSt?.autoLimit], vip: [_legVipSt?.manualLimit, _legVipSt?.autoLimit], vipro: [_legVproSt?.manualLimit, _legVproSt?.autoLimit] }));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

      const _appF8 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🚨 v177-FIX8 (estrutural): o badge de plano do Perfil usa planBadgeHTML() (fonte única, honesta: ⭐ VIP e/ou 🤖 Pro pelo que está REALMENTE ativo) — antes rotulava pelo NOME do plano, e quem só tinha automático via '⭐🤖 VIPro' com 0 envios manuais por dia",
        _appF8.includes("const _pb=g(\"#prof-plan-badges\");\n  if(_pb)_pb.innerHTML=planBadgeHTML();") &&
        !/planLabels=\{free:"Free",vip:"⭐ VIP",vipro:"⭐🤖 VIPro"/.test(_appF8),
        "o badge do Perfil voltou a rotular pelo nome do plano, com mapa próprio");
      check("🚨 v177-FIX8 (estrutural): mismatch de conta Google no Conectar-Gmail registra no authTimeline do DONO (antes ia pro e-mail digitado por engano, que quase nunca existe em DB_USERS — o raio-X do dono nunca via nada) e revoke que falha deixa rastro em vez de só um console.warn",
        _srvF7.includes('_authEvent(ownerEmailCS,"revoke_mismatch"') && _srvF7.includes('_authEvent(ownerEmailCS,"revoke_falhou"'),
        "trilha do revoke pós-mismatch voltou pro e-mail errado / sumiu");
    }
    // Comprovante já usado (fingerprint) — mesma trilha do MC5-P1, sem
    // duplicar setup: cria um 2º usuário VIP com Gmail conectado e tenta
    // mandar candidatura pro e-mail que o fixture já marcou como bounce.
    {
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "bounce177user@test.com", name: "Bounce177", refreshToken: "rt-bounce177-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: 0, plan: "vip", active: true }, plan: "vip" });
      const _sendBounce = await req2("POST", "/api/send", { to: "bounce177@empresa-invalida.com", subject: "Application", message: "Olá, gostaria de me candidatar." });
      check("🚨 v177-FIX2: /api/send RECUSA (400) mandar candidatura MANUAL pra e-mail com bounce já conhecido (DB_INVALID_EMAILS) — antes só o robô automático pulava esses, o manual gastava o limite diário à toa",
        _sendBounce.status === 400 && !!_sendBounce.json?.error, JSON.stringify({ status: _sendBounce.status, error: _sendBounce.json?.error }));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }
    // Coleta do DOL: statusPainel().coleta.published tem que refletir a
    // publicação real (antes ficava sempre undefined, mesmo após publicar) —
    // check estrutural (o fluxo completo de coleta real via feed falso já é
    // provado à parte pelos robôs H-2A/mensal existentes; aqui só garante
    // que o campo novo lê a MESMA fonte que coleta-publish grava).
    {
      const _planSrc2 = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
      const _planStatus = await get("/api/admin/planilhas/status");
      check("🚨 v177-FIX2: statusPainel().coleta já sai com o campo `published` presente mesmo sem coleta nenhuma rodada ainda (key=null → false, nunca undefined)",
        _planStatus.json?.coleta?.published === false, JSON.stringify(_planStatus.json?.coleta));
      check("🚨 v177-FIX2 (estrutural): coleta.published lê getMeta()[dolColeta.key] — a MESMA fonte que coleta-publish grava (antes o campo não existia, então o admin.html sempre mostrava 'em rascunho' mesmo depois de publicar com sucesso)",
        _planSrc2.replace(/\s/g, "").includes("published:dolColeta.key?(getMeta()[dolColeta.key]?.published===true):false"),
        "coleta.published não lê getMeta()[dolColeta.key]");
    }

    // ═══ 🤖 v177 (dono, 14/09/2026 — "implementar a leitura real por IA
    // agora"): a análise por Gemini estava 100% morta em produção (achado
    // MAIS grave da auditoria — o site promete verificação automática que
    // nunca rodava com tráfego real). Implementada de verdade agora; o
    // smoke test nunca chama o Gemini pela rede (continua 100% offline) —
    // exercita a lógica PURA de montar a pergunta e ler a resposta via o
    // gancho /api/test/gemini-check, com respostas do Gemini SIMULADAS. ═══
    {
      const _gReqPng = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { comprovante: "data:image/png;base64,QUJD", valorTotal: 100 } });
      check("🤖 v177: monta o pedido pro Gemini extraindo mime/base64 de um data-URL (image/png)",
        _gReqPng.json?.reqBody?.contents?.[0]?.parts?.[1]?.inline_data?.mime_type === "image/png" &&
        _gReqPng.json?.reqBody?.contents?.[0]?.parts?.[1]?.inline_data?.data === "QUJD" &&
        typeof _gReqPng.json?.reqBody?.contents?.[0]?.parts?.[0]?.text === "string" && _gReqPng.json.reqBody.contents[0].parts[0].text.length > 20 &&
        _gReqPng.json?.reqBody?.generationConfig?.responseSchema?.required?.includes("legivel"),
        JSON.stringify(_gReqPng.json?.reqBody?.contents?.[0]?.parts?.[1]));
      const _gReqPdf = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { comprovante: "QUJD", comprovanteType: "application/pdf", valorTotal: 100 } });
      check("🤖 v177: sem data-URL, usa comprovanteType como mime (aceita PDF cru, não só imagem)",
        _gReqPdf.json?.reqBody?.contents?.[0]?.parts?.[1]?.inline_data?.mime_type === "application/pdf" && _gReqPdf.json?.reqBody?.contents?.[0]?.parts?.[1]?.inline_data?.data === "QUJD",
        JSON.stringify(_gReqPdf.json?.reqBody?.contents?.[0]?.parts?.[1]));

      const _gConfere = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { valorTotal: 150 }, respBody: { candidates: [{ content: { parts: [{ text: JSON.stringify({ legivel: true, valor: 150, data: "14/09/2026", hora: "10:32", pagador: "Fulano de Tal", recebedor: "H2BApply", instituicao: "Banco X", transacaoId: "E2E123456789ABC" }) }] } }] } });
      check("🤖 v177: valor lido BATE com o pedido → CONFERE (o código decide, não a IA — matemática determinística)",
        _gConfere.json?.pc?.veredito === "CONFERE" && _gConfere.json?.pc?.bateComEsperado === true && _gConfere.json?.pc?.valorLido === 150 && _gConfere.json?.pc?.pagadorLido === "Fulano de Tal" && _gConfere.json?.pc?.transacaoIdLida === "E2E123456789ABC",
        JSON.stringify(_gConfere.json?.pc));

      const _gDiverge = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { valorTotal: 150 }, respBody: { candidates: [{ content: { parts: [{ text: JSON.stringify({ legivel: true, valor: 80 }) }] } }] } });
      check("🤖 v177: valor lido NÃO bate com o pedido → DIVERGENCIA",
        _gDiverge.json?.pc?.veredito === "DIVERGENCIA" && _gDiverge.json?.pc?.bateComEsperado === false && _gDiverge.json?.pc?.valorLido === 80, JSON.stringify(_gDiverge.json?.pc));

      const _gIlegivel = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { valorTotal: 150 }, respBody: { candidates: [{ content: { parts: [{ text: JSON.stringify({ legivel: false }) }] } }] } });
      check("🤖 v177: IA marca ilegível → ILEGIVEL, sem valorLido nenhum (nunca chuta número)", _gIlegivel.json?.pc?.veredito === "ILEGIVEL" && _gIlegivel.json?.pc?.valorLido === null, JSON.stringify(_gIlegivel.json?.pc));

      const _gErro = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { valorTotal: 150 }, respBody: {} });
      check("🤖 v177: resposta do Gemini vazia/sem candidates → ERRO (nunca trava, nunca inventa)", _gErro.json?.pc?.veredito === "ERRO" && _gErro.json?.pc?.valorLido === null, JSON.stringify(_gErro.json?.pc));

      const _gQuebrado = await req2("POST", "/api/test/gemini-check", { token: TEST_TOKEN, pedido: { valorTotal: 150 }, respBody: { candidates: [{ content: { parts: [{ text: "isso não é JSON nenhum" }] } }] } });
      check("🤖 v177: resposta que não é JSON válido → ERRO (nunca lança exceção pro chamador)", _gQuebrado.json?.pc?.veredito === "ERRO", JSON.stringify(_gQuebrado.json?.pc));

      const _srcGem = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🤖 v177: (estrutural) a suíte NUNCA alcança o caminho real do Gemini — o gancho de teste retorna antes disso, e o próprio código comenta essa garantia",
        _srcGem.includes("(o gancho de teste NUNCA cai pro caminho real do Gemini abaixo") && _srcGem.includes('if(!process.env.GEMINI_API_KEY){'),
        "guarda de isolamento do teste sumiu do código");
    }

    // ═══ 🛡️ v79 (Diego, 29/07 — áudio no WhatsApp: "ativei DoublePro pro
    // Esdras várias vezes e não entra, volta pro VipPro") ═══
    // CAUSA RAIZ: /api/admin/set-plan chamava addManualVipDays/addAutoVipDays
    // (que leem e gravam manualExpires/autoExpires atualizados) e DEPOIS
    // sobrescrevia o vip inteiro com um snapshot tirado ANTES dessas duas
    // chamadas — apagando silenciosamente os +30 dias que tinham acabado de
    // ser gravados. Corrigido: relê o usuário DEPOIS de addManualVipDays/
    // addAutoVipDays antes do setUser final. Este teste reproduz o cenário
    // exato: usuário com VipPro real e válido, admin faz upgrade pra
    // DoublePro — o autoExpires TEM que refletir os +30 dias novos, não
    // ficar travado na data antiga.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "esdras@test.com", name: "Esdras" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const setVipro = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "vipro" });
    check("🛡️ v79: set-plan ativa VipPro pra Esdras (estado inicial, igual o caso real)", setVipro.json?.ok === true, setVipro.body.slice(0, 140));
    const liveBefore = await get("/api/admin/live");
    const esdrasBefore = (liveBefore.json?.users || []).find((u) => u.email === "esdras@test.com");
    const autoExpiresAntes = esdrasBefore?.vip?.autoExpires || 0;
    check("🛡️ v79: Esdras está com VipPro ativo e autoExpires no futuro (~30d)", esdrasBefore?.plan === "vipro" && autoExpiresAntes > Date.now() + 25 * 86400_000, JSON.stringify({ plan: esdrasBefore?.plan, autoExpires: autoExpiresAntes }));
    // upgrade pra DoublePro — igual o Diego tentou fazer várias vezes
    const setDouble = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "doublepro" });
    check("🛡️ v79: set-plan aceita o upgrade pra DoublePro", setDouble.json?.ok === true, setDouble.body.slice(0, 140));
    const liveAfter = await get("/api/admin/live");
    const esdrasAfter = (liveAfter.json?.users || []).find((u) => u.email === "esdras@test.com");
    check("🛡️ v79: DoublePro aparece pro admin logo depois de ativar (não volta pro VipPro)", esdrasAfter?.plan === "doublepro", JSON.stringify({ plan: esdrasAfter?.plan }));
    check("🛡️ v79: autoExpires foi EXTENDIDO pelos +30d novos, não ficou travado na data antiga do VipPro",
      esdrasAfter?.vip?.autoExpires > autoExpiresAntes + 25 * 86400_000,
      JSON.stringify({ antes: autoExpiresAntes, depois: esdrasAfter?.vip?.autoExpires, diffDias: Math.round(((esdrasAfter?.vip?.autoExpires || 0) - autoExpiresAntes) / 86400_000) }));
    // confirma pelo lado do PRÓPRIO usuário também (mesma checagem dupla do v77)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "esdras@test.com" });
    const stEsdras = await get("/api/status");
    check("🛡️ v79: /api/status do próprio Esdras também mostra DoublePro (nunca diverge do que o admin vê)", stEsdras.json?.plan === "doublepro" && stEsdras.json?.vip?.active === true, JSON.stringify({ plan: stEsdras.json?.plan }));
    // 🚨 ordem do dono (29/07, direto após o caso Esdras): quem tem DoublePro
    // tem que ter EXATAMENTE os limites de DoublePro — antes desse fix, esse
    // usuário ficava com plan:"free" (0 de tudo). v218: ativação NOVA via
    // set-plan carimba a tabela nova (Máximo = 50 manual + 300 auto).
    check("🚨 v79+v218: Esdras com Máximo novo tem EXATAMENTE 50 manual + 300 automático (tabela v218 carimbada na ativação)",
      stEsdras.json?.manualLimit === 50 && stEsdras.json?.autoLimit === 300,
      JSON.stringify({ manualLimit: stEsdras.json?.manualLimit, autoLimit: stEsdras.json?.autoLimit }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 💳 v141 (dono, 15/08 — "esse Cleiton e também o outro ali, eu sei
    // que nenhum dos 2 tem todos esses dias de plano. algo deu errado!") ═══
    // CAUSA RAIZ achada revisando o próprio código: /api/admin/set-plan era
    // a ÚNICA rota que soma dias de VIP SEM trava de clique duplo/retry
    // (vip/activate já tinha desde o v18-FIX). O comentário "caso Cleiton"
    // de 11/07 já estava no código (disco cheio engolindo o plano) — mas só
    // resolvia o SINTOMA (sumir do disco); a causa de "dias A MAIS" nunca
    // tinha trava. Reproduz o cenário exato: mesmo admin, MESMO plano,
    // 2 cliques em sequência no mesmo usuário.
    const cleiton1 = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "vip" });
    check("💳 v141: 1º clique em set-plan funciona normalmente", cleiton1.json?.ok === true, cleiton1.body.slice(0, 140));
    const cleiton2 = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "vip" });
    check("💳 v141: 2º clique NO MESMO plano é BLOQUEADO (409) — nunca mais empilha dias sem querer (o próprio caso Cleiton)",
      cleiton2.status === 409 && cleiton2.json?.duplicate === true, `status=${cleiton2.status} body=${cleiton2.body.slice(0, 140)}`);
    // Mas o upgrade LEGÍTIMO pro PLANO DIFERENTE (o cenário real do v79,
    // Diego escalando VipPro→DoublePro pro Esdras em segundos) PRECISA
    // continuar passando — já provado pelas checagens v79 acima, que rodam
    // ANTES desta seção e continuam 100% verdes.
    // A trava de 5s barra o clique-colado, mas o Cleiton real (11/07) foi o
    // admin voltando a clicar MINUTOS depois, achando que a 1ª não tinha
    // ido (aviso de disco cheio) — isso a trava de 5s NÃO pega sozinha.
    // Espera a trava expirar e repete a MESMA concessão pra simular esse
    // retorno — é aqui que o DETECTOR na Conferência precisa entrar.
    await new Promise((r) => setTimeout(r, 5300));
    const cleiton3 = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "vip" });
    check("💳 v141: (setup) 3ª tentativa passa da trava de 5s e se repete — reproduz o retorno minutos depois do caso Cleiton", cleiton3.json?.ok === true, cleiton3.body.slice(0, 140));
    const cleitonDup = await get("/api/admin/conferencia");
    const _cleitonDivs = (cleitonDup.json?.divergencias || []).filter((d) => d.tipo === "concessoes_duplicadas" && d.email === "esdras@test.com");
    check("💳 v141: a Conferência DETECTA a duplicata sozinha (2 concessões do MESMO plano em minutos) — teria achado o caso Cleiton na hora",
      _cleitonDivs.length >= 1, JSON.stringify(_cleitonDivs.slice(0, 1)));
    check("💳 v141: a divergência NÃO aparece pro upgrade legítimo VipPro→DoublePro (planos diferentes) — sem lobo em falso",
      !(cleitonDup.json?.divergencias || []).some((d) => d.tipo === "concessoes_duplicadas" && d.msg?.includes("doublepro")),
      "achou divergência falsa pro upgrade legítimo");

    // GET /api/admin/financeiro-usuario/:email — a ficha única por usuário
    // (antes espalhada em 5 rotas: user-detail, pedidos filtrados no
    // cliente, diamonds/user, audit sem filtro, creditos só via /pedido/:id).
    const finU = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("esdras@test.com"));
    check("💳 v141: financeiro-usuario junta plano, reconciliação, pedidos, créditos, auditoria e uso — tudo num lugar só",
      finU.json?.ok === true &&
      Array.isArray(finU.json?.creditos) && finU.json.creditos.length >= 3 && // vip.creditos agora recebe TAMBÉM do set-plan (antes só vip/activate/pedido/diamante)
      Array.isArray(finU.json?.auditoria) && finU.json.auditoria.length >= 3 &&
      Array.isArray(finU.json?.reconciliacao?.duplicacoes) && finU.json.reconciliacao.duplicacoes.length >= 1 &&
      typeof finU.json?.uso?.manualLimit === "number",
      JSON.stringify({ plano: finU.json?.plano?.atual, creditos: finU.json?.creditos?.length, auditoria: finU.json?.auditoria?.length, dup: finU.json?.reconciliacao?.duplicacoes?.length }).slice(0, 300));
    const finU404 = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("ninguem-existe-aqui@test.com"));
    check("💳 v141: e-mail inexistente devolve 404 limpo (nunca quebra a tela)", finU404.status === 404, `status=${finU404.status}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "esdras@test.com" });
    const finU403 = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("esdras@test.com"));
    check("💳 v141: usuário comum recebe 401/403 (admin-only — dado financeiro sensível)", [401, 403].includes(finU403.status), `status=${finU403.status}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 🎯 v82 (ordem do dono, 29/07/2026 — "IA sugerindo as vagas com mais
    // chance pra cada um", prioridade #1 da casa): MATCH DE VAGA. Pontua cada
    // vaga pelo encaixe com o perfil do candidato (categoria preferida,
    // estado do perfil, texto batendo com experiência/inglês) — na busca
    // manual (/api/sheet-meta) E na fila automática (/api/auto/start). ═══
    // 🔒 v172: este bloco é sobre matchScore na fila automática, não sobre o
    // gate de plano/Gmail novo — semeia os 2 pra chegar na parte testada.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "matchtest@test.com", name: "Match Test", refreshToken: "rt-matchtest-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "doublepro" }, plan: "doublepro" });
    // Sem preferência ainda: pega a categoria do 1º resultado de uma planilha real.
    const smBase = await get("/api/sheet-meta?sheet=jan2026&email=0&top=5");
    const _jobsBase = smBase.json?.jobs || [];
    check("🎯 v82: /api/sheet-meta expõe matchScore pra usuário logado (nunca null pra quem tem sessão)", _jobsBase.length > 0 && _jobsBase.every((j) => j.matchScore != null), JSON.stringify(_jobsBase.map((j) => j.matchScore)));
    const _alvo = _jobsBase[0];
    const _scoreAntes = _alvo?.matchScore;
    // Preferência de categoria = a categoria EXATA do próprio job alvo — depois confere que o MESMO job subiu de nota.
    await req2("POST", "/api/settings", { h2bProfile: { preferredArea: _alvo.category, englishLevel: "basic", experiencedH2B: false, h2bSeasons: 0, usaTrips: false, hasDriverLicense: false, availability: "immediate" } });
    const smDepois = await get("/api/sheet-meta?sheet=jan2026&email=0&top=5");
    const _alvoDepois = (smDepois.json?.jobs || []).find((j) => j.id === _alvo.id);
    check("🎯 v82: setar preferredArea igual à categoria da vaga AUMENTA o matchScore dessa vaga específica (mesma vaga, antes x depois)",
      _alvoDepois && _alvoDepois.matchScore > _scoreAntes,
      JSON.stringify({ antes: _scoreAntes, depois: _alvoDepois?.matchScore, categoria: _alvo.category }));
    check("🎯 v82: matchWhy explica o motivo (nunca uma caixa preta)", Array.isArray(_alvoDepois?.matchWhy) && _alvoDepois.matchWhy.some((w) => w.includes("categoria")), JSON.stringify(_alvoDepois?.matchWhy));
    // sort=match: a página inteira vem em ordem NÃO-crescente de matchScore.
    const smMatchSort = await get("/api/sheet-meta?sheet=jan2026&email=0&top=25&sort=match");
    const _scores = (smMatchSort.json?.jobs || []).map((j) => j.matchScore);
    let _ordenado = true;
    for (let i = 0; i < _scores.length - 1; i++) if (_scores[i] < _scores[i + 1]) _ordenado = false;
    check("🎯 v82: sort=match devolve a página em ordem decrescente de matchScore", _scores.length > 1 && _ordenado, JSON.stringify(_scores));
    // 🐢 v162 (dono, 24/08: "site está completamente lento, não é internet"):
    // o comparador do sort=match recalculava computeJobMatchScore() DENTRO
    // do Array.sort — 2x por comparação, sem cache — travando o processo
    // (single-thread) inteiro a cada busca "🎯 Melhor pra mim" com as
    // planilhas reais (milhares de vagas). Guarda ESTRUTURAL: o padrão tem
    // que ser "calcula 1x por item, guarda, ordena pelo valor guardado"
    // (decorate-sort-undecorate) — o MESMO padrão já correto do
    // orderQueueSmart — nunca mais computeJobMatchScore dentro do comparador.
    {
      const _srv162 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _blocoMatch = _srv162.slice(_srv162.indexOf('sort==="match" && matchCtx'), _srv162.indexOf('sort==="match" && matchCtx') + 400);
      check("🐢 v162: (estrutural) sort=match NUNCA recalcula o score dentro do comparador — calcula 1x por item (map), guarda, ordena pelo valor guardado",
        !/\.sort\(\(a,\s*b\)\s*=>\s*\(?computeJobMatchScore/.test(_blocoMatch) &&
        /\.map\(r=>\(\{r,sc:computeJobMatchScore/.test(_blocoMatch) &&
        /\.sort\(\(a,b\)=>b\.sc-a\.sc\)/.test(_blocoMatch),
        "sort=match ainda recalcula score no comparador (regressão de performance)");
    }

    // Fila automática: 10 vagas de uma categoria "preferida" + 10 de outra,
    // todas com empregador NOVO (contagem global 0 → mesma faixa da fila
    // esperta) — só o match score decide a ordem dentro da faixa.
    const pdfB64Match = Buffer.from("%PDF-1.4 " + "match ".repeat(300)).toString("base64");
    const upMatch = await req2("POST", "/api/cv/upload", { base64: pdfB64Match, name: "Curriculo_Match.pdf", cvType: "resume" });
    const _queueMatch = [];
    for (let i = 0; i < 10; i++) _queueMatch.push({ to: `pref-${i}@matchtest-fila.com`, title: "Vaga Preferida", company: "Empresa Pref", category: "landscape", state: "FL" });
    for (let i = 0; i < 10; i++) _queueMatch.push({ to: `outra-${i}@matchtest-fila.com`, title: "Vaga Outra", company: "Empresa Outra", category: "construction", state: "TX" });
    await req2("POST", "/api/settings", { h2bProfile: { preferredArea: "landscape", englishLevel: "basic", experiencedH2B: false, h2bSeasons: 0, usaTrips: false, hasDriverLicense: false, availability: "immediate" } });
    const asMatch = await req2("POST", "/api/auto/start", { queue: _queueMatch, resumeIdx: upMatch.json?.cv?.idx, subjects: ["x"], emailBodies: ["y"] });
    check("🎯 v82: (setup) fila sintética de 20 vagas iniciou ok", asMatch.json?.ok === true, asMatch.body.slice(0, 160));
    const stMatch = await get("/api/auto/status");
    const _cats = stMatch.json?.queueCategories || [];
    check("🎯 v82: fila esperta prioriza a categoria do perfil (landscape) — mesma faixa de contato (0), só o match decide, sem sobreposição possível (score 60-80 vs 40-60)",
      _cats.length >= 20 && _cats.slice(0, 10).every((c) => c === "landscape"),
      JSON.stringify(_cats));

    // ═══ 🔍 v173 (ORDEM DO DONO, 13/09/2026 — reset TOTAL dos filtros): motor
    // único de facetas (mod-filtros.js) + /api/vagas/filtros + UI nova. As
    // regras inegociáveis: E entre dimensões, OU dentro, contagem por opção
    // calculada com os OUTROS filtros aplicados, contagem = verdade da lista,
    // dimensão sem dado na planilha honesta, gate Double Pro no servidor. ═══
    {
      const vf0 = (await get("/api/vagas/filtros?sheet=jan2026&email=0")).json;
      check("🔍 v173: /api/vagas/filtros sem filtro → total = planilha inteira, facetas de estado/categoria/salário presentes",
        vf0?.ok === true && vf0.total === vf0.totalPlanilha && vf0.total > 1000 && vf0.facetas?.estado?.length > 5 && vf0.facetas?.categoria?.length > 3 && Array.isArray(vf0.facetas?.salario?.limiares),
        JSON.stringify({ total: vf0?.total, planilha: vf0?.totalPlanilha }).slice(0, 120));
      const e1 = vf0.facetas.estado[0], e2 = vf0.facetas.estado[1];
      const vf1 = (await get(`/api/vagas/filtros?sheet=jan2026&email=0&estado=${encodeURIComponent(e1.v)}`)).json;
      check("🔍 v173: 1 estado marcado → total = contagem daquela opção (a contagem por opção é a verdade)", vf1.total === e1.n, `${vf1.total} vs ${e1.n}`);
      const vf2 = (await get(`/api/vagas/filtros?sheet=jan2026&email=0&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}`)).json;
      check("🔍 v173: 2 estados = OU (soma) — marcar uma 2ª opção do MESMO grupo nunca diminui", vf2.total === e1.n + e2.n && vf2.total >= vf1.total, `${vf2.total} vs ${e1.n}+${e2.n}`);
      check("🔍 v173: a faceta de estado ignora o próprio filtro de estado (contagem do 1º segue igual com 2 marcados)", vf2.facetas.estado.find(x => x.v === e1.v)?.n === e1.n, JSON.stringify(vf2.facetas.estado.slice(0, 2)));
      const cat = vf2.facetas.categoria.find(c => c.n > 0);
      const vf3 = (await get(`/api/vagas/filtros?sheet=jan2026&email=0&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}&categoria=${cat.v}`)).json;
      check("🔍 v173: estado + categoria = E — total = contagem da categoria DENTRO dos estados (um filtro nunca 'elimina' o outro, só combina)", vf3.total === cat.n && vf3.total <= vf2.total, `${vf3.total} vs ${cat.n}`);
      const l20 = vf3.facetas.salario.limiares.find(l => l.v === 20);
      const vf4 = (await get(`/api/vagas/filtros?sheet=jan2026&email=0&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}&categoria=${cat.v}&salarioMin=20`)).json;
      const sm4 = (await get(`/api/sheet-meta?sheet=jan2026&email=0&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}&categoria=${cat.v}&salarioMin=20&top=1`)).json;
      check("🔍 v173: salário ≥$20 → total = contagem do limiar E a LISTA (/api/sheet-meta) devolve o MESMO total — uma verdade só (13n)",
        vf4.total === l20.n && sm4.total === vf4.total, `facetas=${vf4.total} limiar=${l20.n} lista=${sm4.total}`);
      const smLegacy = (await get(`/api/sheet-meta?sheet=jan2026&email=0&state=${encodeURIComponent(e1.v)},${encodeURIComponent(e2.v)}&category=${cat.v}&minWage=20&top=1`)).json;
      check("🔍 v173: nomes LEGADOS de parâmetro (state/category/minWage — front antigo em cache) continuam funcionando na lista", smLegacy.total === vf4.total, `${smLegacy.total} vs ${vf4.total}`);
      const vfJ = (await get("/api/vagas/filtros?sheet=jul2026&email=0")).json;
      check("🔍 v173: jul2026 (Pending Processing) → disponibilidade honesta: salário=0, e-mail=0, cargo=0 — o front esconde/avisa em vez de mostrar '0 vagas' sem explicação",
        vfJ.disponibilidade?.salario === 0 && vfJ.disponibilidade?.email === 0 && vfJ.disponibilidade?.cargo === 0 && vfJ.total === vfJ.totalPlanilha, JSON.stringify(vfJ.disponibilidade).slice(0, 140));
      const vfJe = (await get("/api/vagas/filtros?sheet=jul2026&email=1")).json;
      check("🔍 v173: jul2026 com 'só com e-mail' → 0 (honesto), e a faceta diz quantas estão sem e-mail", vfJe.total === 0 && vfJe.facetas.email.sem === vfJ.totalPlanilha, JSON.stringify(vfJe.facetas.email));
      // 🛡️ v276 (bug real do dono, 23/09/2026: "vagas aparecem com o e-mail do
      // empregador oculto — TODA vaga real tem e-mail, isso nunca deveria
      // acontecer"). Antes, PARÂMETRO AUSENTE caía em "mostra tudo" — a única
      // proteção era o padrão do CLIENTE (frágil: localStorage antigo,
      // chamada direta à API, loadTabCounts() que nem manda o parâmetro).
      // Prova aqui: SEM email nenhum na query (nem 0 nem 1) o SERVIDOR
      // esconde sozinho — igual a pedir email=1 explícito.
      const vfJdef = (await get("/api/vagas/filtros?sheet=jul2026")).json;
      const smJdef = (await get("/api/sheet-meta?sheet=jul2026&top=25")).json;
      check("🛡️ v276: parâmetro `email` AUSENTE (nem 0 nem 1) já esconde vaga sem e-mail por padrão — mesma proteção de email=1, sem depender do cliente mandar nada",
        vfJdef.total === 0 && smJdef.total === 0 && (smJdef.jobs || []).length === 0,
        JSON.stringify({ vfDef: vfJdef.total, smDef: smJdef.total, jobs: (smJdef.jobs || []).length }));
      check("🛡️ v276: email=0 EXPLÍCITO continua funcionando pra quem quer ver tudo de propósito (opt-out preservado)",
        vfJ.total === vfJ.totalPlanilha && vfJ.totalPlanilha === 2625, `vfJ.total=${vfJ.total} totalPlanilha=${vfJ.totalPlanilha}`);
      check("🛡️ v276: `email` não conta mais em ativos() — é padrão PROTETOR do app (igual ocultarEncerradas), não escolha do usuário",
        vfJdef.ativos === 0, `ativos=${vfJdef.ativos}`);
      const vfH = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0")).json;
      const mes = vfH.facetas.inicio.find(m => m.n > 0);
      const vfHm = (await get(`/api/vagas/filtros?sheet=h2a-jun2026&email=0&inicio=${mes.v}`)).json;
      check("🔍 v173: H-2A tem mês de início e cidade (disponibilidade > 0) e filtrar por mês bate com a contagem da faceta", vfH.disponibilidade.inicio > 0 && vfH.disponibilidade.cidade > 0 && vfHm.total === mes.n, `${vfHm.total} vs ${mes.n}`);
      const vfCb = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&cidadeBusca=spring")).json;
      check("🔍 v173: busca dentro da lista de cidades (cidadeBusca) filtra as opções no servidor", vfCb.facetas.cidade.length > 0 && vfCb.facetas.cidade.every(c => /spring/i.test(c.v)), JSON.stringify(vfCb.facetas.cidade.slice(0, 2)));
      // 💎 gate Double Pro no SERVIDOR: admin (DP) aplica grupo; usuário comum tem o parâmetro ignorado
      const gA = vfJ.facetas.grupo.find(x => x.v === "A");
      const vfGadm = (await get("/api/vagas/filtros?sheet=jul2026&email=0&grupo=A")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vffree@test.com", name: "VF Free" });
      const vfGfree = (await get("/api/vagas/filtros?sheet=jul2026&email=0&grupo=A")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      check("🔍 v173: 💎 grupo A–H é gate do SERVIDOR — admin/DoublePro filtra (total = contagem do grupo), usuário comum tem o parâmetro ignorado (total = planilha)",
        vfGadm.isDP === true && vfGadm.total === gA.n && vfGfree.isDP === false && vfGfree.total === vfJ.totalPlanilha, `adm=${vfGadm.total}/${gA?.n} free=${vfGfree.total}`);
      // 🚨 v177-FIX2 (auditoria 14/09/2026): o gate isDP já impedia o FILTRO
      // de status/grupo de restringir a lista pra quem não é DP (check
      // acima), mas a FACETA (distribuição/contagem por opção — dado
      // exclusivo de verdade) era calculada e devolvida SEMPRE, mesmo pro
      // usuário grátis — só o front escondia atrás do cadeado.
      check("🚨 v177-FIX2: faceta de status/grupo (💎 DoublePro) só é calculada e devolvida no JSON quando isDP===true — usuário comum não recebe mais esse dado exclusivo (nem escondido no front, ausente na resposta)",
        Array.isArray(vfGadm.facetas?.grupo) && vfGadm.facetas.grupo.length > 0 && vfGfree.facetas?.grupo === undefined && vfGfree.facetas?.status === undefined,
        JSON.stringify({ admGrupo: vfGadm.facetas?.grupo?.length, freeGrupo: vfGfree.facetas?.grupo, freeStatus: vfGfree.facetas?.status }));
      // rotas do sistema antigo morreram (nada de 2ª verdade)
      const mortas = [];
      for (const r of ["count-jobs", "sheet-facets", "sheet-titles", "sheet-categories", "my-availability"]) { const x = await get(`/api/${r}?sheet=jan2026`); if (x.status !== 404) mortas.push(`${r}=${x.status}`); }
      check("🔍 v173: as 5 rotas do sistema de filtros antigo foram REMOVIDAS (404) — count-jobs, sheet-facets, sheet-titles, sheet-categories, my-availability", mortas.length === 0, mortas.join(","));
      // motor offline: formato legado do job.filters (robô que já rodava antes do deploy) e invariantes
      const { createFiltros } = require(path.join(__dirname, "mod-filtros.js"));
      const F = createFiltros({ normalizeStateName: s => String(s || "").toUpperCase().trim(), normBusca: s => String(s || "").toLowerCase().trim(), cityMatchNormFn: () => null, regioes: {}, grupoDe: r => r.g || "", searchSheet: (arr) => ({ total: arr.length, items: arr }), categoriaLabel: k => k });
      const leg = F.parse({ state: "FLORIDA,TEXAS", category: "landscape", minWage: "18", titles: ["Cook"], beginMonths: [6, 7], grupos: "A,B", city: "Key West", minWorkers: "5", keyword: "hotel", dolStatus: "Certified" });
      check("🔍 v173: FILTROS.parse aceita o formato LEGADO do job.filters (state/category/minWage/titles/beginMonths/grupos/city/minWorkers/keyword) — robô que já rodava não perde o refill; dolStatus legado (v209: dimensão removida) é ACEITO e IGNORADO sem quebrar o parse",
        leg.estado.join() === "FLORIDA,TEXAS" && leg.categoria[0] === "landscape" && leg.salarioMin === 18 && leg.cargo[0] === "cook" && leg.inicio.join() === "6,7" && leg.grupo.join() === "A,B" && leg.cidade[0] === "Key West" && leg.vagasMin === 5 && leg.q === "hotel" && leg.status === undefined,
        JSON.stringify(leg).slice(0, 160));
      const rowsF = [{ c: "1", s: "FLORIDA", k: "food", w: "20", wunit: "h", e: "a@x.com", wk: 5 }, { c: "2", s: "FLORIDA", k: "food", w: "1500", wunit: "mo", e: "b@x.com", wk: 1 }, { c: "3", s: "TEXAS", k: "farm", w: "22", wunit: "h", e: "", wk: 10 }];
      const facF = F.facetas(rowsF, F.parse(new URLSearchParams({ estado: "FLORIDA", email: "0" })), {}); // 🛡️ v276: email=0 pra não filtrar a linha 3 (sem e-mail) — o teste é sobre salário/estado, não sobre o padrão novo
      check("🔍 v173: motor — salário normalizado pra $/hora (1500/mês ≈ $8,67/h fica abaixo de $12), faceta de e-mail conta com/sem, estado ignora o próprio filtro",
        facF.total === 2 && facF.facetas.salario.limiares.find(l => l.v === 12).n === 1 && facF.facetas.email.com === 2 && facF.facetas.email.sem === 0 && facF.facetas.estado.find(x => x.v === "TEXAS").n === 1,
        JSON.stringify({ t: facF.total, l12: facF.facetas.salario.limiares.find(l => l.v === 12), em: facF.facetas.email, tx: facF.facetas.estado }).slice(0, 200));
      // ═══ 🚨 v237 (achado de auditoria — Baixa, dormente até o DOL mandar um
      // SOC sujo): a família do cargo era `("soc:" + _famNorm(r.soc)) ||
      // _famNorm(t)` — concatenação de string NUNCA é falsy, então o
      // fallback pro título nunca disparava. SOC sujo (só pontuação, ex.:
      // "-") normaliza pra "" e virava a família fantasma "soc:" — juntando
      // vagas de CARGOS DIFERENTES no mesmo chip só por causa do SOC ruim.
      const rowsSoc = [
        { c: "10", s: "FLORIDA", k: "farm", t: "Farmworker", soc: "-", w: "18", wunit: "h", e: "a@x.com", wk: 5 },
        { c: "11", s: "FLORIDA", k: "farm", t: "Landscaper", soc: "-", w: "18", wunit: "h", e: "b@x.com", wk: 5 },
      ];
      const facSoc = F.facetas(rowsSoc, F.parse(new URLSearchParams()), {});
      check("🚨 v237: SOC sujo (\"-\", normaliza pra vazio) cai no TÍTULO — 2 vagas de cargos diferentes com o mesmo SOC ruim viram 2 chips separados, nunca a família fantasma 'soc:' juntando as duas",
        facSoc.facetas.cargo.length === 2 && facSoc.facetas.cargo.every(x => x.n === 1) && !facSoc.facetas.cargo.some(x => x.v === "soc:"),
        JSON.stringify(facSoc.facetas.cargo));
      // estrutural: fonte única no servidor + front novo sem resquício do antigo
      const _srv173 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _refill = _srv173.slice(_srv173.indexOf("function tryAutoRefill("), _srv173.indexOf("function tryAutoRefill(") + 2500);
      check("🔍 v173: (estrutural) lista, contagem e REFILL do robô usam o MESMO motor (FILTROS.filtrar + _excluirEnviadosFn) — nunca mais 3 cópias divergentes",
        /FILTROS\.parse\(job\.filters/.test(_refill) && /FILTROS\.filtrar\(/.test(_refill) && (_srv173.match(/FILTROS\.filtrar\(/g) || []).length >= 2 && (_srv173.match(/_excluirEnviadosFn\(/g) || []).length >= 3 && !/f\.beginMonths|wantOutros/.test(_refill),
        "refill/lista/contagem não convergem no motor único");
      const _app173 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _idx173 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      check("🔍 v173: (estrutural) front NOVO vivo (vfOpen/vfParams/vfSnapshotAuto/vfAutoCount, #vf-overlay, #btn-vf-manual, #vf-chips-auto) e o ANTIGO apagado (openMasterFilters, renderWizardCats, selectCat, master-filters-overlay, seletores q-estado/q-cidade, inputs af-*)",
        ["function vfOpen(", "function vfParams(", "function vfSnapshotAuto(", "async function vfAutoCount(", "function vfRenderChips("].every(f => _app173.includes(f)) &&
        ['id="vf-overlay"', 'id="btn-vf-manual"', 'id="vf-chips-auto"', 'id="vf-count-auto"', 'onclick="vfOpen(\'auto\')"'].every(f => _idx173.includes(f)) &&
        !/openMasterFilters|renderWizardCats|function selectCat\(|refreshAutoFilterCount|_mfCtxState|updateFilterCount|showAutoPreview/.test(_app173) &&
        !/master-filters-overlay|id="q-estado"|id="dl-estados"|id="af-state"|id="af-min-wage"|cat-chips-jobs/.test(_idx173),
        "resquício do sistema antigo ou peça nova faltando");
      check("🔍 v173: (i18n, regra 6f) as strings novas do painel existem nas 3 línguas (vf_apply, vf_zero, vf_no_salary, vf_meses…)",
        ["vf_apply", "vf_zero", "vf_no_salary", "vf_no_email_auto", "vf_meses", "vf_sec_categoria", "vf_ws2_sub"].every(k => (_app173.match(new RegExp(`"${k}":`, "g")) || []).length === 3),
        "chave vf_* faltando em alguma língua");
      check("🔍 v173: (estrutural) sort=wage usa a MESMA régua de $/hora do filtro (FILTROS.wageHora) com decorate-sort — nunca regex dentro do comparador",
        /FILTROS\.wageHora\(r\)\}\)\)\.sort\(\(a,b\)=>b\.w-a\.w\)/.test(_srv173) && !/const pw=r=>\{\s*if\(!r\.w\)return -1;/.test(_srv173), "sort=wage divergiu do motor");
    }

    // ═══ 🎯 v179 — LOTE 1: A CONTAGEM VOLTA A SER A VERDADE DA LISTA ═══
    // Ordem do dono (17/09/2026): "os filtros não podem falhar, não podem ser
    // mal feitos, precisam estar funcionando e ter um sentido — o usuário tem
    // que desfrutar 100%". Auditoria mediu, contra as planilhas empacotadas,
    // chip anunciando 217 e lista devolvendo 108; a mesma cidade em 3 chips;
    // vaga de $9,59/h virando $0,06/h. Todos os números abaixo foram MEDIDOS
    // no servidor real deste repositório (não copiados de relatório).
    {
      const vfH = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0")).json;
      // (1) valor de faceta é OPACO — valor COM vírgula não pode ser
      // re-quebrado pelo servidor.
      // ⚠️ ATUALIZADO no v181 LOTE 7: a faceta de cargo passou a emitir a
      // chave de FAMÍLIA, que por construção NÃO tem vírgula (é o título
      // normalizado sem pontuação) — não existe mais opção de cargo com
      // vírgula pra conferir. A regra continua valendo e é provada pelo
      // caminho que ainda tem vírgula de verdade: o título literal antigo
      // ("Farmworkers and Laborers, Crop, Nursery, and Greenhouse" salvo no
      // aparelho ou num job.filters de robô que já está rodando), que tem que
      // casar com a família inteira em vez de virar 4 pedaços soltos.
      const _titulosComVirgula = ["Farmworkers and Laborers, Crop, Nursery, and Greenhouse", "Farmworkers, Farm & Ranch Animals"];
      const paresVirg = [];
      for (const tl of _titulosComVirgula) {
        const sm = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&cargo=${encodeURIComponent(tl)}&top=1`)).json;
        const fam = (vfH.facetas.cargo || []).find((x) => String(x.label || "").toLowerCase() === tl.toLowerCase());
        paresVirg.push({ v: tl.slice(0, 30), faceta: fam ? fam.n : -1, lista: sm.total });
      }
      check("🎯 v179-L1: valor COM vírgula nunca é re-quebrado pelo servidor — o chip anunciava 217 e a lista devolvia 108 (v179); no v181 o cargo virou FAMÍLIA e o título literal com vírgula (valor legado) casa com a família inteira",
        paresVirg.length === 2 && paresVirg.every((p) => p.faceta > 0 && p.faceta === p.lista), JSON.stringify(paresVirg));
      const semVirg = (vfH.facetas.cargo || []).find((x) => x.n > 100);
      const smSV = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&cargo=${encodeURIComponent(semVirg.v)}&top=1`)).json;
      check("🎯 v179-L1: a opção que a faceta de cargo emite devolve exatamente o que ela anuncia (guarda do conserto acima)", smSV.total === semVirg.n, `${semVirg.v}: ${semVirg.n} vs ${smSV.total}`);

      // (2) parse(URL) e parse(objeto) — fila inicial do robô × refill
      const { createFiltros: _cfL1 } = require(path.join(__dirname, "mod-filtros.js"));
      const FL1 = _cfL1({ normalizeStateName: (s) => String(s || "").toUpperCase().trim(), normBusca: (s) => String(s || "").toLowerCase().trim(), cityMatchNormFn: (t) => { const q = String(t || "").toLowerCase().trim(); return q ? ((c) => c.includes(q)) : null; }, regioes: {}, grupoDe: (r) => r.g || "", searchSheet: (arr) => ({ total: arr.length, items: arr }), categoriaLabel: (k) => k });
      const divergem = [];
      for (const [dim, v] of [["cargo", "Cooks, Restaurant"], ["cidade", "Jenison, MI"]]) {
        const a = JSON.stringify(FL1.parse(new URLSearchParams([[dim, v]]))[dim]);
        const b = JSON.stringify(FL1.parse({ [dim]: [v] })[dim]);
        if (a !== b || JSON.parse(a).length !== 1) divergem.push(`${dim}: ${a} vs ${b}`);
      }
      check("🎯 v179-L1: parse(URL) e parse(objeto) produzem o MESMO filtro — a fila inicial do robô (URL) e o refill (job.filters) filtravam conjuntos diferentes e ninguém via, porque o robô roda sozinho",
        divergem.length === 0, divergem.join(" | "));
      check("🎯 v179-L1: formato legado CSV preservado onde o valor nunca tem vírgula (estado=TEXAS,FLORIDA → 2 itens) e repetição de parâmetro também",
        FL1.parse(new URLSearchParams([["estado", "TEXAS,FLORIDA"]])).estado.length === 2 && FL1.parse(new URLSearchParams([["estado", "TEXAS"], ["estado", "FLORIDA"]])).estado.length === 2,
        JSON.stringify(FL1.parse(new URLSearchParams([["estado", "TEXAS,FLORIDA"]])).estado));
      // (3) cidade: chave canônica cidade|ESTADO
      const vfLb = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&cidadeBusca=labelle")).json;
      const lbFl = (vfLb.facetas.cidade || []).find((c) => c.v === "labelle|FLORIDA");
      const smLb = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&cidade=${encodeURIComponent("labelle|FLORIDA")}&top=2000`)).json;
      // MEDIDO: 65 na Flórida (+1 Labelle/GEORGIA). O relatório da auditoria
      // dizia "1 chip de 66" — os 66 incluíam a vaga da GEÓRGIA, que é outra
      // cidade; a verdade é 65 + 1, e é isso que a tela passa a mostrar.
      // ⚠️ ATUALIZADO no v182 LOTE 8: o rótulo virou "Labelle". A limpeza na
      // gravação (limparCidade) passa o CAIXA ALTA pra Title Case, então as 11
      // linhas "LABELLE" viraram "Labelle" e essa grafia (23+11=34) passou a
      // ser a MAIS FREQUENTE, na frente de "LaBelle" (32). O que este check
      // guarda continua igual: UMA opção por cidade+estado, 65 na Flórida, a
      // da Geórgia separada e faceta === lista.
      check("🎯 v179-L1: cidade é LUGAR, não texto — 'LaBelle'/'Labelle'/'LABELLE' viravam 3 chips (32/23/11) e clicar qualquer um trazia 66 (com 1 da GEÓRGIA junto); agora 1 opção por cidade+estado, com rótulo na grafia mais comum",
        (vfLb.facetas.cidade || []).length === 2 && lbFl && lbFl.n === 65 && lbFl.label === "Labelle" && lbFl.estado === "FLORIDA" &&
        smLb.total === 65 && smLb.jobs.every((j) => j.state === "FLORIDA"),
        JSON.stringify(vfLb.facetas.cidade) + " lista=" + smLb.total);
      const vfAmes = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&cidadeBusca=ames")).json;
      const ames = (vfAmes.facetas.cidade || []).find((c) => c.v === "ames|IOWA");
      const smAmes = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&cidade=${encodeURIComponent("ames|IOWA")}&top=2000`)).json;
      check("🎯 v179-L1: marcar uma cidade não traz mais cidade de outro estado — 'Ames' casava por pedaço de texto e devolvia 24 (St James/LA, Lamesa/TX, Jamestown/ND, Amesbury/MA…); agora 12, todas Ames/IOWA",
        ames && ames.n === 12 && smAmes.total === 12 && smAmes.jobs.every((j) => j.state === "IOWA" && /^ames$/i.test(j.city || "")),
        `faceta ${ames && ames.n} lista ${smAmes.total} estados ${[...new Set(smAmes.jobs.map((j) => j.state))].join("/")}`);
      const divCid = [];
      for (const c of (vfH.facetas.cidade || []).slice(0, 30)) {
        const sm = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&cidade=${encodeURIComponent(c.v)}&top=1`)).json;
        if (sm.total !== c.n) divCid.push(`${c.v}: ${c.n}≠${sm.total}`);
      }
      check("🎯 v179-L1: varredura — nas 30 cidades mais comuns da H-2A, a contagem do chip é EXATAMENTE o que a lista devolve (antes ~500 das 2.569 opções mentiam)",
        divCid.length === 0 && (vfH.facetas.cidade || []).length >= 30, divCid.slice(0, 5).join(" | "));
      const regs = {};
      for (const nome of ["cape cod", "adirondacks", "vail", "outer banks"]) {
        const sm = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&cidade=${encodeURIComponent(nome)}&top=1`)).json;
        regs[nome] = { faceta: (vfH.facetas.regiao || []).find((r) => r.v === nome)?.n, lista: sm.total };
      }
      check("🎯 v179-L1: região turística continua funcionando (texto livre, casamento amplo) e faceta === lista — cape cod 10, adirondacks 30, vail 12, outer banks 11",
        regs["cape cod"].lista === 10 && regs["adirondacks"].lista === 30 && regs["vail"].lista === 12 && regs["outer banks"].lista === 11 &&
        Object.values(regs).every((r) => r.faceta === r.lista), JSON.stringify(regs));
      // (4) salário mal rotulado na fonte
      const { wageHora: _wh } = require(path.join(__dirname, "mod-filtros.js"));
      check("🎯 v179-L1: salário mensal mal rotulado é tratado como HORA (41 linhas reais da H-2A: '9.59 mo' virava $0,06/h e sumia de todo filtro) — e o mensal LEGÍTIMO continua dividido por 173",
        Math.abs(_wh({ w: "16.28", wunit: "mo" }) - 16.28) < 0.01 && Math.abs(_wh({ w: "2458", wunit: "mo" }) - 14.21) < 0.02 && Math.abs(_wh({ w: "9.59", wunit: "mo" }) - 9.59) < 0.01,
        `${_wh({ w: "16.28", wunit: "mo" })} / ${_wh({ w: "2458", wunit: "mo" })}`);
      const l12 = vfH.facetas.salario.limiares.find((l) => l.v === 12);
      const l15 = vfH.facetas.salario.limiares.find((l) => l.v === 15);
      check("🎯 v179-L1: a faixa exibida deixa de ser o lixo da fonte (min era $0,06 e a tela imprimia 'de $0.06 a $75/h'): min/max por percentil, extremos em minAbs/maxAbs, e as 41 vagas voltam pro limiar de $12 (4.364 → 4.395)",
        vfH.facetas.salario.min >= 7 && vfH.facetas.salario.maxAbs >= vfH.facetas.salario.max && l12.n === 4395 && l15.n > 0,
        JSON.stringify(vfH.facetas.salario).slice(0, 200));
      // (5) busca textual não pode ser calculada 2x por requisição
      let _chamou = 0;
      const FL2 = _cfL1({ normalizeStateName: (s) => String(s || "").toUpperCase(), normBusca: (s) => String(s || "").toLowerCase(), cityMatchNormFn: () => null, regioes: {}, grupoDe: () => "", searchSheet: (rows) => { _chamou++; return { total: rows.length, items: rows }; }, categoriaLabel: (k) => k });
      const _rowsL2 = [{ c: "1", t: "cook" }, { c: "2", t: "x" }];
      FL2.filtrar(_rowsL2, FL2.parse({ q: "cook" }), { except: ["q"] });
      const _semExcept = _chamou;
      FL2.filtrar(_rowsL2, FL2.parse({ q: "cook" }), {});
      check("🎯 v179-L1: com except:['q'] (lista e refill do robô) a busca textual NÃO é calculada e jogada fora — a planilha inteira era varrida 2x por requisição (70,6ms vs 1,4ms medidos)",
        _semExcept === 0 && _chamou === 1, `com except=${_semExcept}, sem except=${_chamou}`);
      // (6) desempenho da rota que o painel chama a cada tecla
      const _med = async (p, n) => { const t = []; for (let i = 0; i < n; i++) { const t0 = Date.now(); await get(p + "&_cb=" + i + "_" + Date.now()); t.push(Date.now() - t0); } t.shift(); t.sort((a, b) => a - b); return t[Math.floor(t.length / 2)]; };
      const medFil = await _med("/api/vagas/filtros?sheet=h2a-jun2026&email=0", 6);
      const medBusca = await _med("/api/sheet-meta?sheet=jan2026&email=0&top=25&q=cook", 6);
      // Medido neste repo depois da correção: ~39ms e ~37ms (antes 107ms e
      // 71ms). O teto é folgado de propósito pra não ficar instável no CI —
      // o que ele trava é a REGRESSÃO de ordem de grandeza.
      check("🎯 v179-L1: desempenho — a contagem ao vivo renormalizava a cidade 114 mil vezes por requisição (23 regiões × 4.964 linhas) e travava o processo inteiro; agora usa o índice",
        medFil < 75 && medBusca < 75, `filtros=${medFil}ms busca=${medBusca}ms`);
      const vfCache1 = await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&estado=TEXAS");
      const _t0c = Date.now(); const vfCache2 = await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&estado=TEXAS"); const _msc = Date.now() - _t0c;
      check("🎯 v179-L1: cache curto (5s) da contagem ao vivo — a mesma pergunta repetida (cada tecla digitada no painel) não refaz o cálculo inteiro",
        vfCache1.json.total === vfCache2.json.total && _msc < 20, `${_msc}ms`);
      // (7) o índice enxerga o que o robô acabou de enriquecer
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const upEnr = await req2("POST", "/api/admin/sheet/upload", { name: "Enriquecer Teste", key: "enrich-teste", data: [{ c: "H-400-ENR-0001", e: "chefe@enrichteste.com", n: "Enriquecer Teste LLC", t: "Housekeeper", s: "MAINE" }] });
      const vfE0 = (await get("/api/vagas/filtros?sheet=enrich-teste&email=0")).json;
      const rEnr = await req2("POST", "/api/test/enriquecer-linha", {
        token: TEST_TOKEN, sheet: "enrich-teste", case: "H-400-ENR-0001",
        dol: { worksite_city: "Bar Harbor", worksite_state: "MAINE", begin_date: "2027-05-01", case_status: "Certified" },
      });
      const vfE1 = (await get("/api/vagas/filtros?sheet=enrich-teste&email=0")).json;
      const smE1 = (await get(`/api/sheet-meta?sheet=enrich-teste&cidade=${encodeURIComponent("bar harbor|MAINE")}&top=10`)).json;
      check("🎯 v179-L1: o que o robô de planilha acaba de enriquecer JÁ VALE nos filtros — as linhas são mutadas no lugar e o comprimento nunca muda, então o índice ficava congelado até o próximo boot (cidade/data/salário descobertos não filtravam nada)",
        upEnr.json?.ok === true && rEnr.json?.ok === true && vfE0.disponibilidade.cidade === 0 && vfE0.disponibilidade.inicio === 0 &&
        vfE1.disponibilidade.cidade === 1 && vfE1.disponibilidade.inicio === 1 && smE1.total === 1,
        `upload=${upEnr.status} enriq=${rEnr.status} · antes cidade=${vfE0.disponibilidade.cidade}/inicio=${vfE0.disponibilidade.inicio} · depois cidade=${vfE1.disponibilidade.cidade}/inicio=${vfE1.disponibilidade.inicio} · lista=${smE1.total}`);
      // estrutural: as regras novas não podem ser desfeitas sem o teste avisar
      const _modL1 = fs.readFileSync(path.join(__dirname, "mod-filtros.js"), "utf8");
      check("🎯 v179-L1: (estrutural) as regras novas estão no motor ÚNICO — valor de faceta opaco (_lista com csv=false em cargo/cidade/status), chave canônica de cidade (ciKey), except:['q'] respeitado e índice invalidado por versão da planilha",
        /cargo: _lista\(first\("cargo", "titles"\)[\s\S]*?, false\)/.test(_modL1) && /ciKey/.test(_modL1) &&
        /!\(opts\.except \|\| \[\]\)\.includes\("q"\)/.test(_modL1) && /ix\.ver === ver/.test(_modL1) &&
        !/cityMatchFn\(/.test(_modL1),
        "regra do lote 1 desfeita no mod-filtros.js");
    }

    // ═══ 🏷️ v179 — LOTE 2: A CATEGORIA SAI DO TÍTULO, NÃO DO NOME DA EMPRESA ═══
    // 2.588 vagas de PAISAGISMO viviam dentro de 🏗️ Construção porque
    // "Landscape Laborer" casava com a chave "laborer" — e recategorizeAllSheets
    // refazia esse erro em TODO boot. Medido neste repo, jan2026 (9.240 linhas):
    // ANTES landscape 1.279 / construction 4.005 · DEPOIS landscape 3.877 /
    // construction 1.438. jul2025: construction 502 → 330, landscape 244 → 417.
    {
      const vfCat = (await get("/api/vagas/filtros?sheet=jan2026&email=0")).json;
      const cLand = (vfCat.facetas.categoria || []).find((c) => c.v === "landscape");
      const cConst = (vfCat.facetas.categoria || []).find((c) => c.v === "construction");
      check("🏷️ v179-L2: jan2026 depois do recategorizeAllSheets do boot — paisagismo voltou pra 🌿 Paisagismo (1.279 → 3.877) e 🏗️ Construção parou de inchar (4.005 → 1.438)",
        cLand && cConst && cLand.n >= 3500 && cConst.n <= 1600, `landscape=${cLand && cLand.n} construction=${cConst && cConst.n}`);
      // a vaga que o chip promete é a vaga que a lista entrega (mesma régua do lote 1)
      const smConst = (await get("/api/sheet-meta?sheet=jan2026&email=0&categoria=construction&top=2000")).json;
      const smConst2 = (await get("/api/sheet-meta?sheet=jan2026&email=0&categoria=construction&top=2000&skip=2000")).json;
      const titulosConst = [...smConst.jobs, ...smConst2.jobs].map((j) => j.title || "");
      check("🏷️ v179-L2: nenhuma vaga com 'landscap' no título continua dentro de 🏗️ Construção (eram 2.558 de 3.375) — e a contagem do chip é a da lista",
        smConst.total === cConst.n && titulosConst.filter((t) => /landscap/i.test(t)).length === 0,
        `total=${smConst.total} chip=${cConst && cConst.n} com landscap=${titulosConst.filter((t) => /landscap/i.test(t)).length}`);
      // fixtures determinísticas (título × empresa) pelo caminho REAL: o upload
      // de planilha é quem chama detectCategory(r.t, r.n) quando a linha não
      // traz categoria — a resposta da lista mostra o que a função decidiu.
      const fixCat = [
        ["Landscape Laborer", "312 Land Development, LLC", "landscape"],
        ["Landscape Laborer", "Painted Woods Golf Course", "landscape"],   // empresa NUNCA decide sozinha
        ["Golf Course Maintenance Laborer", "Escondido Club Inc", "golf"],
        ["Cook", "Breezeway Family Resorts", "food"],                       // correção do v960 não pode regredir
        ["Forestry Worker", "Cumberland Forestry Contractors, LLC", "forest"],
        ["Housekeeper", "Sunrise Construction Co", "housekeeper"],
        ["General Laborers", "J.J. Ferguson Prestress-Precast Co.", "construction"], // plural
        ["Stonemasons", "Tasdemir Marble and Granite LLC", "construction"],
      ];
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Categoria Teste", key: "cat-teste",
        data: fixCat.map(([t, n], i) => ({ c: `H-400-CAT-${String(i).padStart(4, "0")}`, e: `chefe${i}@catteste.com`, n, t })),
      });
      const smCat = (await get("/api/sheet-meta?sheet=cat-teste&email=0&top=50")).json;
      const errosCat = [];
      for (const [t, n, esperado] of fixCat) {
        const j = (smCat.jobs || []).find((x) => x.title === t && x.company === n);
        if (!j || j.category !== esperado) errosCat.push(`${t} | ${n} → ${j ? j.category : "?"} (esperado ${esperado})`);
      }
      check("🏷️ v179-L2: fixtures determinísticas título × empresa — o TÍTULO decide, a empresa só desempata; chave genérica (laborer/worker/golf course) só vale quando nenhuma específica casou; plural conta",
        errosCat.length === 0 && (smCat.jobs || []).length === fixCat.length, errosCat.join(" | "));
      const _srvL2 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🏷️ v179-L2: (estrutural) detectCategory recebe TÍTULO e EMPRESA separados em TODOS os chamadores — nunca mais a string 'empresa + título' grudada, que deixava uma chave longa da empresa vencer o cargo real",
        /function detectCategory\(titulo, empresa\)/.test(_srvL2) && !/detectCategory\(`\$\{r\.n/.test(_srvL2) && !/detectCategory\(`\$\{j\.employer/.test(_srvL2) &&
        !/detectCategory\(`\$\{c\.n/.test(fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8")) &&
        /CAT_CHAVES_GENERICAS/.test(_srvL2) && /_chaveInteira/.test(_srvL2),
        "algum chamador ainda concatena empresa+título, ou a regra de palavra inteira sumiu");
    }

    // ═══ 🔎 v179 — LOTE 3: A BUSCA ACHA O QUE EXISTE (e só o que existe) ═══
    // Medido no servidor real deste repo, ANTES → DEPOIS:
    // welder 4.002 → 13 · carpenter 4.002 → 106 · bartender 1.210 → 41 ·
    // dishwasher 1.209 → 145 · cook 1.215 → 589 · housekeeper 965 → 453 ·
    // "cape cod" em jan2026 (planilha SEM cidade) 3.354 → 17 · nº do caso
    // 6.387 → 1 · forklift 1 → 416 · housing 0 → 145 · wheelbarrow 0 → 11.
    {
      const _q = async (sheet, q, extra) => (await get(`/api/sheet-meta?sheet=${sheet}&email=0&q=${encodeURIComponent(q)}&top=${extra || 3}`)).json;
      const bw = await _q("jan2026", "welder");
      const bc = await _q("jan2026", "carpenter");
      const bb = await _q("jan2026", "bartender");
      const bd = await _q("jan2026", "dishwasher");
      const bk = await _q("jan2026", "cook");
      const bh = await _q("jan2026", "housekeeper");
      check("🔎 v179-L3: ACHAR ≠ SUGERIR — a 'categoria implícita' era ANEXADA ao resultado: q=welder devolvia 4.002 vagas (13 com a palavra) e era ISSO que virava total, faceta e FILA DO ROBÔ; agora o total é só quem casa de verdade",
        bw.total === 13 && bc.total === 106 && bb.total === 41 && bd.total === 145 && bk.total === 589 && bh.total === 453,
        `welder=${bw.total} carpenter=${bc.total} bartender=${bb.total} dishwasher=${bd.total} cook=${bk.total} housekeeper=${bh.total}`);
      check("🔎 v179-L3: a categoria parecida não some — viaja em `sugestoes` pra tela oferecer ('também há N em 🏗️ Construção'), e só entra nos números se o usuário mandar",
        Array.isArray(bw.sugestoes) && bw.sugestoes[0]?.categoria === "construction" && bw.sugestoes[0]?.n > 1000 &&
        bb.sugestoes[0]?.categoria === "food" && bw.jobs.every((j) => /welder/i.test(`${j.title} ${j.company} ${j.desc || ""}`)),
        JSON.stringify(bw.sugestoes));
      const bwWage = (await get("/api/sheet-meta?sheet=jan2026&email=0&q=welder&sort=wage&top=6")).json;
      check("🔎 v179-L3: com outra ordenação a relevância não vira ruído — q=welder&sort=wage trazia Rebar Workers/Office Clerk nas 6 primeiras; agora as 6 são welder de verdade",
        bwWage.jobs.length === 6 && bwWage.jobs.every((j) => /welder/i.test(j.title || "")), JSON.stringify(bwWage.jobs.map((j) => j.title)));
      const bcc = await _q("jan2026", "cape cod");
      check("🔎 v179-L3: região só é procurada na CIDADE (e o parcial só casa no COMEÇO de uma palavra) — 'cape cod' numa planilha SEM cidade nenhuma devolvia 3.354 vagas, porque 'cape' casava dentro de 'landSCAPE' e 'dennis'/'orleans'/'sandwich' são nomes de empresa",
        bcc.total === 17, `${bcc.total}`);
      const smCape = (await get("/api/sheet-meta?sheet=h2a-jun2026&email=0&cidade=cape%20cod&top=1")).json;
      check("🔎 v179-L3: a região no FILTRO de cidade não regrediu (cape cod = 10 na H-2A)", smCape.total === 10, `${smCape.total}`);
      const id1 = await _q("jan2026", "H-400-26001-520313");
      const id2 = await _q("jan2026", "520313");
      const id3 = await _q("jan2026", "26001");
      const id4 = await _q("jul2025", "H-400-25184-149281");
      const id5 = await _q("h2a-jun2026", "H-300-26121-860855");
      check("🔎 v179-L3: o campo promete 'nº do caso' e devolvia 6.387 vagas — o hífen virava espaço e '26001' (prefixo do lote do DOL) casava com milhares; atalho de identificador + token parcial obrigado a ter LETRA",
        id1.total === 1 && id1.jobs[0].caseNum === "H-400-26001-520313" && id2.total === 1 && id3.total <= 1 && id4.total === 1 && id5.total === 1,
        `completo=${id1.total} sufixo=${id2.total} lote5dig=${id3.total} jul2025=${id4.total} h2a=${id5.total}`);
      const dsc = {};
      for (const q of ["forklift", "housing", "tobacco", "wheelbarrow", "cook", "tractor"]) dsc[q] = (await _q("h2a-jun2026", q, 1)).total;
      check("🔎 v179-L3: a busca passou a olhar a DESCRIÇÃO/SOC/requisitos — é a informação mais rica da linha e estava invisível: forklift 1 → 416, housing 0 → 145, wheelbarrow 0 → 11, tobacco 24 → 278 (e q=cook na H-2A continua 14)",
        dsc.forklift === 416 && dsc.housing === 145 && dsc.wheelbarrow === 11 && dsc.tobacco === 278 && dsc.cook === 14, JSON.stringify(dsc));
      // (tractor sobe de 72 pra 1.741 DE PROPÓSITO — "tractor" está nas
      // funções de 1.741 vagas. O relatório da auditoria pedia 72 e 416 ao
      // mesmo tempo, o que é contraditório: ou a descrição entra na busca ou
      // não. Entra — e a relevância põe o título na frente.)
      const trt = (await get("/api/sheet-meta?sheet=h2a-jun2026&email=0&q=tractor&top=5")).json;
      check("🔎 v179-L3: quem casa no TÍTULO vem primeiro — com a descrição no palheiro, 'tractor' passa de 72 pra 1.741 vagas e as primeiras da lista são as que têm a palavra no cargo",
        trt.total === 1741 && trt.jobs.slice(0, 5).every((j) => /tractor/i.test(`${j.title} ${j.company}`)), JSON.stringify(trt.jobs.map((j) => j.title)));
      const ptJar = await _q("jan2026", "jardinagem", 1), enLand = await _q("jan2026", "landscape", 1);
      const ptCam = await _q("jan2026", "camareira", 1), enHk = await _q("jan2026", "housekeeper", 1);
      const ptCol = await _q("h2a-jun2026", "colheita", 1), enHar = await _q("h2a-jun2026", "harvest", 1);
      check("🇧🇷 v179-L3: o público é 100% brasileiro e o acervo 100% em inglês — 'jardinagem', 'camareira' e 'colheita' devolviam quase nada; agora a consulta vira um OU de termos em inglês (nunca a categoria inteira)",
        ptJar.total >= enLand.total && enLand.total > 3000 && ptCam.total >= enHk.total && enHk.total > 400 && ptCol.total === enHar.total && enHar.total > 2000,
        `jardinagem=${ptJar.total}/landscape=${enLand.total} camareira=${ptCam.total}/housekeeper=${enHk.total} colheita=${ptCol.total}/harvest=${enHar.total}`);
      check("🇧🇷 v179-L3: busca em português NÃO vira 'categoria inteira' (o erro que este lote corrige) — jardinagem fica abaixo do acervo e ainda oferece a sugestão de categoria",
        ptJar.total < 9240 && (ptJar.sugestoes || []).length >= 0, `${ptJar.total} de 9240`);
      const t3 = []; for (let i = 0; i < 6; i++) { const t0 = Date.now(); await get(`/api/sheet-meta?sheet=jan2026&email=0&top=25&q=cook&_cb=${i}_${Date.now()}`); t3.push(Date.now() - t0); }
      t3.shift(); t3.sort((a, b) => a - b);
      check("🔎 v179-L3: o palheiro é pré-calculado por LINHA (WeakMap), não montado dentro do filtro a cada requisição — lição do v162; medido 70,6ms → ~6ms mesmo com descrição/SOC no texto",
        t3[Math.floor(t3.length / 2)] < 40, `mediana ${t3[Math.floor(t3.length / 2)]}ms (${t3.join("/")})`);
      const _srvL3 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _appL3 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🔎 v179-L3: (estrutural) a sugestão de categoria NÃO entra no resultado (nunca mais `[...combined,...extra]`), o palheiro vem do cache e a tela consome `sugestoes` de verdade",
        !/const extra=list\.filter\(r=>\(r\.k\|\|"other"\)===impliedCat/.test(_srvL3) && /sugestao=\{categoria:impliedCat/.test(_srvL3) &&
        /_hayDe\(r\)\.h/.test(_srvL3) && /BUSCA_PT_EN/.test(_srvL3) && /_buscaIdentificador/.test(_srvL3) &&
        /function _vfRenderSugestoes\(/.test(_appL3) && /function vfIncluirSugestao\(/.test(_appL3) &&
        ["vf_sug", "vf_sug_btn"].every((k) => (_appL3.match(new RegExp(`"${k}":`, "g")) || []).length === 3),
        "regra do lote 3 desfeita (categoria implícita de volta no resultado, palheiro por requisição, ou tela sem a sugestão)");
    }

    // ═══ 🔒 v179 — LOTE 4: ROTA HONESTA E GATE FECHADO ═══
    {
      // (1) 💎 grupo/status são dado EXCLUSIVO do Double Pro — o v177-FIX3
      // fechou a FACETA, mas a rota continuava mandando vaga a vaga, em texto
      // puro, até pra quem não tem cookie nenhum.
      const _cookieGuardado = COOKIE; COOKIE = "";
      const semCookie = (await get("/api/sheet-meta?sheet=jul2026&email=0&top=3")).json;
      COOKIE = _cookieGuardado;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vazadp@test.com", name: "Sem DP" });
      const gratis = (await get("/api/sheet-meta?sheet=jul2026&email=0&top=3")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "temdp@test.com", name: "Com DP", plan: "doublepro", vip: { plan: "doublepro", active: true, manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, source: "pix" } });
      const dp = (await get("/api/sheet-meta?sheet=jul2026&email=0&top=3")).json;
      check("🔒 v179-L4: 💎 grupo da loteria e status no DOL saíam vaga a vaga pra QUALQUER um (até sem cookie) — o cadeado da tela era decorativo, bastava ler a resposta; agora null pra quem não é Double Pro, igual a faceta já faz",
        semCookie.jobs.every((j) => j.grupo === null && j.status === null) &&
        gratis.jobs.every((j) => j.grupo === null && j.status === null) &&
        dp.jobs.some((j) => j.grupo) && dp.jobs.every((j) => j.status),
        `semCookie=${JSON.stringify(semCookie.jobs.map((j) => [j.grupo, j.status]))} dp=${JSON.stringify(dp.jobs.map((j) => [j.grupo, j.status]))}`);
      // (2) `exp` é MESES DE EXPERIÊNCIA EXIGIDA, nunca "expirada"
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Vaga Morta Teste", key: "morta-teste",
        data: [
          { c: "H-400-EXP-0001", e: "viva@mortateste.com", n: "Viva LLC", t: "Welder", st: "Certified", exp: 1, de: "2027-01-01" },
          { c: "H-400-EXP-0002", e: "velha@mortateste.com", n: "Velha LLC", t: "Welder", st: "Certified", exp: 0, de: "2020-01-01" },
          { c: "H-400-EXP-0003", e: "retirada@mortateste.com", n: "Retirada LLC", t: "Welder", st: "Withdrawn", exp: 0, de: "2027-01-01" },
        ],
      });
      const mt = async (c) => (await get(`/api/test/vaga-morta?token=${TEST_TOKEN}&sheet=morta-teste&case=${c}`)).json;
      const m1 = await mt("H-400-EXP-0001"), m2 = await mt("H-400-EXP-0002"), m3 = await mt("H-400-EXP-0003");
      check("🔒 v179-L4: `exp` é MESES DE EXPERIÊNCIA EXIGIDA (0,1,2,…,60) e o robô tratava exp===1 como 'vaga EXPIRADA', pulando 447 vagas boas em jan2026 e 149 em jul2025 com motivo falso — e o enriquecimento grava exp=1 pra toda vaga que exige experiência (quanto mais rodava, pior)",
        m1.motivo === null && /ENCERRADA/.test(m2.motivo || "") && /RETIRADA/.test(m3.motivo || ""),
        `exp1=${JSON.stringify(m1.motivo)} temporadaVelha=${JSON.stringify(m2.motivo)} withdrawn=${JSON.stringify(m3.motivo)}`);
      // (3) parâmetro inválido não some calado
      const inv = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&inicio=13&salarioMin=abc&grupo=Z")).json;
      check("🔒 v179-L4: parâmetro inválido sumia CALADO e a resposta devolvia a planilha inteira (inicio=13 → total 4.964 com ativos=0) — na tela é confusão, no robô o job.filters corrompido fazia o refill se realimentar com TUDO; agora cada descarte é declarado",
        inv.total === 4964 && Array.isArray(inv.ignorados) && inv.ignorados.length === 3 &&
        inv.ignorados.some((x) => x.param === "inicio") && inv.ignorados.some((x) => x.param === "salarioMin") && inv.ignorados.some((x) => x.param === "grupo"),
        JSON.stringify(inv.ignorados));
      const topAbc = (await get("/api/sheet-meta?sheet=jul2025&email=0&top=abc")).json;
      const skipAbc = (await get("/api/sheet-meta?sheet=jul2025&email=0&skip=abc&top=5")).json;
      check("🔒 v179-L4: top=abc virava NaN e a lista voltava VAZIA ao lado de um contador de milhares ('Nenhuma vaga encontrada' com total 2.206) — agora cai no padrão (25) e skip inválido vira 0",
        topAbc.jobs.length === 25 && topAbc.total === 2206 && skipAbc.skip === 0 && skipAbc.jobs.length === 5,
        `top=abc → ${topAbc.jobs.length} vagas / total ${topAbc.total}; skip=abc → skip ${skipAbc.skip}`);
      const vistos = new Set(); let dup = 0;
      for (let sk = 0; sk < 2206; sk += 500) {
        const pg = (await get(`/api/sheet-meta?sheet=jul2025&email=0&sort=shuffle&top=500&skip=${sk}`)).json;
        for (const j of pg.jobs) { if (vistos.has(j.caseNum)) dup++; else vistos.add(j.caseNum); }
      }
      check("🔒 v179-L4: `sort` vinha da URL sem lista branca — sort=shuffle reembaralhava a cada requisição e a paginação DUPLICAVA e PERDIA vaga (varredura real de jul2025: 1.465 únicas / 741 duplicadas); agora ordenação desconhecida cai no padrão estável",
        vistos.size === 2206 && dup === 0, `${vistos.size} únicas / ${dup} duplicadas`);
      // (4) o "de N vagas" das duas rotas tem que ser o MESMO número
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "denvagas@test.com", name: "Den Vagas" });
      const semHist = (await get("/api/sheet-meta?sheet=morta-teste&email=0&hideSent=1&top=5")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "denvagas@test.com", sentTo: ["viva@mortateste.com", "velha@mortateste.com"] });
      const comHist = (await get("/api/sheet-meta?sheet=morta-teste&email=0&hideSent=1&top=5")).json;
      const vfHist = (await get("/api/vagas/filtros?sheet=morta-teste&email=0&hideSent=1")).json;
      check("🔒 v179-L4: o 'de N vagas' da lista usava a planilha BRUTA (remainingTotal) enquanto o painel já descontava enviadas/fila (totalBase) — os dois alimentam o MESMO 'de N' da MESMA tela e divergiam pra quem tem histórico; agora é o mesmo corte (regra 8), pela mesma função",
        semHist.remainingTotal === 3 && comHist.remainingTotal === 1 && comHist.remainingTotal === vfHist.totalBase,
        `sem histórico=${semHist.remainingTotal} · com 2 envios: lista=${comHist.remainingTotal} painel=${vfHist.totalBase}`);
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _srvL4 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🔒 v179-L4: (estrutural) o gate 💎 é do SERVIDOR na resposta por vaga, `exp` não é mais sinal de expiração e só existem ordenações da lista branca",
        /status:_dpMeta\?\(r\.st\|\|"–"\):null/.test(_srvL4) && /grupo:\(_dpMeta&&r\.g/.test(_srvL4) &&
        !/row\.exp===1\|\|row\.exp===true/.test(_srvL4) && /const SORTS_VALIDOS = new Set/.test(_srvL4) &&
        !/sort==="shuffle"/.test(_srvL4),
        "gate por vaga, exp ou lista branca de sort desfeitos");
    }

    // ═══ 🖥️ v181 — LOTE 5: A TELA CONTA A MESMA HISTÓRIA QUE O SERVIDOR ═══
    // O dono viu na prática: o painel anunciava "TEXAS 821" enquanto a lista,
    // com a MESMA busca, tinha 21. A tela mandava `q` só no automático.
    {
      const _par = async (qs) => {
        const vf = (await get("/api/vagas/filtros?" + qs)).json;
        const sm = (await get("/api/sheet-meta?" + qs + "&top=1")).json;
        return { vf: vf.total, sm: sm.total, qs };
      };
      const pares = [];
      for (const qs of ["sheet=jan2026&email=1&q=cook", "sheet=jan2026&email=1&q=cook&estado=TEXAS",
        "sheet=jan2026&q=welder&categoria=construction", "sheet=jul2025&q=housekeeper&email=1",
        "sheet=h2a-jun2026&q=tractor&salarioMin=15", "sheet=h2a-jun2026&q=forklift&estado=FLORIDA"]) pares.push(await _par(qs));
      check("🖥️ v181-L5 (caso 16): com busca ativa, o total do painel é IDÊNTICO ao da lista em 6 combinações — era a quebra mais visível da regra da casa (o painel ignorava o `q` e ranqueava TEXAS 821 numa lista de 21)",
        pares.every((p) => p.vf === p.sm), JSON.stringify(pares));
      const _appL5 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🖥️ v181-L5 (estrutural): a busca do manual É o filtro `q` do motor (VF.st.manual.q, enviado nos DOIS contextos) — o `ctx===\"auto\"&&st.q` do vfParams e o `q` solto na lista morreram",
        !/ctx==="auto"&&st\.q/.test(_appL5) && /if\(st\.q\)p\.set\("q",st\.q\)/.test(_appL5) &&
        _appL5.includes("function _vfSetQ(") && !/p\.set\("hideSent","1"\);if\(fQ\)p\.set\("q",fQ\)/.test(_appL5),
        "a busca do manual voltou a viver fora do motor de filtros");
      // (2) lista vazia honesta: os 3 números que a frase precisa existem na rota
      const vazio = (await get("/api/sheet-meta?sheet=jul2026&email=1&top=25")).json;
      const vfVazio = (await get("/api/vagas/filtros?sheet=jul2026&email=1")).json;
      check("🕳️ v181-L5: a aba Julho 2026 devolve total 0 com remainingTotal 2.625 e disponibilidade.email 0 — os 3 números que a frase honesta usa ('a planilha tem N vagas, mas o governo não publicou e-mail nenhum'); a tela imprimia '0 vagas' como se a planilha estivesse vazia",
        (vazio.jobs || []).length === 0 && vazio.total === 0 && vazio.remainingTotal === 2625 &&
        vfVazio.disponibilidade.email === 0 && vfVazio.totalPlanilha === 2625,
        JSON.stringify({ total: vazio.total, rem: vazio.remainingTotal, email: vfVazio.disponibilidade.email }));
      check("🕳️ v181-L5 (estrutural): `sTrueTotal` é atribuído ANTES do ramo vazio (era só dentro do else) e a lista vazia explica a CAUSA com botão de ação — nunca mais 'Nenhuma vaga encontrada' seco",
        /sTrueTotal=d\.remainingTotal\|\|sTrueTotal\|\|0;\s*\n\s*if\(!d\.jobs\?\.length\)/.test(_appL5) &&
        _appL5.includes("function _vfVazioHtml(") && _appL5.includes("vf_vazio_sem_email") && _appL5.includes("vf_vazio_tirando"),
        "a lista vazia voltou a ser muda");
      // (3) badge = ativos() do motor, pras MESMAS 8 combinações de estado
      const { createFiltros: _cfL5 } = require(path.join(__dirname, "mod-filtros.js"));
      const FL5 = _cfL5({ normalizeStateName: (s) => String(s || "").toUpperCase().trim(), normBusca: (s) => String(s || "").toLowerCase().trim(), cityMatchNormFn: () => null, regioes: {}, grupoDe: (r) => r.g || "", searchSheet: (arr) => ({ total: arr.length, items: arr }), categoriaLabel: (k) => k });
      // espelho EXATO da vfAtivos(st) do app.js (contexto planilha, não ao vivo)
      // 🛡️ v276: `email` NÃO conta mais — virou padrão protetor do app (igual
      // ocultarEncerradas), não escolha do usuário.
      const vfAtivosFront = (st) => { let n = 0; for (const k of ["estado", "cidade", "categoria", "cargo", "inicio", "grupo"]) if ((st[k] || []).length) n++; if (st.salarioMin > 0) n++; if (st.vagasMin > 0) n++; if (st.q) n++; return n; };
      const estados = [{}, { email: true }, { q: "cook" }, { q: "cook", email: true }, { estado: ["TEXAS"], q: "cook", email: true },
        { estado: ["TEXAS"], categoria: ["food"], salarioMin: 15, email: true }, { cidade: ["ames|IOWA"], vagasMin: 5 },
        { tipo: "agricultural", ativa: true, email: true }];
      const badge = estados.map((st) => { const p = new URLSearchParams(); for (const k of ["estado", "cidade", "categoria", "cargo", "grupo"]) (st[k] || []).forEach((v) => p.append(k, v)); (st.inicio || []).forEach((m) => p.append("inicio", String(m))); if (st.salarioMin > 0) p.set("salarioMin", String(st.salarioMin)); if (st.vagasMin > 0) p.set("vagasMin", String(st.vagasMin)); if (st.email) p.set("email", "1"); if (st.q) p.set("q", st.q); return { front: vfAtivosFront(st), motor: FL5.ativos(FL5.parse(p)) }; });
      check("🔍 v181-L5: o badge '🔍 N filtros' espelha EXATAMENTE o ativos() do motor nas 8 combinações — contava tipo/ativa (que a tela nunca envia fora da aba ao vivo) e ignorava o 'só com e-mail', o filtro mais consequente da tela",
        badge.every((b) => b.front === b.motor), JSON.stringify(badge));
      check("🔍 v181-L5 (estrutural): o 'só com e-mail' DESLIGADO virou chip visível ('incluindo vagas sem e-mail — não dá pra se candidatar') e tirar o chip volta ao outro estado — e (🛡️ v276) `email` NÃO conta mais em ativos() nem manda '1'/omite: manda '1' OU '0' sempre explícito (opt-out nunca depende de omissão)",
        !/if\(st\.email\)n\+\+;/.test(_appL5) && _appL5.includes("vf_chip_sem_email") &&
        /!st\.email\)push\("email"/.test(_appL5) && /else if\(dim==="email"\)st\.email=!st\.email;/.test(_appL5) &&
        /p\.set\("email",\(ctx==="auto"\|\|st\.email\)\?"1":"0"\);/.test(_appL5),

        "chip do e-mail desligado ausente");
      // ═══ 🐛 v224 (achados do dono no modal "Filtrar vagas") ═══
      // (1) "Limpar tudo" pequeno (fora do painel) e "Limpar tudo" do
      // cabeçalho do painel viviam em mundos separados — um só mexia no
      // filtro JÁ APLICADO (VF.st), o outro só no RASCUNHO (VF.draft).
      check("🐛 v224 (estrutural): vfClearDraft() (cabeçalho do painel) zera o RASCUNHO e o filtro JÁ APLICADO juntos — antes só mexia no rascunho, e fechar o painel sem clicar Aplicar trazia o filtro antigo de volta",
        /function vfClearDraft\(\)\{[\s\S]{0,200}VF\.st\[ctx\]=_vfEmpty\(\);vfSave\(ctx\);vfAfterChange\(ctx\);/.test(_appL5),
        "vfClearDraft não zera mais o VF.st junto");
      check("🐛 v224 (estrutural): vfClear(ctx) (chip fora do painel / lista vazia) zera o filtro aplicado E o RASCUNHO quando o painel está aberto no mesmo contexto — antes as opções ficavam marcadas na tela mesmo depois de 'limpar'",
        /function vfClear\(ctx\)\{[\s\S]{0,220}if\(VF\.draft&&VF\.ctx===ctx\)\{VF\.draft=_vfEmpty\(\);/.test(_appL5),
        "vfClear não sincroniza mais o VF.draft aberto");
      // (2) Race condition: "Limpar tudo" do painel ficava preso mostrando a
      // contagem de um filtro anterior (ex.: Michigan) porque o painel
      // (preview ao vivo) e a contagem do já-aplicado (fora do painel)
      // dividiam UM contador de sequência só — uma resposta de um motivo
      // descartava a resposta fresca do outro motivo como se fosse "antiga".
      check("🐛 v224 (estrutural): vfFetch tem contadores de sequência SEPARADOS pro painel (rascunho) e pro já-aplicado (fora do painel) — um não pode mais descartar a resposta fresca do outro como 'antiga'",
        _appL5.includes("seqAplicado:0") && /const painel=!!st;/.test(_appL5) &&
        /const chave=painel\?"seq":"seqAplicado";/.test(_appL5) && /if\(seq!==VF\[chave\]\)return null;/.test(_appL5),
        "vfFetch voltou a usar um VF.seq só pros dois motivos");
      // (3) Busca por palavra-chave: apóstrofo sozinho (ou qualquer busca que
      // vira string vazia depois de tirar acento/pontuação) devolvia "Ver 0
      // vagas" em vez de ignorar a busca — uma vaga real com apóstrofo no
      // nome da empresa ("Olson's Greenhouses") nunca conseguia dar match
      // com só um apóstrofo, mas também não devia zerar a planilha inteira.
      const _semQ = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0")).json;
      const _soApostrofo = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&q=" + encodeURIComponent("'"))).json;
      const _soPontuacao = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&q=" + encodeURIComponent("'!#$%")))
        .json;
      const _gibberish = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&q=zzzznenhumavagatemisso")).json;
      check("🐛 v224: busca que é SÓ pontuação/acento (normaliza pra string vazia) é IGNORADA — nunca mais 'Ver 0 vagas' pra quem digitou um apóstrofo sozinho, igual uma empresa real da planilha pode ter no nome",
        _soApostrofo.total === _semQ.total && _soPontuacao.total === _semQ.total,
        JSON.stringify({ semQ: _semQ.total, apostrofo: _soApostrofo.total, pontuacao: _soPontuacao.total }));
      check("🐛 v224: busca com letras de verdade que não bate com NADA continua devolvendo 0 honesto — a correção é só pra busca vazia depois de normalizar, nunca pra esconder um resultado zero real",
        _gibberish.total === 0, `total=${_gibberish.total}`);
      const _srvL224 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🐛 v224 (estrutural): _normSearch (server.js) tem a guarda explícita pra busca vazia — searchSheet nunca mais monta `alvos=[]`/`direct=[]` incondicional quando a busca inteira era só pontuação",
        /const ql=_normSearch\(qRaw\);[\s\S]{0,900}if \(!ql\) \{/.test(_srvL224),
        "guarda de busca vazia sumiu de searchSheet");
      // (4) 🗓️ "Começa logo" entrega o que promete (caso 21)
      const st10 = (await get("/api/sheet-meta?sheet=h2a-jun2026&email=0&sort=start&top=10")).json;
      const _hj = new Date().toISOString().slice(0, 10);
      const faixas = (st10.jobs || []).map((j) => { const d = String(j.start || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? (d >= _hj ? 0 : 1) : 2; });
      const semSort = (await get("/api/sheet-meta?sheet=h2a-jun2026&email=0&top=1")).json;
      check("🗓️ v181-L5 (caso 21): 'Começa logo' entregava 'começou há mais tempo' (as 5 primeiras da H-2A eram de jan/fev — 8 meses atrás). Agora: nenhuma vaga já iniciada aparece antes de uma que ainda vai começar, e o total não muda",
        faixas.length === 10 && faixas.every((f, i) => i === 0 || f >= faixas[i - 1]) && faixas[0] === 0 && st10.total === semSort.total,
        JSON.stringify({ faixas, datas: (st10.jobs || []).map((j) => j.start), total: st10.total }));
      const vfJan = (await get("/api/vagas/filtros?sheet=jan2026&email=0")).json;
      check("🗓️ v181-L5: em jan2026/jul2025 a data de início é VAZIA em 100% das linhas (disponibilidade.inicio 0) — a tela esconde 🗓️/Recentes em vez de acender um botão que não faz nada em 11.446 vagas",
        vfJan.disponibilidade.inicio === 0 && _appL5.includes("function _vfSyncSortBtns(") && /so-start","so-desc/.test(_appL5),
        `inicio=${vfJan.disponibilidade.inicio}`);
      // (5) "Recentes" virou ordenação REAL por data (decisão do dono)
      const rec = (await get("/api/sheet-meta?sheet=h2a-jun2026&email=0&sort=desc&top=12")).json;
      const datasRec = (rec.jobs || []).map((j) => String(j.start || "").slice(0, 10));
      const _srvL5 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🆕 v181-L5: 'Recentes' era literalmente a planilha AO CONTRÁRIO (list.reverse()) — ordem de arquivo vendida como data. Agora ordena de verdade pela data de início, da mais recente pra mais antiga, sem mudar o total",
        datasRec.length === 12 && datasRec.every((d, i) => i === 0 || d <= datasRec[i - 1]) && rec.total === semSort.total &&
        !/if \(sort==="desc"\) list=\[\.\.\.list\]\.reverse\(\);/.test(_srvL5),
        JSON.stringify({ datas: datasRec, total: rec.total }));
      check("🆕 v181-L5 (estrutural): as duas ordenações por data usam decorate-sort-undecorate com a data calculada 1x por linha (_dataISO) — nunca parse dentro do comparador (lição do v162)",
        /function _dataISO\(/.test(_srvL5) && /list=list\.map\(\(r,i\)=>\{const d=_dataISO\(r\.d\)/.test(_srvL5) &&
        !/sort\(\(a,b\)=>String\(a\.d\|\|"9999"\)/.test(_srvL5),
        "ordenação por data voltou a parsear dentro do comparador");
      // (6) painel que não fica mudo. v209/v210: os rótulos PT de "Certified"/
      // "Pending Processing" e a faceta "status no DOL" foram REMOVIDOS por
      // completo (regra 0.2 — nenhum status de vaga pro usuário, nem filtro
      // pago) — a checagem de _vfStatusLabel/vf_st_* saiu daqui de propósito;
      // ver os 2 checks estruturais v210 mais abaixo que provam a remoção.
      const _i18nL5 = ["vf_erro", "vf_erro_btn", "vf_vazio_t", "vf_vazio_sem_email", "vf_vazio_tirando", "vf_chip_sem_email", "vf_grupo_expl"];
      const _dictL5 = (lang) => { const i = _appL5.indexOf(`  ${lang}: {`); const e = _appL5.indexOf("\n  }", i); return _appL5.slice(i, e); };
      const _ptL5 = _dictL5("pt"), _enL5 = _dictL5("en"), _esL5 = _dictL5("es");
      const _faltamL5 = _i18nL5.filter((k) => !(_ptL5.includes(`"${k}":`) && _enL5.includes(`"${k}":`) && _esL5.includes(`"${k}":`)));
      check("🏷️ v181-L5: strings de erro/vazio/grupo da loteria presentes no LANG_DICT nas 3 línguas",
        _faltamL5.length === 0, `faltando: ${_faltamL5.join(",")}`);
      check("🚫 v209/v210 (estrutural): a faceta/filtro 'status no DOL' (Certified/Pending/Withdrawn/Denied/Expired) saiu por completo do app.js — nem _vfStatusLabel, nem vf_st_*, nem seção 'status' no VF_SECS",
        !_appL5.includes("_vfStatusLabel") && !_appL5.includes("vf_st_certified") && !/\{k:"status"/.test(_appL5),
        "resquício do facet de status sobrou no app.js");
      const dpStatusIgnorado = (await get("/api/sheet-meta?sheet=jan2026&email=0&status=Certified&top=1")).json;
      check("🚫 v209/v210: o parâmetro status=Certified agora é IGNORADO pelo servidor (não filtra mais nada) — jan2026 devolve o total INTEIRO da planilha, igual sem o parâmetro",
        dpStatusIgnorado.total === 9240, `${dpStatusIgnorado.total}`);
      check("🛑 v181-L5: o painel não fica mais mudo com spinner eterno quando a rede falha — erro clicável no corpo (mesmo padrão da lista) e timeout de 8s no fetch das opções; nenhum catch vazio no bloco VF",
        _appL5.includes("function _vfRenderErro(") && _appL5.includes("AbortController") &&
        !/try\{const d=await vfFetch\("manual"\);if\(d\)\{VF\.fac\.manual=d;vfRenderChips\("manual"\);\}\}catch\(e\)\{\}/.test(_appL5),
        "catch vazio / spinner eterno de volta no painel");
    }

    // ═══ 🧰 v181 — LOTE 6: FILTROS NOVOS QUE OS DADOS SUSTENTAM ═══
    // exp (meses de experiência), temporada (derivada das datas), visto, e a
    // regra geral "dimensão com 1 valor só não separa nada". Todos os números
    // abaixo foram medidos nas planilhas empacotadas deste repositório.
    {
      // 🛡️ v276: email=0 sempre — os números abaixo foram medidos ANTES do
      // servidor esconder vaga sem e-mail por padrão; o teste do padrão novo
      // fica isolado logo depois (bloco jul2026), não aqui.
      const _t = async (qs) => (await get("/api/sheet-meta?" + qs + "&top=1&email=0")).json.total;
      const vfJ = (await get("/api/vagas/filtros?sheet=jan2026&email=0")).json;
      const vfJ25 = (await get("/api/vagas/filtros?sheet=jul2025&email=0")).json;
      const vfH2a = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0")).json;
      const vfJ26 = (await get("/api/vagas/filtros?sheet=jul2026&email=0")).json;
      // (1) EXPERIÊNCIA — caso 19: faceta = lista, teto acumulando
      const exp0 = vfJ.facetas.exp.find((x) => x.v === 0), exp3 = vfJ.facetas.exp.find((x) => x.v === 3);
      const l0 = await _t("sheet=jan2026&exp=0"), l3 = await _t("sheet=jan2026&exp=3"), l25 = await _t("sheet=jul2025&exp=0");
      check("🧰 v181-L6 (caso 19): filtro novo de EXPERIÊNCIA — 5.923 vagas de jan2026 (64%) e 1.037 de jul2025 exigem ZERO mês, o dado estava lá desde sempre e não era filtro nenhum. Faceta por TETO = verdade da lista, e '≤3 meses' acumula os menores",
        exp0.n === 5923 && l0 === 5923 && exp3.n === 8475 && l3 === 8475 && l25 === 1037 &&
        vfJ25.facetas.exp.find((x) => x.v === 0).n === 1037,
        JSON.stringify({ faceta0: exp0.n, lista0: l0, faceta3: exp3.n, lista3: l3, jul2025: l25 }));
      check("🧰 v181-L6: a dimensão não é oferecida onde o dado não existe — H-2A tem 0 linha com experiência publicada e jul2026 tem os 2.625 zeros de fachada (1 valor distinto só, não separa nada)",
        vfH2a.disponibilidade.exp === 0 && vfH2a.disponibilidade.expDistintos === 0 &&
        vfJ26.disponibilidade.exp === 2625 && vfJ26.disponibilidade.expDistintos === 1 &&
        vfJ.disponibilidade.expDistintos === 15,
        JSON.stringify({ h2a: vfH2a.disponibilidade.exp, j26dist: vfJ26.disponibilidade.expDistintos, janDist: vfJ.disponibilidade.expDistintos }));
      const vfExp0 = (await get("/api/vagas/filtros?sheet=jan2026&email=0&exp=0")).json;
      const txExp = vfExp0.facetas.estado.find((x) => x.v === "TEXAS");
      check("🧰 v181-L6: a experiência cruza com as outras dimensões pela régua de sempre (E entre dimensões) — a contagem que a faceta de estado anuncia DENTRO de exp=0 é a que a lista devolve",
        txExp.n === (await _t("sheet=jan2026&exp=0&estado=TEXAS")), `faceta=${txExp.n}`);
      // (2) TEMPORADA — caso 20 (os números dependem do DIA: calculados aqui
      //     com a mesma régua, contra o arquivo empacotado)
      const _bundle = JSON.parse(fs.readFileSync(path.join(__dirname, "h2a_jun2026_compact.json"), "utf8"));
      const _hoje2 = new Date().toISOString().slice(0, 10);
      const _isoOk = (v) => { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; };
      let espFut = 0, espAb = 0, espEnc = 0, espSem = 0;
      for (const r of _bundle) { const d = _isoOk(r.d), de = _isoOk(r.de); if (!d && !de) espSem++; else if (de && de < _hoje2) espEnc++; else if (d && d > _hoje2) espFut++; else espAb++; }
      const fT = Object.fromEntries((vfH2a.facetas.temporada || []).map((x) => [x.v, x.n]));
      const lEnc = await _t("sheet=h2a-jun2026&temporada=encerrada");
      const encJobs = (await get(`/api/sheet-meta?sheet=h2a-jun2026&email=0&temporada=encerrada&top=2000`)).json.jobs || [];
      check("🗓️ v181-L6 (caso 20): filtro novo de TEMPORADA na H-2A — nenhum filtro usava a data de FIM e 219+ vagas JÁ TERMINADAS eram listadas como qualquer outra. Faceta = lista, as 3 faixas + sem data fecham o total da planilha, e toda vaga 'encerrada' tem fim no passado",
        fT.encerrada === espEnc && fT.aberta === espAb && fT.futura === espFut && lEnc === espEnc &&
        fT.futura + fT.aberta + fT.encerrada + vfH2a.facetas.temporadaSemData === 4964 &&
        encJobs.length === espEnc && encJobs.every((j) => String(j.end || "").slice(0, 10) < _hoje2),
        JSON.stringify({ faceta: fT, esperado: { espFut, espAb, espEnc }, lista: lEnc, semData: vfH2a.facetas.temporadaSemData }));
      check("🗓️ v181-L6: planilha H-2B sem data nenhuma (jan2026/jul2025: 11.446 vagas) não oferece a dimensão — disponibilidade.temporada 0, régua da casa 'dimensão sem dado é honesta'",
        vfJ.disponibilidade.temporada === 0 && vfJ25.disponibilidade.temporada === 0 &&
        vfJ26.disponibilidade.temporadaDistintos === 1,
        JSON.stringify({ jan: vfJ.disponibilidade.temporada, jul: vfJ25.disponibilidade.temporada, j26dist: vfJ26.disponibilidade.temporadaDistintos }));
      // (3) esconder a temporada ENCERRADA por padrão (decisão do dono)
      const padrao = await _t("sheet=h2a-jun2026&ocultarEncerradas=1");
      const semPadrao = await _t("sheet=h2a-jun2026");
      const padraoJan = await _t("sheet=jan2026&ocultarEncerradas=1");
      const padraoJ26 = await _t("sheet=jul2026&ocultarEncerradas=1");
      const vfPadrao = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&ocultarEncerradas=1")).json;
      check("⏳ v181-L6 (decisão do dono): a lista esconde por PADRÃO a vaga cuja temporada já acabou (4.964 → 4.744 na H-2A: a pessoa gastava envio e limite diário com vaga que não existe mais) e mostra tudo em 1 clique — nunca esconde o que não dá pra afirmar (planilha sem data de fim fica intocada)",
        padrao === 4964 - espEnc && semPadrao === 4964 && padraoJan === 9240 && padraoJ26 === 2625,
        JSON.stringify({ padrao, semPadrao, jan: padraoJan, jul2026: padraoJ26 }));
      check("⏳ v181-L6: transparência total — com o padrão ligado a FACETA continua anunciando as encerradas (é de lá que sai o número do chip 'escondendo N') e o badge de filtros continua ZERO (é padrão do app, não escolha do usuário)",
        (vfPadrao.facetas.temporada.find((x) => x.v === "encerrada") || {}).n === espEnc && vfPadrao.ativos === 0 && vfPadrao.total === 4964 - espEnc,
        JSON.stringify({ faceta: vfPadrao.facetas.temporada, ativos: vfPadrao.ativos }));
      // o robô: vaga com fim no passado nunca entra na fila do refill
      const _srvL6 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("⏳ v181-L6: o robô usa a MESMA régua no envio e no REFILL (função única _motivoVagaMorta) — antes o refill devolvia pra fila exatamente a vaga encerrada que o envio tinha acabado de pular",
        /function _motivoVagaMorta\(/.test(_srvL6) && (_srvL6.match(/_motivoVagaMorta\(/g) || []).length >= 3 &&
        !/if\(st\.includes\("WITHDRAWN"\)\|\|st\.includes\("DENIED"\)\|\|st\.includes\("EXPIRED"\)\|\|st\.includes\("INVALIDATED"\)\)continue;/.test(_srvL6),
        "refill voltou a ter régua própria de vaga morta");
      // (4) dimensão com menos de 2 valores distintos
      check("🙈 v181-L6: TODA dimensão de opções declara <dim>Distintos (não só o status) — jan2026 statusDistintos 1, H-2A 0, jul2026 grupoDistintos 2, jan2026 grupoDistintos 0 e visaDistintos 1 nas 4 planilhas: nenhuma separa nada e a tela não oferece",
        vfJ.disponibilidade.statusDistintos === 1 && vfH2a.disponibilidade.statusDistintos === 0 &&
        vfJ26.disponibilidade.grupoDistintos === 2 && vfJ.disponibilidade.grupoDistintos === 0 &&
        [vfJ, vfJ25, vfH2a, vfJ26].every((v) => v.disponibilidade.visaDistintos === 1) &&
        ["estadoDistintos", "cidadeDistintos", "categoriaDistintos", "cargoDistintos", "inicioDistintos", "expDistintos", "temporadaDistintos", "visaDistintos", "statusDistintos", "grupoDistintos"].every((k) => typeof vfH2a.disponibilidade[k] === "number"),
        JSON.stringify(vfJ26.disponibilidade));
      // (5) visto: só aparece quando a planilha tem os 2 (planilha mista de teste)
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Mista Visto", key: "mista-visa", data: [
          { c: "H-400-VISA-0001", n: "B1 LLC", s: "TEXAS", e: "rh@b1visa.com", t: "Cook", visa: "H-2B" },
          { c: "H-400-VISA-0002", n: "B2 LLC", s: "TEXAS", e: "rh@b2visa.com", t: "Cook" },
          { c: "H-300-VISA-0003", n: "A1 LLC", s: "IOWA", e: "rh@a1visa.com", t: "Farm Worker", visa: "H-2A" },
          { c: "H-300-VISA-0004", n: "A2 LLC", s: "IOWA", e: "rh@a2visa.com", t: "Farm Worker" },
        ],
      });
      const vfMix = (await get("/api/vagas/filtros?sheet=mista-visa&email=0")).json;
      const listaA = (await get("/api/sheet-meta?sheet=mista-visa&email=0&visa=H-2A&top=10")).json;
      check("🛂 v181-L6: o tipo de visto virou dimensão do motor (com fallback pelo prefixo do case: H-300 → H-2A, H-400 → H-2B) e só é oferecida quando a planilha tem os DOIS — numa planilha mista a faceta soma o total e o filtro bate com ela",
        vfMix.disponibilidade.visaDistintos === 2 && vfMix.facetas.visa.length === 2 &&
        vfMix.facetas.visa.reduce((a, x) => a + x.n, 0) === 4 &&
        (vfMix.facetas.visa.find((x) => x.v === "H-2A") || {}).n === 2 && listaA.total === 2 &&
        (listaA.jobs || []).every((j) => j.visa === "H-2A"),
        JSON.stringify({ dist: vfMix.disponibilidade.visaDistintos, fac: vfMix.facetas.visa, lista: listaA.total }));
      // (6) mês de início COM ANO (compatível com o formato antigo)
      const mar = (vfH2a.facetas.inicio || []).find((x) => x.v === "2026-03");
      const somaMeses = (vfH2a.facetas.inicio || []).reduce((a, x) => a + x.n, 0) + vfH2a.facetas.inicioSemData;
      const lMar = await _t("sheet=h2a-jun2026&inicio=2026-03"), lLegado = await _t("sheet=h2a-jun2026&inicio=3");
      check("📅 v181-L6: '📅 Mês de início' ganhou ANO — a faceta devolve AAAA-MM com `passado`, a soma dos meses + sem data fecha a planilha, e marcar 2026-03 devolve exatamente os 1.121 que o chip anuncia",
        mar && mar.n === 1121 && mar.passado === true && lMar === 1121 && somaMeses === 4964 &&
        (vfH2a.facetas.inicio || []).every((x) => /^\d{4}-\d{2}$/.test(x.v)),
        JSON.stringify({ mar, soma: somaMeses, lista: lMar }));
      check("📅 v181-L6: o formato ANTIGO (mês 1–12, que vive em job.filters de robô rodando e no aparelho de quem salvou filtro) continua casando — mês 3 de qualquer ano devolve o mesmo conjunto",
        lLegado === 1121 && (await _t("sheet=jul2026&inicio=10")) === 2625, `legado=${lLegado}`);
      const igL6 = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0&inicio=13&exp=abc&temporada=xxx&visa=H-9")).json;
      check("📅 v181-L6: parâmetro inválido das dimensões novas continua DECLARADO (nunca some calado, senão um filtro corrompido vira 'a planilha inteira' pro robô)",
        igL6.total === 4964 && igL6.ignorados.length === 4 &&
        ["inicio", "exp", "temporada", "visa"].every((p) => igL6.ignorados.some((x) => x.param === p)),
        JSON.stringify(igL6.ignorados));
      // (7) front: estado padrão, envio dos parâmetros e chip permanente
      const _appL6 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _i18nL6 = ["vf_sec_exp", "vf_sec_temporada", "vf_sec_visa", "vf_exp_0", "vf_exp_ate", "vf_temp_futura", "vf_temp_aberta", "vf_temp_encerrada", "vf_um_valor", "vf_meses_passados", "vf_chip_encerradas"];
      const _dL6 = (lang) => { const i = _appL6.indexOf(`  ${lang}: {`); const e = _appL6.indexOf("\n  }", i); return _appL6.slice(i, e); };
      const _ptL6 = _dL6("pt"), _enL6 = _dL6("en"), _esL6 = _dL6("es");
      const _faltaL6 = _i18nL6.filter((k) => !(_ptL6.includes(`"${k}":`) && _enL6.includes(`"${k}":`) && _esL6.includes(`"${k}":`)));
      check("🧰 v181-L6 (estrutural): a tela nasce com o padrão que esconde a temporada encerrada (manual E Passo 2 do robô), manda exp/temporada/visa/ocultarEncerradas na MESMA query da contagem, tem o chip permanente e a regra única de dimensão com 1 valor — com todas as strings novas nas 3 línguas",
        /ocultarEncerradas:true/.test(_appL6) && /\(st\.exp\|\|\[\]\)\.forEach/.test(_appL6) &&
        /"temporada","visa"/.test(_appL6) && /p\.set\("ocultarEncerradas","1"\)/.test(_appL6) &&
        _appL6.includes("vf_chip_encerradas") && _appL6.includes("const _soUmValor=") &&
        _appL6.includes("function _vfMesLabel(") && _faltaL6.length === 0,
        `faltando: ${_faltaL6.join(",")}`);
    }

    // ═══ 🏷️ v181 — LOTE 7: CARGO POR FAMÍLIA ═══
    // O título vem cru do DOL: em jan2026 são 1.806 títulos distintos, 1.192
    // aparecem 1 única vez, e "landscape laborer" (2.120) + "landscape
    // laborers" (231) + "laborer, landscape" (9) eram 3 chips pro MESMO
    // trabalho. A lista de cargos era, na prática, ruído que nunca cabia na
    // tela. Agora a faceta agrupa por FAMÍLIA (SOC quando existe, senão o
    // título normalizado) — e o valor antigo continua casando.
    {
      const _t7 = async (qs) => (await get("/api/sheet-meta?" + qs + "&top=1&email=0")).json.total; // 🛡️ v276
      const vfJ7 = (await get("/api/vagas/filtros?sheet=jan2026&email=0")).json;
      const vfH7 = (await get("/api/vagas/filtros?sheet=h2a-jun2026&email=0")).json;
      const land = (vfJ7.facetas.cargo || []).find((x) => x.v === "laborer landscape");
      check("🏷️ v181-L7: as 3 grafias de 'Landscape Laborer' (2.120 + 231 + 9) viraram UMA opção de 2.360 com o rótulo da grafia mais frequente — e clicar devolve exatamente os 2.360 que o chip anuncia",
        land && land.n === 2360 && land.label === "Landscape Laborer" && (await _t7("sheet=jan2026&cargo=" + encodeURIComponent("laborer landscape"))) === 2360,
        JSON.stringify(land));
      const crop = (vfH7.facetas.cargo || []).find((x) => x.v === "soc:crop farmworker greenhouse laborer nursery");
      check("🏷️ v181-L7: onde existe SOC (classificação oficial do governo) a família é o SOC — na H-2A as 393 grafias de farmworker viraram 1 opção de 2.515, faceta === lista, e a planilha caiu de 723 cargos distintos pra 38 famílias (cobertura do top-40: 100%)",
        crop && crop.n === 2515 && (await _t7("sheet=h2a-jun2026&cargo=" + encodeURIComponent(crop.v))) === 2515 &&
        vfH7.facetas.cargoDistintos === 38 && vfH7.facetas.cargo.reduce((a, x) => a + x.n, 0) === 4964,
        JSON.stringify({ crop, distintos: vfH7.facetas.cargoDistintos }));
      check("🏷️ v181-L7: jan2026 caiu de 1.806 cargos distintos pra 1.492 famílias e a cobertura do top-40 subiu de 55,8% pra 61,5% — a chave de família NUNCA contém vírgula (senão voltaria o bug do _csv do v179)",
        vfJ7.facetas.cargoDistintos === 1492 && vfJ7.disponibilidade.cargoDistintos === 1492 &&
        (vfJ7.facetas.cargo || []).every((x) => !x.v.includes(",")) &&
        vfJ7.facetas.cargo.reduce((a, x) => a + x.n, 0) / vfJ7.total > 0.6,
        JSON.stringify({ distintos: vfJ7.facetas.cargoDistintos, cobertura: (vfJ7.facetas.cargo.reduce((a, x) => a + x.n, 0) / vfJ7.total * 100).toFixed(1) }));
      // COMPATIBILIDADE: valor antigo (título literal salvo no aparelho / em
      // job.filters de robô rodando) continua casando — e agora com a família
      const compat = [];
      for (const [sh, v0, esp] of [["jan2026", "Landscape Laborer", 2360], ["jan2026", "landscape laborers", 2360],
        ["jan2026", "laborer, landscape", 2360], ["h2a-jun2026", "Farmworker", 2515],
        ["h2a-jun2026", "farmworkers and laborers, crop, nursery, and greenhouse", 2515],
        ["h2a-jun2026", "ag equipment operator", 1611]]) compat.push({ v0, esp, got: await _t7(`sheet=${sh}&cargo=${encodeURIComponent(v0)}`) });
      check("🏷️ v181-L7 (compatibilidade — o risco do lote): TODO valor de cargo antigo continua funcionando (título literal, outra grafia, com vírgula, caixa diferente) e agora cai na família certa — é o que impede um robô já rodando de perder o refill depois do deploy",
        compat.every((c) => c.got === c.esp), JSON.stringify(compat));
      // casos 1-2: contagem = lista continua verdade pras 30 opções mais comuns
      const divergem7 = [];
      for (const o of (vfH7.facetas.cargo || []).slice(0, 15)) {
        const l = await _t7(`sheet=h2a-jun2026&cargo=${encodeURIComponent(o.v)}`);
        if (l !== o.n) divergem7.push({ v: o.v, faceta: o.n, lista: l });
      }
      for (const o of (vfJ7.facetas.cargo || []).slice(0, 15)) {
        const l = await _t7(`sheet=jan2026&cargo=${encodeURIComponent(o.v)}`);
        if (l !== o.n) divergem7.push({ v: o.v, faceta: o.n, lista: l });
      }
      check("🏷️ v181-L7 (casos 1–2): nas 30 famílias mais comuns das 2 planilhas, a contagem do chip é EXATAMENTE o que a lista devolve — a regra da casa continua de pé depois de trocar o valor que a faceta emite",
        divergem7.length === 0, JSON.stringify(divergem7).slice(0, 300));
      // busca dentro da lista de cargos + multi-seleção somando
      const busca7 = (await get("/api/vagas/filtros?sheet=jan2026&email=0&cargoBusca=cook")).json;
      const duas = (busca7.facetas.cargo || []).slice(0, 2);
      const soma = duas.reduce((a, x) => a + x.n, 0);
      const listaDuas = await _t7(`sheet=jan2026&cargo=${encodeURIComponent(duas[0].v)}&cargo=${encodeURIComponent(duas[1].v)}`);
      check("🏷️ v181-L7: a busca dentro da lista de cargos continua olhando o TÍTULO de cada linha (a família entra se qualquer grafia dela casar) e marcar 2 famílias SOMA — OU dentro da mesma dimensão, como manda a régua do motor",
        duas.length === 2 && duas.every((x) => x.n > 0) && listaDuas === soma,
        JSON.stringify({ duas, soma, lista: listaDuas }));
      const _modL7 = fs.readFileSync(path.join(__dirname, "mod-filtros.js"), "utf8");
      const _appL7 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🏷️ v181-L7 (estrutural): a família é UMA função só no motor (_famNorm/_famKey, idempotente e sem vírgula), o índice guarda tFam + o mapa título→família da compatibilidade, e a tela mostra o rótulo humano da faceta (nunca a chave crua)",
        /const _famNorm = /.test(_modL7) && /const _famKey = /.test(_modL7) && /tFam: new Array\(n\)/.test(_modL7) &&
        /famPorTitulo/.test(_modL7) && /_cargoKeyDoCliente/.test(_modL7) &&
        !/set\.has\(ix\.tl\[i\]\)/.test(_modL7) && _appL7.includes("function _vfCargoLabel("),
        "família de cargo desfeita no motor ou na tela");
    }




    // ═══ 📧 ORDEM DO DONO (13/09/2026): e-mails de envio por plano — grátis 0
    // (nem vincula Gmail), VIP/VIPro 1 (só o principal), DoublePro 2, admin 6.
    // Cortesia (code) e trial contam como sem plano pago. ═══
    {
      const _exp = Date.now() + 30 * 86400_000;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "snd-free@test.com", name: "Snd Free" });
      const sFree = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "snd-vip@test.com", name: "Snd VIP", vip: { manualExpires: _exp, active: true, plan: "vip", source: "pix" }, plan: "vip" });
      const sVip = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "snd-vipro@test.com", name: "Snd VIPro", vip: { manualExpires: _exp, autoExpires: _exp, active: true, plan: "vipro", source: "pix" }, plan: "vipro" });
      const sVipro = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "snd-dp@test.com", name: "Snd DP", vip: { manualExpires: _exp, autoExpires: _exp, active: true, plan: "doublepro", source: "pix" }, plan: "doublepro" });
      const sDp = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "snd-code@test.com", name: "Snd Code", vip: { manualExpires: _exp, autoExpires: _exp, active: true, plan: "doublepro", source: "code" }, plan: "doublepro" });
      const sCode = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const sAdm = (await get("/api/status")).json;
      check("📧 ordem 13/09: e-mails de envio por plano — grátis 0 · VIP 1 · VIPro 1 · DoublePro 2 · cortesia (code) 0 · admin 6 (senderMax do /api/status = getMaxSenders, fonte única)",
        sFree.senderMax === 0 && sVip.senderMax === 1 && sVipro.senderMax === 1 && sDp.senderMax === 2 && sCode.senderMax === 0 && sAdm.senderMax === 6,
        JSON.stringify({ free: sFree.senderMax, vip: sVip.senderMax, vipro: sVipro.senderMax, dp: sDp.senderMax, code: sCode.senderMax, adm: sAdm.senderMax }));
      const _srvSnd = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _appSnd = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("📧 ordem 13/09: (estrutural) as 3 travas de Gmail extra (add-sender + 2 callbacks) explicam pelo PLANO (_msgLimiteSenders), o front mostra o nº de e-mails nos cards de plano (plan_emails_*) e a legenda do robô cobre 0/1/2/admin nas 3 línguas",
        (_srvSnd.match(/_msgLimiteSenders\(/g) || []).length >= 3 && /MAX_SENDER_EMAILS_DOUBLEPRO/.test(_srvSnd) && !/VIP Exclusivo/.test(fs.readFileSync(path.join(__dirname, "index.html"), "utf8")) &&
        ["snd_hint_admin", "snd_hint_dp", "snd_hint_1", "snd_hint_0", "plan_emails_1", "plan_emails_2"].every(k => (_appSnd.match(new RegExp(`"${k}":`, "g")) || []).length === 3) && !/U\.senderMax\|\|1/.test(_appSnd),
        "limite por plano não propagado no front/mensagens");
    }

    // ═══ 📋 v174: ALIMENTAÇÃO AUTOMÁTICA DAS PLANILHAS (ordem do dono, 13/09) ═══
    // Portado do site antigo: coleta do feed do DOL (rascunho → publicar),
    // vagas novas H-2A (entra nova / sai inativa), planilhas do mês (H-2A
    // publica sozinha acima do mínimo; H-2B SEMPRE rascunho) e o painel.
    // Feed falso (FEED_PORT): 14 vagas válidas + 1 duplicada + 1 sem e-mail.
    {
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
      const plSt0 = await get("/api/admin/planilhas/status");
      check("📋 v174+v208: painel dos robôs responde numa chamada só (enrich/h2aNovas/coleta/mensais — frescor saiu, v208) e os agendadores ficam DESLIGADOS no npm test",
        plSt0.json?.ok === true && plSt0.json.agendado === false && ["enrich", "h2aNovas", "coleta", "mensalH2a", "mensalH2b"].every((k) => plSt0.json[k] && typeof plSt0.json[k] === "object") && plSt0.json.fresh === undefined,
        plSt0.body.slice(0, 200));
      const enSt = await get("/api/admin/enrich/status");
      const enBad = await req2("POST", "/api/admin/enrich/start", { sheetKey: "nao-existe-2099" });
      check("📋 v174: enriquecimento — status parado (nunca gasta DOL sozinho no teste) e start numa planilha inexistente é 404",
        enSt.json?.ok === true && enSt.json.running === false && enBad.status === 404, `st=${enSt.body.slice(0, 80)} start=${enBad.status}`);
      // 🚨 v177-FIX2 (estrutural — o loop de enriquecimento bate no HOSTNAME
      // real do DOL, sem fake feed nenhum, então rodar o bot de ponta a ponta
      // aqui travaria/estouraria o teste; a régua é textual, igual outras
      // classes de bug assíncrono desta suíte):
      const _srvSrc177b = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🚨 v177-FIX2: DELETE /api/admin/sheet/:key para o bot de Enriquecimento se ele estiver rodando NESSA planilha (antes seguia gastando chamadas ao DOL à toa até o ciclo terminar sozinho, já que SHEET_EXTRAS[key] deixa de existir)",
        _srvSrc177b.includes('if(_enrichBot.running&&_enrichBot.sheetKey===key){') && _srvSrc177b.includes("_enrichBot.running=false;"),
        "DELETE não para mais o enrichBot em cima da planilha apagada");
      check("🚨 v177-FIX2: _saveEnrichedSheet só carimba savedAt quando gravou de fato em algum dos 3 destinos (built-in jan/jul, H-2A, extra) — antes carimbava incondicional, então uma planilha extra apagada em cima do bot rodando aparecia como 'salva' sem gravar NADA",
        _srvSrc177b.replace(/\s/g, "").includes("if(_gravou)_enrichBot.savedAt=Date.now();"),
        "_saveEnrichedSheet ainda carimba savedAt incondicionalmente");
      // 📥 COLETA manual (rascunho → publicar)
      const cs = await req2("POST", "/api/admin/sheet/coleta-start", { visa: "H-2B", sheetKey: "teste2099", sheetName: "Teste 2099" });
      check("📥 v174: coleta-start aceita e dispara em background", cs.json?.ok === true && cs.json.key === "teste2099", cs.body.slice(0, 120));
      let stC = null;
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); stC = (await get("/api/admin/sheet/coleta-status")).json; if (stC && stC.running === false && stC.finishedAt) break; }
      check("📥 v174: coleta terminou: 14 vagas (dedupe tirou a duplicada, qualidade tirou a sem e-mail), 100% e em RASCUNHO",
        stC?.running === false && !stC?.error && stC?.count === 14 && stC?.progress === 100 && stC?.published === false,
        JSON.stringify({ count: stC?.count, error: stC?.error, published: stC?.published }));
      const sl1 = await get("/api/sheets-list");
      const admL = await get("/api/admin/sheets");
      check("🔒 v174: rascunho NÃO aparece pros usuários, mas o admin vê com published:false (e a H-2A built-in agora está na lista do painel)",
        !(sl1.json?.sheets || []).some((x) => x.key === "teste2099") && (admL.json?.sheets || []).some((x) => x.key === "teste2099" && x.published === false && x.withEmail === 14) && (admL.json?.sheets || []).some((x) => x.key === "h2a-jun2026" && x.builtin === true),
        JSON.stringify((admL.json?.sheets || []).map((x) => [x.key, x.published])));
      const pub = await req2("POST", "/api/admin/sheet/coleta-publish", { key: "teste2099" });
      const sl2 = await get("/api/sheets-list");
      const sm2 = await get("/api/sheet-meta?sheet=teste2099&email=0&skip=0&top=5");
      check("📢 v174: publicar libera a planilha pros usuários (lista + Manual abre as vagas)",
        pub.json?.ok === true && pub.json.count === 14 && (sl2.json?.sheets || []).some((x) => x.key === "teste2099" && x.count === 14) && Array.isArray(sm2.json?.jobs) && sm2.json.jobs.length > 0,
        `pub=${pub.body.slice(0, 80)} meta=${sm2.body.slice(0, 80)}`);
      // 🚨 v177-FIX2 (auditoria 14/09/2026): a MESMA coleta ("teste2099", ainda
      // a última rodada em dolColeta.key) tem que aparecer publicada no painel
      // — antes co.published nunca existia no objeto, então o admin.html
      // sempre mostrava "em rascunho, publique abaixo" mesmo depois disso.
      const plStPub = await get("/api/admin/planilhas/status");
      check("🚨 v177-FIX2: statusPainel().coleta.published reflete a publicação real feita agora mesmo (não fica preso em 'rascunho' depois de publicar)",
        plStPub.json?.coleta?.key === "teste2099" && plStPub.json?.coleta?.published === true, JSON.stringify(plStPub.json?.coleta));
      const pub2 = await req2("POST", "/api/admin/sheet/coleta-publish", { key: "teste2099" });
      check("📢 v174: publicar de novo é idempotente (jaPublicada) — o radar nunca é avisado 2x", pub2.json?.ok === true && pub2.json.jaPublicada === true, pub2.body.slice(0, 100));
      // 🌾 VAGAS NOVAS H-2A — o total esperado sai do PRÓPRIO bundle com a
      // MESMA regra de inatividade (status morto OU temporada encerrada).
      const _h2aBundle = JSON.parse(fs.readFileSync(path.join(__dirname, "h2a_jun2026_compact.json"), "utf8"));
      const _hojeISO = new Date().toISOString().slice(0, 10);
      const _deadRe = /denied|withdrawn|invalidat|expired|cancel/i;
      const h2aVivas = _h2aBundle.filter((r) => !_deadRe.test(String(r.st || "")) && !(r.de && /^\d{4}-\d{2}-\d{2}$/.test(r.de) && r.de < _hojeISO)).length;
      const hn1 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
      check("🌾 v174: Vagas Novas H-2A sincroniza — entram as 14 novas do feed, saem as de temporada encerrada",
        hn1.json?.ok === true && hn1.json.added === 14 && hn1.json.total === h2aVivas + 14, `esperado total=${h2aVivas + 14} | ` + hn1.body.slice(0, 160));
      const hn2 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
      check("🌾 v174: 2ª rodada não duplica NADA (0 novas, total estável)",
        hn2.json?.ok === true && hn2.json.added === 0 && hn2.json.jaTinha >= 14 && hn2.json.total === h2aVivas + 14, hn2.body.slice(0, 160));
      fs.writeFileSync(path.join(DATA, "h2a_feed_withdraw.flag"), "1");
      const hn3 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
      fs.unlinkSync(path.join(DATA, "h2a_feed_withdraw.flag"));
      check("🌾 v174: vaga que virou 'withdrawn' no DOL é RETIRADA da planilha (status atualizado + removida)",
        hn3.json?.ok === true && hn3.json.removidas === 1 && hn3.json.atualizadas >= 1 && hn3.json.total === h2aVivas + 13, hn3.body.slice(0, 160));
      const slH2aN = await get("/api/sheets-list");
      const _h2aRow = (slH2aN.json?.sheets || []).find((x) => x.key === "h2a-jun2026");
      check("🌾 v174: vagas novas H-2A já contam como disponíveis pros usuários (planilha H-2A de sempre, sem aba nova)",
        _h2aRow && _h2aRow.count === h2aVivas + 13 && _h2aRow.available >= 13, JSON.stringify(_h2aRow || {}).slice(0, 140));

      // 🗓️ v207 — o arquivo de HOJE ainda não existe no DOL (caso real 19/09/2026, sábado)
      fs.writeFileSync(path.join(DATA, "h2a_feed_404_hoje.flag"), "1");
      const hn4 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
      fs.unlinkSync(path.join(DATA, "h2a_feed_404_hoje.flag"));
      const _stH2a = (await get("/api/admin/planilhas/status")).json;
      check("🗓️ v207: arquivo de HOJE ausente no DOL (404) NÃO é erro — o robô usa o dia anterior, termina ok, avisa no log e a aba não mostra ⚠️ Erro",
        hn4.json?.ok === true && !_stH2a?.h2aNovas?.lastError && (_stH2a?.botLogs || []).some((l) => l.bot === "h2a-novas" && /ainda não publicou/.test(l.msg)) && (_stH2a?.botLogs || []).some((l) => l.bot === "h2a-novas" && /Usando o arquivo de/.test(l.msg)),
        JSON.stringify({ r: hn4.json, lastError: _stH2a?.h2aNovas?.lastError }));
      fs.writeFileSync(path.join(DATA, "h2a_feed_404_todos.flag"), "1");
      const hn5 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
      fs.unlinkSync(path.join(DATA, "h2a_feed_404_todos.flag"));
      const _stH2a2 = (await get("/api/admin/planilhas/status")).json;
      check("🗓️ v207: DOL sem arquivo nos últimos 7 dias → erro HONESTO (nunca finge sucesso nem inventa vaga), planilha intacta e nova tentativa automática agendada em 1h (nunca preso até o ciclo de 12h)",
        hn5.json?.ok === false && /não publicou/.test(hn5.json?.error || "") && hn5.json.proximaTentativa > Date.now() && _stH2a2?.h2aNovas?.totalPlanilha === hn4.json.total && _stH2a2?.h2aNovas?.proximaTentativa === hn5.json.proximaTentativa,
        JSON.stringify(hn5.json));
      const hn6 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
      const _stH2a3 = (await get("/api/admin/planilhas/status")).json;
      check("🗓️ v207: o ciclo seguinte com o DOL de volta limpa o erro e a tentativa agendada", hn6.json?.ok === true && !_stH2a3?.h2aNovas?.lastError && !_stH2a3?.h2aNovas?.proximaTentativa, hn6.body.slice(0, 120));
      // 📅 H-2A DO MÊS — publica sozinha (H2A_BIM_MIN_PUBLICAR=10 no env do teste)
      const bim1 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", {});
      check("🌾 v174: última rodada há 1 mês (fixture) → o disparo MENSAL responde NA HORA (started:true) com a chave do mês",
        bim1.json?.ok === true && bim1.json.started === true && /^h2a-\d{6}$/.test(bim1.json.key || ""), bim1.body.slice(0, 160));
      let bimSt = null;
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); bimSt = (await get("/api/admin/sheet/coleta-status")).json; if (bimSt && !bimSt.running && bimSt.finishedAt && bimSt.key === bim1.json?.key) break; }
      check("🌾 v174: robô junta 6 feeds (90 dias), dedupa, PUBLICA sozinho (acima do mínimo) e reporta 100%",
        bimSt && bimSt.error === null && bimSt.count === 14 && bimSt.published === true && bimSt.progress === 100 && bimSt.bimestral?.lastKey === bim1.json?.key && bimSt.bimestral?.lastPublished === true,
        JSON.stringify({ error: bimSt?.error, count: bimSt?.count, published: bimSt?.published, lastKey: bimSt?.bimestral?.lastKey }));
      const shlBim = await get("/api/sheets-list");
      const _shBim = (shlBim.json?.sheets || []).find((x) => x.key === bim1.json?.key);
      check("🌾 v174: a \"H-2A <Mês> <Ano>\" já aparece na lista dos usuários (visa H-2A, nome certo)",
        _shBim && _shBim.count === 14 && _shBim.visa === "H-2A" && /^H-2A /.test(String(_shBim.name || "")), JSON.stringify(_shBim || {}).slice(0, 160));
      const bim2 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", {});
      check("🌾 v174: rodar de novo DENTRO do mesmo mês é recusado (409 skipped) — nunca duplica planilha",
        bim2.status === 409 && bim2.json?.skipped === true, `status=${bim2.status} body=${bim2.body.slice(0, 120)}`);
      const bim3 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", { force: true });
      let bimSt3 = null;
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); bimSt3 = (await get("/api/admin/sheet/coleta-status")).json; if (bimSt3 && !bimSt3.running && bimSt3.finishedAt && bimSt3.startedAt > (bimSt?.startedAt || 0)) break; }
      check("🌾 v174: force=true refaz a do mês do zero (MESMA chave, sem duplicar)",
        bim3.json?.ok === true && bim3.json.key === bim1.json?.key && bimSt3?.count === 14 && bimSt3?.error === null,
        `resp=${bim3.body.slice(0, 100)} status=${JSON.stringify({ count: bimSt3?.count, error: bimSt3?.error })}`);
      // 🧊 H-2B DO MÊS — RASCUNHO SEMPRE (auto-publicar é exceção SÓ do H-2A)
      const h2b1 = await req2("POST", "/api/admin/sheet/h2b-mensal-run", { force: true });
      check("🧊 v174: robô H-2B mensal dispara em background (started:true) com a chave do mês",
        h2b1.json?.ok === true && h2b1.json.started === true && /^h2b-\d{6}$/.test(h2b1.json.key || ""), h2b1.body.slice(0, 160));
      let h2bSt = null;
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); h2bSt = (await get("/api/admin/sheet/coleta-status")).json; if (h2bSt && !h2bSt.running && h2bSt.finishedAt && h2bSt.key === h2b1.json?.key) break; }
      check("🧊 v174: coleta os 6 feeds H-2B (14 válidas) e fica em RASCUNHO mesmo acima do mínimo — publicar sozinho segue SÓ do H-2A",
        h2bSt && h2bSt.error === null && h2bSt.count === 14 && h2bSt.published === false && h2bSt.progress === 100 && h2bSt.mensalH2b?.lastKey === h2b1.json?.key && h2bSt.mensalH2b?.lastPublished === false,
        JSON.stringify({ error: h2bSt?.error, count: h2bSt?.count, published: h2bSt?.published, lastKey: h2bSt?.mensalH2b?.lastKey }));
      const shlH2bDraft = await get("/api/sheets-list");
      check("🧊 v174: em rascunho, a H-2B do mês NÃO aparece pros usuários",
        !(shlH2bDraft.json?.sheets || []).some((x) => x.key === h2b1.json?.key), JSON.stringify((shlH2bDraft.json?.sheets || []).map((x) => x.key)));
      const h2bPub = await req2("POST", "/api/admin/sheet/coleta-publish", { key: h2b1.json?.key });
      const shlH2bPub = await get("/api/sheets-list");
      const _shH2b = (shlH2bPub.json?.sheets || []).find((x) => x.key === h2b1.json?.key);
      check("🧊 v174: publicada com 1 clique, a \"H-2B <Mês> <Ano>\" aparece pra todo mundo e vira a H-2B MAIS NOVA (latestH2b)",
        h2bPub.json?.ok === true && h2bPub.json.count === 14 && _shH2b && _shH2b.count === 14 && /^H-2B /.test(String(_shH2b.name || "")) && shlH2bPub.json?.latestH2b === h2b1.json?.key && _shH2b.latest === true,
        JSON.stringify({ pub: h2bPub.body.slice(0, 80), row: _shH2b, latest: shlH2bPub.json?.latestH2b }));
      const h2b2 = await req2("POST", "/api/admin/sheet/h2b-mensal-run", {});
      check("🧊 v174: rodar de novo DENTRO do mesmo mês sem force é recusado (409)",
        h2b2.status === 409 && h2b2.json?.skipped === true, `status=${h2b2.status} body=${h2b2.body.slice(0, 120)}`);
      // 📜 log humano dos robôs — DB_BOT_LOGS era escrito por 7 robôs e nunca lido
      const plSt1 = await get("/api/admin/planilhas/status");
      const _bl = plSt1.json?.botLogs || [];
      check("📜 v174: o painel recebe o log humano de TODOS os robôs (botLogs) — vagas novas H-2A, H-2A do mês e H-2B do mês aparecem com rótulo e tipo",
        _bl.length >= 3 && ["h2a-novas", "h2a-bimestral", "h2b-mensal"].every((b) => _bl.some((l) => l.bot === b && l.botLabel && l.msg && l.ts)) && fs.readFileSync(path.join(__dirname, "admin.html"), "utf8").includes('id="bl-log"'),
        JSON.stringify(_bl.slice(0, 3)).slice(0, 200));
      // ═══ 🚨 v177-FIX7 (7ª leva da auditoria) ═══
      // Coleta manual com janela de datas que corta quase tudo: o erro
      // culpava SEMPRE o DOL, nunca o filtro que o próprio admin escolheu.
      const _csJan = await req2("POST", "/api/admin/sheet/coleta-start", { visa: "H-2B", sheetKey: "teste-janela", sheetName: "Teste Janela", beginFrom: "2030-01-01", beginTo: "2030-12-31" });
      let _stJan = null;
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); _stJan = (await get("/api/admin/sheet/coleta-status")).json; if (_stJan && _stJan.running === false && _stJan.finishedAt && _stJan.key === "teste-janela") break; }
      const _slJan = await get("/api/sheets-list");
      check("🚨 v177-FIX7: coleta em que a JANELA DE DATAS do próprio admin cortou quase tudo falha nomeando o filtro (com as datas escolhidas) em vez de culpar o DOL — e, como sempre, nada é salvo",
        _csJan.json?.ok === true && _stJan && /fora da janela de datas/i.test(_stJan.error || "") && /2030-01-01/.test(_stJan.error || "") &&
        !(_slJan.json?.sheets || []).some((x) => x.key === "teste-janela"),
        JSON.stringify({ erro: (_stJan?.error || "").slice(0, 140) }));
      const _modFresh = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
      // 🗑️ v208 (dono, 19/09/2026): o robô de frescor foi RETIRADO por decisão de
      // produto — vaga já enriquecida nunca mais é reconsultada no DOL. A guarda
      // v177-FIX7/v182-L8 media a cobertura do frescor; agora vira uma guarda
      // NEGATIVA permanente (nunca deixa o robô voltar) + prova que a lista de
      // planilhas publicadas (renomeada `planilhasPublicadas`, ainda usada pelo
      // vigia de saúde) continua viva.
      check("🗑️ v208 (estrutural, guarda permanente): o robô de frescor não existe mais — nenhuma reconferência de vaga já completa (freshBot/runFreshCycle/aplicarFrescor/fresh-run) sobrevive em lugar nenhum",
        !_modFresh.includes("freshBot") && !_modFresh.includes("runFreshCycle") && !_modFresh.includes("aplicarFrescor") &&
        !fs.readFileSync(path.join(__dirname, "server.js"), "utf8").includes("fresh-run") &&
        !fs.readFileSync(path.join(__dirname, "admin.html"), "utf8").includes("plFreshRun") &&
        _modFresh.includes("function planilhasPublicadas()") && _modFresh.includes('meta[k]?.published !== false'),
        "resquício do robô de frescor encontrado");
      // 🔒 admin-only + estrutural
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
      const pl403 = await Promise.all([req2("POST", "/api/admin/sheet/h2a-bimestral-run", {}), req2("POST", "/api/admin/sheet/coleta-start", { sheetKey: "x" }), get("/api/admin/planilhas/status"), req2("POST", "/api/admin/sheet/coleta-publish", { key: "teste2099" })]);
      check("🔒 v174: usuário comum recebe 403 nos robôs de planilha (admin-only)", pl403.every((r) => r.status === 403), pl403.map((r) => r.status).join(","));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _srvPl = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _modPl = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
      const _admPl = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      check("📋 v174: (estrutural) H-2B mensal NUNCA publica sozinha (autoPublish:false) e a H-2A sim, upload dispara o enriquecimento e o painel tem a aba Planilhas & Robôs",
        /runH2bMensal[\s\S]{0,400}autoPublish: false/.test(_modPl) && /runH2aMensal[\s\S]{0,400}autoPublish: true/.test(_modPl) && _srvPl.includes("PLANILHAS.autoEnrichCycle()") &&
        _admPl.includes('data-view="planilhas"') && _admPl.includes("function loadPlanilhas(") && _admPl.includes("/api/admin/planilhas/status") && _admPl.includes("/api/admin/sheet/coleta-publish"),
        "estrutura do v174 incompleta");
      // 🚫 v217 (dono, 19/09/2026 — "resumi o programa todo para nao gastar...
      // robos só precisa 2 vezes por ano quando entrar planilha nova"):
      // NENHUM robô de planilha pode ter agendamento por relógio. Guarda
      // estrutural PERMANENTE — mede a função inteira (do "function
      // iniciarAgendadores" até o próximo "function " de nível 2), não o
      // arquivo todo, pra pegar de verdade um T()/I() que volte lá dentro.
      const _iniAgFn = (_modPl.match(/function iniciarAgendadores\(\)[\s\S]*?\n  \}/) || [""])[0];
      check("🚫 v217 (estrutural, guarda permanente): iniciarAgendadores() não registra NENHUM setTimeout/setInterval — robôs de planilha são só por clique do admin, nunca por relógio",
        _iniAgFn.length > 20 && !/setTimeout|setInterval/.test(_iniAgFn) && _srvPl.includes("PLANILHAS.iniciarAgendadores()"),
        "iniciarAgendadores() ainda agenda algo sozinho: " + _iniAgFn.slice(0, 200));
      const _plStatusAg = await get("/api/admin/planilhas/status");
      check("🚫 v217: /api/admin/planilhas/status devolve agendado:false (o painel mostra \"Só manual\") mesmo em produção — não só no npm test",
        _plStatusAg.json?.agendado === false, JSON.stringify(_plStatusAg.json?.agendado));

      // 📧 v282 (dono, 24/09/2026 — "eu preciso que todas as vagas sempre
      // estejam disponível com um e-mail disponível... depois do deploy,
      // automaticamente... eu não quero clicar em nada"): 1 disparo de
      // enriquecimento por BOOT — mas fora de iniciarAgendadores(), pra guarda
      // acima continuar provando algo de verdade (nunca um setInterval).
      const _bootHookBlock = _srvPl.slice(_srvPl.indexOf("PLANILHAS.iniciarAgendadores();"), _srvPl.indexOf("PLANILHAS.iniciarAgendadores();") + 2500);
      check("📧 v282 (estrutural, guarda permanente): existe 1 hook de BOOT (setTimeout, nunca setInterval) logo depois de PLANILHAS.iniciarAgendadores() chamando autoEnrichCycle() — garante e-mail das vagas sem precisar de clique do admin, mas sem virar vigia recorrente",
        /setTimeout\(/.test(_bootHookBlock) && !/setInterval\(/.test(_bootHookBlock) && /PLANILHAS\.autoEnrichCycle\(\)/.test(_bootHookBlock),
        _bootHookBlock.slice(0, 200));
      check("📧 v282 (estrutural): autoEnrichCycle() continua com o guard isTest — o hook de boot nunca bate rede real no npm test (mesma proteção que já existia pro clique manual)",
        /async function autoEnrichCycle\(\)\s*\{[\s\S]{0,200}if\s*\(isTest\)/.test(_modPl));
    }

    // 💳 v175: os pedidos criados acima (blocos de compra) geraram aviso por
    // e-mail pros admins PELA CONTA DE NOTIFICAÇÕES (outbox), com assunto,
    // dados do cliente e nº do pedido — fonte única _mensagemPedidoAdmin.
    {
      const _box = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "notif_outbox.json"), "utf8")); } catch { return []; } })();
      const _ped = _box.filter((x) => x.tipo === "pedido");
      check("💳 v175: cada pedido novo gera aviso por e-mail pros e-mails de admin pela conta de notificações (assunto 'Novo pedido de plano', nº do pedido, WhatsApp e link do painel)",
        _ped.length >= 2 && _ped.some((x) => /Novo pedido de plano/.test(x.subject) && /Pedido: #/.test(x.text) && /\/admin/.test(x.text)) && _ped.every((x) => x.from === "suporteh2bapply@gmail.com" && /@/.test(x.to)),
        JSON.stringify(_ped.slice(0, 2).map((x) => ({ to: x.to, s: String(x.subject).slice(0, 40) }))));
    }

    // ═══ 📡 v134: RADAR DE VAGAS (aprovado pelo dono) + funil do limite ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radaruser@test.com", name: "Radar User" });
    const rdVazio = await req2("POST", "/api/radar", { estados: [], cidade: "", q: "" });
    check("📡 v134: radar sem NENHUM filtro é recusado (400) — radar de tudo viraria spam", rdVazio.status === 400, rdVazio.body.slice(0, 120));
    const rdSave = await req2("POST", "/api/radar", { estados: ["MA"], cidade: "Martha's Vineyard", q: "housekeeper" });
    const rdGet = await get("/api/radar");
    // ⚠️ ATUALIZADO no v182 LOTE 9: o radar guarda o SNAPSHOT INTEIRO dos
    // filtros em `radar.filtros` (antes só 4 dimensões soltas). O corpo LEGADO
    // ({estados, cidade, q, categoria}) continua sendo aceito — front antigo em
    // cache não pode perder o radar de ninguém.
    check("📡 v134 + v182-L9: radar salva e aparece no GET (corpo legado continua aceito, normalizado pro snapshot único)",
      rdSave.json?.ok === true && rdGet.json?.radar?.filtros?.estado?.[0] === "MA" &&
      rdGet.json?.radar?.filtros?.cidade?.[0] === "Martha's Vineyard" && rdGet.json?.radar?.ativo === true,
      rdGet.body.slice(0, 200));
    const rdOff = await req2("POST", "/api/radar", { remove: true });
    const rdGet2 = await get("/api/radar");
    check("📡 v134: desligar o radar remove de verdade", rdOff.json?.ok === true && rdGet2.json?.radar === null, rdGet2.body.slice(0, 100));
    // v174: além do upload manual do admin, a coleta do DOL, a publicação de
    // rascunho e as vagas novas H-2A também avisam o radar (bloco 📋 acima);
    // aqui fica a prova comportamental do caminho do upload, de ponta a
    // ponta, em vez de só contar chamadas de registrarVagasNovasNoRadar() no texto.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radaruser@test.com", name: "Radar User" });
    // estado no formato NOME POR EXTENSO — é o que o front realmente manda
    // (o VF guarda "MASSACHUSETTS", não a sigla "MA" — normalizeStateName no
    // servidor) e é o mesmo formato do campo `s` das planilhas compactas.
    await req2("POST", "/api/radar", { estados: ["MASSACHUSETTS"], cidade: "", q: "housekeeper" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const rdUpload = await req2("POST", "/api/admin/sheet/upload", {
      name: "Radar Teste", key: "radar-teste",
      data: [{ c: "H-400-RADAR-0001", e: "vaga@radarteste.com", n: "Radar Teste LLC", t: "Housekeeper", s: "MASSACHUSETTS" }],
    });
    check("📡 v134: admin consegue publicar planilha nova (/api/admin/sheet/upload)", rdUpload.json?.ok === true, rdUpload.body.slice(0, 160));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radaruser@test.com" });
    const rdGet3 = await get("/api/radar");
    // ⚠️ ATUALIZADO no v189 LOTE 7: esta asserção codificava um comportamento
    // ERRADO — dizia "avisa de verdade" e checava `totalAvisos`, um contador
    // que a tela mostrava como "🔔 N avisos já enviados" e que NUNCA
    // correspondeu a aviso nenhum (não há push nesta reconstrução: pushToUser
    // é no-op, PUSH_ENABLED=false, e a função nem chegava a chamá-lo). O que o
    // radar faz de verdade — e agora o que se mede — é CONTAR as vagas novas
    // que combinam com o filtro salvo, pra pessoa ver quando abrir o site.
    check("📡 v134 + v189-L7: vaga nova casando com o radar é CONTADA de verdade (novas sobe com o nº real de vagas que combinam, ultimaEm carimbado) — e o contador de 'avisos enviados', que nunca correspondeu a aviso nenhum, morreu",
      rdGet3.json?.radar?.novas === 1 && rdGet3.json?.radar?.ultimaEm > 0 &&
      !("totalAvisos" in (rdGet3.json?.radar || {})) && !("lastPushAt" in (rdGet3.json?.radar || {})),
      JSON.stringify(rdGet3.json?.radar || {}).slice(0, 200));
    // 🚫 v189 LOTE 7 — GUARDA PERMANENTE: enquanto PUSH_ENABLED for false, NENHUM
    // arquivo servido ao cliente pode prometer aviso/notificação. Não é questão
    // de texto: não existe canal nenhum (sem VAPID, sem rota /api/push/*,
    // pushToUser vazio), então toda promessa dessas é mentira pro usuário no
    // momento em que ele mais confia no site (logo depois do Pix).
    const _cfgL7 = fs.readFileSync(path.join(__dirname, "mod-config.js"), "utf8");
    const _appL7 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    const _idxL7 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const _tutL7 = fs.readFileSync(path.join(__dirname, "tutorial-conteudo.html"), "utf8");
    const _pushOff = /const PUSH_ENABLED\s*=\s*false/.test(_cfgL7);
    // Tira comentários antes de medir: a guarda mede o que é EXECUTADO/servido,
    // nunca o texto que explica por que a promessa foi removida (senão o
    // próprio comentário "não promete mais aviso no celular" derrubaria o
    // teste — a classe de falso-positivo da guarda anti-função-fantasma).
    const _semCom = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
    const _semHtmlCom = (txt) => txt.replace(/<!--[\s\S]*?-->/g, " ");
    const _proibidas = [/Avisamos por notifica/i, /aviso no celular/i, /push no celular/i, /notifica[cç][aã]o no celular/i, /ative as notifica/i, /notifica[cç][õo]es ativadas/i];
    const _achadas = [];
    for (const [nome, txt] of [["app.js", _semCom(_appL7)], ["index.html", _semHtmlCom(_semCom(_idxL7))], ["tutorial-conteudo.html", _semHtmlCom(_tutL7)]])
      for (const rx of _proibidas) { const m = txt.match(rx); if (m) _achadas.push(nome + ": " + m[0]); }
    check("🚫 v189-L7 (guarda permanente): com PUSH_ENABLED=false, nenhum arquivo servido ao cliente promete aviso/notificação — o site parou de pedir uma permissão que nunca usaria e de prometer 'avisamos na hora' logo depois do Pix",
      _pushOff && _achadas.length === 0,
      `pushOff=${_pushOff} promessas=[${_achadas.join(" | ")}]`);
    check("🚫 v189-L7 (estrutural): o convite de push e o auto-request no primeiro login foram REMOVIDOS (renderPushAsk/requestPushPermission/_autoPushSetup e os divs vazios que os hospedavam) — não sobrou plumbing morto pedindo permissão",
      !/renderPushAsk|requestPushPermission|_autoPushSetup|_renderNotifToggle/.test(_semCom(_appL7)) &&
      !_idxL7.includes("plan-push-ask") && !_idxL7.includes("auto-push-ask") &&
      !/radar_alerts/.test(_appL7),
      "sobrou código de pedido de push no front");
    check("🌐 v189-L7: as chaves novas do Radar honesto existem nas 3 línguas (regra do dicionário) e o texto do radar não promete mais aviso",
      (_appL7.match(/"radar_novas":/g) || []).length === 3 && (_appL7.match(/"radar_novas_zero":/g) || []).length === 3 &&
      !/radar_sub":"[^"]*celular/.test(_appL7),
      "radar_novas/radar_novas_zero não estão nas 3 línguas ou o radar_sub ainda fala em celular");
    // ══════════════════════════════════════════════════════════════════════
    // 📣 v197 — LOTE 15: OS NÚMEROS E AS PROMESSAS BATEM COM O CÓDIGO
    // Cinco textos vendiam um produto diferente do que o motor entrega. A
    // regra v172j ("toda mudança em limite/preço/regra de plano espelhada no
    // MESMO commit") vale pros textos também — por isso estas guardas são
    // PERMANENTES e derivam de mod-config.js / do motor real.
    // ══════════════════════════════════════════════════════════════════════
    {
      const _PL15 = require(path.join(__dirname, "mod-config.js")).PLAN_LIMITS_NEW;
      const _idx15 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _app15 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _cu15 = fs.readFileSync(path.join(__dirname, "como-usar.html"), "utf8");
      const _tut15 = fs.readFileSync(path.join(__dirname, "tutorial-conteudo.html"), "utf8");
      const _srv15 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _semHtml15 = (t2) => t2.replace(/<!--[\s\S]*?-->/g, " ");
      const _semJs15 = (t2) => t2.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

      // (1) os números de envio/dia citados na landing e na calculadora saem
      // de PLAN_LIMITS_NEW — a landing prometia "até 400 candidaturas/dia"
      // pro ROBÔ (o automático máximo é 200) e "prioridade máxima na fila",
      // que não existe em lugar nenhum do código.
      const _totVipro = _PL15.vipro.manual + _PL15.vipro.auto;
      const _totDp = _PL15.doublepro.manual + _PL15.doublepro.auto;
      check("📣 v197-L15/v218 (guarda permanente): os números de envio/dia da landing e da calculadora saem de PLAN_LIMITS_NEW — e as promessas que o código não cumpre ('prioridade máxima na fila', 'aumenta seu limite diário', robô de 400/dia) sumiram",
        _idx15.includes(`${_PL15.vip.manual} manuais no Manual, ${_PL15.vipro.manual} manuais + ${_PL15.vipro.auto} automáticas no Turbo e ${_PL15.doublepro.manual} manuais + ${_PL15.doublepro.auto} automáticas no Máximo`) &&
        _idx15.includes(`data-i18n="roi_vipro">Turbo — ${_totVipro}/dia (manual + automático)`) &&
        _idx15.includes(`data-i18n="roi_dp">Máximo — ${_totDp}/dia (manual + automático)`) &&
        (_app15.match(/"roi_vipro":/g) || []).length === 3 &&
        !/prioridade m[áa]xima na fila/i.test(_semHtml15(_idx15)) &&
        !/aumenta seu limite di[áa]rio/i.test(_semHtml15(_idx15)) &&
        !/at[ée] 400 candidaturas\/dia/i.test(_semHtml15(_idx15)),
        "algum número da landing/calculadora divergiu de mod-config.js ou uma das promessas voltou");

      // (2) o modal morto #terms-m (zero openers) anunciava "Free (20 manual
      // + 10 auto/dia)" — a mentira mais grave da página, num produto onde a
      // conta grátis envia ZERO desde o v172.
      check("📣 v197-L15: o modal morto #terms-m (sem NENHUM botão que o abrisse) foi removido — ele anunciava 'Free (20 manual + 10 auto/dia)' e o free envia 0/0",
        !/id="terms-m"/.test(_semHtml15(_idx15)) && !/Free \(20 manual/.test(_semHtml15(_idx15)) &&
        _PL15.free.manual === 0 && _PL15.free.auto === 0,
        "o modal morto continua no index.html");

      // (3) o intervalo do robô é o do MOTOR (calcSmartInterval 6,5–7,5min):
      // a tela dizia 5–6 min em 5 lugares e CALCULAVA a previsão de término
      // com 5,5min por envio — ~27% otimista num número usado pra planejar.
      const _eng15 = fs.readFileSync(path.join(__dirname, "mod-engine-core.js"), "utf8");
      const _motorOk = _eng15.includes("const MIN_MS = 6.5 * 60 * 1000;") && _eng15.includes("const MAX_MS = 7.5 * 60 * 1000;");
      const _servidos15 = { "index.html": _semHtml15(_idx15), "app.js": _semJs15(_app15), "como-usar.html": _semHtml15(_cu15), "tutorial-conteudo.html": _semHtml15(_tut15) };
      const _mentemIntervalo = Object.entries(_servidos15).filter(([, t2]) => /5[–-]6 ?min|5 ?[–-] ?6 minutos|5\.5\/|=5\.5|\|\|330/.test(t2)).map(([f]) => f);
      check("📣 v197-L15 (guarda permanente): nenhum arquivo servido diz '5–6 min' nem calcula a previsão com 5,5min — o motor manda a cada 6,5–7,5min (~7) desde o v118, e a tela agora tem UMA constante (AUTO_INT_MIN/MAX/AVG)",
        _motorOk && _mentemIntervalo.length === 0 &&
        /const AUTO_INT_MIN=6\.5, AUTO_INT_MAX=7\.5, AUTO_INT_AVG=7;/.test(_app15) &&
        (_app15.match(/AUTO_INT_AVG/g) || []).length >= 4,
        `motor=${_motorOk} ainda mentem=[${_mentemIntervalo.join(",")}]`);

      // (4) VIP/VIPro só podem 1 Gmail e o DoublePro no máximo 2 (403 na cara
      // de quem tentar o 3º) — 4 telas mandavam "adicionar 2 ou mais contas".
      const _todos15 = { ..._servidos15, "server.js": _semJs15(_srv15) };
      const _mandam2 = Object.entries(_todos15).filter(([, t2]) => /2 ou mais contas Gmail|2\+ contas Gmail/.test(t2)).map(([f]) => f);
      check("📣 v197-L15/v218 (guarda permanente): nenhum texto do site manda 'adicionar 2 ou mais / 2+ contas Gmail' — Manual e Turbo têm direito a 1 conta e o Máximo a 2; o texto agora é o MESMO nos 8 pontos",
        _mandam2.length === 0 &&
        (_idx15.match(/o Máximo reveza entre 2 Gmails/g) || []).length >= 3 &&
        _cu15.includes("o Máximo reveza entre 2 Gmails") && _tut15.includes("o Máximo reveza entre 2 Gmails") &&
        (_srv15.match(/o Máximo reveza entre 2 Gmails/g) || []).length >= 2,
        `ainda mandam 2+: [${_mandam2.join(",")}] `);
      // texto NOVO passa pelo dicionário nas 3 línguas (regra 6f)
      check("📣 v197-L15: o aviso de Gmail do Perfil virou UMA chave de dicionário nas 3 línguas (gmail_contas) — texto novo nunca entra fixo no markup",
        (_app15.match(/"gmail_contas":/g) || []).length === 3 && _idx15.includes('data-i18n="gmail_contas"'),
        "gmail_contas não está nas 3 línguas ou o markup não usa a chave");

      // (5) o rodapé dizia "mantido por doações — nunca por venda" 200 linhas
      // abaixo de "assina um plano via PIX"; os Termos falavam em
      // "doação/compra" (resquício da era diamantes, removida no v170).
      check("📣 v197-L15: o rodapé preserva a ideia do dono (dois brasileiros, sem empresa por trás) e parou de dizer 'nunca por venda' — e os Termos não falam mais em doação num site onde o plano é COMPRADO",
        !/nunca por venda/i.test(_semHtml15(_idx15)) && _idx15.includes("sem empresa por trás") &&
        !/doa[çc][ãa]o\/compra|comprar\/doar/i.test(_srv15) &&
        !/doa[çc]/i.test(_semHtml15(_idx15).replace(/<script[\s\S]*?<\/script>/g, " ")),
        "sobrou linguagem de doação em texto visível");
      // e os consentimentos velhos e novos não podem apontar pra textos
      // diferentes com a MESMA etiqueta de versão
      check("📣 v197-L15: mexeu no texto dos Termos, subiu a versão do consentimento (2026-09 → 2026-09b) — senão quem aceitou antes e quem aceita depois ficam com a mesma etiqueta pra textos diferentes",
        _srv15.includes('versaoTermos:"2026-09b"') && !_srv15.includes('versaoTermos:"2026-09"'),
        "versaoTermos não subiu junto com o texto");

      // (6) COMPORTAMENTAL: o VIPro com o MANUAL vencido e o automático ativo
      // cai no limitReached no 1º clique — e nem o servidor nem o funil podem
      // mandar "assine um plano"/"continue de graça" pra quem JÁ PAGA.
      await req2("POST", "/api/test/login", {
        token: TEST_TOKEN, email: "upsell15@test.com", name: "Upsell Quinze", refreshToken: "rt-upsell15",
        plan: "vipro", vip: { manualExpires: Date.now() - 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "vipro" },
      });
      const _snd15 = await req2("POST", "/api/send", { to: "rh@upsell15.com", subject: "Application", message: "Olá." });
      const _err15 = String(_snd15.json?.error || "");
      check("📣 v197-L15: pagante VIPro com o manual vencido (automático ativo) leva limitReached no 1º clique — e a resposta NÃO manda assinar nada nem fala em 'de graça'",
        _snd15.status === 429 && _snd15.json?.limitReached === true && _snd15.json?.dailyLimit === 0 &&
        !/assine um plano/i.test(_err15) && !/de gra[çc]a/i.test(_err15),
        JSON.stringify({ status: _snd15.status, err: _err15.slice(0, 80), lim: _snd15.json?.dailyLimit }));
      check("📣 v197-L15 (estrutural): o funil do limite ramifica pelo estado REAL das DUAS dimensões (manualLimit/autoLimit do /api/status), não por 'tem plano' — e quem já está no topo (DoublePro com os 2 lados ativos) não vê upsell nenhum",
        /const _manualOn=\(U\.manualLimit\|\|0\)>0, _autoOn=\(U\.autoLimit\|\|0\)>0;/.test(_app15) &&
        /_topo=String\(U\.plan\|\|""\)==="doublepro"&&_manualOn&&_autoOn/.test(_app15) &&
        _app15.includes("if(_topo||U.isAdmin)return;") &&
        !/upsell_later":"[^"]*(gra[çc]a|free|gratis)/i.test(_app15),
        "limitUpsell voltou a decidir por 'tem plano' ou o upsell_later ainda promete 'de graça'");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }

    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    check("📡⭐ v134: front tem o botão 📡 Radar e o funil do limite (limitUpsell 1x/dia)",
      frontAll.includes("function radarModal") && frontAll.includes("function limitUpsell") && home.body.includes('id="radar-btn"') && frontAll.includes("h2b_upsell"),
      "radarModal/limitUpsell/radar-btn/h2b_upsell não encontrados");

    // (v133: prompt da IA do chat — o chat com IA foi removido por completo
    // nesta reconstrução, README confirma.)

    // (v121 PLANILHA H-2A BIMESTRAL e v138 PLANILHA H-2B MENSAL — robôs de
    // coleta/publicação automática de planilha DOL; README confirma que
    // esta reconstrução não tem robôs de coleta — "as planilhas são
    // estáticas". Sem /api/admin/sheet/h2a-bimestral-run,
    // /api/admin/sheet/h2b-mensal-run, coleta-status ou coleta-publish.)

    // ═══ 💸 v140 (conta do Render): gzip nas conversas de robô ═══
    // O httpsReq descomprime sozinho e as chamadas ao DOL pedem gzip. A
    // chamada de streaming cru (proxy/download de buffer) CONTINUA identity
    // de propósito — não descomprime. (Arquitetura multi-servidor removida:
    // as chamadas gzip que existiam só pra rota peer saíram junto.)
    const _gmailSrcV140 = fs.readFileSync(path.join(__dirname, "mod-gmail.js"), "utf8");
    check("💸 v140: httpsReq descomprime gzip/deflate/br sozinho (fail-open pro corpo cru se falhar)",
      _gmailSrcV140.includes("content-encoding") && _gmailSrcV140.includes("gunzipSync") && _gmailSrcV140.includes("brotliDecompressSync"),
      "descompressão não encontrada no mod-gmail.js");
    // v195 LOTE 14: a exigência de UM "Accept-Encoding":"identity" saiu daqui —
    // a única requisição de streaming cru do servidor era o /proxy aberto pro
    // site do DOL, removido naquele lote. Exigir identity agora obrigaria a
    // manter (ou recriar) justamente o que foi apagado de propósito.
    // v223: server.js parou de conversar com o DOL (busca ao vivo saiu de
    // vez) — a conversa mora inteira em mod-planilhas.js, atrás de UM header
    // só (DOL_HDR) reaproveitado por todo robô de coleta, nunca mais inline.
    const _planSrcV140 = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
    check("💸 v140: toda conversa com o DOL pede gzip (o httpsReq descomprime sozinho) — desde o v223 essa conversa mora só em mod-planilhas.js (server.js não fala mais com o DOL); o único identity que existia era o do /proxy aberto, removido no v195 LOTE 14",
      _planSrcV140.includes('"Accept-Encoding": "gzip"') && !_planSrcV140.includes('"Accept-Encoding": "identity"') &&
      !_srvSrc.includes('"Accept-Encoding":"identity"') && !_srvSrc.includes('"Accept-Encoding":"gzip"'),
      `planilhas_gzip=${_planSrcV140.includes('"Accept-Encoding": "gzip"')} srv_gzip=${_srvSrc.includes('"Accept-Encoding":"gzip"')}`);

    // ═══ 🎯 v139: VAGAS PRA VOCÊ — prateleira do match na Home (regra 13m) ═══
    // O ranking é cacheado 10min por usuário, mas o corte da regra 8
    // (enviado OU na fila nunca reaparece) roda FRESCO em toda resposta —
    // o teste prova exatamente isso pondo o empregador nº1 na fila.
    // 🔒 v172: este bloco é sobre a prateleira "Pra Você", não sobre o gate
    // novo — semeia plano+Gmail pra chegar no /api/auto/start testado.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pravoce@test.com", name: "PraVoce", refreshToken: "rt-pravoce-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "doublepro" }, plan: "doublepro" });
    await req2("POST", "/api/settings", { h2bProfile: { preferredArea: "landscape", englishLevel: "basic", experiencedH2B: false, h2bSeasons: 0 } });
    const pv1 = await get("/api/jobs/pra-voce");
    const _pvJobs1 = pv1.json?.jobs || [];
    check("🎯 v139: prateleira responde com 1 a 8 vagas, todas com e-mail e nota de match",
      pv1.json?.ok === true && _pvJobs1.length >= 1 && _pvJobs1.length <= 8 && _pvJobs1.every((j) => j.email && typeof j.matchScore === "number"),
      pv1.body.slice(0, 160));
    check("🎯 v139: empregadores ÚNICOS, ordenados da maior nota pra menor (nunca caixa preta: matchWhy vem junto)",
      new Set(_pvJobs1.map((j) => String(j.email).toLowerCase())).size === _pvJobs1.length &&
      _pvJobs1.every((j, i) => i === 0 || _pvJobs1[i - 1].matchScore >= j.matchScore) &&
      _pvJobs1.some((j) => Array.isArray(j.matchWhy)),
      JSON.stringify(_pvJobs1.map((j) => j.matchScore)));
    const pdfPv = Buffer.from("%PDF-1.4 pra-voce conteudo de teste ".repeat(60)).toString("base64");
    const upPv = await req2("POST", "/api/cv/upload", { base64: pdfPv, name: "CV_PraVoce.pdf", cvType: "resume" });
    const _pvTop = _pvJobs1[0];
    const pvStart = await req2("POST", "/api/auto/start", { queue: [{ to: _pvTop.email, title: _pvTop.title, company: _pvTop.company, category: _pvTop.category || "other", state: _pvTop.state || "TX" }], resumeIdx: upPv.json?.cv?.idx, subjects: ["x"], emailBodies: ["y"] });
    check("🎯 v139: (setup) fila de 1 vaga com o empregador nº1 da prateleira iniciou", pvStart.json?.ok === true, pvStart.body.slice(0, 140));
    const pv2 = await get("/api/jobs/pra-voce");
    check("🎯 v139: empregador que entrou na fila do automático SOME da prateleira NA HORA (regra 8 corta fresco, mesmo com ranking cacheado)",
      pv2.json?.ok === true && !(pv2.json?.jobs || []).some((j) => String(j.email || "").toLowerCase() === String(_pvTop.email || "").toLowerCase()),
      pv2.body.slice(0, 140));
    await req2("POST", "/api/auto/stop", {});
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 💼 MC4 — PARTE 1 (MASTER COMMAND 4, dono, 28/08): SÓCIOS & ACERTO ═══
    // "quanto eu tenho a receber e quanto diego tem a receber?" — fonte única
    // computeSocios(): régua idêntica ao canônico (invariante delta R$0),
    // dono explícito > herdado (ajuste) > derivado da trilha > SEM DONO
    // (nunca chuta). Roda ANTES do drill de fusão de propósito: aqui o caixa/
    // gastos/repasses ainda são exatamente as fixtures.
    const soc1 = (await get("/api/admin/socios")).json;
    check("💼 MC4-P1: /api/admin/socios usa a MESMA régua do canônico — liquidoContabil === computeEntradasJanelas().total (delta R$0 EXATO) e a fórmula vem declarada, nunca caixa preta",
      soc1?.ok === true && soc1.checagem?.delta === 0 && typeof soc1.formula === "string" && soc1.formula.includes("TEM A RECEBER"),
      JSON.stringify(soc1?.checagem));
    check("💼 MC4-P1: gastos por pagador exatos (Andrio 120 do bolso · Diego 40 · Empresa 60 = 220) e repasse já feito D→A de R$50 contado na posição dos DOIS lados",
      soc1?.gastos?.total === 220 && soc1.gastos.porPagador.andrio === 120 && soc1.gastos.porPagador.diego === 40 && soc1.gastos.porPagador.empresa === 60 &&
      soc1.repasses?.diegoParaAndrio === 50 && soc1.socios?.diego?.repassou === 50 && soc1.socios?.andrio?.recebeuRepasse === 50,
      JSON.stringify({ g: soc1?.gastos, r: soc1?.repasses }).slice(0, 200));
    const _sdAntes = soc1?.entradas?.semDono;
    check("💼 MC4-P1: entrada sem recebidoPor e sem trilha de admin (favulso1, R$77) cai no SEM DONO — o motor NUNCA chuta o dono do dinheiro",
      _sdAntes && _sdAntes.n >= 1 && (_sdAntes.itens || []).some((i) => i.id === "favulso1" && i.valor === 77),
      JSON.stringify(_sdAntes).slice(0, 200));
    const _sA = soc1?.socios?.andrio, _sD = soc1?.socios?.diego;
    const _okMat = (s) => Math.abs(s.posicao - (s.recebido - s.gastosPagos - s.repassou + s.recebeuRepasse)) < 0.011 && Math.abs(s.acerto - (s.direito - s.posicao)) < 0.011;
    check("💼 MC4-P1: a matemática declarada FECHA — posição e acerto batem com a fórmula nos 2 sócios e direito(A)+direito(D) = lucro distribuível exato (centavo fechado)",
      _sA && _sD && _okMat(_sA) && _okMat(_sD) && Math.abs(_sA.direito + _sD.direito - soc1.lucroDistribuivel) < 0.011,
      JSON.stringify({ a: _sA, d: _sD, lucro: soc1?.lucroDistribuivel }).slice(0, 260));
    const _atrBad = await req2("POST", "/api/admin/financeiro", { action: "edit_pagamento", id: "favulso1", motivo: "teste enum", changes: { recebidoPor: "fulano" } });
    check("💼 MC4-P1: recebidoPor virou ENUM — edição com dono inventado ('fulano') leva 400 na cara (antes QUALQUER string entrava e o lançamento sumia do acerto em silêncio)",
      _atrBad.status === 400, (_atrBad.body || "").slice(0, 120));
    const _atrOk = await req2("POST", "/api/admin/financeiro", { action: "edit_pagamento", id: "favulso1", motivo: "Atribuição de dono (Sócios & Acerto)", changes: { recebidoPor: "diego" } });
    const soc2 = (await get("/api/admin/socios")).json;
    check("💼 MC4-P1: atribuir favulso1 ao Diego em 1 clique (rota de edição EXISTENTE, com trilha) tira do SEM DONO e soma EXATOS R$77 no recebido dele",
      _atrOk.json?.ok === true && !(soc2?.entradas?.semDono?.itens || []).some((i) => i.id === "favulso1") &&
      Math.abs(soc2?.socios?.diego?.recebido - (_sD.recebido + 77)) < 0.011 && soc2?.checagem?.delta === 0,
      JSON.stringify({ antes: _sD?.recebido, depois: soc2?.socios?.diego?.recebido }).slice(0, 160));
    const _sp70 = await req2("POST", "/api/admin/socios/split", { andrio: 70, diego: 30 });
    const soc3 = (await get("/api/admin/socios")).json;
    check("💼 MC4-P1: split 70/30 salvo muda o DIREITO na hora (Andrio = 70% do lucro) e split inválido (negativo) é recusado com 400",
      _sp70.json?.ok === true && soc3?.split?.andrio === 70 &&
      Math.abs(soc3?.socios?.andrio?.direito - Math.round(soc3.lucroDistribuivel * 0.7 * 100) / 100) < 0.011 &&
      (await req2("POST", "/api/admin/socios/split", { andrio: -5, diego: 105 })).status === 400,
      JSON.stringify({ split: soc3?.split, dirA: soc3?.socios?.andrio?.direito, lucro: soc3?.lucroDistribuivel }).slice(0, 160));
    await req2("POST", "/api/admin/socios/split", { andrio: 50, diego: 50 });
    // Nesta reconstrução o admin.html é enxuto (3 abas: Visão Geral/Usuários/
    // Pedidos Pendentes) — não existe painel "🧠 Sócios & Acerto" na UI; a
    // API (/api/admin/socios + computeSocios) é a parte real e já foi
    // testada ponta a ponta acima.
    check("💼 MC4-P1 (estrutural): server tem a fonte única computeSocios",
      _srvSrc.includes("function computeSocios()") && _srvSrc.includes("sociosSplit"),
      "computeSocios sumiu do server.js");

    const _admHtml = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
    // (o admin.html enxuto desta reconstrução não tem card de Fusão de
    // Servidores na UI — só 3 abas; a arquitetura multi-servidor inteira
    // [Fusão, backup entre irmãos, financeiro-global] foi removida do
    // server.js por não fazer parte deste site de servidor único.)

    // 🌐 v157 (dono, 22/08: "retire tudo sobre o servidor 2 e 3"): o seletor
    // de servidores, a pill 🌐, os cards "Escolha seu servidor"/"conta em
    // outro servidor" e o atalho multi-servidor do admin SUMIRAM do front —
    // nenhum usuário (nem admin) vê referência a Servidor 2/3 em tela nenhuma.
    check("🌐 v157: front sem NENHUM resquício multi-servidor (seletor, pill, cards e redirects removidos de index.html e app.js)",
      !home.body.includes("srv-select-ov") && !home.body.includes("srv-pill-btn") &&
      !appJs.body.includes("openServerSelect") && !appJs.body.includes("agSignupAt") &&
      !appJs.body.includes("agAdminGoTo") && !appJs.body.includes("showSrvBlockModal") &&
      !appJs.body.includes("Escolha seu servidor") && !appJs.body.includes("Acesso Admin detectado"),
      "sobrou UI multi-servidor no front");

    // ═══ 🛡️ v149: CONTA ÚNICA (ordem do dono, 20/08 — print do ranking com
    // todo mundo 2x). As 3 defesas: ranking global deduplica por uid (a mesma
    // conta pós-fusão vive nos 2 servidores), o e-mail digitado vira contrato
    // no login do Google (autenticou outro = barra + revoga o token, a vaga
    // das 100 é devolvida), e a landing avisa: 2ª conta = risco de ban.
    // (ranking removido por completo nesta reconstrução — sem /api/ranking
    // nem dedupe de peers por uid; README confirma ranking fora do escopo.)
    // v172c (ORDEM DO DONO, 12/09/2026): login do site virou usuário+senha —
    // não existe mais "e-mail digitado é contrato" pra login (não tem Google
    // no meio). Essa proteção agora só faz sentido em /oauth/connect-send
    // (gmail.send, gated por plano pago): trava RE-conexão com um Gmail
    // diferente do já esperado (resolveSendGmail — null pra quem nunca
    // conectou nenhum, nunca trava a 1ª conexão de conta nova — ver bug
    // real v172c-FIX acima), autenticar outro Gmail já esperado revoga e barra.
    check("🛡️ v172c-FIX: (estrutural) /oauth/connect-send usa resolveSendGmail (nunca a identidade de login crua) pro login_hint e pra travar reconexão, revoga se autenticar outro Gmail",
      _csBlock.includes("resolveSendGmail(p)") && _srvSrc.includes("resolveSendGmail(ownerCS)") && _srvSrc.includes("_emailCS!==_expectedGmailCS") && _srvSrc.includes('path:"/revoke"'),
      "connect-send protegido (resolveSendGmail) não encontrado no server.js");
    // 🚨 v172c-SEC (auditoria de segurança, 12/09/2026 — CRÍTICO real): até
    // aqui, o "state" do OAuth sozinho era prova suficiente de quem completa
    // o fluxo em /oauth/callback — sem checar se a sessão ATUAL é a mesma
    // que iniciou. Login-CSRF: um atacante podia iniciar o fluxo logado
    // como ele mesmo, mandar o link de consentimento pra uma vítima
    // qualquer, e o Gmail de VERDADE da vítima ficava vinculado à conta do
    // atacante. Não dá pra testar de ponta a ponta sem credencial real do
    // Google (CONFIGURED=false neste ambiente — outros testes acima
    // dependem disso de propósito); prova estrutural: os 2 branches
    // (__sender__ e __connectsend__) exigem getSess(req) batendo com quem
    // iniciou ANTES de qualquer troca de código com o Google.
    // v237u (bug real ao vivo, 20/09/2026 — Andrio deslogado no meio de
    // "Conectar Gmail Extra"): a checagem de sessão pura quebrava sempre que
    // um deploy caía durante a ida-e-volta do Google (KB-078 derruba TODA
    // sessão de login de propósito a cada restart). Agora aceita sessão de
    // quem iniciou OU o cookie de handshake (h2b_of, vive no navegador,
    // sobrevive a restart) provando o MESMO navegador — mas sessão de OUTRA
    // pessoa (_sessOutro*) nunca é sobrescrita pelo cookie, mantendo o
    // login-CSRF fechado.
    check("🚨 v172c-SEC/v237u: /oauth/callback (branch __sender__) exige sessão de quem iniciou OU cookie de handshake provando o mesmo navegador — sessão de OUTRA pessoa nunca é aceita — login-CSRF fechado",
      _srvSrc.includes("const _sessOutro2=!!_sess2?.user_email&&_sess2.user_email!==ownerEmail2;") &&
      _srvSrc.includes("if(!_sessOk2&&(_sessOutro2||!_oauthFlowSameBrowser(req,_st))){"),
      "callback de add-sender não confere mais a sessão/cookie de quem iniciou");
    check("🚨 v172c-SEC/v237u: /oauth/callback (branch __connectsend__) exige sessão de quem iniciou OU cookie de handshake provando o mesmo navegador — sessão de OUTRA pessoa nunca é aceita — login-CSRF fechado",
      _srvSrc.includes("const _sessOutroCS=!!_sessCS?.user_email&&_sessCS.user_email!==ownerEmailCS;") &&
      _srvSrc.includes("if(!_sessOkCS&&(_sessOutroCS||!_oauthFlowSameBrowser(req,_st))){"),
      "callback de connect-send não confere mais a sessão/cookie de quem iniciou");
    check("🔌 v237u: /oauth/add-sender, /oauth/connect-send e /oauth/notif-connect gravam o cookie de handshake (h2b_of) ANTES de redirecionar pro Google — sobrevive a deploy no meio do caminho, diferente da sessão de login",
      (_srvSrc.match(/Set-Cookie":makeFlowCookieStr\(st\)/g) || []).length === 3,
      "cookie de handshake (h2b_of) não está sendo gravado nas 3 rotas de início do fluxo");
    check("🔌 v237u: sessão reconstruída (_oauthReloginCookie) e cookie de handshake limpo (clearFlowCookieStr) só quando a sessão original não bateu — nos 3 callbacks",
      _srvSrc.includes('const _cookiesOut2=[clearFlowCookieStr(),...(_sessOk2?[]:[_oauthReloginCookie(ownerEmail2)])];') &&
      _srvSrc.includes('const _cookiesOutCS=[clearFlowCookieStr(),...(_sessOkCS?[]:[_oauthReloginCookie(ownerEmailCS)])];') &&
      _srvSrc.includes('const _cookiesOutN=[clearFlowCookieStr(),...(_sessOkN?[]:[_oauthReloginCookie(pn.ownerEmail)])];'),
      "reconstrução de sessão pós-cookie não encontrada nos 3 callbacks");

    // 🚨 v239 (achado real AO VIVO, 20/09/2026 — Andrio testando "Conectar
    // Gmail" como usuário comum pelo domínio oficial h2bapply.com): o
    // callback do Google voltava pra h2bapply-2026.onrender.com em vez de
    // h2bapply.com — domínio DIFERENTE de onde os cookies de sessão/
    // handshake tinham sido gravados, "Sessão inválida ou expirada" pra
    // TODO usuário conectando Gmail pelo domínio custom. Raiz: h2bapply.com
    // nunca esteve na allowlist de _oauthBase (só entrava o host de
    // APP_URL/RENDER_EXTERNAL_*, e o Render NUNCA muda essas envs quando um
    // domínio próprio é anexado). Testado direto por /api/test/oauth-base
    // (rota só de teste — CONFIGURED=false neste ambiente nunca deixaria
    // bater de verdade em /oauth/connect-send pra inspecionar a URL).
    const _obH2b = await reqHost("/api/test/oauth-base?token=" + TEST_TOKEN, "h2bapply.com");
    check("🚨 v239: _oauthBase reconhece h2bapply.com (domínio oficial, hardcoded na allowlist) e devolve o MESMO domínio — o redirect_uri do Google volta pra onde os cookies de sessão/handshake vivem",
      _obH2b.status === 200 && _obH2b.json?.base === "https://h2bapply.com",
      JSON.stringify(_obH2b.json));

    const _obApp = await reqHost("/api/test/oauth-base?token=" + TEST_TOKEN, "localhost:3000");
    check("🔒 v239 (regressão v61): host que bate com APP_URL (localhost:3000, valor de fábrica sem a env definida) continua reconhecido — o fix não tirou o comportamento original",
      _obApp.status === 200 && _obApp.json?.base === "http://localhost:3000",
      JSON.stringify(_obApp.json));

    const _obAtk = await reqHost("/api/test/oauth-base?token=" + TEST_TOKEN, "evil-attacker.example.com");
    check("🔒 v239 (anti open-redirect, continua valendo): host DESCONHECIDO (nunca visto no allowlist) NUNCA é refletido de volta — cai no fallback de APP_URL, exatamente como antes do fix",
      _obAtk.status === 200 && _obAtk.json?.base === "http://localhost:3000" && _obAtk.json?.base !== "https://evil-attacker.example.com",
      JSON.stringify(_obAtk.json));
    // v172c: cadastro/login por usuário+senha — nunca senha em texto puro
    // (scrypt), nunca @ no username (impossível colidir com e-mail de admin),
    // e as 2 rotas têm rate limit (força-bruta de senha/username).
    check("🔐 v172c: (estrutural) /api/cadastro e /api/login usam scrypt (_hashPw/_verifyPw), nunca senha em texto puro",
      _srvSrc.includes("scryptSync") && _srvSrc.includes("function _hashPw") && _srvSrc.includes("function _verifyPw") &&
      _srvSrc.includes('pathname==="/api/cadastro"') && _srvSrc.includes('pathname==="/api/login"'),
      "hashing de senha ou rotas de cadastro/login não encontrados no server.js");
    check("🔐 v172c: (estrutural) username de cadastro NUNCA aceita @ (impossível colidir com e-mail de admin) + isAdminEmail como defesa extra + rate limit nas 2 rotas",
      _srvSrc.includes("^[a-z0-9_.]{3,30}$") && _srvSrc.includes("isAdminEmail(username)") &&
      (_srvSrc.match(/rateLimit\("cadastro_/) || []).length > 0 && (_srvSrc.match(/rateLimit\("login_/) || []).length > 0,
      "validação de username ou rate limit não encontrados no server.js");
    check("🛡️ v149: aviso de CONTA ÚNICA na landing (ban permanente, nome do currículo denuncia) nas 3 línguas",
      home.body.includes('data-i18n="au_t"') && home.body.includes('data-i18n="au_b"') &&
      (appJs.body.match(/"au_t":/g) || []).length === 3 && (appJs.body.match(/"au_b":/g) || []).length === 3,
      "seção au_t/au_b não encontrada (landing ou dicionário 3 línguas)");
    // (vigia de anúncios do DOL/dolNewsAutoTick — aba Notícias removida,
    // sem esse robô nesta reconstrução.)
    // 🔓 v153 (ordem do dono, 21/08 — "libera todos"): o boot ZERA a lista
    // inteira de banidos UMA vez (carimbo limpouTudoEm), e ban virou decisão
    // EXPLÍCITA: deletar conta não bane mais sozinho; o admin tem botão
    // Banir/Desbanir na aba Auditoria.
    const _blkPos = JSON.parse(fs.readFileSync(path.join(DATA, "blocked_emails.json"), "utf8"));
    check("🔓 v153: boot ZEROU a lista de banidos (todos liberados) e carimbou a limpeza (não re-zera bans futuros)",
      Array.isArray(_blkPos.emails) && _blkPos.emails.length === 0 && !!_blkPos.limpouTudoEm,
      JSON.stringify(_blkPos).slice(0, 120));
    // (admin.html enxuto não tem UI de Auditoria/ban — sem "Também BANIR
    // este e-mail?"; a rota real é a parte que importa aqui.)
    check("🔓 v153: (estrutural) deletar conta NÃO bane mais sozinho — ban no delete só com pedido explícito (banir:true)",
      _srvSrc.includes("d.banir===true"),
      "auto-ban do delete-user ainda existe (sem checar banir:true explícito)");
    // Rotas de banir/desbanir exigem admin HARDCODED — loga como um deles.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const banEx = await req2("POST", "/api/admin/ban-email", { email: "fica.banido@test.com" });
    const banLs = await get("/api/admin/banned-emails");
    check("🚫 v153: ban EXPLÍCITO pela rota funciona e aparece na lista do painel",
      banEx.json?.ok === true && (banLs.json?.emails || []).includes("fica.banido@test.com"),
      (banLs.body || "").slice(0, 100));
    const unb = await req2("POST", "/api/admin/unban-email", { email: "fica.banido@test.com" });
    const banLs2 = await get("/api/admin/banned-emails");
    check("🔓 v153: desbanir pela rota funciona (lista fica vazia)",
      unb.json?.ok === true && (banLs2.json?.emails || []).length === 0,
      JSON.stringify({ unb: unb.json, depois: banLs2.json?.emails }).slice(0, 120));

    // ═══ 🚨 v228 (achado de auditoria — Alta): DB_BLOCKED só existia de
    // decoração — nenhuma rota de cadastro/login olhava a lista, então
    // banir um Gmail não impedia a MESMA pessoa recriar conta na hora só
    // trocando o username. Regressão ponta a ponta: banir → código de
    // verificação confirmado → cadastro é RECUSADO mesmo assim → desbanir
    // → o MESMO e-mail volta a cadastrar normal.
    const banV228 = await req2("POST", "/api/admin/ban-email", { email: "banido.v228@gmail.com" });
    const tokV228 = await verificar("banido.v228@gmail.com");
    const cadV228 = await cadastroCompleto({ username: "user_v228_banido", email: "banido.v228@gmail.com", emailToken: tokV228 });
    check("🚫 v228: e-mail banido é RECUSADO no cadastro (403) mesmo com o código de verificação já confirmado — banir de verdade impede recadastro, não é mais só decorativo",
      banV228.json?.ok === true && cadV228.status === 403 && /banido permanentemente/i.test(cadV228.json?.error || ""),
      JSON.stringify({ ban: banV228.json, cad: cadV228.status, err: cadV228.json?.error }).slice(0, 200));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    await req2("POST", "/api/admin/unban-email", { email: "banido.v228@gmail.com" });
    const cadV228b = await cadastroCompleto({ username: "user_v228_ok", email: "banido.v228@gmail.com", emailToken: tokV228 });
    check("🔓 v228: desbanindo, o MESMO e-mail volta a cadastrar normalmente — o bloqueio é só enquanto banido, nunca permanente por engano",
      cadV228b.status === 200 && cadV228b.json?.ok === true,
      JSON.stringify(cadV228b.json).slice(0, 160));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // ═══ 💼 MC4 — PARTE 3 (28/08): DRE MENSAL + RELATÓRIO EXECUTIVO ════════
    // Receita/gastos/resultado MÊS A MÊS com quebra por sócio (mesma régua
    // de dono do Acerto — _finDonoDe, fonte única), por plano e categoria;
    // exportação CSV (;+BOM) e relatório executivo 100% determinístico.
    const dreM = (await get("/api/admin/dre")).json;
    check("💼 MC4-P3: /api/admin/dre — a soma dos meses bate com o canônico (delta R$0 EXATO), totais fecham (resultado = receita − gastos) e a fórmula vem declarada",
      dreM?.ok === true && dreM.checagem?.delta === 0 && Array.isArray(dreM.meses) && dreM.meses.length >= 1 &&
      Math.abs(dreM.totais.resultado - (dreM.totais.receita - dreM.totais.gastos)) < 0.011 && typeof dreM.formula === "string",
      JSON.stringify({ delta: dreM?.checagem, totais: dreM?.totais }).slice(0, 160));
    check("💼 MC4-P3: TODO mês fecha internamente — porSocio (Andrio+Diego+semDono) = receita do mês, gastosPorPagador = gastos do mês, porPlano e categorias somam o mês (centavo fechado)",
      dreM.meses.every((m) => Math.abs(m.porSocio.andrio + m.porSocio.diego + m.porSocio.semDono - m.receita) < 0.011) &&
      dreM.meses.every((m) => Math.abs(m.gastosPorPagador.andrio + m.gastosPorPagador.diego + m.gastosPorPagador.empresa - m.gastos) < 0.011) &&
      dreM.meses.every((m) => Math.abs(Object.values(m.porPlano).reduce((s2, v) => s2 + v, 0) - m.receita) < 0.03) &&
      dreM.meses.every((m) => Math.abs(Object.values(m.gastosPorCategoria).reduce((s2, v) => s2 + v, 0) - m.gastos) < 0.03),
      JSON.stringify(dreM.meses.map((m) => m.mes)).slice(0, 120));
    const _mAgo = dreM.meses.find((m) => m.mes === "2026-08");
    check("💼 MC4-P3: agosto/2026 (mês das fixtures) presente — receita > 0, gastos das fixtures (≥220) e categoria 'servidor' detalhada (gsm1+gsm3 = 180)",
      _mAgo && _mAgo.receita > 0 && _mAgo.gastos >= 220 - 0.011 && (_mAgo.gastosPorCategoria.servidor || 0) >= 180 - 0.011,
      JSON.stringify(_mAgo).slice(0, 220));
    const _csvDre = await _getBufA("/api/admin/dre?fmt=csv");
    const _csvDreTxt = _csvDre.buf.toString("utf8");
    check("💼 MC4-P3: exportação CSV do DRE (; + BOM pro Excel) com cabeçalho, linha de agosto/2026 e linha TOTAL",
      _csvDre.status === 200 && String(_csvDre.headers["content-type"] || "").includes("csv") &&
      _csvDre.buf.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])) &&
      _csvDreTxt.includes("mes;receita;gastos;resultado") && _csvDreTxt.includes("2026-08;") && /\nTOTAL;/.test(_csvDreTxt),
      _csvDreTxt.slice(0, 120));
    // (o admin.html desta reconstrução é enxuto — sem painel dedicado de DRE
    // mensal na UI; a rota/executivo determinístico é a parte real testada)
    check("💼 MC4-P3: relatório executivo 100% determinístico — cita mês, receita e o acerto dos sócios com fontes; régua de dono é FONTE ÚNICA (_finDonoDe compartilhado entre acerto e DRE)",
      typeof dreM.executivo?.texto === "string" && dreM.executivo.texto.includes("RELATÓRIO EXECUTIVO") &&
      /receita/i.test(dreM.executivo.texto) && /(tem a receber|deve repassar|em dia)/i.test(dreM.executivo.texto) &&
      (dreM.executivo.fontes || []).length >= 3 &&
      _srvSrc.includes("function _finDonoDe(") && _srvSrc.includes("_finDonoDe(p,_byId,0)") && !_srvSrc.includes("const _donoDe="),
      (dreM.executivo?.texto || "").slice(0, 160));

    // ═══ 💼 MC4 — PARTE 4 (28/08): ACERTO OPERACIONAL ══════════════════════
    // Repasse entre sócios registrável pela aba 🧠 (rota add_repasse
    // existente) e o front INTEIRO (card do Financeiro + Robô de
    // Conferência) consumindo SÓ a fonte única — finCalcAcerto morreu.
    const _socP4a = (await get("/api/admin/socios")).json;
    const p4rep = await req2("POST", "/api/admin/financeiro", { action: "add_repasse", repasse: { valor: 25, de: "andrio", nota: "drill MC4-P4" } });
    const _socP4b = (await get("/api/admin/socios")).json;
    check("💼 MC4-P4: repasse novo A→D de R$25 move o acerto EXATO — posições ±25, acertos ±25, soma dos acertos conservada e delta do canônico segue R$0 (repasse nunca mexe na receita)",
      p4rep.json?.ok === true &&
      Math.abs(_socP4b.repasses.andrioParaDiego - (_socP4a.repasses.andrioParaDiego + 25)) < 0.011 &&
      Math.abs(_socP4b.socios.andrio.posicao - (_socP4a.socios.andrio.posicao - 25)) < 0.011 &&
      Math.abs(_socP4b.socios.diego.posicao - (_socP4a.socios.diego.posicao + 25)) < 0.011 &&
      Math.abs(_socP4b.socios.andrio.acerto - (_socP4a.socios.andrio.acerto + 25)) < 0.011 &&
      Math.abs((_socP4b.socios.andrio.acerto + _socP4b.socios.diego.acerto) - (_socP4a.socios.andrio.acerto + _socP4a.socios.diego.acerto)) < 0.011 &&
      _socP4b.checagem?.delta === 0,
      JSON.stringify({ antes: _socP4a.socios?.andrio?.acerto, depois: _socP4b.socios?.andrio?.acerto }).slice(0, 140));
    const p4del = await req2("POST", "/api/admin/financeiro", { action: "delete_repasse", id: p4rep.json?.id, motivo: "drill reversível MC4-P4" });
    const _socP4c = (await get("/api/admin/socios")).json;
    check("💼 MC4-P4: excluir o repasse (motivo obrigatório na trilha) devolve o acerto EXATAMENTE ao estado anterior — operação reversível e auditada; repetir a exclusão dá 404 honesto",
      p4del.json?.ok === true &&
      Math.abs(_socP4c.socios.andrio.acerto - _socP4a.socios.andrio.acerto) < 0.011 &&
      Math.abs(_socP4c.repasses.andrioParaDiego - _socP4a.repasses.andrioParaDiego) < 0.011 &&
      (await req2("POST", "/api/admin/financeiro", { action: "delete_repasse", id: p4rep.json?.id, motivo: "repetido" })).status === 404,
      JSON.stringify({ a: _socP4a.socios?.andrio?.acerto, c: _socP4c.socios?.andrio?.acerto }).slice(0, 120));
    // (sem painel "Financeiro"/"🧠" na UI enxuta desta reconstrução — a
    // fonte única /api/admin/socios + add_repasse/delete_repasse já foi
    // testada ponta a ponta acima, sem 2ª verdade client-side pra derrubar)

    // ═══ 💼 MC4 — PARTE 5 (28/08, FINAL): FECHAMENTO IMUTÁVEL + RESPONDER ══
    // Fechar um mês congela o DRE dele; dinheiro mexido depois vira
    // divergência acusada pela auditoria; e o Cérebro responde "quanto
    // tenho a receber?" com o acerto ao vivo da fonte única.
    const p5f = await req2("POST", "/api/admin/fechamento", { mes: "2026-08" });
    const p5fDup = await req2("POST", "/api/admin/fechamento", { mes: "2026-08" });
    const p5fBad = await req2("POST", "/api/admin/fechamento", { mes: "1999-01" });
    const p5list = (await get("/api/admin/fechamentos")).json;
    const _fAgo = (p5list?.fechamentos || []).find((f) => f.mes === "2026-08");
    check("💼 MC4-P5: fechar agosto/2026 congela o DRE do mês (snapshot em disco + trilha no Audit + push aos admins) — refechar dá 409 (IMUTÁVEL), mês sem movimento dá 400, e a lista mostra o fechamento ÍNTEGRO",
      p5f.json?.ok === true && p5f.json?.fechamento?.dre?.receita > 0 &&
      p5fDup.status === 409 && p5fBad.status === 400 &&
      _fAgo && _fAgo.divergencia?.divergente === false && typeof _fAgo.acerto?.andrio === "number" &&
      fs.existsSync(path.join(DATA, "fechamentos.json")),
      JSON.stringify({ f: p5f.status, dup: p5fDup.status, div: _fAgo?.divergencia }).slice(0, 160));
    // Nesta reconstrução não existe mod-cerebro.js (RULE_FECHAMENTO_DIVERGENTE,
    // a auditoria /api/admin/cerebro/auditar e o "responder()" de perguntas
    // como "quanto eu tenho a receber?" eram dele) — só o fechamento em si
    // (já testado acima) sobreviveu como rota própria.

    // ═══ 🩻 v163: RAIO-X DE MEMÓRIA (OOM 2GB no Render — medir antes de operar)
    const memX = (await get("/api/admin/memoria")).json;
    // ⚠️ ASSERÇÃO ATUALIZADA no v192 LOTE 10: ela exigia `pedidos.n >= 2`, ou
    // seja, codificava como CERTO justamente o problema que o próprio raio-X
    // denunciava ("candidato nº1 a migrar pra disco"). Com os comprovantes de
    // pedido em disco, o número honesto é ZERO — e ele continua contando os do
    // FINANCEIRO (gastos/pagamentos), que seguem inline nesta versão.
    check("🩻 v163 + v192-L10: /api/admin/memoria mede o processo (rss/heap > 0) e os comprovantes base64 RESIDENTES na RAM — os de PEDIDO agora são ZERO (foram pro disco) e os de gasto (ainda inline) continuam sendo contados",
      memX?.ok === true && memX.processo?.rssMB > 0 && memX.processo?.heapUsadoMB > 0 &&
      memX.comprovantes?.pedidos?.n === 0 && memX.comprovantes?.pedidos?.mb === 0 &&
      memX.comprovantes?.gastos?.n >= 1 &&
      Array.isArray(memX.arquivos) && memX.arquivos.some((a) => a.nome === "users.json") &&
      Array.isArray(memX.dicas) && memX.dicas.length >= 1 && typeof memX.bancos?.usuarios === "number",
      JSON.stringify({ rss: memX?.processo?.rssMB, comp: memX?.comprovantes?.pedidos, gastos: memX?.comprovantes?.gastos?.n }).slice(0, 160));
    check("🩻 v163: (estrutural) a rota NUNCA faz JSON.stringify de banco inteiro (só de 1 linha-amostra) e o pulso [mem] roda a cada 6h no log",
      /Planilhas residentes: linhas reais \+ estimativa por AMOSTRA/.test(_srvSrc) &&
      _srvSrc.includes("JSON.stringify(a[0]||{})") && !/JSON\.stringify\(DB_USERS\)/.test(_srvSrc.split("api/admin/memoria")[1]?.split("api/")[0] || "x") &&
      _srvSrc.includes("[mem] rss=") && _srvSrc.includes("setInterval(_memPulse,6*3600_000)"),
      "raio-x sem a guarda de amostra ou sem pulso");
    // 🩹 v240 (achado real, 22/09/2026 — 2º alerta de OOM do Render): antes
    // desta correção, "planilhas" só olhava SHEET_EXTRAS — as 3 planilhas
    // NÚCLEO (jan/jul2025/h2a, a maioria das vagas residentes) nunca
    // apareciam no raio-x, escondendo o maior consumidor de memória do
    // processo. Prova que as 3 aparecem agora, com linhas reais > 0.
    const _memPlKeys = (memX?.planilhas || []).map((p) => p.key);
    check("🩹 v240: /api/admin/memoria mede as planilhas NÚCLEO (jan2026/jul2025/h2a) junto com as extras — antes ficavam de fora e o raio-x reportava 'nenhum ofensor' mesmo com ~16 mil vagas fora da conta",
      ["jan2026", "jul2025", "h2a"].every((k) => _memPlKeys.includes(k)) &&
      (memX.planilhas.find((p) => p.key === "jan2026")?.linhas || 0) > 0 &&
      (memX.planilhas.find((p) => p.key === "jul2025")?.linhas || 0) > 0 &&
      (memX.planilhas.find((p) => p.key === "h2a")?.linhas || 0) > 0,
      JSON.stringify(memX?.planilhas));
    // 🩹 v240 (estrutural): onlineMap (Map write-only, nunca lido em lugar
    // nenhum, crescia 1 entrada por e-mail distinto a cada /api/status pra
    // sempre) foi removido de vez — prova que não sobrou NENHUM `.set(` nem
    // declaração de Map pra ele, e que markOnline() continua existindo (só
    // perdeu a parte morta, o setUser({lastSeenAt}) real ficou).
    check("🩹 v240: (estrutural) onlineMap (Map write-only, nunca lido) foi removido — markOnline() continua persistindo lastSeenAt de verdade",
      !/const onlineMap\s*=\s*new Map/.test(_srvSrc) && /const markOnline = email/.test(_srvSrc) && /setUser\(email, \{ lastSeenAt: now \}\)/.test(_srvSrc),
      "onlineMap ainda presente ou markOnline quebrado");
    // 🩹 v240 (estrutural): healthState (Map real, usado em 10+ pontos —
    // NUNCA remover a função) ganhou poda periódica (mesma cadência 6h da
    // faxina do DB_SENT) — nunca mexe em quem tem automático ativo agora.
    check("🩹 v240: (estrutural) healthState ganhou poda periódica (6h) que nunca remove usuário com automático ativo — getHealth() continua intacta (usada em 10+ pontos, nunca seria seguro apagar)",
      _srvSrc.includes("for (const [email, h] of healthState)") &&
      _srvSrc.includes("if (job?.active) continue;") &&
      _srvSrc.includes("function getHealth(email)"),
      "poda de healthState não encontrada ou getHealth foi removida por engano");

    // v164 (CÉREBRO AUTÔNOMO) e o painel /api/admin/cerebro/painel inteiro
    // dependiam do mod-cerebro.js, que não existe nesta reconstrução —
    // removido (nenhuma rota /api/admin/cerebro/* sobrou no server.js).

    // ═══ 💼 MC5 — PARTE 1 (29/08): A PORTA DE ENTRADA BLINDADA ═════════════
    // "recebe, identifica valor/data/comprovante, faz o check" — a aprovação
    // agora ENXERGA a leitura do robô e o comprovante repetido ANTES de
    // creditar; doação real nunca mais é engolida pelo dedup.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5a@test.com", name: "MC5 A" });
    const mc5p1 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "MC5 A", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:100:E2EMC5AAA1:Pagador MC5", comprovante: Buffer.from("comp-mc5-a").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400)); // preCheck roda em background
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // 🎯 v178 (dono, 14/09/2026 — "não vai ter correção de pedidos... o
    // valor não bate, simplesmente não vai ter que alterar nada, esse
    // cadastro vai ter que ser excluído, vai ter que ser criado um novo
    // pelo usuário"): o robô leu R$100 mas o pedido é de R$150 — antes disso
    // ficava pendente esperando um admin decidir (confirmarDivergencia);
    // agora CANCELA sozinho, sem revisão manual nenhuma, e explica o motivo.
    const mc5p1Get = await get("/api/pedido/" + mc5p1.json?.pedidoId);
    const mc5Ap1 = await req2("PATCH", "/api/pedido/" + mc5p1.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    check("🎯 v178: valor DIVERGENTE (robô leu R$100 × pedido R$300) cancela o pedido SOZINHO, na hora — sem correção manual, sem admin decidir — com o motivo explicado pro cliente",
      mc5p1.json?.ok === true && !mc5p1.json?.duplicado &&
      mc5p1Get.json?.pedido?.status === "cancelado" && mc5p1Get.json?.pedido?.canceladoPor === "sistema (IA — valor divergente)" &&
      /R\$100\.00.*R\$300\.00/.test(mc5p1Get.json?.pedido?.notaAdmin || ""),
      JSON.stringify({ status: mc5p1Get.json?.pedido?.status, por: mc5p1Get.json?.pedido?.canceladoPor, nota: mc5p1Get.json?.pedido?.notaAdmin }).slice(0, 200));
    check("🎯 v178: tentar ativar um pedido JÁ cancelado (pelo auto-cancelamento) é barrado com 409 jaCancelado — não existe mais caminho pra 'aprovar mesmo assim' um valor errado",
      mc5Ap1.status === 409 && mc5Ap1.json?.jaCancelado === true && mc5Ap1.json?.canceladoPor === "sistema (IA — valor divergente)",
      JSON.stringify(mc5Ap1.json).slice(0, 160));
    check("🎯 v178: (estrutural) só DIVERGENCIA cancela sozinho — ILEGIVEL/ERRO continuam pendentes pra revisão humana (a IA não tem certeza do que leu; cancelar aí puniria um comprovante legítimo com foto ruim)",
      _srvSrc.includes('function _autoCancelarSeDivergente(pedido,pc){\n  if(pc.veredito!=="DIVERGENCIA")return;'),
      "guarda de escopo do auto-cancelamento mudou");

    // ═══ 🧾 v192 LOTE 10: COMPROVANTE DE PEDIDO MORA NO DISCO ═══════════════
    // Antes cada pedido segurava o base64 inteiro (até ~8MB) na RAM pra
    // sempre — inclusive de pedido aprovado/cancelado meses atrás — e QUALQUER
    // mudança de status reserializava TODOS eles em persistPedidos(). O
    // pedido acima acabou de nascer, ser lido pela IA (fingerprint + veredito)
    // e ser cancelado: tudo isso já rodou lendo do disco.
    const _compDir = path.join(DATA, "comprovantes");
    const _lsComp = (() => { try { return fs.readdirSync(_compDir); } catch { return []; } })();
    const _pedNoDisco = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "pedidos.json"), "utf8")); } catch { return []; } })();
    const _pdMc5 = _pedNoDisco.find((x) => x.id === mc5p1.json?.pedidoId) || {};
    check("🧾 v192-L10: o comprovante do pedido novo vai pro DISCO na hora — o base64 some do objeto em memória E do pedidos.json (reserializado a cada clique do admin), mas o painel continua abrindo os bytes por GET /api/pedido/:id",
      _lsComp.some((f) => f.startsWith(String(mc5p1.json?.pedidoId))) &&
      _pdMc5.comprovante === null && !!_pdMc5.comprovanteArquivo &&
      mc5p1Get.json?.pedido?.comprovante === Buffer.from("comp-mc5-a").toString("base64"),
      JSON.stringify({ arquivo: _pdMc5.comprovanteArquivo, inline: _pdMc5.comprovante, abriu: (mc5p1Get.json?.pedido?.comprovante || "").slice(0, 12) }));
    check("🧾 v192-L10: a leitura da IA e a impressão digital (SHA-256) do comprovante passaram a vir do DISCO — o pedido foi lido e auto-cancelado por divergência normalmente, com hash gravado",
      typeof mc5p1Get.json?.pedido?.comprovanteHash === "string" && mc5p1Get.json.pedido.comprovanteHash.length === 64 &&
      mc5p1Get.json?.pedido?.preCheck?.veredito === "DIVERGENCIA",
      JSON.stringify({ hash: (mc5p1Get.json?.pedido?.comprovanteHash || "").slice(0, 12), veredito: mc5p1Get.json?.pedido?.preCheck?.veredito }));
    // ═══ 🗓️ v193 LOTE 11: /api/pedido BLINDADO (data, campos livres, privacidade)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "l11@test.com", name: "Lote Onze" });
    const _l11Lixo = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "L11", userWhatsapp: "11 9", userCity: "SP", pagoEm: "xyz" });
    const _l11Futuro = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "L11", userWhatsapp: "11 9", userCity: "SP", pagoEm: new Date("2090-03-01T12:00:00Z").getTime() });
    check("🗓️ v193-L11: data de pagamento sem sentido é recusada NA CRIAÇÃO (400) — 'xyz' e ano 2090 — em vez de virar RangeError lá na aprovação (depois de creditar os dias) ou deixar o cliente escolher em que mês o dinheiro dele aparece no DRE",
      _l11Lixo.status === 400 && /data do pagamento/i.test(_l11Lixo.json?.error || "") &&
      _l11Futuro.status === 400,
      JSON.stringify({ lixo: _l11Lixo.status, futuro: _l11Futuro.status, err: (_l11Lixo.json?.error || "").slice(0, 60) }));
    const _l11Gigante = await req2("POST", "/api/pedido", {
      plano: "vip", dias: 30, consentimento: true, pagoEm: Date.now(),
      userName: { nome: "objeto" }, userWhatsapp: "11 99999 0000 ".repeat(10),
      userCity: "c".repeat(400), userState: "s".repeat(400), userAddress: "x".repeat(1000_000),
      nota: "n".repeat(9000), desconto: 50,
    });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _l11Admin = ((await get("/api/pedidos?status=pendente")).json?.pedidos || []).find((x) => x.id === _l11Gigante.json?.pedidoId) || {};
    check("🧱 v193-L11: campos livres do pedido têm TIPO e TAMANHO — endereço de 1MB e nota gigante são cortados, objeto vira texto e o `desconto` vindo do cliente é sempre 0 (nenhuma tela manda esse campo, e ele era impresso no aviso aos sócios)",
      _l11Gigante.json?.ok === true && typeof _l11Admin.userName === "string" && _l11Admin.userName.length <= 160 &&
      (_l11Admin.userAddress || "").length === 200 && (_l11Admin.nota || "").length === 500 &&
      (_l11Admin.userCity || "").length === 80 && (_l11Admin.userState || "").length === 60 && _l11Admin.desconto === 0,
      JSON.stringify({ nome: typeof _l11Admin.userName, addr: (_l11Admin.userAddress || "").length, nota: (_l11Admin.nota || "").length, desc: _l11Admin.desconto }));

    // REGRESSÃO do bug: pedido LEGADO com pagoEm lixo aprovado AGORA não pode
    // mais dar 500 depois de creditar os dias — e tem que deixar lançamento.
    const _l11Aprov = await req2("PATCH", "/api/pedido/pedlixo1", { status: "ativo", recebidoPor: "andrio" });
    const _finL11 = (await get("/api/admin/financeiro")).json?.pagamentos || [];
    const _entL11 = _finL11.filter((x) => x.pedidoId === "pedlixo1");
    check("🗓️ v193-L11 (regressão): aprovar pedido LEGADO com `pagoEm` lixo credita os dias E lança no caixa — antes estourava 500 DEPOIS do crédito, o caixa ficava vazio e a 2ª tentativa batia no 409 'já ativado' (o 'pedido ativo sem caixa' clássico)",
      _l11Aprov.status === 200 && _l11Aprov.json?.ok === true && _entL11.length === 1 &&
      (_entL11[0].dataPagamento || "").slice(0, 10) === new Date().toISOString().slice(0, 10),
      JSON.stringify({ status: _l11Aprov.status, lancamentos: _entL11.length, data: _entL11[0]?.dataPagamento }));

    // Privacidade: o DETALHE do próprio pedido devolvia o objeto CRU
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "l11priv@test.com", name: "L11 Priv" });
    const _l11Ped = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "L11 Priv", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150", comprovante: Buffer.from("comp-l11-priv").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    await req2("PATCH", "/api/pedido/" + _l11Ped.json?.pedidoId, { status: "cancelado", notaAdmin: "Comprovante de outra pessoa — cancelado pelo suporte" });
    const _l11VisaoAdmin = await get("/api/pedido/" + _l11Ped.json?.pedidoId);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "l11priv@test.com" });
    const _l11Visao = await get("/api/pedido/" + _l11Ped.json?.pedidoId);
    const _l11Txt = JSON.stringify(_l11Visao.json || {});
    check("🔒 v193-L11: o DONO do pedido vê a MESMA projeção da lista (função única) — sem notaAdmin interna, sem preCheck cru (que leva e-mail de OUTRO usuário no dupAlerta), sem avisoFalhas e sem o base64 — mas COM o motivoCancelamento que a Home mostra; o admin continua recebendo o pedido cru + o retrato do VIP",
      _l11Visao.status === 200 && _l11Visao.json?.pedido?.motivoCancelamento === "Comprovante de outra pessoa — cancelado pelo suporte" &&
      _l11Visao.json?.pedido?.comprovante === true && _l11Visao.json?.usuario === null &&
      !_l11Txt.includes("notaAdmin") && !_l11Txt.includes("preCheck") && !_l11Txt.includes("avisoFalhas") &&
      !_l11Txt.includes(Buffer.from("comp-l11-priv").toString("base64")) &&
      _l11VisaoAdmin.json?.pedido?.notaAdmin && _l11VisaoAdmin.json?.pedido?.preCheck &&
      _l11VisaoAdmin.json?.pedido?.comprovante === Buffer.from("comp-l11-priv").toString("base64"),
      JSON.stringify({ motivo: _l11Visao.json?.pedido?.motivoCancelamento, usuario: _l11Visao.json?.usuario, temNota: _l11Txt.includes("notaAdmin") }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    const _bytesLegado = Buffer.from("comprovante-mem-1").toString("base64");
    const _legado1 = await get("/api/pedido/pedmem1");
    const _mig2x = await req2("POST", "/api/test/migrar-comprovantes", { token: TEST_TOKEN });
    const _legado2 = await get("/api/pedido/pedmem1");
    check("🧾 v192-L10: pedido ANTIGO (status 'ativo', comprovante inline no arquivo) é migrado no boot — de QUALQUER status, não só pendente — e continua abrindo; rodar a migração de novo é no-op (idempotente, não duplica nem perde)",
      _legado1.json?.pedido?.comprovante === _bytesLegado && _legado2.json?.pedido?.comprovante === _bytesLegado &&
      _mig2x.json?.inlineNaRam === 0 && _mig2x.json?.comArquivo >= 3 && _mig2x.json?.arquivos === _mig2x.json?.comArquivo,
      JSON.stringify(_mig2x.json));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5b@test.com", name: "MC5 B" });
    const mc5p2 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "MC5 B", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:300:E2EMC5AAA1:Pagador MC5", comprovante: Buffer.from("comp-mc5-b-refoto").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const mc5Ap3 = await req2("PATCH", "/api/pedido/" + mc5p2.json?.pedidoId, { status: "ativo", recebidoPor: "diego" });
    check("💼 MC5-P1 + v178: MESMA transação PIX (E2E) reaparece em OUTRO usuário — mesmo o pedido original tendo sido CANCELADO (pelo auto-cancelamento por valor divergente, não aprovado), a aprovação barra com 409 'comprovante já usado' apontando o pedido e o e-mail originais (reuso suspeito não some só porque a 1ª tentativa foi rejeitada)",
      mc5Ap3.status === 409 && mc5Ap3.json?.comprovanteUsado === true && mc5Ap3.json?.pedidoDup === mc5p1.json?.pedidoId && mc5Ap3.json?.emailDup === "mc5a@test.com",
      JSON.stringify(mc5Ap3.json).slice(0, 180));

    // ═══ 🚨 v226 (achado de auditoria, 20/09/2026): reuso de comprovante no
    // caminho AUTOMÁTICO (ativação provisória na hora, sem admin nenhum) ═══
    // Antes só a aprovação MANUAL do admin checava hash/transação — o mesmo
    // comprovante Pix (mesmo arquivo OU mesma transação E2E) reaparecendo em
    // OUTRA conta, com valor batendo (CONFERE), ativava plano provisório na
    // hora sem barreira nenhuma. Dois usuários diferentes usam a MESMA
    // transação E2E (v226aaa1): o 1º ativa normalmente (1ª vez que aparece),
    // o 2º tem que ficar pendente — SEM autoAtivado nem ativadoEm.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "v226a@test.com", name: "V226 A" });
    const v226p1 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "V226 A", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150:E2EV226AAA1:Pagador V226", comprovante: Buffer.from("comp-v226-a").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    const v226St1 = (await get("/api/status")).json;
    check("🚨 v226: 1ª vez que a transação PIX aparece — ativa o provisório automático normalmente (comportamento de sempre intacto)",
      v226p1.json?.ok === true && v226St1?.plan === "vip" && v226St1?.vip?.source === "auto-provisorio",
      JSON.stringify({ ok: v226p1.json?.ok, plan: v226St1?.plan, source: v226St1?.vip?.source }).slice(0, 160));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "v226b@test.com", name: "V226 B" });
    const v226p2 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "V226 B", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150:E2EV226AAA1:Pagador V226", comprovante: Buffer.from("comp-v226-b-refoto").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    const v226St2 = (await get("/api/status")).json;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const v226Ped2 = (await get("/api/pedido/" + v226p2.json?.pedidoId)).json?.pedido;
    check("🚨 v226 (CRÍTICO corrigido): MESMA transação PIX reaparecendo em conta NOVA com valor batendo (CONFERE) NÃO ativa mais o provisório automático sozinho — comprovante Pix real reaproveitado em contas novas não vira VIP grátis na hora sem um humano olhar; pedido fica pendente, sem ativadoEm/autoAtivado, e o preCheck continua mostrando CONFERE (a leitura em si não muda, só a ativação é barrada)",
      v226p2.json?.ok === true && v226St2?.plan !== "vip" && v226St2?.needsPlan === true &&
      v226Ped2?.status === "pendente" && !v226Ped2?.ativadoEm && !v226Ped2?.autoAtivado &&
      v226Ped2?.preCheck?.veredito === "CONFERE",
      JSON.stringify({ plan: v226St2?.plan, needsPlan: v226St2?.needsPlan, status: v226Ped2?.status, ativadoEm: v226Ped2?.ativadoEm, veredito: v226Ped2?.preCheck?.veredito }).slice(0, 220));
    check("🚨 v226 (estrutural, função única): a mesma _comprovanteJaUsado() usada pela aprovação MANUAL agora também é chamada pelos 2 pontos do caminho AUTOMÁTICO (gancho de teste e Gemini real) antes de autoAtivarProvisorio — nunca uma 2ª lógica duplicada",
      (_srvSrc.match(/_comprovanteJaUsado\(/g) || []).length >= 4,
      "chamadas de _comprovanteJaUsado() insuficientes — refactor pode ter perdido algum caminho");

    // ═══ 🚨 v227 (achado de auditoria, 20/09/2026): pauseAuto/resumeAuto/
    // stopAuto (app.js) ignoravam a resposta do servidor — um 401 (sessão
    // caiu) ou 404 (job já não existe, ex.: outra aba já parou) ainda assim
    // marcava "Pausado"/"Retomado"/"Parado" na tela, mentindo pro usuário
    // sobre o estado real do robô automático. Sem UI em Chromium nesta
    // suíte, a guarda é ESTRUTURAL: as 3 funções têm que checar `d.ok` (via
    // jsonSafe, o helper único do site pra resposta não-JSON) antes de
    // aplicar a mudança otimista — nunca voltar a assumir sucesso do fetch.
    {
      const _appSrcV227 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnPause = (_appSrcV227.match(/async function pauseAuto\(\)\{[\s\S]*?\n\}/) || [""])[0];
      const _fnResume = (_appSrcV227.match(/async function resumeAuto\(\)\{[\s\S]*?\n\}/) || [""])[0];
      const _fnStop = (_appSrcV227.match(/async function stopAuto\(\)\{[\s\S]*?\n\n\/\//) || [""])[0];
      check("🚨 v227 (estrutural): pauseAuto/resumeAuto/stopAuto usam jsonSafe() + checam d.ok antes de mudar U.autoJob/UI — nenhuma delas mais assume sucesso só porque o fetch não lançou exceção",
        /jsonSafe\(r\)/.test(_fnPause) && /if\(!d\.ok\)throw/.test(_fnPause) &&
        /jsonSafe\(r\)/.test(_fnResume) && /if\(!d\.ok\)throw/.test(_fnResume) &&
        /jsonSafe\(r\)/.test(_fnStop) && /if\(!d\.ok\)throw/.test(_fnStop),
        JSON.stringify({ pause: _fnPause.length, resume: _fnResume.length, stop: _fnStop.length }));
    }

    // ═══ 🚨 v227b (achado do dono testando ao vivo, 20/09/2026): loadPlanos()
    // caía direto no estado de erro ("Não deu pra carregar os planos") numa
    // falha isolada de fetch/race na 1ª carga da página MAIS importante do
    // funil de pagamento, sem nenhuma nova tentativa — clicar "Tentar de
    // novo" carregava na hora, prova de que era falha transiente, não do
    // servidor. Guarda ESTRUTURAL: loadPlanos() tenta até 3x (com pausa
    // curta) antes de desistir e mostrar o erro.
    {
      const _appSrcV227b = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnLoadPlanos = (_appSrcV227b.match(/async function loadPlanos\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v227b (estrutural): loadPlanos() tenta buscar /api/planos até 3x (loop com jsonSafe) antes de cair no estado de erro — nunca mais 1 falha isolada de rede mostra 'Não deu pra carregar' na página de pagamento",
        /for\(let _t=0;_t<3;_t\+\+\)/.test(_fnLoadPlanos) && /jsonSafe\(r\)/.test(_fnLoadPlanos) && /plan_error_load/.test(_fnLoadPlanos),
        `loadPlanos() sem retry — ${_fnLoadPlanos.length} chars capturados`);
    }

    // ═══ 🚨 v229 (achado de auditoria — Alta): doClearHist() (reset de
    // "Enviadas") mostrava "Resetado ✓" e já reescrevia a tela inteira
    // ANTES de chamar o servidor, com o fetch real escondido num catch{}
    // vazio — uma falha de verdade deixava a pessoa convencida de que
    // resetou enquanto o servidor continuava intocado por baixo. Guarda
    // ESTRUTURAL: o fetch+jsonSafe+d.ok tem que vir ANTES de qualquer
    // mutação local (APPLIED.clear()), sem catch{} vazio sobrando.
    {
      const _appSrcV229 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnClearHist = (_appSrcV229.match(/async function doClearHist\(ovEl\)\{[\s\S]*?\n\}\n/) || [""])[0];
      const _idxFetch = _fnClearHist.indexOf('fetch("/api/history/clear"');
      const _idxApplied = _fnClearHist.indexOf("APPLIED.clear()");
      check("🚨 v229 (estrutural): doClearHist() confirma com o servidor (jsonSafe + d.ok) ANTES de zerar APPLIED/HIST e mostrar 'Resetado ✓' — nunca mais um catch{} vazio no fetch de /api/history/clear deixa a tela mentir que resetou quando o servidor falhou",
        _idxFetch >= 0 && _idxApplied >= 0 && _idxFetch < _idxApplied &&
        /if\(!d\.ok\)throw/.test(_fnClearHist) &&
        !/fetch\("\/api\/history\/clear",\{method:"POST",credentials:"include"\}\);\}catch\{\}/.test(_fnClearHist),
        JSON.stringify({ idxFetch: _idxFetch, idxApplied: _idxApplied, len: _fnClearHist.length }));
      const _fnResetAuto = (_appSrcV229.match(/async function doResetAuto\(ovEl\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v229b (estrutural): doResetAuto() só mostra a dica de próximo passo quando doClearHist() de fato retornou sucesso — nunca mais 2 mensagens contraditórias (reset falhou + 'comece o automático')",
        /if\(await doClearHist\(ovEl\)\)/.test(_fnResetAuto),
        _fnResetAuto.slice(0, 200));
      // 🚨 v230 (achado de auditoria — Média): o dropdown "Enviar por" do
      // modal de envio manual filtrava tokenExpired mas ESQUECIA blocked —
      // as outras 3 telas que listam remetentes elegíveis já filtram os 2.
      const _fnPopSender = (_appSrcV229.match(/const extras=\(U\.senderEmails\|\|\[\]\)\.filter\(x=>x\.active!==false&&!x\.tokenExpired&&!x\.blocked\);/) || [""])[0];
      check("🚨 v230 (estrutural): o dropdown 'Enviar por' do modal de envio manual (openSendModal) também exclui remetente blocked, igual às outras telas que listam remetentes elegíveis — nunca mais deixa escolher uma conta suspensa pelo Google",
        !!_fnPopSender,
        "filtro de 'Enviar por' sem &&!x.blocked");

      // ═══ 🚨 v231 (achado do dono testando ao vivo, 20/09/2026): badge
      // "Currículos 1" mas o corpo mostrava "Nenhum perfil criado ainda"
      // numa conta com 326 candidaturas automáticas — 3 lugares buscavam
      // perfis frescos e tratavam QUALQUER resposta sem `profiles` (um 401
      // de sessão caída incluso) como "0 perfis de verdade", sobrescrevendo
      // UPROFILES/U.profiles com array vazio. Fonte única _refreshProfiles()
      // só aceita quando `profiles` é de fato um array; renderProfiles()
      // ganhou o mesmo fallback pra U.profiles usado em ~10 outros lugares.
      const _fnRefresh = (_appSrcV229.match(/async function _refreshProfiles\(\)\{[\s\S]*?\n\}/) || [""])[0];
      check("🚨 v231 (estrutural): _refreshProfiles() usa jsonSafe e só aceita a resposta quando Array.isArray(d.profiles) — nunca mais confunde 401/erro genérico com '0 perfis'",
        /jsonSafe\(r\)/.test(_fnRefresh) && /Array\.isArray\(d\.profiles\)/.test(_fnRefresh) && /throw new Error/.test(_fnRefresh),
        _fnRefresh.slice(0, 200));
      check("🚨 v231 (estrutural): os 4 pontos que buscavam perfis frescos direto (loadProfilesView, _renderAutoProfilesPanel, openAutoModal, stopAuto) agora chamam _refreshProfiles() — nenhuma cópia duplicada do fetch cru sobrando neles",
        /await _refreshProfiles\(\)\)\)toast/.test(_appSrcV229.match(/async function loadProfilesView\(\)\{[\s\S]*?\n\}/)?.[0] || "") &&
        /await _refreshProfiles\(\);/.test(_appSrcV229.match(/async function _renderAutoProfilesPanel\(\)\{[\s\S]*?\n  const profiles=/)?.[0] || "") &&
        /await _refreshProfiles\(\);/.test(_appSrcV229.match(/async function openAutoModal\(\)\{[\s\S]*?\n  const profiles=/)?.[0] || "") &&
        /await _refreshProfiles\(\);\n\}catch\(e\)/.test(_appSrcV229.match(/async function stopAuto\(\)\{[\s\S]*?\n\}\n/)?.[0] || ""),
        "algum dos 4 pontos ainda tem o fetch cru de /api/profiles em vez de chamar _refreshProfiles()");
      const _fnRenderProfiles = (_appSrcV229.match(/function renderProfiles\(\)\{[\s\S]*?\n\}/) || [""])[0];
      const _idxAutoCura = _fnRenderProfiles.indexOf("UPROFILES=U.profiles");
      const _idxVazio = _fnRenderProfiles.indexOf("if(!UPROFILES.length){");
      check("🚨 v231 (estrutural): renderProfiles() AUTO-CURA UPROFILES a partir de U.profiles ANTES de decidir 'nenhum perfil criado' — nunca mais mostra a tela mais grave do site (perfil é essencial pro Automático) só porque UPROFILES ficou vazio por uma falha em OUTRA tela",
        _idxAutoCura >= 0 && _idxVazio >= 0 && _idxAutoCura < _idxVazio,
        JSON.stringify({ idxAutoCura: _idxAutoCura, idxVazio: _idxVazio }));

      // 🚨 v232 (achado de auditoria — Média): deleteProfile() descartava a
      // resposta do servidor — o servidor RECUSA apagar o último perfil
      // restante (400), mas a função removia o card da tela e mostrava
      // "Perfil excluído ✓" mesmo assim (o perfil reaparecia sozinho no
      // próximo carregamento, parecendo um bug de sincronização).
      const _fnDeleteProfile = (_appSrcV229.match(/async function deleteProfile\(id\)\{[\s\S]*?\n\}/) || [""])[0];
      check("🚨 v232 (estrutural): deleteProfile() checa jsonSafe+d.ok ANTES de remover o card da tela e mostrar sucesso — uma recusa do servidor (ex.: último perfil restante) nunca mais finge que apagou",
        /jsonSafe\(r\)/.test(_fnDeleteProfile) && /if\(!d\.ok\)throw/.test(_fnDeleteProfile) &&
        _fnDeleteProfile.indexOf("if(!d.ok)throw") < _fnDeleteProfile.indexOf("UPROFILES=UPROFILES.filter"),
        _fnDeleteProfile.slice(0, 220));
    }

    // ═══ 🚨 v233 (achado de auditoria — Média): GET /api/debug era PÚBLICO,
    // sem nenhuma checagem de sessão/admin — vazava total de usuários,
    // sessões ativas, jobs automáticos rodando e o caminho do disco de
    // dados pra QUALQUER um na internet. Zero telas do site chamam essa
    // rota (achado confirmado por varredura em app.js/admin.html/index.html)
    // — agora exige admin, mesma trava da rota irmã /api/debug/export.
    COOKIE = "";
    const _debugSemSessao = await get("/api/debug");
    check("🚨 v233: GET /api/debug SEM sessão é RECUSADO (403) — antes vazava total de usuários, sessões ativas e caminho do disco pra qualquer um na internet, sem nenhuma tela do site usar essa rota",
      _debugSemSessao.status === 403,
      `status=${_debugSemSessao.status} body=${(_debugSemSessao.body || "").slice(0, 120)}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const _debugAdmin = await get("/api/debug");
    check("🚨 v233: GET /api/debug COM sessão de admin continua funcionando (200) — a trava é só contra acesso público, a rota continua útil pro admin",
      _debugAdmin.status === 200 && typeof _debugAdmin.json?.total_users === "number",
      JSON.stringify(_debugAdmin.json).slice(0, 160));

    // ═══ 🚨 v234 (achado de auditoria — Média): POST /api/pedido/:id/
    // comprovante (reenvio do comprovante pelo dono do pedido) não tinha
    // NENHUM rate limit — cada chamada grava até ~8MB no disco E dispara
    // preCheckComprovante(ativar:true) de novo, que em produção chama a IA
    // (Gemini) pra reler o comprovante. Um script hostil (ou um bug de
    // retry em loop no cliente) conseguia martelar a rota e gastar cota de
    // IA/disco à toa. Mesmo padrão de /api/cadastro e /api/login.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "ratelimit234@test.com", name: "Rate Limit 234" });
    const _pedRL234 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Rate Limit 234", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("rl234-original").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    let _rl234Last;
    for (let i = 0; i < 6; i++) {
      _rl234Last = await req2("POST", "/api/pedido/" + _pedRL234.json?.pedidoId + "/comprovante", { comprovante: Buffer.from("rl234-tentativa-" + i).toString("base64") });
    }
    check("🚨 v234: reenviar comprovante tem rate limit (5/hora por usuário) — a 6ª tentativa seguida leva 429, protegendo disco e cota de IA de um script hostil martelando a rota",
      _rl234Last.status === 429 && /Muitos reenvios/.test(_rl234Last.json?.error || ""),
      JSON.stringify({ status: _rl234Last.status, err: _rl234Last.json?.error }).slice(0, 160));

    // 🧹 v235 (achado de auditoria — Baixa): "SEM_COMPROVANTE" nunca era um
    // veredito de verdade — _geminiComprovanteParse e o gancho de teste só
    // produzem ERRO/ILEGIVEL/CONFERE/DIVERGENCIA. Guarda permanente contra
    // reintroduzir código morto (a string nunca dava match em lugar nenhum).
    check("🧹 v235 (estrutural): 'SEM_COMPROVANTE' não existe mais em lugar nenhum do server.js — era um veredito que nunca era produzido (código morto no allowlist de leitura ruim)",
      !_srvSrc.includes("SEM_COMPROVANTE"),
      "achado 'SEM_COMPROVANTE' de volta no server.js — confirmar se virou um veredito real antes de reintroduzir");

    // ═══ 🚨 v236 (achado de auditoria — Crítica): checkStatus() é a PRIMEIRA
    // coisa que roda ao abrir/recarregar o site — antes tratava QUALQUER
    // resposta não-JSON de /api/status (deploy reiniciando: proxy devolve
    // HTML) exatamente como "sessão inexistente", mostrando a landing pra
    // um usuário PAGANTE com sessão válida. Guarda ESTRUTURAL: agora tenta
    // até 3x (mesmo padrão do loadPlanos, v227b) antes de desistir.
    {
      const _appSrcV236 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnCheckStatus = (_appSrcV236.match(/async function checkStatus\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v236 (estrutural): checkStatus() tenta buscar /api/status até 3x (loop com jsonSafe) antes de mostrar a landing — nunca mais 1 falha isolada de rede desloga um usuário com sessão válida",
        /for\(let _t=0;_t<3;_t\+\+\)/.test(_fnCheckStatus) && /jsonSafe\(r\)/.test(_fnCheckStatus) && /if\(!d\)\{showLanding\(\);return;\}/.test(_fnCheckStatus),
        `checkStatus() sem retry — ${_fnCheckStatus.length} chars capturados`);
    }

    // ═══ 🚨 v237 (achados da 2ª rodada de auditoria — painel-admin/dinheiro):
    // 4 fetch() cru sem jsonSafe no app.js (mesma classe de bug do v227/v229/
    // v230/v232/v236 — deploy reiniciando devolve HTML e o r.json() cru
    // estoura em vez de mostrar "servidor reiniciando, tente de novo").
    {
      const _appSrcV237 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnManualCdSave = (_appSrcV237.match(/async function _manualCdSave\(off\)\{[\s\S]*?\n\}\n/) || [""])[0];
      const _fnDoSend = (_appSrcV237.match(/async function doSend\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      const _fnRemoveSender = (_appSrcV237.match(/async function _removeSenderEmail\(email\)\{[\s\S]*?\n\}\n/) || [""])[0];
      const _fnSaveProfile = (_appSrcV237.match(/async function saveProfile\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v237 (estrutural): _manualCdSave()/doSend()/_removeSenderEmail()/saveProfile() usam jsonSafe(r) — os 4 últimos fetch() do app.js que ainda faziam r.json() cru (deploy reiniciando quebrava o toggle de cooldown, o envio manual, remover Gmail extra e salvar perfil com erro genérico em vez de 'servidor reiniciando')",
        /jsonSafe\(r\)/.test(_fnManualCdSave) && /jsonSafe\(r\)/.test(_fnDoSend) && /jsonSafe\(r\)/.test(_fnRemoveSender) && /jsonSafe\(r\)/.test(_fnSaveProfile),
        `chars: cd=${_fnManualCdSave.length} send=${_fnDoSend.length} rm=${_fnRemoveSender.length} save=${_fnSaveProfile.length}`);
    }

    // ═══ 🧹 v237 (achado de auditoria — Média): /api/admin/push-user era
    // código morto — validava {email,title} e devolvia ok:true SEM efeito
    // colateral nenhum (nunca gravava nada, nunca chamava pushToUser).
    check("🧹 v237 (estrutural): /api/admin/push-user foi removida — não sobrou rota fantasma que engana quem conectasse um botão a ela achando que enviou push de verdade (a rota real é /api/admin/message)",
      !_srvSrc.includes('"/api/admin/push-user"'),
      "/api/admin/push-user ainda existe no server.js");

    // ═══ 🚨 v237 (achado de auditoria — Alta): /api/admin/user/full-update
    // era uma 2ª porta pra dias de VIP/plano/pagamento que NUNCA chamava
    // addCredito() (dias invisíveis no extrato — geraria acusação FALSA de
    // "dias sem origem"), NUNCA chamava logAdminAction (invisível na
    // auditoria, irreversível), sem trava de duplo-clique e sem carimbar
    // vip.limits (13o). Zero chamador confirmado por grep em admin.html/
    // app.js/smoke-test.js antes da remoção.
    check("🚨 v237 (estrutural): /api/admin/user/full-update foi removida — 2ª porta pra dias de VIP sem addCredito/logAdminAction/trava de duplo-clique não existe mais; quem ajusta dias usa vip/set-expiry",
      !_srvSrc.includes('"/api/admin/user/full-update"'),
      "/api/admin/user/full-update ainda existe no server.js");

    // ═══ 🚨 v237 (achado de auditoria — Alta): promover/rebaixar admin
    // (set-user-field, field:"isAdmin") só exigia isAdminVip (inclui
    // ADMIN_EMAILS_EXTRA) — qualquer admin auxiliar conseguia criar OUTRO
    // admin, sem trilha nenhuma. Agora exige isAdminEmail hardcoded (mesma
    // régua do delete-user/ban-email) e fica na auditoria.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "v237alvo@test.com", name: "V237 Alvo" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const v237negado = await req2("POST", "/api/admin/set-user-field", { email: "v237alvo@test.com", field: "isAdmin", value: true });
    check("🚨 v237: admin NÃO-hardcoded (isAdminVip via ADMIN_EMAILS_EXTRA) é RECUSADO (403) tentando conceder isAdmin a outra conta pelo set-user-field",
      v237negado.status === 403, `status=${v237negado.status} body=${v237negado.body.slice(0, 140)}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const v237ok = await req2("POST", "/api/admin/set-user-field", { email: "v237alvo@test.com", field: "isAdmin", value: true });
    const v237audit = await req2("GET", "/api/admin/audit");
    const v237auditEntry = (v237audit.json?.audit || []).find(a => a.action === "set_is_admin" && a.targetEmail === "v237alvo@test.com");
    check("🚨 v237: admin HARDCODED (ADMIN_EMAIL) consegue conceder isAdmin pelo set-user-field, E a ação fica registrada em /api/admin/audit (reversível pelo ↩️ — antes era invisível)",
      v237ok.json?.ok === true && !!v237auditEntry && v237auditEntry.after?.isAdmin === true,
      JSON.stringify({ ok: v237ok.json?.ok, achouAudit: !!v237auditEntry }).slice(0, 160));

    // ═══ 🚨 v237 (achado de auditoria — Alta): vip/set-expiry era a ÚNICA
    // rota que muda vip.manualExpires/autoExpires sem a trava de duplo-
    // clique que vip/activate (v18-FIX) e set-plan (v141) já tinham — mesmo
    // padrão _adminVipActivateLock, janela de 5s.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "v237exp@test.com", name: "V237 Exp" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const v237se1 = await req2("POST", "/api/admin/vip/set-expiry", { email: "v237exp@test.com", manualDays: 10 });
    const v237se2 = await req2("POST", "/api/admin/vip/set-expiry", { email: "v237exp@test.com", manualDays: 10 });
    check("🚨 v237: 1º clique em vip/set-expiry funciona normalmente", v237se1.json?.ok === true, v237se1.body.slice(0, 140));
    check("🚨 v237: 2º clique em SEGUIDA no MESMO usuário é BLOQUEADO (409, mesma trava do set-plan/v141) — nunca mais duplica addCredito()/logAdminAction() por duplo-clique",
      v237se2.status === 409 && v237se2.json?.duplicate === true, `status=${v237se2.status} body=${v237se2.body.slice(0, 140)}`);

    // ═══ 🚨 v237k (achado de uma 3ª rodada de auditoria — Alta, admin):
    // vip/gift-days mexe no MESMO par vip.manualExpires/autoExpires que
    // vip/activate, set-plan e vip/set-expiry — mas era a única rota sem a
    // trava de duplo-clique (_adminVipActivateLock) nem logAdminAction.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "v237gift@test.com", name: "V237 Gift" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const v237g1 = await req2("POST", "/api/admin/vip/gift-days", { email: "v237gift@test.com", dias: 3, motivo: "site fora do ar (teste v237k)" });
    const v237g2 = await req2("POST", "/api/admin/vip/gift-days", { email: "v237gift@test.com", dias: 3, motivo: "site fora do ar (teste v237k)" });
    check("🚨 v237k: 1º clique em vip/gift-days funciona normalmente", v237g1.json?.ok === true, v237g1.body.slice(0, 140));
    check("🚨 v237k: 2º clique em SEGUIDA no MESMO usuário é BLOQUEADO (409, mesma trava do set-expiry/set-plan) — nunca mais soma a cortesia 2x por duplo-clique",
      v237g2.status === 409 && v237g2.json?.duplicate === true, `status=${v237g2.status} body=${v237g2.body.slice(0, 140)}`);
    const v237gAudit = await req2("GET", "/api/admin/audit");
    const v237gAuditEntry = (v237gAudit.json?.audit || []).find(a => a.action === "vip_gift_days" && a.targetEmail === "v237gift@test.com");
    check("🚨 v237k: a concessão de dias grátis fica registrada em /api/admin/audit (reversível pelo ↩️ — antes era invisível, só o console.log efêmero)",
      !!v237gAuditEntry, JSON.stringify({ achou: !!v237gAuditEntry }));

    // ═══ 🚨 v237 (achado de auditoria — Alta, vagas/filtros): loadSheetMeta()
    // (a busca manual de vagas, aba planilha) não tinha NENHUMA proteção
    // contra resposta de um fetch antigo chegando depois de uma troca de
    // aba/busca/ordenação — mesma classe do bug já corrigido em vfFetch no
    // v224 (contadores de sequência), só que aqui não existia proteção
    // nenhuma: trocar de aba rápido enquanto a 1ª busca ainda carregava podia
    // misturar vagas da aba ERRADA na lista da aba atual, ou deixar o
    // skeleton de carregamento preso pra sempre (a troca de contexto ficava
    // bloqueada atrás do `if(sLoading)return` do fetch antigo).
    {
      const _appSrcV237b = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnLoadSheetMeta = (_appSrcV237b.match(/async function loadSheetMeta\(reset=false\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v237 (estrutural): loadSheetMeta() ganha contador de contexto (sCtxSeq) — reset=true NUNCA fica preso atrás de um fetch antigo (bypassa o gate de sLoading), invalida esse fetch antigo, e a resposta velha é descartada em silêncio (mySeq!==sCtxSeq) tanto no sucesso quanto no catch/finally",
        /if\(sLoading&&!reset\)return;/.test(_fnLoadSheetMeta) &&
        /if\(reset\)sCtxSeq\+\+;/.test(_fnLoadSheetMeta) &&
        /const mySeq=sCtxSeq;/.test(_fnLoadSheetMeta) &&
        /if\(mySeq!==sCtxSeq\)return;/.test(_fnLoadSheetMeta) &&
        /if\(mySeq===sCtxSeq\)g\("#lmore"\)\.innerHTML/.test(_fnLoadSheetMeta) &&
        /if\(mySeq===sCtxSeq\)sLoading=false;/.test(_fnLoadSheetMeta) &&
        /jsonSafe\(r\)/.test(_fnLoadSheetMeta),
        `loadSheetMeta() sem a guarda de contexto — ${_fnLoadSheetMeta.length} chars capturados`);
    }

    // ═══ 🚨 v237 (achado de auditoria — Alta, perfil/onboarding): PDF órfão
    // sobrevivia em OUTROS perfis depois de excluído. O servidor (/api/cv/
    // delete) já limpava resumeIdx/coverIdx de TODO perfil que apontava pro
    // arquivo apagado; o cliente só limpava DOCS/U.cvs e o perfil que
    // estava sendo EDITADO no momento — um perfil diferente (H-2A enquanto
    // se mexe no H-2B, por exemplo) ficava com a referência órfã em
    // UPROFILES/U.profiles até o próximo reload, e a injeção de "DOCS
    // fantasma" do openModal fabricava uma entrada usando o pdfName/
    // coverName ainda em cache — mostrando currículo "disponível" que o
    // servidor já tinha apagado.
    {
      const _appSrcV237c = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnDeleteCv = (_appSrcV237c.match(/async function deleteCvFromAccount\(idx, cvType\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v237 (estrutural): deleteCvFromAccount() varre UPROFILES e U.profiles limpando resumeIdx/coverIdx/pdfName/coverName de QUALQUER perfil que apontava pro PDF apagado — mesma limpeza que o servidor já faz, nunca mais um perfil diferente do que estava sendo editado fica com currículo fantasma",
        /jsonSafe\(r\)/.test(_fnDeleteCv) &&
        (_fnDeleteCv.match(/if\(pr\.resumeIdx===idx\)\{delete pr\.resumeIdx;delete pr\.pdfName;pr\.pdfSize=0;\}/g) || []).length === 2 &&
        (_fnDeleteCv.match(/if\(pr\.coverIdx===idx\)\{delete pr\.coverIdx;delete pr\.coverName;pr\.coverSize=0;\}/g) || []).length === 2 &&
        /\(UPROFILES\|\|\[\]\)\.forEach/.test(_fnDeleteCv) && /U\.profiles\)\(U\.profiles\)\.forEach/.test(_fnDeleteCv),
        `deleteCvFromAccount() sem a varredura de perfis órfãos — ${_fnDeleteCv.length} chars capturados`);
    }

    // ═══ 🚨 v237 (achado de auditoria — Média, perfil/onboarding): DOCS só
    // era populado no boot (fetch inicial de /api/cv) — um upload novo feito
    // DENTRO do editor de perfil (saveProfileFromEditor) atualizava o
    // PERFIL (UPROFILES) mas nunca DOCS. Reabrir o editor logo em seguida
    // (mesmo perfil ou outro) pra vincular esse PDF recém-subido não achava
    // a opção em _pePopulateResumeSlots()/_pePopulateCoverSlots() (leem DOCS
    // direto) até um reload da página.
    {
      const _appSrcV237e = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnSaveFromEditor = (_appSrcV237e.match(/async function saveProfileFromEditor\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v237 (estrutural): saveProfileFromEditor() injeta o PDF/cover recém-enviado em DOCS na hora (mesmo dado que o servidor acabou de devolver) — nunca mais precisa de reload pra escolher esse arquivo de novo em outro perfil",
        /if\(!DOCS\.some\(c=>c\.idx===d\.cv\.idx\)\)DOCS\.push\(\{idx:d\.cv\.idx,name:d\.cv\.name,size:d\.cv\.size,cvType:"resume"\}\);/.test(_fnSaveFromEditor) &&
        /if\(!DOCS\.some\(c=>c\.idx===d\.cv\.idx\)\)DOCS\.push\(\{idx:d\.cv\.idx,name:d\.cv\.name,size:d\.cv\.size,cvType:"cover"\}\);/.test(_fnSaveFromEditor),
        `saveProfileFromEditor() sem o push em DOCS — ${_fnSaveFromEditor.length} chars capturados`);
    }

    // ═══ 🚨 v237 (achado de auditoria — Baixa, perfil/onboarding): validação
    // de WhatsApp divergia em 3 lugares. O cadastro (#ag-s-whats, server.js
    // /api/cadastro) sempre exigiu ≥10 dígitos ("com DDD"), mas o gate do
    // Envio Automático (startAuto) e o card "Cadastre seu WhatsApp"
    // (wppRequiredSave) aceitavam a partir de 8 — um número sem DDD passava
    // ali e nunca funcionava de verdade pro empregador chamar. Alinhados
    // pra ≥10 nos 3 lugares.
    {
      const _appSrcV237f = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnStartAuto = (_appSrcV237f.match(/async function startAuto\(overrideStartH, overrideEndH, _mode="now"\)\{[\s\S]*?\n\}\n/) || [""])[0];
      const _fnWppReq = (_appSrcV237f.match(/async function wppRequiredSave\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v237 (estrutural): startAuto() e wppRequiredSave() exigem ≥10 dígitos de WhatsApp (mesma régua do cadastro, 'com DDD') — não mais ≥8, que deixava passar número sem DDD",
        /_wppNum\.length<10/.test(_fnStartAuto) &&
        /digits\.length < 10/.test(_fnWppReq) &&
        /jsonSafe\(r\)/.test(_fnWppReq) &&
        !/_wppNum\.length<8/.test(_fnStartAuto) && !/digits\.length < 8/.test(_fnWppReq),
        `startAuto=${_fnStartAuto.length}chars wppRequiredSave=${_fnWppReq.length}chars`);
    }

    // ═══ 🚨 v237g (achado de uma 3ª rodada de auditoria — Alta, auth): o
    // modal de login/cadastro/recuperação da landing (#auth-gate) não tinha
    // NENHUM jeito de fechar — sem X, sem clique-fora, sem Escape. agBack()
    // só trocava de tela (login/signup → choice), nunca fechava o overlay.
    // Visitante que abria o card e mudava de ideia (queria só ver preços
    // antes) ficava preso até dar F5 ou sair do site — bug de conversão
    // grave no topo do funil.
    {
      const _idxV237g = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _appSrcV237g = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _fnCloseAuthGate = (_appSrcV237g.match(/function closeAuthGate\(\)\{[\s\S]*?\n\}\n/) || [""])[0];
      check("🚨 v237g: closeAuthGate() remove as classes 'open' (#auth-gate) e 'ag-lock' (<html>, trava de scroll) — a MESMA dupla que openAuthGate() adiciona",
        /ov\.classList\.remove\("open"\)/.test(_fnCloseAuthGate) && /document\.documentElement\.classList\.remove\("ag-lock"\)/.test(_fnCloseAuthGate),
        `closeAuthGate() ausente ou incompleta — ${_fnCloseAuthGate.length} chars capturados`);
      check("🚨 v237g: #auth-gate tem os 3 jeitos padrão de fechar que TODO outro overlay do site já tinha — botão .ag-close (X), clique no fundo escuro (event.target===this) e Escape (mesmo listener global do #vf-overlay)",
        /<div id="auth-gate" onclick="if\(event\.target===this\)closeAuthGate\(\)">/.test(_idxV237g) &&
        /<button class="ag-close" onclick="closeAuthGate\(\)" aria-label="Fechar">×<\/button>/.test(_idxV237g) &&
        /const ag=g\("#auth-gate"\);\s*\n\s*if\(ag&&ag\.classList\.contains\("open"\)\)\{e\.preventDefault\(\);closeAuthGate\(\);\}/.test(_appSrcV237g),
        "botão X, clique-fora ou Escape do #auth-gate sumiu");
    }

    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5c@test.com", name: "MC5 C" });
    const mc5d1 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-um").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const mc5d2 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-dois").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const mc5d3 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-tres").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const mc5d4 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-quatro").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    check("💼 MC5-P1 → v170: 2º e 3º pedidos com pedido pendente NÃO são mais engolidos pelo dedup (o PIX já foi feito ANTES do envio — cada pedido é PRÓPRIO, comprovante preservado); o 4º pendente é barrado com aviso claro (teto anti-abuso)",
      mc5d1.json?.ok === true && !mc5d1.json?.duplicado &&
      mc5d2.json?.ok === true && !mc5d2.json?.duplicado && mc5d2.json?.pedidoId !== mc5d1.json?.pedidoId &&
      mc5d3.json?.ok === true && !mc5d3.json?.duplicado &&
      mc5d4.status === 400 && /3 pedidos em análise/.test(mc5d4.json?.error || ""),
      JSON.stringify({ d2dup: mc5d2.json?.duplicado, d4: mc5d4.status }).slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5d@test.com", name: "MC5 D" });
    const mc5inv = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 D", userWhatsapp: "11 9", userCity: "SP", comprovante: "!!!corrompido###", comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    check("💼 MC5-P1: comprovante corrompido leva 400 com motivo claro em PT — NUNCA mais pedido criado 'ok' sem prova em silêncio (o usuário via 'recebemos seu comprovante' e o admin via 'NÃO enviado')",
      mc5inv.status === 400 && /corrompido/.test(mc5inv.json?.error || ""),
      (mc5inv.body || "").slice(0, 120));
    // (o retry automático de leitura com backoff 1min/10min — _preCheckComRetry
    // — e a UI de admin com "Transação:"/"Aguardando leitura" não existem
    // nesta reconstrução — preCheckComprovante aqui só roda de verdade via
    // o gancho de teste, sem Gemini/OCR em produção; o comportamento real
    // de divergência/reuso/corrompido já foi testado ponta a ponta acima.
    // A compressão no aparelho (_compComprovante) é real, no app.js.)
    check("💼 MC5-P1: comprovante é comprimido no aparelho antes do envio (canvas JPEG — mata HEIC de iPhone)",
      fs.readFileSync(path.join(__dirname, "app.js"), "utf8").includes("_compComprovante"),
      "_compComprovante não encontrado no app.js");

    // 🧪 AUDITORIA 10/09/2026 (atualizada v218): PLANO_PRECO_TAB tem 3 planos
    // × 2 prazos (30/60d) = 6 combinações, mas só vip/vipro de 30 dias
    // tinham sido exercidos pela APROVAÇÃO REAL (PATCH /api/pedido/:id
    // {status:"ativo"}) nos testes acima — doublepro só aparecia via
    // /api/admin/set-plan (concessão manual do admin, caminho de código
    // diferente) e o prazo de 60 dias nunca passou pela aprovação de
    // pedido de verdade.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-dp@test.com", name: "Combo DoublePro" });
    const comboDp = await req2("POST", "/api/pedido", { plano: "doublepro", dias: 30, consentimento: true, userName: "Combo DoublePro", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:500", comprovante: Buffer.from("combo-dp").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const comboDpAp = await req2("PATCH", "/api/pedido/" + comboDp.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-dp@test.com" });
    const comboDpSt = (await get("/api/status")).json;
    check("🧪 combo plano×prazo: Máximo 30d aprovado por PEDIDO REAL (não só set-plan do admin) ativa manual+auto com os limites 50/300 da tabela nova — combinação nunca exercida antes pela aprovação",
      comboDpAp.json?.ok === true && comboDpAp.json?.plano === "doublepro" &&
      comboDpSt?.plan === "doublepro" && comboDpSt?.manualLimit === 50 && comboDpSt?.autoLimit === 300 &&
      comboDpSt?.vip?.autoActive === true && comboDpSt?.vip?.manualActive === true,
      JSON.stringify({ ap: comboDpAp.json?.plano, plan: comboDpSt?.plan, ml: comboDpSt?.manualLimit, al: comboDpSt?.autoLimit }).slice(0, 160));

    // Sem nota "TESTE_COMPROVANTE:" de propósito: com ela, o robô leria
    // CONFERE e a ativação PROVISÓRIA automática (intencional — ver
    // autoAtivarProvisorio) somaria +AUTO_ATIVA_DIAS por cima dos 60 da
    // aprovação, misturando dois comportamentos num teste só. Sem precheck
    // nenhum, a aprovação do admin é a ÚNICA fonte de dias — matemática limpa.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-90@test.com", name: "Combo 60 Dias" });
    const combo90 = await req2("POST", "/api/pedido", { plano: "vip", dias: 60, consentimento: true, userName: "Combo 60 Dias", userWhatsapp: "11 9", userCity: "SP", valorTotal: 270, comprovante: Buffer.from("combo-90").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const combo90Ap = await req2("PATCH", "/api/pedido/" + combo90.json?.pedidoId, { status: "ativo", recebidoPor: "diego" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-90@test.com" });
    const combo90St = (await get("/api/status")).json;
    const _diasRestantes90 = combo90St?.vip?.manualExpires ? Math.round((combo90St.vip.manualExpires - Date.now()) / 86400000) : 0;
    check("🧪 combo plano×prazo: Manual de 60 dias (não o padrão de 30) aprovado por pedido real estende a validade ~60 dias e NÃO libera automático (Manual puro é só manual) — prazo 60d nunca tinha sido exercido pela aprovação",
      combo90Ap.json?.ok === true && combo90St?.plan === "vip" &&
      _diasRestantes90 >= 58 && _diasRestantes90 <= 61 &&
      combo90St?.vip?.autoActive === false && combo90St?.manualLimit === 100,
      JSON.stringify({ ap: combo90Ap.status, plan: combo90St?.plan, diasRestantes: _diasRestantes90, auto: combo90St?.vip?.autoActive }).slice(0, 180));

    // ═══ 💼 MC5 — PARTE 2 (29/08): O USUÁRIO VÊ TUDO ═══════════════════════
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5a@test.com", name: "MC5 A" });
    const mc5vis = (await get("/api/pedidos")).json;
    const _rowA = (mc5vis?.pedidos || []).find((p2) => p2.id === mc5p1.json?.pedidoId);
    check("💼 MC5-P2 + v178: /api/pedidos do usuário virou WHITELIST — sem preCheck cru (vazava e-mail de OUTRO usuário no dupAlerta), sem notaAdmin/criadoPor internos; comprovanteStatus derivado SEGURO ('analise'); e o pedido aparece CANCELADO com o motivo real do auto-cancelamento (v178) visível no motivoCancelamento — a pessoa sabe exatamente por que precisa fazer um pedido novo",
      _rowA && !("preCheck" in _rowA) && !("notaAdmin" in _rowA) && !("criadoPor" in _rowA) &&
      _rowA.comprovanteStatus === "analise" && _rowA.comprovante === true && typeof _rowA.valorTotal === "number" &&
      _rowA.status === "cancelado" && /R\$100\.00.*R\$300\.00/.test(_rowA.motivoCancelamento || ""),
      JSON.stringify(_rowA).slice(0, 260));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    await req2("PATCH", "/api/pedido/" + mc5d1.json?.pedidoId, { status: "cancelado", notaAdmin: "valor não confere com o comprovante" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5c@test.com", name: "MC5 C" });
    const mc5visC = (await get("/api/pedidos")).json;
    const _rowC = (mc5visC?.pedidos || []).find((p2) => p2.id === mc5d1.json?.pedidoId);
    // (push ao usuário é no-op nesta reconstrução — `async function
    // pushToUser(){}` — não há canal de push real; o que sobrevive e é
    // real é o motivo aparecer pro usuário via /api/pedidos, testado abaixo.)
    check("💼 MC5-P2: doação cancelada mostra o MOTIVO pro usuário (motivoCancelamento) — a notícia ruim nunca mais é muda",
      _rowC && _rowC.status === "cancelado" && _rowC.motivoCancelamento === "valor não confere com o comprovante",
      JSON.stringify({ mot: _rowC?.motivoCancelamento }).slice(0, 140));
    const mc5re = await req2("POST", "/api/pedido/" + mc5d2.json?.pedidoId + "/comprovante", { comprovante: Buffer.from("pix-dois-novo-nitido").toString("base64"), comprovanteType: "image/png" });
    await new Promise((r2) => setTimeout(r2, 400));
    const mc5re403 = await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5d@test.com", name: "MC5 D" })
      .then(() => req2("POST", "/api/pedido/" + mc5d3.json?.pedidoId + "/comprovante", { comprovante: Buffer.from("nao-e-meu").toString("base64") }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5a@test.com", name: "MC5 A" });
    const mc5re400 = await req2("POST", "/api/pedido/" + mc5p1.json?.pedidoId + "/comprovante", { comprovante: Buffer.from("ja-ativo").toString("base64") });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _pdRe = (await get("/api/pedido/" + mc5d2.json?.pedidoId)).json?.pedido;
    check("💼 MC5-P2: reenvio de comprovante pelo DONO do pedido pendente substitui com trilha (hash anterior guardado, novo hash recalculado, leitura re-rodada) — outro usuário leva 403 e pedido já confirmado leva 400 (beco do comprovante ilegível FECHADO)",
      mc5re.json?.ok === true && _pdRe && _pdRe.comprovanteReenviadoEm > 0 && _pdRe.comprovanteHash &&
      _pdRe.comprovanteHash !== _pdRe.comprovanteAnteriorHash &&
      mc5re403.status === 403 && mc5re400.status === 400,
      JSON.stringify({ re: mc5re.status, h: !!_pdRe?.comprovanteHash, f403: mc5re403.status, f400: mc5re400.status }).slice(0, 140));
    const mc5pl = (await get("/api/planos")).json;
    check("💼 MC5-P2 → v170/v218: /api/planos entrega a mediana REAL de confirmação (promessa honesta no lugar do '24h' fixo) — fonte única de preço/limites pro checkout, nunca hardcoded (3 planos × 2 prazos desde a v218)",
      mc5pl?.ok === true && (typeof mc5pl?.medianaAprovacaoHoras === "number" || mc5pl?.medianaAprovacaoHoras === null) &&
      Array.isArray(mc5pl?.precos) && mc5pl.precos.length >= 6 && mc5pl?.limites?.vipro?.manual === 100,
      JSON.stringify({ med: mc5pl?.medianaAprovacaoHoras, n: mc5pl?.precos?.length }).slice(0, 100));

    // ═══ 💼 MC5 — PARTE 3 (29/08): UMA RÉGUA SÓ NAS TELAS DO ADMIN ═════════
    // 🕐 v172m (achado real, 13/09/2026): esta checagem dependia de gsm1/2/3
    // (dataGasto FIXA em agosto/2026, usadas de propósito pelos testes de
    // DRE/fechamento do mês "2026-08" mais acima) também caírem dentro da
    // janela ROLANTE "últimos 30 dias a partir de agora" — verdade só
    // enquanto "agora" ainda estava perto de agosto/2026. Assim que o
    // calendário real passou disso, a janela parou de alcançar essas datas
    // fixas e o teste começou a falhar por coincidência de calendário, não
    // por bug de produto. Lança um gasto de verdade com data RELATIVA a
    // Date.now() (mesmo padrão do gasto USD do MC5-P5 logo abaixo) — nunca
    // fica velho, e sem mexer nas fixtures estáticas (que o MC4-P1, mais
    // acima, já conferiu com somas EXATAS — um gasto novo ali quebraria
    // aquela conta).
    const gJan = await req2("POST", "/api/admin/financeiro", { action: "add_gasto", gasto: { valor: 40, categoria: "servidor", descricao: "Backup mensal (teste P3)", pagoPor: "andrio", dataGasto: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() } });
    const dr3 = (await get("/api/admin/dono-resumo")).json;
    check("💼 MC5-P3 (bug real): 'gastos 30d' da Visão do Dono lia dataPagamento (gasto usa dataGasto) e mostrava R$0 SEMPRE — agora soma de verdade (gasto real ≥ R$35,50 lançado há 5 dias) e o líquido 30d fecha (dias30 − gastos30)",
      gJan.json?.ok === true && dr3?.ok === true && dr3.gastos30 >= 35.49 &&
      Math.abs(dr3.liquido30 - (dr3.entradas?.dias30 - dr3.gastos30)) < 0.011,
      JSON.stringify({ g30: dr3?.gastos30, liq: dr3?.liquido30 }).slice(0, 100));
    const finP3 = (await get("/api/admin/financeiro")).json;
    const socP3 = (await get("/api/admin/socios")).json;
    check("💼 MC5-P3: o card 'Total recebido' do Financeiro agora mostra a régua CANÔNICA (janelas viajam na rota) — idêntica ao líquido do Acerto de Sócios (delta R$0) — e o Math.max híbrido morreu no front",
      finP3?.ok === true && finP3.entradas && typeof finP3.entradas.total === "number" &&
      Math.abs(finP3.entradas.total - socP3?.liquidoContabil) < 0.011 &&
      !_admHtml.includes("Math.max(window._receitaReal"),
      JSON.stringify({ jan: finP3?.entradas?.total, soc: socP3?.liquidoContabil }).slice(0, 100));
    const csvFin = await _getBufA("/api/admin/financeiro/exportar");
    const _csvFinTxt = csvFin.buf.toString("utf8");
    check("💼 MC5-P3: CSV da contabilidade vem do SERVIDOR pela fonte única — valor EFETIVO + dono pela régua do acerto (favulso1 sai como diego/explicito, nunca 'Andrio na marra') + gastos, com BOM",
      csvFin.status === 200 && csvFin.buf.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])) &&
      _csvFinTxt.includes("valor_efetivo;dono") &&
      _csvFinTxt.includes("Entrada Avulsa;;77,00;77,00;diego;explicito") &&
      _csvFinTxt.includes("GASTO;"),
      _csvFinTxt.split("\n").find((l) => l.includes("Entrada Avulsa"))?.slice(0, 120) || _csvFinTxt.slice(0, 120));
    // (aba Mensal/fin-insights/Pagantes são UI do admin.html ANTIGO — o
    // admin.html enxuto desta reconstrução não tem essas telas; a parte
    // real e viva no server.js é o cálculo em si: lucro HONESTO sem
    // Math.max(0) e o canônico excluindo anulado/ajuste.)
    check("💼 MC5-P3: (estrutural) fin-insights com lucro HONESTO (sem Math.max(0)) e canônico exclui anulado/ajuste",
      _srvSrc.includes("parteAndrio") && !_srvSrc.includes("Math.max(0,receitaTotal-despTotal)") &&
      _srvSrc.includes('if(pg.anuladoPor||pg.tipo==="ajuste")continue;'),
      "alguma régua honesta sumiu do server.js");

    // ═══ 💼 MC5 — PARTE 4 (29/08): TUDO CLICÁVEL E EXPLICADO ═══════════════
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const pedAdm4 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 30, userName: "Dono", userWhatsapp: "11 9", userCity: "SP" });
    const pedsAdm4 = (await get("/api/pedidos")).json;
    const _rAdm4 = (pedsAdm4?.pedidos || []).find((p2) => p2.id === pedAdm4.json?.pedidoId);
    const _rUsr4 = (pedsAdm4?.pedidos || []).find((p2) => p2.id === mc5p1.json?.pedidoId);
    await req2("PATCH", "/api/pedido/" + pedAdm4.json?.pedidoId, { status: "cancelado" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // (admin.html enxuto não tem a Visão do Dono com cards clicáveis,
    // "📖 Entenda os números" ou o card 🌍 Faturamento Global do painel
    // antigo — as peças reais e vivas são os dados/flags que a API expõe.)
    check("💼 MC5-P4: pedidos chegam marcados (ehAdmin pela lista real de e-mails de admin) — exclusão de teste de admin também vale no server (mesma régua da Conferência, agora _pedidoNaoEhReceita — v237v-FIX generalizou pra também excluir a conta de teste pelo isTeste do próprio pedido)",
      _rAdm4?.ehAdmin === true && _rUsr4?.ehAdmin === false &&
      _srvSrc.includes("if(_pedidoNaoEhReceita(pd))continue;"),
      JSON.stringify({ adm: _rAdm4?.ehAdmin, usr: _rUsr4?.ehAdmin }).slice(0, 80));

    // ═══ 💼 MC5 — PARTE 5 (29/08): QUEM RECEBEU/GASTOU 100% ════════════════
    // Dono do dinheiro NUNCA mais é chutado; gasto recorrente (Render todo
    // mês) e em dólar; repasse com comprovante; entrada manual com prova
    // some do "sem comprovante"; corte de mês em horário de Brasília.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5e@test.com", name: "MC5 E" });
    const mc5p5 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 E", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150", comprovante: Buffer.from("comp-mc5-e-p5").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const mc5Ap5 = await req2("PATCH", "/api/pedido/" + mc5p5.json?.pedidoId, { status: "ativo" }); // SEM recebidoPor, de propósito
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const finP5 = (await get("/api/admin/financeiro")).json;
    const _rowP5 = (finP5?.pagamentos || []).find((x) => x.pedidoId === mc5p5.json?.pedidoId);
    const _csvP5 = (await _getBufA("/api/admin/financeiro/exportar")).buf.toString("utf8");
    const _linP5 = _csvP5.split("\n").find((l) => l.includes(String(mc5p5.json?.pedidoId || "").slice(-8).toUpperCase()));
    check("💼 MC5-P5: aprovação SEM 'quem recebeu' não carimba mais um sócio na marra — o caixa nasce SEM recebidoPor e o dono sai da TRILHA (ativadoPorEmail do admin real → 'derivado', auditável no CSV)",
      mc5Ap5.json?.ok === true && _rowP5 && !("recebidoPor" in _rowP5) &&
      _rowP5.ativadoPorEmail === "andrio.usa2026@gmail.com" &&
      !!_linP5 && _linP5.includes(";andrio;derivado"),
      JSON.stringify({ ap: mc5Ap5.status, rp: _rowP5 && ("recebidoPor" in _rowP5), csv: (_linP5 || "").slice(0, 90) }));
    const avSem = await req2("POST", "/api/admin/financeiro", { action: "add_pagamento", pagamento: { valor: 91, nota: "entrada teste sem dono (P5)" } });
    const avCom = await req2("POST", "/api/admin/financeiro", { action: "add_pagamento", pagamento: { valor: 57, nota: "entrada com comprovante (P5)", recebidoPor: "empresa", comprovante: Buffer.from("comp-avulsa-57").toString("base64"), comprovanteType: "image/png" } });
    const finP5b = (await get("/api/admin/financeiro")).json;
    const _r91 = (finP5b?.pagamentos || []).find((x) => x.id === avSem.json?.id);
    const _r57 = (finP5b?.pagamentos || []).find((x) => x.id === avCom.json?.id);
    const socP5b = (await get("/api/admin/socios")).json;
    check("💼 MC5-P5: entrada manual sem dono (ou com dono FORA do enum) nasce SEM recebidoPor e cai honestamente em 'sem dono' no Acerto (antes qualquer coisa virava 'andrio' na marra) — e comprovante de entrada ganha fingerprint SHA-256 sem base64 na lista",
      _r91 && !("recebidoPor" in _r91) && _r57 && !("recebidoPor" in _r57) &&
      (socP5b?.entradas?.semDono?.itens || []).some((i) => i.id === avSem.json?.id) &&
      _r57.temComprovante === true && /^[0-9a-f]{64}$/.test(_r57.comprovanteHash || "") && !("comprovante" in _r57),
      JSON.stringify({ r91: _r91 && ("recebidoPor" in _r91), hash: (_r57?.comprovanteHash || "").slice(0, 12), semDonoN: socP5b?.entradas?.semDono?.n }));
    const gUsd = await req2("POST", "/api/admin/financeiro", { action: "add_gasto", gasto: { moeda: "USD", valorUSD: 10, cambio: 5, valor: 1, recorrente: true, categoria: "hospedagem", descricao: "Render (teste P5)", pagoPor: "empresa", dataGasto: new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString() } });
    const _gU = ((await get("/api/admin/financeiro")).json?.gastos || []).find((x) => x.id === gUsd.json?.id);
    const rec1 = await req2("POST", "/api/admin/financeiro", { action: "rodar_recorrentes" });
    const rec2 = await req2("POST", "/api/admin/financeiro", { action: "rodar_recorrentes" });
    const _gCopia = ((await get("/api/admin/financeiro")).json?.gastos || []).find((x) => x.recorrenteDe === gUsd.json?.id);
    check("💼 MC5-P5: gasto em DÓLAR converte pela MESMA régua do edit (10 USD × 5 = R$50, nunca o valor cru) e gasto RECORRENTE ganha a cópia do mês sozinho — idempotente (rodar 2x nunca duplica), sem comprovante (o push cobra o anexo)",
      _gU && _gU.valor === 50 && _gU.recorrente === true &&
      rec1.json?.ok === true && rec1.json?.criados === 1 && rec2.json?.criados === 0 &&
      _gCopia && _gCopia.valor === 50 && _gCopia.moeda === "USD" && !_gCopia.temComprovante && /recorrente automático/.test(_gCopia.descricao || ""),
      JSON.stringify({ v: _gU?.valor, c1: rec1.json?.criados, c2: rec2.json?.criados, copia: _gCopia?.valor }));
    const repP5 = await req2("POST", "/api/admin/financeiro", { action: "add_repasse", repasse: { valor: 12, de: "diego", nota: "Pix teste P5", comprovante: Buffer.from("comp-repasse-12").toString("base64"), comprovanteType: "image/png" } });
    const _rpP5 = ((await get("/api/admin/financeiro")).json?.repasses || []).find((x) => x.id === repP5.json?.id);
    const rpFull = (await get("/api/admin/repasse/" + repP5.json?.id)).json;
    check("💼 MC5-P5: repasse entre sócios com COMPROVANTE — a lista viaja SEM base64 (RAM protegida) mas com selo+hash, e o arquivo abre sob demanda na rota própria (mesmo modelo do gasto)",
      _rpP5 && _rpP5.temComprovante === true && !("comprovante" in _rpP5) && /^[0-9a-f]{64}$/.test(_rpP5.comprovanteHash || "") &&
      rpFull?.ok === true && typeof rpFull.repasse?.comprovante === "string" && rpFull.repasse.comprovante.length > 10,
      JSON.stringify({ tem: _rpP5?.temComprovante, hash: (_rpP5?.comprovanteHash || "").slice(0, 10), full: !!rpFull?.repasse?.comprovante }));
    // (a listagem "SEM COMPROVANTE" com reconhecimento de anexo próprio —
    // /api/admin/cerebro/lista — era do mod-cerebro.js, removido; o dado
    // real (semDono/comprovante por lançamento) já foi provado acima via
    // /api/admin/socios e /api/admin/financeiro.)
    check("💼 MC5-P5: (estrutural) corte de mês em horário de Brasília (−3h, fonte única) e robô de gasto recorrente existem no server",
      _srvSrc.includes("d.getTime()-3*3600*1000).toISOString().slice(0,7)") &&
      _srvSrc.includes("function _lancarGastosRecorrentes()") &&
      _srvSrc.includes('"/api/admin/repasse/"'),
      "corte BRT ou robô de recorrência sumiram do server.js");

    // ═══ 💼 MC5 — PARTE 6 (29/08): O CAIXA NUNCA APAGA ═════════════════════
    // Cancelamento vira AJUSTE− (fonte única do cérebro), gravação de
    // dinheiro conferida, action desconhecida = 400 na cara, e os eventos
    // do tempo real sobrevivem a deploy (fila persistida + retomada no boot).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5f@test.com", name: "MC5 F" });
    const p6ped = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 F", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150", comprovante: Buffer.from("comp-p6-f").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _janAntes6 = (await get("/api/admin/financeiro")).json?.entradas?.total;
    await req2("PATCH", "/api/pedido/" + p6ped.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    const _janMeio6 = (await get("/api/admin/financeiro")).json?.entradas?.total;
    const p6canc = await req2("PATCH", "/api/pedido/" + p6ped.json?.pedidoId, { status: "cancelado", notaAdmin: "teste P6 — caixa nunca apaga" });
    const finP6 = (await get("/api/admin/financeiro")).json;
    const _p6orig = (finP6?.pagamentos || []).find((x) => x.pedidoId === p6ped.json?.pedidoId && x.tipo !== "ajuste");
    const _p6aj = (finP6?.pagamentos || []).find((x) => x.tipo === "ajuste" && x.ajustaPedidoId === p6ped.json?.pedidoId);
    check("💼 MC5-P6: cancelar pedido APROVADO anula por AJUSTE− em vez de apagar — original preservado (anuladoPor com o motivo do admin), par de −150, e o líquido canônico volta EXATO ao de antes da aprovação (delta R$0)",
      p6canc.json?.ok === true && _p6orig && !!_p6orig.anuladoPor && /caixa nunca apaga/.test(_p6orig.anuladoPor.motivo || "") &&
      _p6aj && _p6aj.valor === -150 && !_p6aj.pedidoId &&
      Math.abs(_janMeio6 - _janAntes6 - 150) < 0.011 && Math.abs(finP6.entradas.total - _janAntes6) < 0.011,
      JSON.stringify({ antes: _janAntes6, meio: _janMeio6, fim: finP6?.entradas?.total, aj: _p6aj?.valor }).slice(0, 160));
    // (as checagens de RULE_CANCELLED_PAYMENT/lista de ajustes via
    // /api/admin/cerebro/* saíram — mod-cerebro.js não existe nesta
    // reconstrução; o comportamento real do caixa já foi provado acima)
    const badAct = await req2("POST", "/api/admin/financeiro", { action: "add_pagament0", pagamento: { valor: 10, nota: "typo" } });
    const _sem10 = !((await get("/api/admin/financeiro")).json?.pagamentos || []).some((x) => x.valor === 10 && x.nota === "typo");
    check("💼 MC5-P6: action desconhecida no caixa leva 400 com o nome do typo — antes era 'ok:true' mudo que não fazia NADA (o admin achava que salvou)",
      badAct.status === 400 && /desconhecida/i.test(badAct.json?.error || "") && /add_pagament0/.test(badAct.json?.error || "") && _sem10,
      (badAct.body || "").slice(0, 120));

    // ═══ 💼 MC5 — PARTE 7 (30/08): VIGIAS QUE NUNCA DORMEM ═════════════════
    // Auto-fechamento de meses antigos (rota própria, real nesta
    // reconstrução) — o resto da Parte 7 (vigia da diária, dead-man's
    // switch, ia-saude, tempo real via cérebro) dependia do mod-cerebro.js
    // removido e saiu.
    const _mesGusd = new Date(Date.now() - 32 * 24 * 3600_000 - 3 * 3600_000).toISOString().slice(0, 7);
    const fAuto = await req2("POST", "/api/admin/fechamento/auto", { ignorarDia3: true });
    const fAuto2 = await req2("POST", "/api/admin/fechamento/auto", { ignorarDia3: true });
    const _fechsP7 = (await get("/api/admin/fechamentos")).json;
    check("💼 MC5-P7: auto-fechamento agora pega TODOS os meses antigos abertos (o mês do gasto USD de 32 dias atrás fecha sozinho), nunca o corrente — e a 2ª rodada diz honestamente 'nenhum mês antigo aberto'",
      fAuto.json?.ok === true &&
      (_fechsP7?.fechamentos || []).some((f) => f.mes === _mesGusd) &&
      fAuto2.json?.ok === true && fAuto2.json?.skipped === "nenhum mês antigo aberto",
      JSON.stringify({ f1: fAuto.json?.fechados, f2: fAuto2.json?.skipped, mes: _mesGusd }).slice(0, 160));
    // (tempo real do cérebro, ia-saude, dead-man's switch da diária e o
    // vigia /api/admin/cerebro/vigia dependiam do mod-cerebro.js removido —
    // saíram; o auto-fechamento acima é a parte real que sobreviveu)

    // ═══ 🔐 v165: AUTENTICAÇÃO NUNCA CAI POR NOSSA CAUSA (caso real, 02/09:
    // usuário com Gmail "desconectando sempre" — envia 5-10min e pede login)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "authb@test.com", name: "Auth B" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "autha@test.com", name: "Auth A", senderEmails: [{ email: "authb@test.com", active: true, refresh_token: "rt-fake-b", addedAt: Date.now() }] });
    const remB = await req2("DELETE", "/api/sender/" + encodeURIComponent("authb@test.com"), {});
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const udB165 = (await get("/api/admin/user-detail/" + encodeURIComponent("authb@test.com"))).json;
    const finUA165 = (await get("/api/admin/financeiro-usuario/" + encodeURIComponent("autha@test.com"))).json;
    check("🔐 v165: remover como EXTRA um e-mail que é conta de LOGIN de alguém NUNCA mais revoga o grant no Google (revogar matava o login/automático daquela pessoa — grant é por conta Google, não por cópia) — e os DOIS lados ficam com o evento na linha do tempo",
      remB.json?.ok === true &&
      (udB165?.user?.authTimeline || []).some((ev) => ev.tipo === "revoke_pulado") &&
      finUA165?.ok === true && finUA165.auth && Array.isArray(finUA165.auth.timeline) &&
      finUA165.auth.timeline.some((ev) => ev.tipo === "sender_removido" && /sem revoke/.test(ev.detalhe || "")),
      JSON.stringify({ rem: remB.status, tlB: (udB165?.user?.authTimeline || []).map((e2) => e2.tipo), tlA: (finUA165?.auth?.timeline || []).map((e2) => e2.tipo) }).slice(0, 200));
    check("🔐 v165: (estrutural motor) token vencido no MEIO da fila renova sozinho e re-tenta (vaga nunca queimada por 'Invalid Credentials'), erro 'auth' só pausa depois que um refresh REAL confirma a queda, extra com auth morta é ISOLADO (robô segue pelas outras contas) e RECONECTAR só é marcado com queda confirmada pelo Google — nunca por erro de rede",
      _srvSrc.includes('"refresh_meio_fila"') && _srvSrc.includes('"refresh_provou_vivo"') &&
      _srvSrc.includes('_gmErr0.includes("Invalid Credentials")') &&
      _srvSrc.includes('"extra_isolado_auth"') &&
      (_srvSrc.match(/sem marcar RECONECTAR/g) || []).length >= 2 &&
      _srvSrc.includes("let _authRetried = false;"),
      "resiliência do motor incompleta");
    // (o raio-X 🔐 na 💳 Auditoria era UI do admin.html antigo — o admin.html
    // enxuto desta reconstrução não tem essa aba; o motor de diagnóstico em
    // si, no server, é real e continua vivo.)
    check("🔐 v165: (estrutural diagnóstico) linha do tempo de autenticação por usuário (ring 40) alimentada por login/refresh/pausas/revokes, e detector de QUEDA RÁPIDA (invalid_grant <30min após consent novo = Google da conta derrubando → instrução myaccount + push 1x/6h)",
      _srvSrc.includes("function _authEvent(") && _srvSrc.includes(".slice(0,40)}") &&
      _srvSrc.includes("function _diagQuedaAuth(") && _srvSrc.includes("lastConsentAt") &&
      _srvSrc.includes("está derrubando a autorização") &&
      _srvSrc.includes('"refresh_falhou"') && _srvSrc.includes('"login_consent"') && _srvSrc.includes('"revoke_mismatch"'),
      "diagnóstico de autenticação incompleto");

    // (MC5-P8 RELATÓRIOS PRONTOS — /api/admin/cerebro/relatorio-periodico e
    // /relatorios eram do mod-cerebro.js, removido nesta reconstrução.)

    // ═══ 📖 v160: CENTRAL DE TUTORIAIS — 28 partes com prints REAIS ════════
    // Ordem do dono (23/08): "quero prints nos tutoriais, explicando cada
    // detalhe". As fotos são telas verdadeiras do app (Playwright, fixtures
    // ricas) servidas por /tut-img/ — nunca base64 no HTML.
    {
      const _idx160 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _frag160 = (await get("/tutorial-conteudo")).body || "";
      const _tuts = _frag160.match(/<details class="tut-d" id="tut-(\d+)"/g) || [];
      const _ids = new Set(_tuts.map((m) => parseInt(m.match(/tut-(\d+)/)[1], 10)));
      const _appJs160 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      // Nesta reconstrução várias das 28 partes originais cobriam features
      // removidas (ranking, chat IA, notícias, códigos promo etc.) — restam
      // 20 partes reais, todas com palavras-chave; o mecanismo (busca sob
      // demanda) continua o mesmo.
      check(`📖 v160: o fragmento /tutorial-conteudo tem as ${_tuts.length} partes que sobraram (cada uma com palavras-chave) e a aba carrega sob demanda (loadTutorial) com busca (tutFiltra)`,
        _tuts.length === 20 &&
        (_frag160.match(/data-kw="/g) || []).length >= _tuts.length &&
        _idx160.includes('id="tut-conteudo"') && _idx160.includes('oninput="tutFiltra()"') &&
        _appJs160.includes("function tutFiltra") && _appJs160.includes("function loadTutorial") &&
        _appJs160.includes('if(v==="tutorial"){loadTutorial();}'),
        `tuts=${_tuts.length}`);
      // 🌐 regra 6f/catraca: as strings de UI da aba passam pelo dicionário nas 3 línguas
      check("📖 v160: strings de UI da aba (título/busca/vazio/carregando) no LANG_DICT em pt+en+es — a catraca de tradução continua zerada",
        ["tut_t", "tut_s", "tut_ph", "tut_v", "tut_load"].every((k) => (_appJs160.match(new RegExp('"' + k + '":"', "g")) || []).length === 3) &&
        _idx160.includes('data-i18n="tut_t"') && _idx160.includes('data-i18n-ph="tut_ph"'),
        "chaves tut_ ausentes em alguma língua");
      const _imgsRef = [...new Set((_frag160.match(/\/tut-img\/[a-z0-9-]+\.jpg/g) || []))];
      const _faltando = _imgsRef.filter((u2) => !fs.existsSync(path.join(__dirname, "tutorial-img", u2.split("/").pop())));
      // v170 (09/09): 5 prints do fluxo antigo de diamante/doação/código saíram
      // do tutorial (t21-planos/t22-doacao/t23-troca/t25-missoes/t25-codigo —
      // telas que não existem mais) — piso recalibrado pra realidade atual.
      // v189 LOTE 7: saiu também o print do card "Notificações" do Perfil —
      // o passo "Ativar as notificações push" deixou de existir (o site não
      // manda notificação nenhuma), então o print seria de uma tela que não
      // existe. O arquivo t05-notificacoes.jpg foi apagado do repo junto.
      check("📖 v160: TODAS as fotos referenciadas nos tutoriais existem de verdade no disco (nenhum print quebrado)",
        _imgsRef.length >= 9 && _faltando.length === 0,
        JSON.stringify({ refs: _imgsRef.length, faltando: _faltando }).slice(0, 200));
      const _img160 = await _getBufA("/tut-img/t01-landing.jpg");
      const _trav160 = await get("/tut-img/..%2Fserver.js");
      const _nada160 = await get("/tut-img/nao-existe.jpg");
      check("📖 v160: a rota /tut-img serve a foto real (200, image/jpeg) e RECUSA nome fora do padrão (traversal encodado) e arquivo inexistente",
        _img160.status === 200 && String(_img160.headers["content-type"]).includes("image/jpeg") && _img160.buf.length > 10_000 &&
        _trav160.status === 404 && _nada160.status === 404,
        JSON.stringify({ st: _img160.status, len: _img160.buf?.length, trav: _trav160.status, nada: _nada160.status }).slice(0, 140));
    }

    // (v161 CURA DA CAMADA GEMINI — sem geminiGenerate, sem GEMINI_API_KEY,
    // sem /api/admin/ia-saude nesta reconstrução. README: "sem nenhuma
    // verificação por IA, aprovação sempre manual pelo admin".)

    // 🩺 v155 (caso Esdras: "desbaniu e continua barrado" — a causa era OUTRA
    // porta): raio-X do login testa as portas de bloqueio LOCAIS (ban, conta
    // existe, flags de trial).
    const dg1 = await get("/api/admin/diagnostico-login?email=" + encodeURIComponent("smoke@test.com"));
    check("🩺 v155: diagnóstico de conta EXISTENTE → nenhum bloqueio e explica que o login é liberado",
      dg1.json?.ok === true && (dg1.json?.problemas || []).length === 0 && (dg1.json?.info || []).some((x) => /Conta EXISTE/.test(x)),
      (dg1.body || "").slice(0, 160));
    const dg2 = await get("/api/admin/diagnostico-login?email=" + encodeURIComponent("naoexiste.diag@test.com"));
    check("🩺 v155: e-mail SEM conta → nenhum bloqueio, seria cadastro novo",
      dg2.json?.ok === true && (dg2.json?.problemas || []).length === 0 &&
      (dg2.json?.info || []).some((x) => /CADASTRO NOVO/.test(x)),
      (dg2.body || "").slice(0, 250));

    // ═══ 🐛 v172c-FIX (bug real, 12/09/2026): resolveSendGmail ═══
    // Bug encontrado em auditoria: login normal virou usuário+senha (v172c)
    // e o username escolhido (SEM @) ficava gravado como u.email/identidade
    // — mas /oauth/connect-send e o motor de envio (manual e automático)
    // comparavam/usavam esse valor como se fosse o Gmail de verdade.
    // Resultado: 100% dos usuários criados depois do v172c eram BLOQUEADOS
    // pra sempre ao tentar conectar o Gmail de envio (username nunca bate
    // com um endereço @gmail.com real), e mesmo que bloqueassem essa trava,
    // o "From:" do e-mail saía com o username em vez de um Gmail — o motor
    // de candidaturas (razão de existir do site) ficava 100% quebrado pra
    // conta nova. Corrigido com u.gmailEmail (carimbado na 1ª conexão bem
    // sucedida) + resolveSendGmail (mod-gmail.js), fonte única usada em
    // /oauth/connect-send (login_hint + trava de reconexão) e no motor de
    // envio (manual e automático).
    const { resolveSendGmail } = require("./mod-gmail.js");
    check("🐛 resolveSendGmail: conta NOVA (username sem @, nunca conectou Gmail) → null (1ª conexão aceita qualquer conta)",
      resolveSendGmail({email:"joaosilva123"}) === null);
    check("🐛 resolveSendGmail: conta NOVA já conectou um Gmail antes (gmailEmail carimbado) → trava nesse Gmail",
      resolveSendGmail({email:"joaosilva123",gmailEmail:"Joao.Silva@Gmail.com"}) === "joao.silva@gmail.com");
    check("🐛 resolveSendGmail: conta LEGADA (e-mail de login já É um Gmail real, sem gmailEmail carimbado) → usa o próprio e-mail",
      resolveSendGmail({email:"andrio.usa2026@gmail.com"}) === "andrio.usa2026@gmail.com");
    check("🐛 resolveSendGmail: gmailEmail carimbado tem PRIORIDADE sobre o e-mail de login, mesmo em conta legada",
      resolveSendGmail({email:"andrio.usa2026@gmail.com",gmailEmail:"outro@gmail.com"}) === "outro@gmail.com");
    check("🐛 resolveSendGmail: sem registro nenhum (owner null/undefined) → null, nunca quebra",
      resolveSendGmail(null) === null && resolveSendGmail(undefined) === null);

    // ═══ 🐛 v172c-FIX rodada 2 (auditoria adversarial, 12/09/2026): outros ═══
    // lugares que ainda tratavam a identidade de login (username sem @ pra
    // conta nova) como se fosse sempre um Gmail de verdade — achados DEPOIS
    // do fix crítico do connect-send/motor de envio, revisando o resto do
    // produto com a mesma lupa. Todos resolvidos com a MESMA fonte única
    // (resolveSendGmail / findAccountByRealGmail), nunca uma 2ª lógica.
    check("🐛 v172c-FIX: {email} do template automático usa _autoRealSendEmail (Gmail real), não o username cru",
      _srvSrc.includes("email:      String(_autoRealSendEmail)") || _srvSrc.includes("email: String(_autoRealSendEmail)"),
      "tplVars.email não usa _autoRealSendEmail — {email} nos assuntos/corpos do envio automático voltaria a vazar o username");
    check("🐛 v172c-FIX: histórico/log do envio automático (senderEmail) usa _autoRealSendEmail, nunca mais _autoSenderEmail||email cru",
      !_srvSrc.includes("senderEmail: _autoSenderEmail || email") && !_srvSrc.includes("senderEmail:_autoSenderEmail||email"),
      "ainda existe um senderEmail:_autoSenderEmail||email cru no motor automático — 'Enviado por (Gmail)' voltaria a mostrar o username");
    check("🐛 v172c-FIX: histórico do envio MANUAL resolve senderEmail pelo Gmail real quando é o principal quem envia",
      _srvSrc.includes("(actualSenderEmail && actualSenderEmail !== s.user_email) ? actualSenderEmail : (resolveSendGmail(p) || s.user_email)"),
      "senderEmail do envio manual não resolve mais pelo resolveSendGmail — histórico voltaria a mostrar o username em vez do Gmail");
    check("🐛 v172c-FIX: fill() do cliente (envio manual) usa U.gmailEmail antes do username pro {email}",
      _appSrc172d.includes("U?.gmailEmail||U?.email") || _appSrc172d.includes("U?.gmailEmail || U?.email"),
      "fill() ainda usa só U?.email pro {email} — candidatura manual voltaria a vazar o username pro empregador");
    check("🐛 v172c-FIX: /api/status devolve gmailEmail (Gmail real resolvido) — front finalmente consegue mostrar o Gmail certo",
      _srvSrc.includes("const gmailEmail = resolveSendGmail(p);") && _srvSrc.includes("gmailConnected,gmailEmail,emailContato:p.emailContato||null,emailVerificado:!!p.emailVerificadoEm,needsPlan"),
      "/api/status não expõe mais gmailEmail — dropdown/checklist de remetente e {email} manual ficariam sem fonte de verdade");
    check("🐛 v172c-FIX: dropdown 'Enviar por' e checklist do Automático mostram o Gmail real (rótulo), mantendo o value original",
      _appSrc172d.includes("lbl:(U.gmailEmail||U.email)+\" (principal)\"") && _appSrc172d.includes("label:U.gmailEmail||U.email"),
      "rótulo do dropdown/checklist não usa mais U.gmailEmail — voltaria a mostrar o username rotulado '(principal)'");
    check("🐛 v172c-FIX: /oauth/add-sender/callback trava duplicar o PRÓPRIO Gmail principal como extra via resolveSendGmail (não só comparando o username)",
      _srvSrc.includes("const _principalGmail2=resolveSendGmail(owner2);") && _srvSrc.includes("(_principalGmail2&&newEmail2===_principalGmail2)||newEmail2===ownerEmail2"),
      "guarda de e-mail principal duplicado não usa resolveSendGmail — conta nova conseguiria re-registrar o próprio Gmail como 'extra'");
    check("🐛 v172c-FIX: DELETE /api/sender reconhece o Gmail conectado de uma conta v172c antes de revogar (findAccountByRealGmail)",
      _srvSrc.includes("function findAccountByRealGmail(email)") && _srvSrc.includes("const _donoLogin=findAccountByRealGmail(emailToRemove);"),
      "DELETE /api/sender ainda usa getUser(emailToRemove) puro — revoke podia derrubar o Gmail de envio de uma conta v172c sem aviso (v165 furado)");
    check("🐛 v172c-FIX: admin.html não bloqueia mais 'E-mail do cliente' com validação nativa de e-mail (aceita username v172c)",
      !/id="pg-email"[^>]*type="email"/.test(fs.readFileSync(path.join(__dirname,"admin.html"),"utf8")),
      "campo pg-email ainda é type=email — admin não consegue linkar pagamento a cliente cadastrado por username");
    check("🐛 v172c-FIX: e-mail de aviso de novo pedido ao admin não rotula mais o username como 'Email' (mostra login + Gmail conectado separados)",
      _srvSrc.includes("🪪 Usuário (login): ${pedido.userEmail") && _srvSrc.includes("📧 Gmail conectado: ${_realGmailForMail"),
      "aviso de novo pedido ainda rotula pedido.userEmail como Email — confunde o admin quando é um username");

    // ═══ 🚨 Auditoria de segurança adversarial do login novo (v172b/v172c), ═══
    // 12/09/2026 — achados CRÍTICOS/HIGH corrigidos:
    check("🚨 v172c-SEC: boot avisa alto no log quando ADMIN_PANEL_PASS_ANDRIO/_DIEGO não estão definidas (mesmo padrão do DATA_ENC_KEY)",
      _srvSrc.includes("[SEGURANÇA]") && _srvSrc.includes("está usando a senha de FÁBRICA"),
      "aviso de boot da senha de fábrica não encontrado no server.js");
    check("🚨 v172c-SEC: sanitizeUserForClient() nunca mais deixa passwordHash/passwordSalt vazar pro navegador",
      _srvSrc.includes("password:undefined,refresh_token:undefined,cached_access_token:undefined,passwordHash:undefined,passwordSalt:undefined"),
      "sanitizeUserForClient não redige passwordHash/passwordSalt — /api/debug/export e /api/admin/user-detail vazam credencial de todo mundo");
    check("🚨 v172c-SEC: passwordHash/passwordSalt entram na mesma cifra em disco dos tokens OAuth (defesa extra contra vazamento de backup)",
      _srvSrc.includes('USER_SECRET_FIELDS=["refresh_token","cached_access_token","passwordHash","passwordSalt"]'),
      "USER_SECRET_FIELDS não inclui mais passwordHash/passwordSalt");
    check("🚨 v172c-SEC: _hashPw/_verifyPw viraram assíncronos (scrypt no threadpool) — login/cadastro não trava mais o site inteiro pra todo mundo",
      _srvSrc.includes("async function _hashPw(senha,saltHex)") && _srvSrc.includes("async function _verifyPw(senha,saltHex,hashHex)") && _srvSrc.includes("const _scryptAsync = util.promisify(crypto.scrypt);"),
      "_hashPw/_verifyPw continuam síncronos — scryptSync ainda bloqueia o event loop único");
    check("🚨 v172c-SEC: cadastro reconfere o username por baixo do hash assíncrono (nunca sobrescreve um cadastro concorrente em silêncio)",
      _srvSrc.includes("if(getUser(username))return json(res,409,{error:\"Esse nome de usuário já existe. Escolha outro ou entre na sua conta.\"});\n      const nomeCompleto=(nome+\" \"+sobrenome).trim();"),
      "reconferência pós-hash do username não encontrada — corrida de cadastro concorrente pode voltar");
    check("🚨 v172c-SEC: rate-limit das rotas de login/cadastro usa o ÚLTIMO valor de X-Forwarded-For (o que o Render realmente viu), nunca o primeiro (forjável pelo cliente)",
      _srvSrc.includes("function _clientIp(req)") &&
      (_srvSrc.match(/const _ip=_clientIp\(req\);/g)||[]).length>=3 &&
      _srvSrc.includes("const ip=_clientIp(req);") &&
      !/x-forwarded-for["\]]*\)?\s*\|\|[^;]*\)\.split\(","\)\[0\]/.test(_srvSrc),
      "extração de IP das rotas de auth não usa mais _clientIp — rate-limit de força-bruta pode continuar contornável");
    check("🚨 v172c-SEC: /api/admin/set-password derruba todas as sessões antigas do usuário ao trocar a senha (senha velha para de valer na hora)",
      _srvSrc.includes("_sessõesDerrubadas++"),
      "set-password não derruba mais sessões antigas — reset de senha não protege contra sessão já aberta");

    // ═══ 🛡️ v73: AQUECIMENTO DE CONTA GMAIL NOVA (proteção anti-bloqueio) ═══
    // Pedido real do dono: "tem gente sendo bloqueada pelo Google". A defesa:
    // conta recém-conectada manda pouco nos primeiros dias, ganha volume aos
    // poucos — e uma conta suspensa isolada não trava as outras contas saudáveis.
    const { warmupCapForSender: _warmupFn, daysSince: _daysSinceFn, createCalcSmartInterval } = require("./mod-engine-core.js");

    // ═══ 🎯 ordem do dono, 12/09/2026: automático do ADMIN — 5min por
    // e-mail (padrão, sem customizar nada), dividido pelo nº de e-mails
    // conectados ativos (pra que CADA e-mail individual continue ~5min). ═══
    const _mkCalc = (fakeUsers) => createCalcSmartInterval({
      getUser: (email) => fakeUsers[email], isAdminVip: (u) => !!u?._admin,
    });
    const _calcAdm1 = _mkCalc({ "adm1@test.com": { email: "adm1@test.com", _admin: true, senderEmails: [] } });
    const _ivAdm1 = _calcAdm1("adm1@test.com");
    check("🎯 admin SEM customizar intervalo, 1 e-mail conectado → ~5min (255-345s com jitter ±15%)",
      _ivAdm1 >= 255_000 && _ivAdm1 <= 345_000, `iv=${Math.round(_ivAdm1 / 1000)}s`);
    const _calcAdm2 = _mkCalc({ "adm2@test.com": { email: "adm2@test.com", _admin: true, senderEmails: [{ email: "extra@x.com", active: true }] } });
    const _ivAdm2 = _calcAdm2("adm2@test.com");
    check("🎯 admin com 2 e-mails conectados (principal+extra) → intervalo GERAL cai pela metade (~2,5min) pra cada e-mail continuar ~5min",
      _ivAdm2 >= 127_000 && _ivAdm2 <= 173_000, `iv=${Math.round(_ivAdm2 / 1000)}s`);
    const _calcAdmCustom = _mkCalc({ "adm3@test.com": { email: "adm3@test.com", _admin: true, adminSettings: { intervalSecs: 600 }, senderEmails: [] } });
    const _ivAdmCustom = _calcAdmCustom("adm3@test.com");
    check("🎯 admin com intervalo customizado (10min) continua respeitando o valor configurado",
      _ivAdmCustom >= 510_000 && _ivAdmCustom <= 690_000, `iv=${Math.round(_ivAdmCustom / 1000)}s`);
    const _calcComum = _mkCalc({ "comum@test.com": { email: "comum@test.com", senderEmails: [] } });
    const _ivComum = _calcComum("comum@test.com");
    check("🎯 usuário comum NÃO muda — continua 6,5-7,5min (regra v118 intacta, só o admin ganhou padrão novo)",
      _ivComum >= 6.5 * 60_000 && _ivComum <= 7.5 * 60_000, `iv=${Math.round(_ivComum / 1000)}s`);

    // ═══ 🎯 limite diário REAL do automático do admin: 450/dia POR e-mail
    // conectado (era 9999 pra conta inteira, nunca pausava nada de verdade) ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "admauto@test.com", name: "Admin Auto", isAdmin: true });
    const asAdm1 = await get("/api/auto/status");
    check("🎯 admin com 1 e-mail (só o principal) → autoLimit = 450 (padrão por sender)",
      asAdm1.json?.autoLimit === 450, `autoLimit=${asAdm1.json?.autoLimit}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "admauto@test.com", senderEmails: [{ email: "extra1auto@test.com", active: true }] });
    const asAdm2 = await get("/api/auto/status");
    check("🎯 admin com 2 e-mails (principal+extra ativo) → autoLimit = 900 (450×2, nunca um total único pra conta)",
      asAdm2.json?.autoLimit === 900, `autoLimit=${asAdm2.json?.autoLimit}`);
    await req2("POST", "/api/admin/my-settings", { senderLimits: { "admauto@test.com": 100 } });
    const asAdm3 = await get("/api/auto/status");
    check("🎯 senderLimits customizado (antes campo morto) agora É respeitado por e-mail — principal com teto 100 + extra no padrão 450 = 550",
      asAdm3.json?.autoLimit === 550, `autoLimit=${asAdm3.json?.autoLimit}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "admauto@test.com", senderEmails: [{ email: "extra1auto@test.com", active: true, blocked: true }] });
    const asAdm4 = await get("/api/auto/status");
    check("🎯 e-mail extra BLOQUEADO não conta no total (só o principal com teto customizado: 100)",
      asAdm4.json?.autoLimit === 100, `autoLimit=${asAdm4.json?.autoLimit}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true }); // restaura sessão de teste padrão
    check("🎯 (estrutural) getAutoLimit(admin) soma 450/sender — nunca mais retorna 9999 fixo pra conta inteira",
      _srvSrc.includes("perSenderAutoLimit(u,s.email)") && !_srvSrc.includes("// Admin: respeita senderLimits se configurado, senão 9999"),
      "cálculo por sender não encontrado em getAutoLimit");
    check("🎯 (estrutural) o teto de 450/dia por sender TAMBÉM pausa o robô do admin (waiting_limit) — antes só usuário comum pausava",
      !_srvSrc.includes("if(!isAdminVip(p) && todayAuto>=autoLimit)") && !_srvSrc.includes("if(!isAdminVip(p)&&todayAuto>=autoLimit)return json(res,429"),
      "gate de limite diário ainda isenta admin em algum lugar");
    check("🎯 (estrutural) seleção de remetente do automático do ADMIN é ALEATÓRIA (nunca round-robin determinístico só pra ele) — usuário comum continua round-robin",
      _srvSrc.includes("if (isAdminVip(p)) {") && /Math\.random\(\) \* \(i \+ 1\)/.test(_srvSrc) && _srvSrc.includes("pool.sort((a, b) => (countBySender[a.countKey]"),
      "embaralhamento aleatório do pool de senders do admin não encontrado");
    // 🐛 v172e (auditoria, 12/09/2026): getSenderToken contava o rodízio/
    // aquecimento/teto-de-admin pela IDENTIDADE de login do principal
    // (ownerEmail) — mas o histórico real grava o Gmail REAL conectado
    // (resolveSendGmail) pra esse mesmo envio. Pra conta v172c (username
    // sem '@'), countBySender[ownerEmail] nunca batia com a chave real do
    // histórico e ficava sempre 0: o principal sempre "parecia" ter
    // enviado 0 hoje, furando o rodízio 1-a-1 com extras, o teto de
    // aquecimento (13a) e o teto de 450/dia por sender do admin.
    check("🐛 v172e-FIX: pool do round-robin conta o principal pela chave REAL do histórico (resolveSendGmail), não pelo username de login",
      _srvSrc.includes("const _principalCountKey = resolveSendGmail(p) || ownerEmail;") &&
      _srvSrc.includes("{ email: ownerEmail, countKey: _principalCountKey, isPrincipal: true, addedAt: p?.gmailConnectedAt || p?.created_at }") &&
      _srvSrc.includes("...extrasOk.map(s => ({ ...s, countKey: s.email, isPrincipal: false }))"),
      "getSenderToken não monta mais o pool com countKey resolvido — contagem do principal v172c voltaria a ficar sempre 0");
    check("🐛 v172e-FIX: filtro de aquecimento, teto do admin e sort do rodízio leem countBySender pela chave resolvida (countKey), nunca mais por c.email cru",
      _srvSrc.includes("return cap === null || (countBySender[c.countKey] || 0) < cap;") &&
      _srvSrc.includes("const withinDaily = pool.filter(c => (countBySender[c.countKey] || 0) < perSenderAutoLimit(p, c.countKey));") &&
      !_srvSrc.includes("(countBySender[c.email] || 0) < cap") &&
      !_srvSrc.includes("(countBySender[c.email] || 0) < perSenderAutoLimit"),
      "algum dos 3 usos (aquecimento/admin/sort) ainda lê countBySender pela identidade crua — a conta v172c continuaria sempre com contagem 0");
    // 🐛 v172e-FIX (auditoria, 12/09/2026): 2 caminhos de erro em /api/send
    // (pdfMissing e WARMUP_CAP_REACHED) faziam "return" depois de reservar
    // o slot manual (_reserveManualSlot) sem liberar — a reserva ficava
    // "fantasma" até o setTimeout de 60s, podendo gerar um 429 de limite
    // indevido num reenvio rápido legítimo. Difícil de testar via HTTP sem
    // depender de timing entre requisições concorrentes — guarda estrutural
    // confirma que os 2 pontos exatos liberam a reserva antes do return.
    check("🐛 v172e-FIX: /api/send libera a reserva de slot ANTES do return em erro de currículo ausente (pdfMissing) e de conta em aquecimento (warmup) — nunca mais reserva fantasma por até 60s",
      /if\(_reservedManualSlot\)\{_releaseManualSlot\(s\.user_email\);_reservedManualSlot=false;\}\s*\n\s*return json\(res,400,\{error:"Seu currículo \(PDF\) não foi encontrado no servidor/.test(_srvSrc) &&
      /if\(_reservedManualSlot\)\{_releaseManualSlot\(s\.user_email\);_reservedManualSlot=false;\}\s*\n\s*return json\(res,429,\{error:"Essa conta Gmail atingiu o limite de segurança de hoje/.test(_srvSrc),
      "um dos 2 releases antes do return não foi encontrado — a reserva de slot pode voltar a vazar por até 60s nesses erros");
    check("🐛 v172e-FIX: getAutoLimit(admin) resolve o Gmail real do principal antes de somar o teto por sender (mesma classe do bug do getSenderToken)",
      _srvSrc.includes("const senders=[{email:resolveSendGmail(u)||u.email},...(u.senderEmails||[]).filter(s=>!s.blocked&&!s.tokenExpired)];"),
      "getAutoLimit ainda soma o teto do principal pela identidade crua — admin v172c que customizasse o teto do próprio Gmail principal veria o total errado");
    check("🌱 aquecimento: conta de HOJE (dia 0) tem teto de 15/dia", _warmupFn(new Date().toISOString()) === 15, `cap=${_warmupFn(new Date().toISOString())}`);
    check("🌱 aquecimento: conta de 4 dias tem teto de 40/dia", _warmupFn(Date.now() - 4 * 86400_000) === 40, `cap=${_warmupFn(Date.now() - 4 * 86400_000)}`);
    check("🌱 aquecimento: conta de 10 dias tem teto de 100/dia", _warmupFn(Date.now() - 10 * 86400_000) === 100, `cap=${_warmupFn(Date.now() - 10 * 86400_000)}`);
    check("🌱 aquecimento: conta de 20 dias já GRADUOU (sem teto extra, null)", _warmupFn(Date.now() - 20 * 86400_000) === null, `cap=${_warmupFn(Date.now() - 20 * 86400_000)}`);
    check("🌱 aquecimento: sem data conhecida (addedAt ausente) NUNCA bloqueia por falta de dado", _warmupFn(undefined) === null && _daysSinceFn(undefined) === Infinity);

    // Estrutural (mesmo padrão da checagem de escopo OAuth): confirma que a
    // defesa central existe no código-fonte — regressão aqui é séria
    // (usuário real ficando bloqueado pelo Google de novo).
    check("🛡️ getSenderToken PREFERE o pool dentro do teto de aquecimento (round-robin ainda evita conta em risco quando tem opção)",
      _srvSrc.includes("warmupCapForSender(c.addedAt)") && _srvSrc.includes("const withinWarmup"),
      "trecho warmupCapForSender/withinWarmup não encontrado");
    check("🛡️ conta suspensa (não-principal) é ISOLADA (blocked:true) e o automático CONTINUA pelas outras — não pausa tudo à toa",
      _srvSrc.includes('blocked:true,blockedReason:errType') && _srvSrc.includes("automático CONTINUA pelas outras contas"),
      "lógica de isolamento por sender não encontrada");

    // ═══ 🛡️ v76: aquecimento NUNCA mais pausa o automático (ordem do dono,
    // 27/07, cliente pago vendo "waiting_warmup" travado: "eu quero nao nunca
    // pare o automático") ═══ — o teto por conta virou preferência de
    // rodízio, não bloqueio: se TODAS as contas já bateram o teto de hoje,
    // usa a menos carregada mesmo assim e segue no intervalo normal, em vez
    // de pausar até amanhã.
    check("🛡️ round-robin não lança mais WARMUP_CAP_REACHED quando todas as contas estão no teto (usa o pool inteiro em vez de travar)",
      !_srvSrc.includes("else throw new Error(\"WARMUP_CAP_REACHED\")"),
      "ainda existe um throw incondicional de WARMUP_CAP_REACHED no round-robin");
    check("🛡️ status waiting_warmup (pausa de até 3h esperando o teto zerar) foi REMOVIDO do motor automático",
      !_srvSrc.includes('status:"waiting_warmup"'),
      "status waiting_warmup ainda sendo atribuído — automático ainda pode pausar por aquecimento");

    // ═══ 🛡️ v77c: BUG REAL achado revisando o v77b — /api/admin/pedido-set-valor
    // referenciava uma variável `body` que NUNCA existia no escopo (faltava
    // o readBody/JSON.parse). Sem try/catch ao redor, o ReferenceError
    // acontecia DENTRO do callback assíncrono do request handler e nunca
    // virava resposta HTTP — a requisição ficava PENDURADA PRA SEMPRE (o
    // admin via a tela girando; o smoke-test, que não tinha cobertura pra
    // essa rota antes do v77b, travou o processo inteiro por +40min até eu
    // achar). Guarda estrutural: confirma que a rota lê o body de verdade e
    // nunca mais referencia uma variável `body` não declarada.
    // ⚠️ CHECK SUBSTITUÍDO no v194 LOTE 12: o do v77c garantia que a rota
    // `pedido-set-valor` lia o body direito. A rota foi REMOVIDA (ordem v178),
    // então a guarda vira NEGATIVA — senão a regra volta a entrar sozinha numa
    // sessão futura. A lição do v77c (rota sem try/catch referenciando
    // variável inexistente PENDURA a requisição pra sempre) continua valendo
    // pra toda rota nova; o que não pode voltar é este caminho de dinheiro.
    check("🚫 v194-L12 (estrutural): nenhum caminho de 'corrigir valor de pedido' pode voltar — nem a rota /api/admin/pedido-set-valor, nem o branch corrigirValor que reescrevia o pedido e o caixa",
      !_srvSrc.includes('pathname==="/api/admin/pedido-set-valor"') &&
      !_srvSrc.includes("pd.valorCorrigidoPor=s.user_email") &&
      _srvSrc.includes("correcaoRemovida:true") &&
      _srvSrc.includes("valorCorrigidoPor:pd.valorCorrigidoPor||null"),
      "rota/branch de correção de valor de pedido de volta, ou a trilha de leitura (valorOriginal/valorCorrigidoPor) sumiu das respostas");

    // ═══ 🛡️ v75: rate limit do Google NÃO pausa mais o automático ═══
    // Ordem do dono (27/07): "automático só deve parar se o Google bloquear,
    // se não bloquear vai enviar sempre". Rate limit (429) é só o Google
    // pedindo pra desacelerar, não um bloqueio de verdade — antes disso
    // pausava a fila por até 12h ("O Google pediu uma pausa"); agora só
    // segue no intervalo humanizado normal, sem nunca atribuir o status
    // waiting_rate_limit de novo (suspensão/desativação de conta continua
    // pausando de verdade — isso É bloqueio real).
    check("🛡️ rate limit do Google não pausa mais a fila (só segue no intervalo normal)",
      _srvSrc.includes("Seguindo no ritmo normal — não é um bloqueio") && !_srvSrc.includes('status:"waiting_rate_limit"') && !_srvSrc.includes("status:'waiting_rate_limit'"),
      "mensagem nova não encontrada, ou status waiting_rate_limit ainda sendo atribuído em algum lugar");
    check("🛡️ bloqueio de verdade (conta suspensa/desativada) continua pausando — só o rate limit parou de pausar",
      _srvSrc.includes('errType === "suspended" || errType === "send_disabled"'));

    // Ponta a ponta: /api/status expõe o campo primaryWarmup de verdade (o
    // fixture cliente@test.com não tem created_at → fail-open correto: sem
    // dado de quando a conta nasceu, NUNCA bloqueia por falta de informação
    // — comportamento de segurança, não um bug).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const stW = await get("/api/status");
    check("🌱 /api/status expõe primaryWarmup (fail-open: sem created_at no fixture → sem teto, nunca bloqueia à toa)", stW.json?.primaryWarmup && stW.json.primaryWarmup.cap === null, JSON.stringify(stW.json?.primaryWarmup));

    // ═══ 🔌 v195 LOTE 13: Gmail de envio — reconectar volta a ligar o robô,
    // e o aquecimento do PRINCIPAL passa a contar do dia da CONEXÃO ═══
    {
      // (1) O relógio do aquecimento do Gmail principal era o created_at do
      // CADASTRO — mas desde o v172c o Gmail só é conectado DEPOIS de pagar:
      // uma conta antiga conectava um Gmail novinho e entrava sem teto nenhum
      // (cap=null), justo o caso que o aquecimento existe pra proteger.
      await req2("POST", "/api/test/login", {
        token: TEST_TOKEN, email: "gwarm@test.com", name: "Gmail Novo",
        createdAt: new Date(Date.now() - 200 * 86400_000).toISOString(),
        gmailConnectedAt: Date.now(),
      });
      const _stGW = await get("/api/status");
      check("🌱 v195-L13: conta CADASTRADA há 200 dias que conectou o Gmail HOJE entra no aquecimento de dia 1 (teto 15/dia) — antes o relógio era o do cadastro e um Gmail novinho saía sem teto nenhum",
        _stGW.json?.primaryWarmup?.cap === 15, JSON.stringify(_stGW.json?.primaryWarmup));

      // (2) Robô parado por autenticação volta SOZINHO na reconexão do Gmail —
      // e o ritmo de ~7min é preservado (nextSendAt intacto, sem envio na hora).
      const _next13 = Date.now() + 6 * 60_000;
      const _job13 = { active: false, status: "paused_token_revoked", queue: [{ to: "rh@vaga-l13.com", title: "Cook", company: "L13 LLC" }], nextSendAt: _next13, originalCount: 1, source: "jan2026" };
      await req2("POST", "/api/test/login", {
        token: TEST_TOKEN, email: "greconn@test.com", name: "Reconecta", refreshToken: "rt-reconn-l13",
        vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "vipro" }, plan: "vipro",
      });
      const _rc = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "greconn@test.com", job: _job13, limparTimer: true, reconectar: true });
      check("🔌 v195-L13: robô em paused_token_revoked VOLTA sozinho quando o Gmail é reconectado (mesma função que o callback do /oauth/connect-send chama) — e o nextSendAt é PRESERVADO, nunca dispara um envio fora do intervalo de ~7min",
        _rc.json?.retomado === "retomado" && _rc.json?.job?.active === true && _rc.json?.job?.nextSendAt === _next13 && _rc.json?.temTimer === true,
        JSON.stringify({ retomado: _rc.json?.retomado, active: _rc.json?.job?.active, next: _rc.json?.job?.nextSendAt === _next13, timer: _rc.json?.temTimer }));
      // limpa o timer pra não sobrar nada pendurado no resto da suíte
      await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "greconn@test.com", job: { active: false, status: "finished", queue: [] }, limparTimer: true });

      // (3) O gate do v172h continua intocado: automático VENCIDO não volta
      // por reconexão nenhuma (reconectar o Gmail não é pagar de novo).
      await req2("POST", "/api/test/login", {
        token: TEST_TOKEN, email: "greconnvenc@test.com", name: "Auto Vencido", refreshToken: "rt-reconn-venc",
        vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() - 86400_000, active: true, plan: "vipro" }, plan: "vipro",
      });
      const _rcv = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "greconnvenc@test.com", job: { ..._job13 }, limparTimer: true, reconectar: true });
      check("🔌 v195-L13: quem está com o AUTOMÁTICO vencido não tem o robô religado pela reconexão do Gmail (gate v172h intocado) — a resposta diz 'sem_plano' e o job continua parado",
        _rcv.json?.retomado === "sem_plano" && _rcv.json?.job?.active === false && _rcv.json?.temTimer === false,
        JSON.stringify({ retomado: _rcv.json?.retomado, active: _rcv.json?.job?.active, timer: _rcv.json?.temTimer }));

      // (4) ESTRUTURAL: as instruções de pausa por autenticação apontam pro
      // caminho que EXISTE (o cartão Conectar meu Gmail / /oauth/connect-send).
      // O login do site é usuário+senha desde o v172c — "faça login com o
      // Google de novo" mandava o cliente pagante pra lugar nenhum.
      const _appL13 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _wdL13 = fs.readFileSync(path.join(__dirname, "mod-watchdogs.js"), "utf8");
      const _frasesMortas = ["login com o Google", "log in with Google again", "Sign out and log in with Google", "Entra con Google de nuevo", "Cierra sesión y entra con Google",
        "🔐 Acesso Google revogado — faça login novamente", "🔐 Sem token salvo — faça login novamente",
        "Faça login novamente no H2BApply para reativar o envio automático.", "Faça login de novo no H2BApply para reativar o envio automático.",
        "Watchdog: faça login novamente para retomar o envio automático"];
      const _arqsL13 = { "app.js": _appL13, "index.html": fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "server.js": _srvSrc, "mod-watchdogs.js": _wdL13 };
      const _achadosL13 = Object.entries(_arqsL13).flatMap(([f, src]) => _frasesMortas.filter((fr) => src.includes(fr)).map((fr) => `${f}: "${fr}"`));
      check("🔌 v195-L13 (estrutural): nenhum arquivo servido ao cliente, nem o log do motor/vigias, manda 'fazer login com o Google de novo' — esse caminho não existe desde o v172c",
        _achadosL13.length === 0, _achadosL13.join(" · "));
      // e os 3 dicionários apontam pro MESMO cartão — 1 idioma consertado e 2
      // mentindo é o mesmo bug com outra cara.
      const _hintsOk = (_appL13.match(/"hint_auth_err":"Abra o Envio Automático e toque em “Conectar meu Gmail”/g) || []).length === 1 &&
        (_appL13.match(/"hint_token_revoked":"Abra o Envio Automático e toque em “Conectar meu Gmail”/g) || []).length === 1 &&
        (_appL13.match(/"hint_no_refresh":"Abra o Envio Automático e toque em “Conectar meu Gmail”/g) || []).length === 1 &&
        (_appL13.match(/Open Auto Send and tap “Connect my Gmail”/g) || []).length === 3 &&
        (_appL13.match(/Abre Envío Automático y toca “Conectar mi Gmail”/g) || []).length === 3;
      check("🔌 v195-L13 (estrutural): as 3 dicas de pausa por autenticação (auth_err/token_revoked/no_refresh) mandam pro cartão Conectar meu Gmail nos 3 idiomas",
        _hintsOk, "algum idioma ficou com a instrução antiga");
      // e o selo 🌱 do principal (que o servidor calculava e ninguém lia) tem
      // tela, reusando o MESMO HTML do badge dos extras.
      check("🌱 v195-L13 (estrutural): o selo de aquecimento é um HTML só (_warmupBadgeHTML) e o Gmail PRINCIPAL finalmente o exibe (#profile-primary-gmail) — o tutorial já prometia 'o selo 🌱 no Perfil mostra o estágio'",
        (_appL13.match(/function _warmupBadgeHTML\(/g) || []).length === 1 &&
        (_appL13.match(/_warmupBadgeHTML\(/g) || []).length === 3 &&
        _appL13.includes('document.getElementById("profile-primary-gmail")') &&
        fs.readFileSync(path.join(__dirname, "index.html"), "utf8").includes('id="profile-primary-gmail"'),
        "selo do principal ou o helper único não encontrado");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    }

    // ═══ 🚨 v177-FIX5 (auditoria 14/09/2026 — 5ª leva): envio manual e
    // automático. Corrida de 2 inícios do robô, PDF cru anexado sem
    // validação, extras que sobrevivem ao downgrade de plano, refill que
    // recarregava fila de quem perdeu o automático. ═══
    {
      // (1) CORRIDA REAL: 2 cliques/abas iniciando o robô ao mesmo tempo.
      // A checagem de "job já ativo" é síncrona, mas o setAutoJob só acontece
      // depois de vários awaits — as DUAS passavam e a 2ª sobrescrevia a fila
      // da 1ª (e scheduleAuto era agendado 2×).
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "racestart@test.com", name: "Race Start", refreshToken: "rt-race-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "doublepro" }, plan: "doublepro" });
      const _pdfRace = Buffer.from("%PDF-1.4 " + "race ".repeat(300)).toString("base64");
      const _upRace = await req2("POST", "/api/cv/upload", { base64: _pdfRace, name: "CV_Race.pdf", cvType: "resume" });
      const _mkQ = (tag) => [1, 2].map((i) => ({ to: `vaga${i}@${tag}-race.com`, title: "Cook", company: `Empresa ${tag}${i}` }));
      // A 1ª requisição sobe o corpo DEVAGAR (2 pedaços com 400ms de intervalo
      // — 4G real, e o que o handler enxerga é exatamente isso: ele começa a
      // rodar quando chegam os CABEÇALHOS, muito antes do corpo terminar). É
      // nessa janela que a 2ª chamada entrava e passava junto.
      const _r1p = reqSlow("POST", "/api/auto/start", { queue: _mkQ("um"), resumeIdx: _upRace.json?.cv?.idx, subjects: ["a"], emailBodies: ["b"] }, 400);
      await new Promise((r) => setTimeout(r, 150));
      const _r2 = await req2("POST", "/api/auto/start", { queue: _mkQ("dois"), resumeIdx: _upRace.json?.cv?.idx, subjects: ["a"], emailBodies: ["b"] });
      const _r1 = await _r1p;
      const _oks = [_r1, _r2].filter((r) => r.json?.ok === true).length;
      const _barrado = [_r1, _r2].find((r) => r.status === 409);
      check("🚨 v177-FIX5: 2 inícios CONCORRENTES do robô (duplo clique / 2 abas) — só UM monta a fila, o outro leva 409; antes as duas passavam e a 2ª jogava fora a fila da 1ª (sem lock nenhum, ao contrário do envio manual)",
        _oks === 1 && !!_barrado && (_barrado.json?.alreadyStarting === true || _barrado.json?.alreadyRunning === true),
        JSON.stringify({ r1: _r1.status, r2: _r2.status, oks: _oks }).slice(0, 160));
      await req2("POST", "/api/auto/stop", {});

      // (2) Currículo mandado direto no corpo (pdfBase64) ia CRU pro anexo do
      // e-mail, sem nenhuma das validações que /api/cv/upload aplica.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pdfcru@test.com", name: "PDF Cru", refreshToken: "rt-pdfcru-test", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: 0, active: true, plan: "vip" }, plan: "vip" });
      const _envCru = await req2("POST", "/api/send", { to: "rh@empresa-pdfcru.com", subject: "Application", message: "Olá, gostaria de me candidatar.", pdfBase64: Buffer.from("isto nao e um pdf de verdade, e lixo").toString("base64"), pdfName: "falso.pdf" });
      check("🚨 v177-FIX5: /api/send recusa (400) currículo mandado direto no corpo (pdfBase64) que NÃO é PDF de verdade — antes o base64 cru virava anexo no e-mail pro empregador sem nenhuma validação (magic bytes/tamanho só existiam no /api/cv/upload)",
        _envCru.status === 400 && _envCru.json?.pdfInvalid === true,
        JSON.stringify({ status: _envCru.status, err: (_envCru.json?.error || "").slice(0, 80) }));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

      check("🚨 v177-FIX5 (estrutural): o PLANO manda em quantos Gmails enviam — o rodízio corta os extras excedentes por getMaxSenders e o envio manual por conta específica recusa extra sem plano que dê direito (downgrade DoublePro→VIP deixava os 2 e-mails ativos: mandar por 2 pagando por 1)",
        _srvSrc.includes("const _maxSnd = getMaxSenders(p || {});") &&
        _srvSrc.includes("extras.filter(s => !s.tokenExpired && !s.blocked).slice(0, Math.max(0, _maxSnd - 1))") &&
        _srvSrc.includes("if (getMaxSenders(p || {}) <= 1) throw new Error(_msgLimiteSenders(getMaxSenders(p || {})));"),
        "getSenderToken voltou a ignorar o teto de e-mails do plano");
      check("🚨 v177-FIX5 (estrutural): o refill automático (que marca o job como active:true) só roda pra quem AINDA tem automático ativo — antes recarregava a fila ANTES da checagem de plano, reservando vagas pra quem acabou de perder o plano",
        _srvSrc.includes("const _added=(isAdminVip(_pRefill)||isAutoVipActive(_pRefill))?tryAutoRefill(email,job):0;"),
        "tryAutoRefill voltou a rodar antes da checagem de plano");
      check("🚨 v177-FIX5 (estrutural): o selo de aquecimento (primaryWarmup.sentToday) conta o histórico pela chave RESOLVIDA do Gmail (resolveSendGmail) — pra conta v172c o filtro por username nunca casava e o selo mostrava sempre 0, escondendo o throttling real",
        _srvSrc.includes("x.senderEmail===(gmailEmail||s.user_email)||x.senderEmail===s.user_email"),
        "primaryWarmup voltou a contar só por s.user_email");
      check("🚨 v177-FIX5 (estrutural): o freio de rajada do manual (20/60s) isenta admin, igual o cooldown de 1min já fazia (v120) — QA do admin não leva mais 429 dentro do próprio limite diário",
        _srvSrc.includes('if(!isAdminVip(p)&&rateLimit(s.user_email+"_send_burst",20,60_000))'),
        "burst do /api/send ainda não isenta admin");
      check("🚨 v177-FIX5→v240b (estrutural): /api/cv/upload confere o retorno da persistência antes de responder ok — antes dizia 'salvo' mesmo com disco E fallback em memória falhando (o usuário só descobria na hora de se candidatar). v240b extraiu a checagem pra FONTE ÚNICA (_finalizeCvUpload), usada pelos 2 caminhos de persistência (JSON legado com saveCv + streaming novo com saveCvFromFile) em vez de duplicada em cada um",
        (_srvSrc.match(/if\(!persistFn\(/g) || []).length === 2 &&
        (_srvSrc.match(/_finalizeCvUpload\(s\.user_email/g) || []).length === 2,
        "a checagem de persistência (persistFn) ou a fonte única (_finalizeCvUpload) não cobre mais os 2 caminhos de upload");
      // devolve a sessão pro usuário comum — o próximo check conta com isso
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    }

    // (v199 LOTE 19: aqui vivia um check com título de feature de OUTRO
    // projeto — "Respostas Certas", `/api/admin/reply-triage/status`. Essa rota
    // nunca existiu neste repo: o check só passava porque o portão genérico
    // `/api/admin` devolve 403 pra qualquer caminho, então ele media o portão,
    // não a feature. Um verde que não guarda nada é pior que nenhum check — dá
    // a sensação de cobertura que não existe. O portão genérico continua
    // provado pelos checks de admin de verdade, logo acima.)

    // ══════════════════════════════════════════════════════════════════════
    // 📥 v180 — IMPORTAR PLANILHA (JSON) E SEED ENRIQUECIDO
    // Diagnóstico: o jul2026_compact.json do git é um ESQUELETO (2.625 case
    // numbers, 0 e-mail) e o dado completo daquela planilha só existe no disco
    // de produção do site antigo. O dono baixa o JSON de lá e (a) importa aqui
    // pelo painel ou (b) manda pra virar o seed bundled. Os dois caminhos usam
    // a MESMA mesclagem: sobe a linha mais rica e NINGUÉM SOME.
    // ══════════════════════════════════════════════════════════════════════
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    {
      const _rows = async (k) => (await get("/api/admin/sheet/download/" + k)).json || [];
      const _row = (arr, c) => arr.find((r) => r.c === c) || {};
      // 1) planilha "esqueleto" do jeito que o DOL entrega: 3 vagas, só 1 com
      //    e-mail. Antes do v180 a rota jogava fora TODA linha sem e-mail — e é
      //    justamente ela que o robô de enriquecimento existe pra completar.
      const impNova = await req2("POST", "/api/admin/sheet/upload", {
        name: "Mescla Teste", key: "merge-teste", data: [
          { c: "H-400-MRG-0001", n: "Alpha LLC", s: "FLORIDA", st: "Pending Processing", g: "A" },
          { c: "H-400-MRG-0002", n: "Beta LLC", s: "TEXAS", st: "Pending Processing", g: "B", e: "rh@beta-mrg.com", t: "Cook", ci: "Austin" },
          { c: "H-400-MRG-0003", n: "Gama LLC", s: "MAINE", st: "Pending Processing", g: "C" },
        ],
      });
      const r0 = await _rows("merge-teste");
      check("📥 v180: planilha nova aceita as linhas AINDA sem e-mail (é o que o robô de enriquecimento completa depois) — exige só que o arquivo tenha e-mail em alguma linha",
        impNova.json?.ok === true && impNova.json.substituiu === false && impNova.json.count === 3 && impNova.json.comEmail === 1 && r0.length === 3,
        JSON.stringify({ resp: impNova.json, linhas: r0.length }).slice(0, 200));
      // 2) reimportação da MESMA chave: 1 linha enriquecida (ganha e-mail/
      //    título/cidade e NÃO traz o grupo), 1 linha pobre por cima de uma que
      //    já tem e-mail, 1 case novo. A 3ª linha nem vem no arquivo.
      const impSub = await req2("POST", "/api/admin/sheet/upload", {
        name: "Mescla Teste", key: "merge-teste", data: [
          { c: "H-400-MRG-0001", n: "Alpha LLC", s: "FLORIDA", e: "chefe@alpha-mrg.com", t: "Landscape Laborer", ci: "Miami", w: "16.50" },
          { c: "H-400-MRG-0002", n: "Beta LLC", s: "TEXAS", st: "Certified" },
          { c: "H-400-MRG-0004", n: "Delta LLC", s: "MAINE", e: "rh@delta-mrg.com", t: "Housekeeper" },
        ],
      });
      const r1 = await _rows("merge-teste");
      const a1 = _row(r1, "H-400-MRG-0001"), a2 = _row(r1, "H-400-MRG-0002"), a3 = _row(r1, "H-400-MRG-0003"), a4 = _row(r1, "H-400-MRG-0004");
      const admSheets = await get("/api/admin/sheets");
      const _metaMrg = (admSheets.json?.sheets || []).find((x) => x.key === "merge-teste") || {};
      check("📥 v180 (a): importar em chave que JÁ EXISTE é SUBSTITUIÇÃO MESCLADA — a linha esqueleto ganha e-mail/título/cidade SEM perder o grupo A-H, o case novo entra e a vaga que não veio no arquivo continua no ar",
        impSub.json?.ok === true && impSub.json.substituiu === true && impSub.json.count === 4 &&
        impSub.json.adicionadas === 1 && impSub.json.atualizadas === 1 && impSub.json.comEmailAntes === 1 && impSub.json.comEmail === 3 &&
        r1.length === 4 && a1.e === "chefe@alpha-mrg.com" && a1.t === "Landscape Laborer" && a1.ci === "Miami" && a1.g === "A" &&
        a4.e === "rh@delta-mrg.com" && a3.c === "H-400-MRG-0003" && a3.n === "Gama LLC" && _metaMrg.withEmail === 3,
        JSON.stringify({ resp: impSub.json, a1, a3, a4 }).slice(0, 320));
      check("📥 v180 (b): linha SEM e-mail importada por cima de uma que JÁ TINHA e-mail não apaga nada — e-mail, título e cidade continuam lá, e o campo em conflito (status) fica com a linha rica: quem tem contato vence, o resto só PREENCHE vazio, nunca zera",
        a2.e === "rh@beta-mrg.com" && a2.t === "Cook" && a2.ci === "Austin" && a2.g === "B" && a2.st === "Pending Processing",
        JSON.stringify(a2));
      // a trilha da importação vive no sheets_meta.json do disco — confere lá
      const _metaDisco = JSON.parse(fs.readFileSync(path.join(DATA, "sheets_meta.json"), "utf8"))["merge-teste"] || {};
      check("📥 v180: sheets_meta.json registra importedRows=3, mergedFrom=3 e quem importou — auditoria de quem trocou a planilha de vagas do site",
        _metaDisco.importedRows === 3 && _metaDisco.mergedFrom === 3 && _metaDisco.importedBy === "smoke@test.com" && _metaDisco.importedAt > 0 && _metaDisco.published === true,
        JSON.stringify(_metaDisco).slice(0, 220));
      // 3) arquivo sem NENHUM e-mail é recusado na cara (nunca publica em silêncio)
      const impRuim = await req2("POST", "/api/admin/sheet/upload", { name: "Sem Email", key: "merge-teste", data: [{ c: "H-400-MRG-0009", n: "Zeta LLC" }] });
      const r2 = await _rows("merge-teste");
      check("📥 v180: arquivo sem NENHUMA linha com e-mail é recusado (400) e a planilha no ar fica intocada — nunca troca uma planilha boa por um arquivo errado",
        impRuim.status === 400 && /e-mail/i.test(impRuim.json?.error || "") && r2.length === 4,
        JSON.stringify({ status: impRuim.status, erro: impRuim.json?.error, linhas: r2.length }));
      // 4) (c) MIGRAÇÃO DO SEED: esqueleto em /data + bundled com e-mail → mescla.
      const _seed = async (atual, bundled) => (await req2("POST", "/api/test/seed-merge", { token: TEST_TOKEN, key: "jul2026", atual, bundled })).json?.resultado || {};
      const _esqueleto = [{ c: "H-400-SEED-0001", n: "Alpha LLC", s: "FLORIDA", g: "A", e: "" }, { c: "H-400-SEED-0002", n: "Beta LLC", s: "TEXAS", g: "B", e: "" }];
      const sd1 = await _seed(_esqueleto, [
        { c: "H-400-SEED-0001", n: "Alpha LLC", s: "FLORIDA", e: "chefe@seed.com", t: "Cook", ci: "Miami" },
        { c: "H-400-SEED-0003", n: "Gama LLC", s: "MAINE", e: "rh@seed3.com", t: "Welder" },
      ]);
      const _sdRow = (c) => (sd1.rows || []).find((r) => r.c === c) || {};
      check("📥 v180 (c): esqueleto em /data (0 e-mail) + seed bundled COM e-mail → o bundled vence e é MESCLADO (linha ganha e-mail/título mantendo o grupo, case novo entra, case que só existe em /data fica)",
        sd1.aplicar === true && (sd1.rows || []).length === 3 && sd1.adicionadas === 1 && sd1.atualizadas === 1 &&
        sd1.emailAntes === 0 && sd1.emailDepois === 2 &&
        _sdRow("H-400-SEED-0001").e === "chefe@seed.com" && _sdRow("H-400-SEED-0001").g === "A" && _sdRow("H-400-SEED-0002").n === "Beta LLC",
        JSON.stringify({ aplicar: sd1.aplicar, add: sd1.adicionadas, upd: sd1.atualizadas, rows: (sd1.rows || []).length }));
      const sd2 = await _seed(sd1.rows || [], [{ c: "H-400-SEED-0001", n: "Alpha LLC", e: "outro@seed.com" }]);
      check("📥 v180 (c): IDEMPOTENTE — no boot seguinte /data já tem e-mail e a migração nem abre o arquivo bundled (nunca sobrescreve enriquecimento real com seed velho)",
        sd2.aplicar === false && /já tem e-mail/.test(sd2.motivo || ""), JSON.stringify(sd2).slice(0, 160));
      const sd3 = await _seed(_esqueleto, [{ c: "H-400-SEED-0001", n: "Alpha LLC", s: "FLORIDA" }]);
      check("📥 v180 (c): bundled que TAMBÉM é esqueleto não mexe em nada (é o estado de hoje no git — a migração só dispara quando o arquivo novo traz contato de verdade)",
        sd3.aplicar === false && /0 e-mail/.test(sd3.motivo || ""), JSON.stringify(sd3).slice(0, 160));
      // 4b) built-in (jan2026/jul2025/H-2A) NÃO mora em SHEET_EXTRAS: importar
      //     numa chave dessas tem que atualizar o array certo e salvar pelo
      //     funil único — nunca criar uma planilha fantasma com a mesma chave.
      const _slAntes = (await get("/api/sheets-list")).json?.sheets || [];
      const _julAntes = _slAntes.find((x) => x.key === "jul2025") || {};
      const impBi = await req2("POST", "/api/admin/sheet/upload", {
        name: "Julho 2025 (H-2B)", key: "jul2025",
        data: [{ c: "H-400-BUILTIN-0001", n: "Builtin Import LLC", s: "GEORGIA", e: "rh@builtin-import.com", t: "Welder" }],
      });
      const _slDepois = (await get("/api/sheets-list")).json?.sheets || [];
      const _julDepois = _slDepois.filter((x) => x.key === "jul2025");
      const _jobBi = (await get("/api/sheet-meta?sheet=jul2025&email=0&q=Builtin%20Import&top=5")).json;
      check("📥 v180: importar numa planilha BUILT-IN (jul2025) atualiza a planilha de verdade e salva pelo funil único — sem criar planilha fantasma com a mesma chave em SHEET_EXTRAS",
        impBi.json?.ok === true && impBi.json.builtin === true && impBi.json.substituiu === true && impBi.json.adicionadas === 1 &&
        _julDepois.length === 1 && _julDepois[0].count === (_julAntes.count || 0) + 1 &&
        (_jobBi.jobs || []).some((j) => j.company === "Builtin Import LLC"),
        JSON.stringify({ resp: impBi.json, antes: _julAntes.count, depois: _julDepois.map((x) => x.count), achou: (_jobBi.jobs || []).length }).slice(0, 220));
      // 5) estrutural: função ÚNICA de mesclagem (upload + seed) e o botão no painel
      const _srv180 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _adm180 = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      check("📥 v180 (estrutural): a mesclagem é UMA função só — `_mesclarPlanilha` é chamada pelo upload do admin E pelo seed do boot (nunca duas réguas pro mesmo dado)",
        (_srv180.match(/_mesclarPlanilha\(/g) || []).length >= 3 && _srv180.includes("function _mesclarPlanilha(") && _srv180.includes("function _seedVenceEsqueleto("),
        "a régua de mesclagem voltou a ser duplicada");
      check("📥 v180 (estrutural): reimportar uma planilha PARA o robô de enriquecimento que estiver rodando nela (senão ele segue escrevendo no array velho e o progresso vai pro lixo)",
        _srv180.includes('_enrichLog(`⏹️ Bot parado automaticamente — planilha "${keyReal}" foi reimportada pelo admin.`,"warn")'),
        "upload voltou a trocar as linhas debaixo do bot rodando");
      check("📥 v180 (e): o painel tem o botão de importar de verdade (input de arquivo + POST /api/admin/sheet/upload) — a rota existia desde sempre sem UI nenhuma",
        _adm180.includes('id="ip-file"') && _adm180.includes('type="file"') && _adm180.includes('accept=".json,application/json"') &&
        _adm180.includes('"/api/admin/sheet/upload"') && _adm180.includes("function plImportarAbrir(") && _adm180.includes("FileReader"),
        "botão de importar planilha sumiu do admin.html");
      // limpeza: a planilha de teste não fica no ar pro resto da suíte
      await req2("DELETE", "/api/admin/sheet/merge-teste");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 🧩 v182 — LOTE 8: TERMINAR DE ALIMENTAR A PLANILHA
    // O robô dava jan2026/jul2025 (11.446 vagas) por "100% completas" só porque
    // toda linha tem E-MAIL — e era por isso que 0% delas tinha cidade, datas
    // ou descrição. Aqui o critério vira "tem o que a TELA usa", o frescor
    // passa a cobrir toda planilha publicada, a unidade do salário é lida de
    // verdade, `exp` volta a ser MESES e a cidade é limpa na gravação.
    // Com DOL_API_BASE apontando pro feed falso, o ciclo do robô roda DE
    // VERDADE no npm test (antes o hostname do DOL o tornava inexercitável).
    // ══════════════════════════════════════════════════════════════════════
    {
      const _rowsL8 = async (k) => (await get("/api/admin/sheet/download/" + k)).json || [];
      const _rL8 = (arr, c) => arr.find((r) => r.c === c) || {};
      // (30) o progresso REAL de cada planilha, pela MESMA função que a fila do robô usa
      const stL8 = (await get("/api/admin/planilhas/status")).json;
      const filaL8 = stL8.enrichFila || [];
      const fJan = filaL8.find((x) => x.k === "jan2026");
      check("🧩 v182-L8 (30): planilha com 100% de e-mail NÃO é mais 'completa' — jan2026 (9.240 vagas) aparece com as 9.240 pendentes por falta de cidade/datas/descrição; era esse `if` que tirava 11.446 vagas H-2B da fila do robô pra sempre",
        !!fJan && fJan.total === 9240 && fJan.semEmail === 0 && fJan.completas === 0 && fJan.pendentes === 9240 &&
        fJan.faltando.e === 0 && fJan.faltando.ci === 9240 && fJan.faltando.desc === 9240,
        JSON.stringify(fJan));
      check("🧩 v182-L8 (30/35): a fila ataca por IMPACTO — a jul2026 (2.625 linhas, ZERO e-mail) vem na frente de todas, porque vaga sem contato é candidatura impossível; depois vem quem tem mais linhas pendentes",
        filaL8.length >= 4 && filaL8[0].k === "jul2026" && filaL8[0].semEmail === 2625 &&
        filaL8.findIndex((x) => x.k === "jan2026") > filaL8.findIndex((x) => x.k === "jul2026"),
        filaL8.map((x) => `${x.k}:semEmail=${x.semEmail}/pend=${x.pendentes}`).join(" · "));
      // (30/33/34) um ciclo REAL do robô sobre o feed falso
      const _hits0 = DOL_HITS.length;
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Alimentar Oito", key: "enrich-l8", data: [
          { c: "H-400-L8-0000", n: "Completa LLC", s: "TEXAS", e: "rh@completa-l8.com", t: "Cook", ci: "Austin", d: "2027-01-01", de: "2027-06-30", desc: "Cozinhar." },
          { c: "H-400-L8-0001", n: "Oito Um LLC", s: "LOUISIANA", e: "rh@oitoum.com", t: "Landscape Laborer", exp: 6, w: "800.00", wunit: "h" },
          { c: "H-400-L8-0002", n: "Oito Dois LLC", s: "MAINE", e: "rh@oitodois.com", t: "Housekeeper" },
          { c: "H-400-L8-0003", n: "Oito Tres LLC", s: "NEW YORK", e: "rh@oitotres.com", t: "Crop Harvester" },
        ],
      });
      await req2("POST", "/api/admin/enrich/start", { sheetKey: "enrich-l8", resume: true });
      let enL8 = null;
      for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 200)); enL8 = (await get("/api/admin/enrich/status")).json; if (enL8 && enL8.running === false && enL8.done >= 4) break; }
      const arrL8 = await _rowsL8("enrich-l8");
      const r1 = _rL8(arrL8, "H-400-L8-0001"), r2 = _rL8(arrL8, "H-400-L8-0002"), r3 = _rL8(arrL8, "H-400-L8-0003");
      const hitsL8 = DOL_HITS.slice(_hits0);
      check("🧩 v182-L8 (30): um ciclo do robô preenche cidade, datas E descrição de linhas que JÁ TINHAM e-mail — exatamente o caso de jan2026/jul2025, que o ciclo antigo declarava '100% completo' e pulava",
        !!r1.ci && !!r1.d && !!r1.de && !!r1.desc && !!r2.ci && !!r2.d && !!r2.desc && !!r3.d && !!r3.desc,
        JSON.stringify({ r1: { ci: r1.ci, d: r1.d, de: r1.de, desc: !!r1.desc }, r2: { ci: r2.ci, d: r2.d }, r3: { d: r3.d } }));
      check("🧩 v182-L8 (30): linha JÁ completa não gasta chamada ao DOL, e a retomada começa na primeira linha PENDENTE (não mais na primeira sem e-mail) — as 3 pendentes foram consultadas, a completa nunca",
        hitsL8.includes("H-400-L8-0001") && hitsL8.includes("H-400-L8-0002") && hitsL8.includes("H-400-L8-0003") &&
        !hitsL8.includes("H-400-L8-0000"),
        hitsL8.join(","));
      check("🧩 v182-L8 (34): sujeira da fonte não vira mais opção de filtro — 'Franklin Baldwin, LA 70514' grava 'Franklin Baldwin', 'BAR HARBOR' vira 'Bar Harbor' e '13033' (que não é cidade nenhuma) não grava nada",
        r1.ci === "Franklin Baldwin" && r2.ci === "Bar Harbor" && (r3.ci || "") === "",
        JSON.stringify([r1.ci, r2.ci, r3.ci]));
      check("🧩 v182-L8 (32): a unidade do salário é a que o DOL publicou — Week→w, Bi-Weekly→bw, Piece Rate→pr (antes TUDO que não fosse 'Month' era gravado como HORA e $800/semana virava $4,62/h na régua do filtro)",
        r1.wunit === "w" && r2.wunit === "bw" && r3.wunit === "pr",
        JSON.stringify([r1.wunit, r2.wunit, r3.wunit]));
      check("🧩 v182-L8 (33): `exp` volta a ser MESES — o número que já existia (6) sobrevive ao robô, os meses publicados pelo DOL são gravados (3) e o Sim/Não vai pra `expReq` sem nunca inventar um `exp`",
        r1.exp === 6 && r1.expReq === "sim" && r2.exp === 3 && r2.expReq === "sim" && r3.exp === undefined && r3.expReq === "sim",
        JSON.stringify([r1.exp, r1.expReq, r2.exp, r2.expReq, r3.exp, r3.expReq]));
      const vfL8 = (await get("/api/vagas/filtros?sheet=enrich-l8&email=0")).json;
      const ciL8 = (vfL8.facetas.cidade || []).map((c) => c.label).sort();
      const smL8 = (await get(`/api/sheet-meta?sheet=enrich-l8&cidade=${encodeURIComponent("franklin baldwin|LOUISIANA")}&top=10`)).json;
      check("🧩 v182-L8 (34): o que o robô acabou de gravar já vale nos filtros e a faceta de cidade só tem LUGAR (nenhum CEP, nenhum número de rua) — e o chip continua entregando exatamente o que promete",
        ciL8.length === 3 && ciL8.join("|") === "Austin|Bar Harbor|Franklin Baldwin" && smL8.total === 1,
        JSON.stringify(ciL8) + " lista=" + smL8.total);
      // (32) a régua única de $/hora entende as unidades novas
      const { wageHora: _wh8 } = require(path.join(__dirname, "mod-filtros.js"));
      check("🧩 v182-L8 (32): wageHora fecha a conta das unidades novas — $800/semana e $1.600/quinzena e $41.600/ano são todos $20/h, e pagamento por PEÇA é salário DESCONHECIDO (0), nunca um $/h inventado",
        _wh8({ w: "800", wunit: "w" }) === 20 && _wh8({ w: "1600", wunit: "bw" }) === 20 && _wh8({ w: "41600", wunit: "y" }) === 20 &&
        _wh8({ w: "3", wunit: "pr" }) === 0 && _wh8({ w: "50", wunit: "bw" }) === 50,
        JSON.stringify([_wh8({ w: "800", wunit: "w" }), _wh8({ w: "1600", wunit: "bw" }), _wh8({ w: "3", wunit: "pr" })]));
      check("🧩 v182-L8 (32): a vaga paga por peça sai do filtro de salário em vez de entrar com valor falso",
        vfL8.facetas.salario.semSalario >= 1 && (vfL8.facetas.salario.limiares.find((l) => l.v === 12) || {}).n === 2,
        JSON.stringify(vfL8.facetas.salario).slice(0, 160));
      // (31→v208) o frescor foi RETIRADO por decisão de produto (19/09/2026) —
      // vaga já completa nunca mais é reconsultada. planilhasPublicadas() (o que
      // sobrou daquele item, sem a parte de reconferência) continua listando
      // TODA planilha publicada, rascunho fora — é a mesma lista que o vigia de
      // saúde usa (v199 LOTE 18) e agora é provada aqui.
      // createPlanilhas() é uma fábrica por injeção de dependências (padrão do
      // repo) — não dá pra chamar planilhasPublicadas() direto por require();
      // provamos pelo efeito visível: a MESMA lista que o vigia de saúde usa
      // é exatamente o que GET /api/sheets-list mostra pro usuário.
      const _sheetsL = await get("/api/sheets-list");
      const _chavesL = (_sheetsL.json?.sheets || []).map((x) => x.key);
      check("🧩 v208: planilhasPublicadas() (fonte única do vigia de saúde) bate com o que o usuário vê em /api/sheets-list — jan2026/jul2025/h2a-jun2026 publicadas, sem rascunho",
        ["jan2026", "jul2025", "h2a-jun2026"].every((k) => _chavesL.includes(k)) && !_chavesL.includes("teste-janela"),
        JSON.stringify(_chavesL));
      // (35) forçar o seed da jul2026 MESCLA — nunca troca a planilha inteira
      const j26antes = await _rowsL8("jul2026");
      const _casoJ26 = j26antes[0] && j26antes[0].c;
      await req2("POST", "/api/test/enriquecer-linha", {
        token: TEST_TOKEN, sheet: "jul2026", case: _casoJ26,
        dol: { worksite_city: "Naples", worksite_state: "FL", apply_email: "rh@j26-enriquecida.com", begin_date: "2026-10-01", end_date: "2027-04-30", job_duties: "Trabalho de temporada.", case_status: "Certified" },
      });
      const seedForce = await req2("POST", "/api/admin/sheet/seed-jul2026", { force: true });
      const j26depois = await _rowsL8("jul2026");
      const _linhaJ26 = _rL8(j26depois, _casoJ26);
      check("🧩 v182-L8 (35): forçar o seed da jul2026 MESCLA (mesma `_mesclarPlanilha` do upload) — antes trocava a planilha inteira pelo arquivo bundled, e um clique apagaria meses de e-mail/cidade/descrição que o robô já tinha conquistado em /data",
        seedForce.json?.ok === true && seedForce.json.mesclado === true && j26depois.length === j26antes.length &&
        _linhaJ26.e === "rh@j26-enriquecida.com" && _linhaJ26.ci === "Naples" && !!_linhaJ26.desc,
        JSON.stringify({ resp: seedForce.json, linha: { e: _linhaJ26.e, ci: _linhaJ26.ci } }).slice(0, 220));
      // estrutural: produção intocada (mesma URL do DOL, mesmo ritmo) e critério numa lista só
      const _modL8 = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
      check("🧩 v182-L8 (estrutural): em produção NADA mudou no trato com o DOL — a base padrão continua sendo api.seasonaljobs.dol.gov/datahub/ e o ritmo educado do enriquecimento (800ms) só encolhe com base local de teste",
        _modL8.includes('process.env.DOL_API_BASE || "https://api.seasonaljobs.dol.gov/datahub/"') &&
        _modL8.includes("_dolLocal ? 20 : 800") &&
        !/httpsReq\(\{ hostname: "api\.seasonaljobs/.test(_modL8),
        "o ritmo/hostname de produção foi alterado");
      check("🧩 v182-L8 (estrutural): o critério de 'completa' é UMA lista só (CAMPOS_ESSENCIAIS) — fila, ponto de retomada, laço do robô e painel leem dela, nunca cada um do seu jeito",
        _modL8.includes("const CAMPOS_ESSENCIAIS = [") && _modL8.includes("sheet.filter(linhaCompleta)") &&
        _modL8.includes("!linhaCompleta(r)") && _modL8.includes("if (linhaCompleta(row))") && _modL8.includes("progressoPlanilha(getSheet(k)") &&
        !_modL8.includes("if (temEmail(row) && row.ci)") && !_modL8.includes("if (withoutEmail === 0)"),
        "o critério de conclusão voltou a ser 'tem e-mail'");
      const _admL8 = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      check("🧩 v182-L8: o painel Planilhas & Robôs mostra o progresso REAL (N/N completas · N pendentes: N sem cidade, N sem descrição…) em vez de '100%'",
        _admL8.includes("function _plFilaHtml(") && _admL8.includes("sem descrição") && _admL8.includes("_plFilaHtml(d.enrichFila)"),
        "o painel voltou a esconder o que falta em cada planilha");
      await req2("DELETE", "/api/admin/sheet/enrich-l8");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 🕊️ v195 — LOTE 14: EDUCADO COM O DOL
    // O IP do servidor no DOL é recurso COMPARTILHADO: se ele levar 403/429,
    // os 5 robôs de planilha morrem pra todo mundo.
    // 🚫 v223: as rotas de busca ao vivo (/api/jobs, /api/sheet-detail,
    // /api/sheet-batch) saíram do site (ordem do dono — "só planilhas a
    // partir de agora") — os testes delas saíram junto. O que fica aqui é
    // só o que protege o robô de ENRIQUECIMENTO periódico (mod-planilhas.js).
    // ══════════════════════════════════════════════════════════════════════
    {
      // (1) o proxy aberto morreu — qualquer método/corpo ia pro DOL com o
      // nosso IP, sem sessão, sem limite e com CORS *, e ninguém chamava.
      const _px = await get("/proxy/jobs");
      const _px2 = await getSemCookie("/proxy/");
      check("🕊️ v195-L14: o proxy aberto pro DOL (/proxy) NÃO existe mais — era um repasse sem sessão, sem rate-limit e com CORS *, usando o IP que os 5 robôs de planilha compartilham, e nenhuma tela do site chamava",
        _px.status === 404 && _px2.status === 404,
        `status=${_px.status}/${_px2.status}`);

      // (5) parar de reconsultar o vazio: linha que o DOL já respondeu sem ter
      // o que dar sai da fila por 60h — antes o vigia de 30min reperguntava a
      // planilha inteira pro governo, pra sempre, sem NENHUMA linha mudar.
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Educado Quatorze", key: "eq-l14", data: [
          // o DOL não conhece: responde 200 vazio → carimba e sai da fila
          { c: "H-400-L14-0001", n: "Um LLC", s: "TEXAS", e: "rh@um-l14.com", t: "Cook" },
          // carimbo VENCIDO (100h) → volta pra fila normalmente
          { c: "H-400-L14-0002", n: "Dois LLC", s: "TEXAS", e: "rh@dois-l14.com", t: "Cook", eq: Date.now() - 100 * 3600_000 },
          // carimbo FRESCO → nem na 1ª volta o DOL é perguntado
          { c: "H-400-L14-0003", n: "Tres LLC", s: "TEXAS", e: "rh@tres-l14.com", t: "Cook", eq: Date.now() },
        ],
      });
      const _esperaEnrich = async () => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 150)); const st = (await get("/api/admin/enrich/status")).json; if (st && st.running === false) return st; } return null; };
      await _esperaEnrich();
      const _hA = DOL_HITS.length;
      await req2("POST", "/api/admin/enrich/start", { sheetKey: "eq-l14", resume: true });
      await _esperaEnrich();
      const _volta1 = DOL_HITS.slice(_hA).filter((c) => c.startsWith("H-400-L14-000"));
      const _hB = DOL_HITS.length;
      await req2("POST", "/api/admin/enrich/start", { sheetKey: "eq-l14", resume: true });
      await _esperaEnrich();
      const _volta2 = DOL_HITS.slice(_hB).filter((c) => c.startsWith("H-400-L14-000"));
      check("🕊️ v195-L14: a linha perguntada ao DOL há pouco sai da fila (carimbo `eq`) — a 1ª volta consulta a nova e a de carimbo VENCIDO, nunca a de carimbo fresco; a 2ª volta, logo em seguida, não pergunta NADA",
        _volta1.includes("H-400-L14-0001") && _volta1.includes("H-400-L14-0002") && !_volta1.includes("H-400-L14-0003") &&
        _volta2.length === 0,
        `1ª=${JSON.stringify(_volta1)} 2ª=${JSON.stringify(_volta2)}`);
      const _eqRows = (await get("/api/admin/sheet/download/eq-l14")).json || [];
      const _eq1 = _eqRows.find((r) => r.c === "H-400-L14-0001") || {};
      const { progressoPlanilha: _progL14 } = require(path.join(__dirname, "mod-planilhas.js"));
      const _pgL14 = _progL14(_eqRows);
      check("🕊️ v195-L14: o painel continua contando a linha como PENDENTE (ela é), só sabendo que está AGUARDANDO a janela do DOL — o robô é que fica com 0 a fazer agora; esconder a pendência seria mentir sobre o que falta na planilha",
        Number(_eq1.eq) > Date.now() - 10 * 60_000 &&
        _pgL14.pendentes === 3 && _pgL14.aguardandoDol === 3 && _pgL14.pendentesAgora === 0,
        JSON.stringify({ eq: _eq1.eq, prog: _pgL14 }).slice(0, 200));
      await req2("DELETE", "/api/admin/sheet/eq-l14");

      // (6) estrutural: o /proxy sumiu de vez e o enriquecimento perdeu o
      // I(12h) redundante do vigia de 30min — o "SEM EMAIL" virou resumo.
      const _srvL14 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _modL14 = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
      const _swL14 = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
      check("🕊️ v195-L14 (estrutural): o /proxy sumiu do servidor E do service worker, e o enriquecimento perdeu o I(12h) redundante (o vigia de 30min já cobre) — o 'SEM EMAIL' agora é resumo por ciclo, não uma linha de log por vaga",
        !_srvL14.includes('pathname.startsWith("/proxy")') && !_swL14.includes('url.pathname.startsWith("/proxy")') &&
        !_modL14.includes('I(12 * 3600_000, autoEnrichCycle, "auto-enrich")') &&
        _modL14.includes("vaga(s) continuam SEM E-MAIL no DOL nesta rodada") &&
        !_modL14.includes("SEM EMAIL | ${(row.t"),
        "algum resquício do /proxy, do I(12h) ou do log por vaga continua vivo");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 🎨 v182 — LOTE 9: DELEITE, MOBILE E ACESSIBILIDADE
    // Quatro dimensões sumiam CALADAS quando a planilha não tem o dado, a
    // busca não tinha × pra limpar, o botão de filtros era o MENOR alvo da
    // fileira, o painel não fechava no Escape nem movia o foco, o Passo 2 do
    // robô não tinha ponte com a busca manual e o 📡 Radar salvava 4 das 11
    // dimensões que a pessoa montou.
    // ══════════════════════════════════════════════════════════════════════
    {
      const _appL9 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _idxL9 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      // (36) dimensão sem dado AVISA, não some — nas 3 línguas (regra 6f)
      const _chavesL9 = ["vf_no_cidade", "vf_no_inicio", "vf_no_cargo", "vf_no_vagas", "vf_no_exp", "vf_no_temporada", "vf_ponte", "vf_ws2_dyn", "radar_evaluated"];
      check("🎨 v182-L9 (36): as 6 dimensões que sumiam caladas (cidade, mês de início, cargo, vagas, experiência, temporada) passaram a mostrar o MESMO aviso âmbar do salário/e-mail — e cada texto novo existe nas 3 línguas do dicionário",
        _chavesL9.every((k) => (_appL9.match(new RegExp('"' + k + '":', "g")) || []).length === 3) &&
        ['_semDado("cidade"', '_semDado("inicio"', '_semDado("cargo"', '_semDado("vagas"', '_semDado("exp"', '_semDado("temporada"'].every((x) => _appL9.includes(x)) &&
        !_appL9.includes('const has=disp.cidade>0||sel.length;show("cidade",!live&&has);'),
        "alguma dimensão voltou a sumir sem explicar, ou faltou tradução");
      // (37) a busca vira chip removível E tem × no campo
      check("🎨 v182-L9 (37): a busca tem × pra limpar dentro do campo (o campo irmão da aba Enviadas já tinha) e vira chip removível sobre a lista, fora do painel",
        _idxL9.includes('id="q-clear"') && _idxL9.includes("limparBusca()") && _appL9.includes("function limparBusca(") &&
        _appL9.includes('if(st.q)push("q","","🔎 "+st.q') && _idxL9.includes('id="vf-chips-manual"'),
        "× da busca / chip da busca não encontrados");
      // (38) alvos ≥44px, aria-modal, foco, ESC e aria-pressed
      check("🎨 v182-L9 (38): alvos de toque ≥44px (o botão 🔍 Filtros tinha min-height:36px INLINE, que vencia a regra mobile de 44px; as opções tinham 40 e o × do chip 24) e o painel ganhou aria-modal",
        !/id="btn-vf-manual"[^>]*min-height:36px/.test(_idxL9) &&
        /\.vf-opt\{[^}]*min-height:44px/.test(_idxL9) && /\.vf-more\{min-height:44px/.test(_idxL9) &&
        /\.vf-chip button\{[^}]*min-width:44px/.test(_idxL9) && _idxL9.includes('role="dialog" aria-modal="true"'),
        "algum alvo de toque voltou a ficar abaixo de 44px");
      check("🎨 v182-L9 (38): o painel move o foco pro primeiro controle ao abrir, devolve pro botão ao fechar, fecha no Escape (reaproveitando vfClose) e cada opção declara aria-pressed",
        _appL9.includes("VF.foco=document.activeElement") && _appL9.includes('aria-pressed="${on?"true":"false"}"') &&
        /e\.key!=="Escape"[\s\S]{0,160}vfClose\(\)/.test(_appL9),
        "foco/Escape/aria-pressed não encontrados");
      // 🦯 v278 (achado de auditoria — Alta): o .jcard (card de vaga — o
      // elemento mais usado do site inteiro, listando TODAS as vagas)
      // tinha só onclick, sem role/tabindex — inacessível por teclado, e
      // mesmo focado por acaso não ativaria nada, porque o listener global
      // de Enter/Espaço (v257, linha ~1343) só dispara pra role="button".
      // Mesmo padrão já usado no log-entry (linha ~4236/5042).
      check("🦯 v278: o card de vaga (.jcard) agora é focável por teclado (role=\"button\" tabindex=\"0\") — reusa o MESMO listener global de Enter/Espaço já existente, sem duplicar lógica",
        _appL9.includes('onclick="selSheetJob(\'${esc(j.id)}\')" role="button" tabindex="0"'),
        "jcard sem role=\"button\" tabindex=\"0\"");
      // ♿ v279 (achado de auditoria — Alta): o modal de candidatura (#modal,
      // o fluxo de conversão mais importante do site) não tinha contrato de
      // diálogo (role/aria-modal/aria-labelledby) nem gestão de foco — quem
      // chegava até ele pelo teclado (agora possível desde o v278) abria um
      // "diálogo" mudo pra leitor de tela, com o foco preso atrás do overlay,
      // e ao fechar perdia a posição na lista. Mesmo padrão do vfOpen/vfClose
      // (LOTE 9, linha ~1247/1262).
      check("♿ v279: #modal ganhou role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"m-title\" (mesmo padrão do #vf-modal)",
        /<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">/.test(_idxL9),
        "#modal sem contrato de diálogo (role/aria-modal/aria-labelledby)");
      check("♿ v279: openModal() guarda o foco de origem e move o foco pro modal ao abrir; closeModal() devolve o foco — mesmo padrão do vfOpen/vfClose",
        _appL9.includes('_modalFoco=document.activeElement;') &&
        _appL9.includes('setTimeout(()=>{const alvo=g("#modal .mx");if(alvo&&typeof alvo.focus==="function")alvo.focus();},60);') &&
        /const voltar=_modalFoco;_modalFoco=null;if\(voltar&&typeof voltar\.focus==="function"&&document\.contains\(voltar\)\)try\{voltar\.focus\(\);\}catch\(e\)\{\}/.test(_appL9),
        "openModal/closeModal sem gestão de foco");
      check("♿ v279: Escape fecha #modal também (só fechava por clique fora ou no X) — mesmo listener global já usado pro #vf-overlay e #auth-gate",
        /const md=g\("#modal"\);\s*\n\s*if\(md&&!md\.classList\.contains\("gone"\)\)\{e\.preventDefault\(\);closeModal\(\);return;\}/.test(_appL9),
        "Escape não fecha #modal");
      // 🖼️ v280 (achado de auditoria — Média/Alta): as 19 fotos reais da
      // landing (hero + galeria "Veja o site por dentro") não tinham
      // width/height — sem espaço reservado, o navegador empurrava o
      // conteúdo seguinte quando cada imagem terminava de carregar (CLS).
      // A imagem do hero (.ln-preview-main) é candidata a LCP, carregada
      // com loading="eager" pra 100% dos visitantes não logados.
      const _landingImgs = [...(_idxL9.matchAll(/src="\/tut-img\/(landing-[\w-]+\.jpg)"([^>]*)>/g))];
      check("🖼️ v280: as 22 tags <img> das fotos reais da landing (hero+thumbs+galeria) TODAS declaram width/height — nunca mais layout pulando quando a foto termina de carregar",
        _landingImgs.length === 22 && _landingImgs.every(([, , attrs]) => /width="\d+"/.test(attrs) && /height="\d+"/.test(attrs)),
        `${_landingImgs.filter(([, , attrs]) => !(/width="\d+"/.test(attrs) && /height="\d+"/.test(attrs))).length} sem dimensão de ${_landingImgs.length}`);
      check("🖼️ v280: width/height batem com o tamanho REAL do arquivo em tutorial-img/ (nunca um valor chutado que distorce a proporção)",
        _landingImgs.every(([, fname, attrs]) => {
          const wh = attrs.match(/width="(\d+)" height="(\d+)"/);
          if (!wh) return false;
          try {
            const buf = fs.readFileSync(path.join(__dirname, "tutorial-img", fname));
            // JPEG SOF0/SOF2 marker (0xFFC0/0xFFC2): 2 bytes h, 2 bytes w, logo após o marcador+len+precisão
            for (let i = 2; i < buf.length - 9; i++) {
              if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
                const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
                return String(h) === wh[2] && String(w) === wh[1];
              }
            }
            return false;
          } catch (e) { return false; }
        }),
        "algum width/height não bate com o arquivo real (JPEG SOF)");
      // ♿ v281 (achado de auditoria — Alta): 7 overlays que JÁ fechavam no
      // clique-fora (X ou fundo escuro) nunca tinham Escape — só o
      // #vf-overlay/#modal/#auth-gate (v182-L9/v279/v237) tinham. Extensão
      // do MESMO listener global, nunca um 2º. #wpp-required-overlay,
      // #terms-overlay, #cv-prompt-overlay e #success-overlay ficam de fora
      // DE PROPÓSITO — são gates obrigatórios/confirmações sem clique-fora,
      // Escape neles abriria uma saída que o produto nunca ofereceu.
      check("♿ v281: Escape agora fecha os 7 overlays que já fechavam no clique-fora mas nunca tinham a tecla (Editor de Perfil, Confirmação do Automático, Modal do Robô, Detalhe do Log, Tour, Menu ☰, Excluir Conta)",
        [
          'const pe=g("#profile-editor-overlay");\n    if(pe&&!pe.classList.contains("gone")){e.preventDefault();closeProfileEditor();return;}',
          'const pf=g("#pf-overlay");\n    if(pf&&!pf.classList.contains("gone")){e.preventDefault();closePreflight();return;}',
          'if(_isAutoModalOpen()){e.preventDefault();closeAutoModal();return;}',
          'const ld=g("#log-detail-overlay");\n    if(ld&&ld.style.display==="flex"){e.preventDefault();closeLogDetail();return;}',
          'const tro=g("#tour-overlay");\n    if(tro&&!tro.classList.contains("gone")){e.preventDefault();closeTour();return;}',
          'const mm=g("#more-menu-overlay");\n    if(mm&&!mm.classList.contains("gone")){e.preventDefault();mm.classList.add("gone");return;}',
          'const da=g("#del-acc-m");\n    if(da&&!da.classList.contains("gone")){e.preventDefault();closeDeleteAccountModal();return;}',
        ].every((s) => _appL9.includes(s)),
        "algum overlay perdeu o fechamento por Escape");
      // 🦯 v283 (achado de auditoria — Alta): admin.html inteiro tinha 33
      // <label> e ZERO for= — leitor de tela anunciava "campo de edição"
      // sem dizer QUAL campo (Valor, Plano, Categoria…), em TODO o fluxo
      // de trabalho do admin (aprovar pedido, ativar VIP, importar
      // planilha, lançar gasto/pagamento). Clicar no texto do label também
      // não focava o campo, sem o for=.
      const _admL9 = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      const _admLabels = [..._admL9.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
      const _admSemAssoc = _admLabels.filter(([, attrs, inner]) => !/\bfor="/.test(attrs) && !/<(input|select|textarea)\b/.test(inner));
      check("🦯 v283: admin.html — todo <label> agora tem for= (associação explícita) ou envolve o próprio campo (checkbox/radio) — só os 2 labels de GRUPO de radio ('Pago por'/'Recebido por', sem 1 campo único pra apontar) ficam de fora, registrados",
        _admLabels.length >= 33 && _admSemAssoc.length === 2 &&
        _admSemAssoc.every(([full]) => /Pago por|Recebido por/.test(full)) &&
        _admL9.includes('<select id="pend-status" aria-label="Filtrar por status"'),
        `total=${_admLabels.length} sem-associação=${JSON.stringify(_admSemAssoc.map(([f]) => f))}`);
      // 🦯 v284 (achado de auditoria contínua — Alta): as 5 estrelas de
      // #review-stars (avaliação do H2BApply) eram <span> com só onclick —
      // sem tabindex/role/aria-label. submitReview() BLOQUEIA o envio sem
      // _reviewStarVal, que só é setado por clique — usuário de teclado
      // nunca conseguia avaliar (feature 100% inoperável, não só difícil).
      check("🦯 v284: #review-stars — as 5 estrelas viram role=button tabindex=0 aria-label (reusa a delegação global de Enter/Espaço já existente, zero JS novo) e reviewSetStar() mantém aria-pressed sincronizado",
        [1, 2, 3, 4, 5].every((n) => _idxL9.includes(`data-v="${n}" role="button" tabindex="0" aria-pressed="false" aria-label="${n} estrela${n > 1 ? "s" : ""}" onclick="reviewSetStar(${n})"`)) &&
        _appL9.includes('el.setAttribute("aria-pressed",marcada?"true":"false");'),
        "estrelas de avaliação sem role=button/aria-pressed");
      // 🚨 v285 (achado de auditoria contínua — CRÍTICA, caminho de
      // monetização): #comp-drop-area (upload do comprovante de pagamento,
      // PASSO 4 obrigatório da compra de plano) era um <div onclick> puro —
      // o <input type=file> real é display:none (fora da tab order) e o
      // div não tinha role/tabindex. submitPlanOrder() (app.js) BLOQUEIA o
      // pedido sem _planComp64 — usuário de teclado NUNCA conseguia sequer
      // abrir o seletor de arquivo, travando toda compra de plano paga.
      check("🚨 v285: #comp-drop-area (comprovante do pagamento) ganha role=button tabindex=0 aria-label — reusa a MESMA delegação global de Enter/Espaço, sem JS novo",
        _idxL9.includes('id="comp-drop-area" role="button" tabindex="0" aria-label="Selecionar comprovante do pagamento" onclick="document.getElementById(\'comp-file-input\').click()"'),
        "upload de comprovante sem role=button/tabindex");
      // ♿ v286 (achado de auditoria contínua — Alta, ARMADILHA de teclado):
      // .mob-back (botão "Voltar às vagas" do painel full-screen de
      // detalhe de vaga no mobile) só fechava por clique — sem role,
      // tabindex nem Escape. Como .jcard já é focável (#164), um usuário
      // de teclado CONSEGUE abrir esse painel mas ficava PRESO dentro
      // dele, sem nenhum jeito de voltar pela lista.
      check("♿ v286: .mob-back ganha role=button tabindex=0 aria-label (reusa a delegação Enter/Espaço) e #mob-detail entra na lista de fechamento por Escape",
        _idxL9.includes('class="mob-back" role="button" tabindex="0" aria-label="Voltar às vagas" onclick="closeMobDetail()"') &&
        _appL9.includes('const mdt=g("#mob-detail");\n    if(mdt&&mdt.classList.contains("show")){e.preventDefault();closeMobDetail();return;}'),
        "painel de detalhe mobile continua sem saída por teclado");
      // ♿ v287 (achado de auditoria contínua — Média): #m-cd-pill (v120,
      // configuração de proteção de 1min entre envios manuais — desligar
      // arrisca bloqueio do Gmail) é o ÚNICO ponto da UI que expõe essa
      // configuração (grep confirmou: nenhuma tela de Perfil/Config tem
      // equivalente). <div onclick> sem role/tabindex — usuário de teclado
      // não alcançava essa configuração de segurança da própria conta.
      check("♿ v287: #m-cd-pill ganha role=button tabindex=0 aria-label (reusa a delegação Enter/Espaço global)",
        _idxL9.includes('id="m-cd-pill" role="button" tabindex="0" aria-label="Configurações de proteção de envio manual"'),
        "pill de proteção de envio manual sem role=button/tabindex");
      // ♿ v288 (achado de auditoria contínua — Alta, WCAG AA): .stab-cnt
      // (contador de vagas por fonte, sidebar) no tema escuro renderizava
      // com contraste 1.92:1 (badge inativo) / ~2.3:1 (ativo) — o bloco
      // "v14 LIGHT OVERRIDES" (!important, linha ~916) hardcoda color pro
      // valor do tema CLARO e o rescue dark (linha ~136) só reclamava
      // background, nunca color. Números praticamente invisíveis no
      // tema escuro. Contraste calculado independentemente: #4c4f82 sobre
      // #222644 = 1.92:1 (abaixo do AA 4.5:1); var(--t2) dark (#a5a8cc)
      // sobre var(--sf3) dark (#222644) = 6.35:1 (fix, AA folgado).
      check("♿ v288: [data-theme=dark] .stab-cnt e .stab.active .stab-cnt reclamam color também (não só background) — contador de vagas legível no tema escuro",
        _idxL9.includes('[data-theme="dark"] .stab-cnt{background:var(--sf3)!important;color:var(--t2)!important}') &&
        _idxL9.includes('[data-theme="dark"] .stab.active .stab-cnt{background:var(--bluel)!important;color:#93c5fd!important;border-color:var(--blueb)!important}'),
        "badges de contagem por fonte continuam ilegíveis no tema escuro");
      // 🚨 v289 (achado de auditoria contínua — CRÍTICA, mesmo padrão do
      // v288 aplicado ao fluxo de candidatura): [data-theme="dark"]
      // .cv-slot (linhas de currículo/carta/perfil dentro do modal
      // "Enviar Candidatura") só reclamava background, nunca color. O
      // bloco "v14 LIGHT OVERRIDES" força color:#1e1b4b (!important) e o
      // nome do currículo/perfil (app.js mkSlots, sem color próprio)
      // herdava esse valor. Contraste calculado: #1e1b4b sobre var(--sf2)
      // dark (#1c1f35) = ~1.01:1 — texto PRATICAMENTE INVISÍVEL bem no
      // centro da ação de candidatar-se.
      check("🚨 v289: [data-theme=dark] .cv-slot reclama color e border-color também — nome do currículo/perfil visível no tema escuro",
        _idxL9.includes('[data-theme="dark"] .cv-slot{background:var(--sf2)!important;color:var(--text)!important;border-color:var(--border2)!important}'),
        "linhas de currículo/perfil continuam ilegíveis no tema escuro");
      // (39) ponte manual → robô + subtítulo honesto
      check("🎨 v182-L9 (39): o Passo 2 do robô ganhou a ponte 'usar os mesmos filtros da minha busca' (forçando só com e-mail) e o subtítulo passou a citar só as dimensões que a fonte escolhida TEM de verdade",
        _idxL9.includes('id="btn-vf-ponte"') && _appL9.includes("function vfUsarFiltrosDaBusca(") &&
        _appL9.includes('VF.st.auto=Object.assign(_vfClone(st),{email:true})') && _appL9.includes("function _vfWs2Sub(") && _appL9.includes("_vfWs2Sub(d);vfPonteSync();"),
        "ponte manual→robô não encontrada");
      check("🎨 v182-L9 (39/40): o snapshot dos filtros é função ÚNICA — o robô usa com e-mail forçado, o Radar usa o mesmo sem forçar nada",
        _appL9.includes("function vfSnapshot(ctx,extra)") && _appL9.includes('function vfSnapshotAuto(extra){return vfSnapshot("auto",Object.assign({email:true}') &&
        _appL9.includes('const payload={filtros:vfSnapshot("manual")}'),
        "vfSnapshot deixou de ser a fonte única do snapshot");
      // (40) o radar guarda TUDO e é avaliado pelo MESMO motor
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radar9@test.com", name: "Radar Nove" });
      const rd9 = await req2("POST", "/api/radar", { filtros: { estado: ["MASSACHUSETTS"], categoria: ["housekeeper"], q: "housekeeper", salarioMin: 20, vagasMin: 2, exp: [0] } });
      const rd9g = (await get("/api/radar")).json;
      check("🎨 v182-L9 (40): o radar guarda o snapshot COMPLETO — salário, vagas abertas e experiência (que antes eram jogados fora) chegam inteiros ao servidor",
        rd9.json?.ok === true && rd9.json.dimensoes === 6 && rd9g.radar.filtros.salarioMin === 20 && rd9g.radar.filtros.vagasMin === 2 &&
        rd9g.radar.filtros.exp[0] === 0 && rd9g.radar.filtros.estado[0] === "MASSACHUSETTS" && rd9g.radar.filtros.categoria[0] === "housekeeper" && rd9g.radar.filtros.q === "housekeeper",
        JSON.stringify(rd9g.radar && rd9g.radar.filtros).slice(0, 220));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Radar Nove Pobre", key: "radar9-pobre",
        data: [{ c: "H-400-R9-0001", e: "rh@radar9pobre.com", n: "Radar Nove Pobre LLC", t: "Housekeeper", s: "MASSACHUSETTS", k: "housekeeper", w: "12.00", wunit: "h", wk: 5, exp: 0 }],
      });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radar9@test.com" });
      const rd9pobre = (await get("/api/radar")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Radar Nove Rico", key: "radar9-rico",
        data: [{ c: "H-400-R9-0002", e: "rh@radar9rico.com", n: "Radar Nove Rico LLC", t: "Housekeeper", s: "MASSACHUSETTS", k: "housekeeper", w: "25.00", wunit: "h", wk: 5, exp: 0 }],
      });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radar9@test.com" });
      const rd9rico = (await get("/api/radar")).json;
      // ⚠️ v189 LOTE 7: mede `novas` (vagas novas que combinam de verdade) no
      // lugar do antigo `totalAvisos` — o comportamento provado é o mesmo (a
      // vaga pobre não entra, a rica entra), só o nome deixou de mentir.
      check("🎨 v182-L9 (40) + v189-L7: quem pediu '$20+/h' não vê no radar a vaga de $12/h que só casa no estado e na palavra — o radar é avaliado pelo MESMO FILTROS.filtrar da lista e da fila do robô, nunca por uma 3ª régua",
        (rd9pobre.radar.novas || 0) === 0 && rd9rico.radar.novas === 1 && rd9rico.radar.ultimaEm > 0,
        `pobre=${rd9pobre.radar.novas} rico=${rd9rico.radar.novas}`);
      const _srvL9 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🎨 v182-L9 (40, estrutural): a régua própria do radar (includes/split de texto) morreu — sobrou _radarFiltrosDe + FILTROS.filtrar, e o modal diz exatamente o que está sendo avaliado",
        _srvL9.includes("function _radarFiltrosDe(") && _srvL9.includes("const matches=FILTROS.filtrar(novas,f,{isDP:_isDoublePro(u2)});") &&
        !_srvL9.includes("if(r.cidade&&!hay.includes(_nrm(r.cidade)))return false;") &&
        _appL9.includes("radar_evaluated") && _appL9.includes('id="radar-agora"'),
        "o radar voltou a ter régua própria");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("DELETE", "/api/admin/sheet/radar9-pobre");
      await req2("DELETE", "/api/admin/sheet/radar9-rico");
      // 🛡️ v276 (mesmo bug real do dono, agora no Radar): o filtro salvo do
      // Radar NEM SEMPRE tem `email` explícito (a tela nunca expôs esse
      // campo pro usuário escolher) — _radarSanitiza defaultava `false`
      // (mostra tudo, inclusive vaga IMPOSSÍVEL de aplicar por falta de
      // e-mail do empregador). Agora só `false` EXPLÍCITO desliga; ausente
      // cai no padrão protetor, igual a lista e a fila do robô.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radar276@test.com", name: "Radar 276" });
      const rd276 = await req2("POST", "/api/radar", { filtros: { estado: ["MASSACHUSETTS"], categoria: ["housekeeper"] } });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Radar 276 Sem Email", key: "radar276-sememail",
        data: [{ c: "H-400-R276-0001", e: "", n: "Radar 276 Sem Email LLC", t: "Housekeeper", s: "MASSACHUSETTS", k: "housekeeper", w: "25.00", wunit: "h", wk: 5 }],
      });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radar276@test.com" });
      const rd276semEmail = (await get("/api/radar")).json;
      check("🛡️ v276: radar SEM `email` explícito no filtro salvo (nem true nem false) já esconde vaga sem e-mail do empregador — bate em tudo mais (estado/categoria) mas não conta como 'vaga nova' porque é impossível se candidatar",
        rd276.json?.ok === true && (rd276semEmail.radar.novas || 0) === 0,
        JSON.stringify({ save: rd276.json, novas: rd276semEmail.radar?.novas }));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/sheet/upload", {
        name: "Radar 276 Com Email", key: "radar276-comemail",
        data: [{ c: "H-400-R276-0002", e: "rh@radar276.com", n: "Radar 276 Com Email LLC", t: "Housekeeper", s: "MASSACHUSETTS", k: "housekeeper", w: "25.00", wunit: "h", wk: 5 }],
      });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radar276@test.com" });
      const rd276comEmail = (await get("/api/radar")).json;
      check("🛡️ v276: a MESMA vaga COM e-mail conta normalmente — a proteção é só do campo e-mail, o resto do filtro (estado/categoria) segue funcionando igual",
        rd276comEmail.radar.novas === 1, `novas=${rd276comEmail.radar.novas}`);
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("DELETE", "/api/admin/sheet/radar276-sememail");
      await req2("DELETE", "/api/admin/sheet/radar276-comemail");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 🔒 v182 — LOTE 10: O E-MAIL DO EMPREGADOR É O ATIVO QUE O CLIENTE PAGA
    // Provado com curl SEM cookie: /api/sheet-meta?sheet=jan2026&top=2000
    // devolvia os e-mails de 2.000 empregadores em texto puro — 5 requisições
    // e qualquer um levava os 9.240 da planilha inteira. A regra "ZERO envio
    // grátis" protegia o ENVIO; a lista de contatos estava aberta.
    // 🔓 v277 (dono, 23/09/2026): "free NUNCA pode enviar, mas o e-mail tem
    // que estar disponível pra pessoa copiar se ela quiser" — o LOTE 10
    // tinha ido longe demais gateando o endereço a isVipActive, misturando
    // "não pode enviar pelo app" (regra de sempre) com "não pode ver o
    // contato". Agora só quem NÃO TEM CONTA NENHUMA (scraper sem cookie)
    // continua vendo mascarado — qualquer sessão logada, free inclusive, vê
    // o endereço completo.
    // ══════════════════════════════════════════════════════════════════════
    {
      const URL10 = "/api/sheet-meta?sheet=jan2026&top=3&email=1&hideSent=0";
      const anon = (await getSemCookie(URL10)).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "gratis10@test.com", name: "Gratis Dez" });
      const gratis = (await get(URL10)).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pagante10@test.com", name: "Pagante Dez", refreshToken: "rt-pagante10", plan: "vipro", vip: { manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, active: true, plan: "vipro" } });
      const pagante = (await get(URL10)).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const admin = (await get(URL10)).json;
      const mascararEmailLocal = (e) => { const x = String(e || "").toLowerCase(); const i = x.indexOf("@"); return i < 1 ? "" : x[0] + "••••" + x.slice(i); };
      const _mascarado = (e) => typeof e === "string" && e.includes("••••") && e.includes("@") && !/^[a-z0-9._%+-]{2,}@/i.test(e);
      check("🔒 v182-L10: SEM cookie nenhum (scraper) o endereço sai MASCARADO — e `hasEmail` continua true, porque é dele que a tela, a contagem e o 'só com e-mail' dependem, nunca do texto do endereço",
        anon && anon.jobs.length === 3 && anon.jobs.every((j) => _mascarado(j.email) && j.hasEmail === true && j.emailBloqueado === true),
        JSON.stringify(anon && anon.jobs.map((j) => j.email)));
      check("🔓 v277: sessão GRÁTIS (logada, mas sem plano) recebe o endereço COMPLETO — free não pode ENVIAR pelo app (gate separado, continua valendo), mas pode VER e copiar o contato do empregador",
        gratis.jobs.every((j) => j.email && !j.email.includes("•") && j.email.includes("@") && !j.emailBloqueado && j.hasEmail === true),
        JSON.stringify({ lista: gratis.jobs[0].email, bloqueado: gratis.jobs[0].emailBloqueado }));
      check("🔒 v182-L10: sessão com PLANO ATIVO recebe o endereço COMPLETO na lista (é com ele que o modal de envio manual é preenchido)",
        pagante.jobs.every((j) => j.email && !j.email.includes("•") && j.email.includes("@") && !j.emailBloqueado),
        JSON.stringify({ lista: pagante.jobs[0].email }));
      check("🔒 v182-L10 + v277: admin recebe completo e o CONJUNTO devolvido é idêntico nos 4 casos — mascarar (só o anônimo, agora) não muda a contagem, nem a ordem, nem quem entra na lista",
        admin.jobs.every((j) => j.email && !j.email.includes("•")) &&
        anon.total === gratis.total && gratis.total === pagante.total && pagante.total === admin.total &&
        JSON.stringify(anon.jobs.map((j) => j.caseNum)) === JSON.stringify(pagante.jobs.map((j) => j.caseNum)) &&
        JSON.stringify(gratis.jobs.map((j) => j.email)) === JSON.stringify(pagante.jobs.map((j) => j.email)),
        `totais anon=${anon.total} gratis=${gratis.total} pagante=${pagante.total} admin=${admin.total}`);
      // 🔓 v277: a prateleira "Pra Você" usa o MESMO podeVerEmailVaga — prova
      // separada porque é o 2º (e único outro) consumidor da função.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "gratis10@test.com" });
      const pvGratis = await get("/api/jobs/pra-voce");
      const _pvGratisJobs = pvGratis.json?.jobs || [];
      check("🔓 v277: 'Pra Você' pra sessão GRÁTIS também devolve o e-mail COMPLETO (mesma régua da lista principal — podeVerEmailVaga não distingue mais free de VIP)",
        pvGratis.json?.ok === true && _pvGratisJobs.length >= 1 &&
        _pvGratisJobs.every((j) => j.email && !j.email.includes("•") && j.email.includes("@") && !j.emailBloqueado),
        JSON.stringify({ n: _pvGratisJobs.length, primeiro: _pvGratisJobs[0]?.email }));
      // o filtro "só com e-mail" não pode depender do mascaramento
      const fAnon = (await getSemCookie("/api/vagas/filtros?sheet=jan2026&email=1")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pagante10@test.com" });
      const fPag = (await get("/api/vagas/filtros?sheet=jan2026&email=1")).json;
      check("🔒 v182-L10: 'só com e-mail' devolve a MESMA contagem com e sem plano (9.240 em jan2026) — a faceta lê a EXISTÊNCIA do e-mail na linha real, nunca o texto que viajou pro cliente",
        fAnon.total === 9240 && fAnon.total === fPag.total && fAnon.facetas.email.com === fPag.facetas.email.com,
        `anon=${fAnon.total} pagante=${fPag.total}`);
      // o envio manual de quem PAGA continua de ponta a ponta
      const _alvo = pagante.jobs[0].email;
      const envio = await req2("POST", "/api/send", { to: _alvo, subject: "Application", message: "Olá, gostaria de me candidatar." });
      const envioMascarado = await req2("POST", "/api/send", { to: mascararEmailLocal(_alvo), subject: "Application", message: "Olá, gostaria de me candidatar." });
      // O endereço REAL passa do gate de plano (402) e da validação de
      // destinatário e só para no passo SEGUINTE (currículo em PDF) — o envio
      // de verdade pelo Gmail a suíte nunca chama. Já o endereço MASCARADO é
      // recusado como destinatário inválido: se algum dia um JSON velho da
      // tela chegar aqui, ele morre na porta, nunca vira e-mail enviado.
      check("🔒 v182-L10: o envio manual de quem PAGA não quebrou — o endereço real da lista passa pelo gate de plano e pela validação de destinatário (para só no passo seguinte, o PDF), enquanto o endereço MASCARADO é recusado na porta",
        envio.status !== 402 && /curr[ií]culo|PDF/i.test(envio.body || "") &&
        envioMascarado.status === 400 && /destinat|inv[áa]lido/i.test(envioMascarado.body || ""),
        `real=${envio.status}:${(envio.body || "").slice(0, 70)} · mascarado=${envioMascarado.status}:${(envioMascarado.body || "").slice(0, 70)}`);
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _srvL10 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _appL10 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("🔒 v182-L10 (estrutural): a máscara é função ÚNICA (mascararEmail + podeVerEmailVaga) e está em TODA rota que devolve vaga com e-mail — lista e 'pra você' (v223: detalhe/lote/vagas ao vivo saíram do site — só planilhas a partir de agora)",
        _srvL10.includes("function mascararEmail(") && _srvL10.includes("function podeVerEmailVaga(") && _srvL10.includes("function jobComEmailVisivel(") &&
        (_srvL10.match(/podeVerEmailVaga\(req\)/g) || []).length >= 2 &&
        !/email:emailVal\|\|null/.test(_srvL10),
        "alguma rota voltou a devolver o e-mail cru");
      check("🔓 v277 (estrutural): a régua mudou de 'plano ativo' pra 'sessão logada de verdade' — nem podeVerEmailVaga nem _verEmailMeta checam mais isAdminVip/isVipActive (só existência de sessão+usuário); o texto do gate antigo não pode voltar",
        !_srvL10.includes("isAdminVip(u) || isVipActive(u)") && !/_verEmailMeta=!!\(_uMeta&&\(isAdminVip/.test(_srvL10) &&
        _srvL10.includes("const _verEmailMeta=!!_uMeta;"),
        "o gate voltou a exigir plano pago pra ver o e-mail");
      check("🔒 v182-L10 (estrutural): a fila do robô é montada com a LINHA REAL do servidor (não com o JSON da tela) e endereço mascarado nunca entra nela",
        _srvL10.includes('let emailRaw = (rowPri?.e||"").trim() || (meta.email||"").trim()') && _srvL10.includes('if(emailRaw.includes("•")) emailRaw = "";') &&
        _appL10.includes("email_locked") && _appL10.includes("j.hasEmail&&j.emailBloqueado"),
        "a fila do robô voltou a confiar no e-mail vindo da tela");
    }
    // ═══ 🧾 v185 LOTE 3: A JORNADA DO PEDIDO — o usuário vê o que aconteceu ══
    {
      // (1) A ativação PROVISÓRIA (intencional, 21/07) existia no servidor e
      // era invisível na tela: o front nunca re-consultava o /api/status
      // depois de enviar o pedido, então quem comprava batia no cadeado
      // "Plano necessário" e só um F5 resolvia. Este é o MESMO payload que o
      // front agora reaplica (applyStatus).
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "provl3@test.com", name: "Provisorio Lote3" });
      const _stAntesL3 = (await get("/api/status")).json;
      const _pvL3 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "Provisorio Lote3", userWhatsapp: "53 98145 3496", userCity: "Pelotas", userState: "RS", nota: "TESTE_COMPROVANTE:300", comprovante: Buffer.from("comp-l3-provisorio").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await new Promise((r) => setTimeout(r, 600));
      const _stDepoisL3 = (await get("/api/status")).json;
      check("🧾 v185-L3: comprovante que CONFERE libera o plano na hora (provisório) e o /api/status já reflete isso — needsPlan vira false e autoLimit passa de 0; é exatamente esse payload que a tela deixava de reaplicar (a pessoa batia no cadeado 'Plano necessário' e só um F5 resolvia)",
        _pvL3.json?.ok === true && _stAntesL3?.needsPlan === true && (_stAntesL3?.autoLimit || 0) === 0 &&
        _stDepoisL3?.needsPlan === false && (_stDepoisL3?.autoLimit || 0) > 0,
        JSON.stringify({ antes: { needsPlan: _stAntesL3?.needsPlan, autoLimit: _stAntesL3?.autoLimit }, depois: { needsPlan: _stDepoisL3?.needsPlan, autoLimit: _stDepoisL3?.autoLimit } }));
      // (2) /api/status expõe o ESTADO cadastrado (o cadastro v175 já obriga)
      // — é o que deixa o passo 2 da compra confirmar em vez de pedir de novo
      check("🧾 v185-L3: /api/status devolve `estado` junto com `city` — sem ele o passo 2 da compra não tinha como confirmar os dados e pedia cidade/estado de novo, com a cidade nem pré-preenchida",
        typeof _stDepoisL3?.estado === "string" && "estado" in (_stDepoisL3 || {}),
        JSON.stringify({ city: _stDepoisL3?.city, estado: _stDepoisL3?.estado }));
      // (3) pedido CANCELADO devolve o motivo na whitelist do /api/pedidos
      // (guarda de regressão da privacidade: nada de preCheck cru)
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cancl3@test.com", name: "Cancelado Lote3" });
      const _pcL3 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Cancelado Lote3", userWhatsapp: "53 98145 3496", userCity: "Pelotas", userState: "RS" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("PATCH", "/api/pedido/" + _pcL3.json?.pedidoId, { status: "cancelado", notaAdmin: "comprovante mostra R$50, plano custa R$100" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cancl3@test.com", name: "Cancelado Lote3" });
      const _pedsL3 = (await get("/api/pedidos")).json?.pedidos || [];
      const _cancL3 = _pedsL3.find((x) => x.id === _pcL3.json?.pedidoId) || {};
      check("🧾 v185-L3: pedido cancelado devolve `motivoCancelamento` pro dono (a Home passou a contar o que aconteceu em vez de o card simplesmente sumir) e a whitelist continua fechada — nada de preCheck cru nem notaAdmin interna",
        _cancL3.status === "cancelado" && /R\$50/.test(_cancL3.motivoCancelamento || "") &&
        !("preCheck" in _cancL3) && !("notaAdmin" in _cancL3) && !("criadoPor" in _cancL3),
        JSON.stringify({ motivo: _cancL3.motivoCancelamento, chaves: Object.keys(_cancL3).join(",") }).slice(0, 220));
      const _appL3 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      const _idxL3 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const _srvL3 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🧾 v185-L3 (estrutural): applyStatus(d) é a fonte única do estado da conta e o syncData() também a usa — o 'Próximo passo' decide por U.needsPlan (gate oficial do servidor), NUNCA por U.plan==='free' (getPlan devolve 'vipro' pra quem só tem o automático — armadilha do v177-FIX8)",
        _appL3.includes("function applyStatus(d)") && /if\(stR&&stR\.ok\)\{try\{const sd=await stR\.json\(\);if\(sd\.connected\)\{applyStatus\(sd\);/.test(_appL3) &&
        _appL3.includes("if(!U.isAdmin && U.needsPlan){") && !_appL3.includes('U.plan==="free" && (U.manualRemaining||0)<=0'),
        "applyStatus/renderNextStep não estão no formato esperado");
      check("🧾 v185-L3 (estrutural): a Home não manda mais 'falar no WhatsApp do rodapé' (escondido depois do login) — o card leva pro número que já é público no app; e o aviso de pedido cancelado tem X pra dispensar, pra não virar cartaz permanente",
        !_appL3.includes("WhatsApp no rodapé") && _appL3.includes('const WA_SUPORTE="https://wa.me/5553981453496"') &&
        _appL3.includes("function dispensarPedidoCancelado(") && _appL3.includes("7*86400_000"),
        "o card da Home ainda aponta pro rodapé ou o cancelado não tem como ser dispensado");
      check("🧾 v185-L3 (estrutural): o 'Telefone alternativo' do checkout morreu (campo que NENHUMA tela lia, pedido no meio de uma compra) e o passo 2 virou confirmação dos dados do cadastro, com queda pro formulário quando falta cidade/estado",
        !_idxL3.includes("plan-form-phone") && !_appL3.includes("userPhone") && !_srvL3.includes("userPhone:d.userPhone") &&
        _idxL3.includes('id="plan-dados-resumo"') && _idxL3.includes('id="plan-dados-form"') &&
        _appL3.includes("function _planPrepararDados()") && _appL3.includes("function planCorrigirNoPerfil()"),
        "resquício do userPhone ou o passo 2 não virou confirmação");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }

    // ═══ 🤖 v184 LOTE 2: MOTOR DE ENVIO — robô zumbi e duplicata em crash ══
    {
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "zumbil2@test.com", name: "Zumbi Lote2" });
      // Estado NORMAL do motor: mandou a ÚLTIMA vaga da fila e está no
      // intervalo humanizado de ~7min esperando o refill. Antes do v183 esse
      // job morria em silêncio a cada deploy (e este repo faz deploy a cada
      // commit) — reactivateOneAutoJob devolvia false e o laço de órfãos do
      // watchdog tinha a MESMA condição de fila não-vazia.
      const _nextL2 = Date.now() + 5 * 60_000;
      const _semFila = { active: true, queue: [], status: "waiting_interval", nextSendAt: _nextL2, source: "jan2026", originalCount: 3, lastSentAt: Date.now() - 2 * 60_000 };
      const _rL2 = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "zumbil2@test.com", job: _semFila, limparTimer: true, reativar: true });
      check("🤖 v184-L2: job ativo com a fila VAZIA (mandou a última vaga e espera o refill de ~7min) volta a ser agendado depois de um restart — antes reactivateOneAutoJob devolvia false e o robô do cliente pagante simplesmente não voltava",
        _rL2.json?.reativado === true && _rL2.json?.temTimer === true,
        JSON.stringify({ reativado: _rL2.json?.reativado, temTimer: _rL2.json?.temTimer }));
      check("🤖 v184-L2: e o nextSendAt ORIGINAL é respeitado (o robô espera o tempo que FALTAVA) — reagendar disparando na hora furaria o intervalo humanizado de 7min contra o Gmail",
        _rL2.json?.job?.nextSendAt === _nextL2 && _rL2.json?.job?.status === "waiting_interval",
        JSON.stringify({ nextSendAt: _rL2.json?.job?.nextSendAt, esperado: _nextL2, status: _rL2.json?.job?.status }));
      // não deixa timer vivo mandando e-mail no meio da suíte
      await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "zumbil2@test.com", job: { ..._semFila, active: false, status: "inativo" }, limparTimer: true });
      // "vaga enviada nunca reaparece" grava no disco NA HORA (era debounce de 2s)
      const _sentPath = path.join(DATA, "sent_emails.json");
      const _lerSent = () => { try { return fs.readFileSync(_sentPath, "utf8"); } catch { return ""; } };
      const _antesSent = _lerSent();
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "persistel2@test.com", sentTo: ["empregador-persiste-l2@teste-h2b.com"] });
      const _depoisSent = _lerSent();
      check("🤖 v184-L2: marcar empregador como JÁ CONTATADO grava em disco NA HORA (antes era debounce de 2s — um kill duro na janela devolvia a vaga enviada pra fila e o robô mandava a MESMA candidatura pro MESMO empregador)",
        !_antesSent.includes("empregador-persiste-l2@teste-h2b.com") && _depoisSent.includes("empregador-persiste-l2@teste-h2b.com"),
        "sent_emails.json não tinha o empregador logo após o markSent — voltou a ser debounced");
      const _srvL2 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _deadFn = (_srvL2.match(/function _motivoVagaMorta\(row\)\{[\s\S]*?\n\}/) || [""])[0]
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      check("🤖 v184-L2 (estrutural): a régua de vaga morta não pode voltar a olhar `row.exp` (meses de EXPERIÊNCIA, nunca vencimento) — só status do DOL e data de fim no passado decidem",
        !!_deadFn && !/row\.exp/.test(_deadFn) && /WITHDRAWN/.test(_deadFn) && /_dataISO\(row\.de\)/.test(_deadFn),
        "o corpo de _motivoVagaMorta voltou a referenciar row.exp");
      check("🤖 v184-L2 (estrutural): markSent grava síncrono (SENT_FILE é só conjunto de e-mail) e setAutoJob CONTINUA debounced — o arquivo do robô carrega a fila inteira de todo mundo e é escrito várias vezes por envio",
        /DB_SENT\[u\]\.add\(nd\);\s*\n\s*persistSent\(\);/.test(_srvL2) && !_srvL2.includes("persistSentDebounced") &&
        _srvL2.includes("const setAutoJob = (e,d) => { DB_AUTO[e]={...(DB_AUTO[e]||{}),...d}; persistDebounced(AUTO_FILE,DB_AUTO,5000); };"),
        "markSent voltou a ser debounced (ou setAutoJob virou síncrono)");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }

    // ═══ 🔐 v183 LOTE 1: QUEM APROVOU E DE QUEM É O DINHEIRO ═══════════════
    // Desde o v177-FIX a sessão do painel pode ter como CHAVE INTERNA o
    // USERNAME reservado ("diego"), e toda a atribuição financeira só
    // entendia E-MAIL: editorFromEmail("diego") caía no default "andrew"
    // (aprovação do Diego gravada como "Andrew") e isAdminEmail("diego") era
    // false, então _finDonoDe devolvia "sem dono" e o acerto entre sócios
    // perdia o dono de TODA entrada aprovada pelo painel.
    {
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _socAntes = (await get("/api/admin/socios")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "compradorl1@test.com", name: "Comprador Lote1" });
      const _pdL1 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Comprador Lote1", userWhatsapp: "53 98145 3496", userCity: "Pelotas" });
      const _pdL1Id = _pdL1.json?.pedidoId;
      // sessão do PAINEL pelo login por senha do Diego (chave interna = username)
      COOKIE = "";
      const _logDiegoL1 = await req2("POST", "/api/admin-panel/login", { user: "diego", password: "teste-smoke-diego-2026" });
      const _actL1 = await req2("PATCH", "/api/pedido/" + _pdL1Id, { status: "ativo" });
      const _pedsL1 = (await get("/api/pedidos")).json?.pedidos || [];
      const _pdL1Full = _pedsL1.find((x) => x.id === _pdL1Id) || {};
      check("🔐 v183-L1: pedido aprovado pela sessão do painel do DIEGO fica registrado como 'Diego' (antes saía 'Andrew', porque editorFromEmail lia o USERNAME da sessão em vez do e-mail real do sócio)",
        _logDiegoL1.status === 200 && _actL1.json?.ok === true && _pdL1Full._ativadoEditor === "Diego" && _pdL1Full._ativadoEditorEmail === "jesuscristh22@gmail.com" && _pdL1Full.ativadoPor === "jesuscristh22@gmail.com",
        JSON.stringify({ editor: _pdL1Full._ativadoEditor, email: _pdL1Full._ativadoEditorEmail, ativadoPor: _pdL1Full.ativadoPor }));
      const _socDepois = (await get("/api/admin/socios")).json;
      const _dDiego = (_socDepois?.socios?.diego?.recebido || 0) - (_socAntes?.socios?.diego?.recebido || 0);
      const _dDerDiego = (_socDepois?.socios?.diego?.derivado || 0) - (_socAntes?.socios?.diego?.derivado || 0);
      const _dSemDono = (_socDepois?.entradas?.semDono?.n || 0) - (_socAntes?.entradas?.semDono?.n || 0);
      check("🔐 v183-L1: o R$150 aprovado pelo Diego entra no acerto COMO DELE (modo derivado da trilha) — e a fila de 'entradas sem dono' NÃO cresceu (era pra lá que todo dinheiro aprovado pelo painel ia)",
        _dDiego === 150 && _dDerDiego === 1 && _dSemDono === 0,
        JSON.stringify({ deltaRecebidoDiego: _dDiego, deltaDerivado: _dDerDiego, deltaSemDono: _dSemDono }));
      const _banL1 = await get("/api/admin/banned-emails");
      const _sentL1 = await req2("POST", "/api/admin/health-sentinel/run", {});
      check("🔐 v183-L1: as guardas de 'admin hardcoded' reconhecem a sessão do painel por username — /api/admin/banned-emails e /api/admin/health-sentinel/run respondem 200, não 403 (o painel do Diego levava 403 nas duas)",
        _banL1.status === 200 && _sentL1.status === 200, JSON.stringify({ banned: _banL1.status, sentinel: _sentL1.status }));
      // o vigia mede o canal de e-mail que REALMENTE existe (mod-notif), não
      // o Gmail pessoal do ADMIN_EMAIL — que nem conta tem desde o v172c.
      const _repL1 = _sentL1.json?.report || {};
      check("🔐 v183-L1: o sentinela passou a medir a CONTA DE NOTIFICAÇÕES (mod-notif, v175) — o alarme vermelho de 'notificações mudas' era disparado a cada 6h só porque getUser(ADMIN_EMAIL) é null desde o v172c",
        typeof _repL1.notif === "object" && typeof _repL1.notif.ok === "boolean",
        JSON.stringify({ notif: _repL1.notif, adminToken: _repL1.adminToken }));
      const _sentSrcL1 = fs.readFileSync(path.join(__dirname, "mod-sentinel.js"), "utf8");
      const _srvSrcL1 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🔐 v183-L1 (estrutural): o botLog de resumo do sentinela fica VERMELHO pela conta de notificações, nunca mais por S.adminToken (alarme falso treinava o dono a ignorar o log onde o alarme real aparece)",
        _sentSrcL1.includes("S.notif?.ok?'info':'error'") && !/S\.adminToken\?\.ok\?'info':'error'/.test(_sentSrcL1) &&
        !_sentSrcL1.includes("TOKEN DO ADMIN QUEBRADO"),
        "o resumo do sentinela ainda decide 'error' pelo token do Gmail pessoal do admin");
      check("🔐 v183-L1 (estrutural): _sessAdminEmail(s) é a fonte ÚNICA de 'qual e-mail representa esta sessão' — nenhuma guarda de admin nem atribuição financeira lê s.user_email cru",
        _srvSrcL1.includes("function _sessAdminEmail(s)") && _srvSrcL1.includes("function _sessAdminNome(s)") &&
        _srvSrcL1.includes("admin_email:login.email") &&
        !/isAdminEmail\(s\.user_email\)/.test(_srvSrcL1) && !/editorFromEmail\(s\.user_email\)/.test(_srvSrcL1) &&
        !/ativadoPorEmail:s\.user_email/.test(_srvSrcL1),
        "ainda existe guarda/atribuição lendo s.user_email cru");
      COOKIE = "";
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }

    // ═══ 💳 v187 LOTE 5: LIMITES DO PLANO E A MENSAGEM DE QUEM JÁ PAGOU ════
    {
      // As duas tabelas vêm da FONTE ÚNICA (mod-config), nunca de números
      // repetidos aqui — mudar a tabela não pode passar por este teste.
      const { PLAN_LIMITS_NEW, PLAN_LIMITS } = require(path.join(__dirname, "mod-config.js"));
      // (1) A ativação PROVISÓRIA gravava o vip SEM `vip.limits`, então
      // getManualLimit/getAutoLimit caíam na tabela LEGADA (PLAN_LIMITS):
      // VIPro provisório dava 200+200/dia em vez dos 100+100 vendidos — e na
      // hora em que o admin confirmava o pedido (que carimba a tabela nova) o
      // limite CAÍA PELA METADE na cara de quem acabou de pagar.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "lim187@test.com", name: "Limites 187" });
      await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "Limites 187", userWhatsapp: "53 98145 3496", userCity: "Pelotas", userState: "RS", nota: "TESTE_COMPROVANTE:300", comprovante: Buffer.from("comp-187-limites").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await new Promise((r) => setTimeout(r, 600));
      const _stProv187 = (await get("/api/status")).json;
      check("💳 v187-L5: o plano PROVISÓRIO vale exatamente o que foi vendido — VIPro provisório devolve 100 manuais + 100 automáticos (PLAN_LIMITS_NEW), não os 200+200 da tabela legada que a confirmação do admin depois cortaria pela metade",
        _stProv187?.manualLimit === PLAN_LIMITS_NEW.vipro.manual && _stProv187?.autoLimit === PLAN_LIMITS_NEW.vipro.auto &&
        _stProv187?.vip?.source === "auto-provisorio",
        JSON.stringify({ manual: _stProv187?.manualLimit, auto: _stProv187?.autoLimit, source: _stProv187?.vip?.source }));

      // (2) Concessão manual do admin numa conta NOVA também carimba o
      // contrato (antes ela nascia sem limits e herdava a tabela legada).
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "novo187@test.com", name: "Novo 187" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/vip/activate", { email: "novo187@test.com", days: 30, autoDays: 30, plan: "vipro" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "novo187@test.com" });
      const _stNovo187 = (await get("/api/status")).json;
      check("💳 v187-L5: /api/admin/vip/activate numa conta SEM plano ativo carimba vip.limits da tabela vigente — 100/100 no VIPro (antes só o plano era gravado e o usuário caía na tabela legada, com o dobro do vendido)",
        _stNovo187?.manualLimit === PLAN_LIMITS_NEW.vipro.manual && _stNovo187?.autoLimit === PLAN_LIMITS_NEW.vipro.auto,
        JSON.stringify({ manual: _stNovo187?.manualLimit, auto: _stNovo187?.autoLimit }));

      // (3) ...mas carimbo CEGO cortaria pela metade um cliente LEGADO ativo
      // numa simples renovação — "nenhum pagante perde nada" (mod-config).
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legado187@test.com", name: "Legado 187", plan: "vip", vip: { active: true, plan: "vip", source: "payment", manualExpires: Date.now() + 10 * 86400000, autoExpires: 0 } });
      const _legAntes = (await get("/api/status")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("POST", "/api/admin/vip/activate", { email: "legado187@test.com", days: 30, plan: "vip" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legado187@test.com" });
      const _legDepois = (await get("/api/status")).json;
      check("💳 v187-L5: renovar um contrato LEGADO ativo (sem vip.limits, tabela antiga 200/dia) NÃO carimba nada — o limite continua 200 depois do +30d; carimbo cego aqui cortaria pela metade quem pagou antes da tabela nova",
        _legAntes?.manualLimit === PLAN_LIMITS.vip.manual && _legDepois?.manualLimit === PLAN_LIMITS.vip.manual,
        JSON.stringify({ antes: _legAntes?.manualLimit, depois: _legDepois?.manualLimit }));

      // (4) Provisório VENCIDO com o pedido ainda na mesa do admin: o gate
      // continua bloqueando (ZERO envio grátis), mas a mensagem não pode
      // mandar pagar de novo quem já pagou.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "espera187@test.com", name: "Espera 187" });
      const _pedEsp = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Espera 187", userWhatsapp: "53 98145 3496", userCity: "Pelotas", userState: "RS" });
      const _pidEsp = _pedEsp.json?.pedidoId;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "espera187@test.com", plan: "vip", vip: { active: true, plan: "vip", source: "auto-provisorio", pedidoId: _pidEsp, manualExpires: Date.now() - 3600000, autoExpires: 0 } });
      const _stEsp = (await get("/api/status")).json;
      const _sendEsp = await req2("POST", "/api/send", { to: "empregador187@example.com", subject: "Application", message: "Olá" });
      check("💳 v187-L5: provisório vencido + pedido AINDA pendente → /api/send continua 402 (ZERO envio grátis intacto), mas a mensagem cita o pedido na mesa do admin e NUNCA manda assinar/pagar de novo — era assim que o site induzia um 2º pagamento de quem já tinha pago",
        _sendEsp.status === 402 && /não precisa pagar de novo/.test(_sendEsp.json?.error || "") &&
        !/assine|venceu em/i.test(_sendEsp.json?.error || "") &&
        _stEsp?.provisorioPendente?.ref === String(_pidEsp).slice(-8).toUpperCase(),
        JSON.stringify({ status: _sendEsp.status, erro: (_sendEsp.json?.error || "").slice(0, 150), prov: _stEsp?.provisorioPendente }));

      // (5) ...e o plano que venceu DE VERDADE (sem pedido esperando) continua
      // com a mensagem de sempre, citando a data — regra v172h intacta.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "venc187@test.com", name: "Vencido 187", plan: "vip", vip: { active: true, plan: "vip", source: "payment", manualExpires: Date.now() - 2 * 86400000, autoExpires: 0 } });
      const _sendVenc = await req2("POST", "/api/send", { to: "empregador187@example.com", subject: "Application", message: "Olá" });
      const _stVenc = (await get("/api/status")).json;
      check("💳 v187-L5: plano vencido SEM pedido esperando continua dizendo a data exata do vencimento (v172h) e provisorioPendente vem null — a mensagem nova é exceção pra quem pagou, nunca o novo padrão",
        _sendVenc.status === 402 && /venceu em \d{2}\/\d{2}\/\d{4}/.test(_sendVenc.json?.error || "") &&
        _stVenc?.provisorioPendente === null,
        JSON.stringify({ status: _sendVenc.status, erro: (_sendVenc.json?.error || "").slice(0, 120), prov: _stVenc?.provisorioPendente }));

      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _srvL5 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _appL5 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
      check("💳 v187-L5 (estrutural): o carimbo de limites numa concessão manual é régua ÚNICA (limitsParaAtivacaoAdmin, usada por vip/activate e vip/set-expiry) e a tela tem uma fonte só pro subtítulo do gate (_planGateSubTxt, usada pelos 2 gates e pelo toast do automático pausado)",
        _srvL5.includes("function limitsParaAtivacaoAdmin(") &&
        (_srvL5.match(/limitsParaAtivacaoAdmin\(target,planName\)/g) || []).length === 2 &&
        _srvL5.includes("function _provisorioPendente(") && _srvL5.includes("provisorioPendente:_provPend?") &&
        _appL5.includes("function _planGateSubTxt(") && (_appL5.match(/_planGateSubTxt\(/g) || []).length === 4,
        "o carimbo de limites ou o subtítulo do gate voltaram a ter 2 réguas");
    }

    // ═══ 🤖 v188 LOTE 6: PAINEL — HISTÓRICO DE PEDIDOS E VIP POR BOTÃO ═════
    // As duas entregas nominais do backlog do dono (task #111) + o maior
    // buraco de receita da auditoria (pagante com o robô parado, invisível).
    {
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      // (1) HISTÓRICO — a rota SEMPRE filtrou por status e devolveu o pedido
      // inteiro; a tela é que só pedia "pendente" e descartava o resto.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "aprov188@test.com", name: "Aprovado 188" });
      await req2("POST", "/api/settings", { whatsapp: "53 98145 3496" });
      const _pApr = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Aprovado 188", userWhatsapp: "53 98145 3496", userCity: "Pelotas", userState: "RS" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "canc188@test.com", name: "Cancelado 188" });
      const _pCan = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Cancelado 188", userWhatsapp: "53 98145 3496", userCity: "Pelotas", userState: "RS" });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      await req2("PATCH", "/api/pedido/" + _pApr.json?.pedidoId, { status: "ativo" });
      await req2("PATCH", "/api/pedido/" + _pCan.json?.pedidoId, { status: "cancelado", notaAdmin: "comprovante de outra pessoa" });
      const _lAtivo = (await get("/api/pedidos?status=ativo")).json?.pedidos || [];
      const _lCanc = (await get("/api/pedidos?status=cancelado")).json?.pedidos || [];
      const _rowApr = _lAtivo.find((x) => x.id === _pApr.json?.pedidoId) || {};
      const _rowCan = _lCanc.find((x) => x.id === _pCan.json?.pedidoId) || {};
      check("🤖 v188-L6: o painel consegue ver o HISTÓRICO — ?status=ativo e ?status=cancelado devolvem listas separadas e corretas, com quem aprovou/cancelou, quando e o motivo (a rota já fazia tudo isso; só a tela pedia 'pendente' e jogava o objeto fora)",
        _rowApr.status === "ativo" && _rowApr.ativadoEm > 0 && !!_rowApr._ativadoEditor &&
        _rowCan.status === "cancelado" && /outra pessoa/.test(_rowCan.notaAdmin || "") &&
        !_lAtivo.some((x) => x.id === _pCan.json?.pedidoId) && !_lCanc.some((x) => x.id === _pApr.json?.pedidoId),
        JSON.stringify({ aprovado: { st: _rowApr.status, por: _rowApr._ativadoEditor, em: _rowApr.ativadoEm }, cancelado: { st: _rowCan.status, nota: _rowCan.notaAdmin } }).slice(0, 200));
      check("🤖 v188-L6: a linha do pedido leva o nome e o WhatsApp da CONTA (cadastro v175 — obrigatório), não só o e-mail: é com eles que o admin decide e fala com o cliente sem sair da tela",
        typeof _rowApr.contaNome === "string" && _rowApr.contaNome === "Aprovado 188" &&
        String(_rowApr.contaWhatsapp || "").replace(/[^0-9]/g, "").length >= 10,
        JSON.stringify({ nome: _rowApr.contaNome, wa: _rowApr.contaWhatsapp }));

      // (2) VIP POR BOTÃO — as 4 rotas existiam prontas e sem nenhum botão.
      // Pela sessão do PAINEL (chave interna = username), a concessão tem que
      // ficar registrada no e-mail REAL do sócio (v183 LOTE 1) e ser revertível.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vipbtn188@test.com", name: "VIP Botao 188" });
      COOKIE = "";
      await req2("POST", "/api/admin-panel/login", { user: "diego", password: "teste-smoke-diego-2026" });
      const _actVip = await req2("POST", "/api/admin/vip/activate", { email: "vipbtn188@test.com", days: 30, autoDays: 0, plan: "vip", note: "reposicao" });
      const _finVip = (await get("/api/admin/financeiro-usuario/vipbtn188@test.com")).json;
      const _credVip = (_finVip?.creditos || [])[0] || {};
      const _audList = (await get("/api/admin/audit")).json?.audit || [];
      const _audVip = _audList.find((a) => a.action === "vip_activate" && a.targetEmail === "vipbtn188@test.com") || {};
      check("🤖 v188-L6 (task #111-B): conceder VIP pelo painel soma os dias, carimba o plano e grava no extrato do usuário com o E-MAIL REAL do sócio que clicou (a sessão do painel tem o username como chave interna — v183 LOTE 1)",
        _actVip.json?.ok === true && _finVip?.plano?.manual?.ativo === true &&
        _credVip.dias === 30 && _credVip.dadoPor === "Diego" &&
        _audVip.admin === "jesuscristh22@gmail.com" && !!_audVip.before,
        JSON.stringify({ cred: { dias: _credVip.dias, por: _credVip.dadoPor }, aud: { admin: _audVip.admin, acao: _audVip.action } }));
      const _revVip = await req2("POST", "/api/admin/audit/revert", { id: _audVip.id, motivo: "teste de reversao" });
      const _finVip2 = (await get("/api/admin/financeiro-usuario/vipbtn188@test.com")).json;
      check("🤖 v188-L6: a concessão feita pelo botão é REVERSÍVEL em 1 clique (/api/admin/audit/revert restaura o snapshot de antes) — dar dias pelo painel nunca é irreversível",
        _revVip.json?.ok === true && _finVip2?.plano?.manual?.ativo === false,
        JSON.stringify({ revert: _revVip.status, manualAtivoDepois: _finVip2?.plano?.manual?.ativo }));

      // (3) REVOGAR — rota única (/api/admin/vip/revoke): zera os dois
      // relógios, para o robô e PRESERVA o extrato de dias concedidos.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "revog188@test.com", name: "Revogado 188", plan: "vipro", vip: { active: true, plan: "vipro", source: "payment", manualExpires: Date.now() + 20 * 86400000, autoExpires: Date.now() + 20 * 86400000, creditos: [{ id: "cred_x", quando: Date.now(), dias: 30, tipo: "pago", origem: "pagamento", motivo: "Plano VIPro 30d", dadoPor: "Diego" }] } });
      await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "revog188@test.com", job: { active: true, status: "waiting_interval", queue: [{ to: "x@y.com" }], nextSendAt: Date.now() + 60000 } });
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _revok = await req2("POST", "/api/admin/vip/revoke", { email: "revog188@test.com" });
      const _finRev = (await get("/api/admin/financeiro-usuario/revog188@test.com")).json;
      const _jobRev = (await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "revog188@test.com" })).json;
      check("🤖 v188-L6: revogar pelo painel zera os DOIS relógios, para o robô automático do usuário (delAutoJob) e PRESERVA o extrato de dias concedidos — o objeto novo que a rota gravava antes apagava vip.creditos, a história de quanto já foi dado e por quê",
        _revok.json?.ok === true && _finRev?.plano?.manual?.ativo === false && _finRev?.plano?.auto?.ativo === false &&
        (_finRev?.creditos || []).length === 1 && !_jobRev?.job,
        JSON.stringify({ manual: _finRev?.plano?.manual?.ativo, auto: _finRev?.plano?.auto?.ativo, creditos: (_finRev?.creditos || []).length, job: !!_jobRev?.job }));
      const _revNaoExiste = await req2("POST", "/api/admin/vip/revoke", { email: "naoexiste188@test.com" });
      const _rotaMorta = await req2("POST", "/api/admin/revoke-vip", { email: "revog188@test.com" });
      check("🤖 v188-L6: a rota duplicada /api/admin/revoke-vip (sem trilha de auditoria, sem parar o robô e criando registro pra e-mail inexistente) foi REMOVIDA — e a rota oficial responde 404 pra usuário que não existe, em vez de criar um do nada",
        _rotaMorta.status === 404 && _revNaoExiste.status === 404,
        JSON.stringify({ rotaRemovida: _rotaMorta.status, usuarioInexistente: _revNaoExiste.status }));

      // (4) ROBÔ PARADO DE PAGANTE — o vigia detecta, mas avisava por 2 canais
      // no-op (sendNotifEmail/pushToUser). Agora o resultado aparece na tela.
      COOKIE = "";
      await req2("POST", "/api/admin-panel/login", { user: "andrio", password: "teste-smoke-andrio-2026" });
      const _sent = (await req2("POST", "/api/admin/health-sentinel/run", {})).json;
      const _contab = (await get("/api/admin/contabilidade")).json;
      const _uRev = (_contab?.usuarios || []).find((x) => x.email === "revog188@test.com") || {};
      check("🤖 v188-L6: /api/admin/contabilidade passou a dizer, por usuário, se o Gmail de ENVIO está conectado (booleano — o token nunca viaja) e o que o robô dele está fazendo; sem isso o painel não respondia 'esse cliente paga e está conseguindo enviar?'",
        "gmailConectado" in _uRev && _uRev.gmailConectado === false && "robo" in _uRev &&
        typeof (_contab?.usuarios || [])[0]?.diasCreditadosCortesia === "number" &&
        _sent?.ok === true && Array.isArray(_sent?.report?.vipDesync),
        JSON.stringify({ gmail: _uRev.gmailConectado, robo: _uRev.robo, sentinela: !!_sent?.ok }));

      const _admL6 = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      const _srvL6 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      check("🤖 v188-L6 (estrutural): o painel consome o vigia (health-sentinel + varredura sob demanda), tem a coluna de Gmail/robô, o filtro de status dos pedidos e o botão de plano por usuário — e nenhuma tela chama a rota removida",
        _admL6.includes('api("/api/admin/health-sentinel")') && _admL6.includes('api("/api/admin/health-sentinel/run"') &&
        _admL6.includes("function celulaGmailRobo(") && _admL6.includes('id="pend-status"') &&
        _admL6.includes("function abrirVipModal(") && _admL6.includes("function detalhesPedido(") &&
        _admL6.includes('api("/api/admin/vip/revoke"') && !_admL6.includes("/api/admin/revoke-vip") &&
        !_srvL6.includes('pathname==="/api/admin/revoke-vip"'),
        "faltou peça do painel do lote 6 ou a rota duplicada voltou");
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    }

    // 🧹 v191 LOTE 9 — o backup.json aposentado: parou de ser escrito e o
    // resíduo (com refresh_token e hash de senha em texto puro) sai do disco
    // E do SQLite no boot. A cópia da pasta cvs/ virou assíncrona: com
    // fs.cpSync ela travava o event loop pra TODO MUNDO 2min depois de cada
    // deploy — exatamente quando todos reconectam.
    const _srvL9 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("🧹 v191-L9: o backup.json aposentado (todos os usuários com refresh_token e senha em TEXTO PURO, lido por ninguém) parou de ser escrito e o boot apaga o resíduo do disco e do SQLite",
      !fs.existsSync(path.join(DATA, "backup.json")) &&
      !/persist\(path\.join\(DATA_DIR,\s*"backup\.json"\)/.test(_srvL9) &&
      _srvL9.includes("storageDelete(_bkJson)") &&
      /BACKUP_EXCLUIR = new Set\(\[[^\]]*"backup\.json"/.test(_srvL9),
      `residuo=${fs.existsSync(path.join(DATA, "backup.json"))}`);
    check("💾 v191-L9 (estrutural): o backup completo copia com fs.promises (cpSync da pasta cvs/ inteira travava o event loop de todo mundo) e nenhum timer chama a função sem tratar a promessa",
      _srvL9.includes("async function criarBackupCompleto()") && _srvL9.includes("await fsp.copyFile(") && _srvL9.includes("await fsp.cp(CVS_DIR") &&
      _srvL9.includes("criarBackupCompleto().catch(") && !/setTimeout\(criarBackupCompleto/.test(_srvL9) && !/setInterval\(criarBackupCompleto/.test(_srvL9),
      "criarBackupCompleto ainda é síncrono ou algum timer chama sem .catch");

    // ═══ 🚫 v194 LOTE 12: o ramo isReply do /api/send MORREU ═══════════════
    // Ele não tinha NENHUM chamador (a aba Respostas não existe nesta
    // reconstrução e o app é só-envio) e era um bypass de verdade: com
    // isReply:true + um threadId que o próprio /api/send devolveu, o envio
    // pulava limite diário, cooldown, freio de rajada, "já enviei pra esse
    // empregador" (regra 8) e a fila do automático.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "l12reply@test.com", name: "L12 Reply", refreshToken: "rt-l12-reply", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 } });
    const _l12HistAntes = ((await get("/api/history")).json?.history || []).length;
    const _l12Reply = await req2("POST", "/api/send", { to: "rh@empresa-l12reply.com", subject: "Re: vaga", message: "obrigado pelo retorno", isReply: true, threadId: "thread-qualquer-123", messageId: "<abc@mail.gmail.com>" });
    const _l12HistDepois = ((await get("/api/history")).json?.history || []).length;
    check("🚫 v194-L12: envio com isReply:true é RECUSADO (400) com explicação — o caminho que dava até 50 e-mails/dia fora do limite do plano, pra empregador JÁ contatado e com countedAsManual:false, não existe mais; o histórico não cresce",
      _l12Reply.status === 400 && _l12Reply.json?.respostaRemovida === true && _l12HistDepois === _l12HistAntes,
      JSON.stringify({ status: _l12Reply.status, hist: [_l12HistAntes, _l12HistDepois] }));
    const _l12Compat = await req2("POST", "/api/send", { to: "rh@empresa-l12compat.com", subject: "Application", message: "Olá, gostaria de me candidatar.", threadId: "thread-qualquer-123", messageId: "<abc@mail.gmail.com>" });
    check("🚫 v194-L12: threadId/messageId de um cliente ANTIGO em cache são IGNORADOS (o envio segue como candidatura nova e chega na etapa do currículo) em vez de recusados — quem está com a tela velha não perde a candidatura",
      _l12Compat.json?.respostaRemovida !== true && /curr[ií]culo|PDF/i.test(_l12Compat.body || ""),
      `status=${_l12Compat.status} body=${(_l12Compat.body || "").slice(0, 90)}`);

    // REGRESSÃO da cadeia de remetente: escolher o PRINCIPAL explicitamente
    // caía, por acaso, no `else` que existia pro reply. "Só remover o else"
    // quebraria esse caso legítimo.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "l12send@test.com", name: "L12 Send", refreshToken: "rt-l12-send", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 } });
    await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "l12 ".repeat(400)).toString("base64"), name: "CV_L12.pdf", cvType: "resume" });
    const _gL12Antes = GOOGLE.envios.length;
    const _l12Principal = await req2("POST", "/api/send", { to: "rh@empresa-l12send.com", subject: "Application", message: "Olá, gostaria de me candidatar.", senderEmail: "l12send@test.com" });
    // 📧 v202 LOTE 20: esta asserção era "não deu erro do NOSSO código" porque
    // a chamada ao Gmail sempre morria na rede do sandbox. Com o Gmail falso
    // ela vira a prova completa: o ramo do e-mail PRINCIPAL escolhido
    // explicitamente ENVIA de verdade (ok:true) pelo endereço certo.
    check("🔁 v194-L12 (regressão): escolher explicitamente o e-mail PRINCIPAL como remetente ENVIA de verdade (ok:true, mensagem saindo do endereço principal) — o `else` que servia ao reply removido no v194 continua cobrindo esse caso legítimo",
      _l12Principal.status === 200 && _l12Principal.json?.ok === true &&
      GOOGLE.envios.length === _gL12Antes + 1 &&
      GOOGLE.envios[GOOGLE.envios.length - 1].para === "rh@empresa-l12send.com" &&
      /l12send@test\.com/.test(GOOGLE.envios[GOOGLE.envios.length - 1].de || ""),
      `status=${_l12Principal.status} raw=${String(_l12Principal.json?.errorRaw || "").slice(0, 90)} envio=${JSON.stringify(GOOGLE.envios[GOOGLE.envios.length - 1] || {}).slice(0, 160)}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 📧 v202 LOTE 20 — O MOTOR DE ENVIO TESTADO DE VERDADE ═════════════
    // A prioridade nº1 do produto (a candidatura CHEGAR no empregador) tinha
    // cobertura comportamental ZERO: todos os POSTs em /api/send e
    // /api/auto/start paravam nos portões (402/429/400/lock) porque o Gmail e
    // o endpoint de token do Google são hosts fixos que o sandbox não alcança.
    // As garantias mais caras do repo eram provadas por GREP DE STRING no
    // server.js — renomear um log quebrava o teste e quebrar a lógica
    // mantendo o texto passava verde. Com o Google falso (GOOGLE_FAKE_BASE,
    // mesma régua do DOL_API_BASE do v182) cada uma delas vira comportamento
    // observável. Os estruturais continuam AO LADO: custam zero e pegam a
    // remoção acidental do caminho de renovação.
    // Fixtures com plano PAGO de verdade — nenhum portão é contornado.
    {
      const { _googleFakeTarget } = require("./mod-gmail.js");
      const _envTokenOrig = process.env.TEST_LOGIN_TOKEN;
      const _envBaseOrig = process.env.GOOGLE_FAKE_BASE;
      const _alvo = (host, tok, base) => {
        if (tok === null) delete process.env.TEST_LOGIN_TOKEN; else process.env.TEST_LOGIN_TOKEN = tok;
        if (base === null) delete process.env.GOOGLE_FAKE_BASE; else process.env.GOOGLE_FAKE_BASE = base;
        try { return _googleFakeTarget(host); } finally {
          if (_envTokenOrig === undefined) delete process.env.TEST_LOGIN_TOKEN; else process.env.TEST_LOGIN_TOKEN = _envTokenOrig;
          if (_envBaseOrig === undefined) delete process.env.GOOGLE_FAKE_BASE; else process.env.GOOGLE_FAKE_BASE = _envBaseOrig;
        }
      };
      const _local = `http://127.0.0.1:${GOOGLE_PORT}`;
      check("🔐 v202-L20 (guarda permanente): o rewrite de host do httpsReq só liga com TEST_LOGIN_TOKEN **E** GOOGLE_FAKE_BASE local, e SÓ pros 2 hosts EXATOS do Google — sem env, com https, com host remoto, com sufixo colado ou pra qualquer outro host (DOL, userinfo, Gemini) ele NUNCA redireciona credencial nenhuma",
        // liga: os 2 hosts exatos, com as 2 travas
        !!_alvo("gmail.googleapis.com", "t".repeat(30), _local) &&
        !!_alvo("oauth2.googleapis.com", "t".repeat(30), "http://localhost:1234") &&
        // não liga: falta uma das travas
        _alvo("gmail.googleapis.com", null, _local) === null &&
        _alvo("gmail.googleapis.com", "t".repeat(30), null) === null &&
        // não liga: destino que não é local / não é http
        _alvo("gmail.googleapis.com", "t".repeat(30), "https://127.0.0.1:1234") === null &&
        _alvo("gmail.googleapis.com", "t".repeat(30), "http://evil.example.com:80") === null &&
        // não liga: host que não está na lista de 2 (inclui wildcard e sufixo)
        _alvo("www.googleapis.com", "t".repeat(30), _local) === null &&
        _alvo("generativelanguage.googleapis.com", "t".repeat(30), _local) === null &&
        _alvo("api.seasonaljobs.dol.gov", "t".repeat(30), _local) === null &&
        _alvo("gmail.googleapis.com.evil.com", "t".repeat(30), _local) === null &&
        // e a lista de hosts no CÓDIGO continua sendo exatamente esses 2
        /GOOGLE_REWRITABLE_HOSTS = new Set\(\["gmail\.googleapis\.com", "oauth2\.googleapis\.com"\]\)/
          .test(fs.readFileSync(path.join(__dirname, "mod-gmail.js"), "utf8")),
        "a régua do rewrite de host aceitou uma combinação que NÃO podia — isso é redirecionamento de credencial do Google");

      // ── 1) ENVIO MANUAL PONTA A PONTA ──────────────────────────────────
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "envio20@test.com", name: "Envio 20", refreshToken: "rt-envio20", plan: "vipro", vip: { active: true, plan: "vipro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 } });
      await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "envio20 ".repeat(300)).toString("base64"), name: "CV_Envio20.pdf", cvType: "resume" });
      GOOGLE.limpar();
      const _env20 = await req2("POST", "/api/send", { to: "rh@empresa-envio20.com", subject: "Candidatura — Cook", message: "Olá, gostaria de me candidatar à vaga.", jobTitle: "Cook", company: "Empresa Envio 20", caseNum: "H-400-ENVIO20" });
      const _hist20 = ((await get("/api/history")).json?.history || []);
      const _sent20 = (await get("/api/sent-emails")).json;
      check("📧 v202-L20: envio MANUAL de quem tem plano pago e Gmail conectado CHEGA no Gmail (200) — a candidatura sai com o destinatário e o assunto do usuário, entra no histórico com o id devolvido pelo Google e o empregador vira 'já contatado' (regra 8). Nenhum check da suíte tinha visto uma candidatura sair.",
        _env20.status === 200 && _env20.json?.ok === true && _env20.json?.countedAsManual === true &&
        GOOGLE.envios.length === 1 && GOOGLE.envios[0].para === "rh@empresa-envio20.com" &&
        GOOGLE.envios[0].assunto === "Candidatura — Cook" &&
        _hist20.some((h) => h.to === "rh@empresa-envio20.com" && h.type === "manual" && h.msgId === _env20.json?.messageId) &&
        (_sent20?.sent || []).includes("rh@empresa-envio20.com"),
        JSON.stringify({ status: _env20.status, body: (_env20.body || "").slice(0, 120), envios: GOOGLE.envios }).slice(0, 320));

      // ── 2) ERRO NOS PASSOS PÓS-ENVIO (v177-FIX3, agora comportamental) ──
      // `desc` chegando como NÚMERO faz buildJobSnapshot estourar (.slice de
      // number) DEPOIS que o Gmail já respondeu 200 — exatamente a classe que
      // o try/catch próprio do v177-FIX3 existe pra cobrir. E é aqui que
      // aparece o bug REAL que este lote corrigiu: o markSent vivia DENTRO
      // desse try, então o servidor dizia "enviada" sem nunca registrar o
      // empregador — a mesma empresa voltava na busca e na fila do robô.
      await req2("POST", "/api/settings", { manualCdOff: true });
      GOOGLE.limpar();
      const _pos20 = await req2("POST", "/api/send", { to: "rh@empresa-posenvio20.com", subject: "Candidatura", message: "Olá, gostaria de me candidatar.", desc: 123456 });
      const _sentPos = (await get("/api/sent-emails")).json;
      check("📧 v202-L20: falha NOS PASSOS PÓS-ENVIO devolve ok:true com aviso (nunca 'falha' pra uma candidatura que JÁ SAIU) — e, correção deste lote, a regra 8 registra o empregador MESMO ASSIM: antes o markSent vivia dentro do try que estourava e a empresa podia receber 2 candidaturas",
        _pos20.status === 200 && _pos20.json?.ok === true && typeof _pos20.json?.warning === "string" && /hist[oó]rico/i.test(_pos20.json.warning) &&
        GOOGLE.envios.length === 1 && GOOGLE.envios[0].para === "rh@empresa-posenvio20.com" &&
        (_sentPos?.sent || []).includes("rh@empresa-posenvio20.com"),
        JSON.stringify({ status: _pos20.status, json: _pos20.json, marcados: (_sentPos?.sent || []).length }).slice(0, 300));

      // ── 2b) 🚨 v230 (achado de auditoria — Média): REMETENTE MANUAL
      // BLOQUEADO pelo Google (blocked:true, 13a3) ────────────────────────
      // getSenderToken já filtrava `blocked` no pool do round-robin
      // automático, mas o envio MANUAL com remetente ESCOLHIDO pelo usuário
      // nunca checava — tentava renovar o token de uma conta suspensa,
      // falhava, e caía no catch genérico que manda pelo principal EM
      // SILÊNCIO (o usuário via "enviado" achando que saiu pela conta que
      // ele escolheu). Prova: nada sai pelo principal, resposta é 409 clara.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "envio20@test.com", senderEmails: [{ email: "blocked230@gmail.com", active: true, blocked: true, addedAt: Date.now() - 30 * 86400_000 }] });
      GOOGLE.limpar();
      const _blk230 = await req2("POST", "/api/send", { to: "rh@empresa-blk230.com", subject: "Candidatura", message: "Olá, gostaria de me candidatar.", senderEmail: "blocked230@gmail.com", jobTitle: "Cook", company: "Empresa 230", caseNum: "H-400-BLK230" });
      check("🚨 v230: escolher explicitamente um remetente BLOQUEADO pelo Google (blocked:true) é RECUSADO (409, senderBlocked:true) em vez de mandar em silêncio pelo Gmail principal — o usuário sabe na hora que precisa trocar de conta",
        _blk230.status === 409 && _blk230.json?.senderBlocked === true && GOOGLE.envios.length === 0,
        JSON.stringify({ status: _blk230.status, body: (_blk230.body || "").slice(0, 160), envios: GOOGLE.envios.length }));

      // ── 2c) 🚨 v237l (achado de auditoria — Alta, gmail-envio): TIMEOUT
      // AMBÍGUO no sender extra escolhido não pode virar reenvio cego pelo
      // principal — antes, QUALQUER exceção (incluindo a conexão caindo sem
      // nenhuma resposta do Gmail — httpsReq pode rejeitar sem saber se o
      // envio já foi processado do outro lado) caía direto no fallback que
      // mandava a MESMA candidatura de novo, por OUTRA conta, arriscando 2
      // e-mails pro mesmo empregador. GOOGLE.falhasEnvio com networkError
      // simula exatamente isso: o fake Gmail destrói a conexão sem responder.
      // v101: só DoublePro permite e-mail extra de verdade (VIP/VIPro = 0
      // extras) — precisa do plano certo pra chegar no httpsReq do sender.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "envio20@test.com", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 }, senderEmails: [{ email: "ambig237l@gmail.com", active: true, access_token: "at-ambig237l", token_expiry: Date.now() + 3600_000, addedAt: Date.now() - 30 * 86400_000 }] });
      GOOGLE.limpar();
      GOOGLE.falhasEnvio.push({ networkError: true });
      const _amb237l = await req2("POST", "/api/send", { to: "rh@empresa-ambig237l.com", subject: "Candidatura", message: "Olá, gostaria de me candidatar.", senderEmail: "ambig237l@gmail.com", jobTitle: "Cook", company: "Empresa Ambig", caseNum: "H-400-AMBIG237L" });
      check("🚨 v237l: timeout AMBÍGUO (conexão cai sem NENHUMA resposta do Gmail) no sender extra escolhido NÃO reenvia pelo principal em silêncio — 502 claro com ambiguousSend:true, e ZERO e-mails saem (nem pelo extra, nem por um reenvio pelo principal)",
        _amb237l.status === 502 && _amb237l.json?.ambiguousSend === true && GOOGLE.envios.length === 0,
        JSON.stringify({ status: _amb237l.status, body: (_amb237l.body || "").slice(0, 200), envios: GOOGLE.envios.length }));

      // ── 2d) v237l (contraste): erro CONFIRMADO do Gmail (resposta HTTP de
      // verdade, não ambíguo) no sender extra CONTINUA caindo pro principal
      // normalmente — a proteção nova é só pra quando a resposta nunca
      // chega; nunca pode travar o fallback seguro que já existia pra
      // quando o Google efetivamente respondeu com um erro.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "envio20@test.com", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 }, senderEmails: [{ email: "confirm237l@gmail.com", active: true, access_token: "at-confirm237l", token_expiry: Date.now() + 3600_000, addedAt: Date.now() - 30 * 86400_000 }] });
      GOOGLE.limpar();
      GOOGLE.falhasEnvio.push({ status: 500, body: { error: { message: "Internal error" } } });
      const _conf237l = await req2("POST", "/api/send", { to: "rh@empresa-confirm237l.com", subject: "Candidatura", message: "Olá, gostaria de me candidatar.", senderEmail: "confirm237l@gmail.com", jobTitle: "Cook", company: "Empresa Confirm", caseNum: "H-400-CONFIRM237L" });
      check("v237l (contraste): erro CONFIRMADO do Gmail (HTTP 500 de verdade, resposta chegou) no sender extra continua caindo pro principal e ENVIANDO normalmente — a trava nova não é geral, é só pra ambiguidade real",
        _conf237l.status === 200 && _conf237l.json?.ok === true && GOOGLE.envios.length === 1 &&
        GOOGLE.envios[0].para === "rh@empresa-confirm237l.com" && GOOGLE.envios[0].de.includes("envio20@test.com"),
        JSON.stringify({ status: _conf237l.status, body: (_conf237l.body || "").slice(0, 160), envios: GOOGLE.envios }).slice(0, 320));

      // ── 2e) v237l (estrutural): o MESMO padrão de guarda existe no
      // round-robin manual (sem senderEmail explícito) — a fragilidade de
      // orquestrar contagem/ordem do round-robin numa vaga só pra provar de
      // novo o comportamento já provado acima não vale o risco; aqui só
      // confere que a mesma trava foi aplicada nos DOIS lugares que fazem
      // fallback-pra-principal no envio manual.
      {
        const _srvSrcV237l = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
        const _e2Block = _srvSrcV237l.slice(_srvSrcV237l.indexOf("}catch(e2){"), _srvSrcV237l.indexOf("}else if(!requestedSender){"));
        const _e3Block = _srvSrcV237l.slice(_srvSrcV237l.indexOf("}catch(e3){"), _srvSrcV237l.indexOf("}else{\n        // v194 LOTE 12"));
        check("v237l (estrutural): os DOIS catches do fallback manual (sender extra explícito `e2` e round-robin `e3`) checam `.noResponse` e devolvem 502 ambiguousSend antes de qualquer reenvio pelo principal",
          /if\(e2\.noResponse\)/.test(_e2Block) && /ambiguousSend:true/.test(_e2Block) &&
          /if\(e3\.noResponse\)/.test(_e3Block) && /ambiguousSend:true/.test(_e3Block),
          `e2 tem=${/if\(e2\.noResponse\)/.test(_e2Block)} e3 tem=${/if\(e3\.noResponse\)/.test(_e3Block)}`);
      }

      // ── 2f) 🚨 v237n (achado de auditoria — Média, gmail-envio): o teto de
      // AQUECIMENTO (13a) do sender extra explícito era check-then-act SEM
      // reserva — diferente do limite diário total (_manualSendReserved,
      // v18-FIX), 2+ requisições CONCORRENTES pro MESMO sender liam a MESMA
      // contagem "antiga" (getHist ainda sem os envios em voo) e todas
      // passavam, furando o teto. Conta recém-conectada (addedAt=agora) tem
      // cap=15/dia (warmupCapForSender) — dispara 16 envios EM PARALELO
      // (Promise.all, TCP separado cada um) pro mesmo sender e prova que no
      // MÁXIMO 15 saem de verdade; o 16º (ou mais, se a corrida se repetir)
      // é recusado com WARMUP_CAP_REACHED, nunca furando o teto.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "warmup237n@test.com", name: "Warmup 237n", refreshToken: "rt-warmup237n", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 }, senderEmails: [{ email: "sndwarmup237n@gmail.com", active: true, access_token: "at-warmup237n", token_expiry: Date.now() + 3600_000, addedAt: Date.now() }] });
      await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "warmup237n ".repeat(300)).toString("base64"), name: "CV_Warmup237n.pdf", cvType: "resume" });
      await req2("POST", "/api/settings", { manualCdOff: true });
      GOOGLE.limpar();
      const _w237nResults = await Promise.all(Array.from({ length: 16 }, (_, i) =>
        req2("POST", "/api/send", { to: `rh${i}@warmup237n-test.com`, subject: "Candidatura", message: "Olá, gostaria de me candidatar.", senderEmail: "sndwarmup237n@gmail.com", jobTitle: "Cook", company: `Empresa Warmup ${i}`, caseNum: `H-400-WARMUP237N-${i}` })));
      const _w237nOk = _w237nResults.filter((r) => r.status === 200 && r.json?.ok === true).length;
      const _w237nCap = _w237nResults.filter((r) => r.status === 429 && r.json?.warmup === true).length;
      check("🚨 v237n: 16 envios manuais CONCORRENTES pro MESMO sender em aquecimento (cap=15/dia) — no máximo 15 saem de verdade pelo Gmail; o excedente é recusado (429 warmup), nunca fura o teto por causa da corrida",
        _w237nOk === 15 && _w237nCap >= 1 && _w237nOk + _w237nCap === 16 &&
        GOOGLE.envios.filter((e2) => (e2.de || "").includes("sndwarmup237n")).length === 15,
        JSON.stringify({ ok: _w237nOk, cap: _w237nCap, total: _w237nResults.length, enviosPeloSender: GOOGLE.envios.filter((e2) => (e2.de || "").includes("sndwarmup237n")).length, statuses: _w237nResults.map((r) => r.status) }).slice(0, 400));

      // ── 3) FILA AUTOMÁTICA DE 3 VAGAS: envia de verdade e a fila diminui ─
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "auto20@test.com", name: "Auto 20", refreshToken: "rt-auto20", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 } });
      const _cvAuto20 = await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "auto20 ".repeat(300)).toString("base64"), name: "CV_Auto20.pdf", cvType: "resume" });
      GOOGLE.limpar();
      const _fila20 = [1, 2, 3].map((i) => ({ to: `rh${i}@auto20-test.com`, title: "Cook", company: `Empresa Auto ${i}`, category: "food", state: "FL" }));
      const _start20 = await req2("POST", "/api/auto/start", { queue: _fila20, resumeIdx: _cvAuto20.json?.cv?.idx, subjects: ["Candidatura — Cook"], emailBodies: ["Olá, gostaria de me candidatar."] });
      const _ate = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15_000)) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
      const _c1 = await _ate(() => GOOGLE.envios.length >= 1);
      const _j1 = (await get("/api/auto/status")).json?.job || {};
      const _d2 = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "auto20@test.com", disparar: true });
      const _d3 = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "auto20@test.com", disparar: true });
      const _destinos20 = GOOGLE.envios.map((e2) => e2.para).sort();
      check("🤖 v202-L20: a fila do AUTOMÁTICO envia de verdade e diminui a cada ciclo — 3 vagas viram 3 candidaturas no Gmail (uma por ciclo, fila 3→2→1→0), todas com o assunto e o corpo que o usuário escreveu e saindo do Gmail dele",
        _start20.status === 200 && _c1 === true &&
        _j1.queueSize === 2 && _d2.json?.job?.queue?.length === 1 && _d3.json?.job?.queue?.length === 0 &&
        _d3.json?.job?.active === true && _d3.json?.job?.status === "waiting_interval" &&
        GOOGLE.envios.length === 3 &&
        JSON.stringify(_destinos20) === JSON.stringify(["rh1@auto20-test.com", "rh2@auto20-test.com", "rh3@auto20-test.com"]) &&
        GOOGLE.envios.every((e2) => e2.assunto === "Candidatura — Cook" && /auto20@test\.com/.test(e2.de || "")),
        JSON.stringify({ start: _start20.status, c1: _c1, filas: [_j1.queueSize, _d2.json?.job?.queue?.length, _d3.json?.job?.queue?.length], envios: _destinos20, status: _d3.json?.job?.status }).slice(0, 380));

      // ── 4) TOKEN VENCIDO NO MEIO DA FILA (v165): renova e RE-TENTA a MESMA vaga
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "auth401@test.com", name: "Auth 401", refreshToken: "rt-auth401-vivo", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 } });
      const _cv401 = await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "a401 ".repeat(300)).toString("base64"), name: "CV_401.pdf", cvType: "resume" });
      GOOGLE.limpar();
      GOOGLE.falhasEnvio.push({ status: 401, body: { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } } });
      const _start401 = await req2("POST", "/api/auto/start", { queue: [{ to: "rh1@auth401-test.com", title: "Cook", company: "Empresa 401 A" }, { to: "rh2@auth401-test.com", title: "Cook", company: "Empresa 401 B" }], resumeIdx: _cv401.json?.cv?.idx, subjects: ["Candidatura"], emailBodies: ["Olá."] });
      const _ok401 = await _ate(() => GOOGLE.envios.length >= 1);
      const _j401 = (await get("/api/auto/status")).json?.job || {};
      // A fila ESPERTA reordena as vagas na montagem (regra 13/score de
      // encaixe) — o teste nunca assume QUAL das duas foi a 1ª; o que importa
      // é que a MESMA vaga do 401 foi a que saiu, uma única vez.
      const _alvo401 = GOOGLE.envios[0]?.para || "";
      const _h401 = ((await get("/api/history")).json?.history || []).filter((h) => h.to === _alvo401);
      check("🔐 v202-L20 (v165, comportamental): token vencido NO MEIO da fila ('Invalid Credentials') renova sozinho e RE-TENTA a MESMA vaga — a candidatura sai com o token NOVO, a vaga não é queimada (1 no histórico, não 2) e a fila só anda uma casa; antes isso era provado por grep de uma string de log",
        _start401.status === 200 && _ok401 === true &&
        GOOGLE.refreshes.length >= 1 && GOOGLE.refreshes[0].refresh_token === "rt-auth401-vivo" &&
        GOOGLE.envios.length === 1 && /^rh[12]@auth401-test\.com$/.test(_alvo401) &&
        /^at-vivo-/.test(GOOGLE.envios[0].auth || "") &&
        _h401.length === 1 && _j401.queueSize === 1 && _j401.active === true,
        JSON.stringify({ refreshes: GOOGLE.refreshes.length, envios: GOOGLE.envios, hist: _h401.length, fila: _j401.queueSize, status: _j401.status }).slice(0, 360));

      // ── 5) invalid_grant CONFIRMADO pelo Google → PAUSA (13a2) ─────────
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "rtmorto20@test.com", name: "RT Morto", refreshToken: "rt-morto20", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 } });
      const _cvMorto = await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "morto20 ".repeat(300)).toString("base64"), name: "CV_Morto.pdf", cvType: "resume" });
      GOOGLE.limpar();
      GOOGLE.rtMortos.add("rt-morto20");
      GOOGLE.falhasEnvio.push({ status: 401, body: { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } } });
      const _startMorto = await req2("POST", "/api/auto/start", { queue: [{ to: "rh1@rtmorto20-test.com", title: "Cook", company: "Morto A" }, { to: "rh2@rtmorto20-test.com", title: "Cook", company: "Morto B" }], resumeIdx: _cvMorto.json?.cv?.idx, subjects: ["Candidatura"], emailBodies: ["Olá."] });
      const _pausou = await _ate(() => GOOGLE.refreshes.length >= 1);
      await new Promise((r) => setTimeout(r, 400));
      const _jMorto = (await get("/api/auto/status")).json?.job || {};
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _udMorto = (await get("/api/admin/financeiro-usuario/" + encodeURIComponent("rtmorto20@test.com"))).json;
      check("🔐 v202-L20 (13a2, comportamental): a pausa por autenticação só acontece com a queda CONFIRMADA por um refresh REAL — o Google devolve invalid_grant, o robô para (paused_auth_error), a vaga VOLTA pra fila (nada é perdido) e o refresh_token é marcado como morto; nenhum e-mail saiu",
        _startMorto.status === 200 && _pausou === true &&
        GOOGLE.envios.length === 0 &&
        _jMorto.active === false && _jMorto.status === "paused_auth_error" && _jMorto.queueSize === 2 &&
        _udMorto?.auth?.rtInvalid === true &&
        (_udMorto?.auth?.timeline || []).some((ev) => ev.tipo === "pausa_auth"),
        JSON.stringify({ envios: GOOGLE.envios.length, job: { a: _jMorto.active, s: _jMorto.status, q: _jMorto.queueSize }, rtInvalid: _udMorto?.auth?.rtInvalid, tl: (_udMorto?.auth?.timeline || []).map((ev) => ev.tipo) }).slice(0, 320));

      // ── 6) EXTRA COM AUTH MORTA: isolado, e o robô SEGUE pelas outras ───
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "extra20@test.com", name: "Extra 20", refreshToken: "rt-extra20-principal", plan: "doublepro", vip: { active: true, plan: "doublepro", source: "payment", manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000 }, senderEmails: [{ email: "extraruim20@test.com", active: true, refresh_token: "rt-extra20-morto", addedAt: Date.now() - 60 * 86400_000 }] });
      const _cvExtra = await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "extra20 ".repeat(300)).toString("base64"), name: "CV_Extra20.pdf", cvType: "resume" });
      GOOGLE.limpar();
      GOOGLE.rtMortos.add("rt-extra20-morto");
      // 1 envio manual pelo PRINCIPAL antes: o rodízio escolhe por menor
      // contagem do dia, então com 1×0 o EXTRA é o próximo da vez — é o que
      // leva o motor a tropeçar na conta doente de propósito.
      await req2("POST", "/api/send", { to: "rh@empresa-extra20-manual.com", subject: "Candidatura", message: "Olá, gostaria de me candidatar." });
      const _startExtra = await req2("POST", "/api/auto/start", { queue: [{ to: "rh1@extra20-test.com", title: "Cook", company: "Extra A" }, { to: "rh2@extra20-test.com", title: "Cook", company: "Extra B" }], resumeIdx: _cvExtra.json?.cv?.idx, subjects: ["Candidatura"], emailBodies: ["Olá."] });
      const _okExtra = await _ate(() => GOOGLE.envios.length >= 2);
      const _jExtra = (await get("/api/auto/status")).json?.job || {};
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _udExtra = (await get("/api/admin/financeiro-usuario/" + encodeURIComponent("extra20@test.com"))).json;
      check("🛡️ v202-L20 (v73/v165, comportamental): conta Gmail EXTRA com autorização morta é ISOLADA (badge RECONECTAR) e o robô SEGUE pelas outras — a vaga sai pelo Gmail principal no mesmo ciclo, o job continua ativo e nada é apagado da conta doente",
        _startExtra.status === 200 && _okExtra === true &&
        (_udExtra?.auth?.senders || []).some((se) => se.email === "extraruim20@test.com" && se.tokenExpired === true && se.active === true) &&
        GOOGLE.envios.some((e2) => /^rh[12]@extra20-test\.com$/.test(e2.para) && /extra20@test\.com/.test(e2.de || "")) &&
        _jExtra.active === true && _jExtra.status !== "paused_auth_error",
        JSON.stringify({ senders: _udExtra?.auth?.senders, envios: GOOGLE.envios.map((e2) => e2.para), job: { a: _jExtra.active, s: _jExtra.status } }).slice(0, 380));
      GOOGLE.limpar();

      // ── 7) 🚨 v237 (achado de auditoria — Alta, gmail-envio): 2 extras com
      // auth morta na MESMA chamada de round-robin não podiam mais apagar um
      // ao outro. getSenderToken() usava o `p` capturado no TOPO da função
      // pra gravar tokenExpired — quando o 2º candidato também falhava, a
      // escrita dele reusava o array de ANTES da 1ª falha, revertendo a
      // marcação que tinha acabado de ser gravada 2 linhas antes (só o
      // ÚLTIMO processado ficava tokenExpired:true de verdade). Cenário: só
      // admin permite 2+ extras no pool ao mesmo tempo (MAX_SENDER_EMAILS_
      // DOUBLEPRO=2 = principal+1 extra só — não dá pra ter 2 extras vivos
      // simultâneos fora do admin); `senders` do /api/auto/start restringe o
      // rodízio SÓ aos 2 extras (exclui o principal do pool), garantindo que
      // os 2 sejam tentados nessa chamada — ambos com refresh_token morto.
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "duplaextra20@test.com", name: "Dupla Extra 20", isAdmin: true, refreshToken: "rt-duplaextra20-principal", senderEmails: [
        { email: "extraruimA20@test.com", active: true, refresh_token: "rt-duplaextra20-mortaA", addedAt: Date.now() - 60 * 86400_000 },
        { email: "extraruimB20@test.com", active: true, refresh_token: "rt-duplaextra20-mortaB", addedAt: Date.now() - 60 * 86400_000 },
      ] });
      const _cvDupla = await req2("POST", "/api/cv/upload", { base64: Buffer.from("%PDF-1.4 " + "duplaextra20 ".repeat(300)).toString("base64"), name: "CV_DuplaExtra20.pdf", cvType: "resume" });
      GOOGLE.limpar();
      GOOGLE.rtMortos.add("rt-duplaextra20-mortaA");
      GOOGLE.rtMortos.add("rt-duplaextra20-mortaB");
      const _startDupla = await req2("POST", "/api/auto/start", { queue: [{ to: "rh1@duplaextra20-test.com", title: "Cook", company: "Dupla A" }], senders: ["extraruimA20@test.com", "extraruimB20@test.com"], resumeIdx: _cvDupla.json?.cv?.idx, subjects: ["Candidatura"], emailBodies: ["Olá."] });
      const _okDupla = await _ate(() => GOOGLE.refreshes.length >= 2);
      const _udDupla = (await get("/api/admin/financeiro-usuario/" + encodeURIComponent("duplaextra20@test.com"))).json;
      const _sendersDupla = _udDupla?.auth?.senders || [];
      check("🚨 v237: 2 extras com auth morta na MESMA rodada de round-robin (rodízio restrito só a eles via 'senders', exclui o principal do pool) ficam AMBOS com tokenExpired:true — a 2ª escrita não apaga mais o que a 1ª acabou de gravar (releitura de getUser() a cada escrita, nunca reusa snapshot velho)",
        _startDupla.status === 200 && _okDupla === true &&
        _sendersDupla.some((se) => se.email === "extraruimA20@test.com" && se.tokenExpired === true) &&
        _sendersDupla.some((se) => se.email === "extraruimB20@test.com" && se.tokenExpired === true),
        JSON.stringify({ senders: _sendersDupla, refreshes: GOOGLE.refreshes.length }).slice(0, 320));
      GOOGLE.limpar();
    }

    // ═══ 🧹 v199 LOTE 18: faxina do servidor (o que não tinha como rodar) ═══
    // O app é SÓ-ENVIO: o escopo pedido ao Google é gmail.send e nada mais
    // (guarda estrutural própria mais acima). Mesmo assim sobrevivia o stack
    // INTEIRO de leitura de caixa de entrada — 3 rotas /api/inbox* (2 delas
    // SEM nenhuma guarda: chamariam o Gmail com um escopo que não existe),
    // o leitor/parser de mensagem, o casador resposta→candidatura e o índice
    // `app_index.json`, ESCRITO a cada candidatura enviada pra alimentar um
    // único leitor que também era inalcançável: RAM e disco gastos por envio
    // pra ninguém. Junto iam 2 sinks sem front (/api/note/*, /api/alerts) e
    // 3 bancos que só eram carregados no boot e regravados no shutdown.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "l18@test.com", name: "L18" });
    const _l18Rotas = {
      inbox: await get("/api/inbox"),
      inboxMatch: await req2("POST", "/api/inbox/match", { threadId: "x" }),
      inboxRead: await req2("POST", "/api/inbox/read", { ids: ["x"] }),
      alerts: await req2("POST", "/api/alerts", { state: "TX" }),
      note: await req2("POST", "/api/note/vaga-x", { note: "oi" }),
    };
    check("🧹 v199-L18: as 5 rotas sem dono respondem 404 — /api/inbox, /api/inbox/match, /api/inbox/read (leitura de caixa de entrada, que este app nunca faz), /api/alerts e /api/note/:id (dois sinks que gravavam dado ilimitado por usuário sem NENHUMA tela lendo)",
      Object.values(_l18Rotas).every((r) => r.status === 404),
      JSON.stringify(Object.fromEntries(Object.entries(_l18Rotas).map(([k, v]) => [k, v.status]))));
    check("🧹 v199-L18: nenhum app_index.json é criado — o índice de candidaturas era escrito (debounced) a CADA envio e o único leitor dele vivia dentro da leitura de inbox",
      !fs.existsSync(path.join(DATA, "app_index.json")),
      "app_index.json ainda está sendo escrito no DATA_DIR");
    const _l18Sinks = ["notes.json", "job_alerts.json", "push_subs.json", "notifications.json", "suggestions.json"]
      .filter((f) => fs.existsSync(path.join(DATA, f)));
    check("🧹 v199-L18: os bancos sem leitor (notes/job_alerts/push_subs/notifications/suggestions) não são mais criados nem regravados no desligamento",
      _l18Sinks.length === 0, `ainda em disco: ${_l18Sinks.join(", ")}`);
    // `settings` era merge de objeto ARBITRÁRIO do cliente dentro do users.json
    // (teto de corpo: 50MB), sem nenhuma tela mandando o campo.
    await req2("POST", "/api/settings", { settings: { lixo: "x".repeat(5000), outro: { a: 1 } } });
    const _l18Disco = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8")); } catch { return {}; } })();
    check("🧹 v199-L18: POST /api/settings com `settings:{…}` NÃO grava nada — o campo continua sendo LIDO (conta antiga com assunto/corpo salvo ali segue servida), mas o cliente não escreve mais objeto arbitrário dentro do users.json",
      !_l18Disco["l18@test.com"]?.settings?.lixo,
      JSON.stringify(Object.keys(_l18Disco["l18@test.com"]?.settings || {})).slice(0, 120));
    // O vigia media planilha com um `typeof getSheet` de uma global que não
    // existe no módulo: S.planilhas era SEMPRE [] e o resumo dizia "0
    // planilha(s) com alerta" mesmo com planilha envelhecida.
    // (a rota do vigia exige um e-mail que é admin DE VERDADE — isAdminEmail —,
    // não só uma conta com a flag isAdmin; mesmo padrão do check do v183-L1.)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Admin", isAdmin: true });
    const _l18Sent = await req2("POST", "/api/admin/health-sentinel/run", {});
    const _l18Pl = _l18Sent.json?.report?.planilhas || [];
    check("🧹 v199-L18: o monitor de planilhas do vigia FUNCIONA (antes era sempre lista vazia) — lê as planilhas publicadas pela mesma função do robô de frescor e mede 'completa' pela régua única CAMPOS_ESSENCIAIS",
      _l18Sent.json?.ok === true && _l18Pl.length >= 2 &&
      _l18Pl.every((x) => typeof x.vagas === "number" && x.vagas > 0 && typeof x.pctCompletas === "number"),
      JSON.stringify(_l18Pl.slice(0, 3)));
    check("🧹 v199-L18: o vigia enxerga a planilha que o robô ainda não completou (jan2026/jul2025 têm e-mail em 100% das linhas mas ZERO cidade/datas/descrição — era exatamente esse alarme que nunca acendia)",
      _l18Pl.some((x) => x.alerta && /completas|e-mail/.test(String(x.alerta))),
      JSON.stringify(_l18Pl.map((x) => [x.planilha, x.alerta])).slice(0, 300));
    // Estrutural: nada do stack removido pode voltar por descuido.
    const _l18Srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const _l18Wd = fs.readFileSync(path.join(__dirname, "mod-watchdogs.js"), "utf8");
    // Só comentários de LINHA: um `/* … */` guloso aqui casaria com pares
    // acidentais formados por literais de regex do próprio código e apagaria
    // trechos inteiros do arquivo (a guarda passaria a medir o vazio).
    const _l18SemCom = (t2) => t2.replace(/^[ \t]*\/\/.*$/gm, " ");
    const _l18SrvCode = _l18SemCom(_l18Srv), _l18WdCode = _l18SemCom(_l18Wd);
    const _l18Mortos = ["gmailFetchInbox", "gmailMarkRead", "matchAppToEmail", "indexApp", "rebuildAppIndex",
      "DB_APP_INDEX", "APPIDX_FILE", "fetchGmailMessageHeaders", "DB_NOTES", "DB_ALERTS", "DB_PUSH",
      "DB_NOTIF ", "DB_SUGGESTIONS", "hourBRT", "isOnlineUser", "_savePlaniha", "getAllAdminEmails", "setHealth"]
      .filter((n) => _l18SrvCode.includes(n));
    check("🧹 v199-L18 (estrutural): nenhuma das 18 peças do stack morto voltou ao server.js (leitura de inbox, índice de candidaturas, bancos sem leitor e funções órfãs)",
      _l18Mortos.length === 0, `ainda presentes: ${_l18Mortos.join(", ")}`);
    check("🧹 v199-L18 (estrutural): `vipExpiryWatchdog` não existe mais — era um `return` vazio agendado a cada 15min cujo comentário ainda prometia '10 automáticos/dia grátis', o oposto do 'ZERO envio grátis' em vigor desde o v172",
      !_l18WdCode.includes("vipExpiryWatchdog") && !_l18SrvCode.includes("vipExpiryWatchdog") &&
      !/10 autom[aá]ticos\/dia/.test(_l18Wd), "resquício de vipExpiryWatchdog encontrado");
    check("🧹 v199-L18 (estrutural): o Resumo Diário do Dono parou de AFIRMAR uma entrega que nunca aconteceu — o laço de envio era `for(const ae of ADMIN_EMAILS){}` com corpo VAZIO e o log escrevia 'Enviado aos admins' todo dia",
      !_l18SrvCode.includes("Enviado aos admins") && _l18SrvCode.includes("Resumo de ontem:") &&
      !/for\(const ae of ADMIN_EMAILS\)\{\s*\}/.test(_l18SrvCode),
      "o texto/laço do resumo diário ainda está lá");
    // O contrato do JSON não muda (respostas:0) — cliente antigo do painel e a
    // asserção histórica deste smoke dependem da FORMA da resposta.
    const _l18Res = await req2("POST", "/api/admin/resumo-diario-run", {});
    check("🧹 v199-L18: o resumo diário continua respondendo com a MESMA forma de sempre (incluindo `respostas`, agora sempre 0 — o app não lê caixa de entrada) e o log do robô diz a verdade",
      _l18Res.json?.ok === true && _l18Res.json?.respostas === 0 && typeof _l18Res.json?.envios === "number",
      JSON.stringify(_l18Res.json || {}).slice(0, 160));

    // ═══ 🇧🇷 v199 LOTE 17: português fixo — inclusive pra quem já ficou preso ═══
    // O README e o CLAUDE.md dizem "o app não tem seletor de idioma... é só em
    // português, de propósito". Só que o campo `language` aceitava pt|en|es e o
    // front aplicava cegamente o que viesse do /api/status: conta com 'en'
    // (legada do site antigo ou gravada por um POST direto) abria o site inteiro
    // em inglês SEM caminho de volta, porque nenhuma tela tem botão de idioma.
    // Corrigir só a porta de entrada deixaria essas contas presas PRA SEMPRE —
    // por isso a cura é migração de boot (a régua da casa: causa raiz, e o dado
    // já bugado é curado, nunca "conserta pra frente e esquece o passado").
    const _l17Disco = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8")); } catch { return {}; } };
    const _l17U = _l17Disco();
    check("🇧🇷 v199-L17: a migração de boot curou as contas presas em outro idioma — language='en' e 'pt-BR' viraram 'pt' NO DISCO (sem ela, quem já estava preso continuaria em inglês pra sempre)",
      _l17U["idiomaen@test.com"]?.language === "pt" && _l17U["idiomaptbr@test.com"]?.language === "pt",
      JSON.stringify({ en: _l17U["idiomaen@test.com"]?.language, ptbr: _l17U["idiomaptbr@test.com"]?.language }));
    const _l17LogMig = /idioma normalizado pra "pt" em \d+ conta/.test(log);
    check("🇧🇷 v199-L17: a migração de idioma LOGA quantas contas curou (migração muda dinheiro/acesso de ninguém, mas silenciosa ninguém audita)",
      _l17LogMig, "linha [migração] 🇧🇷 não apareceu no log do boot");
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "idiomaen@test.com" });
    const _l17Set = await req2("POST", "/api/settings", { language: "en" });
    const _l17St = await get("/api/status");
    const _l17Depois = _l17Disco();
    check("🇧🇷 v199-L17: /api/settings NÃO grava mais 'en'/'es' — a rota responde ok (cliente antigo em cache nunca vê erro), o /api/status continua dizendo 'pt' e o disco não mudou: não existe mais como ficar preso num idioma sem botão de volta",
      _l17Set.status === 200 && _l17St.json?.language === "pt" && _l17Depois["idiomaen@test.com"]?.language === "pt",
      JSON.stringify({ set: _l17Set.status, status: _l17St.json?.language, disco: _l17Depois["idiomaen@test.com"]?.language }));
    const _l17Pt = await req2("POST", "/api/settings", { language: "pt-BR" });
    check("🇧🇷 v199-L17: 'pt-BR' (o valor que TODA conta antiga carrega) continua sendo aceito e normalizado pra 'pt' — a chave do dicionário é de 2 letras",
      _l17Pt.status === 200 && _l17Disco()["idiomaen@test.com"]?.language === "pt", JSON.stringify({ status: _l17Pt.status }));
    // Os dicionários EN/ES ficam VIVOS (decisão do dono) — o que morreu foram as
    // chaves que nenhuma tela usa. Guarda nova: os 3 dicionários têm EXATAMENTE
    // o mesmo conjunto de chaves. Chave que nasce em 1 língua só é o buraco de
    // tradução que a guarda i18n-1 só pega quando a chave chega no HTML.
    const _l17Dict = (lang) => {
      const i = appJs.body.indexOf(`  ${lang}: {`), e = appJs.body.indexOf("\n  }", i);
      return [...appJs.body.slice(i, e).matchAll(/"([a-zA-Z_0-9]+)"\s*:/g)].map((m) => m[1]);
    };
    const _l17Pt2 = _l17Dict("pt"), _l17En = _l17Dict("en"), _l17Es = _l17Dict("es");
    const _l17SoPt = _l17Pt2.filter((k) => !_l17En.includes(k) || !_l17Es.includes(k));
    const _l17Sobra = [..._l17En, ..._l17Es].filter((k) => !_l17Pt2.includes(k));
    const _l17DupPt = _l17Pt2.filter((k, i2) => _l17Pt2.indexOf(k) !== i2);
    check(`🌐 v199-L17: os 3 dicionários têm o MESMO conjunto de chaves, sem duplicata (pt=${_l17Pt2.length} en=${_l17En.length} es=${_l17Es.length}) — chave duplicada é sobrescrita em silêncio pelo JS e chave que existe em 1 língua só é buraco de tradução`,
      _l17Pt2.length > 400 && _l17SoPt.length === 0 && _l17Sobra.length === 0 && _l17DupPt.length === 0,
      JSON.stringify({ soPt: _l17SoPt.slice(0, 5), sobra: _l17Sobra.slice(0, 5), dup: _l17DupPt.slice(0, 5) }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ⚙️ v199 LOTE 19: a versão do Node não pode ser 3 verdades diferentes.
    // O repo declarava engines ">=18", o CI roda 22 e o Render decide sozinho
    // (sem .node-version ele pode subir em outra major a qualquer momento) —
    // ou seja, o que a suíte prova NÃO é necessariamente o que atende o
    // cliente. Pinado no 22, que é o que o CI já prova a cada push.
    const _pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    const _nodeVer = fs.readFileSync(path.join(__dirname, ".node-version"), "utf8").trim();
    const _ci = fs.readFileSync(path.join(__dirname, ".github/workflows/ci.yml"), "utf8");
    const _ciNode = (_ci.match(/node-version:\s*(\d+)/) || [])[1];
    check(`⚙️ v199-L19: a major do Node é UMA só nos 3 lugares — .node-version (${_nodeVer}, é o que o Render honra), engines do package.json (${_pkg.engines?.node}) e o CI (${_ciNode})`,
      _nodeVer === _ciNode && _pkg.engines?.node === ">=" + _ciNode && _pkg.scripts?.["sw-bump"] === "node sw-bump.js",
      JSON.stringify({ nodeVersion: _nodeVer, engines: _pkg.engines?.node, ci: _ciNode, swBump: _pkg.scripts?.["sw-bump"] }));

    // ═══ 🔁 v199 LOTE 19: O 2º BOOT — o que este repo faz a cada commit ═══
    // A suíte sempre subiu o servidor UMA vez, num DATA_DIR recém-criado. Só
    // que este repo faz DEPLOY A CADA COMMIT: o boot que importa em produção é
    // o SEGUNDO, com o disco já sujo do primeiro. Nada provava que as ~15
    // migrações de boot são idempotentes (uma que reaplique mexe em dado real
    // de gente pagante) nem que o robô no meio de um envio sobrevive ao
    // reinício. Aqui o servidor é DERRUBADO de verdade (SIGTERM, esperando o
    // evento 'exit' — sem isso o próximo spawn bateria em porta ocupada e a
    // suíte falharia pelo motivo errado) e sobe de novo no MESMO DATA_DIR.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // 🩹 v221: título de vaga com código SOC cortado NA FONTE do DOL (achado
    // real do dono, 60 caracteres — largura clássica de campo antigo) só é
    // curado quando a planilha passa pelo BOOT (loadSheets), nunca no upload
    // em si — mesmo padrão do _selfHealCidades. Sobe a planilha ANTES do
    // restart (upload não cura) e confere DEPOIS (2º boot cura).
    await req2("POST", "/api/admin/sheet/upload", {
      name: "Titulo Teste", key: "titulo-teste", data: [
        { c: "H-400-TIT-0001", n: "Titulo LLC", s: "FLORIDA", e: "rh@titulo-teste.com", t: "49-9098: Helpers—Installation, Maintenance, and Repair Worke" },
        { c: "H-400-TIT-0002", n: "Titulo LLC 2", s: "TEXAS", e: "rh@titulo-teste2.com", t: "99-9999: Trabalhador Agricola de Colheita e Producao Sazonal" },
      ],
    });
    // Estado "no meio do caminho" ANTES do restart: um robô mandando (o caso
    // perigoso: o processo morre entre escolher a vaga e gravar) e outro
    // dormindo no limite diário.
    await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "boot2sending@test.com",
      job: { active: true, status: "sending", queue: [{ to: "rh@boot2-a.com", company: "Boot2 A" }, { to: "rh@boot2-b.com", company: "Boot2 B" }], source: "jan2026", startedAt: Date.now(), originalCount: 2 } });
    await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "boot2limite@test.com",
      job: { active: true, status: "waiting_limit", queue: [{ to: "rh@boot2-c.com", company: "Boot2 C" }], source: "jul2025", startedAt: Date.now(), originalCount: 1 } });
    // Pedido com ativação provisória viva (dinheiro na mesa) + sessão logada.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "boot2pedido@test.com", name: "Boot2 Pedido" });
    // (o gancho TESTE_COMPROVANTE é o mesmo padrão do feed falso do DOL: só
    // existe com TEST_LOGIN_TOKEN e faz a leitura do comprovante CONFERIR sem
    // tocar em rede — é o que liga a ativação provisória de verdade.)
    const _b2Ped = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true,
      userName: "Boot2 Pedido", userWhatsapp: "11 98888-0002", userCity: "SP", nota: "TESTE_COMPROVANTE:150",
      comprovante: Buffer.from("comprovante-boot2-unico").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const _b2PedId = _b2Ped.json?.pedidoId;
    await new Promise((r) => setTimeout(r, 500));
    const _b2StAntes = (await get("/api/status")).json;
    const _cookieAntes = COOKIE;

    // v209: handshakes de OAuth "no meio do caminho" — exatamente o estado
    // real que a Bíblia de Testes flagrou (clique em Conectar, o Render
    // reinicia ANTES da volta do Google, "Sessão OAuth inválida ou
    // expirada" sem culpa do usuário). __sender__ já sobrevivia; __notif__ e
    // __connectsend__ eram persistidos mas nunca RESTAURADOS (bug real).
    const _b2Notif = await req2("POST", "/api/test/notif-state", { token: TEST_TOKEN });
    const _b2CSend = await req2("POST", "/api/test/connectsend-state", { token: TEST_TOKEN });
    const _b2NotifId = "__notif__" + _b2Notif.json?.state;
    const _b2CSendId = "__connectsend__" + _b2CSend.json?.state;

    const _logAntes = log.length;
    const _morreuLimpo = await matarServidor(srv, "SIGTERM");
    check("🔁 v199-L19: o servidor desliga LIMPO com SIGTERM (o mesmo sinal do deploy do Render) — o processo sai sozinho dentro do teto, sem precisar de SIGKILL",
      _morreuLimpo === true, "o processo não saiu no tempo e precisou de SIGKILL — algum handle ficou pendurado no desligamento");
    srv = spawnServidor(ENV_SRV, (t) => (log += t));
    const _subiu2 = await waitUp(40_000);
    check("🔁 v199-L19: 2º boot no MESMO DATA_DIR (o que acontece a cada deploy deste repo) sobe e responde HTTP", _subiu2);
    // v209: prova o fix de raiz — os dois handshakes criados ANTES do SIGTERM
    // (no meio do caminho, exatamente como um clique real em "Conectar" que
    // o Render interrompe) sobrevivem ao restart e existem no 2º boot.
    const _b2NotifDepois = await get(`/api/test/session-exists?token=${TEST_TOKEN}&id=${encodeURIComponent(_b2NotifId)}`);
    const _b2CSendDepois = await get(`/api/test/session-exists?token=${TEST_TOKEN}&id=${encodeURIComponent(_b2CSendId)}`);
    check("🔁 v209: handshake __notif__ (Admin → Notificações → Conectar conta Google) sobrevive a um restart no meio do caminho — antes sumia e o admin via 'Sessão OAuth inválida ou expirada' sem motivo aparente",
      _b2NotifDepois.json?.exists === true, JSON.stringify(_b2NotifDepois.json));
    check("🔁 v209: handshake __connectsend__ (Conectar Gmail pra enviar) sobrevive a um restart no meio do caminho — mesmo bug que afetava a 1ª tentativa de conexão do usuário comum",
      _b2CSendDepois.json?.exists === true, JSON.stringify(_b2CSendDepois.json));
    const _log2 = log.slice(_logAntes);
    // Só os prefixos que significam APLICAÇÃO de migração — vários blocos
    // logam mesmo sem fazer nada, e casar com eles daria falso vermelho.
    const _reaplicou = [
      [/\[migração\] 🇧🇷 idioma normalizado/, "idioma → pt"],
      [/\[migração\] 🧾 \d+ comprovante\(s\) movidos/, "comprovantes pro disco"],
      [/\[migração\] 🔓 lista de banidos ZERADA/, "lista de banidos"],
      [/\[migração\] 🧹 backup\.json aposentado removido/, "backup.json aposentado"],
      [/\[cv-blobs\] ✅ \d+ usuário\(s\) migrados/, "PDFs pro disco"],
      [/\[perfil-por-visto\] ✅ Migração concluída: [1-9]/, "perfil por visto"],
      [/\[cv-dedup\] ✅ Limpeza concluída: [1-9]/, "dedupe de currículo"],
      [/\[db\] Migrando /, "renome de arquivo legado"],
      [/\[migrate\] ✅ .* copiado para/, "planilha enriquecida pro /data"],
    ].filter(([re]) => re.test(_log2)).map(([, nome]) => nome);
    check("🔁 v199-L19: NENHUMA migração de boot reaplica no 2º boot — todas as ~15 são idempotentes de verdade (uma que reaplicasse mexeria de novo em dado de gente pagante a cada deploy)",
      _reaplicou.length === 0, `reaplicaram: ${_reaplicou.join(", ")}`);
    // 🩹 v221: o 2º boot é exatamente o que cura o título cortado — confere
    // AGORA, com a planilha lida do disco de verdade (loadSheets real, não o
    // upload em memória de antes do restart).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _tRows = (await get("/api/admin/sheet/download/titulo-teste")).json || [];
    const _t1 = _tRows.find((r) => r.c === "H-400-TIT-0001") || {};
    const _t2 = _tRows.find((r) => r.c === "H-400-TIT-0002") || {};
    check("🩹 v221: título de vaga com código SOC VERIFICADO (49-9098) e cortado na fonte do DOL é completado no boot com a grafia oficial BLS/O*NET — 'Worke' vira 'Workers', sem mexer no resto da linha",
      _t1.t === "49-9098: Helpers--Installation, Maintenance, and Repair Workers" && _t1.n === "Titulo LLC" && _t1.e === "rh@titulo-teste.com",
      JSON.stringify(_t1));
    check("🩹 v221: título com a MESMA assinatura de corte (60 caracteres, prefixo SOC) mas código SEM grafia oficial verificada NUNCA é adivinhado — fica exatamente como veio, só vira aviso no log pro admin conferir",
      _t2.t === "99-9999: Trabalhador Agricola de Colheita e Producao Sazonal",
      JSON.stringify(_t2));
    check("🩹 v221 (estrutural): o boot registra os 2 casos no log — 1 completado de verdade e 1 sinalizado pra revisão manual (nunca em silêncio)",
      /\[sheet\] 🩹 .*1 título\(s\) de vaga completado\(s\)/.test(_log2) && /\[sheet\] 🔎 .*prefixo SOC 99-9999/.test(_log2),
      _log2.split("\n").filter((l) => l.includes("[sheet]") && (l.includes("🩹") || l.includes("🔎"))).slice(0, 5).join(" | "));
    // O robô no meio do caminho não pode sumir nem perder fila.
    const _b2A = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "boot2sending@test.com" });
    const _b2B = await req2("POST", "/api/test/auto-job", { token: TEST_TOKEN, email: "boot2limite@test.com" });
    check("🔁 v199-L19: o robô sobrevive ao reinício com a FILA INTEIRA — o job que estava 'sending' (processo morto no meio de um envio) e o que dormia em 'waiting_limit' voltam com as mesmas vagas na fila",
      (_b2A.json?.job?.queue || []).length === 2 && (_b2B.json?.job?.queue || []).length === 1 &&
      _b2A.json?.job?.source === "jan2026" && _b2B.json?.job?.source === "jul2025",
      JSON.stringify({ sending: _b2A.json?.job?.status, fila: (_b2A.json?.job?.queue || []).length, limite: _b2B.json?.job?.status }));
    // Dinheiro na mesa: o pedido provisório continua pendente e ativo.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "boot2pedido@test.com" });
    const _b2Lista = await get("/api/pedidos");
    const _b2Achado = (_b2Lista.json?.pedidos || []).find((x) => x.id === _b2PedId);
    const _b2St = await get("/api/status");
    check("🔁 v199-L19: o pedido com ativação provisória atravessa o deploy inteiro — continua PENDENTE na mesa do admin e o cliente continua com o plano ativo (era exatamente o cenário 'paguei e o site reiniciou')",
      _b2StAntes?.needsPlan === false && !!_b2Achado && _b2Achado.status === "pendente" && _b2St.json?.needsPlan === false,
      JSON.stringify({ antes: _b2StAntes?.needsPlan, pedido: _b2Achado?.status, depois: _b2St.json?.needsPlan, id: _b2PedId }));
    // Sessão de LOGIN cai de propósito (decisão do dono, ver _loadSessionsFromDisk).
    check("🔁 v199-L19: a sessão de login NÃO sobrevive ao reinício — e isso é DE PROPÓSITO (todos entram de novo a cada deploy); o log do boot declara a decisão em vez de deixar parecer bug",
      /\[sessions\] 🔒 Deploy detectado/.test(_log2),
      "o boot não declarou mais o descarte das sessões de login");
    COOKIE = _cookieAntes;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 💾 v199 LOTE 19: o modo que roda EM PRODUÇÃO (SQLite dual-write) ═══
    // A suíte inteira roda com STORAGE=json — o modo que o storage.js chama de
    // "antigo". Em produção o padrão é SQLite com espelho JSON, e o motivo
    // declarado dele é justamente acabar com o JSON truncado numa queda. Ou
    // seja: o caminho que guarda o dinheiro dos clientes nunca era exercitado.
    // Servidor próprio, disco próprio, e um restart pra provar que o que foi
    // gravado no banco volta.
    {
      const DATA_S = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-sqlite-"));
      const PORT_S = PORT + 60;
      let logS = "", srvS = null;
      const reqS = (method, p2, payload) => new Promise((resolve, reject) => {
        const body = payload === undefined ? null : JSON.stringify(payload);
        const r = http.request(`http://127.0.0.1:${PORT_S}` + p2, { method,
          headers: { ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
          let b = ""; res.on("data", (c) => (b += c));
          res.on("end", () => { let json2 = null; try { json2 = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json: json2 }); });
        });
        r.on("error", reject); if (body) r.write(body); r.end();
      });
      try {
        // JSONs legados no disco ANTES do 1º boot — são eles que o storage
        // tem que IMPORTAR pro banco na primeira execução.
        fs.writeFileSync(path.join(DATA_S, "users.json"), JSON.stringify({
          "sqlite@test.com": { email: "sqlite@test.com", name: "SQLite ORIGINAL", plan: "free", created_at: new Date().toISOString(), cvs: [], profiles: [], saved: [], onboarded: true },
        }));
        fs.writeFileSync(path.join(DATA_S, "pedidos.json"), JSON.stringify([
          { id: "pedsqlite1", userEmail: "sqlite@test.com", userName: "SQLite ORIGINAL", tipo: "plano", plano: "vip", dias: 30, valorTotal: 100, status: "pendente", createdAt: Date.now() }]));
        // SEM STORAGE=json de propósito — este é o único boot da suíte no modo de produção.
        srvS = spawnServidor({ PORT: String(PORT_S), DATA_DIR: DATA_S, TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890" }, (t) => (logS += t));
        const _upS = await esperarNoAr(() => reqS("GET", "/api/status"), 40_000);
        const _sqliteIndisponivel = /SQLite indispon[ií]vel/.test(logS);
        if (_sqliteIndisponivel) {
          // HONESTO: pular com aviso, nunca falso-verde. `node:sqlite` existe a
          // partir do Node 22.5 (e este repo pina o 22 no .node-version); se o
          // ambiente não tiver nem ele nem o better-sqlite3 opcional, o servidor
          // cai pro JSON sozinho — comportamento correto, mas não é o que este
          // bloco quer provar.
          console.log("  ⏭️  v199-L19: modo SQLite PULADO — nem node:sqlite nem better-sqlite3 neste ambiente (o servidor caiu pro JSON, que é o fallback correto). Rode com Node >= 22.5 pra exercitar o modo de produção.");
          check("💾 v199-L19: sem SQLite no ambiente, o servidor cai pro JSON e continua servindo (fallback do storage.js)", _upS === true, "nem no fallback o servidor subiu");
        } else {
          check("💾 v199-L19: boot no modo de PRODUÇÃO (SQLite + espelho JSON, sem STORAGE=json) sobe e cria o h2bapply.db — o caminho que guarda o dinheiro dos clientes nunca tinha sido exercitado pela suíte",
            _upS === true && /SQLite ativo/.test(logS) && fs.existsSync(path.join(DATA_S, "h2bapply.db")),
            `up=${_upS} db=${fs.existsSync(path.join(DATA_S, "h2bapply.db"))} log=${(logS.match(/\[storage\][^\n]*/g) || []).join(" | ").slice(0, 200)}`);
          check("💾 v199-L19: os JSONs que já existiam no disco foram IMPORTADOS pro banco na 1ª execução (migração automática do storage.js), sem ninguém perder nada",
            /⬆️\s+Migrado/.test(logS), (logS.match(/\[storage\][^\n]*/g) || []).join(" | ").slice(0, 240));
          // Grava pelo servidor, reinicia, e confere que o dado volta.
          await reqS("POST", "/api/test/login", { token: TEST_TOKEN, email: "sqlitenovo@test.com", name: "SQLite NOVO" });
          await matarServidor(srvS, "SIGTERM");
          logS = "";
          srvS = spawnServidor({ PORT: String(PORT_S), DATA_DIR: DATA_S, TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890" }, (t) => (logS += t));
          const _upS2 = await esperarNoAr(() => reqS("GET", "/api/status"), 40_000);
          const _stS2 = await reqS("POST", "/api/test/login", { token: TEST_TOKEN, email: "sqlitenovo@test.com" });
          check("💾 v199-L19: o que foi gravado no modo SQLite VOLTA depois de um restart — a conta criada antes do desligamento continua lá (e o usuário do JSON importado também)",
            _upS2 === true && _stS2.status === 200 && !/SQLite indispon/.test(logS),
            `up=${_upS2} status=${_stS2.status}`);
        }
      } catch (e) {
        check("💾 v199-L19: drill do modo SQLite sem exceção", false, e.message);
      } finally {
        try { await matarServidor(srvS, "SIGKILL"); } catch {}
        try { fs.rmSync(DATA_S, { recursive: true, force: true }); } catch {}
      }
    }

    // 🛟 v191 LOTE 9 — drill de restauração de backup (servidor e disco só dele)
    await drillRestauracaoBackup();

    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });

    // v209/v210 (achados reais da Bíblia de Testes, 19/09/2026):
    // (a) admin via "Grátis"/"Sem plano ativo" no card de status e no badge
    // do Perfil enquanto o Admin→Usuários mostrava doublepro — o card lia
    // só vip.manualExpires/autoExpires, sem saber que isAdminVip() já
    // libera tudo sem precisar desses relógios.
    // (b) badge de vaga "Ativa"/"Inativa" violava a regra 0.2 (nenhum
    // status de vaga pro usuário — enriquecimento é 1x só e nunca
    // reconferido, então "ativa/inativa" vira mentira com o tempo).
    const _appV209 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    check("🔁 v209: planLabelAtivo()/renderPlanStatusCard()/planBadgeHTML() tratam U.isAdmin ANTES de concluir 'Grátis' — admin não lê vip.manualExpires/autoExpires pra saber se tem acesso",
      /function planLabelAtivo\(\)\{[\s\S]{0,800}if\(U\.isAdmin\)/.test(_appV209) &&
      /if\(!hasManual&&!hasAuto&&U\.isAdmin\)/.test(_appV209) &&
      (_appV209.match(/if\(!hasManual&&!hasAuto&&U\.isAdmin\)/g) || []).length >= 2,
      "algum dos 3 lugares (label/card/badge) voltou a concluir 'Grátis' só pelos relógios de VIP, sem checar admin");
    check("🔁 v210: nenhum badge 'Ativa'/'Inativa' de vaga sobrou em app.js (regra 0.2 — nem badge, nem menção de status de vaga pro usuário)",
      !/Ativa<\/span>['"`]?:['"`]?<span class="tag tr">/.test(_appV209) && !_appV209.includes("Ativa</span>':'<span class=\"tag tr\">") &&
      !/\{j\.active\?['"`]<span class="tag tg">/.test(_appV209) && !/\{job\.active\?['"`]<span class="tag tg">/.test(_appV209),
      "achou algum resquício de badge Ativa/Inativa condicionado em .active");

    // 🚨 v213 (bug real, achado ao vivo pelo dono depois do v210: Envio Manual
    // 100% quebrado — clique em qualquer vaga da aba "ao vivo" do DOL nunca
    // abria o detalhe). Causa raiz: mkCard() (loadJobs, aba ao vivo) tinha o
    // `>` de fechamento da tag <div class="jcard"...> comido pelo ternário
    // do style="display:none" — o browser nunca fechava o card, os filhos
    // (título/empresa/tags) viravam IRMÃOS soltos dentro de #jlist em vez de
    // aninhados no card clicável, e o onclick nunca era alcançado. Bug
    // PRÉ-EXISTENTE (não veio do v209/v210 — confirmado no histórico da
    // sessão que já lia essa linha quebrada antes de qualquer edição de
    // hoje), só ficou perto o bastante do trecho tocado pro dono desconfiar.
    // Guarda genérica: mkSheetCard() tem que fechar a tag <div class="jcard"...>
    // com `>` ANTES da 1ª quebra de linha do template — nunca deixar o `>`
    // cair pro meio dos atributos seguintes. (v223: mkCard()/selJob2() da aba
    // ao vivo saíram do site — só mkSheetCard() continua existindo.)
    check("🚨 v213 (estrutural): mkSheetCard() fecha a tag <div class=\"jcard\"...> com '>' antes da 1ª quebra de linha — nunca mais um card de vaga nasce sem fechar a tag de abertura (bug real: clique nunca abria o detalhe, filhos viravam irmãos soltos em #jlist)",
      /onclick="selSheetJob\('\$\{esc\(j\.id\)\}'\)" role="button" tabindex="0"\$\{\(isApplied\|\|_inAutoQ\)\?' style="display:none"':""\}>/.test(_appV209),
      "a tag de abertura do card voltou a ficar sem '>' antes da quebra de linha");

    // 🚨 v237o (achado de auditoria — Média, admin/PWA): o atalho "Vagas H-2B"
    // do manifest.json apontava pra /?tab=seasonal — "seasonal" nunca existiu
    // em VIEWS (a aba "ao vivo" saiu no v223) e sv() não validava o valor: o
    // loop que liga/desliga `.gone` compara "id!==v" pra CADA view conhecida,
    // e como nenhuma bate com "seasonal" TODAS ganhavam `.gone` — o app
    // inteiro sumia, tela em branco, sem erro nenhum pro usuário. Corrigido
    // na raiz em sv() (nunca deixa `v` fora de VIEWS chegar no loop — cai pra
    // "home") E no manifest.json (o atalho aponta pra "jobs", a aba de vagas
    // de verdade).
    const _manifestV237o = fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8");
    // (a mesma string "VIEWS.forEach(id=>{const ve=g(\"#v-\"+id)" também
    // aparece no handler de popstate, MAIS CEDO no arquivo — por isso a
    // busca do loop começa a partir da posição da guarda, não do começo do
    // arquivo, pra achar o loop de DENTRO de sv(), não o outro.)
    const _posGuardaV237o = _appV209.indexOf('if(!VIEWS.includes(v))');
    const _posLoopV237o = _appV209.indexOf('VIEWS.forEach(id=>{const ve=g("#v-"+id)', _posGuardaV237o);
    check("🚨 v237o: sv() nunca deixa uma view DESCONHECIDA (atalho do manifest.json quebrado, link velho em cache, ?tab= digitado errado) apagar TODAS as views da tela — cai pra 'home' antes do loop que liga/desliga `.gone`",
      /if\(!VIEWS\.includes\(v\)\)\{[\s\S]{0,120}v="home"/.test(_appV209) &&
      _posGuardaV237o > -1 && _posLoopV237o > -1 && (_posLoopV237o - _posGuardaV237o) < 700,
      `guarda em ${_posGuardaV237o}, loop de sv() em ${_posLoopV237o} (distância ${_posLoopV237o - _posGuardaV237o})`);
    check("🚨 v237o: o atalho \"Vagas H-2B\" do manifest.json (PWA) aponta pra /?tab=jobs (aba real) — não sobrou nenhum /?tab=seasonal (aba que nunca existiu em VIEWS)",
      _manifestV237o.includes('"url": "/?tab=jobs"') && !_manifestV237o.includes("seasonal"),
      "manifest.json ainda referencia uma aba inexistente");

    // 🚨🚨 v237r (URGENTE, ordem direta do dono, 20/09/2026): "eu preciso de
    // um botão pra sair da ADM e voltar pra página normal, sem deslogar" +
    // "o usuário tem que ter lá embaixo um botão de sair da conta também".
    // (1) index.html: a sidebar do dashboard comum não tinha NENHUM botão
    // de logout direto no rodapé — só escondido dentro da aba Meu Perfil
    // (regra 14: menu só com o essencial, mas isso tinha ido longe demais).
    // (2) admin.html: só existia "Sair" (fazerLogout — chama /api/disconnect
    // e destrói a sessão de verdade) — sem jeito de voltar pro site normal
    // SEM deslogar. Painel admin e site normal usam a MESMA sessão/cookie
    // (os 2 chamam o mesmo /api/disconnect pra sair de verdade), então
    // "voltar sem deslogar" é só navegar pra "/" sem tocar em sessão nenhuma
    // — voltarSiteNormal() faz exatamente isso, nunca chama /api/disconnect.
    const _idxV237r = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const _admV237r = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
    check("🚨 v237r: a sidebar do dashboard comum (index.html) tem um botão \"Sair\" direto no rodapé (onclick=confirmLogout()) — antes só existia escondido dentro da aba Meu Perfil",
      /onclick="confirmLogout\(\)"[\s\S]{0,120}<i class="ti ti-logout">/.test(_idxV237r.slice(_idxV237r.indexOf('id="sb-prof"'))),
      "não achou o botão Sair logo depois do cartão de perfil na sidebar");
    check("🚨 v237r: admin.html tem 2 botões DISTINTOS no rodapé da sidebar — \"Voltar ao site\" (voltarSiteNormal, NUNCA chama /api/disconnect) e \"Sair\" (fazerLogout, chama /api/disconnect) — nunca confundidos",
      /class="sb-back" onclick="voltarSiteNormal\(\)"/.test(_admV237r) &&
      /class="sb-logout" onclick="fazerLogout\(\)"/.test(_admV237r) &&
      /function voltarSiteNormal\(\)\{\s*location\.href="\/";\s*\}/.test(_admV237r.replace(/\n/g, " ")),
      "algum dos 2 botões sumiu, ou voltarSiteNormal() não é a navegação simples esperada");
    check("🚨 v237r (estrutural, negativo): voltarSiteNormal() NUNCA chama /api/disconnect — senão viraria um 2º jeito de deslogar disfarçado de 'voltar'",
      (() => { const m = _admV237r.match(/function voltarSiteNormal\(\)\{[^}]*\}/); return !!m && !m[0].includes("disconnect"); })(),
      "voltarSiteNormal() ganhou uma chamada a /api/disconnect — deixaria de ser 'voltar sem deslogar'");

    // 🧹 v237s (achado de auditoria — Média/Baixa, admin): /api/admin/set-
    // auto-limit gravava u.customAutoLimit e job.lockedAutoLimit, mas NENHUM
    // dos 2 campos era lido em lugar nenhum (getAutoLimit() explicitamente
    // NÃO usa lockedAutoLimit — comentário próprio já dizia isso — e
    // customAutoLimit não aparecia em nenhuma outra linha do arquivo) e
    // NENHUMA tela do admin.html chamava essa rota — o admin clicando
    // "definir limite" (se algum dia existisse botão) teria a falsa
    // impressão de que mudou algo, sem efeito nenhum de verdade. Removida
    // por completo (rota código morto, nunca chamada por ninguém).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const _v237sDel = await req2("POST", "/api/admin/set-auto-limit", { email: "v237alvo@test.com", limit: 999 });
    check("🧹 v237s: /api/admin/set-auto-limit foi removida (404) — código morto que gravava campos que nada lia (getAutoLimit() nunca usa lockedAutoLimit/customAutoLimit)",
      _v237sDel.status === 404,
      `status=${_v237sDel.status} body=${_v237sDel.body.slice(0, 120)}`);
    check("🧹 v237s (estrutural): server.js não tem mais nenhum resquício de customAutoLimit (campo morto, sem leitor em lugar nenhum)",
      !fs.readFileSync(path.join(__dirname, "server.js"), "utf8").includes("customAutoLimit"),
      "customAutoLimit ainda aparece em server.js");

    // 🚨 v237t (achado de auditoria — Baixa, auth): /api/disconnect não
    // exigia POST — o cookie é SameSite=Lax (vai numa navegação de TOPO
    // mesmo vinda de outro site), então uma página maliciosa com só um
    // <a href="…/api/disconnect"> deslogava qualquer usuário em silêncio,
    // sem clique em botão nenhum do H2BApply. Prova real: login de teste,
    // confirma sessão viva (/api/status), tenta GET em /api/disconnect
    // (deve ser recusado, sessão continua viva), depois POST de verdade
    // (aí sim desloga) — as 2 chamadas do front (doLogout/fazerLogout) já
    // mandam method:"POST" explicitamente desde este mesmo lote.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "v237t@test.com", name: "V237T" });
    const _v237tAntes = await get("/api/status");
    const _v237tGet = await req2("GET", "/api/disconnect");
    const _v237tDepoisGet = await get("/api/status");
    const _v237tPost = await req2("POST", "/api/disconnect");
    const _v237tDepoisPost = await get("/api/status");
    check("🚨 v237t: GET em /api/disconnect é RECUSADO (nunca 200) e a sessão continua logada — antes qualquer método deslogava, inclusive uma navegação de topo vinda de outro site (cookie SameSite=Lax)",
      _v237tAntes.json?.connected === true && _v237tGet.status !== 200 &&
      _v237tDepoisGet.json?.connected === true,
      `antes=${_v237tAntes.json?.connected} getStatus=${_v237tGet.status} depoisGet=${_v237tDepoisGet.json?.connected}`);
    check("🚨 v237t: POST em /api/disconnect continua funcionando normalmente (desloga de verdade) — a trava é só de MÉTODO, o logout real não quebrou",
      _v237tPost.status === 200 && _v237tPost.json?.ok === true && _v237tDepoisPost.json?.connected !== true,
      `post=${_v237tPost.status} depoisPost=${_v237tDepoisPost.json?.connected}`);

    // 🔶 v215 (dono, 19/09/2026 — domínio migrado de verdade pra cá):
    // estrutural — o banner "já era assinante VIP?" pro site antigo
    // (h2bapply.onrender.com) é SEMPRE visível (nunca condicionado a
    // U.newPurchasesBlocked), aparece na aba Planos E no Painel/Home, bem
    // chamativo (cor contrastante — classe .vip-old-banner), e é um <a>
    // explícito (clique do usuário), nunca JS de auto-redirect.
    const _idxV214 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    check("🔶 v215 estrutural: banner 'já era assinante VIP?' pro site antigo aparece 2x (Planos + Home/Painel), sempre com a classe chamativa .vip-old-banner e link explícito pro h2bapply.onrender.com — nunca window.location automático",
      (_idxV214.match(/class="vip-old-banner"/g) || []).length >= 2 &&
      (_idxV214.match(/href="https:\/\/h2bapply\.onrender\.com"/g) || []).length >= 2 &&
      !/h2bapply\.onrender\.com[\s\S]{0,120}location\.(href|assign|replace)/.test(_idxV214),
      `ocorrências vip-old-banner=${(_idxV214.match(/class="vip-old-banner"/g) || []).length} onrender=${(_idxV214.match(/href="https:\/\/h2bapply\.onrender\.com"/g) || []).length}`);
    // 🔶 v215b (dono, 19/09/2026, mesmo dia): o mesmo aviso, mas na LANDING
    // (pré-login) — visitante que já era VIP bate o olho ANTES de decidir
    // Entrar/Criar conta, logo abaixo da navbar. Bem chamativo (.ln-oldsite-
    // banner, cor contrastante, pulso sutil), <a> explícito, nunca redirect
    // automático.
    check("🔶 v215b estrutural: landing (pré-login) tem o banner 'já era assinante VIP?' logo abaixo da navbar, chamativo (.ln-oldsite-banner) e com link explícito pro h2bapply.onrender.com — nunca auto-redirect",
      /class="ln-oldsite-banner"/.test(_idxV214) &&
      /<nav class="ln-nav">[\s\S]{0,1200}<a href="https:\/\/h2bapply\.onrender\.com"[^>]*class="ln-oldsite-banner"/.test(_idxV214) &&
      !/ln-oldsite-banner[\s\S]{0,200}location\.(href|assign|replace)/.test(_idxV214),
      "banner da landing sumiu, saiu do lugar (depois da navbar) ou virou auto-redirect");
    check("🚧 estrutural: loadPlanos() troca o banner de manutenção pelo seletor de compra lendo SEMPRE U.newPurchasesBlocked (nunca decide sozinho no front) — e applyStatus() propaga o campo vindo do /api/status",
      /if\(U\.newPurchasesBlocked\)\{/.test(_appV209) &&
      /newPurchasesBlocked:!!d\.newPurchasesBlocked/.test(_appV209),
      "o gate de U.newPurchasesBlocked sumiu de loadPlanos() ou applyStatus() parou de propagar o campo");

    // 🚧 A suíte principal (SEM BLOCK_NEW_PURCHASES, igual produção real
    // hoje — domínio já migrado) precisa continuar vendendo normal: prova
    // que /api/status NÃO marca newPurchasesBlocked por padrão.
    const _stSemBloqueio = await get("/api/status");
    check("🚧 /api/status NÃO bloqueia compra por padrão (interruptor de emergência desligado — é o estado real de produção desde que o domínio migrou pra cá)",
      _stSemBloqueio.json?.newPurchasesBlocked === false || _stSemBloqueio.json?.newPurchasesBlocked === undefined,
      JSON.stringify(_stSemBloqueio.json?.newPurchasesBlocked));

    // 🚧 Drill isolado (servidor próprio, COM BLOCK_NEW_PURCHASES=true)
    // provando que o interruptor de emergência, se algum dia for ligado,
    // recusa de verdade no backend — ver função acima.
    await drillBloqueioComprasNovas();

    // 🎬 v237v (dono, 20/09/2026 — vídeo de verificação do Google/gmail.send +
    // demo de compra pro Andrio): conta de TESTE única (ndrkick.3@gmail.com,
    // TEST_ACCOUNT_EMAIL/mod-config.js) — comprovante FAKE aceito só nela
    // (sem OCR), confirmação manual do admin NUNCA pulada, e nada disso pode
    // contar como dinheiro real em nenhuma tela financeira.
    {
      const _testeEmail = "ndrkick.3@gmail.com";
      await req2("POST", "/api/admin-panel/login", { user: "andrio", password: "teste-smoke-andrio-2026" });
      const _memAntes = await req2("GET", "/api/admin/memoria");
      const _donoAntes = await req2("GET", "/api/admin/dono-resumo");
      const _pagAntes = await req2("GET", "/api/admin/pagantes");
      const _pagAntesN = (_pagAntes.json?.rows || []).filter(r => r.email === _testeEmail).length;

      const _pedTeste = await req2("POST", "/api/pedido", {
        userEmail: _testeEmail, plano: "vip", dias: 30,
        userName: "Conta de Teste (vídeo)", userWhatsapp: "11 90000-0000", userCity: "SP",
        comprovante: Buffer.from("isso-nao-e-um-comprovante-de-verdade-so-um-print-qualquer").toString("base64"),
        comprovanteType: "image/jpeg", pagoEm: Date.now(),
      });
      check("🎬 v237v: pedido da conta de TESTE é criado normalmente (comprovante fake aceito)",
        _pedTeste.status === 200 && !!_pedTeste.json?.pedidoId,
        JSON.stringify(_pedTeste.json));
      const _pedTesteId = _pedTeste.json?.pedidoId;

      const _pedTesteDetalhe = await req2("GET", "/api/pedido/" + _pedTesteId);
      check("🎬 v237v: o pedido sai marcado isTeste:true e continua PENDENTE (a confirmação manual do admin NUNCA é pulada — só o comprovante é facilitado)",
        _pedTesteDetalhe.json?.pedido?.isTeste === true && _pedTesteDetalhe.json?.pedido?.status === "pendente",
        JSON.stringify({ isTeste: _pedTesteDetalhe.json?.pedido?.isTeste, status: _pedTesteDetalhe.json?.pedido?.status }));
      check("🎬 v237v: comprovante FAKE (bytes quaisquer, sem foto de pagamento real) vira CONFERE sem OCR só nessa conta — bate com o valor do próprio pedido",
        _pedTesteDetalhe.json?.pedido?.preCheck?.veredito === "CONFERE" &&
        Math.abs((_pedTesteDetalhe.json?.pedido?.preCheck?.valorLido || 0) - (_pedTesteDetalhe.json?.pedido?.valorTotal || -1)) < 0.01 &&
        /conta de teste/i.test(_pedTesteDetalhe.json?.pedido?.preCheck?.resumo || ""),
        JSON.stringify(_pedTesteDetalhe.json?.pedido?.preCheck));

      const _confirmaTeste = await req2("PATCH", "/api/pedido/" + _pedTesteId, { status: "ativo", recebidoPor: "andrio" });
      check("🎬 v237v: admin CONFIRMA manualmente o pedido de teste (exatamente como um pedido real) e o plano é ativado",
        _confirmaTeste.status === 200 && _confirmaTeste.json?.ok === true,
        JSON.stringify(_confirmaTeste.json));

      const _memDepois = await req2("GET", "/api/admin/memoria");
      check("🎬 v237v: confirmar o pedido de teste NÃO cria NENHUMA entrada no caixa (DB_FINANCEIRO.pagamentos) — contagem bruta idêntica antes/depois",
        _memDepois.json?.bancos?.pagamentos === _memAntes.json?.bancos?.pagamentos,
        `antes=${_memAntes.json?.bancos?.pagamentos} depois=${_memDepois.json?.bancos?.pagamentos}`);

      const _donoDepois = await req2("GET", "/api/admin/dono-resumo");
      check("🎬 v237v: receita/pendentes da Visão do Dono (computeEntradasJanelas) ficam EXATAMENTE iguais antes/depois de confirmar um pedido de R$ real pra conta de teste",
        JSON.stringify(_donoDepois.json?.entradas) === JSON.stringify(_donoAntes.json?.entradas) &&
        _donoDepois.json?.pendentes?.valor === _donoAntes.json?.pendentes?.valor,
        JSON.stringify({ antes: _donoAntes.json?.entradas, depois: _donoDepois.json?.entradas }));

      const _pagDepois = await req2("GET", "/api/admin/pagantes");
      const _pagDepoisN = (_pagDepois.json?.rows || []).filter(r => r.email === _testeEmail).length;
      check("🎬 v237v: a conta de teste NUNCA aparece na lista de Pagantes, mesmo com plano ativo de verdade",
        _pagAntesN === 0 && _pagDepoisN === 0,
        `antes=${_pagAntesN} depois=${_pagDepoisN}`);

      const _confConf = await req2("GET", "/api/admin/conferencia");
      const _naConferencia = (_confConf.json?.rows || []).some(r => r.id === _pedTesteId);
      check("🎬 v237v: o pedido de teste NÃO aparece na Conferência (relatório de todos os pagamentos) nem gera divergência",
        !_naConferencia,
        JSON.stringify((_confConf.json?.rows || []).find(r => r.email === _testeEmail)));

      const _pedidosAdmin = await req2("GET", "/api/pedidos");
      const _apareceNormal = (_pedidosAdmin.json?.pedidos || []).some(p => p.id === _pedTesteId);
      check("🎬 v237v: o pedido de teste continua aparecendo NORMALMENTE na listagem de pedidos do admin — só o dinheiro é isolado, nunca a visibilidade (o admin precisa achar e confirmar pelo painel de sempre)",
        _apareceNormal === true,
        "pedido de teste sumiu de /api/pedidos");

      // 🔒 negativo: o MESMO truque (comprovante qualquer, sem GEMINI_API_KEY
      // configurada neste ambiente) NUNCA funciona pra um e-mail comum —
      // a exceção é hardcoded num único e-mail, nunca um padrão geral.
      const _pedNormalFake = await req2("POST", "/api/pedido", {
        userEmail: "usuarionormal237v@test.com", plano: "vip", dias: 30,
        userName: "Usuário Normal", userWhatsapp: "11 90000-0000", userCity: "SP",
        comprovante: Buffer.from("mesmo-truque-mas-com-email-normal-nao-e-a-conta-de-teste").toString("base64"),
        comprovanteType: "image/jpeg", pagoEm: Date.now(),
      });
      const _pedNormalDetalhe = await req2("GET", "/api/pedido/" + _pedNormalFake.json?.pedidoId);
      check("🔒 v237v: o MESMO comprovante fake NÃO vira CONFERE pra um e-mail comum (fica honestamente sem leitura, como sempre) — a exceção nunca vira padrão geral",
        _pedNormalDetalhe.json?.pedido?.isTeste !== true && _pedNormalDetalhe.json?.pedido?.preCheck == null,
        JSON.stringify({ isTeste: _pedNormalDetalhe.json?.pedido?.isTeste, preCheck: _pedNormalDetalhe.json?.pedido?.preCheck }));
    }

    // 🎬 v238c (dono, 20/09/2026 — trocou de conta na hora de gravar o vídeo:
    // "decidiu gravar... usando a própria conta real dele
    // (andrio.kick18@gmail.com)"): 2º e-mail de teste (TEST_ACCOUNT_EMAIL_2,
    // mod-config.js) — MESMA régua exata do v237v acima, provando que
    // isTestAccountEmail generalizado cobre os 2 e-mails ao mesmo tempo
    // (não é um "trocou de 1 pra outro" — os 2 continuam valendo juntos).
    {
      const _teste2Email = "andrio.kick18@gmail.com";
      const _donoAntes2 = await req2("GET", "/api/admin/dono-resumo");
      const _pagAntes2 = await req2("GET", "/api/admin/pagantes");
      const _pagAntes2N = (_pagAntes2.json?.rows || []).filter(r => r.email === _teste2Email).length;

      const _pedTeste2 = await req2("POST", "/api/pedido", {
        userEmail: _teste2Email, plano: "vip", dias: 30,
        userName: "Conta de Teste 2 (vídeo)", userWhatsapp: "11 90000-0001", userCity: "SP",
        comprovante: Buffer.from("segundo-print-fake-conta-de-teste-v238c").toString("base64"),
        comprovanteType: "image/jpeg", pagoEm: Date.now(),
      });
      check("🎬 v238c: pedido do 2º e-mail de teste (andrio.kick18@gmail.com) é criado normalmente",
        _pedTeste2.status === 200 && !!_pedTeste2.json?.pedidoId,
        JSON.stringify(_pedTeste2.json));
      const _pedTeste2Id = _pedTeste2.json?.pedidoId;

      const _pedTeste2Detalhe = await req2("GET", "/api/pedido/" + _pedTeste2Id);
      check("🎬 v238c: o pedido do 2º e-mail sai isTeste:true, PENDENTE, e o comprovante fake vira CONFERE sem OCR — exatamente a régua do 1º e-mail",
        _pedTeste2Detalhe.json?.pedido?.isTeste === true &&
        _pedTeste2Detalhe.json?.pedido?.status === "pendente" &&
        _pedTeste2Detalhe.json?.pedido?.preCheck?.veredito === "CONFERE",
        JSON.stringify({ isTeste: _pedTeste2Detalhe.json?.pedido?.isTeste, status: _pedTeste2Detalhe.json?.pedido?.status, veredito: _pedTeste2Detalhe.json?.pedido?.preCheck?.veredito }));

      const _confirmaTeste2 = await req2("PATCH", "/api/pedido/" + _pedTeste2Id, { status: "ativo", recebidoPor: "andrio" });
      check("🎬 v238c: admin confirma manualmente o pedido do 2º e-mail de teste (confirmação humana nunca pulada)",
        _confirmaTeste2.status === 200 && _confirmaTeste2.json?.ok === true,
        JSON.stringify(_confirmaTeste2.json));

      const _donoDepois2 = await req2("GET", "/api/admin/dono-resumo");
      check("🎬 v238c: confirmar o pedido do 2º e-mail de teste NÃO move a receita/pendentes da Visão do Dono — isolamento financeiro idêntico ao 1º e-mail",
        JSON.stringify(_donoDepois2.json?.entradas) === JSON.stringify(_donoAntes2.json?.entradas) &&
        _donoDepois2.json?.pendentes?.valor === _donoAntes2.json?.pendentes?.valor,
        JSON.stringify({ antes: _donoAntes2.json?.entradas, depois: _donoDepois2.json?.entradas }));

      const _pagDepois2 = await req2("GET", "/api/admin/pagantes");
      const _pagDepois2N = (_pagDepois2.json?.rows || []).filter(r => r.email === _teste2Email).length;
      check("🎬 v238c: o 2º e-mail de teste NUNCA aparece em Pagantes, mesmo com plano ativo de verdade",
        _pagAntes2N === 0 && _pagDepois2N === 0,
        `antes=${_pagAntes2N} depois=${_pagDepois2N}`);

      const _confConf2 = await req2("GET", "/api/admin/conferencia");
      const _naConferencia2 = (_confConf2.json?.rows || []).some(r => r.id === _pedTeste2Id);
      check("🎬 v238c: o pedido do 2º e-mail de teste NÃO aparece na Conferência",
        !_naConferencia2,
        JSON.stringify((_confConf2.json?.rows || []).find(r => r.email === _teste2Email)));

      const _pedTeste1Regressao = await req2("POST", "/api/pedido", {
        userEmail: "ndrkick.3@gmail.com", plano: "vip", dias: 30,
        userName: "Conta de Teste 1 (regressão)", userWhatsapp: "11 90000-0000", userCity: "SP",
        comprovante: Buffer.from("terceiro-print-fake-regressao-v238c").toString("base64"),
        comprovanteType: "image/jpeg", pagoEm: Date.now(),
      });
      const _pedTeste1RegressaoDetalhe = await req2("GET", "/api/pedido/" + _pedTeste1Regressao.json?.pedidoId);
      check("🎬 v238c: o 1º e-mail de teste (ndrkick.3@gmail.com) continua funcionando junto com o 2º — generalizar isTestAccountEmail não quebrou o original",
        _pedTeste1RegressaoDetalhe.json?.pedido?.isTeste === true &&
        _pedTeste1RegressaoDetalhe.json?.pedido?.preCheck?.veredito === "CONFERE",
        JSON.stringify(_pedTeste1RegressaoDetalhe.json?.pedido?.preCheck));
    }

    // 🎬 v237v-FIX (achado real, revisão pré-gravação do vídeo — o teste
    // acima usava o override de admin `userEmail`, que grava targetEmail
    // como o PRÓPRIO e-mail literal e mascarava o bug de verdade): pd.
    // userEmail é a CHAVE de login — username pra conta NOVA (v172c, nunca
    // tem @) — nunca o Gmail de contato. Sem resolver emailContato,
    // isTestAccountEmail(username) NUNCA bate, e um AUTOCADASTRO real com
    // ndrkick.3@gmail.com como e-mail de contato NUNCA virava isTeste:true
    // — exatamente o risco que o Andrio (via este chat) apontou antes de
    // gravar o vídeo. Prova de ponta a ponta pelo fluxo REAL (cadastro →
    // login automático → autocheckout, sem NENHUM override de admin).
    {
      const _outboxPath237v = path.join(DATA, "notif_outbox.json");
      const _lerOutbox237v = () => { try { return JSON.parse(fs.readFileSync(_outboxPath237v, "utf8")); } catch { return []; } };
      const _ultimoCodigo237v = (to, tipo) => { const m = _lerOutbox237v().filter((x) => x.to === to && x.tipo === tipo).pop(); const c = m && String(m.text || "").match(/^(\d{6})$/m); return c ? c[1] : null; };
      const _emailTesteReal = "ndrkick.3@gmail.com";

      const _envCod = await req2("POST", "/api/email/enviar-codigo", { email: _emailTesteReal });
      const _codigo = _ultimoCodigo237v(_emailTesteReal.toLowerCase(), "codigo_cadastro");
      const _conf = await req2("POST", "/api/email/confirmar", { email: _emailTesteReal, codigo: _codigo });
      const _tokenCadastro = _conf.json?.token;
      check("🎬 v237v-FIX: fluxo de cadastro normal (código por e-mail) funciona pra ndrkick.3@gmail.com igual pra qualquer usuário — a conta de teste NÃO é especial no cadastro, só no comprovante",
        _envCod.status === 200 && !!_codigo && !!_tokenCadastro,
        JSON.stringify({ envio: _envCod.status, temCodigo: !!_codigo, temToken: !!_tokenCadastro }));

      const _usernameEscolhido = "contadetestev237v";
      const _cad = await req2("POST", "/api/cadastro", {
        username: _usernameEscolhido, password: "12345678", nome: "Conta", sobrenome: "De Teste",
        dataNascimento: "01/01/1995", cidade: "Recife", estado: "PE", pais: "Brasil",
        whatsapp: "5581999999999", email: _emailTesteReal, emailToken: _tokenCadastro,
      });
      check("🎬 v237v-FIX: cadastro real cria a conta com USERNAME escolhido como identidade de login (nunca o Gmail) — exatamente o cenário que expõe o bug se a resolução por emailContato estiver quebrada",
        _cad.status === 200 && _cad.json?.username === _usernameEscolhido,
        JSON.stringify(_cad.json));

      // Autocheckout — SEM userEmail override nenhum: targetEmail vem de
      // s.user_email (a sessão que o cadastro acabou de logar), exatamente
      // como vai acontecer quando o Andrio clicar em "Comprar" logado como
      // essa conta.
      const _pedReal = await req2("POST", "/api/pedido", {
        plano: "vip", dias: 30, consentimento: true,
        userName: "Conta De Teste", userWhatsapp: "5581999999999", userCity: "Recife",
        comprovante: Buffer.from("print-qualquer-fluxo-real-de-autocheckout").toString("base64"),
        comprovanteType: "image/jpeg", pagoEm: Date.now(),
      });
      check("🎬 v237v-FIX: autocheckout (sem override de admin) cria o pedido normalmente",
        _pedReal.status === 200 && !!_pedReal.json?.pedidoId,
        JSON.stringify(_pedReal.json));

      await req2("POST", "/api/admin-panel/login", { user: "andrio", password: "teste-smoke-andrio-2026" });
      const _pedRealDetalhe = await req2("GET", "/api/pedido/" + _pedReal.json?.pedidoId);
      check("🚨 v237v-FIX (achado real, corrigido ANTES do vídeo): o pedido do AUTOCHECKOUT sai com userEmail = USERNAME de login (nunca o Gmail) mas isTeste:true mesmo assim — a resolução por emailContato funciona; sem o fix, isTeste ficava false pra SEMPRE nesse fluxo",
        _pedRealDetalhe.json?.pedido?.userEmail === _usernameEscolhido &&
        _pedRealDetalhe.json?.pedido?.userEmail !== _emailTesteReal &&
        _pedRealDetalhe.json?.pedido?.isTeste === true &&
        _pedRealDetalhe.json?.pedido?.preCheck?.veredito === "CONFERE",
        JSON.stringify({ userEmail: _pedRealDetalhe.json?.pedido?.userEmail, isTeste: _pedRealDetalhe.json?.pedido?.isTeste, veredito: _pedRealDetalhe.json?.pedido?.preCheck?.veredito }));

      const _memAntesFix = await req2("GET", "/api/admin/memoria");
      const _donoAntesFix = await req2("GET", "/api/admin/dono-resumo");
      const _confirmaReal = await req2("PATCH", "/api/pedido/" + _pedReal.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
      check("🎬 v237v-FIX: admin confirma o pedido do autocheckout normalmente",
        _confirmaReal.status === 200 && _confirmaReal.json?.ok === true,
        JSON.stringify(_confirmaReal.json));
      const _memDepoisFix = await req2("GET", "/api/admin/memoria");
      const _donoDepoisFix = await req2("GET", "/api/admin/dono-resumo");
      check("🚨 v237v-FIX: confirmar o pedido do AUTOCHECKOUT real também não cria entrada no caixa nem move a receita da Visão do Dono — o isolamento financeiro cobre o fluxo de verdade, não só o override de admin usado no teste anterior",
        _memDepoisFix.json?.bancos?.pagamentos === _memAntesFix.json?.bancos?.pagamentos &&
        JSON.stringify(_donoDepoisFix.json?.entradas) === JSON.stringify(_donoAntesFix.json?.entradas),
        JSON.stringify({ pagAntes: _memAntesFix.json?.bancos?.pagamentos, pagDepois: _memDepoisFix.json?.bancos?.pagamentos, entAntes: _donoAntesFix.json?.entradas, entDepois: _donoDepoisFix.json?.entradas }));

      const _pagREAL = await req2("GET", "/api/admin/pagantes");
      check("🎬 v237v-FIX: a conta criada pelo cadastro real (username ≠ Gmail) também não aparece em Pagantes",
        !(_pagREAL.json?.rows || []).some(r => r.email === _usernameEscolhido || r.email === _emailTesteReal),
        JSON.stringify((_pagREAL.json?.rows || []).find(r => r.email === _usernameEscolhido)));
    }

    // 🎬 v237x (dono, 20/09/2026 — "eu nunca digito senha em nenhum campo,
    // nem mesmo autopreenchida"): link mágico de entrada na conta de
    // teste, por e-mail — sem login por Google (v172b) e sem senha,
    // era o único jeito de o Andrio entrar como ndrkick.3@gmail.com pra
    // gravar o vídeo. Prova de ponta a ponta: visitar a URL manda o
    // e-mail, o link do e-mail troca por sessão de VERDADE, o link não
    // funciona 2 vezes, e um e-mail QUALQUER na query string é ignorado
    // (o alvo é sempre TEST_ACCOUNT_EMAIL, nunca escolhido por quem pede).
    {
      const _outboxPath237x = path.join(DATA, "notif_outbox.json");
      const _lerOutbox237x = () => { try { return JSON.parse(fs.readFileSync(_outboxPath237x, "utf8")); } catch { return []; } };

      const _pedeLink = await get("/entrar-conta-teste?email=atacante@teste-alheio.com");
      check("🎬 v237x: GET /entrar-conta-teste manda o link SEMPRE pro TEST_ACCOUNT_EMAIL — um e-mail alheio na query string é ignorado por completo (rota nunca lê e-mail de fora)",
        _pedeLink.status === 200 && /Link enviado/.test(_pedeLink.body) && /ndrkick\.3@gmail\.com/.test(_pedeLink.body),
        _pedeLink.body.slice(0, 200));

      const _emailLink = _lerOutbox237x().filter(x => x.to === "ndrkick.3@gmail.com" && x.tipo === "login_conta_teste").pop();
      const _tokenLink = _emailLink && String(_emailLink.text || "").match(/\/entrar-teste\?t=([a-f0-9]+)/);
      check("🎬 v237x: o e-mail de verdade chega com o link de entrada (mesmo mecanismo de outbox usado por todo o resto do site em teste)",
        !!_tokenLink, JSON.stringify(_emailLink?.subject));

      const _entrou = await req2("GET", "/entrar-teste?t=" + (_tokenLink ? _tokenLink[1] : "invalido"));
      check("🎬 v237x: clicar no link troca por uma sessão de LOGIN de verdade (302 com Set-Cookie, sem passar por senha nenhuma)",
        _entrou.status === 302 && String(_entrou.headers?.location || "").includes("tab=plans") && /h2b_session=/.test(_entrou.headers?.["set-cookie"]?.join(";") || ""),
        `status=${_entrou.status} location=${_entrou.headers?.location || ""}`);

      const _statusPosLogin = await req2("GET", "/api/status");
      check("🚨 v237x: a sessão criada pelo link é da CONTA DE TESTE de verdade (emailContato bate, isAdmin false) — nunca vira admin nem outra conta",
        _statusPosLogin.json?.connected === true && _statusPosLogin.json?.emailContato === "ndrkick.3@gmail.com" && _statusPosLogin.json?.isAdmin === false,
        JSON.stringify({ connected: _statusPosLogin.json?.connected, emailContato: _statusPosLogin.json?.emailContato, isAdmin: _statusPosLogin.json?.isAdmin }));

      const _reuso = await req2("GET", "/entrar-teste?t=" + (_tokenLink ? _tokenLink[1] : "invalido"));
      check("🔒 v237x: o MESMO link não funciona 2 vezes (uso único de verdade — token some da memória no primeiro uso)",
        _reuso.status === 302 && String(_reuso.headers?.location || "").includes("err="),
        `status=${_reuso.status} location=${_reuso.headers?.location || ""}`);

      const _tokenInventado = await get("/entrar-teste?t=" + "a".repeat(48));
      check("🔒 v237x: um token INVENTADO (nunca emitido) nunca vira sessão — redireciona com erro, sem cookie nenhum",
        _tokenInventado.status === 302 && String(_tokenInventado.headers?.location || "").includes("err=") && !_tokenInventado.headers?.["set-cookie"],
        `status=${_tokenInventado.status} location=${_tokenInventado.headers?.location || ""}`);
    }

    const disk = fs.readdirSync(path.join(DATA, "cvs"));
    check("PDFs válidos gravados no disco", disk.includes("cliente@test.com_1002.pdf") && disk.includes("cliente@test.com_1004.pdf"),
      disk.join(", "));
    check("PDF órfão varrido do disco", !disk.includes("fantasma@test.com_777.pdf"));
    const pdf = fs.readFileSync(path.join(DATA, "cvs", "cliente@test.com_1004.pdf"), "utf8");
    check("conteúdo do PDF íntegro (%PDF)", pdf.startsWith("%PDF"));
  } catch (e) {
    check("execução sem exceção", false, e.message);
  } finally {
    srv.kill("SIGKILL");
    try { feedSrv.close(); } catch {}
    try { googleSrv.close(); } catch {}
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  }

  if (failed) {
    console.log(`\n❌ ${failed} verificação(ões) FALHARAM. Últimas linhas do servidor:`);
    console.log(log.split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  console.log("\n✅ Smoke test 100% verde — seguro pra deploy.");
  process.exit(0);
})();
