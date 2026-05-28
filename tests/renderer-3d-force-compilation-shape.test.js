// Regression — forceCompilation argument shape.
//
// Babylon's `Material.forceCompilation(mesh, onCompiled?, options?, onError?)`
// expects a *function* as the 2nd argument. Passing the options object there
// (instead of in slot 3) silently broke material compilation: Babylon would
// finish compiling and call `onCompiled(material)`, but `onCompiled` was an
// object → `TypeError: t is not a function`. The error fires per PBR effect
// fallback, so a single misuse cascades into dozens of console errors AND a
// "BJS — Unable to compile effect" downstream symptom.
//
// Lock the call shape with a source scan so this can't regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/renderer-3d.js'), 'utf8');

test('every forceCompilation call passes a function (or undefined) as the 2nd arg, not an object', () => {
  // Pull every `forceCompilation(... , ...)` invocation. Allow whitespace/newlines.
  const calls = [...src.matchAll(/\bforceCompilation\s*\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(calls.length > 0, 'expected at least one forceCompilation call in renderer-3d.js');
  for (const inner of calls) {
    // Find the 2nd top-level arg. Split on commas at depth 0.
    const args = [];
    let depth = 0, start = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(inner.slice(start, i).trim());
        start = i + 1;
      }
    }
    args.push(inner.slice(start).trim());
    const second = args[1] ?? '';
    assert.ok(
      !second.startsWith('{'),
      `forceCompilation 2nd arg looks like an options object — should be the onCompiled callback (pass undefined and put options in slot 3). Got: forceCompilation(${inner})`,
    );
  }
});
