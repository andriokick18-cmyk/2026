════════════════════════════════════════════════════════════
  H2BApply — GUIA RÁPIDO DE DEPLOY (Render.com)
  Versão: v9.11 · 28/06/2026
════════════════════════════════════════════════════════════

╔══════════════════════════════════════════════════════════╗
║  🚀 RESET DA TEMPORADA — PASSO A PASSO (só logar e fazer)  ║
╚══════════════════════════════════════════════════════════╝
1. Suba estes arquivos no GitHub (commit + push) OU pelo upload do Render.
2. (RECOMENDADO) Baixe um backup do /data antes — é IRREVERSÍVEL.
   E feche o acerto de contas com o Diego (o financeiro vai zerar).
3. No Render → seu serviço → Environment → adicione:
        RESET_NOW = temporada1
   (pode ser qualquer valor; serve de "senha" do reset)
4. Faça o deploy. No boot o sistema reseta TUDO uma única vez, sozinho,
   já sobe com a memória limpa (NÃO precisa reiniciar à mão).
5. Confirme nos logs do Render a linha:  [reset] ✅ Reset concluído.
6. PRONTO. Pode deixar a env RESET_NOW lá — ela NÃO repete o reset
   (fica carimbada em /data/.reset_token). Para resetar de novo no futuro,
   troque o valor (ex.: temporada2) e faça deploy.

O QUE O RESET APAGA: usuários, perfis, currículos, históricos, enviados,
   planos/VIP, pedidos, financeiro, referrals, ranking, push, anti-abuse de
   trial (todos podem pegar trial de novo).
O QUE PRESERVA: admin_settings.json (suas SENHAS de editor e a regra de
   trial 1 dia), knowledge_base.json (treino do Gemini) e as vagas DOL.

(Alternativa manual, se preferir o shell do Render:  npm run reset  e depois
 reinicie o serviço. O método por RESET_NOW acima é mais simples.)

────────────────────────────────────────────────────────────

O QUE MUDOU NESTA VERSÃO (v9.11)
- RESET TURNKEY por env RESET_NOW (roda 1x no deploy, sem shell) — inclui
  zerar o trial_used.json para a nova temporada.
- Script standalone reset_h2bapply.js também zera trial_used.json e cria o
  admin_settings.json (se faltar) já com a regra 1 dia VIP Manual + senhas.
- Atalho npm run reset.

─────────────────────── HISTÓRICO v9.10 ───────────────────────
v9.10 — Correções da auditoria de enraizamento:
P-01 (CRÍTICO) Gmail extra agora exige PLANO PAGO E ATIVO. Trial e dias de
   indicação/promo (source 'trial'/'code') NÃO liberam mais Gmail extra, e
   plano expirado também não (checagem em tempo real via isVipActive).
P-02 (ALTO) Financeiro unificado: lançamentos manuais (entradas e gastos)
   agora PERSISTEM NO SERVIDOR (anexam, sem apagar os automáticos) e somem
   corretamente ao remover. Novos campos "Recebido por" e "Pago por" para o
   acerto entre sócios. Imagem do comprovante continua só no localStorage.
P-03 (MÉDIO) Excluir currículo limpa a referência nos perfis (resumeIdx/
   coverIdx) também na rota DELETE — fim do envio sem anexo.
P-04 (MÉDIO) Anti-abuse de trial por IP afrouxado (2→4 contas/IP) para não
   bloquear redes móveis/CGNAT. googleId continua como regra forte.
P-05 (BAIXO) Constantes órfãs AUTO_INTERVAL_MIN/MAX removidas.

NÃO ALTERADO de propósito (decisão sua):
P-06 Separação de permissões Andrio × Diego (hoje ambos têm poder total).

Mantém tudo da v9.9 (intervalo 5–6 min, data de pagamento, senha de editor
no banco, fallback de e-mail de pedido, etc.).

─────────────────────── HISTÓRICO v9.9 ───────────────────────
O QUE MUDOU NA v9.9
1) INTERVALO DE ENVIO: 3–5 min → 5–6 min (motor + todos os textos). Admin
   continua configurando o seu próprio (mín. 30s).
2) DATA DE PAGAMENTO DO CLIENTE (corrige fluxo de recuperação de VIP):
   no pedido agora há um campo OBRIGATÓRIO "Data em que você pagou".
   Antes ia sempre a data de hoje; agora vai a data real do comprovante,
   travada para não aceitar data futura. É por ela que se confere o VIP.
3) E-MAIL DE PEDIDO mostra a data de pagamento informada ("CONFIRA se bate
   com o comprovante") e tem FALLBACK anti-falha-silenciosa: se a conta
   admin principal estiver sem token, tenta qualquer outro admin — o aviso
   não deixa de sair. (Log avisa se NENHUM admin tiver token.)
4) FINANCEIRO "QUEM DEVE A QUEM": cada pagamento guarda recebidoPor
   (Andrew→Andrio / Diego→Diego, ou pela escolha no modal de aprovação).
   O Robô de Auditoria agora mostra quanto cada sócio recebeu e calcula o
   repasse real ("Fulano repassa R$X para Beltrano") em vez do placeholder.
5) SENHA DE EDITOR NO BANCO: Andrew e Diego trocam a PRÓPRIA senha em
   Configurações → "Minha Conta". As senhas saíram do código e vão para
   admin_settings.json (não vazam nas rotas de settings). Padrões antigos
   continuam valendo até serem trocados.
6) Removido o rótulo fantasma "Aguardando horário (08h-20h)" (envio é 24/7).

PENDÊNCIAS QUE DEPENDEM DE VOCÊ (ver chat):
- Confirmar e-mail do Diego na lista de admins (env ADMIN_EMAILS_EXTRA).
- Decidir se quer unificar o financeiro manual (localStorage) com o do
  servidor — hoje o acerto usa a receita dos pedidos (servidor).

────────────────────────────────────────────────────────────
COMO SUBIR (escolha o seu jeito)
────────────────────────────────────────────────────────────

IMPORTANTE: use os arquivos de DENTRO desta pasta (server.js, index.html,
admin.html, guia.html, etc.). NÃO suba a pasta "work19" inteira — os
arquivos têm que ficar na RAIZ do projeto, onde estão os atuais.

OPÇÃO A — GitHub → Render (recomendado, seu fluxo normal):
  1. Substitua os arquivos no seu repositório pelos desta pasta.
  2. Commit + push.
  3. O Render builda e reinicia sozinho. Pronto.

OPÇÃO B — Upload direto no Render:
  1. Envie os arquivos novos (no mínimo server.js e index.html).
  2. Deixe o serviço reiniciar.

────────────────────────────────────────────────────────────
SOBRE OS DADOS E O "TREINAMENTO" DO GEMINI
────────────────────────────────────────────────────────────
- O disco /data NÃO é apagado no deploy. Usuários, pagamentos, pedidos e a
  base de conhecimento (knowledge_base.json) continuam intactos.
- O "treinamento" do Gemini é a Base de Conhecimento (KB-001…KB-029) embutida
  no server.js. Ao reiniciar, as entradas novas entram sozinhas (merge — só
  soma, nunca apaga). Você não precisa fazer nada manual.
- O Gemini usa esse conhecimento quando você roda o "Robô de Auditoria" no
  painel admin. A cada auditoria ele relê toda a memória acumulada.

────────────────────────────────────────────────────────────
CHECAGEM PÓS-DEPLOY (30 segundos)
────────────────────────────────────────────────────────────
  [ ] Site abre normal (login Google funciona).
  [ ] Admin: aba "Pagantes" carrega quem pagou + dias de VIP.
  [ ] Admin: "Central de Incidentes" abre e baixa relatório.
  [ ] Cadastro novo: avatares do ranking aparecem como círculos pequenos.

Se algo falhar, me avise com o erro exato (print/console) que eu corrijo.
════════════════════════════════════════════════════════════
