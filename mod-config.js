/* ═══════════════════════════════════════════════════════════════════════
   ⚙️ src/config.js — Fase 1 da Transformação · Módulo 1 (extraído do server.js)
   Configuração pura: sem dependências internas, só process.env.
   REGRA: valores idênticos aos originais — extração mecânica, zero mudança
   de comportamento. Suíte de testes valida antes/depois.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// ── E-mails com limite de contas remetentes ─────────────────────────────
const MAX_SENDER_EMAILS_FREE   = 1; // free: apenas o email principal (0 extras)
const MAX_SENDER_EMAILS_VIP    = 2; // pagantes: email principal + 1 extra = 2 total
const MAX_SENDER_EMAILS_ADMIN  = 6; // admins: email principal + 5 extras = 6 total
const MAX_RESUMES              = 10; // 11/07: 10 PDFs de currículo por conta (perfil único, 07/2026); 3 travava usuário real com uploads órfãos de tentativas falhas
const MAX_COVERS               = 10;

// ── Admins ──────────────────────────────────────────────────────────────
const ADMIN_EMAIL   = (process.env.ADMIN_EMAIL || "andrio.kick18@gmail.com").trim().toLowerCase();
const ADMIN_EMAIL_2 = (process.env.ADMIN_EMAIL_2 || "").trim().toLowerCase();
// Admins adicionais hardcoded — adicione mais emails aqui se necessário
const ADMIN_EMAILS_EXTRA = ["ndrkick.2@gmail.com","jesuscristh22@gmail.com","andrio.usa2026@gmail.com","ueudesmaresias@gmail.com"].map(e=>e.trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS  = new Set([ADMIN_EMAIL, ADMIN_EMAIL_2, ...ADMIN_EMAILS_EXTRA].filter(Boolean));
const isAdminEmail  = (e) => ADMIN_EMAILS.has((e||"").trim().toLowerCase());

// ── VAPID — Web Push Notifications ──────────────────────────────────────
// Gere suas chaves com: npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY  = (process.env.VAPID_PUBLIC_KEY  || "").trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || `mailto:${ADMIN_EMAIL}`;
const PUSH_ENABLED      = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

// ── Planos ───────────────────────────────────────────────────────────────
//   free      → 20 manual  + 10 auto   /dia (Grátis)
//   vip       → 200 manual + 10 auto   /dia (só manual pago)
//   vipro     → 200 manual + 200 auto  /dia (manual + automático)
//   doublepro → 400 manual + 400 auto  /dia (2 contas Gmail)
//   pro       → 0 manual   + 200 auto  /dia (só auto — legado)
//   Os limites de manual e auto são INDEPENDENTES — não se misturam.
// v118 (ORDEM DO DONO, 02/08/2026): tabela NOVA de limites — vale só pra
// CONTRATAÇÕES a partir da mudança (troca 💎, upgrade, código, set-plan do
// admin). Quem já tinha plano ativo mantém a tabela antiga até vencer
// (contrato congelado em vip.limits — ver getManualLimit/getAutoLimit).
const PLAN_LIMITS_NEW = {
  free:      { manual: 20,  auto: 10  },
  vip:       { manual: 100, auto: 0   }, // R$100 — 100 manuais/dia
  pro:       { manual: 0,   auto: 100 }, // legado
  vipro:     { manual: 100, auto: 100 }, // R$150 — 100 + 100
  doublepro: { manual: 200, auto: 200 }, // R$250 — 200 + 200
};
const PLAN_LIMITS = {
  free:      { manual: 20,  auto: 10  },
  vip:       { manual: 200, auto: 10  }, // VIP = só manual 200/dia
  pro:       { manual: 0,   auto: 200 }, // só auto — legado
  vipro:     { manual: 200, auto: 200 }, // manual + auto 200 cada
  doublepro: { manual: 400, auto: 400 }, // DoublePro — 2 contas, 400 cada
};

module.exports = {
  MAX_SENDER_EMAILS_FREE, MAX_SENDER_EMAILS_VIP, MAX_SENDER_EMAILS_ADMIN,
  MAX_RESUMES, MAX_COVERS,
  ADMIN_EMAIL, ADMIN_EMAIL_2, ADMIN_EMAILS_EXTRA, ADMIN_EMAILS, isAdminEmail,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_ENABLED,
  PLAN_LIMITS, PLAN_LIMITS_NEW,
};
