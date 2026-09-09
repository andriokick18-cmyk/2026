# 📜 Instruções do projeto — H2BApply (repo "2026")

> Carregado automaticamente por toda sessão de IA neste repositório.
> Este arquivo descreve o repo **`andriokick18-cmyk/2026`** — uma
> reconstrução enxuta do H2BApply, distinta de outros repositórios do
> mesmo dono que podem ter código e regras diferentes. Nunca presuma
> que uma feature descrita para outro repositório existe aqui sem
> conferir no código real primeiro.

## O que este repo é (e não é)

Leia o `README.md` primeiro — ele é a fonte da verdade sobre o que o
produto faz. Resumo: motor de envio de candidaturas H-2B/H-2A (manual e
automático) por Gmail, login Google, perfis de currículo, compra direta
de plano (Pix → comprovante → ativação, sem moeda intermediária), painel
admin de contabilidade. **NÃO existe** (removido de propósito nesta
reconstrução): ranking/gamificação, IA/Gemini, Cérebro Contábil, aba de
Notícias, chat, seletor de idioma, robôs de coleta de planilha, códigos
promocionais, multi-servidor, menu/drawer hambúrguer.

Se uma tarefa mencionar qualquer uma dessas features removidas, pare e
confirme com o dono antes de reintroduzir — é bem provável que ele esteja
se referindo a outro repositório/projeto.

## Como trabalhar

1. **Corrija a causa raiz**, não o sintoma. Entenda a função inteira
   antes de editar, não só a linha do erro.
2. **`npm test` tem que passar 100% antes de todo commit** (roda
   `npm run check` + `smoke-test.js` — servidor real + fixtures, ~30s).
   O CI (`.github/workflows/ci.yml`) roda a mesma suíte a cada push.
3. **Nada de código morto**: função/rota/arquivo sem nenhum chamador real
   deve ser removido, não comentado ou deixado "por precaução".
   `npm run check` já roda `check-duplicates.js` contra função duplicada.
4. **Service Worker**: toda mudança em `index.html`/`admin.html`/`app.js`
   que altere algo visível ou executável exige subir o `CACHE_NAME` em
   `sw.js` junto — senão aparelhos ficam com JS velho em cache e a tela
   fica em branco ou desatualizada.
5. Commits contam o **porquê**, não só o quê. Sem emojis a menos que já
   seja o padrão do arquivo/commit sendo seguido.
6. Pesquise como sites/produtos de referência resolvem um problema de
   UI/UX antes de inventar um padrão novo — mas para qualquer conteúdo
   sobre vistos (H-2B/H-2A), só fontes oficiais (USCIS, DOL, Federal
   Register, travel.state.gov).

## Regras de produto (confirmadas com o dono — não reverter sem ordem nova)

- **Administrador não tem senha.** Só é admin quem entra com o e-mail
  cadastrado em `ADMIN_EMAIL`/`ADMIN_EMAIL_2` via login Google — a rota já
  exige sessão de admin antes de qualquer ação sensível. Não reintroduzir
  nenhuma senha adicional de admin/editor.
- **Compra direta de plano, preço sempre do servidor.** `GET /api/planos`
  é a fonte única de preço/limites; `POST /api/pedido` recalcula o valor
  oficial no servidor e NUNCA confia num `valorTotal` vindo do cliente.
  Consentimento (`consentimento:true`) é obrigatório pra usuário comum e
  fica registrado com timestamp/versão dos termos.
- **Ativação provisória automática é intencional** (dono, 21/07/2026):
  se o comprovante bate o valor do plano, o usuário é ativado NA HORA por
  alguns dias (janela provisória, `autoAtivarProvisorio` em server.js) —
  mas o pedido continua "pendente" na aba Pedidos do admin, e a
  confirmação humana continua SEMPRE obrigatória pro período cheio. Isso
  não é bug — é intencional, para não fazer o usuário esperar a revisão
  manual pra começar a usar. Cancelar um pedido nesse estado (comprovante
  falso, por exemplo) já revoga o plano provisório automaticamente — ver
  `if(pd.autoAtivado && !pd.ativadoEm)` na rota `PATCH /api/pedido/:id`.
  O painel (`admin.html`) destaca esses pedidos com selo "já ativo
  (provisório)" e sobe eles pro topo da lista — mantenha isso ao mexer
  na tela de Pedidos Pendentes.
- **Chave Pix**: uma só, consolidada (telefone do Andrio), vive em
  `PIX_KEY`/`PIX_NAME` no `app.js`. Não reintroduzir múltiplas chaves.
- **Português fixo**: o app não tem seletor de idioma nem detecta idioma
  do navegador — é só em português, de propósito.

## Variáveis de ambiente

`.env.example` é a fonte da verdade (revisado contra `process.env.*` real
no código — se adicionar uma env nova, adicione lá também). Antes de
remover ou "corrigir" uma env como se fosse obsoleta, confirme com
`grep -rn "process.env.NOME_DA_ENV" *.js` — já aconteceu desse arquivo
ficar desatualizado citando variáveis de uma feature que não existe mais.

## Documentação de deploy/verificação Google

- `GOOGLE_VERIFICATION_CHECKLIST.md` — checklist atual da verificação
  OAuth do Google. Itens `[CÓDIGO]` já resolvidos no repo; itens `[DONO]`
  só o dono resolve (Search Console, Cloud Console, vídeo).
- `GOOGLE_VERIFICATION_VIDEO_SCRIPT.md` — roteiro do vídeo de verificação.
- `RESTAURACAO_BACKUP.md` — como restaurar um backup (drill real testado).

Se encontrar outro arquivo `.md`/`.txt` na raiz descrevendo uma feature
da lista "o que NÃO existe" acima, ou citando outro repositório como
"fonte única"/"servidor 1/2/3", é lixo herdado de outro projeto — apague
em vez de tentar reconciliar.
