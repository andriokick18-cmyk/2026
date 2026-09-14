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
- **📧 Cadastro com e-mail verificado + conta de notificações (v175, dono,
  13/09/2026 — "cadastro precisa ser obrigatoriamente preenchido completo;
  apenas 1 WhatsApp; a pessoa só pode concluir o cadastro depois de
  verificar o seu email; SuporteH2bapply@gmail.com vai ser o e-mail do
  site que envia os códigos")**: (1) `mod-notif.js` guarda UMA conta
  Google conectada pelo admin (Admin → Notificações → Conectar conta
  Google, rota `/oauth/notif-connect`, state `__notif__` no
  `/oauth/callback`, só escopo gmail.send, refresh_token cifrado em
  `DATA_DIR/notif_account.json`) e é a ÚNICA origem de e-mail do sistema:
  código de confirmação do cadastro, código de recuperação de senha e o
  aviso de pedido novo pros e-mails de admin (com comprovante anexado;
  toggle na aba). Usuário NÃO recebe nenhum outro e-mail (sendNotifEmail
  segue no-op). No `npm test` nada sai pra internet: o módulo grava em
  `notif_outbox.json` e o smoke lê o código de lá (`/api/test/notif-
  conectar` conecta uma conta falsa, só com TEST_LOGIN_TOKEN). (2) Código
  de 6 dígitos, 5 min, hash na memória, 5 tentativas, 60s entre envios, 3
  envios/15min por e-mail, 30 pedidos/h por IP; confirmar devolve um token
  HMAC (e-mail + finalidade + 30 min) que `POST /api/cadastro` EXIGE
  (`emailToken`). (3) `/api/cadastro` obriga TODOS os campos (nome,
  sobrenome, nascimento DD/MM/AAAA real 16-100 anos, cidade, estado, país,
  WhatsApp ≥10 dígitos — vira `phone` também, campo Telefone separado
  MORREU —, Gmail `…@gmail.com` único entre contas: é o Gmail que envia
  as candidaturas, guardado em `emailContato`/`emailVerificadoEm`).
  Username reservado (andrio/andrew/diego) só nasce admin se o e-mail
  confirmado for de admin (fechou a janela "quem cadastrar primeiro leva o
  admin"). `/api/login` aceita o e-mail cadastrado no lugar do usuário.
  (4) Recuperação: `POST /api/senha/enviar-codigo` (resposta GENÉRICA,
  sem enumeração) + `POST /api/senha/redefinir` (código + senha ≥8,
  derruba todas as sessões antigas). (5) `/oauth/connect-send` manda
  `login_hint=emailContato` e o callback RECUSA (com revoke) Google
  diferente do e-mail cadastrado; o modal `#gwm` mostra o endereço em
  destaque ("ENTRE COM ESTE E-MAIL"). Conta legada sem `emailContato`
  segue a regra antiga. (6) O wizard de onboarding de 6 passos foi
  REMOVIDO (pedia de novo o que o cadastro já pede); no lugar, a janela
  `#cv-prompt-overlay` "Cadastre seu currículo agora" (1x por sessão, até
  existir perfil) abre o editor de perfil, que agora nasce com 3 títulos +
  3 textos ABERTOS (`_pePad`, mínimo da casa; do 4º em diante remove),
  rótulos explicando título × corpo, aviso de que a cover letter NÃO é
  obrigatória, e inglês/CNH (alimentam a nota de encaixe) como opcionais.
  Textos novos do editor têm data-i18n + dicionário nas 3 línguas (a
  CATRACA do smoke continua no teto 7). PROIBIDO: cadastro sem e-mail
  confirmado, 2º canal de e-mail fora do mod-notif, e reintroduzir o
  wizard antigo. **E-mails de admin (v175b, dono: "meu email adm é
  andrio.usa2026@gmail.com")**: `ADMIN_EMAIL` padrão =
  andrio.usa2026@gmail.com (dono; login "andrio" do painel), `ADMIN_EMAIL_2`
  padrão = jesuscristh22@gmail.com (Diego; login "diego"); os avisos de
  compra pela conta de notificações vão SÓ pros 2 (`_notifDestinatarios`);
  andrio.kick18@gmail.com e as outras contas auxiliares seguem admin pelo
  `ADMIN_EMAILS_EXTRA`, sem receber aviso. A env do Render manda, se existir.
  **🔐 v176 (dono, 13/09/2026 — "quando o sistema identificar meu e-mail
  que é de adm ele não pede verificação... desativa o código pra esse
  cadastro do usuário andrio que é o adm")**: ÚNICA exceção sancionada ao
  "PROIBIDO: cadastro sem e-mail confirmado" acima — em
  `/api/email/enviar-codigo`, se o e-mail digitado é de admin
  (`isAdminEmail`) e AINDA NÃO tem conta, o servidor devolve o token de
  "e-mail verificado" NA HORA, sem código, mesmo com a conta de
  notificações desconectada (resolve o ovo-e-galinha: o dono não
  conseguia criar a PRÓPRIA conta de usuário sem antes conectar a conta
  de notificações, e não tinha como conectá-la sem antes existir sua
  conta). Risco aceito por escrito pelo dono após eu explicar (pergunta
  feita, ele confirmou a mesma decisão): até esse e-mail completar o
  cadastro pela 1ª vez, quem SOUBESSE o texto exato do e-mail de admin
  (nunca aparece em tela nenhuma — conferido em index.html/app.js)
  poderia criar conta com ele sem provar dono da caixa de entrada. A
  janela fecha SOZINHA E PRA SEMPRE assim que a conta nasce (o mesmo
  e-mail volta a bater no 409 de sempre). Toda ativação do bootstrap é
  logada + `pushGlobalEvent("admin_bootstrap_email",...)`. PROIBIDO:
  estender esse bypass pra qualquer e-mail que não seja `isAdminEmail`,
  ou tirar o log/auditoria dele.
- **🚨 v177 — AUDITORIA COMPLETA DE 135 AGENTES (dono, 14/09/2026 —
  "confirme se tudo está funcionando... use seu sistema para se fazer no
  mínimo 50 perguntas... mesmo que leve horas")**: rodei um workflow com
  135 subagentes cobrindo 14 áreas do site, 122 perguntas específicas,
  cada achado verificado por um 2º agente cético tentando refutar — 103
  confirmados (39 graves), 4 descartados. Duas entregas:
  **(1) 1ª leva de correções seguras** (mesmo commit v177-FIX): regex de
  robô parado em mod-sentinel.js cobrindo os 3 status reais de auth
  quebrada (URGENTE — VIP pagante com automático morto ficava invisível
  pro vigia); toggle "avisar pedido novo" passou a bloquear os 2 canais
  de uma vez (antes só desviava pro Gmail pessoal do admin quando
  desligado); caminho legado do aviso agora usa `_notifDestinatarios()`
  (só os 2 sócios — antes vazava pros 3 e-mails auxiliares); conta admin
  nascida por username reservado (v175/v176) passou a ser reconhecida
  por `isAdminVip(u)` nas guardas de "Esqueci minha senha" (fechava uma
  escalada real: quem tivesse o Gmail conectado resetava a senha da
  conta admin inteira sem nunca precisar do ADMIN_PANEL_PASS) e no TTL
  de sessão (24h, não mais 7 dias); `/api/admin-panel/login` passou a
  reusar a conta pelo username reservado quando ela já existe (antes
  criava uma 2ª conta paralela pro mesmo admin, chave e-mail vs
  username); tutorial corrigido (prometia 10 envios/dia grátis —
  free é 0/0). 10 checks novos no smoke.
  **(2) Leitura real do comprovante por IA** — achado mais grave da
  auditoria: desde o v161 ("cura da camada Gemini") a leitura automática
  do comprovante era 100% código-morto em produção — só existia dentro
  do gancho `TEST_LOGIN_TOKEN`; fora dele `preCheckComprovante` sempre
  devolvia `null`, então "ativação provisória automática" e o texto dos
  Termos prometendo confirmação automática nunca eram reais pra nenhum
  usuário. Perguntei ao dono como resolver (implementar de verdade vs.
  só corrigir o texto vs. deixar pra depois) — ele escolheu implementar.
  `preCheckComprovante` agora chama o Gemini de verdade
  (`GEMINI_API_KEY`, modelo `gemini-2.0-flash` por padrão,
  `GEMINI_MODEL` opcional) com `responseSchema` estruturado — a IA SÓ
  extrai dado bruto (valor/data/pagador/recebedor/instituição/
  transacaoId); quem decide CONFERE×DIVERGENCIA é sempre o código,
  comparando o valor lido com `pedido.valorTotal` (regra da casa:
  "matemática sempre determinística, IA nunca decide número" — nenhuma
  mudança nessa filosofia, só a peça que faltava foi religada). Sem
  `GEMINI_API_KEY` configurada, continua HONESTAMENTE pendente (nunca
  finge que leu — mesmo comportamento de sempre). Falha de rede/resposta
  quebrada do Gemini grava veredito `ERRO` (nunca trava, nunca inventa).
  `_geminiComprovanteRequestBody`/`_geminiComprovanteParse` são funções
  PURAS (sem I/O) exercitadas via o gancho `/api/test/gemini-check` —
  8 checks novos provam CONFERE/DIVERGENCIA/ILEGIVEL/ERRO com respostas
  do Gemini simuladas, sem a suíte NUNCA tocar rede de verdade.
  **Pendente do dono**: configurar `GEMINI_API_KEY` no Render (grátis em
  https://aistudio.google.com/apikey) — sem ela o comprovante segue
  pendente de conferência manual, sem quebrar nada.
  **⚠️ Backlog restante da auditoria (não implementado ainda, prioridade
  decrescente)**: painel admin sem UI pra ver histórico de aprovados/
  cancelados, conceder/revogar VIP manualmente (só via API direta hoje);
  ~60 achados médios/baixos catalogados (detalhes completos no relatório
  entregue ao dono em 14/09/2026).
- **🚫 v178 — SEM CORREÇÃO DE PEDIDO: valor errado cancela, não conserta
  (dono, 14/09/2026, respondendo o item acima — "não vai ter correção de
  pedidos... se a pessoa errar o pedido não vai ser aceito, pronto...
  esse pedido vai ter que ser excluído, vai ter que ser criado um novo
  pelo usuário")**: decisão de produto que FECHA a pergunta "vai ter UI
  pra corrigir valor de pedido?" — a resposta é não, nunca vai ter,
  porque não existe mais pedido com valor errado pra corrigir: o Gemini
  (v177) lê o comprovante e, se o valor NÃO bate com o preço do plano
  (DIVERGENCIA — leitura confiável, não é o caso de ILEGIVEL/ERRO, que
  continuam pendentes pra revisão humana porque a IA não tem certeza do
  que leu), o pedido é CANCELADO na hora, sozinho, sem nenhuma decisão
  de admin — `_autoCancelarSeDivergente()` chama a fonte única
  `_cancelarPedidoInterno()` (extraída do antigo branch
  `status==="cancelado"` do PATCH /api/pedido/:id — usada tanto pelo
  cancelamento manual do admin quanto pelo automático, nunca 2 lógicas).
  O cliente vê o motivo exato (`motivoCancelamento`, "comprovante mostra
  R$X, plano custa R$Y") em Minhas doações e precisa criar um pedido
  novo com o valor certo — não existe (e nunca vai existir) um caminho
  de "corrigir o valor e aprovar mesmo assim" pra esse caso. Ativar um
  pedido já cancelado (por qualquer motivo) é bloqueado com 409
  `jaCancelado`. O detector de "comprovante já usado" (v2.0-P2) passou a
  considerar também pedidos cancelados como possível duplicata (antes só
  pago/ativo) — senão o mesmo arquivo/transação reaparecer depois de um
  auto-cancelamento passava batido. **🐛 v178-FIX (achado pelos próprios
  testes antes de qualquer deploy)**: a 1ª versão de
  `_cancelarPedidoInterno` nasceu por engano DENTRO do callback do
  `http.createServer` (função aninhada, só existia durante 1
  requisição) — chamada de FORA desse escopo (por
  `_autoCancelarSeDivergente`) dava `ReferenceError`, engolido em
  silêncio pelo `.catch(()=>{})` do fire-and-forget: nenhum pedido
  divergente era cancelado de verdade, apesar do código "parecer"
  certo. Corrigido movendo a função pro escopo do MÓDULO. Lição: função
  chamada de fora do request handler NUNCA pode ser declarada dentro
  dele — os testes reais (não só `node --check`) são o que pega esse
  tipo de bug. PROIBIDO: reintroduzir qualquer caminho de "editar valor
  de pedido divergente e aprovar" — a régua da casa agora é
  cancelar-e-refazer, não corrigir.
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
  disco a partir da 1ª linha SEM e-mail (v174c — nunca "contagem − 5":
  buracos espalhados seriam pulados), fila ordenada por IMPACTO (planilha
  com mais vagas sem e-mail primeiro; a H-2A built-in entra na fila)
  (15s pós-boot, 12h, vigia 30min, e no upload de planilha);
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

## v177-FIX2 (14/09/2026) — 2ª leva da auditoria de 135 agentes

Continuação do v177-FIX/v177/v178: mais 8 achados MÉDIOS/BAIXOS do
backlog da auditoria (`achados-media.txt`/`achados-baixa.txt`),
corrigidos e testados. (1) `getSess()` agora confere o TTL (24h admin /
7d usuário) NA HORA de cada requisição — antes uma sessão vencida
continuava sendo aceita por até 5min extras, até a varredura periódica
apagá-la. (2) `/api/login` e `/api/admin-panel/login`: o delay
anti-timing de 300ms era SOMADO depois da checagem — conta inexistente
(sem scrypt) respondia mais rápido que senha errada numa conta que
existe, vazando por latência se o username/e-mail tem cadastro.
`_atéTempoMinimo()` nivela pro mesmo tempo total sempre. (3) XSS real:
`${icon}` (campo livre do perfil, até 8 chars, sem allowlist) não
passava por `esc()` no painel de perfis automáticos — a guarda
check-xss-guard.js trata a instrução `.innerHTML=` INTEIRA como segura
só porque outro `${}` dela (`names`) já tinha `esc()`, mascarando esse.
Corrigido (`${esc(icon)}`, `${esc(cats)}`); a fraqueza estrutural da
própria guarda (checa a instrução inteira, não cada `${}`) fica
registrada aqui como risco conhecido, não corrigida agora (mudar a
heurística da guarda é projeto à parte, risco de falso-positivo em
massa). (4) Cancelamento de pedido ativado agora registra o ESTORNO no
extrato `vip.creditos` (dias negativos, `origem:"estorno"`, ligado ao
`pedidoId`) — antes mexia direto em `manualExpires`/`autoExpires` sem
deixar rastro, e o crédito original de +N dias ficava pra sempre como
se os dias ainda estivessem concedidos. (5) Boot avisa alto no log se
`_notifDestinatarios()` tiver menos de 2 e-mails (`ADMIN_EMAIL`/
`ADMIN_EMAIL_2` vazio ou malformado no Render passava batido em
silêncio). (6) `/api/send` (envio MANUAL) agora recusa (400) mandar
candidatura pra e-mail com bounce já conhecido (`DB_INVALID_EMAILS`) —
antes só o robô automático pulava esses (`comInvalidos:true` no
`_excluirEnviadosFn`), o manual gastava o limite diário à toa. (7)
`statusPainel().coleta` ganhou o campo `published` (lido de
`getMeta()[dolColeta.key]`) — antes o admin.html sempre mostrava "em
rascunho, publique abaixo" mesmo depois de publicar com sucesso, porque
esse campo nunca existia no objeto. (8) DELETE de planilha extra agora
PARA o bot de Enriquecimento se ele estiver rodando nela (mesma trava
cooperativa do botão "Parar") — antes seguia gastando chamadas ao DOL à
toa até o ciclo terminar sozinho; e `_saveEnrichedSheet` só carimba
`savedAt` quando gravou de fato em algum destino real — antes carimbava
incondicional, então uma planilha apagada nessas condições aparecia
como "salva" sem gravar NADA em disco. 17 checks novos (comportamentais
+ estruturais), sw v42. Backlog restante da auditoria (findings de menor
impacto — CSP `unsafe-inline`, rateMap em memória, timing do
`_clientIp`, duplicidade entre plano diferente do mesmo cliente, etc.)
continua em `achados-media.txt`/`achados-baixa.txt` no scratchpad da
sessão — a régua de decisão (maior impacto, menor risco) priorizou os
8 acima nesta rodada.

## v177-FIX3 (14/09/2026) — 3ª leva da auditoria de 135 agentes

Mais 4 achados corrigidos e testados (sem mexer em nenhum arquivo
servido ao cliente — sem bump de sw.js): (1) `/api/login`: mensagem de
conta LEGADA (login era só Google, sem senha) agora cita "Esqueci minha
senha" como caminho mais rápido — `/api/senha/enviar-codigo` já
destrava essa conta sozinha, sem precisar do WhatsApp; a mensagem só
mandava pro suporte. (2) Rate-limit do login do painel admin
(`/api/admin-panel/login`) agora inclui o USERNAME tentado na chave —
antes era só IP, compartilhado entre os 2 ÚNICOS logins possíveis
(andrio/diego); se os 2 estiverem atrás do mesmo IP (mesmo escritório/
Wi-Fi/VPN), uma sequência de erros de digitação de UM consumia o limite
do OUTRO também. (3) `/api/send` (manual): erro nos passos PÓS-ENVIO
(indexApp/markSent/cálculo de limite) tinha o MESMO catch do envio pelo
Gmail — mas nesse ponto o e-mail JÁ FOI ENVIADO (o resultado do Gmail
já existe), então uma falha de contabilidade local caía no catch que
traduz erro de Gmail e devolvia "falha" pro usuário de uma candidatura
que já saiu de verdade (e, se `addHist` já rodou, já está bloqueada
contra reenvio). Agora tem o PRÓPRIO try/catch: erro aqui loga alto mas
sempre devolve `ok:true` (com aviso de que o histórico pode demorar a
aparecer) — nunca mais mistura "envio falhou" com "só a contabilidade
falhou". (4) `mod-filtros.js facetas()`: a distribuição de `status`/
`grupo` (💎 DoublePro, dado exclusivo) era SEMPRE calculada e devolvida
no JSON de `/api/vagas/filtros`, mesmo pra usuário grátis — o gate
`ctx.isDP` só impedia o FILTRO de restringir a lista, nunca a FACETA em
si (o front escondia atrás do cadeado, mas o dado já tinha vazado na
resposta). Agora os dois blocos só rodam com `ctx.isDP===true`. 4
checks novos (1 comportamental + 3 estruturais), suíte 100% verde
(413 checks). Backlog restante continua em
`achados-media.txt`/`achados-baixa.txt`.
