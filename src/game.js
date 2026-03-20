// Central game state and turn management
import { generateMap, getStartPosition, WITCH_OBJECTIVES } from './map.js';
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

// Actions per turn per phase
const ACTIONS = {
  [Phase.DAWN]:  { hero: 3, witch: 3 },
  [Phase.DAY]:   { hero: 4, witch: 3 },
  [Phase.DUSK]:  { hero: 3, witch: 3 },
  [Phase.NIGHT]: { hero: 3, witch: 4 },
};

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
  constructor(witchIsAI = true) {
    resetRoster();
    this.tiles     = generateMap();
    this.entities  = [];
    this.witchIsAI = witchIsAI;

    // Fog of war: hide witch movements and positions in AI mode
    this.fogOfWar = witchIsAI;

    const heroPos  = getStartPosition('hero');
    const witchPos = getStartPosition('witch');
    this.hero  = createHero(heroPos.col, heroPos.row);
    this.witch = createWitch(witchPos.col, witchPos.row);
    this.entities.push(this.hero, this.witch);

    this.inventory = { shared: {}, witch: {} };

    this.witchObjectives = WITCH_OBJECTIVES;

    this.round        = 1;
    this.phase        = Phase.DAWN;
    this.activePlayer = Player.HERO;
    this.actionsLeft  = ACTIONS[Phase.DAWN].hero;
    this.bonusActions = 0;

    this.log = [
      `🌅 Dawn breaks over Salem. The hero stirs at the Inn.`,
      `The witch has three Power Nodes to seize: ` +
        WITCH_OBJECTIVES.map(o => o.label).join(', ') + `.`,
      `⚠ Stay in a fortified building when night falls or suffer in the darkness.`,
    ];

    this.selectedEntity = null;
    this.pendingAction  = null;
    this.winner         = null;
  }

  // ── Turn management ────────────────────────────────────────────────────

  get actionsAvailable() {
    return this.actionsLeft + this.bonusActions;
  }

  spendAction(cost = 1) {
    if (this.bonusActions > 0) {
      this.bonusActions = Math.max(0, this.bonusActions - cost);
    } else {
      this.actionsLeft = Math.max(0, this.actionsLeft - cost);
    }
  }

  endTurn() {
    const playerLabel = this.activePlayer === Player.HERO ? "Hero's" : "Witch's";
    this.addLog(`${playerLabel} turn ends.`);

    if (this.activePlayer === Player.HERO) {
      this.activePlayer = Player.WITCH;
      this.actionsLeft  = ACTIONS[this.phase].witch;
      this.bonusActions = 0;
      if (!this.fogOfWar) this.addLog(`The witch stirs…`);
    } else {
      // End of full round — advance round and check phase
      this.activePlayer = Player.HERO;
      this.round++;

      const prevPhase = this.phase;
      this.phase = phaseForRound(this.round);

      // Each living hero survivor grants +1 action to the hero turn
      const survivorBonus = this.entities.filter(
        e => e.alive && e.owner === 'hero' && e.type === 'survivor'
      ).length;
      this.actionsLeft  = ACTIONS[this.phase].hero + survivorBonus;
      this.bonusActions = 0;

      // Announce phase transitions
      if (this.phase !== prevPhase) {
        this._announcePhaseChange(prevPhase, this.phase);
      } else {
        this.addLog(
          `Round ${this.round} — ${PHASE_ICON[this.phase]} ${this.phase.toUpperCase()}` +
          ` (Hero: ${this.actionsLeft} actions, Witch: ${ACTIONS[this.phase].witch} actions)`
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
        `🌙 Night descends! The witch grows powerful. Unfortified heroes will suffer!`,
      [`${Phase.NIGHT}->${Phase.DAWN}`]:
        `🌅 Dawn breaks. The darkness retreats. Find cover for the coming night.`,
    };
    const key = `${from}->${to}`;
    this.addLog(messages[key] || `Phase changed: ${to.toUpperCase()}`);
    this.addLog(
      `Round ${this.round} — ${PHASE_ICON[to]} ${to.toUpperCase()}` +
      ` (Hero: ${this.actionsLeft} actions, Witch: ${ACTIONS[to].witch} actions)`
    );
  }

  _applyNightHazard() {
    const endangered = this.entities.filter(e => {
      if (!e.alive || e.owner !== 'hero') return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING && t.fortifyLevel > 0);
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
    const allHeld = this.witchObjectives.every(obj =>
      this.entities.some(
        e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row
      )
    );
    if (allHeld) {
      this.winner = 'witch';
      this.addLog('🌙 As dawn breaks, the witch holds all three Power Nodes! Salem is lost…');
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
