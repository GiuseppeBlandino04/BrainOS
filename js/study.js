// Contenuti propri del telefono: carte (quiz e flashcard) e note, generate dall'AI o scritte a mano.
// Restano sul telefono; si possono mandare al Drive (cartella BrainOS/Condivisi) o esportare come file,
// e importare da lì sul telefono o sul PC.
import * as db from './db.js';
import * as ai from './ai.js';
import * as drive from './drive.js';
import { review } from './srs.js';
import { E, regionOf, addText, removeByRef } from './engine.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16));
const now = () => Date.now() / 1000;

export const M = { cards: [], notes: [] };
export async function load() {
  M.cards = await db.all('mycards');
  M.notes = (await db.all('mynotes')).sort((a, b) => b.modificata - a.modificata);
}

// ----------------------------------------------------------------- carte
function newCard(c) {
  return { id: uid(), domanda: c.domanda, opzioni: c.opzioni, corretta: c.corretta ?? 0, spiegazione: c.spiegazione || '',
    doc: c.doc || '', docId: c.docId || null, loc: c.loc || '', chunk: c.chunk || null, regione_nome: c.regione_nome || 'Mie carte',
    raccolta: c.raccolta || '', reps: 0, ease: 2.5, interval: 0, due: 0, lapses: 0, creata: now(), mia: true, origine: c.origine || 'telefono' };
}
const key = c => (c.domanda + '|' + (c.opzioni?.[c.corretta] || '')).toLowerCase().replace(/\s+/g, ' ').trim();

export async function addCards(list) {
  const have = new Set(M.cards.map(key));
  const fresh = list.map(newCard).filter(c => c.domanda && c.opzioni?.length && !have.has(key(c)));
  await db.putMany('mycards', fresh);
  M.cards.push(...fresh);
  return fresh;
}
export async function reviewMine(card, grade) {
  const c = M.cards.find(x => x.id === card.id); if (!c) return;
  Object.assign(c, review(c, grade, now()));
  await db.put('mycards', c);
}
export async function deleteCards(ids) {
  const s = new Set(ids);
  for (const id of s) await db.del('mycards', id);
  M.cards = M.cards.filter(c => !s.has(c.id));
}

// Genera quiz o flashcard dall'AI. ambito: { doc?, raccolta?, regione?, tutto? }; tipo: 'quiz' | 'flashcard'
export async function generate(ambito, n = 8, tipo = 'quiz') {
  let idx = E.chunks.map((c, i) => i).filter(i => {
    const c = E.chunks[i], d = E.docs.get(c.doc);
    if (ambito.doc && c.doc !== ambito.doc) return false;
    if (ambito.raccolta && d?.raccolta !== ambito.raccolta) return false;
    if (ambito.regione !== undefined && regionOf(c.id) !== ambito.regione) return false;
    return c.text.length > 160;
  });
  if (!idx.length) throw new Error('Non ci sono abbastanza testi in questo ambito');
  const usedChunks = new Set(M.cards.map(c => c.chunk));
  const fresh = idx.filter(i => !usedChunks.has(E.chunks[i].id));
  if (fresh.length >= Math.min(4, idx.length)) idx = fresh;
  // passaggi a caso, preferendo quelli lunghi
  idx.sort(() => Math.random() - 0.5);
  const pick = idx.sort((a, b) => E.chunks[b].text.length * Math.random() - E.chunks[a].text.length * Math.random()).slice(0, Math.min(idx.length, Math.max(3, Math.ceil(n * 0.75))));
  const ctx = pick.map((i, k) => { const c = E.chunks[i]; return `[${k + 1}] ${E.docs.get(c.doc)?.nome || ''}${c.loc ? ' — ' + c.loc : ''}\n${c.text.slice(0, 1400)}`; }).join('\n\n');
  const formato = tipo === 'quiz'
    ? '{"domande":[{"domanda":"…","opzioni":["…","…","…","…"],"corretta":0,"spiegazione":"…","fonte":1}]} — 4 opzioni plausibili, una sola corretta (indice da 0)'
    : '{"domande":[{"domanda":"…","risposta":"…","spiegazione":"…","fonte":1}]} — risposte brevi e precise';
  const res = await ai.generate(`Crea ${n} ${tipo === 'quiz' ? 'domande a scelta multipla' : 'flashcard (domanda e risposta)'} in italiano per ` +
    `verificare la comprensione di questi passaggi degli appunti di uno studente. Domande che fanno ragionare, non banali; ` +
    `formule in LaTeX tra $...$. "fonte" è il numero del passaggio usato. Rispondi solo in JSON: ${formato}\n\n${ctx}`, { json: true, temperature: 0.7 });
  const qs = (res.json?.domande || []).filter(q => q.domanda);
  const out = [];
  for (const q of qs) {
    const src = pick[(+q.fonte || 1) - 1] ?? pick[0];
    const c = E.chunks[src], d = E.docs.get(c.doc);
    const r = regionOf(c.id), reg = E.graph?.regions?.[r];
    const opts = tipo === 'quiz' ? (q.opzioni || []).map(String).slice(0, 5) : [String(q.risposta || '')];
    if (!opts.length || !opts[0]) continue;
    out.push({ domanda: q.domanda, opzioni: opts, corretta: tipo === 'quiz' ? Math.max(0, Math.min(opts.length - 1, +q.corretta || 0)) : 0,
      spiegazione: q.spiegazione || '', doc: d?.nome || '', docId: d?.id, loc: c.loc, chunk: c.id,
      regione_nome: reg?.nome || d?.raccolta || 'Mie carte', raccolta: d?.raccolta || '', origine: 'AI' });
  }
  if (!out.length) throw new Error("L'AI non ha creato domande valide: riprova");
  return addCards(out);
}

// ------------------------------------------------------------------ note
export async function saveNote(note, titolo, testo) {
  const n = note?.mia ? M.notes.find(x => x.id === note.id) : null;
  const rec = n || { id: uid(), creata: now(), mia: true };
  Object.assign(rec, { titolo, testo, modificata: now() });
  await db.put('mynotes', rec);
  if (!n) M.notes.unshift(rec);
  M.notes.sort((a, b) => b.modificata - a.modificata);
  await addText('nota', rec.id, titolo, `# ${titolo}\n\n${testo}`, 'Note');
  return rec;
}
export async function deleteNote(id) {
  await db.del('mynotes', id); M.notes = M.notes.filter(n => n.id !== id);
  await removeByRef('nota', id);
}

// ------------------------------------------------- condivisione: pacchetti e file
// Formato comune a telefono e PC: *.brainos.json nella cartella del Drive BrainOS/Condivisi
export function pack(titolo, { carte = [], note = [] } = {}) {
  return {
    formato: 'brainos-condiviso', versione: 1, titolo, creato: now(), da: 'telefono',
    carte: carte.map(c => ({ domanda: c.domanda, opzioni: c.opzioni, corretta: c.corretta, spiegazione: c.spiegazione || '', doc: c.doc || '', loc: c.loc || '', argomento: c.regione_nome || '' })),
    note: note.map(n => ({ titolo: n.titolo, testo: n.testo })),
  };
}
const csvCell = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
export function toCsv(p) {      // importabile in Anki (domanda;risposta;spiegazione;argomento)
  return '﻿' + p.carte.map(c => [c.domanda, c.opzioni[c.corretta] ?? '', c.spiegazione, c.argomento].map(csvCell).join(';')).join('\n');
}
export function toMd(p) {
  let s = `# ${p.titolo}\n\n`;
  p.carte.forEach((c, k) => {
    s += `## ${k + 1}. ${c.domanda}\n\n`;
    if (c.opzioni.length > 1) s += c.opzioni.map((o, j) => `${j === c.corretta ? '- **✔ ' + o + '**' : '- ' + o}`).join('\n') + '\n\n';
    else s += `**Risposta:** ${c.opzioni[0]}\n\n`;
    if (c.spiegazione) s += `> ${c.spiegazione}\n\n`;
  });
  for (const n of p.note) s += `## ${n.titolo}\n\n${n.testo}\n\n`;
  return s;
}
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'BrainOS';

export function files(p) {
  const base = safeName(p.titolo);
  const out = [new File([JSON.stringify(p, null, 1)], `${base}.brainos.json`, { type: 'application/json' })];
  if (p.carte.length) out.push(new File([toCsv(p)], `${base} (Anki).csv`, { type: 'text/csv' }));
  out.push(new File([toMd(p)], `${base}.md`, { type: 'text/markdown' }));
  return out;
}

let sharedId = null;
export async function sharedFolder() {
  if (!sharedId) sharedId = await drive.folder('Condivisi', await drive.folder('BrainOS'));
  return sharedId;
}
export async function toDrive(p) {
  const dir = await sharedFolder();
  for (const f of files(p)) await drive.upload(dir, f.name, f, f.type);
}
export async function fileToDrive(blob, name, mime) {
  return drive.upload(await sharedFolder(), name, blob, mime || blob.type || 'application/octet-stream');
}
export async function listShared() {
  const dir = await sharedFolder();
  return drive.children(dir);
}
export const isPack = name => /\.brainos\.json$/i.test(name);

// importa un pacchetto (oggetto già letto)
export async function importPack(p) {
  if (p?.formato !== 'brainos-condiviso') throw new Error('Non è un pacchetto di BrainOS');
  const carte = await addCards((p.carte || []).map(c => ({ ...c, opzioni: (c.opzioni || []).map(String), regione_nome: c.argomento || p.titolo, raccolta: p.titolo, origine: 'importata' })));
  let note = 0;
  for (const n of p.note || []) {
    if (M.notes.some(x => x.titolo === n.titolo && x.testo === n.testo)) continue;   // già importata
    await saveNote(null, n.titolo, n.testo); note++;
  }
  return { carte: carte.length, note };
}
