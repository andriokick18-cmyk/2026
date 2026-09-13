# 📜 Instruções do projeto — H2BApply (repo "2026")

> Carregado automaticamente por toda sessão de IA neste repositório.
> Este arquivo descreve o repo **`andriokick18-cmyk/2026`** — uma
> reconstrução enxuta do H2BApply, distinta de outros repositórios do
> mesmo dono que podem ter código e regras diferentes. Nunca presuma
> que uma feature descrita para outro repositório existe aqui sem
> conferir no código real primeiro.

## O que este repo é (e não é)

Leia o `README.md` primeiro — ele é a fonte da verdade sobre o que o
produto faz. Resumo: motor de envio de candidaturas H-2B/H-2A (manual e
automático) por Gmail, cadastro/login por usuário+senha (Google só para
conectar o Gmail de envio após plano pago, via /oauth/connect-send),
perfis de currículo, compra direta de plano (Pix → comprovante →
ativação, sem moeda intermediária), painel admin de contabilidade
(também por usuário+senha, v172b). **NÃO existe** (removido de propósito nesta
reconstrução): ranking/gamificação, IA/Gemini, Cérebro Contábil, aba de
Notícias, chat, seletor de idioma, códigos promocionais, multi-servidor,
menu/drawer hambúrguer. (Os robôs de coleta/alimentação de planilha VOLTARAM
por ordem do dono em 13/09/2026 — ver regra 📋 abaixo.)

Se uma tarefa mencionar qualquer uma dessas features removidas, pare e
confirme com o dono antes de reintroduzir — é bem provável que ele esteja
se referindo a outro repositório/projeto.

## Como trabalhar

1. **Corrija a causa raiz**, não o sintoma. Entenda a função inteira
   antes de editar, não só a linha do erro.
2. **`npm test` tem que passar 100% antes de todo commit** (roda
   `npm run check` + `smoke-test.js` — servidor real + fixtures, ~30s).
   O CI (`.github/workflows/ci.yml`) roda a mesma suíte a cada push.
3. **Nada de código morto**: função/rota/arquivo sem nenhum chamador real
   deve ser removido, não comentado ou deixado "por precaução".
   `npm run check` já roda `check-duplicates.js` contra função duplicada.
4. **Service Worker**: toda mudança em `index.html`/`admin.html`/`app.js`
   que altere algo visível ou executável exige subir o `CACHE_NAME` em
   `sw.js` junto — senão aparelhos ficam com JS velho em cache e a tela
   fica em branco ou desatualizada.
5. Commits contam o **porquê**, não só o quê. Sem emojis a menos que já
   seja o padrão do arquivo/commit sendo seguido.
6. Pesquise como sites/produtos de referência resolvem um problema de
   UI/UX antes de inventar um padrão novo — mas para qualquer conteúdo
   sobre vistos (H-2B/H-2A), só fontes oficiais (USCIS, DOL, Federal
   Register, travel.state.gov).

## Regras de produto (confirmadas com o dono — não reverter sem ordem nova)

- **Login do site (usuário comum) é usuário+senha — ZERO Google na
  landing.** v172b (dono, 12/09/2026): o PAINEL admin (`/admin`) passou a
  logar por usuário+senha — só 2 logins existem (`ADMIN_PANEL_LOGINS` em
  server.js: andrio/diego), senha em scrypt (nunca texto puro no código;
  `ADMIN_PANEL_PASS_ANDRIO`/`_DIEGO` no `.env` sobrescrevem sem mexer no
  código). A sessão criada mapeia pro `ADMIN_EMAIL`/`ADMIN_EMAIL_2` real —
  toda a lógica `isAdminVip`/`isAdminEmail` já existente continua intocada
  e vale igual, venha a sessão de onde vier (senha do painel OU login
  Google normal como um desses e-mails).
  **v172c (dono, 12/09/2026 — "não quero que tenha nenhuma ligação com o
  Google na landing page"): cadastro/login do usuário comum TAMBÉM virou
  usuário+senha** — `POST /api/cadastro` (nome, sobrenome, data de
  nascimento, cidade, estado, país, telefone, WhatsApp, usuário, senha —
  senha pode ser só números, mín. 8 caracteres desde a auditoria de
  segurança de 12/09/2026 — 4 era fraco demais pra quebra offline) e
  `POST /api/login`
  (usuário+senha), ambos em `server.js`, mesmo hashing scrypt do painel
  (`_hashPw`/`_verifyPw`). O USERNAME vira a chave `.email`/`DB_USERS` —
  regex `^[a-z0-9_.]{3,30}$` proíbe `@` de propósito (estruturalmente
  impossível colidir com um e-mail real de admin); `isAdminEmail(username)`
  é defesa extra. Conta nova nasce 100% free (sem trial), sem NENHUM
  e-mail conectado. `/oauth/start` virou um dead-end fechado (302 pra `/`,
  nunca mais abre o Google) — só existe pra não deixar um link antigo
  contornar o cadastro novo. O Google só entra em cena DEPOIS: quando a
  pessoa tem plano pago ativo e clica em enviar automático/manual, um
  botão abre `/oauth/connect-send` (gated por `isVipActive`) pra conectar
  o Gmail de ENVIO — com aviso obrigatório (modal `#gwm`,
  `showGmailConnectWarnModal`) de que esse e-mail é PERMANENTE (usado
  tanto no manual quanto no automático, nunca pode ser trocado depois).
  PROIBIDO reintroduzir login/cadastro por e-mail+Google na landing sem
  ordem nova do dono — se precisar recuperar uma conta Google antiga (de
  antes do v172c, sem senha) ou repor senha esquecida, é o admin quem
  carimba uma senha nova pela aba Usuários (botão 🔑, `POST
  /api/admin/set-password` em server.js), nunca reabrindo `/oauth/start`.
- **Compra direta de plano, preço sempre do servidor.** `GET /api/planos`
  é a fonte única de preço/limites; `POST /api/pedido` recalcula o valor
  oficial no servidor e NUNCA confia num `valorTotal` vindo do cliente.
  Consentimento (`consentimento:true`) é obrigatório pra usuário comum e
  fica registrado com timestamp/versão dos termos.
- **Ativação provisória automática é intencional** (dono, 21/07/2026):
  se o comprovante bate o valor do plano, o usuário é ativado NA HORA por
  alguns dias (janela provisória, `autoAtivarProvisorio` em server.js) —
  mas o pedido continua "pendente" na aba Pedidos do admin, e a
  confirmação humana continua SEMPRE obrigatória pro período cheio. Isso
  não é bug — é intencional, para não fazer o usuário esperar a revisão
  manual pra começar a usar. Cancelar um pedido nesse estado (comprovante
  falso, por exemplo) já revoga o plano provisório automaticamente — ver
  `if(pd.autoAtivado && !pd.ativadoEm)` na rota `PATCH /api/pedido/:id`.
  O painel (`admin.html`) destaca esses pedidos com selo "já ativo
  (provisório)" e sobe eles pro topo da lista — mantenha isso ao mexer
  na tela de Pedidos Pendentes.
- **Chave Pix**: uma só, consolidada, vive em `PIX_KEY`/`PIX_NAME` no
  `app.js`. Desde 12/09/2026 (ordem do dono) é a chave aleatória do Diego
  (`PIX_NAME='Diego Cardoso'`) — todo dinheiro cai no nome dele agora, não
  mais no Andrio. Não reintroduzir múltiplas chaves nem voltar pro Andrio
  sem ordem nova.
- **Português fixo**: o app não tem seletor de idioma nem detecta idioma
  do navegador — é só em português, de propósito.
- **📋 Alimentação automática das planilhas (v174, dono, 13/09/2026 — "as
  planilhas devem ser alimentadas, igual elas já são hoje, com todas as
  informações de cada vaga; esse sistema você pode trazer do h2bapply.com
  antigo")**: portado pra `mod-planilhas.js` (injeção de dependências por
  getters — as planilhas em memória são REATRIBUÍDAS no loadSheets, o
  módulo nunca guarda referência direta). 5 robôs, ligados em
  `PLANILHAS.iniciarAgendadores()` no bloco de robôs do server.listen:
  (1) ENRIQUECIMENTO vaga a vaga pela API do DOL (e-mail, cidade, datas,
  nº de vagas, telefone, salário, SOC, funções, horas, URL) — 1 vaga por
  vez, backoff em 403/429, salva no disco a CADA vaga e retoma pelo
  disco (15s pós-boot, 12h, vigia 30min, e no upload de planilha);
  (2) FRESCOR: status/datas/salário das vagas já completas (H-2B mais
  nova + H-2A), 120 por ciclo (5min, 6h); (3) VAGAS NOVAS H-2A 2x/dia:
  ENTRA vaga ativa nova (nunca duplica), SAI inativa (negada/retirada/
  temporada encerrada), trava se >50% sumiria de uma vez; (4) COLETA do
  feed ZIP do datahub (dedupe por case number, filtro de qualidade,
  integridade) → RASCUNHO que o admin publica com 1 clique
  (`coleta-publish`, idempotente, avisa o radar na 1ª publicação);
  (5) PLANILHAS DO MÊS (núcleo único `runPlanilhaMensal`): "H-2A <Mês>
  <Ano>" (chave `h2a-AAAAMM`) PUBLICA SOZINHA acima de
  `H2A_BIM_MIN_PUBLICAR` (padrão 200) — exceção autorizada por escrito
  SÓ do H-2A; "H-2B <Mês> <Ano>" (`h2b-AAAAMM`) fica SEMPRE em rascunho
  (`autoPublish:false` no wrapper — se o dono autorizar por escrito, é
  trocar ali, nunca no núcleo). A H-2B mensal publicada vira a "H-2B
  mais nova" sozinha (`latestH2bKey` entende `h2b-AAAAMM`). Painel:
  aba "Planilhas & Robôs" (`GET /api/admin/planilhas/status` — tudo numa
  chamada; forçar cada robô; coleta manual com log ao vivo; publicar/
  enriquecer/baixar/remover por planilha). REGRAS: todo robô só loga e
  avisa em erro, NUNCA derruba o servidor nem apaga a planilha anterior
  se a coleta falhar; no `npm test` os agendadores ficam DESLIGADOS
  (`isTest`) e cada robô é provado pelas rotas com o feed falso do
  smoke (`DOL_FEED_BASE`); o sandbox não alcança o DOL — enriquecimento
  real só em produção. Upload manual do admin (`/api/admin/sheet/
  upload`) agora nasce `published:true` (antes o registro ficava sem o
  campo e `/api/sheets-list` escondia a planilha de todo usuário). O log
  humano de TODOS os robôs (`botLog` → `DB_BOT_LOGS`, ring 1500 em memória)
  viaja no mesmo `/api/admin/planilhas/status` (`botLogs`) e aparece no
  painel "Últimas ações dos robôs" da aba — antes era escrito e nunca lido.
- **ZERO envio grátis, sem exceção** (dono, 11-12/09/2026, reforçado várias
  vezes: "nenhum usuário vai ter envio grátis... ninguém sendo free
  consegue enviar nada e nem fazer autenticação"). `PLAN_LIMITS`/
  `PLAN_LIMITS_NEW` em `mod-config.js`: `free:{manual:0,auto:0}` sempre —
  qualquer fallback tipo `||10`/`||20` num limite é BUG (mascara um 0 real
  com um número falso; use sempre `??`). O botão de conectar Gmail
  **não existe/não funciona pra conta free** — free só navega/vê vagas e
  planos, nunca autentica Gmail nem envia nada, manual ou automático.
- **Plano vencido bloqueia de vez, com data (v172h, dono, 12/09/2026)**:
  quando o plano de alguém vence (mesmo com Gmail já conectado de antes),
  manual E automático ficam bloqueados — `/api/send`/`/api/auto/start`
  devolvem 402 citando a data exata de vencimento (`planGateMsg()` em
  `server.js`); um job automático que já estava rodando quando o plano
  vence PARA de vez (`scheduleAuto()` seta `status:"paused_no_vip"`,
  nunca mais fica reagendando pra meia-noite pra sempre). O aviso na tela
  sempre cita a data real ("seu plano venceu em DD/MM/AAAA"), nunca um
  "expirou" genérico. Os botões de conectar Gmail (manual e automático)
  são cartões grandes de ação — não voltar a ser pilulazinha pequena.
- **Manual e automático vencem SEPARADOS — nunca um herda o limite do
  outro (v172i, 12/09/2026, vazamento de receita real)**: `getPlan()`
  devolve um nome só, mas `vip.manualExpires` e `vip.autoExpires` são
  independentes. `getManualLimit`/`getAutoLimit` (server.js) devolvem 0
  ANTES de consultar qualquer tabela quando a própria dimensão não está
  ativa (`isManualVipActive`/`isAutoVipActive`). PROIBIDO voltar a
  derivar um limite só de `PLAN_LIMITS[getPlan(u)]` — foi assim que
  manual vencido ganhava 200 envios/dia do automático (e doublepro com
  automático vencido ganhava 400 pelo atalho `u.plan`).
- **Páginas públicas de SEO são produto, não enfeite** (v172j,
  12/09/2026): `/h2bapply-funciona`, `/h2b-e-golpe`, `/guia` e as geradas
  por estado/categoria (`/vagas-h2b/*`, templates em server.js) ficaram 5
  dias com o CTA principal em `/oauth/google` (404) e vendendo plano grátis
  com envio + limites da tabela legada. O CTA de cadastro é SEMPRE
  `/?cadastro=1` (a landing abre o card de cadastro direto —
  `maybeShowServerSelect` em app.js); toda mudança em `PLAN_LIMITS_NEW`,
  preço, regra de plano ou login tem que ser espelhada nessas páginas no
  MESMO commit (guarda no smoke: números da página "funciona" = mod-config).
  `G-XXXXXXXXXX` (GA) nessas páginas é placeholder — só o dono troca.
- **Usernames reservados nascem admin** (`ADMIN_RESERVED_USERNAMES` em
  `server.js`, hoje `andrio`/`andrew`/`diego`): concedido NA HORA do
  cadastro (`/api/cadastro`) + migração de apoio no boot pra conta
  pré-existente. `/api/cadastro` é rota pública — risco aceito e conhecido
  de corrida (alguém registrar o username antes da pessoa real), o dono
  foi avisado e decidiu assim mesmo. Não adicionar username novo à lista
  sem ordem expressa do dono (cada um vira admin de verdade).
- **Nada de texto do "site antigo"** (dono, 12/09/2026: "nosso site é o
  2026, eu não quero nada do site antigo"). Antes de escrever/revisar
  qualquer card explicativo ou copy nova, confira se não descreve um
  conceito que esta reconstrução removeu (moeda intermediária/diamantes,
  processo interno que o usuário não precisa saber, plano grátis com
  limite, etc. — ver "O que este repo é" no topo deste arquivo).

## Variáveis de ambiente

`.env.example` é a fonte da verdade (revisado contra `process.env.*` real
no código — se adicionar uma env nova, adicione lá também). Antes de
remover ou "corrigir" uma env como se fosse obsoleta, confirme com
`grep -rn "process.env.NOME_DA_ENV" *.js` — já aconteceu desse arquivo
ficar desatualizado citando variáveis de uma feature que não existe mais.

## Documentação de deploy/verificação Google

- `GOOGLE_VERIFICATION_CHECKLIST.md` — checklist atual da verificação
  OAuth do Google. Itens `[CÓDIGO]` já resolvidos no repo; itens `[DONO]`
  só o dono resolve (Search Console, Cloud Console, vídeo).
- `GOOGLE_VERIFICATION_VIDEO_SCRIPT.md` — roteiro do vídeo de verificação.
- `RESTAURACAO_BACKUP.md` — como restaurar um backup (drill real testado).

Se encontrar outro arquivo `.md`/`.txt` na raiz descrevendo uma feature
da lista "o que NÃO existe" acima, ou citando outro repositório como
"fonte única"/"servidor 1/2/3", é lixo herdado de outro projeto — apague
em vez de tentar reconciliar.
