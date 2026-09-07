# 🛟 RESTAURAÇÃO DE BACKUP — roteiro ensaiado (21/07/2026)

> **Para Andrio e Diego.** Este roteiro foi TESTADO de verdade: servidor A com
> conta + currículo + pedido → backup → restauração num disco zerado →
> conta, PDF (byte a byte) e pedido de volta. Não é teoria.

## O que os backups cobrem

- **Diário automático** (3h da manhã + 2min após todo boot): todos os `.json`
  de `/data` **+ a pasta `cvs/`** (PDFs dos usuários) → `/data/backups/`,
  guardando os **3 mais recentes** (poda automática).
- **Manual pelo painel** (Admin → rotas v2 backup): mesma cobertura, na hora
  que quiser, com auditoria de quem fez.

## 🚨 Restaurar pelo PAINEL (o caminho normal)

1. Painel Admin → Backup → escolher o backup pela data
2. Confirmar com `RESTAURAR` + seu nome
3. **Reiniciar o servidor** (Render → Manual Deploy → Restart)
4. Conferir: login de um usuário conhecido → currículo aparece? → Pedidos ok?

O restore já faz sozinho: devolve os `.json`, devolve a pasta `cvs/`, tira um
snapshot `pre-restore-*` de segurança do estado atual ANTES de mexer, e
**reseta o SQLite** (ver armadilha abaixo).

## 🚨 Restaurar NA MÃO (disco novo / catástrofe)

1. No shell do Render (ou disco novo montado em `/data`):
   `cp -r /data/backups/<DATA-ESCOLHIDA>/* /data/`
2. **APAGUE o SQLite** (passo que salva a restauração):
   `rm -f /data/h2bapply.db /data/h2bapply.db-wal /data/h2bapply.db-shm`
3. Reinicie o servidor
4. Confira como no roteiro do painel

## ⚠️ AS 3 ARMADILHAS (aprendidas no ensaio)

1. **SQLite ignora JSON restaurado.** Com o storage SQLite ativo, o boot lê
   do `h2bapply.db` e NEM OLHA os `.json` — restaurar sem apagar o `.db`
   não muda NADA (e parece que funcionou). O restore do painel já apaga
   sozinho; na mão, o passo 2 é obrigatório.
2. **Debounce de 5s.** As gravações de usuário vão ao disco com até ~5s de
   atraso — um backup disparado no MESMO segundo de uma ação pode não
   conter ela. O diário roda de madrugada (zero risco); no manual, espere
   ~10s depois de qualquer mexida importante antes de criar o backup.
3. **PDFs moram em `cvs/`** (desde a v21 não estão mais dentro do
   users.json). Backup/restore que ignora essa pasta devolve contas SEM
   currículo. Os dois fluxos já cobrem — mas se um dia copiarem na mão,
   lembrem da pasta.

## 📅 Rotina recomendada

- 1x por mês: criar um backup manual e conferir no listado que a pasta
  `cvs/` está dentro (30 segundos).
- Depois de qualquer incidente de disco (ENOSPC): conferir se o backup
  daquela madrugada existe antes de confiar nele.
