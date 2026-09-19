# H2BApply — Conhecimento sobre H-2B (base oficial)

> Regra: nada aqui entra sem fonte oficial (USCIS > U.S. Department of Labor
> > FLAG/OFLC > SeasonalJobs.dol.gov > Departamento de Estado). O que ainda
> não foi confirmado fica marcado como **a confirmar** e não pode virar
> texto do site. Este arquivo está em construção pela auditoria de 19/09/2026
> (frente "h2b-conteudo-oficial"); o glossário para o usuário e a lista de
> afirmações do site auditadas serão anexados aqui.

## Confirmado em fonte oficial

- O programa H-2B permite que empregadores ou agentes dos EUA, que cumpram
  os requisitos regulatórios, tragam estrangeiros para preencher trabalhos
  **temporários não agrícolas**. Fonte: USCIS —
  https://www.uscis.gov/working-in-the-united-states/temporary-workers/h-2b-temporary-non-agricultural-workers
- Quem pede é o **empregador** (peticionário), que precisa demonstrar: não há
  trabalhadores americanos suficientes, capazes, dispostos, qualificados e
  disponíveis; contratar H-2B não prejudica salários e condições dos
  trabalhadores americanos; e a necessidade é **temporária** (mesmo que o
  cargo em si não seja). Fonte: USCIS (link acima).
- Antes de pedir a classificação H-2B ao USCIS, o empregador obtém a
  **certificação de trabalho temporário** no Departamento do Trabalho
  (formulário **ETA-9142B**) e só então protocola o **Form I-129** no USCIS.
  Fonte: USCIS (link acima) e DOL —
  https://www.dol.gov/agencies/eta/foreign-labor/programs/h-2b
- A necessidade temporária pode ser: **ocorrência única**, **sazonal**,
  **pico de demanda** ou **intermitente**; salvo ocorrência única, o
  emprego certificado não pode passar de **9 meses**. Fonte: USCIS (link
  acima).
- O empregador não pode cobrar do trabalhador taxas pelo recrutamento nem
  pela petição (proteções do programa). Fonte: DOL/WHD —
  https://www.dol.gov/agencies/whd/immigration/h2b (**a confirmar o trecho
  literal**).

## A confirmar (não usar em texto do site até ter fonte)

- Teto anual de vistos H-2B e vistos suplementares do ano fiscal 2026
  (Federal Register 2026-02131 — ver
  https://www.federalregister.gov/documents/2026/02/03/2026-02131/).
- Tempo máximo de permanência em H-2B (até 3 anos no total) e regras de
  extensão; troca de empregador/portabilidade.
- O que "Certified" e "Pending Processing" significam exatamente no
  SeasonalJobs e como localizar uma vaga pelo ETA Case Number na fonte.
- Etapas do visto no consulado (DS-160, entrevista) e o que o trabalhador
  paga ou não paga.

## O que o site pode e não pode dizer (resumo)

- Pode: "vaga certificada pelo Departamento do Trabalho dos EUA", "use o
  ETA Case Number para conferir a vaga na fonte oficial", "o empregador é
  quem contrata e faz o pedido de visto".
- Não pode: prometer emprego, entrevista, visto, extensão ou aprovação;
  apresentar-se como governo, USCIS, DOL, SeasonalJobs, empregador,
  patrocinador ou advogado; simplificar regra migratória de um jeito que
  induza a erro.

## Regra de produto ligada ao dado do DOL

- Cada vaga é enriquecida uma única vez pelo ETA Case Number (API oficial),
  com os dados copiados sem alteração. Depois disso não há reconferência de
  status, data ou salário, e o site não mostra "ativa/inativa/expirada" para
  o usuário (decisão do dono, 19/09/2026 — ver `H2BAPPLY_PRODUCT_RULES.md`
  7b). O ETA Case Number continua sendo o caminho para o usuário conferir a
  vaga na fonte oficial por conta própria.
- O arquivo diário do DOL (`datahub-search/sjCaseData/zip/<tipo>/<AAAA-MM-DD>`)
  é gerado à meia-noite do horário do Leste dos EUA e nem todo dia tem
  arquivo; a data de hoje pode responder 404 sem ser falha (caso real de
  19/09/2026). O robô usa o arquivo mais recente disponível e nunca inventa
  dado. Fonte: SeasonalJobs Data Feeds — https://seasonaljobs.dol.gov/feeds
  (página bloqueada para leitura direta daqui; regra da meia-noite obtida
  pelo resumo da busca oficial — **a confirmar na página**).

