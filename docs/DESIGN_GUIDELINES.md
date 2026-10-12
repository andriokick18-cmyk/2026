# 🎨 DESIGN GUIDELINES — H2BApply (v969, ordem do dono em 12/10/2026)

> O dono mandou uma transcrição (vídeo "5 ferramentas de design do Claude Code")
> e ordenou: "aprenda, guarde na memória pra sempre e implemente tudo".
> Este arquivo é a implementação das 5 ferramentas DENTRO do repo — toda sessão
> de IA deve obedecê-lo em QUALQUER mudança visual. A ordem resumida vive no
> CLAUDE.md (seção 🎨); este é o manual completo. Texto/mensagens têm manual
> próprio (`H2BAPPLY_UX_RULES.md`) — os dois valem juntos.

## 1) RÉGUA DE BOM GOSTO (a "Taste Skill")

O que "premium" significa NESTE produto (público: trabalhador brasileiro,
celular barato, sol no olho, pressa):

1. **Clareza vence decoração.** Cada tela tem UMA ação principal, óbvia em 3
   segundos. Se dois botões disputam atenção, um deles vira secundário
   (ghost/outline) — nunca dois gradientes brigando.
2. **Hierarquia tipográfica, não gritaria.** Título > subtítulo > corpo > nota,
   com saltos claros (ver escala no §3). NUNCA tudo em bold; peso 800+ é só
   pra título e número que importa.
3. **Espaço em branco é recurso, não desperdício.** Padding interno consistente
   (12/14/16px nos cards), gap vertical de 10–14px entre blocos. Tela apertada
   parece quebrada; tela espaçada parece cara.
4. **Cor com papel.** Azul = ação; verde = sucesso/dinheiro recebido; âmbar =
   atenção/pendente; vermelho = erro/perigo; roxo = marca/destaque especial.
   Cor fora do papel confunde (ex.: botão verde de "cancelar" é proibido).
   Fundo colorido SEMPRE na versão translúcida do token (`--bluel`, `--greenl`…)
   com a borda irmã (`--blueb`…), nunca cor chapada atrás de texto escuro.
5. **Gradiente é tempero, não prato.** No máximo 1 gradiente por tela visível
   (o CTA principal ou o hero). "Degradê roxo com três cards arredondados" em
   série é exatamente o clichê que o dono proibiu.
6. **Ícone acompanha texto, não substitui.** Tabler Icons, 1 por rótulo,
   sempre com `aria-label` quando o botão é só-ícone (guarda já existe).
7. **Consistência > novidade.** Componente novo só quando NENHUM existente
   serve (.btn, .alert, .jcard, .stab, cards padrão). Antes de desenhar,
   procurar o padrão já usado na tela vizinha e copiar o idioma.
8. **Mobile primeiro de verdade.** 360px é a tela de referência: sem scroll
   horizontal, alvo de toque ≥44px, texto ≥12px (nota) / ≥13.5px (corpo),
   botão principal ≥48px de altura.
9. **Tema claro E escuro sempre.** Toda cor nova deriva de token de `:root`
   com a variante `[data-theme="dark"]` — hex solto em style inline só se
   funciona nos DOIS temas (testar!). Contraste mínimo AA 4.5:1 (guarda --t3).
10. **Linguagem do modelo REAL deste repo.** Aqui plano é VENDIDO direto
    (PIX + comprovante, decisão do dono no v218) — "assine", "pague via PIX"
    e preço em R$ são corretos e ficam. ATENÇÃO: a "linguagem v66"
    (doação/diamantes) é regra do repo ANTIGO congelado — NÃO vale aqui;
    auditoria que acusar "violou v66" neste repo é falso positivo. Texto e
    tom seguem `H2BAPPLY_UX_RULES.md`.

## 2) CHECKLIST DE AUDITORIA (as "Web Design Guidelines")

Rodar mentalmente (e com prints reais quando a mudança é visual) ANTES de dar
qualquer entrega visual por pronta:

- [ ] A ação principal da tela é a mais visível? (tamanho, cor, posição)
- [ ] 360px: sem overflow horizontal, nada sobreposto, toque ≥44px?
- [ ] Desktop 1280px: a tela não ficou "esticada" (max-width nos blocos)?
- [ ] Tema escuro: algum texto sumiu? Algum fundo chapado claro sobrou?
- [ ] Contraste AA em TODO texto novo (inclusive placeholder e nota)?
- [ ] Espaçamentos seguem a escala (§3)? Nenhum margin/padding "mágico" tipo 7px/23px?
- [ ] Os raios de canto usam --r/--rl/--rxl (ou os já usados no bloco vizinho)?
- [ ] Toda string nova passou pelo LANG_DICT (3 línguas, regra 6f)?
- [ ] Estados vazios/erro/carregando desenhados (nunca tela branca ou spinner eterno)?
- [ ] Interpolação em innerHTML passa por esc() (check-xss-guard)?
- [ ] sw.js bumpado se mexeu em index/admin/app.js/h2b-extras (regra 6c)?
- [ ] Saldo de <div> das views conferido (regra 6d)?

## 3) DESIGN SYSTEM REAL DO SITE (o "Awesome Design")

Fonte única: o `:root` do index.html (claro) + `[data-theme="dark"]`. NUNCA
inventar um segundo sistema; mudar token = mudar o site inteiro de uma vez.

**Tipografia** — família: `'DM Sans', system-ui, sans-serif` (body 15px/1.5).
Escala usada no site (não inventar tamanhos fora dela sem motivo):
nota 10–11px · corpo pequeno 12–12.5px · corpo 13–14px · destaque 14.5–15px ·
subtítulo 16–17px · título de card 18–20px · título de tela 22–26px ·
hero 32–44px. Pesos: 400 corpo, 600–700 rótulo/botão, 800 título, 900 só hero/número-herói.

**Cores (claro)** — fundo `--bg #f0f4ff`; superfícies `--surface/#fff`,
`--sf2 #f5f7ff`, `--sf3 #edf0ff`, `--sf4 #e0e7ff`; texto `--text #1e1b4b`,
`--t2 #4c4f82`, `--t3 #6d70a6` (mínimo AA), `--t4` só decorativo;
bordas `--border`/`--border2` (roxo translúcido).
Semânticas: `--blue/--blueh/--bluel/--blueb`, `--green/…l/…b`, `--red/…l/…b`,
`--amber/…l/…b`, `--purple/--purpleh/…l/…b`. Receita de badge/alerta:
`background:var(--Xl); border:1.5px solid var(--Xb); color:` tom escuro da família.
Tema escuro redefine os mesmos tokens — por isso hex direto é proibido em
componente novo.

**Raios** — `--r:10px` (botão/controle), `--rl:14px` (card), `--rxl:20px`
(card-herói/modal). Já usados também: 12px (sub-card) e 16px (card grande) —
escolher o do vizinho, nunca um novo.

**Sombras** — `--shadow` (repouso), `--shadowm` (flutuante), `--shadowl`
(modal). Sombra colorida só em CTA (ex.: `0 2px 8px rgba(37,99,235,.25)`).

**Espaçamento** — escala de uso: 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 ·
32px. Padding de card: 12–16px; gap de lista: 10–12px; respiro de seção: 20–32px.

**Componentes canônicos** (reusar, não redesenhar): `.btn` + `.btn-primary`
(gradiente azul→índigo, o ÚNICO gradiente "de série") / `.btn-ghost`-like
cinza; `.alert al-red/al-green/...`; `.jcard` (vaga); `.stab` (aba de
planilha); card padrão `background:var(--surface);border:1.5px solid
var(--border);border-radius:14–16px`; pill/badge arredondado 99px.

## 4) IMAGEM → CÓDIGO (o "Image to Code")

Quando o dono mandar print/foto de um design que gostou:
1. LER a imagem de verdade (tool Read) e descrever o que a torna boa
   (hierarquia, espaçamento, cor) ANTES de codar.
2. Reproduzir a ESTRUTURA adaptada ao nosso design system (§3) — nossos
   tokens, nossa fonte, nossos componentes — nunca colar o estilo alheio cru,
   nunca copiar marca/logo/ilustração de terceiro.
3. Entregar com a auditoria do §2 + print comparativo (lado novo × referência).

## 5) AUTO-REVISÃO VISUAL NO CHROMIUM (o "Playwright")

Toda entrega que MUDA uma tela termina com o Claude ABRINDO a tela:
- Script fora do repo (scratchpad), padrão dos já existentes (insta-check/):
  sobe o server com TEST_LOGIN_TOKEN em porta própria, loga via
  /api/test/login, fotografa em 1280px E 360px, claro e (quando a mudança toca
  cor) escuro, e CONFERE por `getBoundingClientRect`/`getComputedStyle` o que
  afirmou (visível, sem overflow, alvo ≥44px, console sem erro).
- O print é prova, não enfeite: olhar a imagem e procurar o que está feio —
  desalinhado, apertado, cortado — antes de dar por pronto.
- Em produção o dono confirma visual (sandbox não alcança produção).

## 6) FILA DE POLIMENTO (1ª auditoria real, 12/10/2026 — achados confirmados ainda não aplicados)

Rodada 1 aplicada (v969): rodapé fixo magro no celular · pill "Veja como
funciona" fluindo · "Ao vivo" 1 linha · "H-2B/H-2A" sem quebra no hífen (card
Instagram, login e botão do guia) · gate com 1 ação principal (Criar conta) ·
aba de planilha ATIVA preenchida (anel âmbar só na ativa) · selo MAIS NOVA sem
corte (z-index) · data dos chips em DD/MM/AAAA · contador sem número repetido ·
"Próximo passo" com tokens (bug real do tema escuro) · saudação legível sobre a
foto · placeholder AA · prova social some quando zerada · risca clara no fim da
landing · aviso do Aprenda com tokens + respiro na última aba · card duplicado
de "Gmail conectado" no Perfil. Falsos positivos descartados: "molduras vazias"
(imagens lazy no print de página inteira — carregam no navegador real) e tudo
que citava "linguagem v66" (regra do repo antigo; aqui plano é vendido via PIX).

Pendentes (ordem sugerida):
1. Nomes de plano inconsistentes na MESMA tela (badge "Pro" × textos "Máximo/
   VIP/VIPro") — régua única de rótulo de plano no front.
2. Card do Instagram (desktop): coluna de texto estreita com espaço morto à
   direita — flex da coluna + nowrap no eyebrow.
3. Hierarquia da 1ª dobra da landing: Instagram acima do produto disputa com o
   CTA (decisão do dono — ele PEDIU Instagram no topo; só revisitar com ele).
4. Vãos desiguais: cards "Veja o site por dentro", "Em 4 passos" (ícones
   dançando), cards dos criadores (2 × 3 links).
5. Salário 2x no card de vaga; iconografia dupla (emoji + ícone Tabler) em
   série (pill Turbo com 3 ícones, tiles da Home com emoji repetido).
6. Rodapé fixo no desktop ainda cobre ~40px de conteúdo (padding-bottom no
   body ou tirar o fixo no desktop).
7. 2 ícones de YouTube idênticos no rodapé (Andrio/Diego) — diferenciar rótulo.
8. Aprenda: parágrafos sem max-width (~70ch) no desktop.
9. Badge "OBRIGATÓRIO" do WhatsApp continua vermelho com o campo preenchido.
10. Texto corrido da landing ainda quebra "H-" no meio de parágrafos (resolver
    por CSS geral da landing, não span a span).
