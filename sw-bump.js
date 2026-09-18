#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🔖 sw-bump.js — sobe o CACHE_NAME do sw.js E regrava a IMPRESSÃO DIGITAL
   dos arquivos servidos ao cliente, numa operação só.

   POR QUE ISTO EXISTE (v199 LOTE 19): a regra 4 da casa manda subir o
   CACHE_NAME sempre que index.html/admin.html/app.js mudarem — senão o
   aparelho da pessoa mistura JS velho em cache com HTML novo e a tela fica em
   branco. Até aqui isso era disciplina humana, e as 2 guardas do smoke que
   diziam vigiar a regra só conferiam "a versão é >= v43" — condição
   permanentemente verdadeira, que nunca pegaria a PRÓXIMA edição sem bump.
   Agora o sw.js carrega o hash do que foi publicado junto com ele; o smoke
   recalcula e compara. Mudou um byte do front sem passar por aqui, o teste
   quebra e diz o que fazer.

   USO:
     npm run sw-bump -- "v201 lote 19 — o que mudou pro usuário"
     npm run sw-bump                (sem nota: escreve uma genérica e avisa)

   A nota entra no MESMO formato de sempre (histórico acumulado na linha do
   CACHE_NAME, do mais novo pro mais antigo) e é escrita EM PORTUGUÊS, pensando
   em quem vai ler depois — não em quem escreveu.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Arquivos que o navegador baixa e executa. Mudou qualquer um deles, o cache
// precisa de nome novo. (Mesma lista do check do smoke — uma verdade só.)
const ARQUIVOS_FRONT = ["index.html", "admin.html", "app.js", "h2b-extras-user.js"];
const SW = path.join(__dirname, "sw.js");

function fingerprintFront(raiz = __dirname) {
  const h = crypto.createHash("sha256");
  for (const f of ARQUIVOS_FRONT) {
    // O nome entra no hash junto com o conteúdo: trocar dois arquivos de lugar
    // tem que mudar a impressão digital.
    h.update(f + "\0");
    h.update(fs.readFileSync(path.join(raiz, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function bump(nota) {
  let sw = fs.readFileSync(SW, "utf8");
  const m = sw.match(/const CACHE_NAME = "h2bapply-2026-v(\d+)";/);
  if (!m) { console.error("❌ sw-bump: não achei a linha do CACHE_NAME no sw.js."); process.exit(1); }
  const atual = parseInt(m[1], 10);
  const novo = atual + 1;
  const texto = String(nota || "").trim() ||
    "atualização dos arquivos servidos ao cliente (sem nota — descreva a mudança da próxima vez)";
  sw = sw.replace(
    `const CACHE_NAME = "h2bapply-2026-v${atual}"; //`,
    `const CACHE_NAME = "h2bapply-2026-v${novo}"; // v${novo}: ${texto} v${atual}:`
  );

  const fp = fingerprintFront();
  if (/const CACHE_FRONT_FINGERPRINT = "[0-9a-f]*";/.test(sw)) {
    sw = sw.replace(/const CACHE_FRONT_FINGERPRINT = "[0-9a-f]*";/, `const CACHE_FRONT_FINGERPRINT = "${fp}";`);
  } else {
    // 1ª vez: nasce logo abaixo do CACHE_NAME, onde quem edita vai ver.
    sw = sw.replace(
      /(const CACHE_NAME = "h2bapply-2026-v\d+";.*\n)/,
      `$1// Impressão digital dos arquivos servidos ao cliente (${ARQUIVOS_FRONT.join(" + ")})\n` +
      `// no momento deste bump. O smoke recalcula e compara: se diferir, a suíte\n` +
      `// falha pedindo \`npm run sw-bump\`. NUNCA edite este valor à mão.\n` +
      `const CACHE_FRONT_FINGERPRINT = "${fp}";\n`
    );
  }
  fs.writeFileSync(SW, sw);
  console.log(`✅ sw.js: v${atual} → v${novo} · impressão digital do front: ${fp}`);
  if (!String(nota || "").trim()) console.log("⚠️  Sem nota: escreva `npm run sw-bump -- \"o que mudou\"` da próxima vez.");
}

module.exports = { fingerprintFront, ARQUIVOS_FRONT };

if (require.main === module) bump(process.argv.slice(2).join(" "));
