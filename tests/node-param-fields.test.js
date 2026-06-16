// Tests for the logic-node param-field descriptors (src/tools/node-param-fields.js).
// Guards that the editor's typed form covers every node type and that objective
// sub-fields stay within the runtime's known objective types.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { NODE_PARAM_FIELDS, OBJECTIVE_SPEC_FIELDS, paramFieldsFor } from '../src/tools/node-param-fields.js';
import { allNodeTypes } from '../src/mission-logic/node-types.js';
import { KNOWN_OBJECTIVE_TYPES } from '../src/campaign/json-mission.js';

describe('node-param-fields', () => {
  test('every registered node type has a param-field descriptor', () => {
    const missing = allNodeTypes().map((d) => d.type).filter((t) => NODE_PARAM_FIELDS[t] === undefined);
    assert.deepEqual(missing, [], `node types without a typed form: ${missing.join(', ')}`);
  });

  test('every field descriptor has a key + kind', () => {
    for (const [type, fields] of Object.entries(NODE_PARAM_FIELDS)) {
      for (const f of fields) {
        assert.equal(typeof f.key, 'string', `${type} field missing key`);
        assert.equal(typeof f.kind, 'string', `${type}.${f.key} missing kind`);
      }
    }
  });

  test('objective-spec sub-fields stay within KNOWN_OBJECTIVE_TYPES', () => {
    const bad = Object.keys(OBJECTIVE_SPEC_FIELDS).filter((t) => !KNOWN_OBJECTIVE_TYPES.has(t));
    assert.deepEqual(bad, [], `objective types not honored by the runtime: ${bad.join(', ')}`);
  });

  test('paramFieldsFor returns [] for an unknown type', () => {
    assert.deepEqual(paramFieldsFor('nope'), []);
  });
});
