# Instruções de tradução (H2BApply: vagas de visto H-2B/H-2A para brasileiros)

Traduza do português para **inglês americano natural** (en) e **espanhol neutro latino-americano, tratando o leitor por "tú"** (es).

Entrada: `/home/user/2026/i18n/todo/chunk-NNN.json` — objeto `{"texto em português": "arquivos de origem"}`. As CHAVES são os textos a traduzir; o valor é só contexto.
Saída (2 arquivos, objeto `{"<chave EXATA>": "<tradução>"}`): `/home/user/2026/i18n/en/chunk-NNN.json` e `/home/user/2026/i18n/es/chunk-NNN.json`.

Regras:
1. Todas as chaves nas duas saídas, sem alterar uma letra da chave; nenhuma tradução vazia. Texto já em inglês (ex.: nome oficial de seção do governo dos EUA) = copie igual no EN e traduza no ES quando fizer sentido.
2. Marcadores: `{#}` = um número; `{*}` = trecho inserido pelo programa (nome, quantidade, data, estado). Mantenha EXATAMENTE a mesma quantidade de `{#}` e de `{*}` na tradução, no lugar gramaticalmente certo. Nada dentro do marcador.
3. Não traduza: H2BApply, H-2B, H-2A, Gmail, Google, DOL, USCIS, PIX, WhatsApp, Instagram, nomes de empresas, e-mails, URLs, códigos de formulário (I-129, DS-160…). Preserve emojis, pontuação e símbolos. "R$" fica "R$".
5. Muitos textos são FRAGMENTOS (pedaço de frase entre tags HTML): traduza para soar natural colado no mesmo lugar.
6. Tom claro, amigável e direto. Conteúdo de vistos, leis e dinheiro deve ser preciso (não invente nem suavize fatos). "diamantes"/💎 = "diamonds"/"diamantes". "Envio automático" = "Automatic sending"/"Envío automático". Lista/planilha de vagas = "job list"/"lista de empleos".
7. Não edite nenhum outro arquivo. Gere os JSON com Write ou script (JSON válido, aspas escapadas).
8. Valide: `cd /home/user/2026 && node tools/i18n-validate.js NNN` até imprimir OK.
