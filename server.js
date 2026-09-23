// ═══════════════════════════════════════════════════════════
//  H2BApply v13.1 — Motor de envio automático profissional
//  [REESTRUTURADO: calcStreak/last7Days movidas para escopo global;
//   flushAll completo no shutdown]
//
//  PLANOS: a tabela ÚNICA vive em mod-config.js (PLAN_LIMITS_NEW, com o
//  comentário certo ao lado) e os preços em PLANO_PRECO_TAB. Aqui não mora
//  cópia nenhuma — a que morava dizia "free → 20 manual + 10 auto/dia",
//  o OPOSTO da regra em vigor desde o v172 ("ZERO envio grátis": free é
//  0/0). Comentário com número de plano desatualizado é armadilha: a
//  próxima sessão lê, acredita e "corrige" o código pra bater com ele.
//
//  NOVIDADES v13:
//    • Envio automático STREAMING (começa imediatamente)
//    • Logs completos com status detalhado
//    • Filtros dinâmicos por categoria de serviço
//    • Painel de logs profissional + exportação CSV
//    • Dashboard em tempo real
//    • Recuperação automática após queda
//    • Migração automática de dados antigos
//    • IDs únicos por candidatura (appId) + índice de vinculação
// ═══════════════════════════════════════════════════════════
"use strict";
const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const fsp    = require("fs").promises; // v191 LOTE 9: cópia de backup sem travar o event loop
const path   = require("path");
const crypto = require("crypto");
const util   = require("util");
const { URLSearchParams } = require("url");
const zlib = require("zlib");

// ═══ V951 (Parte 1 do plano 10/10): COMPRESSÃO HTTP + ETag ═══════════════
// index.html tem ~1,18MB e era servido CRU com no-cache → ~1,2MB por visita
// no 4G. Agora: brotli/gzip (cai para ~180-250KB) + ETag (revalidação vira
// 304 sem corpo). Compressão roda UMA vez por arquivo/mtime e fica em cache
// de memória — custo por request é zero.
const _assetCache = {}; // { file: { mtime, raw, gz, br, etag } }
// v34-GA: ID do Google Analytics em UM lugar só. Os HTMLs carregam o
// placeholder G-XXXXXXXXXX; se GA_MEASUREMENT_ID estiver no ambiente
// (Render), o servidor troca na hora de servir — analytics liga em TODAS as
// páginas de uma vez, sem tocar em arquivo. Sem a env, tudo fica como era.
const GA_MEASUREMENT_ID = String(process.env.GA_MEASUREMENT_ID || "").trim();
function _injectGaId(raw){
  if (!GA_MEASUREMENT_ID || !/^G-[A-Z0-9]{4,}$/i.test(GA_MEASUREMENT_ID)) return raw;
  const txt = raw.toString("utf8");
  if (!txt.includes("G-XXXXXXXXXX")) return raw;
  return Buffer.from(txt.split("G-XXXXXXXXXX").join(GA_MEASUREMENT_ID), "utf8");
}
function getStaticAsset(file){
  const fp = path.join(__dirname, file);
  const st = fs.statSync(fp);
  const c = _assetCache[file];
  if (c && c.mtime === st.mtimeMs) return c;
  const raw = _injectGaId(fs.readFileSync(fp));
  const entry = {
    mtime: st.mtimeMs,
    raw,
    gz: zlib.gzipSync(raw, { level: 6 }),
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    etag: '"' + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20) + '"'
  };
  _assetCache[file] = entry;
  return entry;
}
function sendAsset(req, res, file, ctype, cacheControl){
  let a;
  try { a = getStaticAsset(file); }
  catch { res.writeHead(404); return res.end(file + " não encontrado"); }
  if (req.headers["if-none-match"] === a.etag) {
    res.writeHead(304, { ETag: a.etag, "Cache-Control": cacheControl || "no-cache", Vary: "Accept-Encoding" });
    return res.end();
  }
  const ae = String(req.headers["accept-encoding"] || "");
  const h = { "Content-Type": ctype, "Cache-Control": cacheControl || "no-cache", ETag: a.etag, Vary: "Accept-Encoding" };
  let body = a.raw;
  if (/\bbr\b/.test(ae))        { h["Content-Encoding"] = "br";   body = a.br; }
  else if (/\bgzip\b/.test(ae)) { h["Content-Encoding"] = "gzip"; body = a.gz; }
  h["Content-Length"] = body.length;
  res.writeHead(200, h);
  return res.end(body);
}
// v18-PERF: as páginas dinâmicas de SEO programático (/vagas-h2b/:estado e
// /vagas-h2b/categoria/:categoria) geram HTML novo por requisição (dados
// mudam a cada boot), então não dá pra usar o cache de getStaticAsset (que é
// por arquivo+mtime) — mas ainda merecem br/gzip: são ~25-35KB de HTML puro,
// e comprimir na hora custa poucos ms e economiza ~75% de banda no 4G do
// usuário, igual já é feito pros arquivos estáticos. Sem ETag aqui de
// propósito (conteúdo é barato de gerar de novo; Cache-Control já cobre).
function sendHtmlCompressed(req, res, html, cacheControl){
  const raw = Buffer.from(html, "utf8");
  const ae = String(req.headers["accept-encoding"] || "");
  const h = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cacheControl || "public, max-age=1800", Vary: "Accept-Encoding" };
  let body = raw, enc = null;
  try {
    if (/\bbr\b/.test(ae)) { body = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }); enc = "br"; }
    else if (/\bgzip\b/.test(ae)) { body = zlib.gzipSync(raw, { level: 6 }); enc = "gzip"; }
  } catch(e) { body = raw; enc = null; } // qualquer erro de compressão → cai pro HTML cru, nunca quebra a resposta
  if (enc) h["Content-Encoding"] = enc;
  h["Content-Length"] = body.length;
  res.writeHead(200, h);
  return res.end(body);
}
// ══════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────
const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const APP_URL       = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
// ── v72 — SÓ-ENVIO PERMANENTE E UNIVERSAL (ordem do dono, 26/07/2026) ──────
// Antes era um toggle por servidor (GMAIL_SEND_ONLY=1, só no Servidor 3).
// Agora é a arquitetura DEFINITIVA dos 3: o app pede ao Google SOMENTE o
// escopo gmail.send — nunca readonly, nunca modify. Ele NUNCA lê, abre ou
// guarda a caixa de entrada de ninguém; só manda a candidatura que o
// próprio usuário escreveu. A aba Respostas foi removida do site (v72) —
// não existe mais em nenhum servidor. GMAIL_SEND_ONLY permanece como
// nome interno (usado em ~15 pontos do código) só por compatibilidade —
// não é mais configurável por env; é sempre true.
const GMAIL_SEND_ONLY = true;
const OAUTH_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.send";
console.log("[oauth] ✉️ Modo só-envio (permanente, v72): escopo único gmail.send — nunca lê caixa de entrada. Aba Respostas removida.");
// v172c (ORDEM DO DONO, 12/09/2026): login do site virou usuário+senha
// (/api/login, /api/cadastro) — SEM Google nenhum. Só CONECTAR O GMAIL PRA
// ENVIAR (escopo sensível gmail.send, gated por plano pago ativo —
// isVipActive) ainda fala com o Google, via /oauth/connect-send/
// /oauth/add-sender, pedindo OAUTH_SCOPES completo.
const REDIRECT_URI        = APP_URL + "/oauth/callback";
const REDIRECT_URI_SENDER = APP_URL + "/oauth/add-sender/callback";

// ── v61: redirect_uri pelo HOST da requisição (com allowlist) ──────────────
// BUG REAL (25/07, prints do dono): login do Servidor 3 travava "pra sempre"
// na volta do Google — a env APP_URL apontava pra applyh2b.com (DNS ainda no
// parking da Namecheap, endereço morto) e o Google devolvia o usuário pra lá,
// mesmo quem entrou pelo h2b-server-3.onrender.com. Raiz: o redirect_uri era
// SEMPRE o APP_URL, ignorando por qual endereço a pessoa estava navegando.
// Agora o servidor monta o redirect_uri pelo host da requisição, DESDE QUE
// seja um host confiável: o do APP_URL, o RENDER_EXTERNAL_URL (o Render
// define sozinho em todo serviço) ou um host da lista de servidores (+www).
// Host desconhecido cai no APP_URL (comportamento antigo) — nunca se confia
// cegamente no header Host (anti open-redirect/host-poisoning). O start e o
// callback acontecem no MESMO host (o Google devolve exatamente pra onde o
// start apontou), então derivar de novo no callback dá o valor idêntico que
// a troca do code exige. Lembrete operacional: cada host usado precisa estar
// nos Authorized redirect URIs do Google Console (…/oauth/callback).
//
// 🚨 v239 (achado real, 20/09/2026 — Andrio testando "Conectar Gmail" como
// usuário comum pelo domínio oficial): h2bapply.com virou o domínio custom
// deste ambiente (v238 — DNS migrado em 19-20/09), mas NUNCA entrou nesta
// allowlist. O Render NUNCA muda RENDER_EXTERNAL_URL/_HOSTNAME quando um
// domínio próprio é anexado (continuam sempre o *.onrender.com do serviço),
// e a env APP_URL no painel do Render seguiu apontando pro *.onrender.com de
// antes da migração — ninguém tinha atualizado ela. Resultado: quem navegava
// h2bapply.com iniciava o OAuth, `_oauthBase` não reconhecia o host e caía
// no FALLBACK (APP_URL = h2bapply-2026.onrender.com); o Google devolvia a
// pessoa pra esse domínio DIFERENTE de onde os cookies de sessão
// (h2b_session) e de handshake (h2b_of, v237u) tinham sido gravados —
// nenhum cookie bate lá, então "Sessão inválida ou expirada" acontecia com
// TODO usuário tentando conectar o Gmail pelo domínio oficial, quebrando o
// fluxo principal de Envio Automático/Manual pra quem loga em h2bapply.com.
// Corrigido hardcodeando o domínio oficial aqui — nunca dependendo só de uma
// env configurada certa no painel do Render (a MESMA classe de fragilidade
// que já causou o bug original do v61) — mesmo padrão das ~30 URLs
// canônicas fixas já espalhadas pelo SEO deste arquivo (robots.txt/sitemap/
// JSON-LD, sempre "https://h2bapply.com"). Continua host allowlist (nunca
// confia cegamente no header Host). ⚠️ Operacional: se um dia existir
// www.h2bapply.com de verdade, adicionar aqui TAMBÉM exige adicionar
// "https://www.h2bapply.com/oauth/callback" nos Authorized redirect URIs do
// Google Console — sem isso o Google recusa com redirect_uri_mismatch.
const CANONICAL_OAUTH_HOSTS = ["h2bapply.com"];
function _oauthBase(req){
  try{
    const host=String((req.headers&&req.headers.host)||"").toLowerCase().split(",")[0].trim();
    if(!host) return APP_URL;
    const norm=x=>{try{return new URL(x).host.toLowerCase();}catch(e){return "";}};
    const ok=new Set([norm(APP_URL),...CANONICAL_OAUTH_HOSTS]);
    if(process.env.RENDER_EXTERNAL_URL) ok.add(norm(process.env.RENDER_EXTERNAL_URL));
    // Cinto e suspensório: o Render também define RENDER_EXTERNAL_HOSTNAME
    // (só o host, sem protocolo) — cobre o caso de a _URL vir vazia/mudada.
    if(process.env.RENDER_EXTERNAL_HOSTNAME) ok.add(String(process.env.RENDER_EXTERNAL_HOSTNAME).toLowerCase().trim());
    ok.delete("");
    if(!ok.has(host)) return APP_URL;
    const proto=(host.startsWith("localhost")||host.startsWith("127."))?"http":"https";
    return proto+"://"+host;
  }catch(e){ return APP_URL; }
}
// ── Fase 1 · Módulo 1: configuração extraída para src/config.js ──────────
const { MAX_SENDER_EMAILS_FREE, MAX_SENDER_EMAILS_VIP, MAX_SENDER_EMAILS_DOUBLEPRO, MAX_SENDER_EMAILS_ADMIN,
        ADMIN_AUTO_DAILY_LIMIT_PER_SENDER,
        MAX_RESUMES, MAX_COVERS,
        ADMIN_EMAIL, ADMIN_EMAIL_2, ADMIN_EMAILS_EXTRA, ADMIN_EMAILS, isAdminEmail,
        TEST_ACCOUNT_EMAIL, isTestAccountEmail, naoEhReceita,
        PUSH_ENABLED,
        PLAN_LIMITS, PLAN_LIMITS_NEW, NOME_PLANO_PUBLICO } = require("./mod-config.js");
// 🏷️ v218 — nome público de um plano em texto (log/extrato/nota), nunca a
// chave interna crua (era "Plano VIPRO" — não faz sentido pra quem paga).
// Chave desconhecida cai no próprio nome maiúsculo — nunca quebra.
const nomePlanoDisplay = (k) => NOME_PLANO_PUBLICO[String(k || "").toLowerCase()] || String(k || "").toUpperCase() || "?";
// 🔐 SENHA — helpers compartilhados (painel admin E cadastro de usuário
// comum, ambos por usuário+senha agora). scrypt (memory-hard) com salt
// próprio por conta; nunca texto puro persistido em lugar nenhum.
// 🚨 v172c-SEC (auditoria de segurança, 12/09/2026): scryptSync é SÍNCRONO —
// bloqueia o event loop ÚNICO do Node inteiro (site inteiro pra TODO MUNDO:
// outros usuários, o robô automático, o admin) pela duração inteira do
// cálculo. Como as 3 rotas novas (/api/cadastro, /api/login, /api/admin-
// panel/login) são públicas e SEM autenticação, uma rajada de poucas
// dezenas de requisições simultâneas já travava o site inteiro por
// segundos — exatamente a classe de bug que este mesmo repo já corrigiu
// antes (v162 "sort=match travava tudo"). crypto.scrypt (assíncrono) roda
// no threadpool do libuv, nunca no event loop principal.
const _scryptAsync = util.promisify(crypto.scrypt);
async function _hashPw(senha,saltHex){
  const salt=saltHex||crypto.randomBytes(16).toString("hex");
  const buf=await _scryptAsync(senha,salt,64);
  return { salt, hash: buf.toString("hex") };
}
async function _verifyPw(senha,saltHex,hashHex){
  if(!senha||!saltHex||!hashHex)return false;
  try{
    const buf=await _scryptAsync(senha,saltHex,64);
    return crypto.timingSafeEqual(buf, Buffer.from(hashHex,"hex"));
  }catch(e){ return false; }
}
// 🔐 LOGIN DO PAINEL ADMIN (ordem do dono, 12/09/2026): só Andrio e Diego,
// por usuário+senha — nada de Google nessa porta específica. Senha NUNCA
// em texto puro aqui: scrypt (memory-hard) com salt próprio. Trocar a
// senha depois não precisa mexer no código — defina ADMIN_PANEL_PASS_ANDRIO
// ou ADMIN_PANEL_PASS_DIEGO (texto puro, só no .env, nunca commitado) que
// o boot recalcula o hash sozinho; sem a env, usa o hash de fábrica abaixo.
// 🚨 v172c-SEC (auditoria de segurança, 12/09/2026 — CVE interno CRÍTICO):
// o par salt/hash de fábrica ORIGINAL deste bloco (commit a860ebc) tinha a
// senha em TEXTO PURO exposta na própria mensagem do commit
// ("andrio/andrioapplyh2b, diego/diegoapplyh2b") — com este repo PÚBLICO no
// GitHub, qualquer pessoa lendo o histórico tinha login de admin completo,
// sem precisar quebrar hash nenhum. Substituído por senhas ALEATÓRIAS de
// alta entropia (24 caracteres, geradas fora deste chat/commit) cujo hash
// aqui embaixo NUNCA teve o texto puro escrito em lugar nenhum do
// repositório — só o hash é público, e scrypt com entropia alta resiste a
// isso. AS SENHAS NOVAS FORAM ENTREGUES AO DONO FORA DO GIT. Ainda assim:
// PROIBIDO functionar como senha permanente — configure
// ADMIN_PANEL_PASS_ANDRIO/_DIEGO de verdade no ambiente (Render → env vars,
// nunca no código) assim que possível; o aviso no boot abaixo lembra disso
// toda vez que sobe sem a env definida.
const ADMIN_PANEL_LOGINS = [
  { user:"andrio", nome:"Andrio", email:ADMIN_EMAIL,
    salt:"5f673a0c82508a78a7edce9e7d612aaf",
    hash:"9a6339c189bc3bf05d327d56c3f6b9cff3c70ff8562d6f78cdc9e932ed81ce6f85dc9a9d90e6b9b6d83381e8febe8f3658ec13dcf721f3bb2d94975f59a0727f" },
  { user:"diego", nome:"Diego", email:ADMIN_EMAIL_2,
    salt:"7c4b2200cdec635426a9ce64bcb31a8b",
    hash:"51d387f761bc0a5b7274dd89dc73df98b50025613f80bf02b1b1d01c317eadc73bc33627619f0d15448adddbb2f9121a29fe348f319a30f5fe3c31118ae84a55" },
].map(l=>{
  const envKey="ADMIN_PANEL_PASS_"+l.user.toUpperCase();
  if(!process.env[envKey]){
    // 🚨 v172c-SEC: sem a env, cai no hash de fábrica acima — funcional
    // (senha de alta entropia, nunca exposta no repo), mas é um segredo
    // ÚNICO e FIXO pra sempre até alguém configurar a env de verdade.
    // Aviso alto no log a cada boot (mesmo padrão do DATA_ENC_KEY abaixo).
    console.warn(`[SEGURANÇA] ⚠️ ${envKey} não definida — login do painel admin de "${l.user}" está usando a senha de FÁBRICA (fixa, nunca rotaciona sozinha). Configure ${envKey} no ambiente (Render → Environment) assim que possível.`);
    return l;
  }
  // Só aqui (boot, roda 2x no total — nunca por requisição de usuário) o
  // scryptSync SÍNCRONO é seguro; _hashPw virou assíncrono (ver acima) e
  // não dá pra usar dentro de um .map() síncrono no carregamento do módulo.
  const salt=crypto.randomBytes(16).toString("hex");
  const hash=crypto.scryptSync(process.env[envKey],salt,64).toString("hex");
  return {...l,salt,hash};
});
// getMaxSenders retorna o TOTAL de emails de envio (principal + extras).
// 📧 ORDEM DO DONO (13/09/2026): grátis 0 · VIP/VIPro 1 · DoublePro 2 · admin 6.
// Trial e cortesia (vip.source 'trial'/'code') contam como SEM plano pago;
// plano expirado também (isVipActive é checado em tempo real).
const getMaxSenders = (u) => {
  if(u?.isAdmin || isAdminEmail(u?.email||"")) return MAX_SENDER_EMAILS_ADMIN;
  const src = (u?.vip?.source||"").toLowerCase();
  const isPaidActive = isVipActive(u) && src !== 'trial' && src !== 'code';
  if(!isPaidActive) return MAX_SENDER_EMAILS_FREE;
  return getPlan(u)==="doublepro" ? MAX_SENDER_EMAILS_DOUBLEPRO : MAX_SENDER_EMAILS_VIP;
};
// Mensagem única das 3 travas de Gmail extra (add-sender + 2 callbacks) — diz
// o PORQUÊ pelo plano, não um "limite de N" seco.
const _msgLimiteSenders = (max) => max<=0
  ? "Sem plano ativo não dá pra vincular Gmail de envio — assine um plano na aba Planos."
  : max===1
    ? "Gmail extra é exclusivo do plano Máximo (2 e-mails de envio) — seu plano usa só o e-mail principal."
    : `Limite de ${max} e-mails de envio atingido.`;
const PORT          = parseInt(process.env.PORT || "3000", 10);
const IS_PROD       = APP_URL.startsWith("https://");
const CONFIGURED    = !!(CLIENT_ID && CLIENT_SECRET);
const CONFIGURADO_OAUTH = () => CONFIGURED; // v175: usado pela aba Notificações (o painel explica o que falta)

// ── Planos ────────────────────────────────────────────────
// PLAN_LIMITS / PLAN_LIMITS_NEW vivem em mod-config.js — é lá que está a
// tabela com os números de verdade e a explicação de cada um. A cópia que
// existia aqui envelheceu 2 gerações de regra (dizia free 20/10 e vip com
// automático) e contradizia o código logo abaixo; mudar limite de plano é
// mexer NA TABELA, nunca num comentário ou num `if`.
// Intervalos base (substituídos pelo cálculo inteligente)
// (constantes AUTO_INTERVAL_MIN/MAX removidas — o motor usa calcSmartInterval)
// Horário padrão se usuário não configurar
// Horário de envio REMOVIDO: automático roda 24/7 sem janela de horário

// Intervalo de envio: ~7 min (6,5 a 7,5 com jitter — calcSmartInterval).
// Admins podem configurar intervalo menor.
// adminIntervalSecs: número de segundos entre envios (mín 30s para admins)
// calcSmartInterval: corpo em src/engine/core.js (Fase 1 · Módulo 6)
const { createCalcSmartInterval, nowBRT: _nowBRTMod, todayStrBRT: _todayStrBRTMod, toLocaleBRT: _toLocaleBRTMod, warmupCapForSender, diasRestantesCanonico } = require("./mod-engine-core.js");
// 🔒 Integridade de vagas — 1 vaga = 1 ETA Case Number único (KB-076).
// Mesmo módulo usado pelo build-sheets.js standalone, pra nunca divergir a
// regra de dedupe/merge entre o cron oficial e o bot de coleta do admin.
const { dedupeVagas: _vagasDedupe, verifyIntegrity: _vagasVerify, buildManifest: _vagasManifest, mergePreferindo: _vagaMergePreferindo } = require("./mod-vagas-integrity.js");
let _calcSmartIntervalImpl = null;
function calcSmartInterval(email){
  if(!_calcSmartIntervalImpl) _calcSmartIntervalImpl = createCalcSmartInterval({ getUser, isAdminVip }); // lazy: getUser/isAdminVip declarados adiante
  return _calcSmartIntervalImpl(email);
}

// ══════════════════════════════════════════════════════════
//  TIMEZONE BRT — UTC-3 fixo (sem horário de verão no Brasil)
//  Todas as datas/horas do sistema usam BRT consistentemente
// ══════════════════════════════════════════════════════════
function nowBRT(){ return _nowBRTMod(); } // corpo em src/engine/core.js

function todayStrBRT(){ return _todayStrBRTMod(); } // corpo em src/engine/core.js

function toLocaleBRT(ts){ return _toLocaleBRTMod(ts); } // corpo em src/engine/core.js

function toTimeBRT(ts) {
  const d = new Date((ts||Date.now()) - 3*60*60*1000);
  return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
}




// ── Storage ───────────────────────────────────────────────
// REGRA: /data é persistente (volume Docker/Railway). /tmp é volátil e apagado no reinício.
// Tenta garantir que /data exista e seja gravável antes de usá-lo.
(function ensureDataDir() {
  const preferred = process.env.DATA_DIR || "/data";
  try {
    if (!fs.existsSync(preferred)) fs.mkdirSync(preferred, { recursive: true });
    const testFile = require("path").join(preferred, ".write_test");
    fs.writeFileSync(testFile, "ok"); fs.unlinkSync(testFile);
  } catch (e) {
    console.error(`[CRÍTICO] ⚠️  Não foi possível usar ${process.env.DATA_DIR||"/data"} para dados: ${e.message}`);
    console.error("[CRÍTICO] ⚠️  USANDO /tmp — tokens e PDFs serão PERDIDOS no próximo reinício!");
    console.error("[CRÍTICO] ⚠️  Monte um volume persistente em /data ou defina DATA_DIR corretamente.");
  }
})();
const DATA_DIR    = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
// ── 💾 STORAGE ENGINE (Fase 4): SQLite com fallback JSON e dual-write ──────
const { initStorage, storageLoad, storagePersist, storageDelete, storageInfo } = require("./storage.js");
initStorage(DATA_DIR);
const USERS_FILE  = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json"); // KB-078: só guarda OAuth __sender__ em andamento — login NUNCA sobrevive a deploy (de propósito)

// ══ V955: CIFRAGEM EM REPOUSO (AES-256-GCM) ═══════════════════════════════
// Protege refresh_tokens/access_tokens do Gmail gravados em disco (users.json,
// sessions.json e SQLite). Chave: env DATA_ENC_KEY (qualquer string forte).
// Sem a chave definida → comportamento antigo (texto puro) + aviso no boot.
// Formato: "enc1:" + base64(iv[12] | authTag[16] | ciphertext). Retrocompatível:
// valores sem o prefixo passam direto (dados legados continuam funcionando).
const _encKeyRaw = process.env.DATA_ENC_KEY || "";
const _encKey = _encKeyRaw ? crypto.createHash("sha256").update(_encKeyRaw).digest() : null;
if(_encKey)console.log("[crypto] 🔐 Cifragem em repouso ATIVA (AES-256-GCM) — tokens Gmail protegidos no disco");
else console.warn("[crypto] ⚠️  DATA_ENC_KEY não definida — tokens Gmail ficam em TEXTO PURO no disco. Defina no Render para ativar a cifragem (retrocompatível, sem migração).");
function encStr(s){
  if(!_encKey||typeof s!=="string"||!s||s.startsWith("enc1:"))return s;
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv("aes-256-gcm",_encKey,iv);
  const ct=Buffer.concat([c.update(s,"utf8"),c.final()]);
  return "enc1:"+Buffer.concat([iv,c.getAuthTag(),ct]).toString("base64");
}
function decStr(s){
  if(typeof s!=="string"||!s.startsWith("enc1:"))return s; // legado texto puro
  if(!_encKey)return null; // cifrado mas sem chave → trata como ausente (re-login)
  try{
    const raw=Buffer.from(s.slice(5),"base64");
    const iv=raw.subarray(0,12),tag=raw.subarray(12,28),ct=raw.subarray(28);
    const d=crypto.createDecipheriv("aes-256-gcm",_encKey,iv);d.setAuthTag(tag);
    return Buffer.concat([d.update(ct),d.final()]).toString("utf8");
  }catch{return null;} // chave errada/corrompido → ausente, nunca crash
}
// Campos sensíveis do usuário cifrados no disco (cópia rasa — runtime intocado)
// 🚨 v172c-SEC: passwordHash/passwordSalt (scrypt) entraram na mesma cifra
// em disco dos tokens OAuth — defesa extra contra vazamento de backup/disco
// bruto (a senha mínima de 4 caracteres tornaria offline-cracking rápido
// se o arquivo cru vazasse sem essa camada).
const USER_SECRET_FIELDS=["refresh_token","cached_access_token","passwordHash","passwordSalt"];
// v21-SEC: versão SEGURA de um usuário pra mandar pro navegador (admin ou não).
// Remove os segredos de NÍVEL RAIZ e também os tokens OAuth aninhados em
// senderEmails[] (access_token/refresh_token dos Gmails extras) — antes o
// /api/admin/user-detail e o /api/debug/export mandavam esses tokens pro
// browser, onde extensão/console/histórico de rede conseguem ler.
function sanitizeUserForClient(u){
  if(!u)return u;
  // 🚨 v172c-SEC (auditoria de segurança, 12/09/2026 — CRÍTICO real): este
  // sanitizador é da era OAuth e nunca foi atualizado pros campos NOVOS de
  // senha (v172c) — passwordHash/passwordSalt (scrypt) saíam intactos pro
  // navegador em GET /api/debug/export (banco INTEIRO) e /api/admin/user-
  // detail/:email, pra qualquer conta isAdmin:true. Com o limite de senha
  // de só 4 caracteres, isso permitia quebrar offline boa parte das contas.
  const c={...u,password:undefined,refresh_token:undefined,cached_access_token:undefined,passwordHash:undefined,passwordSalt:undefined};
  if(Array.isArray(c.senderEmails))c.senderEmails=c.senderEmails.map(se=>se?{
    email:se.email,label:se.label||"",active:se.active!==false,
    tokenExpired:!!se.tokenExpired,blocked:!!se.blocked,addedAt:se.addedAt,
    reauthedAt:se.reauthedAt,hasRefreshToken:!!se.refresh_token
  }:se);
  if(Array.isArray(c.cvs))c.cvs=c.cvs.map(cv=>{if(cv&&cv.b64){const{b64,...rest}=cv;return rest;}return cv;});
  return c;
}
function _encUsersForDisk(db){
  if(!_encKey)return db;
  const out={};
  for(const[e,u]of Object.entries(db||{})){
    const c={...u};
    for(const f of USER_SECRET_FIELDS)if(typeof c[f]==="string"&&c[f])c[f]=encStr(c[f]);
    if(Array.isArray(c.senderEmails))c.senderEmails=c.senderEmails.map(se=>
      se&&typeof se.refresh_token==="string"?{...se,refresh_token:encStr(se.refresh_token)}:se);
    out[e]=c;
  }
  return out;
}
function _decUsersFromDisk(db){
  for(const u of Object.values(db||{})){
    if(!u)continue;
    for(const f of USER_SECRET_FIELDS)if(typeof u[f]==="string"&&u[f].startsWith("enc1:"))u[f]=decStr(u[f]);
    if(Array.isArray(u.senderEmails))for(const se of u.senderEmails)
      if(se&&typeof se.refresh_token==="string"&&se.refresh_token.startsWith("enc1:"))se.refresh_token=decStr(se.refresh_token);
  }
  return db;
}
const HIST_FILE   = path.join(DATA_DIR, "history.json");
const CVS_DIR     = path.join(DATA_DIR, "cvs");
// 🧾 v192 LOTE 10: comprovantes de pedido saem da RAM e vão pro disco (mesmo
// movimento que o v21 fez com os PDFs de currículo). Antes cada pedido
// carregava o base64 inteiro (até ~8MB) pra sempre dentro de DB_PEDIDOS —
// inclusive de pedido aprovado/cancelado meses atrás — e QUALQUER mudança de
// status reserializava TODOS eles em persistPedidos(), travando o servidor a
// cada clique do admin. O próprio raio-X de memória já apontava isto como
// "candidato nº1 a migrar pra disco com leitura sob demanda".
const COMPROVANTES_DIR = path.join(DATA_DIR, "comprovantes");
const AUTO_FILE   = path.join(DATA_DIR, "auto_jobs.json");
const SENT_FILE   = path.join(DATA_DIR, "sent_emails.json");
const LOGS_FILE   = path.join(DATA_DIR, "auto_logs.json");   // NEW: logs detalhados
const JOURNEY_FILE = path.join(DATA_DIR, "journey.json");       // Jornada do usuário
const ADMIN_SETTINGS_FILE = path.join(DATA_DIR, "admin_settings.json"); // Admin global settings
const REVIEWS_FILE     = path.join(DATA_DIR, "reviews.json");        // Avaliações reais de usuários p/ landing page (moderadas por admin)
const PEDIDOS_FILE     = path.join(DATA_DIR, "pedidos.json");         // Pedidos de plano dos usuários
const FINANCEIRO_FILE  = path.join(DATA_DIR, "financeiro.json");      // Dados financeiros (entradas + gastos)
const BLOCKED_FILE     = path.join(DATA_DIR, "blocked_emails.json");  // Emails banidos permanentemente
const TRIAL_USED_FILE  = path.join(DATA_DIR, "trial_used.json");       // Histórico anti-abuse: phones/IPs que já receberam trial
// V951: cooldowns de notificação (admin+usuário) precisam sobreviver a
// restart/deploy — antes eram objetos só-em-memória (_notifSentAt,
// _pedAlertSent, _authErrNotifiedAt, _refillNotifiedAt) que voltavam a
// {} a cada deploy no Render. Como as varreduras (health-sentinel,
// pendingOrderAlert) disparam poucos minutos após o boot, TODO deploy
// reenviava de novo qualquer notificação "pendente", ignorando o
// cooldown de 12-24h combinado — daí "toda vez que eu faço deploy essas
// notificações aparecem". Persistindo em disco, o cooldown é respeitado
// de verdade entre reinícios do processo.
const NOTIF_COOLDOWN_FILE = path.join(DATA_DIR, "notif_cooldowns.json");
// v166: divergências de contabilidade que o admin já revisou e confirmou
// como OK (ex.: conta de admin com dias de teste sem crédito formal — não
// é bug, é esperado). Chave é uma ASSINATURA dos valores exatos da
// divergência (email + regra + números) — nunca "email X resolvido pra
// sempre": se os números mudarem (nova divergência), volta a alertar.
const DIVERGENCIAS_OK_FILE = path.join(DATA_DIR, "divergencias_ok.json");
let DB_DIVERGENCIAS_OK = {}; // { assinatura → {email,motivo,confirmadoEm,confirmadoPor} }
try { fs.mkdirSync(CVS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(COMPROVANTES_DIR, { recursive: true }); } catch {}

console.log(`[boot] H2BApply v13.0 | ${APP_URL} | ${DATA_DIR}`);
const _diskOk = DATA_DIR !== "/tmp";
console.log(`[boot] Disk: ${_diskOk ? `✅ ${DATA_DIR} (persistente)` : "❌ /tmp (VOLÁTIL — tokens/PDFs serão perdidos no próximo deploy!)"}`);
if (!_diskOk) {
  console.error("══════════════════════════════════════════════════════");
  console.error("  ❌  ATENÇÃO: dados sendo salvos em /tmp (VOLÁTIL)!");
  console.error("  Configure DATA_DIR=/data ou monte um volume em /data");
  console.error("══════════════════════════════════════════════════════");
}

// ══════════════════════════════════════════════════════════
//  BANCO DE DADOS EM MEMÓRIA
// ══════════════════════════════════════════════════════════
let DB_USERS  = {};
let DB_HIST   = {};
let DB_AUTO   = {};
let DB_SENT   = {};   // { userEmail → Set<destEmail> }
let DB_LOGS   = {};   // { userEmail → LogEntry[] }
let DB_JOURNEY = {}; // { userEmail → JourneyEvent[] }
let DB_ADMIN_SETTINGS = { emailNotificationsEnabled: false,
  // v172 (ORDEM DO DONO, 11/09/2026): newUserTrialEnabled/newUserTrialDays/
  // newUserTrialAutoDays/newUserTrialPlan foram REMOVIDOS — trial grátis de
  // usuário novo não existe mais (só quem paga envia). newUserTrialDays/
  // AutoDays/Plan já eram código morto antes disso (a concessão real
  // hardcodeava "1 dia MANUAL apenas", nunca lia esses 3 campos).
  // 💼 MC4-P1 (dono, 28/08/2026): divisão societária do LUCRO — padrão 50/50,
  // editável na seção "Sócios & Acerto" da aba 🧠 (computeSocios usa isto).
  sociosSplit: { andrio: 50, diego: 50 },
}; // v9: trial = 1d VIP Manual apenas (sem auto)
// v57/v171 (ORDEM DO DONO): SER admin continua vindo do e-mail (ADMIN_EMAIL/
// ADMIN_EMAIL_2/isAdminEmail — a rota já exige sessão de admin antes de
// qualquer ação); o que mudou foi COMO se chega numa sessão com esse
// e-mail. v172b (12/09/2026) trocou "logar com esse e-mail no Google" por
// senha própria do painel (/api/admin-panel/login, ADMIN_PANEL_PASS_*
// mais abaixo) — o e-mail continua sendo o dono real da conta/trilha
// financeira, a senha é só a porta de entrada nova.
// O antigo sistema de "senha de editor" (Andrew/Diego, de antes disso
// tudo) foi removido por completo nesta faxina — nenhum fluxo de
// aprovação usava mais, e as senhas padrão de fábrica tinham vazado no
// código público.
// DIEGO_ADMIN_EMAILS: e-mails que contam como "Diego" na trilha/acerto
// financeiro; o resto dos admins conta como "Andrew" (Andrio). Ajustável
// por env sem deploy de código.
const DIEGO_ADMIN_EMAILS = new Set(String(process.env.DIEGO_ADMIN_EMAILS||"jesuscristh22@gmail.com").split(",").map(e=>e.trim().toLowerCase()).filter(Boolean));
function editorFromEmail(email){
  return DIEGO_ADMIN_EMAILS.has(String(email||"").trim().toLowerCase()) ? "diego" : "andrew";
}
// 🔐 v183 LOTE 1 — QUEM APROVOU / DE QUEM É O DINHEIRO.
// Desde o v177-FIX a sessão do painel pode ter como CHAVE INTERNA o USERNAME
// reservado ("andrio"/"diego") em vez do e-mail real — decisão deliberada pra
// nunca existirem 2 contas pro mesmo admin. Só que toda a cadeia de
// ATRIBUIÇÃO entende E-MAIL: editorFromEmail("diego") caía no default
// "andrew" (toda aprovação do Diego virava "Andrew" na trilha) e
// isAdminEmail("diego") é false, então _finDonoDe devolvia "sem dono" e o
// acerto entre sócios perdia o dono de TODA entrada aprovada pelo painel.
// A sessão agora carrega TAMBÉM o e-mail real (admin_email) e este helper é a
// fonte ÚNICA de "qual e-mail representa esta sessão". Sessão antiga (gravada
// antes deste commit) e sessão de usuário comum caem no fallback — mesmo
// comportamento de sempre.
function _sessAdminEmail(s){ return String((s&&(s.admin_email||s.user_email))||""); }
// Nome humano do admin da sessão pro extrato de créditos (dadoPor). Estava
// repetido em 3 rotas (set-plan / vip-activate / set-expiry) já lendo o
// s.user_email errado — agora é uma régua só, pelo e-mail real da sessão.
function _sessAdminNome(s){
  const em=_sessAdminEmail(s);
  if(isAdminEmail(em)&&em===ADMIN_EMAIL)return "Andrio";
  if(ADMIN_EMAIL_2&&em===ADMIN_EMAIL_2)return "Diego";
  return em;
}
// Notifications: { notifications: [{id, title, body, createdAt, createdBy, readBy:[email,...]}] }
let DB_REVIEWS = []; // Array de avaliações reais de usuários {id,text,rating,displayName,location,email,plan,status,createdAt}
let DB_PEDIDOS     = []; // Array de pedidos de plano
let DB_FINANCEIRO  = {pagamentos:[],gastos:[]};  // Dados financeiros persistentes
// ── AUDITORIA DE AÇÕES DO ADMIN (v19, dono 15/07/2026) ──────────────────────
// Toda mutação de plano/VIP feita pelo painel fica registrada com snapshot
// ANTES/DEPOIS — e as reversíveis podem ser desfeitas em 1 clique ("adm fez
// cagada tem reversão?"). Append-only, persistido em disco.
const ADMIN_AUDIT_FILE = path.join(DATA_DIR, "admin_audit.json");
let DB_ADMIN_AUDIT = [];
function logAdminAction(admin, action, targetEmail, before, after, detail){
  try{
    const entry={
      id:"aud_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,7),
      ts:Date.now(), admin:String(admin||"?"), action:String(action||"?"),
      targetEmail:String(targetEmail||""), detail:String(detail||"").slice(0,300),
      before:before?JSON.parse(JSON.stringify(before)):null,
      after:after?JSON.parse(JSON.stringify(after)):null,
      reverted:false
    };
    DB_ADMIN_AUDIT.unshift(entry);
    if(DB_ADMIN_AUDIT.length>2000)DB_ADMIN_AUDIT.length=2000;
    persist(ADMIN_AUDIT_FILE,DB_ADMIN_AUDIT);
    return entry.id;
  }catch(e){console.warn("[audit]",e.message);return null;}
}
// 💳 v141 (caso Cleiton — dois usuários com mais dias de plano do que
// pagaram): detector que teria achado isso na hora, sem esperar o dono
// perceber por acaso. Varre DB_ADMIN_AUDIT procurando 2+ concessões de dias
// (set_plan/vip_activate) pro MESMO usuário numa janela curta — o padrão
// exato de "admin clicou e clicou de novo achando que não tinha ido".
// Não usa "dias pagos vs dias no vip" como comparação direta porque ativação
// manual LEGÍTIMA sem pedido formal é rotina desta casa (regra 6c/13b) —
// compararia sempre "divergente" e gritaria lobo falso. Isto aqui, não:
// duas concessões em poucos minutos pro mesmo e-mail é sinal específico.
function detectarConcessoesDuplicadas(janelaMin){
  const JAN=(janelaMin||15)*60_000;
  const porEmail={};
  for(const a of DB_ADMIN_AUDIT){
    if(!["set_plan","vip_activate"].includes(a.action)||!a.targetEmail)continue;
    (porEmail[a.targetEmail]=porEmail[a.targetEmail]||[]).push(a);
  }
  const achados=[];
  for(const [email,acts] of Object.entries(porEmail)){
    if(acts.length<2)continue;
    acts.sort((x,y)=>x.ts-y.ts);
    for(let i=1;i<acts.length;i++){
      const gap=acts[i].ts-acts[i-1].ts;
      if(gap>JAN)continue;
      // v79 (Diego, real): VipPro→DoublePro no mesmo usuário em segundos é
      // upgrade LEGÍTIMO, não clique duplo — só conta como duplicata quando
      // as duas concessões terminam no MESMO plano (o sinal de "clicou 2x
      // achando que não foi", não de escalada proposital).
      const p1=acts[i-1].after?.plan,p2=acts[i].after?.plan;
      if(p1&&p2&&p1!==p2)continue;
      if(acts[i-1].reverted||acts[i].reverted)continue; // já corrigido, não repete alarme
      achados.push({email,gapMin:Math.round(gap/60000),
        a1:{id:acts[i-1].id,ts:acts[i-1].ts,action:acts[i-1].action,admin:acts[i-1].admin,detail:acts[i-1].detail,reverted:acts[i-1].reverted},
        a2:{id:acts[i].id,ts:acts[i].ts,action:acts[i].action,admin:acts[i].admin,detail:acts[i].detail,reverted:acts[i].reverted}});
    }
  }
  return achados;
}
// Snapshot mínimo e suficiente pra reverter plano/VIP de um usuário
function _vipSnapshot(u){
  if(!u)return null;
  return {plan:u.plan||"free", vip:u.vip?JSON.parse(JSON.stringify(u.vip)):null};
}
// ── Tabela oficial de preços (plano→dias→R$) ──────────────────────────────
// v18-FIX: hoisted pra fora do pré-check de comprovante (onde vivia sozinha)
// pra poder ser reaproveitada também na ATIVAÇÃO do pedido — antes, os "dias"
// creditados vinham direto de pd.dias (valor que o CLIENTE mandou na criação
// do pedido, só limitado a um intervalo [1,3650]), nunca conferido contra
// esta tabela. Um cliente podia mandar {plano:"vip",dias:3650} e, se o editor
// aprovasse sem reparar no alerta do Gemini, o sistema creditava 10 anos de
// VIP. Preços em R$ — mudar aqui exige avisar o Andrio antes (dinheiro real).
// v218 (ORDEM DO DONO, 20/09/2026): reestruturação de Planos — só 30 e 60
// dias (90/365 saíram; nada usa esses prazos fora desta tabela — a coleta
// manual do admin manda valorTotal explícito). 60 dias vem com desconto pra
// incentivar o plano mais longo: Manual economiza R$30, Turbo R$60, Máximo R$100.
const PLANO_PRECO_TAB={vip:{30:150,60:270},vipro:{30:300,60:540},doublepro:{30:500,60:900}};

// 🚧 INTERRUPTOR DE EMERGÊNCIA — compra nova (dono, 19/09/2026, ATUALIZADO no
// mesmo dia: "h2bapply.com agora aponta pra este ambiente DE VERDADE"). Nasceu
// como bloqueio enquanto este ambiente ainda NÃO era o domínio oficial — essa
// premissa morreu: o domínio já foi migrado pro DNS deste ambiente, então
// tráfego REAL de h2bapply.com cai aqui agora. Continuar bloqueando por
// padrão derrubaria assinatura nova de cliente de verdade (prioridade #2 da
// casa) sem motivo nenhum. Virou interruptor de emergência: default LIGADO
// (compra funciona normal, sem mudança nenhuma pro usuário) — só desliga com
// env explícita, pra um freeze futuro de verdade (ex.: nova migração). Admin
// (Regularizar/retroativo) nunca é afetado, congelado ou não.
const NEW_PURCHASES_BLOCKED = process.env.BLOCK_NEW_PURCHASES === "true";

// ══════════════════════════════════════════════════════════════════════════
// 💰 CONTABILIDADE CANÔNICA — UMA função, UM número (dono, 15/07/2026)
// O painel mostrava 4 receitas diferentes pro MESMO caixa:
//   • Painel Financeiro (topo):  R$ 3.750  (/api/admin/financeiro — livro-caixa cru)
//   • Indicadores essenciais:    R$ 3.585  (/api/admin/fin-insights — com correção de pedido)
//   • Aba Pagantes:              R$ 1.250/mês (soma crua de TODOS os pagamentos, sem regra)
//   • Aba Pedidos de Plano:      R$ 3.850  (soma de pedidos pagos/ativos — não é caixa)
// Quatro fórmulas = quatro verdades = zero confiança. Agora TODAS as telas
// chamam esta função. Regras únicas:
//   1. Fonte por pagante (sem dupla contagem): livro-caixa → pedido pago/ativo → paymentAmount.
//   2. RAIZ ÚNICA DE VALOR: se a entrada do livro-caixa aponta pra um pedido
//      (pedidoId) e o pedido foi CORRIGIDO depois, o valor do pedido vence.
//   3. source 'code'/'trial' NUNCA é receita nem pagante.
//   4. Entradas avulsas (sem usuário) entram na receita como categoria própria.
// ══════════════════════════════════════════════════════════════════════════
function computeFinanceCanonico(){
  const now=Date.now();
  const pv=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
  const ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
  const PRICE={vip:100,pro:150,vipro:150,doublepro:250};
  const finBy={},pedBy={};
  const _pedById={};for(const ped of (DB_PEDIDOS||[])){if(ped&&ped.id)_pedById[ped.id]=ped;}
  for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){
    if(!pg||!pg.email)continue;const e=String(pg.email).toLowerCase();
    // 💼 MC5-P3 (auditoria 29/08): a régua canônica agora exclui ADMIN
    // (dinheiro de teste nunca é receita — v53) e lançamento ANULADO/AJUSTE
    // (o par ±0 do AJUSTE do cérebro; antes o negativo era descartado e o
    // anulado seguia somando — receita fantasma).
    if(naoEhReceita(e))continue;
    if(pg.anuladoPor||pg.tipo==="ajuste")continue;
    let v=pv(pg.valor);
    const _ped=pg.pedidoId?_pedById[pg.pedidoId]:null;
    if(_ped&&pv(_ped.valorTotal)>0&&pv(_ped.valorTotal)!==v)v=pv(_ped.valorTotal);
    (finBy[e]=finBy[e]||[]).push({valor:v,date:ts(pg.dataPagamento)||ts(pg.data)||pg.criadoEm||0});
  }
  for(const ped of Object.values(DB_PEDIDOS||{})){
    if(!ped||!ped.userEmail)continue;const st=String(ped.status||"").toLowerCase();
    if(st!=="pago"&&st!=="ativo")continue;const e=String(ped.userEmail).toLowerCase();
    if(_pedidoNaoEhReceita(ped))continue; // 💼 MC5-P3 + 🎬 v237v-FIX: admin/teste nunca é receita (pelo isTeste do pedido, nunca pela chave crua)
    (pedBy[e]=pedBy[e]||[]).push({valor:pv(ped.valorTotal),date:ts(ped.ativadoEm)||ts(ped.pagoEm)||0});
  }
  const ms=new Date();ms.setDate(1);ms.setHours(0,0,0,0);const monthStart=ms.getTime();
  let receitaTotal=0,receitaMes=0,qtdPagantes=0,novosMes=0,vencendo7=0,vencendo7Valor=0,vencidos=0,trials=0,gift=0,giftDias=0;
  const porPlano={vip:0,vipro:0,doublepro:0,pro:0}, porPlanoQtd={vip:0,vipro:0,doublepro:0,pro:0};
  const topPagantes=[];
  for(const u of Object.values(DB_USERS||{})){
    if(!u||!u.email)continue;const elc=u.email.toLowerCase();const vip=u.vip||{};const src=String(vip.source||"").toLowerCase();
    if(_usuarioNaoEhReceita(elc,u))continue; // 💼 MC5-P3 + 🎬 v237v-FIX: admin/teste nunca é receita/pagante (confere emailContato, não a chave de login)
    if(src==="trial"){ if(isVipActive(u)) trials++; continue; }
    if(src==="code"){ gift++; giftDias+=(vip.days||0); continue; }
    let pags=finBy[elc]||[];if(!pags.length)pags=pedBy[elc]||[];if(!pags.length&&u.paymentAmount)pags=[{valor:pv(u.paymentAmount),date:ts(vip.activatedAt)||0}];
    pags=pags.filter(x=>x.valor>0);
    const everPaid=(src===""||src==="admin"||src==="pago"||src==="payment")&&((vip.manualExpires||0)>0||(vip.autoExpires||0)>0||vip.activatedAt);
    if(!pags.length&&!everPaid)continue;
    const tot=pags.reduce((a,x)=>a+x.valor,0);
    if(tot>0){qtdPagantes++;topPagantes.push({nome:u.name||u.email,email:u.email,valor:tot,plano:vip.plan||getPlan(u)});}
    receitaTotal+=tot;
    const firstDate=pags.length?Math.min(...pags.map(x=>x.date||now)):(ts(vip.activatedAt)||0);
    if(firstDate>=monthStart) novosMes++;
    for(const x of pags){if((x.date||0)>=monthStart)receitaMes+=x.valor;}
    const plan=vip.plan||getPlan(u); if(porPlano[plan]!==undefined){porPlano[plan]+=tot;porPlanoQtd[plan]++;}
    const nextExp=Math.max(vip.manualExpires||0,vip.autoExpires||0);
    if(nextExp>0){const dleft=diasRestantesCanonico(nextExp,now); if(dleft<=0)vencidos++; else if(dleft<=7){vencendo7++;vencendo7Valor+=(PRICE[plan]||100);}}
  }
  topPagantes.sort((a,b)=>b.valor-a.valor);
  let receitaAvulsa=0; const avulsas=[];
  const _uEm=new Set(Object.keys(DB_USERS||{}).map(e=>e.toLowerCase()));
  for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){
    if(!pg) continue;
    const e=String(pg.email||"").toLowerCase();
    if(e&&_uEm.has(e)) continue;
    if(naoEhReceita(e)||pg.anuladoPor||pg.tipo==="ajuste") continue; // 💼 MC5-P3 + 🎬 v237v
    const v=pv(pg.valor); if(v<=0) continue;
    const dt=ts(pg.dataPagamento)||ts(pg.data)||pg.criadoEm||0;
    receitaAvulsa+=v; receitaTotal+=v; avulsas.push({valor:v,date:dt});
    if(dt>=monthStart) receitaMes+=v;
  }
  // Valor "em pedidos" (pagos/ativos) — NÃO é caixa; exposto separado pra aba
  // Pedidos mostrar o rótulo honesto e a diferença vs. o caixa ficar explicável.
  let valorPedidos=0;for(const e in pedBy)for(const x of pedBy[e])valorPedidos+=x.valor;
  return {receitaTotal,receitaMes,receitaAvulsa,qtdPagantes,novosMes,vencendo7,vencendo7Valor,vencidos,trials,gift,giftDias,porPlano,porPlanoQtd,topPagantes,finBy,pedBy,avulsas,monthStart,valorPedidos};
}
// 💰 Fonte única das janelas hoje/7d/30d/total de receita — todas as telas
// (Visão do Dono, Sócios & Acerto, DRE) chamam esta função, nunca uma cópia
// própria (2 verdades sobre o mesmo dinheiro podem divergir). Mesma correção
// que computeFinanceCanonico aplica: se um pedido LEGADO foi corrigido antes
// da v194 (os 2 caminhos de correção morreram com o LOTE 12) e o lançamento
// cru do caixa ainda não reflete isso, o valor do PEDIDO vence — nunca duas
// fontes divergentes.
function computeEntradasJanelas(){
  const now=Date.now(),DAY=86400_000;
  const hojeISO=new Date(now-3*3600_000).toISOString().slice(0,10);
  const _ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
  const _pedById={};for(const ped of (DB_PEDIDOS||[])){if(ped&&ped.id)_pedById[ped.id]=ped;}
  const pags=(DB_FINANCEIRO.pagamentos||[]).filter(p=>!naoEhReceita(p.email));
  let hoje=0,dias7=0,dias30=0,total=0,n30=0;
  for(const p of pags){
    const t=_ts(p.dataPagamento||p.data);
    let v=parseFloat(p.valor)||0;
    const _ped=p.pedidoId?_pedById[p.pedidoId]:null;
    if(_ped&&(parseFloat(_ped.valorTotal)||0)>0&&(parseFloat(_ped.valorTotal)||0)!==v)v=parseFloat(_ped.valorTotal)||0;
    total+=v;
    if(t>=now-7*DAY)dias7+=v;
    if(t>=now-30*DAY){dias30+=v;n30++;}
    if(t&&new Date(t-3*3600_000).toISOString().slice(0,10)===hojeISO)hoje+=v;
  }
  let pagantes=0;
  for(const[em,u2]of Object.entries(DB_USERS)){
    if(_usuarioNaoEhReceita(em,u2))continue; // 🎬 v237v-FIX: confere emailContato, não a chave de login
    if(!u2?.vip?.active||u2.vip.source==="trial"||u2.vip.source==="code")continue;
    const exp=Math.max(u2.vip.manualExpires||0,u2.vip.autoExpires||0);
    if(exp>now)pagantes++;
  }
  return {hoje,dias7,dias30,total,n30,pagantes};
}
// ══════════════════════════════════════════════════════════════════════════
// 💼 MC4-P1 — SÓCIOS & ACERTO (MASTER COMMAND 4, dono, 28/08/2026):
// "eu preciso saber quanto eu tenho a receber e quanto diego tem a receber,
// quanto desse dinheiro veio para mim e quanto foi para o diego?"
// FONTE ÚNICA de "de quem é cada real" — a regra 13n vale pro acerto também:
// PROIBIDO recalcular isso em qualquer tela (o finCalcAcerto do front era a
// 2ª verdade — some na Parte 4 do MC4). A régua de VALOR é a MESMA do
// canônico (computeEntradasJanelas): exclui admin, pedido corrigido vence o
// caixa — o smoke prova liquidoContabil === computeEntradasJanelas().total.
// DONO de cada entrada (nesta ordem, sempre explicável — nunca caixa preta):
//   1. recebidoPor explícito ('andrio'|'diego') — marcado na aprovação/edição
//   2. lançamento de AJUSTE herda o dono do pagamento que ele anula/corrige
//      (senão anular um lançamento cobraria o par negativo de outro sócio)
//   3. derivado da TRILHA (ativadoPorEmail→lancadoPorEmail→confirmadoPor→
//      porEmail) via editorFromEmail — contado à parte como "derivado"
//   4. senão: SEM DONO — nunca chuta; vira lista pro admin atribuir em 1 clique
// 💼 MC4-P3: a régua de VALOR e de DONO de cada lançamento virou helper de
// módulo — compartilhada por computeSocios (acerto) e computeDreMensal (DRE
// mensal). Mudar aqui muda as duas telas juntas — nunca duas verdades (13n).
function _finValorEfetivo(p,pedById){
  let v=parseFloat(p.valor)||0;
  const _ped=p.pedidoId?pedById[p.pedidoId]:null;
  if(_ped&&(parseFloat(_ped.valorTotal)||0)>0&&(parseFloat(_ped.valorTotal)||0)!==v)v=parseFloat(_ped.valorTotal)||0;
  return v;
}
function _finDonoDe(p,byId,depth){
  const r=String(p.recebidoPor||"").trim().toLowerCase();
  if(r==="andrio"||r==="diego")return {dono:r,modo:"explicito"};
  if(p.tipo==="ajuste"&&p.ajustaPagamentoId&&depth<2){
    const alvo=byId[p.ajustaPagamentoId];
    if(alvo){const h=_finDonoDe(alvo,byId,depth+1);if(h.dono)return {dono:h.dono,modo:"herdado"};}
  }
  for(const em of [p.ativadoPorEmail,p.lancadoPorEmail,p.confirmadoPor,p.porEmail]){
    if(em&&isAdminEmail(em))return {dono:editorFromEmail(em)==="diego"?"diego":"andrio",modo:"derivado"};
  }
  return {dono:null,modo:"semDono"};
}
function computeSocios(){
  const _round=v=>Math.round(v*100)/100;
  const _pedById={};for(const ped of (DB_PEDIDOS||[])){if(ped&&ped.id)_pedById[ped.id]=ped;}
  const pags=(DB_FINANCEIRO.pagamentos||[]).filter(p=>p&&!naoEhReceita(p.email));
  const _byId={};for(const p of pags){if(p.id)_byId[p.id]=p;}
  const S=()=>({recebido:0,n:0,derivado:0,derivadoValor:0,gastosPagos:0,repassou:0,recebeuRepasse:0,posicao:0,direito:0,acerto:0});
  const socios={andrio:S(),diego:S()};
  const semDono={total:0,n:0,itens:[]};
  let liquidoContabil=0,anuladosN=0,anuladosValor=0;
  for(const p of pags){
    const v=_finValorEfetivo(p,_pedById);
    liquidoContabil+=v;
    if(p.anuladoPor){anuladosN++;anuladosValor+=v;}
    const {dono,modo}=_finDonoDe(p,_byId,0);
    if(dono){
      socios[dono].recebido+=v;socios[dono].n++;
      if(modo==="derivado"||modo==="herdado"){socios[dono].derivado++;socios[dono].derivadoValor+=v;}
    }else{
      semDono.total+=v;semDono.n++;
      if(semDono.itens.length<50)semDono.itens.push({id:p.id||null,email:p.email||null,nome:p.nome||null,valor:v,quando:p.dataPagamento||p.data||null,tipo:p.tipo||null,anulado:!!p.anuladoPor});
    }
  }
  // GASTOS: gasto é da EMPRESA sempre (sai do lucro dos dois); quem pagou do
  // próprio bolso (pagoPor andrio/diego) fica com esse valor a receber de volta.
  const gastos={total:0,n:0,porPagador:{andrio:0,diego:0,empresa:0}};
  for(const g of (DB_FINANCEIRO.gastos||[])){
    if(!g)continue;const gv=parseFloat(g.valor)||0;if(!(gv>0))continue;
    gastos.total+=gv;gastos.n++;
    const quem=["andrio","diego"].includes(String(g.pagoPor||"").toLowerCase())?String(g.pagoPor).toLowerCase():"empresa";
    gastos.porPagador[quem]+=gv;
    if(quem!=="empresa")socios[quem].gastosPagos+=gv;
  }
  // REPASSES: dinheiro que um sócio JÁ passou pro outro — muda só a POSIÇÃO
  // (quanto cada um efetivamente embolsou), nunca a receita nem o lucro.
  const repasses={n:0,andrioParaDiego:0,diegoParaAndrio:0};
  for(const r of (DB_FINANCEIRO.repasses||[])){
    if(!r)continue;const rv=parseFloat(r.valor)||0;if(!(rv>0))continue;
    repasses.n++;
    if(String(r.de||"").toLowerCase()==="andrio"){repasses.andrioParaDiego+=rv;socios.andrio.repassou+=rv;socios.diego.recebeuRepasse+=rv;}
    else{repasses.diegoParaAndrio+=rv;socios.diego.repassou+=rv;socios.andrio.recebeuRepasse+=rv;}
  }
  // SPLIT societário (padrão 50/50; editável no painel — Configurações persiste)
  const spRaw=(DB_ADMIN_SETTINGS&&DB_ADMIN_SETTINGS.sociosSplit)||{};
  let spA=parseFloat(spRaw.andrio),spD=parseFloat(spRaw.diego);
  if(!(spA>=0))spA=50;if(!(spD>=0))spD=50;if(!((spA+spD)>0)){spA=50;spD=50;}
  const frA=spA/(spA+spD);
  const lucroDistribuivel=_round(liquidoContabil-gastos.total);
  socios.andrio.direito=_round(lucroDistribuivel*frA);
  socios.diego.direito=_round(lucroDistribuivel-socios.andrio.direito); // fecha o centavo — a soma dos direitos é SEMPRE o lucro exato
  for(const k of ["andrio","diego"]){
    const so=socios[k];
    so.recebido=_round(so.recebido);so.derivadoValor=_round(so.derivadoValor);
    so.gastosPagos=_round(so.gastosPagos);so.repassou=_round(so.repassou);so.recebeuRepasse=_round(so.recebeuRepasse);
    so.posicao=_round(so.recebido-so.gastosPagos-so.repassou+so.recebeuRepasse);
    so.acerto=_round(so.direito-so.posicao);
  }
  const canonicoTotal=computeEntradasJanelas().total;
  const avisos=[];
  if(semDono.n)avisos.push(`⚠️ ${semDono.n} entrada(s) SEM DONO somando R$ ${_round(semDono.total).toFixed(2)} — atribua abaixo pra o acerto ficar exato.`);
  const _der=socios.andrio.derivado+socios.diego.derivado;
  if(_der)avisos.push(`ℹ️ ${_der} entrada(s) atribuídas pela TRILHA de quem aprovou/lançou (não havia recebidoPor explícito) — confira e marque explicitamente se alguma estiver errada.`);
  if(anuladosN)avisos.push(`ℹ️ ${anuladosN} lançamento(s) anulados (com par de AJUSTE −) continuam no extrato — cada par soma zero, ninguém é cobrado por eles.`);
  return {
    liquidoContabil:_round(liquidoContabil),
    entradas:{ total:_round(liquidoContabil), semDono:{total:_round(semDono.total),n:semDono.n,itens:semDono.itens}, anulados:{n:anuladosN,valor:_round(anuladosValor)} },
    gastos:{n:gastos.n,total:_round(gastos.total),porPagador:{andrio:_round(gastos.porPagador.andrio),diego:_round(gastos.porPagador.diego),empresa:_round(gastos.porPagador.empresa)}},
    repasses:{n:repasses.n,andrioParaDiego:_round(repasses.andrioParaDiego),diegoParaAndrio:_round(repasses.diegoParaAndrio)},
    split:{andrio:spA,diego:spD},
    lucroDistribuivel,
    socios,
    formula:"líquido contábil (caixa sem admins, pedido corrigido vence) = R$ "+_round(liquidoContabil).toFixed(2)
      +" · lucro distribuível = líquido − gastos (R$ "+_round(gastos.total).toFixed(2)+") = R$ "+lucroDistribuivel.toFixed(2)
      +" · direito de cada sócio = lucro × sua fração do split ("+spA+"/"+spD+")"
      +" · posição = o que já recebeu − gastos que pagou do bolso − repasses que fez + repasses que recebeu"
      +" · TEM A RECEBER = direito − posição (negativo = deve repassar ao outro)",
    avisos,
    checagem:{canonicoTotal:_round(canonicoTotal),delta:_round(liquidoContabil-canonicoTotal)}
  };
}
// ══════════════════════════════════════════════════════════════════════════
// 💼 MC4-P3 — DRE MENSAL (Master Command 4: "trabalho de contabilidade...
// como se fosse uma empresa de milhões, com relatórios sobre tudo").
// Receita/gastos/resultado MÊS A MÊS, com quebra por sócio (MESMA régua de
// dono do acerto — _finDonoDe), por plano (rótulo do pedido; planoOriginal
// da doação normalizada v154 preservado) e por categoria de gasto. A soma
// dos meses TEM que bater com computeEntradasJanelas — delta R$0 provado no
// smoke. Mês da receita: dataPagamento||data||criadoEm (precedência do
// canônico); mês do gasto: dataGasto||data||criadoEm.
function computeDreMensal(){
  const _round=v=>Math.round(v*100)/100;
  const _ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
  // 💼 MC5-P5: corte de mês em HORÁRIO DE BRASÍLIA (UTC−3) — um PIX das 22h
  // do dia 31 é do mês que o dono viveu, não do mês seguinte em UTC. O
  // fechamento mensal herda o corte por usar esta mesma função (fonte única).
  const _mes=t=>{if(!t)return null;const d=new Date(t);if(isNaN(d.getTime()))return null;return new Date(d.getTime()-3*3600*1000).toISOString().slice(0,7);};
  const _pedById={};for(const ped of (DB_PEDIDOS||[])){if(ped&&ped.id)_pedById[ped.id]=ped;}
  const pags=(DB_FINANCEIRO.pagamentos||[]).filter(p=>p&&!naoEhReceita(p.email));
  const _byId={};for(const p of pags){if(p.id)_byId[p.id]=p;}
  const meses={};
  const M=k=>meses[k]=meses[k]||{mes:k,receita:0,gastos:0,resultado:0,porSocio:{andrio:0,diego:0,semDono:0},porPlano:{},gastosPorCategoria:{},gastosPorPagador:{andrio:0,diego:0,empresa:0}};
  let recTotal=0,gasTotal=0;
  for(const p of pags){
    const v=_finValorEfetivo(p,_pedById);
    const m=M(_mes(_ts(p.dataPagamento||p.data)||p.criadoEm||0)||"sem-data");
    m.receita+=v;recTotal+=v;
    const {dono}=_finDonoDe(p,_byId,0);
    m.porSocio[dono||"semDono"]+=v;
    const ped=p.pedidoId?_pedById[p.pedidoId]:null;
    const chave=!ped?"avulso":(ped.tipo==="doacao"||ped.plano==="doacao")?String(ped.planoOriginal||"doacao").toLowerCase():String(ped.planoOriginal||ped.plano||"plano").toLowerCase();
    m.porPlano[chave]=(m.porPlano[chave]||0)+v;
  }
  for(const g of (DB_FINANCEIRO.gastos||[])){
    if(!g)continue;const gv=parseFloat(g.valor)||0;if(!(gv>0))continue;
    const m=M(_mes(_ts(g.dataGasto||g.data)||g.criadoEm||0)||"sem-data");
    m.gastos+=gv;gasTotal+=gv;
    const cat=String(g.categoria||g.cat||"geral").slice(0,40);
    m.gastosPorCategoria[cat]=(m.gastosPorCategoria[cat]||0)+gv;
    const pp=String(g.pagoPor||"empresa").toLowerCase();
    m.gastosPorPagador[pp==="andrio"||pp==="diego"?pp:"empresa"]+=gv;
  }
  const lista=Object.values(meses).sort((a,b)=>b.mes.localeCompare(a.mes)).slice(0,24);
  for(const m of lista){
    m.receita=_round(m.receita);m.gastos=_round(m.gastos);m.resultado=_round(m.receita-m.gastos);
    for(const k of ["andrio","diego","semDono"])m.porSocio[k]=_round(m.porSocio[k]);
    for(const k of Object.keys(m.porPlano))m.porPlano[k]=_round(m.porPlano[k]);
    for(const k of Object.keys(m.gastosPorCategoria))m.gastosPorCategoria[k]=_round(m.gastosPorCategoria[k]);
    for(const k of ["andrio","diego","empresa"])m.gastosPorPagador[k]=_round(m.gastosPorPagador[k]);
  }
  const canonicoTotal=computeEntradasJanelas().total;
  return { meses:lista,
    totais:{receita:_round(recTotal),gastos:_round(gasTotal),resultado:_round(recTotal-gasTotal)},
    checagem:{canonicoTotal:_round(canonicoTotal),delta:_round(recTotal-canonicoTotal)},
    formula:"cada mês: resultado = receita (régua do canônico — sem admins, pedido corrigido vence; mês por dataPagamento) − gastos (mês por dataGasto) · sócio pela MESMA régua do Acerto (explícito > herdado > trilha > sem dono)" };
}
// 📕 MC4-P5 — FECHAMENTO MENSAL IMUTÁVEL: fechar um mês congela o DRE dele
// em disco (snapshot). Fechado NUNCA é sobrescrito (409) — se o dinheiro do
// mês mudar depois (lançamento retroativo), a listagem mostra a divergência
// e o cérebro acusa (RULE_FECHAMENTO_DIVERGENTE, sempre decisão humana).
const FECHAMENTOS_FILE = path.join(DATA_DIR, "fechamentos.json");
function lerFechamentos(){
  try{ return JSON.parse(fs.readFileSync(FECHAMENTOS_FILE,"utf8"))||{}; }catch(e){ return {}; }
}
// 🤖 v164: fechar mês virou função ÚNICA — usada pela rota (fechamento
// manual) E pelo fechamento AUTOMÁTICO do dia 3 (autonomia). Nunca 2 lógicas.
function _fecharMes(mes,quem){
  if(!/^\d{4}-\d{2}$/.test(String(mes||"")))return {erro:"mes_invalido"};
  const fechs=lerFechamentos();
  if(fechs[mes])return {erro:"ja_fechado",fechamento:fechs[mes]};
  const dre=computeDreMensal();
  const mesDre=(dre.meses||[]).find(m=>m.mes===mes);
  if(!mesDre)return {erro:"sem_movimento"};
  const soc=computeSocios();
  fechs[mes]={mes,fechadoEm:new Date().toISOString(),por:quem,dre:mesDre,
    acerto:{andrio:soc.socios.andrio.acerto,diego:soc.socios.diego.acerto,split:soc.split},
    checagemDelta:dre.checagem.delta};
  persist(FECHAMENTOS_FILE,fechs);
  try{logAdminAction(quem,"fechamento_mensal",mes,null,{receita:mesDre.receita,gastos:mesDre.gastos,resultado:mesDre.resultado},`Fechamento do mês ${mes}: receita R$${mesDre.receita.toFixed(2)} · gastos R$${mesDre.gastos.toFixed(2)} · resultado R$${mesDre.resultado.toFixed(2)}`);}catch(e){}
  // Push aos admins — fechamento é marco contábil, os dois sócios ficam sabendo
  return {ok:true,fechamento:fechs[mes]};
}
function _fechamentosComVivo(){
  const fechs=lerFechamentos();
  const dre=computeDreMensal();
  const vivo={};for(const m of (dre.meses||[]))vivo[m.mes]=m;
  const lista=Object.values(fechs).sort((a,b)=>String(b.mes).localeCompare(String(a.mes))).map(f=>{
    const v=vivo[f.mes]||{receita:0,gastos:0,resultado:0};
    const dR=Math.round((v.receita-(f.dre?.receita||0))*100)/100;
    const dG=Math.round((v.gastos-(f.dre?.gastos||0))*100)/100;
    return {...f,aoVivo:{receita:v.receita,gastos:v.gastos,resultado:v.resultado},
      divergencia:{receita:dR,gastos:dG,divergente:Math.abs(dR)>=0.01||Math.abs(dG)>=0.01}};
  });
  const mesesAbertos=(dre.meses||[]).filter(m=>!fechs[m.mes]).map(m=>m.mes);
  return {fechamentos:lista,mesesAbertos};
}
// 🤖 v164 (dono, 29/08/2026 — "quero que tudo no programa seja feito
// sozinho, não quero ter que ficar clicando"): fechamento AUTOMÁTICO do
// mês anterior no dia 3 (margem pra lançamento atrasado) — só mês com
// movimento; mês já fechado nunca refecha.
function _autoFecharMesAnterior(quem){
  const d=new Date(Date.now()-3*3600_000); // 🕰️ MC5-P7: dia 3 em BRT (mesma régua do DRE)
  if(d.getUTCDate()<3)return {skipped:"aguarda o dia 3 (margem pra lançamento atrasado)"};
  return _autoFecharMesesAntigos(quem);
}
// 🕰️ MC5-P7: fecha TODOS os meses antigos com movimento ainda abertos — não
// só o imediatamente anterior. Servidor que ficou fora do ar num dia 3 (ou
// meses de antes do fechamento existir) nunca mais deixa mês pra trás. O
// mês CORRENTE nunca fecha ("sem_movimento" continua vindo do _fecharMes).
function _autoFecharMesesAntigos(quem){
  const mesAtual=new Date(Date.now()-3*3600_000).toISOString().slice(0,7);
  const abertos=(_fechamentosComVivo().mesesAbertos||[]);
  const fechados=[],pulados=[];
  for(const mes of abertos){
    if(!/^\d{4}-\d{2}$/.test(String(mes||""))||mes>=mesAtual){continue;} // corrente/sem-data ficam abertos
    const r=_fecharMes(mes,quem||"🧠 fechamento automático");
    if(r.ok){fechados.push(mes);console.log(`[cerebro] 📕 mês ${mes} fechado AUTOMATICAMENTE (receita R$${r.fechamento.dre.receita.toFixed(2)})`);}
    else pulados.push({mes,motivo:r.erro});
  }
  if(!fechados.length)return {skipped:"nenhum mês antigo aberto",pulados};
  return {fechado:fechados[fechados.length-1],fechados,pulados};
}
// 💼 MC5-P5 — GASTO RECORRENTE (dono: Render cobra todo mês; a despesa fixa
// sumia do DRE nos meses em que ninguém lembrava de lançar de novo). Para
// cada gasto marcado `recorrente` (e que não é cópia), se o mês corrente
// (corte BRT — a MESMA régua do DRE) ainda não tem a cópia dele, cria o
// gasto do mês SEM comprovante e avisa os admins por push pra anexarem.
// IDEMPOTENTE por (recorrenteDe + mês) — rodar 2x nunca duplica.
// 💼 MC5-P6: gravação de DINHEIRO conferida — persistFinanceiro() devolve
// false quando o disco falha (cheio/sem permissão), mas os fluxos de
// aprovação e do robô seguiam como se tivesse salvo: o lançamento vivia só
// na RAM e sumia no próximo restart, sem ninguém saber. Agora loga alto e
// avisa os admins por push — e o cérebro pega a sequela (pedido ativo sem
// caixa vira decisão "registrar entrada", caso Cleiton).
function _persistFinConferido(contexto){
  if(persistFinanceiro())return true;
  console.error(`[financeiro] 🔴 FALHA ao gravar o caixa no disco (${contexto}) — a mudança está só na memória até o próximo restart`);
  return false;
}
function _lancarGastosRecorrentes(){
  const gastos=DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos||[];
  const _mesDe=(g)=>{const t=Date.parse(g.dataGasto||g.data||"")||g.criadoEm||0;if(!t)return null;return new Date(t-3*3600*1000).toISOString().slice(0,7);};
  const mesAtual=new Date(Date.now()-3*3600*1000).toISOString().slice(0,7);
  const criados=[];
  for(const g of gastos.slice()){
    if(!g||g.recorrente!==true||g.recorrenteDe)continue;
    if(_mesDe(g)===mesAtual)continue; // o original já é deste mês
    if(gastos.some(x=>x&&x.recorrenteDe===g.id&&_mesDe(x)===mesAtual))continue; // cópia do mês já existe
    const novo={
      id:'gst_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
      valor:g.valor,categoria:g.categoria||"geral",pagoPor:g.pagoPor||"empresa",
      descricao:String(g.descricao||g.nota||"").slice(0,160)+" (recorrente automático)",
      dataGasto:new Date().toISOString(),criadoEm:Date.now(),
      recorrenteDe:g.id,lancadoPor:"🔁 robô de gastos recorrentes",lancadoPorEmail:"sistema",
      temComprovante:false
    };
    // Gasto em dólar: re-converte com o câmbio do original (editável depois).
    if(String(g.moeda||'').toUpperCase()==='USD'&&g.valorUSD>0){novo.moeda='USD';novo.valorUSD=g.valorUSD;novo.cambio=(g.cambio>0)?g.cambio:5.17;novo.valor=Math.round(novo.valorUSD*novo.cambio*100)/100;}
    gastos.unshift(novo);criados.push(novo);
    if(!Array.isArray(DB_FINANCEIRO.alteracoes))DB_FINANCEIRO.alteracoes=[];
    DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
      tipo:'add_gasto_recorrente',por:'🔁 robô de gastos recorrentes',porEmail:'sistema',em:Date.now(),
      motivo:'Cópia mensal automática do gasto '+g.id+' ('+novo.categoria+' R$'+(novo.valor||0).toFixed(2)+')',antes:null,depois:{...novo}});
  }
  if(criados.length){
    _persistFinConferido("gastos recorrentes do mês"); // MC5-P6: gravação conferida
    console.log(`[financeiro] 🔁 ${criados.length} gasto(s) recorrente(s) lançados pro mês ${mesAtual}`);
  }
  return {mes:mesAtual,criados:criados.length,ids:criados.map(c=>c.id)};
}
// 📊 MC4-P3 — Relatório executivo: 100% DETERMINÍSTICO (nenhuma IA calcula
// número — mesmo princípio do responder() do cérebro), sempre com fontes.
function relatorioExecutivoDre(dre){
  const soc=computeSocios();
  const F=v=>"R$ "+(Number(v)||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
  const L=[];
  const agora=new Date();
  L.push(`📊 RELATÓRIO EXECUTIVO — H2BApply · gerado em ${agora.toLocaleDateString("pt-BR")} ${agora.toLocaleTimeString("pt-BR").slice(0,5)}`);
  L.push(`Régua: caixa sem admins, pedido corrigido vence (checagem vs painel: Δ ${F(dre.checagem.delta)}).`);
  const [m0,m1]=dre.meses;
  if(m0){
    let cresc="";
    if(m1&&m1.receita>0)cresc=` · receita ${m0.receita>=m1.receita?"+":""}${Math.round(((m0.receita-m1.receita)/m1.receita)*1000)/10}% vs ${m1.mes}`;
    L.push(`• Mês ${m0.mes}: receita ${F(m0.receita)} · gastos ${F(m0.gastos)} · resultado ${F(m0.resultado)}${cresc}`);
    const topPlano=Object.entries(m0.porPlano).sort((a,b)=>b[1]-a[1])[0];
    if(topPlano)L.push(`  – maior origem de receita no mês: ${topPlano[0]} (${F(topPlano[1])})`);
    const topCat=Object.entries(m0.gastosPorCategoria).sort((a,b)=>b[1]-a[1])[0];
    if(topCat)L.push(`  – maior gasto no mês: ${topCat[0]} (${F(topCat[1])})`);
  }
  const marg=dre.totais.receita>0?Math.round((dre.totais.resultado/dre.totais.receita)*1000)/10:null;
  L.push(`• Acumulado (${dre.meses.length} mês(es)): receita ${F(dre.totais.receita)} · gastos ${F(dre.totais.gastos)} · resultado ${F(dre.totais.resultado)}${marg!=null?` · margem ${marg}%`:""}`);
  for(const k of ["andrio","diego"]){
    const so=soc.socios[k];const nome=k==="andrio"?"Andrio":"Diego";
    L.push(`• ${nome}: já recebeu ${F(so.recebido)} · ${so.acerto>0.009?`tem a receber ${F(so.acerto)}`:so.acerto<-0.009?`deve repassar ${F(Math.abs(so.acerto))}`:"em dia"} (split ${soc.split[k]}%)`);
  }
  if(soc.entradas.semDono.n)L.push(`⚠️ ${soc.entradas.semDono.n} entrada(s) sem dono (${F(soc.entradas.semDono.total)}) — atribua na aba 🧠 pro acerto ficar exato.`);
  return {texto:L.join("\n"),geradoEm:new Date().toISOString(),
    fontes:["computeDreMensal (caixa + gastos, mês a mês)","computeSocios (acerto entre sócios)","computeEntradasJanelas (checagem delta R$0)"]};
}
// ── MONITOR ETA ──────────────────────────────────────────────────────────
// Registro permanente de TODAS as vagas por ETA Case Number: status, grupo,
// histórico completo, agenda de consultas. Alimentado pelas planilhas +
// worker independente que consulta o DOL 24/7 (não depende de interface).
let DB_BLOCKED     = {emails:[]};               // Emails banidos permanentemente
let DB_TRIAL_USED  = {phones:{},ips:{},googleIds:{}};  // Anti-abuse: {phones:{"+5511...":"email"}, ips:{"1.2.3.4":["email1","email2"]}, googleIds:{"108...":"email"}}

// 🩹 v240 (achado real, 22/09/2026 — 2º alerta de OOM do Render, 512MB):
// onlineMap crescia PRA SEMPRE, 1 entrada por e-mail distinto, a cada
// /api/status chamado (todo carregamento de página de todo usuário logado)
// — e nunca era LIDO em lugar nenhum do código (grep confirma: só .set(),
// zero .get()/.has()/iteração). O status "online" de verdade que o painel
// admin mostra vem de `sessions` (onlineEmails, derivado ao vivo), não
// deste Map. Removido — o `setUser({lastSeenAt})` abaixo é o que
// efetivamente persiste "visto por último" (já lido pela faxina do
// DB_SENT, 6h). PROIBIDO reintroduzir um Map paralelo de "online" sem
// antes checar se `sessions`/`lastSeenAt` já resolve o que for preciso.
const markOnline = email => {
  if(!email) return;
  const now = Date.now();
  // Persiste lastSeenAt no DB do usuário (sobrevive a reinícios)
  const p = getUser(email);
  if(p) setUser(email, { lastSeenAt: now });
};

function load(f, def) { return storageLoad(f, def); } // Fase 4: SQLite + migração automática + fallback JSON

// ══════════════════════════════════════════════════════════
//  SISTEMA DE INTELIGÊNCIA DE EMAILS — Base Global
//  v199 LOTE 18: estes 3 bancos são HISTÓRICO + ajuste manual do admin, nunca
//  mais descoberta automática. O leitor de bounce vivia dentro da leitura de
//  caixa de entrada, que este app não faz (escopo único gmail.send) — era
//  código que não tinha como rodar nem em teoria. Quem escreve hoje é o admin
//  (/api/admin/email-intelligence/mark-invalid); quem lê é o envio (manual e
//  robô pulam endereço com bounce conhecido) e o painel.
// ══════════════════════════════════════════════════════════
const INVALID_EMAILS_FILE   = path.join(DATA_DIR, "invalid_emails.json");
const EMAIL_CORRECTIONS_FILE = path.join(DATA_DIR, "email_corrections.json");
const TEMP_FAILURES_FILE    = path.join(DATA_DIR, "temp_failures.json");

let DB_INVALID_EMAILS   = {};  // { email: {email,domain,motivo,tipo,first,last,count,users,msg,status} }
let DB_EMAIL_CORRECTIONS = {}; // { orig: {original,corrected,confidence,count,first,last} }
let DB_TEMP_FAILURES    = {};  // { email: {email,errors:[],count} }

function isEmailInvalid(email){
  const e = DB_INVALID_EMAILS[email?.toLowerCase()];
  return e && e.status === 'invalid' && e.count >= 1;
}

function boot() {
  // ── CANÁRIO DE PERSISTÊNCIA (diagnóstico turnkey nos logs) ────────────
  // Prova se DATA_DIR sobrevive a restarts. Se este aviso aparecer a CADA
  // deploy ("criado agora"), o disco é EFÊMERO → TODOS os dados se perdem a
  // cada reinício (causa de "app fantasma": usuários somem, contadores zeram,
  // VIP volta pra trial de 1 dia). Solução: montar o disco persistente do
  // Render em /data (Dashboard → Disks → Mount Path /data).
  try {
    const _cf = path.join(DATA_DIR, ".persist_canary");
    if (fs.existsSync(_cf)) {
      const _c = JSON.parse(fs.readFileSync(_cf, "utf8") || "{}");
      _c.boots = (_c.boots || 1) + 1; _c.lastBootAt = Date.now();
      const _ageH = ((Date.now() - (_c.createdAt || Date.now())) / 3600000).toFixed(1);
      fs.writeFileSync(_cf, JSON.stringify(_c));
      console.log(`[persist] ✅ Canário OK — disco PERSISTENTE. Idade: ${_ageH}h | boots: ${_c.boots}`);
    } else {
      fs.writeFileSync(_cf, JSON.stringify({ id: "cny_" + Date.now().toString(36), createdAt: Date.now(), boots: 1, lastBootAt: Date.now() }));
      console.warn(`[persist] ⚠️ Canário CRIADO AGORA em ${DATA_DIR}. Se aparecer a CADA deploy, o disco é EFÊMERO — monte o disco persistente do Render em /data!`);
    }
  } catch (e) { console.error("[persist] erro no canário:", e.message); }

  // ── RESET ÚNICO CONTROLADO POR ENV (turnkey, sem abrir shell) ─────────
  // Para resetar TUDO: no Render, crie a env RESET_NOW com um valor qualquer
  // (ex.: RESET_NOW=temporada1) e faça deploy. Roda UMA vez, carimba o token
  // em /data/.reset_token e NUNCA repete — mesmo deixando a env ligada.
  // Para um novo reset no futuro, troque o valor (ex.: temporada2).
  // PRESERVA: admin_settings.json (senhas de editor + trial), knowledge_base.json
  // e os arquivos de vagas DOL. Roda antes dos loads → memória sobe limpa.
  try {
    const _resetTok = (process.env.RESET_NOW || "").trim();
    if (_resetTok) {
      const _tokFile = path.join(DATA_DIR, ".reset_token");
      let _prev = ""; try { _prev = fs.readFileSync(_tokFile, "utf8").trim(); } catch {}
      if (_resetTok !== _prev) {
        // ── PROTEÇÃO ANTI-WIPE ────────────────────────────────────────
        // Se o token mudou mas JÁ EXISTEM usuários, normalmente significa
        // que o .reset_token sumiu (disco efêmero) e o reset tentaria rodar
        // DE NOVO, apagando pagantes. Aborta — a não ser que o token termine
        // em ":force" (reset intencional de nova temporada).
        const _force = _resetTok.endsWith(":force");
        let _existingUsers = 0;
        try { _existingUsers = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "users.json"), "utf8") || "{}")).length; } catch {}
        if (_existingUsers > 0 && !_force) {
          console.error(`[reset] 🛑 ABORTADO: ${_existingUsers} usuário(s) existem e RESET_NOW="${_resetTok}" mudou sem ":force".`);
          console.error(`[reset] 🛑 Provável disco efêmero (token sumiu). Para evitar perda, NÃO apaguei nada.`);
          console.error(`[reset] 🛑 Reset intencional? Use RESET_NOW="${_resetTok}:force". Senão, REMOVA a env RESET_NOW.`);
          try { fs.writeFileSync(_tokFile, _resetTok); } catch {}
        } else {
        console.log(`[reset] 🔄 RESET_NOW="${_resetTok}" novo — executando reset único da temporada...`);
        const _empty = {
          "users.json": {}, "h2b_users.json": {}, "history.json": {}, "h2b_history.json": {},
          "app_index.json": {}, "auto_jobs.json": {}, "sent_emails.json": {}, "auto_logs.json": {},
          "journey.json": {}, "notes.json": {}, "job_alerts.json": {},
          "push_subs.json": {}, "financeiro.json": { pagamentos: [], gastos: [] }, "pedidos.json": [],
          "suggestions.json": [], "referrals.json": { byCode: {}, byEmail: {} },
          "notifications.json": { notifications: [] },
          "invalid_emails.json": {}, "email_corrections.json": {}, "temp_failures.json": {},
          "trial_used.json": { phones: {}, ips: {}, googleIds: {} }
        };
        for (const [f, v] of Object.entries(_empty)) {
          try { fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2)); }
          catch (e) { console.warn("[reset] " + f + ":", e.message); }
        }
        try { fs.unlinkSync(path.join(DATA_DIR, "backup.json")); } catch {}
        try { fs.rmSync(path.join(DATA_DIR, "cvs"), { recursive: true, force: true }); } catch {}
        try { fs.mkdirSync(path.join(DATA_DIR, "cvs"), { recursive: true }); } catch {}
        try { fs.writeFileSync(_tokFile, _resetTok); } catch {}
        console.log("[reset] ✅ Reset concluído. PRESERVADOS: admin_settings, knowledge_base, vagas DOL.");
        } // fim do bloco de wipe (proteção anti-wipe)
      } else {
        console.log(`[reset] RESET_NOW="${_resetTok}" já aplicado antes — ignorando.`);
      }
    }
  } catch (e) { console.error("[reset] erro geral:", e.message); }

  // Migração automática de nomes antigos
  const mig = (newF, oldF, def) => {
    if (fs.existsSync(newF)) return load(newF, def);
    if (fs.existsSync(oldF)) {
      console.log(`[db] Migrando ${path.basename(oldF)} → ${path.basename(newF)}`);
      const d = load(oldF, def);
      try { fs.copyFileSync(oldF, newF); } catch {}
      return d;
    }
    return def;
  };
  DB_USERS  = mig(USERS_FILE,  path.join(DATA_DIR, "h2b_users.json"),   {});
  _decUsersFromDisk(DB_USERS); // V955: decifra tokens gravados com DATA_ENC_KEY
  _migrateUsersToSingleProfile(DB_USERS); // KB-SEO-03 (2026-07): consolida perfis múltiplos → 1 por usuário
  _dedupeAndHealUserCvs(DB_USERS); // v20 (07/2026): remove PDFs duplicados e cura perfis com referência quebrada
  _migrateCvBlobsToDisk(DB_USERS); // v21 (07/2026): PDFs base64 saem do users.json → disco (RAM e persist leves)
  _sweepOrphanCvFiles(DB_USERS);   // v21 (07/2026): apaga PDFs órfãos do disco (lixo do antigo delete sem unlink)
  _sweepOrphanStagedComprovantes(); // v240c: apaga comprovantes "em preparo" de um processo anterior (o Map de posse morreu com ele)
  _wipeCannedDefaults(DB_USERS);   // v22 (ordem do dono): remove texto enlatado de fábrica intocado — conteúdo é do usuário
  _migrarIdiomaParaPt(DB_USERS);   // 🇧🇷 v199 LOTE 17: conta presa em EN/ES volta pro português (o site não tem seletor)
  DB_HIST   = mig(HIST_FILE,   path.join(DATA_DIR, "h2b_history.json"), {});
  DB_AUTO   = load(AUTO_FILE, {});
  DB_LOGS   = load(LOGS_FILE, {});
  DB_JOURNEY = load(JOURNEY_FILE, {});
  const savedAdminSettings = load(ADMIN_SETTINGS_FILE, null);
  if(savedAdminSettings) Object.assign(DB_ADMIN_SETTINGS, savedAdminSettings);
  DB_DIVERGENCIAS_OK = load(DIVERGENCIAS_OK_FILE, {});
  DB_REVIEWS = load(REVIEWS_FILE, []);
  if(!Array.isArray(DB_REVIEWS)) DB_REVIEWS = [];
  DB_PEDIDOS = load(PEDIDOS_FILE, []);
  if(!Array.isArray(DB_PEDIDOS)) DB_PEDIDOS = [];
  _migrarComprovantesParaDisco(); // 🧾 v192 LOTE 10 (idempotente, qualquer status)
  DB_ADMIN_AUDIT = load(ADMIN_AUDIT_FILE, []);
  if(!Array.isArray(DB_ADMIN_AUDIT)) DB_ADMIN_AUDIT = [];
  DB_FINANCEIRO = load(FINANCEIRO_FILE, {pagamentos:[],gastos:[],repasses:[]});
  if(!DB_FINANCEIRO.pagamentos) DB_FINANCEIRO = {pagamentos:[],gastos:[],repasses:[]};
  if(!Array.isArray(DB_FINANCEIRO.repasses)) DB_FINANCEIRO.repasses = []; // repasses entre sócios (dinheiro que um já pagou ao outro)
  DB_BLOCKED = load(BLOCKED_FILE, {emails:[]});
  if(!Array.isArray(DB_BLOCKED.emails)) DB_BLOCKED = {emails:[]};
  // 🔓 v153 (ordem do dono, 21/08/2026 — "elimine todos os e-mails
  // bloqueados permanentemente, libera todos; a partir de agora só bloqueia
  // quem eu mandar"): limpeza ÚNICA de toda a lista de banidos. O carimbo
  // `limpouTudoEm` garante que roda 1 vez só — bans explícitos feitos pelo
  // dono DEPOIS da limpeza nunca são apagados por um boot seguinte.
  // (Origem da bagunça: deletar conta banía o e-mail junto sem ninguém
  // pedir — caso Esdras; esse auto-ban também foi removido no v153.)
  if(!DB_BLOCKED.limpouTudoEm){
    const _qtd=DB_BLOCKED.emails.length;
    DB_BLOCKED.emails=[];
    DB_BLOCKED.limpouTudoEm=new Date().toISOString();
    persist(BLOCKED_FILE,DB_BLOCKED);
    console.log(`[migração] 🔓 lista de banidos ZERADA — ${_qtd} e-mail(is) liberados (ordem do dono, 21/08/2026)`);
  }
  // 🧹 v191 LOTE 9 — o backup.json aposentado sai do disco E do SQLite.
  // Ele guardava TODOS os usuários (refresh_token do Google e hash de senha em
  // TEXTO PURO — passava por fora do DATA_ENC_KEY) e ninguém nunca o leu.
  // Deixar o resíduo no volume seria pior que antes: um arquivo em claro
  // parado pra sempre, e ainda copiado pra dentro de cada backup se um dia
  // saísse do BACKUP_EXCLUIR. A limpeza é idempotente (só age se existir).
  try{
    const _bkJson=path.join(DATA_DIR,"backup.json");
    const _tinhaArquivo=fs.existsSync(_bkJson);
    if(_tinhaArquivo) fs.unlinkSync(_bkJson);
    const _tinhaNoDb=storageDelete(_bkJson);
    if(_tinhaArquivo||_tinhaNoDb) console.log(`[migração] 🧹 backup.json aposentado removido (arquivo: ${_tinhaArquivo?"sim":"não"}, SQLite: ${_tinhaNoDb?"sim":"não"}) — guardava tokens e senhas em texto puro e ninguém o lia.`);
  }catch(e){ console.warn("[migração] backup.json:",e.message); }

  DB_TRIAL_USED = load(TRIAL_USED_FILE, {phones:{},ips:{},googleIds:{}});
  if(!DB_TRIAL_USED.phones) DB_TRIAL_USED.phones={};
  if(!DB_TRIAL_USED.ips) DB_TRIAL_USED.ips={};
  if(!DB_TRIAL_USED.googleIds) DB_TRIAL_USED.googleIds={};

  // ── Emails Inválidos (bounces) — carregado do disco, persiste entre deploys ──
  const _rawInvalid = load(INVALID_EMAILS_FILE, {});
  DB_INVALID_EMAILS = {};
  for(const [k,v] of Object.entries(_rawInvalid)){
    DB_INVALID_EMAILS[k] = {...v, users: new Set(Array.isArray(v.users)?v.users:(v.users?[v.users]:[]))};
  }
  DB_EMAIL_CORRECTIONS = load(EMAIL_CORRECTIONS_FILE, {});
  DB_TEMP_FAILURES = load(TEMP_FAILURES_FILE, {});
  const _invalidCount = Object.keys(DB_INVALID_EMAILS).length;
  const _tempCount = Object.keys(DB_TEMP_FAILURES).length;
  if(_invalidCount||_tempCount) console.log(`[bounce] ✅ ${_invalidCount} emails inválidos | ${_tempCount} falhas temporárias carregados do disco`);

  const rawSent = mig(SENT_FILE, path.join(DATA_DIR, "h2b_sent_emails.json"), {});
  for (const [k, v] of Object.entries(rawSent)) DB_SENT[k] = new Set(Array.isArray(v) ? v : []);
  // ══════════════════════════════════════════════════════
  // REGRA PRINCIPAL: reconstrói DB_SENT completo do HIST
  // Garante que NENHUM envio do histórico seja esquecido
  // Sobrevive a deploy, reinício, corrupção do sent_emails
  // ══════════════════════════════════════════════════════
  let _sentRebuilt = 0;
  for (const [userEmail, entries] of Object.entries(DB_HIST)) {
    if (!DB_SENT[userEmail]) DB_SENT[userEmail] = new Set();
    for (const h of entries) {
      const nd = (h.to||"").toLowerCase().trim().replace(/\.+$/,"");
      if (nd && !DB_SENT[userEmail].has(nd)) {
        DB_SENT[userEmail].add(nd);
        _sentRebuilt++;
      }
    }
  }
  if (_sentRebuilt > 0) {
    persistSent(); // Salva o DB_SENT reconstruído no disco imediatamente
    console.log(`[db] 🔒 DB_SENT reconstruído do histórico: +${_sentRebuilt} entradas adicionadas`);
  }
  console.log(`[db] ✅ ${Object.keys(DB_USERS).length} usuários | ${Object.values(DB_HIST).reduce((n,a)=>n+a.length,0)} enviados`);
  console.log(`[db] Logs: ${Object.values(DB_LOGS).reduce((n,a)=>n+a.length,0)} entradas`);
  // NOTA v19: a reconciliação de jobs automáticos após restart já existe —
  // ver reactivateAutoJobs() (chamada 6s após o boot, mais abaixo no arquivo).
  // Ela é mais cuidadosa que um "scheduleAuto pra tudo que tá active" ingênuo:
  // respeita waiting_limit/waiting_rate_limit/waiting_interval e o nextSendAt
  // já salvo (não reenvia na hora ignorando um cooldown de rate-limit em
  // andamento) e pré-aquece tokens antes de agendar. Não duplicar essa lógica
  // aqui — ver defesa complementar em /api/auto/start (self-heal de timer morto).
}

// ❄️ v191 LOTE 9 — CONGELAMENTO DE GRAVAÇÕES (restauração de backup).
// BUG REAL do procedimento de emergência: a rota de restore copiava os .json
// de volta pra /data e apagava o .db, mas o PROCESSO seguia vivo com TUDO em
// memória no estado PRÉ-restore — em segundos um setUser debounced regravava
// users.json por cima, e o "reinicie o servidor" mandava SIGTERM, cujo
// flushAll() grava a MEMÓRIA inteira em cima dos arquivos restaurados. Ou
// seja: pedidos/financeiro voltavam e usuários/histórico/robôs voltavam ao
// estado de antes — restauração MISTA e silenciosa, justo no procedimento que
// se executa em pânico. A partir daqui, restaurar CONGELA toda gravação até o
// reinício: um único portão (persist) cobre users/hist/auto/pedidos/
// financeiro/sessões/tudo mais, porque todo banco passa por aqui.
let _gravacoesCongeladas = false;
let _gravacoesCongeladasMotivo = "";
function persist(file, data) {
  if (_gravacoesCongeladas) {
    console.warn(`[freeze] ❄️ persist(${path.basename(file)}) IGNORADO — ${_gravacoesCongeladasMotivo}. Reinicie o servidor pra concluir.`);
    return false;
  }
  // Fase 4: SQLite atômico (WAL) + espelho JSON (STORAGE_MIRROR=off desliga o espelho)
  // V955: users.json passa pelo cifrador de campos sensíveis (cópia — runtime intocado)
  if (file === USERS_FILE) data = _encUsersForDisk(data);
  const okP = storagePersist(file, data); // true/false — ver storage.js
  // 11/07: ENOSPC em produção derrubou a gravação de TOKENS (usuários "perdendo
  // token sozinhos"). Se a escrita falhar, tenta liberar espaço e regrava 1x —
  // priorizando que dados críticos (users.json com refresh_token) sobrevivam.
  if (!okP) {
    try {
      if (typeof emergencyDiskCleanup === "function" && emergencyDiskCleanup("persist falhou: " + path.basename(file))) {
        const retry = storagePersist(file, data);
        if (retry) console.log("[disk] ✅ regravação após faxina: " + path.basename(file));
        return retry;
      }
    } catch(e) { console.error("[disk] retry pós-faxina falhou:", e.message); }
  }
  return okP;
}
function persistSent() {
  const out={};for(const[k,v]of Object.entries(DB_SENT))out[k]=[...v];persist(SENT_FILE,out);
}
function persistLogs() { persistDebounced(LOGS_FILE, DB_LOGS, 3000); }
function persistLogsImmediate() { persist(LOGS_FILE, DB_LOGS); }
// ⚡ v190 LOTE 8: caminho do LOG DE ENVIO (status enviado/falhou/pausado/…).
// Era `persistLogsImmediate()` — o auto_logs.json INTEIRO, de TODOS os
// usuários, serializado e gravado de forma síncrona a cada candidatura que
// sai, bloqueando o event loop pra todo mundo (o próprio comentário do
// código registra 19MB e 1,2s por persist antes do corte pra 500 entradas).
// Throttle: agrupa as gravações, mas o teto garante que o log nunca fica
// mais que `_LOGS_MAX_WAIT` sem ir pro disco, mesmo com tráfego contínuo.
// No npm test o teto é curto pra suíte provar as DUAS metades (não grava na
// hora × grava mesmo com chamadas contínuas) sem esperar meio minuto.
const _LOGS_MAX_WAIT = process.env.TEST_LOGIN_TOKEN ? 1500 : 30000;
function persistLogsThrottled() { persistThrottled(LOGS_FILE, DB_LOGS, 3000, _LOGS_MAX_WAIT); }

// CRUD
const getUser    = e => DB_USERS[e]||null;
// 🐛 v172c: getUser(email) só acha conta pela CHAVE do banco — pra conta
// legada isso já É o Gmail real, mas pra conta nova (v172c) a chave é o
// username e o Gmail real vive à parte em u.gmailEmail. Usada pra proteção
// "esse Gmail é conta de login de alguém, não revogar" (v165) — sem isso,
// essa proteção nunca reconhecia uma conta v172c pelo Gmail que ela conectou.
function findAccountByRealGmail(email){
  const byKey=getUser(email);
  if(byKey)return byKey;
  const low=String(email||"").toLowerCase().trim();
  if(!low)return null;
  return Object.values(DB_USERS||{}).find(u=>u&&String(u.gmailEmail||"").toLowerCase().trim()===low)||null;
}
// 🎬 v237v-FIX (achado real, revisão pré-gravação do vídeo com o Andrio —
// mesma classe do comentário logo acima): pd.userEmail/a CHAVE de
// DB_USERS é a IDENTIDADE de LOGIN — username pra conta nova (v172c,
// NUNCA tem @) ou o próprio Gmail em conta legada/pedido "Regularizar" do
// admin. Comparar TEST_ACCOUNT_EMAIL contra essa chave crua NUNCA
// reconhece a conta de teste — o Gmail de CONTATO real (confirmado por
// código no cadastro, ANTES de qualquer Gmail de envio ser conectado)
// mora em `emailContato`, campo separado. Fonte única de resolução —
// usada em toda checagem de "é a conta de teste" a partir de uma chave.
function _emailContatoReal(loginKey){
  if(!loginKey)return "";
  const u=getUser(loginKey);
  return (u&&u.emailContato)||loginKey;
}
// naoEhReceita (mod-config.js) pelo PEDIDO — usa o carimbo isTeste gravado
// na criação (fonte única, nunca re-deriva por e-mail numa leitura tardia,
// que erraria pra pedido de conta nova por causa do problema acima).
function _pedidoNaoEhReceita(pd){ return naoEhReceita(pd&&pd.userEmail)||!!(pd&&pd.isTeste); }
// naoEhReceita pelo USUÁRIO — pra loops que já têm o objeto carregado
// (Object.entries(DB_USERS) etc.): confere o Gmail de contato real, nunca
// a chave de login crua.
function _usuarioNaoEhReceita(em,u){ return naoEhReceita(em)||isTestAccountEmail(u&&u.emailContato); }
// FIX-CRASH: setUser usa debounce de 3s para evitar escrita excessiva no disco
// (markOnline chamado em todo /api/status causava persist() a cada request)
const _setUserPersistDebounce = { tid: null };
const setUser    = (e,d) => {
  DB_USERS[e]={...(DB_USERS[e]||{}),...d};
  // v43-FIX (dono, 23/07: "site lento, até salvar perfil demora muito"):
  // isCritical checava d.cvs/d.profiles/d.senderEmails por TRUTHY — mas são
  // ARRAYS, e array (mesmo vazio []) é sempre truthy em JS. Resultado real:
  // TODO save de perfil/currículo/e-mail extra caía no ramo síncrono — que
  // não é um writeFileSync simples: _encUsersForDisk roda AES-256-GCM sobre
  // TODOS os usuários, o JSON do banco INTEIRO é serializado 2x (espelho
  // SQLite + arquivo) e gravado em disco de forma BLOQUEANTE, travando o
  // Node inteiro (evento único) para TODO mundo, não só quem salvou. Com
  // milhares de usuários isso é a causa raiz do "trava até salvar perfil".
  // Perfil/currículo/e-mail extra NÃO são dado financeiro — o debounce de
  // 5s já é seguro: flushAll() grava DB_USERS de verdade no SIGTERM/SIGINT
  // (exatamente o sinal que o Render manda antes de reiniciar num deploy),
  // então a única janela de perda é um crash bruto (SIGKILL) dentro de 5s
  // de uma edição — infinitamente mais raro que travar todo mundo a cada
  // clique. Fica síncrono só o que É dinheiro/acesso: token OAuth, VIP,
  // admin, plano.
  const isCritical = !!(d.refresh_token || d.cached_access_token || d.vip || d.isAdmin || d.plan);
  if (isCritical) {
    persist(USERS_FILE, DB_USERS);
  } else {
    persistDebounced(USERS_FILE, DB_USERS, 5000);
  }
};
const delUser    = e => { delete DB_USERS[e]; persist(USERS_FILE,DB_USERS); };

// ── KB-SEO-03 (2026-07, pedido do dono): PERFIL ÚNICO por usuário ───────────
// Antes cada usuário podia ter até 20 "perfis de currículo" (um por tipo de
// vaga). Passamos a permitir só 1 por usuário, com informações gerais que
// valem pra qualquer vaga. Rodada ÚNICA no boot: consolida quem já tinha mais
// de 1 perfil, escolhendo o "melhor" (favorito > mais completo > mais recente)
// como sobrevivente e juntando os assuntos/corpos únicos dos outros nele —
// nenhum texto que o usuário escreveu se perde, só deixa de estar espalhado
// em vários perfis. Idempotente: usuário com 0 ou 1 perfil não é tocado.
function _mergeProfilesToOne(profiles){
  if(!Array.isArray(profiles)||profiles.length<=1)return profiles;
  const scored=profiles.map(p=>({p,score:(p.isFavorite?1000:0)+(p.subjects?.length||0)+(p.emailBodies?.length||0)}));
  scored.sort((a,b)=>b.score-a.score||new Date(b.p.updatedAt||0)-new Date(a.p.updatedAt||0));
  const survivor={...scored[0].p};
  const subjSet=new Set((survivor.subjects||[]).map(s=>String(s).trim()).filter(Boolean));
  const bodyList=[...(survivor.emailBodies||[])].map(b=>String(b).trim()).filter(Boolean);
  const bodySeen=new Set(bodyList);
  for(const{p:other}of scored.slice(1)){
    (other.subjects||[]).forEach(s=>{const t=String(s).trim();if(t)subjSet.add(t);});
    (other.emailBodies||[]).forEach(b=>{const t=String(b).trim();if(t&&!bodySeen.has(t)){bodyList.push(t);bodySeen.add(t);}});
  }
  survivor.subjects=[...subjSet].slice(0,10);
  survivor.emailBodies=bodyList;
  survivor.subject=survivor.subjects[0]||survivor.subject||"";
  survivor.body=survivor.emailBodies[0]||survivor.body||"";
  survivor.isGeneral=true;survivor.categories=[];survivor.active=true;survivor.isFavorite=true;
  survivor.allowManual=true;survivor.allowAuto=true;
  survivor.name=survivor.name||"Meu Perfil";
  survivor.updatedAt=new Date().toISOString();
  return [survivor];
}
// v19 (dono, 15/07/2026): detecta se um perfil legado era de H-2A pelo nome,
// descrição ou planilhas selecionadas — usado só na migração, pra não rotular
// como H-2B o perfil de quem sempre foi de agricultura.
function _inferVisaType(p){
  if(p?.visaType==="h2a"||p?.visaType==="h2b")return p.visaType;
  const txt=((p?.name||"")+" "+(p?.desc||"")).toLowerCase().replace(/[^a-z0-9]/g,"");
  if(txt.includes("h2a"))return "h2a";
  if(Array.isArray(p?.sheets)&&p.sheets.some(s=>String(s).toLowerCase().includes("h2a")))return "h2a";
  return "h2b";
}
// 🇧🇷 v199 LOTE 17 — MIGRAÇÃO: idioma de TODO usuário vira "pt".
// O site é só em português de propósito (regra do README) e não tem seletor de
// idioma em tela nenhuma. Enquanto isso, o campo `language` aceitava 'en'/'es'
// (e o front aplicava cegamente): quem tivesse esse valor gravado — conta legada
// do site antigo, ou um POST direto em /api/settings — abria o app inteiro em
// inglês SEM NENHUM caminho de volta. Corrigir só "pra frente" (fechar a
// whitelist) deixaria essas contas presas pra sempre; por isso a cura roda aqui.
// IDEMPOTENTE: no boot seguinte ninguém mais bate na condição e nada é logado.
// (O "pt-BR" que as contas antigas carregam também é normalizado — a chave do
// dicionário é de 2 letras, então o valor com região nunca casava com nada.)
function _migrarIdiomaParaPt(users){
  let tocados=0;
  for(const em of Object.keys(users||{})){
    const u=users[em]; if(!u||typeof u!=="object")continue;
    if(u.language!==undefined && u.language!=="pt"){ u.language="pt"; tocados++; }
  }
  if(tocados){
    persist(USERS_FILE, users);
    console.log(`[migração] 🇧🇷 idioma normalizado pra "pt" em ${tocados} conta(s) — o app é só em português e não tem seletor pra desfazer.`);
  }
  return tocados;
}

function _migrateUsersToSingleProfile(users){
  // v19: era "perfil único"; virou "1 perfil POR TIPO DE VISTO" (máx. 2: H-2B
  // + H-2A). Cliente real tinha 2 perfis H-2B + 1 H-2A e a consolidação antiga
  // juntou TUDO num perfil só — vaga de H-2A passou a sair com texto de H-2B.
  // Agora: agrupa por tipo inferido (nome/desc/planilhas), consolida DENTRO de
  // cada tipo, e carimba visaType em todo perfil que não tem. Idempotente.
  let touched=0;
  for(const email of Object.keys(users)){
    const u=users[email];
    if(!u||!Array.isArray(u.profiles)||!u.profiles.length)continue;
    let changed=false;
    // Carimba visaType em quem não tem (usuários já migrados pro perfil único)
    for(const p of u.profiles){
      if(p&&p.visaType!=="h2a"&&p.visaType!=="h2b"){p.visaType=_inferVisaType(p);changed=true;}
    }
    if(u.profiles.length>1){
      const byType={h2b:[],h2a:[]};
      for(const p of u.profiles)byType[(p.visaType==="h2a")?"h2a":"h2b"].push(p);
      const result=[];
      for(const vt of ["h2b","h2a"]){
        if(!byType[vt].length)continue;
        const merged=byType[vt].length>1?_mergeProfilesToOne(byType[vt]):byType[vt];
        merged[0].visaType=vt;
        if(vt==="h2a"){merged[0].isFavorite=false;if(!merged[0].icon||merged[0].icon==="🎯")merged[0].icon="🌾";}
        result.push(merged[0]);
      }
      if(result.length!==u.profiles.length){
        console.log(`[perfil-por-visto] 🔀 ${email}: ${u.profiles.length} perfis → ${result.length} (${result.map(p=>p.visaType).join("+")})`);
        changed=true;
      }
      u.profiles=result;
    }
    if(changed)touched++;
  }
  if(touched>0){
    persist(USERS_FILE,users);
    console.log(`[perfil-por-visto] ✅ Migração concluída: ${touched} usuário(s) com perfis por tipo de visto.`);
  }
}
// v20 (reclamação real, 07/2026): LIMPEZA de PDFs duplicados + cura de perfis.
// Muita gente ficou com o mesmo PDF 3x na conta (o upload não deduplicava e o
// editor de perfil re-subia o arquivo a cada edição) e com perfis apontando
// para idx de PDF que não existe mais (sobras da consolidação v19). Regras:
//   1. PDFs do mesmo tipo com o MESMO nome → sobrevive 1 (preferência: o que
//      algum perfil referencia > o que tem b64 salvo > o mais recente); os
//      perfis que apontavam pros removidos são remapeados pro sobrevivente.
//   2. Perfil apontando para idx inexistente → tenta casar pelo NOME salvo no
//      perfil (pdfName/coverName); se não achar, limpa a referência (o editor
//      passa a mostrar a verdade em vez de um anexo fantasma).
// Idempotente: usuário sem duplicata e sem referência quebrada não é tocado.
function _dedupeAndHealUserCvs(users){
  let touched=0;
  for(const email of Object.keys(users)){
    const u=users[email];
    if(!u)continue;
    let changed=false;
    const cvs=Array.isArray(u.cvs)?u.cvs:[];
    if(cvs.length>1){
      const refs=new Set();
      for(const pr of (u.profiles||[])){
        if(pr?.resumeIdx!=null)refs.add(parseInt(pr.resumeIdx,10));
        if(pr?.coverIdx!=null)refs.add(parseInt(pr.coverIdx,10));
      }
      const groups=new Map();
      for(const c of cvs){
        const key=(c.cvType||"resume")+"||"+String(c.name||"").trim().toLowerCase();
        if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push(c);
      }
      const remap=new Map(); // idx removido → idx sobrevivente
      const kept=[];
      for(const arr of groups.values()){
        if(arr.length===1){kept.push(arr[0]);continue;}
        const score=c=>(refs.has(parseInt(c.idx,10))?4:0)+((c.b64&&c.b64.length>100)?2:0);
        arr.sort((a,b)=>score(b)-score(a)||parseInt(b.idx,10)-parseInt(a.idx,10));
        const survivor=arr[0];
        if(!(survivor.b64&&survivor.b64.length>100)){
          const withB64=arr.find(c=>c.b64&&c.b64.length>100);
          if(withB64)survivor.b64=withB64.b64;
        }
        kept.push(survivor);
        for(const dup of arr.slice(1)){
          remap.set(parseInt(dup.idx,10),survivor.idx);
          try{fs.unlinkSync(cvPath(email,dup.idx));}catch{}
        }
        changed=true;
      }
      if(changed){
        u.cvs=kept;
        for(const pr of (u.profiles||[])){
          if(!pr)continue;
          if(pr.resumeIdx!=null&&remap.has(parseInt(pr.resumeIdx,10)))pr.resumeIdx=remap.get(parseInt(pr.resumeIdx,10));
          if(pr.coverIdx!=null&&remap.has(parseInt(pr.coverIdx,10)))pr.coverIdx=remap.get(parseInt(pr.coverIdx,10));
        }
        console.log(`[cv-dedup] 🧹 ${email}: duplicatas removidas — ${cvs.length} → ${kept.length} PDF(s)`);
      }
    }
    // Cura de referências quebradas (roda pra todo mundo, mesmo sem duplicata)
    const cvSet=new Set((u.cvs||[]).map(c=>parseInt(c.idx,10)));
    const byName=(name,type)=>{
      const t=String(name||"").trim().toLowerCase();if(!t)return null;
      const m=(u.cvs||[]).find(c=>(c.cvType||"resume")===type&&String(c.name||"").trim().toLowerCase()===t);
      return m?m.idx:null;
    };
    for(const pr of (u.profiles||[])){
      if(!pr)continue;
      if(pr.resumeIdx!=null&&!cvSet.has(parseInt(pr.resumeIdx,10))){
        const m=byName(pr.pdfName,"resume");
        if(m!=null){pr.resumeIdx=m;console.log(`[cv-dedup] 🩹 ${email}: currículo do perfil "${pr.name}" recuperado pelo nome (${pr.pdfName})`);}
        else{pr.resumeIdx=null;delete pr.pdfName;pr.pdfSize=0;}
        changed=true;
      }
      if(pr.coverIdx!=null&&!cvSet.has(parseInt(pr.coverIdx,10))){
        const m=byName(pr.coverName,"cover");
        if(m!=null){pr.coverIdx=m;console.log(`[cv-dedup] 🩹 ${email}: cover do perfil "${pr.name}" recuperada pelo nome (${pr.coverName})`);}
        else{pr.coverIdx=null;delete pr.coverName;pr.coverSize=0;}
        changed=true;
      }
      // Nome-fantasma: perfil "diz" que tem PDF (pdfName/coverName) mas não
      // aponta pra nenhum (idx null) — sobra do sistema legado. O editor
      // mostrava um anexo que NUNCA era enviado. Tenta recuperar pelo nome;
      // se o arquivo não existe mais, apaga o nome pra UI mostrar a verdade.
      if(pr.resumeIdx==null&&pr.pdfName){
        const m=byName(pr.pdfName,"resume");
        if(m!=null){pr.resumeIdx=m;console.log(`[cv-dedup] 🩹 ${email}: currículo-fantasma do perfil "${pr.name}" religado pelo nome (${pr.pdfName})`);}
        else{delete pr.pdfName;pr.pdfSize=0;}
        changed=true;
      }
      if(pr.coverIdx==null&&pr.coverName){
        const m=byName(pr.coverName,"cover");
        if(m!=null){pr.coverIdx=m;console.log(`[cv-dedup] 🩹 ${email}: cover-fantasma do perfil "${pr.name}" religada pelo nome (${pr.coverName})`);}
        else{delete pr.coverName;pr.coverSize=0;}
        changed=true;
      }
    }
    if(changed)touched++;
  }
  if(touched>0){
    persist(USERS_FILE,users);
    console.log(`[cv-dedup] ✅ Limpeza concluída: ${touched} usuário(s) com PDFs deduplicados e/ou perfis curados.`);
  }
}
// v21 (07/2026): MIGRAÇÃO — move os PDFs base64 de dentro de users.json pro
// disco (CVS_DIR) e limpa o campo b64. Motivo: com o b64 no DB, todo persist
// de users.json reserializava os PDFs de TODOS os usuários (megabytes por
// escrita de qualquer campo) e o Node carregava tudo isso na RAM — combustível
// do 502 por falta de memória. Regras de segurança:
//   - só apaga o b64 DEPOIS de confirmar o arquivo válido no disco (>100 bytes);
//   - se a escrita falhar, o b64 fica no DB (nada se perde);
//   - idempotente: quem não tem b64 não é tocado.
function _migrateCvBlobsToDisk(users){
  let touched=0, freedBytes=0, kept=0;
  for(const email of Object.keys(users)){
    const u=users[email];
    if(!u||!Array.isArray(u.cvs))continue;
    let changed=false;
    for(const c of u.cvs){
      if(!c||!c.b64||c.b64.length<=100)continue;
      const fp=cvPath(email,c.idx);
      let onDisk=false;
      try{ onDisk=fs.statSync(fp).size>100; }catch{}
      if(!onDisk){
        try{
          fs.writeFileSync(fp+".tmp",Buffer.from(c.b64,"base64"));
          fs.renameSync(fp+".tmp",fp);
          onDisk=fs.statSync(fp).size>100;
        }catch(err){ console.warn(`[cv-blobs] falha ao gravar ${fp}: ${err.message} — b64 mantido no DB`); }
      }
      if(onDisk){ freedBytes+=c.b64.length; delete c.b64; changed=true; }
      else kept++;
    }
    if(changed)touched++;
  }
  if(touched>0){
    persist(USERS_FILE,users);
    console.log(`[cv-blobs] ✅ ${touched} usuário(s) migrados: ~${(freedBytes/1048576).toFixed(1)}MB de PDFs saíram do users.json pro disco${kept?` (${kept} b64 mantidos por falha de disco)`:""}.`);
  }
}
// v22 (ORDEM DO DONO, 21/07/2026): "não quero nada de preenchimento padrão de
// nada — quem faz isso é o usuário". Limpa das contas existentes o texto
// ENLATADO que o sistema gravava no cadastro (settings.subject/body/followup*).
// Só remove o que bate EXATAMENTE com os padrões históricos de fábrica — texto
// que o usuário editou é DELE e nunca é tocado. Idempotente.
const _CANNED_DEFAULTS=[
  "Application for {vaga} – {nome}",
  "Dear Hiring Manager,\n\nMy name is {nome} and I am writing to express my strong interest in the {vaga} position at {empresa}.\n\nI am from {pais} and fully available to start on the requested date.\n\nPlease find my resume attached.\n\nBest regards,\n{nome}\n{telefone}",
  "Following up: {vaga} at {empresa}",
  "Dear Hiring Manager,\n\nFollowing up on {vaga} at {empresa}.\n\nBest regards,\n{nome}",
];
function _wipeCannedDefaults(users){
  let touched=0;
  for(const email of Object.keys(users)){
    const u=users[email];
    if(!u||!u.settings)continue;
    let changed=false;
    for(const f of ["subject","body","followupSubject","followupBody"]){
      if(typeof u.settings[f]==="string"&&_CANNED_DEFAULTS.includes(u.settings[f])){
        delete u.settings[f];changed=true;
      }
    }
    if(changed)touched++;
  }
  if(touched>0){
    persist(USERS_FILE,users);
    console.log(`[texto-enlatado] 🧹 ${touched} conta(s) limparam o template de fábrica intocado — texto agora é 100% do usuário.`);
  }
}
// v21 (07/2026): VARREDURA de PDFs órfãos em CVS_DIR. O antigo POST
// /api/cv/delete removia o PDF do registro mas NUNCA apagava o arquivo do
// disco — lixo acumulando num volume que já encheu uma vez (incidente ENOSPC).
// Monta o conjunto de arquivos esperados a partir de TODOS os usuários e apaga
// o que ninguém referencia (só arquivos no padrão nosso: <email>_<idx>.pdf,
// mais .tmp abandonados de escrita interrompida). Roda depois das migrações.
function _sweepOrphanCvFiles(users){
  try{
    if(!fs.existsSync(CVS_DIR))return;
    const expected=new Set();
    for(const email of Object.keys(users)){
      for(const c of (users[email]?.cvs||[])){
        if(c&&c.idx!=null)expected.add(path.basename(cvPath(email,c.idx)));
      }
    }
    let removed=0,freed=0;
    for(const f of fs.readdirSync(CVS_DIR)){
      const isTmp=f.endsWith(".pdf.tmp");
      const isPdf=/_\d+\.pdf$/.test(f);
      if(!isTmp&&!isPdf)continue;            // não é arquivo nosso — não toca
      if(!isTmp&&expected.has(f))continue;   // em uso — não toca
      try{
        const fp=path.join(CVS_DIR,f);
        freed+=(fs.statSync(fp).size||0);
        fs.unlinkSync(fp);removed++;
      }catch{}
    }
    if(removed>0)console.log(`[cv-sweep] 🧹 ${removed} PDF(s) órfão(s) removidos do disco (~${(freed/1048576).toFixed(1)}MB liberados).`);
  }catch(e){ console.warn("[cv-sweep] varredura falhou:",e.message); }
}
const getHist    = e => DB_HIST[e]||[];
const addHist    = (e,entry) => { if(!DB_HIST[e])DB_HIST[e]=[]; DB_HIST[e].unshift(entry); if(DB_HIST[e].length>10000)DB_HIST[e]=DB_HIST[e].slice(0,10000); invalidateUserStatsCache(e); persistDebounced(HIST_FILE,DB_HIST,1500); }; // FIX-BUG8
const delHist    = e => { delete DB_HIST[e]; persist(HIST_FILE,DB_HIST); };
const getAutoJob = e => DB_AUTO[e]||null;
// v45-FIX (auditoria proativa, mesma classe do setUser() em 23/07: "site
// lento"): setAutoJob grava o AUTO_FILE INTEIRO em disco de forma SÍNCRONA
// (bloqueia o Node pra TODO MUNDO) a cada chamada — e é chamado váááárias
// vezes por CADA e-mail que CADA robô automático de CADA usuário manda (ver
// doAutoSend/scheduleAuto: status:"sending", depois "waiting_interval" ou
// erro/rate-limit, de novo a cada reagendamento). addHist logo acima já
// tinha recebido esse mesmo tratamento (FIX-BUG8) — setAutoJob, que roda
// com frequência MAIOR (é o motor do automático rodando 24/7 pra cada
// usuário ativo), tinha ficado pra trás. Estado do job é lido sempre da
// memória (getAutoJob) — nunca do disco — então debounce não muda nada pra
// quem usa o site; só evita travar o servidor inteiro a cada envio de
// qualquer robô. flushAll() já grava de verdade no SIGTERM/SIGINT (deploy).
const setAutoJob = (e,d) => { DB_AUTO[e]={...(DB_AUTO[e]||{}),...d}; persistDebounced(AUTO_FILE,DB_AUTO,5000); };
const delAutoJob = e => { delete DB_AUTO[e]; persistDebounced(AUTO_FILE,DB_AUTO,5000); };
// ══════════════════════════════════════════════════════════
// REGRA PRINCIPAL — Anti-duplicata absoluta
// Um usuário NUNCA envia para o mesmo empregador duas vezes
// a não ser que ele mesmo retire a vaga do histórico.
// Dupla camada: DB_SENT (memória/disco) + HIST (fallback)
// Sobrevive a: deploy, reinício, logout, troca de celular
// ══════════════════════════════════════════════════════════

// Normaliza email para comparação — remove espaços, lowercase, ponto final
const _normEmail = (e) => (e||"").toLowerCase().trim().replace(/\.+$/,"");

const hasSent = (u, d) => {
  const nd = _normEmail(d);
  if(!nd) return false;
  // Camada 1: DB_SENT em memória (rápido)
  if(DB_SENT[u]?.has(nd)) return true;
  // Camada 2: fallback direto no histórico (à prova de falhas)
  const hist = DB_HIST[u] || [];
  return hist.some(h => _normEmail(h.to) === nd);
};

// 🛡️ v184 LOTE 2 — "vaga enviada NUNCA reaparece" é a única coisa que o
// produto promete que não pode falhar, e ela dependia de um debounce de 2s.
// O comentário do motor dizia "salva ANTES de tentar envio (evita
// reprocessamento em crash)", mas o que era salvo em disco na hora era NADA:
// setAutoJob é debounced de propósito (DB_AUTO carrega a fila inteira de
// todo mundo) e markSent também era. Um kill duro (deploy sem SIGTERM, OOM do
// Render) na janela do debounce devolvia a vaga JÁ ENVIADA pra fila e o robô
// mandava a MESMA candidatura pro MESMO empregador.
// Aqui a gravação passa a ser SÍNCRONA — e só aqui: SENT_FILE é só conjuntos
// de e-mail (barato), e os ÚNICOS chamadores em produção são os dois pontos
// de envio bem-sucedido (automático e manual), ou seja, no máximo 1 gravação
// por candidatura que realmente saiu. setAutoJob continua debounced (o
// arquivo é ordens de grandeza maior e é escrito várias vezes por envio) —
// a fila pode voltar atrasada num crash, mas hasSent() corta a vaga como já
// enviada e o empregador nunca recebe duas vezes.
const markSent = (u, d) => {
  const nd = _normEmail(d);
  if(!nd) return;
  if(!DB_SENT[u]) DB_SENT[u] = new Set();
  DB_SENT[u].add(nd);
  persistSent();
};

// Set completo do que o usuário JÁ enviou (DB_SENT + fallback do histórico),
// construído UMA vez por chamada — para checar milhares de vagas sem custo
// (hasSent() sozinho reescanearia o histórico inteiro a cada vaga).
const buildUserSentSet = (u) => {
  const set = new Set(DB_SENT[u] ? [...DB_SENT[u]] : []);
  for (const h of (DB_HIST[u] || [])) { const n = _normEmail(h.to); if (n) set.add(n); }
  return set;
};

// 🔖 v126 (dono, 12/08: "salvou há meses TEM que aparecer"): acha uma vaga
// pelo ETA case number em TODAS as fontes carregadas (seasonal + planilhas
// fixas + extras) e devolve um snapshot compacto pro acervo de salvas.
// Usado pela auto-cura do GET /api/saved (vagas salvas ANTES do v126 só
// tinham o id — sem isso, sumiam da aba se saíssem da tela).
// v139: mapeamento linha-compacta → snapshot (fonte única — usado pelas
// Vagas Salvas E pelo Vagas Pra Você; nunca duplicar este shape).
function _vagaSnapshot(r,verEmail){
  const _e=String(r.e||"").trim().toLowerCase();
  return {id:r.c,caseNum:r.c,title:r.t||"Seasonal Worker",company:r.n||"",city:r.ci||"",state:r.s||"",
    wage:r.w?`$${r.w}/${r.wunit||"h"}`:"",email:verEmail===false?mascararEmail(_e):_e,
    hasEmail:!!(_e&&_e.includes("@")),emailBloqueado:verEmail===false&&!!_e,
    visa:r.visa||"",category:r.k||"other",
    url:r.c&&String(r.c).startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${r.c}`:""};
}

// ═══ 🔒 v182 LOTE 10 — O E-MAIL DO EMPREGADOR É O ATIVO QUE O CLIENTE PAGA ═══
// Provado com curl SEM cookie nenhum: /api/sheet-meta?sheet=jan2026&top=2000
// devolvia os e-mails de 2.000 empregadores em texto puro — 5 requisições e
// qualquer scraper levava os 9.240 da planilha inteira. A regra "ZERO envio
// grátis" protegia o ENVIO; a lista de contatos estava aberta.
// Agora o endereço COMPLETO só viaja pra sessão com plano ativo (isVipActive)
// ou admin. Pra visitante/grátis vai mascarado ("k••••@gmail.com") com
// `hasEmail:true` preservado: contagem, filtros e "só com e-mail" continuam
// IDÊNTICOS, porque nenhum deles lê o endereço — só a existência dele (o corte
// e as facetas rodam no servidor, sobre a linha real).
function mascararEmail(e){
  const s2=String(e||"").trim().toLowerCase();
  const i=s2.indexOf("@");
  if(i<1)return "";
  return s2[0]+"••••"+s2.slice(i);
}
// Cópia da vaga com o e-mail mascarado (nunca muta o objeto do cache — as
// listas do DOL e da planilha são compartilhadas entre TODOS os usuários).
function jobComEmailVisivel(job,ver){
  if(!job)return job;
  const e=String(job.email||"").trim().toLowerCase();
  if(ver||!e)return job;
  return {...job,email:mascararEmail(e),emailBloqueado:true};
}
// Uma pergunta só, usada por TODA rota que devolve vaga com e-mail.
function podeVerEmailVaga(req){
  try{
    const sess=getSess(req); if(!sess?.user_email) return false;
    const u=getUser(sess.user_email); if(!u) return false;
    return isAdminVip(u) || isVipActive(u);
  }catch(e){ return false; }
}
// 🎯 v139: cache do ranking "pra você" (10min por usuário) — só o RANKING é
// cacheado; o corte de enviados/fila (regra 8) roda fresco em toda resposta.
const _praVoceCache=new Map();

// ══════════════════════════════════════════════════════════
//  v13 — SISTEMA DE IDs ÚNICOS POR CANDIDATURA
//  Cada envio gera um appId estável e é indexado por:
//    threadId (Gmail), msgId (header Message-ID), to (destinatário)
//  Isso permite vincular uma resposta recebida → vaga original
// ══════════════════════════════════════════════════════════
function newAppId(){
  return "app_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
}

// ══════════════════════════════════════════════════════════
//  v15-SEC: Normalização e validação robusta de e-mail
//  Corrige: espaços, <>, maiúsculas, comprimento excessivo,
//  regex fraca que aceitava "@", "x@", "test@ x", etc.
// ══════════════════════════════════════════════════════════
const EMAIL_MAX_LEN = 254; // RFC 5321
const EMAIL_REGEX   = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * Normaliza um endereço de e-mail:
 *   - Remove espaços, caracteres <>"
 *   - Converte para minúsculas
 *   - Extrai apenas o endereço de "Nome <email@x>"
 * Retorna a string normalizada (pode ainda ser inválida — valide com isValidEmail).
 */
function normalizeEmail(raw){ return _normEmailMod(raw); } // corpo em src/gmail.js (Fase 1 · Módulo 2)

/**
 * Valida se uma string é um endereço de e-mail aceitável:
 *   - Comprimento ≤ 254 chars (RFC 5321)
 *   - Formato local@dominio.tld (mínimo 2 chars no TLD)
 *   - Sem espaços nem caracteres de controle
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  if (email.length > EMAIL_MAX_LEN) return false;
  return EMAIL_REGEX.test(email);
}

/**
 * Normaliza E valida.
 * Retorna { ok: true, email } ou { ok: false, reason }.
 */
// v18-FIX: conjunto de TODOS os e-mails do próprio usuário (principal + Gmails
// extras conectados) — usado pelas guardas de auto-envio (self-send). Antes
// só o principal era checado, então quem tem um 2º Gmail (recurso pago) podia
// acidentalmente "aplicar" pro próprio Gmail extra e perder 1 vaga do limite diário.
function _ownEmailsOf(ownerEmail){
  const u=getUser(ownerEmail)||{};
  return new Set([String(ownerEmail||"").toLowerCase(), ...((u.senderEmails||[]).map(x=>String(x.email||"").toLowerCase()).filter(Boolean))]);
}
function parseEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: "e-mail vazio" };
  if (email.length > EMAIL_MAX_LEN) return { ok: false, reason: `e-mail muito longo (${email.length} chars, máx ${EMAIL_MAX_LEN})` };
  if (!isValidEmail(email)) return { ok: false, reason: `formato inválido: "${email}"` };
  return { ok: true, email };
}

// Monta snapshot completo da vaga a partir de objetos vindos do client/auto-queue
function buildJobSnapshot(j){
  if(!j || typeof j !== "object") return null;
  // Aceita tanto formato vindo do /api/send (campos top-level) quanto de queue auto
  const snap = {
    title:   j.title || j.jobTitle || j.job || "",
    company: j.company || "",
    city:    j.city || "",
    state:   j.state || "",
    wage:    j.wage || "",
    visa:    j.visa || j.visaType || (j.jobType==="agricultural"?"H-2A":j.jobType==="non-agricultural"?"H-2B":""),
    workers: j.workers || null,
    start:   j.start || j.beginDate || "",
    end:     j.end || j.endDate || "",
    category:j.category || "",
    desc:    (j.desc || j.description || "").slice(0,1000),
    caseNum: j.caseNum || j.case_number || "",
    sourceEmail: (j.to || j.email || "").toLowerCase(),
    capturedAt: Date.now()
  };
  // Não retorna snapshot vazio (capturedAt não conta como dado real)
  const { capturedAt, ...realFields } = snap;
  const hasAny = Object.values(realFields).some(v => v && v !== 0 && (typeof v!=="object"));
  return hasAny ? snap : null;
}

// ── LOGS detalhados ───────────────────────────────────────
function addLog(userEmail, entry) {
  if (!DB_LOGS[userEmail]) DB_LOGS[userEmail] = [];
  const record = {
    id:          crypto.randomBytes(8).toString("hex"),
    ts:          Date.now(),
    date:        toLocaleBRT(Date.now()),
    hour:        toTimeBRT(Date.now()),
    to:          "",
    status:      "pendente",
    jobTitle:    "",
    company:     "",
    category:    "",
    state:       "",
    source:      "",
    profileUsed: "",
    subjectUsed: "",
    resumeName:  "",
    attachCount: 0,
    attempt:     1,
    error:       "",
    appId:       "",
    ...entry,
  };
  DB_LOGS[userEmail].unshift(record);
  if (DB_LOGS[userEmail].length > 500) DB_LOGS[userEmail] = DB_LOGS[userEmail].slice(0, 500); // 11/07: era 2000 — auto_logs.json chegou a 19MB e cada persist bloqueava 1,2s
  const critical = ["enviado","falhou","pausado","cancelado","erro_anexo"].includes(record.status);
  if (critical) persistLogsThrottled();
  else if (DB_LOGS[userEmail].length % 20 === 0) persistLogs();
}

// ── RASTREAMENTO DE JORNADA ──────────────────────────────────────────────────
function trackJourney(email, action, detail) {
  if(!email||!action) return;
  try {
    if(!DB_JOURNEY[email]) DB_JOURNEY[email]=[];
    const d=detail||{};
    DB_JOURNEY[email].unshift({
      ts:Date.now(), date:toLocaleBRT(Date.now()),
      action, ok:d.ok!==false,
      detail:d.detail||'', error:d.error||'', meta:d.meta||{}
    });
    if(DB_JOURNEY[email].length>500) DB_JOURNEY[email]=DB_JOURNEY[email].slice(0,500);
    persistDebounced(JOURNEY_FILE, DB_JOURNEY, 5000);
    if(d.ok===false && d.critical) pushGlobalEvent('user_error',email,`${action}: ${d.error||''}`, 'error');
  } catch(e){ console.warn('[trackJourney]',e.message); }
}

function getUserLogs(userEmail, filters={}) {
  const logs = DB_LOGS[userEmail] || [];
  let out = logs;
  if (filters.status)   out = out.filter(l => l.status === filters.status);
  if (filters.state)    out = out.filter(l => (l.state||"").toUpperCase() === filters.state.toUpperCase());
  if (filters.category) out = out.filter(l => l.category === filters.category);
  if (filters.source)   out = out.filter(l => l.source === filters.source);
  if (filters.q)        { const q=filters.q.toLowerCase(); out=out.filter(l=>(l.company||"").toLowerCase().includes(q)||(l.to||"").toLowerCase().includes(q)||(l.jobTitle||"").toLowerCase().includes(q)); }
  if (filters.dateFrom) out = out.filter(l => l.ts >= new Date(filters.dateFrom).getTime());
  if (filters.dateTo)   out = out.filter(l => l.ts <= new Date(filters.dateTo).getTime()+86400_000);
  const total = out.length;
  const skip = parseInt(filters.skip||0,10);
  const top  = Math.min(100, parseInt(filters.top||50,10));
  return { logs: out.slice(skip, skip+top), total, skip };
}
function exportLogsCSV(userEmail) {
  const logs = DB_LOGS[userEmail] || [];
  const hdr = ["ID","Data","Hora","Status","Empresa","Email","Vaga","Categoria","Estado","Origem","Perfil","Assunto","Anexos","Tentativa","Erro","AppID"];
  const rows = logs.map(l => [
    l.id, l.date, l.hour||"", l.status, l.company||"", l.to||"", l.jobTitle||"",
    l.category||"", l.state||"", l.source||"", l.profileUsed||"", l.subjectUsed||"",
    l.attachCount||0, l.attempt||1, l.error||"", l.appId||""
  ].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(","));
  return [hdr.join(","), ...rows].join("\n");
}

// v191 LOTE 9 — o antigo backup.json MORREU (só o persistLogs deste timer
// continua). Ele reserializava TODOS os usuários a cada 10min e gravava
// refresh_token do Google e hash de senha em TEXTO PURO (o persist() só cifra
// o USERS_FILE — este arquivo passava por fora do DATA_ENC_KEY), num arquivo
// que NINGUÉM lia: nem o boot, nem o restore, nem o painel. Era só custo de
// disco/CPU e uma cópia em claro dos segredos de todo mundo. O backup de
// verdade (criarBackupCompleto + rotas /api/admin/v2/backup/*) cobre tudo,
// com os campos sensíveis já cifrados, e é ele que o RESTAURACAO_BACKUP.md usa.
setInterval(()=>{ try{persistLogs();}catch{} },10*60*1000);

// ── BACKUP COMPLETO AUTOMÁTICO (2026-07-08, a pedido do Andrio) ────────────
// (O antigo backup.json de 10 em 10min foi APOSENTADO no v191 LOTE 9 — ele
// reserializava todos os usuários gravando refresh_token e hash de senha em
// TEXTO PURO, por fora do DATA_ENC_KEY, num arquivo que ninguém jamais leu;
// hoje o boot apaga o que sobrou dele.) Já existia um sistema de backup
// completo (copia TODOS os .json em pastas com data + restauração), só que
// vivia dentro do
// painel /admin-v2 — uma URL separada que não é a que o Andrio usa no dia a
// dia (/admin). Ou seja: existia, mas não "enraizado" — dependia de alguém
// visitar uma página que ninguém visita. Agora roda sozinho, todo dia, sem
// precisar de ninguém clicar em nada. Restaurar é pelas rotas
// /api/admin/v2/backup/* (mod-admin-v2.js) — ver RESTAURACAO_BACKUP.md, que
// tem o roteiro ensaiado de verdade. NÃO existe tela de backup no admin.html
// (o comentário antigo mandava procurar uma "aba Configurações" que nunca
// existiu — procurar tela que não existe é o pior jeito de descobrir isso no
// meio de uma emergência).
// ══ v70 — VIGIA DE DISCO (edição única, sem irmãos pra vigiar) ═══════════
// Caso real (26/07 de manhã): confirma que o disco não está enchendo antes
// do ENOSPC derrubar o servidor — checa a cada 15 min; <200MB livres →
// avisa no log 1x/dia (a versão que vigiava servidores-irmãos foi removida,
// esta arquitetura é single-server).
let _diskAvisoDia=null;
function _checarDiscoProprio(){
  try{
    if(!fs.statfsSync)return;
    const st=fs.statfsSync(DATA_DIR);
    const freeMB=Math.round(st.bavail*st.bsize/1048576);
    const dia=todayStrBRT();
    if(freeMB<200&&_diskAvisoDia!==dia){
      _diskAvisoDia=dia;
      console.warn(`[disco] ⚠️ servidor com só ${freeMB}MB livres!`);
    }
  }catch(e){}
}
setInterval(_checarDiscoProprio,15*60*1000);
setTimeout(()=>{try{_checarDiscoProprio();}catch(e){}},90*1000); // 1ª checagem logo após o boot

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_RETENCAO = 3; // 11/07: era 20 — com history/auto_jobs/logs de 30MB+ cada, 20 dias de cópias ENCHERAM o disco do Render (ENOSPC real em produção). 3 dias cobre recuperação sem afogar o disco.
// Arquivos que NÃO entram no backup: efêmeros/regeneráveis ou redundantes.
const BACKUP_EXCLUIR = new Set(["auto_logs.json","backup.json","bot_logs.json"]);
function _diskFreeMB(){
  try{ const st=fs.statfsSync(DATA_DIR); return Math.round(st.bavail*st.bsize/1048576); }
  catch{ return null; } // statfs indisponível → não bloqueia
}
// v191 LOTE 9: ASSÍNCRONO. Copiar todos os .json + a pasta cvs/ inteira com
// fs.cpSync/copyFileSync travava o event loop pra TODOS os usuários (2min
// depois de cada boot é justamente a janela em que todo mundo reconecta
// pós-deploy). Mesmo trabalho, com as versões de fs.promises.
async function criarBackupCompleto(){
  try{
    if(!fs.existsSync(DATA_DIR)) return {ok:false,error:"DATA_DIR inexistente"};
    fs.mkdirSync(BACKUP_DIR,{recursive:true});
    // 11/07: poda ANTES de copiar (antes só podava depois — num disco já cheio,
    // a cópia falhava antes de a poda ter chance de rodar) + guarda de espaço.
    try{
      const _antigos=fs.readdirSync(BACKUP_DIR).filter(d=>/^\d{4}-/.test(d)).sort();
      const _exc=_antigos.length-(BACKUP_RETENCAO-1);
      if(_exc>0) for(const v of _antigos.slice(0,_exc)){ try{ fs.rmSync(path.join(BACKUP_DIR,v),{recursive:true,force:true}); }catch{} }
    }catch{}
    const _freeMB=_diskFreeMB();
    if(_freeMB!==null&&_freeMB<150){
      console.warn(`[backup] ⛔ pulado — só ${_freeMB}MB livres no disco (mínimo 150MB). Espaço vale mais que backup agora.`);
      return {ok:false,error:"disco quase cheio ("+_freeMB+"MB livres) — backup pulado"};
    }
    const stamp=new Date(Date.now()-3*3600_000).toISOString().replace(/[:T]/g,"-").slice(0,19); // nome já em horário BRT
    const dir=path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dir,{recursive:true});
    let n=0;
    for(const f of fs.readdirSync(DATA_DIR)){
      if(!f.endsWith(".json")) continue;
      if(BACKUP_EXCLUIR.has(f)) continue; // 11/07: logs efêmeros não merecem 3 cópias
      try{ await fsp.copyFile(path.join(DATA_DIR,f), path.join(dir,f)); n++; }
      catch(e){ console.warn("[backup] falhou copiar",f,e.message); }
    }
    // v21 (07/2026): os PDFs agora vivem SÓ em CVS_DIR (saíram do users.json),
    // então o backup precisa cobrir a pasta cvs/ — e mesmo assim fica MENOR que
    // antes (base64 no JSON inflava cada PDF em ~33%, copiado 3x na retenção).
    try{
      if(fs.existsSync(CVS_DIR)){
        await fsp.cp(CVS_DIR, path.join(dir,"cvs"), {recursive:true});
        n+=fs.readdirSync(CVS_DIR).length;
      }
    }catch(e){ console.warn("[backup] falhou copiar pasta cvs/:",e.message); }
    // 🧾 v192 LOTE 10: os comprovantes de pedido também vivem em disco agora —
    // backup que ignorasse esta pasta devolveria pedidos SEM prova de pagamento
    // (mesma lição do v27-FIX com a pasta cvs/).
    try{
      if(fs.existsSync(COMPROVANTES_DIR)){
        await fsp.cp(COMPROVANTES_DIR, path.join(dir,"comprovantes"), {recursive:true});
        n+=fs.readdirSync(COMPROVANTES_DIR).length;
      }
    }catch(e){ console.warn("[backup] falhou copiar pasta comprovantes/:",e.message); }
    // Poda: mantém só os BACKUP_RETENCAO mais recentes, apaga o resto
    try{
      const todos=fs.readdirSync(BACKUP_DIR).filter(d=>/^\d{4}-/.test(d)).sort();
      const excedente=todos.length-BACKUP_RETENCAO;
      if(excedente>0) for(const velho of todos.slice(0,excedente)){
        try{ fs.rmSync(path.join(BACKUP_DIR,velho),{recursive:true,force:true}); }catch(e){}
      }
    }catch(e){}
    console.log(`[backup] ✅ backup completo: ${stamp} (${n} arquivo(s))`);
    return {ok:true,name:stamp,files:n};
  }catch(e){ console.error("[backup] FALHA ao criar backup completo:",e.message); return {ok:false,error:e.message}; }
}
// ── FAXINA DE DISCO (11/07) — roda no boot e quando persist falha (ENOSPC) ──
let _lastDiskCleanup=0;
function emergencyDiskCleanup(motivo){
  if(Date.now()-_lastDiskCleanup<10*60_000) return false; // no máx 1x/10min
  _lastDiskCleanup=Date.now();
  let liberado=0;
  try{
    // 1. Backups: mantém só o MAIS RECENTE em emergência
    if(fs.existsSync(BACKUP_DIR)){
      const dirs=fs.readdirSync(BACKUP_DIR).filter(d=>/^\d{4}-/.test(d)).sort();
      for(const v of dirs.slice(0,Math.max(0,dirs.length-1))){
        try{ fs.rmSync(path.join(BACKUP_DIR,v),{recursive:true,force:true}); liberado++; }catch{}
      }
    }
    // 2. Logs: corta todos os usuários para 200 entradas
    let cortados=0;
    for(const em of Object.keys(DB_LOGS)){
      if((DB_LOGS[em]||[]).length>200){ DB_LOGS[em]=DB_LOGS[em].slice(0,200); cortados++; }
    }
    // 3. auto_jobs: remove jobs FINALIZADOS há mais de 14 dias (fila já vazia; só ocupam espaço)
    let jobsRemovidos=0;
    for(const [em,job] of Object.entries(DB_AUTO)){
      if(job&&!job.active&&job.status==="finished"&&job.finishedAt&&Date.now()-job.finishedAt>14*86400_000){
        delete DB_AUTO[em]; jobsRemovidos++;
      }
    }
    if(jobsRemovidos)persist(AUTO_FILE,DB_AUTO);
    if(cortados)persistLogsImmediate();
    console.warn(`[disk] 🧹 Faxina de emergência (${motivo}): ${liberado} backup(s) antigos removidos, logs de ${cortados} usuário(s) cortados, ${jobsRemovidos} job(s) finalizados antigos removidos. Livre agora: ${_diskFreeMB()??"?"}MB`);
    return true;
  }catch(e){ console.error("[disk] faxina falhou:",e.message); return false; }
}
// Boot: compacta logs no ato (o cap novo de 500 só vale pra entradas novas)
setTimeout(()=>{
  try{
    let c=0;for(const em of Object.keys(DB_LOGS)){if((DB_LOGS[em]||[]).length>500){DB_LOGS[em]=DB_LOGS[em].slice(0,500);c++;}}
    if(c){persistLogsImmediate();console.log(`[disk] logs compactados no boot: ${c} usuário(s) acima de 500 entradas`);}
    const free=_diskFreeMB();
    if(free!==null)console.log(`[disk] espaço livre no volume: ${free}MB`);
    if(free!==null&&free<300)emergencyDiskCleanup("boot com <300MB livres");
  }catch(e){console.warn("[disk] compactação de boot:",e.message);}
},90_000);

// v191 LOTE 9 — idade (em horas) do backup mais recente, ou null se não há
// nenhum. Só olha pastas no padrão da poda (/^\d{4}-/) — a mesma que a
// retenção e a faxina de emergência enxergam.
function _horasDesdeUltimoBackup(){
  try{
    const dirs=fs.readdirSync(BACKUP_DIR).filter(d=>/^\d{4}-/.test(d));
    if(!dirs.length) return null;
    let maisNovo=0;
    for(const d of dirs){
      try{ const st=fs.statSync(path.join(BACKUP_DIR,d)); if(st.mtimeMs>maisNovo) maisNovo=st.mtimeMs; }catch{}
    }
    return maisNovo ? (Date.now()-maisNovo)/3600_000 : null;
  }catch{ return null; }
}
// Roda o backup de boot só se fizer sentido (ver comentário abaixo).
const BACKUP_BOOT_MIN_H = 12;
// No npm test o atraso é configurável pra provar a decisão de verdade; em
// produção continua sendo 2 minutos, como sempre foi.
const _BACKUP_BOOT_DELAY = (process.env.TEST_LOGIN_TOKEN && process.env.BACKUP_BOOT_MS) ? Number(process.env.BACKUP_BOOT_MS) : 2*60_000;
const _rodarBackup = (motivo) => criarBackupCompleto().catch(e=>console.error(`[backup] falha inesperada (${motivo}):`,e?.message||e));
(function agendarBackupDiario(){
  // 1x por dia, ~03:00 BRT (06:00 UTC) — horário de menor uso.
  const now=new Date();
  const proxima=new Date(now);
  proxima.setUTCHours(6,5,0,0);
  if(proxima<=now) proxima.setUTCDate(proxima.getUTCDate()+1);
  setTimeout(function tickDiario(){
    _rodarBackup("diário");
    setInterval(()=>_rodarBackup("diário"), 24*3600_000);
  }, proxima-now);
  // Backup também logo no boot (rede de segurança se o servidor ficar dias
  // sem passar pelas 3h — ex.: redeploys frequentes).
  // ⚠️ v191 LOTE 9: mas SÓ se o mais recente já tiver ≥12h. Este repo faz
  // deploy a cada commit e a retenção é de 3 pastas: numa tarde de 3 commits,
  // 3 backups novos (todos do mesmo estado de hoje) empurravam pra fora os
  // backups de ONTEM — exatamente o que alguém procura quando algo dá errado.
  setTimeout(()=>{
    const h=_horasDesdeUltimoBackup();
    if(h!==null && h < BACKUP_BOOT_MIN_H){
      console.log(`[backup] boot: já existe backup de ${h.toFixed(1)}h atrás — pulado (a retenção de ${BACKUP_RETENCAO} guarda os dias anteriores).`);
      return;
    }
    _rodarBackup("boot");
  }, _BACKUP_BOOT_DELAY);
})();

// ═══════════════════════════════════════════════════════════════════════════
// 🔄 RECONCILIAÇÃO PLANOS × PEDIDOS PAGOS (11/07 — incidente do disco cheio)
// O ENOSPC engoliu ativações de plano (caso Wagner: R$600 pagos, conta FREE).
// Esta rotina reconstrói, pedido pago por pedido pago, a expiração que cada
// usuário DEVERIA ter (renovações encadeadas: cada pedido soma a partir do
// max(expiração corrente, data do pedido)) e DEVOLVE o que faltar.
// REGRAS DE SEGURANÇA:
//   • Só ADICIONA dias/plano — nunca reduz nada de ninguém (Math.max em tudo).
//   • Só considera pedidos com status pago/ativo (trial/código ficam de fora).
//   • Nunca rebaixa plano: se o atual ativo é "maior" (doublepro > vipro > vip),
//     mantém o atual e só estende as datas.
//   • Idempotente: rodar 10x dá o mesmo resultado — seguro no boot de todo deploy.
const _PLAN_RANK={vip:1,pro:2,vipro:2,doublepro:3};
function reconciliarPlanosComPedidos(apply){
  const _t=v=>{if(!v)return 0;const x=typeof v==="number"?v:Date.parse(v);return isNaN(x)?0:x;};
  const byUser={};
  for(const ped of Object.values(DB_PEDIDOS||{})){
    if(!ped||!ped.userEmail)continue;
    const st=String(ped.status||"").toLowerCase();
    if(st!=="pago"&&st!=="ativo")continue;
    // 💎 v154 (BUG REAL, dono 21/08: "na hora que eu aceitei a doação o site
    // colocou mais 30 dias pra ele"): DOAÇÃO NUNCA entra na reconciliação.
    // Doação não tem campo `dias`, então caía no padrão de 30 — cada doação
    // aprovada virava +30 dias manuais AQUI, em TODO boot, inclusive
    // re-desfazendo correções manuais do admin. Doação = só diamantes.
    if(ped.tipo==="doacao"||String(ped.plano||"").toLowerCase()==="doacao")continue;
    const e=String(ped.userEmail).toLowerCase();
    (byUser[e]=byUser[e]||[]).push(ped);
  }
  const relatorio=[];
  for(const [email,peds] of Object.entries(byUser)){
    const u=getUser(email);if(!u)continue;
    peds.sort((a,b)=>(_t(a.ativadoEm)||_t(a.pagoEm)||_t(a.criadoEm))-(_t(b.ativadoEm)||_t(b.pagoEm)||_t(b.criadoEm)));
    let expManual=0,expAuto=0,planoPed=null;
    for(const pd of peds){
      const t=_t(pd.ativadoEm)||_t(pd.pagoEm)||_t(pd.criadoEm);if(!t)continue;
      const dias=Number(pd.diasTotal)||((Number(pd.diasBase)||30)+(Number(pd.diasBonus)||0));
      const pk=String(pd.planoKey||pd.plano||"vipro").toLowerCase();
      expManual=Math.max(expManual,t)+dias*86400_000;
      if(pk!=="vip")expAuto=Math.max(expAuto,t)+dias*86400_000;
      if(!planoPed||(_PLAN_RANK[pk]||0)>=(_PLAN_RANK[planoPed]||0))planoPed=pk;
    }
    const curM=u.vip?.manualExpires||0,curA=u.vip?.autoExpires||0;
    const TOL=60_000;
    const needM=expManual>curM+TOL,needA=expAuto>curA+TOL;
    const deviaEstarAtivo=expManual>Date.now();
    const planAtualRank=isVipActive(u)?(_PLAN_RANK[String(u.plan||"").toLowerCase()]||0):0;
    const planFinal=deviaEstarAtivo&&(_PLAN_RANK[planoPed]||0)>planAtualRank?planoPed:(u.plan||"free");
    const planWrong=deviaEstarAtivo&&planFinal!==(u.plan||"free");
    if(!(needM||needA||planWrong))continue;
    const novoM=Math.max(curM,expManual),novoA=Math.max(curA,expAuto);
    const item={email,name:u.name||"",plano:planoPed,pedidos:peds.length,
      antes:{plan:u.plan||"free",manualExpires:curM,autoExpires:curA},
      depois:{plan:planFinal,manualExpires:novoM,autoExpires:novoA},
      diasManualDevolvidos:needM?Math.max(0,diasRestantesCanonico(novoM,Math.max(curM,Date.now()))):0,
      diasAutoDevolvidos:needA?Math.max(0,diasRestantesCanonico(novoA,Math.max(curA,Date.now()))):0};
    relatorio.push(item);
    if(apply){
      setUser(email,{plan:planFinal,
        vip:{...(u.vip||{}),active:deviaEstarAtivo||isVipActive(u),plan:deviaEstarAtivo?planoPed:(u.vip?.plan||planoPed),
             manualExpires:novoM,autoExpires:novoA,
             source:u.vip?.source||"payment",reconciledAt:Date.now(),reconciledBy:"reconciliacao_pedidos"}});
      try{trackJourney(email,"plan_reconciled",{detail:`${planoPed} — dias restaurados pelos ${peds.length} pedido(s) pago(s)`,meta:{manualAte:new Date(novoM).toISOString().slice(0,10),autoAte:novoA?new Date(novoA).toISOString().slice(0,10):null}});}catch{}
      try{addLog(email,{status:"sistema",jobTitle:"✅ Seus dias de plano foram verificados e restaurados",company:"Conferimos seus pagamentos e devolvemos todos os dias que faltavam. Obrigado pela paciência!"});}catch{}
    }
  }
  if(apply&&relatorio.length){
    const saved=persist(USERS_FILE,DB_USERS);
    console.log(`[reconciliar] 🔄 ${relatorio.length} usuário(s) corrigidos · gravado no disco: ${saved?"SIM":"⚠️ NÃO — faxina vai tentar de novo"}`);
    try{pushGlobalEvent("plan_reconciled","sistema",`🔄 Reconciliação: ${relatorio.length} pagante(s) tiveram os dias de plano restaurados`,"info");}catch{}
  }
  return relatorio;
}
// Roda sozinho em TODO boot (idempotente): se um restart engoliu plano, o
// próximo boot devolve — sem depender de ninguém perceber e reclamar.
setTimeout(()=>{try{
  const r=reconciliarPlanosComPedidos(true);
  console.log(`[reconciliar] boot: ${r.length} correção(ões)${r.length?" → "+r.map(x=>x.email).join(", "):""}`);
}catch(e){console.error("[reconciliar] falha no boot:",e.message);}},120_000);

// FIX-BUG15 v2: limpeza inteligente de DB_SENT por data de envio
// Remove apenas emails enviados há mais de 6 meses, preservando os recentes.
// NUNCA apaga tudo — evita reenvio para empresas antigas.
setInterval(()=>{
  try {
    const SIX_MONTHS = 180 * 86400_000;
    const cutoff = Date.now() - SIX_MONTHS;
    let cleaned = 0;
    for(const [ue, sentSet] of Object.entries(DB_SENT)){
      const u = getUser(ue); const j = getAutoJob(ue);
      // Só processa usuários sem automático ativo e que não aparecem há 6 meses
      if(j?.active || !u?.lastSeenAt || u.lastSeenAt >= cutoff) continue;
      // Reconstrói Set mantendo só emails enviados nos últimos 6 meses (via HIST)
      const hist = getHist(ue);
      const recentEmails = new Set();
      for(const entry of hist){
        let ts = 0;
        if(entry.sentAt){ const p=new Date(entry.sentAt).getTime(); if(!isNaN(p)) ts=p; }
        if(!ts && entry.dateStr){
          const pts=entry.dateStr.split("/");
          if(pts.length===3){ const r=new Date(`${pts[2]}-${pts[1]}-${pts[0]}T12:00:00Z`).getTime(); if(!isNaN(r)) ts=r; }
        }
        if(ts >= cutoff){ const nd=_normEmail(entry.to||""); if(nd) recentEmails.add(nd); }
      }
      const removed = sentSet.size - recentEmails.size;
      if(removed > 0){
        DB_SENT[ue] = recentEmails;
        cleaned += removed;
        console.log(`[mem-clean] ${ue}: ${removed} antigos removidos (${recentEmails.size} recentes mantidos)`);
      }
    }
    if(cleaned>0){persistSent();console.log(`[mem-clean] Total: ${cleaned} entradas antigas removidas`);}
  }catch(e){console.warn("[mem-clean]",e.message);}
}, 6*60*60*1000);

// ══════════════════════════════════════════════════════════
//  VIP STACK — manual days + auto days são independentes
//  Um usuário pode ter: vip.manualExpires e vip.autoExpires
//  separados. O admin pode dar só manual, só auto ou ambos.
// ══════════════════════════════════════════════════════════


// v72: o polling de inbox (verificava novas respostas a cada 2 min pra
// disparar push) foi DESLIGADO — exigia gmail.readonly, que o app não pede
// mais (ordem do dono: só enviar, nunca ler a caixa de entrada de ninguém).
// A aba Respostas que esse push abria também foi removida do site.


// Verifica se manual VIP está ativo
function isAdminVip(u) {
  // Admin sempre tem VIP ativo infinito (sem expiração)
  return !!(u?.isAdmin || isAdminEmail(u?.email||""));
}

function isManualVipActive(u) {
  if (isAdminVip(u)) return true; // Admin = infinito
  if (!u) return false;
  const now = Date.now();
  // Stack novo: vip.manualExpires
  if (u.vip?.manualExpires && now < u.vip.manualExpires) return true;
  // Compatibilidade com sistema antigo (plano vip ou vipro)
  if (u.vip?.active && now < (u.vip.expiresAt||0) && ["vip","vipro"].includes(u.vip?.plan||"vip")) return true;
  return false;
}
// Verifica se auto VIP (pro/vipro) está ativo
function isAutoVipActive(u) {
  if (!u) return false;
  if (isAdminVip(u)) return true; // Admin = infinito
  const now = Date.now();
  // Stack novo: vip.autoExpires
  if (u.vip?.autoExpires && now < u.vip.autoExpires) return true;
  // Compatibilidade com sistema antigo
  if (u.vip?.active && now < (u.vip.expiresAt||0) && ["pro","vipro"].includes(u.vip?.plan||"")) return true;
  return false;
}
function isVipActive(u) { return isManualVipActive(u) || isAutoVipActive(u); }

// 🔒 v172h (ordem do dono, 12/09/2026 — "diz pra ela que o plano dela
// venceu dia tal, e pra ela ir pra planos contratar um plano novo"): gate
// de plano (/api/send, /api/auto/start, scheduleAuto) cita a data real de
// vencimento quando o usuário já teve um plano — nunca um "expirou"
// genérico pra quem já sabe exatamente quando isso aconteceu.
// 🚨 v172k (auditoria 13/09/2026, achado real): a versão original pegava
// Math.max(autoExpires,manualExpires,expiresAt) sem saber QUAL dimensão
// estava sendo negada — um VIP Manual ATIVO (manualExpires no FUTURO)
// tentando ligar o automático lia "Seu plano venceu em <data futura>",
// porque o Math.max pegava a data do manual (que nem venceu) só porque
// era a maior das três. `dimensao` ('auto'|'manual') diz qual expiração é
// a relevante pro gate que está chamando; só fala "venceu" quando ELA
// mesma já passou. Se a dimensão pedida nunca esteve ativa mas OUTRA está
// (o caso real: VIP só-manual pedindo automático), a mensagem é sobre o
// que falta, nunca sobre uma data que ainda não chegou.
// 💳 v187: "o provisório venceu mas o pedido ainda está na mesa do admin".
// Só devolve algo quando as DUAS coisas são verdade (vip veio do robô do
// comprovante E o pedido que o originou continua `pendente`) — try/catch
// porque nenhum gate de envio pode quebrar por causa de uma consulta de
// texto.
function _provisorioPendente(p){
  try{
    if(String(p?.vip?.source||"")!=="auto-provisorio")return null;
    const id=p?.vip?.pedidoId; if(!id)return null;
    const pd=(DB_PEDIDOS||[]).find(x=>x&&x.id===id);
    if(!pd||pd.status!=="pendente")return null;
    return {pedidoId:id,ref:String(id).slice(-8).toUpperCase()};
  }catch(e){ return null; }
}
function planGateMsg(p, semPlanoMsg, dimensao) {
  const now = Date.now();
  const manualExp = p?.vip?.manualExpires || 0;
  const autoExp = p?.vip?.autoExpires || 0;
  const relevante = dimensao === "auto" ? autoExp : dimensao === "manual" ? manualExp : Math.max(manualExp, autoExp, p?.vip?.expiresAt || 0);
  // 💳 v187: quem JÁ PAGOU e está só esperando a confirmação humana nunca pode
  // ler "seu plano venceu — assine de novo". A janela provisória de 3 dias
  // existe pra pessoa usar o site enquanto o admin não confere; se a conferência
  // demora mais que isso, a mensagem de sempre empurrava pra um SEGUNDO
  // pagamento alguém cujo pedido está na mesa. Ordem "ZERO envio grátis"
  // intacta: continua 402, continua bloqueado — muda só o que o cliente lê.
  const _prov = _provisorioPendente(p);
  if (_prov && relevante > 0 && relevante <= now)
    return `Seu período provisório de ${AUTO_ATIVA_DIAS} dias terminou, mas o seu pedido #${_prov.ref} já está com a nossa equipe para confirmação — não precisa pagar de novo. Assim que confirmarmos, o período completo do seu plano é liberado.`;
  if (relevante > 0 && relevante <= now) return `Seu plano venceu em ${new Date(relevante).toLocaleDateString("pt-BR")}. ${semPlanoMsg}`;
  if (dimensao === "auto" && manualExp > now) return `Seu plano VIP é só manual — ${semPlanoMsg}`;
  return semPlanoMsg;
}

// Admin tem plano máximo para fins de limites diários
function getAdminPlan() { return "doublepro"; }

// Retorna plano efetivo baseado no stack
function getPlan(u) {
  if (isAdminVip(u)) return getAdminPlan(); // Admin = plano máximo sempre
  const manual = isManualVipActive(u);
  const auto   = isAutoVipActive(u);
  // doublepro é o ÚNICO que precisa do plano salvo (limites 400/400) — atalho só p/ ele
  if (u.plan === 'doublepro' && isVipActive(u)) return 'doublepro';
  // Calcula pelo que está REALMENTE ativo (corrige o caso VIP+Pro = vipro, antes
  // o atalho 'return u.plan' devolvia "vip" e travava o automático em 10/dia).
  if (manual && auto) return 'vipro';
  if (auto)           return 'vipro'; // auto ativo (inclui legado "pro") → limite auto 200
  if (manual)         return 'vip';
  return 'free';
}

// v118: CONTRATO CONGELADO — plano ativado a partir da mudança grava
// vip.limits {manual,auto} (tabela nova) na ativação; plano antigo não tem
// vip.limits e cai na tabela LEGADA (ninguém que já pagou perde nada).
function limitesDoPlanoNovo(planKey){
  const t=PLAN_LIMITS_NEW[planKey]||PLAN_LIMITS_NEW.vip;
  return { manual:t.manual, auto:t.auto };
}
// 💳 v187 — QUEM CARIMBA `vip.limits` NUMA CONCESSÃO MANUAL DO ADMIN.
// Régua única (usada por /api/admin/vip/activate e /api/admin/vip/set-expiry;
// a aprovação de pedido e o set-plan já carimbavam direto porque ali o plano
// vendido é sempre o da tabela nova). Três casos, nesta ordem:
//  (a) conta que JÁ tem contrato novo (vip.limits) e está trocando de tier:
//      recarimba com a tabela nova DO TIER NOVO — senão um VIP(100/0) virando
//      DoublePro ficaria com 100/0, recebendo menos do que o tier concedido;
//      mesmo tier = mantém o carimbo (contrato congelado, v118).
//  (b) conta LEGADA com plano ATIVO (sem vip.limits): NÃO carimba. Carimbo
//      cego aqui cortaria pela metade o limite de quem pagou antes da tabela
//      nova só por renovar — "nenhum pagante perde nada" (mod-config.js).
//  (c) conta sem plano ativo (nova, expirada ou legada já vencida): carimba a
//      tabela nova — ativação nova vale o contrato de hoje.
function limitsParaAtivacaoAdmin(target, planName){
  const atuais=target?.vip?.limits;
  if(atuais&&typeof atuais.manual==="number"){
    return String(target?.vip?.plan||"")===String(planName)?{}:{limits:limitesDoPlanoNovo(planName)};
  }
  return isVipActive(target)?{}:{limits:limitesDoPlanoNovo(planName)};
}
// ⚠️ v172 (auditoria 11/09/2026): os `|| 20`/`|| 10` daqui escondiam ZERO
// como se fosse "sem valor" (0 é falsy em JS) — com o plano free virando
// {manual:0,auto:0} (regra "só quem paga usa"), esses fallbacks
// RESSUSCITAVAM 20 manuais/10 automáticos grátis por trás das costas.
// `??` só cai no fallback se o valor for null/undefined de verdade (plano
// desconhecido, nunca deveria acontecer — todos os planos estão na tabela).
// 🚨 v172i (auditoria 12/09/2026 — VAZAMENTO DE RECEITA real): getPlan()
// devolve um NOME de plano só, mas manual e automático vencem em datas
// independentes (vip.manualExpires × vip.autoExpires). Com o automático
// ativo e o manual VENCIDO, getPlan() ainda devolve 'vipro' (o ramo
// `if(auto) return 'vipro'` roda antes do `if(manual)`), e a tabela
// PLAN_LIMITS.vipro.manual=200 liberava 200 envios MANUAIS/dia de graça
// pra quem só pagou (ou só ainda tem) o automático — plano legado "pro"
// (auto-only) caía nisso desde sempre. O atalho do doublepro
// (`u.plan==='doublepro' && isVipActive(u)` — OU, não E) vazava 400 pelo
// mesmo caminho nos 2 sentidos. Diferente do automático (que scheduleAuto
// re-checa com isAutoVipActive), o manual NÃO tem segunda trava —
// /api/send confia só neste número. Regra nova, nos 2 getters: a
// dimensão que NÃO está ativa de verdade devolve 0 ANTES de olhar
// qualquer tabela por nome de plano — nunca herda o limite da outra.
const getManualLimit = u => {
  if (u?.vip?.limits && typeof u.vip.limits.manual==="number" && isManualVipActive(u)) return u.vip.limits.manual;
  if (!isManualVipActive(u)) return 0; // isManualVipActive já devolve true pra admin
  return PLAN_LIMITS[getPlan(u)]?.manual ?? 0;
};
const getAutoLimit   = u => {
  if (isAdminVip(u)) {
    // 🎯 ordem do dono, 12/09/2026: 450/dia por CADA e-mail conectado
    // (principal + extras ativos), não mais um total fixo de 9999 (que
    // na prática nunca pausava nada). Soma os tetos por sender — o
    // enforcement de verdade (nenhum sender isolado passa do próprio
    // teto) mora em getSenderToken; isto aqui é só o total agregado
    // pras telas/gates que comparam "enviei hoje >= limite".
    // 🐛 v172e: mesma classe de bug do getSenderToken (auditoria 12/09) —
    // pra admin v172c (login por username, sem @), u.email não é o Gmail
    // que perSenderAutoLimit espera receber (um admin que customiza o
    // teto do PRINCIPAL em adminSettings.senderLimits digita o Gmail real,
    // que é o que aparece na tela — nunca o username de login).
    const senders=[{email:resolveSendGmail(u)||u.email},...(u.senderEmails||[]).filter(s=>!s.blocked&&!s.tokenExpired)];
    return senders.reduce((sum,s)=>sum+perSenderAutoLimit(u,s.email),0);
  }
  if (u?.vip?.limits && typeof u.vip.limits.auto==="number" && isAutoVipActive(u)) return u.vip.limits.auto;
  // 🚨 v172i: mesma regra do getManualLimit — automático vencido nunca herda
  // o limite do atalho doublepro (u.plan salvo + OU do isVipActive) nem de
  // nenhuma tabela por nome. (admin já saiu com return no bloco acima.)
  if (!isAutoVipActive(u)) return 0;
  return PLAN_LIMITS[getPlan(u)]?.auto ?? 0;
};
// Teto diário de automático de UM sender específico do admin — usa o
// customizado em adminSettings.senderLimits[email] se existir (>0),
// senão o padrão ADMIN_AUTO_DAILY_LIMIT_PER_SENDER (450).
const perSenderAutoLimit = (u,senderEmail) => {
  const custom=u?.adminSettings?.senderLimits?.[String(senderEmail||"").toLowerCase().trim()];
  return (Number.isFinite(custom)&&custom>0) ? custom : ADMIN_AUTO_DAILY_LIMIT_PER_SENDER;
};

// Adiciona dias de manual VIP ao stack
function addManualVipDays(email, days) {
  const u = getUser(email) || {};
  const now = Date.now();
  const current = (u.vip?.manualExpires && u.vip.manualExpires > now) ? u.vip.manualExpires : now;
  const newExpires = current + days * 86400_000;
  const vip = { ...(u.vip || {}), manualExpires: newExpires, active: true };
  setUser(email, { vip });
  return newExpires;
}
// Adiciona dias de auto VIP ao stack
function addAutoVipDays(email, days) {
  const u = getUser(email) || {};
  const now = Date.now();
  const current = (u.vip?.autoExpires && u.vip.autoExpires > now) ? u.vip.autoExpires : now;
  const newExpires = current + days * 86400_000;
  const vip = { ...(u.vip || {}), autoExpires: newExpires, active: true };
  setUser(email, { vip });
  return newExpires;
}

// ── EXTRATO DE DIAS (ledger de proveniência) ──────────────────────────
// Registra CADA concessão de dias VIP com sua história: pago vs grátis,
// de onde veio (origem), quem deu (dadoPor), por quê (motivo) e quando.
// Fonte única para exibir "60 pagos + 2 indicação" no perfil e no modal.
// Append-only — nunca apaga, só soma (mesma política do KB).
// Importante: chamar SEMPRE depois do setUser principal do vip, para que
// o spread ...(tgt.vip||{}) já tenha preservado os créditos anteriores.
function addCredito(email, c){
  const u = getUser(email) || {};
  const vip = u.vip || {};
  const creditos = Array.isArray(vip.creditos) ? vip.creditos.slice(-299) : [];
  const credito = {
    id: "cred_"+Date.now().toString(36)+"_"+crypto.randomBytes(3).toString("hex"),
    quando: Date.now(),
    dias: Math.round(Number(c.dias)||0),
    tipo: c.tipo === "pago" ? "pago" : "gratis",        // pago | gratis
    origem: c.origem || "admin",                         // pagamento|bonus|trial|indicacao|admin|codigo
    motivo: String(c.motivo||"").slice(0,200),
    dadoPor: c.dadoPor || "sistema",                     // Andrio | Diego | sistema | email
    pedidoId: c.pedidoId || null,
    valor: c.tipo === "pago" ? (Number(c.valor)||0) : 0,
  };
  if(credito.dias === 0) return null; // não registra concessão vazia
  creditos.push(credito);
  setUser(email, { vip: { ...vip, creditos } });
  return credito;
}

const todayStr = () => todayStrBRT();
// Array de "DD/MM/YYYY" (BRT) dos últimos `n` dias, hoje incluso — MESMA
// formatação de todayStrBRT(), pra nunca dessincronizar do que addHist já
// grava em h.dateStr. Usado pra janelas tipo "últimos 7 dias" na vitrine
// pública (v243) sem inventar uma 2ª forma de calcular data.
function _ultimosDiasStr(n){
  const out=[];
  const hoje=_nowBRTMod();
  for(let i=0;i<n;i++){
    const d=new Date(hoje.getTime()-i*86400_000);
    out.push(`${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`);
  }
  return out;
}
// Manual = type "manual" apenas (NÃO conta auto, NÃO conta reply)
const countManualToday = h => (h||[]).filter(x=>(x.dateStr||"")===todayStr()&&x.type==="manual").length;
// Auto = type "auto" apenas
const countAutoToday   = h => (h||[]).filter(x=>(x.dateStr||"")===todayStr()&&x.type==="auto").length;

// CVs — v16-FIX: dupla persistência (disco + DB) para nunca perder PDF no reinício
const cvPath   = (e,i) => path.join(CVS_DIR,e.replace(/[^a-zA-Z0-9@._-]/g,"_")+"_"+i+".pdf");

// v21 (07/2026): DISCO É A FONTE ÚNICA dos PDFs. O b64 dentro de DB_USERS
// (v16) fazia TODO persist de users.json reserializar os PDFs de todos os
// usuários (megabytes por escrita, avisos de >800ms no storage) e mantinha
// tudo isso na RAM do Node — combustível do 502 por falta de memória do
// Servidor 2. CVS_DIR mora dentro de DATA_DIR: mesma durabilidade do JSON.
// O b64 no DB vira SÓ rede de segurança: usado apenas se a escrita em disco
// falhar (e limpo pelo loadCv/migração assim que o disco voltar a funcionar).
const saveCv = (e,i,b64) => {
  // Escrita atômica (tmp+rename): nunca deixa PDF truncado se o processo cair
  try {
    const fp=cvPath(e,i);
    fs.writeFileSync(fp+".tmp", Buffer.from(b64,"base64"));
    fs.renameSync(fp+".tmp", fp);
    return true;
  } catch(err) {
    console.warn(`[cv] Falha ao salvar disco (${err.message}) — guardando b64 no DB como rede de segurança`);
  }
  // Fallback raro: disco indisponível → guarda no DB pra não perder o arquivo
  try {
    const p = getUser(e) || {};
    const cvs = (p.cvs || []).map(c => {
      if(parseInt(c.idx,10) === parseInt(i,10)) return {...c, b64};
      return c;
    });
    setUser(e, {cvs});
    return true;
  } catch(err) {
    console.warn(`[cv] Falha ao salvar DB: ${err.message}`);
    return false;
  }
};

// v240b (dono, 22/09/2026 — 2º alerta de OOM 512MB, hipótese de upload
// simultâneo grande bufferizado por inteiro): move o corpo do upload de
// currículo/cover direto pro disco em stream, em vez de acumular tudo (até
// 50MB, MAX_BODY_SIZE) num Buffer só na RAM antes de decodificar. O arquivo
// cai já em CVS_DIR com nome único; saveCvFromFile só faz o rename final
// (mesma convenção atômica tmp→destino do saveCv acima).
const CV_MAX_BYTES = { resume: 5_250_000, cover: 3_150_000 }; // = os mesmos limites em base64*0.75 do JSON legado
function streamBodyToTempFile(req, maxBytes){
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(CVS_DIR, `_upload_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.tmp`);
    const ws = fs.createWriteStream(tmpPath);
    let size = 0, done = false;
    const finish = (err, result) => { if(done) return; done = true; err ? reject(err) : resolve(result); };
    const abort = (err) => {
      ws.destroy();
      fs.unlink(tmpPath, () => {});
      // Dreno o resto do corpo sem gravar mais nada (só descarta) — a conexão
      // HTTP precisa terminar de "ouvir" o corpo até o fim antes da resposta
      // de erro sair, senão o keep-alive corrompe a PRÓXIMA requisição no
      // mesmo socket (o parser HTTP acha que sobrou corpo = começo do próximo
      // request).
      req.removeAllListeners("data");
      req.on("data", () => {});
      req.resume();
      finish(err);
    };
    req.on("data", chunk => {
      if(done) return;
      size += chunk.length;
      if(size > maxBytes){ abort(new Error("PAYLOAD_TOO_LARGE")); return; }
      if(!ws.write(chunk)) req.pause();
    });
    ws.on("drain", () => { if(!done) req.resume(); });
    req.on("end", () => { if(done) return; ws.end(() => finish(null, { tmpPath, size })); });
    req.on("error", abort);
    ws.on("error", abort);
  });
}
function readFirstBytes(fp, n){
  const fd = fs.openSync(fp, "r");
  try { const buf = Buffer.alloc(n); const got = fs.readSync(fd, buf, 0, n, 0); return buf.slice(0, got); }
  finally { fs.closeSync(fd); }
}
const saveCvFromFile = (e,i,tmpPath) => {
  try {
    fs.renameSync(tmpPath, cvPath(e,i));
    return true;
  } catch(err) {
    console.warn(`[cv] Falha ao mover arquivo streamado (${err.message}) — tentando fallback em memória`);
  }
  // Mesma rede de segurança do saveCv: se o disco falhar, guarda no DB.
  try {
    const b64 = fs.readFileSync(tmpPath).toString("base64");
    try { fs.unlinkSync(tmpPath); } catch {}
    const p = getUser(e) || {};
    const cvs = (p.cvs || []).map(c => parseInt(c.idx,10)===parseInt(i,10) ? {...c, b64} : c);
    setUser(e, {cvs});
    return true;
  } catch(err2) {
    console.warn(`[cv] Falha no fallback também: ${err2.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
};
// Regras de negócio (dedup por nome+tipo, limite de slots, idx, journey,
// formato da resposta) — fonte única pros 2 caminhos de persistência (JSON
// legado com base64 e o novo stream-pro-disco), nunca duplicada entre eles.
function _finalizeCvUpload(email, safeName, cvType, sizeBytes, persistFn, onDecline){
  const p = getUser(email) || {}; const cvs = p.cvs || [];
  // v20: upload do MESMO arquivo (mesmo nome+tipo) SUBSTITUI o existente.
  const _dup = cvs.find(c => (c.cvType||"resume")===cvType && String(c.name||"").trim().toLowerCase()===safeName.trim().toLowerCase());
  if(_dup){
    _dup.size=sizeBytes; _dup.date=new Date().toISOString(); delete _dup.b64; setUser(email,{cvs});
    if(!persistFn(_dup.idx)) return {status:500,body:{error:"Não conseguimos guardar seu currículo agora (falha ao gravar no servidor). Tente de novo em instantes — nada foi salvo pela metade."}};
    trackJourney(email,'pdf_upload',{detail:`PDF substituído: ${safeName} ~${Math.round(sizeBytes/1024)}KB`,meta:{name:safeName,idx:_dup.idx,cvType,replaced:true}});
    return {status:200,body:{ok:true,replaced:true,cv:{idx:_dup.idx,name:_dup.name,size:_dup.size,date:_dup.date,cvType}}};
  }
  const typeLimit = cvType==="cover"?MAX_COVERS:MAX_RESUMES;
  const sameType = cvs.filter(c => (c.cvType||"resume")===cvType);
  // Limite de slots batido ANTES de persistir: no caminho streamado o arquivo
  // já está gravado num tmp — onDecline() é quem limpa esse órfão (persistFn
  // nunca chega a ser chamado aqui).
  if(sameType.length>=typeLimit){ if(onDecline) onDecline(); return {status:429,body:{error:`Limite de ${typeLimit} ${cvType==="cover"?"cover letters":"currículos"} atingido. Para liberar espaço: abra o editor de perfil → seção Currículo → clique no ícone 🗑️ ao lado de um PDF antigo.`,limitReached:true,cvType,limit:typeLimit}}; }
  const idx = Date.now(); const meta = {idx,name:safeName,size:sizeBytes,date:new Date().toISOString(),cvType};
  cvs.push(meta); setUser(email,{cvs});
  if(!persistFn(idx)){ setUser(email,{cvs:cvs.filter(c=>c.idx!==idx)}); return {status:500,body:{error:"Não conseguimos guardar seu currículo agora (falha ao gravar no servidor). Tente de novo em instantes — nada foi salvo pela metade."}}; }
  trackJourney(email,'pdf_upload',{detail:`PDF: ${safeName} ~${Math.round(sizeBytes/1024)}KB`,meta:{name:safeName,idx,cvType}});
  return {status:200,body:{ok:true,cv:{idx:meta.idx,name:meta.name,size:meta.size,date:meta.date,cvType:meta.cvType}}};
}

// ── 🧾 v192 LOTE 10 — COMPROVANTES DE PEDIDO EM DISCO ─────────────────────
// O arquivo guarda EXATAMENTE a string que antes vivia na memória (base64 puro
// ou data URL): assim todo leitor — anexo do e-mail, Gemini, painel — continua
// recebendo o mesmo conteúdo de sempre, sem nenhuma régua nova de formato.
function comprovantePath(pedidoId){
  return path.join(COMPROVANTES_DIR, String(pedidoId||"").replace(/[^a-zA-Z0-9@._-]/g,"_")+".b64");
}
// Escrita atômica (tmp+rename), igual ao saveCv: nunca deixa comprovante pela
// metade se o processo cair no meio. Devolve o nome do arquivo ou null.
function saveComprovante(pedidoId, conteudo){
  try{
    if(!pedidoId||typeof conteudo!=="string"||!conteudo) return null;
    fs.mkdirSync(COMPROVANTES_DIR,{recursive:true});
    const fp=comprovantePath(pedidoId);
    fs.writeFileSync(fp+".tmp", conteudo, "utf8");
    fs.renameSync(fp+".tmp", fp);
    return path.basename(fp);
  }catch(err){
    console.error(`[comprovante] ❌ falha ao gravar o comprovante do pedido ${pedidoId}: ${err.message}`);
    return null;
  }
}
// Leitura sob demanda. Aceita o pedido inteiro pra continuar servindo o
// comprovante de pedido LEGADO que ainda esteja inline na memória (o boot
// migra, mas nunca dependemos da migração pra responder).
function loadComprovante(pedido){
  if(!pedido) return null;
  if(typeof pedido.comprovante==="string"&&pedido.comprovante) return pedido.comprovante;
  if(!pedido.comprovanteArquivo) return null;
  try{
    const txt=fs.readFileSync(path.join(COMPROVANTES_DIR, path.basename(String(pedido.comprovanteArquivo))),"utf8");
    return txt||null; // sem piso de tamanho: quem valida o conteúdo é a rota de entrada (400 com motivo)
  }catch(e){
    console.warn(`[comprovante] não consegui ler o arquivo do pedido ${pedido.id}: ${e.message}`);
    return null;
  }
}
// "Tem comprovante?" é UMA pergunta só (arquivo em disco OU legado na memória)
// — toda tela/rota que antes fazia `!!pd.comprovante` passa por aqui.
function temComprovante(pedido){
  return !!(pedido&&(pedido.comprovanteArquivo||(typeof pedido.comprovante==="string"&&pedido.comprovante)));
}

// 🚀 v240c (dono, 22/09/2026 — mesma lógica do v240b/currículo, agora pro
// comprovante de pagamento): em vez de bufferizar até ~8MB de base64 dentro
// do JSON gigante de /api/pedido, o cliente sobe o arquivo cru (binário)
// numa chamada PRÓPRIA, que streama e converte pra base64 em PEDAÇOS (nunca
// o arquivo inteiro numa string só) direto pro disco — /api/pedido só
// recebe de volta um TOKEN curto de posse. Formato final em disco (.b64,
// texto base64) fica IDÊNTICO ao caminho legado — loadComprovante,
// preCheckComprovante e todo o resto do site continuam lendo do jeito de
// sempre, sem saber COMO o arquivo chegou lá.
const COMPROVANTE_STAGE_MAX_BYTES = 8_025_000; // = 10_700_000 chars base64 * 0.75 (mesmo teto de sempre, em bytes crus)
const STAGED_COMPROVANTE_TTL_MS = 2*3600_000; // 2h — sobra pra terminar um checkout sem pressa
const STAGED_COMPROVANTES = new Map(); // token -> {email, path, createdAt} — em memória, mesmo padrão dos links de uso único (v237x)
function _sweepStagedComprovantes(){
  const agora=Date.now();
  for(const [tok,entry] of STAGED_COMPROVANTES){
    if(agora-entry.createdAt>STAGED_COMPROVANTE_TTL_MS){
      try{fs.unlinkSync(entry.path);}catch{}
      STAGED_COMPROVANTES.delete(tok);
    }
  }
}
// Varredura de boot: qualquer "_staged_*.b64" em disco nasceu de um processo
// ANTERIOR (o Map de posse é só em memória — morre com o processo) — nunca
// tem dono válido depois de um restart, então é sempre lixo seguro de apagar.
function _sweepOrphanStagedComprovantes(){
  try{
    if(!fs.existsSync(COMPROVANTES_DIR))return;
    let removed=0;
    for(const f of fs.readdirSync(COMPROVANTES_DIR)){
      if(!f.startsWith("_staged_"))continue;
      try{fs.unlinkSync(path.join(COMPROVANTES_DIR,f));removed++;}catch{}
    }
    if(removed>0)console.log(`[comprovante-stage] 🧹 ${removed} comprovante(s) em preparo órfão(s) removido(s) do disco (processo anterior nunca terminou o checkout).`);
  }catch(e){ console.warn("[comprovante-stage] varredura falhou:",e.message); }
}
// Streama o CORPO CRU da requisição (binário) direto pro disco JÁ em base64
// — nunca monta o arquivo inteiro numa string/Buffer só. Alinha em múltiplos
// de 3 bytes entre pedaços (resto guardado em `carry`) pra virar base64
// válido sem costura errada entre um pedaço e o próximo.
function stageComprovanteFromReq(req, email){
  return new Promise((resolve, reject) => {
    _sweepStagedComprovantes();
    fs.mkdirSync(COMPROVANTES_DIR,{recursive:true});
    const token=crypto.randomBytes(16).toString("hex");
    const destPath=path.join(COMPROVANTES_DIR, `_staged_${token}.b64`);
    const ws=fs.createWriteStream(destPath+".tmp");
    let carry=Buffer.alloc(0), size=0, done=false;
    const finish=(err,result)=>{ if(done)return; done=true; err?reject(err):resolve(result); };
    const abort=(err)=>{
      ws.destroy();
      fs.unlink(destPath+".tmp",()=>{});
      // Mesmo motivo do streaming de currículo: drena o resto do corpo em
      // vez de só parar de ouvir, senão o próximo request no mesmo socket
      // keep-alive quebra.
      req.removeAllListeners("data");
      req.on("data",()=>{});
      req.resume();
      finish(err);
    };
    req.on("data",chunk=>{
      if(done)return;
      size+=chunk.length;
      if(size>COMPROVANTE_STAGE_MAX_BYTES){ abort(new Error("PAYLOAD_TOO_LARGE")); return; }
      const buf=carry.length?Buffer.concat([carry,chunk]):chunk;
      const usable=buf.length-(buf.length%3);
      const toEncode=buf.subarray(0,usable);
      carry=buf.subarray(usable);
      if(toEncode.length){
        if(!ws.write(toEncode.toString("base64")))req.pause();
      }
    });
    ws.on("drain",()=>{ if(!done)req.resume(); });
    req.on("end",()=>{
      if(done)return;
      const finalB64=carry.length?carry.toString("base64"):"";
      ws.end(finalB64,()=>{
        // Sem piso de tamanho (o caminho legado com d.comprovante também não
        // tinha um — só recusa o VAZIO de verdade, nunca inventa um limite novo).
        if(size===0){ try{fs.unlinkSync(destPath+".tmp");}catch{} return finish(new Error("TOO_SMALL")); }
        try{ fs.renameSync(destPath+".tmp", destPath); }
        catch(e){ return finish(e); }
        STAGED_COMPROVANTES.set(token,{email,path:destPath,createdAt:Date.now()});
        finish(null,{token});
      });
    });
    req.on("error",abort);
    ws.on("error",abort);
  });
}
// Reivindica um comprovante já preparado (mesmo dono, ainda não expirado) e
// MOVE (rename — sem reler o conteúdo) pro destino final. null = token
// inválido/expirado/de outra conta (nunca deixa um usuário roubar o
// comprovante preparado por outro).
function claimStagedComprovante(token, email, destFilePath){
  const entry=STAGED_COMPROVANTES.get(token);
  if(!entry||entry.email!==email)return null;
  STAGED_COMPROVANTES.delete(token);
  try{
    fs.mkdirSync(path.dirname(destFilePath),{recursive:true});
    fs.renameSync(entry.path, destFilePath);
    return path.basename(destFilePath);
  }catch(e){
    console.warn(`[comprovante-stage] falha ao mover ${token}: ${e.message}`);
    try{fs.unlinkSync(entry.path);}catch{}
    return null;
  }
}

// Migração de boot, IDEMPOTENTE e de QUALQUER status (pedido aprovado ou
// cancelado meses atrás é justamente o peso morto que sobrava na RAM).
// Nada é apagado da memória antes do arquivo existir em disco.
function _migrarComprovantesParaDisco(){
  try{
    let movidos=0,falhas=0,mb=0;
    for(const pd of DB_PEDIDOS){
      if(!pd||typeof pd.comprovante!=="string"||!pd.comprovante) continue;
      const bytes=pd.comprovante.length;
      const arq=saveComprovante(pd.id,pd.comprovante);
      if(!arq){falhas++;continue;} // fica na RAM e tenta de novo no próximo boot
      pd.comprovanteArquivo=arq;
      pd.comprovante=null;
      movidos++;mb+=bytes;
    }
    if(movidos||falhas){
      persistPedidos();
      console.log(`[migração] 🧾 ${movidos} comprovante(s) movidos pra ${COMPROVANTES_DIR} (${(mb/1048576).toFixed(1)}MB fora da RAM)${falhas?` — ${falhas} falha(s), seguem na memória`:""}.`);
    }
  }catch(e){ console.warn("[migração] comprovantes:",e.message); }
}

const loadCv = (e,i) => {
  // 1. Tenta ler do disco primeiro (mais rápido)
  try {
    const buf = fs.readFileSync(cvPath(e,i));
    if(buf && buf.length > 100) return buf.toString("base64");
  } catch {}
  // 2. Fallback: recupera do DB (rede de segurança de quando o disco falhou)
  try {
    const p = getUser(e);
    const cv = (p?.cvs||[]).find(c => parseInt(c.idx,10) === parseInt(i,10));
    if(cv?.b64 && cv.b64.length > 100) {
      const b64 = cv.b64;
      // Restaura no disco e, se der certo, LIMPA o b64 do DB (v21: disco é a
      // fonte única — o DB não deve seguir carregando o PDF pra sempre)
      try {
        fs.writeFileSync(cvPath(e,i), Buffer.from(b64,"base64"));
        const cvs=(p.cvs||[]).map(c=>{ if(parseInt(c.idx,10)===parseInt(i,10)){const {b64:_,...rest}=c;return rest;} return c; });
        setUser(e,{cvs});
        console.log(`[cv] ✅ PDF restaurado do DB para disco (e b64 limpo do DB): ${e} idx=${i}`);
      } catch {}
      return b64;
    }
  } catch {}
  return null;
};

const deleteCv = (e,i) => {
  try { fs.unlinkSync(cvPath(e,i)); } catch {}
  // Remove b64 do DB também
  try {
    const p = getUser(e) || {};
    const cvs = (p.cvs||[]).map(c => {
      if(parseInt(c.idx,10) === parseInt(i,10)) { const {b64,...rest}=c; return rest; }
      return c;
    });
    setUser(e, {cvs});
  } catch {}
};

// ══════════════════════════════════════════════════════════
//  PLANILHAS COM CATEGORIAS DINÂMICAS
// ══════════════════════════════════════════════════════════
let SHEET_JAN = [], SHEET_JUL = [], SHEET_H2A = [];
let SHEET_EXTRAS = {}; // { "jul2026": [...vagas] } — planilhas extras carregadas via admin
const SHEETS_DIR = path.join(DATA_DIR, "sheets");
const SHEETS_META_FILE = path.join(DATA_DIR, "sheets_meta.json");
let DB_SHEETS_META = {}; // { "jul2026": { name, file, uploaded, count, enriched, enrichedAt } }

// ── Bot de Enriquecimento de Planilhas ──────────────────
// ══════════════════════════════════════════════════════════════════════════
//  📜 LOG UNIFICADO DE TODOS OS ROBÔS — pedido do dono (07/07/2026):
//  "preciso de logs inteligentes pra eu visualizar na página adm" pra saber
//  o que cada robô do sistema fez, quando e como. Ring buffer global — cada
//  robô empurra uma linha aqui além do log próprio dele (não substitui,
//  soma). Lido pela aba nova "📜 Logs dos Robôs" no admin.
// ══════════════════════════════════════════════════════════════════════════
const DB_BOT_LOGS = [];
const BOT_LOG_CAP = 1500;
function botLog(botId, botLabel, msg, type='info'){
  DB_BOT_LOGS.unshift({ ts:Date.now(), bot:botId, botLabel, msg:String(msg||'').slice(0,400), type });
  if(DB_BOT_LOGS.length>BOT_LOG_CAP) DB_BOT_LOGS.length=BOT_LOG_CAP;
}

const _enrichBot = {
  running: false,
  sheetKey: null,
  total: 0,
  done: 0,
  ok: 0,
  noEmail: 0,
  aguardando: 0, // v195 LOTE 14: linhas puladas por já terem sido perguntadas ao DOL há pouco
  errors: 0,
  startedAt: null,
  log: [],         // últimas 100 linhas de log
  savedAt: null,
};

function _enrichLog(msg, type='info'){
  const line = { ts: Date.now(), msg, type };
  _enrichBot.log.push(line);
  if(_enrichBot.log.length > 200) _enrichBot.log.shift();
  console.log(`[enrich] ${msg}`);
  botLog('enrich','Enriquecimento de Planilha',msg,type);
}

// Mapa de categorias para labels em português
// v166 (Ordem 6f — público 100% brasileiro): label limpo pra emoji + termo
// SÓ em português (o "/ EnglishWord" bilíngue poluía o chip de filtro). O
// campo `en` fica intocado — não é usado em lugar nenhum do código hoje
// (conferido: só existe aqui, na definição), mas é preservado como
// referência caso algum texto em inglês (e-mail ao empregador, etc.) venha
// a precisar dele no futuro.
const CATEGORY_LABELS = {
  landscape:    { label:"🌿 Jardim/Paisagismo",     en:"Landscape" },
  construction: { label:"🏗️ Construção",            en:"Construction" },
  housekeeper:  { label:"🏨 Hotelaria/Limpeza",     en:"Housekeeper" },
  seafood:      { label:"🦞 Frutos do Mar",          en:"Seafood" },
  farm:         { label:"🌾 Fazenda/Agrícola",       en:"Farm" },
  golf:         { label:"⛳ Campo de Golfe",          en:"Golf" },
  amusement:    { label:"🎡 Parque de Diversões",    en:"Amusement" },
  forest:       { label:"🌲 Florestal",              en:"Forest" },
  lifeguard:    { label:"🏊 Salva-vidas",            en:"Lifeguard" },
  food:         { label:"🍽️ Alimentação",           en:"Food & Bar" },
  ski:          { label:"⛷️ Estação de Esqui",       en:"Ski Resort" },
  // v167 (revisão 07/09/2026): chave real presente em planilhas (jan2026:52,
  // jul2025:23 vagas) sem entrada — caía no fallback CATEGORY_LABELS[k]?.label||k
  // e mostrava "cleaning" cru em inglês no chip de categoria (viola 6f).
  cleaning:     { label:"🧹 Limpeza",                 en:"Cleaning" },
  // ── Categorias H-2A (agricultura) ──
  crop:         { label:"🌱 Lavoura / Colheita",      en:"Crop / Field" },
  equipment_op: { label:"🚜 Operador de Máquinas",    en:"Equipment Operator" },
  livestock:    { label:"🐄 Pecuária / Animais",      en:"Livestock" },
  sheepherder:  { label:"🐑 Pastor de Ovelhas",       en:"Sheepherder" },
  nursery:      { label:"🪴 Viveiro / Estufa",        en:"Nursery / Greenhouse" },
  irrigation:   { label:"💧 Irrigação",               en:"Irrigation" },
  mechanic:     { label:"🔧 Mecânico Agrícola",       en:"Farm Mechanic" },
  supervisor:   { label:"👷 Supervisor de Fazenda",   en:"Farm Supervisor" },
  driver:       { label:"🚐 Motorista / Transporte",  en:"Driver" },
  truck_driver: { label:"🚛 Motorista de Caminhão",   en:"Truck Driver" },
  grader_sorter:{ label:"📦 Classificador / Seleção", en:"Grader / Sorter" },
  packer:       { label:"📦 Embalador",               en:"Packer" },
  carpenter:    { label:"🔨 Carpinteiro",             en:"Carpenter" },
  ironworker:   { label:"🏗️ Estrutura Metálica",     en:"Ironworker" },
  fence:        { label:"🚧 Cercas",                  en:"Fence" },
  cook:         { label:"👨‍🍳 Cozinheiro",            en:"Cook" },
  meat:         { label:"🥩 Frigorífico / Abate",     en:"Meat / Slaughter" },
  logging:      { label:"🪵 Extração de Madeira",     en:"Logging" },
  inspector:    { label:"🔎 Inspetor Agrícola",       en:"Ag Inspector" },
  other:        { label:"📋 Outros",                  en:"Other" },
};

// ── Normalização de estado (KB-SEO-02): planilhas antigas usavam sigla de 2
// letras ("TX"), enquanto jul2025_compact.json e h2a_jun2026_compact.json usam
// nome por extenso ("TEXAS") — sem normalizar, agregados por estado (ex.: página
// de salários, páginas por estado) contavam "TX" e "TEXAS" como lugares
// diferentes, subcontando quase todo estado. Esta função sempre devolve o
// NOME POR EXTENSO em maiúsculas, e o slug (para URL) em minúsculas sem acento.
const STATE_ABBR_TO_NAME = {AL:"ALABAMA",AK:"ALASKA",AZ:"ARIZONA",AR:"ARKANSAS",CA:"CALIFORNIA",CO:"COLORADO",CT:"CONNECTICUT",DE:"DELAWARE",FL:"FLORIDA",GA:"GEORGIA",HI:"HAWAII",ID:"IDAHO",IL:"ILLINOIS",IN:"INDIANA",IA:"IOWA",KS:"KANSAS",KY:"KENTUCKY",LA:"LOUISIANA",ME:"MAINE",MD:"MARYLAND",MA:"MASSACHUSETTS",MI:"MICHIGAN",MN:"MINNESOTA",MS:"MISSISSIPPI",MO:"MISSOURI",MT:"MONTANA",NE:"NEBRASKA",NV:"NEVADA",NH:"NEW HAMPSHIRE",NJ:"NEW JERSEY",NM:"NEW MEXICO",NY:"NEW YORK",NC:"NORTH CAROLINA",ND:"NORTH DAKOTA",OH:"OHIO",OK:"OKLAHOMA",OR:"OREGON",PA:"PENNSYLVANIA",RI:"RHODE ISLAND",SC:"SOUTH CAROLINA",SD:"SOUTH DAKOTA",TN:"TENNESSEE",TX:"TEXAS",UT:"UTAH",VT:"VERMONT",VA:"VIRGINIA",WA:"WASHINGTON",WV:"WEST VIRGINIA",WI:"WISCONSIN",WY:"WYOMING",DC:"DISTRICT OF COLUMBIA",PR:"PUERTO RICO",VI:"VIRGIN ISLANDS",GU:"GUAM",AS:"AMERICAN SAMOA",MP:"NORTHERN MARIANA ISLANDS"};
function normalizeStateName(raw){
  const s=String(raw||"").trim().toUpperCase();
  if(!s)return"";
  if(STATE_ABBR_TO_NAME[s])return STATE_ABBR_TO_NAME[s]; // sigla de 2 letras
  return s; // já é nome por extenso
}
function stateSlug(name){
  return String(name||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z]+/g,"-").replace(/^-+|-+$/g,"");
}

// 🧹 v182 LOTE 8 — LIMPEZA DA CIDADE: FUNÇÃO ÚNICA (robô de alimentação +
// carregamento das planilhas). A cidade entrava CRUA da fonte e virava opção
// de filtro do jeito que veio: na H-2A existem "Franklin Baldwin, LA 70514",
// "McBee SC 29101", "Mailing: 611 Church St. Vidalia, G", "13033",
// "N2575 County Rd. B", e 216 das 2.569 grafias estão em CAIXA ALTA. Cada uma
// dessas é um chip clicável que não é lugar nenhum.
// RÉGUA (conservadora de propósito — cidade ERRADA é pior que cidade suja):
//   • tira "Mailing:"/"Mailing address:" do começo;
//   • tira o CEP do fim (5 ou 5-4 dígitos);
//   • tira a sigla de estado do fim SÓ quando ela existe no mapa único
//     STATE_ABBR_TO_NAME (agora com VI/GU/AS/MP) — nunca corta 2 letras à toa;
//   • descarta o que não tem NENHUMA letra ("13033") e o que começa com número
//     de rua ("611 Church St. Vidalia", "N2575 County Rd. B");
//   • Title Case SÓ quando o valor está todo em caixa alta — assim "LaBelle" e
//     "McBee" continuam intactos.
// IDEMPOTENTE: aplicar de novo devolve exatamente o mesmo texto (é o que
// permite rodar a auto-cura em todo boot sem risco).
// ⚠️ A CHAVE canônica de cidade do v179 (norm(cidade)+"|"+ESTADO) NÃO muda —
// só o texto fica limpo; contagem e casamento seguem idênticos.
function limparCidade(raw){
  let s=String(raw==null?"":raw).replace(/\s+/g," ").trim();
  if(!s)return"";
  s=s.replace(/^mailing\s*(address)?\s*:?\s*/i,"").trim();
  s=s.replace(/[,\s]+\d{5}(-\d{4})?$/,"").trim();
  const sig=s.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if(sig&&STATE_ABBR_TO_NAME[sig[2].toUpperCase()])s=sig[1].trim();
  s=s.replace(/[,;.\s]+$/,"").trim();
  if(!s)return"";
  if(!/[a-zA-Z]/.test(s))return"";          // "13033" — número, não cidade
  if(/^[a-zA-Z]?\d/.test(s))return"";       // endereço ("611 Church St.", "N2575 County Rd.")
  if(!/[a-z]/.test(s))s=s.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
  return s;
}
// Auto-cura no boot: passa a régua acima em toda linha já carregada (a H-2A
// tem 216 grafias sujas de nascença) e diz no log quantas mudaram. Só em
// memória — a próxima gravação da planilha (enriquecimento/frescor) leva o
// texto limpo pro disco; nunca reescreve arquivo no boot à toa.
function _selfHealCidades(label, rows){
  if(!Array.isArray(rows)||!rows.length)return 0;
  let n=0;
  for(const r of rows){
    if(!r||r.ci===undefined||r.ci===null)continue;
    const limpa=limparCidade(r.ci);
    if(limpa!==r.ci){ r.ci=limpa; n++; }
  }
  if(n)console.log(`[sheet] 🧹 ${label}: ${n} cidade(s) limpa(s) (CEP/sigla de estado/endereço/CAIXA ALTA) — chave canônica intocada`);
  return n;
}

// 🩹 v221 (achado ao vivo do dono, 20/09/2026): quando o empregador não dá um
// título próprio, o DOL publica "CÓDIGO SOC: nome oficial da ocupação" como
// job_title — e pelo menos 1 vaga real chegou com esse campo cortado NA FONTE
// (60 caracteres, largura clássica de campo antigo do sistema do DOL: "49-9098:
// Helpers—Installation, Maintenance, and Repair Worke", faltando "rs"). Só
// completa o título quando a grafia oficial do código está VERIFICADA aqui
// (fonte: BLS OES / O*NET — nunca inventa nome de ocupação); pra qualquer
// outro código com a MESMA assinatura de corte (60 caracteres, prefixo SOC),
// só REGISTRA no log pro admin conferir manualmente — nunca adivinha. Nunca
// toca o histórico de candidaturas já enviadas (só o texto da vaga na
// planilha).
const _SOC_TITULOS_OFICIAIS = {
  // BLS: https://www.bls.gov/oes/current/oes499098.htm · O*NET: 49-9098.00
  "49-9098": "Helpers--Installation, Maintenance, and Repair Workers",
};
function _selfHealTitulosTruncados(label, rows){
  if(!Array.isArray(rows)||!rows.length)return 0;
  let n=0;
  for(const r of rows){
    if(!r||!r.t)continue;
    const m=/^(\d{2}-\d{4}):\s/.exec(r.t);
    if(!m)continue;
    const codigo=m[1];
    const oficial=_SOC_TITULOS_OFICIAIS[codigo];
    if(oficial){
      const corrigido=`${codigo}: ${oficial}`;
      if(r.t!==corrigido){ r.t=corrigido; n++; }
    } else if(r.t.length===60){
      console.warn(`[sheet] 🔎 ${label}: título de vaga com a MESMA assinatura do corte real (60 caracteres, prefixo SOC ${codigo}) — confira/complete manualmente: "${r.t}" (case ${r.c||"?"})`);
    }
  }
  if(n)console.log(`[sheet] 🩹 ${label}: ${n} título(s) de vaga completado(s) (código SOC truncado na FONTE do DOL, corrigido com a grafia oficial BLS/O*NET) — histórico de candidaturas intocado`);
  return n;
}

// 🔒 Auto-cura de integridade (KB-076): toda vez que uma planilha é lida do
// disco, confere se tem case number duplicado. Se tiver (arquivo antigo,
// gerado antes desta correção — ex.: h2a_jun2026_compact.json tinha 36
// duplicados), MESCLA e GRAVA de volta corrigido, para o boot seguinte já
// carregar limpo. Nunca precisa de intervenção manual — o sistema se
// autocorrige e deixa registrado no log exatamente o que fez.
// v48 (bug real 25/07, print do dono: "as vagas das planilhas de inverno e
// h2a sumiram"): TODA gravação de planilha passa a ser ATÔMICA (tmp+rename).
// Antes era writeFileSync direto no arquivo final — se o processo morresse no
// meio (deploy/OOM/disco cheio), o arquivo em /data ficava truncado/corrompido
// e, como /data tem prioridade sobre a cópia do código, a planilha "sumia"
// pra sempre em todos os boots seguintes.
function _writeFileAtomic(p, str){
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, p);
}
function _selfHealSheetIntegrity(label, rows, persistPath){
  const check = _vagasVerify(rows, {caseField:'c'});
  if(check.ok) return rows;
  const { rows: cleaned, duplicatesMerged } = _vagasDedupe(rows, {caseField:'c'});
  console.warn(`[sheet] 🩹 AUTO-CURA ${label}: ${rows.length} linhas → ${cleaned.length} vagas únicas (${duplicatesMerged} case number(s) duplicado(s) mesclado(s), NENHUM dado perdido)`);
  if(persistPath){
    try{
      _writeFileAtomic(persistPath, JSON.stringify(cleaned));
      console.warn(`[sheet] 🩹 ${label}: arquivo corrigido salvo em ${persistPath}`);
    }catch(e){ console.warn(`[sheet] ⚠️ Auto-cura ${label}: não consegui salvar o arquivo corrigido: ${e.message}`); }
  }
  return cleaned;
}

function loadSheets() {
  // ── Carrega DB_SHEETS_META do disco ──
  if(fs.existsSync(SHEETS_META_FILE)){
    try{ DB_SHEETS_META = JSON.parse(fs.readFileSync(SHEETS_META_FILE,"utf8")); }catch{}
  }

  // 🩹 Auto-cura (09/07/2026): deploys anteriores podem ter gravado uma
  // entrada de planilha EXTRA em sheets_meta.json sem o campo "file" (bug
  // do seed automático de jul2026, corrigido acima). Sem "file", o loop de
  // carregamento abaixo pula a planilha e ela nunca recupera o
  // enriquecimento já salvo em /data/sheets/ — reseta pra 0% pra sempre.
  // Cura sozinho, sem precisar de passo manual do admin: se a entrada não
  // tem "file" mas o arquivo <chave>.json existe em /data/sheets/, aponta
  // pra ele.
  for(const[metaKey,meta]of Object.entries(DB_SHEETS_META)){
    if(metaKey==="jan2026"||metaKey==="jul2025") continue;
    if(meta && !meta.file){
      const guess = `${metaKey}.json`;
      if(fs.existsSync(path.join(SHEETS_DIR,guess))){
        meta.file = guess;
        console.warn(`[sheet] 🩹 sheets_meta.json: "${metaKey}" estava sem campo "file" — corrigido sozinho para "${guess}".`);
      }
    }
  }

  let anyLoaded = false;
  for(const[key,file]of[["jan","jan2026_compact.json"],["jul","jul2025_compact.json"],["h2a","h2a_jun2026_compact.json"]]){
    // PRIORIDADE: /data/ (disco persistente, sobrevive deploys e carrega o
    // enriquecimento acumulado). FALLBACK: __dirname (cópia bundled do código).
    // v48-FIX (bug real 25/07, print do dono: "vagas das planilhas sumiram"):
    // antes o fallback só valia quando o arquivo de /data NÃO EXISTIA. Se ele
    // existisse corrompido/truncado (gravação não-atômica interrompida por
    // deploy/OOM/disco cheio) ou com os e-mails varridos, o load fazia
    // `continue` e a planilha ficava VAZIA pra sempre — mesmo com a cópia
    // bundled 100% boa (com e-mails) do lado. Agora: lê as DUAS cópias,
    // usa a melhor (a de /data só se for válida E tiver e-mails quando a
    // bundled tem) e REGRAVA /data sozinho quando recupera pela bundled.
    const pData = path.join(DATA_DIR, file);   // /data/jan2026_compact.json
    const pSrc  = path.join(__dirname, file);   // cópia bundled do deploy
    const _readRows = (p) => { try{ const d=JSON.parse(fs.readFileSync(p,"utf8")); return (Array.isArray(d)&&d.length)?d:null; }catch{ return null; } };
    const _emails = (a) => a===null ? -1 : a.reduce((n,r)=>n+((r.e&&String(r.e).includes("@"))?1:0),0);
    const dData = fs.existsSync(pData) ? _readRows(pData) : null;
    const dSrc  = fs.existsSync(pSrc)  ? _readRows(pSrc)  : null;
    let d=null;
    if(dData && (_emails(dData)>0 || _emails(dSrc)<=0)){
      d=dData; console.log(`[sheet] 📂 Carregando ${file} de /data/ (enriquecido)`);
    } else if(dSrc){
      d=dSrc;
      if(fs.existsSync(pData)){
        console.warn(`[sheet] 🩹 ${file}: cópia de /data corrompida/vazia/sem e-mails (${dData?dData.length+" linhas, "+_emails(dData)+" e-mails":"ilegível"}) — RECUPERADO pela cópia bundled do código (${dSrc.length} vagas, ${_emails(dSrc)} e-mails) e /data regravado.`);
      } else {
        console.log(`[sheet] 📂 Carregando ${file} de código (original)`);
      }
      try{ _writeFileAtomic(pData, JSON.stringify(dSrc)); }catch(e){ console.warn(`[sheet] ⚠️ não consegui regravar ${pData}: ${e.message}`); }
    } else if(dData){
      d=dData; console.log(`[sheet] 📂 Carregando ${file} de /data/ (única cópia disponível)`);
    }
    if(!d){
      console.warn(`[sheet] ⚠️ ${file}: nenhuma cópia legível (nem /data, nem código). Execute: node build-sheets.js`);
      continue;
    }
    try {
      // 🔒 Garante 1 vaga = 1 ETA case number ANTES de publicar em memória.
      d = _selfHealSheetIntegrity(key, d, pData);
      if(key==="jan") SHEET_JAN=d; else if(key==="jul") SHEET_JUL=d; else SHEET_H2A=d;
      (key==="jan"?SHEET_JAN:key==="jul"?SHEET_JUL:SHEET_H2A).forEach(r=>{if(!r.k)r.k=detectCategory(r.t,r.n);});
      _selfHealCidades(key, d); // v182: sujeira de cidade nunca vira opção de filtro
      _selfHealTitulosTruncados(key, d); // v221: título com código SOC cortado na fonte do DOL
      console.log(`[sheet] ✅ ${key}: ${d.length} vagas (ETA case numbers únicos)`);
      anyLoaded = true;
    } catch(e) {
      console.warn(`[sheet] ❌ Erro ao processar ${file}:`, e.message);
    }
  }
  if (!anyLoaded) {
    console.warn("[sheet] ❌ NENHUMA planilha builtin carregada. Execute 'node build-sheets.js'.");
  }

  // ── Carrega planilhas EXTRAS do disco (/data/sheets/*.json) ──
  if(fs.existsSync(SHEETS_DIR)){
    let extrasLoaded = 0;
    for(const [metaKey, meta] of Object.entries(DB_SHEETS_META)){
      if(metaKey==="jan2026"||metaKey==="jul2025") continue;
      if(!meta?.file) continue;
      const fp = path.join(SHEETS_DIR, meta.file);
      if(!fs.existsSync(fp)) continue;
      try{
        let d = JSON.parse(fs.readFileSync(fp,"utf8"));
        if(!Array.isArray(d)||d.length===0){ console.warn(`[sheet] ⚠️ extra ${metaKey}: arquivo ${meta.file} vazio/inválido — planilha NÃO carregada (se for jul2026, o seed bundled recupera sozinho).`); continue; }
        // 🔒 Mesma garantia de integridade pras planilhas extras/históricas.
        d = _selfHealSheetIntegrity(`extra:${metaKey}`, d, fp);
        d.forEach(r=>{if(!r.k)r.k=detectCategory(r.t,r.n);r._sheet=metaKey;});
        _selfHealCidades(`extra:${metaKey}`, d); // v182: mesma régua única de limpeza
        _selfHealTitulosTruncados(`extra:${metaKey}`, d); // v221: título com código SOC cortado na fonte do DOL
        SHEET_EXTRAS[metaKey] = d;
        extrasLoaded++;
        console.log(`[sheet] ✅ extra ${metaKey}: ${d.length} vagas (ETA case numbers únicos)`);
      }catch(e){ console.warn(`[sheet] ❌ Erro ao ler extra ${metaKey}:`, e.message); }
    }
    if(extrasLoaded>0) console.log(`[sheet] ✅ ${extrasLoaded} planilha(s) extra(s) carregada(s) do disco`);
  }

  // 🌱 Seed automático da planilha de Julho 2026 (ver função abaixo pro
  // porquê da checagem ser sobre DADO REAL, não sobre a existência de uma
  // entrada no meta — KB-086).
  seedJul2026FromBundle();
}

// ── 🌱 SEED "jul2026" — pedido do dono (08/07/2026): a lista randomizada de
// Julho 2026 acabou de sair e foi enviada pra mim. Deixo um
// jul2026_compact.json BUNDLED no código (mesma ideia do jan2026/jul2025/
// h2a) com os 2.625 case numbers + grupo oficial + empresa/estado já
// extraídos do PublicFacingReport real. Se ainda NÃO existe vaga de
// verdade carregada pra "jul2026" (ou se `force`=true, chamado manualmente
// pelo admin), carrega esse arquivo, publica na hora (usuário já pode se
// candidatar) e entrega pro Enriquecimento automático completar o resto.
//
// 🔒 KB-086 (dono, 08/07/2026): a checagem NÃO pode ser só "existe uma
// entrada em DB_SHEETS_META['jul2026']?" — um bot antigo (já apagado,
// aquele que baixava planilha errada) deixou uma entrada órfã/vazia no
// /data/sheets_meta.json de um deploy passado, e essa checagem antiga
// ficava "true" pra sempre sem NUNCA semear de verdade — foi exatamente
// isso que bloqueou o primeiro deploy. Agora a checagem é sobre DADO REAL
// carregado (SHEET_EXTRAS["jul2026"] com linha de verdade).
// 🎯 Estado do mapa de grupos A-H de Julho 2026 — infra mínima mantida
// (o robô/admin de importação e checagem automática do DOL foi removido;
// isto só preserva o dado já usado por seedJul2026FromBundle e pelo
// filtro/exibição de grupo na busca, pra não quebrar em runtime).
const GRUPOS_J26_FILE = path.join(DATA_DIR, "grupos_jul2026.json");
let DB_GRUPOS_J26 = { mapa: {}, meta: { ultimaImportacao: null, historicoImportacoes: [] } };
function loadGruposJ26(){
  try{
    if(fs.existsSync(GRUPOS_J26_FILE)){
      const d = JSON.parse(fs.readFileSync(GRUPOS_J26_FILE,"utf8"));
      if(d && typeof d==="object"){
        DB_GRUPOS_J26.mapa = d.mapa || {};
        DB_GRUPOS_J26.meta = { ...DB_GRUPOS_J26.meta, ...(d.meta||{}) };
      }
    }
  }catch(e){ console.warn("[grupos-j26] falha ao carregar:", e.message); }
}
function persistGruposJ26(){
  try{
    const tmp = GRUPOS_J26_FILE+".tmp";
    fs.writeFileSync(tmp, JSON.stringify(DB_GRUPOS_J26));
    fs.renameSync(tmp, GRUPOS_J26_FILE);
  }catch(e){ console.warn("[grupos-j26] falha ao salvar:", e.message); }
}
// ═══ 📥 v180 — MESCLAGEM DE PLANILHA (fonte ÚNICA: importação do admin + seed) ═══
// Diagnóstico (18/09/2026): o jul2026_compact.json versionado no git é um
// ESQUELETO — 2.625 case numbers com empresa/estado/grupo e mais NADA (0
// e-mail, 0 título, 0 salário, 0 cidade). O dado completo daquela planilha só
// existe no disco de produção do site antigo, onde o robô de enriquecimento
// passou meses preenchendo vaga a vaga. Existem então DOIS caminhos pra trazer
// esse dado pra cá — o admin importa o JSON pelo painel, ou o arquivo bundled
// enriquecido chega num deploy — e os dois precisam da MESMA regra de fusão,
// nunca de duas.
//
// RÉGUA (ordem do dono): sobe a linha MAIS RICA, e NINGUÉM SOME.
//   1. linha com e-mail vence linha sem e-mail (é o e-mail que permite a
//      candidatura — perder um e-mail já descoberto é perder vaga de verdade);
//   2. entre duas com (ou duas sem) e-mail, vence a que tem mais campos
//      preenchidos entre t/w/ci/d/de/desc (título, salário, cidade, datas,
//      descrição — o que o enriquecimento do DOL traz);
//   3. empate → vence a linha NOVA (dado recém-importado é o mais fresco).
// Escolhida a base, a UNIÃO campo a campo (mergePreferindo, mod-vagas-
// integrity) preenche todo campo vazio da base com o da outra linha: o grupo
// A-H, o `_sheet` e qualquer coisa que o arquivo novo não trouxe continuam
// vivos. Case number que existia e NÃO veio no arquivo novo fica intocado.
function _mesclarPlanilha(atual, novas, opts){
  const o = opts || {};
  const sheetKey = o.sheetKey || "";
  const _cn = c => String(c==null?"":c).trim().toUpperCase();
  const _cheio = v => v!==undefined && v!==null && v!=="" && v!=="-" && v!=="–";
  const _temEmail = r => !!(r && r.e && String(r.e).includes("@"));
  const _riqueza = r => ["t","w","ci","d","de","desc"].reduce((n,f)=>n+(_cheio(r&&r[f])?1:0),0);
  // devolve a linha que vira BASE da união (regra 1→2→3 acima)
  const _base = (nova, velha) => {
    if(_temEmail(nova)!==_temEmail(velha)) return _temEmail(nova) ? nova : velha;
    return _riqueza(nova) >= _riqueza(velha) ? nova : velha;
  };
  const mapa = new Map(), ordem = [];
  for(const r of (atual||[])){
    const cn = _cn(r && r.c); if(!cn) continue;
    if(mapa.has(cn)){ mapa.set(cn, _vagaMergePreferindo(mapa.get(cn), r)); continue; } // nunca duplica
    mapa.set(cn, r); ordem.push(cn);
  }
  let adicionadas=0, atualizadas=0;
  for(const r of (novas||[])){
    const cn = _cn(r && r.c); if(!cn) continue;
    if(!mapa.has(cn)){ mapa.set(cn, {...r, c:cn}); ordem.push(cn); adicionadas++; continue; }
    const velha = mapa.get(cn);
    const base = _base(r, velha);
    const mesclada = _vagaMergePreferindo(base, base===r ? velha : r);
    mesclada.c = cn;
    let mudou=false;
    for(const k of Object.keys(mesclada)){ if(mesclada[k]!==velha[k]){ mudou=true; break; } }
    if(mudou) atualizadas++;
    mapa.set(cn, mesclada);
  }
  const rows = ordem.map(cn=>mapa.get(cn));
  rows.forEach(r=>{ if(!r.k) r.k=detectCategory(r.t,r.n); if(sheetKey) r._sheet=sheetKey; });
  const _comEmail = a => (a||[]).reduce((n,r)=>n+(_temEmail(r)?1:0),0);
  return { rows, adicionadas, atualizadas,
    preservadas: rows.length - adicionadas,
    antes: (atual||[]).length, recebidas: (novas||[]).length,
    emailAntes: _comEmail(atual), emailDepois: _comEmail(rows) };
}

// 🌱 v180 — SEED BUNDLED ENRIQUECIDO VENCE ESQUELETO EM /data.
// A planilha extra em /data SEMPRE vencia a cópia bundled ("já existe dado
// real"), o que é certo enquanto /data é o lado enriquecido. Só que o inverso
// aconteceu de verdade: /data (produção) ficou com o ESQUELETO semeado no
// primeiro deploy e o arquivo bundled é que passou a ser o lado completo.
// Decisão SÓ por evidência: se o que está em /data não tem NENHUM e-mail e o
// bundled tem, o bundled é mesclado por cima (mesma régua de `_mesclarPlanilha`
// — ninguém some). Idempotente: no boot seguinte /data já tem e-mail e a
// checagem sai de cara, sem nem abrir o arquivo bundled.
function _seedVenceEsqueleto(key, atual, bundled){
  const _comEmail = a => (a||[]).reduce((n,r)=>n+((r && r.e && String(r.e).includes("@"))?1:0),0);
  if(!Array.isArray(atual) || !atual.length) return { aplicar:false, motivo:"sem dado carregado em /data" };
  const emailAntes = _comEmail(atual);
  if(emailAntes>0) return { aplicar:false, motivo:"/data já tem e-mail", emailAntes };
  if(!Array.isArray(bundled) || !bundled.length) return { aplicar:false, motivo:"bundled vazio/ilegível", emailAntes };
  const emailBundle = _comEmail(bundled);
  if(emailBundle<1) return { aplicar:false, motivo:"bundled também é esqueleto (0 e-mail)", emailAntes, emailBundle };
  return { aplicar:true, emailBundle, ..._mesclarPlanilha(atual, bundled, {sheetKey:key}) };
}

function _lerSeedBundled(arquivo){
  try{
    const seedPath = path.join(__dirname, arquivo);
    if(!fs.existsSync(seedPath)) return null;
    const d = JSON.parse(fs.readFileSync(seedPath,"utf8"));
    return (Array.isArray(d) && d.length) ? d : null;
  }catch(e){ console.warn(`[sheet] ⚠️ não consegui ler ${arquivo}: ${e.message}`); return null; }
}
// 🧩 v182 LOTE 8: grava a jul2026 mesclada (memória + /data + meta) — o MESMO
// caminho pro seed automático (esqueleto em /data, v180) e pro "force" do
// admin. Sem isso o force continuaria destrutivo, com a régua de fusão só num
// dos dois lugares.
function _aplicarSeedJul2026(m, origem){
  SHEET_EXTRAS["jul2026"] = m.rows;
  DB_SHEETS_META["jul2026"] = { ...(DB_SHEETS_META["jul2026"]||{}), count:m.rows.length, uniqueCaseCount:m.rows.length,
    file: DB_SHEETS_META["jul2026"]?.file || "jul2026.json", published:true,
    seedMergedAt: Date.now(), seedMergedRows: m.recebidas, source:origem };
  try{
    if(!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR,{recursive:true});
    _writeFileAtomic(path.join(SHEETS_DIR, DB_SHEETS_META["jul2026"].file), JSON.stringify(m.rows));
    _writeFileAtomic(SHEETS_META_FILE, JSON.stringify(DB_SHEETS_META,null,2));
  }catch(e){ console.warn("[sheet] ⚠️ jul2026: mesclei o seed em memória mas falhei ao gravar em /data:", e.message); }
  return { ok:true, skipped:false, migrado:true, count:m.rows.length, atualizadas:m.atualizadas, adicionadas:m.adicionadas, comEmail:m.emailDepois };
}
function seedJul2026FromBundle(force){
  const hasRealJul2026 = Array.isArray(SHEET_EXTRAS["jul2026"]) && SHEET_EXTRAS["jul2026"].length>0;
  // 🧩 v182 LOTE 8: FORÇAR A SEMEADURA NÃO PODE SER DESTRUTIVO. O botão do
  // painel trocava a planilha INTEIRA pelo arquivo bundled (hoje um esqueleto
  // sem e-mail) — em produção, com /data já enriquecido pelo robô, um clique
  // apagaria meses de e-mail, cidade e descrição. Agora força = MESCLA, pela
  // MESMA `_mesclarPlanilha` do upload e do seed (ninguém some, a linha mais
  // rica vence). Semear do zero segue existindo só quando não há NADA no ar.
  if(hasRealJul2026 && force){
    const bundled = _lerSeedBundled("jul2026_compact.json");
    if(!bundled) return { ok:false, reason:'arquivo bundled não encontrado ou vazio no deploy' };
    const m = _mesclarPlanilha(SHEET_EXTRAS["jul2026"], bundled, {sheetKey:"jul2026"});
    const r = _aplicarSeedJul2026(m, "seed-bundled-forcado");
    console.log(`[sheet] 🌱 jul2026: seed bundled MESCLADO por ordem do admin — ${m.atualizadas} atualizada(s), ${m.adicionadas} nova(s), ${m.rows.length} no total (${m.emailAntes} → ${m.emailDepois} com e-mail).`);
    return { ...r, mesclado:true };
  }
  if(hasRealJul2026 && !force){
    // 🌱 v180: /data pode estar com o ESQUELETO (0 e-mail) enquanto o arquivo
    // bundled deste deploy já é a planilha enriquecida — nesse caso o bundled
    // vence e é MESCLADO por cima (ninguém some). Só lê o arquivo quando o que
    // está em memória não tem e-mail nenhum: com e-mail em /data, sai na hora.
    const atual = SHEET_EXTRAS["jul2026"];
    const semEmail = !atual.some(r=>r && r.e && String(r.e).includes("@"));
    if(semEmail){
      const m = _seedVenceEsqueleto("jul2026", atual, _lerSeedBundled("jul2026_compact.json"));
      if(m.aplicar){
        const r = _aplicarSeedJul2026(m, "seed-bundled-enriquecido");
        console.log(`[sheet] 🌱 jul2026: esqueleto em /data substituído pelo seed bundled enriquecido (${m.emailDepois} linhas com e-mail) — ${m.atualizadas} atualizada(s), ${m.adicionadas} nova(s), ${m.rows.length} no total.`);
        return r;
      }
    }
    return { ok:true, skipped:true, reason:'já existe dado real', count:atual.length };
  }
  if(DB_SHEETS_META["jul2026"] && !hasRealJul2026) console.log(`[sheet] ⚠️ jul2026 tinha uma entrada em sheets_meta.json mas SEM vaga real carregada (provavelmente resquício de bot antigo) — semeando do zero mesmo assim.`);
  try{
    const seedPath = path.join(__dirname, "jul2026_compact.json");
    let seed = _lerSeedBundled("jul2026_compact.json"); // v180: leitura única, usada também pela migração de esqueleto acima
    if(!seed){
      console.warn(`[sheet] ⚠️ jul2026_compact.json não encontrado/vazio em ${seedPath} — nada pra semear.`);
      return { ok:false, reason:'arquivo bundled não encontrado ou vazio no deploy' };
    }
    seed = _selfHealSheetIntegrity("jul2026", seed, seedPath);
    seed.forEach(r=>{ if(!r.k) r.k=detectCategory(r.t,r.n); r._sheet="jul2026"; });
    SHEET_EXTRAS["jul2026"] = seed;
    DB_SHEETS_META["jul2026"] = {
      name: "Julho 2026 (H-2B)", key: "jul2026", emoji: "❄️",
      // 🐛 KB-FIX (09/07/2026): faltava "file" aqui. Sem isso, o loop que
      // recarrega planilhas EXTRAS de /data/sheets/*.json (loadSheets, ao
      // ler DB_SHEETS_META) pulava "jul2026" com `if(!meta?.file) continue`
      // — então SHEET_EXTRAS["jul2026"] nascia VAZIO em todo restart/deploy,
      // hasRealJul2026 dava false, e seedJul2026FromBundle() re-semeava do
      // zero (0% e-mail) TODA VEZ, jogando fora todo o enriquecimento já
      // salvo em disco. É exatamente por isso que o enriquecimento "não ia
      // pra frente": cada deploy resetava o progresso antes de terminar.
      file: "jul2026.json",
      published: true, publishedAt: Date.now(), visaType: "H-2B",
      count: seed.length, uniqueCaseCount: seed.length,
      source: "seed-bundled-publicfacingreport",
      uploaded: Date.now(),
    };
    try{ fs.writeFileSync(SHEETS_META_FILE, JSON.stringify(DB_SHEETS_META,null,2)); }catch{}
    try{
      if(!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR,{recursive:true});
      fs.writeFileSync(path.join(SHEETS_DIR,"jul2026.json"), JSON.stringify(seed));
    }catch(e){ console.warn("[sheet] ⚠️ jul2026 seed: falha ao gravar em /data/sheets:", e.message); }
    console.log(`[sheet] 🌱 jul2026 semeada do arquivo bundled: ${seed.length} vagas publicadas (sem e-mail ainda — Enriquecimento é manual desde o v217, use a aba Planilhas & Robôs).`);

    // Também alimenta o mapa de grupos oficiais (mesmos dados, mesma
    // fonte) — assim o card "Grupos — Julho 2026" já mostra as
    // estatísticas certas sem precisar reimportar nada.
    let novosGrupos=0;
    try{
      for(const r of seed){
        const cn=String(r.c||"").toUpperCase();
        if(r.g && /^[A-H]$/.test(r.g) && !DB_GRUPOS_J26.mapa[cn]){
          DB_GRUPOS_J26.mapa[cn] = { grupo:r.g, manual:false, empresa:r.n||"", estado:r.s||"", status:r.st||"", importadoEm:Date.now(), fonte:'seed-bundled' };
          novosGrupos++;
        }
      }
      if(novosGrupos>0){
        DB_GRUPOS_J26.meta.ultimaImportacao = { at:Date.now(), fonte:'seed-bundled', arquivo:'jul2026_compact.json', novos:novosGrupos, atualizados:0, rejeitados:0, totalNoRelatorio:seed.length };
        DB_GRUPOS_J26.meta.historicoImportacoes.unshift(DB_GRUPOS_J26.meta.ultimaImportacao);
        persistGruposJ26();
        console.log(`[grupos-j26] 🌱 ${novosGrupos} grupo(s) semeado(s) junto com a planilha jul2026.`);
      }
    }catch(e){ console.warn("[grupos-j26] ⚠️ falha ao semear grupos junto com jul2026:", e.message); }
    return { ok:true, skipped:false, count:seed.length, novosGrupos };
  }catch(e){
    console.warn("[sheet] ⚠️ Falha ao semear jul2026 do arquivo bundled:", e.message);
    return { ok:false, reason:e.message };
  }
}

const CATEGORY_KEYWORDS = {
  landscape:    ['landscape','lawn','turf','grass','grounds','mowing','garden','tree','arborist','nursery','sod','irrigation','mulch','shrub'],
  construction: ['construction','concrete','masonry','roofing','gutter','excavat','paving','asphalt','electrical','plumb','hvac','demolit','contractor','builders'],
  housekeeper:  ['hotel','resort','hospitality','inn','lodge','motel','housekeeper','cleaning','laundry','maid'],
  seafood:      ['seafood','fish','crab','lobster','oyster','shrimp','vessel','marine','aqua','shellfish'],
  farm:         ['farm','agri','crop','harvest','orchard','ranch','dairy','livestock','poultry'],
  golf:         ['golf','country club'],
  amusement:    ['amusement','carnival','fair','theme park','waterpark','camp'],
  forest:       ['forest','timber','logging','reforestation'],
  lifeguard:    ['lifeguard','pool','aquatic','swim'],
  // ⚠️ V960 (correção do bug Housekeeper↔Cook): faltavam palavras de CARGO
  // aqui — antes só tinha nome de lugar (restaurant/grill/...), então um
  // título "Cook"/"Chef"/"Kitchen" nunca vencia "hotel/resort" quando o
  // nome da empresa também aparecia no texto analisado.
  food:         ['restaurant','grill','tavern','cantina','bistro','brewpub','cafeteria','diner','foodservice','food service','food prep','bartend','cook','chef','kitchen','dishwasher','waiter','waitress','server','banquet','busser','baker','barista'],
  ski:          ['ski ','snowboard','winter resort','mountain resort'],
};

// ═══ 🏷️ v179 LOTE 2 — A CATEGORIA SAI DO TÍTULO, NÃO DO NOME DA EMPRESA ═══
// Até aqui `detectCategory` recebia "empresa + título" GRUDADOS e procurava as
// chaves de JOB_TITLE_TO_CAT com `includes` solto no texto inteiro. Dois
// estragos medidos nas planilhas empacotadas:
//  • "Landscape Laborer" casava com a chave "laborer" (construção) porque
//    "landscape" não existia na tabela — e `recategorizeAllSheets` refazia
//    esse erro em TODO boot: jan2026 saía de landscape 3.930 / construction
//    1.372 pra landscape 1.282 / construction 4.002. 2.558 dos 3.375 títulos
//    com "landscap" acabavam dentro de 🏗️ Construção, a gaveta mais usada
//    do site apontando pra vaga errada.
//  • Como o NOME DA EMPRESA entrava no mesmo texto, uma chave mais longa
//    vinda dela vencia o cargo real: "Landscape Laborer | Painted Woods Golf
//    Course" → golf; "Forestry Worker | Cumberland Forestry Contractors" →
//    construção (por "contractor").
// Regra nova, em 3 passos, nesta ordem e sem exceção:
//  (1) tabela de CARGOS só contra o TÍTULO, por PALAVRA/FRASE INTEIRA e do
//      match mais específico pro mais curto; chave GENÉRICA (laborer, worker,
//      kitchen, server, cleaner, restaurant, golf course) só decide quando
//      nenhuma específica casou;
//  (2) palavras-chave (CATEGORY_KEYWORDS) ainda sobre o TÍTULO;
//  (3) só então o nome da EMPRESA, como desempate.
// PROIBIDO voltar a decidir categoria por nome de empresa antes do título.
let _jobTitlePriorityKeys = null;
const _catRegexCache = new Map();
// Chaves que, sozinhas, não dizem de que trabalho se trata — toda categoria
// tem "laborer"/"worker" e um clube de golfe tem cozinha, quarto e jardim.
const CAT_CHAVES_GENERICAS = new Set(["laborer", "worker", "general laborer", "kitchen", "kitchen staff", "server", "cleaner", "restaurant", "golf course"]);
// Título normalizado pra casamento por palavra inteira: pontuação vira
// espaço ("Cooks, Restaurant" → "cooks restaurant").
const _normTitulo = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
// O "s?" no fim aceita o PLURAL do último termo — a fonte escreve tanto
// "General Laborer" quanto "General Laborers"/"Janitors"/"Cooks", e exigir a
// palavra exata jogava essas vagas em "other" (regressão pega medindo as
// planilhas antes de commitar, não por leitura de código).
function _chaveInteira(texto, chave) {
  let re = _catRegexCache.get(chave);
  if (!re) { re = new RegExp("(?:^| )" + chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, " ") + "s?(?: |$)"); _catRegexCache.set(chave, re); }
  return re.test(texto);
}
function detectCategory(titulo, empresa) {
  const t = _normTitulo(titulo);
  // (1) tabela de cargos, SÓ no título, palavra inteira, mais específico 1º
  if (t) {
    if (!_jobTitlePriorityKeys) _jobTitlePriorityKeys = Object.entries(JOB_TITLE_TO_CAT).sort((a, b) => b[0].length - a[0].length);
    let generica = "";
    for (const [chave, cat] of _jobTitlePriorityKeys) {
      if (!_chaveInteira(t, chave)) continue;
      if (CAT_CHAVES_GENERICAS.has(chave)) { if (!generica) generica = cat; continue; }
      return cat;
    }
    if (generica) return generica;
  }
  // (2) palavras-chave, ainda no TÍTULO
  const tl = String(titulo || "").toLowerCase();
  if (tl) for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) { if (kws.some(k => tl.includes(k))) return cat; }
  // (3) só agora a EMPRESA desempata
  const nl = String(empresa || "").toLowerCase();
  if (nl) for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) { if (kws.some(k => nl.includes(k))) return cat; }
  return "other";
}

function getSheet(n) { return n==="jan2026"?SHEET_JAN:n==="jul2025"?SHEET_JUL:(n==="h2a-jun2026"||n==="h2ajun2026")?SHEET_H2A:SHEET_EXTRAS[n]||[]; }

// ── v51 (dono, 25/07): qual é a planilha H-2B mais RECENTE? ─────────────────
// O DOL trabalha em ciclo jan/jul: a última lista H-2B foi a de JULHO (2026);
// quando a de JANEIRO (2027) sair e for publicada, ela assume SOZINHA como a
// mais nova — sem mexer em código. A chave da planilha carrega mês+ano
// (jan2026, jul2025, jul2026, jan2027...) e vira um placar ano*100+mês.
// Rascunho (published:false) não conta — só o que o usuário já vê.
// v180: `comEmail:true` só considera planilha que JÁ tem contato — o selo
// "⭐ MAIS NOVA" da lista do usuário usa essa variante (vender como mais nova
// uma planilha de onde não sai NENHUMA candidatura é propaganda enganosa).
// latestH2bBruta (sem opções, GET /api/sheets-list) continua sem exigir
// e-mail: é o "mais nova de verdade" bruto, informativo pro admin, mesmo
// antes do enriquecimento terminar (v208: não existe mais robô de frescor
// pra "precisar conferir" — a variante ficou só como leitura honesta).
function latestH2bKey(opts){
  const exigirEmail = !!(opts && opts.comEmail);
  let best=null,bestScore=-1;
  const consider=(key)=>{
    // v174: a "H-2B <Mês> <Ano>" do robô mensal (chave h2b-AAAAMM) também
    // disputa — a mais recente vira a H-2B MAIS NOVA sozinha (na lista do
    // usuário e no latestH2bBruta que o admin lê).
    const m=String(key).toLowerCase().match(/(jan|jul)\s*(\d{4})/);
    const m2=String(key).toLowerCase().match(/^h2b-(\d{4})(\d{2})$/);
    if(!m&&!m2)return;
    const rows=getSheet(key);
    if(!Array.isArray(rows)||!rows.length)return;
    const meta=DB_SHEETS_META[key];
    if(meta&&meta.published===false)return; // rascunho não conta
    if(meta&&meta.historico===true)return;  // temporada histórica não disputa
    if(exigirEmail&&!rows.some(r=>r&&r.e&&String(r.e).includes("@")))return; // v180: sem contato, não é "a mais nova" pro usuário
    const score=m?parseInt(m[2],10)*100+(m[1]==="jul"?7:1):parseInt(m2[1],10)*100+parseInt(m2[2],10);
    if(score>bestScore){bestScore=score;best=key;}
  };
  ["jan2026","jul2025"].forEach(consider);
  Object.keys(SHEET_EXTRAS).forEach(consider);
  return best;
}
function getAllSheets() {
  // Retorna TODAS as planilhas combinadas (jan + jul + extras)
  return [...SHEET_JAN,...SHEET_JUL,...SHEET_H2A,...Object.values(SHEET_EXTRAS).flat()];
}

// ── computeWageStats (SEO): agrega salário/hora REAL a partir das planilhas
// já carregadas em memória — usado por /api/public-wage-stats (página geral)
// e pelas páginas dinâmicas /vagas-h2b/:estado (SEO programático por estado).
// Nunca inventa número; só agrega o que já está nos dados do próprio sistema.
function computeWageStats(){
  // Corte de US$100/h: remove ~46 vagas de "range livestock/sheepherder" e
  // cargos de temporada (ex.: Alpine Ski Coach) que vêm com wunit="h" mas
  // "w" é na verdade um salário MENSAL (regra federal especial de pastoreio
  // a céu aberto) — mistagged na planilha de origem, não erro nosso. Nenhuma
  // vaga H-2B/H-2A legítima paga acima disso por hora.
  const rows=getAllSheets().filter(r=>r&&r.wunit==="h"&&r.w&&parseFloat(r.w)>0&&parseFloat(r.w)<=100);
  const wageOf=r=>parseFloat(r.w);
  const overall=(()=>{
    if(!rows.length)return{count:0,avg:0,min:0,max:0};
    const ws=rows.map(wageOf);
    return{count:rows.length,avg:+(ws.reduce((a,b)=>a+b,0)/ws.length).toFixed(2),min:+Math.min(...ws).toFixed(2),max:+Math.max(...ws).toFixed(2)};
  })();
  const groupBy=(keyFn,labelFn)=>{
    const map=new Map();
    for(const r of rows){
      const k=keyFn(r);if(!k)continue;
      if(!map.has(k))map.set(k,{sum:0,count:0,min:Infinity,max:-Infinity});
      const g=map.get(k);const w=wageOf(r);g.sum+=w;g.count++;g.min=Math.min(g.min,w);g.max=Math.max(g.max,w);
    }
    return[...map.entries()]
      .map(([k,g])=>({key:k,label:labelFn(k),count:g.count,avgWage:+(g.sum/g.count).toFixed(2),minWage:+g.min.toFixed(2),maxWage:+g.max.toFixed(2)}))
      .sort((a,b)=>b.count-a.count);
  };
  const byCategoryAll=groupBy(r=>r.k||"other",k=>CATEGORY_LABELS[k]?.label||k);
  const byStateAll=groupBy(r=>normalizeStateName(r.s),k=>k).map(s=>({...s,slug:stateSlug(s.key)}));
  // Top categorias DENTRO de cada estado (conteúdo único por página de estado)
  const catByState=new Map();
  for(const r of rows){
    const st=normalizeStateName(r.s);if(!st)continue;
    if(!catByState.has(st))catByState.set(st,new Map());
    const cm=catByState.get(st);
    const k=r.k||"other";
    if(!cm.has(k))cm.set(k,{sum:0,count:0});
    const g=cm.get(k);g.sum+=wageOf(r);g.count++;
  }
  const topCategoriesByState=new Map();
  for(const[st,cm]of catByState.entries()){
    topCategoriesByState.set(st,[...cm.entries()]
      .map(([k,g])=>({key:k,label:CATEGORY_LABELS[k]?.label||k,count:g.count,avgWage:+(g.sum/g.count).toFixed(2)}))
      .sort((a,b)=>b.count-a.count).slice(0,6));
  }
  // v18-SEO: espelho de topCategoriesByState, mas invertido — top ESTADOS
  // dentro de cada CATEGORIA. Alimenta as páginas /vagas-h2b/categoria/:cat
  // (SEO programático por categoria, mesma ideia das páginas por estado).
  const stateByCat=new Map();
  for(const r of rows){
    const st=normalizeStateName(r.s);if(!st)continue;
    const k=r.k||"other";
    if(!stateByCat.has(k))stateByCat.set(k,new Map());
    const sm=stateByCat.get(k);
    if(!sm.has(st))sm.set(st,{sum:0,count:0});
    const g=sm.get(st);g.sum+=wageOf(r);g.count++;
  }
  const topStatesByCategory=new Map();
  for(const[k,sm]of stateByCat.entries()){
    topStatesByCategory.set(k,[...sm.entries()]
      .map(([st,g])=>({key:st,label:st,slug:stateSlug(st),count:g.count,avgWage:+(g.sum/g.count).toFixed(2)}))
      .sort((a,b)=>b.count-a.count).slice(0,8));
  }
  return{overall,byCategoryAll,byStateAll,topCategoriesByState,topStatesByCategory};
}

// ── Página dinâmica SEO programático: /vagas-h2b/:estado ────────────────────
// Uma página por estado (só para estados com volume real de vagas — evita
// "thin content"), gerada no servidor com números reais e únicos por estado
// (contagem, salário médio/mín/máx, top categorias daquele estado). Reaproveita
// o mesmo sistema visual das outras páginas SEO (h2bapply-funciona.html etc).
const MIN_JOBS_FOR_STATE_PAGE=20; // abaixo disso, conteúdo fraco demais pra indexar bem
// ── 📊 RESUMO DIÁRIO DO DONO (v37) ──────────────────────────────────────────
// Todo dia às 8h BRT os números de ontem (vendas, pedidos na mesa com alerta
// dos parados >24h, envios e usuários novos) vão pro LOG DOS ROBÔS, que o
// admin lê na aba "Planilhas & Robôs". Gatilho manual: POST
// /api/admin/resumo-diario-run.
// 🚨 v199 LOTE 18: até aqui o laço de entrega era `for(const ae of
// ADMIN_EMAILS){}` — CORPO VAZIO —, e mesmo assim o botLog escrevia "Enviado
// aos admins: ...": o painel afirmava TODO DIA uma entrega que nunca
// aconteceu. O laço morreu e o texto passou a dizer o que de fato é (o resumo
// de ontem, registrado aqui). Mandar por e-mail seria um 4º tipo de e-mail
// além dos 3 sancionados no v175 — decisão do dono, não faxina minha.
async function resumoDiarioDonoRun(){
  try{
    const DAY=86400_000;
    const ontem=new Date(Date.now()-3*3600_000-DAY); // "ontem" no fuso BRT
    const ontemISO=ontem.toISOString().slice(0,10);
    const [yy,mm,dd]=ontemISO.split("-");
    const ontemBR=`${dd}/${mm}/${yy}`; // formato do dateStr do histórico
    let vendas=0,vendasQtd=0;
    for(const pg of (DB_FINANCEIRO.pagamentos||[])){
      const dt=String(pg.dataPagamento||pg.data||"").slice(0,10);
      if(dt===ontemISO){vendas+=(+pg.valor||0);vendasQtd++;}
    }
    const pend=DB_PEDIDOS.filter(x=>x.status==="pendente").length;
    const criticos=DB_PEDIDOS.filter(x=>x.status==="pendente"&&(Date.now()-(x.createdAt||0))>24*3600_000).length;
    let envios=0;
    for(const arr of Object.values(DB_HIST)){
      if(!Array.isArray(arr))continue;
      for(const h of arr){
        if(h.dateStr!==ontemBR)continue;
        if(h.type==="manual"||h.type==="auto")envios++;
      }
    }
    let novos=0;
    for(const u of Object.values(DB_USERS)){
      if(String(u?.created_at||"").slice(0,10)===ontemISO)novos++;
    }
    const body=`💰 R$ ${vendas.toFixed(0)} em ${vendasQtd} venda(s) · 🛒 ${pend} pedido(s) na mesa${criticos?` (⚡ ${criticos} há +24h!)`:""} · 📨 ${envios} envio(s) · 👤 ${novos} usuário(s) novo(s)`;
    try{botLog('resumo-dono','Resumo Diário do Dono',`Resumo de ontem: ${body}`,'info');}catch{}
    console.log(`[resumo-dono] 📊 ${body}`);
    return {ok:true,ontem:ontemISO,vendas,vendasQtd,pendentes:pend,criticos,envios,respostas:0,novosUsuarios:novos};
  }catch(e){ console.warn("[resumo-dono]",e.message); return {ok:false,error:e.message}; }
}
function scheduleResumoDono(){
  const now=new Date();const next=new Date(now);
  next.setUTCHours(11,0,0,0); // 8h BRT = 11h UTC
  if(next<=now)next.setUTCDate(next.getUTCDate()+1);
  setTimeout(async()=>{ await resumoDiarioDonoRun(); scheduleResumoDono(); }, next-now);
}




// ── 📡 v134 — RADAR DE VAGAS (aprovado pelo dono, 13/08) ────────────────────
// O usuário salva UM radar (os filtros inteiros da busca dele) e o sistema
// marca quantas vagas NOVAS entraram combinando com ele. Chamado pelos 2
// pontos onde vaga nova entra no sistema: robô Vagas Novas H-2A (diário) e a
// planilha mensal auto-publicada.
// 🚫 v189 LOTE 7 (decisão do dono): NÃO existe push nem aviso no celular.
// Esta reconstrução não tem canal de notificação nenhum (pushToUser é no-op,
// PUSH_ENABLED=false) — o radar é um FILTRO SALVO que conta as vagas novas e
// mostra pro usuário quando ele abre o site. PROIBIDO voltar a escrever
// "avisamos"/"push"/"aviso no celular" em qualquer tela enquanto não existir
// um canal de verdade.
// 📡 v182 LOTE 9 — FILTROS DO RADAR, UMA RÉGUA SÓ. Aceita o formato NOVO
// (snapshot inteiro em `radar.filtros`) e o LEGADO (estados/cidade/q/categoria
// de radares criados antes), e devolve sempre um filtro do motor ÚNICO — quem
// avalia é o MESMO FILTROS.filtrar da lista de vagas e da fila do robô.
function _radarSanitiza(src){
  const o=src&&typeof src==="object"?src:{};
  const lim=(a,n,len)=>(Array.isArray(a)?a:(a?[a]:[])).map(x=>String(x).trim().slice(0,len)).filter(Boolean).slice(0,n);
  return {
    q:String(o.q||"").slice(0,60).trim(),
    estado:lim(o.estado!==undefined?o.estado:o.estados,8,40),
    cidade:lim(o.cidade,6,80),
    categoria:lim(o.categoria,8,30),
    cargo:lim(o.cargo,6,140),
    status:lim(o.status,6,60),
    grupo:lim(o.grupo,8,2),
    temporada:lim(o.temporada,4,20),
    visa:lim(o.visa,2,10),
    inicio:lim(o.inicio,12,10),
    exp:(Array.isArray(o.exp)?o.exp:[]).map(x=>parseInt(x,10)).filter(n=>Number.isFinite(n)&&n>=0&&n<=600).slice(0,6),
    salarioMin:Number(o.salarioMin)>0?Number(o.salarioMin):0,
    vagasMin:Number(o.vagasMin)>0?Math.floor(Number(o.vagasMin)):0,
    email:o.email===true,
  };
}
function _radarFiltrosDe(r){
  if(!r)return null;
  const base=(r.filtros&&typeof r.filtros==="object")?r.filtros:_radarSanitiza(r);
  return FILTROS.parse(base);
}
// 📡 v189 LOTE 7 — O RADAR É UM FILTRO SALVO, NÃO UM AVISO (decisão do dono).
// Esta função se chamava "notificar" e contava `totalAvisos`, que a tela
// mostrava como "🔔 N avisos já enviados" — mas NENHUM aviso saía daqui: não
// há push (pushToUser é no-op, PUSH_ENABLED=false) e nem sequer era chamado.
// O número subia sozinho e o usuário acreditava que tinha sido avisado N
// vezes. Agora o que se registra é o que realmente acontece: quantas vagas
// NOVAS entraram combinando com o filtro salvo (`radar.novas`, contagem real
// de matches) e quando (`radar.ultimaEm`) — o usuário vê isso ao abrir o
// Radar. A trava de 1x/dia saiu junto: ela era anti-spam de push, e contar
// vaga nova não faz spam nenhum.
async function registrarVagasNovasNoRadar(novas,origem){
  try{
    if(!Array.isArray(novas)||!novas.length)return 0;
    const now=Date.now();let atingidos=0;
    for(const [em,u2] of Object.entries(DB_USERS)){
      const r=u2?.radar;if(!r||r.ativo===false)continue;
      const f=_radarFiltrosDe(r);
      if(!f||!FILTROS.ativos(f))continue;
      const matches=FILTROS.filtrar(novas,f,{isDP:_isDoublePro(u2)});
      if(!matches.length)continue;
      setUser(em,{radar:{...r,ultimaEm:now,novas:Math.min(9999,(r.novas||0)+matches.length)}});
      atingidos++;
    }
    if(atingidos)console.log(`[radar] 📡 ${atingidos} radar(es) com vaga nova combinando (${origem}, ${novas.length} vagas novas)`);
    return atingidos;
  }catch(e){console.warn("[radar]",e.message);return 0;}
}


function renderStatePage(entry,topCats,overallCount){
  const {key:stateName,count,avgWage,minWage,maxWage}=entry;
  const titleCase=stateName.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
  const fmtN=n=>Number(n).toLocaleString("pt-BR");
  const fmtUsd=n=>"US$ "+Number(n).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
  // v18-SEO: link cruzado pra página da categoria (linkagem interna — ajuda o
  // Google a descobrir as páginas novas de /vagas-h2b/categoria/:cat e passa
  // "link juice" entre as duas famílias de página programática).
  const catRows=topCats.map(c=>`<tr><td class="lbl"><a href="/vagas-h2b/categoria/${c.key}">${c.label}</a></td><td class="cnt">${fmtN(c.count)}</td><td class="wg">${fmtUsd(c.avgWage)}/h</td></tr>`).join("");
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1a56db">
<title>Vagas H-2B e H-2A em ${titleCase}: ${fmtN(count)} Vagas, Salário Médio ${fmtUsd(avgWage)}/h</title>
<meta name="description" content="${fmtN(count)} vagas H-2B/H-2A certificadas pelo DOL em ${titleCase}, com salário médio de ${fmtUsd(avgWage)}/hora (variando ${fmtUsd(minWage)} a ${fmtUsd(maxWage)}). Dados reais, calculados ao vivo.">
<meta name="author" content="H2BApply">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://h2bapply.com/vagas-h2b/${entry.slug}">
<meta property="og:title" content="Vagas H-2B e H-2A em ${titleCase}: ${fmtN(count)} Vagas, Salário Médio ${fmtUsd(avgWage)}/h">
<meta property="og:description" content="${fmtN(count)} vagas H-2B/H-2A certificadas pelo DOL em ${titleCase}, salário médio ${fmtUsd(avgWage)}/hora.">
<meta property="og:url" content="https://h2bapply.com/vagas-h2b/${entry.slug}">
<meta property="og:type" content="article">
<meta property="og:image" content="https://h2bapply.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Vagas H-2B e H-2A em ${titleCase}: ${fmtN(count)} Vagas, Salário Médio ${fmtUsd(avgWage)}/h">
<meta name="twitter:description" content="${fmtN(count)} vagas H-2B/H-2A certificadas pelo DOL em ${titleCase}, salário médio ${fmtUsd(avgWage)}/hora.">
<meta name="twitter:image" content="https://h2bapply.com/og-image.png">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&family=Sora:wght@700;800&display=swap" rel="stylesheet">
<link rel="preload" as="style" href="/vendor/tabler-icons.min.css" onload="this.onload=null;this.rel='stylesheet'" onerror="this.onerror=null;this.href='/vendor/tabler-icons.min.css';this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="/vendor/tabler-icons.min.css"></noscript>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}body{font-family:'DM Sans',system-ui,sans-serif;background:#f0f4ff;color:#1e1b4b;font-size:15px;line-height:1.6}
a{color:inherit;text-decoration:none}
:root{--surface:#fff;--sf2:#f5f7ff;--sf4:#e0e7ff;--border:rgba(99,102,241,.12);--t2:#4c4f82;--t3:#7c7fb5;--t4:#a5a8cc;--blue:#3b82f6;--bluel:rgba(59,130,246,.14);--blueb:rgba(59,130,246,.32);--green:#10b981;--greenl:rgba(16,185,129,.13);--navy:#0f172a;--r:10px;--rl:14px;--rxl:20px}
.top-bar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:58px;background:rgba(255,255,255,.92);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
.logo-row{display:flex;align-items:center;gap:10px;font-family:'Sora',sans-serif;font-weight:800;font-size:17px;color:var(--navy)}
.logo-row img{width:36px;height:36px;border-radius:10px}
.btn-login{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,#3b82f6,#7c3aed);color:#fff;font-weight:700;font-size:13px;padding:9px 18px;border-radius:10px;border:none;box-shadow:0 4px 15px rgba(59,130,246,.3)}
.hero{background:linear-gradient(160deg,#052e1c,#065f46,#0d7a4f,#10b981);color:#fff;padding:48px 20px 36px;text-align:center}
.hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;margin-bottom:18px}
.hero h1{font-family:'Sora',sans-serif;font-size:clamp(22px,4.8vw,34px);font-weight:800;line-height:1.26;margin-bottom:12px;max-width:680px;margin-left:auto;margin-right:auto}
.hero-sub{font-size:14.5px;opacity:.9;max-width:540px;margin:0 auto 22px;line-height:1.7}
.btn-hero{display:inline-flex;align-items:center;gap:8px;padding:13px 24px;border-radius:12px;font-weight:700;font-size:14px;background:#fff;color:#065f46;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;max-width:820px;margin:0 auto;padding:28px 20px 4px}
.stat-card{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rl);padding:16px 14px;text-align:center;box-shadow:0 2px 10px rgba(99,102,241,.06)}
.stat-n{font-family:'Sora',sans-serif;font-size:22px;font-weight:800;color:var(--green)}
.stat-lbl{font-size:11.5px;font-weight:600;color:var(--t3);margin-top:3px}
.content{max-width:820px;margin:0 auto;padding:24px 20px 56px}
.section{margin:36px 0 0}
.section-head{margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid var(--sf4)}
.section-head h2{font-family:'Sora',sans-serif;font-size:19px;font-weight:800;color:var(--navy)}
.section-head p{font-size:12px;color:var(--t3);margin-top:2px}
.card{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rl);padding:18px 20px;box-shadow:0 2px 10px rgba(99,102,241,.04)}
.card p{font-size:13.5px;color:var(--t2);line-height:1.75;margin-bottom:10px}
.card p:last-child{margin-bottom:0}
.wage-table{width:100%;border-collapse:collapse;font-size:13.5px}
.wage-table th{text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--t3);font-weight:700;padding:8px 8px;border-bottom:2px solid var(--sf4)}
.wage-table td{padding:9px 8px;border-bottom:1px solid var(--border);color:var(--t2)}
.wage-table tr:last-child td{border-bottom:none}
.wage-table .wg{font-weight:800;color:var(--green);font-family:'Sora',sans-serif}
.wage-table .lbl{font-weight:700;color:var(--navy)}
.wage-table .lbl a{color:var(--navy)}
.wage-table .lbl a:hover{color:var(--green);text-decoration:underline}
.wage-table .cnt{color:var(--t3);font-size:12px}
.warn-box{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--r);margin:12px 0;font-size:12.5px;line-height:1.65;background:var(--bluel);border:1.5px solid var(--blueb);color:#1e40af}
.cta-section{background:linear-gradient(160deg,#0a0520,#1e1b4b,#4c1d95,#7c3aed);color:#fff;border-radius:var(--rxl);padding:34px 24px;text-align:center;margin:40px 0 28px}
.cta-section h3{font-family:'Sora',sans-serif;font-size:20px;font-weight:800;margin-bottom:8px}
.cta-section p{font-size:13.5px;opacity:.82;margin-bottom:20px;max-width:440px;margin-left:auto;margin-right:auto}
.cta-btn-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.btn-cta-white{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#1e1b4b;font-weight:700;font-size:13.5px;padding:12px 22px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.2)}
.btn-cta-outline{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.12);color:#fff;font-weight:700;font-size:13.5px;padding:12px 22px;border-radius:12px;border:1.5px solid rgba(255,255,255,.35)}
footer{background:#fff;border-top:1px solid var(--border);text-align:center;padding:22px 20px;font-size:12px;color:var(--t3)}
footer a{color:var(--blue);font-weight:600}
</style>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-XXXXXXXXXX');</script>
</head>
<body>
<header class="top-bar">
  <a href="/" class="logo-row"><img src="/apple-touch-icon.png" alt="H2BApply logo"><span>H2BApply</span></a>
  <a href="/?cadastro=1" class="btn-login" onclick="gtag('event','sign_up_intent',{method:'password',source:'vagas-h2b-${entry.slug}-nav'})"><i class="ti ti-rocket"></i> Começar grátis</a>
</header>
<section class="hero">
  <div class="hero-badge"><i class="ti ti-map-pin"></i> Vagas em ${titleCase}</div>
  <h1>Vagas H-2B e H-2A em ${titleCase}: quantas tem e quanto pagam</h1>
  <p class="hero-sub">${fmtN(count)} vagas certificadas pelo Departamento do Trabalho dos EUA (DOL) em ${titleCase}, com salário médio de ${fmtUsd(avgWage)} por hora. Números calculados ao vivo, direto da base de dados do H2BApply.</p>
  <a href="/?cadastro=1" class="btn-hero" onclick="gtag('event','sign_up_intent',{method:'password',source:'vagas-h2b-${entry.slug}-hero'})"><i class="ti ti-rocket"></i> Ver essas vagas grátis</a>
</section>
<div class="stats-row">
  <div class="stat-card"><div class="stat-n">${fmtN(count)}</div><div class="stat-lbl">Vagas em ${titleCase}</div></div>
  <div class="stat-card"><div class="stat-n">${fmtUsd(avgWage)}</div><div class="stat-lbl">Salário médio/hora</div></div>
  <div class="stat-card"><div class="stat-n">${fmtUsd(minWage)}–${fmtUsd(maxWage)}</div><div class="stat-lbl">Faixa de salário/hora</div></div>
</div>
<main class="content">
  <section class="section" id="categorias">
    <div class="section-head"><h2>Principais áreas de trabalho em ${titleCase}</h2><p>Categorias com mais vagas abertas no estado, e o salário médio de cada uma</p></div>
    <div class="card">
      <table class="wage-table"><thead><tr><th>Área</th><th>Vagas</th><th>Média/hora</th></tr></thead><tbody>${catRows}</tbody></table>
    </div>
    <div class="warn-box"><i class="ti ti-info-circle"></i><div>O salário exibido é a média entre as vagas certificadas em ${titleCase} — o valor exato de cada vaga é definido pelo DOL antes da contratação e pode variar por função e empregador específico.</div></div>
  </section>
  <section class="section" id="sobre">
    <div class="section-head"><h2>Como se candidatar às vagas de ${titleCase}</h2><p>Nenhuma vaga é vendida — a candidatura é direta ao empregador</p></div>
    <div class="card">
      <p>As vagas H-2B e H-2A em ${titleCase} vêm de planilhas públicas do Departamento do Trabalho dos EUA, o mesmo órgão que certifica o salário mínimo obrigatório de cada uma. O H2BApply organiza esses dados e automatiza o envio da sua candidatura para os empregadores certificados — sem cobrar taxa de recrutamento, o que é proibido pelas próprias regras do programa.</p>
      <p>Quer ver as vagas específicas de ${titleCase} disponíveis agora? Crie uma conta gratuita — leva menos de 1 minuto, com usuário e senha (sem conta do Google).</p>
    </div>
  </section>
  <div class="cta-section">
    <h3>Buscar vagas em ${titleCase} agora 🇺🇸</h3>
    <p>Conta grátis, sem cartão de crédito. O cadastro é usuário e senha e você já pode filtrar vagas por estado, categoria e salário.</p>
    <div class="cta-btn-row">
      <a href="/?cadastro=1" class="btn-cta-white" onclick="gtag('event','sign_up_intent',{method:'password',source:'vagas-h2b-${entry.slug}-cta'})"><i class="ti ti-rocket"></i> Criar conta grátis</a>
      <a href="/quanto-ganha-h2b" class="btn-cta-outline"><i class="ti ti-chart-bar"></i> Ver salários por estado</a>
    </div>
  </div>
</main>
<footer>
  <div style="margin-bottom:8px"><a href="/">H2BApply</a> · <a href="/guia">Guia H-2B/H-2A</a> · <a href="/h2b-e-golpe">H2B é Golpe?</a> · <a href="/quanto-ganha-h2b">Quanto Ganha?</a> · <a href="/privacidade">Privacidade</a> · <a href="/termos">Termos</a></div>
  <div>Dados calculados a partir de planilhas públicas do Departamento do Trabalho dos EUA. Conteúdo educativo, não é aconselhamento jurídico.</div>
</footer>
<!-- v18-SEO: BreadcrumbList — rich result de trilha de navegação no Google.
     Não usamos JobPosting aqui de propósito: esta página mostra ESTATÍSTICAS
     agregadas (contagem/salário médio de várias vagas de vários empregadores),
     não uma vaga específica — JobPosting exige campos de uma vaga individual
     (hiringOrganization, datePosted, validThrough) que não existem nesse nível
     de agregação, e usá-lo errado gera erro no Search Console. -->
<script type="application/ld+json">
${JSON.stringify({
  "@context":"https://schema.org",
  "@type":"BreadcrumbList",
  "itemListElement":[
    {"@type":"ListItem","position":1,"name":"H2BApply","item":"https://h2bapply.com/"},
    {"@type":"ListItem","position":2,"name":"Salários por Estado","item":"https://h2bapply.com/quanto-ganha-h2b"},
    {"@type":"ListItem","position":3,"name":`Vagas H-2B/H-2A em ${titleCase}`,"item":`https://h2bapply.com/vagas-h2b/${entry.slug}`}
  ]
})}
</script>
</body>
</html>`;
}

// ── Página dinâmica SEO programático: /vagas-h2b/categoria/:categoria ───────
// Espelha renderStatePage, mas por CATEGORIA de vaga (landscape, construction,
// farm etc.) em vez de por estado — mesmo padrão de "SEO programático" já
// validado nas páginas de estado, reaproveitando dados que computeWageStats()
// já calcula (topStatesByCategory). Cada página lista os estados com mais
// vagas daquela categoria e o salário médio em cada um.
const MIN_JOBS_FOR_CATEGORY_PAGE=20; // mesmo corte das páginas de estado — evita "thin content"
function renderCategoryPage(entry,topStates,overallCount){
  const {key:catKey,count,avgWage,minWage,maxWage}=entry;
  const fullLabel=CATEGORY_LABELS[catKey]?.label||catKey;
  const labelParts=fullLabel.split(" ");
  const catEmoji=labelParts.length>1?labelParts[0]:"📋";
  const catName=(labelParts.length>1?labelParts.slice(1).join(" "):fullLabel).trim();
  const fmtN=n=>Number(n).toLocaleString("pt-BR");
  const fmtUsd=n=>"US$ "+Number(n).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
  const stateRows=topStates.map(s=>{
    const stTitle=s.key.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
    return `<tr><td class="lbl"><a href="/vagas-h2b/${s.slug}">${stTitle}</a></td><td class="cnt">${fmtN(s.count)}</td><td class="wg">${fmtUsd(s.avgWage)}/h</td></tr>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1a56db">
<title>Vagas H-2B e H-2A de ${catName}: ${fmtN(count)} Vagas, Salário Médio ${fmtUsd(avgWage)}/h</title>
<meta name="description" content="${fmtN(count)} vagas H-2B/H-2A certificadas pelo DOL na área de ${catName}, com salário médio de ${fmtUsd(avgWage)}/hora (variando ${fmtUsd(minWage)} a ${fmtUsd(maxWage)}). Dados reais, calculados ao vivo.">
<meta name="author" content="H2BApply">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://h2bapply.com/vagas-h2b/categoria/${catKey}">
<meta property="og:title" content="Vagas H-2B e H-2A de ${catName}: ${fmtN(count)} Vagas, Salário Médio ${fmtUsd(avgWage)}/h">
<meta property="og:description" content="${fmtN(count)} vagas H-2B/H-2A certificadas pelo DOL na área de ${catName}, salário médio ${fmtUsd(avgWage)}/hora.">
<meta property="og:url" content="https://h2bapply.com/vagas-h2b/categoria/${catKey}">
<meta property="og:type" content="article">
<meta property="og:image" content="https://h2bapply.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Vagas H-2B e H-2A de ${catName}: ${fmtN(count)} Vagas, Salário Médio ${fmtUsd(avgWage)}/h">
<meta name="twitter:description" content="${fmtN(count)} vagas H-2B/H-2A certificadas pelo DOL na área de ${catName}, salário médio ${fmtUsd(avgWage)}/hora.">
<meta name="twitter:image" content="https://h2bapply.com/og-image.png">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&family=Sora:wght@700;800&display=swap" rel="stylesheet">
<link rel="preload" as="style" href="/vendor/tabler-icons.min.css" onload="this.onload=null;this.rel='stylesheet'" onerror="this.onerror=null;this.href='/vendor/tabler-icons.min.css';this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="/vendor/tabler-icons.min.css"></noscript>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}body{font-family:'DM Sans',system-ui,sans-serif;background:#f0f4ff;color:#1e1b4b;font-size:15px;line-height:1.6}
a{color:inherit;text-decoration:none}
:root{--surface:#fff;--sf2:#f5f7ff;--sf4:#e0e7ff;--border:rgba(99,102,241,.12);--t2:#4c4f82;--t3:#7c7fb5;--t4:#a5a8cc;--blue:#3b82f6;--bluel:rgba(59,130,246,.14);--blueb:rgba(59,130,246,.32);--green:#10b981;--greenl:rgba(16,185,129,.13);--navy:#0f172a;--r:10px;--rl:14px;--rxl:20px}
.top-bar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:58px;background:rgba(255,255,255,.92);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
.logo-row{display:flex;align-items:center;gap:10px;font-family:'Sora',sans-serif;font-weight:800;font-size:17px;color:var(--navy)}
.logo-row img{width:36px;height:36px;border-radius:10px}
.btn-login{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,#3b82f6,#7c3aed);color:#fff;font-weight:700;font-size:13px;padding:9px 18px;border-radius:10px;border:none;box-shadow:0 4px 15px rgba(59,130,246,.3)}
.hero{background:linear-gradient(160deg,#1e1b4b,#4c1d95,#6d28d9,#7c3aed);color:#fff;padding:48px 20px 36px;text-align:center}
.hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;margin-bottom:18px}
.hero h1{font-family:'Sora',sans-serif;font-size:clamp(22px,4.8vw,34px);font-weight:800;line-height:1.26;margin-bottom:12px;max-width:680px;margin-left:auto;margin-right:auto}
.hero-sub{font-size:14.5px;opacity:.9;max-width:540px;margin:0 auto 22px;line-height:1.7}
.btn-hero{display:inline-flex;align-items:center;gap:8px;padding:13px 24px;border-radius:12px;font-weight:700;font-size:14px;background:#fff;color:#4c1d95;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;max-width:820px;margin:0 auto;padding:28px 20px 4px}
.stat-card{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rl);padding:16px 14px;text-align:center;box-shadow:0 2px 10px rgba(99,102,241,.06)}
.stat-n{font-family:'Sora',sans-serif;font-size:22px;font-weight:800;color:#7c3aed}
.stat-lbl{font-size:11.5px;font-weight:600;color:var(--t3);margin-top:3px}
.content{max-width:820px;margin:0 auto;padding:24px 20px 56px}
.section{margin:36px 0 0}
.section-head{margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid var(--sf4)}
.section-head h2{font-family:'Sora',sans-serif;font-size:19px;font-weight:800;color:var(--navy)}
.section-head p{font-size:12px;color:var(--t3);margin-top:2px}
.card{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rl);padding:18px 20px;box-shadow:0 2px 10px rgba(99,102,241,.04)}
.card p{font-size:13.5px;color:var(--t2);line-height:1.75;margin-bottom:10px}
.card p:last-child{margin-bottom:0}
.wage-table{width:100%;border-collapse:collapse;font-size:13.5px}
.wage-table th{text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--t3);font-weight:700;padding:8px 8px;border-bottom:2px solid var(--sf4)}
.wage-table td{padding:9px 8px;border-bottom:1px solid var(--border);color:var(--t2)}
.wage-table tr:last-child td{border-bottom:none}
.wage-table .wg{font-weight:800;color:#7c3aed;font-family:'Sora',sans-serif}
.wage-table .lbl{font-weight:700;color:var(--navy)}
.wage-table .lbl a{color:var(--navy)}
.wage-table .lbl a:hover{color:#7c3aed;text-decoration:underline}
.wage-table .cnt{color:var(--t3);font-size:12px}
.warn-box{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--r);margin:12px 0;font-size:12.5px;line-height:1.65;background:var(--bluel);border:1.5px solid var(--blueb);color:#1e40af}
.cta-section{background:linear-gradient(160deg,#0a0520,#1e1b4b,#4c1d95,#7c3aed);color:#fff;border-radius:var(--rxl);padding:34px 24px;text-align:center;margin:40px 0 28px}
.cta-section h3{font-family:'Sora',sans-serif;font-size:20px;font-weight:800;margin-bottom:8px}
.cta-section p{font-size:13.5px;opacity:.82;margin-bottom:20px;max-width:440px;margin-left:auto;margin-right:auto}
.cta-btn-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.btn-cta-white{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#1e1b4b;font-weight:700;font-size:13.5px;padding:12px 22px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.2)}
.btn-cta-outline{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.12);color:#fff;font-weight:700;font-size:13.5px;padding:12px 22px;border-radius:12px;border:1.5px solid rgba(255,255,255,.35)}
footer{background:#fff;border-top:1px solid var(--border);text-align:center;padding:22px 20px;font-size:12px;color:var(--t3)}
footer a{color:var(--blue);font-weight:600}
</style>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-XXXXXXXXXX');</script>
</head>
<body>
<header class="top-bar">
  <a href="/" class="logo-row"><img src="/apple-touch-icon.png" alt="H2BApply logo"><span>H2BApply</span></a>
  <a href="/?cadastro=1" class="btn-login" onclick="gtag('event','sign_up_intent',{method:'password',source:'vagas-h2b-cat-${catKey}-nav'})"><i class="ti ti-rocket"></i> Começar grátis</a>
</header>
<section class="hero">
  <div class="hero-badge">${catEmoji} Vagas de ${catName}</div>
  <h1>Vagas H-2B e H-2A de ${catName} nos EUA: quantas tem e quanto pagam</h1>
  <p class="hero-sub">${fmtN(count)} vagas certificadas pelo Departamento do Trabalho dos EUA (DOL) na área de ${catName}, com salário médio de ${fmtUsd(avgWage)} por hora. Números calculados ao vivo, direto da base de dados do H2BApply.</p>
  <a href="/?cadastro=1" class="btn-hero" onclick="gtag('event','sign_up_intent',{method:'password',source:'vagas-h2b-cat-${catKey}-hero'})"><i class="ti ti-rocket"></i> Ver essas vagas grátis</a>
</section>
<div class="stats-row">
  <div class="stat-card"><div class="stat-n">${fmtN(count)}</div><div class="stat-lbl">Vagas de ${catName}</div></div>
  <div class="stat-card"><div class="stat-n">${fmtUsd(avgWage)}</div><div class="stat-lbl">Salário médio/hora</div></div>
  <div class="stat-card"><div class="stat-n">${fmtUsd(minWage)}–${fmtUsd(maxWage)}</div><div class="stat-lbl">Faixa de salário/hora</div></div>
</div>
<main class="content">
  <section class="section" id="estados">
    <div class="section-head"><h2>Onde tem mais vagas de ${catName}</h2><p>Estados com mais vagas abertas nessa área, e o salário médio de cada um</p></div>
    <div class="card">
      <table class="wage-table"><thead><tr><th>Estado</th><th>Vagas</th><th>Média/hora</th></tr></thead><tbody>${stateRows}</tbody></table>
    </div>
    <div class="warn-box"><i class="ti ti-info-circle"></i><div>O salário exibido é a média entre as vagas certificadas de ${catName} — o valor exato de cada vaga é definido pelo DOL antes da contratação e pode variar por função e empregador específico.</div></div>
  </section>
  <section class="section" id="sobre">
    <div class="section-head"><h2>Como se candidatar às vagas de ${catName}</h2><p>Nenhuma vaga é vendida — a candidatura é direta ao empregador</p></div>
    <div class="card">
      <p>As vagas H-2B e H-2A de ${catName} vêm de planilhas públicas do Departamento do Trabalho dos EUA, o mesmo órgão que certifica o salário mínimo obrigatório de cada uma. O H2BApply organiza esses dados e automatiza o envio da sua candidatura para os empregadores certificados — sem cobrar taxa de recrutamento, o que é proibido pelas próprias regras do programa.</p>
      <p>Quer ver as vagas específicas de ${catName} disponíveis agora? Crie uma conta gratuita — leva menos de 1 minuto, com usuário e senha (sem conta do Google).</p>
    </div>
  </section>
  <div class="cta-section">
    <h3>Buscar vagas de ${catName} agora 🇺🇸</h3>
    <p>Conta grátis, sem cartão de crédito. O cadastro é usuário e senha e você já pode filtrar vagas por estado, categoria e salário.</p>
    <div class="cta-btn-row">
      <a href="/?cadastro=1" class="btn-cta-white" onclick="gtag('event','sign_up_intent',{method:'password',source:'vagas-h2b-cat-${catKey}-cta'})"><i class="ti ti-rocket"></i> Criar conta grátis</a>
      <a href="/quanto-ganha-h2b" class="btn-cta-outline"><i class="ti ti-chart-bar"></i> Ver salários por estado</a>
    </div>
  </div>
</main>
<footer>
  <div style="margin-bottom:8px"><a href="/">H2BApply</a> · <a href="/guia">Guia H-2B/H-2A</a> · <a href="/h2b-e-golpe">H2B é Golpe?</a> · <a href="/quanto-ganha-h2b">Quanto Ganha?</a> · <a href="/privacidade">Privacidade</a> · <a href="/termos">Termos</a></div>
  <div>Dados calculados a partir de planilhas públicas do Departamento do Trabalho dos EUA. Conteúdo educativo, não é aconselhamento jurídico.</div>
</footer>
<script type="application/ld+json">
${JSON.stringify({
  "@context":"https://schema.org",
  "@type":"BreadcrumbList",
  "itemListElement":[
    {"@type":"ListItem","position":1,"name":"H2BApply","item":"https://h2bapply.com/"},
    {"@type":"ListItem","position":2,"name":"Salários por Estado","item":"https://h2bapply.com/quanto-ganha-h2b"},
    {"@type":"ListItem","position":3,"name":`Vagas de ${catName}`,"item":`https://h2bapply.com/vagas-h2b/categoria/${catKey}`}
  ]
})}
</script>
</body>
</html>`;
}

// Fisher-Yates shuffle — embaralha sem modificar o array original
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Maps job title keywords → category
const JOB_TITLE_TO_CAT = {
  bartender:"food",barman:"food",barmaid:"food",cook:"food","line cook":"food",
  "prep cook":"food",chef:"food",dishwasher:"food",waiter:"food",waitress:"food",
  "food server":"food",barista:"food",baker:"food","food service":"food",
  "kitchen staff":"food",kitchen:"food",server:"food",restaurant:"food",
  banquet:"food",busser:"food","food prep":"food","cafeteria worker":"food",
  landscaper:"landscape","lawn care":"landscape",groundskeeper:"landscape",
  gardener:"landscape","landscape worker":"landscape",
  // v179: sem estas chaves, "Landscape Laborer" (2.588 vagas em jan2026)
  // casava com "laborer" e ia parar em 🏗️ Construção.
  "landscape laborer":"landscape",landscape:"landscape",landscaping:"landscape",
  lawn:"landscape",grounds:"landscape",groundsman:"landscape",
  "nursery worker":"landscape","tree trimmer":"landscape",
  "forestry worker":"forest",forestry:"forest",
  carpenter:"construction",electrician:"construction",plumber:"construction",
  welder:"construction",roofer:"construction",mason:"construction",laborer:"construction",
  painter:"construction","general laborer":"construction",
  // v179: com o casamento por PALAVRA INTEIRA, "mason" não alcança mais os
  // compostos que a fonte usa de verdade (medido nas planilhas).
  brickmason:"construction",stonemason:"construction",blockmason:"construction",
  "tile setter":"construction","marble setter":"construction",
  housekeeper:"housekeeper",maid:"housekeeper",cleaner:"housekeeper",
  janitor:"housekeeper","room attendant":"housekeeper",
  "guestroom attendant":"housekeeper","front desk":"housekeeper",
  "seafood processor":"seafood","fish processor":"seafood","crab picker":"seafood",
  "farm worker":"farm",farmhand:"farm","field worker":"farm",harvester:"farm",
  greenskeeper:"golf",caddie:"golf","golf course":"golf",
  lifeguard:"lifeguard","pool attendant":"lifeguard",
};
const CAT_OCC_LABELS = {
  food:"Food Service Bartender Cook Waiter",landscape:"Landscape Grounds Lawn",
  construction:"Construction Labor Carpenter",housekeeper:"Housekeeper Cleaning Hotel",
  seafood:"Seafood Fish Crab Processor",farm:"Farm Agricultural Worker",
  golf:"Golf Course Greens",amusement:"Amusement Recreation Park",
  forest:"Forestry Timber Logging",lifeguard:"Lifeguard Pool Aquatic",
  ski:"Ski Resort Winter Mountain",other:"Seasonal Worker",
};

// ── v111b (dono, 02/08, print: "quero pesquisar Martha's Vineyard, Tisbury,
// Oak Bluffs, Edgartown…"): REGIÕES TURÍSTICAS DOS EUA → cidades-membro.
// A planilha só guarda a CIDADE de cada vaga; a região (ilha/costa/vale) é
// conhecimento nosso. Pesquisar o nome da região acha vaga em QUALQUER
// cidade dela. Chaves e valores já em forma normalizada (sem acento,
// apóstrofo ou maiúscula — mesmo _norm da busca). Cobre as regiões que
// mais empregam H-2B; adicionar aqui é 1 linha por região.
const REGIOES_EUA={
 "marthas vineyard":["edgartown","oak bluffs","tisbury","vineyard haven","west tisbury","chilmark","aquinnah","marthas vineyard"],
 "cape cod":["barnstable","hyannis","falmouth","provincetown","chatham","dennis","yarmouth","sandwich","brewster","orleans","truro","wellfleet","eastham","harwich","mashpee","bourne","woods hole","cape cod"],
 "nantucket":["nantucket","siasconset"],
 "florida keys":["key west","key largo","islamorada","marathon","big pine key","duck key","tavernier","florida keys"],
 "outer banks":["nags head","kill devil hills","kitty hawk","corolla","manteo","hatteras","avon","rodanthe","ocracoke","outer banks"],
 "hamptons":["southampton","east hampton","montauk","sag harbor","westhampton","bridgehampton","amagansett","hamptons"],
 "lake tahoe":["south lake tahoe","tahoe city","stateline","incline village","truckee","kings beach","lake tahoe"],
 "jackson hole":["jackson","teton village","wilson","moose","jackson hole"],
 "mackinac":["mackinac island","mackinaw city","st ignace","mackinac"],
 "smoky mountains":["gatlinburg","pigeon forge","sevierville","townsend","smoky mountains"],
 "wisconsin dells":["wisconsin dells","lake delton","baraboo"],
 "myrtle beach":["myrtle beach","north myrtle beach","surfside beach","murrells inlet","pawleys island"],
 "hilton head":["hilton head island","hilton head","bluffton"],
 "gulf shores":["gulf shores","orange beach","foley","fort morgan"],
 "ocean city":["ocean city","berlin","west ocean city"],
 "branson":["branson","hollister","ridgedale"],
 "aspen":["aspen","snowmass village","snowmass","basalt","carbondale"],
 "vail":["vail","avon","edwards","beaver creek","eagle"],
 "yellowstone":["west yellowstone","gardiner","cooke city","yellowstone national park","yellowstone"],
 "poconos":["stroudsburg","east stroudsburg","tannersville","mount pocono","pocono manor","poconos"],
 "adirondacks":["lake placid","lake george","saranac lake","bolton landing","adirondack"],
 "door county":["sturgeon bay","fish creek","ephraim","sister bay","egg harbor","door county"],
 "destin":["destin","miramar beach","santa rosa beach","fort walton beach","seaside","watercolor","rosemary beach"],
};
// v113: helpers de busca por lugar — mesma normalização do searchSheet
// (apóstrofo/acento/caixa) + expansão de região, reutilizáveis pelo filtro
// de CIDADE do modal (sheet-meta e jobs). Fonte única, nunca duplicar.
function _normBusca(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/["'‘’`´]/g,"").replace(/\s+/g," ").trim();}
// v179: a régua de casamento de lugar passou a existir em UMA versão só, que
// recebe o texto JÁ NORMALIZADO — o motor de filtros normaliza a cidade de
// cada linha uma única vez no índice (ix.ciN) em vez de re-normalizar 114 mil
// vezes por requisição. Fonte única: nunca duplicar a expansão de região.
function _cityMatchNorm(filtro){
  const ql=_normBusca(filtro);
  if(!ql)return null;
  let cities=null;
  for(const[reg,cs] of Object.entries(REGIOES_EUA)){
    if(ql===reg||ql.includes(reg)||(ql.length>=4&&reg.startsWith(ql))){cities=cs;break;}
  }
  return c=>{if(!c)return false;return c.includes(ql)||(cities&&cities.some(x=>c.includes(x)));};
}
// 🤖 v179: VERSÃO DA PLANILHA EM MEMÓRIA. Os robôs de planilha (enriquecimento,
// frescor, vagas novas) MUTAM as linhas no lugar — o array é o mesmo e o
// comprimento não muda, então o índice do motor de filtros ficava congelado
// até o próximo boot e o e-mail/cidade/data descobertos não valiam em filtro
// nenhum. Todo save passa por _saveEnrichedSheet, que incrementa aqui.
const _VF_CACHE = new Map(); // cache curto da contagem ao vivo (5s) — v179
const _sheetVerMap = new WeakMap();
function _bumpSheetVersion(arr){ if(Array.isArray(arr)) _sheetVerMap.set(arr,(_sheetVerMap.get(arr)||0)+1); }
function _sheetVersionOf(arr){ return (Array.isArray(arr) && _sheetVerMap.get(arr)) || 0; }

// ═══ 🔍 v173 (ordem do dono, 13/09/2026 — reset TOTAL dos filtros): MOTOR
// ÚNICO de filtros de vagas (mod-filtros.js). Lista do manual (/api/sheet-
// meta), contagem ao vivo por opção (/api/vagas/filtros), fila do automático
// e o REFILL (tryAutoRefill) leem e aplicam filtros pela MESMA função —
// antes eram 3 cópias que divergiam. AND entre dimensões, OR dentro. ═══
const { createFiltros: _createFiltros } = require("./mod-filtros.js");
const FILTROS = _createFiltros({
  normalizeStateName,
  normBusca: _normBusca,
  cityMatchNormFn: _cityMatchNorm,
  regioes: REGIOES_EUA,
  grupoDe: r => { const cn = String(r.c || "").toUpperCase(); return (r.g && /^[A-H]$/.test(r.g)) ? r.g : (DB_GRUPOS_J26.mapa[cn]?.grupo || ""); },
  searchSheet: (...a) => searchSheet(...a),
  categoriaLabel: k => CATEGORY_LABELS[k]?.label || k,
  sheetVersion: _sheetVersionOf,
});
// Corte por usuário (regra 8: empregador já contatado OU na fila do
// automático NUNCA reaparece). Devolve null quando não há nada a cortar.
// comProprios/comInvalidos: só o robô (nunca manda pra si mesmo nem pra
// e-mail já conhecido como inválido).
function _excluirEnviadosFn(email, { comProprios = false, comInvalidos = false } = {}) {
  if (!email) return null;
  const sSet = buildUserSentSet(email);
  const aJob = getAutoJob(email);
  const aSet = new Set((aJob?.queue || []).map(it => _normEmail(it.to || "")).filter(Boolean));
  const own = comProprios ? _ownEmailsOf(email) : null;
  if (!sSet.size && !aSet.size && !own && !comInvalidos) return null;
  return r => {
    const e = _normEmail(r.e || "");
    if (!e) return false;
    if (sSet.has(e) || aSet.has(e)) return true;
    if (own && own.has(e)) return true;
    if (comInvalidos && isEmailInvalid(e)) return true;
    return false;
  };
}
function _isDoublePro(u) { return !!(u && (u.isAdmin || getPlan(u) === "doublepro")); }

// ═══ 🔎 v179 LOTE 3 — BUSCA QUE ACHA O QUE EXISTE ═══
// Normalização ÚNICA da busca (acento, apóstrofo, pontuação) e PALHEIRO
// pré-calculado por LINHA. Antes a string de busca de cada vaga era montada
// DENTRO do filtro, a cada requisição (lição do v162: nada de texto dentro de
// laço quente). O palheiro passou a incluir DESCRIÇÃO, SOC e requisitos — a
// informação mais rica da linha estava invisível pra quem digitava
// ("forklift" está na descrição de 416 vagas da H-2A e a busca achava 1).
const _normSearch = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/["'‘’`´]/g, "")
  .replace(/[^a-z0-9@.\s]+/g, " ").replace(/\s+/g, " ").trim();
const _hayCache = new WeakMap();
let _hayEpoca = 0; // sobe quando um robô mexe nas linhas (_saveEnrichedSheet)
function _hayDe(r) {
  let c = _hayCache.get(r);
  if (!c || c.v !== _hayEpoca) {
    c = { v: _hayEpoca,
      h: _normSearch([r.t, r.n, r.c, r.e, r.s, r.ci, r.desc, r.soc, r.socT, r.req].filter(Boolean).join(" ")),
      tn: _normSearch([r.t, r.n].filter(Boolean).join(" ")) };
    _hayCache.set(r, c);
  }
  return c;
}
// 🇧🇷 O público é 100% brasileiro e o acervo é 100% em inglês. Quem digita
// "jardinagem", "camareira" ou "colheita" recebia ZERO e concluía que não há
// vaga. Aqui a consulta INTEIRA (normalizada) vira um OU de termos em inglês
// — nunca a categoria inteira (esse é justamente o erro que este lote corrige).
const BUSCA_PT_EN = {
  jardinagem: ["landscape", "grounds"], paisagismo: ["landscape", "grounds"],
  jardineiro: ["landscaper", "gardener"], jardim: ["garden"], grama: ["lawn"],
  camareira: ["housekeeper", "room attendant"], arrumadeira: ["housekeeper"],
  faxina: ["cleaner", "janitor"], faxineira: ["cleaner", "janitor"], limpeza: ["cleaning", "janitor"],
  zelador: ["janitor"], recepcao: ["front desk"], hotel: ["hotel"], pousada: ["inn", "lodge"],
  cozinheiro: ["cook"], cozinha: ["kitchen"], "auxiliar de cozinha": ["prep cook", "kitchen"],
  garcom: ["waiter", "server"], garconete: ["waitress", "server"],
  "lavador de pratos": ["dishwasher"], padeiro: ["baker"], confeiteiro: ["pastry", "baker"],
  barman: ["bartender"], sorveteria: ["ice cream"],
  construcao: ["construction"], pedreiro: ["mason", "bricklayer"], carpinteiro: ["carpenter"],
  soldador: ["welder"], eletricista: ["electrician"], encanador: ["plumber"], pintor: ["painter"],
  telhadista: ["roofer"], servente: ["laborer"], obra: ["construction"],
  colheita: ["harvest"], fazenda: ["farm"], agricultura: ["agricultur", "farm"],
  lavoura: ["crop", "field"], ordenha: ["dairy", "milker"], gado: ["livestock", "cattle"],
  tratorista: ["tractor"], pomar: ["orchard"], estufa: ["greenhouse"],
  pescado: ["seafood"], peixe: ["fish"], camarao: ["shrimp"], caranguejo: ["crab"], ostra: ["oyster"],
  motorista: ["driver"], caminhoneiro: ["truck driver"],
  "salva vidas": ["lifeguard"], piscina: ["pool"],
  floresta: ["forest"], madeira: ["timber", "logging"], reflorestamento: ["reforestation"],
  esqui: ["ski"], neve: ["snow"], golfe: ["golf"], "parque de diversoes": ["amusement"],
  armazem: ["warehouse"], empacotador: ["packer"], "operador de maquina": ["machine operator", "equipment operator"],
};
// Atalho de IDENTIFICADOR: o campo de busca promete "nº do caso" ao usuário e
// devolvia 6.387 vagas — o hífen virava espaço e "26001" (prefixo do lote do
// DOL) casava com milhares. Nº completo → igualdade; lote → prefixo; 6 dígitos
// puros → o serial final do caso, que é único.
function _buscaIdentificador(list, qRaw) {
  const up = qRaw.toUpperCase().replace(/\s+/g, "");
  if (/^H-\d{3}-\d{5}-\d{6}$/.test(up)) return list.filter(r => String(r.c || "").toUpperCase() === up);
  if (/^H-\d{3}(-\d{1,5})?$/.test(up)) return list.filter(r => String(r.c || "").toUpperCase().startsWith(up));
  if (/^\d{4,8}$/.test(up)) return list.filter(r => String(r.c || "").toUpperCase().endsWith("-" + up));
  return null;
}
// 📅 Data ISO válida da linha (AAAA-MM-DD) ou "" — fonte ÚNICA usada pelas
// ordenações por data (start/desc) e pela régua de temporada. Nunca dentro de
// comparador de sort: o valor é calculado 1x por linha (decorate-sort).
function _dataISO(v){const s=String(v||"").slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:"";}
// v179: só estas ordenações existem. Qualquer outra coisa vinda da URL cai

// no padrão estável — ordenação aleatória por requisição quebra a paginação
// (a mesma vaga aparece 2x e outra nunca aparece).
const SORTS_VALIDOS = new Set(["random", "asc", "desc", "wage", "start", "match"]);
function searchSheet(arr, q, state, category, skip, top, sort, matchCtx) {
  let list = arr;
  let sugestao = null;
  if (q && q.trim()) {
    // ── v62 (bug real, print do dono 26/07: "Marthas vineyard" não achava nada
    // e a tela enchia de vaga sem relação): a busca olha CIDADE e TÍTULO e
    // normaliza acento/apóstrofo ("Marthas" == "Martha's"). Mantido.
    // ── v179 (auditoria 17/09/2026): ACHAR e SUGERIR viraram coisas
    // separadas. A "categoria implícita" era ANEXADA ao resultado: q=welder
    // devolvia 4.002 vagas das quais 13 tinham a palavra (carpenter 4.002/106,
    // bartender 1.210/41, cook 1.215/589) — e esse conjunto é o que vira
    // `total`, faceta e FILA DO ROBÔ (quem filtrou "welder" tinha o automático
    // se realimentando com 4.000 empregadores de construção civil). Agora a
    // categoria só viaja como SUGESTÃO ("também há N vagas em 🏗️ Construção").
    const qRaw = String(q).trim();
    const _ident = _buscaIdentificador(list, qRaw);
    if (_ident) { list = _ident; }
    else {
    const ql=_normSearch(qRaw);
    // 🐛 v224 (achado do dono, teste de robustez do campo "Palavra-chave"):
    // _normSearch tira acento/apóstrofo/pontuação de propósito ("Marthas" ==
    // "Martha's", v62) — mas uma busca que é SÓ pontuação (ex.: um apóstrofo
    // sozinho) normalizava pra STRING VAZIA e cada linha abaixo tratava isso
    // como "buscar por nada", devolvendo `direct=[]` incondicional: "Ver 0
    // vagas" pra quem digitou 1 caractere que existe de verdade em nome de
    // empresa real ("Olson's Greenhouses of Colorado, LLC"). Sem NENHUM
    // caractere de busca sobrando após normalizar, não há o que comparar —
    // a busca é ignorada (mesmo resultado de campo vazio), nunca finge ter
    // encontrado zero.
    if (!ql) { /* nada a comparar — `list` continua o array completo */ }
    else {
    const toks=ql.split(" ").filter(Boolean);
    // 🇧🇷 consulta em português vira OU de termos em inglês (a original continua valendo)
    const alvos=[];
    for(const e of (BUSCA_PT_EN[ql]||[])){const tk=_normSearch(e).split(" ").filter(Boolean);if(tk.length)alvos.push(tk);}
    if(toks.length)alvos.push(toks);
    // Detect implied category from job title keyword (vira SUGESTÃO, não resultado)
    let impliedCat = null;
    if (ql.length >= 3) {
      for(const[title,cat] of Object.entries(JOB_TITLE_TO_CAT)){
        if(ql===title||ql.includes(title)||title.startsWith(ql)){impliedCat=cat;break;}
      }
      if(!impliedCat){
        for(const[cat,kws] of Object.entries(CATEGORY_KEYWORDS)){
          if(kws.some(k=>k.trim().length>=3&&ql.includes(k.trim()))){impliedCat=cat;break;}
        }
      }
    }
    // v111b: a busca é uma REGIÃO conhecida? ("marthas vineyard", "cape cod"…)
    // → vaga em qualquer cidade-membro conta como match direto.
    // ⚠️ v179: a expansão de região casa SÓ contra a CIDADE. Casar contra o
    // texto inteiro fazia "dennis"/"orleans"/"sandwich" (nomes comuns de
    // empresa) puxarem 3.354 vagas numa planilha que não tem cidade nenhuma.
    let _regCities=null;
    for(const[reg,cities] of Object.entries(REGIOES_EUA)){
      if(ql===reg||ql.includes(reg)||(ql.length>=4&&reg.startsWith(ql))){_regCities=cities;break;}
    }
    // (1) Match direto: TODAS as palavras de algum alvo, em qualquer campo
    //     (título, empresa, cidade, DESCRIÇÃO, SOC, requisitos)
    let direct=alvos.length?list.filter(r=>{const h=_hayDe(r).h;return alvos.some(tk=>tk.every(t=>h.includes(t)));}):[];
    if(_regCities){
      const _vis=new Set(direct.map(r=>r.c));
      for(const r of list){ if(_vis.has(r.c))continue; const c=_normSearch(r.ci||""); if(c&&_regCities.some(x=>c.includes(x)))direct.push(r); }
    }
    // Relevância: título/empresa que contém a busca vem primeiro (espírito do
    // antigo tier1), o resto mantém a ordem estável (paginação correta).
    if(direct.length>1){
      const tHit=r=>{const tn=_hayDe(r).tn;return alvos.some(tk=>tk.every(t=>tn.includes(t)));};
      direct=[...direct.filter(tHit),...direct.filter(r=>!tHit(r))];
    }
    // (2) Match parcial multi-palavra COMPLEMENTA depois: palavra ≥4 letras
    //     ("marthas vineyard" lista também "Vineyard Haven"/"Edgartown").
    //     ⚠️ v179: o token precisa ter LETRA (nunca pedaço de nº de caso), só
    //     casa em TÍTULO ou EMPRESA (era por aí que "26001" virava 6.387) e
    //     casa no COMEÇO de uma palavra — "cape" (de "cape cod") casava dentro
    //     de "landSCAPE" e devolvia 3.354 vagas de paisagismo numa planilha
    //     que não tem cidade nenhuma.
    let partial=[];
    if(toks.length>1){
      const big=toks.filter(t=>t.length>=4&&/[a-z]/.test(t))
        .map(t=>new RegExp("(?:^| )"+t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
      if(big.length){
        const seenD=new Set(direct.map(r=>r.c));
        partial=list.filter(r=>{if(seenD.has(r.c))return false;const tn=_hayDe(r).tn;return big.some(re=>re.test(tn));});
      }
    }
    list=[...direct,...partial];
    // (3) Categoria implícita vira SUGESTÃO — quem decide incluir é o usuário
    if(impliedCat && (!category||category==="all")){
      const seen=new Set(list.map(r=>r.c));
      let n=0; for(const r of arr) if((r.k||"other")===impliedCat && !seen.has(r.c)) n++;
      if(n>0) sugestao={categoria:impliedCat,label:(CATEGORY_LABELS[impliedCat]?.label||impliedCat),n};
    }
    }
    }
  }
  if (state)    list=list.filter(r=>(r.s||"").toUpperCase()===state.toUpperCase());
  if (category && category!=="all") {
    const cats=category.split(",").map(c=>c.trim()).filter(Boolean);
    if(cats.length===1) list=list.filter(r=>(r.k||"other")===cats[0]);
    else list=list.filter(r=>cats.includes(r.k||"other"));
  }
  // Ordenação: asc/desc preserva paginação visual; shuffle (default) garante aleatoriedade
  // para evitar que vários usuários enviem para as mesmas empresas simultaneamente.
  // NOTA: o shuffle real acontece no /api/auto/start após coletar todas as vagas.
  // Na busca paginada usamos ordem estável para garantir que skip/top
  // retornem registros corretos sem duplicatas ou lacunas entre páginas.
  // 🗓️ v181 LOTE 5 — "Recentes" era literalmente a planilha AO CONTRÁRIO
  // (`list.reverse()`): ordem de arquivo, sem nenhuma relação com data. Virou
  // ordenação REAL por data de início, da mais recente pra mais antiga
  // (decorate-sort-undecorate, lição do v162 — nunca parse dentro do
  // comparador). Vaga sem data vai pro fim, mantendo a ordem estável (a
  // paginação por skip/top continua correta). Em planilha SEM data nenhuma
  // (jan2026/jul2025) a ordenação não muda nada — e a tela não oferece mais o
  // botão nesse caso (disponibilidade.inicio === 0).
  if (sort==="desc") {
    list=list.map((r,i)=>({r,i,d:_dataISO(r.d)}))
      .sort((a,b)=>(a.d?0:1)-(b.d?0:1)||(a.d&&b.d?b.d.localeCompare(a.d):0)||a.i-b.i)
      .map(x=>x.r);
  }
  // ── V953: ordenações determinísticas novas (estáveis p/ paginação) ──

  // wage  → maior salário primeiro, NORMALIZADO por unidade: dados reais têm
  //         'h' (16k), 'mo' (184) e vazio. Mensal ÷173h e semanal ÷40h viram
  //         equivalente/hora — senão $4.938/mês "ganha" de $30/h no sort.
  // start → começa antes primeiro (r.d ISO; sem data vai pro fim)
  else if (sort==="wage") {
    // v173: régua ÚNICA de $/hora (FILTROS.wageHora — a mesma do filtro de
    // salário) + decorate-sort-undecorate (lição do v162: nunca regex dentro
    // do comparador).
    list=list.map(r=>({r,w:FILTROS.wageHora(r)})).sort((a,b)=>b.w-a.w).map(x=>x.r);
  }
  // 🗓️ v181 LOTE 5 — "Começa logo" entregava "começou há mais tempo": a
  // ordenação era crescente CRUA por r.d, então na H-2A (4.959 das 4.964 já
  // começaram) as primeiras da lista eram de janeiro/fevereiro — contrato que
  // começou há 8 meses. Agora são 3 FAIXAS: (0) ainda vai começar, da mais
  // próxima pra mais distante; (1) já começou, da mais recente pra mais
  // antiga; (2) sem data publicada, no fim, na ordem estável de sempre.
  else if (sort==="start") {
    const _hj=new Date().toISOString().slice(0,10);
    list=list.map((r,i)=>{const d=_dataISO(r.d);return{r,i,d,f:d?(d>=_hj?0:1):2};})
      .sort((a,b)=>a.f-b.f||(a.f===0?a.d.localeCompare(b.d):a.f===1?b.d.localeCompare(a.d):0)||a.i-b.i)
      .map(x=>x.r);
  }

  // 🎯 match → vaga com melhor encaixe no perfil do candidato primeiro
  // (v82). Só ativa se o chamador passou um contexto — sem perfil,
  // cai no comportamento estável de sempre (nunca quebra quem não logou).
  // 🐢 v162 (dono, 24/08: "site está completamente lento, não é internet"):
  // achado revisando o motor de busca — o comparador chamava
  // computeJobMatchScore() DENTRO do sort, recalculando a pontuação (regex
  // sobre o texto da vaga) 2x por comparação. Array.sort é O(n log n)
  // comparações, então virava ~2n·log(n) chamadas da função — com as
  // planilhas reais (9.240 + 2.206 + 4.831 + 2.625 vagas), uma busca só com
  // "🎯 Melhor pra mim" recalculava a pontuação DEZENAS DE MILHARES de vezes,
  // travando o processo (single-thread) inteiro por um tempo real — e isso
  // trava o site pra TODOS os usuários conectados na hora, não só quem
  // buscou. Corrigido com o mesmo padrão "decorate-sort-undecorate" que o
  // orderQueueSmart (fila automática) já usava certo: calcula a pontuação
  // UMA VEZ por item, guarda junto, ordena pelo valor guardado. O(n) scores
  // em vez de O(n log n) — de dezenas de milhares de chamadas pra só n.
  else if (sort==="match" && matchCtx) {
    list=list.map(r=>({r,sc:computeJobMatchScore(_matchSignalFromRow(r),matchCtx)?.score||0}))
      .sort((a,b)=>b.sc-a.sc).map(x=>x.r);
  }
  // sort="asc", "random", "" → ordem estável para paginação correta
  return { total:list.length, items:list.slice(skip,skip+top), sugestao };
}

// ══════════════════════════════════════════════════════════
//  ENVIO AUTOMÁTICO — STREAMING INTELIGENTE
//  Inicia imediatamente sem esperar carregar tudo
// ══════════════════════════════════════════════════════════
const autoTimers = new Map();
const autoStats  = new Map(); // { email → { sent, failed, skipped, startedAt } }

// isAutoHour REMOVIDA: automático não tem mais janela de horário

function getAutoStats(email) {
  return autoStats.get(email) || { sent:0, failed:0, skipped:0, startedAt:null };
}
function updateAutoStats(email, delta) {
  const s = getAutoStats(email);
  autoStats.set(email, { ...s, ...delta });
}

function scheduleAuto(email) {
  if(autoTimers.has(email))clearTimeout(autoTimers.get(email));
  const job=getAutoJob(email);
  if(!job||!job.active){autoTimers.delete(email);return;}
  // Fila zerada: v23 — tenta refill automático antes de finalizar
  if(!job.queue?.length){
    // 🚨 v177-FIX5 (auditoria 14/09/2026): o refill rodava ANTES da checagem
    // de plano logo abaixo — e ele marca o job como active:true. Quem perdia
    // o automático exatamente quando a fila zerava ganhava uma fila nova
    // (vagas "reservadas" pra ele) e um job ligado por ~5s, só pro tick
    // seguinte descobrir que não tem plano. Só recarrega quem ainda tem
    // automático ativo de verdade; o resto cai no encerramento normal.
    const _pRefill=getUser(email)||{};
    const _added=(isAdminVip(_pRefill)||isAutoVipActive(_pRefill))?tryAutoRefill(email,job):0;
    if(_added>0){
      addLog(email,{status:"sistema",jobTitle:`🔄 Fila recarregada sozinha: +${_added} vaga(s) nova(s)`,company:"O robô continua trabalhando com os mesmos filtros — nada pra você fazer."});
      autoTimers.set(email,setTimeout(()=>scheduleAuto(email),5000));
      return;
    }
    setAutoJob(email,{...job,active:false,queue:[],finishedAt:Date.now(),status:"finished"});
    autoTimers.delete(email);
    addLog(email,{status:"sistema",jobTitle:"✅ Fila finalizada",company:`Total: ${job.originalCount||0} vagas processadas.`});
    console.log(`[auto] ${email} fila zerada no scheduleAuto — marcado como finished`);
    // v18-FIX: push como fallback — canal separado do kill-switch de e-mail do dono
    return;
  }

  // ── Sem janela de horário: roda 24/7 até zerar a fila ────────────────────
  // Ao atingir o limite diário, aguarda a meia-noite BRT (00:00 = 03:00 UTC)
  // e retoma imediatamente — sem parar por horário, nunca.

  function nextMidnightBRT() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3,0,1,0); // 00:00 BRT = 03:01 UTC (1s após meia-noite)
    if (next <= now) next.setUTCDate(next.getUTCDate()+1);
    return next;
  }

  const p=getUser(email)||{};

  // ── Conta deletada pelo próprio usuário: nunca mandar e-mail em nome dela ──
  // Defesa extra (o timer já é limpo no momento do delete, mas um setTimeout
  // pode estar em voo numa corrida rara — esta checagem garante que nada sai).
  if(p.accountDeleted){
    setAutoJob(email,{...job,active:false,status:"paused_account_deleted",finishedAt:Date.now()});
    autoTimers.delete(email);
    return;
  }

  // 🔒 v172h (ordem do dono, 12/09/2026 — "se a pessoa não pagou mais o
  // plano... tem que ser bloqueado o envio automático e o manual... diz pra
  // ela que o plano dela venceu dia tal"): scheduleAuto nunca distinguia
  // "o plano de verdade venceu" de "bateu o teto de HOJE num plano ainda
  // válido" — pra quem perdia o automático (free, ou VIPro/DoublePro
  // vencido), getAutoLimit virava 0 e `todayAuto(0)>=autoLimit(0)` caía
  // SEMPRE no ramo de baixo, reagendando pra meia-noite PRA SEMPRE com
  // "Limite diário atingido: 0/0 envios hoje" — nunca avisava a pessoa que
  // o plano venceu, nunca parava o robô de verdade (comentário antigo daqui
  // — "10 automáticos grátis pra todos" — já nem era mais real desde que o
  // plano free virou 0/0; ficou stale). Corrigido: sem automático ativo de
  // verdade (nem admin) o job PARA — `paused_no_vip`, o MESMO status que
  // /api/admin/revoke-trial já usa (toast dedicado já existe no front) —
  // citando a data real de vencimento, sem reagendar timer nenhum.
  if(!isAdminVip(p) && !isAutoVipActive(p)){
    setAutoJob(email,{...job,active:false,status:"paused_no_vip",finishedAt:Date.now()});
    autoTimers.delete(email);
    addLog(email,{status:"sistema",jobTitle:"⛔ Envio automático pausado",company:planGateMsg(p,"Assine um plano na aba Planos pra continuar enviando automaticamente.","auto")});
    console.log(`[auto] ${email} sem VIP automático ativo (${planGateMsg(p,"plano nunca ativo","auto")}) — robô PARADO (paused_no_vip), sem reagendar`);
    return;
  }

  // Limite: usa o atual do plano (não o lockedAutoLimit) para que expiração surta efeito
  const autoLimit = getAutoLimit(p);
  const todayAuto=countAutoToday(getHist(email));

  // 🎯 ordem do dono, 12/09/2026: admin TAMBÉM pausa ao bater o teto —
  // getAutoLimit(p) já soma 450/dia por sender conectado (perSenderAutoLimit),
  // então o teto agora é REAL (antes 9999 nunca pausava nada de propósito).
  if(todayAuto>=autoLimit){
    const next = nextMidnightBRT();
    const delay = Math.max(60_000, Math.min(next - Date.now(), 24*60*60*1000)); // entre 1min e 24h
    setAutoJob(email,{...job,status:"waiting_limit",nextSendAt:next.getTime()});
    autoTimers.set(email,setTimeout(()=>scheduleAuto(email),delay));
    const retomaBRT = next.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit"});
    addLog(email,{status:"limite",jobTitle:`📊 Limite diário atingido: ${todayAuto}/${autoLimit} envios hoje`,company:`Retoma automaticamente às 00:00 BRT (${Math.round(delay/60000)}min). Fila: ${job.queue?.length||0} vagas restantes.`,error:""});
    console.log(`[auto] ${email} limite diário (${todayAuto}/${autoLimit}) — aguarda meia-noite BRT (${Math.round(delay/60000)}min)`);
    return;
  }

  doAutoSend(email);
}

// ⏫ v125 (BUG REAL, print do dono 12/08: cliente ativou VIPro às 09:58 e o
// robô ficou "Limite diário atingido 10/100 — retoma em 14h"): quando o
// usuário bateu o limite do plano ANTIGO e DEPOIS ativou/melhorou o plano,
// o timer de "espera a meia-noite" não ficava sabendo do upgrade — pagante
// esperando por um limite que não existe mais. Toda ativação de plano
// (compra direta aprovada, set-plan do admin, código) chama isto: se o robô está
// dormindo por limite (waiting_limit — e SÓ nesse estado, nunca mexe no
// ritmo de 7min de quem está enviando), acorda AGORA; o scheduleAuto
// recalcula o limite do zero e, se ainda estiver estourado (ex.: renovou o
// mesmo plano), simplesmente re-agenda a meia-noite — idempotente.
function acordarRoboAposPlano(email){
  try{
    const j=getAutoJob(email);
    if(!j||!j.active||j.status!=="waiting_limit")return;
    if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
    addLog(email,{status:"sistema",jobTitle:"⏫ Plano ativado — robô acordou na hora",company:"O limite novo já vale agora; o robô voltou a trabalhar sem esperar a meia-noite."});
    console.log(`[auto] ⏫ ${email}: acordado após ativação de plano (estava waiting_limit)`);
    scheduleAuto(email);
  }catch(e){console.warn("[auto] acordarRoboAposPlano:",e.message);}
}

// ── Tipo de visto da vaga: 'h2a' | 'h2b' | null ─────────────────────────────
// v19 (dono, 15/07/2026): a vaga manda no perfil. H-2A → perfil H-2A;
// H-2B → perfil H-2B. Detecta pelo campo visa da vaga, senão pela planilha.
function jobVisaType(target, sheet){
  const v=String(target?.visa||target?.visaType||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(v.includes("H2A"))return "h2a";
  if(v.includes("H2B"))return "h2b";
  const sh=String(sheet||"").toLowerCase();
  if(sh.includes("h2a"))return "h2a";
  if(sh&&sh!=="manual"&&sh!=="seasonal")return "h2b"; // planilhas restantes são H-2B
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 🎯 MATCH DE VAGA (dono, 29/07/2026: "IA sugerindo as vagas com mais chance
// pra cada um" — prioridade #1 da casa é brasileiro conseguir emprego).
// Pontua 0-100 o encaixe de UMA vaga com o perfil do candidato — heurística
// local, instantânea, sem chamada de IA externa (dá pra rodar em toda busca
// e em toda fila automática sem custo). Sempre devolve o "porquê" (nunca
// caixa preta). Duas fontes de vaga (linha crua da planilha `r.*` e o objeto
// já mapeado `{category,state,...}` usado na fila) convergem pro MESMO
// formato de sinal antes de pontuar — uma função de pontuação só, nunca
// duplicada por formato de vaga.
// ══════════════════════════════════════════════════════════════════════════
function _matchSignalFromRow(r){return{category:r.k||"other",state:r.s||"",workers:r.wk||0,text:`${r.desc||""} ${r.req||""}`,visa:r.visa||""};}
function _matchSignalFromJob(j){return{category:j.category||"other",state:j.state||"",workers:j.workers||0,text:`${j.desc||""} ${j.req||""}`,visa:j.visa||""};}
function computeJobMatchScore(sig,ctx){
  if(!ctx)return null;
  const vt=jobVisaType({visa:sig.visa})||"h2b";
  const profile=ctx.profileByVisa?ctx.profileByVisa[vt]:null;
  const h2bProfile=ctx.h2bProfile;
  let score=50;const why=[];
  if(h2bProfile?.preferredArea&&sig.category&&h2bProfile.preferredArea===sig.category){score+=20;why.push("categoria que você prefere");}
  if(profile){
    if(Array.isArray(profile.categories)&&profile.categories.length&&profile.categories.includes(sig.category)){score+=15;why.push("dentro do que seu perfil mira");}
    if(profile.state&&sig.state&&profile.state===sig.state){score+=15;why.push("estado do seu perfil");}
  }
  const txt=(sig.text||"").toLowerCase().trim();
  if(txt){
    const pedeExperiencia=/experience required|experienced worker|prior experience|returning worker/.test(txt);
    const aceitaIniciante=/no experience|entry.?level|will train|on.the.job training/.test(txt);
    const temExperiencia=!!(h2bProfile?.experiencedH2B||(h2bProfile?.h2bSeasons||0)>0);
    if(temExperiencia&&pedeExperiencia){score+=10;why.push("pede experiência e você já tem");}
    if(!temExperiencia&&aceitaIniciante){score+=10;why.push("aceita quem está começando");}
    if(!temExperiencia&&pedeExperiencia){score-=10;why.push("pede experiência que você ainda não tem");}
    const pedeIngles=/fluent english|advanced english|strong english|excellent english/.test(txt);
    const inglesOpcional=/english not required|no english required|english is not necessary/.test(txt);
    const nivel=h2bProfile?.englishLevel||"basic";
    if((nivel==="none"||nivel==="basic")&&inglesOpcional){score+=8;why.push("não exige inglês avançado");}
    if((nivel==="none"||nivel==="basic")&&pedeIngles){score-=12;why.push("pede inglês avançado");}
    if(nivel==="advanced"&&pedeIngles){score+=5;why.push("seu inglês avançado é diferencial aqui");}
  }
  if((sig.workers||0)>=10)score+=5;
  return{score:Math.max(0,Math.min(100,Math.round(score))),why};
}
// Monta o contexto de match (h2bProfile + 1 perfil por tipo de visto) a
// partir do usuário logado — usado na busca manual E na fila automática,
// nunca duas verdades separadas sobre "qual perfil vale pra essa vaga".
function buildMatchCtx(u){
  if(!u)return null;
  const profiles=(u.profiles||[]).filter(pr=>pr.active!==false);
  const profileByVisa={};
  for(const pr of profiles){const vt=pr.visaType||"h2b";if(!profileByVisa[vt])profileByVisa[vt]=pr;}
  return{h2bProfile:u.h2bProfile||null,profileByVisa};
}

// ── Seleção de perfil — v19: PERFIL POR TIPO DE VISTO (dono, 15/07/2026) ────
// Cada usuário pode ter até 2 perfis: 1 H-2B e 1 H-2A (cliente real reclamou:
// tinha perfis separados, a consolidação juntou tudo e o texto de H-2B saiu
// pra vaga de H-2A). Prioridade:
//   1. perfil ATIVO do MESMO tipo de visto da vaga — regra absoluta do dono:
//      "a vaga é de h2a tem que ir o perfil de h2a"
//   2. perfil escolhido explicitamente no wizard (job.profileId)
//   3. (avançado) perfil que declarou a categoria da vaga
//   4. perfil normal/geral (favorito 1º)
//   5. qualquer perfil ativo
// Se o usuário NÃO tem perfil do tipo da vaga (ele escolhe se cria ou não),
// cai nos passos seguintes — envia com o que existe, nunca trava o envio.
function selectProfile(profiles, target, sheet, preferredId) {
  if (!profiles || !profiles.length) return null;
  const active = profiles.filter(pr => pr.active !== false);
  if (!active.length) return null;
  // No automático só entram perfis com allowAuto ligado; se ninguém tiver, usa todos os ativos
  const autoOk = active.filter(pr => pr.allowAuto !== false);
  const pool = autoOk.length ? autoOk : active;

  // 1. Tipo de visto da vaga — vence tudo quando existe perfil correspondente
  const vt = jobVisaType(target, sheet);
  if (vt) {
    const byVisa = pool.find(pr => (pr.visaType||"h2b") === vt) || active.find(pr => (pr.visaType||"h2b") === vt);
    if (byVisa) return byVisa;
  }

  // 2. Escolha explícita do usuário (wizard do automático)
  if (preferredId) {
    const chosen = pool.find(pr => pr.id === preferredId) || active.find(pr => pr.id === preferredId);
    if (chosen) return chosen;
  }

  const jobCat = (target.category || "other").toLowerCase();

  // 3. (Avançado, opcional) perfil que declarou a categoria da vaga
  const byCat = pool.filter(pr => Array.isArray(pr.categories) && pr.categories.length && pr.categories.includes(jobCat));
  if (byCat.length) return byCat.find(pr => pr.isFavorite) || byCat[0];

  // 4. Perfil normal — sem categorias (compat: isGeneral legado conta como normal)
  const normal = pool.filter(pr => pr.isGeneral || !(pr.categories || []).length);
  if (normal.length) return normal.find(pr => pr.isFavorite) || normal[0];

  // 5. Fallback
  return pool[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// 🧠 v23 — INTELIGÊNCIA DO ROBÔ (pedido do dono: "programa agindo certo,
// pensando certo"). 4 peças: fila esperta, vaga morta, refill automático.
// ═══════════════════════════════════════════════════════════════════════════

// Quantos e-mails o APP INTEIRO já mandou pra cada empregador (cache 30min).
// Usado pra ordenar a fila: empregador MENOS contatado primeiro — mais chance
// de resposta pro usuário e menos risco de spam coletivo nos populares.
let _globalContactCache={map:null,ts:0};
function getGlobalContactCounts(){
  if(_globalContactCache.map&&Date.now()-_globalContactCache.ts<30*60_000)return _globalContactCache.map;
  const m=new Map();
  try{
    for(const h of Object.values(DB_HIST)){
      for(const x of (h||[])){
        if(x.type==="reply")continue;
        const t=String(x.to||"").toLowerCase();
        if(t)m.set(t,(m.get(t)||0)+1);
      }
    }
  }catch(e){console.warn("[fila-esperta] contagem falhou:",e.message);}
  _globalContactCache={map:m,ts:Date.now()};
  return m;
}
// Ordena a fila em faixas de "quanto o app já contatou esse empregador"
// (0 → 1-2 → 3-5 → 6-15 → 16+), embaralhando DENTRO de cada faixa — mantém
// a proteção original (usuários simultâneos não batem nos mesmos alvos) e
// ainda prioriza os empregadores mais frescos.
// v82: com matchCtx, DENTRO de cada faixa as vagas com melhor encaixe no
// perfil do candidato flutuam pra cima (jitter aleatório de ±10 pontos
// preserva a proteção original — usuários com perfil parecido não convergem
// todos pro EXATO mesmo empregador no topo da fila).
function orderQueueSmart(queue,matchCtx){
  try{
    const counts=getGlobalContactCounts();
    const buckets=new Map();
    for(const it of queue){
      const c=counts.get(String(it.to||"").toLowerCase())||0;
      const b=c===0?0:c<=2?1:c<=5?2:c<=15?3:4;
      if(!buckets.has(b))buckets.set(b,[]);
      buckets.get(b).push(it);
    }
    const out=[];
    for(const b of [...buckets.keys()].sort((x,y)=>x-y)){
      const arr=buckets.get(b);
      if(matchCtx){
        out.push(...arr
          .map(it=>({it,key:(computeJobMatchScore(_matchSignalFromJob(it),matchCtx)?.score||50)+(Math.random()*20-10)}))
          .sort((x,y)=>y.key-x.key)
          .map(x=>x.it));
      } else {
        out.push(...shuffleArray(arr));
      }
    }
    return out;
  }catch(e){console.warn("[fila-esperta] falhou — usando shuffle:",e.message);return shuffleArray(queue);}
}

// A fila envelhece (dias/semanas no automático). Antes de gastar 1 envio do
// limite diário do usuário, confere se a vaga ainda está VIVA na planilha
// atual. Devolve o motivo (string) se morreu, null se está ok/desconhecida.
// Motivo de a LINHA estar morta (status do DOL ou temporada encerrada), ou
// null. Fonte ÚNICA — usada pela checagem antes de cada envio do robô
// (isQueueJobDead) E pelo REFILL da fila (tryAutoRefill): duas réguas
// diferentes pro mesmo "essa vaga ainda existe?" era como a vaga encerrada
// voltava pra fila pelo refill logo depois de ser pulada no envio.
function _motivoVagaMorta(row){
  if(!row)return null;
  const st=String(row.st||"").toUpperCase();
  if(st.includes("WITHDRAWN"))return "vaga RETIRADA pelo empregador";
  if(st.includes("DENIED"))return "vaga NEGADA pelo DOL";
  if(st.includes("EXPIRED")||st.includes("INVALIDATED"))return "vaga EXPIRADA";
  // ⚠️ v179: `row.exp` é MESES DE EXPERIÊNCIA EXIGIDA (0,1,2,3,…,60), NUNCA
  // "expirada" — mas a condição acima tinha `row.exp===1` e pulava o envio
  // com a mensagem falsa "vaga EXPIRADA". São 447 vagas boas em jan2026 e
  // 149 em jul2025 descartadas hoje, e o robô de enriquecimento grava
  // exp=1 pra toda vaga que exige experiência: quanto mais ele roda, mais
  // vaga boa era jogada fora. A temporada encerrada (data de FIM no
  // passado) é o sinal honesto que faltava.
  const de=_dataISO(row.de);
  if(de&&de<new Date().toISOString().slice(0,10))return "temporada ENCERRADA (a vaga terminou em "+de.split("-").reverse().join("/")+")";
  return null;
}
function isQueueJobDead(source,caseNum){
  try{
    if(!caseNum)return null;
    const rows=getSheet(source||"");
    if(!rows||!rows.length)return null;
    const cn=String(caseNum).toUpperCase();
    const row=rows.find(r=>String(r.c||"").toUpperCase()===cn);
    if(!row)return null; // sumiu da planilha — não dá pra afirmar que morreu
    return _motivoVagaMorta(row);
  }catch{return null;}
}


// 🔄 REFILL AUTOMÁTICO: quando a fila zera, o robô se realimenta SOZINHO com
// os MESMOS filtros que o usuário escolheu no início (job.filters), cortando
// tudo que já foi enviado — em vez de parar e esperar o usuário voltar.
// Devolve quantas vagas novas entraram (0 = nada novo → finaliza como antes).
function tryAutoRefill(email,job){
  try{
    if(!job||(job.refills||0)>=50)return 0; // trava de segurança absoluta
    const rows=getSheet(job.source||"");
    if(!rows||!rows.length)return 0; // fonte não é planilha (fila manual) — sem refill
    // v173: os MESMOS filtros do início, pelo MESMO motor da lista e da
    // contagem (FILTROS) — job.filters no formato novo OU legado (robô que
    // já rodava antes do deploy). O robô só manda pra quem tem e-mail.
    const u2=getUser(email)||{};
    const f=FILTROS.parse(job.filters||{});
    f.email=true;
    const cap=Math.min(2000,parseInt(job.filters?.limit)||job.originalCount||500);
    let base=FILTROS.filtrar(rows,f,{except:["q"],excluir:_excluirEnviadosFn(email,{comProprios:true,comInvalidos:true}),isDP:_isDoublePro(u2)});
    if(f.q)base=searchSheet(base,f.q,"","",0,base.length,"").items;
    const fresh=[];
    for(const r of base){
      const em=String(r.e||"").toLowerCase().trim();
      // v181: MESMA régua do envio (isQueueJobDead) — status morto do DOL E
      // temporada encerrada. O refill devolvia pra fila exatamente a vaga que
      // o envio acabara de pular por ter terminado.
      if(_motivoVagaMorta(r))continue;

      fresh.push({
        id:r.c,to:em,title:r.t||"Seasonal Worker",company:r.n||"",category:r.k||"other",
        state:r.s||"",city:r.ci||"",wage:r.w?`$${r.w}/${r.wunit||"h"}`:"",visa:r.visa||"",
        start:r.d||"",end:r.de||"",workers:r.wk||null,desc:"",caseNum:r.c,
        url:r.c&&String(r.c).startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${r.c}`:"",
        sheetOrigin:job.source
      });
      if(fresh.length>=cap)break;
    }
    if(!fresh.length)return 0;
    const ordered=orderQueueSmart(fresh,buildMatchCtx(u2));
    setAutoJob(email,{...job,queue:ordered,originalCount:(job.originalCount||0)+ordered.length,
      filteredCount:ordered.length,refills:(job.refills||0)+1,lastRefillAt:Date.now(),
      status:"refilled",active:true,finishedAt:null});
    console.log(`[auto-refill] 🔄 ${email}: fila recarregada sozinha com ${ordered.length} vaga(s) nova(s) (refill #${(job.refills||0)+1})`);
    return ordered.length;
  }catch(e){console.warn(`[auto-refill] falhou p/ ${email}:`,e.message);return 0;}
}

// ── Rotação de assunto sem repetição consecutiva ──────────
// rotState: { lastSubjIdx, lastBodyIdx } — guardado no job
function rotateItem(items, lastIdx) {
  if (!items || !items.length) return { value: null, idx: -1 };
  if (items.length === 1) return { value: items[0], idx: 0 };
  // Exclui o último usado para evitar repetição consecutiva
  let candidates = items.map((v, i) => ({ v, i })).filter(x => x.i !== lastIdx);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { value: pick.v, idx: pick.i };
}

// Controle simples de concorrência: impede dois doAutoSend simultâneos para o mesmo email
const autoSendLock = new Set();

// ── PERFORMANCE: cache de stats do usuário (evita recomputar em todo /api/status) ──
const _userStatsCache = new Map(); // email → { todayManual, todayAuto, ts }
const USER_STATS_TTL  = 30_000; // 30s

function getUserStatsCached(email) {
  const cached = _userStatsCache.get(email);
  if (cached && Date.now() - cached.ts < USER_STATS_TTL) return cached;
  const h = getHist(email);
  const todayManual = countManualToday(h);
  const todayAuto   = countAutoToday(h);
  const result = { todayManual, todayAuto, ts: Date.now() };
  _userStatsCache.set(email, result);
  return result;
}

function invalidateUserStatsCache(email) {
  _userStatsCache.delete(email);
}

// ── PERFORMANCE: deduplicação de envio manual por destinatário ──
// Impede envio duplicado por duplo-clique / refresh
const _manualSendInFlight = new Map(); // email+to → promessa em andamento

// 🚨 v177-FIX5 (auditoria 14/09/2026): /api/auto/start não tinha NENHUM lock
// equivalente ao _manualSendInFlight. A checagem de "job já ativo" é síncrona,
// mas o `setAutoJob` final só acontece depois de vários awaits (readBody +
// montagem da fila) — duas chamadas concorrentes (duplo clique, 2 abas, 4G
// lento) passavam as DUAS pela checagem, a 2ª sobrescrevia a fila da 1ª e
// scheduleAuto era agendado 2×. Mesma solução do manual: reserva por usuário,
// liberada no finally (e por idade, caso alguma exceção escape do caminho).
const _autoStartInFlight = new Map(); // email → ts da reserva

// v18-FIX: reserva de vagas do limite diário MANUAL — corrige corrida TOCTOU.
// Antes, o limite diário era checado lendo o histórico (countManualToday) ANTES
// do await pro Gmail (que pode levar vários segundos, o próprio código já loga
// quando passa de 5s). Duas requisições concorrentes pro MESMO usuário — abas
// diferentes, duplo device, ou só cliques rápidos em vagas diferentes — liam a
// MESMA contagem "antiga" e as DUAS passavam no limite, permitindo estourar bem
// além do limite do plano numa janela curta (hipótese confirmada como causa mais
// provável do relato "180 envios em 3h" registrado no diagnóstico acima).
// Este contador reserva a vaga SINCRONAMENTE (antes de qualquer await) assim que
// a checagem passa, e só libera quando o envio termina (sucesso ou erro) — a
// segunda requisição concorrente já vê a reserva e é bloqueada corretamente.
// v18-FIX: trava de idempotência pro crédito manual de VIP no painel admin
// (/api/admin/vip/activate) — impede duplo-clique/retry somando dias 2x.
const _adminVipActivateLock = new Map(); // "adminEmail|targetEmail" → timestamp

const _manualSendReserved = new Map(); // email → nº de envios reservados (em voo)
function _reserveManualSlot(email){ _manualSendReserved.set(email,(_manualSendReserved.get(email)||0)+1); }
function _releaseManualSlot(email){ const n=(_manualSendReserved.get(email)||0)-1; if(n<=0)_manualSendReserved.delete(email); else _manualSendReserved.set(email,n); }

// 🚨 v237n (achado de auditoria — Média, gmail-envio): o teto de aquecimento
// (13a) do envio manual com SENDER ESPECÍFICO (getSenderToken, mais abaixo)
// checava getHist() sem reservar nada — check-then-act clássico. Diferente
// do limite diário total (_manualSendReserved acima, corrigido desde o
// v18-FIX), 2 requisições concorrentes pro MESMO sender em aquecimento liam
// a MESMA contagem "antiga" e as DUAS passavam, furando o teto por alguns
// e-mails numa rajada. `_makeWarmupReleaser` devolve uma função DE UM TIRO
// SÓ (idempotente — 2ª chamada não faz nada): o chamador em /api/send libera
// explicitamente assim que o envio de verdade termina (sucesso OU falha,
// bloco finally), e o setTimeout é só rede de segurança (30s) pro raro
// caminho que nunca chega no finally. Sem o release EXPLÍCITO, um envio que
// termina rápido (o normal) ficaria contado 2x — no hist real E na reserva —
// até o timer de 30s, furando o teto pra MENOS da metade do valor real
// (bug encontrado testando: 16 envios concorrentes com cap=15 só deixava
// 8 passarem, não 15, com só o timer sem release explícito).
const _warmupReserved = new Map(); // "dono|sender" → nº de envios reservados (em voo) nesse sender hoje
// 🎬 v237x: tokens do link mágico de entrada na conta de teste (token →
// {email,expires,used}). PRECISA viver aqui, fora do handler por
// requisição (bug real corrigido antes do commit: declarado dentro do
// `http.createServer` ele recriava um Map VAZIO a cada requisição — o
// token gerado em /entrar-conta-teste sumia antes de /entrar-teste
// conseguir lê-lo, e o link nunca funcionava de verdade).
const _loginTesteTokens = new Map();
function _makeWarmupReleaser(key){
  let done=false;
  return ()=>{ if(done)return; done=true; const n=(_warmupReserved.get(key)||0)-1; if(n<=0)_warmupReserved.delete(key); else _warmupReserved.set(key,n); };
}

// ⚡ v190 LOTE 8: cache de 60s do /api/public-stats (rota pública que varre o
// histórico inteiro e que a landing chama a cada 30s em toda aba aberta).
let _publicStatsCache = null;

// 🌉 v238 (dono, 20/09/2026 — "quero que puxe a informação pra landing
// mostrar quantos usuários já teve cadastrado... amanhã a mesma coisa, ele
// vai puxar automaticamente"): h2bapply.onrender.com é o site ANTIGO
// (New-repository) — h2bapply.com migrou o DNS pra ESTE ambiente, mas o
// antigo continua no ar só pra assinantes de antes terminarem os dias de
// VIP que já pagaram (banner "ambiente velho" na landing). Ele JÁ expõe
// /api/public-stats publicamente, e essa rota (auditada agora) só devolve
// NÚMEROS agregados — nunca e-mail, nome ou qualquer dado de usuário —
// ordem EXPRESSA do dono: "nenhuma das informações dos usuários é para vir
// pra lá, apenas o número de quantidade e pronto". `?local=1` evita
// qualquer recursão com os servidores-irmãos dele (mortos/ocultos, v156/
// v157 de lá). Por isso este lado só CONSOME — nunca escreve nada no
// New-repository, que continua congelado. Cache de 30min (o Render free do
// site antigo hiberna — bater a cada 30s como a landing faz seria acordar
// ele à toa por um número que não muda tão rápido) + fail-open total: site
// antigo fora do ar/hibernando/sem rede nunca derruba nem atrasa a landing
// daqui, só some a parcela dele da soma (ou usa o último valor bom).
let _statsLegadoCache = null;
async function _fetchStatsLegado(){
  if(process.env.TEST_LOGIN_TOKEN)return null; // nunca bate rede de verdade no npm test
  const agora=Date.now();
  if(_statsLegadoCache && agora-_statsLegadoCache.em < 30*60_000)return _statsLegadoCache.dados;
  try{
    const r=await httpsReq({hostname:"h2bapply.onrender.com",path:"/api/public-stats?local=1",method:"GET",headers:{"User-Agent":"H2BApply-stats-bridge/1"}});
    const b=r&&r.body;
    if(r&&r.status===200&&b&&typeof b.totalUsers==="number"){
      const dados={totalUsers:parseInt(b.totalUsers)||0,vipUsers:parseInt(b.vipUsers)||0,totalSent:parseInt(b.totalSent)||0,totalAuto:parseInt(b.totalAuto)||0};
      _statsLegadoCache={em:agora,dados};
      return dados;
    }
  }catch(e){/* fail-open: site antigo fora do ar, hibernando ou sem rede */}
  return _statsLegadoCache?_statsLegadoCache.dados:null; // último valor bom conhecido, senão nada
}

// ── PERFORMANCE: debounce de persist para evitar escrita excessiva no disco ──
// v191 LOTE 9: o mapa guarda {tid, data} — o PAYLOAD pendente junto com o
// timer. Sem isso o flushAll do SIGTERM só sabia regravar uma lista FIXA de
// bancos, e qualquer persistDebounced fora dela (journey.json hoje, o próximo
// que alguém escrever amanhã) simplesmente se perdia no deploy.
const _persistDebounceTimers = new Map();
function persistDebounced(file, data, delayMs = 2000) {
  if (_persistDebounceTimers.has(file)) {
    clearTimeout(_persistDebounceTimers.get(file).tid);
  }
  _persistDebounceTimers.set(file, { data, tid: setTimeout(() => {
    _persistDebounceTimers.delete(file);
    persist(file, data);
  }, delayMs) });
}
// ⚡ v190 LOTE 8 — THROTTLE COM TETO (não é debounce puro).
// O problema do debounce puro numa via CONTÍNUA: cada chamada faz
// clearTimeout da anterior, então com tráfego constante (o robô de vários
// usuários mandando a cada ~7min, 24/7) o timer pode nunca chegar a disparar
// e um OOM/kill perderia TODO o histórico desde o último flush. O throttle
// mantém a economia do debounce (não grava o banco inteiro a cada evento,
// bloqueando o event loop pra todos) MAS garante uma gravação de verdade
// pelo menos a cada `maxWaitMs` desde que o arquivo ficou sujo.
const _persistSujoDesde = new Map();
function persistThrottled(file, data, delayMs = 3000, maxWaitMs = 30000) {
  const agora = Date.now();
  if (!_persistSujoDesde.has(file)) _persistSujoDesde.set(file, agora);
  if (agora - _persistSujoDesde.get(file) >= maxWaitMs) {
    // teto estourado: grava AGORA (e cancela o debounce pendente)
    if (_persistDebounceTimers.has(file)) {
      clearTimeout(_persistDebounceTimers.get(file).tid);
      _persistDebounceTimers.delete(file);
    }
    _persistSujoDesde.delete(file);
    return persist(file, data);
  }
  if (_persistDebounceTimers.has(file)) clearTimeout(_persistDebounceTimers.get(file).tid);
  _persistDebounceTimers.set(file, { data, tid: setTimeout(() => {
    _persistDebounceTimers.delete(file);
    _persistSujoDesde.delete(file);
    persist(file, data);
  }, delayMs) });
}
// ❄️ v191 LOTE 9 — liga o congelamento de gravações (só a restauração de
// backup chama). Cancela TUDO que está pendente (debounces + o timer de
// sessões) pra que nada caia em cima dos arquivos que acabaram de voltar do
// backup, e a partir daqui persist() vira no-op até o processo reiniciar.
function congelarGravacoes(motivo) {
  if (_gravacoesCongeladas) return false;
  _gravacoesCongeladas = true;
  _gravacoesCongeladasMotivo = String(motivo || "gravações congeladas").slice(0, 200);
  try { _persistDebounceTimers.forEach((ent) => clearTimeout(ent.tid)); } catch {}
  _persistDebounceTimers.clear();
  _persistSujoDesde.clear();
  try { if (_sessPersistT) { clearTimeout(_sessPersistT); _sessPersistT = null; } } catch {}
  console.warn(`[freeze] ❄️ GRAVAÇÕES CONGELADAS — ${_gravacoesCongeladasMotivo}. Nada mais vai ao disco até o servidor reiniciar (inclusive o flushAll do SIGTERM).`);
  return true;
}

async function doAutoSend(email) {
  if (autoSendLock.has(email)) { console.warn(`[auto] ${email} já enviando`); return; }
  autoSendLock.add(email);
  try {
    await _doAutoSendInner(email);
  } catch(unexpectedErr) {
    // FIX-BUG12: captura exceções não tratadas — sempre reagenda
    // v76b: loga o STACK completo (antes só a .message) — sem isso, um erro
    // recorrente tipo "Maximum call stack size exceeded" (RangeError de
    // recursão/estouro de pilha) fica sem pista NENHUMA de qual função
    // causou, mesmo olhando os logs do Render.
    console.error(`[auto] ERRO INESPERADO ${email}:`, unexpectedErr?.stack||unexpectedErr?.message||unexpectedErr);
    const curJob = getAutoJob(email);
    if (curJob?.active && curJob?.queue?.length > 0) {
      addLog(email, { status:"sistema", jobTitle:"⚠️ Erro interno recuperado", company:String(unexpectedErr?.message||"erro").slice(0,200) });
      autoTimers.set(email, setTimeout(()=>scheduleAuto(email), 60_000));
    }
  } finally {
    autoSendLock.delete(email);
  }
}

// ── Traduz erros técnicos do Gmail em mensagens claras para o usuário leigo ──
// v18-FIX: hoisted pra fora de _doAutoSendInner (onde vivia só pro envio
// AUTOMÁTICO) pra virar compartilhada — o envio MANUAL (/api/send) devolvia
// a mensagem CRUA do Google direto pro usuário (ex: "User-rate limit
// exceeded. Retry after 2026-07-15T12:31:47.032Z"), que ninguém leigo entende
// e parece "bug misterioso" — na real quase sempre é um limite do Google
// (Gmail deixa mandar só um tanto de e-mail por vez), não um problema no
// H2BApply. `toEmailCtx` é opcional (só usado na mensagem de "e-mail
// inválido"; o auto-engine passa target.to, o manual passa o destinatário
// que a pessoa mesma escolheu).
function translateGmailErrorMsg(msg, toEmailCtx) {
  msg = String(msg||"");
  if (msg.includes("rateLimitExceeded") || msg.includes("userRateLimitExceeded") || msg.includes("User-rate limit"))
    return { type:"rate_limit", friendly:"⏳ Motivo: o próprio Google limita quantos e-mails uma conta Gmail pode mandar em pouco tempo — é uma proteção automática contra spam que existe pra QUALQUER conta Gmail (pessoal ou não), não é algo específico do H2BApply nem sinal de que sua conta tem algum defeito. Isso acontece quando muitos e-mails saem em sequência rápida, seja mandando manualmente ou pelo robô automático. Não é permanente: o Google libera de novo sozinho depois de alguns minutos. O que fazer: espere um pouco (geralmente 5 a 30 minutos) antes de tentar mandar de novo. No envio automático o sistema já sabe disso e espera + tenta de novo sozinho, sem precisar fazer nada." };
  if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked"))
    return { type:"auth", friendly:"🔐 Motivo: o H2BApply usa uma autorização que o Google dá quando você conecta o seu Gmail de envio — como uma chave de acesso pra poder mandar e-mail em seu nome. Essa chave expirou ou parou de valer, o que costuma acontecer se você trocou a senha do Google, revogou o acesso do H2BApply nas configurações da sua Conta Google, ou ficou muito tempo sem usar o app. O que fazer: conecte o seu Gmail de novo no H2BApply (o botão de conectar Gmail, na tela de envio) pra gerar uma chave nova." };
  if (msg.includes("insufficientPermissions") || msg.includes("Request had insufficient"))
    return { type:"permission", friendly:"🔐 Motivo: quando você conecta o seu Gmail, o Google pede sua permissão pra deixar o H2BApply mandar e-mail em seu nome. Se essa permissão não foi concedida por completo (por exemplo, desmarcando alguma opção na tela do Google), o envio não funciona. O que fazer: conecte o seu Gmail de novo no H2BApply, aceitando TODAS as permissões que a tela do Google pedir." };
  if (msg.includes("suspended") || msg.includes("Account has been suspended") || msg.includes("Suspended"))
    return { type:"suspended", friendly:"⛔ Motivo: o próprio Google suspendeu temporariamente essa conta Gmail — geralmente por segurança (por exemplo, login de um lugar não reconhecido, ou o Google desconfiando de atividade automatizada). Isso é uma decisão do Google, o H2BApply não tem controle sobre isso. O que fazer: acesse gmail.com direto pelo navegador com essa conta e veja se aparece algum aviso, pedido de verificação ou confirmação de segurança — resolvendo isso lá, volta a funcionar." };
  if (msg.includes("sendDisabled") || msg.includes("Mail sending is disabled"))
    return { type:"send_disabled", friendly:"⛔ Motivo: o envio de e-mails está desativado nessa conta Google especificamente (pode ser uma configuração da própria conta, ou — se for um Gmail de empresa/Workspace — uma restrição colocada pelo administrador daquela conta). O H2BApply não consegue mandar nada até isso ser reativado do lado do Google. O que fazer: verifique as configurações de envio dessa conta em mail.google.com, ou fale com quem administra essa conta se for uma conta de trabalho." };
  if (msg.includes("StorageQuotaExceeded") || msg.includes("quota"))
    return { type:"quota", friendly:"📦 Motivo: toda conta Google tem um espaço de armazenamento (normalmente 15GB grátis) que é COMPARTILHADO entre Gmail, Google Drive e Google Fotos. Quando esse espaço enche, o Gmail não consegue nem enviar e-mail novo, porque tecnicamente não tem 'lugar' pra guardar a cópia do que foi enviado. O que fazer: entre em drive.google.com, apague arquivos/fotos/e-mails antigos que não precisa mais (ou esvazie a Lixeira do Gmail), ou compre mais espaço no Google One." };
  if (msg.includes("Invalid") && msg.includes("To"))
    return { type:"invalid_email", friendly:`📧 Motivo: o endereço de e-mail do empregador cadastrado nesta vaga${toEmailCtx?` ("${toEmailCtx}")`:""} está com um formato inválido — provavelmente um erro na fonte oficial de onde a vaga veio (dados do governo dos EUA), não algo que dá pra corrigir no H2BApply. Essa vaga específica não pôde ser enviada. O que fazer: pule essa vaga e tente outra — as outras não têm esse problema.` };
  if (msg.includes("554") || msg.includes("550") || msg.includes("rejected"))
    return { type:"rejected", friendly:"📧 Motivo: quem recusou o e-mail foi o servidor do PRÓPRIO EMPREGADOR (não o Gmail nem o H2BApply) — geralmente porque aquele endereço de e-mail não existe mais, a caixa está cheia, ou o servidor dele bloqueia mensagens de remetentes desconhecidos. Não é um problema na sua conta. O que fazer: essa vaga foi pulada automaticamente — continue com as próximas candidaturas normalmente." };
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET"))
    return { type:"network", friendly:"🌐 Motivo: a conexão entre o servidor do H2BApply e os servidores do Google demorou demais ou caiu no meio do caminho — uma instabilidade momentânea de rede, não um problema na sua conta Gmail. O que fazer: tente enviar de novo em alguns segundos; geralmente resolve sozinho." };
  if (msg.includes("500") || msg.includes("503") || msg.includes("Service Unavailable"))
    return { type:"server_error", friendly:"⚠️ Motivo: os próprios servidores do Google tiveram uma falha temporária (acontece de vez em quando com qualquer serviço do Google, não é algo do H2BApply nem da sua conta). O que fazer: espere um pouco e tente de novo — normalmente volta ao normal em minutos." };
  return { type:"unknown", friendly:`❌ Não foi possível enviar: ${msg.slice(0, 200)}` };
}

async function _doAutoSendInner(email) {
  // Sempre relê o job do banco — nunca usa objeto em cache
  const job = getAutoJob(email);
  if (!job || !job.active) { autoTimers.delete(email); return; }

  // ── Fila: copia fresca a cada ciclo (nunca mutamos job.queue diretamente) ──
  let queue = (job.queue || []).map(item => Object.assign({}, item)); // cópia profunda rasa
  let target = null;

  // Pula duplicatas da fila
  while (queue.length > 0) {
    const candidate = queue[0];
    if (!hasSent(email, candidate.to)) {
      // v15-SEC: auto dedup + validação robusta + self-send guard
      const _ce = parseEmail(candidate.to||"");
      if (!_ce.ok) {
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:`E-mail inválido (${_ce.reason}): "${candidate.to}"` });
        queue.shift(); continue;
      }
      // v18-FIX: guarda de auto-envio agora também cobre os Gmails EXTRAS do
      // próprio usuário (mesmo ajuste feito no envio manual), não só o principal.
      if (_ownEmailsOf(email).has(_ce.email)) {
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:"Destinatário é o próprio usuário — auto-envio bloqueado" });
        queue.shift(); continue;
      }
      // ── VERIFICAR BASE GLOBAL DE EMAILS INVÁLIDOS (bounce intelligence) ──
      if (isEmailInvalid(_ce.email)) {
        const invInfo = DB_INVALID_EMAILS[_ce.email];
        const motivo = invInfo?.motivo || 'Email permanentemente inválido (bounce detectado)';
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:`⚫ Email inválido removido da fila: ${motivo} (${invInfo?.count||1}x detectado)` });
        queue.shift(); continue;
      }
      // ── v23: VAGA MORTA — a fila envelhece; não gasta envio do limite
      // diário do usuário numa vaga que foi retirada/negada/expirou depois
      // que a fila foi montada.
      const _dead = isQueueJobDead(job.source, candidate.caseNum || candidate.id);
      if (_dead) {
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:`🪦 ${_dead} depois que a fila foi montada — pulada (não contou no seu limite)` });
        queue.shift(); continue;
      }
      candidate.to = _ce.email; // normalizado
      target = Object.assign({}, candidate); break;
    }
    addLog(email, { status:"duplicado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:"Email já enviado anteriormente", senderEmail:resolveSendGmail(getUser(email))||email });
    queue.shift();
  }

  // FIX-BUG6: finaliza APENAS quando !target
  if (!target) {
    // v23: antes de finalizar, o robô tenta se REALIMENTAR sozinho com os
    // mesmos filtros do usuário (vagas novas que ele ainda não enviou).
    const _added = tryAutoRefill(email, { ...job, queue:[] });
    if (_added > 0) {
      addLog(email, { status:"sistema", jobTitle:`🔄 Fila recarregada sozinha: +${_added} vaga(s) nova(s)`, company:"O robô continua trabalhando com os mesmos filtros — nada pra você fazer." });
      autoTimers.set(email, setTimeout(()=>scheduleAuto(email), 5000));
      return;
    }
    setAutoJob(email, { ...job, active:false, queue:[], finishedAt:Date.now(), status:"finished" });
    autoTimers.delete(email);
    addLog(email, { status:"sistema", jobTitle:"✅ Fila finalizada", company:`Total: ${job.originalCount||0} vagas processadas. Todas enviadas!` });
    console.log(`[auto] ${email} finalizado — todas as vagas enviadas`);
    // v18-FIX: push como fallback — canal separado do kill-switch de e-mail do dono
    return;
  }

  // Tira o target da fila ANTES de tentar o envio. ⚠️ v184 LOTE 2: isto NÃO
  // é proteção contra crash — setAutoJob é debounced de propósito (DB_AUTO
  // carrega a fila inteira de todo mundo), então num kill duro a fila volta
  // do disco ANTIGA, com esta vaga dentro. Quem garante que o empregador não
  // recebe duas vezes é o markSent do sucesso, que grava SÍNCRONO, e o
  // hasSent/regra 8 que corta a vaga no refill e no próximo ciclo.
  queue.shift();
  setAutoJob(email, { ...job, queue, lastSentAt:Date.now(), status:"sending", currentJob:target });

  // ── Token — nunca pausa sem tentar renovar primeiro ──────
  const logEntry = { company:target.company||"", to:target.to||"", jobTitle:target.title||"", category:target.category||"other", state:target.state||"", city:target.city||"", source:job.source||"", resumeName:"", error:"", profileUsed:"", selectedProfileName:"" };
  let accessToken = null;
  let _autoSenderEmail = email; // email que vai realmente enviar (principal ou extra)

  // ── Round-robin REAL: inclui email principal + todos os extras
  // getSenderToken decide quem envia baseado em menor contagem hoje
  // Se retornar token=null → principal escolhido, fluxo normal de sessão/refresh
  // Se retornar token!=null → extra escolhido, usa diretamente
  try {
    const {token:sndTok0, senderEmail:sndEmail0} = await getSenderToken(email, null, job.senders);
    _autoSenderEmail = sndEmail0; // já define o sender (principal ou extra)
    if (sndTok0) {
      accessToken = sndTok0; // extra: tem token direto
      console.log(`[auto] 🔄 Round-robin → extra: ${sndEmail0}`);
    } else {
      console.log(`[auto] 🔄 Round-robin → principal: ${sndEmail0}`);
      // token=null → fluxo normal de sessão/refresh abaixo para o principal
    }
  } catch(e) {
    console.warn("[auto] round-robin erro:", e.message);
    // v76: WARMUP_CAP_REACHED não é mais lançado pelo round-robin (getSenderToken
    // usa a conta mesmo em aquecimento quando não sobra alternativa — ver ali) —
    // automático nunca mais pausa esperando o teto diário zerar.
    // Usuário SELECIONOU e-mails específicos e nenhum está disponível:
    // NÃO cair no principal (pode estar bloqueado — foi excluído de propósito).
    if (Array.isArray(job.senders) && job.senders.length &&
        !job.senders.map(x=>String(x).toLowerCase()).includes(email.toLowerCase())) {
      queue.unshift(target); // devolve a vaga à fila — nada foi enviado
      setAutoJob(email, { ...job, queue, active:false, status:"paused_auth_error", finishedAt:Date.now() });
      autoTimers.delete(email);
      addLog(email, { status:"pausado", jobTitle:"⛔ E-mails de envio indisponíveis", company:"Os e-mails que você selecionou estão com token expirado ou bloqueados. Reconecte-os no Perfil → Gmail Extra e retome.", error:e.message });
      return;
    }
  }

  // Prioridade 1: sessão ativa em memória (só se não usou sender extra)
  const sessArr = Object.values(sessions).filter(s => s.user_email === email && s.access_token);
  const sess    = sessArr[0] || null;
  const sessId  = sess ? Object.keys(sessions).find(k => sessions[k] === sess) : null;
  if (!accessToken) {
    if (sess && sess.expires_at && Date.now() > sess.expires_at - 120_000) {
      try { await refreshToken(sessId); } catch(e) { console.warn("[auto] refresh sessão:", e.message); }
    }
    if (sess?.access_token) accessToken = sess.access_token;
  }

  // Prioridade 2: token cacheado no banco ainda válido
  if (!accessToken) {
    const userData = getUser(email);
    if (userData?.cached_access_token && userData.cached_token_expiry && Date.now() < userData.cached_token_expiry - 120_000) {
      accessToken = userData.cached_access_token;
    }
  }

  // (round-robin já decidiu o sender acima — principal ou extra)

  // Prioridade 3: renovar via refresh_token (sempre tenta antes de pausar)
  if (!accessToken) {
    const userData = getUser(email);
    if (userData?.refresh_token) {
      try {
        accessToken = await refreshTokenForUser(email);
        console.log(`[auto] ✅ Token renovado via refresh_token para ${email}`);
      } catch(e) {
        const msg = e.message || "";
        const isRevoked = msg.includes("invalid_grant") || msg.includes("revoked") || msg.includes("Token has been expired or revoked");
        // Só pausa definitivamente se o usuário revogou o acesso no Google
        // Para erros de rede/timeout, mantém ativo e tenta de novo no próximo ciclo
        if (isRevoked) {
          // U1 (11/07): marca o refresh_token como MORTO. Sem isso, o próximo login
          // usava prompt=select_account (porque "tem" refresh_token — só que morto),
          // o Google NÃO mandava um novo, e o usuário relogava infinitamente sem
          // resolver — exatamente o relato "desfiz o login, entrei, continua igual".
          setUser(email, { rtInvalid:true, rtInvalidAt:Date.now() });
          // 🔐 v165: diagnóstico com a CAUSA certa — queda minutos após um
          // consent novo = o Google da conta derrubando (senha/segurança),
          // e a instrução vira "resolva em myaccount.google.com" + push.
          const _dqA=_diagQuedaAuth(email,msg);
          setAutoJob(email, { ...getAutoJob(email), active:false, status:"paused_token_revoked" });
          autoTimers.delete(email);
          addLog(email, { status:"pausado", company:"Sistema", to:"", jobTitle: _dqA.fast?"🔐 O Google da sua conta derrubou o acesso — veja a Segurança da conta":"🔐 Acesso ao Gmail revogado — reconecte em Envio Automático → Conectar meu Gmail", error: _dqA.friendly });
          console.warn(`[auto] ❌ Token revogado para ${email} — pausa definitiva`);
          // Notifica usuário por email APENAS se ativo nos últimos 10 dias
          { const _u = getUser(email);
            const _lastSeen = _u?.lastSeenAt || new Date(_u?.created_at||0).getTime();
            const _inactiveDays = (Date.now() - _lastSeen) / 86400000;
            if (_inactiveDays <= 10) {
            } else {
              console.log(`[notif] token_revoked ignorado — ${email} inativo ${Math.round(_inactiveDays)}d`);
            }
          }
        } else {
          // Erro temporário (rede, timeout) — agenda nova tentativa em 5min sem pausar
          const curJob = getAutoJob(email);
          if (curJob) {
            const retryDelay = 5 * 60 * 1000;
            setAutoJob(email, { ...curJob, status:"waiting_token_retry", nextSendAt: Date.now() + retryDelay });
            autoTimers.set(email, setTimeout(() => scheduleAuto(email), retryDelay));
            addLog(email, { status:"sistema", jobTitle:"⏳ Erro temporário de token — tentando novamente em 5min", company: msg });
            console.warn(`[auto] ⚠️ Erro temporário de token para ${email}, retry em 5min:`, msg);
          }
        }
        return;
      }
    } else {
      // Sem refresh_token nenhum — usuário nunca deu permissão offline ou dados foram perdidos
      setAutoJob(email, { ...getAutoJob(email), active:false, status:"paused_no_session" });
      autoTimers.delete(email);
      addLog(email, { status:"pausado", company:"Sistema", to:"", jobTitle:"🔐 Sem permissão de envio salva — reconecte em Envio Automático → Conectar meu Gmail", error:"Nenhum refresh_token disponível" });
      return;
    }
  }

  // ── Payload: construído do zero a cada envio ──────────────
  let sendOk = false;
  let retryCount = 0;
  let _authRetried = false; // 🔐 v165: 1 renovação de token no meio da fila por ciclo
  const MAX_RETRIES = 2;

  while (retryCount <= MAX_RETRIES) {
    // Relê usuário a cada tentativa (dados podem ter mudado)
    const p = getUser(email) || {};
    // 🐛 v172c: "email" (parâmetro da função) é a IDENTIDADE da conta — pra
    // conta nova (login usuário+senha) isso é o USERNAME, nunca um Gmail de
    // verdade (sem @, validado assim de propósito no cadastro). Quem
    // realmente ENVIA (e deve aparecer no From:, no {email} do template e
    // no registro de qual conta mandou) é: o sender EXTRA de verdade
    // (_autoSenderEmail !== email), OU o Gmail conectado pelo principal
    // (resolveSendGmail(p)) — "email" só sobra de fallback pra conta LEGADA,
    // onde ele já É o Gmail. Fonte ÚNICA calculada aqui, reusada em tudo
    // que precisa do endereço real (MIME From:, {email} do template, log/
    // histórico) — nunca recalculada duas vezes com risco de divergir.
    const _autoRealSendEmail = (_autoSenderEmail && _autoSenderEmail !== email) ? _autoSenderEmail : (resolveSendGmail(p) || email);

    // Seleção de perfil — sempre calculada do zero
    const profiles       = Array.isArray(p.profiles) ? p.profiles : [];
    const selectedProfile = selectProfile(profiles, target, job.source || "", job.profileId || null);
    const rotState       = job.rotState || { lastSubjIdx:-1, lastBodyIdx:-1 };

    // Índices de currículo: perfil tem prioridade sobre job, job sobre fallback automático
    let effectiveResumeIdx = (job.resumeIdx != null) ? job.resumeIdx : null;
    let effectiveCoverIdx  = (job.coverIdx  != null) ? job.coverIdx  : null;
    if (selectedProfile) {
      if (selectedProfile.resumeIdx != null) effectiveResumeIdx = selectedProfile.resumeIdx;
      // v20 (reclamação real, 07/2026): cover letter do perfil manda SEMPRE —
      // coverIdx null no perfil significa "Nenhuma" (escolha explícita do
      // usuário), não "sem preferência". Antes o null deixava valer o
      // job.coverIdx, que o /api/auto/start preenchia com a cover de OUTRO
      // perfil (ex.: carta do H-2A saindo em toda vaga H-2B).
      effectiveCoverIdx = (selectedProfile.coverIdx != null) ? selectedProfile.coverIdx : null;
    }
    // Fallback automático: se ainda nulo, usa o primeiro resume disponível do usuário
    if (effectiveResumeIdx == null) {
      const firstResume = (p.cvs || []).find(c => (c.cvType || "resume") === "resume");
      if (firstResume) effectiveResumeIdx = firstResume.idx;
    }

    // ── Anexos: leitura fresca do disco a cada tentativa ──
    const attachments = [];
    // v167 (bug real, auditoria 08/09/2026): rastreado à parte de
    // attachments.length — currículo E carta somam no mesmo array, então
    // "tem 1 anexo" não dizia se era o currículo ou só a carta.
    let resumeAttached = false;

    if (effectiveResumeIdx != null) {
      const ridx = parseInt(effectiveResumeIdx, 10);
      // v15-FIX: comparação tipo-segura (idx pode vir como string em alguns casos de JSON legado)
      const cvMeta = (p.cvs || []).find(c => parseInt(c.idx, 10) === ridx);
      // Lê bytes frescos do disco (nunca cache em variável fora do loop)
      const cvData = loadCv(email, ridx);
      if (cvMeta && cvData) {
        // Valida que é base64 real e não vazio
        const buf = Buffer.from(cvData, "base64");
        if (buf.length > 100) {
          attachments.push({ data: cvData, name: String(cvMeta.name || "resume.pdf") });
          resumeAttached = true;
          logEntry.resumeName = cvMeta.name || "resume.pdf";
        } else {
          console.warn(`[auto] PDF muito pequeno (${buf.length}b) idx=${ridx} — pode estar corrompido`);
        }
      } else {
        console.warn(`[auto] Resume não encontrado no disco: email=${email} idx=${ridx} path=${cvPath(email, ridx)}`);
        // Verifica se arquivo existe no disco
        const cpth = cvPath(email, ridx);
        if (!fs.existsSync(cpth)) {
          addLog(email, { status:"erro_anexo", company:target.company||"", to:target.to, jobTitle:target.title||"", error:`Arquivo PDF não encontrado: idx=${ridx}` });
        }
      }
    }

    if (effectiveCoverIdx != null) {
      const cidx = parseInt(effectiveCoverIdx, 10);
      // v15-FIX: comparação tipo-segura
      const cvMeta = (p.cvs || []).find(c => parseInt(c.idx, 10) === cidx);
      const cvData = loadCv(email, cidx);
      if (cvMeta && cvData) {
        const buf = Buffer.from(cvData, "base64");
        if (buf.length > 100) {
          attachments.push({ data: cvData, name: String(cvMeta.name || "cover.pdf") });
        }
      }
    }

    // Validação: se resumeIdx foi configurado mas arquivo não carregou, tenta qualquer CV disponível.
    // v167 (bug real, auditoria 08/09/2026): a condição antiga era
    // "attachments.length === 0" — com uma carta válida já empurrada acima,
    // o total nunca zerava e este bloco (e o gate final abaixo) NUNCA
    // rodavam: a vaga saía só com a carta, sem currículo, sem aviso nenhum.
    // Agora checa resumeAttached especificamente.
    if (effectiveResumeIdx != null && !resumeAttached) {
      // Tenta qualquer CV do usuário como último recurso
      const fallbackCV = (p.cvs || []).find(c => {
        const data = loadCv(email, c.idx);
        return data && Buffer.from(data, "base64").length > 100;
      });
      if (fallbackCV) {
        const data = loadCv(email, fallbackCV.idx);
        attachments.push({ data, name: fallbackCV.name });
        resumeAttached = true;
        logEntry.resumeName = fallbackCV.name;
        console.warn(`[auto] ⚠️ CV idx=${effectiveResumeIdx} não encontrado — usando fallback: ${fallbackCV.name}`);
      } else {
        addLog(email, { ...logEntry, status:"pulado", error:`Currículo não encontrado no servidor (idx=${effectiveResumeIdx}). Faça upload novamente.` });
        break;
      }
    }

    // ── Assunto (rotação, novo objeto a cada envio) ────────
    const subjectPool = (selectedProfile?.subjects?.length) ? [...selectedProfile.subjects]
                      : (job.subjects?.length)              ? [...job.subjects]
                      : null;
    // v22 (ORDEM DO DONO): sem assunto do usuário → NÃO inventa um (genSubject
    // removido). O envio é pulado logo abaixo com erro claro mandando
    // configurar o perfil. Texto de candidatura é 100% do usuário.
    let chosenSubject = "", newSubjIdx = -1;
    if (subjectPool && subjectPool.length) {
      const rot = rotateItem(subjectPool, rotState.lastSubjIdx);
      chosenSubject = rot.value; newSubjIdx = rot.idx;
    }

    // ── Corpo (rotação, novo objeto a cada envio) ──────────
    const bodyPool = (selectedProfile?.emailBodies?.length) ? [...selectedProfile.emailBodies]
                   : (job.emailBodies?.length)              ? [...job.emailBodies]
                   : null;
    let rawBody, newBodyIdx;
    if (bodyPool && bodyPool.length) {
      const rot = rotateItem(bodyPool, rotState.lastBodyIdx);
      rawBody = rot.value; newBodyIdx = rot.idx;
    } else {
      rawBody = String(selectedProfile?.body || job.bodyTemplate || ""); newBodyIdx = -1;
    }
    if (!rawBody || !String(rawBody).trim()) rawBody = "";

    // Salva rotState ANTES de enviar (novo objeto imutável)
    const newRotState = { lastSubjIdx: newSubjIdx, lastBodyIdx: newBodyIdx };
    setAutoJob(email, { ...getAutoJob(email), rotState: newRotState });

    // Interpola variáveis — novo string a cada chamada
    // Inclui TODAS as variáveis que os templates podem usar
    const tplVars = {
      vaga:       String(target.title    || ""),
      empresa:    String(target.company  || ""),
      nome:       String(p.name || sess?.user_name || ""),
      pais:       String(p.country || "Brazil"),
      telefone:   String(p.phone || ""),
      email:      String(_autoRealSendEmail),            // Gmail real de envio (nunca o username de login)
      cidade:     String(target.city    || p.city || ""),
      estado:     String(target.state   || ""),
      // v167 (bug real, auditoria 08/09/2026): {categoria} era um botão
      // clicável no editor de perfil, mas nem fillTpl (aqui) nem o fill()
      // do cliente (manual) sabiam essa chave — saía o texto LITERAL
      // "{categoria}" no e-mail de verdade. Mesma fonte que /api/category-
      // groups expõe pro front (window._catLabels), pra nunca divergir.
      categoria:  String(CATEGORY_LABELS[target.category]?.label || target.category || ""),
      wage:       String(target.wage    || ""),
      salario:    String(target.wage    || ""),
      inicio:     String(target.start   || ""),
      fim:        String(target.end     || ""),
      case_number:String(target.caseNum || ""),
      eta_case:   String(target.caseNum || ""),         // alias
      url_vaga:   target.caseNum && target.caseNum.startsWith("H-")
                    ? `https://seasonaljobs.dol.gov/jobs/${target.caseNum}`
                    : (target.url || ""),               // link direto para a vaga no DOL
    };
    const subject = fillTpl(String(chosenSubject), tplVars);
    const body    = fillTpl(String(rawBody),        tplVars);

    // v15-SEC: bloqueia envio com assunto ou corpo vazio
    if (!subject.trim()) {
      addLog(email, { ...logEntry, status:"pulado", error:"Assunto em branco — configure um assunto no perfil ou nas configurações." });
      break; // sai do retry loop — pula esta vaga
    }
    if (!body.trim()) {
      addLog(email, { ...logEntry, status:"pulado", error:"Corpo do e-mail em branco — configure um template de mensagem no perfil ou nas configurações." });
      break;
    }
    // v16-FIX: bloqueia envio sem PDF — email vazio pro empregador não pode acontecer
    // v167: também bloqueia quando o perfil tinha currículo configurado mas ele
    // não entrou nos anexos (arquivo órfão) — antes uma carta válida sozinha
    // enganava esta checagem (attachments.length>0 só por causa dela).
    if (attachments.length === 0 || (effectiveResumeIdx != null && !resumeAttached)) {
      addLog(email, { ...logEntry, status:"pulado", error:"Nenhum currículo (PDF) encontrado. Acesse a aba Perfil, suba seu currículo e configure o perfil de envio." });
      console.warn(`[auto] ⛔ BLOQUEADO sem anexo: ${email} → ${target.to}`);
      break;
    }

    // v15-SEC: re-valida e normaliza target.to antes de construir MIME (defesa em profundidade)
    const _finalEmail = parseEmail(target.to);
    if (!_finalEmail.ok) {
      addLog(email, { ...logEntry, status:"pulado", error:`E-mail inválido na fila (${_finalEmail.reason}): "${target.to}"` });
      break;
    }
    if (_ownEmailsOf(email).has(_finalEmail.email)) {
      addLog(email, { ...logEntry, status:"pulado", error:"Destinatário é o próprio usuário — auto-envio bloqueado (verificação final)" });
      break;
    }
    target.to = _finalEmail.email; // garante normalizado no MIME

    // ── Constrói MIME do zero (nunca reutiliza raw) ────────
    const raw = buildMime({
      to: target.to,
      subject,
      text: body,
      fromName: String(p.name || "H2BApply"),
      fromEmail: String(_autoRealSendEmail),
      attachments: attachments.map(a => ({ data: a.data, name: a.name })), // cópia explícita
    });

    // Log detalhado de diagnóstico por envio
    const _pname = selectedProfile?.name||"(nenhum — usando fallback)";
    const _pcats  = selectedProfile?.categories?.join(",")||"(todas)";
    const _presIdx= selectedProfile?.resumeIdx??null;
    const _resFinal= effectiveResumeIdx;
    console.log(`[auto] perfil="${_pname}" cats=[${_pcats}] resume_perfil=${_presIdx} resume_usado=${_resFinal} cat_vaga="${target.category}" anexos=${attachments.length} tentativa=${retryCount+1}`);
    logEntry.selectedProfileName = _pname;
    logEntry.profileUsed = _pname;

    try {
      const { status:gmStatus, body:gmBody } = await httpsReq(
        { hostname:"gmail.googleapis.com", path:"/gmail/v1/users/me/messages/send", method:"POST",
          headers:{ "Authorization":"Bearer "+accessToken, "Content-Type":"application/json" } },
        { raw }
      );
      // 🔐 v165: token de acesso venceu NO MEIO da fila (401 / "Invalid
      // Credentials") → renova SOZINHO e re-tenta o MESMO envio — a vaga
      // nunca mais é queimada nem o robô pausado por um token só vencido
      // (13a2: mensagem de token vencido ≠ autorização morta). Só se o
      // PRÓPRIO refresh falhar é que o erro real segue pro fluxo de pausa.
      {
        const _gmErr0=gmBody?.error?String(gmBody.error.message||""):"";
        if(!_authRetried&&(gmStatus===401||_gmErr0.includes("Invalid Credentials")||_gmErr0.includes("authError")||_gmErr0.includes("Token has been expired or revoked"))){
          _authRetried=true;
          try{
            accessToken=(_autoSenderEmail&&_autoSenderEmail!==email)?await refreshSenderToken(email,_autoSenderEmail):await refreshTokenForUser(email);
            _authEvent(email,"refresh_meio_fila","Token venceu no meio da fila — renovado sozinho e envio re-tentado"+(_autoSenderEmail&&_autoSenderEmail!==email?" ("+_autoSenderEmail+")":""));
            console.log(`[auto] 🔁 v165: token renovado no MEIO da fila (${_autoSenderEmail||email}) — re-tentando o envio`);
            continue;
          }catch(eRef){throw new Error(eRef.message||_gmErr0||("Gmail HTTP "+gmStatus));}
        }
      }
      if (gmBody?.error) {
        const msg = String(gmBody.error.message || JSON.stringify(gmBody.error));
        // Erros de rate limit / 5xx → retry; erros de autenticação / payload → sem retry
        const isRateLimit2 = msg.includes("rateLimitExceeded") || msg.includes("userRateLimitExceeded") || msg.includes("User-rate limit");
        const isTransient = gmStatus >= 500 || isRateLimit2;
        if (isTransient && retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = isRateLimit2 ? 30000 : 5000 * retryCount; // rate limit → espera 30s antes de retry
          console.warn(`[auto] ⚠️ erro transiente (${msg}), retry ${retryCount}/${MAX_RETRIES} em ${delay/1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(msg);
      }
      if (gmStatus !== 200) throw new Error("Gmail HTTP " + gmStatus);

      // ── Sucesso ──────────────────────────────────────────
      markSent(email, target.to);
      const appId = newAppId();
      const snap  = buildJobSnapshot(Object.assign({}, target));
      const histEntry = {
        appId,
        jobId:     target.id || ("a_" + Date.now()),
        job:       target.title,
        company:   target.company,
        to:        target.to,
        dateStr:   todayStr(), // BRT
        date:      toLocaleBRT(Date.now()),
        sentAt:    new Date().toISOString(),
        msgId:     gmBody?.id || null,
        gmailMsgId:gmBody?.id || null,
        threadId:  gmBody?.threadId || null,
        jobSnapshot: snap,
        type:      "auto",
        senderEmail: _autoRealSendEmail,
        attachCount: attachments.length,
        category:  target.category,
        state:     target.state,
        // v74: só pra ADMIN (2-5 contas) guarda o texto literal enviado
        // (auditoria própria). Usuário comum
        // (escala de milhões) NUNCA guarda isso — subjectUsed truncado em
        // DB_LOGS já basta pro caso deles.
        ...((isAdminVip(p)||isAdminEmail(email)) ? { subjectSent: subject.slice(0,500), bodySent: body.slice(0,3000) } : {}),
        city:      target.city      || "",
        wage:      target.wage      || "",
        visa:      target.visa      || target.visaType || "",
        workers:   target.workers   || null,
        start:     target.start     || target.beginDate || "",
        end:       target.end       || target.endDate   || "",
        caseNum:   target.caseNum   || target.case_number || "",
        source:    job.source,
        profileUsed: selectedProfile?.name || null,
      };
      addHist(email, histEntry);
      invalidateUserStatsCache(email);

      addLog(email, { ...logEntry, status:"enviado", appId, profileUsed:selectedProfile?.name||"", subjectUsed:subject.slice(0,120), subjectTpl:(chosenSubject||"").slice(0,120), attachCount:attachments.length, attempt:retryCount+1, senderEmail:_autoRealSendEmail, wage:target.wage||"", city:target.city||"", workers:target.workers||null, start:target.start||"", caseNum:target.caseNum||"" });
      updateAutoStats(email, { sent:(getAutoStats(email).sent||0)+1, startedAt:getAutoStats(email).startedAt||Date.now() });
      // ✅ Heartbeat: registra atividade para o watchdog
      { const h=getHealth(email); h.lastSent=Date.now(); h.errors=0; h.stalledAt=null; h.status="ok"; }
      // Limpa _rl_* keys do job para o destinatário atual (evita crescimento infinito do objeto)
      { const _cj=getAutoJob(email); if(_cj){ const _rlKey="_rl_"+(target.to||"").replace(/[^a-z0-9]/gi,""); if(_cj[_rlKey]){ const {[_rlKey]:_rm,..._rest}=_cj; setAutoJob(email,_rest); } } }
      console.log(`[auto] ✅ ${email} → ${target.to} anexos=${attachments.length} [${appId}]`);
      sendOk = true;
      break;

    } catch(e) {
      const errMsg = String(e.message);

      // v18-FIX: translateGmailError agora é a função compartilhada
      // translateGmailErrorMsg() (hoisted acima de _doAutoSendInner) — o
      // /api/send (envio manual) passou a usá-la também, então a lógica de
      // tradução vive num único lugar em vez de duplicada.
      const { type: errType, friendly: errFriendly } = translateGmailErrorMsg(errMsg, logEntry.to);
      const isRateLimit = errType === "rate_limit";
      const isAuth      = errType === "auth" || errType === "permission";
      const isSuspended = errType === "suspended" || errType === "send_disabled";
      const isTransient = errType === "network" || errType === "server_error";
      const isSkippable = errType === "invalid_email" || errType === "rejected" || errType === "quota";

      if (isRateLimit) {
        // 🛡️ v75 (ordem do dono, 27/07/2026: "automático só deve parar se o
        // Google bloquear, se não bloquear vai enviar sempre"): rate limit
        // (userRateLimitExceeded/429) NÃO é um bloqueio — é só o Google
        // pedindo pra desacelerar um pouco, e se resolve sozinho rápido.
        // Antes isso pausava a fila por até 12h (Retry-After do Google, ou
        // 1h de fallback) e mostrava "O Google pediu uma pausa" — pra quem
        // pagou por automático rodando o dia todo isso parecia travado.
        // Agora só devolve a vaga pra fila e segue no intervalo humanizado
        // normal (5-6min) — nunca para de verdade por isto. Só bloqueio de
        // verdade (suspensão/desativação da conta, mais abaixo) pausa.
        const curJob = getAutoJob(email);
        if (curJob) {
          const restoredQ = [target, ...(curJob.queue||[])];
          setAutoJob(email, { ...curJob, queue: restoredQ });
        }
        addLog(email, { ...logEntry, status:"sistema", error: errFriendly + " Seguindo no ritmo normal — não é um bloqueio." });
        trackJourney(email,'auto_fail',{ok:false,error:errFriendly,detail:`Rate limit → ${target?.company||"?"} (seguiu sem pausar)`});
        const interval=calcSmartInterval(email);
        console.warn(`[auto] ⏳ Rate limit ${email} — não é bloqueio, seguindo no intervalo normal (${Math.round(interval/60000)}min)`);
        setAutoJob(email,{...getAutoJob(email),status:"waiting_interval",nextSendAt:Date.now()+interval});
        autoTimers.set(email, setTimeout(() => scheduleAuto(email), interval));
        return;
      }

      // 🛡️ v73: suspensão/bloqueio de uma conta EXTRA (não a principal), com
      // OUTRAS contas saudáveis ainda disponíveis → isola só a conta doente
      // (blocked:true, o round-robin já a exclui sozinho) e SEGUE enviando
      // pelas demais, em vez de parar TODO o automático por causa de 1 conta.
      // Continua pausando tudo se: for a conta PRINCIPAL, for erro de auth
      // (afeta a sessão como um todo), ou não sobrar mais nenhuma conta sã.
      if (isSuspended && _autoSenderEmail && _autoSenderEmail !== email) {
        // A conta principal sempre continua no pool do round-robin como
        // fallback (getSenderToken monta [principal, ...extrasOk] sempre) —
        // isolando só o extra doente, o motor segue sozinho pelo que restou.
        const uForBlock = getUser(email);
        const updSenders=(uForBlock?.senderEmails||[]).map(s2=>s2.email===_autoSenderEmail?{...s2,blocked:true,blockedReason:errType,blockedAt:Date.now()}:s2);
        setUser(email,{senderEmails:updSenders});
        addLog(email,{...logEntry,status:"pausado",error:`⛔ A conta ${_autoSenderEmail} foi ${errType==="suspended"?"suspensa pelo Google":"desativada pra envio"} — ela foi ISOLADA (não é mais usada) e o automático CONTINUA pelas outras contas. ${errFriendly}`});
        trackJourney(email,'auto_fail',{ok:false,error:errFriendly,detail:`Sender ${_autoSenderEmail} isolado — auto continua`});
        console.warn(`[auto] ⛔ Sender ${_autoSenderEmail} suspenso — isolado, automático de ${email} CONTINUA pelos demais`);
        // Devolve a vaga à fila (não foi enviada) e agenda o próximo ciclo normalmente
        const curJob0=getAutoJob(email);
        if(curJob0){ const restoredQ0=[target,...(curJob0.queue||[])]; setAutoJob(email,{...curJob0,queue:restoredQ0}); }
        const interval0=calcSmartInterval(email);
        setAutoJob(email,{...getAutoJob(email),status:"waiting_interval",nextSendAt:Date.now()+interval0});
        autoTimers.set(email, setTimeout(() => scheduleAuto(email), interval0));
        return;
      }

      if (isAuth || isSuspended) {
        // 🔐 v165: NUNCA pausa por "auth" sem PROVAR com um refresh de
        // verdade — mensagem com cara de autenticação não é autorização
        // morta (13a2). Se o refresh funcionar, o erro era passageiro:
        // re-tenta o envio no mesmo ciclo e segue sem pausar nada.
        if (isAuth && !_authRetried) {
          _authRetried = true;
          try{
            accessToken=(_autoSenderEmail&&_autoSenderEmail!==email)?await refreshSenderToken(email,_autoSenderEmail):await refreshTokenForUser(email);
            _authEvent(email,"refresh_provou_vivo","Erro parecia de autenticação ("+errMsg.slice(0,80)+") mas o refresh funcionou — envio re-tentado sem pausar");
            console.log(`[auto] 🔁 v165: erro 'auth' desmentido pelo refresh (${email}) — seguindo sem pausar`);
            continue;
          }catch(eRef){console.warn(`[auto] v165: refresh confirmou a queda de auth (${email}):`,eRef.message);}
        }
        // Problema de autenticação CONFIRMADO (ou suspensão sem mais nenhuma
        // conta saudável pra isolar e seguir): pausa e avisa com a CAUSA certa.
        let _pauseFriendly = errFriendly;
        if (isAuth) {
          if (!_autoSenderEmail || _autoSenderEmail === email) {
            // Principal: marca o RT como morto (próximo login força consent) e
            // diagnostica: queda MINUTOS após consent novo = Google da conta.
            setUser(email, { rtInvalid:true, rtInvalidAt:Date.now() });
            _pauseFriendly = _diagQuedaAuth(email, errMsg).friendly;
          } else {
            // 🔐 v165: extra com autorização MORTA não derruba o robô inteiro
            // (mesmo padrão do v73 pra suspensão): marca só o badge RECONECTAR
            // daquele extra, devolve a vaga e SEGUE pelas outras contas.
            const _uSnd=getUser(email);
            setUser(email,{senderEmails:(_uSnd?.senderEmails||[]).map(s2=>s2.email===_autoSenderEmail?{...s2,tokenExpired:true}:s2)});
            _authEvent(email,"extra_isolado_auth","Conta extra "+_autoSenderEmail+" com autorização morta — isolada (badge RECONECTAR); o automático CONTINUA pelas outras contas");
            addLog(email,{...logEntry,status:"sistema",error:`🔐 A conta extra ${_autoSenderEmail} precisa ser reconectada (autorização morta) — ela foi isolada e o automático CONTINUA pelas outras contas.`});
            console.warn(`[auto] 🔐 v165: extra ${_autoSenderEmail} com auth morta — isolado, automático de ${email} CONTINUA`);
            const _cjX=getAutoJob(email);
            if(_cjX){ setAutoJob(email,{..._cjX,queue:[target,...(_cjX.queue||[])]}); }
            const _ivX=calcSmartInterval(email);
            setAutoJob(email,{...getAutoJob(email),status:"waiting_interval",nextSendAt:Date.now()+_ivX});
            autoTimers.set(email, setTimeout(() => scheduleAuto(email), _ivX));
            return;
          }
        }
        const curJob = getAutoJob(email);
        if (curJob) {
          // Devolve vaga à fila para quando o usuário logar de novo
          const restoredQ = [target, ...(curJob.queue||[])];
          setAutoJob(email, { ...curJob, queue: restoredQ, active:false, status: isSuspended ? "paused_account_suspended" : "paused_auth_error" });
        }
        if (autoTimers.has(email)) { clearTimeout(autoTimers.get(email)); autoTimers.delete(email); }
        _authEvent(email,isSuspended?"pausa_suspensa":"pausa_auth","Automático pausado: "+errMsg.slice(0,150));
        addLog(email, { ...logEntry, status:"pausado", error: _pauseFriendly });
        trackJourney(email,'auto_fail',{ok:false,error:_pauseFriendly,critical:true,detail:`Auth error → auto pausado`});
        console.warn(`[auto] ❌ Auth/suspended ${email} — auto pausado`);
        return;
      }

      if (isTransient && retryCount < MAX_RETRIES) {
        retryCount++;
        console.warn(`[auto] ⚠️ Erro temporário (${errMsg}), retry ${retryCount}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 8000 * retryCount));
        continue;
      }

      // Erro definitivo para esta vaga (invalid email, rejected, quota, unknown)
      // Pula a vaga e continua com a próxima — NÃO para o automático
      addLog(email, { ...logEntry, status: isSkippable ? "pulado" : "falhou", error: errFriendly, profileUsed:selectedProfile?.name||"", subjectUsed:(subject||"").slice(0,120), attachCount:attachments.length, attempt:retryCount+1, senderEmail:_autoRealSendEmail, wage:target.wage||"", city:target.city||"" });
      trackJourney(email,'auto_fail',{ok:false,error:errFriendly,detail:`${target?.company||"?"} → ${target?.to||"?"}`});
      updateAutoStats(email, { failed:(getAutoStats(email).failed||0)+1 });
      break;
    }
  }

  // Agenda próximo envio — sempre relê job do banco
  const updJob = getAutoJob(email);
  if (!updJob || !updJob.active) { autoTimers.delete(email); return; }
  const interval = calcSmartInterval(email);
  setAutoJob(email, { ...updJob, status:"waiting_interval", nextSendAt:Date.now()+interval });
  autoTimers.set(email, setTimeout(() => scheduleAuto(email), interval));
}

// v22 (ORDEM DO DONO): genSubject removido — o programa não inventa assunto.
// fillTpl: substitui TODAS as variáveis de template — incluindo {email}, {cidade}, {estado}
const fillTpl=(tpl,v)=>(tpl||"")
  .replace(/{vaga}/g,       v.vaga||"")
  .replace(/{empresa}/g,    v.empresa||"")
  .replace(/{categoria}/g,  v.categoria||"")
  .replace(/{url_vaga}/g,   v.url_vaga||"")
  .replace(/{case_number}/g,v.case_number||"")
  .replace(/{eta_case}/g,   v.eta_case||"")
  .replace(/{salario}/g,    v.salario||"")
  .replace(/{fim}/g,        v.fim||"")
  .replace(/{nome}/g,       v.nome||"")
  .replace(/{pais}/g,       v.pais||"")
  .replace(/{telefone}/g,   v.telefone||"")
  .replace(/{email}/g,      v.email||"")
  .replace(/{cidade}/g,     v.cidade||"")
  .replace(/{estado}/g,     v.estado||"")
  .replace(/{city}/g,       v.cidade||"")
  .replace(/{state}/g,      v.estado||"")
  .replace(/{wage}/g,       v.wage||"")
  .replace(/{salario}/g,    v.wage||"")
  .replace(/{inicio}/g,     v.inicio||"")
  .replace(/{start}/g,      v.inicio||"");

// v19-FIX: corpo do loop de reactivateAutoJobs() extraído pra função própria,
// reutilizável em qualquer lugar que precise "religar" um job travado (timer
// morto) SEM ignorar um cooldown em andamento — é o que diferencia isso de um
// scheduleAuto() direto: respeita waiting_limit/waiting_rate_limit/waiting_interval
// e o nextSendAt já salvo, senão um "self-heal" ingênuo poderia disparar um
// envio na hora bem no meio de um cooldown de rate-limit do Google, piorando
// o bloqueio em vez de esperar ele passar. Retorna true se agendou algo.
function reactivateOneAutoJob(email, job, now){
  now = now || Date.now();
  // 🛡️ v184 LOTE 2: exigir fila NÃO-VAZIA aqui matava em silêncio o job que
  // acabou de mandar a ÚLTIMA vaga da fila e está no intervalo humanizado de
  // ~7min esperando o refill (queue:[] + active:true + nextSendAt futuro é
  // estado NORMAL do motor). Este repo faz deploy a cada commit: o robô de um
  // cliente pagante simplesmente não voltava, e nenhum vigia o pegava (o laço
  // de órfãos do watchdog tinha a MESMA condição). Fila vazia passa; o ramo
  // waitStatuses+hasNextSend abaixo re-agenda pro tempo que FALTAVA — nunca
  // chamar scheduleAuto na hora aqui, senão o refill dispara e sai um envio
  // fora do intervalo de 7min.
  if(!job?.active) return false;
  // FIX-BUG13: valida estrutura da fila
  if(!Array.isArray(job.queue)){
    console.error(`[auto] ${email}: queue corrompida — resetando`);
    setAutoJob(email,{...job,active:false,status:"paused_corrupt_queue"});
    addLog(email,{status:"pausado",jobTitle:"❌ Fila corrompida",company:"Reinicie o automático.",error:"queue não é array"});
    return false;
  }

  const waitStatuses=new Set(["waiting_rate_limit","waiting_limit","waiting_interval"]);
  const hasNextSend = job.nextSendAt && job.nextSendAt > now;

  if(job.status === "waiting_limit"){
    // Para waiting_limit: sempre verifica se o limite já zerou (novo dia)
    if(hasNextSend){
      const delay = Math.max(1000, job.nextSendAt - now);
      console.log(`[auto] ${email} aguardando limite — retoma em ${Math.round(delay/60000)}min`);
      autoTimers.set(email, setTimeout(()=>scheduleAuto(email), delay));
    } else {
      // nextSendAt passou → meia-noite cruzou → novo dia → dispara imediatamente
      console.log(`[auto] ${email} limite de ontem expirou — disparando imediatamente`);
      scheduleAuto(email);
    }
  } else if(waitStatuses.has(job.status) && hasNextSend){
    const delay = Math.max(1000, job.nextSendAt - now);
    console.log(`[auto] reativado com delay ${Math.round(delay/1000)}s para ${email} (status: ${job.status})`);
    autoTimers.set(email, setTimeout(()=>scheduleAuto(email), delay));
  } else {
    scheduleAuto(email);
  }
  return true;
}

// ── 🔌 v195 LOTE 13: reconectar o Gmail RETOMA o robô sozinho ───────────────
// Até aqui o callback do /oauth/connect-send só limpava `rtInvalid`: o job
// continuava `paused_*` até a pessoa achar o botão genérico "Retomar" — e
// TODAS as instruções de pausa por autenticação mandavam "fazer login com o
// Google de novo", caminho que não existe desde o v172c (login é usuário+
// senha; o Google só conecta o Gmail de ENVIO). Cliente pagante ficava com o
// robô morto depois de fazer exatamente o que o site mandou.
// Régua (a mesma do gate v172h, que continua intocado): só religa quem TEM
// automático ativo (ou é admin) e tem refresh_token de verdade.
// O ritmo é PRESERVADO: `nextSendAt` futuro vira timer pro tempo que faltava
// — chamar scheduleAuto na hora dispararia o refill e furaria o intervalo
// humanizado de ~7min contra o Gmail (mesma lição do v184 LOTE 2).
const AUTH_PAUSED_STATUSES = new Set(["paused_auth_error","paused_token_revoked","paused_no_refresh_token","paused_oauth_expired","paused_no_session"]);
function retomarAutoAposReconexao(email){
  try{
    const job = getAutoJob(email);
    if(!job || job.active) return null;                       // nada parado esperando auth
    if(!AUTH_PAUSED_STATUSES.has(job.status)) return null;     // parou por outro motivo (plano, fila corrompida...)
    const u = getUser(email);
    if(!u) return null;
    if(!u.refresh_token) return "sem_token";
    if(!(isAutoVipActive(u) || isAdminVip(u))) return "sem_plano";
    const now = Date.now();
    const next = (Number.isFinite(job.nextSendAt) && job.nextSendAt > now) ? job.nextSendAt : 0;
    const novo = { ...job, active:true, status: next ? "waiting_interval" : "resuming" };
    if(next) novo.nextSendAt = next; else delete novo.nextSendAt;
    setAutoJob(email, novo);
    if(autoTimers.has(email)){ clearTimeout(autoTimers.get(email)); autoTimers.delete(email); }
    if(next) autoTimers.set(email, setTimeout(()=>scheduleAuto(email), Math.max(1000, next-now)));
    else scheduleAuto(email);
    addLog(email,{status:"sistema",jobTitle:"▶️ Envio automático retomado sozinho depois da reconexão do Gmail",company:"Conectar Gmail",to:""});
    console.log(`[auto] ▶️ ${email}: robô retomado após reconexão do Gmail (status anterior: ${job.status})`);
    return "retomado";
  }catch(e){ console.warn("[auto] falha ao retomar após reconexão:", e.message); return null; }
}

async function reactivateAutoJobs(){
  let n=0;
  const now = Date.now();

  // Passo 1: renova tokens de TODOS os usuários com auto ativo ANTES de agendar
  // FIX-CRASH: pré-aquecimento em background com lotes de 3 (não bloqueia o boot)
  const emailsToWarm = Object.entries(DB_AUTO)
    .filter(([,j]) => j.active && j.queue?.length > 0)
    .map(([e]) => e);

  console.log(`[boot] Pré-aquecendo tokens para ${emailsToWarm.length} usuário(s) com auto ativo...`);
  // Fire-and-forget: não bloqueia o boot — tokens são renovados em background
  (async () => {
    for (let i = 0; i < emailsToWarm.length; i += 3) {
      const lote = emailsToWarm.slice(i, i + 3);
      await Promise.allSettled(lote.map(async email => {
        const u = getUser(email);
        if (!u?.refresh_token) return;
        try {
          await refreshTokenForUser(email);
          console.log(`[boot] ✅ Token pré-aquecido: ${email}`);
        } catch(e) {
          console.warn(`[boot] ⚠️ Token falhou para ${email}:`, e.message);
        }
      }));
      if (i + 3 < emailsToWarm.length) await new Promise(r => setTimeout(r, 1000));
    }
  })();

  // Passo 2: agenda os jobs
  for(const[email,job]of Object.entries(DB_AUTO)){
    if(reactivateOneAutoJob(email, job, now)) n++;
  }
  if(n) console.log(`[boot/auto] ${n} job(s) reativados após restart`);
}

// ══════════════════════════════════════════════════════════
//  SESSION
// ══════════════════════════════════════════════════════════
// ══ SESSÕES — LOGOUT FORÇADO A CADA DEPLOY (pedido do dono, 07/07/2026) ═════
// Decisão INVERTIDA da V955 (que fazia sessões de login sobreviverem a
// deploy): agora, toda vez que o processo sobe (deploy ou restart), TODAS as
// sessões de LOGIN são descartadas — a pessoa precisa clicar em "Entrar" de
// novo. Isso NUNCA toca em DB_USERS[email].refresh_token/cached_access_token
// (arquivo separado, users.json) — o envio AUTOMÁTICO usa esse token direto
// do banco (refreshTokenForUser, ver Prioridade 3 mais abaixo) e continua
// rodando 100% normalmente, sem qualquer interrupção, mesmo com todo mundo
// deslogado do navegador. Única exceção preservada: __sender__ (token
// temporário de "adicionar Gmail extra" em andamento, <10min) — não é
// "login", é um passo de UI no meio do caminho; se o servidor reiniciar
// bem nessa janela (ex.: Render "acordando"), não queremos quebrar esse
// fluxo específico.
const SESS_TTL =7*24*60*60*1000;
// Auditoria de segurança (10/09/2026): sessão de admin abre dados financeiros
// sensíveis (Pendentes, valores, comprovantes) e usava o MESMO prazo de 7 dias
// de um usuário comum — sem trava adicional. TTL bem mais curto só pra sessão
// de admin (a sessão já cai por completo a cada deploy — isto cobre o admin
// ficando logado por dias entre deploys, hipótese real no Render).
const ADMIN_SESS_TTL =24*60*60*1000;
// v209 (bug real, 19/09/2026 — "Sessão OAuth inválida ou expirada" intermitente
// no 1º connect, tanto do Gmail de envio quanto da conta de notificações):
// __connectsend__ (/oauth/connect-send) e __notif__ (/oauth/notif-connect) já
// chamavam persistSessions() logo após criar o state, achando que sobreviviam
// a um restart no meio da ida-e-volta do Google — igual __sender__. Mas
// persistSessions() só GRAVAVA entradas __sender__ (o resto era descartado no
// próprio snapshot) e _loadSessionsFromDisk() só RESTAURAVA __sender__. Ou
// seja: se o Render reiniciasse (deploy ou "acordar" do free tier) bem entre o
// clique em "Conectar" e a volta do OAuth, o state some e o callback cai no
// fallback genérico "Sessão OAuth inválida ou expirada" — sem culpa nenhuma do
// usuário, só bastava clicar de novo (com o servidor já estável). Nenhum dos
// 3 é uma sessão de LOGIN de verdade — são handshakes de OAuth de <10min, a
// MESMA categoria que já tinha esse tratamento pro __sender__; generalizado
// pra lista única, pra nenhum handshake novo repetir esse mesmo bug.
const OAUTH_HANDSHAKE_PREFIXES=["__sender__","__connectsend__","__notif__"];
function _isOauthHandshake(id){return OAUTH_HANDSHAKE_PREFIXES.some(pfx=>id.startsWith(pfx));}
function _loadSessionsFromDisk(){
  const box=Object.create(null);
  try{
    let raw=storageLoad(SESSIONS_FILE,null);
    if(!raw)return box;
    if(raw.enc){const dec=decStr(raw.enc);if(!dec)return box;raw=JSON.parse(dec);} // cifrado
    const now=Date.now();let kept=0,expired=0,loggedOut=0;
    for(const[id,s]of Object.entries(raw)){
      if(!s){expired++;continue;}
      // Handshakes de OAuth em andamento (<10min) podem sobreviver a um
      // restart no meio do caminho — não são "login", são um passo de UI.
      if(_isOauthHandshake(id)){
        if(s.pending||now-(s.created||0)>600_000){expired++;continue;}
        box[id]=s;kept++;continue;
      }
      // Qualquer outra coisa (login normal, __p__ pendente de login) é
      // descartada de propósito — é exatamente isso que "logout no deploy" significa.
      loggedOut++;
    }
    console.log(`[sessions] 🔒 Deploy detectado: ${loggedOut} sessão(ões) de login descartada(s) de propósito (pedido do dono — todos precisam entrar de novo). ${kept} entrada(s) temporária(s) de OAuth em andamento preservada(s), ${expired} expirada(s)/inválida(s). ⚠️ Tokens em DB_USERS (refresh_token) NÃO foram tocados — o envio automático continua rodando normalmente para todo mundo.`);
  }catch(e){console.warn("[sessions] restauração falhou (seguindo vazio):",e.message);}
  return box;
}
const sessions=_loadSessionsFromDisk();
const rateMap  =Object.create(null);
function persistSessions(){
  try{
    const snap={};
    for(const[id,s]of Object.entries(sessions)){
      if(!s)continue;
      // Handshakes de OAuth (__sender__/__connectsend__/__notif__) precisam
      // sobreviver a restart/cold-start (Render free tier "dorme" com
      // inatividade — se o servidor reiniciar entre o clique em "Conectar" e
      // a volta do OAuth do Google, esse estado em memória se perdia e a
      // conexão nunca completava). Expiram sozinhos em 10min (checagem de
      // idade no callback), então é seguro persistir.
      if(_isOauthHandshake(id)){snap[id]=s;continue;}
      // 🔒 Pedido do dono: sessões de LOGIN (e o __p__ pendente de login) NUNCA
      // são gravadas em disco — elas só existem em memória durante o processo
      // atual. Assim, o próximo boot (deploy ou restart) já não encontra nada
      // pra restaurar, e todo mundo precisa entrar de novo. Isso não afeta o
      // envio automático em nada: o token dele mora em DB_USERS, arquivo à parte.
      continue;
    }
    const payload=_encKey?{enc:encStr(JSON.stringify(snap))}:snap;
    persist(SESSIONS_FILE,payload);
  }catch(e){console.warn("[sessions] persist:",e.message);}
}
let _sessPersistT=null;
function persistSessionsDebounced(ms=2000){
  if(_sessPersistT)clearTimeout(_sessPersistT);
  _sessPersistT=setTimeout(()=>{_sessPersistT=null;persistSessions();},ms);
}

function rateLimit(k,max,ms){const n=Date.now();if(!rateMap[k]||rateMap[k].r<n)rateMap[k]={n:0,r:n+ms};return++rateMap[k].n>max;}
// 🚨 v172c-SEC (auditoria de segurança, 12/09/2026): as rotas novas de
// login/cadastro pegavam o PRIMEIRO valor de X-Forwarded-For pra montar a
// chave do rate-limit — mas esse cabeçalho é uma LISTA que qualquer
// cliente pode mandar com valores inventados na frente; o Render (nosso
// proxy real) sempre ANEXA o IP de conexão de verdade como o ÚLTIMO valor
// da lista. Confiar no primeiro deixava o limite de tentativas trivialmente
// contornável (um valor falso novo a cada requisição = chave nova sempre).
// _clientIp() usa o ÚLTIMO valor (o que o Render realmente viu) — fonte
// única, nunca duplicar essa extração em rota nova.
function _clientIp(req){
  const xff=req.headers["x-forwarded-for"];
  if(xff){const parts=String(xff).split(",").map(s=>s.trim()).filter(Boolean);if(parts.length)return parts[parts.length-1];}
  return req.socket?.remoteAddress||"anon";
}
const makeCookieStr=id=>{const b=`h2b_session=${id}; Path=/; HttpOnly; Max-Age=${30*86400}`;return IS_PROD?b+"; Secure; SameSite=Lax":b+"; SameSite=Lax";};
const clearCookieStr=()=>{const b="h2b_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";return IS_PROD?b+"; Secure; SameSite=Lax":b;};
const getSessId=req=>{const m=(req.headers.cookie||"").match(/(?:^|;\s*)h2b_session=([^;]+)/);return m?m[1]:null;};
// 🔌 v237u (bug real ao vivo, 20/09/2026 — Andrio testando "Conectar Gmail
// Extra" com ndrkick.3@gmail.com: passou pela tela do Google e voltou
// DESLOGADO, "Sessão inválida ou expirada", em vez de cair no perfil com o
// Gmail conectado). Causa raiz: KB-078 derruba TODA sessão de LOGIN a cada
// deploy/restart, de propósito (07/07/2026) — mas os handshakes de OAuth
// (__sender__/__connectsend__/__notif__) sobrevivem à parte (v209), porque o
// Google pode levar bastante tempo (avisos de "app não verificado" →
// Avançado → Continuar) até a pessoa voltar. Se um deploy caiu bem nessa
// janela — e este servidor publica a cada commit — a sessão de login sumia
// enquanto o handshake persistido continuava vivo, e a trava anti-CSRF
// v172c-SEC (que exige a sessão de login atual == quem iniciou) barrava a
// pessoa mesmo sem culpa nenhuma dela.
// Fix: cookie de handshake PRÓPRIO (h2b_of), independente de `sessions` — mora
// no NAVEGADOR, então sobrevive ao restart do processo. Ele prova "é o MESMO
// navegador que iniciou este state" sem depender da sessão de login continuar
// viva, e mantém a MESMA proteção contra o ataque de verdade (vítima clicando
// o link de consentimento que o atacante mandou): o navegador da vítima nunca
// recebeu esse cookie (Set-Cookie nunca viaja por link, só na resposta pro
// navegador que fez a requisição), então nem sessão nem cookie batem lá.
const FLOW_COOKIE="h2b_of";
const makeFlowCookieStr=val=>{const b=`${FLOW_COOKIE}=${val}; Path=/oauth; HttpOnly; Max-Age=600`;return IS_PROD?b+"; Secure; SameSite=Lax":b+"; SameSite=Lax";};
const clearFlowCookieStr=()=>{const b=`${FLOW_COOKIE}=; Path=/oauth; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;return IS_PROD?b+"; Secure; SameSite=Lax":b;};
const _oauthFlowSameBrowser=(req,expectedSt)=>{const m=(req.headers.cookie||"").match(new RegExp("(?:^|;\\s*)"+FLOW_COOKIE+"=([^;]+)"));return!!m&&m[1]===expectedSt;};
// Reconstrói a sessão de login (mesmo formato usado em /api/login) quando ela
// sumiu no meio do handshake mas o cookie acima já provou que é o MESMO
// navegador que iniciou logado — a pessoa volta pro perfil JÁ logada, com o
// Gmail conectado, em vez de ter que entrar de novo pra repetir o fluxo.
const _oauthReloginCookie=ownerEmail=>{const sid="usr_"+crypto.randomBytes(16).toString("hex");sessions[sid]={user_email:ownerEmail,user_name:(getUser(ownerEmail)||{}).name||ownerEmail,created_at:Date.now()};persistSessionsDebounced(500);return makeCookieStr(sid);};
// 🚨 v177-FIX2 (auditoria 14/09/2026): antes, uma sessão vencida (>24h admin
// / >7d usuário) continuava sendo ACEITA por toda requisição até a próxima
// varredura periódica do setInterval (a cada 5min) apagá-la — janela real de
// até 5min a mais de acesso com sessão expirada. getSess() agora confere o
// TTL na hora, pra CADA requisição (expiração preguiçosa) — a varredura
// periódica continua existindo só pra liberar memória de sessões inativas.
const getSess  =req=>{
  const id=getSessId(req);if(!id)return null;
  const s=sessions[id];if(!s)return null;
  const age=Date.now()-(s.ts||s.created_at||0);
  const ttl=s.pending?600_000:(isAdminVip(getUser(s.user_email))?ADMIN_SESS_TTL:SESS_TTL);
  if(age>ttl){delete sessions[id];return null;}
  return s;
};

// ══════════════════════════════════════════════════════════
//  HTTP UTILS
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  Gerador de ícone PNG puro (sem dependências externas)
//  Compatível com PWA manifest, notificações push e iOS
//  Gera um PNG sólido com gradiente azul e texto "H2B"
// ══════════════════════════════════════════════════════════
function generateIconPNG(size) {
  // CRC32 lookup table
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff);
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crc = Buffer.alloc(4); crc.writeInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crc]);
  }
  // Blue gradient: top #1e3a8a → bottom #1a56db
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(0x1e + (0x1a - 0x1e) * t);
    const g = Math.round(0x3a + (0x56 - 0x3a) * t);
    const b = Math.round(0x8a + (0xdb - 0x8a) * t);
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter none
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);
  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(size, 0); IHDR.writeUInt32BE(size, 4);
  IHDR[8] = 8; IHDR[9] = 2; // 8-bit RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", IHDR), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

// httpsReq: extraído para src/gmail.js (Fase 1 · Módulo 2)
const { httpsReq, normalizeEmail: _normEmailMod, buildMime: _buildMimeMod, sanitizeHeaderField, resolveSendGmail } = require("./mod-gmail.js");
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB — suficiente para PDFs base64
function readBody(req){return new Promise((res,rej)=>{const p=[];let sz=0;req.on("data",c=>{sz+=c.length;if(sz>MAX_BODY_SIZE){rej(new Error("Payload too large"));return;}p.push(c);});req.on("end",()=>res(Buffer.concat(p).toString()));req.on("error",rej);});}
function json(res,status,data){
  const b=JSON.stringify(data);
  const raw=Buffer.byteLength(b);
  // V951: gzip automático para respostas >16KB quando o cliente aceita.
  // A lista de vagas (H-2A ~4,5MB) cai ~85% — só nesta rota já paga a Parte 1.
  // Compressão nível 5: ~40ms num payload de 4MB, imperceptível e vale o tráfego.
  const _rq=res._req;
  if(_rq && raw>16384 && /\bgzip\b/.test(String(_rq.headers["accept-encoding"]||""))){
    try{
      const gz=zlib.gzipSync(b,{level:5});
      res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Encoding":"gzip","Content-Length":gz.length,"Vary":"Accept-Encoding"});
      return res.end(gz);
    }catch(e){/* fallback sem compressão */}
  }
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":raw});
  res.end(b);
}

// ── isAdmin helper — declarado aqui perto do getSess/json para clareza ──────
// (antes estava na linha ~4260 após os usos — funcionava por hoisting mas era confuso)
function isAdmin(req, res) {
  const s = getSess(req);
  if (!s?.user_email) { json(res, 401, { error: "Não autenticado." }); return false; }
  const p = getUser(s.user_email);
  if (!p?.isAdmin && !isAdminEmail(_sessAdminEmail(s))) { json(res, 403, { error: "Acesso negado." }); return false; }
  return true;
}

// ══════════════════════════════════════════════════════════
//  GMAIL
// ══════════════════════════════════════════════════════════
// ══ 🔐 v165 — AUTENTICAÇÃO NUNCA CAI POR NOSSA CAUSA (dono, 02/09/2026:
// "o Gmail dele está sendo desconectado sempre... envia por 5-10 minutos e
// pede autenticação de novo. Não sei se é erro no sistema ou no Google
// dele") ═══════════════════════════════════════════════════════════════
// Linha do tempo de autenticação POR USUÁRIO (ring de 40, debounced — nunca
// campo crítico, regra 6e): todo evento que toca a autorização Google fica
// registrado no próprio usuário. É o raio-X que separa "nós derrubamos" de
// "o Google da conta dele derrubou" — o admin vê na 💳 Auditoria.
function _authEvent(email,tipo,detalhe){
  try{
    const em=String(email||"").toLowerCase().trim();if(!em)return;
    const u=getUser(em);if(!u)return;
    const tl=Array.isArray(u.authTimeline)?u.authTimeline:[];
    setUser(em,{authTimeline:[{em:Date.now(),tipo:String(tipo||"?").slice(0,40),detalhe:String(detalhe||"").slice(0,300)},...tl].slice(0,40)});
  }catch(e){}
}
// Classifica uma queda de autorização: refresh morto MINUTOS depois de um
// consent novo (lastConsentAt < 30min) = o GOOGLE da conta está derrubando
// (troca de senha recente, alerta de segurança pendente, proteção reforçada
// contra apps) — relogar aqui sem resolver lá desconecta de novo. A pessoa
// recebe a instrução CERTA (myaccount.google.com → Segurança) + push 1x/6h.
function _diagQuedaAuth(email,rawMsg){
  const u=getUser(email)||{};
  const fast=!!(u.lastConsentAt&&(Date.now()-u.lastConsentAt)<30*60_000);
  const friendly=fast
    ?"🔐 O Google da SUA conta está derrubando a autorização minutos depois do login — isso NÃO é o H2BApply desconectando: costuma acontecer quando você trocou a senha do Google há pouco, quando há um alerta de segurança pendente na conta, ou quando a conta tem proteção reforçada contra apps. Antes de reconectar aqui: entre em myaccount.google.com → Segurança, resolva qualquer alerta amarelo/vermelho (confirme 'Foi você') e SÓ DEPOIS reconecte seu Gmail no H2BApply (Envio Automático → Conectar meu Gmail)."
    :"🔐 A autorização do Google expirou ou foi revogada (troca de senha, acesso removido nas configurações do Google, ou muito tempo sem uso). Reconecte seu Gmail no H2BApply (Envio Automático → Conectar meu Gmail) pra gerar uma permissão nova.";
  _authEvent(email,fast?"queda_rapida":"queda_auth",String(rawMsg||"").slice(0,200)+(fast?" · caiu "+Math.round((Date.now()-u.lastConsentAt)/60000)+"min após o consent novo — provável causa: segurança da conta Google":""));
  if(fast&&(!u.authFastDropAvisoEm||Date.now()-u.authFastDropAvisoEm>6*3600_000)){
    setUser(email,{authFastDropAvisoEm:Date.now()});
  }
  return {fast,friendly};
}
async function refreshToken(sid){
  const s=sessions[sid];
  // Usa refresh_token da sessão ou do banco persistido
  const rt=s?.refresh_token||(s?.user_email?getUser(s.user_email)?.refresh_token:null);
  if(!rt)throw new Error("Sem refresh_token — usuário precisa fazer login novamente.");
  const b=new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:rt,grant_type:"refresh_token"}).toString();
  const{body:r}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(b)}},b);
  if(r.error)throw new Error(r.error_description||r.error);
  if(r.access_token){
    if(s){s.access_token=r.access_token;s.expires_at=Date.now()+(r.expires_in||3600)*1000;}
    // Persiste o novo access_token no banco (para uso pelo auto sem sessão)
    if(s?.user_email){setUser(s.user_email,{cached_access_token:r.access_token,cached_token_expiry:Date.now()+(r.expires_in||3600)*1000});}
    // Atualiza refresh_token se veio um novo
    if(r.refresh_token&&s?.user_email){setUser(s.user_email,{refresh_token:r.refresh_token});if(s)s.refresh_token=r.refresh_token;}
  }
}

// Renova token usando refresh_token do banco (para auto sem sessão ativa)
async function refreshTokenForUser(email){
  const u=getUser(email);if(!u?.refresh_token)throw new Error("Sem refresh_token — usuário precisa fazer login novamente.");
  const b=new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:u.refresh_token,grant_type:"refresh_token"}).toString();
  const{body:r}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(b)}},b);
  if(r.error){_authEvent(email,"refresh_falhou",String(r.error_description||r.error).slice(0,180));throw new Error(r.error_description||r.error);} // 🔐 v165: o erro CRU do Google fica na linha do tempo
  if(!r.access_token)throw new Error("Token não retornado pelo Google.");
  const expiresAt=Date.now()+(r.expires_in||3600)*1000;
  setUser(email,{cached_access_token:r.access_token,cached_token_expiry:expiresAt});
  if(r.refresh_token)setUser(email,{refresh_token:r.refresh_token});
  // Atualiza todas as sessões ativas desse usuário
  for(const sid of Object.keys(sessions)){const s=sessions[sid];if(s.user_email===email){s.access_token=r.access_token;s.expires_at=expiresAt;if(r.refresh_token)s.refresh_token=r.refresh_token;}}
  console.log(`[token] ✅ Token renovado para ${email} via banco`);
  return r.access_token;
}

// ══════════════════════════════════════════════════════════
//  MULTI-SENDER — Gerenciamento de emails extras de envio
//  Cada usuário pode ter até MAX_SENDER_EMAILS emails (incluindo o principal)
//  Os extras ficam em p.senderEmails[] — nunca substituem o login principal
// ══════════════════════════════════════════════════════════

// Renova token de um email extra (senderEmail)
async function refreshSenderToken(ownerEmail, senderEmail) {
  const p = getUser(ownerEmail);
  const sender = (p?.senderEmails || []).find(s => s.email === senderEmail);
  if (!sender?.refresh_token) throw new Error("Sem refresh_token para " + senderEmail);
  const b = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: sender.refresh_token, grant_type: "refresh_token"
  }).toString();
  const { body: r } = await httpsReq({
    hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(b) }
  }, b);
  if (r.error) { _authEvent(ownerEmail,"refresh_extra_falhou",senderEmail+": "+String(r.error_description||r.error).slice(0,150)); throw new Error(r.error_description || r.error); } // 🔐 v165
  if (!r.access_token) throw new Error("Token não retornado pelo Google.");
  const expiresAt = Date.now() + (r.expires_in || 3600) * 1000;
  // Atualiza token do sender no banco
  // 🚨 v237 (achado de auditoria — Alta, gmail-envio): usava `p.senderEmails`
  // capturado no TOPO da função, ANTES do await de rede acima — qualquer
  // escrita concorrente em senderEmails nessa janela (ex.: outro candidato
  // do MESMO round-robin marcando tokenExpired, ou o admin removendo um
  // extra) seria apagada por esta escrita reusando o array velho. Relê
  // getUser() agora, imediatamente antes de escrever — mesma lição do
  // "nunca guardar snapshot antes de um helper que já lê+grava o mesmo
  // registro, sempre reler depois".
  const senders = (getUser(ownerEmail)?.senderEmails || []).map(s =>
    s.email === senderEmail
      ? { ...s, access_token: r.access_token, token_expiry: expiresAt,
          ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}),
          tokenExpired: false }
      : s
  );
  setUser(ownerEmail, { senderEmails: senders });
  console.log(`[sender] ✅ Token renovado para sender ${senderEmail} de ${ownerEmail}`);
  return r.access_token;
}

// Obtém token válido para envio — tenta principal e extras em round-robin
// requestedSender: email específico pedido (manual), ou null (automático = round-robin)
// allowedSenders: lista de emails que o usuário SELECIONOU para envio (auto).
//   Se fornecida, o rodízio usa SÓ esses; se o principal NÃO está na lista,
//   ele NUNCA é usado (caso da cliente com principal bloqueado pelo Gmail).
async function getSenderToken(ownerEmail, requestedSender, allowedSenders) {
  const p = getUser(ownerEmail);
  const extras = (p?.senderEmails || []).filter(s => s.active !== false);
  const allowed = Array.isArray(allowedSenders) && allowedSenders.length
    ? allowedSenders.map(e=>String(e).toLowerCase().trim())
    : null;

  // ── Envio manual: sender específico pedido pelo usuário ──
  if (requestedSender && requestedSender !== ownerEmail) {
    const s = extras.find(x => x.email === requestedSender);
    if (!s) throw new Error("Email de envio não encontrado ou removido.");
    // 🚨 v230 (achado de auditoria — Média): o round-robin automático (mais
    // abaixo) já filtrava `s.blocked` (conta suspensa pelo Google, 13a3) do
    // seu pool — mas o envio MANUAL com remetente explícito nunca checava:
    // uma conta bloqueada ainda tentava refreshSenderToken, falhava, e caía
    // no catch genérico que troca pro principal EM SILÊNCIO (o usuário via
    // "enviado" sem saber que não saiu pela conta que ele escolheu). Agora
    // recusa na hora, com sentinela própria (mesmo padrão do
    // WARMUP_CAP_REACHED) pro chamador devolver um erro claro e acionável
    // em vez de substituir o remetente sem avisar.
    if (s.blocked) throw new Error("SENDER_BLOCKED");
    // 🚨 v177-FIX5: mesma régua do rodízio — sem plano que dê direito a Gmail
    // extra (downgrade ou plano vencido), o extra não envia. Nada é apagado:
    // é só o teto do plano valendo também na hora do envio manual.
    if (getMaxSenders(p || {}) <= 1) throw new Error(_msgLimiteSenders(getMaxSenders(p || {})));
    // 🛡️ v73: mesma proteção de aquecimento do round-robin, aplicada quando
    // o usuário escolhe ESTA conta específica na tela de envio manual.
    // 🚨 v237n: soma a reserva em voo (ver _warmupReserved acima) ao
    // histórico já persistido — sem isso, 2 requisições concorrentes pro
    // mesmo sender liam a MESMA contagem e as DUAS passavam.
    const _wCap = warmupCapForSender(s.addedAt);
    let _releaseWarmup = null;
    if (_wCap !== null) {
      const _today = todayStr();
      const _wKey = ownerEmail+"|"+s.email;
      const _sentToday = getHist(ownerEmail).filter(h => h.dateStr === _today && h.senderEmail === s.email).length;
      const _wReserved = _warmupReserved.get(_wKey)||0;
      if (_sentToday+_wReserved >= _wCap) throw new Error("WARMUP_CAP_REACHED");
      _warmupReserved.set(_wKey,_wReserved+1);
      _releaseWarmup = _makeWarmupReleaser(_wKey);
      setTimeout(_releaseWarmup, 30_000); // rede de segurança — o chamador libera explícito bem antes disso
    }
    if (s.access_token && s.token_expiry && Date.now() < s.token_expiry - 120_000) {
      return { token: s.access_token, senderEmail: s.email, releaseWarmup: _releaseWarmup };
    }
    try {
      const token = await refreshSenderToken(ownerEmail, s.email);
      return { token, senderEmail: s.email, releaseWarmup: _releaseWarmup };
    } catch(e) {
      // 🔐 v165: só marca RECONECTAR quando o GOOGLE confirmou a queda
      // (invalid_grant/revoked) — erro de rede/timeout NÃO mata a conta
      // (13a2): antes, um soluço de rede carimbava tokenExpired e a pessoa
      // via "RECONECTAR" numa conta perfeitamente saudável.
      const _mE=String(e.message||"");
      if(_mE.includes("invalid_grant")||_mE.includes("revoked")||_mE.includes("invalid_client")){
        // 🚨 v237 (achado de auditoria — Alta): relê getUser() em vez de reusar
        // o `p` capturado no topo de getSenderToken() — evita apagar uma
        // marcação concorrente (ver o mesmo achado no round-robin abaixo).
        setUser(ownerEmail, { senderEmails: (getUser(ownerEmail)?.senderEmails || []).map(x => x.email === s.email ? { ...x, tokenExpired: true } : x) });
        console.warn(`[sender] ⚠️ Token do sender ${s.email} MORTO (${_mE.slice(0,80)}), usando principal`);
      } else {
        console.warn(`[sender] ⚠️ erro passageiro no refresh de ${s.email} (${_mE.slice(0,80)}) — usando principal só neste envio, sem marcar RECONECTAR`);
      }
    }
  }

  // ── Automático: round-robin REAL entre principal + extras ──
  // O email principal entra no pool junto com os extras
  // Alternância baseada em contagem de envios de hoje: menor contagem = próximo
  if (!requestedSender) {
    const hist = getHist(ownerEmail);
    const today = todayStr();
    const countBySender = {};
    for (const h of hist) {
      if (h.dateStr === today && h.senderEmail) {
        countBySender[h.senderEmail] = (countBySender[h.senderEmail] || 0) + 1;
      }
    }

    // Monta pool completo: principal + extras ativos sem erro
    // Principal representado como objeto sintético para uniformidade
    // 🚨 v177-FIX5 (auditoria 14/09/2026): o PLANO manda em quantos e-mails
    // podem enviar (getMaxSenders — grátis 0 · VIP/VIPro 1 · DoublePro 2),
    // mas o rodízio nunca consultava esse teto: depois de um downgrade
    // (DoublePro→VIP) ou do plano vencer, os extras continuavam 100% ativos
    // e a pessoa seguia mandando por 2 Gmails pagando por 1 — a MESMA classe
    // de vazamento de receita do v172i, só que em senders em vez de limites.
    // Corta pelo excedente (ordem de cadastro), nunca apaga nem desativa
    // nada: voltar pro DoublePro devolve o extra na hora, sem reconectar.
    const _maxSnd = getMaxSenders(p || {});
    const extrasOk = extras.filter(s => !s.tokenExpired && !s.blocked).slice(0, Math.max(0, _maxSnd - 1));
    // 🐛 v172e (auditoria, 12/09/2026): countBySender é indexado por
    // hist[].senderEmail, que pro envio do PRINCIPAL grava o Gmail REAL
    // (resolveSendGmail — ver _doAutoSendInner) — nunca a identidade de
    // login (username sem '@' pra conta v172c). Usar "ownerEmail" como
    // chave de contagem do principal deixava countBySender[ownerEmail]
    // sempre 0/undefined pra qualquer conta v172c, quebrando 3 coisas ao
    // mesmo tempo: o rodízio 1-a-1 com extras (linha do sort abaixo), o
    // teto de aquecimento (13a — conta nova nunca era realmente freada) e
    // o teto de 450/dia por sender do admin. countKey é só pra CONTAR —
    // "email"/o retorno pro principal continuam a identidade de sempre
    // (mantém o filtro "allowed" e o contrato de retorno intactos).
    const _principalCountKey = resolveSendGmail(p) || ownerEmail;
    let pool = [
      { email: ownerEmail, countKey: _principalCountKey, isPrincipal: true, addedAt: p?.gmailConnectedAt || p?.created_at },  // email principal sempre no pool (🌱 v195 LOTE 13: relógio = conexão do Gmail, não o cadastro)
      ...extrasOk.map(s => ({ ...s, countKey: s.email, isPrincipal: false }))
    ];
    // Seleção do usuário: só os e-mails escolhidos participam do rodízio
    if (allowed) pool = pool.filter(c => allowed.includes(String(c.email).toLowerCase()));
    if (!pool.length) throw new Error("Nenhum dos e-mails selecionados está disponível para envio. Reconecte-os no Perfil → Gmail Extra.");

    // ── 🛡️ v73/v76: AQUECIMENTO — conta Gmail recém-conectada manda pouco
    // nos primeiros dias (proteção real contra o Google marcar como bot; ver
    // warmupCapForSender). Cada conta tem seu PRÓPRIO relógio (addedAt).
    // Se sobrar pelo menos 1 conta dentro do limite de hoje, PREFERE essas
    // (fica menos exposta) — mas v76 (ordem do dono, 27/07: "eu quero que
    // nunca pare o automático") tirou o STOP: se TODAS as contas já bateram
    // o teto de hoje, o robô não pausa mais esperando amanhã — usa a MENOS
    // carregada mesmo assim e continua no intervalo humanizado normal. O
    // intervalo (5-6min) já é a proteção real contra rajada repentina; o
    // teto por conta virou só uma preferência de rodízio, não um bloqueio.
    const withinWarmup = pool.filter(c => {
      const cap = warmupCapForSender(c.addedAt);
      return cap === null || (countBySender[c.countKey] || 0) < cap;
    });
    if (withinWarmup.length) pool = withinWarmup;
    // else: mantém o pool inteiro (nenhuma conta some da fila por aquecimento)

    // 🎯 ordem do dono, 12/09/2026: automático do ADMIN escolhe o remetente
    // ALEATORIAMENTE entre os elegíveis (nunca o round-robin determinístico
    // de sempre — só pra admin; usuário comum, no máx 2 e-mails, continua
    // no round-robin de menor contagem, inalterado). Prefere quem ainda
    // está dentro do próprio teto de 450/dia (perSenderAutoLimit) — mesma
    // filosofia do aquecimento: nunca esvazia o pool, só prefere.
    if (isAdminVip(p)) {
      const withinDaily = pool.filter(c => (countBySender[c.countKey] || 0) < perSenderAutoLimit(p, c.countKey));
      if (withinDaily.length) pool = withinDaily;
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    } else {
      // Ordena por menor contagem hoje → alterna naturalmente 1,2,1,2...
      pool.sort((a, b) => (countBySender[a.countKey] || 0) - (countBySender[b.countKey] || 0));
    }

    for (const candidate of pool) {
      if (candidate.isPrincipal) {
        // Email principal: token vem da sessão/cache/refresh_token (tratado no fluxo principal)
        return { token: null, senderEmail: ownerEmail };
      }
      // Extra: usa token cacheado ou renova
      if (candidate.access_token && candidate.token_expiry && Date.now() < candidate.token_expiry - 120_000) {
        console.log(`[sender] 🔄 Round-robin → ${candidate.email} (${countBySender[candidate.countKey]||0} hoje)`);
        return { token: candidate.access_token, senderEmail: candidate.email };
      }
      try {
        const token = await refreshSenderToken(ownerEmail, candidate.email);
        console.log(`[sender] 🔄 Round-robin → ${candidate.email} (token renovado)`);
        return { token, senderEmail: candidate.email };
      } catch(e) {
        // 🔐 v165: mesma regra do manual — RECONECTAR só com queda CONFIRMADA
        // pelo Google; erro passageiro pula a conta SÓ neste ciclo (13a2).
        const _mE=String(e.message||"");
        if(_mE.includes("invalid_grant")||_mE.includes("revoked")||_mE.includes("invalid_client")){
          // 🚨 v237 (achado de auditoria — Alta, gmail-envio): usava `p`
          // capturado no TOPO de getSenderToken() — quando 2+ candidatos do
          // MESMO round-robin falham em sequência, a 2ª escrita reusava o
          // array de ANTES da 1ª falha e apagava o tokenExpired que a 1ª
          // tinha acabado de gravar (só o ÚLTIMO que falhou ficava marcado
          // de verdade; o(s) anterior(es) voltavam a aparecer saudáveis na
          // tela, e o robô tentava enviar por eles de novo no PRÓXIMO
          // ciclo). Relê getUser() a cada escrita — nunca reusa snapshot.
          setUser(ownerEmail, { senderEmails: (getUser(ownerEmail)?.senderEmails || []).map(x => x.email === candidate.email ? { ...x, tokenExpired: true } : x) });
          console.warn(`[sender] ⚠️ Sender ${candidate.email} com token MORTO (${_mE.slice(0,80)}), pulando`);
        } else {
          console.warn(`[sender] ⚠️ erro passageiro no refresh de ${candidate.email} (${_mE.slice(0,80)}) — pulando só neste ciclo, sem marcar RECONECTAR`);
        }
        // continua para próximo candidato
      }
    }
  }

  // ── Fallback final: email principal — SÓ se o usuário não o excluiu da seleção ──
  if (allowed && !allowed.includes(String(ownerEmail).toLowerCase())) {
    throw new Error("Os e-mails selecionados para envio estão indisponíveis (token expirado/bloqueado). O principal não foi usado porque você o excluiu da seleção.");
  }
  return { token: null, senderEmail: ownerEmail };
}


function buildMime(opts){ return _buildMimeMod(opts); } // corpo em src/gmail.js (Fase 1 · Módulo 2)

// 🔒 v172 (ORDEM DO DONO, 11/09/2026): desde que login parou de trazer um
// access_token gmail.send-capaz (é só identidade agora), a sessão CHEGA aqui
// sem access_token no caso comum (usuário conectou o Gmail em ALGUM momento
// via /oauth/connect-send, e a sessão atual é de um relogin posterior que
// não repassou o token, ou de outro aparelho). O código ANTIGO só tentava
// refreshToken(sid) quando JÁ HAVIA um access_token perto de expirar — sem
// nenhum, batia direto em "Sessão expirada." mesmo com um refresh_token
// perfeitamente válido no banco (getUser().refresh_token), porque
// refreshToken() nunca era chamado. Agora tenta refresh SEMPRE que falta
// (ou está vencendo) — refreshToken() já sabe cair pro refresh_token
// persistido (ver função refreshToken acima) mesmo sem um na sessão.
async function _ensureSendToken(sid){
  const s=sessions[sid];
  if(!s)throw new Error("Sessão expirada.");
  const stale=!s.access_token||(s.expires_at&&Date.now()>s.expires_at-120_000);
  if(stale){
    try{await refreshToken(sid);}
    catch(e){
      if(!s.access_token)throw new Error("Conecte seu Gmail pra enviar candidaturas (Automático ou Manual → Conectar Gmail).");
    }
  }
  if(!s.access_token)throw new Error("Conecte seu Gmail pra enviar candidaturas (Automático ou Manual → Conectar Gmail).");
  return s;
}
// 🐛 v172c: fromEmail do sender PRINCIPAL não pode mais ser s.user_email cru
// — pra conta nova (login usuário+senha) isso é o USERNAME, não um Gmail de
// verdade, e vazava um "From:" inválido pro Gmail (a API "me" até manda pela
// conta certa, mas o cabeçalho From malformado é outra história). O Gmail
// REAL conectado (gmailEmail, ver resolveSendGmail) tem prioridade;
// s.user_email só sobra como fallback pra conta LEGADA, onde ele já É o Gmail.
async function gmailSend(sid,opts){const s=await _ensureSendToken(sid);const owner=getUser(s.user_email);const raw=buildMime({...opts,fromEmail:resolveSendGmail(owner)||s.user_email});const{status,body}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+s.access_token,"Content-Type":"application/json"}},{raw});if(body?.error){const msg=body.error.message||JSON.stringify(body.error);throw new Error(msg);}if(status!==200)throw new Error("Gmail HTTP "+status);return body;}

// Envio com suporte a threading (respostas na mesma conversa)
async function gmailSendWithThread(sid,opts){
  const s=await _ensureSendToken(sid);
  const owner=getUser(s.user_email);
  const raw=buildMimeWithHeaders({...opts,fromEmail:resolveSendGmail(owner)||s.user_email});
  const payload={raw};
  // threadId vincula a mensagem ao thread correto no Gmail
  if(opts.threadId)payload.threadId=opts.threadId;
  const{status,body}=await httpsReq({
    hostname:"gmail.googleapis.com",
    path:"/gmail/v1/users/me/messages/send",
    method:"POST",
    headers:{"Authorization":"Bearer "+s.access_token,"Content-Type":"application/json"}
  },payload);
  if(body?.error){const msg=body.error.message||JSON.stringify(body.error);throw new Error(msg);}
  if(status!==200)throw new Error("Gmail HTTP "+status);
  return body;
}

// buildMime com suporte a cabeçalhos customizados (In-Reply-To, References)
function buildMimeWithHeaders({to,subject,text,fromName,fromEmail,attachments=[],threadHeaders={}}){
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");
  const b64=s=>Buffer.from(s).toString("base64");
  const L=[
    `From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,
    `To: ${to}`
  ];
  L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`);
  // Cabeçalhos de threading — v18-SEC: In-Reply-To/References vêm de
  // d.messageId/d.threadId enviados pelo CLIENTE (não validados contra o
  // índice real de threads do usuário); sem sanitizar, um valor com \r\n
  // injetaria cabeçalhos MIME arbitrários na mensagem enviada pelo Gmail
  // do próprio usuário. Mesmo tratamento para nome de anexo, abaixo.
  if(threadHeaders["In-Reply-To"])L.push(`In-Reply-To: ${sanitizeHeaderField(threadHeaders["In-Reply-To"],300)}`);
  if(threadHeaders["References"])L.push(`References: ${sanitizeHeaderField(threadHeaders["References"],300)}`);
  L.push("MIME-Version: 1.0");
  if(!attachments.length){
    L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);
  }else{
    L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");
    for(const a of attachments){const aMime=a.mime||"application/octet-stream";const aName=sanitizeHeaderField(a.name);L.push(`--${bnd}`,`Content-Type: ${aMime}; name="${aName}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${aName}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}
    L.push(`--${bnd}--`);
  }
  return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

// ── Gmail Inbox: busca e-mails recebidos ──────────────────
async function gmailGetToken(sid){
  const s=sessions[sid];
  // FIX: se não há access_token na sessão, tenta usar o token cacheado no banco ou renova via refresh_token
  if(!s?.access_token){
    const email=s?.user_email;
    if(email){
      const u=getUser(email);
      // Usa token cacheado no banco se ainda válido (com 2min de margem)
      if(u?.cached_access_token && u.cached_token_expiry && Date.now()<u.cached_token_expiry-120_000){
        if(s) s.access_token=u.cached_access_token;
        if(s) s.expires_at=u.cached_token_expiry;
        return u.cached_access_token;
      }
      // Tenta renovar via refresh_token do banco
      if(u?.refresh_token){
        try{
          const token=await refreshTokenForUser(email);
          if(s){s.access_token=token;s.expires_at=Date.now()+3500_000;}
          return token;
        }catch(re){throw new Error("Sessão expirada — faça login novamente. ("+re.message+")");}
      }
    }
    throw new Error("Sessão expirada.");
  }
  if(s.expires_at&&Date.now()>s.expires_at-120_000){try{await refreshToken(sid);}catch{}}
  return s.access_token;
}

// v22 (ORDEM DO DONO): genCover/"IA gera" removidos — era um template FIXO
// disfarçado de IA escrevendo a candidatura pelo usuário. Texto é do usuário.

// ══════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════

// ── Todo mundo que conta como "administrador" no sistema: o Set fixo
// (ADMIN_EMAILS) + qualquer usuário com isAdmin:true no cadastro. ──────────




function _saveEnrichedSheet(sheetKey, sheet){
  // v179: as linhas em memória JÁ mudaram — o índice dos filtros e o palheiro
  // da busca precisam saber disso mesmo que a gravação em disco falhe depois.
  _bumpSheetVersion(sheet);
  _hayEpoca++;
  try{
    // 🔒 Checagem leve de integridade (não bloqueia salvamento — o bot de
    // enriquecimento só EDITA campos das linhas já existentes, não deveria
    // nunca introduzir duplicata; se acontecer, só avisa no log pra
    // investigar, já que abortar aqui perderia o progresso do enriquecimento).
    const _chk = _vagasVerify(sheet, {caseField:'c'});
    if(!_chk.ok){
      _enrichLog(`⚠️ Integridade: ${_chk.duplicateCases.length} case number(s) duplicado(s) detectado(s) em "${sheetKey}" — investigar (não deveria acontecer no bot de enriquecimento).`, "warn");
    }
    // Salva SEMPRE em /data/ (disco persistente — sobrevive a deploys)
    // E também em __dirname para leitura imediata sem precisar recarregar
    const dataPath = path.join(DATA_DIR, sheetKey==="jan2026"?"jan2026_compact.json":"jul2025_compact.json");
    const srcPath  = path.join(__dirname, sheetKey==="jan2026"?"jan2026_compact.json":"jul2025_compact.json");
    const payload  = JSON.stringify(sheet);

    // v48: TODAS as gravações atômicas (tmp+rename) — gravação direta
    // interrompida por deploy/OOM/disco cheio truncava o arquivo em /data e
    // a planilha "sumia" em todos os boots seguintes (bug real 25/07).
    // v49: no npm test (TEST_LOGIN_TOKEN setado — NUNCA existe em produção) o
    // dual-write pra pasta do código é PULADO: o smoke roda o servidor dentro
    // do próprio repositório e o robô H-2A gravaria vagas FALSAS de teste por
    // cima do arquivo bundled versionado no git.
    const _skipSrcWrite = !!process.env.TEST_LOGIN_TOKEN;
    let _gravou=false;
    if(sheetKey==="jan2026"||sheetKey==="jul2025"){
      // Salva no disco persistente (/data/) — não é sobrescrito no deploy
      _writeFileAtomic(dataPath, payload);
      // Salva também na pasta do código (para leitura imediata neste boot)
      if(!_skipSrcWrite){try{_writeFileAtomic(srcPath, payload);}catch{}}
      _enrichLog(`💾 Salvo em /data/ e código: ${sheet.length} vagas`, "ok");
      _gravou=true;
    } else if(sheetKey==="h2a-jun2026"||sheetKey==="h2a"){
      // v24-FIX: a H-2A é built-in como jan/jul mas este save NÃO tinha o ramo
      // dela — qualquer atualização (frescor/enriquecimento) era descartada em
      // silêncio. Mesmo dual-write das outras built-ins.
      _writeFileAtomic(path.join(DATA_DIR,"h2a_jun2026_compact.json"), payload);
      if(!_skipSrcWrite){try{_writeFileAtomic(path.join(__dirname,"h2a_jun2026_compact.json"), payload);}catch{}}
      _enrichLog(`💾 H-2A salva em /data/ e código: ${sheet.length} vagas`, "ok");
      _gravou=true;
    } else if(SHEET_EXTRAS[sheetKey]){
      const meta = DB_SHEETS_META[sheetKey];
      const fp = path.join(SHEETS_DIR, meta?.file||`${sheetKey}.json`);
      _writeFileAtomic(fp, payload); // extras já ficam em /data/sheets/
      _gravou=true;
    }
    // 🚨 v177-FIX2 (auditoria 14/09/2026): savedAt era carimbado incondicional,
    // mesmo quando NENHUM dos 3 ramos batia (ex.: planilha extra apagada
    // enquanto o bot de enriquecimento ainda rodava nela — SHEET_EXTRAS[key]
    // já não existe mais) — o painel mostrava "salvo" pra um save que não
    // gravou NADA em disco, e ninguém via log de erro nenhum.
    if(_gravou)_enrichBot.savedAt = Date.now();
    else _enrichLog(`⚠️ "${sheetKey}" não bate com nenhum destino de gravação conhecido (planilha apagada?) — nada foi salvo.`, "warn");
  }catch(e){ _enrichLog(`❌ Erro ao salvar: ${e.message}`,"error"); }
}

// ═══ 📋 v174 — ALIMENTAÇÃO AUTOMÁTICA DAS PLANILHAS (ordem do dono, 13/09/2026:
// "as planilhas devem ser alimentadas, igual elas já são hoje, com todas as
// informações de cada vaga — esse sistema você pode trazer do h2bapply.com
// antigo"). Os 5 robôs moram em mod-planilhas.js (injeção por getters — as
// planilhas em memória são REATRIBUÍDAS no loadSheets, então o módulo nunca
// pode guardar referência direta). Aqui só a ligação e as rotas do painel.
const { createPlanilhas: _createPlanilhas, progressoPlanilha: _progressoPlanilha } = require("./mod-planilhas.js");
const PLANILHAS = _createPlanilhas({
  fs, path, DATA_DIR, SHEETS_DIR, SHEETS_META_FILE,
  getSheet, getSheetH2A: () => SHEET_H2A, setSheetH2A: (arr) => { SHEET_H2A = arr; },
  getExtras: () => SHEET_EXTRAS, getMeta: () => DB_SHEETS_META,
  enrichBot: _enrichBot, enrichLog: _enrichLog, saveSheet: _saveEnrichedSheet,
  httpsReq, botLog, pushToUser, ADMIN_EMAILS, detectCategory, limparCidade,
  dedupe: _vagasDedupe, verify: _vagasVerify, manifest: _vagasManifest,
  // 📡 v189 LOTE 7: o nome diz o que a função faz — CONTA vaga nova que
  // combina com o filtro salvo. Não notifica ninguém (não há canal).
  registrarVagasNovasNoRadar,
  isTest: !!process.env.TEST_LOGIN_TOKEN,
});

// ═══ 📧 v175 — E-MAILS DO SISTEMA + CÓDIGOS (ordem do dono, 13/09/2026):
// a conta SuporteH2bapply@gmail.com (conectada pelo admin em Admin →
// Notificações) envia o código de confirmação do cadastro, o código de
// recuperação de senha e o aviso de pedido novo pro Andrio e pro Diego.
// Nunca lê caixa de entrada (só gmail.send). Detalhes em mod-notif.js.
const { createNotif: _createNotif } = require("./mod-notif.js");
const NOTIF = _createNotif({
  fs, path, DATA_DIR, httpsReq, buildMime: (o) => buildMime(o), encStr, decStr,
  getClientId: () => CLIENT_ID, getClientSecret: () => CLIENT_SECRET,
  isTest: !!process.env.TEST_LOGIN_TOKEN,
  hmacSecret: process.env.DATA_ENC_KEY || crypto.randomBytes(32).toString("hex"),
  appUrl: APP_URL,
});
// O e-mail cadastrado É o Gmail que vai enviar as candidaturas (manual e
// automático) — por isso só aceita Gmail.
const _isGmail = (e) => /^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/.test(String(e || "").trim().toLowerCase());
function _findUserByEmail(email) {
  const e = String(email || "").trim().toLowerCase(); if (!e.includes("@")) return null;
  for (const u of Object.values(DB_USERS)) { if (!u || u.deleted) continue; if (String(u.emailContato || "").toLowerCase() === e || String(u.email || "").toLowerCase() === e) return u; }
  return null;
}
// Data de nascimento: aceita AAAA-MM-DD (input date) ou DD/MM/AAAA (digitado);
// devolve ISO ou null se não for uma data real de alguém entre 16 e 100 anos.
function _parseNasc(v) {
  const t = String(v || "").trim(); let y, m, d;
  let mm = t.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else { mm = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (!mm) return null; d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const idade = (Date.now() - dt.getTime()) / (365.25 * 86400_000); if (idade < 16 || idade > 100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// Quem recebe o aviso de compra pela conta de notificações: os 2 SÓCIOS
// (ADMIN_EMAIL = dono, ADMIN_EMAIL_2 = Diego) — ordem do dono, 13/09/2026
// ("de compras para mim e pro Diego"). Contas admin auxiliares não recebem.
const _notifDestinatarios = () => [...new Set([ADMIN_EMAIL, ADMIN_EMAIL_2].filter(e => e && e.includes("@")))];
// 🚨 v177-FIX2 (auditoria 14/09/2026): ADMIN_EMAIL_2 vazio/malformado no
// Render passava batido em silêncio — o aviso de compra ia só pro Andrio,
// sem NENHUM alerta de que faltava configurar o e-mail do Diego. Checagem
// de sanidade só no boot (não a cada pedido).
if (_notifDestinatarios().length < 2) {
  console.error(`[boot] ⚠️ ATENÇÃO: só ${_notifDestinatarios().length} destinatário(s) de aviso de compra configurado(s) (esperado: 2 sócios — Andrio + Diego). Confira ADMIN_EMAIL/ADMIN_EMAIL_2 no ambiente.`);
}
// Mensagem do aviso de pedido novo aos admins — fonte ÚNICA (conta de
// notificações OU caminho legado pelo Gmail do admin).
function _mensagemPedidoAdmin(pedido) {
  const _pagoEmStr = pedido.pagoEm ? new Date(pedido.pagoEm).toLocaleDateString("pt-BR") : "Não informada";
  const _realGmailForMail = resolveSendGmail(getUser(pedido.userEmail));
  // v192 LOTE 10: os bytes do comprovante vêm do disco (leitura sob demanda),
  // não da memória — o anexo do aviso aos sócios continua idêntico.
  const _compB64 = loadComprovante(pedido);
  // 🎬 v237v: aviso da conta de TESTE fica CLARÍSSIMO no assunto/corpo —
  // nunca parece uma venda real (ver requisito de isolamento financeiro).
  const _testeTag = pedido.isTeste ? "[TESTE] " : "";
  const subject = `${_testeTag}💳 Novo pedido de plano — ${pedido.userName || pedido.userEmail} quer ${pedido.plano} por ${pedido.dias}d`;
  const text = `${pedido.isTeste ? "🎬 ESTE PEDIDO É DE TESTE (conta de demonstração) — NÃO é uma venda real, não entra em nenhum relatório financeiro.\n\n" : ""}💳 NOVO PEDIDO DE PLANO RECEBIDO!

👤 Usuário: ${pedido.userName || "?"}
🪪 Usuário (login): ${pedido.userEmail || "?"}
📧 Gmail conectado: ${_realGmailForMail || "(ainda não conectou Gmail de envio)"}
📱 WhatsApp: ${pedido.userWhatsapp || "?"}
🏙️ Cidade: ${pedido.userCity || "?"}

📦 Plano: ${nomePlanoDisplay(pedido.plano)} — ${pedido.dias} dias — R$${pedido.valorTotal}${pedido.desconto > 0 ? " (" + pedido.desconto + "% desconto)" : ""}
💰 Data de pagamento informada pelo cliente: ${_pagoEmStr}   ⬅️ CONFIRA se bate com o comprovante
📝 Nota: ${pedido.nota || "Sem observação"}
🆔 Pedido: #${pedido.id.slice(-8).toUpperCase()}
⏰ Recebido no sistema: ${new Date().toLocaleString("pt-BR")}
${_compB64 ? "📸 Comprovante: ANEXADO a este email" : "⚠️ Comprovante: NÃO enviado ainda"}

✅ Para ativar: ${APP_URL}/admin → Pedidos Pendentes → Aprovar
${pedido.criadoPor && pedido.criadoPor !== pedido.userEmail ? `\n🛠️ Registrado retroativamente por admin: ${pedido.criadoPor}` : ""}

— Sistema H2BApply`;
  // Anexo do comprovante (aceita base64 PURO — formato real salvo — ou data URL)
  let attachments = [];
  if (_compB64) {
    try {
      let mimeType, base64Data;
      const m = _compB64.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mimeType = m[1]; base64Data = m[2]; } else { mimeType = pedido.comprovanteType || "image/jpeg"; base64Data = _compB64; }
      const ext = mimeType.includes("pdf") ? "pdf" : mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
      if (base64Data && base64Data.length > 40) attachments = [{ name: `comprovante_${pedido.id.slice(-8).toUpperCase()}.${ext}`, data: base64Data, mime: mimeType }];
    } catch (e) { console.warn("[pedido] erro processando comprovante:", e.message); }
  }
  return { subject, text, attachments };
}


// 🔑 Usernames reservados que nascem admin (ordem do dono, 12/09/2026).
// Fonte ÚNICA — usada tanto no /api/cadastro (grant IMEDIATO, no instante
// da criação, sem depender de nenhum restart do servidor) quanto na
// migração de boot mais abaixo (rede de segurança pra conta que já
// existia de antes desta lista, ou que nasceu bem no meio de um deploy).
// 🚨 RISCO DE SEGURANÇA aceito pelo dono: /api/cadastro é público —
// QUALQUER visitante pode tentar registrar um desses usernames antes da
// pessoa de verdade (username não tem dono reservado, primeiro que
// cadastra leva o admin). Nunca adicionar um nome aqui sem avisar o dono
// desse risco de novo.
const ADMIN_RESERVED_USERNAMES = new Set(["andrio","andrew","diego"]);

const server=http.createServer(async(req,res)=>{
  res._req=req; // V951: permite ao helper json() negociar gzip sem mudar 400+ call sites
  let u,pathname;try{u=new URL(req.url,"http://x");pathname=u.pathname;}catch{res.writeHead(400);return res.end();}
  res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Content-Security-Policy",[
    "default-src 'self'",
    // v34-GA: googletagmanager liberado — o funil inteiro tinha gaEvent()
    // instrumentado mas a CSP bloqueava o script do Analytics em silêncio.
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net https://unpkg.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://oauth2.googleapis.com https://gmail.googleapis.com https://fcm.googleapis.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  // v18-SEC: regex de localhost tinha limite solto — "http://localhost.evil.com"
  // também passava (sem \b/porta delimitando o fim do host). Agora exige que
  // depois de "localhost" venha só ":porta" ou fim da string.
  const org=req.headers.origin||"";const ao=(org===APP_URL||/^https?:\/\/localhost(:\d+)?$/.test(org))?org:APP_URL;
  res.setHeader("Access-Control-Allow-Origin",ao);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,PATCH,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}

  const serveHtml=f=>sendAsset(req,res,f,"text/html; charset=utf-8","no-cache"); // V951: brotli/gzip + ETag
  // v40 (reclamação real do dono, 22/07): os ícones Tabler vinham de CDN
  // (jsdelivr/unpkg) que MUITAS redes móveis brasileiras bloqueiam — app
  // inteiro ficava sem ícone ("tudo feio"). Fonte agora é BUILT-IN, servida
  // pelo próprio site (regra KB-048: o que não pode faltar mora no repo).
  if(pathname==="/vendor/tabler-icons.min.css")return sendAsset(req,res,"tabler-icons.min.css","text/css; charset=utf-8","public, max-age=31536000, immutable");
  if(pathname==="/vendor/fonts/tabler-icons.woff2")return sendAsset(req,res,"tabler-icons.woff2","font/woff2","public, max-age=31536000, immutable");
  if(pathname==="/"||pathname==="/index.html")return serveHtml("index.html");
  // v34-SEO: páginas privadas NUNCA entram no Google — o robots.txt só pede
  // pra não rastrear; o X-Robots-Tag (+ meta noindex no HTML) proíbe indexar
  // mesmo se alguém linkar a URL por fora.
  if(pathname==="/admin"||pathname==="/admin.html"){res.setHeader("X-Robots-Tag","noindex, nofollow");return serveHtml("admin.html");}
  if(pathname==="/guia"||pathname==="/guia.html")return serveHtml("guia.html");
  // v85: guia de COMO USAR o app (passo a passo com prints reais de cada tela)
  // — separado do /guia (que explica o VISTO). Acesso pelo atalho da Home e
  // pelo menu; página própria pra poder compartilhar por link/WhatsApp.
  if(pathname==="/como-usar"||pathname==="/como-usar.html")return serveHtml("como-usar.html");
  // 📖 v160 — conteúdo da Central de Tutoriais: fragmento HTML carregado sob
  // demanda pela aba Tutorial (o index fica ~33KB mais leve; o conteúdo só
  // desce quando a pessoa abre a aba).
  if(pathname==="/tutorial-conteudo")return serveHtml("tutorial-conteudo.html");
  // 📖 v160 — prints da Central de Tutoriais (aba Tutorial do app): arquivos
  // reais em /tutorial-img (nunca base64 no HTML — 29 fotos embutidas
  // deixariam o index com muitos MB; assim carregam lazy, só ao abrir cada
  // passo a passo). Nome SANITIZADO (só [a-z0-9-]. jpg/png) — nunca traversal.
  if(pathname.startsWith("/tut-img/")){
    const nome=pathname.slice("/tut-img/".length);
    if(!/^[a-z0-9-]+\.(jpg|png)$/.test(nome)){res.writeHead(404);return res.end();}
    // JPEG/PNG já são comprimidos — servir direto (sem o cache br/gz do
    // sendAsset, que triplicaria a memória com 30+ fotos sem ganho nenhum).
    try{const img=fs.readFileSync(path.join(__dirname,"tutorial-img",nome));res.writeHead(200,{"Content-Type":nome.endsWith(".png")?"image/png":"image/jpeg","Cache-Control":"public, max-age=604800"});return res.end(img);}catch{res.writeHead(404);return res.end();}
  }
  // 🖼️ Fotos reais de marca (hero da Home, sidebar, landing, Enviadas —
  // pedido do dono, print de referência). Mesmo padrão do /tut-img: nome
  // SANITIZADO (só [a-z0-9-].jpg), nunca traversal.
  if(pathname.startsWith("/img/")){
    const nomeImg=pathname.slice("/img/".length);
    if(!/^[a-z0-9-]+\.jpg$/.test(nomeImg)){res.writeHead(404);return res.end();}
    try{const img=fs.readFileSync(path.join(__dirname,"img",nomeImg));res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"public, max-age=604800"});return res.end(img);}catch{res.writeHead(404);return res.end();}
  }
  if(pathname==="/h2bapply-funciona"||pathname==="/h2bapply-funciona.html")return serveHtml("h2bapply-funciona.html"); // SEO: página "H2BApply funciona?" (como funciona, confiança, preços, FAQ)
  if(pathname==="/h2b-e-golpe"||pathname==="/h2b-e-golpe.html")return serveHtml("h2b-e-golpe.html"); // SEO/confiança: página "H2B é golpe?" — golpes comuns, regra federal anti-taxa-de-recrutamento, como verificar vaga real
  if(pathname==="/quanto-ganha-h2b"||pathname==="/quanto-ganha-h2b.html")return serveHtml("quanto-ganha-h2b.html"); // SEO: página "quanto ganha quem trabalha H2B/H2A" — médias reais calculadas ao vivo via /api/public-wage-stats
  // SEO programático por estado: /vagas-h2b/texas, /vagas-h2b/florida, etc. — gerado
  // no servidor com números reais (nunca arquivo estático). Estados com poucas vagas
  // (< MIN_JOBS_FOR_STATE_PAGE) não têm página própria pra evitar "thin content";
  // caem de volta pro hub de salários.
  if(pathname==="/vagas-h2b"||pathname==="/vagas-h2b/"){res.writeHead(302,{"Location":"/quanto-ganha-h2b"});return res.end();}
  // v18-SEO: SEO programático por CATEGORIA: /vagas-h2b/categoria/landscape, etc.
  // Checado ANTES da rota genérica por estado abaixo, senão "/vagas-h2b/categoria"
  // seria lido como se "categoria" fosse o slug de um estado.
  if(pathname==="/vagas-h2b/categoria"||pathname==="/vagas-h2b/categoria/"){res.writeHead(302,{"Location":"/quanto-ganha-h2b"});return res.end();}
  if(pathname.startsWith("/vagas-h2b/categoria/")){
    const catKey=pathname.slice("/vagas-h2b/categoria/".length).replace(/\/$/,"").toLowerCase();
    try{
      const{byCategoryAll,topStatesByCategory,overall}=computeWageStats();
      const entry=byCategoryAll.find(c=>c.key===catKey);
      if(!entry||entry.count<MIN_JOBS_FOR_CATEGORY_PAGE){res.writeHead(302,{"Location":"/quanto-ganha-h2b"});return res.end();}
      const topStates=topStatesByCategory.get(entry.key)||[];
      const html=renderCategoryPage(entry,topStates,overall.count);
      return sendHtmlCompressed(req,res,html,"public, max-age=1800");
    }catch(e){
      console.warn("[vagas-h2b/categoria] erro:",e.message);
      res.writeHead(302,{"Location":"/quanto-ganha-h2b"});return res.end();
    }
  }
  if(pathname.startsWith("/vagas-h2b/")){
    const slug=pathname.slice("/vagas-h2b/".length).replace(/\/$/,"").toLowerCase();
    try{
      const{byStateAll,topCategoriesByState,overall}=computeWageStats();
      const entry=byStateAll.find(s=>s.slug===slug);
      if(!entry||entry.count<MIN_JOBS_FOR_STATE_PAGE){res.writeHead(302,{"Location":"/quanto-ganha-h2b"});return res.end();}
      const topCats=topCategoriesByState.get(entry.key)||[];
      const html=renderStatePage(entry,topCats,overall.count);
      return sendHtmlCompressed(req,res,html,"public, max-age=1800");
    }catch(e){
      console.warn("[vagas-h2b/state] erro:",e.message);
      res.writeHead(302,{"Location":"/quanto-ganha-h2b"});return res.end();
    }
  }
  if(pathname==="/diagnostico"||pathname==="/diagnostico.html"){res.setHeader("X-Robots-Tag","noindex, nofollow");return serveHtml("diagnostico.html");}
  if(pathname==="/admin-reviews"||pathname==="/admin-reviews.html"){res.setHeader("X-Robots-Tag","noindex, nofollow");return serveHtml("admin-reviews.html");} // Moderação de avaliações reais (protegido via checagem de admin nas próprias rotas /api/admin/reviews*)

  // ── SEO: robots.txt + sitemap.xml (KB-SEO-01: site não tinha nenhum dos dois,
  // dificultando indexação/descoberta pelo Google) ──────────────────────────
  if(pathname==="/robots.txt"){
    res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"public, max-age=3600"});
    return res.end("User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin-reviews\nDisallow: /ad\nDisallow: /api/\nDisallow: /diagnostico\n\nSitemap: https://h2bapply.com/sitemap.xml\n");
  }
  if(pathname==="/sitemap.xml"){
    const _pages=[
      {loc:"https://h2bapply.com/",priority:"1.0",changefreq:"daily"},
      {loc:"https://h2bapply.com/guia",priority:"0.9",changefreq:"weekly"},
      {loc:"https://h2bapply.com/h2bapply-funciona",priority:"0.8",changefreq:"weekly"},
      {loc:"https://h2bapply.com/h2b-e-golpe",priority:"0.8",changefreq:"weekly"},
      {loc:"https://h2bapply.com/quanto-ganha-h2b",priority:"0.8",changefreq:"weekly"},
    ];
    // SEO programático: inclui só os estados com vagas suficientes pra ter página própria
    // (mesmo corte de MIN_JOBS_FOR_STATE_PAGE usado na rota /vagas-h2b/:estado).
    try{
      const{byStateAll,byCategoryAll}=computeWageStats();
      byStateAll.filter(s=>s.count>=MIN_JOBS_FOR_STATE_PAGE).forEach(s=>{
        _pages.push({loc:`https://h2bapply.com/vagas-h2b/${s.slug}`,priority:"0.7",changefreq:"weekly"});
      });
      // v18-SEO: páginas por categoria (mesmo corte de MIN_JOBS_FOR_CATEGORY_PAGE
      // usado na rota /vagas-h2b/categoria/:categoria).
      byCategoryAll.filter(c=>c.count>=MIN_JOBS_FOR_CATEGORY_PAGE).forEach(c=>{
        _pages.push({loc:`https://h2bapply.com/vagas-h2b/categoria/${c.key}`,priority:"0.7",changefreq:"weekly"});
      });
    }catch(e){console.warn("[sitemap] erro ao listar páginas de estado/categoria:",e.message);}
    // v18-SEO: <lastmod> ajuda o Google a saber que a página foi atualizada
    // recentemente (o sitemap não tinha nenhuma data — usa a data do boot,
    // já que o conteúdo destas páginas é recalculado a cada deploy/boot).
    const _lastmod=new Date().toISOString().slice(0,10);
    const _urls=_pages.map(p=>`  <url>\n    <loc>${p.loc}</loc>\n    <lastmod>${_lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`).join("\n");
    const _xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${_urls}\n</urlset>\n`;
    res.writeHead(200,{"Content-Type":"application/xml; charset=utf-8","Cache-Control":"public, max-age=3600"});
    return res.end(_xml);
  }

  // ── /ad — painel admin protegido ──────────────────────────
  // Só emails admin podem acessar. Qualquer outro usuário recebe
  // uma tela de acesso negado sem revelar que existe um painel.
  if(pathname==="/ad"||pathname==="/ad.html"){
    // Verificar sessão do usuário atual
    const adSess = getSess(req);
    if(!adSess?.user_email){
      // Não logado — redirecionar para login com next=/ad
      res.writeHead(302,{"Location":"/?next=ad"});
      return res.end();
    }
    const adUser = getUser(adSess.user_email);
    if(!isAdminEmail(_sessAdminEmail(adSess)) && !isAdminVip(adUser)){
      // Logado mas não é admin — tela de erro
      const errorPage = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Acesso Negado — H2BApply</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#020617;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;padding:20px}
    .card{background:#0f172a;border:1.5px solid rgba(239,68,68,.3);border-radius:20px;padding:40px 32px;max-width:420px;width:100%;text-align:center}
    .icon{font-size:64px;margin-bottom:20px}
    .title{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}
    .sub{font-size:14px;color:#94a3b8;line-height:1.6;margin-bottom:24px}
    .badge{display:inline-block;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;color:#ef4444;margin-bottom:24px}
    .btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px}
    .email{font-size:11px;color:#475569;margin-top:20px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <div class="badge">⛔ ACESSO RESTRITO</div>
    <div class="title">Área exclusiva</div>
    <div class="sub">
      Esta área é exclusiva para <strong style="color:#fff">funcionários da plataforma H2BApply</strong>.<br><br>
      Se você é um candidato, acesse o painel principal abaixo.
    </div>
    <a href="/" class="btn">← Ir para o app</a>
    <div class="email">Você está logado como: ${adSess.user_email}</div>
  </div>
</body>
</html>`;
      res.writeHead(403,{"Content-Type":"text/html; charset=utf-8"});
      return res.end(errorPage);
    }
    // É admin — servir o painel
    return serveHtml("admin.html");
  }

  // Google Search Console verification
  if(pathname==="/google380652ea59ad95e1.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=UTF-8"});
    return res.end("google-site-verification: google380652ea59ad95e1");
  }

  // Política de Privacidade
  if(pathname==="/privacidade"||pathname==="/privacy"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=86400"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Política de Privacidade — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d0f1a;--surface:#161928;--sf2:#1c1f35;
    --border:rgba(139,92,246,0.18);
    --text:#e8eaf6;--t2:#a5a8cc;--t3:#7c7fb5;
    --blue:#3b82f6;
  }
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--text);background:var(--bg);line-height:1.7}
  .star-bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
  .star-bg::before{content:"";position:absolute;inset:0;background:
    radial-gradient(ellipse 900px 600px at 15% 30%,rgba(59,130,246,.1) 0%,transparent 70%),
    radial-gradient(ellipse 700px 500px at 85% 70%,rgba(139,92,246,.08) 0%,transparent 70%),
    radial-gradient(ellipse 500px 400px at 50% 0%,rgba(16,185,129,.04) 0%,transparent 60%)}
  .container{max-width:760px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:var(--text)}
  h1{font-size:28px;font-weight:800;color:var(--text);margin-bottom:8px}
  .date{font-size:13px;color:var(--t2);margin-bottom:32px}
  h2{font-size:18px;font-weight:700;color:var(--text);margin:28px 0 10px}
  p{color:var(--t2);margin-bottom:12px;font-size:15px}
  ul{color:var(--t2);margin:8px 0 12px 20px;font-size:15px}
  li{margin-bottom:6px}
  a{color:var(--blue);text-decoration:none}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:24px}
  .footer{text-align:center;margin-top:40px;font-size:13px;color:var(--t3)}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
</style>
</head>
<body>
<div class="star-bg"></div>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Voltar ao App</a>
  <div class="card">
    <h1>Política de Privacidade</h1>
    <div class="date">Última atualização: Julho de 2026 — Versão 3.1</div>

    <h2>1. Informações que coletamos</h2>
    <p>Ao usar o H2BApply, coletamos as seguintes informações:</p>
    <ul>
      <li><strong>Dados de cadastro:</strong> nome de usuário e senha (armazenada com hash — nunca em texto puro), informados diretamente por você ao criar sua conta</li>
      <li><strong>Dados do perfil:</strong> nome completo, sobrenome, data de nascimento, país, estado, cidade, telefone/WhatsApp</li>
      <li><strong>Dados do Google (apenas se/quando você conectar um Gmail para enviar candidaturas, após ativar um plano pago):</strong> endereço de email da conta Google conectada</li>
      <li><strong>Acesso ao Gmail:</strong> permissão para enviar emails em seu nome para candidaturas H-2B/H-2A — concedida apenas quando você mesmo escolhe conectar sua conta Google (nunca durante o cadastro ou login, que são feitos só com usuário e senha)</li>
      <li><strong>Currículos (PDF):</strong> arquivos enviados para uso nas candidaturas</li>
      <li><strong>Histórico de candidaturas:</strong> registro dos emails enviados para empregadores americanos</li>
    </ul>

    <h2>2. Como usamos suas informações</h2>
    <ul>
      <li>Enviar emails de candidatura para empregadores americanos em seu nome</li>
      <li>Gerenciar seu histórico de candidaturas e evitar envios duplicados</li>
      <li>Melhorar a experiência do usuário no aplicativo</li>
    </ul>

    <h2>3. Acesso ao Gmail</h2>
    <p>O H2BApply solicita acesso ao seu Gmail <strong>exclusivamente</strong> para:</p>
    <ul>
      <li>Enviar emails de candidatura H-2B/H-2A para empregadores nos EUA (escopo <code>gmail.send</code>)</li>
    </ul>
    <p><strong>Este serviço NÃO lê, NÃO armazena e NÃO tem acesso à sua caixa de entrada.</strong> A única permissão solicitada é a de enviar as candidaturas que você mesmo escolher e autorizar.</p>
    <p><strong>Nunca lemos, armazenamos ou compartilhamos o conteúdo de seus emails pessoais.</strong> O acesso é restrito às funcionalidades descritas acima e está em conformidade com a <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Política de Dados de Usuário do Google API</a>, incluindo os requisitos de Uso Limitado.</p>
    <p style="background:var(--sf2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:13.5px"><em>Google API Limited Use Disclosure (English):</em> H2BApply's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API Services User Data Policy</a>, including the Limited Use requirements. This application only requests the <code>gmail.send</code> scope, used exclusively to send job application emails that the user explicitly composes and authorizes. It does not read, store, or access the user's inbox in any way. We do not use Google user data for advertising, we do not sell it, and no humans read it except with explicit user consent or for security purposes as permitted by the policy.</p>

    <h2>4. Compartilhamento de dados</h2>
    <p>Não vendemos, alugamos ou compartilhamos seus dados pessoais com terceiros, exceto:</p>
    <ul>
      <li><strong>Empregadores americanos:</strong> seu nome, email e currículo são enviados nas candidaturas (com seu consentimento)</li>
      <li><strong>Google APIs:</strong> para autenticação e envio de emails via Gmail</li>
    </ul>

    <h2>5. Segurança dos dados</h2>
    <p>Seus dados são armazenados em servidores seguros com acesso restrito. Utilizamos criptografia para proteger tokens de acesso. Você pode pedir a exclusão da sua conta e dos seus dados a qualquer momento pela página <a href="/excluir-conta">/excluir-conta</a>.</p>

    <h2>6. Retenção de dados</h2>
    <p>Mantemos seus dados enquanto sua conta estiver ativa. Ao excluir sua conta em <a href="/delete-account">/excluir-conta</a>, seu acesso ao Gmail é revogado imediatamente no Google, sua sessão é encerrada e a conta é <strong>desativada</strong> (some do app e de qualquer lista pública, o envio automático para). Seu histórico de candidaturas e seus registros de pagamento/pedido são <strong>mantidos</strong> mesmo após a exclusão — não por opção comercial, mas porque a legislação brasileira (Código Civil e normas fiscais) exige guarda de registros financeiros/contábeis por prazo determinado, e porque preservar seu histórico permite restaurar sua conta automaticamente caso você entre novamente com o mesmo email. Se quiser a remoção definitiva dos seus dados em vez da desativação, use o canal de contato abaixo — atendemos o pedido dentro do prazo legal, respeitada a guarda obrigatória de registros financeiros.</p>

    <h2>7. Seus direitos (LGPD — Lei 13.709/2018)</h2>
    <p>Nos termos da <strong>Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018)</strong>, você tem direito a:</p>
    <ul>
      <li>Acessar seus dados pessoais armazenados</li>
      <li>Corrigir informações incorretas</li>
      <li>Excluir/desativar sua conta a qualquer momento (ver "Retenção de dados" acima)</li>
      <li>Baixar uma cópia de todos os seus dados a qualquer momento, direto no app (Configurações → "Baixar meus dados") — sem precisar pedir a ninguém</li>
      <li>Solicitar a eliminação definitiva dos seus dados pelo canal de contato, respeitada a guarda legal de registros financeiros</li>
      <li>Revogar o acesso ao Gmail a qualquer momento em <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a></li>
    </ul>

    <h2>8. Contato</h2>
    <p>Para dúvidas sobre privacidade, entre em contato:</p>
    <ul>
      <li>Email: <a href="mailto:suporte@h2bapply.com">suporte@h2bapply.com</a></li>
      <li>WhatsApp: +55 53 98145-3496</li>
      <li>Instagram: <a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></li>
    </ul>
  </div>
  <div class="footer">
    © 2026 H2BApply · <a href="/" style="color:var(--blue)">h2bapply.com</a>
    &nbsp;|&nbsp; <a href="/privacy" style="color:var(--blue)">Privacidade</a>
    &nbsp;|&nbsp; <a href="/terms" style="color:var(--blue)">Termos</a>
    &nbsp;|&nbsp; <a href="/contact" style="color:var(--blue)">Contato</a>
    <br><small style="color:var(--t3)">suporte@h2bapply.com</small>
  </div>
</div>
</body>
</html>`);
  }

  // Google API Services User Data Policy — Limited Use, página dedicada
  // (checklist de verificação OAuth: reforça a mesma disclosure que já
  // existe dentro de /privacidade, mas num link curto e fácil de achar
  // pro revisor do Google, sem precisar ler a política inteira).
  if(pathname==="/google-data-usage"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=86400"});
    return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Google User Data Usage — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d0f1a;--surface:#161928;--sf2:#1c1f35;
    --border:rgba(139,92,246,0.18);
    --text:#e8eaf6;--t2:#a5a8cc;--t3:#7c7fb5;
    --blue:#3b82f6;--bluel:rgba(59,130,246,.16);--blueb:rgba(59,130,246,.36);
    --green:#10b981;--greenl:rgba(16,185,129,.16);--greenb:rgba(16,185,129,.35);
  }
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--text);background:var(--bg);line-height:1.7}
  .star-bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
  .star-bg::before{content:"";position:absolute;inset:0;background:
    radial-gradient(ellipse 900px 600px at 15% 30%,rgba(59,130,246,.1) 0%,transparent 70%),
    radial-gradient(ellipse 700px 500px at 85% 70%,rgba(139,92,246,.08) 0%,transparent 70%),
    radial-gradient(ellipse 500px 400px at 50% 0%,rgba(16,185,129,.04) 0%,transparent 60%)}
  .container{max-width:680px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:var(--text)}
  h1{font-size:26px;font-weight:800;color:var(--text);margin-bottom:8px}
  .date{font-size:13px;color:var(--t2);margin-bottom:28px}
  h2{font-size:16px;font-weight:700;color:var(--text);margin:22px 0 8px}
  p{color:var(--t2);margin-bottom:12px;font-size:14.5px}
  ul{color:var(--t2);margin:8px 0 12px 20px;font-size:14.5px}
  li{margin-bottom:6px}
  a{color:var(--blue);text-decoration:none}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:26px;margin-bottom:20px}
  .scope-box{background:var(--bluel);border:1.5px solid var(--blueb);border-radius:10px;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#93c5fd;margin:10px 0;overflow-wrap:anywhere;word-break:break-all}
  .no-box{background:var(--greenl);border:1.5px solid var(--greenb);border-radius:10px;padding:14px 16px;font-size:14px;color:#86efac;margin:14px 0}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
  .footer{text-align:center;margin-top:40px;font-size:12px;color:var(--t3)}
</style>
</head>
<body>
<div class="star-bg"></div>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Back to app</a>
  <div class="card">
    <h1>How H2BApply uses Google user data</h1>
    <div class="date">Last updated: September 2026</div>

    <h2>The only scope we request</h2>
    <div class="scope-box">https://www.googleapis.com/auth/gmail.send</div>
    <p>That's it. We never request <code>gmail.readonly</code>, <code>gmail.modify</code>, <code>gmail.metadata</code>, <code>gmail.insert</code>, <code>gmail.compose</code>, or <code>mail.google.com</code>.</p>

    <h2>What we do with it</h2>
    <p>H2BApply helps Brazilian workers apply to U.S. seasonal jobs (H-2B/H-2A visas) publicly listed by the U.S. Department of Labor. The user writes their own application e-mail (subject and body) and attaches their own resume. When the user clicks "Send" — manually, one job at a time, or through a queue they start and can pause/stop at any time — the app sends that exact e-mail <strong>from the user's own Gmail account</strong> to the employer the user selected.</p>

    <h2>What we never do</h2>
    <div class="no-box">
      ✅ We do not read your inbox.<br>
      ✅ We do not store the content of your e-mails.<br>
      ✅ We do not access, search, or export any message you didn't send through the app.<br>
      ✅ We do not use Gmail data for advertising.<br>
      ✅ We do not sell Google user data, ever.<br>
      ✅ No human reads your data, except with your explicit consent or as required for security/fraud investigation, as permitted by Google's policy.
    </div>

    <h2>Limited Use compliance</h2>
    <p>H2BApply's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

    <h2>Revoke access anytime</h2>
    <p>You can revoke H2BApply's access to your Google account at any time at <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>. Deleting your H2BApply account (available in-app, or via <a href="/delete-account">/delete-account</a>) also revokes the underlying Google grant automatically.</p>

    <h2>Full policy</h2>
    <p>This page summarizes our Gmail data practices. For our complete privacy practices, see the <a href="/privacidade">Privacy Policy</a>.</p>
  </div>
  <div class="footer">
    © 2026 H2BApply · <a href="/" style="color:var(--blue)">h2bapply.com</a>
    &nbsp;|&nbsp; <a href="/privacidade" style="color:var(--blue)">Privacidade</a>
    &nbsp;|&nbsp; <a href="/termos" style="color:var(--blue)">Termos</a>
    <br><small style="color:var(--t3)">suporte@h2bapply.com</small>
  </div>
</div>
</body>
</html>`);
  }

  // Termos de Uso
  if(pathname==="/termos"||pathname==="/terms"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=86400"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Termos de Uso — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d0f1a;--surface:#161928;--sf2:#1c1f35;
    --border:rgba(139,92,246,0.18);
    --text:#e8eaf6;--t2:#a5a8cc;--t3:#7c7fb5;
    --blue:#3b82f6;
    --amberl:rgba(245,158,11,.16);--amberb:rgba(245,158,11,.36);
  }
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--text);background:var(--bg);line-height:1.7}
  .star-bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
  .star-bg::before{content:"";position:absolute;inset:0;background:
    radial-gradient(ellipse 900px 600px at 15% 30%,rgba(59,130,246,.1) 0%,transparent 70%),
    radial-gradient(ellipse 700px 500px at 85% 70%,rgba(139,92,246,.08) 0%,transparent 70%),
    radial-gradient(ellipse 500px 400px at 50% 0%,rgba(16,185,129,.04) 0%,transparent 60%)}
  .container{max-width:760px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:var(--text)}
  h1{font-size:28px;font-weight:800;color:var(--text);margin-bottom:8px}
  .date{font-size:13px;color:var(--t2);margin-bottom:32px}
  h2{font-size:18px;font-weight:700;color:var(--text);margin:28px 0 10px}
  p{color:var(--t2);margin-bottom:12px;font-size:15px}
  ul{color:var(--t2);margin:8px 0 12px 20px;font-size:15px}
  li{margin-bottom:6px}
  a{color:var(--blue);text-decoration:none}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:24px}
  .footer{text-align:center;margin-top:40px;font-size:13px;color:var(--t3)}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
  .warning{background:var(--amberl);border:1.5px solid var(--amberb);border-radius:10px;padding:14px 16px;font-size:14px;color:#fcd34d;margin-bottom:16px}
</style>
</head>
<body>
<div class="star-bg"></div>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Voltar ao App</a>
  <div class="card">
    <h1>Termos de Uso</h1>
    <div class="date">Última atualização: Setembro de 2026 — Versão 4.0</div>

    <div class="warning">⚠️ <strong>Importante:</strong> O H2BApply é uma ferramenta de candidatura — um serviço digital de envio de e-mails. Não garantimos contratação, aprovação de visto ou resposta de empregadores.</div>

    <h2>1. Sobre o serviço</h2>
    <p>O H2BApply é um serviço digital brasileiro, pago por assinatura, que automatiza o ENVIO de candidaturas para vagas H-2B e H-2A publicadas no portal oficial do Departamento de Trabalho dos Estados Unidos (DOL). O serviço usa a sua própria conta Gmail para mandar, em seu nome, exatamente o e-mail (assunto, corpo e currículo) que VOCÊ escreveu e escolheu enviar.</p>

    <h2>2. Elegibilidade</h2>
    <ul>
      <li>Ter 18 anos ou mais</li>
      <li>Possuir uma conta Google (Gmail) válida</li>
      <li>Concordar com estes termos e com a Política de Privacidade</li>
    </ul>

    <h2>3. Uso aceitável</h2>
    <p>Ao usar o H2BApply, você concorda em:</p>
    <ul>
      <li>Fornecer informações verdadeiras em seu perfil e currículo</li>
      <li>Usar o serviço apenas para candidaturas legítimas a vagas H-2B/H-2A</li>
      <li>Não usar o app para envio de spam ou conteúdo enganoso</li>
      <li>Respeitar os limites de envio do seu plano</li>
      <li>Ser o único responsável pelo conteúdo (assunto, corpo, currículo) que decide enviar</li>
    </ul>

    <h2>4. O que o H2BApply faz — e o que ele NUNCA faz</h2>
    <p><strong>Faz:</strong> envia, pela sua própria conta Gmail, o e-mail de candidatura que você escreveu, para o empregador que você escolheu, dentro do limite diário do seu plano (manual e/ou automático).</p>
    <p><strong>Nunca faz:</strong> o H2BApply <strong>não escreve, não sugere e não preenche</strong> assunto, corpo de e-mail ou carta de apresentação por você — se você não escrever o texto, o envio é pulado com um aviso claro na tela. O H2BApply também <strong>nunca lê, abre, armazena ou monitora</strong> sua caixa de entrada (recebidos); a única permissão usada no Gmail é a de enviar. O H2BApply não é uma agência de emprego, não representa nenhum empregador e não tem qualquer vínculo com o governo dos Estados Unidos.</p>

    <h2>5. Planos, preços e como funciona a compra</h2>
    <p>Os preços de cada plano e período são sempre os exibidos na tela antes do pagamento, calculados pelo próprio servidor — nunca um valor "combinado" ou digitado à mão. A compra funciona assim:</p>
    <ul>
      <li>Você escolhe o plano e o período e vê o valor exato a pagar via PIX</li>
      <li>Você confirma que leu e entende este Termo (seção 12) antes de continuar</li>
      <li>Você paga via PIX e envia o comprovante dentro do próprio app</li>
      <li><strong>Você precisa continuar com a mesma conta cadastrada</strong> até a análise terminar — o comprovante é vinculado à sua conta, e sair ou excluir a conta no meio da análise pode impedir a confirmação</li>
      <li>Se os dados do comprovante conferem automaticamente, o plano é liberado <strong>na hora, de forma PROVISÓRIA</strong> (por poucos dias), mas o pedido continua na fila para um administrador humano confirmar — nenhum plano fica ativo por muito tempo sem essa confirmação</li>
      <li>Se o comprovante não confere, está ilegível ou incompleto, o pedido fica pendente de revisão manual e você é avisado</li>
    </ul>
    <p>Quem ativou um plano antes de uma mudança de preços ou regras mantém os limites da própria ativação até o vencimento. Não há reembolso automático após o uso do plano, sem prejuízo do direito de arrependimento da seção 6.</p>

    <h2>6. Direito de arrependimento (Código de Defesa do Consumidor, art. 49)</h2>
    <p>Como a contratação acontece fora de um estabelecimento físico (pela internet), você tem até <strong>7 (sete) dias corridos</strong> a partir da confirmação do pagamento para desistir da compra e pedir reembolso integral, bastando avisar pelo e-mail de suporte (seção 13). Se o plano já tiver sido efetivamente usado (por exemplo, envios automáticos ou manuais já realizados dentro do período pago), o reembolso pode ser proporcional ao que ainda não foi utilizado. Este direito não substitui, e não é substituído por, nenhuma outra garantia prevista em lei.</p>

    <h2>7. Limitação de responsabilidade</h2>
    <p>O H2BApply é uma ferramenta de envio de e-mails e <strong>não garante</strong>:</p>
    <ul>
      <li>Contratação por qualquer empresa americana</li>
      <li>Resposta de empregadores</li>
      <li>Aprovação de visto H-2B ou H-2A</li>
      <li>Entrada nos Estados Unidos</li>
    </ul>
    <p>O resultado das candidaturas depende exclusivamente de empregadores, autoridades americanas e consulados — fatores totalmente fora do controle do H2BApply.</p>

    <h2>8. Conta e segurança</h2>
    <p>Você é responsável por manter a segurança da sua conta Google. O H2BApply acessa seu Gmail <strong>apenas para enviar</strong> as candidaturas que você mesmo escreve e autoriza — o app nunca lê, abre nem armazena o conteúdo da sua caixa de entrada, conforme descrito na Política de Privacidade.</p>

    <h2>9. Cancelamento</h2>
    <p>Você pode cancelar sua conta a qualquer momento pelo app. Também pode revogar o acesso ao Gmail em <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>.</p>

    <h2>10. Alterações nos termos</h2>
    <p>Podemos atualizar estes termos periodicamente. Mudanças significativas serão comunicadas pelo app. O uso continuado após alterações implica aceitação dos novos termos.</p>

    <h2 id="gmail-aviso">11. Aviso sobre uso do Gmail — um risco que é do Google, não do H2BApply</h2>
    <div class="warning">⚠️ <strong>Leia com atenção antes de usar o envio automático.</strong></div>
    <p>O H2BApply utiliza sua conta Gmail para enviar candidaturas. O Google — empresa terceira, totalmente independente do H2BApply — pode <strong>limitar ou bloquear temporariamente</strong> contas Gmail que enviam muitos emails em curto período, especialmente quando:</p>
    <ul>
      <li>Você usa apenas <strong>1 conta Gmail</strong> para todos os envios</li>
      <li>O volume de emails é muito alto em um único dia</li>
      <li>Os emails são enviados para muitos destinatários desconhecidos</li>
    </ul>
    <p><strong>O que o H2BApply já faz para reduzir esse risco:</strong> aquecimento gradual de conta nova, intervalo humanizado entre envios automáticos e o rodízio entre Gmails: Manual e Turbo enviam pelo seu Gmail cadastrado (1 conta); o Máximo reveza entre 2 Gmails, o que reduz o volume por conta e o risco de bloqueio.</p>
    <p><strong>Isenção específica:</strong> mesmo com essas proteções, a decisão de limitar, suspender ou bloquear uma conta Gmail é tomada exclusivamente pelo Google, segundo critérios e políticas próprias que o H2BApply não controla nem pode garantir. Por isso, o H2BApply não se responsabiliza por bloqueios, suspensões ou limitações impostas pelo Google à sua conta Gmail. Ao ativar o envio automático, você declara estar ciente deste risco específico — que decorre de ato de terceiro (o Google), e não de falha do H2BApply.</p>

    <h2>12. Consentimento informado ao comprar um plano</h2>
    <p>Antes de concluir o pagamento de qualquer plano, você confirma que leu e entende que:</p>
    <ul>
      <li>Está contratando um <strong>serviço digital pago</strong> de automação de envio de e-mails — não uma agência de emprego, consultoria de imigração ou qualquer garantia de resultado</li>
      <li>O H2BApply <strong>nunca escreve texto por você</strong>; o conteúdo enviado é sempre de sua autoria e responsabilidade</li>
      <li>O preço mostrado na tela, no momento da escolha do plano, é o valor final a pagar</li>
      <li>Depois de pagar via PIX, é necessário enviar o comprovante e <strong>permanecer logado na mesma conta</strong> até a análise (automática e, sempre, humana) ser concluída</li>
      <li>O risco de limitação/bloqueio da conta Gmail pelo Google é um risco de terceiro, nos termos da seção 11, e pode ser reduzido — mas não eliminado — usando mais de uma conta de envio</li>
      <li>Tem direito de arrependimento de 7 dias corridos, nos termos da seção 6</li>
      <li>Concorda integralmente com este Termo de Uso e com a Política de Privacidade</li>
    </ul>

    <h2>13. Contato</h2>
    <ul>
      <li>Email: <a href="mailto:suporte@h2bapply.com">suporte@h2bapply.com</a></li>
      <li>WhatsApp: +55 53 98145-3496</li>
      <li>Instagram: <a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></li>
      <li>Site: <a href="https://h2bapply.com">h2bapply.com</a></li>
    </ul>
  </div>
  <div class="footer">
    © 2026 H2BApply · <a href="/" style="color:var(--blue)">h2bapply.com</a>
    &nbsp;|&nbsp; <a href="/privacy" style="color:var(--blue)">Privacidade</a>
    &nbsp;|&nbsp; <a href="/terms" style="color:var(--blue)">Termos</a>
    &nbsp;|&nbsp; <a href="/contact" style="color:var(--blue)">Contato</a>
    <br><small style="color:var(--t3)">suporte@h2bapply.com</small>
  </div>
</div>
</body>
</html>`);
  }

  // Página de Exclusão de Dados — exigida pelo Google OAuth
  if(pathname==="/delete-account"||pathname==="/excluir-conta"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=3600"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Excluir Conta — H2BApply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc;line-height:1.7}
.container{max-width:640px;margin:0 auto;padding:40px 20px}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
.logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:800}
h1{font-size:26px;font-weight:800;color:#1e293b;margin-bottom:8px}
h2{font-size:16px;font-weight:700;color:#374151;margin:24px 0 8px}
p{font-size:14px;color:#4b5563;margin-bottom:12px}
ul{font-size:14px;color:#4b5563;margin:0 0 12px 20px}
ul li{margin-bottom:6px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;margin-bottom:20px}
.warning{background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:14px;font-size:13px;color:#991b1b;margin-bottom:20px}
.email-link{color:#4f46e5;font-weight:700}
.btn{display:inline-block;background:#4f46e5;color:#fff;padding:11px 24px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-top:8px}
.footer{text-align:center;margin-top:40px;font-size:12px;color:#94a3b8}
.date{font-size:12px;color:#94a3b8;margin-top:4px}
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div>
      <div style="font-size:20px;font-weight:800">H2BApply</div>
      <div class="date">h2bapply.com</div>
    </div>
  </div>

  <h1>Exclusão de Conta e Dados</h1>
  <p style="color:#64748b;margin-bottom:24px">Esta página explica o que acontece de verdade quando você pede pra excluir sua conta no H2BApply — e como pedir.</p>

  <div class="warning">
    ⚠️ <strong>Atenção:</strong> ao excluir sua conta, o acesso ao seu Gmail é revogado na hora, sua sessão é encerrada e a conta é <strong>desativada</strong> — some do app e de qualquer lista pública, e o envio automático para. Seu histórico de candidaturas e seus registros de pagamento são <strong>mantidos</strong> mesmo depois disso, por exigência da legislação brasileira (detalhes na nossa <a href="/privacidade" class="email-link">Política de Privacidade</a>, seção 6). A remoção definitiva desses dados é um pedido separado, feito pelo canal de contato abaixo.
  </div>

  <div class="card">
    <h2>📋 O que acontece na hora</h2>
    <ul>
      <li>Seu perfil e informações pessoais somem do app e de qualquer lista pública</li>
      <li>Autorização de acesso ao Gmail é revogada automaticamente no Google</li>
      <li>Envio automático e manual param imediatamente</li>
      <li>Sua conta fica desativada — se você entrar de novo com o <strong>mesmo e-mail</strong>, ela é restaurada automaticamente, com tudo como estava</li>
    </ul>
  </div>

  <div class="card">
    <h2>🗂️ O que é mantido por exigência legal</h2>
    <p>Não é opção comercial — é o Código Civil e normas fiscais brasileiras que exigem a guarda de registros financeiros/contábeis por um prazo determinado:</p>
    <ul>
      <li>Histórico de candidaturas enviadas</li>
      <li>Registros de pagamento e pedido</li>
    </ul>
    <p>Quer a remoção definitiva desses dados em vez da desativação? Peça pelo canal de contato abaixo — atendemos dentro do prazo legal, respeitada a guarda obrigatória de registros financeiros.</p>
  </div>

  <div class="card">
    <h2>🔐 Acesso ao Google</h2>
    <p>Sua conta no H2BApply é criada com usuário e senha — o <strong>Google OAuth</strong> é usado só depois, e só para ENVIAR e-mails pelo seu Gmail (nunca para ler sua caixa de entrada). Ao excluir sua conta, revogamos essa autorização no Google. Para garantia adicional, você também pode revogar o acesso diretamente em:</p>
    <p><a href="https://myaccount.google.com/permissions" target="_blank" class="email-link">myaccount.google.com/permissions</a></p>
    <p>Busque por "H2BApply" e clique em "Remover acesso".</p>
  </div>

  <div class="card">
    <h2>📧 Como solicitar a exclusão</h2>
    <p><strong>Opção 1 — Pelo WhatsApp do suporte (mais rápido):</strong></p>
    <ul>
      <li>Chame o suporte em <a href="https://wa.me/5553981453496" class="email-link">wa.me/5553981453496</a></li>
      <li>Diga o usuário e o e-mail cadastrados e peça a exclusão da conta</li>
      <li>Confirmamos o pedido e processamos a exclusão</li>
    </ul>
    <p style="margin-top:12px"><strong>Opção 2 — Por email:</strong></p>
    <ul>
      <li>Envie um email para <a href="mailto:suporte@h2bapply.com" class="email-link">suporte@h2bapply.com</a></li>
      <li>Assunto: "Exclusão de conta — [seu email]"</li>
      <li>Responderemos em até 48 horas confirmando a exclusão</li>
    </ul>
    <a href="mailto:suporte@h2bapply.com?subject=Solicitar exclusão de conta H2BApply" class="btn">📧 Solicitar exclusão por email</a>
  </div>

  <div class="card">
    <h2>⏱️ Prazo</h2>
    <p>A desativação da conta é <strong>imediata</strong>. A remoção definitiva dos dados pessoais que não têm guarda legal obrigatória (perfil, currículos, configurações) acontece em até 30 dias após o pedido feito pelo canal de contato. Durante esse período você não recebe nenhuma comunicação da plataforma.</p>
    <p>Registros financeiros e histórico de candidaturas continuam mantidos pelo prazo exigido pela legislação, mesmo depois desse pedido — nunca é opção comercial, é obrigação legal.</p>
  </div>

  <div class="footer">
    © 2026 H2BApply · <a href="/privacy" style="color:#94a3b8">Privacidade</a> · <a href="/terms" style="color:#94a3b8">Termos</a> · <a href="/contact" style="color:#94a3b8">Contato</a>
    <br>suporte@h2bapply.com
  </div>
</div>
</body>
</html>`);
  }

  // Página de Contato
  if(pathname==="/contact"||pathname==="/contato"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=3600"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Contato — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc;line-height:1.7}
  .container{max-width:600px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:#1e293b}
  h1{font-size:28px;font-weight:800;color:#1e293b;margin-bottom:8px}
  .sub{font-size:14px;color:#64748b;margin-bottom:28px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;margin-bottom:16px}
  .contact-item{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #f1f5f9}
  .contact-item:last-child{border-bottom:none}
  .contact-icon{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
  .contact-label{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
  .contact-value{font-size:15px;font-weight:600;color:#1e293b}
  .contact-value a{color:#4f46e5;text-decoration:none}
  .footer{text-align:center;margin-top:32px;font-size:13px;color:#94a3b8}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
  .badge{display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:20px}
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Voltar ao App</a>
  <div class="badge">🌐 Plataforma de candidaturas H-2B/H-2A</div>
  <h1>Fale Conosco</h1>
  <p class="sub">Estamos aqui para ajudar com dúvidas sobre o app, planos ou candidaturas.</p>
  <div class="card">
    <div class="contact-item">
      <div class="contact-icon" style="background:#eff6ff">📧</div>
      <div>
        <div class="contact-label">Email de suporte</div>
        <div class="contact-value"><a href="mailto:suporte@h2bapply.com">suporte@h2bapply.com</a></div>
      </div>
    </div>
    <div class="contact-item">
      <div class="contact-icon" style="background:#f0fdf4">💬</div>
      <div>
        <div class="contact-label">WhatsApp</div>
        <div class="contact-value"><a href="https://wa.me/5553981453496" target="_blank">+55 53 98145-3496</a></div>
      </div>
    </div>
    <div class="contact-item">
      <div class="contact-icon" style="background:#fdf4ff">📸</div>
      <div>
        <div class="contact-label">Instagram</div>
        <div class="contact-value"><a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></div>
      </div>
    </div>
    <div class="contact-item">
      <div class="contact-icon" style="background:#fefce8">🌐</div>
      <div>
        <div class="contact-label">Site</div>
        <div class="contact-value"><a href="https://h2bapply.com">h2bapply.com</a></div>
      </div>
    </div>
  </div>
  <div class="card" style="background:#fefce8;border-color:#fde68a">
    <h2 style="font-size:16px;color:#92400e;margin-bottom:10px">⚠️ Aviso sobre Gmail</h2>
    <p style="font-size:14px;color:#78350f">O uso intensivo de uma única conta Gmail pode gerar bloqueio pelo Google. Manual e Turbo enviam pelo seu Gmail cadastrado (1 conta); o Máximo reveza entre 2 Gmails, o que reduz o volume por conta e o risco de bloqueio. <a href="/terms#gmail-aviso" style="color:#92400e;font-weight:700">Ver termos de uso →</a></p>
  </div>
  <div class="footer">
    © 2026 H2BApply &nbsp;·&nbsp; <a href="/privacy" style="color:#94a3b8">Privacidade</a> &nbsp;·&nbsp; <a href="/terms" style="color:#94a3b8">Termos</a>
    <br><small>suporte@h2bapply.com</small>
  </div>
</div>
</body>
</html>`);
  }

  // 🚫 v194 LOTE 12 — A ROTA /api/admin/pedido-set-valor FOI REMOVIDA.
  // Ordem do dono (v178, 14/09/2026): "não vai ter correção de pedidos... se a
  // pessoa errar o pedido não vai ser aceito, pronto... vai ter que ser criado
  // um novo pelo usuário". A rota continuava viva sem NENHUM botão no painel:
  // por curl, qualquer admin reescrevia o valor de um pedido (ela nem olhava o
  // status — reescrevia pago e cancelado, sincronizando o caixa junto) e
  // ativava. Os campos de LEITURA da trilha (valorOriginal/valorCorrigidoPor/
  // valorCorrigidoEm) continuam nas respostas: pedido antigo já carimbado não
  // pode perder a história. Correção de valor de DESPESA/entrada manual segue
  // existindo no Financeiro — o que morreu é corrigir o valor de um PEDIDO.

  // ════ GESTÃO DE PLANILHAS DE VAGAS ════════════════════════
  // GET /api/admin/sheets — lista todas as planilhas
  // ═══ 📋 v174 — ROTAS DOS ROBÔS DE PLANILHA (admin-only; POST com corpo
  // segue a regra da casa: JSON.parse(await readBody(req)) dentro de try/catch,
  // e o catch SEMPRE responde — nunca requisição pendurada). ═══
  // ═══ 📧 v175 — ABA NOTIFICAÇÕES (admin) ═══
  if(pathname==="/api/admin/notificacoes/status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    return json(res,200,{ok:true,...NOTIF.status(),destinatarios:_notifDestinatarios(),oauthConfigurado:CONFIGURADO_OAUTH(),meuEmail:s.user_email,redirectUri:_oauthBase(req)+"/oauth/callback"});
  }
  if(pathname==="/api/admin/notificacoes/desconectar"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{const r=await NOTIF.desconectar();try{logAdminAction(s.user_email,"notif_disconnect","(config)",{email:r.email||null},null,"Desconectou a conta de notificações");}catch(e){}return json(res,200,{ok:true,...r});}
    catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/notificacoes/teste"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const to=String(d.to||s.user_email).trim().toLowerCase();
      if(!to.includes("@"))return json(res,400,{error:"Informe um e-mail de destino."});
      if(!NOTIF.conectada())return json(res,409,{error:"Nenhuma conta conectada — clique em Conectar conta Google primeiro."});
      await NOTIF.sendMail({to,subject:"✅ Teste — notificações do H2BApply funcionando",text:`Este é um e-mail de teste enviado pelo painel admin do H2BApply em ${new Date().toLocaleString("pt-BR")}.\n\nSe você recebeu, a conta de notificações está conectada certinho: códigos de cadastro, recuperação de senha e avisos de pedido vão sair por ela.\n\n— H2BApply`,tipo:"teste"});
      return json(res,200,{ok:true,to});
    }catch(e){return json(res,502,{error:"Falha no envio: "+e.message});}
  }
  if(pathname==="/api/admin/notificacoes/config"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{const d=JSON.parse((await readBody(req))||"{}");if(typeof d.avisoPedidos!=="boolean")return json(res,400,{error:"avisoPedidos precisa ser true/false"});const v=NOTIF.setAvisoPedidos(d.avisoPedidos);if(v===null)return json(res,409,{error:"Nenhuma conta de notificações conectada — conecte antes de configurar o aviso."});return json(res,200,{ok:true,avisoPedidos:v});}
    catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }

  if(pathname==="/api/admin/planilhas/status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    // botLogs: o log humano de TODOS os robôs (DB_BOT_LOGS, mais novo primeiro)
    // — frescor/H-2A novas/mensais/sentinela só falam por aqui.
    return json(res,200,{ok:true,...PLANILHAS.statusPainel(),enrichLog:_enrichBot.log.slice(-80),coletaLog:PLANILHAS.dolColeta.log.slice(-80),botLogs:DB_BOT_LOGS.slice(0,80),latestH2b:latestH2bKey()});
  }
  if(pathname==="/api/admin/enrich/status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const b=_enrichBot;
    return json(res,200,{ok:true,running:b.running,sheetKey:b.sheetKey,total:b.total,done:b.done,okCount:b.ok,noEmail:b.noEmail,errors:b.errors,startedAt:b.startedAt,savedAt:b.savedAt,pct:b.total>0?Math.round((b.done/b.total)*100):0,log:b.log.slice(-100)});
  }
  if(pathname==="/api/admin/enrich/start"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const key=String(d.sheetKey||"").trim();
      const rows=getSheet(key);
      if(!key||!Array.isArray(rows)||!rows.length)return json(res,404,{error:"Planilha não encontrada ou vazia: "+key});
      if(_enrichBot.running)return json(res,409,{error:`O bot já está rodando na planilha "${_enrichBot.sheetKey}" — pare antes de trocar.`});
      PLANILHAS.runEnrichBot(key,d.resume===true).catch(e=>_enrichLog("❌ "+e.message,"error"));
      return json(res,200,{ok:true,sheetKey:key,resume:d.resume===true});
    }catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }
  if(pathname==="/api/admin/enrich/stop"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const was=_enrichBot.running;_enrichBot.running=false;
    if(was)_enrichLog("⏹ Parado pelo admin — o progresso já está salvo no disco; Enriquecer de novo retoma de onde parou.","warn");
    return json(res,200,{ok:true,wasRunning:was});
  }
  if(pathname==="/api/admin/sheet/coleta-start"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const visa=String(d.visa||"H-2B").toUpperCase()==="H-2A"?"H-2A":"H-2B";
      const key=String(d.sheetKey||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");
      const name=String(d.sheetName||"").trim().slice(0,80)||key;
      if(!key)return json(res,400,{error:"Chave da planilha obrigatória (letras, números, - e _)."});
      if(["jan2026","jul2025","h2a-jun2026","h2a","h2ajun2026"].includes(key))return json(res,400,{error:"Essa chave é de uma planilha built-in — escolha outra."});
      if(PLANILHAS.dolColeta.running)return json(res,409,{error:"Já existe uma coleta rodando — acompanhe o log e tente depois."});
      const dateOk=(v)=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""))?String(v):"";
      PLANILHAS.runDolColeta({visa,sheetKey:key,sheetName:name,beginFrom:dateOk(d.beginFrom),beginTo:dateOk(d.beginTo),publishedBy:s.user_email}).catch(e=>console.error("[coleta]",e.message));
      return json(res,200,{ok:true,key,visa});
    }catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }
  if(pathname==="/api/admin/sheet/coleta-status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const c=PLANILHAS.dolColeta;
    return json(res,200,{ok:true,running:c.running,log:c.log,startedAt:c.startedAt,finishedAt:c.finishedAt,key:c.key,count:c.count,error:c.error,progress:c.progress,
      published:!!(c.key&&DB_SHEETS_META[c.key]?.published===true),bimestral:PLANILHAS.getEstadoH2a(),mensalH2b:PLANILHAS.getEstadoH2b()});
  }
  // Publicar um rascunho (coleta manual OU "H-2B <Mês> <Ano>" do robô) — 1 clique
  // do admin libera pros usuários no Manual e no Automático. Idempotente.
  if(pathname==="/api/admin/sheet/coleta-publish"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const key=String(d.key||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");
      const rows=SHEET_EXTRAS[key];const meta=DB_SHEETS_META[key];
      if(!key||!Array.isArray(rows)||!meta)return json(res,404,{error:"Planilha não encontrada: "+key});
      if(meta.published===true)return json(res,200,{ok:true,key,count:rows.length,jaPublicada:true});
      meta.published=true;meta.publishedAt=Date.now();meta.publishedBy=s.user_email;
      fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
      addLog(s.user_email,{status:"sistema",jobTitle:`📢 Planilha publicada: ${meta.name||key}`,company:`${rows.length} vagas — Chave: ${key}`});
      // 📡 v134: 1ª publicação = vaga nova chegando pros usuários → radar avisa
      registrarVagasNovasNoRadar(rows,`publicacao:${key}`).catch(e=>console.warn("[radar] publicar:",e.message));
      console.log(`[sheet] 📢 "${key}" publicada por ${s.user_email} (${rows.length} vagas)`);
      return json(res,200,{ok:true,key,count:rows.length});
    }catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }
  // Planilhas do mês: gerar/refazer AGORA (background — a resposta volta na hora
  // e o painel acompanha pelo coleta-status). 409 quando a do mês já existe e
  // não veio force:true — nunca duplica planilha.
  if((pathname==="/api/admin/sheet/h2a-bimestral-run"||pathname==="/api/admin/sheet/h2b-mensal-run")&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    let d={};
    try{const raw=await readBody(req);d=raw?JSON.parse(raw):{};}catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
    try{
      const r=await (pathname.endsWith("h2a-bimestral-run")?PLANILHAS.runH2aMensal:PLANILHAS.runH2bMensal)("manual:"+s.user_email,d.force===true,true);
      return json(res,r.skipped?409:r.ok?200:500,r);
    }catch(e){return json(res,500,{ok:false,error:e.message});}
  }
  if(pathname==="/api/admin/sheet/h2a-novas-run"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{const r=await PLANILHAS.runH2aNovasCycle("manual:"+s.user_email);return json(res,r.ok?200:500,r);}
    catch(e){return json(res,500,{ok:false,error:e.message});}
  }

  if(pathname==="/api/admin/sheets"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    // Calcular stats reais de enriquecimento contando campos preenchidos
    const _enrichStats=(arr)=>{
      if(!arr||!arr.length)return{withCity:0,withPhone:0,withDesc:0,withDate:0};
      return{
        withCity:arr.filter(r=>r.ci).length,
        withPhone:arr.filter(r=>r.ph).length,
        withDesc:arr.filter(r=>r.desc).length,
        withDate:arr.filter(r=>r.d&&r.d!=="–").length,
      };
    };
    // v174: uma linha por planilha (built-ins incluindo a H-2A + extras) com
    // published (o que /api/sheets-list usa pra mostrar ao usuário), origem e
    // quantas têm e-mail — o painel "Planilhas & Robôs" mostra rascunho vs no ar.
    const _mkRow=(key,name,arr,builtin,visaType)=>{
      const st=_enrichStats(arr);const meta=DB_SHEETS_META[key]||{};
      return{key,name,count:arr.length,builtin,active:true,visaType,
        uploaded:meta.uploaded||null,source:meta.source||(builtin?"bundled":"upload"),
        published:builtin?true:meta.published===true,
        publishedAt:meta.publishedAt||null,
        enriched:meta.enriched||st.withCity,enrichedAt:meta.enrichedAt||null,
        withEmail:arr.filter(r=>r.e&&String(r.e).includes("@")).length,
        stats:st,enrichPct:arr.length>0?Math.round((st.withCity/arr.length)*100):0};
    };
    const sheets=[
      _mkRow("jan2026","Janeiro 2026 (H-2B)",SHEET_JAN,true,"H-2B"),
      _mkRow("jul2025","Julho 2025 (H-2B)",SHEET_JUL,true,"H-2B"),
      _mkRow("h2a-jun2026","H-2A Agricultura",SHEET_H2A,true,"H-2A"),
      ...Object.entries(SHEET_EXTRAS).map(([key,arr])=>_mkRow(key,DB_SHEETS_META[key]?.name||key,arr,false,
        String(DB_SHEETS_META[key]?.visaType||arr[0]?.visa||"H-2B").toUpperCase().includes("H-2A")?"H-2A":"H-2B")),
    ];
    const totalVagas = sheets.reduce((n,sh)=>n+sh.count,0);
    const totalEnriched = sheets.reduce((s,sh)=>s+(sh.stats?.withCity||0),0);
    // Status do bot em tempo real
    const botStatus={running:_enrichBot.running,sheetKey:_enrichBot.sheetKey,done:_enrichBot.done,total:_enrichBot.total,pct:_enrichBot.total>0?Math.round((_enrichBot.done/_enrichBot.total)*100):0};
    return json(res,200,{ok:true,sheets,totalVagas,totalEnriched,botStatus});
  }

  // GET /api/admin/sheet/integrity — diagnóstico sob demanda (KB-076): confere,
  // para CADA planilha carregada em memória agora, se a contagem de linhas
  // bate com a contagem de ETA case numbers únicos. Não deveria nunca dar
  // "false" em produção (loadSheets já se autocura no boot), mas é a forma
  // do admin CONFERIR ao vivo, sem precisar reprocessar nada, que "quantas
  // vagas tem" é sempre igual a "quantos case numbers diferentes existem".
  if(pathname==="/api/admin/sheet/integrity"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const checkOne=(key,arr)=>{
      const r=_vagasVerify(arr,{caseField:'c'});
      return{key,totalRows:r.totalRows,uniqueCaseCount:r.uniqueCaseCount,
        ok:r.ok,duplicateCases:r.duplicateCases.slice(0,20),
        rowsWithoutCase:r.rowsWithoutCase};
    };
    const results=[
      checkOne("jan2026",SHEET_JAN),
      checkOne("jul2025",SHEET_JUL),
      checkOne("h2a",SHEET_H2A),
      ...Object.entries(SHEET_EXTRAS).map(([k,arr])=>checkOne(k,arr)),
    ];
    const allOk = results.every(r=>r.ok);
    return json(res,200,{ok:true,allOk,results});
  }

  if(pathname==="/api/admin/sheet/upload"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    // FIX v941: `body` não existia neste escopo → ReferenceError → request pendurado
    // pra sempre (mesma classe do bug #819). Agora lê o corpo corretamente.
    let _upBody;
    try{ _upBody=JSON.parse(await readBody(req)); }
    catch(e){ return json(res,400,{error:"Corpo inválido: "+e.message}); }
    const{name,key,data}=_upBody;
    if(!name||!key||!data)return json(res,400,{error:"name, key e data obrigatórios"});
    // Sanitizar key (só letras, números, hífen, underscore)
    const safeKey=key.toLowerCase().replace(/[^a-z0-9_-]/g,"");
    if(!safeKey)return json(res,400,{error:"key inválida"});
    // Validar dados
    let vagas;
    try{ vagas = typeof data==="string"?JSON.parse(data):data; }
    catch(e){return json(res,400,{error:"JSON inválido: "+e.message});}
    if(!Array.isArray(vagas))return json(res,400,{error:"data deve ser um array de vagas"});
    // Garantir campos obrigatórios. Uma planilha de verdade PRECISA trazer
    // e-mail em alguma linha (é o que permite candidatura) — arquivo sem
    // nenhum e-mail é recusado na cara, nunca publicado em silêncio.
    const comEmail = vagas.filter(v=>v&&v.c&&v.e&&String(v.e).includes("@"));
    if(comEmail.length<1)return json(res,400,{error:`Nenhuma vaga válida (com case_number e e-mail). Recebidas: ${vagas.length}`});
    // v180: linha com case number mas AINDA sem e-mail entra também — é
    // exatamente ela que o robô de enriquecimento completa depois (e, numa
    // substituição, é ela que traz cidade/título/status novos sem apagar o
    // e-mail que a planilha atual já tinha).
    const validRaw = vagas.filter(v=>v&&v.c);
    // 🔒 DEDUPE por ETA case number — mesma regra do resto do sistema (KB-076):
    // 1 vaga = 1 case number único. Se o admin subir um arquivo com o mesmo
    // case number 2x, mescla em vez de publicar linha duplicada.
    const { rows: recebidas, duplicatesMerged } = _vagasDedupe(validRaw, {caseField:'c'});
    try{
      // v180: a planilha pode ser uma das BUILT-IN (jan2026/jul2025/H-2A) — o
      // botão de importar aparece em todas. Elas NÃO moram em SHEET_EXTRAS:
      // gravar uma chave dessas lá criaria uma planilha fantasma (a H-2A
      // apareceria 2x pro usuário). Built-in é atualizada no array certo e
      // salva pelo funil único `_saveEnrichedSheet` (o mesmo caminho que o
      // robô de enriquecimento já usa há meses).
      const _builtin = {jan2026:"jan", jul2025:"jul", "h2a-jun2026":"h2a", h2a:"h2a"}[safeKey] || null;
      const keyReal = _builtin==="h2a" ? "h2a-jun2026" : safeKey; // "h2a" é apelido da H-2A built-in
      const antes = _builtin ? (getSheet(keyReal)||[]) : (SHEET_EXTRAS[keyReal]||[]);
      const jaExistia = antes.length>0;
      // 🤖 v177-FIX2 / v180: trocar as linhas debaixo do robô de enriquecimento
      // é o mesmo problema de apagar a planilha com ele rodando — ele escreve
      // no array VELHO e o progresso vai pro lixo. Mesma trava cooperativa do
      // DELETE e do botão "Parar"; o autoEnrichCycle agendado logo abaixo
      // recomeça na planilha nova.
      if(_enrichBot.running && _enrichBot.sheetKey===keyReal){
        _enrichBot.running=false;
        _enrichLog(`⏹️ Bot parado automaticamente — planilha "${keyReal}" foi reimportada pelo admin.`,"warn");
      }
      // 📥 v180: chave que JÁ EXISTE é SUBSTITUIÇÃO MESCLADA, nunca troca cega
      // — a régua de "linha mais rica vence" e "case number que não veio no
      // arquivo fica" mora numa função só (_mesclarPlanilha), a MESMA do seed.
      const m = _mesclarPlanilha(antes, recebidas, {sheetKey:keyReal});
      const valid = m.rows;
      if(_builtin){
        if(_builtin==="jan") SHEET_JAN=valid; else if(_builtin==="jul") SHEET_JUL=valid; else SHEET_H2A=valid;
        _saveEnrichedSheet(keyReal, valid); // grava no destino certo da built-in
      } else {
        const fname=DB_SHEETS_META[keyReal]?.file||`${keyReal}.json`;
        if(!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR,{recursive:true});
        _writeFileAtomic(path.join(SHEETS_DIR,fname),JSON.stringify(valid));
        SHEET_EXTRAS[keyReal]=valid;
        // v174: upload do admin É a publicação (antes o registro nascia sem
        // `published` e /api/sheets-list — que exige published===true — escondia
        // a planilha de todo usuário em silêncio).
        const metaAntes=DB_SHEETS_META[keyReal]||{};
        DB_SHEETS_META[keyReal]={...metaAntes,name,file:fname,uploaded:metaAntes.uploaded||Date.now(),
          count:valid.length,uniqueCaseCount:valid.length,enriched:valid.filter(r=>r.ci).length,
          published:true,publishedAt:metaAntes.publishedAt||Date.now(),publishedBy:s.user_email,
          source:jaExistia?"import-admin":"upload",
          importedAt:Date.now(),importedBy:s.user_email,importedRows:m.recebidas,mergedFrom:jaExistia?m.antes:0,
          visaType:String(valid[0]?.visa||metaAntes.visaType||"H-2B").toUpperCase().includes("H-2A")?"H-2A":"H-2B"};
        _writeFileAtomic(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
      }
      const resumo=jaExistia
        ? `${m.atualizadas} linha(s) atualizada(s), ${m.adicionadas} nova(s), ${m.preservadas-m.atualizadas} intocada(s) — e-mail: ${m.emailAntes} → ${m.emailDepois}`
        : `${valid.length} vagas únicas de ${vagas.length} recebidas${duplicatesMerged?`, ${duplicatesMerged} duplicata(s) mesclada(s)`:''}`;
      console.log(`[sheet] ✅ ${jaExistia?`Planilha "${keyReal}" reimportada${_builtin?" (built-in)":""}`:`Nova planilha carregada: ${keyReal}`} (${resumo})`);
      botLog('import','Importação de Planilha',`${jaExistia?'Reimportada':'Criada'} "${keyReal}" por ${s.user_email}: ${resumo}`,'ok');
      addLog(s.user_email,{status:"sistema",jobTitle:`📋 ${jaExistia?'Planilha reimportada':'Nova planilha adicionada'}: ${name}`,company:`${valid.length} vagas — Chave: ${keyReal} (${resumo})`});
      // Dispara enriquecimento automático imediato (não espera o watchdog de 30min)
      setTimeout(()=>PLANILHAS.autoEnrichCycle().catch(e=>console.error("[auto-enrich] trigger upload erro:",e.message)), 3000);
      console.log(`[auto-enrich] 🔔 Enriquecimento de "${keyReal}" agendado em 3s`);
      // 🎯 Se essa é a planilha de Julho 2026 e já existem grupos oficiais
      // importados, aplica na hora — não precisa esperar a próxima importação.
      if(keyReal==="jul2026" && typeof j26ApplyGroupsToSheet==="function"){
        const r = j26ApplyGroupsToSheet();
        if(r.applied>0) console.log(`[grupos-j26] ✅ ${r.applied} grupo(s) já existente(s) aplicado(s) na planilha recém-publicada.`);
      }
      // 📡 v134: vaga nova entrando no sistema tem que avisar quem tem radar
      // ligado casando com ela (v174: os robôs de coleta/publicação e o de
      // vagas novas H-2A avisam do mesmo jeito — mod-planilhas.js). v180: numa
      // reimportação só as vagas REALMENTE novas avisam — ninguém leva push de
      // uma vaga que já estava no site desde ontem.
      const _novasPraRadar=valid.slice(m.preservadas).filter(r=>r.e&&String(r.e).includes("@")); // planilha nova: preservadas=0, avisa de tudo
      registrarVagasNovasNoRadar(_novasPraRadar,`upload:${keyReal}`).catch(e=>console.warn("[radar] notificar upload:",e.message));
      return json(res,200,{ok:true,key:keyReal,builtin:!!_builtin,count:valid.length,total:vagas.length,duplicatesMerged,
        substituiu:jaExistia,atualizadas:m.atualizadas,adicionadas:m.adicionadas,preservadas:m.preservadas,
        importedRows:m.recebidas,comEmailAntes:m.emailAntes,comEmail:m.emailDepois});
    }catch(e){
      console.error(`[sheet] ❌ Falha ao importar "${safeKey}":`,e.message); // safeKey: o keyReal pode nem ter sido calculado ainda
      return json(res,500,{error:"Falha ao gravar a planilha: "+e.message});
    }
  }

  // DELETE /api/admin/sheet/:key — remove planilha extra
  if(pathname.startsWith("/api/admin/sheet/")&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=pathname.split("/").pop();
    if(!SHEET_EXTRAS[key])return json(res,404,{error:"Planilha não encontrada"});
    // 🚨 v177-FIX2 (auditoria 14/09/2026): apagar uma planilha extra enquanto
    // o bot de Enriquecimento ainda roda NELA deixava o loop seguir gastando
    // chamadas ao DOL à toa (SHEET_EXTRAS[key] já não existe mais pra salvar
    // nada) até o ciclo terminar sozinho — mesma trava cooperativa do botão
    // "Parar" (enrich/stop), só que automática.
    if(_enrichBot.running&&_enrichBot.sheetKey===key){
      _enrichBot.running=false;
      _enrichLog(`⏹️ Bot parado automaticamente — planilha "${key}" foi apagada.`,"warn");
    }
    delete SHEET_EXTRAS[key];
    const meta=DB_SHEETS_META[key];
    if(meta?.file){try{fs.unlinkSync(path.join(SHEETS_DIR,meta.file));}catch{}}
    delete DB_SHEETS_META[key];
    fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
    return json(res,200,{ok:true});
  }

  // POST /api/admin/sheet/test-publish-jan — TESTE do dono (07/07/2026): clona
  // a planilha de Jan 2026 (vagas reais já enriquecidas) e publica com a chave
  // "jul2026-teste", só pra validar que o fluxo de "planilha nova aparece pro
  // usuário no Manual e no Automático" funciona de ponta a ponta — sem
  // precisar esperar a coleta real de Julho. Some quando o admin apagar pelo
  // DELETE /api/admin/sheet/:key que já existe (mesmo botão "Excluir" de
  // qualquer planilha extra em Planilhas & Coleta DOL).
  if(pathname==="/api/admin/sheet/test-publish-jan"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    if(!SHEET_JAN.length)return json(res,400,{error:"Planilha de Jan 2026 está vazia — nada pra clonar."});
    const testKey="jul2026-teste";
    const clone=SHEET_JAN.map(r=>({...r,_sheet:testKey}));
    try{
      if(!fs.existsSync(SHEETS_DIR))fs.mkdirSync(SHEETS_DIR,{recursive:true});
      const fname=`${testKey}.json`;
      fs.writeFileSync(path.join(SHEETS_DIR,fname),JSON.stringify(clone));
      SHEET_EXTRAS[testKey]=clone;
      DB_SHEETS_META[testKey]={
        name:"🧪 TESTE — Jul 2026 (cópia de Jan 2026)", file:fname,
        uploaded:Date.now(), count:clone.length, enriched:clone.filter(r=>r.ci).length,
        published:true, publishedAt:Date.now(), visaType:"H-2B", isTest:true,
      };
      fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
      console.log(`[test] 🧪 Planilha de teste "${testKey}" publicada (${clone.length} vagas, cópia de Jan 2026)`);
      return json(res,200,{ok:true,key:testKey,count:clone.length});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/sheet/seed-jul2026 — aplica o jul2026_compact.json bundled
  // mesmo que já exista uma entrada (zoada ou não) no registro. Botão de
  // segurança pra não depender só do boot funcionar direito (KB-086).
  // 🧩 v182 LOTE 8: com planilha JÁ no ar, forçar MESCLA (nunca substitui) —
  // ver seedJul2026FromBundle. A resposta diz o que a mesclagem fez.
  if(pathname==="/api/admin/sheet/seed-jul2026"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const r = seedJul2026FromBundle(true);
    if(!r.ok) return json(res,400,{error:r.reason||"Falha ao semear"});
    return json(res,200,{ok:true, count:r.count, novosGrupos:r.novosGrupos, skipped:r.skipped,
      mesclado:r.mesclado===true, atualizadas:r.atualizadas, adicionadas:r.adicionadas, comEmail:r.comEmail});
  }

    // GET /api/admin/sheet/download/:key — baixar planilha enriquecida como JSON
  if(pathname.startsWith("/api/admin/sheet/download/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=decodeURIComponent(pathname.split("/").pop());
    const sheet=getSheet(key); // v174: fonte única — inclui a H-2A built-in
    if(!sheet||!sheet.length)return json(res,404,{error:"Planilha não encontrada"});
    const fname=`${key}_enriquecida_${new Date().toISOString().slice(0,10)}.json`;
    res.writeHead(200,{
      "Content-Type":"application/json; charset=utf-8",
      "Content-Disposition":`attachment; filename="${fname}"`,
      "Cache-Control":"no-cache",
    });
    return res.end(JSON.stringify(sheet,null,2));
  }

  // GET /api/admin/sheet/stats/:key — estatísticas da planilha
  if(pathname.startsWith("/api/admin/sheet/stats/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=pathname.split("/").pop();
    const sheet=getSheet(key); // v174: fonte única — inclui a H-2A built-in
    if(!sheet||!sheet.length)return json(res,404,{error:"Planilha não encontrada"});
    const cats={};sheet.forEach(r=>{const c=r.k||"other";cats[c]=(cats[c]||0)+1;});
    const states={};sheet.forEach(r=>{const c=r.s||"?";states[c]=(states[c]||0)+1;});
    const comCity=sheet.filter(r=>r.ci).length;
    const comDesc=sheet.filter(r=>r.desc).length;
    return json(res,200,{ok:true,key,
      total:sheet.length,comEmail:sheet.filter(r=>r.e).length,comCity,comDesc,
      categorias:Object.entries(cats).sort((a,b)=>b[1]-a[1]),
      estados:Object.entries(states).sort((a,b)=>b[1]-a[1]).slice(0,10),
      meta:DB_SHEETS_META[key]||null,
    });
  }

  // ── API: Email Intelligence (bounces globais) ──────────
  if(pathname==="/api/admin/email-intelligence"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const invalids = Object.values(DB_INVALID_EMAILS).map(e=>({
      ...e, users: [...(e.users instanceof Set ? e.users : new Set(e.users||[]))]
    })).sort((a,b)=>b.count-a.count);
    const corrections = Object.values(DB_EMAIL_CORRECTIONS).sort((a,b)=>b.count-a.count);
    const tempFails   = Object.values(DB_TEMP_FAILURES).sort((a,b)=>b.count-a.count).slice(0,50);
    // Domínios com mais erros
    const byDomain={};
    invalids.forEach(e=>{ byDomain[e.domain]=(byDomain[e.domain]||0)+1; });
    const topDomains=Object.entries(byDomain).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([d,c])=>({domain:d,count:c}));
    return json(res,200,{
      ok:true,
      totalInvalid:invalids.length,
      totalCorrections:corrections.length,
      totalTemp:Object.keys(DB_TEMP_FAILURES).length,
      invalids: invalids.slice(0,200),
      corrections: corrections.slice(0,100),
      tempFails,
      topDomains,
      lastUpdated: Date.now()
    });
  }

  // Marcar email como inválido manualmente
  if(pathname==="/api/admin/email-intelligence/mark-invalid"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const {email,motivo}=body;if(!email)return json(res,400,{error:"email obrigatório"});
    const now=Date.now();
    DB_INVALID_EMAILS[email.toLowerCase()]={
      email:email.toLowerCase(),domain:email.split('@')[1]||'',
      motivo:motivo||'Marcado manualmente pelo admin',tipo:'manual',
      first:now,last:now,count:1,users:new Set(['admin']),msg:'Manual',status:'invalid'
    };
    const toSave={};
    for(const [k,v] of Object.entries(DB_INVALID_EMAILS)){toSave[k]={...v,users:[...(v.users instanceof Set?v.users:new Set(v.users||[]))]}}
    try{fs.writeFileSync(INVALID_EMAILS_FILE,JSON.stringify(toSave,null,2));}catch{}
    return json(res,200,{ok:true});
  }

  // Remover email da lista negra
  if(pathname.startsWith("/api/admin/email-intelligence/remove/")&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const email=decodeURIComponent(pathname.split('/').pop());
    delete DB_INVALID_EMAILS[email];
    const toSave={};
    for(const [k,v] of Object.entries(DB_INVALID_EMAILS)){toSave[k]={...v,users:[...(v.users instanceof Set?v.users:new Set(v.users||[]))]}}
    try{fs.writeFileSync(INVALID_EMAILS_FILE,JSON.stringify(toSave,null,2));}catch{}
    return json(res,200,{ok:true});
  }

  // ── PWA: manifest, service worker e ícones ────────────
  if(pathname==="/manifest.json"){
    return sendAsset(req,res,"manifest.json","application/manifest+json","public, max-age=86400"); // V951
  }
  if(pathname==="/sw.js"){
    // V951: ETag faz o update-check do SW virar 304; Service-Worker-Allowed preservado
    let a;try{a=getStaticAsset("sw.js");}catch{res.writeHead(404);return res.end("sw.js não encontrado");}
    if(req.headers["if-none-match"]===a.etag){res.writeHead(304,{ETag:a.etag,"Service-Worker-Allowed":"/","Cache-Control":"no-cache, must-revalidate",Vary:"Accept-Encoding"});return res.end();}
    const ae=String(req.headers["accept-encoding"]||"");
    const h={"Content-Type":"application/javascript","Cache-Control":"no-cache, must-revalidate","Service-Worker-Allowed":"/",ETag:a.etag,Vary:"Accept-Encoding"};
    let body=a.raw;
    if(/\bbr\b/.test(ae)){h["Content-Encoding"]="br";body=a.br;}
    else if(/\bgzip\b/.test(ae)){h["Content-Encoding"]="gzip";body=a.gz;}
    h["Content-Length"]=body.length;
    res.writeHead(200,h);return res.end(body);
  }
  // 🔧 FIX CRÍTICO (03/07): extras nunca eram servidos (404) — blindagem não carregava
  if(pathname==="/h2b-extras-user.js"||pathname==="/app.js"){
    // v116: /app.js = todo o JS do corpo do index.html, extraído pra fora
    // (1,3MB inline eram re-parseados a cada abertura = ~14s de travada em
    // celular mediano). Mesmo motor de asset: brotli/gzip + ETag/304.
    return sendAsset(req,res,pathname.slice(1),"application/javascript; charset=utf-8","no-cache, must-revalidate"); // V951
  }
  // Ícones PWA — serve PNG se existir, senão gera SVG inline como fallback
  const ICON_MAP={
    "/icon-192.png":"icon-192.png",
    "/icon-512.png":"icon-512.png",
    "/icon-192-maskable.png":"icon-192-maskable.png",
    "/icon-512-maskable.png":"icon-512-maskable.png",
    "/icon-256.png":"icon-256.png",
    "/icon-384.png":"icon-384.png",
    "/apple-touch-icon.png":"apple-touch-icon.png",
    "/favicon-32.png":"favicon-32.png",
    "/favicon.ico":"favicon-32.png"
  };
  // Print real do aviso do Google — usado no modal educativo pré-login
  if(pathname==="/google-aviso.jpg"){
    try{const img=fs.readFileSync(path.join(__dirname,"google-aviso.jpg"));res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"public, max-age=604800"});return res.end(img);}catch{res.writeHead(404);return res.end();}
  }
  // v18-SEO: banner de preview pra WhatsApp/redes sociais (og:image) — sem
  // ele, links compartilhados do H2BApply apareciam sem nenhuma imagem.
  if(pathname==="/og-image.png"){
    try{const img=fs.readFileSync(path.join(__dirname,"og-image.png"));res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800"});return res.end(img);}catch{res.writeHead(404);return res.end();}
  }
  if(ICON_MAP[pathname]){
    const iconPath=path.join(__dirname,ICON_MAP[pathname]);
    if(fs.existsSync(iconPath)){const data=fs.readFileSync(iconPath);res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800, immutable"});return res.end(data);}
  }
  if(pathname==="/icon-192.png"||pathname==="/icon-512.png"){
    const size=pathname==="/icon-192.png"?192:512;
    const pngPath=path.join(__dirname,pathname.slice(1));
    if(fs.existsSync(pngPath)){
      res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800"});
      return res.end(fs.readFileSync(pngPath));
    }
    // Fallback: gera PNG real (sem dependências externas) compatível com PWA/iOS/push
    try {
      const png = generateIconPNG(size);
      res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800"});
      return res.end(png);
    } catch(e) {
      // Último recurso: SVG
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size*0.2}" fill="#1a56db"/><text x="50%" y="44%" font-family="system-ui,sans-serif" font-size="${size*0.28}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">H2B</text></svg>`;
      res.writeHead(200,{"Content-Type":"image/svg+xml","Cache-Control":"public, max-age=3600"});
      return res.end(svg);
    }
  }

  // ── /api/sheets-list — planilhas disponíveis para o usuário (fixas + extras publicadas) ──
  if(pathname==="/api/sheets-list"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    // DISPONIBILIDADE POR USUÁRIO (2026-07-09): antes cada fonte mostrava só o
    // total bruto da planilha ("2.625 vagas") mesmo que o usuário já tivesse
    // enviado pra metade delas — dava a impressão de que nada era descontado.
    // Agora cada planilha informa também quantas ainda estão DISPONÍVEIS pra
    // ESTE usuário (têm e-mail e ele nunca enviou pra aquele empregador) e
    // quantas ele já enviou. Regra de contagem = a MESMA regra anti-duplicata
    // do motor de envio (por e-mail do empregador), então o número que o
    // usuário vê é o número que de fato vai pra fila.
    const _sentSet = buildUserSentSet(s.user_email);
    const _avail = (rows) => {
      let withEmail=0, sent=0;
      for(const r of rows){ const e=_normEmail(r.e); if(!e||!e.includes("@"))continue; withEmail++; if(_sentSet.has(e))sent++; }
      return {withEmail, sent, available: withEmail-sent};
    };
    const _mk=(key,name,visa,emoji)=>{const rows=getSheet(key)||[];return {key,name,visa,count:rows.length,builtin:true,emoji,..._avail(rows)};};
    const out=[
      _mk("jan2026","Jan 2026","H-2B","☀️"),
      _mk("jul2025","Jul 2025","H-2B","❄️"),
      _mk("h2a-jun2026","H-2A Agricultura","H-2A","🌾"),
    ];
    for(const [k,meta] of Object.entries(DB_SHEETS_META)){
      if(k==="jan2026"||k==="jul2025") continue;
      if(!meta || meta.published!==true) continue;
      const arr=SHEET_EXTRAS[k]||[];
      if(!arr.length) continue;
      const visa=(meta.visaType||arr[0]?.visa||"H-2B").toUpperCase().includes("H-2A")?"H-2A":"H-2B";
      out.push({key:k,name:meta.name||k,visa,count:arr.length,builtin:false,emoji:meta.emoji||(visa==="H-2A"?"🌾":"📋"),historico:meta.historico===true,..._avail(arr)});
    }
    // v51 (dono, 25/07): a H-2B mais RECENTE vem PRIMEIRO (à esquerda,
    // destacada no front). Hoje é jul2026; quando a de janeiro sair e for
    // publicada, ela assume sozinha. Sort estável — o resto mantém a ordem.
    // 📥 v180: o selo "MAIS NOVA" só vale pra planilha de onde dá pra se
    // candidatar HOJE. A planilha recém-saída do DOL entra publicada mas com
    // 0 e-mail (o governo publica a lista antes dos contatos, e o robô de
    // enriquecimento completa vaga a vaga durante dias) — vendê-la como a
    // melhor é mandar o usuário pra uma aba de onde não sai nenhum e-mail.
    // Nesse estado ela viaja com `emEnriquecimento:true` (o front mostra "em
    // preparação", nunca esconde a planilha — o dono quer ver que ela existe)
    // e o selo fica com a H-2B mais nova QUE TEM contato.
    for(const s2 of out)s2.emEnriquecimento=(s2.count>0&&(s2.withEmail||0)===0);
    const _latestKey=latestH2bKey({comEmail:true});
    for(const s2 of out)s2.latest=(s2.key===_latestKey);
    out.sort((a,b)=>(b.latest?1:0)-(a.latest?1:0));
    return json(res,200,{ok:true,sheets:out,latestH2b:_latestKey,latestH2bBruta:latestH2bKey()});
  }

  // ══════════════════ 📥 DOWNLOAD DE PLANILHAS (admin) — v87 ══════════════════
  // Ordem do dono (01/08): "quero baixar TODAS as vagas de uma planilha num
  // documento pesquisável, que abre fácil no celular e no computador, e eu
  // filtro por qualquer campo (email, empresa, estado...)". Admin-only.
  // Duas formas do MESMO dado: HTML pesquisável (abre no navegador, busca ao
  // vivo, cada vaga desenhada como no site) e CSV (abre no Excel/Sheets com
  // filtro de coluna). Fonte única: getSheet(key) — o mesmo dado que o site usa.
  const _sheetExportList=()=>{
    const labelMap={jan2026:{name:"Janeiro 2026 (H-2B)",emoji:"☀️"},jul2025:{name:"Julho 2025 (H-2B)",emoji:"❄️"},"h2a-jun2026":{name:"H-2A Agricultura (Jun 2026)",emoji:"🌾"},jul2026:{name:"Julho 2026 (H-2B)",emoji:"🆕"}};
    const seen=new Set(),out=[];
    const add=(key,name,emoji)=>{
      if(seen.has(key))return;seen.add(key);
      const rows=getSheet(key)||[];if(!rows.length)return;
      const withEmail=rows.filter(r=>r.e&&String(r.e).includes("@")).length;
      out.push({key,name,emoji,count:rows.length,withEmail});
    };
    for(const [k,m] of Object.entries(labelMap)) add(k,m.name,m.emoji);
    for(const [k,meta] of Object.entries(DB_SHEETS_META||{})){
      if(seen.has(k)||meta?.published!==true)continue;
      const visa=(meta.visaType||"H-2B").toUpperCase().includes("H-2A")?"🌾":"📋";
      add(k,meta.name||k,meta.emoji||visa);
    }
    return out;
  };
  if(pathname==="/api/admin/sheets-download-list"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{ return json(res,200,{ok:true,sheets:_sheetExportList()}); }
    catch(e){ return json(res,500,{error:"Erro: "+e.message}); }
  }
  if(pathname==="/api/admin/sheet-download"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const key=String(u.searchParams.get("sheet")||"").trim();
      const format=(u.searchParams.get("format")||"html").toLowerCase();
      const rows=getSheet(key)||[];
      if(!rows.length)return json(res,404,{error:"Planilha vazia ou inexistente."});
      const meta=_sheetExportList().find(x=>x.key===key)||{name:key,emoji:"📋"};
      const nomeArq=`H2BApply_${String(meta.name||key).replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_+|_+$/g,"")}`;
      // Colunas (rótulo → valor por linha). Ordem pensada pro candidato.
      const dolUrl=c=>c&&String(c).startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${c}`:"";
      const salario=r=>r.w?`$${r.w}/${r.wunit||"h"}`:"";
      const COLS=[
        ["Nº do Caso (ETA)",r=>r.c||""],
        ["Empresa",r=>r.n||""],
        ["Cargo",r=>r.t||""],
        ["Estado",r=>r.s||""],
        ["Cidade",r=>r.ci||""],
        ["Email",r=>r.e||""],
        ["Telefone",r=>r.ph||""],
        ["Telefone 2",r=>r.ph2||""],
        ["Salário",salario],
        ["Vagas",r=>r.wk||""],
        ["Início",r=>r.d||""],
        ["Fim",r=>r.de||""],
        ["Categoria",r=>r.k||""],
        ["Visto",r=>r.visa||""],
        ["Status DOL",r=>r.st||""],
        ["Grupo",r=>r.g||""],
        ["Link Oficial DOL",r=>dolUrl(r.c)],
      ];
      if(format==="csv"){
        const csvEsc=v=>{const s2=String(v==null?"":v);return /[",\n;]/.test(s2)?'"'+s2.replace(/"/g,'""')+'"':s2;};
        const linhas=[COLS.map(c=>csvEsc(c[0])).join(",")];
        for(const r of rows)linhas.push(COLS.map(c=>csvEsc(c[1](r))).join(","));
        const csv="﻿"+linhas.join("\r\n"); // BOM p/ Excel abrir acentos certo
        res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="${nomeArq}.csv"`,"Cache-Control":"no-store"});
        return res.end(csv);
      }
      // HTML pesquisável (default)
      const esc=v=>String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
      const cards=rows.map(r=>{
        const campos=COLS.filter(c=>c[0]!=="Empresa"&&c[0]!=="Cargo"&&String(c[1](r)).trim()!=="").map(c=>{
          const val=c[1](r);
          const isLink=c[0]==="Link Oficial DOL";
          const isMail=c[0]==="Email";
          const disp=isLink?`<a href="${esc(val)}" target="_blank" rel="noopener">abrir no site do governo →</a>`:isMail?`<a href="mailto:${esc(val)}">${esc(val)}</a>`:esc(val);
          return `<div class="f"><span class="fl">${esc(c[0])}</span><span class="fv">${disp}</span></div>`;
        }).join("");
        const busca=esc(COLS.map(c=>c[1](r)).join(" ")).toLowerCase();
        return `<article class="vg" data-b="${busca}"><h2>${esc(r.t||"(cargo não informado)")}</h2><div class="co">${esc(r.n||"")}</div>${campos}</article>`;
      }).join("");
      const doc=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(meta.name||key)} — Vagas H2BApply</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#0f172a;--soft:#64748b;--line:#e5e8ec;--green:#059669;--blue:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#131c2e;--ink:#e8eef7;--soft:#93a2b8;--line:#243149;--green:#34d399;--blue:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:14px 16px;z-index:9}
h1{font-size:17px;margin:0 0 3px}.sub{font-size:12.5px;color:var(--soft)}
.search{width:100%;margin-top:10px;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px;font-size:16px;background:var(--bg);color:var(--ink)}
.count{font-size:12px;color:var(--soft);margin-top:6px}
main{max-width:820px;margin:0 auto;padding:14px 16px 60px;display:flex;flex-direction:column;gap:12px}
.vg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.vg h2{font-size:15px;margin:0 0 2px}.co{font-size:13px;color:var(--soft);margin-bottom:8px}
.f{display:flex;gap:10px;padding:3px 0;font-size:13px;border-top:1px solid var(--line)}
.f:first-of-type{border-top:none}.fl{color:var(--soft);min-width:120px;flex-shrink:0}.fv{word-break:break-word}
.fv a{color:var(--blue);text-decoration:none}
.empty{text-align:center;color:var(--soft);padding:40px 0;display:none}
</style></head><body>
<header>
<h1>${esc(meta.emoji||"")} ${esc(meta.name||key)}</h1>
<div class="sub">${rows.length.toLocaleString("pt-BR")} vagas · ${meta.withEmail!=null?meta.withEmail.toLocaleString("pt-BR")+" com email":""} · baixado do H2BApply</div>
<input class="search" id="q" type="search" placeholder="🔎 Pesquisar por email, empresa, estado, cargo..." oninput="filtrar()" autocomplete="off">
<div class="count" id="cnt"></div>
</header>
<main id="lista">${cards}<div class="empty" id="vazio">Nenhuma vaga encontrada para essa pesquisa.</div></main>
<script>
var VG=[].slice.call(document.querySelectorAll('.vg'));var CNT=document.getElementById('cnt');var VZ=document.getElementById('vazio');
function filtrar(){var q=(document.getElementById('q').value||'').toLowerCase().trim();var n=0;
for(var i=0;i<VG.length;i++){var ok=!q||VG[i].getAttribute('data-b').indexOf(q)>=0;VG[i].style.display=ok?'':'none';if(ok)n++;}
CNT.textContent=(q?n+' de '+VG.length:VG.length)+' vagas';VZ.style.display=n?'none':'block';}
filtrar();
</script></body></html>`;
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Disposition":`attachment; filename="${nomeArq}.html"`,"Cache-Control":"no-store"});
      return res.end(doc);
    }catch(e){ return json(res,500,{error:"Erro ao gerar o arquivo: "+e.message}); }
  }

  // ── Sheet routes com categorias dinâmicas ─────────────
  if(pathname==="/api/sheet-meta"){
    const sheet=u.searchParams.get("sheet")||"";const arr=getSheet(sheet);
    // ⚠️ v179: parâmetro inválido não pode sumir calado. `top=abc` virava NaN
    // → Math.max(1,NaN)=NaN → a lista voltava VAZIA ao lado de um contador de
    // milhares ("Nenhuma vaga encontrada" com total 2.206). E `sort` vinha da
    // URL sem lista branca: `sort=shuffle` reembaralhava a cada requisição,
    // então a paginação por skip/top duplicava e PERDIA vaga (varredura real
    // de jul2025: 1.465 únicas e 741 duplicadas de 2.206).
    const _nTop=parseInt(u.searchParams.get("top")||"",10);
    const _nSkip=parseInt(u.searchParams.get("skip")||"",10);
    const top=Number.isFinite(_nTop)?Math.min(2000,Math.max(1,_nTop)):25;
    const skip=Number.isFinite(_nSkip)?Math.max(0,_nSkip):0;
    const _sortReq=(u.searchParams.get("sort")||"").trim();
    const sort=SORTS_VALIDOS.has(_sortReq)?_sortReq:"random";
    // v173: TODOS os filtros (estado/cidade/categoria/cargo/salário/vagas/mês
    // de início/status/grupo/e-mail) passam pelo motor único FILTROS — a
    // MESMA régua da contagem ao vivo (/api/vagas/filtros) e do refill do
    // robô. A busca textual (q) fica com o searchSheet (relevância/região/
    // categoria implícita) — o motor a exclui aqui de propósito.
    // hideSent=1 → o SERVIDOR corta, ANTES da paginação, toda vaga cujo
    // EMPREGADOR (e-mail) o usuário já contatou OU está na fila do automático
    // (regra 8 do dono: enviada ou na fila NUNCA mais aparece, até resetar).
    const f=FILTROS.parse(u.searchParams);
    const hideSent=(u.searchParams.get("hideSent")||"").trim()==="1";
    const baseArr=arr;
    const catTitles={landscape:"Landscape Worker",construction:"Construction Worker",
      housekeeper:"Housekeeper",seafood:"Seafood Processor",farm:"Farm Worker",
      golf:"Golf Course Worker",amusement:"Amusement Park Worker",
      forest:"Forestry Worker",lifeguard:"Lifeguard",
      food:"Food Service / Bartender",ski:"Ski Resort Worker",other:"Seasonal Worker"};
    const _sMeta=getSess(req);
    const _uMeta=_sMeta?.user_email?getUser(_sMeta.user_email):null;
    const _dpMeta=_isDoublePro(_uMeta);
    const _corteMeta=hideSent?_excluirEnviadosFn(_sMeta?.user_email):null;
    const _verEmailMeta=!!(_uMeta&&(isAdminVip(_uMeta)||isVipActive(_uMeta)));
    const preFiltered=FILTROS.filtrar(baseArr,f,{except:["q"],excluir:_corteMeta,isDP:_dpMeta});
    // 🎯 v82: contexto de match (perfil H2B + perfil por visto) do usuário
    // logado — null pra visitante sem sessão/perfil, cai sempre no
    // comportamento de sempre (sem score, sort=match vira ordem estável).
    const matchCtx=_uMeta?buildMatchCtx(_uMeta):null;
    const{total,items,sugestao}=searchSheet(preFiltered,f.q,"","",skip,top,sort,matchCtx);
    let filtered=items; // já paginado corretamente
    // total já é o total filtrado (pré-filtro + searchSheet)
    return json(res,200,{jobs:filtered.map(r=>{
      const st=(r.st||"").toUpperCase();
      // v181: MESMA régua do filtro de visto (mod-filtros: campo `visa` e,
      // quando falta, o prefixo do case — H-300 → H-2A, H-400 → H-2B). Antes
      // a rota tinha a sua própria, e a linha sem o campo saía como H-2B.
      const visa=FILTROS.visaDaLinha(r)||(st.includes("H-2A")?"H-2A":"H-2B");

      const active=!st.includes("WITHDRAWN")&&!st.includes("DENIED")&&!st.includes("EXPIRED")&&!st.includes("INVALIDATED");
      const cat=r.k||"other";
      const occupation=r.t||catTitles[cat]||"Seasonal Worker";
      const emailVal=(r.e||"").toLowerCase().trim();
      const _m=matchCtx?computeJobMatchScore(_matchSignalFromRow(r),matchCtx):null;
      return{
        id:r.c, caseNum:r.c,
        company:r.n||"–", state:r.s||"–", city:r.ci||"",
        zip:r.zip||"", addr:r.addr||"",
        start:r.d||"–", end:r.de||"–",
        // 💎 v179: status no DOL e grupo da loteria são dado EXCLUSIVO do
        // Double Pro — o v177-FIX3 fechou o vazamento na FACETA, mas aqui
        // saíam em texto puro VAGA A VAGA pra qualquer um (inclusive sem
        // cookie nenhum): o cadeado da tela era decorativo e quem é grátis
        // recebia o dado bruto e filtrava no próprio navegador.
        status:_dpMeta?(r.st||"–"):null, category:cat, visa, active,
        grupo:(_dpMeta&&r.g&&/^[A-H]$/.test(r.g))?r.g:null,
        title:occupation, occupation,
        wage:r.w?`$${r.w}/${r.wunit||"h"}`:null,
        wageRaw:r.w||null, wageMax:r.wmax||null,
        wageInfo:r.winfo||null,
        workers:r.wk||null,
        // 🔒 v182 LOTE 10: `hasEmail` (o que a TELA e os filtros usam) nunca muda;
        // o endereço só sai inteiro pra plano ativo/admin.
        email:(emailVal?(_verEmailMeta?emailVal:mascararEmail(emailVal)):null), hasEmail:!!(emailVal&&emailVal.includes("@")),
        emailBloqueado:!_verEmailMeta&&!!emailVal,
        phone:r.ph||null, phone2:r.ph2||null,
        website:r.site||null,
        desc:r.desc||null,
        req:r.req||null,
        soc:r.soc||null, socTitle:r.socT||null,
        hours:r.hrs||null, schedule:r.sched||null,
        fullTime:r.ft||null,
        url:r.c&&r.c.startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${r.c}`:(r.url||null),
        fromSheet:true,
        matchScore:_m?_m.score:null, matchWhy:_m?_m.why:null
      };
    // v179: "de N vagas" agora passa pelo MESMO corte da regra 8 (enviadas /
    // na fila) que o `totalBase` de /api/vagas/filtros já usava — os dois
    // alimentam o MESMO "de N" da mesma tela e divergiam pra quem tem
    // histórico (com centenas de envios, dois denominadores pro mesmo
    // conjunto). Mesma função de corte, nunca uma 2ª conta.
    }),total,remainingTotal:_corteMeta?baseArr.reduce((n,r)=>n+(_corteMeta(r)?0:1),0):baseArr.length,
      skip,sheet,filtrosAtivos:FILTROS.ativos(f),ignorados:f._ignorados||[],sugestoes:sugestao?[sugestao]:[]});
  }

  // Dicionário de rótulos de categoria (PT) — fonte única pros cards/chips
  if(pathname==="/api/category-groups"){
    return json(res,200,{labels:CATEGORY_LABELS});
  }
  // ═══ 🔍 v173: CONTAGEM AO VIVO POR OPÇÃO (busca facetada) ═══
  // GET /api/vagas/filtros?sheet=X&estado=FLORIDA&categoria=food&salarioMin=18…
  // Devolve, numa passada só: total com TODOS os filtros; pra cada
  // dimensão, a contagem de cada opção calculada com todos os OUTROS
  // filtros aplicados (um filtro nunca "elimina" o outro — marcar um 2º
  // estado SOMA); e a disponibilidade de dado por dimensão (planilha sem
  // salário publicado → o front nem oferece o filtro, com aviso honesto).
  // hideSent=1 → contagens já descontam enviadas/na fila (regra 8).
  // cargoBusca/cidadeBusca = busca dentro da lista longa (cargos/cidades).
  if(pathname==="/api/vagas/filtros"){
    const sheet=(u.searchParams.get("sheet")||"").trim();const arr=getSheet(sheet);
    const f=FILTROS.parse(u.searchParams);
    const hideSent=(u.searchParams.get("hideSent")||"").trim()==="1";
    const _sF=getSess(req);
    const _uF=_sF?.user_email?getUser(_sF.user_email):null;
    const _isDPF=_isDoublePro(_uF);
    // ⚡ v179: cache CURTO (5s) por (planilha + versão da planilha + query +
    // plano + usuário). O painel dispara esta rota a cada opção marcada e a
    // cada tecla das buscas de cidade/cargo — sem isso, o mesmo cálculo
    // completo era refeito várias vezes por segundo no processo single-thread.
    // A versão da planilha entra na chave, então o que o robô acabou de
    // enriquecer aparece na contagem seguinte, nunca 5s de dado velho por
    // outro motivo que não o próprio relógio.
    const _cKey=sheet+"\u0000"+_sheetVersionOf(arr)+"\u0000"+arr.length+"\u0000"+u.search+"\u0000"+(_isDPF?1:0)+"\u0000"+(hideSent?(_sF?.user_email||""):"");
    const _hit=_VF_CACHE.get(_cKey);
    if(_hit&&Date.now()-_hit.t<5000)return json(res,200,_hit.body);
    const r=FILTROS.facetas(arr,f,{
      excluir:hideSent?_excluirEnviadosFn(_sF?.user_email):null,
      isDP:_isDPF,
      cargoBusca:(u.searchParams.get("cargoBusca")||"").slice(0,60),
      cidadeBusca:(u.searchParams.get("cidadeBusca")||"").slice(0,60),
    });
    const _body={ok:true,sheet,totalPlanilha:arr.length,...r,filtros:f,ignorados:f._ignorados||[]};
    if(_VF_CACHE.size>200)_VF_CACHE.clear();
    _VF_CACHE.set(_cKey,{t:Date.now(),body:_body});
    return json(res,200,_body);
  }

  // ── Generate cover ────────────────────────────────────
  // v22 (ORDEM DO DONO): /api/generate-cover removido — o "IA gera" era um
  // template fixo escrevendo a candidatura pelo usuário. Resposta clara pra
  // qualquer cliente antigo que ainda chame:
  if(pathname==="/api/generate-cover"&&req.method==="POST"){return json(res,410,{error:"Recurso removido: o texto da candidatura é escrito por você, no seu perfil."});}

  // ── LOGS DO ENVIO AUTOMÁTICO (NEW) ───────────────────
  if(pathname==="/api/auto-logs"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const filters={status:u.searchParams.get("status")||"",state:u.searchParams.get("state")||"",category:u.searchParams.get("category")||"",source:u.searchParams.get("source")||"",q:u.searchParams.get("q")||"",dateFrom:u.searchParams.get("dateFrom")||"",dateTo:u.searchParams.get("dateTo")||"",skip:u.searchParams.get("skip")||"0",top:u.searchParams.get("top")||"50"};
    return json(res,200,getUserLogs(s.user_email,filters));
  }
  // Exportar CSV
  if(pathname==="/api/auto-logs/export"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const csv=exportLogsCSV(s.user_email);
    res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="h2b_logs.csv"',"Content-Length":Buffer.byteLength(csv,"utf8")});
    return res.end(csv);
  }
  // Limpar logs
  if(pathname==="/api/auto-logs"&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    DB_LOGS[s.user_email]=[];persistLogs();return json(res,200,{ok:true});
  }

  // ── 🔐 LOGIN DO PAINEL ADMIN (ordem do dono, 12/09/2026): o painel admin
  // (/admin) passa a ter entrada própria por usuário+senha — só Andrio e
  // Diego, nada de Google aqui. (No MESMO dia, v172c logo abaixo trocou
  // TAMBÉM o cadastro/login do usuário comum pra usuário+senha — o único
  // login que continua Google é o Gmail que se conecta DEPOIS de um plano
  // pago pra ENVIAR candidaturas, /oauth/connect-send/add-sender — nunca
  // mais pra entrar em conta nenhuma, admin ou comum.)
  // Senha nunca fica em texto puro no código: scrypt (memory-hard) com
  // salt próprio por login; ADMIN_PANEL_PASS_ANDRIO/_DIEGO (env, opcional)
  // permitem trocar a senha sem mexer no código — sem env, usa o hash
  // embutido de fábrica.
  if(pathname==="/api/admin-panel/login"&&req.method==="POST"){
    const _ip=_clientIp(req);
    // 🚨 v177-FIX2 (auditoria 14/09/2026): o delay anti-timing de 300ms era
    // SOMADO depois da checagem — usuário inexistente (short-circuit, sem
    // scrypt) respondia em ~300ms puros, enquanto usuário válido com senha
    // errada (roda _verifyPw/scrypt primeiro) respondia mais devagar. Dava
    // pra descobrir se "andrio"/"diego" existe só medindo a latência.
    // _atéTempoMinimo() nivela pro MESMO tempo total sempre.
    const _t0=Date.now();
    const _atéTempoMinimo=async(ms=300)=>{const falta=ms-(Date.now()-_t0);if(falta>0)await new Promise(r=>setTimeout(r,falta));};
    try{
      const d=JSON.parse(await readBody(req));
      const user=String(d.user||"").trim().toLowerCase();
      const senha=String(d.password||"");
      // 🚨 v177-FIX3 (auditoria 14/09/2026): a chave do rate-limit era só o
      // IP, compartilhada entre os 2 ÚNICOS logins possíveis (andrio/diego)
      // — se os 2 admins estiverem atrás do mesmo IP (mesmo escritório/
      // Wi-Fi/VPN), uma sequência de erros de digitação de UM deles
      // consumia o limite do OUTRO também. A chave agora inclui o username
      // tentado — cada admin tem seu próprio contador, sem abrir mão do
      // limite por IP+conta. (Lê o body ANTES do rate-limit — igual toda
      // outra rota — pra nunca consumir a stream duas vezes.)
      if(rateLimit("adminpanel_"+_ip+"_"+user,10,900_000))return json(res,429,{error:"Muitas tentativas. Aguarde 15 minutos."});
      const login=ADMIN_PANEL_LOGINS.find(l=>l.user===user);
      const ok=login&&senha&&(await _verifyPw(senha,login.salt,login.hash));
      if(!ok){await _atéTempoMinimo();return json(res,403,{error:"Usuário ou senha inválidos."});}
      if(!login.email)return json(res,500,{error:`Senha certa, mas ${login.nome} não tem e-mail configurado no ambiente (ADMIN_EMAIL${login.user==="diego"?"_2":""}). Configure e reinicie o servidor.`});
      // 🚨 v177-FIX (auditoria 14/09/2026, ALTA): antes SEMPRE criava/usava a
      // conta pela chave do E-MAIL (login.email) — se o mesmo admin já tinha
      // se cadastrado pelo site (v175/v176, username reservado "andrio"/
      // "diego"), esta rota criava uma SEGUNDA conta paralela (chave
      // diferente: o e-mail), com seu próprio isAdmin/vip/diamante/sessão —
      // e de quebra passava a bloquear o bootstrap do v176 pra sempre (o
      // e-mail já "tem conta" na visão do /api/email/enviar-codigo). Agora
      // prefere a conta que já existe pelo USERNAME reservado (login.user é
      // sempre "andrio"/"diego") QUANDO ela já é admin — nunca duas contas
      // pro mesmo admin daqui pra frente. A resposta HTTP continua expondo
      // o e-mail de verdade (login.email); só a CHAVE interna da sessão muda.
      const _existenteAdmin=getUser(login.user);
      const _key=(_existenteAdmin&&_existenteAdmin.isAdmin)?login.user:login.email;
      if(!getUser(_key))setUser(_key,{email:_key,name:login.nome,created_at:new Date().toISOString(),plan:"free",vip:null,cvs:[],profiles:[],saved:[],onboarded:true,isAdmin:true});
      const sid="adm_"+crypto.randomBytes(16).toString("hex");
      // v183 LOTE 1: admin_email guarda o e-mail REAL do admin mesmo quando a
      // chave interna da conta é o username reservado — sem ele, toda a
      // atribuição financeira (editorFromEmail/isAdminEmail) lia "diego"/
      // "andrio" como se fosse um e-mail e falhava calada.
      sessions[sid]={user_email:_key,admin_email:login.email,user_name:login.nome,created_at:Date.now()};
      persistSessionsDebounced(500);
      console.log(`[admin-panel] 🔐 Login por senha: ${login.user} (${_key}${_key!==login.email?", e-mail real "+login.email:""})`);
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":makeCookieStr(sid)});
      return res.end(JSON.stringify({ok:true,email:login.email}));
    }catch(e){return json(res,500,{error:e.message});}
  }

  // 🆕 CADASTRO/LOGIN DE USUÁRIO COMUM POR USUÁRIO+SENHA (ordem do dono,
  // 12/09/2026 — "não quero que tenha nenhuma ligação com o Google na
  // landing page... ela vai criar conta, vai pedir o nome, sobrenome...
  // não precisa conectar e-mail nenhum ali"): a landing NUNCA MAIS chama
  // o OAuth do Google pra login/cadastro — só usuário+senha, como o
  // painel admin (v172b). O Gmail de VERDADE só entra em cena DEPOIS,
  // quando a pessoa (já com plano pago) conecta o e-mail de ENVIO em
  // /oauth/connect-send — rota separada, TOTALMENTE inalterada.
  // ══ 📧 v175 — VERIFICAÇÃO DE E-MAIL POR CÓDIGO (ordem do dono, 13/09/2026):
  // "a pessoa só pode concluir o cadastro depois de verificar o seu email".
  // Enviar → código de 6 dígitos (5 min) sai pela conta de notificações;
  // Confirmar → token assinado que o /api/cadastro exige. Limites: 60s entre
  // envios, 3 envios/15min por e-mail, 5 tentativas por código, 10 pedidos/h
  // por IP. Resposta sempre honesta: se a conta de envio não está conectada,
  // devolve 503 explicando — nunca finge que mandou.
  if(pathname==="/api/email/enviar-codigo"&&req.method==="POST"){
    const _ip=_clientIp(req);
    if(rateLimit("codigo_"+_ip,30,3600_000))return json(res,429,{error:"Muitos pedidos de código deste aparelho. Aguarde 1 hora."});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const email=String(d.email||"").trim().toLowerCase();
      if(!_isGmail(email))return json(res,400,{error:"Use um Gmail válido (…@gmail.com) — é por ele que o site envia suas candidaturas."});
      if(_findUserByEmail(email))return json(res,409,{error:"Já existe uma conta com esse e-mail. Entre com seu usuário ou use \"Esqueci minha senha\"."});
      // 🔐 v176 (dono, 13/09/2026 — "quando o sistema identificar meu e-mail
      // que é de adm ele não pede verificação... desativa o código pra esse
      // cadastro do usuário andrio que é o adm"): os e-mails de admin
      // (ADMIN_EMAIL/ADMIN_EMAIL_2/ADMIN_EMAILS_EXTRA) são valor que só o
      // DONO configura no servidor — nunca vêm de input de usuário nem
      // aparecem em NENHUMA tela pro público (conferido: não existe no
      // index.html/app.js). O dono ficava TRANCADO do próprio site esperando
      // conectar a conta de notificações (Admin → Notificações) só pra poder
      // mandar um código pra SI MESMO — ovo e galinha (o painel admin nem
      // depende disso, mas criar a conta de USUÁRIO dependia). Bootstrap: se
      // o e-mail é de admin e AINDA NÃO tem conta (checagem logo acima),
      // devolve o token de "e-mail verificado" NA HORA, sem gastar nenhum
      // código. A janela fecha SOZINHA E PRA SEMPRE assim que esse e-mail
      // completar o /api/cadastro — getUser passa a existir e o 409 acima
      // barra igual qualquer e-mail já cadastrado, voltando a exigir código
      // normal pra sempre depois disso. Auditado em log + GLOBAL_EVENTS
      // (nunca em silêncio).
      if(isAdminEmail(email)){
        const token=NOTIF.tokenVerificado("cadastro",email);
        console.log(`[email] 🔐 bootstrap de admin: ${email} confirmado sem código (e-mail de admin, conta ainda não existe)`);
        try{pushGlobalEvent("admin_bootstrap_email",email,`E-mail de admin (${email}) verificado sem código no cadastro — janela fecha assim que a conta nascer`,"warn");}catch(e){}
        return json(res,200,{ok:true,email,autoVerificado:true,token});
      }
      if(!NOTIF.conectada())return json(res,503,{error:"A verificação por e-mail está temporariamente indisponível (conta de envio não conectada). Tente de novo em alguns minutos ou chame o suporte."});
      const pode=NOTIF.podeEnviar("cadastro",email);
      if(!pode.ok)return json(res,429,{error:pode.motivo==="aguarde"?`Aguarde ${pode.segundos}s pra pedir outro código.`:`Limite de códigos atingido pra esse e-mail. Tente de novo em ${Math.ceil(pode.segundos/60)} min.`,segundos:pode.segundos});
      const c=NOTIF.gerarCodigo("cadastro",email);
      const tpl=NOTIF.templateCodigoCadastro({codigo:c.codigo});
      await NOTIF.sendMail({to:email,subject:tpl.subject,text:tpl.text,tipo:"codigo_cadastro"});
      return json(res,200,{ok:true,email,expiraEm:c.expiraEm,reenvioEm:c.reenvioEm});
    }catch(e){console.warn("[email/enviar-codigo]",e.message);return json(res,502,{error:"Não conseguimos enviar o e-mail agora ("+String(e.message).slice(0,80)+"). Tente de novo em instantes."});}
  }
  if(pathname==="/api/email/confirmar"&&req.method==="POST"){
    const _ip=_clientIp(req);
    if(rateLimit("codigoconf_"+_ip,40,3600_000))return json(res,429,{error:"Muitas tentativas. Aguarde um pouco."});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const email=String(d.email||"").trim().toLowerCase();
      const r=NOTIF.confirmarCodigo("cadastro",email,d.codigo);
      if(!r.ok)return json(res,400,{error:r.motivo,expirado:!!r.expirado,cancelado:!!r.cancelado});
      return json(res,200,{ok:true,email,token:r.token});
    }catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }
  // ══ 🔑 v175 — RECUPERAÇÃO DE SENHA pelo e-mail cadastrado ══
  // Resposta GENÉRICA no envio (nunca revela se o e-mail tem conta); o
  // código só sai se a conta existir. Redefinir exige código válido, senha
  // ≥8 e derruba todas as sessões antigas daquela conta.
  if(pathname==="/api/senha/enviar-codigo"&&req.method==="POST"){
    const _ip=_clientIp(req);
    if(rateLimit("senhacod_"+_ip,10,3600_000))return json(res,429,{error:"Muitos pedidos deste aparelho. Aguarde 1 hora."});
    // 🚨 v237m (achado de auditoria — Média, auth): a anti-enumeração desta
    // rota era ILUSÓRIA. O comentário já dizia "mesmo tempo de resposta —
    // sem enumeração", mas só o ramo SEM conta esperava um floor fixo de
    // 400ms — o ramo COM conta fazia um `await NOTIF.sendMail(...)` de
    // VERDADE (chamada de rede real pro Gmail, normalmente MAIS lenta que
    // 400ms) antes de responder, e ainda por cima podia devolver um 429
    // (rate-limit por e-mail) ou um 502 (falha no envio) — 2 status codes
    // que só existiam nesse ramo. Cronometrar a resposta, ou só olhar o
    // status, dava pra descobrir se um e-mail tem conta — o oposto do que
    // a régua 13d/13e (gmail.send-only, nunca lê inbox pra confirmar nada)
    // já tinha decidido que este site NUNCA revela.
    // Corrigido: o e-mail agora sai em FIRE-AND-FORGET (nunca aguardado) —
    // nem o tempo de rede do envio nem uma falha dele chegam a influenciar
    // a resposta HTTP; o rate-limit por e-mail continua valendo pra
    // proteger a caixa de quem tem conta, só que em silêncio (nunca vira
    // um 429 visível). TODO caminho cai no MESMO floor de 400ms e na MESMA
    // resposta genérica — sem conta, com conta, ou rate-limitado, é tudo
    // idêntico pra quem está do outro lado da rede.
    //
    // 🚨🚨 v237q (URGENTE, ordem do dono, 20/09/2026 — usuário real sem
    // receber o código): o v237m criou um efeito colateral sério. O
    // rate-limit por e-mail (NOTIF.podeEnviar — só existe pra conta REAL,
    // porque só é alimentado dentro do `if(u&&...)`) ficou 100% silencioso.
    // Se a pessoa clicasse "reenviar" antes de passar o cooldown (60s) ou
    // depois de esgotar as 3 tentativas em 15min — o MAIS PROVÁVEL de
    // acontecer com alguém ansioso porque o 1º e-mail está demorando —
    // NENHUM código novo era gerado/enviado, mas a tela seguia dizendo
    // "o código chegou lá" toda vez, sem avisar "espera, já mandei um".
    // A pessoa via a MESMA mensagem de sucesso indefinidamente e nunca
    // recebia nada, achando o site quebrado.
    // Correção: um cooldown por E-MAIL DIGITADO (nunca por conta — aplicado
    // ANTES de checar se a conta existe, então é idêntico pra e-mail real
    // ou inventado, sem reabrir a enumeração) usa o `rateLimit()` genérico
    // (2 janelas: 1/60s e 3/15min, mesmos números de sempre) pra decidir se
    // ESTE pedido é um reenvio rápido demais — e, se for, a resposta diz
    // isso com clareza (mesma resposta pra QUALQUER e-mail, exista conta ou
    // não) em vez de fingir sucesso mudo.
    const _t0=Date.now();
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const email=String(d.email||"").trim().toLowerCase();
      if(!email.includes("@"))return json(res,400,{error:"Informe o e-mail cadastrado."});
      if(!NOTIF.conectada())return json(res,503,{error:"A recuperação por e-mail está temporariamente indisponível. Chame o suporte no WhatsApp."});
      // v237q: cooldown UNIFORME por e-mail digitado — roda pra QUALQUER
      // e-mail (com conta ou sem), então nunca vira sinal de enumeração.
      const _cd60=rateLimit("senhacd60_"+email,1,60_000);
      const _cd15=rateLimit("senhacd15_"+email,3,900_000);
      if(_cd60||_cd15){
        const _falta0=400-(Date.now()-_t0);
        if(_falta0>0)await new Promise(r=>setTimeout(r,_falta0));
        return json(res,200,{ok:true,cooldown:true,
          msg:_cd15?"Muitos pedidos de código pra esse e-mail. Aguarde alguns minutos antes de tentar de novo (confira também o spam).":"Se você já pediu um código pra esse e-mail, aguarde 1 minuto antes de pedir outro (confira também o spam)."});
      }
      const u=_findUserByEmail(email);
      // 🚨 v177-FIX (auditoria 14/09/2026, ALTA): isAdminEmail(u.email) só
      // protege conta admin do formato ANTIGO (chave = Gmail real). Uma
      // conta admin do v175/v176 (username reservado, "andrio"/"diego")
      // tem u.email===username (sem @) — isAdminEmail nunca batia, e quem
      // tivesse acesso ao Gmail conectado (emailContato) conseguia pedir
      // código e redefinir a senha da conta admin inteira pelo autoatendimento
      // comum, sem nunca precisar da senha do painel /admin dedicado.
      // isAdminVip(u) cobre os 2 formatos (checa u.isAdmin OU isAdminEmail).
      if(u&&!isAdminVip(u)){
        const c=NOTIF.gerarCodigo("senha",email);
        const tpl=NOTIF.templateCodigoSenha({codigo:c.codigo});
        NOTIF.sendMail({to:email,subject:tpl.subject,text:tpl.text,tipo:"codigo_senha"})
          .catch(e=>console.warn("[senha/enviar-codigo] falha no envio (resposta segue genérica, anti-enumeração):",e.message));
      }
      const _falta=400-(Date.now()-_t0);
      if(_falta>0)await new Promise(r=>setTimeout(r,_falta));
      return json(res,200,{ok:true,msg:"Se existir uma conta com esse e-mail, o código foi enviado. Vale 5 minutos."});
    }catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }
  if(pathname==="/api/senha/redefinir"&&req.method==="POST"){
    const _ip=_clientIp(req);
    if(rateLimit("senharedef_"+_ip,30,3600_000))return json(res,429,{error:"Muitas tentativas. Aguarde um pouco."});
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      const email=String(d.email||"").trim().toLowerCase();
      const nova=String(d.novaSenha||"");
      if(nova.length<8)return json(res,400,{error:"A nova senha precisa ter pelo menos 8 caracteres."});
      const r=NOTIF.confirmarCodigo("senha",email,d.codigo);
      if(!r.ok)return json(res,400,{error:r.motivo});
      const u=_findUserByEmail(email);
      if(!u||isAdminVip(u))return json(res,400,{error:"Conta não encontrada."}); // v177-FIX: mesma régua acima — cobre conta admin dos 2 formatos
      const {salt,hash}=await _hashPw(nova);
      setUser(u.email,{passwordSalt:salt,passwordHash:hash,passwordChangedAt:Date.now()});
      let _derrubadas=0;for(const sid of Object.keys(sessions)){if(sessions[sid]?.user_email===u.email){delete sessions[sid];_derrubadas++;}}
      persistSessionsDebounced(500);
      _authEvent(u.email,"senha_redefinida",`Senha redefinida pelo e-mail cadastrado (${_derrubadas} sessão(ões) antiga(s) derrubada(s))`);
      console.log(`[senha] 🔑 ${u.email} redefiniu a senha pelo e-mail (${_derrubadas} sessões derrubadas)`);
      return json(res,200,{ok:true,username:u.username||u.email});
    }catch(e){return json(res,400,{error:"Corpo inválido: "+e.message});}
  }
  // 🧪 só no npm test: "conecta" uma conta de notificações falsa (o envio
  // real nunca sai — mod-notif grava no outbox). Mesma trava do /api/test/login.
  // 📧 v207 (só teste): cria o estado "conexão da conta de notificações em
  // andamento" — o /oauth/notif-connect real exige GOOGLE_CLIENT_ID/SECRET (o
  // smoke não tem) e é isso que deixa provar o caminho de ERRO do callback.
  if(pathname==="/api/test/notif-state"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{const d=JSON.parse((await readBody(req))||"{}");if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      const s=getSess(req);const st=crypto.randomBytes(8).toString("hex");sessions["__notif__"+st]={ownerEmail:s?.user_email||"",created:Date.now()};
      return json(res,200,{ok:true,state:st});}catch(e){return json(res,400,{error:e.message});}
  }
  // 🧪 v209 (só teste): mesmo papel do notif-state acima, mas pro handshake
  // __connectsend__ (/oauth/connect-send) — prova que os dois sobrevivem a um
  // restart no meio do caminho (ver OAUTH_HANDSHAKE_PREFIXES).
  if(pathname==="/api/test/connectsend-state"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{const d=JSON.parse((await readBody(req))||"{}");if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      const s=getSess(req);const st=crypto.randomBytes(8).toString("hex");sessions["__connectsend__"+st]={ownerEmail:s?.user_email||"",created:Date.now(),fromTab:"plans"};
      return json(res,200,{ok:true,state:st});}catch(e){return json(res,400,{error:e.message});}
  }
  // 🧪 v209 (só teste): diz se um id de sessão específico existe em memória
  // AGORA — usado pra provar que um handshake de OAuth sobreviveu (ou não) a
  // um restart real do processo, sem depender de rede pro Google no callback.
  if(pathname==="/api/test/session-exists"&&req.method==="GET"&&process.env.TEST_LOGIN_TOKEN){
    if(String(u.searchParams.get("token")||"")!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
    const id=String(u.searchParams.get("id")||"");
    return json(res,200,{ok:true,exists:!!sessions[id]});
  }
  // 🧪 v239 (só teste): expõe o resultado de _oauthBase(req) direto — prova o
  // host allowlist (incluindo o domínio oficial h2bapply.com, hardcoded no
  // v239) sem precisar de GOOGLE_CLIENT_ID/SECRET reais (CONFIGURED=false
  // neste ambiente, então bater em /oauth/connect-send de verdade nunca
  // chega a montar a URL do Google pra inspecionar).
  if(pathname==="/api/test/oauth-base"&&req.method==="GET"&&process.env.TEST_LOGIN_TOKEN){
    if(String(u.searchParams.get("token")||"")!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
    return json(res,200,{ok:true,base:_oauthBase(req)});
  }
  if(pathname==="/api/test/notif-conectar"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{const d=JSON.parse((await readBody(req))||"{}");if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      NOTIF.conectar({email:String(d.email||"suporteh2bapply@gmail.com").toLowerCase(),refresh_token:"teste-rt-"+crypto.randomBytes(4).toString("hex"),connectedBy:"smoke-test"});
      return json(res,200,{ok:true,status:NOTIF.status()});}catch(e){return json(res,400,{error:e.message});}
  }
  // 🧪 v179: gancho de teste pro caminho REAL do robô de enriquecimento —
  // o DOL não é alcançável do sandbox, então o smoke aplica a MESMA função
  // que o robô usa (PLANILHAS.aplicarDolNaLinha) numa linha da planilha e
  // salva pela MESMA função (_saveEnrichedSheet). Prova que o índice do
  // motor de filtros enxerga a linha enriquecida SEM reiniciar o servidor
  // (as linhas são mutadas no lugar e o comprimento nunca muda).
  if(pathname==="/api/test/enriquecer-linha"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{const d=JSON.parse((await readBody(req))||"{}");if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      const arr=getSheet(String(d.sheet||""));if(!Array.isArray(arr)||!arr.length)return json(res,404,{error:"planilha vazia"});
      const row=arr.find(r=>String(r.c||"")===String(d.case||""))||arr[0];
      PLANILHAS.aplicarDolNaLinha(row,d.dol||{});
      _saveEnrichedSheet(String(d.sheet||""),arr);
      return json(res,200,{ok:true,row});}catch(e){return json(res,400,{error:e.message});}
  }
  // 🧪 v179: gancho de teste pra `isQueueJobDead` — a função que decide se o
  // robô PULA uma vaga da fila. É chamada no meio do laço de envio automático
  // (que exige plano, Gmail conectado e fila viva), então sem este atalho a
  // regra "exp é experiência, não expiração" só daria pra conferir lendo o
  // código. Mesma trava dos outros /api/test/*.
  if(pathname==="/api/test/vaga-morta"&&process.env.TEST_LOGIN_TOKEN){
    if(String(u.searchParams.get("token")||"")!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
    return json(res,200,{ok:true,motivo:isQueueJobDead(u.searchParams.get("sheet")||"",u.searchParams.get("case")||"")});
  }
  // 🧪 v184 LOTE 2: gancho de teste pro RESSUSCITAR do robô depois de um
  // restart. reactivateOneAutoJob() só roda no boot (e no self-heal do
  // /api/auto/start), e o estado que interessa — job ativo com a fila VAZIA
  // esperando o refill de ~7min — não dá pra montar por rota normal. Aqui o
  // teste semeia o job exatamente nesse estado e chama a MESMA função do
  // boot, sem reiniciar o processo. Mesma trava dos outros /api/test/*.
  if(pathname==="/api/test/auto-job"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      const em=String(d.email||"").toLowerCase().trim();
      if(!em)return json(res,400,{error:"email"});
      if(d.job)setAutoJob(em,d.job);
      if(d.limparTimer&&autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
      let reativado=null;
      if(d.reativar)reativado=reactivateOneAutoJob(em,getAutoJob(em));
      // 🔌 v195 LOTE 13: mesma função que o callback do /oauth/connect-send
      // chama depois de gravar o refresh_token novo — o callback em si exige
      // a ida-e-volta real ao Google, que o smoke nunca faz.
      let retomado=null;
      if(d.reconectar)retomado=retomarAutoAposReconexao(em);
      // 📧 v202 LOTE 20: dispara UM ciclo do motor automático DE VERDADE (a
      // mesma scheduleAuto que o timer de ~7min chama) e ESPERA ele terminar.
      // Sem isto nenhum check jamais viu uma candidatura sair pelo robô: o
      // ciclo é fire-and-forget (setTimeout de 100ms no /api/auto/start, timer
      // de 7min depois), então a suíte não tinha como observar o resultado sem
      // dormir por tempo. Espera o lock REAL do motor (autoSendLock) em vez de
      // um sleep fixo, e limpa o timer do próximo ciclo — um gancho de teste
      // não pode deixar setTimeout de 7min vivo no processo.
      if(d.disparar){
        const _esperarLock=async()=>{const _t0=Date.now();while(autoSendLock.has(em)&&Date.now()-_t0<25_000)await new Promise(r=>setTimeout(r,25));};
        await _esperarLock();
        if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
        scheduleAuto(em);
        await _esperarLock();
        await new Promise(r=>setTimeout(r,60));
        if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
      }
      return json(res,200,{ok:true,reativado,retomado,temTimer:autoTimers.has(em),job:getAutoJob(em)});
    }catch(e){return json(res,400,{error:e.message});}
  }
  // 🧾 v192 LOTE 10 (só teste): re-roda a migração de comprovantes pra provar
  // que ela é IDEMPOTENTE — mesma filosofia do /api/test/seed-merge.
  if(pathname==="/api/test/migrar-comprovantes"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      _migrarComprovantesParaDisco();
      // v240c: "_staged_*" é comprovante em PREPARO (ainda sem pedido dono —
      // ver stageComprovanteFromReq) — não é um arquivo "de pedido" e não
      // deve contar aqui, senão arquivos>comArquivo mesmo com a migração ok.
      let arquivos=0;try{arquivos=fs.readdirSync(COMPROVANTES_DIR).filter(f=>!f.startsWith("_staged_")).length;}catch{}
      return json(res,200,{ok:true,arquivos,
        inlineNaRam:DB_PEDIDOS.filter(x=>typeof x.comprovante==="string"&&x.comprovante).length,
        comArquivo:DB_PEDIDOS.filter(x=>!!x.comprovanteArquivo).length});
    }catch(e){return json(res,400,{error:e.message});}
  }
  // 🌱 v180: gancho de teste pra exercitar a DECISÃO do seed ("esqueleto em
  // /data × bundled enriquecido") e a mesclagem, sem depender do arquivo
  // bundled versionado no repo (que hoje é justamente um esqueleto) e sem
  // escrever nada em disco — mesma filosofia dos outros /api/test/*.
  if(pathname==="/api/test/seed-merge"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{
      const d=JSON.parse((await readBody(req))||"{}");
      if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      return json(res,200,{ok:true,resultado:_seedVenceEsqueleto(String(d.key||"teste"),d.atual||[],d.bundled||[])});
    }catch(e){return json(res,400,{error:e.message});}
  }
  // 🤖 v177: gancho de teste pra exercitar a lógica PURA de montar a
  // pergunta pro Gemini e ler a resposta dele — sem nunca chamar a rede de
  // verdade (mesma filosofia dos outros /api/test/*: o smoke test tem que
  // continuar 100% offline). Prova a lógica que decide CONFERE×DIVERGENCIA
  // com uma resposta do Gemini SIMULADA.
  if(pathname==="/api/test/gemini-check"&&req.method==="POST"&&process.env.TEST_LOGIN_TOKEN){
    try{const d=JSON.parse((await readBody(req))||"{}");if(d.token!==process.env.TEST_LOGIN_TOKEN)return json(res,403,{error:"token"});
      const pedido=d.pedido||{};
      const reqBody=_geminiComprovanteRequestBody(pedido);
      const pc=d.respBody!==undefined?_geminiComprovanteParse(d.respBody,pedido):null;
      return json(res,200,{ok:true,reqBody,pc});}catch(e){return json(res,400,{error:e.message});}
  }

  // 🆕 CADASTRO por usuário+senha (v172c) — v175: TODOS os campos obrigatórios,
  // 1 só WhatsApp e e-mail Gmail CONFIRMADO por código (emailToken) — ordem
  // do dono, 13/09/2026: "cadastro precisa ser obrigatoriamente preenchido
  // completo... apenas 1 número de telefone WhatsApp... a pessoa só pode
  // concluir o cadastro depois de verificar o seu email".
  if(pathname==="/api/cadastro"&&req.method==="POST"){
    const _ip=_clientIp(req);
    if(rateLimit("cadastro_"+_ip,20,900_000))return json(res,429,{error:"Muitas tentativas. Aguarde 15 minutos."});
    try{
      const d=JSON.parse(await readBody(req));
      const username=String(d.username||"").trim().toLowerCase();
      const senha=String(d.password||"");
      const nome=String(d.nome||"").trim().slice(0,80);
      const sobrenome=String(d.sobrenome||"").trim().slice(0,80);
      const email=String(d.email||"").trim().toLowerCase();
      const cidade=String(d.cidade||"").trim().slice(0,80);
      const estado=String(d.estado||"").trim().slice(0,60);
      const pais=String(d.pais||"").trim().slice(0,60);
      const whatsapp=String(d.whatsapp||"").replace(/[^\d+]/g,"").slice(0,20);
      // Sem @ de propósito — nunca pode colidir com um e-mail real.
      if(!/^[a-z0-9_.]{3,30}$/.test(username))return json(res,400,{error:"Nome de usuário precisa ter 3 a 30 letras/números/ponto/underline (sem espaço, sem @)."});
      // 🚨 v172c-SEC: 8 é o mínimo aceitável sem exigir complexidade.
      if(senha.length<8)return json(res,400,{error:"A senha precisa ter pelo menos 8 caracteres."});
      if(!nome||!sobrenome)return json(res,400,{error:"Nome e sobrenome são obrigatórios."});
      const nascISO=_parseNasc(d.dataNascimento);
      if(!nascISO)return json(res,400,{error:"Informe sua data de nascimento (DD/MM/AAAA)."});
      if(!cidade||!estado||!pais)return json(res,400,{error:"Cidade, estado e país são obrigatórios."});
      if(whatsapp.replace(/\D/g,"").length<10)return json(res,400,{error:"Informe seu WhatsApp com DDD (só números, ex.: 5511999999999)."});
      if(!_isGmail(email))return json(res,400,{error:"Informe um Gmail válido (…@gmail.com) — é por ele que o site envia suas candidaturas."});
      // 🚨 v228 (achado de auditoria — Alta): DB_BLOCKED.emails era escrito
      // por /api/admin/ban-email e pelo banir:true do delete-user, mas
      // NENHUMA rota de cadastro/login olhava essa lista — banir um Gmail
      // não impedia a MESMA pessoa recriar conta na hora com o MESMO Gmail
      // de contato (só trocando o username, que é livre). Checado aqui,
      // ANTES do fluxo de verificação de código, pra não fazer alguém
      // banido gastar um código de e-mail à toa.
      if(DB_BLOCKED.emails.includes(email))return json(res,403,{error:"Esse e-mail está banido permanentemente do H2BApply. Se você acredita que isso é um engano, chame o suporte no WhatsApp +55 53 98145-3496."});
      // 🚨 v177-FIX7: o token "e-mail verificado" é assinado com um segredo que
      // NASCE JUNTO COM O PROCESSO — um deploy entre o "confirmar código" e o
      // "criar conta" invalida um token legítimo. A mensagem agora explica.
      if(!NOTIF.validarToken(d.emailToken,"cadastro",email))return json(res,400,{error:"Confirme seu e-mail primeiro: clique em \"Enviar verificação\" e digite o código que chegou no seu Gmail. (Se você já confirmou agora há pouco, o site foi reiniciado no meio do cadastro — é só confirmar de novo, seus dados continuam preenchidos.)"});
      if(_findUserByEmail(email))return json(res,409,{error:"Já existe uma conta com esse e-mail. Entre com seu usuário ou use \"Esqueci minha senha\"."});
      // Cinto-e-suspensório: impossível "roubar" identidade de admin pelo username.
      if(isAdminEmail(username))return json(res,400,{error:"Esse nome de usuário não pode ser usado."});
      if(getUser(username))return json(res,409,{error:"Esse nome de usuário já existe. Escolha outro ou entre na sua conta."});
      // 🔑 usernames reservados (ADMIN_RESERVED_USERNAMES) nascem admin — v175:
      // SÓ com o e-mail confirmado sendo um e-mail de admin (fecha a janela
      // "quem cadastrar primeiro leva o admin" apontada na auditoria de 13/09).
      const _nasceAdmin=ADMIN_RESERVED_USERNAMES.has(username);
      if(_nasceAdmin&&!isAdminEmail(email))return json(res,400,{error:"Esse nome de usuário é reservado. Escolha outro."});
      const {salt,hash}=await _hashPw(senha);
      // 🚨 v172c-SEC: _hashPw é assíncrono — reconfere unicidade antes de gravar.
      if(_findUserByEmail(email))return json(res,409,{error:"Já existe uma conta com esse e-mail."});
      if(getUser(username))return json(res,409,{error:"Esse nome de usuário já existe. Escolha outro ou entre na sua conta."});
      const nomeCompleto=(nome+" "+sobrenome).trim();
      // 🔒 v172: conta nova nasce 100% free (0 manual/0 auto), sem trial nenhum;
      // só ENVIA depois de plano pago + conectar o Gmail em /oauth/connect-send.
      setUser(username,{
        email:username,username,name:nomeCompleto,nome,sobrenome,
        emailContato:email,emailVerificadoEm:Date.now(),
        dataNascimento:nascISO,
        city:cidade,estado,country:pais,
        phone:whatsapp,whatsapp,
        passwordSalt:salt,passwordHash:hash,
        created_at:new Date().toISOString(),plan:"free",vip:null,cvs:[],profiles:[],saved:[],
        onboarded:false,isAdmin:_nasceAdmin,language:"pt", // v199 LOTE 17: o app é só em PT
      });
      const sid="usr_"+crypto.randomBytes(16).toString("hex");
      sessions[sid]={user_email:username,user_name:nomeCompleto,created_at:Date.now()};
      persistSessionsDebounced(500);
      console.log(`[cadastro] 🆕 Conta nova por usuário+senha: ${username} (${email})${_nasceAdmin?" (👑 admin — username reservado + e-mail de admin)":""}`);
      try{ trackJourney(username,'first_login',{detail:"Novo. Cadastro usuário+senha com e-mail confirmado por código",meta:{name:nomeCompleto,email}}); }catch(e){}
      try{ pushGlobalEvent('new_user',username,`Novo: ${nomeCompleto}`,"info"); }catch(e){}
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":makeCookieStr(sid)});
      return res.end(JSON.stringify({ok:true,username,novaConta:true}));
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/login"&&req.method==="POST"){
    const _ip=_clientIp(req);
    if(rateLimit("login_"+_ip,20,900_000))return json(res,429,{error:"Muitas tentativas. Aguarde 15 minutos."});
    // 🚨 v177-FIX2 (auditoria 14/09/2026): mesma correção do admin-panel —
    // o delay anti-timing era somado DEPOIS da checagem (300ms fixos quando
    // a conta não existe — short-circuit sem scrypt — vs 300ms+scrypt quando
    // existe e a senha está errada), vazando por latência se um username
    // tem conta. _atéTempoMinimo() nivela pro mesmo tempo total sempre.
    const _t0=Date.now();
    const _atéTempoMinimo=async(ms=300)=>{const falta=ms-(Date.now()-_t0);if(falta>0)await new Promise(r=>setTimeout(r,falta));};
    try{
      const d=JSON.parse(await readBody(req));
      const username=String(d.username||"").trim().toLowerCase();
      const senha=String(d.password||"");
      // v175: aceita também o E-MAIL cadastrado no lugar do usuário (quem
      // esquece o username ainda entra) — a identidade continua sendo o username.
      const u=getUser(username)||(username.includes("@")?_findUserByEmail(username):null);
      const _ident=u?String(u.email||username):username;
      // 🆘 v172c-UX (12/09/2026): conta ANTIGA (login era só Google, migrada
      // sem passwordHash) tomava a mesma mensagem genérica de "senha errada"
      // que uma senha digitada errada de verdade — pra quem nunca teve senha
      // nenhuma isso é indistinguível de um bug, e o único jeito de destravar
      // (admin rodar /api/admin/set-password) é invisível pro usuário. Avisa
      // direto pra chamar o suporte, sem abrir mão do delay anti-timing.
      const _legado=!!u&&!isAdminEmail(_ident)&&!u.passwordHash;
      // 🚨 v177-FIX2 (auditoria 14/09/2026): /api/senha/enviar-codigo +
      // redefinir JÁ destravam essa conta sozinha (não exigem senha antiga
      // nenhuma) — a mensagem só mandava pro WhatsApp, sem citar o caminho
      // mais rápido que o próprio site já oferece.
      if(_legado){await _atéTempoMinimo();return json(res,403,{error:"Essa conta é de antes da senha (login era só pelo Google) e ainda não tem senha definida. Clique em \"Esqueci minha senha\" pra criar uma agora (mais rápido) ou chame o suporte no WhatsApp +55 53 98145-3496."});}
      const ok=!!u&&!isAdminEmail(_ident)&&(await _verifyPw(senha,u.passwordSalt,u.passwordHash));
      if(!ok){await _atéTempoMinimo();return json(res,403,{error:"Usuário ou senha inválidos."});}
      // 🚨 v237 (achado de auditoria — Alta): /api/account/delete promete no
      // próprio comentário "relogar com o MESMO e-mail restaura tudo
      // automaticamente", mas NENHUM caminho de login jamais limpava
      // accountDeleted. A senha nunca é apagada na exclusão (soft-delete),
      // então o login funcionava normal — mas scheduleAuto() (linha ~4293)
      // continua vendo accountDeleted:true em TODO ciclo e desliga o
      // automático em silêncio, pra sempre, sem o app.js jamais mostrar
      // isso na tela. Quem excluiu a conta por engano (ou achando que era
      // só uma pausa) e voltou ficava com o recurso pago mais importante
      // do site quebrado sem chance de autoatendimento.
      if(u.accountDeleted){
        setUser(_ident,{accountDeleted:false,deletedAt:null});
        addLog(_ident,{status:"sistema",jobTitle:"✅ Conta restaurada (relogou depois de excluir)",company:""});
        try{trackJourney(_ident,'account_restored',{detail:'Usuário relogou depois de ter excluído a própria conta'});}catch{}
        console.log("[account] ✅ Conta restaurada no relogin:",_ident);
      }
      const sid="usr_"+crypto.randomBytes(16).toString("hex");
      sessions[sid]={user_email:_ident,user_name:u.name||_ident,created_at:Date.now()};
      persistSessionsDebounced(500);
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":makeCookieStr(sid)});
      return res.end(JSON.stringify({ok:true,username:_ident}));
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── OAuth ─────────────────────────────────────────────
  // 🚪 v172b (ORDEM DO DONO, 12/09/2026 — "não quero que tenha nenhuma
  // ligação com o Google na landing page"): o login por identidade via
  // Google foi DESLIGADO de vez — cadastro/login viraram usuário+senha
  // (/api/cadastro, /api/login, acima). Esta rota fica só como um
  // dead-end fechado (nunca mais abre o consentimento do Google) pra que
  // ninguém consiga contornar o cadastro novo batendo direto na URL
  // antiga — sem isso, visitantes continuariam consumindo o teto de 100
  // contas de teste do OAuth só de login, o problema que essa mudança
  // resolve. /oauth/connect-send (Gmail de ENVIO, pós-plano pago)
  // continua 100% intocado — é outra rota, outro propósito.
  if(pathname==="/oauth/start"){res.writeHead(302,{Location:"/"});return res.end();}

  if(pathname==="/oauth/callback"){
    const code=u.searchParams.get("code"),error=u.searchParams.get("error");
    const fail=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)});res.end();};
    const _st=u.searchParams.get("state")||"";
    // 📧 v207 (caso real, dono testando na véspera do lançamento): erro do
    // Google no fluxo de ADMIN (conta de notificações) voltava pra LANDING
    // como "Login cancelado." — cara de login de usuário, sem dizer o que
    // fazer. Agora volta pro painel, na aba certa, com o passo a passo.
    if(error&&sessions["__notif__"+_st]){
      delete sessions["__notif__"+_st];
      const _msgN=error==="access_denied"
        ?"Conexão cancelada na tela do Google — nenhuma conta foi conectada. O que fazer: 1. Clique em Conectar conta Google de novo. 2. Na tela do Google, escolha a conta de suporte (não a sua pessoal). 3. Permita \"Enviar e-mail em seu nome\"."
        :`O Google recusou a conexão (${error}). O que conferir no Google Cloud Console → APIs e serviços → Credenciais: 1. A URL de retorno mostrada nesta aba está em "URIs de redirecionamento autorizados" do cliente OAuth do site. 2. Se a tela de permissão está em modo Teste, a conta de suporte está na lista de usuários de teste. Depois clique em Conectar conta Google de novo.`;
      res.writeHead(302,{Location:"/admin?notif=erro&msg="+encodeURIComponent(_msgN)});return res.end();
    }
    if(error)return fail(error==="access_denied"?"Login cancelado.":"Erro OAuth: "+error);
    if(!code)return fail("Código OAuth inválido.");
    // [FIX redirect_uri_mismatch] — detecta se é fluxo add-sender pelo state
    if(sessions["__sender__"+_st]){
      const fail2=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)+"&tab=profile"});res.end();};
      const pending2=sessions["__sender__"+_st];
      if(Date.now()-pending2.created>600_000){delete sessions["__sender__"+_st];return fail2("Sessão expirada. Tente novamente.");}
      const ownerEmail2=pending2.ownerEmail;
      delete sessions["__sender__"+_st];
      // 🚨 v172c-SEC (auditoria de segurança, 12/09/2026 — CRÍTICO real):
      // até aqui, o "state" sozinho era prova suficiente de quem completa
      // o fluxo — sem checar a SESSÃO atual. Um atacante logado como ele
      // mesmo podia iniciar /oauth/add-sender, mandar o link de
      // consentimento do Google pra uma VÍTIMA qualquer (que só precisa
      // clicar "Permitir" — nem precisa ter conta no H2BApply), e o Gmail
      // de VERDADE da vítima ficava vinculado como sender "extra" da conta
      // do atacante (login-CSRF/state-fixation, CWE-352). Exige que quem
      // está navegando AGORA seja a MESMA pessoa que iniciou o fluxo.
      const _sess2=getSess(req);
      const _sessOk2=_sess2?.user_email===ownerEmail2;
      const _sessOutro2=!!_sess2?.user_email&&_sess2.user_email!==ownerEmail2;
      // v237u: sessão sumiu (deploy no meio do caminho) mas o cookie do
      // handshake (h2b_of, vive no navegador) prova que é o MESMO navegador
      // que iniciou — aceita. Sessão de OUTRA pessoa nunca é sobrescrita pelo
      // cookie (continua negando sempre, igual antes).
      if(!_sessOk2&&(_sessOutro2||!_oauthFlowSameBrowser(req,_st))){
        _authEvent(ownerEmail2,"oauth_state_sessao_diferente","Callback de add-sender chegou sem sessão ou com sessão diferente de quem iniciou — bloqueado (possível login-CSRF)");
        return fail2("Sessão inválida ou expirada. Faça login e clique em Conectar Gmail Extra de novo.");
      }
      // Sessão sumiu no meio do caminho (deploy) mas o cookie provou o mesmo
      // navegador — devolve já logada, com o Gmail conectado, em vez de
      // deixar a pessoa de fora tendo feito tudo certo.
      const _cookiesOut2=[clearFlowCookieStr(),...(_sessOk2?[]:[_oauthReloginCookie(ownerEmail2)])];
      try{
        // 🔒 v237w (dono, 20/09/2026 — "cortar o vínculo do Gmail API até o
        // usuário pagar"): defesa em profundidade — o plano pode ter
        // expirado nos ~segundos que a pessoa levou na tela do Google
        // (mesmo padrão do /oauth/connect-send). Sem isso, `/oauth/
        // add-sender` só travava ANTES de ir pro Google (e só quando
        // reauth≠1 — ver comentário lá); aqui fecha a mesma classe de furo
        // no momento em que o vínculo de verdade seria criado.
        const owner2Check=getUser(ownerEmail2);
        if(!owner2Check||!isVipActive(owner2Check)){
          return fail2("Seu plano não está mais ativo. Assine um plano pra conectar um Gmail extra.");
        }
        const tb2=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:_oauthBase(req)+"/oauth/callback",grant_type:"authorization_code"}).toString();
        const{body:tk2}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tb2)}},tb2);
        if(tk2.error)return fail2(tk2.error_description||tk2.error);
        if(!tk2.access_token)return fail2("Token não recebido.");
        const{body:ui2}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tk2.access_token}});
        if(!ui2.email)return fail2("E-mail não obtido.");
        const newEmail2=ui2.email.toLowerCase().trim();
        const owner2=getUser(ownerEmail2)||{};
        // 🐛 v172c: ownerEmail2 é a IDENTIDADE da sessão (username sem @ pra
        // conta nova) — comparar newEmail2 (Gmail real) contra ela nunca dá
        // igual pra conta v172c, deixando essa trava sempre desarmada.
        // resolveSendGmail(owner2) resolve pro Gmail principal de verdade
        // (gmailEmail carimbado, ou o próprio e-mail em conta legada).
        const _principalGmail2=resolveSendGmail(owner2);
        if((_principalGmail2&&newEmail2===_principalGmail2)||newEmail2===ownerEmail2)return fail2("Este é seu email principal. Adicione um Gmail diferente.");
        if(getUser(newEmail2))return fail2("Este Gmail já tem conta no H2BApply. Use outro email.");
        const existing2=owner2.senderEmails||[];
        const jaExiste2=existing2.find(s=>s.email===newEmail2);
        if(jaExiste2){
          const renovados2=existing2.map(s=>s.email===newEmail2?{...s,access_token:tk2.access_token,token_expiry:Date.now()+(tk2.expires_in||3600)*1000,refresh_token:tk2.refresh_token||s.refresh_token||null,tokenExpired:false,blocked:false,active:true,reauthedAt:Date.now()}:s);
          setUser(ownerEmail2,{senderEmails:renovados2});
          console.log(`[sender] 🔄 ${newEmail2} RE-AUTENTICADO para ${ownerEmail2}`);
          trackJourney(ownerEmail2,'sender_reauthed',{detail:`Sender reautenticado: ${newEmail2}`});
          const _safeRe2=JSON.stringify(newEmail2);
          const pageRe2=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail reativado!</title></head><body><script>sessionStorage.setItem('senderReauthed',${_safeRe2});window.location.href='/';<\/script></body></html>`;
          res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(pageRe2),"Cache-Control":"no-cache","Set-Cookie":_cookiesOut2});return res.end(pageRe2);
        }
        const maxSnd3=getMaxSenders(getUser(ownerEmail2)||{});
        if(1+existing2.length>=maxSnd3)return fail2(_msgLimiteSenders(maxSnd3));
        const newSender2={email:newEmail2,label:ui2.name||newEmail2,access_token:tk2.access_token,token_expiry:Date.now()+(tk2.expires_in||3600)*1000,refresh_token:tk2.refresh_token||null,addedAt:Date.now(),active:true,tokenExpired:false,blocked:false};
        if(!newSender2.refresh_token)console.warn(`[sender] ⚠️ refresh_token não recebido para ${newEmail2}`);
        setUser(ownerEmail2,{senderEmails:[...existing2,newSender2]});
        console.log(`[sender] ✅ ${newEmail2} adicionado como sender de ${ownerEmail2}`);
        trackJourney(ownerEmail2,'sender_added',{detail:`Sender adicionado: ${newEmail2}`});
        const _safeEmail2=JSON.stringify(newEmail2);
        const page2=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail adicionado!</title></head><body><script>sessionStorage.setItem('senderAdded',${_safeEmail2});window.location.href='/';<\/script></body></html>`;
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(page2),"Cache-Control":"no-cache","Set-Cookie":_cookiesOut2});return res.end(page2);
      }catch(e2){return fail2("Erro ao adicionar email: "+e2.message);}
    }
    // ── CONECTAR GMAIL PRA ENVIAR (v172) — callback ──────────────────────
    if(sessions["__connectsend__"+_st]){
      const pendingCS=sessions["__connectsend__"+_st];
      const failCS=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)+"&tab="+encodeURIComponent(pendingCS.fromTab||"plans")});res.end();};
      if(Date.now()-pendingCS.created>600_000){delete sessions["__connectsend__"+_st];return failCS("Sessão expirada. Tente conectar de novo.");}
      const ownerEmailCS=pendingCS.ownerEmail;
      delete sessions["__connectsend__"+_st];
      // 🚨 v172c-SEC: mesma falha de login-CSRF do bloco __sender__ acima
      // (ver comentário lá) — sem isso, um atacante com plano pago podia
      // iniciar /oauth/connect-send e induzir uma VÍTIMA a completar o
      // consentimento do Google, vinculando o Gmail de ENVIO real da
      // vítima à conta do atacante (gmail.send — escopo sensível de
      // verdade). Exige sessão atual = quem iniciou o fluxo.
      const _sessCS=getSess(req);
      const _sessOkCS=_sessCS?.user_email===ownerEmailCS;
      const _sessOutroCS=!!_sessCS?.user_email&&_sessCS.user_email!==ownerEmailCS;
      // v237u: mesma resiliência do bloco __sender__ acima — sessão sumida
      // por deploy no meio do caminho é aceita se o cookie do handshake
      // provar o mesmo navegador; sessão de OUTRA pessoa continua negando.
      if(!_sessOkCS&&(_sessOutroCS||!_oauthFlowSameBrowser(req,_st))){
        _authEvent(ownerEmailCS,"oauth_state_sessao_diferente","Callback de connect-send chegou sem sessão ou com sessão diferente de quem iniciou — bloqueado (possível login-CSRF)");
        return failCS("Sessão inválida ou expirada. Faça login e clique em Conectar Gmail de novo.");
      }
      const _cookiesOutCS=[clearFlowCookieStr(),...(_sessOkCS?[]:[_oauthReloginCookie(ownerEmailCS)])];
      try{
        // Defesa em profundidade: o plano pode ter expirado nos ~segundos
        // que a pessoa levou na tela do Google — confere de novo, igual a
        // rota /oauth/connect-send já conferiu antes de redirecionar.
        const ownerCS=getUser(ownerEmailCS);
        if(!ownerCS||!isVipActive(ownerCS)){
          return failCS("Seu plano não está mais ativo. Assine um plano pra conectar o Gmail e enviar candidaturas.");
        }
        const tbCS=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:_oauthBase(req)+"/oauth/callback",grant_type:"authorization_code"}).toString();
        const{body:tkCS}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tbCS)}},tbCS);
        if(tkCS.error)return failCS(tkCS.error_description||tkCS.error);
        if(!tkCS.access_token)return failCS("Token não recebido.");
        const{body:uiCS}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tkCS.access_token}});
        const _emailCS=String(uiCS.email||"").toLowerCase().trim();
        if(!_emailCS)return failCS("E-mail não obtido.");
        // v172c (bug real corrigido, 12/09/2026 — ver resolveSendGmail):
        // conta nova não tem NENHUM Gmail ainda (login é usuário+senha, sem @)
        // — esta é a 1ª conexão dela, aceita a conta Google que a pessoa
        // escolher. Só trava RE-conexão com um Gmail DIFERENTE do que já
        // estava conectado (ou, em conta legada, diferente do e-mail de
        // login, que já era o Gmail real) — aí sim revoga (escopo sensível
        // de verdade) e barra, mesmo padrão de proteção de sempre.
        // v175 (ordem do dono, 13/09/2026): o e-mail cadastrado é o que envia —
        // autorizar outra conta Google é barrado (e o token revogado), com a
        // mensagem dizendo qual é o certo. Conta legada sem e-mail cadastrado
        // segue a regra de sempre (1ª conexão livre, reconexão só com a mesma).
        const _expectedGmailCS=ownerCS.emailContato||resolveSendGmail(ownerCS);
        if(_expectedGmailCS && _emailCS!==_expectedGmailCS){
          try{
            const _rvBCS="token="+encodeURIComponent(tkCS.refresh_token||tkCS.access_token);
            await httpsReq({hostname:"oauth2.googleapis.com",path:"/revoke",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(_rvBCS)}},_rvBCS);
            // 🚨 v177-FIX8 (auditoria 14/09/2026): o evento era gravado no
            // authTimeline de _emailCS — a conta Google que a pessoa escolheu
            // POR ENGANO, que quase nunca existe em DB_USERS. Resultado: o
            // raio-X de autenticação do DONO da conta (o único que alguém abre)
            // nunca via o mismatch. Vai pro dono, citando a conta errada.
            _authEvent(ownerEmailCS,"revoke_mismatch","Conectar-Gmail-pra-enviar revogado: esperava "+_expectedGmailCS+", autenticou "+_emailCS);
          }catch(eRvCS){
            // Revoke falho deixava só um console.warn efêmero — o token da
            // conta errada ficava órfão no Google sem NENHUM rastro. Agora fica
            // registrado na conta do dono, com o erro cru.
            console.warn("[oauth] revoke pós-mismatch (connect-send) falhou:",eRvCS.message);
            try{_authEvent(ownerEmailCS,"revoke_falhou","Revoke do token de "+_emailCS+" (conta errada) NÃO completou: "+String(eRvCS.message||eRvCS).slice(0,160)+" — o acesso pode ter ficado órfão no Google.");}catch{}
          }
          return failCS(`Você entrou com ${_emailCS}, mas o e-mail da sua conta é ${_expectedGmailCS}. Saia do Google e entre com ${_expectedGmailCS} — é ele que envia suas candidaturas.`);
        }
        if(!tkCS.refresh_token && !ownerCS.refresh_token){
          // Google só manda refresh_token com prompt=consent (sempre pedido
          // acima) — mas se por algum motivo não veio E nunca existiu um
          // antes, não dá pra enviar sem sessão ativa; melhor avisar do que
          // fingir que conectou.
          return failCS("O Google não devolveu a permissão de envio. Tente conectar de novo.");
        }
        setUser(ownerEmailCS,{
          gmailEmail: _emailCS,
          refresh_token: tkCS.refresh_token || ownerCS.refresh_token,
          cached_access_token: tkCS.access_token,
          cached_token_expiry: Date.now()+(tkCS.expires_in||3600)*1000,
          rtInvalid:false, rtInvalidAt:null,
          lastConsentAt:Date.now(), scopeVersion:2,
          // 🌱 v195 LOTE 13: o relógio do AQUECIMENTO do Gmail principal é o
          // da CONEXÃO, não o do cadastro (created_at). Desde o v172c o Gmail
          // só é conectado DEPOIS de pagar — uma conta cadastrada há meses
          // conectava um Gmail novinho em folha e entrava sem teto nenhum
          // (cap=null), justo o caso que o aquecimento existe pra proteger.
          // Carimba só na 1ª conexão: o Gmail de envio é PERMANENTE (v172c),
          // então recarimbar numa reconexão zeraria o aquecimento de uma
          // conta já madura.
          ...(ownerCS.gmailConnectedAt?{}:{gmailConnectedAt:Date.now()}),
        });
        // A sessão ATUAL (se existir) já sai pronta pra enviar sem precisar de outro round-trip.
        for(const sid2 of Object.keys(sessions)){const ss2=sessions[sid2];if(ss2.user_email===ownerEmailCS){ss2.access_token=tkCS.access_token;ss2.expires_at=Date.now()+(tkCS.expires_in||3600)*1000;ss2.refresh_token=tkCS.refresh_token||ownerCS.refresh_token;}}
        _authEvent(ownerEmailCS,"login_consent","Conectou Gmail pra enviar (plano pago ativo — v172)");
        console.log(`[oauth] ✅ ${ownerEmailCS} conectou o Gmail pra enviar (plano ${getPlan(ownerCS)})`);
        addLog(ownerEmailCS,{status:"sistema",jobTitle:"✅ Gmail conectado — já pode enviar candidaturas",company:"Conectar Gmail"});
        // 🔌 v195 LOTE 13: robô parado por autenticação volta SOZINHO — a
        // pessoa acabou de fazer exatamente o que o aviso mandou. O
        // `retomarAutoAposReconexao` relê o usuário (o setUser acima já
        // gravou o refresh_token novo) e só religa com automático ativo.
        const _retomado = retomarAutoAposReconexao(ownerEmailCS)==="retomado";
        res.writeHead(302,{Location:"/?gmailConnected=1"+(_retomado?"&autoRetomado=1":"")+"&tab="+encodeURIComponent(pendingCS.fromTab||"plans"),"Set-Cookie":_cookiesOutCS});return res.end();
      }catch(eCS){return failCS("Erro ao conectar o Gmail: "+eCS.message);}
    }
    // ── 📧 v175: CONTA DE NOTIFICAÇÕES (admin) — callback ────────────────
    if(sessions["__notif__"+_st]){
      const pn=sessions["__notif__"+_st];delete sessions["__notif__"+_st];
      const failN=m=>{res.writeHead(302,{Location:"/admin?notif=erro&msg="+encodeURIComponent(m)});res.end();};
      if(Date.now()-pn.created>600_000)return failN("Sessão expirada. Tente conectar de novo.");
      const _sN=getSess(req);const _pN=_sN?.user_email?getUser(_sN.user_email):null;
      const _sessOkN=_sN?.user_email===pn.ownerEmail&&isAdminVip(_pN);
      const _sessOutroN=!!_sN?.user_email&&_sN.user_email!==pn.ownerEmail;
      const _pOwnerN=getUser(pn.ownerEmail);
      // v237u: mesma resiliência dos outros 2 handshakes — sessão sumida por
      // deploy é aceita com o cookie provando o mesmo navegador, contanto que
      // o dono do handshake continue admin (relido fresco, sem depender da
      // sessão morta).
      if(!_sessOkN&&(_sessOutroN||!(_oauthFlowSameBrowser(req,_st)&&isAdminVip(_pOwnerN))))return failN("Sessão inválida — entre no painel e clique em Conectar de novo.");
      const _cookiesOutN=[clearFlowCookieStr(),...(_sessOkN?[]:[_oauthReloginCookie(pn.ownerEmail)])];
      try{
        const tbN=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:_oauthBase(req)+"/oauth/callback",grant_type:"authorization_code"}).toString();
        const{body:tkN}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tbN)}},tbN);
        if(tkN.error)return failN(tkN.error_description||tkN.error);
        if(!tkN.access_token)return failN("Token não recebido.");
        const{body:uiN}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tkN.access_token}});
        const _emailN=String(uiN.email||"").toLowerCase().trim();
        if(!_emailN)return failN("E-mail da conta não obtido.");
        if(!tkN.refresh_token)return failN("O Google não devolveu a permissão permanente (refresh token). Em myaccount.google.com → Segurança → Apps com acesso, remova o H2BApply e conecte de novo.");
        NOTIF.conectar({email:_emailN,refresh_token:tkN.refresh_token,connectedBy:pn.ownerEmail});
        try{logAdminAction(pn.ownerEmail,"notif_connect","(config)",null,{email:_emailN},"Conectou a conta Google de notificações: "+_emailN);}catch(e){}
        res.writeHead(302,{Location:"/admin?notif=ok&email="+encodeURIComponent(_emailN),"Set-Cookie":_cookiesOutN});return res.end();
      }catch(eN){return failN("Erro ao conectar a conta: "+eN.message);}
    }
    // v172c (ORDEM DO DONO, 12/09/2026): login normal virou usuário+senha
    // (/api/login) — /oauth/start nunca mais grava sessions["__p__"+st], e
    // esta rota só existe pros 2 fluxos acima (__sender__/__connectsend__).
    // Nenhum outro estado chega até aqui em uso normal; falha graciosa em
    // vez de manter um fluxo de login-por-Google que nunca mais é aberto.
    return fail("Sessão OAuth inválida ou expirada. Tente novamente.");
  }

  // ══════════════════════════════════════════════════════════
  //  MULTI-SENDER — OAuth para adicionar email extra de envio
  // ══════════════════════════════════════════════════════════

  // Inicia OAuth do email extra — só para quem já está logado
  if(pathname==="/oauth/add-sender"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email)||{};
    // 🔒 v237w (dono, 20/09/2026 — "cortar o vínculo do Gmail API até o
    // usuário pagar"): `reauth=1` (usado só pra RECONECTAR um sender que já
    // existia com token quebrado) pulava o ÚNICO gate desta rota — a quota
    // por plano (getMaxSenders), que só de propósito TAMBÉM barrava quem
    // nunca pagou (FREE = 0). Sem plano ativo, o Google NUNCA é acionado
    // por esta rota — nem pra reconectar (getMaxSenders já cobre o caso
    // normal; isVipActive aqui fecha o furo específico do reauth=1).
    // ANTES de "servidor configurado" — mesma ordem e mesmo motivo do
    // /oauth/connect-send (regra de NEGÓCIO por usuário, não falha
    // operacional; o teste automatizado prova as duas coisas separadas,
    // já que este ambiente não tem GOOGLE_CLIENT_ID/SECRET reais).
    if(!isVipActive(p)){res.writeHead(302,{Location:"/?err="+encodeURIComponent(_msgLimiteSenders(0))});return res.end();}
    if(!CONFIGURED){res.writeHead(302,{Location:"/?err="+encodeURIComponent("OAuth não configurado.")});return res.end();}
    const totalSenders=1+(p.senderEmails||[]).length;
    const maxSnd=getMaxSenders(p);
    const _reauth=String(u.searchParams.get("reauth")||"")==="1";
    if(totalSenders>=maxSnd && !_reauth){res.writeHead(302,{Location:"/?err="+encodeURIComponent(_msgLimiteSenders(maxSnd))});return res.end();}
    const st=crypto.randomBytes(20).toString("hex");
    // Salva o state com o email do dono para vincular no callback
    sessions["__sender__"+st]={ownerEmail:s.user_email,created:Date.now()};
    persistSessions(); // grava no disco (ver ajuste em persistSessions: __sender__ agora sobrevive a restart)
    const qs=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:_oauthBase(req)+"/oauth/callback",response_type:"code",scope:OAUTH_SCOPES,access_type:"offline",prompt:"consent select_account",state:st});
    // v237u: cookie de handshake (independente de `sessions`) pra sobreviver
    // a um deploy que caia no meio da ida-e-volta do Google — ver comentário
    // completo junto de makeFlowCookieStr().
    res.writeHead(302,{Location:"https://accounts.google.com/o/oauth2/v2/auth?"+qs,"Set-Cookie":makeFlowCookieStr(st)});return res.end();
  }

  // ══════════════════════════════════════════════════════════
  //  CONECTAR GMAIL PRA ENVIAR (v172, ORDEM DO DONO, 11/09/2026)
  //  "ninguém vai poder logar e fazer a autenticação [do Gmail] antes de
  //  comprar... depois que ela pagar sim, aí sim ela faz a autenticação
  //  dentro do automático ou dentro do manual" — o gmail.send da conta
  //  PRINCIPAL só é pedido AQUI, nunca no login, e só com plano pago ATIVO
  //  (isVipActive) — checado nesta rota E de novo no callback (defesa em
  //  profundidade contra o plano expirar no meio da ida-e-volta do Google).
  // ══════════════════════════════════════════════════════════
  if(pathname==="/oauth/connect-send"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // 🔒 v172: o plano pago é checado ANTES de "o servidor está configurado" —
    // é uma regra de NEGÓCIO (por usuário), não uma falha operacional; sem
    // essa ordem, um servidor mal configurado mascarava se o gate de plano
    // estava funcionando (o teste automatizado depende dessa ordem pra provar
    // as duas coisas separadamente, já que o ambiente de teste não tem
    // GOOGLE_CLIENT_ID/SECRET reais).
    const p=getUser(s.user_email)||{};
    if(!isVipActive(p)){
      res.writeHead(302,{Location:"/?err="+encodeURIComponent("Você precisa de um plano ativo pra conectar seu Gmail e começar a enviar candidaturas.")+"&tab=plans"});return res.end();
    }
    if(!CONFIGURED){res.writeHead(302,{Location:"/?err="+encodeURIComponent("OAuth não configurado.")});return res.end();}
    const st=crypto.randomBytes(20).toString("hex");
    // Guarda de onde a pessoa veio (aba) pra devolver ela lá depois de conectar.
    const _fromTab=String(u.searchParams.get("from")||"").replace(/[^a-z0-9_-]/gi,"").slice(0,30)||"plans";
    sessions["__connectsend__"+st]={ownerEmail:s.user_email,created:Date.now(),fromTab:_fromTab};
    persistSessions(); // sobrevive a restart, mesmo padrão do __sender__
    // login_hint = o Gmail JÁ conectado (reconexão) ou, pra conta LEGADA cujo
    // e-mail de login já É um Gmail real, o próprio e-mail — nunca o username
    // de login de uma conta v172c (nunca tem @, confundiria a tela do Google
    // sem ajudar em nada). resolveSendGmail devolve null pra quem
    // ainda não conectou nenhum Gmail: aí a pessoa escolhe livremente.
    // v175: o e-mail CADASTRADO (confirmado por código) é o Gmail que envia —
    // vai de login_hint pro Google já cravar a conta certa na tela.
    const _hintCS=p.emailContato||resolveSendGmail(p);
    const qs=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:_oauthBase(req)+"/oauth/callback",response_type:"code",scope:OAUTH_SCOPES,access_type:"offline",prompt:"consent",state:st,...(_hintCS?{login_hint:_hintCS}:{})});
    // v237u: mesmo cookie de handshake do add-sender — este fluxo é o gate
    // pra poder ENVIAR (v172), então uma sessão derrubada por deploy no meio
    // do caminho aqui é ainda mais crítica (bloqueia candidaturas).
    res.writeHead(302,{Location:"https://accounts.google.com/o/oauth2/v2/auth?"+qs,"Set-Cookie":makeFlowCookieStr(st)});return res.end();
  }

  // 📧 v175: inicia a conexão da CONTA DE NOTIFICAÇÕES (Admin → Notificações).
  // Só admin; escopo gmail.send (nunca leitura); prompt=consent garante o
  // refresh_token; select_account deixa escolher a conta de suporte na hora.
  if(pathname==="/oauth/notif-connect"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado."});
    if(!CONFIGURED){res.writeHead(302,{Location:"/admin?notif=erro&msg="+encodeURIComponent("OAuth do Google não configurado no servidor (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).")});return res.end();}
    const st=crypto.randomBytes(20).toString("hex");
    sessions["__notif__"+st]={ownerEmail:s.user_email,created:Date.now()};
    persistSessions();
    const _hintN=NOTIF.status().email||"";
    const qs=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:_oauthBase(req)+"/oauth/callback",response_type:"code",scope:OAUTH_SCOPES,access_type:"offline",prompt:"consent select_account",state:st,...(_hintN?{login_hint:_hintN}:{})});
    // v237u: mesmo cookie de handshake dos outros 2 fluxos.
    res.writeHead(302,{Location:"https://accounts.google.com/o/oauth2/v2/auth?"+qs,"Set-Cookie":makeFlowCookieStr(st)});return res.end();
  }

  // ══════════════════════════════════════════════════════════
  //  🎬 v237x (dono, 20/09/2026 — "eu nunca digito senha em nenhum campo,
  //  nem mesmo autopreenchida"): sem login por Google (v172b) e sem digitar
  //  senha, não existia NENHUM jeito de entrar como a conta de TESTE (ver
  //  v237v/TEST_ACCOUNT_EMAIL) pra gravar o vídeo de compra. LINK MÁGICO
  //  por e-mail — MESMO modelo de confiança que /api/email/enviar-codigo
  //  (cadastro) e a recuperação de senha já usam neste site: prova de
  //  DONO DA CAIXA DE ENTRADA = login, nunca um admin gerando/entregando
  //  link na mão de ninguém. É o próprio Andrio que visita esta URL (só
  //  navegar, sem formulário, sem JS) e recebe o link de entrada no
  //  Gmail ndrkick.3@gmail.com de verdade; clicou no link = provou que é
  //  dono daquela caixa = entra. Pública de propósito (é pra quem AINDA
  //  não tem sessão nenhuma) — mas o alvo é 100% FIXO: NUNCA aceita
  //  e-mail vindo de query string/body/header, só TEST_ACCOUNT_EMAIL.
  //  ESCOPO DELIBERADAMENTE FECHADO: isto NÃO é impersonation geral
  //  (entrar como qualquer usuário real) — só existe UMA conta alvo
  //  possível, hardcoded pela mesma fonte única do v237v. Rate-limit
  //  igual ao resto do site pra ninguém spammar o Gmail do Andrio.
  // ══════════════════════════════════════════════════════════
  if(pathname==="/entrar-conta-teste"&&req.method==="GET"){
    const _ip=_clientIp(req);
    const _pagina=(corpo)=>{res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar — conta de teste</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#1a1a2e;line-height:1.6}</style></head><body>${corpo}</body></html>`);};
    if(rateLimit("entrarteste_"+_ip,5,900_000))return _pagina("<h2>⏳ Muitos pedidos</h2><p>Aguarde 15 minutos e tente de novo.</p>");
    try{
      let loginKey=Object.keys(DB_USERS).find(k=>{
        const uu=DB_USERS[k];
        return uu&&!uu.deleted&&String(uu.emailContato||uu.email||"").toLowerCase()===TEST_ACCOUNT_EMAIL;
      });
      if(!loginKey){
        loginKey="contadeteste";
        if(getUser(loginKey))return _pagina(`<h2>⚠️ Conflito</h2><p>O username "${loginKey}" já existe e não é a conta de teste (${TEST_ACCOUNT_EMAIL}) — verifique manualmente antes.</p>`);
        // Senha aleatória, forte, NUNCA exposta em resposta nenhuma — o
        // login desta conta sempre passa pelo link mágico, nunca por senha.
        const{salt,hash}=await _hashPw(crypto.randomBytes(24).toString("hex"));
        setUser(loginKey,{
          email:loginKey,username:loginKey,name:"Conta De Teste",nome:"Conta",sobrenome:"De Teste",
          emailContato:TEST_ACCOUNT_EMAIL,emailVerificadoEm:Date.now(),
          dataNascimento:"1995-01-01",city:"Recife",estado:"PE",country:"Brasil",
          phone:"5581999999999",whatsapp:"5581999999999",
          passwordSalt:salt,passwordHash:hash,
          created_at:new Date().toISOString(),plan:"free",vip:null,cvs:[],profiles:[],saved:[],
          onboarded:false,isAdmin:false,language:"pt",
        });
        console.log(`[entrar-conta-teste] 🎬 conta de teste criada agora: ${loginKey} (${TEST_ACCOUNT_EMAIL})`);
      }
      const token=crypto.randomBytes(24).toString("hex");
      _loginTesteTokens.set(token,{email:loginKey,expires:Date.now()+10*60_000,used:false});
      if(!NOTIF.conectada())return _pagina("<h2>⚠️ Conta de notificações desconectada</h2><p>O site não consegue mandar e-mail agora — conecte a conta de notificações em Admin → Notificações e tente de novo.</p>");
      await NOTIF.sendMail({to:TEST_ACCOUNT_EMAIL,
        subject:"🎬 Seu link de entrada — H2BApply (conta de teste)",
        text:`Clique no link abaixo pra entrar direto na conta de teste, sem senha nenhuma:\n\n${APP_URL}/entrar-teste?t=${token}\n\nVale 10 minutos e só funciona 1 vez. Se você não pediu, ignore este e-mail.`,
        tipo:"login_conta_teste"});
      return _pagina(`<h2>✅ Link enviado</h2><p>Confira o Gmail <b>${TEST_ACCOUNT_EMAIL}</b> — o link vale 10 minutos e só funciona 1 vez.</p>`);
    }catch(e){return _pagina(`<h2>❌ Erro</h2><p>${String(e.message||e)}</p>`);}
  }
  // Consome o link (GET — a pessoa só clica) e troca por uma sessão de
  // login de verdade. Uso único: o token some da memória assim que usado
  // ou vencido — nunca dá pra reabrir o mesmo link duas vezes.
  if(pathname==="/entrar-teste"&&req.method==="GET"){
    const token=u.searchParams.get("t")||"";
    const pend=_loginTesteTokens.get(token);
    _loginTesteTokens.delete(token);
    if(!pend||pend.used||Date.now()>pend.expires){
      res.writeHead(302,{Location:"/?err="+encodeURIComponent("Link expirado ou já usado — peça um novo em /entrar-conta-teste.")});return res.end();
    }
    const uAlvo=getUser(pend.email);
    const sid="usr_"+crypto.randomBytes(16).toString("hex");
    sessions[sid]={user_email:pend.email,user_name:uAlvo?.name||pend.email,created_at:Date.now()};
    persistSessionsDebounced(500);
    res.writeHead(302,{Location:"/?tab=plans","Set-Cookie":makeCookieStr(sid)});return res.end();
  }

  // [FIX] Alias legado — redireciona para /oauth/callback (unificado)
  if(pathname==="/oauth/add-sender/callback"){
    const _rparams=u.search||"";
    res.writeHead(302,{Location:"/oauth/callback"+_rparams});return res.end();
  }
  // Remove email extra de envio  // Remove email extra de envio
  if(/^\/api\/sender\/[^/]+$/.test(pathname)&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const emailToRemove=decodeURIComponent(pathname.replace("/api/sender/","")).toLowerCase().trim();
    if(emailToRemove===s.user_email)return json(res,400,{error:"Não é possível remover seu email principal."});
    const p=getUser(s.user_email)||{};
    const existing=p.senderEmails||[];
    const _snd=existing.find(x=>x.email===emailToRemove);
    if(!_snd)return json(res,404,{error:"Email não encontrado."});
    setUser(s.user_email,{senderEmails:existing.filter(x=>x.email!==emailToRemove)});
    // v21-PRIV: revoga o token no GOOGLE também (best-effort, não bloqueia a
    // remoção). Antes o app só descartava o token — a permissão continuava
    // ativa na conta Google da pessoa ("acesso de terceiros") pra sempre.
    // Revogar o refresh_token invalida a família inteira de tokens.
    // 🔐 v165 (dono, 02/09/2026 — usuário com "Gmail desconectando sempre"):
    // o /revoke do Google derruba o GRANT INTEIRO daquela conta Google neste
    // app — o grant é por (app, conta Google), NÃO por cópia de token. Se o
    // e-mail removido como EXTRA também é conta de LOGIN de alguém no site
    // (a própria pessoa ou OUTRO usuário), revogar aqui matava o login e o
    // automático daquela conta na hora, sem rastro — "desconectou do nada".
    // Agora: conta que existe como USUÁRIO do site NUNCA sofre revoke ao ser
    // removida como extra — só descartamos o token local (a privacidade v21
    // continua valendo pros extras "puros", que não são conta de ninguém).
    const _tok=_snd.refresh_token||_snd.access_token;
    const _donoLogin=findAccountByRealGmail(emailToRemove);
    if(_tok&&!_donoLogin){
      httpsReq({hostname:"oauth2.googleapis.com",path:"/revoke?token="+encodeURIComponent(_tok),method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"}})
        .then(r=>console.log(`[sender] 🔒 token de ${emailToRemove} revogado no Google (status ${r.status})`))
        .catch(e=>console.warn(`[sender] revoke falhou (${emailToRemove}):`,e.message));
    }else if(_tok&&_donoLogin){
      console.log(`[sender] 🔒 v165: revoke PULADO — ${emailToRemove} é conta de LOGIN de um usuário do site; revogar derrubaria o login/automático dela (grant é por conta Google, não por cópia)`);
      _authEvent(emailToRemove,"revoke_pulado","Removido como e-mail extra de "+s.user_email+" — revoke no Google NÃO feito pra não derrubar seu login/automático");
    }
    _authEvent(s.user_email,"sender_removido","E-mail extra "+emailToRemove+" removido"+(_donoLogin?" (sem revoke no Google — é conta de login de usuário)":" (acesso revogado no Google)"));
    console.log(`[sender] 🗑 ${emailToRemove} removido de ${s.user_email}`);
    return json(res,200,{ok:true});
  }

  // Atualiza label ou active de um email extra
  if(/^\/api\/sender\/[^/]+$/.test(pathname)&&req.method==="PATCH"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const emailToUpdate=decodeURIComponent(pathname.replace("/api/sender/","")).toLowerCase().trim();
    if(emailToUpdate===s.user_email)return json(res,400,{error:"Não é possível editar o email principal aqui."});
    try{
      const d=JSON.parse(await readBody(req));
      const p=getUser(s.user_email)||{};
      const senders=(p.senderEmails||[]).map(x=>x.email===emailToUpdate?{...x,...(d.label!==undefined?{label:String(d.label).slice(0,40)}:{}),...(d.active!==undefined?{active:!!d.active}:{})}:x);
      setUser(s.user_email,{senderEmails:senders});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: Central de Incidentes ─────────────────────────
  if(pathname==="/api/admin/incidents"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const now=Date.now();
      const allUsers=Object.values(DB_USERS||{});
      const incidents=[];
      const missions=[];
      // (TOKEN_INACTIVE_IGNORE_MS/TOKEN_ACTIVE_ALERT_MS removidos — só eram
      // usados pelos blocos de incidente de token, que foram desativados acima.)

      for(const u of allUsers){
        if(!u||!u.email)continue;
        const email=u.email;
        const job=getAutoJob(email);
        const lastSeen=u.lastSeenAt||new Date(u.created_at||0).getTime();
        const inactiveMs=now-lastSeen;

        // ── Token/OAuth expirado: NÃO é mais um "incidente" acionável ──────
        // Decisão do dono (2026-06-28): "token não é um problema" — quem resolve
        // é o USUÁRIO (relogando em h2bapply.com), não o admin. Não há ação real
        // possível aqui (nem "Resolver" faz sentido, nem o dono quer ficar
        // clicando "Notificar"). O aviso automático por e-mail já existe e roda
        // sozinho via authErrorWatchdog (a cada 3h, sem intervenção humana) —
        // então nem a notificação manual fazia falta. Saúde do token continua
        // 100% rastreada em healthState/oauthOk para diagnóstico (Robô de
        // Auditoria, painel de saúde) — só PAROU de poluir a fila de incidentes
        // que o dono precisa revisar e decidir algo sobre. (Blocos antigos que
        // geravam incidents.push/missions.push para 'tok_'/'auth_err_' removidos.)

        // ── Automático travado ───────────────────────────────────
        const WAIT_STATUSES=["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"];
        if(job&&job.active&&job.lastSentAt&&(now-job.lastSentAt)>7200000&&!WAIT_STATUSES.includes(job?.status)){
          const horas=Math.round((now-job.lastSentAt)/3600000);
          incidents.push({
            id:'stuck_'+email, type:'auto_stuck', severity:'warn', status:'open',
            robot:'Automático Gmail', module:'Envio',
            userEmail:email, name:u.name||email,
            title:'Automático travado — sem envios',
            description:`Último envio há ${horas}h. O robô está ativo mas não processa a fila. Pode estar bloqueado silenciosamente pelo Gmail.`,
            suggestedAction:`Verifique os logs do usuário. Se há erros de rate limit, aguarde. Se não há atividade, reinicie o automático.`,
            humanExplanation:`O robô está marcado como ativo mas não envia há ${horas} horas. Isso geralmente indica bloqueio silencioso pelo Gmail ou fila vazia.`,
            options:[
              {label:'Reiniciar automático',action:'restart_auto'},
              {label:'Ignorar por agora',action:'ignore'}
            ],
            createdAt:now
          });
        }

        // ── VIP vencido mas marcado ativo → AUTO-CORREÇÃO (sem incidente) ──
        // FALSO ALARME removido: vip.active é só um rótulo; a fonte da verdade
        // são as expirações (isManualVipActive/isAutoVipActive). getPlan e os
        // limites já voltam ao free sozinhos quando vence — NÃO há acesso
        // indevido a nada pago. E com a regra "10 automáticos grátis/dia para
        // todos", vencer plano não exige nenhuma ação humana. O robô agora
        // apenas sincroniza o rótulo sozinho (o que a sugestão mandava o admin
        // fazer manualmente).
        if(u.vip&&u.vip.active){
          const exp=Math.max(u.vip.manualExpires||0,u.vip.autoExpires||0);
          if(exp>0&&exp<now){
            try{ setUser(email,{vip:{...u.vip,active:false}});
              console.log(`[robô-contábil] 🔄 rótulo vip.active sincronizado (vencido) para ${email}`);
            }catch(e){}
          }
        }

        // ── Sem currículo com automático ativo ───────────────────
        if(job&&job.active&&(!u.cvs||u.cvs.length===0)){
          incidents.push({
            id:'nocv_'+email, type:'no_cv', severity:'info', status:'open',
            robot:'Automático Gmail', module:'Currículo',
            userEmail:email, name:u.name||email,
            title:'Automático ativo sem currículo',
            description:`${u.name||email} está com o automático ligado mas não tem nenhum currículo (PDF) cadastrado. Os envios estão sendo pulados.`,
            suggestedAction:'Instrua o usuário a fazer upload do currículo na aba Perfil.',
            humanExplanation:'O robô não consegue enviar candidaturas porque não há PDF de currículo para anexar. Todos os envios estão sendo ignorados silenciosamente.',
            options:[
              {label:'Notificar usuário',action:'notify_no_cv'},
              {label:'Ignorar',action:'ignore'}
            ],
            createdAt:now
          });
        }

        // ── Muitos erros consecutivos ────────────────────────────
        const health=global._healthMap&&global._healthMap[email];
        if(health&&health.errors>=5){
          incidents.push({
            id:'errs_'+email, type:'too_many_errors', severity:'error', status:'open',
            robot:'Automático Gmail', module:'Envio',
            userEmail:email, name:u.name||email,
            title:`Muitos erros consecutivos: ${health.errors}`,
            description:`O robô de ${u.name||email} acumulou ${health.errors} erros consecutivos. Último erro: ${health.lastError||'desconhecido'}.`,
            suggestedAction:'Verifique os logs do usuário para identificar o tipo de erro predominante.',
            humanExplanation:`Erros repetidos geralmente indicam problema persistente de autenticação, rate limit ou configuração incorreta.`,
            options:[
              {label:'Ver logs',action:'view_logs'},
              {label:'Reiniciar automático',action:'restart_auto'},
              {label:'Ignorar',action:'ignore'}
            ],
            createdAt:now
          });
        }
      }


      // ── Incidentes de emails inválidos ───────────────────────
      const bounceCount=Object.keys(DB_TEMP_FAILURES||{}).length;
      if(bounceCount>=10){
        incidents.push({
          id:'sys_bounces', type:'banco_erro', severity:'warn', status:'open',
          robot:'Robô de Bounce', module:'Emails Inválidos',
          title:`${bounceCount} emails com falha acumulados`,
          description:`A base de emails inválidos acumulou ${bounceCount} entradas. Isso pode indicar problema de qualidade na planilha de vagas.`,
          suggestedAction:'Acesse ⛔ Emails Inválidos para revisar e limpar entradas antigas.',
          humanExplanation:'Emails que retornam erro são acumulados. Se o número está alto, a planilha pode ter muitos endereços incorretos.',
          options:[{label:'Ver emails inválidos',action:'view_invalid'},{label:'Ignorar',action:'ignore'}],
          createdAt:Date.now()
        });
      }

      // ── Aplicar resoluções/exclusões (persistência em memória) ──
      const resolved=global._resolvedIncidents||{};
      const finalIncidents=incidents
        .filter(i=>!resolved[i.id]?.deleted)
        .map(i=>resolved[i.id]
          ?{...i,status:'resolved',resolvedAt:resolved[i.id].resolvedAt,resolvedBy:resolved[i.id].resolvedBy,adminNote:resolved[i.id].note||''}
          :i);
      const finalMissions=missions.filter(m=>!resolved[m.incidentId]);

      // ── Regras aprendidas ────────────────────────────────────
      const rules=global._incidentRules||{};

      const open=finalIncidents.filter(i=>i.status==='open').length;
      const missionsPending=finalMissions.length;

      // ── Painel de saúde do sistema ───────────────────────────
      const health={
        gmail:  allUsers.some(u=>u.cached_token_expiry&&u.cached_token_expiry<Date.now())?'yellow':'green',
        oauth:  allUsers.some(u=>getAutoJob(u.email)?.status==='paused_auth_error')?'yellow':'green',
        bounces: bounceCount>=20?'red':bounceCount>=5?'yellow':'green',
        users:  allUsers.length
      };

      // ── Validação anti-divergência: contador = registros ─────
      const divergencia=(open>0&&finalIncidents.filter(i=>i.status==='open').length===0);

      return json(res,200,{
        ok:true,
        incidents:finalIncidents,
        missions:finalMissions,
        rules,
        health,
        open,
        pending:open,
        missionsPending,
        total:finalIncidents.length,
        divergencia,
        generatedAt:Date.now()
      });
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: resolver incidente específico ──────────────────
  if(pathname.startsWith("/api/admin/incidents/")&&pathname.endsWith("/resolve")&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const id=decodeURIComponent(pathname.split("/api/admin/incidents/")[1].replace("/resolve",""));
      // Persiste resolução em memória (os incidentes são gerados dinamicamente, então apenas logamos)
      if(!global._resolvedIncidents)global._resolvedIncidents={};
      global._resolvedIncidents[id]={resolvedAt:Date.now(),resolvedBy:s.user_email,note:d?.note||""};
      const saveAsRule=d?.saveAsRule;
      if(saveAsRule&&d?.ruleText){
        if(!global._incidentRules)global._incidentRules={};
        const ruleKey=(d.incidentType||id.split('_')[0])+'__'+(d.decision||'ignore');
        if(!global._incidentRules[ruleKey]) global._incidentRules[ruleKey]={count:0};
        global._incidentRules[ruleKey].ruleText=d.ruleText;
        global._incidentRules[ruleKey].decision=d.decision||'ignore';
        global._incidentRules[ruleKey].learnedAt=Date.now();
        global._incidentRules[ruleKey].count=(global._incidentRules[ruleKey].count||0)+1;
        console.log(`[incidents] Regra aprendida: ${ruleKey} — ${d.ruleText}`);
      }
      console.log(`[incidents] Incidente ${id} resolvido por ${s.user_email}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: deletar incidente ──────────────────────────────
  if(pathname.startsWith("/api/admin/incidents/")&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const id=decodeURIComponent(pathname.split("/api/admin/incidents/")[1]);
      if(!global._resolvedIncidents)global._resolvedIncidents={};
      global._resolvedIncidents[id]={resolvedAt:Date.now(),resolvedBy:s.user_email,deleted:true};
      console.log(`[incidents] Incidente ${id} deletado por ${s.user_email}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: limpar todos incidentes resolvidos ─────────────
  if(pathname==="/api/admin/incidents/clear"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    global._resolvedIncidents={};
    console.log(`[incidents] Todos incidentes limpos por ${s.user_email}`);
    return json(res,200,{ok:true});
  }

  // 🔓 v152b — Admin: VER a lista de banidos (o caso Esdras mostrou que o
  // admin não tinha como saber com qual grafia o e-mail estava na lista).
  if(pathname==="/api/admin/banned-emails"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins."});
    return json(res,200,{ok:true,emails:DB_BLOCKED.emails});
  }
  // 🩺 v155 — Admin: POR QUE ESTE E-MAIL NÃO ENTRA? Testa as portas de
  // bloqueio locais de uma vez: ban, conta existe?, flags de trial.
  if(pathname==="/api/admin/diagnostico-login"&&req.method==="GET"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const email=String(u.searchParams.get("email")||"").toLowerCase().trim();
      if(!email.includes("@"))return json(res,400,{error:"email inválido"});
      const usr=getUser(email);
      const problemas=[];const info=[];
      if(DB_BLOCKED.emails.includes(email))problemas.push("🚫 BANIDO (lista de banidos) — desbanir na seção 🚫 abaixo");
      else info.push("✅ NÃO está na lista de banidos");
      if(usr){info.push("✅ Conta EXISTE ("+(usr.name||"sem nome")+", plano "+(usr.plan||"free")+") — login é liberado");}
      else info.push("ℹ️ Conta NÃO existe — a pessoa entraria como CADASTRO NOVO (sempre aceito)");
      if(usr?._trialBlockedByIp||usr?._trialBlockedByGoogleId)info.push("ℹ️ Flag anti-abuso de TRIAL presente — não bloqueia login, só o teste grátis");
      const veredito=problemas.length?("❌ "+problemas.length+" bloqueio(s) encontrado(s) — veja acima"):"✅ NENHUM bloqueio encontrado";
      return json(res,200,{ok:true,email,problemas,info,veredito});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── 💼 MC4-P1 (MASTER COMMAND 4, dono, 28/08/2026): SÓCIOS & ACERTO ────
  // "quanto eu tenho a receber e quanto diego tem a receber?" — a matemática
  // mora em computeSocios() (fonte única, régua do canônico); a tela só mostra.
  if(pathname==="/api/admin/socios"&&req.method==="GET"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{return json(res,200,{ok:true,...computeSocios()});}catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/socios/split"&&req.method==="POST"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const d=JSON.parse(await readBody(req));
      const a=parseFloat(d.andrio),g=parseFloat(d.diego);
      if(!(a>=0)||!(g>=0)||!((a+g)>0))return json(res,400,{error:"Percentuais inválidos: os dois precisam ser ≥ 0 e a soma maior que zero."});
      const antes={...((DB_ADMIN_SETTINGS&&DB_ADMIN_SETTINGS.sociosSplit)||{andrio:50,diego:50})};
      DB_ADMIN_SETTINGS.sociosSplit={andrio:Math.round(a*100)/100,diego:Math.round(g*100)/100};
      persist(ADMIN_SETTINGS_FILE,DB_ADMIN_SETTINGS);
      logAdminAction(s.user_email,"socios_split","(config)",antes,DB_ADMIN_SETTINGS.sociosSplit,`Divisão societária → Andrio ${a}% · Diego ${g}%`);
      return json(res,200,{ok:true,split:DB_ADMIN_SETTINGS.sociosSplit});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── 💼 MC4-P3: DRE MENSAL + relatório executivo + exportação (CSV ;+BOM)
  if(pathname==="/api/admin/dre"&&req.method==="GET"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const dre=computeDreMensal();
      if((u.searchParams.get("fmt")||"")==="csv"){
        const n2=v=>String((Number(v)||0).toFixed(2)).replace(".",",");
        const linhas=["mes;receita;gastos;resultado;receita_andrio;receita_diego;receita_sem_dono;gastos_andrio;gastos_diego;gastos_empresa"];
        for(const m of dre.meses)linhas.push([m.mes,n2(m.receita),n2(m.gastos),n2(m.resultado),n2(m.porSocio.andrio),n2(m.porSocio.diego),n2(m.porSocio.semDono),n2(m.gastosPorPagador.andrio),n2(m.gastosPorPagador.diego),n2(m.gastosPorPagador.empresa)].join(";"));
        linhas.push(["TOTAL",n2(dre.totais.receita),n2(dre.totais.gastos),n2(dre.totais.resultado),"","","","","",""].join(";"));
        res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="dre-mensal-h2bapply.csv"'});
        return res.end("\uFEFF"+linhas.join("\n"));
      }
      return json(res,200,{ok:true,...dre,executivo:relatorioExecutivoDre(dre)});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── 💼 MC5-P3: CSV do livro-caixa pela FONTE ÚNICA (o finExportCSV do
  // front montava CSV cru — sem pedido-vence-caixa, com admins, e "sem
  // dono" virava Andrio na marra). Agora: valor EFETIVO + dono pela mesma
  // régua do acerto (_finValorEfetivo/_finDonoDe) + gastos, com ; e BOM.
  if(pathname==="/api/admin/financeiro/exportar"&&req.method==="GET"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const n2=v=>String((Number(v)||0).toFixed(2)).replace(".",",");
      const cel=v=>{const t2=String(v==null?"":v).replace(/"/g,'""');return /[",;\n]/.test(t2)?'"'+t2+'"':t2;};
      const _pedById={};for(const ped of (DB_PEDIDOS||[])){if(ped&&ped.id)_pedById[ped.id]=ped;}
      const pags=(DB_FINANCEIRO.pagamentos||[]).filter(p2=>p2&&!naoEhReceita(p2.email));
      const _byId={};for(const p2 of pags){if(p2.id)_byId[p2.id]=p2;}
      const linhas=["tipo;data;cliente_descricao;plano_categoria;valor_lancado;valor_efetivo;dono;origem_dono;anulado;nota"];
      for(const p2 of pags){
        const dono=_finDonoDe(p2,_byId,0);
        const dt=String(p2.dataPagamento||p2.data||"").slice(0,10)||(p2.criadoEm?new Date(p2.criadoEm).toISOString().slice(0,10):"");
        linhas.push(["ENTRADA",dt,cel(p2.nome||p2.email||""),cel(p2.plano||""),n2(p2.valor),n2(_finValorEfetivo(p2,_pedById)),dono.dono||"sem dono",dono.modo,p2.anuladoPor?"sim":"",cel(p2.nota||"")].join(";"));
      }
      for(const g2 of (DB_FINANCEIRO.gastos||[])){
        if(!g2)continue;
        const dt=String(g2.dataGasto||g2.data||"").slice(0,10)||(g2.criadoEm?new Date(g2.criadoEm).toISOString().slice(0,10):"");
        linhas.push(["GASTO",dt,cel(g2.descricao||g2.desc||g2.titulo||"Gasto"),cel(g2.categoria||g2.cat||"geral"),"-"+n2(g2.valor),"-"+n2(g2.valor),String(g2.pagoPor||"empresa"),"registro","",cel(g2.nota||"")].join(";"));
      }
      res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="contabilidade-h2bapply.csv"'});
      return res.end("\uFEFF"+linhas.join("\n"));
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── 📕 MC4-P5: FECHAMENTO MENSAL (imutável — 409 pra refechar) ─────────
  if(pathname==="/api/admin/fechamento"&&req.method==="POST"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const d=JSON.parse(await readBody(req));
      const mes=String(d.mes||"").trim();
      const r=_fecharMes(mes,s.user_email); // 🤖 v164: função ÚNICA (rota + automático)
      if(r.erro==="mes_invalido")return json(res,400,{error:"Mês inválido — use o formato AAAA-MM."});
      if(r.erro==="ja_fechado")return json(res,409,{error:`O mês ${mes} já foi fechado em ${String(r.fechamento?.fechadoEm||"").slice(0,10)} por ${r.fechamento?.por||"?"} — fechamento é IMUTÁVEL. Se o dinheiro mudou depois, a divergência aparece na lista e na auditoria do cérebro.`});
      if(r.erro==="sem_movimento")return json(res,400,{error:`O mês ${mes} não tem nenhum movimento no caixa — nada a fechar.`});
      return json(res,200,{ok:true,fechamento:r.fechamento});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/fechamentos"&&req.method==="GET"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{return json(res,200,{ok:true,..._fechamentosComVivo()});}catch(e){return json(res,500,{error:e.message});}
  }
  // 🕰️ MC5-P7 — fecha AGORA todos os meses antigos abertos (o mesmo motor do
  // automático do dia 3; ignorarDia3:true pula a margem, pro admin/vigia).
  if(pathname==="/api/admin/fechamento/auto"&&req.method==="POST"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const d=JSON.parse(await readBody(req)||"{}");
      const r=d.ignorarDia3===true?_autoFecharMesesAntigos(s.user_email):_autoFecharMesAnterior(s.user_email);
      return json(res,200,{ok:true,...r});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── 🩻 v163 (CEO mode, 29/08/2026 — OOM 2GB no Render, "é o mais
  // importante agora"): RAIO-X DE MEMÓRIA. Antes de operar, MEDIR: o que
  // realmente ocupa a RAM deste processo. Tudo calculado SEM copiar dado
  // nenhum — NUNCA JSON.stringify de banco grande aqui (isso por si só
  // dobraria a memória em produção): contagens, soma de .length das
  // strings base64 já residentes e fs.stat dos arquivos em disco.
  if(pathname==="/api/admin/memoria"&&req.method==="GET"){
    const s=getSess(req);const adm=s?.user_email?getUser(s.user_email):null;
    if(!(adm?.isAdmin||isAdminEmail(_sessAdminEmail(s))))return json(res,403,{error:"Só admin."});
    try{
      const MB=v=>Math.round(v/1048576*10)/10;
      const mu=process.memoryUsage();
      // 1) Comprovantes base64 vivendo NA RAM (suspeito nº1 do OOM):
      //    cada pedido/pagamento/gasto com foto carrega a string inteira
      //    pra sempre na memória do processo.
      const _blob=(arr,campos)=>{let n=0,bytes=0;const top=[];
        for(const r of (arr||[])){if(!r)continue;let b=0;for(const c of campos)if(typeof r[c]==="string")b+=r[c].length;
          if(b>0){n++;bytes+=b;top.push({id:r.id||r.userEmail||"?",mb:MB(b)});}}
        top.sort((a,b2)=>b2.mb-a.mb);return {n,mb:MB(bytes),top5:top.slice(0,5)};};
      const comprovantes={
        pedidos:_blob(DB_PEDIDOS,["comprovante"]),
        pagamentos:_blob(DB_FINANCEIRO.pagamentos,["comprovante","img"]),
        gastos:_blob(DB_FINANCEIRO.gastos,["comprovante","img"])
      };
      // 2) Planilhas residentes: linhas reais + estimativa por AMOSTRA
      //    (stringify de 1 linha × nº de linhas — nunca da planilha inteira)
      // 🩹 v240 (achado real, 22/09/2026 — auditoria do 2º alerta de OOM):
      // esta lista só olhava SHEET_EXTRAS — as 3 planilhas NÚCLEO
      // (SHEET_JAN/SHEET_JUL/SHEET_H2A, ~16.400 das ~19.000 vagas
      // residentes) nunca apareciam aqui. O raio-x rodava "limpo" mesmo
      // com o maior consumidor de memória do processo inteiro fora da
      // conta — corrigido pra medir as 4 juntas, mesma técnica de amostra.
      const planilhas=[];
      try{
        const _nucleo={jan2026:SHEET_JAN,jul2025:SHEET_JUL,h2a:SHEET_H2A};
        for(const [k,a] of Object.entries(_nucleo)){if(!Array.isArray(a)||!a.length)continue;
          const amostra=JSON.stringify(a[0]||{}).length;planilhas.push({key:k,linhas:a.length,mbEstimado:MB(amostra*a.length)});}
        for(const k of Object.keys(SHEET_EXTRAS||{})){const a=SHEET_EXTRAS[k];if(!Array.isArray(a)||!a.length)continue;
          const amostra=JSON.stringify(a[0]||{}).length;planilhas.push({key:k,linhas:a.length,mbEstimado:MB(amostra*a.length)});}
      }catch(e){}
      planilhas.sort((a,b)=>b.mbEstimado-a.mbEstimado);
      // 3) Contagens dos bancos residentes (nunca stringify)
      const bancos={usuarios:Object.keys(DB_USERS||{}).length,pedidos:(DB_PEDIDOS||[]).length,
        pagamentos:(DB_FINANCEIRO.pagamentos||[]).length,gastos:(DB_FINANCEIRO.gastos||[]).length,
        historicos:Object.keys(DB_HIST||{}).length};
      // 4) Disco (DATA_DIR): cada entrada com tamanho — dir soma recursiva capada
      const _dirSize=(dir,depth)=>{if(depth>3)return 0;let tot=0;let ents=[];
        try{ents=fs.readdirSync(dir,{withFileTypes:true});}catch(e){return 0;}
        for(const e of ents.slice(0,5000)){const p2=path.join(dir,e.name);
          try{tot+=e.isDirectory()?_dirSize(p2,depth+1):(fs.statSync(p2).size||0);}catch(err){}}
        return tot;};
      const arquivos=[];
      try{for(const e of fs.readdirSync(DATA_DIR,{withFileTypes:true})){
        const p2=path.join(DATA_DIR,e.name);
        try{arquivos.push({nome:e.name+(e.isDirectory()?"/":""),mb:MB(e.isDirectory()?_dirSize(p2,0):fs.statSync(p2).size)});}catch(err){}
      }}catch(e){}
      arquivos.sort((a,b)=>b.mb-a.mb);
      // 5) Dicas honestas derivadas dos números medidos (nunca chute)
      const dicas=[];
      const compMb=Math.round((comprovantes.pedidos.mb+comprovantes.pagamentos.mb+comprovantes.gastos.mb)*10)/10;
      const compN=comprovantes.pedidos.n+comprovantes.pagamentos.n+comprovantes.gastos.n;
      if(compMb>=30)dicas.push(`⚠️ ${compMb}MB de comprovantes base64 vivem PERMANENTEMENTE na RAM (${compN} arquivo(s)) — candidato nº1 a migrar pra disco com leitura sob demanda.`);
      const planLinhas=planilhas.reduce((s2,p2)=>s2+p2.linhas,0);
      const planMb=planilhas.reduce((s2,p2)=>s2+p2.mbEstimado,0);
      if(planMb>=40)dicas.push(`ℹ️ Planilhas (núcleo + extras) somam ~${Math.round(planMb)}MB estimados residentes, ${planLinhas} vaga(s) em ${planilhas.length} planilha(s) — necessárias pra busca instantânea; a estimativa é por AMOSTRA (1 linha × total) e tende a ficar ABAIXO do custo real de objeto em V8, então trate como piso, não teto.`);
      if(MB(mu.rss)-MB(mu.heapUsed)>=300)dicas.push(`ℹ️ rss ${MB(mu.rss)}MB vs heap usado ${MB(mu.heapUsed)}MB: a diferença é buffer/nativo/fragmentação — picos transientes (coleta ZIP, backup gzip) contam aqui.`);
      if(!dicas.length)dicas.push("✅ Nenhum ofensor óbvio de memória nos números medidos agora — se o rss estiver alto mesmo assim, o vilão é pico transiente (compare este raio-x logo após um deploy vs horas depois).");
      return json(res,200,{ok:true,
        processo:{rssMB:MB(mu.rss),heapUsadoMB:MB(mu.heapUsed),heapTotalMB:MB(mu.heapTotal),externosMB:MB(mu.external||0),buffersMB:MB(mu.arrayBuffers||0),uptimeHoras:Math.round(process.uptime()/360)/10,node:process.version},
        comprovantes,planilhas:planilhas.slice(0,12),bancos,arquivos:arquivos.slice(0,20),dicas});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // 🚫 v153 — Admin: BANIR e-mail explicitamente (ordem do dono: ban só
  // quando ele mandar; o auto-ban do delete-account foi removido).
  if(pathname==="/api/admin/ban-email"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const emailLow=String(d.email||"").trim().toLowerCase();
      if(!emailLow.includes("@"))return json(res,400,{error:"email inválido"});
      if(isAdminEmail(emailLow))return json(res,403,{error:"Não dá pra banir um e-mail de admin."});
      if(!DB_BLOCKED.emails.includes(emailLow)){
        DB_BLOCKED.emails.push(emailLow);
        persist(BLOCKED_FILE,DB_BLOCKED);
      }
      logAdminAction(s.user_email,"ban_email",emailLow,null,null,`E-mail banido permanentemente (explícito)`);
      console.log(`[admin] 🚫 Email banido permanentemente por ${s.user_email}: ${emailLow}`);
      return json(res,200,{ok:true,banned:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: desbanir email ─────────────────────────────────
  if(pathname==="/api/admin/unban-email"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins podem desbanir."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      const emailLow=email.trim().toLowerCase();
      DB_BLOCKED.emails=DB_BLOCKED.emails.filter(e=>e!==emailLow);
      persist(BLOCKED_FILE,DB_BLOCKED);
      console.log(`[admin] ✅ Email desbanido: ${emailLow}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: ver histórico anti-abuse de trial ──────────────
  if(pathname==="/api/admin/trial-abuse"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins."});
    // IPs com múltiplas contas usando trial
    const suspectIps=Object.entries(DB_TRIAL_USED.ips||{})
      .filter(([,emails])=>emails.length>1)
      .map(([ip,emails])=>({ip,emails,count:emails.length}))
      .sort((a,b)=>b.count-a.count);
    return json(res,200,{ok:true,phones:DB_TRIAL_USED.phones||{},ips:DB_TRIAL_USED.ips||{},suspectIps,totalPhones:Object.keys(DB_TRIAL_USED.phones||{}).length,totalIps:Object.keys(DB_TRIAL_USED.ips||{}).length});
  }

  // ── Admin: revogar trial de usuário específico ────────────
  if(pathname==="/api/admin/revoke-trial"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,reason}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      const u=getUser(email);if(!u)return json(res,404,{error:"Usuário não encontrado"});
      // Para o automático imediatamente
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      const job=getAutoJob(email);
      if(job?.active) setAutoJob(email,{...job,active:false,status:"paused_no_vip",finishedAt:Date.now()});
      // Revoga VIP/trial
      setUser(email,{plan:"free",vip:{active:false,manualExpires:0,autoExpires:0,revokedAt:Date.now(),revokedBy:s.user_email,revokeReason:reason||"Trial abuse"}});
      addLog(email,{status:"sistema",jobTitle:"⛔ Trial revogado pelo admin",company:reason||"Uso indevido de trial detectado"});
      console.log(`[trial] ⛔ Trial de ${email} revogado por ${s.user_email}: ${reason||"abuse"}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: notificar usuário com paused_auth_error (1-click) ──────────────
  if(pathname==="/api/admin/notify-auth-error"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      console.log(`[admin] 📧 Email auth_error enviado para ${email} por ${s.user_email}`);
      return json(res,200,{ok:true,message:`Email enviado para ${email}`});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: pedidos críticos (pendentes >24h) ──────────────────────────────
  if(pathname==="/api/admin/pedidos-criticos"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const now=Date.now();
    const criticos=(DB_PEDIDOS||[]).filter(pd=>pd.status==="pendente"&&(now-(pd.createdAt||0))>24*3600_000)
      .map(pd=>({id:pd.id,userEmail:pd.userEmail,plano:pd.plano,valor:pd.valorTotal,
        horas:Math.round((now-(pd.createdAt||0))/3600000),createdAt:pd.createdAt}))
      .sort((a,b)=>b.horas-a.horas);
    return json(res,200,{ok:true,criticos,total:criticos.length});
  }

  // ── ADMIN: configurações pessoais de admin (intervalo, limites por sender) ──

  // ── 🩺 ROTAS DE SAÚDE/OPERAÇÃO — extraídas para src/routes/admin-health.js (Fase 1 · Módulo 5)
  if(await handleAdminHealthRoutes(req,res,pathname)) return;
  if(await handleAdminV2Routes(req,res,pathname)) return;

  // ── M08: Marcar ação admin no log ─────────────────────────
  // (helper usado internamente, mas também exposto como webhook)
  function _logAdminAction(adminEmail,action,target,detail){
    if(!global._adminActionLog)global._adminActionLog=[];
    global._adminActionLog.unshift({ts:Date.now(),admin:adminEmail,action,target:target||"",detail:detail||""});
    if(global._adminActionLog.length>500)global._adminActionLog.length=500;
  }

  // ── Admin: financeiro (entradas + gastos) ────────────────
  if(pathname==="/api/admin/financeiro"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    // Retornar sem imagens (muito pesado) — imagens ficam nos pedidos
    // Retorna SEMPRE sem imagem base64 (imagens só via /api/pedido/:id)
    const stripImg = arr => (arr||[]).map(p=>{const c={...p};delete c.img;delete c.comprovante;return c;});
    const slim={
      pagamentos: stripImg(DB_FINANCEIRO.pagamentos),
      gastos:     stripImg(DB_FINANCEIRO.gastos),
      repasses:   stripImg(DB_FINANCEIRO.repasses), // MC5-P5: repasse agora pode ter comprovante — base64 só via /api/admin/repasse/:id
    };
    // ── Resumo GIFT/CÓDIGO: NÃO conta dinheiro nem como pagante. Categoria
    // separada — quantos usuários ativaram por código e quantos dias no total.
    // Fonte da verdade: vip.source==='code'.
    const now=Date.now();
    let codGift={usuarios:0, ativos:0, diasTotal:0, lista:[]};
    for(const u of Object.values(DB_USERS)){
      if((u.vip?.source||"")!=="code") continue;
      codGift.usuarios++;
      const ativo=isVipActive(u);
      if(ativo) codGift.ativos++;
      // dias concedidos pelo código (preferir vip.days; senão derivar da expiração)
      let dias=u.vip?.days||0;
      if(!dias){
        const exp=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);
        const base=u.vip?.activatedAt||u.created_at?new Date(u.vip?.activatedAt||u.created_at).getTime():now;
        if(exp>base) dias=Math.round((exp-base)/86400000);
      }
      codGift.diasTotal+=dias;
      codGift.lista.push({email:u.email,nome:u.name||u.email,codigo:u.vip?.usedCode||null,dias,ativo,plano:u.vip?.plan||"vip"});
    }
    // ── RECEITA: fonte canônica ÚNICA (computeFinanceCanonico) — a MESMA que
    // alimenta fin-insights, Pagantes e Pedidos. Antes este endpoint tinha uma
    // cópia da fórmula SEM a correção de valor por pedido, e mostrava R$ 3.750
    // enquanto os Indicadores mostravam R$ 3.585 pro mesmo caixa (dono, 15/07).
    const F=computeFinanceCanonico();
    const receitaReal=F.receitaTotal, receitaMes=F.receitaMes, receitaAvulsa=F.receitaAvulsa, qtdPagantes=F.qtdPagantes;
    // 💼 MC5-P3: as JANELAS canônicas (13n) viajam junto — o card "Total
    // recebido" do Financeiro mostra a MESMA régua da Visão do Dono/Cérebro
    // (o Math.max híbrido do front morreu).
    return json(res,200,{ok:true,financeiro:slim,pagamentos:slim.pagamentos,gastos:slim.gastos,repasses:slim.repasses,codGift,receitaReal,receitaMes,receitaAvulsa,qtdPagantes,entradas:computeEntradasJanelas()});
  }

  // ── Admin: Inteligência Financeira — 20 análises (fonte única no servidor) ──
  if(pathname==="/api/admin/fin-insights"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const now=Date.now();
    const pv=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
    const ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
    // v19: TODOS os números compartilhados vêm da fonte canônica única —
    // a mesma dos outros endpoints financeiros (fim das 4 receitas diferentes).
    const F=computeFinanceCanonico();
    const {receitaTotal,receitaMes,receitaAvulsa,qtdPagantes,novosMes,vencendo7,vencendo7Valor,vencidos,trials,gift,giftDias,porPlano,porPlanoQtd,topPagantes,finBy,monthStart}=F;
    const pedBy=F.pedBy, _avulsas=F.avulsas;
    // Despesas
    const gastos=(DB_FINANCEIRO&&DB_FINANCEIRO.gastos)||[];
    let despTotal=0,despMes=0; const despCat={},despSocio={andrio:0,diego:0,empresa:0};
    for(const g of gastos){const v=pv(g.valor);despTotal+=v;const dt=ts(g.dataGasto)||ts(g.data)||g.criadoEm||0;if(dt>=monthStart)despMes+=v;const c=(g.categoria||g.cat||"geral");despCat[c]=(despCat[c]||0)+v;const pp=(g.pagoPor||"empresa").toLowerCase();if(despSocio[pp]!==undefined)despSocio[pp]+=v;}
    // 💼 MC5-P3: lucro HONESTO — pode ser negativo (prejuízo aparece, mesma
    // verdade do DRE; o Math.max(0,...) escondia). E a parte de cada sócio
    // segue o SPLIT configurado (era "metade" fixa 50/50).
    const lucro=receitaTotal-despTotal;
    const _spI=(DB_ADMIN_SETTINGS&&DB_ADMIN_SETTINGS.sociosSplit)||{};
    let _spIA=parseFloat(_spI.andrio),_spID=parseFloat(_spI.diego);
    if(!(_spIA>=0))_spIA=50;if(!(_spID>=0))_spID=50;if(!((_spIA+_spID)>0)){_spIA=50;_spID=50;}
    const parteAndrio=Math.round(lucro*(_spIA/(_spIA+_spID))*100)/100;
    const parteDiego=Math.round((lucro-parteAndrio)*100)/100;
    // Série últimos 6 meses (receita por mês, do livro-caixa+pedidos por data)
    const serie=[]; for(let i=5;i>=0;i--){const d0=new Date();d0.setMonth(d0.getMonth()-i,1);d0.setHours(0,0,0,0);const a=d0.getTime();const d1=new Date(d0);d1.setMonth(d1.getMonth()+1);const b=d1.getTime();let soma=0;for(const e in finBy)for(const x of finBy[e])if((x.date||0)>=a&&(x.date||0)<b)soma+=x.valor;if(!Object.keys(finBy).length){for(const e in pedBy)for(const x of pedBy[e])if((x.date||0)>=a&&(x.date||0)<b)soma+=x.valor;}for(const x of _avulsas)if((x.date||0)>=a&&(x.date||0)<b)soma+=x.valor;serie.push({mes:d0.toLocaleDateString("pt-BR",{month:"short",year:"2-digit"}),valor:soma});}
    return json(res,200,{ok:true,insights:{
      receitaTotal,receitaMes,receitaAvulsa,despTotal,despMes,lucro,parteAndrio,parteDiego,split:{andrio:_spIA,diego:_spID},metade:parteAndrio,
      qtdPagantes,ticketMedio:qtdPagantes?Math.round(receitaTotal/qtdPagantes):0,
      novosMes,vencendo7,vencendo7Valor,vencidos,trials,gift,giftDias,
      porPlano,porPlanoQtd,despCat,despSocio,
      topPagantes:topPagantes.slice(0,5),serie,
      mrrEstimado:receitaMes, // receita reconhecida no mês
      projecaoRenovacao:vencendo7Valor,
      geradoEm:new Date().toISOString()
    }});
  }

  // GET /api/admin/gasto/:id — comprovante de um gasto sob demanda (não vai na lista)
  if(pathname.startsWith("/api/admin/gasto/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const gid=decodeURIComponent(pathname.slice("/api/admin/gasto/".length));
    const gs=(DB_FINANCEIRO.gastos||[]).find(x=>x.id===gid);
    if(!gs)return json(res,404,{error:"Gasto não encontrado."});
    return json(res,200,{ok:true,gasto:gs});
  }
  // GET /api/admin/repasse/:id — comprovante de um repasse sob demanda (💼 MC5-P5, espelha o gasto)
  if(pathname.startsWith("/api/admin/repasse/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const rid=decodeURIComponent(pathname.slice("/api/admin/repasse/".length));
    const rp=(DB_FINANCEIRO.repasses||[]).find(x=>x.id===rid);
    if(!rp)return json(res,404,{error:"Repasse não encontrado."});
    return json(res,200,{ok:true,repasse:rp});
  }
  // GET /api/admin/pagamento/:id — comprovante de um pagamento sob demanda (espelha o gasto)
  if(pathname.startsWith("/api/admin/pagamento/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const pid=decodeURIComponent(pathname.slice("/api/admin/pagamento/".length));
    const pg=(DB_FINANCEIRO.pagamentos||[]).find(x=>x.id===pid);
    if(!pg)return json(res,404,{error:"Pagamento não encontrado."});
    return json(res,200,{ok:true,pagamento:pg});
  }
  if(pathname==="/api/admin/financeiro"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      // SEGURANÇA: nunca substitui arrays completos — só adiciona/atualiza itens
      // Logger da trilha de auditoria (append-only) — usado também nos ADDS,
      // que antes NÃO eram auditados (só edição/exclusão apareciam no Histórico).
      const _quemAdd = _sessAdminNome(s); // v183 LOTE 1: pelo e-mail REAL da sessão
      const _logAdd=(tipo,registro,motivo)=>{
        if(!Array.isArray(DB_FINANCEIRO.alteracoes)) DB_FINANCEIRO.alteracoes=[];
        const {comprovante,img,...limpo}=registro||{};
        DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          tipo, por:_quemAdd, porEmail:_sessAdminEmail(s), em:Date.now(),
          motivo:String(motivo||'').slice(0,300), antes:null, depois:limpo});
      };
      // GARANTIA DE VERDADE (2026-07-08): se persistFinanceiro() falhar (disco
      // cheio, sem permissão etc.), desfaz a mutação em memória (senão a tela
      // mostraria "salvo" com o dado só vivendo até o próximo restart) e avisa
      // com erro real em vez de ok:true. rollback() deve devolver o array/objeto
      // ao estado de antes da mutação, incluindo remover o log de alteracoes.
      const _persistFinOuFalha=(rollback)=>{
        if(persistFinanceiro()) return null; // gravou de verdade — segue o jogo
        try{ rollback&&rollback(); }catch(e){ console.error('[financeiro] rollback falhou:',e.message); }
        return json(res,500,{error:"⚠️ Não consegui gravar no disco — a alteração NÃO foi salva. Tente de novo; se persistir, avise o Andrio (pode ser disco cheio ou sem permissão no servidor)."});
      };
      // 💼 MC5-P5: impressão digital dos comprovantes do CAIXA — a mesma régua
      // SHA-256 dos comprovantes de pedido (2.0-P2), pra gasto/entrada manual
      // entrarem no radar de reuso do cérebro em vez de serem invisíveis.
      const _hashComp=(b64)=>{try{return crypto.createHash("sha256").update(String(b64).replace(/^data:[^;]+;base64,/,"")).digest("hex");}catch(e){return null;}};
      // 🕰️ MC5-P7: TODA action que mexe no caixa avisa o tempo real do
      // cérebro (3.0-P6 cobria só as 4 rotas de pedido) — entrada/gasto/
      // repasse manual, edição, exclusão e anexo também entram na janela.
      // 💼 MC5-P5: dispara o robô de gastos recorrentes sob demanda — o MESMO
      // que roda sozinho na autonomia das 02h (idempotente por mês).
      if(d.action==='rodar_recorrentes'){
        const _rrec=_lancarGastosRecorrentes();
        return json(res,200,{ok:true,..._rrec});
      }
      if(d.action==='add_pagamento' && d.pagamento){
        // Adicionar um pagamento individual (mesmo padrão de proveniência do gasto)
        const pg=d.pagamento;
        // VALIDAÇÃO REAL (v948): antes, entrada inválida podia entrar muda ou
        // sumir sem explicação. Agora o servidor diz exatamente o que faltou.
        const _valor=Math.round((parseFloat(pg.valor)||0)*100)/100;
        if(_valor<=0) return json(res,400,{error:"Valor da entrada deve ser maior que zero."});
        if(_valor>1_000_000) return json(res,400,{error:"Valor da entrada inválido."});
        pg.valor=_valor;
        pg.email=String(pg.email||"").trim().toLowerCase();
        // ENTRADA AVULSA (sem email): permitida — é dinheiro recebido FORA do
        // site (Pix/PicPay direto pro sócio, saldo inicial, acerto externo).
        // Exige descrição para o outro sócio entender o que é, e NUNCA ativa VIP.
        if(!pg.email){
          if(!pg.nota||String(pg.nota).trim().length<3)
            return json(res,400,{error:"Entrada avulsa (sem email) exige uma descrição — o outro sócio precisa entender do que se trata."});
          pg.tipo='avulsa';
        } else { pg.tipo=pg.tipo==='avulsa'?'avulsa':'cliente'; }
        // 💼 MC5-P5: dono do dinheiro só se veio EXPLÍCITO no enum — antes
        // qualquer coisa (inclusive vazio) virava 'andrio' na marra e o acerto
        // creditava dinheiro pro sócio errado sem ninguém perceber.
        const _rpEnum=String(pg.recebidoPor||"").toLowerCase();
        if(_rpEnum==='andrio'||_rpEnum==='diego'){ pg.recebidoPor=_rpEnum; } else { delete pg.recebidoPor; }
        if(!pg.id) pg.id='fin_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
        if(!pg.criadoEm) pg.criadoEm=Date.now();
        // Quem LANÇOU vem da sessão — não pode ser forjado pelo corpo (mesmo padrão do gasto).
        pg.lancadoPorEmail=_sessAdminEmail(s);
        pg.lancadoPor = _sessAdminNome(s)!==_sessAdminEmail(s) ? _sessAdminNome(s) : (pg.lancadoPor||_sessAdminEmail(s));
        // Comprovante OPCIONAL, mesma validação do gasto (antes ficava só no
        // localStorage de quem lançou — o outro sócio nunca via a imagem).
        if(pg.comprovante && typeof pg.comprovante==='string'){
          if(pg.comprovante.length>10_700_000 || !/^[A-Za-z0-9+/]/.test(pg.comprovante.slice(0,10))) pg.comprovante=null;
        } else { pg.comprovante = null; }
        const _allowP=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
        pg.comprovanteType = pg.comprovante ? (_allowP.includes(pg.comprovanteType)?pg.comprovanteType:'image/jpeg') : null;
        pg.temComprovante = !!pg.comprovante;
        if(pg.comprovante) pg.comprovanteHash=_hashComp(pg.comprovante); // MC5-P5: fingerprint sempre
        DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos||[];
        DB_FINANCEIRO.pagamentos.unshift(pg);
        _logAdd('add_pagamento',pg,(pg.tipo==='avulsa'?'Entrada avulsa: ':'Entrada de cliente: ')+'R$'+pg.valor.toFixed(2)+' · recebido por '+(pg.recebidoPor||'(sem dono — vai derivar da trilha)')+(pg.nota?' · '+String(pg.nota).slice(0,80):''));
        const _errAP=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos.filter(x=>x.id!==pg.id);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errAP) return _errAP;
        return json(res,200,{ok:true,id:pg.id,temComprovante:pg.temComprovante});
      }
      if(d.action==='add_gasto' && d.gasto){
        // Adicionar um gasto individual (com proveniência completa)
        const gs=d.gasto;
        const _gv=Math.round((parseFloat(gs.valor)||0)*100)/100;
        if(_gv<=0) return json(res,400,{error:"Valor do gasto deve ser maior que zero."});
        if(_gv>1_000_000) return json(res,400,{error:"Valor do gasto inválido."});
        gs.valor=_gv;
        if(!gs.id) gs.id='gst_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
        if(!gs.criadoEm) gs.criadoEm=Date.now();
        // Quem LANÇOU vem da sessão — não pode ser forjado pelo corpo.
        gs.lancadoPorEmail=_sessAdminEmail(s);
        gs.lancadoPor = _sessAdminNome(s)!==_sessAdminEmail(s) ? _sessAdminNome(s) : (gs.lancadoPor||_sessAdminEmail(s));
        // Data do GASTO separada da data de lançamento (pertence ao mês em que ocorreu).
        gs.dataGasto = gs.dataGasto || new Date(gs.criadoEm).toISOString();
        // Quem BANCOU o gasto (acerto entre sócios): andrio | diego | empresa.
        gs.pagoPor = ["andrio","diego","empresa"].includes((gs.pagoPor||"").toLowerCase())
                     ? (gs.pagoPor||"").toLowerCase() : "empresa";
        gs.categoria = String(gs.categoria||"geral").slice(0,40);
        // 💼 MC5-P5: gasto RECORRENTE (ex.: Render todo mês) — flag booleana;
        // o robô _lancarGastosRecorrentes cria a cópia de cada mês novo e o
        // push cobra o comprovante (a despesa fixa nunca mais some do DRE).
        if(gs.recorrente===true||gs.recorrente==='true'||gs.recorrente===1){ gs.recorrente=true; } else { delete gs.recorrente; }
        // 💼 MC5-P5: gasto em DÓLAR — MESMA régua do edit_gasto (fonte única de
        // conversão): moeda USD + valorUSD>0 → valor em R$ = valorUSD × câmbio.
        if(String(gs.moeda||'').toUpperCase()==='USD'){
          gs.valorUSD=Math.round((parseFloat(gs.valorUSD)||0)*100)/100;
          if(gs.valorUSD>0){
            gs.moeda='USD';
            if(!(parseFloat(gs.cambio)>0)) gs.cambio=5.17; else gs.cambio=parseFloat(gs.cambio);
            gs.valor=Math.round(gs.valorUSD*gs.cambio*100)/100;
          } else { delete gs.moeda; delete gs.valorUSD; delete gs.cambio; }
        }
        // Comprovante OPCIONAL (selo no front). Guarda só se válido e leve (~6MB).
        if(gs.comprovante && typeof gs.comprovante==='string'){
          if(gs.comprovante.length>10_700_000 || !/^[A-Za-z0-9+/]/.test(gs.comprovante.slice(0,10))) gs.comprovante=null;
        } else { gs.comprovante = null; }
        const _allowG=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
        gs.comprovanteType = gs.comprovante ? (_allowG.includes(gs.comprovanteType)?gs.comprovanteType:'image/jpeg') : null;
        gs.temComprovante = !!gs.comprovante;
        if(gs.comprovante) gs.comprovanteHash=_hashComp(gs.comprovante); // MC5-P5: fingerprint sempre
        DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos||[];
        DB_FINANCEIRO.gastos.unshift(gs);
        _logAdd('add_gasto',gs,'Gasto: R$'+gs.valor.toFixed(2)+' · pago por '+gs.pagoPor+' · '+gs.categoria+(gs.descricao?' · '+String(gs.descricao).slice(0,80):''));
        const _errAG=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos.filter(x=>x.id!==gs.id);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errAG) return _errAG;
        return json(res,200,{ok:true,id:gs.id,temComprovante:gs.temComprovante});
      }
      // ── Trilha de auditoria: NADA é apagado/editado sem histórico ──
      // Cada alteração grava: quem (sessão, não forjável), quando, motivo,
      // valor anterior e novo. A trilha (alteracoes[]) é append-only.
      const _quem = _sessAdminNome(s); // v183 LOTE 1: pelo e-mail REAL da sessão
      const _logAlt=(tipo,antes,depois,motivo)=>{
        if(!Array.isArray(DB_FINANCEIRO.alteracoes)) DB_FINANCEIRO.alteracoes=[];
        const strip=o=>{if(!o)return o;const{comprovante,img,...r}=o;return r;};
        DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          tipo, por:_quem, porEmail:_sessAdminEmail(s), em:Date.now(),
          motivo:String(motivo||'').slice(0,300), antes:strip(antes), depois:strip(depois)});
      };
      // ── REPASSES ENTRE SÓCIOS ─────────────────────────────────────────
      // Registra dinheiro que um sócio JÁ pagou ao outro (ex.: Diego→Andrio),
      // para o "Acerto entre sócios" descontar o que já foi acertado.
      if(d.action==='add_repasse' && d.repasse){
        const rp=d.repasse;
        const valor=Math.round((parseFloat(rp.valor)||0)*100)/100;
        if(valor<=0) return json(res,400,{error:"Valor do repasse deve ser maior que zero."});
        if(valor>1_000_000) return json(res,400,{error:"Valor do repasse inválido."});
        const de=(String(rp.de||"").toLowerCase()==="andrio")?"andrio":"diego";
        const para=de==="andrio"?"diego":"andrio";
        let dataRepasse=new Date().toISOString();
        if(rp.dataRepasse){ const t=new Date(rp.dataRepasse).getTime(); if(!isNaN(t)) dataRepasse=new Date(t).toISOString(); }
        const novo={
          id:'rep_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          de, para, valor, dataRepasse,
          nota:String(rp.nota||"").slice(0,200),
          lancadoPorEmail:_sessAdminEmail(s), lancadoPor:_quem, criadoEm:Date.now()
        };
        // 💼 MC5-P5: repasse também aceita COMPROVANTE (mesma validação e o
        // mesmo fingerprint do gasto/entrada) — dinheiro entre sócios com prova.
        if(rp.comprovante && typeof rp.comprovante==='string'
           && rp.comprovante.length<=10_700_000 && /^[A-Za-z0-9+/]/.test(rp.comprovante.slice(0,10))){
          const _allowR=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
          novo.comprovante=rp.comprovante;
          novo.comprovanteType=_allowR.includes(rp.comprovanteType)?rp.comprovanteType:'image/jpeg';
          novo.temComprovante=true;
          novo.comprovanteHash=_hashComp(rp.comprovante);
        }
        DB_FINANCEIRO.repasses=DB_FINANCEIRO.repasses||[];
        DB_FINANCEIRO.repasses.unshift(novo);
        _logAlt('add_repasse',null,novo,'Repasse registrado: '+de+' → '+para+' R$'+valor.toFixed(2));
        const _errAR=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.repasses=DB_FINANCEIRO.repasses.filter(x=>x.id!==novo.id);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errAR) return _errAR;
        console.log(`[fin] repasse ${de}→${para} R$${valor.toFixed(2)} por ${s.user_email}`);
        return json(res,200,{ok:true,id:novo.id});
      }
      if(d.action==='delete_repasse' && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da exclusão (obrigatório para o histórico)."});
        const alvo=(DB_FINANCEIRO.repasses||[]).find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Repasse não encontrado."});
        DB_FINANCEIRO.repasses=(DB_FINANCEIRO.repasses||[]).filter(x=>x.id!==d.id);
        _logAlt('excluir_repasse',alvo,null,d.motivo);
        const _errDR=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.repasses.unshift(alvo);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errDR) return _errDR;
        return json(res,200,{ok:true});
      }
      if(d.action==='delete_pagamento' && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da exclusão (obrigatório para o histórico)."});
        const alvo=(DB_FINANCEIRO.pagamentos||[]).find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Pagamento não encontrado."});
        DB_FINANCEIRO.pagamentos=(DB_FINANCEIRO.pagamentos||[]).filter(x=>x.id!==d.id);
        _logAlt('excluir_pagamento',alvo,null,d.motivo);
        const _errDP=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.pagamentos.unshift(alvo);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errDP) return _errDP;
        return json(res,200,{ok:true});
      }
      if(d.action==='delete_gasto' && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da exclusão (obrigatório para o histórico)."});
        const alvo=(DB_FINANCEIRO.gastos||[]).find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Gasto não encontrado."});
        DB_FINANCEIRO.gastos=(DB_FINANCEIRO.gastos||[]).filter(x=>x.id!==d.id);
        _logAlt('excluir_gasto',alvo,null,d.motivo);
        const _errDG=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.gastos.unshift(alvo);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errDG) return _errDG;
        return json(res,200,{ok:true});
      }
      // ── Editar pagamento/gasto (valor, data, nota) com histórico ──
      if((d.action==='edit_pagamento'||d.action==='edit_gasto') && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da edição (obrigatório para o histórico)."});
        const arr=d.action==='edit_pagamento'?(DB_FINANCEIRO.pagamentos||[]):(DB_FINANCEIRO.gastos||[]);
        const alvo=arr.find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Registro não encontrado."});
        const antes={...alvo};
        // 💼 MC4-P1: dono do dinheiro é ENUM, não texto livre — esta edição
        // aceitava QUALQUER string em recebidoPor/pagoPor e o Acerto entre
        // Sócios perdia o lançamento em silêncio (ia parar no "sem dono").
        // Inválido = 400 na cara; vazio = limpa a atribuição de propósito.
        if(d.changes&&d.changes.recebidoPor!==undefined){
          const _rp=String(d.changes.recebidoPor||"").trim().toLowerCase();
          if(!["andrio","diego",""].includes(_rp))return json(res,400,{error:"recebidoPor inválido — use 'andrio', 'diego' ou vazio pra limpar."});
          d.changes.recebidoPor=_rp;
        }
        if(d.changes&&d.changes.pagoPor!==undefined){
          const _pp=String(d.changes.pagoPor||"").trim().toLowerCase();
          if(!["andrio","diego","empresa",""].includes(_pp))return json(res,400,{error:"pagoPor inválido — use 'andrio', 'diego', 'empresa' ou vazio."});
          d.changes.pagoPor=_pp||"empresa";
        }
        const ALLOWED=['valor','desconto','dataPagamento','dataGasto','data','nota','descricao','categoria','plano','email','nome','pagoPor','recebidoPor','moeda','valorUSD','cambio','fonte'];
        for(const k of ALLOWED){ if(d.changes&&d.changes[k]!==undefined){ alvo[k]=['valor','desconto','valorUSD','cambio'].includes(k)?(parseFloat(d.changes[k])||0):d.changes[k]; } }
        if(alvo.recebidoPor==="")delete alvo.recebidoPor;
        // Moeda: gasto/entrada pode ser em DÓLAR — o valor em R$ é derivado do câmbio
        if(String(alvo.moeda||'').toUpperCase()==='USD'&&alvo.valorUSD>0){
          if(!(alvo.cambio>0))alvo.cambio=5.17; // câmbio padrão editável
          alvo.valor=Math.round(alvo.valorUSD*alvo.cambio*100)/100;
        }
        alvo.editadoEm=Date.now(); alvo.editadoPor=_quem;
        _logAlt(d.action,antes,{...alvo},d.motivo);
        const _errED=_persistFinOuFalha(()=>{
          // Restaura TODOS os campos ao estado anterior (remove os que a edição
          // adicionou e não existiam antes, restaura os que existiam).
          Object.keys(alvo).forEach(k=>delete alvo[k]);
          Object.assign(alvo,antes);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errED) return _errED;
        return json(res,200,{ok:true,registro:(()=>{const{comprovante,img,...r}=alvo;return r;})()});
      }
      // ── Anexar/trocar comprovante em registro existente ──
      if(d.action==='attach_comprovante' && d.id){
        const arr2=d.tipo==='pagamento'?(DB_FINANCEIRO.pagamentos||[]):(DB_FINANCEIRO.gastos||[]);
        const alvo2=arr2.find(x=>x.id===d.id);
        if(!alvo2) return json(res,404,{error:"Registro não encontrado."});
        if(!d.comprovante||typeof d.comprovante!=='string'||d.comprovante.length>10_700_000||!/^[A-Za-z0-9+/]/.test(d.comprovante.slice(0,10)))
          return json(res,400,{error:"Comprovante inválido (máx ~8MB)."});
        const _allow2=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
        alvo2.comprovante=d.comprovante;
        alvo2.comprovanteType=_allow2.includes(d.comprovanteType)?d.comprovanteType:'image/jpeg';
        alvo2.temComprovante=true;
        alvo2.comprovanteHash=_hashComp(d.comprovante); // MC5-P5: fingerprint sempre
        _logAlt('attach_comprovante',null,{id:d.id,tipo:d.tipo},'Comprovante anexado/substituído');
        persistFinanceiro();
        return json(res,200,{ok:true});
      }
      // ── Consultar trilha de alterações ──
      if(d.action==='get_alteracoes'){
        return json(res,200,{ok:true,alteracoes:(DB_FINANCEIRO.alteracoes||[]).slice(-200).reverse()});
      }
      // REMOVIDO v945: caminho legado _replace (substituição TOTAL dos arrays) —
      // era um risco de apagar gastos/pagamentos inteiros; nada no front usa.
      // 💼 MC5-P6: action desconhecida recusada NA CARA (400) — antes caía num
      // "ok:true" mudo que persistia sem fazer NADA: um typo de action no
      // front parecia sucesso e a mudança simplesmente não existia.
      return json(res,400,{error:'Ação desconhecida: "'+String(d.action||"(vazia)").slice(0,40)+'" — nada foi alterado no caixa.'});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: editar campo de usuário ───────────────────────
  if(pathname==="/api/admin/set-user-field"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,field,value}=d;
      if(!email||!field)return json(res,400,{error:"email e field obrigatórios"});
      const ALLOWED=['name','phone','city','country','isAdmin','whatsapp'];
      if(!ALLOWED.includes(field))return json(res,400,{error:"Campo não permitido: "+field});
      const target=getUser(email);if(!target)return json(res,404,{error:"Usuário não encontrado"});
      // 🚨 v237 (achado de auditoria — Alta): promover/rebaixar admin é MAIS
      // sensível que deletar conta (delete-user já exige o admin HARDCODED,
      // isAdminEmail(_sessAdminEmail(s)) — não só isAdminVip, que também
      // inclui ADMIN_EMAILS_EXTRA). Antes qualquer conta admin conseguia dar
      // isAdmin:true pra QUALQUER outra conta, sem trilha nenhuma em
      // logAdminAction (invisível em /api/admin/audit, irreversível pelo
      // botão ↩️). Mesma trava + trilha que já protege o resto de "admin
      // hardcoded only" no arquivo.
      if(field==="isAdmin"){
        if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Só os admins fixos podem conceder ou remover acesso de admin."});
        logAdminAction(s.user_email,"set_is_admin",email,{isAdmin:!!target.isAdmin},{isAdmin:!!value},
          `${value?"Concedeu":"Removeu"} acesso de admin`);
      }
      setUser(email,{[field]:value});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // 🤖 v188 LOTE 6: a rota /api/admin/revoke-vip foi REMOVIDA (regra 3 —
  // código morto). Era uma 2ª cópia, PIOR, do /api/admin/vip/revoke: sem
  // chamador nenhum no front, sem logAdminAction (revogar plano sem trilha
  // de auditoria), sem clearTimeout/delAutoJob (o robô do usuário continuava
  // agendado depois de "revogar") e sem 404 pra usuário inexistente (criava
  // um registro vazio). A revogação oficial — e agora com botão no painel —
  // é SÓ /api/admin/vip/revoke.
  // ── Admin: definir plano ──────────────────────────────────
  // 🔄 Reconciliação manual (admin): confere TODOS os pagantes e devolve dias
  if(pathname==="/api/admin/reconciliar-planos"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req).catch(()=>"{}")||"{}");
      const relatorio=reconciliarPlanosComPedidos(d.apply!==false);
      return json(res,200,{ok:true,aplicado:d.apply!==false,corrigidos:relatorio.length,relatorio});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/set-plan"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,plan}=d;if(!email||!plan)return json(res,400,{error:"email e plan obrigatórios"});
      const VALID_PLANS=['free','vip','vipro','doublepro','pro'];
      if(!VALID_PLANS.includes(plan))return json(res,400,{error:"Plano inválido"});
      // 💳 v141 (caso Cleiton, achado na auditoria: "nenhum dos 2 tem todos
      // esses dias de plano"): esta era a ÚNICA rota que soma dias de VIP
      // SEM nenhuma trava de clique duplo/retry — vip/activate já tinha
      // (v18-FIX). Se o admin clicasse 2x achando que a 1ª falhou (ex.: pelo
      // aviso de disco cheio do caso Cleiton original, 11/07), cada clique
      // empilhava +30 dias, silenciosamente. Mesma trava de 5s, mesmo padrão
      // — MAS a chave inclui o PLANO (não só admin+email): upgrade legítimo
      // e imediato de um plano pro outro (caso real do Diego, v79 — VipPro
      // → DoublePro pro mesmo usuário em segundos) precisa continuar
      // passando; só o clique duplo no MESMO plano é bloqueado.
      const _spKey=s.user_email+"|"+String(email||"").toLowerCase()+"|"+plan;
      if(_adminVipActivateLock.has(_spKey))
        return json(res,409,{error:"Ativação em andamento para este usuário. Aguarde alguns segundos e confira antes de tentar de novo.",duplicate:true});
      _adminVipActivateLock.set(_spKey,Date.now());
      setTimeout(()=>_adminVipActivateLock.delete(_spKey),5000);
      const tgt=getUser(email);if(!tgt)return json(res,404,{error:"Usuário não encontrado"});
      const _audBefore=_vipSnapshot(tgt); // v19: snapshot pra reversão
      if(plan!=='free'){addManualVipDays(email,30);if(['vipro','doublepro','pro'].includes(plan))addAutoVipDays(email,30);}
      // v79 (bug real: "ativei DoublePro pro Esdras várias vezes e não entra,
      // volta pro VipPro" — Diego, 29/07): addManualVipDays/addAutoVipDays
      // ACIMA já leem e gravam manualExpires/autoExpires atualizados — mas
      // o setUser abaixo usava `tgt.vip`, o snapshot de ANTES dessas duas
      // chamadas, sobrescrevendo o vip inteiro e apagando silenciosamente
      // os +30 dias que acabaram de ser gravados. Precisa reler o usuário
      // DEPOIS das duas funções pra não desfazer o próprio trabalho delas.
      const tgtFresh=getUser(email)||tgt;
      setUser(email,{plan,vip:{...(tgtFresh.vip||{}),active:plan!=='free',plan,source:'admin',activatedBy:s.user_email,...(plan!=='free'?{limits:limitesDoPlanoNovo(plan)}:{})}});
      logAdminAction(s.user_email,"set_plan",email,_audBefore,_vipSnapshot(getUser(email)),`Plano → ${plan}${plan!=='free'?" (+30d)":""}`);
      // 💳 v141: faltava aqui — era a única rota de concessão de dias que NÃO
      // alimentava o extrato vip.creditos (addCredito), então a Auditoria
      // Financeira por usuário não via essa concessão no "quanto já foi dado
      // e por quê". Agora toda rota que soma dias grava no mesmo ledger.
      if(plan!=='free')addCredito(email,{dias:30,tipo:"gratis",origem:"admin",motivo:`set-plan → ${plan}`,dadoPor:_sessAdminNome(s)});
      if(plan!=='free')acordarRoboAposPlano(email); // v125: robô dormindo por limite antigo acorda já
      // 11/07 (caso Cleiton): plano foi ativado 3x e sumia após cada restart porque
      // o persist falhava em silêncio com o disco cheio. Agora VERIFICA a gravação
      // e grita para o admin — nunca mais falha silenciosa em dado de dinheiro.
      const _saved=persist(USERS_FILE,DB_USERS);
      if(!_saved){
        console.error(`[set-plan] 🚨 PLANO DE ${email} NÃO FOI GRAVADO NO DISCO!`);
        try{pushGlobalEvent('persist_fail',email,'🚨 Plano ativado mas NÃO gravado no disco — será perdido no restart! Libere espaço.','error');}catch{}
        return json(res,200,{ok:true,persisted:false,warning:'⚠️ ATENÇÃO: o plano foi ativado NA MEMÓRIA mas NÃO FOI GRAVADO NO DISCO (disco cheio?). Ele será PERDIDO no próximo restart. Libere espaço no Render e ative novamente!'});
      }
      return json(res,200,{ok:true,persisted:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // 🔐 v172c (ORDEM DO DONO, 12/09/2026): cadastro/login viraram usuário+
  // senha — mas conta ANTIGA (criada por Google, antes desta mudança) não
  // tem passwordSalt/passwordHash nenhum, e /oauth/start virou dead-end.
  // Essa conta ficaria trancada pra sempre sem uma forma de ENTRAR de novo.
  // Esta rota é a válvula de escape: o admin carimba uma senha nova pra
  // QUALQUER usuário (conta antiga sem senha, ou senha esquecida de conta
  // nova) — nunca reabre o Google, sempre a MESMA função de hash
  // (_hashPw/scrypt) do cadastro normal.
  if(pathname==="/api/admin/set-password"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const email=String(d.email||"").trim().toLowerCase();
      const novaSenha=String(d.novaSenha||"");
      if(!email)return json(res,400,{error:"email obrigatório"});
      if(novaSenha.length<8)return json(res,400,{error:"A senha precisa ter pelo menos 8 caracteres."});
      const tgt=getUser(email);if(!tgt)return json(res,404,{error:"Usuário não encontrado"});
      const {salt,hash}=await _hashPw(novaSenha);
      setUser(email,{passwordSalt:salt,passwordHash:hash});
      // 🚨 v172c-SEC (auditoria de segurança, 12/09/2026): trocar a senha
      // (conta comprometida, esquecida, etc.) SEM derrubar as sessões
      // antigas deixava quem já estava logado continuar logado pra sempre
      // com a senha VELHA — o reset não protegia a conta de verdade contra
      // quem já tinha uma sessão aberta antes da troca.
      let _sessõesDerrubadas=0;
      for(const sid of Object.keys(sessions)){
        if(sessions[sid]?.user_email===email){delete sessions[sid];_sessõesDerrubadas++;}
      }
      if(_sessõesDerrubadas)persistSessionsDebounced(500);
      logAdminAction(s.user_email,"set_password",email,{tinhaSenha:!!tgt.passwordHash},{tinhaSenha:true,sessõesDerrubadas:_sessõesDerrubadas},"Senha definida/redefinida pelo admin");
      console.log(`[admin] 🔑 ${s.user_email} definiu senha nova para ${email}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // 🧹 v237 (achado de auditoria — Média): /api/admin/push-user foi
  // REMOVIDA — validava {email,title} e devolvia ok:true SEM NENHUM efeito
  // colateral (nunca gravava nada, nunca chamava pushToUser). Zero
  // chamador em admin.html/app.js (confirmado por grep) — código morto que
  // ia enganar quem conectasse um botão a ela achando que enviou algo. A
  // rota que funciona de verdade pra avisar um usuário é /api/admin/
  // message (grava adminMessage, lido por /api/my-message).
  // ── Admin: limpar PDFs ─────────────────────────────────────
  if(pathname==="/api/admin/reset-pdfs"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      const tgt=getUser(email);if(!tgt)return json(res,404,{error:"Usuário não encontrado"});
      (tgt.cvs||[]).forEach(c=>{try{deleteCv(email,c.idx);}catch{}});
      setUser(email,{cvs:[]});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: deletar usuário ─────────────────────────────────
  if(pathname==="/api/admin/delete-user"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    if(!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Apenas admins hardcoded podem deletar contas."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      if(isAdminEmail(email))return json(res,403,{error:"Não é possível deletar uma conta admin."});
      delUser(email);
      delete DB_HIST[email];persist(HIST_FILE,DB_HIST);
      delete DB_SENT[email];persistSent();
      delete DB_LOGS[email];persistLogs();
      delete DB_AUTO[email];persist(AUTO_FILE,DB_AUTO);
      // 🔓 v153 (ordem do dono, 21/08): deletar conta NÃO bane mais o e-mail
      // sozinho — esse efeito colateral criou os bans acidentais (caso
      // Esdras). Ban agora é decisão EXPLÍCITA: ou o admin marca `banir:true`
      // aqui (o painel pergunta), ou usa o botão Banir da aba Auditoria.
      const emailLow = email.trim().toLowerCase();
      let banned=false;
      if(d.banir===true&&!DB_BLOCKED.emails.includes(emailLow)){
        DB_BLOCKED.emails.push(emailLow);
        persist(BLOCKED_FILE, DB_BLOCKED);
        banned=true;
        console.log(`[admin] 🚫 Email banido permanentemente (pedido explícito no delete): ${emailLow}`);
      }
      console.log(`[admin] 🗑️ Conta deletada: ${emailLow}${banned?" (e banida)":" (SEM ban — pode recriar)"}`);
      return json(res,200,{ok:true,banned});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: limpar sent de usuário ──────────────────────────
  if(pathname==="/api/admin/clear-sent"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      DB_SENT[email]=new Set();persistSent();
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/my-settings"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!p||!isAdminVip(p))return json(res,403,{error:"Acesso negado. Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const current=p.adminSettings||{};
      const updated={...current};
      // Intervalo entre envios (segundos, mín 30) — v172b: padrão do admin
      // virou 5min (300s), não 3min (180s), quando o valor enviado é inválido.
      if(d.intervalSecs!==undefined){updated.intervalSecs=Math.max(30,parseInt(d.intervalSecs)||300);}
      // Limites por sender {email: N}
      if(d.senderLimits!==undefined&&typeof d.senderLimits==="object"){
        updated.senderLimits={};
        for(const [em,lim] of Object.entries(d.senderLimits)){
          const n=parseInt(lim);if(n>0&&n<=9999)updated.senderLimits[em.toLowerCase().trim()]=n;
        }
      }
      setUser(s.user_email,{adminSettings:updated});
      return json(res,200,{ok:true,adminSettings:updated});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/my-settings"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!p||!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    return json(res,200,{ok:true,adminSettings:p.adminSettings||{}});
  }

  // GET /api/planos — fonte única e PÚBLICA dos planos: preço oficial em R$
  // (PLANO_PRECO_TAB) e limites manual/auto por plano (PLAN_LIMITS_NEW). A
  // tela de compra NUNCA hardcoda esses números — deriva sempre daqui (regra
  // 13o: mudança de tabela é mudança de código, nunca só de texto). Também
  // devolve a mediana REAL das últimas confirmações de comprovante
  // (createdAt→ativadoEm) — promessa honesta no checkout, no lugar de um
  // prazo fixo inventado.
  if(pathname==="/api/planos"&&req.method==="GET"){
    const tabela=[];
    for(const[pl,combos]of Object.entries(PLANO_PRECO_TAB))
      for(const dk of Object.keys(combos))
        tabela.push({plano:pl,dias:parseInt(dk,10),valorTotal:combos[dk]});
    let medianaAprovacaoHoras=null;
    try{
      const hs=(DB_PEDIDOS||[]).filter(pp=>pp&&pp.ativadoEm&&pp.createdAt)
        .sort((a,b)=>(b.ativadoEm||0)-(a.ativadoEm||0)).slice(0,30)
        .map(pp=>(pp.ativadoEm-pp.createdAt)/3600000).filter(h=>h>0&&h<24*14).sort((a,b)=>a-b);
      if(hs.length>=3)medianaAprovacaoHoras=Math.round(hs[Math.floor(hs.length/2)]*10)/10;
    }catch(e){}
    return json(res,200,{ok:true,precos:tabela,limites:PLAN_LIMITS_NEW,medianaAprovacaoHoras});
  }

  // 🚀 v240c: sobe o comprovante (arquivo cru, streamado) ANTES de criar o
  // pedido — devolve um token curto que /api/pedido (ou o reenvio) reivindica
  // depois. Mesma trava de rate-limit do upload de currículo.
  if(pathname==="/api/pedido/comprovante-stage"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Sessão expirada. Faça login novamente.",sessionExpired:true,code:"SESSION_EXPIRED"});
    if(DATA_DIR==="/tmp")return json(res,503,{error:"⚠️ Servidor sem volume persistente (/tmp). O upload funcionaria agora, mas o arquivo SOME no próximo reinício. Configure DATA_DIR=/data com volume persistente antes de continuar.",diskVolatile:true});
    if(rateLimit(s.user_email+"_comp_stage",10,3600_000))return json(res,429,{error:"Muitos envios de comprovante. Tente novamente em 1 hora."});
    try{
      const {token}=await stageComprovanteFromReq(req,s.user_email);
      return json(res,200,{ok:true,token});
    }catch(e){
      if(e.message==="PAYLOAD_TOO_LARGE")return json(res,400,{error:"O comprovante passou de ~8MB — envie uma foto menor ou um print da tela do banco."});
      if(e.message==="TOO_SMALL")return json(res,400,{error:"O arquivo do comprovante veio vazio ou corrompido — tente enviar de novo (foto ou print)."});
      return json(res,500,{error:e.message});
    }
  }

  // ── PEDIDOS DE PLANO ───────────────────────────────────────
  // POST /api/pedido — usuário cria pedido de plano
  if(pathname==="/api/pedido"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // Rate-limit (auditoria 10/09/2026): era a única rota de dinheiro sem
    // trava de rajada — o teto de 3 pendentes barra abuso sustentado, mas
    // não impede rajada de requisições (ex.: criar+cancelar em loop). Mesmo
    // padrão das outras rotas sensíveis (rateLimit por e-mail da sessão).
    if(rateLimit(s.user_email+"_pedido",15,60_000))return json(res,429,{error:"Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo."});
    try{
      const d=JSON.parse(await readBody(req));
      // Por padrão, o pedido pertence a quem está logado (fluxo normal: usuário comprando seu próprio plano).
      // Exceção: ADMIN pode criar um pedido retroativo EM NOME de outro usuário (fluxo "Regularizar" do
      // Robô Contábil), enviando userEmail no corpo. Só admin pode usar esse override — usuário comum jamais
      // pode forjar o userEmail de outra pessoa.
      let targetEmail=s.user_email;
      if(d.userEmail){
        const reqUser=getUser(s.user_email);
        const reqIsAdmin=isAdminVip(reqUser)||isAdminEmail(_sessAdminEmail(s));
        const te=(d.userEmail||"").trim().toLowerCase();
        if(reqIsAdmin && te){
          // Admin pode criar pedido para qualquer email válido
          // (usuário pode não estar no DB local ainda)
          targetEmail=te;
        }
      }
      // ── COMPRA DIRETA DE PLANO (v170 — dono, 09/09/2026: "retire todo
      // sistema de diamantes... reestruture pra pessoa conseguir comprar"):
      // sem moeda intermediária. O usuário escolhe plano+período, o SERVIDOR
      // recalcula o preço em R$ pela tabela oficial (nunca confia no valor
      // que o cliente mandou — trava contra manipulação), e o comprovante
      // enviado é para ESSE valor exato. Aprovação ativa o plano DIRETO.
      const planoKey={vip:"vip",vipro:"vipro",doublepro:"doublepro"}[String(d.plano||"").toLowerCase()];
      const diasReq=parseInt(d.dias,10)||0;
      const _isAdminCaller=isAdminVip(getUser(s.user_email))||isAdminEmail(_sessAdminEmail(s));
      // 🚧 Interruptor de emergência: desligado por padrão (ver
      // NEW_PURCHASES_BLOCKED) — só bloqueia se BLOCK_NEW_PURCHASES=true
      // for setado de propósito. Admin (Regularizar) passa direto sempre —
      // é documentação de compra ANTIGA, não venda nova.
      if(NEW_PURCHASES_BLOCKED&&!_isAdminCaller){
        return json(res,403,{error:"Assinaturas novas estão pausadas no momento por uma manutenção rápida — tente novamente em instantes.",newPurchasesBlocked:true});
      }
      let valorOficial=null;
      if(planoKey&&(PLANO_PRECO_TAB[planoKey]||{})[diasReq]!=null){
        valorOficial=PLANO_PRECO_TAB[planoKey][diasReq];
      }else if(!_isAdminCaller){
        return json(res,400,{error:"Plano ou período inválido. Escolha um dos planos e prazos exibidos na tela."});
      }
      // Admin (Regularizar/retroativo) pode registrar um valor histórico fora
      // da tabela atual — documentação contábil de compra antiga.
      // 🚨 v177-FIX4 (auditoria): esse é o ÚNICO ponto do site onde um valor em
      // R$ entra no caixa sem passar pela tabela oficial. Antes o único rastro
      // era o `criadoPor` do próprio pedido — nada em DB_ADMIN_AUDIT, nada que
      // o dono visse depois. Agora fica carimbado na trilha administrativa
      // (quem, quando, pra quem, quanto e por que saiu da tabela).
      let _valorForaTabela=false;
      if(valorOficial==null){valorOficial=parseFloat(d.valorTotal)||0;_valorForaTabela=true;}
      // Consentimento informado é OBRIGATÓRIO pra pedido de usuário comum —
      // pense como advogado (dono, 09/09/2026): a pessoa precisa confirmar
      // que entende o que está comprando (serviço de envio, nunca garantia
      // de emprego/visto) e o preço exato ANTES de o pedido ser criado.
      if(!_isAdminCaller&&d.consentimento!==true){
        return json(res,400,{error:"Você precisa marcar que leu e entende como o programa funciona antes de continuar."});
      }
      // 🗓️ v193 LOTE 11 — A DATA DE PAGAMENTO É VALIDADA NA PORTA.
      // Ela vinha CRUA do cliente e só era convertida lá na aprovação, DEPOIS
      // de creditar os dias: `new Date("xyz").toISOString()` estoura
      // RangeError, o catch devolve 500 e o persistPedidos nunca roda — dias
      // concedidos, ZERO entrada no caixa, e a 2ª tentativa bate no 409 "já
      // foi ativado". Era a receita exata do "pedido ativo sem caixa" que a
      // contabilidade existe pra evitar. Com data VÁLIDA mas absurda (ano
      // 2090), o cliente ainda escolhia em que mês o dinheiro dele aparece no
      // DRE. Agora: número ou string parseável, dentro de uma faixa sã — fora
      // disso, 400 na cara (nunca "corrige depois" — regra v178).
      let _pagoEmMs=null;
      if(d.pagoEm!==undefined&&d.pagoEm!==null&&d.pagoEm!==""){
        const _t=(typeof d.pagoEm==="number")?d.pagoEm:Date.parse(String(d.pagoEm));
        const _MIN=Date.UTC(2024,0,1);              // antes disso o site nem existia
        const _MAX=Date.now()+36*3600_000;          // 1 dia + margem de fuso
        if(!Number.isFinite(_t)||_t<_MIN||_t>_MAX){
          return json(res,400,{error:"A data do pagamento não faz sentido. Informe a data que está no comprovante (não pode ser no futuro nem de anos atrás)."});
        }
        _pagoEmMs=_t;
      }
      // ── DEDUP: se o próprio usuário já tem um pedido EM ANÁLISE, não cria
      // outro — devolve o pendente existente. Regularização do admin EM NOME de
      // outro usuário (targetEmail != quem chamou) passa direto, sem dedup.
      if(targetEmail===s.user_email){
        // 💼 MC5-P1 (29/08): o PIX já foi feito ANTES do envio do comprovante —
        // engolir um 2º pedido pendente no dedup seria dinheiro real sem
        // rastro. Cada pedido vira registro PRÓPRIO (a anti-fraude é o
        // hash/transação E2E do comprovante + a trava de "comprovante já
        // usado" na aprovação); só um TETO anti-abuso protege contra spam.
        const _nPend=DB_PEDIDOS.filter(x=>x&&x.userEmail===targetEmail&&x.status==="pendente").length;
        if(_nPend>=3)return json(res,400,{error:"Você já tem 3 pedidos em análise — aguarde a confirmação deles antes de enviar outro. Dúvidas? Chame no WhatsApp."});
        // DEDUP 2 (caso Wagner, 18/07/2026): o dedup acima só vê PENDENTE —
        // aprovado o 1º pedido, o cliente conseguia criar outro igual e o
        // editor aprovava de novo (3× no caso real). Se já existe pedido do
        // MESMO plano pago/ativo há ≤3 dias, devolve o existente em vez de
        // criar outro. Renovação de verdade (dias depois) passa normal, e o
        // admin (Regularizar) não passa por aqui.
        const _tsP=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
        const jaRecente=DB_PEDIDOS.find(x=>x.userEmail===targetEmail
          &&["pago","ativo"].includes(String(x.status||"").toLowerCase())
          &&String(x.plano||"")===String(d.plano||"")
          &&(Date.now()-(_tsP(x.ativadoEm)||_tsP(x.pagoEm)||x.createdAt||0))<=3*86400_000);
        if(jaRecente){
          return json(res,200,{ok:true,duplicado:true,pedido:jaRecente,
            message:"Você já tem um pedido deste plano aprovado há poucos dias — seu plano já está ativo. Se você pagou de novo ou acha que é engano, fale com o suporte pelo WhatsApp."});
        }
      }
      // 💼 MC5-P1 item 6: comprovante que veio mas é inválido NUNCA mais é
      // descartado em silêncio (o pedido nascia "ok" sem prova e o usuário
      // via "recebemos seu comprovante") — agora recusa com o motivo claro.
      if(d.comprovante&&typeof d.comprovante==="string"){
        if(d.comprovante.length>10_700_000)return json(res,400,{error:"O comprovante passou de ~8MB — envie uma foto menor ou um print da tela do banco."});
        if(!/^[A-Za-z0-9+/]/.test(d.comprovante.slice(0,10)))return json(res,400,{error:"O arquivo do comprovante veio corrompido — tente enviar de novo (foto ou print)."});
      }
      const pedido={
        id:"ped_"+Date.now().toString(36)+"_"+crypto.randomBytes(4).toString("hex"),
        createdAt:Date.now(),
        status:"pendente", // pendente | pago | ativo | cancelado | expirado
        userEmail:targetEmail,
        criadoPor:s.user_email, // quem de fato fez a chamada (admin ou o próprio usuário)
        // 🧱 v193 LOTE 11: campos livres com TIPO e TAMANHO (mesmos tetos do
        // cadastro/settings). Antes aceitavam qualquer coisa — objeto, array,
        // 1MB de texto — e iam inteiros pra DB_PEDIDOS (reserializado a cada
        // clique do admin) e pra lista do painel.
        userName:String(d.userName||"").slice(0,160),
        userWhatsapp:String(d.userWhatsapp||"").slice(0,30),
        // v185 LOTE 3: userPhone (o "Telefone alternativo" do checkout) MORREU.
        // Desde o v175 existe UM telefone só (o WhatsApp obrigatório do
        // cadastro); o campo extra não era lido por NENHUMA tela nem por
        // nenhum aviso — era digitação pedida à toa no meio de uma compra.
        userCity:String(d.userCity||"").slice(0,80),
        userState:String(d.userState||"").slice(0,60),
        userAddress:String(d.userAddress||"").slice(0,200),
        plano:planoKey||d.plano||"vipro", // vip | vipro | doublepro
        dias:planoKey?diasReq:(parseInt(d.dias)||30),
        tipo:"plano",
        valorTotal:valorOficial,
        // v193 LOTE 11: desconto SEMPRE 0. Nenhuma tela manda esse campo, mas
        // ele vinha do cliente e era impresso no aviso aos sócios ("(50%
        // desconto)") — e o valor cobrado é sempre o da tabela oficial. Se um
        // dia existir desconto de verdade, nasce com UI e trilha próprias.
        desconto:0,
        // Trilha de consentimento informado — carimba o que a pessoa
        // confirmou entender no momento da compra (auditável depois).
        consentimento:_isAdminCaller?null:{em:Date.now(),versaoTermos:"2026-09b"},
        // 🚨 v177-FIX4 (auditoria): aqui vivia uma 2ª cópia das MESMAS duas
        // validações do bloco acima (tamanho >10.7MB e prefixo base64) — mas
        // o bloco acima já responde 400 e interrompe a requisição, então esses
        // `if` eram inalcançáveis. Duplicação que só podia divergir com o
        // tempo (um limite mudado num lugar só) e virar descarte silencioso.
        // 🧾 v192 LOTE 10: o base64 NUNCA mais entra no objeto que vive na RAM
        // e é reserializado a cada persistPedidos() — vai pro disco na hora e
        // o pedido guarda só o nome do arquivo (bytes lidos sob demanda).
        comprovante:null,
        comprovanteArquivo:null,
        comprovanteType:(()=>{
          const t=d.comprovanteType||'image/jpeg';
          const allowed=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
          return allowed.includes(t)?t:'image/jpeg';
        })(),
        nota:String(d.nota||"").slice(0,500),
        notaAdmin:"",
        ativadoPor:null,
        ativadoEm:null,
        pagoEm:_pagoEmMs,
        // 🎬 v237v: marca pra sempre poder filtrar/excluir de relatórios reais
        // depois — a conta de TESTE única (ver mod-config.js), nunca um
        // padrão. v237v-FIX: resolve o Gmail de CONTATO real primeiro
        // (targetEmail é a chave de login — username pra conta nova, nunca
        // bate direto contra TEST_ACCOUNT_EMAIL — ver _emailContatoReal).
        isTeste:isTestAccountEmail(_emailContatoReal(targetEmail)),
      };
      if(typeof d.comprovante==="string"&&d.comprovante){
        const _arqC=saveComprovante(pedido.id,d.comprovante);
        if(!_arqC)return json(res,500,{error:"Não conseguimos guardar seu comprovante agora (falha ao gravar no servidor). Tente de novo em instantes — nada foi salvo pela metade."});
        pedido.comprovanteArquivo=_arqC;
      }else if(typeof d.comprovanteToken==="string"&&d.comprovanteToken){
        // 🚀 v240c: cliente novo subiu o comprovante ANTES (streamado, via
        // /api/pedido/comprovante-stage) — só reivindica (rename, sem reler
        // o conteúdo) em vez de gravar um base64 que chegou no corpo.
        const _arqC=claimStagedComprovante(d.comprovanteToken,s.user_email,comprovantePath(pedido.id));
        if(!_arqC)return json(res,400,{error:"O comprovante enviado expirou ou é inválido — volte e anexe o comprovante de novo."});
        pedido.comprovanteArquivo=_arqC;
      }
      DB_PEDIDOS.unshift(pedido);
      persistPedidos();
      if(_valorForaTabela){
        logAdminAction(s.user_email,"pedido_valor_fora_tabela",targetEmail,null,
          {pedidoId:pedido.id,plano:pedido.plano,dias:pedido.dias,valorTotal:pedido.valorTotal},
          `Pedido criado pelo admin com valor FORA da tabela oficial (plano "${pedido.plano}", ${pedido.dias}d): R$${Number(pedido.valorTotal||0).toFixed(2)}`);
        console.log(`[pedido] ⚠️ valor fora da tabela registrado por ${s.user_email}: ${pedido.id} R$${pedido.valorTotal} (${pedido.plano} ${pedido.dias}d)`);
      }

      // ── PRÉ-CHECK DO COMPROVANTE (Gemini Vision) — roda na CRIAÇÃO ────────
      // 🧠 Parte 4 (Cérebro): o corpo virou a função ÚNICA preCheckComprovante
      // (usada aqui com ativação provisória E pelo lote do Cérebro, que nunca
      // ativa nada) — mesma leitura, mesmo formato, nunca 2 verdades.
      preCheckComprovante(pedido,{ativar:true}).catch(()=>{});
      // Log interno (registrado no histórico do usuário do plano, não de quem clicou)
      addLog(targetEmail,{status:"sistema",jobTitle:`💳 ${targetEmail!==s.user_email?"Pedido regularizado pelo admin":"Novo pedido de plano"}: ${pedido.plano} ${pedido.dias}d — R$${pedido.valorTotal}`,company:"Pedido #"+pedido.id.slice(-8).toUpperCase()});
      // Email para admins (em background)
      ;(async()=>{
        try{
          // 🚨 v177-FIX (auditoria 14/09/2026): o toggle "Avisar por e-mail
          // quando entrar pedido novo" só guardava o bloco da conta de
          // notificações — com ele DESLIGADO (mas a conta conectada), a
          // execução caía direto no caminho legado abaixo e mandava mesmo
          // assim, pelo Gmail pessoal do admin. "Desligar" não desligava
          // nada, só trocava de remetente. Agora o toggle é checado UMA
          // VEZ, ANTES dos dois caminhos — desligado, NENHUM aviso sai por
          // NENHUM canal, exatamente o que o texto do toggle promete.
          if(!NOTIF.status().avisoPedidos){console.log("[pedido] 🔕 avisoPedidos desligado — nenhum aviso de compra enviado.");return;}
          // 📧 v175 (ordem do dono): a conta de notificações (Admin →
          // Notificações) tem prioridade — o aviso de compra pro Andrio e
          // pro Diego sai pelo Suporte, sem depender do Gmail pessoal de
          // nenhum admin estar conectado. O caminho legado abaixo continua
          // como reserva enquanto a conta não estiver conectada.
          if(NOTIF.conectada()){
            const _mN=_mensagemPedidoAdmin(pedido);let _okN=0;const _falhasN=[];
            for(const toEmail of _notifDestinatarios()){
              try{await NOTIF.sendMail({to:toEmail,subject:_mN.subject,text:_mN.text,attachments:_mN.attachments,tipo:"pedido"});_okN++;console.log("[pedido] ✅ aviso via conta de notificações →",toEmail);}
              catch(e){_falhasN.push({to:toEmail,erro:String(e.message||e).slice(0,160)});console.warn("[pedido] notif err →",toEmail,":",e.message);}
            }
            // 🚨 v177-FIX7 (auditoria 14/09/2026): quando o aviso saía pro Andrio
            // mas falhava pro Diego, o `_okN>0` dava a rodada por boa e o sócio
            // que ficou sem aviso não tinha COMO saber (só um console.warn que
            // ninguém lê, e o lastError da conta é sobrescrito no envio seguinte).
            // A falha por destinatário agora fica gravada NO PEDIDO — a trilha
            // vive o mesmo tempo que o dinheiro dela.
            if(_falhasN.length){
              try{
                const _iF=DB_PEDIDOS.findIndex(x=>x&&x.id===pedido.id);
                if(_iF>=0){DB_PEDIDOS[_iF].avisoFalhas=_falhasN.map(f=>({...f,em:Date.now()}));persistPedidos();}
              }catch{}
              console.error(`[pedido] ⚠️ AVISO NÃO CHEGOU pra ${_falhasN.length} sócio(s) no pedido ${pedido.id}: ${_falhasN.map(f=>f.to).join(", ")} — conferir a aba Notificações (cota de 500/dia do Gmail, conta desconectada, etc.)`);
            }
            if(_okN>0)return;
          }
          let adminToken=null, adminTokenFrom=null;
          // 1) Token de sessão ativa do admin principal
          const adminSessEntry=Object.values(sessions).find(ss=>ss.user_email===ADMIN_EMAIL&&ss.access_token);
          if(adminSessEntry?.access_token){adminToken=adminSessEntry.access_token;adminTokenFrom=ADMIN_EMAIL;}
          // 2) Refresh do admin principal
          if(!adminToken){try{const t=await refreshTokenForUser(ADMIN_EMAIL);if(t){adminToken=t;adminTokenFrom=ADMIN_EMAIL;}}catch{}}
          // 3) FALLBACK ANTI-FALHA-SILENCIOSA: se o admin principal não tem token,
          //    tenta QUALQUER outro admin (sessão ou refresh). Assim o aviso de
          //    pedido nunca deixa de sair só porque uma conta deslogou.
          if(!adminToken){
            for(const ae of ADMIN_EMAILS){
              if(ae===ADMIN_EMAIL) continue;
              const se=Object.values(sessions).find(ss=>ss.user_email===ae&&ss.access_token);
              if(se?.access_token){adminToken=se.access_token;adminTokenFrom=ae;break;}
              try{const t=await refreshTokenForUser(ae);if(t){adminToken=t;adminTokenFrom=ae;break;}}catch{}
            }
          }
          if(!adminToken){console.warn("[pedido] ⚠️ NENHUM admin com token válido — aviso de pedido NÃO enviado. Reconecte o Gmail admin.");}
          if(adminToken){
            const _fromEmail = adminTokenFrom || ADMIN_EMAIL;
            // fonte única da mensagem (a mesma da conta de notificações)
            const {subject:emailSubject,text:emailText,attachments}=_mensagemPedidoAdmin(pedido);

            // 🚨 v177-FIX (auditoria 14/09/2026): mandava pra [...ADMIN_EMAILS]
            // inteiro (inclui os 3 e-mails auxiliares de ADMIN_EMAILS_EXTRA) —
            // o caminho legado nunca respeitava a mesma régua "só os 2 sócios"
            // que _notifDestinatarios() já garante no caminho novo (v175b).
            // Qualquer disparo do legado (conta desconectada, ou reserva de
            // token) mandava nome/WhatsApp/valor/comprovante do cliente pras
            // contas auxiliares, contrariando o CLAUDE.md.
            for(const toEmail of _notifDestinatarios()){
              try{
                // buildMime com anexo se comprovante existir
                const raw=buildMime({
                  to:toEmail,
                  subject:emailSubject,
                  fromName:"H2BApply 💳",
                  fromEmail:_fromEmail,
                  text:emailText,
                  attachments, // array vazio se não tiver comprovante
                });
                await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+adminToken,"Content-Type":"application/json"}},{raw});
                console.log("[pedido] ✅ Email"+(attachments.length?" c/ comprovante":"")+" enviado para:",toEmail);
              }catch(e){console.warn("[pedido] email err →",toEmail,":",e.message);}
            }
          }
        }catch(e){console.warn("[pedido] email geral err:",e.message);}
      })();
      return json(res,200,{ok:true,pedidoId:pedido.id});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // GET /api/pedidos — lista todos os pedidos (admin) ou só do usuário
  if(pathname==="/api/pedidos"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);
    const isAdm=isAdminVip(p);
    let list=isAdm?DB_PEDIDOS:DB_PEDIDOS.filter(pd=>pd.userEmail===s.user_email);
    // Filtros (admin)
    const statusF=u.searchParams.get("status")||"";
    const planoF=u.searchParams.get("plano")||"";
    if(statusF)list=list.filter(pd=>pd.status===statusF);
    if(planoF)list=list.filter(pd=>pd.plano===planoF);
    // Remover base64 do comprovante para listagem (muito pesado)
    // 💼 MC5-P2 item 6 (privacidade, auditoria 29/08): usuário comum recebe
    // WHITELIST — nunca o spread interno (o preCheck cru vazava o E-MAIL DE
    // OUTRO USUÁRIO no dupAlerta; notaAdmin é interna — só a de cancelamento
    // vira o motivo visível). comprovanteStatus é derivado SEGURO:
    // DIVERGENCIA nunca é exposta ao doador (não se avisa quem tenta
    // fraude) — pra ele fica "em análise".
    // 🧾 v188 LOTE 6: o admin decide olhando a LISTA — precisa do nome e do
    // WhatsApp de quem pagou ali, não só do e-mail. O nome da CONTA vence o
    // que foi digitado no checkout (o cadastro v175 obriga nome/sobrenome;
    // userName é fallback de pedido antigo).
    const slim=isAdm
      ?list.map(pd=>{const _cu=getUser(pd.userEmail)||{};
        return {...pd,comprovante:temComprovante(pd),ehAdmin:isAdminEmail(pd.userEmail||""),
          contaNome:_cu.name||"",contaWhatsapp:_cu.whatsapp||_cu.phone||""};})
      :list.map(_pedidoVisaoUsuario);
    return json(res,200,{ok:true,pedidos:slim,total:list.length});
  }
  // 💼 MC5-P2 item 5: reenvio de comprovante pelo DONO do pedido pendente —
  // fecha o beco sem saída do comprovante ilegível (a foto melhor SUBSTITUI,
  // com trilha do hash anterior; leitura e fingerprint recalculados na hora).
  if(pathname.startsWith("/api/pedido/")&&pathname.endsWith("/comprovante")&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // 🚨 v234 (achado de auditoria — Média): sem rate limit nenhum — cada
    // chamada grava até ~8MB no disco E dispara preCheckComprovante(ativar:
    // true), que em produção chama a IA (Gemini) pra ler o comprovante de
    // novo. Sem trava, um script hostil (ou um bug de retry em loop no
    // cliente) conseguia martelar a rota e gastar cota de IA/disco à toa.
    // Mesmo padrão de /api/cadastro e /api/login (rateLimit por identidade).
    if(rateLimit("comprovante_reenvio_"+s.user_email,5,3_600_000))return json(res,429,{error:"Muitos reenvios de comprovante em pouco tempo. Aguarde um pouco e tente de novo."});
    try{
      const pid=decodeURIComponent(pathname.slice("/api/pedido/".length,-"/comprovante".length));
      const pd=DB_PEDIDOS.find(p2=>p2&&p2.id===pid);
      if(!pd)return json(res,404,{error:"Pedido não encontrado."});
      if(pd.userEmail!==s.user_email&&!isAdminVip(getUser(s.user_email)))return json(res,403,{error:"Este pedido não é seu."});
      if(pd.status!=="pendente")return json(res,400,{error:"Só dá pra trocar o comprovante de um pedido ainda em análise."});
      const d=JSON.parse(await readBody(req));
      const c=d.comprovante;
      // 🚀 v240c: reenvio também aceita o token de um comprovante já
      // streamado (/api/pedido/comprovante-stage), fonte única com a criação.
      const _tokRe=typeof d.comprovanteToken==="string"&&d.comprovanteToken?d.comprovanteToken:null;
      if(!_tokRe){
        if(!c||typeof c!=="string")return json(res,400,{error:"Envie o comprovante."});
        if(c.length>10_700_000)return json(res,400,{error:"O comprovante passou de ~8MB — envie uma foto menor."});
        if(!/^[A-Za-z0-9+/]/.test(c.slice(0,10)))return json(res,400,{error:"O arquivo veio corrompido — tente de novo."});
      }
      const _allowRe=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
      pd.comprovanteAnteriorHash=pd.comprovanteHash||null; // trilha (nunca o base64 antigo — RAM)
      let _arqRe;
      if(_tokRe){
        _arqRe=claimStagedComprovante(_tokRe,s.user_email,comprovantePath(pd.id));
        if(!_arqRe)return json(res,400,{error:"O comprovante enviado expirou ou é inválido — anexe de novo."});
      }else{
        _arqRe=saveComprovante(pd.id,c); // v192 LOTE 10: disco, nunca RAM
        if(!_arqRe)return json(res,500,{error:"Não conseguimos guardar o comprovante novo agora. Tente de novo em instantes — o anterior continua valendo."});
      }
      pd.comprovanteArquivo=_arqRe;
      pd.comprovante=null;
      pd.comprovanteType=_allowRe.includes(d.comprovanteType)?d.comprovanteType:'image/jpeg';
      pd.comprovanteHash=null;delete pd.preCheck;delete pd._avisoLeituraEm;
      pd.comprovanteReenviadoEm=Date.now();
      persistPedidos();
      preCheckComprovante(pd,{ativar:true}).catch(()=>{});
      console.log(`[pedido] 📤 comprovante reenviado pelo dono: ${pd.id} (${s.user_email})`);
      return json(res,200,{ok:true,message:"Comprovante atualizado — vamos reler agora."});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // GET /api/pedido/:id — detalhe de um pedido incluindo comprovante
  if(pathname.startsWith("/api/pedido/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const pid=decodeURIComponent(pathname.slice("/api/pedido/".length));
    const pd=DB_PEDIDOS.find(x=>x.id===pid);
    if(!pd)return json(res,404,{error:"Pedido não encontrado."});
    const p=getUser(s.user_email);
    if(!isAdminVip(p)&&pd.userEmail!==s.user_email)return json(res,403,{error:"Acesso negado."});
    // v193 LOTE 11: usuário comum vê a MESMA projeção da lista (função única),
    // nunca o objeto cru — antes bastava GET no próprio pedido pra receber
    // notaAdmin interna, avisoFalhas e o preCheck com e-mail de terceiro.
    if(!isAdminVip(p))return json(res,200,{ok:true,pedido:_pedidoVisaoUsuario(pd),usuario:null});
    // Admin recebe também um retrato do VIP atual do usuário, para o modal calcular
    // a validade final (com empilhamento) e exibir o extrato de dias.
    let usuario=null;
    if(isAdminVip(p)){
      const tu=getUser(pd.userEmail)||{};
      const _now=Date.now();
      usuario={
        email:pd.userEmail,
        plan:tu.plan||"free",
        manualExpires:tu.vip?.manualExpires||0,
        autoExpires:tu.vip?.autoExpires||0,
        source:tu.vip?.source||null,
        manualAtivo:!!(tu.vip?.manualExpires&&tu.vip.manualExpires>_now)&&tu.vip?.source!=="trial",
        diasRestantes:Math.max(0,diasRestantesCanonico(Math.max(tu.vip?.manualExpires||0,tu.vip?.autoExpires||0),_now)),
        creditos:Array.isArray(tu.vip?.creditos)?tu.vip.creditos.slice(-30).reverse():[],
        totalPago:(tu.vip?.creditos||[]).filter(c=>c.tipo==="pago").reduce((a,c)=>a+(c.dias||0),0),
        totalGratis:(tu.vip?.creditos||[]).filter(c=>c.tipo==="gratis").reduce((a,c)=>a+(c.dias||0),0),
      };
    }
    // 🧾 v192 LOTE 10: o contrato da resposta não mudou (o painel abre o
    // comprovante a partir daqui) — só a ORIGEM dos bytes: disco, sob demanda,
    // numa CÓPIA (o objeto em memória continua sem o base64).
    return json(res,200,{ok:true,pedido:{...pd,comprovante:loadComprovante(pd)},usuario});
  }
  // PATCH /api/pedido/:id — admin atualiza status (v2: senha + bônus + Gemini)
  if(pathname.startsWith("/api/pedido/")&&req.method==="PATCH"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const pid=decodeURIComponent(pathname.slice("/api/pedido/".length));
    if(DB_PEDIDOS.findIndex(x=>x.id===pid)<0)return json(res,404,{error:"Pedido não encontrado."});
    try{
      const d=JSON.parse(await readBody(req));
      // v18-FIX: NÃO reaproveita o índice calculado antes do await acima —
      // POST /api/pedido faz DB_PEDIDOS.unshift(...), que desloca o índice de
      // TODO pedido existente em +1. Se um pedido novo chegar enquanto este
      // PATCH está no meio do upload do body (rede lenta, comum em 4G),
      // o índice antigo passa a apontar pra OUTRO pedido — ativando o VIP
      // errado / creditando dias na conta de outro usuário. Refaz a busca
      // por ID (não por índice) agora que o body já terminou de chegar.
      const idx=DB_PEDIDOS.findIndex(x=>x.id===pid);
      if(idx<0)return json(res,404,{error:"Pedido não encontrado (pode ter sido removido)."});
      const pd=DB_PEDIDOS[idx];

      // 🚫 v194 LOTE 12: o branch `corrigirValor` deste PATCH foi REMOVIDO
      // junto com a rota /api/admin/pedido-set-valor — mesma ordem v178
      // (valor errado CANCELA e o cliente refaz; não existe "corrigir e
      // aprovar mesmo assim"). Sem chamador em tela nenhuma, ele era a 2ª
      // porta pra reescrever o valor de um pedido ILEGIVEL/ERRO e ativar.
      if(d.corrigirValor!==undefined){
        return json(res,400,{error:"Correção de valor de pedido não existe mais: pedido com valor errado é CANCELADO e o cliente faz um novo com o valor certo (ordem do dono, v178).",correcaoRemovida:true});
      }

      // Validar senha de editor ao ativar
      if(d.status==="ativo"){
        // 🎯 v178: pedido CANCELADO (inclusive pelo auto-cancelamento por
        // valor divergente, logo abaixo) nunca pode ser ativado depois — o
        // caminho certo é o cliente criar um pedido novo com o valor
        // certo, nunca "reviver" este.
        if(pd.canceladoEm){
          return json(res,409,{error:`⛔ Este pedido foi CANCELADO${pd.notaAdmin?" ("+String(pd.notaAdmin).slice(0,140)+")":""} e não pode ser ativado. Se o cliente pagou o valor certo, ele precisa fazer um pedido novo.`,jaCancelado:true,canceladoPor:pd.canceladoPor,canceladoEm:pd.canceladoEm});
        }
        // GUARD DUPLA ATIVAÇÃO: se este pedido JÁ foi ativado, recusa com erro claro.
        // Evita que Andrew e Diego ativem o mesmo pedido e contem os dias 2×.
        // Seguro contra corrida: pd.ativadoEm é setado de forma SÍNCRONA mais abaixo,
        // antes de qualquer await — então a 2ª requisição cai aqui e é barrada.
        if(pd.ativadoEm){
          const quem=pd._ativadoEditor||pd.ativadoPor||"o outro editor";
          const quando=pd.ativadoEm?new Date(pd.ativadoEm).toLocaleString("pt-BR"):"";
          console.log(`[pedido] ⛔ dupla ativação barrada: ${pd.id} (já ativado por ${quem})`);
          return json(res,409,{error:`⛔ Este pedido JÁ FOI ATIVADO por ${quem}${quando?` em ${quando}`:""}. Não dá pra ativar de novo (evita contar os dias duas vezes).`,jaAtivado:true,ativadoPor:quem,ativadoEm:pd.ativadoEm});
        }
        // GUARD PEDIDO DUPLICADO (dono, 18/07/2026 — caso Wagner: 3 pedidos
        // iguais do MESMO cliente aprovados em sequência = R$450 e 90 dias
        // creditados de UM pagamento de R$150/30d). A guarda acima só vê o
        // MESMO pedido; esta vê OUTRO pedido igual: mesmo cliente, mesmo
        // plano, pago/ativo há ≤3 dias. Só ativa com confirmação explícita
        // do editor (confirmarDuplicado:true) — na dúvida, cancela o extra.
        if(!d.confirmarDuplicado){
          const _3d=3*86400_000,_agr=Date.now();
          const _ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
          // 🚨 v177-FIX4 (auditoria 14/09/2026): a comparação era `plano ===
          // plano` (string exata) — o cliente que pagou 2× em poucos dias
          // escolhendo planos DIFERENTES (erro comum: comprou VIP, quis o
          // VIPro e pagou de novo) passava batido, sem NENHUM aviso ao admin,
          // e ficava com os dois períodos empilhados. O guard continua sendo
          // só um aviso confirmável (o robô avisa, o humano decide) — upgrade
          // legítimo aprova igual, com 1 clique a mais e vendo os dois pedidos.
          // O fallback de data também estava errado (`criadoEm` não existe no
          // pedido — o campo é `createdAt`), então pedido marcado pago sem
          // data de pagamento nunca entrava na janela de 3 dias.
          const _dup=DB_PEDIDOS.find(x=>x&&x.id!==pd.id&&x.userEmail===pd.userEmail
            &&["pago","ativo"].includes(String(x.status||"").toLowerCase())
            &&(_agr-(_ts(x.ativadoEm)||_ts(x.pagoEm)||_ts(x.criadoEm)||_ts(x.createdAt)))<=_3d);
          if(_dup){
            console.log(`[pedido] ⚠️ possível duplicado: ${pd.id} × ${_dup.id} (${pd.userEmail})`);
            return json(res,409,{duplicado:true,pedidoDup:_dup.id,
              error:`⚠️ POSSÍVEL DUPLICADO: este cliente já tem o pedido #${_dup.id.slice(-8).toUpperCase()} (${_dup.plano}) pago/ativo há menos de 3 dias — este aqui é ${pd.plano}. Se ele pagou DE NOVO de verdade, confirme; se é o mesmo pagamento, CANCELE este pedido.`});
          }
        }
        // 💼 MC5-P1 item 1 (auditoria 29/08): a aprovação agora ENXERGA o
        // pré-check. Nada bloqueia definitivo — mas aprovar leitura ruim
        // (DIVERGENCIA/ILEGIVEL) ou valor lido ≠ valor do pedido exige
        // confirmação explícita, VENDO os números (mesmo padrão do
        // confirmarDuplicado). O robô avisa, o humano decide.
        // 🧹 v235 (achado de auditoria — Baixa): removido um 3º veredito
        // deste allowlist que nunca existia de verdade — _geminiComprovanteParse
        // e o gancho de teste só produzem ERRO/ILEGIVEL/CONFERE/DIVERGENCIA,
        // e pedido sem comprovante nenhum nunca chega a ter `preCheck`
        // setado (a checagem já é `_pc&&[...]`, então _pc falsy já cobria
        // esse caso). Era código morto — nunca dava match.
        if(!d.confirmarDivergencia){
          const _pc=pd.preCheck||null;
          const _vLido=(_pc&&_pc.valorLido!=null)?parseFloat(_pc.valorLido):null;
          const _ruim=_pc&&["DIVERGENCIA","ILEGIVEL"].includes(String(_pc.veredito||"").toUpperCase());
          const _difere=_vLido!=null&&Math.abs(_vLido-(pd.valorTotal||0))>=0.01;
          if(_ruim||_difere){
            return json(res,409,{divergencia:true,veredito:_pc?.veredito||null,valorLido:_vLido,valorPedido:pd.valorTotal||0,
              error:`⚠️ O robô leu este comprovante como ${_pc?.veredito||"?"}${_vLido!=null?` (leitura R$${_vLido.toFixed(2)} × pedido R$${(pd.valorTotal||0).toFixed(2)})`:""}. Abra o comprovante e confira antes de creditar — pra aprovar mesmo assim, confirme.`});
          }
        }
        // 💼 MC5-P1 item 2: comprovante JÁ USADO — mesmo ARQUIVO (hash
        // SHA-256) ou mesma TRANSAÇÃO PIX (E2E) já pago/ativo em outro
        // pedido de QUALQUER usuário. Antes essa fraude só aparecia na
        // auditoria das 02h, DEPOIS dos 💎 creditados — agora barra na hora.
        if(!d.confirmarComprovanteUsado){
          const _usado=_comprovanteJaUsado(pd);
          if(_usado){
            return json(res,409,{comprovanteUsado:true,pedidoDup:_usado.id,emailDup:_usado.userEmail,
              error:`🔴 COMPROVANTE JÁ USADO: ${(pd.comprovanteHash&&_usado.comprovanteHash===pd.comprovanteHash)?"o MESMO arquivo":"a MESMA transação PIX"} já apareceu no pedido #${String(_usado.id||"").slice(-8).toUpperCase()} (${_usado.userEmail}, status "${_usado.status}"). Só confirme se tiver CERTEZA que são pagamentos diferentes.`});
          }
        }
        // v57 (dono, 25/07) — atualizado p/ v172b (12/09): sem senha extra aqui — a
        // sessão de admin (login por usuário+senha em /api/admin-panel/login desde
        // o v172b, nunca mais Google) já garante quem é o editor; o e-mail da sessão
        // identifica quem fez a ação.
        const editorKey=editorFromEmail(_sessAdminEmail(s));
        pd._ativadoEditor=editorKey==="andrew"?"Andrew":"Diego";
        pd._ativadoEditorEmail=_sessAdminEmail(s);
      }

      // v21: status só da máquina de estados oficial. As guardas de duplicidade
      // comparam com igualdade EXATA (x.status==="pendente") — um status fora
      // do padrão (typo, capitalização) faria todas falharem em silêncio.
      if(d.status){
        const _STATUS_OK=["pendente","pago","ativo","cancelado","expirado"];
        if(!_STATUS_OK.includes(d.status))return json(res,400,{error:`Status inválido: "${d.status}". Use: ${_STATUS_OK.join(", ")}.`});
        pd.status=d.status;
      }
      if(d.notaAdmin!==undefined)pd.notaAdmin=String(d.notaAdmin).slice(0,500);

      if(d.status==="ativo"&&!pd.ativadoEm){
        pd.ativadoPor=_sessAdminEmail(s);
        pd.ativadoEm=Date.now();
        // ── COMPRA DIRETA DE PLANO (v170 — dono, 09/09/2026): aprovar o
        // pedido ativa o plano NA HORA, sem etapa intermediária. O caixa
        // recebe a entrada normal (mesma fonte única que Sócios/DRE leem).
        const planoKey={vip:"vip",vipro:"vipro",doublepro:"doublepro"}[String(pd.plano||"").toLowerCase()]||"vip";
        const dias=parseInt(pd.dias,10)||30;
        pd.diasTotal=dias; // ⚠️ estorno-de-dias no cancelamento (abaixo) e a reconciliação do boot leem ESTE campo — sem ele, cancelar um pedido não devolve os dias
        const isAuto=["vipro","doublepro"].includes(planoKey);
        // ⚠️ v171 (auditoria 11/09/2026): se ESTE pedido já tinha ativação
        // PROVISÓRIA (autoAtivarProvisorio), addManualVipDays/addAutoVipDays
        // empilhariam os dias pagos EM CIMA do provisório ainda não vencido —
        // a expiração final passava a valer mais que pd.diasTotal, e o
        // estorno do cancelamento (que só subtrai pd.diasTotal) nunca
        // recuperava essa sobra: pedido cancelado ficava com dias de plano
        // pago ativos de graça. O pagamento SUCEDE o provisório, nunca soma
        // com ele — zera o provisório deste pedido (cap em "agora", nunca
        // no passado) antes de empilhar os dias pagos, mesmo padrão que a
        // revogação de provisório já usa abaixo.
        // ℹ️ ESTADO REAL (v204 LOTE 22 — o comentário que estava aqui dizia
        // que autoAtivarProvisorio "só roda no gancho TEST_LOGIN_TOKEN", o
        // que é FALSO desde o v177): a ativação provisória é caminho de
        // PRODUÇÃO — preCheckComprovante chama o Gemini de verdade e, com
        // veredito CONFERE, ativa na hora. O risco de 2 provisórios
        // disputando `vip.pedidoId` foi FECHADO no v177-FIX4: só existe UM
        // provisório por vez (o 2º pedido espera a confirmação humana), então
        // a checagem `===pd.id` abaixo nunca mais fica órfã.
        const uProv=getUser(pd.userEmail);
        if(pd.autoAtivado&&uProv?.vip?.source==="auto-provisorio"&&uProv.vip.pedidoId===pd.id){
          const agoraP=Date.now();
          setUser(pd.userEmail,{vip:{...uProv.vip,
            manualExpires:Math.min(uProv.vip.manualExpires||0,agoraP),
            autoExpires:Math.min(uProv.vip.autoExpires||0,agoraP)}});
        }
        addManualVipDays(pd.userEmail,dias);
        if(isAuto)addAutoVipDays(pd.userEmail,dias);
        const uFresh=getUser(pd.userEmail)||{}; // relê fresco — os helpers acima já gravaram
        setUser(pd.userEmail,{plan:planoKey,vip:{...(uFresh.vip||{}),plan:planoKey,source:"payment",
          activatedAt:pd.ativadoEm,activatedBy:pd._ativadoEditor||"Admin",
          note:`Plano ${nomePlanoDisplay(planoKey)} ${dias}d — pedido #${pd.id.slice(-8).toUpperCase()}`,
          days:dias,autoDays:isAuto?dias:0,limits:limitesDoPlanoNovo(planoKey)}});
        addCredito(pd.userEmail,{dias,tipo:"pago",origem:"pagamento",
          motivo:`Plano ${nomePlanoDisplay(planoKey)} ${dias}d — pedido #${pd.id.slice(-8).toUpperCase()}`,
          dadoPor:pd._ativadoEditor||"Admin",pedidoId:pd.id,valor:pd.valorTotal||0});
        const _pgTs=(typeof pd.pagoEm==="number"&&Number.isFinite(pd.pagoEm))?pd.pagoEm:Date.parse(String(pd.pagoEm||""));
        // 🎬 v237v: pedido da conta de TESTE NUNCA entra no caixa — confirmar
        // ativa o plano normalmente (mesmo VIP de sempre, pro vídeo mostrar o
        // ciclo completo) mas o "dinheiro" nunca nasce em DB_FINANCEIRO, então
        // nenhuma tela financeira (Indicadores/Sócios/DRE/Conferência/
        // Pagantes/Visão do Dono) precisa nem saber que isso existiu.
        if(pd.isTeste){
          console.log(`[financeiro] 🎬 pedido de TESTE confirmado (${pd.userEmail}) — plano ativado, SEM entrada no caixa (v237v)`);
        }
        if(!DB_FINANCEIRO.pagamentos)DB_FINANCEIRO.pagamentos=[];
        if(!pd.isTeste&&!DB_FINANCEIRO.pagamentos.some(x=>x.pedidoId===pd.id)){
          DB_FINANCEIRO.pagamentos.unshift({
            id:"fin_"+Date.now().toString(36),email:pd.userEmail,
            nome:pd.userName||pd.userEmail,plano:planoKey,
            dias,valor:pd.valorTotal||0,desconto:0,
            nota:`Plano ${nomePlanoDisplay(planoKey)} ${dias}d — pedido #${pd.id.slice(-8).toUpperCase()}`,
            data:new Date().toISOString(),
            // v193 LOTE 11: cinto e suspensório — a criação já recusa data
            // sem sentido, mas pedido LEGADO pode ter `pagoEm` lixo gravado
            // antes desta versão. Aqui isso NUNCA mais pode estourar depois
            // de creditar os dias: data impossível vira "hoje", que é o pior
            // caso honesto (o lançamento entra; o dinheiro não some).
            dataPagamento:new Date(Number.isFinite(_pgTs)?_pgTs:Date.now()).toISOString(),
            pedidoId:pd.id,source:"pedido_automatico",
            ativadoPor:pd._ativadoEditor||"Admin",ativadoPorEmail:_sessAdminEmail(s),
            // 💼 MC5-P5: dono do dinheiro só entra se veio EXPLÍCITO no enum.
            // Sem ele, o campo é OMITIDO — computeSocios deriva honestamente
            // da trilha (ativadoPorEmail) e conta como "derivado", em vez de
            // carimbar um sócio na marra sem ninguém ter dito quem recebeu.
            ...((["andrio","diego"].includes((d.recebidoPor||"").toLowerCase()))
              ?{recebidoPor:(d.recebidoPor||"").toLowerCase()}:{}),
            whatsapp:pd.userWhatsapp||""
          });
          _persistFinConferido("aprovação do pedido #"+pd.id.slice(-8).toUpperCase()); // MC5-P6: gravação conferida
          console.log("[financeiro] plano ativado:",pd.userEmail,"R$",pd.valorTotal,"→",planoKey,dias+"d");
        }
        addLog(pd.userEmail,{status:"sistema",jobTitle:`✅ Plano ${nomePlanoDisplay(planoKey)} ativado (${dias}d) — pedido #${pd.id.slice(-8).toUpperCase()} confirmado`,company:"Pedido #"+pd.id.slice(-8).toUpperCase()});
        persistPedidos();
        acordarRoboAposPlano(pd.userEmail); // v125: robô dormindo por limite antigo acorda já
        return json(res,200,{ok:true,pedido:(()=>{const{comprovante,..._l}=pd;return _l;})(),plano:planoKey,dias});
      }

      if(d.status==="cancelado"){
        const _rC=_cancelarPedidoInterno(pd,{por:_sessAdminEmail(s),notaAdmin:d.notaAdmin});
        if(!_rC.ok){
          console.log(`[pedido] ⛔ duplo cancelamento barrado: ${pd.id} (já cancelado por ${_rC.body.canceladoPor})`);
          return json(res,_rC.status,_rC.body);
        }
      }
      persistPedidos(); // v18-FIX: idem — pd já é a referência viva do array, sem reescrita por índice
      return json(res,200,{ok:true,pedido:pd});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── GET /api/admin/conferencia — TODOS os pagamentos desde a 1ª compra ────
  // (dono, 21/07/2026) Uma linha por pagamento: pedidos de plano (qualquer
  // status; comprovante sob demanda via GET /api/pedido/:id). Sem imagens na
  // lista (leve). v194 LOTE 12: o valor do pedido NÃO é mais editável por
  // lugar nenhum — valor errado cancela e o cliente refaz (ordem v178); os
  // campos valorOriginal/valorCorrigidoPor continuam viajando como LEITURA
  // da trilha de pedido antigo já carimbado.
  // 🧾 3.0-P7 — fonte ÚNICA da Conferência: a lista e a exportação usam o
  // MESMO builder e o MESMO filtro (nunca 2 verdades sobre os pagamentos).
  const _confData=()=>{
    const rows=[];
    // v53 (ORDEM DO DONO, 25/07: "eudes, andrio não pagamos pra usar o
    // programa — se tiver contando algum valor de nossas contas,
    // desconsidere"): conta de ADMIN nunca entra na Conferência, nem nas
    // divergências, nem em nenhum total — pedido/código de admin é teste
    // interno, não receita. Fonte da verdade: isAdminEmail (mod-config).
    // 🎬 v237v: mesma exclusão pra conta de TESTE — o pedido de demo não
    // pode aparecer como venda de verdade na Conferência. v237v-FIX: pelo
    // isTeste do próprio pedido (_pedidoNaoEhReceita), nunca pela chave de
    // login crua (username de conta nova nunca bate contra TEST_ACCOUNT_EMAIL).
    for(const pd of DB_PEDIDOS){
      if(_pedidoNaoEhReceita(pd))continue;
      rows.push({tipo:"pedido",id:pd.id,em:pd.createdAt||0,
        email:pd.userEmail,nome:pd.userName||pd.userEmail,
        plano:pd.plano,dias:pd.dias,valor:pd.valorTotal||0,status:pd.status,
        temComprovante:temComprovante(pd),comprovanteType:pd.comprovanteType||null,
        autoAtivado:!!pd.autoAtivado,ativadoEm:pd.ativadoEm||null,
        ativadoPor:pd._ativadoEditor||pd.ativadoPor||null,pagoEm:pd.pagoEm||null,
        preCheck:pd.preCheck?{veredito:pd.preCheck.veredito,resumo:pd.preCheck.resumo||""}:null,
        // 🧠 Parte 5 (Conferência 2.0, item 20): o triângulo por linha —
        // valor lido no comprovante + veredito da leitura (lote do cérebro)
        comprovanteLido:pd.preCheck&&pd.preCheck.valorLido!=null?pd.preCheck.valorLido:null,
        comprovanteVeredito:pd.preCheck?.veredito||null,
        // 🧾 2.0-P2: OCR completo na linha — quem pagou, por qual banco e o
        // ID da transação (E2E) que o motor de duplicidade cruza
        comprovantePagador:pd.preCheck?.pagadorLido||null,
        comprovanteTransacao:pd.preCheck?.transacaoIdLida||null,
        comprovanteInstituicao:pd.preCheck?.instituicaoLida||null,
        valorOriginal:pd.valorOriginal!==undefined?pd.valorOriginal:null,
        valorCorrigidoPor:pd.valorCorrigidoPor||null,valorCorrigidoEm:pd.valorCorrigidoEm||null});
    }
    rows.sort((a,b)=>(b.em||0)-(a.em||0));
    const resumo={
      total:rows.length,
      pedidos:rows.filter(r=>r.tipo==="pedido").length,
      codigos:rows.filter(r=>r.tipo==="codigo").length,
      valorPedidos:rows.filter(r=>r.tipo==="pedido"&&["pago","ativo"].includes(r.status)).reduce((s2,r)=>s2+(r.valor||0),0),
      valorCodigos:rows.filter(r=>r.tipo==="codigo").reduce((s2,r)=>s2+(r.valor||0),0),
    };
    // ── 🔍 DIVERGÊNCIAS plano × pedido × caixa ────────────────────────────
    // A reconciliação do boot só cobre UMA direção (pedido pago → devolver
    // dias). Aqui as outras quatro, pro número do dono nunca mentir:
    //   1. VIP pago ativo sem NENHUM pedido pago/ativo que o justifique
    //   2. pedido ATIVO com valor mas sem entrada no caixa
    //   3. entrada automática do caixa apontando pra pedido inexistente ou
    //      CANCELADO (receita inflada)
    //   4. valor do caixa ≠ valor do pedido (legado de antes da correção
    //      sincronizada — a própria Conferência corrige)
    const divergencias=[];
    const nowD=Date.now();
    const _emailsComPedidoPago=new Set(DB_PEDIDOS
      .filter(pd=>["pago","ativo"].includes(String(pd.status||"").toLowerCase()))
      .map(pd=>String(pd.userEmail||"").toLowerCase()));
    for(const [em,usr] of Object.entries(DB_USERS)){
      if(!usr?.vip||usr.isAdmin||_usuarioNaoEhReceita(em,usr))continue; // v53 + v237v-FIX: admin/teste fora das divergências (emailContato, não a chave)
      if(!["payment","pago"].includes(String(usr.vip.source||"")))continue;
      const expD=Math.max(usr.vip.manualExpires||0,usr.vip.autoExpires||0);
      if(expD<=nowD)continue;
      if(!_emailsComPedidoPago.has(String(em).toLowerCase()))
        divergencias.push({tipo:"vip_sem_pedido",email:em,nome:usr.name||em,
          msg:`VIP ${String(usr.vip.plan||"?").toUpperCase()} ativo até ${new Date(expD).toLocaleDateString("pt-BR")} sem NENHUM pedido pago/ativo no sistema`});
    }
    const _pagsAut=(DB_FINANCEIRO.pagamentos||[]).filter(pg=>!naoEhReceita(pg.email)); // v53 + v237v: caixa de admin/teste não é divergência
    for(const pd of DB_PEDIDOS){
      if(_pedidoNaoEhReceita(pd))continue; // v53 + v237v-FIX
      if(String(pd.status||"")!=="ativo"||(pd.valorTotal||0)<=0)continue;
      if(!_pagsAut.some(x=>x.pedidoId===pd.id))
        divergencias.push({tipo:"pedido_sem_caixa",email:pd.userEmail,nome:pd.userName||pd.userEmail,pedidoId:pd.id,
          msg:`Pedido #${(pd.id||"").slice(-8).toUpperCase()} ATIVO (R$ ${(pd.valorTotal||0).toFixed(2)}) sem entrada no caixa`});
    }
    for(const pg of _pagsAut){
      if(pg.source!=="pedido_automatico"||!pg.pedidoId)continue;
      const pdX=DB_PEDIDOS.find(x=>x.id===pg.pedidoId);
      if(!pdX)divergencias.push({tipo:"caixa_orfao",email:pg.email,nome:pg.nome||pg.email,
        msg:`Entrada de R$ ${(pg.valor||0).toFixed(2)} no caixa aponta pra pedido que NÃO existe (${String(pg.pedidoId).slice(-8).toUpperCase()})`});
      else if(String(pdX.status||"")==="cancelado")divergencias.push({tipo:"caixa_cancelado",email:pg.email,nome:pg.nome||pg.email,pedidoId:pdX.id,
        msg:`Entrada de R$ ${(pg.valor||0).toFixed(2)} no caixa de pedido CANCELADO #${(pdX.id||"").slice(-8).toUpperCase()} — receita inflada`});
      else if(Math.abs((pg.valor||0)-(pdX.valorTotal||0))>0.01)divergencias.push({tipo:"valor_diverge",email:pg.email,nome:pg.nome||pg.email,pedidoId:pdX.id,
        msg:`Caixa R$ ${(pg.valor||0).toFixed(2)} ≠ pedido R$ ${(pdX.valorTotal||0).toFixed(2)} (#${(pdX.id||"").slice(-8).toUpperCase()}) — corrija pelo ✏️ da Conferência`});
    }
    // 💳 v141 — 5ª divergência (caso Cleiton): concessão de dias duplicada
    // (mesmo usuário, 2 ativações de plano em poucos minutos).
    for(const dup of detectarConcessoesDuplicadas(15)){
      const u2=getUser(dup.email);
      if(_usuarioNaoEhReceita(dup.email,u2))continue; // v53 + v237v-FIX
      divergencias.push({tipo:"concessoes_duplicadas",email:dup.email,nome:u2?.name||dup.email,
        msg:`Plano ativado 2x em ${dup.gapMin}min — possível clique duplo (${dup.a1.detail} → ${dup.a2.detail}). Confira em 💳 Pagantes → clique no usuário.`});
    }
    return {rows,resumo,divergencias};
  };
  // 🧾 3.0-P7 — filtro único da Conferência: busca multi-campo (nome, e-mail,
  // pedido, código, plano, pagador do OCR, transação, instituição, valor),
  // status, tipo e janela de dias. Sem parâmetro = comportamento de sempre.
  const _confFiltrarRows=(rows0,f)=>{
    let out=rows0;
    if(f.tipo)out=out.filter(r=>r.tipo===f.tipo);
    if(f.status)out=out.filter(r=>String(r.status||"")===f.status);
    const dJ=parseInt(f.janela,10);
    if(dJ>0){const corte=Date.now()-dJ*86400_000;out=out.filter(r=>(r.em||0)>=corte);}
    if(f.q){const s2=String(f.q).toLowerCase().trim();
      out=out.filter(r=>[r.email,r.nome,r.plano,r.id,r.code,r.status,r.comprovantePagador,r.comprovanteTransacao,r.comprovanteInstituicao,String(r.valor??"")]
        .some(v=>v&&String(v).toLowerCase().includes(s2)));}
    return out;
  };
  if(pathname==="/api/admin/conferencia"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const {rows,resumo,divergencias}=_confData();
    const f={q:u.searchParams.get("q")||"",status:u.searchParams.get("status")||"",tipo:u.searchParams.get("tipo")||"",janela:u.searchParams.get("janela")||""};
    const temFiltro=!!(f.q||f.status||f.tipo||f.janela);
    const out=temFiltro?_confFiltrarRows(rows,f):rows;
    return json(res,200,{ok:true,rows:out,resumo,divergencias,
      filtrados:out.length,valorFiltrado:Math.round(out.reduce((s2,r)=>s2+(r.valor||0),0)*100)/100});
  }
  // 🧾 3.0-P7 — exportação da Conferência (CSV ;+BOM / JSON) respeitando os
  // MESMOS filtros da tela — o admin baixa exatamente o que está vendo.
  if(pathname==="/api/admin/conferencia/exportar"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const {rows}=_confData();
      const f={q:u.searchParams.get("q")||"",status:u.searchParams.get("status")||"",tipo:u.searchParams.get("tipo")||"",janela:u.searchParams.get("janela")||""};
      const out=_confFiltrarRows(rows,f).map(r=>({
        data:r.em?new Date(r.em).toISOString().slice(0,10):"",tipo:r.tipo,id:r.id,
        email:r.email,nome:r.nome,plano:r.plano||"",dias:r.dias??"",valor:r.valor||0,status:r.status||"",
        comprovante:r.temComprovante?"sim":"não",veredito:r.comprovanteVeredito||"",valorLido:r.comprovanteLido??"",
        pagador:r.comprovantePagador||"",transacao:r.comprovanteTransacao||"",instituicao:r.comprovanteInstituicao||"",
        ativadoPor:r.ativadoPor||"",codigo:r.code||"",
      }));
      const nomeBase="conferencia-"+new Date().toISOString().slice(0,10)+(f.q||f.status||f.tipo||f.janela?"-filtrada":"");
      if(u.searchParams.get("fmt")==="json"){
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="${nomeBase}.json"`,"Cache-Control":"no-store"});
        return res.end(JSON.stringify({geradoEm:new Date().toISOString(),filtros:f,total:out.length,valorTotal:Math.round(out.reduce((s2,r)=>s2+(r.valor||0),0)*100)/100,rows:out},null,2));
      }
      const cols=Object.keys(out[0]||{vazio:1});
      const escCsv=(v)=>{const s2=String(v??"");return /[",;\n]/.test(s2)?'"'+s2.replace(/"/g,'""')+'"':s2;};
      const corpo="﻿"+cols.join(";")+"\n"+out.map(r=>cols.map(c2=>escCsv(r[c2])).join(";")).join("\n");
      res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="${nomeBase}.csv"`,"Cache-Control":"no-store"});
      return res.end(corpo);
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── POST /api/admin/resumo-diario-run — gatilho manual do Resumo do Dono ──
  if(pathname==="/api/admin/resumo-diario-run"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    return json(res,200,await resumoDiarioDonoRun());
  }

  // ── /api/status ───────────────────────────────────────
  if(pathname==="/api/status"){
    const s=getSess(req);if(!s?.user_email)return json(res,200,{connected:false});
    markOnline(s.user_email);
    const p=getUser(s.user_email);if(!p)return json(res,200,{connected:false,reason:"user_not_found"});
    // v63b: AUTO-CURA da foto de perfil (bug real 26/07, print do dono:
    // avatar "?" no Servidor 3). Conta logada SEM picture no banco ganha UMA
    // tentativa por sessão de puxar a foto do Google com o token que já temos
    // — achou, persiste (merge não-crítico) e o avatar aparece no próximo
    // load, sem exigir relogin. Fail-open: token expirado/erro = segue sem foto.
    if(!p.picture && s.access_token && !s._picTried){
      s._picTried=true;
      try{
        const{status:_ps,body:_ui}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+s.access_token}});
        if(_ps===200&&_ui&&_ui.picture){setUser(s.user_email,{picture:_ui.picture});p.picture=_ui.picture;console.log(`[status] 📸 Foto de perfil recuperada do Google para ${s.user_email}`);}
      }catch(e){}
    }
    const vipOk=isVipActive(p);
    const planKey=getPlan(p);const {todayManual:sentManual,todayAuto:sentAuto}=getUserStatsCached(s.user_email);
    const h=getHist(s.user_email);
    const totalSent=h.length;const totalManual=h.filter(x=>x.type==="manual").length;const totalAutoHist=h.filter(x=>x.type==="auto").length;
    const manualLimit=getManualLimit(p),autoLimit=getAutoLimit(p);
    const autoJob=getAutoJob(s.user_email);
    const stats=getAutoStats(s.user_email);
    const now2=Date.now();
    // 🛡️ v73: status de AQUECIMENTO por conta (transparência — sem isso, o
    // usuário acha que travou/bugou quando na verdade é a proteção rodando).
    // v118: aviso pros CONTRATOS ANTIGOS (sem vip.limits): regras mudaram, mas
    // o plano atual está garantido até vencer com os limites de hoje.
    const _prNotice=(vipOk&&p.vip&&!p.vip.limits&&!["trial","auto-provisorio"].includes(String(p.vip.source||"")))?
      `📢 As regras dos planos mudaram! O seu plano atual está garantido até ${new Date(Math.max(p.vip.manualExpires||0,p.vip.autoExpires||0)).toLocaleDateString("pt-BR")} com seus limites de hoje (${manualLimit} manual${autoLimit>10?` / ${autoLimit} automático`:""} por dia). Na próxima troca por plano valem os limites novos.`:null;
    // 🔒 v172 (ORDEM DO DONO, 11/09/2026): o front usa isto pra decidir qual
    // CTA mostrar em Automático/Manual — "assine um plano" (sem plano pago)
    // vs "conecte seu Gmail" (tem plano, mas nunca passou por
    // /oauth/connect-send). Admin é isento SÓ da trava de PLANO — a de Gmail
    // conectado vale pra ele igual todo mundo (bug real achado em auditoria,
    // 12/09/2026: esta linha dava gmailConnected:true pra TODO admin mesmo
    // sem refresh_token nenhum, escondendo pra sempre o card "Meu Gmail
    // (admin) — não conectado" e anulando o próprio propósito do fix do
    // e09ccd0 — /api/send e /api/auto/start já faziam a checagem certa
    // [!p.refresh_token, sem isentar admin], só este campo do /api/status
    // estava errado).
    const gmailConnected = !!p.refresh_token;
    // 🐛 v172c: o front nunca recebia o Gmail REAL conectado — só "email"
    // (identidade de login, USERNAME sem @ pra conta nova), então toda tela
    // que precisa mostrar "qual Gmail vai enviar" (dropdown do envio manual,
    // checklist do automático) rotulava o username como se fosse o Gmail
    // principal. resolveSendGmail devolve o endereço certo (ou null se ainda
    // não conectou nenhum).
    // 🚨 v177-FIX5 (auditoria 14/09/2026): o selo "🌱 Aquecendo X/Y hoje"
    // (primaryWarmup.sentToday, abaixo) contava o histórico por s.user_email —
    // que pra conta v172c é o USERNAME de login, nunca o Gmail real gravado em
    // senderEmail. Pra essas contas o filtro jamais casava e o selo mostrava
    // sempre 0, escondendo o throttling real do usuário (regra 13a: nunca
    // esconder esse throttling). Agora conta pela chave resolvida, mantendo o
    // username como fallback (conta legada, cujo histórico usa o próprio e-mail).
    const gmailEmail = resolveSendGmail(p);
    // 💳 v187: "paguei, o robô liberou 3 dias, venceu e ninguém confirmou" —
    // sem este campo a TELA repetia "seu plano venceu, assine de novo" pra
    // quem já tem o pedido na mesa do admin (o servidor já não repete: ver
    // planGateMsg). null quando não há provisório vencendo com pedido pendente.
    const _provPend = _provisorioPendente(p);
    return json(res,200,{connected:true,sendOnly:GMAIL_SEND_ONLY,newPurchasesBlocked:NEW_PURCHASES_BLOCKED&&!isAdminVip(p),planRulesNotice:_prNotice,
      provisorioPendente:_provPend?{pedidoId:_provPend.pedidoId,ref:_provPend.ref}:null,manualCdOff:p.manualCdOff===true,gmailConnected,gmailEmail,emailContato:p.emailContato||null,emailVerificado:!!p.emailVerificadoEm,needsPlan:!isAdminVip(p)&&!vipOk,email:s.user_email,name:p.name||s.user_name,picture:p.picture||s.picture||"",country:p.country||"Brazil",phone:p.phone||"",whatsapp:p.whatsapp||"",cc:p.cc||"",city:p.city||"",estado:p.estado||p.state||"",language:p.language||"pt",h2bProfile:p.h2bProfile||{},age:p.age||0,isAdmin:!!p.isAdmin,plan:planKey,totalSent,totalManual,totalAutoHist,vip:p.vip?{active:vipOk,expiresAt:p.vip.expiresAt||Math.max(p.vip.manualExpires||0,p.vip.autoExpires||0),activatedAt:p.vip.activatedAt,days:p.vip.days||30,plan:p.vip.plan||"vip",manualExpires:p.vip.manualExpires||0,autoExpires:p.vip.autoExpires||0,manualActive:isManualVipActive(p),autoActive:isAutoVipActive(p),source:p.vip.source||null}:null,todaySentManual:sentManual,manualLimit,manualRemaining:Math.max(0,manualLimit-sentManual),todaySentAuto:sentAuto,autoLimit,autoRemaining:Math.max(0,autoLimit-sentAuto),autoEnabled:true,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0,source:autoJob.source,startedAt:autoJob.startedAt,lastSentAt:autoJob.lastSentAt,nextSendAt:autoJob.nextSendAt,currentJob:autoJob.currentJob,originalCount:autoJob.originalCount}:null,autoStats:stats,cvs:(p.cvs||[]).map(c=>({idx:c.idx,name:c.name,size:c.size,date:c.date,cvType:c.cvType||"resume"})),settings:p.settings||{},onboarded:!!p.onboarded,adminMessage:p.adminMessage||null,profiles:p.profiles||[],senderEmails:(p.senderEmails||[]).map(sm=>({email:sm.email,label:sm.label||"",active:sm.active!==false,tokenExpired:!!sm.tokenExpired,blocked:!!sm.blocked,blockedReason:sm.blockedReason||null,addedAt:sm.addedAt,warmupCap:warmupCapForSender(sm.addedAt),sentToday:h.filter(x=>x.dateStr===todayStr()&&x.senderEmail===sm.email).length})),senderMax:getMaxSenders(p),primaryWarmup:{cap:warmupCapForSender(p.gmailConnectedAt||p.created_at),sentToday:h.filter(x=>x.dateStr===todayStr()&&(x.senderEmail===(gmailEmail||s.user_email)||x.senderEmail===s.user_email||!x.senderEmail)).length},adminSettings:isAdminVip(p)?{intervalSecs:(p.adminSettings?.intervalSecs||300),senderLimits:(p.adminSettings?.senderLimits||{}),maxSenders:getMaxSenders(p)}:null});
  }

  if(pathname==="/api/onboard"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});setUser(s.user_email,{onboarded:true});return json(res,200,{ok:true});}
  if(pathname==="/api/settings"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));const upd={};
      if(d.name!==undefined){upd.name=String(d.name).slice(0,200);s.user_name=upd.name;}
      if(d.country!==undefined)upd.country=String(d.country).slice(0,100);
      if(d.phone!==undefined){
        upd.phone=String(d.phone).slice(0,50);
        // Registrar telefone no DB_TRIAL_USED quando usuário que teve trial cadastra phone
        const _ph=upd.phone.replace(/\D/g,"");
        if(_ph.length>=8){
          const _curU=getUser(s.user_email);
          const _hadTrial=_curU?.vip?.source==="trial"||(_curU?.vip?.note||"").includes("Trial");
          if(_hadTrial&&!DB_TRIAL_USED.phones[_ph]){
            DB_TRIAL_USED.phones[_ph]=s.user_email;
            try{fs.writeFileSync(TRIAL_USED_FILE,JSON.stringify(DB_TRIAL_USED,null,2));}catch{}
            console.log(`[trial] 📱 Telefone ${_ph} vinculado ao trial de ${s.user_email}`);
          }
        }
      }
      if(d.whatsapp!==undefined)upd.whatsapp=String(d.whatsapp).slice(0,50);
      if(d.age!==undefined){const a=parseInt(d.age)||0;if(a>=10&&a<=100)upd.age=a;}
      if(d.city!==undefined)upd.city=String(d.city).slice(0,100);
      // 🚨 v177-FIX6 (auditoria 14/09/2026): aceitava QUALQUER string de até 10
      // chars como idioma e devolvia ela no /api/status, onde o front aplica
      // cegamente o que existir no dicionário. Whitelist, normalizada pra 2
      // letras ("pt-BR"→"pt"); qualquer outra coisa é ignorada, nunca gravada.
      // 🇧🇷 v199 LOTE 17: a whitelist virou "pt" e SÓ. O site não tem seletor de
      // idioma (decisão de produto) — aceitar 'en'/'es' aqui era o único jeito
      // de uma conta ficar presa num idioma que nenhuma tela sabe desfazer.
      if(d.language!==undefined){
        const _lg=String(d.language).slice(0,2).toLowerCase();
        if(_lg==="pt")upd.language="pt";
      }
      // h2bProfile: objeto completo
      if(d.h2bProfile){
        const cur=getUser(s.user_email)||{};
        const hbp=d.h2bProfile;
        upd.h2bProfile={
          ...(cur.h2bProfile||{}),
          experiencedH2B:!!hbp.experiencedH2B,
          h2bSeasons:Math.max(0,parseInt(hbp.h2bSeasons)||0),
          englishLevel:["none","basic","intermediate","advanced"].includes(hbp.englishLevel)?hbp.englishLevel:"basic",
          preferredArea:String(hbp.preferredArea||"general").slice(0,50),
          usaTrips:!!hbp.usaTrips,
          hasDriverLicense:!!hbp.hasDriverLicense,
          availability:["immediate","1month","3months"].includes(hbp.availability)?hbp.availability:"immediate",
        };
      }
      // v120 (ORDEM DO DONO, 05/08): o cooldown de 1min do envio MANUAL é o
      // padrão, mas o USUÁRIO pode desligar — desde que aceite o risco (o
      // front só manda true depois do aceite explícito; guardamos o carimbo
      // de quando aceitou). O automático NÃO tem escolha: 7min sempre.
      if(d.manualCdOff!==undefined){
        upd.manualCdOff=d.manualCdOff===true;
        if(upd.manualCdOff)upd.manualCdOffAt=Date.now();
      }
      // v199 LOTE 18: `settings` não é mais GRAVADO pelo cliente (nenhuma tela
      // manda o campo; era um merge de objeto arbitrário dentro do users.json).
      // A leitura segue viva no /api/status pra conta antiga que tem dado ali.
      setUser(s.user_email,upd);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/cv/upload"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Sessão expirada. Faça login novamente.",sessionExpired:true,code:"SESSION_EXPIRED"});
    // v167 (bug real, auditoria 08/09/2026): antes SÓ /api/auto/start recusava
    // rodar em disco volátil (/tmp, sem volume persistente montado) — este
    // upload e o /api/profiles/save abaixo respondiam 200 "salvo com sucesso"
    // normalmente, mas o PDF (e o perfil inteiro) SOMEM no próximo restart/
    // deploy do processo Node. Isso produz exatamente o padrão relatado:
    // "salvei, funcionou na hora, mas depois sumiu". Mesmo aviso claro de
    // /api/auto/start, agora nas duas rotas mais usadas do fluxo de perfil.
    if(DATA_DIR==="/tmp")return json(res,503,{error:"⚠️ Servidor sem volume persistente (/tmp). O upload funcionaria agora, mas o arquivo SOME no próximo reinício. Configure DATA_DIR=/data com volume persistente antes de continuar.",diskVolatile:true});
    if(rateLimit(s.user_email+"_cv",10,3600_000))return json(res,429,{error:"Muitos uploads. Tente novamente em 1 hora."});
    const _ctype=(req.headers["content-type"]||"").toLowerCase();
    if(_ctype.startsWith("application/json")){
      // Caminho legado: cliente antigo em cache (Service Worker) ainda manda
      // base64 dentro de JSON — mantido byte-a-byte igual antes, só a
      // persistência final foi extraída pra _finalizeCvUpload (fonte única
      // com o caminho novo abaixo).
      try{
        const d=JSON.parse(await readBody(req));if(!d.base64||!d.name)return json(res,400,{error:"base64 e name obrigatórios."});
        const estimatedBytes=Math.round(d.base64.length*0.75);
        const cvType=(d.cvType||"resume");const _cvMaxLen=cvType==="cover"?4_200_000:7_000_000;
        if(d.base64.length>_cvMaxLen)return json(res,400,{error:cvType==="cover"?"Carta maior que 3MB.":"Currículo maior que 5MB."});
        if(estimatedBytes<1000)return json(res,400,{error:"Arquivo muito pequeno ou corrompido."});
        const pdfBuf=Buffer.from(d.base64.slice(0,8),"base64");if(pdfBuf.length<4||pdfBuf[0]!==0x25||pdfBuf[1]!==0x50||pdfBuf[2]!==0x44||pdfBuf[3]!==0x46)return json(res,400,{error:"Arquivo inválido: não é um PDF. Envie um arquivo .pdf válido."});
        const safeName=String(d.name).replace(/[<>"'&\r\n\t]/g,"").slice(0,200);if(!safeName)return json(res,400,{error:"Nome do arquivo inválido."});
        const _r=_finalizeCvUpload(s.user_email,safeName,cvType,estimatedBytes,idx=>saveCv(s.user_email,idx,d.base64));
        return json(res,_r.status,_r.body);
      }catch(e){return json(res,500,{error:e.message});}
    }
    // 🚀 v240b: caminho novo — o cliente manda o PDF cru como corpo binário
    // (nunca mais base64 dentro de JSON) e streama direto pro disco, sem
    // bufferizar o arquivo inteiro na RAM antes de gravar. Metadados (nome,
    // tipo) vêm na query string porque o corpo é só o arquivo.
    let cvType="resume";
    try{
      cvType=(u.searchParams.get("cvType")||"resume")==="cover"?"cover":"resume";
      const safeName=String(u.searchParams.get("name")||"").replace(/[<>"'&\r\n\t]/g,"").slice(0,200);
      if(!safeName)return json(res,400,{error:"Nome do arquivo inválido."});
      const {tmpPath,size}=await streamBodyToTempFile(req,CV_MAX_BYTES[cvType]);
      if(size<1000){try{fs.unlinkSync(tmpPath);}catch{}return json(res,400,{error:"Arquivo muito pequeno ou corrompido."});}
      const sig=readFirstBytes(tmpPath,4);
      if(sig.length<4||sig[0]!==0x25||sig[1]!==0x50||sig[2]!==0x44||sig[3]!==0x46){try{fs.unlinkSync(tmpPath);}catch{}return json(res,400,{error:"Arquivo inválido: não é um PDF. Envie um arquivo .pdf válido."});}
      const _r=_finalizeCvUpload(s.user_email,safeName,cvType,size,idx=>saveCvFromFile(s.user_email,idx,tmpPath),()=>{try{fs.unlinkSync(tmpPath);}catch{}});
      return json(res,_r.status,_r.body);
    }catch(e){
      if(e.message==="PAYLOAD_TOO_LARGE")return json(res,400,{error:cvType==="cover"?"Carta maior que 3MB.":"Currículo maior que 5MB."});
      return json(res,500,{error:e.message});
    }
  }
  if(/^\/api\/cv\/\d+$/.test(pathname)&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const idx=parseInt(pathname.split("/").pop(),10);const p=getUser(s.user_email);if(!p?.cvs?.find(c=>c.idx===idx))return json(res,403,{error:"CV não encontrado."});const b64=loadCv(s.user_email,idx);if(!b64)return json(res,404,{error:"Arquivo não encontrado."});return json(res,200,{base64:b64,idx});}
  if(/^\/api\/cv\/\d+$/.test(pathname)&&req.method==="DELETE"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const idx=parseInt(pathname.split("/").pop(),10);const p=getUser(s.user_email);if(!p?.cvs?.find(c=>c.idx===idx))return json(res,403,{error:"CV não encontrado."});deleteCv(s.user_email,idx);const _cleanProfiles=(p.profiles||[]).map(pr=>{const np={...pr};if(np.resumeIdx===idx){delete np.resumeIdx;delete np.pdfName;np.pdfSize=0;}if(np.coverIdx===idx){delete np.coverIdx;delete np.coverName;np.coverSize=0;}return np;});setUser(s.user_email,{cvs:(p.cvs||[]).filter(c=>c.idx!==idx),profiles:_cleanProfiles});return json(res,200,{ok:true});}

  if(pathname==="/api/send"&&req.method==="POST"){
    const _sendT0=Date.now(); // DIAGNÓSTICO (2026-07-09): mede onde o tempo vai num envio manual — relato de "180 envios em 3h" sem causa óbvia no código; até achar a causa definitiva, loga se demorar muito, pra próxima vez ter dado real em vez de suposição.
    // 🔒 v172 (ORDEM DO DONO, 11/09/2026): o check antigo (!s?.access_token)
    // confundia "está autenticado" com "tem permissão de Gmail" — desde que
    // login parou de trazer um access_token gmail.send-capaz, TODA sessão
    // logada batia aqui em "Sessão expirada." mesmo pra quem só queria
    // NAVEGAR (e nem estava tentando enviar ainda). Autenticação de verdade
    // é só user_email; a capacidade de ENVIAR é checada embaixo, em 2
    // camadas: plano pago ativo (isVipActive) e Gmail conectado (refresh_token).
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Sessão expirada."});
    const p=getUser(s.user_email)||{};
    if(!isAdminVip(p)&&!isVipActive(p))return json(res,402,{error:planGateMsg(p,"Você precisa de um plano ativo pra enviar candidaturas.","manual"),needsPlan:true});
    // 🔒 v172: admin pula a trava de PLANO (isAdminVip já vale como plano
    // máximo), mas NÃO pula a de Gmail conectado — sem token de verdade
    // ninguém envia nada, admin incluso; bypassar aqui só trocaria um erro
    // limpo (403 needsGmailConnect) por um erro cru lá na frente.
    if(!p.refresh_token)return json(res,403,{error:"Conecte seu Gmail pra começar a enviar candidaturas.",needsGmailConnect:true});
    let dedupKey = null; // declarado fora do try para que o catch possa acessar
    let _reservedManualSlot=false; // idem — precisa ser liberada mesmo se o catch pegar um erro
    let _toEmailForErr=null; // idem — usado só pra dar contexto numa mensagem de erro amigável
    try{
      const d=JSON.parse(await readBody(req));if(!d.to||!d.subject||!d.message)return json(res,400,{error:"Campos obrigatórios."});
      _toEmailForErr=String(d.to||"");
      // v15-SEC: normalização e validação robusta do destinatário
      const _parsedTo = parseEmail(d.to);
      if (!_parsedTo.ok) return json(res,400,{error:`E-mail inválido: ${_parsedTo.reason}`});
      const toEmail = _parsedTo.email;
      // v118 (ORDEM DO DONO, 02/08): 1 envio MANUAL por minuto — o relógio
      // conta a partir do envio anterior. Proteção anti-spam às empresas,
      // vale pra todo mundo (admin isento pra testes). Vem ANTES de token/
      // limite diário: recusa barata, sem gastar nada.
      // v120 (ORDEM DO DONO, 05/08): o usuário pode DESLIGAR essa proteção
      // (p.manualCdOff, aceite de risco registrado) — escolha dele, o Gmail
      // é dele. Só o cooldown do manual é opcional; o automático segue 7min.
      if(!isAdminVip(p)&&p.manualCdOff!==true){
        // addHist usa unshift → o envio mais RECENTE mora no índice 0.
        const _hArr=getHist(s.user_email)||[];
        for(let _i=0;_i<_hArr.length;_i++){
          const _h=_hArr[_i];
          if(_h.type!=="manual")continue;
          const _elapsed=Date.now()-new Date(_h.sentAt||0).getTime();
          if(_elapsed>=0&&_elapsed<60000){
            const _left=Math.ceil((60000-_elapsed)/1000);
            return json(res,429,{error:`⏳ Espere ${_left}s pro próximo envio manual (regra: 1 por minuto, protege seu Gmail e as empresas).`,cooldownLeft:_left});
          }
          break; // só o manual mais recente importa
        }
      }
      // v15-SEC: guarda contra auto-envio
      // v18-FIX: antes só comparava com o email PRINCIPAL — quem tem um Gmail
      // extra conectado (recurso pago, ex. DoublePro) podia "candidatar-se" sem
      // querer pro próprio segundo Gmail, desperdiçando 1 vaga do limite diário.
      const _ownEmails=new Set([s.user_email.toLowerCase(), ...((p.senderEmails||[]).map(x=>String(x.email||"").toLowerCase()).filter(Boolean))]);
      if (_ownEmails.has(toEmail)) return json(res,400,{error:"Não é possível enviar candidatura para seu próprio e-mail (principal ou extra conectado)."});
      // 🚨 v177-FIX2 (auditoria 14/09/2026): o robô automático já pula e-mail
      // com bounce conhecido (comInvalidos:true no _excluirEnviadosFn), mas o
      // envio MANUAL nunca consultava DB_INVALID_EMAILS — o usuário podia
      // gastar 1 do limite diário mandando pra um e-mail que o próprio site
      // já sabe que devolve erro. Bloqueio direto, sem gastar limite/cooldown.
      if (isEmailInvalid(toEmail)) return json(res,400,{error:"Este e-mail já retornou erro de entrega em envios anteriores (bounce conhecido) — não vale a pena gastar seu envio nele. Escolha outra vaga."});
      // v15-SEC: assunto e corpo não podem ser vazios
      if (!String(d.subject).trim()) return json(res,400,{error:"O assunto do e-mail não pode estar em branco."});
      if (!String(d.message).trim()) return json(res,400,{error:"O corpo do e-mail não pode estar em branco."});

      // 🚫 v194 LOTE 12 — O RAMO `isReply` MORREU. Ele não tinha NENHUM
      // chamador (a aba Respostas não existe nesta reconstrução e o app é
      // só-envio), e era um bypass de verdade: com `isReply:true` + um
      // threadId que o próprio /api/send devolveu, o envio pulava limite
      // diário, cooldown, freio de rajada, "já enviei pra esse empregador"
      // (regra 8) e a fila do automático — até 50 e-mails/dia extras pra
      // empregadores JÁ contatados, gravados com countedAsManual:false.
      // Cliente antigo em cache que ainda mande `threadId`/`messageId` não
      // perde a candidatura: os campos são IGNORADOS e o envio segue como
      // novo. Só `isReply:true` é recusado, com explicação.
      if(d.isReply===true){
        return json(res,400,{error:"Este aplicativo só ENVIA candidaturas novas — responder e-mail de empregador não existe aqui (nem lemos caixa de entrada). Atualize a página e envie a candidatura normalmente.",respostaRemovida:true});
      }

      // ── DEDUP: impede envio simultâneo do mesmo email para o mesmo destinatário ──
      dedupKey = s.user_email + "|" + toEmail + "|new";
      if (_manualSendInFlight.has(dedupKey)) {
        return json(res,409,{error:"Envio em andamento para este destinatário. Aguarde.",duplicate:true});
      }
      _manualSendInFlight.set(dedupKey, Date.now());
      // Remove lock após 15s (garante limpeza mesmo em erro)
      setTimeout(()=>_manualSendInFlight.delete(dedupKey), 15000);

      { // v194 LOTE 12: bloco sem `if` — TODO envio passa por estas checagens
        // (era `if(!isReply)`, e o ramo de resposta pulava todas elas).
        // v18-FIX: rajada — antes só a resposta (reply) tinha rateLimit(); o envio
        // de candidatura nova não tinha NENHUM freio de curto prazo, só o limite
        // diário (que por sua vez tinha a corrida corrigida abaixo). Agora também
        // trava rajadas rápidas independente do limite diário total.
        // 🚨 v177-FIX5 (auditoria 14/09/2026): este freio de rajada é anterior
        // à isenção de admin do cooldown de 1min (v120) e nunca foi revisado —
        // uma sessão de QA do admin mandando >20 candidaturas em 1 minuto
        // (dentro do limite diário dele) levava 429, contrariando a intenção
        // declarada de "admin isento pra testes". Mesma régua do cooldown.
        if(!isAdminVip(p)&&rateLimit(s.user_email+"_send_burst",20,60_000))return json(res,429,{error:"Muitos envios em pouco tempo. Aguarde um minuto."});
        // Só verifica limite para candidaturas novas (não respostas)
        const lim=getManualLimit(p);const h=getHist(s.user_email);const sent=countManualToday(h);
        // v18-FIX (corrida TOCTOU / "180 envios em 3h"): soma as reservas de envios
        // já em voo (checagem passou, Gmail ainda não respondeu) — sem isso, duas
        // requisições concorrentes liam a mesma contagem "antiga" do histórico e
        // as DUAS passavam no limite, estourando a cota do plano numa rajada.
        const _reserved=_manualSendReserved.get(s.user_email)||0;
        if(sent+_reserved>=lim)return json(res,429,{error:`Limite de ${lim} envios/dia atingido.`,limitReached:true,plan:getPlan(p),todaySent:sent,dailyLimit:lim});
        // v16-FIX: bloqueia manual se já enviado (manual ou automático) — evita duplicata
        if(hasSent(s.user_email,toEmail))return json(res,409,{error:"Você já enviou para esta empresa. Verifique o histórico.",alreadySent:true});
        // v17-FIX: verifica se email está na fila do automático (ainda não enviado)
        const _autoQ = getAutoJob(s.user_email);
        if(_autoQ?.active && _autoQ.queue?.some(q => _normEmail(q.to) === _normEmail(toEmail)))
          return json(res,409,{error:"Esta empresa está na fila do envio automático. Aguarde ou cancele o automático primeiro.",inAutoQueue:true});
        // v18-FIX: o automático marca a vaga em job.currentJob ENQUANTO está enviando
        // (antes de terminar e marcar em DB_SENT) — a checagem acima não pegava esse
        // instante intermediário, permitindo que o manual mandasse pra MESMA empresa
        // que o automático estava processando naquele exato momento (envio duplicado).
        if(_autoQ?.active && _autoQ.currentJob && _normEmail(_autoQ.currentJob.to)===_normEmail(toEmail))
          return json(res,409,{error:"O envio automático está processando esta empresa agora. Aguarde alguns segundos e tente novamente.",inAutoQueue:true});
        _reserveManualSlot(s.user_email); _reservedManualSlot=true;
        // Rede de segurança: libera a reserva sozinha em 60s mesmo se algo impedir
        // o fluxo normal de chegar ao release explícito (ex. crash raro no meio do envio).
        setTimeout(()=>{ if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;} }, 60_000);
      }

      const attachments=[];const getAtt=async idx=>{if(idx==null)return null;const m=p.cvs?.find(c=>c.idx===parseInt(idx,10));return m&&loadCv(s.user_email,m.idx)?{data:loadCv(s.user_email,m.idx),name:m.name}:null;};
      {// Toda candidatura é NOVA — anexos sempre
        let resumeAttached=false;
        // 🚨 v177-FIX5 (auditoria 14/09/2026): o caminho alternativo pdfBase64
        // (currículo mandado direto no corpo, sem passar pelos Documentos)
        // empurrava o base64 CRU pro anexo do e-mail sem NENHUMA das validações
        // que /api/cv/upload aplica — dava pra mandar qualquer coisa (ou lixo
        // corrompido) em nome do usuário pro empregador. Mesma régua do upload:
        // tamanho e magic bytes %PDF.
        if(d.resumeIdx!=null){const a=await getAtt(d.resumeIdx);if(a){attachments.push(a);resumeAttached=true;}}
        else if(d.pdfBase64){
          const _pb=String(d.pdfBase64);
          const _pbuf=Buffer.from(_pb.slice(0,8),"base64");
          const _pbRuim=_pb.length>7_000_000
            ?"Currículo maior que 5MB — reduza o arquivo antes de enviar."
            :(_pbuf.length<4||_pbuf[0]!==0x25||_pbuf[1]!==0x50||_pbuf[2]!==0x44||_pbuf[3]!==0x46)
              ?"O currículo anexado não é um PDF válido. Envie um arquivo .pdf de verdade."
              :null;
          if(_pbRuim){
            // Mesma disciplina do pdfMissing (v172e): este return é liso, não
            // passa pelo catch — solta a reserva de slot e o lock do dedup.
            if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
            _manualSendInFlight.delete(dedupKey);
            return json(res,400,{error:_pbRuim,pdfInvalid:true});
          }
          attachments.push({data:_pb,name:d.pdfName||"resume.pdf"});resumeAttached=true;
        }
        if(d.coverIdx!=null){const a=await getAtt(d.coverIdx);if(a)attachments.push(a);}
        // v21: MESMA regra do automático (v16-FIX) — candidatura sem currículo
        // anexado não pode chegar no empregador (queima o usuário e a
        // reputação do app). Se o resumeIdx apontava pra PDF apagado/corrompido
        // e nada foi anexado, tenta o primeiro currículo válido da conta; se
        // não existir NENHUM, bloqueia com erro claro em vez de enviar vazio.
        // v167 (bug real, auditoria 08/09/2026): a checagem era !attachments.length
        // (TOTAL de anexos) — com coverIdx válido e resumeIdx órfão, o total dava
        // 1 (só a carta) e este bloco nunca rodava: a candidatura saía SEM
        // CURRÍCULO, 200 de sucesso, sem aviso nenhum. Checagem agora é só sobre
        // o currículo, nunca conta a carta como substituta dele.
        if(!resumeAttached){
          const _fb=(p.cvs||[]).find(c=>(c.cvType||"resume")==="resume"&&loadCv(s.user_email,c.idx));
          if(_fb){attachments.push({data:loadCv(s.user_email,_fb.idx),name:_fb.name||"resume.pdf"});console.warn(`[send] ⚠️ ${s.user_email}: resumeIdx=${d.resumeIdx} sem arquivo — usando fallback "${_fb.name}"`);}
          else{
            // 🐛 v172e (auditoria, 12/09/2026): esse retorno acontece DEPOIS da
            // reserva de slot (_reserveManualSlot acima) mas é um "return" liso,
            // nunca passa pelo catch — sem isso a reserva ficava "fantasma" até
            // o setTimeout de 60s, e um reenvio rápido (currículo corrigido, ou
            // outra vaga) podia levar um 429 de limite sem o usuário ter
            // esgotado a cota de verdade.
            if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
            return json(res,400,{error:"Seu currículo (PDF) não foi encontrado no servidor. Vá em Perfil → Documentos e envie o PDF de novo antes de se candidatar.",pdfMissing:true});
          }
        }
      }

      // ── Multi-sender: selecionar email de envio ─────────────
      const requestedSender=(d.senderEmail||"").toLowerCase().trim()||null;
      const sid=getSessId(req);
      let actualSenderEmail=s.user_email;
      let r;
      if(requestedSender&&requestedSender!==s.user_email){
        // Enviar via email extra especificado manualmente pelo usuário
        try{
          const{token:senderTok,senderEmail:usedEmail,releaseWarmup}=await getSenderToken(s.user_email,requestedSender);
          if(senderTok){
            actualSenderEmail=usedEmail;
            // 🚨 v237n: libera a reserva de aquecimento (getSenderToken) assim
            // que ESTA tentativa de envio termina, sucesso ou falha — nunca
            // espera a rede de segurança de 30s, senão um envio já concluído
            // fica contado 2x (no hist real E na reserva) até o timer estourar.
            try{
              const raw2=buildMimeWithHeaders({to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",fromEmail:usedEmail,attachments});
              const payload2={raw:raw2};
              const{status:gs2,body:gb2}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+senderTok,"Content-Type":"application/json"}},payload2);
              if(gb2?.error)throw new Error(gb2.error.message||JSON.stringify(gb2.error));
              if(gs2!==200)throw new Error("Gmail HTTP "+gs2);
              r=gb2;
            }finally{ if(releaseWarmup)releaseWarmup(); }
          }else{r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments});}
        }catch(e2){
          // 🛡️ v73: a conta ESCOLHIDA pelo usuário está em aquecimento — cair
          // pro principal sem checar ele também poderia furar a proteção da
          // OUTRA conta. Mais simples e mais seguro: avisar, não redirecionar.
          if(e2.message==="WARMUP_CAP_REACHED"){
            // 🐛 v172e: mesmo caso do pdfMissing acima — "return" liso após a
            // reserva de slot, nunca passa pelo catch externo. Sem liberar
            // aqui, a reserva fantasma podia gerar um 429 de limite indevido
            // num reenvio rápido com outra conta/vaga dentro da janela de 60s.
            if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
            return json(res,429,{error:"Essa conta Gmail atingiu o limite de segurança de hoje (proteção contra bloqueio pelo Google — ela é nova aqui e ainda está em aquecimento). Tente outra conta ou volte em algumas horas.",warmup:true});
          }
          // 🚨 v230: mesma filosofia do WARMUP_CAP_REACHED acima — a conta
          // ESCOLHIDA está bloqueada pelo Google; avisar com clareza é mais
          // seguro que trocar pro principal em silêncio (o usuário podia ter
          // motivo pra não usar o principal nesse envio específico).
          if(e2.message==="SENDER_BLOCKED"){
            if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
            return json(res,409,{error:"Essa conta Gmail está bloqueada pelo Google e não pode enviar. Escolha outro remetente em Perfil → Gmail Extra, ou reconecte essa conta.",senderBlocked:true});
          }
          // 🚨 v237l (achado de auditoria — Alta, gmail-envio): até aqui, QUALQUER
          // exceção do sender extra (incluindo timeout de rede — httpsReq dá 15s
          // e pode cair sem NUNCA saber se o Gmail já processou o envio) caía
          // direto no reenvio pelo principal, abaixo. Num timeout ambíguo, isso
          // podia mandar a MESMA candidatura 2x pro empregador (1x pela conta
          // extra que talvez tenha saído mesmo com erro local, 1x pelo
          // principal) — sem o usuário nem o sistema saberem. e2.noResponse
          // (marcado em httpsReq/mod-gmail.js) é só true quando a rejeição
          // aconteceu SEM nenhuma resposta HTTP do Gmail — recusa o reenvio
          // automático nesse caso específico, em vez de arriscar duplicar.
          if(e2.noResponse){
            if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
            console.warn("[send] ⚠️ Timeout AMBÍGUO no sender extra — NÃO reenviando pelo principal (risco de duplicar):",e2.message);
            return json(res,502,{error:"Não deu pra confirmar se a candidatura saiu — a conexão com o Google caiu antes da resposta chegar (pode ter saído ou não). Confira em Enviadas antes de tentar de novo: reenviar agora pode duplicar o e-mail pro empregador se o primeiro já tiver saído.",ambiguousSend:true});
          }
          console.warn("[send] Sender extra falhou, usando principal:",e2.message);
          actualSenderEmail=s.user_email;
          r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments});
        }
      }else if(!requestedSender){
        // ── Round-robin automático no envio MANUAL (sem sender especificado) ──
        // Alterna entre principal e extras igualmente, igual ao automático
        try{
          const{token:rrTok,senderEmail:rrEmail}=await getSenderToken(s.user_email,null);
          actualSenderEmail=rrEmail;
          if(rrTok&&rrEmail!==s.user_email){
            // Extra escolhido pelo round-robin
            const rawRR=buildMimeWithHeaders({to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",fromEmail:rrEmail,attachments});
            const payloadRR={raw:rawRR};
            const{status:gsRR,body:gbRR}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+rrTok,"Content-Type":"application/json"}},payloadRR);
            if(gbRR?.error)throw new Error(gbRR.error.message||JSON.stringify(gbRR.error));
            if(gsRR!==200)throw new Error("Gmail HTTP "+gsRR);
            r=gbRR;
            console.log(`[send/manual] 🔄 Round-robin manual → ${rrEmail}`);
          }else{
            // Principal escolhido pelo round-robin
            r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments});
          }
        }catch(e3){
          // v76: WARMUP_CAP_REACHED não é mais lançado pelo round-robin (ver
          // getSenderToken) — envio manual sem sender específico nunca mais
          // é recusado por aquecimento, só cai pro principal em erro real.
          // 🚨 v237l (achado de auditoria — Alta, gmail-envio): mesmo risco do
          // sender extra explícito, acima — um timeout AMBÍGUO no candidato do
          // round-robin (sem resposta do Gmail) não pode virar reenvio cego
          // pelo principal (arrisca mandar a mesma candidatura 2x).
          if(e3.noResponse){
            if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
            console.warn("[send/manual] ⚠️ Timeout AMBÍGUO no round-robin — NÃO reenviando pelo principal (risco de duplicar):",e3.message);
            return json(res,502,{error:"Não deu pra confirmar se a candidatura saiu — a conexão com o Google caiu antes da resposta chegar (pode ter saído ou não). Confira em Enviadas antes de tentar de novo: reenviar agora pode duplicar o e-mail pro empregador se o primeiro já tiver saído.",ambiguousSend:true});
          }
          console.warn("[send/manual] Round-robin falhou, usando principal:",e3.message);
          actualSenderEmail=s.user_email;
          r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments});
        }
      }else{
        // v194 LOTE 12: o usuário ESCOLHEU explicitamente o e-mail principal
        // (requestedSender === conta de login) — antes este else existia pro
        // reply e este caso caía nele por acaso. Simplesmente "remover o else"
        // quebraria essa escolha legítima.
        r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments});
      }

      const _tGmailMs = Date.now() - _sendT0;
      const now=new Date();
      // ✅ v202 LOTE 20 (bug real, achado ao testar o motor de verdade): o
      // markSent vivia LÁ EMBAIXO, depois do buildJobSnapshot/addHist —
      // dentro do try de contabilidade cujo catch (v177-FIX3) devolve
      // ok:true de propósito. Uma exceção ali (ex.: o cliente manda `desc`
      // como número e `.slice` estoura) fazia o servidor dizer "enviada" sem
      // NUNCA marcar o empregador como contatado: a mesma empresa voltava na
      // busca e na fila do robô e podia receber 2 candidaturas. A regra 8
      // grava SÍNCRONO (v184) e agora é a PRIMEIRA coisa depois do 200 do
      // Gmail — a candidatura já saiu, isso não pode depender de mais nada.
      markSent(s.user_email, toEmail);
      { // v194 LOTE 12: toda candidatura conta no histórico e no limite do dia
       try{
        // Só registra no histórico candidaturas originais
        const lim=getManualLimit(p);const h=getHist(s.user_email);const sent=countManualToday(h);
        // ── v13: gerar appId estável e snapshot completo da vaga ─
        const appId  = newAppId();
        const snap   = buildJobSnapshot({...d, to: toEmail});
        const histEntry = {
          appId,
          jobId: d.jobId || ("m_" + Date.now()),
          job:   d.jobTitle || d.subject,
          company: d.company || "",
          to: toEmail,
          dateStr: todayStr(), // BRT
          date: toLocaleBRT(Date.now()),
          sentAt: now.toISOString(),
          msgId: r.id,           // mantido p/ compat
          gmailMsgId: r.id,      // id curto Gmail
          threadId: r.threadId || null,
          jobSnapshot: snap,
          attachCount: attachments.length,
          type: "manual",
          // 🐛 v172c: actualSenderEmail fica em s.user_email (username de
          // login, sem @) sempre que quem manda é o principal — mesma classe
          // de bug do motor automático. resolveSendGmail(p) resolve pro
          // Gmail real quando actualSenderEmail não é um sender EXTRA de
          // verdade (extra já vem correto de getSenderToken/usedEmail).
          senderEmail: (actualSenderEmail && actualSenderEmail !== s.user_email) ? actualSenderEmail : (resolveSendGmail(p) || s.user_email),
          sheetSource: d.sheetSource||undefined,
          // FIX: salvar caseNum para que /api/sent-ids possa filtrar a vaga da planilha
          caseNum: d.caseNum || "",
          // v74: idem ao envio automático — só admin guarda o texto literal enviado.
          ...((isAdminVip(p)||isAdminEmail(_sessAdminEmail(s))) ? { subjectSent: String(d.subject||"").slice(0,500), bodySent: String(d.message||"").slice(0,3000) } : {}),
        };
        addHist(s.user_email, histEntry);
        // v18-FIX: libera a reserva do limite AQUI — o histórico real (addHist)
        // já reflete este envio a partir de agora, então countManualToday() já
        // conta com ele; manter a reserva depois disso contaria em dobro.
        if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
        // (o markSent subiu pra logo depois do 200 do Gmail — v202 LOTE 20)
        const newSent=sent+1;const newLim=getManualLimit(p);
        _manualSendInFlight.delete(dedupKey);
        invalidateUserStatsCache(s.user_email);
        const _tTotalMs = Date.now() - _sendT0;
        if (_tTotalMs > 5000) console.warn(`[send-timing] ⚠️ LENTO: ${s.user_email} → ${toEmail} | gmail=${_tGmailMs}ms | resto=${_tTotalMs-_tGmailMs}ms | total=${_tTotalMs}ms`);
        return json(res,200,{ok:true,messageId:r.id,appId,threadId:r.threadId||null,todaySent:newSent,dailyLimit:newLim,remaining:Math.max(0,newLim-newSent),countedAsManual:true,caseNum:d.caseNum||"",sheetSource:d.sheetSource||""});
       }catch(eBook){
        // 🚨 v177-FIX2 (auditoria 14/09/2026): o e-mail JÁ FOI ENVIADO pelo
        // Gmail (r existe, veio de gmailSendWithThread lá em cima) ANTES
        // deste try — uma exceção aqui dentro (markSent/cálculo de
        // limite) é só contabilidade LOCAL, nunca "falha no envio". Antes,
        // qualquer erro aqui caía no catch de fora, que roda
        // translateGmailErrorMsg e devolve 500 com cara de Gmail quebrado —
        // o usuário via "falha" pra uma candidatura que já saiu de verdade
        // e (se addHist já rodou) já está bloqueada contra reenvio.
        console.error("[send] pós-envio falhou (candidatura JÁ SAIU pelo Gmail, mensagem só não terminou de indexar):", eBook.message);
        _manualSendInFlight.delete(dedupKey);
        if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
        return json(res,200,{ok:true,messageId:r.id,threadId:r.threadId||null,countedAsManual:true,warning:"Candidatura enviada, mas houve um problema ao atualizar o histórico — pode não aparecer na hora em Enviadas."});
       }
      }
    }catch(e){
      _manualSendInFlight.delete(dedupKey);
      if(_reservedManualSlot){_releaseManualSlot(s.user_email);_reservedManualSlot=false;}
      console.error("[send]",e.message);
      // v18-FIX: antes devolvia e.message CRU pro usuário — texto técnico do
      // Google tipo "User-rate limit exceeded. Retry after 2026-07-15T12:31:47Z"
      // que ninguém leigo entende e parece bug do H2BApply (não é — é o Google
      // limitando a conta Gmail da pessoa). Agora traduz pra uma explicação
      // clara em português antes de responder; o texto técnico original ainda
      // vai pro console (linha acima) e no campo errorRaw, pra investigar se
      // precisar, mas quem aparece pro usuário é a versão amigável.
      const {type:_errType,friendly:_errFriendly}=translateGmailErrorMsg(e.message,_toEmailForErr);
      return json(res,500,{error:_errFriendly,errorType:_errType,errorRaw:e.message});
    }
  }




  // /api/cv/delete — Remove PDF da conta do usuário
  if(pathname==="/api/cv/delete"&&req.method==="POST"){
    const sd=getSess(req);if(!sd?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const idx=parseInt(d.idx,10);
      if(!idx)return json(res,400,{error:"idx inválido."});
      const u=getUser(sd.user_email);
      if(!u)return json(res,404,{error:"Usuário não encontrado."});
      const cvs=(u.cvs||[]).filter(c=>c.idx!==idx);
      // v21: apaga o ARQUIVO também — antes só sumia do registro e o PDF
      // ficava órfão no disco pra sempre (disco cheio já derrubou o sistema)
      deleteCv(sd.user_email,idx);
      // Remover referência de perfis que usavam esse PDF (nome-fantasma incluso)
      const profiles=(u.profiles||[]).map(p=>{
        const np={...p};
        if(np.resumeIdx===idx){delete np.resumeIdx;delete np.pdfName;np.pdfSize=0;}
        if(np.coverIdx===idx){delete np.coverIdx;delete np.coverName;np.coverSize=0;}
        return np;
      });
      setUser(sd.user_email,{cvs,profiles});
      console.log("[cv/delete]",sd.user_email,"idx:",idx);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  if(pathname==="/api/accept-terms"&&req.method==="POST"){
    try{
      const s2=getSess(req);
      const d=JSON.parse(await readBody(req));
      const ip=_clientIp(req);
      if(s2?.user_email){
        setUser(s2.user_email,{termsAccepted:{version:d.version||"2.0",ts:Date.now(),date:new Date().toISOString(),ip}});
        console.log("[terms] Aceite:",s2.user_email,d.version,ip);
      }
      return json(res,200,{ok:true});
    }catch(e){return json(res,200,{ok:true});}
  }

  if(pathname==="/api/sent-ids"&&req.method==="GET"){
    const s2=getSess(req);if(!s2?.user_email)return json(res,401,{error:"Não autenticado."});
    const hist=getHist(s2.user_email);
    const sentJan=new Set(),sentJul=new Set(),sentSeasonal=new Set();
    // FIX "volta pra estaca zero": conjunto global por case number, independente
    // de planilha — o chute por prefixo mandava H-300 (H-2A!) pro balde jul2025
    // e planilhas novas não tinham balde nenhum → enviadas reapareciam na lista.
    const sentAll=new Set();

    hist.forEach(h=>{
      const cn  = h.caseNum||"";
      const src = h.sheetSource||"";
      const id  = h.jobId||h.id||"";
      if(cn) sentAll.add(cn);

      if(src==="jan2026" || (!src && (cn.startsWith("H-4")||cn.startsWith("H-5")||cn.startsWith("H-6")))){
        if(cn) sentJan.add(cn);
      } else if(src==="jul2025" || (!src && cn.startsWith("H-3"))){
        if(cn) sentJul.add(cn);
      } else if(cn && !src){
        // caseNum sem planilha detectada — adiciona em ambas por segurança
        sentJan.add(cn); sentJul.add(cn);
      }
      // Seasonal: sempre adiciona por jobId
      if(id) sentSeasonal.add(id);
    });

    // Vagas na fila do automático também somem da planilha
    const autoJob = getAutoJob(s2.user_email);
    const autoQueue = autoJob?.active ? (autoJob.queue||[]) : [];
    const autoQueueIds = autoQueue.map(q=>q.id||q.caseNum).filter(Boolean);

    autoQueue.forEach(q => {
      if(!q.id && !q.caseNum) return;
      const id = q.id || q.caseNum;
      const cn = q.caseNum||"";
      if(cn||/^H-\d/.test(String(id)))sentAll.add(cn||id); // fila do auto some de TODA planilha
      const src = autoJob.source || "";
      if(src==="jan2026"||cn.startsWith("H-4")||cn.startsWith("H-5")) sentJan.add(id);
      else if(src==="jul2025"||cn.startsWith("H-3")) sentJul.add(id);
      else sentSeasonal.add(id);
    });

    return json(res,200,{
      all:[...sentAll],
      jan2026:[...sentJan],
      jul2025:[...sentJul],
      seasonal:[...sentSeasonal],
      autoQueueIds,
      autoQueueSize: autoQueue.length,
      autoQueueNotice: autoQueue.length > 0
        ? `⚡ ${autoQueue.length} vaga${autoQueue.length>1?"s estão":"está"} oculta${autoQueue.length>1?"s":""} da lista porque já ${autoQueue.length>1?"estão":"está"} na sua fila de envio automático.`
        : null
    });
  }



  // 🔁 v-2026: a aba "Enviadas" (browsing de histórico) foi removida, mas
  // syncData()/_searchHist (busca dentro da Pesquisa) e o selo "já enviado"
  // nos cards de vaga continuam dependendo de ler o histórico bruto — só a
  // TELA de listagem saiu, o dado nunca deveria ter saído de servir.
  if(pathname==="/api/history"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    return json(res,200,{ok:true,history:getHist(s.user_email)});
  }

  // Limpa TODO o histórico + DB_SENT do usuário (Reset geral — vagas voltam para a lista)
  if(pathname==="/api/history/clear"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const total=(DB_HIST[s.user_email]||[]).length;
      // Apaga histórico
      delete DB_HIST[s.user_email];
      persist(HIST_FILE,DB_HIST);
      // Apaga sent (anti-duplicata) — para que as vagas voltem à lista
      delete DB_SENT[s.user_email];
      persistSent();
      invalidateUserStatsCache(s.user_email);
      console.log(`[history/clear] ${s.user_email} resetou histórico completo (${total} entradas)`);
      return json(res,200,{ok:true,removed:total});
    }catch(e){return json(res,500,{error:e.message});}
  }


  if(pathname==="/api/diag"&&req.method==="GET"){
    const sd=getSess(req);if(!sd?.user_email||!isAdminEmail(_sessAdminEmail(sd)))return json(res,403,{error:"Acesso negado."});
    return json(res,200,{
      uptime_s:Math.round(process.uptime()),
      memory_mb:Math.round(process.memoryUsage().heapUsed/1024/1024),
      sessions_count:Object.keys(sessions).length,
      users_count:Object.keys(DB_USERS).length,
      app_url:APP_URL,redirect_uri:REDIRECT_URI,
      client_id_prefix:CLIENT_ID.slice(0,30)+"...",
      client_secret_len:CLIENT_SECRET.length,
      client_secret_preview:CLIENT_SECRET.slice(0,8)+"..."+CLIENT_SECRET.slice(-4),
      disk:fs.existsSync("/data"),data_dir:DATA_DIR,is_prod:IS_PROD,
      node_version:process.version
    });
  }

  if(pathname==="/api/warmup"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,ts:Date.now()}));}

  // ── v114: 🗺️ /api/lugares — estados e cidades REAIS da planilha (pra
  // os seletores sugestivos do lado da busca). Deriva dos dados: só
  // sugere lugar que TEM vaga. Regiões turísticas entram na lista de
  // cidades (a busca já sabe expandi-las — v111b/v113). Cache 5min.
  if(pathname==="/api/lugares"&&req.method==="GET"){
    try{
      const shKey=(u.searchParams.get("sheet")||"seasonal").slice(0,40);
      global._lugaresCache=global._lugaresCache||{};
      const hit=global._lugaresCache[shKey];
      if(hit&&Date.now()-hit.at<300000)return json(res,200,hit.data);
      let rows;
      if(shKey==="seasonal")rows=getAllSheets().filter(r=>r.e&&r.e.includes("@"));
      else{const sh=getSheet(shKey);rows=Array.isArray(sh)?sh:[];}
      const est={},cid={},emp={},car={};
      for(const r of rows){
        const s=String(r.s||"").toUpperCase().trim();
        const c=String(r.ci||"").trim();
        if(s&&s!=="–")est[s]=(est[s]||0)+1;
        if(c&&c!=="–")cid[c+"|"+s]=(cid[c+"|"+s]||0)+1;
        // v119: empresas e cargos alimentam as sugestões instantâneas da busca
        const n=String(r.n||"").trim();if(n&&n!=="–")emp[n]=(emp[n]||0)+1;
        const t2=String(r.t||"").trim();if(t2&&t2!=="–")car[t2]=(car[t2]||0)+1;
      }
      const data={
        ok:true,
        estados:Object.entries(est).sort((a,b)=>b[1]-a[1]).map(([n,q])=>({n,q})),
        cidades:Object.entries(cid).sort((a,b)=>b[1]-a[1]).slice(0,1500).map(([k,q])=>{const[n,e]=k.split("|");return{n,e,q};}),
        empresas:Object.entries(emp).sort((a,b)=>b[1]-a[1]).slice(0,800).map(([n,q])=>({n,q})),
        cargos:Object.entries(car).sort((a,b)=>b[1]-a[1]).slice(0,400).map(([n,q])=>({n,q})),
        regioes:["Martha's Vineyard","Cape Cod","Nantucket","Florida Keys","Outer Banks","Hamptons","Lake Tahoe","Jackson Hole","Mackinac","Smoky Mountains","Wisconsin Dells","Myrtle Beach","Hilton Head","Gulf Shores","Ocean City","Branson","Aspen","Vail","Yellowstone","Poconos","Adirondacks","Door County","Destin"],
      };
      global._lugaresCache[shKey]={at:Date.now(),data};
      return json(res,200,data);
    }catch(e){return json(res,500,{ok:false,error:e.message});}
  }




  // 📡 v134 — RADAR DE VAGAS: GET vê, POST {estados,cidade,q,categoria}
  // salva (1 por usuário), POST {remove:true} desliga.
  if(pathname==="/api/radar"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const u2=getUser(s.user_email)||{};
    if(req.method==="GET")return json(res,200,{ok:true,radar:u2.radar||null});
    if(req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      if(d.remove===true){setUser(s.user_email,{radar:null});return json(res,200,{ok:true,removed:true});}
      // 📡 v182 LOTE 9: o radar guardava 4 das 11 dimensões (e da cidade e da
      // categoria só a PRIMEIRA) — quem montou "$20+/h + Alimentação +
      // Flórida" era avisado de qualquer vaga de Alimentação na Flórida,
      // inclusive de $12/h. Agora guarda o SNAPSHOT INTEIRO dos filtros e
      // quem avalia é o MESMO FILTROS.filtrar da lista e da fila do robô —
      // nunca uma 3ª régua.
      const filtros=_radarSanitiza(d.filtros||d);
      const f=FILTROS.parse(filtros);
      if(!FILTROS.ativos(f))return json(res,400,{error:"Escolha ao menos 1 filtro antes de criar o radar."});
      // 📡 v189 LOTE 7: filtro novo = contagem nova (o número mostrado é
      // "vagas novas que entraram combinando com ESTE radar").
      const radar={filtros,ativo:true,createdAt:u2.radar?.createdAt||Date.now(),
        ultimaEm:0,novas:0};
      setUser(s.user_email,{radar});
      return json(res,200,{ok:true,radar,dimensoes:FILTROS.ativos(f)});
    }catch(e){return json(res,500,{error:e.message});}}}

  // 🔖 v126 (dono, 12/08): vaga salva agora guarda o SNAPSHOT completo
  // (u.savedJobs) — aparece na aba Vagas Salvas mesmo meses depois, mesmo
  // que a vaga já não esteja em nenhuma planilha. u.saved (ids) continua
  // sendo a fonte do estado dos botõezinhos 🔖 nos cards.
  // ── 🎯 v139 — VAGAS PRA VOCÊ (prateleira da Home) ────────────────────────
  // Completa a regra 13m: a nota de match (computeJobMatchScore) ganhou uma
  // prateleira própria — as melhores vagas AINDA DISPONÍVEIS pro perfil do
  // usuário, com o porquê (matchWhy, nunca caixa preta). Regra 8 absoluta:
  // empregador já enviado OU na fila do automático NUNCA aparece aqui — o
  // ranking é cacheado 10min por usuário, mas esse corte roda FRESCO em
  // toda resposta. Vaga morta/encerrada também fica de fora. Sem perfil,
  // a nota é neutra (50) e a prateleira ainda mostra vagas — nunca bloqueia.
  if(pathname==="/api/jobs/pra-voce"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const em=s.user_email;
      let cand=_praVoceCache.get(em);
      if(!cand||Date.now()-cand.t>10*60_000){
        const ctx=buildMatchCtx(getUser(em));
        const hoje=new Date().toISOString().slice(0,10);
        const _DEAD=/denied|withdrawn|invalidat|expired|cancel/i;
        const top=[];
        for(const r of getAllSheets()){
          const e2=_normEmail(r.e);
          if(!e2||!e2.includes("@"))continue;
          if(_DEAD.test(String(r.st||"")))continue;
          if(r.de&&/^\d{4}-\d{2}-\d{2}$/.test(r.de)&&r.de<hoje)continue;
          const m=ctx?computeJobMatchScore(_matchSignalFromRow(r),ctx):null;
          top.push({row:r,score:m?m.score:50,why:m?(m.why||null):null});
        }
        top.sort((a,b)=>b.score-a.score);
        cand={t:Date.now(),top:top.slice(0,80)};
        if(_praVoceCache.size>2000)_praVoceCache.clear();
        _praVoceCache.set(em,cand);
      }
      const sentSet=buildUserSentSet(em);
      const _verEmailPV=podeVerEmailVaga(req); // 🔒 v182 LOTE 10
      const aj=getAutoJob(em);
      const qEmails=new Set();
      if(aj&&Array.isArray(aj.queue))for(const it of aj.queue){const qe=_normEmail(it.email||it.to);if(qe)qEmails.add(qe);}
      const out=[];const seen=new Set();
      for(const c of cand.top){
        const e2=_normEmail(c.row.e);
        if(!e2||seen.has(e2)||sentSet.has(e2)||qEmails.has(e2))continue;
        seen.add(e2);
        out.push({..._vagaSnapshot(c.row,_verEmailPV),sheet:c.row._sheet||"",matchScore:c.score,matchWhy:c.why});
        if(out.length>=8)break;
      }
      return json(res,200,{ok:true,jobs:out});
    }catch(e){return json(res,500,{ok:false,error:e.message});}
  }
  // 🚨 v237t (achado de auditoria — Baixa, auth): faltava a trava
  // req.method==="POST" — o cookie é SameSite=Lax (sempre vai numa
  // navegação de topo, mesmo vinda de outro site), então uma página
  // maliciosa com só um <a href="…/api/disconnect"> ou um window.location
  // deslogava qualquer usuário logado em silêncio. Os 2 chamadores do
  // front (doLogout em app.js, fazerLogout em admin.html) já foram
  // ajustados pra mandar method:"POST" explicitamente.
  if(pathname==="/api/disconnect"&&req.method==="POST"){const id=getSessId(req);if(id&&sessions[id]){delete sessions[id];persistSessionsDebounced(500);}res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":clearCookieStr()});return res.end('{"ok":true}');}

  // ── POST /api/account/delete — usuário deleta a própria conta ──────────
  // Soft-delete: NADA é apagado (histórico, financeiro, pedidos — tudo fica).
  // Só marca accountDeleted:true. Efeito imediato: some do ranking e de
  // qualquer lista pública, o automático para, a sessão é destruída (logout).
  // Relogar com o MESMO e-mail restaura tudo automaticamente (ver OAuth callback).
  if(pathname==="/api/account/delete"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req)||"{}");
      if(d.confirm!==true)return json(res,400,{error:"Confirmação obrigatória."});
      const email=s.user_email;
      // Revoga o próprio grant no Google (best-effort, não bloqueia a exclusão).
      // Diferente do caso do v165 (remover EXTRA que também é login de alguém),
      // aqui é a PRÓPRIA pessoa pedindo pra sair — revogar é exatamente o
      // esperado, não um efeito colateral acidental. Limpa o token local
      // também, pra nenhum código futuro poder reusar credencial de conta
      // deletada por engano.
      const u=getUser(email);
      const _tok=u?.refresh_token||u?.cached_access_token;
      if(_tok){
        httpsReq({hostname:"oauth2.googleapis.com",path:"/revoke?token="+encodeURIComponent(_tok),method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"}})
          .then(r=>console.log(`[account] 🔒 token de ${email} revogado no Google (status ${r.status})`))
          .catch(e=>console.warn(`[account] revoke falhou (${email}):`,e.message));
      }
      setUser(email,{accountDeleted:true,deletedAt:Date.now(),refresh_token:null,cached_access_token:null});
      // Para o automático imediatamente, se estiver rodando.
      const job=getAutoJob(email);
      if(job){
        setAutoJob(email,{...job,active:false,status:"paused_account_deleted",finishedAt:Date.now()});
      }
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      addLog(email,{status:"sistema",jobTitle:"🗑️ Conta deletada pelo usuário",company:"Some do ranking e de listas públicas. Dados ficam guardados. Relogar restaura tudo."});
      try{ trackJourney(email,'account_deleted',{detail:'Usuário deletou a própria conta'}); }catch{}
      console.log("[account] 🗑️ Conta deletada pelo usuário:",email);
      // Destrói a sessão (mesmo padrão do /api/disconnect) — logout imediato.
      const sid=getSessId(req);if(sid&&sessions[sid]){delete sessions[sid];persistSessionsDebounced(500);}
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":clearCookieStr()});
      return res.end('{"ok":true}');
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── GET /api/account/export — portabilidade de dados (LGPD art. 18, V) ──
  // Auditoria de 10/09/2026: a Política de Privacidade já listava esse
  // direito, mas só existia por pedido manual ao suporte. Autoatendimento:
  // o próprio usuário baixa TUDO que escreveu, na hora, sem depender de
  // ninguém. Só os dados DELE (nunca de outro usuário) e NUNCA nada
  // sensível de acesso (token OAuth, hash de comprovante de terceiro) —
  // é portabilidade de dados pessoais, não um dump de segurança.
  if(pathname==="/api/account/export"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(rateLimit(s.user_email+"_export",10,3600_000))return json(res,429,{error:"Muitos pedidos de exportação. Tente de novo em 1 hora."});
    try{
      const email=s.user_email;
      const p=getUser(email)||{};
      const h=getHist(email);
      const meusPedidos=(DB_PEDIDOS||[]).filter(pd=>pd&&pd.userEmail===email).map(pd=>({
        id:pd.id,criadoEm:pd.createdAt,status:pd.status,plano:pd.plano,dias:pd.dias,
        valorTotal:pd.valorTotal,ativadoEm:pd.ativadoEm||null,pagoEm:pd.pagoEm||null,
        canceladoEm:pd.canceladoEm||null,temComprovante:temComprovante(pd)}));
      const exportado={
        geradoEm:new Date().toISOString(),
        aviso:"Seus dados pessoais no H2BApply, conforme a LGPD (Lei 13.709/2018, art. 18). Nunca inclui a senha em texto puro (só o hash, e nem esse é exportado) nem token de acesso.",
        conta:{email,nome:p.name||"",telefone:p.phone||"",whatsapp:p.whatsapp||"",cidade:p.city||"",
          pais:p.country||"",idade:p.age||null,idioma:p.language||"",criadaEm:p.created_at||null,
          plano:getPlan(p),vip:p.vip?{ativo:isVipActive(p),manualExpira:p.vip.manualExpires||null,autoExpira:p.vip.autoExpires||null}:null},
        h2bProfile:p.h2bProfile||{},
        perfisDeVaga:(p.profiles||[]).map(pr=>({nome:pr.name,estado:pr.state||null,categorias:pr.categories||[],
          assuntos:pr.subjects||[],corpos:pr.emailBodies||[]})),
        curriculos:(p.cvs||[]).map(c=>({nome:c.name,tamanho:c.size,data:c.date,tipo:c.cvType||"resume"})),
        contasGmailExtras:(p.senderEmails||[]).map(sm=>({email:sm.email,rotulo:sm.label||""})),
        historicoDeCandidaturas:h.map(x=>({empresa:x.company||"",vaga:x.job||"",para:x.to||"",data:x.date||"",
          tipo:x.type||"",categoria:x.category||"",estado:x.state||""})),
        totalCandidaturasEnviadas:h.length,
        meusPedidos,
      };
      const fname=`h2bapply-meus-dados-${new Date().toISOString().slice(0,10)}.json`;
      res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="${fname}"`});
      return res.end(JSON.stringify(exportado,null,2));
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── v27-TEST: LOGIN DE TESTE (para o npm test cobrir fluxos autenticados) ──
  // SÓ EXISTE quando a env TEST_LOGIN_TOKEN (mín. 20 chars) está definida —
  // em produção a variável não existe e a rota responde 404 como qualquer
  // caminho inválido. O smoke test gera um token aleatório por execução.
  // Nunca defina TEST_LOGIN_TOKEN num servidor de verdade.
  if(pathname==="/api/test/login"&&req.method==="POST"){
    const _tt=String(process.env.TEST_LOGIN_TOKEN||"");
    if(!_tt||_tt.length<20)return json(res,404,{error:"404"});
    try{
      const d=JSON.parse(await readBody(req));
      if(String(d.token||"")!==_tt)return json(res,403,{error:"token inválido"});
      const email=String(d.email||"").toLowerCase().trim();
      if(!email.includes("@"))return json(res,400,{error:"email inválido"});
      if(!getUser(email))setUser(email,{email,name:String(d.name||"Test User"),created_at:new Date().toISOString(),plan:"free",cvs:[],profiles:[],saved:[],onboarded:true,isAdmin:d.isAdmin===true});
      else if(d.isAdmin===true)setUser(email,{isAdmin:true});
      // 🔐 v165 (só teste): semeia e-mails extras pra provar a guarda do
      // revoke na remoção de sender (conta de login nunca sofre revoke).
      if(Array.isArray(d.senderEmails))setUser(email,{senderEmails:d.senderEmails});
      // 🧪 v179 (só teste): semeia empregadores JÁ CONTATADOS (regra 8) —
      // é o que o corte hideSent usa, e sem isso não dá pra provar que a
      // lista e o painel descontam o MESMO tanto.
      if(Array.isArray(d.sentTo))for(const _t of d.sentTo)markSent(email,String(_t||""));
      // 🔒 v172 (só teste): desde que login parou de conceder gmail.send
      // sozinho, testes que precisam simular "plano pago + Gmail conectado"
      // (pra chegar na parte que realmente querem testar, não no gate novo)
      // semeiam isso explicitamente aqui — nunca em produção (TEST_LOGIN_TOKEN
      // só existe no ambiente de teste, checado no topo desta rota).
      if(d.refreshToken)setUser(email,{refresh_token:String(d.refreshToken),cached_access_token:"test-token",cached_token_expiry:Date.now()+3600_000});
      // 🌱 v195 LOTE 13 (só teste): o relógio do aquecimento do Gmail PRINCIPAL
      // passou a ser a data da CONEXÃO (gmailConnectedAt), não a do cadastro —
      // provar isso exige uma conta ANTIGA que conectou o Gmail hoje, estado
      // que nenhuma rota normal monta.
      if(d.createdAt)setUser(email,{created_at:String(d.createdAt)});
      if(d.gmailConnectedAt)setUser(email,{gmailConnectedAt:Number(d.gmailConnectedAt)});
      if(d.vip)setUser(email,{vip:d.vip,plan:d.plan||getUser(email)?.plan});
      const sid="test_"+crypto.randomBytes(16).toString("hex");
      sessions[sid]={user_email:email,user_name:String(d.name||"Test"),created_at:Date.now(),access_token:"test-token",expires_at:Date.now()+3600_000};
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":makeCookieStr(sid)});
      return res.end(JSON.stringify({ok:true,email}));
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── v27: EMPREGADORES BLOQUEADOS do usuário (enviados + fila do robô) ────
  // Alimenta o front pra TODA superfície (pesquisa, seasonal, salvas) saber
  // na hora se uma vaga é "nova de verdade" ou do mesmo empregador já
  // contatado — regra do dono: o usuário nunca deve se preocupar com duplicado.
  if(pathname==="/api/sent-emails"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const sentSet=buildUserSentSet(s.user_email);
    const j=getAutoJob(s.user_email);
    const queued=[...new Set((j?.queue||[]).map(it=>_normEmail(it.to||"")).filter(Boolean))];
    return json(res,200,{ok:true,sent:[...sentSet],queued});
  }

  // v198 LOTE 16: as 3 rotas /api/templates* foram REMOVIDAS junto com o
  // subsistema de "Modelos de e-mail" do front (morto desde o v22 — "nada de
  // texto padrão"): guardavam até 50 modelos por usuário dentro do DB_USERS,
  // sem nenhuma tela que os criasse, lesse ou apagasse.

  // ── PROFILES ──────────────────────────────────────────
  if(pathname==="/api/profiles"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const p=getUser(s.user_email)||{};return json(res,200,{profiles:p.profiles||[]});}
  if(pathname==="/api/profiles/save"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // v167: mesmo aviso do /api/cv/upload acima — perfil "salvo" em disco
    // volátil (/tmp) some no próximo restart, sem erro nenhum na hora.
    if(DATA_DIR==="/tmp")return json(res,503,{error:"⚠️ Servidor sem volume persistente (/tmp). O perfil seria salvo agora, mas some no próximo reinício. Configure DATA_DIR=/data com volume persistente antes de continuar.",diskVolatile:true});
    try{const d=JSON.parse(await readBody(req));if(!d.name)return json(res,400,{error:"name obrigatório"});const p=getUser(s.user_email)||{};let prfs=p.profiles||[];
    // Validate and normalize subjects (up to 10, no duplicates, no empty)
    // Auditoria 10/09/2026: MAX_BODY_SIZE aceita corpo de até 50MB (pensado
    // pra PDF em base64 em outras rotas) — sem corte de TAMANHO por item
    // aqui, um perfil podia gravar assuntos/corpos de megabytes cada,
    // inflando DB_USERS pra sempre (o próprio setUser serializa o banco
    // INTEIRO a cada save — é a mesma classe de lentidão do v43-FIX,
    // só que essa porta de entrada não tinha trava nenhuma). Mesmo
    // padrão de corte já usado em /api/templates/save.
    const rawSubjs=Array.isArray(d.subjects)?d.subjects:[];
    const subjects=[...new Set(rawSubjs.map(s=>String(s).trim().slice(0,300)).filter(Boolean))].slice(0,10);
    // Validate and normalize email bodies (no empty, com corte de tamanho E de quantidade)
    const rawBodies=Array.isArray(d.emailBodies)?d.emailBodies:[];
    const emailBodies=rawBodies.map(b=>String(b).trim().slice(0,5000)).filter(Boolean).slice(0,10);
    // ── PERFIL ÚNICO (2026-07, pedido do dono): mínimo 3 assuntos e 3 corpos
    // diferentes, escritos pelo próprio usuário — sem isso a candidatura sai
    // com texto padrão igual à de milhares de outros usuários. Antes só o
    // editor completo (frontend) validava isso; agora vale pra qualquer
    // chamador da API (onboarding incluso), sem brecha.
    if(subjects.length<3)return json(res,400,{error:"Mínimo 3 assuntos diferentes de email."});
    if(emailBodies.length<3)return json(res,400,{error:"Mínimo 3 corpos de email diferentes."});
    // Normalize categories (only known keys)
    const KNOWN_CATS=["landscape","construction","housekeeper","seafood","farm","golf","amusement","forest","lifeguard","other"];
    const categories=Array.isArray(d.categories)?d.categories.filter(c=>KNOWN_CATS.includes(c)):[];
    // Normalize sheets — KNOWN_SHEETS era uma lista estática (só jan2026/
    // jul2025/dol), então QUALQUER planilha nova (h2a, jan2025, jul2026...)
    // era descartada em silêncio aqui se o usuário tentasse selecioná-la
    // num perfil de envio automático. Agora é dinâmico: sempre inclui as
    // fixas + todas as chaves publicadas em SHEET_EXTRAS no momento do save.
    const KNOWN_SHEETS=["jan2026","jul2025","h2a-jun2026","dol",...Object.keys(SHEET_EXTRAS)];
    const sheets=Array.isArray(d.sheets)?d.sheets.filter(s=>KNOWN_SHEETS.includes(s)):[];
    // ── v19 (dono, 15/07/2026): 1 PERFIL POR TIPO DE VISTO — até 2 perfis por
    // usuário (1 H-2B + 1 H-2A). Cliente real tinha perfis separados por visto
    // e a consolidação pra perfil único misturou os textos: vaga H-2A passou a
    // receber corpo de H-2B. Agora: salvar com visaType X sempre EDITA o perfil
    // X existente (nunca cria um segundo do mesmo tipo) e NUNCA toca no perfil
    // do outro tipo. Criar o segundo tipo é opcional — o usuário escolhe.
    const visaType=(String(d.visaType||"").toLowerCase()==="h2a")?"h2a":"h2b";
    const existing=prfs.find(pr=>(pr.visaType||"h2b")===visaType)||null;
    // v20 (reclamação real, 07/2026): três consertos neste objeto —
    // (a) active/allowManual/allowAuto eram FORÇADOS true no servidor, então
    //     desativar um perfil nunca funcionou de verdade; agora respeitam o
    //     que veio do front.
    // (b) resumeIdx/coverIdx: campo AUSENTE no payload (ex.: onboarding, que
    //     não mexe em PDF) herda o valor do perfil existente — antes recriar o
    //     perfil pelo onboarding APAGAVA o vínculo do currículo. null explícito
    //     continua significando "Nenhum" (escolha do usuário no editor).
    const prf={id:existing?existing.id:(d.id||crypto.randomUUID()),name:String(d.name).slice(0,80),desc:String(d.desc||"").slice(0,200),active:d.active!==false,type:"normal",visaType,icon:String(d.icon||(visaType==="h2a"?"🌾":"🎯")).slice(0,8),isFavorite:visaType==="h2b",allowManual:d.allowManual!==false,allowAuto:d.allowAuto!==false,coverName:d.coverName?String(d.coverName).slice(0,200):undefined,coverSize:d.coverSize||0,isGeneral:true,subjects,emailBodies,subject:subjects[0]||String(d.subject||"").slice(0,200),body:emailBodies[0]||String(d.body||"").slice(0,5000),categories:[],sheets,resumeIdx:(d.resumeIdx!==undefined)?d.resumeIdx:(existing?(existing.resumeIdx??null):null),pdfName:d.pdfName?String(d.pdfName).slice(0,200):undefined,pdfSize:d.pdfSize||0,coverIdx:(d.coverIdx!==undefined)?d.coverIdx:(existing?(existing.coverIdx??null):null),state:String(d.state||"").slice(0,40),updatedAt:new Date().toISOString(),createdAt:existing?existing.createdAt:(d.createdAt||new Date().toISOString())};
    // v20 (reclamação real, 07/2026): perfil só pode apontar pra PDF que existe
    // de verdade na conta — e o nome exibido vem SEMPRE do arquivo real. Antes
    // um idx órfão (sobra de migração/exclusão) e nomes-fantasma (pdfName/
    // coverName sem arquivo) faziam o editor mostrar anexo que nunca era
    // enviado — e o envio caía num PDF de fallback que o usuário não escolheu.
    const _cvsAll=p.cvs||[];
    const _cvMetaOf=idx=>idx==null?null:_cvsAll.find(c=>parseInt(c.idx,10)===parseInt(idx,10))||null;
    const _resMeta=_cvMetaOf(prf.resumeIdx);
    if(_resMeta){prf.pdfName=_resMeta.name;prf.pdfSize=_resMeta.size||0;}
    else{prf.resumeIdx=null;delete prf.pdfName;prf.pdfSize=0;}
    const _covMeta=_cvMetaOf(prf.coverIdx);
    if(_covMeta){prf.coverName=_covMeta.name;prf.coverSize=_covMeta.size||0;}
    else{prf.coverIdx=null;delete prf.coverName;prf.coverSize=0;}
    // ── ORDEM DO DONO: pelo menos UM dos dois (currículo OU carta) tem que
    // estar anexado — nunca os dois vazios. Validação AUTORITATIVA aqui no
    // servidor (vale pro onboarding E pro editor completo, que hoje só
    // valida currículo no front) — checa os valores JÁ resolvidos acima
    // (depois da herança do perfil existente e do "null explícito zera").
    if(prf.resumeIdx==null&&prf.coverIdx==null)
      return json(res,400,{error:"Anexe pelo menos um currículo ou uma carta de apresentação a este perfil."});
    prfs=[...prfs.filter(pr=>(pr.visaType||"h2b")!==visaType),prf]; // preserva o perfil do OUTRO tipo
    setUser(s.user_email,{profiles:prfs});return json(res,200,{ok:true,profile:prf});}catch(e){return json(res,500,{error:e.message});}}
  // v21: liga/desliga perfil SEM passar pela validação de conteúdo do save.
  // Antes o front reenviava o perfil inteiro pro /api/profiles/save só pra
  // mudar active — e perfil legado com <3 assuntos nem DESATIVAR conseguia
  // (barrava no "Mínimo 3 assuntos"). Toggle não muda texto: não valida texto.
  if(pathname==="/api/profiles/toggle"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{
    const d=JSON.parse(await readBody(req));if(!d.id)return json(res,400,{error:"id obrigatório"});
    const p=getUser(s.user_email)||{};let found=null;
    const prfs=(p.profiles||[]).map(pr=>{if(pr.id!==d.id)return pr;found={...pr,active:(typeof d.active==="boolean")?d.active:!(pr.active!==false),updatedAt:new Date().toISOString()};return found;});
    if(!found)return json(res,404,{error:"Perfil não encontrado."});
    setUser(s.user_email,{profiles:prfs});return json(res,200,{ok:true,profile:found});
  }catch(e){return json(res,500,{error:e.message});}}
  if(pathname==="/api/profiles/delete"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));if(!d.id)return json(res,400,{error:"id obrigatório"});const p=getUser(s.user_email)||{};
    // v19: com perfis por tipo de visto (1 H-2B + 1 H-2A), pode apagar um dos
    // dois — mas nunca o ÚLTIMO (ficaria sem assunto/corpo e o envio cairia
    // no fallback genérico). Editar continua sempre liberado.
    const cur=p.profiles||[];
    if(cur.length<=1&&cur.some(pr=>pr.id===d.id))return json(res,400,{error:"Você precisa de pelo menos 1 perfil configurado. Edite-o em vez de apagar."});
    setUser(s.user_email,{profiles:cur.filter(pr=>pr.id!==d.id)});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

  if(pathname==="/api/debug/export"){const s=getSess(req);if(!s?.user_email||!isAdminVip(getUser(s.user_email)))return json(res,403,{error:"Acesso negado."});
    // v21-SEC: antes exportava DB_USERS CRU — refresh_tokens do Google de TODOS
    // os usuários (principal + senders extras) iam pro navegador do admin.
    const _safeUsers={};for(const[em,uu]of Object.entries(DB_USERS))_safeUsers[em]=sanitizeUserForClient(uu);
    return json(res,200,{ts:new Date().toISOString(),users:_safeUsers,totalUsers:Object.keys(DB_USERS).length,dataDir:DATA_DIR,disk:fs.existsSync("/data")});}

  // ── ENVIO AUTOMÁTICO ──────────────────────────────────
  if(pathname==="/api/auto/start"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // Proteção contra múltiplos cliques: bloqueia se já existe job ativo
    if(DATA_DIR==="/tmp"){
      return json(res,503,{error:"⚠️ Servidor sem volume persistente (/tmp). Configure DATA_DIR=/data com volume Docker/Railway antes de usar o automático.",diskVolatile:true});
    }
    // 🚨 v177-FIX5: reserva contra 2 inícios concorrentes (ver _autoStartInFlight).
    {
      const _asTs=_autoStartInFlight.get(s.user_email);
      if(_asTs&&Date.now()-_asTs<60_000)
        return json(res,409,{error:"Já estamos montando sua fila — aguarde alguns segundos antes de clicar de novo.",alreadyStarting:true});
    }
    const existingJob=getAutoJob(s.user_email);
    // v124 (BUG REAL, vídeo do dono 10/08: cliente PAGANTE montou a fila nova,
    // clicou iniciar e recebeu "robô estava travado — reiniciei. 0 vaga(s) na
    // fila" pra sempre, sem enviar nada): um job ZUMBI (active:true com fila
    // VAZIA — sobra de crash/deploy no instante exato em que a fila zerou, ou
    // pausa com fila já vazia) caía no ramo de auto-heal abaixo, que
    // ressuscitava o job VELHO e JOGAVA FORA a fila nova que o cliente acabou
    // de configurar. Zumbi de fila vazia não se ressuscita: finaliza e segue
    // com o início NOVO que o cliente pediu.
    if(existingJob&&existingJob.active&&!(existingJob.queue?.length)){
      try{if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}}catch{}
      setAutoJob(s.user_email,{...existingJob,active:false,queue:[],status:"finished",finishedAt:existingJob.finishedAt||Date.now()});
      console.warn(`[auto/start] 🧟 ${s.user_email}: job ativo com fila VAZIA (zumbi) — finalizado; seguindo com o início novo do cliente.`);
      addLog(s.user_email,{status:"sistema",jobTitle:"🔧 Robô antigo (fila zerada) finalizado — começando sua fila nova",company:"auto-heal"});
    }else if(existingJob&&existingJob.active){
      // v19-FIX: "active:true" no disco não significa que o robô está de fato
      // rodando — o timer (autoTimers, em memória) morre em todo restart do
      // processo (deploy/spin-down/disco efêmero); reactivateAutoJobs() cobre
      // isso 6s após o boot, mas esta é uma segunda camada de defesa: se por
      // QUALQUER motivo (ex.: usuário clicou bem nesses 6s, ou uma exceção
      // engoliu o reagendamento em algum ponto) não existe timer vivo pra esse
      // usuário, religar aqui em vez de travar o usuário pra sempre atrás de um
      // "já está em andamento" que é mentira. Usa reactivateOneAutoJob() (não
      // scheduleAuto() direto) pra respeitar um cooldown de rate-limit/limite
      // diário já salvo em vez de disparar um envio na hora ignorando ele.
      if(!autoTimers.has(s.user_email)){
        console.warn(`[auto/start] ⚠️ ${s.user_email} tinha job active:true sem timer vivo (robô parado de verdade) — reagendando em vez de bloquear.`);
        reactivateOneAutoJob(s.user_email, existingJob);
        addLog(s.user_email,{status:"sistema",jobTitle:"🔧 Timer morto detectado e reagendado no início",company:"auto-heal"});
        // Mesmo formato de resposta do início normal (ok+queueSize+skippedAlreadySent)
        // pra não quebrar o front-end, que espera esses campos numéricos — só que
        // aqui a fila é a que já existia (não uma nova), e sinalizamos healed:true
        // pra quem quiser mostrar uma mensagem diferente de "iniciado" pro usuário.
        const _healedJob=getAutoJob(s.user_email);
        return json(res,200,{ok:true,healed:true,queueSize:_healedJob?.queue?.length||0,skippedAlreadySent:0,message:"O robô estava travado (parado sem avisar) e foi reiniciado agora."});
      }
      return json(res,409,{error:"Envio automático já está em andamento. Pause ou pare antes de iniciar novamente.",alreadyRunning:true,queueSize:existingJob.queue?.length||0});
    }
    const p=getUser(s.user_email)||{};const h=getHist(s.user_email);const todayAuto=countAutoToday(h);const autoLimit=getAutoLimit(p);
    // 🔒 v172 (ORDEM DO DONO, 11/09/2026): autoLimit=0 é o caso NOVO (plano
    // free não manda mais nada) — merece mensagem própria, "atingiu 0/dia"
    // confundiria quem nunca teve chance de mandar nenhum.
    if(!isAdminVip(p)&&autoLimit<=0)return json(res,402,{error:planGateMsg(p,"Você precisa de um plano com envio automático (Turbo ou Máximo) pra usar o robô.","auto"),needsPlan:true});
    // 🎯 ordem do dono, 12/09/2026: o teto do admin (450/dia por e-mail
    // conectado, somado em getAutoLimit) agora é REAL e vale pra ele
    // também — só a trava de PLANO (linha acima) continua isentando admin.
    if(todayAuto>=autoLimit)return json(res,429,{error:`Limite de ${autoLimit} automáticos/dia atingido.`,limitReached:true});
    // 🔒 v172: mesma régua do /api/send — admin pula PLANO, nunca Gmail conectado.
    if(!p.refresh_token)return json(res,403,{error:"Conecte seu Gmail antes de ligar o envio automático.",needsGmailConnect:true});
    _autoStartInFlight.set(s.user_email,Date.now());
    try{
      const d=JSON.parse(await readBody(req));
      // ── Validação: perfil válido ──────────────────────────
      const profiles=(p.profiles||[]).filter(pr=>pr.active!==false);
      // ── REESTRUTURADO: perfil escolhido explicitamente no wizard ─────────
      // Se o usuário escolheu um perfil, o currículo/cover DELE mandam no job.
      let jobProfileId=null;
      if(d.profileId){
        const chosen=profiles.find(pr=>pr.id===d.profileId);
        if(chosen){
          jobProfileId=chosen.id;
          if(chosen.resumeIdx!=null)d.resumeIdx=chosen.resumeIdx;
          // v20: cover do perfil manda SEMPRE — null aqui é "Nenhuma" (escolha
          // explícita), então zera qualquer coverIdx que o front tenha mandado.
          d.coverIdx=(chosen.coverIdx!=null)?chosen.coverIdx:null;
          console.log(`[auto/start] perfil escolhido pelo usuário: "${chosen.name}" (res=${chosen.resumeIdx} cover=${chosen.coverIdx})`);
        } else {
          console.warn(`[auto/start] profileId=${d.profileId} não encontrado/inativo — seguirá com seleção padrão`);
        }
      }
      const hasResumeIdx=d.resumeIdx!=null||(profiles.length>0&&profiles.some(pr=>pr.resumeIdx!=null));
      // Verifica se existe pelo menos um assunto configurado (em algum perfil ativo ou no bodyTemplate)
      const hasSubject=profiles.some(pr=>(pr.subjects&&pr.subjects.length>0)||pr.subject)||d.bodyTemplate||(Array.isArray(d.subjects)&&d.subjects.length>0);

      // ═══════════════════════════════════════════════════════
      // v15-FIX: Validação de PDF robusta e tolerante
      // ═══════════════════════════════════════════════════════
      // Aceita o envio se EXISTIR qualquer um dos cenários:
      //   1. d.resumeIdx (frontend) aponta para um CV existente no disco
      //   2. Algum perfil ativo tem resumeIdx apontando para CV existente
      //   3. Existe qualquer CV no disco do usuário (último recurso)
      // Helper para verificar se um CV idx é válido (existe no disco)
      const _cvExists = (idx) => {
        if (idx == null) return false;
        const ridx = parseInt(idx, 10);
        if (!Number.isFinite(ridx)) return false;
        try { return fs.existsSync(cvPath(s.user_email, ridx)); } catch { return false; }
      };

      // Coleta TODOS os PDFs disponíveis (perfis + p.cvs)
      const availablePdfs = [];

      // 1) PDFs vinculados a perfis ativos
      for (const pr of profiles) {
        if (pr.resumeIdx != null && _cvExists(pr.resumeIdx)) {
          availablePdfs.push({ source: `perfil "${pr.name}"`, idx: parseInt(pr.resumeIdx, 10) });
        }
      }

      // 2) PDFs em p.cvs (Documentos)
      for (const cv of (p.cvs || [])) {
        if (_cvExists(cv.idx)) {
          // Evita duplicatas
          if (!availablePdfs.some(a => a.idx === parseInt(cv.idx, 10))) {
            availablePdfs.push({ source: `Documentos: ${cv.name || cv.idx}`, idx: parseInt(cv.idx, 10) });
          }
        }
      }

      // Verifica se d.resumeIdx específico é válido (se foi enviado)
      let pdfOk = true;
      let pdfErrorDetail = "";
      if (d.resumeIdx != null) {
        if (!_cvExists(d.resumeIdx)) {
          // d.resumeIdx inválido — mas talvez outros PDFs estejam disponíveis
          if (availablePdfs.length > 0) {
            // Tudo bem — o processQueue vai usar fallback automaticamente
            console.log(`[auto/start] resumeIdx=${d.resumeIdx} inválido, mas há ${availablePdfs.length} PDF(s) disponível(eis) — continuando com fallback`);
          } else {
            pdfOk = false;
            pdfErrorDetail = ` (resumeIdx=${d.resumeIdx} não encontrado e nenhum outro PDF disponível)`;
          }
        }
      } else {
        // Sem d.resumeIdx — exige pelo menos 1 PDF disponível em qualquer lugar
        if (availablePdfs.length === 0) {
          pdfOk = false;
          pdfErrorDetail = " (nenhum PDF encontrado nos perfis ou em Documentos)";
        }
      }

      // Log diagnóstico — facilita debugar problemas futuros
      console.log(`[auto/start] user=${s.user_email} profiles_ativos=${profiles.length} pdfs_disponiveis=${availablePdfs.length} d.resumeIdx=${d.resumeIdx} pdfOk=${pdfOk}`);
      if (!pdfOk) {
        console.warn(`[auto/start] PDF check FALHOU para ${s.user_email}${pdfErrorDetail}`);
        console.warn(`[auto/start] perfis: ${profiles.map(pr=>`${pr.name}[res=${pr.resumeIdx}]`).join(", ") || "(nenhum)"}`);
        console.warn(`[auto/start] p.cvs: ${(p.cvs||[]).map(c=>`${c.name}#${c.idx}`).join(", ") || "(nenhum)"}`);
        return json(res,400,{
          error: "Nenhum currículo (PDF) encontrado. Faça upload de um PDF em Documentos ou vincule um currículo a um perfil antes de iniciar.",
          pdfMissing: true,
          detail: pdfErrorDetail.trim(),
          debug: {
            profilesActive: profiles.length,
            profilesWithResume: profiles.filter(pr=>pr.resumeIdx!=null).length,
            cvsRegistered: (p.cvs||[]).length,
            cvsOnDisk: (p.cvs||[]).filter(c=>_cvExists(c.idx)).length
          }
        });
      }
      let queue=[];
      // ENRAIZAMENTO (2026-07-09): vagas já enviadas agora são cortadas AQUI,
      // na montagem da fila — não mais uma a uma na hora do envio. Antes a fila
      // nascia com TODAS as vagas (inclusive 2.000+ já enviadas), o tamanho da
      // fila mentia, o % de progresso mentia, e o motor perdia ciclos pulando
      // duplicata por duplicata. O skip do motor continua existindo como 2ª
      // camada de segurança (corrida entre manual e auto), mas o grosso sai já.
      const _sentSetStart = buildUserSentSet(s.user_email);
      let skippedAlreadySent = 0;
      // MODO 1: Frontend já enviou fila com emails (fluxo antigo, agora preserva todos os campos extras)
      if(d.queue&&d.queue.length){
        // v15-SEC: normaliza emails, valida com regex robusta, remove self-sends
        queue=d.queue.map(item=>{ const _p=parseEmail(item.to||''); return _p.ok ? {...item, to: _p.email} : null; })
          .filter(item => item && isValidEmail(item.to) && item.to !== s.user_email.toLowerCase())
          .filter(item => { if(_sentSetStart.has(_normEmail(item.to))){ skippedAlreadySent++; return false; } return true; })
          .map(item=>({
          id: item.id || item.caseNum || "",
          to: item.to,
          title: item.title || "",
          company: item.company || "",
          category: item.category || "other",
          state: item.state || "",
          // v13: campos opcionais ricos para snapshot — preservados se vierem
          city:    item.city    || "",
          wage:    item.wage    || "",
          visa:    item.visa    || item.visaType || "",
          start:   item.start   || item.beginDate || "",
          end:     item.end     || item.endDate || "",
          workers: item.workers || null,
          desc:    item.desc    || item.description || "",
          caseNum: item.caseNum || item.case_number || ""
        }));
      }
      // MODO 2: Frontend enviou case numbers + caseMeta (contém email da planilha local)
      // Usa email diretamente do caseMeta (que vem do sheet-meta com campo email já preenchido)
      // Fallback: busca na planilha local pelo case number
      if(d.cases&&d.cases.length&&!queue.length){
        console.log(`[auto] Construindo fila de ${d.cases.length} vagas via caseMeta+planilha local...`);
        // Combina TODOS os sheets: jan2026 + jul2025 + planilhas extras carregadas
        const allSheetRows2 = getAllSheets();
        const sheetByCase = new Map(allSheetRows2.map(r=>[String(r.c||"").toUpperCase(), r]));
        let noEmailCount = 0;
        for(const cn of d.cases){
          const meta = d.caseMeta?.[cn] || {};
          // 🔒 v182 LOTE 10: a PLANILHA DO SERVIDOR manda — a prioridade era o
          // `caseMeta.email` vindo da TELA, e desde que o endereço só sai
          // inteiro pra plano ativo, um JSON velho no aparelho (carregado
          // enquanto o plano estava vencido) poderia colocar um e-mail
          // MASCARADO na fila do robô. A linha real é a fonte; o que veio da
          // tela é só fallback, e endereço mascarado nunca entra.
          const rowPri = sheetByCase.get(String(cn).toUpperCase());
          let emailRaw = (rowPri?.e||"").trim() || (meta.email||"").trim() || (meta.to||"").trim();
          if(emailRaw.includes("•")) emailRaw = "";
          if(!emailRaw){ noEmailCount++; continue; }
          const _p = parseEmail(emailRaw);
          if(!_p.ok || _p.email === s.user_email.toLowerCase()) continue;
          if(_sentSetStart.has(_normEmail(_p.email))){ skippedAlreadySent++; continue; } // já enviou pra esse empregador
          const row = rowPri;
          // Título real: usa o título da planilha (campo t) em vez de occupation genérico
          const realTitle = meta.title || row?.t || meta.company || cn;
          queue.push({
            id: cn, to: _p.email,
            title: realTitle,
            company: meta.company || row?.n || "",
            category: meta.category || row?.k || "other",
            state: meta.state || row?.s || "",
            city: meta.city || row?.ci || row?.d || "",   // ci = cidade, d = legado
            wage: meta.wage || (row?.w ? `$${row.w}/${row.wunit||'h'}` : ""),
            visa: meta.visa || row?.visa || "",
            start: meta.start || row?.d || "",
            end: meta.end || row?.de || "",
            workers: meta.workers || row?.wk || null,
            desc: (meta.desc||"").slice(0,500),
            caseNum: cn,
            url: cn.startsWith("H-") ? `https://seasonaljobs.dol.gov/jobs/${cn}` : "",
            sheetOrigin: row?._sheet || "local",  // rastrear de qual planilha veio
          });
        }
        console.log(`[auto] ✅ ${queue.length} vagas com email de ${d.cases.length} cases (${noEmailCount} sem email, ${skippedAlreadySent} já enviadas — cortadas da fila)`);
      }
      if(!queue.length){
        if(skippedAlreadySent>0) return json(res,400,{error:`Todas as ${skippedAlreadySent} vagas dessa seleção já foram enviadas por você antes. Escolha outra fonte, categoria ou filtro para encontrar vagas novas.`,allAlreadySent:true,skippedAlreadySent});
        // 🚨 v172l (achado real, print do dono 13/09/2026): a mensagem antiga
        // era genérica e citava JAN2026/JUL2025 mesmo quando o problema era
        // outra planilha (ex.: jul2026/H-2B, "contatos em breve" — o e-mail
        // simplesmente ainda não foi liberado pelo governo pra NENHUMA vaga
        // dela). noEmailCount já vinha sendo contado; agora a mensagem usa
        // ele pra dizer a causa real em vez de sugerir "arquivo corrompido".
        if(noEmailCount>0 && noEmailCount===d.cases.length){
          return json(res,400,{error:`Nenhuma dessas ${d.cases.length} vaga(s) tem e-mail de contato ainda — o governo (DOL) ainda não liberou os dados dessa planilha. Escolha outra fonte de vagas (Jan 2026, Jul 2025 ou H-2A) pra usar o automático agora.`,noEmail:true});
        }
        return json(res,400,{error:"Nenhuma vaga com e-mail encontrada nessa seleção. Tente outra planilha, categoria ou filtro.",noEmail:true});
      }
      // BUG-015 CORRIGIDO: proteção contra fila duplicada só bloqueia se o job anterior terminou
      // nos últimos 60s (era 5min) E não foi parado/cancelado manualmente pelo usuário.
      const queueFingerprint=crypto.createHash("md5").update(queue.map(i=>i.to).sort().join(",")).digest("hex");
      const lastJob=getAutoJob(s.user_email);
      if(lastJob&&lastJob.queueFingerprint===queueFingerprint&&lastJob.finishedAt&&Date.now()-lastJob.finishedAt<60_000&&lastJob.status==="finished"){
        return json(res,409,{error:"Esta fila idêntica já foi processada há menos de 1 minuto. Aguarde um momento.",duplicateQueue:true});
      }
      // startH/endH removidos — automático roda 24/7 sem janela de horário

      // v15-FIX: Determina job.resumeIdx com fallback automático
      // Se frontend mandou um resumeIdx válido, usa ele.
      // Senão, escolhe o primeiro PDF disponível (perfis > p.cvs).
      // Isso garante que sempre haja um anexo, mesmo se o perfil selecionado pelo processQueue não tiver CV.
      let jobResumeIdx = (d.resumeIdx != null && _cvExists(d.resumeIdx)) ? parseInt(d.resumeIdx, 10) : null;
      if (jobResumeIdx == null && availablePdfs.length > 0) {
        jobResumeIdx = availablePdfs[0].idx;
        console.log(`[auto/start] usando fallback resumeIdx=${jobResumeIdx} (${availablePdfs[0].source})`);
      }
      let jobCoverIdx = (d.coverIdx != null && _cvExists(d.coverIdx)) ? parseInt(d.coverIdx, 10) : null;
      // v20 (reclamação real, 07/2026): REMOVIDA a "caça" de cover letter em
      // qualquer perfil ativo. Ela fazia a carta de UM perfil (ex.: H-2A) virar
      // anexo de TODOS os envios, mesmo com o usuário tendo escolhido "Nenhuma"
      // no perfil da vaga. Cover letter agora só entra por escolha explícita
      // (do perfil ou do painel) — nunca por adivinhação.

      // ✅ v23 FILA ESPERTA: empregador MENOS contatado pelo app inteiro vai
      // primeiro (mais chance de resposta; menos spam coletivo nos populares).
      // Dentro de cada faixa continua embaralhado — usuários simultâneos não
      // batem nos mesmos alvos (proteção original preservada).
      // v82: dentro de cada faixa, prioriza (com jitter) as vagas com melhor
      // match pro perfil do candidato — "IA sugerindo as vagas com mais
      // chance pra cada um" (ordem do dono, 29/07/2026).
      queue = orderQueueSmart(queue,buildMatchCtx(p));
      // ── v23 AVISO DE VISTO: fila tem vagas de um tipo que o usuário não tem
      // perfil — o envio segue (regra do dono: nunca trava), mas ele fica
      // SABENDO que essas vagas sairão com o texto do outro perfil.
      let visaWarning=null;
      {
        const _vtCount={h2a:0,h2b:0};
        for(const it of queue){const vt=jobVisaType(it,d.source||"");if(vt)_vtCount[vt]++;}
        const _profVts=new Set(profiles.map(pr=>pr.visaType||"h2b"));
        for(const vt of ["h2a","h2b"]){
          if(_vtCount[vt]>0&&!_profVts.has(vt)){
            const nome=vt==="h2a"?"H-2A":"H-2B";
            visaWarning={missing:vt,count:_vtCount[vt],message:`⚠️ ${_vtCount[vt]} vaga(s) da fila são ${nome} e você ainda não tem um perfil ${nome} — elas vão sair com o texto do seu outro perfil. Crie o perfil ${nome} em Perfil → Meus Perfis pra cada vaga receber o texto certo.`};
            addLog(s.user_email,{status:"sistema",jobTitle:`⚠️ ${_vtCount[vt]} vaga(s) ${nome} sem perfil ${nome}`,company:"Crie o perfil desse tipo de visto pra essas vagas saírem com o texto certo."});
          }
        }
      }
      // ── Seleção de e-mails de envio (rodízio 1 a 1 SÓ entre os escolhidos) ──
      // Valida contra principal + extras ativos; se nada válido vier, usa todos (comportamento padrão).
      let jobSenders = null;
      if (Array.isArray(d.senders) && d.senders.length) {
        const validSet = new Set([s.user_email.toLowerCase(), ...((p.senderEmails||[]).filter(x=>x.active!==false).map(x=>String(x.email).toLowerCase()))]);
        jobSenders = d.senders.map(e=>String(e).toLowerCase().trim()).filter(e=>validSet.has(e));
        if (!jobSenders.length) jobSenders = null;
      }
      // mode removido — sempre 24/7
const job={active:true,startedAt:Date.now(),queue,originalCount:queue.length,filteredCount:queue.length,profileId:jobProfileId,resumeIdx:jobResumeIdx,coverIdx:jobCoverIdx,bodyTemplate:d.bodyTemplate||p.settings?.body||"",subjects:Array.isArray(d.subjects)&&d.subjects.length?d.subjects:null,emailBodies:Array.isArray(d.emailBodies)&&d.emailBodies.length?d.emailBodies:null,status:"starting",lastSentAt:null,finishedAt:null,source:d.source||"manual",category:d.category||"all",filters:d.filtros||d.filters||{},queueFingerprint,rotState:{lastSubjIdx:-1,lastBodyIdx:-1},senders:jobSenders,lockedAutoLimit:getAutoLimit(p)};
      setAutoJob(s.user_email,job);
      autoStats.set(s.user_email,{sent:0,failed:0,skipped:0,startedAt:Date.now()});
      addLog(s.user_email,{status:"sistema",jobTitle:`Envio automático iniciado: ${queue.length} vagas${skippedAlreadySent>0?` (${skippedAlreadySent} já enviadas foram puladas)`:""}`,company:`Fonte: ${d.source||"manual"} | Categoria: ${d.category||"all"}`,source:d.source||"manual",category:d.category||"all"});
      trackJourney(s.user_email,'auto_start',{detail:`Auto: ${queue.length} vagas | ${d.source||"manual"}`,meta:{queueSize:queue.length,skippedAlreadySent}});
      // Inicia imediatamente
      setTimeout(()=>scheduleAuto(s.user_email),100);
      return json(res,200,{ok:true,queueSize:queue.length,skippedAlreadySent,visaWarning});
    }catch(e){return json(res,500,{error:e.message});}
    finally{_autoStartInFlight.delete(s.user_email);}
  }
  if(pathname==="/api/auto/pause"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);if(!j)return json(res,404,{error:"Nenhum job."});if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}setAutoJob(s.user_email,{...j,active:false,status:"paused"});addLog(s.user_email,{status:"pausado",jobTitle:"Envio pausado pelo usuário",company:""});return json(res,200,{ok:true});}
  if(pathname==="/api/auto/resume"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);if(!j)return json(res,404,{error:"Nenhum job."});setAutoJob(s.user_email,{...j,active:true,status:"resuming"});addLog(s.user_email,{status:"sistema",jobTitle:"Envio retomado",company:""});scheduleAuto(s.user_email);return json(res,200,{ok:true});}
  if(pathname==="/api/auto/stop"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}addLog(s.user_email,{status:"cancelado",jobTitle:"Envio cancelado pelo usuário",company:""});delAutoJob(s.user_email);return json(res,200,{ok:true});}


  // ── ADMIN: Reinicia todos os workers travados de uma vez ───────────────────────
  if(pathname==="/api/admin/restart-all-stalled"&&req.method==="POST"){
    const s=getSess(req);
    if(!s?.user_email||!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Acesso negado."});
    let restarted=0, tokensFailed=0, skipped=0;
    const SAFE_WAIT_STATUSES = new Set(["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"]);
    for(const[email,job] of Object.entries(DB_AUTO)){
      if(!job.active||!job.queue?.length) continue;
      // BUG3-FIX: não reiniciar quem está em espera legítima (limite diário, rate limit, etc.)
      const hasActiveTimer = autoTimers.has(email);
      const hasNextSendFuture = job.nextSendAt && job.nextSendAt > Date.now();
      const isLegitWait = SAFE_WAIT_STATUSES.has(job.status) && (hasActiveTimer || hasNextSendFuture);
      if(isLegitWait){ skipped++; continue; }
      // Renova token antes de reiniciar
      const u=getUser(email);
      if(u?.refresh_token){
        try{ await refreshTokenForUser(email); }
        catch(e){ tokensFailed++; console.warn(`[restart-all] token falhou ${email}:`,e.message); }
      }
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      setAutoJob(email,{...job,status:"recovering",nextSendAt:null});
      addLog(email,{status:"sistema",jobTitle:"🔄 Worker reiniciado pelo admin",company:"Restart manual via painel"});
      scheduleAuto(email);
      restarted++;
    }
    console.log(`[admin/restart-all] ${restarted} workers reiniciados, ${skipped} em espera legítima ignorados, ${tokensFailed} tokens falharam`);
    return json(res,200,{ok:true,restarted,skipped,tokensFailed});
  }

  // ── HEALTH CHECK — para Render/Railway não reiniciar o container ──────────────
  if(pathname==="/health"||pathname==="/ping"){
    const activeJobs=Object.values(DB_AUTO).filter(j=>j.active&&j.queue?.length>0).length;
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({ok:true,uptime:Math.round(process.uptime()),memMB:Math.round(process.memoryUsage().rss/1024/1024),users:Object.keys(DB_USERS).length,activeJobs,ts:Date.now()}));
  }
  if(pathname==="/api/auto/status"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);const h=getHist(s.user_email);const p=getUser(s.user_email)||{};const stats=getAutoStats(s.user_email);const allLogs=DB_LOGS[s.user_email]||[];
    const logs=allLogs.slice(0,15);// últimos 15 logs para dashboard
    const logStats={sent:allLogs.filter(l=>l.status==="enviado").length,failed:allLogs.filter(l=>l.status==="falhou").length,dup:allLogs.filter(l=>l.status==="duplicado").length,skip:allLogs.filter(l=>l.status==="pulado").length};
    const todayLogs=allLogs.filter(l=>{const d=new Date(l.ts||0);return d.toDateString()===new Date().toDateString();});
    const todayStats={sent:todayLogs.filter(l=>l.status==="enviado").length,failed:todayLogs.filter(l=>l.status==="falhou").length};
    // jSH/jEH removidos — sem janela de horário
    const autoQueueIds=j&&j.active?(j.queue||[]).map(q=>q.id||q.caseNum).filter(Boolean):[];
    // v67: prévia das PRÓXIMAS vagas da fila + intervalo — o painel mostra o
    // que vem por aí e calcula o horário estimado de término (menos tela
    // vazia, mais informação, pedido do dono 26/07).
    const queuePreview=j&&j.active?(j.queue||[]).slice(0,4).map(q=>({company:q.company||"",title:q.title||"",to:q.to||"",state:q.state||""})):[];
    // 🎯 v82: categorias da fila NA ORDEM REAL de envio — confirma pro
    // próprio usuário (e pro smoke test) que a fila esperta está mesmo
    // priorizando o que combina com o perfil, não só uma promessa no ar.
    const queueCategories=j&&j.active?(j.queue||[]).slice(0,30).map(q=>q.category||"other"):[];
    // v118: usuário comum ~7min (ordem do dono). v172b: admin sem customizar
    // caiu pra 300 (5min), não mais o fallback de usuário comum (420).
    const _ivSecs=isAdminVip(p)?(p.adminSettings?.intervalSecs||300):420;
    // v67b (bug real, print do dono 26/07: card "35 enviados" × "73 hoje"):
    // autoStats é um Map EM MEMÓRIA — zera a cada restart/deploy do servidor,
    // enquanto a fila continua rodando (DB_AUTO persiste). O card do painel
    // subcontava depois de cada deploy. Fonte da verdade é o HISTÓRICO
    // persistido (o mesmo que conta o limite diário): o card agora conta os
    // envios do histórico desde o startedAt da fila atual — imune a deploy.
    if(j&&j.startedAt){
      const _sentReal=h.filter(x=>x.type==="auto"&&Date.parse(x.sentAt||0)>=j.startedAt).length;
      if(_sentReal>(stats.sent||0))stats.sent=_sentReal;
    }
    return json(res,200,{job:j?{active:j.active,status:j.status,queueSize:j.queue?.length||0,originalCount:j.originalCount,filteredCount:j.filteredCount,startedAt:j.startedAt,lastSentAt:j.lastSentAt,nextSendAt:j.nextSendAt,currentJob:j.currentJob,source:j.source,category:j.category,}:null,todayAuto:countAutoToday(h),autoLimit:getAutoLimit(p),stats,recentLogs:logs,logStats,todayStats,autoQueueIds:autoQueueIds,queuePreview,queueCategories,intervalSecs:_ivSecs});}

  // ── ADMIN ─────────────────────────────────────────────
  if(pathname.startsWith("/api/admin")){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // 🚨 v172c-SEC (auditoria, 12/09/2026): era `!p?.isAdmin` cru — ignorava
    // ADMIN_EMAILS_EXTRA (isAdminEmail). Conta legada cujo e-mail bate na
    // lista mas nunca teve isAdmin:true persistido no cadastro ficava 403
    // aqui, mesmo sendo isAdminVip()===true (fonte única) em todo o resto
    // do sistema — 2 definições de "é admin" divergindo no MAIOR portão da
    // API. Nunca reintroduzir a checagem crua; sempre isAdminVip(p).
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    if(pathname==="/api/admin/stats"&&req.method==="GET"){const tu=Object.keys(DB_USERS).length;const ts=Object.values(DB_HIST).reduce((n,a)=>n+a.length,0);const ds=todayStr();const tt=Object.values(DB_HIST).reduce((n,a)=>n+a.filter(h=>h.dateStr===ds).length,0);const vu=Object.values(DB_USERS).filter(u=>isVipActive(u)).length;const au=Object.values(DB_AUTO).filter(j=>j.active).length;return json(res,200,{totalUsers:tu,totalSent:ts,todayTotal:tt,vipUsers:vu,activeAutoJobs:au,freeUsers:tu-vu,activeSessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,dataDir:DATA_DIR,disk:fs.existsSync("/data"),sheetJan:SHEET_JAN.length,sheetJul:SHEET_JUL.length});}
    if(pathname==="/api/admin/users"&&req.method==="GET"){const list=Object.values(DB_USERS).map(u=>{const vok=isVipActive(u);const h=getHist(u.email);const autoJob=getAutoJob(u.email);return{email:u.email,name:u.name,picture:u.picture,country:u.country,phone:u.phone,created_at:u.created_at,cvCount:(u.cvs||[]).length,histCount:h.length,todaySent:countManualToday(h)+countAutoToday(h),plan:getPlan(u),isAdmin:!!u.isAdmin,vip:u.vip?{active:vok,expiresAt:u.vip.expiresAt,activatedAt:u.vip.activatedAt,days:u.vip.days||30,plan:u.vip.plan||"vip",manualExpires:u.vip.manualExpires||0,autoExpires:u.vip.autoExpires||0,source:u.vip.source||"admin",usedCode:u.vip.usedCode||null,codeNote:u.vip.codeNote||null,activatedBy:u.vip.activatedBy||null,note:u.vip.note||null}:null,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0}:null};}).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));return json(res,200,{users:list,total:list.length});}
    // ── 🎁 DIAS GRÁTIS (cortesia) — dono, 18/07/2026 ─────────────────────
    // Caso de uso: "o site ficou 2 dias com problema, quero dar 2 dias a mais
    // pro cliente". Estende a validade SEM tocar em NADA da contabilidade:
    // não cria pagamento, não muda plano, não muda source (pagante continua
    // pagante, trial continua trial). Só empurra a(s) data(s) de vencimento
    // e registra quem deu, quantos dias e por quê (vip.giftHistory).
    if(pathname==="/api/admin/vip/gift-days"&&req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      const email=String(d.email||"").trim().toLowerCase();
      if(!email)return json(res,400,{error:"email obrigatório."});
      const dias=Math.max(1,Math.min(60,parseInt(d.dias,10)||0));
      if(!(parseInt(d.dias,10)>0))return json(res,400,{error:"Informe quantos dias (1 a 60)."});
      const motivo=String(d.motivo||"").trim();
      if(motivo.length<3)return json(res,400,{error:"Informe o motivo (obrigatório — ex.: 'site fora do ar 2 dias')."});
      // 🚨 v237 (achado de auditoria — Alta, admin): esta rota mexe no MESMO
      // par vip.manualExpires/autoExpires que vip/activate, set-plan e
      // vip/set-expiry — mas era a única sem a trava de duplo-clique
      // (_adminVipActivateLock) nem logAdminAction. Duplo-clique/retry somava
      // a cortesia 2x em silêncio (mesma classe do "caso Cleiton" que já
      // motivou a trava nas rotas irmãs); sem logAdminAction, a concessão
      // nunca aparecia em /api/admin/audit e não dava pra reverter pelo ↩️.
      const _giftKey=s.user_email+"|"+email;
      if(_adminVipActivateLock.has(_giftKey))
        return json(res,409,{error:"Concessão em andamento para este usuário. Aguarde alguns segundos e confira antes de tentar de novo.",duplicate:true});
      _adminVipActivateLock.set(_giftKey,Date.now());
      setTimeout(()=>_adminVipActivateLock.delete(_giftKey),5000);
      const target=getUser(email);
      if(!target)return json(res,404,{error:"Usuário não encontrado."});
      const now=Date.now(),DAYg=86400_000;
      const _audBeforeGift=_vipSnapshot(target); // v19: snapshot pra reversão
      const v={...(target.vip||{})};
      // Estende o manual sempre; o automático só se o cliente JÁ tem automático
      // (cortesia espelha o que ele contratou — não dá recurso novo de graça).
      const baseM=(v.manualExpires&&v.manualExpires>now)?v.manualExpires:now;
      v.manualExpires=baseM+dias*DAYg;
      if((v.autoExpires||0)>0){
        const baseA=(v.autoExpires>now)?v.autoExpires:now;
        v.autoExpires=baseA+dias*DAYg;
      }
      v.active=true;
      v.giftHistory=[...(v.giftHistory||[]).slice(-19),{em:now,dias,motivo:motivo.slice(0,160),
        por:_sessAdminNome(s)}];
      setUser(email,{vip:v});
      logAdminAction(_sessAdminEmail(s),"vip_gift_days",email,_audBeforeGift,_vipSnapshot(getUser(email)),`+${dias}d cortesia — ${motivo}`);
      console.log(`[gift-days] +${dias}d para ${email} por ${s.user_email} — ${motivo.slice(0,80)}`);
      return json(res,200,{ok:true,dias,manualExpires:v.manualExpires,autoExpires:v.autoExpires||0,
        venceEm:new Date(v.manualExpires).toLocaleDateString("pt-BR")});
    }catch(e){return json(res,500,{error:e.message});}}
    if(pathname==="/api/admin/vip/activate"&&req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      if(!d.email)return json(res,400,{error:"email obrigatório."});
      // v18-FIX: guarda de idempotência — este endpoint (crédito manual de VIP
      // pelo admin) não tinha NENHUMA proteção contra duplo-clique/retry, ao
      // contrário do fluxo de aprovação de pedido (que já trava por pd.ativadoEm).
      // Um duplo-clique aqui somava os dias DUAS vezes silenciosamente. Trava
      // simples: mesmo admin + mesmo email-alvo não pode repetir em <5s.
      const _vipActKey=s.user_email+"|"+String(d.email||"").toLowerCase();
      if(_adminVipActivateLock.has(_vipActKey))
        return json(res,409,{error:"Ativação em andamento para este usuário. Aguarde alguns segundos e confira antes de tentar de novo.",duplicate:true});
      _adminVipActivateLock.set(_vipActKey,Date.now());
      setTimeout(()=>_adminVipActivateLock.delete(_vipActKey),5000);
      const target=getUser(d.email);
      if(!target)return json(res,404,{error:"Usuário não encontrado."});
      const days=Math.max(0,Math.min(365,parseInt(d.days||30,10)));
      const autoDays=Math.max(0,Math.min(365,parseInt(d.autoDays||0,10)));
      const planName=d.plan||"vip";
      const now=Date.now();

      // Lógica CORRETA de acumulação:
      // - days = dias de acesso MANUAL
      // - autoDays = dias de acesso AUTOMÁTICO
      // - Para cada tipo, soma sobre o que já existe (se ainda ativo) ou começa de hoje
      // - NUNCA soma days em auto E autoDays em auto ao mesmo tempo

      const curManual=(target.vip?.manualExpires&&target.vip.manualExpires>now)?target.vip.manualExpires:now;
      const curAuto  =(target.vip?.autoExpires&&target.vip.autoExpires>now)?target.vip.autoExpires:now;

      // manualExpires: soma days (se o plano tem manual)
      const manualExpires = days>0 ? curManual + days*86400_000 : (target.vip?.manualExpires||0);

      // autoExpires: soma APENAS autoDays (não days) — evita o bug do 60 dias
      const autoExpires   = autoDays>0 ? curAuto + autoDays*86400_000 : (target.vip?.autoExpires||0);

      const vip={...(target.vip||{}),active:true,manualExpires,autoExpires,
        // 🔐 v188 LOTE 6: quem concedeu é o e-mail REAL do sócio — a chave
        // interna da sessão do painel pode ser o username reservado (v183).
        activatedAt:now,activatedBy:_sessAdminEmail(s),
        note:d.note||"",days,autoDays,plan:planName,source:'admin',
        // 💳 v187: concessão manual carimbava o plano mas NUNCA os limites —
        // a conta caía na tabela LEGADA (o dobro do vendido) até alguém
        // aprovar um pedido por cima. Régua única (nunca corta legado ativo).
        ...limitsParaAtivacaoAdmin(target,planName)};
      const _audBefore=_vipSnapshot(target); // v19: snapshot pra reversão
      setUser(d.email,{plan:planName,vip});
      logAdminAction(_sessAdminEmail(s),"vip_activate",d.email,_audBefore,_vipSnapshot(getUser(d.email)),`+${days}d manual, +${autoDays}d auto, plano ${planName}${d.note?` — ${d.note}`:""}`);
      // 🧠 Cérebro 2.0 P1 (revisão adversarial): o crédito registrava só os
      // dias MANUAIS — ativação com autoDays > days (ex.: 0 manual + 30 auto)
      // deixava o extrato menor que o saldo real e o auditor de dias acusava
      // um cliente legítimo. O restante mede max(manual, auto), então a
      // evidência registra o MAIOR dos dois relógios concedidos.
      const _credDias=Math.max(days,autoDays);
      if(_credDias>0) addCredito(d.email,{dias:_credDias,tipo:"gratis",origem:"admin",motivo:`Ativação admin — ${planName} (manual ${days}d · auto ${autoDays}d)`+(d.note?` (${d.note})`:""),dadoPor:_sessAdminNome(s)});
      console.log(`[admin] ✅ Ativou ${planName} → ${d.email} (manual:${days}d→${new Date(manualExpires).toLocaleDateString('pt-BR')} auto:${autoDays}d→${autoExpires>now?new Date(autoExpires).toLocaleDateString('pt-BR'):'–'})`);

      // (Bônus de indicação por compra removido — 2026-07-03, KB-059)

      return json(res,200,{ok:true,vip,days,autoDays,
        manualExpiresDate:manualExpires>now?new Date(manualExpires).toLocaleDateString("pt-BR"):null,
        autoExpiresDate:autoExpires>now?new Date(autoExpires).toLocaleDateString("pt-BR"):null});
    }catch(e){return json(res,500,{error:e.message});}}

    // 🤖 v188 LOTE 6: a ÚNICA rota de revogação (a duplicata /api/admin/revoke-vip
    // foi removida). Duas correções ao ganhar botão no painel: (a) 404 pra
    // usuário inexistente — antes um e-mail digitado errado criava um registro
    // vazio e devolvia "ok"; (b) o vip é ZERADO, não SUBSTITUÍDO: o objeto novo
    // apagava `vip.creditos` (o extrato de dias concedidos que a aba Usuários,
    // a régua do ⚠️ e a auditoria financeira leem) — revogar um plano não pode
    // apagar a história de quantos dias foram dados e por quê.
    if(pathname==="/api/admin/vip/revoke"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório."});const _tgtRev=getUser(d.email);if(!_tgtRev)return json(res,404,{error:"Usuário não encontrado."});const _audBefore=_vipSnapshot(_tgtRev);if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}delAutoJob(d.email);setUser(d.email,{plan:"free",vip:{...(_tgtRev.vip||{}),active:false,revokedAt:Date.now(),revokedBy:_sessAdminEmail(s),manualExpires:0,autoExpires:0,expiresAt:0,limits:null}});logAdminAction(_sessAdminEmail(s),"vip_revoke",d.email,_audBefore,_vipSnapshot(getUser(d.email)),"VIP revogado → free");return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

    // ── CONTAS DUPLICADAS (v19, dono 15/07/2026): mesma pessoa com 2+ contas ──
    // Detecta por: (a) mesmo nome normalizado (sem acento/caixa/espaço extra),
    // (b) mesmo telefone/WhatsApp, (c) mesmo IP de trial. Dandara Neves 2x,
    // Simone Santana 2x e Lucas Hara 2x apareciam soltos na lista sem nenhum
    // aviso — agora o admin vê os grupos e decide o que fazer.
    if(pathname==="/api/admin/duplicates"&&req.method==="GET"){
      const _norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\s+/g," ").trim();
      const byName={},byPhone={};
      for(const u of Object.values(DB_USERS)){
        if(!u?.email)continue;
        const n=_norm(u.name);
        if(n&&n.length>5)(byName[n]=byName[n]||[]).push(u.email);
        const ph=String(u.whatsapp||u.phone||"").replace(/[^0-9]/g,"");
        if(ph&&ph.length>=10)(byPhone[ph]=byPhone[ph]||[]).push(u.email);
      }
      const byIp={};
      try{for(const[ip,rec]of Object.entries(DB_TRIAL_USED?.ips||{})){const ems=Array.isArray(rec)?rec:(rec?.emails||[rec?.email].filter(Boolean));if(ems&&ems.length>1)byIp[ip]=ems;}}catch{}
      const groups=[];
      const _mk=(tipo,chave,emails)=>{
        const users=emails.map(e=>{const u=getUser(e)||{};const vip=u.vip||{};return{email:e,name:u.name||e,plan:getPlan(u),source:vip.source||"",vipAtivo:isVipActive(u),criadoEm:u.created_at||null,totalEnviado:(getHist(e)||[]).length};});
        groups.push({tipo,chave,users});
      };
      // v53 (dono, 25/07: "estou com muita dificuldade de entender tudo isso
      // ... não mostrar se não valer a pena"): grupo que contém QUALQUER
      // conta de admin é o próprio dono/sócios testando (mesmo nome/telefone
      // dos admins) — não é suspeita de fraude, só polui a tela. Some inteiro.
      const _grupoDeAdmin=(ems)=>ems.some(e=>isAdminEmail(e));
      for(const[n,ems]of Object.entries(byName)){const u2=[...new Set(ems)];if(u2.length>1&&!_grupoDeAdmin(u2))_mk("nome",n,u2);}
      for(const[ph,ems]of Object.entries(byPhone)){const u2=[...new Set(ems)];if(u2.length>1&&!_grupoDeAdmin(u2))_mk("telefone",ph,u2);}
      for(const[ip,ems]of Object.entries(byIp)){const u2=[...new Set(ems)];if(u2.length>1&&!_grupoDeAdmin(u2))_mk("ip_trial",ip,u2);}
      return json(res,200,{ok:true,groups,total:groups.length});
    }

    // ── AUDITORIA DO ADMIN: listar + reverter (v19, dono 15/07/2026) ─────────
    if(pathname==="/api/admin/audit"&&req.method==="GET"){
      return json(res,200,{ok:true,audit:DB_ADMIN_AUDIT.slice(0,200)});
    }
    if(pathname==="/api/admin/audit/revert"&&req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      if(!d.id)return json(res,400,{error:"id obrigatório."});
      const motivo=String(d.motivo||"").trim();
      if(motivo.length<3)return json(res,400,{error:"Motivo é obrigatório (mín. 3 caracteres) — fica registrado na auditoria."});
      const entry=DB_ADMIN_AUDIT.find(a=>a.id===d.id);
      if(!entry)return json(res,404,{error:"Registro de auditoria não encontrado."});
      if(entry.reverted)return json(res,409,{error:"Esta ação já foi revertida antes."});
      if(!entry.before||!entry.targetEmail)return json(res,400,{error:"Esta ação não tem snapshot para reverter."});
      const target=getUser(entry.targetEmail);
      if(!target)return json(res,404,{error:"Usuário-alvo não existe mais."});
      const _now=_vipSnapshot(target);
      // Restaura EXATAMENTE o plano/vip de antes da ação
      setUser(entry.targetEmail,{plan:entry.before.plan||"free",vip:entry.before.vip||null});
      entry.reverted=true;entry.revertedAt=Date.now();entry.revertedBy=s.user_email;entry.revertMotivo=motivo;
      persist(ADMIN_AUDIT_FILE,DB_ADMIN_AUDIT);
      logAdminAction(s.user_email,"revert",entry.targetEmail,_now,entry.before,`Reversão de "${entry.action}" (${entry.id}): ${motivo}`);
      console.log(`[audit] ↩️ ${s.user_email} reverteu ${entry.action} de ${entry.targetEmail}`);
      return json(res,200,{ok:true,restored:entry.before});
    }catch(e){return json(res,500,{error:e.message});}}

    if(pathname==="/api/admin/vip/set-expiry"&&req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      if(!d.email)return json(res,400,{error:"email obrigatório."});
      // 🚨 v237 (achado de auditoria — Alta): set-expiry era a ÚNICA rota que
      // muda vip.manualExpires/autoExpires SEM a trava de duplo-clique que
      // vip/activate (v18-FIX) e set-plan (13r) já têm — mesma _adminVipActivateLock,
      // mesma janela de 5s. Duplo-clique/retry aqui não dobra os dias (é "definir
      // vencimento exato", não "somar"), mas duplicava o addCredito() da linha do
      // tempo (Cérebro 2.0-P1) e o logAdminAction, inflando o teto explicável e
      // poluindo a auditoria com 2 entradas idênticas pra 1 ação só.
      const _vipSetExpKey=s.user_email+"|"+String(d.email||"").toLowerCase();
      if(_adminVipActivateLock.has(_vipSetExpKey))
        return json(res,409,{error:"Ativação em andamento para este usuário. Aguarde alguns segundos e confira antes de tentar de novo.",duplicate:true});
      _adminVipActivateLock.set(_vipSetExpKey,Date.now());
      setTimeout(()=>_adminVipActivateLock.delete(_vipSetExpKey),5000);
      const target=getUser(d.email);
      if(!target)return json(res,404,{error:"Usuário não encontrado."});
      const now=Date.now();
      const manualDays=parseInt(d.manualDays||0,10);
      const autoDays=parseInt(d.autoDays||0,10);
      const manualExpires=manualDays>0?now+manualDays*86400000:0;
      const autoExpires=autoDays>0?now+autoDays*86400000:0;
      let planName=target.vip?.plan||"vip";
      if(d.plan)planName=d.plan;
      else if(manualDays>0&&autoDays>0)planName="vipro";
      else if(manualDays>0)planName="vip";
      else if(autoDays>0)planName="pro";
      const vip={...(target.vip||{}),active:true,manualExpires,autoExpires,
        adjustedAt:now,adjustedBy:_sessAdminEmail(s),adjustedCreditado:true,
        note:d.note||(target.vip?.note||""),
        plan:planName,source:target.vip?.source||"admin",
        usedCode:target.vip?.usedCode||null,
        // 💳 v187: mesma régua única do vip/activate — "definir vencimento
        // exato" também é ativação e precisa dizer QUAIS limites valem.
        ...limitsParaAtivacaoAdmin(target,planName)};
      const _audBefore=_vipSnapshot(target); // v19: snapshot pra reversão
      setUser(d.email,{plan:planName,vip});
      logAdminAction(_sessAdminEmail(s),"set_expiry",d.email,_audBefore,_vipSnapshot(getUser(d.email)),`Validade → manual:${manualDays}d auto:${autoDays}d plano:${planName}`);
      // 🧠 Cérebro 2.0 P1 (revisão adversarial): "definir vencimento exato"
      // (13r) não deixava NENHUMA evidência que os motores de dias leem — um
      // ajuste LEGÍTIMO do admin viraria acusação de "dias sem origem". O
      // ajuste agora vira crédito DATADO (o maior dos dois relógios; evento
      // em t com D dias reproduz exatamente now+D na linha do tempo) e o vip
      // carimba adjustedCreditado — ajustes ANTIGOS, sem crédito, são
      // ancorados pelo auditor via adjustedAt e ficam fora da acusação.
      const _diasSet=Math.max(manualDays>0?manualDays:0,autoDays>0?autoDays:0);
      if(_diasSet>0)addCredito(d.email,{dias:_diasSet,tipo:"gratis",origem:"set-expiry",motivo:`Vencimento definido pelo admin: manual ${manualDays}d · auto ${autoDays}d (${planName})`,dadoPor:_sessAdminNome(s)});
      console.log("[admin] set-expiry "+d.email+" manual:"+manualDays+"d auto:"+autoDays+"d plano:"+planName);
      return json(res,200,{ok:true,vip,planName,
        manualExpiresDate:manualExpires>0?new Date(manualExpires).toLocaleDateString("pt-BR"):null,
        autoExpiresDate:autoExpires>0?new Date(autoExpires).toLocaleDateString("pt-BR"):null});
    }catch(e){return json(res,500,{error:e.message});}}
    // ── v28: 💰 VISÃO DO DONO — a 1ª tela do admin (ordem do dono: "o adm
    // precisa saber sobre valores, entradas, e tudo sobre isso"). Padrão dos
    // painéis de referência: 4-6 números de dinheiro/ação, zero ruído.
    if(pathname==="/api/admin/dono-resumo"&&req.method==="GET"){
      const now=Date.now(),DAY=86400_000;
      // "hoje" em BRT: compara a data ISO (YYYY-MM-DD) do timestamp deslocado
      // -3h com a de agora deslocada -3h (todayStrBRT é DD/MM — não serve aqui)
      const hojeISO=new Date(now-3*3600_000).toISOString().slice(0,10);
      const _ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
      // v83: janelas hoje/7d/30d/total agora vêm da MESMA fonte única do
      // Faturamento Global (computeEntradasJanelas) — nunca mais 2 cálculos
      // separados que podem divergir (mesma classe de bug do v77b, no caixa).
      const janelas=computeEntradasJanelas();
      // 💼 MC5-P3 (bug real da auditoria 29/08): gasto nasce com dataGasto —
      // ler dataPagamento aqui fazia "gastos 30d" mostrar R$0 SEMPRE e o
      // "líquido 30d" virar receita bruta disfarçada.
      let g30=0;for(const g of (DB_FINANCEIRO.gastos||[])){const t=_ts(g.dataGasto||g.data)||g.criadoEm||0;if(t>=now-30*DAY)g30+=parseFloat(g.valor)||0;}
      // Pedidos esperando decisão = dinheiro parado na mesa
      const pend=DB_PEDIDOS.filter(x=>["pendente","pago"].includes(String(x.status||"").toLowerCase())&&!_pedidoNaoEhReceita(x));
      const pendValor=pend.reduce((a,x)=>a+(parseFloat(x.valorTotal)||0),0);
      // Vencendo em 7 dias (renovação = receita da semana que vem) — a
      // CONTAGEM de pagantes já vem de janelas.pagantes (fonte única);
      // esta lista só monta o detalhe (quem, plano, quantos dias faltam).
      const vencendo=[];
      for(const[em,u2]of Object.entries(DB_USERS)){
        if(_usuarioNaoEhReceita(em,u2))continue; // v53 + v237v-FIX: admin/teste não é pagante (emailContato, não a chave)
        if(!u2?.vip?.active||u2.vip.source==="trial"||u2.vip.source==="code")continue;
        const exp=Math.max(u2.vip.manualExpires||0,u2.vip.autoExpires||0);
        if(exp<=now)continue;
        if(exp<=now+7*DAY)vencendo.push({email:em,nome:u2.name||em,plano:u2.vip.plan||u2.plan||"vip",diasRestantes:Math.max(0,Math.ceil((exp-now)/DAY))});
      }
      vencendo.sort((a,b)=>a.diasRestantes-b.diasRestantes);
      // Cadastros
      let novosHoje=0,novos7=0,totalUsers=0;
      for(const u2 of Object.values(DB_USERS)){
        totalUsers++;
        const c=_ts(u2?.created_at);
        if(c>=now-7*DAY)novos7++;
        if(c&&new Date(c-3*3600_000).toISOString().slice(0,10)===hojeISO)novosHoje++;
      }
      return json(res,200,{ok:true,
        entradas:{hoje:janelas.hoje,dias7:janelas.dias7,dias30:janelas.dias30,total:janelas.total,ticketMedio30:janelas.n30?Math.round(janelas.dias30/janelas.n30):0},
        gastos30:g30,liquido30:janelas.dias30-g30,
        pendentes:{qtd:pend.length,valor:pendValor},
        pagantes:janelas.pagantes,vencendo7d:vencendo.slice(0,8),vencendoQtd:vencendo.length,
        novos:{hoje:novosHoje,dias7:novos7,total:totalUsers}});
    }
    // ── Admin: PAGANTES — visão única "quem pagou + dias de VIP" (calculada no servidor = fonte única) ──
if(pathname==="/api/admin/pagantes"&&req.method==="GET"){try{
  const now=Date.now();
  const parseVal=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
  const toTs=x=>{if(!x)return null;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?null:t;};
  // Livro-caixa (fonte primária de pagamentos) por email
  const finByEmail={};
  for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){
    if(!pg||!pg.email)continue;
    const e=String(pg.email).toLowerCase();
    (finByEmail[e]=finByEmail[e]||[]).push({valor:parseVal(pg.valor),date:toTs(pg.dataPagamento)||toTs(pg.data)||pg.criadoEm||null,id:pg.id||null,source:"financeiro"});
  }
  // Pedidos pagos/ativos (fallback) por email
  const pedByEmail={};
  for(const ped of Object.values(DB_PEDIDOS||{})){
    if(!ped||!ped.userEmail)continue;
    const st=String(ped.status||"").toLowerCase();
    if(st!=="pago"&&st!=="ativo")continue;
    const e=String(ped.userEmail).toLowerCase();
    (pedByEmail[e]=pedByEmail[e]||[]).push({valor:parseVal(ped.valorTotal),date:ped.ativadoEm||ped.pagoEm||ped.createdAt||null,id:ped.id||null,source:"pedido"});
  }
  const PLAN_LABELS={free:"Grátis",vip:"✋ Manual",pro:"🤖 Pro",vipro:"⚡ Turbo",doublepro:"🚀 Máximo"};
  const rows=[];
  for(const u of Object.values(DB_USERS||{})){
    if(!u||!u.email)continue;
    // 🎬 v237v: a conta de TESTE nunca aparece como "quem pagou" — mesma
    // régua da Conferência/DRE. v237v-FIX: u.email é a CHAVE de login
    // (username pra conta nova, nunca bate contra TEST_ACCOUNT_EMAIL) —
    // confere o Gmail de CONTATO real (emailContato).
    if(isTestAccountEmail(u.emailContato))continue;
    const email=u.email;const elc=email.toLowerCase();const vip=u.vip||{};
    const src=String(vip.source||"").toLowerCase();
    // Pagamentos: Financeiro (primário) -> Pedidos (fallback) -> paymentAmount do usuário (último recurso)
    let pagamentos=finByEmail[elc]||[];
    if(!pagamentos.length) pagamentos=pedByEmail[elc]||[];
    if(!pagamentos.length && u.paymentAmount) pagamentos=[{valor:parseVal(u.paymentAmount),date:vip.activatedAt||null}];
    pagamentos=pagamentos.filter(p=>p.valor>0).sort((a,b)=>(b.date||0)-(a.date||0));
    const everPaidVip = (src===""||src==="admin"||src==="pago"||src==="payment") && ((vip.manualExpires||0)>0||(vip.autoExpires||0)>0||vip.activatedAt);
    const isPayer = pagamentos.length>0 || everPaidVip;
    if(!isPayer)continue;
    const plan=vip.plan||getPlan(u);
    const nextExp=Math.max(vip.manualExpires||0,vip.autoExpires||0);
    const daysLeft = diasRestantesCanonico(nextExp,now);
    const manualActive=isManualVipActive(u);const autoActive=isAutoVipActive(u);
    const status = daysLeft===null?"sem_data":(daysLeft<=0?"vencido":(daysLeft<=3?"vencendo":"ativo"));
    const totalPago=pagamentos.reduce((acc,p)=>acc+p.valor,0);
    const last=pagamentos[0]||null;
    rows.push({
      email,name:u.name||email,plan,planLabel:PLAN_LABELS[plan]||plan,source:src||"admin",
      whatsapp:u.whatsapp||u.phone||"",
      manualExpires:vip.manualExpires||0,autoExpires:vip.autoExpires||0,nextExpiry:nextExp,
      daysLeft,manualActive,autoActive,active:(manualActive||autoActive),status,
      lastPaymentValor:last?last.valor:0,lastPaymentDate:last?last.date:null,
      lastPaymentId:last?last.id:null,lastPaymentSource:last?last.source:null,
      totalPago,pedidosCount:pagamentos.length,note:vip.note||""
    });
  }
  rows.sort((a,b)=>{if(a.daysLeft===null&&b.daysLeft===null)return 0;if(a.daysLeft===null)return 1;if(b.daysLeft===null)return -1;return a.daysLeft-b.daysLeft;});
  // v19: Receita da fonte canônica ÚNICA — antes esta aba somava o livro-caixa
  // CRU (sem excluir code/trial, sem correção de pedido) e mostrava
  // "R$ 1.250 receita do mês" enquanto os Indicadores mostravam R$ 1.085.
  const _F=computeFinanceCanonico();
  const summary={
    totalPagantes:rows.length,
    ativos:rows.filter(r=>r.status==="ativo"||r.status==="vencendo").length,
    vencendo:rows.filter(r=>r.status==="vencendo").length,
    vencidos:rows.filter(r=>r.status==="vencido").length,
    semData:rows.filter(r=>r.status==="sem_data").length,
    receitaMes:_F.receitaMes,receitaTotal:_F.receitaTotal
  };
  return json(res,200,{ok:true,rows,summary,generatedAt:now});
}catch(e){return json(res,500,{error:e.message});}}

// ══════════════════════════════════════════════════════════════════════════
// 🧮 CONTABILIDADE (admin-only) — 100% DETERMINÍSTICA, ZERO IA/Cérebro.
// Reaproveita DB_PEDIDOS/DB_FINANCEIRO (já existentes) e a fórmula EXATA de
// "dias restantes" de /api/admin/pagantes (Math.max dos 2 expires,
// Math.ceil da diferença em dias) — só que aqui a lista é de TODOS os
// usuários (não só quem pagou) e ordenada DECRESCENTE (mais dias primeiro).
// Checagem de consistência simples e honesta: dias restantes > soma dos
// dias creditados (vip.creditos tipo:"pago") = flag de suspeita — é só
// matemática, sem IA, sem Cérebro Contábil.
// v166: assinatura de uma divergência de contabilidade — identifica a
// divergência EXATA (regra + usuário + os números que a causaram), nunca
// só o e-mail. Se os números mudarem depois (nova divergência), a
// assinatura muda junto e o alerta volta a aparecer — "confirmar OK" nunca
// é um "silenciar pra sempre" por usuário.
function _divergenciaAssinatura(regraId,email,valores){
  const partes=[regraId,String(email||"").toLowerCase(),...(valores||[]).map(v=>String(v))];
  return crypto.createHash("sha256").update(partes.join("|")).digest("hex").slice(0,24);
}
// ── GET /api/admin/contabilidade — dashboard ────────────────────────────
if(pathname==="/api/admin/contabilidade"&&req.method==="GET"){
  const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
  const pAdm=getUser(s.user_email);if(!isAdminVip(pAdm))return json(res,403,{error:"Acesso negado."});
  try{
    const now=Date.now();
    const pv=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
    // Total recebido: mesma fonte única canônica do resto do painel
    // (computeEntradasJanelas já exclui admin/teste — regra 13n).
    const totalRecebido=computeEntradasJanelas().total;
    // Gastos por sócio — direto do livro-caixa (DB_FINANCEIRO.gastos).
    const gastos=(DB_FINANCEIRO&&DB_FINANCEIRO.gastos)||[];
    let gastosAndrio=0,gastosDiego=0,gastosEmpresa=0;
    for(const g of gastos){
      const v=pv(g.valor);const pp=String(g.pagoPor||"").toLowerCase();
      if(pp==="andrio")gastosAndrio+=v;
      else if(pp==="diego")gastosDiego+=v;
      else gastosEmpresa+=v;
    }
    const totalGastos=gastosAndrio+gastosDiego+gastosEmpresa;
    // Lista de TODOS os usuários por dias de VIP restantes — fórmula EXATA
    // de /api/admin/pagantes, mas DESC (quem tem MAIS dias primeiro).
    const usuarios=[];
    for(const u of Object.values(DB_USERS||{})){
      if(!u||!u.email)continue;
      const vip=u.vip||{};
      const nextExp=Math.max(vip.manualExpires||0,vip.autoExpires||0);
      const daysLeft=diasRestantesCanonico(nextExp,now);
      const diasCreditadosPagos=(Array.isArray(vip.creditos)?vip.creditos:[])
        .filter(c=>c&&c.tipo==="pago").reduce((a,c)=>a+(parseInt(c.dias,10)||0),0);
      // 🤖 v188 LOTE 6: dia PAGO e dia DADO são coisas diferentes e a régua do
      // ⚠️ (que só conta "pago") continua intocada — esta coluna é ADITIVA:
      // mostra, ao lado, quantos dias foram concedidos como cortesia. Sem ela
      // o admin via "restam 40 dias / creditados 0" e não tinha como saber,
      // olhando a tela, que os 40 saíram de uma concessão manual legítima.
      const diasCreditadosCortesia=(Array.isArray(vip.creditos)?vip.creditos:[])
        .filter(c=>c&&c.tipo!=="pago").reduce((a,c)=>a+(parseInt(c.dias,10)||0),0);
      // 🔎 checagem de consistência simples: dias restantes > total creditado
      // como "pago" = suspeita (dias apareceram sem crédito registrado que
      // os explique). Só flaga quando há dias restantes de verdade.
      const regraId="dias_maior_creditado";
      const rawSuspeita=(daysLeft!=null&&daysLeft>0&&diasCreditadosPagos<daysLeft);
      // a assinatura carrega os NÚMEROS exatos da divergência atual — o
      // cálculo roda sempre do zero (nunca cacheia o resultado), só a
      // DECISÃO do admin sobre ESSES números específicos é que persiste.
      // v167 (bug real: "Concordo, está OK" nunca ficava confirmado por mais
      // de ~24h): a assinatura usava `daysLeft`, que é Math.ceil((nextExp-
      // Date.now())/86400000) — recalculado a cada request, ele DIMINUI 1
      // por dia só pelo tempo passar, mesmo sem NADA mudar na conta. No dia
      // seguinte a assinatura já era outra e o ⚠️ voltava sozinho pro mesmo
      // caso já revisado. `nextExp` é a data de expiração em si (timestamp
      // fixo — só muda quando o admin de fato mexe no VIP), então usá-la no
      // lugar de `daysLeft` mantém a confirmação válida enquanto a situação
      // real não mudar, e ainda assim invalida a assinatura se a expiração
      // ou os dias creditados mudarem de verdade.
      const assinatura=rawSuspeita?_divergenciaAssinatura(regraId,u.email,[nextExp,diasCreditadosPagos]):null;
      const jaConfirmadaOk=!!(assinatura&&DB_DIVERGENCIAS_OK[assinatura]);
      const suspeita=rawSuspeita&&!jaConfirmadaOk;
      // 🤖 v188 LOTE 6 (o maior buraco de receita da auditoria): pagante com o
      // robô morto era INVISÍVEL no painel. O sentinela já detecta (vipDesync),
      // mas avisava por sendNotifEmail e pushToUser — os DOIS são no-op nesta
      // reconstrução, então o achado não chegava a ninguém. Aqui vai o estado
      // CRU por usuário (nunca uma 2ª régua de "robô quebrado" — a régua é a do
      // sentinela, que alimenta o card da aba Usuários): se o Gmail de envio
      // está conectado (BOOLEANO — o token NUNCA viaja) e o que o robô dele
      // está fazendo agora.
      const _jobU=getAutoJob(u.email);
      usuarios.push({
        email:u.email,nome:u.name||u.email,plano:getPlan(u),
        manualExpires:vip.manualExpires||0,autoExpires:vip.autoExpires||0,
        daysLeft,diasCreditadosPagos,diasCreditadosCortesia,
        gmailConectado:!!u.refresh_token,
        robo:_jobU?{ativo:!!_jobU.active,status:String(_jobU.status||""),fila:(_jobU.queue||[]).length}:null,
        isAdmin:isAdminVip(u),assinatura,
        suspeita:!!suspeita,motivo:rawSuspeita?"dias restantes maiores que o total creditado":null
      });
    }
    // DESC: quem tem MAIS dias primeiro; sem data (null) sempre por último.
    usuarios.sort((a,b)=>{
      if(a.daysLeft===null&&b.daysLeft===null)return 0;
      if(a.daysLeft===null)return 1;
      if(b.daysLeft===null)return -1;
      return b.daysLeft-a.daysLeft;
    });
    return json(res,200,{ok:true,
      totalRecebido,gastosAndrio,gastosDiego,gastosEmpresa,totalGastos,
      qtdUsuarios:usuarios.length,qtdSuspeitas:usuarios.filter(u=>u.suspeita).length,
      usuarios,geradoEm:now});
  }catch(e){return json(res,500,{error:e.message});}
}
// ── POST /api/admin/contabilidade/divergencia — admin confirma (ou não)
// que uma divergência ESPECÍFICA é esperada/está OK. Só grava quando
// concordo:true — a resposta "não, é um problema" não precisa nem chamar
// esta rota (fire-and-forget do front), e mesmo se chamar, não persiste
// nada. Gravar é por ASSINATURA (regra+usuário+números), nunca por e-mail
// sozinho — se os números da divergência mudarem depois, ela volta a
// alertar mesmo pro mesmo usuário.
if(pathname==="/api/admin/contabilidade/divergencia"&&req.method==="POST"){
  const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
  const pAdm=getUser(s.user_email);if(!isAdminVip(pAdm))return json(res,403,{error:"Acesso negado."});
  try{
    const d=JSON.parse(await readBody(req));
    const email=String(d.email||"").trim().toLowerCase();
    const assinatura=String(d.assinatura||"").trim();
    if(!email||!assinatura)return json(res,400,{error:"email e assinatura são obrigatórios."});
    if(d.concordo!==true)return json(res,200,{ok:true,gravado:false});
    DB_DIVERGENCIAS_OK[assinatura]={email,confirmadoEm:Date.now(),confirmadoPor:_sessAdminEmail(s)};
    persist(DIVERGENCIAS_OK_FILE,DB_DIVERGENCIAS_OK);
    return json(res,200,{ok:true,gravado:true});
  }catch(e){return json(res,500,{error:e.message});}
}
// ── POST /api/admin/contabilidade/gasto — registra gasto com comprovante ──
// (mesmo padrão de add_gasto: valor, categoria, comprovante base64<=~8MB
// com fingerprint SHA-256 — mas pagoPor é SÓ andrio|diego, sem "empresa".)
if(pathname==="/api/admin/contabilidade/gasto"&&req.method==="POST"){
  const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
  const pAdm=getUser(s.user_email);if(!isAdminVip(pAdm))return json(res,403,{error:"Acesso negado."});
  try{
    const d=JSON.parse(await readBody(req));
    const gs=d.gasto||d||{};
    const valor=Math.round((parseFloat(gs.valor)||0)*100)/100;
    if(valor<=0)return json(res,400,{error:"Valor do gasto deve ser maior que zero."});
    if(valor>1_000_000)return json(res,400,{error:"Valor do gasto inválido."});
    const pagoPor=String(gs.pagoPor||"").toLowerCase();
    if(!["andrio","diego"].includes(pagoPor))return json(res,400,{error:'pagoPor deve ser "andrio" ou "diego".'});
    const categoria=String(gs.categoria||"geral").slice(0,40);
    const _hashCompC=(b64)=>{try{return crypto.createHash("sha256").update(String(b64).replace(/^data:[^;]+;base64,/,"")).digest("hex");}catch(e){return null;}};
    let comprovante=null,comprovanteType=null;
    if(gs.comprovante&&typeof gs.comprovante==="string"){
      if(gs.comprovante.length>10_700_000)return json(res,400,{error:"O comprovante passou de ~8MB — envie um arquivo menor."});
      if(!/^[A-Za-z0-9+/]/.test(gs.comprovante.slice(0,10)))return json(res,400,{error:"O arquivo do comprovante veio corrompido — tente enviar de novo."});
      comprovante=gs.comprovante;
      const _allowC=["image/jpeg","image/jpg","image/png","image/webp","application/pdf"];
      comprovanteType=_allowC.includes(gs.comprovanteType)?gs.comprovanteType:"image/jpeg";
    }
    const _quem=_sessAdminNome(s); // v183 LOTE 1: pelo e-mail REAL da sessão
    const novo={
      id:"gst_"+Date.now().toString(36)+"_"+crypto.randomBytes(4).toString("hex"),
      valor,categoria,pagoPor,
      descricao:String(gs.descricao||gs.nota||"").slice(0,300),
      dataGasto:gs.dataGasto||new Date().toISOString(),
      criadoEm:Date.now(),
      lancadoPorEmail:_sessAdminEmail(s),lancadoPor:_quem,
      comprovante,comprovanteType,temComprovante:!!comprovante,
      comprovanteHash:comprovante?_hashCompC(comprovante):null
    };
    DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos||[];
    DB_FINANCEIRO.gastos.unshift(novo);
    if(!Array.isArray(DB_FINANCEIRO.alteracoes))DB_FINANCEIRO.alteracoes=[];
    DB_FINANCEIRO.alteracoes.push({id:"alt_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,6),
      tipo:"add_gasto",por:_quem,porEmail:_sessAdminEmail(s),em:Date.now(),
      motivo:"Gasto: R$"+valor.toFixed(2)+" · pago por "+pagoPor+" · "+categoria,antes:null,depois:{id:novo.id,valor,categoria,pagoPor}});
    if(!persistFinanceiro()){
      DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos.filter(x=>x.id!==novo.id);
      DB_FINANCEIRO.alteracoes.pop();
      return json(res,500,{error:"⚠️ Não consegui gravar no disco — a alteração NÃO foi salva. Tente de novo."});
    }
    return json(res,200,{ok:true,id:novo.id,temComprovante:novo.temComprovante});
  }catch(e){return json(res,500,{error:e.message});}
}
// ── POST /api/admin/contabilidade/pagamento — entrada manual no caixa ────
// (mesmo padrão de add_pagamento: cliente ou avulsa, comprovante opcional
// com fingerprint SHA-256, dono do dinheiro só se vier EXPLÍCITO no enum.)
if(pathname==="/api/admin/contabilidade/pagamento"&&req.method==="POST"){
  const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
  const pAdm=getUser(s.user_email);if(!isAdminVip(pAdm))return json(res,403,{error:"Acesso negado."});
  try{
    const d=JSON.parse(await readBody(req));
    const pg=d.pagamento||d||{};
    const valor=Math.round((parseFloat(pg.valor)||0)*100)/100;
    if(valor<=0)return json(res,400,{error:"Valor da entrada deve ser maior que zero."});
    if(valor>1_000_000)return json(res,400,{error:"Valor da entrada inválido."});
    const email=String(pg.email||"").trim().toLowerCase();
    let tipo;
    if(!email){
      if(!pg.nota||String(pg.nota).trim().length<3)
        return json(res,400,{error:"Entrada sem e-mail (avulsa) exige uma descrição de pelo menos 3 caracteres."});
      tipo="avulsa";
    } else { tipo="cliente"; }
    const _rpEnum=String(pg.recebidoPor||"").toLowerCase();
    const recebidoPor=(_rpEnum==="andrio"||_rpEnum==="diego")?_rpEnum:undefined;
    const _hashCompP=(b64)=>{try{return crypto.createHash("sha256").update(String(b64).replace(/^data:[^;]+;base64,/,"")).digest("hex");}catch(e){return null;}};
    let comprovante=null,comprovanteType=null;
    if(pg.comprovante&&typeof pg.comprovante==="string"){
      if(pg.comprovante.length>10_700_000)return json(res,400,{error:"O comprovante passou de ~8MB — envie um arquivo menor."});
      if(!/^[A-Za-z0-9+/]/.test(pg.comprovante.slice(0,10)))return json(res,400,{error:"O arquivo do comprovante veio corrompido — tente enviar de novo."});
      comprovante=pg.comprovante;
      const _allowP=["image/jpeg","image/jpg","image/png","image/webp","application/pdf"];
      comprovanteType=_allowP.includes(pg.comprovanteType)?pg.comprovanteType:"image/jpeg";
    }
    const _quem=_sessAdminNome(s); // v183 LOTE 1: pelo e-mail REAL da sessão
    const novo={
      id:"fin_"+Date.now().toString(36)+"_"+crypto.randomBytes(4).toString("hex"),
      email,nome:pg.nome||email||"",tipo,valor,
      nota:String(pg.nota||"").slice(0,300),
      data:new Date().toISOString(),
      dataPagamento:pg.dataPagamento?new Date(pg.dataPagamento).toISOString():new Date().toISOString(),
      criadoEm:Date.now(),
      lancadoPorEmail:_sessAdminEmail(s),lancadoPor:_quem,
      ...(recebidoPor?{recebidoPor}:{}),
      comprovante,comprovanteType,temComprovante:!!comprovante,
      comprovanteHash:comprovante?_hashCompP(comprovante):null
    };
    DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos||[];
    DB_FINANCEIRO.pagamentos.unshift(novo);
    if(!Array.isArray(DB_FINANCEIRO.alteracoes))DB_FINANCEIRO.alteracoes=[];
    DB_FINANCEIRO.alteracoes.push({id:"alt_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,6),
      tipo:"add_pagamento",por:_quem,porEmail:_sessAdminEmail(s),em:Date.now(),
      motivo:(tipo==="avulsa"?"Entrada avulsa: ":"Entrada de cliente: ")+"R$"+valor.toFixed(2)+" · recebido por "+(recebidoPor||"(sem dono — vai derivar da trilha)"),
      antes:null,depois:{id:novo.id,valor,tipo}});
    if(!persistFinanceiro()){
      DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos.filter(x=>x.id!==novo.id);
      DB_FINANCEIRO.alteracoes.pop();
      return json(res,500,{error:"⚠️ Não consegui gravar no disco — a alteração NÃO foi salva. Tente de novo."});
    }
    return json(res,200,{ok:true,id:novo.id,temComprovante:novo.temComprovante});
  }catch(e){return json(res,500,{error:e.message});}
}

// ── 💳 v141 — AUDITORIA FINANCEIRA POR USUÁRIO (caso Cleiton) ───────────────
// Pedido do dono depois de achar 2 usuários com mais dias de plano do que
// pagaram: uma ficha ÚNICA por usuário juntando tudo que hoje vive espalhado
// em 5 rotas diferentes (user-detail, pedidos filtrados no cliente, diamonds/
// user, audit sem filtro, creditos só via /api/pedido/:id) — comprovante,
// quem editou, quando pagou, histórico completo, dias restantes, quem
// ativou e como, e um comparativo "bate ou não bate". Fonte única: NENHUM
// dado novo é armazenado aqui, só agregação do que já existe (getUser,
// DB_PEDIDOS, DB_ADMIN_AUDIT, vip.creditos).
if(pathname.startsWith("/api/admin/financeiro-usuario/")&&req.method==="GET"){try{
  const email=decodeURIComponent(pathname.replace("/api/admin/financeiro-usuario/","")).toLowerCase().trim();
  const u=getUser(email);
  if(!u)return json(res,404,{error:"Usuário não encontrado."});
  const now=Date.now();
  const vip=u.vip||{};
  const hist=getHist(email);
  const daysLeftOf=ts=>ts?diasRestantesCanonico(ts,now):null;

  // Pedidos deste usuário — completo (comprovante fica como flag; o admin
  // abre o comprovante inteiro clicando, via GET /api/pedido/:id já existente).
  const pedidos=DB_PEDIDOS.filter(pd=>String(pd.userEmail||"").toLowerCase()===email)
    .map(pd=>({id:pd.id,plano:pd.plano,dias:pd.dias,diasBase:pd.diasBase,diasBonus:pd.diasBonus,
      valorTotal:pd.valorTotal,valorOriginal:pd.valorOriginal,status:pd.status,tipo:pd.tipo||"plano",
      temComprovante:temComprovante(pd),comprovanteHash:pd.comprovanteHash||null,
      createdAt:pd.createdAt,pagoEm:pd.pagoEm,ativadoEm:pd.ativadoEm,
      ativadoPor:pd._ativadoEditor||pd.ativadoPor||null,notaAdmin:pd.notaAdmin||null,
      valorCorrigidoPor:pd.valorCorrigidoPor||null,valorCorrigidoEm:pd.valorCorrigidoEm||null}))
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const totalPagoHistorico=pedidos.filter(p=>["pago","ativo"].includes(p.status)).reduce((s2,p)=>s2+(p.valorTotal||0),0);

  // 🚨 Comprovante reutilizado — mesmo hash em pedido de OUTRO usuário.
  const hashesDoUsuario=new Set(pedidos.map(p=>p.comprovanteHash).filter(Boolean));
  const comprovantesReusados=hashesDoUsuario.size?DB_PEDIDOS.filter(pd=>
    pd.comprovanteHash&&hashesDoUsuario.has(pd.comprovanteHash)&&String(pd.userEmail||"").toLowerCase()!==email
  ).map(pd=>({email:pd.userEmail,pedidoId:pd.id})):[];

  // Trilha de auditoria administrativa (todas as ações sobre este usuário).
  const auditoria=DB_ADMIN_AUDIT.filter(a=>a.targetEmail===email)
    .map(a=>({id:a.id,ts:a.ts,admin:a.admin,action:a.action,detail:a.detail,reverted:!!a.reverted,revertedBy:a.revertedBy||null,revertedAt:a.revertedAt||null}));
  const duplicacoes=detectarConcessoesDuplicadas(15).filter(d=>d.email===email);

  // Extrato de dias (creditos) + presentes (giftHistory) — "de onde vieram os dias".
  const creditos=Array.isArray(vip.creditos)?[...vip.creditos].sort((a,b)=>b.quando-a.quando):[];
  const giftHistory=Array.isArray(vip.giftHistory)?[...vip.giftHistory].sort((a,b)=>(b.quando||0)-(a.quando||0)):[];
  const diasPagosLedger=creditos.filter(c=>c.tipo==="pago").reduce((s2,c)=>s2+(c.dias||0),0);
  const diasGratisLedger=creditos.filter(c=>c.tipo==="gratis").reduce((s2,c)=>s2+(c.dias||0),0);

  // Uso real do plano — está usando o que paga?
  const todayManual=countManualToday(hist),todayAuto=countAutoToday(hist);
  const ultimoEnvio=hist[0]||null;
  const autoJob=getAutoJob(email);

  // Sinais de risco.
  const gmailsBloqueados=(u.senderEmails||[]).filter(se=>se.blocked).map(se=>({email:se.email,motivo:se.blockedReason||null}));

  return json(res,200,{ok:true,
    usuario:{email:u.email,name:u.name||u.email,createdAt:u.created_at||null,
      isAdmin:!!u.isAdmin,whatsapp:u.whatsapp||u.phone||"",country:u.country||"",language:u.language||"pt"},
    plano:{
      atual:getPlan(u),source:vip.source||null,note:vip.note||"",
      manual:{ativo:isManualVipActive(u),expira:vip.manualExpires||0,diasRestantes:daysLeftOf(vip.manualExpires)},
      auto:{ativo:isAutoVipActive(u),expira:vip.autoExpires||0,diasRestantes:daysLeftOf(vip.autoExpires)},
      limites:vip.limits||null,limitesEfetivos:{manual:getManualLimit(u),auto:getAutoLimit(u)},
      ativadoPor:vip.activatedBy||null,ativadoEm:vip.activatedAt||null,usedCode:vip.usedCode||null,codeNote:vip.codeNote||null,
    },
    reconciliacao:{
      diasPagosLedger,diasGratisLedger,totalPagoHistorico,
      pedidosPagosCount:pedidos.filter(p=>["pago","ativo"].includes(p.status)).length,
      duplicacoes, // 2+ ativações no mesmo usuário em ≤15min — sinal direto do caso Cleiton
      comprovantesReusados,
    },
    pedidos,
    creditos,giftHistory,auditoria,
    uso:{
      todayManual,manualLimit:getManualLimit(u),todayAuto,autoLimit:getAutoLimit(u),
      totalHistorico:hist.length,ultimoEnvio:ultimoEnvio?{empresa:ultimoEnvio.company,quando:ultimoEnvio.sentAt,tipo:ultimoEnvio.type}:null,
      autoJobStatus:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0}:null,
      perfisCurriculo:(u.profiles||[]).length,cvs:(u.cvs||[]).length,
    },
    risco:{gmailsBloqueados,comprovanteReusadoCount:comprovantesReusados.length},
    // 🔐 v165: raio-X de autenticação — separa "nós derrubamos" de "o
    // Google da conta derrubou" (caso real: usuário desconectando sempre).
    auth:{
      timeline:Array.isArray(u.authTimeline)?u.authTimeline.slice(0,40):[],
      rtInvalid:!!u.rtInvalid,rtInvalidAt:u.rtInvalidAt||null,
      temRefreshToken:!!u.refresh_token,lastConsentAt:u.lastConsentAt||null,
      statusAuto:autoJob?.status||null,
      senders:(u.senderEmails||[]).map(se=>({email:se.email,active:se.active!==false,tokenExpired:!!se.tokenExpired,blocked:!!se.blocked,blockedReason:se.blockedReason||null})),
    },
  });
}catch(e){return json(res,500,{error:e.message});}}

if(pathname.startsWith("/api/admin/user/")&&req.method==="DELETE"){const te=decodeURIComponent(pathname.split("/").pop());if(te===s.user_email)return json(res,400,{error:"Não pode deletar a si mesmo."});const t=getUser(te);if(t)(t.cvs||[]).forEach(c=>deleteCv(te,c.idx));if(autoTimers.has(te)){clearTimeout(autoTimers.get(te));autoTimers.delete(te);}delUser(te);delHist(te);if(DB_AUTO[te]){delete DB_AUTO[te];persist(AUTO_FILE,DB_AUTO);}if(DB_SENT[te]){delete DB_SENT[te];persistSent();}// BUG-011 CORRIGIDO: limpa dados órfãos ao deletar usuário
if(DB_LOGS[te]){delete DB_LOGS[te];persistLogs();}return json(res,200,{ok:true});}
    if(pathname==="/api/admin/message"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email||!d.text)return json(res,400,{error:"email e text obrigatórios."});const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});setUser(d.email,{adminMessage:{text:d.text,date:new Date().toISOString(),from:s.user_email}});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

    // ── ADMIN LIVE MONITOR ────────────────────────────────────
    // ── ADMIN: Jornada individual ─────────────────────────────────────────────
    if(pathname.startsWith("/api/admin/journey/")&&req.method==="GET"){
      const tEm=decodeURIComponent(pathname.replace("/api/admin/journey/",""));
      return json(res,200,{email:tEm,journey:(DB_JOURNEY[tEm]||[]).slice(0,200),total:(DB_JOURNEY[tEm]||[]).length});
    }
    if(pathname==="/api/admin/journey-feed"&&req.method==="GET"){
      const pu=new URL("http://x"+req.url);
      const lim2=parseInt(pu.searchParams.get("limit")||"100");
      const af2=pu.searchParams.get("action")||"";
      const allEv=[];
      for(const[em,evs] of Object.entries(DB_JOURNEY)){
        const usr=getUser(em)||{};
        for(const ev of (evs||[]).slice(0,50)){
          if(af2&&ev.action!==af2)continue;
          allEv.push({...ev,email:em,name:usr.name||em.split("@")[0],picture:usr.picture||"",plan:getPlan(usr)});
        }
      }
      allEv.sort((a,b)=>b.ts-a.ts);
      return json(res,200,{events:allEv.slice(0,lim2),total:allEv.length});
    }
    if(pathname==="/api/admin/reset-daily"&&req.method==="POST"){
      try{
        const td=todayStr();let rm=0,ua=0;
        for(const em of Object.keys(DB_HIST)){
          const before=DB_HIST[em].length;
          DB_HIST[em]=DB_HIST[em].filter(h=>(h.dateStr||"")!==td);
          const r2=before-DB_HIST[em].length;
          if(r2>0){rm+=r2;ua++;invalidateUserStatsCache(em);}
        }
        persist(HIST_FILE,DB_HIST);
        pushGlobalEvent("reset_daily",s.user_email,`Reset: ${rm} entradas de ${ua} usuários`,"info");
        return json(res,200,{ok:true,totalRemoved:rm,usersAffected:ua,date:td});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/fix-auto"&&req.method==="POST"){
      try{
        const fa=JSON.parse(await readBody(req));
        const faTgt=fa.email||null;
        const faResults=[];
        const faEmails=faTgt?[faTgt]:Object.keys(DB_AUTO);
        for(const em of faEmails){
          const job=getAutoJob(em);if(!job)continue;
          const usr=getUser(em)||{};const hist=getHist(em);
          const tAuto=countAutoToday(hist);const aLim=getAutoLimit(usr);
          const hasTmr=autoTimers.has(em);
          const fr={email:em,action:"none",detail:""};
          if(job.active&&(!job.queue||job.queue.length===0)){
            if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
            setAutoJob(em,{...job,active:false,status:"finished",finishedAt:Date.now()});
            addLog(em,{status:"sistema",jobTitle:"✅ Fila finalizada pelo fix-auto",company:"Reparo"});
            fr.action="finalized";fr.detail="Fila vazia→finalizado";
          } else if(!job.active&&(job.status==="paused_no_session"||job.status==="paused_oauth_expired"||job.status==="paused")){
            const hTok=!!(usr.cached_access_token&&usr.cached_token_expiry&&Date.now()<usr.cached_token_expiry-60000);
            const hRef=!!usr.refresh_token;
            if(!hTok&&!hRef){fr.action="skipped";fr.detail="Sem token — login necessário";}
            else{setAutoJob(em,{...job,active:true,status:"restarted_by_fix"});addLog(em,{status:"sistema",jobTitle:"🔧 Reativado pelo fix-auto",company:"OK"});scheduleAuto(em);fr.action="reactivated";fr.detail="Token OK→reativado";}
          } else if(job.active&&!hasTmr){
            addLog(em,{status:"sistema",jobTitle:"🔧 Timer perdido→reagendado",company:"fix-auto"});
            scheduleAuto(em);fr.action="rescheduled";fr.detail="Timer perdido→reagendado";
          } else if(job.status==="waiting_limit"&&tAuto<aLim){
            if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
            setAutoJob(em,{...job,active:true,status:"running"});scheduleAuto(em);
            fr.action="resumed_after_limit";fr.detail=`${tAuto}/${aLim}→retomando`;
          } else if(job.active&&job.queue?.length>0&&hasTmr){
            const st=Date.now()-(job.lastSentAt||job.startedAt||0);
            if(st>600000){if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}scheduleAuto(em);fr.action="unstalled";fr.detail=`Stall ${Math.round(st/60000)}min→reiniciado`;}
            else{fr.action="ok";fr.detail=`OK fila:${job.queue.length}`;}
          } else{fr.action="ok";fr.detail=`status:${job.status||"?"}`;}
          faResults.push(fr);
        }
        const faFixed=faResults.filter(r=>!["ok","skipped","none"].includes(r.action)).length;
        pushGlobalEvent("fix_auto",s.user_email,`fix-auto: ${faFixed}/${faResults.length}`,"info");
        return json(res,200,{ok:true,results:faResults,fixed:faFixed,total:faResults.length});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/bulk-status"&&req.method==="GET"){
      const bsNow=Date.now();const bsResult=[];
      for(const[em,job] of Object.entries(DB_AUTO)){
        const usr=getUser(em)||{};const bsH=getHealth(em)||{};const hist=getHist(em);
        const tAuto=countAutoToday(hist);const aLim=getAutoLimit(usr);
        const hasTmr=autoTimers.has(em);const lastAct=job.lastSentAt||job.startedAt||0;
        const stalMs=job.active&&job.queue?.length>0?bsNow-lastAct:0;
        const hPdf=(usr.cvs||[]).some(c=>{try{return!!loadCv(em,c.idx);}catch{return false;}});
        const hTok=!!(usr.refresh_token||(usr.cached_access_token&&usr.cached_token_expiry&&bsNow<usr.cached_token_expiry-60000));
        const qLen=job.queue?.length||0;const origC=job.originalCount||0;
        const sentC=origC-qLen;const pct=origC>0?Math.round((sentC/origC)*100):0;
        let phase="",phDet="",phIco="",canFix=false,needsUser=false;
        if(!job.active&&!qLen&&job.status==="finished"){phase="finished";phDet=`Concluído ${sentC}/${origC}`;phIco="✅";}
        else if(!job.active&&(job.status==="paused_no_session"||job.status==="paused_oauth_expired")){phase="paused_token";phDet="Token expirado—login necessário";phIco="🔑";needsUser=true;}
        else if(!job.active){phase="paused_manual";phDet=`Parado: ${job.status||"?"}`;phIco="⏸";canFix=true;}
        else if(job.active&&tAuto>=aLim){const nx=job.nextSendAt?new Date(job.nextSendAt):null;phase="waiting_limit";phDet=`Limite ${tAuto}/${aLim}. ${nx?`Retoma em ${Math.round((nx-bsNow)/60000)}min`:"Retoma meia-noite"}. Fila:${qLen}`;phIco="📊";canFix=true;}
        // waiting_hour removido — sem janela de horário
        else if(job.active&&["waiting_rate_limit","waiting_interval","waiting_token_retry"].includes(job.status)){const nx=job.nextSendAt;phase="waiting_limit";phDet=`${job.status==="waiting_rate_limit"?"Rate limit Google":"Aguardando"}. ${nx&&nx>bsNow?`Retoma em ${Math.round((nx-bsNow)/60000)}min`:"Retoma sozinho"}. Fila:${qLen}`;phIco="⏳";}
        else if(job.active&&stalMs>1200000){phase="stalled";phDet=`Travado ${Math.round(stalMs/60000)}min. Timer:${hasTmr?'ativo':'MORTO'}`;phIco="🚨";canFix=true;}
        else if(job.active&&!hasTmr&&qLen>0){phase="dead_timer";phDet="Timer morto";phIco="💀";canFix=true;}
        else if(job.active&&qLen>0){const nx=job.nextSendAt;phase="running";phDet=`${qLen} restantes (${pct}%). ${nx&&nx>bsNow?`Próximo ${Math.round((nx-bsNow)/1000)}s`:"Enviando"}`;phIco="🟢";}
        else{phase=job.status||"unknown";phDet=`Status:${job.status||"?"} Fila:${qLen}`;phIco="❓";}
        const bsLogs=(DB_LOGS[em]||[]).slice(0,20).map(l=>({ts:l.ts,date:l.date||"",status:l.status,jobTitle:l.jobTitle||"",company:l.company||"",to:l.to||"",error:l.error||""}));
        bsResult.push({email:em,name:usr.name||em.split("@")[0],picture:usr.picture||"",plan:getPlan(usr),phase,phaseDetail:phDet,phaseIcon:phIco,canFix,needsUser,job:{active:job.active,status:job.status,queueLen:qLen,originalCount:origC,sentCount:sentC,pctDone:pct,startedAt:job.startedAt,lastSentAt:job.lastSentAt,nextSendAt:job.nextSendAt},todayAuto:tAuto,autoLimit:aLim,stalledMs:stalMs,restarts:bsH.restarts||0,errors:bsH.errors||0,lastError:bsH.lastError||"",checklist:{hasToken:hTok,hasPdf:hPdf,hasTimer:hasTmr,limitOk:tAuto<aLim,queueOk:qLen>0},logs:bsLogs});
      }
      const bsOrd={stalled:0,dead_timer:1,paused_token:2,waiting_limit:3,running:4,paused_manual:5,finished:6,unknown:7};
      bsResult.sort((a,b)=>(bsOrd[a.phase]??99)-(bsOrd[b.phase]??99));
      return json(res,200,{workers:bsResult,total:bsResult.length,ts:bsNow});
    }
    // ── ADMIN: EXPORT COMPLETO DE LOGS PARA IA ──────────────────────────────
    // Gera um relatório JSON estruturado de todos os usuários e seus logs.
    // Formato otimizado para colar no Claude e pedir diagnóstico.
    if(pathname==="/api/admin/logs/export"&&req.method==="GET"){
      const u2=new URL("http://x"+req.url);
      const fmt=u2.searchParams.get("fmt")||"json";    // json | csv | claude
      const filter=u2.searchParams.get("filter")||"";  // all | errors | active
      const since=parseInt(u2.searchParams.get("since")||"0"); // timestamp ms
      const now=Date.now();

      // Montar snapshot completo
      const snapshot={
        exportedAt: new Date().toISOString(),
        exportedBy: s.user_email,
        serverVersion: "v15",
        totalUsers: Object.keys(DB_USERS).length,
        filter,
        users: []
      };

      for(const[email,user] of Object.entries(DB_USERS)){
        const job=getAutoJob(email)||null;
        const h=getHealth(email)||{};
        const hist=getHist(email);
        const logs=(DB_LOGS[email]||[]);
        const journey=(DB_JOURNEY[email]||[]);
        const todayAuto=countAutoToday(hist);
        const autoLimit=getAutoLimit(user);
        const plan=getPlan(user);

        // Filtrar logs por timestamp se solicitado
        const filteredLogs=since>0
          ? logs.filter(l=>l.ts>=since)
          : logs;
        const filteredJourney=since>0
          ? journey.filter(j=>j.ts>=since)
          : journey;

        // Erros recentes (últimas 24h)
        // Erros recentes (últimas 24h) — exclui falhas de rate limit (são esperas normais)
        const recentErrors=logs.filter(l=>
          (l.status==="falhou"||l.status==="erro_anexo")&&
          l.ts>(now-86400000)&&
          !((l.error||"").toLowerCase().includes("rate limit")||
            (l.error||"").toLowerCase().includes("ratelimit")||
            (l.error||"").toLowerCase().includes("user-rate"))
        );

        // Determinar se deve incluir este usuário
        if(filter==="errors" && recentErrors.length===0 && !h.lastError && !job?.status?.includes("paused")) continue;
        if(filter==="active" && !job?.active) continue;

        // Determinar status atual legível
        let currentStatus="Sem automático";
        let statusDetail="";
        if(job){
          const qLen=job.queue?.length||0;
          const origC=job.originalCount||0;
          const pctDone=origC>0?Math.round(((origC-qLen)/origC)*100):0;
          if(!job.active){
            const st=job.status||"parado";
            if(st==="finished") currentStatus="✅ Concluído";
            else if(st.includes("paused_no_session")||st.includes("paused_oauth")) currentStatus="🔑 Token Gmail expirado";
            else if(st==="paused") currentStatus="⏸ Pausado manualmente";
            else if(st==="waiting_rate_limit") currentStatus="⏳ Rate limit Gmail";
            else currentStatus=`Parado: ${st}`;
            statusDetail=`Fila: ${qLen.toLocaleString()} vagas restantes de ${origC.toLocaleString()} (${pctDone}% concluído)`;
          } else {
            const st=job.status||"";
            if(st==="waiting_limit") currentStatus=`📊 Limite diário (${todayAuto}/${autoLimit})`;
            // waiting_hour removido
            else if(st==="waiting_rate_limit") currentStatus=`⏳ Rate limit Gmail`;
            else currentStatus=`🟢 Rodando`;
            statusDetail=`${qLen.toLocaleString()} restantes (${pctDone}%). Próximo: ${job.nextSendAt&&job.nextSendAt>now?Math.round((job.nextSendAt-now)/60000)+"min":"agora"}`;
          }
        }

        // Checar problemas
        const problems=[];
        if(h.oauthOk===false) problems.push("TOKEN_GMAIL_EXPIRADO");
        if(h.hasPdf===false) problems.push("SEM_PDF");
        if((user.profiles||[]).length===0) problems.push("SEM_PERFIL");
        if((user.profiles||[]).every(p=>!(p.subjects?.length>0||p.subject))) problems.push("SEM_ASSUNTO");
        if((user.profiles||[]).every(p=>!(p.emailBodies?.length>0||p.body))) problems.push("SEM_CORPO_EMAIL");
        if(job?.active&&!autoTimers.has(email)) problems.push("TIMER_MORTO");
        if(recentErrors.length>5) problems.push(`${recentErrors.length}_ERROS_24H`);

        snapshot.users.push({
          // Identificação
          email,
          name: user.name||email.split("@")[0],
          plan,
          createdAt: user.created_at||"",
          // Status atual
          currentStatus,
          statusDetail,
          problems,
          hasCriticalProblem: problems.length>0,
          // Automático
          autoJob: job ? {
            active: job.active,
            status: job.status||"",
            queueRemaining: job.queue?.length||0,
            queueOriginal: job.originalCount||0,
            pctDone: job.originalCount>0?Math.round(((job.originalCount-(job.queue?.length||0))/job.originalCount)*100):0,
            daysLeft: autoLimit>0?Math.ceil((job.queue?.length||0)/autoLimit):null,
            startedAt: job.startedAt?new Date(job.startedAt).toISOString():"",
            lastSentAt: job.lastSentAt?new Date(job.lastSentAt).toISOString():"",
            nextSendAt: job.nextSendAt?new Date(job.nextSendAt).toISOString():"",
            source: job.source||"",
            category: job.category||"",
          } : null,
          // Limite diário
          todayAuto,
          todayManual: countManualToday(hist),
          autoLimit,
          manualLimit: getManualLimit(user),
          // Saúde
          health: {
            oauthOk: h.oauthOk,
            hasPdf: h.hasPdf,
            timerActive: autoTimers.has(email),
            restarts: h.restarts||0,
            errors: h.errors||0,
            lastError: h.lastError||"",
            stalledAt: h.stalledAt||null,
          },
          // CVs e perfis
          cvCount: (user.cvs||[]).length,
          cvNames: (user.cvs||[]).map(c=>c.name),
          profileCount: (user.profiles||[]).length,
          profileNames: (user.profiles||[]).map(p=>p.name),
          // Logs filtrados (máx 100 por usuário)
          logs: filteredLogs.slice(0,100).map(l=>({
            date: l.date||"",
            status: l.status,
            company: l.company||"",
            to: l.to||"",
            job: l.jobTitle||"",
            error: l.error||"",
            profile: l.profileUsed||"",
            attach: l.attachCount||0,
          })),
          // Jornada do usuário (máx 50)
          journey: filteredJourney.slice(0,50).map(j=>({
            date: j.date||"",
            action: j.action,
            ok: j.ok,
            detail: j.detail||"",
            error: j.error||"",
          })),
          // Erros recentes
          recentErrors: recentErrors.slice(0,20).map(l=>({
            date: l.date||"",
            company: l.company||"",
            to: l.to||"",
            error: l.error||"",
          })),
        });
      }

      // Ordenar: problemas críticos primeiro
      snapshot.users.sort((a,b)=>{
        if(a.hasCriticalProblem&&!b.hasCriticalProblem) return -1;
        if(!a.hasCriticalProblem&&b.hasCriticalProblem) return 1;
        return (b.recentErrors.length)-(a.recentErrors.length);
      });

      // Formato CLAUDE — texto otimizado para colar no chat
      if(fmt==="claude"){
        const lines=[];
        lines.push(`# H2BApply — Relatório de Diagnóstico`);
        lines.push(`**Gerado em:** ${new Date().toLocaleString("pt-BR")} | **Total usuários:** ${snapshot.totalUsers} | **Filtro:** ${filter||"todos"}`);
        lines.push("");
        const withProblems=snapshot.users.filter(u=>u.hasCriticalProblem||u.recentErrors.length>0);
        const ok=snapshot.users.filter(u=>!u.hasCriticalProblem&&u.recentErrors.length===0);
        lines.push(`## Resumo: ${withProblems.length} com problemas | ${ok.length} sem problemas`);
        lines.push("");
        for(const u of snapshot.users){
          lines.push(`---`);
          lines.push(`### ${u.name} (${u.email}) — ${u.plan.toUpperCase()}`);
          lines.push(`**Status:** ${u.currentStatus}`);
          if(u.statusDetail) lines.push(`**Detalhe:** ${u.statusDetail}`);
          if(u.problems.length>0) lines.push(`**⚠️ PROBLEMAS:** ${u.problems.join(", ")}`);
          if(u.autoJob){
            const j=u.autoJob;
            lines.push(`**Fila:** ${j.queueRemaining.toLocaleString()}/${j.queueOriginal.toLocaleString()} vagas (${j.pctDone}%) — ~${j.daysLeft||"?"}d restantes`);
            lines.push(`**Auto hoje:** ${u.todayAuto}/${u.autoLimit} | **Último envio:** ${j.lastSentAt?j.lastSentAt.slice(0,16).replace("T"," "):"nunca"}`);
          }
          if(u.health.lastError) lines.push(`**Último erro:** ${u.health.lastError}`);
          if(u.recentErrors.length>0){
            lines.push(`**Erros recentes (${u.recentErrors.length}):**`);
            u.recentErrors.slice(0,5).forEach(e=>lines.push(`  - [${e.date}] ${e.company||e.to}: ${e.error}`));
          }
          if(u.logs.length>0){
            lines.push(`**Últimos logs:**`);
            u.logs.slice(0,5).forEach(l=>lines.push(`  - [${l.date}] ${l.status.toUpperCase()} | ${l.company||l.to||""} ${l.error?"→ "+l.error:""}`));
          }
          lines.push("");
        }
        const text=lines.join("\n");
        res.writeHead(200,{
          "Content-Type":"text/plain; charset=utf-8",
          "Content-Disposition":`attachment; filename="h2bapply-diagnostico-${new Date().toISOString().slice(0,10)}.txt"`,
          "Content-Length":Buffer.byteLength(text,"utf8")
        });
        return res.end(text);
      }

      // Formato CSV simplificado
      if(fmt==="csv"){
        const headers=["email","name","plan","currentStatus","problems","todayAuto","autoLimit","queueRemaining","queueOriginal","pctDone","daysLeft","hasPdf","hasToken","timerActive","restarts","errors","lastError","lastSentAt","profileCount","cvCount"];
        const rows=[headers.join(",")];
        snapshot.users.forEach(u=>{
          const j=u.autoJob;
          rows.push([
            u.email,u.name,u.plan,
            `"${u.currentStatus}"`,
            `"${u.problems.join("|")}"`,
            u.todayAuto,u.autoLimit,
            j?.queueRemaining||0,j?.queueOriginal||0,j?.pctDone||0,j?.daysLeft||0,
            u.health.hasPdf,u.health.oauthOk,u.health.timerActive,
            u.health.restarts,u.health.errors,
            `"${(u.health.lastError||"").replace(/"/g,"'").slice(0,100)}"`,
            j?.lastSentAt||"",u.profileCount,u.cvCount
          ].join(","));
        });
        const csv=rows.join("\n");
        res.writeHead(200,{
          "Content-Type":"text/csv; charset=utf-8",
          "Content-Disposition":`attachment; filename="h2bapply-logs-${new Date().toISOString().slice(0,10)}.csv"`,
          "Content-Length":Buffer.byteLength(csv,"utf8")
        });
        return res.end(csv);
      }

      // Formato JSON padrão
      const jsonStr=JSON.stringify(snapshot,null,2);
      res.writeHead(200,{
        "Content-Type":"application/json; charset=utf-8",
        "Content-Disposition":`attachment; filename="h2bapply-logs-${new Date().toISOString().slice(0,10)}.json"`,
        "Content-Length":Buffer.byteLength(jsonStr,"utf8")
      });
      return res.end(jsonStr);
    }

    if(pathname==="/api/admin/live"&&req.method==="GET"){
      const now=Date.now();
      // (Cérebro Contábil removido — semáforo por usuário não existe mais.)
      const _cbFlags={};
      const onlineSessions=Object.values(sessions).filter(s=>s.user_email&&!s.pending&&(now-(s.created_at||0))<SESS_TTL);
      const onlineEmails=new Set(onlineSessions.map(s=>s.user_email));
      const activeJobs=Object.entries(DB_AUTO).filter(([,j])=>j.active&&j.queue?.length>0);
      // v19-FIX (dono, 15/07): "22 fila(s) travada(s)" era ALARME FALSO — jobs em
      // waiting_limit (limite diário atingido, retoma meia-noite) e waiting_rate_limit
      // (Google pausou, retoma sozinho) contavam como "travados" porque o único
      // critério era tempo-sem-enviar. É a MESMA lição do KB-001, que já tinha sido
      // aplicada na auditoria/incidentes mas NÃO aqui no /api/admin/live — que é
      // exatamente o que pinta o banner vermelho e o contador do painel.
      const _WAIT_STATUSES=new Set(["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"]);
      const stalledJobs=activeJobs.filter(([email,job])=>{
        if(_WAIT_STATUSES.has(job.status))return false;
        const lastAct=job.lastSentAt||job.startedAt||0;
        return now-lastAct>STALL_THRESHOLD;
      });
      const users=Object.values(DB_USERS).map(u=>{
        const job=getAutoJob(u.email);
        const h=getHealth(u.email);
        const hist=getHist(u.email);
        const logs=(DB_LOGS[u.email]||[]).slice(0,8); // mais logs para diagnóstico
        const todaySent=countManualToday(hist)+countAutoToday(hist);
        // CORREÇÃO: duplicados NÃO são falhas — são comportamento normal e esperado do sistema
        // "falhou" = erro real (SMTP, quota, token, etc.)
        // "duplicado" / "pulado" = sistema funcionando corretamente (anti-spam, anti-repetição)
        const todayFailed=(DB_LOGS[u.email]||[]).filter(l=>l.status==="falhou"&&l.ts>now-86400000).length;
        const todaySkipped=(DB_LOGS[u.email]||[]).filter(l=>l.status==="pulado"&&l.ts>now-86400000).length;
        const todayDuplicates=(DB_LOGS[u.email]||[]).filter(l=>l.status==="duplicado"&&l.ts>now-86400000).length;
        const isOnline=onlineEmails.has(u.email);
        const lastSession=onlineSessions.find(s=>s.user_email===u.email);
        const sessionAge=lastSession?Math.round((now-(lastSession.created_at||0))/60000):null;
        // v19-FIX: waiting_limit/rate_limit/interval NÃO é travado (mesma regra do
        // stalledJobs acima) — era isso que marcava "🚨 Travado"/"Problema" em
        // usuário que só atingiu o limite diário (10/10, 200/200).
        const jobStalled=job?.active&&!_WAIT_STATUSES.has(job?.status)&&job?.queue?.length>0&&(now-(job.lastSentAt||job.startedAt||0))>STALL_THRESHOLD;
        const uPlan=getPlan(u);
        const autoLimitU=getAutoLimit(u);
        const manualLimitU=getManualLimit(u);
        const todayManualU=countManualToday(hist);
        const todayAutoU=countAutoToday(hist);

        // ── DIAGNÓSTICO: por que não está enviando? ──────────────
        let diagStatus = "ok";
        let diagReason = "";
        let diagAction = "";
        if (job?.active) {
          const lastSentMs = job.lastSentAt ? now - job.lastSentAt : null;
          const minsSinceLastSend = lastSentMs ? Math.round(lastSentMs/60000) : null;
          const expectedMaxInterval = 6; // 5min max + 1min margem

          if (job.status === "waiting_limit") {
            diagStatus = "waiting_limit";
            diagReason = `Limite diário atingido (${todayAutoU}/${autoLimitU}). Retoma amanhã.`;
            diagAction = "Normal — aguarda meia-noite BRT";
          // waiting_hour removido — sem janela de horário
            diagAction = "Normal — aguarda horário configurado";
          } else if (job.status === "waiting_rate_limit") {
            diagStatus = "rate_limit";
            diagReason = `Gmail bloqueou temporariamente (rate limit). Retoma às ${job.nextSendAt?new Date(job.nextSendAt).toLocaleTimeString("pt-BR",{timeZone:"America/Sao_Paulo"}):"?"}`;
            diagAction = "Normal — aguarda Google liberar";
          } else if (job.status === "waiting_token_retry") {
            diagStatus = "token_retry";
            diagReason = "Erro temporário de token. Tentando renovar em 5min.";
            diagAction = "Aguardar ou reiniciar manualmente";
          } else if (jobStalled) {
            diagStatus = "stalled";
            const stallMins = Math.round((now-(job.lastSentAt||job.startedAt||0))/60000);
            diagReason = `Travado há ${stallMins}min sem enviar. Timer: ${autoTimers.has(u.email)?"✅ ativo":"❌ morto"}. Token: ${h.oauthOk===false?"❌ inválido":"?"}`;
            diagAction = "Reinicie o worker — watchdog vai tentar automaticamente";
          } else if (minsSinceLastSend !== null && minsSinceLastSend > expectedMaxInterval && job.status === "sending") {
            diagStatus = "stuck_sending";
            diagReason = `Status 'sending' há ${minsSinceLastSend}min — possível travamento interno`;
            diagAction = "Reinicie o worker";
          } else if (!h.oauthOk && h.oauthOk !== null) {
            diagStatus = "no_token";
            diagReason = "Token OAuth inválido ou revogado. Usuário precisa fazer login novamente.";
            diagAction = "Usuário deve fazer login";
          } else if (!h.hasPdf && h.hasPdf !== null) {
            diagStatus = "no_pdf";
            diagReason = "PDF do currículo não encontrado no servidor.";
            diagAction = "Usuário deve fazer upload do PDF novamente";
          } else if (minsSinceLastSend !== null && minsSinceLastSend > 10 && !["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"].includes(job.status)) {
            diagStatus = "slow";
            diagReason = `Último envio há ${minsSinceLastSend}min. Status: ${job.status}. Timer: ${autoTimers.has(u.email)?"✅":"❌"}`;
            diagAction = autoTimers.has(u.email) ? "Aguardar próximo ciclo" : "Reiniciar worker — timer morto";
          } else if (!job.lastSentAt && job.startedAt) {
            const startedMins = Math.round((now-job.startedAt)/60000);
            diagStatus = startedMins > 8 ? "never_sent" : "starting";
            diagReason = startedMins > 8
              ? `Iniciou há ${startedMins}min mas nunca enviou nenhum email. Possível problema de configuração.`
              : `Iniciando (${startedMins}min) — primeiro envio em breve`;
            diagAction = startedMins > 8 ? "Verifique logs — pode ser PDF ausente ou assunto vazio" : "Aguardar";
          } else {
            diagStatus = "ok";
            const lastSendStr = job.lastSentAt ? `${Math.round((now-job.lastSentAt)/60000)}min atrás` : "nunca";
            const nextSendStr = job.nextSendAt && job.nextSendAt > now ? `em ${Math.round((job.nextSendAt-now)/60000)}min` : "em breve";
            diagReason = `Funcionando normalmente. Último envio: ${lastSendStr}. Próximo: ${nextSendStr}.`;
            diagAction = "";
          }
        }

        return{
          email:u.email, name:u.name, picture:u.picture, plan:uPlan,
          isOnline, sessionAge,
          hasAuto:!!job?.active,
          autoStatus:job?.status||null,
          // autoMode/startH/endH removidos — sem janela de horário
          queueSize:job?.queue?.length||0,
          originalCount:job?.originalCount||0,
          queueDaysLeft:autoLimitU>0?Math.ceil((job?.queue?.length||0)/autoLimitU):null,
          lastSentAt:job?.lastSentAt||null,
          startedAt:job?.startedAt||null,
          nextSendAt:job?.nextSendAt||null,
          currentJob:job?.currentJob||null,
          jobStalled,
          timers:autoTimers.has(u.email),
          manualLimit:manualLimitU,
          autoLimit:autoLimitU,
          todaySentManual:todayManualU,
          todaySentAuto:todayAutoU,
          todaySent:todayManualU+todayAutoU,
          todayFailed, todaySkipped, todayDuplicates,
          profileCount:(u.profiles||[]).length,
          hasPdf:h.hasPdf,
          oauthOk:h.oauthOk,
          gmailOk:h.gmailOk,
          restarts:h.restarts||0,
          errors:h.errors||0,
          lastError:h.lastError||"",
          stalledSince:h.stalledAt,
          totalSent:hist.filter(x=>x.type!=="reply").length,
          totalAutoSent:hist.filter(x=>x.type==="auto").length,
          totalManualSent:hist.filter(x=>x.type==="manual").length,
          cvCount:(u.cvs||[]).length,
          createdAt:u.created_at||u.createdAt||"",
          recentLogs:logs,
          lastHeartbeat:h.lastSent||0,
          source:job?.source||null,
          category:job?.category||null,
          totalQueueRemaining:job?.queue?.length||0,
          autoLimitLocked:job?.lockedAutoLimit||null,
          // DIAGNÓSTICO COMPLETO
          diag:{ status:diagStatus, reason:diagReason, action:diagAction },
          cerebro:_cbFlags[u.email]||null, // 🚦 2.0-P5: 🔴/🟡 do Cérebro Contábil
          vip:u.vip?{active:isVipActive(u),manualExpires:u.vip.manualExpires||0,autoExpires:u.vip.autoExpires||0,plan:u.vip.plan||'vip',source:u.vip.source||'admin',usedCode:u.vip.usedCode||null,codeNote:u.vip.codeNote||null,activatedBy:u.vip.activatedBy||null,activatedAt:u.vip.activatedAt||null,note:u.vip.note||null}:null,
          // CCC fields para filtros
          lastValidatedAt:u.lastValidatedAt||null,
          lastValidatedBy:u.lastValidatedBy||null,
          lastValidationResult:u.lastValidationResult||null,
          financialStatus:u.financialStatus||null,
          hasReceipt:!!(u.paymentAmount||u.financialStatus==='pago'),
          accountDeleted:!!u.accountDeleted, deletedAt:u.deletedAt||null,
        };
      }).sort((a,b)=>{
        // Ordena: problemas primeiro, depois ativos, depois online, depois por envios hoje
        const prob = (u) => ["stalled","stuck_sending","no_token","no_pdf","never_sent","token_retry"].includes(u.diag?.status) ? 0 : 1;
        if(prob(a)<prob(b)) return -1; if(prob(a)>prob(b)) return 1;
        if(a.hasAuto&&!b.hasAuto)return-1; if(!a.hasAuto&&b.hasAuto)return 1;
        if(a.isOnline&&!b.isOnline)return-1; if(!a.isOnline&&b.isOnline)return 1;
        return(b.todaySent||0)-(a.todaySent||0);
      });
      const totalSentToday=Object.values(DB_HIST).reduce((n,h)=>n+h.filter(x=>x.dateStr===todayStr()).length,0);
      const totalSentAll=Object.values(DB_HIST).reduce((n,h)=>n+h.length,0);
      // FIX-ADM: estatísticas completas de fila
      const totalQueueAll=Object.values(DB_AUTO).reduce((n,j)=>n+(j.queue?.length||0),0);
      const totalOriginalAll=Object.values(DB_AUTO).reduce((n,j)=>n+(j.originalCount||0),0);
      const activeWithQueue=Object.values(DB_AUTO).filter(j=>j.active&&j.queue?.length>0).length;
      const waitingLimit=Object.values(DB_AUTO).filter(j=>j.active&&j.status==="waiting_limit").length;
      const diskOk=DATA_DIR!=="/tmp";
      return json(res,200,{
        ts:now,
        adminEmail:s.user_email,
        onlineCount:onlineEmails.size,
        activeAutoCount:activeJobs.length,
        activeWithQueue,
        waitingLimit,
        stalledCount:stalledJobs.length,
        totalUsers:Object.keys(DB_USERS).length,
        totalSentToday,totalSentAll,
        totalQueueAll,totalOriginalAll,
        activeSessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,
        globalEvents:GLOBAL_EVENTS.slice(0,100),
        users,
        serverUptime:Math.round(process.uptime()),
        memMB:Math.round(process.memoryUsage().rss/1048576),
        sheetJan:SHEET_JAN.length,sheetJul:SHEET_JUL.length,
        diskOk,dataDir:DATA_DIR,
      });
    }

    // ── ADMIN FORCE RESTART JOB ───────────────────────────────
    if(pathname==="/api/admin/force-restart"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        const job=getAutoJob(d.email);
        if(!job)return json(res,404,{error:"Job não encontrado."});
        if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}
        setAutoJob(d.email,{...job,active:true,status:"restarted_by_admin",lastSentAt:null});
        const h=getHealth(d.email);h.restarts++;h.stalledAt=null;
        pushGlobalEvent("force_restart",d.email,`Job reiniciado pelo admin (restart #${h.restarts})`,"info");
        addLog(d.email,{status:"sistema",jobTitle:"🔄 Job reiniciado pelo admin",company:`Restart #${h.restarts}`});
        scheduleAuto(d.email);
        return json(res,200,{ok:true,restarts:h.restarts});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN FORCE STOP JOB ─────────────────────────────────
    if(pathname==="/api/admin/force-stop"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}
        delAutoJob(d.email);
        addLog(d.email,{status:"cancelado",jobTitle:"🛑 Job parado pelo admin",company:""});
        pushGlobalEvent("force_stop",d.email,"Job parado pelo admin","info");
        return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN CRASH REPORTS ────────────────────────────────────
    if(pathname==="/api/admin/crashes"&&req.method==="GET"){
      return json(res,200,{events:GLOBAL_EVENTS,total:GLOBAL_EVENTS.length});
    }

    // ── ADMIN USER DETAIL (completo) ──────────────────────────
    if(pathname.startsWith("/api/admin/user-detail/")&&req.method==="GET"){
      const email=decodeURIComponent(pathname.replace("/api/admin/user-detail/",""));
      const u=getUser(email);if(!u)return json(res,404,{error:"Usuário não encontrado."});
      const job=getAutoJob(email);
      const h=getHealth(email);
      const hist=getHist(email);
      const logs=(DB_LOGS[email]||[]).slice(0,300);
      // Retorna histórico completo (últimos 100) para aba de histórico no admin
      const _tStr=todayStrBRT();
      const todayManualCount=hist.filter(x=>(x.dateStr||"")===_tStr&&x.type!=="auto").length;
      const todayAutoCount=hist.filter(x=>(x.dateStr||"")===_tStr&&x.type==="auto").length;
      const histRecent=hist.slice(0,100).map(h=>({
        dateStr:h.dateStr,date:h.date,sentAt:h.sentAt,
        company:h.company,to:h.to,job:h.job,
        type:h.type,profileUsed:h.profileUsed,
        attachCount:h.attachCount,category:h.category,
        state:h.state,appId:h.appId
      }));
      // Informações de saúde de PDF enriquecida
      const pdfDiag=(u.cvs||[]).map(c=>{
        const exists=fs.existsSync(cvPath(email,c.idx));
        return{idx:c.idx,name:c.name,size:c.size,date:c.date,cvType:c.cvType,onDisk:exists};
      });
      return json(res,200,{
        user:sanitizeUserForClient(u), // v21-SEC: antes vazava tokens OAuth dos senders extras

        job,health:h,
        histCount:hist.length,
        todayManual:todayManualCount,
        todayAuto:todayAutoCount,
        todayTotal:todayManualCount+todayAutoCount,
        history:histRecent,
        logs,
        sentSet:[...(DB_SENT[email]||[])].length,
        timers:autoTimers.has(email),
        pdfDiag,
        adminEmail:s.user_email
      });
    }

    // ── ADMIN: Atualizar dados do perfil do usuário ────────────
    if(pathname==="/api/admin/user/update"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});
        const upd={};
        if(d.name!==undefined)upd.name=String(d.name).slice(0,200);
        if(d.country!==undefined)upd.country=String(d.country).slice(0,100);
        if(d.phone!==undefined)upd.phone=String(d.phone).slice(0,50);
        /* cc field removed */
        if(d.city!==undefined)upd.city=String(d.city).slice(0,100);
        setUser(d.email,upd);
        console.log(`[admin] Perfil de ${d.email} editado por ${s.user_email}`);
        return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // 🚨 v237 (achado de auditoria — Alta): /api/admin/user/full-update foi
    // REMOVIDA — era uma "2ª porta" pra dias de VIP/plano/pagamento, exatamente
    // a classe de rota que mod-admin-v2.js já reconhece e documenta ter
    // removido de lá por ser perigosa (comentário no topo daquele arquivo).
    // Diferente de TODA outra rota que mexe em dias de VIP (vip/activate,
    // set-plan, vip/set-expiry), esta nunca chamava addCredito() — dias
    // dados por ela ficavam invisíveis no extrato vip.creditos e CRIAVAM
    // uma divergência de fraude FALSA (/api/admin/contabilidade flags
    // daysLeft > diasCreditadosPagos, e esses dias nunca entravam nesse
    // total); nunca chamava logAdminAction (invisível em /api/admin/audit,
    // irreversível pelo botão ↩️); não tinha nenhuma trava de duplo-clique;
    // não carimbava vip.limits (regra 13o — usuário caía na tabela legada
    // por engano). Os campos de "pagamento" (paymentAmount/paymentMethod/
    // paymentReceiver) eram 100% decorativos — nunca tocavam
    // DB_FINANCEIRO.pagamentos, nunca apareciam em Total Recebido/Sócios/
    // DRE/Conferência: um admin podia preencher "R$250 · Pix" e ver
    // ok:true achando que registrou uma entrada no caixa que nunca existiu.
    // Confirmado por grep: ZERO chamador em admin.html/app.js/smoke-test.js
    // — nenhuma tela usava isso. Quem precisa ajustar dias usa vip/set-
    // expiry (que ganhou trava de idempotência no mesmo v237); quem precisa
    // registrar pagamento usa /api/admin/contabilidade/pagamento de verdade.


    // ── ADMIN: Live endpoint retorna adminEmail ────────────────
    if(pathname==="/api/admin/settings"&&req.method==="GET"){return json(res,200,{settings:DB_ADMIN_SETTINGS,adminEmail:s.user_email});}
    if(pathname==="/api/admin/settings"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));Object.assign(DB_ADMIN_SETTINGS,d);persist(ADMIN_SETTINGS_FILE,DB_ADMIN_SETTINGS);return json(res,200,{ok:true,settings:DB_ADMIN_SETTINGS});}catch(e){return json(res,500,{error:e.message});}}
  }


  // ⚡ v190 LOTE 8 — CACHE DE 60s. Esta rota varre TODOS os usuários e TODO o
  // histórico de todos (5 reduce sobre milhares de envios), é PÚBLICA (sem
  // cookie, sem rate-limit) e a landing chama a cada 30s em CADA aba aberta —
  // inclusive de quem já está logado usando o app. Com 20 abas abertas era a
  // varredura completa do banco 40x por minuto, bloqueando o event loop de
  // todo mundo. Os números continuam REAIS, só podem estar até 60s velhos —
  // são estatísticas de vitrine, não dinheiro nem limite de ninguém.
  if(pathname==="/api/public-stats"&&req.method==="GET"){
    const agora=Date.now();
    if(_publicStatsCache && agora-_publicStatsCache.em < 60_000)
      return json(res,200,process.env.TEST_LOGIN_TOKEN?{..._publicStatsCache.dados,_calculos:_publicStatsCache.calculos}:_publicStatsCache.dados);
    // 🐛 v238-FIX (achado do dono, 20/09/2026 — "VIP ativo: 1" na landing
    // sem NENHUM cliente pago ainda): isVipActive() dá VIP infinito pro
    // admin de propósito (acesso interno sempre liberado) — mas contar
    // isso como "cliente VIP" numa vitrine pública é mentira.
    // 🚨 v238-FIX2 (achado no próprio npm test rodando este fix): a conta
    // criada pelo login por senha do painel /admin (server.js ~8163) grava
    // {email:_key,isAdmin:true} onde _key é o USUÁRIO interno ("andrio"),
    // NUNCA um e-mail real — nem isAdminEmail(chave) nem isTestAccountEmail
    // (emailContato) pegavam essa forma. isAdminVip(u) é a régua CORRETA
    // (lê u.isAdmin OU isAdminEmail(u.email) — o comentário da linha 6339
    // já documentava essa união como "todo mundo que conta como admin").
    const _usersReais=Object.entries(DB_USERS).filter(([em,u])=>!isAdminVip(u)&&!_usuarioNaoEhReceita(em,u));
    const totalUsers=_usersReais.length;
    const vipUsers=_usersReais.filter(([,u])=>isVipActive(u)).length;
    const allHist=Object.values(DB_HIST);
    // 🎨 v243 (dono, 23/09/2026 — achado num print: "Envios Hoje" e
    // "Automáticos" apareciam 0 de manhã cedo, bem do lado da venda do
    // "Robô automático 24/7" na Home, passando a impressão de robô parado).
    // "Hoje" zera todo santo dia até o 1º envio; "últimos 7 dias" só chega a
    // zero se o site inteiro ficar uma semana sem NENHUM envio — nunca
    // aconteceu em produção. Mesmo dado (DB_HIST), só a janela mudou.
    const _dias7=new Set(_ultimosDiasStr(7));
    const last7Sent=allHist.reduce((n,a)=>n+a.filter(h=>_dias7.has(h.dateStr)&&h.type!=="reply").length,0);
    const last7Auto=allHist.reduce((n,a)=>n+a.filter(h=>_dias7.has(h.dateStr)&&h.type==="auto").length,0);
    const totalSent=allHist.reduce((n,a)=>n+a.filter(h=>h.type!=="reply").length,0);
    const totalAuto=allHist.reduce((n,a)=>n+a.filter(h=>h.type==="auto").length,0);
    const legado=await _fetchStatsLegado(); // v238: histórico do site antigo, só números agregados — ver comentário da função
    const out={
      totalUsers:totalUsers+(legado?.totalUsers||0),
      vipUsers:vipUsers+(legado?.vipUsers||0),
      last7Sent,last7Auto,
      totalSent:totalSent+(legado?.totalSent||0),
      totalAuto:totalAuto+(legado?.totalAuto||0),
    };
    _publicStatsCache={em:agora,dados:out,calculos:(_publicStatsCache?.calculos||0)+1};
    // só no npm test: prova que a 2ª chamada NÃO recalculou (o nº de cálculos
    // reais fica visível no corpo, nunca em produção).
    return json(res,200,process.env.TEST_LOGIN_TOKEN?{...out,_calculos:_publicStatsCache.calculos}:out);
  }

  // ── /api/public-wage-stats — GET, sem login (SEO: página "quanto ganha quem
  // trabalha H-2B/H-2A"). Calcula médias de salário/hora REAIS a partir das
  // planilhas de vagas já carregadas em memória (v223: única fonte de vaga do
  // site, desde que o /api/jobs de busca ao vivo do DOL saiu) —
  // nunca número inventado. Só considera vagas com salário por HORA (r.wunit
  // === "h", ~98% do total); as poucas vagas mensais (ex.: pastores de ovelha)
  // ficam de fora pra não misturar unidade e distorcer a média. ─────────────
  if(pathname==="/api/public-wage-stats"&&req.method==="GET"){
    try{
      const{overall,byCategoryAll,byStateAll}=computeWageStats();
      const byCategory=byCategoryAll.slice(0,14).map(({key,label,count,avgWage})=>({key,label,count,avgWage}));
      const byState=byStateAll.slice(0,12).map(({key,label,count,avgWage,slug})=>({key,label,count,avgWage,slug}));
      return json(res,200,{ok:true,overall,byCategory,byState,source:"Planilhas públicas de certificação do Departamento do Trabalho dos EUA (DOL), mesma base usada na busca de vagas do H2BApply.",updatedAt:new Date().toISOString()});
    }catch(e){
      console.warn("[public-wage-stats] erro:",e.message);
      return json(res,200,{ok:false,overall:{count:0,avg:0,min:0,max:0},byCategory:[],byState:[]});
    }
  }


  // 🚨 v233 (achado de auditoria — Média): rota PÚBLICA sem nenhuma checagem
  // de sessão/admin — vazava total de usuários, sessões ativas, contagem de
  // jobs automáticos rodando, caminho do disco de dados e se é produção pra
  // QUALQUER um na internet (zero telas do site chamam essa rota — achado
  // confirmado: nenhuma referência em app.js/admin.html/index.html). Mesma
  // trava da irmã /api/debug/export (admin hardcoded).
  if(pathname==="/api/debug"){
    const s=getSess(req);if(!s?.user_email||!isAdminEmail(_sessAdminEmail(s)))return json(res,403,{error:"Acesso negado."});
    return json(res,200,{version:"13.1",app_url:APP_URL,configured:CONFIGURED,sessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,disk:fs.existsSync("/data"),data_dir:DATA_DIR,total_users:Object.keys(DB_USERS).length,sheet_jan:SHEET_JAN.length,sheet_jul:SHEET_JUL.length,active_auto:Object.values(DB_AUTO).filter(j=>j.active).length,is_prod:IS_PROD});
  }

  if(pathname==="/api/my-message"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const p=getUser(s.user_email)||{};if(p.adminMessage){const m=p.adminMessage;setUser(s.user_email,{adminMessage:null});return json(res,200,{message:m});}return json(res,200,{message:null});}

  // 🚫 v195 LOTE 14: o /proxy foi REMOVIDO. Era um proxy ABERTO pra
  // seasonaljobs.dol.gov — qualquer método, qualquer corpo, sem sessão, sem
  // rate-limit e com access-control-allow-origin:* —, usando o IP do NOSSO
  // servidor. Nenhuma tela do site chamava. Não recriar.
  // 🚫 v223 (ordem do dono, 20/09/2026 — "não quero mais dados ao vivo do
  // dol, a partir de agora só planilhas"): as rotas que substituíam o proxy
  // (/api/jobs, /api/sheet-detail, /api/sheet-batch) saíram JUNTO — o site
  // não faz mais NENHUMA consulta em tempo real à API do DOL. O que ele
  // precisa do DOL vem só dos robôs de coleta periódica de planilha
  // (mod-planilhas.js, feed ZIP — mecanismo separado, continua existindo).

  // ── AVALIAÇÕES REAIS DE USUÁRIOS (landing page) ─────────────────────────
  // Substitui os depoimentos fixos/fictícios da landing por avaliações reais,
  // enviadas por usuários autenticados e moderadas por admin antes de ir ao ar
  // (evita spam/abuso e conteúdo impróprio aparecendo direto na home pública).
  if(pathname==="/api/reviews" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    if(rateLimit(s.user_email+"_review",3,86400_000)) return json(res,429,{error:"Muitas avaliações enviadas. Tente novamente amanhã."});
    try{
      const d=JSON.parse(await readBody(req));
      const text=(d.text||"").trim();
      const rating=Math.round(Number(d.rating));
      const location=(d.location||"").trim().slice(0,60);
      const p=getUser(s.user_email)||{};
      const fallbackName=(p.name||s.user_name||"Usuário").trim().split(/\s+/)[0]||"Usuário";
      let displayName=(d.displayName||"").trim().slice(0,40);
      if(!displayName) displayName=fallbackName;
      if(!text||text.length<15) return json(res,400,{error:"Conte um pouco mais — mínimo 15 caracteres."});
      if(text.length>600) return json(res,400,{error:"Avaliação muito longa. Máximo 600 caracteres."});
      if(!Number.isFinite(rating)||rating<1||rating>5) return json(res,400,{error:"Escolha uma nota de 1 a 5 estrelas."});
      const review={
        id:"rev_"+Date.now()+"_"+crypto.randomBytes(3).toString("hex"),
        text, rating, displayName, location,
        email:s.user_email,
        plan:p.plan||"free",
        status:"pending", // pending | approved | rejected
        createdAt:new Date().toISOString(),
      };
      if(!Array.isArray(DB_REVIEWS)) DB_REVIEWS=[];
      DB_REVIEWS.unshift(review);
      if(DB_REVIEWS.length>2000) DB_REVIEWS=DB_REVIEWS.slice(0,2000);
      persist(REVIEWS_FILE, DB_REVIEWS);
      console.log(`[review] ${s.user_email} (${rating}★): "${text.slice(0,60)}..."`);
      return json(res,200,{ok:true,id:review.id});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // Usuário logado vê o status das próprias avaliações enviadas
  if(pathname==="/api/reviews/mine" && req.method==="GET"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const mine=(DB_REVIEWS||[]).filter(r=>r.email===s.user_email).slice(0,20)
      .map(r=>({id:r.id,text:r.text,rating:r.rating,displayName:r.displayName,location:r.location,status:r.status,createdAt:r.createdAt}));
    return json(res,200,{ok:true,reviews:mine});
  }

  // Público (landing page, sem autenticação): só avaliações aprovadas, sem e-mail/plano
  if(pathname==="/api/reviews/public" && req.method==="GET"){
    const approved=(DB_REVIEWS||[]).filter(r=>r.status==="approved");
    const list=approved.slice(0,24)
      .map(r=>({id:r.id,text:r.text,rating:r.rating,displayName:r.displayName,location:r.location,createdAt:r.createdAt}));
    // v18-SEO: totalApproved (contagem REAL, sem o corte de 24) alimenta o
    // aggregateRating (reviewCount) na landing — precisa refletir o total de
    // verdade, não só quantas cabem na grade visível, senão o schema.org fica
    // incorreto (Google exige que reviewCount reflita as avaliações reais).
    const avgRating=approved.length?+(approved.reduce((s,r)=>s+(r.rating||5),0)/approved.length).toFixed(2):0;
    return json(res,200,{ok:true,reviews:list,count:list.length,totalApproved:approved.length,avgRating});
  }

  // Admin: lista todas (default = pendentes) para moderação
  if(pathname==="/api/admin/reviews" && req.method==="GET"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email)||{};
    if(!p.isAdmin && !isAdminEmail(_sessAdminEmail(s))) return json(res,403,{error:"Acesso negado"});
    const filter=(u.searchParams.get("status")||"pending").trim();
    const list=filter==="all" ? (DB_REVIEWS||[]) : (DB_REVIEWS||[]).filter(r=>r.status===filter);
    const counts={pending:0,approved:0,rejected:0};
    for(const r of (DB_REVIEWS||[])) if(counts[r.status]!==undefined) counts[r.status]++;
    return json(res,200,{ok:true,reviews:list.slice(0,300),counts});
  }

  // Admin: aprova/rejeita/exclui uma avaliação
  if(pathname==="/api/admin/reviews/status" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email)||{};
    if(!p.isAdmin && !isAdminEmail(_sessAdminEmail(s))) return json(res,403,{error:"Acesso negado"});
    try{
      const d=JSON.parse(await readBody(req));
      if(d.action==="delete"){
        DB_REVIEWS=(DB_REVIEWS||[]).filter(r=>r.id!==d.id);
        persist(REVIEWS_FILE, DB_REVIEWS);
        return json(res,200,{ok:true,deleted:true});
      }
      const rev=(DB_REVIEWS||[]).find(x=>x.id===d.id);
      if(!rev) return json(res,404,{error:"Avaliação não encontrada"});
      if(!["approved","rejected","pending"].includes(d.status)) return json(res,400,{error:"Status inválido"});
      rev.status=d.status;
      rev.reviewedAt=new Date().toISOString();
      rev.reviewedBy=s.user_email;
      persist(REVIEWS_FILE, DB_REVIEWS);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── SISTEMA DE INDICAÇÃO REMOVIDO DEFINITIVAMENTE (2026-07-03, KB-059) ──
  // Motivo: uso de má fé (abuso do programa de bônus). Removidos: genRefCode,
  // getOrCreateRefCode, GET /api/referral/info, GET /api/admin/referral/list,
  // bônus de cadastro (OAuth callback) e bônus de compra (/api/pedido + set-plan).
  // Rotas antigas respondem 410 Gone para clientes/PWAs com cache antigo:
  if(pathname.startsWith("/api/referral") || pathname.startsWith("/api/admin/referral")){
    return json(res,410,{error:"O programa de indicação foi encerrado."});
  }

  res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"404"}));
});

// 🎯 v178 (dono, 14/09/2026 — "não vai ter correção de pedidos... o valor
// não bate, simplesmente não vai ter que alterar nada, esse cadastro vai
// ter que ser excluído, vai ter que ser criado um novo pelo usuário"):
// fonte ÚNICA de cancelamento de pedido — usada pela rota PATCH (admin
// manual) E pelo auto-cancelamento por divergência de valor que a IA
// detecta (preCheckComprovante/_autoCancelarSeDivergente, mais abaixo).
// Extraída do corpo antigo do branch status==="cancelado" pra nunca
// duplicar esta lógica (caixa, estorno de dias, revogação de provisório).
// 🐛 v178-FIX: nasceu por engano DENTRO do callback do http.createServer
// (função aninhada, só existia durante 1 requisição) — preCheckComprovante
// chamava ela de FORA desse escopo e o ReferenceError morria em silêncio
// dentro do .catch(()=>{}) do fire-and-forget, então NENHUM pedido
// divergente era cancelado de verdade. Precisa estar no escopo do MÓDULO
// (aqui, fora do createServer) pra ser visível dos dois lados.
function _cancelarPedidoInterno(pd,opts){
  const {por,notaAdmin}=opts||{};
  // GUARD DUPLO CANCELAMENTO: sem isso, clicar cancelar 2x no mesmo pedido
  // — ou 2 admins cancelando quase junto, ou o auto-cancelamento correndo
  // com uma ação manual — estornava dias de VIP DUAS VEZES.
  if(pd.canceladoEm){
    return {ok:false,status:409,body:{error:`⛔ Este pedido JÁ FOI CANCELADO por ${pd.canceladoPor||"o outro editor"} em ${new Date(pd.canceladoEm).toLocaleString("pt-BR")}. Não dá pra cancelar de novo (evita estornar os dias duas vezes).`,jaCancelado:true,canceladoPor:pd.canceladoPor,canceladoEm:pd.canceladoEm}};
  }
  pd.canceladoPor=por||"sistema";pd.canceladoEm=Date.now();pd.status="cancelado";
  if(notaAdmin)pd.notaAdmin=notaAdmin;
  // ── 🧾 MC5-P6: o caixa NUNCA apaga — cancelamento vira AJUSTE− ─────────
  const _pagsVivas=(DB_FINANCEIRO.pagamentos||[]).filter(x=>x&&x.pedidoId===pd.id&&x.tipo!=="ajuste"&&!x.anuladoPor);
  if(_pagsVivas.length){
    try{
      const _nAnul=_anularNoCaixa(pd.id,true,por||"sistema","CANCEL-"+pd.id.slice(-8).toUpperCase(),
        "Pedido #"+pd.id.slice(-8).toUpperCase()+" cancelado"+(notaAdmin?" — "+String(notaAdmin).slice(0,120):"")+" (entrada anulada por AJUSTE — o caixa nunca apaga)");
      console.log(`[financeiro] pedido ${pd.id} cancelado — ${_nAnul} entrada(s) ANULADA(S) por AJUSTE− (original preservado no caixa)`);
    }catch(eA){console.error("[financeiro] anular caixa do cancelado:",eA.message);}
  }
  // ── Estorno de DIAS: os dias SEGUEM o pedido ───────────────────────────
  if(pd.ativadoEm&&(pd.diasTotal||0)>0){
    const tgtC=getUser(pd.userEmail);
    if(tgtC&&tgtC.vip&&["payment","pago"].includes(String(tgtC.vip.source||""))){
      const DAYc=86400_000;
      const v={...tgtC.vip};
      if((v.manualExpires||0)>0)v.manualExpires=v.manualExpires-pd.diasTotal*DAYc;
      if(["vipro","doublepro"].includes(pd.plano)&&(v.autoExpires||0)>0)v.autoExpires=v.autoExpires-pd.diasTotal*DAYc;
      v.note=(String(v.note||"")+" · estorno "+pd.diasTotal+"d (pedido #"+pd.id.slice(-8).toUpperCase()+" cancelado)").slice(-220);
      setUser(pd.userEmail,{vip:v});
      // 🚨 v177-FIX2 (auditoria 14/09/2026): o estorno mexia direto em
      // manualExpires/autoExpires sem registrar no extrato vip.creditos —
      // o crédito original (+N dias, gravado na ativação) ficava pra sempre
      // no extrato como se os dias ainda estivessem concedidos. addCredito
      // aceita dias negativo (única checagem é dias===0) — mesma política
      // "nunca apaga, só soma" já usada no caixa (AJUSTE−) pro estorno.
      addCredito(pd.userEmail,{dias:-pd.diasTotal,tipo:"pago",origem:"estorno",
        motivo:`Estorno — pedido #${pd.id.slice(-8).toUpperCase()} cancelado`,
        dadoPor:por||"sistema",pedidoId:pd.id});
      console.log(`[pedido] ${pd.id} cancelado — estornados ${pd.diasTotal}d de VIP de ${pd.userEmail}`);
    }
  }
  // ── Revogação da ativação PROVISÓRIA (o robô liberou pelo comprovante,
  // mas o pedido caiu — fraude, engano, ou valor divergente) ────────────
  if(pd.autoAtivado&&!pd.ativadoEm){
    const tgtP=getUser(pd.userEmail);
    if(tgtP&&tgtP.vip&&tgtP.vip.source==="auto-provisorio"&&tgtP.vip.pedidoId===pd.id){
      const agora=Date.now();
      setUser(pd.userEmail,{plan:"free",vip:{...tgtP.vip,active:false,
        manualExpires:Math.min(tgtP.vip.manualExpires||0,agora),
        autoExpires:Math.min(tgtP.vip.autoExpires||0,agora),
        note:(String(tgtP.vip.note||"")+" · ⛔ provisório revogado (pedido cancelado)").slice(-220)}});
      addLog(pd.userEmail,{status:"sistema",
        jobTitle:"⛔ Ativação provisória revogada — pedido cancelado",
        company:`Pedido #${pd.id.slice(-8).toUpperCase()}`});
      console.log(`[auto-ativa] ⛔ provisório de ${pd.userEmail} revogado (pedido ${pd.id} cancelado)`);
    }
  }
  persistPedidos();
  return {ok:true};
}

// ── Cleanup ───────────────────────────────────────────────
setInterval(()=>{const n=Date.now();let c=0;Object.keys(sessions).forEach(k=>{const s=sessions[k],a=n-(s.ts||s.created_at||0),
  // 🚨 v177-FIX (auditoria 14/09/2026): isAdminEmail(_sessAdminEmail(s)) checava
  // só o e-mail — pra uma conta admin nascida por /api/cadastro (username
  // reservado, v175/v176), sessions[sid].user_email é o USERNAME ("andrio"),
  // nunca bate em isAdminEmail, e a sessão caía no SESS_TTL de 7 dias em vez
  // do ADMIN_SESS_TTL de 24h — reabrindo a janela de exposição que o
  // ADMIN_SESS_TTL foi criado pra fechar, justo no login mais comum do
  // próprio admin. isAdminVip(getUser(...)) cobre os 2 formatos de conta.
  ttl=(!s.pending&&isAdminVip(getUser(s.user_email)))?ADMIN_SESS_TTL:SESS_TTL;if((s.pending&&a>600_000)||(!s.pending&&a>ttl)){delete sessions[k];c++;}});if(c)console.log(`[cleanup] ${c} sessão(ões)`);persistSessionsDebounced(1000); // V955: snapshot periódico (captura refresh de tokens)
// v21-FIX: a limpeza do rateMap abaixo estava GRUDADA no comentário da linha
// acima desde a V955 — virou comentário e NUNCA rodou: o mapa de rate-limit
// acumulava uma entrada por usuário×ação pra sempre (vazamento lento de RAM).
Object.keys(rateMap).forEach(k=>{if(rateMap[k].r<n)delete rateMap[k];});
// Limpa locks de send órfãos (>30s)
_manualSendInFlight.forEach((ts,k)=>{if(n-ts>30000)_manualSendInFlight.delete(k);});
_autoStartInFlight.forEach((ts,k)=>{if(n-ts>60000)_autoStartInFlight.delete(k);});},300_000);
// BUG-001 CORRIGIDO: cron VIP agora suporta schema novo (manualExpires/autoExpires) E schema legado (expiresAt)
setInterval(()=>{
  let n=0;
  const now=Date.now();
  Object.entries(DB_USERS).forEach(([e,u])=>{
    if(!u.vip?.active) return;
    // Schema novo: verifica manualExpires e autoExpires independentemente
    const manualOk = u.vip.manualExpires && now < u.vip.manualExpires;
    const autoOk   = u.vip.autoExpires   && now < u.vip.autoExpires;
    // Schema legado: expiresAt sem campos novos preenchidos
    const legacyOk = u.vip.expiresAt && now < u.vip.expiresAt && !u.vip.manualExpires && !u.vip.autoExpires;
    if(!manualOk && !autoOk && !legacyOk){
      DB_USERS[e]={...u,vip:{...u.vip,active:false},plan:"free"};
      n++;
      if(autoTimers.has(e)){clearTimeout(autoTimers.get(e));autoTimers.delete(e);}
      console.log(`[vip] expirado: ${e} (manual:${u.vip.manualExpires||0} auto:${u.vip.autoExpires||0} legacy:${u.vip.expiresAt||0})`);
    }
  });
  if(n){persist(USERS_FILE,DB_USERS);console.log(`[vip] ${n} expirado(s) total`);}
},3600_000);

// FIX-CRASH: Monitor de memória — loga a cada 10min e alerta se estiver alto
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB  = Math.round(mem.rss / 1024 / 1024);
  if (heapMB > 400) {
    console.warn(`[mem] ⚠️ Heap alto: ${heapMB}MB RSS: ${rssMB}MB — users:${Object.keys(DB_USERS).length} logs:${Object.values(DB_LOGS).reduce((n,a)=>n+a.length,0)} hist:${Object.values(DB_HIST).reduce((n,a)=>n+a.length,0)}`);
    // Limpa cache de inbox expirado
    if (global._inboxCache) {
      const now = Date.now();
      for (const k of Object.keys(global._inboxCache)) {
        if (now - global._inboxCache[k].ts > 2 * 60_000) delete global._inboxCache[k];
      }
    }
  } else {
    console.log(`[mem] Heap: ${heapMB}MB RSS: ${rssMB}MB`);
  }
}, 10 * 60 * 1000);

// ══════════════════════════════════════════════════════════
//  NOTIFICAÇÕES AUTOMÁTICAS POR EMAIL — H2BApply
//  Avisa o usuário quando fila trava ou finaliza
//  Usa Gmail do admin (ADMIN_EMAIL — hoje andrio.usa2026@gmail.com)
//  25+ variações de mensagem para nunca repetir
// ══════════════════════════════════════════════════════════

// V951: carrega cooldowns persistidos (se existirem) ANTES de criar os
// objetos em memória — assim eles nascem já com o histórico de quando a
// última notificação de cada tipo foi enviada, mesmo após um deploy.
let _DB_NOTIF_COOLDOWN = { notifSentAt:{}, authErrNotifiedAt:{}, pedAlertSent:{}, refillNotifiedAt:{} };
try{
  if(fs.existsSync(NOTIF_COOLDOWN_FILE)){
    const _loaded = JSON.parse(fs.readFileSync(NOTIF_COOLDOWN_FILE,"utf8"));
    _DB_NOTIF_COOLDOWN = { ..._DB_NOTIF_COOLDOWN, ..._loaded };
  }
}catch(e){ console.warn("[notif-cooldown] falha ao carregar cooldowns persistidos:", e.message); }
function _persistNotifCooldowns(){
  if(_gravacoesCongeladas) return; // ❄️ v191 LOTE 9: escrita direta (não passa por persist) — o restore também congela esta
  try{
    _DB_NOTIF_COOLDOWN.notifSentAt = _notifSentAt;
    _DB_NOTIF_COOLDOWN.authErrNotifiedAt = (typeof getAuthErrNotifiedAt==="function") ? getAuthErrNotifiedAt() : (_DB_NOTIF_COOLDOWN.authErrNotifiedAt||{});
    _DB_NOTIF_COOLDOWN.pedAlertSent = (typeof getPedAlertSent==="function") ? getPedAlertSent() : (_DB_NOTIF_COOLDOWN.pedAlertSent||{});
    _DB_NOTIF_COOLDOWN.refillNotifiedAt = global._refillNotifiedAt||{};
    fs.writeFileSync(NOTIF_COOLDOWN_FILE, JSON.stringify(_DB_NOTIF_COOLDOWN));
  }catch(e){ console.warn("[notif-cooldown] falha ao salvar cooldowns:", e.message); }
}
setInterval(_persistNotifCooldowns, 5*60*1000); // salva a cada 5min (não só no shutdown — Render pode matar sem SIGTERM)
global._refillNotifiedAt = _DB_NOTIF_COOLDOWN.refillNotifiedAt; // usado por mod-sentinel.js (re-engajamento)

const _notifSentAt = _DB_NOTIF_COOLDOWN.notifSentAt; // email → {stalled: ts, finished: ts} — evita spam

// Estado de saúde por usuário
const healthState = new Map(); // email → { lastSent, lastCheck, restarts, errors, status }
const GLOBAL_EVENTS = []; // crash reports e eventos críticos globais (max 500)
const STALL_THRESHOLD = 20 * 60 * 1000; // 20min sem envio = travada
const WATCHDOG_INTERVAL = 2 * 60 * 1000; // checa a cada 2min


function getHealth(email) {
  if (!healthState.has(email)) healthState.set(email, { lastSent:0, lastCheck:0, restarts:0, errors:0, status:"ok", lastError:"", oauthOk:null, gmailOk:null, hasPdf:null, stalledAt:null });
  return healthState.get(email);
}
// 🩹 v240 (achado real, 22/09/2026 — 2º alerta de OOM do Render, 512MB):
// healthState cresce PRA SEMPRE — 1 entrada por e-mail que já passou por
// getHealth() (envio manual, watchdog, painel admin — 10+ pontos de
// chamada) e NENHUM deles jamais dava .delete(). Poda periódica (mesmo
// padrão/cadência da faxina do DB_SENT, 6h): nunca mexe em quem tem
// automático rodando AGORA nem em quem foi tocado nos últimos 90 dias —
// só limpa conta deletada ou realmente parada há muito tempo.
setInterval(() => {
  let removidos = 0;
  for (const [email, h] of healthState) {
    const u = getUser(email);
    if (!u) { healthState.delete(email); removidos++; continue; }
    const job = getAutoJob(email);
    if (job?.active) continue;
    const ultimoToque = Math.max(h.lastCheck || 0, h.lastSent || 0);
    if (ultimoToque && (Date.now() - ultimoToque) > 90 * 86400_000) { healthState.delete(email); removidos++; }
  }
  if (removidos) console.log(`[mem-clean] healthState: ${removidos} entrada(s) antiga(s) removida(s)`);
}, 6 * 60 * 60 * 1000);

function pushGlobalEvent(type, email, msg, level="warn") {
  GLOBAL_EVENTS.unshift({ ts:Date.now(), date:toLocaleBRT(Date.now()), type, email, msg, level });
  if(GLOBAL_EVENTS.length>500) GLOBAL_EVENTS.length=500;
  console.log(`[watchdog/${level}] ${email||"global"}: ${msg}`);
}

// Diagnóstico completo de um job ativo
async function diagnoseJob(email) {
  const job = getAutoJob(email);
  const user = getUser(email);
  const h = getHealth(email);
  if (!job || !job.active) return;

  const now = Date.now();
  h.lastCheck = now;

  // 1. Checa PDF/CV
  const hasPdf = (user?.cvs||[]).some(c => loadCv(email, c.idx));
  if (!hasPdf && h.hasPdf !== false) {
    h.hasPdf = false;
    addLog(email, { status:"sistema", jobTitle:"⚠️ PDF do currículo não encontrado", company:"Watchdog detectou: faça upload do currículo novamente", error:"PDF ausente" });
    pushGlobalEvent("no_pdf", email, "PDF do currículo não encontrado — envio automático pode falhar", "warn");
  } else { h.hasPdf = true; }

  // 2. Checa OAuth/token — só age se usuário ativo nos últimos 10 dias
  const hasToken = !!(user?.refresh_token || user?.cached_access_token);
  if (!hasToken && h.oauthOk !== false) {
    const lastSeen = user?.lastSeenAt || new Date(user?.created_at||0).getTime();
    const inactiveDays = (Date.now() - lastSeen) / 86400000;
    if (inactiveDays > 10) {
      // Usuário inativo >10 dias: pausa silenciosa sem log ruidoso, sem notif
      h.oauthOk = false;
      setAutoJob(email, { ...job, active:false, status:"paused_oauth_expired" });
      autoTimers.delete(email);
      console.log(`[watchdog] ${email} token inválido mas inativo ${Math.round(inactiveDays)}d — pausa silenciosa`);
      return;
    }
    // Usuário ativo: alerta real
    h.oauthOk = false;
    addLog(email, { status:"pausado", jobTitle:"🔐 Autenticação expirada", company:"Vigia: reconecte seu Gmail em Envio Automático → Conectar meu Gmail pra retomar o envio automático", error:"Sem refresh_token" });
    pushGlobalEvent("oauth_invalid", email, "Autenticação expirada — automático pausado", "error");
    setAutoJob(email, { ...job, active:false, status:"paused_oauth_expired" });
    autoTimers.delete(email);
    return;
  }
  h.oauthOk = true;

  // 3. Checa fila travada (ativo mas sem progresso há STALL_THRESHOLD)
  // ⚠️ NUNCA marcar como stalled se está aguardando limite/horário/rate-limit — são esperas normais
  const WAITING_STATUSES = new Set(["waiting_limit","waiting_rate_limit","waiting_interval"]);
  const lastActivity = job.lastSentAt || job.startedAt || 0;
  const stalledMs = now - lastActivity;
  const isStalled = job.active && job.queue?.length > 0 && stalledMs > STALL_THRESHOLD
    && !WAITING_STATUSES.has(job.status)  // não é espera normal
    && !(job.nextSendAt && job.nextSendAt > now); // não tem próximo envio agendado

  if (isStalled) {
    const mins = Math.round(stalledMs / 60000);
    if (!h.stalledAt) {
      h.stalledAt = now;
      pushGlobalEvent("stalled", email, `Fila travada há ${mins} minutos — tentando reiniciar`, "warn");
      addLog(email, { status:"sistema", jobTitle:`🔄 Fila travada há ${mins}min — reiniciando worker`, company:"Watchdog auto recovery", error:"Worker não respondia" });
    }
    // Auto recovery: reinicia o timer se não há timer ativo
    if (!autoTimers.has(email)) {
      h.restarts++;
      h.stalledAt = null;
      pushGlobalEvent("recovery", email, `Worker reiniciado automaticamente (restart #${h.restarts})`, "info");
      addLog(email, { status:"sistema", jobTitle:`✅ Worker reiniciado automaticamente (#${h.restarts})`, company:"Watchdog recovery" });
      scheduleAuto(email);
    }
  } else if (h.stalledAt) {
    h.stalledAt = null; // fila voltou a andar
  }

  // 4. Checa timer morto: job ativo mas sem timer scheduled e sem nextSendAt futuro
  const timerMissing = job.active && job.queue?.length > 0 && !autoTimers.has(email);
  const nextOk = job.nextSendAt && job.nextSendAt > now;
  if (timerMissing && !nextOk && !isStalled) {
    h.restarts++;
    pushGlobalEvent("dead_timer", email, `Timer morto detectado — reagendando (restart #${h.restarts})`, "warn");
    addLog(email, { status:"sistema", jobTitle:`🔄 Timer morto detectado — reagendando worker`, company:"Watchdog" });
    scheduleAuto(email);
  }

  // 5. Checa timer fantasma: nextSendAt já passou há mais de 10min mas timer ainda existe
  // Isso ocorre quando o Node.js event loop ficou travado — o setTimeout existe mas não disparou
  const nextOverdue = job.nextSendAt && job.nextSendAt < now - 10*60*1000;
  const hasTimer = autoTimers.has(email);
  const notWaitingNormal = !["waiting_limit","waiting_rate_limit"].includes(job.status);
  if (nextOverdue && hasTimer && notWaitingNormal && !isStalled) {
    clearTimeout(autoTimers.get(email));
    autoTimers.delete(email);
    h.restarts++;
    pushGlobalEvent("ghost_timer", email, `Timer fantasma detectado (nextSendAt passou há ${Math.round((now-job.nextSendAt)/60000)}min) — reiniciando (restart #${h.restarts})`, "warn");
    addLog(email, { status:"sistema", jobTitle:`🔄 Timer atrasado — reagendando worker`, company:"Watchdog" });
    scheduleAuto(email);
  }

  // 6. Checa parada absoluta: ativo há mais de 4h sem nenhum envio
  // Cobre casos onde nextSendAt está no futuro mas o timer nunca vai disparar
  // EXCEÇÃO: waiting_limit e waiting_rate_limit são esperas longas normais
  const ABSOLUTE_STALL_MS = 4 * 60 * 60 * 1000; // 4 horas
  const lastAct = job.lastSentAt || job.startedAt || 0;
  const absoluteStalled = lastAct > 0 && (now - lastAct) > ABSOLUTE_STALL_MS;
  const isLongWait = ["waiting_limit","waiting_rate_limit"].includes(job.status);
  if (absoluteStalled && !isLongWait) {
    // Força reinício total: cancela timer existente e reagenda
    if (autoTimers.has(email)) {
      clearTimeout(autoTimers.get(email));
      autoTimers.delete(email);
    }
    h.restarts++;
    const hrsStalled = Math.round((now - lastAct) / 3600000);
    pushGlobalEvent("absolute_stall", email, `Sem envios há ${hrsStalled}h (status: ${job.status}) — forçando reinício (restart #${h.restarts})`, "error");
    addLog(email, { status:"sistema", jobTitle:`🔄 Sem atividade há ${hrsStalled}h — reiniciando worker`, company:"Watchdog forçou reinício" });
    scheduleAuto(email);
  }

  h.status = "ok";
}

// Watchdog global: roda a cada 2min
setInterval(async () => {
  const activeJobs = Object.entries(DB_AUTO).filter(([,j]) => j.active); // v184 LOTE 2: fila vazia aguardando refill também precisa de diagnóstico
  for (const [email] of activeJobs) {
    try { await diagnoseJob(email); } catch(e) { console.error(`[watchdog] erro em ${email}:`, e.message); }
  }
  // Detecta jobs marcados active=true mas sem timer E sem nextSendAt — orphans pós-crash
  const now = Date.now();
  // 🚨 v237 (achado de auditoria — Alta, gmail-envio): este loop (e os 2
  // setInterval logo abaixo, stuck-guard e daily-reset) não tinham try/catch
  // por iteração — diferente do loop de diagnoseJob() acima, que já protegia
  // cada usuário. Um único job em DB_AUTO com formato que faça scheduleAuto
  // (ou getHealth/getAutoJob/addLog) lançar exceção síncrona interrompia o
  // for-loop NAQUELE ponto: nenhum usuário processado DEPOIS do registro
  // corrompido (na ordem de Object.entries) era verificado/recuperado NESSE
  // ciclo — e como a ordem é estável, o MESMO usuário corrompido quebrava o
  // loop em TODO ciclo seguinte, pra sempre, transformando a própria rede de
  // segurança contra "fila travada sem avisar ninguém" num ponto único de
  // falha capaz de travar a recuperação automática de TODOS os usuários.
  for (const [email, job] of Object.entries(DB_AUTO)) {
    try {
      // v184 LOTE 2: job ativo com fila VAZIA (esperando o refill de ~7min) é
      // estado normal — e era justamente quem ficava órfão pra sempre depois de
      // um restart. Quem decide é o nextOk abaixo, como já era pro resto.
      if (!job.active) continue;
      if (!autoTimers.has(email)) {
        const nextOk = job.nextSendAt && job.nextSendAt > now && (job.nextSendAt - now) < 6*3600_000;
        if (!nextOk) {
          const h = getHealth(email);
          h.restarts++;
          pushGlobalEvent("orphan_recovery", email, `Job órfão pós-crash recuperado (restart #${h.restarts})`, "info");
          addLog(email, { status:"sistema", jobTitle:"✅ Queue restaurada após crash", company:"Watchdog recovery pós-reinício" });
          scheduleAuto(email);
        }
      }
    } catch(e) { console.error(`[watchdog:orphan_recovery] erro em ${email}:`, e.message); }
  }
}, WATCHDOG_INTERVAL);

// Detecta status "sending" preso por >30min (lock liberado mas status não atualizado)
setInterval(()=>{
  const now=Date.now();
  // 🚨 v237: mesma proteção do orphan_recovery acima — try/catch por
  // iteração, nunca deixar 1 job corrompido travar a recuperação dos outros.
  for(const[email,job] of Object.entries(DB_AUTO)){
    try {
      if(!job.active||job.status!=="sending") continue;
      const lastAct=job.lastSentAt||job.startedAt||0;
      if(lastAct>0&&(now-lastAct)>30*60*1000&&!autoSendLock.has(email)){
        console.warn(`[stuck-guard] ${email}: sending preso ${Math.round((now-lastAct)/60000)}min — reiniciando`);
        addLog(email,{status:"sistema",jobTitle:"🔄 Status 'sending' travado — reiniciando",company:"Stuck guardian"});
        if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
        scheduleAuto(email);
      }
    } catch(e) { console.error(`[stuck-guard] erro em ${email}:`, e.message); }
  }
},5*60*1000);

// ══════════════════════════════════════════════════════════
//  DAILY RESET GUARDIAN — Garante que jobs em waiting_limit
//  sejam retomados no próximo dia, mesmo após crashes/deploys
//  Roda a cada 5 minutos e verifica se nextSendAt já passou
// ══════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  let resumed = 0;
  // 🚨 v237: mesma proteção dos 2 watchdogs acima.
  for (const [email, job] of Object.entries(DB_AUTO)) {
    try {
      if (!job.active || !job.queue?.length) continue;
      if (job.status !== "waiting_limit") continue;
      // Se nextSendAt já passou e não há timer ativo, retoma imediatamente
      const nextPassed = !job.nextSendAt || job.nextSendAt <= now;
      const noTimer = !autoTimers.has(email);
      if (nextPassed && noTimer) {
        const h = getHealth(email);
        h.restarts++;
        console.log(`[daily-reset] ${email} — limite expirou, retomando envios (restart #${h.restarts})`);
        addLog(email, { status:"sistema", jobTitle:"🔄 Novo dia — retomando envios automáticos", company:`Fila: ${job.queue.length} vagas restantes` });
        scheduleAuto(email);
        resumed++;
      }
    } catch(e) { console.error(`[daily-reset] erro em ${email}:`, e.message); }
  }
  if (resumed > 0) console.log(`[daily-reset] ${resumed} job(s) retomados após reset diário`);
}, 5 * 60 * 1000); // checa a cada 5min

// Heartbeat: atualiza lastSent quando auto envia com sucesso
// (hook no addLog existente — detecta status "enviado")
const _origAddLog = addLog;
// Patch addLog para atualizar heartbeat
const _addLogPatched = function(userEmail, entry) {
  _origAddLog(userEmail, entry);
  if (entry.status === "enviado") {
    const h = getHealth(userEmail);
    h.lastSent = Date.now();
    h.errors = 0;
    h.stalledAt = null;
  }
  if (entry.status === "falhou") {
    const h = getHealth(userEmail);
    h.errors = (h.errors||0) + 1;
    h.lastError = entry.error || "Erro desconhecido";
    if (h.errors >= 5) {
      pushGlobalEvent("too_many_errors", userEmail, `${h.errors} falhas consecutivas: ${h.lastError}`, "error");
    }
  }
};
// Nota: _addLogPatched foi definido acima mas o heartbeat já está embutido
// diretamente em doAutoSend (linha "h.lastSent=Date.now()") — sem duplicação.

// Admin: endpoint live monitor
// Injetado nos handlers de /api/admin


// 🔕 v-2026: Notificações (push/e-mail) AO USUÁRIO foram removidas nesta
// reconstrução (v175: os únicos e-mails que saem do sistema são os da conta
// de notificações — código de cadastro, código de senha e aviso de pedido
// aos admins — ver mod-notif.js; sendNotifEmail continua no-op de propósito).
// sendNotifEmail/pushToUser continuam existindo como stubs inertes só porque
// watchdogs/sentinel/admin-health ainda recebem essas 2 funções por injeção
// de dependência — automático/doações continuam 100% funcionais, só o AVISO
// ao usuário fica silencioso (não existe mais canal nenhum pra entregá-lo).
async function sendNotifEmail(){}
async function pushToUser(){}

// ══════════════════════════════════════════════════════════
//  🐕 WATCHDOGS — extraídos para src/watchdogs.js (Fase 1 · Módulo 4)
//  tokenGuardian (renova tokens 10/10min) · authErrorWatchdog (notifica
//  parados >12h, 3/3h)
// ══════════════════════════════════════════════════════════
const { initWatchdogs } = require("./mod-watchdogs.js");
const { getAuthErrNotifiedAt } = initWatchdogs({
  DB_AUTO: ()=>DB_AUTO, autoTimers: ()=>autoTimers,
  getUser, getAutoJob, setAutoJob, addLog, sendNotifEmail, refreshTokenForUser,
  authErrNotifiedAtInit: _DB_NOTIF_COOLDOWN.authErrNotifiedAt, // V951: sobrevive a deploy
  botLog, // 📜 log unificado — pedido do dono (07/07/2026)
  // v18-FIX: canal de push como FALLBACK — sendNotifEmail está 100% bloqueado
  // pela chave DB_ADMIN_SETTINGS.emailNotificationsEnabled=false (decisão do
  // dono, 06/07/2026, intocada aqui). Sem um canal alternativo, usuário pagante
  // com robô travado ficava sem NENHUM aviso, em NENHUM canal. Push é um canal
  // separado (não passa pelo kill-switch de e-mail) — não contorna a decisão
  // do dono, só usa o canal que sobrou ligado.
  pushToUser,
});

// ══════════════════════════════════════════════════════════
//  FUNÇÕES UTILITÁRIAS GLOBAIS (stats, ranking)
//  Movidas para escopo global para reutilização entre rotas
// ══════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════
//  SISTEMA DE PEDIDOS DE PLANO
//  Usuário solicita → admin revisa e ativa
// ════════════════════════════════════════════════════════════
// FIX (2026-07-08, a pedido do Andrio — "você garante que toda edição fica
// salva?"): antes essas duas funções tinham escrita própria, simples, SEM
// retry e SEM SQLite — mais fraca que o resto do sistema (users.json já
// usava o motor persist()/storagePersist() com SQLite+WAL e 3 tentativas).
// Exatamente os arquivos de DINHEIRO (pedidos e financeiro) estavam na
// via mais fraca. Agora passam pelo mesmo persist() robusto de tudo mais,
// e retornam true/false pra quem chama poder checar de verdade.
function persistPedidos(){
  try{ return !!persist(PEDIDOS_FILE, DB_PEDIDOS); }
  catch(e){ console.warn("[pedidos]",e.message); return false; }
}
// 🔒 v193 LOTE 11 — O QUE O DONO DO PEDIDO PODE VER: função ÚNICA, usada na
// LISTA (/api/pedidos) e no DETALHE (GET /api/pedido/:id). O detalhe devolvia
// o pedido CRU pro próprio usuário, furando a whitelist que a lista aplica de
// propósito desde o MC5-P2 (o preCheck cru leva o E-MAIL DE OUTRO USUÁRIO no
// dupAlerta; notaAdmin é nota interna — só a de cancelamento vira motivo
// visível; e o base64 do comprovante não precisa voltar pra quem o enviou).
// DIVERGENCIA nunca é exposta ao doador: pra ele fica "em análise" (não se
// avisa quem tenta fraude o que o robô detectou).
function _pedidoVisaoUsuario(pd){
  const v=String((pd.preCheck||{}).veredito||"").toUpperCase();
  const comprovanteStatus=!temComprovante(pd)?"sem":(v==="CONFERE"?"ok":(v==="ILEGIVEL"||v==="ERRO")?"ilegivel":v?"analise":"aguardando");
  return {id:pd.id,createdAt:pd.createdAt,status:pd.status,tipo:pd.tipo,plano:pd.plano,dias:pd.dias,
    valorTotal:pd.valorTotal,
    autoAtivado:!!pd.autoAtivado,ativadoEm:pd.ativadoEm||null,pagoEm:pd.pagoEm||null,canceladoEm:pd.canceladoEm||null,
    userEmail:pd.userEmail,comprovante:temComprovante(pd),comprovanteStatus,
    motivoCancelamento:(pd.status==="cancelado"&&pd.notaAdmin)?String(pd.notaAdmin).slice(0,200):null};
}
// Grava o resultado do pré-check do comprovante no pedido (por id), sem corrida.
function setPedidoPreCheck(pedidoId, pc){
  try{
    const i=DB_PEDIDOS.findIndex(p=>p.id===pedidoId);
    if(i<0) return;
    DB_PEDIDOS[i].preCheck = { ...pc, at: Date.now() };
    persistPedidos();
  }catch(e){ console.warn("[precheck] setPedidoPreCheck:",e.message); }
}

// ── 🧠 Parte 4 — LEITURA DE COMPROVANTE (função única, Cérebro Contábil) ────
// Usada na criação do pedido (ativar:true → ativação provisória se CONFERE) e
// pelo lote de auditoria do Cérebro (ativar:false — auditoria NUNCA ativa
// nada). Gancho de teste determinístico (mesmo padrão do feed falso do DOL):
// com TEST_LOGIN_TOKEN definido, nota "TESTE_COMPROVANTE:<valor>" simula a
// leitura sem IA — a matemática do triângulo pedido×caixa×comprovante
// continua 100% real. NUNCA definir TEST_LOGIN_TOKEN em produção.
// 💼 MC5-P1 item 7 (auditoria 29/08): se o Gemini falhar na criação (quota,
// timeout), a leitura re-tenta SOZINHA em 1min e de novo em 10min — antes o
// pedido ficava com veredito ERRO esperando a rodada das 02h ou um clique.
// Só re-tenta quando o resultado foi ERRO de verdade (ilegível/divergente é
// leitura feita, não falha) — e no máximo 2 re-tentativas (nunca loop).
// 💼 MC5-P2 item 5b: leitura ruim que o USUÁRIO pode resolver (foto ilegível
// ou sem comprovante) vira push pedindo reenvio — 1x por pedido, só doação
// pendente. DIVERGENCIA fica de fora de propósito (não se avisa fraudador).
// 🤖 v177 (dono, 14/09/2026 — auditoria achou a leitura por IA 100% morta
// em produção desde o v161 ("aprovação sempre manual"); o dono escolheu
// explicitamente "implementar a leitura real por IA agora" em vez de só
// corrigir o texto). Prompt fixo, em PT — pede SÓ os dados brutos do
// comprovante. O código, NUNCA a IA, decide CONFERE×DIVERGENCIA (regra da
// casa: "matemática sempre determinística, IA nunca decide número") —
// comparando o valor lido com pedido.valorTotal.
const GEMINI_COMPROVANTE_PROMPT = `Você está analisando um comprovante de pagamento PIX (recibo brasileiro) anexado por um cliente pra confirmar uma doação no site H2BApply. Leia a imagem/PDF com atenção e responda SOMENTE com os dados que você consegue ver — nunca invente nem arredonde.

Regras:
- "legivel": false se a imagem estiver ilegível, cortada, corrompida, ou não parecer um comprovante de pagamento de verdade — nesse caso deixe os outros campos null.
- "valor": o VALOR PAGO em reais, como número (ex.: 150.00). Se não conseguir ler o valor com certeza, deixe null e marque legivel:false — nunca chute um número.
- "data"/"hora": data e hora da transação, como aparecem no comprovante (texto livre).
- "pagador"/"recebedor": nome de quem pagou e de quem recebeu, como aparecem no comprovante.
- "instituicao": banco/instituição financeira do comprovante.
- "transacaoId": o identificador da transação/E2E do PIX, se aparecer (geralmente uma sequência alfanumérica longa).`;
const GEMINI_COMPROVANTE_SCHEMA = {
  type: "OBJECT",
  properties: {
    legivel: { type: "BOOLEAN" },
    valor: { type: "NUMBER", nullable: true },
    data: { type: "STRING", nullable: true },
    hora: { type: "STRING", nullable: true },
    pagador: { type: "STRING", nullable: true },
    recebedor: { type: "STRING", nullable: true },
    instituicao: { type: "STRING", nullable: true },
    transacaoId: { type: "STRING", nullable: true },
  },
  required: ["legivel"],
};
// Monta o corpo da chamada — função PURA (sem I/O), testável isolada do
// httpsReq real (o smoke test não tem como chamar o Gemini de verdade).
function _geminiComprovanteRequestBody(pedido,b64){
  const raw=String(b64||pedido.comprovante||"");
  const m=raw.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType=m?m[1]:(pedido.comprovanteType||"image/jpeg");
  const base64Data=m?m[2]:raw;
  return {
    contents:[{parts:[
      {text:GEMINI_COMPROVANTE_PROMPT},
      {inline_data:{mime_type:mimeType,data:base64Data}},
    ]}],
    generationConfig:{temperature:0,responseMimeType:"application/json",responseSchema:GEMINI_COMPROVANTE_SCHEMA},
  };
}
// Traduz a resposta crua do Gemini pro MESMO formato que o gancho de teste
// já produz (pc = {veredito,valorLido,...}) — função PURA, testável com uma
// resposta simulada, sem precisar de rede nenhuma.
function _geminiComprovanteParse(respBody,pedido){
  const base={dataLida:null,horaLida:null,pagadorLido:null,recebedorLido:null,instituicaoLida:null,transacaoIdLida:null,bateComEsperado:false,alertas:[],precoEsperado:pedido.valorTotal||0,valorInformado:pedido.valorTotal||0};
  try{
    const text=respBody&&respBody.candidates&&respBody.candidates[0]&&respBody.candidates[0].content&&respBody.candidates[0].content.parts&&respBody.candidates[0].content.parts[0]&&respBody.candidates[0].content.parts[0].text;
    if(!text)return {...base,veredito:"ERRO",valorLido:null,resumo:"A IA não devolveu leitura nenhuma (resposta vazia) — confira manualmente."};
    const d=JSON.parse(text);
    if(d.legivel===false||d.valor==null||!Number.isFinite(Number(d.valor))){
      return {...base,veredito:"ILEGIVEL",valorLido:null,dataLida:d.data||null,horaLida:d.hora||null,pagadorLido:d.pagador||null,recebedorLido:d.recebedor||null,instituicaoLida:d.instituicao||null,transacaoIdLida:d.transacaoId||null,resumo:"Comprovante ilegível pra IA — confira manualmente."};
    }
    const lido=Number(d.valor);
    const bate=Math.abs(lido-(pedido.valorTotal||0))<0.01;
    return {...base,veredito:bate?"CONFERE":"DIVERGENCIA",valorLido:lido,dataLida:d.data||null,horaLida:d.hora||null,
      pagadorLido:d.pagador||null,recebedorLido:d.recebedor||null,instituicaoLida:d.instituicao||null,transacaoIdLida:d.transacaoId||null,
      bateComEsperado:bate,resumo:bate?`IA leu R$${lido.toFixed(2)} — bate com o pedido.`:`IA leu R$${lido.toFixed(2)}, mas o pedido é de R$${(pedido.valorTotal||0).toFixed(2)}.`};
  }catch(e){
    return {...base,veredito:"ERRO",valorLido:null,resumo:"Erro lendo a resposta da IA: "+e.message};
  }
}
// 🎯 v178 (dono, 14/09/2026 — "não vai ter correção de pedidos... o valor
// não bate, simplesmente não vai ter que alterar nada, esse cadastro vai
// ter que ser excluído, vai ter que ser criado um novo pelo usuário"):
// fonte ÚNICA — chamada tanto pelo gancho de teste quanto pelo Gemini de
// verdade (nunca 2 comportamentos diferentes entre teste e produção). A
// IA LEU com confiança e o valor NÃO bate → cancela NA HORA, sem revisão
// manual nenhuma. Só DIVERGENCIA cancela sozinho — ILEGIVEL/ERRO continuam
// pendentes pra revisão humana (a IA não tem certeza do que leu; cancelar
// aí puniria um comprovante legítimo com foto ruim — o caminho certo pra
// isso é reenviar a foto, rota já existente).
function _autoCancelarSeDivergente(pedido,pc){
  if(pc.veredito!=="DIVERGENCIA")return;
  const _idxD=DB_PEDIDOS.findIndex(p=>p.id===pedido.id);
  if(_idxD<0)return;
  const _pdD=DB_PEDIDOS[_idxD];
  if(_pdD.canceladoEm||_pdD.ativadoEm)return;
  const _rD=_cancelarPedidoInterno(_pdD,{por:"sistema (IA — valor divergente)",
    notaAdmin:`Cancelado automaticamente: o comprovante mostra R$${(pc.valorLido||0).toFixed(2)}, mas o plano escolhido custa R$${(pedido.valorTotal||0).toFixed(2)}. Se você pagou o valor certo, confira se enviou o comprovante certo; se pagou um valor diferente, faça uma nova doação com o valor correto.`});
  if(_rD.ok)console.log(`[precheck] 🚫 pedido ${pedido.id} CANCELADO automaticamente — valor divergente (lido R$${pc.valorLido}, esperado R$${pedido.valorTotal||0})`);
}
// 🚨 v226 (achado de auditoria, 20/09/2026): função ÚNICA da checagem de
// "comprovante já usado" — mesmo ARQUIVO (hash SHA-256) ou mesma
// TRANSAÇÃO PIX (E2E) já pago/ativo/cancelado em outro pedido de QUALQUER
// usuário. Existia só dentro da aprovação MANUAL do admin (PATCH /api/
// pedido/:id) — o comentário da ativação AUTOMÁTICA (autoAtivarProvisorio,
// logo abaixo) dizia "comprovante reusado nunca chega aqui" mas isso era
// FALSO: nenhuma função no caminho automático olhava hash/transação, só
// o VALOR lido. Um comprovante Pix real reaproveitado em contas novas
// (Gmail diferente, mesmo arquivo/transação, mesmo valor) conferia
// "CONFERE" e ativava 3 dias de VIP na hora, sem nenhum humano olhar.
// Agora as duas ativações (manual e automática) usam a MESMA régua.
// v226-fix (achado testando o próprio fix): a ativação AUTOMÁTICA nunca
// muda pd.status — o pedido fica "pendente" pra sempre até o admin
// aprovar (ou nunca). Um 1º pedido só auto-ativado (autoAtivado:true,
// status ainda "pendente") não entrava no filtro ["pago","ativo",
// "cancelado"], então um 2º pedido com o MESMO arquivo/transação passava
// pela checagem e também auto-ativava — reuso automático→automático
// intacto. `x.autoAtivado` cobre esse caso sem duplicar a régua.
function _comprovanteJaUsado(pd){
  const _hash=pd.comprovanteHash||null;
  const _tx=String((pd.preCheck||{}).transacaoIdLida||"").replace(/\s+/g,"").toUpperCase();
  return DB_PEDIDOS.find(x=>x&&x.id!==pd.id
    &&(["pago","ativo","cancelado"].includes(String(x.status||"").toLowerCase())||x.autoAtivado)
    &&((_hash&&x.comprovanteHash===_hash)
      ||(_tx.length>=6&&String((x.preCheck||{}).transacaoIdLida||"").replace(/\s+/g,"").toUpperCase()===_tx)));
}
async function preCheckComprovante(pedido, opts){
  const ativar=!!(opts&&opts.ativar);
  // ── 🧾 2.0-P2: IMPRESSÃO DIGITAL SEMPRE — o hash SHA-256 do comprovante é
  // calculado mesmo SEM chave Gemini e mesmo no gancho de teste. Antes ele só
  // nascia dentro do caminho da IA, então comprovante importado dos
  // servidores 2/3 (nunca pré-checado lá) ficava sem fingerprint e o reuso
  // do MESMO arquivo entre usuários era invisível pra RULE_RECEIPT_REUSED.
  // v192 LOTE 10: os bytes vêm do disco (leitura sob demanda) — o fingerprint,
  // a leitura da IA e o anexo do e-mail usam a MESMA fonte.
  const _compB64=loadComprovante(pedido);
  try{
    if(_compB64&&!pedido.comprovanteHash){
      const _hb64=String(_compB64).replace(/^data:[^;]+;base64,/,"");
      const _h=crypto.createHash("sha256").update(_hb64).digest("hex");
      const _i=DB_PEDIDOS.findIndex(p=>p.id===pedido.id);
      if(_i>=0){DB_PEDIDOS[_i].comprovanteHash=_h;pedido.comprovanteHash=_h;persistPedidos();}
    }
  }catch(eH){console.warn("[precheck] fingerprint:",eH.message);}
  // 🎬 v237v (dono, 20/09/2026 — vídeo de verificação do Google/gmail.send +
  // demo de compra pro Andrio) + v238c (20/09/2026 — trocou de conta na
  // hora de gravar): as contas de TESTE (TEST_ACCOUNT_EMAIL/
  // TEST_ACCOUNT_EMAIL_2, mod-config.js — isTestAccountEmail cobre as 2)
  // pulam a leitura REAL do comprovante — qualquer arquivo vira um
  // "CONFERE" sintético batendo com o valor do próprio pedido, sem OCR
  // nenhum. Roda ANTES do gancho TEST_LOGIN_TOKEN (que só existe em npm
  // test — NUNCA em produção) pra funcionar no site AO VIVO, que é onde
  // esse vídeo precisa ser gravado. Isso NÃO pula a confirmação manual do
  // admin: o pedido continua "pendente" igual a qualquer outro
  // (autoAtivarProvisorio só dá acesso PROVISÓRIO de 3 dias, a MESMA régua
  // de sempre pra comprovante real que bate — a ativação definitiva
  // continua exigindo o clique do admin em Pedidos Pendentes). Isolamento
  // financeiro é feito à parte, no PATCH que confirma o pedido (nunca cria
  // entrada em DB_FINANCEIRO.pagamentos pra pedido.isTeste).
  if(pedido.isTeste){
    if(!_compB64) return null; // sem arquivo nenhum, fica pendente igual sempre
    const pc={veredito:"CONFERE",valorLido:pedido.valorTotal||0,dataLida:null,horaLida:null,
      pagadorLido:null,recebedorLido:null,instituicaoLida:null,transacaoIdLida:null,
      bateComEsperado:true,resumo:"(conta de teste — comprovante aceito sem OCR, v237v)",
      alertas:[],precoEsperado:pedido.valorTotal||0,valorInformado:pedido.valorTotal||0};
    setPedidoPreCheck(pedido.id,pc);
    if(ativar){
      const _reuso=_comprovanteJaUsado(pedido);
      if(!_reuso)autoAtivarProvisorio(pedido.id);
    }
    return pc;
  }
  if(process.env.TEST_LOGIN_TOKEN){
    // Gancho estendido (2.0-P2): TESTE_COMPROVANTE:<valor>[:<idTransacao>[:<pagador>]]
    const m=String(pedido.nota||"").match(/^TESTE_COMPROVANTE:(\d+(?:\.\d+)?)(?::([A-Za-z0-9-]+))?(?::(.+))?$/);
    if(m){
      const lido=parseFloat(m[1]);
      const bate=Math.abs(lido-(pedido.valorTotal||0))<0.01;
      const pc={veredito:bate?"CONFERE":"DIVERGENCIA",valorLido:lido,dataLida:null,horaLida:null,
        pagadorLido:m[3]||null,recebedorLido:null,instituicaoLida:null,transacaoIdLida:m[2]||null,
        bateComEsperado:bate,resumo:`(teste) leu R$${lido}`,alertas:[],precoEsperado:null,valorInformado:pedido.valorTotal||0};
      setPedidoPreCheck(pedido.id,pc);
      // v178: mesmo gancho de sempre — o teste tem que se comportar EXATAMENTE
      // como o Gemini de verdade (fonte única _autoCancelarSeDivergente),
      // senão a suíte prova um comportamento que a produção não tem.
      _autoCancelarSeDivergente(pedido,pc);
      if(ativar&&pc.veredito==="CONFERE"){
        const _reuso=_comprovanteJaUsado(pedido);
        if(_reuso)console.warn(`[precheck] 🚫 pedido ${pedido.id} NÃO ativado automaticamente — comprovante já usado no pedido ${_reuso.id} (${_reuso.userEmail}); fica pendente de conferência manual.`);
        else autoAtivarProvisorio(pedido.id);
      }
      return pc;
    }
    // (o gancho de teste NUNCA cai pro caminho real do Gemini abaixo — a
    // suíte inteira precisa continuar 100% offline, sem rede nenhuma)
    return null;
  }
  // 🤖 v177: sem GEMINI_API_KEY configurada no Render, fica HONESTAMENTE
  // pendente — nunca inventa leitura (mesmo comportamento de sempre).
  if(!process.env.GEMINI_API_KEY){
    console.warn("[precheck] sem GEMINI_API_KEY configurada — comprovante fica pendente de conferência manual.");
    return null;
  }
  if(!_compB64) return null;
  try{
    const body=_geminiComprovanteRequestBody(pedido,_compB64);
    const model=process.env.GEMINI_MODEL||"gemini-2.0-flash";
    const r=await httpsReq({hostname:"generativelanguage.googleapis.com",path:`/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,method:"POST",headers:{"Content-Type":"application/json"}},body);
    if(r.status!==200){
      console.warn("[precheck] Gemini respondeu",r.status,JSON.stringify(r.body).slice(0,200));
      setPedidoPreCheck(pedido.id,{veredito:"ERRO",valorLido:null,dataLida:null,horaLida:null,pagadorLido:null,recebedorLido:null,instituicaoLida:null,transacaoIdLida:null,bateComEsperado:false,resumo:`A IA falhou ao ler (HTTP ${r.status}) — confira manualmente.`,alertas:[],precoEsperado:pedido.valorTotal||0,valorInformado:pedido.valorTotal||0});
      return null;
    }
    const pc=_geminiComprovanteParse(r.body,pedido);
    setPedidoPreCheck(pedido.id,pc);
    _autoCancelarSeDivergente(pedido,pc);
    if(ativar&&pc.veredito==="CONFERE"){
      const _reuso=_comprovanteJaUsado(pedido);
      if(_reuso)console.warn(`[precheck] 🚫 pedido ${pedido.id} NÃO ativado automaticamente — comprovante já usado no pedido ${_reuso.id} (${_reuso.userEmail}); fica pendente de conferência manual.`);
      else autoAtivarProvisorio(pedido.id);
    }
    return pc;
  }catch(e){
    console.warn("[precheck] erro chamando Gemini:",e.message);
    try{setPedidoPreCheck(pedido.id,{veredito:"ERRO",valorLido:null,dataLida:null,horaLida:null,pagadorLido:null,recebedorLido:null,instituicaoLida:null,transacaoIdLida:null,bateComEsperado:false,resumo:"Erro de rede/tempo lendo o comprovante — confira manualmente. ("+e.message+")",alertas:[],precoEsperado:pedido.valorTotal||0,valorInformado:pedido.valorTotal||0});}catch{}
    return null;
  }
}

// ── ATIVAÇÃO PROVISÓRIA AUTOMÁTICA (dono, 21/07/2026) ────────────────────────
// "Se bateu o valor ele vai ativar direto pro usuário, mas fica pendente pro
//  adm verificar SEMPRE — nunca pode ficar plano ativo por muitos dias sem o
//  adm confirmar." Regra: pré-check leu o comprovante e o valor CONFERE →
// ativa o plano NA HORA, porém só por AUTO_ATIVA_DIAS dias (janela
// provisória). O pedido continua "pendente" na mesa do admin; a confirmação
// humana concede o período cheio (substituindo, nunca somando — ver
// _ehTrial na ativação). Sem confirmação, o provisório expira sozinho.
// v226: comprovante reusado (mesmo arquivo/transação em outro pedido)
// NUNCA chega aqui — quem chama (preCheckComprovante) barra com
// _comprovanteJaUsado() antes de chamar esta função (achado real de
// auditoria: essa checagem não existia antes, e o comentário aqui dizia
// que ela existia). Não roda se o cliente JÁ tem VIP pago ativo
// (renovação empilha dias — decisão que fica 100% com o admin).
const AUTO_ATIVA_DIAS = 3;
function autoAtivarProvisorio(pedidoId){
  try{
    const pd=DB_PEDIDOS.find(p=>p.id===pedidoId);
    if(!pd) return false;
    // v64: doação NUNCA ativa provisório — diamante provisório poderia ser
    // transferido/gasto antes da confirmação humana. Doação só credita com
    // o admin aprovando (o pré-check da IA continua mastigando o veredito).
    if(pd.tipo==="doacao"||pd.plano==="doacao") return false;
    if(pd.status!=="pendente"||pd.ativadoEm||pd.autoAtivado) return false;
    const u=getUser(pd.userEmail); if(!u) return false;
    const now=Date.now(), DAY=86400_000;
    const manualAtivo=u.vip?.manualExpires&&u.vip.manualExpires>now;
    const autoAtivo=u.vip?.autoExpires&&u.vip.autoExpires>now;
    const ehGratis=["trial","auto-provisorio"].includes(String(u.vip?.source||""));
    if((manualAtivo||autoAtivo)&&!ehGratis) return false; // já tem VIP pago — admin decide
    // 🚨 v177-FIX4 (auditoria 14/09/2026, reproduzido de verdade): vip.pedidoId
    // é um valor ÚNICO. Com um provisório JÁ VIVO do pedido A, ativar o pedido
    // B por cima SOBRESCREVIA esse campo — e a revogação do cancelamento
    // (`tgtP.vip.pedidoId===pd.id` em _cancelarPedidoInterno) passava a falhar
    // EM SILÊNCIO pro pedido A: o admin via "cancelado com sucesso" e o cliente
    // continuava com o plano ativo. Pior: cada pedido novo com comprovante que
    // CONFERE renovava a janela de 3 dias de graça, indefinidamente. Um
    // provisório por vez — o 2º pedido espera a confirmação humana de sempre.
    if((manualAtivo||autoAtivo)&&String(u.vip?.source||"")==="auto-provisorio"
       &&u.vip?.pedidoId&&u.vip.pedidoId!==pd.id){
      console.log(`[auto-ativa] ⏸️ ${pd.userEmail} já tem provisório vivo do pedido ${u.vip.pedidoId} — pedido ${pd.id} fica pendente pro admin (nunca sobrescreve o vínculo).`);
      return false;
    }
    const planoKey={vip:"vip",vipro:"vipro",doublepro:"doublepro"}[pd.plano]||"vipro";
    const isAuto=["vipro","doublepro"].includes(planoKey);
    const fim=now+AUTO_ATIVA_DIAS*DAY;
    setUser(pd.userEmail,{plan:planoKey,vip:{...(u.vip||{}),active:true,plan:planoKey,
      source:"auto-provisorio",manualExpires:fim,autoExpires:isAuto?fim:0,
      // 💳 v187: o provisório é o plano que a pessoa ACABOU de comprar — tem
      // que valer exatamente o que foi vendido. Sem este carimbo o vip nascia
      // sem `limits` e getManualLimit/getAutoLimit caíam na tabela LEGADA
      // (PLAN_LIMITS): VIPro provisório dava 200+200/dia em vez dos 100+100
      // da tabela vigente, DoublePro 400/400 em vez de 200/200 — e quando o
      // admin confirmava o pedido (que carimba limitesDoPlanoNovo) o limite
      // CAÍA PELA METADE na cara do cliente, parecendo punição por pagar.
      limits:limitesDoPlanoNovo(planoKey),
      activatedAt:now,activatedBy:"Robô (comprovante conferido)",pedidoId:pd.id,
      note:`⚡ Ativação PROVISÓRIA automática (${AUTO_ATIVA_DIAS}d) — pedido #${pd.id.slice(-8).toUpperCase()} aguarda confirmação do admin`,
      days:AUTO_ATIVA_DIAS,autoDays:isAuto?AUTO_ATIVA_DIAS:0}});
    pd.autoAtivado=true; pd.autoAtivadoEm=now;
    persistPedidos();
    addLog(pd.userEmail,{status:"sistema",
      jobTitle:`⚡ Plano ${planoKey} ativado PROVISORIAMENTE (${AUTO_ATIVA_DIAS}d) — comprovante conferido pelo robô`,
      company:`Pedido #${pd.id.slice(-8).toUpperCase()} aguarda confirmação do admin`});
    console.log(`[auto-ativa] ⚡ ${pd.userEmail} — ${planoKey} provisório ${AUTO_ATIVA_DIAS}d (pedido ${pd.id})`);
    return true;
  }catch(e){ console.warn("[auto-ativa]",e.message); return false; }
}

function persistFinanceiro(){
  // Salva sem imagens base64 inline para não explodir o arquivo — as
  // imagens ficam como referência de pedido (já persistidas nos pedidos).
  try{ return !!persist(FINANCEIRO_FILE, DB_FINANCEIRO); }
  catch(e){ console.warn("[financeiro]",e.message); return false; }
}
// 🧾 O CAIXA NUNCA APAGA: cancelar um pedido aprovado NUNCA remove a entrada
// do caixa — o lançamento original fica marcado `anuladoPor` e entra um par
// de AJUSTE negativo (mesmo valor efetivo — regra "pedido vence caixa"),
// preservando a história completa do dinheiro. Portado do Cérebro Contábil
// (mod-cerebro.js, removido) porque o cancelamento de doação — fluxo de
// pagamento protegido — depende desta função.
function _anularNoCaixa(pedidoOuFinId, porPedido, quem, batch, motivo){
  const _pv=(v)=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
  const fin=DB_FINANCEIRO;
  fin.pagamentos=fin.pagamentos||[];fin.alteracoes=fin.alteracoes||[];
  const pedById={};for(const pd of (DB_PEDIDOS||[]))if(pd&&pd.id)pedById[pd.id]=pd;
  const alvo=porPedido?(x)=>x.pedidoId===pedidoOuFinId:(x)=>x.id===pedidoOuFinId;
  const alvos=fin.pagamentos.filter((x)=>x&&x.tipo!=="ajuste"&&!x.anuladoPor&&alvo(x));
  if(!alvos.length)throw new Error("entrada não encontrada no caixa (já anulada?)");
  for(const pg of alvos){
    let v=_pv(pg.valor);
    const ped=pg.pedidoId?pedById[pg.pedidoId]:null;
    if(ped&&_pv(ped.valorTotal)>0&&_pv(ped.valorTotal)!==v)v=_pv(ped.valorTotal);
    const ajusteId="aj_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,6);
    pg.anuladoPor={ajusteId,em:Date.now(),motivo,por:quem};
    // v168 (bug real, auditoria 08/09/2026): dataPagamento aqui era um
    // DATE-ONLY já ajustado pra BRT (-3h) e truncado ("YYYY-MM-DD") — todo
    // OUTRO lançamento do caixa grava um ISO timestamp COMPLETO (new
    // Date().toISOString(), com hora). computeEntradasJanelas (e qualquer
    // outro consumidor) aplica o ajuste de -3h UMA VEZ sobre o timestamp
    // completo pra achar o dia BRT — aplicado em cima de um valor JÁ
    // truncado, o ajuste duplo empurrava o par negativo pro dia ANTERIOR,
    // inflando a janela "hoje" sempre que uma entrada era cancelada no
    // mesmo dia (o positivo contava, o negativo que devia zerá-lo não).
    // Mesmo formato de todo mundo agora — sem ajuste, sem truncar aqui.
    fin.pagamentos.push({
      id:ajusteId,tipo:"ajuste",email:pg.email,nome:pg.nome||pg.email,
      valor:-v,dataPagamento:new Date().toISOString(),
      criadoEm:Date.now(),ajustaPagamentoId:pg.id||null,ajustaPedidoId:pg.pedidoId||null,
      motivo:motivo+" · "+batch,por:"Sistema (caixa nunca apaga)",porEmail:quem,
    });
    const {comprovante,img,...limpo}=pg;
    fin.alteracoes.push({id:"alt_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,6),tipo:"ajuste_pagamento",por:"Sistema (caixa nunca apaga)",porEmail:quem,em:Date.now(),motivo:motivo+" · "+batch,antes:limpo,depois:{ajusteId,valor:-v,anulado:true}});
  }
  persistFinanceiro();
  logAdminAction(quem,"cerebro_fix_caixa",(porPedido?"pedido:":"caixa:")+pedidoOuFinId,{pagamentosAnulados:alvos.map(({comprovante,img,...l})=>l)},null,motivo+" · "+batch);
  return alvos.length;
}

// ── BOOT ─────────────────────────────────────────────────
boot();loadSheets();
loadGruposJ26(); // 🎯 mapa de grupos A-H de jul2026 (infra mínima — ver comentário na declaração)

// ── Correção pontual pedida pelo Andrio (05/07/26): o gasto "RENDER 41 DOLARES"
// foi lançado como R$ 2.010,00 por engano — o valor real é US$ 41 (câmbio 5,17
// = R$ 211,97). Idempotente: só corrige 1x, e a correção fica na trilha.
try{
  const _gErr=(DB_FINANCEIRO.gastos||[]).find(g=>g&&!g._fixRender41&&/render/i.test(g.descricao||g.nota||"")&&/41/.test(g.descricao||g.nota||"")&&g.valor>=2000&&g.valor<=2020);
  if(_gErr){
    const _antes={...(_gErr)};delete _antes.comprovante;
    _gErr.moeda="USD";_gErr.valorUSD=41;_gErr.cambio=5.17;
    _gErr.valor=Math.round(41*5.17*100)/100; // 211,97
    _gErr.editadoEm=Date.now();_gErr.editadoPor="Sistema";_gErr._fixRender41=true;
    if(!Array.isArray(DB_FINANCEIRO.alteracoes))DB_FINANCEIRO.alteracoes=[];
    const _dep={...(_gErr)};delete _dep.comprovante;
    DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36),tipo:'edit_gasto',por:'Sistema (correção Andrio)',porEmail:'sistema',em:Date.now(),
      motivo:'Correção automática: gasto RENDER lançado como R$2.010,00 por engano — valor real US$41 (câmbio 5,17 = R$211,97).',antes:_antes,depois:_dep});
    persistFinanceiro();
    console.log('[fin] ✅ Gasto RENDER corrigido: R$2.010,00 → US$41 (R$211,97)');
  }
}catch(e){console.warn('[fin] fix render41:',e.message);}

// ── Migração automática: copiar planilhas enriquecidas para /data/ ──────────
// Se o bot já enriqueceu (enrichedAt no meta) mas o arquivo em /data/ não existe,
// significa que o enriquecimento foi feito antes desta correção.
// Copia o arquivo de __dirname para /data/ para que deploys futuros carreguem corretamente.
(function migrateEnrichedSheets(){
  for(const[key,file]of[["jan2026","jan2026_compact.json"],["jul2025","jul2025_compact.json"]]){
    const dataPath=path.join(DATA_DIR,file);
    const srcPath=path.join(__dirname,file);
    if(!fs.existsSync(dataPath)&&fs.existsSync(srcPath)){
      try{
        const data=JSON.parse(fs.readFileSync(srcPath,"utf8"));
        // Só migra se o arquivo tem dados enriquecidos (campo ci preenchido em pelo menos 10%)
        const withCity=data.filter(r=>r.ci).length;
        const pct=data.length>0?Math.round(withCity/data.length*100):0;
        if(pct>=10){
          fs.writeFileSync(dataPath,JSON.stringify(data));
          console.log(`[migrate] ✅ ${file} copiado para /data/ (${pct}% enriquecido, ${data.length} vagas)`);
        } else {
          console.log(`[migrate] ⚠️ ${file} sem enriquecimento significativo (${pct}%) — não migrado`);
        }
      }catch(e){console.warn(`[migrate] Erro ao migrar ${file}:`,e.message);}
    } else if(fs.existsSync(dataPath)){
      console.log(`[migrate] ✅ ${file} já existe em /data/ — ok`);
    }
  }
})();

// ── Recategorização corretiva (bug reportado: Housekeeper puxando vaga de
// Cook/cozinha) — causa-raiz: detectCategory() vinha sendo chamado só com o
// NOME DA EMPRESA (r.n), nunca com o CARGO (r.t). Uma empresa chamada
// "Breezeway Family Resorts" contratando "Cook" caía em housekeeper só por
// ter "resort" no nome. Os 5 pontos que faziam essa chamada errada já foram
// corrigidos no código (agora passam título e empresa SEPARADOS). Esta função
// roda 1x no boot e força o recálculo de TODA vaga já classificada antes da
// correção (ignora o cache de r.k existente), e persiste o resultado.
// ⚠️ v179: é justamente por rodar em todo boot que ela reintroduzia o erro do
// paisagismo em 2.588 vagas — a correção tinha que ser na FUNÇÃO, nunca aqui.
function recategorizeAllSheets(){
  let totalFixed=0;
  function fixArray(arr,label){
    let fixed=0;
    for(const r of arr){
      if(String(r.visa||"").toUpperCase().includes("H-2A")) continue; // H-2A tem taxonomia própria — nunca tocar aqui
      const novo=detectCategory(r.t,r.n);
      if(r.k!==novo){ r.k=novo; fixed++; }
    }
    if(fixed>0) console.log(`[recat] 🔧 ${label}: ${fixed}/${arr.length} vagas recategorizadas (título passou a valer, não só empresa)`);
    return fixed;
  }
  totalFixed+=fixArray(SHEET_JAN,"jan2026");
  totalFixed+=fixArray(SHEET_JUL,"jul2025");
  // H-2A NÃO entra aqui: usa uma taxonomia agrícola própria de 20 categorias
  // (crop, livestock, equipment_op, sheepherder...) que não existe em
  // CATEGORY_KEYWORDS. Rodar detectCategory() nele destruiria essa
  // classificação especializada — só H-2B (jan2026/jul2025/extras) usa
  // CATEGORY_KEYWORDS.
  for(const[key,arr] of Object.entries(SHEET_EXTRAS)){
    const n=fixArray(arr,`extra:${key}`);
    if(n>0){
      try{
        if(!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR,{recursive:true});
        fs.writeFileSync(path.join(SHEETS_DIR,key+".json"), JSON.stringify(arr));
      }catch(e){console.warn(`[recat] Erro ao persistir extra ${key}:`,e.message);}
    }
  }
  // Persiste jan2026/jul2025 corrigidos em /data/ (mesmo padrão do bot de enriquecimento)
  if(totalFixed>0){
    try{ fs.writeFileSync(path.join(DATA_DIR,"jan2026_compact.json"), JSON.stringify(SHEET_JAN)); }catch(e){console.warn("[recat] persist jan2026:",e.message);}
    try{ fs.writeFileSync(path.join(DATA_DIR,"jul2025_compact.json"), JSON.stringify(SHEET_JUL)); }catch(e){console.warn("[recat] persist jul2025:",e.message);}
    console.log(`[recat] ✅ Recategorização concluída: ${totalFixed} vaga(s) corrigida(s) no total e salvas em /data/.`);
  } else {
    console.log("[recat] ✅ Nenhuma vaga precisou de correção de categoria.");
  }
}
recategorizeAllSheets();

// ── Graceful shutdown: persiste TODOS os bancos ──────────
function flushAll() {
  // ❄️ v191 LOTE 9: com as gravações congeladas (restauração de backup em
  // andamento), o SIGTERM NÃO pode gravar a memória por cima dos arquivos que
  // acabaram de voltar do backup — era exatamente isso que desfazia o restore.
  if (_gravacoesCongeladas) {
    console.warn(`[shutdown] ❄️ gravações congeladas (${_gravacoesCongeladasMotivo}) — nada foi salvo por cima dos arquivos restaurados. É o comportamento certo: suba o servidor de novo pra carregar o backup.`);
    return;
  }
  console.log("[shutdown] Persistindo dados...");

  // 1. FLUSH GENÉRICO: todo persistDebounced/persistThrottled pendente vai pro
  //    disco com o payload que ele guardou (v191 LOTE 9). Antes o shutdown só
  //    CANCELAVA esses timers e regravava uma lista fixa — journey.json (e
  //    qualquer banco novo que use o debounce) se perdia em todo deploy.
  const _gravados = new Set();
  for (const [file, ent] of [..._persistDebounceTimers]) {
    clearTimeout(ent.tid);
    try { persist(file, ent.data); _gravados.add(file); }
    catch(e) { console.warn("[shutdown] pendente " + path.basename(file) + ":", e.message); }
  }
  _persistDebounceTimers.clear();
  _persistSujoDesde.clear();

  // 2. Persiste todos os bancos principais — DEDUPLICADO contra o passo 1:
  //    users.json e history.json são os maiores do sistema e serializá-los 2x
  //    num sinal em que o Render dá poucos segundos é justamente o que pode
  //    fazer o processo morrer no meio da gravação.
  const _grava = (file, data, rotulo) => {
    if (_gravados.has(file)) return;
    _gravados.add(file);
    try { persist(file, data); } catch(e) { console.warn("[shutdown] " + rotulo + ":", e.message); }
  };
  _grava(USERS_FILE,  DB_USERS,  "users");
  try { persistSessions();              } catch(e) { console.warn("[shutdown] sessions:", e.message); }
  _grava(HIST_FILE,   DB_HIST,   "hist");
  _grava(AUTO_FILE,   DB_AUTO,   "auto");
  _grava(LOGS_FILE,   DB_LOGS,   "logs");
  _grava(REVIEWS_FILE, DB_REVIEWS, "reviews");
  try { _persistNotifCooldowns(); } catch(e) { console.warn("[shutdown] notif-cooldowns:", e.message); }

  // 3. Persiste sent_emails (conversão Set → Array)
  try {
    const out = {};
    for (const [k, v] of Object.entries(DB_SENT)) out[k] = [...v];
    _grava(SENT_FILE, out, "sent");
  } catch(e) { console.warn("[shutdown] sent:", e.message); }

  // A LISTA vai pro log de propósito: é a prova, num deploy real, de que
  // nenhum banco foi serializado duas vezes no mesmo desligamento (e de que
  // os debounces pendentes entraram). O smoke lê exatamente esta linha.
  console.log(`[shutdown] ✅ Dados salvos (${_gravados.size} banco(s), sem repetir nenhum): ${[..._gravados].map(f=>path.basename(f)).join(",")}`);
}
process.on("SIGTERM",()=>{flushAll();process.exit(0);});
process.on("SIGINT", ()=>{flushAll();process.exit(0);});
process.on("uncaughtException",(err)=>{
  console.error("[FATAL] uncaughtException:",err?.message||err);
  try{pushGlobalEvent("uncaught_exception",null,String(err?.message||err).slice(0,200),"error");persist(AUTO_FILE,DB_AUTO);persist(USERS_FILE,DB_USERS);}catch(_){}
  // NÃO termina — timers do automático continuam
});
process.on("unhandledRejection",(reason)=>{
  console.error("[WARN] unhandledRejection:",reason?.message||reason);
  try{pushGlobalEvent("unhandled_rejection",null,String(reason?.message||reason).slice(0,200),"warn");}catch(_){}
});



server.listen(PORT,"0.0.0.0",()=>{
  console.log(`\n✅  H2BApply v13.1 — ${APP_URL} (porta ${PORT})`);
  console.log(`    👤 Usuários: ${Object.keys(DB_USERS).length}`);
  console.log(`    📋 Jan/2026: ${SHEET_JAN.length} | Jul/2025: ${SHEET_JUL.length}`);
  console.log(`    🍪 Cookie: SameSite=Lax | IS_PROD: ${IS_PROD}`);
  if(!CONFIGURED)console.log("\n⚠️  Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET!\n");
  setTimeout(()=>reactivateAutoJobs().catch(e=>console.error("[boot] reactivate error:",e.message)),6000);

  // ══════════════════════════════════════════════════════════════════════
  // ── AUTO-REGULARIZAÇÃO FINANCEIRA — roda 30s após boot ────────────────
  // Verifica clientes com plano ativo mas sem dados financeiros preenchidos
  // e preenche automaticamente. Nunca sobrescreve dados já existentes.
  // Também salva contexto financeiro na KB para auditorias futuras.
  // ══════════════════════════════════════════════════════════════════════
  // ── Regularização imediata dos clientes confirmados (10s após boot) ────────
  // Dados confirmados pelo Andrio em 27/06/2026. Executado 1 vez por cliente.
  // Nunca sobrescreve dados já preenchidos pelo admin/Diego.
  setTimeout(()=>{
    const _CLIENTES_CONFIRMADOS=[
      {email:"italoleal812@gmail.com",        nome:"Ítalo Almeida Leal",            valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"esdras.silva.h2b@gmail.com",    nome:"Esdras Alberto da Silva",       valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"sw26wagnersilva@gmail.com",     nome:"Wagner Silva da Silva",         valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"maykoncanalgg@gmail.com",       nome:"Maykon de Souza Nobrega",       valor:"R$100.00",plano:"vip",  nota:"VIP Manual 30d — confirmado Diego 27/06/2026"},
      {email:"jonatafontela07@gmail.com",     nome:"Jonata Fontela Dutra",          valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"itallofeitoza1993@gmail.com",   nome:"Itallo Jailson Feitoza",        valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"regianegoncalves.rgs@gmail.com",nome:"Regiane Gonçalves dos Santos",  valor:"R$100.00",plano:"vip",  nota:"VIP Manual 30d — confirmado Diego 27/06/2026"},
      {email:"bruno.j.lange@gmail.com",       nome:"Bruno Luis Jara Lange",         valor:"R$120.00",plano:"vipro",nota:"VIPro 30d R$120 desconto — confirmado Diego 27/06/2026"},
      {email:"enggustavomachado93@gmail.com", nome:"Gustavo Amaral Machado",        valor:"R$100.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"jose.camilo.jobs@gmail.com",    nome:"José Camilo Rodrigues",         valor:"R$149.90",plano:"vipro",nota:"VIPro 30d R$149,90 — confirmado Diego 27/06/2026"},
    ];
    const now=Date.now();
    let _reg=0;
    for(const c of _CLIENTES_CONFIRMADOS){
      const u=getUser(c.email);
      if(!u)continue;
      // Nunca sobrescrever dados já preenchidos
      if(u.financialStatus==='pago'&&u.paymentAmount&&u.lastValidationResult==='CLIENTE_VALIDADO')continue;
      const patch={};
      if(!u.financialStatus)patch.financialStatus='pago';
      if(!u.paymentAmount)patch.paymentAmount=c.valor;
      if(!u.paymentMethod)patch.paymentMethod='pix';
      if(!u.paymentReceiver)patch.paymentReceiver='Diego';
      if(!u.paymentDate)patch.paymentDate='27/06/2026';
      if(!u.paymentNote)patch.paymentNote=c.nota;
      if(u.lastValidationResult!=='CLIENTE_VALIDADO'){
        patch.lastValidatedAt=now;
        patch.lastValidatedBy='Sistema (boot) — confirmado por Diego';
        patch.lastValidationResult='CLIENTE_VALIDADO';
      }
      if(!u.adminNotes)patch.adminNotes=`Receita jun/2026: R$1.319,90 | Gastos: R$466,01 | Lucro: R$853,89 (Andrio: R$426,95 / Diego: R$426,95)`;
      patch.adminEditHistory=[...(u.adminEditHistory||[]).slice(-49),{
        at:now,by:'Sistema Auto',byEmail:'boot',
        changes:Object.keys(patch).join(','),
        note:`Regularização boot 27/06/2026 — ${c.nota}`
      }];
      setUser(c.email,patch);
      _reg++;
      console.log(`[boot-reg] ✅ ${c.nome} (${c.email}): ${c.valor} preenchido`);
    }
    if(_reg>0)console.log(`[boot-reg] ✅ ${_reg} cliente(s) regularizado(s) automaticamente`);
    else console.log('[boot-reg] ✅ Todos os clientes confirmados já estão regularizados');
  }, 10000); // 10s após boot

  // ── 🔑 Migração de SEGURANÇA (rede de apoio): concede admin a qualquer
  // conta de ADMIN_RESERVED_USERNAMES que já exista mas ainda não tenha
  // isAdmin — cobre conta criada ANTES desta lista existir, ou o raro caso
  // de o cadastro ter acontecido bem no meio de um deploy. O caminho
  // PRINCIPAL é o grant imediato dentro do próprio /api/cadastro (linha
  // ~7586) — não depende de restart nenhum. Carimbo em disco POR USERNAME
  // garante que esta migração roda de VERDADE só 1 vez por conta: depois
  // da 1ª concessão nunca mais mexe nela, mesmo que o próprio admin
  // revogue isAdmin depois pelo painel (senão o boot desfaria a decisão
  // dele a cada restart). Conta ainda não existir neste boot = não
  // escreve carimbo, tenta de novo no próximo.
  setTimeout(()=>{
    for(const username of ADMIN_RESERVED_USERNAMES){
      try{
        const _stampFile=path.join(DATA_DIR,`mig_admin_${username}_v1.json`);
        if(fs.existsSync(_stampFile))continue;
        const _u=getUser(username);
        if(_u&&!_u.isAdmin){
          setUser(username,{isAdmin:true});
          fs.writeFileSync(_stampFile,JSON.stringify({em:Date.now(),motivo:"ordem do dono, 12/09/2026 — username reservado (rede de apoio do boot, fora do /api/cadastro)"}));
          console.log(`[boot] 🔑 Conta "${username}" promovida a admin (migração de apoio, ordem do dono)`);
        }
      }catch(e){console.warn(`[boot] erro na migração admin ${username}:`,e.message);}
    }
  },10500);


  // v72: Startup Bounce Scan DESLIGADO — lia a inbox de todo usuário com
  // token (gmail.readonly) procurando bounce. Sem esse escopo (ordem do
  // dono: só ENVIAR, nunca ler caixa de entrada), o scan nunca teria o que
  // ler — rodar mesmo assim só gastaria refresh_token de todo usuário à toa
  // a cada boot. DB_INVALID_EMAILS e isEmailInvalid() continuam de pé (dado
  // histórico + entradas manuais do admin seguem valendo pro robô pular
  // e-mails já conhecidos como mortos), só a DESCOBERTA de novos bounces
  // por leitura de inbox parou.

  // ── 📋 v217 (dono, 19/09/2026): robôs de planilha (mod-planilhas.js) —
  // enriquecimento, vagas novas H-2A, H-2A do mês e H-2B do mês — não têm
  // MAIS agendamento por relógio nenhum. iniciarAgendadores() só loga; cada
  // robô roda por clique do admin (aba Planilhas & Robôs) quando o DOL
  // publicar temporada nova (poucas vezes por ano). Chamada mantida pra não
  // esconder o boot deste módulo, mas não registra timer algum.
  PLANILHAS.iniciarAgendadores();

  // 📊 Resumo Diário do Dono — push às 8h BRT com os números de ontem.
  scheduleResumoDono();


  // ⏰ v125b (mesmo incidente do print de 12/08): varredura anti-preso — a
  // cada 10min, robô parado em waiting_limit com timer MORTO (deploy pegou o
  // servidor no meio da espera) ou já ABAIXO do limite atual (plano melhorou,
  // virada do dia perdida) volta pro agendador. scheduleAuto re-avalia tudo
  // do zero (se ainda estiver no limite real, só re-arma a meia-noite), então
  // a varredura é sempre segura — e o cliente preso se solta SOZINHO, sem
  // precisar clicar em nada.
  setInterval(()=>{try{
    for(const [em,j] of Object.entries(DB_AUTO)){
      if(!j?.active||j.status!=="waiting_limit")continue;
      const p=getUser(em)||{};
      const abaixo=countAutoToday(getHist(em))<(getAutoLimit(p));
      if(!autoTimers.has(em)||abaixo){
        if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
        console.log(`[auto] ⏰ sweep: ${em} em waiting_limit ${abaixo?"já ABAIXO do limite atual":"com timer morto"} — reagendado agora`);
        scheduleAuto(em);
      }
    }
  }catch(e){console.warn("[auto-sweep]",e.message);}}, 10*60_000);
});

// ══════════════════════════════════════════════════════════════════════════
//  🩺 HEALTH SENTINEL — extraído para src/sentinel.js (Fase 1 · Módulo 3)
//  Injeção de dependências via getters: estado vivo do servidor sempre atual.
// ══════════════════════════════════════════════════════════════════════════
const { initSentinel } = require("./mod-sentinel.js");
const { healthSentinelRun, pendingOrderAlert, queueSanitizerRun, getPedAlertSent } = initSentinel({
  DB_USERS: ()=>DB_USERS, DB_AUTO: ()=>DB_AUTO, DB_PEDIDOS: ()=>DB_PEDIDOS,
  DB_INVALID_EMAILS: ()=>DB_INVALID_EMAILS, DB_SHEETS_META: ()=>DB_SHEETS_META,
  SHEET_EXTRAS: ()=>SHEET_EXTRAS, sessions: ()=>sessions,
  ADMIN_EMAIL, ADMIN_EMAILS,
  getUser, getAutoJob, setAutoJob, isVipActive, sendNotifEmail,
  refreshTokenForUser, buildMime, httpsReq, getSheet,
  // v199 LOTE 18: o monitor de planilhas do vigia usa as MESMAS fontes do
  // robô — a lista de planilhas PUBLICADAS (a do frescor) e a régua única de
  // "completa" (CAMPOS_ESSENCIAIS, via progressoPlanilha). Nada de uma 2ª
  // lista montada à mão aqui dentro.
  planilhasPublicadas: ()=>PLANILHAS.planilhasPublicadas(),
  progressoPlanilha: _progressoPlanilha,
  cooldownMaps: { notifSentAt: ()=>_notifSentAt, authErrNotifiedAt: getAuthErrNotifiedAt },
  pedAlertSentInit: _DB_NOTIF_COOLDOWN.pedAlertSent, // V951: sobrevive a deploy
  // v183 LOTE 1: a saúde do canal de e-mail do sistema é a CONTA DE
  // NOTIFICAÇÕES (v175), não mais o Gmail pessoal do ADMIN_EMAIL.
  notifConectada: ()=>NOTIF.conectada(),
  botLog, // 📜 log unificado — pedido do dono (07/07/2026)
  pushToUser, // v18-FIX: fallback de notificação enquanto o e-mail está desligado pelo dono
});

// ── Router do grupo saúde/operação (Fase 1 · Módulo 5) ──
const { createAdminHealthRouter } = require("./mod-admin-health.js");
const handleAdminHealthRoutes = createAdminHealthRouter({
  getSess, getUser, isAdminVip, isAdminEmail, json, readBody,
  sessAdminEmail:_sessAdminEmail, // v183 LOTE 1: sessão do painel por username
  DB_USERS: ()=>DB_USERS, DB_AUTO: ()=>DB_AUTO, DB_PEDIDOS: ()=>DB_PEDIDOS,
  getAutoJob, setAutoJob, sendNotifEmail, storageInfo,
  queueSanitizerRun, healthSentinelRun, pendingOrderAlert,
});
console.log("[health-sentinel] 🩺 Módulo carregado: desync VIP↔robô, lembrete de renovação, alerta de pedidos, sanitização de fila.");

// ── ⛃ BACKUP DO SISTEMA — rotas /api/admin/v2/backup/* (mod-admin-v2.js) ──
// O painel V2 foi aposentado (18/07/2026); o módulo agora só cuida de backup
// (usado pelo painel clássico /admin) + auditoria dessas ações.
const { createAdminV2Router } = require("./mod-admin-v2.js");
const handleAdminV2Routes = createAdminV2Router({
  getSess, getUser, isAdminVip, json, readBody, DATA_DIR,
  congelarGravacoes, // ❄️ v191 LOTE 9: restaurar backup congela as gravações até o reinício
});
console.log("[admin-v2] ⛃ Módulo de backup carregado (rotas /api/admin/v2/backup/*).");

const _memPulse=()=>{try{const m=process.memoryUsage();console.log(`[mem] rss=${Math.round(m.rss/1048576)}MB heap=${Math.round(m.heapUsed/1048576)}/${Math.round(m.heapTotal/1048576)}MB ext=${Math.round((m.external||0)/1048576)}MB up=${Math.round(process.uptime()/60)}min`);}catch(e){}};
setTimeout(_memPulse,30_000);setInterval(_memPulse,6*3600_000);
