# H2BApply — Como testar

> Regra da casa: `npm test` 100% verde antes de todo commit. A suíte sobe um
> servidor real com fixtures e prova comportamento, não só sintaxe.

## O que roda em `npm test`

1. `npm run check`: `node --check` em server.js, storage.js e mod-*.js;
   `check-duplicates.js` (funções duplicadas em server, mods e app.js);
   `check-xss-guard.js` (cada `${...}` em innerHTML/insertAdjacentHTML passa
   por `esc()` ou está na allowlist por assinatura, com motivo).
2. `node smoke-test.js`: servidor real em porta aleatória (3900-3990) com
   `DATA_DIR` temporário, `STORAGE=json`, `TEST_LOGIN_TOKEN`, feed falso do
   DOL (`DOL_FEED_BASE`/`DOL_API_BASE`) e Gmail/OAuth falsos
   (`GOOGLE_FAKE_BASE`). Cerca de 710 checks: rotas, gates de plano,
   envio manual e automático ponta a ponta, planilhas e enriquecimento,
   filtros, pedidos e pagamentos, admin, backup/restore (drill real com
   reinício), 2º boot no mesmo disco, SQLite, i18n, guardas estruturais.

## Regras dos testes

- Nunca afrouxar um check para passar. Se um check antigo codificava
  comportamento errado, atualizar com o porquê no comentário.
- Todo bug real corrigido ganha um check que reproduz o cenário exato.
- Guardas estruturais existem para bugs que já aconteceram (sw.js sem bump,
  função fantasma em onclick, chave i18n sem tradução, dado hardcoded de
  cliente, exp de vaga lido como vencimento). Não desativar.
- `TEST_LOGIN_TOKEN`, `DOL_API_BASE`, `GOOGLE_FAKE_BASE` são só de teste;
  nunca em produção.

## Front-end

- Mudou `index.html`, `admin.html`, `app.js` ou `h2b-extras-user.js`:
  `npm run sw-bump -- "o que mudou"` ANTES do `npm test` (sobe o
  `CACHE_NAME` e regrava a impressão digital; a suíte falha sem isso).
- Revisão real no Chromium (Playwright em `/opt/node22/lib/node_modules/
  playwright`, `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`): 1280×850 e
  390×844, capturando `pageerror`, `console.error` e respostas 4xx/5xx que
  o front faz sozinho. Script fica fora do repositório.
- Toda string nova visível passa pelo `LANG_DICT` (pt/en/es) via
  `data-i18n`/`t()`; a guarda i18n-1 exige as 3 línguas.

## Checklist de personas (Master Command)

Para cada tela alterada, responder como: quem nunca usou o site; quem tem
pouco computador; quem não entende inglês; quem nunca ouviu falar de H-2B;
quem acabou de ver um erro; o admin; o dev de segurança; o especialista de
UX. Se qualquer resposta for "não sei o que fazer", a tela não está pronta.

## Cenários que sempre devem ser provocados

Senha errada · e-mail inválido/duplicado · campo vazio · dado inválido · F5
no meio · voltar no navegador · duas abas · sessão expirada · Gmail
desconectado · autorização vencida/negada · sem currículo · currículo
incompleto · PDF inválido/grande · sem plano · plano vencido · limite do dia
· sem vagas · busca errada · filtro sem resultado · vaga sem e-mail · envio
com erro · clique duplo · internet caiu · servidor indisponível.

## Testes no site ao vivo

Ficam com o dono (sessão real no navegador). Nunca enviar candidatura real
para empregador de verdade, nunca alterar dias VIP de usuário real, nunca
aprovar pagamento real só para testar, nunca apagar dado real. Achados do
dono entram em `docs/H2BAPPLY_LIVE_SYSTEM_AUDIT.md` e viram comandos.
