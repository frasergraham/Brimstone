// "Send To…" — multiplayer free action that lives on a SURVIVOR. Selecting
// the action opens a radial destination picker; the chosen destination is
// another leader on the same faction. The survivor's ownerId flips to the
// destination leader's ownerId at resolution time.
//
// Action shape on the wire:
//   { type: PlanActionType.SENT_TO, entityId: <survivorId>, destOwnerId: <leaderOwnerId> }
//
// Covered:
//   - happy path (transfer mutates survivor.ownerId)
//   - free action: zero AP cost, doesn't drain budget
//   - cannot transfer to self (same owning leader)
//   - cannot transfer when faction has only one leader (solo / 1v1)
//   - cannot transfer to a leader on the opposing faction
//   - cannot transfer a non-survivor actor (heroes / witches / minions)
//   - cannot transfer when survivor has no live owning leader (orphan)
//   - multi-transfer in one round both apply
//   - getValidActions surfaces SENT_TO only on eligible survivors
//   - resolver routes PlanActionType.SENT_TO through executeSentTo

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import {
  executeSentTo, canUseSentTo, getSentToDestinations,
  getValidActions, ActionType,
} from '../src/actions.js';
import { createSurvivor, createMinion, EntityType } from '../src/entities.js';
import { resolvePlansMP, resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType, actionCosts, validatePlanAction } from '../src/planner.js';

function freshState() {
  return new GameState(true, true);
}

// Build a 2v2 hero-side state by adding two extra heroes to a standard
// GameState. Returns { state, h1, h2, w1 } where h1 / h2 are leader entities
// and w1 is the default witch.
function twoVTwoState() {
  const state = freshState();
  // Default hero (state.hero) already has ownerId='hero'. Add a second hero.
  const h2Spawn = { col: state.hero.col + 1, row: state.hero.row };
  state.addPlayer('h2', 'Hero Two', 'hero', h2Spawn.col, h2Spawn.row, false);
  const h2 = state.entities.find(e => e.ownerId === 'h2');
  assert.ok(h2, 'expected second hero leader to spawn');
  return { state, h1: state.hero, h2, w1: state.witch };
}

// Place a survivor adjacent to `leader`, owned by leader.ownerId. Mirrors
// the live "leader recruits survivor" flow in factions.js which sets the
// faction (`owner`) when the survivor is claimed.
function placeOwnedSurvivor(state, leader, dCol = 1, dRow = 0) {
  const s = createSurvivor(leader.col + dCol, leader.row + dRow, leader.ownerId, state);
  s.owner = leader.owner;
  state.entities.push(s);
  return s;
}

// ── happy path ───────────────────────────────────────────────────────────────

describe('executeSentTo — happy path', () => {
  test('transfers ownerId from current leader to destination leader', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    assert.equal(survivor.ownerId, h1.ownerId);

    const r = executeSentTo(state, survivor, h2.ownerId);
    assert.equal(r.success, true, r.log?.[0]);
    assert.equal(survivor.ownerId, h2.ownerId, 'survivor.ownerId should flip to destination leader');
  });

  test('is a free action (cost === 0)', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = executeSentTo(state, survivor, h2.ownerId);
    assert.equal(r.cost, 0);
  });

  test('emits a human-readable log line', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = executeSentTo(state, survivor, h2.ownerId);
    assert.ok(r.log?.length >= 1);
    // Log line should describe the transfer in some form.
    assert.match(r.log[0], /to/i);
  });

  test('actionCosts() returns false for SENT_TO', () => {
    assert.equal(actionCosts(PlanActionType.SENT_TO), false);
  });
});

// ── edge cases ───────────────────────────────────────────────────────────────

describe('executeSentTo — edge cases', () => {
  test('cannot send to self (current owning leader)', () => {
    const { state, h1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = executeSentTo(state, survivor, h1.ownerId);
    assert.equal(r.success, false);
    assert.match(r.log[0], /yourself/i);
  });

  test('cannot send to a missing destination ownerId', () => {
    const { state, h1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = executeSentTo(state, survivor, null);
    assert.equal(r.success, false);
  });

  test('cannot send to a leader on the opposing faction', () => {
    const { state, h1, w1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = executeSentTo(state, survivor, w1.ownerId);
    assert.equal(r.success, false);
    assert.match(r.log[0], /faction/i);
    assert.equal(survivor.ownerId, h1.ownerId, 'survivor must NOT be transferred to enemy');
  });

  test('cannot send a non-survivor actor (hero leader)', () => {
    const { state, h1, h2 } = twoVTwoState();
    // Pass a leader as the actor. Should fail.
    const r = executeSentTo(state, h1, h2.ownerId);
    assert.equal(r.success, false);
  });

  test('cannot send a non-survivor actor (minion)', () => {
    const { state, h1, h2 } = twoVTwoState();
    const minion = createMinion(h1.col + 1, h1.row + 1, 'witch', state);
    minion.ownerId = h1.ownerId; // contrived
    state.entities.push(minion);
    const r = executeSentTo(state, minion, h2.ownerId);
    assert.equal(r.success, false);
  });

  test('cannot send if destination leader is dead', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    h2.hp = 0; // Entity.alive is a getter that reads hp > 0
    assert.equal(h2.alive, false, 'sanity: hp=0 → not alive');
    const r = executeSentTo(state, survivor, h2.ownerId);
    assert.equal(r.success, false);
    assert.match(r.log[0], /no longer alive/i);
  });

  test('cannot send when the survivor has no live owning leader (orphan)', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    // Sender leader dies — survivor is now orphaned from a live leader.
    h1.hp = 0;
    const r = executeSentTo(state, survivor, h2.ownerId);
    assert.equal(r.success, false);
  });
});

// ── canUseSentTo / availability gate ────────────────────────────────────────

describe('canUseSentTo / SENT_TO availability', () => {
  test('false in solo (1 hero) even with owned survivors', () => {
    const state = freshState();
    const survivor = placeOwnedSurvivor(state, state.hero);
    // Actor is the survivor; faction has only one leader → no destination.
    assert.equal(canUseSentTo(state, survivor), false);
  });

  test('false for a hero leader (leader is no longer the actor)', () => {
    const { state, h1 } = twoVTwoState();
    placeOwnedSurvivor(state, h1);
    // The leader itself must NOT carry the action.
    assert.equal(canUseSentTo(state, h1), false);
  });

  test('false for an orphan survivor (no live owning leader)', () => {
    const { state, h1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    h1.hp = 0;
    assert.equal(canUseSentTo(state, survivor), false);
  });

  test('true for a survivor when there is another leader on its faction', () => {
    const { state, h1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    assert.equal(canUseSentTo(state, survivor), true);
  });

  test('getValidActions surfaces SENT_TO on the SURVIVOR, not the leader', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);

    // Leader does NOT carry SENT_TO any more.
    const leaderActions = getValidActions(state, h1);
    assert.equal(
      leaderActions.find(a => a.type === ActionType.SENT_TO),
      undefined,
      'SENT_TO must NOT appear on the leader\'s action set',
    );

    // Survivor DOES carry SENT_TO.
    const survivorActions = getValidActions(state, survivor);
    const sentTo = survivorActions.find(a => a.type === ActionType.SENT_TO);
    assert.ok(sentTo, 'SENT_TO action should appear on the survivor');
    assert.equal(sentTo.destinations.length, 1);
    assert.equal(sentTo.destinations[0].ownerId, h2.ownerId);

    // Solo state — should NOT surface even on a survivor (no other leader).
    const solo = freshState();
    const soloSurvivor = placeOwnedSurvivor(solo, solo.hero);
    const soloActions = getValidActions(solo, soloSurvivor);
    assert.equal(
      soloActions.find(a => a.type === ActionType.SENT_TO),
      undefined,
      'SENT_TO must not appear in solo / 1v1',
    );
  });

  test('SENT_TO must not appear on a minion / non-survivor unit', () => {
    const { state, h1 } = twoVTwoState();
    const minion = createMinion(h1.col + 1, h1.row + 1, 'witch', state);
    minion.ownerId = h1.ownerId;
    state.entities.push(minion);
    const actions = getValidActions(state, minion);
    assert.equal(
      actions.find(a => a.type === ActionType.SENT_TO),
      undefined,
      'SENT_TO must not surface on a non-survivor unit',
    );
  });

  test('getSentToDestinations excludes the survivor\'s current leader and dead leaders', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    // h1 is the survivor's owner → must not appear in destination list.
    const dests = getSentToDestinations(state, survivor);
    assert.deepEqual(dests.map(d => d.ownerId).sort(), ['h2']);
    h2.hp = 0;
    assert.equal(getSentToDestinations(state, survivor).length, 0);
  });
});

// ── planner validation ──────────────────────────────────────────────────────

describe('validatePlanAction(SENT_TO)', () => {
  test('rejects missing destination', () => {
    const { state, h1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    assert.equal(
      validatePlanAction(state, { type: PlanActionType.SENT_TO, entityId: survivor.id }).valid,
      false,
    );
  });

  test('rejects destination === survivor\'s current owner (self-send)', () => {
    const { state, h1 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = validatePlanAction(state, {
      type: PlanActionType.SENT_TO,
      entityId: survivor.id,
      destOwnerId: h1.ownerId,
    });
    assert.equal(r.valid, false);
  });

  test('accepts a well-formed SENT_TO', () => {
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const r = validatePlanAction(state, {
      type: PlanActionType.SENT_TO,
      entityId: survivor.id,
      destOwnerId: h2.ownerId,
    });
    assert.equal(r.valid, true);
  });

  test('rejects when actor is not a survivor', () => {
    const { state, h1, h2 } = twoVTwoState();
    // entityId is the leader, not a survivor → reject.
    const r = validatePlanAction(state, {
      type: PlanActionType.SENT_TO,
      entityId: h1.id,
      destOwnerId: h2.ownerId,
    });
    assert.equal(r.valid, false);
  });
});

// ── resolver / parity ──────────────────────────────────────────────────────

describe('resolver — SENT_TO routing & parity', () => {
  test('resolvePlansMP routes SENT_TO through executeSentTo and mutates ownerId', () => {
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    assert.ok(steps.length > 0, 'expected at least one step');
    assert.equal(s.ownerId, h2.ownerId);
    // Find the ACTION_OK event
    const events = steps.flatMap(st => (st.playerEvents ?? []).flatMap(pe => pe.events));
    const ok = events.find(e => e.type === ResEventType.ACTION_OK && e.action?.type === PlanActionType.SENT_TO);
    assert.ok(ok, 'expected an ACTION_OK SENT_TO event');
    assert.equal(ok.result.cost, 0);
  });

  test('SENT_TO does not consume the budget — paid action still resolves after it', () => {
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);

    // SENT_TO is now the survivor's action; queue EXPLORE on the leader after it.
    const plan = [
      { type: PlanActionType.SENT_TO, entityId: s.id, destOwnerId: h2.ownerId },
      { type: PlanActionType.EXPLORE, entityId: h1.id },
    ];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const events = steps.flatMap(st => (st.playerEvents ?? []).flatMap(pe => pe.events));
    const sentToOk = events.find(e => e.type === ResEventType.ACTION_OK && e.action?.type === PlanActionType.SENT_TO);
    const exploreOk = events.find(e => e.type === ResEventType.ACTION_OK && e.action?.type === PlanActionType.EXPLORE);
    assert.ok(sentToOk, 'SENT_TO should fire');
    assert.ok(exploreOk, 'EXPLORE should still fire after the free SENT_TO');
  });

  test('multi-transfer in one round: both survivors flip', () => {
    const { state, h1, h2 } = twoVTwoState();
    const sA = placeOwnedSurvivor(state, h1, 1, 0);
    const sB = placeOwnedSurvivor(state, h1, -1, 0);

    const plan = [
      { type: PlanActionType.SENT_TO, entityId: sA.id, destOwnerId: h2.ownerId },
      { type: PlanActionType.SENT_TO, entityId: sB.id, destOwnerId: h2.ownerId },
    ];
    resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero', plan },
      { playerId: h2.ownerId, faction: 'hero', plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    assert.equal(sA.ownerId, h2.ownerId);
    assert.equal(sB.ownerId, h2.ownerId);
  });

  test('legacy resolvePlans (offline 1v1) routes SENT_TO too — fails as expected when only one leader', () => {
    // Offline 1v1 — only one hero leader, so SENT_TO must fail gracefully and not crash.
    const state = freshState();
    const s = placeOwnedSurvivor(state, state.hero);
    const heroPlan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: 'no-such-player',
    }];
    const steps = resolvePlans(state, heroPlan, []);
    // Survivor still belongs to hero
    assert.equal(s.ownerId, state.hero.ownerId);
    // Hero plan emitted an ACTION_FAIL (gracefully)
    const events = steps.flatMap(st => st.heroEvents ?? []);
    const fail = events.find(e => e.type === ResEventType.ACTION_FAIL);
    assert.ok(fail, 'expected ACTION_FAIL for an impossible SENT_TO');
  });
});

// ── SURVIVOR_RECEIVED — paired counterpart of SENT_TO ACTION_OK ─────────────

describe('resolver — SURVIVOR_RECEIVED on recipient bucket', () => {
  test('resolvePlansMP pushes a SURVIVOR_RECEIVED event into the destination owner\'s bucket', () => {
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);

    // There must be exactly one SURVIVOR_RECEIVED event, on h2's bucket.
    const recvEntries = steps.flatMap(st =>
      (st.playerEvents ?? []).flatMap(pe => pe.events.map(e => ({ ...e, _pe: pe }))),
    ).filter(e => e.type === ResEventType.SURVIVOR_RECEIVED);
    assert.equal(recvEntries.length, 1, 'expected exactly one SURVIVOR_RECEIVED event');
    assert.equal(recvEntries[0]._pe.playerId, h2.ownerId,
      'SURVIVOR_RECEIVED must land on the RECIPIENT bucket, not the sender');
    assert.notEqual(recvEntries[0]._pe.playerId, h1.ownerId,
      'SURVIVOR_RECEIVED must NOT land on the sender bucket');
  });

  test('SURVIVOR_RECEIVED carries the four claimed payload fields (plus destOwnerId)', () => {
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const recv = steps.flatMap(st => (st.playerEvents ?? []).flatMap(pe => pe.events))
      .find(e => e.type === ResEventType.SURVIVOR_RECEIVED);
    assert.ok(recv, 'expected a SURVIVOR_RECEIVED event');
    // The 4 claimed fields
    assert.equal(recv.survivorId,    s.id);
    assert.equal(recv.survivorName,  s.displayName);
    assert.equal(recv.fromOwnerId,   h1.ownerId);
    assert.equal(recv.fromOwnerName, h1.displayName);
    // Plus destOwnerId so the digest builder can locate the recipient leader
    // from the pre-step snapshot without consulting the post-step state.
    assert.equal(recv.destOwnerId,   h2.ownerId);
  });

  test('SURVIVOR_RECEIVED creates a fresh bucket if the recipient had no actions', () => {
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    // h2 has an empty plan — so absent SENT_TO, h2 would have NO bucket in
    // any step. The fan-out must synthesise one for the received card.
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const h2Buckets = steps.flatMap(st => (st.playerEvents ?? [])).filter(
      pe => pe.playerId === h2.ownerId
    );
    assert.ok(h2Buckets.length >= 1, 'h2 should have at least one bucket after SENT_TO');
    const allH2Events = h2Buckets.flatMap(b => b.events);
    const recv = allH2Events.find(e => e.type === ResEventType.SURVIVOR_RECEIVED);
    assert.ok(recv, 'h2 bucket must carry the SURVIVOR_RECEIVED event');
  });

  test('multi-transfer in one step emits one SURVIVOR_RECEIVED per SENT_TO', () => {
    const { state, h1, h2 } = twoVTwoState();
    const sA = placeOwnedSurvivor(state, h1, 1, 0);
    const sB = placeOwnedSurvivor(state, h1, -1, 0);
    const plan = [
      { type: PlanActionType.SENT_TO, entityId: sA.id, destOwnerId: h2.ownerId },
      { type: PlanActionType.SENT_TO, entityId: sB.id, destOwnerId: h2.ownerId },
    ];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const recvs = steps.flatMap(st => (st.playerEvents ?? []).flatMap(pe => pe.events))
      .filter(e => e.type === ResEventType.SURVIVOR_RECEIVED);
    assert.equal(recvs.length, 2);
    assert.deepEqual(recvs.map(r => r.survivorId).sort(), [sA.id, sB.id].sort());
  });

  test('failed SENT_TO does NOT emit a SURVIVOR_RECEIVED', () => {
    const { state, h1 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    // Send to self → fails
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h1.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const recvs = steps.flatMap(st => (st.playerEvents ?? []).flatMap(pe => pe.events))
      .filter(e => e.type === ResEventType.SURVIVOR_RECEIVED);
    assert.equal(recvs.length, 0, 'no recv event when SENT_TO fails');
  });

  test('legacy resolvePlans path emits SURVIVOR_RECEIVED on same-faction bucket', () => {
    // Construct an offline-but-multi-leader scenario by adding a second hero
    // and calling resolvePlans (legacy). SENT_TO will succeed on the legacy
    // faction-bucket path; the received event must land alongside the sender's.
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    const heroPlan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlans(state, heroPlan, []);
    const heroEvents = steps.flatMap(st => st.heroEvents ?? []);
    const ok   = heroEvents.find(e => e.type === ResEventType.ACTION_OK
      && e.action?.type === PlanActionType.SENT_TO);
    const recv = heroEvents.find(e => e.type === ResEventType.SURVIVOR_RECEIVED);
    assert.ok(ok,   'expected ACTION_OK for the SENT_TO');
    assert.ok(recv, 'expected SURVIVOR_RECEIVED on the hero bucket');
    assert.equal(recv.survivorId,    s.id);
    assert.equal(recv.fromOwnerId,   h1.ownerId);
    assert.equal(recv.fromOwnerName, h1.displayName);
  });
});

// ── _serializeEvents allowlist parity (online wire) ─────────────────────────

describe('_serializeEvents — SENT_TO + SURVIVOR_RECEIVED parity', () => {
  test('SURVIVOR_RECEIVED preserves all payload fields on the wire', async () => {
    const { serializeEventsForTest } = await import('../server/lobby.js');
    const recv = {
      type:          ResEventType.SURVIVOR_RECEIVED,
      faction:       'hero',
      survivorId:    'e42',
      survivorName:  'Old Tom',
      fromOwnerId:   'h1-uuid',
      fromOwnerName: 'Anya',
      destOwnerId:   'h2-uuid',
    };
    const [out] = serializeEventsForTest([recv]);
    assert.equal(out.type,          ResEventType.SURVIVOR_RECEIVED);
    assert.equal(out.faction,       'hero');
    assert.equal(out.survivorId,    'e42');
    assert.equal(out.survivorName,  'Old Tom');
    assert.equal(out.fromOwnerId,   'h1-uuid');
    assert.equal(out.fromOwnerName, 'Anya');
    assert.equal(out.destOwnerId,   'h2-uuid');
  });

  test('SENT_TO ACTION_OK preserves the new result fields the sender card needs', async () => {
    const { serializeEventsForTest } = await import('../server/lobby.js');
    const ev = {
      type:    ResEventType.ACTION_OK,
      faction: 'hero',
      action:  { type: PlanActionType.SENT_TO, entityId: 'e42', destOwnerId: 'h2-uuid' },
      result:  {
        success:       true,
        log:           ['Old Tom sent to Bea.'],
        cost:          0,
        survivorId:    'e42',
        survivorName:  'Old Tom',
        fromOwnerId:   'h1-uuid',
        fromOwnerName: 'Anya',
        destOwnerId:   'h2-uuid',
        destOwnerName: 'Bea',
      },
    };
    const [out] = serializeEventsForTest([ev]);
    assert.equal(out.result.cost,          0);
    assert.equal(out.result.survivorId,    'e42');
    assert.equal(out.result.survivorName,  'Old Tom');
    assert.equal(out.result.fromOwnerId,   'h1-uuid');
    assert.equal(out.result.fromOwnerName, 'Anya');
    assert.equal(out.result.destOwnerId,   'h2-uuid');
    assert.equal(out.result.destOwnerName, 'Bea');
  });
});

// ── Replay timeline integration ─────────────────────────────────────────────

describe('replay-timeline — SENT_TO sender + SURVIVOR_RECEIVED recipient cards', () => {
  test('buildStepDigest emits a recipient entry with the receive note', async () => {
    const { buildStepDigest } = await import('../src/replay-timeline.js');
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const digest = buildStepDigest(steps, state.entities, {
      isVisible: () => true,
      PlanActionType, ResEventType,
      viewerFaction: 'hero',
    });
    const allEntries = digest.flatMap(d => d.entries);
    const recvEntry = allEntries.find(e => e.actionType === 'survivor-received');
    assert.ok(recvEntry, 'expected a survivor-received digest entry');
    assert.match(recvEntry.note?.text ?? '', /📥/);
    assert.match(recvEntry.note?.text ?? '', new RegExp(h1.displayName));

    const sendEntry = allEntries.find(e => e.actionType === PlanActionType.SENT_TO);
    assert.ok(sendEntry, 'expected a sent-to (sender) digest entry');
    assert.match(sendEntry.note?.text ?? '', /📤/);
    assert.equal(sendEntry.label, 'SEND', 'sender label should read SEND, not generic SENT-TO');
  });

  test('compactUneventfulTurns — a recipient column with only SURVIVOR_RECEIVED never collapses', async () => {
    const { buildStepDigest, compactUneventfulTurns } = await import('../src/replay-timeline.js');
    const { state, h1, h2 } = twoVTwoState();
    const s = placeOwnedSurvivor(state, h1);
    const plan = [{
      type: PlanActionType.SENT_TO,
      entityId: s.id,
      destOwnerId: h2.ownerId,
    }];
    const steps = resolvePlansMP(state, [
      { playerId: h1.ownerId, faction: 'hero',  plan },
      { playerId: h2.ownerId, faction: 'hero',  plan: [] },
      { playerId: state.witch.ownerId, faction: 'witch', plan: [] },
    ]);
    const digest = buildStepDigest(steps, state.entities, {
      isVisible: () => true,
      PlanActionType, ResEventType,
      viewerFaction: 'hero',
    });
    // Even with adjacent uneventful frames padded around it, the column
    // carrying the receive entry must survive compaction. We can verify the
    // recipient entry still appears in the compacted output.
    const compacted = compactUneventfulTurns(digest);
    const survives = compacted.some(col =>
      (col.entries ?? []).some(e => e.actionType === 'survivor-received')
    );
    assert.ok(survives, 'SURVIVOR_RECEIVED entry must survive timeline compaction');
  });
});

// ── plan-step label (describePlanAction) ───────────────────────────────────

describe('describePlanAction — SENT_TO', () => {
  test('returns "📤 Send <survivor> to <leader>" instead of generic "Step N"', async () => {
    const { describePlanAction } = await import('../src/ui-render.js');
    const { state, h1, h2 } = twoVTwoState();
    const survivor = placeOwnedSurvivor(state, h1);
    const action = {
      type: PlanActionType.SENT_TO,
      entityId: survivor.id,
      destOwnerId: h2.ownerId,
    };
    const desc = describePlanAction(action, state.entities, 0);
    assert.match(desc, /📤/);
    assert.match(desc, /Send/i);
    assert.match(desc, new RegExp(survivor.displayName));
    // h2 is the destination — its displayName must appear.
    assert.match(desc, new RegExp(h2.displayName));
    // Must NOT fall back to the generic "Step N" shape.
    assert.doesNotMatch(desc, /^Step\s\d/);
  });

  test('falls back gracefully when the survivor entity is missing from the snapshot', async () => {
    const { describePlanAction } = await import('../src/ui-render.js');
    const { state, h2 } = twoVTwoState();
    const action = {
      type: PlanActionType.SENT_TO,
      entityId: 'no-such-entity',
      destOwnerId: h2.ownerId,
    };
    const desc = describePlanAction(action, state.entities, 0);
    // Still recognizable as a Send action — no crash, no generic "Step N".
    assert.match(desc, /Send|📤/i);
    assert.doesNotMatch(desc, /^Step\s\d/);
  });
});
