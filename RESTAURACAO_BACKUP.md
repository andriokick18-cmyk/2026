# 🛟 RESTAURAÇÃO DE BACKUP — roteiro ensaiado (21/07/2026, refeito em v191)

> **Para Andrio e Diego.** Este roteiro foi TESTADO de verdade: servidor A com
> conta + currículo + pedido → backup → restauração num disco zerado →
> conta, PDF (byte a byte) e pedido de volta. Não é teoria.
>
> **v191 (18/09/2026):** agora o ensaio roda dentro do `npm test`, com o
> servidor VIVO e do jeito que acontece na vida real — backup → mudanças →
> restore pela rota → **SIGTERM** → reinício → os dados do backup continuam
> lá. Era exatamente nesse pedaço que a restauração se desfazia sozinha (ver
> "armadilha 4" abaixo).

## O que os backups cobrem

- **Diário automático** (3h da manhã + no boot, **só se o backup mais recente
  já tiver ≥12h**): todos os `.json` de `/data` **+ a pasta `cvs/`** (PDFs dos
  usuários) **+ a pasta `comprovantes/`** (comprovantes de pagamento dos
  pedidos, que desde a v192 moram em disco e não mais dentro do
  `pedidos.json`) → `/data/backups/`, guardando os **3 mais recentes** (poda
  automática). O limite de 12h existe porque este repo faz deploy a cada
  commit: sem ele, 3 commits numa tarde criavam 3 backups do MESMO dia e
  empurravam pra fora os backups de ontem — justo o que se procura quando
  algo dá errado.
- **Manual pelo painel** (Admin → rotas v2 backup): mesma cobertura, na hora
  que quiser, com auditoria de quem fez.

## 🚨 Restaurar pela API (rotas prontas, sem botão dedicado no painel ainda)

As rotas `/api/admin/v2/backup/*` (mod-admin-v2.js) existem e funcionam,
mas nesta reconstrução `admin.html` ainda não tem uma tela própria pra
elas — chame direto (com a sessão de admin logada no navegador, ex. via
DevTools → Console, ou curl com o cookie de sessão):

1. `GET /api/admin/v2/backup/list` → lista os backups disponíveis (data)
2. `POST /api/admin/v2/backup/restore` com `{name:"<DATA-ESCOLHIDA>"}`
3. **Reiniciar o servidor** (Render → Manual Deploy → Restart)
4. Conferir: login de um usuário conhecido → currículo aparece? → Pedidos ok?

O restore já faz sozinho: devolve os `.json`, devolve a pasta `cvs/`, tira um
snapshot `pre-restore-*` de segurança do estado atual ANTES de mexer,
**reseta o SQLite** (ver armadilha abaixo) e **CONGELA todas as gravações**
até o reinício (resposta com `congelado:true`).

> ❄️ **O que "congelado" significa na prática.** Depois do restore o site
> continua no ar servindo o estado ANTIGO que está na memória, mas nada mais
> é gravado em disco — nem no desligamento. É de propósito: é o que impede o
> servidor de escrever a memória velha por cima do backup que acabou de
> voltar. **Reinicie o quanto antes** (Render → Restart): só o reinício
> carrega de verdade o backup restaurado. Se você desistir da restauração,
> basta reiniciar também — o estado congelado é descartado e o snapshot
> `pre-restore-*` guarda o que estava no disco antes.

## 🚨 Restaurar NA MÃO (disco novo / catástrofe)

1. No shell do Render (ou disco novo montado em `/data`):
   `cp -r /data/backups/<DATA-ESCOLHIDA>/* /data/`
   (isso já traz as pastas `cvs/` e `comprovantes/` junto)
2. **APAGUE o SQLite** (passo que salva a restauração):
   `rm -f /data/h2bapply.db /data/h2bapply.db-wal /data/h2bapply.db-shm`
3. Reinicie o servidor
4. Confira como no roteiro do painel

## ⚠️ AS 4 ARMADILHAS (aprendidas no ensaio)

1. **SQLite ignora JSON restaurado.** Com o storage SQLite ativo, o boot lê
   do `h2bapply.db` e NEM OLHA os `.json` — restaurar sem apagar o `.db`
   não muda NADA (e parece que funcionou). O restore do painel já apaga
   sozinho; na mão, o passo 2 é obrigatório.
2. **Debounce de 5s.** As gravações de usuário vão ao disco com até ~5s de
   atraso — um backup disparado no MESMO segundo de uma ação pode não
   conter ela. O diário roda de madrugada (zero risco); no manual, espere
   ~10s depois de qualquer mexida importante antes de criar o backup.
3. **PDFs moram em `cvs/` e comprovantes em `comprovantes/`** (os PDFs desde
   a v21, os comprovantes desde a v192 — nenhum dos dois vive mais dentro de
   um .json). Backup/restore que ignora essas pastas devolve conta SEM
   currículo e pedido SEM prova de pagamento. Os dois fluxos já cobrem — mas
   se um dia copiarem na mão, lembrem das duas pastas.
4. **O servidor vivo desfazia o restore (corrigido na v191).** Restaurar
   copiava os arquivos de volta, mas o processo seguia com TUDO em memória no
   estado de antes: em segundos um salvamento atrasado regravava `users.json`,
   e o SIGTERM do "reinicie o servidor" gravava a memória inteira por cima de
   tudo. Resultado: pedidos e financeiro voltavam, usuários/histórico/robôs
   não — restauração pela METADE, em silêncio. Hoje o restore congela as
   gravações e o desligamento respeita o congelamento (o `npm test` prova o
   caminho inteiro). **Se um dia alguém mexer no `flushAll`/`persist`,
   mantenha essa trava: sem ela o roteiro acima volta a mentir.**

## 📅 Rotina recomendada

- 1x por mês: criar um backup manual e conferir no listado que a pasta
  `cvs/` está dentro (30 segundos).
- Depois de qualquer incidente de disco (ENOSPC): conferir se o backup
  daquela madrugada existe antes de confiar nele.
