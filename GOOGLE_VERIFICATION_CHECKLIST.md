# ✅ Google OAuth Verification Checklist — H2BApply

**Gerado em:** Junho 2026 · **Atualizado em:** 26/07/2026 (v72 — send-only universal)
**App:** H2BApply · **3 servidores, 3 (ou 2) projetos OAuth no Google Cloud**
**OAuth Client:** Google Cloud Console → APIs & Services → Credentials

---

## 🎉 CONFIRMADO HOJE: NENHUM DOS 3 SERVIDORES PRECISA DE CASA

Pesquisei agora na documentação oficial do Google (links no fim) pra ter
certeza, porque isso muda o tamanho do problema inteiro:

O Google divide escopos OAuth em 3 níveis — **não-sensível** (email,
profile), **sensível** (ex.: `gmail.send`) e **restrito** (ex.:
`gmail.readonly`, `gmail.modify`, `gmail.metadata`, `gmail.insert`,
`gmail.compose`, `mail.google.com`). **`gmail.send` é SENSÍVEL, não
RESTRITO** — confirmado na própria referência de escopos do Gmail e nas
páginas de verificação do Google (fontes no fim do arquivo).

Por que isso importa tanto: só escopo **restrito** exige a **auditoria
CASA** (Cloud Application Security Assessment) — um processo caro (pode
passar de milhares de dólares) e demorado (meses), reavaliado TODO ANO.
Quem pede **só escopo sensível** (nosso caso, desde o v72 — TODO servidor
pede só `gmail.send`) passa pela **verificação sensível simples**: sem
CASA, sem auditoria de segurança terceirizada. Prazo típico da própria
documentação do Google: **~3 a 10 dias úteis** depois de uma submissão
completa (bem diferente do "4-6 semanas" que este arquivo dizia antes —
aquele prazo era pro cenário ANTIGO, com `gmail.readonly`+`gmail.modify`,
que É restrito).

**Conclusão prática:** o v72 (26/07) não foi só uma decisão de privacidade
— foi a decisão que tirou os 3 servidores da fila cara/lenta da CASA e
botou todos na fila rápida. Isso vale pros 3 igual, não só pro Servidor 3.

---

## 🚀 PLANO DE ATAQUE — OS 3 SERVIDORES (26/07/2026)

Cada servidor tem seu próprio Client ID no Google Cloud (README_SERVIDORES:
Servidor 1 e 3 têm projeto próprio; o Servidor 2 pode estar usando o
mesmo Client ID do 1 — CONFERIR). Verificação é POR PROJETO OAuth, não por
domínio — ou seja, pode ser preciso repetir este passo a passo até 3 vezes
(uma vez por Client ID diferente).

**ORDEM DE PRIORIDADE (maior impacto primeiro):**
1. **Servidor 3** (applyh2b.com) — CRÍTICO: é onde todo cadastro NOVO
   entra, e o teto de ~100 usuários do app não verificado trava o
   crescimento agora. Prioridade máxima.
2. **Servidor 1** (h2bapply.com) — já tem base de usuários; conferir se
   já foi verificado alguma vez (login do dono no GCC do projeto dele diz).
3. **Servidor 2** (h2b-teste) — se usa o MESMO Client ID do Servidor 1,
   verificar o 1 já resolve os dois.

**PRÉ-REQUISITO do Servidor 3 (bloqueia tudo):** o DNS de applyh2b.com
precisa apontar pro Render e abrir com cadeado (README_SERVIDORES, Caso
1). O Google visita o site do domínio durante a análise — domínio morto
= reprovação na hora. **Ainda pendente hoje** (conferido agora: o domínio
ainda resolve pro parking da Namecheap, não pro Render).

**PASSO A PASSO (repita para cada Client ID/projeto, ~30 min + espera):**
1. search.google.com/search-console → adicionar a propriedade do domínio
   daquele servidor → verificar (DNS TXT na Namecheap ou HTML tag).
2. Google Cloud Console (projeto daquele servidor) → OAuth consent screen:
   - App name: `H2BApply` · Support email: e-mail de suporte daquele servidor
   - App logo: ícone 120x120 (usar o icon-512.png reduzido)
   - App domain / Privacy / Terms: URLs daquele domínio
   - Authorized domains: SÓ o domínio real (remover `onrender.com` se
     estiver lá — domínio de plataforma não é aceito como authorized domain)
3. Mesma tela → Scopes → confirmar que só existe:
   `openid`, `email`, `profile`, `.../auth/gmail.send`
   (se aparecer `gmail.readonly` ou `gmail.modify` sobrando de uma
   verificação antiga, REMOVER — cada escopo a mais que sobra reabre a
   exigência de justificar ele também)
4. Publishing status → **Publish app** → botão **Prepare for verification**.
5. JUSTIFICATIVA DO ESCOPO gmail.send (colar em inglês):
   > H2BApply helps Brazilian workers apply to U.S. seasonal jobs (H-2B/H-2A
   > visas) listed publicly by the U.S. Department of Labor. The user writes
   > their own application e-mails and attaches their own resume; the app
   > sends these applications FROM the user's own Gmail account, one by one,
   > only to employers the user selected. gmail.send is the only Gmail scope
   > requested: the app cannot read, modify, or delete any mailbox content,
   > and does not access the inbox in any way. Each send is user-initiated
   > (manually or via a queue the user starts, pauses and stops at any time).
6. VÍDEO de demonstração (roteiro pronto em
   GOOGLE_VERIFICATION_VIDEO_SCRIPT.md — gravar no domínio daquele
   servidor, mostrando: login → consent com 1 escopo só (send) → usuário
   escreve os próprios textos → envio → o e-mail aparece em "Enviado" DO
   GMAIL DO USUÁRIO). Subir como link não listado no YouTube.
7. Enviar e responder os e-mails do time de verificação (chegam no e-mail
   de suporte daquele projeto — responder SEMPRE em inglês, rápido; é
   assim que se mantém o prazo de ~3-10 dias em vez de esticar).

**Enquanto a verificação não sai:** o aviso amarelo continua (normal) e o
teto de 100 vale no Servidor 3 — se apertar, os primeiros ~100 são os
early users e a verificação vira urgência máxima.

---

## 🟢 JÁ ESTÁ CORRETO (código — vale pros 3 servidores desde o v72)

| Item | Status | Detalhes |
|------|--------|----------|
| **Escopos mínimos** | ✅ | Apenas: `openid`, `email`, `profile`, `gmail.send` — hardcoded, não é mais opcional |
| **Sem escopos restritos** | ✅ | Sem `gmail.readonly`, `gmail.modify`, `gmail.metadata`, `mail.google.com` — nunca mais, nos 3 |
| **Nenhuma leitura de inbox** | ✅ | v72: bounce-scan e polling de resposta foram desligados — zero chamada de leitura ao Gmail |
| **Página de Privacidade** | ✅ | `/privacy` e `/privacidade` — completa, já reflete o modo só-envio |
| **Página de Termos** | ✅ | `/terms` e `/termos` |
| **Página de Exclusão de Conta** | ✅ | `/delete-account` — exigida pelo Google |
| **HTTPS** | ✅ | Render.com fornece SSL automático |
| **robots.txt / sitemap.xml** | ✅ | Presentes |
| **Página google-data-usage** | ✅ | `/google-data-usage` |
| **Política de Limited Use** | ✅ | Declarada na `/privacy` e `/google-data-usage` |
| **Revogação de token** | ✅ | Tokens revogados ao excluir conta |
| **State parameter no OAuth** | ✅ | CSRF protection implementada |
| **Rate limit no OAuth** | ✅ | 15 tentativas por 15 minutos |

---

## 🔴 SÓ O DONO PODE FAZER (fora do código, no Google Cloud Console)

| Item | Prioridade | Onde |
|------|-----------|------|
| **Corrigir DNS do applyh2b.com** | 🔴 BLOQUEIA TUDO | Namecheap + Render (README_SERVIDORES, Caso 1) |
| **Conferir se Servidor 2 usa o MESMO Client ID do 1** | 🔴 CRÍTICO | Evita fazer o trabalho 2x à toa |
| **Verificar domínio no Search Console** | 🔴 CRÍTICO | search.google.com/search-console, por domínio |
| **Authorized domains no GCC (remover onrender.com)** | 🔴 CRÍTICO | OAuth consent screen, por projeto |
| **Logo 120x120 + nome + homepage/privacy/terms** | 🟡 IMPORTANTE | OAuth consent screen, por projeto |
| **Publish app + Prepare for verification** | 🔴 CRÍTICO | OAuth consent screen, por projeto |
| **Colar a justificativa do gmail.send** | 🔴 CRÍTICO | Formulário de verificação |
| **Gravar e subir o vídeo** | 🟡 IMPORTANTE | GOOGLE_VERIFICATION_VIDEO_SCRIPT.md |
| **Responder e-mails do time do Google em inglês, rápido** | 🔴 CRÍTICO | Segura o prazo de ~3-10 dias |

---

## ⚠️ RISCOS (atualizados com a confirmação de hoje)

| Risco | Severidade | Mitigação |
|-------|-----------|-----------|
| App em "Testing" com teto de 100 usuários | 🔴 BLOQUEANTE (Servidor 3) | Publicar + verificar — some sozinho |
| Domínio applyh2b.com sem DNS | 🔴 BLOQUEIA a verificação inteira | Corrigir Namecheap (Caso 1) |
| Sobrar `gmail.readonly`/`modify` de config antiga em algum projeto | 🟡 MÉDIO | Conferir e remover na tela de Scopes antes de submeter |
| ~~`gmail.send` exige CASA~~ | ✅ **DESCARTADO HOJE** | Confirmado oficialmente: sensível, não restrito — SEM CASA |

---

## 📚 Fontes (consultadas 26/07/2026)

- [Sensitive scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Restricted scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Gmail API — OAuth scopes reference](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted Scopes — Google Cloud Platform Console Help](https://support.google.com/cloud/answer/13464325)
