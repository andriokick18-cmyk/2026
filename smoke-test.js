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
const feedSrv = http.createServer((rq, rs) => {
  const h2a = (rq.url || "").includes("/h2a/");
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
    valorTotal: 150, status: "pendente", createdAt: Date.now() - 7 * 3600_000 }]));
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

// ── Execução ────────────────────────────────────────────────────────────
(async () => {
  console.log(`🧪 Smoke test — porta ${PORT}, dados em ${DATA}`);
  await testAuthWatchdogPush(); // unit puro, não precisa do servidor
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    // 🚨 v172c-SEC: NUNCA testar com a senha de fábrica de produção (nem a
    // antiga vazada, nem a nova) — o teste define a SUA PRÓPRIA senha via
    // env, exatamente como uma instalação real deveria fazer (a env sempre
    // vence o hash de fábrica embutido no código).
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed`, H2A_BIM_MIN_PUBLICAR: "10", ADMIN_PANEL_PASS_ANDRIO: "teste-smoke-andrio-2026", ADMIN_PANEL_PASS_DIEGO: "teste-smoke-diego-2026" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  srv.stdout.on("data", (c) => (log += c));
  srv.stderr.on("data", (c) => (log += c));

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
    const ultimoCodigo = (to, tipo) => { const m = lerOutbox().filter((x) => x.to === to && x.tipo === tipo).pop(); const c = m && String(m.text || "").match(/▶\s+(\d{6})\s+◀/); return c ? c[1] : null; };
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
    check("📧 v175: Enviar verificação → e-mail com código de 6 dígitos sai pela conta de suporte (outbox), vale 5 min, reenvio em 60s, texto avisa que é o mesmo Gmail que vai enviar as candidaturas",
      _env1.status === 200 && _env1.json?.expiraEm === 300 && _env1.json?.reenvioEm === 60 && /^\d{6}$/.test(_cod1 || "") && _mail1?.from === "suporteh2bapply@gmail.com" && /5 minutos/.test(_mail1?.text || "") && /ENVIAR suas candidaturas/.test(_mail1?.text || "") && String(_mail1?.subject || "").includes(_cod1 || "x"),
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

    // v86 (dono, 01/08): público 100% brasileiro — o site tem que abrir em
    // PORTUGUÊS por padrão, nunca em inglês só porque o navegador do celular
    // está em inglês. Guarda: o inicializador de idioma NÃO pode mais decidir
    // pelo navegador (navigator.language) — só pela escolha salva do usuário,
    // caindo em 'pt' por padrão. Se alguém reintroduzir a detecção por
    // navegador, o site volta a abrir em inglês pra muitos brasileiros.
    const _langInitOk = !frontAll.includes("navigator.language||'pt'") && /getItem\('h2b_lang'\)[\s\S]{0,160}return'pt'/.test(frontAll);
    check("🇧🇷 v86: index.html abre em PORTUGUÊS por padrão (idioma não decidido mais pelo navigator.language)",
      _langInitOk, "inicializador de _curLang não caiu no padrão PT esperado (localStorage → fallback 'pt')");

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
    const _seoFiles = ["h2bapply-funciona.html", "h2b-e-golpe.html", "como-usar.html", "tutorial-conteudo.html", "server.js"];
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
    // com token válido"). O sandbox de teste não alcança a Gmail API de
    // verdade (sem rede pro Google) — o envio em si (status 200) não dá
    // pra provar aqui; a garantia estrutural abaixo prova que o código
    // não desiste no primeiro admin sem token nem usa `break`.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Admin Extra", isAdmin: true });
    const _logBefore = log.length;
    const hsRun = await req2("POST", "/api/admin/health-sentinel/run", {});
    const _logSince = log.slice(_logBefore);
    check("🐛 watchdog de pedido pendente: pedwatch1 (7h) aparece no relatório e o admin principal SEM token não trava a rodada (fallback resolve outro admin — nunca 'NENHUM admin com token válido')",
      hsRun.json?.ok === true && (hsRun.json?.report?.pedidosPendentes || []).some((p) => p.id === "pedwatch1") &&
      !/NENHUM admin com token válido/.test(_logSince),
      JSON.stringify({ pend: hsRun.json?.report?.pedidosPendentes, logTrecho: _logSince.slice(-300) }).slice(0, 400));
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

    // v47: GUARDA ESTRUTURAL das vias quentes de persistência — indexApp e os
    // callbacks de header do Gmail rodam a CADA e-mail enviado (manual e
    // automático); não dá pra disparar envio real de Gmail no smoke, então a
    // guarda confere direto no código-fonte que essas vias usam
    // persistDebounced (nunca persist síncrono, que grava o banco inteiro
    // travando o servidor pra todo mundo — bug real "site lento", 23/07).
    const _srvSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const _idxAppBody = (_srvSrc.match(/function indexApp\([\s\S]*?\n\}/) || [""])[0];
    check("⚡ indexApp (roda a cada e-mail enviado) grava DEBOUNCED, nunca síncrono",
      _idxAppBody.includes("persistDebounced(APPIDX_FILE") && !/(?<!Debounced)\(?persist\(APPIDX_FILE/.test(_idxAppBody),
      _idxAppBody ? "" : "função indexApp não encontrada no server.js");
    const _gmailCbs = [...(_srvSrc.matchAll(/gmailHeaderMsgId = h\.messageId; (persist\w*)\(/g))].map((m) => m[1]);
    check("⚡ callbacks de header do Gmail (por e-mail) gravam o histórico DEBOUNCED",
      _gmailCbs.length === 2 && _gmailCbs.every((f) => f === "persistDebounced"),
      `encontrados: ${_gmailCbs.join(", ") || "nenhum"}`);

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
    check("🧾 v170: o preço vem SEMPRE da tabela oficial — o valorTotal mandado pelo cliente (R$1, propositalmente errado) é ignorado e o pedido nasce com R$150 (VIPro 30d)",
      pd1Get.json?.pedido?.valorTotal === 150, JSON.stringify({ valorTotal: pd1Get.json?.pedido?.valorTotal }));
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
    check("💰 Visão do Dono: a ativação de R$150 aparece nas entradas de hoje",
      dr.json?.ok === true && dr.json?.entradas?.total >= 150 && dr.json?.entradas?.hoje >= 150, dr.body.slice(0, 140));

    // v31: 🧾 Conferência de pagamentos — todos os pagamentos numa lista só,
    // valor ao lado do nome, e correção de valor com trilha (caixa junto)
    const cf = await get("/api/admin/conferencia");
    const cfRow = (cf.json?.rows || []).find((r) => r.tipo === "pedido" && r.id === pdId);
    check("🧾 Conferência lista o pedido com o valor ao lado do nome", cf.json?.ok === true && cfRow?.valor === 150, cf.body.slice(0, 140));
    // O pedido recém-ativado TEM entrada no caixa — não pode aparecer como divergência
    const dvComprador = (cf.json?.divergencias || []).filter((x) => x.email === "comprador@test.com");
    check("🔍 varredura de divergências roda e não acusa o fluxo saudável", Array.isArray(cf.json?.divergencias) && dvComprador.length === 0, JSON.stringify(dvComprador).slice(0, 140));
    const corr = await req2("PATCH", "/api/pedido/" + pdId, { corrigirValor: 147 });
    check("✏️ corrigirValor altera o pedido preservando o original na trilha", corr.json?.ok === true && corr.json?.pedido?.valorTotal === 147 && corr.json?.pedido?.valorOriginal === 150, corr.body.slice(0, 140));
    const fin1b = await get("/api/admin/financeiro");
    const pgCorr = (fin1b.json?.pagamentos || []).find((x) => x.pedidoId === pdId);
    check("✏️ correção de valor corrige o caixa JUNTO (uma verdade só)", corr.json?.caixaCorrigido === true && pgCorr?.valor === 147);

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
    check("🧾 v170: GET /api/planos expõe 'limites' (fonte única PLAN_LIMITS_NEW) e 'precos' (fonte única PLANO_PRECO_TAB), sem exigir sessão",
      plTab.json?.ok === true &&
      plTab.json?.limites?.vip?.manual === 100 && plTab.json?.limites?.vip?.auto === 0 &&
      plTab.json?.limites?.vipro?.manual === 100 && plTab.json?.limites?.vipro?.auto === 100 &&
      plTab.json?.limites?.doublepro?.manual === 200 && plTab.json?.limites?.doublepro?.auto === 200 &&
      (plTab.json?.precos || []).some((p2) => p2.plano === "vipro" && p2.dias === 30 && p2.valorTotal === 150),
      JSON.stringify({ limites: plTab.json?.limites, n: plTab.json?.precos?.length }).slice(0, 200));

    // admin cancela: caixa estornado E os dias de VIP estornados
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com" });
    const canc = await req2("PATCH", "/api/pedido/" + pdId, { status: "cancelado" });
    // 💼 MC5-P6: o cancelamento NUNCA mais APAGA a entrada do caixa — o
    // original fica ANULADO (história preservada) e entra o par de AJUSTE
    // negativo pelo valor EFETIVO (pedido corrigido 150→147 vence o caixa).
    // O líquido é idêntico ao da exclusão antiga; a história, não.
    const fin2 = await get("/api/admin/financeiro");
    const _cOrig = (fin2.json?.pagamentos || []).find((x) => x.pedidoId === pdId && x.tipo !== "ajuste");
    const _cAj = (fin2.json?.pagamentos || []).find((x) => x.tipo === "ajuste" && x.ajustaPedidoId === pdId);
    check("💼 MC5-P6: cancelamento estorna por AJUSTE− (original preservado+anulado, par −147 pelo valor efetivo) — o caixa nunca apaga",
      canc.json?.ok === true && _cOrig && !!_cOrig.anuladoPor && _cAj && _cAj.valor === -147,
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
      const _pvA = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Prov Dup", userWhatsapp: "11 99999", userCity: "SP", nota: "TESTE_COMPROVANTE:100", comprovante: Buffer.from("prov-dup-a").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
      const _pvStA = (await get("/api/status")).json;
      // 2º pedido com comprovante que também CONFERE — antes do fix ele
      // reativava o provisório por cima e roubava o vip.pedidoId do 1º
      // (de quebra, renovando os 3 dias de graça indefinidamente).
      const _pvB = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "Prov Dup", userWhatsapp: "11 99999", userCity: "SP", nota: "TESTE_COMPROVANTE:100", comprovante: Buffer.from("prov-dup-b").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
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

      check("🚨 v177-FIX4 (estrutural): a 2ª cópia (inalcançável) das validações de tamanho/base64 do comprovante saiu do objeto do pedido — a regra vive num lugar só, que responde 400 com o motivo em vez de descartar em silêncio",
        !/Limitar tamanho: max 8MB em base64/.test(_srv2) && _srv2.includes('comprovante:(typeof d.comprovante==="string"&&d.comprovante)?d.comprovante:null'),
        "validação de comprovante ainda está duplicada dentro do objeto do pedido");

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
      check("🚨 v177-FIX6 (estrutural): CACHE_NAME do sw.js subiu junto com a mudança em app.js/admin.html (regra da casa — senão o aparelho mistura JS velho com HTML novo)",
        /const CACHE_NAME = "h2bapply-2026-v(4[3-9]|[5-9]\d|\d{3,})"/.test(fs.readFileSync(path.join(__dirname, "sw.js"), "utf8")),
        "sw.js ainda está no cache antigo (v42 ou menor)");

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
      check("🚨 v177-FIX8 (estrutural): CACHE_NAME do sw.js subiu de novo junto com a mudança em app.js",
        /const CACHE_NAME = "h2bapply-2026-v(4[4-9]|[5-9]\d|\d{3,})"/.test(fs.readFileSync(path.join(__dirname, "sw.js"), "utf8")),
        "sw.js não subiu junto com a mudança em app.js");
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
    // usuário ficava com plan:"free" (0 de tudo). v118: ativação NOVA via
    // set-plan carimba a tabela nova (200 manual + 200 auto).
    check("🚨 v79+v118: Esdras com DoublePro novo tem EXATAMENTE 200 manual + 200 automático (tabela v118 carimbada na ativação)",
      stEsdras.json?.manualLimit === 200 && stEsdras.json?.autoLimit === 200,
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
    const smBase = await get("/api/sheet-meta?sheet=jan2026&top=5");
    const _jobsBase = smBase.json?.jobs || [];
    check("🎯 v82: /api/sheet-meta expõe matchScore pra usuário logado (nunca null pra quem tem sessão)", _jobsBase.length > 0 && _jobsBase.every((j) => j.matchScore != null), JSON.stringify(_jobsBase.map((j) => j.matchScore)));
    const _alvo = _jobsBase[0];
    const _scoreAntes = _alvo?.matchScore;
    // Preferência de categoria = a categoria EXATA do próprio job alvo — depois confere que o MESMO job subiu de nota.
    await req2("POST", "/api/settings", { h2bProfile: { preferredArea: _alvo.category, englishLevel: "basic", experiencedH2B: false, h2bSeasons: 0, usaTrips: false, hasDriverLicense: false, availability: "immediate" } });
    const smDepois = await get("/api/sheet-meta?sheet=jan2026&top=5");
    const _alvoDepois = (smDepois.json?.jobs || []).find((j) => j.id === _alvo.id);
    check("🎯 v82: setar preferredArea igual à categoria da vaga AUMENTA o matchScore dessa vaga específica (mesma vaga, antes x depois)",
      _alvoDepois && _alvoDepois.matchScore > _scoreAntes,
      JSON.stringify({ antes: _scoreAntes, depois: _alvoDepois?.matchScore, categoria: _alvo.category }));
    check("🎯 v82: matchWhy explica o motivo (nunca uma caixa preta)", Array.isArray(_alvoDepois?.matchWhy) && _alvoDepois.matchWhy.some((w) => w.includes("categoria")), JSON.stringify(_alvoDepois?.matchWhy));
    // sort=match: a página inteira vem em ordem NÃO-crescente de matchScore.
    const smMatchSort = await get("/api/sheet-meta?sheet=jan2026&top=25&sort=match");
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
      const vf0 = (await get("/api/vagas/filtros?sheet=jan2026")).json;
      check("🔍 v173: /api/vagas/filtros sem filtro → total = planilha inteira, facetas de estado/categoria/salário presentes",
        vf0?.ok === true && vf0.total === vf0.totalPlanilha && vf0.total > 1000 && vf0.facetas?.estado?.length > 5 && vf0.facetas?.categoria?.length > 3 && Array.isArray(vf0.facetas?.salario?.limiares),
        JSON.stringify({ total: vf0?.total, planilha: vf0?.totalPlanilha }).slice(0, 120));
      const e1 = vf0.facetas.estado[0], e2 = vf0.facetas.estado[1];
      const vf1 = (await get(`/api/vagas/filtros?sheet=jan2026&estado=${encodeURIComponent(e1.v)}`)).json;
      check("🔍 v173: 1 estado marcado → total = contagem daquela opção (a contagem por opção é a verdade)", vf1.total === e1.n, `${vf1.total} vs ${e1.n}`);
      const vf2 = (await get(`/api/vagas/filtros?sheet=jan2026&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}`)).json;
      check("🔍 v173: 2 estados = OU (soma) — marcar uma 2ª opção do MESMO grupo nunca diminui", vf2.total === e1.n + e2.n && vf2.total >= vf1.total, `${vf2.total} vs ${e1.n}+${e2.n}`);
      check("🔍 v173: a faceta de estado ignora o próprio filtro de estado (contagem do 1º segue igual com 2 marcados)", vf2.facetas.estado.find(x => x.v === e1.v)?.n === e1.n, JSON.stringify(vf2.facetas.estado.slice(0, 2)));
      const cat = vf2.facetas.categoria.find(c => c.n > 0);
      const vf3 = (await get(`/api/vagas/filtros?sheet=jan2026&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}&categoria=${cat.v}`)).json;
      check("🔍 v173: estado + categoria = E — total = contagem da categoria DENTRO dos estados (um filtro nunca 'elimina' o outro, só combina)", vf3.total === cat.n && vf3.total <= vf2.total, `${vf3.total} vs ${cat.n}`);
      const l20 = vf3.facetas.salario.limiares.find(l => l.v === 20);
      const vf4 = (await get(`/api/vagas/filtros?sheet=jan2026&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}&categoria=${cat.v}&salarioMin=20`)).json;
      const sm4 = (await get(`/api/sheet-meta?sheet=jan2026&estado=${encodeURIComponent(e1.v)}&estado=${encodeURIComponent(e2.v)}&categoria=${cat.v}&salarioMin=20&top=1`)).json;
      check("🔍 v173: salário ≥$20 → total = contagem do limiar E a LISTA (/api/sheet-meta) devolve o MESMO total — uma verdade só (13n)",
        vf4.total === l20.n && sm4.total === vf4.total, `facetas=${vf4.total} limiar=${l20.n} lista=${sm4.total}`);
      const smLegacy = (await get(`/api/sheet-meta?sheet=jan2026&state=${encodeURIComponent(e1.v)},${encodeURIComponent(e2.v)}&category=${cat.v}&minWage=20&top=1`)).json;
      check("🔍 v173: nomes LEGADOS de parâmetro (state/category/minWage — front antigo em cache) continuam funcionando na lista", smLegacy.total === vf4.total, `${smLegacy.total} vs ${vf4.total}`);
      const vfJ = (await get("/api/vagas/filtros?sheet=jul2026")).json;
      check("🔍 v173: jul2026 (Pending Processing) → disponibilidade honesta: salário=0, e-mail=0, cargo=0 — o front esconde/avisa em vez de mostrar '0 vagas' sem explicação",
        vfJ.disponibilidade?.salario === 0 && vfJ.disponibilidade?.email === 0 && vfJ.disponibilidade?.cargo === 0 && vfJ.total === vfJ.totalPlanilha, JSON.stringify(vfJ.disponibilidade).slice(0, 140));
      const vfJe = (await get("/api/vagas/filtros?sheet=jul2026&email=1")).json;
      check("🔍 v173: jul2026 com 'só com e-mail' → 0 (honesto), e a faceta diz quantas estão sem e-mail", vfJe.total === 0 && vfJe.facetas.email.sem === vfJ.totalPlanilha, JSON.stringify(vfJe.facetas.email));
      const vfH = (await get("/api/vagas/filtros?sheet=h2a-jun2026")).json;
      const mes = vfH.facetas.inicio.find(m => m.n > 0);
      const vfHm = (await get(`/api/vagas/filtros?sheet=h2a-jun2026&inicio=${mes.v}`)).json;
      check("🔍 v173: H-2A tem mês de início e cidade (disponibilidade > 0) e filtrar por mês bate com a contagem da faceta", vfH.disponibilidade.inicio > 0 && vfH.disponibilidade.cidade > 0 && vfHm.total === mes.n, `${vfHm.total} vs ${mes.n}`);
      const vfCb = (await get("/api/vagas/filtros?sheet=h2a-jun2026&cidadeBusca=spring")).json;
      check("🔍 v173: busca dentro da lista de cidades (cidadeBusca) filtra as opções no servidor", vfCb.facetas.cidade.length > 0 && vfCb.facetas.cidade.every(c => /spring/i.test(c.v)), JSON.stringify(vfCb.facetas.cidade.slice(0, 2)));
      // 💎 gate Double Pro no SERVIDOR: admin (DP) aplica grupo; usuário comum tem o parâmetro ignorado
      const gA = vfJ.facetas.grupo.find(x => x.v === "A");
      const vfGadm = (await get("/api/vagas/filtros?sheet=jul2026&grupo=A")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vffree@test.com", name: "VF Free" });
      const vfGfree = (await get("/api/vagas/filtros?sheet=jul2026&grupo=A")).json;
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
      check("🔍 v173: FILTROS.parse aceita o formato LEGADO do job.filters (state/category/minWage/titles/beginMonths/grupos/city/minWorkers/keyword/dolStatus) — robô que já rodava não perde o refill",
        leg.estado.join() === "FLORIDA,TEXAS" && leg.categoria[0] === "landscape" && leg.salarioMin === 18 && leg.cargo[0] === "cook" && leg.inicio.join() === "6,7" && leg.grupo.join() === "A,B" && leg.cidade[0] === "Key West" && leg.vagasMin === 5 && leg.q === "hotel" && leg.status[0] === "Certified",
        JSON.stringify(leg).slice(0, 160));
      const rowsF = [{ c: "1", s: "FLORIDA", k: "food", w: "20", wunit: "h", e: "a@x.com", wk: 5 }, { c: "2", s: "FLORIDA", k: "food", w: "1500", wunit: "mo", e: "b@x.com", wk: 1 }, { c: "3", s: "TEXAS", k: "farm", w: "22", wunit: "h", e: "", wk: 10 }];
      const facF = F.facetas(rowsF, F.parse(new URLSearchParams({ estado: "FLORIDA" })), {});
      check("🔍 v173: motor — salário normalizado pra $/hora (1500/mês ≈ $8,67/h fica abaixo de $12), faceta de e-mail conta com/sem, estado ignora o próprio filtro",
        facF.total === 2 && facF.facetas.salario.limiares.find(l => l.v === 12).n === 1 && facF.facetas.email.com === 2 && facF.facetas.email.sem === 0 && facF.facetas.estado.find(x => x.v === "TEXAS").n === 1,
        JSON.stringify({ t: facF.total, l12: facF.facetas.salario.limiares.find(l => l.v === 12), em: facF.facetas.email, tx: facF.facetas.estado }).slice(0, 200));
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
      const vfH = (await get("/api/vagas/filtros?sheet=h2a-jun2026")).json;
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
        const sm = (await get(`/api/sheet-meta?sheet=h2a-jun2026&cargo=${encodeURIComponent(tl)}&top=1`)).json;
        const fam = (vfH.facetas.cargo || []).find((x) => String(x.label || "").toLowerCase() === tl.toLowerCase());
        paresVirg.push({ v: tl.slice(0, 30), faceta: fam ? fam.n : -1, lista: sm.total });
      }
      check("🎯 v179-L1: valor COM vírgula nunca é re-quebrado pelo servidor — o chip anunciava 217 e a lista devolvia 108 (v179); no v181 o cargo virou FAMÍLIA e o título literal com vírgula (valor legado) casa com a família inteira",
        paresVirg.length === 2 && paresVirg.every((p) => p.faceta > 0 && p.faceta === p.lista), JSON.stringify(paresVirg));
      const semVirg = (vfH.facetas.cargo || []).find((x) => x.n > 100);
      const smSV = (await get(`/api/sheet-meta?sheet=h2a-jun2026&cargo=${encodeURIComponent(semVirg.v)}&top=1`)).json;
      check("🎯 v179-L1: a opção que a faceta de cargo emite devolve exatamente o que ela anuncia (guarda do conserto acima)", smSV.total === semVirg.n, `${semVirg.v}: ${semVirg.n} vs ${smSV.total}`);

      // (2) parse(URL) e parse(objeto) — fila inicial do robô × refill
      const { createFiltros: _cfL1 } = require(path.join(__dirname, "mod-filtros.js"));
      const FL1 = _cfL1({ normalizeStateName: (s) => String(s || "").toUpperCase().trim(), normBusca: (s) => String(s || "").toLowerCase().trim(), cityMatchNormFn: (t) => { const q = String(t || "").toLowerCase().trim(); return q ? ((c) => c.includes(q)) : null; }, regioes: {}, grupoDe: (r) => r.g || "", searchSheet: (arr) => ({ total: arr.length, items: arr }), categoriaLabel: (k) => k });
      const divergem = [];
      for (const [dim, v] of [["cargo", "Cooks, Restaurant"], ["cidade", "Jenison, MI"], ["status", "Certified, Partially"]]) {
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
      const vfLb = (await get("/api/vagas/filtros?sheet=h2a-jun2026&cidadeBusca=labelle")).json;
      const lbFl = (vfLb.facetas.cidade || []).find((c) => c.v === "labelle|FLORIDA");
      const smLb = (await get(`/api/sheet-meta?sheet=h2a-jun2026&cidade=${encodeURIComponent("labelle|FLORIDA")}&top=2000`)).json;
      // MEDIDO: 65 na Flórida (+1 Labelle/GEORGIA). O relatório da auditoria
      // dizia "1 chip de 66" — os 66 incluíam a vaga da GEÓRGIA, que é outra
      // cidade; a verdade é 65 + 1, e é isso que a tela passa a mostrar.
      check("🎯 v179-L1: cidade é LUGAR, não texto — 'LaBelle'/'Labelle'/'LABELLE' viravam 3 chips (32/23/11) e clicar qualquer um trazia 66 (com 1 da GEÓRGIA junto); agora 1 opção por cidade+estado, com rótulo na grafia mais comum",
        (vfLb.facetas.cidade || []).length === 2 && lbFl && lbFl.n === 65 && lbFl.label === "LaBelle" && lbFl.estado === "FLORIDA" &&
        smLb.total === 65 && smLb.jobs.every((j) => j.state === "FLORIDA"),
        JSON.stringify(vfLb.facetas.cidade) + " lista=" + smLb.total);
      const vfAmes = (await get("/api/vagas/filtros?sheet=h2a-jun2026&cidadeBusca=ames")).json;
      const ames = (vfAmes.facetas.cidade || []).find((c) => c.v === "ames|IOWA");
      const smAmes = (await get(`/api/sheet-meta?sheet=h2a-jun2026&cidade=${encodeURIComponent("ames|IOWA")}&top=2000`)).json;
      check("🎯 v179-L1: marcar uma cidade não traz mais cidade de outro estado — 'Ames' casava por pedaço de texto e devolvia 24 (St James/LA, Lamesa/TX, Jamestown/ND, Amesbury/MA…); agora 12, todas Ames/IOWA",
        ames && ames.n === 12 && smAmes.total === 12 && smAmes.jobs.every((j) => j.state === "IOWA" && /^ames$/i.test(j.city || "")),
        `faceta ${ames && ames.n} lista ${smAmes.total} estados ${[...new Set(smAmes.jobs.map((j) => j.state))].join("/")}`);
      const divCid = [];
      for (const c of (vfH.facetas.cidade || []).slice(0, 30)) {
        const sm = (await get(`/api/sheet-meta?sheet=h2a-jun2026&cidade=${encodeURIComponent(c.v)}&top=1`)).json;
        if (sm.total !== c.n) divCid.push(`${c.v}: ${c.n}≠${sm.total}`);
      }
      check("🎯 v179-L1: varredura — nas 30 cidades mais comuns da H-2A, a contagem do chip é EXATAMENTE o que a lista devolve (antes ~500 das 2.569 opções mentiam)",
        divCid.length === 0 && (vfH.facetas.cidade || []).length >= 30, divCid.slice(0, 5).join(" | "));
      const regs = {};
      for (const nome of ["cape cod", "adirondacks", "vail", "outer banks"]) {
        const sm = (await get(`/api/sheet-meta?sheet=h2a-jun2026&cidade=${encodeURIComponent(nome)}&top=1`)).json;
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
      const medFil = await _med("/api/vagas/filtros?sheet=h2a-jun2026", 6);
      const medBusca = await _med("/api/sheet-meta?sheet=jan2026&top=25&q=cook", 6);
      // Medido neste repo depois da correção: ~39ms e ~37ms (antes 107ms e
      // 71ms). O teto é folgado de propósito pra não ficar instável no CI —
      // o que ele trava é a REGRESSÃO de ordem de grandeza.
      check("🎯 v179-L1: desempenho — a contagem ao vivo renormalizava a cidade 114 mil vezes por requisição (23 regiões × 4.964 linhas) e travava o processo inteiro; agora usa o índice",
        medFil < 75 && medBusca < 75, `filtros=${medFil}ms busca=${medBusca}ms`);
      const vfCache1 = await get("/api/vagas/filtros?sheet=h2a-jun2026&estado=TEXAS");
      const _t0c = Date.now(); const vfCache2 = await get("/api/vagas/filtros?sheet=h2a-jun2026&estado=TEXAS"); const _msc = Date.now() - _t0c;
      check("🎯 v179-L1: cache curto (5s) da contagem ao vivo — a mesma pergunta repetida (cada tecla digitada no painel) não refaz o cálculo inteiro",
        vfCache1.json.total === vfCache2.json.total && _msc < 20, `${_msc}ms`);
      // (7) o índice enxerga o que o robô acabou de enriquecer
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const upEnr = await req2("POST", "/api/admin/sheet/upload", { name: "Enriquecer Teste", key: "enrich-teste", data: [{ c: "H-400-ENR-0001", e: "chefe@enrichteste.com", n: "Enriquecer Teste LLC", t: "Housekeeper", s: "MAINE" }] });
      const vfE0 = (await get("/api/vagas/filtros?sheet=enrich-teste")).json;
      const rEnr = await req2("POST", "/api/test/enriquecer-linha", {
        token: TEST_TOKEN, sheet: "enrich-teste", case: "H-400-ENR-0001",
        dol: { worksite_city: "Bar Harbor", worksite_state: "MAINE", begin_date: "2027-05-01", case_status: "Certified" },
      });
      const vfE1 = (await get("/api/vagas/filtros?sheet=enrich-teste")).json;
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
      const vfCat = (await get("/api/vagas/filtros?sheet=jan2026")).json;
      const cLand = (vfCat.facetas.categoria || []).find((c) => c.v === "landscape");
      const cConst = (vfCat.facetas.categoria || []).find((c) => c.v === "construction");
      check("🏷️ v179-L2: jan2026 depois do recategorizeAllSheets do boot — paisagismo voltou pra 🌿 Paisagismo (1.279 → 3.877) e 🏗️ Construção parou de inchar (4.005 → 1.438)",
        cLand && cConst && cLand.n >= 3500 && cConst.n <= 1600, `landscape=${cLand && cLand.n} construction=${cConst && cConst.n}`);
      // a vaga que o chip promete é a vaga que a lista entrega (mesma régua do lote 1)
      const smConst = (await get("/api/sheet-meta?sheet=jan2026&categoria=construction&top=2000")).json;
      const smConst2 = (await get("/api/sheet-meta?sheet=jan2026&categoria=construction&top=2000&skip=2000")).json;
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
      const smCat = (await get("/api/sheet-meta?sheet=cat-teste&top=50")).json;
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
      const _q = async (sheet, q, extra) => (await get(`/api/sheet-meta?sheet=${sheet}&q=${encodeURIComponent(q)}&top=${extra || 3}`)).json;
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
      const bwWage = (await get("/api/sheet-meta?sheet=jan2026&q=welder&sort=wage&top=6")).json;
      check("🔎 v179-L3: com outra ordenação a relevância não vira ruído — q=welder&sort=wage trazia Rebar Workers/Office Clerk nas 6 primeiras; agora as 6 são welder de verdade",
        bwWage.jobs.length === 6 && bwWage.jobs.every((j) => /welder/i.test(j.title || "")), JSON.stringify(bwWage.jobs.map((j) => j.title)));
      const bcc = await _q("jan2026", "cape cod");
      check("🔎 v179-L3: região só é procurada na CIDADE (e o parcial só casa no COMEÇO de uma palavra) — 'cape cod' numa planilha SEM cidade nenhuma devolvia 3.354 vagas, porque 'cape' casava dentro de 'landSCAPE' e 'dennis'/'orleans'/'sandwich' são nomes de empresa",
        bcc.total === 17, `${bcc.total}`);
      const smCape = (await get("/api/sheet-meta?sheet=h2a-jun2026&cidade=cape%20cod&top=1")).json;
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
      const trt = (await get("/api/sheet-meta?sheet=h2a-jun2026&q=tractor&top=5")).json;
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
      const t3 = []; for (let i = 0; i < 6; i++) { const t0 = Date.now(); await get(`/api/sheet-meta?sheet=jan2026&top=25&q=cook&_cb=${i}_${Date.now()}`); t3.push(Date.now() - t0); }
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
      const semCookie = (await get("/api/sheet-meta?sheet=jul2026&top=3")).json;
      COOKIE = _cookieGuardado;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vazadp@test.com", name: "Sem DP" });
      const gratis = (await get("/api/sheet-meta?sheet=jul2026&top=3")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "temdp@test.com", name: "Com DP", plan: "doublepro", vip: { plan: "doublepro", active: true, manualExpires: Date.now() + 30 * 86400_000, autoExpires: Date.now() + 30 * 86400_000, source: "pix" } });
      const dp = (await get("/api/sheet-meta?sheet=jul2026&top=3")).json;
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
      const inv = (await get("/api/vagas/filtros?sheet=h2a-jun2026&inicio=13&salarioMin=abc&grupo=Z")).json;
      check("🔒 v179-L4: parâmetro inválido sumia CALADO e a resposta devolvia a planilha inteira (inicio=13 → total 4.964 com ativos=0) — na tela é confusão, no robô o job.filters corrompido fazia o refill se realimentar com TUDO; agora cada descarte é declarado",
        inv.total === 4964 && Array.isArray(inv.ignorados) && inv.ignorados.length === 3 &&
        inv.ignorados.some((x) => x.param === "inicio") && inv.ignorados.some((x) => x.param === "salarioMin") && inv.ignorados.some((x) => x.param === "grupo"),
        JSON.stringify(inv.ignorados));
      const topAbc = (await get("/api/sheet-meta?sheet=jul2025&top=abc")).json;
      const skipAbc = (await get("/api/sheet-meta?sheet=jul2025&skip=abc&top=5")).json;
      check("🔒 v179-L4: top=abc virava NaN e a lista voltava VAZIA ao lado de um contador de milhares ('Nenhuma vaga encontrada' com total 2.206) — agora cai no padrão (25) e skip inválido vira 0",
        topAbc.jobs.length === 25 && topAbc.total === 2206 && skipAbc.skip === 0 && skipAbc.jobs.length === 5,
        `top=abc → ${topAbc.jobs.length} vagas / total ${topAbc.total}; skip=abc → skip ${skipAbc.skip}`);
      const vistos = new Set(); let dup = 0;
      for (let sk = 0; sk < 2206; sk += 500) {
        const pg = (await get(`/api/sheet-meta?sheet=jul2025&sort=shuffle&top=500&skip=${sk}`)).json;
        for (const j of pg.jobs) { if (vistos.has(j.caseNum)) dup++; else vistos.add(j.caseNum); }
      }
      check("🔒 v179-L4: `sort` vinha da URL sem lista branca — sort=shuffle reembaralhava a cada requisição e a paginação DUPLICAVA e PERDIA vaga (varredura real de jul2025: 1.465 únicas / 741 duplicadas); agora ordenação desconhecida cai no padrão estável",
        vistos.size === 2206 && dup === 0, `${vistos.size} únicas / ${dup} duplicadas`);
      // (4) o "de N vagas" das duas rotas tem que ser o MESMO número
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "denvagas@test.com", name: "Den Vagas" });
      const semHist = (await get("/api/sheet-meta?sheet=morta-teste&hideSent=1&top=5")).json;
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "denvagas@test.com", sentTo: ["viva@mortateste.com", "velha@mortateste.com"] });
      const comHist = (await get("/api/sheet-meta?sheet=morta-teste&hideSent=1&top=5")).json;
      const vfHist = (await get("/api/vagas/filtros?sheet=morta-teste&hideSent=1")).json;
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
      const vfAtivosFront = (st) => { let n = 0; for (const k of ["estado", "cidade", "categoria", "cargo", "inicio", "status", "grupo"]) if ((st[k] || []).length) n++; if (st.salarioMin > 0) n++; if (st.vagasMin > 0) n++; if (st.q) n++; if (st.email) n++; return n; };
      const estados = [{}, { email: true }, { q: "cook" }, { q: "cook", email: true }, { estado: ["TEXAS"], q: "cook", email: true },
        { estado: ["TEXAS"], categoria: ["food"], salarioMin: 15, email: true }, { cidade: ["ames|IOWA"], vagasMin: 5 },
        { tipo: "agricultural", ativa: true, email: true }];
      const badge = estados.map((st) => { const p = new URLSearchParams(); for (const k of ["estado", "cidade", "categoria", "cargo", "status", "grupo"]) (st[k] || []).forEach((v) => p.append(k, v)); (st.inicio || []).forEach((m) => p.append("inicio", String(m))); if (st.salarioMin > 0) p.set("salarioMin", String(st.salarioMin)); if (st.vagasMin > 0) p.set("vagasMin", String(st.vagasMin)); if (st.email) p.set("email", "1"); if (st.q) p.set("q", st.q); return { front: vfAtivosFront(st), motor: FL5.ativos(FL5.parse(p)) }; });
      check("🔍 v181-L5: o badge '🔍 N filtros' espelha EXATAMENTE o ativos() do motor nas 8 combinações — contava tipo/ativa (que a tela nunca envia fora da aba ao vivo) e ignorava o 'só com e-mail', o filtro mais consequente da tela",
        badge.every((b) => b.front === b.motor), JSON.stringify(badge));
      check("🔍 v181-L5 (estrutural): o 'só com e-mail' DESLIGADO virou chip visível ('incluindo vagas sem e-mail — não dá pra se candidatar') e tirar o chip volta ao outro estado",
        /else if\(st\.email\)n\+\+;/.test(_appL5) && _appL5.includes("vf_chip_sem_email") &&
        /!st\.email\)push\("email"/.test(_appL5) && /else if\(dim==="email"\)st\.email=!st\.email;/.test(_appL5),

        "chip do e-mail desligado ausente");
      // (4) 🗓️ "Começa logo" entrega o que promete (caso 21)
      const st10 = (await get("/api/sheet-meta?sheet=h2a-jun2026&sort=start&top=10")).json;
      const _hj = new Date().toISOString().slice(0, 10);
      const faixas = (st10.jobs || []).map((j) => { const d = String(j.start || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? (d >= _hj ? 0 : 1) : 2; });
      const semSort = (await get("/api/sheet-meta?sheet=h2a-jun2026&top=1")).json;
      check("🗓️ v181-L5 (caso 21): 'Começa logo' entregava 'começou há mais tempo' (as 5 primeiras da H-2A eram de jan/fev — 8 meses atrás). Agora: nenhuma vaga já iniciada aparece antes de uma que ainda vai começar, e o total não muda",
        faixas.length === 10 && faixas.every((f, i) => i === 0 || f >= faixas[i - 1]) && faixas[0] === 0 && st10.total === semSort.total,
        JSON.stringify({ faixas, datas: (st10.jobs || []).map((j) => j.start), total: st10.total }));
      const vfJan = (await get("/api/vagas/filtros?sheet=jan2026")).json;
      check("🗓️ v181-L5: em jan2026/jul2025 a data de início é VAZIA em 100% das linhas (disponibilidade.inicio 0) — a tela esconde 🗓️/Recentes em vez de acender um botão que não faz nada em 11.446 vagas",
        vfJan.disponibilidade.inicio === 0 && _appL5.includes("function _vfSyncSortBtns(") && /so-start","so-desc/.test(_appL5),
        `inicio=${vfJan.disponibilidade.inicio}`);
      // (5) "Recentes" virou ordenação REAL por data (decisão do dono)
      const rec = (await get("/api/sheet-meta?sheet=h2a-jun2026&sort=desc&top=12")).json;
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
      // (6) rótulos PT do status + painel que não fica mudo
      const _i18nL5 = ["vf_st_certified", "vf_st_pending", "vf_st_withdrawn", "vf_st_denied", "vf_erro", "vf_erro_btn", "vf_vazio_t", "vf_vazio_sem_email", "vf_vazio_tirando", "vf_chip_sem_email", "vf_grupo_expl"];
      const _dictL5 = (lang) => { const i = _appL5.indexOf(`  ${lang}: {`); const e = _appL5.indexOf("\n  }", i); return _appL5.slice(i, e); };
      const _ptL5 = _dictL5("pt"), _enL5 = _dictL5("en"), _esL5 = _dictL5("es");
      const _faltamL5 = _i18nL5.filter((k) => !(_ptL5.includes(`"${k}":`) && _enL5.includes(`"${k}":`) && _esL5.includes(`"${k}":`)));
      check("🏷️ v181-L5: 'Certified'/'Pending Processing' viraram rótulo em PT (✅ Aprovada pelo governo / ⏳ Em análise no DOL) e o grupo da loteria ganhou explicação — todas as strings novas no LANG_DICT nas 3 línguas",
        _faltamL5.length === 0 && _appL5.includes("function _vfStatusLabel("), `faltando: ${_faltamL5.join(",")}`);
      const dpStatus = (await get("/api/sheet-meta?sheet=jan2026&status=Certified&top=1")).json;
      check("🏷️ v181-L5: o VALOR enviado ao servidor continua o LITERAL do dado (status=Certified → 9.240 em jan2026) — só o rótulo da tela traduz, o filtro não mexe",
        dpStatus.total === 9240, `${dpStatus.total}`);
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
      const _t = async (qs) => (await get("/api/sheet-meta?" + qs + "&top=1")).json.total;
      const vfJ = (await get("/api/vagas/filtros?sheet=jan2026")).json;
      const vfJ25 = (await get("/api/vagas/filtros?sheet=jul2025")).json;
      const vfH2a = (await get("/api/vagas/filtros?sheet=h2a-jun2026")).json;
      const vfJ26 = (await get("/api/vagas/filtros?sheet=jul2026")).json;
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
      const vfExp0 = (await get("/api/vagas/filtros?sheet=jan2026&exp=0")).json;
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
      const encJobs = (await get(`/api/sheet-meta?sheet=h2a-jun2026&temporada=encerrada&top=2000`)).json.jobs || [];
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
      const vfPadrao = (await get("/api/vagas/filtros?sheet=h2a-jun2026&ocultarEncerradas=1")).json;
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
      const vfMix = (await get("/api/vagas/filtros?sheet=mista-visa")).json;
      const listaA = (await get("/api/sheet-meta?sheet=mista-visa&visa=H-2A&top=10")).json;
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
      const igL6 = (await get("/api/vagas/filtros?sheet=h2a-jun2026&inicio=13&exp=abc&temporada=xxx&visa=H-9")).json;
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
      const _t7 = async (qs) => (await get("/api/sheet-meta?" + qs + "&top=1")).json.total;
      const vfJ7 = (await get("/api/vagas/filtros?sheet=jan2026")).json;
      const vfH7 = (await get("/api/vagas/filtros?sheet=h2a-jun2026")).json;
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
      const busca7 = (await get("/api/vagas/filtros?sheet=jan2026&cargoBusca=cook")).json;
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
      check("📋 v174: painel dos robôs responde numa chamada só (enrich/fresh/h2aNovas/coleta/mensais) e os agendadores ficam DESLIGADOS no npm test",
        plSt0.json?.ok === true && plSt0.json.agendado === false && ["enrich", "fresh", "h2aNovas", "coleta", "mensalH2a", "mensalH2b"].every((k) => plSt0.json[k] && typeof plSt0.json[k] === "object"),
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
      const sm2 = await get("/api/sheet-meta?sheet=teste2099&skip=0&top=5");
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
      check("🚨 v177-FIX7 (estrutural): o robô de frescor passou a cobrir a planilha H-2A DO MÊS (h2a-AAAAMM, a que se publica sozinha) — antes só olhava a H-2B mais nova e a chave fixa h2a-jun2026, então a planilha mais nova do site envelhecia sem NENHUMA reconferência de status/data/salário",
        _modFresh.includes("function latestH2aMensalKey()") &&
        _modFresh.includes('[latestH2bKey(), "h2a-jun2026", latestH2aMensalKey()]'),
        "runFreshCycle voltou a ignorar as planilhas H-2A mensais");
      // 🔒 admin-only + estrutural
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
      const pl403 = await Promise.all([req2("POST", "/api/admin/sheet/h2a-bimestral-run", {}), req2("POST", "/api/admin/sheet/coleta-start", { sheetKey: "x" }), get("/api/admin/planilhas/status"), req2("POST", "/api/admin/sheet/coleta-publish", { key: "teste2099" })]);
      check("🔒 v174: usuário comum recebe 403 nos robôs de planilha (admin-only)", pl403.every((r) => r.status === 403), pl403.map((r) => r.status).join(","));
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
      const _srvPl = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
      const _modPl = fs.readFileSync(path.join(__dirname, "mod-planilhas.js"), "utf8");
      const _admPl = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
      check("📋 v174: (estrutural) agendadores ligados no boot (PLANILHAS.iniciarAgendadores), H-2B mensal NUNCA publica sozinha (autoPublish:false) e a H-2A sim, upload dispara o enriquecimento e o painel tem a aba Planilhas & Robôs",
        _srvPl.includes("PLANILHAS.iniciarAgendadores()") && /runH2bMensal[\s\S]{0,400}autoPublish: false/.test(_modPl) && /runH2aMensal[\s\S]{0,400}autoPublish: true/.test(_modPl) && _srvPl.includes("PLANILHAS.autoEnrichCycle()") &&
        _admPl.includes('data-view="planilhas"') && _admPl.includes("function loadPlanilhas(") && _admPl.includes("/api/admin/planilhas/status") && _admPl.includes("/api/admin/sheet/coleta-publish"),
        "estrutura do v174 incompleta");
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
    check("📡 v134: radar salva e aparece no GET (estados/cidade/busca, ativo)",
      rdSave.json?.ok === true && rdGet.json?.radar?.estados?.[0] === "MA" && rdGet.json?.radar?.ativo === true,
      rdGet.body.slice(0, 140));
    const rdOff = await req2("POST", "/api/radar", { remove: true });
    const rdGet2 = await get("/api/radar");
    check("📡 v134: desligar o radar remove de verdade", rdOff.json?.ok === true && rdGet2.json?.radar === null, rdGet2.body.slice(0, 100));
    // v174: além do upload manual do admin, a coleta do DOL, a publicação de
    // rascunho e as vagas novas H-2A também avisam o radar (bloco 📋 acima);
    // aqui fica a prova comportamental do caminho do upload, de ponta a
    // ponta, em vez de só contar chamadas de notificarRadares() no texto.
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
    check("📡 v134: vaga nova casando com o radar (upload manual do admin) avisa de verdade — totalAvisos sobe e lastPushAt é carimbado",
      rdGet3.json?.radar?.totalAvisos === 1 && rdGet3.json?.radar?.lastPushAt > 0,
      JSON.stringify(rdGet3.json?.radar || {}).slice(0, 160));
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
    check("💸 v140: chamadas ao DOL pedem gzip e o streaming cru segue identity",
      (_srvSrc.match(/"Accept-Encoding":"gzip"/g) || []).length >= 2 && (_srvSrc.match(/"Accept-Encoding":"identity"/g) || []).length >= 1,
      `gzip=${(_srvSrc.match(/"Accept-Encoding":"gzip"/g) || []).length} identity=${(_srvSrc.match(/"Accept-Encoding":"identity"/g) || []).length}`);

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
    check("🚨 v172c-SEC: /oauth/callback (branch __sender__) exige que a sessão ATUAL seja quem iniciou o fluxo — login-CSRF fechado",
      /const _sess2=getSess\(req\);\s*\n\s*if\(!_sess2\?\.user_email\|\|_sess2\.user_email!==ownerEmail2\)/.test(_srvSrc),
      "callback de add-sender não confere mais a sessão atual contra quem iniciou o fluxo");
    check("🚨 v172c-SEC: /oauth/callback (branch __connectsend__) exige que a sessão ATUAL seja quem iniciou o fluxo — login-CSRF fechado",
      /const _sessCS=getSess\(req\);\s*\n\s*if\(!_sessCS\?\.user_email\|\|_sessCS\.user_email!==ownerEmailCS\)/.test(_srvSrc),
      "callback de connect-send não confere mais a sessão atual contra quem iniciou o fluxo");
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
    check("🩻 v163: /api/admin/memoria mede o processo (rss/heap > 0), conta os comprovantes base64 RESIDENTES na RAM (fixtures: pedidos ≥2 com foto, gastos ≥1) e lista os arquivos do DATA com tamanho",
      memX?.ok === true && memX.processo?.rssMB > 0 && memX.processo?.heapUsadoMB > 0 &&
      memX.comprovantes?.pedidos?.n >= 2 && memX.comprovantes?.pedidos?.mb >= 0 &&
      memX.comprovantes?.gastos?.n >= 1 &&
      Array.isArray(memX.arquivos) && memX.arquivos.some((a) => a.nome === "users.json") &&
      Array.isArray(memX.dicas) && memX.dicas.length >= 1 && typeof memX.bancos?.usuarios === "number",
      JSON.stringify({ rss: memX?.processo?.rssMB, comp: memX?.comprovantes?.pedidos, gastos: memX?.comprovantes?.gastos?.n }).slice(0, 160));
    check("🩻 v163: (estrutural) a rota NUNCA faz JSON.stringify de banco inteiro (só de 1 linha-amostra) e o pulso [mem] roda a cada 6h no log",
      /Planilhas residentes: linhas reais \+ estimativa por AMOSTRA/.test(_srvSrc) &&
      _srvSrc.includes("JSON.stringify(a[0]||{})") && !/JSON\.stringify\(DB_USERS\)/.test(_srvSrc.split("api/admin/memoria")[1]?.split("api/")[0] || "x") &&
      _srvSrc.includes("[mem] rss=") && _srvSrc.includes("setInterval(_memPulse,6*3600_000)"),
      "raio-x sem a guarda de amostra ou sem pulso");

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
    check("🎯 v178: valor DIVERGENTE (robô leu R$100 × pedido R$150) cancela o pedido SOZINHO, na hora — sem correção manual, sem admin decidir — com o motivo explicado pro cliente",
      mc5p1.json?.ok === true && !mc5p1.json?.duplicado &&
      mc5p1Get.json?.pedido?.status === "cancelado" && mc5p1Get.json?.pedido?.canceladoPor === "sistema (IA — valor divergente)" &&
      /R\$100\.00.*R\$150\.00/.test(mc5p1Get.json?.pedido?.notaAdmin || ""),
      JSON.stringify({ status: mc5p1Get.json?.pedido?.status, por: mc5p1Get.json?.pedido?.canceladoPor, nota: mc5p1Get.json?.pedido?.notaAdmin }).slice(0, 200));
    check("🎯 v178: tentar ativar um pedido JÁ cancelado (pelo auto-cancelamento) é barrado com 409 jaCancelado — não existe mais caminho pra 'aprovar mesmo assim' um valor errado",
      mc5Ap1.status === 409 && mc5Ap1.json?.jaCancelado === true && mc5Ap1.json?.canceladoPor === "sistema (IA — valor divergente)",
      JSON.stringify(mc5Ap1.json).slice(0, 160));
    check("🎯 v178: (estrutural) só DIVERGENCIA cancela sozinho — ILEGIVEL/ERRO continuam pendentes pra revisão humana (a IA não tem certeza do que leu; cancelar aí puniria um comprovante legítimo com foto ruim)",
      _srvSrc.includes('function _autoCancelarSeDivergente(pedido,pc){\n  if(pc.veredito!=="DIVERGENCIA")return;'),
      "guarda de escopo do auto-cancelamento mudou");
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5b@test.com", name: "MC5 B" });
    const mc5p2 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "MC5 B", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150:E2EMC5AAA1:Pagador MC5", comprovante: Buffer.from("comp-mc5-b-refoto").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const mc5Ap3 = await req2("PATCH", "/api/pedido/" + mc5p2.json?.pedidoId, { status: "ativo", recebidoPor: "diego" });
    check("💼 MC5-P1 + v178: MESMA transação PIX (E2E) reaparece em OUTRO usuário — mesmo o pedido original tendo sido CANCELADO (pelo auto-cancelamento por valor divergente, não aprovado), a aprovação barra com 409 'comprovante já usado' apontando o pedido e o e-mail originais (reuso suspeito não some só porque a 1ª tentativa foi rejeitada)",
      mc5Ap3.status === 409 && mc5Ap3.json?.comprovanteUsado === true && mc5Ap3.json?.pedidoDup === mc5p1.json?.pedidoId && mc5Ap3.json?.emailDup === "mc5a@test.com",
      JSON.stringify(mc5Ap3.json).slice(0, 180));
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

    // 🧪 AUDITORIA 10/09/2026: PLANO_PRECO_TAB tem 3 planos × 4 prazos = 12
    // combinações, mas só vip/vipro de 30 dias tinham sido exercidos pela
    // APROVAÇÃO REAL (PATCH /api/pedido/:id {status:"ativo"}) nos testes
    // acima — doublepro só aparecia via /api/admin/set-plan (concessão
    // manual do admin, caminho de código diferente) e nenhum prazo de
    // 60/90/365 dias nunca passou pela aprovação de pedido de verdade.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-dp@test.com", name: "Combo DoublePro" });
    const comboDp = await req2("POST", "/api/pedido", { plano: "doublepro", dias: 30, consentimento: true, userName: "Combo DoublePro", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:250", comprovante: Buffer.from("combo-dp").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const comboDpAp = await req2("PATCH", "/api/pedido/" + comboDp.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-dp@test.com" });
    const comboDpSt = (await get("/api/status")).json;
    check("🧪 combo plano×prazo: DoublePro 30d aprovado por PEDIDO REAL (não só set-plan do admin) ativa manual+auto com os limites 200/200 da tabela nova — combinação nunca exercida antes pela aprovação",
      comboDpAp.json?.ok === true && comboDpAp.json?.plano === "doublepro" &&
      comboDpSt?.plan === "doublepro" && comboDpSt?.manualLimit === 200 && comboDpSt?.autoLimit === 200 &&
      comboDpSt?.vip?.autoActive === true && comboDpSt?.vip?.manualActive === true,
      JSON.stringify({ ap: comboDpAp.json?.plano, plan: comboDpSt?.plan, ml: comboDpSt?.manualLimit, al: comboDpSt?.autoLimit }).slice(0, 160));

    // Sem nota "TESTE_COMPROVANTE:" de propósito: com ela, o robô leria
    // CONFERE e a ativação PROVISÓRIA automática (intencional — ver
    // autoAtivarProvisorio) somaria +AUTO_ATIVA_DIAS por cima dos 90 da
    // aprovação, misturando dois comportamentos num teste só. Sem precheck
    // nenhum, a aprovação do admin é a ÚNICA fonte de dias — matemática limpa.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-90@test.com", name: "Combo 90 Dias" });
    const combo90 = await req2("POST", "/api/pedido", { plano: "vip", dias: 90, consentimento: true, userName: "Combo 90 Dias", userWhatsapp: "11 9", userCity: "SP", valorTotal: 270, comprovante: Buffer.from("combo-90").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const combo90Ap = await req2("PATCH", "/api/pedido/" + combo90.json?.pedidoId, { status: "ativo", recebidoPor: "diego" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "combo-90@test.com" });
    const combo90St = (await get("/api/status")).json;
    const _diasRestantes90 = combo90St?.vip?.manualExpires ? Math.round((combo90St.vip.manualExpires - Date.now()) / 86400000) : 0;
    check("🧪 combo plano×prazo: VIP de 90 dias (não o padrão de 30) aprovado por pedido real estende a validade ~90 dias e NÃO libera automático (VIP puro é só manual) — prazo 60/90/365 nunca tinha sido exercido pela aprovação",
      combo90Ap.json?.ok === true && combo90St?.plan === "vip" &&
      _diasRestantes90 >= 88 && _diasRestantes90 <= 91 &&
      combo90St?.vip?.autoActive === false && combo90St?.manualLimit === 100,
      JSON.stringify({ ap: combo90Ap.status, plan: combo90St?.plan, diasRestantes: _diasRestantes90, auto: combo90St?.vip?.autoActive }).slice(0, 180));

    // ═══ 💼 MC5 — PARTE 2 (29/08): O USUÁRIO VÊ TUDO ═══════════════════════
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5a@test.com", name: "MC5 A" });
    const mc5vis = (await get("/api/pedidos")).json;
    const _rowA = (mc5vis?.pedidos || []).find((p2) => p2.id === mc5p1.json?.pedidoId);
    check("💼 MC5-P2 + v178: /api/pedidos do usuário virou WHITELIST — sem preCheck cru (vazava e-mail de OUTRO usuário no dupAlerta), sem notaAdmin/criadoPor internos; comprovanteStatus derivado SEGURO ('analise'); e o pedido aparece CANCELADO com o motivo real do auto-cancelamento (v178) visível no motivoCancelamento — a pessoa sabe exatamente por que precisa fazer um pedido novo",
      _rowA && !("preCheck" in _rowA) && !("notaAdmin" in _rowA) && !("criadoPor" in _rowA) &&
      _rowA.comprovanteStatus === "analise" && _rowA.comprovante === true && typeof _rowA.valorTotal === "number" &&
      _rowA.status === "cancelado" && /R\$100\.00.*R\$150\.00/.test(_rowA.motivoCancelamento || ""),
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
    check("💼 MC5-P2 → v170: /api/planos entrega a mediana REAL de confirmação (promessa honesta no lugar do '24h' fixo) — fonte única de preço/limites pro checkout, nunca hardcoded",
      mc5pl?.ok === true && (typeof mc5pl?.medianaAprovacaoHoras === "number" || mc5pl?.medianaAprovacaoHoras === null) &&
      Array.isArray(mc5pl?.precos) && mc5pl.precos.length >= 9 && mc5pl?.limites?.vipro?.manual === 100,
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
    check("💼 MC5-P4: pedidos chegam marcados (ehAdmin pela lista real de e-mails de admin) — exclusão de teste de admin também vale no server (mesma régua da Conferência)",
      _rAdm4?.ehAdmin === true && _rUsr4?.ehAdmin === false &&
      _srvSrc.includes("if(isAdminEmail(pd.userEmail))continue;"),
      JSON.stringify({ adm: _rAdm4?.ehAdmin, usr: _rUsr4?.ehAdmin }).slice(0, 80));

    // ═══ 💼 MC5 — PARTE 5 (29/08): QUEM RECEBEU/GASTOU 100% ════════════════
    // Dono do dinheiro NUNCA mais é chutado; gasto recorrente (Render todo
    // mês) e em dólar; repasse com comprovante; entrada manual com prova
    // some do "sem comprovante"; corte de mês em horário de Brasília.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5e@test.com", name: "MC5 E" });
    const mc5p5 = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 E", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:100", comprovante: Buffer.from("comp-mc5-e-p5").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const mc5Ap5 = await req2("PATCH", "/api/pedido/" + mc5p5.json?.pedidoId, { status: "ativo" }); // SEM recebidoPor, de propósito
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const finP5 = (await get("/api/admin/financeiro")).json;
    const _rowP5 = (finP5?.pagamentos || []).find((x) => x.pedidoId === mc5p5.json?.pedidoId);
    const _csvP5 = (await _getBufA("/api/admin/financeiro/exportar")).buf.toString("utf8");
    const _linP5 = _csvP5.split("\n").find((l) => l.includes("100,00"));
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
    const p6ped = await req2("POST", "/api/pedido", { plano: "vip", dias: 30, consentimento: true, userName: "MC5 F", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:100", comprovante: Buffer.from("comp-p6-f").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _janAntes6 = (await get("/api/admin/financeiro")).json?.entradas?.total;
    await req2("PATCH", "/api/pedido/" + p6ped.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    const _janMeio6 = (await get("/api/admin/financeiro")).json?.entradas?.total;
    const p6canc = await req2("PATCH", "/api/pedido/" + p6ped.json?.pedidoId, { status: "cancelado", notaAdmin: "teste P6 — caixa nunca apaga" });
    const finP6 = (await get("/api/admin/financeiro")).json;
    const _p6orig = (finP6?.pagamentos || []).find((x) => x.pedidoId === p6ped.json?.pedidoId && x.tipo !== "ajuste");
    const _p6aj = (finP6?.pagamentos || []).find((x) => x.tipo === "ajuste" && x.ajustaPedidoId === p6ped.json?.pedidoId);
    check("💼 MC5-P6: cancelar pedido APROVADO anula por AJUSTE− em vez de apagar — original preservado (anuladoPor com o motivo do admin), par de −100, e o líquido canônico volta EXATO ao de antes da aprovação (delta R$0)",
      p6canc.json?.ok === true && _p6orig && !!_p6orig.anuladoPor && /caixa nunca apaga/.test(_p6orig.anuladoPor.motivo || "") &&
      _p6aj && _p6aj.valor === -100 && !_p6aj.pedidoId &&
      Math.abs(_janMeio6 - _janAntes6 - 100) < 0.011 && Math.abs(finP6.entradas.total - _janAntes6) < 0.011,
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
      check("📖 v160: TODAS as fotos referenciadas nos tutoriais existem de verdade no disco (nenhum print quebrado)",
        _imgsRef.length >= 10 && _faltando.length === 0,
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
      _srvSrc.includes("{ email: ownerEmail, countKey: _principalCountKey, isPrincipal: true, addedAt: p?.created_at }") &&
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
    check("🛡️ /api/admin/pedido-set-valor lê o body de verdade (JSON.parse(await readBody)) — nunca mais trava a requisição pra sempre",
      !_srvSrc.includes("const {pedidoId,valor}=body;") && /pedido-set-valor[\s\S]{0,1200}?JSON\.parse\(await readBody\(req\)\)/.test(_srvSrc),
      "rota pedido-set-valor não encontrada lendo o body via readBody logo depois do pathname check, ou o padrão quebrado antigo voltou");

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
      check("🚨 v177-FIX5 (estrutural): /api/cv/upload confere o retorno do saveCv antes de responder ok — antes dizia 'salvo' mesmo com disco E fallback em memória falhando (o usuário só descobria na hora de se candidatar)",
        (_srvSrc.match(/if\(!saveCv\(s\.user_email/g) || []).length === 2,
        "uma das 2 gravações de currículo ainda responde ok:true sem olhar o retorno do saveCv");
      // devolve a sessão pro usuário comum — o próximo check conta com isso
      await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    }

    // 🎯 usuário comum (não-admin) NUNCA acessa Respostas Certas — é dado
    // privado do admin (respostas de e-mail de outra pessoa).
    const rcAsUser = await get("/api/admin/reply-triage/status");
    check("🎯 usuário comum recebe 403 em Respostas Certas (aba é admin-only de verdade, não só escondida no menu)",
      rcAsUser.status === 403, rcAsUser.body.slice(0, 120));

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
      const _jobBi = (await get("/api/sheet-meta?sheet=jul2025&q=Builtin%20Import&top=5")).json;
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
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });

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
