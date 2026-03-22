// Central game state and turn management
import { generateMap } from './map.js';
import { createHero, createWitch, createMinion, resetRoster, EntityType } from './entities.js';
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
const CYCLE_LENGTH = 8;

export const Phase = Object.freeze({
  DAWN:  'dawn',
  DAY:   'day',
  DUSK:  'dusk',
  NIGHT: 'night',
});

export const Player = Object.freeze({ HERO: 'hero', WITCH: 'witch' });

// Calculate actions for a player at the start of their turn.
// Hero  — base 3 + 1 in DAWN (prep bonus) + 1 in DAY + 1 per extra unit (cap +2)
// Witch — base 4 + 1 in NIGHT + 1 per 2 extra units (cap +4, so needs 8 minions for full bonus)
function computeActions(player, phase, entities) {
  const isHero     = player === Player.HERO;
  const owner      = isHero ? 'hero' : 'witch';
  const leaderType = isHero ? 'hero' : 'witch';
  const extras     = entities.filter(e => e.alive && e.owner === owner && e.type !== leaderType).length;

  if (isHero) {
    const timeBonus = (phase === Phase.DAY || phase === Phase.DAWN) ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 2);
  } else {
    const timeBonus = phase === Phase.NIGHT ? 1 : 0;
    // Each pair of minions earns +1 action, up to +4 (needs 8 minions for max)
    const unitBonus = Math.min(Math.floor(extras / 2), 4);
    return 4 + timeBonus + unitBonus;
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

    // Fog of war: hide witch movements and positions when witch is AI
    this.fogOfWar = witchIsAI;

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
    this.lastNightDamage   = []; // positions damaged last night hazard (for flash animation)
    this.lastDayDamage     = []; // positions damaged last day hazard
    this.lastHazardLog     = []; // human-readable lines describing hazard events this phase

    // Cumulative node scoring: each dawn/dusk majority scores 1 point; first to 3 wins.
    this.nodeScore = { hero: 0, witch: 0 };

    // Attrition level: hazard damage dealt to exposed units. Ramps up each dawn.
    // Cycle 1: 1 dmg, Cycle 2: 2 dmg, Cycle 3: 3 dmg.
    this.attritionLevel = 1;
  }

  // ── Turn management ────────────────────────────────────────────────────

  get actionsAvailable() {
    return this.actionsLeft;
  }

  spendAction(cost = 1) {
    this.actionsLeft = Math.max(0, this.actionsLeft - cost);
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
      // Node spawning: only during NIGHT — each held node raises a free minion
      if (this.phase === Phase.NIGHT)
      for (const obj of this.witchObjectives) {
        const holder = this.entities.find(
          e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row
        );
        if (!holder) continue;
        const spawnHex = getNeighbors(obj.col, obj.row).find(n => {
          const t = this.tiles.get(hexKey(n.col, n.row));
          return t && t.type !== TileType.RIVER &&
            !this.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
        });
        if (spawnHex) {
          const newMinion = createMinion(spawnHex.col, spawnHex.row);
          this.entities.push(newMinion);
          this.addLog(`🌑 The node at (${obj.col},${obj.row}) stirs — a new minion rises!`);
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
    // Only SURVIVORS in the open take night damage — the hero is hardened against it
    const endangered = this.entities.filter(e => {
      if (!e.alive || e.type !== EntityType.SURVIVOR) return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    for (const e of endangered) {
      this.lastNightDamage.push({ col: e.col, row: e.row });
      const killed = e.takeDamage(dmg);
      const line = killed
        ? `💀 ${e.displayName} is consumed by the night!`
        : `🌙 ${e.displayName} suffers in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;
      this.addLog(line);
      this.lastHazardLog.push(line);
      if (killed) this.entities = this.entities.filter(x => x.id !== e.id);
    }
    if (endangered.length === 0) {
      this.addLog(`🌙 Night falls. Survivors rest safely, sheltered from the dark.`);
    }
  }

  _applyDayHazard(dmg = 1) {
    // Witch minions, zombies, and golems caught in the open during daylight take dmg damage
    const sunburned = this.entities.filter(e => {
      if (!e.alive || e.owner !== 'witch') return false;
      if (e.type === EntityType.WITCH) return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    for (const e of sunburned) {
      this.lastDayDamage.push({ col: e.col, row: e.row });
      const killed = e.takeDamage(dmg);
      const line = killed
        ? `💀 ${e.displayName} is destroyed by the light!`
        : `☀ ${e.displayName} is scorched in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;
      this.addLog(line);
      this.lastHazardLog.push(line);
      if (killed) this.entities = this.entities.filter(x => x.id !== e.id);
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
      if (this.nodeScore.witch >= 3) {
        this.winner    = 'witch';
        this.winReason = WIN_REASON.SCORE_WITCH;
        this.addLog('🌙 The witch has claimed three ritual moments — Salem falls to darkness!');
      }
    } else if (heroCount > witchCount) {
      this.nodeScore.hero++;
      this.addLog(`☀ At ${phaseLabel}: hero leads ${heroCount}–${witchCount}. Score — Hero ${this.nodeScore.hero} / Witch ${this.nodeScore.witch}`);
      if (this.nodeScore.hero >= 3) {
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

    shuffle(buildings).slice(0, 10).forEach(t => { t.hiddenSurvivor = true; });
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
