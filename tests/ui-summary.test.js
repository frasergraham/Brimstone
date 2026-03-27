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

// ── Game-over summary customization ─────────────────────────────────────────

describe('game-over summary title', () => {
  function getSummaryTitle(gameOver, winner, humanFaction, roundNum) {
    if (gameOver) {
      if (!humanFaction) {
        return winner === 'hero' ? 'Hero Wins!' : 'Witch Wins!';
      }
      return winner === humanFaction ? 'Victory!' : 'Defeat';
    }
    return `Round ${roundNum ?? ''} complete`;
  }

  test('normal round shows round number', () => {
    assert.equal(getSummaryTitle(false, null, 'hero', 5), 'Round 5 complete');
  });

  test('victory when hero wins and player is hero', () => {
    assert.equal(getSummaryTitle(true, 'hero', 'hero', 10), 'Victory!');
  });

  test('defeat when witch wins and player is hero', () => {
    assert.equal(getSummaryTitle(true, 'witch', 'hero', 10), 'Defeat');
  });

  test('victory when witch wins and player is witch', () => {
    assert.equal(getSummaryTitle(true, 'witch', 'witch', 10), 'Victory!');
  });

  test('defeat when hero wins and player is witch', () => {
    assert.equal(getSummaryTitle(true, 'hero', 'witch', 10), 'Defeat');
  });

  test('autoplay: hero wins shows "Hero Wins!"', () => {
    assert.equal(getSummaryTitle(true, 'hero', null, 10), 'Hero Wins!');
  });

  test('autoplay: witch wins shows "Witch Wins!"', () => {
    assert.equal(getSummaryTitle(true, 'witch', null, 10), 'Witch Wins!');
  });
});

// ── Per-step node capture detection ─────────────────────────────────────────

describe('per-step node capture detection', () => {
  // Mirrors the per-step logic in _animateResolutionSteps
  function detectStepNodeChanges(witchObjectives, preStepEntities, postStepEntities) {
    const preOwners = witchObjectives.map(obj => {
      const holder = preStepEntities.find(e => e.alive && e.col === obj.col && e.row === obj.row);
      return holder?.owner ?? null;
    });
    const changes = [];
    preOwners.forEach((prevOwner, idx) => {
      const obj = witchObjectives[idx];
      const postHolder = postStepEntities.find(e => e.alive && e.col === obj.col && e.row === obj.row);
      const postOwner = postHolder?.owner ?? null;
      if (postOwner !== prevOwner) {
        changes.push({ label: obj.label, from: prevOwner, to: postOwner });
      }
    });
    return changes;
  }

  const objectives = [
    { col: 3, row: 4, label: 'Dark Grove' },
    { col: 7, row: 2, label: 'Blood Altar' },
  ];

  test('detects unit moving onto a node in a single step', () => {
    const pre  = [{ alive: true, col: 2, row: 4, owner: 'hero', id: 1 }];
    const post = [{ alive: true, col: 3, row: 4, owner: 'hero', id: 1 }];
    const changes = detectStepNodeChanges(objectives, pre, post);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Dark Grove');
    assert.equal(changes[0].to, 'hero');
  });

  test('no change when node control stays the same', () => {
    const pre  = [{ alive: true, col: 3, row: 4, owner: 'hero', id: 1 }];
    const post = [{ alive: true, col: 3, row: 4, owner: 'hero', id: 1 }];
    const changes = detectStepNodeChanges(objectives, pre, post);
    assert.equal(changes.length, 0);
  });

  test('detects unit leaving a node', () => {
    const pre  = [{ alive: true, col: 7, row: 2, owner: 'witch', id: 1 }];
    const post = [{ alive: true, col: 8, row: 2, owner: 'witch', id: 1 }];
    const changes = detectStepNodeChanges(objectives, pre, post);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].label, 'Blood Altar');
    assert.equal(changes[0].from, 'witch');
    assert.equal(changes[0].to, null);
  });
});

// ── Action budget breakdown ─────────────────────────────────────────────────

// Mirrors the line-item computation in _showPhaseModal
function computeBudgetRows(faction, phase, entities) {
  const rows = [];
  if (faction === 'hero') {
    const base = 3;
    const timeBonus = (phase === 'day' || phase === 'dawn') ? 1 : 0;
    const survivorCount = entities.filter(e => e.alive && e.owner === 'hero' && e.type !== 'hero').length;
    const survivorBonus = Math.min(survivorCount, 5);
    rows.push({ label: 'Base', value: base });
    if (timeBonus)     rows.push({ label: `phase bonus`, value: timeBonus });
    if (survivorBonus) rows.push({ label: `survivors`, value: survivorBonus });
  } else {
    const base = 4;
    const timeBonus = phase === 'night' ? 1 : 0;
    const unitCount = entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
    const unitBonus = Math.min(Math.floor(unitCount / 2), 4);
    rows.push({ label: 'Base', value: base });
    if (timeBonus) rows.push({ label: `phase bonus`, value: timeBonus });
    if (unitBonus) rows.push({ label: `minions`, value: unitBonus });
  }
  return rows;
}

describe('action budget breakdown rows', () => {
  test('hero base only (no bonus phase, no survivors)', () => {
    const rows = computeBudgetRows('hero', 'night', [
      { alive: true, owner: 'hero', type: 'hero' },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 3);
  });

  test('hero with day bonus and 2 survivors', () => {
    const rows = computeBudgetRows('hero', 'day', [
      { alive: true, owner: 'hero', type: 'hero' },
      { alive: true, owner: 'hero', type: 'survivor' },
      { alive: true, owner: 'hero', type: 'survivor' },
    ]);
    assert.equal(rows.length, 3); // base + day + survivors
    assert.equal(rows[0].value, 3);
    assert.equal(rows[1].value, 1); // day bonus
    assert.equal(rows[2].value, 2); // 2 survivors
  });

  test('hero survivor bonus caps at 5', () => {
    const entities = [
      { alive: true, owner: 'hero', type: 'hero' },
      ...Array.from({ length: 7 }, () => ({ alive: true, owner: 'hero', type: 'survivor' })),
    ];
    const rows = computeBudgetRows('hero', 'dusk', entities);
    const surRow = rows.find(r => r.label.includes('survivors'));
    assert.equal(surRow.value, 5);
  });

  test('witch base only (no night, no minions)', () => {
    const rows = computeBudgetRows('witch', 'day', [
      { alive: true, owner: 'witch', type: 'witch' },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 4);
  });

  test('witch with night bonus and 4 minions', () => {
    const rows = computeBudgetRows('witch', 'night', [
      { alive: true, owner: 'witch', type: 'witch' },
      ...Array.from({ length: 4 }, () => ({ alive: true, owner: 'witch', type: 'minion' })),
    ]);
    assert.equal(rows.length, 3); // base + night + minions
    assert.equal(rows[0].value, 4);
    assert.equal(rows[1].value, 1); // night bonus
    assert.equal(rows[2].value, 2); // floor(4/2) = 2
  });

  test('witch minion bonus caps at 4', () => {
    const entities = [
      { alive: true, owner: 'witch', type: 'witch' },
      ...Array.from({ length: 12 }, () => ({ alive: true, owner: 'witch', type: 'minion' })),
    ];
    const rows = computeBudgetRows('witch', 'dawn', entities);
    const unitRow = rows.find(r => r.label.includes('minions'));
    assert.equal(unitRow.value, 4);
  });

  test('total matches sum of all row values', () => {
    const entities = [
      { alive: true, owner: 'hero', type: 'hero' },
      { alive: true, owner: 'hero', type: 'survivor' },
      { alive: true, owner: 'hero', type: 'survivor' },
      { alive: true, owner: 'hero', type: 'survivor' },
    ];
    const rows = computeBudgetRows('hero', 'dawn', entities);
    const total = rows.reduce((sum, r) => sum + r.value, 0);
    assert.equal(total, 3 + 1 + 3); // base + dawn + 3 survivors = 7
  });
});
