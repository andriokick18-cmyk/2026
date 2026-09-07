# 🔐 Google OAuth Master Audit — H2BApply
**Data:** Junho 2026 | **Versão:** 1.0 | **Auditor:** Claude (Anthropic)

---

## 🐛 PROBLEMAS ENCONTRADOS E CORRIGIDOS

### CRÍTICO — Bug de rota /privacy fora do servidor
- **Problema:** O bloco de código da página `/privacy` estava colado FORA do `server.listen()`, tornando-o código morto — a rota nunca era atingida.
- **Causa:** Merge/edição acidental colou código depois do `});` de fechamento do server.
- **Correção:** Código removido de fora do servidor. Nova rota `/privacidade||/privacy` completa e corrigida inserida dentro do handler HTTP.
- **Impacto:** A página de privacidade agora funciona corretamente.

### MÉDIO — Ausência de robots.txt e sitemap.xml
- **Problema:** Sem robots.txt e sitemap, o Google não consegue indexar o site eficientemente.
- **Correção:** Rotas `/robots.txt` e `/sitemap.xml` adicionadas.

### MÉDIO — Ausência de páginas exigidas pelo Google
- **Problema:** Google exige páginas específicas para verificação de apps com escopos sensíveis.
- **Correção:** Adicionadas: `/google-data-usage` e `/oauth-explanation`.

---

## 📁 ARQUIVOS MODIFICADOS

| Arquivo | Modificação |
|---------|-------------|
| `server.js` | Corrigido bug crítico de rota /privacy fora do handler |
| `server.js` | Adicionado: `/robots.txt` |
| `server.js` | Adicionado: `/sitemap.xml` |
| `server.js` | Adicionado: `/google-data-usage` (exigido pelo Google) |
| `server.js` | Adicionado: `/oauth-explanation` |
| `server.js` | Rota `/privacidade\|\|/privacy` reescrita — mais completa e conforme Limited Use |
| `GOOGLE_VERIFICATION_CHECKLIST.md` | Criado — lista completa de pendências |
| `GOOGLE_VERIFICATION_VIDEO_SCRIPT.md` | Criado — roteiro do vídeo para submissão |
| `GOOGLE_OAUTH_MASTER_AUDIT.md` | Este arquivo |

---

## 🔑 ESCOPOS UTILIZADOS

| Escopo | Classificação Google | Sensível? | Por quê é necessário |
|--------|---------------------|-----------|----------------------|
| `openid` | Básico | ❌ Não | Autenticação padrão OAuth 2.0 |
| `email` | Básico | ❌ Não | Identificar o usuário na plataforma |
| `profile` | Básico | ❌ Não | Exibir nome e foto no painel |
| `gmail.send` | **Sensível** | ✅ **Sim** | Enviar emails de candidatura em nome do usuário |

---

## ✅ ESCOPOS REMOVIDOS / NÃO UTILIZADOS

| Escopo | Por que foi evitado |
|--------|---------------------|
| `gmail.readonly` | Não necessário — não lemos emails |
| `gmail.modify` | Não necessário — não modificamos emails |
| `gmail.compose` | Não necessário — apenas enviamos via API |
| `mail.google.com` | Acesso total ao Gmail — desnecessário e proibido para uso limitado |
| `https://www.googleapis.com/auth/gmail.labels` | Não necessário |
| `drive` | Não utilizado |
| `calendar` | Não utilizado |
| `contacts` | Não utilizado |

**O app usa o MÍNIMO necessário de escopos.**

---

## 📊 INVENTÁRIO OAUTH COMPLETO

### Endpoints OAuth
| Rota | Método | Função |
|------|--------|--------|
| `/oauth/start` | GET | Inicia fluxo OAuth principal (login do usuário) |
| `/oauth/callback` | GET | Processa code do Google, salva tokens |
| `/oauth/add-sender` | GET | Inicia OAuth para adicionar Gmail secundário |
| `/oauth/add-sender/callback` | GET | Processa código do Gmail secundário |

### Armazenamento de Tokens
| Dado | Onde | Proteção |
|------|------|----------|
| `refresh_token` | `users.json` no disco do Render | HTTPS, sem exposição via API |
| `access_token` | Memória (sessão) + `cached_access_token` no DB | Expira em 1h |
| `cached_token_expiry` | `users.json` | Verificado antes de usar |

### Gmail API
- **Endpoint:** `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
- **Uso:** Exclusivamente para envio de emails de candidatura
- **Autenticação:** Bearer token (access_token renovado via refresh_token)
- **Proteção:** Token renovado automaticamente antes da expiração

---

## 🎯 RISCO DE APROVAÇÃO

| Fator | Status | Impacto |
|-------|--------|---------|
| Escopos mínimos | ✅ Correto | Positivo |
| Páginas de privacidade | ✅ Completas | Positivo |
| google-data-usage page | ✅ Criada | Positivo |
| Uso legítimo de gmail.send | ✅ Justificado | Positivo |
| App em modo Testing | ⚠️ Precisa publicar | BLOQUEANTE |
| Verificação de domínio no GCC | ⚠️ Verificar | Importante |
| Logo na consent screen | ⚠️ Falta upload | Médio |
| Vídeo de demonstração | ⚠️ Precisa gravar | Importante |

**Estimativa de aprovação:** Alta — se o vídeo e justificativa forem enviados corretamente.  
**Prazo típico:** 4-6 semanas após submissão.

---

## 🚀 PASSOS FINAIS (em ordem)

### No Render (agora):
1. Fazer deploy deste ZIP
2. Testar: `curl https://h2bapply.com/privacy`
3. Testar: `curl https://h2bapply.com/google-data-usage`
4. Testar: `curl https://h2bapply.com/robots.txt`

### No Google Cloud Console:
5. Acessar console.cloud.google.com
6. APIs & Services → OAuth consent screen
7. Preencher todos os campos:
   - App name: **H2BApply**
   - User support email: **suporte@h2bapply.com**
   - App logo: upload 120x120 PNG (usar icon-512.png redimensionado)
   - App homepage: **https://h2bapply.com**
   - App privacy policy: **https://h2bapply.com/privacy**
   - App terms of service: **https://h2bapply.com/terms**
   - Authorized domain: **h2bapply.com**
   - Developer contact: **suporte@h2bapply.com**
8. Scopes: confirmar que apenas os 4 escopos listados estão adicionados
9. Clicar **PUBLISH APP** (sair do Testing)
10. Clicar **Submit for verification**
11. No formulário de verificação:
    - Colar a justificativa do gmail.send (ver VIDEO_SCRIPT.md)
    - Anexar link do vídeo (YouTube não listado ou Google Drive)
12. Aguardar email do Google

---

## 📬 LINKS ÚTEIS

- Console: https://console.cloud.google.com/apis/credentials/consent
- Política Google API: https://developers.google.com/terms/api-services-user-data-policy
- Escopos sensíveis: https://developers.google.com/identity/protocols/oauth2/scopes
- Verificação: https://support.google.com/cloud/answer/9110914
- Status da verificação: https://console.cloud.google.com/apis/credentials/consent

---

*Auditoria realizada em Junho 2026. Todos os problemas de código foram corrigidos automaticamente.*
