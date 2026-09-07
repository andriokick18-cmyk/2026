/* ═══════════════════════════════════════════════════════════════════════
   💾 STORAGE ENGINE v1.0 — Fundação profissional de dados do H2BApply
   Fase 4 do roadmap (A_MENTE_DO_H2BAPPLY.md §7-risco-1 e §8-item-4).

   ESTRATÉGIA (risco zero em produção):
   1. Tenta SQLite nativo do Node (node:sqlite, Node ≥22.5) — zero deps.
   2. Se indisponível, tenta better-sqlite3 (se instalado via npm).
   3. Se nada existir → cai para os flat-files JSON atuais (comportamento idêntico ao de hoje).
   4. DUAL-WRITE ligado por padrão: toda escrita vai ao SQLite E espelha o JSON.
      → rollback = apagar h2bapply.db e reiniciar. Nada se perde.
   5. Migração automática na 1ª execução: importa os JSONs existentes para o banco.

   MODELO: 1 tabela chave-valor (collection → blob JSON), preservando a semântica
   atual de persist(arquivo, objetoInteiro). Ganhos imediatos: arquivo único,
   WAL (leitura não bloqueia escrita), transação atômica (fim do risco de JSON
   truncado em queda de energia), e caminho aberto para granularizar depois.

   ENV:
     STORAGE=json    → força modo antigo (desativa SQLite)
     STORAGE_MIRROR=off → desliga o espelho JSON (só depois de semanas estável!)
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

let _db = null;
let _mode = "json";              // "sqlite-node" | "sqlite-better" | "json"
const MIRROR = (process.env.STORAGE_MIRROR || "on") !== "off";
const FORCE_JSON = (process.env.STORAGE || "").toLowerCase() === "json";

let _stmtGet = null, _stmtSet = null;

function initStorage(dataDir){
  if (FORCE_JSON) { console.log("[storage] Modo JSON forçado via STORAGE=json"); return { mode:_mode }; }
  const dbPath = path.join(dataDir, "h2bapply.db");
  // 1) node:sqlite (nativo, Node >= 22.5)
  try {
    const { DatabaseSync } = require("node:sqlite");
    _db = new DatabaseSync(dbPath);
    _mode = "sqlite-node";
  } catch(e1) {
    // 2) better-sqlite3 (opcional)
    try {
      const Database = require("better-sqlite3");
      _db = new Database(dbPath);
      _mode = "sqlite-better";
    } catch(e2) {
      console.log("[storage] SQLite indisponível (node:sqlite e better-sqlite3) — usando flat-file JSON (modo atual).");
      return { mode:_mode };
    }
  }
  try {
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA synchronous=NORMAL");
    _db.exec(`CREATE TABLE IF NOT EXISTS kv (
      collection TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    _stmtGet = _db.prepare("SELECT data FROM kv WHERE collection = ?");
    _stmtSet = _db.prepare(`INSERT INTO kv (collection, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(collection) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
    console.log(`[storage] 💾 SQLite ativo (${_mode}) em ${dbPath} · espelho JSON: ${MIRROR?"ON":"OFF"}`);
  } catch(e) {
    console.warn("[storage] Falha ao preparar SQLite — fallback JSON:", e.message);
    _db = null; _mode = "json";
  }
  return { mode:_mode };
}

const collectionOf = file => path.basename(file); // ex: users.json

// ── LOAD: SQLite primeiro; se a collection não existe, migra do JSON ────────
function storageLoad(file, def){
  if (_db) {
    try {
      const row = _stmtGet.get(collectionOf(file));
      if (row && row.data !== undefined) return JSON.parse(row.data);
      // Migração automática 1ª vez: importa o JSON existente
      try {
        const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
        _stmtSet.run(collectionOf(file), JSON.stringify(legacy), new Date().toISOString());
        console.log(`[storage] ⬆️  Migrado ${collectionOf(file)} → SQLite (${Array.isArray(legacy)?legacy.length+" itens":"objeto"})`);
        return legacy;
      } catch { return def; }
    } catch(e) {
      console.warn(`[storage] load(${collectionOf(file)}) falhou no SQLite — usando JSON:`, e.message);
    }
  }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}

// ── PERSIST: SQLite (atômico) + espelho JSON opcional (mesmo tmp+rename atual)
// Retorna true se os dados FICARAM salvos em pelo menos um lugar (SQLite ou
// JSON), false se as duas formas falharam — pra quem chama poder avisar o
// usuário em vez de responder "salvo" com a escrita tendo falhado de verdade.
function storagePersist(file, data){
  const _t0 = Date.now(); // DIAGNÓSTICO (2026-07-09): ver comentário em /api/send no server.js
  const payload = JSON.stringify(data);
  let sqliteOk = false;
  if (_db) {
    try { _stmtSet.run(collectionOf(file), payload, new Date().toISOString()); sqliteOk = true; }
    catch(e){ console.warn(`[storage] persist(${collectionOf(file)}) falhou no SQLite:`, e.message); }
  }
  const _finish = (ok) => {
    const _ms = Date.now() - _t0;
    if (_ms > 800) console.warn(`[storage-timing] ⚠️ persist(${collectionOf(file)}) demorou ${_ms}ms (${(payload.length/1024).toFixed(0)}KB, sqlite=${sqliteOk})`);
    return ok;
  };
  if (!_db || MIRROR || !sqliteOk) {
    // Escrita JSON idêntica à original (3 tentativas, tmp+rename)
    for (let attempt=0; attempt<3; attempt++){
      try { const t=file+".tmp"; fs.writeFileSync(t, JSON.stringify(data,null,2), "utf8"); fs.renameSync(t,file); return _finish(true); }
      catch(e){
        if (attempt===2){
          try { fs.writeFileSync(file, JSON.stringify(data,null,2)); return _finish(true); }
          catch(e2){ if(!sqliteOk){ console.error("[storage] FALHA total persist:", e2.message); return _finish(false); } }
        }
      }
    }
  }
  return _finish(sqliteOk);
}

// ── Diagnóstico para o painel admin ─────────────────────────────────────────
function storageInfo(){
  const info = { mode:_mode, mirror:MIRROR, collections:[] };
  if (_db) {
    try {
      const rows = _db.prepare("SELECT collection, length(data) AS bytes, updated_at FROM kv ORDER BY collection").all();
      info.collections = rows;
    } catch{}
  }
  return info;
}

module.exports = { initStorage, storageLoad, storagePersist, storageInfo };
