# H2BApply — Regras de UX e de texto

> Complementa `H2BAPPLY_PRODUCT_RULES.md`. Vale para toda tela, botão, campo,
> mensagem, e-mail e página pública. Regra de ouro: se minha mãe, ou alguém
> que nunca usou computador, entrar aqui, ela sabe o que fazer? Se algo der
> errado, sabe resolver? Depois de uma etapa, sabe a próxima? Entende o que
> o H2BApply faz e o que NÃO faz?

## 1. Padrão único de mensagem de erro

Toda mensagem visível segue esta estrutura, nesta ordem:

1. **O que aconteceu** (uma frase, em português simples, sem código).
2. **Por que costuma acontecer** (uma frase; só quando ajuda).
3. **O que fazer** (passos numerados, curtos, na ordem em que a pessoa faz).
4. **Botão de ação** quando existe uma ação direta (Reconectar Gmail,
   Tentar de novo, Ir para Planos, Ver detalhes).
5. **Onde pedir ajuda** quando o problema pode persistir (WhatsApp do
   suporte, sempre o mesmo número do rodapé).

Exemplo: "Não conseguimos conectar seu Gmail. Isso normalmente acontece
quando a autorização do Google expirou ou foi interrompida. O que fazer:
1. Toque em Desconectar Gmail. 2. Toque em Conectar Gmail. 3. Escolha a sua
conta. 4. Autorize o H2BApply. [Conectar Gmail novamente]".

Proibido como única explicação: códigos (401, 500), inglês técnico
(OAuth, token, refresh, rate limit, queue, sender, job, cooldown, warmup),
"Erro", "Falha", "Tente novamente" sozinhos.

## 2. Jargão sempre explicado

O termo técnico pode existir, mas ao lado vem a explicação simples. Exemplos
obrigatórios:

- **ETA Case Number**: número oficial da solicitação de trabalho H-2B
  registrada no Departamento do Trabalho dos EUA. Serve para conferir a vaga
  na fonte oficial.
- **Conexão com o Google**: precisamos conectar seu Gmail para o H2BApply
  enviar seu currículo por você. O site não recebe sua senha.
- **Certified / Pending**: situação da vaga no governo (aprovada / em
  análise). Ver glossário em `H2BAPPLY_H2B_KNOWLEDGE.md`.

## 3. Botões com significado

Nunca "Clique aqui" ou "OK". Sempre o que vai acontecer: "Criar minha conta",
"Entrar", "Ver vagas", "Cadastrar currículo", "Conectar Gmail", "Enviar meu
currículo", "Ver minhas candidaturas". Ação importante pede confirmação com
o resumo do que vai acontecer (para quem, qual vaga, com qual currículo).

## 4. Campos que se explicam

Todo campo tem rótulo claro, exemplo e formato. Validação explica com
exemplo: "Digite um e-mail válido. Exemplo: nome@gmail.com". Cadastro longo
é quebrado em etapas com "Etapa X de N". Formulário longo salva sozinho e,
ao voltar, oferece continuar de onde parou.

## 5. Estados

- **Carregando**: diz o que está acontecendo ("Procurando vagas…",
  "Conectando ao Google…", "Enviando sua candidatura…"). Nunca tela
  congelada sem explicação; nunca spinner eterno sem saída.
- **Vazio**: explica e oferece a ação ("Você ainda não cadastrou seu
  currículo. [Começar meu currículo]").
- **Sucesso**: só quando o servidor confirmou; diz o que aconteceu e o
  próximo passo.
- **Próximo passo**: depois de criar conta → cadastrar currículo; depois do
  currículo → encontrar uma vaga; depois de conectar o Gmail → escolher uma
  vaga; depois do envio → acompanhar as candidaturas.

## 6. Página da vaga

Ordem: cargo, empregador, local, salário, início, fim, horas, nº de
trabalhadores, experiência, funções, requisitos, moradia, transporte, como
se candidatar, e-mail, telefone, ETA Case Number, fonte, publicada em. Sem
"status" (ativa/inativa/expirada): decisão do dono, ver
`H2BAPPLY_PRODUCT_RULES.md` regra 7b. Em destaque o que a pessoa procura primeiro: quanto paga, onde, quando
começa e termina, quantas horas, precisa de experiência, tem moradia, como
aplicar, qual é o ETA Case Number. Dado ausente: "Informação não fornecida
pelo empregador". Fonte sempre visível: "Dados do U.S. Department of Labor
(SeasonalJobs). O H2BApply é independente e não afiliado ao governo dos EUA."

## 7. Busca e filtros

Zero resultado nunca é "0 results": explica e sugere (outro cargo, remover
um filtro, outro estado, palavra mais simples) e, quando possível, "Você quis
dizer: Maintenance?". Cada filtro explica seu objetivo em uma linha. Nenhum
filtro existe só porque parece profissional.

## 8. Envio e histórico

Antes de enviar: "Você está se candidatando para: [cargo] · [empresa] ·
[local]", com currículo, seu e-mail, destinatário e assunto para revisar.
Duplicidade: "Você já enviou uma candidatura para esta vaga. Enviado em
[data]. [Ver envio]". Histórico com status humanos: Enviado · Aguardando ·
Falhou · Precisa tentar de novo. Falha: "Não conseguimos enviar seu
currículo. Ele NÃO foi enviado para esta empresa. [Reconectar Gmail]
[Tentar novamente] [Ver detalhes]".

## 9. Mobile primeiro

O celular é o fluxo principal. Nada sai da tela, nada fica pequeno,
sobreposto ou cortado; nada exige zoom. Alvos de toque ≥ 44px; texto de
instrução e de erro ≥ 14px; usável com uma mão. Cada tamanho de tela tem a
experiência própria (menus, cards, formulários, tabelas, filtros, modais).

## 10. Acessibilidade e leitura

Contraste suficiente, foco visível, navegação por teclado no fluxo
principal, rótulo em todo campo, texto alternativo em imagens, títulos em
ordem. Se a pessoa precisa aproximar a tela para entender, está errado.

## 11. Landing page

Ensina o produto inteiro rolando a página, sem exigir conta: o que é → como
funciona (7 passos com imagem real) → como criar conta → como cadastrar
currículo → como encontrar e verificar uma vaga → como conectar o Gmail →
como enviar → o que acontece depois → planos → perguntas frequentes → criar
conta. Moderna, limpa, humana, sem cara de governo nem de golpe, sem blocos
gigantes de texto. Deixa claro o que o H2BApply é e o que não é, e traz em
destaque a mensagem de confiança da regra 7c ("100% das vagas vêm do site
oficial do governo… viu uma vaga em outro lugar e quer saber se é golpe?
pesquise aqui").
