# H2BApply — Regras permanentes do produto

> Fonte: Master Command do dono (19/09/2026, partes 1 e 2). Este arquivo é a
> memória permanente do produto: um novo desenvolvedor, uma nova sessão de IA
> ou um novo agente deve ler isto e o `CLAUDE.md` antes de tocar em qualquer
> coisa. Nada aqui muda sem ordem escrita do dono.

## Norte do produto (H2BApply North Star)

- **Objetivo**: ajudar trabalhadores, em especial brasileiros, a encontrar
  oportunidades de trabalho H-2B (e H-2A) nos Estados Unidos, entender essas
  oportunidades, preparar o currículo e facilitar o envio de candidaturas
  aos empregadores.
- **Usuário**: pessoas que podem ter pouco conhecimento de tecnologia, de
  processos de candidatura, do programa H-2B, dos sistemas americanos e de
  inglês. Muitas usam só o celular.
- **Problema**: informações espalhadas, vagas difíceis de pesquisar,
  processos confusos, dificuldade real de enviar uma candidatura.
- **Solução**: centralizar e simplificar a descoberta de vagas, as
  informações da vaga, o currículo, a candidatura, o envio e o acompanhamento.
- **Negócio**: o site é o produto inteiro e a fonte de receita. Cada envio só
  existe para quem assina um plano. Tudo que trava um envio, uma assinatura
  ou a confiança do cliente mexe direto no caixa.

## Regras que nunca mudam

1. **O usuário nunca pode ficar perdido.** Toda função explica o que é, para
   que serve, por que existe, o que fazer, o que acontece depois, o que pode
   dar errado, como corrigir e para onde ir em seguida.
2. **Todo erro visível ensina.** Responde: o que aconteceu? por quê? o que eu
   faço agora? existe um botão para corrigir? Nunca "Authentication error",
   "Error 500", "Unauthorized" como única explicação.
3. **O H2BApply não é o governo americano** e **não é afiliado ao
   SeasonalJobs.dol.gov**. Ele usa informações públicas de vagas do
   Departamento do Trabalho dos EUA para facilitar a pesquisa e a candidatura.
4. **O H2BApply não garante** emprego, entrevista, visto, extensão nem
   aprovação migratória. Nunca se apresenta como advogado, escritório de
   imigração, representante do USCIS, do DOL ou do SeasonalJobs, empregador
   ou patrocinador de visto. Encontrar uma vaga não é ser contratado; enviar
   um currículo não obriga o empregador a responder.
5. **Candidatura não é imigração.** Ser contratado não é ter aprovação
   migratória. Processos de visto têm etapas próprias; o site não substitui
   orientação jurídica.
6. **Não inventar.** Nem dado de vaga, nem regra de H-2B, nem número. Dado
   que a fonte não informou aparece como "Informação não fornecida pelo
   empregador". Regra de imigração só com fonte oficial (USCIS > DOL >
   FLAG/OFLC > SeasonalJobs > Departamento de Estado); ver
   `H2BAPPLY_H2B_KNOWLEDGE.md`.
7. **ETA Case Number é sagrado.** Nunca gerar, alterar, trocar ou esconder o
   número recebido da fonte. Ele fica visível em área própria com o caminho
   para verificar a vaga na fonte oficial. 1 vaga = 1 case number
   (`mod-vagas-integrity.js`).
7b. **Cada vaga é enriquecida UMA ÚNICA VEZ** (decisão do dono, 19/09/2026,
    que substitui a parte da seção 8 do Master Command sobre reconferir
    vaga): o robô consulta a API oficial do DOL pelo ETA Case Number, copia
    as informações reais sem alterar nada, e a vaga fica pronta para
    sempre. O enriquecimento só roda em vaga ainda incompleta (sem e-mail,
    cidade, datas ou descrição); vaga completa nunca é reconsultada, nunca é
    marcada como inativa ou expirada e nunca entra numa nova busca. Não
    existe robô de "frescor". **Nenhum conceito de "status da vaga"
    (ativa/inativa/expirada) aparece para o usuário.** A entrada de vagas
    novas continua pelo arquivo diário do DOL (uma baixada por ciclo, nunca
    vaga a vaga).
7c. **Mensagem de confiança (dono, 19/09/2026), em destaque na landing e na
    FAQ:** "100% das vagas do H2BApply vêm direto do site oficial do governo
    americano (SeasonalJobs.dol.gov). Nenhuma vaga de fora entra aqui. Viu
    uma vaga em outro site, aplicativo ou rede social e quer saber se é
    golpe? Abra o H2BApply, vá em Envio Manual e pesquise as informações
    dessa vaga: se ela existe na fonte oficial, ela está aqui. Não garantimos
    que você será contratado, mas ajudamos você a encontrar vagas de verdade
    e a se candidatar com segurança."
8. **Vaga é dado, não texto.** Estrutura fixa por vaga (cargo, empregador,
   local, estado, salário, início, fim, nº de trabalhadores, horas,
   requisitos, funções, e-mail/telefone/método de candidatura, ETA Case
   Number, fonte, publicada em, importada em). Sem campo de "status" para o
   usuário (regra 7b).
9. **Nunca sucesso falso.** "Enviado" só quando o Gmail confirmou; "VIP
   ativado" só quando a ativação aconteceu de verdade; "Salvo" só depois de
   gravar. A interface reflete o estado real.
10. **O site nunca escreve pelo usuário.** Assunto, corpo e carta são do
    usuário; sem texto, o envio é pulado com aviso claro.
11. **Duplicidade é impossível.** Uma vaga enviada, ou já na fila do
    automático, não é enviada de novo (chave: e-mail do empregador). Única
    exceção: o usuário resetar os enviados de propósito.
12. **Só envio pelo Gmail.** O site pede ao Google somente permissão de
    ENVIAR (`gmail.send`); nunca lê caixa de entrada de ninguém. O usuário
    nunca informa a senha do Gmail ao site.
13. **Só quem paga envia.** Conta grátis tem 0 envios manuais e 0
    automáticos; serve para conhecer o site. Toda mudança de limite, preço ou
    regra de plano é mudança de código com texto espelhado no mesmo commit.
14. **Toda decisão passa pelo objetivo.** Antes de implementar, perguntar:
    isso ajuda a encontrar ou entender uma vaga? preparar ou enviar a
    candidatura? acompanhar? torna mais fácil, reduz erro, aumenta confiança?
    Se a resposta for não para tudo, a função não deveria existir.
15. **Prioridade fixa**: 1 segurança · 2 integridade dos dados · 3
    funcionamento · 4 fluxo principal do usuário · 5 clareza · 6
    acessibilidade · 7 performance · 8 conversão · 9 design · 10 extras.
16. **Dado de cliente nunca vai para o git.** O repositório é público. Nome,
    e-mail, telefone, comprovante, currículo ou lista de clientes vivem só no
    `DATA_DIR` do servidor.
17. **Proativo, nunca perigoso.** Corrigir o que está errado, simplificar o
    confuso, implementar o que falta. Mas nada irreversível (apagar dados,
    excluir usuários, cancelar pagamentos, mudar credenciais ou domínio,
    alterar produção de forma destrutiva) sem alinhar com o dono antes.
18. **Português por padrão.** O app abre sempre em português; termos
    jurídicos não são traduzidos de forma incorreta; jargão só com
    explicação simples ao lado.
19. **Nomenclatura única**: sempre "Currículo", "candidatura", "vaga",
    "Gmail", "conta", "perfil", "envio". Nunca alternar nomes para a mesma
    coisa.
20. **Corrigir na camada certa.** Backend, banco, API, UX ou segurança: o
    problema é resolvido onde nasce; texto bonito nunca cobre função quebrada.

## Fluxo principal que o produto deve tornar óbvio

Landing → entender → criar conta → cadastrar currículo → finalizar perfil →
encontrar vaga → abrir vaga → entender vaga → verificar ETA Case Number →
escolher candidatura → conectar Gmail → revisar → enviar → confirmar →
acompanhar. Depois de cada etapa o site diz o próximo passo.

## Definição de "pronto"

O H2BApply só está pronto quando: o usuário entende o produto; consegue
criar conta, entrar, cadastrar currículo e entender cada campo; consegue
procurar vagas e entender os resultados; entende o ETA Case Number e
consegue verificar a origem da vaga; consegue conectar o Gmail e enviar; o
sistema confirma o envio corretamente e não mente sobre falhas; o usuário
entende os erros, sabe corrigi-los e sabe o próximo passo; consegue
acompanhar candidaturas; tudo funciona no celular e no desktop; a landing
explica o produto com tutorial integrado e imagens reais; os dados das vagas
são tratados sem invenção; as informações de H-2B são corretas e deixam
claro que o site não é o governo, não é afiliado ao SeasonalJobs e não
promete emprego nem aprovação migratória; a segurança foi auditada; e o
usuário consegue ir do primeiro acesso até uma candidatura sem pedir ajuda.
