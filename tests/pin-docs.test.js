// Tests for logic-editor pin tooltips (src/tools/pin-docs.js) + the comment node.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { pinDoc, PIN_DOCS } from '../src/tools/pin-docs.js';
import { allNodeTypes, pinsOf, getNodeType, NodeKind } from '../src/mission-logic/node-types.js';
import { validateGraph } from '../src/mission-logic/graph.js';
import { MissionLogicEngine, makeTestContext } from '../src/mission-logic/index.js';

describe('pin-docs', () => {
  test('PIN_DOCS keys are all real node types', () => {
    const types = new Set(allNodeTypes().map((d) => d.type));
    for (const t of Object.keys(PIN_DOCS)) assert.ok(types.has(t), `${t} is a registered node type`);
  });

  test('every pin of every node has a tooltip (specific or default)', () => {
    for (const def of allNodeTypes()) {
      const node = { type: def.type, params: def.type === 'sequence' ? { outputs: 3 } : {} };
      const p = pinsOf(node);
      if (p.execIn) assert.ok(pinDoc(def.type, 'in', 'in').length, `${def.type} exec-in`);
      for (const d of p.dataIn) assert.ok(pinDoc(def.type, 'in', d.name).length, `${def.type}.in.${d.name}`);
      for (const x of p.execOut) assert.ok(pinDoc(def.type, 'out', x).length, `${def.type}.out.${x}`);
      for (const d of p.dataOut) assert.ok(pinDoc(def.type, 'out', d.name).length, `${def.type}.out.${d.name}`);
    }
  });
});

describe('comment node', () => {
  test('is registered as a pin-less annotation kind', () => {
    const def = getNodeType('comment');
    assert.equal(def.kind, NodeKind.COMMENT);
    const p = pinsOf({ type: 'comment', params: {} });
    assert.equal(p.execIn, false);
    assert.deepEqual([p.execOut, p.dataIn, p.dataOut], [[], [], []]);
  });

  test('a graph with a comment validates and the engine ignores it', () => {
    const graph = {
      version: 1, variables: [],
      nodes: [
        { id: 'note', type: 'comment', params: { text: 'this section spawns the ambush' } },
        { id: 'ev', type: 'onMissionStart' },
        { id: 'beat', type: 'storyBeat', params: { title: 'go' } },
      ],
      edges: [{ from: { node: 'ev', pin: 'out' }, to: { node: 'beat', pin: 'in' }, kind: 'exec' }],
    };
    assert.doesNotThrow(() => validateGraph(graph));
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart');
    assert.equal(ctx._emitted.filter((e) => e.kind === 'storyBeat').length, 1);
  });
});
