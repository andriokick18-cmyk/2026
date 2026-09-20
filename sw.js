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
const CACHE_NAME = "h2bapply-2026-v88"; // v88: v227+v227b: pauseAuto/resumeAuto/stopAuto checam resposta do servidor antes de mudar UI; loadPlanos() com retry automático (3x) antes de mostrar erro na página de Planos v87: v87: v225: corrige erro técnico cru no login quando o servidor reinicia (deploy no Render) e ajusta texto da Central de Tutoriais pra não prometer foto que não existe em todo item v86: v86: v224: corrige 3 bugs reais do modal Filtrar vagas — Limpar tudo dessincronizado (rascunho x aplicado), race condition na contagem ao vivo e busca vazia zerando resultado v85: v85: v223: remove por completo a aba Vagas ao Vivo e a busca em tempo real ao DOL — o site só usa planilhas a partir de agora v84: v84: v221: corrige 2 achados da auditoria ao vivo pós-v220 (badge de aquecimento do Gmail admin sem sentido e label VIP Infinito colada no plano Máximo por engano do rename do v218) v83: v83: v220: remove por completo o sistema de código de migração VIP do site antigo (ordem do dono, 20/09/2026) v82: v82: v218: reestruturação de Planos — nomes/preços/limites novos (Manual/Turbo/Máximo), design com diamante SVG e FAQ, varredura técnica completa v81: v81: v218: prep pra reestruturação de Planos (preços/nomes/limites novos, diamante SVG, FAQ) v80: v80: v217: robôs de planilha (enriquecimento, vagas novas H-2A, H-2A/H-2B do mês) viram 100% manuais — sem agendamento automático nenhum, só clique do admin v79: v79: v216: hero da landing reorganizado — trocada a arte quebrada (Estátua da Liberdade cortada/com erro de português) por um preview clicável de capturas reais do site, e a seção 'Veja o site por dentro' subiu pra logo depois do hero v78: v78: v215b: banner grande e chamativo na landing (pre-login) apontando pro ambiente antigo (h2bapply.onrender.com), pra quem ainda tem dias VIP la v77: v77: v215: interruptor de emergencia de compra nova desligado por padrao (dominio h2bapply.com migrado de verdade pra este ambiente) + banner VIP do site antigo sempre visivel e chamativo (Planos + Home) v76: v76: v214: bloqueio de compra nova (prep migração de domínio h2bapply.com→ambiente novo) — banner + link explícito pro site antigo v75: v75: v213: corrige tag <div class="jcard"> sem fechar na aba ao vivo do DOL — Envio Manual travava em 'Selecione uma vaga' (bug pré-existente, achado ao vivo) v74: v74: v212: landing ganha screenshots reais do site ('Veja o site por dentro') no lugar da animação falsa 'Veja em ação' v73: v73: v211: remove filtro/faceta 'Status no DOL' (Certified/Pending/Withdrawn/Denied/Expired) — regra 0.2 cobre também filtro pago, não só badge grátis v72: v72: v209: admin não vê mais 'Grátis'/'Sem plano ativo' no Perfil (isAdminVip não depende dos relógios de VIP) v71: v71: v210: remove badge Ativa/Inativa dos cards e detalhe de vaga (regra 0.2 — nenhum status de vaga pro usuário, dado nunca reconferido) v70: v70: v208 — o robô de frescor foi retirado (vaga enriquecida uma vez só, nunca mais reconsultada) e a aba Planilhas & Robôs parou de falar em frescor v69: v69: v207 — robô de vagas novas H-2A cai pro dia anterior quando o DOL ainda não publicou o arquivo de hoje (erro honesto + nova tentativa em 1h); aba Notificações mostra a URL de retorno que precisa estar no Google Cloud Console e o erro do Google volta pro painel com o passo a passo v68: v68: v206 — códigos de migração VIP: quem tinha VIP no site antigo resgata os dias que sobraram na aba Planos com um código de uso único preso ao Gmail; painel admin ganhou a aba Códigos de migração (criar, importar em lote, mensagem de WhatsApp pronta) v67: v67: escape por expressao no innerHTML (XSS) e funcao morta showBanner removida v66: v66: CSS morto removido do index.html e dois ReferenceError de produção corrigidos (Home e app.js inteiro) v65: v65: v201 lote 19 — guardas da suíte que realmente guardam (o service worker agora é vigiado por impressão digital do front, não por um número que só cresce) v64: v64: v199 lote 18 — faxina no servidor: saiu tudo que sobrava da época em que o app lia a caixa de entrada (o app só envia), junto com o índice que era escrito a cada candidatura pra ninguém ler e dois vigias que só existiam no papel. v63: v199 lote 17 — o site é português fixo de verdade: uma conta que tivesse ficado em inglês (sem nenhum botão na tela pra voltar) volta sozinha pro português, e o dicionário perdeu 235 textos que nenhuma tela usava. v62: v198 lote 16 — faxina no front: o sistema de "Modelos de e-mail" (morto desde que o site parou de escrever texto pelo usuário) saiu inteiro, junto com 31 funções que ninguém chamava; o selo de plano do topo agora diz o que a conta realmente pode fazer hoje (quem só tem o robô não aparece mais como VIPro); o ícone do perfil deixou de ir cru pra tela; e o tema do atalho de teclado parou de brigar com o do botão. v61: v197 lote 15 — o site parou de prometer o que o programa não faz: sumiram "prioridade máxima na fila", "aumenta seu limite diário" e o robô de 400/dia; o intervalo do robô virou o REAL (~7 min, não 5–6) inclusive na previsão de quando a fila termina; o aviso de Gmail fala dos planos de verdade (VIP/VIPro 1 conta, DoublePro 2) e quem já paga não lê mais "assine um plano" ao bater o limite do dia. v60: v195 lote 14 — o proxy aberto pro site do DOL (que qualquer um podia usar com o IP do nosso servidor) foi removido, e o service worker parou de tratar /proxy como rota. v59: v195 lote 13 — reconectar o Gmail volta a ligar o robô sozinho (de onde parou) e as instruções de pausa por autenticação apontam pro cartão que existe, nos 3 idiomas; o selo 🌱 de aquecimento do Gmail principal finalmente aparece no Perfil e conta a partir do dia da CONEXÃO. v58: v189 lote 7 — o site parou de prometer notificação que não existe: o convite de push sumiu (o app nunca mandou nenhuma), e o 📡 Radar virou o que sempre foi de verdade, um filtro salvo que conta as vagas novas pra você ver quando abrir. v57: v188 lote 6 — painel admin com histórico de pedidos (aprovados/cancelados, por quem e por quê), plano do usuário por botão (somar dias, definir vencimento, revogar) e a lista de pagantes com o robô parado. v56: v187 lote 5 — quem já pagou nunca mais lê "assine de novo": o gate de plano (manual, automático e o toast do robô pausado) mostra que o pedido está com a equipe quando a janela provisória vence com o pedido ainda pendente. v55: v185 lote 3 — a jornada do pedido aparece: ativação provisória reflete na tela sem F5, pedido cancelado avisa o motivo na Home (com WhatsApp direto), "Próximo passo" leva quem não tem plano pra Planos e o passo 2 da compra só CONFIRMA os dados do cadastro. v54: v182 lote 10 — e-mail do empregador só viaja inteiro pra plano ativo; sem plano a vaga mostra "🔒 liberado com plano ativo" no lugar do endereço. v53: v182 lote 9 — filtro sem dado avisa em vez de sumir, × pra limpar a busca, alvos de toque de 44px, painel com foco/Escape/aria-pressed, ponte "usar os filtros da minha busca" no robô e 📡 Radar guardando os filtros inteiros. v52: v182 lote 8 — painel Planilhas & Robôs mostra o progresso REAL da alimentação (N/N completas · o que falta em cada planilha) em vez de "100%". v51: v181 — acabamento visto no Chromium (seção de plano pago não abre mais vazia; frase da dimensão de 1 valor só em PT correto). v50: v181 lote 7 — cargo por FAMÍLIA na lista de filtros (as 3 grafias de "Landscape Laborer" viraram 1 opção de 2.360; a H-2A caiu de 723 cargos pra 38 famílias) com o rótulo humano da grafia mais frequente. v49: v181 lote 6 — filtros novos que os dados sustentam: experiência exigida ("não exige experiência"), temporada (esconde por padrão a que já terminou, com chip "mostrar"), tipo de visto, mês de início COM ANO e a regra de dimensão com 1 valor só. v48: v181 lote 5 — a tela conta a mesma história que o servidor: busca do manual dentro do motor de filtros (painel e lista com o MESMO número), lista vazia que explica a causa, badge espelhando o motor, status do DOL em português, "Começa logo"/"Recentes" ordenando por data de verdade e painel que avisa em vez de girar pra sempre. v47: v180 — planilha importável pelo painel (botão Importar JSON), seed enriquecido vence esqueleto em /data, selo "MAIS NOVA" só pra planilha com e-mail (a sem e-mail aparece "em preparação"). v46: v179 lote 3 — busca honesta: a categoria parecida virou sugestão clicável na lista ("também há N em 🏗️ Construção"). v45: v179 lote 1 — chave canônica de cidade (rótulo "LaBelle · Flórida" no painel e nos chips) e $12/$15 na régua de salário. v44: v177-FIX8 — badge de plano do Perfil pela fonte única honesta (VIPro com 0 manuais/dia sumiu). v43: v177-FIX6 — convite de currículo/aviso de WhatsApp voltam a aparecer em LOGIN (não só no cadastro), logout limpa sessionStorage compartilhado, rótulos honestos no painel admin. v42: v177-FIX2 — 2ª leva de correções da auditoria de 135 agentes (ícone de perfil sem esc() no painel automático — XSS). v41: v177-FIX — 1ª leva de correções da auditoria de 135 agentes (robô parado invisível pro admin, aviso de compra vazando pra e-mails auxiliares, toggle de aviso não desligava de verdade, admin sem senha resetável por golpe, admin duplicado, tutorial com número errado). v40: v176 — bootstrap do e-mail de admin no cadastro (pula o código quando o e-mail digitado é de admin, aviso "confirmado automaticamente" no front). v39: v175b — e-mail admin do dono (andrio.usa2026) e do Diego como padrão; avisos de compra só pros 2 sócios (rótulo na aba Notificações). v38: v175 — cadastro com e-mail verificado por código, recuperação de senha, janela pós-cadastro, editor 3+3, aviso do e-mail no Gmail, aba Notificações. v37: v174b — log humano dos robôs na aba. v36: v174 — aba "Planilhas & Robôs" no painel admin (alimentação automática das planilhas: coleta DOL, enriquecimento, frescor, vagas novas H-2A, planilhas do mês).
// Impressão digital dos arquivos servidos ao cliente (index.html + admin.html + app.js + h2b-extras-user.js)
// no momento deste bump. O smoke recalcula e compara: se diferir, a suíte
// falha pedindo `npm run sw-bump`. NUNCA edite este valor à mão.
const CACHE_FRONT_FINGERPRINT = "4b00a2d6129f3da3";
// v31 (histórico): // v31: v172h (dono, 12/09/2026 — "verifique todo o site, tem muitas regras soltas, tudo errado... eu não quero nada do site antigo") — varredura geral por copy stale: FAQ da Home e da landing (h_faq_qty, como-usar.html) diziam "plano gratuito: 20 manuais + 10 automáticos por dia" e "não precisa pagar, 10 automáticos grátis pra todo mundo" — contradizia de frente a regra de zero envio grátis; JSON-LD de SEO também prometia envio grátis limitado (falso). Corrigido nos 3 idiomas + tour + landing + JSON-LD, e mais 2 lugares que descreviam "planos VIP" como se incluíssem automático (é só manual — VIPro/DoublePro é que incluem).

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

  // ── APIs e OAuth → sempre network, sem interceptar ──
  // (v195 lote 14: o /proxy saiu daqui junto com a rota — proxy aberto pro DOL
  // com o IP do servidor, sem sessão nem limite, e sem nenhum chamador.)
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/oauth/")
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
