/* ═══════════════════════════════════════════════════════════════════════
   📧 mod-notif.js — E-MAILS DO SISTEMA + CÓDIGOS DE VERIFICAÇÃO (v175, 13/09/2026)
   Ordem do dono: "SuporteH2bapply@gmail.com vai ser o e-mail do site que
   envia os códigos para os usuários... eu vou na página adm, aba
   Notificações, e logo o Google pra usar esse e-mail".

   O que este módulo faz (e SÓ isso):
   • CONTA DE NOTIFICAÇÕES: uma conta Google conectada pelo admin (OAuth,
     escopo gmail.send — nunca lê caixa de entrada) fica guardada em
     DATA_DIR/notif_account.json com o refresh_token CIFRADO (mesma cifra
     dos tokens dos usuários). Só existe UMA conta; conectar outra troca.
   • ENVIO: sendMail() renova o access token sozinho e manda pela API do
     Gmail (users/me/messages/send) com o MIME da casa (buildMime). No
     npm test (isTest) NUNCA chama o Google — grava em notif_outbox.json,
     que o smoke lê pra pegar o código e provar o pipeline inteiro.
   • CÓDIGOS (OTP): 6 dígitos aleatórios (crypto), válidos por 5 minutos,
     guardados só em HASH na memória, máx. 5 tentativas erradas (aí o
     código morre), reenvio com espera de 60s e no máx. 3 envios por
     e-mail a cada 15 min — padrão do mercado (NIST SP 800-63B: código
     curto exige limite de tentativas; expiração 5-10 min).
   • TOKEN DE E-MAIL VERIFICADO: depois de confirmar o código, o cliente
     recebe um token HMAC (e-mail + finalidade + validade 30 min) que o
     /api/cadastro exige — sem estado no servidor, sobrevive a restart.
   Erro de envio nunca derruba nada: fica em lastError pro painel.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("crypto");

function createNotif(deps) {
  const { fs, path, DATA_DIR, httpsReq, buildMime, encStr, decStr, getClientId, getClientSecret, isTest, hmacSecret, appUrl } = deps;
  const FILE = path.join(DATA_DIR, "notif_account.json");
  const OUTBOX = path.join(DATA_DIR, "notif_outbox.json");
  const APP_NAME = "H2BApply";
  const hoje = () => new Date().toISOString().slice(0, 10);

  // ── estado da conta ──────────────────────────────────────────────────
  let acc = null;
  try { const raw = JSON.parse(fs.readFileSync(FILE, "utf8")); if (raw && raw.email) acc = { ...raw, refresh_token: decStr(raw.refresh_token) || null }; } catch { acc = null; }
  if (acc && !acc.refresh_token) { console.warn("[notif] ⚠️ conta de notificações no disco sem refresh_token legível (DATA_ENC_KEY mudou?) — precisa reconectar no painel"); acc.rtInvalid = true; }
  const saveAcc = () => {
    try {
      if (!acc) { try { fs.unlinkSync(FILE); } catch { } return; }
      fs.writeFileSync(FILE, JSON.stringify({ ...acc, refresh_token: acc.refresh_token ? encStr(acc.refresh_token) : null, cached_access_token: undefined, cached_expiry: undefined }, null, 2));
    } catch (e) { console.warn("[notif] gravar conta:", e.message); }
  };
  const conectada = () => !!(acc && acc.email && acc.refresh_token && !acc.rtInvalid);

  function status() {
    const t = acc && acc.sentToday && acc.sentToday.dia === hoje() ? acc.sentToday.n : 0;
    return {
      conectada: conectada(), email: acc ? acc.email : null, connectedAt: acc ? acc.connectedAt : null, connectedBy: acc ? acc.connectedBy : null,
      rtInvalid: !!(acc && acc.rtInvalid), sentToday: t, sentTotal: acc ? (acc.sentTotal || 0) : 0, lastSendAt: acc ? acc.lastSendAt || null : null,
      lastError: acc ? acc.lastError || null : null, lastErrorAt: acc ? acc.lastErrorAt || null : null,
      avisoPedidos: acc ? acc.avisoPedidos !== false : true, modoTeste: !!isTest, limiteDiario: 500,
    };
  }
  function conectar({ email, refresh_token, connectedBy }) {
    acc = { email: String(email || "").toLowerCase().trim(), refresh_token, connectedAt: Date.now(), connectedBy: connectedBy || null,
      sentToday: { dia: hoje(), n: 0 }, sentTotal: (acc && acc.email === email ? acc.sentTotal : 0) || 0, lastError: null, lastErrorAt: null, avisoPedidos: acc ? acc.avisoPedidos !== false : true, rtInvalid: false };
    saveAcc();
    console.log(`[notif] ✅ conta de notificações conectada: ${acc.email} (por ${connectedBy || "?"})`);
  }
  async function desconectar() {
    if (!acc) return { ok: true, jaEstava: true };
    const tok = acc.refresh_token || acc.cached_access_token;
    if (tok && !isTest) {
      try { const b = "token=" + encodeURIComponent(tok); await httpsReq({ hostname: "oauth2.googleapis.com", path: "/revoke", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(b) } }, b); }
      catch (e) { console.warn("[notif] revoke falhou (segue desconectando):", e.message); }
    }
    const email = acc.email; acc = null; saveAcc();
    console.log(`[notif] 🔌 conta de notificações desconectada: ${email}`);
    return { ok: true, email };
  }
  // 🚨 v177-FIX (auditoria 14/09/2026): devolvia `false` tanto pra "desliguei
  // com sucesso" quanto pra "não tem conta conectada, nada foi salvo" — o
  // chamador não tinha como distinguir os dois, então o painel achava que o
  // toggle tinha funcionado quando na verdade não fez nada. Agora `null`
  // significa especificamente "sem conta conectada".
  function setAvisoPedidos(on) { if (!acc) return null; acc.avisoPedidos = !!on; saveAcc(); return acc.avisoPedidos; }

  // ── token de acesso (renova sozinho) ─────────────────────────────────
  async function accessToken() {
    if (!conectada()) throw new Error("Conta de notificações não conectada — conecte em Admin → Notificações.");
    if (acc.cached_access_token && acc.cached_expiry && Date.now() < acc.cached_expiry - 60_000) return acc.cached_access_token;
    const b = new URLSearchParams({ client_id: getClientId(), client_secret: getClientSecret(), refresh_token: acc.refresh_token, grant_type: "refresh_token" }).toString();
    const { body: r } = await httpsReq({ hostname: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(b) } }, b);
    if (!r || r.error) {
      const msg = String((r && (r.error_description || r.error)) || "token não renovado");
      if (/invalid_grant|revoked|expired/i.test(msg)) { acc.rtInvalid = true; acc.lastError = "Google derrubou a permissão (" + msg + ") — reconecte a conta no painel."; acc.lastErrorAt = Date.now(); saveAcc(); }
      throw new Error(msg);
    }
    acc.cached_access_token = r.access_token; acc.cached_expiry = Date.now() + (r.expires_in || 3600) * 1000;
    return r.access_token;
  }

  // ── envio ────────────────────────────────────────────────────────────
  function _contabiliza(ok, err) {
    if (!acc) return;
    if (ok) { if (!acc.sentToday || acc.sentToday.dia !== hoje()) acc.sentToday = { dia: hoje(), n: 0 }; acc.sentToday.n++; acc.sentTotal = (acc.sentTotal || 0) + 1; acc.lastSendAt = Date.now(); }
    else { acc.lastError = String(err || "?").slice(0, 300); acc.lastErrorAt = Date.now(); }
    saveAcc();
  }
  async function sendMail({ to, subject, text, attachments, tipo }) {
    const dest = String(to || "").trim().toLowerCase();
    if (!dest.includes("@")) throw new Error("destinatário inválido");
    if (isTest) {
      // 🧪 npm test: nada sai pra internet — o outbox é a prova do pipeline
      let box = []; try { box = JSON.parse(fs.readFileSync(OUTBOX, "utf8")) || []; } catch { }
      box.push({ ts: Date.now(), to: dest, subject, text, tipo: tipo || "?", attachments: (attachments || []).map(a => ({ name: a.name, mime: a.mime, bytes: a.data ? a.data.length : 0 })), from: acc ? acc.email : "(sem conta)" });
      fs.writeFileSync(OUTBOX, JSON.stringify(box.slice(-200), null, 2));
      _contabiliza(true);
      return { ok: true, teste: true };
    }
    try {
      const token = await accessToken();
      const raw = buildMime({ to: dest, subject, text, fromName: APP_NAME, fromEmail: acc.email, attachments: attachments || [] });
      const { status: st, body } = await httpsReq({ hostname: "gmail.googleapis.com", path: "/gmail/v1/users/me/messages/send", method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" } }, { raw });
      if (body && body.error) throw new Error(body.error.message || JSON.stringify(body.error));
      if (st !== 200) throw new Error("Gmail HTTP " + st);
      _contabiliza(true);
      return { ok: true, id: body && body.id };
    } catch (e) { _contabiliza(false, e.message); throw e; }
  }

  // ── códigos de verificação (OTP) ─────────────────────────────────────
  const CODIGO_TTL_MS = 5 * 60_000, MAX_TENTATIVAS = 5, REENVIO_MS = 60_000, MAX_ENVIOS = 3, JANELA_ENVIOS_MS = 15 * 60_000;
  const pend = new Map(); // `${finalidade}:${email}` → { hash, exp, tentativas, envios:[ts], ultimoEnvio }
  const key = (f, e) => `${f}:${String(e || "").toLowerCase().trim()}`;
  const hashCode = (c) => crypto.createHash("sha256").update(String(c)).digest("hex");
  setInterval(() => { const now = Date.now(); for (const [k, v] of pend) if (v.exp < now - JANELA_ENVIOS_MS) pend.delete(k); }, 60_000).unref?.();

  function podeEnviar(finalidade, email) {
    const v = pend.get(key(finalidade, email)); if (!v) return { ok: true };
    const now = Date.now();
    if (v.ultimoEnvio && now - v.ultimoEnvio < REENVIO_MS) return { ok: false, motivo: "aguarde", segundos: Math.ceil((REENVIO_MS - (now - v.ultimoEnvio)) / 1000) };
    const recentes = (v.envios || []).filter(t => now - t < JANELA_ENVIOS_MS);
    if (recentes.length >= MAX_ENVIOS) return { ok: false, motivo: "limite", segundos: Math.ceil((JANELA_ENVIOS_MS - (now - recentes[0])) / 1000) };
    return { ok: true };
  }
  function gerarCodigo(finalidade, email) {
    const k = key(finalidade, email); const prev = pend.get(k) || {};
    const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const now = Date.now();
    pend.set(k, { hash: hashCode(codigo), exp: now + CODIGO_TTL_MS, tentativas: 0, envios: [...(prev.envios || []).filter(t => now - t < JANELA_ENVIOS_MS), now], ultimoEnvio: now });
    return { codigo, expiraEm: CODIGO_TTL_MS / 1000, reenvioEm: REENVIO_MS / 1000 };
  }
  function confirmarCodigo(finalidade, email, codigo) {
    const k = key(finalidade, email); const v = pend.get(k);
    if (!v) return { ok: false, motivo: "nenhum código pedido pra esse e-mail — clique em Enviar verificação" };
    if (Date.now() > v.exp) { pend.delete(k); return { ok: false, motivo: "código expirado (vale 5 minutos) — peça um novo", expirado: true }; }
    const c = String(codigo || "").replace(/\D/g, "");
    if (c.length !== 6 || hashCode(c) !== v.hash) {
      v.tentativas++;
      if (v.tentativas >= MAX_TENTATIVAS) { pend.delete(k); return { ok: false, motivo: "5 tentativas erradas — o código foi cancelado, peça um novo", cancelado: true }; }
      return { ok: false, motivo: `código incorreto (${MAX_TENTATIVAS - v.tentativas} tentativa${MAX_TENTATIVAS - v.tentativas === 1 ? "" : "s"} restante${MAX_TENTATIVAS - v.tentativas === 1 ? "" : "s"})`, restantes: MAX_TENTATIVAS - v.tentativas };
    }
    pend.delete(k);
    return { ok: true, token: tokenVerificado(finalidade, email) };
  }
  // ── token "e-mail verificado" (HMAC, 30 min) ──────────────────────────
  const TOKEN_TTL_MS = 30 * 60_000;
  const secret = crypto.createHash("sha256").update(String(hmacSecret || crypto.randomBytes(32).toString("hex"))).digest();
  function tokenVerificado(finalidade, email) {
    const payload = Buffer.from(JSON.stringify({ e: String(email).toLowerCase().trim(), f: finalidade, x: Date.now() + TOKEN_TTL_MS })).toString("base64url");
    const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return payload + "." + mac;
  }
  function validarToken(token, finalidade, email) {
    try {
      const [payload, mac] = String(token || "").split(".");
      if (!payload || !mac) return false;
      const esperado = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
      if (mac.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(esperado))) return false;
      const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return d.f === finalidade && d.e === String(email || "").toLowerCase().trim() && Date.now() < d.x;
    } catch { return false; }
  }

  // ── templates (PT-BR, texto puro — chega em qualquer cliente de e-mail) ──
  const rodape = `\n\n—\n${APP_NAME} · ${appUrl || "https://h2bapply.com"}\nEste e-mail foi enviado automaticamente pelo sistema. Se você não pediu este código, pode ignorar esta mensagem com segurança — nada acontece na sua conta sem ele.`;
  function templateCodigoCadastro({ codigo }) {
    return {
      subject: `${codigo} é o seu código de confirmação — ${APP_NAME}`,
      text: `Olá!\n\nVocê está criando sua conta no ${APP_NAME}. Use o código abaixo pra confirmar que este e-mail é seu:\n\n    ▶  ${codigo}  ◀\n\nO código vale por 5 minutos e só funciona no cadastro que você está fazendo agora.\n\nIMPORTANTE: este e-mail vai ser o mesmo que você vai conectar depois pra ENVIAR suas candidaturas (envio manual e automático). Guarde bem o acesso a ele.\n\nNão compartilhe este código com ninguém — a equipe do ${APP_NAME} nunca vai pedir ele por telefone ou WhatsApp.${rodape}`,
    };
  }
  function templateCodigoSenha({ codigo }) {
    return {
      subject: `${codigo} é o seu código pra redefinir a senha — ${APP_NAME}`,
      text: `Olá!\n\nRecebemos um pedido pra redefinir a senha da sua conta no ${APP_NAME}. Use o código abaixo:\n\n    ▶  ${codigo}  ◀\n\nEle vale por 5 minutos. Se você NÃO pediu pra trocar a senha, ignore este e-mail: sua senha continua a mesma e ninguém consegue entrar só com este código sem estar na tela de recuperação.\n\nNão compartilhe este código com ninguém.${rodape}`,
    };
  }

  return { status, conectar, desconectar, setAvisoPedidos, conectada, sendMail, accessToken, podeEnviar, gerarCodigo, confirmarCodigo, tokenVerificado, validarToken, templateCodigoCadastro, templateCodigoSenha, OUTBOX_FILE: OUTBOX, limites: { CODIGO_TTL_MS, MAX_TENTATIVAS, REENVIO_MS, MAX_ENVIOS, JANELA_ENVIOS_MS, TOKEN_TTL_MS } };
}

module.exports = { createNotif };
