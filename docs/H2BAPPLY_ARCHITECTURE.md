# H2BApply — Arquitetura (v1, 19/09/2026)

> Mapa de como as peças se conectam. Será refinado pela auditoria profunda
> (frente "dados-banco-arquitetura"). Servidor único, sem multi-servidor.

## Visão geral

- **Frontend**: `index.html` (landing + app de página única com views
  `v-home`, `v-jobs`, `v-hist`, `v-logs`, `v-profile`, `v-auto`, `v-plans`,
  `v-tutorial`, `v-settings`), `app.js` (lógica do app e `LANG_DICT`),
  `admin.html` (painel, login por usuário+senha: overview, usuários,
  pedidos, códigos de migração, notificações, planilhas e robôs),
  `h2b-extras-user.js`, `sw.js` (PWA, `CACHE_NAME` + impressão digital
  do front), `manifest.json`, páginas públicas (`guia.html`,
  `quanto-ganha-h2b.html`, `h2bapply-funciona.html`, `h2b-e-golpe.html`,
  `como-usar.html`, `tutorial-conteudo.html`, `diagnostico.html`) e
  templates gerados no servidor (`/vagas-h2b`, `/privacidade`, `/termos`,
  `/excluir-conta`, `/google-data-usage`, `/contato`).
- **Backend**: `server.js` (Node `http`, monólito com as rotas como
  `if (pathname === ...)`) + módulos por injeção de dependências:
  `mod-config.js` (envs e tabelas de plano), `mod-gmail.js` (HTTP para o
  Gmail/OAuth e montagem MIME), `mod-engine-core.js` (intervalo humanizado
  do robô), `mod-filtros.js` (motor único de filtros/facetas),
  `mod-planilhas.js` (coleta, enriquecimento e planilhas do mês a partir do
  DOL — cada vaga é enriquecida uma única vez pelo ETA Case Number e não é
  reconsultada depois; ver `H2BAPPLY_PRODUCT_RULES.md` 7b), `mod-vagas-integrity.js` (1 vaga = 1 ETA Case Number),
  `mod-notif.js` (conta Google de notificações: códigos de cadastro/senha,
  aviso de pedido aos sócios), `mod-sentinel.js` (vigia de saúde),
  `mod-watchdogs.js` (token guardian e robô parado por auth),
  `mod-admin-health.js` e `mod-admin-v2.js` (saúde e backup/restore),
  `storage.js` (gravação atômica JSON + SQLite dual-write).
- **Rotas**: ~94 `/api/admin/*` (sessão de painel obrigatória), `/api/status`,
  cadastro/login/senha, perfis e currículos (`/api/profiles`, `/api/cv*`),
  vagas (`/api/sheet-meta`, `/api/sheet-detail`, `/api/sheet-batch`,
  `/api/jobs`, `/api/vagas/filtros`, `/api/jobs/pra-voce`), envio
  (`/api/send`, `/api/auto/*`, `/api/history`, `/api/auto-logs`), planos e
  pedidos (`/api/planos`, `/api/pedido*`, `/api/vip/resgatar-codigo`),
  OAuth (`/oauth/connect-send`, callback), rotas de teste (`/api/test/*`, só
  com `TEST_LOGIN_TOKEN`).

## Dados (`DATA_DIR`, disco persistente do Render)

JSON por coleção com espelho em SQLite (`storage.js`): `users.json`
(conta, perfil, VIP com `vip.limits`/`vip.creditos`, Gmail de envio,
extras), `history.json` (candidaturas enviadas), `sent_emails.json` (regra
anti-duplicado por e-mail de empregador), `auto_jobs.json` (fila do robô),
`auto_logs.json`, `pedidos.json` (pedidos de plano; comprovantes em
`comprovantes/`), `financeiro.json` (caixa, gastos, repasses),
`fechamentos.json`, `admin_audit.json`, `admin_settings.json`,
`journey.json`, `reviews.json`, `blocked_emails.json`, `invalid_emails.json`,
`email_corrections.json`, `temp_failures.json`, `sessions.json` (só OAuth em
andamento; login não sobrevive a deploy, de propósito), `notif_*.json`,
`migration_codes.json`, planilhas (`*_compact.json`, `sheets/`,
`sheets_meta.json`, `h2a_bimestral.json`, `h2b_mensal.json`), currículos em
PDF em `cvs/`, backups em `backups/`. Chave do usuário: `email` (para conta
nova é o username sem `@`; o Gmail confirmado fica em `emailContato`).

## Robôs e vigias (setInterval no `server.js` e módulos)

Persistência de logs (10 min), checagem de disco (15 min), backup diário e
de boot (pula se o mais recente tem menos de 12 h), limpeza de sessões,
cache de vagas ao vivo, cooldowns de notificação (5 min), sentinela de
saúde, token guardian e watchdog de robô parado, enriquecimento das
planilhas (30 min), planilhas do mês (12 h), pulso de memória (6 h),
motor de envio automático (timer por usuário, ~7 min entre envios).

## Integrações externas

- **Google OAuth + Gmail API**: escopos `openid email profile
  https://www.googleapis.com/auth/gmail.send` (só envio; nunca leitura).
  Redirect URIs construídos de um allowlist de hosts. Em teste, os hosts
  `gmail.googleapis.com` e `oauth2.googleapis.com` podem ser redirecionados
  para um servidor falso local, só com `TEST_LOGIN_TOKEN` +
  `GOOGLE_FAKE_BASE` em loopback.
- **DOL / SeasonalJobs**: feed ZIP e API por case number (enriquecimento,
  vagas ao vivo), com ritmo educado e backoff em 403; em teste,
  `DOL_FEED_BASE`/`DOL_API_BASE` apontam para o feed falso.
- **Gemini**: só para ler o comprovante de PIX (valor/data/pagador) no
  pré-check do pedido; nunca decide sozinho, o admin confirma.
- **Render**: hospedagem (Node 22, `.node-version`), disco persistente em
  `/data`, hibernação no plano Free (primeiro acesso lento), envs em
  `.env.example`.
- **GitHub**: repositório público `andriokick18-cmyk/2026`, branch `main`;
  CI em `.github/workflows/ci.yml` roda `npm test`.

## Fluxo de uma candidatura

Vaga (planilha) → usuário escolhe perfil (assunto/corpo/currículo próprios)
→ `/api/send` (gate de plano, Gmail conectado, anti-duplicado, limite do
dia, cooldown) → Gmail API com token renovado se preciso → `markSent`
síncrono → `history.json` → tela Enviadas. Automático: fila em
`auto_jobs.json`, um envio a cada ~7 min por usuário, mesma régua.
