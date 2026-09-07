# 🔍 AUDITORIA MESTRA — H2BApply
**Data:** 28/06/2026 · **Versão analisada:** v9 (work19) · **Autor:** Claude (co-dono técnico)
**Modo:** Diagnóstico completo — **nenhuma linha de código alterada nesta entrega.**

Analisado o sistema real (não recomendações genéricas): `index.html` (15.606 linhas, app do usuário), `admin.html` (12.275, painel) e `server.js` (10.027, backend). Referências de arquivo/linha incluídas para você conferir.

---

## 📌 RESUMO EXECUTIVO — os 5 achados que mais importam

1. **🔴 Promessa de trial errada** — o app promete "5 dias VIP grátis / 400 por dia", mas o backend dá **1 dia VIP Manual**. Quebra de confiança no dia 2 = churn e reclamação no suporte.
2. **🔴 Cadastro pesado demais para mobile** — o onboarding exige 6 campos pessoais + 7 perguntas H2B + apelido + avatar **antes** de o usuário ver qualquer valor. Muito atrito para trabalhador estrangeiro no celular.
3. **🟠 Dívida técnica perigosa** — funções críticas duplicadas no `admin.html` (`aprovarPedido`, `adminSetPlan`, `verComprovante`, `renderModalCompras`): editar a cópia errada não tem efeito. Foi isso que mascarou o bug da Central de Incidentes.
4. **🟠 Navegação redundante** — "Respostas" tem 10 caminhos diferentes; o menu mistura ação (Envio) com lugar (Ranking). Falta hierarquia de "o que faço primeiro".
5. **🟡 Acessibilidade** — `maximum-scale=1` no viewport impede zoom de pinça. Ruim para usuários mais velhos / baixa visão.

---

## 1. 🔴 PROBLEMAS CRÍTICOS

| # | Problema | Onde | Impacto |
|---|----------|------|---------|
| C1 | **Trial divergente.** Backend = 1 dia VIP Manual (`server.js` L204 `newUserTrialDays:1`; L4444–4446 "Trial boas-vindas 1d VIP Manual", sem auto). Frontend ainda diz "5 dias VIP grátis" e "400 por dia" (`index.html` L3750, L3820–3821, passo final do wizard ~L11974). | index.html ↔ server.js | Usuário se sente enganado → cancela, dá nota baixa, abre ticket. Mina o redesign anti-abuso (KB-015). |
| C2 | **Funções admin duplicadas.** `aprovarPedido` (L7659 **e** L8537), `adminSetPlan` (L8159 **e** L8704), `verComprovante` (L8100 **e** L8566), `renderModalCompras` (L8280 **e** L8813). A 2ª vence; a 1ª é código morto. | admin.html | Editar a versão errada parece "não fazer nada". Foi a causa-raiz oculta do bug de incidentes (KB-021). Risco alto de regressão. |
| C3 | **Fragilidade do bloco `<script>`.** Um único caractere mal escapado derruba ~1.750 linhas e dezenas de funções silenciosamente (já aconteceu 2×: landing e incidentes). | admin.html / index.html | Falhas em cascata difíceis de achar. Precisa de validação `node --check` por bloco antes de cada ZIP. |
| C4 | **Acesso direto a DB_USERS.** `Object.values(DB_USERS)` na rota de incidentes (`server.js` L4598) e possivelmente em outras varreduras, contra a regra da Constituição (sempre `getUser`/`setUser`). | server.js | Risco de inconsistência de dados quando o storage evoluir; viola padrão acordado. Mapear todos os pontos. |

---

## 2. 🟠 PROBLEMAS MÉDIOS

- **M1 — Cadastro longo antes do valor.** `ob-step-1` (6 campos obrigatórios) + `ob-step-1b` (7 perguntas) + `ob-step-1c` (apelido + 20 avatares) acontecem **antes** de o usuário ver uma vaga. Cada passo a mais derruba conclusão. (`index.html` L11745–11900)
- **M2 — "WhatsApp obrigatório" em momento duplicado.** Coletado no onboarding **e** reforçado por modal separado 2s depois (`index.html` L4921–4924). Pode parecer cobrança repetida.
- **M3 — Navegação sem hierarquia clara.** Menu lateral mistura: Home, Envio Manual, Respostas, Ranking, Planos, Enviadas, Indicar, Notificações, Ver tudo, Admin. Falta separar "fluxo principal" (Buscar → Enviar → Acompanhar) de "secundário" (Ranking, Indicar). (`index.html` L1794–1816)
- **M4 — Redundância de atalhos.** "Respostas" alcançável por 10 caminhos (bottom nav, 2 cards da home, atalho da home, "ver tudo", sidebar, drawer…). Bom para descoberta, ruim para foco — o iniciante não sabe qual é "o" caminho.
- **M5 — `ob-step-label` inicia "Passo 1 de 5" mas o wizard tem 7 sub-telas** (1, 1b, 1c, 2, 3, 4, 5). O label é atualizado por JS (`L12688`), mas confira se `total` reflete as sub-telas reais — senão a barra de progresso "mente".
- **M6 — Duplicação de dados pessoais.** Nome/cidade/país/telefone/apelido coletados no onboarding **e** repetidos na aba "Eu" do perfil (`index.html` L2438+). Aceitável para edição, mas confirme que é a mesma fonte de verdade (sem campos órfãos).

---

## 3. 🟡 PROBLEMAS LEVES

- **L1 — `maximum-scale=1`** no viewport (`index.html` L5) bloqueia zoom. Remover melhora acessibilidade sem custo.
- **L2 — Excesso de emojis em labels de formulário** (👤🎂📱🏙️🌍 etc.). Bonito, mas pesa visualmente em telas pequenas; testar versão mais sóbria.
- **L3 — `.btn-sm` mobile = 36px** de altura (`index.html` L11402). Abaixo do ideal de 44px para alvos de toque primários; ok para secundários.
- **L4 — 16 blocos `.home-shortcut`** definidos no CSS — verificar se todos são usados ou se há estilos órfãos.
- **L5 — Arquivos duplicados no ZIP** (`admin-3.html`, `index-1.html`) — risco de subir o arquivo errado. Limpar do pacote de produção.

---

## 4. ⚡ MELHORIAS RÁPIDAS (quick wins — baixo esforço, alto retorno)

1. **Corrigir a promessa do trial** em todos os textos para "1 dia VIP Manual" (ou ajustar o backend, se a intenção for dar mais — decisão de negócio, ver Perguntas). 
2. **Remover `maximum-scale=1`** do viewport.
3. **Apagar as 4 funções duplicadas mortas** do `admin.html` (deixa só a versão canônica).
4. **Tornar "Pular" mais visível** nos passos opcionais do onboarding (hoje é texto cinza pequeno) — reduz a sensação de obrigatoriedade.
5. **Adicionar `node --check` por bloco `<script>`** ao checklist pré-ZIP (previne C3 para sempre).

---

## 5. 🏗️ MELHORIAS ESTRUTURAIS

- **Onboarding em 2 fases:** Fase 1 = só o essencial para começar (nome + WhatsApp + área). Empurrar H2B-detalhado, apelido/avatar e perfil-de-currículo para "complete depois" com um checklist persistente na home. Já existe a base (`checkShowOnboarding`, `ob-step-action`).
- **Fonte única de verdade do plano/trial:** centralizar o texto de "dias e limites" numa variável vinda do backend (`/api/me`) e renderizar dinâmico — nunca hardcodar "5 dias/400" no HTML.
- **Modularizar os `<script>`** gigantes por domínio (incidentes, financeiro, usuários) para que um erro de sintaxe não derrube tudo. Ou ao menos isolar os blocos de maior risco.
- **Eliminar duplicação de funções** com um passo de build que detecta nomes repetidos no escopo global.

---

## 6. 🎨 MELHORIAS DE UX

- "O que faço primeiro?" deve ser respondido em **1 tela**: a home já tem card de Auto + stats + atalhos; falta um **CTA único dominante** ("Buscar vagas →") acima de tudo no primeiro acesso.
- Mensagem de fim de onboarding deve **espelhar o benefício real** (1 dia manual) e dizer claramente o que destrava ao virar VIP.
- Reduzir escolhas simultâneas: 20 avatares numa grade 5×4 no celular é muito; 8–10 cobrem 95% dos casos.

## 7. 🖼️ MELHORIAS DE UI

- Diminuir densidade do `ob-step-1b` (7 perguntas numa tela) — quebrar em 2 telas leves ou usar accordion.
- Padronizar tamanho de toque ≥44px nos botões primários do fluxo de envio.
- Hierarquia tipográfica: hoje muitos `font-weight:800/900` competindo; reservar 900 para 1 elemento por tela.

## 8. 📱 MELHORIAS MOBILE (prioridade do projeto)

- Remover trava de zoom (L1).
- Bottom nav: confirmar que os 5 ícones têm alvo ≥44px e rótulo legível.
- Onboarding: inputs lado-a-lado (grid 1fr 1fr) em telas <360px podem ficar apertados — testar em aparelho pequeno.
- Garantir que modais usem `100dvh` (já visto no detalhe de e-mail — bom padrão, replicar).

## 9. 💰 MELHORIAS DE CONVERSÃO

- **Corrigir C1 é a maior alavanca de retenção** — promessa cumprida no dia 2 evita churn imediato.
- Mostrar **prova de valor antes do paywall**: deixar o usuário buscar e ver vagas reais antes de pedir todos os dados.
- No fim do dia-1 do trial, mensagem proativa: "Você enviou X candidaturas hoje. Vire VIP para automático 24/7."

## 10. 🆕 MELHORIAS PARA NOVOS USUÁRIOS

- Onboarding mínimo (M1/estrutural acima).
- Texto "Pular" claro em todos os passos opcionais.
- Tutorial e Guia acessíveis sem sair do fluxo.

## 11. 💎 MELHORIAS PARA USUÁRIOS VIP

- Deixar limites/dias VIP **sempre visíveis** vindos do backend (sem números fixos no HTML).
- Estado do Envio Automático em destaque na home (já existe `home-auto-card` — bom).

## 12. 🛠️ MELHORIAS PARA ADMINISTRADORES

- Eliminar funções duplicadas (C2) para tornar manutenção previsível.
- Validação `node --check` no checklist (C3).
- Mapear e corrigir acessos diretos a `DB_USERS` (C4).

---

## 🎯 FOCO ESPECIAL: O CADASTRO IDEAL

**Hoje:** 7 sub-telas, ~13 campos obrigatórios + escolhas, tudo antes do primeiro valor.

**Ideal (mobile-first, para trabalhador H2B estrangeiro):**
1. **Tela 1 — Começar (3 campos):** Nome · WhatsApp · Área de interesse. Botão grande "Ver vagas agora →".
2. **Valor imediato:** já mostrar vagas reais da área escolhida.
3. **Complete seu perfil (opcional, persistente):** idade, cidade/país, experiência H2B, inglês, CNH, currículo, perfil de e-mail, apelido/avatar — tudo como checklist na home que destrava recursos ("anexe o currículo para enviar"). 
4. **Apelido/avatar** só quando o usuário abrir o Ranking pela 1ª vez (contexto certo).

Princípio: **pedir o mínimo para gerar valor; o resto vem por necessidade, não por barreira.**

---

## 🧠 RELATÓRIO DE APRENDIZADO PARA O GEMINI (memória evolutiva — somar, nunca apagar)

Sugestão de novas entradas KB para persistir no `server.js` (append-only). **Não foram gravadas ainda** — aguardando seu OK (ver Perguntas).

- **KB-022 — Promessa de trial divergente do backend.** Frontend prometia "5 dias VIP/400 por dia"; backend dá 1 dia VIP Manual. Lição: textos de plano/limite NUNCA hardcodados no HTML — sempre vindos de `/api/me`. Fonte única de verdade. Tags: trial, conversão, consistência.
- **KB-023 — Funções globais duplicadas mascaram bugs.** Definir a mesma função em 2 blocos faz a 2ª vencer e a 1ª virar código morto; editar a errada "não faz nada". Lição: um nome global = uma definição. Tags: arquitetura, dívida-técnica, regressão.
- **KB-024 — Onboarding curto converte mais.** Pedir 13+ campos antes do valor derruba conclusão no mobile. Lição: mínimo para gerar valor; resto via checklist progressivo. Tags: ux, conversão, mobile, onboarding.
- **KB-025 — Acessibilidade do viewport.** `maximum-scale=1` bloqueia zoom e prejudica usuários mais velhos/baixa visão. Tags: acessibilidade, mobile.
- **KB-026 — Validação pré-ZIP.** Rodar `node --check` por bloco `<script>` evita que 1 caractere derrube centenas de funções. Tags: build, qualidade, prevenção.

---

## ❓ PERGUNTAS DE DECISÃO (impactam negócio/arquitetura — escolha A, B ou C)

**P1 — O trial real:** quero alinhar a promessa à realidade.
- **(A)** Manter 1 dia VIP Manual e **corrigir todos os textos** para refletir isso. *(mais honesto, menos abuso)*
- **(B)** Aumentar o trial de verdade (ex.: 3 dias manual) e ajustar textos. *(mais conversão, algum risco de abuso)*
- **(C)** Trial dinâmico configurável pelo admin, textos sempre vindos do backend. *(mais robusto, mais trabalho)*

**P2 — Cadastro:** 
- **(A)** Encurtar para 3 campos + checklist progressivo (recomendado).
- **(B)** Manter os passos, só melhorar "Pular" e densidade.
- **(C)** Você decide o conjunto mínimo de campos e eu redesenho em cima disso.

**P3 — Dívida técnica (funções duplicadas):**
- **(A)** Eu removo as 4 duplicatas mortas agora.
- **(B)** Eu mapeio TODAS as duplicatas do admin.html primeiro e te mostro a lista.
- **(C)** Deixar para depois.

Me diga as letras (ex.: "P1-A, P2-A, P3-B") e eu já começo a implementar — com ZIP completo e KB atualizada, como sempre.
