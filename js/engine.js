// Il cervello del telefono: documenti → frammenti → significati → regioni, neuroni e sinapsi.
// Funziona da solo, senza PC. L'AI cloud (Gemini/Groq) serve per significati, OCR, audio e risposte;
// senza rete il cervello resta consultabile e la ricerca per parole funziona lo stesso.
import * as db from './db.js';
import * as ai from './ai.js';
import { extract, chunk as chunkText, ocrPdfPage, readable, needsNet } from './extract.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16));
const now = () => Date.now() / 1000;
// pausa brevissima per lasciare respirare l'interfaccia (MessageChannel: niente ritardo minimo di 4 ms)
const _mc = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null; const _q = [];
if (_mc) _mc.port1.onmessage = () => _q.shift()?.();
const tick = () => new Promise(r => { if (_mc) { _q.push(r); _mc.port2.postMessage(0); } else setTimeout(r, 0); });
// durante i calcoli lunghi cedo il passo ogni ~12 ms: tocchi e animazioni restano fluidi
let _t0 = 0;
const breathe = async () => { const n = performance.now(); if (n - _t0 > 12) { await new Promise(r => setTimeout(r, 0)); _t0 = performance.now(); } };
const online = () => !globalThis.navigator || navigator.onLine !== false;
const day = () => new Date().toISOString().slice(0, 10);

export const E = {
  docs: new Map(), chunks: [], byId: new Map(), graph: null, ready: false,
  busy: '', queue: 0, pendingEmbed: 0, pendingOcr: 0, error: null, version: 0,
};
const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const emit = () => { E.version++; listeners.forEach(fn => { try { fn(E); } catch (e) { console.error(e); } }); };

// ------------------------------------------------------------------ parole
const STOP = new Set(('a ad al allo ai agli all agl alla alle con col coi da dal dallo dai dagli dall dagl dalla dalle di del dello dei degli dell degl della delle in nel nello nei negli nell negl nella nelle su sul sullo sui sugli sull sugl sulla sulle per tra fra il lo la i gli le l un uno una e ed o od ma se che chi cui non più piu come anche quando dove perché perche quindi cioè cioe sono è e\' era essere ha hanno ho abbiamo avere questo questa questi queste quello quella quelli quelle suo sua suoi sue loro mio mia tuo tua noi voi lui lei esso essa essi si sì no ne ci vi ogni tutto tutti tutte tutta molto poco altro altri altra altre stesso stessa può puo possono deve devono fare fatto viene vengono così cosi poi già gia solo sempre mai the of and to in is are for on with as by be this that it from an or at which was were can not').split(' '));
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function words(text) {
  const out = [];
  for (const m of norm(text).matchAll(/[a-z0-9]+(?:'[a-z]+)?/g)) {
    let w = m[0].replace(/^[a-z]{1,3}'/, '');
    if (w.length < 2 || STOP.has(w) || /^\d{5,}$/.test(w)) continue;
    if (w.length > 5) w = w.replace(/(azioni|azione|mente|zioni|zione|ità|ita|i|e|a|o)$/, '');   // radice grezza
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------- caricamento
export async function load() {
  await ai.load();
  const docs = await db.all('docs');
  E.docs = new Map(docs.map(d => [d.id, d]));
  E.chunks = (await db.all('chunks')).filter(c => E.docs.has(c.doc));
  E.chunks.sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : a.k - b.k));
  E.byId = new Map(E.chunks.map((c, i) => [c.id, i]));
  E.graph = await db.kget('graph');
  E.regionNames = await db.kget('regionNames', {});
  buildLexical();
  E.ready = true;
  counts(); emit();
  if (E.graph?.n !== E.chunks.length) scheduleGraph(500);
  pump();
}

function counts() {
  E.queue = [...E.docs.values()].filter(d => d.stato === 'in coda' || d.stato === 'attesa rete').length;
  E.pendingEmbed = E.chunks.filter(c => !c.vec).length;
  E.pendingOcr = [...E.docs.values()].reduce((s, d) => s + (d.ocr?.length || 0), 0);
}

// --------------------------------------------------------------- documenti
export const docOf = matId => [...E.docs.values()].find(d => d.mat === matId);

// Aggiunge al cervello un materiale (già salvato nel negozio "materials")
const adding = new Map();
export function addMaterial(m, raccolta = '') {
  if (!adding.has(m.id)) adding.set(m.id, addMaterialNow(m, raccolta).finally(() => adding.delete(m.id)));
  return adding.get(m.id);
}
async function addMaterialNow(m, raccolta) {
  if (!readable(m.nome, m.mime)) return null;
  const have = docOf(m.id);
  if (have) return have;
  const d = { id: uid(), mat: m.id, nome: m.nome, fonte: 'materiale', raccolta: raccolta || ({ pc: 'Dal PC', drive: 'Dal Drive', telefono: 'Miei file' }[m.fonte] || 'Miei file'),
    stato: 'in coda', t: now(), nchunk: 0, ocr: [] };
  await db.put('docs', d); E.docs.set(d.id, d);
  counts(); emit(); pump();
  return d;
}

// Note, risposte salvate e testi: diventano documenti con testo proprio
export async function addText(kind, id, titolo, testo, raccolta) {
  let d = [...E.docs.values()].find(x => x.fonte === kind && x.ref === id);
  if (!d) d = { id: uid(), ref: id, fonte: kind, t: now(), ocr: [] };
  Object.assign(d, { nome: titolo, raccolta, stato: 'in coda', testo, nchunk: 0, modificato: now() });
  await db.put('docs', d); E.docs.set(d.id, d);
  counts(); emit(); pump();
  return d;
}

export async function removeDoc(id) {
  const d = E.docs.get(id); if (!d) return;
  E.docs.delete(id);
  await db.del('docs', id);
  await db.delPrefix('chunks', `${id}:`);
  E.chunks = E.chunks.filter(c => c.doc !== id);
  E.byId = new Map(E.chunks.map((c, i) => [c.id, i]));
  buildLexical(); counts(); emit(); scheduleGraph();
}
export const removeByRef = async (kind, ref) => { for (const d of [...E.docs.values()]) if (d.fonte === kind && d.ref === ref) await removeDoc(d.id); };
export const removeByMat = async matId => { const d = docOf(matId); if (d) await removeDoc(d.id); };

export async function setRaccolta(docId, raccolta) {
  const d = E.docs.get(docId); if (!d) return;
  d.raccolta = raccolta; await db.put('docs', d); emit(); scheduleGraph();
}
export const raccolte = () => [...new Set([...E.docs.values()].map(d => d.raccolta).filter(Boolean))].sort();

async function storeChunks(d, parts, append = false) {
  const base = append ? d.nchunk : 0;
  if (!append && E.chunks.some(c => c.doc === d.id)) { await db.delPrefix('chunks', `${d.id}:`); E.chunks = E.chunks.filter(c => c.doc !== d.id); }
  const rows = parts.map((p, k) => ({ id: `${d.id}:${base + k}`, doc: d.id, k: base + k, text: p.text, loc: p.loc || '', page: p.page || null, t: p.t ?? null, vec: null }));
  await db.putMany('chunks', rows);
  E.chunks.push(...rows);
  E.byId = new Map(E.chunks.map((c, i) => [c.id, i]));
  d.nchunk = base + rows.length;
}

// ------------------------------------------------------------- lavoro di fondo
let pumping = false, wake = null;
export function pump() { if (wake) { clearTimeout(wake); wake = null; } if (!pumping) work(); }
async function work() {
  pumping = true;
  try {
    for (;;) {
      const did = await step();
      counts();
      if (!did) break;
      emit(); await tick();
    }
  } catch (e) { E.error = e.message; console.error(e); }
  finally { pumping = false; E.busy = ''; emit(); }
  if (E.queue || E.pendingEmbed || E.pendingOcr) wake = setTimeout(pump, 60000);     // riprova (rete, limiti)
}

async function budget(kind, max) {
  const b = await db.kget('budget', {});
  if (b.day !== day()) { b.day = day(); b.ocr = 0; b.sum = 0; }
  if ((b[kind] || 0) >= max) return false;
  b[kind] = (b[kind] || 0) + 1; await db.kset('budget', b); return true;
}

async function step() {
  // 1) leggere i documenti nuovi
  const next = [...E.docs.values()].filter(d => d.stato === 'in coda' || (d.stato === 'attesa rete' && online() && ai.available()))
    .sort((a, b) => a.t - b.t)[0];
  if (next) { await readDoc(next); return true; }
  // 2) significati (Gemini, a blocchi da 100)
  const todo = E.chunks.filter(c => !c.vec);
  if (todo.length && ai.canEmbed() && online() && !E.embedPause) {
    const batch = todo.slice(0, 100);
    E.busy = `Calcolo i significati · ${todo.length} frammenti`;
    emit();
    try {
      const vecs = await ai.embed(batch.map(c => `${E.docs.get(c.doc)?.nome || ''}\n${c.text}`));
      batch.forEach((c, i) => { c.vec = vecs[i]; });
      await db.putMany('chunks', batch);
      if (todo.length <= 100) scheduleGraph(800);
      return true;
    } catch (e) {
      E.error = 'Significati: ' + e.message;
      E.embedPause = true; setTimeout(() => { E.embedPause = false; pump(); }, e.status === 429 ? 60000 : 30000);
    }
  }
  // 3) OCR delle pagine scansionate (Gemini, con un massimo al giorno)
  const ocrDoc = [...E.docs.values()].find(d => d.ocr?.length);
  if (ocrDoc && ai.canEmbed() && online() && !E.ocrPause) {
    if (!(await budget('ocr', 150))) { E.ocrPause = true; setTimeout(() => { E.ocrPause = false; }, 3600e3); return false; }
    const p = ocrDoc.ocr[0];
    E.busy = `OCR: ${ocrDoc.nome} · pagina ${p}`; emit();
    try {
      const m = await db.get('materials', ocrDoc.mat);
      const text = m ? await ocrPdfPage(m.blob, p) : '';
      if (text.trim().length > 20) { await storeChunks(ocrDoc, chunkText([{ text, loc: `p. ${p} (OCR)`, page: p }]), true); buildLexical(); }
      ocrDoc.ocr.shift(); await db.put('docs', ocrDoc);
      if (!ocrDoc.ocr.length) scheduleGraph();
      return true;
    } catch (e) {
      E.error = 'OCR: ' + e.message; E.ocrPause = true; setTimeout(() => { E.ocrPause = false; pump(); }, 60000);
    }
  }
  // 4) riassunti dei documenti (in background, pochi al giorno)
  const sumDoc = [...E.docs.values()].find(d => d.stato === 'letto' && !d.riassunto && !d.noSum && d.nchunk >= 2 && d.fonte === 'materiale');
  if (sumDoc && ai.available() && online() && !E.sumPause) {
    if (!(await budget('sum', 60))) { E.sumPause = true; return false; }
    E.busy = `Riassumo ${sumDoc.nome}`; emit();
    try { await summarize(sumDoc); return true; }
    catch (e) { sumDoc.noSum = true; E.sumPause = true; setTimeout(() => { E.sumPause = false; }, 120000); }
  }
  return false;
}

async function readDoc(d) {
  E.busy = `Leggo ${d.nome}…`; emit();
  try {
    let parts;
    if (d.testo !== undefined) parts = chunkText([{ text: d.testo, loc: '' }]);
    else {
      const m = await db.get('materials', d.mat);
      if (!m) { await removeDoc(d.id); return; }
      if (needsNet(m.nome) && (!online() || !ai.available())) {
        d.stato = 'attesa rete'; d.errore = ai.available() ? 'serve la connessione' : 'serve una chiave AI (Impostazioni)';
        await db.put('docs', d); return;
      }
      const r = await extract(m.blob, m.nome, m.mime, { onProgress: t => { E.busy = `Leggo ${d.nome} · ${t}`; emit(); } });
      parts = chunkText(r.segs);
      d.ocr = r.ocr || []; d.info = r.info || '';
    }
    await storeChunks(d, parts);
    d.stato = 'letto'; d.errore = null;
  } catch (e) {
    if (e instanceof ai.NoAI) { d.stato = 'attesa rete'; d.errore = e.message; }
    else { d.stato = 'errore'; d.errore = e.message; }
  }
  await db.put('docs', d);
  clearTimeout(lexTimer); lexTimer = setTimeout(buildLexical, E.queue > 0 ? 4000 : 300);   // indice delle parole: una volta sola dopo tanti file
  scheduleGraph(2500);
}
let lexTimer = 0;

export async function retry(docId) {
  const d = E.docs.get(docId); if (!d) return;
  d.stato = 'in coda'; d.errore = null; await db.put('docs', d); pump();
}

async function summarize(d) {
  const cs = E.chunks.filter(c => c.doc === d.id);
  let text = '', used = 0;
  const step = Math.max(1, Math.floor(cs.length / 30));
  for (let i = 0; i < cs.length && used < 14000; i += step) { text += `[${cs[i].loc}] ${cs[i].text}\n\n`; used += cs[i].text.length; }
  const r = await ai.generate(`Riassumi in italiano questo documento «${d.nome}» per uno studente: 5-10 punti chiave in Markdown, ` +
    `formule in LaTeX tra $...$, indicando le pagine o i minuti tra parentesi quando utile. Niente introduzioni.\n\n${text}`);
  d.riassunto = r.testo.trim(); await db.put('docs', d);
}
export async function summarizeNow(docId) { const d = E.docs.get(docId); if (d) { await summarize(d); emit(); } return d?.riassunto; }

// --------------------------------------------------------------- ricerca per parole
let LEX = null;
let lexRun = 0;
async function buildLexical() {      // a piccoli pezzi: con migliaia di frammenti non blocca l'app
  const run = ++lexRun, chunks = E.chunks;
  const inv = new Map(); const len = new Float32Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const ws = words((E.docs.get(c.doc)?.nome || '') + ' ' + c.text);
    len[i] = ws.length || 1;
    const tf = new Map(); for (const w of ws) tf.set(w, (tf.get(w) || 0) + 1);
    for (const [w, n] of tf) { let l = inv.get(w); if (!l) inv.set(w, l = []); l.push(i, n); }
    if ((i & 63) === 63) { await breathe(); if (run !== lexRun) return; }
  }
  if (run !== lexRun || chunks !== E.chunks) { if (run === lexRun) buildLexical(); return; }
  let avg = 0; for (const x of len) avg += x; avg = avg / (len.length || 1);
  LEX = { inv, len, avg, N: chunks.length };
}
function bm25(q, allow) {
  const sc = new Map(); const { inv, len, avg, N } = LEX;
  for (const w of new Set(words(q))) {
    const l = inv.get(w); if (!l) continue;
    const df = l.length / 2, idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let j = 0; j < l.length; j += 2) {
      const i = l[j]; if (allow && !allow(i)) continue;
      const tf = l[j + 1];
      sc.set(i, (sc.get(i) || 0) + idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * len[i] / avg)));
    }
  }
  return [...sc].sort((a, b) => b[1] - a[1]).slice(0, 60);
}

// Ricerca ibrida (significato + parole esatte, fusione RRF) come sul PC.
// filtro: { raccolta?, doc?, regione? }. Restituisce [{i, chunk, doc, score, score_vec, parole}]
export async function search(q, k = 8, filtro = {}) {
  const allow = (filtro.raccolta || filtro.doc || filtro.regione !== undefined) ? i => {
    const c = E.chunks[i], d = E.docs.get(c.doc);
    if (filtro.doc && c.doc !== filtro.doc) return false;
    if (filtro.raccolta && d?.raccolta !== filtro.raccolta) return false;
    if (filtro.regione !== undefined && regionOf(c.id) !== filtro.regione) return false;
    return true;
  } : null;
  const lex = bm25(q, allow);
  let vec = [];
  if (ai.canEmbed() && online() && E.chunks.some(c => c.vec)) {
    try {
      const [qv] = await ai.embed([q], 'RETRIEVAL_QUERY');
      const sc = [];
      E.chunks.forEach((c, i) => {
        if (!c.vec || (allow && !allow(i))) return;
        let s = 0; for (let j = 0; j < qv.length; j++) s += qv[j] * c.vec[j];
        sc.push([i, s]);
      });
      vec = sc.sort((a, b) => b[1] - a[1]).slice(0, 60);
    } catch (e) { E.error = 'Ricerca per significato non riuscita: ' + e.message; }
  }
  const fused = new Map();
  vec.forEach(([i, s], r) => fused.set(i, { i, rrf: 1 / (60 + r), score_vec: s, parole: false }));
  lex.forEach(([i], r) => { const f = fused.get(i) || { i, rrf: 0, score_vec: null, parole: false }; f.rrf += 1 / (60 + r); f.parole = r < 15; fused.set(i, f); });
  const out = [...fused.values()].sort((a, b) => b.rrf - a.rrf);
  // non più di 3 frammenti dallo stesso documento
  const per = new Map(), hits = [];
  for (const h of out) {
    const c = E.chunks[h.i]; const n = per.get(c.doc) || 0;
    if (n >= 3) continue; per.set(c.doc, n + 1);
    hits.push({ ...h, score: h.rrf * 30, chunk: c, doc: E.docs.get(c.doc) });
    if (hits.length >= k) break;
  }
  return { hits, semantica: vec.length > 0, best: vec.length ? vec[0][1] : null, lexBest: lex.length ? lex[0][1] : 0 };
}

// ricerca veloce per la barra (solo parole, offline)
export function quickFind(q, n = 20) {
  if (!q.trim() || !LEX) return [];
  return bm25(q).slice(0, n).map(([i, s]) => ({ i, s, chunk: E.chunks[i], doc: E.docs.get(E.chunks[i].doc) }));
}

// ------------------------------------------------------------------ il grafo
let gIdx = null, gIdxFor = null;
export function gIndex(id) {          // posizione di un frammento nel grafo (che può essere di poco più vecchio)
  if (!E.graph) return -1;
  if (gIdxFor !== E.graph) { gIdx = new Map(E.graph.ids.map((x, i) => [x, i])); gIdxFor = E.graph; }
  return gIdx.get(id) ?? -1;
}
export const regionOf = id => { const g = gIndex(id); return g >= 0 ? E.graph.region[g] : -1; };
let gTimer = null;
export function scheduleGraph(delay = 3000) {
  // mentre sto ancora leggendo file non ridisegno il cervello a ogni documento: una volta sola alla fine
  if (E.queue > 0 || pumping) delay = Math.max(delay, 8000);
  clearTimeout(gTimer); gTimer = setTimeout(() => buildGraph().catch(e => { E.error = 'Grafo: ' + e.message; emit(); }), delay); }

const DIM = 256;
function hashVec(text) {       // riserva senza AI: "impronta" delle parole (TF-IDF approssimato)
  const v = new Float32Array(DIM);
  for (const w of words(text)) {
    let h = 2166136261; for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 16777619); }
    const df = LEX?.inv.get(w)?.length / 2 || 1;
    v[(h >>> 0) % DIM] += ((h >>> 31) ? 1 : -1) * Math.log(1 + (LEX?.N || 1) / df);
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#b388ff', '#ff8c42', '#7bdff2', '#ef476f', '#a7c957', '#f4a261',
  '#90e0ef', '#e5989b', '#cdb4db', '#80ed99', '#ffafcc', '#48cae4', '#fcbf49', '#c77dff', '#72efdd', '#ff6b6b', '#64dfdf', '#ffd6a5', '#9bf6ff', '#bdb2ff'];

let building = false;
export async function buildGraph() {
  if (building) { scheduleGraph(2000); return; }
  // se sto ancora calcolando i significati, ridisegno solo alla fine (una volta sola), tranne la prima volta
  if (E.graph?.n && E.chunks.some(c => !c.vec) && ai.canEmbed() && online() && !E.embedPause) return;
  building = true;
  try {
    const N = E.chunks.length;
    if (!N) { E.graph = null; await db.kset('graph', null); emit(); return; }
    E.busy = 'Disegno il cervello…'; emit(); await tick();
    const useReal = E.chunks.every(c => c.vec) || (ai.canEmbed() && E.chunks.filter(c => c.vec).length > N * 0.9);
    const V = [];
    for (const c of E.chunks) {     // l'"impronta" di riserva si calcola una volta sola per frammento
      V.push((useReal && c.vec) ? c.vec : (c._hv ||= hashVec((E.docs.get(c.doc)?.nome || '') + ' ' + c.text)));
      if ((V.length & 255) === 0) await breathe();
    }
    const D = V[0].length;
    const rnd = rng(1234);

    // --- regioni: k-means sferico (k-means++), su un campione se sono tanti
    const K = Math.max(1, Math.min(24, Math.round(Math.sqrt(N / 10)), N));
    const sample = N > 6000 ? Array.from({ length: 6000 }, () => Math.floor(rnd() * N)) : [...Array(N).keys()];
    const cent = [V[sample[Math.floor(rnd() * sample.length)]].slice()];
    const dmin = new Float32Array(sample.length).fill(2);
    while (cent.length < K) {
      let tot = 0;
      const last = cent.at(-1);
      for (let j = 0; j < sample.length; j++) { dmin[j] = Math.min(dmin[j], 1 - dot(V[sample[j]], last)); tot += dmin[j] * dmin[j]; if ((j & 511) === 511) await breathe(); }
      let r = rnd() * tot, pick = sample[0];
      for (let j = 0; j < sample.length; j++) { r -= dmin[j] * dmin[j]; if (r <= 0) { pick = sample[j]; break; } }
      cent.push(V[pick].slice());
    }
    const assign = new Int32Array(N);
    const assignAll = async () => { for (let i = 0; i < N; i++) { let b = 0, bs = -9; for (let k = 0; k < K; k++) { const s = dot(V[i], cent[k]); if (s > bs) { bs = s; b = k; } } assign[i] = b; if ((i & 255) === 255) await breathe(); } };
    for (let it = 0; it < 10; it++) {
      let cc = 0;
      for (const i of sample) { let b = 0, bs = -9; for (let k = 0; k < K; k++) { const s = dot(V[i], cent[k]); if (s > bs) { bs = s; b = k; } } assign[i] = b; if ((++cc & 255) === 0) await breathe(); }
      const sum = Array.from({ length: K }, () => new Float32Array(D)); const cnt = new Int32Array(K);
      for (const i of sample) { const a = assign[i]; cnt[a]++; for (let j = 0; j < D; j++) sum[a][j] += V[i][j]; }
      for (let k = 0; k < K; k++) if (cnt[k]) { let n = 0; for (const x of sum[k]) n += x * x; n = Math.sqrt(n) || 1; cent[k] = sum[k].map(x => x / n); }
      await breathe();
      await tick();
    }
    await assignAll();
    // i frammenti dello stesso documento tendono a stare insieme: regione di maggioranza per i documenti piccoli
    const byDoc = new Map();
    for (let i = 0; i < N; i++) { const d = E.chunks[i].doc; if (!byDoc.has(d)) byDoc.set(d, []); byDoc.get(d).push(i); }
    for (const idx of byDoc.values()) {
      if (idx.length > 6) continue;
      const c = new Map(); for (const i of idx) c.set(assign[i], (c.get(assign[i]) || 0) + 1);
      const best = [...c].sort((a, b) => b[1] - a[1])[0][0];
      for (const i of idx) assign[i] = best;
    }
    // regioni vuote via, rinumero per grandezza
    const sizes = new Map(); for (const a of assign) sizes.set(a, (sizes.get(a) || 0) + 1);
    const order = [...sizes.keys()].sort((a, b) => sizes.get(b) - sizes.get(a));
    const remap = new Map(order.map((k, j) => [k, j]));
    for (let i = 0; i < N; i++) assign[i] = remap.get(assign[i]);
    const R = order.length;
    const rc = order.map(k => cent[k]);
    const rsize = order.map(k => sizes.get(k));

    // --- dove stanno le regioni sulla superficie: simili vicine (molle su una sfera)
    const golden = Math.PI * (3 - Math.sqrt(5));
    let dirs = Array.from({ length: R }, (_, k) => { const y = 1 - 2 * (k + 0.5) / R, r = Math.sqrt(1 - y * y); return [Math.cos(golden * k) * r, y, Math.sin(golden * k) * r]; });
    const sim = rc.map(a => rc.map(b => dot(a, b)));
    for (let it = 0; it < 300 && R > 2; it++) {
      const f = dirs.map(() => [0, 0, 0]);
      for (let a = 0; a < R; a++) for (let b = 0; b < R; b++) {
        if (a === b) continue;
        const d = [dirs[b][0] - dirs[a][0], dirs[b][1] - dirs[a][1], dirs[b][2] - dirs[a][2]];
        const L = Math.hypot(...d) || 1e-3;
        const want = 0.35 + (1 - sim[a][b]) * 1.6;
        const s = (L - want) * 0.02 / L;
        f[a][0] += d[0] * s; f[a][1] += d[1] * s; f[a][2] += d[2] * s;
      }
      dirs = dirs.map((p, a) => { const q = [p[0] + f[a][0], p[1] + f[a][1], p[2] + f[a][2]]; const n = Math.hypot(...q); return q.map(x => x / n); });
    }

    // --- posizioni dei neuroni: dentro la "macchia" della propria regione, ordinati per significato
    const pos = new Float32Array(N * 3);
    const total = N;
    for (let r = 0; r < R; r++) {
      const idx = []; for (let i = 0; i < N; i++) if (assign[i] === r) idx.push(i);
      const share = rsize[r] / total;
      const ang = Math.min(1.25, Math.sqrt(share * 4 * 1.15));          // raggio angolare della macchia
      const c = dirs[r];
      // base del piano tangente
      let u = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      u = [u[1] * c[2] - u[2] * c[1], u[2] * c[0] - u[0] * c[2], u[0] * c[1] - u[1] * c[0]];
      let nu = Math.hypot(...u); u = u.map(x => x / nu);
      const w = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
      // due direzioni principali della regione (iterazione delle potenze) → coordinate 2D
      const cen = rc[r];
      const pc = [];
      for (let p = 0; p < 2; p++) {
        let e = new Float32Array(D).map(() => rnd() - 0.5);
        for (let it = 0; it < 8; it++) {
          const ne = new Float32Array(D);
          let cnt2 = 0;
          for (const i of idx.length > 1500 ? idx.filter((_, j) => j % Math.ceil(idx.length / 1500) === 0) : idx) {
            let s = 0; for (let j = 0; j < D; j++) s += (V[i][j] - cen[j]) * e[j];
            for (let j = 0; j < D; j++) ne[j] += s * (V[i][j] - cen[j]);
            if ((++cnt2 & 127) === 0) await breathe();
          }
          if (p === 1) { const s = dot(ne, pc[0]); for (let j = 0; j < D; j++) ne[j] -= s * pc[0][j]; }
          let n = 0; for (const x of ne) n += x * x; n = Math.sqrt(n) || 1; e = ne.map(x => x / n);
        }
        pc.push(e);
      }
      const xy = idx.map(i => { let a = 0, b = 0; for (let j = 0; j < D; j++) { const d = V[i][j] - cen[j]; a += d * pc[0][j]; b += d * pc[1][j]; } return [a, b]; });
      // da coordinate a disco uniforme: raggio per rango, angolo dalla direzione
      const rad = xy.map(([a, b]) => Math.hypot(a, b));
      const rank = rad.map((_, j) => j).sort((a, b) => rad[a] - rad[b]);
      const rr = new Float32Array(idx.length); rank.forEach((j, k) => { rr[j] = Math.sqrt((k + 0.5) / idx.length); });
      idx.forEach((i, j) => {
        const th = Math.atan2(xy[j][1], xy[j][0]) + (rnd() - 0.5) * 0.25;
        const rho = ang * rr[j] * (0.92 + rnd() * 0.08);
        const tx = Math.cos(th) * rho, ty = Math.sin(th) * rho;
        // mappa esponenziale sulla sfera
        const L = Math.hypot(tx, ty) || 1e-6, s = Math.sin(L) / L;
        let p = [c[0] * Math.cos(L) + (u[0] * tx + w[0] * ty) * s, c[1] * Math.cos(L) + (u[1] * tx + w[1] * ty) * s, c[2] * Math.cos(L) + (u[2] * tx + w[2] * ty) * s];
        const depth = 0.9 + rnd() * 0.1;                                  // spessore della corteccia
        // forma di cervello: allungato avanti-dietro, emisferi separati, base appiattita, lobi temporali
        let [x, y, z] = p;
        x = x * 0.86 + Math.sign(x) * 0.07;
        z = z * 1.18;
        y = y * 0.82; if (y < -0.25) y = -0.25 + (y + 0.25) * 0.55;
        if (y < 0 && Math.abs(z) < 0.5) x *= 1.06;
        pos[i * 3] = x * depth; pos[i * 3 + 1] = y * depth; pos[i * 3 + 2] = z * depth;
      });
      await tick();
    }

    // --- sinapsi: per ogni neurone i 3 più simili tra un campione della stessa regione
    const links = [];
    const members = Array.from({ length: R }, () => []); for (let i = 0; i < N; i++) members[assign[i]].push(i);
    for (let i = 0; i < N; i++) {
      const m = members[assign[i]];
      const cand = m.length <= 160 ? m : Array.from({ length: 160 }, () => m[Math.floor(rnd() * m.length)]);
      const best = [];
      for (const j of cand) {
        if (j === i) continue;
        const s = dot(V[i], V[j]);
        if (best.length < 3) { best.push([j, s]); best.sort((a, b) => b[1] - a[1]); }
        else if (s > best[2][1]) { best[2] = [j, s]; best.sort((a, b) => b[1] - a[1]); }
      }
      for (const [j] of best) links.push(i, j);
      if ((i & 31) === 31) await breathe();
    }

    // --- documenti: posizione media dei loro frammenti, e legami tra documenti simili
    const docs = [];
    for (const [d, idx] of byDoc) {
      let x = 0, y = 0, z = 0; const mv = new Float32Array(D);
      for (const i of idx) { x += pos[i * 3]; y += pos[i * 3 + 1]; z += pos[i * 3 + 2]; for (let j = 0; j < D; j++) mv[j] += V[i][j]; }
      const n = Math.hypot(x, y, z) || 1;
      let nm = 0; for (const v of mv) nm += v * v; nm = Math.sqrt(nm) || 1;
      const reg = new Map(); for (const i of idx) reg.set(assign[i], (reg.get(assign[i]) || 0) + 1);
      docs.push({ id: d, p: [x / n * 1.04, y / n * 1.04, z / n * 1.04], n: idx.length, r: [...reg].sort((a, b) => b[1] - a[1])[0][0], v: mv.map(v => v / nm) });
    }
    const dlinks = [];
    docs.forEach((a, ia) => {
      const best = docs.map((b, ib) => [ib, ib === ia ? -9 : dot(a.v, b.v)]).sort((x, y) => y[1] - x[1]).slice(0, 3);
      for (const [ib, s] of best) if (s > 0.3 && ia < ib) dlinks.push(ia, ib, Math.round(s * 100));
    });

    // --- nomi delle regioni
    const regions = await nameRegions(R, assign, rsize, dirs);
    E.graph = {
      n: N, ids: E.chunks.map(c => c.id), pos, region: Array.from(assign), links: Uint32Array.from(links), real: useReal,
      regions, docs: docs.map(({ v, ...d }) => d), dlinks, t: now(),
    };
    await db.kset('graph', E.graph);
  } finally { building = false; E.busy = ''; emit(); }
}

async function keywords(R, assign) {
  // parole tipiche di ogni regione rispetto a tutto il cervello (su un campione, a piccoli pezzi)
  const df = new Map(), rdf = Array.from({ length: R }, () => new Map()), rn = new Int32Array(R);
  const step = Math.max(1, Math.floor(E.chunks.length / 3000));
  let N = 0;
  for (let i = 0; i < E.chunks.length; i += step) {
    const c = E.chunks[i];
    const ws = new Set(words(c.text).filter(w => w.length >= 4 && !/^\d+$/.test(w)));
    rn[assign[i]]++; N++;
    for (const w of ws) { df.set(w, (df.get(w) || 0) + 1); rdf[assign[i]].set(w, (rdf[assign[i]].get(w) || 0) + 1); }
    if ((N & 63) === 0) await breathe();
  }
  return rdf.map((m, r) => [...m].filter(([, n]) => n >= Math.max(2, rn[r] * 0.08))
    .map(([w, n]) => [w, (n / rn[r]) * Math.log(N / df.get(w))]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]));
}
const pretty = s => s.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase()).slice(0, 40);

async function nameRegions(R, assign, rsize, dirs) {
  const kw = await keywords(R, assign);
  const out = [];
  const used = new Map();
  for (let r = 0; r < R; r++) {
    const docsIn = new Map(), racc = new Map();
    E.chunks.forEach((c, i) => { if (assign[i] !== r) return; docsIn.set(c.doc, (docsIn.get(c.doc) || 0) + 1); const ra = E.docs.get(c.doc)?.raccolta; if (ra) racc.set(ra, (racc.get(ra) || 0) + 1); });
    const main = [...docsIn].sort((a, b) => b[1] - a[1])[0]?.[0];
    const firma = main || 'r' + r;
    const generic = new Set(['Dal Drive', 'Dal PC', 'Miei file', 'Note', 'Risposte salvate']);
    const topR = [...racc].sort((a, b) => b[1] - a[1])[0];
    let nome, fonte;
    if (E.regionNames[firma]?.utente) { nome = E.regionNames[firma].nome; fonte = 'tuo'; }
    else if (E.regionNames[firma]?.ai) { nome = E.regionNames[firma].nome; fonte = 'AI'; }
    else if (topR && !generic.has(topR[0]) && topR[1] >= rsize[r] * 0.6) { nome = topR[0]; fonte = 'raccolta'; }
    else if (main) { nome = pretty(E.docs.get(main)?.nome || ''); fonte = 'file'; }
    if (!nome) { nome = kw[r].slice(0, 2).join(' · ') || `Regione ${r + 1}`; fonte = 'parole'; }
    const k = used.get(nome) || 0; used.set(nome, k + 1);
    if (k) nome = `${nome} · ${kw[r][k - 1] || k + 1}`;
    out.push({ id: r, nome, fonte, firma, colore: PALETTE[r % PALETTE.length], n: rsize[r], parole: kw[r], dir: dirs[r],
      file: [...docsIn].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d]) => E.docs.get(d)?.nome || '') });
  }
  return out;
}

export async function renameRegion(firma, nome) {
  E.regionNames[firma] = nome ? { nome, utente: true } : undefined;
  if (!nome) delete E.regionNames[firma];
  await db.kset('regionNames', E.regionNames);
  for (const r of E.graph?.regions || []) if (r.firma === firma) { r.nome = nome || r.nome; r.fonte = nome ? 'tuo' : r.fonte; }
  await db.kset('graph', E.graph); emit();
}
export async function aiNameRegions() {
  const regs = (E.graph?.regions || []).filter(r => r.fonte !== 'tuo');
  if (!regs.length) return 0;
  const lista = regs.map(r => `${r.id}: file = ${r.file.slice(0, 4).join('; ')} | parole = ${r.parole.join(', ')}`).join('\n');
  const res = await ai.generate(`Dai un nome breve (2-4 parole, in italiano, stile "Analisi matematica", "Reti neurali") a ogni regione ` +
    `del cervello di uno studente, in base ai file e alle parole tipiche. Rispondi in JSON: {"nomi": {"<id>": "<nome>"}}.\n\n${lista}`, { json: true });
  const nomi = res.json?.nomi || {};
  let n = 0;
  for (const r of regs) {
    const v = String(nomi[r.id] || '').trim();
    if (v.length < 3 || v.length > 48) continue;
    E.regionNames[r.firma] = { nome: v, ai: true }; r.nome = v; r.fonte = 'AI'; n++;
  }
  await db.kset('regionNames', E.regionNames); await db.kset('graph', E.graph); emit();
  return n;
}

export async function wipe() { for (const s of ['docs', 'chunks', 'chats', 'mycards', 'mynotes']) await db.clear(s); }
