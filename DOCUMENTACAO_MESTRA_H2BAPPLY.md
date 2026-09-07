# 📘 DOCUMENTAÇÃO MESTRA — H2BApply v15

> **Constituição Técnica Oficial do Projeto.**
> Gerada a partir da análise do código real (server.js ~11.100 linhas, index.html ~16.600, admin.html ~13.000). Nada aqui é suposição: descreve o stack que o sistema **realmente** usa.

> ⚠️ **Nota de stack:** O H2BApply **NÃO** usa Supabase, banco relacional, RLS, Edge Functions, React, hooks ou pastas `/src`. É um **monólito Node.js com bibliotecas nativas**, frontend **HTML/JS vanilla (SPA)** e **persistência em arquivos JSON**. As seções abaixo documentam o que existe de fato e, onde o stack clássico não se aplica, explicam o equivalente usado.

---

## ÍNDICE

1. Visão Geral
2. Arquitetura
3. Estrutura de Arquivos
4. "Banco de Dados" (stores JSON)
5. Persistência e o disco `/data`
6. Autenticação e Sessão (Google OAuth)
7. Planos, VIP e Limites
8. Sistema de Vagas (Planilhas)
9. Sistema Manual
10. Sistema Automático (motor de envio)
11. Inteligência Artificial (Gemini)
12. Bot de Coleta DOL e Enriquecimento
13. Administração (admin.html)
14. Pagamentos, Pedidos e Contabilidade
15. Ranking e Gamificação
16. Notificações (Push, Email, in-app)
17. Inventário Completo de APIs (168 rotas)
18. Inventário de Funções (129)
19. Segurança
20. Integrações Externas
21. Frontend / PWA / Design
22. Fluxos (diagramas)
23. Watchdogs e tarefas em background
24. Problemas, código morto e melhorias
25. Notas de qualidade

---

## 1. VISÃO GERAL

**O que é:** plataforma SaaS que automatiza candidaturas a vagas sazonais americanas de visto **H-2B** (não-agrícola) e **H-2A** (agrícola). O usuário (brasileiro buscando trabalho temporário nos EUA) conecta sua conta Gmail e o sistema envia e-mails de candidatura — manualmente ou em modo automático — para os empregadores listados nas vagas oficiais do **Department of Labor (DOL / seasonaljobs.dol.gov)**.

**Problema que resolve:** candidatar-se a centenas de vagas H-2B/H-2A é repetitivo e lento. O H2BApply monta as planilhas de vagas (com e-mail do empregador), gerencia currículos e dispara as candidaturas pelo Gmail do próprio usuário, com controle de limite, anti-bloqueio e acompanhamento de respostas.

**Quem usa:**
- **Usuário comum** — candidato. Conecta Gmail, cria perfil de currículo, envia candidaturas.
- **VIP/pagante** — usuário com plano pago (limites maiores, automático).
- **Admin/Editor** — operadores (Andrio, Diego, Andrew) que gerenciam usuários, pagamentos, planilhas, IA e o sistema.

**Negócio (regra-chave):** todos têm **10 envios automáticos grátis/dia**; planos pagos elevam os limites (até 400/dia no DoublePro).

---

## 2. ARQUITETURA

```
┌─────────────────────────────────────────────────────────────┐
│  CLIENTE (navegador / PWA)                                    │
│  index.html  → app do usuário (SPA vanilla JS)               │
│  admin.html  → painel administrativo (SPA vanilla JS)        │
│  sw.js       → service worker (PWA, push, cache)             │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP/JSON (fetch, cookie h2b_session)
┌───────────────▼─────────────────────────────────────────────┐
│  SERVIDOR — server.js (Node.js puro, http.createServer)      │
│  • Roteamento manual por pathname (168 rotas)                │
│  • Sem framework (Express NÃO é usado) — libs nativas        │
│  • Stores em memória (DB_*) + persistência JSON em /data     │
│  • Motores: Manual, Automático, Coleta DOL, Enriquecimento   │
│  • Watchdogs em setInterval                                  │
└───┬───────────────┬───────────────┬─────────────────────────┘
    │               │               │
┌───▼────┐    ┌─────▼──────┐   ┌────▼───────────────┐
│ Google │    │  Gemini    │   │  DOL seasonaljobs   │
│ OAuth  │    │ (IA)       │   │  (vagas)            │
│ +Gmail │    │ generative │   │  api.seasonaljobs   │
│ API    │    │ language   │   │  .dol.gov           │
└────────┘    └────────────┘   └─────────────────────┘
```

**Bibliotecas:** somente nativas do Node — `http`, `https`, `fs`, `path`, `url`, `crypto`, `zlib`. **Zero dependências externas** no `package.json` (não há `node_modules` de terceiros). Toda chamada HTTP externa usa a função própria `httpsReq()` (nunca `fetch` no servidor).

**Hospedagem/Deploy:** Render.com, com disco persistente montado em `/data`. CI/CD via GitHub (push → deploy). Start: `node server.js`. Node ≥ 18.

**Fluxo de dados:** requisição → `http.createServer` handler → roteamento por `pathname` + `req.method` → função da rota → lê/escreve stores `DB_*` em memória → `persistDebounced()`/`persist()` grava JSON em `/data` → resposta JSON via `json(res, status, obj)`.

---

## 3. ESTRUTURA DE ARQUIVOS

Tudo na raiz do repositório (não há árvore de pastas `/src`).

| Arquivo | Tamanho | Função |
|---|---|---|
| `server.js` | ~707 KB | **O backend inteiro.** Roteamento, stores, motores, IA, watchdogs. |
| `index.html` | ~1,1 MB | App do usuário (SPA). HTML + CSS + JS inline. |
| `admin.html` | ~810 KB | Painel administrativo (SPA). |
| `guia.html` | ~56 KB | Guia/manual do usuário. |
| `sw.js` | ~8 KB | Service worker (PWA: cache, push). |
| `manifest.json` | — | Manifesto PWA (ícones, nome, cores). |
| `package.json` | — | Metadados + scripts (`start`, `reset`). |
| `jan2026_compact.json` | ~2 MB | **Planilha built-in** Jan 2026 (H-2B, ~9.240 vagas). |
| `jul2025_compact.json` | ~490 KB | **Planilha built-in** Jul 2025 (H-2B, ~2.206 vagas). |
| `h2a_jun2026_compact.json` | ~4,5 MB | **Planilha built-in** H-2A Agricultura (5.000 vagas, 20 categorias). |
| `build-sheets.js` | — | Script utilitário para montar planilhas compactas. |
| `reset_h2bapply.js` | — | Script de reset de temporada (`npm run reset`). |
| `.env.example` | — | Modelo de variáveis de ambiente. |
| `*.md`, `*.txt` | — | Auditorias, constituição da IA, checklists Google. |
| ícones `.png/.svg`, `favicon`, `apple-touch-icon` | — | Assets PWA. |
| `google380652ea59ad95e1.html` | — | Verificação de domínio Google. |

---

## 4. "BANCO DE DADOS" — Stores JSON em memória

Não há SQL. Cada "tabela" é um **objeto JavaScript em memória** (`DB_*`), carregado de um arquivo `.json` no boot e persistido em `/data`. Acesso **sempre** via helpers (`getUser/setUser`, `getHist/addLog`), nunca acesso direto ao objeto.

| Store | Arquivo | Conteúdo |
|---|---|---|
| `DB_USERS` | `users.json` | Usuários (perfil, vip, plan, cvs, profiles, senderEmails, refresh_token, settings). **Chave: e-mail.** |
| `DB_HIST` | `hist.json` | Histórico de envios por usuário (manual + auto). |
| `DB_AUTO` | `auto.json` | Jobs automáticos ativos (fila, status, source, limites). |
| `DB_SENT` | `sent.json` | IDs de vagas já enviadas (anti-duplicação). |
| `DB_LOGS` | `logs.json` | Logs do sistema/auto. |
| `DB_PEDIDOS` | `pedidos.json` | Pedidos de plano (comprovante, status, aprovação). |
| `DB_FINANCEIRO` | `financeiro.json` | Pagamentos aprovados + acerto entre sócios. |
| `DB_COMPROVANTES` | (browser localStorage) | Comprovantes ficam no navegador do admin, **não** no servidor. |
| `DB_KB` | `kb.json` | Base de conhecimento da IA (51+ entradas KB-001…). |
| `DB_NOTIF` / `DB_PUSH` | `notif.json`/`push.json` | Notificações in-app e inscrições Web Push. |
| `DB_INCIDENTS` | (memória/log) | Central de incidentes (admin). |
| `DB_CODES` | `codes.json` | Códigos promocionais. |
| `DB_BLOCKED` / `DB_INVALID_EMAILS` | `blocked.json`/`invalid_emails.json` | E-mails banidos/ inválidos (bounce). |
| `DB_TRIAL_USED` | `trial_used.json` | Anti-abuso de trial (IP + Google ID). |
| `DB_SHEETS_META` | `sheets_meta.json` | Metadados de planilhas extras (published, visaType, count). |
| `DB_JOURNEY` | `journey.json` | Jornada do usuário (eventos). |
| `DB_RANK_BADGES` / `DB_RANK_HIDDEN` | — | Badges e ocultações do ranking. |
| `DB_SUGGESTIONS` | `suggestions.json` | Sugestões de usuários. |
| `DB_NOTES` | `notes.json` | Notas administrativas. |
| `DB_ALERTS` | `alerts.json` | Alertas. |
| `DB_ADMIN_SETTINGS` | `admin_settings.json` | Config do admin (intervalos, limites por sender). |
| `DB_APP_INDEX` | `app_index.json` | Índice de candidaturas ↔ e-mails (matching de respostas). |
| `DB_EMAIL_CORRECTIONS` | `email_corrections.json` | Correções de e-mail sugeridas. |
| `DB_TEMP_FAILURES` | `temp_failures.json` | Falhas temporárias de envio. |

**Persistência:** `persist()`, `persistDebounced()`, `persistFlush()`, `flushAll()` e variantes específicas (`persistPedidos`, `persistFinanceiro`, `persistLogs`...). Gravação em disco é **debounced** para reduzir I/O.

---

## 5. PERSISTÊNCIA E O DISCO `/data`

- `DATA_DIR = /data` (fallback `/tmp`). Todos os `*.json` de estado vivem aqui.
- **Planilhas built-in** (`jan2026`, `jul2025`, `h2a-jun2026`) carregam de `__dirname` (o próprio repositório) — **sobrevivem a qualquer deploy/reset**.
- **Planilhas extras** (coletadas em runtime) vão para `/data/sheets/*.json` — dependem da persistência do disco.
- **Canário de persistência:** no boot grava `.persist_canary`; se sumir, loga que o disco está efêmero (diagnóstico de perda de dados).
- **Proteção anti-wipe:** `RESET_NOW` recusa apagar se houver usuários, a menos que o token termine em `:force`.
- **Reset de temporada:** `reset_h2bapply.js` limpa dados de usuários preservando settings de admin e a base de conhecimento.

---

## 6. AUTENTICAÇÃO E SESSÃO (Google OAuth)

Não há cadastro com senha. O login é **100% Google OAuth 2.0**.

**Escopos solicitados:**
- `gmail.send` — enviar candidaturas
- `gmail.readonly` — ler caixa de entrada (respostas)
- `gmail.modify` — marcar lidos

**Fluxo:**
```
/oauth/start → Google consent → /oauth/callback
  → troca code por tokens (oauth2.googleapis.com)
  → cria sessão sess_<hex> em memória (sessions[sid])
  → Set-Cookie: h2b_session=<sid> (httpOnly)
  → makeCallbackPage() devolve HTML que fecha/redireciona
```

- **Sessão:** objeto em memória `sessions[sid]` (não persiste entre reinícios — usuário pode precisar relogar; o `refresh_token` fica salvo em `DB_USERS` para o motor automático rodar sem o usuário presente).
- **getSessId(req):** lê o cookie `h2b_session`.
- **Multi-Gmail:** `/oauth/add-sender` adiciona contas extras de envio (até o limite do plano), com rotação round-robin.
- **Renovação de token:** `refreshToken`, `refreshTokenForUser`, `refreshSenderToken`, `getSenderToken` — renovam access tokens via refresh token salvo.
- **Admin:** definido por e-mail em `ADMIN_EMAILS` (`isAdminEmail`) ou flag `u.isAdmin` (`isAdminVip` = admin tem acesso/limites infinitos).
- **Editores:** Andrew (`84800-54`) e Diego (`Diego2026`) — senhas para ações sensíveis, registradas em `adminEditHistory[]`.

---

## 7. PLANOS, VIP E LIMITES

**Tabela `PLAN_LIMITS`:**

| Plano | Manual/dia | Auto/dia | Observação |
|---|---|---|---|
| `free` | 20 | 10 | Todos têm 10 auto grátis/dia |
| `vip` | 200 | 10 | Só manual (R$100) |
| `pro` | 0 | 200 | Legado (só auto) |
| `vipro` | 200 | 200 | Manual + auto (R$150) |
| `doublepro` | 400 | 400 | 2 Gmails, R$250 |

**Fonte da verdade do plano efetivo** = o que está **ativo agora**, não o rótulo `u.plan`:
- `isManualVipActive(u)` → `u.vip.manualExpires > agora`
- `isAutoVipActive(u)` → `u.vip.autoExpires > agora`
- `getPlan(u)`: admin→máximo; `doublepro` salvo+ativo→doublepro; manual&&auto→`vipro`; auto→`vipro`; manual→`vip`; senão `free`.
- `getManualLimit(u)` / `getAutoLimit(u)` = `PLAN_LIMITS[getPlan(u)]`.

> **Lição registrada (KB-050):** nunca derivar limite do campo `u.plan` salvo — ele pode estar defasado em relação às expirações reais.

**Trial:** 1 dia VIP Manual (200 envios), anti-abuso por IP + Google ID (`DB_TRIAL_USED`).
`vip.source` (`trial` | `pago`/`payment` | `code`) identifica a origem.

---

## 8. SISTEMA DE VAGAS (PLANILHAS)

Cada vaga (campos compactos): `c` case number, `t` título, `n` empregador, `s` estado, `ci` cidade, `e` e-mail, `w` salário, `wunit`, `wk` nº vagas, `d`/`de` datas, `ph` telefone, `desc` descrição, `soc` SOC code, `url`, `visa` (H-2A/H-2B), `k` categoria, `active`.

**Planilhas built-in** (sempre disponíveis, carregadas do repo):
- `jan2026` → "Jan 2026" (H-2B)
- `jul2025` → "Jul 2025" (H-2B)
- `h2a-jun2026` → "H-2A Agricultura" (H-2A, 20 categorias)

**Funções de acesso:**
- `getSheet(key)` — retorna uma planilha por chave.
- `getAllSheets()` — combina built-ins + extras (usado pelo motor automático para achar vaga por case number).
- `searchSheet()` — busca/filtra (texto, estado, salário, categoria).
- `getSheetCategories()` / `getSheetCategoriesCached()` — categorias da planilha.

**Categorias:** `CATEGORY_KEYWORDS` + `CATEGORY_LABELS` (rótulos pt-BR). H-2A tem 20 categorias próprias (Lavoura, Operador de Máquinas, Pecuária, Pastor de Ovelhas, Viveiro, Irrigação, Mecânico, Supervisor, Motorista, etc.) + "Outros". `detectCategory(texto)` classifica por empresa+título+SOC.

**APIs de planilha:** `/api/sheets-list` (lista para o usuário), `/api/sheet-meta`, `/api/sheet-categories`, `/api/count-jobs`, `/api/sheet-detail`, `/api/sheet-batch`, `/api/jobs` (feed, tenta DOL ao vivo e cai para planilhas locais).

---

## 9. SISTEMA MANUAL

O usuário navega as vagas e dispara candidaturas uma a uma (ou em lote manual).

**Fluxo:** abre aba da planilha (`setTab`) → `/api/sheet-meta` lista vagas → seleciona vaga → vê detalhe → **Enviar** → `/api/send` monta o e-mail (MIME, currículo anexo, template/cover) e envia via Gmail API (`gmailSend`/`gmailSendWithThread`).

- Limite manual = `getManualLimit` (20 free / 200 VIP).
- Anti-duplicação: `DB_SENT` registra IDs enviados; vaga já enviada não reenvia.
- Templates e cover letters: `/api/templates*`, `/api/generate-cover` (IA).
- Histórico: `/api/history`, `addLog`, `countManualToday`.

---

## 10. SISTEMA AUTOMÁTICO (motor de envio)

Coração do produto: envia candidaturas **24/7 sem o usuário presente**, usando o `refresh_token` salvo.

**Criação:** wizard no app → escolhe fonte (planilha) → categorias → `/api/auto/start` monta a **fila** (`queue`) buscando os case numbers em `getAllSheets()`; salva `DB_AUTO[email]` com `queue`, `source`, `status`, `lockedAutoLimit`, fingerprint anti-duplicação.

**Motor (`scheduleAuto` → `doAutoSend` → `_doAutoSendInner`):**
1. Verifica fila e perfil (precisa de **perfil de currículo** com CV).
2. **Regra 10/dia para todos:** não bloqueia por falta de plano; o limite diário (`getAutoLimit`) regula.
3. Se `todayAuto >= autoLimit` → status `waiting_limit`, agenda retomada à **meia-noite BRT** (`nextMidnightBRT`).
4. Senão, envia 1 e-mail (`gmailSend`), agenda próximo com `calcSmartInterval` (intervalo inteligente 5–6 min, anti-bloqueio).
5. Rotação de Gmails (DoublePro): round-robin pelo sender com menos envios no dia.
6. `updateAutoStats`, `addLog`, `trackJourney`.

**Estados do job:** `starting`, `sending`, `resuming`, `waiting_interval`, `waiting_limit`, `waiting_rate_limit`, `paused` (usuário), `paused_no_vip` (**hoje só por revogação manual de admin**), `paused_auth_error` (token caiu — pede relogin), `paused_corrupt_queue`, `restarted_by_fix`.

**Controle:** `/api/auto/start|pause|resume|stop|status`. `reactivateAutoJobs()` no boot reagenda jobs ativos (pré-aquece tokens em lotes de 3).

> **Lição (KB-051):** limite e bloqueio são responsabilidades separadas. O hard-stop por VIP foi removido; só o limite diário regula. Cuidado com watchdog que re-aplica bloqueio errado.

---

## 11. INTELIGÊNCIA ARTIFICIAL (Gemini)

**Provedor:** Google Gemini (`generativelanguage.googleapis.com`). Modelos usados: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash` (Vision). Chave via `getGeminiKey()`.

**Usos:**
1. **Chat/assistente** (`/api/gemini/chat`, `/api/gemini/status`) — responde dúvidas do usuário com contexto da base de conhecimento.
2. **Base de Conhecimento (`DB_KB`)** — 51+ entradas (KB-001…KB-051) com problema/solução/impacto/módulos/tags. **Regra do dono:** o Gemini é treinado (KB atualizada) a CADA mudança no sistema.
3. **Vision — pré-check de comprovante** — lê a imagem do comprovante (`gemini-2.0-flash`, inline_data), compara valor × preço do plano e devolve veredito (`CONFERE`/`DIVERGENCIA`/`ILEGIVEL`); SHA-256 detecta comprovante duplicado.
4. **Robô de Auditoria** (`/api/admin/auditoria-gemini`) — audita o sistema/contabilidade.
5. **Geração de cover letter** (`/api/generate-cover`).
6. **Boot:** `gemini-boot`, `gemini-boot-auto` (rotinas de inicialização da IA).

**Contexto/memória:** a "memória" da IA é a `DB_KB` (não há fine-tuning real). O dossiê + KB são injetados no prompt.

---

## 12. BOT DE COLETA DOL E ENRIQUECIMENTO

Dois bots distintos que falam com o DOL (`api.seasonaljobs.dol.gov/datahub`, OData):

**1. Coleta (Criar Planilha via DOL Advanced Search):**
- Admin cola a URL do Advanced Search → `_parseDolAdvancedUrl` extrai visa/data/status → `_runDolBuildBot` pagina a API (`$filter visa_class/begin_date`, `$orderby dhTimestamp`, `$top/$skip`).
- **Degradação progressiva:** se o DOL recusa um campo (4xx), remove `$orderby`, depois `begin_date` (filtra a data no servidor) e continua — não morre calado. Loga o corpo do erro. Aborta após 5 erros (sem loop).
- Salva em `SHEET_EXTRAS`/`/data/sheets/` + `DB_SHEETS_META`. Publicar (`/api/admin/sheet/build-publish`) marca `published=true` (aparece no `/api/sheets-list`).
- APIs: `build-from-dol`, `build-status`, `build-stop`, `build-publish`, `sheet/upload`.

**2. Enriquecimento (`_runEnrichBot`):** para cada ETA case number, acessa o DOL e preenche cidade, telefone, datas, descrição (`fetchByCase`, `fetchDOL`, `normJob`). APIs: `/api/admin/enrich/start|status|stop`. Roda em background.

> **Lição (KB-044/045/046):** o `build-from-dol` chegou a "travar sem responder" porque lia um `body` inexistente (a rota deve usar `readBody(req)`). Toda rota POST precisa ler o corpo explicitamente — referenciar `body` mágico pendura a conexão.

---

## 13. ADMINISTRAÇÃO (admin.html)

Painel completo (SPA). Seções principais (menu): **Dashboard, Automáticos, Eventos, Todos Usuários, VIP & Planos, Pagantes & Dias VIP, Vencimentos VIP, Pedidos de Plano, Lixeira de Pedidos, Planilhas de Vagas, Emails Inválidos, Códigos Promo, Ranking, Notificações, Sugestões, Configurações, Central de Incidentes, Logs & Export, Robô de Teste, Robô de Auditoria.**

Capacidades (amostra das ~90 rotas `/api/admin/*`):
- **Usuários:** listar/atualizar/validar/excluir (`users`, `user/update`, `user/full-update`, `delete-user`, `set-user-field`).
- **Planos/VIP:** ativar/revogar/expiry (`vip/activate`, `vip/revoke`, `vip/set-expiry`, `set-plan`, `set-auto-limit`, `revoke-vip`, `revoke-trial`).
- **Pagamentos/Pedidos:** `pedidos`, `pedido`, `pedido-set-valor`, `pedidos-criticos`, `financeiro`, `pagantes`.
- **Planilhas/DOL:** coleta, enriquecimento, upload, publish.
- **IA:** `kb`, `auditoria-gemini`.
- **Saúde/automático:** `health-summary`, `live`, `fix-auto`, `force-restart`, `force-stop`, `restart-all-stalled`, `bulk-status`, `reset-daily`, `reset-pdfs`.
- **Notificações:** `notif/*`, `push-user`, `notify-auth-error`, `notify-all-auth-error`, `message`.
- **Ranking:** `ranking`, `ranking/badge`, `ranking/hide`, `ranking/reset`, `ranking/stats`.
- **Incidentes/abuso:** `incidents`, `trial-abuse`, `unban-email`, `crashes`, `action-log`.
- **Códigos:** `codes`, `codes/create`, `codes/delete`, `codes/revoke`.
- **Export:** `users/export`, `logs/export`, `metrics/daily`.

Toda ação sensível exige senha de editor e é logada (`adminEditHistory[]` / `action-log`). `isAdminVip()` protege todas as rotas admin.

---

## 14. PAGAMENTOS, PEDIDOS E CONTABILIDADE

- **Pagamento:** PIX (manual, com comprovante). Não há Stripe ativo no fluxo principal.
- **Pedido de plano:** usuário envia comprovante → `DB_PEDIDOS` → admin aprova no modal (com pré-check Gemini Vision + bônus de dias + senha de editor) → concede VIP (`addManualVipDays`/`addAutoVipDays`) → registra em `DB_FINANCEIRO`.
- **Contabilidade:** só conta **comprovantes aprovados dentro do programa** (sem valores externos/hardcoded). Card "Acerto entre sócios" + "Fechamento Mensal" (split 50/50 Andrio/Diego, quem deve a quem) + export CSV.
- **Comprovantes:** ficam no **localStorage do navegador do admin** (`DB_COMPROVANTES` não é store de servidor) + SHA-256 anti-duplicado.
- **Funções:** `addCredito`, `addManualVipDays`, `addAutoVipDays`, `setPedidoPreCheck`, `persistFinanceiro`, `persistPedidos`.

---

## 15. RANKING E GAMIFICAÇÃO

- **Indicações:** ❌ REMOVIDO DEFINITIVAMENTE (2026-07-03, KB-059) por uso de má fé. Rotas `/api/referral*` respondem 410 Gone. Dias já concedidos no passado não foram revogados; rótulos de legado (source `referral`, origem `indicacao`) permanecem para leitura do histórico.
- **Ranking:** `calcRanking`, `calcAdminRanking`, `calcStreak`, badges (`DB_RANK_BADGES`), ocultação (`DB_RANK_HIDDEN`), períodos (`inRankPeriod`). APIs `/api/ranking`, `/api/ranking/profile`, `/api/admin/ranking*`.
- **Jornada (`DB_JOURNEY`):** `trackJourney`, `pushGlobalEvent`, feed em `/api/admin/journey-feed`.

---

## 16. NOTIFICAÇÕES

- **Web Push (PWA):** VAPID (`createVapidJWT`, `/api/push/vapid-public-key`, `subscribe/unsubscribe/test`, `sendWebPush`, `pushToUser`). Inscrições em `DB_PUSH`.
- **E-mail transacional:** `sendNotifEmail` (ex.: `vip_expired`, auth error, reengajamento).
- **In-app:** `DB_NOTIF`, `/api/notif/pending`, `/api/notif/read`, `serverPushPoll`/`pushGlobalEvent` (eventos em tempo quase real por polling).
- **Reengajamento:** `runReengagement`, `scheduleReengagement`.

---

## 17. INVENTÁRIO COMPLETO DE APIS (168 rotas)

**Páginas/estáticos:** `/`, `/index.html`, `/admin`, `/admin.html`, `/ad`, `/guia`, `/contato`, `/privacidade`, `/termos`, `/excluir-conta`, `/health`, `/ping`, `/sw.js`, `/manifest.json`, ícones, verificação Google.

**OAuth:** `/oauth/start`, `/oauth/callback`, `/oauth/add-sender(/callback)(-legacy)`.

**Usuário — conta/perfil:** `/api/status`, `/api/me/stats`, `/api/my-stats`, `/api/onboard`, `/api/accept-terms`, `/api/settings`, `/api/disconnect`, `/api/account/delete`, `/api/warmup`, `/api/diag`, `/api/debug(/export)`.

**Currículos/perfis:** `/api/profiles`, `/api/profiles/save`, `/api/profiles/delete`, `/api/cv/upload`, `/api/cv/delete`, `/api/generate-cover`, `/api/templates(/save|/delete)`.

**Vagas:** `/api/jobs`, `/api/sheets-list`, `/api/sheet-meta`, `/api/sheet-detail`, `/api/sheet-batch`, `/api/sheet-categories`, `/api/category-groups`, `/api/count-jobs`, `/api/saved`.

**Envio manual:** `/api/send`, `/api/history(/clear|/delete)`, `/api/sent-ids`, `/api/sent/remove`.

**Automático:** `/api/auto/start|pause|resume|stop|status`, `/api/auto-logs(/export)`.

**Respostas/inbox:** `/api/inbox`, `/api/inbox/match`, `/api/inbox/read`, `/api/followup/check`.

**IA:** `/api/gemini/chat`, `/api/gemini/status`.

**Gamificação/social:** `/api/ranking`, `/api/ranking/profile`, `/api/check-rankname`, `/api/suggestions(/status)`, `/api/public-stats`.

**Pagamento/código:** `/api/pedido`, `/api/pedidos`, `/api/redeem-code`, `/api/my-message`, `/api/alerts`.

**Push:** `/api/push/subscribe|unsubscribe|test|vapid-public-key`, `/api/notif/pending|read`.

**Admin:** ~90 rotas `/api/admin/*` (ver §13).

> Inventário completo e exato das 168 rotas extraído do `server.js` por `pathname`. Cada rota valida sessão (`getSess`) e, quando admin, `isAdminVip()`.

---

## 18. INVENTÁRIO DE FUNÇÕES (129)

**Auth/sessão/token:** getSessId, refreshToken, refreshTokenForUser, refreshSenderToken, getSenderToken, isAdmin, isAdminVip, isAdminEmail, getMaxSenders, makeCallbackPage.

**Planos/VIP:** getPlan, getAdminPlan, getManualLimit, getAutoLimit, isManualVipActive, isAutoVipActive, isVipActive, addManualVipDays, addAutoVipDays, addCredito.

**Usuários/stores:** getUser/setUser, getHist/addLog, getUserLogs, getUserStatsCached, invalidateUserStatsCache, persist*, flushAll, load.

**Vagas/planilhas:** loadSheets, getSheet, getAllSheets, searchSheet, getSheetCategories(Cached), detectCategory, normJob, removeFromSheets, _savePlaniha, _saveEnrichedSheet.

**Motor automático:** scheduleAuto, doAutoSend, _doAutoSendInner, calcSmartInterval, selectProfile, reactivateAutoJobs, updateAutoStats, getAutoStats, diagnoseJob, buildJobSnapshot, rotateItem, shuffleArray.

**Manual/e-mail:** gmailSend, gmailSendWithThread, gmailGetToken, gmailFetchInbox, gmailMarkRead, fetchGmailMessageHeaders, buildMime, buildMimeWithHeaders, genCover, extractText, parseEmail, parseRefs, normMsgId, normalizeEmail, extractEmail, isValidEmail, isEmailInvalid, classifyBounce, isBounceMail, processBounce, suggestEmailCorrection, levenshtein.

**DOL/IA:** _parseDolAdvancedUrl, _runDolBuildBot, _dolBuildLog, _runEnrichBot, _enrichLog, _autoEnrichCycle, fetchDOL, fetchByCase, getGeminiKey.

**Notificações/push:** createVapidJWT, sendWebPush, pushToUser, pushGlobalEvent, serverPushPoll, sendNotifEmail, runReengagement, scheduleReengagement.

**Ranking/jornada:** calcRanking, calcAdminRanking, calcStreak, inRankPeriod, trackJourney.

**Watchdogs:** vipExpiryWatchdog, authErrorWatchdog, tokenGuardianRun.

**Infra/util:** httpsReq, readBody, json, rateLimit, getHeader, b64url, b64urlToBuffer, getHealth, setHealth, boot, indexApp, rebuildAppIndex, findAppById, matchAppToEmail, newAppId, ensureIdx, last7Days, todayStrBRT, nowBRT, hourBRT, toLocaleBRT, toTimeBRT, exportLogsCSV, generateIconPNG.

*(Lista exaustiva das 129 funções top-level; helpers inline adicionais existem dentro das rotas.)*

---

## 19. SEGURANÇA

- **Auth:** OAuth Google; sessão por cookie httpOnly; token de acesso renovado via refresh token.
- **Autorização:** rotas admin protegidas por `isAdminVip()`; ações de editor exigem senha e são logadas.
- **Sanitização:** validação de e-mail (`isValidEmail`, `normalizeEmail`), filtro de inválidos/bounce (`DB_INVALID_EMAILS`, `DB_BLOCKED`).
- **Rate limiting:** `rateLimit()` em rotas sensíveis.
- **Anti-abuso de trial:** IP + Google ID (`DB_TRIAL_USED`).
- **Anti-bloqueio Gmail:** intervalos inteligentes, rotação de senders, aviso de responsabilidade do usuário.
- **Anti-duplicação:** `DB_SENT` + fingerprint de fila.
- **Proteção de dados:** canário de persistência + anti-wipe no reset.
- **Pontos de atenção:** sessões em memória (perdem no restart); comprovantes no localStorage do admin (não no servidor); chaves via env (`.env`).

---

## 20. INTEGRAÇÕES EXTERNAS

| Integração | Host | Uso |
|---|---|---|
| Google OAuth | `accounts.google.com`, `oauth2.googleapis.com` | Login + tokens |
| Gmail API | `gmail.googleapis.com` | Enviar/ler e-mails |
| Google APIs | `www.googleapis.com` | Perfil/escopos |
| Gemini | `generativelanguage.googleapis.com` | IA (chat, vision, auditoria) |
| DOL SeasonalJobs | `api.seasonaljobs.dol.gov`, `seasonaljobs.dol.gov` | Vagas (coleta/enriquecimento) |

Stripe/Supabase/OpenAI/Claude/webhooks: **não usados** no código atual.

---

## 21. FRONTEND / PWA / DESIGN

- **SPA vanilla:** `index.html` (usuário) e `admin.html` (admin) — HTML + CSS + JS inline, navegação por `switchView`/`sv()`/`setTab`.
- **PWA:** `manifest.json` + `sw.js` (cache offline, instalável, push). Ícones 192–512 + maskable.
- **Design:** cards, abas `.stab` (planilhas com badges VERÃO/INVERNO/🌾 H-2A), chips de filtro, modais, toasts (`toast()`). Tema claro/escuro. Mobile-first.
- **i18n:** PT-BR principal.
- **Responsividade:** layout fluido para celular (público-alvo majoritariamente mobile).

---

## 22. FLUXOS (diagramas)

**Usuário — onboarding e envio:**
```
Acessa site → /oauth/start → Google → /oauth/callback (sessão)
 → /api/status (carrega perfil) → onboarding/aceite de termos
 → cria perfil de currículo + upload CV (/api/cv/upload, /api/profiles/save)
 → MANUAL: aba planilha → /api/sheet-meta → vaga → /api/send → Gmail
 → AUTO: wizard → fonte+categoria → /api/auto/start → motor 24/7
 → respostas: /api/inbox → ranking/estatísticas
```

**Pagamento → VIP:**
```
Usuário paga PIX → envia comprovante → /api/pedido → DB_PEDIDOS
 → admin: pré-check Gemini Vision → aprova (senha editor)
 → addManual/AutoVipDays → DB_FINANCEIRO → usuário vira VIP
```

**Automático (ciclo):**
```
scheduleAuto → tem fila? → perfil/CV ok? → limite diário ok?
   ├ não (atingiu) → waiting_limit → retoma 00:00 BRT
   └ sim → doAutoSend (gmailSend) → addLog → calcSmartInterval → próximo
```

**Coleta DOL:**
```
admin cola URL → _parseDolAdvancedUrl → _runDolBuildBot (OData paginado)
 → degrada campos se 4xx → salva SHEET_EXTRAS + DB_SHEETS_META
 → build-publish (published=true) → /api/sheets-list → usuário vê a planilha
```

---

## 23. WATCHDOGS E TAREFAS EM BACKGROUND

- `reactivateAutoJobs()` — boot: reagenda jobs ativos, pré-aquece tokens.
- `vipExpiryWatchdog()` — **hoje no-op** quanto a parar por plano (regra 10/dia para todos).
- `authErrorWatchdog()` / `tokenGuardianRun()` — detectam token caído (`paused_auth_error`), notificam para relogin.
- `_autoEnrichCycle()` — enriquecimento contínuo.
- `runReengagement()`/`scheduleReengagement()` — reengajamento.
- `serverPushPoll()` — eventos em tempo quase real.
- `persistDebounced`/`flushAll` — gravação periódica em disco.
- Canário de persistência no boot.

---

## 24. PROBLEMAS, CÓDIGO MORTO E MELHORIAS

**Código morto / backups no repo:**
- Lote de limpeza 18/07/2026 (parte 2): `mod-dol-monitor.js` REMOVIDO (52 KB — nada dava require, rotas nunca despachadas, zero chamadas no admin; as funções de grupos/ETA vivem no server.js). `icon_master.svg` (v1) removido — `icon_master_v2.svg` é a fonte atual dos ícones. `package.json`: scripts `test`/`test:*` apontavam para pasta `tests/` que nunca foi commitada — substituídos por `npm run check` (node --check em server.js, storage.js e mod-*.js). `.env.example` completado com as 8 variáveis que faltavam (GEMINI_API_KEY, GEMINI_DAILY_LIMIT, DATA_ENC_KEY, EDITOR_PWD_ANDREW/DIEGO, STORAGE, STORAGE_MIRROR, RESET_NOW). README: `SESSION_SECRET` (não existe no código) trocado pelas variáveis reais. sw.js: CACHE_NAME v18b→v19.
- Notas de entrega antigas REMOVIDAS em 18/07/2026: `CORRECAO_EMAIL_SECUNDARIO.md` e `CORRECAO_ENVIO_MANUAL_PERFIL.md` (correções de 03/07 já aplicadas e vivas no código) e `BOTS-REMOVIDOS.md` (descrevia a remoção do `_dolBuildBot`, que foi RECRIADO depois — o documento contradizia o código). `admin-v2.html` + `TRANSFORMACAO_ADMIN_V2.md` também removidos (painel V2 aposentado; `mod-admin-v2.js` reduzido às rotas de backup usadas pelo painel clássico).
- `admin-3.html`, `index-1.html`, `update_clientes_pagantes.js` — REMOVIDOS em 18/07/2026 (revisão da contabilidade: eram versões antigas não servidas + script de migração já executado com dados de clientes hardcoded).
- `h2a_compact.json`, `h2a_jobs.json` e `eta_grupos_oficiais.json` — REMOVIDOS em 18/07/2026 (nada os carregava: as planilhas vivas são jan2026/jul2025/jul2026/h2a_jun2026_compact.json e os grupos vivem em jul2026_compact.json + /data/grupos_jul2026.json; recuperáveis no histórico do git se precisar).

**Riscos arquiteturais:**
- **Monólito de 1 arquivo** (`server.js` ~11k linhas) — difícil manutenção; sem testes automatizados.
- **Persistência JSON em arquivo** — não escala para milhões; risco de corrupção/concorrência (last-write-wins). Migrar para um banco real (SQLite/Postgres) é o próximo passo natural de escala.
- **Sessões em memória** — somem no restart (usuário reloga).
- **Sem framework** — roteamento manual por `if(pathname===...)` (168 ramos) é frágil a typos; toda rota POST precisa lembrar de `readBody` (já causou requisição pendurada — KB-046).
- **Comprovantes em localStorage do admin** — não centralizados; risco se trocar de navegador.

**Bugs já corrigidos (rastreáveis na KB):**
- Re-login retoma auto (KB Ítalo), getPlan VIP+Pro=vipro (KB-050), 10 auto grátis para todos (KB-051), coleta DOL travada por `body` inexistente (KB-046), planilha H-2A built-in (KB-048), abas H-2A Manual/Auto (KB-049).

**Melhorias sugeridas:** banco relacional; modularizar `server.js`; testes; sessão persistente; centralizar comprovantes; fila de envio resiliente; observabilidade/métricas.

---

## 25. NOTAS DE QUALIDADE (0–10)

| Critério | Nota | Comentário |
|---|---|---|
| Arquitetura | 6 | Monólito funcional e pragmático, mas pouco modular e sem testes. |
| Organização | 5 | Tudo em poucos arquivos gigantes; backups no repo. |
| Performance | 7 | Cache, debounce e intervalos inteligentes ajudam; JSON em arquivo limita escala. |
| Segurança | 7 | OAuth + autorização admin sólidos; sessão em memória e comprovantes locais são pontos fracos. |
| Código | 6 | Funções bem nomeadas e helpers consistentes; arquivos muito grandes. |
| UX | 8 | Fluxos claros, mobile-first, feedback (toasts), guia. |
| UI | 8 | Cards/abas/badges coesos, tema claro/escuro. |
| Escalabilidade | 5 | JSON-em-arquivo + monólito limitam crescimento a milhões. |
| "Banco" | 5 | Stores JSON simples e rápidos, mas sem integridade relacional. |
| IA | 8 | Uso prático e variado de Gemini (chat, vision, auditoria) com KB versionada. |
| Documentação | 7 | Boa rastreabilidade via KB (51 entradas) + auditorias; faltava esta visão única (agora suprida). |

---

> **Status:** documentação gerada a partir do código real do `New-repository-main` v15. Para reconstruir o sistema, este documento + os arquivos `server.js`, `index.html`, `admin.html`, `sw.js`, `manifest.json` e as planilhas built-in são suficientes. Nenhuma alteração foi feita no projeto durante esta análise.

---

## 🌐 MULTI-SERVIDOR (V933 · 04/07/2026)

O H2BApply agora opera como **servidores irmãos independentes** (mesmo código, bancos separados):

- **Identidade:** env `SERVER_ID` (1 = h2bapply.com, 2 = h2b-teste.onrender.com). O mesmo ZIP é deployado nos dois repositórios; só a variável muda.
- **Seletor na landing:** overlay estilo "realm select" mostra os servidores com barra de lotação (config em Admin → Configurações → 🌐 Servidores: nome/url/máx. exibido/status lotado|aberto). Servidor lotado = só login; aberto = cadastro. Clique em servidor remoto redireciona para a URL dele.
- **Rotas públicas:** `GET /api/servers/self` (id + usuários), `GET /api/servers` (lista p/ o seletor; peers via httpsReq, cache 10 min, falha silenciosa), `GET /api/servers/ranking-export` (top 50 público, nunca e-mail), `GET /api/ranking/global` (funde local + peers).
- **Regra de ouro:** contas NÃO migram entre servidores (bancos separados). A UI comunica isso no seletor, no drawer e no perfil ("Servidor N").

## 🏆 RANKING v15
Categorias: **Envios** | **💎 VIP** (nº de compras — `calcVipCompras()`, mesma fonte canônica da receitaReal; trial/código nunca contam) | **🔥 Mais Ativos** (dias distintos com envio no período) | **🌐 Global** (entre servidores). Categoria "Respostas" removida. Privacidade: `publicProfile.mostrarFotoGoogle=false` oculta a foto Google em todo lugar público.

## 🌟 PERFIL PÚBLICO (opt-in)
`user.publicProfile` = { sobre≤600, experiencias≤400, foiContratado(sim|nao|""), opiniao≤300, mostrarFotoGoogle }. Editado em Perfil → card "Perfil Público"; salvo via `POST /api/settings` (sanitizado no server). Exibido no modal do ranking (`/api/ranking/profile`). E-mail/telefone/cidade NUNCA aparecem.

## 💸 REPASSES ENTRE SÓCIOS
`DB_FINANCEIRO.repasses[]` registra dinheiro que um sócio já pagou ao outro. Actions: `add_repasse` (de/para/valor/data/nota; lançador vem da sessão) e `delete_repasse` (motivo obrigatório) — ambas na trilha `alteracoes[]`. O card "Acerto entre sócios" e o Robô Contábil descontam os repasses automaticamente do "quem repassa pra quem".

## 📡 MONITOR ETA — FASE 1 (V934 · 04/07/2026)

Sistema de monitoramento contínuo de TODAS as vagas por ETA Case Number:

- **Registro:** `DB_ETA` (`eta_registry.json`) — 1 registro por case com empresa, estado, cidade, begin/end, grupo, status, histórico completo (append-only, máx 40), agenda de consultas e contadores. Seed automático das planilhas (boot + diário), sem duplicatas.
- **Grupos:** derivados do Begin Date (🟢A Abr–Jun · 🟡B Jul–Set · 🔵C Out–Dez · 🔴D Jan–Mar); coluna de grupo na planilha e ajuste manual do admin (`grupoManual`) têm prioridade.
- **Worker:** `etaTick()` a cada 45s, independente da interface, fila inteligente por `nextCheckAt`, 5 cases por request DOL (`$filter case_number eq ... or ...`), agenda adaptativa (12h perto do início, 24h padrão, 48h não listada, 7d encerrada), retry 30 min, kill-switch `etaWorkerEnabled`. Status aceita qualquer string — status novos entram sozinhos. Persistência com debounce 3 min + flush no SIGTERM.
- **Gating Double Pro:** resolvido no SERVIDOR. `POST /api/eta/map` (grupo p/ todos; status/✨ só DP; demais `locked:true`) e `GET /api/eta/case` (detalhe completo DP; teaser + upsell p/ demais).
- **Front:** linha ETA nos cards de vagas (selo de grupo + status/🔒 + botão ⭐ Monitor ETA), modal premium dark com linha do tempo do histórico (DP) ou tela de upgrade "💎 Quero ser Double Pro — R$250".
- **Admin:** view 📡 Monitor ETA — stats, distribuição por status/grupo, ligar/pausar robô, consultar case agora, definir grupo, logs ao vivo (`/api/admin/eta/*`).
- **Fase 2 planejada:** provider FLAG (status pré-certificação: Pending/Analyst Review), IA de probabilidade, filtros por grupo/status, notificações de mudança e upload de planilhas com coluna de grupo.

## 🔒 CONTA ÚNICA ENTRE SERVIDORES (V936 · 04/07/2026)

Trava server-side no callback OAuth (só para conta NOVA; login existente intocado):
1. **Lotado real:** servidor com status `lotado` recusa cadastro novo e redireciona `/?err=srv_lotado` com o servidor aberto sugerido.
2. **Conta única:** `checkAccountOnPeers()` consulta os irmãos via `GET /api/servers/has-account?h=<SHA-256 do e-mail>` (PII nunca viaja em texto; rate limit 120/min/IP; cache de hashes local 5 min, inclui soft-deletadas). Achou → redireciona `/?err=conta_outro_srv&srv_id/nome/url`.
3. **Fail-open deliberado:** peer fora do ar (timeout 6s) não bloqueia cadastro legítimo — logado para auditoria.
4. **Front:** `window._srvBlock` capturado antes do replaceState; `showSrvBlockModal()` exibe o card de tela cheia (👋 "Você já tem conta no Servidor X" com botão direto + `?entrar=1`, ou 🔴 "Servidor lotado" com botão para o servidor aberto).

## ⚠️ ATUALIZAÇÃO v156/v157 (22/08/2026) — ERA DE 1 SERVIDOR SÓ
A seção "CONTA ÚNICA ENTRE SERVIDORES" acima é HISTÓRICA. Desde o v156:
cadastro e login acontecem SEMPRE no Servidor 1; a trava de "lotado", os
redirects `srv_lotado`/`conta_outro_srv` e a `checkAccountOnPeers()` foram
REMOVIDOS; o front não tem mais seletor de servidores. Detalhes: CLAUDE.md
regra 13y.

## 🧠 CÉREBRO CONTÁBIL (Master Commands 1 e 2 · 22/08/2026)

O auditor autônomo do sistema. Vive em `mod-cerebro.js` (injeção de
dependências por getters, padrão mod-sentinel; instanciado no fim do
server.js). NUNCA confia no estado atual do banco: reconstrói a realidade
a partir das EVIDÊNCIAS e compara. Matemática 100% determinística — IA
nenhuma decide número (a leitura de comprovante usa Gemini só pra EXTRAIR
campos da imagem; a comparação é código).

### Arquitetura / dados
- Relatórios versionados `AUDIT-AAAA-MM-DD-NNN` em `DATA/cerebro/` (com o
  ledger completo dentro); estado em `DATA/cerebro/cerebro_state.json`
  (modo, incidentes, decisões resolvidas, correções aplicadas, resumo,
  última diária, histórico de auditorias).
- Fontes únicas respeitadas: `computeEntradasJanelas` (janelas de
  receita, regra 13n), `vip.creditos`/`addCredito` (extrato de dias),
  `diamondLedger` (💎), `DB_ADMIN_AUDIT`/`logAdminAction` (trilha com
  reversão ↩️), `criarBackupCompleto` (snapshot), `preCheckComprovante`
  (leitura de comprovante — função ÚNICA da criação e do lote).

### Motores
1. **Ledger canônico** (`reconstruirLedger`): 1 lançamento por movimento
   de dinheiro, com confiança 0-100 e classificação VERIFIED/RECONCILED/
   SUSPECT/CONFLICT; valor segue a regra do canônico (pedido corrigido
   vence caixa cru); cross-check contra computeEntradasJanelas no próprio
   relatório (delta ≠ 0 = achado URGENTE).
2. **Dias VIP** (`auditarDias`): (a) TETO da vida — restante > soma de
   toda evidência (créditos+pedidos+códigos+trocas+presentes) = excesso
   inexplicável; (b) RELÓGIO DAS CONCESSÕES — reconstrução por DATAS
   (cada concessão estende a partir de max(quando, expiração vigente));
   evento sem data é aplicado HOJE (generoso, nunca acusa inocente);
   margem 2 dias; ajuste legado de set-expiry (13r) é ANCORADO (listado,
   nunca acusado). Auto-fix só existe pro teto; o relógio é sempre
   decisão.
3. **Comprovantes** (`preCheckComprovante` + lote `rodarComprovantes`):
   OCR completo (valor, data, hora, pagador, recebedor, instituição, ID
   da transação E2E), fingerprint SHA-256 SEMPRE (mesmo sem chave IA),
   fila educada 1/3s, incremental. Divergência de valor em pedido
   pago/ativo NUNCA se auto-corrige.
4. **Duplicidades**: mesmo usuário (score: valor+janela+hash+transação)
   e ENTRE usuários (nome do pagador+valor+janela+hash+transação; régua
   61 — valor+janela sozinhos nunca acusam; grupo >20 do mesmo valor é
   pulado).
5. **Códigos**: usos acima do limite (trava furada), VIP "de código" sem
   registro de resgate.
6. **Regras** (`avaliarRegras`): ~16 RULE_* com id ESTÁVEL (hash
   regra+alvo), severidade, confiança, esperado×atual, evidências e ação
   recomendada; lista priorizada (severidade > valor > confiança).

### Correções (3 níveis) e segurança
- SEGURAS (nível 2): `fix_dias` (capa expiração no teto) e
  `fix_caixa_cancelado` — SEMPRE com `criarBackupCompleto` antes (aborta
  se falhar), trilha no DB_ADMIN_AUDIT (fix_dias reversível pelo ↩️ de 1
  clique), validação PÓS-gravação (relê e aborta se não bater) e lote
  FIX-<auditId> (individual: FIX1-<auditId>).
- DECISÕES (nível 3): tudo que tem 2 explicações possíveis vira pergunta
  [corrigir/manter/ignorar] — decisão gravada NUNCA é re-perguntada.
- MODOS: simulacao / supervisionado (padrão) / auto-seguro — a rodada
  diária obedece.

### Central de Incidentes
Finding → incidente com ciclo de vida (🔴 NOVO → 🔵 AGUARDANDO_ADMIN /
🟡 EM_ANALISE → 🟢 RESOLVIDO / ⚫ IGNORADO / 🟣 CORRIGIDO_AUTO), histórico
por incidente (cap 30), sync dentro de toda auditoria (some=resolve,
volta=reabre — decisão explícita nunca reabre), cap 500 com prioridade
pros abertos.

### Autonomia e escala
- Rodada diária 02h BRT (dentro do bloco de robôs; MODO_APOSENTADO não
  roda) + push do resumo aos admins; botão "▶️ Rodar AGORA".
- IA administrativa `responder()`: respostas 100% determinísticas do
  último relatório, sempre com fontes.
- Escala: leituras (incidentes/decisões) reusam o relatório por 10s;
  `auditarBg` roda a varredura fora da requisição ({background:true});
  lote de comprovantes em fila educada; flags de usuário com cache 60s.
- Semáforo 🔴/🟡 por usuário na página Usuários; faixa na Visão do Dono
  ("existe algo precisando de mim?") lê só o status persistido.

### Rotas (todas admin-only)
POST /api/admin/cerebro/auditar [{background:true}] · GET status · GET
erros · GET relatorio/:id · POST corrigir {confirmar} · GET decisoes ·
POST decisao {id,escolha} · GET incidentes · POST incidente {id,acao} ·
GET exportar?fmt=csv|json&tipo=ledger|findings · GET comprovantes · POST
comprovantes/rodar · POST modo · POST diaria · POST perguntar.

### Testes
Suíte `npm test` cobre: caso 70 dias (teto), caso "3×30 esconde 30→60"
(relógio), gift-days/set-expiry/código sem data protegidos (nunca acusa
inocente), transação PIX reusada com arquivos diferentes, pagador igual
em 2 contas na régua exata (70 flagra / 60 não), rollback→reaparece→
re-corrige, decisão nunca re-pergunta, incidentes (ciclo completo),
modos, diária, perguntas com fonte. TEST_LOGIN_TOKEN NUNCA em produção.

## 🤖 CÉREBRO 3.0 (Master Command 3 · 22/08/2026 — 8 partes, 100% entregue)

O terceiro Master Command transformou o Cérebro Contábil num sistema
inteligente completo, mantendo a regra de ouro: **números são sempre
determinísticos; a IA nunca calcula, nunca inventa, nunca decide sozinha**.

1. **Gemini como camada 4** — o MESMO Gemini já instalado no site analisa
   só os casos AMBÍGUOS (fila educada, cache por hash de evidências,
   AI_ANALYSIS_LOG com versão de prompt, nível SUGGEST, whitelist de
   classificações; sem chave = pendente honesto).
2. **Tudo clicável** — todo card do dashboard abre a lista real por trás
   (`listarCategoria`, do último relatório persistido), com janelas
   1/7/30 e linha → 💳 Auditoria do usuário.
3. **Registro de Comprovantes** — 1 linha por comprovante com hash, OCR
   completo e STATUS derivado das mesmas regras dos motores (VÁLIDO—
   CONFIRMADO/VÁLIDO/DUPLICADO/DIVERGENTE/INCOMPLETO/EM ANÁLISE/
   CANCELADO), busca multi-campo.
4. **Decisões caso-pronto** — [💰 Registrar entrada no caixa] (caso
   Cleiton: snapshot + trilha + idempotente; dinheiro só entra após o
   clique do admin) e [🆗 São pagamentos DIFERENTES] (conclusão
   semântica); botões 👤/📎 de contexto em todo card.
5. **AJUSTE± — o caixa nunca apaga** — anulação = original preservado
   (`anuladoPor`) + lançamento de AJUSTE negativo pareado; ajuste manual
   ± com motivo obrigatório e snapshot; card 🧮 com motivo por linha;
   líquido idêntico, história permanente (delta R$0 provado).
6. **Tempo real** — aprovação/cancelamento/correção de valor acordam o
   cérebro (debounce 45s, uma auditoria completa pra N eventos, nunca
   por cima de outra); faixa ⚡ + botão "Reagir agora".
7. **Conferência 2.0** — busca multi-campo server-side (nome, e-mail,
   pedido, código, pagador OCR, transação PIX, instituição, valor),
   filtros status/tipo/janela e exportação CSV/JSON que baixa
   exatamente o que a tela mostra (fonte única `_confData`).
8. **Aprendizado com decisões** — registrar, NUNCA treinar: toda decisão
   humana agregada por regra/escolha (`aprendizado()`), mostrada nos
   casos parecidos (📚 historicoParecido) e passada à IA como contexto
   (participa do hash — cache invalida quando o histórico muda). Nunca
   suprime achado nem decide sozinho.

### Rotas novas do 3.0 (admin-only)
GET /api/admin/cerebro/ia · POST ia/rodar · GET lista?tipo&janela · GET
comprovantes/registro?status&q · POST decisao {registrar_entrada|
pagamentos_diferentes} · POST ajuste {finId|pedidoId,valor,motivo} ·
POST reagir · GET aprendizado · GET /api/admin/conferencia?q&status&
tipo&janela · GET /api/admin/conferencia/exportar?fmt&…filtros.

### Auditoria final
O smoke fecha com o pipeline diário completo e TODOS os motores das 8
partes vivos no mesmo relatório, com cross-check delta R$0.

## 💼 CÉREBRO 4.0 (Master Command 4 · 28/08/2026 — 5 partes, 100% entregue)

Contabilidade de EMPRESA: "quanto eu tenho a receber e quanto diego tem a
receber" respondido por uma régua só, do acerto ao fechamento.

1. **Motor de Sócios & Acerto** — `computeSocios()` (server.js) é a fonte
   única de "de quem é cada real": régua de valor idêntica ao canônico
   (exclui admin; pedido corrigido vence o caixa — delta R$0 provado);
   dono por ordem explicável (recebidoPor explícito → AJUSTE herda o dono
   do pagamento que anula → derivado da trilha via editorFromEmail → SEM
   DONO, nunca chuta). lucro = líquido − gastos; direito = lucro × split
   (sociosSplit nas Configurações, padrão 50/50); posição = recebido −
   gastos do bolso − repasses feitos + recebidos; TEM A RECEBER =
   direito − posição. Seção 💼 no topo da aba 🧠 com atribuição de
   entradas sem dono em 1 clique. recebidoPor/pagoPor viraram ENUM na
   edição (texto livre sumia do acerto em silêncio).
2. **Gastos com comprovante + DRE-base** — botão 💸 na aba 🧠 (reusa
   add_gasto com trilha/rollback e a compressão de imagem do Financeiro);
   `rel.dre` em toda auditoria (receita pela fonte única − gastos =
   resultado + margem, por categoria/pagador); regra
   RULE_GASTO_SEM_COMPROVANTE (MEDIA — nunca correção automática; alvo é
   o id do gasto, nunca e-mail); cards 💸/📈 clicáveis
   (listarCategoria('gastos')).
3. **DRE mensal + relatório executivo** — régua de valor/dono extraída
   pra `_finValorEfetivo`/`_finDonoDe` (compartilhada acerto+DRE — nunca
   2ª régua); `computeDreMensal()`: mês a mês por sócio/plano/categoria,
   soma dos meses = canônico (delta R$0) e todo mês fecha internamente no
   centavo; `relatorioExecutivoDre()` 100% determinístico com fontes;
   GET /api/admin/dre (JSON + CSV ;+BOM); botão 📅 na aba 🧠.
4. **Acerto operacional** — finCalcAcerto (client-side) EXCLUÍDO: card do
   Financeiro e Robô de Conferência consomem só GET /api/admin/socios;
   botão 🤝 Registrar repasse na aba 🧠 (add_repasse existente,
   pré-seleciona quem deve e sugere o valor; exclusão auditada).
5. **Fechamento mensal imutável** — POST /api/admin/fechamento congela o
   DRE do mês em DATA/fechamentos.json (refechar = 409); GET
   /api/admin/fechamentos lista com a divergência AO VIVO; regra
   RULE_FECHAMENTO_DIVERGENTE (ALTA, sempre decisão) acusa dinheiro
   mexido depois do fechamento; push aos admins no fechamento e acerto
   dos sócios na push diária; responder() do cérebro responde "quanto
   tenho a receber?" com o acerto ao vivo da fonte única.

### Rotas novas do 4.0
GET/POST /api/admin/socios(/split) · GET /api/admin/dre(?fmt=csv) ·
POST /api/admin/fechamento · GET /api/admin/fechamentos.

### Invariantes protegidos por teste
liquidoContabil === computeEntradasJanelas().total (delta R$0 exato) ·
soma dos meses do DRE = canônico · todo mês fecha internamente ·
repasse move o acerto exato com soma conservada e é reversível ·
fechamento imutável com divergência acusada pela auditoria.
