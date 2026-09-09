# ✅ Checklist completo — Verificação OAuth do Google (H2BApply)

**Atualizado em:** 09/09/2026 · **Domínio:** h2bapply.com · **Servidor único** (a era multi-servidor acabou — não é mais preciso rodar fusão nenhuma antes de verificar).

Consolida e substitui `GUIA_VERIFICACAO_GOOGLE.txt` e o checklist anterior. O roteiro de vídeo continua em `GOOGLE_VERIFICATION_VIDEO_SCRIPT.md`. Todo item marcado **[CÓDIGO]** já foi conferido/corrigido no repositório; todo item **[DONO]** só pode ser feito por fora, no Google Cloud Console / Search Console — nenhum código resolve isso.

---

## Por que isso é rápido e barato pro nosso caso

O Google separa escopos OAuth em 3 níveis: não-sensível, **sensível** (ex.: `gmail.send`) e **restrito** (ex.: `gmail.readonly`, `gmail.modify`, `mail.google.com`). Só escopo **restrito** exige a auditoria **CASA** (paga, cara, demorada, renovada todo ano). `gmail.send` é sensível — verificação padrão e gratuita, **~3 a 10 dias úteis** após submissão completa. O app já pede *só* esse escopo (hardcoded, `GMAIL_SEND_ONLY = true`, `server.js`) — a decisão mais importante já está tomada.

---

## A. Escopo e arquitetura OAuth — técnico, no código

1. **[CÓDIGO ✅]** Só `openid email profile gmail.send` é solicitado — `OAUTH_SCOPES` em `server.js:136`, hardcoded, não é mais toggle por ambiente.
2. **[CÓDIGO ✅]** Nunca `gmail.readonly`/`gmail.modify`/`gmail.metadata`/`gmail.insert`/`gmail.compose`/`mail.google.com`.
3. **[CÓDIGO ✅]** Nenhuma rota lê a caixa de entrada — bounce-scan e polling de resposta desligados de propósito (`GMAIL_SEND_ONLY` guarda isso em pelo menos 3 pontos do server.js).
4. **[CÓDIGO ✅ — conferido 09/09]** `state` contra CSRF: `/oauth/start` gera um valor aleatório de 20 bytes (`crypto.randomBytes`), grava em `sessions["__p__"+state]` (ou `__sender__` no fluxo de conta extra) e consome UMA VEZ SÓ no `/oauth/callback` (`delete` logo após o uso — nunca reaproveitável). Sem state válido = fluxo recusado.
5. **[CÓDIGO ✅ — conferido 09/09]** Rate limit: `/oauth/start` chama `rateLimit(ip+"_oauth", 30, 900_000)` — 30 tentativas por 15 minutos por IP, com aviso claro ao estourar.
6. **[CÓDIGO ✅ — conferido 09/09]** Token revogado de verdade ao excluir conta: `/api/account/delete` chama o endpoint `/revoke` do Google (`oauth2.googleapis.com`) com o `refresh_token`/`cached_access_token` do usuário antes do soft-delete.
7. **[CÓDIGO ✅ — conferido 09/09]** Só 2 redirect URIs vivos no código, sempre construídos a partir de um allowlist de hosts (`_oauthBase()` — nunca aceita host arbitrário do header): `/oauth/callback` (fluxo principal, unificado) e `/oauth/add-sender/callback` (mantido como alias de compatibilidade, redireciona pro unificado). **[DONO]** só falta conferir que os 2 estão cadastrados no Google Cloud Console exatamente assim.
8. **[CÓDIGO ✅ — conferido 09/09]** Renovação automática de token expirado no meio da fila: 401/"Invalid Credentials"/"Token has been expired or revoked" durante um envio (manual ou automático) dispara `refreshTokenForUser`/`refreshSenderToken` e RE-TENTA o mesmo envio — a vaga nunca é queimada por um token vencido, e o erro nunca aparece pro usuário à toa.

## B. Domínio e Search Console

9. **[DONO]** Verificar a propriedade `h2bapply.com` em search.google.com/search-console (registro TXT no DNS da Namecheap).
10. **[DONO]** Confirmar que homepage, política de privacidade, termos, authorized domains, redirect URIs e JavaScript origins **apontam todos pro MESMO domínio verificado** — um único campo divergente (ex.: um subdomínio não verificado) já reprova a submissão inteira.
11. **[DONO]** Remover qualquer `onrender.com` que tenha sobrado da lista de "authorized domains" — domínio de plataforma não conta como domínio próprio.
12. **[DONO]** DNS ativo com HTTPS válido (cadeado) — o Google visita o site durante a análise; domínio fora do ar é reprovação na hora.

## C. Tela de permissão OAuth (Google Cloud Console)

13. **[DONO]** Nome do app **exatamente** igual ao nome mostrado no site: `H2BApply`.
14. **[DONO]** E-mail de suporte real e monitorado (já usamos `suporte@h2bapply.com` em todo o site — usar o mesmo aqui).
15. **[DONO]** E-mail de contato do desenvolvedor real e monitorado.
16. **[DONO]** Homepage URL = `https://h2bapply.com`.
17. **[CÓDIGO ✅]** Privacy Policy URL pronta e pública sem login: `/privacidade`.
18. **[CÓDIGO ✅]** Terms of Service URL pronta e pública sem login: `/termos`.
19. **[DONO]** Authorized domains = só `h2bapply.com`.
20. **[DONO] ⚠️ Estratégico:** NÃO subir logo na primeira submissão — logo dispara uma verificação de marca separada que atrasa tudo. Subir só depois de aprovado.
21. **[DONO]** Escopos declarados na tela = exatamente os usados no código (item 1), nada "por precaução".
22. **[DONO]** Tipo de usuário: **Externo** (qualquer conta Google pode se cadastrar).
23. **[DONO]** Publishing status: **Em produção** (não "Testing") antes de clicar em "Preparar para verificação".

## D. Páginas obrigatórias do site — públicas, sem exigir login

24. **[CÓDIGO ✅]** `/privacidade` e `/privacy` — com o parágrafo "Google API Limited Use Disclosure" em inglês.
25. **[CÓDIGO ✅]** `/termos` e `/terms`.
26. **[CÓDIGO ✅]** `/delete-account` e `/excluir-conta` — funcional, com instrução clara.
27. **[CÓDIGO ✅ — criado agora]** `/google-data-usage` — página dedicada, curta, só sobre o uso de dados do Google (reforça a Limited Use disclosure num link direto e fácil de achar pro revisor, em vez de exigir que ele leia a política inteira).
28. **[CÓDIGO ✅]** Homepage com a seção "Como o H2BApply usa sua conta Google" explicando o escopo em linguagem simples.
29. **[CÓDIGO ✅]** `robots.txt` e `sitemap.xml`.
30. **[CÓDIGO ✅]** Contato visível em mais de um lugar (rodapé + páginas legais + WhatsApp).

## E. O vídeo de demonstração

31. **[DONO]** Gravado no domínio REAL de produção — nunca localhost/staging.
32. **[DONO]** Mostra a tela de consentimento do Google com o nome do app e a permissão "Enviar e-mail em seu nome" visíveis por alguns segundos — o momento mais importante do vídeo inteiro.
33. **[DONO]** Mostra o fluxo completo: login → usuário escreve o próprio e-mail (assunto/corpo/currículo) → clica Enviar → o e-mail aparece em "Enviados" no Gmail do próprio usuário.
34. **[DONO]** Formato: YouTube não listado, 2 a 4 minutos, com ou sem narração (legendas/zoom ajudam).
35. **[DONO] (reforça bastante)** Mostrar myaccount.google.com → Segurança → apps com acesso → H2BApply aparecendo só com "enviar e-mail", nada mais.

## F. Texto de justificativa do escopo

36. **[DONO]** Descrever em inglês, específico ao produto (não genérico) — modelo pronto em `GUIA_VERIFICACAO_GOOGLE.txt`.
37. **[DONO]** Deixar explícito: nunca lê, nunca armazena, nunca acessa a caixa de entrada.
38. **[DONO]** Referenciar a URL exata da política de privacidade dentro do texto.

## G. Erros mais comuns que reprovam — evitar

39. Nome do app inconsistente entre o site e a tela de consentimento.
40. Subir logo junto na primeira submissão (ver item 20).
41. Homepage/política hospedada em domínio não verificado no Search Console.
42. Vídeo sem mostrar a tela de consentimento, ou gravado fora do domínio real.
43. Pedir qualquer escopo a mais "por via das dúvidas" — cada escopo extra exige justificar ele também.
44. Responder devagar, ou em português, ao time de revisão do Google (sempre inglês, sempre rápido — é o que segura o prazo de poucos dias).
45. Política de privacidade sem a frase de Limited Use — a nossa já tem.

## H. Sinais de confiança que reviewers (humanos) avaliam, além do checklist técnico

46. **[pendente — próxima etapa]** Site rápido e limpo no celular — não só "funciona", mas parece profissional. Reviewers do Google acessam pelo telefone também, e isso pesa na avaliação subjetiva de "isso parece legítimo?".
47. **[CÓDIGO ✅]** Sem erros de JavaScript no console — coberto pela suíte de testes (guarda de sintaxe `vm.Script` em todo `<script>` inline).
48. **[CÓDIGO ✅]** HTTPS em toda navegação, sem conteúdo misto.
49. **[CÓDIGO ✅]** Ícones e `manifest.json` completos para instalar como app (192/256/384/512/maskable + favicon já existem).
50. **[CÓDIGO ✅]** Nome da marca consistente em toda parte — título da aba, favicon, rodapé, e-mails, redes sociais.
51. **[CÓDIGO ✅]** Política de privacidade e termos escritos em linguagem clara, não só juridiquês — Google também avalia isso.
52. **[CÓDIGO ✅]** Nada na tela de login que pareça urgência artificial ou phishing (contagens regressivas agressivas, etc.).

## I. Pós-aprovação

53. **[DONO]** Só depois de aprovado: subir o logo real na tela de consentimento.
54. **[DONO]** Desligar qualquer banner temporário de aviso de reset/transição que ainda esteja ligado nas Configurações do admin.
55. **[DONO]** Escopo sensível não tem prazo fixo de revalidação anual (isso é regra do escopo *restrito*/CASA) — ainda assim, vale conferir 1x/ano se a política do Google mudou algo.

---

## 📚 Fontes consultadas (09/09/2026)

- [Sensitive scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Restricted scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Verification requirements — Google Cloud Platform Console Help](https://support.google.com/cloud/answer/13464321)
- [Unverified apps — Google Cloud Platform Console Help](https://support.google.com/cloud/answer/7454865)
- [Google OAuth Verification Guide (2026)](https://singhamandeep.com/google-oauth-verification-guide/)
- [Fix the "App isn't verified" warning (2026)](https://singhamandeep.com/google-oauth-unverified-app-warning/)
