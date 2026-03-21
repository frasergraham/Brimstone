// Central game state and turn management
import { generateMap } from './map.js';
import { createHero, createWitch, resetRoster, EntityType } from './entities.js';
import { ResourceType, TileType } from './tiles.js';
import { hexKey } from './hex.js';

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
// Base: 3 (hero) / 4 (witch) + 1 for their favoured time of day
// + 1 per additional living unit they control beyond their leader.
function computeActions(player, phase, entities) {
  const isHero    = player === Player.HERO;
  const base      = isHero ? 3 : 4;
  const timeBonus = (isHero && phase === Phase.DAY) || (!isHero && phase === Phase.NIGHT) ? 1 : 0;
  const owner     = isHero ? 'hero' : 'witch';
  const leaderType = isHero ? 'hero' : 'witch';
  const extras    = entities.filter(e => e.alive && e.owner === owner && e.type !== leaderType).length;
  return base + timeBonus + extras;
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

    this.round        = 1;
    this.phase        = Phase.DAWN;
    this.activePlayer = Player.HERO;
    this.actionsLeft  = computeActions(Player.HERO, Phase.DAWN, []);

    this.log = [
      `🌅 Dawn breaks over Salem. The hero stirs at the Inn.`,
      `Three Power Nodes: ${this.witchObjectives.map(o => o.label).join(', ')}.`,
      `⚔ Control all three at dawn to win. Any building shelters against the night.`,
    ];

    this.selectedEntity = null;
    this.pendingAction  = null;
    this.winner         = null;
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
      this.activePlayer = Player.WITCH;
      this.actionsLeft  = computeActions(Player.WITCH, this.phase, this.entities);
      if (!this.fogOfWar) this.addLog(`The witch stirs…`);
    } else {
      // End of full round — advance round and check phase
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

      // Night hazard: hero units in unfortified locations take 1 damage
      if (this.phase === Phase.NIGHT) {
        this._applyNightHazard();
      }

      // Dawn: check if witch holds all objectives (only at dawn start)
      if (this.phase === Phase.DAWN) {
        this._checkDawnObjectives();
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
        `🌙 Night descends! The witch grows powerful. Heroes in the open will suffer!`,
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

  _applyNightHazard() {
    // Any building (even unfortified) gives shelter against the night
    const endangered = this.entities.filter(e => {
      if (!e.alive || e.owner !== 'hero') return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    for (const e of endangered) {
      const killed = e.takeDamage(1);
      this.addLog(`🌙 The darkness presses in on ${e.displayName}! (-1 HP)`);
      if (killed) {
        this.entities = this.entities.filter(x => x.id !== e.id);
        this.addLog(`${e.displayName} is consumed by the night!`);
      }
    }
    if (endangered.length === 0) {
      this.addLog(`🌙 Night falls. The party rests safely, sheltered from the dark.`);
    }
  }

  // ── Victory conditions ─────────────────────────────────────────────────

  checkVictory() {
    if (!this.witch.alive) {
      this.winner = 'hero';
      this.addLog('☀ The witch has been defeated! Salem is saved!');
      return;
    }
    if (!this.hero.alive) {
      this.winner = 'witch';
      this.addLog('🌙 The hero has fallen. Darkness descends on Salem forever…');
    }
  }

  _checkDawnObjectives() {
    // Witch wins by holding all power nodes at dawn
    const witchHoldsAll = this.witchObjectives.every(obj =>
      this.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    );
    if (witchHoldsAll) {
      this.winner = 'witch';
      this.addLog('🌙 As dawn breaks, the witch holds all three Power Nodes! Salem is lost…');
      return;
    }

    // Hero wins by controlling all power nodes at dawn
    const heroHoldsAll = this.witchObjectives.every(obj =>
      this.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
    );
    if (heroHoldsAll) {
      this.winner = 'hero';
      this.addLog('☀ At dawn, the hero holds all three Power Nodes! The witch\'s ritual is broken!');
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

  toJSON() {
    return JSON.stringify({
      round: this.round,
      phase: this.phase,
      activePlayer: this.activePlayer,
      actionsLeft: this.actionsLeft,
      inventory: this.inventory,
      log: this.log.slice(-20),
    });
  }
}
