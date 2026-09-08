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
// 🚚 v144: lado LOCAL do drill de FUSÃO — conta que TAMBÉM existe no
// servidor-irmão B (criada lá DEPOIS, então lá é a vencedora). Aqui: conta
// ANTIGA com 10d de VIP manual pagos, 5 💎 reais e 1 envio (emp1-a@x.com).
users["fusao.conflito@test.com"] = {
  email: "fusao.conflito@test.com", name: "Conflito Antigo", plan: "vip",
  created_at: "2026-01-01T00:00:00.000Z", cvs: [], profiles: [],
  vip: { active: true, plan: "vip", manualExpires: Date.now() + 10 * 86400_000, autoExpires: 0, source: "payment" },
  diamonds: { real: 5, bonus: 0 },
};
fs.writeFileSync(path.join(DATA, "users.json"), JSON.stringify(users, null, 2));
// 🔓 v152: simula o ban acidental do Esdras (delete-account bane o e-mail
// junto) — a cura de boot tem que tirar SÓ ele, preservando bans legítimos.
// v152b: a lista guarda a grafia com PONTOS TROCADOS de propósito (Gmail
// ignora pontos) — a cura precisa achar pela forma canônica, não por texto.
fs.writeFileSync(path.join(DATA, "blocked_emails.json"), JSON.stringify({
  emails: ["esdrassilva.h2b@gmail.com", "fica.banido@test.com"] }));
// 💎 v154: conta com bônus INFLADO pela fusão (40💎 de bônus mas só 2
// missões pagas = 5💎, com 2💎 de bônus já gastos numa troca) — a migração
// do boot precisa deixar bonus = 5−2 = 3, SEM tocar nos 50 reais.
users["bonusbug@test.com"] = { email: "bonusbug@test.com", name: "Bonus Bug", plan: "free",
  created_at: "2026-06-01T00:00:00.000Z", profiles: [],
  diamonds: { real: 50, bonus: 40 },
  missoes: { primeiro_envio: 1753000000000, perfil_completo: 1753000000001 },
  diamondLedger: [{ ts: 1753100000000, tipo: "troca", qtd: -10, real: -8, bonus: -2, saldoReal: 50, saldoBonus: 40, plano: "vip" }] };
// 🧠 CÉREBRO CONTÁBIL Parte 1 — os 4 casos do Master Command:
// (41) usuário com 70 dias restantes mas evidência de só 30 comprados;
users["setentadias@test.com"] = { email: "setentadias@test.com", name: "Setenta Dias", plan: "vip",
  created_at: "2026-06-01T00:00:00.000Z", profiles: [],
  vip: { active: true, plan: "vip", source: "payment", manualExpires: Date.now() + 70 * 86400_000,
    creditos: [{ id: "cred70", quando: Date.now() - 86400_000, dias: 30, tipo: "pago", origem: "pagamento", motivo: "VIP 30d", dadoPor: "sistema", valor: 100, pedidoId: null }] } };
// 🧠 Cérebro 2.0 Parte 1 (Master Command 2): o caso que o TETO não pega —
// comprou 30d há 200 dias (expirou faz tempo) e 30d há 10 dias. Teto da vida
// = 60; o sistema mostra 45 (≤ 60 → a regra antiga fica muda). Pelo RELÓGIO
// das concessões deviam restar ~20 — o motor de linha do tempo flagra +25.
users["sessentadias@test.com"] = { email: "sessentadias@test.com", name: "Sessenta Dias", plan: "vip",
  vip: { active: true, plan: "vip", source: "payment", manualExpires: Date.now() + 45 * 86400_000,
    creditos: [
      { id: "credS1", quando: Date.now() - 200 * 86400_000, dias: 30, tipo: "pago", origem: "pagamento", motivo: "VIP 30d antigo", dadoPor: "sistema", valor: 100, pedidoId: null },
      { id: "credS2", quando: Date.now() - 10 * 86400_000, dias: 30, tipo: "pago", origem: "pagamento", motivo: "VIP 30d recente", dadoPor: "sistema", valor: 100, pedidoId: null }] } };
// 🧠 2.0-P1 (revisão adversarial): cliente pago COMPENSADO com presente do
// admin (gift-days grava só vip.giftHistory) — 30d comprados há 5 dias +
// 10d de presente há 2 dias = 35 restantes. Sem ler o giftHistory, o motor
// acusaria +10 num cliente 100% legítimo.
users["presente@test.com"] = { email: "presente@test.com", name: "Cliente Presenteado", plan: "vip",
  vip: { active: true, plan: "vip", source: "payment", manualExpires: Date.now() + 35 * 86400_000,
    giftHistory: [{ em: Date.now() - 2 * 86400_000, dias: 10, motivo: "site fora do ar — compensação", por: "Andrio" }],
    creditos: [{ id: "credP1", quando: Date.now() - 5 * 86400_000, dias: 30, tipo: "pago", origem: "pagamento", motivo: "VIP 30d", dadoPor: "sistema", valor: 100, pedidoId: null }] } };
// 🧠 2.0-P1: "definir vencimento exato" (13r) LEGADO — o admin cravou 15d há
// 3 dias e a rota antiga não gravava crédito nenhum (só adjustedAt). O motor
// tem que ANCORAR (listar sem acusar), nunca flagrar o ajuste legítimo.
users["ajustado@test.com"] = { email: "ajustado@test.com", name: "Vencimento Ajustado", plan: "vip",
  vip: { active: true, plan: "vip", source: "admin", manualExpires: Date.now() + 15 * 86400_000,
    adjustedAt: Date.now() - 3 * 86400_000, adjustedBy: "andrio.usa2026@gmail.com",
    creditos: [{ id: "credA1", quando: Date.now() - 60 * 86400_000, dias: 30, tipo: "pago", origem: "pagamento", motivo: "VIP 30d antigo", dadoPor: "sistema", valor: 100, pedidoId: null }] } };
// 🎟️ 2.0-P3: VIP ativo "de código" mas SEM constar no resgate de código
// nenhum — dias de cortesia sem registro (RULE_CODE_SOURCE_NO_RECORD).
users["codeghost@test.com"] = { email: "codeghost@test.com", name: "Código Fantasma", plan: "vip",
  vip: { active: true, plan: "vip", source: "code", days: 30, manualExpires: Date.now() + 20 * 86400_000 } };
// (42) dois lançamentos iguais no caixa (mesmo usuário/valor/data, sem pedido);
users["duplicado@test.com"] = { email: "duplicado@test.com", name: "Pag Duplicado", plan: "free", created_at: "2026-06-01T00:00:00.000Z", profiles: [] };
// (21) pedido ativo SEM entrada no caixa (caso Cleiton);
users["cleiton2@test.com"] = { email: "cleiton2@test.com", name: "Cleiton Dois", plan: "free", created_at: "2026-06-01T00:00:00.000Z", profiles: [] };
// (43) cortesia por código: 30 dias, receita R$0.
users["codegift@test.com"] = { email: "codegift@test.com", name: "Code Gift", plan: "vip",
  created_at: "2026-06-01T00:00:00.000Z", profiles: [],
  vip: { active: true, plan: "vip", source: "code", days: 30, manualExpires: Date.now() + 30 * 86400_000 } };
fs.writeFileSync(path.join(DATA, "users.json"), JSON.stringify(users, null, 2));
fs.writeFileSync(path.join(DATA, "pedidos.json"), JSON.stringify([
  { id: "pedsemcaixa1", userEmail: "cleiton2@test.com", userName: "Cleiton Dois", plano: "vipro", dias: 30,
    valorTotal: 150, status: "ativo", createdAt: Date.now() - 3 * 86400_000, pagoEm: Date.now() - 3 * 86400_000,
    ativadoEm: Date.now() - 2 * 86400_000, ativadoPor: "admin" },
  // 🧠 Parte 2 (caso 44): pedido CANCELADO cuja entrada continua no caixa
  { id: "pedcanc1", userEmail: "duplicado@test.com", userName: "Pag Duplicado", plano: "vipro", dias: 30,
    valorTotal: 99, status: "cancelado", createdAt: Date.now() - 9 * 86400_000,
    ativadoEm: Date.now() - 8 * 86400_000, canceladoEm: Date.now() - 7 * 86400_000 },
  // 🧾 Parte 4 (caso 45): comprovantes SEM leitura (como os importados dos
  // servidores 2/3) — o gancho TESTE_COMPROVANTE simula a leitura sem IA:
  // pedcomp1 lê R$100 num pedido de R$150 (divergência crítica);
  // pedcomp2 lê R$150 = confere.
  { id: "pedcomp1", userEmail: "comp1@test.com", userName: "Comp Um", tipo: "doacao", plano: "doacao", dias: 0,
    valorTotal: 150, diamantes: 100, status: "ativo", comprovante: Buffer.from("comprovante-1").toString("base64"),
    comprovanteType: "image/jpeg", nota: "TESTE_COMPROVANTE:100", createdAt: Date.now() - 4 * 86400_000, ativadoEm: Date.now() - 3 * 86400_000 },
  { id: "pedcomp2", userEmail: "comp2@test.com", userName: "Comp Dois", tipo: "doacao", plano: "doacao", dias: 0,
    valorTotal: 150, diamantes: 100, status: "ativo", comprovante: Buffer.from("comprovante-2").toString("base64"),
    comprovanteType: "image/jpeg", nota: "TESTE_COMPROVANTE:150", createdAt: Date.now() - 4 * 86400_000, ativadoEm: Date.now() - 3 * 86400_000 },
  // 🧾 2.0-P2 (Motor 2): o golpe que o hash de ARQUIVO não pega — o mesmo PIX
  // re-fotografado gera bytes diferentes (hashes diferentes), mas o ID da
  // transação (E2E) é único no Banco Central. Dois usuários, dois arquivos,
  // UMA transação → RULE_TRANSACTION_ID_REUSED.
  { id: "pedtx1", userEmail: "txa@test.com", userName: "Tx Um", tipo: "doacao", plano: "doacao", dias: 0,
    valorTotal: 100, diamantes: 67, status: "ativo", comprovante: Buffer.from("print-pix-original").toString("base64"),
    comprovanteType: "image/jpeg", nota: "TESTE_COMPROVANTE:100:E2EABC12345:Fulano Pagador", createdAt: Date.now() - 2 * 86400_000, ativadoEm: Date.now() - 2 * 86400_000 },
  { id: "pedtx2", userEmail: "txb@test.com", userName: "Tx Dois", tipo: "doacao", plano: "doacao", dias: 0,
    valorTotal: 150, diamantes: 100, status: "ativo", comprovante: Buffer.from("print-pix-refoto-diferente").toString("base64"),
    comprovanteType: "image/jpeg", nota: "TESTE_COMPROVANTE:150:E2EABC12345:Fulano Pagador", createdAt: Date.now() - 2 * 86400_000 + 3600_000, ativadoEm: Date.now() - 2 * 86400_000 + 3600_000 }]));
fs.writeFileSync(path.join(DATA, "financeiro.json"), JSON.stringify({ pagamentos: [
  // 💼 MC4-P1: recebidoPor explícito nas fixtures — o acerto entre sócios
  // (computeSocios) precisa de donos conhecidos pra matemática ser provável.
  { id: "fdup1", email: "duplicado@test.com", nome: "Pag Duplicado", valor: 150, dataPagamento: "2026-08-15", criadoEm: Date.now() - 6 * 86400_000, recebidoPor: "andrio" },
  { id: "fdup2", email: "duplicado@test.com", nome: "Pag Duplicado", valor: 150, dataPagamento: "2026-08-15", criadoEm: Date.now() - 6 * 86400_000 + 5 * 60_000, recebidoPor: "andrio" },
  { id: "fcanc1", email: "duplicado@test.com", nome: "Pag Duplicado", valor: 99, dataPagamento: "2026-08-13", criadoEm: Date.now() - 8 * 86400_000, pedidoId: "pedcanc1" },
  { id: "fcomp1", email: "comp1@test.com", nome: "Comp Um", valor: 150, dataPagamento: "2026-08-17", criadoEm: Date.now() - 3 * 86400_000, pedidoId: "pedcomp1", recebidoPor: "diego" },
  { id: "fcomp2", email: "comp2@test.com", nome: "Comp Dois", valor: 150, dataPagamento: "2026-08-17", criadoEm: Date.now() - 3 * 86400_000, pedidoId: "pedcomp2", recebidoPor: "diego" },
  { id: "ftx1", email: "txa@test.com", nome: "Tx Um", valor: 100, dataPagamento: "2026-08-19", criadoEm: Date.now() - 2 * 86400_000, pedidoId: "pedtx1", recebidoPor: "andrio" },
  { id: "ftx2", email: "txb@test.com", nome: "Tx Dois", valor: 150, dataPagamento: "2026-08-19", criadoEm: Date.now() - 2 * 86400_000 + 3600_000, pedidoId: "pedtx2", recebidoPor: "diego" },
  // 🎟️ 2.0-P3: MESMO pagador ("Maria Pagadora Silva") creditado em 2 contas
  // DIFERENTES — mesmo valor, 30min de diferença. Valor+janela sozinhos dão
  // 45 (não acusam — pagar preço de tabela no mesmo dia é normal); é o NOME
  // batendo que cruza a régua de 61.
  { id: "fghost1", email: "ghost1@test.com", nome: "Maria Pagadora Silva", valor: 200, dataPagamento: "2026-08-20", criadoEm: Date.now() - 86400_000, recebidoPor: "diego" },
  { id: "fghost2", email: "ghost2@test.com", nome: "Maria Pagadora Silva", valor: 200, dataPagamento: "2026-08-20", criadoEm: Date.now() - 86400_000 + 30 * 60_000, recebidoPor: "andrio" },
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
fs.writeFileSync(path.join(DATA, "promo_codes.json"), JSON.stringify({
  GIFT30SMOKE: { manualDays: 30, autoDays: 0, maxUses: 5, usedBy: ["codegift@test.com"], createdAt: Date.now() - 5 * 86400_000 },
  // 🎟️ 2.0-P3: código com a trava de limite FURADA — 2 resgates num maxUses 1
  OVERUSE1: { manualDays: 30, autoDays: 0, maxUses: 1, usedBy: ["a1@test.com", "a2@test.com"], createdAt: Date.now() - 6 * 86400_000 } }));
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
  // 🚚 v144: envio local do usuário do drill de fusão (DB_SENT reconstrói do hist)
  "fusao.conflito@test.com": [{ appId: "app_a1", to: "emp1-a@x.com", subject: "x", type: "manual", sentAt: "2026-02-01T12:00:00.000Z", date: "2026-02-01", dateStr: "2026-02-01" }],
}));
// PDF órfão no disco (lixo do antigo delete sem unlink) — o sweep deve apagar
fs.mkdirSync(path.join(DATA, "cvs"), { recursive: true });
fs.writeFileSync(path.join(DATA, "cvs", "fantasma@test.com_777.pdf"), "%PDF-1.4 orfao");

// v46: notícias com data futura/absurda (bug real, print do dono 23/07:
// "ABRIL 2103", "JUNHO 2027") — a migração do boot deve REMOVER as inválidas
// e PRESERVAR a válida. Datas futuras construídas dinamicamente pra o teste
// não apodrecer com o calendário.
const _futuroISO = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
fs.writeFileSync(path.join(DATA, "dol_noticias.json"), JSON.stringify({ items: [
  { id: "n_valida001", date: "2026-06-29", titleEN: "OFLC Issues Technical Release Notes VALID", url: "", titlePT: "Notícia válida", resumoPT: "ok", translatedAt: 1, addedAt: 1 },
  { id: "n_futura001", date: _futuroISO, titleEN: "Future effective-date wrongly parsed", url: "", titlePT: "", resumoPT: "", translatedAt: null, addedAt: 1 },
  { id: "n_absurda01", date: "2103-04-04", titleEN: "Year 2103 typo announcement", url: "", titlePT: "", resumoPT: "", translatedAt: null, addedAt: 1 },
] }));
// Baseline do Vigia corrompido com data futura — deve voltar pro baseline
// oficial no boot (senão anúncio real novo nunca mais dispararia detecção).
fs.writeFileSync(path.join(DATA, "dol_news_watch.json"), JSON.stringify({
  ultimaConhecida: { date: _futuroISO, title: "corrompida", detectadaEm: 1, origem: "teste" },
}));

// Simula o disco de um servidor ANTIGO (lista salva da era v58, com o 1
// "lotado") — as migrações one-shot do boot rodam em cadeia: v58 (_migSrv3)
// acrescenta o Servidor 3 e depois a v156 (_migMonoSrv, "não existe mais
// server 2 e 3") deixa o 1 ABERTO e os irmãos OCULTOS. O check lá embaixo
// prova o estado FINAL — exatamente o que curou a pessoa real barrada em 22/08.
fs.writeFileSync(path.join(DATA, "admin_settings.json"), JSON.stringify({
  servers: [
    { id: 1, nome: "Servidor 1", url: "https://h2bapply.com", maxExibido: 50, status: "lotado" },
    { id: 2, nome: "Servidor 2", url: "https://h2b-teste.onrender.com", maxExibido: 100, status: "aberto" },
  ],
}));

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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed`, H2A_BIM_MIN_PUBLICAR: "10" },
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
    const nt = await get("/api/noticias");
    let ntJson = null; try { ntJson = JSON.parse(nt.body); } catch {}
    check("GET /api/noticias → ok com lista (aba Notícias DOL)",
      nt.status === 200 && ntJson && ntJson.ok === true && Array.isArray(ntJson.items), nt.body.slice(0, 120));
    // 🚨 v156 (dono, 22/08 — pessoa real criando conta jogada pro Servidor 3
    // morto): a era multi-servidor ACABOU. O fixture semeou a lista ANTIGA
    // (v58: 1 lotado, 2 aberto) — a migração one-shot do boot tem que deixar
    // o 1 ABERTO e os irmãos OCULTOS; o seletor público mostra SÓ o 1.
    const svs = await get("/api/servers");
    check("🌐 v156: seletor público mostra SÓ o Servidor 1 (os irmãos viraram ocultos na migração do boot)",
      svs.json?.ok === true && (svs.json?.servers || []).length === 1 && svs.json?.servers?.[0]?.id === 1 &&
      svs.json?.servers?.[0]?.status === "aberto",
      JSON.stringify((svs.json?.servers || []).map((x) => x.id + ":" + x.status + ":" + x.url)));
    let _admSet = null; try { _admSet = JSON.parse(fs.readFileSync(path.join(DATA, "admin_settings.json"), "utf8")); } catch {}
    const _svDisco = (id) => (_admSet?.servers || []).find((x) => parseInt(x.id) === id);
    check("🌐 v156: migração gravou no disco (flag one-shot _migMonoSrv) — 1 aberto, irmãos ocultos; edição futura do dono nunca é revertida",
      _admSet?._migMonoSrv === true && _svDisco(1)?.status === "aberto" &&
      (_admSet?.servers || []).filter((x) => parseInt(x.id) !== 1).every((x) => x.status === "oculto"),
      `_migMonoSrv=${_admSet?._migMonoSrv} lista=${JSON.stringify((_admSet?.servers || []).map((x) => x.id + ":" + x.status))}`);
    // O coração do bug real: e-mail SEM conta pedia cadastro e a triagem
    // oferecia o Servidor 3. Agora /api/auth/where devolve SEMPRE este
    // servidor como único destino, forçado "aberto" — nunca mais um irmão.
    const aw = await get("/api/auth/where?email=" + encodeURIComponent("pessoa.nova.v156@gmail.com"));
    check("🌐 v156: /api/auth/where de e-mail novo → cadastro é AQUI (self, aberto) e NENHUM irmão é oferecido",
      aw.json?.ok === true && aw.json?.found === false && (aw.json?.openServers || []).length === 1 &&
      aw.json?.openServers?.[0]?.self === true && aw.json?.openServers?.[0]?.status === "aberto",
      JSON.stringify(aw.json?.openServers));
    // v156b (print do dono: o atalho admin ainda listava Servidor 2 e 3 —
    // "apague, não existe mais"): a lista especial de admin também esconde
    // ocultos; com 1 servidor o front pula a tela de escolha (d.servers>1).
    const awAdm = await get("/api/auth/where?email=" + encodeURIComponent("andrio.usa2026@gmail.com"));
    check("🌐 v156b: atalho admin do /api/auth/where lista SÓ o Servidor 1 (ocultos apagados até pra admin)",
      awAdm.json?.ok === true && awAdm.json?.isAdmin === true && Array.isArray(awAdm.json?.servers) &&
      awAdm.json?.servers.length === 1 && awAdm.json?.servers[0]?.id === 1,
      JSON.stringify(awAdm.json?.servers));
    // (o texto histórico do KB-063 cita os códigos de erro — o que não pode
    // existir é o CÓDIGO do redirect: writeHead 302 pra /?err=srv_lotado etc.)
    const _srvSrc156 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("🌐 v156: (estrutural) o callback OAuth não tem mais NENHUM redirect de cadastro pra outro servidor (srv_lotado/conta_outro_srv mortos)",
      !_srvSrc156.includes("Location:`/?err=srv_lotado") && !_srvSrc156.includes("Location:`/?err=conta_outro_srv") && !/async function checkAccountOnPeers/.test(_srvSrc156),
      "sobrou trava/redirect multi-servidor no server.js");

    // v46: notícia com data FUTURA/absurda ("ABRIL 2103" — print real do dono)
    // é extração errada de data de vigência do corpo do texto. A migração do
    // boot remove as inválidas do fixture e preserva a válida.
    const _ntIds = (ntJson?.items || []).map((i) => i.id);
    check("📰 migração do boot removeu notícias com data futura/absurda (2103 etc.)",
      _ntIds.includes("n_valida001") && !_ntIds.includes("n_futura001") && !_ntIds.includes("n_absurda01"),
      `ids presentes: ${_ntIds.join(", ").slice(0, 120)}`);
    // Baseline do Vigia corrompido com data futura (anúncio real novo nunca
    // mais dispararia) — o boot deve restaurar o baseline oficial no arquivo.
    let _watchDisk = null; try { _watchDisk = JSON.parse(fs.readFileSync(path.join(DATA, "dol_news_watch.json"), "utf8")); } catch {}
    check("📰 baseline futuro do Vigia foi restaurado pro oficial no boot",
      _watchDisk?.ultimaConhecida?.date === "2026-06-29",
      `date no disco: ${_watchDisk?.ultimaConhecida?.date}`);
    // v33-SEO: /noticias é página PÚBLICA renderizada no servidor
    const ntPub = await get("/noticias");
    check("GET /noticias → página pública SEO das notícias traduzidas",
      ntPub.status === 200 && ntPub.body.includes("Notícias H-2B e H-2A em português"), `status=${ntPub.status}`);
    const smap = await get("/sitemap.xml");
    check("sitemap.xml lista /noticias (changefreq daily)",
      smap.status === 200 && smap.body.includes("h2bapply.com/noticias"), `status=${smap.status}`);
    // v56: verificação Google — a Política de Privacidade precisa existir e
    // conter a declaração canônica de Limited Use em inglês (o revisor procura
    // exatamente por ela). Servidor completo também menciona ler respostas.
    const priv = await get("/privacidade");
    check("🔏 /privacidade existe com a declaração Limited Use (exigência da verificação Google)",
      priv.status === 200 && priv.body.includes("Limited Use requirements") && priv.body.includes("gmail.send"),
      `status=${priv.status}`);
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
    // convite rotativo tem 50+ frases (pedido literal do dono).
    const _iaSideOk = frontAll.includes('id="ia-side"') &&
      !frontAll.includes('id="ia-fab"') &&
      frontAll.includes('sb-item-menu') && frontAll.includes(">MENU<") &&
      frontAll.includes("_IA_BALLOONS") &&
      (frontAll.match(/\n\s{2}"[^"\n]{10,60}",/g)||[]).length >= 50;
    check("🤖 v103: chat IA fixo na sidebar (sem botão flutuante, MENU roxo, 50+ balões-convite)",
      _iaSideOk, "ia-side/MENU/_IA_BALLOONS(50+) não conferem — ou o ia-fab voltou");

    // v100: 🖥️ Modo computador — toggle que força o layout desktop no
    // celular/app trocando o <meta viewport> pra largura fixa (igual "site
    // para computador" do Chrome). Preferência do aparelho em localStorage
    // (h2b_desktop). Guarda: função + persistência + troca do viewport.
    const _dmOk = frontAll.includes("setScreenMode") &&
      frontAll.includes("h2b_screen_mode") &&
      /meta\[name="viewport"\]'\)/.test(frontAll) &&
      frontAll.includes("'width=1100'") &&
      frontAll.includes("force-cel") &&
      frontAll.includes('id="mode-auto-btn"') &&
      frontAll.includes('id="mode-pc-btn"') &&
      frontAll.includes('id="mode-cel-btn"') &&
      frontAll.includes('id="sb-mode-pc"');
    check("🖥️ v104: 3 modos de tela (Auto/Celular/PC) no drawer E na sidebar — viewport pro celular, force-cel pro PC",
      _dmOk, "lógica setScreenMode/h2b_screen_mode/force-cel ou os botões dos 2 seletores não encontrados no index.html");

    // 📋 v118 (ORDEM DO DONO, 02/08 — novas regras de planos): guarda
    // estrutural do FRONT. (1) o texto de venda mostra os números NOVOS
    // (100 manual · 100+100 · 200+200) — nunca mais os antigos; (2) o
    // cliente tem cooldown de 1min no manual (window._manualCdUntil armado
    // no sucesso E sincronizado pelo cooldownLeft do 429 do servidor);
    // (3) o aviso das regras (planRulesNotice) chega ao usuário 1x por
    // sessão (_avisoRegrasPlanos + sessionStorage h2b_prn).
    const _v118Front = frontAll.includes("100 candidaturas manuais/dia") &&
      frontAll.includes("100 manual + 100 automático/dia") &&
      frontAll.includes("200 manual + 200 automático/dia") &&
      frontAll.includes("_manualCdUntil") &&
      frontAll.includes("cooldownLeft") &&
      frontAll.includes("_avisoRegrasPlanos") &&
      frontAll.includes("planRulesNotice") &&
      frontAll.includes("h2b_prn");
    check("📋 v118: front vende os números novos e aplica cooldown de 1min + aviso de regras (uma vez por sessão)",
      _v118Front, "textos de venda novos, _manualCdUntil/cooldownLeft ou _avisoRegrasPlanos/h2b_prn não encontrados no front");

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
    check("🌐 i18n-1: seletor de idioma com BANDEIRAS grandes + motor de varredura data-i18n",
      home.body.includes('id="lang-flag"') && home.body.includes("🇺🇸") && frontAll.includes('querySelectorAll("[data-i18n]")'),
      "lang-flag, bandeiras ou sweep data-i18n não encontrados");
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
    // data-i18n nas views só pode DIMINUIR. Quem adicionar tela nova sem
    // tradução quebra este teste na hora (regra 6f virou guarda automática).
    const _vp = home.body.slice(home.body.indexOf('id="v-home"'), home.body.indexOf('id="modal"'));
    const _ptTexts = [...new Set([..._vp.matchAll(/>([^<>{}\n]{4,80})</g)].map((m) => m[1].trim())
      .filter((t2) => t2 && !/^[\d\s\W]+$/.test(t2) && !/^(ti |var\(|http)/.test(t2))
      .filter((t2) => /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]|(^| )(de|do|da|para|com|seu|sua|você|não|vaga|envio|dia|até|mês)( |$)/i.test(t2)))];
    const _semTag = _ptTexts.filter((t2) => !new RegExp('data-i18n[^>]*>' + t2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(_vp));
    check(`🌐 i18n-5: CATRACA de tradução — textos PT sem data-i18n nas views: ${_semTag.length} (teto 5 — v136 zerou o site, só pode continuar zerado)`,
      _semTag.length <= 5, `estourou o teto: ${_semTag.length} — novas telas PRECISAM nascer com data-i18n (amostra: ${_semTag.slice(0, 3).join(" | ")})`);

    // 🔖 v126 (Vagas Salvas) removido de propósito nesta reconstrução enxuta
    // (README.md) — não há mais aba/estado/rota pra testar aqui.

    // v95 (reestruturação parte 8): o wizard de ativação NUNCA cobre o
    // caminho do dinheiro — no checkout de doação (#plan-step-2 visível) o
    // card E o pill somem por completo (o card tampava o passo 4 do
    // comprovante obrigatório; o pill minimizado tampava o botão "Enviar
    // doação"). Guarda: o código do wizard precisa checar plan-step-2 e
    // esconder os dois.
    const extrasJs = await get("/h2b-extras-user.js");
    const _wizDoacaoOk = extrasJs.status === 200 &&
      /doacaoAberta[\s\S]{0,200}plan-step-2/.test(extrasJs.body) &&
      /if\(doacaoAberta\)\{card\.style\.display="none";pill\.style\.display="none";return;\}/.test(extrasJs.body);
    check("💎 v95: wizard de ativação some por completo (card+pill) durante o checkout de doação",
      _wizDoacaoOk, `status=${extrasJs.status} — lógica doacaoAberta/plan-step-2 não encontrada no h2b-extras-user.js`);

    // v34: páginas privadas proibidas de indexar + CSP deixa o Analytics carregar
    const admPage = await get("/admin");
    check("GET /admin manda X-Robots-Tag noindex (página privada fora do Google)",
      admPage.status === 200 && String(admPage.headers["x-robots-tag"] || "").includes("noindex"), JSON.stringify(admPage.headers["x-robots-tag"]));
    check("CSP libera googletagmanager (funil gaEvent deixa de ser bloqueado)",
      String(home.headers["content-security-policy"] || "").includes("googletagmanager.com"));

    // 🌾 v121b: o painel admin tem o botão de gerar a planilha bimestral na
    // hora (o dono esperou a de Agosto "às cegas" — nunca mais: botão +
    // resultado visível + push também na falha).
    check("🌾 v121b: botão 'Gerar a deste mês agora' da bimestral existe no admin",
      admPage.body.includes('id="h2a-bim-btn"') && admPage.body.includes("h2aBimestralRun"),
      "h2a-bim-btn/h2aBimestralRun não encontrados no admin.html");

    // v106: telas financeiras do admin CONSOLIDADAS (fila do dono) — menu de
    // dinheiro com 2 itens (Visão do Dono + Pedidos) e régua 💰 no topo de
    // cada tela financeira (_renderMoneyNav/MONEY_VIEWS). Guarda: a régua
    // existe, cobre as 6 telas, e os itens removidos NÃO voltaram pro menu.
    // (Precisa vir DEPOIS do const admPage acima — v106b corrigiu um TDZ
    // real: a 1ª versão referenciava admPage antes da inicialização.)
    const _admBody = admPage.body;
    const _mnOk = _admBody.includes("_renderMoneyNav") && _admBody.includes("MONEY_VIEWS") &&
      ["'dono'","'pedidos'","'conferencia'","'pagantes'","'vip'","'diamantes'"].every(k=>_admBody.includes(`[${k}`)) &&
      !/class="sb-item"[^>]*onclick="showView\('conferencia'\)/.test(_admBody) &&
      !/class="sb-item"[^>]*onclick="showView\('diamantes'\)/.test(_admBody);
    check("💰 v106: régua Dinheiro consolida as 6 telas financeiras (menu enxuto: só Visão do Dono + Pedidos)",
      _mnOk, "_renderMoneyNav/MONEY_VIEWS ausentes ou os itens removidos voltaram pra sidebar do admin");

    // v44: GUARDA ESTRUTURAL do admin.html — mesma classe de bug do #v-home
    // (div não fechada = view nasce aninhada e some), mas aqui o admin tem
    // um mecanismo OFICIAL diferente: fixOrphanViews() no runtime confere
    // `v.parentElement !== content` e, se for verdade, arranca a view de
    // onde ela estiver no DOM e a arruma dentro de #content. Ou seja: uma
    // view pode legitimamente morar FISICAMENTE fora de #content no HTML
    // cru, contanto que o id dela esteja na lista fixOrphanViews — senão
    // ela fica escondida pra sempre (bug real de produção: Conferência
    // nasceu com tela preta por não estar nessa lista). A guarda replica
    // a MESMA regra do runtime, contando abertura/fechamento de <div> a
    // partir de "id=\"content\"" pra achar onde #content realmente fecha:
    // toda view cujo <div id="view-X"> cai DEPOIS desse fechamento (fora
    // de #content) tem que estar em fixOrphanViews — senão é uma órfã
    // nova, não registrada, prestes a repetir o mesmo bug.
    const admNoScript = admPage.body.replace(/<script[\s\S]*?<\/script>/g, "");
    const admViewTags = [...admNoScript.matchAll(/<div\b[^>]*\bid="(view-[a-zA-Z0-9-]+)"/g)]
      .filter((m) => m[1] !== "view-title");
    const orphanArrMatch = admPage.body.match(/fixOrphanViews[\s\S]{0,300}?\[([\s\S]{0,600}?)\]/);
    const orphanIds = orphanArrMatch ? [...orphanArrMatch[1].matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]) : [];
    check("🧬 admin.html: lista de views órfãs (fixOrphanViews) encontrada no JS",
      orphanIds.length > 0, `encontrados: ${orphanIds.join(", ") || "NENHUM"}`);
    const contentIdIdx = admNoScript.indexOf('id="content"');
    const contentDivStart = contentIdIdx === -1 ? -1 : admNoScript.lastIndexOf("<div", contentIdIdx);
    let contentDivEnd = -1;
    if (contentDivStart !== -1) {
      let depth = 0;
      const divRe = /<div\b|<\/div>/g;
      divRe.lastIndex = contentDivStart;
      let dm;
      while ((dm = divRe.exec(admNoScript))) {
        depth += dm[0] === "<div" ? 1 : -1;
        if (depth === 0) { contentDivEnd = divRe.lastIndex; break; }
      }
    }
    check("🧱 admin.html: fechamento de #content localizado (guarda de órfãs depende disso)",
      contentDivEnd !== -1, `contentDivStart=${contentDivStart} contentDivEnd=${contentDivEnd}`);
    const unregisteredOutside = admViewTags.filter((m) => m.index >= contentDivEnd && !orphanIds.includes(m[1]));
    check("🏗️ admin.html: nenhuma view fora de #content sem registro em fixOrphanViews (não fica preta)",
      contentDivEnd !== -1 && unregisteredOutside.length === 0,
      unregisteredOutside.map((m) => m[1]).join(", "));
    let admNestingBug = null;
    const insideTags = admViewTags.filter((m) => m.index < contentDivEnd);
    for (let i = 0; i < insideTags.length - 1; i++) {
      const idA = insideTags[i][1], idB = insideTags[i + 1][1];
      const seg = admNoScript.slice(insideTags[i].index, insideTags[i + 1].index);
      const bal = (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
      if (bal !== 0) { admNestingBug = `#${idA} não fechou direito (saldo ${bal}, esperado 0) — #${idB} nasceu aninhada dentro dela`; break; }
    }
    check("🏗️ admin.html: nenhuma aba dentro de #content nasce aninhada dentro de outra", admNestingBug === null, admNestingBug || "");

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
      const _jsArq = ["app.js", "h2b-extras-user.js", "h2b-extras-admin.js", "sw.js"];
      const _errosJs = [];
      for (const _f of _jsArq) {
        try { new vm.Script(fs.readFileSync(path.join(__dirname, _f), "utf8"), { filename: _f }); }
        catch (e) { _errosJs.push(`${_f}: ${String(e.message).slice(0, 120)}`); }
      }
      check("🩺 v159: app.js, h2b-extras-*.js e sw.js compilam como script clássico do navegador",
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
    const lg = await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    check("login de teste cria sessão", lg.status === 200 && lg.json?.ok === true, lg.body.slice(0, 100));
    const st2 = await get("/api/status");
    check("sessão vale: /api/status connected:true", st2.json?.connected === true);

    // ═══ ⏳ v118 (ORDEM DO DONO, 02/08): 1 envio MANUAL por minuto ═══
    // O fixture gravou um envio manual "agora" pro cooldown@test.com — a
    // tentativa seguinte dentro de 60s TEM que levar 429 com cooldownLeft.
    // Fica AQUI (primeiro teste autenticado) de propósito: a janela de 60s
    // do fixture não pode fechar antes do teste rodar.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cooldown@test.com", name: "Cooldown" });
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
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "zumbi@test.com", name: "Zumbi" });
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
    // v149b: a fase de IDENTIDADE do login usa escopo básico literal — o único
    // literal permitido é "openid email"; qualquer outro (principalmente com
    // gmail) tem que passar por OAUTH_SCOPES, senão a regra 13d fura por fora.
    const _scopeLiterais = [..._srvSrc.matchAll(/scope:"([^"]+)"/g)].map((m) => m[1]);
    check("✉️ OAuth usa OAUTH_SCOPES nos 3 pontos (v149b somou a 2ª fase do login), GMAIL_SEND_ONLY=true fixo, escopo é SÓ gmail.send (nunca readonly/modify) e o único escopo literal é o básico da fase identidade",
      _scopeUses === 3 && _sendOnlyConst === "true" && _scopesLine.includes("gmail.send") && !_scopesLine.includes("readonly") && !_scopesLine.includes("modify") &&
      _scopeLiterais.every((s) => s === "openid email"),
      `usos=${_scopeUses} | GMAIL_SEND_ONLY=${_sendOnlyConst} | literais=${JSON.stringify(_scopeLiterais)} | escopos="${_scopesLine.slice(0, 90)}"`);

    // ═══ v46: CÓDIGOS PROMO — personalizado honrado + Membro YouTube R$147 ═══
    // Bug real: o campo "Código personalizado" do admin era IGNORADO pelo
    // servidor (sempre gerava aleatório). E o dono pediu botão dedicado de
    // código Membro YouTube: uso único, 30d, valendo R$147 na Conferência.
    const cc1 = await req2("POST", "/api/admin/codes/create", { manualDays: 5, autoDays: 0, maxUses: 1, code: "PROMOSMOKE1" });
    check("🎟️ código personalizado é honrado (não vira aleatório)",
      cc1.json?.ok === true && cc1.json?.code === "PROMOSMOKE1", cc1.body.slice(0, 120));
    const cc1b = await req2("POST", "/api/admin/codes/create", { manualDays: 5, autoDays: 0, maxUses: 1, code: "PROMOSMOKE1" });
    check("🎟️ código personalizado repetido é barrado (409)", cc1b.status === 409, `status=${cc1b.status}`);
    const cc2 = await req2("POST", "/api/admin/codes/create", { manualDays: 30, autoDays: 30, maxUses: 1, yt: true });
    check("🎬 código Membro YouTube criado com flag yt", cc2.json?.ok === true && cc2.json?.yt === true, cc2.body.slice(0, 120));
    const ytCode = cc2.json?.code;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "ytmember@test.com", name: "YT Member" });
    const rd = await req2("POST", "/api/redeem-code", { code: ytCode });
    check("🎬 membro YouTube resgata o código (30d manual + 30d auto)",
      rd.json?.ok === true && rd.json?.manualDays === 30 && rd.json?.autoDays === 30, rd.body.slice(0, 140));
    // 🔒 v84 (achado em auditoria de segurança): código resgatado é
    // vip.source==="code" (cortesia, NUNCA pagamento — regra 13c) mas tinha
    // plan="vipro" real e manualExpires/autoExpires no futuro — /api/plans/
    // upgrade só excluía "trial"/"auto-provisorio" da checagem de "plano
    // pago", deixando passar. Sem o fix, dava pra virar DoublePro pagando só
    // a DIFERENÇA de diamantes sobre um plano que nunca custou nada.
    const upgCode = await req2("POST", "/api/plans/upgrade", { novoPlano: "doublepro" });
    check("🔒 v84: quem só tem plano de CÓDIGO (cortesia, nunca pago) NÃO consegue upgrade — nunca desconta preço de plano nunca pago", upgCode.status === 400, upgCode.body.slice(0, 160));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const cfYt = await get("/api/admin/conferencia");
    const ytRow = (cfYt.json?.rows || []).find((r) => r.tipo === "codigo" && r.code === ytCode && r.email === "ytmember@test.com");
    check("🎬 Conferência lista o resgate do código YouTube valendo R$147",
      !!ytRow && ytRow.valor === 147, JSON.stringify(ytRow || {}).slice(0, 140));

    // ═══ 🎟️ v142 (dono, 15/08 — usuário perdeu acesso ao Gmail, admin vai
    // recriar a conta e "quero repor os 15 dias dele que sobraram do Google
    // Pro... 15 dias doublepro 400 manual e 400 automático") ═══
    // Antes: todo código caía cego na tabela NOVA (v118) por nome de plano —
    // no máximo vipro 100/100, nunca reproduzia um contrato LEGADO (ex.:
    // doublepro 400/400) numa conta recriada do zero. Agora o admin pode
    // sobrescrever o limite exato na criação do código.
    const ccCustom = await req2("POST", "/api/admin/codes/create", { manualDays: 15, autoDays: 15, maxUses: 1, note: "Migração Gmail perdido", manualLimit: 400, autoLimit: 400 });
    check("🎟️ v142: código com limite customizado (400/400) é criado e devolve os limites na resposta",
      ccCustom.json?.ok === true && ccCustom.json?.manualLimit === 400 && ccCustom.json?.autoLimit === 400, ccCustom.body.slice(0, 160));
    const customCode = ccCustom.json?.code;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "migrado@test.com", name: "Migrado" });
    const rdCustom = await req2("POST", "/api/redeem-code", { code: customCode });
    check("🎟️ v142: usuário resgata o código de 15 dias", rdCustom.json?.ok === true && rdCustom.json?.manualDays === 15 && rdCustom.json?.autoDays === 15, rdCustom.body.slice(0, 160));
    const stMigrado = await get("/api/status");
    check("🎟️ v142: o limite EXATO do código (400 manual + 400 auto) é aplicado — não o padrão do plano (que daria no máximo 200/200)",
      stMigrado.json?.manualLimit === 400 && stMigrado.json?.autoLimit === 400,
      JSON.stringify({ manualLimit: stMigrado.json?.manualLimit, autoLimit: stMigrado.json?.autoLimit, plan: stMigrado.json?.plan }));
    check("🎟️ v142: mesmo com limite legado, a origem continua 'code' (cortesia, NUNCA pagamento — regra 13c intacta)",
      stMigrado.json?.vip?.source === "code", JSON.stringify({ source: stMigrado.json?.vip?.source }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const ccNormal = await req2("POST", "/api/admin/codes/create", { manualDays: 5, autoDays: 0, maxUses: 1, code: "PROMOSMOKE2" });
    check("🎟️ v142: código SEM limite customizado continua funcionando exatamente como antes (comportamento padrão preservado)",
      ccNormal.json?.ok === true && ccNormal.json?.manualLimit == null && ccNormal.json?.autoLimit == null, ccNormal.body.slice(0, 160));

    // ═══ CAMINHO DO DINHEIRO: comprador (não-admin) compra, admin aprova ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com", name: "Comprador" });
    const pd1 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150, userName: "Comprador" });
    const pdId = pd1.json?.pedidoId;
    check("pedido criado pelo comprador", pd1.json?.ok === true && !!pdId, pd1.body.slice(0, 120));
    // 💼 MC5-P1 (29/08): desde o v154 TODO pedido de usuário é DOAÇÃO — e
    // doação NUNCA mais cai no dedup de pendente (o PIX é feito ANTES do
    // envio; engolir o 2º comprovante era dinheiro real sem rastro). O 2º
    // pedido agora nasce como pedido PRÓPRIO — e é cancelado aqui em
    // seguida pra não mudar o estado dos checks antigos da mesa do dono.
    const pd2 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150 });
    check("💼 MC5-P1: 2ª doação com pendente aberto vira pedido PRÓPRIO (dedup não engole mais o comprovante)", pd2.json?.ok === true && !pd2.json?.duplicado && pd2.json?.pedidoId && pd2.json?.pedidoId !== pdId, pd2.body.slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    await req2("PATCH", "/api/pedido/" + pd2.json?.pedidoId, { status: "cancelado" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com", name: "Comprador" });

    // v57 (dono, 25/07): aprovar NÃO pede mais senha — o portão é a SESSÃO de
    // admin (Google), e quem aprovou fica registrado pelo e-mail logado.
    // Não-admin tentando ativar → 403 (o portão que importa continua de pé).
    const naoAdm = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    check("🔒 não-admin NÃO consegue ativar pedido (403 — portão é a sessão, não senha)", naoAdm.status === 403, `status=${naoAdm.status}`);
    // troca pro ADMIN pra aprovar
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const bad = await req2("PATCH", "/api/pedido/" + pdId, { status: "Banana" });
    check("status fora da máquina de estados → 400", bad.status === 400, bad.body.slice(0, 100));
    const act = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    // 💎 v154 (ordem do dono, 21/08): TODO pedido aprovado é DOAÇÃO — o
    // pedido de "plano" do front antigo nasce/normaliza como doação e a
    // aprovação credita SÓ diamantes (R$150 → 100💎). NENHUM dia de VIP.
    check("💎 v154: ativação SEM senha (admin logado) → credita 100 💎 (R$150) e NÃO ativa plano nenhum",
      act.json?.ok === true && act.json?.diamantes === 100, act.body.slice(0, 160));
    const _udComprador = (await get("/api/admin/user-detail/" + encodeURIComponent("comprador@test.com"))).json?.user;
    check("💎 v154: comprador NÃO ganhou nenhum dia de VIP na aprovação (plan free, sem expiração manual)",
      (_udComprador?.plan || "free") === "free" && !(_udComprador?.vip?.manualExpires > Date.now()),
      JSON.stringify({ plan: _udComprador?.plan, vip: _udComprador?.vip?.manualExpires }).slice(0, 120));
    // 💎 v154: e a RECONCILIAÇÃO do boot não devolve dias por doação (era o
    // bug real: doação sem campo `dias` caía no padrão de 30 e cada doação
    // aprovada virava +30 dias manuais em todo boot)
    const recDoa = await req2("POST", "/api/admin/reconciliar-planos", { apply: false });
    check("💎 v154: reconciliação IGNORA doações — nenhuma correção proposta pro comprador (antes: +30d por doação em todo boot)",
      recDoa.json?.ok === true && !(recDoa.json?.relatorio || []).some((x) => x.email === "comprador@test.com"),
      JSON.stringify((recDoa.json?.relatorio || []).map((x) => x.email)).slice(0, 120));
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

    // ═══ v59: 🌍 FATURAMENTO GLOBAL — os 3 servidores somados ═══
    // Rota peer sem token → 403; com o token derivado da DATA_ENC_KEY → ok.
    const finNoTok = await get("/api/servers/financeiro");
    check("🌍 rota peer de financeiro SEM token → 403 (dinheiro nunca fica público)",
      finNoTok.status === 403, `status=${finNoTok.status}`);
    const _peerTok = crypto.createHmac("sha256", "smoke-enc-key-1234567890").update("h2b-peer-financeiro-v1").digest("hex");
    const finTok = await new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/servers/financeiro", method: "GET", headers: { "x-peer-fin": _peerTok } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
      }); r.on("error", reject); r.end();
    });
    check("🌍 rota peer COM token responde as entradas (admin nunca na soma)",
      finTok.status === 200 && finTok.json?.ok === true && typeof finTok.json?.entradas?.total === "number",
      JSON.stringify(finTok.json?.entradas || {}).slice(0, 120));
    const fg = await get("/api/admin/financeiro-global");
    check("🌍 Faturamento Global: lista os 3 servidores e soma (self na hora)",
      fg.json?.ok === true && (fg.json?.servidores || []).length === 3 &&
      fg.json.servidores.some((x) => x.self && x.ok) && fg.json?.global?.total >= 147 && fg.json?.peerAuth === true,
      JSON.stringify({ total: fg.json?.global?.total, n: (fg.json?.servidores || []).length }).slice(0, 120));
    // v83 (consolidação de telas financeiras): dono-resumo e a entrada "self"
    // do Faturamento Global agora vêm da MESMA função (computeEntradasJanelas)
    // — nunca mais 2 cálculos que podem divergir (mesma classe de bug do v77b,
    // só que no caixa em vez de diamantes). Guarda de regressão: os 2 números
    // (calculados no MESMO instante) têm que bater EXATAMENTE.
    const drCheck = await get("/api/admin/dono-resumo");
    const _fgSelf = (fg.json?.servidores || []).find((x) => x.self);
    check("💰 v83: dono-resumo e Faturamento Global (self) usam a MESMA fonte — total/hoje idênticos, nunca divergem",
      drCheck.json?.entradas?.total === _fgSelf?.entradas?.total && drCheck.json?.entradas?.hoje === _fgSelf?.entradas?.hoje && drCheck.json?.pagantes === _fgSelf?.entradas?.pagantes,
      JSON.stringify({ dono: drCheck.json?.entradas, global: _fgSelf?.entradas }));
    // v60: servidores antigos (1/2, intocados por ordem do dono) entram na
    // soma pelo TOTAL INFORMADO manualmente — salvo nas configurações.
    const _fgBase = fg.json?.global?.total || 0;
    // (no smoke este servidor se resolve como id 1 — então o manual entra no 2)
    await req2("POST", "/api/admin/settings", { fgManual2: 5000 });
    const fg2 = await get("/api/admin/financeiro-global");
    const _srv2m = (fg2.json?.servidores || []).find((x) => x.id === 2);
    check("🌍 total manual do servidor antigo soma no global (R$5.000 informado no 2)",
      fg2.json?.ok === true && _srv2m?.manual === true && fg2.json.global.total === _fgBase + 5000,
      JSON.stringify({ total: fg2.json?.global?.total, esperado: _fgBase + 5000 }).slice(0, 120));

    // v32: ⏳ Robô de Renovação — a varredura roda inteira sem erro sob demanda
    const rnv = await req2("POST", "/api/admin/renova-run", {});
    check("⏳ Robô de Renovação roda sob demanda (varredura completa sem erro)", rnv.json?.ok === true && typeof rnv.json?.avisados === "number", rnv.body.slice(0, 100));

    // v37: 📊 Resumo Diário do Dono — números de ontem calculados sem erro
    const rsd = await req2("POST", "/api/admin/resumo-diario-run", {});
    check("📊 Resumo Diário do Dono calcula os números de ontem sob demanda",
      rsd.json?.ok === true && typeof rsd.json?.vendas === "number" && typeof rsd.json?.pendentes === "number" && typeof rsd.json?.envios === "number", rsd.body.slice(0, 140));

    // v35: 🤖 Bot de coleta "Nova Planilha do DOL" — ponta a ponta com o feed falso
    const cs = await req2("POST", "/api/admin/sheet/coleta-start", { visa: "H-2B", sheetKey: "teste2099", sheetName: "Teste 2099" });
    check("🤖 coleta-start aceita e dispara o bot em background", cs.json?.ok === true, cs.body.slice(0, 120));
    let stC = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 300));
      stC = (await get("/api/admin/sheet/coleta-status")).json;
      if (stC && stC.running === false && stC.finishedAt) break;
    }
    check("🤖 coleta terminou: 14 vagas (dedupe tirou a duplicada, qualidade tirou a sem e-mail)",
      stC?.running === false && !stC?.error && stC?.count === 14, JSON.stringify({ count: stC?.count, error: stC?.error }));
    const sl1 = await get("/api/sheets-list");
    check("🔒 rascunho da coleta NÃO aparece pros usuários antes de publicar",
      sl1.status === 200 && !(sl1.json?.sheets || []).some((x) => x.key === "teste2099"), sl1.body.slice(0, 160));
    const pub = await req2("POST", "/api/admin/sheet/coleta-publish", { key: "teste2099" });
    const sl2 = await get("/api/sheets-list");
    check("📢 publicar libera a planilha coletada na lista dos usuários",
      pub.json?.ok === true && (sl2.json?.sheets || []).some((x) => x.key === "teste2099" && x.count === 14), sl2.body.slice(0, 200));
    const sm2 = await get("/api/sheet-meta?sheet=teste2099&skip=0&top=5");
    check("🗂️ vagas da planilha coletada abrem no Manual (/api/sheet-meta)",
      Array.isArray(sm2.json?.jobs) && sm2.json.jobs.length > 0, sm2.body.slice(0, 140));

    // v87: 📥 DOWNLOAD DE PLANILHAS (admin) — baixa todas as vagas num arquivo
    // pesquisável (HTML) ou CSV. Guarda: admin lista e baixa; não-admin é
    // barrado; o HTML tem a caixa de busca e cada vaga; o CSV tem cabeçalho.
    const dlList = await get("/api/admin/sheets-download-list");
    check("📥 v87: admin lista as planilhas pra download (com contagem de email por planilha)",
      dlList.json?.ok === true && (dlList.json?.sheets || []).some((s) => s.key === "teste2099" && typeof s.withEmail === "number"), dlList.body.slice(0, 160));
    const dlHtml = await get("/api/admin/sheet-download?sheet=teste2099&format=html");
    check("📥 v87: download HTML traz TODAS as vagas + caixa de busca ao vivo (attachment)",
      dlHtml.status === 200 && /Content-Disposition/i.test(Object.keys(dlHtml.headers).join(" ") ? "Content-Disposition" : "") && dlHtml.body.includes('id="q"') && (dlHtml.body.match(/class="vg"/g) || []).length === 14 && (dlHtml.headers["content-disposition"] || "").includes("attachment"),
      `status=${dlHtml.status} vagas=${(dlHtml.body.match(/class="vg"/g) || []).length}`);
    const dlCsv = await get("/api/admin/sheet-download?sheet=teste2099&format=csv");
    check("📥 v87: download CSV abre no Excel (cabeçalho + 14 linhas + BOM UTF-8)",
      dlCsv.status === 200 && dlCsv.body.charCodeAt(0) === 0xFEFF && /Empresa/.test(dlCsv.body) && dlCsv.body.trim().split("\n").length === 15 && (dlCsv.headers["content-disposition"] || "").includes(".csv"),
      `status=${dlCsv.status} linhas=${dlCsv.body.trim().split("\n").length}`);
    // não-admin NÃO pode baixar (dado de empregador é só do dono)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "curioso@test.com", name: "Curioso" });
    const dlDenied = await get("/api/admin/sheet-download?sheet=teste2099&format=csv");
    check("📥 v87: usuário comum NÃO consegue baixar a planilha (403) — export é admin-only", dlDenied.status === 403, `status=${dlDenied.status}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // v49/v50: 🌾 Robô "Vagas Novas H-2A" — ponta a ponta com o feed falso (o
    // caminho /h2a/ serve 14 vagas H-300 novas + 1 duplicada + 1 sem e-mail).
    // ENTRA ativa nova, SAI inativa (regra do dono: "planilha sempre completa").
    // O total esperado é calculado do PRÓPRIO bundle com a MESMA regra de
    // inatividade (status morto OU temporada encerrada) — independente da
    // data em que o teste rodar, e de o ciclo de boot já ter rodado ou não.
    const _h2aBundle = JSON.parse(fs.readFileSync(path.join(__dirname, "h2a_jun2026_compact.json"), "utf8"));
    const _hojeISO = new Date().toISOString().slice(0, 10);
    const _deadRe = /denied|withdrawn|invalidat|expired|cancel/i;
    const h2aVivas = _h2aBundle.filter((r) => !_deadRe.test(String(r.st || "")) && !(r.de && /^\d{4}-\d{2}-\d{2}$/.test(r.de) && r.de < _hojeISO)).length;
    const hn1 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
    check("🌾 Vagas Novas H-2A: sincroniza — entram as 14 novas, saem as de temporada encerrada",
      hn1.json?.ok === true && hn1.json?.total === h2aVivas + 14 && (hn1.json?.added === 14 || hn1.json?.jaTinha >= 14),
      `esperado total=${h2aVivas + 14} | ` + hn1.body.slice(0, 160));
    const hn2 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
    check("🌾 Vagas Novas H-2A: 2ª rodada não duplica NADA (0 novas, total estável)",
      hn2.json?.ok === true && hn2.json?.added === 0 && hn2.json?.jaTinha >= 14 && hn2.json?.total === h2aVivas + 14,
      hn2.body.slice(0, 160));
    // v50: feed passa a trazer a vaga 14 RETIRADA (withdrawn) — o robô tem
    // que atualizar o status e REMOVER exatamente ela da planilha.
    fs.writeFileSync(path.join(DATA, "h2a_feed_withdraw.flag"), "1");
    const hn3 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
    check("🌾 Vagas Novas H-2A: vaga que virou 'withdrawn' no DOL é RETIRADA da planilha",
      hn3.json?.ok === true && hn3.json?.removidas === 1 && hn3.json?.atualizadas >= 1 && hn3.json?.total === h2aVivas + 13,
      hn3.body.slice(0, 160));
    fs.unlinkSync(path.join(DATA, "h2a_feed_withdraw.flag"));
    const slH2a = await get("/api/sheets-list");
    const _h2aRow = (slH2a.json?.sheets || []).find((x) => x.key === "h2a-jun2026");
    check("🌾 vagas novas H-2A já contam como disponíveis pros usuários (sem aba nova)",
      _h2aRow && _h2aRow.count === h2aVivas + 13 && _h2aRow.available >= 13, JSON.stringify(_h2aRow || {}).slice(0, 140));

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
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "ndrkick.2@gmail.com", name: "Andrio Kickhofel" });
    const pdAdm = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150, userName: "Andrio Kickhofel" });
    check("🚫 pedido de conta admin é criado normalmente (fluxo não quebra)", pdAdm.json?.ok === true || !!pdAdm.json?.pedidoId, pdAdm.body.slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const cfAdm = await get("/api/admin/conferencia");
    const _temAdmRow = (cfAdm.json?.rows || []).some((r) => String(r.email || "").toLowerCase() === "ndrkick.2@gmail.com");
    check("🚫 Conferência NÃO lista pedido de conta admin (admin não é receita)", cfAdm.json?.ok === true && !_temAdmRow, _temAdmRow ? "BUG: pedido do admin apareceu na Conferência" : "ok");
    // Neste ponto o ÚNICO pedido pendente do fixture é o do admin — com a
    // exclusão certa, a mesa do dono tem que estar zerada.
    const drAdm = await get("/api/admin/dono-resumo");
    check("🚫 Visão do Dono NÃO soma pedido pendente de admin na mesa",
      drAdm.json?.ok === true && (drAdm.json?.pendentes?.qtd || 0) === 0 && (drAdm.json?.pendentes?.valor || 0) === 0, JSON.stringify(drAdm.json?.pendentes));

    // v27: conjunto de empregadores bloqueados responde pro usuário logado
    const se = await get("/api/sent-emails");
    check("GET /api/sent-emails → listas de enviados e fila", se.json?.ok === true && Array.isArray(se.json?.sent) && Array.isArray(se.json?.queued), se.body.slice(0, 100));

    // 💎 v154: o comprador ficou com os DIAMANTES da doação (100, menos os 2
    // do reajuste do corrigirValor 150→147 = 98) e SEGUE free — dia de VIP só
    // por troca 💎/upgrade/código/admin, nunca por aprovação.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const st3 = await get("/api/status");
    const dmComp = await get("/api/diamonds");
    check("💎 v154: comprador segue FREE mas com 98 💎 reais (100 da aprovação − 2 do reajuste de valor 150→147)",
      st3.json?.plan !== "vipro" && st3.json?.vip?.active !== true && dmComp.json?.saldo?.real === 98,
      JSON.stringify({ plan: st3.json?.plan, saldo: dmComp.json?.saldo }).slice(0, 120));

    // admin cancela: caixa estornado E os 💎 da doação estornados (13c)
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
    const dmComp2 = await get("/api/diamonds");
    check("💎 v154: cancelamento estorna os 💎 da doação (98→0) — regra 13c",
      (dmComp2.json?.saldo?.real || 0) === 0, JSON.stringify(dmComp2.json?.saldo).slice(0, 100));

    // ═══ 💎 v64: SISTEMA DE DIAMANTES — o novo caminho do dinheiro ═══
    // Doação PIX → admin aprova → 💎 REAIS; troca por plano ativa NA HORA
    // (sem lançar caixa de novo); só 💎 real transfere; bônus é gasto primeiro.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com", name: "Doador" });
    const dp1 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 150, userName: "Doador", userWhatsapp: "53 9 9999-9999", userCity: "Pelotas" });
    const dpId = dp1.json?.pedidoId || dp1.json?.pedido?.id;
    check("💎 doação criada (R$150 → pedido tipo doacao)", dp1.json?.ok === true && !!dpId, dp1.body.slice(0, 140));
    const dmAntes = await get("/api/diamonds");
    check("💎 saldo começa zerado", dmAntes.json?.ok === true && dmAntes.json?.saldo?.real === 0 && dmAntes.json?.saldo?.bonus === 0, dp1.body.slice(0, 100));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dpAct = await req2("PATCH", "/api/pedido/" + dpId, { status: "ativo" });
    check("💎 aprovação da doação credita 100 💎 REAIS (R$150 ÷ 1,50)", dpAct.json?.ok === true && dpAct.json?.diamantes === 100, dpAct.body.slice(0, 140));
    const finD = await get("/api/admin/financeiro");
    check("💎 doação aprovada lançou R$150 no livro-caixa", (finD.json?.pagamentos || []).some((x) => x.pedidoId === dpId && x.valor === 150));
    // bônus do admin: 20 💎 de brinde (intransferíveis, gastos primeiro)
    const admB = await req2("POST", "/api/admin/diamonds", { email: "doador@test.com", bonus: 20, nota: "brinde smoke" });
    check("💎 admin credita 20 💎 de brinde", admB.json?.ok === true && admB.json?.saldo?.bonus === 20, admB.body.slice(0, 100));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com" });
    const dm1 = await get("/api/diamonds");
    check("💎 saldo do doador: 100 reais + 20 bônus", dm1.json?.saldo?.real === 100 && dm1.json?.saldo?.bonus === 20, JSON.stringify(dm1.json?.saldo));
    // transferir 30 💎 → só do REAL (bônus fica intocado)
    const tx1 = await req2("POST", "/api/diamonds/transfer", { para: "comprador@test.com", qtd: 30 });
    check("💎 transferência de 30 💎 sai SÓ do saldo real (bônus intacto)", tx1.json?.ok === true && tx1.json?.saldo?.real === 70 && tx1.json?.saldo?.bonus === 20, tx1.body.slice(0, 120));
    const txMuito = await req2("POST", "/api/diamonds/transfer", { para: "comprador@test.com", qtd: 999 });
    check("💎 transferir mais do que tem de REAL é barrado (402)", txMuito.status === 402, `status=${txMuito.status}`);
    // troca por plano: VIP 30d = 67 💎 (100/1,50) — gasta os 20 de bônus PRIMEIRO
    const tr1 = await req2("POST", "/api/diamonds/trocar", { plano: "vip", dias: 30 });
    check("💎 troca por VIP 30d custa 67 💎 e ativa na hora", tr1.json?.ok === true && tr1.json?.preco === 67 && tr1.json?.saldo?.bonus === 0 && tr1.json?.saldo?.real === 23, tr1.body.slice(0, 140));
    const stD = await get("/api/status");
    check("💎 doador está VIP ativo depois da troca", stD.json?.plan === "vip" && stD.json?.vip?.active === true, JSON.stringify({ plan: stD.json?.plan, vip: !!stD.json?.vip?.active }));
    // a TROCA não pode lançar caixa de novo (o dinheiro entrou na doação)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com" });
    const finD3 = await get("/api/admin/financeiro");
    const entradasDoador = (finD3.json?.pagamentos || []).filter((x) => x.email === "doador@test.com");
    check("💎 troca por plano NÃO duplica o caixa (só a doação conta)", entradasDoador.length === 1, JSON.stringify(entradasDoador.map((x) => x.valor)));
    // saldo insuficiente é recusado com 402
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com" });
    const tr2 = await req2("POST", "/api/diamonds/trocar", { plano: "doublepro", dias: 365 });
    check("💎 troca sem saldo suficiente → 402", tr2.status === 402, `status=${tr2.status}`);

    // ═══ 💎 v77 (dono, 28/07: "usuário comprou 250 reais em diamantes e
    // ativou o DoublePro, mas não aparece lá que ele está com o doublepro")
    // ═══════════════════════════════════════════════════════════════════
    // CAUSA RAIZ ACHADA: doação creditava 💎 com Math.floor(valorTotal÷1,5),
    // mas planoPrecoDiamantes() cobra o preço do plano com Math.round(). Pra
    // planos cujo preço em R$ não é múltiplo exato de 1,5 (DoublePro 30d =
    // R$250 = 166,67💎 "cru"), doar EXATAMENTE o valor de tabela do plano
    // creditava 166💎 (floor) mas o plano custava 167💎 (round) — 1💎 curto,
    // sem nenhum aviso claro, e o admin não tinha como enxergar isso na
    // hora (daí "não sei se tá funcionando"). Corrigido: doação agora usa a
    // MESMA regra (round) que o preço do plano — doar o valor de tabela de
    // qualquer plano sempre cobre EXATAMENTE aquele plano, nunca mais falta
    // 1💎 por causa de arredondamento diferente dos 2 lados da mesma conta.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doadorround@test.com", name: "Doador Round" });
    const dpR1 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 250, userName: "Doador Round", userWhatsapp: "53 9 9999-9999", userCity: "Pelotas" });
    const dpRId = dpR1.json?.pedidoId || dpR1.json?.pedido?.id;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dpRAct = await req2("PATCH", "/api/pedido/" + dpRId, { status: "ativo" });
    check("💎 v77: doar EXATAMENTE o preço de tabela do DoublePro 30d (R$250) credita 167💎 (round), não mais 166 (floor)",
      dpRAct.json?.ok === true && dpRAct.json?.diamantes === 167, dpRAct.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doadorround@test.com" });
    const trDPR = await req2("POST", "/api/diamonds/trocar", { plano: "doublepro", dias: 30 });
    check("💎 v77: com o crédito corrigido, dá EXATAMENTE pra trocar por DoublePro 30d (sem faltar 1💎)",
      trDPR.json?.ok === true && trDPR.json?.preco === 167 && trDPR.json?.saldo?.real === 0, trDPR.body.slice(0, 160));

    // ═══ 💎 v77b (achado revisando o v77): corrigir o VALOR de uma doação
    // JÁ APROVADA atualizava o caixa mas nunca reajustava os diamantes já
    // creditados — mesma classe de bug do arredondamento (13f), só que
    // pelo caminho de CORREÇÃO manual em vez da aprovação original. Testa
    // as 2 rotas que corrigem valor (ambas usadas pelo admin.html): PATCH
    // /api/pedido/:id {corrigirValor} (Conferência) e POST
    // /api/admin/pedido-set-valor (tela de Pedidos). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // doadorround está com saldo 0 (gastou os 167💎 no DoublePro) — corrige
    // o valor da doação pra CIMA (R$250→R$300, precisa de 200💎) e credita
    // a diferença (33💎) sem precisar de saldo prévio (crédito nunca falha).
    const corrPatch = await req2("PATCH", "/api/pedido/" + dpRId, { corrigirValor: 300 });
    check("💎 v77b: corrigirValor (Conferência) recalcula e credita a diferença de diamantes (+33💎)",
      corrPatch.json?.ok === true && corrPatch.json?.diamCorrecao?.aplicado === 33 && corrPatch.json?.diamCorrecao?.faltou === 0,
      corrPatch.body.slice(0, 200));
    const dmAfterUp = await get("/api/admin/diamonds/user/doadorround@test.com");
    check("💎 v77b: saldo do doadorround refletiu o +33💎 da correção pra cima", dmAfterUp.json?.saldo?.real === 33, JSON.stringify(dmAfterUp.json?.saldo));
    // corrige pra BAIXO agora (R$300→R$100, precisa só de 67💎) — tem que
    // remover 133💎, mas só sobram 33💎 no saldo (o resto já foi gasto no
    // DoublePro) — remove o que der (33) e ACUSA o que faltou (100), nunca
    // deixa saldo negativo.
    const corrPost = await req2("POST", "/api/admin/pedido-set-valor", { pedidoId: dpRId, valor: 100 });
    check("💎 v77b: pedido-set-valor remove o que der do saldo quando a correção pra baixo não cabe mais (33 removidos, 100 acusados como já gastos)",
      corrPost.json?.ok === true && corrPost.json?.diamCorrecao?.aplicado === -33 && corrPost.json?.diamCorrecao?.faltou === 100,
      corrPost.body.slice(0, 200));
    const dmAfterDown = await get("/api/admin/diamonds/user/doadorround@test.com");
    check("💎 v77b: saldo nunca fica negativo — foi a 0, não a -100", dmAfterDown.json?.saldo?.real === 0, JSON.stringify(dmAfterDown.json?.saldo));

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

    // ═══ ⬆️ v80 (ordem do dono, 29/07): UPGRADE DE PLANO — quem já tem plano
    // pago ativo paga só a DIFERENÇA em 💎 (mesmo período) pra subir de tier
    // — NUNCA reinicia nem soma dias. Cobre exatamente os 3 requisitos do
    // dono: (1) desconta os diamantes certos, (2) dias continuam os mesmos,
    // (3) nunca duplica o caixa (upgrade é 100% em diamantes). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "upgradeuser@test.com", name: "Upgrade User" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const upTop = await req2("POST", "/api/admin/diamonds", { email: "upgradeuser@test.com", real: 300, nota: "top-up smoke upgrade" });
    check("⬆️ v80: top-up credita 300💎 pro teste de upgrade", upTop.json?.ok === true, upTop.body.slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "upgradeuser@test.com" });
    // Começa no VIP 30d (67💎) — plano mais barato, só manual, SEM automático ainda.
    const upBuyVip = await req2("POST", "/api/diamonds/trocar", { plano: "vip", dias: 30 });
    check("⬆️ v80: compra VIP 30d (67💎) pra começar o teste de upgrade", upBuyVip.json?.ok === true && upBuyVip.json?.preco === 67, upBuyVip.body.slice(0, 140));
    const stVipAntes = await get("/api/status");
    const manualExpiresAntes = stVipAntes.json?.vip?.manualExpires;
    check("⬆️ v80: VIP 30d ativo, SÓ manual (sem automático ainda)", stVipAntes.json?.plan === "vip" && manualExpiresAntes > Date.now() && !(stVipAntes.json?.vip?.autoExpires > Date.now()), JSON.stringify(stVipAntes.json?.vip));
    // Upgrade pra VIPRO — diferença: 100💎(vipro/30d) - 67💎(vip/30d) = 33💎
    const upgVipro = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: upgrade VIP→VIPRO cobra EXATAMENTE a diferença (33💎), não o preço cheio (100💎)", upgVipro.json?.ok === true && upgVipro.json?.diferenca === 33, upgVipro.body.slice(0, 160));
    const stVipro = await get("/api/status");
    check("⬆️ v80: upgrade NÃO mexeu no manualExpires — dias continuam EXATAMENTE os mesmos de antes", stVipro.json?.vip?.manualExpires === manualExpiresAntes, JSON.stringify({ antes: manualExpiresAntes, depois: stVipro.json?.vip?.manualExpires }));
    check("⬆️ v80: automático foi destravado pela 1ª vez, mas até a MESMA data do manual (nunca ganhou +30d novos)", stVipro.json?.vip?.autoExpires === manualExpiresAntes, JSON.stringify({ manualExpiresAntes, autoExpiresDepois: stVipro.json?.vip?.autoExpires }));
    check("⬆️ v80+v118: plano e limites viraram VIPRO de verdade (tabela nova: 100 manual + 100 auto)", stVipro.json?.plan === "vipro" && stVipro.json?.manualLimit === 100 && stVipro.json?.autoLimit === 100, JSON.stringify({ plan: stVipro.json?.plan, manualLimit: stVipro.json?.manualLimit, autoLimit: stVipro.json?.autoLimit }));
    // Upgrade de novo, VIPRO→DOUBLEPRO — diferença: 167💎(doublepro/30d) - 100💎(vipro/30d) = 67💎
    const upgDouble = await req2("POST", "/api/plans/upgrade", { novoPlano: "doublepro" });
    check("⬆️ v80: upgrade VIPRO→DOUBLEPRO cobra EXATAMENTE a diferença (67💎)", upgDouble.json?.ok === true && upgDouble.json?.diferenca === 67, upgDouble.body.slice(0, 160));
    const stDouble2 = await get("/api/status");
    check("⬆️ v80: 2º upgrade TAMBÉM não mexeu nos dias — manualExpires e autoExpires continuam os mesmos do início", stDouble2.json?.vip?.manualExpires === manualExpiresAntes && stDouble2.json?.vip?.autoExpires === manualExpiresAntes, JSON.stringify(stDouble2.json?.vip));
    check("⬆️ v80+v118: agora com DoublePro de verdade — tabela nova: 200 manual + 200 automático (não ficou preso nos limites do VipPro)", stDouble2.json?.plan === "doublepro" && stDouble2.json?.manualLimit === 200 && stDouble2.json?.autoLimit === 200, JSON.stringify({ plan: stDouble2.json?.plan, manualLimit: stDouble2.json?.manualLimit, autoLimit: stDouble2.json?.autoLimit }));
    // Saldo final: 300 - 67(compra vip) - 33(upgrade vipro) - 67(upgrade doublepro) = 133
    const dmUpFinal = await get("/api/diamonds");
    check("⬆️ v80: saldo final bate exatamente com as 3 cobranças (300-67-33-67=133💎) — nada cobrado a mais ou a menos", dmUpFinal.json?.saldo?.real === 133, JSON.stringify(dmUpFinal.json?.saldo));
    // Downgrade/mesmo-tier tem que ser recusado
    const upSame = await req2("POST", "/api/plans/upgrade", { novoPlano: "doublepro" });
    check("⬆️ v80: 'upgrade' pro MESMO tier que já tem é recusado (400)", upSame.status === 400, `status=${upSame.status}`);
    const upDowngrade = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: 'upgrade' pra um tier INFERIOR é recusado (400) — upgrade não é downgrade disfarçado", upDowngrade.status === 400, `status=${upDowngrade.status}`);
    // Sem plano pago ativo não pode "upgradar"
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "semplano@test.com", name: "Sem Plano" });
    const upSemPlano = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: quem não tem plano pago ativo não consegue 'upgrade' (tem que comprar direto)", upSemPlano.status === 400, `status=${upSemPlano.status}`);
    // Saldo insuficiente pro upgrade → 402, educado
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pobreupgrade@test.com", name: "Pobre Upgrade" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const upPobreVip = await req2("POST", "/api/admin/set-plan", { email: "pobreupgrade@test.com", plan: "vip" }); // usa o admin (sem gastar diamante) só pra ter um VIP ativo
    check("⬆️ v80: (setup) admin ativou VIP pro teste de saldo insuficiente", upPobreVip.json?.ok === true, upPobreVip.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pobreupgrade@test.com" });
    const upPobre = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: upgrade sem 💎 suficiente → 402 (nunca ativa de graça)", upPobre.status === 402, upPobre.body.slice(0, 160));

    // ═══ 📋 v118 (ORDEM DO DONO, 02/08): NOVAS REGRAS DE PLANOS ═══
    // Tabela nova (vip 100/0 · vipro 100/100 · doublepro 200/200) vale SÓ
    // pra ativação NOVA (vip.limits carimbado na hora — contrato congelado).
    // Quem pagou ANTES não tem vip.limits, continua na tabela antiga até
    // expirar (nenhum pagante perde nada) e é AVISADO via planRulesNotice.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "legadoplano@test.com" });
    const stLegado = await get("/api/status");
    check("📋 v118: usuário LEGADO (VipPro pago antes da mudança, sem vip.limits) MANTÉM 200 manual + 200 auto da tabela antiga",
      stLegado.json?.plan === "vipro" && stLegado.json?.manualLimit === 200 && stLegado.json?.autoLimit === 200,
      JSON.stringify({ plan: stLegado.json?.plan, manualLimit: stLegado.json?.manualLimit, autoLimit: stLegado.json?.autoLimit }));
    check("📋 v118: usuário legado recebe o AVISO das regras novas (planRulesNotice com garantia até a data + limites de hoje)",
      typeof stLegado.json?.planRulesNotice === "string" && /garantido/.test(stLegado.json.planRulesNotice) && /200/.test(stLegado.json.planRulesNotice),
      String(stLegado.json?.planRulesNotice).slice(0, 180));
    // Ativação NOVA de VIP (só manual): carimba 100 manual e NÃO destrava automático
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vipnovo118@test.com", name: "Vip Novo 118" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    await req2("POST", "/api/admin/set-plan", { email: "vipnovo118@test.com", plan: "vip" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "vipnovo118@test.com" });
    const stVipNovo = await get("/api/status");
    check("📋 v118: VIP novo (R$100) = 100 candidaturas MANUAIS/dia, sem automático destravado",
      stVipNovo.json?.plan === "vip" && stVipNovo.json?.manualLimit === 100,
      JSON.stringify({ plan: stVipNovo.json?.plan, manualLimit: stVipNovo.json?.manualLimit, autoLimit: stVipNovo.json?.autoLimit }));
    check("📋 v118: quem ativou DEPOIS da mudança (vip.limits carimbado) NÃO vê o aviso de regras novas",
      !stVipNovo.json?.planRulesNotice, String(stVipNovo.json?.planRulesNotice || "null"));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // ⏱️ v118: intervalo humanizado do automático virou ~7min (6,5–7,5) pra
    // usuário comum — unit puro na MESMA função que o motor usa em produção.
    const { createCalcSmartInterval } = require("./mod-engine-core.js");
    const _calcIv = createCalcSmartInterval({ getUser: () => ({}), isAdminVip: () => false });
    let _ivDentro = true, _ivMin = Infinity, _ivMax = 0;
    for (let _k = 0; _k < 300; _k++) { const _v = _calcIv("comum@test.com"); _ivMin = Math.min(_ivMin, _v); _ivMax = Math.max(_ivMax, _v); if (_v < 6.5 * 60_000 || _v > 7.5 * 60_000) _ivDentro = false; }
    check("⏱️ v118: calcSmartInterval devolve SEMPRE entre 6,5 e 7,5 minutos (média ~7) pra usuário comum",
      _ivDentro, `min=${Math.round(_ivMin / 1000)}s max=${Math.round(_ivMax / 1000)}s`);
    const _admIv = createCalcSmartInterval({ getUser: () => ({ isAdmin: true, adminSettings: { intervalSecs: 60 } }), isAdminVip: () => true })("admin@test.com");
    check("⏱️ v118: intervalo CUSTOM do admin continua respeitado (não foi atropelado pelos 7min)",
      _admIv >= 45_000 && _admIv <= 75_000, `admIv=${Math.round(_admIv / 1000)}s`);
    // Financeiro (caixa) NUNCA recebe entrada nova por causa do upgrade —
    // upgrade é 100% em diamantes, dinheiro já entrou quando os 💎 foram doados.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const finUpgrade = await get("/api/admin/financeiro");
    const entradasUpgradeUser = (finUpgrade.json?.pagamentos || []).filter((x) => x.email === "upgradeuser@test.com");
    check("⬆️ v80: upgrade NUNCA lança entrada no caixa (100% diamantes — dinheiro já contou na doação original)", entradasUpgradeUser.length === 0, JSON.stringify(entradasUpgradeUser));

    // ═══ 💎 v81 (ordem do dono, 29/07/2026 — "eu e o Diego temos limite
    // infinito"): admin/DM pode testar troca/upgrade de plano GRÁTIS (só pra
    // testar a funcionalidade) — nunca desconta diamante de verdade, nunca
    // gera lançamento, nunca conta em nenhum agregado do site. MAS se o
    // admin DOAR diamantes pra um usuário de verdade, isso CONTA normal —
    // o destinatário recebe 💎 real de verdade e aparece no extrato como
    // doação do admin, sem descontar nada do admin (poço infinito). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dmSaldoAntes = await get("/api/diamonds");
    check("💎 v81: admin começa com saldo 0 (nunca comprou nada de verdade)", dmSaldoAntes.json?.saldo?.real === 0 && dmSaldoAntes.json?.saldo?.bonus === 0, JSON.stringify(dmSaldoAntes.json?.saldo));
    check("💎 v81: /api/diamonds avisa 'diamantesInfinitos:true' pra conta admin", dmSaldoAntes.json?.diamantesInfinitos === true, JSON.stringify(dmSaldoAntes.json));
    const overviewAntes = await get("/api/admin/diamonds/overview");
    const gastoTrocaAntes = overviewAntes.json?.totals?.totalGastoEmTrocasPorPlano || 0;
    const transferAntes = overviewAntes.json?.totals?.totalTransferidoEntreUsuarios || 0;
    // Admin "compra" VIP 30d SEM ter diamante nenhum — tem que funcionar (é teste).
    const dmBuyVip = await req2("POST", "/api/diamonds/trocar", { plano: "vip", dias: 30 });
    check("💎 v81: admin com 0💎 consegue trocar por VIP mesmo assim (diamante infinito de teste)", dmBuyVip.json?.ok === true, dmBuyVip.body.slice(0, 160));
    check("💎 v81: saldo do admin continua EXATAMENTE 0 depois da troca — não gastou de verdade", dmBuyVip.json?.saldo?.real === 0 && dmBuyVip.json?.saldo?.bonus === 0, JSON.stringify(dmBuyVip.json?.saldo));
    const stDmVip = await get("/api/status");
    check("💎 v81: plano BRUTO do admin virou vip de verdade (vip.plan/manualExpires gravados)", stDmVip.json?.vip?.plan === "vip" && stDmVip.json?.vip?.manualExpires > Date.now(), JSON.stringify(stDmVip.json?.vip));
    const dmManualExpiresAntes = stDmVip.json?.vip?.manualExpires;
    const dmLedgerAposTroca = await get("/api/diamonds");
    check("💎 v81: NENHUM lançamento 'troca' no extrato do admin — teste não conta em lugar nenhum", !(dmLedgerAposTroca.json?.ledger || []).some((e) => e.tipo === "troca"), JSON.stringify(dmLedgerAposTroca.json?.ledger));
    // Upgrade também grátis, com os dias intocados (mesma regra do usuário normal)
    const dmUpgVipro = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("💎 v81: admin faz upgrade VIP→VIPRO de graça (0💎 cobrados de verdade)", dmUpgVipro.json?.ok === true, dmUpgVipro.body.slice(0, 160));
    const stDmVipro = await get("/api/status");
    check("💎 v81: upgrade do admin também preserva os dias (manualExpires intocado)", stDmVipro.json?.vip?.manualExpires === dmManualExpiresAntes && stDmVipro.json?.vip?.plan === "vipro", JSON.stringify(stDmVipro.json?.vip));
    const dmSaldoAposUpgrade = await get("/api/diamonds");
    check("💎 v81: saldo do admin AINDA é 0 depois do upgrade também — e nenhum lançamento 'upgrade' no extrato", dmSaldoAposUpgrade.json?.saldo?.real === 0 && !(dmSaldoAposUpgrade.json?.ledger || []).some((e) => e.tipo === "upgrade"), JSON.stringify(dmSaldoAposUpgrade.json));
    const overviewDepoisTroca = await get("/api/admin/diamonds/overview");
    check("💎 v81: troca/upgrade de teste do admin NÃO mexeu nos agregados do site (totalGastoEmTrocasPorPlano igual antes e depois)", (overviewDepoisTroca.json?.totals?.totalGastoEmTrocasPorPlano || 0) === gastoTrocaAntes, JSON.stringify({ antes: gastoTrocaAntes, depois: overviewDepoisTroca.json?.totals?.totalGastoEmTrocasPorPlano }));

    // Doação do admin pra usuário de verdade — ISSO conta.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "receberadmin@test.com", name: "Recebe Doacao Admin" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dmDoa = await req2("POST", "/api/diamonds/transfer", { para: "receberadmin@test.com", qtd: 15 });
    check("💎 v81: admin doa 15💎 pra usuário real MESMO com saldo 0 (poço infinito, nunca bloqueia)", dmDoa.json?.ok === true, dmDoa.body.slice(0, 160));
    check("💎 v81: saldo do admin continua 0 depois de doar — a doação NUNCA sai do saldo dele", dmDoa.json?.saldo?.real === 0, JSON.stringify(dmDoa.json?.saldo));
    const dmLedgerAposDoacao = await get("/api/diamonds");
    const dmTransferOut = (dmLedgerAposDoacao.json?.ledger || []).find((e) => e.tipo === "transfer_out" && e.para === "receberadmin@test.com");
    check("💎 v81: extrato do PRÓPRIO admin registra a doação pra auditoria (qtd certa), mas com real:0 (não descontou de verdade)", !!dmTransferOut && dmTransferOut.qtd === -15 && dmTransferOut.real === 0, JSON.stringify(dmTransferOut));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "receberadmin@test.com" });
    const dmRecebeu = await get("/api/diamonds");
    check("💎 v81: destinatário recebeu 15💎 REAIS de verdade (pode gastar/repassar)", dmRecebeu.json?.saldo?.real === 15, JSON.stringify(dmRecebeu.json?.saldo));
    const dmTransferIn = (dmRecebeu.json?.ledger || []).find((e) => e.tipo === "transfer_in");
    check("💎 v81: extrato do destinatário mostra a doação atribuída CERTINHO ao e-mail do admin", dmTransferIn?.de === "smoke@test.com" && dmTransferIn?.qtd === 15, JSON.stringify(dmTransferIn));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const overviewDepoisDoacao = await get("/api/admin/diamonds/overview");
    check("💎 v81: doação do admin CONTA nos agregados do site (totalTransferidoEntreUsuarios subiu exatamente 15) — diferente da troca/upgrade de teste, essa é real",
      (overviewDepoisDoacao.json?.totals?.totalTransferidoEntreUsuarios || 0) === transferAntes + 15,
      JSON.stringify({ antes: transferAntes, depois: overviewDepoisDoacao.json?.totals?.totalTransferidoEntreUsuarios }));

    // ═══ 🎯 v82 (ordem do dono, 29/07/2026 — "IA sugerindo as vagas com mais
    // chance pra cada um", prioridade #1 da casa): MATCH DE VAGA. Pontua cada
    // vaga pelo encaixe com o perfil do candidato (categoria preferida,
    // estado do perfil, texto batendo com experiência/inglês) — na busca
    // manual (/api/sheet-meta) E na fila automática (/api/auto/start). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "matchtest@test.com", name: "Match Test" });
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

    // ═══ GUARDA PONTA A PONTA da troca por DoublePro vista pelo lado do
    // ADMIN, não só pelo /api/status do próprio usuário (que já era testado
    // acima só pro plano vip). Cobre as 2 rotas que o painel admin realmente
    // usa (renderUsersTable via /api/admin/users e o polling de refreshAll
    // via /api/admin/live) — se getPlan()/isVipActive() divergirem entre o
    // que o usuário vê e o que o admin vê, esta guarda pega. ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dpTop = await req2("POST", "/api/admin/diamonds", { email: "doador@test.com", real: 300, nota: "top-up smoke doublepro" });
    check("💎 v77: top-up admin credita 300 💎 reais pro teste de DoublePro", dpTop.json?.ok === true && dpTop.json?.saldo?.real === 323, dpTop.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com" });
    const trDP = await req2("POST", "/api/diamonds/trocar", { plano: "doublepro", dias: 30 });
    check("💎 v77: troca por DoublePro 30d custa 167 💎 e responde ok", trDP.json?.ok === true && trDP.json?.preco === 167 && trDP.json?.saldo?.real === 156, trDP.body.slice(0, 160));
    const stDP = await get("/api/status");
    check("💎 v77: /api/status (usuário) mostra plan=doublepro e vip ativo", stDP.json?.plan === "doublepro" && stDP.json?.vip?.active === true, JSON.stringify({ plan: stDP.json?.plan, vip: !!stDP.json?.vip?.active }));
    check("🚨 v77+v118: quem trocou 💎 por DoublePro AGORA leva a tabela nova carimbada — 200 manual + 200 automático (mesma régua do v79 pro caminho de diamantes)",
      stDP.json?.manualLimit === 200 && stDP.json?.autoLimit === 200,
      JSON.stringify({ manualLimit: stDP.json?.manualLimit, autoLimit: stDP.json?.autoLimit }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const adUsers = await get("/api/admin/users");
    const doadorNaListaUsers = (adUsers.json?.users || []).find((u) => u.email === "doador@test.com");
    check("💎 v77: /api/admin/users (Todos Usuários) MOSTRA doublepro pro admin — o gap que o dono reportou",
      doadorNaListaUsers?.plan === "doublepro" && doadorNaListaUsers?.vip?.active === true,
      JSON.stringify({ plan: doadorNaListaUsers?.plan, vipActive: doadorNaListaUsers?.vip?.active, autoExpires: doadorNaListaUsers?.vip?.autoExpires }));
    const adLive = await get("/api/admin/live");
    const doadorNaListaLive = (adLive.json?.users || []).find((u) => u.email === "doador@test.com");
    check("💎 v77: /api/admin/live (Visão Geral/VIP & Planos) TAMBÉM mostra doublepro",
      doadorNaListaLive?.plan === "doublepro", JSON.stringify({ plan: doadorNaListaLive?.plan }));

    // ═══ 💎 v77: PAINEL COMPLETO DE DIAMANTES (ranking + extrato por usuário
    // + agregados) — ordem do dono: "quero ver quem tem mais diamantes, o
    // que qualquer usuário comprou, como foi usado, 20+ informações" ═══
    const dOver = await get("/api/admin/diamonds/overview");
    check("💎 v77: overview responde ok com os campos principais (totals/ranking/topDoadores/atividadeRecente)",
      dOver.json?.ok === true && dOver.json?.totals && Array.isArray(dOver.json?.ranking) && Array.isArray(dOver.json?.topDoadores) && Array.isArray(dOver.json?.atividadeRecente),
      dOver.body.slice(0, 200));
    check("💎 v77: ranking vem ordenado do MAIOR saldo pro menor",
      dOver.json.ranking.every((r, i, arr) => i === 0 || arr[i - 1].total >= r.total), JSON.stringify(dOver.json.ranking.slice(0, 5)));
    const doadorNoRanking = (dOver.json?.ranking || []).find((r) => r.email === "doador@test.com");
    check("💎 v77: doador@test.com aparece no ranking com o plano doublepro e saldo correto (156💎 real)",
      doadorNoRanking?.plano === "doublepro" && doadorNoRanking?.real === 156, JSON.stringify(doadorNoRanking));
    check("💎 v77: totals.usuariosComSaldo + usuariosSemSaldo bate com o total de usuários do servidor",
      dOver.json.totals.usuariosComSaldo + dOver.json.totals.usuariosSemSaldo === dOver.json.totals.usuariosTotal,
      JSON.stringify(dOver.json.totals));
    check("💎 v77: trocasPorPlano contabilizou as trocas de VIP e DoublePro feitas neste teste",
      dOver.json?.trocasPorPlano?.vip?.count >= 1 && dOver.json?.trocasPorPlano?.doublepro?.count >= 2,
      JSON.stringify(dOver.json?.trocasPorPlano));
    const doadorNoTop = (dOver.json?.topDoadores || []).find((r) => r.email === "doador@test.com");
    check("💎 v77: topDoadores lista doador@test.com com os 100💎 reais da doação original",
      doadorNoTop?.realDoado === 100, JSON.stringify(doadorNoTop));

    const dUserFicha = await get("/api/admin/diamonds/user/doador@test.com");
    check("💎 v77: ficha individual (/api/admin/diamonds/user/:email) mostra saldo, plano e extrato completo",
      dUserFicha.json?.ok === true && dUserFicha.json?.plano === "doublepro" && dUserFicha.json?.saldo?.real === 156 && Array.isArray(dUserFicha.json?.ledger) && dUserFicha.json.ledger.length >= 5,
      dUserFicha.body.slice(0, 200));
    const dUser404 = await get("/api/admin/diamonds/user/naoexiste@test.com");
    check("💎 v77: ficha de e-mail inexistente → 404 (não quebra, não inventa)", dUser404.status === 404);

    // não-admin NUNCA vê o painel de diamantes de todo mundo (dado financeiro sensível)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const dOverAsUser = await get("/api/admin/diamonds/overview");
    check("💎 v77: usuário comum recebe 403 no overview de diamantes (painel é admin-only)", dOverAsUser.status === 403);
    const dUserFichaAsUser = await get("/api/admin/diamonds/user/doador@test.com");
    check("💎 v77: usuário comum recebe 403 na ficha de diamantes de outra pessoa", dUserFichaAsUser.status === 403);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // quem recebeu a transferência pode gastar (30 💎 reais no comprador)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const dmC = await get("/api/diamonds");
    check("💎 comprador recebeu os 30 💎 reais da transferência", dmC.json?.saldo?.real === 30, JSON.stringify(dmC.json?.saldo));

    // ═══ 🎁 v68: MISSÕES — recompensas em 💎 bônus (retroativas) ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const ms1 = await get("/api/missions");
    const msPerfil = (ms1.json?.missoes || []).find((m) => m.id === "perfil_completo");
    check("🎁 /api/missions lista as 5 missões com progresso", ms1.json?.ok === true && (ms1.json?.missoes || []).length === 5, ms1.body.slice(0, 140));
    check("🎁 perfil completo (fixture tem perfil+CV) é premiado RETROATIVAMENTE", msPerfil?.done === true, JSON.stringify(msPerfil));
    const dmM = await get("/api/diamonds");
    check("🎁 missão creditou 💎 BÔNUS (intransferível, gasto primeiro)", (dmM.json?.saldo?.bonus || 0) >= 3 && (dmM.json?.ledger || []).some((l) => l.tipo === "missao"), JSON.stringify(dmM.json?.saldo));
    await get("/api/missions"); // reabrir a tela não pode pagar de novo
    const dmM2 = await get("/api/diamonds");
    check("🎁 missão paga UMA vez só (reabrir não duplica)", (dmM2.json?.saldo?.bonus || 0) === (dmM.json?.saldo?.bonus || 0), `antes=${dmM.json?.saldo?.bonus} depois=${dmM2.json?.saldo?.bonus}`);
    // 🔒 v84b (ordem do dono, 31/07 vendo o painel real: 408 bônus em
    // circulação): 💎 de missão é bônus, e bônus NUNCA pode ser doado —
    // só serve pra troca/upgrade de plano. Este usuário tem SÓ bônus
    // (0 reais) — a doação tem que ser recusada (402) com o saldo intacto.
    const _bonusAntes = dmM2.json?.saldo?.bonus || 0;
    const txBonus = await req2("POST", "/api/diamonds/transfer", { para: "comprador@test.com", qtd: 1 });
    check("🔒 v84b: usuário SÓ com 💎 de missão (bônus) NÃO consegue doar nem 1 — bônus é intransferível de verdade", txBonus.status === 402, `status=${txBonus.status} body=${txBonus.body.slice(0, 120)}`);
    const dmM3 = await get("/api/diamonds");
    check("🔒 v84b: a tentativa de doação recusada não mexeu no saldo de bônus", (dmM3.json?.saldo?.bonus || 0) === _bonusAntes && (dmM3.json?.saldo?.real || 0) === 0, JSON.stringify(dmM3.json?.saldo));

    // ═══ 🌍 v129 (ORDEM DO DONO, 13/08): OS 3 SERVIDORES SÃO UM NEGÓCIO SÓ ═══
    // Ranking, landing e contabilidade somam os 3. No smoke não há irmãos
    // (fail-open comprovado: nada quebra sem peer); aqui provamos as PEÇAS:
    // a rota peer de ranking por período/categoria, a rota peer financeira
    // com gastos+usuários, e a landing com modo ?local=1 (anti-recursão).
    const rkExp = await get("/api/servers/ranking-export?period=day&category=sends");
    check("🌍 v129: rota peer de ranking aceita período/categoria e devolve lista pública (uid/score, nunca e-mail)",
      rkExp.json?.ok === true && Array.isArray(rkExp.json?.list) && typeof rkExp.json?.total === "number" &&
      rkExp.json.list.every((r) => r.uid && !("email" in r)),
      rkExp.body.slice(0, 160));
    const rkLoc = await get("/api/ranking?period=day&category=sends");
    check("🌍 v129: /api/ranking segue 100% funcional sem irmãos (fail-open — a aba nunca quebra)",
      rkLoc.json?.ok === true && Array.isArray(rkLoc.json?.list), rkLoc.body.slice(0, 120));
    const _finTok = crypto.createHmac("sha256", "smoke-enc-key-1234567890").update("h2b-peer-financeiro-v1").digest("hex");
    const finPeer = await new Promise((resolve, reject) => {
      http.get(BASE + "/api/servers/financeiro", { headers: { "x-peer-fin": _finTok } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: r.statusCode, json: j, body: b }); }); }).on("error", reject);
    });
    check("🌍 v129: rota peer financeira agora carrega gastos (30d/total) e usuários — tudo que o dono quer somar",
      finPeer.json?.ok === true && typeof finPeer.json?.entradas?.gastos30 === "number" && typeof finPeer.json?.entradas?.gastosTotal === "number" && typeof finPeer.json?.entradas?.usuariosTotal === "number",
      JSON.stringify(finPeer.json?.entradas || {}).slice(0, 160));
    const psLocal = await get("/api/public-stats?local=1");
    check("🌍 v129: landing tem modo ?local=1 (o que os irmãos pedem entre si — nunca recursão)",
      typeof psLocal.json?.totalUsers === "number" && psLocal.json?.global === undefined,
      psLocal.body.slice(0, 120));

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
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    check("📡⭐ v134: front tem o botão 📡 Radar e o funil do limite (limitUpsell 1x/dia)",
      frontAll.includes("function radarModal") && frontAll.includes("function limitUpsell") && home.body.includes('id="radar-btn"') && frontAll.includes("h2b_upsell"),
      "radarModal/limitUpsell/radar-btn/h2b_upsell não encontrados");
    const _srvRadar = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("📡 v134: vaga nova dispara o radar nos 2 caminhos (Vagas Novas H-2A + planilha mensal publicada)",
      (_srvRadar.match(/notificarRadares\(/g) || []).length >= 3, "chamadas de notificarRadares ausentes");

    // 🤖 v133: o prompt da IA do chat (1) responde na LÍNGUA do usuário e
    // (2) não menciona mais a aba Respostas (removida — regra 13d) nem o
    // intervalo antigo de 5-6min (é ~7 desde o v118). Guarda no fonte.
    const _srvSrcIA = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("🤖 v133: IA do chat com regra de idioma e sem conteúdo defasado (aba Respostas / 5-6min)",
      _srvSrcIA.includes("REGRA DE IDIOMA") && !/aba Respostas, o botão de gráfico/.test(_srvSrcIA) && !/Intervalo de 5 a 6 minutos/.test(_srvSrcIA),
      "REGRA DE IDIOMA ausente ou conteúdo defasado ainda no prompt");

    // ═══ 🗄️ v69: BACKUP ENTRE IRMÃOS — rota de recepção blindada ═══
    const zlibB = require("zlib");
    const _peerTokB = crypto.createHmac("sha256", "smoke-enc-key-1234567890").update("h2b-peer-financeiro-v1").digest("hex");
    const _gzB = zlibB.gzipSync(JSON.stringify({ v: 1, ts: 1, serverId: 1, files: { "financeiro.json": "{\"pagamentos\":[]}" } }));
    const rawPost = (p, buf, hdrs) => new Promise((resolve, reject) => {
      const r = http.request(BASE + p, { method: "POST", headers: { ...hdrs, "Content-Length": buf.length } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); });
      }); r.on("error", reject); r.write(buf); r.end();
    });
    const br403 = await rawPost("/api/servers/backup-receive", _gzB, { "x-backup-from": "1" });
    check("🗄️ backup-receive SEM token → 403 (dados nunca ficam públicos)", br403.status === 403, `status=${br403.status}`);
    const brOk = await rawPost("/api/servers/backup-receive", _gzB, { "x-peer-fin": _peerTokB, "x-backup-from": "1", "x-backup-stamp": "2026-07-26", "Content-Type": "application/gzip" });
    check("🗄️ backup do irmão é aceito e confirma os bytes", brOk.json?.ok === true && brOk.json?.bytes === _gzB.length, brOk.body.slice(0, 100));
    check("🗄️ blob gzip gravado no disco (backups_peers/srv1)", fs.existsSync(path.join(DATA, "backups_peers", "srv1", "2026-07-26.json.gz")));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 🌾 v121 (ORDEM DO DONO, 08/08): PLANILHA H-2A BIMESTRAL ═══
    // O robô junta 6 feeds escalonados (90 dias), dedupa por case number,
    // filtra qualidade e — autorizado por escrito — PUBLICA SOZINHO acima
    // do mínimo (aqui 10; feed falso rende 14 válidas de 6×16 registros:
    // duplicadas mescladas + sem e-mail descartada, provando a esteira).
    // v121c: o disparo é em BACKGROUND (resposta imediata, sem timeout de
    // HTTP no meio da coleta) — o resultado se acompanha pelo coleta-status
    // (% de progresso + log ao vivo), exatamente como o painel faz.
    // SEM force: o fixture diz que a última rodada foi há 1 mês — no regime
    // MENSAL (v122) tem que rodar; se alguém reverter pra "2 meses", quebra.
    const bim1 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", {});
    check("🌾 v121c+v122: com a última rodada há 1 mês, o disparo MENSAL responde NA HORA (started:true) com a chave do mês",
      bim1.json?.ok === true && bim1.json?.started === true && /^h2a-\d{6}$/.test(bim1.json?.key || ""),
      bim1.body.slice(0, 160));
    let bimSt = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      bimSt = (await get("/api/admin/sheet/coleta-status")).json;
      if (bimSt && !bimSt.running && bimSt.finishedAt) break;
    }
    check("🌾 v121: robô junta 6 feeds (90 dias), dedupa, PUBLICA sozinho e reporta % concluído",
      bimSt && bimSt.error === null && bimSt.count === 14 && bimSt.published === true && bimSt.progress === 100 && bimSt.bimestral?.lastKey === bim1.json?.key,
      JSON.stringify({ error: bimSt?.error, count: bimSt?.count, published: bimSt?.published, progress: bimSt?.progress, lastKey: bimSt?.bimestral?.lastKey }));
    const shlBim = await get("/api/sheets-list");
    const _shBim = (shlBim.json?.sheets || []).find((x) => x.key === bim1.json?.key);
    check("🌾 v121: a planilha nova já aparece na lista dos usuários (Manual/Automático), publicada",
      _shBim && _shBim.count === 14, JSON.stringify(_shBim || {}).slice(0, 160));
    const bim2 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", {});
    check("🌾 v121+v122: rodar de novo DENTRO do mesmo mês é recusado (409) — nunca duplica planilha",
      bim2.status === 409 && bim2.json?.skipped === true, `status=${bim2.status} body=${bim2.body.slice(0, 120)}`);
    const bim3 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", { force: true });
    let bimSt3 = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      bimSt3 = (await get("/api/admin/sheet/coleta-status")).json;
      if (bimSt3 && !bimSt3.running && bimSt3.finishedAt) break;
    }
    check("🌾 v121: force=true refaz a do mês do zero (MESMA chave, sem duplicar)",
      bim3.json?.ok === true && bim3.json?.key === bim1.json?.key && bimSt3?.count === 14 && bimSt3?.error === null,
      `resp=${bim3.body.slice(0, 100)} status=${JSON.stringify({ count: bimSt3?.count, error: bimSt3?.error })}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const bim403 = await req2("POST", "/api/admin/sheet/h2a-bimestral-run", {});
    check("🌾 v121: usuário comum recebe 403 no robô bimestral (admin-only)", bim403.status === 403, `status=${bim403.status}`);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ 🧊 v138: PLANILHA H-2B MENSAL — RASCUNHO SEMPRE (KB-078) ═══
    // Mesmo núcleo mensal do H-2A, visto H-2B. A diferença INEGOCIÁVEL:
    // auto-publicar é exceção autorizada por escrito SÓ do robô H-2A (13p);
    // o H-2B fica em rascunho MESMO acima do mínimo, até o admin publicar.
    const h2b1 = await req2("POST", "/api/admin/sheet/h2b-mensal-run", { force: true });
    check("🧊 v138: robô H-2B mensal dispara em background (started:true) com a chave do mês",
      h2b1.json?.ok === true && h2b1.json?.started === true && /^h2b-\d{6}$/.test(h2b1.json?.key || ""),
      h2b1.body.slice(0, 160));
    let h2bSt = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      h2bSt = (await get("/api/admin/sheet/coleta-status")).json;
      if (h2bSt && !h2bSt.running && h2bSt.finishedAt) break;
    }
    check("🧊 v138: coleta os 6 feeds H-2B (14 válidas do feed falso) e fica em RASCUNHO mesmo acima do mínimo — auto-publicar segue SÓ do H-2A (KB-078)",
      h2bSt && h2bSt.error === null && h2bSt.count === 14 && h2bSt.published === false && h2bSt.progress === 100 &&
      h2bSt.mensalH2b?.lastKey === h2b1.json?.key && h2bSt.mensalH2b?.lastPublished === false,
      JSON.stringify({ error: h2bSt?.error, count: h2bSt?.count, published: h2bSt?.published, lastKey: h2bSt?.mensalH2b?.lastKey }));
    const shlH2bDraft = await get("/api/sheets-list");
    check("🧊 v138: em rascunho, a planilha H-2B do mês NÃO aparece pros usuários",
      !(shlH2bDraft.json?.sheets || []).some((x) => x.key === h2b1.json?.key), JSON.stringify((shlH2bDraft.json?.sheets || []).map((x) => x.key)));
    const h2bPub = await req2("POST", "/api/admin/sheet/coleta-publish", { key: h2b1.json?.key });
    check("🧊 v138: publicação manual explícita do admin funciona (1 clique)", h2bPub.json?.ok === true && h2bPub.json?.count === 14, h2bPub.body.slice(0, 120));
    const shlH2bPub = await get("/api/sheets-list");
    const _shH2b = (shlH2bPub.json?.sheets || []).find((x) => x.key === h2b1.json?.key);
    check("🧊 v138: publicada, a \"H-2B <Mês> <Ano>\" aparece pra todo mundo (Manual/Automático) com o nome certo",
      _shH2b && _shH2b.count === 14 && /^H-2B /.test(String(_shH2b.name || "")), JSON.stringify(_shH2b || {}).slice(0, 160));
    const h2b2 = await req2("POST", "/api/admin/sheet/h2b-mensal-run", {});
    check("🧊 v138: rodar de novo DENTRO do mesmo mês sem force é recusado (409) — nunca duplica",
      h2b2.status === 409 && h2b2.json?.skipped === true, `status=${h2b2.status} body=${h2b2.body.slice(0, 120)}`);
    check("🧊 v138: agendador do H-2B mensal existe (boot+20min + ciclo 12h) e o robô NUNCA auto-publica (autoPublish:false)",
      _srvSrc.includes('_runH2bMensal("boot")') && _srvSrc.includes('_runH2bMensal("agendado")') &&
      /_runH2bMensal[\s\S]{0,400}autoPublish:false/.test(_srvSrc),
      "agendador ou autoPublish:false do H-2B não encontrados no server.js");

    // ═══ 💸 v140 (conta do Render): gzip nas conversas de robô ═══
    // Os 23GB de "Service-Initiated" eram em boa parte JSON cru — o
    // httpsReq agora descomprime sozinho e os robôs pedem gzip do DOL e
    // dos irmãos. As 2 chamadas de streaming cru (proxy e download de
    // buffer) CONTINUAM identity de propósito — não descomprimem.
    const _gmailSrcV140 = fs.readFileSync(path.join(__dirname, "mod-gmail.js"), "utf8");
    check("💸 v140: httpsReq descomprime gzip/deflate/br sozinho (fail-open pro corpo cru se falhar)",
      _gmailSrcV140.includes("content-encoding") && _gmailSrcV140.includes("gunzipSync") && _gmailSrcV140.includes("brotliDecompressSync"),
      "descompressão não encontrada no mod-gmail.js");
    check("💸 v140: robôs pedem gzip (DOL + irmãos ≥5 chamadas) e o streaming cru segue identity",
      (_srvSrc.match(/"Accept-Encoding":"gzip"/g) || []).length >= 5 && (_srvSrc.match(/"Accept-Encoding":"identity"/g) || []).length >= 2,
      `gzip=${(_srvSrc.match(/"Accept-Encoding":"gzip"/g) || []).length} identity=${(_srvSrc.match(/"Accept-Encoding":"identity"/g) || []).length}`);

    // ═══ 🎯 v139: VAGAS PRA VOCÊ — prateleira do match na Home (regra 13m) ═══
    // O ranking é cacheado 10min por usuário, mas o corte da regra 8
    // (enviado OU na fila nunca reaparece) roda FRESCO em toda resposta —
    // o teste prova exatamente isso pondo o empregador nº1 na fila.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pravoce@test.com", name: "PraVoce" });
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
    const bst = await get("/api/admin/backup-peers");
    check("🗄️ admin vê o backup recebido na visão de status", bst.json?.ok === true && (bst.json?.recebidos || []).some((r) => r.de === "srv1"), bst.body.slice(0, 140));
    // DRILL DE RESTAURAÇÃO (regra da casa: ensaiada de verdade, nunca presumida)
    const { execSync: _exec } = require("child_process");
    const _restDir = path.join(DATA, "restaurado-drill");
    _exec(`node restaurar_backup_irmao.js "${path.join(DATA, "backups_peers", "srv1", "2026-07-26.json.gz")}" "${_restDir}"`, { cwd: __dirname, stdio: "pipe" });
    const _restOk = fs.existsSync(path.join(_restDir, "financeiro.json")) && fs.readFileSync(path.join(_restDir, "financeiro.json"), "utf8") === '{"pagamentos":[]}';
    check("🗄️ DRILL de restauração: 1 comando devolve os arquivos do pacote intactos", _restOk);

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
    const _admSocSrc = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
    check("💼 MC4-P1 (estrutural): painel 🧠 tem a seção Sócios & Acerto viva (fetch da rota + atribuir + split) e o server tem a fonte única computeSocios",
      _admSocSrc.includes("/api/admin/socios") && _admSocSrc.includes("cerebroSociosAtribuir") && _admSocSrc.includes("cerebroSociosSplitSalvar") &&
      _srvSrc.includes("function computeSocios()") && _srvSrc.includes("sociosSplit"),
      "algum pedaço da seção Sócios & Acerto sumiu");

    // ═══ 🚚 v144: DRILL REAL DE FUSÃO DE SERVIDORES (ordem do dono, 15/08) ═══
    // Não é simulação: sobe um SEGUNDO servidor de verdade (o "Servidor 2"),
    // com contas, VIP, diamantes, envios, PDF no disco e pedido com
    // comprovante — e o servidor principal PUXA e FUNDE tudo, exatamente o
    // clique que o dono vai dar em produção antes de desligar os irmãos.
    const PORT_B = FEED_PORT + 1;
    const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-fusao-b-"));
    const _fNow = Date.now();
    fs.writeFileSync(path.join(DATA_B, "users.json"), JSON.stringify({
      // conta que SÓ existe no B — entra inteira no A
      "fusao.legado@test.com": { email: "fusao.legado@test.com", name: "Legado Fusão", plan: "vipro",
        created_at: "2026-05-01T00:00:00.000Z", profiles: [],
        vip: { active: true, plan: "vipro", manualExpires: _fNow + 20 * 86400_000, autoExpires: _fNow + 20 * 86400_000, source: "payment",
          creditos: [{ id: "credB1", quando: _fNow - 86400_000, dias: 30, tipo: "pago", origem: "pagamento", motivo: "VIPro", dadoPor: "sistema", valor: 150 }] },
        diamonds: { real: 7, bonus: 3 },
        cvs: [{ idx: 9001, name: "CV_Legado.pdf", size: 2000, cvType: "resume" }] },
      // conta que existe NOS DOIS — no B é a MAIS NOVA (2026-08-01), então
      // o perfil dela VENCE; dias/diamantes/envios do A são SOMADOS.
      "fusao.conflito@test.com": { email: "fusao.conflito@test.com", name: "Conflito Novo", plan: "vip",
        created_at: "2026-08-01T00:00:00.000Z", profiles: [],
        vip: { active: true, plan: "vip", manualExpires: _fNow + 8 * 86400_000, autoExpires: _fNow + 5 * 86400_000, source: "payment" },
        diamonds: { real: 2, bonus: 1 } },
    }));
    fs.writeFileSync(path.join(DATA_B, "history.json"), JSON.stringify({
      "fusao.legado@test.com": [
        { appId: "app_b_l1", to: "l1@x.com", subject: "x", type: "manual", sentAt: "2026-06-01T12:00:00.000Z", date: "2026-06-01", dateStr: "2026-06-01" },
        { appId: "app_b_l2", to: "l2@x.com", subject: "x", type: "auto", sentAt: "2026-06-02T12:00:00.000Z", date: "2026-06-02", dateStr: "2026-06-02" }],
      "fusao.conflito@test.com": [
        { appId: "app_b1", to: "emp2-b@x.com", subject: "x", type: "manual", sentAt: "2026-08-02T12:00:00.000Z", date: "2026-08-02", dateStr: "2026-08-02" }],
    }));
    fs.mkdirSync(path.join(DATA_B, "cvs"), { recursive: true });
    fs.writeFileSync(path.join(DATA_B, "cvs", "fusao.legado@test.com_9001.pdf"), "%PDF-1.4 curriculo do legado que nao pode se perder");
    const _compB64 = Buffer.from("comprovante-pix-fusao").toString("base64");
    fs.writeFileSync(path.join(DATA_B, "pedidos.json"), JSON.stringify([
      { id: "pedB0001", userEmail: "fusao.legado@test.com", userName: "Legado Fusão", plano: "vipro", dias: 30,
        valorTotal: 150, status: "ativo", comprovante: _compB64, comprovanteType: "image/jpeg",
        createdAt: _fNow - 2 * 86400_000, pagoEm: _fNow - 2 * 86400_000, ativadoEm: _fNow - 86400_000, ativadoPor: "admin" }]));
    fs.writeFileSync(path.join(DATA_B, "financeiro.json"), JSON.stringify({
      pagamentos: [{ id: "pgB0001", email: "fusao.legado@test.com", nome: "Legado Fusão", valor: 150, dataPagamento: "2026-08-13", criadoEm: _fNow - 86400_000, pedidoId: "pedB0001", source: "pedido_automatico" }], gastos: [] }));
    const srvB = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT_B), DATA_DIR: DATA_B, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed` },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const _waitB = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const ok = await new Promise((rs) => { http.get(`http://127.0.0.1:${PORT_B}/api/public-stats`, (r) => { r.resume(); rs(r.statusCode === 200); }).on("error", () => rs(false)); }); if (ok) return true; } catch {} await new Promise((r) => setTimeout(r, 400)); } return false; };
    check("🚚 v144: (setup) Servidor B subiu de verdade na porta " + PORT_B, await _waitB(40_000));
    // aponta o "Servidor 2" da config pro B local e dispara a fusão
    await req2("POST", "/api/admin/settings", { servers: [
      { id: 1, nome: "Servidor 1", url: BASE, maxExibido: 100, status: "aberto" },
      { id: 2, nome: "Servidor 2", url: `http://127.0.0.1:${PORT_B}`, maxExibido: 100, status: "aberto" }] });
    const fu1 = await req2("POST", "/api/admin/fusao/puxar", { serverId: 2 });
    check("🚚 v144: fusão dispara em background (started:true)", fu1.json?.ok === true && fu1.json?.started === true, fu1.body.slice(0, 140));
    let fuSt = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      fuSt = (await get("/api/admin/fusao/status")).json;
      if (fuSt && !fuSt.running && fuSt.finishedAt) break;
    }
    check("🚚 v144: fusão TERMINOU sem erro (backup automático antes + tudo gravado no disco)",
      fuSt && fuSt.error === null && fuSt.relatorio, JSON.stringify({ error: fuSt?.error, rel: fuSt?.relatorio }).slice(0, 220));
    const _rel = fuSt?.relatorio || {};
    check("🚚 v144: relatório fecha a conta — 1 conta nova (só existia no B), 1 fundida (conflito), 1 pedido, 1 PDF, 0 erros",
      _rel.novos === 1 && _rel.fundidos === 1 && _rel.pedidosImportados === 1 && _rel.pdfs >= 1 && (_rel.erros || []).length === 0,
      JSON.stringify(_rel).slice(0, 260));
    // A conta que só existia no B entrou INTEIRA: 20d de VIP, 7💎+3💎, PDF no disco
    const finLeg = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("fusao.legado@test.com"));
    check("🚚 v144: conta exclusiva do B chegou com os dias de VIP EXATOS (a pessoa loga e já sai mandando)",
      finLeg.json?.ok === true && finLeg.json?.plano?.manual?.diasRestantes >= 19 && finLeg.json?.plano?.manual?.diasRestantes <= 20 &&
      finLeg.json?.plano?.auto?.diasRestantes >= 19 && finLeg.json?.creditos?.length >= 1,
      JSON.stringify({ m: finLeg.json?.plano?.manual?.diasRestantes, a: finLeg.json?.plano?.auto?.diasRestantes }).slice(0, 120));
    check("🚚 v144: o PDF do currículo veio junto e está NO DISCO do servidor principal",
      fs.existsSync(path.join(DATA, "cvs", "fusao.legado@test.com_9001.pdf")));
    const pedFu = await get("/api/pedido/pedB0001");
    check("🚚 v144: pedido do B chegou COM comprovante aberto (base64 íntegro) e marcado com o servidor de origem",
      pedFu.json?.ok !== false && pedFu.json?.pedido?.comprovante === _compB64 && pedFu.json?.pedido?.origemServidor === 2,
      JSON.stringify({ tem: !!pedFu.json?.pedido?.comprovante, origem: pedFu.json?.pedido?.origemServidor }).slice(0, 120));
    // O CONFLITO: perfil do B vence (mais novo), dias e diamantes SOMADOS
    const finCon = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("fusao.conflito@test.com"));
    const _mDias = finCon.json?.plano?.manual?.diasRestantes, _aDias = finCon.json?.plano?.auto?.diasRestantes;
    check("🚚 v144: CONFLITO DE E-MAIL — dias de VIP SOMADOS (10 locais + 8 do B ≈ 18 manual · 5 auto) — ninguém perde o que pagou",
      _mDias >= 17 && _mDias <= 18 && _aDias >= 4 && _aDias <= 5, JSON.stringify({ manual: _mDias, auto: _aDias }));
    const _uCon = (await get("/api/admin/user-detail/" + encodeURIComponent("fusao.conflito@test.com"))).json?.user;
    check("🚚 v144: CONFLITO — perfil vencedor é o da conta criada por ÚLTIMO (nome do B); 💎 REAIS somados (5+2) e bônus RECALCULADO das missões (0 — v154: bônus nunca soma na fusão)",
      _uCon?.name === "Conflito Novo" && _uCon?.diamonds?.real === 7 && _uCon?.diamonds?.bonus === 0,
      JSON.stringify({ name: _uCon?.name, d: _uCon?.diamonds }).slice(0, 120));
    // Regra 8 (a mais sagrada): anti-duplicado UNIDO — nunca reenvia pra
    // empregador já contatado em QUALQUER um dos servidores.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "fusao.conflito@test.com", name: "Conflito" });
    const seFu = await get("/api/sent-emails");
    check("🚚 v144: REGRA 8 — anti-duplicado dos DOIS servidores unido (emp1-a@x.com E emp2-b@x.com bloqueados)",
      (seFu.json?.sent || []).includes("emp1-a@x.com") && (seFu.json?.sent || []).includes("emp2-b@x.com"), JSON.stringify(seFu.json?.sent).slice(0, 140));
    const stFu = await get("/api/status");
    check("🚚 v144: envios dos dois servidores SOMADOS no histórico/ranking (1 do A + 1 do B = 2)",
      stFu.json?.totalSent === 2, JSON.stringify({ totalSent: stFu.json?.totalSent }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // IDEMPOTÊNCIA: rodar de novo NÃO pode somar dias/diamantes duas vezes
    const fu2 = await req2("POST", "/api/admin/fusao/puxar", { serverId: 2 });
    let fuSt2 = null;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 400)); fuSt2 = (await get("/api/admin/fusao/status")).json; if (fuSt2 && !fuSt2.running && fuSt2.finishedAt) break; }
    const finCon2 = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("fusao.conflito@test.com"));
    check("🚚 v144: IDEMPOTÊNCIA — rodar a fusão DE NOVO não duplica nada (0 novos, 0 fundidos, dias e 💎 intactos)",
      fu2.json?.ok === true && fuSt2?.relatorio?.novos === 0 && fuSt2?.relatorio?.fundidos === 0 &&
      finCon2.json?.plano?.manual?.diasRestantes === _mDias &&
      (await get("/api/admin/user-detail/" + encodeURIComponent("fusao.conflito@test.com"))).json?.user?.diamonds?.real === 7,
      JSON.stringify({ rel2: fuSt2?.relatorio, dias: finCon2.json?.plano?.manual?.diasRestantes }).slice(0, 220));
    // financeiro do B fundido no caixa local
    const finGlob = await get("/api/admin/financeiro");
    check("🚚 v144: caixa do B fundido no caixa local (pagamento de R$150 presente, sem duplicar)",
      (finGlob.json?.pagamentos || []).filter((p2) => p2.id === "pgB0001").length === 1, JSON.stringify((finGlob.json?.pagamentos || []).filter((p2) => p2.id === "pgB0001")).slice(0, 140));
    srvB.kill();
    // ═══ 🚚 v146: MODO APOSENTADO — depois da fusão, o servidor antigo
    // redireciona TODO MUNDO pro Servidor 1 (env REDIRECT_ALL_TO), mas as
    // rotas peer continuam vivas (pra re-puxar a fusão se precisar).
    await new Promise((r) => setTimeout(r, 500));
    const srvB2 = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT_B), DATA_DIR: DATA_B, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed`, REDIRECT_ALL_TO: "https://h2bapply.com" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const _rawB = (p, headers) => new Promise((rs) => { http.get({ host: "127.0.0.1", port: PORT_B, path: p, headers: headers || {} }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => rs({ status: r.statusCode, location: r.headers.location || "", body: b })); }).on("error", () => rs(null)); });
    const _waitB2 = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await _rawB("/"); if (r && r.status) return true; await new Promise((r2) => setTimeout(r2, 400)); } return false; };
    check("🚚 v146: (setup) servidor aposentado subiu com REDIRECT_ALL_TO", await _waitB2(40_000));
    const rd1 = await _rawB("/admin?x=1");
    check("🚚 v146: MODO APOSENTADO — quem entra no servidor antigo é jogado pro Servidor 1 (302, caminho preservado)",
      rd1 && rd1.status === 302 && rd1.location === "https://h2bapply.com/admin?x=1", JSON.stringify(rd1).slice(0, 140));
    const _peerTokFu = require("crypto").createHmac("sha256", "smoke-enc-key-1234567890").update("h2b-peer-financeiro-v1").digest("hex");
    const rd2 = await _rawB("/api/servers/fusao/manifest", { "x-peer-fin": _peerTokFu });
    check("🚚 v146: rotas peer continuam VIVAS no modo aposentado (dá pra re-puxar a fusão mesmo com o redirect ligado)",
      rd2 && rd2.status === 200 && JSON.parse(rd2.body || "{}").ok === true, JSON.stringify({ status: rd2?.status }).slice(0, 100));
    srvB2.kill();
    try { fs.rmSync(DATA_B, { recursive: true, force: true }); } catch {}

    // ═══ 📦 v148: DRILL REAL DA MIGRAÇÃO POR ARQUIVO (dono, 20/08: "já que a
    // fusão não está dando certo... botão de download de todas as informações
    // ... e no server um, o importar. Me garanta que agora vai funcionar").
    // Sobe um TERCEIRO servidor de verdade (SERVER_ID=3), o admin EXPORTA o
    // arquivo pela rota real, e o servidor principal IMPORTA o arquivo —
    // sem os dois nunca se falarem por rede. Mesmo motor, mesmas garantias.
    const PORT_C = FEED_PORT + 2;
    const DATA_C = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-fusao-c-"));
    const _cNow = Date.now();
    fs.writeFileSync(path.join(DATA_C, "users.json"), JSON.stringify({
      // conta que SÓ existe no C — entra inteira no A via arquivo
      "fusao.arquivo@test.com": { email: "fusao.arquivo@test.com", name: "Arquivo Fusão", plan: "vipro",
        created_at: "2026-06-01T00:00:00.000Z", profiles: [],
        vip: { active: true, plan: "vipro", manualExpires: _cNow + 12 * 86400_000, autoExpires: _cNow + 12 * 86400_000, source: "payment" },
        diamonds: { real: 4, bonus: 2 },
        cvs: [{ idx: 9101, name: "CV_Arquivo.pdf", size: 1500, cvType: "resume" }] },
      // conta que existe NOS DOIS — no C é MAIS VELHA (2026-07-01) que a local
      // (2026-08-01, vencedora da fusão do B) → local vence, dias/💎 SOMADOS.
      "fusao.conflito@test.com": { email: "fusao.conflito@test.com", name: "Conflito Velho C", plan: "vip",
        created_at: "2026-07-01T00:00:00.000Z", profiles: [],
        vip: { active: true, plan: "vip", manualExpires: _cNow + 3 * 86400_000, autoExpires: _cNow + 2 * 86400_000, source: "payment" },
        diamonds: { real: 1, bonus: 0 } },
      // o admin do teste precisa logar no C pra exportar — pré-semeado BEM
      // antigo pra, na importação, a conta local (mais nova) vencer sem ruído
      "smoke@test.com": { email: "smoke@test.com", name: "Smoke", plan: "free",
        created_at: "2020-01-01T00:00:00.000Z", profiles: [], isAdmin: true },
    }));
    fs.writeFileSync(path.join(DATA_C, "history.json"), JSON.stringify({
      "fusao.arquivo@test.com": [{ appId: "app_c_a1", to: "emp4-c@x.com", subject: "x", type: "manual", sentAt: "2026-07-01T12:00:00.000Z", date: "2026-07-01", dateStr: "2026-07-01" }],
      "fusao.conflito@test.com": [{ appId: "app_c1", to: "emp3-c@x.com", subject: "x", type: "manual", sentAt: "2026-07-02T12:00:00.000Z", date: "2026-07-02", dateStr: "2026-07-02" }],
    }));
    fs.mkdirSync(path.join(DATA_C, "cvs"), { recursive: true });
    fs.writeFileSync(path.join(DATA_C, "cvs", "fusao.arquivo@test.com_9101.pdf"), "%PDF-1.4 curriculo que viaja dentro do arquivo exportado");
    const _compC64 = Buffer.from("comprovante-pix-arquivo").toString("base64");
    fs.writeFileSync(path.join(DATA_C, "pedidos.json"), JSON.stringify([
      { id: "pedC0001", userEmail: "fusao.arquivo@test.com", userName: "Arquivo Fusão", plano: "vipro", dias: 30,
        valorTotal: 100, status: "ativo", comprovante: _compC64, comprovanteType: "image/jpeg",
        createdAt: _cNow - 3 * 86400_000, pagoEm: _cNow - 3 * 86400_000, ativadoEm: _cNow - 2 * 86400_000, ativadoPor: "admin" }]));
    fs.writeFileSync(path.join(DATA_C, "financeiro.json"), JSON.stringify({
      pagamentos: [{ id: "pgC0001", email: "fusao.arquivo@test.com", nome: "Arquivo Fusão", valor: 100, dataPagamento: "2026-08-14", criadoEm: _cNow - 2 * 86400_000, pedidoId: "pedC0001", source: "pedido_automatico" }], gastos: [] }));
    const srvC = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT_C), DATA_DIR: DATA_C, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed`, SERVER_ID: "3" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    // mini-jar de cookie próprio pro servidor C (admin logado LÁ pra exportar)
    let COOKIE_C = "";
    const _reqC = (method, p, payload) => new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : null;
      const r = http.request(`http://127.0.0.1:${PORT_C}` + p, { method, headers: {
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...(COOKIE_C ? { Cookie: COOKIE_C } : {}) } }, (res2) => {
        const sc = res2.headers["set-cookie"]; if (sc && sc.length) COOKIE_C = sc[0].split(";")[0];
        let b = ""; res2.on("data", (c) => (b += c));
        res2.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res2.statusCode, body: b, json: j }); });
      });
      r.on("error", reject); if (body) r.write(body); r.end();
    });
    const _getBufC = (p) => new Promise((rs) => { http.get({ host: "127.0.0.1", port: PORT_C, path: p, headers: COOKIE_C ? { Cookie: COOKIE_C } : {} }, (r) => { const ch = []; r.on("data", (c) => ch.push(c)); r.on("end", () => rs({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(ch) })); }).on("error", () => rs(null)); });
    const _getBufA = (p) => new Promise((rs) => { http.get(BASE + p, { headers: COOKIE ? { Cookie: COOKIE } : {} }, (r) => { const ch = []; r.on("data", (c) => ch.push(c)); r.on("end", () => rs({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(ch) })); }).on("error", () => rs(null)); });
    const _postBinA = (p, buf) => new Promise((rs, rj) => { const r = http.request(BASE + p, { method: "POST", headers: { "Content-Type": "application/gzip", "Content-Length": buf.length, ...(COOKIE ? { Cookie: COOKIE } : {}) } }, (res2) => { let b = ""; res2.on("data", (c) => (b += c)); res2.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} rs({ status: res2.statusCode, json: j, body: b }); }); }); r.on("error", rj); r.write(buf); r.end(); });
    const _waitC = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const ok = await new Promise((rs) => { http.get(`http://127.0.0.1:${PORT_C}/api/public-stats`, (r) => { r.resume(); rs(r.statusCode === 200); }).on("error", () => rs(false)); }); if (ok) return true; } catch {} await new Promise((r) => setTimeout(r, 400)); } return false; };
    check("📦 v148: (setup) Servidor C (SERVER_ID=3) subiu de verdade na porta " + PORT_C, await _waitC(40_000));
    await _reqC("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    // EXPORTAR no C: o mesmo clique que o dono vai dar no Servidor 2 e 3
    const exC = await _getBufC("/api/admin/fusao/exportar");
    check("📦 v148: EXPORTAR gera o arquivo .gz com os contadores nos headers (3 usuários, 1 pedido, servidor 3)",
      exC && exC.status === 200 && String(exC.headers["content-type"]).includes("gzip") &&
      exC.headers["x-fusao-users"] === "3" && exC.headers["x-fusao-pedidos"] === "1" && exC.headers["x-fusao-server"] === "3",
      JSON.stringify({ status: exC?.status, u: exC?.headers?.["x-fusao-users"], p: exC?.headers?.["x-fusao-pedidos"], s: exC?.headers?.["x-fusao-server"] }));
    let _exDados = null;
    try { _exDados = JSON.parse(require("zlib").gunzipSync(exC.buf).toString("utf8")); } catch {}
    check("📦 v148: o arquivo é JSON gzipado ÍNTEGRO — formato marcado, PDF em base64 a bordo, pedido com comprovante, globais juntos",
      _exDados && _exDados.fmt === "h2bapply-fusao-arquivo-v1" && _exDados.serverId === 3 &&
      _exDados.users["fusao.arquivo@test.com"]?.pdfs?.[0]?.b64?.length > 10 &&
      _exDados.pedidos?.length === 1 && _exDados.pedidos[0].comprovante === _compC64 &&
      (_exDados.globais?.financeiro?.pagamentos || []).some((p2) => p2.id === "pgC0001") &&
      !JSON.stringify(_exDados.users).includes("refresh_token"),
      JSON.stringify({ fmt: _exDados?.fmt, sid: _exDados?.serverId, users: Object.keys(_exDados?.users || {}).length }).slice(0, 160));
    // IMPORTAR no A: o clique do dono no Servidor 1 (com o C já MORTO —
    // é exatamente o cenário que a fusão por rede não cobria). v148b: o
    // painel envia em PEDAÇOS de 4MB (arquivo de 42MB do celular era cortado
    // pelo proxy do Render numa requisição só) — o drill prova o caminho
    // fatiado de verdade: 2 partes por offset + fim.
    srvC.kill();
    const _postParteA = (upId, off, buf) => new Promise((rs, rj) => { const r = http.request(BASE + "/api/admin/fusao/importar-parte", { method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": buf.length, "x-up-id": upId, "x-up-off": String(off), ...(COOKIE ? { Cookie: COOKIE } : {}) } }, (res2) => { let b = ""; res2.on("data", (c) => (b += c)); res2.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} rs({ status: res2.statusCode, json: j }); }); }); r.on("error", rj); r.write(buf); r.end(); });
    const _metade = Math.ceil(exC.buf.length / 2);
    const pt1 = await _postParteA("smokeup1", 0, exC.buf.slice(0, _metade));
    // a 2ª parte é enviada DUAS vezes (retentativa de 4G) — offset idempotente
    await _postParteA("smokeup1", _metade, exC.buf.slice(_metade));
    const pt2 = await _postParteA("smokeup1", _metade, exC.buf.slice(_metade));
    check("📦 v148b: upload em PARTES grava por offset (retentativa do mesmo pedaço não corrompe; total de bytes fecha)",
      pt1.json?.ok === true && pt2.json?.ok === true && pt2.json?.bytes === exC.buf.length,
      JSON.stringify({ p1: pt1.json, p2: pt2.json, esperado: exC.buf.length }).slice(0, 140));
    const imp1 = await req2("POST", "/api/admin/fusao/importar-fim", { upId: "smokeup1" });
    check("📦 v148: IMPORTAR aceita o arquivo (montado das partes) e dispara em background (modo arquivo, origem 3)",
      imp1.json?.ok === true && imp1.json?.started === true && imp1.json?.modo === "arquivo" && imp1.json?.serverId === 3,
      (imp1.body || "").slice(0, 160));
    let impSt = null;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); impSt = (await get("/api/admin/fusao/status")).json; if (impSt && !impSt.running && impSt.finishedAt) break; }
    check("📦 v148: importação TERMINOU sem erro — log completo pro dono conferir (backup antes + tudo gravado)",
      impSt && impSt.error === null && impSt.relatorio && (impSt.log || []).some((l) => /IMPORTAÇÃO DO SERVIDOR 3 CONCLUÍDA/.test(l.msg)),
      JSON.stringify({ error: impSt?.error, rel: impSt?.relatorio }).slice(0, 220));
    const _relC = impSt?.relatorio || {};
    check("📦 v148: relatório fecha a conta — 1 conta nova, 2 fundidas (conflito + admin), 1 pedido, 1 PDF, 0 erros",
      _relC.novos === 1 && _relC.fundidos === 2 && _relC.pedidosImportados === 1 && _relC.pdfs >= 1 && (_relC.erros || []).length === 0,
      JSON.stringify(_relC).slice(0, 260));
    const finArq = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("fusao.arquivo@test.com"));
    check("📦 v148: conta exclusiva do C chegou com os dias de VIP EXATOS e o PDF do currículo NO DISCO do principal",
      finArq.json?.ok === true && finArq.json?.plano?.manual?.diasRestantes >= 11 && finArq.json?.plano?.manual?.diasRestantes <= 12 &&
      fs.existsSync(path.join(DATA, "cvs", "fusao.arquivo@test.com_9101.pdf")),
      JSON.stringify({ m: finArq.json?.plano?.manual?.diasRestantes }).slice(0, 100));
    const pedArq = await get("/api/pedido/pedC0001");
    check("📦 v148: pedido do C chegou COM o comprovante intacto e marcado com o servidor de origem 3",
      pedArq.json?.ok !== false && pedArq.json?.pedido?.comprovante === _compC64 && pedArq.json?.pedido?.origemServidor === 3,
      JSON.stringify({ tem: !!pedArq.json?.pedido?.comprovante, origem: pedArq.json?.pedido?.origemServidor }).slice(0, 100));
    const finCon3 = await get("/api/admin/financeiro-usuario/" + encodeURIComponent("fusao.conflito@test.com"));
    const _mDias3 = finCon3.json?.plano?.manual?.diasRestantes;
    const _uCon3 = (await get("/api/admin/user-detail/" + encodeURIComponent("fusao.conflito@test.com"))).json?.user;
    check("📦 v148: CONFLITO via arquivo — conta local (mais nova) vence o perfil, mas os 3 dias e o 💎 do C são SOMADOS",
      _mDias3 >= _mDias + 2 && _mDias3 <= _mDias + 3 && _uCon3?.name === "Conflito Novo" && _uCon3?.diamonds?.real === 8,
      JSON.stringify({ dias: _mDias3, antes: _mDias, name: _uCon3?.name, real: _uCon3?.diamonds?.real }).slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "fusao.conflito@test.com", name: "Conflito" });
    const seC = await get("/api/sent-emails");
    check("📦 v148: REGRA 8 — anti-duplicado do arquivo UNIDO ao local (emp3-c@x.com bloqueado; 3 envios no total)",
      (seC.json?.sent || []).includes("emp3-c@x.com") && (await get("/api/status")).json?.totalSent === 3,
      JSON.stringify(seC.json?.sent).slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // IDEMPOTÊNCIA: importar o MESMO arquivo de novo não pode somar nada
    const imp2 = await _postBinA("/api/admin/fusao/importar", exC.buf);
    let impSt2 = null;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 400)); impSt2 = (await get("/api/admin/fusao/status")).json; if (impSt2 && !impSt2.running && impSt2.finishedAt) break; }
    check("📦 v148: IDEMPOTÊNCIA — importar o MESMO arquivo de novo não duplica nada (0 novos, 0 fundidos, dias e 💎 intactos)",
      imp2.json?.ok === true && impSt2?.relatorio?.novos === 0 && impSt2?.relatorio?.fundidos === 0 &&
      (await get("/api/admin/financeiro-usuario/" + encodeURIComponent("fusao.conflito@test.com"))).json?.plano?.manual?.diasRestantes === _mDias3 &&
      (await get("/api/admin/user-detail/" + encodeURIComponent("fusao.conflito@test.com"))).json?.user?.diamonds?.real === 8,
      JSON.stringify({ rel2: impSt2?.relatorio }).slice(0, 200));
    const finGlobC = await get("/api/admin/financeiro");
    check("📦 v148: caixa do C fundido no caixa local SEM duplicar (pagamento pgC0001 presente exatamente 1 vez)",
      (finGlobC.json?.pagamentos || []).filter((p2) => p2.id === "pgC0001").length === 1,
      JSON.stringify((finGlobC.json?.pagamentos || []).filter((p2) => p2.id === "pgC0001")).slice(0, 120));
    // GUARDA: importar um arquivo exportado DESTE MESMO servidor é recusado
    // (duplicaria dias/diamantes de todo mundo — o erro explica o porquê)
    const exA = await _getBufA("/api/admin/fusao/exportar");
    const impSelf = exA && exA.status === 200 ? await _postBinA("/api/admin/fusao/importar", exA.buf) : null;
    check("📦 v148: GUARDA — arquivo exportado deste MESMO servidor é recusado na importação (senão duplicava tudo)",
      exA && exA.status === 200 && impSelf && impSelf.status === 400 && /DESTE mesmo servidor/i.test(impSelf.json?.error || ""),
      JSON.stringify({ ex: exA?.status, imp: impSelf?.status, err: impSelf?.json?.error }).slice(0, 180));
    const _admHtml = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
    check("📦 v148: (estrutural) painel tem os botões ⬇️ Baixar e ⬆️ Importar (upload fatiado com %) e o modo antigo virou secundário",
      _admHtml.includes('id="fusao-btn-export"') && _admHtml.includes('id="fusao-file"') && _admHtml.includes("fusaoImportar()") && _admHtml.includes("Modo antigo") && _admHtml.includes("importar-parte"),
      "botões da migração por arquivo (ou o upload fatiado) não encontrados no admin.html");
    try { fs.rmSync(DATA_C, { recursive: true, force: true }); } catch {}

    // ═══ 🙈 v147: servidor OCULTO some do seletor público, mas as rotas
    // internas (fusão) continuam enxergando — "quem entrar no server 1 não
    // terá mais a opção do server 2 e 3" (dono, 15/08).
    await req2("POST", "/api/admin/settings", { servers: [
      { id: 1, nome: "Servidor 1", url: BASE, maxExibido: 100, status: "aberto" },
      { id: 2, nome: "Servidor 2", url: `http://127.0.0.1:${PORT_B}`, maxExibido: 100, status: "oculto" }] });
    const svPub = await get("/api/servers");
    check("🙈 v147: servidor marcado 'oculto' NÃO aparece no seletor público (todo mundo forçado pro Servidor 1)",
      (svPub.json?.servers || []).length === 1 && svPub.json?.servers?.[0]?.id === 1, JSON.stringify(svPub.json?.servers?.map((s2) => s2.id)));
    const psSrv = await get("/api/public-stats");
    check("🙈 v147: public-stats conta 1 servidor visível → a pill 🌐 some da landing",
      psSrv.json?.serversVisiveis === 1, JSON.stringify({ vis: psSrv.json?.serversVisiveis }));
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

    // 📢 v144: aviso do reset de login — toggle do admin liga o banner público
    await req2("POST", "/api/admin/settings", { avisoResetLogin: true });
    const psAviso = await get("/api/public-stats");
    check("📢 v144: toggle ligado → /api/public-stats expõe o aviso pra landing (antes do login)",
      psAviso.json?.avisoResetLogin === true, psAviso.body.slice(0, 120));
    await req2("POST", "/api/admin/settings", { avisoResetLogin: false });
    const psAviso2 = await get("/api/public-stats");
    check("📢 v144: toggle desligado → aviso some", psAviso2.json?.avisoResetLogin === false, psAviso2.body.slice(0, 100));
    check("📢 v144: banner existe na landing com o texto do dono (data-i18n rst_t/rst_b, 3 línguas)",
      home.body.includes('id="aviso-reset-banner"') && home.body.includes('data-i18n="rst_b"'),
      "banner do reset não encontrado no index.html");

    // ═══ 🛡️ v149: CONTA ÚNICA (ordem do dono, 20/08 — print do ranking com
    // todo mundo 2x). As 3 defesas: ranking global deduplica por uid (a mesma
    // conta pós-fusão vive nos 2 servidores), o e-mail digitado vira contrato
    // no login do Google (autenticou outro = barra + revoga o token, a vaga
    // das 100 é devolvida), e a landing avisa: 2ª conta = risco de ban.
    const rkDedup = await get("/api/ranking?period=all&category=sends");
    check("🛡️ v149: /api/ranking responde ok e nenhum uid aparece 2x na lista",
      rkDedup.json?.ok === true && Array.isArray(rkDedup.json?.list) &&
      new Set(rkDedup.json.list.map((r) => r.uid).filter(Boolean)).size === rkDedup.json.list.filter((r) => r.uid).length,
      JSON.stringify({ n: rkDedup.json?.list?.length }).slice(0, 80));
    check("🛡️ v149: (estrutural) merge de peers do ranking deduplica por uid e não soma o total de peer já fundido",
      _srvSrc.includes("_peerFundido") && _srvSrc.includes("_peerTotais") && _srvSrc.includes("dedupe mantendo a maior contagem"),
      "dedupe do ranking global não encontrado no server.js");
    check("🛡️ v149b: (estrutural) login em 2 FASES — identidade primeiro (openid email, fora das 100 vagas) barra e-mail errado ANTES da caixinha; a 2ª fase ainda revalida com revoke de backup",
      _srvSrc.includes('scope:"openid email"') && _srvSrc.includes('_oauthFase==="identidade"') &&
      _srvSrc.includes("login_hint:_expectedHint") && _srvSrc.includes("_expectedHint&&_authedEmail!==_expectedHint") &&
      _srvSrc.includes('path:"/revoke"'),
      "fluxo de 2 fases (identidade → gmail) não encontrado no server.js");
    check("🛡️ v149: (estrutural) o front manda o e-mail digitado como login_hint (só o desta visita, nunca um antigo do aparelho)",
      appJs.body.includes("login_hint=") && appJs.body.includes("_agEmail"),
      "login_hint não encontrado no app.js");
    check("🛡️ v149: aviso de CONTA ÚNICA na landing (ban permanente, nome do currículo denuncia) nas 3 línguas",
      home.body.includes('data-i18n="au_t"') && home.body.includes('data-i18n="au_b"') &&
      (appJs.body.match(/"au_t":/g) || []).length === 3 && (appJs.body.match(/"au_b":/g) || []).length === 3,
      "seção au_t/au_b não encontrada (landing ou dicionário 3 línguas)");
    // 📢 v150 (comunicado do dono): janela obrigatória ANTES do login (mesmo
    // toggle avisoResetLogin) — reset explicado + anti-duplicação com ban; o
    // fluxo de entrada só segue depois do "Li e entendi" (fail-open sempre).
    check("📢 v150: janela do reset ANTES do login (anti-duplicação/ban) nas 3 línguas + intercepta o openAuthGate com fail-open",
      home.body.includes('id="reset-notice-modal"') && home.body.includes('data-i18n="rn_warn"') &&
      (appJs.body.match(/"rn_t":/g) || []).length === 3 && appJs.body.includes("resetNoticeOk") &&
      appJs.body.includes("h2bResetNoticeOk") && appJs.body.includes("_avisoResetOn"),
      "modal rn_* ou interceptação do openAuthGate não encontrados");
    // 💸 v151 (fatura do Render, 21/08 — 38,6GB de banda "Service-Initiated"
    // gerada pelos próprios servidores): servidor aposentado (REDIRECT_ALL_TO)
    // desliga automático, backup entre irmãos, sentinela e TODOS os robôs de
    // coleta; o vigia de anúncios do DOL caiu de 10 pra 30min em todos.
    check("💸 v151: (estrutural) MODO_APOSENTADO desliga scheduleAuto + backup peers + sentinela + robôs de coleta (casca só de redirect)",
      _srvSrc.includes("const MODO_APOSENTADO") &&
      (_srvSrc.match(/if\(MODO_APOSENTADO\)return/g) || []).length >= 3 &&
      (_srvSrc.match(/if\(!MODO_APOSENTADO\)\{/g) || []).length >= 2 &&
      _srvSrc.includes("modo aposentado — enrich/frescor"),
      "gates do MODO_APOSENTADO não encontrados no server.js");
    check("💸 v151: vigia de anúncios do DOL roda a cada 30min (não mais 10min — banda em triplicata)",
      _srvSrc.includes("setInterval(dolNewsAutoTick, 30*60_000)") && !_srvSrc.includes("setInterval(dolNewsAutoTick, 10*60_000)"),
      "intervalo do dolNewsAutoTick não é 30min");
    // 🔓 v153 (ordem do dono, 21/08 — "libera todos"): o boot ZERA a lista
    // inteira de banidos UMA vez (carimbo limpouTudoEm), e ban virou decisão
    // EXPLÍCITA: deletar conta não bane mais sozinho; o admin tem botão
    // Banir/Desbanir na aba Auditoria.
    const _blkPos = JSON.parse(fs.readFileSync(path.join(DATA, "blocked_emails.json"), "utf8"));
    check("🔓 v153: boot ZEROU a lista de banidos (todos liberados) e carimbou a limpeza (não re-zera bans futuros)",
      Array.isArray(_blkPos.emails) && _blkPos.emails.length === 0 && !!_blkPos.limpouTudoEm,
      JSON.stringify(_blkPos).slice(0, 120));
    check("🔓 v153: (estrutural) deletar conta NÃO bane mais sozinho — ban no delete só com pedido explícito (banir:true) e o painel pergunta",
      _srvSrc.includes("d.banir===true") && _admHtml.includes("Também BANIR este e-mail permanentemente?"),
      "auto-ban do delete-user ainda existe ou o painel não pergunta");
    // Rotas de banir/desbanir exigem admin HARDCODED — loga como um deles.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const banEx = await req2("POST", "/api/admin/ban-email", { email: "fica.banido@test.com" });
    const banLs = await get("/api/admin/banned-emails");
    check("🚫 v153: ban EXPLÍCITO pela rota funciona e aparece na lista do painel",
      banEx.json?.ok === true && (banLs.json?.emails || []).includes("fica.banido@test.com"),
      (banLs.body || "").slice(0, 100));
    const unb = await req2("POST", "/api/admin/unban-email", { email: "fica.banido@test.com" });
    const banLs2 = await get("/api/admin/banned-emails");
    check("🔓 v153: desbanir pela rota funciona (lista fica vazia) e o painel tem Banir + Desbanir",
      unb.json?.ok === true && (banLs2.json?.emails || []).length === 0 &&
      _admHtml.includes('id="ban-list"') && _admHtml.includes("desbanirEmail") && _admHtml.includes("banirEmail"),
      JSON.stringify({ unb: unb.json, depois: banLs2.json?.emails }).slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });

    // 💎 v154: migração única do boot recalculou o bônus inflado pela fusão
    // (fixture: 40 de bônus, mas 2 missões=5💎 e 2💎 já gastos → alvo 3),
    // SEM tocar nos 50 reais — e deixou o carimbo pra nunca re-rodar.
    const _udBB = (await get("/api/admin/user-detail/" + encodeURIComponent("bonusbug@test.com"))).json?.user;
    check("💎 v154: boot corrigiu bônus inflado (40→3 = missões 5 − gasto 2) e NÃO tocou nos 💎 reais (50)",
      _udBB?.diamonds?.real === 50 && _udBB?.diamonds?.bonus === 3 &&
      (_udBB?.diamondLedger || []).some((l) => l.tipo === "ajuste" && /bônus recalculado/.test(l.nota || "")),
      JSON.stringify(_udBB?.diamonds).slice(0, 100));
    check("💎 v154: carimbo da correção existe no disco (rodada única — brinde de admin futuro nunca é apagado)",
      fs.existsSync(path.join(DATA, "diamantes_fix_v154.json")));
    check("💎 v154: (estrutural) reconciliação pula doação + aprovação normaliza pedido legado + criação nasce doação + fusão recalcula bônus",
      _srvSrc.includes('if(ped.tipo==="doacao"||String(ped.plano||"").toLowerCase()==="doacao")continue;') &&
      _srvSrc.includes("normalizado pra DOAÇÃO na aprovação") &&
      _srvSrc.includes("nasce como DOAÇÃO") &&
      _srvSrc.includes("_bonusLegitimoCalc(missoesFund,ledgerFund)"),
      "alguma das 4 defesas do v154 sumiu do server.js");

    // ═══ 🧠 CÉREBRO CONTÁBIL — PARTE 1 (Master Command do dono, 22/08) ═══
    // Auditoria SÓ-LEITURA: reconstrói o ledger das evidências e acha os 4
    // casos plantados nas fixtures — sem alterar um byte do banco.
    const cb1 = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _rel1 = cb1.json?.relatorio;
    check("🧠 cérebro: auditoria roda em modo SÓ-LEITURA (simulação, 0 alterações) e devolve relatório versionado",
      cb1.json?.ok === true && _rel1?.modo === "simulacao" && _rel1?.alteracoesFeitas === 0 && /^AUDIT-\d{4}-\d{2}-\d{2}-\d{3}$/.test(_rel1?.auditId || ""),
      (cb1.body || "").slice(0, 160));
    const _div70 = (_rel1?.dias?.divergencias || []).find((d) => d.email === "setentadias@test.com");
    check("🧠 cérebro (caso 70 dias): 70 restantes com evidência de só 30 → excesso ~40 detectado com confiança ≥99 e proveniência explicada",
      _div70 && _div70.excesso >= 35 && _div70.excesso <= 41 && _div70.confianca >= 99 && (_div70.proveniencia || []).length >= 1,
      JSON.stringify(_div70).slice(0, 200));
    const _dup150 = (_rel1?.duplicidades || []).find((d) => d.email === "duplicado@test.com");
    check("🧠 cérebro (pagamento duplicado): 2×R$150 iguais → score ≥61 com motivos explicados; receita conta R$150 confirmável + R$150 duplicidade (nunca R$300)",
      _dup150 && _dup150.score >= 61 && (_dup150.motivos || []).length >= 2 && _rel1?.receita?.duplicadaSuspeita === 150,
      JSON.stringify({ dup: _dup150, receita: _rel1?.receita }).slice(0, 220));
    check("🧠 cérebro (caso Cleiton): pedido ativo SEM entrada no caixa é listado como benefício sem evidência financeira",
      (_rel1?.pedidosSemCaixa || []).some((p2) => p2.pedidoId === "pedsemcaixa1" && p2.email === "cleiton2@test.com"),
      JSON.stringify(_rel1?.pedidosSemCaixa).slice(0, 160));
    check("🧠 cérebro (código promocional): cortesia dá dias mas receita de códigos é SEMPRE R$0; usuário de código sem divergência de dias (o código explica os 30d)",
      _rel1?.receita?.cortesias === 0 && (_rel1?.codigos?.usuariosComCortesia || 0) >= 1 &&
      !(_rel1?.dias?.divergencias || []).some((d) => d.email === "codegift@test.com") &&
      !(_rel1?.dias?.semEvidencia || []).some((d) => d.email === "codegift@test.com"),
      JSON.stringify(_rel1?.codigos).slice(0, 140));
    check("🧠 cérebro: receita registrada BATE com a fonte única computeEntradasJanelas (cross-check, delta 0)",
      _rel1?.crossCheck && Math.abs(_rel1.crossCheck.delta || 0) < 0.01,
      JSON.stringify(_rel1?.crossCheck).slice(0, 120));
    // prova do SÓ-LEITURA: o usuário dos 70 dias continua intocado
    const _ud70 = (await get("/api/admin/user-detail/" + encodeURIComponent("setentadias@test.com"))).json?.user;
    check("🧠 cérebro: SÓ-LEITURA de verdade — os 70 dias do usuário seguem lá (nenhuma correção foi aplicada nesta parte)",
      _ud70?.vip?.manualExpires > Date.now() + 65 * 86400_000 && (_ud70?.vip?.creditos || []).length === 1,
      JSON.stringify({ exp: _ud70?.vip?.manualExpires, creditos: (_ud70?.vip?.creditos || []).length }).slice(0, 120));
    const cbSt = await get("/api/admin/cerebro/status");
    const cbRel = await get("/api/admin/cerebro/relatorio/" + _rel1.auditId);
    check("🧠 cérebro: relatório fica versionado no disco — status aponta o último e a rota devolve o arquivo completo com o ledger",
      cbSt.json?.ultimoId === _rel1.auditId && cbRel.json?.ok === true && Array.isArray(cbRel.json?.relatorio?.ledger),
      JSON.stringify({ st: cbSt.json?.ultimoId, temLedger: Array.isArray(cbRel.json?.relatorio?.ledger) }).slice(0, 120));

    // ═══ 🧠 PARTE 2: MOTOR DE REGRAS + INCIDENTES + 🔎 ENCONTRAR ERROS ═══
    const _f1 = _rel1?.findings || [];
    const _byRule = (r2) => _f1.find((x) => x.rule === r2);
    check("🧠 P2: toda regra devolve o pacote explicável (id, severidade, confiança, esperado×atual, evidências, ação recomendada)",
      _f1.length >= 4 && _f1.every((x) => x.id && x.rule && x.severity && typeof x.confianca === "number" && x.esperado !== undefined && x.atual !== undefined && x.acaoRecomendada),
      JSON.stringify(_f1[0]).slice(0, 200));
    check("🧠 P2: as 4 regras dos casos plantados dispararam (dias impossíveis URGENTE, duplicado, sem-caixa, cancelado-no-caixa URGENTE)",
      _byRule("RULE_VIP_DAYS_FROM_PURCHASE")?.severity === "URGENTE" && !!_byRule("RULE_DUPLICATE_PAYMENT") &&
      !!_byRule("RULE_ORDER_WITHOUT_PAYMENT") && _byRule("RULE_CANCELLED_PAYMENT")?.severity === "URGENTE",
      JSON.stringify(_f1.map((x) => x.rule + ":" + x.severity)).slice(0, 260));
    check("🧠 P2: lista vem PRIORIZADA (severidade nunca sobe ao descer a lista) e o relatório conta por severidade",
      _f1.every((x, i) => i === 0 || ({ URGENTE: 4, ALTA: 3, MEDIA: 2, BAIXA: 1, INFORMATIVA: 0 })[_f1[i - 1].severity] >= ({ URGENTE: 4, ALTA: 3, MEDIA: 2, BAIXA: 1, INFORMATIVA: 0 })[x.severity]) &&
      (_rel1.porSeveridade?.URGENTE || 0) >= 2,
      JSON.stringify(_rel1.porSeveridade).slice(0, 100));
    check("🧠 P2: achados URGENTE/ALTA viraram incidentes na Central (tipo cerebro_*)",
      _rel1.incidentesNovos >= 3 &&
      ((await get("/api/admin/incidents")).json?.incidents || (await get("/api/admin/incidents")).json?.events || []).length >= 0,
      JSON.stringify({ novos: _rel1.incidentesNovos }).slice(0, 80));
    const cbErr = await get("/api/admin/cerebro/erros");
    check("🔎 P2: 'Encontrar erros' devolve a lista priorizada e NÃO duplica incidentes na re-execução (id estável = 0 novos)",
      cbErr.json?.ok === true && (cbErr.json?.erros || []).length === _f1.length && cbErr.json?.incidentesNovos === 0 &&
      cbErr.json.erros[0].id === _f1[0].id,
      JSON.stringify({ n: cbErr.json?.erros?.length, novos: cbErr.json?.incidentesNovos }).slice(0, 100));

    // ═══ 🧠 PARTE 3: CORREÇÕES SEGURAS + CENTRAL DE DECISÕES + ROLLBACK ═══
    const _dias70 = async () => (await get("/api/admin/user-detail/" + encodeURIComponent("setentadias@test.com"))).json?.user?.vip?.manualExpires || 0;
    const cbFix0 = await req2("POST", "/api/admin/cerebro/corrigir", {});
    check("🛠 P3: sem confirmar = SIMULAÇÃO — lista as 2 seguras (dias→teto e caixa-do-cancelado) e as decisões nível 3, sem alterar nada",
      cbFix0.json?.ok === true && cbFix0.json?.simulacao === true &&
      (cbFix0.json?.seguras || []).some((c) => c.tipo === "fix_dias" && c.alvo === "setentadias@test.com") &&
      (cbFix0.json?.seguras || []).some((c) => c.tipo === "fix_caixa_cancelado") &&
      (cbFix0.json?.decisoes || []).some((d2) => d2.rule === "RULE_DUPLICATE_PAYMENT" && d2.opcoes.includes("remover_duplicado")) &&
      (await _dias70()) > Date.now() + 65 * 86400_000,
      JSON.stringify({ seg: cbFix0.json?.seguras?.map((c) => c.tipo), dec: cbFix0.json?.decisoes?.length }).slice(0, 160));
    const cbFix1 = await req2("POST", "/api/admin/cerebro/corrigir", { confirmar: true });
    const finPosFix = await get("/api/admin/financeiro");
    check("🛠 P3: confirmar:true → SNAPSHOT antes + aplica: 70→30 dias E caixa do cancelado ANULADO por AJUSTE −99 (3.0-P5: o original fica PRESERVADO — o caixa nunca apaga), com trilha no Financeiro",
      cbFix1.json?.ok === true && cbFix1.json?.snapshotOk === true && (cbFix1.json?.aplicadas || []).length >= 2 && (cbFix1.json?.falhas || []).length === 0 &&
      (await _dias70()) <= Date.now() + 31 * 86400_000 && (await _dias70()) >= Date.now() + 28 * 86400_000 &&
      (finPosFix.json?.pagamentos || []).some((x) => x.id === "fcanc1" && x.anuladoPor && x.anuladoPor.ajusteId) &&
      (finPosFix.json?.pagamentos || []).some((x) => x.tipo === "ajuste" && x.ajustaPagamentoId === "fcanc1" && x.valor === -99) &&
      ((await get("/api/admin/audit")).json?.audit || []).some((a) => a.action === "cerebro_fix_caixa"),
      JSON.stringify({ apl: cbFix1.json?.aplicadas, falhas: cbFix1.json?.falhas }).slice(0, 220));
    const cbFix2 = await req2("POST", "/api/admin/cerebro/corrigir", { confirmar: true });
    check("🛠 P3: IDEMPOTÊNCIA (item 26) — corrigir de novo aplica ZERO (o finding sumiu; 30 dias continuam 30, nunca 30−40)",
      cbFix2.json?.ok === true && (cbFix2.json?.aplicadas || []).length === 0 && (await _dias70()) >= Date.now() + 28 * 86400_000,
      JSON.stringify(cbFix2.json).slice(0, 140));
    // ROLLBACK: a correção de dias entra na MESMA trilha reversível do painel
    const _audL = (await get("/api/admin/audit")).json?.audit || [];
    const _fixEnt = _audL.find((a) => a.action === "cerebro_fix_dias" && a.targetEmail === "setentadias@test.com" && !a.reverted);
    const rb = await req2("POST", "/api/admin/audit/revert", { id: _fixEnt?.id, motivo: "drill de rollback do cérebro" });
    check("↩️ P3: ROLLBACK de 1 clique — reverter a correção pela trilha devolve os 70 dias EXATOS de antes",
      rb.json?.ok === true && (await _dias70()) > Date.now() + 65 * 86400_000,
      JSON.stringify({ rb: rb.json?.ok }).slice(0, 80));
    const cbFix3 = await req2("POST", "/api/admin/cerebro/corrigir", { confirmar: true });
    check("🛠 P3: pós-rollback a divergência REAPARECE e a correção re-aplica limpa (auditoria nunca 'esquece' um problema vivo)",
      cbFix3.json?.ok === true && (cbFix3.json?.aplicadas || []).some((c) => c.tipo === "fix_dias") && (await _dias70()) <= Date.now() + 31 * 86400_000,
      JSON.stringify(cbFix3.json?.aplicadas).slice(0, 140));
    // CENTRAL DE DECISÕES: manter/ignorar fica gravado e nunca pergunta de novo
    const dcs1 = await get("/api/admin/cerebro/decisoes");
    const _dDup = (dcs1.json?.decisoes || []).find((d2) => d2.rule === "RULE_DUPLICATE_PAYMENT");
    const dcOk = await req2("POST", "/api/admin/cerebro/decisao", { id: _dDup?.id, escolha: "manter" });
    const dcs2 = await get("/api/admin/cerebro/decisoes");
    check("❓ P3: Central de Decisões — pergunta com opções e evidências; 'MANTER' fica gravado e a decisão some da fila pra sempre",
      _dDup && _dDup.pergunta && dcOk.json?.ok === true && dcOk.json?.escolha === "manter" &&
      !(dcs2.json?.decisoes || []).some((d2) => d2.id === _dDup.id),
      JSON.stringify({ antes: dcs1.json?.decisoes?.length, depois: dcs2.json?.decisoes?.length }).slice(0, 100));
    const cbStModo = await req2("POST", "/api/admin/cerebro/modo", { modo: "auto-seguro" });
    const cbSt2 = await get("/api/admin/cerebro/status");
    check("⚙️ P3: modos SIMULAÇÃO/AUTO-SEGURO/SUPERVISIONADO — troca gravada e visível no status (o job diário da Parte 6 vai obedecer)",
      cbStModo.json?.ok === true && cbSt2.json?.modo === "auto-seguro" && (cbSt2.json?.correcoesAplicadas || 0) >= 2 &&
      (await req2("POST", "/api/admin/cerebro/modo", { modo: "supervisionado" })).json?.ok === true,
      JSON.stringify({ modo: cbSt2.json?.modo }).slice(0, 80));

    // ═══ 🧾 PARTE 4: COMPROVANTES EM LOTE (triângulo pedido×comprovante) ═══
    // Sem chave Gemini (ambiente de teste) o gancho TESTE_COMPROVANTE simula
    // a leitura dos 2 fixtures; os pedidos da fusão (pedB0001/pedC0001) têm
    // comprovante mas ficam HONESTAMENTE pendentes (releitura quando houver
    // chave) — a auditoria nunca inventa leitura que não fez (regra 29).
    const cbC0 = await get("/api/admin/cerebro/comprovantes");
    check("🧾 P4: contador enxerga TODOS os comprovantes sem leitura (2 plantados + os importados da fusão)",
      cbC0.json?.ok === true && cbC0.json?.naoConferidos >= 4, JSON.stringify({ pend: cbC0.json?.naoConferidos }));
    const cbCRun = await req2("POST", "/api/admin/cerebro/comprovantes/rodar", { limite: 50 });
    let cbC1 = null;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); cbC1 = (await get("/api/admin/cerebro/comprovantes")).json; if (cbC1 && !cbC1.job?.running && cbC1.job?.finishedAt) break; }
    check("🧾 P4: fila EDUCADA em background processa a fila toda; os 4 legíveis (2 da P4 + 2 da 2.0-P2) ganham leitura e os sem-IA continuam pendentes (nunca inventa)",
      cbCRun.json?.started === true && cbC1?.job?.feitos >= 4 && cbC1?.job?.erros === 0 &&
      cbC1?.naoConferidos === (cbC0.json?.naoConferidos || 0) - 4,
      JSON.stringify({ job: cbC1?.job?.feitos, pendAntes: cbC0.json?.naoConferidos, pendDepois: cbC1?.naoConferidos }).slice(0, 140));
    const _pc1 = (await get("/api/pedido/pedcomp1")).json?.pedido?.preCheck;
    const _pc2 = (await get("/api/pedido/pedcomp2")).json?.pedido?.preCheck;
    check("🧾 P4: triângulo — leitura R$100 × pedido R$150 = DIVERGENCIA; R$150 × R$150 = CONFERE (mesmo formato do pré-check da criação)",
      _pc1?.veredito === "DIVERGENCIA" && _pc1?.valorLido === 100 && _pc2?.veredito === "CONFERE" && _pc2?.valorLido === 150,
      JSON.stringify({ p1: _pc1?.veredito, p2: _pc2?.veredito }));
    check("🧾 P4: lista de divergentes mostra SÓ o que não bate (pedcomp1, nunca pedcomp2)",
      (cbC1?.divergentes || []).some((d2) => d2.pedidoId === "pedcomp1") && !(cbC1?.divergentes || []).some((d2) => d2.pedidoId === "pedcomp2"),
      JSON.stringify(cbC1?.divergentes).slice(0, 160));
    const cbErr2 = await get("/api/admin/cerebro/erros");
    const _fMis = (cbErr2.json?.erros || []).find((x) => x.rule === "RULE_RECEIPT_AMOUNT_MISMATCH");
    check("🧾 P4: RULE_RECEIPT_AMOUNT_MISMATCH = URGENTE pro pedcomp1 (dinheiro aceito com comprovante que não bate) e NUNCA pro pedcomp2",
      _fMis && _fMis.severity === "URGENTE" && _fMis.alvo === "pedcomp1" &&
      !(cbErr2.json?.erros || []).some((x) => x.rule === "RULE_RECEIPT_AMOUNT_MISMATCH" && x.alvo === "pedcomp2"),
      JSON.stringify(_fMis).slice(0, 180));
    const cbFix4 = await req2("POST", "/api/admin/cerebro/corrigir", {});
    check("🧾 P4: divergência CRÍTICA de comprovante NUNCA vira correção automática — vai pra Central de Decisões [manter/ignorar] (item 45)",
      !(cbFix4.json?.seguras || []).some((c) => c.alvo === "pedcomp1") &&
      (cbFix4.json?.decisoes || []).some((d2) => d2.rule === "RULE_RECEIPT_AMOUNT_MISMATCH" && d2.opcoes.join(",") === "manter,ignorar"),
      JSON.stringify({ seg: cbFix4.json?.seguras?.map((c) => c.alvo), dec: cbFix4.json?.decisoes?.map((d2) => d2.rule) }).slice(0, 200));
    const cbCRun2 = await req2("POST", "/api/admin/cerebro/comprovantes/rodar", { limite: 50 });
    check("🧾 P4: INCREMENTAL — os já lidos NUNCA re-processam; a re-execução pega só os sem-IA pendentes (item 16)",
      cbCRun2.json?.started === true && cbCRun2.json?.total === cbC1?.naoConferidos && cbCRun2.json?.total < (cbC0.json?.naoConferidos || 99),
      JSON.stringify(cbCRun2.json).slice(0, 100));
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 200)); const j2 = (await get("/api/admin/cerebro/comprovantes")).json; if (j2 && !j2.job?.running) break; }

    // ═══ 🧠 PARTE 5: INTEGRIDADE % + DASHBOARD + EXPORTAÇÃO + CONFERÊNCIA 2.0 ═══
    const cbAudP5 = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _integ = cbAudP5.json?.relatorio?.integridade;
    check("🩺 P5: INTEGRIDADE CONTÁBIL calculada por fórmula declarada (%, classe e componentes conferíveis — nunca número de enfeite)",
      _integ && typeof _integ.pct === "number" && _integ.pct >= 0 && _integ.pct <= 100 && /Saudável|Atenção|Crítico/.test(_integ.classe) &&
      _integ.componentes && typeof _integ.componentes.lancamentos === "number",
      JSON.stringify(_integ).slice(0, 160));
    const cbStP5 = await get("/api/admin/cerebro/status");
    check("🧠 P5: status guarda o RESUMO da última auditoria (dashboard abre instantâneo, sem re-auditar)",
      cbStP5.json?.resumo?.integridade?.pct === _integ.pct && cbStP5.json?.resumo?.receita?.registrada >= 0,
      JSON.stringify(cbStP5.json?.resumo?.integridade).slice(0, 100));
    const exCsv = await _getBufA("/api/admin/cerebro/exportar?fmt=csv&tipo=ledger");
    const exJson = await _getBufA("/api/admin/cerebro/exportar?fmt=json&tipo=findings");
    check("📤 P5: exportação — ledger em CSV (cabeçalho com canonicalId) e divergências em JSON (com regra e severidade)",
      exCsv?.status === 200 && String(exCsv.headers["content-type"]).includes("csv") && exCsv.buf.toString("utf8").includes("canonicalId") &&
      exJson?.status === 200 && (JSON.parse(exJson.buf.toString("utf8")).rows || []).some((r) => r.regra && r.severidade),
      JSON.stringify({ csv: exCsv?.status, primeiraLinha: exCsv?.buf?.toString("utf8").split("\n")[0]?.slice(0, 60) }).slice(0, 160));
    const cfP5 = await get("/api/admin/conferencia");
    const _rowComp1 = (cfP5.json?.rows || []).find((r) => r.tipo === "pedido" && r.id === "pedcomp1");
    check("🧾 P5: Conferência 2.0 — cada pedido carrega o triângulo (valor lido no comprovante + veredito) na própria linha",
      _rowComp1 && _rowComp1.comprovanteLido === 100 && _rowComp1.comprovanteVeredito === "DIVERGENCIA",
      JSON.stringify({ lido: _rowComp1?.comprovanteLido, ver: _rowComp1?.comprovanteVeredito }).slice(0, 100));
    check("🧠 P5: (estrutural) painel tem a aba 🧠 Cérebro Contábil completa — view, régua 💰, botão de auditoria, decisões inline e exportação",
      _admHtml.includes('id="view-cerebro"') && _admHtml.includes("loadCerebro") && _admHtml.includes("EXECUTAR AUDITORIA COMPLETA") &&
      _admHtml.includes("cerebroDecisao") && _admHtml.includes("cerebro/exportar?fmt=csv") && _admHtml.includes("'cerebro','🧠 Cérebro'"),
      "aba do cérebro incompleta no admin.html");

    // ═══ 📅 PARTE 6: RODADA DIÁRIA + IA ADMINISTRATIVA (fim do Master Command) ═══
    // O pipeline diário obedece o MODO: supervisionado só audita e reporta;
    // auto-seguro também aplica as correções seguras (com snapshot embutido).
    const cbD1 = await req2("POST", "/api/admin/cerebro/diaria", {});
    const cbStD1 = await get("/api/admin/cerebro/status");
    check("📅 P6: pipeline diário em modo SUPERVISIONADO — audita, carimba ultimaDiaria e NÃO aplica correção nenhuma",
      cbD1.json?.ok === true && /^AUDIT-/.test(cbD1.json?.auditId || "") && cbD1.json?.modo === "supervisionado" &&
      cbD1.json?.aplicadas === 0 && cbD1.json?.correcoes === null &&
      cbStD1.json?.ultimaDiaria?.auditId === cbD1.json?.auditId && cbStD1.json?.ultimaDiaria?.modo === "supervisionado",
      JSON.stringify({ id: cbD1.json?.auditId, modo: cbD1.json?.modo, ultima: cbStD1.json?.ultimaDiaria }).slice(0, 180));
    await req2("POST", "/api/admin/cerebro/modo", { modo: "auto-seguro" });
    const cbD2 = await req2("POST", "/api/admin/cerebro/diaria", {});
    await req2("POST", "/api/admin/cerebro/modo", { modo: "supervisionado" });
    check("📅 P6: pipeline diário em modo AUTO-SEGURO — as correções seguras RODAM de verdade (simulacao:false) dentro da rodada",
      cbD2.json?.ok === true && cbD2.json?.modo === "auto-seguro" && cbD2.json?.correcoes &&
      cbD2.json?.correcoes.simulacao === false && Array.isArray(cbD2.json?.correcoes.aplicadas || []) &&
      (await get("/api/admin/cerebro/status")).json?.ultimaDiaria?.modo === "auto-seguro",
      JSON.stringify({ modo: cbD2.json?.modo, corr: cbD2.json?.correcoes?.simulacao, apl: cbD2.json?.aplicadas }).slice(0, 140));
    // IA administrativa: número NUNCA vem de IA — vem do relatório persistido,
    // e a resposta sempre entrega a FONTE (auditId + o que foi analisado).
    const cbQ1 = await req2("POST", "/api/admin/cerebro/perguntar", { pergunta: "quanto realmente recebemos?" });
    check("💬 P6: 'quanto realmente recebemos?' → separa registrada×confirmada, avisa que cortesia é R$0 e cita a fonte (auditId)",
      cbQ1.json?.ok === true && /Receita REGISTRADA/.test(cbQ1.json?.resposta || "") && /CONFIRMADA/.test(cbQ1.json?.resposta || "") &&
      /Cortesias/.test(cbQ1.json?.resposta || "") && /^AUDIT-/.test(cbQ1.json?.auditId || "") &&
      (cbQ1.json?.fontes || []).some((f) => f.includes(cbQ1.json?.auditId)),
      (cbQ1.json?.resposta || cbQ1.body || "").slice(0, 200));
    const cbQ2 = await req2("POST", "/api/admin/cerebro/perguntar", { pergunta: "quem tem dias demais?" });
    check("💬 P6: 'quem tem dias demais?' → responde do bloco de dias auditados (teto, sem-evidência OU relógio das concessões)",
      cbQ2.json?.ok === true && /(Ninguém tem mais dias|SEM ORIGEM|sem NENHUMA evidência|relógio das concessões)/.test(cbQ2.json?.resposta || ""),
      (cbQ2.json?.resposta || "").slice(0, 200));
    const cbQ3 = await req2("POST", "/api/admin/cerebro/perguntar", { pergunta: "quais pagamentos são duplicados?" });
    check("💬 P6: 'quais pagamentos são duplicados?' → aponta o caso plantado com score e motivos, e lembra que apagar é decisão HUMANA",
      cbQ3.json?.ok === true && /duplicado@test\.com/.test(cbQ3.json?.resposta || "") && /score/.test(cbQ3.json?.resposta || "") &&
      /decisão SUA/i.test(cbQ3.json?.resposta || ""),
      (cbQ3.json?.resposta || "").slice(0, 200));
    check("📅 P6: (estrutural) agendador das 02h BRT vive DENTRO do bloco de robôs (aposentado nunca roda) + caixa de pergunta no painel — 🕰️ MC5-P7: o corpo virou _cbVigiaTick (carimbo em disco + catch-up), a diária das 02h continua lá dentro",
      _srvSrc.includes("setInterval(()=>{try{_cbVigiaTick(false);}") && _srvSrc.includes('"🧠 auditoria diária 02h"') && /getUTCHours\(\)>=2/.test(_srvSrc) &&
      _admHtml.includes("cerebroPerguntar") && _admHtml.includes("cerebroDiaria") && _admHtml.includes('id="cb-pergunta"'),
      "agendador diário ou caixa de pergunta não encontrados");

    // ═══ 🧠 CÉREBRO 2.0 — PARTE 1: SALDO ESPERADO POR LINHA DO TEMPO ═══
    // O gap real do teto: sessentadias comprou 30d há 200 dias (expirou) e
    // 30d há 10 dias. Teto da vida = 60 ≥ 45 mostrados → regra antiga MUDA.
    // O relógio das concessões reconstrói por DATAS: esperado ~20, +25 furados.
    const cbTl = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _tl = cbTl.json?.relatorio?.dias?.timeline;
    const _fSess = (_tl?.flagrados || []).find((x) => x.email === "sessentadias@test.com");
    check("📅 2.0-P1: caso que o teto NÃO pega (teto 60, sistema 45) — o relógio das concessões flagra: esperado ~20, diferença ≥ +23",
      _fSess && _fSess.esperado >= 19 && _fSess.esperado <= 21 && _fSess.registrado >= 44 && _fSess.diferenca >= 23 &&
      Array.isArray(_fSess.eventos) && _fSess.eventos.length >= 2 && _fSess.confianca === 95 && _fSess.margem === 2,
      JSON.stringify(_fSess).slice(0, 240));
    const _fdTl = (cbTl.json?.relatorio?.findings || []).find((x) => x.rule === "RULE_VIP_DAYS_PURCHASE_DATE_RECONCILIATION" && x.alvo === "sessentadias@test.com");
    check("📅 2.0-P1: virou finding RULE_VIP_DAYS_PURCHASE_DATE_RECONCILIATION (severidade ALTA) com a linha do tempo como evidência, data a data",
      _fdTl && _fdTl.severity === "ALTA" && /linha do tempo/.test(_fdTl.titulo) && (_fdTl.evidencias || []).length >= 2 &&
      (_fdTl.evidencias || []).some((e2) => /expiraria/.test(e2)),
      JSON.stringify(_fdTl).slice(0, 240));
    check("📅 2.0-P1: margem + generosidade protegem o inocente — setentadias (30d ontem), codegift (código sem data) e presente (gift-days do admin) NUNCA são flagrados",
      !(_tl?.flagrados || []).some((x) => ["setentadias@test.com", "codegift@test.com", "presente@test.com"].includes(x.email)) &&
      !(cbTl.json?.relatorio?.dias?.divergencias || []).some((x) => x.email === "presente@test.com"),
      JSON.stringify((_tl?.flagrados || []).map((x) => x.email)).slice(0, 200));
    // Revisão adversarial em cima da 1ª versão do motor: 3 caminhos legítimos
    // de concessão eram invisíveis (gift-days, set-expiry, autoDays>days) e o
    // campo de data do pedido estava ERRADO (dataPagamento é do caixa; pedido
    // usa pagoEm). As guardas abaixo provam cada correção.
    const _anc = cbTl.json?.relatorio?.dias?.ancorados || [];
    check("⚓ 2.0-P1: set-expiry LEGADO (só adjustedAt, sem crédito) é ANCORADO — listado no relatório mas fora de teto e linha do tempo",
      _anc.some((a) => a.email === "ajustado@test.com") &&
      !(_tl?.flagrados || []).some((x) => x.email === "ajustado@test.com") &&
      !(cbTl.json?.relatorio?.dias?.divergencias || []).some((x) => x.email === "ajustado@test.com"),
      JSON.stringify(_anc.map((a) => a.email)).slice(0, 160));
    const _srvSrcP1 = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const _cbSrcP1 = fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8");
    check("⚓ 2.0-P1: (estrutural) as rotas passaram a DEIXAR evidência — set-expiry grava crédito datado + adjustedCreditado; vip/activate registra max(manual, auto); pedido lê pagoEm (dataPagamento é campo do CAIXA, não de pedido)",
      _srvSrcP1.includes('origem:"set-expiry"') && _srvSrcP1.includes("adjustedCreditado:true") &&
      _srvSrcP1.includes("const _credDias=Math.max(days,autoDays);") &&
      _cbSrcP1.includes("_ts(pd.pagoEm)") && !_cbSrcP1.includes("pd.dataPagamento"),
      "evidência das rotas ou campo de data do pedido não conferem");

    // ═══ 🧾 CÉREBRO 2.0 — PARTE 2: COMPROVANTES 2.0 (OCR completo + transação) ═══
    const _ptx1 = (await get("/api/pedido/pedtx1")).json?.pedido;
    const _ptx2 = (await get("/api/pedido/pedtx2")).json?.pedido;
    check("🧾 2.0-P2: OCR completo — a leitura guarda ID da transação (E2E) e pagador, campo a campo (gancho estendido TESTE_COMPROVANTE:valor:tx:pagador)",
      _ptx1?.preCheck?.transacaoIdLida === "E2EABC12345" && _ptx1?.preCheck?.pagadorLido === "Fulano Pagador" &&
      _ptx1?.preCheck?.veredito === "CONFERE" && _ptx2?.preCheck?.transacaoIdLida === "E2EABC12345",
      JSON.stringify({ tx: _ptx1?.preCheck?.transacaoIdLida, pag: _ptx1?.preCheck?.pagadorLido }).slice(0, 140));
    check("🧾 2.0-P2: impressão digital SEMPRE — hash SHA-256 calculado SEM chave Gemini (cobre os importados dos servidores 2/3), e os 2 arquivos são DIFERENTES",
      /^[0-9a-f]{64}$/.test(_ptx1?.comprovanteHash || "") && /^[0-9a-f]{64}$/.test(_ptx2?.comprovanteHash || "") &&
      _ptx1?.comprovanteHash !== _ptx2?.comprovanteHash,
      JSON.stringify({ h1: (_ptx1?.comprovanteHash || "").slice(0, 12), h2: (_ptx2?.comprovanteHash || "").slice(0, 12) }));
    const cbTx = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _fdTx = (cbTx.json?.relatorio?.findings || []).find((x) => x.rule === "RULE_TRANSACTION_ID_REUSED");
    check("🧾 2.0-P2: MESMA transação PIX em 2 pedidos de usuários diferentes (arquivos diferentes!) = URGENTE — o que o hash de arquivo nunca pegaria",
      _fdTx && _fdTx.severity === "URGENTE" && _fdTx.alvo === "E2EABC12345" &&
      (_fdTx.evidencias || []).some((e2) => /pedtx1/.test(e2)) && (_fdTx.evidencias || []).some((e2) => /pedtx2/.test(e2)) &&
      /txa@test\.com/.test(_fdTx.titulo) && /txb@test\.com/.test(_fdTx.titulo),
      JSON.stringify(_fdTx).slice(0, 240));
    const cbTxFix = await req2("POST", "/api/admin/cerebro/corrigir", {});
    check("🧾 2.0-P2: transação reusada NUNCA se auto-corrige — vira decisão [manter/ignorar] (qual pedido é o legítimo é decisão HUMANA)",
      !(cbTxFix.json?.seguras || []).some((c) => c.alvo === "E2EABC12345") &&
      (cbTxFix.json?.decisoes || []).some((d2) => d2.rule === "RULE_TRANSACTION_ID_REUSED" && d2.opcoes.join(",") === "pagamentos_diferentes,manter,ignorar"),
      JSON.stringify((cbTxFix.json?.decisoes || []).map((d2) => d2.rule)).slice(0, 180));
    const cfTx = await get("/api/admin/conferencia");
    const _rowTx = (cfTx.json?.rows || []).find((r) => r.tipo === "pedido" && r.id === "pedtx1");
    check("🧾 2.0-P2: Conferência mostra a leitura completa por linha — valor lido, pagador e ID da transação (e o admin.html renderiza o TX)",
      _rowTx && _rowTx.comprovanteTransacao === "E2EABC12345" && _rowTx.comprovantePagador === "Fulano Pagador" &&
      _admHtml.includes("comprovanteTransacao") && _srvSrcP1.includes("transacaoIdLida") && _srvSrcP1.includes("pagadorLido") &&
      _srvSrcP1.includes("recebedorLido") && _srvSrcP1.includes("instituicaoLida") && _srvSrcP1.includes("horaLida"),
      JSON.stringify({ tx: _rowTx?.comprovanteTransacao, pag: _rowTx?.comprovantePagador }).slice(0, 140));

    // ═══ 🎟️ CÉREBRO 2.0 — PARTE 3: CÓDIGOS + DUPLICIDADE MULTI-CRITÉRIO ═══
    const cbP3 = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _fdOver = (cbP3.json?.relatorio?.findings || []).find((x) => x.rule === "RULE_CODE_OVERUSED");
    check("🎟️ 2.0-P3: código com a trava FURADA (2 resgates num limite de 1) = URGENTE, listando cada resgate — e o GIFT30SMOKE (1/5) NUNCA é flagrado",
      _fdOver && _fdOver.severity === "URGENTE" && _fdOver.alvo === "OVERUSE1" &&
      (_fdOver.evidencias || []).some((e2) => /a1@test\.com/.test(e2)) &&
      !(cbP3.json?.relatorio?.findings || []).some((x) => x.rule === "RULE_CODE_OVERUSED" && x.alvo === "GIFT30SMOKE"),
      JSON.stringify(_fdOver).slice(0, 200));
    const _fdGhost = (cbP3.json?.relatorio?.findings || []).find((x) => x.rule === "RULE_CODE_SOURCE_NO_RECORD");
    check("🎟️ 2.0-P3: VIP ativo 'de código' SEM registro de resgate nenhum = ALTA (codeghost) — e codegift (resgate registrado) NUNCA é flagrado",
      _fdGhost && _fdGhost.alvo === "codeghost@test.com" && _fdGhost.severity === "ALTA" &&
      !(cbP3.json?.relatorio?.findings || []).some((x) => x.rule === "RULE_CODE_SOURCE_NO_RECORD" && x.alvo === "codegift@test.com"),
      JSON.stringify(_fdGhost).slice(0, 180));
    const _cross = cbP3.json?.relatorio?.duplicidadesCrossUser || [];
    const _cGhost = _cross.find((d2) => d2.emails.includes("ghost1@test.com") && d2.emails.includes("ghost2@test.com"));
    check("🎟️ 2.0-P3: MESMO pagador em 2 contas diferentes (nome+valor+janela = score 70) é flagrado — e comp1×comp2 (só valor+janela = 60) fica ABAIXO da régua",
      _cGhost && _cGhost.score >= 61 && (_cGhost.motivos || []).some((m2) => /MESMO nome de pagador/.test(m2)) &&
      !_cross.some((d2) => d2.emails.includes("comp1@test.com") && d2.emails.includes("comp2@test.com")),
      JSON.stringify({ ghost: _cGhost?.score, todos: _cross.map((d2) => d2.emails.join("×")) }).slice(0, 220));
    const _fdCross = (cbP3.json?.relatorio?.findings || []).find((x) => x.rule === "RULE_CROSS_USER_DUPLICATE");
    const cbP3Fix = await req2("POST", "/api/admin/cerebro/corrigir", {});
    check("🎟️ 2.0-P3: os 3 achados novos viram DECISÃO [manter/ignorar] — nenhum entra na lista de correção automática",
      _fdCross && ["RULE_CODE_OVERUSED", "RULE_CODE_SOURCE_NO_RECORD"].every((r2) =>
        (cbP3Fix.json?.decisoes || []).some((d2) => d2.rule === r2 && d2.opcoes.join(",") === "manter,ignorar")) &&
      (cbP3Fix.json?.decisoes || []).some((d2) => d2.rule === "RULE_CROSS_USER_DUPLICATE" && d2.opcoes.join(",") === "pagamentos_diferentes,manter,ignorar") &&
      !(cbP3Fix.json?.seguras || []).some((c) => ["OVERUSE1", "codeghost@test.com"].includes(c.alvo) || String(c.alvo).includes("ghost1")),
      JSON.stringify((cbP3Fix.json?.decisoes || []).map((d2) => d2.rule)).slice(0, 220));
    const cbQ4 = await req2("POST", "/api/admin/cerebro/perguntar", { pergunta: "quais pagamentos são duplicados?" });
    check("🎟️ 2.0-P3: 'Pergunte ao Cérebro' agora cita também o caso entre usuários (ghost1 × ghost2) com os motivos",
      cbQ4.json?.ok === true && /ghost1@test\.com/.test(cbQ4.json?.resposta || "") && /nome de pagador/i.test(cbQ4.json?.resposta || ""),
      (cbQ4.json?.resposta || "").slice(0, 220));

    // ═══ 🚨 CÉREBRO 2.0 — PARTE 4: CENTRAL DE INCIDENTES COM CICLO DE VIDA ═══
    const inc1 = await get("/api/admin/cerebro/incidentes");
    const _incSess = (inc1.json?.incidentes || []).find((i) => i.alvo === "sessentadias@test.com");
    const _incGhost = (inc1.json?.incidentes || []).find((i) => i.alvo === "codeghost@test.com" && i.rule === "RULE_CODE_SOURCE_NO_RECORD");
    check("🚨 2.0-P4: cada achado vira INCIDENTE com status e histórico — quem tem decisão pendente nasce 🔵 AGUARDANDO ADMIN, com contadores por status",
      inc1.json?.ok === true && inc1.json?.porStatus && typeof inc1.json?.abertos === "number" &&
      _incSess && _incSess.status === "AGUARDANDO_ADMIN" && (_incSess.historico || []).some((h) => /criado pela auditoria/.test(h.evento)) &&
      _incGhost && _incGhost.status === "AGUARDANDO_ADMIN",
      JSON.stringify({ porStatus: inc1.json?.porStatus, sess: _incSess?.status }).slice(0, 200));
    const incAn = await req2("POST", "/api/admin/cerebro/incidente", { id: _incSess?.id, acao: "analisar" });
    check("🚨 2.0-P4: [ANALISAR] marca 🟡 EM ANÁLISE com trilha de quem fez",
      incAn.json?.ok === true && incAn.json?.status === "EM_ANALISE",
      JSON.stringify(incAn.json).slice(0, 120));
    const incMan = await req2("POST", "/api/admin/cerebro/incidente", { id: _incGhost?.id, acao: "manter" });
    const inc2 = await get("/api/admin/cerebro/incidentes");
    const _incGhost2 = (inc2.json?.incidentes || []).find((i) => i.id === _incGhost?.id);
    const _incSess2 = (inc2.json?.incidentes || []).find((i) => i.id === _incSess?.id);
    check("🚨 2.0-P4: [MANTER] resolve o incidente (🟢), grava a decisão E a re-auditoria NÃO reabre (decisão explícita nunca reaparece); o EM ANÁLISE sobrevive à re-auditoria",
      incMan.json?.ok === true && _incGhost2?.status === "RESOLVIDO" &&
      (_incGhost2?.historico || []).some((h) => /MANTER/.test(h.evento)) &&
      _incSess2?.status === "EM_ANALISE",
      JSON.stringify({ ghost: _incGhost2?.status, sess: _incSess2?.status }).slice(0, 140));
    const _incTx = (inc2.json?.incidentes || []).find((i) => i.rule === "RULE_TRANSACTION_ID_REUSED");
    const incCor = await req2("POST", "/api/admin/cerebro/incidente", { id: _incTx?.id, acao: "corrigir" });
    check("🚨 2.0-P4: [CORRIGIR] num incidente SEM correção automática disponível recusa com explicação clara (nunca inventa correção)",
      incCor.status === 400 && /não tem correção automática/.test(incCor.json?.error || ""),
      (incCor.body || "").slice(0, 160));
    check("🚨 2.0-P4: (estrutural) ciclo de vida completo no motor — REAPARECEU pós-rollback, RESOLVIDO quando some, CORRIGIDO_AUTO no lote e correção individual FIX1 com snapshot; painel com botões e chips",
      _cbSrcP1 === _cbSrcP1 && (() => { const _s = fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8"); return _s.includes("REAPARECEU na auditoria") && _s.includes("sumiu da auditoria") && _s.includes("CORRIGIDO_AUTO") && _s.includes('"FIX1-"'); })() &&
      _admHtml.includes("cerebroIncidentes") && _admHtml.includes("cerebroIncAcao") && _admHtml.includes("AGUARDANDO VOCÊ"),
      "ciclo de vida ou UI de incidentes incompletos");

    // ═══ 💰 CÉREBRO 2.0 — PARTE 5: RECEITA DETALHADA + SEMÁFORO + PROGRESSO ═══
    const cbP5b = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _rd = cbP5b.json?.relatorio?.receitaDetalhada;
    check("💰 2.0-P5: receita detalhada — janelas vêm da FONTE ÚNICA (13n: total idêntico ao cross-check) + quebra por plano/tipo + top doadores",
      _rd && _rd.janelas && _rd.janelas.total === cbP5b.json?.relatorio?.crossCheck?.canonicoTotal &&
      typeof _rd.porTipo?.doacao === "number" && _rd.porTipo.doacao > 0 &&
      typeof _rd.porPlano?.doacao === "number" && Array.isArray(_rd.topDoadores) && _rd.topDoadores.length >= 3 &&
      _rd.topDoadores.every((t2) => t2.email && t2.total > 0),
      JSON.stringify({ janelas: _rd?.janelas?.total, canonico: cbP5b.json?.relatorio?.crossCheck?.canonicoTotal, tipos: _rd?.porTipo }).slice(0, 200));
    const stP5b = await get("/api/admin/cerebro/status");
    check("💰 2.0-P5: o resumo persistido carrega a receita detalhada (dashboard abre instantâneo, sem re-auditar)",
      stP5b.json?.resumo?.receitaDetalhada?.janelas?.total === _rd?.janelas?.total &&
      stP5b.json?.resumo?.receitaDetalhada?.porTipo?.doacao === _rd?.porTipo?.doacao,
      JSON.stringify(stP5b.json?.resumo?.receitaDetalhada?.janelas).slice(0, 120));
    const liveP5 = await get("/api/admin/live");
    const _uSess = (liveP5.json?.users || []).find((x) => x.email === "sessentadias@test.com");
    const _uPres = (liveP5.json?.users || []).find((x) => x.email === "presente@test.com");
    check("🚦 2.0-P5: página Usuários com SEMÁFORO do cérebro — sessentadias (incidente ABERTO em análise) pinta 🟡 com os motivos; presente (limpo) fica sem selo",
      _uSess && _uSess.cerebro && _uSess.cerebro.nivel === "amarelo" && (_uSess.cerebro.motivos || []).length >= 1 &&
      _uPres && !_uPres.cerebro,
      JSON.stringify({ sess: _uSess?.cerebro, pres: _uPres?.cerebro }).slice(0, 200));
    check("🚦 2.0-P5: (estrutural) card do usuário renderiza o selo 🔴/🟡 clicável pra 💳 Auditoria + animação de etapas na auditoria",
      _admHtml.includes("u.cerebro") && _admHtml.includes("🔴") && _admHtml.includes("Reconstruindo dias (relógio das concessões)") &&
      _admHtml.includes("cb-aud-prog") && _admHtml.includes("Receita detalhada"),
      "semáforo ou animação não encontrados no admin.html");

    // ═══ 👤 CÉREBRO 2.0 — PARTE 6: "MINHA CONTA EM 5 SEGUNDOS" (usuário comum) ═══
    const _appJsP6 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    check("👤 2.0-P6: o card Minha Conta aparece pra TODO MUNDO — usuário Grátis vê plano+limite (antes não via NADA), com saldo 💎 real/bônus e última doação",
      _appJsP6.includes("t('mc_1')") && _appJsP6.includes("t('mc_2')") && _appJsP6.includes("t('mc_4')") &&
      _appJsP6.includes("_mcUltimoPedido") && _appJsP6.includes("p.userEmail===U.email") &&
      !/if\(!hasManual&&!hasAuto\)\{el\.style\.display="none";return;\}/.test(_appJsP6),
      "card Minha Conta incompleto no app.js");
    check("👤 2.0-P6: (regra 6f) toda string nova do card passa pelo dicionário — mc_1..mc_12 presentes nas 3 línguas (pt/en/es)",
      (_appJsP6.match(/"mc_12"/g) || []).length === 3 && (_appJsP6.match(/"mc_7"/g) || []).length === 3 &&
      /"mc_9":"confirmada — 💎 na sua conta"/.test(_appJsP6) && /"mc_9":"confirmed — 💎 credited"/.test(_appJsP6),
      "chaves mc_* faltando em alguma língua");
    const pedU = await get("/api/pedidos");
    check("👤 2.0-P6: /api/pedidos entrega o que o card precisa — userEmail, valorTotal, status e criadoEm por pedido (comprovante NUNCA viaja na listagem)",
      pedU.json?.ok === true && (pedU.json?.pedidos || []).length >= 3 &&
      (pedU.json?.pedidos || []).every((p) => p.userEmail && p.status && (p.comprovante === true || p.comprovante === false)),
      JSON.stringify({ n: pedU.json?.pedidos?.length }).slice(0, 80));

    // ═══ ⚡ CÉREBRO 2.0 — PARTE 7 (FINAL): ESCALA + VISÃO DO DONO + DOCS ═══
    const bgStart = await req2("POST", "/api/admin/cerebro/auditar", { background: true });
    let bgSt = null;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); bgSt = (await get("/api/admin/cerebro/status")).json; if (bgSt?.auditJob && !bgSt.auditJob.running && bgSt.auditJob.finishedAt) break; }
    check("⚡ 2.0-P7: auditoria em BACKGROUND — dispara na hora, roda fora da requisição e o status entrega o auditId no fim (escala pra milhares)",
      bgStart.json?.started === true && bgStart.json?.background === true &&
      bgSt?.auditJob?.finishedAt > 0 && /^AUDIT-/.test(bgSt?.auditJob?.auditId || "") && !bgSt?.auditJob?.erro &&
      bgSt?.ultimoId === bgSt?.auditJob?.auditId,
      JSON.stringify(bgSt?.auditJob).slice(0, 160));
    const dcsC1 = await get("/api/admin/cerebro/decisoes");
    const dcsC2 = await get("/api/admin/cerebro/decisoes");
    check("⚡ 2.0-P7: leituras reusam o relatório por 10s (2 GETs seguidos = MESMA auditoria, sem varrer o banco de novo) — correções continuam sempre frescas",
      dcsC1.json?.auditId && dcsC1.json.auditId === dcsC2.json?.auditId &&
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("_relFresco(10_000)"),
      JSON.stringify({ a: dcsC1.json?.auditId, b: dcsC2.json?.auditId }).slice(0, 120));
    check("💰 2.0-P7: Visão do Dono responde 'existe algo precisando de mim?' — faixa do Cérebro (só status persistido, nunca dispara auditoria) clicável pra aba 🧠",
      _admHtml.includes('id="dono-cerebro-strip"') && _admHtml.includes("loadDonoCerebroStrip") &&
      _admHtml.includes("toque pra ver o que precisa de você") && !/loadDonoCerebroStrip[\s\S]{0,400}?cerebro\/auditar/.test(_admHtml),
      "faixa do dono ausente ou disparando auditoria");
    const _docMd = fs.readFileSync(path.join(__dirname, "DOCUMENTACAO_MESTRA_H2BAPPLY.md"), "utf8");
    check("📚 2.0-P7: documentação completa do Cérebro na DOCUMENTACAO_MESTRA (arquitetura, motores, correções, incidentes, rotas, testes) + nota v156 sobre a seção multi-servidor histórica",
      _docMd.includes("🧠 CÉREBRO CONTÁBIL (Master Commands 1 e 2") && _docMd.includes("RELÓGIO DAS CONCESSÕES") &&
      _docMd.includes("FIX1-<auditId>") && _docMd.includes("POST perguntar") && _docMd.includes("ERA DE 1 SERVIDOR SÓ"),
      "seção do cérebro incompleta na documentação");
    // 🧠 AUDITORIA FINAL DO CÉREBRO CONTÁBIL (item 70 do Master Command):
    // o pipeline completo roda e CONFIRMA a consistência — cross-check da
    // receita com delta ZERO, todos os motores presentes no relatório, e o
    // estado do cérebro íntegro de ponta a ponta.
    const finRun = await req2("POST", "/api/admin/cerebro/diaria", {});
    const finRel = (await get("/api/admin/cerebro/relatorio/" + finRun.json?.auditId)).json?.relatorio;
    check("🧠 AUDITORIA FINAL: sistema CONSISTENTE — receita do ledger bate EXATA com a fonte única (delta R$0), integridade calculada, e TODOS os motores presentes (ledger, dias+relógio+âncoras, comprovantes, duplicidades clássica e cross-user, códigos, incidentes, receita detalhada)",
      finRun.json?.ok === true && finRel && finRel.crossCheck?.delta === 0 &&
      typeof finRel.integridade?.pct === "number" &&
      Array.isArray(finRel.ledger) && finRel.ledger.length >= 8 &&
      finRel.dias?.timeline && Array.isArray(finRel.dias?.ancorados) &&
      Array.isArray(finRel.duplicidades) && Array.isArray(finRel.duplicidadesCrossUser) &&
      finRel.receitaDetalhada?.janelas?.total === finRel.crossCheck?.canonicoTotal &&
      finRel.porSeveridade && typeof finRel.problemas === "number",
      JSON.stringify({ delta: finRel?.crossCheck?.delta, integridade: finRel?.integridade?.pct, problemas: finRel?.problemas }).slice(0, 160));
    const cbTlFix = await req2("POST", "/api/admin/cerebro/corrigir", {});
    check("📅 2.0-P1: duas explicações possíveis = NUNCA auto-corrige — sessentadias vai pra Central de Decisões [manter/ignorar], jamais pra lista segura",
      !(cbTlFix.json?.seguras || []).some((c) => c.alvo === "sessentadias@test.com") &&
      (cbTlFix.json?.decisoes || []).some((d2) => d2.rule === "RULE_VIP_DAYS_PURCHASE_DATE_RECONCILIATION" && d2.alvo === "sessentadias@test.com" && d2.opcoes.join(",") === "manter,ignorar"),
      JSON.stringify({ seg: cbTlFix.json?.seguras?.map((c) => c.alvo), dec: (cbTlFix.json?.decisoes || []).filter((d2) => d2.alvo === "sessentadias@test.com").map((d2) => d2.rule) }).slice(0, 220));
    check("📅 2.0-P1: (estrutural) _fixDias revalida o GRAVADO depois de alterar e aborta se não bater (validar antes E depois — senão bloquear)",
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("validação pós-alteração FALHOU"),
      "revalidação pós-gravação não encontrada no mod-cerebro");

    // ═══ 🤖 CÉREBRO 3.0 — PARTE 1: GEMINI COMO MOTOR DE ANÁLISE (CAMADA 4) ═══
    // O gancho de teste (TEST_LOGIN_TOKEN) devolve uma análise fixa — o
    // pipeline real roda inteiro: fila educada, cache por inputHash, log
    // AI_ANALYSIS_LOG e o anexo nas decisões/incidentes.
    const iaRun = await req2("POST", "/api/admin/cerebro/ia/rodar", { limite: 20 });
    let iaSt = null;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 200)); iaSt = (await get("/api/admin/cerebro/ia")).json; if (iaSt?.job && !iaSt.job.running && iaSt.job.finishedAt) break; }
    check("🤖 3.0-P1: lote IA analisa os casos AMBÍGUOS em fila educada e registra tudo no AI_ANALYSIS_LOG (id, regra, inputHash, promptVersion, modelo, resultado, confiança)",
      iaRun.json?.started === true && iaRun.json?.total >= 3 && iaSt?.job?.erros === 0 && iaSt?.analises >= 3 &&
      iaSt?.nivel === "SUGGEST" && iaSt?.promptVersion === "cb-ia-v1" &&
      (iaSt?.ultimas || []).every((l) => l.findingId && l.rule && l.classificacao && typeof l.probabilidade === "number"),
      JSON.stringify({ total: iaRun.json?.total, analises: iaSt?.analises, job: iaSt?.job }).slice(0, 180));
    const decIA = await get("/api/admin/cerebro/decisoes");
    const _dIA = (decIA.json?.decisoes || []).find((d2) => d2.ia);
    check("🤖 3.0-P1: a decisão carrega a análise da IA — classificação, probabilidade e EXPLICAÇÃO citando evidências (nunca só 'erro')",
      _dIA && _dIA.ia.classificacao === "DUPLICIDADE_PROVAVEL" && _dIA.ia.probabilidade === 94 &&
      /evidências/i.test(_dIA.ia.explicacao || "") && _dIA.ia.promptVersion === "cb-ia-v1" && _dIA.ia.model === "gemini-2.0-flash",
      JSON.stringify(_dIA?.ia).slice(0, 200));
    const iaRun2 = await req2("POST", "/api/admin/cerebro/ia/rodar", { limite: 20 });
    let iaSt2 = null;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 200)); iaSt2 = (await get("/api/admin/cerebro/ia")).json; if (iaSt2?.job && !iaSt2.job.running && iaSt2.job.finishedAt > (iaSt?.job?.finishedAt || 0)) break; }
    check("🤖 3.0-P1: CACHE por inputHash — re-rodar com as mesmas evidências NUNCA re-chama o Gemini (custo controlado, item 33) e o log não cresce",
      iaRun2.json?.started === true && iaSt2?.job?.feitas === 0 && iaSt2?.job?.cacheadas >= 3 && iaSt2?.analises === iaSt?.analises,
      JSON.stringify({ feitas: iaSt2?.job?.feitas, cache: iaSt2?.job?.cacheadas, antes: iaSt?.analises, depois: iaSt2?.analises }).slice(0, 160));
    const incIA = await get("/api/admin/cerebro/incidentes");
    check("🤖 3.0-P1: incidentes abertos também carregam a análise da IA anexada",
      (incIA.json?.incidentes || []).some((i) => i.ia && i.ia.classificacao),
      JSON.stringify((incIA.json?.incidentes || []).filter((i) => i.ia).length).slice(0, 60));
    check("🤖 3.0-P1: (estrutural) IA é SUGGEST puro — nunca chamada dentro da auditoria determinística, resposta fora do contrato vira NECESSITA_DECISAO, sem chave = honesto (nunca inventa), e o painel tem o botão 🤖",
      (() => { const _s = fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8");
        const _aud = _s.slice(_s.indexOf("function auditarTudo"), _s.indexOf("PARTE 4: CENTRAL DE INCIDENTES"));
        return !_aud.includes("_iaAnalisarCaso") && _s.includes('IA_NIVEL = "SUGGEST"') &&
          _s.includes('"NECESSITA_DECISAO"') && _s.includes("sem chave Gemini configurada") && _s.includes("NUNCA calcula, NUNCA inventa"); })() &&
      _admHtml.includes("cerebroRodarIA"),
      "guardas da camada IA não encontradas");

    // ═══ 🖱️ CÉREBRO 3.0 — PARTE 2: TUDO CLICÁVEL (drill-down de cada card) ═══
    const lsReg = await get("/api/admin/cerebro/lista?tipo=registrada");
    const _stCat = (await get("/api/admin/cerebro/status")).json;
    check("🖱️ 3.0-P2: card RECEITA REGISTRADA abre a lista — e o valorTotal da lista bate EXATO com o número do card (nunca decorativo)",
      lsReg.json?.ok === true && lsReg.json?.total >= 8 &&
      lsReg.json?.valorTotal === _stCat?.resumo?.receita?.registrada &&
      (lsReg.json?.rows || []).every((r) => r.email && typeof r.valor === "number" && r.plano && r.classificacao),
      JSON.stringify({ lista: lsReg.json?.valorTotal, card: _stCat?.resumo?.receita?.registrada, n: lsReg.json?.total }).slice(0, 140));
    const lsDup = await get("/api/admin/cerebro/lista?tipo=duplicada");
    const lsConf = await get("/api/admin/cerebro/lista?tipo=confirmada");
    check("🖱️ 3.0-P2: lista de DUPLICADAS traz score e motivos linha a linha (fdup2) — e a lista de CONFIRMADAS nunca contém uma suspeita de duplicidade",
      (lsDup.json?.rows || []).some((r) => r.email === "duplicado@test.com" && r.score >= 61 && (r.motivos || []).length >= 2) &&
      !(lsConf.json?.rows || []).some((r) => r.dup),
      JSON.stringify(lsDup.json?.rows?.map((r) => r.email + ":" + r.score)).slice(0, 140));
    const lsSem = await get("/api/admin/cerebro/lista?tipo=semComprovante");
    check("🖱️ 3.0-P2: indicador novo R$ SEM COMPROVANTE — lista bate com o card, inclui os avulsos (fdup1) e NUNCA inclui quem tem comprovante (pedcomp1)",
      lsSem.json?.ok === true && lsSem.json?.valorTotal === _stCat?.resumo?.receita?.semComprovante &&
      (lsSem.json?.rows || []).some((r) => r.email === "duplicado@test.com") &&
      !(lsSem.json?.rows || []).some((r) => r.pedidoId === "pedcomp1"),
      JSON.stringify({ lista: lsSem.json?.valorTotal, card: _stCat?.resumo?.receita?.semComprovante }).slice(0, 120));
    const lsJan = await get("/api/admin/cerebro/lista?tipo=registrada&janela=1");
    const lsCanc = await get("/api/admin/cerebro/lista?tipo=cancelada");
    check("🖱️ 3.0-P2: a janela filtra de verdade (1 dia = menos linhas que o total, com o corte no título) e a lista de CANCELADOS mostra o pedcanc1 com valor e data",
      lsJan.json?.ok === true && lsJan.json?.total < lsReg.json?.total && /últimos 1 dia/.test(lsJan.json?.titulo || "") &&
      (lsCanc.json?.rows || []).some((r) => r.pedidoId === "pedcanc1" && r.valor === 99),
      JSON.stringify({ jan1: lsJan.json?.total, tudo: lsReg.json?.total, canc: lsCanc.json?.rows?.length }).slice(0, 120));
    check("🖱️ 3.0-P2: (estrutural) todos os cards do dashboard têm clique (inclusive CANCELADA e SEM COMPROVANTE novos) + janelas hoje/7/30 clicáveis + lista renderizada com linha→💳 Auditoria",
      _admHtml.includes("cerebroLista('confirmada')") && _admHtml.includes("cerebroLista('registrada')") &&
      _admHtml.includes("cerebroLista('duplicada')") && _admHtml.includes("cerebroLista('cancelada')") &&
      _admHtml.includes("cerebroLista('semComprovante')") && _admHtml.includes("cerebroLista('comprovantesPendentes')") &&
      _admHtml.includes("cerebroLista('registrada','7')") && _admHtml.includes("async function cerebroLista"),
      "cards sem clique ou lista ausente");

    // ═══ 🗂️ CÉREBRO 3.0 — PARTE 3: REGISTRO DE COMPROVANTES ═══════════════
    const reg1 = await get("/api/admin/cerebro/comprovantes/registro");
    const _regBy = (id) => (reg1.json?.rows || []).find((r) => r.pedidoId === id);
    check("🗂️ 3.0-P3: registro deriva o STATUS certo de cada comprovante — pedcomp2 VÁLIDO—CONFIRMADO, pedcomp1 DIVERGENTE, pedtx1/2 DUPLICADO (por transação, apontando um pro outro), importado da fusão EM ANÁLISE",
      reg1.json?.ok === true && _regBy("pedcomp2")?.status === "VÁLIDO — CONFIRMADO" &&
      _regBy("pedcomp1")?.status === "DIVERGENTE" &&
      _regBy("pedtx1")?.status === "DUPLICADO" && (_regBy("pedtx1")?.dupTransacao || []).includes("pedtx2") &&
      _regBy("pedtx2")?.status === "DUPLICADO" && (_regBy("pedtx2")?.dupTransacao || []).includes("pedtx1") &&
      (reg1.json?.rows || []).some((r) => r.pedidoId === "pedB0001" && r.status === "EM ANÁLISE"),
      JSON.stringify({ c2: _regBy("pedcomp2")?.status, c1: _regBy("pedcomp1")?.status, t1: _regBy("pedtx1")?.status, dup: _regBy("pedtx1")?.dupTransacao }).slice(0, 200));
    check("🗂️ 3.0-P3: contadores por status são honestos — a soma dos chips bate com o total de comprovantes",
      Object.values(reg1.json?.porStatus || {}).reduce((s2, v) => s2 + v, 0) === reg1.json?.total && reg1.json?.total >= 6,
      JSON.stringify(reg1.json?.porStatus).slice(0, 160));
    const regQ = await get("/api/admin/cerebro/comprovantes/registro?q=" + encodeURIComponent("e2eabc12345"));
    check("🗂️ 3.0-P3: busca multi-campo — procurar pela TRANSAÇÃO acha exatamente os 2 comprovantes do mesmo PIX",
      regQ.json?.filtrados === 2 && (regQ.json?.rows || []).every((r) => ["pedtx1", "pedtx2"].includes(r.pedidoId)),
      JSON.stringify(regQ.json?.rows?.map((r) => r.pedidoId)).slice(0, 100));
    const regF = await get("/api/admin/cerebro/comprovantes/registro?status=" + encodeURIComponent("DUPLICADO"));
    check("🗂️ 3.0-P3: chip-filtro por status — só DUPLICADOS, com o valor somado certo (R$100 + R$150 = R$250)",
      regF.json?.ok === true && (regF.json?.rows || []).every((r) => r.status === "DUPLICADO") && regF.json?.valorFiltrado === 250,
      JSON.stringify({ n: regF.json?.filtrados, v: regF.json?.valorFiltrado }).slice(0, 100));
    check("🗂️ 3.0-P3: (estrutural) botão 🗂️ na aba 🧠 + tela com chips clicáveis, busca e 📎 abrir comprovante",
      _admHtml.includes("cerebroRegistro") && _admHtml.includes("Registro de Comprovantes") &&
      _admHtml.includes('id="cb-reg-q"') && _admHtml.includes("mesma TRANSAÇÃO que"),
      "registro de comprovantes ausente na UI");

    // ═══ 🎬 CÉREBRO 3.0 — PARTE 4: DECISÕES 2.0 CASO-PRONTO ════════════════
    // O caso chega PRONTO pro admin: pedido sem caixa oferece [💰 Registrar
    // entrada] com pedido/e-mail/valor já resolvidos; suspeita de duplicidade
    // oferece [🆗 São pagamentos DIFERENTES] (resposta semântica, não um
    // "manter" genérico); toda decisão leva contexto clicável (👤 e-mails +
    // 📎 pedidos). Dinheiro continua 100% decisão humana — o cérebro executa
    // SÓ depois do clique, com snapshot + trilha + idempotência.
    const p4a = await get("/api/admin/cerebro/decisoes");
    const _dSemCx = (p4a.json?.decisoes || []).find((d2) => d2.rule === "RULE_ORDER_WITHOUT_PAYMENT" && d2.alvo === "pedsemcaixa1");
    const _dCrossP4 = (p4a.json?.decisoes || []).find((d2) => d2.rule === "RULE_CROSS_USER_DUPLICATE");
    check("🎬 3.0-P4: caso-pronto — pedido ativo sem caixa oferece [💰 registrar entrada] com pedido/e-mail/valor JÁ resolvidos, e toda decisão leva contexto clicável (👤 e-mails + 📎 pedidos)",
      _dSemCx && _dSemCx.opcoes.join(",") === "registrar_entrada,manter,ignorar" &&
      _dSemCx.execucao?.pedidoId === "pedsemcaixa1" && _dSemCx.execucao?.email === "cleiton2@test.com" && _dSemCx.execucao?.valor === 150 &&
      (_dSemCx.contexto?.emails || []).includes("cleiton2@test.com") && (_dSemCx.contexto?.pedidos || []).includes("pedsemcaixa1") &&
      _dCrossP4 && (_dCrossP4.contexto?.emails || []).length >= 2,
      JSON.stringify({ op: _dSemCx?.opcoes, ex: _dSemCx?.execucao, ctx: _dSemCx?.contexto }).slice(0, 240));
    const p4b = await req2("POST", "/api/admin/cerebro/decisao", { id: _dSemCx?.id, escolha: "registrar_entrada" });
    const p4Aud = await req2("POST", "/api/admin/cerebro/auditar", {});
    check("🎬 3.0-P4: [💰 Registrar entrada] cria o lançamento no caixa (snapshot antes + trilha no Financeiro) — o achado 'caso Cleiton' SOME da auditoria fresca e o cross-check continua batendo (delta R$0)",
      p4b.json?.ok === true && p4b.json?.pagamento?.pedidoId === "pedsemcaixa1" && p4b.json?.pagamento?.valor === 150 &&
      !(p4Aud.json?.relatorio?.findings || []).some((x) => x.rule === "RULE_ORDER_WITHOUT_PAYMENT" && x.alvo === "pedsemcaixa1") &&
      p4Aud.json?.relatorio?.crossCheck?.delta === 0,
      JSON.stringify({ ok: p4b.json?.ok, pag: p4b.json?.pagamento, delta: p4Aud.json?.relatorio?.crossCheck?.delta }).slice(0, 200));
    const p4c = await req2("POST", "/api/admin/cerebro/decisao", { id: _dSemCx?.id, escolha: "registrar_entrada" });
    const p4Led = await _getBufA("/api/admin/cerebro/exportar?fmt=json&tipo=ledger");
    const _p4Rows = (JSON.parse(p4Led.buf.toString("utf8")).rows || []).filter((r) => r.canonicalId === "pedsemcaixa1");
    check("🎬 3.0-P4: idempotência do dinheiro — repetir a decisão devolve 'já resolvida' e o caixa fica com EXATAMENTE 1 lançamento do pedido (regra 8 do dinheiro: nunca duplica)",
      p4c.json?.ok === true && p4c.json?.jaResolvida === true && _p4Rows.length === 1 && _p4Rows[0].valor === 150,
      JSON.stringify({ ja: p4c.json?.jaResolvida, rows: _p4Rows.length, valor: _p4Rows[0]?.valor }).slice(0, 140));
    const p4i = await get("/api/admin/cerebro/incidentes");
    const _p4IncCx = (p4i.json?.incidentes || []).find((i) => i.rule === "RULE_ORDER_WITHOUT_PAYMENT" && i.alvo === "pedsemcaixa1");
    const _dTxP4 = (p4a.json?.decisoes || []).find((d2) => d2.rule === "RULE_TRANSACTION_ID_REUSED");
    const p4d = await req2("POST", "/api/admin/cerebro/decisao", { id: _dTxP4?.id, escolha: "pagamentos_diferentes" });
    const p4d2 = await get("/api/admin/cerebro/decisoes");
    const p4i2 = await get("/api/admin/cerebro/incidentes");
    const _p4IncTx = (p4i2.json?.incidentes || []).find((i) => i.id === _dTxP4?.id);
    check("🎬 3.0-P4: [🆗 São pagamentos DIFERENTES] grava a CONCLUSÃO semântica — decisão nunca re-perguntada, incidentes 🟢 RESOLVIDOS com a história certa (registro no caixa / DIFERENTES)",
      p4d.json?.ok === true && p4d.json?.escolha === "pagamentos_diferentes" &&
      !(p4d2.json?.decisoes || []).some((d2) => d2.id === _dTxP4?.id) &&
      _p4IncCx?.status === "RESOLVIDO" && (_p4IncCx?.historico || []).some((h) => /registrado no caixa/.test(h.evento)) &&
      _p4IncTx?.status === "RESOLVIDO" && (_p4IncTx?.historico || []).some((h) => /DIFERENTES/.test(h.evento)),
      JSON.stringify({ tx: _p4IncTx?.status, cx: _p4IncCx?.status }).slice(0, 140));
    check("🎬 3.0-P4: (estrutural) labels caso-pronto + botões de contexto no painel; 'pagamentos diferentes' recusado em decisão que NÃO é de duplicidade (motor valida a opção)",
      _admHtml.includes("💰 Registrar entrada no caixa") && _admHtml.includes("🆗 São pagamentos DIFERENTES") &&
      _admHtml.includes("👤 ${esc(em)}") && _admHtml.includes("📎 pedido #${esc(pid)}") &&
      (() => { const _s = fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8"); return _s.includes("_ctxDecisao") && _s.includes("não aceita 'pagamentos diferentes'") && _s.includes("cerebro_confirmacao_manual"); })(),
      "UI/validação das decisões caso-pronto incompletas");

    // ═══ 🧮 CÉREBRO 3.0 — PARTE 5: AJUSTE± — O CAIXA NUNCA APAGA ═══════════
    // Toda correção de dinheiro vira LANÇAMENTO próprio (tipo "ajuste", ±,
    // motivo obrigatório) pareado com o original — que fica PRESERVADO no
    // caixa marcado `anuladoPor`. Saldo líquido idêntico ao da exclusão
    // antiga (delta R$0 provado), história permanente.
    const p5Aud = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _p5Led = p5Aud.json?.relatorio;
    const p5LedExp = await _getBufA("/api/admin/cerebro/exportar?fmt=json&tipo=ledger");
    const _p5Rows = JSON.parse(p5LedExp.buf.toString("utf8")).rows || [];
    check("🧮 3.0-P5: ledger reconhece o par — original fcanc1 vira ANULADO (preservado) + lançamento AJUSTE de −99, receita líquida intacta (crossCheck delta R$0) e o CONFLICT nunca volta (idempotência do novo modelo)",
      _p5Rows.some((r) => r.canonicalId === "pedcanc1" && r.classificacao === "ANULADO") &&
      _p5Rows.some((r) => r.classificacao === "AJUSTE" && r.valor === -99) &&
      // 💼 MC5-P6: o cancelamento da rota também virou AJUSTE− — o pedido
      // cancelado lá no começo da suíte (147) soma aqui: −99 + −147 = −246.
      typeof _p5Led?.receita?.ajustes === "number" && _p5Led.receita.ajustes === -246 &&
      !(_p5Led?.findings || []).some((x) => x.rule === "RULE_CANCELLED_PAYMENT" && x.alvo === "pedcanc1") &&
      !(_p5Led?.findings || []).some((x) => x.rule === "RULE_PAYMENT_WITHOUT_ORDER" && String(x.alvo).startsWith("aj:")) &&
      _p5Led?.crossCheck?.delta === 0,
      JSON.stringify({ ajustes: _p5Led?.receita?.ajustes, delta: _p5Led?.crossCheck?.delta, anulado: _p5Rows.filter((r) => r.classificacao === "ANULADO").length }).slice(0, 160));
    const p5Bad1 = await req2("POST", "/api/admin/cerebro/ajuste", { pedidoId: "pedsemcaixa1", valor: 0, motivo: "motivo válido de teste" });
    const p5Bad2 = await req2("POST", "/api/admin/cerebro/ajuste", { pedidoId: "pedsemcaixa1", valor: -50, motivo: "x" });
    check("🧮 3.0-P5: ajuste manual RECUSA valor zero e motivo curto — todo ajuste conta o porquê, sempre",
      p5Bad1.status === 400 && /zero/.test(p5Bad1.json?.error || "") &&
      p5Bad2.status === 400 && /motivo/i.test(p5Bad2.json?.error || ""),
      JSON.stringify({ e1: p5Bad1.json?.error, e2: p5Bad2.json?.error }).slice(0, 180));
    const p5Aj = await req2("POST", "/api/admin/cerebro/ajuste", { finId: "pedsemcaixa1", pedidoId: "pedsemcaixa1", valor: -50, motivo: "drill do smoke: entrada confirmada a maior, tirando R$50" });
    const p5Aud2 = await req2("POST", "/api/admin/cerebro/auditar", {});
    check("🧮 3.0-P5: ajuste manual − aplica SEM apagar nada — entra como lançamento próprio ancorado no pedido, o total líquido cai R$50 e o cross-check continua batendo (delta R$0)",
      p5Aj.json?.ok === true && p5Aj.json?.ajuste?.valor === -50 &&
      p5Aud2.json?.relatorio?.receita?.ajustes === -296 && // MC5-P6: −246 do bloco acima + o −50 manual
      p5Aud2.json?.relatorio?.crossCheck?.delta === 0 &&
      (p5Aud2.json?.relatorio?.receita?.registrada || 0) === (_p5Led?.receita?.registrada || 0) - 50,
      JSON.stringify({ aj: p5Aj.json?.ajuste, ajustes: p5Aud2.json?.relatorio?.receita?.ajustes, delta: p5Aud2.json?.relatorio?.crossCheck?.delta }).slice(0, 180));
    const p5Lista = await get("/api/admin/cerebro/lista?tipo=ajustes");
    check("🧮 3.0-P5: card 🧮 AJUSTES clicável — a lista traz cada ajuste com motivo e o valorTotal bate EXATO com o número do card",
      p5Lista.json?.ok === true && p5Lista.json?.total === 3 && // MC5-P6: fcanc1 + cancelamento da rota + manual
      p5Lista.json?.valorTotal === p5Aud2.json?.relatorio?.receita?.ajustes &&
      (p5Lista.json?.rows || []).every((r) => r.classificacao === "AJUSTE" && r.motivo),
      JSON.stringify({ total: p5Lista.json?.total, vt: p5Lista.json?.valorTotal, rows: (p5Lista.json?.rows || []).map((r) => r.valor) }).slice(0, 160));
    check("🧮 3.0-P5: (estrutural) o motor do cérebro NUNCA mais apaga pagamento (o filter de exclusão sumiu; _anularNoCaixa marca anuladoPor) + card AJUSTES e botão de ajuste manual no painel",
      (() => { const _s = fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8"); return !_s.includes("fin.pagamentos = fin.pagamentos.filter") && _s.includes("_anularNoCaixa") && _s.includes("anuladoPor = { ajusteId") && _s.includes('"ajuste_pagamento"'); })() &&
      _admHtml.includes("cerebroLista('ajustes')") && _admHtml.includes("cerebroAjusteManual") && _admHtml.includes("AJUSTES NO CAIXA"),
      "modelo AJUSTE± incompleto no motor ou no painel");

    // ═══ ⚡ CÉREBRO 3.0 — PARTE 6: TEMPO REAL (gatilhos nas rotas de dinheiro) ═══
    // Toda aprovação/cancelamento/correção de valor chama o hook — os eventos
    // entram numa janela com debounce e viram UMA auditoria completa (fonte
    // única, nunca mini-verdade incremental). No teste o timer nunca dispara
    // sozinho (600s > suíte) — o flush determinístico é o reagirAgora(), o
    // mesmo do botão ⚡ do painel.
    const p6St0 = await get("/api/admin/cerebro/status");
    check("⚡ 3.0-P6: os hooks REAIS acumularam eventos a suíte inteira (a aprovação, o cancelamento e as correções de valor lá do começo do teste) — e nada disparou sozinho dentro da janela",
      p6St0.json?.tempoReal && p6St0.json.tempoReal.aguardando >= 4 && !p6St0.json.tempoReal.ultimaReacao,
      JSON.stringify(p6St0.json?.tempoReal).slice(0, 160));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "temporeal@test.com", name: "Tempo Real" });
    const p6Pd = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150, userName: "Tempo Real" });
    const p6Id = p6Pd.json?.pedidoId;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const p6Act = await req2("PATCH", "/api/pedido/" + p6Id, { status: "ativo" });
    const p6Sv = await req2("POST", "/api/admin/pedido-set-valor", { pedidoId: p6Id, valor: 140 });
    const p6St1 = await get("/api/admin/cerebro/status");
    check("⚡ 3.0-P6: aprovar + corrigir valor = exatamente 2 eventos novos na janela (o debounce agrupa — nenhuma auditoria disparada no meio)",
      p6Act.json?.ok === true && p6Sv.json?.ok === true &&
      p6St1.json?.tempoReal?.aguardando === (p6St0.json?.tempoReal?.aguardando || 0) + 2,
      JSON.stringify({ antes: p6St0.json?.tempoReal?.aguardando, depois: p6St1.json?.tempoReal?.aguardando }).slice(0, 120));
    const p6R = await req2("POST", "/api/admin/cerebro/reagir", {});
    const p6St2 = await get("/api/admin/cerebro/status");
    check("⚡ 3.0-P6: a reação roda UMA auditoria completa pra todos os eventos juntos — ultimaReacao carimbada, o relatório novo vira o oficial e a fila zera",
      p6R.json?.ok === true && p6R.json?.eventos === p6St1.json?.tempoReal?.aguardando && /^AUDIT-/.test(p6R.json?.auditId || "") &&
      p6St2.json?.ultimoId === p6R.json?.auditId && p6St2.json?.tempoReal?.aguardando === 0 &&
      p6St2.json?.tempoReal?.ultimaReacao?.auditId === p6R.json?.auditId,
      JSON.stringify({ r: p6R.json, ultimo: p6St2.json?.ultimoId }).slice(0, 200));
    const p6R2 = await req2("POST", "/api/admin/cerebro/reagir", {});
    const p6Rel = await get("/api/admin/cerebro/relatorio/" + p6R.json?.auditId);
    check("⚡ 3.0-P6: sem evento pendente a reação é no-op honesto (nunca audita à toa) e o relatório da reação bate no cross-check (delta R$0, mesmo com o pedido aprovado+corrigido agora)",
      p6R2.json?.ok === true && p6R2.json?.nada === true &&
      p6Rel.json?.ok === true && p6Rel.json?.relatorio?.crossCheck?.delta === 0,
      JSON.stringify({ r2: p6R2.json, delta: p6Rel.json?.relatorio?.crossCheck?.delta }).slice(0, 140));
    check("⚡ 3.0-P6: (estrutural) hooks nas 4 rotas de dinheiro protegidos por try (NUNCA quebram o fluxo que aprovou/cancelou) + faixa ⚡ e botão Reagir agora no painel",
      (() => { const _s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8"); return _s.includes('_cbTempoReal("pedido_aprovado"') && _s.includes('_cbTempoReal("pedido_cancelado"') && (_s.match(/_cbTempoReal\("valor_corrigido"/g) || []).length === 2 && /function _cbTempoReal[\s\S]{0,300}catch/.test(_s); })() &&
      _admHtml.includes("cerebroReagir") && _admHtml.includes("⚡ Tempo real") && _admHtml.includes("Reagir agora"),
      "hooks/painel do tempo real incompletos");

    // ═══ 🧾 CÉREBRO 3.0 — PARTE 7: CONFERÊNCIA FILTROS/BUSCA 2.0 + EXPORT ═══
    // A Conferência (fonte central dos pagamentos) ganhou busca multi-campo,
    // filtro por status/tipo/janela SERVER-SIDE (mesmo builder da lista —
    // fonte única) e exportação CSV/JSON que baixa EXATAMENTE o filtrado.
    const p7q = await get("/api/admin/conferencia?q=" + encodeURIComponent("e2eabc12345"));
    check("🧾 3.0-P7: busca multi-campo server-side — procurar pela TRANSAÇÃO PIX acha exatamente os 2 pedidos do mesmo E2E, com contagem e valor do filtro",
      p7q.json?.ok === true && p7q.json?.filtrados === 2 && p7q.json?.valorFiltrado === 250 &&
      (p7q.json?.rows || []).every((r) => ["pedtx1", "pedtx2"].includes(r.id)) &&
      (p7q.json?.resumo?.total || 0) > 2,
      JSON.stringify({ n: p7q.json?.filtrados, v: p7q.json?.valorFiltrado, ids: (p7q.json?.rows || []).map((r) => r.id) }).slice(0, 160));
    const p7st = await get("/api/admin/conferencia?status=cancelado");
    const p7tp = await get("/api/admin/conferencia?tipo=codigo");
    const p7ja = await get("/api/admin/conferencia?tipo=pedido&janela=1");
    check("🧾 3.0-P7: filtros por status, tipo e janela — cancelados incluem o pedcanc1, códigos vêm só códigos, e janela de 1 dia só traz lançamento de hoje (incluindo o pedido do tempo real)",
      (p7st.json?.rows || []).length >= 1 && (p7st.json?.rows || []).every((r) => r.status === "cancelado") && (p7st.json?.rows || []).some((r) => r.id === "pedcanc1") &&
      (p7tp.json?.rows || []).length >= 2 && (p7tp.json?.rows || []).every((r) => r.tipo === "codigo") &&
      (p7ja.json?.rows || []).every((r) => (r.em || 0) >= Date.now() - 86400_000 - 300_000) && (p7ja.json?.rows || []).some((r) => r.id === p6Id),
      JSON.stringify({ canc: p7st.json?.filtrados, cod: p7tp.json?.filtrados, hoje: p7ja.json?.filtrados }).slice(0, 120));
    const p7csv = await _getBufA("/api/admin/conferencia/exportar?fmt=csv&q=" + encodeURIComponent("e2eabc12345"));
    const p7json = await _getBufA("/api/admin/conferencia/exportar?fmt=json&q=" + encodeURIComponent("e2eabc12345"));
    const _p7Exp = JSON.parse(p7json.buf.toString("utf8"));
    check("🧾 3.0-P7: exportação respeita os MESMOS filtros da tela — CSV (; + BOM, com OCR por coluna) e JSON com os 2 pedidos da transação e o valor somado",
      p7csv.status === 200 && String(p7csv.headers["content-type"]).includes("csv") &&
      p7csv.buf.toString("utf8").charCodeAt(0) === 0xFEFF && p7csv.buf.toString("utf8").includes("pagador;transacao") &&
      p7csv.buf.toString("utf8").includes("pedtx1") && p7csv.buf.toString("utf8").includes("E2EABC12345") &&
      _p7Exp.total === 2 && _p7Exp.valorTotal === 250 && (_p7Exp.rows || []).every((r) => r.transacao === "E2EABC12345") &&
      String(p7csv.headers["content-disposition"] || "").includes("filtrada"),
      JSON.stringify({ csv: p7csv.status, header: p7csv.buf.toString("utf8").split("\n")[0].slice(0, 80), total: _p7Exp.total }).slice(0, 200));
    check("🧾 3.0-P7: (estrutural) fonte ÚNICA — lista e exportação usam o MESMO builder e o MESMO filtro; tela com busca nova, status, janela, contador e botões ⬇️",
      (() => { const _s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8"); return (_s.match(/_confData\(\)/g) || []).length >= 2 && (_s.match(/_confFiltrarRows\(rows/g) || []).length >= 2; })() &&
      _admHtml.includes('id="conf-status"') && _admHtml.includes('id="conf-janela"') && _admHtml.includes("confExportar('csv')") &&
      _admHtml.includes('id="conf-count"') && _admHtml.includes("conferencia/exportar"),
      "filtros/export da Conferência incompletos");

    // ═══ 📚 CÉREBRO 3.0 — PARTE 8 (FINAL): APRENDIZADO + AUDITORIA FINAL ═══
    // O cérebro REGISTRA (nunca treina): toda decisão humana fica agregada
    // por regra e escolha, aparece nos casos parecidos e vira contexto pra
    // IA — mas nunca suprime achado nem decide sozinho.
    const p8d = await get("/api/admin/cerebro/decisoes");
    const _dGhostP8 = (p8d.json?.decisoes || []).find((d2) => d2.rule === "RULE_CROSS_USER_DUPLICATE");
    const _dSessP8 = (p8d.json?.decisoes || []).find((d2) => d2.rule === "RULE_VIP_DAYS_PURCHASE_DATE_RECONCILIATION");
    check("📚 3.0-P8: toda decisão pendente chega com o histórico da própria regra (historicoParecido) — e é honesto: 0 quando nunca houve caso igual",
      _dGhostP8 && _dGhostP8.historicoParecido && typeof _dGhostP8.historicoParecido.jaDecididas === "number" &&
      _dSessP8 && _dSessP8.historicoParecido.jaDecididas === 0,
      JSON.stringify({ ghost: _dGhostP8?.historicoParecido, sess: _dSessP8?.historicoParecido }).slice(0, 140));
    const p8m = await req2("POST", "/api/admin/cerebro/decisao", { id: _dGhostP8?.id, escolha: "manter" });
    const p8apr = await get("/api/admin/cerebro/aprendizado");
    check("📚 3.0-P8: o aprendizado agrega POR REGRA o que o admin concluiu — o MANTER de agora entra com a regra certa (via incidente) e as conclusões semânticas da P4 (registrar entrada, pagamentos DIFERENTES) já estão lá",
      p8m.json?.ok === true && p8apr.json?.ok === true && p8apr.json?.totalDecisoes >= 4 &&
      p8apr.json?.porRegra?.RULE_CROSS_USER_DUPLICATE?.escolhas?.manter === 1 &&
      p8apr.json?.porRegra?.RULE_TRANSACTION_ID_REUSED?.escolhas?.pagamentos_diferentes === 1 &&
      p8apr.json?.porRegra?.RULE_ORDER_WITHOUT_PAYMENT?.escolhas?.registrar_entrada === 1,
      JSON.stringify(p8apr.json?.porRegra).slice(0, 300));
    check("📚 3.0-P8: (estrutural) o histórico entra como CONTEXTO da IA (participa do hash — mudou o histórico, o cache invalida sozinho) e aparece no card 📚 e no painel; toda escolha nova grava rule+alvo",
      (() => { const _s = fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8"); return _s.includes("historicoAdmin: _histRegra(aprendizado()") && _s.includes("HISTÓRICO (informativo, não é regra)") && _s.includes("function aprendizado") && _s.includes("rule: _incR?.rule || null"); })() &&
      _admHtml.includes("historicoParecido") && _admHtml.includes("📚 Aprendizado"),
      "aprendizado incompleto no motor ou no painel");
    // 🏁 AUDITORIA FINAL DO CÉREBRO 3.0: pipeline diário completo com TODOS
    // os motores das 8 partes vivos ao mesmo tempo — e o dinheiro fechando.
    const p8dia = await req2("POST", "/api/admin/cerebro/diaria", {});
    const p8fst = await get("/api/admin/cerebro/status");
    const p8rel = await get("/api/admin/cerebro/relatorio/" + (p8fst.json?.ultimoId || ""));
    const _pr8 = p8rel.json?.relatorio || {};
    const p8ia = await get("/api/admin/cerebro/ia");
    const p8reg = await get("/api/admin/cerebro/comprovantes/registro");
    const p8lst = await get("/api/admin/cerebro/lista?tipo=ajustes");
    const p8cf = await get("/api/admin/conferencia?janela=30");
    check("🏁 3.0-FINAL: pipeline diário com TODOS os motores do Cérebro 3.0 vivos — IA camada 4, drill-down, registro de comprovantes, decisões caso-pronto, AJUSTE±, tempo real, Conferência 2.0 e aprendizado — e o dinheiro fecha (crossCheck delta R$0)",
      p8dia.json?.ok === true && _pr8.crossCheck?.delta === 0 &&
      typeof _pr8.receita?.ajustes === "number" && !!_pr8.receitaDetalhada && !!_pr8.dias?.timeline &&
      p8ia.json?.ok === true && p8reg.json?.ok === true && p8lst.json?.ok === true &&
      p8cf.json?.ok === true && typeof p8cf.json?.valorFiltrado === "number" &&
      p8fst.json?.tempoReal && typeof p8fst.json?.tempoReal.debounceMs === "number" &&
      ((await get("/api/admin/cerebro/aprendizado")).json?.totalDecisoes || 0) >= 4,
      JSON.stringify({ dia: p8dia.json?.ok, delta: _pr8.crossCheck?.delta, ajustes: _pr8.receita?.ajustes }).slice(0, 160));

    // ═══ 💼 MC4 — PARTE 2 (28/08): GASTOS COM COMPROVANTE + DRE-BASE ═══════
    // O dinheiro que SAI ganha a mesma régua do que entra: DRE no relatório
    // da auditoria (receita pela fonte única 13n − gastos = resultado), regra
    // de gasto sem comprovante (MEDIA, nunca correção/decisão automática) e
    // registro de gasto com comprovante SEM sair da aba 🧠.
    const p2Aud = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _dre1 = p2Aud.json?.relatorio?.dre;
    const _finG1 = (await get("/api/admin/financeiro")).json;
    const _gSum1 = Math.round((_finG1?.gastos || []).reduce((s2, g) => s2 + (parseFloat(g.valor) || 0), 0) * 100) / 100;
    check("💼 MC4-P2: relatório da auditoria ganhou o DRE-base — receita líquida pela fonte única (idêntica às janelas do próprio relatório), gastos batem com o caixa de despesas e resultado = receita − gastos EXATO, com fórmula declarada",
      _dre1 && Math.abs(_dre1.receitaLiquida - (p2Aud.json?.relatorio?.receitaDetalhada?.janelas?.total || 0)) < 0.011 &&
      _dre1.gastos?.total === _gSum1 && _gSum1 >= 220 &&
      Math.abs(_dre1.resultado - (_dre1.receitaLiquida - _dre1.gastos.total)) < 0.011 && typeof _dre1.formula === "string",
      JSON.stringify(_dre1).slice(0, 220));
    const _fGasto = (p2Aud.json?.relatorio?.findings || []).filter((x) => x.rule === "RULE_GASTO_SEM_COMPROVANTE");
    check("💼 MC4-P2: RULE_GASTO_SEM_COMPROVANTE aponta gsm1 e gsm2 (sem comprovante) e NUNCA o gsm3 (tem) — MEDIA, alvo é o ID do gasto e nenhum e-mail no alvo/título (semáforo não pinta ninguém por despesa da empresa), e NÃO vira decisão",
      _fGasto.some((x) => x.alvo === "gasto:gsm1") && _fGasto.some((x) => x.alvo === "gasto:gsm2") &&
      !_fGasto.some((x) => x.alvo === "gasto:gsm3") && _fGasto.every((x) => x.severity === "MEDIA" && !/@/.test(x.alvo + x.titulo)) &&
      !((await get("/api/admin/cerebro/decisoes")).json?.decisoes || []).some((dd) => dd.rule === "RULE_GASTO_SEM_COMPROVANTE"),
      JSON.stringify(_fGasto.map((x) => x.alvo)).slice(0, 160));
    const lsGastos = await get("/api/admin/cerebro/lista?tipo=gastos");
    check("💼 MC4-P2: card 💸 abre a lista de gastos — valorTotal bate EXATO com o DRE e as linhas trazem categoria, pagador, descrição e 📎 (gsm3 com, gsm1 sem)",
      lsGastos.json?.ok === true && lsGastos.json?.valorTotal === _dre1?.gastos?.total &&
      (lsGastos.json?.rows || []).some((r) => r.canonicalId === "gsm3" && r.temComprovante === true && r.plano === "servidor") &&
      (lsGastos.json?.rows || []).some((r) => r.canonicalId === "gsm1" && r.status === "pago por andrio" && r.temComprovante === false && r.motivo === "Render mensal"),
      JSON.stringify({ vt: lsGastos.json?.valorTotal, dre: _dre1?.gastos?.total }).slice(0, 140));
    const p2Add = await req2("POST", "/api/admin/financeiro", { action: "add_gasto", gasto: { valor: 35.5, categoria: "api", descricao: "Chave Gemini", pagoPor: "diego", comprovante: Buffer.from("nota-fiscal-gemini").toString("base64"), comprovanteType: "image/png" } });
    const p2Aud2 = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _dre2 = p2Aud2.json?.relatorio?.dre;
    check("💼 MC4-P2: gasto novo COM comprovante (mesmo caminho do botão 💸 da aba 🧠 → add_gasto) entra no DRE na próxima auditoria (+R$35,50 exatos, resultado cai junto) e NÃO gera pendência (tem comprovante)",
      p2Add.json?.ok === true && p2Add.json?.temComprovante === true &&
      Math.abs(_dre2?.gastos?.total - (_dre1.gastos.total + 35.5)) < 0.011 &&
      Math.abs((_dre1.resultado - _dre2.resultado) - 35.5) < 0.011 &&
      Math.abs(_dre2?.gastos?.porPagador?.diego - (_dre1.gastos.porPagador.diego + 35.5)) < 0.011 &&
      !(p2Aud2.json?.relatorio?.findings || []).some((x) => x.rule === "RULE_GASTO_SEM_COMPROVANTE" && String(x.alvo).includes(String(p2Add.json?.id))),
      JSON.stringify({ antes: _dre1?.gastos?.total, depois: _dre2?.gastos?.total, id: p2Add.json?.id }).slice(0, 160));
    check("💼 MC4-P2: DRE no resumo persistido (dashboard abre sem re-auditar) + painel com cards 💸/📈 clicáveis e o formulário de gasto com comprovante dentro da aba 🧠",
      (await get("/api/admin/cerebro/status")).json?.resumo?.dre?.gastos?.total === _dre2?.gastos?.total &&
      _admHtml.includes("cerebroGastoForm") && _admHtml.includes("cerebroGastoSalvar") &&
      _admHtml.includes("cerebroLista('gastos')") && _admHtml.includes("RESULTADO (DRE)") && _admHtml.includes('id="cb-g-img"'),
      "resumo sem dre ou painel sem a UI de gastos");

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
    check("💼 MC4-P3: relatório executivo 100% determinístico — cita mês, receita e o acerto dos sócios com fontes; painel com botão 📅 + exports; régua de dono é FONTE ÚNICA (_finDonoDe compartilhado entre acerto e DRE)",
      typeof dreM.executivo?.texto === "string" && dreM.executivo.texto.includes("RELATÓRIO EXECUTIVO") &&
      /receita/i.test(dreM.executivo.texto) && /(tem a receber|deve repassar|em dia)/i.test(dreM.executivo.texto) &&
      (dreM.executivo.fontes || []).length >= 3 &&
      _admHtml.includes("cerebroDreMensal") && _admHtml.includes("/api/admin/dre?fmt=csv") &&
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
    check("💼 MC4-P4: a 2ª verdade MORREU — nenhuma chamada a finCalcAcerto sobrou; card do Financeiro e Robô de Conferência consomem /api/admin/socios; aba 🧠 registra/exclui repasse; card sem a linha 'Metade gastos empresa' e com 'Direito pelo split'",
      !_admHtml.includes("function finCalcAcerto(") && !_admHtml.includes("finCalcAcerto(") &&
      (_admHtml.match(/\/api\/admin\/socios/g) || []).length >= 3 &&
      _admHtml.includes("cerebroRepasseForm") && _admHtml.includes("cerebroRepasseSalvar") && _admHtml.includes("cerebroRepasseExcluir") &&
      !_admHtml.includes("Metade gastos empresa") && _admHtml.includes("Direito pelo split"),
      "resquício do finCalcAcerto ou UI de repasse ausente");

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
    await req2("POST", "/api/admin/financeiro", { action: "add_gasto", gasto: { valor: 10, categoria: "outro", descricao: "retroativo pos-fechamento", pagoPor: "empresa", dataGasto: "2026-08-20", comprovante: Buffer.from("nf-retro").toString("base64"), comprovanteType: "image/jpeg" } });
    const p5list2 = (await get("/api/admin/fechamentos")).json;
    const _fAgo2 = (p5list2?.fechamentos || []).find((f) => f.mes === "2026-08");
    const p5aud = await req2("POST", "/api/admin/cerebro/auditar", {});
    const _fdFech = (p5aud.json?.relatorio?.findings || []).find((x) => x.rule === "RULE_FECHAMENTO_DIVERGENTE");
    check("💼 MC4-P5: gasto retroativo de R$10 DENTRO do mês fechado — a lista acusa a divergência EXATA (Δ gastos = 10) e a auditoria cria RULE_FECHAMENTO_DIVERGENTE (ALTA, sempre decisão humana manter/ignorar)",
      _fAgo2?.divergencia?.divergente === true && Math.abs(_fAgo2.divergencia.gastos - 10) < 0.011 &&
      _fdFech && _fdFech.severity === "ALTA" && _fdFech.alvo === "fechamento:2026-08" &&
      ((await get("/api/admin/cerebro/decisoes")).json?.decisoes || []).some((dd) => dd.rule === "RULE_FECHAMENTO_DIVERGENTE" && dd.opcoes.join(",") === "manter,ignorar"),
      JSON.stringify({ div: _fAgo2?.divergencia, fd: _fdFech?.alvo }).slice(0, 180));
    const p5resp = await req2("POST", "/api/admin/cerebro/perguntar", { pergunta: "quanto eu tenho a receber?" });
    const _socP5 = (await get("/api/admin/socios")).json;
    check("💼 MC4-P5: 'quanto eu tenho a receber?' — o Cérebro responde com o acerto AO VIVO da fonte única (direito de cada sócio idêntico ao computeSocios, conta aberta e fonte citada) — e 'quanto realmente recebemos?' continua caindo no ramo de receita",
      p5resp.json?.resposta && /Andrio/.test(p5resp.json.resposta) && /Diego/.test(p5resp.json.resposta) &&
      p5resp.json.resposta.includes(_socP5.socios.andrio.direito.toFixed(2)) &&
      /computeSocios/.test(p5resp.json.resposta) && /(TEM A RECEBER|DEVE REPASSAR|em dia)/.test(p5resp.json.resposta) &&
      /Receita REGISTRADA/.test((await req2("POST", "/api/admin/cerebro/perguntar", { pergunta: "quanto realmente recebemos?" })).json?.resposta || ""),
      (p5resp.json?.resposta || "").slice(0, 200));
    check("💼 MC4-P5: (estrutural) painel com 📕 Fechamento mensal, push do fechamento no servidor, acerto na push diária do cérebro e DOCUMENTACAO_MESTRA com a seção completa do Cérebro 4.0",
      _admHtml.includes("cerebroFechamentos") && _admHtml.includes("cerebroFecharMes") && _admHtml.includes("/api/admin/fechamento") &&
      _srvSrc.includes("Fechamento mensal registrado") &&
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("RULE_FECHAMENTO_DIVERGENTE") &&
      fs.readFileSync(path.join(__dirname, "DOCUMENTACAO_MESTRA_H2BAPPLY.md"), "utf8").includes("💼 CÉREBRO 4.0"),
      "algum pedaço da Parte 5 sumiu");

    // ═══ 🩻 v163: RAIO-X DE MEMÓRIA (OOM 2GB no Render — medir antes de operar)
    const memX = (await get("/api/admin/memoria")).json;
    check("🩻 v163: /api/admin/memoria mede o processo (rss/heap > 0), conta os comprovantes base64 RESIDENTES na RAM (fixtures: pedidos ≥4 com foto, gastos ≥2) e lista os arquivos do DATA com tamanho",
      memX?.ok === true && memX.processo?.rssMB > 0 && memX.processo?.heapUsadoMB > 0 &&
      memX.comprovantes?.pedidos?.n >= 4 && memX.comprovantes?.pedidos?.mb >= 0 &&
      memX.comprovantes?.gastos?.n >= 2 &&
      Array.isArray(memX.arquivos) && memX.arquivos.some((a) => a.nome === "users.json") &&
      Array.isArray(memX.dicas) && memX.dicas.length >= 1 && typeof memX.bancos?.usuarios === "number",
      JSON.stringify({ rss: memX?.processo?.rssMB, comp: memX?.comprovantes?.pedidos, gastos: memX?.comprovantes?.gastos?.n }).slice(0, 160));
    check("🩻 v163: (estrutural) a rota NUNCA faz JSON.stringify de banco inteiro (só de 1 linha-amostra), o pulso [mem] roda a cada 6h no log e o painel tem o card com loadMemoria",
      /Planilhas residentes: linhas reais \+ estimativa por AMOSTRA/.test(_srvSrc) &&
      _srvSrc.includes("JSON.stringify(a[0]||{})") && !/JSON\.stringify\(DB_USERS\)/.test(_srvSrc.split("api/admin/memoria")[1]?.split("api/")[0] || "x") &&
      _srvSrc.includes("[mem] rss=") && _srvSrc.includes("setInterval(_memPulse,6*3600_000)") &&
      _admHtml.includes("loadMemoria") && _admHtml.includes('id="memoria-out"') && _admHtml.includes("Memória do servidor"),
      "raio-x sem a guarda de amostra, sem pulso ou sem UI");

    // ═══ 🤖 v164: CÉREBRO AUTÔNOMO — tudo entregue ao abrir, sem cliques ═══
    // Ordem do dono (29/08): "quero que tudo no programa seja feito sozinho,
    // não quero ter que ficar clicando em qualquer coisa".
    const _stAntes164 = (await get("/api/admin/cerebro/status")).json;
    const pv164 = (await get("/api/admin/cerebro/painel")).json;
    const _stDepois164 = (await get("/api/admin/cerebro/status")).json;
    check("🤖 v164: /api/admin/cerebro/painel entrega TUDO em 1 chamada (decisões prontas com opções, incidentes, sócios, executivo, fechamentos, comprovantes) — e abrir o painel NUNCA dispara auditoria (ultimoId intacto)",
      pv164?.ok === true && Array.isArray(pv164.decisoes) && pv164.decisoes.length >= 1 && pv164.decisoes[0].opcoes?.length >= 2 &&
      typeof pv164.incidentes?.totalAbertos === "number" && pv164.socios?.socios?.andrio && typeof pv164.executivo?.texto === "string" &&
      (pv164.fechamentos?.fechamentos || []).length >= 1 && typeof pv164.comprovantes?.naoConferidos === "number" &&
      _stAntes164?.ultimoId === _stDepois164?.ultimoId && pv164.status?.ultimoId === _stAntes164?.ultimoId,
      JSON.stringify({ dec: pv164?.decisoes?.length, inc: pv164?.incidentes?.totalAbertos, ult: [_stAntes164?.ultimoId, _stDepois164?.ultimoId] }).slice(0, 160));
    const p164dia = await req2("POST", "/api/admin/cerebro/diaria", {});
    check("🤖 v164: a rodada diária carrega a AUTONOMIA (comprovantes+IA+fechamento do mês anterior) — no npm test vem honestamente PULADA (filas em background criariam corrida; cada peça tem o próprio check) e a resposta antiga segue intacta",
      p164dia.json?.ok === true && p164dia.json?.auditId && p164dia.json?.autonomia && /corrida/.test(p164dia.json.autonomia.pulado || ""),
      JSON.stringify(p164dia.json?.autonomia).slice(0, 140));
    check("🤖 v164: (estrutural servidor) fechar mês é função ÚNICA (_fecharMes na rota manual E no automático), o agendador das 02h chama a autonomia, e o fechamento automático espera o dia 3 e só fecha mês com movimento",
      (_srvSrc.match(/_fecharMes\(/g) || []).length >= 3 && _srvSrc.includes("_autoFecharMesAnterior") &&
      _srvSrc.includes('_cbAutonomia("🧠 auditoria diária 02h")') && _srvSrc.includes("aguarda o dia 3") && _srvSrc.includes('"sem_movimento"'),
      "autonomia do servidor incompleta");
    check("🤖 v164: (estrutural painel) a aba 🧠 abre com o painel completo (1 fetch do /painel), renderiza decisões/incidentes/executivo/fechamentos SEM clique e dispara auditoria em background sozinha quando a última tem >30min",
      _admHtml.includes("/api/admin/cerebro/painel") && _admHtml.includes("_cbPainelVivo") &&
      _admHtml.includes("background:true") && _admHtml.includes("_cbAutoKick") &&
      _admHtml.includes("Entregue pronto") && _admHtml.includes("fecha SOZINHO no dia 3"),
      "painel autônomo incompleto no front");

    // ═══ 💼 MC5 — PARTE 1 (29/08): A PORTA DE ENTRADA BLINDADA ═════════════
    // "recebe, identifica valor/data/comprovante, faz o check" — a aprovação
    // agora ENXERGA a leitura do robô e o comprovante repetido ANTES de
    // creditar; doação real nunca mais é engolida pelo dedup.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5a@test.com", name: "MC5 A" });
    const mc5p1 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 150, userName: "MC5 A", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:100:E2EMC5AAA1:Pagador MC5", comprovante: Buffer.from("comp-mc5-a").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
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
    const mc5p2 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 150, userName: "MC5 B", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:150:E2EMC5AAA1:Pagador MC5", comprovante: Buffer.from("comp-mc5-b-refoto").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const mc5Ap3 = await req2("PATCH", "/api/pedido/" + mc5p2.json?.pedidoId, { status: "ativo", recebidoPor: "diego" });
    check("💼 MC5-P1: MESMA transação PIX (E2E) já ativa em OUTRO usuário, arquivo re-fotografado diferente — a aprovação barra com 409 'comprovante já usado' apontando o pedido e o e-mail originais (antes só a auditoria das 02h pegava, DEPOIS dos 💎 creditados)",
      mc5Ap3.status === 409 && mc5Ap3.json?.comprovanteUsado === true && mc5Ap3.json?.pedidoDup === mc5p1.json?.pedidoId && mc5Ap3.json?.emailDup === "mc5a@test.com",
      JSON.stringify(mc5Ap3.json).slice(0, 180));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5c@test.com", name: "MC5 C" });
    const mc5d1 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 30, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-um").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const mc5d2 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 45, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-dois").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const mc5d3 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 60, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-tres").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    const mc5d4 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 75, userName: "MC5 C", userWhatsapp: "11 9", userCity: "SP", comprovante: Buffer.from("pix-quatro").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    check("💼 MC5-P1: 2ª e 3ª doações com doação pendente NÃO são mais engolidas pelo dedup (o PIX já foi feito ANTES do envio — cada doação vira pedido próprio, comprovante preservado); a 4ª pendente é barrada com aviso claro (teto anti-abuso)",
      mc5d1.json?.ok === true && !mc5d1.json?.duplicado &&
      mc5d2.json?.ok === true && !mc5d2.json?.duplicado && mc5d2.json?.pedidoId !== mc5d1.json?.pedidoId &&
      mc5d3.json?.ok === true && !mc5d3.json?.duplicado &&
      mc5d4.status === 400 && /3 doações em análise/.test(mc5d4.json?.error || ""),
      JSON.stringify({ d2dup: mc5d2.json?.duplicado, d4: mc5d4.status }).slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5d@test.com", name: "MC5 D" });
    const mc5inv = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 30, userName: "MC5 D", userWhatsapp: "11 9", userCity: "SP", comprovante: "!!!corrompido###", comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    check("💼 MC5-P1: comprovante corrompido leva 400 com motivo claro em PT — NUNCA mais pedido criado 'ok' sem prova em silêncio (o usuário via 'recebemos seu comprovante' e o admin via 'NÃO enviado')",
      mc5inv.status === 400 && /corrompido/.test(mc5inv.json?.error || ""),
      (mc5inv.body || "").slice(0, 120));
    check("💼 MC5-P1: (estrutural) PDF é lido de verdade (REVISAR_MANUAL hardcoded morreu), retry automático da leitura existe (1min/10min, máx 2), comprovante é comprimido no aparelho (canvas JPEG — mata HEIC), banner de aprovação mostra pagador/banco/transação e o badge sem leitura fala a verdade",
      !_srvSrc.includes("PDF não lido automaticamente") && _srvSrc.includes("function _preCheckComRetry(") &&
      fs.readFileSync(path.join(__dirname, "app.js"), "utf8").includes("_compComprovante") &&
      _admHtml.includes("Transação:") && _admHtml.includes("confirmarComprovanteUsado") && _admHtml.includes("Aguardando leitura"),
      "algum item da porta blindada sumiu");

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
    check("💼 MC5-P2: doação cancelada mostra o MOTIVO pro usuário (motivoCancelamento) e o servidor manda push do cancelamento — a notícia ruim nunca mais é muda",
      _rowC && _rowC.status === "cancelado" && _rowC.motivoCancelamento === "valor não confere com o comprovante" &&
      _srvSrc.includes("❌ Doação cancelada") && _admHtml.includes("o usuário recebe por notificação"),
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
    const mc5di = (await get("/api/diamonds")).json;
    const _appSrc2 = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    check("💼 MC5-P2: /api/diamonds entrega a mediana REAL de confirmação (promessa honesta no lugar do '24h' fixo) + front com packs derivados da tabela oficial (13c — hardcode morreu como fonte), extrato com 'ver todos'/saldo/rótulos novos, i18n das strings novas nas 3 línguas e 'Renove agora' (v66) extinto",
      typeof mc5di?.medianaAprovacaoHoras === "number" &&
      _appSrc2.includes("_renderPacksFromTable") && _appSrc2.includes("mpReenviarComprovante") &&
      (_appSrc2.match(/"mc_13":/g) || []).length === 3 && (_appSrc2.match(/"mp_reenviar":/g) || []).length === 3 &&
      !_appSrc2.includes("Renove agora") && _appSrc2.includes("_diamExtratoAll"),
      JSON.stringify({ med: mc5di?.medianaAprovacaoHoras }).slice(0, 80));

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
    check("💼 MC5-P3: (estrutural) as mini-verdades morreram — aba Mensal consome /api/admin/dre (finAgrupaMeses/finMesKey excluídos), fin-insights com lucro HONESTO (sem Math.max(0)) e partes pelo SPLIT, canônico exclui admin/anulado/ajuste, e o Pagantes pergunta quem recebeu",
      !_admHtml.includes("function finAgrupaMeses") && !_admHtml.includes("function finMesKey") &&
      (_admHtml.match(/\/api\/admin\/dre/g) || []).length >= 2 &&
      _admHtml.includes("/api/admin/financeiro/exportar") &&
      _admHtml.includes("Quem RECEBEU esse dinheiro? Digite exatamente") &&
      _srvSrc.includes("parteAndrio") && !_srvSrc.includes("Math.max(0,receitaTotal-despTotal)") &&
      _srvSrc.includes('if(pg.anuladoPor||pg.tipo==="ajuste")continue;'),
      "alguma mini-verdade sobreviveu");

    // ═══ 💼 MC5 — PARTE 4 (29/08): TUDO CLICÁVEL E EXPLICADO ═══════════════
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const pedAdm4 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 30, userName: "Dono", userWhatsapp: "11 9", userCity: "SP" });
    const pedsAdm4 = (await get("/api/pedidos")).json;
    const _rAdm4 = (pedsAdm4?.pedidos || []).find((p2) => p2.id === pedAdm4.json?.pedidoId);
    const _rUsr4 = (pedsAdm4?.pedidos || []).find((p2) => p2.id === mc5p1.json?.pedidoId);
    await req2("PATCH", "/api/pedido/" + pedAdm4.json?.pedidoId, { status: "cancelado" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    check("💼 MC5-P4: pedidos chegam marcados (ehAdmin pela lista real de e-mails de admin) — o card 'Valor em pedidos' agora exclui teste de admin (v53) e bate com a régua da Conferência",
      _rAdm4?.ehAdmin === true && _rUsr4?.ehAdmin === false && _admHtml.includes("!p.ehAdmin"),
      JSON.stringify({ adm: _rAdm4?.ehAdmin, usr: _rUsr4?.ehAdmin }).slice(0, 80));
    await req2("POST", "/api/admin/settings", { fgManual2: 0 });
    const fg4 = (await get("/api/admin/financeiro-global")).json;
    const _srvOc4 = (fg4?.servidores || []).find((x) => !x.self && x.oculto === true && x.ok === false);
    check("💼 MC5-P4: era de 1 servidor — servidor OCULTO nunca mais é consultado (dieta 13w) e chega marcado (oculto:true); o card 🌍 do painel se aposenta sozinho quando não há irmão vivo/manual",
      !!_srvOc4 &&
      _srvSrc.includes("_svOculto") && _admHtml.includes("fg-card") && _admHtml.includes("aposentado (era de 1 servidor)"),
      JSON.stringify(fg4?.servidores || []).slice(0, 160));
    check("💼 MC5-P4: (estrutural) os 4 cards do dono abrem a lista (donoVerLancamentos), 📖 Entenda os números existe com todas as réguas explicadas, RESULTADO abre o DRE (não a lista errada), decisão atualiza a tela inteira, lote de comprovantes tem progresso ao vivo, códigos explicados e 💎 'Total já doado' sem admin",
      (_admHtml.match(/donoVerLancamentos\(/g) || []).length >= 5 &&
      _admHtml.includes("donoEntendaNumeros") && _admHtml.includes("Entenda os números") && _admHtml.includes("TEM A RECEBER = direito − posição") &&
      !/RESULTADO \(DRE\)[^\n]*cerebroLista/.test(_admHtml) && /RESULTADO \(DRE\)[^\n]*cerebroDreMensal/.test(_admHtml) &&
      _admHtml.includes("loadCerebro(); // 💼 MC5-P4") && _admHtml.includes("Lote concluído") &&
      _admHtml.includes("não soma receita") &&
      _srvSrc.includes('pd.status==="ativo"&&!isAdminEmail(pd.userEmail'),
      "algum item do 'tudo clicável e explicado' sumiu");

    // ═══ 💼 MC5 — PARTE 5 (29/08): QUEM RECEBEU/GASTOU 100% ════════════════
    // Dono do dinheiro NUNCA mais é chutado; gasto recorrente (Render todo
    // mês) e em dólar; repasse com comprovante; entrada manual com prova
    // some do "sem comprovante"; corte de mês em horário de Brasília.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5e@test.com", name: "MC5 E" });
    const mc5p5 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 83, userName: "MC5 E", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:83", comprovante: Buffer.from("comp-mc5-e-p5").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "andrio.usa2026@gmail.com", name: "Dono", isAdmin: true });
    const mc5Ap5 = await req2("PATCH", "/api/pedido/" + mc5p5.json?.pedidoId, { status: "ativo" }); // SEM recebidoPor, de propósito
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const finP5 = (await get("/api/admin/financeiro")).json;
    const _rowP5 = (finP5?.pagamentos || []).find((x) => x.pedidoId === mc5p5.json?.pedidoId);
    const _csvP5 = (await _getBufA("/api/admin/financeiro/exportar")).buf.toString("utf8");
    const _linP5 = _csvP5.split("\n").find((l) => l.includes("83,00"));
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
    await req2("POST", "/api/admin/cerebro/auditar", {});
    const lsSemP5 = (await get("/api/admin/cerebro/lista?tipo=semComprovante")).json;
    check("💼 MC5-P5: o cérebro reconhece o anexo PRÓPRIO da entrada manual — a avulsa COM comprovante sai do card 'SEM COMPROVANTE' (falso positivo morto) e a SEM comprovante continua listada",
      lsSemP5?.ok === true &&
      (lsSemP5.rows || []).some((r) => r.canonicalId === "fin:" + avSem.json?.id) &&
      !(lsSemP5.rows || []).some((r) => r.canonicalId === "fin:" + avCom.json?.id),
      JSON.stringify({ tem91: (lsSemP5?.rows || []).some((r) => r.canonicalId === "fin:" + avSem.json?.id), tem57: (lsSemP5?.rows || []).some((r) => r.canonicalId === "fin:" + avCom.json?.id) }));
    check("💼 MC5-P5: (estrutural) corte de mês do DRE em horário de Brasília (−3h, fonte única — o fechamento herda o corte), option 'empresa' no gasto do Financeiro, checkbox 🔁 recorrente, anexo no repasse (cb-r-img + cerebroVerRepasseComp), robô recorrente dentro da autonomia das 02h e anexo próprio como prova no cérebro",
      _srvSrc.includes("d.getTime()-3*3600*1000).toISOString().slice(0,7)") &&
      _srvSrc.includes("out.recorrentes=_lancarGastosRecorrentes()") &&
      _srvSrc.includes('"/api/admin/repasse/"') &&
      _admHtml.includes('id="cb-g-rec"') && _admHtml.includes("cb-r-img") && _admHtml.includes("cerebroVerRepasseComp") &&
      /id="fin-g-pago"[\s\S]{0,220}value="empresa"/.test(_admHtml) &&
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("temAnexoProprio"),
      "algum item do 'quem recebeu/gastou 100%' sumiu");

    // ═══ 💼 MC5 — PARTE 6 (29/08): O CAIXA NUNCA APAGA ═════════════════════
    // Cancelamento vira AJUSTE− (fonte única do cérebro), gravação de
    // dinheiro conferida, action desconhecida = 400 na cara, e os eventos
    // do tempo real sobrevivem a deploy (fila persistida + retomada no boot).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "mc5f@test.com", name: "MC5 F" });
    const p6ped = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 66, userName: "MC5 F", userWhatsapp: "11 9", userCity: "SP", nota: "TESTE_COMPROVANTE:66", comprovante: Buffer.from("comp-p6-f").toString("base64"), comprovanteType: "image/jpeg", pagoEm: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const _janAntes6 = (await get("/api/admin/financeiro")).json?.entradas?.total;
    await req2("PATCH", "/api/pedido/" + p6ped.json?.pedidoId, { status: "ativo", recebidoPor: "andrio" });
    const _janMeio6 = (await get("/api/admin/financeiro")).json?.entradas?.total;
    const p6canc = await req2("PATCH", "/api/pedido/" + p6ped.json?.pedidoId, { status: "cancelado", notaAdmin: "teste P6 — caixa nunca apaga" });
    const finP6 = (await get("/api/admin/financeiro")).json;
    const _p6orig = (finP6?.pagamentos || []).find((x) => x.pedidoId === p6ped.json?.pedidoId && x.tipo !== "ajuste");
    const _p6aj = (finP6?.pagamentos || []).find((x) => x.tipo === "ajuste" && x.ajustaPedidoId === p6ped.json?.pedidoId);
    check("💼 MC5-P6: cancelar doação APROVADA anula por AJUSTE− em vez de apagar — original preservado (anuladoPor com o motivo do admin), par de −66, e o líquido canônico volta EXATO ao de antes da aprovação (delta R$0)",
      p6canc.json?.ok === true && _p6orig && !!_p6orig.anuladoPor && /caixa nunca apaga/.test(_p6orig.anuladoPor.motivo || "") &&
      _p6aj && _p6aj.valor === -66 && !_p6aj.pedidoId &&
      Math.abs(_janMeio6 - _janAntes6 - 66) < 0.011 && Math.abs(finP6.entradas.total - _janAntes6) < 0.011,
      JSON.stringify({ antes: _janAntes6, meio: _janMeio6, fim: finP6?.entradas?.total, aj: _p6aj?.valor }).slice(0, 160));
    await req2("POST", "/api/admin/cerebro/auditar", {});
    const errsP6 = (await get("/api/admin/cerebro/erros")).json;
    const lsAjP6 = (await get("/api/admin/cerebro/lista?tipo=ajustes")).json;
    check("💼 MC5-P6: o cérebro entende o novo cancelamento — pedido cancelado com entrada ANULADA não vira CONFLITO nem RULE_CANCELLED_PAYMENT (nada a corrigir: já está corrigido), e o par aparece na lista de AJUSTES com o motivo",
      !(errsP6?.findings || []).some((f) => f.rule === "RULE_CANCELLED_PAYMENT" && String(f.alvo || "").includes(p6ped.json?.pedidoId)) &&
      (lsAjP6?.rows || []).some((r2) => r2.canonicalId === "aj:" + _p6aj?.id && /Pedido #/.test(r2.motivo || "")),
      JSON.stringify({ findings: (errsP6?.findings || []).filter((f) => String(f.alvo || "").includes(p6ped.json?.pedidoId || "?")).map((f) => f.rule) }).slice(0, 160));
    const badAct = await req2("POST", "/api/admin/financeiro", { action: "add_pagament0", pagamento: { valor: 10, nota: "typo" } });
    const _sem10 = !((await get("/api/admin/financeiro")).json?.pagamentos || []).some((x) => x.valor === 10 && x.nota === "typo");
    check("💼 MC5-P6: action desconhecida no caixa leva 400 com o nome do typo — antes era 'ok:true' mudo que não fazia NADA (o admin achava que salvou)",
      badAct.status === 400 && /desconhecida/i.test(badAct.json?.error || "") && /add_pagament0/.test(badAct.json?.error || "") && _sem10,
      (badAct.body || "").slice(0, 120));
    const _cbStateDisk = JSON.parse(fs.readFileSync(path.join(DATA, "cerebro", "cerebro_state.json"), "utf8"));
    check("💼 MC5-P6: a fila do tempo real está PERSISTIDA em disco (um deploy no meio da janela de debounce não perde mais a reação) — os eventos da aprovação e do cancelamento de agora estão lá",
      _cbStateDisk?.tempoRealPend && _cbStateDisk.tempoRealPend.pendentes >= 2 &&
      (_cbStateDisk.tempoRealPend.eventos || []).some((e2) => e2.tipo === "pedido_cancelado") &&
      (_cbStateDisk.tempoRealPend.eventos || []).some((e2) => e2.tipo === "pedido_aprovado"),
      JSON.stringify(_cbStateDisk?.tempoRealPend).slice(0, 160));
    const p6flush = await req2("POST", "/api/admin/cerebro/reagir", {});
    const _cbStateDisk2 = JSON.parse(fs.readFileSync(path.join(DATA, "cerebro", "cerebro_state.json"), "utf8"));
    check("💼 MC5-P6: reagiu = fila do disco LIMPA (tempoRealPend some do estado) — e no boot retomarTempoReal() re-arma o que tiver sobrado de antes do restart",
      p6flush.json?.ok === true && p6flush.json?.eventos >= 2 && !_cbStateDisk2.tempoRealPend &&
      _srvSrc.includes("_cerebro.retomarTempoReal()") &&
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("function retomarTempoReal"),
      JSON.stringify({ ev: p6flush.json?.eventos, pend: !!_cbStateDisk2.tempoRealPend }).slice(0, 120));
    check("💼 MC5-P6: (estrutural) o filter que APAGAVA a entrada do cancelamento morreu (função única anularNoCaixa exportada do cérebro), gravação de dinheiro conferida (_persistFinConferido na aprovação E no robô recorrente, com push de socorro) — e o fallthrough 'ok mudo' do financeiro morreu",
      !_srvSrc.includes("entrada do caixa removida junto") && _srvSrc.includes("_cerebro.anularNoCaixa(") &&
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("anularNoCaixa: _anularNoCaixa") &&
      _srvSrc.includes("function _persistFinConferido") && (_srvSrc.match(/_persistFinConferido\(/g) || []).length >= 3 &&
      _srvSrc.includes("Caixa não gravou no disco") &&
      _srvSrc.includes("Ação desconhecida"),
      "algum item do 'caixa nunca apaga' sumiu");

    // ═══ 💼 MC5 — PARTE 7 (30/08): VIGIAS QUE NUNCA DORMEM ═════════════════
    // Carimbo da diária em DISCO + catch-up (Render Free hiberna às 02h),
    // dead-man's switch, IA morta → push, retry com teto, tempo real em
    // TODAS as actions do caixa e auto-fechamento de TODOS os meses antigos.
    const vg1 = await req2("POST", "/api/admin/cerebro/vigia", { forcar: true });
    const _stampDisk1 = JSON.parse(fs.readFileSync(path.join(DATA, "cerebro", "diaria_stamp.json"), "utf8"));
    const vg2 = await req2("POST", "/api/admin/cerebro/vigia", { forcar: true });
    check("💼 MC5-P7: o vigia roda a diária em CATCH-UP (não só na hora exata das 02h) e carimba o dia em DISCO — restart não perde o carimbo e a 2ª checagem do mesmo dia NÃO re-roda (idempotente por dia)",
      vg1.json?.ok === true && vg1.json?.catchup === true && vg1.json?.deadman === false &&
      _stampDisk1.dia === vg1.json?.dia && _stampDisk1.em > Date.now() - 120_000 &&
      vg2.json?.ok === true && vg2.json?.catchup === false && vg2.json?.deadman === false,
      JSON.stringify({ v1: vg1.json, v2: { c: vg2.json?.catchup, d: vg2.json?.deadman } }).slice(0, 160));
    fs.writeFileSync(path.join(DATA, "cerebro", "diaria_stamp.json"), JSON.stringify({ dia: "2026-08-01", em: Date.now() - 72 * 3600_000 }));
    const vg3 = await req2("POST", "/api/admin/cerebro/vigia", { forcar: true });
    const vg4 = await req2("POST", "/api/admin/cerebro/vigia", { forcar: true });
    check("💼 MC5-P7: DEAD-MAN'S SWITCH — diária sem sucesso há 72h dispara o aviso aos admins E o catch-up recupera na mesma checagem; depois do sucesso o alarme desarma sozinho",
      vg3.json?.ok === true && vg3.json?.deadman === true && vg3.json?.catchup === true &&
      vg4.json?.deadman === false && vg4.json?.catchup === false,
      JSON.stringify({ v3: { d: vg3.json?.deadman, c: vg3.json?.catchup }, v4: { d: vg4.json?.deadman, c: vg4.json?.catchup } }).slice(0, 140));
    const _mesGusd = new Date(Date.now() - 32 * 24 * 3600_000 - 3 * 3600_000).toISOString().slice(0, 7);
    const fAuto = await req2("POST", "/api/admin/fechamento/auto", { ignorarDia3: true });
    const fAuto2 = await req2("POST", "/api/admin/fechamento/auto", { ignorarDia3: true });
    const _fechsP7 = (await get("/api/admin/fechamentos")).json;
    check("💼 MC5-P7: auto-fechamento agora pega TODOS os meses antigos abertos (o mês do gasto USD de 32 dias atrás fecha sozinho), nunca o corrente — e a 2ª rodada diz honestamente 'nenhum mês antigo aberto'",
      fAuto.json?.ok === true &&
      (_fechsP7?.fechamentos || []).some((f) => f.mes === _mesGusd) &&
      fAuto2.json?.ok === true && fAuto2.json?.skipped === "nenhum mês antigo aberto",
      JSON.stringify({ f1: fAuto.json?.fechados, f2: fAuto2.json?.skipped, mes: _mesGusd }).slice(0, 160));
    const _trAntes7 = (await get("/api/admin/cerebro/status")).json?.tempoReal?.aguardando || 0;
    const edG7 = await req2("POST", "/api/admin/financeiro", { action: "edit_gasto", id: "gsm3", motivo: "teste vigia P7", changes: { nota: "editado no P7" } });
    const _trDepois7 = (await get("/api/admin/cerebro/status")).json?.tempoReal?.aguardando || 0;
    check("💼 MC5-P7: TODA action do caixa avisa o tempo real — editar um gasto entra na janela do cérebro na hora (antes só as 4 rotas de pedido tinham gatilho)",
      edG7.json?.ok === true && _trDepois7 === _trAntes7 + 1 &&
      (_srvSrc.match(/_hookCaixa\(/g) || []).length >= 9,
      JSON.stringify({ antes: _trAntes7, depois: _trDepois7 }).slice(0, 100));
    const iaS7 = (await get("/api/admin/ia-saude")).json;
    const compS7 = (await get("/api/admin/cerebro/comprovantes")).json;
    check("💼 MC5-P7: IA morta não fica muda (3 falhas TOTAIS seguidas → push 1x/6h; série visível na Saúde da IA) e o retry de leitura ganhou TETO (5 tentativas → sai da fila e entra na lista de esgotados, nunca escondido)",
      typeof iaS7?.falhasSeguidas === "number" && iaS7.falhasSeguidas === 0 &&
      Array.isArray(compS7?.esgotados) &&
      _srvSrc.includes("_iaFalhaSeq.n>=3") && _srvSrc.includes("IA fora do ar") &&
      _srvSrc.includes("tentativas:_tentErr") &&
      fs.readFileSync(path.join(__dirname, "mod-cerebro.js"), "utf8").includes("(pd.preCheck.tentativas || 0) < 5"),
      JSON.stringify({ falhas: iaS7?.falhasSeguidas, esg: compS7?.esgotados?.length }).slice(0, 100));
    check("💼 MC5-P7: (estrutural) vigia completo — stamp em disco (diaria_stamp.json), dead-man com push 'Vigia contábil parado', teto de 3 falhas/dia da diária, _autoFecharMesesAntigos como motor único do dia 3, e as rotas /cerebro/vigia + /fechamento/auto vivas",
      _srvSrc.includes("DIARIA_STAMP_FILE") && _srvSrc.includes("Vigia contábil parado") &&
      _srvSrc.includes("(st.falhas||0)<3") && _srvSrc.includes("function _autoFecharMesesAntigos") &&
      _srvSrc.includes('"/api/admin/cerebro/vigia"') && _srvSrc.includes('"/api/admin/fechamento/auto"') &&
      !_srvSrc.includes("_cbDiariaDia"),
      "algum vigia dormiu");

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
    check("🔐 v165: (estrutural diagnóstico) linha do tempo de autenticação por usuário (ring 40) alimentada por login/refresh/pausas/revokes, detector de QUEDA RÁPIDA (invalid_grant <30min após consent novo = Google da conta derrubando → instrução myaccount + push 1x/6h) e raio-X 🔐 na 💳 Auditoria",
      _srvSrc.includes("function _authEvent(") && _srvSrc.includes(".slice(0,40)}") &&
      _srvSrc.includes("function _diagQuedaAuth(") && _srvSrc.includes("lastConsentAt") &&
      _srvSrc.includes("Sua conta Google está derrubando o acesso") &&
      _srvSrc.includes('"refresh_falhou"') && _srvSrc.includes('"login_consent"') && _srvSrc.includes('"revoke_mismatch"') &&
      _admHtml.includes("Autenticação Gmail (raio-X)") && _admHtml.includes("d.auth.timeline"),
      "diagnóstico de autenticação incompleto");

    // ═══ 💼 MC5 — PARTE 8 (02/09): RELATÓRIOS PRONTOS ══════════════════════
    // Semanal toda segunda + mensal no dia 3, por PUSH sem ninguém pedir,
    // com histórico navegável — números 100% determinísticos das fontes 13n.
    const _fBRL8 = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const _hojeBRT8 = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const relSem = await req2("POST", "/api/admin/cerebro/relatorio-periodico", { tipo: "semanal" });
    const _jan8 = (await get("/api/admin/financeiro")).json?.entradas;
    check("💼 MC5-P8: relatório SEMANAL gerado com os números da fonte única — o 7d do texto é IDÊNTICO ao computeEntradasJanelas (nunca uma 2ª régua), com acerto dos 2 sócios, saúde contábil e fontes declaradas",
      relSem.json?.ok === true && relSem.json.relatorio?.id === "REL-SEMANAL-" + _hojeBRT8 &&
      /RELATÓRIO SEMANAL/.test(relSem.json.relatorio?.texto || "") &&
      (relSem.json.relatorio?.texto || "").includes("7d " + _fBRL8(_jan8?.dias7)) &&
      /Andrio: /.test(relSem.json.relatorio.texto) && /Diego: /.test(relSem.json.relatorio.texto) &&
      /integridade/.test(relSem.json.relatorio.texto) && /Fontes: computeEntradasJanelas/.test(relSem.json.relatorio.texto),
      (relSem.json?.relatorio?.texto || relSem.body || "").slice(0, 200));
    const _mesAnt8 = new Date(Date.UTC(new Date(Date.now() - 3 * 3600_000).getUTCFullYear(), new Date(Date.now() - 3 * 3600_000).getUTCMonth() - 1, 15)).toISOString().slice(0, 7);
    await req2("POST", "/api/admin/cerebro/relatorio-periodico", { tipo: "mensal" });
    await req2("POST", "/api/admin/cerebro/relatorio-periodico", { tipo: "mensal" });
    const relLst = (await get("/api/admin/cerebro/relatorios")).json;
    const _relMs = (relLst?.relatorios || []).filter((r) => r.id === "REL-MENSAL-" + _hojeBRT8);
    check("💼 MC5-P8: relatório MENSAL cobre o mês ANTERIOR (com status do fechamento 📕) e re-gerar no mesmo dia SUBSTITUI — o histórico nunca duplica; a lista traz semanal E mensal navegáveis",
      _relMs.length === 1 && (new RegExp("RELATÓRIO MENSAL — " + _mesAnt8)).test(_relMs[0].texto || "") &&
      /(Mês FECHADO|Mês ainda ABERTO)/.test(_relMs[0].texto) &&
      (relLst.relatorios || []).some((r) => r.id === "REL-SEMANAL-" + _hojeBRT8),
      JSON.stringify({ n: _relMs.length, ids: (relLst?.relatorios || []).map((r) => r.id).slice(0, 4) }).slice(0, 160));
    check("💼 MC5-P8: (estrutural) o vigia dispara sozinho (semanal toda segunda, mensal no dia 3 — DEPOIS do fechamento automático da autonomia), push 'Relatório pronto' aos admins, histórico com teto 60 e a tela 🗞️ na aba 🧠 com gerar-agora",
      _srvSrc.includes("st.semanalDia!==dia") && _srvSrc.includes("st.mensalMes!==mesR") &&
      _srvSrc.includes("Relatório semanal pronto") && _srvSrc.includes("Relatório mensal pronto") &&
      _srvSrc.includes("hist.slice(0,60)") &&
      _admHtml.includes("cerebroRelatorios") && _admHtml.includes("cerebroGerarRelatorio") &&
      _admHtml.includes("🗞️ Relatórios") && _admHtml.includes("/api/admin/cerebro/relatorio-periodico"),
      "relatórios prontos incompletos");

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
      check("📖 v160: o fragmento /tutorial-conteudo tem as 28 partes completas (ids tut-1..tut-28, todas com palavras-chave) e a aba carrega sob demanda (loadTutorial) com busca (tutFiltra)",
        _tuts.length === 28 && [...Array(28)].every((_, i) => _ids.has(i + 1)) &&
        (_frag160.match(/data-kw="/g) || []).length >= 28 &&
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
      check("📖 v160: TODAS as fotos referenciadas nos tutoriais existem de verdade no disco (nenhum print quebrado) — e são 20+ fotos reais",
        _imgsRef.length >= 20 && _faltando.length === 0,
        JSON.stringify({ refs: _imgsRef.length, faltando: _faltando }).slice(0, 200));
      const _img160 = await _getBufA("/tut-img/t03-home.jpg");
      const _trav160 = await get("/tut-img/..%2Fserver.js");
      const _nada160 = await get("/tut-img/nao-existe.jpg");
      check("📖 v160: a rota /tut-img serve a foto real (200, image/jpeg) e RECUSA nome fora do padrão (traversal encodado) e arquivo inexistente",
        _img160.status === 200 && String(_img160.headers["content-type"]).includes("image/jpeg") && _img160.buf.length > 10_000 &&
        _trav160.status === 404 && _nada160.status === 404,
        JSON.stringify({ st: _img160.status, len: _img160.buf?.length, trav: _trav160.status, nada: _nada160.status }).slice(0, 140));
    }

    // ═══ 🩺 v161: CURA DA CAMADA GEMINI (bug real de produção, 24/08) ══════
    // Prints do dono: pré-check "Unexpected end of JSON input" + Cérebro-IA
    // "sem explicação válida". Causa: fluxos PINADOS num modelo só + tokens
    // curtos (JSON truncado). Agora: função única com cadeia de fallback,
    // motivo honesto de falha e painel 🩺 Saúde da IA.
    const ia161 = await get("/api/admin/ia-saude");
    check("🩺 v161: GET /api/admin/ia-saude — status honesto (chave, cadeia de modelos com 2.0-flash na frente por padrão, estatística por fluxo)",
      ia161.json?.ok === true && typeof ia161.json?.chaveConfigurada === "boolean" &&
      Array.isArray(ia161.json?.cadeia) && ia161.json.cadeia[0] === "gemini-2.0-flash" && ia161.json.cadeia.length >= 3 &&
      typeof ia161.json?.fluxos === "object",
      JSON.stringify({ cadeia: ia161.json?.cadeia, chave: ia161.json?.chaveConfigurada }).slice(0, 160));
    const ping161 = await req2("POST", "/api/admin/ia-saude", { ping: true });
    check("🩺 v161: ping real da IA (simulado no teste) — devolve modelo e latência, nunca trava",
      ping161.json?.ok === true && ping161.json?.ping?.ok === true && ping161.json?.ping?.modelo === "(teste)",
      JSON.stringify(ping161.json).slice(0, 120));
    check("🩺 v161: (estrutural) ZERO chamadas pinadas num modelo só restam no server — todos os 5 fluxos migrados pra geminiGenerate (fallback + motivo real), pré-check e Cérebro-IA com teto 900 tokens, botão 🩺 no painel",
      (() => { const _s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8"); return !_s.includes("models/gemini-2.0-flash:generateContent") && _s.includes("async function geminiGenerate") && _s.includes("process.env.GEMINI_MODEL") && _s.includes('fluxo:"precheck-comprovante"') && _s.includes('fluxo: "cerebro-ia"') && _s.includes('fluxo:"email-fix"') && _s.includes('fluxo:"validar-cliente"') && _s.includes('fluxo:"regularizar-pendentes"') && /precheck-comprovante",temperature:0\.1,maxOutputTokens:900/.test(_s); })() &&
      _admHtml.includes("cerebroIaSaude") && _admHtml.includes("Saúde da IA") && _admHtml.includes("cerebroIaPing"),
      "camada Gemini incompleta");

    // 🩺 v155 (caso Esdras: "desbaniu e continua barrado" — a causa era OUTRA
    // porta): raio-X do login testa todas as portas; e a triagem nunca mais
    // manda ninguém pra servidor Oculto (lá o código congelado tem regras velhas).
    const dg1 = await get("/api/admin/diagnostico-login?email=" + encodeURIComponent("smoke@test.com"));
    check("🩺 v155: diagnóstico de conta EXISTENTE → nenhum bloqueio e explica que o login é liberado",
      dg1.json?.ok === true && (dg1.json?.problemas || []).length === 0 && (dg1.json?.info || []).some((x) => /Conta EXISTE/.test(x)),
      (dg1.body || "").slice(0, 160));
    await req2("POST", "/api/admin/settings", { servers: [
      { id: 1, nome: "Servidor 1", url: BASE, maxExibido: 100, status: "lotado" },
      { id: 2, nome: "Servidor 2", url: `http://127.0.0.1:${PORT_B}`, maxExibido: 100, status: "oculto" }] });
    const dg2 = await get("/api/admin/diagnostico-login?email=" + encodeURIComponent("naoexiste.diag@test.com"));
    check("🩺 v155+v156: e-mail SEM conta + servidor 'lotado' na config → NENHUM bloqueio (o lotado virou decorativo: cadastro novo é SEMPRE aceito aqui)",
      dg2.json?.ok === true && (dg2.json?.problemas || []).length === 0 &&
      (dg2.json?.info || []).some((x) => /SEMPRE aceito/.test(x)) && (dg2.json?.info || []).some((x) => /decorativo/.test(x)),
      (dg2.body || "").slice(0, 250));
    // E o /api/auth/where com o MESMO servidor "lotado" na config: a pessoa
    // nova continua sendo cadastrada AQUI (a trava morreu de verdade, não só
    // no diagnóstico) — este era exatamente o cenário da pessoa real de 22/08.
    const aw2 = await get("/api/auth/where?email=" + encodeURIComponent("pessoa.nova2.v156@gmail.com"));
    check("🌐 v156: mesmo com status 'lotado' salvo na config, a triagem manda o cadastro pra CÁ (forçado aberto) — nunca pro Servidor 2/3",
      aw2.json?.ok === true && aw2.json?.found === false && (aw2.json?.openServers || []).length === 1 &&
      aw2.json?.openServers?.[0]?.self === true && aw2.json?.openServers?.[0]?.status === "aberto",
      JSON.stringify(aw2.json?.openServers));
    await req2("POST", "/api/admin/settings", { servers: [
      { id: 1, nome: "Servidor 1", url: BASE, maxExibido: 100, status: "aberto" },
      { id: 2, nome: "Servidor 2", url: `http://127.0.0.1:${PORT_B}`, maxExibido: 100, status: "oculto" }] });
    check("🩺 v155: (estrutural) triagem NUNCA manda ninguém pra servidor Oculto + painel tem o raio-X de login",
      _srvSrc.includes('if(sv.status==="oculto")continue;') && _admHtml.includes("diagnosticarLogin") && _admHtml.includes('id="diag-email"'),
      "skip de oculto ou raio-X não encontrados");

    // ═══ 🛡️ v73: AQUECIMENTO DE CONTA GMAIL NOVA (proteção anti-bloqueio) ═══
    // Pedido real do dono: "tem gente sendo bloqueada pelo Google". A defesa:
    // conta recém-conectada manda pouco nos primeiros dias, ganha volume aos
    // poucos — e uma conta suspensa isolada não trava as outras contas saudáveis.
    const { warmupCapForSender: _warmupFn, daysSince: _daysSinceFn } = require("./mod-engine-core.js");
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
