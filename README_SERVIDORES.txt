════════════════════════════════════════════════════════════════════
 H2BApply — 1 CÓDIGO, 3 SERVIDORES (guia mestre — 25/07/2026)
 Substitui o README_SERVIDOR2.txt. ESTE repositório (Applyh2b.com) é a
 FONTE ÚNICA: tudo que for editado aqui vale para os 3 servidores.
════════════════════════════════════════════════════════════════════

OS 3 SERVIDORES
------------------------------------------------
  Servidor 1 → https://h2bapply.com            (repo antigo: New-repository)
  Servidor 2 → https://h2b-teste.onrender.com  (repo antigo: Teste)
  Servidor 3 → https://applyh2b.com            (repo: Applyh2b.com ← FONTE)

O código é IDÊNTICO nos três. Quem diz "quem sou eu" são as ENVS do
Render (e, como rede de segurança, o HOST da requisição — _selfId no
server.js corrige sozinho se a env estiver errada, gritando no log).

Em QUALQUER servidor o visitante tem a escolha do servidor dele:
  • Landing → pill "🌐 Servidores" abre o seletor com os 3.
  • Login → digita o e-mail e o /api/auth/where LOCALIZA em qual
    servidor a conta existe, com botão direto pra lá (?entrar=1).
  • v61: o card de login também tem "🌐 Ver todos os servidores" —
    inclusive quando a conta "não foi encontrada" (se um servidor
    irmão estiver fora do ar, a busca é fail-open e pode não achar;
    a pessoa ainda consegue navegar até o servidor certo à mão).
  • Cadastro novo: só em servidor com status "aberto" (hoje, só o 3;
    a trava de conta única impede segunda conta em outro servidor).
  • Admin: e-mail de admin vê os 3 servidores e entra em qualquer um.

════════════════════════════════════════════════════════════════════
 COMO ATUALIZAR OS SERVIDORES 1 E 2 COM O CÓDIGO DAQUI (espelho)
════════════════════════════════════════════════════════════════════
🤖 ESPELHO AUTOMÁTICO (26/07): existe uma GitHub Action
(.github/workflows/espelho.yml) que replica TODO push do main daqui
pros repos dos Servidores 1 e 2 sozinha — os 3 Renders publicam juntos.
Pra ela funcionar, o dono precisa criar UMA vez o secret MIRROR_TOKEN
(passo a passo no topo do próprio arquivo espelho.yml). Enquanto o
secret não existir, a Action falha com aviso e o espelho é manual
(comandos abaixo).

O fluxo antigo era o contrário (New-repository → espelho aqui). AGORA
A FONTE É ESTE REPO. Para levar o código daqui para os outros dois:

  git clone https://github.com/andriokick18-cmyk/Applyh2b.com.git
  cd Applyh2b.com
  git remote add srv1 https://github.com/<owner>/<repo-do-servidor-1>.git
  git push srv1 main --force        # sobrescreve TUDO no repo do srv 1
  git remote add srv2 https://github.com/<owner>/<repo-do-servidor-2>.git
  git push srv2 main --force        # idem para o srv 2

O Render de cada serviço (que continua ligado ao repo antigo dele)
faz o deploy sozinho ao receber o push. ⚠️ ANTES do primeiro espelho:
conferir se os repos antigos têm algo que só existe lá (orquestrador
de temporadas históricas e mod-dol-monitor.js — ver PENDÊNCIAS no
CLAUDE.md) — o push --force APAGA o que não estiver aqui.

Alternativa sem --force (mais trabalho): apagar os arquivos antigos no
repo destino e subir os daqui — subir por cima NÃO apaga sobras (ex.:
admin-3.html, index-1.html, mod-dol-monitor.js, removidos de propósito).

════════════════════════════════════════════════════════════════════
 MATRIZ DE ENVS (Render → Environment de cada serviço)
════════════════════════════════════════════════════════════════════
                        SERVIDOR 1        SERVIDOR 2           SERVIDOR 3
  SERVER_ID             1                 2                    3
  APP_URL               https://h2bapply.com
                                          https://h2b-teste.onrender.com
                                                               https://applyh2b.com
  GOOGLE_CLIENT_ID/     projeto OAuth     projeto OAuth        projeto OAuth
  GOOGLE_CLIENT_SECRET  próprio           próprio (ou o do 1)  próprio

⚠️ v72 (ordem do dono, 26/07): SÓ-ENVIO agora é a arquitetura PERMANENTE e
UNIVERSAL dos 3 servidores — não é mais env por servidor. O app pede ao
Google SOMENTE o escopo gmail.send (hardcoded em server.js); nunca lê,
abre ou guarda a caixa de entrada de ninguém. A aba Respostas foi
REMOVIDA do site nos 3. A env GMAIL_SEND_ONLY pode ser apagada do Render
dos 3 serviços — não é mais lida pelo código.

IGUAIS NOS TRÊS (cada um com seus valores):
  ADMIN_EMAIL / ADMIN_EMAIL_2 / ADMIN_EMAILS_EXTRA
  DATA_DIR=/data  + Persistent Disk montado em /data (sem disco o
    sistema liga, mas usa /tmp e PERDE tudo a cada restart)
  DATA_ENC_KEY (frase forte — cifra os tokens Gmail no disco)
  NODE_OPTIONS=--max-old-space-size=360   (em plano de 512 MB — ver 502 abaixo)
  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (push)
  GEMINI_API_KEY (IA) · EDITOR_PWD_ANDREW / EDITOR_PWD_DIEGO
  TEST_LOGIN_TOKEN: NUNCA em produção (só do npm test)

⚠️ OAUTH de cada servidor: no Google Cloud Console, o Client ID usado
precisa autorizar os DOIS redirects daquele host:
  https://<host>/oauth/callback
  https://<host>/oauth/add-sender/callback
Senão o login Google falha só naquele servidor.

CONFIGURAÇÃO DO SERVIÇO (conferir no Render → Settings)
  Build Command: npm install
  Start Command: node server.js   (ou npm start)
  Branch:        main

════════════════════════════════════════════════════════════════════
 🔴 SITE FORA DO AR? DIAGNÓSTICOS REAIS (2 casos já vividos)
════════════════════════════════════════════════════════════════════

CASO 1 — ERR_CONNECTION_TIMED_OUT em applyh2b.com (print 25/07/2026)
------------------------------------------------
Sintoma: "Não é possível acessar esse site / demorou muito para
responder". Isso é ANTES do HTTP — o navegador nem conectou.
Causa encontrada: o DNS de applyh2b.com aponta para 162.255.119.149,
que é o IP do "URL Redirect/parking" da NAMECHEAP (registrador) — e
esse serviço NÃO responde HTTPS: conexão na porta 443 morre em
timeout. Compare: h2bapply.com aponta para 216.24.57.1 (Render) e abre.
Ou seja: o domínio nunca foi apontado para o Render.

CORREÇÃO (Namecheap + Render, ~10 min + propagação):
  1. Render → serviço do Servidor 3 → Settings → Custom Domains →
     adicionar applyh2b.com e www.applyh2b.com. O Render mostra os
     valores exatos de DNS a usar (A record e CNAME).
  2. Namecheap → Domain List → applyh2b.com → Advanced DNS:
     • REMOVER o "URL Redirect Record" do host @ (é ele o vilão).
     • Adicionar  A Record     @    216.24.57.1   (valor que o Render mostrar)
     • Adicionar  CNAME Record www  <serviço>.onrender.com
  3. Esperar o Render emitir o certificado (fica "Verified") —
     propagação de DNS pode levar de minutos a algumas horas.
  4. Conferir: applyh2b.com deve resolver para IP do Render
     (216.24.57.x), NUNCA mais 162.255.119.x.
  5. DEPOIS que o domínio abrir com cadeado: nos 3 painéis admin
     (Admin → Configurações → 🌐 Servidores), trocar a URL do
     Servidor 3 de https://h2b-server-3.onrender.com para
     https://applyh2b.com (v66b deixou o onrender como URL provisória
     porque o domínio estava morto — seletor e ranking global usam
     essa URL pra alcançar o Servidor 3). E no Render do Servidor 3,
     voltar APP_URL=https://applyh2b.com.
Enquanto isso, o site continua acessível pelo endereço
<serviço>.onrender.com do Servidor 3.

CASO 2 — 502 EM LOOP (Servidor 2, 18/07/2026)
------------------------------------------------
Render mostrou "Instance failed: Ran out of memory (used over 512MB)"
a cada 1-2 min: plano Starter dá 512 MB; o Node passa, o Render mata o
processo e reinicia — quem acessa durante o loop vê 502.
  A) GRÁTIS: env NODE_OPTIONS=--max-old-space-size=360 (obriga o GC a
     limpar antes de estourar) + Manual Deploy → Clear build cache.
  B) DEFINITIVA: plano com 1 GB+ de RAM (o sistema carrega as
     planilhas de vagas inteiras na memória; 512 MB é apertado).
Vale para os 3 servidores — se der 502 "às vezes", abrir EVENTS do
serviço e procurar a mensagem de memória.

CASO 3 — DISCO /data MORREU (backup entre irmãos, v69)
------------------------------------------------
Todo dia às 04h (BRT) cada servidor manda um pacote gzip dos arquivos
críticos (usuários com tokens cifrados, financeiro, pedidos, códigos,
avaliações, histórico, admin_settings) pros 2 irmãos, guardado em
/data/backups_peers/srvN/AAAA-MM-DD.json.gz (2 dias de retenção).
Admin → GET /api/admin/backup-peers mostra o status; POST
/api/admin/backup-peers/run dispara na hora.
RESTAURAR — JEITO FÁCIL (v70, 1 comando, ensaiado no npm test):
  1. Copie o .gz do irmão pro servidor novo (Render → Shell).
  2. Rode:  node restaurar_backup_irmao.js /data/backups_peers/srv3/ARQUIVO.json.gz /data
     (tudo que for sobrescrito ganha cópia .antes-restauracao ao lado)
  3. Reinicie o serviço (MESMA DATA_ENC_KEY!) e confira login/saldos.
RESTAURAR — jeito manual (ex.: disco do Servidor 3 morreu):
  1. No Render do Servidor 1 OU 2 → Shell:
       ls /data/backups_peers/srv3/            ← escolha o mais novo
  2. Baixe o arquivo (base64 no shell ou rota admin) e descompacte
     localmente:  gunzip -c srv3.json.gz > pacote.json
     O JSON tem {files:{"users.json":"...", "financeiro.json":"..."}}
     — grave cada chave num arquivo com o MESMO nome.
  3. No serviço novo do Servidor 3 (disco novo, MESMA DATA_ENC_KEY!):
     suba os arquivos pro /data (shell/scp) e reinicie. A MESMA
     DATA_ENC_KEY é obrigatória — sem ela os tokens Gmail não abrem.
  4. Confira: login, saldos 💎, Conferência e Visão do Dono.

CASO 4 — CONFIGURAR "🎯 RESPOSTAS CERTAS" (v74, admin-only, 27/07/2026)
------------------------------------------------
O QUE É: aba só-admin (painel /admin) onde a IA lê as caixas de entrada
que O PRÓPRIO ADMIN conectar e classifica cada resposta (entrevista real?
pergunta? ignora automático/rejeição). Continua funcionando mesmo sem
configurar nada — só fica com um banner "não configurado" na aba.

POR QUE UM CLIENT OAUTH SEPARADO: o app público (GOOGLE_CLIENT_ID) pede
só gmail.send (regra 13d do CLAUDE.md — é o que destrava a verificação
rápida do Google, sem CASA, pros 3 servidores). Ler a caixa de entrada
exige gmail.readonly, que É escopo restrito e exigiria CASA se pedido
pelo MESMO client público. Solução: um projeto Google Cloud TOTALMENTE
separado, mantido em modo "Testing" (nunca publicado) — nesse modo o
Google permite até 100 "test users" nomeados autorizarem QUALQUER escopo,
inclusive restrito, SEM verificação nenhuma. Como só 2-3 admins vão usar,
isso resolve pra sempre sem nunca precisar submeter esse client pra
revisão do Google.

PASSO A PASSO (fazer 1x, vale pros 3 servidores — mesmo Client ID/Secret):
  1. console.cloud.google.com → crie um projeto NOVO (ex.: "h2bapply-admin-reply"),
     diferente do projeto usado pelo GOOGLE_CLIENT_ID público.
  2. APIs & Services → Library → ative "Gmail API" nesse projeto.
  3. APIs & Services → OAuth consent screen:
     - User Type: External
     - Publishing status: deixe em "Testing" (NUNCA clique em "Publish app")
     - Scopes: adicione .../auth/gmail.readonly
     - Test users: adicione o e-mail de CADA admin que vai usar a aba
       (ex.: andrio.usa2026@gmail.com e o Gmail do Diego)
  4. APIs & Services → Credentials → Create Credentials → OAuth client ID
     - Application type: Web application
     - Authorized redirect URIs: adicione, pra CADA um dos 3 servidores:
       https://<host-do-servidor>/oauth/admin-reply/callback
       (ex.: https://h2bapply.com/oauth/admin-reply/callback,
       https://h2b-teste.onrender.com/oauth/admin-reply/callback,
       https://h2b-server-3.onrender.com/oauth/admin-reply/callback — e
       troque pelo domínio certo quando o DNS do Servidor 3 for corrigido)
  5. Copie o Client ID e Client Secret gerados.
  6. Render → cada um dos 3 serviços → Environment: adicione
     ADMIN_REPLY_CLIENT_ID e ADMIN_REPLY_CLIENT_SECRET com os MESMOS
     valores nos 3 (é o mesmo projeto Google, só client único).
  7. Redeploy. Na aba 🎯 Respostas Certas, clique "Conectar Gmail" — só
     os e-mails cadastrados como test user no passo 3 conseguem logar
     (qualquer outro e-mail recebe erro do Google "app não verificado /
     acesso negado" — é o esperado, é a proteção funcionando).

SEM RISCO PROS USUÁRIOS COMUNS: essas envs não tocam em GOOGLE_CLIENT_ID/
SECRET nem em OAUTH_SCOPES — o login normal e o envio automático de todo
mundo continuam exatamente como estão (só gmail.send, regra 13d).

COMO LER O PROBLEMA SOZINHO
------------------------------------------------
Render → serviço → EVENTS: diz POR QUE caiu (memória, crash, deploy).
Render → serviço → LOGS:  console do Node (o boot imprime [sheet],
[storage], [reconciliar] etc. — se parar no meio, a última linha diz
onde morreu). Deploy reinicia o processo: 502 de ~1 min é normal.
════════════════════════════════════════════════════════════════════
