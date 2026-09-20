/* ═══════════════════════════════════════════════════════════════════════
   ⚙️ src/config.js — Fase 1 da Transformação · Módulo 1 (extraído do server.js)
   Configuração pura: sem dependências internas, só process.env.
   REGRA: valores idênticos aos originais — extração mecânica, zero mudança
   de comportamento. Suíte de testes valida antes/depois.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// ── E-mails com limite de contas remetentes ─────────────────────────────
// 📧 ORDEM DO DONO (13/09/2026): e-mails de envio por plano — grátis 0 (sem
// plano não vincula Gmail nenhum), VIP e VIPro 1 (só o principal), DoublePro
// 2 (principal + 1 extra), admin 6. getMaxSenders (server.js) é a fonte única.
const MAX_SENDER_EMAILS_FREE      = 0;
const MAX_SENDER_EMAILS_VIP       = 1; // VIP e VIPro: só o e-mail principal (0 extras)
const MAX_SENDER_EMAILS_DOUBLEPRO = 2; // DoublePro: principal + 1 extra
const MAX_SENDER_EMAILS_ADMIN     = 6; // admins: principal + 5 extras
// 🎯 ordem do dono, 12/09/2026: automático do admin ganhou um teto DE
// VERDADE (era 9999 = sem teto nenhum) — 450 envios/dia POR e-mail
// conectado (principal ou extra), não um total único pra conta inteira.
// Customizável por e-mail via adminSettings.senderLimits (getAutoLimit).
const ADMIN_AUTO_DAILY_LIMIT_PER_SENDER = 450;
const MAX_RESUMES              = 10; // 11/07: 10 PDFs de currículo por conta (perfil único, 07/2026); 3 travava usuário real com uploads órfãos de tentativas falhas
const MAX_COVERS               = 10;

// ── Admins ──────────────────────────────────────────────────────────────
// v175b (dono, 13/09/2026: "meu email adm é andrio.usa2026@gmail.com"):
// ADMIN_EMAIL é o e-mail do DONO (login "andrio" do painel, avisos de compra,
// username reservado "andrio"); ADMIN_EMAIL_2 é o do Diego (login "diego" —
// antes vinha vazio por padrão e o login dele só funcionava com a env
// definida). A env do Render, se existir, continua mandando.
const ADMIN_EMAIL   = (process.env.ADMIN_EMAIL || "andrio.usa2026@gmail.com").trim().toLowerCase();
const ADMIN_EMAIL_2 = (process.env.ADMIN_EMAIL_2 || "jesuscristh22@gmail.com").trim().toLowerCase();
// Admins adicionais hardcoded (contas auxiliares — continuam admin, mas os
// avisos de compra vão só pros 2 sócios acima). andrio.kick18 é o e-mail
// antigo do dono: fica aqui pra nenhuma trilha/registro antigo virar "não-admin".
const ADMIN_EMAILS_EXTRA = ["andrio.kick18@gmail.com","ndrkick.2@gmail.com","ueudesmaresias@gmail.com"].map(e=>e.trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS  = new Set([ADMIN_EMAIL, ADMIN_EMAIL_2, ...ADMIN_EMAILS_EXTRA].filter(Boolean));
const isAdminEmail  = (e) => ADMIN_EMAILS.has((e||"").trim().toLowerCase());

// ── Web Push ─────────────────────────────────────────────────────────────
// Sem backend real de Web Push nesta reconstrução (sem lib web-push, sem
// rotas /api/push/*, sem VAPID configurado) — PUSH_ENABLED fica sempre
// false; DB_PUSH/pushToUser continuam como stubs inertes (injeção de
// dependência de mod-sentinel.js/mod-watchdogs.js, nunca reativados sem
// ordem nova do dono).
const PUSH_ENABLED = false;

// ── Planos ───────────────────────────────────────────────────────────────
//   free      → 0 manual   + 0 auto   /dia (SEM envio — só navegar/ver como funciona)
//   vip       → 100 manual + 0 auto   /dia — nome público "Manual" (só manual pago)
//   vipro     → 100 manual + 100 auto /dia — nome público "Turbo" (manual + automático)
//   doublepro → 50  manual + 300 auto /dia — nome público "Máximo" (foco em automático)
//   pro       → 0 manual   + 200 auto  /dia (só auto — legado)
//   Os limites de manual e auto são INDEPENDENTES — não se misturam.
// v218 (ORDEM DO DONO, 20/09/2026 — reestruturação da página de Planos):
// nomes/preços/limites NOVOS pra quem compra a partir de hoje. As CHAVES
// INTERNAS (vip/vipro/doublepro) continuam as MESMAS de propósito — só o
// NOME PÚBLICO e os NÚMEROS mudaram (ver NOME_PLANO_PUBLICO, server.js, e
// PLANO_PRECO_TAB pros preços de 30/60 dias). Isso evita reescrever toda a
// contabilidade/admin/migração de código por causa de um nome novo — o
// "contrato congelado" em vip.limits (carimbado na ativação) já garante que
// quem tinha DoublePro (200/200) ANTES desta mudança continua com 200/200
// até vencer; só ativação NOVA a partir de agora carimba 50/300.
// v118 (ORDEM DO DONO, 02/08/2026): tabela NOVA de limites — vale só pra
// CONTRATAÇÕES a partir da mudança (troca 💎, upgrade, código, set-plan do
// admin). Quem já tinha plano ativo mantém a tabela antiga até vencer
// (contrato congelado em vip.limits — ver getManualLimit/getAutoLimit).
// v172 (ORDEM DO DONO, 11/09/2026 — "o site vai ser só pra pessoas pagantes
// usarem... ela não pode usar [antes de pagar]"): o plano free NUNCA mais
// manda e-mail — 0 manual + 0 auto. Free só serve pra logar e ver o site
// (vagas, planos) antes de decidir pagar. getManualLimit/getAutoLimit têm
// fallback `|| N` que escondia zero como falsy — CORRIGIDO junto (ver lá).
const PLAN_LIMITS_NEW = {
  free:      { manual: 0,   auto: 0   },
  vip:       { manual: 100, auto: 0   }, // "Manual" — R$150/30d ou R$270/60d
  pro:       { manual: 0,   auto: 100 }, // legado
  vipro:     { manual: 100, auto: 100 }, // "Turbo" — R$300/30d ou R$540/60d
  doublepro: { manual: 50,  auto: 300 }, // "Máximo" — R$500/30d ou R$900/60d
};
// 🏷️ v218 — NOME PÚBLICO DE CADA PLANO. Fonte única no backend (o front tem
// a sua própria, PLAN_NAMES em app.js — mantidas em paralelo de propósito,
// uma pro que o SERVIDOR escreve em texto/log/extrato, outra pro que a TELA
// desenha; mudar um nome exige tocar nos dois, é o mesmo padrão que já
// existia pro emoji). Nunca "VIP"/"VIPro"/"DoublePro" de novo em texto novo.
const NOME_PLANO_PUBLICO = { vip: "Manual", vipro: "Turbo", doublepro: "Máximo", pro: "Pro", free: "Grátis" };
const PLAN_LIMITS = {
  free:      { manual: 0,   auto: 0   },
  // 🔒 v172g (auditoria 12/09/2026): era `auto:10` — resquício de antes da
  // regra "VIP é só manual" existir. Com getAutoLimit caindo nesta tabela
  // legada pra quem tem só manual ativo (isAutoVipActive false), um VIP
  // manual-only tinha getAutoLimit()=10>0 e PASSAVA pelo gate `autoLimit<=0`
  // de /api/auto/start — conseguia ligar o robô automático de graça, o que
  // a regra "VIP = só manual" proíbe expressamente. Zerado pra fechar o furo.
  vip:       { manual: 200, auto: 0   }, // VIP = só manual 200/dia
  pro:       { manual: 0,   auto: 200 }, // só auto — legado
  vipro:     { manual: 200, auto: 200 }, // manual + auto 200 cada
  doublepro: { manual: 400, auto: 400 }, // DoublePro — 2 contas, 400 cada
};

module.exports = {
  MAX_SENDER_EMAILS_FREE, MAX_SENDER_EMAILS_VIP, MAX_SENDER_EMAILS_DOUBLEPRO, MAX_SENDER_EMAILS_ADMIN,
  ADMIN_AUTO_DAILY_LIMIT_PER_SENDER,
  MAX_RESUMES, MAX_COVERS,
  ADMIN_EMAIL, ADMIN_EMAIL_2, ADMIN_EMAILS_EXTRA, ADMIN_EMAILS, isAdminEmail,
  PUSH_ENABLED,
  PLAN_LIMITS, PLAN_LIMITS_NEW, NOME_PLANO_PUBLICO,
};
