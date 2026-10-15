// Google Drive dal telefono: accesso con Google (Google Identity Services) e API REST di Drive.
// L'app parla direttamente con il TUO Drive: nessun server in mezzo.
import { kget, kset } from './db.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';
export const FOLDER = 'application/vnd.google-apps.folder';
export const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': ['application/pdf', '.pdf'],
  'application/vnd.google-apps.presentation': ['application/pdf', '.pdf'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.drawing': ['application/pdf', '.pdf'],
};
let API = globalThis.__BRAINOS_DRIVE_API || 'https://www.googleapis.com';

export class NeedLogin extends Error {}

let token = null;            // { access, exp, email }
let tokenClient = null;

export async function loadToken() {
  token = await kget('token');
  return token;
}
export function hasValidToken() { return !!(token && token.exp > Date.now() / 1000 + 60); }
export function account() { return token?.email || null; }

function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Impossibile caricare l\'accesso Google (sei online?)'));
    document.head.appendChild(s);
  });
}

// Accesso: apre la finestrina di Google (serve un tocco dell'utente la prima volta e ogni ~ora)
export async function login(clientId, { silent = false } = {}) {
  if (!clientId) throw new Error('Manca il Client ID: inseriscilo nelle impostazioni (☁ Sync)');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPES,
      callback: async r => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        token = { access: r.access_token, exp: Date.now() / 1000 + Number(r.expires_in || 3600), email: token?.email || null };
        try { const a = await api('GET', '/drive/v3/about?fields=user(emailAddress)'); token.email = a.user?.emailAddress || null; } catch { /* niente */ }
        await kset('token', token);
        resolve(token);
      },
      error_callback: e => reject(new Error(e?.type === 'popup_closed' ? 'Accesso annullato' : (e?.message || 'Accesso non riuscito'))),
    });
    tokenClient.requestAccessToken({ prompt: silent ? '' : (token?.email ? '' : 'consent') });
  });
}
export async function logout() {
  if (token?.access && globalThis.google?.accounts?.oauth2) { try { google.accounts.oauth2.revoke(token.access); } catch { /* niente */ } }
  token = null; await kset('token', null);
}
// solo per i test
export function _setToken(t, api) { token = t; if (api) API = api; }

async function api(method, path, { body, headers = {}, raw = false } = {}) {
  if (!hasValidToken()) throw new NeedLogin('Accesso a Google scaduto');
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(API + path, { method, body, headers: { ...headers, Authorization: `Bearer ${token.access}` } });
    if (r.status === 401) { token.exp = 0; await kset('token', token); throw new NeedLogin('Accesso a Google scaduto'); }
    if ([429, 500, 502, 503].includes(r.status) && attempt < 2) { await new Promise(s => setTimeout(s, 1500 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 160)}`);
    if (raw) return r;
    return r.status === 204 ? null : r.json();
  }
}

const qs = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function list(q, { order, fields = 'files(id,name,mimeType,size,modifiedTime,parents,iconLink)' } = {}) {
  const out = [];
  let page = '';
  do {
    const p = new URLSearchParams({ q, fields: `nextPageToken,${fields}`, pageSize: '1000', spaces: 'drive' });
    if (order) p.set('orderBy', order);
    if (page) p.set('pageToken', page);
    const j = await api('GET', `/drive/v3/files?${p}`);
    out.push(...(j.files || []));
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

export async function folder(name, parent = 'root') {
  const found = await list(`name='${qs(name)}' and mimeType='${FOLDER}' and '${parent}' in parents and trashed=false`);
  if (found.length) return found[0].id;
  const j = await api('POST', '/drive/v3/files?fields=id', {
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }), headers: { 'Content-Type': 'application/json' },
  });
  return j.id;
}
export const children = parent => list(`'${parent}' in parents and trashed=false`, { order: 'folder,name' });
export const search = text => list(`name contains '${qs(text)}' and trashed=false`, { order: 'folder,name' });
export const sharedWithMe = () => list('sharedWithMe and trashed=false', { order: 'folder,name' });

export async function upload(parent, name, blob, mime = 'application/octet-stream') {
  const boundary = 'brainos' + Math.random().toString(16).slice(2);
  const meta = JSON.stringify({ name, parents: [parent] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  return api('POST', '/upload/drive/v3/files?uploadType=multipart&fields=id,name,size', {
    body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
}

export async function meta(id) { return api('GET', `/drive/v3/files/${id}?fields=id,name,mimeType,size,modifiedTime`); }

// Scarica un file; i documenti Google vengono esportati (PDF / Excel). Restituisce { blob, name, mime }.
export async function download(id, knownMime = null, knownName = null) {
  const m = knownMime && knownName ? { mimeType: knownMime, name: knownName } : await meta(id);
  const exp = GOOGLE_EXPORT[m.mimeType];
  if (exp) {
    const r = await api('GET', `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp[0])}`, { raw: true });
    const name = m.name.toLowerCase().endsWith(exp[1]) ? m.name : m.name + exp[1];
    return { blob: await r.blob(), name, mime: exp[0] };
  }
  const r = await api('GET', `/drive/v3/files/${id}?alt=media`, { raw: true });
  return { blob: await r.blob(), name: m.name, mime: m.mimeType || r.headers.get('content-type') || '' };
}
export async function readJson(id) {
  const r = await api('GET', `/drive/v3/files/${id}?alt=media`, { raw: true });
  return r.json();
}
export async function remove(id) { return api('DELETE', `/drive/v3/files/${id}`); }
