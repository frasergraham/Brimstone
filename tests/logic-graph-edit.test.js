// Tests for the editor model operations (src/mission-logic/graph-edit.js):
// add/remove nodes, connect/rewire pins with validation, auto-layout, palette.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nodeLabel, paletteGroups, nextNodeId, addNode, removeNode, connect, removeEdges, autoLayout,
} from '../src/mission-logic/graph-edit.js';
import { validateGraph, emptyGraph, EdgeKind, GraphValidationError } from '../src/mission-logic/graph.js';
import { NodeKind } from '../src/mission-logic/node-types.js';

describe('graph-edit / labels + palette', () => {
  test('nodeLabel humanizes a type', () => {
    assert.equal(nodeLabel('onAreaEnter'), 'On Area Enter');
    assert.equal(nodeLabel('spawnUnits'), 'Spawn Units');
  });

  test('palette groups cover every node kind in display order', () => {
    const groups = paletteGroups();
    assert.ok(groups.length >= 6);
    assert.equal(groups[0].kind, NodeKind.EVENT);
    // Every group is non-empty and every type carries a label.
    for (const g of groups) {
      assert.ok(g.types.length > 0);
      for (const t of g.types) assert.ok(t.label.length > 0);
    }
  });
});

describe('graph-edit / node ops', () => {
  test('addNode assigns unique ids and removeNode drops incident edges', () => {
    const graph = emptyGraph();
    const a = addNode(graph, 'onMissionStart', 10, 10);
    const b = addNode(graph, 'storyBeat', 200, 10);
    assert.notEqual(a.id, b.id);
    assert.equal(nextNodeId(graph), 'n2');

    connect(graph, { node: a.id, pin: 'out' }, { node: b.id, pin: 'in' }, EdgeKind.EXEC);
    assert.equal(graph.edges.length, 1);
    removeNode(graph, b.id);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.edges.length, 0, 'edge to the removed node is gone');
  });

  test('addNode rejects unknown types', () => {
    assert.throws(() => addNode(emptyGraph(), 'bogus'), GraphValidationError);
  });
});

describe('graph-edit / connect', () => {
  test('exec connect validates pins and stays validate-clean', () => {
    const graph = emptyGraph();
    const ev = addNode(graph, 'onRoundStart');
    const beat = addNode(graph, 'storyBeat');
    connect(graph, { node: ev.id, pin: 'out' }, { node: beat.id, pin: 'in' }, EdgeKind.EXEC);
    assert.doesNotThrow(() => validateGraph(graph));
  });

  test('connecting a bad exec-out pin throws', () => {
    const graph = emptyGraph();
    const ev = addNode(graph, 'onRoundStart');
    const beat = addNode(graph, 'storyBeat');
    assert.throws(() => connect(graph, { node: ev.id, pin: 'nope' }, { node: beat.id, pin: 'in' }, EdgeKind.EXEC),
      /no exec-out pin/);
  });

  test('a second data edge into one sink REPLACES the first (rewire)', () => {
    const graph = emptyGraph();
    const area = addNode(graph, 'onAreaEnter');
    const a = addNode(graph, 'getEntityProperty');
    const b = addNode(graph, 'filterIsFaction');
    connect(graph, { node: area.id, pin: 'unit' }, { node: b.id, pin: 'entity' }, EdgeKind.DATA);
    connect(graph, { node: a.id, pin: 'value' }, { node: b.id, pin: 'entity' }, EdgeKind.DATA);
    const intoEntity = graph.edges.filter((e) => e.kind === 'data' && e.to.node === b.id && e.to.pin === 'entity');
    assert.equal(intoEntity.length, 1, 'only the latest driver remains');
    assert.equal(intoEntity[0].from.node, a.id);
    assert.doesNotThrow(() => validateGraph(graph));
  });

  test('self-wiring is rejected', () => {
    const graph = emptyGraph();
    const n = addNode(graph, 'sequence');
    assert.throws(() => connect(graph, { node: n.id, pin: 'then0' }, { node: n.id, pin: 'in' }, EdgeKind.EXEC),
      /itself/);
  });

  test('removeEdges drops matching edges', () => {
    const graph = emptyGraph();
    const ev = addNode(graph, 'onMissionStart');
    const beat = addNode(graph, 'storyBeat');
    connect(graph, { node: ev.id, pin: 'out' }, { node: beat.id, pin: 'in' }, EdgeKind.EXEC);
    const n = removeEdges(graph, (e) => e.from.node === ev.id);
    assert.equal(n, 1);
    assert.equal(graph.edges.length, 0);
  });
});

describe('graph-edit / auto-layout', () => {
  test('events land in column 0; downstream nodes shift right', () => {
    const graph = emptyGraph();
    const ev = addNode(graph, 'onMissionStart');
    const seq = addNode(graph, 'sequence');
    const beat = addNode(graph, 'storyBeat');
    connect(graph, { node: ev.id, pin: 'out' }, { node: seq.id, pin: 'in' }, EdgeKind.EXEC);
    connect(graph, { node: seq.id, pin: 'then0' }, { node: beat.id, pin: 'in' }, EdgeKind.EXEC);
    autoLayout(graph);
    const x = (id) => graph.nodes.find((n) => n.id === id).x;
    assert.ok(x(ev.id) < x(seq.id), 'event left of sequence');
    assert.ok(x(seq.id) < x(beat.id), 'sequence left of beat');
  });
});
