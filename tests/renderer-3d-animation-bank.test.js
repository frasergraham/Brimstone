// Animation bank — combat clips registered + retarget assets present.
//
// Flynn's task added three Mixamo combat clips (punch/hit/block) as
// animation-only GLBs that retarget onto the shared paladin skeleton, the
// same pattern as walking.glb/running.glb. These tests pin that:
//   - ANIMATION_BANK exposes punch/hit/block keys
//   - UNIT_RIG_BANK[PALADIN].animations references resolve back into the bank
//   - each referenced .glb file actually ships under assets/models/
// (Combat playback wiring is a separate follow-up — not asserted here.)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANIMATION_BANK, UNIT_RIG_BANK } from '../src/renderer-3d.js';
import { EntityType } from '../src/entities.js';

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models',
);

describe('ANIMATION_BANK — combat clips', () => {
  test('exposes punch/hit/block keys alongside idle/walking/running', () => {
    for (const key of ['idle', 'walking', 'running', 'punch', 'hit', 'block']) {
      assert.ok(ANIMATION_BANK[key], `ANIMATION_BANK.${key} should be defined`);
      assert.match(ANIMATION_BANK[key], /\.glb$/, `${key} points at a .glb`);
    }
  });

  test('combat clip files exist under assets/models/', () => {
    for (const key of ['punch', 'hit', 'block']) {
      const file = path.join(MODELS_DIR, ANIMATION_BANK[key]);
      assert.ok(fs.existsSync(file), `${ANIMATION_BANK[key]} should exist on disk`);
    }
  });
});

describe('UNIT_RIG_BANK[PALADIN] — animation references', () => {
  const rig = UNIT_RIG_BANK[EntityType.PALADIN];

  test('paladin rig lists punch/hit/block animations', () => {
    assert.ok(rig, 'paladin rig is defined');
    for (const key of ['walking', 'running', 'punch', 'hit', 'block']) {
      assert.ok(rig.animations[key], `paladin rig should reference ${key}`);
    }
  });

  test('every paladin animation reference resolves to an ANIMATION_BANK entry', () => {
    const bankFiles = new Set(Object.values(ANIMATION_BANK));
    for (const file of Object.values(rig.animations)) {
      assert.ok(
        bankFiles.has(file),
        `${file} referenced by paladin rig should exist in ANIMATION_BANK`,
      );
    }
  });
});
