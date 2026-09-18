/* ═══════════════════════════════════════════════════════════════════════
   🔍 mod-filtros.js — MOTOR ÚNICO DE FILTROS DE VAGAS (v173, 13/09/2026)
   Ordem do dono (13/09/2026, reafirmada): "apague todo o sistema de filtro
   atual e crie um novo, pesquisando na internet o que importa; um filtro não
   pode eliminar o outro; conforme filtra, mostra a quantidade de vagas".

   O que este módulo garante (padrão de mercado "busca facetada" — Indeed/
   LinkedIn/Baymard):
   • UMA fonte de verdade pra ler (parse) e aplicar (mascara/filtrar) filtros
     — usada pela lista do Envio Manual (/api/sheet-meta), pela contagem ao
     vivo (/api/vagas/filtros), pela montagem da fila do automático e pelo
     REFILL da fila (tryAutoRefill). Antes eram 3 cópias divergentes.
   • Combinação: E (AND) entre dimensões diferentes, OU (OR) entre opções da
     MESMA dimensão. Nenhum filtro "elimina" o outro.
   • Facetas: a contagem de cada opção de uma dimensão é calculada com TODOS
     os OUTROS filtros aplicados (e sem o da própria dimensão) — assim o
     usuário sempre vê "se eu marcar isto, sobram N", e uma opção com 0 pode
     ser desabilitada em vez de levar a uma tela vazia.
   • Disponibilidade: cada dimensão diz quantas vagas da planilha TÊM aquele
     dado. Planilha sem salário publicado (ex.: jul2026 "Pending Processing")
     → o filtro de salário nem é oferecido, com aviso honesto — era o caso
     real do print do dono ("$20+/h não achou nada").
   • Puro: sem I/O, sem estado global além de um cache por array de linhas.

   📌 REGRAS QUE NÃO PODEM SER QUEBRADAS (v179, 17/09/2026 — "os filtros não
   podem falhar… o usuário tem que desfrutar 100%"):
   • VALOR DE FACETA É OPACO: o servidor nunca re-parseia (por vírgula ou o
     que for) um valor que ele mesmo emitiu. Só estado/categoria/mês/grupo,
     cujos valores jamais contêm vírgula, aceitam o CSV legado.
   • CIDADE É UM LUGAR, NÃO UM TEXTO: a chave canônica é
     norm(cidade) + "|" + ESTADO. A faceta agrupa por ela e o filtro casa por
     IGUALDADE dela. Texto livre (digitado / região turística) segue no
     casamento amplo — é lá que ele faz sentido.
   • CONTAGEM POR OPÇÃO = VERDADE DA LISTA: se um chip diz N, marcar esse chip
     tem que devolver exatamente N.
   • Nada de trabalho pesado por linha dentro de laço quente: tudo que se
     repete (normalização, palheiro de busca) é pré-calculado no índice.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// Limiares fixos (o front mostra só os que têm contagem > 0). Salário em
// US$/hora normalizado; vagas = trabalhadores solicitados na certificação.
const SALARIO_LIMIARES = [12, 14, 15, 16, 18, 20, 22, 25, 28, 30];
const VAGAS_LIMIARES = [1, 2, 5, 10, 20, 50];
const MESES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const GRUPOS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const DIMENSOES = ["q", "estado", "cidade", "categoria", "cargo", "salarioMin", "vagasMin", "inicio", "status", "grupo", "email"];
// 💎 Dimensões exclusivas do plano Double Pro (decisão de produto do dono,
// mantida — o gate é do SERVIDOR: pra quem não é DP o parâmetro é ignorado).
const DIMENSOES_DOUBLEPRO = new Set(["grupo", "status"]);

// Salário → US$/hora, normalizado por unidade. MESMA régua usada pra ordenar
// por salário (searchSheet sort=wage) — fonte única: nunca duplicar.
// Dado sujo da fonte, nas DUAS direções (v179 — as duas heurísticas moram
// juntas de propósito, são a mesma ideia):
//  • rotulado "hora" mas > 200 → é mensal sem unidade ($2.058/h não existe);
//  • rotulado mês/semana/dia/ano mas baixo demais pra aquela unidade → é
//    valor HORÁRIO mal rotulado na fonte. Caso real medido na H-2A: 41 linhas
//    com wunit="mo" e valor < 400 ("Field Workers" w=9.59 mo), que dividido
//    por 173 virava $0,06/h — sumia de TODO limiar do filtro, do sort=wage e
//    puxava o "de $X a $Y/h" da tela pra baixo.
// Os pisos são o menor valor plausível pra cada unidade em tempo integral
// (salário mínimo federal $7,25/h: mês ≈ $1.255, semana ≈ $290, dia ≈ $58,
// ano ≈ $15.080) com folga grande pra nunca reclassificar dado legítimo.
function wageHora(r) {
  if (!r || !r.w) return 0;
  const m = String(r.w).match(/[0-9.]+/);
  if (!m) return 0;
  const v = parseFloat(m[0]);
  if (!(v > 0)) return 0;
  const un = String(r.wunit || "h").toLowerCase();
  if (un.startsWith("mo")) return v < 400 ? v : v / 173;
  if (un.startsWith("w")) return v < 100 ? v : v / 40;
  if (un.startsWith("d")) return v < 30 ? v : v / 8;
  if (un.startsWith("y") || un.startsWith("a")) return v < 5000 ? v : v / 2080;
  if (v > 200) return v / 173;
  return v;
}

// 🔑 REGRA v179 — VALOR DE FACETA É OPACO: quem gerou o valor é quem o
// interpreta; o servidor NUNCA re-parseia um valor que ele mesmo emitiu.
// Cargo, cidade e status têm VÍRGULA no próprio nome ("Cooks, Restaurant",
// "Farmworkers and Laborers, Crop, Nursery, and Greenhouse", "Jenison, MI")
// — quebrá-los por vírgula fazia o chip anunciar 217 e a lista devolver 108
// (medido na H-2A: 79 títulos / 804 linhas), e mandava o robô pro empregador
// errado. Só as dimensões cujo valor NUNCA contém vírgula (estado, categoria,
// mês de início, grupo) aceitam o formato legado CSV ("state=FL,TX").
const _arr = (v) => Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
const _lista = (v, fn, csv) => {
  const bruto = csv === false
    ? _arr(v)
    : _arr(v).flatMap(x => Array.isArray(x) ? x : String(x == null ? "" : x).split(","));
  return [...new Set(bruto.map(x => String(x || "").trim()).filter(Boolean).map(fn || (x => x)))];
};
const _num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };

function createFiltros(deps) {
  const {
    normalizeStateName,   // (raw) → "FLORIDA"
    normBusca,            // (texto) → forma normalizada (sem acento/apóstrofo/caixa)
    cityMatchNormFn,      // (texto) → (cidadeJáNormalizada) => bool (região turística)
    regioes,              // { "cape cod": [...cidades] } — só pros rótulos/contagens de região
    grupoDe,              // (row) → "A".."H" | ""
    searchSheet,          // (rows, q, state, category, skip, top, sort) → {total, items}
    categoriaLabel,       // (key) → rótulo PT
    sheetVersion,         // (rows) → nº que MUDA quando o robô mexeu nas linhas
  } = deps;
  const _norm = normBusca || (s => String(s || "").toLowerCase().trim());
  // Chave canônica de CIDADE: cidade normalizada + "|" + ESTADO. Uma cidade
  // é um lugar, não um texto: "LaBelle"/"Labelle"/"LABELLE" da Flórida são a
  // MESMA opção (antes viravam 3 chips de 32/23/11 e clicar qualquer um
  // trazia 66), e "Ames/IOWA" não é "Lamesa/TEXAS" nem "Jamestown/ND"
  // (o casamento por substring sem estado trazia 24 onde só 12 eram Ames).
  const _ciKey = (cidade, estado) => {
    const c = _norm(cidade); if (!c) return "";
    return c + "|" + String(estado || "");
  };
  // Valor canônico vindo do cliente ("labelle|FLORIDA") → mesma chave do
  // índice, tolerante a caixa/grafia do estado.
  const _ciKeyDoCliente = (v) => {
    const s = String(v || ""); const i = s.lastIndexOf("|");
    if (i < 0) return "";
    return _ciKey(s.slice(0, i), normalizeStateName(s.slice(i + 1)) || "");
  };

  // ── parse: aceita URLSearchParams (rota) OU objeto (job.filters do robô).
  // Repetição de parâmetro (cargo=a&cargo=b) e CSV são equivalentes.
  // Formato LEGADO (jobs do automático gravados antes do v173: state/
  // category/keyword/titles/beginMonths/minWage/city/minWorkers/grupos/
  // dolStatus) é aceito pra um robô que já estava rodando não perder o
  // refill depois do deploy.
  function parse(src) {
    // ⚠️ v179: repetição de parâmetro (cargo=a&cargo=b) devolve o ARRAY CRU —
    // juntar com vírgula e re-quebrar destruía todo valor que TEM vírgula.
    // Valor único continua string (é o que preserva o CSV legado "FL,TX").
    const get = (k) => {
      if (!src) return "";
      if (typeof src.getAll === "function") { const all = src.getAll(k); return all.length ? (all.length === 1 ? all[0] : all) : ""; }
      return src[k];
    };
    const first = (...keys) => { for (const k of keys) { const v = get(k); if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) return v; } return ""; };
    const f = {
      q: String(first("q", "keyword") || "").trim().slice(0, 120),
      estado: _lista(first("estado", "state"), s => normalizeStateName(s)).filter(Boolean),
      cidade: _lista(first("cidade", "city"), s => s.slice(0, 80), false),
      categoria: _lista(first("categoria", "category"), s => s.toLowerCase()).filter(c => c !== "all"),
      cargo: _lista(first("cargo", "titles"), s => s.toLowerCase().replace(/\s+/g, " "), false).filter(c => c !== "__outros__"),
      salarioMin: _num(first("salarioMin", "minWage")),
      vagasMin: Math.floor(_num(first("vagasMin", "minWorkers"))),
      inicio: _lista(first("inicio", "beginMonth", "beginMonths"), s => String(parseInt(s, 10))).map(Number).filter(m => m >= 1 && m <= 12),
      status: _lista(first("status", "dolStatus"), s => s.slice(0, 60), false),
      grupo: _lista(first("grupo", "grupos"), s => s.toUpperCase()).filter(g => GRUPOS.includes(g)),
      email: ["1", "true", "yes", "sim"].includes(String(first("email", "hasEmail") || "").toLowerCase()),
    };
    return f;
  }

  // Quantas dimensões estão ativas (badge do front / logs)
  function ativos(f) {
    let n = 0;
    if (f.q) n++;
    for (const k of ["estado", "cidade", "categoria", "cargo", "inicio", "status", "grupo"]) if (f[k] && f[k].length) n++;
    if (f.salarioMin > 0) n++;
    if (f.vagasMin > 0) n++;
    if (f.email) n++;
    return n;
  }

  // ── Índice por planilha (cache por identidade do array — planilha trocada
  // no disco vira array novo e o índice é refeito sozinho).
  // 🤖 v179: os robôs de planilha MUTAM as linhas no lugar (aplicarDolNaLinha
  // escreve e-mail/cidade/data/salário nos MESMOS objetos do MESMO array), e
  // o comprimento nunca muda — o índice ficava congelado até o próximo boot e
  // o enriquecimento não valia nos filtros nem nas contagens. `sheetVersion`
  // (dep do server, incrementada por _saveEnrichedSheet) invalida o índice.
  const _idx = new WeakMap();
  function indexar(rows) {
    const ver = sheetVersion ? (sheetVersion(rows) || 0) : 0;
    let ix = _idx.get(rows);
    if (ix && ix.n === rows.length && ix.ver === ver) return ix;
    const n = rows.length;
    ix = {
      n, ver,
      s: new Array(n), ci: new Array(n), ciN: new Array(n), ciKey: new Array(n), k: new Array(n), t: new Array(n), tl: new Array(n),
      wh: new Float32Array(n), wk: new Int32Array(n), m: new Int8Array(n), st: new Array(n), g: new Array(n), em: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const r = rows[i] || {};
      ix.s[i] = normalizeStateName(r.s);
      ix.ci[i] = String(r.ci || "").trim();
      ix.ciN[i] = ix.ci[i] ? _norm(ix.ci[i]) : "";
      ix.ciKey[i] = ix.ciN[i] ? ix.ciN[i] + "|" + ix.s[i] : "";
      ix.k[i] = String(r.k || "other").toLowerCase();
      const t = String(r.t || "").trim().replace(/\s+/g, " ");
      ix.t[i] = t; ix.tl[i] = t.toLowerCase();
      ix.wh[i] = wageHora(r);
      ix.wk[i] = parseInt(r.wk, 10) > 0 ? parseInt(r.wk, 10) : 0;
      const mm = String(r.d || "").match(/^\d{4}-(\d{2})/);
      ix.m[i] = mm ? parseInt(mm[1], 10) : 0;
      ix.st[i] = String(r.st || "").trim();
      ix.g[i] = grupoDe ? (grupoDe(r) || "") : (r.g && /^[A-H]$/.test(r.g) ? r.g : "");
      ix.em[i] = (r.e && String(r.e).includes("@")) ? 1 : 0;
    }
    _idx.set(rows, ix);
    return ix;
  }

  // Máscara de UMA dimensão (Uint8Array, 1 = a linha passa). Dimensão
  // inativa = todo mundo passa. qSet (linhas que casam com a busca textual)
  // é calculado fora, 1x por requisição, via searchSheet — a MESMA busca da
  // lista (relevância, região, categoria implícita), nunca uma 2ª régua.
  function _maskDim(rows, ix, f, dim, ctx) {
    const n = ix.n; const out = new Uint8Array(n); out.fill(1);
    switch (dim) {
      case "q": {
        if (!f.q) return out;
        const set = ctx.qSet; if (!set) return out;
        for (let i = 0; i < n; i++) out[i] = set.has(rows[i]) ? 1 : 0; return out;
      }
      case "estado": {
        if (!f.estado.length) return out;
        const set = new Set(f.estado);
        for (let i = 0; i < n; i++) out[i] = set.has(ix.s[i]) ? 1 : 0; return out;
      }
      case "cidade": {
        if (!f.cidade.length) return out;
        // Chave canônica (emitida pela faceta: "labelle|FLORIDA") casa por
        // IGUALDADE — cidade é lugar, não pedaço de texto. Valor LIVRE
        // (digitado, região turística, ou cidade salva no aparelho antes do
        // v179) continua no casamento amplo de sempre: compatibilidade.
        const keys = new Set(); const fns = [];
        for (const c of f.cidade) {
          const k = _ciKeyDoCliente(c);
          if (k) { keys.add(k); continue; }
          const fn = cityMatchNormFn ? cityMatchNormFn(c) : null; if (fn) fns.push(fn);
        }
        if (!keys.size && !fns.length) return out;
        for (let i = 0; i < n; i++) {
          const cn = ix.ciN[i];
          out[i] = (cn && ((keys.size && keys.has(ix.ciKey[i])) || (fns.length && fns.some(fn => fn(cn))))) ? 1 : 0;
        }
        return out;
      }
      case "categoria": {
        if (!f.categoria.length) return out;
        const set = new Set(f.categoria);
        for (let i = 0; i < n; i++) out[i] = set.has(ix.k[i]) ? 1 : 0; return out;
      }
      case "cargo": {
        if (!f.cargo.length) return out;
        const set = new Set(f.cargo);
        for (let i = 0; i < n; i++) out[i] = set.has(ix.tl[i]) ? 1 : 0; return out;
      }
      case "salarioMin": {
        if (!(f.salarioMin > 0)) return out;
        for (let i = 0; i < n; i++) out[i] = ix.wh[i] >= f.salarioMin ? 1 : 0; return out;
      }
      case "vagasMin": {
        if (!(f.vagasMin > 0)) return out;
        for (let i = 0; i < n; i++) out[i] = ix.wk[i] >= f.vagasMin ? 1 : 0; return out;
      }
      case "inicio": {
        if (!f.inicio.length) return out;
        const set = new Set(f.inicio);
        for (let i = 0; i < n; i++) out[i] = set.has(ix.m[i]) ? 1 : 0; return out;
      }
      case "status": {
        if (!f.status.length || !ctx.isDP) return out;
        const set = new Set(f.status.map(s => s.toLowerCase()));
        for (let i = 0; i < n; i++) out[i] = set.has(ix.st[i].toLowerCase()) ? 1 : 0; return out;
      }
      case "grupo": {
        if (!f.grupo.length || !ctx.isDP) return out;
        const set = new Set(f.grupo);
        for (let i = 0; i < n; i++) out[i] = set.has(ix.g[i]) ? 1 : 0; return out;
      }
      case "email": {
        if (!f.email) return out;
        for (let i = 0; i < n; i++) out[i] = ix.em[i]; return out;
      }
    }
    return out;
  }

  // Contexto por requisição: qSet (busca textual via searchSheet), base
  // (corte por usuário: enviados/fila/e-mails próprios), isDP.
  function _ctx(rows, f, opts) {
    const ctx = { isDP: !!opts.isDP, qSet: null, base: null };
    // ⚡ v179: /api/sheet-meta e o refill do robô chamam com except:["q"] (a
    // busca textual é aplicada logo depois pelo searchSheet, com relevância).
    // Sem esta checagem a planilha inteira era varrida DUAS vezes por
    // requisição e o 1º resultado era jogado fora (70,6ms vs 1,4ms medidos).
    if (f.q && searchSheet && !(opts.except || []).includes("q")) {
      const { items } = searchSheet(rows, f.q, "", "", 0, rows.length, "");
      ctx.qSet = new Set(items);
    }
    if (typeof opts.excluir === "function") {
      const b = new Uint8Array(rows.length);
      for (let i = 0; i < rows.length; i++) b[i] = opts.excluir(rows[i]) ? 0 : 1;
      ctx.base = b;
    }
    return ctx;
  }

  // Máscara combinada (AND de todas as dimensões, exceto as de `except`).
  function mascara(rows, f, opts = {}) {
    const ix = indexar(rows);
    const ctx = opts._ctx || _ctx(rows, f, opts);
    const except = new Set(opts.except || []);
    const out = new Uint8Array(ix.n); out.fill(1);
    if (ctx.base) for (let i = 0; i < ix.n; i++) out[i] &= ctx.base[i];
    for (const dim of DIMENSOES) {
      if (except.has(dim)) continue;
      const m = _maskDim(rows, ix, f, dim, ctx);
      for (let i = 0; i < ix.n; i++) out[i] &= m[i];
    }
    return out;
  }

  function filtrar(rows, f, opts = {}) {
    const m = mascara(rows, f, opts);
    const out = [];
    for (let i = 0; i < rows.length; i++) if (m[i]) out.push(rows[i]);
    return out;
  }

  // Rótulo humano da cidade: a grafia mais frequente na planilha (LaBelle 32 >
  // Labelle 23 > LABELLE 11); se a mais frequente for toda em caixa alta,
  // vira Title Case. Sem grafia conhecida (valor legado salvo no aparelho),
  // cai no próprio texto.
  const _grafiaLabel = (gm, chave) => {
    let melhor = "", q = -1;
    if (gm) for (const [g, n] of gm) if (n > q) { melhor = g; q = n; }
    if (!melhor) melhor = String(chave || "").split("|")[0];
    if (melhor && !/[a-z]/.test(melhor)) melhor = melhor.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
    return melhor;
  };

  const _top = (map, lim) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, lim);

  // ── Facetas: pra cada dimensão, contagem por opção com todos os OUTROS
  // filtros aplicados. total = tudo aplicado. disponibilidade = quantas
  // linhas da base têm dado naquela dimensão (0 → front esconde/avisa).
  function facetas(rows, f, opts = {}) {
    const ix = indexar(rows);
    const n = ix.n;
    const ctx = _ctx(rows, f, opts);
    const masks = {};
    for (const dim of DIMENSOES) masks[dim] = _maskDim(rows, ix, f, dim, ctx);
    const base = ctx.base || (() => { const b = new Uint8Array(n); b.fill(1); return b; })();
    // AND de tudo exceto `dim` (a própria dimensão fica de fora pra
    // multi-select somar em vez de zerar).
    // ⚡ v179: em vez de percorrer as 11 dimensões pra CADA linha de CADA
    // faceta (11 × 11 × n), conta UMA vez quantas dimensões cada linha
    // reprova. Uma linha entra em "tudo menos dim" quando não reprova nada
    // ou quando a ÚNICA que reprova é justamente `dim`.
    const reprova = new Int8Array(n); const qualFalha = new Array(n);
    for (const d of DIMENSOES) { const md = masks[d]; for (let i = 0; i < n; i++) if (!md[i]) { reprova[i]++; qualFalha[i] = d; } }
    const semDim = (dim) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (base[i] && (reprova[i] === 0 || (reprova[i] === 1 && qualFalha[i] === dim))) ? 1 : 0;
      return out;
    };
    const tudo = semDim("__nenhuma__");
    let total = 0; for (let i = 0; i < n; i++) total += tudo[i];
    let totalBase = 0; for (let i = 0; i < n; i++) totalBase += base[i];

    // disponibilidade (na base, antes dos filtros)
    const disp = { estado: 0, cidade: 0, categoria: 0, cargo: 0, salario: 0, vagas: 0, inicio: 0, status: 0, grupo: 0, email: 0, statusDistintos: 0 };
    const stDistinct = new Set();
    for (let i = 0; i < n; i++) {
      if (!base[i]) continue;
      if (ix.s[i]) disp.estado++;
      if (ix.ci[i]) disp.cidade++;
      if (ix.k[i] && ix.k[i] !== "other") disp.categoria++;
      if (ix.tl[i]) disp.cargo++;
      if (ix.wh[i] > 0) disp.salario++;
      if (ix.wk[i] > 0) disp.vagas++;
      if (ix.m[i] > 0) disp.inicio++;
      if (ix.st[i]) { disp.status++; stDistinct.add(ix.st[i]); }
      if (ix.g[i]) disp.grupo++;
      if (ix.em[i]) disp.email++;
    }
    disp.statusDistintos = stDistinct.size;

    const fac = {};
    // estado
    { const m = semDim("estado"); const c = new Map(); for (let i = 0; i < n; i++) if (m[i] && ix.s[i]) c.set(ix.s[i], (c.get(ix.s[i]) || 0) + 1);
      fac.estado = _top(c, 60).map(([v, q]) => ({ v, n: q })); }
    // categoria
    { const m = semDim("categoria"); const c = new Map(); for (let i = 0; i < n; i++) if (m[i]) c.set(ix.k[i], (c.get(ix.k[i]) || 0) + 1);
      fac.categoria = _top(c, 40).map(([v, q]) => ({ v, label: categoriaLabel ? categoriaLabel(v) : v, n: q })); }
    // cargo (título exato) — top N; com `cargoBusca` filtra por substring
    { const m = semDim("cargo"); const c = new Map(); const lbl = new Map();
      const busca = String(opts.cargoBusca || "").toLowerCase().trim();
      for (let i = 0; i < n; i++) { if (!m[i] || !ix.tl[i]) continue; if (busca && !ix.tl[i].includes(busca)) continue; c.set(ix.tl[i], (c.get(ix.tl[i]) || 0) + 1); if (!lbl.has(ix.tl[i])) lbl.set(ix.tl[i], ix.t[i]); }
      // os já selecionados sempre aparecem (mesmo fora do top), pra poder desmarcar
      const top = _top(c, opts.cargoLimite || 40);
      for (const sel of f.cargo) if (!top.some(([v]) => v === sel)) top.push([sel, c.get(sel) || 0]);
      fac.cargo = top.map(([v, q]) => ({ v, label: lbl.get(v) || v, n: q }));
      fac.cargoDistintos = c.size; }
    // cidade — 1 opção por CIDADE+ESTADO (chave canônica) + regiões turísticas
    { const m = semDim("cidade"); const c = new Map(); const st = new Map(); const graf = new Map();
      for (let i = 0; i < n; i++) {
        if (!m[i] || !ix.ciKey[i]) continue;
        const key = ix.ciKey[i];
        c.set(key, (c.get(key) || 0) + 1);
        if (!st.has(key)) st.set(key, ix.s[i]);
        let gm = graf.get(key); if (!gm) { gm = new Map(); graf.set(key, gm); }
        gm.set(ix.ci[i], (gm.get(ix.ci[i]) || 0) + 1); // grafia mais frequente vira o rótulo
      }
      const busca = _norm(opts.cidadeBusca || "");
      const lista = busca ? [...c.entries()].filter(([v]) => v.slice(0, v.lastIndexOf("|")).includes(busca)) : [...c.entries()];
      const top = lista.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, opts.cidadeLimite || 40);
      for (const sel of f.cidade) if (!top.some(([v]) => v === sel)) top.push([sel, c.get(sel) || 0]);
      fac.cidade = top.map(([v, q]) => ({ v, label: _grafiaLabel(graf.get(v), v), estado: st.get(v) || "", n: q }));
      fac.cidadeDistintas = c.size;
      // ⚡ v179: as 23 regiões contam sobre as CIDADES DISTINTAS já
      // normalizadas no índice (antes era 23 × nº de linhas com _normBusca
      // dentro do laço — 114 mil normalizações por requisição, 107ms de CPU
      // bloqueante numa rota que o painel chama a cada tecla digitada).
      const regs = [];
      if (regioes && cityMatchNormFn) {
        const distintas = [...c.entries()].map(([k, q]) => [k.slice(0, k.lastIndexOf("|")), q]);
        for (const reg of Object.keys(regioes)) {
          const fn = cityMatchNormFn(reg); if (!fn) continue; let q = 0;
          for (const [cn, qt] of distintas) if (fn(cn)) q += qt;
          if (q > 0) regs.push({ v: reg, n: q });
        }
      }
      fac.regiao = regs.sort((a, b) => b.n - a.n); }
    // salário — contagem "≥ limiar" + faixa real
    { const m = semDim("salarioMin"); const cnt = SALARIO_LIMIARES.map(() => 0); let sem = 0; let min = Infinity, max = 0; const vals = [];
      for (let i = 0; i < n; i++) { if (!m[i]) continue; const w = ix.wh[i]; if (!(w > 0)) { sem++; continue; } vals.push(w); if (w < min) min = w; if (w > max) max = w; for (let j = 0; j < SALARIO_LIMIARES.length; j++) if (w >= SALARIO_LIMIARES[j]) cnt[j]++; }
      vals.sort((a, b) => a - b);
      // v179: a FAIXA exibida ("de $X a $Y/h") usa percentil 1 e 99 — um
      // punhado de linhas com unidade errada na fonte não pode definir o que
      // a tela promete. Os extremos crus ficam em minAbs/maxAbs.
      const _pct = (p) => vals.length ? +vals[Math.min(vals.length - 1, Math.max(0, Math.floor((vals.length - 1) * p)))].toFixed(2) : 0;
      fac.salario = { limiares: SALARIO_LIMIARES.map((v, j) => ({ v, n: cnt[j] })), semSalario: sem, comSalario: vals.length,
        min: _pct(0.01), mediana: _pct(0.5), max: _pct(0.99),
        minAbs: vals.length ? +min.toFixed(2) : 0, maxAbs: vals.length ? +max.toFixed(2) : 0 }; }
    // vagas (trabalhadores solicitados)
    { const m = semDim("vagasMin"); const cnt = VAGAS_LIMIARES.map(() => 0); let sem = 0;
      for (let i = 0; i < n; i++) { if (!m[i]) continue; const w = ix.wk[i]; if (!(w > 0)) { sem++; continue; } for (let j = 0; j < VAGAS_LIMIARES.length; j++) if (w >= VAGAS_LIMIARES[j]) cnt[j]++; }
      fac.vagas = { limiares: VAGAS_LIMIARES.map((v, j) => ({ v, n: cnt[j] })), semDado: sem }; }
    // mês de início
    { const m = semDim("inicio"); const cnt = new Array(13).fill(0); let sem = 0;
      for (let i = 0; i < n; i++) { if (!m[i]) continue; if (ix.m[i] > 0) cnt[ix.m[i]]++; else sem++; }
      fac.inicio = MESES.map(mm => ({ v: mm, n: cnt[mm] })); fac.inicioSemData = sem; }
    // status DOL (💎 DoublePro) — só faz sentido com 2+ valores distintos.
    // 🚨 v177-FIX2 (auditoria 14/09/2026): _maskDim já impedia o FILTRO por
    // status/grupo de restringir a lista pra quem não é DP, mas a FACETA
    // (distribuição/contagem) era sempre calculada e devolvida no JSON,
    // mesmo pra usuário grátis — mesmo gate que o filtro já usa.
    if (ctx.isDP) { const m = semDim("status"); const c = new Map(); for (let i = 0; i < n; i++) if (m[i] && ix.st[i]) c.set(ix.st[i], (c.get(ix.st[i]) || 0) + 1);
      fac.status = _top(c, 12).map(([v, q]) => ({ v, n: q })); }
    // grupo A–H (💎 DoublePro)
    if (ctx.isDP) { const m = semDim("grupo"); const c = new Map(); for (let i = 0; i < n; i++) if (m[i] && ix.g[i]) c.set(ix.g[i], (c.get(ix.g[i]) || 0) + 1);
      fac.grupo = GRUPOS.filter(g => c.has(g)).map(g => ({ v: g, n: c.get(g) })); }
    // e-mail de contato
    { const m = semDim("email"); let com = 0, sem = 0; for (let i = 0; i < n; i++) { if (!m[i]) continue; if (ix.em[i]) com++; else sem++; }
      fac.email = { com, sem }; }

    return { total, totalBase, facetas: fac, disponibilidade: disp, ativos: ativos(f), isDP: ctx.isDP };
  }

  return { parse, ativos, indexar, mascara, filtrar, facetas, wageHora, DIMENSOES, DIMENSOES_DOUBLEPRO, SALARIO_LIMIARES, VAGAS_LIMIARES };
}

module.exports = { createFiltros, wageHora, SALARIO_LIMIARES, VAGAS_LIMIARES, DIMENSOES, DIMENSOES_DOUBLEPRO };
