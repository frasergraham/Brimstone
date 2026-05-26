// ═══════════════════════════════════════════════════════════════════════════
// Campaign conductor-script registry
// ─────────────────────────────────────────────────────────────────────────────
// Some missions are *conducted* — a MissionConductor drives a scripted sequence
// of instructional steps, supplies the witch's plan each round, and can force
// dice. That scripting is imperative JS and cannot be expressed declaratively in
// a JSON mission def. So the JSON format references a conductor script by string
// key (`conductor.scriptKey`) and the loader resolves it through this registry.
//
// Each entry is `{ steps, config }`, matching the EXACT pair the runtime already
// consumes (`missionDef.conductorSteps` / `missionDef.conductorConfig`). The
// tutorial script lives in `src/tutorial/tutorial-config.js` (alongside its map
// builder and waves, which JSON authors separately); this registry aggregates
// those pieces under the canonical key "tutorial" so loaders, the editor, and
// future conducted missions all resolve scripts the same way.
//
// To add a conducted script: define its steps + config (in a focused module, as
// the tutorial does) and add a `{ steps, config }` entry below keyed by the name
// the JSON `conductor.scriptKey` will use.
// ═══════════════════════════════════════════════════════════════════════════

import { TUTORIAL_STEPS, TUTORIAL_CONDUCTOR_CONFIG } from '../tutorial/tutorial-config.js';

/**
 * Registry of named conductor scripts, keyed by the string used in mission JSON
 * (`conductor.scriptKey`). Each value is `{ steps, config }` — the same pair the
 * runtime assigns to `missionDef.conductorSteps` / `missionDef.conductorConfig`.
 * @type {Record<string, { steps: object[], config: object }>}
 */
export const CONDUCTOR_SCRIPTS = Object.freeze({
  tutorial: Object.freeze({
    steps: TUTORIAL_STEPS,
    config: TUTORIAL_CONDUCTOR_CONFIG,
  }),
});

/**
 * Resolve a conductor script by key.
 * @param {string} key — the `conductor.scriptKey` from a mission JSON def.
 * @returns {{ steps: object[], config: object } | null} the script, or null if unknown.
 */
export function resolveConductorScript(key) {
  if (!key) return null;
  return CONDUCTOR_SCRIPTS[key] ?? null;
}
