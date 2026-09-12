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
//  v2.9 — Bump de rotina (regra 6c, v170): sistema de diamantes retirado
//    por completo — compra DIRETA de plano (preço em R$ sempre visível
//    ANTES do pagamento, GET /api/planos como fonte única) + clickwrap de
//    consentimento informado no checkout. index.html (view Planos + textos
//    espalhados) e app.js (funções de compra) mudaram juntos.
//
//  v2.10 — Bump de rotina (regra 6c, v171 — auditoria mobile 09/09):
//    bottom-nav mobile de 3→5 itens (Início/Vagas/Enviadas/Perfil/Mais) com
//    menu "Mais" novo; CSS duplicado/conflitante de .bottom-nav/.bn
//    consolidado numa fonte única; 5 alvos de toque corrigidos pra ≥44px;
//    grid de 5 colunas de v-logs virou responsivo; SHELL_URLS corrigido pra
//    bater com as URLs reais (fonte de ícones não era cacheada de verdade);
//    bug real achado nesta auditoria: as 10 miniaturas do tour de boas-vindas
//    apontavam pra /tutorial-img/ (pasta em disco) em vez de /tut-img/ (rota
//    real) — 404 silencioso desde sempre, corrigido junto.
//
//  v2.11 — Bump de rotina (regra 6c): faxina de resquícios de features
//    removidas (ranking/gamificação, chat/"Respostas", atalhos antigos da
//    Home, drawer) — só CSS/JS morto sem HTML correspondente, nenhuma
//    mudança visual pra quem usa o app hoje (provado com Playwright antes
//    e depois: telas idênticas).
//
//  v2.12 — Bump de rotina (auditoria de segurança, 10/09/2026): 6 innerHTML
//    do app.js passaram a escapar com esc() dado que vinha de fora sem
//    escape nenhum (foto de perfil do Google, e-mail/rótulo de Gmail
//    extra, nome de perfil de vaga, corpo de template salvo) — guarda
//    nova check-xss-guard.js impede um innerHTML novo de esquecer o esc().
//
//  v2.13 — Bump de rotina (LGPD art. 18-V, 10/09/2026): botão novo
//    "Baixar meus dados" em Configurações (index.html) + downloadMyData()
//    (app.js) — portabilidade self-service, sem precisar pedir a ninguém.
//
//  v2.14 — Bump de rotina (auditoria em background, 10/09/2026): limite de
//    tamanho de currículo/carta mostrado ao usuário (10MB) não batia com o
//    que o servidor realmente aceita (5MB/3MB) — corrigido nas 3 telas de
//    upload + guarda i18n atualizada. Removida também uma tela inteira
//    "Documentos" morta (uploadDoc/renderDocs/showSessionExpiredModal e
//    companhia — zero chamador real, confirmado antes de apagar).
//
//  v2.15 — Bump de rotina (dono, 11/09/2026): checklist de consentimento da
//    compra reescrito pra falar com o cliente (não com o admin) e sem a
//    promessa de "direito de arrependimento de 7 dias" (removida também dos
//    Termos — seção renumerada 1-12).
//
const CACHE_NAME = "h2bapply-2026-v23"; // v23: faxina do sistema antigo (ordem do dono, 12/09) — removido tudo que sobrou do login por Google/ranking/VAPID/código promo/aba Respostas/aviso de reset já mortos por ordens anteriores (server.js, app.js, index.html, mod-config.js, mod-engine-core.js, reset_h2bapply.js, tutorial-conteudo.html, como-usar.html) + h2b-extras-admin.js e mod-notif-templates.js excluídos por inteiro (órfãos)

// Recursos estáticos que ficam em cache para uso offline.
// HTML NÃO entra aqui — ver motivo acima (cookie de sessão).
// v171 (auditoria mobile 09/09): as 2 URLs aqui embaixo NUNCA batiam com o
// que o index.html realmente pede — a fonte de ícones (889KB, a maior peça
// estática do app) vinha de um CDN que o HTML não usa mais (ele carrega
// /vendor/tabler-icons.min.css local), e a URL do Google Fonts estava
// incompleta (faltava a família Sora e os parâmetros de peso corretos).
// Resultado: nenhuma das duas nunca era reaproveitada do cache do SW —
// corrigido pra bater exatamente com os <link> reais do <head>.
const SHELL_URLS = [
  "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&family=Sora:wght@700;800&display=swap",
  "/vendor/tabler-icons.min.css",
  "/vendor/fonts/tabler-icons.woff2",
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
  // real — pedido confirmado, plano ativado — já manda sua própria url
  // específica; isto é só o fallback genérico).
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
