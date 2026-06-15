// ═══════════════════════════════════════════════════════════════════════════
// Logic Graph Editor — DOM/SVG node editor (Caleb's Studio)
// ─────────────────────────────────────────────────────────────────────────────
// A dependency-free, Blueprint-style node editor for a mission's `logic` graph
// (docs/09). Nodes are absolutely-positioned HTML cards with typed pins; edges are
// SVG bezier curves on an overlay. Model mutations go through graph-edit.js so the
// graph stays validate-clean. The DOM-free model + engine are tested separately;
// this layer is verified in-browser (verifier-browser skill).
//
//   const ed = new LogicGraphEditor(container, graph, { onChange });
//   ed.mount();           // build palette + canvas + inspector
//   ed.getGraph();        // the live, edited graph
// ═══════════════════════════════════════════════════════════════════════════

import { pinsOf, getNodeType, NodeKind } from '../mission-logic/node-types.js';
import { EdgeKind } from '../mission-logic/graph.js';
import {
  paletteGroups, addNode, removeNode, connect, removeEdges, autoLayout,
} from '../mission-logic/graph-edit.js';
import { buildParamForm } from './node-param-fields.js';
import { pinDoc, nodeDoc } from './pin-docs.js';
import { CONDITIONS } from '../campaign/condition-registry.js';
import { createPanZoom } from './graph-pan-zoom.js';

const KIND_COLOR = {
  [NodeKind.EVENT]: '#b45309', [NodeKind.ACTOR]: '#9333ea', [NodeKind.FLOW]: '#0e7490',
  [NodeKind.PURE]: '#4d7c0f', [NodeKind.SIM]: '#b91c1c', [NodeKind.SHOW]: '#1d4ed8',
  [NodeKind.OUT]: '#a16207',
  // Comments draw as a gold sticky-note (see .lge-comment), not via a header bar —
  // give the palette group its visible gold so the heading still matches the graph.
  [NodeKind.COMMENT]: '#caa94f',
};

const CSS = `
.lge-root{display:flex;height:100%;min-height:380px;font:12px/1.4 system-ui,sans-serif;color:#e8e2d6;background:#14110d}
.lge-palette{flex:0 0 168px;overflow:auto;border-right:1px solid #2c2620;padding:8px}
.lge-palette h4{margin:8px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#9a8f7a}
.lge-palette h4.lge-pgroup{border-left:3px solid transparent;padding-left:6px;font-weight:700}
.lge-palette button{display:block;width:100%;text-align:left;margin:2px 0;padding:4px 6px;border:1px solid #332c22;border-radius:4px;background:#1d1812;color:#e8e2d6;cursor:pointer;font-size:11px}
.lge-palette button:hover{background:#2a231a}
.lge-canvas-wrap{position:relative;flex:1 1 auto;overflow:hidden;cursor:grab;background:#0f0d0a;background-image:radial-gradient(#241f17 1px,transparent 1px);background-size:22px 22px}
.lge-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
.lge-world{position:absolute;top:0;left:0;z-index:2}
.lge-nodes{position:absolute;top:0;left:0}
.lge-node{position:absolute;width:170px;background:#1b1610;border:1px solid #3a3328;border-radius:7px;box-shadow:0 2px 8px rgba(0,0,0,.45);user-select:none}
.lge-node.sel{border-color:#d4a857;box-shadow:0 0 0 2px rgba(212,168,87,.35)}
.lge-node-head{display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:6px 6px 0 0;cursor:grab;font-weight:600;font-size:11px;color:#fff}
.lge-node-head .x{cursor:pointer;opacity:.7;padding:0 3px}
.lge-node-head .x:hover{opacity:1}
.lge-pins{display:flex;justify-content:space-between;padding:6px 0}
.lge-col{display:flex;flex-direction:column;gap:3px}
.lge-pin{display:flex;align-items:center;gap:5px;font-size:10px;color:#cfc6b4;cursor:crosshair}
.lge-col.out .lge-pin{flex-direction:row-reverse;text-align:right}
.lge-dot{width:9px;height:9px;border-radius:50%;border:1.5px solid #0f0d0a;flex:0 0 auto}
.lge-comment{position:absolute;background:#2b2410;border:1px solid #6b5a2a;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.4);min-width:120px;user-select:none}
.lge-comment.sel{border-color:#d4a857;box-shadow:0 0 0 2px rgba(212,168,87,.35)}
.lge-comment-head{display:flex;justify-content:space-between;align-items:center;padding:3px 7px;font-size:10px;color:#d8c98a;cursor:grab;border-bottom:1px solid #4a3f1f}
.lge-comment-head .x{cursor:pointer;opacity:.7}
.lge-comment-text{display:block;width:100%;box-sizing:border-box;background:transparent;border:none;color:#f0e7c8;font:12px/1.4 system-ui,sans-serif;padding:6px 7px;resize:both;min-height:44px;outline:none}
.lge-edge-hit{stroke:transparent;stroke-width:12;fill:none;cursor:pointer;pointer-events:stroke}
.lge-edge-hit:hover + .lge-edge-line{stroke:#e07a5f;stroke-width:3.5}
.lge-tip{position:fixed;z-index:1000;pointer-events:none;max-width:260px;background:#0b0a08;color:#f0e8d4;border:1px solid #5a4a2a;border-radius:5px;padding:5px 9px;font:11px/1.45 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.55);white-space:normal}
.lge-dot.exec{border-radius:2px;background:#e8e2d6}
.lge-dot.data{background:#5fa8d3}
.lge-inspector{flex:0 0 196px;border-left:1px solid #2c2620;padding:8px;overflow:auto}
.lge-inspector h4{margin:0 0 6px;font-size:11px;color:#d4a857}
.lge-inspector textarea{width:100%;height:160px;background:#0f0d0a;color:#e8e2d6;border:1px solid #332c22;border-radius:4px;font:11px/1.4 monospace;padding:5px}
.lge-inspector .hint{color:#9a8f7a;font-size:10px;margin-top:6px}
.lge-toolbar{position:absolute;top:6px;right:6px;z-index:5;display:flex;gap:4px}
.lge-toolbar button{padding:3px 8px;border:1px solid #332c22;border-radius:4px;background:#1d1812;color:#e8e2d6;cursor:pointer;font-size:11px}
.lge-status{position:absolute;left:8px;bottom:6px;z-index:5;font-size:11px;padding:2px 7px;border-radius:4px}
.lge-status.ok{background:#14331a;color:#86efac}
.lge-status.err{background:#3a1414;color:#fca5a5}
`;

export class LogicGraphEditor {
  constructor(container, graph, { onChange } = {}) {
    this.container = container;
    this.graph = graph;
    this.onChange = onChange ?? (() => {});
    this.selected = null;
    this._linking = null; // { from:{node,pin}, kind } while dragging a new edge
  }

  mount() {
    if (!document.getElementById('lge-style')) {
      const s = document.createElement('style');
      s.id = 'lge-style'; s.textContent = CSS; document.head.appendChild(s);
    }
    this.container.innerHTML = '';
    const root = el('div', 'lge-root');
    this.palette = el('div', 'lge-palette');
    this.canvasWrap = el('div', 'lge-canvas-wrap');
    this.svg = svgEl('svg', { class: 'lge-edges' });
    this.nodesLayer = el('div', 'lge-nodes');
    this.inspector = el('div', 'lge-inspector');

    // The nodes live in a transformed "world"; edges draw on a screen-space SVG.
    this.world = el('div', 'lge-world');
    this.world.append(this.nodesLayer);

    const toolbar = el('div', 'lge-toolbar');
    toolbar.append(
      btn('Auto-layout', () => { autoLayout(this.graph); this._pz?.reset(); this.render(); this._emit(); }),
      btn('Reset view', () => this._pz?.reset()),
    );
    this.status = el('div', 'lge-status ok'); this.status.textContent = 'ready';

    this.canvasWrap.append(this.svg, this.world, toolbar, this.status);
    root.append(this.palette, this.canvasWrap, this.inspector);
    this.container.append(root);

    // Instant custom tooltips (native `title` is slow/flaky in Electron). Any
    // element with a [data-tip] shows it near the cursor — pins, palette nodes.
    this._tip = el('div', 'lge-tip'); this._tip.style.display = 'none';
    root.append(this._tip);
    root.addEventListener('mousemove', (e) => {
      const host = e.target.closest?.('[data-tip]');
      const text = host?.getAttribute('data-tip');
      if (!text) { this._tip.style.display = 'none'; return; }
      this._tip.textContent = text;
      this._tip.style.display = 'block';
      let x = e.clientX + 14, y = e.clientY + 16;
      const w = this._tip.offsetWidth, h = this._tip.offsetHeight;
      if (x + w > window.innerWidth) x = e.clientX - w - 8;
      if (y + h > window.innerHeight) y = e.clientY - h - 8;
      this._tip.style.left = `${x}px`; this._tip.style.top = `${y}px`;
    });
    root.addEventListener('mouseleave', () => { this._tip.style.display = 'none'; });

    // Pan on background-drag, zoom on wheel; redraw edges after each view change.
    this._pz = createPanZoom(this.canvasWrap, this.world, {
      nodeSelector: '.lge-node, .lge-toolbar, .lge-status',
      onChange: () => this._drawEdges(),
    });

    this._buildPalette();
    this._wireCanvas();
    this.render();
    this.renderInspector();
    return this;
  }

  getGraph() { return this.graph; }

  // ── palette ────────────────────────────────────────────────────────────────
  _buildPalette() {
    this.palette.innerHTML = '';
    const title = el('h4'); title.textContent = 'Add node'; this.palette.append(title);
    for (const group of paletteGroups()) {
      // Tint each group heading with its node kind's graph colour, so the palette
      // reads as a legend for the colours nodes get drawn in.
      const h = el('h4', 'lge-pgroup'); h.textContent = group.label;
      const c = KIND_COLOR[group.kind];
      if (c) { h.style.color = c; h.style.borderLeftColor = c; }
      this.palette.append(h);
      for (const t of group.types) {
        const b = btn(t.label, () => {
          // Drop new nodes near the visible top-left, in world coords.
          const v = this._pz?.view ?? { panX: 0, panY: 0, zoom: 1 };
          const n = addNode(this.graph, t.type, (60 - v.panX) / v.zoom, (60 - v.panY) / v.zoom);
          this.selected = n.id; this.render(); this.renderInspector(); this._emit();
        });
        b.dataset.tip = nodeDoc(t.type); // hover the palette item → what the node does
        b.title = nodeDoc(t.type);
        this.palette.append(b);
      }
    }
  }

  // ── canvas + nodes ───────────────────────────────────────────────────────────
  render() {
    this.nodesLayer.innerHTML = '';
    for (const node of this.graph.nodes) this.nodesLayer.append(this._nodeEl(node));
    this._drawEdges();
    this._validate();
  }

  _nodeEl(node) {
    const def = getNodeType(node.type);
    if (def?.kind === NodeKind.COMMENT) return this._commentEl(node);
    const pins = pinsOf(node);
    const card = el('div', 'lge-node' + (this.selected === node.id ? ' sel' : ''));
    card.dataset.id = node.id;
    card.style.left = `${node.x ?? 40}px`;
    card.style.top = `${node.y ?? 40}px`;

    const head = el('div', 'lge-node-head');
    head.style.background = KIND_COLOR[def?.kind] ?? '#444';
    head.dataset.tip = nodeDoc(node.type); // hover the header → what this node does
    const name = el('span'); name.textContent = nodeTitle(node);
    const x = el('span', 'x'); x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); removeNode(this.graph, node.id); if (this.selected === node.id) this.selected = null; this.render(); this.renderInspector(); this._emit(); };
    head.append(name, x);
    head.addEventListener('mousedown', (e) => this._startDrag(e, node));
    card.append(head);

    const body = el('div', 'lge-pins');
    const inCol = el('div', 'lge-col in');
    const outCol = el('div', 'lge-col out');
    if (pins.execIn) inCol.append(this._pinEl(node.type, node.id, 'in', 'exec', 'in', '▸'));
    for (const d of pins.dataIn) inCol.append(this._pinEl(node.type, node.id, d.name, 'data', 'in', d.name));
    for (const p of pins.execOut) outCol.append(this._pinEl(node.type, node.id, p, 'exec', 'out', p));
    for (const d of pins.dataOut) outCol.append(this._pinEl(node.type, node.id, d.name, 'data', 'out', d.name));
    body.append(inCol, outCol);
    card.append(body);

    card.addEventListener('mousedown', () => { this.selected = node.id; this.renderInspector(); this._markSelected(); });
    return card;
  }

  // Comment node — a sticky-note text box; no pins, edited inline.
  _commentEl(node) {
    const card = el('div', 'lge-comment' + (this.selected === node.id ? ' sel' : ''));
    card.dataset.id = node.id;
    card.style.left = `${node.x ?? 40}px`;
    card.style.top = `${node.y ?? 40}px`;
    card.style.width = `${node.params?.w ?? 200}px`;
    const head = el('div', 'lge-comment-head');
    head.textContent = '💬 comment';
    const x = el('span', 'x'); x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); removeNode(this.graph, node.id); if (this.selected === node.id) this.selected = null; this.render(); this.renderInspector(); this._emit(); };
    head.append(x);
    head.addEventListener('mousedown', (e) => this._startDrag(e, node));
    const ta = el('textarea', 'lge-comment-text');
    ta.value = node.params?.text ?? '';
    ta.placeholder = 'Annotate this section…';
    ta.addEventListener('input', () => { node.params = node.params || {}; node.params.text = ta.value; });
    ta.addEventListener('change', () => { node.params.text = ta.value; this._emit(); });
    card.append(head, ta);
    card.addEventListener('mousedown', () => { this.selected = node.id; this._markSelected(); });
    return card;
  }

  _pinEl(nodeType, nodeId, pin, kind, dir, label) {
    const wrap = el('div', 'lge-pin');
    wrap.dataset.tip = pinDoc(nodeType, dir, pin); // instant custom tooltip
    wrap.title = pinDoc(nodeType, dir, pin);       // native fallback (accessibility)
    const dot = el('div', `lge-dot ${kind}`);
    dot.dataset.node = nodeId; dot.dataset.pin = pin; dot.dataset.kind = kind; dot.dataset.dir = dir;
    const txt = el('span'); txt.textContent = label;
    dot.addEventListener('mousedown', (e) => this._startLink(e, nodeId, pin, kind, dir));
    dot.addEventListener('mouseup', (e) => this._endLink(e, nodeId, pin, kind, dir));
    wrap.append(dot, txt);
    return wrap;
  }

  _markSelected() {
    for (const c of this.nodesLayer.children) c.classList.toggle('sel', c.dataset.id === this.selected);
  }

  // ── dragging nodes ────────────────────────────────────────────────────────────
  _startDrag(e, node) {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = node.x ?? 40, oy = node.y ?? 40;
    const move = (m) => {
      const z = this._pz?.getZoom() ?? 1; // screen delta → world delta
      node.x = ox + (m.clientX - sx) / z; // free placement (infinite canvas — negatives ok)
      node.y = oy + (m.clientY - sy) / z;
      const card = this.nodesLayer.querySelector(`.lge-node[data-id="${node.id}"]`);
      if (card) { card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; }
      this._drawEdges();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this._emit(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  // ── linking pins ──────────────────────────────────────────────────────────────
  _startLink(e, node, pin, kind, dir) {
    if (dir !== 'out') return; // links start at an output pin
    e.preventDefault(); e.stopPropagation();
    this._linking = { from: { node, pin }, kind };
    const move = (m) => this._drawEdges(this._cursorPoint(m));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this._linking = null; this._drawEdges(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  _endLink(e, node, pin, kind, dir) {
    if (!this._linking || dir !== 'in') return;
    if (this._linking.kind !== kind) { this.setStatus(`pin type mismatch (${this._linking.kind} → ${kind})`, false); return; }
    try {
      connect(this.graph, this._linking.from, { node, pin }, kind);
      this._linking = null; this.render(); this._emit();
    } catch (err) { this.setStatus(err.message, false); }
  }

  // ── edges (SVG) ───────────────────────────────────────────────────────────────
  _drawEdges(cursor = null) {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    for (const edge of this.graph.edges) {
      const a = this._pinCenter(edge.from.node, edge.from.pin, 'out');
      const b = this._pinCenter(edge.to.node, edge.to.pin, 'in');
      if (!a || !b) continue;
      // A wide transparent hit path (clickable to delete) behind the visible line.
      const hit = svgEl('path', { d: bezierD(a, b), class: 'lge-edge-hit' });
      const tip = svgEl('title'); tip.textContent = 'Click to remove this link';
      hit.append(tip);
      hit.addEventListener('click', (e) => {
        e.stopPropagation();
        removeEdges(this.graph, (x) => x === edge);
        this.render(); this._emit(); this.setStatus('link removed', true);
      });
      const line = bezier(a, b, edge.kind); line.classList.add('lge-edge-line');
      this.svg.append(hit, line);
    }
    if (this._linking && cursor) {
      const a = this._pinCenter(this._linking.from.node, this._linking.from.pin, 'out');
      if (a) this.svg.append(bezier(a, cursor, this._linking.kind, true));
    }
  }

  // Pin centers are read in SCREEN space (getBoundingClientRect reflects the
  // world transform), so the screen-space SVG draws edges correctly at any zoom.
  _pinCenter(nodeId, pin, dir) {
    const dot = this.nodesLayer.querySelector(`.lge-dot[data-node="${cssEsc(nodeId)}"][data-pin="${cssEsc(pin)}"][data-dir="${dir}"]`);
    if (!dot) return null;
    const r = dot.getBoundingClientRect();
    const cr = this.canvasWrap.getBoundingClientRect();
    return { x: r.left + r.width / 2 - cr.left, y: r.top + r.height / 2 - cr.top };
  }

  _cursorPoint(m) {
    return this._pz ? this._pz.screenPoint(m) : (() => { const cr = this.canvasWrap.getBoundingClientRect(); return { x: m.clientX - cr.left, y: m.clientY - cr.top }; })();
  }

  _wireCanvas() {
    // Click on empty canvas (not a node) clears the selection.
    this.canvasWrap.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.lge-node')) { this.selected = null; this._markSelected(); this.renderInspector(); }
    });
  }

  // ── inspector (typed param fields) ──────────────────────────────────────────
  renderInspector() {
    this.inspector.innerHTML = '';
    const node = this.graph.nodes.find((n) => n.id === this.selected);
    const h = el('h4');
    if (!node) { h.textContent = 'No node selected'; this.inspector.append(h, hint('Add nodes from the palette, drag output→input pins to wire them.')); return; }
    h.textContent = `${nodeTitle(node)}  ·  ${node.id}`;
    // Data-input pins that are wired → their backing param is greyed out (#5).
    const connectedInputs = new Set(
      this.graph.edges.filter((e) => e.kind === EdgeKind.DATA && e.to.node === node.id).map((e) => e.to.pin));
    // Typed form — committing a field re-renders the card (so dynamic pins +
    // titles update) and the inspector; 'change' fires on blur so focus is fine.
    const form = buildParamForm(node, {
      doc: document,
      conditions: Object.keys(CONDITIONS),
      connectedInputs,
      onChange: () => { this.setStatus('updated', true); this.render(); this._emit(); },
    });
    this.inspector.append(h, form);
  }

  // ── status + validation ───────────────────────────────────────────────────────
  setStatus(msg, ok) { this.status.className = `lge-status ${ok ? 'ok' : 'err'}`; this.status.textContent = msg; }
  _validate() {
    try {
      // Lightweight: connect()/addNode keep it clean; surface counts.
      this.setStatus(`${this.graph.nodes.length} nodes · ${this.graph.edges.length} edges`, true);
    } catch (e) { this.setStatus(e.message, false); }
  }

  _emit() { this.onChange?.(this.graph); }
}

// ── small DOM helpers ─────────────────────────────────────────────────────────
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function btn(label, onClick) { const b = el('button'); b.textContent = label; b.onclick = onClick; return b; }
function hint(text) { const d = el('div', 'hint'); d.textContent = text; return d; }
function svgEl(tag, attrs = {}) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
function nodeTitle(node) {
  const base = node.type.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
  const p = node.params || {};
  // A Location shows its user-given name (item 1) — fall back to its first hex.
  if (node.type === 'location') {
    const hexes = Array.isArray(p.hexes) && p.hexes.length
      ? p.hexes
      : (Number.isFinite(p.col) && Number.isFinite(p.row) ? [{ col: p.col, row: p.row }] : []);
    const name = (p.label && String(p.label).trim())
      || (hexes[0] ? `${hexes[0].col},${hexes[0].row}` : '—');
    return `📍 ${name}${hexes.length > 1 ? ` +${hexes.length - 1}` : ''}`;
  }
  const sub = p.round != null ? ` (r${p.round})` : p.phase ? ` (${p.phase})` : p.faction ? ` (${p.faction})` : '';
  return base + sub;
}
function bezierD(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
function bezier(a, b, kind, dashed = false) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  const path = svgEl('path', {
    d: `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`,
    fill: 'none',
    stroke: kind === EdgeKind.DATA ? '#5fa8d3' : '#cdbf9e',
    'stroke-width': kind === EdgeKind.DATA ? 1.5 : 2.5,
    'stroke-dasharray': dashed ? '5 4' : (kind === EdgeKind.DATA ? '4 3' : 'none'),
    opacity: dashed ? 0.8 : 0.9,
  });
  return path;
}
