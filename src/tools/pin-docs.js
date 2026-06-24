// ═══════════════════════════════════════════════════════════════════════════
// Pin documentation for the logic-graph editor — tooltips on every pin.
// ─────────────────────────────────────────────────────────────────────────────
// Keyed by node type → { in: {pin: text}, out: {pin: text} }. The editor shows
// these as `title` tooltips so an author knows what each input/output carries.
// `in`/`out` are by DIRECTION; the exec-in pin is keyed 'in'.
// ═══════════════════════════════════════════════════════════════════════════

const RUN = 'Run this node when triggered.';

export const PIN_DOCS = Object.freeze({
  // Events
  onMissionStart: { out: { out: 'Fires once, when the mission begins.' } },
  onRoundStart: { out: { out: 'Fires at the start of the matching round (or every round).', round: 'The current round number.', phase: 'The current phase: dawn / day / dusk / night.' } },
  onPhase: { out: { out: 'Fires when the day-cycle reaches the chosen phase.', phase: 'The phase that just began.' } },
  onCycleEnd: { out: { out: 'Fires once, AFTER the final turn of a non-looping day-cycle resolves — the correct trigger for a fixed-end mission’s deadline win/lose so the player plays the last (e.g. dawn) turn first.', phase: 'The final phase that just resolved.' } },
  onKillCount: { out: { out: 'Fires once the faction’s cumulative kill count reaches the threshold.', killer: 'The unit that made the kill.' } },
  onAreaEnter: { out: { onEnter: 'Fires when a unit steps onto one of the trigger hexes.', onExit: 'Fires when a unit leaves the trigger hexes.', unit: 'The unit that crossed the boundary.', hex: 'The {col,row} it entered/left.' } },
  factionEvent: { out: { onAllUnitsDead: 'Fires when the faction has zero living units.', onLeaderDead: 'Fires when the faction’s leader is killed.', onUnitCountBelow: 'Fires when living unit count drops below the threshold.' } },
  onActor: { in: { ref: 'Wire a Survivor / unit source here to bind by its id (overrides the typed ref).' }, out: { onSpawn: 'Fires when this specific unit appears on the map.', onDeath: 'Fires when this specific unit dies/leaves.', entity: 'The live unit entity.', hex: 'The unit’s {col,row}.' } },
  onConversationEnd: { out: { done: 'Fires when the named conversation is dismissed. (Usually unnecessary — wire Start Conversation’s Done instead.)' } },

  // Flow
  sequence: { in: { in: RUN }, out: { then0: 'Fires first, then Then 1, Then 2 … in order.' } },
  branch: { in: { in: RUN, cond: 'A boolean — true takes the True path, false the False path.' }, out: { true: 'Fires when the condition is true.', false: 'Fires when the condition is false.' } },
  filterIsFaction: { in: { in: RUN, entity: 'The unit to test (e.g. the unit from an Area Trigger).' }, out: { pass: 'Fires only if the entity belongs to the chosen faction.' } },
  doOnce: { in: { in: RUN }, out: { out: 'Fires the first time only — later triggers are ignored.' } },
  counter: { in: { in: 'Each trigger increments the count.' }, out: { reached: 'Fires once the count reaches the threshold.', count: 'The current count.' } },
  forEach: { in: { in: RUN, items: 'A list to iterate over.' }, out: { body: 'Fires once per item.', done: 'Fires after all items are processed.', item: 'The current item in the loop.' } },

  // Logic / data
  compare: { in: { a: 'Left value.', b: 'Right value.' }, out: { result: 'a (op) b as a boolean.' } },
  logicGate: { in: { a: 'First boolean.', b: 'Second boolean (ignored for NOT).' }, out: { result: 'AND / OR / NOT of the inputs.' } },
  getGameState: { out: { value: 'The chosen game-state field (round, phase, kills…).' } },
  getEntityProperty: { in: { entity: 'The unit to read from.' }, out: { value: 'The chosen property (hp, faction, alive…).' } },
  conditionNamed: { out: { result: 'The named condition predicate, evaluated now.' } },
  completionCount: { out: { count: 'How many of the listed missions are completed (empty list = all completed missions).', total: 'How many distinct missions were considered — the denominator for percent scaling.' } },
  location: { out: { hex: 'A map {col,row} — wire into Spawn Units’ “at”, etc.' } },
  survivor: { out: { id: 'The survivor’s id — wire into an On Actor node’s “ref” (and a conversation participant).', hex: 'The survivor’s {col,row}.' } },

  // Actions (sim)
  spawnUnits: { in: { in: RUN, at: 'Optional hex {col,row} — overrides every unit’s spawn position when wired.' }, out: { done: 'Fires after the units are spawned.', spawned: 'The list of spawned entities.', first: 'The first spawned entity.' } },
  despawnUnit: { in: { in: RUN, target: 'The entity to remove (or set an NPC id in params).' }, out: { done: 'Fires after removal.' } },
  moveUnit: { in: { in: RUN, target: 'The NPC to move (or set an NPC id in params).' }, out: { done: 'Fires after the walk completes.' } },
  setFlag: { in: { in: RUN, value: 'Optional wired value (else the params value).' }, out: { done: 'Fires after the flag is written.' } },
  setObjective: { in: { in: RUN, label: 'Optional wired label (else the params label).', target: 'Optional wired target count (else the params target).' }, out: { done: 'Fires after the Mission Log entry is added/updated.' } },
  updateObjective: { in: { in: RUN, value: 'Optional absolute count (else `set`/`delta` params; default +1).' }, out: { done: 'Fires after the objective’s progress advances.' } },
  completeObjective: { in: { in: RUN }, out: { done: 'Fires after the objective is marked complete.' } },

  // Presentation
  startConversation: { in: { in: RUN }, out: { done: 'Fires when the player DISMISSES the conversation — wire post-dialogue choreography here.' } },
  storyBeat: { in: { in: RUN }, out: { done: 'Fires after the toast is shown.' } },

  // Outcomes
  winMission: { in: { in: 'Trigger to end the mission as a WIN.' } },
  loseMission: { in: { in: 'Trigger to end the mission as a LOSS.' } },
  objectiveOutcome: { in: { in: 'Poll the wrapped objective spec now.' }, out: { met: 'Fires when the objective is satisfied (and ends the mission).', unmet: 'Fires when it is not yet satisfied.' } },
});

// One-line summaries per node type — shown as the palette button's tooltip.
export const NODE_DOCS = Object.freeze({
  onMissionStart: 'Fires once when the mission begins.',
  onRoundStart: 'Fires at the start of a round (a specific one, or every round).',
  onPhase: 'Fires when the day-cycle reaches the chosen phase.',
  onCycleEnd: 'Fires after the final turn of a non-looping cycle — wire deadline win/lose here.',
  onKillCount: 'Fires once a faction reaches a kill-count threshold.',
  onAreaEnter: 'Fires when a unit enters/leaves a hex region (an Area trigger).',
  factionEvent: 'Whole-faction events: all units dead, leader dead, count-below.',
  onActor: 'Per-unit OnSpawn / OnDeath, bound to a placed unit by its ref.',
  onConversationEnd: 'Fires when a named conversation ends (usually unneeded).',
  sequence: 'Fire several outputs in order (Then 0, Then 1 …).',
  branch: 'Take the True or False path based on a boolean input.',
  filterIsFaction: 'Pass only if the wired unit belongs to a faction.',
  doOnce: 'Fire the first time only; later triggers are ignored.',
  counter: 'Count each trigger; fire once a threshold is reached.',
  forEach: 'Loop the body once per item in a list.',
  compare: 'Compare two values (≥ ≤ == …) → a boolean.',
  logicGate: 'AND / OR / NOT of boolean inputs.',
  getGameState: 'Read a game-state field (round, phase, kills…).',
  getEntityProperty: 'Read a property of a unit (hp, faction, alive…).',
  conditionNamed: 'Evaluate a named condition predicate now.',
  completionCount: 'Count completed campaign missions (e.g. scale a final wave by sidequests done).',
  location: 'A map hex as data — wire into Spawn Units’ “at”, etc.',
  survivor: 'A placed survivor as data (id + hex) — wire id into an On Actor’s ref.',
  spawnUnits: 'Spawn one or more units (type, position, overrides, level).',
  despawnUnit: 'Remove a unit / NPC from the map.',
  moveUnit: 'Walk an NPC along a path (post-conversation choreography).',
  setFlag: 'Write a campaign / mission flag.',
  setObjective: 'Push a Mission Log objective (id + label, optional target count).',
  updateObjective: 'Advance a Mission Log objective’s progress (auto-completes at target).',
  completeObjective: 'Mark a Mission Log objective complete (strikethrough).',
  startConversation: 'Play a conversation; its Done fires when dismissed.',
  storyBeat: 'Show a story toast (title + text).',
  winMission: 'End the mission as a WIN.',
  loseMission: 'End the mission as a LOSS (hero death is automatic — no node needed).',
  objectiveOutcome: 'Poll a legacy objective spec each round → win / lose.',
  comment: 'A free-text annotation box (no behaviour).',
});

/** One-line tooltip for a node type (the palette button + node header). */
export function nodeDoc(type) { return NODE_DOCS[type] ?? ''; }

/** Tooltip text for a pin, with a sensible default. */
export function pinDoc(type, dir, pin) {
  const specific = PIN_DOCS[type]?.[dir]?.[pin];
  if (specific) return specific;
  if (dir === 'in' && pin === 'in') return RUN;
  if (/^then\d+$/.test(pin)) return 'Sequence output — fires in order.';
  return `${dir === 'in' ? 'Input' : 'Output'} pin: ${pin}`;
}
