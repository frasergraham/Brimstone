// ═══════════════════════════════════════════════════════════════════════════
// Logic node param fields — typed form descriptors + DOM renderer
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the logic editor's raw-JSON params textarea with specific UI controls.
// `NODE_PARAM_FIELDS` (pure data, unit-tested) maps each node type to a list of
// field descriptors; `buildParamForm` renders them as typed widgets that write
// straight back into node.params. Composite kinds (hexList, unitList, stringList,
// objectiveSpec) get dedicated sub-editors so nothing is ever hand-typed JSON.
// ═══════════════════════════════════════════════════════════════════════════

const FACTIONS = [{ value: 'hero', label: 'Hero' }, { value: 'witch', label: 'Witch' }];
const PHASES = [{ value: '', label: 'Any phase' }, { value: 'dawn', label: 'Dawn' }, { value: 'day', label: 'Day' }, { value: 'dusk', label: 'Dusk' }, { value: 'night', label: 'Night' }];
const COMPARE_OPS = ['>=', '<=', '==', '>', '<', '!='].map((o) => ({ value: o, label: o }));
const GATE_OPS = [{ value: 'and', label: 'AND' }, { value: 'or', label: 'OR' }, { value: 'not', label: 'NOT (a only)' }];
const STATE_FIELDS = ['round', 'phase', 'heroKills', 'witchKills'].map((f) => ({ value: f, label: f }));
const ENTITY_PROPS = ['hp', 'maxHp', 'faction', 'type', 'alive', 'col', 'row'].map((f) => ({ value: f, label: f }));
const SIDES = [{ value: 'win', label: 'Win' }, { value: 'lose', label: 'Lose' }];

// Common enemy/NPC spawn types (datalist suggestions — free text still allowed).
export const UNIT_TYPES = ['zombie', 'minion', 'wood_golem', 'iron_golem', 'soldier', 'brute', 'necromancer', 'captain', 'rogue', 'survivor'];

// Objective-spec sub-fields keyed by objective type (used by the objectiveOutcome
// node). Keys must stay within KNOWN_OBJECTIVE_TYPES (a test guards this).
export const OBJECTIVE_SPEC_FIELDS = {
  eliminate_all: [{ key: 'targetFaction', label: 'Target faction', kind: 'select', options: FACTIONS }],
  hero_killed: [],
  slay_witch: [],
  survive_rounds: [{ key: 'rounds', label: 'Rounds', kind: 'number' }],
  rounds_exceeded: [{ key: 'rounds', label: 'Round limit', kind: 'number' }],
  reach_hex: [{ key: 'col', label: 'Col', kind: 'number' }, { key: 'row', label: 'Row', kind: 'number' }],
  control_nodes: [],
  conductor_complete: [],
  phase_without_survivors: [{ key: 'phase', label: 'Phase', kind: 'select', options: PHASES }, { key: 'survivors', label: 'Min survivors', kind: 'number' }],
  survive_with_party: [{ key: 'phase', label: 'Phase', kind: 'select', options: PHASES }, { key: 'survivors', label: 'Min survivors', kind: 'number' }],
  gather_and_survive: [{ key: 'survivors', label: 'Survivors', kind: 'number' }, { key: 'kills', label: 'Kills (opt)', kind: 'number' }, { key: 'phaseFallback', label: 'Fallback phase', kind: 'select', options: PHASES }],
  survivors_below: [{ key: 'count', label: 'Below count', kind: 'number' }],
  witch_holds_node: [{ key: 'phase', label: 'Phase', kind: 'select', options: PHASES }],
  witch_denied_nodes: [{ key: 'phase', label: 'Phase', kind: 'select', options: PHASES }],
  hero_holds_all_nodes: [{ key: 'phase', label: 'Phase', kind: 'select', options: PHASES }],
  witch_score_threshold: [{ key: 'points', label: 'Points', kind: 'number' }],
  all_party_at_hexes: [{ key: 'hexes', label: 'Target hexes', kind: 'hexList' }, { key: 'faction', label: 'Faction', kind: 'select', options: FACTIONS }],
};

export const OBJECTIVE_TYPES = Object.keys(OBJECTIVE_SPEC_FIELDS).map((t) => ({ value: t, label: t }));

/** Per-node-type field descriptors. */
export const NODE_PARAM_FIELDS = {
  onMissionStart: [],
  onRoundStart: [{ key: 'round', label: 'Round', kind: 'roundOrAny' }],
  onPhase: [{ key: 'phase', label: 'Phase', kind: 'select', options: PHASES, empty: '' }],
  onKillCount: [{ key: 'faction', label: 'Faction', kind: 'select', options: FACTIONS }, { key: 'count', label: 'Kill count', kind: 'number' }],
  onAreaEnter: [{ key: 'hexes', label: 'Trigger hexes (or wire a Location)', kind: 'hexList' }],
  factionEvent: [{ key: 'faction', label: 'Faction', kind: 'select', options: FACTIONS }, { key: 'threshold', label: 'Unit-count threshold', kind: 'number' }],
  onActor: [{ key: 'ref', label: 'Unit ref', kind: 'text' }],
  onConversationEnd: [{ key: 'conversationId', label: 'Conversation id', kind: 'text' }],
  location: [{ key: 'label', label: 'Name', kind: 'text' }, { key: 'hexes', label: 'Hexes', kind: 'hexList' }],
  sequence: [{ key: 'outputs', label: 'Output pins', kind: 'number', min: 1 }],
  branch: [],
  filterIsFaction: [{ key: 'faction', label: 'Faction', kind: 'select', options: FACTIONS }],
  doOnce: [],
  counter: [{ key: 'threshold', label: 'Threshold', kind: 'number' }],
  forEach: [],
  compare: [{ key: 'op', label: 'Operator', kind: 'select', options: COMPARE_OPS }],
  logicGate: [{ key: 'op', label: 'Operator', kind: 'select', options: GATE_OPS }],
  getGameState: [{ key: 'field', label: 'State field', kind: 'select', options: STATE_FIELDS }],
  getEntityProperty: [{ key: 'prop', label: 'Property', kind: 'select', options: ENTITY_PROPS }],
  conditionNamed: [{ key: 'name', label: 'Condition', kind: 'select', options: 'conditions' }],
  spawnUnits: [{ key: 'units', label: 'Units to spawn', kind: 'unitList' }],
  despawnUnit: [{ key: 'npc', label: 'NPC id (choreography)', kind: 'text' }, { key: 'id', label: 'Entity id (direct)', kind: 'text' }],
  moveUnit: [{ key: 'npc', label: 'NPC id', kind: 'text' }, { key: 'path', label: 'Path (hexes)', kind: 'hexList' }],
  setFlag: [{ key: 'key', label: 'Flag key', kind: 'text' }, { key: 'value', label: 'Value', kind: 'text' }],
  startConversation: [{ key: 'conversationId', label: 'Conversation id', kind: 'text' }, { key: 'roleInputs', label: 'Wired roles', kind: 'stringList' }],
  storyBeat: [{ key: 'title', label: 'Title', kind: 'text' }, { key: 'text', label: 'Text', kind: 'prose' }],
  winMission: [{ key: 'winner', label: 'Winner', kind: 'select', options: FACTIONS }, { key: 'reason', label: 'Reason', kind: 'prose' }],
  loseMission: [{ key: 'winner', label: 'Winner (beats player)', kind: 'select', options: FACTIONS }, { key: 'reason', label: 'Reason', kind: 'prose' }],
  objectiveOutcome: [{ key: 'side', label: 'Side', kind: 'select', options: SIDES }, { key: 'spec', label: 'Objective', kind: 'objectiveSpec' }, { key: 'reason', label: 'Reason', kind: 'prose' }],
  comment: [{ key: 'text', label: 'Comment text', kind: 'prose' }],
};

// A WHOLE top-level param that is overridden by a wired data input → greyed out
// when connected. (Spawn Units' `at` input replaces only the per-unit spawn
// POSITION, not the whole unit list, so that's handled inside spawnAtControl —
// not here.)
const PARAM_OVERRIDDEN_BY = {
  // A Location wired into an Area node's `area` input defines its whole region,
  // so the authored hex list is overridden.
  onAreaEnter: { hexes: 'area' },
};

export function paramFieldsFor(type) { return NODE_PARAM_FIELDS[type] ?? []; }

// ── DOM rendering ────────────────────────────────────────────────────────────

const CSS = `
.pf-form{display:flex;flex-direction:column;gap:8px}
.pf-empty{color:#8a7f6a;font-size:11px;font-style:italic}
.pf-field>label{display:block;font-size:10px;color:#9a8f7a;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.pf-field input,.pf-field select,.pf-field textarea{width:100%;box-sizing:border-box;background:#0f0d0a;color:#e8e2d6;border:1px solid #332c22;border-radius:4px;font:11px/1.4 system-ui,sans-serif;padding:4px 5px}
.pf-field textarea{height:54px;font-family:inherit;resize:vertical}
.pf-row{display:flex;gap:5px;align-items:center;margin:3px 0}
.pf-row input{min-width:0}
.pf-mini{font-size:9px;color:#8a7f6a;text-transform:uppercase}
.pf-add{align-self:flex-start;background:#2a231a;color:#cdbf9e;border:1px solid #3a3328;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;margin-top:2px}
.pf-x{background:none;border:none;color:#c98;cursor:pointer;padding:0 3px;font-size:13px}
.pf-sub{border:1px solid #2c2620;border-radius:5px;padding:6px;background:#16120d}
.pf-check{display:flex;align-items:center;gap:5px;font-size:11px;color:#cfc6b4}
.pf-check input{width:auto}
.pf-overridden{opacity:.5}
.pf-overridden .pf-mini{color:#9ec5e8;opacity:1;margin-top:3px}
`;

function ensureStyle(doc) {
  if (!doc.getElementById('pf-style')) { const s = doc.createElement('style'); s.id = 'pf-style'; s.textContent = CSS; doc.head.appendChild(s); }
}

/**
 * Build a typed params form for a node.
 * @param {object} node - graph node ({ type, params })
 * @param {object} opts - { onChange(), doc, conditions:string[] }
 * @returns {HTMLElement}
 */
export function buildParamForm(node, { onChange = () => {}, doc = document, conditions = [], connectedInputs = new Set() } = {}) {
  ensureStyle(doc);
  node.params = node.params || {};
  // Lazily migrate a legacy single-hex Location ({col,row}) to the list shape so
  // the Hexes editor shows its existing cell instead of an empty list.
  if (node.type === 'location'
      && !(Array.isArray(node.params.hexes) && node.params.hexes.length)
      && Number.isFinite(node.params.col) && Number.isFinite(node.params.row)) {
    node.params.hexes = [{ col: node.params.col, row: node.params.row }];
    delete node.params.col; delete node.params.row;
  }
  const form = elc(doc, 'div', 'pf-form');
  const fields = paramFieldsFor(node.type);
  if (!fields.length) { form.append(elc(doc, 'div', 'pf-empty', 'This node has no parameters.')); return form; }
  const overrides = PARAM_OVERRIDDEN_BY[node.type] ?? {};
  const ctx = { doc, onChange, conditions, connectedInputs };
  for (const f of fields) {
    const overridingPin = overrides[f.key];
    if (overridingPin && connectedInputs.has(overridingPin)) {
      // The param is supplied by a wired input — ZERO the now-redundant authored
      // value (list fields → empty, others → unset) so it reads as overridden,
      // then show it greyed/disabled with a note pointing at the input pin.
      if (Array.isArray(node.params[f.key])) node.params[f.key] = [];
      else if (node.params[f.key] !== undefined) delete node.params[f.key];
      const wrap = elc(doc, 'div', 'pf-field pf-overridden');
      if (f.label) wrap.append(elc(doc, 'label', null, f.label));
      const note = elc(doc, 'div', 'pf-mini', `↳ provided by the “${overridingPin}” input`);
      const ctrl = controlFor(node.params, f, ctx);
      ctrl.querySelectorAll?.('input, select, textarea, button').forEach((el) => { el.disabled = true; });
      if (ctrl.tagName === 'INPUT' || ctrl.tagName === 'SELECT' || ctrl.tagName === 'TEXTAREA') ctrl.disabled = true;
      wrap.append(ctrl, note);
      form.append(wrap);
    } else {
      form.append(renderField(node.params, f, ctx));
    }
  }
  return form;
}

function renderField(params, field, ctx) {
  const { doc } = ctx;
  const wrap = elc(doc, 'div', 'pf-field');
  if (field.label) wrap.append(elc(doc, 'label', null, field.label));
  wrap.append(controlFor(params, field, ctx));
  return wrap;
}

function controlFor(params, field, ctx) {
  switch (field.kind) {
    case 'text': return textControl(params, field, ctx, false);
    case 'prose': return textControl(params, field, ctx, true);
    case 'number': return numberControl(params, field, ctx);
    case 'select': return selectControl(params, field, ctx);
    case 'roundOrAny': return roundOrAnyControl(params, field, ctx);
    case 'hexList': return hexListControl(params, field, ctx);
    case 'unitList': return unitListControl(params, field, ctx);
    case 'stringList': return stringListControl(params, field, ctx);
    case 'objectiveSpec': return objectiveSpecControl(params, field, ctx);
    default: return textControl(params, field, ctx, false);
  }
}

function textControl(params, field, ctx, multiline) {
  const el = ctx.doc.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) el.type = 'text';
  el.value = params[field.key] ?? '';
  el.addEventListener('change', () => { setOrDelete(params, field.key, el.value.trim() === '' ? undefined : el.value); ctx.onChange(); });
  return el;
}

function numberControl(params, field, ctx) {
  const el = ctx.doc.createElement('input');
  el.type = 'number';
  if (field.min != null) el.min = String(field.min);
  el.value = params[field.key] ?? '';
  el.addEventListener('change', () => { setOrDelete(params, field.key, el.value === '' ? undefined : Number(el.value)); ctx.onChange(); });
  return el;
}

function selectControl(params, field, ctx) {
  const el = ctx.doc.createElement('select');
  const opts = field.options === 'conditions' ? ctx.conditions.map((c) => ({ value: c, label: c })) : field.options;
  const list = field.empty != null && !opts.some((o) => o.value === '') ? [{ value: '', label: '—' }, ...opts] : opts;
  for (const o of list) { const opt = ctx.doc.createElement('option'); opt.value = o.value; opt.textContent = o.label; el.append(opt); }
  el.value = params[field.key] ?? (field.empty ?? (list[0]?.value ?? ''));
  el.addEventListener('change', () => { setOrDelete(params, field.key, el.value === '' ? undefined : el.value); ctx.onChange(); });
  return el;
}

function roundOrAnyControl(params, field, ctx) {
  const { doc } = ctx;
  const box = elc(doc, 'div', 'pf-sub');
  const check = elc(doc, 'label', 'pf-check');
  const cb = doc.createElement('input'); cb.type = 'checkbox';
  cb.checked = params[field.key] === 'any' || params[field.key] == null && false;
  const num = doc.createElement('input'); num.type = 'number'; num.min = '1';
  num.value = typeof params[field.key] === 'number' ? params[field.key] : '';
  const sync = () => {
    if (cb.checked) { params[field.key] = 'any'; num.disabled = true; }
    else { num.disabled = false; setOrDelete(params, field.key, num.value === '' ? undefined : Number(num.value)); }
    ctx.onChange();
  };
  cb.checked = params[field.key] === 'any';
  num.disabled = cb.checked;
  check.append(cb, doc.createTextNode('Every round'));
  cb.addEventListener('change', sync);
  num.addEventListener('change', sync);
  box.append(check, labeledMini(doc, 'or specific round', num));
  return box;
}

function hexListControl(params, field, ctx) {
  const { doc } = ctx;
  const box = elc(doc, 'div', 'pf-sub');
  if (!Array.isArray(params[field.key])) params[field.key] = [];
  const list = params[field.key];
  const rebuild = () => {
    box.innerHTML = '';
    list.forEach((h, i) => {
      const row = elc(doc, 'div', 'pf-row');
      const col = numInput(doc, h.col, (v) => { h.col = v ?? 0; ctx.onChange(); });
      const r = numInput(doc, h.row, (v) => { h.row = v ?? 0; ctx.onChange(); });
      row.append(elc(doc, 'span', 'pf-mini', 'col'), col, elc(doc, 'span', 'pf-mini', 'row'), r, xButton(doc, () => { list.splice(i, 1); rebuild(); ctx.onChange(); }));
      box.append(row);
    });
    const add = elc(doc, 'button', 'pf-add', '+ hex'); add.type = 'button';
    add.addEventListener('click', () => { list.push({ col: 0, row: 0 }); rebuild(); ctx.onChange(); });
    box.append(add);
  };
  rebuild();
  return box;
}

function unitListControl(params, field, ctx) {
  const { doc } = ctx;
  const box = elc(doc, 'div', 'pf-sub');
  if (!Array.isArray(params[field.key])) params[field.key] = [];
  const list = params[field.key];
  ensureUnitDatalist(doc);
  const rebuild = () => {
    box.innerHTML = '';
    list.forEach((u, i) => {
      const card = elc(doc, 'div', 'pf-sub');
      // type
      const type = doc.createElement('input'); type.setAttribute('list', 'pf-unit-types'); type.placeholder = 'unit type';
      type.value = u.type ?? ''; type.addEventListener('change', () => { u.type = type.value; ctx.onChange(); });
      card.append(labeledMini(doc, 'type', type));
      // spawnAt
      card.append(spawnAtControl(doc, u, ctx));
      // level + log
      const lvl = numInput(doc, u.level, (v) => { setOrDelete(u, 'level', v); ctx.onChange(); });
      card.append(labeledMini(doc, 'level (opt)', lvl));
      const log = doc.createElement('input'); log.type = 'text'; log.placeholder = 'spawn message (opt)';
      log.value = u.spawnLog ?? ''; log.addEventListener('change', () => { setOrDelete(u, 'spawnLog', log.value || undefined); ctx.onChange(); });
      card.append(labeledMini(doc, 'log', log));
      const del = elc(doc, 'button', 'pf-add', 'remove unit'); del.type = 'button';
      del.addEventListener('click', () => { list.splice(i, 1); rebuild(); ctx.onChange(); });
      card.append(del);
      box.append(card);
    });
    const add = elc(doc, 'button', 'pf-add', '+ unit'); add.type = 'button';
    add.addEventListener('click', () => { list.push({ type: 'zombie', spawnAt: 'near_hero' }); rebuild(); ctx.onChange(); });
    box.append(add);
  };
  rebuild();
  return box;
}

const SPAWN_NAMED = [{ value: '__hex', label: 'At hex…' }, { value: 'near_hero', label: 'Near hero' }, { value: 'map_edge', label: 'Map edge' }, { value: 'graveyard', label: 'Graveyard' }];
function spawnAtControl(doc, u, ctx) {
  // When a Location node is wired to the Spawn node's `at` input, it overrides
  // every unit's spawn POSITION — so disable just THIS control (the unit's type /
  // level / message stay editable).
  const overridden = !!ctx.connectedInputs?.has('at');
  const box = elc(doc, 'div', overridden ? 'pf-overridden' : null);
  const sel = doc.createElement('select');
  for (const o of SPAWN_NAMED) { const opt = doc.createElement('option'); opt.value = o.value; opt.textContent = o.label; sel.append(opt); }
  const isHex = typeof u.spawnAt === 'object' && u.spawnAt != null;
  sel.value = isHex ? '__hex' : (u.spawnAt ?? 'near_hero');
  sel.disabled = overridden;
  const hexRow = elc(doc, 'div', 'pf-row');
  const renderHex = () => {
    hexRow.innerHTML = '';
    if (sel.value === '__hex') {
      if (typeof u.spawnAt !== 'object' || !u.spawnAt) u.spawnAt = { col: 0, row: 0 };
      const c = numInput(doc, u.spawnAt.col, (v) => { u.spawnAt.col = v ?? 0; ctx.onChange(); }); c.disabled = overridden;
      const r = numInput(doc, u.spawnAt.row, (v) => { u.spawnAt.row = v ?? 0; ctx.onChange(); }); r.disabled = overridden;
      hexRow.append(elc(doc, 'span', 'pf-mini', 'col'), c, elc(doc, 'span', 'pf-mini', 'row'), r);
    }
  };
  if (!overridden) sel.addEventListener('change', () => { u.spawnAt = sel.value === '__hex' ? { col: 0, row: 0 } : sel.value; renderHex(); ctx.onChange(); });
  renderHex();
  box.append(labeledMini(doc, 'spawn at', sel), hexRow);
  if (overridden) box.append(elc(doc, 'div', 'pf-mini', '↳ position from the Location (at) input'));
  return box;
}

function stringListControl(params, field, ctx) {
  const { doc } = ctx;
  const box = elc(doc, 'div', 'pf-sub');
  if (!Array.isArray(params[field.key])) params[field.key] = [];
  const list = params[field.key];
  const rebuild = () => {
    box.innerHTML = '';
    list.forEach((s, i) => {
      const row = elc(doc, 'div', 'pf-row');
      const inp = doc.createElement('input'); inp.type = 'text'; inp.value = s ?? '';
      inp.addEventListener('change', () => { list[i] = inp.value; ctx.onChange(); });
      row.append(inp, xButton(doc, () => { list.splice(i, 1); rebuild(); ctx.onChange(); }));
      box.append(row);
    });
    const add = elc(doc, 'button', 'pf-add', '+ role'); add.type = 'button';
    add.addEventListener('click', () => { list.push(''); rebuild(); ctx.onChange(); });
    box.append(add);
  };
  rebuild();
  return box;
}

function objectiveSpecControl(params, field, ctx) {
  const { doc } = ctx;
  const box = elc(doc, 'div', 'pf-sub');
  if (typeof params[field.key] !== 'object' || params[field.key] == null) params[field.key] = { type: 'eliminate_all' };
  const spec = params[field.key];
  const rebuild = () => {
    box.innerHTML = '';
    const typeWrap = elc(doc, 'div', 'pf-field');
    typeWrap.append(elc(doc, 'label', null, 'Objective type'));
    const sel = doc.createElement('select');
    for (const o of OBJECTIVE_TYPES) { const opt = doc.createElement('option'); opt.value = o.value; opt.textContent = o.label; sel.append(opt); }
    sel.value = spec.type ?? 'eliminate_all';
    sel.addEventListener('change', () => { spec.type = sel.value; rebuild(); ctx.onChange(); });
    typeWrap.append(sel); box.append(typeWrap);
    for (const sf of (OBJECTIVE_SPEC_FIELDS[spec.type] ?? [])) box.append(renderField(spec, sf, ctx));
  };
  rebuild();
  return box;
}

// ── tiny DOM helpers ──────────────────────────────────────────────────────────
function elc(doc, tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function setOrDelete(obj, key, val) { if (val === undefined || val === '' || (typeof val === 'number' && Number.isNaN(val))) delete obj[key]; else obj[key] = val; }
function numInput(doc, val, onChange) { const i = doc.createElement('input'); i.type = 'number'; i.value = (val ?? '') === '' ? '' : val; i.addEventListener('change', () => onChange(i.value === '' ? undefined : Number(i.value))); return i; }
function labeledMini(doc, label, control) { const w = elc(doc, 'div'); w.append(elc(doc, 'span', 'pf-mini', label), control); return w; }
function xButton(doc, onClick) { const b = elc(doc, 'button', 'pf-x', '✕'); b.type = 'button'; b.addEventListener('click', onClick); return b; }
function ensureUnitDatalist(doc) {
  if (doc.getElementById('pf-unit-types')) return;
  const dl = doc.createElement('datalist'); dl.id = 'pf-unit-types';
  for (const t of UNIT_TYPES) { const o = doc.createElement('option'); o.value = t; dl.append(o); }
  doc.body.append(dl);
}
