#!/usr/bin/env node
/*
 * Croquis headless: build constrained 2D sketches from a JSON description,
 * check them with the same solver as the web app, and export SVG, PDF,
 * TikZ, Croquis .json files and share links. No dependencies: it loads the
 * solver and the renderer straight from index.html.
 *
 *   node croquis.mjs build spec.json --svg out.svg --pdf out.pdf --require-full
 *   node croquis.mjs example > spec.json
 *   node croquis.mjs help
 *
 * Library:
 *   import { build } from './croquis.mjs';
 *   const d = await build(spec);   // d.report, await d.svg(), await d.pdf(), ...
 *
 * Copyright (c) 2026 Stépane Binon. PolyForm Noncommercial License 1.0.0.
 * https://github.com/Bare-Metal-Foundry/croquis
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_URL = 'https://bare-metal-foundry.github.io/croquis/';
const REPO = 'https://github.com/Bare-Metal-Foundry/croquis';

/* ------------------------------------------------------------------ */
/* Loading the app's code without a browser                           */
/* ------------------------------------------------------------------ */
// Helvetica advance widths (1/1000 em) for ASCII 32-126, used to measure text.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
function measureShim() {
  const ctx = {
    font: '12px sans-serif',
    measureText(t) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font), size = m ? +m[1] : 12;
      const mono = /mono/i.test(this.font);
      let w = 0;
      for (const ch of String(t)) { const c = ch.codePointAt(0); w += mono ? 600 : c >= 32 && c <= 126 ? HELV[c - 32] : 600; }
      return { width: w * size / 1000 };
    },
  };
  return ctx;
}
let loaded = null;
/* Returns { K: the solver (SketchCore), H: the renderer }. */
export function load() {
  if (loaded) return loaded;
  const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length < 2) throw new Error('index.html does not contain the Croquis scripts.');
  const g = globalThis;
  const set = (k, v) => { if (g[k] === undefined) g[k] = v; };
  set('window', g);
  g.CROQUIS_HEADLESS = true;
  set('document', {
    createElement: (tag) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => measureShim() } : { setAttribute() {}, append() {}, style: {} }),
    createElementNS: () => ({ setAttribute() {}, append() {} }),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, documentElement: { setAttribute() {}, removeAttribute() {} }, body: { classList: { add() {}, toggle() {} } },
  });
  set('localStorage', { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 });
  set('matchMedia', () => ({ matches: false, addEventListener() {} }));
  set('requestAnimationFrame', () => 0);
  set('location', { protocol: 'https:', origin: 'https://bare-metal-foundry.github.io', pathname: '/croquis/', hash: '', search: '', href: APP_URL });
  for (const code of scripts.slice(0, 2)) (0, eval)(code);
  if (!g.SketchCore || !g.CroquisHeadless) throw new Error('The Croquis scripts did not load.');
  loaded = { K: g.SketchCore, H: g.CroquisHeadless };
  return loaded;
}

/* ------------------------------------------------------------------ */
/* Building a sketch from a description                                */
/* ------------------------------------------------------------------ */
const REL_ALIASES = {
  horizontal: 'horizontal', vertical: 'vertical', parallel: 'parallel', perpendicular: 'perpendicular', collinear: 'collinear',
  equal: 'equal', tangent: 'tangent', concentric: 'concentric', coradial: 'coradial', coincident: 'coincident', merge: 'coincident',
  on: 'on', pointon: 'on', midpoint: 'midpoint', symmetric: 'symmetric', intersection: 'intersection', fix: 'fix', fixed: 'fix',
};
const DIM_ALIASES = {
  distance: 'distance', length: 'distance', horizontal: 'hdistance', hdistance: 'hdistance', vertical: 'vdistance', vdistance: 'vdistance',
  radius: 'radius', diameter: 'diameter', angle: 'angle',
};
class SpecError extends Error {}

/* Builds the sketch described by spec (see `node croquis.mjs help`).
   Returns the sketch, a report and export functions. */
export async function build(spec) {
  const { K, H } = load();
  if (!spec || typeof spec !== 'object') throw new SpecError('The description must be a JSON object.');
  const units = spec.units === 'in' ? 'in' : 'mm';
  const k = units === 'in' ? 25.4 : 1;
  const L = (v, what) => { const n = +v; if (!Number.isFinite(n)) throw new SpecError(what + ' must be a number.'); return n * k; };
  const P = (p, what) => { if (!Array.isArray(p) || p.length !== 2) throw new SpecError(what + ' must be [x, y].'); return { x: L(p[0], what), y: L(p[1], what) }; };
  const sk = new K.Sketch();
  sk.units = units;
  const name = String(spec.name || 'Drawing').slice(0, 120);
  const report = { ok: true, name, units, status: '', dof: 0, problems: [], warnings: [], dimensions: [], measures: [] };
  const named = new Map([['origin', { kind: 'point', id: sk.originId }]]);
  const def = (id, v, where) => {
    if (typeof id !== 'string' || !/^[A-Za-z_][\w-]*$/.test(id)) throw new SpecError(where + ': "id" must be a name such as base or hole_1.');
    if (named.has(id)) throw new SpecError(where + ': the id "' + id + '" is used twice.');
    named.set(id, v);
  };
  /* Resolves "id", "id.start", "id.end", "id.center", rect parts... to a sketch entity id. */
  const ref = (r, where) => {
    if (typeof r !== 'string') throw new SpecError(where + ': a reference must be a string such as "base.start".');
    if (named.has(r)) { const v = named.get(r); if (v.id) return v.id; throw new SpecError(where + ': "' + r + '" is a group of entities; name one part, e.g. "' + r + '.' + Object.keys(v.parts)[0] + '".'); }
    const dot = r.lastIndexOf('.');
    if (dot > 0) {
      const base = r.slice(0, dot), part = r.slice(dot + 1);
      const v = named.get(base);
      if (v && v.parts && v.parts[part]) return v.parts[part];
      const inner = v ? null : (() => { try { return ref(base, where); } catch (e) { return null; } })();
      const e = sk.get(v && v.id ? v.id : inner);
      if (e) {
        const m = { start: 'p1', end: 'p2', center: 'c' }[part];
        if (m && e[m]) return e[m];
      }
    }
    throw new SpecError(where + ': unknown reference "' + r + '". Known: ' + [...named.keys()].slice(0, 30).join(', ') + '.');
  };
  const style = (e, st) => {
    if (!st) return;
    const s = K.cleanStyle(Object.assign({}, st, { fillOp: st.fillOpacity !== undefined ? st.fillOpacity : st.fillOp }));
    if (s) e.style = s;
  };

  // entities
  (spec.entities || []).forEach((o, i) => {
    const where = 'entities[' + i + ']' + (o && o.id ? ' (' + o.id + ')' : '');
    if (!o || typeof o !== 'object') throw new SpecError(where + ' must be an object.');
    const opt = { construction: !!o.construction };
    let made;
    switch (o.type) {
      case 'point': { const p = P(o.at, where + '.at'); made = { kind: 'point', id: sk.addPoint(p.x, p.y, opt) }; break; }
      case 'line': { const a = P(o.from, where + '.from'), b = P(o.to, where + '.to'); made = { kind: 'line', id: sk.addLine(a.x, a.y, b.x, b.y, opt) }; break; }
      case 'circle': {
        const c = P(o.center, where + '.center');
        const r = o.r !== undefined ? L(o.r, where + '.r') : o.d !== undefined ? L(o.d, where + '.d') / 2 : NaN;
        if (!(r > 0)) throw new SpecError(where + ': give a positive "r" or "d".');
        made = { kind: 'circle', id: sk.addCircle(c.x, c.y, r, opt) };
        break;
      }
      case 'arc': {
        // counter-clockwise from "from" to "to" around "center", or by radius and angles in degrees
        const c = P(o.center, where + '.center');
        let a, b;
        if (o.from && o.to) { a = P(o.from, where + '.from'); b = P(o.to, where + '.to'); }
        else {
          const r = L(o.r, where + '.r'), s = (+o.start || 0) * Math.PI / 180, e = (+o.end || 0) * Math.PI / 180;
          a = { x: c.x + r * Math.cos(s), y: c.y + r * Math.sin(s) }; b = { x: c.x + r * Math.cos(e), y: c.y + r * Math.sin(e) };
        }
        made = { kind: 'arc', id: sk.addArc(c.x, c.y, a.x, a.y, b.x, b.y, opt) };
        break;
      }
      case 'rect': {
        const a = P(o.from || o.corner, where + '.from'), b = o.to ? P(o.to, where + '.to') : (() => { const s = P(o.size, where + '.size'); return { x: a.x + s.x, y: a.y + s.y }; })();
        const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
        const r = K.makeRect(sk, lo, hi, opt);
        const [bottom, right, top, left] = r.lines;
        made = { kind: 'rect', parts: { bottom, right, top, left, bl: r.corners[0], br: r.corners[1], tr: r.corners[2], tl: r.corners[3] } };
        break;
      }
      case 'slot': {
        const a = P(o.from, where + '.from'), b = P(o.to, where + '.to');
        const s = K.makeSlot(sk, a, b, L(o.width, where + '.width'), opt);
        made = { kind: 'slot', parts: { side1: s.lines[0], side2: s.lines[1], end1: s.arcs[0], end2: s.arcs[1], axis: s.centerline, c1: s.c1, c2: s.c2 } };
        break;
      }
      case 'polygon': {
        const c = P(o.center, where + '.center'), v = P(o.vertex, where + '.vertex');
        const p = K.makePolygon(sk, c, v, +o.sides || 6, o.inscribed !== false, opt);
        const parts = { circle: p.circle, center: p.center };
        p.lines.forEach((id, j) => { parts['edge' + (j + 1)] = id; });
        made = { kind: 'polygon', parts };
        break;
      }
      default: throw new SpecError(where + ': unknown type "' + o.type + '". Use point, line, circle, arc, rect, slot or polygon.');
    }
    if (made.id) style(sk.get(made.id), o.style);
    else if (o.style) for (const id of Object.values(made.parts)) { const e = sk.get(id); if (e && e.type !== 'point') style(e, o.style); }
    def(o.id || (o.type + (i + 1)), made, where);
  });

  // relations
  const labelOf = new Map();
  (spec.relations || []).forEach((o, i) => {
    const where = 'relations[' + i + ']';
    let type = REL_ALIASES[String(o && o.type).toLowerCase()];
    if (!type) throw new SpecError(where + ': unknown relation "' + (o && o.type) + '".');
    const refs = (o.refs || []).map((r, j) => ref(r, where + '.refs[' + j + ']'));
    if (type === 'on') {
      const target = sk.get(refs[1]);
      type = target && target.type === 'line' ? 'pointOnLine' : 'pointOnCircle';
    }
    const before = new Set(sk.cons.keys());
    const r = K.addRelation(sk, type, refs);
    const tag = where + ' ' + o.type + ' ' + (o.refs || []).join(', ');
    if (r.status === 'redundant') report.warnings.push(tag + ': already implied by other relations, skipped.');
    else if (r.status !== 'ok') { report.problems.push(tag + ': conflicts with the other relations and dimensions (not added).'); report.ok = false; }
    for (const cid of sk.cons.keys()) if (!before.has(cid)) labelOf.set(cid, tag);
  });

  // dimensions
  const dims = [];
  (spec.dimensions || []).forEach((o, i) => {
    const where = 'dimensions[' + i + ']';
    let type = DIM_ALIASES[String(o && o.type).toLowerCase()];
    if (!type) throw new SpecError(where + ': unknown dimension "' + (o && o.type) + '".');
    let refs = (o.refs || []).map((r, j) => ref(r, where + '.refs[' + j + ']'));
    const E = refs.map((id) => sk.get(id));
    if ((type === 'distance' || type === 'hdistance' || type === 'vdistance') && refs.length === 1 && E[0].type === 'line') refs = [E[0].p1, E[0].p2];
    else if (type === 'distance' && refs.length === 2) {
      if (E[0].type === 'point' && E[1].type === 'line') type = 'pointLineDistance';
      else if (E[0].type === 'line' && E[1].type === 'point') { type = 'pointLineDistance'; refs = [refs[1], refs[0]]; }
      else if (E[0].type === 'line' && E[1].type === 'line') type = 'lineLineDistance';
    }
    const value = o.value === undefined || o.value === null ? undefined : type === 'angle' ? +o.value : L(o.value, where + '.value');
    const opts = { value, driven: !!o.driven, name: typeof o.name === 'string' ? o.name : undefined };
    if (o.offset !== undefined && type !== 'angle' && type !== 'radius' && type !== 'diameter') opts.label = { o: L(o.offset, where + '.offset'), t: 0 };
    const r = K.addDimension(sk, type, refs, opts);
    const tag = where + ' ' + o.type + ' ' + (o.refs || []).join(', ') + (value !== undefined ? ' = ' + o.value : '');
    if (r.status === 'redundant') { report.problems.push(tag + ': the geometry is already fixed by other constraints, so this dimension would over-define it. Remove it or set "driven": true.'); report.ok = false; }
    else if (r.status !== 'ok') { report.problems.push(tag + ': the sketch cannot reach this value with its other relations and dimensions.'); report.ok = false; }
    else { labelOf.set(r.id, tag); dims.push({ cid: r.id, spec: o, where }); }
  });

  // notes (annotations that follow the geometry)
  const anchor = (a, where) => {
    if (Array.isArray(a)) { const p = P(a, where); return { k: 'free', x: p.x, y: p.y }; }
    if (typeof a === 'string') {
      const at = /^(.*)@([-\d.]+)$/.exec(a);
      if (at) { const id = ref(at[1], where); const e = sk.get(id); return { k: 'on', id, t: e.type === 'circle' ? (+at[2]) * Math.PI / 180 : +at[2] }; }
      if (a.endsWith('.mid')) { const id = ref(a.slice(0, -4), where); if (sk.get(id).type !== 'line') throw new SpecError(where + ': ".mid" works on lines.'); return { k: 'mid', id }; }
      const id = ref(a, where);
      if (sk.get(id).type !== 'point') throw new SpecError(where + ': attach to a point ("line.start"), a line midpoint ("line.mid") or a position along a curve ("line@0.25").');
      return { k: 'pt', id };
    }
    throw new SpecError(where + ' must be a reference or [x, y].');
  };
  (spec.notes || []).forEach((o, i) => {
    const where = 'notes[' + i + ']';
    const t = String(o && o.type);
    const p = { text: o.text === undefined ? '' : String(o.text) };
    if (o.color) p.color = o.color;
    switch (t) {
      case 'text':
        p.a = anchor(o.at, where + '.at'); p.leader = o.leader !== undefined ? !!o.leader : !Array.isArray(o.at);
        p.off = o.offset ? { x: L(o.offset[0], where), y: L(o.offset[1], where) } : { x: 3 * k, y: 3 * k };
        if (o.size) p.size = +o.size;
        if (o.frame) p.frame = true;
        break;
      case 'force': p.a = anchor(o.at, where + '.at'); p.dir = { ang: +o.angle || 0, ref: 0 }; p.len = o.length ? L(o.length, where) : 20; p.head = !!o.push; break;
      case 'moment': case 'torque': p.a = anchor(o.at, where + '.at'); p.r = o.radius ? L(o.radius, where) : 8; p.ccw = o.ccw !== false; p.ang = o.angle !== undefined ? +o.angle : 90; break;
      case 'load': p.a = anchor(o.from, where + '.from'); p.b = anchor(o.to, where + '.to'); p.q0 = L(o.q0 !== undefined ? o.q0 : o.q || 8, where); p.q1 = L(o.q1 !== undefined ? o.q1 : o.q || 8, where); p.side = o.side === -1 ? -1 : 1; break;
      case 'support': delete p.text; p.a = anchor(o.at, where + '.at'); p.kind = ['fixed', 'pin', 'roller'].includes(o.kind) ? o.kind : 'pin'; p.ang = o.angle !== undefined ? +o.angle : 90; break;
      case 'spring': case 'damper': p.a = anchor(o.from, where + '.from'); p.b = anchor(o.to, where + '.to'); break;
      case 'frame': p.a = anchor(o.at, where + '.at'); p.dir = { ang: +o.angle || 0, ref: 0 }; p.len = o.length ? L(o.length, where) : 14; if (o.x) p.lx = String(o.x); if (o.y) p.ly = String(o.y); break;
      case 'mass': p.a = anchor(o.at, where + '.at'); break;
      default: throw new SpecError(where + ': unknown note "' + t + '". Use text, force, moment, load, support, spring, damper, frame or mass.');
    }
    sk.addNote(t === 'torque' ? 'moment' : t, p);
  });

  K.solve(sk);

  // optional drawing sheet
  if (spec.sheet) {
    const s = spec.sheet, sh = K.defaultSheet();
    if (s.size && K.SHEET_SIZES[s.size]) sh.size = s.size;
    if (s.orient === 'portrait') sh.orient = 'portrait';
    if (['first', 'third', 'none'].includes(s.projection)) sh.projection = s.projection;
    if (s.zones === false) sh.zones = false;
    Object.assign(sh.fields, s.fields || {});
    if (!sh.fields.title) sh.fields.title = name;
    sk.sheet = sh;
    H.use(sk, { name });
    const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(String(s.scale || 'auto'));
    H.fitSheet(sh);
    if (m) { sh.scale = { n: +m[1], d: +m[2] }; }
  }

  // verdict
  const an = K.analyze(sk);
  report.status = an.status === 'full' ? 'fully defined' : an.status === 'over' ? 'over defined' : 'under defined';
  report.dof = an.dof;
  for (const cid of [...an.redundant, ...an.unsat]) {
    const msg = (labelOf.get(cid) || 'an automatic relation') + ': conflicts with other constraints.';
    if (!report.problems.includes(msg)) report.problems.push(msg);
    report.ok = false;
  }
  for (const d of dims) {
    const c = sk.cons.get(d.cid);
    if (!c) continue;
    const v = K.measureDim(sk, c);
    report.dimensions.push({ name: c.name, at: d.where, type: d.spec.type, value: c.type === 'angle' ? round(v) : round(v / k) });
  }
  (spec.measure || []).forEach((o, i) => {
    const where = 'measure[' + i + ']';
    let type = DIM_ALIASES[String(o && o.type).toLowerCase()];
    if (!type) { report.problems.push(where + ': unknown measure type "' + (o && o.type) + '".'); return; }
    let refs = (o.refs || []).map((r, j) => ref(r, where + '.refs[' + j + ']'));
    const E = refs.map((id) => sk.get(id));
    if ((type === 'distance' || type === 'hdistance' || type === 'vdistance') && refs.length === 1 && E[0].type === 'line') refs = [E[0].p1, E[0].p2];
    else if (type === 'distance' && refs.length === 2 && E[0].type !== E[1].type && (E[0].type === 'line' || E[1].type === 'line')) { type = 'pointLineDistance'; if (E[0].type === 'line') refs = [refs[1], refs[0]]; }
    else if (type === 'distance' && E.length === 2 && E[0].type === 'line' && E[1].type === 'line') type = 'lineLineDistance';
    const c = { type, refs, data: K.relData(sk, type, refs, {}) };
    const v = Math.abs(K.measureDim(sk, c));
    report.measures.push({ name: o.name || where, type: o.type, value: type === 'angle' ? round(v) : round(v / k) });
  });
  if (report.status === 'over defined') report.ok = false;

  const use = (o) => H.use(sk, Object.assign({ name }, o));
  return {
    sketch: sk,
    report,
    json: () => JSON.stringify(Object.assign({ name }, sk.toJSON()), null, 1),
    svg: async (o) => { use(o); return H.svg(o); },
    pdf: async (o) => { use(o); return H.pdf(); },
    tikz: async (o) => { use(o); return H.tikz(o); },
    link: async (mode = 'view') => { use(); return H.link(mode); },
  };
}
const round = (v) => +(+v).toPrecision(10);

/* Renders an existing Croquis .json file (exported from the app). */
export async function open(json) {
  const { K, H } = load();
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const sk = K.Sketch.fromJSON(j);
  K.solve(sk);
  const name = String(j.name || 'Drawing');
  const an = K.analyze(sk);
  const use = (o) => H.use(sk, Object.assign({ name }, o));
  return {
    sketch: sk,
    report: { ok: an.status !== 'over', name, status: an.status === 'full' ? 'fully defined' : an.status === 'over' ? 'over defined' : 'under defined', dof: an.dof },
    json: () => JSON.stringify(Object.assign({ name }, sk.toJSON()), null, 1),
    svg: async (o) => { use(o); return H.svg(o); },
    pdf: async (o) => { use(o); return H.pdf(); },
    tikz: async (o) => { use(o); return H.tikz(o); },
    link: async (mode = 'view') => { use(); return H.link(mode); },
  };
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */
export const EXAMPLE = {
  name: 'Crank and slider',
  units: 'mm',
  entities: [
    { id: 'crank', type: 'line', from: [0, 0], to: [25, 15] },
    { id: 'rod', type: 'line', from: [25, 15], to: [90, 0] },
    { id: 'rail', type: 'line', from: [-10, 0], to: [120, 0], construction: true },
  ],
  relations: [
    { type: 'coincident', refs: ['crank.start', 'origin'] },
    { type: 'coincident', refs: ['crank.end', 'rod.start'] },
    { type: 'coincident', refs: ['rail.start', 'origin'] },
    { type: 'horizontal', refs: ['rail'] },
    { type: 'on', refs: ['rod.end', 'rail'] },
  ],
  dimensions: [
    { type: 'length', refs: ['crank'], value: 30 },
    { type: 'length', refs: ['rod'], value: 80 },
    { type: 'angle', refs: ['rail', 'crank'], value: 40 },
    { type: 'length', refs: ['rail'], value: 130, offset: -10 },
  ],
  notes: [
    { type: 'moment', at: 'crank.start', radius: 7, angle: 200, text: 'ω' },
    { type: 'force', at: 'rod.end', angle: 180, length: 18, push: true, text: 'F' },
    { type: 'support', at: 'origin', kind: 'pin', angle: 90 },
  ],
  measure: [
    { name: 'slider position', type: 'horizontal', refs: ['origin', 'rod.end'] },
  ],
};

const HELP = `Croquis headless — build and check constrained 2D sketches, export figures.
${REPO}

Usage
  node croquis.mjs build <spec.json | -> [outputs] [options]
  node croquis.mjs render <drawing.json> [outputs]   render a file saved by the web app
  node croquis.mjs example                          print an example description
  node croquis.mjs help

Outputs (any number)
  --svg <file>   --pdf <file>   --tikz <file>   --json <file>
  --link         print a view-only link that opens the drawing in the web app
  --edit-link    print a link that opens an editable copy

Options
  --require-full    exit with code 3 unless the sketch is fully defined
  --no-dims         leave dimensions out of the figures
  --tikz-width <cm> width of the TikZ figure (default 12)
  --standalone      TikZ as a complete .tex document
  --quiet           no report on stdout

Exit codes: 0 ok · 1 bad input · 2 conflicts or over-defined · 3 not fully defined (with --require-full)
The report (JSON on stdout) gives the status, the degrees of freedom left, every conflict with
the item that caused it, the solved dimension values and any "measure" you asked for.

Description (JSON; lengths in "units", angles in degrees)
{
  "name": "Bracket", "units": "mm" | "in",
  "entities": [                                 every entity gets an "id" you refer to
    {"id":"a","type":"point","at":[x,y]},
    {"id":"b","type":"line","from":[x,y],"to":[x,y],"construction":false},
    {"id":"c","type":"circle","center":[x,y],"r":5}            (or "d": diameter),
    {"id":"d","type":"arc","center":[x,y],"from":[x,y],"to":[x,y]}   counter-clockwise
         (or "r", "start", "end" in degrees),
    {"id":"e","type":"rect","from":[x,y],"to":[x,y]}  parts: e.bottom e.right e.top e.left, corners e.bl e.br e.tr e.tl
    {"id":"f","type":"slot","from":[x,y],"to":[x,y],"width":8}  parts: f.side1 f.side2 f.end1 f.end2 f.axis f.c1 f.c2
    {"id":"g","type":"polygon","center":[x,y],"vertex":[x,y],"sides":6}  parts: g.edge1… g.circle g.center
    optional on any entity: "style": {"color":"blue"|"#rrggbb","dash":"dash|hidden|dot|dashdot|center|phantom",
                                      "width":1.6, "fill":"blue", "fillOpacity":0.3}
  ],
  references: "id", "id.start", "id.end", "id.center", rect/slot/polygon parts, and "origin".
  Colors: ink grey red orange amber green teal cyan blue violet magenta brown, or #rrggbb.

  "relations": [ {"type":"horizontal|vertical|parallel|perpendicular|collinear|equal|tangent|
                  concentric|coradial|coincident|on|midpoint|symmetric|intersection|fix",
                  "refs":[...]} ],
      coincident: two points · on: point + line/circle/arc · midpoint: point + line ·
      symmetric: a, b, axis line · intersection: point, line, line · fix: one entity
  "dimensions": [ {"type":"length|distance|horizontal|vertical|radius|diameter|angle",
                   "refs":[...], "value":80, "driven":false, "offset":10} ],
      length: one line · distance: two points, point + line, or two parallel lines ·
      horizontal / vertical: two points or one line · angle: two lines
  "notes": [ {"type":"text","at":ref|[x,y],"text":"Bracket","offset":[dx,dy]},
             {"type":"force","at":ref,"angle":-90,"length":20,"text":"F_1","push":false},
             {"type":"moment","at":ref,"radius":8,"ccw":true,"text":"M"},
             {"type":"load","from":ref,"to":ref,"q":8,"text":"q"},
             {"type":"support","at":ref,"kind":"fixed|pin|roller","angle":90},
             {"type":"spring"|"damper","from":ref,"to":ref,"text":"k"},
             {"type":"frame","at":ref,"angle":0}, {"type":"mass","at":ref} ]
      note anchors: a point ("rod.end"), a line midpoint ("rod.mid"), a position along a curve
      ("rod@0.25", or "circle@90" in degrees), or a free position [x, y]. "_" and "^" make
      sub/superscripts: F_1, m^2.
  "measure": [ {"name":"stroke","type":"distance","refs":[...]} ]   values reported, nothing drawn
  "sheet": {"size":"A4|A3|A2|A1|A0|Letter|Tabloid","orient":"landscape|portrait","scale":"1:2"|"auto",
            "projection":"first|third|none","fields":{"company":"","number":"","rev":"A","drawn":""}}
}

Tips for rigorous figures: give approximate coordinates, then let relations and dimensions
fix the exact geometry; aim for "fully defined" (dof 0) and treat any problem as an error.
Licence: free for personal and noncommercial use (PolyForm Noncommercial 1.0.0); commercial use
needs the author's approval: https://www.linkedin.com/in/stepane-binon/`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP + '\n'); return 0; }
  if (cmd === 'example') { process.stdout.write(JSON.stringify(EXAMPLE, null, 2) + '\n'); return 0; }
  if (cmd !== 'build' && cmd !== 'render') { process.stderr.write('Unknown command "' + cmd + '". Try: node croquis.mjs help\n'); return 1; }
  const opts = { out: {} };
  let input = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (['--svg', '--pdf', '--tikz', '--json'].includes(a)) opts.out[a.slice(2)] = rest[++i];
    else if (a === '--link') opts.link = 'view';
    else if (a === '--edit-link') opts.link = 'edit';
    else if (a === '--require-full') opts.requireFull = true;
    else if (a === '--no-dims') opts.noDims = true;
    else if (a === '--standalone') opts.standalone = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--tikz-width') opts.tikzWidth = +rest[++i];
    else if (!input) input = a;
    else { process.stderr.write('Unexpected argument "' + a + '".\n'); return 1; }
  }
  if (!input) { process.stderr.write('Give a file to read, or - for standard input.\n'); return 1; }
  let text;
  try { text = input === '-' ? readFileSync(0, 'utf8') : readFileSync(input, 'utf8'); }
  catch (e) { process.stderr.write('Cannot read ' + input + ': ' + e.message + '\n'); return 1; }
  let d;
  try { d = cmd === 'build' ? await build(JSON.parse(text)) : await open(text); }
  catch (e) {
    const msg = e instanceof SyntaxError ? 'The input is not valid JSON: ' + e.message : e.message;
    if (opts.quiet) process.stderr.write(msg + '\n'); else process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    return 1;
  }
  const fig = { dims: !opts.noDims };
  const files = [];
  if (opts.out.svg) { writeFileSync(opts.out.svg, await d.svg(fig) || ''); files.push(opts.out.svg); }
  if (opts.out.pdf) { const b = await d.pdf(fig); if (b) { writeFileSync(opts.out.pdf, b); files.push(opts.out.pdf); } }
  if (opts.out.tikz) { writeFileSync(opts.out.tikz, await d.tikz(Object.assign({}, fig, { width: opts.tikzWidth || 12, standalone: !!opts.standalone })) || ''); files.push(opts.out.tikz); }
  if (opts.out.json) { writeFileSync(opts.out.json, d.json()); files.push(opts.out.json); }
  const report = Object.assign({}, d.report, { files });
  if (opts.link) report.link = await d.link(opts.link);
  if (!opts.quiet) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!d.report.ok) return 2;
  if (opts.requireFull && d.report.status !== 'fully defined') return 3;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
