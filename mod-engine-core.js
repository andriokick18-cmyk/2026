/* ═══════════════════════════════════════════════════════════════════════
   ⏱️ src/engine/core.js — Fase 1 · Módulo 6 (extraído do server.js)
   O núcleo TESTÁVEL do motor de envio:
   - calcSmartInterval: o intervalo "humanizado" (6,5-7,5min c/ jitter) que
     protege as contas Gmail dos usuários — a função mais crítica do produto
   - Timezone BRT (UTC-3 fixo): nowBRT, todayStrBRT, toLocaleBRT
   - calcStreak / last7Days: métricas de constância do ranking
   scheduleAuto (a máquina de estados completa, 100% acoplada) permanece
   no server.js — extração dela exige reescrita guiada, não mecânica.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// ── Intervalo humanizado entre envios ─────────────────────────────────────
// createCalcSmartInterval(deps) → calcSmartInterval(email)
// deps: { getUser, isAdminVip } — admins podem ter intervalo custom (min 30s)
function createCalcSmartInterval({ getUser, isAdminVip }){
  return function calcSmartInterval(email) {
    const u = email ? getUser(email) : null;

    // ── Múltiplas contas Gmail conectadas (recurso pago "2 Gmails", e o
    // próprio admin) ──────────────────────────────────────────────────────
    // O round-robin/seleção (getSenderToken, em server.js) já alterna os
    // envios entre a conta principal e as extras — então, na prática, cada
    // CONTA individual continua recebendo o mesmo espaçamento humanizado
    // entre as SUAS próprias mensagens (o que protege contra bloqueio/spam
    // do Gmail), enquanto o ritmo GERAL do usuário fica mais rápido com
    // mais contas, sem aumentar o risco por conta — exatamente o que uma
    // 2ª conta deveria comprar. Sem este ajuste, o intervalo era fixo por
    // USUÁRIO (não por conta): o plano DoublePro prometia "400 automático/
    // dia · 2 Gmails = máximo poder", mas o motor só conseguia ~260/dia
    // mesmo com 2 contas conectadas — a 2ª conta não acelerava nada na
    // prática. Dividindo o intervalo pelo nº de contas ativas corrige isso.
    let activeSenders = 1;
    if (u) {
      const extras = Array.isArray(u?.senderEmails) ? u.senderEmails : [];
      activeSenders += extras.filter(s => s && s.active !== false && !s.tokenExpired && !s.blocked).length;
    }
    activeSenders = Math.min(6, Math.max(1, activeSenders)); // admin pode ter até 6 (principal + 5 extras)

    // Verificar configuração personalizada do admin — ordem do dono,
    // 12/09/2026: PADRÃO do admin (sem customizar nada) virou 5min POR
    // e-mail conectado (antes caía no ritmo de usuário comum, 6,5-7,5min).
    // A divisão por activeSenders vale AQUI TAMBÉM (antes só valia no ramo
    // padrão abaixo) — com 2 e-mails, o ritmo GERAL vira ~2,5min pra que
    // CADA e-mail individual continue sendo usado a cada ~5min.
    if (u && isAdminVip(u)) {
      const secs = Math.max(30, parseInt(u.adminSettings?.intervalSecs) || 300);
      const jitter = secs * 0.15; // ±15% de variação
      const base = (secs + (Math.random() * 2 - 1) * jitter) * 1000;
      return base / activeSenders;
    }

    // v118 (ORDEM DO DONO, 02/08): ritmo do automático subiu pra ~7min por
    // envio — gente demais batendo nas mesmas empresas. Vale pra TODOS
    // (proteção do sistema, não é limite de plano). Admin segue custom (acima).
    const MIN_MS = 6.5 * 60 * 1000; // 6,5 minutos
    const MAX_MS = 7.5 * 60 * 1000; // 7,5 minutos (média 7)
    const base = MIN_MS + Math.random() * (MAX_MS - MIN_MS);
    return base / activeSenders;
  };
}

// ── Timezone BRT — UTC-3 fixo (sem horário de verão no Brasil) ───────────
function nowBRT() {
  // Retorna Date ajustado para BRT (UTC-3)
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function todayStrBRT() {
  const t = nowBRT();
  return `${String(t.getUTCDate()).padStart(2,"0")}/${String(t.getUTCMonth()+1).padStart(2,"0")}/${t.getUTCFullYear()}`;
}

function toLocaleBRT(ts) {
  // Formata timestamp como data/hora no padrão pt-BR em BRT
  const d = new Date((ts||Date.now()) - 3*60*60*1000);
  const date = `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
  const time = `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
  return `${date} ${time}`;
}

// ── Métricas de constância (ranking) ──────────────────────────────────────
// Calcula streak de dias consecutivos com envios
function calcStreak(h) {
  let s = 0;
  const nowBRTd = nowBRT(); // usa UTC-3 fixo igual ao todayStrBRT()
  for (let i = 0; i < 30; i++) {
    const d = new Date(nowBRTd.getTime() - i * 86400_000);
    const ds = `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
    if (h.some(x => x.dateStr === ds)) s++;
    else break;
  }
  return s;
}

// Retorna contagem de envios dos últimos 7 dias
function last7Days(h) {
  const r = [];
  const nowBRTd = nowBRT(); // usa UTC-3 fixo igual ao todayStrBRT()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowBRTd.getTime() - i * 86400_000);
    const ds = `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
    r.push(h.filter(x => x.dateStr === ds).length);
  }
  return r;
}

// ── 🛡️ v73 — AQUECIMENTO DE CONTA GMAIL NOVA (ordem do dono, 27/07/2026:
// "tem gente sendo bloqueada pelo Google, tem algo que possamos fazer?") ──
// Padrão consagrado de QUALQUER ferramenta séria de e-mail em volume
// (Instantly, Lemlist, Smartlead...): uma conta Gmail RECÉM-CONECTADA que
// de repente manda centenas de e-mails por dia é o sinal nº1 que o
// detector de abuso do Google procura — o pulo de 0 pra "muito" é o que
// denuncia bot, não o volume em si. A defesa: toda conta nova entra
// devagar e ganha volume aos poucos, por CONTA (cada Gmail tem seu
// próprio relógio de aquecimento, a partir do dia em que foi conectada
// — addedAt do sender extra, ou created_at da conta pro e-mail principal).
// Depois de ~2 semanas de histórico limpo, a conta destrava o limite
// cheio do plano — o aquecimento é só nos primeiros dias, não um teto
// permanente.
function daysSince(tsOrIso) {
  if (!tsOrIso) return Infinity; // sem data conhecida = trata como já aquecida (nunca bloqueia por falta de dado)
  const t = typeof tsOrIso === "number" ? tsOrIso : Date.parse(tsOrIso);
  if (isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400_000);
}
// Retorna o teto de envios de HOJE pra essa conta, ou null se já não tem
// mais teto de aquecimento (conta "graduada" — vale o limite do plano).
function warmupCapForSender(addedAtTsOrIso) {
  const d = daysSince(addedAtTsOrIso);
  if (d <= 2) return 15;   // dias 1-3: bem devagar, é o período mais sensível
  if (d <= 6) return 40;   // dias 4-7
  if (d <= 13) return 100; // dias 8-14
  return null;             // dia 15+: sem teto extra, vale o limite do plano
}

module.exports = { createCalcSmartInterval, nowBRT, todayStrBRT, toLocaleBRT, calcStreak, last7Days, daysSince, warmupCapForSender };
