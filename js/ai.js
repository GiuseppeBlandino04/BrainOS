// AI del telefono: Gemini (con ricerca Google) → riserva flash-lite → Groq. Stesse regole del PC.
// Le chiavi restano solo su questo telefono (IndexedDB).
import * as db from './db.js';

export const SYSTEM = `Sei BrainOS, il "secondo cervello" dell'utente: conosci i suoi documenti, appunti, registrazioni e progetti.
Regole:
- Rispondi sempre in italiano, in modo chiaro e ordinato (usa Markdown quando aiuta).
- Basati prima di tutto sulle FONTI DELL'UTENTE fornite. Cita ogni informazione presa da lì con il numero tra parentesi quadre, per esempio [2] o [1][3].
- Collega i concetti tra fonti diverse quando è utile: è il tuo punto di forza.
- Se ricevi RISULTATI WEB o cerchi sul web, usali per ciò che le fonti dell'utente non coprono e citali come [W1], [W2]…
- Se le fonti non bastano, dillo chiaramente; puoi usare le tue conoscenze generali dichiarandolo ("Conoscenza generale:").
- Non inventare citazioni, pagine o contenuti che non sono nelle fonti.`;

const GEM = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ = 'https://api.groq.com/openai/v1';
export const URLS = { GEM, GROQ };   // sovrascrivibili nei test
export const EMBED_MODEL = 'gemini-embedding-001';
export const EMBED_DIM = 256;

export const K = { gemini: '', groq: '', geminiModel: 'gemini-flash-latest', geminiRiserva: 'gemini-flash-lite-latest', groqModel: 'openai/gpt-oss-120b' };
export async function load() { Object.assign(K, await db.kget('ai', {})); return K; }
export async function save(patch) { Object.assign(K, patch); await db.kset('ai', { ...K }); }
export const available = () => !!(K.gemini || K.groq);
export const canEmbed = () => !!K.gemini;
export class NoAI extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = s => String(s || '').replace(/\s+/g, ' ').slice(0, 180);

async function post(url, body, headers = {}, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!r.ok) {
    let msg = ''; try { const j = await r.json(); msg = j.error?.message || JSON.stringify(j); } catch { msg = await r.text().catch(() => ''); }
    const e = new Error(`${r.status} ${short(msg)}`); e.status = r.status; throw e;
  }
  return r;
}
const retryable = e => [429, 500, 502, 503, 504].includes(e.status) || e.name === 'TypeError';

// ------------------------------------------------------------- Gemini
function gemBody(system, prompt, history, { web = false, json = false, parts = null, temperature } = {}) {
  const contents = (history || []).map(h => ({ role: h.ruolo === 'assistente' ? 'model' : 'user', parts: [{ text: h.testo }] }));
  contents.push({ role: 'user', parts: parts || [{ text: prompt }] });
  const b = { contents, generationConfig: {} };
  if (system) b.systemInstruction = { parts: [{ text: system }] };
  if (web) b.tools = [{ google_search: {} }];
  if (json) b.generationConfig.responseMimeType = 'application/json';
  if (temperature !== undefined) b.generationConfig.temperature = temperature;
  return b;
}
function gemWeb(cand) {
  const out = [];
  for (const c of cand?.groundingMetadata?.groundingChunks || []) if (c.web?.uri) out.push({ titolo: c.web.title || c.web.uri, url: c.web.uri });
  return out;
}
async function* gemStream(model, body, info, signal) {
  const r = await post(`${GEM}/models/${model}:streamGenerateContent?alt=sse`, body, { 'x-goog-api-key': K.gemini }, signal);
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0 || (k = buf.indexOf('\r\n\r\n')) >= 0) {
      const ev = buf.slice(0, k); buf = buf.slice(k + (buf[k] === '\r' ? 4 : 2));
      const line = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const cand = j.candidates?.[0];
      const w = gemWeb(cand); if (w.length) info.web = w;
      const t = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (t) yield t;
    }
  }
}
async function gemOnce(model, body, signal) {
  const r = await post(`${GEM}/models/${model}:generateContent`, body, { 'x-goog-api-key': K.gemini }, signal);
  const j = await r.json();
  const cand = j.candidates?.[0];
  return { testo: (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''), web: gemWeb(cand) };
}

// --------------------------------------------------------------- Groq
function groqMsgs(system, prompt, history) {
  return [{ role: 'system', content: system }, ...(history || []).map(h => ({ role: h.ruolo === 'assistente' ? 'assistant' : 'user', content: h.testo })),
    { role: 'user', content: prompt }];
}
async function* groqStream(body, signal) {
  const r = await post(`${GROQ}/chat/completions`, { ...body, stream: true }, { Authorization: `Bearer ${K.groq}` }, signal);
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      const d = l.replace(/^data:\s*/, '').trim();
      if (!d || d === '[DONE]' || !l.startsWith('data:')) continue;
      try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t; } catch { /* riga incompleta */ }
    }
  }
  // ultima riga senza "a capo", o risposta non a pezzi (alcuni proxy ignorano stream)
  const rest = buf.trim().replace(/^data:\s*/, '');
  if (rest && rest !== '[DONE]') {
    try { const j = JSON.parse(rest); const t = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content; if (t) yield t; } catch { /* niente */ }
  }
}

// ------------------------------------------------- catena con riserve (testo a pezzi)
export async function* stream(prompt, { history = [], web = false, system = SYSTEM, info = {}, signal } = {}) {
  if (!available()) throw new NoAI('Nessuna chiave AI');
  const errors = [];
  const attempts = [];
  if (K.gemini) { attempts.push(['gemini', K.geminiModel]); if (K.geminiRiserva) attempts.push(['gemini', K.geminiRiserva]); }
  if (K.groq) attempts.push(['groq', K.groqModel]);
  for (const [b, model] of attempts) {
    for (let tries = 0; tries < 2; tries++) {
      let gave = false;
      try {
        const it = b === 'gemini' ? gemStream(model, gemBody(system, prompt, history, { web }), info, signal)
          : groqStream({ model, messages: groqMsgs(system, prompt, history) }, signal);
        info.modello = b === 'gemini' ? `Gemini (${model.replace('-latest', '')})` : `Groq (${model.split('/').pop()})`;
        for await (const t of it) { gave = true; yield t; }
        if (!gave) throw Object.assign(new Error('risposta vuota'), { status: 503 });
        if (errors.length) info.nota = `Riserva usata: ${errors.join(' · ')}`;
        return;
      } catch (e) {
        if (gave || e.name === 'AbortError') throw e;          // a metà risposta non si cambia AI
        if (retryable(e) && tries === 0 && e.status !== 429) { await sleep(1200); continue; }
        errors.push(`${b}: ${short(e.message).slice(0, 60)}`);
        break;
      }
    }
  }
  throw new Error('Nessuna AI ha risposto (' + errors.join(' · ') + ')');
}

// risposta intera (per riassunti, quiz, nomi…); json=true chiede e interpreta JSON
export async function generate(prompt, { system = '', json = false, web = false, parts = null, temperature } = {}) {
  if (!available()) throw new NoAI('Nessuna chiave AI');
  const errors = [];
  const attempts = [];
  if (K.gemini) { attempts.push(['gemini', K.geminiModel]); if (K.geminiRiserva) attempts.push(['gemini', K.geminiRiserva]); }
  if (K.groq && !parts) attempts.push(['groq', K.groqModel]);
  for (const [b, model] of attempts) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        let res;
        if (b === 'gemini') res = await gemOnce(model, gemBody(system, prompt, [], { web, json, parts, temperature }));
        else {
          const body = { model, messages: groqMsgs(system || 'Rispondi in italiano.', prompt, []) };
          if (json) body.response_format = { type: 'json_object' };
          const r = await post(`${GROQ}/chat/completions`, body, { Authorization: `Bearer ${K.groq}` });
          res = { testo: (await r.json()).choices?.[0]?.message?.content || '', web: [] };
        }
        if (!res.testo.trim()) throw Object.assign(new Error('risposta vuota'), { status: 503 });
        res.modello = b;
        if (json) res.json = parseJson(res.testo);
        return res;
      } catch (e) {
        if (retryable(e) && tries === 0 && e.status !== 429) { await sleep(1500); continue; }
        if (e instanceof SyntaxError && tries === 0) continue;
        errors.push(`${b}: ${short(e.message).slice(0, 60)}`);
        break;
      }
    }
  }
  throw new Error('Nessuna AI ha risposto (' + errors.join(' · ') + ')');
}

export function parseJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* cerco il primo oggetto o elenco */ }
  const a = t.search(/[[{]/), z = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && z > a) return JSON.parse(t.slice(a, z + 1));
  throw new SyntaxError('JSON non valido');
}

// ------------------------------------------------------------ embeddings
// Vettori da 256 numeri, normalizzati. Restituisce Float32Array[]; lancia se non c'è la chiave.
export async function embed(texts, task = 'RETRIEVAL_DOCUMENT') {
  if (!K.gemini) throw new NoAI('Serve la chiave Gemini per i significati');
  const out = [];
  for (let k = 0; k < texts.length; k += 100) {
    const batch = texts.slice(k, k + 100);
    let j;
    for (let tries = 0; ; tries++) {
      try {
        const r = await post(`${GEM}/models/${EMBED_MODEL}:batchEmbedContents`, {
          requests: batch.map(t => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text: t.slice(0, 6000) }] }, taskType: task, outputDimensionality: EMBED_DIM })),
        }, { 'x-goog-api-key': K.gemini });
        j = await r.json(); break;
      } catch (e) {
        if (tries < 3 && retryable(e)) { await sleep(e.status === 429 ? 20000 : 2000 * (tries + 1)); continue; }
        throw e;
      }
    }
    for (const e of j.embeddings || []) {
      const v = Float32Array.from(e.values || []);
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      out.push(v);
    }
  }
  return out;
}

// ------------------------------------------------------- vista: OCR e immagini
export async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
export async function readImage(blob, mime, hint = '') {
  if (!K.gemini) throw new NoAI('Serve la chiave Gemini per leggere immagini e scansioni');
  const parts = [{ inline_data: { mime_type: mime || blob.type || 'image/jpeg', data: await blobToB64(blob) } },
    { text: 'Trascrivi fedelmente tutto il testo di questa immagine in Markdown (formule in LaTeX tra $...$). ' +
      'Se ci sono schemi, grafici o figure senza testo, descrivili brevemente tra [ ]. ' + hint + ' Scrivi solo la trascrizione.' }];
  return (await generate('', { parts, temperature: 0 })).testo;
}

// ---------------------------------------------------- audio: Whisper di Groq, poi Gemini
export async function transcribe(blob, name) {
  if (K.groq && blob.size <= 24.5e6) {
    const fd = new FormData();
    fd.append('file', blob, name || 'audio.m4a');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('response_format', 'verbose_json');
    fd.append('language', 'it');
    const r = await fetch(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${K.groq}` }, body: fd });
    if (r.ok) {
      const j = await r.json();
      return (j.segments || [{ start: 0, text: j.text }]).map(s => ({ t: s.start || 0, text: (s.text || '').trim() }));
    }
  }
  if (K.gemini && blob.size <= 19e6) {
    const parts = [{ inline_data: { mime_type: blob.type || 'audio/mp4', data: await blobToB64(blob) } },
      { text: 'Trascrivi questo audio in italiano. Ogni 30-60 secondi inizia una riga con il minuto tra parentesi quadre, es. [03:20].' }];
    const t = (await generate('', { parts, temperature: 0 })).testo;
    const segs = [];
    for (const part of t.split(/(?=\[\d{1,2}:\d{2}\])/)) {
      const m = part.match(/^\[(\d{1,2}):(\d{2})\]\s*/);
      segs.push({ t: m ? +m[1] * 60 + +m[2] : 0, text: part.replace(/^\[\d{1,2}:\d{2}\]\s*/, '').trim() });
    }
    return segs.filter(s => s.text);
  }
  throw new NoAI(blob.size > 24.5e6 ? 'File audio troppo grande per la trascrizione dal telefono (max 25 MB)' : 'Serve una chiave Groq o Gemini per trascrivere');
}
