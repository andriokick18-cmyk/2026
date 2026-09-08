// ══════════════════════════════════════════════════════════
//  H2BApply — Service Worker v2.4
//  Estratégia: Network-first para APIs,
//              Cache-first para fontes/ícones (stale-while-revalidate)
//              HTML NUNCA cacheado (preserva cookie de sessão OAuth)
//  + Push Notifications + notificationclick + message handler
// ══════════════════════════════════════════════════════════
//
//  HISTÓRICO DE CORREÇÕES:
//
//  v2.1 (bug) — CACHE_NAME dinâmico via hash assíncrono.
//    Problema: activate disparava com nome antigo e apagava o cache
//    recém-criado no install. SW interceptava "/" sem cache → cookie
//    de sessão se perdia no redirect pós-OAuth.
//
//  v2.2 — CACHE_NAME fixo (como no backup estável).
//
//  v2.3 — HTML removido do SHELL_URLS e nunca cacheado.
//    Motivo: cookie h2b_session é setado via Set-Cookie no /oauth/callback.
//    Se SW devolve "/" do cache, o browser não envia o cookie em /api/status
//    → app acha que está deslogado → loop de login infinito.
//    BUG-013: fetch de fontes retornava undefined ao falhar; corrigido para 503.
//
//  v2.4 — Bump de versão para forçar reinstalação limpa em todos os clientes.
//    Nenhuma mudança lógica; apenas limpeza de código e documentação.
//
//  v2.5 — Bump de rotina (KB-072): correção do Robô Monitor DOL (403 no
//    download ao vivo + baseline anti-spam + janelas de log separadas
//    teste/produção). admin.html não é cacheado pelo SW (ver nota acima),
//    então o bump aqui é só por convenção de entrega do projeto.
//
//  v2.6 — Bump de rotina (KB-073): correção de INCIDENTE REAL — o robô
//    notificou pagantes 5x sobre relatórios históricos (FY23-25). Fix:
//    ranking cronológico (reportRank/latestKnownRank) + crash de parsing
//    corrigido + estrutura de backfill histórico com janela própria.
//
//  v2.7 — Bump de rotina (KB-074): PublicFacingReport tem muito mais dado
//    do que se pensava (empresa/estado/data de início) — parser expandido
//    e registro ETA enriquecido automaticamente nos 3 caminhos.
//
//  v2.8 — Bump de rotina (KB-075): orquestrador de coleta histórica
//    completa (6 temporadas, vagas com e-mail) + reestruturação visual
//    das abas (seção recolhível "Temporadas Anteriores", Manual+Automático).
//
const CACHE_NAME = "h2bapply-2026-v2"; // v2: remoção do subsistema órfão de Respostas/Inbox e do push VAPID quebrado, textos corrigidos, botão Extras restaurado

// Recursos estáticos que ficam em cache para uso offline.
// HTML NÃO entra aqui — ver motivo acima (cookie de sessão).
const SHELL_URLS = [
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap",
  "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.29.0/dist/tabler-icons.min.css",
];

// ── Instalação: pré-carrega o shell ──────────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[sw] Cache miss:", url, err.message);
          })
        )
      );
    })
  );
  // Ativa imediatamente sem esperar tabs antigas fecharem
  self.skipWaiting();
});

// ── Ativação: remove todos os caches de versões anteriores ───
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => {
              console.log("[sw] Removendo cache antigo:", k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch: estratégia por tipo de requisição ─────────────
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Só intercepta GET
  if (e.request.method !== "GET") return;
  // Ignora extensões do Chrome
  if (url.protocol === "chrome-extension:") return;

  // ── APIs, OAuth e proxy → sempre network, sem interceptar ──
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/oauth/") ||
    url.pathname.startsWith("/proxy")
  ) {
    return;
  }

  // ── HTML → sempre network, NUNCA cacheia ──
  // Cookie h2b_session é definido via Set-Cookie no /oauth/callback.
  // Se o SW devolver o HTML do cache, o cookie não acompanha a requisição
  // de /api/status → app considera deslogado → loop de login.
  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    (e.request.headers.get("accept") || "").includes("text/html")
  ) {
    e.respondWith(
      fetch(e.request).catch(() =>
        // Fallback offline: tenta cache como último recurso
        caches
          .match("/index.html")
          .then((r) => r || new Response("Offline", { status: 503 }))
      )
    );
    return;
  }

  // ── Fontes e ícones CDN → Stale-while-revalidate ──
  // Serve do cache imediatamente (fast), revalida em background.
  if (
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com") ||
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("unpkg.com")
  ) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(e.request);
        const fetchPromise = fetch(e.request)
          .then((res) => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(
            () =>
              cached ||
              new Response("", {
                status: 503,
                statusText: "Service Unavailable",
              })
          );
        // Retorna cache imediato se disponível, caso contrário aguarda rede
        return cached || fetchPromise;
      })
    );
    return;
  }

  // ── Demais recursos estáticos → Network-first com fallback para cache ──
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── Push Notifications ────────────────────────────────────
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = {
      title: "H2BApply",
      body: e.data ? e.data.text() : "Nova notificação",
    };
  }

  const title = data.title || "✈️ H2BApply";
  const options = {
    body: data.body || "Você tem uma nova notificação.",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || "h2b-notif",
    data: {
      url: data.url || "/",
      sound: data.sound || "aviao",
      appId: data.appId || null,
    },
    requireInteraction: true,
    vibrate: [200, 100, 200],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification Click ─────────────────────────────────────
self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  const notifData = e.notification.data || {};
  // v72: sem aba Respostas, o destino padrão de push é a Home (cada push
  // real — diamante creditado, missão cumprida, plano ativado — já manda
  // sua própria url específica; isto é só o fallback genérico).
  const targetUrl = notifData.url || "/";
  const sound = notifData.sound || "aviao";
  const appId = notifData.appId || null;

  e.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Se já há uma aba do app aberta: foca e navega
        for (const client of clientList) {
          try {
            const clientUrl = new URL(client.url);
            if (
              clientUrl.origin === self.location.origin &&
              "focus" in client
            ) {
              client.focus();
              client.postMessage({ type: "navigate", url: targetUrl, sound, appId });
              return;
            }
          } catch {
            /* client.url pode ser opaco em alguns contextos */
          }
        }
        // Nenhuma aba aberta → abre nova
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});

// ── Message Handler ───────────────────────────────────────
self.addEventListener("message", (e) => {
  if (!e.data) return;

  // Força atualização imediata: postMessage({ type: "SKIP_WAITING" })
  if (e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  // Health check do frontend: postMessage({ type: "PING" })
  if (e.data.type === "PING") {
    e.source?.postMessage({ type: "PONG", cacheName: CACHE_NAME });
    return;
  }
});

// ── Notification Close ────────────────────────────────────
self.addEventListener("notificationclose", (_e) => {
  // Telemetria silenciosa — sem ação necessária por ora
});
