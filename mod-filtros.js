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
// 🧰 v181 LOTE 6 — EXPERIÊNCIA EXIGIDA (meses). É o maior filtro que os dados
// já sustentavam e o site não tinha: 5.923 vagas de jan2026 (64%) e 1.037 de
// jul2025 (47%) exigem ZERO mês — pra um brasileiro de primeira viagem é
// provavelmente a primeira pergunta do site inteiro, e é uma vantagem que
// Indeed/LinkedIn não conseguem oferecer (lá esse dado não é declaração
// oficial). As opções são TETOS ("até N meses"), nunca valores exatos.
const EXP_TETOS = [0, 3, 6, 12];
// 🗓️ v181 LOTE 6 — TEMPORADA, derivada das datas que já existem na linha
// (nenhum campo novo na planilha): futura (começa depois de hoje) · aberta
// (já começou e ainda não terminou) · encerrada (data de FIM no passado) ·
// semdata (o governo não publicou data nenhuma). Em trabalho sazonal QUANDO
// começa manda mais que o cargo — é filtro de topo no próprio
// seasonaljobs.dol.gov ("Begin on or after Date").
const TEMPORADAS = ["futura", "aberta", "encerrada", "semdata"];
const VISTOS = ["H-2A", "H-2B"];
const DIMENSOES = ["q", "estado", "cidade", "categoria", "cargo", "salarioMin", "vagasMin", "inicio", "exp", "temporada", "visa", "status", "grupo", "email"];

// 💎 Dimensões exclusivas do plano Double Pro (decisão de produto do dono,
// mantida — o gate é do SERVIDOR: pra quem não é DP o parâmetro é ignorado).
const DIMENSOES_DOUBLEPRO = new Set(["grupo", "status"]);

// Salário → US$/hora, normalizado por unidade. MESMA régua usada pra ordenar
// por salário (searchSheet sort=wage) — fonte única: nunca duplicar.
// Dado sujo da fonte, nas DUAS direções (v179 — as duas heurísticas moram
// juntas de propósito, são a mesma ideia):
//  • rotulado "hora" mas > 200 → é mensal sem unidade ($2.058/h não existe);
//  • "pr" (por peça) NÃO é $/h: devolve 0 (salário desconhecido), nunca um
//    número inventado — v182 LOTE 8, junto com o mapeamento real de
//    pay_range_desc no robô de alimentação;
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
  // 💵 v182 LOTE 8: por PEÇA (produção) não é salário por hora e não dá pra
  // inventar um — vira "sem salário publicado" (fora dos limiares, contado em
  // `semSalario`). Estimar $/h de pagamento por produção seria mentir pro
  // candidato sobre quanto ele vai receber.
  if (un.startsWith("pr")) return 0;
  // Quinzenal (Bi-Weekly do DOL): 80 horas. Mesma proteção das outras — valor
  // baixo demais pra quinzena é hora mal rotulada na fonte.
  if (un.startsWith("bw")) return v < 200 ? v : v / 80;
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
// Visto normalizado: o campo `visa` está preenchido em 100% das 19.035 linhas
// e bate com o prefixo do case number em 100% (H-300 → H-2A, H-400 → H-2B),
// que é o fallback quando o campo falta.
const _visaNorm = (v) => {
  const s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.includes("H2A") || s === "AGRICULTURAL") return "H-2A";
  if (s.includes("H2B") || s === "NONAGRICULTURAL") return "H-2B";
  return "";
};
const _visaDaLinha = (r) => {
  const v = _visaNorm(r && r.visa);
  if (v) return v;
  const c = String((r && r.c) || "").toUpperCase();
  if (c.startsWith("H-300")) return "H-2A";
  if (c.startsWith("H-400")) return "H-2B";
  return "";
};
// Meses de experiência EXIGIDA na linha (-1 = o governo não publicou).
// ⚠️ regra da casa (v179): `exp` é EXPERIÊNCIA, nunca "vaga expirada".
const _expDaLinha = (r) => {
  if (!r) return -1;
  const v = r.exp;
  if (v === "" || v === null || v === undefined || v === true || v === false) return -1;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n <= 600 ? n : -1;
};
const _iso = (v) => { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; };
// 🏷️ v181 LOTE 7 — FAMÍLIA DE CARGO. O título vem CRU do DOL e a mesma
// ocupação se parte em várias opções com a contagem fatiada: em jan2026 são
// 1.806 títulos distintos, 1.192 aparecem 1 única vez, e "landscape laborer"
// (2.120) + "landscape laborers" (231) + "laborer, landscape" (9) eram 3
// chips pro mesmo trabalho. A FAMÍLIA é o título normalizado: minúsculo, sem
// acento, sem pontuação (então NUNCA tem vírgula — senão voltaria o bug do
// _csv do v179), sem "and/&", plural simples removido e palavras ORDENADAS
// (é o que junta "laborer, landscape" com "landscape laborer"). Onde existe
// SOC (classificação oficial do governo, estável), a família é o SOC — na
// H-2A isso junta as 393 grafias de "farmworker" numa opção só.
const _famNorm = (s) => {
  const x = String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!x) return "";
  const w = [];
  for (const tk of x.split(" ")) {
    if (!tk || tk === "and" || tk === "amp") continue;
    w.push(tk.length > 3 && tk.endsWith("s") && !tk.endsWith("ss") ? tk.slice(0, -1) : tk);
  }
  return [...new Set(w)].sort().join(" ");
};
// Chave de família a partir de um valor QUALQUER (nosso ou do cliente).
// Idempotente: aplicar de novo numa chave já emitida devolve ela mesma.
const _famKey = (raw) => {
  const s = String(raw || "").trim();
  if (/^soc:/i.test(s)) { const k = _famNorm(s.slice(4)); return k ? "soc:" + k : ""; }
  return _famNorm(s);
};

// Faixa da temporada: 0 futura · 1 aberta · 2 encerrada · 3 sem data.
const _temporadaDe = (d, de, hoje) => {
  if (!d && !de) return 3;
  if (de && de < hoje) return 2;
  if (d && d > hoje) return 0;
  return 1;
};


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
  // Cargo vindo do cliente → chave de FAMÍLIA. Aceita (a) a chave que a
  // faceta emitiu, (b) um título literal antigo ("Cooks, Restaurant" salvo no
  // aparelho ou em job.filters de robô rodando) e (c) qualquer grafia do
  // mesmo cargo — os 3 caminhos terminam na mesma família.
  const _cargoKeyDoCliente = (v, ix) => {
    const k = _famKey(v);
    if (!k) return "";
    if (ix.famSet.has(k)) return k;
    return ix.famPorTitulo.get(_famNorm(v)) || k;
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
    // ⚠️ v179: o que o motor não entende NÃO some calado. `inicio=13`,
    // `salarioMin=abc`, `grupo=Z` faziam o filtro evaporar e a resposta
    // devolver a planilha INTEIRA com ativos=0 — na tela é confusão; no robô
    // é sério, porque job.filters vem do cliente e é guardado como veio,
    // então um filtro corrompido fazia o refill se realimentar com tudo em
    // vez de parar. Agora cada descarte é declarado em `_ignorados`.
    const ignorados = [];
    const _marcar = (param, valor, motivo) => { if (ignorados.length < 20) ignorados.push({ param, valor: String(valor).slice(0, 40), motivo }); };
    const _brutoEstado = _lista(first("estado", "state"), s => s);
    const _brutoInicio = _lista(first("inicio", "beginMonth", "beginMonths"), s => s);
    const _brutoGrupo = _lista(first("grupo", "grupos"), s => s.toUpperCase());
    const _brutoExp = _lista(first("exp", "expMax"), s => s);
    const _brutoTemp = _lista(first("temporada", "season"), s => s.toLowerCase());
    const _brutoVisa = _lista(first("visa", "visto"), s => s);

    const _wBruto = String(first("salarioMin", "minWage") || "").trim();
    const _vBruto = String(first("vagasMin", "minWorkers") || "").trim();
    // 📅 v181 LOTE 6 — o mês de início ganhou ANO. O índice guardava só o mês
    // (1–12) e a tela imprimia "Mar 1.114" numa planilha em que 4.959 das
    // 4.964 vagas JÁ começaram: quem marca "Mar" entende "vou começar em
    // março" e está filtrando contratos que começaram em março. Agora o valor
    // é AAAA-MM. O formato antigo (1–12, que vive em job.filters de robô já
    // rodando e no aparelho de quem salvou filtro antes) continua valendo e
    // casa com aquele mês de QUALQUER ano.
    const _inicioAM = [], _inicioM = [];
    for (const v of _brutoInicio) {
      const s = String(v).trim();
      const am = s.match(/^(\d{4})-(\d{1,2})$/);
      if (am) { const mm = parseInt(am[2], 10); if (mm >= 1 && mm <= 12) { _inicioAM.push(parseInt(am[1], 10) * 100 + mm); continue; } }
      const m = parseInt(s, 10);
      if (m >= 1 && m <= 12 && /^\d{1,2}$/.test(s)) { _inicioM.push(m); continue; }
      _marcar("inicio", v, "mês inválido (use AAAA-MM ou 1–12)");
    }
    const f = {
      q: String(first("q", "keyword") || "").trim().slice(0, 120),
      estado: _brutoEstado.map(s => normalizeStateName(s)).filter(Boolean),
      cidade: _lista(first("cidade", "city"), s => s.slice(0, 80), false),
      categoria: _lista(first("categoria", "category"), s => s.toLowerCase()).filter(c => c !== "all"),
      cargo: _lista(first("cargo", "titles"), s => s.toLowerCase().replace(/\s+/g, " "), false).filter(c => c !== "__outros__"),
      salarioMin: _num(_wBruto),
      vagasMin: Math.floor(_num(_vBruto)),
      inicio: [...new Set(_inicioM)],
      inicioAM: [...new Set(_inicioAM)],
      exp: _brutoExp.map(s => parseInt(s, 10)).filter(v => Number.isFinite(v) && v >= 0 && v <= 600),
      temporada: _brutoTemp.filter(v => TEMPORADAS.includes(v)),
      // Padrão do app (não é escolha de filtro do usuário — tem chip próprio
      // e permanente na tela): esconder o que JÁ TERMINOU. Nunca esconde o
      // que não dá pra afirmar (vaga sem data de fim continua na lista).
      ocultarEncerradas: ["1", "true", "yes", "sim"].includes(String(first("ocultarEncerradas", "semEncerradas") || "").toLowerCase()),
      visa: [...new Set(_brutoVisa.map(v => _visaNorm(v)).filter(Boolean))],

      status: _lista(first("status", "dolStatus"), s => s.slice(0, 60), false),
      grupo: _brutoGrupo.filter(g => GRUPOS.includes(g)),
      email: ["1", "true", "yes", "sim"].includes(String(first("email", "hasEmail") || "").toLowerCase()),
    };
    for (const v of _brutoEstado) if (!normalizeStateName(v)) _marcar("estado", v, "estado desconhecido");
    for (const v of _brutoGrupo) if (!GRUPOS.includes(v)) _marcar("grupo", v, "grupo fora de A–H");
    for (const v of _brutoExp) { const n2 = parseInt(v, 10); if (!(Number.isFinite(n2) && n2 >= 0 && n2 <= 600)) _marcar("exp", v, "experiência não é um número de meses"); }
    for (const v of _brutoTemp) if (!TEMPORADAS.includes(v)) _marcar("temporada", v, "temporada fora de futura/aberta/encerrada/semdata");
    for (const v of _brutoVisa) if (!_visaNorm(v)) _marcar("visa", v, "visto fora de H-2A/H-2B");


    if (_wBruto && !(f.salarioMin > 0)) _marcar("salarioMin", _wBruto, "salário não é um número maior que zero");
    if (_vBruto && !(f.vagasMin > 0)) _marcar("vagasMin", _vBruto, "quantidade de vagas não é um número maior que zero");
    Object.defineProperty(f, "_ignorados", { value: ignorados, enumerable: false, writable: true, configurable: true });
    return f;
  }

  // Quantas dimensões estão ativas (badge do front / logs)
  function ativos(f) {
    let n = 0;
    if (f.q) n++;
    for (const k of ["estado", "cidade", "categoria", "cargo", "status", "grupo", "exp", "temporada", "visa"]) if (f[k] && f[k].length) n++;
    if ((f.inicio && f.inicio.length) || (f.inicioAM && f.inicioAM.length)) n++;
    if (f.salarioMin > 0) n++;
    if (f.vagasMin > 0) n++;
    if (f.email) n++;
    // ⚠️ `ocultarEncerradas` de propósito NÃO conta: é o estado PADRÃO do app
    // (esconder o que já terminou), declarado na tela por um chip próprio e
    // permanente ("⏳ Escondendo N vagas com temporada encerrada — mostrar"),
    // não uma escolha de filtro que o usuário fez.
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
    // 🗓️ v181: a faixa de temporada depende de HOJE — o índice carrega a data
    // com que foi construído e se refaz sozinho na virada do dia (senão uma
    // vaga que terminou ontem continuaria "aberta" até o próximo deploy).
    const hoje = new Date().toISOString().slice(0, 10);
    let ix = _idx.get(rows);
    if (ix && ix.n === rows.length && ix.ver === ver && ix.hoje === hoje) return ix;
    const n = rows.length;
    ix = {
      n, ver, hoje,
      s: new Array(n), ci: new Array(n), ciN: new Array(n), ciKey: new Array(n), k: new Array(n), t: new Array(n), tl: new Array(n),
      wh: new Float32Array(n), wk: new Int32Array(n), m: new Int8Array(n), am: new Int32Array(n), st: new Array(n), g: new Array(n), em: new Uint8Array(n),
      exp: new Int16Array(n), tp: new Uint8Array(n), vi: new Array(n),
      tFam: new Array(n), famSet: new Set(), famPorTitulo: new Map(),
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
      // família do cargo: SOC quando existe (classificação oficial), senão o
      // título normalizado. O mapa título→família mantém COMPATÍVEL o valor
      // antigo (título literal salvo no aparelho ou num job.filters de robô
      // que já está rodando) — ele continua casando com a família certa.
      const fam = t ? (r.soc ? ("soc:" + _famNorm(r.soc)) || _famNorm(t) : _famNorm(t)) : "";
      ix.tFam[i] = fam;
      if (fam) { ix.famSet.add(fam); const tf = _famNorm(t); if (tf && !ix.famPorTitulo.has(tf)) ix.famPorTitulo.set(tf, fam); }

      ix.wh[i] = wageHora(r);
      ix.wk[i] = parseInt(r.wk, 10) > 0 ? parseInt(r.wk, 10) : 0;
      const dIso = _iso(r.d), deIso = _iso(r.de);
      ix.m[i] = dIso ? parseInt(dIso.slice(5, 7), 10) : 0;
      ix.am[i] = dIso ? parseInt(dIso.slice(0, 4), 10) * 100 + parseInt(dIso.slice(5, 7), 10) : 0;
      ix.tp[i] = _temporadaDe(dIso, deIso, hoje);
      ix.exp[i] = _expDaLinha(r);
      ix.vi[i] = _visaDaLinha(r);
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
        const set = new Set(f.cargo.map(v => _cargoKeyDoCliente(v, ix)).filter(Boolean));
        if (!set.size) return out;
        for (let i = 0; i < n; i++) out[i] = set.has(ix.tFam[i]) ? 1 : 0; return out;
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
        const amSel = f.inicioAM || [], mSel = f.inicio || [];
        if (!amSel.length && !mSel.length) return out;
        const setAM = new Set(amSel), setM = new Set(mSel);
        for (let i = 0; i < n; i++) out[i] = (ix.am[i] && (setAM.has(ix.am[i]) || setM.has(ix.m[i]))) ? 1 : 0; return out;
      }
      // 🧰 experiência: as opções são TETOS ("até N meses"), então OU dentro da
      // dimensão é o menor teto que cabe. Linha sem o dado publicado nunca
      // entra num filtro de experiência (não dá pra afirmar que exige 0).
      case "exp": {
        if (!f.exp.length) return out;
        let teto = -1; for (const v of f.exp) if (v > teto) teto = v;
        for (let i = 0; i < n; i++) out[i] = (ix.exp[i] >= 0 && ix.exp[i] <= teto) ? 1 : 0; return out;
      }
      // 🗓️ temporada: seleção explícita manda; sem seleção, o padrão do app
      // (ocultarEncerradas) só tira o que JÁ TERMINOU — vaga sem data
      // continua na lista, porque não dá pra afirmar que acabou.
      case "temporada": {
        if (f.temporada.length) {
          const set = new Set(f.temporada.map(v => TEMPORADAS.indexOf(v)));
          for (let i = 0; i < n; i++) out[i] = set.has(ix.tp[i]) ? 1 : 0; return out;
        }
        if (f.ocultarEncerradas) { for (let i = 0; i < n; i++) out[i] = ix.tp[i] === 2 ? 0 : 1; return out; }
        return out;
      }
      case "visa": {
        if (!f.visa.length) return out;
        const set = new Set(f.visa);
        for (let i = 0; i < n; i++) out[i] = set.has(ix.vi[i]) ? 1 : 0; return out;
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
    // 🙈 v181 LOTE 6 — DIMENSÃO COM 1 VALOR SÓ NÃO SEPARA NADA. Medido: dentro
    // de CADA planilha o status tem 1 valor distinto ou nenhum (jan2026 e
    // jul2025 100% "Certified", jul2026 100% "Pending Processing", H-2A
    // vazio), e o grupo A–H só existe em jul2026. Marcar a única opção não
    // muda uma vaga. A regra deixou de ser um `if` do status e virou geral:
    // TODA dimensão de opções declara `<dim>Distintos` e a tela não oferece
    // as que têm menos de 2 — com uma linha honesta em vez de sumir calada.
    const disp = { estado: 0, cidade: 0, categoria: 0, cargo: 0, salario: 0, vagas: 0, inicio: 0, status: 0, grupo: 0, email: 0, exp: 0, temporada: 0, visa: 0, statusDistintos: 0 };
    const stDistinct = new Set(), esDistinct = new Set(), ciDistinct = new Set(), kDistinct = new Set(),
      caDistinct = new Set(), inDistinct = new Set(), exDistinct = new Set(), tpDistinct = new Set(),
      viDistinct = new Set(), gDistinct = new Set();
    for (let i = 0; i < n; i++) {
      if (!base[i]) continue;
      if (ix.s[i]) { disp.estado++; esDistinct.add(ix.s[i]); }
      if (ix.ci[i]) { disp.cidade++; ciDistinct.add(ix.ciKey[i]); }
      if (ix.k[i] && ix.k[i] !== "other") disp.categoria++;
      if (ix.k[i]) kDistinct.add(ix.k[i]);
      if (ix.tl[i]) { disp.cargo++; caDistinct.add(ix.tFam ? ix.tFam[i] : ix.tl[i]); }
      if (ix.wh[i] > 0) disp.salario++;
      if (ix.wk[i] > 0) disp.vagas++;
      if (ix.am[i] > 0) { disp.inicio++; inDistinct.add(ix.am[i]); }
      if (ix.exp[i] >= 0) { disp.exp++; exDistinct.add(ix.exp[i]); }
      if (ix.tp[i] !== 3) { disp.temporada++; }
      tpDistinct.add(ix.tp[i]);
      if (ix.vi[i]) { disp.visa++; viDistinct.add(ix.vi[i]); }
      if (ix.st[i]) { disp.status++; stDistinct.add(ix.st[i]); }
      if (ix.g[i]) { disp.grupo++; gDistinct.add(ix.g[i]); }
      if (ix.em[i]) disp.email++;
    }
    disp.statusDistintos = stDistinct.size;
    disp.estadoDistintos = esDistinct.size;
    disp.cidadeDistintos = ciDistinct.size;
    disp.categoriaDistintos = kDistinct.size;
    disp.cargoDistintos = caDistinct.size;
    disp.inicioDistintos = inDistinct.size;
    disp.expDistintos = exDistinct.size;
    // a faixa "sem data" não é opção de temporada — só as 3 reais separam algo
    disp.temporadaDistintos = [...tpDistinct].filter(v => v !== 3).length;
    disp.visaDistintos = viDistinct.size;
    disp.grupoDistintos = gDistinct.size;


    const fac = {};
    // estado
    { const m = semDim("estado"); const c = new Map(); for (let i = 0; i < n; i++) if (m[i] && ix.s[i]) c.set(ix.s[i], (c.get(ix.s[i]) || 0) + 1);
      fac.estado = _top(c, 60).map(([v, q]) => ({ v, n: q })); }
    // categoria
    { const m = semDim("categoria"); const c = new Map(); for (let i = 0; i < n; i++) if (m[i]) c.set(ix.k[i], (c.get(ix.k[i]) || 0) + 1);
      fac.categoria = _top(c, 40).map(([v, q]) => ({ v, label: categoriaLabel ? categoriaLabel(v) : v, n: q })); }
    // cargo — 1 opção por FAMÍLIA (v181): a contagem soma todas as grafias e
    // o rótulo é a grafia MAIS FREQUENTE dentro da família ("Landscape
    // Laborer 2.360" no lugar de 3 chips de 2.120/231/9). A busca por texto
    // continua olhando o TÍTULO de cada linha — a família entra na lista se
    // qualquer grafia dela casar com o que foi digitado.
    { const m = semDim("cargo"); const c = new Map(); const graf = new Map();
      const busca = String(opts.cargoBusca || "").toLowerCase().trim();
      for (let i = 0; i < n; i++) {
        if (!m[i] || !ix.tFam[i]) continue;
        if (busca && !ix.tl[i].includes(busca)) continue;
        const key = ix.tFam[i];
        c.set(key, (c.get(key) || 0) + 1);
        let gm = graf.get(key); if (!gm) { gm = new Map(); graf.set(key, gm); }
        gm.set(ix.t[i], (gm.get(ix.t[i]) || 0) + 1);
      }
      const top = _top(c, opts.cargoLimite || 40);
      // os já selecionados sempre aparecem (mesmo fora do top), pra poder desmarcar
      for (const sel of f.cargo) { const k = _cargoKeyDoCliente(sel, ix); if (k && !top.some(([v]) => v === k)) top.push([k, c.get(k) || 0]); }
      fac.cargo = top.map(([v, q]) => ({ v, label: _grafiaLabel(graf.get(v), v), n: q }));
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
    // 📅 mês de início — AGORA COM ANO (v181): v = "AAAA-MM" e `passado`
    // diz se aquele mês inteiro já ficou pra trás (a tela agrupa esses no
    // fim). O mês/ano vem do índice; o rótulo humano ("Mar/26") é montado na
    // tela pelo dicionário, nunca aqui (regra 6f — idioma mora no LANG_DICT).
    { const m = semDim("inicio"); const c = new Map(); let sem = 0;
      const amHoje = parseInt(ix.hoje.slice(0, 4), 10) * 100 + parseInt(ix.hoje.slice(5, 7), 10);
      for (let i = 0; i < n; i++) { if (!m[i]) continue; if (ix.am[i] > 0) c.set(ix.am[i], (c.get(ix.am[i]) || 0) + 1); else sem++; }
      fac.inicio = [...c.entries()].sort((a, b) => a[0] - b[0])
        .map(([am, q]) => ({ v: `${Math.floor(am / 100)}-${String(am % 100).padStart(2, "0")}`, ano: Math.floor(am / 100), mes: am % 100, n: q, passado: am < amHoje }));
      fac.inicioSemData = sem; }
    // 🧰 experiência exigida — contagem por TETO ("não exige" · até 3 · até 6
    // · até 12 meses), cada uma acumulando as menores.
    { const m = semDim("exp"); const cnt = EXP_TETOS.map(() => 0); let sem = 0;
      for (let i = 0; i < n; i++) { if (!m[i]) continue; const e = ix.exp[i]; if (e < 0) { sem++; continue; } for (let j = 0; j < EXP_TETOS.length; j++) if (e <= EXP_TETOS[j]) cnt[j]++; }
      fac.exp = EXP_TETOS.map((v, j) => ({ v, n: cnt[j] })); fac.expSemDado = sem; }
    // 🗓️ temporada — as 3 faixas reais + quantas não têm data nenhuma
    { const m = semDim("temporada"); const cnt = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) if (m[i]) cnt[ix.tp[i]]++;
      fac.temporada = [0, 1, 2].map(j => ({ v: TEMPORADAS[j], n: cnt[j] })); fac.temporadaSemData = cnt[3]; }
    // 🛂 tipo de visto — hoje cada planilha é de um visto só (a dimensão não é
    // oferecida pela tela), mas o núcleo `runPlanilhaMensal` é o mesmo pros 2
    // robôs e uma coleta pode trazer H-300 e H-400 juntos.
    { const m = semDim("visa"); const c = new Map();
      for (let i = 0; i < n; i++) if (m[i] && ix.vi[i]) c.set(ix.vi[i], (c.get(ix.vi[i]) || 0) + 1);
      fac.visa = VISTOS.filter(v => c.has(v)).map(v => ({ v, n: c.get(v) })); }

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

  return { parse, ativos, indexar, mascara, filtrar, facetas, wageHora, temporadaDe: _temporadaDe, visaDaLinha: _visaDaLinha, DIMENSOES,
 DIMENSOES_DOUBLEPRO, SALARIO_LIMIARES, VAGAS_LIMIARES, EXP_TETOS, TEMPORADAS, VISTOS };
}

module.exports = { createFiltros, wageHora, SALARIO_LIMIARES, VAGAS_LIMIARES, EXP_TETOS, TEMPORADAS, VISTOS, DIMENSOES, DIMENSOES_DOUBLEPRO };

