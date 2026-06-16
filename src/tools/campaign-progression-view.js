// ═══════════════════════════════════════════════════════════════════════════
// Campaign Progression — DOM/SVG view (Caleb's Studio)
// ─────────────────────────────────────────────────────────────────────────────
// Renders the mission-dependency DAG (campaign-progression.js): mission cards in
// a left→right layered layout, prerequisite edges as SVG curves, and an inspector
// to edit a mission's gate (requires + rich `unlock`) and rewards. "Open in Logic
// editor" jumps to that mission's event graph. Dependency-free; verified
// in-browser. Save writes the edited fields back via the host's onSave callback.
// ═══════════════════════════════════════════════════════════════════════════

import { gateSummary, rewardSummary, layoutProgression } from './campaign-progression.js';
import { criterionToRows, rowsToCriterion, LEAF_TYPES, blankRow } from './unlock-fields.js';
import { createPanZoom } from './graph-pan-zoom.js';

const RESOURCE_KEYS = ['wood', 'metal', 'herbs', 'food', 'silver', 'scripture'];

const CSS = `
.cpv-root{display:flex;height:100%;min-height:380px;font:12px/1.4 system-ui,sans-serif;color:#e8e2d6;background:#14110d}
.cpv-canvas{position:relative;flex:1 1 auto;overflow:hidden;cursor:grab;background:#0f0d0a;background-image:radial-gradient(#241f17 1px,transparent 1px);background-size:22px 22px}
.cpv-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
.cpv-world{position:absolute;top:0;left:0;z-index:2}
.cpv-nodes{position:absolute;top:0;left:0}
.cpv-node{position:absolute;width:190px;background:#1b1610;border:1px solid #3a3328;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.45);cursor:grab;user-select:none}
.cpv-node.sel{border-color:#d4a857;box-shadow:0 0 0 2px rgba(212,168,87,.35)}
.cpv-head{display:flex;align-items:center;justify-content:space-between;padding:6px 9px;border-radius:7px 7px 0 0;background:#3b2f1a;color:#ffe9b8;font-weight:600}
.cpv-ch{font-size:9px;background:#0f0d0a;border:1px solid #5a4a30;border-radius:9px;padding:1px 6px;color:#cdbf9e}
.cpv-body{padding:6px 9px;font-size:10px;color:#b8ad97}
.cpv-body .lbl{color:#8a7f6a;text-transform:uppercase;letter-spacing:.05em;font-size:9px;margin-top:4px}
.cpv-body .gate{color:#9ec5e8}.cpv-body .rew{color:#a7d39a}
.cpv-inspector{flex:0 0 230px;border-left:1px solid #2c2620;padding:9px;overflow:auto}
.cpv-inspector h4{margin:0 0 7px;font-size:12px;color:#d4a857}
.cpv-inspector label{display:block;font-size:10px;color:#9a8f7a;margin:7px 0 2px;text-transform:uppercase;letter-spacing:.05em}
.cpv-inspector input,.cpv-inspector textarea{width:100%;background:#0f0d0a;color:#e8e2d6;border:1px solid #332c22;border-radius:4px;font:11px/1.4 monospace;padding:5px;box-sizing:border-box}
.cpv-inspector textarea{height:96px}
.cpv-inspector button{margin-top:8px;padding:5px 9px;border:1px solid #5a4a30;border-radius:4px;background:#2a231a;color:#ffd680;cursor:pointer}
.cpv-toolbar{position:absolute;top:6px;right:6px;z-index:5;display:flex;gap:4px}
.cpv-toolbar button{padding:3px 9px;border:1px solid #332c22;border-radius:4px;background:#1d1812;color:#e8e2d6;cursor:pointer}
.cpv-status{position:absolute;left:8px;bottom:6px;z-index:5;font-size:11px;padding:2px 7px;border-radius:4px;background:#14331a;color:#86efac}
.cpv-status.err{background:#3a1414;color:#fca5a5}
.cpv-inspector select{width:100%;box-sizing:border-box;background:#0f0d0a;color:#e8e2d6;border:1px solid #332c22;border-radius:4px;font:11px/1.4 system-ui,sans-serif;padding:4px}
.cpv-sect{margin-top:11px;border-top:1px solid #2c2620;padding-top:7px}
.cpv-sect>.lbl{color:#d4a857;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;font-weight:600}
.cpv-check{display:flex;align-items:center;gap:6px;font-size:11px;color:#cfc6b4;margin:2px 0}
.cpv-check input{width:auto}
.cpv-checks{max-height:120px;overflow:auto;border:1px solid #2c2620;border-radius:4px;padding:5px}
.cpv-row{display:flex;gap:4px;align-items:center;margin:3px 0}
.cpv-row select,.cpv-row input{min-width:0;flex:1 1 auto}
.cpv-add{background:#2a231a;color:#cdbf9e;border:1px solid #3a3328;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;margin-top:3px}
.cpv-x{background:none;border:none;color:#c98;cursor:pointer;font-size:13px;flex:0 0 auto}
.cpv-res{display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.cpv-res label{font-size:10px;color:#9a8f7a;text-transform:capitalize}
.cpv-modal{position:absolute;inset:0;z-index:20;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
.cpv-modal-box{background:#1b1610;border:1px solid #5a4a30;border-radius:8px;padding:16px;width:300px;box-shadow:0 8px 30px rgba(0,0,0,.6)}
.cpv-modal-box h4{margin:0 0 6px;color:#d4a857}
.cpv-modal-box label{display:block;font-size:10px;color:#9a8f7a;text-transform:uppercase;letter-spacing:.05em;margin:9px 0 2px}
.cpv-modal-box input{width:100%;box-sizing:border-box;background:#0f0d0a;color:#e8e2d6;border:1px solid #332c22;border-radius:4px;padding:6px;font:12px system-ui,sans-serif}
.cpv-modal-actions{display:flex;gap:8px;margin-top:13px}
.cpv-modal-actions button{flex:1}
.cpv-modal-msg{margin-top:8px;font-size:11px;color:#fca5a5;min-height:14px}
`;

export class CampaignProgressionView {
  constructor(container, model, { onSave, onOpenMission, onAddMission } = {}) {
    this.container = container;
    this.model = model;
    this.onSave = onSave ?? (() => {});
    this.onOpenMission = onOpenMission ?? (() => {});
    this.onAddMission = onAddMission ?? null;
    this.selected = null;
  }

  mount() {
    if (!document.getElementById('cpv-style')) {
      const s = document.createElement('style'); s.id = 'cpv-style'; s.textContent = CSS; document.head.appendChild(s);
    }
    this.container.innerHTML = '';
    const root = el('div', 'cpv-root');
    this.canvas = el('div', 'cpv-canvas');
    this.svg = svgEl('svg', { class: 'cpv-edges' });
    this.nodesLayer = el('div', 'cpv-nodes');
    this.inspector = el('div', 'cpv-inspector');

    this.world = el('div', 'cpv-world');
    this.world.append(this.nodesLayer);

    const toolbar = el('div', 'cpv-toolbar');
    toolbar.append(
      ...(this.onAddMission ? [btn('+ Add mission', () => this._promptAddMission())] : []),
      btn('Auto-layout', () => { layoutProgression(this.model.nodes, this.model.edges); this._pz?.reset(); this.render(); }),
      btn('Reset view', () => this._pz?.reset()),
      btn('Save', () => { try { this.onSave(this.model); this.setStatus('saved', true); } catch (e) { this.setStatus(e.message, false); } }),
    );
    this.status = el('div', 'cpv-status'); this.status.textContent = `${this.model.nodes.length} missions`;
    this.canvas.append(this.svg, this.world, toolbar, this.status);
    root.append(this.canvas, this.inspector);
    this.container.append(root);

    this._pz = createPanZoom(this.canvas, this.world, {
      nodeSelector: '.cpv-node, .cpv-toolbar, .cpv-status',
      onChange: () => this._drawEdges(),
    });
    // Click empty canvas → clear selection.
    this.canvas.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.cpv-node')) { this.selected = null; this.render(); }
    });
    this.render();
    return this;
  }

  render() { this.nodesLayer.innerHTML = ''; for (const n of this.model.nodes) this.nodesLayer.append(this._nodeEl(n)); this._drawEdges(); this.renderInspector(); }

  _nodeEl(node) {
    const card = el('div', 'cpv-node' + (this.selected === node.id ? ' sel' : ''));
    card.dataset.id = node.id;
    card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
    const head = el('div', 'cpv-head');
    const t = el('span'); t.textContent = node.title;
    const ch = el('span', 'cpv-ch'); ch.textContent = `Ch ${node.chapter}`;
    head.append(t, ch);
    const body = el('div', 'cpv-body');
    body.append(lbl('Unlock'), span('gate', gateSummary(node)), lbl('Rewards'), span('rew', rewardSummary(node.rewards)));
    card.append(head, body);
    head.addEventListener('mousedown', (e) => this._startDrag(e, node));
    card.addEventListener('mousedown', () => { this.selected = node.id; this.render(); });
    return card;
  }

  _startDrag(e, node) {
    if (e.button !== 0) return; e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = node.x, oy = node.y;
    const move = (m) => {
      const z = this._pz?.getZoom() ?? 1;
      node.x = ox + (m.clientX - sx) / z; node.y = oy + (m.clientY - sy) / z; // free placement

      const c = this.nodesLayer.querySelector(`.cpv-node[data-id="${cssEsc(node.id)}"]`);
      if (c) { c.style.left = `${node.x}px`; c.style.top = `${node.y}px`; }
      this._drawEdges();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  _drawEdges() {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    for (const e of this.model.edges) {
      const a = this._anchor(e.from, 'out'), b = this._anchor(e.to, 'in');
      if (a && b) this.svg.append(bezier(a, b));
    }
  }

  // Screen-space anchors (getBoundingClientRect reflects the world transform).
  _anchor(nodeId, side) {
    const c = this.nodesLayer.querySelector(`.cpv-node[data-id="${cssEsc(nodeId)}"]`);
    if (!c) return null;
    const r = c.getBoundingClientRect(), cr = this.canvas.getBoundingClientRect();
    const x = (side === 'out' ? r.right : r.left) - cr.left;
    const y = r.top + r.height / 2 - cr.top;
    return { x, y };
  }

  renderInspector() {
    this.inspector.innerHTML = '';
    const node = this.model.nodes.find((n) => n.id === this.selected);
    const h = el('h4');
    if (!node) { h.textContent = 'No mission selected'; this.inspector.append(h, hint('Click a mission to edit its unlock gate + rewards. Drag cards to rearrange.')); return; }
    h.textContent = node.title; this.inspector.append(h);

    const commit = () => { this.render(); this.setStatus('edited — click Save to write to disk', true); };
    this.inspector.append(
      this._buildRequires(node, commit),
      this._buildUnlock(node, commit),
      this._buildRewards(node, commit),
      section('', [btn('Open in Logic editor →', () => this.onOpenMission(node.id))]),
      hint('Edges redraw from prerequisites + unlock “mission completed” criteria. Save writes back to the mission JSON.'),
    );
  }

  _otherMissionIds(id) { return this.model.nodes.map((n) => n.id).filter((x) => x !== id); }

  // Requires — a checklist of the other missions (no free-text id typing).
  _buildRequires(node, commit) {
    const box = section('Prerequisite missions');
    const list = el('div', 'cpv-checks');
    for (const other of this._otherMissionIds(node.id)) {
      const lab = el('label', 'cpv-check');
      const cb = mk('input'); cb.type = 'checkbox'; cb.checked = (node.requires ?? []).includes(other);
      cb.addEventListener('change', () => {
        const set = new Set(node.requires ?? []);
        cb.checked ? set.add(other) : set.delete(other);
        node.requires = [...set]; commit();
      });
      const title = this.model.nodes.find((n) => n.id === other)?.title ?? other;
      lab.append(cb, mk('span', null, `${title}`));
      list.append(lab);
    }
    box.append(list);
    return box;
  }

  // Unlock — a flat AND/OR list of leaf criteria (no JSON).
  _buildUnlock(node, commit) {
    const box = section('Unlock criteria');
    const { combinator, rows } = criterionToRows(node.unlock);
    const apply = () => { node.unlock = rowsToCriterion(state.combinator, state.rows); commit(); };
    const state = { combinator, rows };

    const combo = mk('select');
    for (const o of [{ value: 'all', label: 'Match ALL of' }, { value: 'any', label: 'Match ANY of' }]) {
      const op = mk('option'); op.value = o.value; op.textContent = o.label; combo.append(op);
    }
    combo.value = state.combinator;
    combo.addEventListener('change', () => { state.combinator = combo.value; apply(); });
    box.append(combo);

    state.rows.forEach((row, i) => box.append(this._unlockRow(node, state, i, apply)));
    const add = el('button', 'cpv-add', '+ criterion'); add.type = 'button';
    add.addEventListener('click', () => { state.rows.push(blankRow('missionDone')); apply(); });
    box.append(add);
    return box;
  }

  _unlockRow(node, state, i, apply) {
    const row = el('div', 'cpv-row');
    const r = state.rows[i];
    if (r.type === '__advanced') {
      row.append(mk('span', null, 'advanced criterion (kept)'), this._x(() => { state.rows.splice(i, 1); apply(); }));
      return row;
    }
    const typeSel = mk('select');
    for (const t of LEAF_TYPES) { const op = mk('option'); op.value = t.value; op.textContent = t.label; typeSel.append(op); }
    typeSel.value = r.type;
    typeSel.addEventListener('change', () => { state.rows[i] = blankRow(typeSel.value); apply(); });
    row.append(typeSel);

    if (r.type === 'missionDone') {
      const sel = mk('select');
      const blank = mk('option'); blank.value = ''; blank.textContent = '— pick —'; sel.append(blank);
      for (const id of this._otherMissionIds(node.id)) { const o = mk('option'); o.value = id; o.textContent = this.model.nodes.find((n) => n.id === id)?.title ?? id; sel.append(o); }
      sel.value = r.value ?? '';
      sel.addEventListener('change', () => { r.value = sel.value; apply(); });
      row.append(sel);
    } else if (r.type === 'level') {
      row.append(this._num(r.value, (v) => { r.value = v; apply(); }, 'level'));
    } else if (r.type === 'resource') {
      const sel = mk('select');
      for (const k of RESOURCE_KEYS) { const o = mk('option'); o.value = k; o.textContent = k; sel.append(o); }
      sel.value = r.value || 'silver';
      sel.addEventListener('change', () => { r.value = sel.value; apply(); });
      row.append(sel, this._num(r.atLeast ?? 1, (v) => { r.atLeast = v; apply(); }, '≥'));
    } else { // hasItem | flag
      row.append(this._text(r.value, (v) => { r.value = v; apply(); }, r.type === 'flag' ? 'flag key' : 'item id'));
    }
    row.append(this._x(() => { state.rows.splice(i, 1); apply(); }));
    return row;
  }

  // Rewards — a number field per resource (no JSON). Non-resource reward keys are
  // preserved untouched.
  _buildRewards(node, commit) {
    const box = section('Rewards');
    const grid = el('div', 'cpv-res');
    node.rewards = node.rewards ?? {};
    for (const k of RESOURCE_KEYS) {
      const lab = mk('label', null, k);
      const inp = mk('input'); inp.type = 'number'; inp.value = node.rewards[k] ?? '';
      inp.addEventListener('change', () => {
        const v = inp.value === '' ? 0 : Number(inp.value);
        if (!v) delete node.rewards[k]; else node.rewards[k] = v;
        commit();
      });
      grid.append(lab, inp);
    }
    box.append(grid);
    return box;
  }

  _num(val, onChange, ph) { const i = mk('input'); i.type = 'number'; i.placeholder = ph ?? ''; i.value = val ?? ''; i.addEventListener('change', () => onChange(i.value === '' ? '' : Number(i.value))); return i; }
  _text(val, onChange, ph) { const i = mk('input'); i.type = 'text'; i.placeholder = ph ?? ''; i.value = val ?? ''; i.addEventListener('change', () => onChange(i.value)); return i; }
  _x(onClick) { const b = el('button', 'cpv-x', '✕'); b.type = 'button'; b.addEventListener('click', onClick); return b; }

  setStatus(msg, ok) { this.status.className = `cpv-status ${ok ? '' : 'err'}`.trim(); this.status.textContent = msg; }

  // "+ Add mission" — prompt for id + title, create the stub via onAddMission, then
  // add the node to the DAG and select it.
  _promptAddMission() {
    const ov = el('div', 'cpv-modal');
    const box = el('div', 'cpv-modal-box');
    const idF = modalField('Mission id (slug)', 'e.g. the_crossroads');
    const titleF = modalField('Title', 'e.g. The Crossroads');
    const msg = el('div', 'cpv-modal-msg');
    const create = btn('Create', async () => {
      try {
        msg.style.color = ''; msg.textContent = 'Creating…';
        const m = await this.onAddMission({ id: idF.input.value, title: titleF.input.value });
        this.model.nodes.push({ id: m.id, title: m.title, chapter: m.chapter ?? 1, requires: m.requires ?? [], unlock: m.unlock ?? null, rewards: m.rewards ?? {}, x: 30, y: 30 });
        layoutProgression(this.model.nodes, this.model.edges);
        this.selected = m.id;
        ov.remove(); this.render();
        this.setStatus(`created “${m.id}” — double-click it to edit in the Logic editor`, true);
      } catch (e) { msg.textContent = e.message; }
    });
    const cancel = btn('Cancel', () => ov.remove());
    const actions = el('div', 'cpv-modal-actions'); actions.append(create, cancel);
    box.append(el('h4', null, 'New mission'), idF.wrap, titleF.wrap, actions, msg);
    ov.append(box);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
    this.canvas.append(ov);
    idF.input.focus();
    idF.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
  }
}

function modalField(label, placeholder) {
  const wrap = el('div');
  wrap.append(el('label', null, label));
  const input = el('input'); input.type = 'text'; input.placeholder = placeholder;
  wrap.append(input);
  return { wrap, input };
}

// helpers
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const mk = el;
function section(title, children = []) { const box = el('div', 'cpv-sect'); if (title) box.append(el('div', 'lbl', title)); for (const c of children) box.append(c); return box; }
function btn(label, onClick) { const b = el('button'); b.textContent = label; b.onclick = onClick; return b; }
function hint(text) { const d = el('div'); d.style.cssText = 'color:#8a7f6a;font-size:10px;margin-top:8px'; d.textContent = text; return d; }
function lbl(text) { const d = el('div', 'lbl'); d.textContent = text; return d; }
function span(cls, text) { const s = el('div', cls); s.textContent = text; return s; }
function field(label, kind) { const wrap = el('div'); const l = el('label'); l.textContent = label; const input = el(kind); wrap.append(l, input); return { wrap, input }; }
function svgEl(tag, attrs = {}) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
function bezier(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return svgEl('path', { d: `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`, fill: 'none', stroke: '#cdbf9e', 'stroke-width': 2.5, opacity: 0.85 });
}
