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

## v177-FIX4 … v177-FIX8 (14/09/2026) — 4ª a 8ª levas da auditoria de 135 agentes

Continuação direta do v177-FIX/FIX2/FIX3: re-verifiquei cada achado restante
de `achados-media.txt`/`achados-baixa.txt` contra o código ATUAL (muita coisa
mudou desde a auditoria original) e corrigi os que ainda eram reais. 5 commits,
26 checks novos, suíte 100% verde (439 checks). O que mudou, por leva:

**v177-FIX4 — dinheiro/pedidos.** (1) `vip.pedidoId` é UM valor só: um 2º
pedido com comprovante que CONFERE sobrescrevia o vínculo do provisório, e o
cancelamento do 1º pulava a revogação EM SILÊNCIO (o admin via "cancelado com
sucesso" e o cliente continuava com o plano — reproduzido de verdade pela
auditoria); de quebra, cada pedido novo renovava a janela de 3 dias de graça,
sem teto. Agora só existe UM provisório por vez — o 2º pedido espera a
confirmação humana. (2) O guard de pedido duplicado comparava plano IGUAL
(string exata): quem pagou 2× em poucos dias escolhendo planos DIFERENTES
passava batido; continua sendo só aviso confirmável (upgrade legítimo aprova
com 1 clique a mais). O fallback de data também estava errado (`criadoEm` não
existe; o campo é `createdAt`). (3) Pedido criado pelo admin com valor FORA da
tabela oficial agora carimba `pedido_valor_fora_tabela` em `DB_ADMIN_AUDIT` —
era o único R$ que entrava sem tabela e sem trilha. (4) A 2ª cópia
(inalcançável) das validações do comprovante saiu do objeto do pedido.

**v177-FIX5 — envio manual e automático.** (1) `getSenderToken` NUNCA
consultava `getMaxSenders`: depois de um downgrade DoublePro→VIP (ou do plano
vencer) os extras seguiam no rodízio — mandar por 2 Gmails pagando por 1,
mesma classe de vazamento do v172i. Corta pelo excedente (ordem de cadastro),
sem apagar nem desativar nada. (2) `/api/auto/start` não tinha lock nenhum (o
manual tem desde o v18): duplo clique/2 abas em rede lenta passavam os dois e a
2ª fila jogava fora a 1ª. Reserva por usuário (`_autoStartInFlight`), liberada
no `finally`. (3) `d.pdfBase64` ia CRU pro anexo do e-mail do empregador sem
nenhuma das validações do upload — agora mesma régua (tamanho + magic bytes
`%PDF`), soltando a reserva de slot antes do return (disciplina do v172e). (4)
O refill da fila rodava ANTES da checagem de plano e já marcava `active:true`.
(5) `/api/cv/upload` respondia "salvo" sem olhar o retorno do `saveCv`. (6) O
selo 🌱 de aquecimento contava o histórico pelo username de login (conta v172c
mostrava sempre 0 — a regra 13a manda mostrar). (7) O freio de rajada do manual
(20/60s) não isentava admin, ao contrário do cooldown de 1min (v120).

**v177-FIX6 — telas do usuário.** O convite "cadastre seu currículo" e o aviso
obrigatório de WhatsApp exigiam `sessionStorage.h2b_terms_session`, gravado SÓ
no fluxo de CADASTRO: em qualquer LOGIN os dois ficavam mudos, mesmo pra quem
está com zero perfil (não consegue se candidatar a nada). O que aquele gate
queria evitar já é garantido pela checagem do `terms-overlay`. Junto: o convite
não nasce mais por cima do editor de perfil aberto; o aviso de WhatsApp é
cobrado ao fechar o convite (antes rodava 1× aos 2,5s e desistia); `doLogout`
limpa o sessionStorage (aparelho compartilhado: Conta B herdava o "já pulei" da
Conta A); `/api/settings` passou a ter whitelist de idioma (pt/en/es,
normalizado) — antes gravava QUALQUER string de 10 chars num campo que o front
aplica direto; e 2 rótulos do painel pararam de prometer o que o sistema não
faz (o aviso de compra dispara COM OU SEM comprovante; o motivo do cancelamento
não é notificado — `pushToUser` é no-op nesta reconstrução, o cliente lê ao
abrir o site).

**v177-FIX7 — robôs de planilha e concorrência.** (1) O frescor só olhava a
H-2B mais nova e a chave FIXA `h2a-jun2026`: a planilha H-2A DO MÊS
(`h2a-AAAAMM`, que se publica sozinha acima de 200 vagas) envelhecia sem
NENHUMA reconferência de status/data/salário — justo a mais nova do site. Entra
a mais recente já publicada (`latestH2aMensalKey`). (2) Coleta manual cuja
janela de datas do próprio admin cortou quase tudo culpava "resposta suspeita
do DOL"; agora nomeia o filtro e mostra as datas. (3) DRILL REAL de dupla
ativação do mesmo pedido (2 sócios clicando junto, corpo subindo devagar): a
guarda `pd.ativadoEm` era correta mas só por leitura de código, sem teste com 2
requisições vivas — é dinheiro (dias e caixa em dobro). (4) Os códigos de
cadastro vivem só na memória e este repo faz deploy a cada commit: as mensagens
agora NOMEIAM o reinício e avisam que o formulário continua preenchido. (5)
Aviso de compra que sai pro Andrio mas falha pro Diego agora grava
`avisoFalhas` no próprio pedido + erro alto no log (antes o `_okN>0` dava a
rodada por boa e o sócio sem aviso não tinha como saber).

**v177-FIX8 — rótulo honesto de plano e cobertura do legado.** (1) O badge do
Perfil rotulava pelo NOME do plano com mapa próprio, e `getPlan()` devolve
"vipro" também pra quem só tem o automático: a pessoa via "⭐🤖 VIPro" com 0
manuais/dia. Passa a usar `planBadgeHTML()` (fonte única honesta: ⭐ VIP e/ou
🤖 Pro pelo que está ativo de verdade). (2) Os ramos de COMPATIBILIDADE LEGADA
de `isManualVipActive`/`isAutoVipActive` (conta com `vip.expiresAt` único) não
tinham NENHUM teste — nenhuma fixture usava esse campo, justo onde a separação
manual×automático do v172i pode vazar de novo. Cobertos os 3 casos. (3)
Mismatch de conta Google no Conectar-Gmail gravava o evento no authTimeline do
e-mail digitado POR ENGANO (que quase nunca existe em DB_USERS) — vai pro DONO;
e revoke que falha (acesso órfão no Google) deixa rastro.

**Achados re-verificados que NÃO eram mais reais** (não mexer de novo):
`notifToggleAvisos` já recarrega o painel (corrigido no v177-FIX); a leitura do
comprovante por IA e a ativação provisória deixaram de ser código morto no
v177; o hash SHA-256 do comprovante não tem corrida (o bloco roda antes do 1º
`await` de `preCheckComprovante`); os comentários "Gemini Vision" voltaram a
ser verdade com o v177.

**Deixados de propósito (decisão registrada, não esquecimento)**: CSP
`unsafe-inline` (migração pra nonce/hash é projeto à parte); lockout de conta
por brute-force (decisão de produto); remover as dezenas de rotas
`/api/admin/*` sem chamador no front (deletar vs. construir UI é decisão
humana); `rateMap` em memória e confiança no X-Forwarded-For (riscos conhecidos
sem correção segura barata); `DATA_DIR==="/tmp"` por igualdade literal —
alargar pra `startsWith("/tmp")` exigiria carve-out pro `npm test` (que roda
num mkdtemp dentro de /tmp), o que enfraquece a própria guarda; ETag/versão em
`/api/profiles/save` (last-write-wins entre 2 abas — feature, não bug);
magic bytes do comprovante (a própria auditoria concluiu que não é vetor
explorável, e recusar comprovante legítimo por engano é perder dinheiro real).

## v179 — Filtros e busca de vagas (lotes 1-4)

Ordem do dono (17/09/2026): **"os filtros não podem falhar, não podem ser mal
feitos, precisam estar funcionando e ter um sentido — o usuário tem que
desfrutar 100%"**. Auditoria completa do motor de filtros e da busca, medida
contra as planilhas empacotadas (jan2026 9.240 · jul2025 2.206 · h2a-jun2026
4.964 · jul2026 2.625), gerou 41 achados em 10 lotes. **Os lotes 1-4 estão
implementados; os lotes 5-10 (tela, filtros novos, cargo por família,
alimentação da planilha, acabamento/mobile e as decisões de produto) seguem
pendentes, aguardando o dono.** 38 checks novos no smoke (439 → 477).

**Lote 1 — a contagem voltou a ser a verdade da lista** (`mod-filtros.js`,
`server.js`, `app.js`, sw v45). Sete defeitos no motor ÚNICO em que o número
do chip não era o que a lista devolvia — e é o mesmo motor que monta a fila
do robô, então cada divergência virava e-mail pro empregador errado em escala:
(1) chip 217 × lista 108 porque `_csv` quebrava por vírgula QUALQUER valor,
inclusive o que o próprio servidor emitiu (79 títulos / 804 linhas só na
H-2A); (2) `parse(URL)` e `parse(objeto)` discordavam, então a fila INICIAL do
robô e o REFILL filtravam conjuntos diferentes; (3) a mesma cidade em 3 chips
(LaBelle 32 / Labelle 23 / LABELLE 11) e casamento por substring sem estado
(cidade=Ames trazia 24, só 12 eram Ames/IOWA); (4) salário mensal mal rotulado
na fonte virava $0,06/h (41 linhas sumiam de todo limiar e a tela imprimia "de
$0.06 a $75/h"); (5) toda listagem com busca varria a planilha 2× (70,6ms vs
1,4ms); (6) a contagem ao vivo renormalizava a cidade 114 mil vezes por
requisição (107ms de CPU bloqueante numa rota chamada a cada tecla); (7) o
índice não enxergava o enriquecimento até o servidor reiniciar. DEPOIS: faceta
= lista em 100% das amostras, Ames 24 → 12, Vass 61 → 58, limiar $12 4.364 →
4.395, contagem ao vivo 107ms → 39ms, busca na lista 71ms → 6ms.

**Lote 2 — categoria pelo TÍTULO** (`server.js` `detectCategory`,
`mod-planilhas.js`). 2.588 vagas de paisagismo viviam dentro de 🏗️ Construção
porque "Landscape Laborer" casava com a chave `laborer` e `landscape` não
existia na tabela — e `recategorizeAllSheets()` refazia o erro em TODO boot,
persistindo em /data. Medido: jan2026 landscape 1.279 → 3.877, construction
4.005 → 1.438, zero vaga com "landscap" no título dentro de Construção;
jul2025 construction 502 → 330. NÃO implementado de propósito: classificar
pelo código SOC — hoje SOC só existe na H-2A, que nunca passa por
`recategorizeAllSheets` (taxonomia agrícola própria), então seria código sem
efeito e sem teste.

**Lote 3 — busca que acha o que existe** (`server.js` `searchSheet`, `app.js`,
sw v46). q=welder devolvia 4.002 vagas com 13 contendo a palavra (carpenter
4.002/106, bartender 1.210/41, cook 1.215/589) porque a "categoria implícita"
era ANEXADA ao resultado — e esse conjunto virava `total`, faceta e fila do
robô. ACHAR e SUGERIR viraram coisas separadas; a categoria parecida viaja em
`sugestoes` e vira uma barra clicável na lista. Mais: atalho de identificador
(nº do caso 6.387 → 1), token parcial obrigado a ter LETRA e a casar no
COMEÇO de palavra ("cape cod" em jan2026 3.354 → 17, porque "cape" casava
dentro de "landSCAPE"), palheiro com DESCRIÇÃO/SOC/requisitos pré-calculado
por linha (forklift 1 → 416, housing 0 → 145, wheelbarrow 0 → 11) e mapa
`BUSCA_PT_EN` (~60 termos) porque o público é 100% brasileiro e o acervo 100%
em inglês.

**Lote 4 — rota honesta e gate fechado** (`server.js`, sem tocar em arquivo
servido ao cliente). (1) `grupo`/`status` 💎 saíam vaga a vaga pra qualquer um,
até sem cookie — o v177-FIX3 só fechou a faceta; (2) `row.exp===1` era tratado
como "vaga EXPIRADA" pelo robô, descartando 447 vagas em jan2026 e 149 em
jul2025 com motivo falso; (3) parâmetro inválido sumia calado (`inicio=13`
devolvia a planilha inteira; `top=abc` devolvia lista vazia com total 2.206;
`sort=shuffle` fazia a paginação duplicar 741 vagas e perder 741);
(4) `remainingTotal` não passava pelo corte da regra 8 que o `totalBase` da
outra rota já usava — dois denominadores pro mesmo "de N" da mesma tela.

### Regras que nasceram aqui (não podem ser quebradas)

- **VALOR DE FACETA É OPACO**: o servidor nunca re-parseia (por vírgula ou o
  que for) um valor que ele mesmo emitiu. Só estado/categoria/mês/grupo, cujos
  valores jamais contêm vírgula, aceitam o CSV legado (`state=FL,TX`).
- **CHAVE CANÔNICA DE CIDADE = `norm(cidade) + "|" + ESTADO`**. A faceta
  agrupa por ela, o filtro casa por IGUALDADE dela. Cidade é lugar, não
  pedaço de texto. Texto livre (digitado / região turística) continua no
  casamento amplo — é o único lugar onde ele faz sentido.
- **CONTAGEM POR OPÇÃO = VERDADE DA LISTA**: se um chip diz N, marcar esse
  chip devolve exatamente N. Vale pra lista, pra contagem e pro refill do
  robô, que usam o MESMO `FILTROS.filtrar`.
- **`exp` É MESES DE EXPERIÊNCIA EXIGIDA, NUNCA SINAL DE VAGA MORTA.** Vaga
  morta é status do DOL (WITHDRAWN/DENIED/EXPIRED/INVALIDATED) ou data de fim
  no passado.
- **CATEGORIA SAI DO TÍTULO**: tabela de cargos só contra o título, por
  palavra/frase inteira, específico antes de genérico; palavras-chave ainda no
  título; o nome da EMPRESA só desempata no fim. Proibido voltar a concatenar
  "empresa + título".
- **ACHAR ≠ SUGERIR**: o que não casa com a busca não entra em `total`, nem
  na faceta, nem na fila do robô — vira sugestão que o usuário aceita ou não.
- **Nada de trabalho pesado por linha dentro de laço quente** (lição do v162):
  normalização de cidade e palheiro da busca são pré-calculados e invalidados
  por versão da planilha; `_saveEnrichedSheet` é o funil único que avisa.
- **Parâmetro que o motor não entende é DECLARADO** (`_ignorados`), nunca
  descartado em silêncio — um filtro corrompido não pode virar "a planilha
  inteira" pro robô.

## v180 — Planilha importável e seed enriquecido

**Diagnóstico (18/09/2026).** `jul2026_compact.json` versionado no git é um
ESQUELETO: 2.625 case numbers com empresa, estado, grupo A-H e status fixo
"Pending Processing" — **0 e-mail, 0 título, 0 salário, 0 cidade, 0 descrição**
e a mesma data de início em todas as linhas (dado de fachada). O dado completo
daquela planilha só existe no DISCO DE PRODUÇÃO do site antigo, onde o robô de
enriquecimento passou meses batendo na API do DOL vaga a vaga. Duas
consequências viviam escondidas: (1) commitar um `jul2026_compact.json`
enriquecido não adiantava nada, porque o seed do boot pulava quando "já existe
dado real" em `/data`; (2) a planilha aparecia pro usuário como a **MAIS NOVA**
com "0 vagas disponíveis" — vendida como a melhor, sendo que dela não sai
nenhuma candidatura.

**Fluxo do dono.** Baixar o JSON da planilha pelo painel antigo (botão "Baixar
JSON" → `GET /api/admin/sheet/download/<chave>`) e então: **(a)** importar
direto aqui pelo painel (Planilhas & Robôs → "Importar planilha (JSON)" ou
"Importar JSON" no card da planilha) — o arquivo é lido NO NAVEGADOR, resumido
("N linhas · N com e-mail · N com título…") e confirmado antes de subir; ou
**(b)** mandar o arquivo pra virar o `jul2026_compact.json` bundled — o deploy
seguinte aplica sozinho.

**Regras novas (não reverter sem ordem do dono).**

- **Importar numa chave que já existe é SUBSTITUIÇÃO MESCLADA, nunca troca
  cega.** Régua, numa função só (`_mesclarPlanilha`, server.js): linha com
  e-mail vence linha sem; entre duas iguais nesse quesito vence a mais rica
  (campos preenchidos entre `t/w/ci/d/de/desc`); empate → a linha nova.
  Escolhida a base, a UNIÃO campo a campo (`mergePreferindo`, mod-vagas-
  integrity) só PREENCHE vazio — nunca zera: grupo A-H, `_sheet` e tudo que o
  arquivo novo não trouxe continuam vivos, e **case number que existia e não
  veio no arquivo continua no ar**. `k` só é recalculado (`detectCategory`)
  onde falta. Registro em `sheets_meta.json`: `importedAt/importedBy/
  importedRows/mergedFrom`.
- **Linha sem e-mail agora ENTRA** na planilha (antes o upload jogava fora) —
  é exatamente ela que o robô de enriquecimento existe pra completar. O que a
  rota exige é que o ARQUIVO tenha e-mail em alguma linha; sem nenhum, 400 na
  cara e a planilha no ar fica intocada.
- **Importar PARA o robô de enriquecimento** que estiver rodando naquela chave
  (mesma trava cooperativa do DELETE — senão ele segue escrevendo no array
  velho e o progresso vai pro lixo); o `autoEnrichCycle` agendado em 3s
  recomeça na planilha nova. Radar só avisa das vagas REALMENTE novas.
- **Built-in (jan2026/jul2025/H-2A) também é importável** e NÃO vai pra
  `SHEET_EXTRAS` (criaria uma planilha fantasma com a mesma chave, a H-2A
  aparecendo 2x): atualiza o array certo e salva pelo funil único
  `_saveEnrichedSheet`.
- **Seed bundled com e-mail vence esqueleto em /data** (`_seedVenceEsqueleto`,
  chamado por `seedJul2026FromBundle`): se o que está em `/data` não tem
  NENHUM e-mail e o arquivo bundled tem, o bundled é MESCLADO por cima (mesma
  `_mesclarPlanilha` — nunca duas réguas) e gravado em `/data`. Idempotente:
  no boot seguinte `/data` já tem e-mail e a checagem sai antes de abrir o
  arquivo. As built-ins já tinham o equivalente em `loadSheets` (a cópia
  bundled recupera `/data` corrompido/sem e-mail).
- **Selo "⭐ MAIS NOVA" só pra planilha COM e-mail.** `/api/sheets-list` marca
  `latest` pela `latestH2bKey({comEmail:true})`; a candidata sem contato vem
  com `emEnriquecimento:true` e o front mostra "⏳ em preparação — o governo
  ainda não publicou os e-mails de contato; o robô completa sozinho".
  **Nunca esconder a planilha** (o dono quer ver que ela existe) — só não
  vendê-la como pronta. O robô de frescor continua usando `latestH2bKey()` sem
  opção (pra ele a mais nova é a mais nova, com ou sem e-mail);
  `latestH2bBruta` na resposta deixa isso visível.

Testes: 12 checks novos no smoke (473 → 485), incluindo a mesclagem real por
rota (grupo preservado, linha pobre não apaga e-mail, vaga ausente do arquivo
preservada), a migração do seed pelo gancho `/api/test/seed-merge`
(esqueleto→mesclado, idempotência, bundled esqueleto não mexe em nada), o
caminho built-in e a presença do botão no painel.
