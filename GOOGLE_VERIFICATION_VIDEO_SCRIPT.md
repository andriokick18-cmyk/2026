# 🎬 Roteiro do Vídeo de Verificação Google — H2BApply

**Para:** Google OAuth Verification Team  
**Duração recomendada:** 3-5 minutos  
**Idioma:** Inglês (obrigatório para a verificação Google)  
**Formato:** MP4, horizontal, boa resolução

---

## ANTES DE GRAVAR

- Use screen recording (ex: Android screen recorder, OBS, ou Loom)
- Grave em inglês — o Google exige inglês para análise
- Mostre claramente cada passo sem cortes bruscos
- Ative legendas se possível

---

## ROTEIRO COMPLETO (fale em inglês)

### INTRODUÇÃO (0:00 - 0:30)

> "Hello, my name is Andrio Kickhofel, co-founder of H2BApply, accessible at h2bapply.com.
> 
> H2BApply is a platform that helps Brazilian workers apply for H-2B and H-2A seasonal work visa jobs in the United States.
> 
> In this video, I will demonstrate how our app uses Google OAuth and the Gmail API."

---

### PASSO 1 — MOSTRAR A HOMEPAGE (0:30 - 1:00)

- Abra o navegador em **h2bapply.com**
- Mostre a página inicial
- Diga:

> "This is our homepage at h2bapply.com. Users can sign in with their Google account to access the platform."

---

### PASSO 2 — FLUXO DE LOGIN GOOGLE (1:00 - 1:45)

- Clique em "Entrar com Google"
- A tela de consentimento do Google vai aparecer
- Mostre os **escopos solicitados**: openid, email, profile, gmail.send
- Diga:

> "When a user clicks Sign in with Google, they are redirected to the Google OAuth consent screen. 
>
> The app requests only four permissions:
> - openid, email, and profile — to authenticate the user
> - gmail.send — to send job application emails on behalf of the user
>
> We do NOT request access to read, modify, or delete any emails."

- Complete o login

---

### PASSO 3 — MOSTRAR O PAINEL (1:45 - 2:30)

- Mostre o painel logado com nome/foto do Google
- Diga:

> "After login, the user's Google name and profile picture are displayed in the dashboard.
> 
> The user can browse H-2B and H-2A job listings from the U.S. Department of Labor database."

- Mostre a lista de vagas

---

### PASSO 4 — DEMONSTRAR O ENVIO DE EMAIL (2:30 - 3:30)

- Selecione uma vaga na lista
- Clique em "Candidatar-se" (Apply)
- Mostre o modal de envio
- Envie para uma vaga de teste (ou mostre o histórico de enviados)
- Diga:

> "The core feature of H2BApply is sending job application emails. When the user clicks Apply, the app uses the Gmail API with the gmail.send scope to send an email directly from the user's Gmail account to the employer.
>
> The email is sent WITH the user's explicit consent. The user can see exactly what will be sent before confirming.
>
> After sending, the application appears in the user's sent history."

---

### PASSO 5 — MOSTRAR HISTÓRICO (3:30 - 4:00)

- Navegue para a aba "Candidaturas Enviadas"
- Mostre o histórico com empresas, cargos e datas
- Diga:

> "Users can see all applications sent, including the company name, job title, and date sent. This confirms that gmail.send is used only for sending job applications."

---

### PASSO 6 — MOSTRAR PAGES DE PRIVACIDADE (4:00 - 4:30)

- Abra **h2bapply.com/privacy** no navegador
- Mostre a página
- Abra **h2bapply.com/google-data-usage**
- Diga:

> "Our privacy policy at h2bapply.com/privacy clearly explains how we use Google data. We also have a dedicated Google Data Usage page at h2bapply.com/google-data-usage that explains our Limited Use compliance."

---

### CONCLUSÃO (4:30 - 5:00)

> "To summarize:
>
> H2BApply uses Google OAuth to authenticate users and the Gmail API with gmail.send scope ONLY to send job application emails on behalf of users.
>
> We do not read, store, or share any Gmail content.
> We comply fully with Google's Limited Use requirements.
>
> Thank you for reviewing our application."

---

## JUSTIFICATIVA DOS ESCOPOS (copiar e colar no formulário do Google)

### Para `gmail.send`:

> H2BApply is a job application platform for Brazilian workers seeking H-2B and H-2A seasonal work visas in the United States. The core functionality of the app is to send job application emails to U.S. employers on behalf of users.
>
> The `gmail.send` scope is required because:
> 1. The emails must be sent FROM the user's own Gmail account, so employers receive applications from a real person's email address
> 2. This ensures deliverability and authenticity of job applications
> 3. We send ONLY emails that the user has explicitly authorized
> 4. We NEVER read, modify, or delete the user's emails
> 5. Users can pause or stop sending at any time and can revoke access at myaccount.google.com/permissions
>
> There is no alternative way to accomplish this core functionality without the gmail.send scope.

---

## DICAS IMPORTANTES

- ⚠️ O vídeo deve ser em INGLÊS
- ⚠️ Mostre a consent screen real do Google (com os escopos listados)
- ⚠️ Mostre que você está logado e que o email foi de fato enviado via Gmail
- ⚠️ Mostre a página /privacy em inglês também se possível
- 📤 Faça upload no Google Drive ou YouTube (não listado) e cole o link no formulário
