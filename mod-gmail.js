/* ═══════════════════════════════════════════════════════════════════════
   📧 src/gmail.js — Fase 1 da Transformação · Módulo 2 (extraído do server.js)
   Helpers PUROS de e-mail: httpsReq, normalizeEmail, buildMime,
   buildMimeWithHeaders. Sem estado, sem sessões — as funções que USAM
   sessão (gmailSend etc.) permanecem no server.js por enquanto.
   Extração mecânica: corpos idênticos aos originais.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");

// PERF FIX (V-perf): antes cada chamada a gmail.googleapis.com / oauth2.googleapis.com
// abria uma conexão TCP+TLS NOVA do zero (handshake completo a cada envio manual).
// Um Agent com keep-alive reaproveita o socket já autenticado entre requisições,
// cortando 1 round-trip de handshake por envio — ajuda diretamente na lentidão
// relatada no Envio Manual (30s por clique).
const _keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50, maxFreeSockets: 10 });

// 🧪 v202 LOTE 20 — GOOGLE FALSO NO `npm test` (mesma régua do DOL_API_BASE/
// DOL_FEED_BASE do v182). O motor de envio inteiro (manual, automático,
// renovação de token, sentinela) fala com hosts FIXOS do Google, então
// NENHUM envio jamais acontecia na suíte: as garantias mais caras do repo
// — token vencido no meio da fila que renova e re-tenta a MESMA vaga (v165),
// erro nos passos pós-envio que não pode virar "falha" (v177-FIX3), extra
// com auth morta isolado enquanto o robô segue pelas outras contas — eram
// provadas só por grep de string no server.js (renomear um log quebrava o
// teste; quebrar a lógica mantendo o texto passava verde).
// Este é o ÚNICO funil de rede do módulo. Ele aceita redirecionar SÓ os 2
// hosts EXATOS do Google — NUNCA um wildcard `*.googleapis.com` (o DOL, o
// userinfo e o Gemini continuam indo pro host real sempre) — e SÓ com DUPLA
// TRAVA: `TEST_LOGIN_TOKEN` presente (proibido em produção, regra da casa) E
// `GOOGLE_FAKE_BASE` apontando pra http://127.0.0.1|localhost. Qualquer
// outra combinação (env faltando, host remoto, https, porta de fora) vai pro
// Google de verdade, exatamente como sempre foi.
const GOOGLE_REWRITABLE_HOSTS = new Set(["gmail.googleapis.com", "oauth2.googleapis.com"]);
function _googleFakeTarget(hostname){
  if (!process.env.TEST_LOGIN_TOKEN) return null;
  if (!GOOGLE_REWRITABLE_HOSTS.has(String(hostname || "").toLowerCase())) return null;
  let u; try { u = new URL(String(process.env.GOOGLE_FAKE_BASE || "")); } catch { return null; }
  if (u.protocol !== "http:") return null;
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
  return { hostname: u.hostname, port: Number(u.port || 80) };
}

// 💸 v140 (conta do Render): agora entende resposta COMPRIMIDA (gzip/deflate/
// br) — quem pedir "Accept-Encoding: gzip" recebe ~80% menos bytes do DOL e
// dos servidores irmãos. Falha na descompressão cai no corpo cru (fail-open).
//
// 🚨 v237l (achado de auditoria — Alta, gmail-envio): as duas rejeições
// abaixo (erro de socket / timeout de 15s) acontecem SEM nenhuma resposta
// HTTP ter voltado — pro caso do Gmail (messages/send), isso significa que
// NÃO DÁ PRA SABER se o Google já recebeu e processou o envio antes da
// conexão cair (o "timeout ambíguo"). `err.noResponse=true` marca essa
// ambiguidade pro chamador: os pontos em server.js que decidem reenviar a
// MESMA candidatura por outra conta Gmail depois de uma falha (envio manual
// com sender extra e round-robin manual) checam essa marca e RECUSAM o
// reenvio automático quando ela está presente — nunca arriscar mandar a
// mesma candidatura 2x pro mesmo empregador só porque a resposta sumiu no
// caminho. Quando a resposta CHEGA (mesmo um erro do Gmail, ex. HTTP 500 ou
// {error:...} no corpo), não há ambiguidade — o Google confirmou que não
// processou, e cair pro remetente principal continua seguro.
function httpsReq(opts,body){
  return new Promise((res,rej)=>{
    const p=body?(typeof body==="string"?body:JSON.stringify(body)):null;
    const fake=_googleFakeTarget(opts&&opts.hostname);
    const mod=fake?require("http"):https;
    const finalOpts=fake?{...opts,agent:undefined,hostname:fake.hostname,port:fake.port,headers:{...(opts.headers||{}),"x-google-host":String(opts.hostname)}}:(opts.agent?opts:{...opts,agent:_keepAliveAgent});
    const rejNoResponse=(err)=>{ err.noResponse=true; rej(err); };
    const r=mod.request(finalOpts,resp=>{
      const ch=[];
      resp.on("data",c=>ch.push(c));
      resp.on("end",()=>{
        let buf=Buffer.concat(ch);
        const enc=String(resp.headers["content-encoding"]||"").toLowerCase();
        try{if(enc.includes("gzip"))buf=zlib.gunzipSync(buf);else if(enc.includes("deflate"))buf=zlib.inflateSync(buf);else if(enc.includes("br"))buf=zlib.brotliDecompressSync(buf);}catch(e){}
        const raw=buf.toString();
        try{res({status:resp.statusCode,body:JSON.parse(raw)});}catch{res({status:resp.statusCode,body:raw});}
      });
    });
    r.on("error",rejNoResponse);
    r.setTimeout(15000,()=>{r.destroy();rejNoResponse(new Error("Timeout"));});
    if(p)r.write(p);
    r.end();
  });
}

function normalizeEmail(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  // Extrai de "Nome <email@x.com>" ou "<email@x.com>"
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) s = angleMatch[1].trim();
  // Remove caracteres indevidos e normaliza
  s = s.replace(/[<>"'\s]/g, "").toLowerCase();
  return s;
}

// v18-SEC: sanitiza qualquer valor antes de virar cabeçalho MIME cru.
// Sem isso, um nome de anexo (ou In-Reply-To/References vindos do cliente,
// ver server.js) contendo \r\n podia injetar cabeçalhos MIME arbitrários
// (ex: um Bcc: escondido) na mensagem enviada pela CONTA GMAIL DO PRÓPRIO
// USUÁRIO — risco de abuso/spam e possível suspensão da conta dele pelo Google.
function sanitizeHeaderField(s, maxLen){
  return String(s==null?"":s).replace(/[\r\n\t]+/g," ").slice(0, maxLen||200);
}

// 🐛 v172c (bug real corrigido, 12/09/2026): login normal virou usuário+senha
// e o username escolhido (SEM @, validado no cadastro pra nunca ser e-mail)
// fica gravado como identidade (u.email/session.user_email) — mas quem
// realmente ENVIA precisa de um endereço Gmail de verdade. Pra conta nova
// isso só existe depois de conectar o Gmail em /oauth/connect-send, gravado
// à parte em u.gmailEmail (NUNCA confundido com a identidade de login).
// resolveSendGmail devolve o Gmail que essa conta já tem pra enviar/travar
// reconexão: o gmailEmail carimbado, OU (conta LEGADA pré-v172c) o próprio
// e-mail de login quando ele já é um Gmail de verdade — null só quando é
// conta nova que ainda não conectou nenhum Gmail (1ª conexão, aceita
// qualquer conta Google que a pessoa escolher).
function resolveSendGmail(owner){
  if (owner?.gmailEmail) return String(owner.gmailEmail).toLowerCase().trim();
  const em = String(owner?.email||"").toLowerCase().trim();
  return em.includes("@") ? em : null;
}

function buildMime({to,subject,text,fromName,fromEmail,attachments=[]}){ // v15-SEC: normaliza to
  to = normalizeEmail(to) || to;
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");const b64=s=>Buffer.from(s).toString("base64");const L=[`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,`To: ${to}`];L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`,"MIME-Version: 1.0");if(!attachments.length){L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);}else{L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");for(const a of attachments){const aMime=a.mime||"application/octet-stream";const aName=sanitizeHeaderField(a.name);L.push(`--${bnd}`,`Content-Type: ${aMime}; name="${aName}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${aName}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}L.push(`--${bnd}--`);}return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}

// `_googleFakeTarget` é exportado SÓ pra guarda permanente do smoke: é a
// regra que decide se uma credencial do Google pode ser mandada pra outro
// lugar, e ela precisa ser provada combinação a combinação (sem env, host
// remoto, https, outro hostname) sem tocar rede nenhuma.
module.exports = { httpsReq, normalizeEmail, buildMime, sanitizeHeaderField, resolveSendGmail, _googleFakeTarget };
