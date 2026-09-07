# 🌎 H2BApply — Mapa do Produto + Auditoria Nível Mundial
**Data:** 28/06/2026 · **Versão:** v9.5 · **Autor:** Claude (papel de arquiteto/PM/UX)
**Princípio:** mapear e priorizar antes de refatorar. Nenhuma big tech reescreve um produto que já gera receita de uma vez — entrega em incrementos validados. Este documento é o plano; a execução vem por etapas com seu aval.

---

## FASE 1 — O NEGÓCIO

**O que é:** SaaS que automatiza candidaturas (e‑mails) de trabalhadores brasileiros para vagas H‑2B e H‑2A nos EUA. Login via Google, envio via Gmail API do próprio usuário.

**Quem usa:** trabalhador brasileiro, muitas vezes iniciante e em inglês limitado, **no celular**. Quer emprego sazonal nos EUA com o mínimo de burocracia.

**Jornada (o que ele faz / por quê / o que espera):**
Cadastro → cria perfil de candidatura + anexa currículo → busca vagas → envia (manual ou automático) → recebe respostas no WhatsApp/app → fecha contrato. Espera: rapidez, simplicidade, e ver respostas chegando.

**Monetização (verdade do backend):** Free (20 manuais + 10 auto/dia) · ⭐ VIP Manual (200 manuais/dia) · ⭐🤖 VIPro (200+200) · 🚀 DoublePro (400+400, 2 Gmails). Trial = **1 dia VIP Manual**. Indicação: indicador +5 dias (+5 se o amigo assinar).

**Gargalos de crescimento (hipóteses fundamentadas):** atrito no cadastro, falta de clareza do "próximo passo", promessas de plano inconsistentes (já corrigidas), e trabalho manual do admin para cobrança/renovação (atacado com a aba Pagantes).

---

## FASE 2 — MAPA COMPLETO (Origem → Processo → Resultado)

**App do usuário (telas via `sv()`):** home, jobs (vagas), pesquisa, saved (salvas), hist (enviadas), respostas, profile (perfil/currículos), auto (automático), plans, ranking, indicar, notificacoes, redeem (resgatar código), tutorial, iaChat, sugestoes, logs.

**Painel admin (telas):** dashboard, usuários, VIP & Planos, Vencimentos VIP, **💳 Pagantes**, Pedidos de Plano, Pedidos‑Lixeira, Códigos, Financeiro, Central de Incidentes, Robô de Auditoria (Gemini), Emails Inválidos, Planilhas de Vagas, IA Admin, Ranking, Indicações, Notificações, Configurações.

**Dados (flat‑file JSON, persistidos em `/data`):** `DB_USERS` (perfil + `vip.manualExpires/autoExpires`), `DB_PEDIDOS` (pedidos: `valorTotal`, `status`, `plano`), `DB_FINANCEIRO` (livro‑caixa: pagamentos/gastos), `DB_REFERRAL`, `DB_INCIDENTS`.

**Fluxos‑chave:**
- **Envio manual:** seleciona vaga → valida perfil+currículo → Gmail API → registra em histórico + anti‑duplicado → decrementa limite.
- **Envio automático:** configura fonte/perfil → fila → bot envia 24/7 em intervalos → watchdog/recuperação em reboot.
- **Compra de plano:** usuário envia comprovante → pedido `pendente` → admin aprova → ativa VIP (acumula dias) → grava no Financeiro.

---

## FASE 3 — AUDITORIA UX/UI (olhar de produto)

**Pontos fortes:** home com hero + card automático em destaque, stats claros, dark mode no admin, fluxo de envio enxuto.

**Atritos encontrados (fundamentados no código):**
1. **Cadastro longo antes do valor** — 7 sub‑telas antes de ver uma vaga. *(parcialmente mitigado: enriquecido com ajuda/privacidade/variáveis)*
2. **Falta de "próximo passo" na home** — o iniciante não sabe o que fazer primeiro. ✅ **Resolvido nesta versão** (card inteligente).
3. **Redundância de navegação** — "Respostas" tem ~10 caminhos; menu mistura ação (Envio) e lugar (Ranking).
4. **Inconsistência de planos** — textos de dias/limites estavam divergentes. ✅ **Corrigidos** (trial 1 dia, free 20/10). ⏳ **Pendente:** card pago "VIP Manual" diz 400 mas entrega 200 (decisão de preço).
5. **Dívida técnica** — funções admin duplicadas. ✅ **Removidas.**

---

## FASE 4 — COMPARAÇÃO COM BIG TECHS (o que copiar)

- **Stripe/Linear:** números de plano vêm de **uma fonte única** (backend), nunca escritos à mão em cada tela. → adotar para acabar com divergência para sempre.
- **Notion/Duolingo:** **checklist de primeiros passos** que destrava recursos. → base já criada (card "Próximo passo"); evoluir para checklist persistente.
- **Instagram/LinkedIn:** onboarding mínimo, perfil completado depois por necessidade. → mover campos não‑essenciais do cadastro para "complete depois".
- **Uber/Airbnb:** 1 ação dominante por tela. → reduzir caminhos redundantes no menu.

---

## FASE 5 — REESTRUTURAÇÃO PROPOSTA (sequenciada, sem remover nada)

Ordem lógica que o usuário espera: **Buscar → Enviar → Acompanhar → Crescer.** Agrupar o menu nesses blocos; manter Ranking/Indicar como "Crescer" (secundário). Cadastro em 2 fases (essencial agora, resto via checklist). Tudo aditivo.

---

## FASE 12 — RELATÓRIO FINAL

**✅ Já entregue e validado (v9.1 → v9.5):**
- Bug crítico da Central de Incidentes (1 caractere derrubava 15 funções) + downloads.
- Textos de trial/planos alinhados ao backend.
- Cadastro enriquecido (privacidade, ajuda, variáveis).
- 4 funções duplicadas removidas (manutenção previsível).
- **Aba 💳 Pagantes** — quem pagou + dias de VIP num lugar só, calculada no servidor, com renovar 1‑clique + CSV; valor puxado do livro‑caixa.
- Acessibilidade: zoom liberado no app.
- **Card "Próximo passo" inteligente na home** (esta versão).
- Memória do Gemini: KB‑021 → KB‑027.

**🔜 Recomendado (priorizado por impacto × risco):**

| # | Melhoria | Impacto | Risco | Esforço |
|---|----------|---------|-------|---------|
| 1 | **Fonte única de planos** (backend → todas as telas) | Alto | Baixo | Médio |
| 2 | **Cadastro em 2 fases** (3 campos + checklist) | Alto (conversão) | Médio | Médio |
| 3 | **Reorganizar menu** (Buscar→Enviar→Acompanhar→Crescer) | Médio | Médio | Médio |
| 4 | **Decisão do plano pago** VIP Manual 400 vs 200 | Médio | Baixo | Baixo |
| 5 | **Checklist de onboarding persistente** na home | Alto (ativação) | Baixo | Médio |

---

## ▶️ PRÓXIMO PASSO — responda com um número

Me responda **só com o número** (ex.: "1") e eu executo essa melhoria já, com ZIP completo validado e KB atualizada:

**1** Fonte única de planos · **2** Cadastro em 2 fases · **3** Menu reorganizado · **4** Resolver plano pago 400/200 · **5** Checklist de onboarding

Se quiser, mando 2 de uma vez (ex.: "1 e 5"). O que **não** vou fazer é refatorar tudo às cegas e arriscar derrubar seu sistema no ar — entrego nível mundial **em incrementos seguros**.
