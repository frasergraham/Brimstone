/**
 * Training data serializers for LLM-based AI players.
 *
 * serializeGameStateForLLM(state, faction) → text description of the board
 * serializePlanForLLM(plan, state) → text description of the planned actions
 * parsePlanFromLLM(text, state, faction) → PlanAction[]
 */

import { hexKey, hexDistance } from '../src/hex.js';
import { Phase, nodeController, phaseForRound } from '../src/game.js';
import { sightRange } from '../src/actions.js';
import { PlanActionType } from '../src/planner.js';
import { EntityType } from '../src/entities.js';

// ── Phase info ──────────────────────────────────────────────────────────────

const PHASE_EFFECTS = {
  dawn:  'Hero gets +1 action. Power Nodes are scored this round.',
  day:   'Hero gets +1 action. Witch undead in the open suffer attrition.',
  dusk:  'Power Nodes are scored this round. Night approaches — seek shelter.',
  night: 'Witch gets +2 ATK and +1 action. Hero sight reduced to 1 hex. Survivors in the open suffer attrition.',
};

const CYCLE_LENGTH = 8;

function roundsUntilScoring(round, cycleConfig = null) {
  if (!cycleConfig) {
    const pos = (round - 1) % CYCLE_LENGTH;
    // Dawn at pos 0, Dusk at pos 4
    if (pos < 4) return 4 - pos; // rounds until dusk
    return CYCLE_LENGTH - pos;   // rounds until next dawn
  }
  const { phases, loop } = cycleConfig;
  const len = phases.length;
  const currentIdx = loop ? ((round || 1) - 1) % len : (round || 1) - 1;
  if (currentIdx >= len) return Infinity;
  if (phases[currentIdx] === 'dawn' || phases[currentIdx] === 'dusk') return 0;
  for (let offset = 1; offset < len; offset++) {
    const i = loop ? (currentIdx + offset) % len : currentIdx + offset;
    if (i >= len) return Infinity;
    if (phases[i] === 'dawn' || phases[i] === 'dusk') return offset;
  }
  return Infinity;
}

// ── Entity description ──────────────────────────────────────────────────────

function describeEntity(e) {
  const parts = [];
  const name = e.displayName ?? e.name ?? e.type;
  if (e.title) parts.push(`${name} the ${e.title}`);
  else parts.push(name);

  parts.push(`@ (${e.col},${e.row})`);
  parts.push(`HP:${e.hp}/${e.maxHp}`);
  parts.push(`ATK:${e.attack + (e.attackBonus || 0)}`);
  parts.push(`DEF:${e.defense + (e.defenseBonus || 0)}`);

  if (e.weapon) parts.push(`weapon:${e.weapon}`);
  if (e.ability) parts.push(`ability:${e.ability}`);
  if (e.guarding > 0) parts.push(`guarding:${e.guarding}`);
  if (e.items?.horse) parts.push('has:horse');

  return parts.join(' ');
}

function entityTypeLabel(type) {
  switch (type) {
    case EntityType.HERO: return 'Hero';
    case EntityType.WITCH: return 'Witch';
    case EntityType.SURVIVOR: return 'Survivor';
    case EntityType.ZOMBIE: return 'Zombie';
    case EntityType.MINION: return 'Minion';
    case EntityType.WOOD_GOLEM: return 'Wood Golem';
    case EntityType.IRON_GOLEM: return 'Iron Golem';
    default: return type;
  }
}

// ── Visibility ──────────────────────────────────────────────────────────────

function getVisibleEnemyPositions(state, faction) {
  const myUnits = state.entities.filter(e => e.alive && e.owner === faction);
  const sight = sightRange(state.phase, false);
  const scoutSight = sightRange(state.phase, true);
  const visible = new Set();

  for (const u of myUnits) {
    const r = (u.ability === 'scout') ? scoutSight : sight;
    for (const e of state.entities) {
      if (!e.alive || e.owner === faction || e.owner === null) continue;
      if (hexDistance(u.col, u.row, e.col, e.row) <= r) {
        visible.add(e.id);
      }
    }
  }
  return visible;
}

// ── Terrain near units ──────────────────────────────────────────────────────

function describeNearbyTerrain(state, entities, radius = 2) {
  const lines = [];
  const seen = new Set();

  for (const e of entities) {
    for (const [key, tile] of state.tiles) {
      if (seen.has(key)) continue;
      const d = hexDistance(e.col, e.row, tile.col, tile.row);
      if (d > radius) continue;
      seen.add(key);

      const parts = [`(${tile.col},${tile.row}): ${tile.type}`];
      if (tile.building) parts.push(`(${tile.building})`);
      if (!tile.explored) parts.push('unexplored');
      if (tile.fortifyLevel > 0) parts.push(`fortified:${tile.fortifyLevel}`);
      if (tile.road || tile.type === 'road') parts.push('road');

      // Check if a node hex
      for (const node of state.witchObjectives ?? []) {
        if (node.hexes?.some(h => h.col === tile.col && h.row === tile.row)) {
          parts.push(`[${node.label} node]`);
        }
      }

      lines.push('  ' + parts.join(' '));
    }
  }
  return lines;
}

// ── Main serializer ─────────────────────────────────────────────────────────

/**
 * Serialize the game state as a text prompt for a specific faction.
 * Applies fog-of-war: only shows enemies visible to the faction's units.
 */
export function serializeGameStateForLLM(state, faction) {
  const lines = [];
  const opponentFaction = faction === 'hero' ? 'witch' : 'hero';
  const budget = faction === 'hero' ? state.heroActionsLeft : state.witchActionsLeft;

  // Header
  lines.push(`ROUND ${state.round} | ${state.phase.toUpperCase()} | Score: Hero ${state.nodeScore?.hero ?? 0} - Witch ${state.nodeScore?.witch ?? 0} | Budget: ${budget} actions`);
  lines.push(`Phase effects: ${PHASE_EFFECTS[state.phase] ?? 'None'}`);

  const scoringIn = roundsUntilScoring(state.round, state.cycleConfig);
  const nextScoringPhase = phaseForRound(state.round + scoringIn, state.cycleConfig);
  lines.push(`Next scoring: ${scoringIn} round${scoringIn !== 1 ? 's' : ''} (${nextScoringPhase})`);
  lines.push('');

  // My units
  const myUnits = state.entities.filter(e => e.alive && e.owner === faction);
  lines.push(`YOUR UNITS (${faction}):`);
  for (const e of myUnits) {
    lines.push('  ' + describeEntity(e));
  }
  lines.push('');

  // Visible enemy units (fog filtered)
  const visibleIds = state.fogOfWar === 'none'
    ? new Set(state.entities.filter(e => e.alive && e.owner === opponentFaction).map(e => e.id))
    : getVisibleEnemyPositions(state, faction);

  const visibleEnemies = state.entities.filter(e => e.alive && visibleIds.has(e.id));
  lines.push(`ENEMY UNITS (visible):`);
  if (visibleEnemies.length === 0) {
    lines.push('  None visible');
  } else {
    for (const e of visibleEnemies) {
      lines.push('  ' + describeEntity(e));
    }
  }
  lines.push('');

  // Power nodes
  lines.push('POWER NODES:');
  for (const node of state.witchObjectives ?? []) {
    const ctrl = nodeController(node, state.entities);
    const center = node.hexes?.[0] ?? node;
    const nearestUnit = myUnits.reduce((best, u) => {
      const d = hexDistance(u.col, u.row, center.col, center.row);
      return d < best ? d : best;
    }, Infinity);
    lines.push(`  ${node.label} @ (${center.col},${center.row}) controller:${ctrl} dist:${nearestUnit === Infinity ? '?' : nearestUnit}`);
  }
  lines.push('');

  // Resources
  const inv = faction === 'hero' ? state.inventory?.shared : state.inventory?.witch;
  if (inv) {
    const res = ['herbs', 'wood', 'metal', 'food', 'silver', 'scripture']
      .map(r => `${r}:${inv[r] ?? 0}`)
      .join(' ');
    lines.push(`RESOURCES: ${res}`);
  }
  lines.push('');

  // Nearby terrain
  lines.push('NEARBY TERRAIN:');
  const terrainLines = describeNearbyTerrain(state, myUnits, 2);
  if (terrainLines.length > 20) {
    lines.push(...terrainLines.slice(0, 20));
    lines.push(`  ... (${terrainLines.length - 20} more hexes)`);
  } else {
    lines.push(...terrainLines);
  }

  return lines.join('\n');
}

// ── Plan serializer ─────────────────────────────────────────────────────────

/**
 * Convert a PlanAction[] into numbered text lines.
 */
export function serializePlanForLLM(plan, state) {
  const lines = [];
  let step = 1;

  for (const action of plan) {
    const entity = state.entities.find(e => e.id === action.entityId);
    const name = entity?.displayName ?? entity?.name ?? action.entityId;

    switch (action.type) {
      case PlanActionType.MOVE:
        lines.push(`${step}. MOVE ${name} → (${action.toCol},${action.toRow})`);
        step++;
        break;
      case PlanActionType.BATTLE_UNIT: {
        const target = state.entities.find(e => e.id === action.targetId);
        const tName = target?.displayName ?? action.targetId;
        lines.push(`${step}. BATTLE ${name} vs ${tName}`);
        step++;
        break;
      }
      case PlanActionType.BATTLE_HEX:
        lines.push(`${step}. BATTLE ${name} → (${action.targetCol},${action.targetRow})`);
        step++;
        break;
      case PlanActionType.EXPLORE:
        lines.push(`${step}. EXPLORE ${name}`);
        step++;
        break;
      case PlanActionType.FORTIFY:
        lines.push(`${step}. FORTIFY ${name}`);
        step++;
        break;
      case PlanActionType.SUMMON:
        lines.push(`${step}. SUMMON ${name}${action.summonType ? ` (${action.summonType})` : ''}`);
        step++;
        break;
      case PlanActionType.HEAL:
        lines.push(`${step}. HEAL ${name}`);
        step++;
        break;
      case PlanActionType.GUARD:
        lines.push(`${step}. GUARD ${name}`);
        step++;
        break;
      case PlanActionType.SOUND_HORN:
        lines.push(`${step}. SOUND_HORN ${name}`);
        step++;
        break;
      case PlanActionType.USE_ITEM:
        lines.push(`${step}. USE_ITEM ${name} ${action.item}`);
        break; // free action, no step increment
      case PlanActionType.EQUIP_WEAPON:
        lines.push(`${step}. EQUIP ${name} ${action.weapon}`);
        break; // free action
      case PlanActionType.USE_ABILITY:
        lines.push(`${step}. ABILITY ${name}`);
        step++;
        break;
      default:
        lines.push(`${step}. ${action.type} ${name}`);
        step++;
    }
  }

  return lines.join('\n');
}

// ── Plan parser ─────────────────────────────────────────────────────────────

/**
 * Parse an LLM text plan back into PlanAction[].
 * Extracts the PLAN: section if present, otherwise parses the whole text.
 * Fuzzy-matches entity names and coordinates.
 */
export function parsePlanFromLLM(text, state, faction) {
  // Extract just the PLAN section if the response has STRATEGY/REASONING/PLAN structure
  const planIdx = text.indexOf('PLAN:');
  const planText = planIdx >= 0 ? text.slice(planIdx + 5) : text;

  const actions = [];
  const myUnits = state.entities.filter(e => e.alive && e.owner === faction);

  // Build name→entity lookup (case-insensitive, partial match)
  function findEntity(nameStr) {
    if (!nameStr) return null;
    const lower = nameStr.trim().toLowerCase();
    // Try exact ID match first
    const byId = state.entities.find(e => e.id === lower);
    if (byId) return byId;
    // Try display name match
    return myUnits.find(e => {
      const dn = (e.displayName ?? e.name ?? '').toLowerCase();
      return dn === lower || dn.includes(lower) || lower.includes(dn);
    }) ?? state.entities.find(e => {
      if (!e.alive) return false;
      const dn = (e.displayName ?? e.name ?? e.type ?? '').toLowerCase();
      return dn === lower || dn.includes(lower) || lower.includes(dn);
    });
  }

  function parseCoords(str) {
    const m = str.match(/\((\d+)\s*,\s*(\d+)\)/);
    if (m) return { col: parseInt(m[1]), row: parseInt(m[2]) };
    return null;
  }

  const lines = planText.split('\n').map(l => l.trim()).filter(l => /^\d+\./.test(l));

  for (const line of lines) {
    // Strip the number prefix: "1. MOVE Hero → (5,3)"
    const body = line.replace(/^\d+\.\s*/, '');
    const upper = body.toUpperCase();

    if (upper.startsWith('MOVE ')) {
      const rest = body.slice(5);
      const arrowIdx = rest.indexOf('→');
      const toIdx = arrowIdx >= 0 ? arrowIdx : rest.indexOf('->');
      if (toIdx < 0) continue;
      const entityName = rest.slice(0, toIdx).trim();
      const coords = parseCoords(rest.slice(toIdx));
      const entity = findEntity(entityName);
      if (entity && coords) {
        actions.push({ type: PlanActionType.MOVE, entityId: entity.id, toCol: coords.col, toRow: coords.row });
      }
    } else if (upper.startsWith('BATTLE ')) {
      const rest = body.slice(7);
      const vsIdx = rest.toLowerCase().indexOf(' vs ');
      const arrowIdx = rest.indexOf('→');
      if (vsIdx >= 0) {
        // BATTLE Hero vs Minion
        const entityName = rest.slice(0, vsIdx).trim();
        const targetName = rest.slice(vsIdx + 4).trim();
        const entity = findEntity(entityName);
        const target = findEntity(targetName);
        if (entity && target) {
          actions.push({ type: PlanActionType.BATTLE_UNIT, entityId: entity.id, targetId: target.id, targetCol: target.col, targetRow: target.row });
        }
      } else if (arrowIdx >= 0 || rest.indexOf('->') >= 0) {
        // BATTLE Hero → (5,3)
        const splitIdx = arrowIdx >= 0 ? arrowIdx : rest.indexOf('->');
        const entityName = rest.slice(0, splitIdx).trim();
        const coords = parseCoords(rest.slice(splitIdx));
        const entity = findEntity(entityName);
        if (entity && coords) {
          actions.push({ type: PlanActionType.BATTLE_HEX, entityId: entity.id, targetCol: coords.col, targetRow: coords.row });
        }
      }
    } else if (upper.startsWith('EXPLORE ')) {
      const entity = findEntity(body.slice(8).trim());
      if (entity) actions.push({ type: PlanActionType.EXPLORE, entityId: entity.id });
    } else if (upper.startsWith('FORTIFY ')) {
      const entity = findEntity(body.slice(8).trim());
      if (entity) actions.push({ type: PlanActionType.FORTIFY, entityId: entity.id });
    } else if (upper.startsWith('SUMMON ')) {
      const rest = body.slice(7).trim();
      const parenIdx = rest.indexOf('(');
      const entityName = parenIdx >= 0 ? rest.slice(0, parenIdx).trim() : rest;
      let summonType = null;
      if (parenIdx >= 0) {
        const inner = rest.slice(parenIdx + 1).replace(')', '').trim().toLowerCase();
        if (['minion', 'wood_golem', 'iron_golem'].includes(inner)) summonType = inner;
      }
      const entity = findEntity(entityName);
      if (entity) {
        const a = { type: PlanActionType.SUMMON, entityId: entity.id };
        if (summonType) a.summonType = summonType;
        actions.push(a);
      }
    } else if (upper.startsWith('HEAL ')) {
      const entity = findEntity(body.slice(5).trim());
      if (entity) actions.push({ type: PlanActionType.HEAL, entityId: entity.id });
    } else if (upper.startsWith('GUARD ')) {
      const entity = findEntity(body.slice(6).trim());
      if (entity) actions.push({ type: PlanActionType.GUARD, entityId: entity.id });
    } else if (upper.startsWith('SOUND_HORN ') || upper.startsWith('SOUND HORN ')) {
      const offset = upper.startsWith('SOUND_HORN') ? 11 : 11;
      const entity = findEntity(body.slice(offset).trim());
      if (entity) actions.push({ type: PlanActionType.SOUND_HORN, entityId: entity.id });
    } else if (upper.startsWith('USE_ITEM ') || upper.startsWith('USE ITEM ')) {
      const offset = upper.startsWith('USE_ITEM') ? 9 : 9;
      const rest = body.slice(offset).trim();
      const parts = rest.split(/\s+/);
      const item = parts.pop()?.toLowerCase();
      const entity = findEntity(parts.join(' '));
      if (entity && item) actions.push({ type: PlanActionType.USE_ITEM, entityId: entity.id, item });
    } else if (upper.startsWith('EQUIP ')) {
      const rest = body.slice(6).trim();
      const parts = rest.split(/\s+/);
      const weapon = parts.pop()?.toLowerCase();
      const entity = findEntity(parts.join(' '));
      if (entity && weapon) actions.push({ type: PlanActionType.EQUIP_WEAPON, entityId: entity.id, weapon });
    } else if (upper.startsWith('ABILITY ')) {
      const entity = findEntity(body.slice(8).trim());
      if (entity) actions.push({ type: PlanActionType.USE_ABILITY, entityId: entity.id });
    }
  }

  return actions;
}
