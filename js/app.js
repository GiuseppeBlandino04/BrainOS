// BrainOS sul telefono: un BrainOS completo e autonomo (cervello 3D, domande con fonti, studio),
// che scambia materiale e contenuti con il PC attraverso il Drive solo quando lo chiedi tu.
import * as sync from './sync.js';
import * as drive from './drive.js';
import * as ai from './ai.js';
import * as eng from './engine.js';
import * as asker from './ask.js';
import * as study from './study.js';
import * as db from './db.js';
import { isDue, isNew, whenLabel, review as srsPreview } from './srs.js';
import { show as showMaterial, shareFile, renderMd, mathIn, script, LIBS } from './viewer.js';
import { readable } from './extract.js';

const S = sync.S, E = eng.E, M = study.M;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => Number(n || 0).toLocaleString('it-IT');
const fmtSize = b => { b = +b || 0; return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; };
const ago = t => {
  if (!t) return 'mai';
  const s = Math.round(Date.now() / 1000 - t);
  if (s < 60) return 'adesso';
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  return new Date(t * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
};
const plural = (n, a, b) => `${fmtN(n)} ${n === 1 ? a : b}`;
const KIND_ICON = { pdf: '📕', immagine: '🖼', audio: '🎧', video: '🎬', word: '📘', tabella: '📊', presentazione: '📙', testo: '📄', file: '📎' };
const iconOf = m => (drive.GOOGLE_EXPORT[m.mime] ? (m.mime.includes('spreadsheet') ? '📊' : '📕') : KIND_ICON[sync.kindOf(m.nome, m.mime)] || '📎');

let tab = 'oggi';
let studioSeg = 'ripasso';
let matFilter = 'tutti';

// ------------------------------------------------------------- utilità UI
let toastT;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
function sheet(html, bind) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  $('#sheetBody').parentElement.scrollTop = 0;
  bind?.($('#sheetBody'));
  mathIn($('#sheetBody'));
}
const closeSheet = () => $('#sheet').classList.add('hidden');
$('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };

const screens = [];
function openScreen(render) {
  closeSheet();
  screens.push(render);
  history.pushState({ s: screens.length }, '');
  drawScreen();
}
function drawScreen() {
  const el = $('#screen');
  if (!screens.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  screens.at(-1)(el);
}
function closeScreen() { if (screens.length) history.back(); }
function replaceScreen(render) { screens[screens.length - 1] = render; drawScreen(); }
addEventListener('popstate', () => {
  if (!$('#sheet').classList.contains('hidden')) { closeSheet(); history.pushState({ s: screens.length }, ''); return; }
  if (screens.length) { screens.pop(); drawScreen(); if (!screens.length) render(); }
});
function head(title, sub = '', extra = '') {
  return `<div class="screen-head"><button class="back" data-back>←</button>
    <div class="ttl"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>${extra}</div>`;
}
function bindBack(el) { el.querySelectorAll('[data-back]').forEach(b => b.onclick = closeScreen); }
const busy = async (btn, fn) => { const t = btn.innerHTML; btn.disabled = true; btn.innerHTML = '⏳ ' + btn.textContent.replace(/^\W+\s*/, ''); try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = t; } };

// tutte le carte: quelle mandate dal PC + le mie
const allCards = () => [...S.cards, ...M.cards];
async function reviewCard(c, g) { if (c.mia) await study.reviewMine(c, g); else await sync.reviewCard(c, g); }

// ------------------------------------------------------------- barra e schede
function updateChrome() {
  const chip = $('#syncChip');
  const out = sync.outbox().length;
  chip.className = 'sync-chip';
  let txt;
  if (E.busy) { chip.classList.add('busy'); txt = E.busy; }
  else if (S.syncing) { chip.classList.add('busy'); txt = S.progress || 'Sincronizzo…'; }
  else if (!navigator.onLine) { chip.classList.add('off'); txt = 'Offline'; }
  else if (!ai.available()) { chip.classList.add('warn'); txt = 'Collega l\'AI'; }
  else if (out) { chip.classList.add('warn'); txt = `${out} da inviare`; }
  else { chip.classList.add('ok'); txt = `${fmtN(E.docs.size)} documenti`; }
  $('#syncText').textContent = txt;
  const due = allCards().filter(c => isDue(c)).length;
  $('#dueN').textContent = due; $('#dueN').classList.toggle('hidden', !due);
}
$('#syncChip').onclick = () => (E.busy ? brainStatus() : !ai.available() ? openSettings() : openSyncScreen());
$('#gear').onclick = () => openSettings();
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
function go(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#brainHost').classList.toggle('hidden', t !== 'cervello');
  $('#view').classList.toggle('hidden', t === 'cervello' || t === 'chiedi');
  $('#chatHost').classList.toggle('hidden', t !== 'chiedi');
  if (t === 'cervello') view?.resume(); else view?.pause();   // il 3D lavora solo quando lo guardi
  render(); scrollTo(0, 0);
}
function render() {
  updateChrome();
  if (tab === 'cervello') return renderBrain();
  if (tab === 'chiedi') return renderChat();
  const v = $('#view');
  ({ oggi: renderToday, studio: renderStudy, materiale: renderMaterials })[tab](v);
}

async function doSync(interactive = false) {
  if (!S.settings.clientId) { openSyncScreen(); toast('Inserisci prima il Client ID'); return; }
  if (!navigator.onLine) { toast('Sei offline: invierò tutto appena torna la connessione'); return; }
  try {
    await sync.sync({ interactive });
    if (S.error) toast('⚠ ' + S.error, 4000);
    else if (!S.needLogin && interactive) toast('✅ Sincronizzato');
  } catch (e) { toast('⚠ ' + e.message, 4000); }
}
async function ensureLogin() {
  if (drive.hasValidToken()) return true;
  if (!S.settings.clientId) { toast('Prima collega il Drive (⚙ → Sincronizzazione con il PC)'); openSyncScreen(); return false; }
  if (!navigator.onLine) { toast('Serve la connessione'); return false; }
  try { await drive.login(S.settings.clientId); updateChrome(); return true; } catch (e) { toast('⚠ ' + e.message, 4000); return false; }
}

function brainStatus() {
  const d = [...E.docs.values()];
  const wait = d.filter(x => x.stato === 'attesa rete'), errs = d.filter(x => x.stato === 'errore');
  sheet(`<h3>🧠 Il cervello del telefono</h3>
    <p class="muted small">${E.busy ? esc(E.busy) : 'In pausa'}</p>
    <div class="stats"><div class="stat"><b>${fmtN(d.length)}</b><span>documenti</span></div><div class="stat"><b>${fmtN(E.chunks.length)}</b><span>frammenti</span></div>
      <div class="stat"><b>${fmtN(E.graph?.regions?.length || 0)}</b><span>regioni</span></div></div>
    ${E.queue ? `<p>📥 ${plural(E.queue, 'documento da leggere', 'documenti da leggere')}</p>` : ''}
    ${E.pendingEmbed ? `<p>🧬 ${fmtN(E.pendingEmbed)} frammenti in attesa dei significati${ai.canEmbed() ? '' : ' (serve la chiave Gemini)'}</p>` : ''}
    ${E.pendingOcr ? `<p>🔍 ${plural(E.pendingOcr, 'pagina scansionata', 'pagine scansionate')} da leggere con l'OCR</p>` : ''}
    ${wait.length ? `<p>⏳ In attesa: ${wait.map(x => esc(x.nome) + ' (' + esc(x.errore || '') + ')').join(', ')}</p>` : ''}
    ${errs.length ? `<p style="color:var(--ko)">⚠ Non letti: ${errs.map(x => esc(x.nome) + ' — ' + esc(x.errore || '')).join('<br>')}</p>` : ''}
    ${E.error ? `<p class="small muted">Ultimo avviso: ${esc(E.error)}</p>` : ''}
    <div class="acts">${errs.length ? '<button class="btn" id="bsRetry">↻ Riprova i non letti</button>' : ''}<button class="btn" id="bsRebuild">🎨 Ridisegna il cervello</button></div>`, box => {
    box.querySelector('#bsRetry')?.addEventListener('click', () => { errs.forEach(x => eng.retry(x.id)); closeSheet(); });
    box.querySelector('#bsRebuild').onclick = () => { eng.buildGraph(); closeSheet(); toast('Ridisegno…'); };
  });
}

// ------------------------------------------------------------------- OGGI
function renderToday(v) {
  const cards = allCards();
  const due = cards.filter(c => isDue(c)), nuove = cards.filter(c => isNew(c));
  const recent = [...S.materials].filter(m => m.aperto).sort((a, b) => b.aperto - a.aperto).slice(0, 3);
  const h = new Date().getHours();
  v.innerHTML = `
    <h1>${h < 12 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera'} 👋</h1>
    ${!ai.available() ? `<div class="banner"><b>Collega l'AI (gratis)</b><br>Serve per le risposte, i significati, l'OCR e la trascrizione. Basta una chiave Gemini (e se vuoi una Groq di riserva).
      <button class="btn primary block" id="tKeys">Inserisci le chiavi</button></div>` : ''}
    ${!E.docs.size ? `<div class="banner"><b>Il tuo cervello è vuoto.</b><br>Aggiungi file dal telefono o importali dal Drive: ogni documento diventa neuroni.
      <div class="row" style="margin-top:8px"><button class="btn grow" id="tAddF">📎 File</button><button class="btn primary grow" id="tAddD">📂 Dal Drive</button></div></div>` : ''}
    <form id="tAsk" class="askbox"><input id="tQ" placeholder="💬 Chiedi qualcosa al tuo cervello…" autocomplete="off"><button class="btn primary">➤</button></form>
    <div class="stats">
      <button class="stat" id="tBrain"><b>${fmtN(E.docs.size)}</b><span>documenti</span></button>
      <button class="stat" id="tDue"><b>${fmtN(due.length)}</b><span>da ripassare</span></button>
      <button class="stat" id="tNew"><b>${fmtN(nuove.length)}</b><span>domande nuove</span></button>
    </div>
    ${E.busy ? `<button class="card big" id="tBusy" style="width:100%;text-align:left"><span class="ico">⏳</span><span class="t"><b>Sto lavorando</b><span class="muted small">${esc(E.busy)}</span></span></button>` : ''}
    <input class="search" id="tSearch" placeholder="🔎 Cerca nei documenti, carte e note…" autocomplete="off">
    <div id="tResults"></div>
    <h2>Aggiungi</h2>
    <div class="tiles four">
      <button class="tile" data-n="nota"><span>📝</span><b>Nota</b></button>
      <button class="tile" data-n="carta"><span>🃏</span><b>Flashcard</b></button>
      <button class="tile" data-n="foto"><span>📷</span><b>Foto</b></button>
      <button class="tile" data-n="file"><span>📎</span><b>File</b></button>
    </div>
    ${recent.length ? `<h2>Riprendi a leggere</h2><div class="list">${recent.map(m => itemMaterial(m)).join('')}</div>` : ''}`;
  v.querySelector('#tKeys')?.addEventListener('click', openSettings);
  v.querySelector('#tAddF')?.addEventListener('click', addSheet);
  v.querySelector('#tAddD')?.addEventListener('click', openDriveBrowser);
  v.querySelector('#tBusy')?.addEventListener('click', brainStatus);
  v.querySelector('#tBrain').onclick = () => go('cervello');
  v.querySelector('#tDue').onclick = () => due.length ? startSession(due, 'Ripasso') : toast('Niente da ripassare oggi ✓');
  v.querySelector('#tNew').onclick = () => nuove.length ? startSession(nuove.slice(0, 15), 'Nuove') : (studioSeg = 'crea', go('studio'));
  v.querySelector('#tAsk').onsubmit = e => { e.preventDefault(); const q = v.querySelector('#tQ').value.trim(); if (q) { go('chiedi'); sendQuestion(q); } };
  v.querySelectorAll('[data-n]').forEach(b => b.onclick = () => addNew(b.dataset.n));
  bindMaterialItems(v);
  const res = v.querySelector('#tResults');
  v.querySelector('#tSearch').oninput = e => {
    const q = e.target.value.trim();
    if (!q) { res.innerHTML = ''; return; }
    const hits = eng.quickFind(q, 15);
    const ql = q.toLowerCase();
    const cs = cards.filter(c => (c.domanda + ' ' + (c.opzioni?.[c.corretta] || '')).toLowerCase().includes(ql)).slice(0, 8);
    const ns = allNotes().filter(n => (n.titolo + ' ' + n.testo).toLowerCase().includes(ql)).slice(0, 8);
    res.innerHTML = (hits.length || cs.length || ns.length) ? `<div class="list" style="margin:10px 0">
      ${hits.map((h, k) => `<button class="item" data-h="${k}"><span class="ico">🧠</span><span class="t"><b>${esc(h.doc?.nome)}${h.chunk.loc ? ' · ' + esc(h.chunk.loc) : ''}</b><span>${esc(snippet(h.chunk.text, q))}</span></span></button>`).join('')}
      ${cs.map((c, k) => `<button class="item" data-c="${k}"><span class="ico">🃏</span><span class="t"><b>${esc(c.domanda)}</b><span>${esc(c.regione_nome || '')}</span></span></button>`).join('')}
      ${ns.map((n, k) => `<button class="item" data-no="${k}"><span class="ico">📝</span><span class="t"><b>${esc(n.titolo)}</b><span>nota</span></span></button>`).join('')}
    </div>` : '<div class="empty">Nessun risultato</div>';
    res.querySelectorAll('[data-h]').forEach(b => b.onclick = () => openChunk(hits[+b.dataset.h].chunk));
    res.querySelectorAll('[data-c]').forEach(b => b.onclick = () => startSession([cs[+b.dataset.c]], 'Domanda'));
    res.querySelectorAll('[data-no]').forEach(b => b.onclick = () => openNote(ns[+b.dataset.no]));
  };
}
function snippet(text, q) {
  const t = text.replace(/\s+/g, ' ');
  const w = q.toLowerCase().split(/\s+/).find(x => x.length > 2) || '';
  const k = Math.max(0, t.toLowerCase().indexOf(w) - 40);
  return (k ? '…' : '') + t.slice(k, k + 140);
}
function addNew(n) {
  if (n === 'nota') editNote(null);
  if (n === 'carta') editCard();
  if (n === 'foto') $('#pickPhoto').click();
  if (n === 'file') addSheet();
}

// ---------------------------------------------------------------- CERVELLO
let view = null, brainMode = 'frammenti', trail = null;
async function ensureView() {
  if (view) return view;
  const { BrainView } = await import('./brainview.js');
  view = new BrainView($('#brainCanvas'), { onPick: pickNeuron, onRegion: openRegion });
  view.setBright(S.settings.bright || 1);
  return view;
}
let shownGraph = null;
async function renderBrain() {
  const host = $('#brainHost');
  const g = E.graph;
  host.querySelector('#bInfo').textContent = g ? `${fmtN(E.docs.size)} documenti · ${fmtN(g.n)} neuroni · ${g.regions.length} regioni${g.real ? '' : ' · significati provvisori'}` : '';
  host.querySelector('#bEmpty').classList.toggle('hidden', !!g);
  host.querySelector('#bEmpty').innerHTML = E.busy ? `⏳ ${esc(E.busy)}` : `Il cervello nasce dai tuoi documenti.<br><br><button class="btn primary" id="bAdd">📎 Aggiungi file</button> <button class="btn" id="bDrive">📂 Dal Drive</button>`;
  host.querySelector('#bAdd')?.addEventListener('click', addSheet);
  host.querySelector('#bDrive')?.addEventListener('click', openDriveBrowser);
  host.querySelectorAll('[data-bm]').forEach(b => b.classList.toggle('on', b.dataset.bm === brainMode));
  try { await ensureView(); } catch (e) {
    host.querySelector('#bEmpty').classList.remove('hidden');
    host.querySelector('#bEmpty').innerHTML = `⚠ Non riesco a disegnare il cervello: ${esc(e.message)}<br><span class="small muted">La prima volta serve la connessione per scaricare il motore grafico.</span>`;
    return;
  }
  if (shownGraph !== g || view.mode !== brainMode) { view.setGraph(g, brainMode); shownGraph = g; if (trail) lightTrail(); }
}
function setupBrainHost() {
  const host = $('#brainHost');
  host.querySelectorAll('[data-bm]').forEach(b => b.onclick = () => { brainMode = b.dataset.bm; renderBrain(); });
  host.querySelector('#bHome').onclick = () => { view?.clear(); view?.home(); trail = null; drawTrail(); };
  host.querySelector('#bRegions').onclick = regionsSheet;
  host.querySelector('#bFind').onclick = () => sheet(`<h3>🔎 Cerca un neurone</h3><input class="search" id="bq" placeholder="Parole, formule, nomi…" autocomplete="off"><div id="br" style="margin-top:10px"></div>`, box => {
    const inp = box.querySelector('#bq'); setTimeout(() => inp.focus(), 50);
    inp.oninput = () => {
      const hits = eng.quickFind(inp.value, 20);
      box.querySelector('#br').innerHTML = `<div class="list">${hits.map((h, k) => `<button class="item" data-k="${k}"><span class="ico">✨</span><span class="t"><b>${esc(h.doc?.nome)} ${h.chunk.loc ? '· ' + esc(h.chunk.loc) : ''}</b><span>${esc(snippet(h.chunk.text, inp.value))}</span></span></button>`).join('')}</div>`;
      box.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { closeSheet(); showChunkInBrain(hits[+b.dataset.k].chunk); });
    };
  });
  const sl = host.querySelector('#bBright');
  sl.value = S.settings.bright || 1;
  sl.oninput = () => { view?.setBright(+sl.value); };
  sl.onchange = () => sync.saveSettings({ bright: +sl.value });
  host.querySelector('#tPrev').onclick = () => stepTrail(-1);
  host.querySelector('#tNext').onclick = () => stepTrail(1);
  host.querySelector('#tClose').onclick = () => { trail = null; drawTrail(); view?.clear(); };
}
const graphIndexOfChunk = c => brainMode === 'documenti' ? (E.graph?.docs || []).findIndex(d => d.id === c.doc) : eng.gIndex(c.id);
async function showChunkInBrain(c) {
  go('cervello'); await renderBrain();
  const i = graphIndexOfChunk(c);
  if (i < 0) { toast('Questo frammento non è ancora nel disegno: lo aggiungo al prossimo aggiornamento'); return; }
  view.light([i]); view.flyTo(i);
}
function pickNeuron(i) {
  const g = E.graph; if (!g) return;
  if (brainMode === 'documenti') {
    const d = E.docs.get(g.docs[i]?.id); if (d) openDocSheet(d);
    view.light([i], { dim: false });
    return;
  }
  const idx = E.byId.get(g.ids[i]);
  const c = E.chunks[idx]; if (!c) return;
  // accendo il neurone e i suoi vicini (impulsi lungo le sinapsi)
  const near = [i]; for (let k = 0; k < g.links.length; k += 2) { if (g.links[k] === i) near.push(g.links[k + 1]); else if (g.links[k + 1] === i) near.push(g.links[k]); if (near.length > 12) break; }
  view.light(near, { dim: false });
  openChunk(c);
}
function openChunk(c) {
  const d = E.docs.get(c.doc);
  const reg = E.graph?.regions?.[eng.regionOf(c.id)];
  sheet(`<p class="muted small">${reg ? `<span class="dotc" style="background:${reg.colore}"></span>${esc(reg.nome)} · ` : ''}${esc(d?.raccolta || '')}</p>
    <h3>${esc(d?.nome || '')}${c.loc ? ` <span class="muted small">· ${esc(c.loc)}</span>` : ''}</h3>
    <div class="md chunk">${renderMd(c.text.slice(0, 2500))}</div>
    <div class="acts">
      ${d?.mat ? '<button class="btn" data-a="open">👁 Apri nel punto giusto</button>' : d?.fonte === 'nota' ? '<button class="btn" data-a="nota">📝 Apri la nota</button>' : ''}
      <button class="btn" data-a="brain">🧠 Mostra nel cervello</button>
      <button class="btn" data-a="ask">💬 Chiedi su questo documento</button>
      <button class="btn" data-a="doc">📄 Scheda del documento</button>
    </div>`, box => box.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    const a = b.dataset.a; closeSheet();
    if (a === 'open') openMaterial(d.mat, { page: c.page, t: c.t, text: c.text });
    if (a === 'nota') { const n = M.notes.find(x => x.id === d.ref); if (n) openNote(n); }
    if (a === 'brain') showChunkInBrain(c);
    if (a === 'ask') { chatFilter = { doc: d.id, nome: d.nome }; go('chiedi'); }
    if (a === 'doc') openDocSheet(d);
  }));
}
function openDocSheet(d) {
  const cs = E.chunks.filter(c => c.doc === d.id);
  const st = { letto: '✅ letto', 'in coda': '⏳ da leggere', 'attesa rete': '⏳ ' + (d.errore || 'serve la rete'), errore: '⚠ ' + (d.errore || 'errore') }[d.stato] || d.stato;
  sheet(`<h3>${esc(d.nome)}</h3><p class="muted small">${esc(d.raccolta || '')} · ${plural(cs.length, 'frammento', 'frammenti')} · ${esc(st)}${d.info ? ' · ' + esc(d.info) : ''}${d.ocr?.length ? ` · ${d.ocr.length} pagine in OCR` : ''}</p>
    ${d.riassunto ? `<div class="md expl">${renderMd(d.riassunto)}</div>` : d.fonte === 'materiale' && d.stato === 'letto' ? '<button class="btn" id="dSum">📝 Riassumi ora</button>' : ''}
    <div class="acts">
      ${d.mat ? '<button class="btn" data-a="open">👁 Apri</button>' : ''}
      <button class="btn" data-a="brain">🧠 Mostra nel cervello</button>
      <button class="btn" data-a="ask">💬 Chiedi su questo documento</button>
      <button class="btn" data-a="quiz">🎓 Quiz da questo documento</button>
      <button class="btn" data-a="flash">🃏 Flashcard da questo documento</button>
      <button class="btn" data-a="racc">🏷 Raccolta: ${esc(d.raccolta || '—')}</button>
      ${d.stato === 'errore' || d.stato === 'attesa rete' ? '<button class="btn" data-a="retry">↻ Riprova a leggerlo</button>' : ''}
    </div>`, box => {
    box.querySelector('#dSum')?.addEventListener('click', e => busy(e.target, async () => {
      try { await eng.summarizeNow(d.id); openDocSheet(d); } catch (er) { toast('⚠ ' + er.message, 4000); }
    }));
    box.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'open') { closeSheet(); openMaterial(d.mat); }
      if (a === 'brain') {
        closeSheet(); go('cervello'); await renderBrain();
        const idx = brainMode === 'documenti' ? [(E.graph?.docs || []).findIndex(x => x.id === d.id)] : cs.map(c => eng.gIndex(c.id));
        view.light(idx.filter(i => i >= 0)); if (idx[0] >= 0) view.flyTo(idx[0], 1.1);
      }
      if (a === 'ask') { closeSheet(); chatFilter = { doc: d.id, nome: d.nome }; go('chiedi'); }
      if (a === 'quiz' || a === 'flash') { closeSheet(); generateAndStart({ doc: d.id }, a === 'quiz' ? 'quiz' : 'flashcard', d.nome); }
      if (a === 'racc') pickRaccolta(d.raccolta, async r => { await eng.setRaccolta(d.id, r); toast('🏷 Raccolta aggiornata'); });
      if (a === 'retry') { await eng.retry(d.id); closeSheet(); toast('Riprovo…'); }
    });
  });
}
function pickRaccolta(cur, done) {
  const list = eng.raccolte();
  sheet(`<h3>🏷 Raccolta</h3><p class="muted small">Le raccolte sono come le cartelle del PC: danno il nome alle regioni e servono come filtro nelle domande.</p>
    <div class="chips wrap">${list.map(r => `<button data-r="${esc(r)}" class="${r === cur ? 'on' : ''}">${esc(r)}</button>`).join('')}</div>
    <label class="f">Nuova raccolta<input id="rn" placeholder="Es. Analisi 2"></label><button class="btn primary block" id="rs">Salva</button>`, box => {
    box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { closeSheet(); done(b.dataset.r); });
    box.querySelector('#rs').onclick = () => { const v = box.querySelector('#rn').value.trim(); if (v) { closeSheet(); done(v); } };
  });
}
function regionsSheet() {
  const regs = E.graph?.regions || [];
  sheet(`<h3>🧠 Regioni</h3><p class="muted small">Tocca una regione per vederla. Il nome viene dalla raccolta, dal file principale o dall'AI; puoi cambiarlo tu.</p>
    <div class="list">${regs.map(r => `<button class="item" data-r="${r.id}"><span class="ico"><span class="dotc big" style="background:${r.colore}"></span></span><span class="t"><b>${esc(r.nome)}</b><span>${fmtN(r.n)} neuroni · ${esc(r.file.slice(0, 2).join(', '))}</span></span></button>`).join('')}</div>
    <div class="acts"><button class="btn" id="rAi" ${ai.available() ? '' : 'disabled'}>✨ Fai dare i nomi all'AI</button></div>`, box => {
    box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => openRegion(+b.dataset.r));
    box.querySelector('#rAi').onclick = e => busy(e.target, async () => {
      try { const n = await eng.aiNameRegions(); toast(`✨ ${plural(n, 'regione rinominata', 'regioni rinominate')}`); shownGraph = null; renderBrain(); regionsSheet(); }
      catch (er) { toast('⚠ ' + er.message, 4000); }
    });
  });
}
function openRegion(r) {
  const reg = E.graph?.regions?.[r]; if (!reg) return;
  if (view && tab === 'cervello') {
    const idx = brainMode === 'documenti' ? E.graph.docs.map((d, i) => d.r === r ? i : -1) : E.graph.region.map((x, i) => x === r ? i : -1);
    const lit = idx.filter(i => i >= 0);
    view.light(lit.slice(0, 5000), { dim: true });
    if (lit.length) view.flyTo(lit[Math.floor(lit.length / 2)], 1.5);
  }
  sheet(`<h3><span class="dotc" style="background:${reg.colore}"></span>${esc(reg.nome)}</h3>
    <p class="muted small">${fmtN(reg.n)} neuroni · nome da: ${esc(reg.fonte)}</p>
    <p class="small"><b>File:</b> ${esc(reg.file.join(' · '))}</p>
    <p class="small"><b>Parole tipiche:</b> ${esc(reg.parole.join(', '))}</p>
    <div class="acts">
      <button class="btn" data-a="ask">💬 Chiedi su questa regione</button>
      <button class="btn" data-a="quiz">🎓 Quiz su questa regione</button>
      <button class="btn" data-a="name">✏ Rinomina</button>
    </div>`, box => box.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'ask') { closeSheet(); chatFilter = { regione: r, nome: reg.nome }; go('chiedi'); }
    if (a === 'quiz') { closeSheet(); generateAndStart({ regione: r }, 'quiz', reg.nome); }
    if (a === 'name') {
      const nome = prompt('Nome della regione (vuoto = automatico)', reg.fonte === 'tuo' ? reg.nome : '');
      if (nome === null) return;
      await eng.renameRegion(reg.firma, nome.trim()); closeSheet(); shownGraph = null; renderBrain();
    }
  }));
}

// "Ripercorri la risposta": passo per passo su ogni fonte
function startTrail(msg) {
  trail = { fonti: msg.fonti || [], web: msg.web || [], k: 0 };
  go('cervello');
  setTimeout(() => { lightTrail(); drawTrail(); }, 60);
}
function lightTrail() {
  if (!trail || !view) return;
  const idx = trail.fonti.map(f => { const c = E.chunks[E.byId.get(f.id)]; return c ? graphIndexOfChunk(c) : -1; });
  trail.idx = idx;
  view.light(idx.filter(i => i >= 0));
  const cur = idx[trail.k]; if (cur >= 0) view.flyTo(cur);
}
function stepTrail(d) {
  if (!trail) return;
  const n = trail.fonti.length + (trail.web.length ? 1 : 0);
  trail.k = Math.max(0, Math.min(n - 1, trail.k + d));
  const cur = trail.idx?.[trail.k];
  if (cur >= 0) view.flyTo(cur); else if (trail.k >= trail.fonti.length) view.home();
  drawTrail();
}
function drawTrail() {
  const el = $('#trail');
  if (!trail) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const f = trail.fonti[trail.k];
  const n = trail.fonti.length + (trail.web.length ? 1 : 0);
  el.querySelector('#tStep').textContent = `${trail.k + 1} / ${n}`;
  el.querySelector('#tBody').innerHTML = f ? `<b>[${f.n}] ${esc(f.nome)}${f.loc ? ' · ' + esc(f.loc) : ''}</b> <span class="tag ${f.citata ? 'ok' : ''}">${f.citata ? 'citata' : 'solo consultata'}</span>
    <div class="small">${esc(f.estratto)}…</div><button class="btn small-btn" id="tOpen">👁 Apri</button>`
    : `<b>🌐 Dal web</b><div class="small">${trail.web.map((w, k) => `<a href="${esc(w.url)}" target="_blank" rel="noopener">[W${k + 1}] ${esc(w.titolo)}</a>`).join('<br>')}</div>`;
  el.querySelector('#tOpen')?.addEventListener('click', () => { const c = E.chunks[E.byId.get(f.id)]; if (c) openChunk(c); });
}

// ------------------------------------------------------------------ CHIEDI
let chat = { messaggi: [] }, chatFilter = null, webMode = 'auto', asking = null;
function renderChat() {
  const host = $('#chatHost');
  const msgs = host.querySelector('#cMsgs');
  host.querySelector('#cFilter').innerHTML = chatFilter ? `📁 ${esc(chatFilter.nome)} ✕` : '📁 Tutto';
  host.querySelector('#cWeb').textContent = { auto: '🌐 Web: auto', sempre: '🌐 Web: sempre', mai: '🌐 Web: no' }[webMode];
  if (!chat.messaggi.length) {
    msgs.innerHTML = `<div class="chat-hello"><div class="logo big"></div><h2 style="text-transform:none;letter-spacing:0;color:var(--text);font-size:18px">Chiedi al tuo cervello</h2>
      <p class="muted">Rispondo con i tuoi documenti e cito le fonti [1]; se non bastano cerco sul web [W1].
      ${!ai.available() ? '<br><b style="color:var(--gold)">Prima inserisci una chiave AI in ⚙ Impostazioni.</b>' : ''}</p>
      ${E.docs.size ? `<div class="sugg">${['Riassumimi gli argomenti principali', 'Cosa dovrei ripassare prima dell\'esame?', 'Spiegami il concetto più difficile dei miei appunti']
        .map(s => `<button class="chip-q">${s}</button>`).join('')}</div>` : ''}</div>`;
    msgs.querySelectorAll('.chip-q').forEach(b => b.onclick = () => sendQuestion(b.textContent));
    return;
  }
  msgs.innerHTML = chat.messaggi.map((m, k) => m.ruolo === 'utente'
    ? `<div class="msg me">${esc(m.testo)}</div>`
    : `<div class="msg ai" data-k="${k}">${msgHtml(m)}</div>`).join('');
  msgs.querySelectorAll('.msg.ai').forEach(el => bindMsg(el, chat.messaggi[+el.dataset.k]));
  mathIn(msgs);
  msgs.scrollTop = msgs.scrollHeight;
}
function citeHtml(text, m) {
  let h = renderMd(text || '');
  h = h.replace(/\[(\d+)\]/g, (x, n) => (m.fonti || []).some(f => f.n === +n) ? `<button class="cite" data-n="${n}">${n}</button>` : x);
  h = h.replace(/\[W(\d+)\]/g, (x, n) => { const w = (m.web || [])[+n - 1]; return w ? `<a class="cite web" href="${esc(w.url)}" target="_blank" rel="noopener">W${n}</a>` : x; });
  return h;
}
function msgHtml(m) {
  const fonti = m.fonti || [];
  return `<div class="md">${m.stato && !m.testo ? `<p class="muted">⏳ ${esc(m.stato)}</p>` : citeHtml(m.testo, m)}</div>
    ${m.finita ? `<div class="msg-foot">
      ${fonti.length ? `<details><summary>${plural(fonti.length, 'fonte', 'fonti')} · ${plural(fonti.filter(f => f.citata).length, 'citata', 'citate')}${m.web?.length ? ` · ${m.web.length} dal web` : ''}</summary>
        <div class="list">${fonti.map(f => `<button class="item src" data-src="${f.n}"><span class="ico">${f.citata ? '📌' : '·'}</span><span class="t"><b>[${f.n}] ${esc(f.nome)}${f.loc ? ' · ' + esc(f.loc) : ''}</b><span>${esc(f.estratto)}</span></span></button>`).join('')}
        ${(m.web || []).map((w, k) => `<a class="item src" href="${esc(w.url)}" target="_blank" rel="noopener"><span class="ico">🌐</span><span class="t"><b>[W${k + 1}] ${esc(w.titolo)}</b><span>${esc(w.url)}</span></span></a>`).join('')}</div></details>` : ''}
      <div class="row wrap acts-row">
        ${fonti.length ? '<button class="mini" data-a="brain">🧠 Nel cervello</button><button class="mini" data-a="trail">🧭 Ripercorri</button>' : ''}
        <button class="mini" data-a="save">💾 Salva nel cervello</button><button class="mini" data-a="cards">🃏 Flashcard</button><button class="mini" data-a="share">↗</button>
      </div>
      <p class="muted small">${esc(m.modello || '')}${m.nota ? ' · ' + esc(m.nota) : ''}</p></div>` : ''}`;
}
function bindMsg(el, m) {
  el.querySelectorAll('[data-n]').forEach(b => b.onclick = () => openSource(m, +b.dataset.n));
  el.querySelectorAll('[data-src]').forEach(b => b.onclick = () => openSource(m, +b.dataset.src));
  el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    const q = chat.messaggi[chat.messaggi.indexOf(m) - 1]?.testo || 'Risposta';
    if (a === 'brain') { trail = null; go('cervello'); await renderBrain(); const idx = m.fonti.map(f => { const c = E.chunks[E.byId.get(f.id)]; return c ? graphIndexOfChunk(c) : -1; }).filter(i => i >= 0); view.light(idx); if (idx[0] !== undefined) view.flyTo(idx[0], 1.2); }
    if (a === 'trail') startTrail(m);
    if (a === 'save') { await asker.saveAnswer(m, q); toast('💾 Salvata nel cervello (raccolta «Risposte salvate»)'); }
    if (a === 'cards') busy(b, async () => {
      try {
        const r = await ai.generate(`Da questa spiegazione crea 3-5 flashcard (domanda e risposta breve) in italiano, formule in LaTeX tra $...$. Rispondi in JSON {"carte":[{"domanda":"…","risposta":"…"}]}.\n\nDOMANDA: ${q}\n\nRISPOSTA:\n${m.testo}`, { json: true });
        const made = await study.addCards((r.json?.carte || []).map(c => ({ domanda: c.domanda, opzioni: [String(c.risposta || '')], regione_nome: 'Dalle risposte', origine: 'AI' })));
        toast(`🃏 ${plural(made.length, 'flashcard aggiunta', 'flashcard aggiunte')} al ripasso`);
      } catch (e) { toast('⚠ ' + e.message, 4000); }
    });
    if (a === 'share') {
      const txt = `# ${q}\n\n${m.testo}\n\nFonti:\n${(m.fonti || []).filter(f => f.citata).map(f => `[${f.n}] ${f.nome}${f.loc ? ' — ' + f.loc : ''}`).join('\n')}`;
      shareFile({ nome: `${q.slice(0, 50).replace(/[\\/:*?"<>|]+/g, '-')}.md`, mime: 'text/markdown' }, new Blob([txt], { type: 'text/markdown' }));
    }
  });
}
function openSource(m, n) {
  const f = (m.fonti || []).find(x => x.n === n); if (!f) return;
  const c = E.chunks[E.byId.get(f.id)];
  if (c) openChunk(c);
  else sheet(`<h3>[${f.n}] ${esc(f.nome)}</h3><p class="muted small">${esc(f.loc || '')} · non più nel cervello</p><div class="md">${renderMd(f.testo || f.estratto)}</div>`);
}
async function sendQuestion(q) {
  if (asking) return;
  q = q.trim(); if (!q) return;
  const storia = chat.messaggi.filter(m => m.testo).map(m => ({ ruolo: m.ruolo, testo: m.testo.slice(0, 3000) }));
  chat.messaggi.push({ ruolo: 'utente', testo: q });
  const m = { ruolo: 'assistente', testo: '', stato: 'Cerco nei tuoi documenti…', fonti: [] };
  chat.messaggi.push(m);
  renderChat();
  const msgs = $('#cMsgs');
  const el = () => msgs.querySelector(`.msg.ai[data-k="${chat.messaggi.indexOf(m)}"]`);
  const ctrl = new AbortController();
  asking = ctrl; $('#cSend').textContent = '■';
  let raf = 0;
  const paint = () => { raf = 0; const e = el(); if (!e) return; e.innerHTML = msgHtml(m); if (m.finita) bindMsg(e, m); mathIn(e); msgs.scrollTop = msgs.scrollHeight; };
  try {
    const filtro = chatFilter ? (chatFilter.doc ? { doc: chatFilter.doc } : chatFilter.regione !== undefined ? { regione: chatFilter.regione } : { raccolta: chatFilter.raccolta }) : {};
    const res = await asker.ask(q, {
      web: webMode, filtro, storia, signal: ctrl.signal,
      onFonti: f => { m.fonti = f; m.stato = 'Penso…'; paint(); if (view && f.length) { const idx = f.map(x => eng.gIndex(x.id)).filter(i => i >= 0); if (brainMode === 'frammenti') view.light(idx); } },
      onStato: s => { m.stato = s; paint(); },
      onTesto: (_p, all) => { m.testo = all; if (!raf) raf = requestAnimationFrame(paint); },
    });
    Object.assign(m, { testo: res.risposta, fonti: res.fonti, web: res.web, modello: res.modello, nota: res.nota, finita: true, stato: null });
  } catch (e) {
    Object.assign(m, { testo: '⚠ ' + e.message, finita: true, stato: null });
  } finally {
    asking = null; $('#cSend').textContent = '➤';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const e = el(); if (e) { e.innerHTML = msgHtml(m); bindMsg(e, m); mathIn(e); }
    msgs.scrollTop = msgs.scrollHeight;
    await asker.saveChat(chat);
  }
}
function setupChatHost() {
  const host = $('#chatHost');
  const inp = host.querySelector('#cInput');
  host.querySelector('#cForm').onsubmit = e => {
    e.preventDefault();
    if (asking) { asking.abort(); return; }
    const q = inp.value; inp.value = ''; inp.style.height = ''; sendQuestion(q);
  };
  inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(140, inp.scrollHeight) + 'px'; };
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && innerWidth > 700) { e.preventDefault(); host.querySelector('#cForm').requestSubmit(); } };
  host.querySelector('#cWeb').onclick = () => { webMode = { auto: 'sempre', sempre: 'mai', mai: 'auto' }[webMode]; renderChat(); };
  host.querySelector('#cFilter').onclick = () => {
    if (chatFilter) { chatFilter = null; renderChat(); return; }
    const racc = eng.raccolte(), regs = E.graph?.regions || [];
    sheet(`<h3>📁 Cerca solo in…</h3>${racc.length ? `<h2>Raccolte</h2><div class="chips wrap">${racc.map(r => `<button data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
      ${regs.length ? `<h2>Regioni</h2><div class="chips wrap">${regs.map(r => `<button data-g="${r.id}"><span class="dotc" style="background:${r.colore}"></span>${esc(r.nome)}</button>`).join('')}</div>` : ''}
      ${!racc.length && !regs.length ? '<div class="empty">Il cervello è ancora vuoto.</div>' : ''}`, box => {
      box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { chatFilter = { raccolta: b.dataset.r, nome: b.dataset.r }; closeSheet(); renderChat(); });
      box.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { const r = regs[+b.dataset.g]; chatFilter = { regione: r.id, nome: r.nome }; closeSheet(); renderChat(); });
    });
  };
  host.querySelector('#cNew').onclick = () => { chat = { messaggi: [] }; renderChat(); };
  host.querySelector('#cHist').onclick = async () => {
    const list = await asker.chats();
    sheet(`<h3>🕘 Conversazioni</h3><input class="search" id="hq" placeholder="Cerca…"><div class="list" id="hl" style="margin-top:10px"></div>`, box => {
      const draw = q => {
        const l = list.filter(c => !q || JSON.stringify(c.messaggi).toLowerCase().includes(q.toLowerCase()));
        box.querySelector('#hl').innerHTML = l.length ? l.map(c => `<div class="item"><span class="ico">💬</span><button class="t" data-id="${c.id}" style="border:0;background:none;text-align:left;padding:0"><b>${esc(c.titolo)}</b><span>${ago(c.t)} · ${c.messaggi.length / 2 | 0} domande</span></button><button class="act" data-del="${c.id}">🗑</button></div>`).join('') : '<div class="empty">Nessuna conversazione</div>';
        box.querySelectorAll('[data-id]').forEach(b => b.onclick = async () => { chat = await asker.getChat(b.dataset.id); closeSheet(); renderChat(); });
        box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await asker.deleteChat(b.dataset.del); list.splice(list.findIndex(c => c.id === b.dataset.del), 1); draw(box.querySelector('#hq').value); });
      };
      box.querySelector('#hq').oninput = e => draw(e.target.value); draw('');
    });
  };
}

// ------------------------------------------------------------------ STUDIO
function regionsWithCards(cards) {
  const by = new Map();
  for (const c of cards) {
    const k = c.regione_nome || 'Altro';
    if (!by.has(k)) by.set(k, { nome: k, carte: [], due: 0, nuove: 0, ok: 0, viste: 0, mie: 0 });
    const r = by.get(k); r.carte.push(c); if (c.mia) r.mie++;
    if (isDue(c)) r.due++; if (isNew(c)) r.nuove++;
    if (c.reps) { r.viste++; if (c.last_ok !== 0 && c.interval >= 1) r.ok++; }
  }
  return [...by.values()].sort((a, b) => b.due - a.due || b.carte.length - a.carte.length);
}
const allNotes = () => [...M.notes, ...S.notes];
function renderStudy(v) {
  const segs = [['ripasso', 'Ripasso'], ['crea', 'Crea'], ['riassunti', 'Riassunti'], ['note', 'Note'], ['esami', 'Esami']];
  v.innerHTML = `<h1>Studio</h1><div class="seg">${segs.map(([k, t]) => `<button data-s="${k}" class="${studioSeg === k ? 'on' : ''}">${t}</button>`).join('')}</div><div id="sb"></div>`;
  v.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { studioSeg = b.dataset.s; renderStudy(v); });
  const sb = v.querySelector('#sb');
  const cards = allCards();
  if (studioSeg === 'ripasso') {
    const due = cards.filter(c => isDue(c)), nuove = cards.filter(c => isNew(c));
    const regs = regionsWithCards(cards);
    sb.innerHTML = !cards.length ? `<div class="empty">Nessuna domanda ancora.<br><br><button class="btn primary" id="sGo">🎓 Creane dai tuoi documenti</button></div>` : `
      <div class="row" style="margin-bottom:12px">
        <button class="btn primary grow" id="sDue" ${due.length ? '' : 'disabled'}>🎓 Ripassa (${due.length})</button>
        <button class="btn grow" id="sNew" ${nuove.length ? '' : 'disabled'}>✨ Nuove (${nuove.length})</button>
      </div>
      <label class="switch"><input type="checkbox" id="sFlash" ${S.settings.flash ? 'checked' : ''}>
        <div>Modalità flashcard<span>Prima pensi alla risposta, poi la scopri e ti valuti da solo</span></div></label>
      <h2>Per argomento</h2>
      <div class="list">${regs.map((r, k) => `<div class="item"><button class="t" data-reg="${k}" style="border:0;background:none;text-align:left;padding:0;display:flex;gap:12px;align-items:center;width:100%">
        <span class="ico">${r.mie === r.carte.length ? '📱' : r.mie ? '🧠' : '💻'}</span><span class="t"><b>${esc(r.nome)}</b><span>${r.carte.length} domande · ${r.due} da ripassare · ${r.nuove} nuove${r.viste ? ` · padronanza ${Math.round(r.ok / r.viste * 100)}%` : ''}</span></span></button>
        <button class="act" data-sh="${k}" title="Condividi / esporta">⋮</button></div>`).join('')}</div>
      <p class="muted small">📱 create sul telefono · 💻 arrivate dal PC. Con ⋮ le mandi nel Drive o le esporti (anche per Anki).</p>
      <button class="btn block" id="sImp" style="margin-top:8px">📥 Importa carte e note dal Drive</button>`;
    sb.querySelector('#sGo')?.addEventListener('click', () => { studioSeg = 'crea'; renderStudy(v); });
    sb.querySelector('#sDue')?.addEventListener('click', () => startSession(due, 'Ripasso'));
    sb.querySelector('#sNew')?.addEventListener('click', () => startSession(nuove.slice(0, 15), 'Nuove'));
    sb.querySelector('#sFlash')?.addEventListener('change', e => sync.saveSettings({ flash: e.target.checked }));
    sb.querySelector('#sImp')?.addEventListener('click', openSharedBrowser);
    sb.querySelectorAll('[data-reg]').forEach(b => b.onclick = () => {
      const r = regs[+b.dataset.reg];
      const list = [...r.carte.filter(c => isDue(c)), ...r.carte.filter(c => isNew(c)), ...r.carte.filter(c => !isDue(c) && !isNew(c))];
      startSession(list.slice(0, 20), r.nome);
    });
    sb.querySelectorAll('[data-sh]').forEach(b => b.onclick = () => { const r = regs[+b.dataset.sh]; shareMenu(r.nome, { carte: r.carte }); });
  } else if (studioSeg === 'crea') {
    const racc = eng.raccolte(), regs = E.graph?.regions || [], docs = [...E.docs.values()].filter(d => d.nchunk).sort((a, b) => a.nome.localeCompare(b.nome));
    sb.innerHTML = !E.chunks.length ? `<div class="empty">Per creare domande servono documenti nel cervello.<br><br><button class="btn primary" id="cAdd">📎 Aggiungi file</button></div>` : `
      <div class="card">
        <label class="f">Da dove<select id="gScope"><option value="tutto">Tutto il cervello</option>
          ${racc.length ? `<optgroup label="Raccolte">${racc.map(r => `<option value="r:${esc(r)}">${esc(r)}</option>`).join('')}</optgroup>` : ''}
          ${regs.length ? `<optgroup label="Regioni">${regs.map(r => `<option value="g:${r.id}">${esc(r.nome)}</option>`).join('')}</optgroup>` : ''}
          <optgroup label="Documenti">${docs.map(d => `<option value="d:${d.id}">${esc(d.nome)}</option>`).join('')}</optgroup></select></label>
        <div class="seg" id="gType"><button data-t="quiz" class="on">Quiz a scelta multipla</button><button data-t="flashcard">Flashcard</button></div>
        <label class="f">Quante<select id="gN"><option>5</option><option selected>8</option><option>12</option><option>20</option></select></label>
        <button class="btn primary block" id="gGo" ${ai.available() ? '' : 'disabled'}>✨ Crea e inizia</button>
        ${ai.available() ? '' : '<p class="muted small">Serve una chiave AI (⚙ Impostazioni).</p>'}
      </div>
      <h2>Scrivi tu</h2><button class="btn block" id="gHand">🃏 Nuova flashcard</button>`;
    sb.querySelector('#cAdd')?.addEventListener('click', addSheet);
    let tipo = 'quiz';
    sb.querySelectorAll('#gType [data-t]').forEach(b => b.onclick = () => { tipo = b.dataset.t; sb.querySelectorAll('#gType button').forEach(x => x.classList.toggle('on', x === b)); });
    sb.querySelector('#gHand')?.addEventListener('click', () => editCard());
    sb.querySelector('#gGo')?.addEventListener('click', () => {
      const s = sb.querySelector('#gScope').value, n = +sb.querySelector('#gN').value;
      const sel = sb.querySelector('#gScope').selectedOptions[0].textContent;
      const ambito = s === 'tutto' ? {} : s.startsWith('r:') ? { raccolta: s.slice(2) } : s.startsWith('g:') ? { regione: +s.slice(2) } : { doc: s.slice(2) };
      generateAndStart(ambito, tipo, sel, n);
    });
  } else if (studioSeg === 'riassunti') {
    const all = [...[...E.docs.values()].filter(d => d.riassunto).map(d => ({ nome: d.nome, testo: d.riassunto, da: '📱' })),
      ...(S.pack?.riassunti || []).map(r => ({ ...r, da: '💻' }))];
    const missing = [...E.docs.values()].filter(d => d.fonte === 'materiale' && d.stato === 'letto' && !d.riassunto).length;
    sb.innerHTML = `<input class="search" id="rq" placeholder="Cerca un documento…">${missing ? `<p class="muted small">${plural(missing, 'documento ancora da riassumere', 'documenti ancora da riassumere')}: li riassumo in background quando c'è rete.</p>` : ''}<div class="list" id="rl" style="margin-top:10px"></div>`;
    const draw = q => {
      const l = all.filter(r => !q || (r.nome + r.testo).toLowerCase().includes(q.toLowerCase()));
      sb.querySelector('#rl').innerHTML = l.length ? l.slice(0, 300).map(r => `<button class="item" data-k="${all.indexOf(r)}"><span class="ico">${r.da}</span>
        <span class="t"><b>${esc(r.nome)}</b><span>${esc(r.testo.replace(/[#*_$]/g, '').slice(0, 90))}</span></span></button>`).join('')
        : `<div class="empty">${all.length ? 'Nessun risultato' : 'I riassunti arrivano da soli man mano che i documenti vengono letti.'}</div>`;
      sb.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { const r = all[+b.dataset.k]; openText(r.nome, 'Riassunto', r.testo, { nome: r.nome + ' (riassunto)', testo: r.testo }); });
    };
    sb.querySelector('#rq').oninput = e => draw(e.target.value); draw('');
  } else if (studioSeg === 'note') {
    const notes = allNotes();
    sb.innerHTML = `<button class="btn primary block" id="nNew">📝 Nuova nota</button><div class="list" style="margin-top:12px">${notes.length ? notes.map((n, k) =>
      `<button class="item" data-n="${k}"><span class="ico">${n.mia ? '📝' : '💻'}</span><span class="t"><b>${esc(n.titolo)}</b><span>${ago(n.modificata)}${n.mia ? '' : ' · dal PC'}${n.inAttesa ? ' · da inviare' : ''}</span></span></button>`).join('')
      : '<div class="empty">Nessuna nota.</div>'}</div>
      ${M.notes.length ? '<button class="btn block" id="nShare" style="margin-top:12px">↗ Condividi o esporta le mie note</button>' : ''}`;
    sb.querySelector('#nNew').onclick = () => editNote(null);
    sb.querySelector('#nShare')?.addEventListener('click', () => shareMenu('Note dal telefono', { note: M.notes }));
    sb.querySelectorAll('[data-n]').forEach(b => b.onclick = () => openNote(notes[+b.dataset.n]));
  } else {
    const e = S.pack?.esami || {};
    const regs = e.regioni || [], docs = e.documenti || [];
    const max = Math.max(1, ...regs.map(x => x.peso));
    sb.innerHTML = regs.length ? `<p class="muted">Dal PC, da ${e.prove} prove d'esame: gli argomenti che escono di più e dove studiarli.</p>
      <h2>Argomenti più chiesti</h2>${regs.map(x => `<div class="bar"><span class="nm">${esc(x.nome)}</span><span class="tr"><i style="width:${x.peso / max * 100}%"></i></span><span class="pc">${x.peso}%</span></div>`).join('')}
      <h2>Dove studiarli</h2><div class="list">${docs.map(d => {
        const local = S.materials.find(m => m.path === d.doc || m.nome === d.nome);
        return `<div class="item"><span class="ico">📍</span><span class="t"><b>${esc(d.nome)}</b><span>${esc((d.pagine || []).filter(p => p !== '—').join(' · ') || '')} · ${d.peso}%</span></span>
          ${local ? `<button class="act" data-open="${local.id}">👁</button>` : ''}</div>`;
      }).join('')}</div>` : `<div class="empty">L'analisi delle prove d'esame la fa il PC e arriva con la sincronizzazione.<br>Sul telefono puoi chiedere: «quali argomenti escono di più negli esami?» dopo aver aggiunto le prove al cervello.</div>`;
    sb.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openMaterial(b.dataset.open));
  }
}
async function generateAndStart(ambito, tipo, titolo, n = 8) {
  if (!ai.available()) { toast('Serve una chiave AI'); openSettings(); return; }
  toast(`✨ Creo ${n} ${tipo === 'quiz' ? 'domande' : 'flashcard'}…`, 20000);
  try {
    const made = await study.generate(ambito, n, tipo);
    toast(`✅ ${plural(made.length, 'domanda pronta', 'domande pronte')}`);
    startSession(made, titolo);
  } catch (e) { toast('⚠ ' + e.message, 4500); }
}

// condividere ed esportare carte e note
function shareMenu(titolo, contenuto) {
  const p = study.pack(titolo, contenuto);
  sheet(`<h3>↗ ${esc(titolo)}</h3><p class="muted small">${plural(p.carte.length, 'carta', 'carte')}${p.note.length ? ' · ' + plural(p.note.length, 'nota', 'note') : ''}</p>
    <div class="acts">
      <button class="btn" data-a="drive">☁ Metti nel Drive (BrainOS/Condivisi)<br><span class="muted small">Il PC e gli altri telefoni li importano da lì</span></button>
      <button class="btn" data-a="file">💾 Esporta come file<br><span class="muted small">.json di BrainOS, .csv per Anki, .md da leggere</span></button>
      ${contenuto.carte?.some(c => c.mia) ? '<button class="btn" data-a="pc">💻 Manda al PC (nel suo ripasso)</button>' : ''}
      ${contenuto.carte?.some(c => c.mia) ? '<button class="btn danger" data-a="del">🗑 Elimina le mie carte di questo argomento</button>' : ''}
    </div>`, box => box.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'drive') {
      if (!(await ensureLogin())) return;
      await busy(b, async () => { try { await study.toDrive(p); closeSheet(); toast('☁ Nel Drive, cartella BrainOS/Condivisi'); } catch (e) { toast('⚠ ' + e.message, 4000); } });
    }
    if (a === 'file') {
      const fs = study.files(p);
      if (navigator.canShare?.({ files: fs })) { try { await navigator.share({ files: fs, title: titolo }); } catch { /* annullato */ } }
      else for (const f of fs) { const l = document.createElement('a'); l.href = URL.createObjectURL(f); l.download = f.name; l.click(); }
    }
    if (a === 'pc') {
      for (const c of p.carte) await sync.newCard(c.domanda, c.opzioni[c.corretta] ?? '', c.spiegazione, { opzioni: c.opzioni, corretta: c.corretta, argomento: c.argomento || titolo });
      closeSheet(); toast('💻 In coda per il PC');
    }
    if (a === 'del') {
      if (!confirm('Eliminare le carte create sul telefono per questo argomento?')) return;
      await study.deleteCards(contenuto.carte.filter(c => c.mia).map(c => c.id)); closeSheet(); render();
    }
  }));
}
// sfoglia BrainOS/Condivisi nel Drive: pacchetti di carte/note e file
async function openSharedBrowser() {
  if (!(await ensureLogin())) return;
  openScreen(async el => {
    el.innerHTML = head('Condivisi nel Drive', 'BrainOS/Condivisi') + '<div class="screen-body"><div class="empty">Carico…</div></div>';
    bindBack(el);
    let items;
    try { items = (await study.listShared()).filter(f => f.mimeType !== drive.FOLDER); }
    catch (e) { el.querySelector('.screen-body').innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`; return; }
    const packs = items.filter(f => study.isPack(f.name)), bases = packs.map(f => f.name.replace(/\.brainos\.json$/i, ''));
    // i .csv (Anki) e .md accanto a un pacchetto sono copie "da leggere": non li ripeto tra i file
    const others = items.filter(f => !study.isPack(f.name) && !bases.some(b => f.name === `${b} (Anki).csv` || f.name === `${b}.md`));
    el.querySelector('.screen-body').innerHTML = `<p class="muted small">Qui finisce ciò che mandi nel Drive dal telefono o dal PC.</p>
      <h2>Carte e note</h2><div class="list">${packs.length ? packs.map((f, k) => `<div class="item"><span class="ico">🃏</span><span class="t"><b>${esc(f.name.replace(/\.brainos\.json$/i, ''))}</b><span>${ago(Date.parse(f.modifiedTime) / 1000)}</span></span><button class="btn" data-p="${k}">Importa</button></div>`).join('') : '<div class="empty">Nessun pacchetto</div>'}</div>
      <h2>File</h2><div class="list">${others.length ? others.map((f, k) => `<div class="item"><span class="ico">${iconOf({ nome: f.name, mime: f.mimeType })}</span><span class="t"><b>${esc(f.name)}</b><span>${f.size ? fmtSize(f.size) : ''}${S.materials.some(m => m.drive_id === f.id) ? ' · già sul telefono' : ''}</span></span><button class="btn" data-f="${k}">⬇</button></div>`).join('') : '<div class="empty">Nessun file</div>'}</div>`;
    const done = b => { b.textContent = '✓'; b.classList.add('ok'); };
    el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => busy(b, async () => {
      try { const r = await study.importPack(await drive.readJson(packs[+b.dataset.p].id)); toast(`📥 ${plural(r.carte, 'carta', 'carte')} e ${plural(r.note, 'nota', 'note')} importate`); return true; }
      catch (e) { toast('⚠ ' + e.message, 4000); }
    }).then(ok => ok && done(b)));
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => busy(b, async () => {
      try { await importFiles([others[+b.dataset.f]], { raccolta: 'Condivisi' }); return true; } catch (e) { toast('⚠ ' + e.message, 4000); }
    }).then(ok => ok && done(b)));
  });
}

// sessione di ripasso / quiz
function startSession(cards, title) {
  if (!cards.length) { toast('Nessuna domanda qui'); return; }
  const st = { cards: [...cards], k: 0, ok: 0, answered: false, title };
  openScreen(el => drawCard(el, st));
}
function drawCard(el, st) {
  if (st.k >= st.cards.length) {
    el.innerHTML = head('Fine', st.title) + `<div class="screen-body"><div class="end"><div class="big">${st.ok} / ${st.cards.length}</div>
      <p>${st.ok === st.cards.length ? 'Perfetto! 🎉' : 'Le domande sbagliate torneranno presto.'}</p>
      <button class="btn primary" data-back>Fatto</button></div></div>`;
    bindBack(el); return;
  }
  const c = st.cards[st.k];
  const flash = S.settings.flash || (c.opzioni || []).length < 2;
  el.innerHTML = head(`${st.k + 1} di ${st.cards.length}`, `${c.regione_nome || ''}${c.doc && c.doc !== 'Dal telefono' ? ' · ' + c.doc : ''}`)
    + `<div class="progress"><i style="width:${st.k / st.cards.length * 100}%"></i></div>
    <div class="screen-body"><div class="q md">${renderMd(c.domanda)}</div><div id="qa"></div><div id="qx"></div></div>
    <div class="screen-foot" id="qf"></div>`;
  bindBack(el);
  const qa = el.querySelector('#qa'), qf = el.querySelector('#qf'), qx = el.querySelector('#qx');
  const after = () => {
    if (c.spiegazione) qx.innerHTML = `<div class="expl md">${renderMd(c.spiegazione)}</div>`;
    if (c.loc || c.doc) qx.insertAdjacentHTML('beforeend', `<p class="muted small">Fonte: ${esc(c.doc || '')}${c.loc ? ' · ' + esc(c.loc) : ''}
      ${c.chunk && E.byId.has(c.chunk) ? ' · <button class="linkbtn" id="qSrc">vedi il passaggio</button>' : ''}</p>`);
    qx.querySelector('#qSrc')?.addEventListener('click', () => openChunk(E.chunks[E.byId.get(c.chunk)]));
    mathIn(el);
  };
  const grade = async g => {
    if (g >= 2) st.ok++;
    await reviewCard(c, g);
    st.k++; drawCard(el, st);
  };
  if (flash) {
    qf.innerHTML = `<button class="btn primary">Mostra la risposta</button>`;
    qf.firstElementChild.onclick = () => {
      qa.innerHTML = `<div class="answer md">${renderMd(c.opzioni?.[c.corretta] ?? '')}</div>`;
      after();
      const days = g => srsPreview(c, g).interval;
      qf.innerHTML = `<div class="grades" style="width:100%">${[['😕', 'Non sapevo', 0], ['😐', 'Difficile', 1], ['🙂', 'Sapevo', 2], ['😎', 'Facile', 3]]
        .map(([e, t, g]) => `<button data-g="${g}"><span>${e}</span>${t}<i class="muted small" style="font-style:normal">${whenLabel(days(g))}</i></button>`).join('')}</div>`;
      qf.querySelectorAll('[data-g]').forEach(b => b.onclick = () => grade(+b.dataset.g));
    };
  } else {
    qa.innerHTML = `<div class="opts">${c.opzioni.map((o, j) => `<button data-j="${j}"><span class="k">${j + 1}</span><span class="md">${renderMd(o).replace(/^<p>|<\/p>\s*$/g, '')}</span></button>`).join('')}</div>`;
    qf.innerHTML = `<button class="btn" data-skip>Salta</button>`;
    qf.querySelector('[data-skip]').onclick = () => { st.k++; drawCard(el, st); };
    qa.querySelectorAll('[data-j]').forEach(b => b.onclick = () => {
      if (st.answered) return;
      st.answered = true;
      const j = +b.dataset.j, right = j === c.corretta;
      qa.querySelectorAll('[data-j]').forEach(x => { x.disabled = true; if (+x.dataset.j === c.corretta) x.classList.add('ok'); else if (+x.dataset.j === j) x.classList.add('ko'); });
      qx.innerHTML = `<p><b>${right ? '✅ Giusto!' : '❌ Non proprio.'}</b></p>`;
      after();
      qf.innerHTML = right ? `<button class="btn" data-g="3">😎 Facilissima</button><button class="btn primary" data-g="2">Avanti ›</button>`
        : `<button class="btn primary" data-g="0">Avanti ›</button>`;
      qf.querySelectorAll('[data-g]').forEach(x => x.onclick = () => { st.answered = false; grade(+x.dataset.g); });
    });
  }
  mathIn(el);
}

// ---------------------------------------------------------------- MATERIALE
function brainTag(m) {
  const d = eng.docOf(m.id);
  if (!d) return readable(m.nome, m.mime) ? '<span class="tag dim">fuori dal cervello</span>' : '';
  return { letto: `<span class="tag ok">🧠 ${d.nchunk}</span>`, 'in coda': '<span class="tag">🧠 in lettura</span>',
    'attesa rete': '<span class="tag gold">🧠 in attesa</span>', errore: '<span class="tag bad">🧠 non letto</span>' }[d.stato] || '';
}
function itemMaterial(m) {
  const src = { pc: 'dal PC', drive: 'dal Drive', telefono: 'mio' }[m.fonte] || '';
  const pc = m.al_pc === 'in coda' ? '<span class="tag gold">da inviare al PC</span>' : m.al_pc === 'inviato' ? '<span class="tag">inviato al PC</span>'
    : m.al_pc === 'nel PC' ? '<span class="tag ok">nel PC</span>' : '';
  return `<div class="item" data-m="${m.id}"><span class="ico">${iconOf(m)}</span><span class="t"><b>${esc(m.nome)}</b>
    <span>${fmtSize(m.size)} · ${src} ${brainTag(m)} ${pc}</span></span><button class="act" data-more="${m.id}">⋮</button></div>`;
}
function bindMaterialItems(root) {
  root.querySelectorAll('[data-m]').forEach(el => el.onclick = e => { if (!e.target.closest('[data-more]')) openMaterial(el.dataset.m); });
  root.querySelectorAll('[data-more]').forEach(b => b.onclick = () => materialMenu(b.dataset.more));
}
function renderMaterials(v) {
  const filters = [['tutti', 'Tutti'], ['telefono', 'Miei'], ['drive', 'Dal Drive'], ['pc', 'Dal PC']];
  const list = S.materials.filter(m => matFilter === 'tutti' || m.fonte === matFilter).sort((a, b) => (b.aperto || b.t) - (a.aperto || a.t));
  v.innerHTML = `<h1>Materiale</h1>
    <div class="row" style="margin-bottom:12px">
      <button class="card big grow" id="mDrive" style="text-align:left;margin:0"><span class="ico">📂</span><span class="t"><b>Dal Drive</b><span class="muted small">Importa file</span></span></button>
      <button class="card big grow" id="mFile" style="text-align:left;margin:0"><span class="ico">📎</span><span class="t"><b>Dal telefono</b><span class="muted small">File e foto</span></span></button>
    </div>
    <button class="item" id="mShared" style="margin-bottom:12px"><span class="ico">🔄</span><span class="t"><b>Condivisi nel Drive</b><span>Ciò che PC e telefono si scambiano (BrainOS/Condivisi)</span></span><span>›</span></button>
    <div class="chips">${filters.map(([k, t]) => `<button data-f="${k}" class="${matFilter === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="list">${list.length ? list.map(itemMaterial).join('') : `<div class="empty">Nessun file.<br>Aggiungili dal telefono o importali dal Drive: entrano nel cervello e li leggi anche offline.</div>`}</div>`;
  v.querySelector('#mDrive').onclick = openDriveBrowser;
  v.querySelector('#mFile').onclick = addSheet;
  v.querySelector('#mShared').onclick = openSharedBrowser;
  v.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { matFilter = b.dataset.f; renderMaterials(v); });
  bindMaterialItems(v);
}
function materialMenu(id) {
  const m = S.materials.find(x => x.id === id);
  if (!m) return;
  const d = eng.docOf(id);
  const canPc = !m.al_pc && (m.fonte === 'drive' || m.fonte === 'telefono');
  sheet(`<h3>${esc(m.nome)}</h3><p class="muted small">${fmtSize(m.size)} · ${{ pc: 'mandato dal PC', drive: 'scaricato dal Drive', telefono: 'aggiunto dal telefono' }[m.fonte]}${d ? ' · raccolta ' + esc(d.raccolta) : ''}</p>
    <div class="acts">
      <button class="btn" data-a="open">👁 Apri</button>
      ${d ? '<button class="btn" data-a="doc">📄 Scheda nel cervello (riassunto, quiz…)</button><button class="btn" data-a="out">🧠 Togli dal cervello del telefono</button>'
        : readable(m.nome, m.mime) ? '<button class="btn" data-a="in">🧠 Aggiungi al cervello del telefono</button>' : ''}
      <button class="btn" data-a="drive">☁ Metti nel Drive (BrainOS/Condivisi)</button>
      ${canPc ? '<button class="btn" data-a="pc">💻 Aggiungi al cervello del PC</button>' : ''}
      <button class="btn" data-a="share">↗ Apri con… / Condividi</button>
      <button class="btn danger" data-a="del">🗑 Togli dal telefono</button>
    </div>`, box => box.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'drive') {
      if (!(await ensureLogin())) return;
      return busy(b, async () => { try { await study.fileToDrive(await sync.getMaterialBlob(id), m.nome, m.mime); closeSheet(); toast('☁ Nel Drive, cartella BrainOS/Condivisi'); } catch (e) { toast('⚠ ' + e.message, 4000); } });
    }
    closeSheet();
    if (a === 'open') openMaterial(id);
    if (a === 'doc') openDocSheet(d);
    if (a === 'in') { await setNoBrain(id, false); await eng.addMaterial(m); toast('🧠 Lo sto leggendo'); render(); }
    if (a === 'out') { await setNoBrain(id, true); await eng.removeByMat(id); toast('Tolto dal cervello (il file resta)'); render(); }
    if (a === 'share') shareFile(m, await sync.getMaterialBlob(id));
    if (a === 'pc') { await sync.sendMaterialToPc(id); toast('💻 In coda per il PC'); render(); }
    if (a === 'del') {
      if (m.fonte === 'pc') toast('Lo rimanderà il PC alla prossima sincronizzazione: per toglierlo davvero usa «×» sul PC', 4000);
      await eng.removeByMat(id); await sync.deleteMaterial(id); render();
    }
  }));
}
let noBrain = new Set();
async function setNoBrain(id, v) { v ? noBrain.add(id) : noBrain.delete(id); await db.kset('noBrain', [...noBrain]); }
// ogni materiale leggibile entra nel cervello (salvo quelli tolti a mano)
let reconciling = null;
function reconcile() {   // una sola alla volta: due chiamate insieme creavano documenti doppi
  reconciling = (reconciling || Promise.resolve()).then(reconcileNow, reconcileNow);
  return reconciling;
}
async function reconcileNow() {
  if (!E.ready || S.settings.autoBrain === false) return;
  for (const m of S.materials) if (!noBrain.has(m.id) && !eng.docOf(m.id) && readable(m.nome, m.mime)) await eng.addMaterial(m, m.raccolta);
  for (const d of [...E.docs.values()]) if (d.mat && !S.materials.some(m => m.id === d.mat)) await eng.removeDoc(d.id);
}

async function openMaterial(id, at = {}) {
  const m = S.materials.find(x => x.id === id);
  if (!m) { toast('Il file non è più sul telefono'); return; }
  sync.touchMaterial(id);
  openScreen(async el => {
    el.innerHTML = head(m.nome, fmtSize(m.size) + (at.page ? ` · p. ${at.page}` : ''), '<button class="back" data-share title="Apri con…">↗</button>') + '<div class="screen-body" id="mb"><div class="empty">Apro…</div></div>';
    bindBack(el);
    const blob = await sync.getMaterialBlob(id);
    el.querySelector('[data-share]').onclick = () => shareFile(m, blob);
    const body = el.querySelector('#mb');
    try {
      const info = await showMaterial(m, blob, body, at);
      if (info) el.querySelector('.ttl span').textContent = `${fmtSize(m.size)} · ${info}`;
      if (at.text && !at.page && !at.t) highlightIn(body, at.text);
    } catch (e) {
      body.innerHTML = `<div class="empty">⚠ ${esc(e.message)}<br><br><button class="btn" data-share2>↗ Apri con un'altra app</button></div>`;
      el.querySelector('[data-share2]').onclick = () => shareFile(m, blob);
    }
  });
}
function highlightIn(body, text) {      // evidenzia il passaggio (Word, testo, PowerPoint…)
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  const words = probe.split(' ').slice(0, 6).join(' ');
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const k = n.textContent.indexOf(words);
    if (k >= 0) {
      const r = document.createRange(); r.setStart(n, k); r.setEnd(n, Math.min(n.textContent.length, k + words.length));
      const mark = document.createElement('mark'); r.surroundContents(mark);
      setTimeout(() => mark.scrollIntoView({ block: 'center' }), 80);
      return;
    }
  }
}
function openText(title, sub, text, shareAs) {
  openScreen(el => {
    el.innerHTML = head(title, sub, shareAs ? '<button class="back" data-sh>↗</button>' : '') + `<div class="screen-body"><div class="md">${renderMd(text)}</div></div>`;
    bindBack(el); mathIn(el);
    el.querySelector('[data-sh]')?.addEventListener('click', () => shareMenu(shareAs.nome, { note: [{ titolo: shareAs.nome, testo: shareAs.testo }] }));
  });
}

// importa file del Drive (anche da BrainOS/Condivisi) e li mette nel cervello
async function importFiles(files, { toPc = false, raccolta = '' } = {}) {
  for (const f of files) {
    const id = await sync.importFromDrive(f, { toPc });
    if (raccolta) {
      await sync.setMaterialRaccolta(id, raccolta);
      const d = eng.docOf(id);            // se il cervello l'ha già preso, aggiorno anche lui
      if (d && d.raccolta !== raccolta) await eng.setRaccolta(d.id, raccolta);
    }
  }
  await reconcile();
}

// Esploratore del Drive: cartelle, ricerca, selezione multipla
async function openDriveBrowser() {
  if (!navigator.onLine) { toast('Serve la connessione per sfogliare il Drive'); return; }
  if (!(await ensureLogin())) return;
  const st = { path: [{ id: 'root', name: 'Il mio Drive' }], items: [], sel: new Set(), q: '', mode: 'drive', busy: '' };
  openScreen(el => drawDrive(el, st));
}
async function loadDrive(el, st) {
  st.busy = 'Carico…'; drawDrive(el, st, true);
  try {
    if (st.mode === 'pc') st.items = (S.pack?.materiali || []).map(m => ({ id: m.drive_id, name: m.nome, mimeType: '', size: m.size, pc: true }));
    else if (st.q) st.items = await drive.search(st.q);
    else if (st.mode === 'shared') st.items = await drive.sharedWithMe();
    else st.items = await drive.children(st.path.at(-1).id);
    st.items = st.items.filter(f => !(st.mode === 'drive' && !st.q && st.path.length === 1 && f.name === 'BrainOS'));
    st.busy = '';
  } catch (e) {
    st.busy = '';
    if (e instanceof drive.NeedLogin) { closeScreen(); toast('Accesso scaduto: ricollegati'); return; }
    st.items = []; toast('⚠ ' + e.message, 4000);
  }
  drawDrive(el, st, true);
}
function drawDrive(el, st, loaded = false) {
  if (!loaded) { loadDrive(el, st); }
  const isFolder = f => f.mimeType === drive.FOLDER;
  const have = id => S.materials.some(m => m.drive_id === id);
  el.innerHTML = head('Importa dal Drive', st.sel.size ? `${st.sel.size} selezionati` : 'Tocca i file da portare sul telefono')
    + `<div class="screen-body">
      <div class="seg">${[['drive', 'Il mio Drive'], ['shared', 'Condivisi con me'], ['pc', 'Dal PC']].map(([k, t]) => `<button data-mode="${k}" class="${st.mode === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${st.mode !== 'pc' ? `<input class="search" id="dq" placeholder="🔎 Cerca in tutto il Drive…" value="${esc(st.q)}" style="margin-bottom:10px">` : ''}
      ${st.mode === 'drive' && !st.q ? `<div class="crumbs">${st.path.map((p, k) => `${k ? '<span>›</span>' : ''}<button data-crumb="${k}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      ${st.mode === 'drive' && !st.q && st.path.length > 1 ? `<div class="row" style="margin-bottom:10px;gap:8px"><button class="btn primary grow" id="dTree">📁 Importa tutta la cartella</button><button class="btn" id="dAll">☑ Solo questi file</button></div>` : ''}
      <div class="list">${st.busy ? `<div class="empty">${esc(st.busy)}</div>` : st.items.length ? st.items.map((f, k) => isFolder(f)
        ? `<button class="item" data-dir="${k}"><span class="ico">📁</span><span class="t"><b>${esc(f.name)}</b></span><span>›</span></button>`
        : `<button class="item ${st.sel.has(f.id) ? 'sel' : ''}" data-file="${k}"><span class="chk">${st.sel.has(f.id) ? '✓' : ''}</span>
            <span class="ico">${iconOf({ nome: f.name, mime: f.mimeType })}</span><span class="t"><b>${esc(f.name)}</b>
            <span>${f.size ? fmtSize(f.size) : drive.GOOGLE_EXPORT[f.mimeType] ? 'documento Google → PDF' : ''}${have(f.id) ? ' · <b style="display:inline;color:var(--ok)">già sul telefono</b>' : ''}</span></span></button>`).join('')
        : `<div class="empty">${st.mode === 'pc' ? 'Il PC non ha mandato file. Sul PC apri un documento e premi «📱 Al telefono».' : 'Cartella vuota'}</div>`}</div>
    </div>
    <div class="screen-foot">
      <button class="btn primary" id="dOff" ${st.sel.size ? '' : 'disabled'}>⬇ Sul telefono</button>
      <button class="btn" id="dPc" ${st.sel.size ? '' : 'disabled'}>⬇ + al PC</button>
    </div>`;
  bindBack(el);
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { st.mode = b.dataset.mode; st.q = ''; st.sel.clear(); loadDrive(el, st); });
  el.querySelectorAll('[data-crumb]').forEach(b => b.onclick = () => { st.path = st.path.slice(0, +b.dataset.crumb + 1); loadDrive(el, st); });
  el.querySelectorAll('[data-dir]').forEach(b => b.onclick = () => { const f = st.items[+b.dataset.dir]; st.q = ''; st.mode = 'drive'; st.path.push({ id: f.id, name: f.name }); loadDrive(el, st); });
  el.querySelector('#dAll')?.addEventListener('click', () => { st.items.filter(f => !isFolder(f)).forEach(f => st.sel.add(f.id)); drawDrive(el, st, true); });
  el.querySelector('#dTree')?.addEventListener('click', () => importDriveTree(el, st));
  el.querySelectorAll('[data-file]').forEach(b => b.onclick = () => {
    const f = st.items[+b.dataset.file];
    st.sel.has(f.id) ? st.sel.delete(f.id) : st.sel.add(f.id);
    drawDrive(el, st, true);
  });
  const dq = el.querySelector('#dq');
  if (dq) { let t; dq.oninput = () => { clearTimeout(t); t = setTimeout(() => { st.q = dq.value.trim(); loadDrive(el, st); }, 450); }; }
  const run = async toPc => {
    const files = st.items.filter(f => st.sel.has(f.id));
    const raccolta = st.mode === 'drive' && !st.q && st.path.length > 1 ? st.path.at(-1).name : '';
    let done = 0;
    for (const f of files) {
      st.busy = `Scarico ${++done} di ${files.length}: ${f.name}…`; drawDrive(el, st, true);
      try {
        if (f.pc) await sync.importFromDrive({ id: f.id, name: f.name, mimeType: 'application/octet-stream' });
        else await importFiles([f], { toPc, raccolta });
      } catch (e) { toast(`⚠ ${f.name}: ${e.message}`, 4000); }
    }
    await reconcile();
    st.busy = ''; st.sel.clear();
    toast(`✅ ${plural(files.length, 'file', 'file')} sul telefono e nel cervello${toPc ? ' · in coda per il PC' : ''}`);
    drawDrive(el, st, true);
  };
  el.querySelector('#dOff').onclick = () => run(false);
  el.querySelector('#dPc').onclick = () => run(true);
}

// tutta una cartella del Drive, sottocartelle comprese: la cartella diventa la raccolta
async function importDriveTree(el, st) {
  const top = st.path.at(-1);
  st.busy = `Guardo cosa c'è in «${top.name}»…`; drawDrive(el, st, true);
  const files = [];
  try {
    const walk = async (id, depth) => {
      for (const f of await drive.children(id)) {
        if (f.mimeType === drive.FOLDER) { if (depth < 8) await walk(f.id, depth + 1); }
        else if (readable(f.name, f.mimeType) || drive.GOOGLE_EXPORT[f.mimeType]) files.push(f);
        if (files.length >= 1000) return;
      }
    };
    await walk(top.id, 0);
  } catch (e) { st.busy = ''; toast('⚠ ' + e.message, 4000); drawDrive(el, st, true); return; }
  st.busy = ''; drawDrive(el, st, true);
  const nuovi = files.filter(f => !S.materials.some(m => m.drive_id === f.id));
  if (!nuovi.length) { toast(files.length ? 'Questi file sono già tutti sul telefono' : 'Nessun file leggibile in questa cartella'); return; }
  const mb = nuovi.reduce((a, f) => a + (+f.size || 0), 0) / 1e6;
  if (!confirm(`Importare ${nuovi.length} file da «${top.name}» (circa ${mb < 1 ? '<1' : Math.round(mb)} MB)?${mb > 100 ? '\n\nSono tanti dati: meglio con il Wi‑Fi.' : ''}`)) return;
  let k = 0, errs = 0;
  for (const f of nuovi) {
    st.busy = `Scarico ${++k} di ${nuovi.length}: ${f.name}…`; drawDrive(el, st, true);
    try { await importFiles([f], { raccolta: top.name }); } catch (e) { errs++; }
  }
  await reconcile();
  st.busy = '';
  toast(`📁 «${top.name}»: ${plural(k - errs, 'file importato', 'file importati')} nel cervello${errs ? ` · ${errs} non riusciti` : ''}`, 5000);
  drawDrive(el, st, true);
}

// ------------------------------------------------------------------ nuovi contenuti
// File, cartelle intere e cartelle compresse (.zip): ogni file leggibile entra nel cervello.
// La cartella diventa la "raccolta" (come le cartelle sul PC: dà il nome alle regioni e fa da filtro).
function addSheet() {
  const dirOk = !!window.showDirectoryPicker || 'webkitdirectory' in document.createElement('input');
  sheet(`<h3>➕ Aggiungi al cervello</h3>
    <div class="list">
      <button class="item" data-k="file"><span class="ico">📄</span><span class="t"><b>File</b><span>Uno o più file (tieni premuto per selezionarne tanti)</span></span></button>
      <button class="item" data-k="dir"><span class="ico">📁</span><span class="t"><b>Cartella intera dal telefono</b><span>${dirOk ? 'Con tutte le sottocartelle' : 'Se il telefono non lo permette, usa lo .zip qui sotto'}</span></span></button>
      <button class="item" data-k="drive"><span class="ico">☁</span><span class="t"><b>Cartella dal Drive</b><span>Apri la cartella e premi «Importa tutta la cartella»</span></span></button>
      <button class="item" data-k="zip"><span class="ico">🗜</span><span class="t"><b>Cartella compressa (.zip)</b><span>App Files di Google: tieni premuta la cartella → ⋮ → Comprimi</span></span></button>
    </div>`, box => box.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
    const k = b.dataset.k;
    if (k === 'file') { closeSheet(); $('#pickFile').click(); }
    if (k === 'zip') { closeSheet(); $('#pickZip').click(); }
    if (k === 'drive') { closeSheet(); openDriveBrowser(); }
    if (k === 'dir') {
      closeSheet();
      if (window.showDirectoryPicker) {
        try { const dir = await showDirectoryPicker({ mode: 'read' }); await addFolderHandle(dir); }
        catch (e) { if (e.name !== 'AbortError') { toast('Uso il selettore classico'); $('#pickDir').click(); } }
      } else $('#pickDir').click();
    }
  }));
}
const SKIP = /(^|\/)(\.|__MACOSX\/|node_modules\/|\.git\/|desktop\.ini$|thumbs\.db$)/i;
async function addFolderHandle(dir) {
  const out = [];
  async function walk(h, path) {
    for await (const [name, e] of h.entries()) {
      const rel = path ? `${path}/${name}` : name;
      if (SKIP.test(rel)) continue;
      if (e.kind === 'directory') await walk(e, rel);
      else { const f = await e.getFile(); out.push({ file: f, path: `${dir.name}/${rel}` }); }
      if (out.length > 2000) return;
    }
  }
  toast(`📁 Leggo «${dir.name}»…`, 20000);
  await walk(dir, '');
  await addEntries(out, dir.name);
}
// .zip → file (con il percorso), senza estrarre nulla sul telefono
async function expandZip(f) {
  await script(LIBS.jszip);
  const zip = await JSZip.loadAsync(f);
  const base = f.name.replace(/\.zip$/i, '');
  const out = [];
  for (const e of Object.values(zip.files)) {
    if (e.dir || SKIP.test(e.name)) continue;
    const name = e.name.split('/').pop();
    out.push({ file: new File([await e.async('blob')], name, { type: '' }), path: `${base}/${e.name}` });
  }
  // se lo zip contiene una sola cartella, la raccolta prende il suo nome
  const tops = new Set(out.map(x => x.path.split('/')[1]));
  const single = tops.size === 1 && out.every(x => x.path.split('/').length > 2) ? [...tops][0] : null;
  return { entries: single ? out.map(x => ({ ...x, path: x.path.split('/').slice(1).join('/') })) : out, nome: single || base };
}
async function addEntries(entries, raccolta) {
  const ok = entries.filter(x => readable(x.file.name, x.file.type));
  const skipped = entries.length - ok.length;
  if (!ok.length) { toast(`Nessun file leggibile in «${raccolta}»${skipped ? ` (${skipped} ignorati)` : ''}`, 4000); return; }
  let k = 0;
  for (const x of ok) {
    if (++k % 5 === 1) toast(`📁 ${raccolta}: aggiungo ${k} di ${ok.length}…`, 20000);
    await sync.addLocalFile(x.file, x.file.name, x.file.type, { toPc: false, raccolta });
  }
  await reconcile();
  toast(`📁 «${raccolta}»: ${plural(ok.length, 'file aggiunto', 'file aggiunti')} al cervello${skipped ? ` · ${skipped} non leggibili ignorati` : ''}`, 5000);
  render();
}
async function addFiles(list) {
  const zips = list.filter(f => /\.zip$/i.test(f.name)), plain = list.filter(f => !/\.zip$/i.test(f.name));
  for (const z of zips) {
    try { const { entries, nome } = await expandZip(z); await addEntries(entries, nome); }
    catch (e) { toast(`⚠ ${z.name}: ${e.message}`, 4000); }
  }
  if (!plain.length) return;
  for (const f of plain) await sync.addLocalFile(f, f.name || `foto_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`, f.type, { toPc: false });
  await reconcile();
  toast(`📎 ${plural(plain.length, 'file aggiunto', 'file aggiunti')} al cervello`); render();
}
$('#pickPhoto').onchange = e => { if (e.target.files.length) addFiles([...e.target.files].map(f => new File([f], `foto_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${(f.name.split('.').pop() || 'jpg')}`, { type: f.type }))); e.target.value = ''; };
$('#pickFile').onchange = e => { if (e.target.files.length) addFiles([...e.target.files]); e.target.value = ''; };
$('#pickZip').onchange = e => { if (e.target.files.length) addFiles([...e.target.files]); e.target.value = ''; };
$('#pickDir').onchange = e => {
  const fs = [...e.target.files]; e.target.value = '';
  if (!fs.length) return;
  if (!fs[0].webkitRelativePath) { addFiles(fs); return; }          // il telefono ha aperto il selettore normale
  const nome = fs[0].webkitRelativePath.split('/')[0];
  addEntries(fs.filter(f => !SKIP.test(f.webkitRelativePath)).map(f => ({ file: f, path: f.webkitRelativePath })), nome);
};

function editNote(note, replace = false) {
  (replace ? replaceScreen : openScreen)(el => {
    el.innerHTML = head(note ? 'Modifica nota' : 'Nuova nota', note && !note.mia ? 'Nota del PC: la modifica gli verrà inviata' : 'Entra nel cervello del telefono') + `<div class="screen-body">
      <label class="f">Titolo<input id="nt" value="${esc(note?.titolo || '')}" placeholder="Es. Idea per la tesina"></label>
      <label class="f">Testo<textarea id="nx" placeholder="Scrivi qui… (Markdown e formule $...$)">${esc((note?.testo || '').replace(/^# .*\n+/, ''))}</textarea></label></div>
      <div class="screen-foot"><button class="btn" data-back>Annulla</button><button class="btn primary" id="ns">Salva</button></div>`;
    bindBack(el);
    el.querySelector('#ns').onclick = async () => {
      const t = el.querySelector('#nt').value.trim(), x = el.querySelector('#nx').value.trim();
      if (!t && !x) { toast('La nota è vuota'); return; }
      const titolo = t || x.split('\n')[0].slice(0, 60);
      if (note && !note.mia) await sync.saveNote(note, titolo, x);       // nota del PC
      else await study.saveNote(note, titolo, x);
      toast('📝 Nota salvata'); closeScreen(); render();
    };
  });
}
function openNote(n) {
  openScreen(el => {
    el.innerHTML = head(n.titolo, `${ago(n.modificata)}${n.mia ? '' : ' · dal PC'}${n.inAttesa ? ' · da inviare' : ''}`, '<button class="back" data-sh>↗</button><button class="back" data-edit>✏</button>')
      + `<div class="screen-body"><div class="md">${renderMd(n.testo)}</div>
      ${n.mia ? `<div class="row" style="margin-top:24px"><button class="btn grow" id="nPc">💻 Manda al PC</button><button class="btn danger" id="nDel">🗑</button></div>` : ''}</div>`;
    bindBack(el); mathIn(el);
    el.querySelector('[data-edit]').onclick = () => editNote(n, true);
    el.querySelector('[data-sh]').onclick = () => shareMenu(n.titolo, { note: [n] });
    el.querySelector('#nPc')?.addEventListener('click', async () => { await sync.saveNote(null, n.titolo, n.testo); toast('💻 In coda per il PC'); });
    el.querySelector('#nDel')?.addEventListener('click', async () => { if (confirm('Eliminare la nota dal telefono?')) { await study.deleteNote(n.id); closeScreen(); render(); } });
  });
}
function editCard() {
  openScreen(el => {
    el.innerHTML = head('Nuova flashcard', 'Entra nel ripasso del telefono') + `<div class="screen-body">
      <label class="f">Domanda<textarea id="cq" style="min-height:110px" placeholder="Es. Enuncia il teorema di Rolle"></textarea></label>
      <label class="f">Risposta<textarea id="ca" style="min-height:140px" placeholder="Formule tra $...$"></textarea></label>
      <label class="f">Argomento<input id="cg" placeholder="Es. Analisi 1" value="${esc(S.settings.lastTopic || '')}"></label></div>
      <div class="screen-foot"><button class="btn" id="cmore">Salva e un'altra</button><button class="btn primary" id="cs">Salva</button></div>`;
    bindBack(el);
    const save = async again => {
      const q = el.querySelector('#cq').value.trim(), a = el.querySelector('#ca').value.trim(), g = el.querySelector('#cg').value.trim();
      if (!q || !a) { toast('Scrivi domanda e risposta'); return; }
      await study.addCards([{ domanda: q, opzioni: [a], regione_nome: g || 'Mie carte', origine: 'a mano' }]);
      if (g !== (S.settings.lastTopic || '')) sync.saveSettings({ lastTopic: g });
      toast('🃏 Flashcard salvata');
      if (again) { el.querySelector('#cq').value = ''; el.querySelector('#ca').value = ''; el.querySelector('#cq').focus(); }
      else { closeScreen(); render(); }
    };
    el.querySelector('#cs').onclick = () => save(false);
    el.querySelector('#cmore').onclick = () => save(true);
  });
}

// -------------------------------------------------------------- IMPOSTAZIONI
function openSettings() {
  openScreen(async el => {
    const info = await sync.storageInfo();
    el.innerHTML = head('Impostazioni') + `<div class="screen-body">
      <h2 style="margin-top:0">AI (gratis)</h2>
      <div class="card">
        <p class="small muted">Le chiavi restano solo su questo telefono. Ordine: Gemini → Gemini Lite → Groq, come sul PC.</p>
        <label class="f">Chiave Gemini <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">crea ›</a><input id="kG" type="password" placeholder="${ai.K.gemini ? '•••••• impostata (scrivi per cambiarla)' : 'AIza…'}" autocomplete="off"></label>
        <label class="f">Chiave Groq (riserva veloce, trascrizioni) <a href="https://console.groq.com/keys" target="_blank" rel="noopener">crea ›</a><input id="kQ" type="password" placeholder="${ai.K.groq ? '•••••• impostata (scrivi per cambiarla)' : 'gsk_…'}" autocomplete="off"></label>
        <div class="row"><button class="btn primary grow" id="kSave">Salva le chiavi</button><button class="btn" id="kTest">Prova</button></div>
        <p class="small" id="kOut"></p>
        <p class="small muted">Gemini serve per: risposte con ricerca Google, significati dei testi, OCR di foto e scansioni. Groq: risposte di riserva e trascrizione degli audio.</p>
      </div>
      <h2>Cervello</h2>
      <div class="card">
        <label class="switch"><input type="checkbox" id="sAuto" ${S.settings.autoBrain !== false ? 'checked' : ''}><div>Metti nel cervello ogni file nuovo<span>File del telefono, del Drive e mandati dal PC</span></div></label>
        <p class="small muted">${fmtN(E.docs.size)} documenti · ${fmtN(E.chunks.length)} frammenti · ${fmtN(E.chunks.filter(c => c.vec).length)} con significato${info ? ` · spazio usato ${fmtSize(info.usage)}` : ''}</p>
        <button class="btn block" id="sStat">📊 Stato e coda di lettura</button>
      </div>
      <h2>Drive e PC</h2>
      <button class="item" id="sSync"><span class="ico">☁</span><span class="t"><b>Sincronizzazione con il PC</b><span>${drive.hasValidToken() ? esc(drive.account() || 'Collegato') : 'Accesso a Google, coda «Da inviare», registro'}</span></span><span>›</span></button>
      <h2>Zona pericolosa</h2>
      <button class="btn danger block" id="sWipe">Cancella tutti i dati di questo telefono</button>
    </div>`;
    bindBack(el);
    el.querySelector('#kSave').onclick = async () => {
      const g = el.querySelector('#kG').value.trim(), q = el.querySelector('#kQ').value.trim();
      const patch = {}; if (g) patch.gemini = g; if (q) patch.groq = q;
      if (!g && !q) { toast('Scrivi almeno una chiave'); return; }
      await ai.save(patch); toast('🔑 Salvate'); eng.pump(); replaceScreen(screens.at(-1));
    };
    el.querySelector('#kTest').onclick = e => busy(e.target, async () => {
      const out = el.querySelector('#kOut');
      try { const r = await ai.generate('Rispondi solo con: ok'); out.innerHTML = `✅ Funziona (${esc(r.modello)})`; }
      catch (er) { out.innerHTML = `<span style="color:var(--ko)">⚠ ${esc(er.message)}</span>`; }
    });
    el.querySelector('#sAuto').onchange = e => { sync.saveSettings({ autoBrain: e.target.checked }); if (e.target.checked) reconcile(); };
    el.querySelector('#sStat').onclick = brainStatus;
    el.querySelector('#sSync').onclick = openSyncScreen;
    el.querySelector('#sWipe').onclick = async () => {
      if (!confirm('Cancellare tutti i dati di BrainOS da questo telefono (cervello, file, carte, note, chat)? Il Drive e il PC non vengono toccati.')) return;
      await sync.wipe(); await eng.wipe(); location.reload();
    };
  });
}

// --------------------------------------------------------------------- SYNC
function openSyncScreen() {
  openScreen(async el => {
    const out = sync.outbox();
    const waiting = sync.waitingPc();
    const logged = drive.hasValidToken();
    el.innerHTML = head('Drive e PC', 'Scambi solo quando lo chiedi tu') + `<div class="screen-body">
    <div class="card">
      <div class="row"><span style="font-size:26px">☁</span><div class="grow"><b>${logged ? esc(drive.account() || 'Collegato') : 'Google Drive'}</b>
        <div class="muted small">${S.syncing ? esc(S.progress || 'Sincronizzo…') : `Ultima sincronizzazione: ${ago(S.lastSync)}`}</div></div></div>
      ${S.error ? `<p class="small" style="color:var(--ko)">⚠ ${esc(S.error)}</p>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="btn primary grow" id="yNow" ${S.syncing ? 'disabled' : ''}>${logged ? '⟳ Sincronizza ora' : 'Accedi con Google'}</button>
        ${logged ? '<button class="btn" id="yOut">Esci</button>' : ''}
      </div>
    </div>
    <p class="muted small">Il telefono ha il suo cervello. Con il PC si scambia solo ciò che scegli: «💻 Al PC» e «☁ Nel Drive» sui file, sulle carte e sulle note; dal PC arrivano i file che mandi con «📱 Al telefono» e, se vuoi, le sue carte e i riassunti.</p>
    <h2>Da inviare al PC (${out.length})</h2>
    <div class="list">${out.length ? out.map((it, k) => `<div class="item"><span class="ico">${it.icona}</span><span class="t"><b>${esc(it.titolo)}</b>
      <span>${it.size ? fmtSize(it.size) + ' · ' : ''}${ago(it.t)}</span></span><button class="act" data-del="${k}" title="Togli dalla coda">×</button></div>`).join('')
      : '<div class="empty">Niente in coda ✓</div>'}</div>
    ${waiting ? `<p class="muted small">⏳ ${waiting} modifiche già nel Drive, in attesa che il PC le applichi (quando BrainOS è acceso sul PC).</p>` : ''}
    <h2>Impostazioni</h2>
    <div class="card">
      <label class="switch"><input type="checkbox" id="yAuto" ${S.settings.autoSync ? 'checked' : ''}><div>Sincronizza da solo<span>Quando apri l'app, dopo ogni invio e ogni 5 minuti</span></div></label>
      <label class="switch"><input type="checkbox" id="yPack" ${S.settings.pcPack !== false ? 'checked' : ''}><div>Ricevi carte, riassunti e note del PC<span>Spento: il telefono resta del tutto separato</span></div></label>
      <label class="switch"><input type="checkbox" id="yPc" ${S.settings.autoPc ? 'checked' : ''}><div>Scarica i file mandati dal PC<span>Quelli che sul PC mandi con «📱 Al telefono»</span></div></label>
      <label class="f" style="margin-top:8px">Client ID di Google<input id="yCid" value="${esc(S.settings.clientId)}" placeholder="…apps.googleusercontent.com"></label>
      <button class="btn" id="ySave">Salva Client ID</button>
      <p class="muted small">Dispositivo: ${esc(S.device)}</p>
    </div>
    <h2>Registro</h2><div class="card log" id="yLog"><div class="muted">…</div></div></div>`;
    bindBack(el);
    el.querySelector('#yNow').onclick = async () => { await doSync(true); replaceScreen(screens.at(-1)); };
    el.querySelector('#yOut')?.addEventListener('click', async () => { await drive.logout(); replaceScreen(screens.at(-1)); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const it = out[+b.dataset.del];
      if (!confirm(`Togliere dalla coda «${it.titolo}»? Non verrà inviato al PC.`)) return;
      await sync.removeOutbox(it); replaceScreen(screens.at(-1));
    });
    el.querySelector('#yAuto').onchange = e => sync.saveSettings({ autoSync: e.target.checked });
    el.querySelector('#yPack').onchange = e => sync.saveSettings({ pcPack: e.target.checked });
    el.querySelector('#yPc').onchange = e => sync.saveSettings({ autoPc: e.target.checked });
    el.querySelector('#ySave').onclick = async () => { await sync.saveSettings({ clientId: el.querySelector('#yCid').value.trim() }); toast('Salvato'); };
    const log = await sync.logEntries();
    el.querySelector('#yLog').innerHTML = log.length ? log.slice(0, 40).map(l => `<div><time>${ago(l.t)}</time><span>${esc(l.testo)}</span></div>`).join('') : '<div class="muted">Ancora niente.</div>';
  });
}

// ------------------------------------------------------------------ avvio
let rT;
const softRender = () => {
  updateChrome();
  if (screens.length || document.activeElement?.matches?.('input, textarea, select')) return;
  if (tab === 'chiedi') return;            // la chat si aggiorna da sola
  clearTimeout(rT); rT = setTimeout(render, 120);
};
sync.onChange(() => { softRender(); reconcile(); });
eng.onChange(softRender);
addEventListener('online', () => { updateChrome(); sync.scheduleSync(500); eng.pump(); });
addEventListener('offline', updateChrome);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync.scheduleSync(800); eng.pump(); } });
setInterval(() => sync.scheduleSync(0), 5 * 60 * 1000);

try {
  await sync.init();
  noBrain = new Set(await db.kget('noBrain', []));
  await study.load();
  await eng.load();
} catch (e) {
  (window.__bosErrors || []).push('Avvio: ' + (e?.message || e));
  throw e;
}
window.__bosStarted = true;
setupBrainHost(); setupChatHost();
go('oggi');
reconcile();
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
sync.scheduleSync(1500);
