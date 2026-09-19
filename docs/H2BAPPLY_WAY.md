# H2BApply Way — como pensamos e trabalhamos

> Princípios do produto e do time. O código existe para servir ao produto; o
> produto existe para servir ao usuário; o H2BApply existe para ajudar pessoas.

## Princípios

- **Simplicidade**: menos funções bem explicadas valem mais do que muitas.
  Antes de criar algo, perguntar por que existe e se há um jeito mais simples.
- **Clareza**: cada tela, botão e campo tem uma missão clara e diz o que
  acontece em seguida.
- **Transparência**: dizemos de onde vêm as vagas, o que o site faz e o que
  não faz, quais permissões pedimos e como usamos os dados.
- **Honestidade**: nunca prometer resultado, nunca mostrar sucesso falso,
  nunca esconder uma falha.
- **Orientação**: o site ensina; o usuário não precisa aprender tecnologia
  para procurar trabalho.
- **Segurança e integridade**: primeiro não causar dano; dados do cliente
  protegidos, nunca no repositório, nunca expostos.
- **Confiabilidade**: o que o site diz que fez, fez. Testes reais provam.
- **Acessibilidade**: celular, letras legíveis, contraste, toque, teclado.
- **Não inventar**: nem dado de vaga, nem regra de H-2B, nem número.

## Como trabalhamos (ordem que nunca muda)

Observar → entender → testar → encontrar o problema → documentar → escrever o
comando → implementar → testar de novo → validar → documentar → procurar o
próximo problema. Nunca "ver problema → alterar código → dar por pronto".

## Antes de qualquer mudança

1. Reler `CLAUDE.md`, `docs/H2BAPPLY_PRODUCT_RULES.md` e
   `docs/H2BAPPLY_UX_RULES.md`.
2. Pesquisar como o mercado resolve (padrão consagrado > invenção); regras de
   H-2B só em fonte oficial.
3. Entender o site inteiro; corrigir na raiz, não o sintoma; perguntar se o
   mesmo problema existe em outro lugar e corrigir de forma sistêmica.
4. Nomear os 3 maiores riscos; medir o impacto em usuário novo e antigo;
   preferir maior impacto com menor risco.
5. Mudança grande ou arriscada (cobrança, dados de cliente, qualquer coisa
   fora deste repositório): alinhar com o dono antes.

## Depois de cada mudança

- `npm test` 100% verde (servidor real + fixtures); `npm run sw-bump` sempre
  que mexer no que o navegador baixa; revisão real no Chromium para tela.
- Commit em português explicando o porquê; nada de código morto.
- Registrar no `CLAUDE.md` (o que era, causa, o que mudou, invariantes,
  checks) e em `docs/DECISIONS.md` quando for decisão de produto.
- Relatório ao dono: o que mudou, arquivos, motivo, testes, resultado,
  riscos e o próximo problema encontrado.

## Como transformar um problema em comando

Contexto (o que está acontecendo) · Problema (o que está errado) · Objetivo
(o que deve acontecer) · Implementação (o que mudar) · Restrições (o que não
pode quebrar) · Testes (como verificar) · Critério de conclusão (como saber
que está pronto).
