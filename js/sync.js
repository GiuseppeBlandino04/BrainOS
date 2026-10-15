// Cuore dell'app del telefono: stato locale, diario degli eventi, coda "Da inviare" e
// sincronizzazione con il Drive. Tutto funziona offline; la rete serve solo per scambiare dati.
import * as db from './db.js';
import * as drive from './drive.js';
import { review as srsReview } from './srs.js';

const ROOT = 'BrainOS';
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16));
const now = () => Date.now() / 1000;

export const S = {
  device: null, settings: {}, pack: null, events: [], uploads: [], materials: [],
  cards: [], notes: [], lastSync: 0, syncing: false, error: null, needLogin: false, progress: '',
};
const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => { try { fn(S); } catch (e) { console.error(e); } });

// ------------------------------------------------------------------ avvio
export async function init() {
  S.device = await db.kget('device');
  if (!S.device) { S.device = 'tel-' + uid().slice(0, 8); await db.kset('device', S.device); }
  S.settings = { clientId: '', autoPc: true, autoSync: true, pcPack: true, autoBrain: true, ...(await db.kget('settings', {})) };
  const cfgCid = globalThis.BRAINOS_CONFIG?.clientId;
  if (!S.settings.clientId && cfgCid) S.settings.clientId = cfgCid;
  const m = (globalThis.location?.hash || '').match(/cid=([^&]+)/);   // dal QR code del PC
  if (m) { S.settings.clientId = decodeURIComponent(m[1]); history.replaceState?.(null, '', location.pathname); }
  await db.kset('settings', S.settings);
  S.pack = await db.kget('pack');
  S.lastSync = await db.kget('lastSync', 0);
  await drive.loadToken();
  await reload();
}

export async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  await db.kset('settings', S.settings);
  if ('pcPack' in patch) recompute();
  emit();
}

async function reload() {
  S.events = (await db.all('events')).sort((a, b) => a.seq - b.seq);
  S.uploads = await db.all('uploads');
  S.materials = (await db.all('materials')).map(({ blob, ...m }) => m);    // senza i contenuti (leggero)
  recompute();
  emit();
}

export async function log(testo) {
  await db.put('log', { t: now(), testo });
  const all = await db.all('log');
  if (all.length > 200) for (const r of all.sort((a, b) => a.id - b.id).slice(0, all.length - 200)) await db.del('log', r.id);
}
export const logEntries = async () => (await db.all('log')).sort((a, b) => b.id - a.id);

// ----------------------------------------------- carte e note (pacchetto + modifiche locali)
const confirmed = () => (S.pack?.elaborati?.[S.device]) || 0;

function recompute() {
  const pack = (S.settings.pcPack === false ? { elaborati: S.pack?.elaborati, carte_telefono: S.pack?.carte_telefono, note_telefono: S.pack?.note_telefono } : S.pack) || {};
  const map = new Map((pack.carte || []).map(c => [String(c.id), { ...c }]));
  const phoneMap = pack.carte_telefono || {};
  const pending = S.events.filter(e => e.seq > confirmed());
  // flashcard create sul telefono e non ancora nel pacchetto
  for (const e of pending) {
    if (e.tipo === 'carta' && !phoneMap[e.id] && !e.copia) {
      map.set('u:' + e.id, { id: 'u:' + e.id, domanda: e.domanda, opzioni: [e.risposta], corretta: 0, spiegazione: e.nota || '',
        doc: 'Dal telefono', loc: '', regione: -1, regione_nome: 'Dal telefono', reps: 0, ease: 2.5, interval: 0, due: 0,
        lapses: 0, creata: e.t, locale: true });
    }
  }
  // ripassi fatti qui e non ancora applicati dal PC
  for (const e of pending) {
    if (e.tipo !== 'ripasso') continue;
    let id = String(e.carta);
    if (id.startsWith('u:') && phoneMap[id.slice(2)]) id = String(phoneMap[id.slice(2)]);
    const c = map.get(id);
    if (c) map.set(id, srsReview(c, e.voto, e.t));
  }
  S.cards = [...map.values()];

  // note: quelle del PC + modifiche e note nuove fatte qui
  const notes = new Map((pack.note || []).map(n => [n.path, { ...n, key: n.path }]));
  const noteMap = pack.note_telefono || {};
  const latest = new Map();
  for (const e of pending) if (e.tipo === 'nota') latest.set(e.id, e);
  for (const e of latest.values()) {
    const path = e.path || noteMap[e.id];
    if (path && notes.has(path)) Object.assign(notes.get(path), { titolo: e.titolo, testo: e.testo, modificata: e.t, inAttesa: true, id: e.id });
    else notes.set('u:' + e.id, { key: 'u:' + e.id, id: e.id, titolo: e.titolo, testo: e.testo, modificata: e.t, inAttesa: true, locale: true });
  }
  S.notes = [...notes.values()].sort((a, b) => (b.modificata || 0) - (a.modificata || 0));
}

// ------------------------------------------------------------------ eventi
export async function addEvent(ev) {
  const seq = (await db.kget('seq', 0)) + 1;
  await db.kset('seq', seq);
  const e = { ...ev, seq, t: ev.t || now(), inviato: false };
  await db.put('events', e);
  S.events.push(e);
  recompute(); emit();
  scheduleSync();
  return e;
}
export const reviewCard = (card, grade) => addEvent({ tipo: 'ripasso', carta: card.id, voto: grade });
export const newCard = (domanda, risposta, nota = '', extra = {}) => addEvent({ tipo: 'carta', id: uid(), domanda, risposta, nota, ...extra });
export async function setMaterialRaccolta(id, raccolta) {
  const m = await db.get('materials', id); if (!m) return;
  m.raccolta = raccolta; await db.put('materials', m); await reload();
}
export function saveNote(note, titolo, testo) {
  // note = null (nuova) | nota esistente (del PC o del telefono)
  const id = note?.id || uid();
  const path = note && !note.locale ? note.path : undefined;
  return addEvent({ tipo: 'nota', id, path, titolo, testo });
}

// ---------------------------------------------------------------- materiale
const kindOf = (name, mime = '') => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'immagine';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'opus'].includes(ext)) return 'audio';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['docx'].includes(ext)) return 'word';
  if (['xlsx', 'xlsm', 'csv', 'tsv'].includes(ext)) return 'tabella';
  if (['pptx'].includes(ext)) return 'presentazione';
  if (['md', 'txt', 'tex', 'json', 'py', 'js', 'java', 'c', 'cpp', 'html', 'css', 'log'].includes(ext) || mime.startsWith('text/')) return 'testo';
  return 'file';
};
export { kindOf };

export async function getMaterialBlob(id) { return (await db.get('materials', id))?.blob || null; }

export async function addLocalFile(blob, name, mime, { toPc = true, raccolta = '' } = {}) {
  const id = uid();
  const m = { id, nome: name, mime: mime || blob.type || '', size: blob.size, fonte: 'telefono', blob, t: now(),
    al_pc: toPc ? 'in coda' : false, aperto: 0, ...(raccolta ? { raccolta } : {}) };
  await db.put('materials', m);
  if (toPc) await db.put('uploads', { id, nome: name, mime: m.mime, size: blob.size, blob, t: now(), materiale: id });
  await reload(); scheduleSync();
  return id;
}

export async function sendMaterialToPc(id) {
  const m = await db.get('materials', id);
  if (!m || m.al_pc) return;
  if (m.fonte === 'drive' && m.drive_id) {
    await addEvent({ tipo: 'importa', id: uid(), nome: m.nome, drive_id: m.drive_id, mime: m.drive_mime || null });
  } else if (m.fonte === 'telefono') {
    await db.put('uploads', { id: m.id, nome: m.nome, mime: m.mime, size: m.size, blob: m.blob, t: now(), materiale: m.id });
  } else return;
  m.al_pc = 'in coda'; await db.put('materials', m);
  await reload(); scheduleSync();
}

export async function deleteMaterial(id) {
  await db.del('materials', id);
  await reload();
}
export async function touchMaterial(id) {
  const m = await db.get('materials', id);
  if (m) { m.aperto = now(); await db.put('materials', m); }
}

// Importa dal Drive: scarica per l'offline ed eventualmente chiede al PC di aggiungerlo al cervello
export async function importFromDrive(f, { toPc = false, onProgress } = {}) {
  const have = S.materials.find(m => m.drive_id === f.id);
  if (have && !toPc) return have.id;
  onProgress?.(`Scarico ${f.name}…`);
  const { blob, name, mime } = await drive.download(f.id, f.mimeType, f.name);
  const id = have?.id || uid();
  await db.put('materials', { id, nome: name, mime: mime || blob.type, size: blob.size, fonte: 'drive', drive_id: f.id,
    drive_mime: f.mimeType, blob, t: now(), al_pc: false, aperto: 0 });
  await log(`⬇ Scaricato dal Drive: ${name}`);
  await reload();
  if (toPc) await sendMaterialToPc(id);
  return id;
}

// ------------------------------------------------------------ coda "Da inviare"
export function outbox() {
  const items = [];
  for (const u of S.uploads) items.push({ tipo: 'file', key: 'u:' + u.id, icona: '📎', titolo: u.nome, size: u.size, t: u.t });
  const unsent = S.events.filter(e => !e.inviato);
  const reviews = unsent.filter(e => e.tipo === 'ripasso');
  if (reviews.length) items.push({ tipo: 'ripassi', key: 'ripassi', icona: '🎓', titolo: `${reviews.length} ripass${reviews.length === 1 ? 'o' : 'i'}`, t: reviews[0].t });
  for (const e of unsent) {
    if (e.tipo === 'carta') items.push({ tipo: 'carta', key: 'e:' + e.seq, icona: '🃏', titolo: e.domanda, t: e.t });
    if (e.tipo === 'nota') items.push({ tipo: 'nota', key: 'e:' + e.seq, icona: '📝', titolo: e.titolo || 'Nota', t: e.t });
    if (e.tipo === 'importa') items.push({ tipo: 'importa', key: 'e:' + e.seq, icona: '🧠', titolo: `Aggiungi al cervello: ${e.nome}`, t: e.t });
  }
  return items;
}
export const waitingPc = () => S.events.filter(e => e.inviato && e.seq > confirmed()).length;

export async function removeOutbox(item) {
  if (item.tipo === 'file') {
    const id = item.key.slice(2);
    await db.del('uploads', id);
    const m = await db.get('materials', id);
    if (m) { m.al_pc = false; await db.put('materials', m); }
  } else if (item.tipo === 'ripassi') {
    for (const e of S.events.filter(x => !x.inviato && x.tipo === 'ripasso')) await db.del('events', e.seq);
  } else {
    const seq = Number(item.key.slice(2));
    const e = S.events.find(x => x.seq === seq);
    if (e?.tipo === 'importa') {
      const m = S.materials.find(x => x.drive_id === e.drive_id);
      if (m) { const full = await db.get('materials', m.id); full.al_pc = false; await db.put('materials', full); }
    }
    await db.del('events', seq);
  }
  await reload();
}

// --------------------------------------------------------------- sincronizzazione
let timer = null;
export function scheduleSync(delay = 2500) {
  clearTimeout(timer);
  if (!S.settings.autoSync) return;
  timer = setTimeout(() => sync().catch(() => {}), delay);
}

const ids = {};
async function fld(...path) {
  const key = path.join('/');
  if (!ids[key]) {
    let parent = 'root';
    for (let k = 0; k < path.length; k++) {
      const sub = path.slice(0, k + 1).join('/');
      if (!ids[sub]) ids[sub] = await drive.folder(path[k], parent);
      parent = ids[sub];
    }
  }
  return ids[key];
}

export async function sync({ interactive = false } = {}) {
  if (S.syncing) return;
  if (globalThis.navigator && navigator.onLine === false) { S.error = 'Sei offline: invio appena torna la connessione'; emit(); return; }
  if (!drive.hasValidToken()) {
    if (!interactive) { S.needLogin = true; emit(); return; }
    await drive.login(S.settings.clientId);
  }
  S.syncing = true; S.error = null; S.needLogin = false; emit();
  const step = t => { S.progress = t; emit(); };
  try {
    await fld(ROOT, 'pacchetto');
    // 1) file del telefono → in-arrivo (poi l'evento "file" dice al PC di prenderli)
    for (const u of await db.all('uploads')) {
      step(`Invio ${u.nome}…`);
      const r = await drive.upload(await fld(ROOT, 'in-arrivo', S.device), u.nome, u.blob, u.mime);
      await db.del('uploads', u.id);
      const m = await db.get('materials', u.materiale);
      if (m) { m.al_pc = 'inviato'; await db.put('materials', m); }
      S.uploads = S.uploads.filter(x => x.id !== u.id);
      await addEventRaw({ tipo: 'file', id: u.id, nome: u.nome, drive_id: r.id });
      await log(`📎 Inviato: ${u.nome}`);
    }
    // 2) diario degli eventi non ancora inviati
    const unsent = (await db.all('events')).filter(e => !e.inviato).sort((a, b) => a.seq - b.seq);
    for (let k = 0; k < unsent.length; k += 500) {
      const batch = unsent.slice(k, k + 500);
      step(`Invio ${batch.length} modifiche…`);
      const name = `${String(batch[0].seq).padStart(6, '0')}-${String(batch.at(-1).seq).padStart(6, '0')}-${Date.now()}.json`;
      const body = JSON.stringify({ dispositivo: S.device, eventi: batch.map(({ inviato, ...e }) => e) });
      await drive.upload(await fld(ROOT, 'eventi', S.device), name, new Blob([body], { type: 'application/json' }), 'application/json');
      for (const e of batch) { e.inviato = true; await db.put('events', e); }
      for (const e of batch.filter(x => x.tipo === 'importa' || x.tipo === 'file')) {
        const m = (await db.all('materials')).find(x => (e.tipo === 'importa' ? x.drive_id === e.drive_id : x.id === e.id));
        if (m) { m.al_pc = 'inviato'; m.evento = e.seq; await db.put('materials', m); }
      }
      const kinds = {};
      batch.forEach(e => { kinds[e.tipo] = (kinds[e.tipo] || 0) + 1; });
      await log('☁ Inviato: ' + Object.entries(kinds).map(([t, n]) => `${n} ${t}`).join(', '));
    }
    // 3) pacchetto del PC
    step('Controllo gli aggiornamenti del PC…');
    const pf = (await drive.list(`name='studio.json' and '${await fld(ROOT, 'pacchetto')}' in parents and trashed=false`))[0];
    if (pf) {
      const sig = `${pf.modifiedTime}|${pf.size}`;
      if (sig !== await db.kget('packSig') || !S.pack) {
        step('Scarico il pacchetto di studio…');
        const pack = await drive.readJson(pf.id);
        S.pack = pack;
        await db.kset('pack', pack); await db.kset('packSig', sig);
        // gli eventi confermati dal PC non servono più
        for (const e of await db.all('events')) if (e.seq <= confirmed() && e.inviato) await db.del('events', e.seq);
        for (const m of await db.all('materials')) {
          if (m.al_pc === 'inviato' && m.evento && m.evento <= confirmed()) { m.al_pc = 'nel PC'; await db.put('materials', m); }
        }
        await log(`📦 Dal PC: ${pack.carte?.length || 0} carte, ${pack.riassunti?.length || 0} riassunti, ${pack.note?.length || 0} note`);
      }
      // 4) materiale che il PC ha mandato al telefono
      const wanted = new Map((S.pack?.materiali || []).map(m => [m.drive_id, m]));
      for (const m of S.materials.filter(x => x.fonte === 'pc' && !wanted.has(x.drive_id))) {
        await db.del('materials', m.id); await log(`🗑 Tolto dal PC: ${m.nome}`);
      }
      if (S.settings.autoPc) {
        for (const pm of wanted.values()) {
          const have = S.materials.find(x => x.drive_id === pm.drive_id);
          if (have && (have.pc_t || 0) >= pm.t) continue;
          step(`Scarico dal PC: ${pm.nome}…`);
          const { blob, name, mime } = await drive.download(pm.drive_id, 'application/octet-stream', pm.nome);
          await db.put('materials', { id: have?.id || uid(), nome: name, mime: mimeFromName(name, mime), size: blob.size, fonte: 'pc',
            drive_id: pm.drive_id, path: pm.path, blob, t: now(), pc_t: pm.t, al_pc: false, aperto: have?.aperto || 0 });
          await log(`📱 Dal PC: ${name}`);
        }
      }
    }
    S.lastSync = now(); await db.kset('lastSync', S.lastSync);
  } catch (e) {
    if (e instanceof drive.NeedLogin) S.needLogin = true;
    else { S.error = e.message || String(e); await log('⚠ ' + S.error); }
    for (const k of Object.keys(ids)) delete ids[k];
  } finally {
    S.syncing = false; S.progress = '';
    await reload();
  }
}
async function addEventRaw(ev) {   // come addEvent, ma senza far ripartire la sincronizzazione
  const seq = (await db.kget('seq', 0)) + 1;
  await db.kset('seq', seq);
  await db.put('events', { ...ev, seq, t: now(), inviato: false });
}
function mimeFromName(name, mime) {
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = name.split('.').pop().toLowerCase();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    mp4: 'video/mp4', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }[ext] || 'application/octet-stream';
}

// ------------------------------------------------------------------- ricerca
export function searchAll(text) {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const c of S.cards) if ((c.domanda + ' ' + (c.opzioni?.[c.corretta] || '')).toLowerCase().includes(q)) out.push({ tipo: 'carta', c });
  for (const n of S.notes) if ((n.titolo + ' ' + n.testo).toLowerCase().includes(q)) out.push({ tipo: 'nota', n });
  for (const r of S.pack?.riassunti || []) if ((r.nome + ' ' + r.testo).toLowerCase().includes(q)) out.push({ tipo: 'riassunto', r });
  for (const m of S.materials) if (m.nome.toLowerCase().includes(q)) out.push({ tipo: 'materiale', m });
  return out.slice(0, 80);
}

export async function storageInfo() {
  try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
}
export async function wipe() {
  for (const s of ['kv', 'events', 'uploads', 'materials', 'log']) await db.clear(s);
}
