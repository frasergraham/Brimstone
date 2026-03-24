// Central game state and turn management
import { generateMap } from './map.js';
import { createHero, createWitch, createMinion, createSurvivor, resetRoster, EntityType } from './entities.js';
import { BuildingType, ResourceType, TileType } from './tiles.js';
import { hexKey, getNeighbors } from './hex.js';

// Win reason strings (shown in game-over overlay)
export const WIN_REASON = {
  WITCH_SLAIN:      'The hero hunted down the witch and ended the curse!',
  HERO_SLAIN:       'The hero fell in battle. Salem is lost to darkness.',
  NODES_WITCH:      'The witch seized all three Power Nodes at dawn — the ritual is complete!',
  NODES_HERO:       'The hero held all three Power Nodes at dawn — the witch\'s ritual is broken!',
  NODES_WITCH_DUSK: 'As dusk falls, the witch holds all three Power Nodes — the ritual advances!',
  NODES_HERO_DUSK:  'As dusk falls, the hero holds all three Power Nodes — the witch\'s ritual is disrupted!',
  SCORE_WITCH:      'The witch dominates the Power Nodes across three cycles — the ritual is complete!',
  SCORE_HERO:       'The hero holds the Power Nodes through the darkness — the curse is broken!',
};

// ── Phase cycle ─────────────────────────────────────────────────────────────
// One full cycle = 8 rounds: DAWN(1) → DAY(3) → DUSK(1) → NIGHT(3)

// Attrition schedule (damage per exposed unit per hazard phase):
//   Cycle 1: 0  — no hazard, players learn the map
//   Cycle 2: 1  — pressure begins
//   Cycles 3-4: 2  — significant threat
//   Cycle 5+: 3  — lethal for most minions/survivors in the open
function attritionForCycle(cycle) {
  if (cycle <= 1) return 0;
  if (cycle === 2) return 1;
  if (cycle <= 4) return 2;
  return 3;
}
const CYCLE_LENGTH = 8;

export const Phase = Object.freeze({
  DAWN:  'dawn',
  DAY:   'day',
  DUSK:  'dusk',
  NIGHT: 'night',
});

export const Player = Object.freeze({ HERO: 'hero', WITCH: 'witch' });

// Calculate actions for a player at the start of their turn.
// Hero  — base 3 + 1 in DAWN/DAY + 1 per survivor (cap +5, so needs 5 survivors for full bonus)
// Witch — base 4 + 1 in NIGHT + 1 per 2 minions (cap +6, so needs 12 minions for full bonus)
export function computeActions(player, phase, entities) {
  const isHero     = player === Player.HERO;
  const owner      = isHero ? 'hero' : 'witch';
  const leaderType = isHero ? 'hero' : 'witch';
  const extras     = entities.filter(e => e.alive && e.owner === owner && e.type !== leaderType).length;

  if (isHero) {
    const timeBonus = (phase === Phase.DAY || phase === Phase.DAWN) ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 5);
  } else {
    const timeBonus = phase === Phase.NIGHT ? 1 : 0;
    // Each pair of minions earns +1 action, up to +4 (needs 8 minions for full bonus)
    const unitBonus = Math.min(Math.floor(extras / 2), 4);
    return 3 + timeBonus + unitBonus;
  }
}

function phaseForRound(round) {
  const r = (round - 1) % CYCLE_LENGTH;
  if (r === 0)            return Phase.DAWN;
  if (r >= 1 && r <= 3)  return Phase.DAY;
  if (r === 4)            return Phase.DUSK;
  return Phase.NIGHT;
}

const PHASE_ICON = {
  [Phase.DAWN]:  '🌅',
  [Phase.DAY]:   '☀',
  [Phase.DUSK]:  '🌇',
  [Phase.NIGHT]: '🌙',
};

export { PHASE_ICON };

export class GameState {
  constructor(witchIsAI = true, heroIsAI = false) {
    resetRoster();
    const mapData  = generateMap();
    this.tiles     = mapData.tiles;
    this.entities  = [];
    this.witchIsAI = witchIsAI;
    this.heroIsAI  = heroIsAI;

    // Fog of war: hide opponent from the human player's view when any side is AI
    this.fogOfWar = witchIsAI || heroIsAI;

    this.hero  = createHero(mapData.heroStart.col,  mapData.heroStart.row);
    this.witch = createWitch(mapData.witchStart.col, mapData.witchStart.row);
    this.entities.push(this.hero, this.witch);

    this.inventory = { shared: {}, witch: {} };

    this.witchObjectives = mapData.witchObjectives;
    this._placeHiddenSurvivors();

    this.round        = 1;
    this.phase        = Phase.DAWN;
    this.activePlayer = Player.HERO;
    this.actionsLeft  = computeActions(Player.HERO, Phase.DAWN, []);
    this.witchSummonsThisTurn = 0;

    this.log = [
      `🌅 Dawn breaks over Salem. The hero stirs at the Inn.`,
      `Three Power Nodes: ${this.witchObjectives.map(o => o.label).join(', ')}.`,
      `⚔ Hold 2+ nodes at each dawn/dusk to score. First to 3 points wins. Three cycles — then darkness claims Salem.`,
    ];

    this.selectedEntity    = null;
    this.pendingAction     = null;
    this.winner            = null;
    this.winReason         = null;
    this.lastNightDamage   = []; // {col,row,dmg,isFort} entries for flash animation
    this.lastDayDamage     = []; // {col,row,dmg} entries for flash animation
    this.lastHazardLog     = []; // human-readable lines describing hazard events this phase

    // Cumulative node scoring: each dawn/dusk majority scores 1 point; first to 3 wins.
    this.nodeScore = { hero: 0, witch: 0 };

    // Attrition level: hazard damage dealt to exposed units (see attritionForCycle).
    this.attritionLevel    = 0;
    this.attritionChanged  = false; // true for exactly one planning phase after a level-up

    // ── Simultaneous-turn planning state ──────────────────────────────────
    // planningPhase: true while both sides are building their action plans.
    // resolving:     true while the resolver is executing paired steps.
    // heroPlan / witchPlan: submitted PlanAction[] arrays (null = not yet submitted).
    // heroReady / witchReady: submission flags.
    this.planningPhase  = false;
    this.resolving      = false;
    this.heroPlan       = null;
    this.witchPlan      = null;
    this.heroReady      = false;
    this.witchReady     = false;
    // Per-faction action budgets computed at planning start (mirrors old actionsLeft).
    this.heroActionsLeft  = 0;
    this.witchActionsLeft = 0;
  }

  // ── Turn management ────────────────────────────────────────────────────

  get actionsAvailable() {
    return this.actionsLeft;
  }

  spendAction(cost = 1) {
    this.actionsLeft = Math.max(0, this.actionsLeft - cost);
  }

  // ── Simultaneous-turn planning API ─────────────────────────────────────

  /** Begin a new planning phase: reset plans and compute per-faction budgets. */
  startPlanning() {
    this.planningPhase    = true;
    this.resolving        = false;
    this.heroPlan         = null;
    this.witchPlan        = null;
    this.heroReady        = false;
    this.witchReady       = false;
    this.heroActionsLeft  = computeActions(Player.HERO,  this.phase, this.entities);
    this.witchActionsLeft = computeActions(Player.WITCH, this.phase, this.entities);
    this.addLog(
      `📋 Planning phase — Hero: ${this.heroActionsLeft} actions, ` +
      `Witch: ${this.witchActionsLeft} actions.`
    );
  }

  /**
   * Submit a faction's plan.
   * @param {'hero'|'witch'} faction
   * @param {import('./planner.js').PlanAction[]} plan
   * @returns {boolean} true when both factions have submitted (resolution can begin)
   */
  submitPlan(faction, plan) {
    if (!this.planningPhase) throw new Error('Not in planning phase.');
    if (faction === Player.HERO) {
      this.heroPlan  = plan;
      this.heroReady = true;
      this.addLog(`⚔ Hero submits their plan (${plan.length} step${plan.length !== 1 ? 's' : ''}).`);
    } else {
      this.witchPlan  = plan;
      this.witchReady = true;
      this.addLog(`✦ Witch submits their plan (${plan.length} step${plan.length !== 1 ? 's' : ''}).`);
    }
    if (this.heroReady && this.witchReady) {
      this.planningPhase = false;
      this.resolving     = true;
      return true;
    }
    return false;
  }

  /**
   * Apply end-of-round effects after resolution: rest healing, night/day node
   * spawns, phase advance, hazards, attrition, and node scoring.
   * Replaces the two sequential endTurn() calls used in the old alternating model.
   */
  endRound() {
    this.resolving = false;
    this.witchSummonsThisTurn = 0;

    // Hero rest heal: resting inside a building or on a Power Node.
    const heroTile = this.tiles.get(hexKey(this.hero.col, this.hero.row));
    if (this.hero.alive && heroTile?.type === TileType.BUILDING && this.hero.hp < this.hero.maxHp) {
      const b = heroTile.building;
      if (b === BuildingType.INN) {
        this.hero.heal(3);
        this.addLog(`🏨 The hero rests at the inn. (+3 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
      } else if (b === BuildingType.CHURCH) {
        this.hero.heal(3);
        this.addLog(`⛪ The hero prays at the chapel. (+3 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
      } else {
        this.hero.heal(1);
        this.addLog(`🏠 The hero rests in shelter. (+1 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
      }
    }
    if (this.hero.alive && this.hero.hp < this.hero.maxHp) {
      const onNode = this.witchObjectives.some(
        obj => obj.col === this.hero.col && obj.row === this.hero.row
      );
      if (onNode) {
        this.hero.heal(1);
        this.addLog(`✨ The hero draws power from the node. (+1 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
      }
    }

    // Night: node spawns (witch → minion, hero → survivor).
    if (this.phase === Phase.NIGHT) {
      for (const obj of this.witchObjectives) {
        const freeHex = () => getNeighbors(obj.col, obj.row).find(n => {
          const t = this.tiles.get(hexKey(n.col, n.row));
          return t && t.type !== TileType.RIVER &&
            !this.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
        });
        if (this.witch.alive && this.witch.col === obj.col && this.witch.row === obj.row) {
          if (Math.random() < 0.33) {
            const hex = freeHex();
            if (hex) {
              this.entities.push(createMinion(hex.col, hex.row));
              this.addLog(`🌑 The witch channels the node — a minion rises from the dark!`);
            }
          } else {
            this.addLog(`🌑 The node stirs… but yields nothing this night.`);
          }
        }
        if (this.hero.alive && this.hero.col === obj.col && this.hero.row === obj.row) {
          if (Math.random() < 0.33) {
            const hex = freeHex();
            if (hex) {
              const s = createSurvivor(hex.col, hex.row);
              s.owner = 'hero';
              if (Math.random() < 0.5) s.items['horse'] = 1;
              this.entities.push(s);
              const horseNote = s.items['horse'] ? ' (arrives on horseback!)' : '';
              this.addLog(`✨ The node calls to the living — a survivor emerges!${horseNote}`);
            }
          } else {
            this.addLog(`✨ The node pulses faintly… no one answers the call tonight.`);
          }
        }
      }
    }

    // Advance round and phase.
    this.entities.forEach(e => e.resetTurn());
    this.round++;
    const prevPhase = this.phase;
    this.phase = phaseForRound(this.round);

    if (this.phase !== prevPhase) {
      this._announcePhaseChange(prevPhase, this.phase);
    } else {
      this.addLog(
        `Round ${this.round} — ${PHASE_ICON[this.phase]} ${this.phase.toUpperCase()}`
      );
    }

    // Hazards on the new phase.
    if (this.phase === Phase.NIGHT) {
      this.lastNightDamage = [];
      this.lastHazardLog   = [];
      this._applyNightHazard(this.attritionLevel);
    }
    if (this.phase === Phase.DAY) {
      this.lastDayDamage = [];
      this.lastHazardLog = [];
      this._applyDayHazard(this.attritionLevel);
    }
    if (this.phase === Phase.DAWN) {
      const cycle    = Math.ceil(this.round / CYCLE_LENGTH);
      const newLevel = attritionForCycle(cycle);
      this.attritionChanged = newLevel !== this.attritionLevel;
      this.attritionLevel   = newLevel;
      if (this.attritionChanged && newLevel > 0) {
        this.addLog(`🌅 A new dawn — cycle ${cycle}. The curse deepens! Hazard damage rises to ${newLevel}.`);
      } else {
        this.addLog(`🌅 A new dawn — cycle ${cycle}.`);
      }
      for (const [, t] of this.tiles) t.explored = false;
      this._checkNodeObjectives(Phase.DAWN);
    }
    if (this.phase === Phase.DUSK) {
      this._checkNodeObjectives(Phase.DUSK);
    }

    this.checkVictory();
  }

  endTurn() {
    const playerLabel = this.activePlayer === Player.HERO ? "Hero's" : "Witch's";
    this.addLog(`${playerLabel} turn ends.`);

    if (this.activePlayer === Player.HERO) {
      // Rest heal: hero recovers HP when ending their turn inside a building
      const heroTile = this.tiles.get(hexKey(this.hero.col, this.hero.row));
      if (this.hero.alive && heroTile?.type === TileType.BUILDING && this.hero.hp < this.hero.maxHp) {
        const b = heroTile.building;
        if (b === BuildingType.INN) {
          this.hero.heal(3);
          this.addLog(`🏨 The hero rests at the inn. (+3 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        } else if (b === BuildingType.CHURCH) {
          this.hero.heal(3);
          this.addLog(`⛪ The hero prays at the chapel. (+3 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        } else {
          this.hero.heal(1);
          this.addLog(`🏠 The hero rests in shelter. (+1 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        }
      }

      // Node blessing: hero standing on a Power Node heals 1 HP
      if (this.hero.alive && this.hero.hp < this.hero.maxHp) {
        const onNode = this.witchObjectives.some(
          obj => obj.col === this.hero.col && obj.row === this.hero.row
        );
        if (onNode) {
          this.hero.heal(1);
          this.addLog(`✨ The hero draws power from the node. (+1 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        }
      }

      this.activePlayer = Player.WITCH;
      this.actionsLeft  = computeActions(Player.WITCH, this.phase, this.entities);
      this.witchSummonsThisTurn = 0;
      this.addLog(`The witch stirs… (${this.actionsLeft} actions)`);
    } else {
      // Node effects: only during NIGHT
      // • Witch standing on a node raises a free minion each night round.
      // • Hero standing on a node attracts a free survivor each night round.
      // Minions held by a minion (not the witch) no longer spawn — the witch
      // must commit herself to a node to fuel her army.
      if (this.phase === Phase.NIGHT) {
        for (const obj of this.witchObjectives) {
          const freeHex = () => getNeighbors(obj.col, obj.row).find(n => {
            const t = this.tiles.get(hexKey(n.col, n.row));
            return t && t.type !== TileType.RIVER &&
              !this.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
          });

          // Witch herself on the node → spawn minion
          const witchHere = this.witch.alive &&
            this.witch.col === obj.col && this.witch.row === obj.row;
          if (witchHere) {
            const hex = freeHex();
            if (hex) {
              this.entities.push(createMinion(hex.col, hex.row));
              this.addLog(`🌑 The witch channels the node — a minion rises from the dark!`);
            }
          }

          // Hero on the node → attract a survivor
          const heroHere = this.hero.alive &&
            this.hero.col === obj.col && this.hero.row === obj.row;
          if (heroHere) {
            const hex = freeHex();
            if (hex) {
              const s = createSurvivor(hex.col, hex.row);
              s.owner = 'hero';
              if (Math.random() < 0.5) s.items['horse'] = 1;
              this.entities.push(s);
              const horseNote = s.items['horse'] ? ' (arrives on horseback!)' : '';
              this.addLog(`✨ The node calls to the living — a survivor emerges to join the hero!${horseNote}`);
            }
          }
        }
      }

      // End of full round — advance round and check phase
      this.witchSummonsThisTurn = 0;
      this.activePlayer = Player.HERO;
      this.round++;

      const prevPhase = this.phase;
      this.phase = phaseForRound(this.round);

      this.actionsLeft = computeActions(Player.HERO, this.phase, this.entities);

      // Announce phase transitions
      if (this.phase !== prevPhase) {
        this._announcePhaseChange(prevPhase, this.phase);
      } else {
        this.addLog(
          `Round ${this.round} — ${PHASE_ICON[this.phase]} ${this.phase.toUpperCase()}` +
          ` (Hero: ${this.actionsLeft} actions)`
        );
      }

      // Night hazard: survivors in the open take attritionLevel damage
      if (this.phase === Phase.NIGHT) {
        this.lastNightDamage = [];
        this.lastHazardLog   = [];
        this._applyNightHazard(this.attritionLevel);
      }

      // Day hazard: witch minions/zombies/golems in the open take attritionLevel damage
      if (this.phase === Phase.DAY) {
        this.lastDayDamage = [];
        this.lastHazardLog = [];
        this._applyDayHazard(this.attritionLevel);
      }

      // Dawn: ramp attrition, reset explored tiles, check nodes
      if (this.phase === Phase.DAWN) {
        this.attritionLevel = Math.min(3, this.attritionLevel + 1);
        this.addLog(`🌅 A new dawn — cycle ${Math.ceil(this.round / CYCLE_LENGTH)}. Attrition rises to ${this.attritionLevel}!`);
        for (const [, t] of this.tiles) t.explored = false;
        this._checkNodeObjectives(Phase.DAWN);
      }

      // Dusk: score nodes
      if (this.phase === Phase.DUSK) {
        this._checkNodeObjectives(Phase.DUSK);
      }
    }

    this.entities.forEach(e => e.resetTurn());
    this.checkVictory();
  }

  _announcePhaseChange(from, to) {
    const messages = {
      [`${Phase.DAWN}->${Phase.DAY}`]:
        `☀ The sun rises. The hero fights with vigour! (+1 ATK in combat)`,
      [`${Phase.DAY}->${Phase.DUSK}`]:
        `🌇 Dusk falls. Seek shelter before night. Neither side has advantage.`,
      [`${Phase.DUSK}->${Phase.NIGHT}`]:
        `🌙 Night descends! The witch grows powerful. Survivors in the open will suffer!`,
      [`${Phase.NIGHT}->${Phase.DAWN}`]:
        `🌅 Dawn breaks. The darkness retreats. Find cover for the coming night.`,
    };
    const key = `${from}->${to}`;
    this.addLog(messages[key] || `Phase changed: ${to.toUpperCase()}`);
    this.addLog(
      `Round ${this.round} — ${PHASE_ICON[to]} ${to.toUpperCase()}` +
      ` (Hero: ${this.actionsLeft} actions)`
    );
  }

  _applyNightHazard(dmg = 1) {
    // Fort degradation: ALL fortifications (including buildings) lose 1 level each
    // night, but are floored at 1 — they never crumble completely from the dark.
    for (const [key, t] of this.tiles) {
      if (t.fortifyLevel > 1) {
        t.fortifyLevel--;
        const [col, row] = key.split(',').map(Number);
        this.lastNightDamage.push({ col, row, dmg: 1, isFort: true });
        this.addLog(`🌑 The dark erodes a fortification at (${col},${row}). (level ${t.fortifyLevel} remaining)`);
      }
    }

    // Only SURVIVORS in the open take night damage — the hero is hardened against it.
    // Fortified hexes shelter their occupants.
    const endangered = this.entities.filter(e => {
      if (!e.alive || e.type !== EntityType.SURVIVOR) return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    if (dmg > 0) {
      for (const e of endangered) {
        const t = this.tiles.get(hexKey(e.col, e.row));
        if (t && t.fortifyLevel > 0) {
          const line = `🏰 ${e.displayName} is sheltered by the fort! (level ${t.fortifyLevel})`;
          this.addLog(line);
          this.lastHazardLog.push(line);
          continue;
        }
        this.lastNightDamage.push({ col: e.col, row: e.row, dmg });
        const killed = e.takeDamage(dmg);
        const line = killed
          ? `💀 ${e.displayName} is consumed by the night!`
          : `🌙 ${e.displayName} suffers in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;
        this.addLog(line);
        this.lastHazardLog.push(line);
        if (killed) this.entities = this.entities.filter(x => x.id !== e.id);
      }
    }
    if (endangered.length === 0 || dmg === 0) {
      this.addLog(`🌙 Night falls. Survivors are safe for now.`);
    }
  }

  _applyDayHazard(dmg = 1) {
    // Witch minions, zombies, and golems caught in the open during daylight take dmg damage.
    // Fortified hexes shelter their occupants from hazard damage.
    const sunburned = this.entities.filter(e => {
      if (!e.alive || e.owner !== 'witch') return false;
      if (e.type === EntityType.WITCH) return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    if (dmg > 0) {
      for (const e of sunburned) {
        const t = this.tiles.get(hexKey(e.col, e.row));
        if (t && t.fortifyLevel > 0) {
          const line = `🏰 ${e.displayName} is sheltered by the fort! (level ${t.fortifyLevel})`;
          this.addLog(line);
          this.lastHazardLog.push(line);
          continue;
        }
        this.lastDayDamage.push({ col: e.col, row: e.row, dmg });
        const killed = e.takeDamage(dmg);
        const line = killed
          ? `💀 ${e.displayName} is destroyed by the light!`
          : `☀ ${e.displayName} is scorched in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;
        this.addLog(line);
        this.lastHazardLog.push(line);
        if (killed) this.entities = this.entities.filter(x => x.id !== e.id);
      }
    }
    if (sunburned.length === 0 || dmg === 0) {
      this.addLog(`☀ Daylight. Witch units are sheltered or out of harm's way.`);
    }
  }

  // ── Victory conditions ─────────────────────────────────────────────────

  checkVictory() {
    if (!this.witch.alive) {
      this.winner    = 'hero';
      this.winReason = WIN_REASON.WITCH_SLAIN;
      this.addLog('☀ The witch has been defeated! Salem is saved!');
      return;
    }
    if (!this.hero.alive) {
      this.winner    = 'witch';
      this.winReason = WIN_REASON.HERO_SLAIN;
      this.addLog('🌙 The hero has fallen. Darkness descends on Salem forever…');
    }
  }

  _checkNodeObjectives(phase) {
    const isDawn     = phase === Phase.DAWN;
    const phaseLabel = isDawn ? 'dawn' : 'dusk';

    const witchCount = this.witchObjectives.filter(obj =>
      this.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    ).length;
    const heroCount = this.witchObjectives.filter(obj =>
      this.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
    ).length;

    // Instant win: sweep all three nodes
    if (witchCount === 3) {
      this.winner    = 'witch';
      this.winReason = isDawn ? WIN_REASON.NODES_WITCH : WIN_REASON.NODES_WITCH_DUSK;
      this.addLog(isDawn
        ? '🌙 As dawn breaks, the witch holds all three Power Nodes! Salem is lost…'
        : '🌙 As dusk falls, the witch holds all three Power Nodes! The ritual advances!');
      return;
    }
    if (heroCount === 3) {
      this.winner    = 'hero';
      this.winReason = isDawn ? WIN_REASON.NODES_HERO : WIN_REASON.NODES_HERO_DUSK;
      this.addLog(isDawn
        ? '☀ At dawn, the hero holds all three Power Nodes! The witch\'s ritual is broken!'
        : '☀ As dusk falls, the hero holds all three Power Nodes! The ritual is disrupted!');
      return;
    }

    // Scoring: whoever holds more nodes scores 1 point (even 1–0 counts)
    if (witchCount > heroCount) {
      this.nodeScore.witch++;
      this.addLog(`🌙 At ${phaseLabel}: witch leads ${witchCount}–${heroCount}. Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
      if (this.nodeScore.witch >= 4) {
        this.winner    = 'witch';
        this.winReason = WIN_REASON.SCORE_WITCH;
        this.addLog('🌙 The witch has claimed three ritual moments — Salem falls to darkness!');
      }
    } else if (heroCount > witchCount) {
      this.nodeScore.hero++;
      this.addLog(`☀ At ${phaseLabel}: hero leads ${heroCount}–${witchCount}. Score — Hero ${this.nodeScore.hero} / Witch ${this.nodeScore.witch}`);
      if (this.nodeScore.hero >= 4) {
        this.winner    = 'hero';
        this.winReason = WIN_REASON.SCORE_HERO;
        this.addLog('☀ The hero has broken the ritual three times — Salem is saved!');
      }
    } else {
      this.addLog(`⚖ At ${phaseLabel}: nodes tied (${witchCount}–${heroCount}). Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
    }
  }

  get gameOver() { return this.winner !== null; }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }

  playerEntities(player) {
    return this.entities.filter(e => e.owner === player && e.alive);
  }

  // Scatter 12 hidden survivors across the map: 10 in buildings, 2 on terrain.
  // Each tile can hold at most one; they reveal when any unit steps onto the tile.
  _placeHiddenSurvivors() {
    const buildings = [];
    const terrain   = [];
    for (const t of this.tiles.values()) {
      if (t.type === TileType.RIVER) continue;
      if (t.type === TileType.BUILDING) buildings.push(t);
      else terrain.push(t);
    }

    const shuffle = arr => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    shuffle(buildings).slice(0, 13).forEach(t => { t.hiddenSurvivor = true; });
    shuffle(terrain).slice(0, 2).forEach(t => { t.hiddenSurvivor = true; });
  }

  toJSON() {
    return JSON.stringify({
      round: this.round,
      phase: this.phase,
      activePlayer: this.activePlayer,
      actionsLeft: this.actionsLeft,
      inventory: this.inventory,
      nodeScore: this.nodeScore,
      attritionLevel: this.attritionLevel,
      log: this.log.slice(-20),
    });
  }
}
