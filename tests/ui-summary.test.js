// Tests for resolution summary enhancements:
// - Fog of war event filtering
// - Node control change detection
// - Reckoning scoring logic

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Fog of war event filtering ──────────────────────────────────────────────

// Mirrors the fog filtering logic in _showResolutionSummary
function filterEventByFog(ev, fogOfWar, humanFaction) {
  if (!fogOfWar || !humanFaction) return true; // no filtering
  if (ev._faction === humanFaction) return true; // our event
  // Exception: show kills where our unit was the target
  if (ev.result?.killed && ev.battleSnaps?.targetSnap?.owner === humanFaction) return true;
  return false;
}

describe('fog of war event filtering in summary', () => {
  test('no fog: all events pass', () => {
    const ev = { _faction: 'witch', result: { success: true } };
    assert.ok(filterEventByFog(ev, false, 'hero'));
  });

  test('fog active: own faction events pass', () => {
    const ev = { _faction: 'hero', result: { success: true } };
    assert.ok(filterEventByFog(ev, true, 'hero'));
  });

  test('fog active: opponent events are filtered out', () => {
    const ev = { _faction: 'witch', action: { type: 'summon' }, result: { success: true } };
    assert.ok(!filterEventByFog(ev, true, 'hero'));
  });

  test('fog active: opponent kill of our unit still shows', () => {
    const ev = {
      _faction: 'witch',
      result: { killed: { type: 'survivor' } },
      battleSnaps: { targetSnap: { owner: 'hero' } },
    };
    assert.ok(filterEventByFog(ev, true, 'hero'));
  });

  test('fog active: opponent kill of opponent unit is hidden', () => {
    const ev = {
      _faction: 'witch',
      result: { killed: { type: 'minion' } },
      battleSnaps: { targetSnap: { owner: 'witch' } },
    };
    assert.ok(!filterEventByFog(ev, true, 'hero'));
  });

  test('no humanFaction: all events pass regardless of fog', () => {
    const ev = { _faction: 'witch', result: { success: true } };
    assert.ok(filterEventByFog(ev, true, null));
  });
});

// ── Node control change detection ───────────────────────────────────────────

// Mirrors the node control change logic
function detectNodeChanges(prevNodes, currentEntities) {
  const changes = [];
  for (const prev of prevNodes) {
    const currentHolder = currentEntities.find(
      e => e.alive && e.col === prev.col && e.row === prev.row
    );
    const currentOwner = currentHolder?.owner ?? null;
    if (currentOwner !== prev.owner) {
      changes.push({ label: prev.label, from: prev.owner, to: currentOwner });
    }
  }
  return changes;
}

describe('node control change detection', () => {
  const prevNodes = [
    { col: 3, row: 4, label: 'Dark Grove', owner: null },
    { col: 7, row: 2, label: 'Blood Altar', owner: 'hero' },
    { col: 10, row: 8, label: 'Cursed Well', owner: 'witch' },
  ];

  test('no changes when all nodes stay the same', () => {
    const entities = [
      { alive: true, col: 7, row: 2, owner: 'hero' },
      { alive: true, col: 10, row: 8, owner: 'witch' },
    ];
    const changes = detectNodeChanges(prevNodes, entities);
    assert.equal(changes.length, 0);
  });

  test('detects hero capturing a neutral node', () => {
    const entities = [
      { alive: true, col: 3, row: 4, owner: 'hero' },
      { alive: true, col: 7, row: 2, owner: 'hero' },
      { alive: true, col: 10, row: 8, owner: 'witch' },
    ];
    const changes = detectNodeChanges(prevNodes, entities);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Dark Grove');
    assert.equal(changes[0].from, null);
    assert.equal(changes[0].to, 'hero');
  });

  test('detects witch seizing a hero node', () => {
    const entities = [
      { alive: true, col: 7, row: 2, owner: 'witch' },
      { alive: true, col: 10, row: 8, owner: 'witch' },
    ];
    const changes = detectNodeChanges(prevNodes, entities);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Blood Altar');
    assert.equal(changes[0].from, 'hero');
    assert.equal(changes[0].to, 'witch');
  });

  test('detects node becoming uncontrolled', () => {
    const entities = [
      { alive: true, col: 7, row: 2, owner: 'hero' },
      // witch left Cursed Well
    ];
    const changes = detectNodeChanges(prevNodes, entities);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Cursed Well');
    assert.equal(changes[0].from, 'witch');
    assert.equal(changes[0].to, null);
  });

  test('dead entities do not count as controlling', () => {
    const entities = [
      { alive: false, col: 7, row: 2, owner: 'hero' }, // dead, no longer controls
      { alive: true, col: 10, row: 8, owner: 'witch' },
    ];
    const changes = detectNodeChanges(prevNodes, entities);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Blood Altar');
    assert.equal(changes[0].to, null);
  });

  test('multiple changes detected simultaneously', () => {
    const entities = [
      { alive: true, col: 3, row: 4, owner: 'witch' },
      { alive: true, col: 7, row: 2, owner: 'witch' },
      // Cursed Well empty
    ];
    const changes = detectNodeChanges(prevNodes, entities);
    assert.equal(changes.length, 3);
  });
});

// ── Reckoning scoring logic ─────────────────────────────────────────────────

function computeReckoningLine(prevScore, currentScore, heroCount, witchCount) {
  const heroDelta  = currentScore.hero  - prevScore.hero;
  const witchDelta = currentScore.witch - prevScore.witch;

  if (witchCount === 3 || heroCount === 3) {
    const who = witchCount === 3 ? 'Witch' : 'Hero';
    return `${who} holds all 3 Power Nodes!`;
  } else if (witchDelta > 0) {
    return `Witch holds ${witchCount} Power Node${witchCount !== 1 ? 's' : ''} to Hero's ${heroCount}. Witch scores 1 victory point.`;
  } else if (heroDelta > 0) {
    return `Hero holds ${heroCount} Power Node${heroCount !== 1 ? 's' : ''} to Witch's ${witchCount}. Hero scores 1 victory point.`;
  } else {
    return `Nodes tied ${heroCount}–${witchCount}. No points scored.`;
  }
}

describe('reckoning scoring line', () => {
  test('witch scores when holding more nodes', () => {
    const line = computeReckoningLine({ hero: 0, witch: 0 }, { hero: 0, witch: 1 }, 1, 2);
    assert.ok(line.includes('Witch scores 1 victory point'));
    assert.ok(line.includes('2 Power Nodes'));
  });

  test('hero scores when holding more nodes', () => {
    const line = computeReckoningLine({ hero: 1, witch: 0 }, { hero: 2, witch: 0 }, 2, 0);
    assert.ok(line.includes('Hero scores 1 victory point'));
  });

  test('tied nodes: no points scored', () => {
    const line = computeReckoningLine({ hero: 1, witch: 1 }, { hero: 1, witch: 1 }, 1, 1);
    assert.ok(line.includes('No points scored'));
    assert.ok(line.includes('tied 1'));
  });

  test('witch instant win with 3 nodes', () => {
    const line = computeReckoningLine({ hero: 0, witch: 0 }, { hero: 0, witch: 1 }, 0, 3);
    assert.equal(line, 'Witch holds all 3 Power Nodes!');
  });

  test('hero instant win with 3 nodes', () => {
    const line = computeReckoningLine({ hero: 0, witch: 0 }, { hero: 1, witch: 0 }, 3, 0);
    assert.equal(line, 'Hero holds all 3 Power Nodes!');
  });

  test('singular Power Node for 1', () => {
    const line = computeReckoningLine({ hero: 0, witch: 0 }, { hero: 0, witch: 1 }, 0, 1);
    assert.ok(line.includes('1 Power Node to'));
  });
});
