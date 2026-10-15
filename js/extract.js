// Lettura dei file sul telefono: restituisce i "segmenti" di testo con la posizione
// (pagina, diapositiva, minuto, foglio) e le pagine che hanno bisogno dell'OCR.
import { script, LIBS, pdfLib } from './viewer.js';
import * as ai from './ai.js';

const extOf = n => (String(n).split('.').pop() || '').toLowerCase();
export const TEXT_EXT = ['txt', 'md', 'markdown', 'tex', 'json', 'jsonl', 'py', 'js', 'ts', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php',
  'html', 'htm', 'css', 'log', 'sql', 'xml', 'yaml', 'yml', 'ipynb', 'r', 'm', 'kt', 'swift', 'sh', 'bat'];
export const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'opus', 'flac', 'mp4', 'mov', 'webm', 'mkv', '3gp'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'bmp'];

export function readable(name, mime = '') {
  const e = extOf(name);
  return e === 'pdf' || ['docx', 'pptx', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(e) || TEXT_EXT.includes(e)
    || AUDIO_EXT.includes(e) || IMAGE_EXT.includes(e) || mime.startsWith('text/') || mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/');
}
export const needsNet = name => AUDIO_EXT.includes(extOf(name)) || IMAGE_EXT.includes(extOf(name));

const clean = t => String(t || '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function tableToText(rows, maxRows = 400) {
  // tabelle piccole per intero; quelle grandi diventano una scheda (colonne + righe di esempio)
  const head = rows[0] || [];
  if (rows.length <= maxRows) return rows.map(r => r.join(' | ')).join('\n');
  const sample = rows.slice(1, 16).map(r => r.join(' | ')).join('\n');
  return `Tabella di dati con ${rows.length - 1} righe e ${head.length} colonne.\nColonne: ${head.join(', ')}\nEsempi:\n${sample}`;
}
function csvRows(text) {
  const first = text.split('\n')[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : first.includes('\t') ? '\t' : ',';
  return text.split(/\r?\n/).filter(Boolean).slice(0, 20000).map(l => l.split(sep));
}

// Restituisce { segs: [{text, loc, page?, t?}], ocr: [numeri di pagina senza testo], info }
export async function extract(blob, name, mime = '', { onProgress } = {}) {
  const e = extOf(name);
  mime = mime || blob.type || '';
  if (e === 'pdf' || mime === 'application/pdf') {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const segs = [], ocr = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (p % 10 === 0) onProgress?.(`pagina ${p} di ${doc.numPages}`);
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '', out = '', lastY = null;
      for (const it of tc.items) {
        const y = it.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) { out += line + '\n'; line = ''; }
        line += it.str + (it.hasEOL ? '\n' : '');
        lastY = y;
      }
      out = clean(out + line);
      if (out.replace(/\s/g, '').length < 40) ocr.push(p);
      else segs.push({ text: out, loc: `p. ${p}`, page: p });
    }
    return { segs, ocr, info: `${doc.numPages} pagine` };
  }
  if (e === 'docx') {
    await script(LIBS.mammoth);
    const r = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
    return { segs: [{ text: clean(r.value), loc: '' }], ocr: [] };
  }
  if (e === 'pptx') {
    await script(LIBS.jszip);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
    const segs = [];
    for (const f of slides) {
      const n = +f.match(/(\d+)\.xml/)[1];
      const xml = await zip.file(f).async('string');
      let txt = xml.split(/<\/a:p>/).map(p => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join('')).filter(Boolean).join('\n');
      const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
      if (notes) {
        const nt = [...(await notes.async('string')).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join(' ').trim();
        if (nt && !/^\d+$/.test(nt)) txt += '\nNote: ' + nt;
      }
      txt = clean(txt.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
      if (txt) segs.push({ text: txt, loc: `diapositiva ${n}`, page: n });
    }
    return { segs, ocr: [], info: `${slides.length} diapositive` };
  }
  if (['xlsx', 'xlsm', 'xls'].includes(e)) {
    await script(LIBS.xlsx);
    const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
    return { segs: wb.SheetNames.map(n => ({ text: tableToText(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' })), loc: `foglio ${n}` })), ocr: [] };
  }
  if (['csv', 'tsv'].includes(e)) return { segs: [{ text: tableToText(csvRows(await blob.text())), loc: '' }], ocr: [] };
  if (IMAGE_EXT.includes(e) || mime.startsWith('image/')) {
    onProgress?.('leggo l\'immagine…');
    const t = await ai.readImage(blob, mime);
    return { segs: [{ text: clean(t), loc: 'immagine' }], ocr: [] };
  }
  if (AUDIO_EXT.includes(e) || mime.startsWith('audio/') || mime.startsWith('video/')) {
    onProgress?.('trascrivo…');
    const parts = await ai.transcribe(blob, name);
    // gruppi di circa un minuto, con il minuto di inizio
    const segs = []; let cur = null;
    for (const p of parts) {
      if (!cur || p.t - cur.t > 60 || cur.text.length > 900) { cur = { text: '', t: p.t, loc: `min ${mmss(p.t)}` }; segs.push(cur); }
      cur.text += (cur.text ? ' ' : '') + p.text;
    }
    return { segs, ocr: [], info: parts.length ? `trascritto, ${mmss(parts.at(-1).t)}` : '' };
  }
  if (TEXT_EXT.includes(e) || mime.startsWith('text/') || !e) {
    let t = await blob.text();
    if (e === 'html' || e === 'htm') t = new DOMParser().parseFromString(t, 'text/html').body?.innerText || t;
    if (e === 'ipynb') { try { t = JSON.parse(t).cells.map(c => [].concat(c.source).join('')).join('\n\n'); } catch { /* lo leggo come testo */ } }
    if (e === 'jsonl' || (t.length > 200000 && /^[\[{]/.test(t.trim()))) {
      const lines = t.split('\n').filter(Boolean);
      t = `File di dati con ${lines.length} righe.\nEsempi:\n${lines.slice(0, 10).map(l => l.slice(0, 300)).join('\n')}`;
    }
    return { segs: [{ text: clean(t.slice(0, 3_000_000)), loc: '' }], ocr: [] };
  }
  return { segs: [], ocr: [], info: 'formato non leggibile' };
}

// OCR di una pagina di PDF con Gemini (la pagina viene disegnata e mandata come immagine)
export async function ocrPdfPage(blob, pageNo) {
  const lib = await pdfLib();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const page = await doc.getPage(pageNo);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(2.2, 1600 / v1.width) });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const img = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return clean(await ai.readImage(img, 'image/jpeg', 'È una pagina di dispense o appunti universitari.'));
}

// Divide in frammenti da ~900 caratteri rispettando i paragrafi; ogni frammento tiene la posizione
export function chunk(segs, size = 900) {
  const out = [];
  for (const s of segs) {
    const paras = s.text.split(/\n\s*\n|(?<=[.!?])\n/);
    let cur = '';
    const flush = () => { if (cur.trim().length > 20) out.push({ text: cur.trim(), loc: s.loc, page: s.page, t: s.t }); cur = ''; };
    for (let p of paras) {
      p = p.trim(); if (!p) continue;
      while (p.length > size * 1.4) {               // paragrafi enormi: taglio alle frasi
        let cut = p.lastIndexOf('. ', size); if (cut < size * 0.5) cut = size;
        if (cur) flush();
        cur = p.slice(0, cut + 1); flush(); p = p.slice(cut + 1).trim();
      }
      if (cur.length + p.length > size && cur) flush();
      cur += (cur ? '\n\n' : '') + p;
    }
    flush();
  }
  return out;
}
