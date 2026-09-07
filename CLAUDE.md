# 📜 ORDENS PERMANENTES DO DONO — H2BApply

> Este arquivo é carregado automaticamente por toda sessão de IA neste
> repositório. **ANTES DE QUALQUER MUDANÇA: releia estas ordens e aplique
> todas.** Elas foram dadas por Andrio (dono) e valem para sempre, até ele
> revogar. Complementa a CONSTITUICAO_IA_H2BAPPLY.txt (Master Mode).

## 🔍 PROCESSO (como trabalhar — sempre)

1. **PESQUISE NA INTERNET ANTES de mudanças de UI/UX/funcionalidade** —
   analise como os sites/modelos de referência do mercado fazem (não precisa
   ser de H-2B). Padrão consagrado > invenção. Para conteúdo sobre vistos:
   só fontes oficiais (USCIS, DOL, Federal Register, travel.state.gov).
2. **Analise TODAS estas ordens a cada edição** — uma mudança nova não pode
   quebrar uma ordem antiga.
3. Entenda o site inteiro antes de agir; corrija na RAIZ, não o sintoma.
4. Dados de usuários já bugados são curados por **migração automática no
   boot** (idempotente, com log) — nunca "conserta pra frente e esquece o
   passado".
5. Teste DE VERDADE: `npm test` (sobe servidor real + fixtures) antes de
   todo commit; drills reais para o que for crítico (ex.: restauração de
   backup foi ensaiada, não presumida).
6. Commits em PT-BR contando o PORQUÊ, no padrão da casa. Nada de código
   morto, funções duplicadas (check-duplicates.js vigia), arquivos inúteis.
6b. **CEO Mode (dono, 22/07/2026)**: pensar como se o dinheiro fosse seu;
   nunca esperar instrução quando a melhoria é óbvia; "próximo" = escolher
   sozinho a melhoria mais importante e entregá-la completa. Prioridades:
   (1) brasileiros conseguirem empregos H-2B/H-2A, (2) assinaturas VIP,
   (3) automatizar tudo, (4) IA/bots, (5) painel admin, (6) velocidade,
   (7) segurança, (8) confiabilidade, (9) UX, (10) escala p/ milhões.
   SEO e monetização entram na régua de toda melhoria. Todo relatório
   explica: problema → solução → motivo → impacto → arquivos → testes.
   Régua de decisão (dono, 22/07): antes de implementar, questionar se há
   solução melhor; nomear os 3 maiores riscos; medir impacto em usuário
   novo E antigo + efeitos colaterais; preferir MAIOR impacto com MENOR
   risco; reduzir cliques; validar entradas; mobile e acessibilidade
   sempre; revisar o próprio trabalho antes de dar por encerrado.

## 🎯 PRODUTO (regras de comportamento — invioláveis)

7. **ZERO texto pré-preenchido**: o programa NUNCA escreve/insere
   assunto, corpo, template ou carta pelo usuário. Sem texto do usuário =
   envio pulado com aviso claro. (Ordem expressa: "não temos
   responsabilidade — quem faz isso é o usuário".)
8. **Duplicados são impossíveis**: vaga enviada OU na fila do automático
   NUNCA reaparece (nem manual, nem automático, nem busca sem aviso). A
   chave é o E-MAIL DO EMPREGADOR. Única exceção: usuário resetar enviados.
9. **Perfis por tipo de visto**: 1 H-2B + 1 H-2A no máximo; A VAGA MANDA
   no perfil; carta "Nenhuma" significa NENHUMA (nunca usar a de outro
   perfil); campo ausente herda, null explícito zera.
10. **Notificações**: só notícia nova SOBRE H-2B/H-2A (classificada) — push
    aos usuários + e-mail aos admins, 1x por notícia. Sem alerta genérico
    de anúncio. Bot da planilha randomizada hiberna (opt-in; lista só sai
    jan/jul).
10b. **E-mail (dono, 23/07/2026)**: o Gmail do Andrio serve SÓ pra avisar
    os admins de compras (pedido novo com comprovante). Usuário NUNCA
    recebe e-mail do sistema (nem robô parado, nem reengajamento, nem
    vencimento) — aviso a usuário é sempre por PUSH. sendNotifEmail é
    no-op incondicional e o reengajamento por e-mail foi desligado em
    definitivo; nenhum toggle religa.
11. **Aba Notícias**: anúncios do DOL desde jan/2026 traduzidos
    automaticamente + pesquisa diária da IA na internet (máx 2/dia, só
    novidade real, sempre com fonte e link).
12. **IA Gemini sempre à mão (dono, 02/08/2026 — substitui a janela
    flutuante do v25)**: o chat mora FIXO e SEMPRE ABERTO na sidebar
    (#ia-side, abaixo das abas — abaixo de Painel Admin pro admin, abaixo
    de MENU pro usuário comum). O botão flutuante 🤖 foi REMOVIDO de vez
    (ordem expressa). No celular (sem sidebar) o acesso é pelo MENU ☰ e
    pela aba IA Chat. Balões-convite rotativos (54 frases, ~2min, só pra
    quem nunca usou o chat, nunca enquanto digita) chamam pro chat sem
    atrapalhar. "Ver tudo" na sidebar virou MENU com destaque roxo;
    cérebro treinável pelo painel admin (experiências de Andrio, Diego,
    Eudes e clientes); preços/regras SEMPRE dinâmicos da fonte oficial do
    código (nunca hardcoded no prompt).
13. **Robôs autônomos**: fila do automático se realimenta sozinha com os
    mesmos filtros; fila esperta (empregador menos contatado primeiro);
    vaga morta é pulada sem gastar limite; planilhas se atualizam sozinhas
    (status/datas/salário) — sempre educados com o DOL (backoff em 403).
13a. **🌱 Aquecimento de Gmail (dono, 27/07/2026 — "gente sendo bloqueada
    pelo Google")**: toda conta Gmail nova (principal ou extra) tem um
    teto de referência que sobe aos poucos (dias 1-3: 15/dia · 4-7:
    40/dia · 8-14: 100/dia · 15+: limite cheio do plano) — cada conta tem
    seu PRÓPRIO relógio (created_at do usuário / addedAt do extra). Sem
    dado de quando a conta nasceu, NUNCA bloqueia por falta de informação
    (fail-open). **v76 (dono, 27/07/2026 — "eu quero nao nunca pare o
    automático", cliente pago travado em `waiting_warmup`): esse teto
    NUNCA MAIS pausa o automático.** É só preferência de rodízio — com
    mais de 1 conta, o round-robin PREFERE a que ainda está dentro do
    teto; se todas já bateram o teto de hoje, usa a menos carregada
    mesmo assim e segue no intervalo humanizado normal (a proteção real
    contra rajada súbita). Proibido reintroduzir um status que pausa o
    automático (`waiting_warmup` ou equivalente) esperando o teto zerar —
    só bloqueio de verdade do Google (conta suspensa/desativada) pausa.
    Uma conta SUSPENSA pelo Google é ISOLADA (blocked:true) e o
    automático CONTINUA pelas outras — nunca pausa tudo por causa de 1
    conta doente. Selo visível no Perfil (🌱 Aquecendo X/Y hoje) — nunca
    esconder esse throttling do usuário, mesmo não bloqueando mais.
13a2. **Regra geral (dono, 27/07/2026, duas vezes no mesmo dia — rate
    limit do Google em v75 e aquecimento em v76): o envio automático só
    pausa de verdade por BLOQUEIO REAL do Google (conta suspensa,
    envio desativado) ou por falta de autenticação/token. Qualquer
    proteção interna nossa (rate limit, aquecimento, etc.) deve
    DESACELERAR ou preferir outra conta, nunca ENTRAR EM ESTADO DE PAUSA
    esperando o problema sumir sozinho — o automático sempre segue
    tentando no intervalo humanizado normal.
13a3. **🔐 v165 — Autenticação NUNCA cai por nossa causa (dono, 02/09/2026
    — usuário real com "Gmail desconectando sempre: envia 5-10min e pede
    login de novo")**: 4 vetores fechados de raiz. (1) O /revoke do Google
    derruba o GRANT INTEIRO da conta (por app+conta Google, NÃO por cópia
    de token) — remover como EXTRA um e-mail que é conta de LOGIN de
    alguém no site revogava o login/automático daquela pessoa em silêncio;
    agora conta que existe como usuário NUNCA sofre revoke ao ser removida
    como extra (v21-PRIV continua pros extras puros). (2) Token de acesso
    vencido NO MEIO da fila (401/"Invalid Credentials") renova sozinho e
    RE-TENTA o mesmo envio — vaga nunca queimada; erro com cara de auth só
    pausa DEPOIS que um refresh real confirma a queda (13a2). (3) Extra
    com auth morta é ISOLADO (badge RECONECTAR) e o robô SEGUE pelas
    outras contas (padrão v73); RECONECTAR só é marcado com queda
    CONFIRMADA pelo Google (invalid_grant/revoked) — erro de rede pula a
    conta só naquele ciclo. (4) Diagnóstico: `authTimeline` por usuário
    (ring 40, debounced) grava logins (consent novo × relogin), refresh
    falhou (erro CRU do Google), renovações no meio da fila, pausas,
    revokes e isolamentos — raio-X "🔐 Autenticação Gmail" na 💳
    Auditoria; `lastConsentAt` alimenta o detector de QUEDA RÁPIDA
    (invalid_grant <30min após consent novo = o GOOGLE da conta derrubando
    — senha trocada/alerta de segurança), que troca a instrução pro
    usuário (myaccount.google.com → Segurança ANTES de relogar) + push
    1x/6h. PROIBIDO: revogar grant de conta de login, marcar
    RECONECTAR/rtInvalid por erro transiente, e pausar por auth sem provar
    com refresh. 3 checks. sw v146. Total da suíte: 534.
13b. **Pagamento**: comprovante que CONFERE (pré-check IA) ativa o plano
    NA HORA, mas PROVISÓRIO (3 dias) e o pedido segue pendente — o admin
    confirma SEMPRE; nunca fica plano ativo dias sem confirmação humana.
13c. **💎 DIAMANTES (dono, 26/07/2026 — substitui a compra de plano)**: NÃO
    existe mais compra direta. Doação PIX (mesmo fluxo de comprovante; SEM
    ativação provisória — admin confirma SEMPRE) credita DIAMANTES REAIS
    (1 💎 = R$ 1,50; env DIAMOND_PRICE_BRL). Plano é TROCADO por 💎 NA HORA,
    sem aprovação e SEM lançar caixa de novo (o dinheiro entrou na doação).
    💎 real pode ser doado a outro usuário DO MESMO servidor; 💎 bônus
    (brinde do admin) é intransferível e é gasto PRIMEIRO na troca. Preço em
    💎 deriva SEMPRE de PLANO_PRECO_TAB (nunca hardcoded em 2º lugar).
    **🎁 Missões (dono, 31/07/2026, vendo o painel real — "isso aqui é
    muito importante")**: 💎 de missão/tarefa é BÔNUS, pago 1 ÚNICA VEZ
    por conta (`u.missoes` nunca é apagado — nem reset de enviados
    re-paga) e NUNCA pode ser doado a ninguém — só serve pra troca/
    upgrade de plano. A rota de transferência debita SÓ do saldo real
    (nunca do bônus) e recusa com 402 quem só tem bônus — guarda de
    regressão v84b no smoke test prova o cenário exato.
    Cancelou doação aprovada → estorna os 💎 (parcial se já gastou, com log).
    LINGUAGEM (v66): NENHUM texto visível do site fala em compra/pagamento/
    contratar/renovar — sempre doação, diamantes, troca e recompensas.
    Preços exibidos ao usuário são em 💎; o R$ só aparece na calculadora da
    doação, DEPOIS que a pessoa escolhe a quantidade. Packs de doação
    mostram só a quantidade de 💎 (nunca o valor junto).
    Aba 🧾 Conferência lista TODOS os pagamentos desde a 1ª compra (valor
    ao lado do nome, comprovante clicável, valor editável com trilha que
    corrige o caixa junto). Código de 30 dias (YouTube do Diego) vale
    R$147 como pagamento; os demais códigos são cortesia (R$0).
13d. **📧 SÓ-ENVIO PERMANENTE (dono, 26/07/2026 — substitui o toggle do
    v55)**: o app SÓ ENVIA e-mail pela API do Google — NUNCA mais pede
    escopo de leitura (gmail.readonly/modify), em NENHUM dos 3 servidores.
    GMAIL_SEND_ONLY é hardcoded `true` em server.js (não é mais env por
    servidor). A aba Respostas foi REMOVIDA do site — não existe mais em
    lugar nenhum. Nenhuma rotina do servidor lê/abre a caixa de entrada de
    ninguém (bounce-scan no boot e o polling de push por resposta foram
    desligados de propósito — dependiam do escopo de leitura). Se um
    e-mail bounça, o sistema só descobre por dado JÁ conhecido
    (DB_INVALID_EMAILS histórico + ajuste manual do admin) — não há mais
    descoberta automática de novos bounces por leitura de inbox. PROIBIDO
    reintroduzir gmail.readonly/gmail.modify, a aba Respostas, ou qualquer
    leitura de caixa de entrada sem ordem EXPRESSA e NOVA do dono.
13e. **🎯 RESPOSTAS CERTAS — REVOGADA (dono, 13/08/2026: "exclua a aba
    respostas")**: a exceção admin-only ao 13d foi EXCLUÍDA por inteiro
    no v135 — aba do painel, rotas /api/admin/reply-triage/*, OAuth de
    leitura isolado (ADMIN_REPLY_*), scanner e guardas de teste. O 13d
    volta a ser ABSOLUTO: NINGUÉM (nem admin) lê caixa de entrada por
    este sistema, em nenhum dos 3 servidores. Os arquivos de dados
    antigos (admin_reply_*.json) ficam inertes no disco. Não recriar
    sem ordem EXPRESSA e NOVA do dono.
13f. **💎 Arredondamento de diamantes — REGRA ÚNICA (dono, 28/07/2026, bug
    real: "comprou 250 reais, ativou DoublePro, mas não aparece que ele
    tem")**: causa raiz achada — doação creditava 💎 com `Math.floor`
    enquanto o preço de cada plano em 💎 usa `Math.round`
    (`planoPrecoDiamantes`). Pra planos cujo preço em R$ não é múltiplo
    exato de `DIAMOND_PRICE_BRL`, doar EXATAMENTE o valor de tabela do
    plano deixava o usuário 1💎 curto, sem aviso claro — parecia "não
    funciona". Corrigido para `Math.round` nos dois lados. PROIBIDO
    usar `Math.floor`/`Math.ceil` em qualquer conversão nova de R$↔💎 —
    é SEMPRE `Math.round`, os dois lados da mesma conta (crédito e
    preço) TÊM que usar a mesma função de arredondamento, senão volta o
    mesmo bug de "faltou 1💎" pra quem doou o valor certinho.
13g. **💎 Painel completo de Diamantes (dono, 28/07/2026)**: aba admin
    "💎 Diamantes" (`/api/admin/diamonds/overview` +
    `/api/admin/diamonds/user/:email`) — ranking de quem tem mais/menos/
    zero 💎, extrato COMPLETO por usuário (o que comprou/trocou/recebeu,
    quando, saldo depois de cada lançamento), 20+ métricas agregadas
    (circulação total, total doado em R$, gasto por plano, top
    doadores, atividade recente de todo mundo). Fonte única: o mesmo
    `diamondLedger` por usuário que já existia desde o v64 — nenhuma
    segunda verdade nova. Admin-only, dado financeiro sensível.
13h. **💎 Corrigir valor de doação REAJUSTA os diamantes (29/07/2026)**:
    achado revisando o v77 — corrigir o R$ de uma doação já aprovada
    (`corrigirValor` na Conferência OU `/api/admin/pedido-set-valor` nos
    Pedidos) atualizava o caixa mas nunca os 💎 já creditados. As duas
    rotas agora chamam `reconciliarDiamantesCorrecao()` (função única,
    nunca duplicada) — credita a diferença pra cima sempre; pra baixo,
    remove o que der do saldo real (nunca negativo) e ACUSA no log
    quanto já foi gasto e não pôde ser recuperado.
13i. **⚠️ Classe de bug real (29/07/2026): rota sem try/catch que referencia
    variável inexistente TRAVA A REQUISIÇÃO PRA SEMPRE, não dá erro.**
    Achado no `/api/admin/pedido-set-valor` (referenciava um `body` que
    nunca foi lido/parseado — nem `readBody`, nem `JSON.parse`). Sem
    try/catch ao redor, a exceção estoura DENTRO do callback assíncrono
    do request handler; os handlers globais `uncaughtException`/
    `unhandledRejection` só logam (não têm acesso a `res`), então a
    resposta HTTP NUNCA sai — o admin via a tela girando pra sempre, sem
    erro nenhum pra reportar. Toda rota nova PRECISA: (1) ler o body só
    via `JSON.parse(await readBody(req))`, nunca reaproveitar uma
    variável de outro escopo; (2) ter try/catch cobrindo isso, com o
    catch sempre devolvendo uma resposta JSON de erro — nunca deixar um
    caminho onde a exceção pode escapar sem que `json(res,...)` seja
    chamado.
13j. **⚠️ Classe de bug real (Diego, 29/07/2026, áudio: "ativei DoublePro
    pro Esdras várias vezes e não entra, volta pro VipPro"): snapshot de
    ANTES de uma função auxiliar reaproveitado DEPOIS dela apaga o que
    ela acabou de gravar.** `/api/admin/set-plan` lia `tgt=getUser(email)`,
    chamava `addManualVipDays`/`addAutoVipDays` (que leem e gravam
    `vip.manualExpires`/`autoExpires` atualizados de verdade) e DEPOIS
    fazia `setUser(email,{vip:{...tgt.vip, ...}})` usando o `tgt` ANTIGO
    — sobrescrevendo o vip inteiro com o snapshot de antes, apagando os
    dias que as duas funções tinham acabado de gravar (no caso de um
    usuário novo, `tgt.vip` nem existia — o resultado virava `plan:free`
    na cara). Regra geral: se uma função auxiliar já lê+grava o mesmo
    registro, PROIBIDO guardar esse registro numa variável ANTES dela e
    reusar essa variável DEPOIS — sempre reler (`getUser`) depois de
    qualquer helper que possa ter mudado o mesmo dado, ou não guardar
    snapshot nenhum. Sem teste algum cobria essa rota antes disso.
13k. **⬆️ Upgrade de plano (dono, 29/07/2026)**: quem já tem plano PAGO
    ativo pode subir de tier (VIP→VIPro→DoublePro) pagando só a
    DIFERENÇA em 💎 entre o plano atual e o novo, no MESMO período
    (`vip.days`) que já tinha assinado — `/api/plans/upgrade`. Regra
    inegociável: **os dias NUNCA reiniciam nem somam** — quem tinha 20
    dias restantes continua com exatamente 20 dias restantes, só que
    num tier melhor. Única exceção: se o upgrade destrava automático
    pela 1ª vez (vinha de VIP só-manual), o automático passa a valer até
    a MESMA data que o manual já tinha (nunca ganha um +30d novo). Upgrade
    é 100% pago em diamantes — NUNCA lança entrada nova no livro-caixa
    (a mesma regra "troca não duplica o caixa" do v64 vale aqui). Downgrade
    e "upgrade" pro mesmo tier são recusados (400). Sem plano pago ativo
    (ou saldo insuficiente) também é recusado, nunca ativa de graça.
    **🔒 v84 (auditoria de segurança, 29/07/2026)**: "plano PAGO" tinha
    esquecido `vip.source==="code"` na lista de exclusão (só excluía
    trial/auto-provisorio) — quem resgatasse um código de cortesia
    (R$0, nunca gera pagamento — regra 13c) conseguia chamar upgrade e
    pagar só a DIFERENÇA de diamantes pra virar DoublePro, descontando
    o preço inteiro de um plano nunca pago. Provado com reversão real do
    fix (o teste falhou mostrando a cobrança de 67💎 em vez de recusar).
    Corrigido: `code` entra na mesma lista de exclusão que TODO o resto
    do financeiro já usa (`computeEntradasJanelas`, dono-resumo) —
    trial E code NUNCA contam como plano pago, em lugar nenhum.
13l. **💎 Diamante infinito pra admin/DM (dono, 29/07/2026 — "eu e o Diego
    temos limite infinito")**: toda conta admin (`isAdminVip` — dono, Diego
    e os demais e-mails de `ADMIN_EMAILS_EXTRA`) pode testar troca/upgrade
    de plano SEM gastar diamante de verdade — `debitDiamonds` (função
    única usada por troca E upgrade) nunca desconta do saldo real do
    admin e NUNCA gera lançamento no extrato dele; por isso nenhum
    agregado do painel 💎 Diamantes (`totalGastoEmTrocasPorPlano` etc.)
    é afetado por teste de admin. Diferente disso: se o admin DOAR
    diamantes pra um usuário de verdade (`/api/diamonds/transfer`), a
    doação NUNCA sai do saldo do admin (poço infinito, nunca bloqueia
    por saldo insuficiente) mas CONTA de verdade — o destinatário recebe
    💎 REAIS de verdade (pode gastar/repassar) e o extrato mostra a
    doação atribuída certinho ao e-mail do admin, entrando nos agregados
    do site (`totalTransferidoEntreUsuarios`) igual qualquer doação real.
    Isso não é um poder novo — admin já podia creditar qualquer saldo pra
    qualquer usuário via `/api/admin/diamonds`; a doação por transferência
    só dá o mesmo resultado com a cara de "doação entre pessoas" no extrato.
13m. **🎯 Match de vaga (dono, 29/07/2026 — "IA sugerindo as vagas com mais
    chance pra cada um", prioridade #1 da casa)**: toda vaga ganha uma nota
    0-100 (`computeJobMatchScore`, server.js) de encaixe com o perfil do
    candidato — categoria preferida (`h2bProfile.preferredArea`), estado e
    categorias do perfil de vaga (`profiles[].state/.categories`), e o
    texto da vaga batendo com experiência (`experiencedH2B`/`h2bSeasons`) e
    nível de inglês (`englishLevel`). Heurística local, NUNCA IA externa —
    roda instantâneo em toda busca manual (`/api/sheet-meta`, `/api/jobs`)
    e em toda fila automática (`orderQueueSmart`). Sempre devolve o
    "porquê" (`matchWhy`) — proibido virar caixa preta. NUNCA bloqueia:
    sem perfil preenchido a nota fica neutra (50), sem sessão a nota some
    (null) — a vaga continua 100% visível e candidatável do jeito de
    sempre. Na fila automática, o score só reordena DENTRO da mesma faixa
    de "quanto o app já contatou esse empregador" (regra 13, fila esperta)
    com jitter aleatório — nunca substitui essa proteção contra usuários
    simultâneos baterem no mesmo empregador. Uma função de pontuação só
    (`computeJobMatchScore` + `_matchSignalFromRow`/`_matchSignalFromJob`
    convergindo os 2 formatos de vaga pro mesmo sinal) — nunca duplicada
    por endpoint. **v139 (14/08)**: a nota ganhou prateleira própria na
    Home — "🎯 Vagas pra você" (`/api/jobs/pra-voce` + `#home-pravoce`):
    top 8 empregadores AINDA disponíveis, ranking cacheado 10min por
    usuário MAS o corte da regra 8 (enviado/na fila) roda FRESCO em toda
    resposta; vaga morta/encerrada fica de fora; matchWhy traduzido no
    front por mapa de chaves (9 frases fixas → pv_w1..pv_w9). Snapshot de
    vaga tem fonte única `_vagaSnapshot()` (Salvas + Pra Você).
13n. **💰 Janelas de entradas — fonte única (dono, 29/07/2026 — fila futura
    "consolidar telas financeiras do admin")**: achado revisando a régua —
    Visão do Dono (`/api/admin/dono-resumo`) e o resumo usado no
    Faturamento Global/rota peer (`_entradasResumo`, `/api/servers/
    financeiro`) reimplementavam CADA UM sua própria cópia do cálculo
    hoje/7d/30d/total (mesma classe de risco do bug real do v77b — 2
    verdades sobre o mesmo dinheiro que podem divergir, só que no caixa em
    vez de diamantes). Unificado em `computeEntradasJanelas()` — fonte
    única, com a MESMA correção que `computeFinanceCanonico` já aplica pras
    outras telas (pedido corrigido depois vence sobre o lançamento cru do
    caixa, se algum dia divergirem). PROIBIDO reintroduzir um 2º cálculo
    dessas janelas em qualquer tela nova — sempre chamar
    `computeEntradasJanelas()`.

13o. **📋 Novas regras de planos v118 (dono, 02/08/2026 — áudio confirmado
    por escrito)**: tabela NOVA só pra ativação nova — VIP R$100 = 100
    manuais/dia (sem automático) · VIPro R$150 = 100 manual + 100 auto ·
    DoublePro R$250 = 200 manual + 200 auto. **Contrato congelado**: toda
    ativação (troca 💎, upgrade, set-plan do admin, código) carimba
    `vip.limits {manual,auto}` na hora; getManualLimit/getAutoLimit
    preferem esse carimbo enquanto o respectivo lado do VIP está ativo.
    Quem pagou ANTES não tem `vip.limits` e cai na tabela LEGADA
    (PLAN_LIMITS: vip 200 · vipro 200/200 · doublepro 400/400) até
    expirar — **nenhum pagante perde nada, nunca** — e vê o aviso
    `planRulesNotice` (/api/status → toast 1x por sessão) com a data de
    garantia e os limites de hoje. Ritmo: automático ~7min/envio
    (calcSmartInterval 6,5–7,5min; custom de admin continua); manual tem
    cooldown de 1 minuto (429 + cooldownLeft no /api/send, espelhado no
    front via _manualCdUntil; admin isento). **v120 (dono, 05/08)**: o
    cooldown do MANUAL é o padrão mas o usuário pode DESLIGAR — pill no
    modal de envio (#m-cd-pill → manualCdModal) com aceite de risco
    obrigatório (checkbox "meu Gmail pode ser bloqueado para sempre";
    carimbo manualCdOffAt no servidor); religar é 1 clique. `manualCdOff`
    vive no usuário via /api/settings e é espelhado no /api/status. O
    intervalo do AUTOMÁTICO não é editável por usuário comum — 7min
    sempre (só o custom de admin existe). PROIBIDO mudar limite de
    plano mexendo só na tabela — mudança nova = tabela nova + carimbo na
    ativação, mantendo os carimbos antigos intocados (mesma filosofia).
    Atenção à ordem do histórico: addHist usa unshift — o envio mais
    recente está no ÍNDICE 0 (o scan do cooldown varre do começo).

13p. **🌾 Planilha H-2A MENSAL (dono, 08/08/2026 — "pode fazer o robô
    publicar sozinho"; mudou de bimestral pra mensal no MESMO dia:
    "daqui 1 mês gera outra em setembro")**: TODO MÊS o robô
    `_runH2aBimestral` (nome interno mantido; cadência é 1 mês) monta
    sozinho a planilha "H-2A <Mês> <Ano>" (chave `h2a-YYYYMM`) com as
    vagas dos últimos 90 dias — 6 feeds ZIP escalonados de 18 dias (cada
    feed do datahub cobre ~20 dias pra trás), MESMA esteira das outras
    (dedupe por case number, filtro de qualidade, integridade) via
    `_runDolColeta` (que agora aceita `feedDates[]`/`visaStrict`/
    `autoPublishMin`). AUTO-PUBLICA — exceção autorizada por escrito à
    regra KB-078 de rascunho, SÓ deste robô — quando coleta ≥
    `H2A_BIM_MIN_PUBLICAR` (padrão 200) vagas válidas; abaixo disso fica
    em RASCUNHO e os admins recebem push pra revisar. Agenda: checa 8min
    após o boot (cria a 1ª sozinho) e a cada 12h; roda de verdade quando
    MUDA O MÊS do calendário (estado em `h2a_bimestral.json`; guarda no
    smoke prova que 1 mês de diferença JÁ roda). Disparo
    manual: POST `/api/admin/sheet/h2a-bimestral-run` (`force:true` refaz
    a do mês). A coleta real só roda em PRODUÇÃO (sandbox não alcança o
    DOL) — o smoke prova a esteira inteira com o feed falso.

13p2. **🧊 Planilha H-2B MENSAL (CEO mode, 14/08/2026 — o site chama
    H2BApply e a planilha H-2B mais nova era de janeiro, em plena época
    de contratação da temporada de inverno)**: mesmo núcleo mensal do
    13p (`_runPlanilhaMensal`, função ÚNICA usada pelos 2 robôs;
    `_runH2aBimestral` e `_runH2bMensal` são só wrappers de config) monta
    todo mês a "H-2B <Mês> <Ano>" (chave `h2b-YYYYMM`, estado em
    `h2b_mensal.json`, boot+20min e ciclo 12h — defasado do H-2A pra
    nunca colidir na `_dolColeta`). DIFERENÇA INEGOCIÁVEL: o H-2B fica
    SEMPRE em RASCUNHO (KB-078) — a auto-publicação continua exceção
    autorizada por escrito SÓ do robô H-2A; os admins recebem push e
    publicam com 1 clique (coleta-publish). Se o dono autorizar por
    escrito o auto-publicar do H-2B, é trocar `autoPublish:false` no
    wrapper — nunca mexer no núcleo. Disparo manual: POST
    `/api/admin/sheet/h2b-mensal-run`. Publicar um rascunho dispara o
    📡 Radar (v134) na 1ª publicação — mesma regra da auto-publicação.
13q. **🚫 INDICAÇÃO PREMIADA — NUNCA (dono, 13/08/2026)**: programa de
    indicação com recompensa (💎/dias por convidar amigo) está PROIBIDO
    para sempre — "as pessoas ficam criando e-mails falsos em
    indicação". Não implementar, não sugerir, não reintroduzir o que
    existir de resquício. 📡 Radar de Vagas (v134) foi APROVADO por
    escrito: push opt-in (só quem criou radar), máx 1/dia por usuário,
    radar vazio recusado — é a única exceção nova de push além das
    já regradas (10/10b).
13r. **💳 Auditoria Financeira por usuário — caso Cleiton (dono,
    15/08/2026: "esse Cleiton e também o outro ali, eu sei que nenhum dos
    2 tem todos esses dias de plano. algo deu errado!")**: causa raiz
    achada — `/api/admin/set-plan` era a ÚNICA rota que soma dias de VIP
    sem trava de clique duplo/retry (`vip/activate` já tinha desde o
    v18-FIX). Corrigido com a mesma trava de 5s, mas a CHAVE inclui o
    PLANO (admin+email+plano) — upgrade legítimo e imediato pro plano
    seguinte (caso real do Diego, v79) continua passando; só repetir o
    MESMO plano é bloqueado. `detectarConcessoesDuplicadas()` varre
    `DB_ADMIN_AUDIT` e acha sozinho 2+ concessões pro mesmo usuário em
    ≤15min terminando no MESMO plano final (não flagra escaladas
    legítimas) — aparece como divergência `concessoes_duplicadas` na
    Conferência. Nova aba principal da sidebar **"💳 Pagantes & Dias
    VIP"** (antes só acessível pela régua 💰) e nova aba do CCC **"💳
    Auditoria"** (`GET /api/admin/financeiro-usuario/:email`, fonte
    única — sem duplicar armazenamento) juntam o que antes vivia em 5
    rotas espalhadas: plano+reconciliação, comprovante de cada pedido,
    extrato de dias concedidos (`vip.creditos` — `set-plan` passou a
    alimentar também, lacuna que existia), trilha de auditoria
    administrativa com reversão em 1 clique, extrato de diamantes, uso
    real (envios hoje/limite/histórico) e sinais de risco (comprovante
    reusado, Gmail bloqueado, missão já paga). Ações rápidas
    diferenciam explicitamente **somar dias** (`vip/activate`) de
    **definir vencimento exato** (`vip/set-expiry`) — a ambiguidade
    entre as duas semânticas era um dos riscos identificados na
    auditoria do código.
13s. **🎟️ Código Promo com limite avançado (dono, 15/08/2026 — usuário
    perdeu acesso ao Gmail, admin recria a conta e quer "repor os 15
    dias dele que sobraram do Google Pro... 15 dias doublepro 400
    manual e 400 automático")**: até aqui todo código resgatado caía
    cego na tabela NOVA (v118, `limitesDoPlanoNovo` por nome do plano)
    — no máximo vipro 100/100, nunca reproduzia um contrato LEGADO
    (ex.: doublepro 400/400) numa conta recriada do zero. Campos
    OPCIONAIS `manualLimit`/`autoLimit` na criação do código (painel
    Códigos Promo → "Limite avançado", vazio = comportamento de sempre):
    se preenchidos, o resgate usa ESSES números diretamente em
    `vip.limits`, ignorando a tabela — funciona porque
    `getManualLimit`/`getAutoLimit` já liam `vip.limits` primeiro,
    antes de qualquer tabela por nome. Propagado no resgate local E no
    caminho cross-servidor (`/api/servers/code-redeem`). Continua
    valendo a regra 13c: origem do plano fica `source:"code"` sempre
    (cortesia, NUNCA pagamento), mesmo com limite legado.
13t. **📝 Rascunho do Editor de Perfil (dono, 15/08/2026 — print via
    WhatsApp: "o usuário não consegue completar o perfil dele", caso real
    da Keyla no Servidor 3)**: causa raiz investigada e NÃO é bug de
    front nem de validação — é consequência de uma decisão deliberada
    já existente (KB-078): o servidor derruba TODAS as sessões de login
    a cada reinício do processo Node (deploy OU Render "acordando" no
    plano free/starter). Servidor 3 é a fonte deste repo e recebe
    deploy a cada commit, então reinicia com muito mais frequência que
    os espelhos — quem está no meio de escrever um perfil novo (a parte
    mais chata de digitar do site: 3+ assuntos, 3+ corpos de e-mail)
    recebia "Sessão expirada" e perdia tudo, sem aviso. **NÃO revertemos
    o KB-078** (a decisão de segurança continua valendo) — só garantimos
    que o TEXTO nunca se perde: `_peSaveDraftNow()`/`_peLoadDraft()`
    (app.js) fazem autosave debounced (500ms) do que está sendo digitado
    no editor de perfil pro `localStorage` (nunca servidor), com
    snapshot extra garantido no instante do clique em "Salvar". Ao
    reabrir o MESMO perfil (mesmo tipo de visto + mesmo id, nunca mistura
    rascunho de perfis diferentes), oferece restaurar. Mensagem de erro
    também ficou mais clara (`_peSessionMsg`) quando é sessão caída.
    Lição geral pra qualquer formulário longo do site: um 401 real do
    servidor não é bug — mas perder o trabalho da pessoa por causa dele
    é, e a correção certa é preservar o rascunho no aparelho, não tentar
    evitar o 401 (ele é intencional).
13u. **🚚 FUSÃO DE SERVIDORES — reset do OAuth (dono, 15/08/2026)**: o
    Google limita OAuth não-verificado a 100 usuários; o dono vai criar
    um OAuth NOVO só no Servidor 1 (h2bapply.com — o domínio que
    sobrevive) e DESLIGAR o 2 e o 3. Antes disso, o Servidor 1 PUXA tudo
    dos irmãos: card "🚚 Fusão de Servidores" em Configurações →
    `/api/admin/fusao/puxar {serverId}` + status/log ao vivo; lado fonte
    responde `/api/servers/fusao/{manifest,user-batch,globais,
    pedidos-batch}` (auth peer x-peer-fin, paginado em 5 usuários/10
    pedidos pra nunca estourar memória — PDFs do disco e comprovantes
    base64 viajam nos lotes). REGRA DE CONFLITO DE E-MAIL (aprovada pelo
    dono): vence a conta criada por ÚLTIMO (perfil/nome/currículos dela),
    MAS dias de VIP restantes + diamantes + envios (union por appId) +
    anti-duplicado (union — regra 8 nunca falha) + missões + savedJobs
    são SOMADOS — ninguém perde o que pagou. Backup completo automático
    ANTES (aborta se falhar); IDEMPOTENTE via `fusao_state.json` (e-mail
    já fundido nunca soma 2x — provado no teste rodando 2x). Tokens OAuth
    NUNCA viajam (morrem com o client novo mesmo). Drill REAL no smoke:
    sobe um segundo servidor de verdade e funde. 📢 Aviso de reset:
    toggle `avisoResetLogin` (Configurações) liga banner na landing
    (rst_t/rst_b, 3 línguas) — "nada foi apagado, entre com o MESMO
    e-mail, conta duplicada = risco de ban dos dois e-mails". **v150
    (dono, 20/08 — comunicado oficial): o MESMO toggle também liga a
    JANELA obrigatória antes do login (#reset-notice-modal, rn_t/rn_p1/
    rn_warn/rn_ok, 3 línguas) — openAuthGate é interceptado e só segue
    após "Li e entendi" (1x por sessão, sessionStorage h2bResetNoticeOk);
    qualquer erro = fail-open, o aviso NUNCA pode impedir um login.** A
    verificação DEFINITIVA do Google (gmail.send é escopo SENSÍVEL →
    verificação GRATUITA, sem CASA) está no GUIA_VERIFICACAO_GOOGLE.txt.
    **📦 v148 (dono, 20/08/2026 — "já que a fusão não está dando certo...
    botão de download de todas as informações... e no server um, o
    importar")**: a fusão por rede exigia os 2 servidores no ar ao mesmo
    tempo (Free hiberna + deploy defasado = "manifest não respondeu").
    Caminho por ARQUIVO virou o principal no card: no Servidor 2/3 o
    admin clica ⬇️ (`GET /api/admin/fusao/exportar` — .fusao.gz em
    stream, 1 usuário por vez, tokens OAuth NUNCA no arquivo) e no
    Servidor 1 clica ⬆️ (`POST /api/admin/fusao/importar`, corpo binário
    com teto próprio de 300MB — o readBody de 50MB é pouco). O import
    roda `_runFusaoArquivo` = MESMO motor (`_fundirUsuario`,
    `_fusaoAplicarGlobais`, `_fusaoPersistTudo` — funções únicas
    compartilhadas com a fusão por rede; `_fusaoUserPayload`/
    `_fusaoGlobaisPayload` são a fonte única do formato), mesmo backup
    prévio obrigatório, mesma idempotência por servidor de origem
    (`fusao_state.json`) e mesmo log ao vivo no painel. GUARDA: arquivo
    exportado do PRÓPRIO servidor é recusado (400) — importar em si
    mesmo duplicaria dias/diamantes de todo mundo. Puxar por rede
    continua existindo como modo secundário (colapsado em <details>).
    Drill real no smoke: sobe um 3º servidor (SERVER_ID=3), exporta pela
    rota, MATA o servidor de origem e importa só com o arquivo — prova
    exatamente o cenário que a rede não cobria. **v148b (mesma noite,
    print do dono: 42,6MB do celular preso em "Enviando..." sem % nem
    tempo)**: o proxy do Render corta requisição longa (~100s), então o
    upload do importar é FATIADO em pedaços de 4MB (`importar-parte`
    grava por OFFSET — retentativa do mesmo pedaço regrava os mesmos
    bytes, nunca corrompe; 3 tentativas por pedaço no front; `importar-
    fim` monta, valida e dispara `_fusaoImportStartFromBuf`, função
    única também usada pela rota de corpo único) com progresso ao vivo
    (% + MB + tempo). Uploads abandonados são varridos no boot (>24h).

13v. **🛡️ Conta única & contrato do e-mail no login (dono, 20/08/2026 —
    print do ranking com todo mundo aparecendo 2x)**: (1) o ranking
    global deduplica por `uid` (pós-fusão a MESMA conta vive no Servidor
    1 importada E no irmão ainda no ar; o uid deriva do e-mail) mantendo
    a maior contagem, e o total de um peer cujo top-50 repete uid do
    local NÃO soma — PROIBIDO reintroduzir merge de ranking sem esse
    dedupe. Aqueles "duplicados" do print NÃO eram pessoas com 2 contas.
    (2) **Login em 2 FASES (v149b — dono: "revogar não adianta, ela não
    pode nem marcar a caixinha")**: com e-mail digitado, a 1ª ida ao
    Google pede SÓ identidade (`openid email` — escopo básico, NÃO conta
    nas 100 vagas); escolheu o e-mail errado = barrado ali, ANTES da
    tela de permissão do gmail.send existir. E-mail certo comprovado →
    2ª etapa pede o gmail.send com a conta cravada (`login_hint`), e o
    callback ainda revalida + revoga token como defesa de backup (caso
    troque de conta no meio do consentimento). Só o e-mail digitado
    NESTA visita (_agEmail) vira hint — nunca um salvo do aparelho.
    (3) Aviso permanente de CONTA ÚNICA na landing (au_t/au_b/au_f, 3
    línguas): 2ª conta mesmo com outro e-mail = risco de BAN PERMANENTE
    das duas; o nome no currículo é sempre o mesmo e o sistema cruza
    nome/telefone/aparelho. (4) O detector de contas duplicadas de
    VERDADE já existia desde o v53 (`/api/admin/duplicates` — nome
    normalizado, telefone, IP; grupo com admin some) na aba Auditoria &
    Duplicadas — banir é decisão HUMANA do admin, nunca automática.

13w. **💸 Dieta de banda do Render (dono, 21/08/2026 — fatura de $45,59:
    38,6GB de banda, 85% "Service-Initiated" gerada pelos PRÓPRIOS
    servidores)**: `MODO_APOSENTADO` (env REDIRECT_ALL_TO válida, pós-
    fusão) desliga NESTE servidor: envio automático (gate único em
    `scheduleAuto` — mandar em paralelo com o Servidor 1 duplicaria
    contato com empregador, furando a regra 8 entre servidores), backup
    diário entre irmãos (85MB×2/dia de dado congelado), sentinela e
    TODOS os robôs de coleta/planilha/notícias/renovação/resumo — fica
    só o redirect 302 + rotas peer/fusão. O vigia de anúncios do DOL
    passou de 10 pra 30min em TODOS os servidores (a página muda poucas
    vezes por mês; 144 fetches/dia por servidor era banda jogada fora).
    PROIBIDO religar robô em servidor aposentado sem ordem nova do dono.
    A parte gorda da fatura (Services ~$40) se resolve no PAINEL do
    Render: depois da migração confirmada, rebaixar os serviços 2 e 3
    pra instância Free (a casca de redirect roda de graça).

13x. **💎 AUDITORIA DOS DIAMANTES & DOAÇÃO NUNCA DÁ DIAS (dono, 21/08/2026
    — "o diamante é o dinheiro de dentro do site")**: 3 bugs reais
    corrigidos de raiz no v154. (1) `reconciliarPlanosComPedidos` (boot)
    não filtrava DOAÇÃO — doação não tem campo `dias`, caía no padrão de
    30, e CADA doação aprovada virava +30 dias manuais em todo boot,
    inclusive re-desfazendo correções manuais do admin ("na hora que eu
    aceitei a doação o site colocou mais 30 dias"). Doação agora é
    PULADA na reconciliação. (2) TODO pedido aprovado é DOAÇÃO: o
    caminho legado de ativação de plano na aprovação foi REMOVIDO;
    pedido de plano (front antigo em cache / importado dos servidores
    2-3) nasce/normaliza como doação (`planoOriginal` na trilha) e a
    aprovação credita SÓ 💎. Dias de VIP nascem SOMENTE de: troca 💎,
    upgrade 💎, código promo e concessão manual do admin. Exceção: admin
    criando pedido retroativo (Regularizar) mantém formato de plano
    (documentação contábil protegida pela reconciliação). (3) A fusão
    SOMAVA bônus (missão paga 1x por PESSOA — quem tinha conta nos 2
    servidores ficou com o dobro): bônus da conta fundida agora é
    RECALCULADO por `_bonusLegitimoCalc` (missões pagas − bônus gasto
    no extrato; fonte única), 💎 REAIS continuam somando (cada lado é
    dinheiro doado de verdade). Migração ÚNICA no boot (carimbo
    `diamantes_fix_v154.json`) recalculou o bônus de todo mundo — reais
    intocados; o carimbo garante que brinde de admin dado depois nunca
    é apagado. PROIBIDO: qualquer caminho novo que conceda dias de VIP
    a partir de aprovação de pedido, e qualquer soma de bônus fora de
    `grantMissao`/crédito explícito de admin.

13y. **🌐 ERA DE 1 SERVIDOR SÓ (dono, 22/08/2026 — URGENTE, pessoa real
    barrada: "tem uma pessoa tentando criar conta e o site está jogando
    pro server três... não existe mais server dois e server três. Qualquer
    conta nova, qualquer login que já existe é tudo no server um")**: a
    triagem multi-servidor MORREU no v156. Migração one-shot no boot
    (`_migMonoSrv`) força Servidor 1 "aberto" e 2/3 "oculto" (defaults
    idem); `/api/auth/where` NUNCA mais consulta irmão nem oferece outro
    servidor — e-mail sem conta = cadastro AQUI, com o self devolvido
    forçado "aberto" (front antigo em cache não pode filtrar); o callback
    OAuth perdeu a trava de "lotado" e a consulta a peers (os 302 de
    `srv_lotado`/`conta_outro_srv` foram REMOVIDOS; `checkAccountOnPeers`
    excluída — código morto); "lotado" virou status decorativo (nunca mais
    recusa cadastro); sentinela e backup entre irmãos PULAM servidor
    oculto (sem alarme falso nem 85MB/dia pra serviço morto). PROIBIDO
    reintroduzir qualquer redirecionamento de cadastro/login pra outro
    servidor sem ordem nova do dono. As rotas peer/fusão continuam vivas
    (usam a lista interna completa, que mantém as URLs dos ocultos).
    **v157 (mesmo dia — "analise todo o site e retire tudo sobre o
    servidor 2 e 3")**: varredura TOTAL no front — seletor de servidores
    (#srv-select-ov + estilos), pill "🌐 Servidores" da landing, cards
    "Escolha seu servidor"/"conta em outro servidor"/"lotado", atalho
    multi-servidor do admin (agAdminGoTo/agRedirect*/agSignupAt/
    openServerSelect/srvGo etc.) e todos os textos "em qual servidor"
    REMOVIDOS de index.html e app.js; o card de entrada fala só de conta
    Google. `/api/auth/where` de admin também filtra ocultos (v156b).
    Guarda no smoke prova a ausência de cada resquício. Nenhum usuário
    (nem admin) vê referência a Servidor 2/3 em tela alguma.

## 🖥️ UX (usuário e admin nunca se perdem)

14. **Site intuitivo e autoexplicativo**: tour em slides no primeiro
    acesso; menus só com o essencial — o secundário mora DENTRO da tela-mãe
    (Logs→Automático, Sugestões→Config, Código→Planos, Lixeira→Pedidos,
    Emails inválidos→Robôs). Antes de criar aba nova, perguntar: "isso
    merece menu ou mora dentro de algo?"
15. **Admin = DINHEIRO primeiro**: a 1ª tela é a Visão do Dono (entradas
    hoje/7d/30d/total, pedidos na mesa, renovações da semana, crescimento).
    Telemetria técnica não ocupa menu — decisão de dono ocupa.
16. Filtros ricos e honestos: multi-estado, mês de início (some quando a
    planilha não tem datas), ordenação real, chips removíveis, contagem
    verdadeira (pós-filtro de enviadas).

6c. **Service Worker**: TODA entrega que mexe em index.html/admin.html/
   h2b-extras-*.js exige subir o CACHE_NAME do sw.js JUNTO — senão os
   aparelhos misturam JS velho em cache com HTML novo e as abas ficam EM
   BRANCO (aconteceu de verdade em 23/07, print do dono).
6d. **HTML de views (index.html)**: ao remover/editar um bloco dentro de
   uma `<div class="view" id="v-X">`, CONFERIR o saldo de `<div>` abertas
   vs fechadas na view inteira antes de commitar — 1 `</div>` a mais ou a
   menos faz a view SEGUINTE nascer aninhada (filha) da anterior, e some
   escondida sempre que a anterior leva `.gone` (bug real 23/07: "nenhuma
   aba funcionando", causa raiz de uma limpeza de HTML anterior, não do
   trabalho de ícones que levou a culpa). O `npm test` agora tem uma
   guarda estrutural pra isso (não desativar).
6e. **setUser()/persist síncrono (server.js)**: NUNCA marcar um campo como
   "crítico" (grava o banco inteiro na hora, bloqueando o servidor pra
   TODOS os usuários) checando truthy — array vazio `[]` é truthy em JS.
   Só é síncrono de verdade dinheiro/acesso (token, vip, isAdmin, plan).
   Perfil/currículo/e-mail extra são SEMPRE debounced (bug real 23/07:
   "site lento, até salvar perfil demora" — `d.profiles`/`d.cvs` truthy
   fazia TODO save reescrever o banco inteiro na hora). Guarda
   determinística no smoke test (não mede tempo — confere se o arquivo em
   disco muda ANTES do debounce disparar).
6g. **🩺 Guarda de SINTAXE do JS inline (CEO mode, 23/08/2026)**: o smoke
   valida com `vm.Script` (gramática Script — a MESMA do navegador) todos
   os blocos `<script>` inline de TODAS as páginas .html + app.js/
   h2b-extras-*.js/sw.js. Classe de bug real do KB: 1 aspa simples não
   escapada num onclick matou um bloco `<script>` inteiro do admin (~15
   funções sumiram em silêncio; o painel "parecia" funcionar por causa de
   duplicatas antigas). A guarda 👻 checa NOMES; esta checa SINTAXE — as
   duas juntas, nunca desativar. Revisão REAL no Chromium (Playwright,
   TEST_LOGIN_TOKEN, script fora do repo) rodada em 23/08: zero erros de
   runtime em 23 views do admin + 11 do usuário + landing.
6f. **🇧🇷 Português por padrão (dono, 01/08/2026 — "site 100% bom pros
   olhos do usuário")**: público é 100% brasileiro. O app abre SEMPRE em
   português — o idioma NUNCA é decidido pelo `navigator.language` (celular
   em inglês fazia muitos brasileiros caírem no inglês). `_curLang` só sai
   do PT se a pessoa TROCOU de propósito pra EN/ES (escolha guardada no
   aparelho + no servidor via `/api/settings`). Normaliza sempre o código
   de região pra 2 letras (`pt-BR`→`pt`) — antes a preferência salva
   `pt-BR` nunca casava com a chave `pt` do dicionário e era ignorada.
   Toda string visível NOVA precisa passar pelo dicionário `LANG_DICT`
   (via `t('chave')` no `applyLang()`), nunca texto fixo em inglês no
   markup — senão fica em inglês pra sempre, mesmo em modo PT (foi o caso
   de "Stats", "Seasonal Jobs" e "Free", corrigidos no v86). Guarda no
   smoke test trava a detecção por navegador (não deixa reintroduzir).

## 🧠 CÉREBRO CONTÁBIL — PROJECT IMPLEMENTATION STATE (Master Command, 22/08/2026)

Plano de 6 partes aprovado pelo dono (avança só quando ele diz PRÓXIMO;
nunca refazer parte concluída; matemática sempre determinística, IA nunca
decide número). Estado:

- ✅ **PARTE 1 (22/08)** — Fundação: `mod-cerebro.js` (injeção por getters,
  padrão mod-sentinel). `reconstruirLedger()` reconstrói a realidade das
  EVIDÊNCIAS (caixa+pedidos+códigos+creditos+diamondLedger), separa receita
  registrada×confirmada×duplicada-suspeita×em-dúvida×cancelada, cortesias
  SEMPRE R$0, valor com a MESMA correção do canônico (pedido vence caixa) e
  cross-check contra `computeEntradasJanelas` no próprio relatório.
  `auditarDias()`: restante hoje × TETO explicável (creditos + pedidos com
  dedupe por pedidoId + códigos usedBy + trocas 💎; upgrade NÃO soma —
  13k); restante>teto = excesso inexplicável (caso 70 dias, confiança 99);
  teto é deliberadamente GENEROSO — errar pra cima esconde, nunca acusa
  inocente. Duplicidade com score explicável (motivos linha a linha, ≥61
  marca). Pedido ativo sem caixa (caso Cleiton) listado. Auditoria
  SÓ-LEITURA (regra 62) → relatório versionado `AUDIT-AAAA-MM-DD-NNN` em
  DATA/cerebro/ + `cerebro_state.json`. Rotas: POST /api/admin/cerebro/
  auditar · GET /api/admin/cerebro/status · GET /api/admin/cerebro/
  relatorio/:id (admin). 8 checks no smoke (casos 41/42/43/21 do Master
  Command + só-leitura provado + cross-check delta 0).
- ✅ **PARTE 2 (22/08)** — Motor de regras: `avaliarRegras()` com 10 regras
  explicáveis (RULE_VIP_DAYS_FROM_PURCHASE, RULE_NO_EVIDENCE_VIP,
  RULE_DUPLICATE_PAYMENT, RULE_ORDER_WITHOUT_PAYMENT, RULE_CANCELLED_
  PAYMENT, RULE_PAYMENT_WITHOUT_ORDER, RULE_RECEIPT_REUSED, RULE_MISSING_
  RECEIPT, RULE_NEGATIVE_BALANCE, RULE_IMPOSSIBLE_EXPIRATION, RULE_
  REVENUE_MISMATCH). Cada finding: id ESTÁVEL (hash regra+alvo — dedupe de
  incidentes entre rodadas, item 26), severidade URGENTE/ALTA/MEDIA/BAIXA,
  confiança, esperado×atual, evidências, ação recomendada, valorImpacto.
  Lista priorizada (severidade > valor > confiança — item 58). Achado
  URGENTE/ALTA NOVO vira incidente na Central (pushGlobalEvent tipo
  `cerebro_*`); URGENTE novo dispara push aos admins. `findingsVistos` no
  cerebro_state (cap 800, preservado via spread no _gravarState).
  `problemas` = findings.length. Rota GET /api/admin/cerebro/erros
  (🔎 Encontrar erros). 5 checks novos (re-execução = 0 incidentes novos).
- ✅ **PARTE 3 (22/08)** — Correções: `planejarCorrecoes` separa SEGURAS
  (nível 2: `fix_dias` capa expiração no teto das evidências; `fix_caixa_
  cancelado` remove entrada de pedido cancelado espelhando o fluxo de
  cancelamento) de DECISÕES (nível 3: duplicado [remover_duplicado/manter/
  ignorar], sem-caixa/sem-evidência/comprovante-reusado/expiração-
  impossível [manter/ignorar]). `aplicarCorrecoesSeguras`: sem confirmar =
  SIMULAÇÃO; com confirmar = snapshot OBRIGATÓRIO (criarBackupCompleto ou
  aborta) + batch FIX-<auditId> + trilha no DB_ADMIN_AUDIT — fix_dias no
  formato {plan,vip} = REVERSÍVEL pelo botão ↩️ existente; fix de caixa usa
  alvo "pedido:"/"caixa:" de propósito (revert recusa 404 — nunca zeraria o
  plano de alguém; rollback = trilha alteracoes + snapshot). Idempotência
  pela AUDITORIA FRESCA (finding some ao corrigir; reaparece pós-rollback
  — correcoesAplicadas é só histórico, NUNCA trava). Central de Decisões:
  decisoesResolvidas nunca re-pergunta; remover_duplicado executa com
  trilha. Modo simulacao/auto-seguro/supervisionado no cerebro_state
  (Parte 6 obedece). Rotas: POST corrigir · GET decisoes · POST decisao ·
  POST modo. 7 checks (dry-run, apply, idempotente, rollback 1-clique,
  re-apply pós-rollback, decisão manter, modos).
- ✅ **PARTE 4 (22/08)** — Comprovantes em lote: `preCheckComprovante`
  extraída do fluxo de criação como FUNÇÃO ÚNICA (criação ativar:true =
  ativação provisória de sempre; lote do cérebro ativar:false — auditoria
  NUNCA ativa nada). Gancho de teste determinístico `TESTE_COMPROVANTE:
  <valor>` na nota (só com TEST_LOGIN_TOKEN — padrão do feed falso DOL).
  `rodarComprovantes`: fila educada em background (1 leitura/3s),
  INCREMENTAL (pendente = comprovante sem preCheck — cobre os importados
  dos servidores 2/3); sem chave Gemini fica HONESTAMENTE pendente (nunca
  inventa leitura — regra 29). `statusComprovantes`: não-conferidos/
  conferidos/divergentes. Regra nova RULE_RECEIPT_AMOUNT_MISMATCH
  (URGENTE: pago/ativo com leitura ≠ valor) — SEMPRE decisão [manter/
  ignorar], NUNCA correção automática (item 45). Rotas GET/POST
  /api/admin/cerebro/comprovantes(/rodar). 7 checks.
- ✅ **PARTE 5 (22/08)** — Dashboard: aba "🧠 Cérebro Contábil" no admin
  (sidebar DINHEIRO + régua 💰 + view-cerebro; loadCerebro/renderCerebroHome/
  renderCerebroErros/cerebroCarregarDecisoes + ações auditar/corrigir(simula
  →confirm)/comprovantes/decisao/modo). Cards item 38 + INTEGRIDADE
  CONTÁBIL % por fórmula DECLARADA (50% lançamentos ok · 30% dias ok ·
  20% penalidade: URGENTE −15pp, ALTA −5pp cada; componentes expostos —
  item 61: nunca esconder problema). `exportar()` CSV (; + BOM) e JSON do
  último relatório (ledger/divergências) via GET /api/admin/cerebro/
  exportar. `statusCerebro().resumo` (receita+integridade+contagens) pro
  dashboard abrir sem re-auditar. Conferência 2.0: rows de pedido levam
  `comprovanteLido`/`comprovanteVeredito` (triângulo por linha).
  Relatório por usuário continua na 💳 Auditoria (v141 — fonte única).
  ATENÇÃO guarda anti-função-fantasma do smoke: nome de função em
  COMENTÁRIO do admin.html conta como chamada. 5 checks. sw v114.
- ✅ **PARTE 6 (22/08) — PROJETO 100% CONCLUÍDO**: `rodarDiaria(quem)`
  (mod-cerebro) = pipeline autônomo — obedece o MODO do painel
  (auto-seguro roda `aplicarCorrecoesSeguras` com o snapshot embutido e
  re-audita DEPOIS, o relatório do dia reflete o estado final;
  supervisionado/simulacao só audita), carimba `ultimaDiaria
  {em,auditId,modo,problemas,aplicadas}` no cerebro_state e manda o
  relatório diário por push aos admins (item 50: usuários, lançamentos,
  problemas, receita confirmada, integridade %, correções). Agendador
  02h BRT DENTRO do bloco de robôs do server.listen (checa 10min,
  carimbo `_cbDiariaDia` — MODO_APOSENTADO já saiu com return antes,
  nunca audita dado congelado; re-rodada pós-restart é inofensiva:
  auditoria é só-leitura e o dedupe por id estável segura incidentes).
  IA administrativa `responder(pergunta)` (itens 36/64/66): resposta
  100% DETERMINÍSTICA montada do último relatório persistido (ramos:
  receita/dias/duplicados/comprovantes/sem-caixa/correções/integridade;
  default = resumo + exemplos), SEMPRE com fontes (auditId + o que foi
  analisado) — nenhuma IA calcula número nenhum; sem relatório = manda
  auditar primeiro, nunca inventa. Rotas: POST /api/admin/cerebro/
  diaria (AUDITAR AGORA do pipeline completo) · POST perguntar. Painel:
  caixa "💬 Pergunte ao Cérebro" + botão "▶️ Rodar o pipeline diário
  AGORA" + última rodada visível. 6 checks no smoke (supervisionado não
  aplica nada; auto-seguro aplica de verdade; 3 perguntas com fonte;
  estrutural do agendador). sw v115. O "Gemini só redige" ficou de fora
  DE PROPÓSITO: determinístico puro é mais seguro e o dono pode pedir a
  camada de redação depois — os números nunca dependerão dela.

## 🧠 CÉREBRO 2.0 — MASTER COMMAND 2 (22/08/2026) — PROJECT IMPLEMENTATION STATE

Segundo Master Command do dono (mesmo protocolo: avança só com "PRÓXIMA";
nunca refazer parte concluída; ao final de TODAS as partes, mandar o ZIP
completo). Análise entregue: grande parte já existia do Cérebro v1 — o
plano de **7 partes** cobre só o DELTA: (1) saldo esperado por linha do
tempo ✅ · (2) comprovantes 2.0 OCR completo + fingerprint/transação ·
(3) códigos & duplicidade multi-critério · (4) Central de Incidentes 2.0
com status · (5) dashboard receita por período/plano/método + Usuários
com semáforo + progresso da auditoria · (6) "minha conta em 5s" pro
usuário comum · (7) lote/background + UX admin + documentação +
auditoria final + ZIP.

- ✅ **PARTE 1 (22/08) — Relógio das concessões**: `auditarDias` ganhou a
  LINHA DO TEMPO por usuário — cada concessão datada estende a expiração
  a partir de `max(quando, expiração vigente)` (igual o motor real);
  fontes datadas: vip.creditos[].quando · pedidos pago/ativo não-doação
  (ativadoEm/dataPagamento/criadoEm, dedupe por pedidoId) · diamondLedger
  troca.ts · carimbo `_fusao` (dias somados do irmão — legítimos por
  ordem do dono). Evento SEM data (código: usedBy não guarda quando) é
  aplicado HOJE — a forma MAIS generosa; margem 2 dias; só fala quem tem
  ≥1 evento datado; usuário já flagrado pelo teto não repete (continue).
  Regra nova `RULE_VIP_DAYS_PURCHASE_DATE_RECONCILIATION` (ALTA;
  URGENTE se +30) — SEMPRE decisão [manter/ignorar], NUNCA correção
  automática (duas explicações possíveis = incidente, item do Master).
  Pega o que o teto não pega: 3×30 na vida = teto 90 esconde um 30→60
  de hoje; o relógio flagra. `_fixDias` agora REVALIDA o gravado depois
  do setUser e aborta se não bater ("validar antes E depois — senão
  bloquear"); integridade % conta os flagrados; responder() cita a linha
  do tempo. rel.dias.timeline {avaliados, margemDias, flagrados[50]}.
  **Revisão adversarial (3 revisores independentes) em cima da 1ª versão
  achou e eu corrigi ANTES do deploy**: (a) campo de data de pedido
  ERRADO — `dataPagamento` é do caixa, pedido usa `pagoEm`; cadeia agora
  espelha a reconciliação do boot (ativadoEm→pagoEm→criadoEm) e os dias
  do pedido usam a MESMA fórmula dela (`_diasPed`: diasTotal senão
  base+bônus padrão 30); (b) gift-days (vip.giftHistory) era invisível —
  cliente compensado seria acusado e o auto-fix do teto podia CORTAR o
  presente; giftHistory agora entra no teto E na linha do tempo; (c)
  set-expiry (13r) não deixava evidência nenhuma — a rota agora grava
  crédito datado (max dos 2 relógios) + carimbo `adjustedCreditado`, e
  ajuste LEGADO (adjustedAt sem carimbo) é ANCORADO: listado em
  rel.dias.ancorados, fora de acusação (nunca escondido — item 61); (d)
  vip/activate registrava só dias manuais no crédito — agora
  max(days,autoDays); (e) `auto-provisorio` (13b) pulado como trial; (f)
  sanidade TS_MIN=1.4e12 (timestamp em segundos importado viraria 1970 e
  acusaria inocente). 7 checks novos (fixtures sessentadias, presente,
  ajustado). Total da suíte: 394.
- ✅ **PARTE 2 (22/08) — Comprovantes 2.0**: OCR COMPLETO no
  `preCheckComprovante` — além de valor/data, extrai hora, pagador,
  recebedor, instituição e ID da transação (E2E do PIX), com ordem
  expressa de nunca inventar (campo ausente = null). FINGERPRINT SEMPRE:
  o hash SHA-256 é calculado no começo da função, mesmo sem chave Gemini
  e no gancho de teste — comprovante importado dos servidores 2/3 ganha
  impressão digital na auditoria (antes o hash só nascia dentro do
  caminho da IA). Regra nova `RULE_TRANSACTION_ID_REUSED` (URGENTE,
  sempre decisão): mesma transação E2E em 2+ pedidos — pega o "mesmo PIX
  re-fotografado" (arquivos/hashes diferentes, transação igual), vale
  até pro mesmo usuário; id <6 chars não acusa (leitura fraca). Gancho
  de teste estendido `TESTE_COMPROVANTE:<valor>[:<tx>[:<pagador>]]`
  (compatível com os antigos). Conferência mostra a leitura completa
  por linha (veredito/valor/pagador/banco/TX — comprovantePagador/
  Transacao/Instituicao nas rows) e statusComprovantes.divergentes
  carrega os campos. 5 checks novos (fixtures pedtx1/pedtx2). sw v119.
  Total da suíte: 399.
- ✅ **PARTE 3 (22/08) — Códigos & duplicidade multi-critério**:
  Motor 5: `RULE_CODE_OVERUSED` (URGENTE — usedBy > maxUses, trava
  furada) e `RULE_CODE_SOURCE_NO_RECORD` (ALTA — VIP ativo source
  "code" sem constar no usedBy de código nenhum). Duplicidade ENTRE
  usuários (`duplicidadesCrossUser` no ledger →
  `RULE_CROSS_USER_DUPLICATE`): mesmo valor +30 · <10min +30 / <48h
  +15 · mesmo arquivo +40 · mesma transação E2E +45 · mesmo NOME de
  pagador (OCR ou caixa, normalizado, >5 chars) +25 — régua 61, então
  valor+janela sozinhos (45 ou 60) NUNCA acusam (pagar preço de tabela
  no mesmo dia é normal); grupo com >20 lançamentos do mesmo valor é
  pulado (preço popular). Score clássico (mesmo usuário) ganhou o
  motivo de transação (+45). Entries do ledger carregam nomePagador/
  hash/tx. Os 3 achados são SEMPRE decisão [manter/ignorar].
  responder() cita os casos cross-user. 5 checks novos (fixtures
  OVERUSE1, codeghost, fghost1/fghost2 "Maria Pagadora Silva").
  Total da suíte: 404.
- ✅ **PARTE 4 (22/08) — Central de Incidentes 2.0**: cada finding (id
  estável) vira INCIDENTE com ciclo de vida no cerebro_state
  (`incidentes`, cap 500 com prioridade pros abertos; histórico cap 30):
  🔴 NOVO → 🔵 AGUARDANDO_ADMIN (tem decisão pendente) / 🟡 EM_ANALISE →
  🟢 RESOLVIDO / ⚫ IGNORADO / 🟣 CORRIGIDO_AUTO. `_syncIncidentes` roda
  DENTRO de toda auditoria: finding que some = RESOLVIDO sozinho (com
  registro); que volta = REAPARECE como NOVO — MAS decisão explícita do
  admin (manter/ignorar) NUNCA reabre (o finding continua existindo de
  propósito), e decisão registrada antes da Central existir é aplicada
  retroativamente. Ações por incidente (`incidenteAcao`): analisar/
  manter/ignorar/corrigir — corrigir individual (`corrigirUm`, lote
  FIX1-<auditId>) tem o MESMO rigor do lote: auditoria fresca + snapshot
  obrigatório + trilha reversível; incidente sem correção automática
  recusa com explicação (nunca inventa). decidir() move o incidente
  junto e o branch remover_duplicado passou a RELER o state pós-audit
  (gravar o snapshot velho apagaria o sync). Rotas: GET /api/admin/
  cerebro/incidentes · POST incidente {id,acao}. Painel: botão 🚨
  Incidentes (contador de abertos) na aba 🧠 com chips por status,
  histórico e botões por incidente. statusCerebro().incidentesAbertos.
  5 checks novos. sw v120. Total da suíte: 409.
- ✅ **PARTE 5 (22/08) — Dashboard detalhado + semáforo**:
  `rel.receitaDetalhada` — janelas SEMPRE por `computeEntradasJanelas`
  (13n, provado no teste: total idêntico ao cross-check), quebra por
  plano/tipo (doacao/plano/avulso; planoOriginal da doação normalizada
  v154 preserva o rótulo) e top 10 doadores; vai no resumo persistido
  (dashboard abre sem re-auditar) e numa seção da aba 🧠 (janelas +
  chips por plano + top doadores clicáveis). `flagsPorUsuario()` —
  semáforo por e-mail derivado do último relatório + incidentes ABERTOS
  (resolvido/ignorado não pinta ninguém), e-mails extraídos do alvo E
  do título do finding, cache 60s invalidado ao fim de toda auditoria;
  `/api/admin/live` anexa `cerebro:{nivel,motivos}` e o card de
  Usuários mostra 🔴/🟡 clicável pra 💳 Auditoria (verde = sem selo).
  Auditoria com etapas ao vivo (⏳🔎💰🧾📦🎟️📅🔁🧠📊) no painel.
  4 checks novos. sw v121. Total da suíte: 413.
- ✅ **PARTE 6 (22/08) — "Minha Conta em 5 segundos"**: o card
  `#plan-status-card` da aba Planos virou a visão completa do usuário
  comum — aparece pra TODO MUNDO (usuário Grátis antes não via NADA:
  agora vê 🆓 plano + limite/dia + convite de troca), mantém as barras
  de dias manual/auto com vencimento e ganhou saldo 💎 real/bônus (com
  a nota "bônus só vale pra troca") e o status da ÚLTIMA doação
  (🕐 aguardando admin / ✅ confirmada / ❌ cancelada) via
  `_mcUltimoPedido` (/api/pedidos filtrado por U.email no front —
  admin recebe a lista toda). Linguagem 100% v66 (doação/troca, nunca
  compra). i18n mc_1..mc_12 nas 3 línguas (regra 6f). 3 checks novos.
  sw v122. Total da suíte: 416.
- ✅ **PARTE 7 (22/08) — FINAL · CÉREBRO 2.0 100% CONCLUÍDO**: (1)
  ESCALA — `auditarBg()` roda a varredura completa FORA da requisição
  ({background:true} no POST auditar; job em statusCerebro().auditJob) e
  as leituras (incidentes/decisões) reusam o relatório por 10s
  (`_relFresco`) — correções e o botão AUDITAR continuam SEMPRE frescos;
  (2) Visão do Dono ganhou a faixa `#dono-cerebro-strip` ("existe algo
  precisando de mim?") — só aparece com incidente aberto ou integridade
  <90%, lê apenas o status persistido (nunca dispara auditoria) e clica
  pra aba 🧠; (3) DOCUMENTACAO_MESTRA ganhou a seção completa "🧠
  CÉREBRO CONTÁBIL" (arquitetura, dados, 6 motores, correções/segurança,
  incidentes, autonomia/escala, rotas, testes) + nota v156 marcando a
  seção multi-servidor como histórica; (4) 🧠 AUDITORIA FINAL no smoke:
  pipeline diário completo com crossCheck delta R$0, integridade
  calculada e TODOS os motores presentes no relatório. 5 checks novos.
  sw v123. Total da suíte: 421. ZIP completo entregue ao dono.

## 🤖 CÉREBRO 3.0 — MASTER COMMAND 3 (22/08/2026) — PROJECT IMPLEMENTATION STATE

Terceiro Master Command (mesmo protocolo: "PRÓXIMO" avança; nunca refazer
parte concluída). Núcleo do pedido: o Gemini JÁ INSTALADO vira o motor
inteligente do cérebro (camada 4) + tudo clicável + registro de
comprovantes + decisões caso-pronto + ajustes sem apagar + tempo real +
filtros/busca + aprendizado. Plano de **8 partes** (só o delta — v1/2.0
já cobrem o resto):
(1) camada Gemini ✅ · (2) drill-down: todo card clicável · (3) Registro
de Comprovantes + receita sem comprovante · (4) Decisões 2.0 caso-pronto
(ações: confirmar pagamento/registrar entrada/pagamentos diferentes) ·
(5) ajustes contábeis AJUSTE± no caixa (nunca apagar) · (6) tempo real
(gatilhos incrementais pós-aprovação/cancelamento) · (7) Conferência
filtros/busca 2.0 + exportações novas · (8) aprendizado com decisões +
auditoria final + ZIP.

- ✅ **PARTE 1 (22/08) — Gemini como camada 4**: dep `gemini(prompt)`
  injetada no mod-cerebro (MESMA chave/modelo gemini-2.0-flash de todo o
  site — nenhuma 2ª IA; gancho de teste com TEST_LOGIN_TOKEN devolve
  análise fixa e o pipeline roda inteiro sem rede). `rodarIA(limite)`:
  fila educada (1/2s prod) SÓ sobre decisões AMBÍGUAS — nunca conta
  simples, nunca dentro da auditoria determinística (guarda estrutural
  no smoke). Cache por `inputHash` (sha256 promptVersion+contexto):
  mesmas evidências = nunca re-chama (item 33). AI_ANALYSIS_LOG em
  DATA/cerebro/ai_analysis_log.json (cap 500): findingId, rule, alvo,
  inputHash, promptVersion cb-ia-v1, model, nivel SUGGEST, resultado
  {classificacao whitelist DUPLICIDADE_PROVAVEL/PAGAMENTOS_DIFERENTES/
  DIVERGENCIA_REAL/PROVAVEL_LEGITIMO/SEM_EVIDENCIA/NECESSITA_DECISAO —
  fora do contrato vira NECESSITA_DECISAO, probabilidade 0-100 clampada,
  explicacao citando evidências}. Sem chave = erro honesto ("análises
  ficam pendentes — a IA nunca inventa"). Decisões e incidentes carregam
  `ia:{classificacao,probabilidade,explicacao,acaoRecomendada,em,
  promptVersion,model}`. Rotas: GET /api/admin/cerebro/ia · POST
  ia/rodar. Painel: botão 🤖 Análise IA + caixa verde da IA nas decisões
  e incidentes. 5 checks. sw v124. Total da suíte: 426.
- ✅ **PARTE 2 (22/08) — Tudo clicável**: `listarCategoria(tipo,janela)`
  no mod-cerebro (registrada/confirmada/duplicada/duvida/cancelada/
  semComprovante/comprovantesPendentes) — lista do ÚLTIMO relatório
  persistido (nunca re-audita pra listar), rows com data/email/plano/
  valor/status/classificação/confiança/score+motivos/📎, janela opcional
  1/7/30 dias com o corte no título, cap 300 rows. Indicador NOVO
  `receita.semComprovante` (item 9 — dinheiro registrado sem comprovante
  anexado, sem contar transação 2x). Rota GET /api/admin/cerebro/lista.
  Painel: _cbCard ganhou clique (↗) — TODOS os cards abrem lista (incl.
  cards novos 🚫 CANCELADA e 📎 SEM COMPROVANTE), DIVERGÊNCIAS →
  incidentes, INTEGRIDADE → auditoria; janelas hoje/7/30 da receita
  detalhada clicáveis; linha da lista → 💳 Auditoria do usuário.
  Guarda do teste: valorTotal da lista bate EXATO com o número do card.
  5 checks. sw v125. Total da suíte: 431.
- ✅ **PARTE 3 (22/08) — Registro de Comprovantes**:
  `registroComprovantes(status,busca)` — 1 linha por comprovante (hash,
  leitura completa do OCR, pagador/instituição/TX) com STATUS derivado
  das MESMAS regras dos motores (nunca 2ª lógica): VÁLIDO — CONFIRMADO
  (CONFERE + pago/ativo) · VÁLIDO · DUPLICADO (mesmo arquivo OU mesma
  transação, apontando os pares) · DIVERGENTE · INCOMPLETO (PDF/
  ilegível) · EM ANÁLISE (sem leitura — importados) · CANCELADO.
  Contadores por status (soma = total, provado no teste), busca
  multi-campo (email/nome/pagador/TX/hash/valor/pedidoId), cap 300.
  Rota GET /api/admin/cerebro/comprovantes/registro. Painel: botão 🗂️
  na aba 🧠 com chips-filtro clicáveis, busca e 📎 abrir comprovante.
  5 checks. sw v126. Total da suíte: 436.
- ✅ **PARTE 4 (22/08) — Decisões 2.0 caso-pronto**: cada decisão da
  Central chega EXECUTÁVEL. (1) `[💰 Registrar entrada no caixa]` no
  pedido ativo sem caixa (caso Cleiton): `RULE_ORDER_WITHOUT_PAYMENT`
  virou decisão própria com `execucao {pedidoId,email,valor}` vindos de
  `pedidosSemCaixa`; o branch `registrar_entrada` do `decidir()` só roda
  APÓS o clique do admin (dinheiro é decisão humana — o cérebro nunca
  registra sozinho): snapshot obrigatório (criarBackupCompleto ou
  aborta), lançamento com `origem:"cerebro_confirmacao_manual"` +
  `confirmadoPor`, `dataPagamento` do `pagoEm/ativadoEm` do pedido
  (mesma semântica do fluxo de aprovação), trilha em `fin.alteracoes`
  (tipo `registrar_pagamento`) + Audit Log, e IDEMPOTENTE: caixa que já
  tem entrada do pedido devolve `jaExistia` e NUNCA duplica (regra 8 do
  dinheiro — provado no teste: repetir a decisão deixa EXATAMENTE 1
  lançamento e o crossCheck segue delta R$0). (2) `[🆗 São pagamentos
  DIFERENTES]` nas 3 suspeitas de duplicidade (`RULE_DUPLICATE_PAYMENT`
  ganha a 4ª opção; `RULE_TRANSACTION_ID_REUSED` e
  `RULE_CROSS_USER_DUPLICATE` trocam pra
  [pagamentos_diferentes/manter/ignorar]): grava a CONCLUSÃO semântica
  (com rule+alvo em `decisoesResolvidas` — alimenta o aprendizado da
  P8), resolve o incidente com "são pagamentos DIFERENTES" na história,
  e o motor RECUSA a opção em decisão que não é de duplicidade. (3)
  Contexto caso-pronto em TODA decisão: `_ctxDecisao(fd)` extrai
  e-mails (≤3, sem admin) e pedidos (≤3, regex `pedido #`) de
  alvo+título+evidências → painel renderiza botões 👤 (abre a 💳
  Auditoria do e-mail) e 📎 (abre o comprovante do pedido) em cada
  card, + confirms específicos por ação. Asserções antigas das opções
  atualizadas (2.0-P2/P3). 5 checks. sw v127. Total da suíte: 441.
- ✅ **PARTE 5 (22/08) — AJUSTE±: o caixa NUNCA apaga**: "remover do
  caixa" morreu — `_removerDoCaixa` virou `_anularNoCaixa` (mesma função
  única usada por fix_caixa_cancelado E remover_duplicado): o original
  fica no caixa marcado `anuladoPor {ajusteId,em,motivo,por}` e entra um
  lançamento pareado `tipo:"ajuste"` com valor NEGATIVO igual ao valor
  EFETIVO (mesma regra "pedido vence caixa"), `ajustaPagamentoId`/
  `ajustaPedidoId`, motivo e trilha `ajuste_pagamento` em
  fin.alteracoes. SEM `pedidoId` próprio de propósito — a correção
  "pedido vence caixa" nunca pode reescrever um ajuste; o canônico
  (computeEntradasJanelas) e o ledger somam os dois lados cru e o
  líquido fica idêntico ao da exclusão antiga (delta R$0 provado).
  Ledger: entry AJUSTE (classificacao própria, confiança 100, motivo
  nas evidências) e original ANULADO — ambos FORA de duplicidade
  (senão anular um duplicado nunca faria o achado sumir), do
  semComprovante e do RULE_PAYMENT_WITHOUT_ORDER; ANULADO não conta
  como "tem caixa" (pedido pago com entrada anulada volta a precisar de
  evidência) e não vira CONFLICT (idempotência do fix do cancelado no
  novo modelo). `receita.ajustes` (soma ±) + card "🧮 AJUSTES NO CAIXA"
  clicável + `listarCategoria('ajustes')` com motivo por linha. Ajuste
  MANUAL do admin: `ajustarCaixaManual` (POST /api/admin/cerebro/ajuste
  — botão 🧮 no painel): ± ancorado num lançamento existente (id OU
  pedidoId), motivo OBRIGATÓRIO ≥5 chars, valor ≠ 0, snapshot antes
  (regra 32), NUNCA anula ninguém — só adiciona. Asserção antiga do
  fcanc1 invertida (era "sumiu do caixa", agora "preservado + par
  −99"). 5 checks. sw v128. Total da suíte: 446.
- ✅ **PARTE 6 (22/08) — TEMPO REAL**: o cérebro reage na hora, não só
  às 02h. `notificarEvento` (mod-cerebro) + helper `_cbTempoReal` no
  server.js (try interno — o hook NUNCA quebra o fluxo que o chamou)
  nas 4 rotas de dinheiro: aprovação de doação, cancelamento de pedido
  e correção de valor (Conferência + pedido-set-valor). Eventos entram
  numa janela com DEBOUNCE (45s prod — aprovar 5 pedidos seguidos = 1
  auditoria, nunca 5) e viram UMA auditoria COMPLETA de sempre (fonte
  única — sem mini-verdade incremental): incidentes sincronizam,
  URGENTE novo dispara push, semáforo atualiza. Nunca roda por cima do
  `_audJob` (re-agenda). Carimbo `tempoReal {ultimaReacao{em,eventos,
  auditId,problemas}, ultimosEventos}` no cerebro_state; statusCerebro
  expõe `tempoReal {aguardando, debounceMs}`. `reagirAgora()` = flush
  manual (POST /api/admin/cerebro/reagir + botão "⚡ Reagir agora" na
  faixa do painel). **No npm test o timer NUNCA dispara sozinho
  (debounce 600s > suíte — senão as auditorias em background quebrariam
  asserções antigas tipo `incidentesNovos >= 3` e criariam corrida em
  todo o resto); o flush determinístico é o reagirAgora(), e o teste
  prova que os hooks acumularam os eventos REAIS da suíte inteira.**
  5 checks. sw v129. Total da suíte: 451.
- ✅ **PARTE 7 (22/08) — Conferência filtros/busca 2.0 + exportações**:
  o builder da Conferência virou fonte ÚNICA `_confData()` +
  `_confFiltrarRows()` (server.js) — a lista E a exportação usam o
  MESMO builder e o MESMO filtro. GET /api/admin/conferencia aceita
  `q` (busca multi-campo: nome/e-mail/pedido/código/plano/status/
  pagador OCR/transação/instituição/valor), `status`, `tipo`,
  `janela` (1/7/30 dias sobre `em`) e devolve `filtrados`+
  `valorFiltrado`; SEM parâmetro = comportamento idêntico ao de sempre
  (rows completas). GET /api/admin/conferencia/exportar emite CSV
  (; + BOM, OCR por coluna: veredito/valorLido/pagador/transacao/
  instituicao) ou JSON com os MESMOS filtros — o admin baixa
  exatamente o que a tela mostra (filename ganha "-filtrada" quando
  há filtro). Front: busca nova multi-campo, selects status/janela,
  contador `#conf-count` (n de N + R$ do filtro) e botões ⬇️ CSV/JSON
  (`confExportar` abre a rota com `_confFiltroAtual()` — filtro do
  cliente espelha o do servidor campo a campo). 4 checks. sw v130.
  Total da suíte: 455.
- ✅ **PARTE 8 (22/08) — FINAL · CÉREBRO 3.0 100% CONCLUÍDO**:
  aprendizado com decisões (item "registrar, NUNCA treinar"):
  `aprendizado()` agrega `decisoesResolvidas` por regra e escolha;
  TODA escolha nova grava `rule`+`alvo` (manter/ignorar puxam a regra
  do incidente de mesmo id; remover_duplicado/registrar_entrada/
  pagamentos_diferentes gravam da própria decisão — registros antigos
  sem regra caem em "(regra não registrada)"). `listarDecisoes` anexa
  `historicoParecido {jaDecididas, escolhas}` (via `_histRegra`) e o
  card mostra "📚 Em N caso(s) desta regra você decidiu X" — sempre
  informativo: NUNCA suprime achado nem decide sozinho. O histórico
  entra no `_iaContexto` como `historicoAdmin` e no prompt como
  "HISTÓRICO (informativo, não é regra)" — participa do inputHash,
  então histórico novo invalida o cache sozinho (item 33; a
  promptVersion cb-ia-v1 não muda). Rota GET /api/admin/cerebro/
  aprendizado + linha 📚 no painel. DOCUMENTACAO_MESTRA ganhou a seção
  "🤖 CÉREBRO 3.0" (8 partes + rotas novas). 🏁 AUDITORIA FINAL no
  smoke: pipeline diário com TODOS os motores do 3.0 vivos no mesmo
  relatório (IA, listas, registro, ajustes, tempo real, Conferência
  2.0, aprendizado) e crossCheck delta R$0. 4 checks. sw v131.
  Total da suíte: 459. ZIP completo entregue ao dono.

## 💼 CÉREBRO 4.0 — MASTER COMMAND 4 (28/08/2026) — PROJECT IMPLEMENTATION STATE

Quarto Master Command do dono ("eu preciso saber quanto eu tenho a receber e
quanto diego tem a receber... adicionar gastos com comprovante... trabalho de
contabilidade... como se fosse uma empresa de milhões, com relatórios sobre
tudo"). Mesmo protocolo: avança só com "PRÓXIMO"; nunca refazer parte
concluída. Análise achou MUITO já pronto (add_gasto com comprovante,
add_repasse, edit/delete com trilha append-only, fin-insights despSocio) — o
plano de **5 partes** cobre só o delta: (1) Motor de Sócios & Acerto ✅ ·
(2) Gastos com comprovante DENTRO da aba 🧠 + DRE-base no relatório da
auditoria · (3) DRE mensal completo (por mês/plano/categoria/sócio) +
exportações + relatório executivo · (4) Acerto operacional: registrar
repasse pela aba 🧠 + front Financeiro consome a fonte única (mata o
finCalcAcerto client-side — 2ª verdade, risco 13n) · (5) Auditoria &
fechamento mensal imutável + regras novas no motor + responder() do cérebro
responde "quanto tenho a receber" + push + docs + ZIP.

- ✅ **PARTE 1 (28/08) — Motor de Sócios & Acerto**: `computeSocios()`
  (server.js, ao lado de computeEntradasJanelas) é a FONTE ÚNICA de "de
  quem é cada real" — régua de valor IDÊNTICA ao canônico (exclui admin,
  pedido corrigido vence o caixa; o smoke prova
  `liquidoContabil === computeEntradasJanelas().total` com delta R$0
  EXATO). Dono de cada entrada, nesta ordem e sempre explicável:
  recebidoPor explícito ('andrio'|'diego') → lançamento de AJUSTE herda o
  dono do pagamento que anula (senão o par negativo cobraria outro sócio)
  → derivado da TRILHA (ativadoPorEmail→lancadoPorEmail→confirmadoPor→
  porEmail, via editorFromEmail; contado à parte como "derivado") → SEM
  DONO (nunca chuta; lista ≤50 pro admin atribuir em 1 clique).
  Matemática declarada (`formula` na resposta): lucroDistribuível =
  líquido − gastos; direito = lucro × fração do split
  (DB_ADMIN_SETTINGS.sociosSplit, padrão 50/50, POST
  /api/admin/socios/split valida ≥0/soma>0 + logAdminAction); posição =
  recebido − gastos que pagou do bolso − repasses feitos + repasses
  recebidos; TEM A RECEBER = direito − posição. Gasto conta pelo
  g.pagoPor (andrio/diego = do bolso, a receber de volta; empresa = só
  sai do lucro); repasse (add_repasse, já existia) muda só a POSIÇÃO.
  Rota GET /api/admin/socios (admin). Painel: seção "💼 Sócios & Acerto"
  no TOPO da aba 🧠 (cards TEM A RECEBER/DEVE REPASSAR por sócio com a
  conta aberta, editor de split, box "entradas sem dono" com atribuição
  em 1 clique via edit_pagamento existente, Δ da checagem sempre
  visível). BUG REAL corrigido de raiz: edit_pagamento aceitava QUALQUER
  string em recebidoPor/pagoPor (texto livre no dono do dinheiro —
  lançamento sumia do acerto em silêncio); agora é ENUM com 400 na cara
  e "" limpa de propósito. 8 checks no smoke (invariante delta R$0,
  gastos/repasses exatos, sem-dono nunca chuta, matemática fecha com
  centavo, enum 400, atribuição +77 exatos, split 70/30 na hora +
  inválido 400, estrutural). PROIBIDO: recalcular acerto/atribuição em
  qualquer tela (sempre computeSocios) e aceitar dono de dinheiro fora
  do enum. sw v134. Total da suíte: 474.
- ✅ **PARTE 2 (28/08) — Gastos com comprovante na aba 🧠 + DRE-base**: o
  dinheiro que SAI ganhou a régua do que entra. (1) `rel.dre` em toda
  auditoria (mod-cerebro, logo após receitaDetalhada): receita líquida
  SEMPRE por `computeEntradasJanelas` (13n — a MESMA régua do
  computeSocios, nunca uma 3ª verdade) − gastos do caixa de despesas =
  resultado + margem%, com quebra porCategoria/porPagador/semComprovante
  e fórmula declarada; entra no `resumo` persistido (dashboard abre sem
  re-auditar). (2) Regra nova `RULE_GASTO_SEM_COMPROVANTE` (MEDIA, 75):
  gasto sem comprovante/img vira finding+incidente — NUNCA correção nem
  decisão automática (o comentário do planejarCorrecoes já regia isso
  pra MEDIA/BAIXA); alvo é `gasto:<id>`, NUNCA e-mail (o semáforo de
  usuários extrai e-mails de alvo/título — ninguém é pintado por
  despesa da empresa). (3) `listarCategoria('gastos')` lê o caixa VIVO
  (modelo do 'cancelada') — cards 💸 GASTOS e 📈 RESULTADO (DRE)
  clicáveis, valorTotal bate exato com o DRE. (4) Botão "💸 Registrar
  gasto" na aba 🧠: formulário com valor/categoria/data/pagoPor/
  descrição + comprovante comprimido (reusa finPreviewImg/
  finGetImgBase64 e a rota EXISTENTE add_gasto com trilha/rollback —
  nada duplicado); sem comprovante = confirm honesto avisando que a
  auditoria vai apontar. 5 checks novos (DRE fecha exato com o caixa e
  as janelas; regra aponta gsm1/gsm2 e nunca gsm3; lista bate com card;
  gasto novo +R$35,50 exatos no DRE sem pendência; resumo persistido +
  estrutural da UI). sw v135. Total da suíte: 479.
- ✅ **PARTE 3 (28/08) — DRE mensal + relatório executivo**: a régua de
  VALOR e de DONO virou helper de módulo (`_finValorEfetivo`/`_finDonoDe`,
  server.js) — compartilhada por computeSocios (acerto) E pelo novo
  `computeDreMensal()`: receita/gastos/resultado MÊS A MÊS com quebra por
  sócio (mesma régua do Acerto), por plano (planoOriginal preservado,
  v154) e por categoria de gasto; mês da receita por dataPagamento||data||
  criadoEm (precedência do canônico), do gasto por dataGasto. Soma dos
  meses = computeEntradasJanelas (delta R$0 provado) e TODO mês fecha
  internamente (porSocio/porPagador/porPlano/categorias = total do mês,
  centavo fechado — 4 invariantes no smoke). `relatorioExecutivoDre()`:
  100% DETERMINÍSTICO (princípio do responder() — IA nunca calcula
  número), sempre com fontes: mês atual vs anterior (crescimento %),
  top plano/categoria, acumulado+margem, acerto de cada sócio, aviso de
  sem-dono. Rota GET /api/admin/dre (JSON com executivo embutido; ?fmt=
  csv exporta ;+BOM com 1 linha/mês + TOTAL). Painel: botão "📅 DRE
  mensal" na aba 🧠 (executivo + tabela com detalhe por mês + exports).
  PROIBIDO: qualquer 2ª régua de dono/valor — sempre _finDonoDe/
  _finValorEfetivo. 5 checks. sw v136. Total da suíte: 484.
- ✅ **PARTE 4 (28/08) — Acerto operacional (a 2ª verdade morreu)**:
  `finCalcAcerto` (admin.html) foi EXCLUÍDO — somava valor cru sem
  pedido-vence-caixa, sem split, sem excluir admin, e entrada sem dono
  virava "Andrio" na marra. O card "Acerto entre sócios" do 💰 Financeiro
  e o Robô de Conferência agora consomem SÓ `GET /api/admin/socios`
  (computeSocios — fonte única 13n); se a rota falhar, a tela avisa e o
  robô pula o acerto — NUNCA recalculam local. Card refeito: Recebeu −
  Gastos do bolso ± Repasses = Posição × 🎯 Direito pelo split (a linha
  "Metade gastos empresa" morreu — gasto empresa sai do lucro via
  direito); cards fin-andrio/fin-diego mostram o direito real; aviso de
  entradas sem dono aponta pra aba 🧠. Aba 🧠 ganhou "🤝 Registrar
  repasse" (cerebroRepasseForm — rota EXISTENTE add_repasse, nada
  duplicado): pré-seleciona quem DEVE repassar e sugere o valor do
  acerto; lista últimos repasses com exclusão auditada (delete_repasse,
  motivo obrigatório). 3 checks (repasse move acerto EXATO ±25 com soma
  conservada e delta R$0; exclusão devolve o estado anterior + 404 na
  repetição; estrutural: zero chamadas a finCalcAcerto, ≥3 consumos da
  fonte única, UI de repasse viva). sw v137. Total da suíte: 487.
- ✅ **PARTE 5 (28/08) — FINAL · CÉREBRO 4.0 100% CONCLUÍDO**:
  📕 FECHAMENTO MENSAL IMUTÁVEL — POST /api/admin/fechamento congela o
  DRE do mês (snapshot em DATA/fechamentos.json + trilha no Audit +
  push aos admins); refechar dá 409 SEMPRE (imutável de verdade); mês
  sem movimento dá 400. GET /api/admin/fechamentos lista cada
  fechamento com a divergência AO VIVO (congelado × hoje). Regra nova
  `RULE_FECHAMENTO_DIVERGENTE` (ALTA, 90): dinheiro mexido DENTRO de
  mês fechado (lançamento/edição retroativa) vira finding+incidente —
  SEMPRE decisão humana [manter/ignorar] (pode ser correção legítima),
  nunca correção automática. O cérebro ganhou as deps computeSocios/
  computeDreMensal/lerFechamentos; `responder()` responde "quanto eu
  tenho a receber?" com o acerto AO VIVO da fonte única (ramo vem
  ANTES do de receita — "receber" casaria com /recebe/; "quanto
  realmente recebemos?" continua no ramo de receita, provado no
  teste); a push diária do cérebro carrega o acerto dos 2 sócios.
  Painel: botão "📕 Fechamento mensal" na aba 🧠 (fechar mês aberto +
  lista com selo ✅ íntegro / ⚠️ divergente). DOCUMENTACAO_MESTRA
  ganhou a seção "💼 CÉREBRO 4.0" completa (5 partes + rotas +
  invariantes). 4 checks (409/400/íntegro; divergência EXATA Δ10 +
  regra ALTA com decisão; responder com números idênticos ao
  computeSocios; estrutural+docs). sw v138. Total da suíte: 491.
  ZIP completo entregue ao dono.

## 🔍 MC5 — CAIXA CRISTAL (29/08/2026) — PROJECT IMPLEMENTATION STATE

Quinto Master Command ("você decide as próximas 100 coisas pra deixar isso
funcional e transparente... recebe, identifica valor/data/comprovante, faz
o check, quem recebeu quanto? quem gastou quanto? decida você em quantas
partes"). Plano nasceu de AUDITORIA real (5 auditores paralelos, ~90
achados com evidência file:line em /tmp .../w8c7mtas1.output; 12 confirmas
de já-existe). **10 partes × ~10 itens = ~100 coisas** (avança com
"PRÓXIMO"; nunca refazer parte concluída):
(1) ✅ Porta de entrada blindada · (2) o usuário vê tudo (cancelamento com
push+motivo, Minhas doações da era doação, status do comprovante,
extrato 💎 completo, whitelist /api/pedidos [vaza e-mail alheio no
dupAlerta!], packs 13c, promessa 24h honesta) · (3) uma régua só nas telas
do admin (Total recebido híbrido Math.max, canônico com admin, aba Mensal
client-side, CSV cru, lucro Math.max(0) vs DRE, gastos30d lê campo errado
[sempre R$0!], pagEditarValor hardcoda andrio) · (4) tudo clicável e
explicado (cards do dono, 📖 Entenda os números, Faturamento Global
aposentado, lote com progresso) · (5) quem recebeu/gastou 100% (3 caminhos
de ativação sem recebidoPor, gasto recorrente, USD, repasse com
comprovante, OCR de gasto/entrada manual, DRE corte BRT) · (6) o caixa
nunca apaga (cancelamento vira AJUSTE−, persist conferido, action
desconhecida 400, eventos tempo-real sobrevivem deploy) · (7) vigias que
nunca dormem (carimbo diária em disco+catch-up, dead-man's switch, Gemini
quebrado → push, retry com teto, tempo real em TODAS as rotas de dinheiro,
auto-fechamento de meses antigos) · (8) relatórios prontos (semanal/mensal
push, histórico) · (9) RAM e velocidade (comprovantes → disco, /api/status
1 passada, poda AUDIT-*.json, ledger 💎 sem cap destrutivo, DATA/cerebro
no backup) · (10) prova final (i18n dinheiro, v66 'Renove', revisão
Chromium, drills, docs, ZIP).

- ✅ **PARTE 1 (29/08) — Porta de entrada blindada**: (1) aprovação agora
  ENXERGA o pré-check: leitura DIVERGENCIA/ILEGIVEL/SEM_COMPROVANTE ou
  valorLido ≠ valorTotal → 409 confirmável mostrando os números
  (confirmarDivergencia — padrão confirmarDuplicado; o humano decide
  VENDO); (2) comprovante JÁ USADO (mesmo hash SHA-256 OU mesma transação
  E2E) em pedido pago/ativo de QUALQUER usuário → 409 confirmável
  (confirmarComprovanteUsado) — fecha a janela entre o golpe e a
  auditoria das 02h; (3) banner de aprovação mostra o OCR INTEIRO
  (pagador/banco/hora/transação); (4) DOAÇÃO nunca mais cai no dedup de
  pendente (o PIX é feito ANTES do envio — engolir o 2º comprovante era
  dinheiro real sem rastro; desde o v154 TODO pedido de usuário é doação,
  então o dedup de pendente só vale pros pedidos de admin/legado) + teto
  anti-abuso 3 pendentes; (5) comprovante inválido (>8MB/corrompido) →
  400 claro, nunca pedido "ok" sem prova em silêncio; (6) retry
  automático da leitura (_preCheckComRetry: ERRO re-tenta em 1min/10min,
  máx 2 — antes esperava as 02h); (7) PDF é LIDO de verdade (inline
  application/pdf no Gemini; REVISAR_MANUAL hardcoded morreu); (8)
  comprovante comprimido no APARELHO (canvas → JPEG 1600px 0.82 — mata
  HEIC de iPhone e derruba 5MB→~200KB; PDF passa cru; fail-open); (9)
  badge sem leitura fala a verdade ("Aguardando leitura", não "Confira
  manual"). Teste antigo do dedup ATUALIZADO pra nova realidade (2ª
  doação vira pedido próprio, cancelado no teste pra não sujar a mesa).
  6 checks. sw v141. Total da suíte: 502.
- ✅ **PARTE 2 (29/08) — O usuário vê tudo**: (1) cancelamento de doação
  NUNCA mais é mudo — push ao usuário com o MOTIVO (cancelarPedido do
  admin pergunta o motivo → notaAdmin → push + `motivoCancelamento` na
  linha cancelada de Minhas doações); (2) /api/pedidos do usuário virou
  WHITELIST (o spread vazava preCheck cru com E-MAIL DE OUTRO USUÁRIO
  no dupAlerta + notaAdmin interna) com `comprovanteStatus` derivado
  SEGURO — DIVERGENCIA vira "analise" pro doador (nunca se avisa quem
  tenta fraude; ILEGIVEL/ERRO viram aviso com reenvio); (3) rota POST
  /api/pedido/:id/comprovante — o DONO do pedido pendente SUBSTITUI o
  comprovante (trilha comprovanteAnteriorHash, hash+leitura recalculados
  via _preCheckComRetry; 403 pra quem não é dono, 400 pra pedido já
  confirmado) + push automático pedindo reenvio quando a leitura sai
  ILEGIVEL (_avisaLeituraRuim, 1x por pedido); (4) "Minhas doações"
  saiu da era plano ("doacao · ?d") — mostra 💎 Doação · N diamantes,
  status em vocabulário de doação e a MEDIANA REAL de confirmação
  (medianaAprovacaoHoras no /api/diamonds) no lugar do "24h" fixo; (5)
  card Minha Conta: status "pago" não mente mais ("pagamento visto — 💎
  a caminho"; mc_9 só no ativo) e a data aparece (era p.criadoEm, o
  campo é createdAt); (6) extrato 💎 completo: "ver todos" (60), saldo
  após cada lançamento, rótulos ajuste/crédito; (7) packs de doação
  derivados SEMPRE da tabela oficial (13c — _renderPacksFromTable; o
  HTML é só fallback) + taxa "N 💎 × R$ 1,50" na calculadora; (8)
  falha do /api/diamonds mostra card com Tentar de novo (era catch
  vazio); (9) "Renove agora" (violava v66) → "Troque seus 💎" via
  LANG_DICT; 20 chaves novas mc_13..15/lb_*/mp_* nas 3 línguas (6f).
  4 checks. sw v142. Total da suíte: 506.
- ✅ **PARTE 3 (29/08) — Uma régua só nas telas do admin**: (1) BUG REAL:
  "gastos 30d"/"líquido 30d" da Visão do Dono e do peer resumo liam
  g.dataPagamento (gasto usa dataGasto) — gastos30 era R$0 SEMPRE;
  corrigido nos 2 lugares; (2) card "Total recebido" do Financeiro era
  Math.max(canônico, soma crua) — inexplicável; agora mostra as JANELAS
  canônicas (13n) que viajam no GET /api/admin/financeiro (`entradas`) —
  delta R$0 provado contra o liquidoContabil do Acerto; (3)
  computeFinanceCanonico agora exclui ADMIN (v53) e lançamento
  ANULADO/AJUSTE (o par ±0 do cérebro; antes o negativo era descartado e
  o anulado seguia somando — receita fantasma); (4) fin-insights com
  lucro HONESTO (sem Math.max(0) — prejuízo aparece) e partes pelo
  SPLIT real (parteAndrio/parteDiego; metade=parteAndrio por
  compatibilidade); (5) aba 📅 Mensal do Financeiro consome
  /api/admin/dre (finAgrupaMeses/finMesKey/linhaAcerto client-side
  EXCLUÍDOS — era a 2ª verdade que o MC4-P4 declarou morta,
  sobrevivendo aqui); (6) CSV da contabilidade virou rota do servidor
  GET /api/admin/financeiro/exportar (valor EFETIVO pedido-vence-caixa
  + dono pela régua do acerto + anulado marcado; o CSV do cliente
  somava cru e carimbava "sem dono" como Andrio); (7) pagEditarValor
  PERGUNTA quem recebeu (era 'andrio' hardcoded); (8) legendas dos
  cards Andrio/Diego mostram o % do split real (era "50% do lucro"
  fixo). 4 checks. sw v143. Total da suíte: 510.
- ✅ **PARTE 4 (29/08) — Tudo clicável e explicado**: (1) os 4 cards da
  Visão do Dono (Hoje/7d/30d/Total) abrem a LISTA dos lançamentos por
  trás (donoVerLancamentos → aba 🧠 + cerebroLista('registrada',janela)
  — nenhum número da 1ª tela é decorativo); (2) 📖 "Entenda os números"
  (donoEntendaNumeros, link verde na Visão do Dono): overlay explicando
  em PT claro CADA régua — janelas canônicas, registrada×confirmada,
  pedidos≠caixa, cortesia R$0, acerto (fórmula), DRE negativo honesto,
  AJUSTE±, fechamento — e a regra 13n declarada; (3) card 🌍 Faturamento
  Global se APOSENTA sozinho na era de 1 servidor (irmãos ocultos sem
  total manual = display:none; servidor oculto chega marcado
  oculto:true e NUNCA mais é consultado por rede — dieta 13w — nos 2
  lugares: financeiro-global e dono-resumo); (4) card 📈 RESULTADO abre
  o DRE mensal (abria a lista só de gastos); (5) decisão tomada →
  loadCerebro() (a tela INTEIRA atualiza, não só a lista); (6) lote de
  comprovantes com PROGRESSO ao vivo (poll 3s em #cb-detalhe + toast de
  conclusão; era fire-and-forget); (7) card 🎟️ Códigos com explicação
  honesta ("referência — não soma receita", 13c); (8) 💎 "Total já
  doado" exclui admin (v53); (9) /api/pedidos admin ganha ehAdmin e o
  card "Valor em pedidos" exclui teste de admin (batendo com a
  Conferência). 3 checks. sw v144. Total da suíte: 513.

- ✅ **PARTE 5 (29/08) — Quem recebeu/gastou 100%**: o dono do dinheiro
  NUNCA mais é chutado. (1) Aprovação de doação SEM `recebidoPor`
  explícito OMITE o campo (spread condicional — o fallback
  `_ativadoEditor==='Diego'?'diego':'andrio'` morreu): o acerto deriva
  da TRILHA (`ativadoPorEmail`) como "derivado", auditável no CSV; (2)
  `add_pagamento` idem — enum ou NADA (antes qualquer string virava
  'andrio' na marra e o dinheiro caía no sócio errado em silêncio);
  entrada sem dono cai honestamente em "sem dono" no Acerto pro admin
  atribuir; (3) `add_gasto` aceita `recorrente:true` e USD
  (`moeda/valorUSD/cambio` — MESMA régua de conversão do edit_gasto,
  padrão 5.17); `_lancarGastosRecorrentes()` (action
  `rodar_recorrentes` + autonomia das 02h) cria a cópia mensal do gasto
  recorrente (Render!) SEM comprovante + push cobrando o anexo —
  idempotente por (recorrenteDe+mês); (4) repasse aceita COMPROVANTE
  (mesma validação/fingerprint; lista viaja stripada, rota nova GET
  /api/admin/repasse/:id sob demanda + 📎 no painel via finZoomImg);
  (5) fingerprint SHA-256 SEMPRE em add_pagamento/add_gasto/
  add_repasse/attach_comprovante (`_hashComp` — mesma régua 2.0-P2 dos
  pedidos); (6) mod-cerebro: entry ganha `temAnexoProprio` e o hash cai
  pro `pg.comprovanteHash` quando não há pedido — entrada manual COM
  comprovante sai do card "SEM COMPROVANTE" (falso positivo morto) e o
  anexo entra no radar de reuso; (7) corte de mês do DRE em HORÁRIO DE
  BRASÍLIA (`_mes` −3h, fonte única — fechamento herda): PIX das 22h do
  dia 31 fica no mês que o dono viveu; (8) front: option "empresa" no
  gasto do Financeiro (só tinha andrio/diego!), checkbox 🔁 recorrente
  no cerebroGastoForm, anexo cb-r-img no cerebroRepasseForm. 6 checks.
  sw v145. Total da suíte: 519.
- ✅ **PARTE 6 (29/08) — O caixa NUNCA apaga**: (1) o cancelamento de
  pedido aprovado parou de REMOVER a entrada do caixa (filter de
  18/07/2026) — agora chama `_cerebro.anularNoCaixa(pd.id,true,...)`
  (a MESMA função única do 3.0-P5, exportada do mod-cerebro; nunca uma
  2ª lógica): original preservado com `anuladoPor` + par de AJUSTE−
  pelo valor EFETIVO; líquido idêntico ao da exclusão antiga em TODAS
  as réguas (provado: canônico volta EXATO ao de antes da aprovação,
  delta R$0) e o cérebro não acusa CONFLITO nem RULE_CANCELLED_PAYMENT
  do que já nasceu anulado. Os estornos de 💎/dias do cancelamento
  continuam intocados. (2) `_persistFinConferido(contexto)`:
  persistFinanceiro() com retorno CONFERIDO na aprovação da doação e
  no robô de gastos recorrentes — falha de disco loga alto + push aos
  admins ("Caixa não gravou no disco") em vez de seguir como se tivesse
  salvo; a sequela (pedido ativo sem caixa) o cérebro já pega (caso
  Cleiton). (3) POST /api/admin/financeiro com action DESCONHECIDA leva
  400 com o nome do typo — o fallthrough "ok:true" mudo (que persistia
  sem fazer NADA) morreu; todas as actions legítimas do front/suíte
  conferidas antes. (4) A fila do tempo real (3.0-P6) SOBREVIVE a
  deploy: `notificarEvento` persiste `tempoRealPend` no cerebro_state,
  a reação limpa, e `retomarTempoReal()` (boot, bloco de robôs — 
  aposentado nunca chega lá) re-arma o debounce com os eventos de antes
  do restart. Asserts antigos atualizados pra nova realidade (−99→−246,
  −149→−296, total de ajustes 2→3, "caixa sumiu"→"anulado + par").
  Sem bump de sw (mudança 100% server-side). 6 checks. Total: 525.
- ✅ **PARTE 7 (30/08) — Vigias que nunca dormem**: (1) o agendador da
  diária virou `_cbVigiaTick` (módulo; o setInterval de 10min do bloco
  de robôs só chama) — carimbo em DISCO (`DATA/cerebro/
  diaria_stamp.json`, sobrevive a restart) e CATCH-UP: a janela deixou
  de ser a hora exata das 02h (getUTCHours()>=2 + dia ainda não
  carimbado) — Render Free hibernando às 02h roda a diária na primeira
  checagem depois de acordar; carimbo SÓ em sucesso, com teto de 3
  falhas/dia (nunca martela auditoria quebrada). (2) DEAD-MAN'S
  SWITCH: diária sem sucesso há 48h+ → push aos admins 1x/24h ("Vigia
  contábil parado") — roda ANTES do catch-up de propósito; desarma
  sozinho no próximo sucesso. Rota POST /api/admin/cerebro/vigia
  ({forcar:true} ignora a janela — admin e teste determinístico). (3)
  IA morta não fica MUDA: `_iaFalhaSeq` no geminiGenerate — 3 falhas
  TOTAIS seguidas (nenhum modelo da cadeia) → push "IA fora do ar"
  1x/6h; sucesso zera; série exposta na Saúde da IA
  (`falhasSeguidas`). (4) Retry com TETO: preCheck ERRO carrega
  `tentativas` (sobrevive à substituição do preCheck); 5+ tentativas
  saem da fila do lote (`comprovantesPendentes`) e entram em
  `statusComprovantes().esgotados` — fora da fila, nunca escondidos.
  (5) Tempo real em TODAS as actions do caixa: `_hookCaixa` em
  add/edit/delete de pagamento/gasto/repasse, attach_comprovante,
  rodar_recorrentes e no ajuste manual do cérebro (3.0-P6 só cobria as
  4 rotas de pedido) — provado: editar gasto = +1 na janela. (6)
  Auto-fechamento de TODOS os meses antigos: `_autoFecharMesesAntigos`
  (o dia 3 fecha tudo que ficou pra trás, nunca o mês corrente; dia 3
  agora em BRT) + rota POST /api/admin/fechamento/auto
  ({ignorarDia3:true}). Sem bump de sw (100% server-side). 6 checks.
  Total da suíte: 531.
- ✅ **PARTE 8 (02/09) — Relatórios prontos**: `_relPeriodico(tipo)` —
  relatório SEMANAL (toda segunda) e MENSAL (dia 3, DEPOIS do
  fechamento automático da autonomia — sai com o mês já carimbado 📕)
  montados 100% DETERMINÍSTICOS das fontes únicas 13n
  (computeEntradasJanelas/computeSocios/computeDreMensal + statusCerebro;
  IA nunca calcula número; o 7d do texto é IDÊNTICO ao canônico, provado
  no smoke). Conteúdo: receita 7d/30d/total, gastos e resultado do
  período, doações confirmadas, pagantes ativos, novos usuários, mesa de
  pendentes, acerto dos 2 sócios pelo split real, integridade % +
  incidentes abertos, fontes declaradas; mensal ainda compara com o mês
  anterior e aponta top plano/categoria. PUSH aos admins com resumo de 1
  linha; texto completo no histórico navegável (DATA/cerebro/
  relatorios_periodicos.json, cap 60; id por dia — re-gerar SUBSTITUI,
  nunca duplica). Agendado no `_cbVigiaTick` (mesma janela pós-02h com
  catch-up; carimbos semanalDia/mensalMes no diaria_stamp). Rotas: GET
  /api/admin/cerebro/relatorios · POST /api/admin/cerebro/
  relatorio-periodico {tipo}. Painel: botão 🗞️ Relatórios na aba 🧠
  (histórico em <details> + gerar semanal/mensal agora). 3 checks.
  sw v147. Total da suíte: 537.
17. **📖 Central de Tutoriais (dono, 24/08/2026 — "quero prints nos
    tutoriais, explicando cada detalhe")**: a aba Tutorial (v-tutorial,
    MENU ☰ → 📖 Central de Tutoriais) tem 28 passo a passos em 7 blocos
    com busca local (tutFiltra — sem acento, título+data-kw, expande o
    que casa) e 29 FOTOS REAIS das telas (Playwright + fixtures ricas +
    planilhas bundled; script fora do repo, mesmo padrão do /como-usar).
    Arquitetura: o conteúdo editorial mora no fragmento
    `tutorial-conteudo.html` (rota /tutorial-conteudo) carregado sob
    demanda por `loadTutorial()` — o index fica ~33KB mais leve e a
    CATRACA de tradução das views continua ZERADA (conteúdo longo em PT
    é a mesma classe do /como-usar; as strings de UI da aba usam
    LANG_DICT tut_* nas 3 línguas). Fotos em /tutorial-img servidas por
    /tut-img/<nome> (sanitizado [a-z0-9-], sem traversal, cache 7d,
    lazy). Ao atualizar uma tela do site, RE-FOTOGRAFAR o print
    correspondente — tutorial com foto velha confunde mais que ajuda.
    O item antigo "Tutorial" do MENU (que abria os slides) virou "Tour
    rápido"; a Central tem entrada destacada verde acima dele.

18. **🐢 v162 — sort=match travava o site inteiro (dono, 24/08/2026: "site
    está completamente lento, e não é internet e sim lentidão do próprio
    site")**: achado revisando `searchSheet()` — o comparador de
    `sort==="match"` chamava `computeJobMatchScore()` DENTRO do
    `Array.sort`, recalculando a pontuação (regex sobre o texto da vaga)
    **2x por comparação, sem cache nenhum**. Com as planilhas reais
    (9.240 + 2.206 + 4.831 + 2.625 vagas), UMA busca com "🎯 Melhor pra
    mim" recalculava a pontuação dezenas de milhares de vezes — travando
    o processo (single-thread) inteiro por um tempo real, pra TODOS os
    usuários conectados, não só quem buscou. Corrigido pro padrão
    "decorate-sort-undecorate" — calcula a pontuação UMA VEZ por item,
    guarda junto, ordena pelo valor guardado — o MESMO padrão que
    `orderQueueSmart` (fila automática) já usava certo desde sempre; o
    bug era só no motor de busca manual. Guarda ESTRUTURAL permanente no
    smoke: nunca mais um `.sort()` pode chamar `computeJobMatchScore`
    dentro do comparador. Sem bump de sw (mudança 100% server-side —
    nenhum arquivo servido ao cliente mudou).

19. **🩻 v163 — Raio-X de Memória (CEO mode, 29/08/2026 — OOM 2GB no
    Render, dor nº1 declarada do dono)**: antes de operar a memória,
    MEDIR. GET /api/admin/memoria devolve rss/heap/nativo do processo +
    comprovantes base64 RESIDENTES na RAM (n/MB/top5 por coleção —
    suspeito nº1 do OOM: cada pedido/pagamento/gasto com foto segura a
    string inteira pra sempre) + planilhas residentes (linhas + MB por
    AMOSTRA de 1 linha) + contagens dos bancos + top 20 do DATA_DIR em
    disco + dicas derivadas dos números. REGRA INEGOCIÁVEL da rota:
    NUNCA JSON.stringify de banco inteiro (dobraria a RAM em produção)
    — guarda estrutural no smoke. Pulso `[mem]` no log a cada 6h (+30s
    pós-boot) pra correlacionar com restarts do Render. Card "🩻
    Memória do servidor" em Configurações (loadMemoria). Uso: comparar
    o raio-x logo após deploy vs horas depois — residentes altos =
    migrar comprovantes pra disco (candidato já identificado); rss alto
    com residentes baixos = pico transiente (coleta ZIP/backup/fusão).

20. **🤖 v164 — Cérebro 100% AUTÔNOMO (dono, 29/08/2026 — "quero que tudo
    no programa seja feito sozinho, eu não quero ter que ficar clicando
    em qualquer coisa, quero tudo entregue quando eu acessar a página adm
    cerebro")**: (1) GET /api/admin/cerebro/painel — TUDO em 1 chamada,
    montado do estado PERSISTIDO (relatório em disco + cerebro_state via
    `painelCompleto()` no mod-cerebro): decisões prontas com botões,
    incidentes abertos, sócios, executivo do DRE, fechamentos com selo,
    comprovantes — abrir a aba NUNCA dispara auditoria (provado no smoke:
    ultimoId intacto). (2) loadCerebro renderiza a seção "🤖 Entregue
    pronto" de cara (decisões com botões de 1 clique, incidentes,
    executivo aberto, fechamentos) e, se a última auditoria tiver >30min
    (ou nunca), dispara auditoria em BACKGROUND sozinho (_cbAutoKick 1x
    por sessão) e recarrega ao terminar. (3) `_cbAutonomia(quem)` no
    server: pós-auditoria SOZINHO — rodarComprovantes (se pendentes),
    rodarIA(10) e `_autoFecharMesAnterior()` (fecha o mês anterior
    AUTOMATICAMENTE no dia 3, só mês com movimento, nunca refecha) —
    chamada pelo agendador das 02h E pela rota diaria. Fechar mês virou
    função ÚNICA `_fecharMes()` (rota manual + automático — nunca 2
    lógicas). **No npm test a autonomia vem honestamente PULADA** (filas
    em background criariam corrida com as asserções — mesma filosofia do
    debounce do tempo real; cada peça é provada isolada nos próprios
    checks). 4 checks. sw v140. Total da suíte: 497.

## ⚠️ PENDÊNCIAS CONHECIDAS (verificar a cada sessão)

- ✅ REGISTRO (02/08/2026, v95–v108): reestruturação total aos olhos do
  usuário CONCLUÍDA (12 partes + extras): subtabs do Perfil em cards
  grandes; Currículos em 3 caminhos (sidebar/drawer/bottom-nav); nº de
  caso falso removido do detalhe de Enviadas; wizard nunca cobre o
  checkout de doação; MENU roxo; chat IA fixo na sidebar (regra 12
  nova) c/ 54 balões; 3 MODOS DE TELA (Auto/Tela pequena/Tela cheia,
  force-cel pro PC) c/ slide no tour + gaEvent; 30 botões só-ícone com
  aria-label; telas financeiras do admin consolidadas (régua 💰,
  _renderMoneyNav); guia /como-usar re-fotografado. Deploys conferidos
  por hash idêntico nos 3 repos. ATENÇÃO: a rede do sandbox de IA NÃO
  alcança os domínios de produção (proxy 403) — confirmação visual de
  produção é sempre do dono.

- DNS de applyh2b.com (parking Namecheap), EDITOR_PWD_*, GA_MEASUREMENT_ID:
  **ADIADOS pelo dono (13/08/2026 — "esqueça, não vou fazer agora")**.
  NÃO relembrar em relatórios; passo a passo continua em
  README_SERVIDORES.txt pra quando ele quiser.
- **🛑 FIM DO ESPELHAMENTO (ordem do dono, 21/08/2026 — "sv 2 e 3 não
  precisa mais colocar nada no git, apenas sv1")**: entregas novas vão
  SÓ pro main deste repo (Applyh2b.com = Servidor 1). Os repos
  New-repository e Teste ficam CONGELADOS no v151 (c206ea2) — não
  espelhar mais nada neles sem ordem nova. Histórico: este repo virou a
  fonte única em 25/07; espelhos rodaram do v65b até o v151 (estado
  antigo preservado no branch backup-pre-espelho-20260726 de cada repo,
  onde está o mod-dol-monitor.js e os arquivos removidos de propósito).
- Bot de coleta ("Nova Planilha do DOL") foi REESCRITO neste repo (v35,
  caminho do feed ZIP + rascunho/publicação manual, testado no smoke com
  feed falso). Ainda SÓ na produção (conferir antes de sobrescrever, valem
  pouco): orquestrador de temporadas históricas e mod-dol-monitor.js (o
  papel de notificação dele já foi substituído pela aba Notícias; o bot da
  planilha randomizada hiberna por ordem do dono).
- `TEST_LOGIN_TOKEN`: NUNCA definir em produção (é só do npm test).
- Fila futura: gateway de pagamento (aguarda chaves), Play Store (TWA),
  espanhol/inglês, consolidar telas financeiras do admin.
