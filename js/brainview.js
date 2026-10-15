// Il cervello 3D sul telefono (Three.js): neuroni come punti sulla GPU, sinapsi, regioni con nome,
// tocco per scegliere un neurone, accensione delle fonti di una risposta e volo della telecamera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VS = `
attribute float size; attribute float glow; attribute vec3 color;
varying vec3 vColor; varying float vGlow;
uniform float uScale; uniform float uDim;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vColor = color; vGlow = glow;
  float s = size * (1.0 + glow * 1.8);
  gl_PointSize = s * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FS = `
varying vec3 vColor; varying float vGlow; uniform float uDim; uniform float uBright;
void main() {
  vec2 p = gl_PointCoord - 0.5; float d = length(p);
  if (d > 0.5) discard;
  float shade = 1.0 - d * 1.1;                                   // sferetta
  float k = mix(uDim, 1.0, max(vGlow, 1.0 - step(0.001, uDim)));  // spenti quando c'è qualcosa di acceso
  vec3 c = mix(vColor, vec3(1.0), vGlow * 0.45) * uBright * k;
  gl_FragColor = vec4(c * shade, 1.0);
}`;

export class BrainView {
  constructor(el, { onPick, onRegion } = {}) {
    this.el = el; this.onPick = onPick; this.onRegion = onRegion;
    this.mode = 'frammenti'; this.bright = 1; this.lit = new Map();
    const w = el.clientWidth || 360, h = el.clientHeight || 500;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));   // 1.5: nitido ma leggero per il telefono
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x05070f);
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 50);
    this.camera.position.set(2.2, 0.9, 2.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.25; this.controls.maxDistance = 8;
    this.controls.autoRotate = true; this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.fly = null; });
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.active = true; this.dirty = true; this.frameN = 0;
    this.labels = document.createElement('div'); this.labels.className = 'brain-labels'; el.appendChild(this.labels);
    // tocco breve = scelta di un neurone
    let down = null;
    const cv = this.renderer.domElement;
    cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    cv.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 8 && performance.now() - down.t < 450) this.pick(e.clientX, e.clientY);
      down = null;
    });
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el);
    this.alive = true; this.loop();
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.mat) this.mat.uniforms.uScale.value = this.scale();
  }
  scale() { return (this.el.clientHeight || 500) * 0.9 * Math.min(devicePixelRatio || 1, 1.5); }   // gl_PointSize è in pixel veri
  dispose() { this.alive = false; this.ro.disconnect(); this.renderer.dispose(); this.el.innerHTML = ''; }

  // graph: dal motore; info: { chunkDoc(i) → id doc, docName(id) }
  setGraph(graph, mode = this.mode) {
    this.graph = graph; this.mode = mode;
    for (const o of [this.points, this.lines]) if (o) { this.scene.remove(o); o.geometry.dispose(); }
    this.points = this.lines = null;
    if (!graph) { this.labels.innerHTML = ''; return; }
    const regs = graph.regions;
    // colori letti a mano (THREE.Color li convertirebbe in lineare e il cervello verrebbe più scuro)
    const col = regs.map(r => { const x = parseInt(String(r.colore).replace('#', ''), 16) || 0x7cf4ff; return { r: (x >> 16 & 255) / 255, g: (x >> 8 & 255) / 255, b: (x & 255) / 255 }; });
    let P, C, S, n;
    if (mode === 'documenti') {
      n = graph.docs.length; P = new Float32Array(n * 3); C = new Float32Array(n * 3); S = new Float32Array(n);
      graph.docs.forEach((d, i) => { P.set(d.p, i * 3); const c = col[d.r] || col[0]; C.set([c.r, c.g, c.b], i * 3); S[i] = 0.05 + Math.min(0.12, Math.sqrt(d.n) * 0.012); });
    } else {
      n = graph.n; P = graph.pos instanceof Float32Array ? graph.pos : Float32Array.from(graph.pos); C = new Float32Array(n * 3); S = new Float32Array(n);
      const base = Math.max(0.012, Math.min(0.045, 0.6 / Math.sqrt(n)));
      for (let i = 0; i < n; i++) { const c = col[graph.region[i]] || col[0]; C[i * 3] = c.r; C[i * 3 + 1] = c.g; C[i * 3 + 2] = c.b; S[i] = base * (0.8 + ((i * 7919) % 10) / 25); }
    }
    this.P = P; this.n = n;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.setAttribute('size', new THREE.BufferAttribute(S, 1));
    this.glow = new Float32Array(n);
    g.setAttribute('glow', new THREE.BufferAttribute(this.glow, 1));
    this.mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: false, depthWrite: true, depthTest: true,
      uniforms: { uScale: { value: this.scale() }, uDim: { value: 0 }, uBright: { value: this.bright } } });
    this.points = new THREE.Points(g, this.mat);
    this.scene.add(this.points);
    // sinapsi (al massimo 20k segmenti: sul telefono di più non si vede e rallenta)
    const L = mode === 'documenti' ? graph.dlinks.filter((_, k) => k % 3 !== 2) : graph.links;
    const step = Math.max(1, Math.ceil((L.length / 2) / 20000));
    const lp = [];
    for (let k = 0; k < L.length; k += 2 * step) { const a = L[k], b = L[k + 1]; if (a >= n || b >= n) continue; lp.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x6f8cff, transparent: true, opacity: mode === 'documenti' ? 0.22 : 0.07, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.lines);
    // etichette delle regioni
    this.labels.innerHTML = regs.map(r => `<button class="blabel" data-r="${r.id}" style="--c:${r.colore}">${r.nome.replace(/</g, '&lt;')}</button>`).join('');
    this.labels.querySelectorAll('[data-r]').forEach(b => b.onclick = () => this.onRegion?.(+b.dataset.r));
    this.regionCenters = regs.map(r => {
      const idx = []; if (mode === 'documenti') graph.docs.forEach((d, i) => d.r === r.id && idx.push(i)); else for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) if (graph.region[i] === r.id) idx.push(i);
      const c = new THREE.Vector3(); idx.forEach(i => c.add(new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]))); if (idx.length) c.divideScalar(idx.length);
      return c.multiplyScalar(1.12);
    });
    this.applyLit();
    this.dirty = true;
  }
  setBright(v) { this.bright = v; if (this.mat) this.mat.uniforms.uBright.value = v; this.dirty = true; }
  // quando la scheda Cervello non è visibile non si disegna niente (batteria e fluidità del resto dell'app)
  pause() { this.active = false; }
  resume() { if (!this.active) { this.active = true; this.dirty = true; this.resize(); } }

  // accende alcuni neuroni (indici del grafo nella modalità corrente); dim = spegne gli altri
  light(indices, { dim = true } = {}) {
    this.lit = new Map(indices.filter(i => i >= 0).map((i, k) => [i, 1 - k * 0.04]));
    this.dim = dim && this.lit.size > 0;
    this.applyLit();
  }
  clear() { this.lit = new Map(); this.dim = false; this.applyLit(); }
  applyLit() {
    if (!this.points) return;
    this.glow.fill(0);
    for (const [i, v] of this.lit) if (i < this.n) this.glow[i] = Math.max(0.6, v);
    this.points.geometry.attributes.glow.needsUpdate = true;
    this.mat.uniforms.uDim.value = this.dim ? 0.22 : 0;
    this.dirty = true;
    if (this.lines) this.lines.material.opacity = this.dim ? 0.02 : (this.mode === 'documenti' ? 0.22 : 0.07);
  }
  // vola verso un neurone
  flyTo(i, dist = 0.7) {
    if (!this.P || i < 0 || i >= this.n) return;
    const p = new THREE.Vector3(this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]);
    const dir = p.clone().normalize();
    this.fly = { target: p, cam: p.clone().add(dir.multiplyScalar(dist)), k: 0 };
    this.controls.autoRotate = false;
  }
  home() { this.fly = { target: new THREE.Vector3(), cam: new THREE.Vector3(2.2, 0.9, 2.6), k: 0 }; }

  pick(x, y) {
    if (!this.P) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(); let best = -1, bd = 26 * 26, bz = 9;
    const W = r.width, H = r.height, cx = x - r.left, cy = y - r.top;
    const camDir = this.camera.position.clone().normalize();
    for (let i = 0; i < this.n; i++) {
      v.set(this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]);
      if (this.dim && !this.lit.has(i)) continue;
      v.project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      const d = (sx - cx) ** 2 + (sy - cy) ** 2;
      if (d < bd || (d < bd * 1.6 && v.z < bz - 0.002)) { bd = Math.min(bd, d); best = i; bz = v.z; }
    }
    void camDir;
    if (best >= 0) this.onPick?.(best);
  }

  loop() {
    if (!this.alive) return;
    requestAnimationFrame(() => this.loop());
    if (!this.active || document.hidden) return;
    this.frameN++;
    if (this.fly) {
      const f = this.fly; f.k = Math.min(1, f.k + 0.045);
      const e = f.k * f.k * (3 - 2 * f.k);
      this.controls.target.lerp(f.target, e * 0.25);
      this.camera.position.lerp(f.cam, e * 0.25);
      if (f.k >= 1 && this.camera.position.distanceTo(f.cam) < 0.01) this.fly = null;
      this.dirty = true;
    }
    if (this.lit.size && this.points && this.frameN % 3 === 0) {        // le fonti pulsano (non a ogni fotogramma)
      const t = performance.now() / 600;
      for (const [i, v] of this.lit) if (i < this.n) this.glow[i] = Math.max(0.5, v) * (0.75 + 0.25 * Math.sin(t + i));
      this.points.geometry.attributes.glow.needsUpdate = true;
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;                                       // fermo: niente da ridisegnare
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    if (this.frameN % 2 === 0) this.placeLabels();
  }
  // etichette: visibili solo le regioni rivolte verso di noi
  placeLabels() {
    if (!this.regionCenters || !this.labels.children.length) return;
    const W = this.el.clientWidth, H = this.el.clientHeight, v = new THREE.Vector3();
    const camN = this.camera.position.clone().sub(this.controls.target).normalize();
    const close = this.camera.position.distanceTo(this.controls.target) < 1.2;
    this.regionCenters.forEach((c, k) => {
      const el = this.labels.children[k]; if (!el) return;
      const facing = c.clone().normalize().dot(camN);
      v.copy(c).project(this.camera);
      const show = facing > 0.15 && v.z < 1 && !(close && facing < 0.6);
      if (el._show !== show) { el.style.display = show ? '' : 'none'; el._show = show; }
      if (show) el.style.transform = `translate3d(${((v.x + 1) / 2 * W) | 0}px,${((1 - v.y) / 2 * H) | 0}px,0) translate(-50%,-50%)`;
      const op = this.dim ? 0.35 : Math.min(1, facing * 1.6);
      if (Math.abs((el._op ?? -1) - op) > 0.05) { el.style.opacity = op; el._op = op; }
    });
  }
}
