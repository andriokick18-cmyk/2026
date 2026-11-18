"use strict";
/* ═══════════════════════════════════════════════════════════════════════
   🎬 v988 — "Todos os vídeos do Diego" (aba 🎓 Tudo que agências cobram)

   Pedido do dono (via chat, 18/11/2026): mostrar DENTRO do site os vídeos do
   canal do sócio Diego (@diegopelomundo) com o player oficial do YouTube
   (embed — nunca baixar/copiar vídeo: cada view conta no canal dele).

   FONTE DA VERDADE = videos-diego.json (id, título, categoria, ordem, "assista
   se..."): editar o arquivo e subir já basta pra adicionar/reordenar vídeo.

   Complemento AUTOMÁTICO (best-effort, nunca quebra nada): o feed RSS oficial
   do canal (youtube.com/feeds/videos.xml?channel_id=...) traz os últimos
   vídeos publicados; os que ainda NÃO estão no JSON entram sozinhos na seção
   "Outros vídeos do canal" (marcados "novo" por 30 dias), pra ninguém precisar
   mexer em código quando o Diego postar. O RSS só é consultado de 6 em 6 horas
   (1h depois de uma falha), em segundo plano — a resposta da rota NUNCA espera
   o YouTube. Sem internet/sem RSS = só o JSON, exatamente como no deploy.

   O id do canal (UC...) é resolvido uma vez a partir da página @handle (ou
   fixado por env DIEGO_CHANNEL_ID / campo canal.channelId do JSON) e fica
   guardado em DATA_DIR/videos_diego_rss.json.
   ═══════════════════════════════════════════════════════════════════════ */
const https = require("https");
const http = require("http");

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const STALE_OK_MS = 6 * 3600_000;     // feed em dia: confere de novo em 6h
const STALE_FAIL_MS = 3600_000;       // falhou: tenta de novo em 1h (nunca martela o YouTube)
const NOVO_MS = 30 * 86400_000;       // selo "novo" dura 30 dias
const MAX_EXTRAS = 40;
const ASSISTA_PADRAO = "Vídeo do canal do Diego. Veja o título e decida se é o seu caso — se tiver dúvida, comece pelos vídeos de “Comece por aqui”.";

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Feed Atom do YouTube → [{id, titulo, publicado(ms)}] (mais novo primeiro, como o YouTube entrega).
function parseFeed(xml) {
  const out = [];
  for (const blk of String(xml || "").split(/<entry[\s>]/).slice(1)) {
    const id = (/<yt:videoId>\s*([^<\s]+)\s*<\/yt:videoId>/.exec(blk) || [])[1];
    if (!id || !ID_RE.test(id)) continue;
    const titulo = decodeEntities(((/<title[^>]*>([\s\S]*?)<\/title>/.exec(blk) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim().slice(0, 200);
    const pub = Date.parse((/<published>\s*([^<\s]+)\s*<\/published>/.exec(blk) || [])[1] || "");
    out.push({ id, titulo: titulo || "Vídeo do canal", publicado: Number.isFinite(pub) ? pub : 0 });
  }
  return out;
}

// Página do canal (@handle) → id UC... Só canonical/externalId/itemprop (do PRÓPRIO canal): um "channelId" solto na página pode ser de canal relacionado e ficaria gravado pra sempre.
function extractChannelId(html) {
  const h = String(html || "");
  const pats = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[A-Za-z0-9_-]{22})["']/i,
  ];
  for (const p of pats) { const m = p.exec(h); if (m && CHANNEL_RE.test(m[1])) return m[1]; }
  return null;
}

function fetchText(url, { timeoutMs = 8000, maxBytes = 3_000_000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error("URL inválida")); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return reject(new Error("protocolo não permitido"));
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.get(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; H2BApply/1.0)", "Accept-Language": "pt-BR,pt;q=0.9", "Cookie": "CONSENT=YES+1" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(fetchText(new URL(res.headers.location, u).toString(), { timeoutMs, maxBytes, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let n = 0; const ch = [];
      res.on("data", (c) => { n += c.length; if (n > maxBytes) { req.destroy(new Error("resposta grande demais")); return; } ch.push(c); });
      res.on("end", () => resolve(Buffer.concat(ch).toString("utf8")));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    const prazo = setTimeout(() => req.destroy(new Error("timeout total")), timeoutMs * 2); if (prazo.unref) prazo.unref();   // resposta gotejada (1 byte/s) não prende o refresh: prazo ABSOLUTO além do ocioso
    req.on("close", () => clearTimeout(prazo));
    req.on("error", reject);
  });
}

function createVideosDiego({ fs, path, DATA_DIR, baseFile, env }) {
  const E = env || process.env;
  const stateFile = path.join(DATA_DIR, "videos_diego_rss.json");
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {}; } catch { state = {}; }
  let running = false;
  const saveState = () => { try { const tmp = stateFile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, stateFile); } catch (e) { console.warn("[videos-diego] estado não gravado:", e.message); } };

  // ── base: videos-diego.json (relido quando o arquivo muda; JSON quebrado nunca derruba a aba — mantém o último bom)
  let baseCache = null, baseMtime = 0;
  function loadBase() {
    try {
      const mt = fs.statSync(baseFile).mtimeMs;
      if (baseCache && mt === baseMtime) return baseCache;
      const raw = JSON.parse(fs.readFileSync(baseFile, "utf8"));
      const cats = (Array.isArray(raw.categorias) ? raw.categorias : []).filter((c) => c && /^[a-z0-9_-]{2,30}$/.test(c.id) && c.titulo)
        .map((c) => ({ id: c.id, titulo: String(c.titulo).slice(0, 80), emoji: String(c.emoji || "").slice(0, 8), ordem: Number(c.ordem) || 99, descricao: String(c.descricao || "").slice(0, 240) }))
        .sort((a, b) => a.ordem - b.ordem);
      const catIds = new Set(cats.map((c) => c.id));
      const seen = new Set();
      const videos = [];
      for (const v of (Array.isArray(raw.videos) ? raw.videos : [])) {
        if (!v || !ID_RE.test(String(v.id || "")) || seen.has(v.id)) continue;
        seen.add(v.id);
        videos.push({
          id: v.id, titulo: String(v.titulo || "Vídeo do canal").slice(0, 200),
          categoria: catIds.has(v.categoria) ? v.categoria : "outros",
          ordem: Number(v.ordem) || 999, assista: String(v.assista || ASSISTA_PADRAO).slice(0, 400),
          ...(v.duracao ? { duracao: String(v.duracao).slice(0, 12) } : {}),
        });
      }
      baseCache = {
        canal: { handle: String((raw.canal && raw.canal.handle) || "@diegopelomundo"), url: String((raw.canal && raw.canal.url) || "https://www.youtube.com/@diegopelomundo"), channelId: (raw.canal && CHANNEL_RE.test(String(raw.canal.channelId || ""))) ? raw.canal.channelId : null },
        categorias: cats, videos,
      };
      baseMtime = mt; return baseCache;
    } catch (e) {
      if (baseCache) return baseCache;
      console.warn("[videos-diego] videos-diego.json ilegível:", e.message);
      return { canal: { handle: "@diegopelomundo", url: "https://www.youtube.com/@diegopelomundo", channelId: null }, categorias: [{ id: "outros", titulo: "Vídeos do canal", emoji: "🎞️", ordem: 1, descricao: "" }], videos: [] };
    }
  }

  const devido = (agora = Date.now()) => !state.em || agora - state.em > (state.ok ? STALE_OK_MS : STALE_FAIL_MS);

  async function resolveChannelId(base) {
    const fixo = E.DIEGO_CHANNEL_ID || base.canal.channelId || state.canalId;
    if (fixo && CHANNEL_RE.test(fixo)) return fixo;
    const html = await fetchText(E.YT_CHANNEL_PAGE_URL || base.canal.url);
    const id = extractChannelId(html);
    if (!id) throw new Error("não achei o id do canal na página");
    return id;
  }

  async function refresh(force) {
    if (running) return false;
    if (!force && !devido()) return false;
    running = true;
    const agora = Date.now();
    try {
      const base = loadBase();
      const canalId = await resolveChannelId(base);
      const feedBase = E.YT_FEED_BASE || "https://www.youtube.com/feeds/videos.xml";
      const xml = await fetchText(`${feedBase}${feedBase.includes("?") ? "&" : "?"}channel_id=${encodeURIComponent(canalId)}`);
      const lista = parseFeed(xml);
      if (!lista.length) throw new Error("feed sem nenhum vídeo");
      state = { em: agora, ok: true, canalId, extras: lista.slice(0, 60), erro: null };
      return true;
    } catch (e) {
      state = { ...state, em: agora, ok: false, erro: String(e.message).slice(0, 160) };   // mantém os extras antigos
      return false;
    } finally { running = false; saveState(); }
  }

  function getPayload() {
    const base = loadBase();
    if (devido() && !running) refresh(false).catch(() => { });   // em segundo plano: a resposta nunca espera o YouTube
    const conhecidos = new Set(base.videos.map((v) => v.id));
    const agora = Date.now();
    const extras = (state.extras || []).filter((x) => ID_RE.test(String(x.id || "")) && !conhecidos.has(x.id)).slice(0, MAX_EXTRAS)
      .map((x, i) => ({ id: x.id, titulo: String(x.titulo || "Vídeo do canal").slice(0, 200), categoria: "outros", ordem: 1000 + i, assista: ASSISTA_PADRAO, ...(x.publicado && agora - x.publicado < NOVO_MS ? { novo: true } : {}) }));
    const videos = [...base.videos, ...extras].sort((a, b) => a.ordem - b.ordem);
    return { ok: true, canal: { handle: base.canal.handle, url: base.canal.url }, categorias: base.categorias, videos, fonte: { rss: !!state.ok, atualizadoEm: state.ok ? state.em : null, extras: extras.length } };
  }

  return { getPayload, refresh, loadBase, estado: () => ({ ...state }) };
}

module.exports = { createVideosDiego, parseFeed, extractChannelId, fetchText, decodeEntities, ID_RE, CHANNEL_RE };
