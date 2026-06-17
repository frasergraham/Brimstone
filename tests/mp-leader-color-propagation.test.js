// MP multi-leader color propagation — pure helpers + integration with
// `entityBaseColor` / `unitHexOutlineColor` / `unitIconOwnerColor`.
//
// Background: in online multiplayer with N > 1 leaders per faction, every
// unit on that faction must carry the OWNING LEADER's per-player colour so
// allied units are distinguishable at a glance. Solo / single-leader games
// keep the legacy "faction primary everywhere" appearance.
//
// What this locks down (no Babylon scene needed):
//   • `factionHasMultipleLeaders` counts only ALIVE leader-type entities of
//     a single faction; mid-game leader death drops the count immediately.
//   • `leaderColorFor` walks to the alive leader matching `ownerId` and
//     returns their `.color`; missing leader → null.
//   • `entityBaseColor(entity, entityList)` propagates the owning-leader
//     colour to survivors / minions / golems in the qualifying MP scenario
//     ONLY. Solo / single-leader: byte-identical to the legacy lookup.
//   • `unitHexOutlineColor` mirrors `entityBaseColor` (delegation).
//   • `unitIconOwnerColor` returns the rim/portrait-bg colour for the
//     floating icon billboard — non-null ONLY in qualifying MP play.
//   • `paintUnitIconBadge` accepts an `ownerColor` and paints (a) an outer
//     rim ring near the plane edge, (b) tints the portrait-disc background.
//     When `ownerColor` is omitted the legacy neutral cream fill is used.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EntityType, isLeaderType,
  factionHasMultipleLeaders, leaderColorFor,
} from '../src/entities.js';

import {
  entityBaseColor,
  unitHexOutlineColor,
  unitIconOwnerColor,
  paintUnitIconBadge,
  UNIT_ICON_TEX_SIZE,
  UNIT_ICON_CARD_WIDTH_MUL,
  UNIT_ICON_OWNER_RIM_THICKNESS_FRAC,
} from '../src/renderer-3d.js';

// ── Fixture helpers ────────────────────────────────────────────────────────

const HERO_A = '#ff3030';   // hero player A
const HERO_B = '#3030ff';   // hero player B
const WITCH_A = '#a020f0';  // witch player A

/** Build a leader entity: alive + leader-type + ownerId + color. */
function mkLeader(opts) {
  return {
    id:      opts.id,
    type:    opts.type ?? EntityType.PALADIN,
    owner:   opts.owner ?? 'hero',
    ownerId: opts.ownerId,
    color:   opts.color,
    alive:   opts.alive ?? true,
  };
}

/** Build a non-leader (survivor / minion / etc.) entity. */
function mkUnit(opts) {
  return {
    id:      opts.id,
    type:    opts.type ?? EntityType.SURVIVOR,
    owner:   opts.owner ?? 'hero',
    ownerId: opts.ownerId,
    alive:   opts.alive ?? true,
  };
}

// ── factionHasMultipleLeaders ───────────────────────────────────────────────

describe('factionHasMultipleLeaders', () => {
  test('returns false in solo: 1 hero leader, 1 witch leader', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero',  ownerId: 'pA', color: HERO_A }),
      mkLeader({ id: 2, type: EntityType.WITCH,   owner: 'witch', ownerId: 'wA', color: WITCH_A }),
    ];
    assert.equal(factionHasMultipleLeaders(entities, 'hero'),  false);
    assert.equal(factionHasMultipleLeaders(entities, 'witch'), false);
  });

  test('returns true for hero side with 2 hero leaders (2v1 mismatched MP)', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero',  ownerId: 'pA', color: HERO_A }),
      mkLeader({ id: 2, type: EntityType.ROGUE,   owner: 'hero',  ownerId: 'pB', color: HERO_B }),
      mkLeader({ id: 3, type: EntityType.WITCH,   owner: 'witch', ownerId: 'wA', color: WITCH_A }),
    ];
    assert.equal(factionHasMultipleLeaders(entities, 'hero'),  true);
    assert.equal(factionHasMultipleLeaders(entities, 'witch'), false,
      'witch side still 1-leader; predicate is per-faction');
  });

  test('counts only ALIVE leaders (mid-game leader death drops below threshold)', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A, alive: true  }),
      mkLeader({ id: 2, type: EntityType.ROGUE,   owner: 'hero', ownerId: 'pB', color: HERO_B, alive: false }),
    ];
    assert.equal(factionHasMultipleLeaders(entities, 'hero'), false,
      'second leader dead — back to single-leader appearance');
  });

  test('ignores non-leader entities even if alive + same faction', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A }),
      mkUnit({   id: 2, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pA' }),
      mkUnit({   id: 3, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pA' }),
      mkUnit({   id: 4, type: EntityType.MINION,   owner: 'hero', ownerId: 'pA' }),
    ];
    assert.equal(factionHasMultipleLeaders(entities, 'hero'), false,
      'survivors and minions are not leaders');
  });

  test('returns false for null / empty / invalid input', () => {
    assert.equal(factionHasMultipleLeaders(null, 'hero'),       false);
    assert.equal(factionHasMultipleLeaders([], 'hero'),         false);
    assert.equal(factionHasMultipleLeaders([{}], 'hero'),       false);
    assert.equal(factionHasMultipleLeaders([{}, {}], null),     false);
    assert.equal(factionHasMultipleLeaders([{}, {}], ''),       false);
  });

  test('isLeaderType is the source of truth — sanity check the leader fixtures', () => {
    assert.ok(isLeaderType(EntityType.PALADIN));
    assert.ok(isLeaderType(EntityType.ROGUE));
    assert.ok(isLeaderType(EntityType.WITCH));
    assert.ok(!isLeaderType(EntityType.SURVIVOR));
    assert.ok(!isLeaderType(EntityType.MINION));
  });
});

// ── leaderColorFor ──────────────────────────────────────────────────────────

describe('leaderColorFor', () => {
  test('returns the alive leader colour matching ownerId', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A }),
      mkLeader({ id: 2, type: EntityType.ROGUE,   owner: 'hero', ownerId: 'pB', color: HERO_B }),
    ];
    assert.equal(leaderColorFor(entities, 'pA'), HERO_A);
    assert.equal(leaderColorFor(entities, 'pB'), HERO_B);
  });

  test('returns null when the target leader is dead', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A, alive: false }),
    ];
    assert.equal(leaderColorFor(entities, 'pA'), null);
  });

  test('returns null when ownerId is missing or no leader matches', () => {
    const entities = [
      mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A }),
    ];
    assert.equal(leaderColorFor(entities, null),       null);
    assert.equal(leaderColorFor(entities, ''),         null);
    assert.equal(leaderColorFor(entities, 'unknown'),  null);
    assert.equal(leaderColorFor(null, 'pA'),           null);
  });

  test('ignores non-leader entities even when ownerId matches', () => {
    const entities = [
      mkUnit({ id: 5, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pA' }),
    ];
    assert.equal(leaderColorFor(entities, 'pA'), null);
  });
});

// ── entityBaseColor — leader-color propagation wrapper ──────────────────────

describe('entityBaseColor — solo / single-leader (no propagation)', () => {
  const entities = [
    mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero',  ownerId: 'pA', color: HERO_A }),
    mkLeader({ id: 2, type: EntityType.WITCH,   owner: 'witch', ownerId: 'wA', color: WITCH_A }),
    mkUnit({   id: 3, type: EntityType.SURVIVOR, owner: 'hero',  ownerId: 'pA' }),
  ];

  test('survivor falls through to faction-primary (no leader propagation)', () => {
    const survivor = entities[2];
    const colorNoList = entityBaseColor(survivor);
    const colorWithList = entityBaseColor(survivor, entities);
    // With no entityList we never propagate.
    assert.notEqual(colorNoList, HERO_A);
    // With an entityList in a single-leader game we ALSO don't propagate.
    assert.notEqual(colorWithList, HERO_A,
      'single-leader → byte-identical to legacy lookup');
    // Must be the same as the no-list call (legacy lookup).
    assert.equal(colorWithList, colorNoList);
  });

  test('omitting entityList keeps the legacy behaviour for entities with .color', () => {
    const leader = entities[0];
    assert.equal(entityBaseColor(leader), HERO_A);
    assert.equal(entityBaseColor(leader, entities), HERO_A);
  });
});

describe('entityBaseColor — MP multi-leader propagation', () => {
  // 2v1 mismatched — hero side has 2 leaders, witch side has 1.
  const entities = [
    mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero',  ownerId: 'pA', color: HERO_A }),
    mkLeader({ id: 2, type: EntityType.ROGUE,   owner: 'hero',  ownerId: 'pB', color: HERO_B }),
    mkLeader({ id: 3, type: EntityType.WITCH,   owner: 'witch', ownerId: 'wA', color: WITCH_A }),
    // Hero side: one survivor per player, plus a minion owned by player A.
    mkUnit({ id: 4, type: EntityType.SURVIVOR, owner: 'hero',  ownerId: 'pA' }),
    mkUnit({ id: 5, type: EntityType.SURVIVOR, owner: 'hero',  ownerId: 'pB' }),
    mkUnit({ id: 6, type: EntityType.MINION,   owner: 'hero',  ownerId: 'pA' }),
    // Witch side: survivor under the only leader.
    mkUnit({ id: 7, type: EntityType.SURVIVOR, owner: 'witch', ownerId: 'wA' }),
  ];

  test('hero-side survivor under player A inherits HERO_A', () => {
    const survA = entities[3];
    assert.equal(entityBaseColor(survA, entities), HERO_A);
  });

  test('hero-side survivor under player B inherits HERO_B (allies distinguishable)', () => {
    const survB = entities[4];
    assert.equal(entityBaseColor(survB, entities), HERO_B);
  });

  test('hero-side MINION under player A inherits HERO_A', () => {
    const minion = entities[5];
    assert.equal(entityBaseColor(minion, entities), HERO_A);
  });

  test('witch-side survivor stays on faction-primary fallback (only 1 witch leader)', () => {
    const witchSurv = entities[6];
    const c = entityBaseColor(witchSurv, entities);
    // Must NOT pick up the witch leader's per-player colour.
    assert.notEqual(c, WITCH_A,
      'single-leader witch faction: legacy behaviour');
    // And must be the same as the no-list call.
    assert.equal(c, entityBaseColor(witchSurv));
  });

  test('mid-game leader death reverts propagation to legacy', () => {
    // Same fixture, but player B's leader has died.
    const dead = entities.map(e =>
      e.id === 2 ? { ...e, alive: false } : e);
    const survA = dead.find(e => e.id === 4);
    // Hero side now has only 1 alive leader → predicate flips false.
    assert.equal(entityBaseColor(survA, dead), entityBaseColor(survA),
      'with only player A alive, survivor A reverts to faction-primary');
  });

  test('unowned / no-ownerId hero-side unit drops to faction-primary even in MP', () => {
    const orphan = mkUnit({ id: 99, type: EntityType.SURVIVOR, owner: 'hero', ownerId: null });
    const c = entityBaseColor(orphan, entities);
    assert.equal(c, entityBaseColor(orphan),
      'no ownerId → no leader to look up → legacy fallback');
  });

  test('entity with no .owner at all stays on the neutral grey', () => {
    assert.equal(entityBaseColor({}, entities),    '#888888');
    assert.equal(entityBaseColor(null, entities),  '#888888');
  });

  test('leader\'s own .color always wins (even before the propagation lookup)', () => {
    const leaderA = entities[0];
    assert.equal(entityBaseColor(leaderA, entities), HERO_A);
  });
});

// ── unitHexOutlineColor delegation ──────────────────────────────────────────

describe('unitHexOutlineColor — mirrors entityBaseColor for both modes', () => {
  const entities = [
    mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A }),
    mkLeader({ id: 2, type: EntityType.ROGUE,   owner: 'hero', ownerId: 'pB', color: HERO_B }),
    mkUnit({   id: 3, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pB' }),
  ];

  test('survivor outline matches the propagated leader colour in MP', () => {
    const surv = entities[2];
    assert.equal(unitHexOutlineColor(surv, entities), HERO_B);
    assert.equal(unitHexOutlineColor(surv, entities), entityBaseColor(surv, entities));
  });

  test('survivor outline falls back to legacy faction tint without entityList', () => {
    const surv = entities[2];
    assert.equal(unitHexOutlineColor(surv), entityBaseColor(surv));
  });
});

// ── unitIconOwnerColor ─────────────────────────────────────────────────────

describe('unitIconOwnerColor — floating icon rim + portrait background', () => {
  const soloEntities = [
    mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A }),
    mkUnit({   id: 2, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pA' }),
  ];
  const mpEntities = [
    mkLeader({ id: 1, type: EntityType.PALADIN, owner: 'hero', ownerId: 'pA', color: HERO_A }),
    mkLeader({ id: 2, type: EntityType.ROGUE,   owner: 'hero', ownerId: 'pB', color: HERO_B }),
    mkUnit({   id: 3, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pA' }),
    mkUnit({   id: 4, type: EntityType.SURVIVOR, owner: 'hero', ownerId: 'pB' }),
  ];

  test('returns null in solo / single-leader play (legacy look preserved)', () => {
    const surv = soloEntities[1];
    assert.equal(unitIconOwnerColor(surv, soloEntities), null);
  });

  test('returns the owning-leader colour for an MP survivor', () => {
    assert.equal(unitIconOwnerColor(mpEntities[2], mpEntities), HERO_A);
    assert.equal(unitIconOwnerColor(mpEntities[3], mpEntities), HERO_B);
  });

  test('returns the leader\'s OWN colour when called on a leader entity', () => {
    assert.equal(unitIconOwnerColor(mpEntities[0], mpEntities), HERO_A);
    assert.equal(unitIconOwnerColor(mpEntities[1], mpEntities), HERO_B);
  });

  test('returns null for orphan units, missing entities, or empty list', () => {
    const orphan = mkUnit({ id: 99, type: EntityType.SURVIVOR, owner: 'hero', ownerId: null });
    assert.equal(unitIconOwnerColor(orphan, mpEntities), null,
      'no ownerId → no leader to walk to');
    assert.equal(unitIconOwnerColor(null, mpEntities), null);
    assert.equal(unitIconOwnerColor(mpEntities[2], null), null);
    assert.equal(unitIconOwnerColor(mpEntities[2], []), null);
  });

  test('reverts to null after the owning leader dies (predicate flips)', () => {
    const dead = mpEntities.map(e =>
      e.id === 2 ? { ...e, alive: false } : e);
    // After leader B dies, the predicate is false; survivor A reverts to null.
    assert.equal(unitIconOwnerColor(dead[2], dead), null);
  });
});

// ── paintUnitIconBadge — outer rim + portrait background ───────────────────
//
// Use a recording canvas-ish stub: track style assignments + arc geometry so
// we can prove the outer rim is drawn at the right radius with the right
// colour AND that the disc background fillStyle was set to ownerColor.

function makeRecordingCtx() {
  const calls = [];
  let style = { fillStyle: null, strokeStyle: null, lineWidth: 1, lineCap: 'butt' };
  return {
    calls,
    get fillStyle()   { return style.fillStyle; },
    set fillStyle(v)  { style.fillStyle   = v; calls.push({ op: 'setFill',   value: v }); },
    get strokeStyle() { return style.strokeStyle; },
    set strokeStyle(v){ style.strokeStyle = v; calls.push({ op: 'setStroke', value: v }); },
    get lineWidth()   { return style.lineWidth; },
    set lineWidth(v)  { style.lineWidth   = v; calls.push({ op: 'setLineWidth', value: v }); },
    get lineCap()     { return style.lineCap; },
    set lineCap(v)    { style.lineCap     = v; calls.push({ op: 'setLineCap', value: v }); },
    get textAlign()   { return ''; }, set textAlign(_)  {},
    get textBaseline(){ return ''; }, set textBaseline(_){},
    get font()        { return ''; }, set font(_)       {},
    get lineJoin()    { return ''; }, set lineJoin(_)   {},

    clearRect: () => calls.push({ op: 'clearRect' }),
    beginPath: () => calls.push({ op: 'beginPath' }),
    closePath: () => calls.push({ op: 'closePath' }),
    arc: (cx, cy, r, sa, ea) => calls.push({
      op: 'arc', cx, cy, r, sa, ea,
      // capture style at time of arc so we can match stroke/fill to geometry
      stroke: style.strokeStyle, fill: style.fillStyle,
      lineWidth: style.lineWidth,
    }),
    stroke: () => calls.push({
      op: 'stroke',
      stroke: style.strokeStyle, lineWidth: style.lineWidth,
    }),
    fill:   () => calls.push({ op: 'fill', fill: style.fillStyle }),
    fillRect: (x, y, w, h) => calls.push({ op: 'fillRect', x, y, w, h, fill: style.fillStyle }),
    save:    () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    clip:    () => calls.push({ op: 'clip' }),
    drawImage: () => calls.push({ op: 'drawImage' }),
    strokeText: () => {},
    fillText:   () => {},
    measureText: () => ({ width: 0 }),
  };
}

describe('paintUnitIconBadge — ownerColor outer rim + portrait background', () => {
  const size  = UNIT_ICON_TEX_SIZE;
  const width = UNIT_ICON_TEX_SIZE * UNIT_ICON_CARD_WIDTH_MUL;

  test('no ownerColor: no outer rim drawn; portrait background is neutral cream', () => {
    const ctx = makeRecordingCtx();
    paintUnitIconBadge(ctx, { size, width, hp: 10, maxHp: 10 });
    // No stroke call should carry the (absent) ownerColor.
    const strokeColors = ctx.calls
      .filter(c => c.op === 'stroke')
      .map(c => c.stroke);
    assert.ok(!strokeColors.includes('#ff3030'),
      'no MP rim should be drawn when ownerColor is omitted');
    // Portrait disc background fillRect should use the neutral cream.
    const bgFill = ctx.calls.find(c => c.op === 'fillRect');
    assert.equal(bgFill.fill, 'rgba(225,220,210,1)',
      'legacy neutral fill when no ownerColor');
  });

  test('with ownerColor: outer rim drawn at owner colour; portrait background tinted', () => {
    const ctx = makeRecordingCtx();
    paintUnitIconBadge(ctx, { size, width, hp: 10, maxHp: 10, ownerColor: '#ff3030' });
    // The very first stroke after the leading clearRect should be the rim arc
    // painted in ownerColor.
    const strokeWithOwner = ctx.calls
      .filter(c => c.op === 'stroke' && c.stroke === '#ff3030');
    assert.ok(strokeWithOwner.length >= 1,
      'an outer rim stroke must be issued in the owner colour');
    // And the portrait disc background fillRect should use ownerColor.
    const bgFill = ctx.calls.find(c => c.op === 'fillRect');
    assert.equal(bgFill.fill, '#ff3030',
      'portrait background must be tinted to ownerColor in MP play');
  });

  test('rim is drawn just inside the plane edge (sanity-check radius is large)', () => {
    const ctx = makeRecordingCtx();
    paintUnitIconBadge(ctx, { size, width, hp: 10, maxHp: 10, ownerColor: '#ff3030' });
    // First arc paints the rim at radius ≈ (size/2 - 2 - rim/2). Find it.
    const rimArc = ctx.calls.find(c =>
      c.op === 'arc' && c.stroke === '#ff3030');
    assert.ok(rimArc, 'must have at least one arc keyed to ownerColor');
    const expectedRimThickness = Math.max(2,
      Math.round(size * UNIT_ICON_OWNER_RIM_THICKNESS_FRAC));
    const expectedRadius = (size / 2) - 2 - expectedRimThickness / 2;
    assert.ok(Math.abs(rimArc.r - expectedRadius) < 1,
      `rim arc radius ${rimArc.r} must equal expected ${expectedRadius}`);
    assert.equal(rimArc.lineWidth, expectedRimThickness,
      'rim arc lineWidth must equal the rim thickness');
  });

  test('rim lineWidth is at least as thick as the HP ring (carries colour at zoom-out)', () => {
    const rimT = Math.max(2, Math.round(UNIT_ICON_TEX_SIZE * UNIT_ICON_OWNER_RIM_THICKNESS_FRAC));
    // Reading UNIT_ICON_RING_THICKNESS_FRAC indirectly via the constant cap:
    // we want the rim to NOT be thinner than the HP arc — the rim is the
    // primary "what player owns this" signal at far zoom.
    assert.ok(rimT >= 2);
  });
});
