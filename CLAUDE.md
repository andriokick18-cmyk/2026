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
reconstrução): ranking/gamificação, chat com IA, a **ABA** Cérebro Contábil do
painel, aba de Notícias, seletor de idioma, códigos promocionais,
multi-servidor, menu/drawer hambúrguer. (Os robôs de coleta/alimentação de
planilha VOLTARAM por ordem do dono em 13/09/2026 — ver regra 📋 abaixo.)

⚠️ **RESSALVA QUE VALE DINHEIRO (v204 LOTE 22)** — este parágrafo já mandou
"parar e confirmar" sobre duas peças que EXISTEM e são usadas:
- **O Gemini existe**, só que com um papel único: LER O COMPROVANTE DE PIX
  (`preCheckComprovante`, v177 — `GEMINI_API_KEY`/`GEMINI_MODEL`). É a IA que
  decide se a ativação provisória acontece. Sem a chave, o comprovante fica
  honestamente pendente de conferência manual e nada quebra. Apagar isso
  desliga exatamente a feature que o dono mandou implementar.
- **O motor contábil existe no servidor** (`computeSocios`, `computeDreMensal`,
  `_fecharMes`, `relatorioExecutivoDre`, `/api/admin/dre`, `/api/admin/socios`,
  fechamento mensal), com testes no smoke — o que NÃO existe é a ABA dele no
  `admin.html`. Ter rota sem tela é decisão pendente do dono (construir a tela
  × remover as rotas), não código morto pra apagar por conta própria.
Regra geral: antes de remover qualquer coisa desta lista, confira no CÓDIGO se
é "não existe" ou "existe sem tela" — são coisas diferentes.

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
   fica em branco ou desatualizada. **O comando é
   `npm run sw-bump -- "o que mudou pro usuário"`** (v199 LOTE 19): ele sobe o
   `CACHE_NAME` E regrava o `CACHE_FRONT_FINGERPRINT` (hash de index.html +
   admin.html + app.js + h2b-extras-user.js) na mesma operação. Nunca edite
   esses dois valores à mão. O smoke recalcula o hash e FALHA se o front
   mudou sem o bump — antes as 2 guardas só conferiam "a versão é ≥ v43",
   condição sempre verdadeira, que nunca pegaria a próxima mudança.
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

## v181 — Filtros: tela, dimensões novas e cargo por família (lotes 5-7)

Continuação direta do v179 (a auditoria de 41 achados em 10 lotes). O dono
autorizou por escrito tudo que a auditoria apontou ("corrija tudo isso que
você disse que tá errado, deixe como explicado") e decidiu os 3 itens que
dependiam dele: **"Recentes" vira ordenação real**, **esconder por padrão a
vaga com temporada encerrada** e **dimensão com 1 valor só não é oferecida**.
Lotes 5, 6 e 7 implementados (8-10 seguem pendentes). 34 checks novos no
smoke (486 → 520). sw v48 → v51.

**Lote 5 — a tela conta a mesma história que o servidor** (`app.js`,
`server.js`, sw v48). O sintoma que o dono viu: o painel anunciava "TEXAS
821" enquanto a lista, com a MESMA busca, tinha 21 — `vfParams` só mandava
`q` no contexto "auto", então o rodapé "Ver N vagas", a contagem de CADA
opção e os chips ignoravam o que a pessoa digitou. A busca virou o filtro
`q` do motor (`VF.st.manual.q`; barra `#q` e painel são o mesmo estado) e vai
nos dois contextos — painel e lista devolvem o MESMO total em 6 combinações
medidas. Mais: `sTrueTotal` passou a ser atribuído ANTES do ramo vazio (a
tela imprimia "0 vagas" numa planilha de 2.625) e a lista vazia explica a
CAUSA — planilha em preparação (com botão pra recomendada) ou os filtros
ativos com "tirando {filtro}, aparecem N vagas" (número EXATO tirado da
faceta que o painel já buscou, nunca estimado); o badge "🔍 N filtros" passou
a espelhar o `ativos()` do motor (conta e-mail e busca, não conta tipo/ativa
fora da aba ao vivo) e o "só com e-mail" DESLIGADO virou chip visível;
"🗓️ Começa logo" ordena em 3 faixas (vai começar → já começou → sem data) e
"Recentes" deixou de ser `list.reverse()`; os dois botões somem quando a
planilha não tem data (11.446 vagas); status do DOL com rótulo PT (o VALOR
enviado continua o literal); painel com erro clicável e timeout de 8s em vez
de spinner eterno.

**Lote 6 — filtros novos que os dados sustentam** (`mod-filtros.js`,
`server.js`, `app.js`, sw v49): `exp` (meses de experiência — 5.923 vagas de
jan2026 e 1.037 de jul2025 exigem ZERO), `temporada` (derivada de `d`/`de`,
sem campo novo) e `visa` (campo `visa` com fallback pelo prefixo do case).

**Lote 7 — cargo por FAMÍLIA** (`mod-filtros.js`, `app.js`, sw v50): o
título vem cru do DOL e a mesma ocupação se partia em vários chips
("landscape laborer" 2.120 + "landscape laborers" 231 + "laborer, landscape"
9). jan2026 1.806 → 1.492 famílias (top-40: 55,8% → 61,5%), jul2025 751 →
666, H-2A 723 → 38 (top-40 100%).

### Regras novas (não quebrar)

- **A BUSCA É UM FILTRO COMO OUTRO QUALQUER**: mora em `VF.st.manual.q`,
  viaja em `vfParams` nos 2 contextos e conta no badge. Proibido voltar a ter
  uma busca que a contagem não enxerga.
- **`exp` = MESES DE EXPERIÊNCIA, opções por TETO** (0 · ≤3 · ≤6 · ≤12). OU
  dentro da dimensão é o MAIOR teto marcado. Linha sem o dado publicado nunca
  entra num filtro de experiência.
- **TEMPORADA ENCERRADA FICA ESCONDIDA POR PADRÃO** (`ocultarEncerradas`,
  decisão do dono): só esconde o que TEM data de fim no passado — planilha
  sem data fica intocada. Não conta no `ativos()` (é padrão do app, não
  escolha do usuário) e é declarada por um chip permanente com o número REAL
  vindo da faceta ("⏳ Escondendo N vagas com temporada encerrada —
  mostrar"). Proibido esconder vaga sem declarar quantas e sem o clique que
  mostra tudo. Seleção explícita de temporada vence o padrão.
- **VAGA MORTA TEM UMA RÉGUA SÓ**: `_motivoVagaMorta(row)` (server.js) —
  status do DOL + data de fim no passado — serve o envio (`isQueueJobDead`)
  E o refill (`tryAutoRefill`). Proibido a 2ª régua que devolvia pra fila a
  vaga que o envio acabara de pular.
- **DIMENSÃO COM MENOS DE 2 VALORES DISTINTOS NÃO É OFERECIDA**:
  `disponibilidade` expõe `<dim>Distintos` pra TODA dimensão de opções e a
  regra é única no front — com uma linha honesta ("todas as vagas desta
  planilha têm o mesmo valor aqui: X"), nunca sumindo calada. Pra dimensão de
  plano pago vale também "não abrir vazia": sem opção de verdade (com os
  outros filtros aplicados), a seção não aparece.
- **MÊS DE INÍCIO TEM ANO**: o índice guarda AAAAMM (`ix.am`) e a faceta
  devolve `{v:"2026-03", ano, mes, n, passado}`; o rótulo humano ("Mar/26") é
  montado na TELA pelo dicionário, nunca no servidor. O formato antigo (1–12)
  continua casando com aquele mês de qualquer ano — `job.filters` de robô
  rodando não pode quebrar.
- **CARGO CASA POR FAMÍLIA**: a chave é o SOC quando existe, senão o título
  normalizado (sem acento, SEM PONTUAÇÃO — nunca vírgula, senão volta o bug
  do `_csv` do v179 —, sem "and/&", plural simples removido, palavras
  ordenadas), e `_famKey` é idempotente. Todo valor antigo (título literal,
  outra grafia, caixa diferente) continua casando pelo mapa título→família do
  índice: quebrar isso quebra o refill de todo robô que já está rodando. O
  rótulo mostrado é a grafia mais frequente da planilha, nunca a chave crua.
- **UMA RÉGUA DE VISTO**: `FILTROS.visaDaLinha` (campo `visa` → prefixo do
  case). A rota `/api/sheet-meta` tinha a sua própria e marcava H-2B a linha
  sem o campo.

## v182 — Alimentação da planilha, acabamento e e-mail protegido (lotes 8-10)

Fecha a auditoria de 41 achados do v179 (lotes 1-4) / v181 (lotes 5-7). Ordem
do dono: **"os filtros não podem falhar… o usuário tem que desfrutar 100%"**,
**"cada vaga tem que ter a descrição e praticamente toda informação"** e a
autorização total ("corrija tudo isso que você disse que tá errado, deixe como
explicado"). 33 checks novos no smoke (520 → 553) + revisão real no Chromium
(1280px e 390×844, zero erro de console). sw v51 → v54.

**Lote 8 — terminar de alimentar a planilha** (`mod-planilhas.js`, `server.js`,
`mod-filtros.js`, `admin.html`, sw v52). O robô dava jan2026 e jul2025 (11.446
vagas, a maior parte do acervo) por "100% completas" só porque toda linha tem
E-MAIL — e era por isso que 0% delas tinha cidade, datas ou descrição: saíam da
fila no primeiro `if` e o ponto de retomada do bot também era "a primeira linha
sem e-mail". Além disso: o frescor nunca reconferia essas duas; a unidade do
salário só sabia "Month" (tudo o mais virava HORA, e $800/semana lia $4,62/h);
`exp` era sobrescrito com 0/1, destruindo o filtro de experiência linha a
linha; e a sujeira de cidade da fonte virava chip clicável. Medido depois:
jan2026 0/9.240 completas com as 9.240 pendentes declaradas no painel; 354
cidades limpas na H-2A (39 chaves-lixo fora da faceta); jul2026 na frente da
fila. **O ritmo com o DOL não mudou** (1 vaga por vez, mesmos backoffs) — pode
levar semanas em produção, e o dono autorizou.

**Lote 9 — deleite, mobile e acessibilidade** (`app.js`, `index.html`,
`server.js`, sw v53). Seis dimensões sumiam CALADAS quando a planilha não tem o
dado (cidade, mês de início, cargo, vagas, experiência, temporada) — agora
explicam em âmbar, como salário e e-mail já faziam. A busca ganhou × pra
limpar; o botão 🔍 Filtros tinha `min-height:36px` INLINE (vencia a regra
mobile de 44px e era o MENOR alvo da fileira); opções 40 → 44; o × do chip 24
→ 44. Painel com aria-modal, foco que entra e volta, Escape e aria-pressed.
Ponte "usar os mesmos filtros da minha busca" no Passo 2 do robô. O 📡 Radar
salvava 4 das 11 dimensões e tinha régua própria de texto — agora guarda o
snapshot inteiro e é avaliado pelo MESMO `FILTROS.filtrar`.

**Lote 10 — e-mail do empregador protegido** (`server.js`, `app.js`, sw v54).
Aprovado pelo dono. Provado com curl sem cookie: `/api/sheet-meta?sheet=jan2026
&top=2000` devolvia 2.000 e-mails em texto puro.

### Regras novas (não quebrar)

- **"COMPLETA" É UMA LISTA SÓ**: `CAMPOS_ESSENCIAIS` (e-mail, cidade, data de
  início, data de fim, descrição) em mod-planilhas.js. Fila, ponto de retomada,
  laço do robô e painel leem dela. Exigir mais um campo é mexer NA LISTA, nunca
  num `if` espalhado. Fila por impacto: sem e-mail primeiro (candidatura
  impossível), depois mais pendentes.
- **O FRESCOR COBRE TODA PLANILHA PUBLICADA**, em rodízio pela reconferida há
  mais tempo (carimbo `freshAt` por planilha — nome único, já existia), com o
  MESMO teto de 120 linhas por ciclo. Rascunho fica de fora.
- **A UNIDADE DO SALÁRIO É A QUE O DOL PUBLICOU** (Hour/Week/Bi-Weekly/Month/
  Year/Piece Rate). Pagamento por PEÇA é salário DESCONHECIDO em `wageHora`
  (0, contado em `semSalario`) — inventar $/h de produção é mentir pro
  candidato.
- **`exp` É MESES E NUNCA É SOBRESCRITO PELO SIM/NÃO**: o número publicado
  manda; o Sim/Não vai pra `expReq`. Sem o número, o filtro tem 2 degraus
  honestos em vez de 4 — nunca um dado falso. Os nomes de campo de meses são
  lidos de forma defensiva (o sandbox não alcança a API do DOL pra confirmar
  qual deles o datahub usa).
- **CIDADE TEM UMA RÉGUA SÓ DE LIMPEZA**: `limparCidade` (server.js, ao lado do
  mapa único de estados, agora com VI/GU/AS/MP) serve o robô E a carga das
  planilhas, é idempotente e roda como auto-cura no boot. Title Case só em
  valor todo em CAIXA ALTA (nunca destrói "LaBelle"/"McBee"). A chave canônica
  do v179 (`norm(cidade)+"|"+ESTADO`) não muda.
- **SEMEAR A jul2026 À FORÇA É MESCLAR, NUNCA SUBSTITUIR** (mesma
  `_mesclarPlanilha` do upload): com /data enriquecido, trocar pelo bundled
  apagaria meses de e-mail/cidade/descrição.
- **DIMENSÃO SEM DADO AVISA, NÃO SOME**: toda dimensão de filtro sem dado
  publicado mostra o aviso âmbar. `_soUmValor` cuida só de "1 valor distinto";
  ZERO valor distinto é falta de dado e tem aviso próprio.
- **ALVO DE TOQUE ≥44px NO QUE DESFAZ FILTRO**: botão de filtros, opções do
  painel, × do chip e × da busca. Painel com aria-modal, foco de entrada e
  saída, Escape e aria-pressed em cada opção.
- **O RADAR USA O MOTOR ÚNICO**: guarda o snapshot COMPLETO dos filtros
  (`radar.filtros`, mesma função de snapshot do robô, sem forçar e-mail) e é
  avaliado por `FILTROS.filtrar` — proibida uma 3ª régua de texto. Corpo legado
  ({estados,cidade,q,categoria}) continua aceito.
- **O E-MAIL DO EMPREGADOR SÓ VIAJA INTEIRO PRA PLANO ATIVO OU ADMIN**
  (`mascararEmail` + `podeVerEmailVaga`, função única, em TODA rota que devolve
  vaga). Sem plano vai mascarado com **`hasEmail` preservado** — contagem,
  facetas, "só com e-mail" e o corte da regra 8 não podem depender do texto do
  endereço. A máscara é feita numa CÓPIA (o cache de vagas é compartilhado).
  A fila do robô é montada com a LINHA REAL do servidor (o `caseMeta` da tela é
  só fallback) e endereço com "•" nunca entra nela nem no /api/send.
- **`DOL_API_BASE`/`DOL_FEED_BASE` são só de teste**: o padrão é o host real do
  DOL. É o que torna o enriquecimento e o frescor exercitáveis no `npm test`
  com o feed falso; em produção nada muda (mesmo caminho, headers e ritmo).

## v183–v186 — Varredura total, lotes 1-4

Ordem do dono (18/09/2026): **"O que ainda pode melhorar? O que não faz
sentido existir? Ou funciona errado? Pensa sobre tudo e resolva!"** +
autorização total ("corrija tudo isso que você disse que tá errado"). Uma
auditoria de leitura completa gerou 22 lotes; estes são os 4 primeiros —
identidade do admin, motor de envio, jornada do pedido e páginas públicas.
22 checks novos (553 → 575), suíte 100% verde. sw v54 → v55 (só o lote 3
toca arquivo servido ao cliente).

**v183 — Lote 1: quem aprovou e de quem é o dinheiro** (`server.js`,
`mod-admin-health.js`, `mod-sentinel.js`). Desde o v177-FIX a sessão do
painel admin pode ter como CHAVE INTERNA o USERNAME reservado
("andrio"/"diego") em vez do e-mail — decisão deliberada pra nunca existirem
2 contas pro mesmo admin. Só que a cadeia inteira de ATRIBUIÇÃO entende
E-MAIL: `editorFromEmail("diego")` caía no default `"andrew"` (TODA aprovação
do Diego era gravada como "Andrew"), `isAdminEmail("diego")` é false — então
`_finDonoDe` devolvia "sem dono" e **cada entrada aprovada pelo painel ia pra
fila de "entradas sem dono" do Acerto entre Sócios** — e as 26 guardas de
"admin hardcoded" (banir/desbanir, deletar conta, sentinela, restart de robôs)
davam 403 na cara do painel. Junto, o alarme falso: o sentinela media a saúde
das notificações pelo Gmail pessoal do `ADMIN_EMAIL` — canal que deixou de ser
o principal no v175 e cuja conta nem existe mais sob esse e-mail desde o v172c
—, gritando 🚨 a cada 6h e pintando de vermelho a linha de "Últimas ações dos
robôs", justo onde um alarme de verdade apareceria.

**v184 — Lote 2: motor de envio** (`server.js`). (1) Job ativo com `queue:[]`
é estado NORMAL (mandou a última vaga e espera o refill de ~7min), mas
`reactivateOneAutoJob` exigia fila não-vazia — e o laço de órfãos do watchdog
e o filtro do `diagnoseJob` tinham a MESMA condição: o robô de um cliente
pagante nessa janela não voltava NUNCA depois de um restart, e nenhum dos 3
vigias o pegava (este repo faz deploy a cada commit). (2) O motor dizia "salva
ANTES de tentar envio (evita reprocessamento em crash)" e o que ia pro disco
na hora era NADA — `setAutoJob` é debounced de propósito e `markSent` também
era: um kill duro devolvia a vaga JÁ ENVIADA pra fila e o robô mandava a MESMA
candidatura pro MESMO empregador. (3) Os 2 primeiros passos do plano já
estavam feitos (v179 tirou `row.exp===1` de `_motivoVagaMorta`; o v182 mandou
o Sim/Não pra `expReq`) — só ganharam guarda estrutural.

**v185 — Lote 3: a jornada do pedido** (`app.js`, `index.html`, `server.js`,
sw v55). A ativação provisória (intencional desde 21/07) estava ANULADA pelo
front: só o `checkStatus()` do boot montava o `U` inteiro, então quem comprava
clicava em "Ir para Envio Automático" e batia no cadeado "Plano necessário" —
só um F5 resolvia. Pedido CANCELADO pelo robô (v178) sumia da Home sem uma
palavra. "Próximo passo" e o card-herói mandavam quem é FREE "buscar vagas" e
"ativar o automático" — free tem 0 envios desde o v172. E o passo 2 da compra
pedia de novo nome/WhatsApp/cidade/estado que o cadastro v175 já obriga.

**v186 — Lote 4: páginas públicas** (`guia.html`, `quanto-ganha-h2b.html`,
`h2bapply-funciona.html`, `server.js`). 5 links de conversão de /guia
(prioridade 0.9 no sitemap) e /quanto-ganha-h2b (0.8) apontavam pra
`/oauth/google`, rota que não existe desde o v172c: **quem chegava do Google e
clicava no botão principal caía em 404**. A guarda do v172j existia desde
12/09 — mas a lista `_seoFiles` nunca incluiu esses 2 arquivos. A
/h2bapply-funciona se contradizia dentro de si mesma e prometia resposta de
empregador "traduzida no painel" (o app é só-envio e nunca lê inbox), carta
"gerada" (nada é escrito pelo app) e um JSON-LD de FAQ divergente do texto
visível. /excluir-conta mandava pra uma tela ("Configurações → Excluir minha
conta") que NUNCA existiu.

### Regras novas (não quebrar)

- **A SESSÃO TEM UM E-MAIL SÓ, E ELE É O REAL**: `_sessAdminEmail(s)`
  (`admin_email` da sessão, com fallback pro `user_email`) é a fonte ÚNICA de
  "qual e-mail representa esta sessão", e `_sessAdminNome(s)` é a única régua
  de "Andrio/Diego/e-mail" pra trilha. PROIBIDO voltar a passar `s.user_email`
  cru pra `isAdminEmail`, `editorFromEmail` ou pra qualquer campo de
  atribuição (`ativadoPorEmail`, `lancadoPorEmail`, `porEmail`, `dadoPor`) —
  a chave interna da conta pode ser um username. Guarda estrutural no smoke.
  Em guarda de rota, trocar `isAdminEmail` por `isAdminVip` **não** é
  equivalente: `isAdminVip` aceita qualquer conta com a flag `isAdmin`.
- **O VIGIA MEDE O CANAL QUE EXISTE**: a saúde do e-mail do sistema é
  `NOTIF.conectada()` (mod-notif, v175) — é ela que deixa o botLog do
  sentinela vermelho. O Gmail pessoal do admin continua medido, mas como
  RESERVA (é o que o `pendingOrderAlert` usa) e em nível informativo. Alarme
  que grita todo dia sem nada estar quebrado treina o dono a ignorar o log.
- **FILA VAZIA NÃO É ROBÔ MORTO**: `active:true` + `queue:[]` + `nextSendAt`
  futuro é o estado normal de quem espera o refill. Nem
  `reactivateOneAutoJob`, nem o laço de órfãos, nem o `diagnoseJob` podem
  exigir fila não-vazia. E o reagendamento respeita o `nextSendAt` original —
  chamar `scheduleAuto` na hora dispararia o refill e furaria o intervalo
  humanizado de ~7min contra o Gmail.
- **"JÁ ENVIEI PRA ESSE EMPREGADOR" GRAVA SÍNCRONO**: `markSent` chama
  `persistSent()` (SENT_FILE é só conjunto de e-mail, e os únicos chamadores
  em produção são os 2 pontos de envio bem-sucedido — no máximo 1 gravação por
  candidatura que saiu). `setAutoJob` **continua debounced** de propósito
  (DB_AUTO carrega a fila inteira de todo mundo e é escrito várias vezes por
  envio): a fila pode voltar atrasada num crash, mas `hasSent`/regra 8 corta a
  vaga. PROIBIDO inverter os dois.
- **O `/api/status` É A VERDADE DA TELA, E ELA SE REAPLICA**: `applyStatus(d)`
  (app.js) é a fonte única do que o servidor diz sobre a conta, usada pelo
  `checkStatus` do boot E pelo `syncData`. Ela nunca mexe em tela (nada de
  `showApp`/`sv`) — senão chamá-la no meio do checkout jogaria a pessoa pra
  Home. Depois de enviar um pedido, o front confere 3 vezes (5s/15s/40s) e
  PARA: nada de `setInterval` permanente (Render Free). E o "⚡ liberado na
  hora" só aparece **depois** que o servidor virou a chave — prometer o
  provisório de antemão é mentira quando não há `GEMINI_API_KEY`.
- **GATE DE ENVIO NA TELA = `U.needsPlan`**, o MESMO campo que o `/api/send` e
  o `/api/auto/start` usam. PROIBIDO decidir por `U.plan==='free'`:
  `getPlan()` devolve "vipro" pra quem só tem o automático (armadilha do
  v177-FIX8).
- **A HOME CONTA O QUE ACONTECEU COM O PEDIDO**: o card escolhe o pedido MAIS
  RECENTE por `createdAt` entre pendente e cancelado (nunca um `.find()` que
  depende da ordem da lista), mostra o `motivoCancelamento` por 7 dias, com ×
  pra dispensar, e o cache envelhece em 5min (além de ser invalidado quando o
  `/api/status` muda plano/gate). Aviso ao usuário é sempre tela — `pushToUser`
  é no-op nesta reconstrução, então nenhum texto pode prometer notificação.
- **O CHECKOUT NÃO PEDE O QUE O CADASTRO JÁ TEM**: com nome, WhatsApp, cidade
  e estado na conta, o passo 2 é CONFIRMAÇÃO em leitura com link pra corrigir
  no Perfil; faltando cidade ou estado, cai no formulário editável
  pré-preenchido — conta legada nunca pode travar a compra.
- **A LISTA `_seoFiles` DO SMOKE COBRE TODA PÁGINA PÚBLICA**: hoje
  h2bapply-funciona, h2b-e-golpe, como-usar, tutorial-conteudo, guia,
  quanto-ganha-h2b e os templates do server.js. Página pública nova entra
  nessa lista NO MESMO COMMIT — foi a ausência dela que deixou 5 CTAs em 404
  por meses.
- **FAQ ESTRUTURADA = TEXTO VISÍVEL**: cada `acceptedAnswer` do JSON-LD tem
  que aparecer IGUAL no HTML da mesma página (guarda que não envelhece a cada
  reescrita de copy). O Google penaliza FAQPage que não bate com a página.
- **NENHUMA PÁGINA PÚBLICA VENDE LOGIN PELO GOOGLE**: o cadastro é usuário e
  senha desde o v172c; o Google só aparece DEPOIS do plano ativo, pra conectar
  o Gmail de ENVIO (permissão só de enviar, endereço PERMANENTE). Guarda por
  frase no smoke, cobrindo as 4 páginas + server.js.

## v187–v190 — Varredura total, lotes 5-8

Continuação direta do v183–v186 (mesma ordem do dono, 18/09/2026: **"O que
ainda pode melhorar? O que não faz sentido existir? Ou funciona errado? Pensa
sobre tudo e resolva!"** + autorização total). Estes 4 lotes são plano de
plano, limites e mensagem de quem pagou · painel admin (task #111) · promessas
de notificação · velocidade do servidor. 21 checks novos (575 → 596), 3
asserções antigas atualizadas porque codificavam comportamento errado. sw v55
→ v58 (o lote 8 é 100% server-side).

**v187 — Lote 5: quem acabou de pagar** (`server.js`, `app.js`, sw v56). Dois
furos que só atingiam cliente PAGANTE. (1) A ativação provisória gravava o vip
SEM `vip.limits`, então `getManualLimit`/`getAutoLimit` caíam na tabela LEGADA
(`PLAN_LIMITS`): VIPro provisório dava 200+200/dia em vez dos 100+100 vendidos
— e quando o admin confirmava o pedido (que carimba `limitesDoPlanoNovo`) o
limite CAÍA PELA METADE, parecendo punição por pagar. As concessões manuais
(`vip/activate`, `vip/set-expiry`) tinham a mesma lacuna. (2) Se a conferência
humana passasse dos 3 dias do provisório, TODOS os gates diziam "Seu plano
venceu em DD/MM — assine um plano" pra quem já tinha pago e cujo pedido estava
na mesa: o site induzia um SEGUNDO pagamento.

**v188 — Lote 6: painel admin** (`admin.html`, `server.js`, sw v57). As duas
tarefas nominais do backlog do dono (task #111) e o maior buraco de receita da
auditoria tinham a MESMA raiz: o servidor já sabia a resposta e a tela não
perguntava. (A) `/api/pedidos` sempre filtrou por status e sempre devolveu o
pedido inteiro — o painel pedia só "pendente" e descartava o resto; agora tem
histórico com filtro, busca, trilha de quem aprovou/cancelou e por quê,
Detalhes (usando o retrato de VIP que `GET /api/pedido/:id` já devolvia) e
confirm de aprovação que diz QUEM, QUAL PLANO e QUANTO. (B) As 4 rotas de VIP
estavam prontas, auditadas e reversíveis — sem nenhum botão. (C) O sentinela
detectava pagante com robô morto a cada 6h e avisava por `sendNotifEmail` e
`pushToUser`, os dois no-op: o achado não chegava a ninguém.

**v189 — Lote 7: o site parou de prometer notificação** (`app.js`,
`index.html`, `tutorial-conteudo.html`, `server.js`, `mod-planilhas.js`, sw
v58). Não existe canal: `pushToUser` é função vazia, `PUSH_ENABLED=false`, sem
VAPID e sem rota `/api/push/*`; o único `new Notification` era o de TESTE, na
hora em que a permissão era concedida. Mesmo assim o app pedia a permissão
sozinho no 1º login, prometia "avisamos NA HORA" na tela logo depois do Pix,
repetia ao ligar o robô, vendia o Radar como "aviso no celular" com um
contador "🔔 N avisos já enviados" que subia sem nada sair, e ensinava tudo
isso no tutorial. Removido o plumbing morto inteiro; o Radar virou o que
sempre foi de verdade (filtro salvo com contagem REAL de vagas novas).

**v190 — Lote 8: velocidade** (`server.js`, `storage.js`, sem tocar em arquivo
servido ao cliente). `addLog` gravava o `auto_logs.json` INTEIRO (de todos os
usuários) de forma síncrona a cada candidatura; `storagePersist` serializava
cada banco DUAS vezes por gravação (a 2ª indentada: ~2,2x o tempo, +37% de
bytes, num servidor que já deu ENOSPC); `/api/public-stats` varria todos os
usuários e todo o histórico, sem cache, chamada a cada 30s por CADA aba
aberta.

### Regras novas (não quebrar)

- **TODA ATIVAÇÃO CARIMBA O CONTRATO, E CARIMBO NÃO ATROPELA LEGADO**:
  `limitsParaAtivacaoAdmin(target,planName)` é a régua ÚNICA das concessões
  manuais (vip/activate e vip/set-expiry) — recarimba quando o tier muda
  dentro do contrato novo, NUNCA carimba por cima de contrato LEGADO ainda
  ativo ("nenhum pagante perde nada") e carimba a tabela de hoje em toda
  ativação nova. A ativação provisória e a aprovação de pedido carimbam
  direto (ali o plano vendido é sempre o da tabela nova). Mudar limite de
  plano continua sendo mexer na TABELA (`PLAN_LIMITS_NEW`), nunca num `if`.
- **QUEM PAGOU NUNCA É MANDADO PAGAR DE NOVO**: com a janela provisória
  vencida e o pedido ainda `pendente`, `planGateMsg` (servidor) e
  `_planGateSubTxt` (tela — fonte única dos 2 gates e do toast do robô
  pausado) dizem que o pedido está com a equipe. O BLOQUEIO não muda (402,
  "ZERO envio grátis" intacto) e o plano que venceu DE VERDADE continua
  citando a data exata (v172h). `/api/status` expõe `provisorioPendente`.
- **REVOGAR PLANO NÃO APAGA A HISTÓRIA**: `/api/admin/vip/revoke` é a ÚNICA
  rota de revogação (a duplicata `/api/admin/revoke-vip` foi removida: sem
  chamador, sem `logAdminAction`, sem `delAutoJob`, e criava registro pra
  e-mail inexistente). Ela zera os dois relógios e para o robô, mas PRESERVA
  `vip.creditos` — é o extrato que a régua do ⚠️ e a auditoria financeira
  leem. Toda rota de VIP atribui pelo `_sessAdminEmail(s)` (v183 LOTE 1).
- **O PAINEL MOSTRA SE O CLIENTE CONSEGUE ENVIAR**: `/api/admin/contabilidade`
  leva, por usuário, `gmailConectado` (BOOLEANO — token nunca viaja) e o
  estado cru do robô; o card "Robôs parados de quem paga" lê o relatório do
  `mod-sentinel` (régua ÚNICA de "robô quebrado" — proibida uma 2ª no
  navegador) e roda a varredura sob demanda. "Dias de cortesia" é coluna
  ADITIVA ao lado de "dias pagos": a régua do ⚠️ (só `tipo:"pago"`) não muda.
- **NENHUMA TELA PROMETE AVISO ENQUANTO NÃO EXISTIR CANAL**: com
  `PUSH_ENABLED=false`, é PROIBIDO em qualquer arquivo servido ao cliente
  qualquer promessa de notificação/push/"aviso no celular", e proibido pedir
  a permissão do navegador (pedir uma permissão que nunca vai ser usada
  queima o pedido pro dia em que houver push de verdade). Guarda permanente
  no smoke, que desconta comentários — ela mede o que EXECUTA, não o texto
  que explica a remoção (mesmo cuidado vale pra qualquer guarda por frase).
- **O RADAR É UM FILTRO SALVO**: `registrarVagasNovasNoRadar` (antiga
  `notificarRadares`) CONTA as vagas novas que combinam (`radar.novas` +
  `ultimaEm`, pela mesma `FILTROS.filtrar`) e o usuário vê quando abre o
  site. Proibido reintroduzir contador de "avisos enviados" — o antigo
  `totalAvisos` subia sem que nada jamais tivesse saído.
- **VIA QUENTE NÃO GRAVA BANCO INTEIRO DE FORMA SÍNCRONA — E NEM CONFIA EM
  DEBOUNCE PURO**: `addLog` usa `persistLogsThrottled` (`persistThrottled`:
  agrupa como o debounce, mas o teto de 30s garante uma gravação real mesmo
  com tráfego contínuo — debounce puro faz `clearTimeout` a cada chamada e
  pode nunca disparar, e aí um OOM leva todo o log desde o boot).
  `persistLogsImmediate` continua SÓ nas compactações de boot. `markSent`
  continua síncrono e `setAutoJob` continua debounced (v184).
- **UM BANCO SE SERIALIZA UMA VEZ POR GRAVAÇÃO**: dentro de `storagePersist`
  é proibido um 2º `JSON.stringify` do mesmo dado (o espelho JSON reusa o
  `payload`). O payload continua sendo calculado no topo da função de
  propósito: pro `users.json` o `persist()` do server.js já trocou `data`
  pela cópia CIFRADA antes de chamar o storage.
- **ROTA PÚBLICA QUE VARRE O BANCO INTEIRO TEM CACHE**: `/api/public-stats`
  (sem cookie, sem rate-limit, chamada a cada 30s por aba aberta) responde de
  um cache de 60s. Vale pra qualquer rota de vitrine nova: número de vitrine
  pode ter 1 minuto de atraso; dinheiro e limite de envio, NUNCA.

## v191–v194 — Varredura total, lotes 9-12

Continuação direta do v183–v186 e do v187–v190 (mesma ordem do dono,
18/09/2026: **"O que ainda pode melhorar? O que não faz sentido existir? Ou
funciona errado? Pensa sobre tudo e resolva!"** + autorização total). Estes 4
lotes são recuperação de desastre · comprovantes fora da RAM · a rota do
dinheiro com régua por item · duas rotas que contrariavam regra escrita do
dono. 23 checks novos (596 → 619) e 6 asserções antigas atualizadas porque
codificavam o comportamento errado. **Nenhum arquivo servido ao cliente mudou
— sw.js segue em v58** (os 4 lotes são 100% servidor, testes e documentação).

**v191 — Lote 9: restaurar backup parou de se desfazer sozinho**
(`server.js`, `mod-admin-v2.js`, `storage.js`, `RESTAURACAO_BACKUP.md`). O
roteiro de emergência era "ensaiado" só até a metade: ninguém nunca tinha
restaurado com o SERVIDOR VIVO e reiniciado depois — e era aí que ele se
desfazia. A rota devolvia os `.json` e apagava o `.db`, mas o processo seguia
com TUDO em memória no estado PRÉ-restore: em segundos um `setUser` debounced
regravava `users.json`, e o "reinicie o servidor" mandava SIGTERM, cujo
`flushAll` grava a memória inteira por cima. Pedidos e financeiro (fora do
flushAll) voltavam; usuários, histórico e robôs não — restauração MISTA e
silenciosa, no procedimento que se executa em pânico. Junto: `flushAll`
cancelava todo debounce pendente e regravava só uma LISTA FIXA (journey.json
se perdia em todo deploy) e podia serializar `users.json`/`history.json` duas
vezes no mesmo sinal; backup 2min após TODO boot com retenção de 3 e deploy a
cada commit (3 commits numa tarde = zero backup de ontem); a cópia da pasta
`cvs/` era `fs.cpSync` — event loop travado pra todo mundo justamente quando
todos reconectam pós-deploy; e o `backup.json` de 10 em 10min reserializava
todos os usuários gravando `refresh_token` e hash de senha em TEXTO PURO (por
fora do `DATA_ENC_KEY`) num arquivo que ninguém jamais leu.

**v192 — Lote 10: comprovante de pedido saiu da RAM** (`server.js`,
`mod-admin-v2.js`, `RESTAURACAO_BACKUP.md`). Cada pedido segurava o
comprovante inteiro em base64 (até ~8MB) dentro de `DB_PEDIDOS`, carregado no
boot e mantido pra sempre — inclusive de pedido aprovado/cancelado meses
atrás — e QUALQUER mudança de status chamava `persistPedidos()`, que
serializa TODOS eles: o servidor engasgava a cada clique do admin e a RAM só
subia num processo que já deu OOM de 2GB. O próprio raio-X de memória (v163)
apontava isto como "candidato nº1 a migrar pra disco com leitura sob
demanda". Mesmo movimento do v21 com os PDFs de currículo.

**v193 — Lote 11: /api/pedido blindado** (`server.js`). `pagoEm` vinha CRU do
cliente e só virava data na APROVAÇÃO, depois de creditar os dias:
`new Date("xyz").toISOString()` estoura RangeError → 500, `persistPedidos`
nunca roda, dias concedidos, ZERO caixa, e a 2ª tentativa bate no 409 "já foi
ativado" — o "pedido ativo sem caixa" que a contabilidade existe pra evitar
(com data válida mas absurda, o cliente escolhia o mês do DRE). Junto: campos
livres sem tipo nem teto (megabytes por pedido em `DB_PEDIDOS`, tudo inteiro
na lista do admin), `desconto` vindo do cliente e impresso no aviso aos
sócios, e o GET por id devolvendo o pedido CRU pro próprio usuário — furando
a whitelist que a LISTA aplica de propósito desde o MC5-P2.

**v194 — Lote 12: rotas que contrariavam regra escrita do dono**
(`server.js`). (1) A ordem v178 fechou a pergunta — pedido com valor errado é
CANCELADO e refeito, nunca corrigido — mas `/api/admin/pedido-set-valor` e o
branch `corrigirValor` do PATCH continuavam vivos, sem nenhum botão no
painel: por curl qualquer admin reescrevia o valor de um pedido (a rota nem
olhava o status — reescrevia pago e cancelado, sincronizando o caixa junto) e
ativava. (2) O ramo `isReply` do `/api/send` não tinha NENHUM chamador (a aba
Respostas não existe e o app é só-envio) e era um bypass de verdade: com
`isReply:true` + um `threadId` que o próprio `/api/send` devolveu, o envio
pulava limite diário, cooldown, freio de rajada, "já enviei pra esse
empregador" (regra 8) e a fila do automático — até 50 e-mails/dia extras pra
empregador JÁ contatado, com `countedAsManual:false`.

### Regras novas (não quebrar)

- **RESTAURAR BACKUP CONGELA AS GRAVAÇÕES ATÉ O REINÍCIO**:
  `congelarGravacoes()` liga um portão ÚNICO dentro de `persist()` (todo banco
  passa por ele) + `_persistNotifCooldowns`, cancela os debounces pendentes e
  o timer de sessões, e o `flushAll` do SIGTERM RESPEITA o congelamento. A
  rota responde `congelado:true` e o site segue no ar servindo o estado antigo
  da memória até o restart. PROIBIDO um caminho de escrita novo que não passe
  por `persist()` sem checar a flag — sem isso o roteiro do
  `RESTAURACAO_BACKUP.md` volta a mentir.
- **O DESLIGAMENTO GRAVA TODO DEBOUNCE PENDENTE, E CADA BANCO UMA VEZ SÓ**: o
  mapa `_persistDebounceTimers` guarda `{tid,data}` e o `flushAll` percorre
  TUDO que está pendente antes da lista fixa, deduplicando por arquivo.
  Persistência nova com `persistDebounced` já nasce coberta — não precisa (e
  não deve) virar mais uma linha na lista fixa. A linha
  `[shutdown] ✅ Dados salvos (...): a,b,c` é a prova, e o smoke lê ela.
- **BACKUP DE BOOT SÓ SE O MAIS RECENTE JÁ TIVER ≥12h**: com deploy a cada
  commit e retenção de 3, backup de boot sem freio apaga os dias anteriores.
  A pasta continua nascendo com o prefixo de data (`/^\d{4}-/`) — é por ele
  que a poda e a faxina de emergência enxergam; prefixo novo criaria
  diretório invisível pras duas (o incidente do ENOSPC).
- **ARQUIVO DE USUÁRIO NÃO MORA DENTRO DE JSON DE BANCO**: PDFs em `cvs/`
  (v21), comprovantes de pedido em `comprovantes/` (v192), sempre com escrita
  atômica (tmp+rename) e leitura SOB DEMANDA. Pasta nova de arquivo entra no
  `criarBackupCompleto` **e** no backup/restore do painel NO MESMO COMMIT —
  backup sem ela devolve conta sem currículo ou pedido sem prova de pagamento.
  Migração de boot idempotente, de QUALQUER status, e nada sai da memória
  antes de o arquivo existir em disco.
- **"TEM COMPROVANTE?" É UMA PERGUNTA SÓ**: `temComprovante(pd)` (arquivo em
  disco OU legado inline) e `loadComprovante(pd)` pros bytes. Proibido voltar
  a espalhar `!!pd.comprovante` — era assim que cada tela decidia sozinha.
  O contrato das rotas não mudou: `GET /api/pedido/:id` (admin) devolve o
  base64 como sempre, só que lido do disco, numa CÓPIA.
- **DATA QUE VIRA DINHEIRO É VALIDADA NA PORTA**: `pagoEm` aceita número ou
  string parseável dentro de uma faixa sã (≥2024, ≤ hoje+36h) — fora disso,
  400 na cara, nunca "corrige depois" (v178). Todo ponto que converte data de
  pagamento em `Date` DEPOIS de mexer em plano/dias tem cinto e suspensório
  (`Number.isFinite` → hoje) — exceção em conversão de data nunca pode
  acontecer depois de creditar dias.
- **CAMPO LIVRE DE ROTA PÚBLICA TEM TIPO E TETO**: `String(x||"").slice(n)`
  com os mesmos tetos do cadastro. Campo que nenhuma tela manda (`desconto`)
  é forçado ao valor neutro, não "aceito por via das dúvidas".
- **O QUE O DONO DO PEDIDO VÊ É UMA FUNÇÃO SÓ**: `_pedidoVisaoUsuario(pd)`
  serve a LISTA e o DETALHE. Nunca `{...pd}` pro usuário comum: junto vão
  `preCheck` (com e-mail de OUTRO usuário no `dupAlerta`), `notaAdmin` e
  `avisoFalhas`. `motivoCancelamento` faz parte da projeção — é o que o card
  da Home (v185) mostra.
- **VALOR DE PEDIDO NÃO SE CORRIGE**: cancela e refaz (v178). Não existe rota
  nem branch de correção; a guarda do smoke é NEGATIVA pra regra não voltar
  sozinha. Os campos `valorOriginal`/`valorCorrigidoPor`/`valorCorrigidoEm`
  continuam nas respostas como LEITURA — apagá-los destruiria a trilha de
  pedido antigo já carimbado.
- **O APP SÓ ENVIA**: `/api/send` recusa `isReply:true` com 400 e IGNORA
  `threadId`/`messageId` (cliente antigo em cache não perde a candidatura).
  Toda candidatura passa pelo limite diário, cooldown, freio de rajada, regra
  8 e fila do automático — não existe caminho "de resposta" que pule isso.
  Na seleção de remetente, escolher explicitamente o e-mail PRINCIPAL é um
  caso legítimo com ramo próprio (`if(requestedSender && requestedSender!==
  s.user_email){…} else if(!requestedSender){round-robin} else {principal}`).

## v195–v198 — Varredura total, lotes 13-16

Continuação direta do v183–v186, v187–v190 e v191–v194 (mesma ordem do dono,
18/09/2026: **"O que ainda pode melhorar? O que não faz sentido existir? Ou
funciona errado? Pensa sobre tudo e resolva!"** + autorização total). Estes 4
lotes são o Gmail de envio · o trato com o DOL · os números e promessas do
site · a faxina do front. 34 checks novos (619 → 653), 2 asserções antigas
atualizadas porque codificavam o comportamento errado. sw v58 → v62.

**v195 — Lote 13: reconectar o Gmail volta a ligar o robô** (`server.js`,
`app.js`, `mod-watchdogs.js`, `index.html`, sw v59). Cliente PAGANTE com o
automático parado por autenticação era mandado pra um botão que não existe:
TODAS as instruções de pausa (os status/dicas do front nos 3 idiomas, o toast,
o `addLog` do motor, o diagnóstico de queda rápida, o watchdog e o Token
Guardian) diziam "saia e faça login com o Google de novo" — mas o login do
site é usuário+senha desde o v172c e `/oauth/start` é dead-end. E quando ele
acertava mesmo assim, o callback do `/oauth/connect-send` só limpava
`rtInvalid`: o job continuava `paused_*` até a pessoa achar o botão genérico
"Retomar". Junto ia o aquecimento: o relógio do Gmail PRINCIPAL era o
`created_at` do CADASTRO, mas desde o v172c o Gmail só é conectado DEPOIS de
pagar — conta antiga conectava um Gmail novinho em folha e entrava sem teto
nenhum (`cap=null`), justo o caso que o aquecimento existe pra proteger; e o
`primaryWarmup` que o servidor calculava não era lido por tela nenhuma,
enquanto o tutorial prometia "o selo 🌱 no Perfil mostra o estágio".

**v196 — Lote 14: educado com o DOL** (`server.js`, `mod-planilhas.js`,
`sw.js`, sw v60). O IP deste servidor no DOL é recurso COMPARTILHADO: se ele
levar 403/429, os 5 robôs de planilha e as "Vagas ao Vivo" morrem pra TODO
MUNDO ao mesmo tempo. Três portas escancaradas: `/proxy` repassava QUALQUER
método/corpo pra seasonaljobs.dol.gov com o nosso IP, sem sessão, sem
rate-limit e com CORS `*` — e nenhuma tela do site chamava; `/api/jobs`,
`/api/sheet-detail` e `/api/sheet-batch` batiam no DOL a CADA chamada anônima
(o batch podia virar 11 requisições) com `case`/`state` interpolados crus no
`$filter`; e o enriquecimento reperguntava ao governo, a cada 30min e PRA
SEMPRE, as linhas que o DOL já tinha respondido sem ter o que dar — a jul2026
inteira (2.625 linhas, zero e-mail) nesse laço, com uma linha de log por vaga
engolindo o ring de 1500 do `botLog`.

**v197 — Lote 15: os números e as promessas batem com o código**
(`index.html`, `app.js`, `server.js`, `como-usar.html`,
`tutorial-conteudo.html`, sw v61). Cinco textos vendiam um produto diferente
do que o motor entrega, todos cobertos pela regra v172j: a landing prometia
"prioridade máxima na fila" (não existe: a única ordenação é DENTRO da fila do
próprio usuário), "aumenta seu limite diário" (grátis é 0 — não aumenta,
LIBERA) e robô "até 400 candidaturas/dia" (o automático máximo é 200); um
modal morto ainda anunciava "Free (20 manual + 10 auto/dia)"; cinco lugares
diziam "5–6 min" entre envios enquanto o motor manda a cada ~7 — e a PREVISÃO
de quando a fila termina usava 5,5 min, ~27% otimista; Termos, /terms,
como-usar e tutorial mandavam "adicionar 2 ou mais contas Gmail" num produto
onde VIP/VIPro podem 1 e DoublePro no máximo 2; o rodapé afirmava "mantido por
doações — nunca por venda" 200 linhas abaixo de "assina um plano via PIX"; e
quem JÁ PAGA e batia o limite do dia lia "Assine um plano" e "Continuar amanhã
de graça".

**v198 — Lote 16: faxina no front** (`app.js`, `index.html`,
`h2b-extras-user.js`, `check-duplicates.js`, `check-xss-guard.js`,
`server.js`, sw v62). O front carregava ~470 linhas que ninguém chamava: o
subsistema de "Modelos de e-mail" inteiro (morto desde o v22 — `BUILTIN_
TEMPLATES=[]`, 20 funções órfãs, um overlay inalcançável e 3 rotas), que ainda
custava 1 fetch a CADA abertura do Perfil; 31 funções sem nenhum chamador; um
chip de limite que pintava um `#hdr-lim` inexistente, chamado 10x por sessão;
e o `check-duplicates.js` — a guarda que nasceu porque "a segunda declaração
sobrescreve a primeira em silêncio" no front — não varria justamente o
`app.js`. O rótulo de plano estava escrito em 8 grafias divergentes e o header
ainda rotulava pelo NOME do plano: quem tinha só o automático ativo via
"🤖 VIPro" com 0 manuais/dia, o mesmo bug que o v177-FIX8 corrigiu só no
Perfil. E sobravam 4 ocorrências do `${p.icon}` cru que o v177-FIX2 corrigiu
num 5º lugar.

### Regras novas (não quebrar)

- **RECONECTAR O GMAIL RETOMA O ROBÔ, E O RITMO É PRESERVADO**:
  `retomarAutoAposReconexao(email)` (server.js) é chamada pelo callback do
  `/oauth/connect-send` e religa o job parado por autenticação
  (`AUTH_PAUSED_STATUSES`) **só** com automático ativo (ou admin) e
  `refresh_token` de verdade — o gate v172h não muda. `nextSendAt` futuro vira
  timer pro tempo que FALTAVA; nunca um `scheduleAuto` na hora (dispararia o
  refill e furaria os ~7min do v184). Retomar em silêncio confunde tanto
  quanto parar em silêncio: fica `addLog` no histórico e o retorno leva
  `&autoRetomado=1`, que a tela transforma em aviso.
- **TODA INSTRUÇÃO DE PAUSA APONTA PRO CAMINHO QUE EXISTE**: o cartão
  "Conectar meu Gmail" (`/oauth/connect-send`). PROIBIDO em qualquer arquivo
  servido ao cliente, log do motor ou vigia mandar "fazer login com o Google
  de novo" — o login do site é usuário+senha desde o v172c. Texto de pausa
  novo entra nos **3 dicionários no mesmo commit**: 1 idioma consertado e 2
  mentindo é o mesmo bug com outra cara. Guarda por frase no smoke.
- **O RELÓGIO DO AQUECIMENTO DO GMAIL PRINCIPAL É A CONEXÃO**:
  `gmailConnectedAt || created_at`, carimbado **só na 1ª conexão** (o Gmail de
  envio é PERMANENTE — recarimbar numa reconexão zeraria o aquecimento de uma
  conta madura). O fail-open do `warmupCapForSender` continua: sem data
  conhecida, NUNCA bloqueia. O selo 🌱 é HTML ÚNICO (`_warmupBadgeHTML`, usado
  pelo principal e pelos extras) e é PROIBIDO esconder o throttling do
  usuário.
- **O IP DO SERVIDOR NO DOL É DE TODO MUNDO**: não existe proxy aberto pro
  DOL (o `/proxy` foi removido e não volta). As 3 rotas públicas que falam com
  o DOL continuam **públicas** (a busca de SEO e o carregamento em background
  do app dependem disso), mas: (a) `/api/jobs` responde de um CACHE por
  combinação de filtros — é ele que corta a amplificação, mais que o 429 —
  guardando a resposta CRUA (a máscara de e-mail do v182 LOTE 10 é por
  requisição, sempre); (b) rate-limit GENEROSO por IP, preferindo o e-mail da
  sessão (CGNAT: um 429 num fluxo humano é pior que o problema); (c)
  sanitização que PRESERVA — aspa do estado ESCAPADA no padrão OData (nunca um
  `/^[A-Z]{2}$/` cego, que quebraria o nome por extenso) e case number só
  passa se FOR um case number (`/^[A-Z0-9-]{5,24}$/`). `DOL_API_BASE` vale
  também no server.js (mesma régua do v182): em produção o padrão é o host
  real.
- **O QUE O DOL JÁ DISSE QUE NÃO TEM NÃO SE REPERGUNTA NA HORA**: o carimbo
  `row.eq` sai da fila do robô por 60h (janela 48-72h de propósito: e-mail que
  aparece no DOL é vaga candidatável). O PAINEL continua contando a linha como
  pendente — ela é — e ganha `aguardandoDol`; quem enxerga "pendente agora"
  (`pendentesAgora`/`semEmailAgora`) é o robô. Log de vaga sem e-mail é RESUMO
  por ciclo, nunca 1 linha por vaga (o ring de 1500 do botLog é compartilhado
  com frescor, mensal e sentinela).
- **TEXTO DE PRODUTO ESPELHA O CÓDIGO, NUNCA O CONTRÁRIO**: os números de
  envio/dia da landing e da calculadora derivam de `PLAN_LIMITS_NEW`
  (guarda permanente no smoke, no molde da que já existia pra
  /h2bapply-funciona); o intervalo do robô tem UMA constante no front
  (`AUTO_INT_MIN/MAX/AVG`, espelhando `calcSmartInterval`) e é PROIBIDO um
  arquivo servido dizer "5–6 min" ou calcular previsão com 5,5; o texto de
  Gmail por plano é o MESMO nos 8 pontos (VIP/VIPro 1 conta, DoublePro 2) —
  PROIBIDO mandar "adicionar 2 ou mais contas"; e mexer no texto dos TERMOS
  obriga a subir `versaoTermos` no mesmo commit, senão consentimentos velhos e
  novos apontam pra textos diferentes com a mesma etiqueta.
- **O FUNIL DO LIMITE LÊ AS DUAS DIMENSÕES**: `limitUpsell` ramifica por
  `U.manualLimit`/`U.autoLimit` (que são 0 quando aquele lado não está ativo —
  v172i), nunca por "tem plano"; DoublePro com os 2 lados ativos e admin não
  veem upsell nenhum. Nenhum texto de limite promete "de graça" — a conta
  grátis envia ZERO desde o v172.
- **RÓTULO DE PLANO: DUAS FUNÇÕES, ZERO MAPAS SOLTOS**. `planLabelAtivo()` diz
  o que a conta pode fazer HOJE, derivado de `vip.manualExpires`/`autoExpires`
  (⭐ VIP · 🤖 Pro · ⭐🤖 VIPro · 💎 DoublePro · Grátis) e serve o header;
  `planBadgeHTML()` é o badge com dias. `PLAN_NAMES`/`planNomePedido()` só
  valem onde o rótulo se refere a um PEDIDO/plano COMPRADO. PROIBIDO um mapa
  novo por nome de plano pra dizer o que a conta pode fazer — é a armadilha do
  v177-FIX8 (`getPlan()` devolve "vipro" pra quem só tem o automático).
- **FUNÇÃO DUPLICADA É VIGIADA NO FRONT INTEIRO**: `check-duplicates.js` varre
  server.js, **app.js**, os `mod-*.js`, os `<script>` inline de index/admin e
  o h2b-extras-user.js. O maior arquivo servido ao cliente estava de fora da
  guarda que existe justamente por causa dele.
- **ÍCONE DE PERFIL É CAMPO LIVRE**: `p.icon`/`selP.icon` passam por `esc()`
  em TODO ponto (mesma classe do `${icon}` do v177-FIX2). E a mensagem de erro
  do `check-xss-guard.js` ensina a ASSINATURA — a ALLOWLIST é indexada por
  assinatura, e uma entrada "arquivo:linha" nasce morta e envelhece a cada
  edição.
- **UMA VERDADE POR PREFERÊNCIA NO APARELHO**: o tema é `h2b_theme` (fora do
  helper do módulo de extras, que prefixa `hx_`) e é aplicado uma vez só, pelo
  `<head>` do index, antes do primeiro paint. Rascunho de texto em
  localStorage tem que ter ESCOPO (o `draft_<id>` global entregava o texto da
  Conta A pra Conta B no mesmo aparelho — mesma classe que o v177-FIX6
  fechou). `setInterval` perpétuo pra "melhoria" com zero casos não existe.

## v199–v201 — Varredura total, lotes 17-19

Continuação direta do v183–v186, v187–v190, v191–v194 e v195–v198 (mesma ordem
do dono, 18/09/2026: **"O que ainda pode melhorar? O que não faz sentido
existir? Ou funciona errado? Pensa sobre tudo e resolva!"** + autorização
total). Estes 3 lotes são o português fixo · a faxina do servidor · as guardas
da suíte. 26 checks novos e 6 asserções antigas removidas ou reescritas porque
codificavam comportamento que não existe mais (654 → 676). sw v62 → v65.

**v199 — Lote 17: português fixo de verdade** (`app.js`, `server.js`, sw v63).
O README e este arquivo dizem que "o app não tem seletor de idioma nem detecta
idioma do navegador — é só em português, de propósito". A regra era declarada e
NÃO era real: `_curLang` aceitava `'en'`/`'es'` do localStorage `h2b_lang`,
gravado a partir do `d.language` que o servidor devolvia, e `/api/settings`
aceitava e gravava pt|en|es. Como NENHUMA tela tem botão de idioma, uma conta
com `language:'en'` (legada ou gravada por um POST direto) abria o site inteiro
em inglês **sem nenhum caminho de volta**. Junto saíram 3 resíduos que
procuravam `#lang-label`/`#lang-flag`/`.lang-opt` (não existem no HTML), o POST
de idioma que rodava a CADA `applyLang()` e o evento `h2b:langchange` (zero
ouvintes no repo).

**v200 — Lote 18: faxina do servidor** (`server.js`, `app.js`,
`mod-watchdogs.js`, `mod-sentinel.js`, sw v64). 786 linhas a menos no server.js,
todas provadas inalcançáveis: o stack inteiro de leitura de caixa de entrada
(`gmailFetchInbox`, `gmailMarkRead`, o parser de mensagem, `matchAppToEmail` e
as 3 rotas `/api/inbox*` — duas delas SEM guarda, chamariam o Gmail com um
escopo que a conta não tem), o callback-legacy sob `if(false&&…)`, o índice
`app_index.json` (ESCRITO a cada candidatura enviada pra alimentar um leitor que
também era inalcançável), o leitor de bounce que só rodava dentro dele, 2 sinks
sem front (`/api/note/:id`, `/api/alerts`), o `d.settings` do `/api/settings`
(merge de objeto arbitrário do cliente dentro do users.json) e 5 bancos que só
eram carregados no boot e regravados no shutdown. Mais 2 vigias que só existiam
no papel e uma afirmação diária falsa (ver regras abaixo).

**v201 — Lote 19: as guardas da suíte** (`smoke-test.js`, `sw.js`,
`sw-bump.js`, `package.json`, `.node-version`, `CLAUDE.md`, sw v65). Três
buracos de confiança: as 2 guardas do CACHE_NAME eram sempre-verdadeiras (só
conferiam "versão ≥ v43"); a suíte subia o servidor UMA vez, num disco limpo e
sempre com `STORAGE=json`, então nem a idempotência das migrações de boot nem o
SQLite que roda em produção eram exercitados; e um check com título de feature
de outro projeto ("Respostas Certas") passava só pelo portão genérico
`/api/admin`.

### Regras novas (não quebrar)

- **O IDIOMA É UMA CONSTANTE**: `const _curLang = 'pt'` — uma atribuição só, em
  todo o front. É PROIBIDO ler/gravar `h2b_lang`, consultar `navigator.language`
  ou mandar idioma pro servidor. A whitelist do `/api/settings` é `"pt"` e só
  (`'pt-BR'` continua sendo aceito e normalizado — é o que toda conta antiga
  carrega). Os dicionários EN/ES e as guardas i18n continuam VIVOS por decisão
  do dono: o dia em que existir seletor, muda-se essa linha e mais nada. O que
  morreu foram 235 chaves que nenhuma tela usa (medidas por script, régua
  conservadora: só entra quem não aparece em lugar nenhum fora do dicionário,
  contando os prefixos montados dinamicamente) e 24 chaves DUPLICADAS dentro do
  mesmo dicionário — o JS sobrescreve a primeira em silêncio, e uma delas
  (`send_profile`) tinha 2 valores diferentes. Guarda nova: **os 3 dicionários
  têm EXATAMENTE o mesmo conjunto de chaves, sem duplicata** — chave que nasce
  em 1 língua só é buraco de tradução que a i18n-1 só pega quando a chave chega
  ao HTML.
- **CONTA PRESA EM DADO RUIM É CURADA POR MIGRAÇÃO, NUNCA SÓ "PRA FRENTE"**:
  `_migrarIdiomaParaPt` normaliza no boot todo `language !== "pt"`, com log de
  quantas contas e idempotente (no boot seguinte ninguém bate na condição). E
  conta nova já nasce com o valor final (`"pt"`, não `"pt-BR"`) — senão a
  migração teria trabalho eterno e o 2º boot acusaria reaplicação.
- **O APP SÓ ENVIA — E AGORA SÓ EXISTE O QUE ENVIA**: não há mais nenhuma
  função, rota ou banco de leitura de caixa de entrada. `GMAIL_SEND_ONLY`
  continua `const true` como documentação (guarda própria no smoke).
  `pushToUser`/`sendNotifEmail` FICAM: são contrato de injeção de 4 módulos, e a
  decisão de mantê-los como stubs está escrita no mod-config.js.
- **REMOVER O LEITOR SEM REMOVER O ESCRITOR É O PIOR DOS MUNDOS**: o
  `app_index.json` era escrito a cada candidatura pra alimentar um único leitor
  morto. Índice, escritor e leitor saíram no MESMO commit. Nada gravado em disco
  é apagado (campos antigos em registros continuam lá, só param de ser
  alimentados) — a mesma régua vale pra qualquer sink futuro.
- **OS 3 BANCOS DE BOUNCE SÃO HISTÓRICO + AJUSTE MANUAL**: `DB_INVALID_EMAILS`
  continua sendo LIDO no envio (manual e robô pulam endereço com bounce
  conhecido) e escrito pelo admin em `/api/admin/email-intelligence/mark-invalid`
  — nunca mais por descoberta automática, que dependia de ler a inbox.
- **VIGIA QUE NÃO PODE ACENDER É PIOR QUE NENHUM**: `vipExpiryWatchdog` era um
  `return` vazio agendado a cada 15min (e o comentário ainda prometia "10
  automáticos/dia grátis", o oposto do ZERO envio grátis do v172) — removido;
  quem para o robô de quem não tem plano é o `scheduleAuto` (`paused_no_vip`,
  v172h). O monitor de planilhas do sentinela testava `typeof getSheet` de uma
  global que não existe no módulo (a função chega em `ctx.getSheet`), então
  `S.planilhas` era SEMPRE `[]` e o resumo dizia "0 planilha(s) com alerta" com
  planilha envelhecida na frente dele. Agora a lista vem da MESMA função do robô
  de frescor (planilhas publicadas) e "completa" é medida pela régua única
  `CAMPOS_ESSENCIAIS` (v182), nunca por e-mail só.
- **LOG DE ROBÔ NÃO AFIRMA O QUE NÃO ACONTECEU**: o "Resumo Diário do Dono"
  executava `for(const ae of ADMIN_EMAILS){}` — corpo VAZIO — e gravava "Enviado
  aos admins: …" todo dia. O laço morreu e o texto virou "Resumo de ontem". Não
  virou e-mail: seria um 4º tipo além dos 3 sancionados no v175, decisão do dono.
  A FORMA do JSON de retorno não muda (`respostas:0`).
- **"TRIAL" NÃO SE INVENTA NA SAÍDA**: os 2 pontos que expõem `vip.source`
  devolvem `null` quando o campo falta (não existe trial nesta reconstrução). Os
  ramos que COMPARAM `source==="trial"` continuam intocados — ali é sentinela
  viva na exclusão de plano pago.
- **O BUMP DO SERVICE WORKER TEM COMANDO E TEM PROVA**:
  `npm run sw-bump -- "o que mudou"` sobe o `CACHE_NAME` E regrava o
  `CACHE_FRONT_FINGERPRINT` (hash de index.html + admin.html + app.js +
  h2b-extras-user.js). Nunca editar os dois à mão. O smoke importa a função de
  hash do próprio `sw-bump.js` (fonte única) e FALHA quando o front mudou sem o
  bump, dizendo o comando. **Guarda que compara com o estado real dos arquivos,
  nunca um número que só cresce** — é o que as 2 guardas antigas não faziam.
- **O 2º BOOT É O QUE IMPORTA**: este repo faz deploy a cada commit, então a
  suíte derruba o servidor com SIGTERM (esperando o evento `exit` com teto — sem
  isso o próximo spawn bate em porta ocupada e a suíte falha pelo motivo errado)
  e sobe de novo no MESMO DATA_DIR. Migração de boot que REAPLIQUE quebra o
  teste (casando só com os prefixos de log que significam APLICAÇÃO — vários
  blocos logam sem fazer nada). Também é provado ali: robô em `sending` e em
  `waiting_limit` voltam com a fila inteira, pedido provisório continua pendente
  e ativo, e a sessão de login cai **de propósito** (o boot declara a decisão no
  log). Subir/derrubar servidor é um helper ÚNICO (`spawnServidor`/
  `matarServidor`/`esperarNoAr`), compartilhado com o drill de restauração do
  v191 — proibida uma 2ª cópia.
- **O MODO DE PRODUÇÃO É EXERCITADO**: um 3º servidor curto roda SEM
  `STORAGE=json` (SQLite + espelho JSON) e prova .db criado, JSONs importados e
  dado de volta depois de um restart. Sem `node:sqlite` nem `better-sqlite3` no
  ambiente, o check PULA com aviso explícito no log — **nunca falso-verde**.
- **A MAJOR DO NODE É UMA SÓ**: `.node-version` (o que o Render honra), `engines`
  do package.json e o `node-version` do CI apontam pro MESMO número (hoje 22, a
  major que o CI já prova a cada push). Guarda no smoke mantém os 3 em
  sincronia. Subir pra uma major que o CI não roda é quebrar o deploy por causa
  de um teste.

## v202–v205 — Varredura total, lotes 20-23 (fim da varredura)

Fecha a varredura de 22 lotes aberta no v183 (mesma ordem do dono,
18/09/2026: **"O que ainda pode melhorar? O que não faz sentido existir? Ou
funciona errado? Pensa sobre tudo e resolva!"** + autorização total). Estes 4
lotes são o motor de envio testado de verdade · o CSS de telas que não
existem mais · a documentação que não engana · a guarda de XSS por
expressão. 21 checks novos e 2 asserções antigas fortalecidas (676 → 697).
sw v65 → v67.

**v202 — Lote 20: o motor de envio finalmente testado** (`mod-gmail.js`,
`server.js`, `smoke-test.js`, `.env.example`). A prioridade nº1 do produto —
a candidatura CHEGAR no empregador — tinha cobertura comportamental ZERO:
todo POST em `/api/send` e `/api/auto/start` da suíte parava nos portões
(402/429/400/lock), porque o Gmail e o endpoint de token do Google são hosts
fixos que o sandbox não alcança. As garantias mais caras do repo (token
vencido no meio da fila que renova e re-tenta a MESMA vaga, erro pós-envio
que não pode virar "falha", extra com auth morta isolado) eram provadas por
GREP DE STRING no server.js: renomear um log quebrava o teste, quebrar a
lógica mantendo o texto passava verde. E o check da sentinela ainda gastava
segundos esperando timeout de rede real pro Google. **Bug real achado ao
testar de verdade**: o `markSent` do envio MANUAL vivia DENTRO do try de
contabilidade cujo catch (v177-FIX3) devolve `ok:true` de propósito — uma
exceção ali (cliente mandando `desc` como número faz `buildJobSnapshot`
estourar) fazia o servidor dizer "candidatura enviada" sem NUNCA registrar o
empregador na regra 8.

**v203 — Lote 21: CSS de telas que não existem mais + 2 ReferenceError**
(`index.html`, `app.js`, `smoke-test.js`, sw v66). Os `<style>` do
index.html carregavam 292 regras (~33KB) de features removidas de propósito.
A REVISÃO VISUAL REAL no Chromium que este lote exigia (Playwright, landing
+ 9 views, 1280px e 390×844, antes e depois) achou o que nenhum teste via:
dois ReferenceError de produção, da mesma classe — função removida, CHAMADA
esquecida. `_loadSoundPref()` (deixada pelo v189) abortava o app.js inteiro
na linha 6015, e tudo que era `const` depois dela ficava em TDZ pra sempre:
`LANG_DICT`, `_curLang` e **`PIX_KEY`/`PIX_NAME`, a chave Pix do checkout**.
`_showWelcome()` (deixada pelo v198) estourava na 1ª linha do `renderHome` e
a Home inteira não renderizava.

**v204 — Lote 22: documentação que não engana a próxima sessão**
(`README.md`, `CLAUDE.md`, `server.js`, `.env.example`). O CLAUDE.md manda
ler o README como fonte da verdade — e os dois mentiam: a aba Enviadas
estava em "o que NÃO existe" com a view viva, e o topo declarava que
Gemini/Cérebro Contábil não existem mandando "parar e confirmar", enquanto o
Gemini É quem lê o comprovante de PIX e o motor contábil roda no servidor.
Comentários "fonte da verdade" do server.js diziam "free → 20 manual + 10
auto/dia" (o oposto do ZERO envio grátis), que a ativação provisória "só
roda no gancho de teste" (falso desde o v177) e mandavam restaurar backup
numa "aba Configurações" que nunca existiu.

**v205 — Lote 23: a guarda de XSS julga cada `${...}`** (`check-xss-guard.js`,
`app.js`, `smoke-test.js`, sw v67). A guarda antiga dava a instrução
`.innerHTML=` inteira por segura assim que UM esc() aparecesse nela — foi
assim que o `${icon}` passou batido até o v177-FIX2, e a fraqueza estava
registrada aqui como risco conhecido. As 405 expressões interpoladas do
front foram revisadas uma a uma: 31 ocorrências de DADO ganharam esc() de
verdade, 75 entraram na allowlist com o motivo, e `showBanner()` (zero
chamadores, API "me passe HTML pronto") foi removida.

### Regras novas (não quebrar)

- **O GOOGLE FALSO SÓ EXISTE NO `npm test`, E SÓ PROS 2 HOSTS EXATOS**: o
  funil único de rede (`httpsReq`, mod-gmail.js) redireciona
  `gmail.googleapis.com` e `oauth2.googleapis.com` — nunca um wildcard de
  subdomínio, nunca o DOL/userinfo/Gemini — e SÓ com DUPLA TRAVA:
  `TEST_LOGIN_TOKEN` presente **e** `GOOGLE_FAKE_BASE` apontando pra
  `http://127.0.0.1|localhost`. Mesma régua do `DOL_API_BASE` do v182: em
  produção nada muda. Guarda permanente com 10 combinações no smoke —
  afrouxar isso é transformar o app num redirecionador de credencial do
  Google.
- **ENVIO É PROVADO POR COMPORTAMENTO, NÃO POR GREP**: os 6 cenários do
  motor (manual ponta a ponta, fila de 3 que diminui, 401 no meio da fila
  que renova e re-tenta a MESMA vaga, erro pós-envio com `ok:true`,
  invalid_grant que pausa e devolve a vaga, extra isolado com o robô
  seguindo) rodam contra o Gmail falso, com fixtures de plano PAGO — nenhum
  portão é contornado. Os estruturais antigos ficam AO LADO (custam zero e
  pegam remoção acidental do caminho de renovação). PROIBIDO trocar um
  check comportamental por grep de string de log.
- **A REGRA 8 GRAVA ANTES DA CONTABILIDADE**: no `/api/send`, `markSent` é a
  PRIMEIRA coisa depois do 200 do Gmail — nunca dentro do try cujo catch
  devolve `ok:true`. A candidatura já saiu; registrar o empregador não pode
  depender de mais nada dar certo (era assim que a mesma empresa podia
  receber 2 candidaturas).
- **A FILA ESPERTA REORDENA — TESTE NÃO ASSUME ORDEM**: `/api/auto/start`
  monta a fila pelo score de encaixe com jitter. Check que afirma "a 1ª
  vaga é a X" quebra por sorte; afirme o CONJUNTO, ou aceite qualquer uma
  das vagas semeadas.
- **CSS MORTO SE PODA POR SELETOR, NUNCA POR BLOCO**: só sai regra cujos
  seletores citam EXCLUSIVAMENTE classes mortas. Regra MISTA (a classe viva
  ao lado da morta) fica intocada — por isso `.hcard`/`.plan-card`/
  `.future-card` continuam vivos dentro das 2 regras do tema claro, com
  contador no smoke pra travar regra NOVA dessas famílias. Classe montada
  por concatenação (`"ls-"+l.status`) e o bloco de fallback de ícones
  (`ti-emoji-fallback`) ficam FORA da poda de propósito.
- **PODA DE CSS EXIGE REVISÃO VISUAL REAL**: não existe teste de regressão
  visual na suíte — prints no Chromium (landing + as 9 views, 1280px e
  390×844) ANTES e DEPOIS são a única rede. Da última vez, 17 dos 20 saíram
  byte a byte idênticos e os 3 restantes eram overlay/animação com tempo
  próprio. Estabilize a tela (fechar tour e convite de currículo) antes de
  comparar, senão o ruído esconde a regressão de verdade.
- **FUNÇÃO REMOVIDA LEVA AS CHAMADAS JUNTO — E TEM GUARDA**: duas guardas
  permanentes no smoke. (1) Nenhuma CHAMADA DE TOPO do app.js pode apontar
  pra função inexistente — ali o ReferenceError aborta o ARQUIVO INTEIRO e
  tudo que é `const` depois fica em TDZ (foi o `_loadSoundPref()`).
  (2) Nenhuma chamada do bundle do front a um nome com `_` ou maiúscula sem
  declaração nenhuma — pega a chamada escondida dentro de função (foi o
  `_showWelcome()` na 1ª linha do `renderHome`). Ao tirar a definição de uma
  função, tire os consumidores no MESMO commit.
- **"NÃO EXISTE" ≠ "EXISTE SEM TELA"**: o topo deste arquivo e o README
  listam features removidas e mandam "parar e confirmar". Antes de remover
  qualquer coisa dessa lista, confira no CÓDIGO: o Gemini existe (lê o
  comprovante de PIX, v177) e o motor contábil existe no servidor
  (`computeSocios`/`computeDreMensal`/`_fecharMes`/`relatorioExecutivoDre`)
  — o que não existe é a ABA deles. Apagar por causa do parágrafo é quebrar
  dinheiro.
- **COMENTÁRIO COM NÚMERO DE PLANO É PROIBIDO FORA DA TABELA**: a tabela
  única vive em `mod-config.js`. Cópia em comentário envelhece e vira
  armadilha — a próxima sessão lê, acredita e "corrige" o código pra bater
  com ela. Vale pra qualquer comentário "fonte da verdade": se ele afirma um
  estado do sistema, ou está certo, ou sai.
- **GUARDA POR TEXTO NÃO PODE MEDIR O PRÓPRIO COMENTÁRIO**: quando o
  comentário novo cita o texto velho pra explicar por que ele saiu, a guarda
  tem que medir a FORMA que só o código velho tinha (a linha de tabela
  `//   free → 20 manual…`, o literal do `new Set([...])`), nunca a palavra
  solta — senão ela se auto-sabota. Mesma família da regra "guarda por frase
  desconta comentários" do v189.
- **TODA ENV LIDA POR `process.env` CONSTA NO `.env.example`**: guarda
  permanente no smoke (23 envs hoje). Env de teste entra como linha
  comentada, com o aviso de nunca definir em produção. O arquivo se declara
  "fonte da verdade revisada contra process.env real" e envelhecia sozinho.
- **XSS SE MEDE POR EXPRESSÃO, NUNCA POR INSTRUÇÃO**: cada `${...}` de cada
  template dentro de `innerHTML`/`outerHTML`/`insertAdjacentHTML` é julgado
  sozinho, nos 4 arquivos do front. Passa quem vai por
  `esc`/`escAttr`/`_vfAttr`, quem é número/booleano/string literal, quem
  termina em formatação de número ou data, quem é chamada de `SAFE_FNS`
  (cada entrada com ASSINATURA e o porquê, escrita depois de LER o corpo da
  função) e quem é operador cujos ramos EMITIDOS são todos seguros. O resto
  entra na ALLOWLIST **por assinatura da EXPRESSÃO**, com o motivo — nunca
  por "arquivo:linha" (entrada por linha nasce morta). PROIBIDO voltar a
  aceitar uma instrução inteira porque "tem um esc() em algum lugar dela".

## v206 — Códigos de migração VIP do site antigo (dono, 19/09/2026)

**Pedido do dono** (documento vindo do Projeto "h2bapply versão final"): os
clientes que ainda tinham dias de VIP no site antigo precisam recuperar esses
dias no site novo sem pagar de novo — um código por cliente, enviado por
WhatsApp. O documento trazia um esboço com os clientes embutidos no
`server.js`; NÃO foi seguido ao pé da letra por um motivo que ele não sabia:
**este repositório é PÚBLICO no GitHub** (a API do GitHub responde 200 sem
autenticação). Nome e Gmail de cliente em arquivo versionado seria vazamento
de dado pessoal (LGPD) pra sempre no histórico do git.

**O que existe agora**
- **Painel admin → "Códigos de migração"** (sidebar, bloco Contabilidade):
  criar 1 código (nome, Gmail do site antigo, plano, dias, código opcional)
  ou importar em lote (`nome;gmail;plano;dias[;codigo]`, uma linha por
  cliente — linha errada é recusada com o motivo, as certas entram); lista
  com status (⏳ aguardando / ✅ usado por quem e quando), busca, botão
  **Mensagem** (copia o texto pronto do WhatsApp) e exclusão SÓ de código
  sem uso. Rotas `GET/POST /api/admin/migracao-codigos` e
  `POST /api/admin/migracao-codigos/excluir` (admin, trilha no Audit Log).
- **Aba Planos do usuário → "🎟️ Tenho um código de migração do site
  antigo"** (`<details>` fechado por padrão, i18n `mig_*` nas 3 línguas):
  `POST /api/vip/resgatar-codigo` (sessão, rate-limit 20/15min por IP).
- **Dados**: `DATA_DIR/migration_codes.json` (`persist` SÍNCRONO — é
  acesso, regra 6e; entra no backup completo como todo .json do DATA_DIR).

**Invariantes (não quebrar)**
- **Dado de cliente NUNCA no git**: o servidor nasce com ZERO códigos; a
  guarda estrutural do smoke recusa `DB_MIGRACAO_CODES["..."]=` ou qualquer
  `H2B26-XXXX-XXXX` literal no server.js. A lista dos clientes fica com o
  dono e entra pelo painel.
- **Preso ao Gmail**: o código só resgata na conta cujo Gmail confirmado no
  cadastro (`emailContato`, v175; fallback `email` pra conta legada/teste)
  é IGUAL ao do código → senão 403. Uso único (409 na repetição); o uso é
  marcado ANTES de gravar o VIP e sem `await` no meio (dois cliques nunca
  passam os dois).
- **Mesma régua de ativação do resto do site**: `addManualVipDays` +
  `addAutoVipDays` (só se o plano tem automático) somando sobre o que já
  existir; `vip.limits` carimbado por `limitsParaAtivacaoAdmin` calculado
  com o snapshot PRÉ-ativação (depois de estender os relógios a conta já
  está ativa e a função devolveria `{}`); reler `getUser` depois dos
  helpers (13j); `addCredito` tipo `gratis` origem `migracao`.
- **`vip.source = "migracao"`**: conta como plano ATIVO pra tudo que é
  feature (Gmails por plano via `getMaxSenders`, gates de envio) — o
  cliente PAGOU, só que no site antigo — mas NUNCA lança no caixa nem cria
  pedido; a régua "só `payment`/`pago` tem pedido" da divergência
  `vip_sem_pedido` não a acusa. Não usar `code`/`trial` aqui: essas duas
  são cortesia e cortariam os Gmails de envio de quem pagou.
- Testes: 14 checks (zero seed, criação, lote, duplicado, 403 conta errada,
  401 anônimo, resgate + limites 100/100 + 2 relógios + senderMax,
  409/404/400, emailContato com DoublePro 200/200, caixa intocado, lista,
  exclusão, disco síncrono, Audit Log, estrutural).

## v217 — Robôs de planilha ficam 100% manuais (dono, 19/09/2026)

**Pedido do dono** (depois de uma auditoria de custo/recursos que apontou os
robôs de planilha do site antigo E do novo rodando por relógio o dia
inteiro): *"esse vigia do dol se ele estiver no sistema novo, pode deletar
ele, quero apenas coisas referentes ao que o 2026 tem hoje, pq eu resumi o
programa todo para nao gastar, entao objetivo dele é funcionar, enviar,
cadastrar, vender e funcionar. robos só precisa 2 vezes por ano quando
entrar planilha nova. e nao mais que isso."*

**Análise antes de mexer**: o repo 2026 não tinha "vigia de anúncios do
DOL" (essa é feature do site antigo, `New-repository`, congelado desde o
v151 — não existe aqui). O que existia era o agendamento automático dos 4
robôs de planilha (v174) em `PLANILHAS.iniciarAgendadores()`:
enriquecimento (15s pós-boot + vigia a cada 30min), vagas novas H-2A
(2min pós-boot + a cada 12h), H-2A do mês (8min pós-boot + a cada 12h) e
H-2B do mês (20min pós-boot + a cada 12h). Nenhum destes é usado por
`scheduleAuto`/envio, cadastro, login ou venda de plano — são só
manutenção de dado de vaga, e o próprio dono já tinha as rotas manuais
prontas (aba Planilhas & Robôs) desde o v174.

**O que mudou**: `iniciarAgendadores()` (mod-planilhas.js) não registra
mais NENHUM `setTimeout`/`setInterval` — só loga que os robôs são manuais
e devolve `false`. `statusPainel().agendado` virou sempre `false` (o
admin.html já sabia mostrar "Só manual" pra esse estado, desde o v174 —
não precisou UI nova). Os 4 robôs continuam 100% funcionais e testados,
só que por clique do admin: `POST /api/admin/enrich/start`,
`POST /api/admin/sheet/coleta-start`, `POST /api/admin/sheet/
h2a-bimestral-run`, `POST /api/admin/sheet/h2b-mensal-run`,
`POST /api/admin/sheet/h2a-novas-run`. **Única exceção que continua
automática**: o enriquecimento disparado 3s depois de um upload manual de
planilha (server.js) — não é um agendador por relógio, é a continuação do
MESMO clique do admin (ele acabou de subir a planilha; faz sentido já
completar os campos). Os watchdogs de ENVIO (`mod-watchdogs.js`,
`mod-sentinel.js`, os 4 vigias de `DB_AUTO` em server.js) e o cron de
expiração de VIP **não foram tocados** — são "funcionar, enviar, vender",
exatamente o que a ordem do dono manda preservar.

**Textos atualizados** (admin.html, README.md, server.js): nenhum lugar
mais afirma "roda sozinho"/"2x/dia"/"a cada Nh" pros robôs de planilha —
a régua agora é "clique quando o DOL publicar temporada nova".

**PROIBIDO**: reintroduzir `T()`/`I()` (timers) dentro de
`iniciarAgendadores()`, ou qualquer outro agendador automático de
coleta/enriquecimento de vaga, sem ordem EXPRESSA e NOVA do dono. A
seção v174 acima (13/09/2026) descreve a implementação ORIGINAL —
histórico, não o comportamento atual; este parágrafo é quem manda hoje.

Testes: guarda estrutural no smoke prova que `iniciarAgendadores()` não
contém `setTimeout`/`setInterval`, que as 5 rotas manuais continuam
funcionando (já cobertas pelos checks do v174/v177/v207), e que
`statusPainel().agendado` é sempre `false`.

## v218 — Reestruturação da página de Planos (dono, 20/09/2026)

**Pedido do dono** (3 partes, texto completo): design novo com diamante
ilustrado nas cores do Brasil como peça central, pesquisa de páginas de
pricing bem avaliadas (tabela comparativa, plano recomendado, FAQ, selo
de economia); nomes/preços/duração novos pros 3 planos, cada um com 30 ou
60 dias (60 com desconto); e varredura técnica completa em todo o site
(front+back) atrás de qualquer referência aos nomes/preços/limites
antigos, incluindo checkout, limites diários, ativação/duração do VIP
(agora 30 ou 60 dias) e tratamento de quem já tem plano ativo. Sem push
pra produção até confirmação explícita do dono (mesmo protocolo do hero
v216).

**PREÇOS/NOMES/LIMITES NOVOS** (`mod-config.js` `PLAN_LIMITS_NEW` +
`NOME_PLANO_PUBLICO`, `server.js` `PLANO_PRECO_TAB`) — só valem pra
ativação NOVA a partir de hoje (contrato congelado, ver abaixo):
- **Manual** (chave interna `vip`, inalterada): 100 candidaturas manuais
  por dia, sem automático. R$150 por 30 dias ou R$270 por 60 dias
  (economize R$30).
- **Turbo** (chave interna `vipro`, inalterada): 100 manuais + 100
  automáticas por dia. R$300 por 30 dias ou R$540 por 60 dias (economize
  R$60).
- **Máximo** (chave interna `doublepro`, inalterada): 50 manuais + 300
  automáticas por dia (era 200/200). R$500 por 30 dias ou R$900 por 60
  dias (economize R$100).
- Durações de 90 e 365 dias saíram de `PLANO_PRECO_TAB` (só 30/60 agora)
  — nada mais dependia delas (confirmado na varredura).

**DECISÃO ARQUITETURAL CENTRAL**: as CHAVES INTERNAS (`vip`/`vipro`/
`doublepro`) foram mantidas de propósito — só o NOME PÚBLICO e os
NÚMEROS mudaram. Isso evitou reescrever banco de dados, chaves do
dropdown do admin, agrupamento de relatório financeiro, formato dos
códigos de migração e a chave de `getMaxSenders` — o "contrato
congelado" que já existia desde o v118 (`vip.limits` carimbado na
ativação, `getManualLimit`/`getAutoLimit` leem de lá primeiro) já
resolve sozinho o problema de "quem já pagou não pode ser afetado":
`PLAN_LIMITS` (tabela legada) foi atualizada para os valores de HOJE (a
geração anterior à v218), então quem tem plano ativo continua com o
limite que comprou até vencer, sem re-carimbo.

**Fonte única de nome público**: `NOME_PLANO_PUBLICO` (mod-config.js) no
backend + `PLAN_NAMES` (app.js) no front — os dois precisam ser tocados
juntos ao renomear um plano (mesmo padrão que já existia pro emoji).
Nenhum texto novo pode voltar a dizer "VIP"/"VIPro"/"DoublePro" — só
"VIP" genérico (= assinante pagante, conceito antigo que sobrevive em
textos de migração do site velho) e "VIP Infinito" (acesso ilimitado do
admin, conceito diferente) continuam existindo, sem relação com os 3
nomes de plano renomeados.

**DESIGN**: diamante SVG (corte brilhante, `clipPath`) estampado com a
bandeira do Brasil (campo verde, losango amarelo — ecoando a forma do
próprio diamante —, círculo azul com globo estilizado, faixa branca sem
texto ilegível, estrelas), facetas e brilho diagonal, `drop-shadow` —
peça central no topo da aba Planos (index.html). Pesquisa de mercado
aplicada: 3 planos é o número mais efetivo; plano do meio (Turbo)
destacado com selo "🔥 MAIS POPULAR" e borda âmbar; selo de economia em
R$ calculado DINAMICAMENTE a partir do preço real vindo de `/api/planos`
(nunca hardcoded — se a tabela mudar de novo, o selo se atualiza
sozinho); FAQ de 6 perguntas (diferença dos planos, por que 60 dias é
mais barato, o que acontece no vencimento, reembolso, segurança do
Gmail, garantia de emprego) com conteúdo cruzado com `/termos` pra nunca
contradizer a lei (CDC art. 49, 7 dias de arrependimento).

**VARREDURA TÉCNICA**: sweep completo em server.js (preço oficial
sempre recalculado no servidor — nunca confia em valor do cliente),
app.js (removidos 4 dicionários de nome duplicados, unificados em
`PLAN_NAMES`), admin.html (dropdowns de migração/set-plan, listagens de
usuário/pedido), index.html, tutorial-conteudo.html, como-usar.html,
h2bapply-funciona.html (página estática de preços reescrita por
inteiro), README.md — toda menção a nome/preço/limite antigo trocada,
incluindo textos de aviso de Gmail ("VIP e VIPro… DoublePro" →
"Manual e Turbo… Máximo") que uma busca só pelo NOME antigo não pegaria
sem também atualizar a régua de guarda do smoke.

**Transição seguro pra quem já comprou**: nenhuma migração de boot foi
necessária — o mecanismo de contrato congelado (v118) já cobre 100% do
caso "cliente pagou antes da mudança de preço/nome". Único cuidado
prático (fora do código, avisado ao dono no relatório): um pedido criado
ANTES do deploy mas aprovado DEPOIS herda os limites NOVOS na hora da
aprovação (é a ativação que carimba `vip.limits`, não a criação do
pedido) — recomendação de aprovar pedidos pendentes antes de publicar,
ou aceitar que o cliente recebe o valor da tabela vigente na aprovação
(nunca o contrário — nunca cobra errado, o preço final que o pedido
grava é sempre o oficial de quando foi CRIADO, `PLANO_PRECO_TAB` na
criação do pedido).

Testes: smoke v218 exercita a tabela nova ponta a ponta pela APROVAÇÃO
REAL de pedido (não só `set-plan` do admin) nos 3 planos, incluindo a
duração de 60 dias (v187-L5, MC5-P1/P2/P5/P6, v183-L1, v185-L3,
combo plano×prazo); guarda permanente (v197-L15) garante que os números
de envio/dia da landing/calculadora sempre saem de `PLAN_LIMITS_NEW` e
nenhum texto antigo de "2 ou mais contas Gmail"/nome de plano volta.
Verificação visual real com Playwright (desktop 1440px e mobile 390px)
confirmou o diamante, a tabela, o selo "MAIS POPULAR", os selos de
economia e o FAQ renderizando corretamente nos dois formatos.

## v219 — Refoto dos prints reais da landing pós-rename de planos (dono, 20/09/2026)

Achado do dono revisando o site AO VIVO após o v218: `landing-4-
automatico.jpg` e `landing-5-painel.jpg` (as 2 das 5 capturas reais do
hero/"Veja o site por dentro" mais afetadas pelo rename) mostravam
"VIPro — 200 envios/dia automático" e "VIP 21 dias" — nomes/números
de ANTES do v218 (as fotos foram tiradas antes do rename, no mesmo
dia). Refotografadas com Playwright (TEST_LOGIN_TOKEN + fixtures reais,
mesmo padrão das outras 5 capturas), mesmas dimensões exatas de antes
(860×1168 e 804×1974, sem mexer no layout do carrossel). Publicado
DIRETO por autorização explícita do dono no chat ("é só troca de
imagem estática, não mexe em preço/lógica... pode publicar direto, sem
esperar minha confirmação") — única exceção ao protocolo padrão de
aguardar confirmação escrita antes de dar push.

Nota permanente: o badge "🤖 Pro" ao lado dos dias do automático NÃO é
um dos 3 nomes de plano renomeados — é rótulo genérico e deliberado de
"automático ativo" (`planBadgeHTML()`, independente do plano), então
continua aparecendo do mesmo jeito depois do v218 e não deve ser
confundido com resíduo do nome antigo.

## v220 — Remoção total do sistema de código de migração VIP (dono, 20/09/2026)

**Ordem do dono** (texto exato): *"delete o sistema de codigo de
imigração de todo site, nao vai ter mais isso"*. O sistema de códigos
de migração VIP do site antigo (implementado no v206, 19/09/2026— ver
seção acima, preservada como registro histórico) foi removido por
completo — não existe mais em NENHUM lugar do site.

**O que saiu** (server.js): rota `POST /api/vip/resgatar-codigo`
(resgate pelo usuário), `GET/POST /api/admin/migracao-codigos` e
`POST /api/admin/migracao-codigos/excluir` (painel admin); `DB_MIGRACAO_
CODES`, `MIGRACAO_CODES_FILE` (`migration_codes.json`) e todo o load
de boot; os helpers `_migGerarCodigo`, `_migNormCodigo`,
`_migEmailDaConta`, `MIG_PLANOS`, `_migVisao`, `_migCriarCodigo`; o
hook de teste `d.emailContato` em `/api/test/login` (só existia pra
testar essa identidade — `emailContato` em si, o campo de verdade do
cadastro v175, continua intocado e usado em vários outros lugares).

**Front** (app.js): função `resgatarCodigoMigracao()` e as 8 chaves
`mig_*` do `LANG_DICT` nas 3 línguas. **Landing** (index.html): o
`<details id="mig-card">` inteiro (resumo, input, botão, mensagem) que
ficava na aba Planos, logo abaixo do card de status do plano. **Admin**
(admin.html): o item da sidebar "Códigos de migração", a view
`#view-migracao` inteira (3 painéis: criar código, importar em lote,
lista com busca), o CSS `.mig-grid`, e as funções `loadMigracao`/
`renderMigracao`/`_migLerForm`/`migCriar`/`migImportar`/`migExcluir`/
`migMensagem`/`migCopiarMsg` — `NOME_PLANO_ADM` (dicionário de nomes do
v218) ficou, porque outras 6 telas do admin dependem dele.

**PROIBIDO**: reintroduzir qualquer parte deste sistema (rota, tela,
banco `migration_codes.json`, texto "código de migração") sem ordem
EXPRESSA e NOVA do dono — a seção v206 acima descreve a implementação
ORIGINAL, histórico, não o comportamento atual.

Testes: os ~20 checks do v206 no smoke saíram junto com o código que
testavam (nunca faz sentido manter teste de feature que não existe
mais). Varredura de repositório inteiro (grep por `migracao`,
`migração`, `mig_`, `resgatarCodigoMigracao`, `DB_MIGRACAO`) confirmou
ZERO referência restante em qualquer arquivo `.js`/`.html`. `npm test`
100% verde (mesma contagem de checks estruturais menos os removidos).
sw.js bumpado (v82→v83).

## v221 — 2 achados da auditoria ao vivo pós-v220 (dono, 20/09/2026)

O dono testou o site publicado inteiro (todas as abas de usuário e
admin) depois do v220 e reportou 4 pontos. 2 eram correções reais; 1
já estava certo (documentado abaixo pra não ser reinvestigado à toa);
1 é só um lembrete sem ação (robôs de planilha manuais desde o v217).

**1) Badge "🌱 Aquecendo — 276/15 hoje" no Gmail do admin, sem
sentido.** Causa raiz: `_warmupBadgeHTML()` (app.js) mostra o teto por
dia-tier do aquecimento (15/40/100 — regra 13a/13a2, pensado pro
CLIENTE) igual pra admin, cujo teto FUNCIONAL de verdade é outro
(`ADMIN_AUTO_DAILY_LIMIT_PER_SENDER=450`/dia por Gmail, mostrado à
parte em "Configurações de Admin"). O número em si não era falso — o
Gmail realmente tinha poucos dias desde `gmailConnectedAt` — só a
MÉTRICA era a errada pra admin: 276 dentro de 450 é normal (regra
13a2: aquecimento nunca pausa envio), mas exibido como "276/15" parece
um teto furado. Corrigido: pra `U.isAdmin`, o selo mantém a
transparência (nunca some — regra 13a) mas troca a fração enganosa por
um texto que diz o que é de verdade (preferência de rodízio, não
trava; aponta pro teto real mostrado acima). Cliente comum não muda em
nada.

**2) Label "VIP Infinito · Máximo" no card de admin, sem sentido.**
Achado confirmado pela versão em inglês do mesmo texto —
`"Unlimited VIP · Máximo"` — uma combinação que não faz sentido em
lugar nenhum (por que o status ilimitado do admin teria o nome de um
plano de CLIENTE colado?). Era sobra do rename mecânico
"DoublePro"→"Máximo" do v218, que bateu numa string que já não devia
ter essa parte. A linha logo abaixo já explica os limites reais do
admin em prosa ("Sem expiração · 450 envios/dia..."), então "· Máximo"
não acrescentava informação — só sugeria (errado) que o status do
admin depende do plano Máximo dos clientes. Corrigido: `pf_vip_infinito`
virou só "VIP Infinito" (e "Unlimited VIP" em EN) nas 3 línguas +
fallback estático do index.html.

**3) Botão "Baixar App" sem feedback — investigado, NÃO é bug.**
`installAppClick()` (app.js, v110) já cobre exatamente isso: app já
instalado avisa; iPhone mostra "Compartilhar → Adicionar à Tela de
Início"; Chrome/Android sem prompt nativo mostra "menu ⋮ → Instalar
aplicativo". `toast()` e o container `#tw` conferidos, sem nenhum
caminho que fique mudo sem erro de JS. Explicação mais provável do que
o dono viu: o navegador de teste capturou o `beforeinstallprompt`
nativo do Chrome, que é um diálogo do SISTEMA OPERACIONAL (fora do DOM
da página) — não aparece como "mensagem do site". Nenhuma mudança de
código feita aqui; registrado pra não reinvestigar à toa.

Testes: `npm test` 100% verde, `check-duplicates.js` e
`check-xss-guard.js` sem achados. sw.js bumpado (v83→v84).

## v222 — Título de vaga com código SOC cortado na fonte do DOL (dono, 20/09/2026)

Continuando a mesma varredura ao vivo do v221, o dono achou 8
candidaturas já enviadas (aba Enviadas > Automático) com o MESMO
título cortado no meio da palavra: `"49-9098: Helpers—Installation,
Maintenance, and Repair Worke"` (faltando "rs").

**Causa raiz**: quando o empregador não dá um título próprio, o DOL
publica o `job_title` como "CÓDIGO SOC: nome oficial da ocupação" — e
esse registro específico chegou assim JÁ CORTADO na fonte (exatos 60
caracteres, largura clássica de campo antigo do sistema do DOL). Não é
bug do nosso import: `row.t = String(dol.job_title).trim()`
(mod-planilhas.js) só copia o que o DOL manda, sem truncar nada.
Verificado o código SOC 49-9098 contra fontes oficiais — [BLS
OES](https://www.bls.gov/oes/current/oes499098.htm) e [O*NET
OnLine](https://www.onetonline.org/link/summary/49-9098.00) — ambas
confirmam "Helpers--Installation, Maintenance, and Repair Workers".

**Correção** (server.js): `_selfHealTitulosTruncados(label, rows)`,
chamada de `loadSheets()` logo depois de `_selfHealCidades` (mesmo
padrão, mesmo ponto — jan2026/jul2025/H-2A e cada planilha extra) —
roda no BOOT, nunca no upload. Detecta título com prefixo `CÓDIGO
SOC: ` e: (a) se o código está no mapa `_SOC_TITULOS_OFICIAIS`
(verificado contra fonte oficial), completa com a grafia oficial; (b)
se o título tem exatamente 60 caracteres mas o código NÃO está
verificado, só REGISTRA no log (`[sheet] 🔎 ...`) pro admin conferir —
nunca inventa nome de ocupação. Só toca o campo `t` da vaga na
planilha; histórico de candidaturas já enviadas (`h`/`DB_HIST`) fica
100% intocado, como pedido.

**Escopo desta entrega**: só o código 49-9098 (o único achado ao vivo)
tem correção automática; qualquer outro título com a mesma assinatura
de corte (60 caracteres, prefixo SOC) vai aparecer no log do boot pra
o admin decidir — adicionar o código verificado ao mapa quando
aparecer um novo caso é a forma de estender.

Testes: 3 checks novos no smoke (v199-L19, dentro do ciclo de 2º boot
já existente — sobe a planilha "titulo-teste" com 1 caso verificado e
1 não-verificado, mata o servidor, sobe de novo e confere que só o
verificado foi completado, o outro ficou intocado e os dois aparecem
no log). `npm test` 100% verde, `check-duplicates.js`/
`check-xss-guard.js` sem achados. Sem bump de sw.js (só server.js e
smoke-test.js mudaram — nenhum arquivo servido ao cliente).

## v223 — Aba "Vagas ao Vivo" removida por completo: site só usa planilhas (dono, 20/09/2026)

Ordem expressa do dono: *"faz melhor, aba ao vivo exclui, não quero
mais dados ao vivo do dol. exclui tudo que tem haver com ela, a partir
de agora só planilhas ok?"*. Isso substitui de vez a tentativa de
corrigir o bug de ordenação (`$orderby` do DOL sempre devolvia por
`dhTimestamp`, ignorando o modo pedido) — em vez de consertar a
ordenação da busca ao vivo, a busca ao vivo inteira deixou de existir.
**Não afeta** os robôs periódicos de coleta de planilha
(mod-planilhas.js, feed ZIP via `DOL_FEED_BASE`) — esses continuam
existindo normalmente e são a ÚNICA fonte de vaga do site a partir de
agora.

**Removido do servidor (server.js)**: o bloco inteiro da "DOL API"
(`jobsCache`/`jobsTotal`/`lastFetch`/`CACHE_TTL`/`refreshCache`,
`FALLBACK_JOBS`, `normJob`, `DOL_API_BASE_SRV`, `_dolApiGet`,
`fetchDOL`, `fetchByCase`, `sheetCache`/`SHEET_TTL`, o bloco de rate
limit `_dolRateLimited`); as rotas `/api/jobs`, `/api/sheet-detail` e
`/api/sheet-batch` inteiras (a última incluía o efeito colateral de
"e-mail descoberto no clique" gravado na planilha — sem consulta ao
vivo, esse caminho não existe mais); os 2 `setInterval`/`setTimeout`
que chamavam `refreshCache`; os campos `jobsCached`/`jobsTotal`/
`jobs_cached` de `/api/admin/stats`, do status ao vivo do admin e de
`/api/debug`; `https://api.seasonaljobs.dol.gov` saiu do `connect-src`
do CSP (nenhum JS de navegador chamava mais). Servidor não faz mais
NENHUMA chamada HTTPS direta ao DOL — essa conversa mora só em
mod-planilhas.js.

**Removido do front (app.js)**: a aba inteira (`JOBS`, `skip`/`total`/
`loading`/`done`, `mkCard(j)`, `selJob2(id)`, `loadJobs()`,
`enrichSheet()`/`updSheetCard()` — o enriquecimento em lote que
rodava depois de carregar a lista de planilha morreu junto, já que
não tinha mais pra onde mandar), `_sentSeasonal`/`_isSentSeasonal` e
todo o sistema `_vfLive()` (~15 pontos do motor de filtros que tinham
um branch "aba ao vivo": `vfAtivos`, `vfFetch`, `vfRefresh`, `vfSet`,
`_vfBuildSecs`, `_vfRenderSecs`, `_vfSyncSortBtns`, `vfRenderChips`,
`vfCountManual`), as 2 seções de filtro exclusivas da aba ao vivo
("Tipo de visto"/"Status da vaga") e as chaves de tradução mortas
(`vf_live_note`, `vf_sec_tipo`, `vf_sec_ativa`, `vf_ativas_lbl`,
`seasonal_jobs`) nas 3 línguas. `selSheetJob(cn)` (detalhe de vaga da
planilha) deixou de ser assíncrono — antes ele fazia round-trip pro
servidor pra "enriquecer" a linha; agora é 100% síncrono, lendo só o
que já está em `sCache`/`sJobs` (cache local + o que `/api/sheet-meta`
já trouxe), porque não existe mais nenhuma fonte de vaga fora da
planilha carregada. Aba inicial default trocou de `"seasonal"` pra
`"jan2026"`. Achado e corrigido no meio da remoção: `limitUpsell()`
lia o global `total` (exclusivo da aba removida, ia ficar travado em
0 pra sempre) — redirecionado pra `sTotal`, o total real da planilha,
senão a mensagem de "ainda restam N vagas hoje" ficaria sempre no
texto genérico.

**Removido do HTML (index.html)**: o botão-aba `#stab-seasonal`
("Vagas ao Vivo"); a aba `Jan 2026` virou a primeira/ativa por padrão.

**Testes (smoke-test.js)**: removidos os testes exclusivos da busca ao
vivo (dedup de cache do `/api/jobs`, escaping de aspas no `$orderby`
OData, descarte de injeção no `/api/sheet-batch`, as leituras de
`/api/sheet-detail` no teste de mascaramento de e-mail v182-L10) —
mantidos os testes que usam a MESMA infraestrutura de DOL falso do
harness mas para os robôs de planilha que continuam vivos (`/proxy`
404, fila educada do robô de enriquecimento). 4 checks corrigidos por
ficarem stale com a remoção (não apontavam bug nenhum, só citavam
código/trecho que mudou de forma ao ficar mais simples): a guarda de
XSS v205-L23 não exige mais `${esc(job.workers)}` (era do card da
aba removida); o contador de filtros ativos v181-L5 casava
`else if(st.email)n++` e virou `if(st.email)n++` (a única razão pro
`else` existir era o branch da aba ao vivo, que sumiu); o teste de
gzip v140 passou a ler `mod-planilhas.js` em vez de `server.js`,
porque é lá que mora agora — e só lá — toda conversa HTTP com o DOL.

Testes: `npm test` 100% verde (722 checks), `check-duplicates.js`/
`check-xss-guard.js` sem achados. sw.js bumpado (v84→v85).

## v224 — 3 bugs reais do modal "Filtrar vagas" (dono, 20/09/2026 — teste de robustez manual)

Auditoria manual real do dono no modal de filtros (dezenas de
combinações, resultado geral bom) achou 3 bugs reais e pediu pra
registrar e corrigir sem pressa. Investigados e corrigidos os 3.

**1) "Limpar tudo" pequeno (chip fora do painel) parecia não fazer
nada.** Causa raiz: existiam DUAS funções de limpar filtro que nunca
se falavam — `vfClearDraft()` (botão do cabeçalho do painel) só
zerava `VF.draft` (o RASCUNHO que a pessoa está editando com o
painel aberto); `vfClear(ctx)` (chip fora do painel / tela de
resultado vazio) só zerava `VF.st[ctx]` (o filtro JÁ APLICADO). Quem
limpava por um lado e reabria/aplicava pelo outro via a seleção
"ressuscitar". Corrigido: as duas agora zeram os DOIS estados —
`vfClearDraft()` também zera `VF.st[ctx]`; `vfClear(ctx)` também zera
`VF.draft` quando o painel está aberto no mesmo contexto.

**2) "Limpar tudo" do cabeçalho às vezes ficava preso mostrando a
contagem do filtro anterior** (caso real do dono: escolheu Michigan,
clicou Limpar tudo, ficou "Ver 476 vagas" com a Experiência ainda
contando como se Michigan estivesse marcado — só um 2º clique
resolvia). Causa raiz: `vfFetch()` tinha UM contador de sequência só
(`VF.seq`) compartilhado entre a contagem AO VIVO do painel aberto
(`vfRefresh`→rascunho) e a contagem do filtro JÁ APLICADO fora do
painel (`vfCountManual`/`vfAutoCount`) — uma chamada de QUALQUER um
dos dois motivos incrementava o contador global, então a resposta
fresca e correta de um motivo podia ser descartada como "antiga" só
porque o OUTRO motivo tinha disparado uma chamada depois. Corrigido:
`vfFetch` agora distingue os dois motivos (`st` preenchido = painel;
ausente = já-aplicado) e usa contadores separados (`VF.seq`/
`VF.seqAplicado`) — um nunca mais descarta a resposta do outro.

**3) Apóstrofo sozinho no campo "Palavra-chave" devolvia "Ver 0
vagas"** — mas uma vaga real pode ter apóstrofo no nome da empresa
("Olson's Greenhouses of Colorado, LLC"), então isso estava errado.
Digitar algo como `' OR 1=1` NÃO reproduziu nenhuma quebra de
verdade (nem no servidor, testado direto por HTTP com várias
variações do texto, nem no navegador de verdade, testado com
Playwright/Chromium digitando o texto real dentro do campo) — o
back-end nunca monta SQL nem regex cru a partir da busca (o valor só
passa por `.includes()`/`.filter()` de string já sanitizada), e o
dono confirmou que não houve execução de script nenhuma. Causa raiz
do "0 vagas" confirmada e corrigida: `_normSearch()` (server.js)
remove acento/apóstrofo/pontuação de propósito pra "Marthas" casar
com "Martha's" (v62) — mas uma busca que é SÓ pontuação normaliza
pra STRING VAZIA, e o código tratava isso como "buscar por nada"
(`alvos=[]` incondicional, `direct=[]`), devolvendo zero em vez de
ignorar a busca. `searchSheet()` agora checa explicitamente: sem
NENHUM caractere de busca sobrando depois de normalizar, a busca é
ignorada (mesmo resultado de campo vazio) — nunca finge ter
encontrado zero. Uma busca com letras de verdade que não bate com
nada continua devolvendo 0 honesto (não é o mesmo bug).

Testes: 6 checks novos no smoke (2 estruturais pro `vfClear`/
`vfClearDraft`, 1 estrutural pro `vfFetch` com contadores separados,
1 estrutural pra guarda de busca vazia em `searchSheet`, 2
comportamentais confirmando que busca-vazia-após-normalizar é
ignorada e busca-com-letra-real-sem-match continua zerando de
verdade). `npm test` 100% verde, `check-duplicates.js`/
`check-xss-guard.js` sem achados. sw.js bumpado (v85→v86).

## v225 — 2 achados do dono testando ao vivo (20/09/2026)

**1) Erro técnico cru na tela de login logo depois de um deploy.**
Causa raiz: das 6 funções do portão de autenticação (login, cadastro,
enviar código de e-mail, confirmar código, enviar código de
recuperação, redefinir senha), só `agSubmitLogin` e a submissão do
cadastro (`agSubmitSignup`) faziam `await r.json()` sem nenhuma
proteção — as outras 4 já tratavam isso com `.catch(()=>({}))`. Num
restart do Render (deploy em andamento), a API pode responder com a
página de erro HTML do proxy em vez de JSON, e `r.json()` cru lança
`SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid
JSON` — esse erro técnico aparecia direto pro usuário. Criada função
única `_agReadJson(r)` (app.js), usada pelas 6 funções: se a
resposta não é JSON de verdade, lança uma mensagem honesta ("O
servidor está reiniciando... espere alguns segundos e tente de
novo.") em vez do erro cru; se é JSON de erro normal (senha errada,
código inválido), segue pro `d.error` de sempre.

**2) Central de Tutoriais prometia foto em todo item, mas só 6 de 20
têm.** O cabeçalho dizia "20 passo a passos **com fotos reais**" —
mas só 6 dos 20 itens (`tutorial-conteudo.html`) têm captura de tela
de verdade (9 imagens reais, todas confirmadas existindo em disco);
os outros 14 são só texto — um comentário no próprio index.html já
registrava "fotos reais entram numa tarefa futura". Texto corrigido
nas 3 línguas (dicionários) + no fallback estático do index.html:
"20 passo a passos — tudo o que dá pra fazer no H2BApply, explicado
tela por tela (vários já com fotos reais)" — verdade tanto hoje
quanto depois que mais fotos forem adicionadas.

**3 auditorias em paralelo** (subagentes normais — o dono negou o
Workflow orquestrado por ser pesado demais pra esta rodada) varreram
o site inteiro por dimensão (envio/automação, pagamento/painel admin,
segurança/confiabilidade) e voltaram com 10 achados reais. Cada um
será verificado individualmente antes de virar correção — registro
deles entra nas próprias seções de correção, à medida que forem
aplicados.

Testes: `npm test` 100% verde, `check-duplicates.js`/
`check-xss-guard.js` sem achados. sw.js bumpado (v86→v87).

## v226 — achado CRÍTICO das 3 auditorias paralelas: reuso de comprovante furava a ativação automática (20/09/2026)

Das 3 auditorias em paralelo do v225 (pagamento/admin), o achado #1 era
o mais grave: o comprovante Pix reaproveitado (mesmo arquivo OU mesma
transação E2E) em uma conta DIFERENTE só era barrado na aprovação
MANUAL do admin (`PATCH /api/pedido/:id`) — a ativação PROVISÓRIA
AUTOMÁTICA (`preCheckComprovante`→`autoAtivarProvisorio`, dispara sozinha
na hora que o pedido é criado, sem nenhum humano olhar) só conferia o
VALOR lido, nunca hash/transação. Pior: o comentário acima de
`autoAtivarProvisorio` já dizia "comprovante reusado nunca chega aqui"
— isso era FALSO, nenhuma checagem real existia nesse caminho. Um
comprovante Pix de verdade (foto/print do mesmo pagamento) reaproveitado
em contas novas (Gmail diferente, mesmo arquivo) conferia "CONFERE" e
ganhava 3 dias de VIP na hora, de graça, indefinidamente (cada conta
nova repetia o golpe).

**Correção (função única):** a checagem que já existia só na rota manual
virou `_comprovanteJaUsado(pd)` (server.js, logo antes de
`preCheckComprovante`) e passou a ser chamada nos 3 lugares que decidem
"já foi usado?": a aprovação manual do admin (refatorada pra usá-la) e
os 2 pontos de `preCheckComprovante` que chamam `autoAtivarProvisorio`
(gancho de teste `TESTE_COMPROVANTE:` e o caminho real do Gemini) — se
`_comprovanteJaUsado` encontra outro pedido com o mesmo hash/transação,
a ativação automática é pulada (`console.warn`, fica pendente de
conferência manual) em vez de rodar.

**2ª camada do mesmo bug, achada escrevendo o teste de regressão:** a
função original só considerava "usado" um pedido com status
`pago`/`ativo`/`cancelado` — mas a ativação AUTOMÁTICA nunca muda
`pd.status` (o pedido fica "pendente" pra sempre, só o VIP do usuário é
que liga). Um 1º pedido só auto-ativado (nunca aprovado manualmente
depois) não batia nesse filtro, então um 2º pedido com o MESMO
arquivo/transação ainda passava e auto-ativava de novo — reuso
automático→automático intacto mesmo depois do primeiro fix. Corrigido
adicionando `||x.autoAtivado` ao filtro de status — nenhuma 2ª lógica,
só cobrindo o caso que faltava na mesma função.

Testes: 3 checks novos no smoke (1ª vez que a transação aparece ativa
normal; 2ª vez em conta nova NÃO ativa mais sozinho, pedido fica
pendente sem `ativadoEm`/`autoAtivado`, preCheck continua mostrando
CONFERE; estrutural confirmando as ≥4 chamadas de `_comprovanteJaUsado`
no server.js). O 2º achado (status `autoAtivado`) só apareceu porque o
próprio teste de regressão rodou contra o fix antes de eu confiar nele —
lição: testar o caminho que a correção deveria fechar, não só declarar
que fechou. `npm test` 100% verde, `check-duplicates.js`/
`check-xss-guard.js` sem achados. Mudança 100% em server.js — sem
bump de sw.js (nenhum arquivo servido ao cliente mudou).

## v227 — achado Alta da auditoria (envio/automação) + achado do dono ao vivo (Planos) (20/09/2026)

**1) `pauseAuto`/`resumeAuto`/`stopAuto` (app.js) ignoravam a resposta do
servidor.** As 3 funções só faziam `await fetch(...)` sem nunca olhar
`r.status`/`d.ok` — um 401 (sessão caiu) ou 404 (job já não existe mais,
ex.: outra aba já tinha parado) ainda assim marcava "Pausado"/
"Retomado"/"Parado" na tela e mudava `U.autoJob` local, mentindo pro
usuário sobre o estado real do robô automático (achado Alta de uma das 3
auditorias paralelas do v225). Corrigido reusando `jsonSafe()` (helper
único do site pra resposta não-JSON, já usado em 4 outros pontos) + checagem
explícita de `d.ok` antes de qualquer mudança otimista de UI; em falha,
mostra "Sessão expirada" quando é o caso ou o erro real do servidor —
nunca mais assume sucesso só porque o `fetch` não lançou exceção.

**2) `loadPlanos()` às vezes mostrava "Não deu pra carregar os planos"
na 1ª entrada da página, mesmo com o servidor saudável** (achado do dono
testando ao vivo — clicar "Tentar de novo" carregava na hora, prova de
falha transiente, não do servidor). Mesma classe do bug de login do
v225: um fetch falhando por atraso/race na carga inicial caía direto no
estado de erro, sem nenhuma nova tentativa — só que aqui na página MAIS
importante do funil de pagamento, custando conversão. Corrigido com
retry automático (até 3 tentativas, pausa curta crescente entre elas,
usando `jsonSafe`) antes de mostrar o estado de erro pro usuário.

Testes: 2 checks estruturais novos no smoke (pause/resume/stop usam
`jsonSafe`+`d.ok`; `loadPlanos` tem o loop de retry) — sem UI em
Chromium nesta suíte, a garantia aqui é de código-fonte, não
comportamental. `npm test` 100% verde, `check-duplicates.js`/
`check-xss-guard.js` sem achados. sw.js bumpado (v87→v88).

## v228 — achado Alta da auditoria (pagamento/admin): banir e-mail era decorativo (20/09/2026)

`DB_BLOCKED.emails` é gravado por `/api/admin/ban-email` e pelo
`banir:true` de `/api/admin/delete-user` — mas até aqui NENHUMA rota de
cadastro ou login olhava essa lista pra valer. Na prática, um admin
banir um Gmail não impedia nada: a mesma pessoa recriava conta na hora,
com o MESMO Gmail de contato, só trocando o username (que é livre e
sem relação com o e-mail). O único consumo real da lista era um aviso
de diagnóstico dentro de uma rota de revisão de usuários — nunca uma
recusa de verdade em cadastro/login.

Corrigido no `/api/cadastro`: checagem explícita de
`DB_BLOCKED.emails.includes(email)` logo após validar que o e-mail é um
Gmail (antes até de gastar o código de verificação da pessoa à toa) —
403 com mensagem clara e o WhatsApp de suporte pra quem acha que foi
engano. Escopo deliberadamente contido: não mexi em `/api/login` (a
identidade de login é o `username`, não o e-mail de contato — o desvio
real que a auditoria descreveu é "recriar conta com o mesmo e-mail",
que é exatamente o caminho fechado aqui) nem no fluxo de conectar Gmail
de envio via OAuth (feature mais ampla, fora do achado original — fica
pra uma auditoria futura se o dono quiser essa camada extra).

O achado irmão da mesma auditoria ("não existe UI de ban/delete no
admin.html") **não foi tratado como bug**: o próprio smoke-test.js já
documentava isso de propósito desde o v153 ("admin.html enxuto não tem
UI de Auditoria/ban... a rota real é a parte que importa aqui") — é uma
decisão de produto da reconstrução deste repo (admin mais enxuto), não
um esquecimento. Fica registrado aqui caso o dono queira essa UI de
volta no futuro.

Testes: regressão ponta a ponta no smoke (banir → código de verificação
confirmado → cadastro é recusado mesmo assim com 403 → desbanir → o
MESMO e-mail volta a cadastrar normal). `npm test` 100% verde,
`check-duplicates.js`/`check-xss-guard.js` sem achados. Mudança 100%
em server.js — sem bump de sw.js.

## v229 — achado Alta da auditoria (segurança/confiabilidade UX): reset de Enviadas mentia sobre o resultado (20/09/2026)

`doClearHist()` (botão "Resetar" da aba Enviadas e do atalho dentro do
Automático — mesmo motor, `/api/history/clear`) fazia tudo isso ANTES
de chamar o servidor: zerava `APPLIED`/`HIST` locais, fazia todas as
vagas reaparecerem na lista e mostrava "Resetado ✓". O `fetch` de
verdade só vinha DEPOIS, dentro de um `catch{}` vazio — uma falha real
(sessão caída, rede, erro 500) deixava a pessoa convencida de que
resetou, com o histórico do servidor intocado por baixo. Cenário
concreto: a próxima tentativa de reenviar manualmente pra uma empresa
"liberada" na tela batia no bloqueio de duplicata de verdade (regra 8,
servidor-autoritativo) sem explicação nenhuma pro usuário.

Corrigido invertendo a ordem: o servidor confirma PRIMEIRO (`jsonSafe`
+ checagem de `d.ok`, mesmo padrão do v227/v228) — só em caso de
sucesso a tela muda e o toast de sucesso aparece; em falha, mostra o
erro real (ou "sessão expirada") e não mexe em nada local, deixando o
usuário tentar de novo com o estado real intacto. Como a função agora
pode "não resetar" de verdade, ela passou a devolver `true`/`false`;
`doResetAuto()` (o atalho da aba Automático) só mostra a dica de
próximo passo ("toque em Começar") quando o reset realmente aconteceu
— antes ela aparecia mesmo em cima de uma falha silenciosa.

Testes: 2 checks estruturais novos no smoke (ordem fetch-antes-mutação
sem catch vazio no fetch; `doResetAuto` condicionado ao retorno) — sem
UI em Chromium nesta suíte. `npm test` 100% verde, `check-duplicates.js`/
`check-xss-guard.js` sem achados. sw.js bumpado (v88→v89).

## v230 — achado Média da auditoria (envio/automação): remetente manual bloqueado caía pro principal em silêncio (20/09/2026)

O round-robin do envio AUTOMÁTICO já filtrava contas com `blocked:true`
(suspensas pelo Google, regra 13a3) do seu pool — mas o envio MANUAL
com remetente ESCOLHIDO explicitamente pelo usuário (`getSenderToken`,
ramo `requestedSender`) nunca checava esse campo: tentava renovar o
token de uma conta suspensa, a renovação falhava, e o `catch` genérico
do `/api/send` trocava pro Gmail principal SEM avisar — o usuário via
"candidatura enviada" achando que saiu pela conta que ele escolheu.
Some com isso duas frentes do mesmo achado: (1) o dropdown "Enviar
por" do modal de envio manual (app.js) filtrava `tokenExpired` mas
esquecia `blocked` — diferente das outras 3 telas do site que já
listam remetentes elegíveis corretamente com os 2 filtros juntos — e
deixava a pessoa ESCOLHER uma conta suspensa; (2) mesmo se a tela
mostrasse (cache velho, outro aparelho), o servidor aceitava a escolha
e substituía em silêncio.

Corrigido nas duas pontas: `getSenderToken` agora lança uma sentinela
própria (`SENDER_BLOCKED`, mesmo padrão já usado por
`WARMUP_CAP_REACHED`) assim que encontra `s.blocked===true`, ANTES de
tentar qualquer renovação de token; a rota `/api/send` reconhece essa
sentinela e devolve 409 com uma mensagem clara ("conta bloqueada pelo
Google, escolha outro remetente ou reconecte") em vez de mandar pelo
principal sem avisar. O dropdown do modal ganhou `&&!x.blocked` no
filtro, igual às outras telas.

Testes: 1 check estrutural (filtro do dropdown) + 1 comportamental
ponta a ponta usando o Gmail falso da suíte (usuário com plano pago +
remetente extra `blocked:true` → escolhe esse remetente no envio manual
→ recebe 409 `senderBlocked:true` → **zero** e-mails saíram pelo Gmail
falso, provando que não caiu pro principal em silêncio). `npm test`
100% verde, `check-duplicates.js`/`check-xss-guard.js` sem achados.
sw.js bumpado (v89→v90).

## v231 — achado do dono testando ao vivo: badge "Currículos 1" mentindo enquanto a tela dizia "nenhum perfil" (20/09/2026)

O dono testou uma conta real com 326 candidaturas automáticas enviadas
e viu o badge da aba Currículos mostrando "1" enquanto o corpo da
página dizia "Nenhum perfil criado ainda". Ele mesmo suspeitou —
corretamente — que fosse a mesma família dos bugs de carregamento já
corrigidos em Planos (v227b) e login (v225): um fetch falhando em
silêncio e caindo pro estado vazio sem retry.

**Causa raiz confirmada**, achada lendo o código: 4 lugares deste
arquivo buscavam perfis frescos do servidor (`loadProfilesView` — a
Currículos em si —, `_renderAutoProfilesPanel`, `openAutoModal` e o
"recarrega perfis" dentro de `stopAuto`) e TODOS faziam
`UPROFILES=pr.profiles||[]` sem checar se a resposta veio de verdade.
`GET /api/profiles` devolve `{error:"..."}` (SEM campo `profiles`) num
401 de sessão caída — e como `pr.profiles||[]` trata qualquer coisa
sem esse campo como array vazio, uma sessão velha (deploy reiniciou,
aparelho ficou minutos parado — sessão NÃO sobrevive a restart, decisão
intencional da casa) virava silenciosamente "você tem 0 perfis",
sobrescrevendo `UPROFILES` e, em 3 dos 4 lugares, `U.profiles` TAMBÉM.

Como o Envio Automático é a tela que esse usuário mais abre (326
candidaturas!), bastava abrir esse modal com a sessão velha pra
corromper os dois. O badge, pintado numa checagem ANTERIOR (que já usa
o fallback `U.profiles`, código único que só faltava aqui), ficava com
o número certo "1" — congelado, sem se atualizar de novo. A tela de
Currículos (`renderProfiles()`), sem nenhum fallback, lia o `UPROFILES`
já corrompido e mostrava vazio. Os dois nunca "mentiram" sozinhos — só
ficaram dessincronizados por uma falha silenciosa em outro lugar.

**Correção (fonte única):** nova função `_refreshProfiles()` — só
aceita a resposta do servidor quando `profiles` é de fato um `Array`
(nunca um erro genérico/401); em qualquer outro caso, MANTÉM o último
dado bom conhecido e devolve `false` pro chamador decidir avisar. Os 4
pontos que faziam o fetch cru agora chamam essa função única — nenhuma
lógica duplicada. `renderProfiles()` ganhou o MESMO fallback pra
`U.profiles` que já existia em ~10 outros lugares do arquivo (contagem
do badge, gate de envio manual, painel do automático etc.) — auto-cura
`UPROFILES` a partir de `U.profiles` antes de decidir "nenhum perfil
criado", a última linha de defesa contra qualquer outro lugar que ainda
possa corromper o estado no futuro.

Testes: 3 checks estruturais no smoke (sem Chromium nesta suíte —
guarda de código-fonte: `_refreshProfiles` valida array antes de
aceitar; os 4 pontos chamam a função única; `renderProfiles()` faz a
auto-cura ANTES do estado vazio). `npm test` 100% verde,
`check-duplicates.js`/`check-xss-guard.js` sem achados. sw.js
bumpado (v90→v91).

## v232 — achado Média da auditoria (segurança/confiabilidade UX): excluir perfil fingia sucesso mesmo recusado (20/09/2026)

`deleteProfile()` descartava por completo a resposta do
`/api/profiles/delete` — nem olhava status nem corpo. O servidor
RECUSA (400) apagar o último perfil restante ("Você precisa de pelo
menos 1 perfil configurado. Edite-o em vez de apagar."), regra que
existe porque um usuário sem NENHUM perfil não tem assunto/corpo de
e-mail e o envio cairia no fallback genérico. Mesmo com essa recusa, a
função removia o card da tela, fechava o editor e mostrava "Perfil
excluído ✓" — o usuário achava que tinha apagado; na próxima vez que
`UPROFILES` fosse recarregado (ex.: reabrindo a página, ou pelo
`_refreshProfiles()` do v231), o perfil REAPARECIA sozinho, parecendo
um bug de sincronização quando na verdade a exclusão nunca aconteceu.

Corrigido com o mesmo padrão já usado em `pauseAuto`/`resumeAuto`/
`stopAuto` (v227) e `doClearHist` (v229): `jsonSafe(r)` + checagem
explícita de `d.ok` ANTES de qualquer mudança otimista na tela; em
falha, mostra o erro real do servidor (ou "sessão expirada") em vez de
fingir sucesso.

Testes: 1 check estrutural no smoke confirmando a ordem correta
(checagem de `d.ok` vem antes da mutação de `UPROFILES`). `npm test`
100% verde, `check-duplicates.js`/`check-xss-guard.js` sem achados.
sw.js bumpado (v91→v92).

## v233 — achado Média da auditoria (segurança/confiabilidade UX): /api/debug era público (20/09/2026)

`GET /api/debug` não tinha NENHUMA checagem de sessão/admin — qualquer
pessoa na internet, sem estar logada, conseguia consultar: total de
usuários cadastrados, quantas sessões estão ativas agora, quantos jobs
do envio automático estão rodando neste instante, o tamanho das
planilhas carregadas, o caminho do disco de dados (`DATA_DIR`) e se o
ambiente é produção ou não. Nada disso é catastrófico sozinho, mas é
inteligência de negócio/operação (crescimento de usuários ao longo do
tempo, volume real de envio) exposta de graça pra concorrente ou bot
curioso — e a varredura confirmou ZERO telas do site chamando essa
rota (nem app.js, nem admin.html, nem index.html): não existe nenhum
uso legítimo público pra justificar deixá-la aberta.

Corrigido com a MESMA trava já usada pela rota irmã `/api/debug/export`
(que já era admin-only) — `getSes`+`isAdminEmail(_sessAdminEmail(s))`,
o padrão mais comum do arquivo pra "admin hardcoded" (25 outras rotas
já usam exatamente essa checagem). A rota continua existindo e útil
pro admin, só parou de ser pública.

Testes: 2 checks comportamentais no smoke (sem sessão → 403; com
sessão de admin → 200 com os campos esperados). `npm test` 100%
verde, `check-duplicates.js`/`check-xss-guard.js` sem achados. Mudança
100% em server.js — sem bump de sw.js.

## v234 — achado Média da auditoria (segurança/confiabilidade UX): reenviar comprovante sem rate limit (20/09/2026)

`POST /api/pedido/:id/comprovante` (o dono do pedido reenvia um
comprovante melhor quando a leitura da IA saiu ruim) não tinha NENHUM
rate limit — diferente de `/api/cadastro` e `/api/login`, que já
usam `rateLimit()` há tempos. Cada chamada bem-sucedida: grava até
~8MB de arquivo novo no disco (`saveComprovante`) E dispara
`preCheckComprovante(ativar:true)` de novo, que em produção chama a
API do Gemini pra reler o comprovante — custo real de cota de IA. Sem
trava nenhuma, um script hostil (ou até um bug de retry em loop no
cliente, a mesma classe de erro que este repo já corrigiu várias vezes
hoje) conseguia martelar a rota e gastar disco/cota à toa.

Corrigido com `rateLimit("comprovante_reenvio_"+s.user_email,5,
3_600_000)` — 5 tentativas por hora por usuário (autenticado, chave
por e-mail em vez de IP — evita falso positivo de gente atrás do
mesmo IP compartilhado), 429 com mensagem clara ao estourar. Generoso
o bastante pra alguém tentando de verdade uma foto melhor 2-3 vezes,
curto o bastante pra travar qualquer automação.

Testes: regressão comportamental no smoke (6 chamadas seguidas pro
mesmo pedido — a 6ª leva 429). `npm test` 100% verde,
`check-duplicates.js`/`check-xss-guard.js` sem achados. Mudança 100%
em server.js — sem bump de sw.js.

## v235 — achado Baixa da auditoria (pagamento/admin): veredito código morto (20/09/2026 — FECHA os 10 achados das 3 auditorias)

O allowlist de "leitura ruim" na aprovação manual de pedido
(`["DIVERGENCIA","ILEGIVEL","SEM_COMPROVANTE"]`) incluía um 3º
veredito que nunca existiu de verdade — `_geminiComprovanteParse`
(leitura real da IA) e o gancho de teste (`TESTE_COMPROVANTE:`) só
produzem `ERRO`/`ILEGIVEL`/`CONFERE`/`DIVERGENCIA`. Confirmado por grep
completo: nenhuma outra linha do arquivo jamais atribuía esse veredito
a `preCheck.veredito`. E mesmo que existisse, o cenário que o nome
sugere ("pedido sem comprovante nenhum") já é coberto de outro jeito —
`preCheckComprovante` nunca roda sem `_compB64`, então `pd.preCheck`
simplesmente fica `null`/undefined, e a checagem já é `_pc&&[...]`
(curto-circuita antes de olhar a lista). Removido — código morto puro,
zero mudança de comportamento observável.

Testes: guarda estrutural permanente no smoke (a string não pode mais
aparecer em lugar nenhum do server.js). `npm test` 100% verde,
`check-duplicates.js`/`check-xss-guard.js` sem achados. Mudança 100%
em server.js — sem bump de sw.js.

**Com este achado fecham os 10 confirmados pelas 3 auditorias
paralelas do v225** (envio/automação, pagamento/admin, segurança/
confiabilidade UX): v226 (Crítica), v227+v230 (Alta/Média, envio),
v228 (Alta, ban), v229 (Alta, reset), v232 (Média, excluir perfil),
v233 (Média, /api/debug público), v234 (Média, rate limit) e este
v235 (Baixa). Junto com os 4 achados do dono testando ao vivo (v225
login+tutorial, v227b Planos, v231 badge de Currículos), são 14
correções reais entregues nesta sessão, todas testadas e no ar.

## v236 — achado Crítica de uma 2ª rodada de 3 auditorias (perfil/onboarding): boot do site inteiro deslogava usuário pagante em falha isolada (20/09/2026)

Depois de fechar os 10 achados da 1ª rodada de auditorias, o dono
pediu pra investigar a tarefa "Varredura total" (#113) — que já estava
100% concluída (22 lotes, v183-v205, "fim da varredura" registrado) —
e continuar corrigindo o que fosse real. Abrimos uma 2ª rodada de 3
auditorias paralelas em áreas ainda não cobertas (painel admin/
dinheiro, perfil/onboarding, vagas/filtros/planilhas). O primeiro
achado, e o mais grave de todos os achados de hoje: `checkStatus()` —
a PRIMEIRA função que roda ao abrir ou recarregar o site inteiro —
fazia `const d=await r.json();` cru em `/api/status`, sem nenhuma
proteção contra resposta não-JSON (deploy reiniciando: o proxy devolve
HTML de erro, exatamente o cenário que motivou os fixes do v225/v227).
A exceção caía no `catch` da função inteira, que chamava
`showLanding()` incondicionalmente — um usuário PAGANTE, com sessão
válida, que desse F5 bem nessa janela de alguns segundos, via a tela
de cadastro/login como se nunca tivesse tido conta. Diferente das 6
funções do portão de autenticação (já protegidas desde o v225) e do
`loadPlanos()` (retry desde o v227b), esta — o ÚNICO ponto de entrada
de TODO o app, muito mais exposto que qualquer uma delas — nunca tinha
sido tocada.

Corrigido com o mesmo padrão já validado hoje: até 3 tentativas (com
pausa curta crescente) usando `jsonSafe`, ANTES de desistir e mostrar
a landing. Uma resposta de verdade dizendo "não conectado" continua
mostrando a landing imediatamente, sem retry nenhum — só falha real de
rede/parse é retentada.

Testes: 1 check estrutural no smoke (loop de retry presente, com
`jsonSafe` e o `return` antecipado quando todas as tentativas falham).
`npm test` 100% verde, `check-duplicates.js`/`check-xss-guard.js` sem
achados. sw.js bumpado (v92→v93).

## v237 — resto dos achados da 2ª rodada (painel-admin/dinheiro): a "2ª porta" pro plano de um cliente, promover admin sem trilha, e mais 4 jsonSafe (20/09/2026)

Continuando a 2ª rodada de 3 auditorias paralelas (v236 fechou o
achado de perfil/onboarding), esta leva fecha os achados restantes da
auditoria de painel-admin/dinheiro, mais os 4 últimos `fetch()` do
app.js que ainda faziam `r.json()` cru.

**1) `jsonSafe` nos 4 pontos que sobraram** (`_manualCdSave`, `doSend`,
`_removeSenderEmail`, `saveProfile`) — mesma classe do v227/v229/v230/
v232/v236: deploy reiniciando devolve HTML, `r.json()` cru estoura, e
em vez de "servidor reiniciando, tente de novo" o usuário via um erro
genérico (ou, no caso do `doSend`, o botão de enviar podia ficar preso
sem feedback nenhum). Com esses 4, não sobra mais `r.json()` cru
alcançável por um fetch de rota autenticada no app.js.

**2) `/api/admin/user/full-update` REMOVIDA — a "2ª porta" pro plano de
um cliente (Alta).** Rota do "Client Control Center" antigo, sem
NENHUM chamador em admin.html/app.js (confirmado por grep antes da
remoção) — mas continuava viva no servidor, então qualquer script ou
requisição direta ainda conseguia usá-la. Era estruturalmente perigosa
de um jeito que nenhuma outra rota de VIP é: diferente de
`vip/activate`, `set-plan` e `vip/set-expiry`, ela NUNCA chamava
`addCredito()` — dias de VIP dados por ela ficavam invisíveis no
extrato `vip.creditos`, e o Cérebro Contábil (auditarDias, régua 13r/
Cérebro 2.0-P1) acusaria esses dias como "sem origem" mesmo sendo uma
concessão legítima de admin — uma correção de fraude gerando uma
acusação FALSA. Também nunca chamava `logAdminAction` (invisível em
`/api/admin/audit`, irreversível pelo botão ↩️), não tinha trava de
duplo-clique, e não carimbava `vip.limits` (13o — usuário cairia na
tabela legada por engano). Os campos de "pagamento"
(`paymentAmount`/`paymentMethod`/`paymentReceiver`) eram 100%
decorativos: nunca tocavam `DB_FINANCEIRO.pagamentos`, nunca
apareciam em Total Recebido/Sócios/DRE/Conferência — um admin podia
preencher "R$250 · Pix" e ver `ok:true` achando que registrou uma
entrada no caixa que nunca existiu. Quem precisa ajustar dias usa
`vip/set-expiry` (que ganhou trava de idempotência no mesmo v237,
abaixo); quem precisa registrar pagamento usa a rota real de
contabilidade.

**3) `/api/admin/push-user` REMOVIDA (Média) — código morto puro.**
Validava `{email,title}` e devolvia `ok:true` sem NENHUM efeito
colateral — nunca gravava nada, nunca chamava `pushToUser`. Zero
chamador confirmado por grep. Deixá-la existindo era um risco: um
botão futuro conectado a ela pareceria funcionar (200 OK) sem nunca
avisar ninguém. A rota que funciona de verdade é `/api/admin/message`.

**4) `set-user-field` (campo `isAdmin`) exige admin HARDCODED (Alta).**
Promover/rebaixar outra conta pra admin só exigia `isAdminVip` — que
inclui `ADMIN_EMAILS_EXTRA` — igual qualquer campo bobo (nome,
telefone). Ou seja: qualquer admin auxiliar conseguia criar OUTRO
admin, sem nenhuma trilha (`logAdminAction`) e portanto invisível em
`/api/admin/audit` e irreversível pelo botão ↩️. Isso é mais sensível
que deletar conta, que já exige `isAdminEmail(_sessAdminEmail(s))` —
só os admins fixos (dono + Diego + a lista hardcoded), não a VIP. Agora
o campo `isAdmin` tem a mesma trava + fica registrado no audit trail.

**5) `vip/set-expiry` ganha a trava de duplo-clique (Alta).** Era a
ÚNICA rota que muda `vip.manualExpires`/`autoExpires` sem a proteção
`_adminVipActivateLock` que `vip/activate` (v18-FIX) e `set-plan`
(13r, caso Cleiton) já tinham. Como "definir vencimento exato" é um
`setUser` absoluto (não soma), um duplo-clique não dobrava os dias —
mas duplicava o `addCredito()` da linha do tempo (Cérebro 2.0-P1) e o
`logAdminAction`, inflando o teto explicável do auditor e poluindo a
auditoria com 2 entradas idênticas pra 1 ação só. Mesmo padrão de
trava, mesma janela de 5s.

Testes: 7 checks novos no smoke — 3 estruturais (jsonSafe nos 4
pontos; push-user sumiu; full-update sumiu) e 4 comportamentais
(admin não-hardcoded recusado no set-user-field isAdmin; admin
hardcoded consegue e fica no audit trail; 1º clique em set-expiry
funciona; 2º clique em seguida no mesmo usuário é bloqueado com 409).
`npm test` 100% verde (751 checks), `check-duplicates.js`/
`check-xss-guard.js` sem achados. sw.js bumpado (v93→v94).

