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
}));
const COOLDOWN_FIX_TS = Date.now();
fs.writeFileSync(path.join(DATA, "history.json"), JSON.stringify({
  "cooldown@test.com": [{ to: "empresa@teste-cooldown.com", subject: "x", type: "manual", sentAt: new Date(COOLDOWN_FIX_TS).toISOString(), date: "hoje" }],
}));
// PDF órfão no disco (lixo do antigo delete sem unlink) — o sweep deve apagar
fs.mkdirSync(path.join(DATA, "cvs"), { recursive: true });
fs.writeFileSync(path.join(DATA, "cvs", "fantasma@test.com_777.pdf"), "%PDF-1.4 orfao");

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
    const _cadOk = await req2("POST", "/api/cadastro", {
      username: "novo_user_v172c", password: "12345678", nome: "Fulano", sobrenome: "Silva",
      dataNascimento: "1995-01-01", cidade: "Recife", estado: "PE", pais: "Brasil",
      telefone: "+5581999999999", whatsapp: "+5581999999999",
    });
    check("🔐 v172c: POST /api/cadastro cria conta usuário+senha (sem Google) e já devolve sessão logada",
      _cadOk.status === 200 && _cadOk.json?.ok === true && _cadOk.json?.username === "novo_user_v172c",
      JSON.stringify(_cadOk.json));
    const _novoUser = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))["novo_user_v172c"];
    check("🔐 v172c: usuário novo nasce com senha em HASH (scrypt) — nunca texto puro no banco",
      !!_novoUser?.passwordSalt && !!_novoUser?.passwordHash && _novoUser.passwordHash !== "12345",
      JSON.stringify({ temSalt: !!_novoUser?.passwordSalt, temHash: !!_novoUser?.passwordHash }));
    const _cadDup = await req2("POST", "/api/cadastro", { username: "novo_user_v172c", password: "99999999", nome: "Outro", sobrenome: "Nome" });
    check("🔐 v172c: cadastro com username JÁ EXISTENTE → 409 (nunca sobrescreve a conta)",
      _cadDup.status === 409, `status=${_cadDup.status}`);
    const _cadCurta = await req2("POST", "/api/cadastro", { username: "outro_user_v172c", password: "12", nome: "A", sobrenome: "B" });
    check("🔐 v172c: cadastro com senha curta (<4) → 400",
      _cadCurta.status === 400, `status=${_cadCurta.status}`);
    const _cadArroba = await req2("POST", "/api/cadastro", { username: "tem@arroba", password: "12345678", nome: "A", sobrenome: "B" });
    check("🔐 v172c: cadastro com @ no username → 400 (impossível colidir com e-mail de admin)",
      _cadArroba.status === 400, `status=${_cadArroba.status}`);
    COOKIE = "";
    const _logOk = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "12345678" });
    check("🔐 v172c: POST /api/login com usuário+senha certos → 200 e sessão nova",
      _logOk.status === 200 && _logOk.json?.ok === true, JSON.stringify(_logOk.json));
    COOKIE = "";
    const _logBad = await req2("POST", "/api/login", { username: "novo_user_v172c", password: "senhaerrada" });
    check("🔐 v172c: POST /api/login com senha ERRADA → 403 (nunca entra)",
      _logBad.status === 403, `status=${_logBad.status}`);
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
    // ADMIN_EMAIL_2 (Diego) não está configurado neste ambiente de teste —
    // login com a senha CERTA do Diego tem que falhar com erro CLARO (nunca
    // criar sessão com e-mail vazio, corromper o banco em silêncio).
    const alDiego = await req2("POST", "/api/admin-panel/login", { user: "diego", password: "teste-smoke-diego-2026" });
    check("🔐 painel admin: senha certa do Diego, mas ADMIN_EMAIL_2 não configurado neste ambiente → erro claro (nunca sessão com e-mail vazio)",
      alDiego.status === 500 && /ADMIN_EMAIL_2/.test(alDiego.json?.error || ""), JSON.stringify(alDiego.json));
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
    check("✉️ v172c: OAUTH_SCOPES (com gmail.send) só é usado em /oauth/add-sender e /oauth/connect-send — a landing não fala mais com o Google pra login",
      _scopeUses === 2 && _sendOnlyConst === "true" && _scopesLine.includes("gmail.send") && !_scopesLine.includes("readonly") && !_scopesLine.includes("modify"),
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

    // v51 (dono): a H-2B mais NOVA (jul2026, semeada e publicada no boot) vem
    // PRIMEIRO na lista (o front a põe à esquerda com o selo MAIS NOVA) —
    // e quando a lista de janeiro sair, latestH2bKey() promove sozinha.
    check("⭐ H-2B mais nova (jul2026) vem PRIMEIRO na lista e marcada como latest",
      slH2a.json?.sheets?.[0]?.key === "jul2026" && slH2a.json.sheets[0].latest === true && slH2a.json?.latestH2b === "jul2026",
      JSON.stringify({ first: slH2a.json?.sheets?.[0]?.key, latestH2b: slH2a.json?.latestH2b }));
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
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const stCancelado = await get("/api/status");
    check("🧾 v170: cancelamento estorna os DIAS de VIP concedidos (30d voltam) — pd.diasTotal alimenta o estorno-de-dias corretamente",
      !(stCancelado.json?.vip?.manualExpires > Date.now() + 3600_000) && !(stCancelado.json?.vip?.autoExpires > Date.now() + 3600_000),
      JSON.stringify(stCancelado.json?.vip));

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
    // Nesta reconstrução não existem robôs de coleta automática (README) —
    // o único ponto onde vaga nova entra no sistema é o upload manual do
    // admin (/api/admin/sheet/upload), então é ELE que precisa disparar o
    // radar. Teste comportamental de ponta a ponta em vez de só contar
    // chamadas de notificarRadares() no texto do server.js.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "radaruser@test.com", name: "Radar User" });
    // estado no formato NOME POR EXTENSO — é o que o front realmente manda
    // (#f-state guarda "MASSACHUSETTS", não a sigla "MA"; ver _mfFillStateSelect
    // em app.js) e é o mesmo formato do campo `s` das planilhas compactas.
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
    const mc5Ap1 = await req2("PATCH", "/api/pedido/" + mc5p1.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    const mc5Ap2 = await req2("PATCH", "/api/pedido/" + mc5p1.json?.pedidoId, { status: "ativo", recebidoPor: "andrio", confirmarDivergencia: true });
    check("💼 MC5-P1: aprovar com leitura DIVERGENTE (robô leu R$100, pedido diz R$150) leva 409 confirmável mostrando os DOIS números — e só aprova com confirmarDivergencia:true (o humano decide VENDO)",
      mc5p1.json?.ok === true && !mc5p1.json?.duplicado &&
      mc5Ap1.status === 409 && mc5Ap1.json?.divergencia === true && Math.abs((mc5Ap1.json?.valorLido ?? 0) - 100) < 0.01 &&
      mc5Ap2.json?.ok === true,
      JSON.stringify({ a: mc5Ap1.status, div: mc5Ap1.json?.divergencia, lido: mc5Ap1.json?.valorLido, b: mc5Ap2.json?.ok }).slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5b@test.com", name: "MC5 B" });
    const mc5p2 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, consentimento: true, userName: "MC5 B", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150:E2EMC5AAA1:Pagador MC5", comprovante: Buffer.from("comp-mc5-b-refoto").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const mc5Ap3 = await req2("PATCH", "/api/pedido/" + mc5p2.json?.pedidoId, { status: "ativo", recebidoPor: "diego" });
    check("💼 MC5-P1: MESMA transação PIX (E2E) já ativa em OUTRO usuário, arquivo re-fotografado diferente — a aprovação barra com 409 'comprovante já usado' apontando o pedido e o e-mail originais (antes só a auditoria das 02h pegava, DEPOIS dos 💎 creditados)",
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
    check("💼 MC5-P2: /api/pedidos do usuário virou WHITELIST — sem preCheck cru (vazava e-mail de OUTRO usuário no dupAlerta), sem notaAdmin/criadoPor internos; comprovanteStatus derivado SEGURO (divergência vira 'analise' — nunca se avisa quem tenta fraude)",
      _rowA && !("preCheck" in _rowA) && !("notaAdmin" in _rowA) && !("criadoPor" in _rowA) &&
      _rowA.comprovanteStatus === "analise" && _rowA.comprovante === true && typeof _rowA.valorTotal === "number",
      JSON.stringify(_rowA).slice(0, 200));
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
    const dr3 = (await get("/api/admin/dono-resumo")).json;
    check("💼 MC5-P3 (bug real): 'gastos 30d' da Visão do Dono lia dataPagamento (gasto usa dataGasto) e mostrava R$0 SEMPRE — agora soma de verdade (fixtures ≥ R$35,50) e o líquido 30d fecha (dias30 − gastos30)",
      dr3?.ok === true && dr3.gastos30 >= 35.49 &&
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
      _srvSrc.includes("const gmailEmail = resolveSendGmail(p);") && _srvSrc.includes("gmailConnected,gmailEmail,needsPlan"),
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
      _srvSrc.includes("if (isAdminVip(p)) {") && /Math\.random\(\) \* \(i \+ 1\)/.test(_srvSrc) && _srvSrc.includes("pool.sort((a, b) => (countBySender[a.email]"),
      "embaralhamento aleatório do pool de senders do admin não encontrado");
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

    // 🎯 usuário comum (não-admin) NUNCA acessa Respostas Certas — é dado
    // privado do admin (respostas de e-mail de outra pessoa).
    const rcAsUser = await get("/api/admin/reply-triage/status");
    check("🎯 usuário comum recebe 403 em Respostas Certas (aba é admin-only de verdade, não só escondida no menu)",
      rcAsUser.status === 403, rcAsUser.body.slice(0, 120));

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
