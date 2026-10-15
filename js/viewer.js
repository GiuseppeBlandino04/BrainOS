// Visualizzatore offline dei materiali. Le librerie si caricano solo quando servono e poi
// restano nella memoria dell'app (service worker), quindi funzionano anche senza rete.
const LIBS = {
  pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
};
export { LIBS };
const loaded = {};
export function script(src) {
  if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('Serve la connessione la prima volta che apri questo tipo di file'));
    document.head.appendChild(s);
  });
  return loaded[src];
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMd(text) {
  const math = [];
  const RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
  const safe = (text || '').replace(RE, m => { math.push(m); return `@@M${math.length - 1}@@`; });
  const html = globalThis.marked ? DOMPurify.sanitize(marked.parse(safe)) : `<p>${esc(safe)}</p>`;
  return html.replace(/@@M(\d+)@@/g, (_m, k) => esc(math[+k]));
}
export function mathIn(el) {
  if (!globalThis.renderMathInElement) return;
  try {
    renderMathInElement(el, { throwOnError: false, delimiters: [
      { left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }] });
  } catch { /* niente */ }
}

export async function pdfLib() {
  await script(LIBS.pdf);
  for (let k = 0; k < 120 && !(globalThis.pdfjsLib || globalThis['pdfjs-dist/build/pdf']); k++) await new Promise(r => setTimeout(r, 50));
  const lib = globalThis.pdfjsLib || globalThis['pdfjs-dist/build/pdf'];
  lib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  return lib;
}
async function pdf(blob, body, startPage = 1) {
  const lib = await pdfLib();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  body.innerHTML = `<div class="pdf-pages">${Array.from({ length: doc.numPages }, (_, i) =>
    `<div class="ph" data-p="${i + 1}">pagina ${i + 1}</div>`).join('')}</div>`;
  const width = Math.min(body.clientWidth - 8, 900);
  const io = new IntersectionObserver(entries => {
    entries.filter(e => e.isIntersecting).forEach(async e => {
      const ph = e.target; io.unobserve(ph);
      const page = await doc.getPage(+ph.dataset.p);
      const v1 = page.getViewport({ scale: 1 });
      const scale = (width / v1.width) * Math.min(devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height; c.style.width = width + 'px';
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      ph.replaceWith(c);
    });
  }, { root: body, rootMargin: '600px' });
  body.querySelectorAll('.ph').forEach(p => io.observe(p));
  if (startPage > 1) setTimeout(() => body.querySelector(`[data-p="${startPage}"]`)?.scrollIntoView(), 50);
  return `${doc.numPages} pagine`;
}

function table(rows) {
  if (!rows.length) return '<p class="muted">Tabella vuota.</p>';
  const [h, ...r] = rows;
  return `<div class="tbl-wrap"><table><thead><tr>${h.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
    r.slice(0, 3000).map(x => `<tr>${x.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    + (r.length > 3000 ? `<p class="muted small">Mostro le prime 3000 righe di ${r.length}.</p>` : '');
}
function csv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : text.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; if (rows.length > 3001) break; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return table(rows);
}

// Mostra il materiale nel contenitore `body`. Restituisce una breve descrizione (es. "12 pagine").
export async function show(m, blob, body, at = {}) {
  const name = m.nome.toLowerCase();
  const ext = name.split('.').pop();
  const mime = m.mime || blob.type || '';
  if (ext === 'pdf' || mime === 'application/pdf') return pdf(blob, body, at.page || 1);
  const url = URL.createObjectURL(blob);
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    body.innerHTML = `<img class="viewer-img" src="${url}" alt="">`; return '';
  }
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'opus'].includes(ext)) {
    body.innerHTML = `<audio class="viewer-media" src="${url}" controls></audio>`;
    if (at.t) body.querySelector('audio').currentTime = at.t;
    return '';
  }
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) {
    body.innerHTML = `<video class="viewer-media" src="${url}" controls playsinline></video>`;
    if (at.t) body.querySelector('video').currentTime = at.t;
    return '';
  }
  if (ext === 'docx') {
    await script(LIBS.mammoth);
    const r = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
    body.innerHTML = `<div class="md">${DOMPurify.sanitize(r.value)}</div>`; return '';
  }
  if (['xlsx', 'xlsm', 'xls'].includes(ext)) {
    await script(LIBS.xlsx);
    const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
    body.innerHTML = wb.SheetNames.map(n => `<h2>${esc(n)}</h2>` + table(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }))).join('');
    return `${wb.SheetNames.length} fogli`;
  }
  if (['csv', 'tsv'].includes(ext)) { body.innerHTML = csv(await blob.text()); return ''; }
  if (['md', 'markdown'].includes(ext)) {
    body.innerHTML = `<div class="md">${renderMd(await blob.text())}</div>`; mathIn(body); return '';
  }
  if (mime.startsWith('text/') || ['txt', 'tex', 'json', 'py', 'js', 'java', 'c', 'cpp', 'h', 'html', 'css', 'log', 'sql', 'xml', 'yaml', 'yml'].includes(ext)) {
    body.innerHTML = `<pre class="text">${esc((await blob.text()).slice(0, 500000))}</pre>`; return '';
  }
  body.innerHTML = `<div class="empty">Questo formato non si può mostrare qui.<br>Usa «Apri con…» per aprirlo con un'altra app.</div>`;
  return '';
}

// "Apri con…": il menu di condivisione di Android (o il download, se non disponibile)
export async function shareFile(m, blob) {
  const file = new File([blob], m.nome, { type: m.mime || blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: m.nome }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = m.nome; a.click();
}
