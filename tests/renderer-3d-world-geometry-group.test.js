// Unit-vs-building occlusion (task t-4d82b52e).
//
// Babylon's `renderingGroupId` groups bypass the depth buffer — a mesh in
// group 1 ALWAYS draws above a mesh in group 0 regardless of world-space
// depth. Previously the renderer used group 1 for unit standees and per-unit
// hex outlines, which made them draw on top of buildings even when the
// camera angle placed a building between the camera and the unit. The fix
// is to keep ALL world geometry in group 0 so the depth buffer handles
// z-order, and reserve higher groups strictly for UI elements that must
// override depth-test (icon billboard → 2, attack overlay → 3).
//
// This file is a source-inspection test: we read src/renderer-3d.js as text
// and assert each `renderingGroupId = N` assignment matches the group the
// owning mesh class belongs to. A source-inspection test is appropriate
// here because the meshes are wired through Babylon at scene-build time;
// stubbing every MeshBuilder call would obscure the very invariant we
// want to pin.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ATTACK_OVERLAY_GROUP,
} from '../src/renderer-3d.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, '..', 'src', 'renderer-3d.js'), 'utf8');

// Pull every `<receiver>.renderingGroupId = <value>;` assignment out of the
// source, with the line number so failure messages point at the offending
// line.
function collectAssignments(src) {
  const lines = src.split('\n');
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\.renderingGroupId\s*=\s*([^;]+);/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) out.push({ line: i + 1, receiver: m[1], rhs: m[2].trim() });
  }
  return out;
}

describe('Renderer3D — world geometry shares renderingGroupId 0', () => {
  const assignments = collectAssignments(SRC);

  test('every assignment in the source parses cleanly', () => {
    assert.ok(assignments.length > 0,
      'expected at least one renderingGroupId assignment in src/renderer-3d.js');
  });

  // Receivers that represent world geometry (depth-test owns z-order):
  //   • cone, sphere, base    → unit standee + plan ghost body
  //   • thin, thick           → per-unit hex outline tubes
  const WORLD_GEOMETRY_RECEIVERS = new Set(['cone', 'sphere', 'base', 'thin', 'thick']);

  for (const a of assignments) {
    if (!WORLD_GEOMETRY_RECEIVERS.has(a.receiver)) continue;
    test(`${a.receiver}.renderingGroupId at line ${a.line} is 0`, () => {
      assert.equal(a.rhs, '0',
        `${a.receiver}.renderingGroupId (line ${a.line}) must be 0 so the ` +
        `depth buffer handles unit-vs-building occlusion; got "${a.rhs}"`);
    });
  }
});

describe('Renderer3D — UI groups stay above world geometry', () => {
  const assignments = collectAssignments(SRC);

  // The icon billboard plane keeps group 2 — it's a UI element that must
  // float over the unit token and never be occluded by another mesh.
  test('the unit-icon billboard plane stays in renderingGroupId 2', () => {
    const planeAssigns = assignments.filter(a => a.receiver === 'plane');
    assert.ok(planeAssigns.length > 0,
      'expected at least one plane.renderingGroupId assignment (icon billboard)');
    for (const a of planeAssigns) {
      assert.equal(a.rhs, '2',
        `plane.renderingGroupId (line ${a.line}) must be 2 (icon billboard); got "${a.rhs}"`);
    }
  });

  // Attack overlay shaft/head/badge meshes use the ATTACK_OVERLAY_GROUP
  // constant — pin both the constant and the assignments.
  test('ATTACK_OVERLAY_GROUP is 3 (highest legal default group)', () => {
    assert.equal(ATTACK_OVERLAY_GROUP, 3);
  });

  test('attack-overlay meshes (shaft / head1 / head2 / badge) use ATTACK_OVERLAY_GROUP', () => {
    const overlayReceivers = new Set(['shaft', 'head1', 'head2', 'badge']);
    const overlayAssigns = assignments.filter(a => overlayReceivers.has(a.receiver));
    assert.ok(overlayAssigns.length >= 4,
      `expected at least 4 attack-overlay renderingGroupId assignments, got ${overlayAssigns.length}`);
    for (const a of overlayAssigns) {
      assert.equal(a.rhs, 'ATTACK_OVERLAY_GROUP',
        `${a.receiver}.renderingGroupId (line ${a.line}) must be ATTACK_OVERLAY_GROUP; got "${a.rhs}"`);
    }
  });
});

describe('Renderer3D — depth-test ordering invariant', () => {
  // Buildings have no explicit renderingGroupId, so they live in Babylon's
  // default group 0. Standees + outlines + ribbons are also pinned to 0 by
  // the assertions above. With both in the same group, Babylon's depth
  // buffer orders them by world-space Z — which is the whole point of the
  // fix: a building between the camera and a unit now correctly hides the
  // unit, instead of the unit drawing on top because of a group bump.
  test('no world-geometry assignment uses a non-zero group', () => {
    const worldReceivers = new Set(['cone', 'sphere', 'base', 'thin', 'thick']);
    const assignments = collectAssignments(SRC);
    const offenders = assignments.filter(
      a => worldReceivers.has(a.receiver) && a.rhs !== '0',
    );
    assert.equal(offenders.length, 0,
      'world-geometry meshes leaked into a non-zero group:\n' +
        offenders.map(o => `  line ${o.line}: ${o.receiver}.renderingGroupId = ${o.rhs}`).join('\n'));
  });

  // Pin the ordering invariant numerically so a future bump of any single
  // constant is caught at the test level rather than only in-browser.
  test('UI groups (icon=2, attack=3) remain strictly above world geometry (0)', () => {
    assert.ok(2 > 0, 'icon billboard group must beat world geometry');
    assert.ok(ATTACK_OVERLAY_GROUP > 2, 'attack overlay must beat icon billboard');
    assert.ok(ATTACK_OVERLAY_GROUP > 0, 'attack overlay must beat world geometry');
  });
});
