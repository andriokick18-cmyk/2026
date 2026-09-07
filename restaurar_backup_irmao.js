#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🗄️ restaurar_backup_irmao.js — Restauração 1-comando do backup entre
   irmãos (v70). Ensaiada de verdade no smoke test (regra da casa: drill
   real, nunca presumido).

   USO (no shell do Render do servidor NOVO, com o .gz já copiado):
     node restaurar_backup_irmao.js /data/backups_peers/srv3/2026-07-26.json.gz /data

   O QUE FAZ:
   - Abre o pacote gzip criado pelo backup entre irmãos (v69);
   - Grava cada arquivo crítico no diretório de destino;
   - NUNCA destrói o que estava lá: qualquer arquivo sobrescrito ganha
     antes uma cópia .antes-restauracao ao lado.
   ⚠️ A DATA_ENC_KEY do serviço precisa ser a MESMA da época do backup —
   sem ela os tokens Gmail dos usuários não abrem.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const [, , origem, destino] = process.argv;
if (!origem || !destino) {
  console.log("Uso: node restaurar_backup_irmao.js <pacote.json.gz> <dir-destino>");
  console.log("Ex.:  node restaurar_backup_irmao.js /data/backups_peers/srv3/2026-07-26.json.gz /data");
  process.exit(1);
}

let bundle;
try {
  bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(origem)).toString());
} catch (e) {
  console.error("⛔ Pacote inválido ou corrompido:", e.message);
  process.exit(1);
}
if (!bundle || typeof bundle.files !== "object" || !Object.keys(bundle.files).length) {
  console.error("⛔ Pacote sem arquivos dentro (files vazio).");
  process.exit(1);
}

fs.mkdirSync(destino, { recursive: true });
let n = 0;
for (const [nome, conteudo] of Object.entries(bundle.files)) {
  // Segurança: só nomes simples de arquivo — nada de ../ nem subpastas.
  const base = path.basename(String(nome));
  if (base !== nome || !base.endsWith(".json")) { console.warn("⏭ ignorado (nome suspeito):", nome); continue; }
  const alvo = path.join(destino, base);
  if (fs.existsSync(alvo)) fs.copyFileSync(alvo, alvo + ".antes-restauracao");
  fs.writeFileSync(alvo, String(conteudo));
  console.log(`✅ ${base} → ${alvo} (${String(conteudo).length} bytes)`);
  n++;
}
console.log(`\n🗄️ Restauração concluída: ${n} arquivo(s) do Servidor ${bundle.serverId || "?"} — pacote de ${bundle.ts ? new Date(bundle.ts).toLocaleString("pt-BR") : "?"}.`);
console.log("➡️  Agora reinicie o serviço e confira: login, saldos 💎, Conferência e Visão do Dono.");
console.log("⚠️  Lembrete: a DATA_ENC_KEY precisa ser a MESMA da época do backup.");
