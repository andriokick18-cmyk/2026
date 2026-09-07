#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
//  H2BApply — RESET COMPLETO DE DADOS
//  Apaga: usuários, histórico, sessões, logs, comprovantes,
//         financeiro, candidaturas, pedidos, referrals,
//         sugestões, alertas, notificações, push subs,
//         emails inválidos, badges, ranking oculto, notas,
//         promo codes, backup automático, temp failures,
//         email corrections, auto jobs, sent emails.
//
//  PRESERVA: admin_settings.json (configurações do sistema)
//            Arquivos de vagas DOL (jul2025_compact.json etc.)
//            Código-fonte (server.js, index.html, admin.html...)
//
//  USO: node reset_h2bapply.js [--data-dir /caminho/para/data]
//       Se DATA_DIR não for passado, usa /data ou /tmp (igual ao server.js)
// ═══════════════════════════════════════════════════════════
"use strict";

const fs   = require("fs");
const path = require("path");

// ── Determinar DATA_DIR ───────────────────────────────────
let DATA_DIR = process.env.DATA_DIR || null;

// Suporte a --data-dir via argumento de linha de comando
const argIdx = process.argv.indexOf("--data-dir");
if (argIdx !== -1 && process.argv[argIdx + 1]) {
  DATA_DIR = process.argv[argIdx + 1];
}

if (!DATA_DIR) {
  DATA_DIR = fs.existsSync("/data") ? "/data" : "/tmp";
}

console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║        H2BApply — RESET COMPLETO DE DADOS           ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log(`\n📁 DATA_DIR: ${DATA_DIR}\n`);

// Garantir que DATA_DIR existe
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`❌ Não foi possível criar/acessar DATA_DIR: ${e.message}`);
  process.exit(1);
}

// ── Função auxiliar ───────────────────────────────────────
function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    console.log(`  ✅ ${path.basename(file)}`);
    return true;
  } catch (e) {
    console.error(`  ❌ ERRO ao escrever ${path.basename(file)}: ${e.message}`);
    return false;
  }
}

function deleteFile(file) {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`  🗑️  ${path.basename(file)} (removido)`);
    } else {
      console.log(`  ⏭️  ${path.basename(file)} (não existia)`);
    }
  } catch (e) {
    console.error(`  ❌ ERRO ao remover ${path.basename(file)}: ${e.message}`);
  }
}

function deleteDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`  🗑️  ${path.basename(dir)}/ (pasta removida)`);
    } else {
      console.log(`  ⏭️  ${path.basename(dir)}/ (não existia)`);
    }
  } catch (e) {
    console.error(`  ❌ ERRO ao remover pasta ${path.basename(dir)}: ${e.message}`);
  }
}

// ── 1. Usuários e sessões ─────────────────────────────────
console.log("\n▶ Usuários e sessões:");
writeJSON(path.join(DATA_DIR, "users.json"), {});
writeJSON(path.join(DATA_DIR, "h2b_users.json"), {}); // alias legado

// ── 2. Histórico de candidaturas ─────────────────────────
console.log("\n▶ Histórico de candidaturas:");
writeJSON(path.join(DATA_DIR, "history.json"), {});
writeJSON(path.join(DATA_DIR, "h2b_history.json"), {}); // alias legado
writeJSON(path.join(DATA_DIR, "app_index.json"), {});   // índice de candidaturas (appId)

// ── 3. Auto jobs (configurações do robô por usuário) ──────
console.log("\n▶ Robô automático:");
writeJSON(path.join(DATA_DIR, "auto_jobs.json"), {});

// ── 4. Emails enviados (dedup) ────────────────────────────
console.log("\n▶ Emails enviados (dedup):");
writeJSON(path.join(DATA_DIR, "sent_emails.json"), {});

// ── 5. Logs do robô ───────────────────────────────────────
console.log("\n▶ Logs:");
writeJSON(path.join(DATA_DIR, "auto_logs.json"), {});

// ── 6. Jornada do usuário ─────────────────────────────────
console.log("\n▶ Jornada:");
writeJSON(path.join(DATA_DIR, "journey.json"), {});

// ── 7. Notas ──────────────────────────────────────────────
console.log("\n▶ Notas:");
writeJSON(path.join(DATA_DIR, "notes.json"), {});

// ── 8. Alertas de vagas ───────────────────────────────────
console.log("\n▶ Alertas:");
writeJSON(path.join(DATA_DIR, "job_alerts.json"), {});

// ── 9. Promo codes ────────────────────────────────────────
console.log("\n▶ Promo codes:");
writeJSON(path.join(DATA_DIR, "promo_codes.json"), {});

// ── 10. Push subscriptions ────────────────────────────────
console.log("\n▶ Push subscriptions:");
writeJSON(path.join(DATA_DIR, "push_subs.json"), {});

// ── 11. Financeiro ────────────────────────────────────────
console.log("\n▶ Financeiro:");
writeJSON(path.join(DATA_DIR, "financeiro.json"), { pagamentos: [], gastos: [] });

// ── 12. Pedidos de plano ──────────────────────────────────
console.log("\n▶ Pedidos:");
writeJSON(path.join(DATA_DIR, "pedidos.json"), []);

// ── 13. Sugestões ─────────────────────────────────────────
console.log("\n▶ Sugestões:");
writeJSON(path.join(DATA_DIR, "suggestions.json"), []);

// ── 14. Referrals ─────────────────────────────────────────
console.log("\n▶ Referrals:");
writeJSON(path.join(DATA_DIR, "referrals.json"), { byCode: {}, byEmail: {} });

// ── 15. Notificações globais ──────────────────────────────
console.log("\n▶ Notificações:");
writeJSON(path.join(DATA_DIR, "notifications.json"), { notifications: [] });

// ── 16. Ranking: ocultos e badges ─────────────────────────
console.log("\n▶ Ranking:");
writeJSON(path.join(DATA_DIR, "rank_hidden.json"), {});
writeJSON(path.join(DATA_DIR, "rank_badges.json"), {});

// ── 17. Emails inválidos / correções / falhas temp ────────
console.log("\n▶ Email intelligence:");
writeJSON(path.join(DATA_DIR, "invalid_emails.json"), {});
writeJSON(path.join(DATA_DIR, "email_corrections.json"), {});
writeJSON(path.join(DATA_DIR, "temp_failures.json"), {});

// ── 17b. Anti-abuse de trial (temporada nova: todos podem pegar trial de novo) ─
console.log("\n▶ Anti-abuse de trial (zerado p/ nova temporada):");
writeJSON(path.join(DATA_DIR, "trial_used.json"), { phones: {}, ips: {}, googleIds: {} });

// ── 18. Backup automático ─────────────────────────────────
console.log("\n▶ Backup automático:");
deleteFile(path.join(DATA_DIR, "backup.json"));

// ── 19. Pasta de CVs/comprovantes ────────────────────────
console.log("\n▶ CVs e comprovantes (pasta /cvs):");
deleteDir(path.join(DATA_DIR, "cvs"));
// Recriar pasta vazia para o server não quebrar
try {
  fs.mkdirSync(path.join(DATA_DIR, "cvs"), { recursive: true });
  console.log(`  📁 cvs/ recriada vazia`);
} catch (e) {
  console.error(`  ❌ Não foi possível recriar cvs/: ${e.message}`);
}

// ── 20. Admin settings — PRESERVADO (só reseta se quiser) ─
console.log("\n▶ Admin settings (PRESERVADO — não apagado):");
const adminFile = path.join(DATA_DIR, "admin_settings.json");
if (fs.existsSync(adminFile)) {
  console.log(`  ✅ ${path.basename(adminFile)} mantido como está`);
} else {
  // Criar padrão se não existir (regra atual: 1 dia VIP Manual, sem auto)
  writeJSON(adminFile, {
    newUserTrialEnabled: true,
    newUserTrialDays: 1,
    newUserTrialAutoDays: 0,
    newUserTrialPlan: "vip",
    editorPasswords: { andrew: "84800-54", diego: "Diego2026" }
  });
  console.log(`  📝 admin_settings.json criado com padrões`);
}

// ── Resumo ────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════╗
║              ✅ RESET CONCLUÍDO                      ║
╠══════════════════════════════════════════════════════╣
║  • Todos os usuários removidos                       ║
║  • Todo histórico de candidaturas apagado            ║
║  • Logs, sessões, tokens OAuth limpos                ║
║  • Comprovantes / CVs removidos                      ║
║  • Financeiro zerado                                 ║
║  • Pedidos, referrals, sugestões apagados            ║
║  • Email intelligence zerado                         ║
║  • Push subscriptions removidas                      ║
║  • Ranking e badges zerados                          ║
║  • admin_settings.json PRESERVADO                    ║
║  • Arquivos de vagas DOL não tocados                 ║
╚══════════════════════════════════════════════════════╝

⚠️  ATENÇÃO: Reinicie o servidor (server.js) para que
    os DBs em memória reflitam os arquivos zerados.
`);
