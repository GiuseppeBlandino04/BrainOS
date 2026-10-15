// Domande al cervello del telefono: stesso sistema del PC (ricerca ibrida → fonti numerate →
// web se le fonti non bastano → risposta a pezzi con citazioni [n] e [Wn]).
import * as db from './db.js';
import * as ai from './ai.js';
import { E, search, addText } from './engine.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16));
const now = () => Date.now() / 1000;
const SOGLIA_WEB = 0.6;      // somiglianza sotto cui le fonti "non bastano"

export const NO_AI = '**Nessuna AI collegata.** Ecco comunque i passaggi dei tuoi documenti più vicini alla domanda (li vedi accesi nel cervello).\n\n' +
  'Per avere risposte complete vai su ⚙ Impostazioni e inserisci una chiave gratuita di Gemini o Groq.';

// opts: { web: 'auto'|'sempre'|'mai', filtro, storia, onFonti, onStato, onTesto, signal }
export async function ask(q, opts = {}) {
  q = q.trim(); if (!q) throw new Error('Domanda vuota');
  const mode = opts.web || 'auto';
  const r = await search(q, 8, opts.filtro || {});
  let hits = r.hits;
  if (r.semantica) hits = hits.filter(h => (h.score_vec ?? 0) >= SOGLIA_WEB * 0.75 || h.parole).slice(0, 8);
  if (!hits.length) hits = r.hits.slice(0, 3);
  const fonti = hits.map((h, k) => ({
    n: k + 1, id: h.chunk.id, doc: h.doc?.id, nome: h.doc?.nome || '', loc: h.chunk.loc, page: h.chunk.page, t: h.chunk.t,
    estratto: h.chunk.text.replace(/\s+/g, ' ').slice(0, 300), testo: h.chunk.text, score: +(h.score_vec ?? h.score).toFixed(3),
  }));
  opts.onFonti?.(fonti);
  const ctx = fonti.map(f => `[${f.n}] ${f.nome}${f.loc ? ' — ' + f.loc : ''}\n${f.testo.slice(0, 1600)}`);
  let prompt = ctx.length ? 'FONTI DELL\'UTENTE:\n\n' + ctx.join('\n\n') : 'FONTI DELL\'UTENTE: nessuna fonte disponibile.';
  const weak = r.semantica ? (r.best ?? 0) < SOGLIA_WEB : !hits.some(h => h.parole);
  let useWeb = mode === 'sempre' || (mode === 'auto' && weak);
  let nota = null;
  if (useWeb && !ai.K.gemini) { nota = 'Ricerca web non disponibile: serve la chiave Gemini.'; useWeb = false; }
  if (useWeb) {
    opts.onStato?.('Cerco anche sul web…');
    if (mode === 'auto') prompt += '\n\n(Le fonti dell\'utente sembrano poco pertinenti: cerca sul web e integra, citando come [W1], [W2]…)';
    else prompt += '\n\n(Cerca anche sul web e cita i risultati come [W1], [W2]…)';
  }
  prompt += `\n\nDOMANDA: ${q}`;
  const info = {};
  let text = '';
  try {
    for await (const piece of ai.stream(prompt, { history: (opts.storia || []).slice(-6), web: useWeb, info, signal: opts.signal })) {
      text += piece; opts.onTesto?.(piece, text);
    }
  } catch (e) {
    if (e.name === 'AbortError') { text += '\n\n_(interrotta)_'; }
    else if (e instanceof ai.NoAI) { text = NO_AI; info.modello = 'nessuno'; }
    else { text = `**L'AI non ha risposto:** ${e.message}\n\nQui sotto trovi comunque le fonti più pertinenti.`; info.modello = 'errore'; }
    opts.onTesto?.('', text);
  }
  const used = new Set([...text.matchAll(/\[(\d+)\]/g)].map(m => +m[1]));
  fonti.forEach(f => { f.citata = used.has(f.n); });
  // i numeri [Wn] seguono l'ordine dei risultati web di Gemini
  const web = info.web || [];
  return { domanda: q, risposta: text, fonti, web, modello: info.modello || '—', nota: [nota, info.nota].filter(Boolean).join(' ') || null,
    web_usato: web.length > 0, pertinenza: r.best, semantica: r.semantica };
}

// ------------------------------------------------------------- conversazioni
export async function chats() { return (await db.all('chats')).sort((a, b) => b.t - a.t); }
export async function getChat(id) { return db.get('chats', id); }
export async function saveChat(chat) {
  if (!chat.id) chat.id = uid();
  chat.t = now();
  if (!chat.titolo) chat.titolo = chat.messaggi.find(m => m.ruolo === 'utente')?.testo.slice(0, 70) || 'Conversazione';
  await db.put('chats', chat);
  return chat;
}
export const deleteChat = id => db.del('chats', id);

// "Salva nel cervello": la risposta diventa un documento (pesa come gli altri, ma sta in "Risposte salvate")
export async function saveAnswer(msg, domanda) {
  const fonti = (msg.fonti || []).filter(f => f.citata).map(f => `[${f.n}] ${f.nome}${f.loc ? ' — ' + f.loc : ''}`).join('\n');
  const testo = `# ${domanda}\n\n${msg.testo}\n\n---\nFonti:\n${fonti}`;
  return addText('risposta', uid(), domanda.slice(0, 80), testo, 'Risposte salvate');
}
