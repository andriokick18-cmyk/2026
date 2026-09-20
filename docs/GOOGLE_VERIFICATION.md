# ✅ Verificação do Google OAuth — escopo `gmail.send` (H2BApply)

**Criado em:** 20/09/2026 · **Atualizado em:** 20/09/2026 (branding
corrigido e verificado). **Domínio:** h2bapply.com · servidor único (a era
multi-servidor acabou — v156/v157).

## 📍 Status atual (20/09/2026)

- ✅ **Branding do OAuth corrigido e verificado.** Causa raiz achada e
  resolvida pelo dono direto no Cloud Console: a Página Inicial, o Link da
  Política de Privacidade e o Link dos Termos estavam configurados com a
  URL antiga do Render (`h2bapply-2026.onrender.com`) em vez de
  `h2bapply.com` — por isso o Google não conseguia verificar a
  propriedade. Trocados os 3 campos pra `h2bapply.com` / `h2bapply.com/
  privacy` / `h2bapply.com/terms`, pedida nova verificação de marca:
  **aprovada** ("Sua marca foi verificada e está aparecendo para os
  usuários"). Branding publicado.
- ✅ App confirmado **"Em produção"** (não em modo teste) no Cloud Console.
- ✅ Justificativa do escopo `gmail.send` já preenchida na tela (texto da
  seção 1 abaixo).
- ✅ Uso atual do limite de teste: **4 de 100 usuários** — folga grande,
  não é urgência.
- ⏳ **Única coisa que falta pra completar a verificação de acesso a
  dados**: o vídeo de demonstração (link do YouTube). Ver seção 2b —
  o Google recomenda EXPLICITAMENTE não gravar direto na conta de
  produção real, pra não arriscar interromper usuário de verdade nem
  gastar cota de envio de alguém que está pagando.

Este arquivo é o ponto único de referência pra tirar o H2BApply do limite de
100 usuários de teste do Google OAuth. Ele substitui/consolida (sem apagar,
por histórico) o conteúdo de `GOOGLE_VERIFICATION_CHECKLIST.md` e
`GOOGLE_VERIFICATION_VIDEO_SCRIPT.md` na raiz do repo — aqueles ficam como
registro de uma rodada anterior (12/09), mas o texto de justificativa e o
roteiro de vídeo AQUI são os atuais, escritos e aprovados pelo dono em
20/09/2026, e são os que devem ser usados na submissão real.

---

## Por que isso é rápido e barato pro nosso caso

O Google separa escopos OAuth em 3 níveis: não-sensível, **sensível** (é o
caso de `gmail.send`) e **restrito** (`gmail.readonly`, `gmail.modify`,
`https://mail.google.com/`, etc.). Só escopo **restrito** exige a avaliação
de segurança **CASA** — paga (na faixa de US$ 15 mil a 75 mil), demorada
(meses) e renovada todo ano. `gmail.send` é sensível: passa pela verificação
padrão do Google, **gratuita**, e normalmente leva de poucos dias a ~2
semanas úteis depois de uma submissão completa (o próprio Google não dá
prazo fixo — relatos públicos vão de 3 dias a mais de uma semana quando há
idas e vindas).

**Confirmado no código, 20/09/2026** (`server.js`):
```js
const GMAIL_SEND_ONLY = true;
const OAUTH_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.send";
```
Nenhuma rota do sistema pede ou usa `gmail.readonly`/`gmail.modify`/
`gmail.metadata`/`gmail.insert`/`gmail.compose`/`https://mail.google.com/` —
em nenhum dos três lugares que fazem OAuth (login social não existe mais
desde o v172c; conexão de Gmail de ENVIO do usuário; conexão da conta de
NOTIFICAÇÕES do sistema, `mod-notif.js`). É o mesmo client OAuth e o mesmo
único escopo sensível em todo o sistema — nada de escopo extra escondido em
lugar nenhum. Isso é bom pra verificação: um único caso de uso, simples de
explicar e fácil de provar em vídeo.

---

## 1) Texto pronto — justificativa do escopo (campo "why do you need this scope" do Cloud Console)

Copiar e colar exatamente como está (em inglês, como o Google exige):

> H2BApply is a job-application assistance platform for Brazilian citizens
> applying to seasonal H-2B/H-2A work-visa jobs in the United States. Once a
> user reviews and approves a job listing, our platform helps them send
> their own pre-written application email, using their own Gmail account,
> to the employer contact address published by the U.S. Department of
> Labor. We request the gmail.send scope solely to transmit these outbound
> application emails on the user's explicit, per-message instruction. The
> app never reads, searches, labels, modifies, or deletes any message in
> the user's mailbox, and never accesses email the user did not initiate.
> gmail.send is the narrowest available Gmail scope for this purpose: it
> grants send-only access with no read or mailbox-management capability.
> Broader scopes such as gmail.modify, gmail.readonly, or
> https://mail.google.com/ would grant capabilities our product does not
> need and that would be inappropriate for our one-way, outbound-only use
> case.

---

## 2) Roteiro pronto — vídeo de demonstração

**Formato**: YouTube **não listado**, inglês (obrigatório pro time de
revisão do Google), 3 a 4 minutos, mostrando o app rodando em
**h2bapply.com** de verdade (nunca localhost/staging).

Passo a passo (ajustar nome exato de botão/tela na hora da gravação se algo
tiver mudado de posição, mas manter esta sequência e o que cada passo tem
que PROVAR):

1. **Login em h2bapply.com** — mostrar que a conta já está logada (login do
   site é usuário+senha; o Google não participa do cadastro/login).
2. **Ir em Envio Automático** e clicar pra conectar/trocar o Gmail de envio.
3. **Deixar a tela de consentimento do Google carregar completamente** —
   este é o momento mais importante do vídeo inteiro:
   - mostrar a barra de endereço com `accounts.google.com`;
   - a tela cheia com o nome **H2BApply**, o logo, e a linha
     **"Send email on your behalf"** visível por uns 3 segundos, parado,
     sem cortar;
   - clicar em **Continuar/Permitir**.
4. **Voltar pro H2BApply** e mostrar a confirmação "Gmail conectado com
   sucesso".
5. **Ir em Envio Manual**, abrir uma vaga real e enviar uma candidatura de
   verdade.
6. Mostrar a **confirmação de enviado** no H2BApply.
7. Mostrar a **mesma mensagem na pasta Enviados** do Gmail que acabou de
   ser conectado — provando visualmente que o `gmail.send` foi usado
   exatamente como descrito na justificativa (só pra mandar a candidatura
   que o próprio usuário escreveu, nada mais).

Isso cobre 100% dos requisitos oficiais do vídeo: mostra a tela de
consentimento com o escopo visível, mostra o uso real do escopo, e prova
que o resultado bate com o que foi declarado no texto de justificativa.

---

## 2b) Como gravar SEM mexer na conta Gmail de produção

O Google recomenda não gravar na conta real que está enviando candidaturas
de verdade agora — risco de interromper um cliente pagante ou gastar cota
de envio de alguém. O roteiro da seção 2 não exige NENHUM dado sensível de
cliente real — só precisa mostrar o fluxo de conexão + 1 envio real — então
dá pra gravar 100% seguro assim:

1. **Conta Google do vídeo**: uma conta Gmail QUALQUER que não seja de
   cliente nenhum — pode ser uma conta pessoal do Andrio/Diego que nunca
   foi usada no site antes, ou uma conta nova criada só pra isso. Ela vira
   o Gmail "de envio" só DAQUELE teste — a tela de consentimento do Google
   que aparece é sempre a MESMA (mesmo client OAuth, mesmo app H2BApply),
   então o vídeo prova exatamente o que precisa provar, sem tocar em conta
   de cliente nenhuma.
2. **Conta H2BApply do vídeo**: criar uma conta NOVA no site (cadastro
   normal usuário+senha) só pra gravar — nunca usar login de cliente
   real. Não precisa de plano pago: conectar o Gmail de envio funciona
   independente de plano (o gate de plano é só pra ENVIAR, não pra
   conectar — conferir se isso ainda é assim antes de gravar; se mudou,
   um código promocional/concessão manual do admin destrava sem custar
   nada).
3. **O envio de teste (passo 5 do roteiro)**: mandar a candidatura pra um
   endereço de e-mail SEGURO controlado pelo próprio Andrio/Diego (o
   próprio e-mail pessoal, por exemplo) — não pra um e-mail de empregador
   real do DOL. O importante pro Google é mostrar que o `gmail.send`
   manda um e-mail de verdade a partir da ação do usuário; não precisa
   ser pra um empregador de verdade. Se quiser deixar mais realista, pode
   abrir uma vaga real da planilha só pra MOSTRAR a tela (sem clicar
   Enviar) e depois simular o envio de teste separadamente pro próprio
   e-mail — desde que o vídeo mostre claramente a mensagem saindo E
   chegando na pasta Enviados do Gmail conectado (passo 7).
4. **Depois de gravar**: desconectar esse Gmail de teste do site (ou só
   deixar a conta de teste inerte — ela não afeta clientes reais de jeito
   nenhum, já que é uma conta separada) e revogar o acesso do H2BApply
   em myaccount.google.com/permissions dessa conta, se quiser encerrar
   de vez.

Isso resolve o pedido do Google (não gravar em produção) sem exigir nenhum
ambiente de teste separado do site — só uma conta Google "descartável" e
uma conta H2BApply nova, gravadas contra o **h2bapply.com real** (o Google
exige domínio real no vídeo, então localhost/staging não serve).

---

## 3) O que já está pronto (não depende de mais nada)

- ✅ Só `openid email profile gmail.send` é pedido, em TODO fluxo OAuth do
  sistema (usuário e conta de notificações) — hardcoded em `server.js`,
  não é mais toggle por ambiente/servidor desde o v195 LOTE 14.
- ✅ Nenhuma rota lê a caixa de entrada — bounce-scan e polling de resposta
  foram desligados de propósito (regra 13d/13e do CLAUDE.md — proibido
  reintroduzir sem ordem nova e expressa do dono).
- ✅ Política de Privacidade (`/privacidade`, `/privacy`) e Termos
  (`/termos`, `/terms`) publicados, públicos, sem exigir login, com a
  frase de "Limited Use" da API do Google.
- ✅ Página dedicada `/google-data-usage` só sobre uso de dados do Google
  (reforça a Limited Use disclosure com um link direto e curto pro
  revisor, sem precisar ler a política inteira).
- ✅ Página de exclusão de conta funcional (`/delete-account`,
  `/excluir-conta`) — revoga o token no Google de verdade antes do
  soft-delete.
- ✅ Privacidade e Termos linkados no **rodapé de toda página pública**
  (landing, modal de consentimento do cadastro, footer do app logado) —
  todos como link relativo, então sempre apontam pro MESMO domínio que
  está no ar (nenhum link fixo pra domínio errado ou porta de teste).
- ✅ `robots.txt` e `sitemap.xml` existem e respondem.
- ✅ `manifest.json` com ícones 192/256/384/512 — o "Baixar App" é um PWA
  instalado (atalho do navegador) usando o **mesmo client OAuth e o mesmo
  único escopo** do site — não é um app nativo separado, não precisa de
  verificação adicional pra mobile.
- ✅ Renovação automática de token expirado no meio da fila de envio
  (401/`invalid_grant` disparam refresh e RE-TENTAM o mesmo envio — regra
  13a3 do CLAUDE.md) — o produto continua funcionando corretamente mesmo
  com token vencido, o que é um sinal de robustez que reviewers também
  avaliam.
- ✅ `state` anti-CSRF gerado com `crypto.randomBytes`, consumido uma única
  vez no callback, nunca reaproveitável.
- ✅ Rate limit no início do fluxo OAuth (30 tentativas / 15 min / IP).
- ✅ **Confirmação extra (dono, 20/09/2026)**: o aviso de "app não
  verificado" do Google **já aparece de verdade hoje** em produção — a
  tela "Como conectar" da conta de notificações do sistema no painel
  admin diz literalmente *"Se aparecer 'app não verificado': Avançado →
  Acessar h2bapply.com"* — confirma que a verificação é mesmo necessária
  agora, não é só teórico.
- ✅ **Confirmação extra (dono, 20/09/2026)**: a conta de notificações do
  sistema (usada só pra avisar admins de novos pedidos, regra 10b/13d)
  usa a mesma lógica de permissão só-envio (`gmail.send`), igual o fluxo
  do usuário comum — é tudo o mesmo client OAuth e o mesmo único escopo
  sensível em todo o sistema, o que deixa a justificativa pro Google
  ainda mais simples e verdadeira (um caso de uso só, sem exceção).
- ✅ Nenhum erro de JavaScript no console — coberto pela guarda de sintaxe
  `vm.Script` em todo `<script>` inline do smoke test (regra 6g).
- ✅ HTTPS em toda navegação, sem conteúdo misto.

---

## 4) O que só o Andrio consegue fazer (exige login pessoal no Google)

Nada aqui é código — são ações no **Google Cloud Console** e no **Google
Search Console**, que exigem a senha/2FA da conta do Andrio.

### A. Domínio (Search Console) — ✅ CONCLUÍDO 20/09/2026
1. ✅ Propriedade `h2bapply.com` verificada.
2. ✅ Homepage, Link da Política de Privacidade e Link dos Termos corrigidos
   de `h2bapply-2026.onrender.com` (URL antiga do Render, causa raiz de o
   Google não conseguir verificar) pra `h2bapply.com` / `h2bapply.com/
   privacy` / `h2bapply.com/terms`.
3. ⏳ Conferir se ainda sobrou algum `onrender.com` na lista de "authorized
   domains" do Cloud Console (redirect URIs / JavaScript origins) — vale
   uma olhada rápida mesmo com o branding já aprovado.

### B. Tela de consentimento OAuth (Cloud Console → OAuth consent screen) — ✅ CONCLUÍDO 20/09/2026
4. ✅ Nome do app, e-mails de suporte/contato, Homepage URL, Authorized
   domains, escopos declarados, tipo de usuário Externo e publishing
   status "Em produção" — tudo conferido; **branding verificado e
   publicado** ("Sua marca foi verificada e está aparecendo para os
   usuários").
5. ✅ Justificativa do escopo `gmail.send` já estava bem escrita na tela
   (o texto da seção 1 deste arquivo serve de referência/backup, caso
   precise reescrever algo).
6. **Nota pro pós-aprovação**: se o logo ainda não subiu, mantê-lo fora até
   a verificação de ACESSO A DADOS (não só a de marca) ser aprovada — a de
   marca já passou, mas a de dados (que precisa do vídeo) ainda não foi
   nem submetida.

### C. Vídeo — ⏳ PENDENTE (única coisa que falta)
7. Gravar o roteiro da seção 2, **seguindo o jeito seguro da seção 2b**
   (conta Gmail descartável + conta H2BApply nova + envio de teste pro
   próprio e-mail — nunca na conta de produção real) — em inglês, no
   domínio real `h2bapply.com`.
8. Subir no YouTube como **não listado** e copiar o link.

### D. Envio da verificação de acesso a dados — ⏳ PENDENTE
9. Colar o link do vídeo no formulário de verificação (a justificativa já
   está preenchida — item 5) e enviar pra revisão.
10. Responder rápido e sempre em inglês se o time do Google pedir algo a
    mais — é isso que mais segura o prazo (normalmente poucos dias, sem
    prazo fixo garantido).

### E. Pós-aprovação
11. Escopo sensível não tem prazo fixo de revalidação anual (isso é regra
    do escopo *restrito*/CASA) — ainda vale conferir uma vez por ano se a
    política do Google mudou algo.

---

## Erros mais comuns que reprovam — evitar

- Nome do app inconsistente entre o site e a tela de consentimento.
- Subir logo junto na primeira submissão (item B.12).
- Homepage/política hospedada em domínio não verificado no Search Console.
- Vídeo sem mostrar a tela de consentimento, ou gravado fora do domínio
  real de produção.
- Pedir qualquer escopo a mais "por via das dúvidas".
- Responder devagar, ou em português, ao time de revisão do Google.
- Política de privacidade sem a frase de Limited Use (a nossa já tem).

---

## Fontes oficiais consultadas

- [Sensitive scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Restricted scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Verification requirements — Google Cloud Platform Console Help](https://support.google.com/cloud/answer/13464321)
- [Unverified apps — Google Cloud Platform Console Help](https://support.google.com/cloud/answer/7454865)
