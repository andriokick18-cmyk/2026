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

// 💸 v140 (conta do Render): agora entende resposta COMPRIMIDA (gzip/deflate/
// br) — quem pedir "Accept-Encoding: gzip" recebe ~80% menos bytes do DOL e
// dos servidores irmãos. Falha na descompressão cai no corpo cru (fail-open).
function httpsReq(opts,body){return new Promise((res,rej)=>{const p=body?(typeof body==="string"?body:JSON.stringify(body)):null;const finalOpts=opts.agent?opts:{...opts,agent:_keepAliveAgent};const r=https.request(finalOpts,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{let buf=Buffer.concat(ch);const enc=String(resp.headers["content-encoding"]||"").toLowerCase();try{if(enc.includes("gzip"))buf=zlib.gunzipSync(buf);else if(enc.includes("deflate"))buf=zlib.inflateSync(buf);else if(enc.includes("br"))buf=zlib.brotliDecompressSync(buf);}catch(e){}const raw=buf.toString();try{res({status:resp.statusCode,body:JSON.parse(raw)});}catch{res({status:resp.statusCode,body:raw});}});});r.on("error",rej);r.setTimeout(15000,()=>{r.destroy();rej(new Error("Timeout"));});if(p)r.write(p);r.end();});}

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

function buildMime({to,subject,text,fromName,fromEmail,attachments=[]}){ // v15-SEC: normaliza to
  to = normalizeEmail(to) || to;
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");const b64=s=>Buffer.from(s).toString("base64");const L=[`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,`To: ${to}`];L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`,"MIME-Version: 1.0");if(!attachments.length){L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);}else{L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");for(const a of attachments){const aMime=a.mime||"application/octet-stream";const aName=sanitizeHeaderField(a.name);L.push(`--${bnd}`,`Content-Type: ${aMime}; name="${aName}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${aName}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}L.push(`--${bnd}--`);}return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}

module.exports = { httpsReq, normalizeEmail, buildMime, sanitizeHeaderField };
