// Central game state and turn management
import { generateMap, getStartPosition, WITCH_OBJECTIVES } from './map.js';
import { createHero, createWitch, EntityType } from './entities.js';
import { ResourceType } from './tiles.js';

// Day/Night cycle: 3 rounds per phase
const ROUNDS_PER_PHASE = 3;

// Actions per turn per phase
const ACTIONS = {
  day:   { hero: 4, witch: 3 },
  night: { hero: 3, witch: 4 },
};

export const Phase = Object.freeze({ DAY: 'day', NIGHT: 'night' });
export const Player = Object.freeze({ HERO: 'hero', WITCH: 'witch' });

export class GameState {
  constructor(witchIsAI = true) {
    this.tiles    = generateMap();
    this.entities = [];
    this.witchIsAI = witchIsAI;

    // Spawn hero and witch
    const heroPos  = getStartPosition('hero');
    const witchPos = getStartPosition('witch');
    this.hero  = createHero(heroPos.col, heroPos.row);
    this.witch = createWitch(witchPos.col, witchPos.row);
    this.entities.push(this.hero, this.witch);

    // Inventory: stockpile of resources per side
    this.inventory = {
      hero:  {},
      witch: {},
    };

    // Witch's strategic objectives (imported from map)
    this.witchObjectives = WITCH_OBJECTIVES;

    // Turn tracking
    this.round         = 1;   // round number (increments after both players act)
    this.phase         = Phase.DAY;
    this.activePlayer  = Player.HERO;
    this.actionsLeft   = ACTIONS[Phase.DAY].hero;
    this.bonusActions  = 0;   // from Food resource

    // Log
    this.log = [`Day 1 begins. The hero arrives at the Inn.`];
    this.log.push(
      `The witch has three Power Nodes she is trying to seize: ` +
      WITCH_OBJECTIVES.map(o => o.label).join(', ') + `.`
    );

    // UI state (managed externally but kept here for serialisation)
    this.selectedEntity = null;
    this.pendingAction  = null;  // { type, actor, targets }

    // Victory tracking
    this.winner = null;  // null | 'hero' | 'witch'
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
    this.addLog(`${this.activePlayer === Player.HERO ? "Hero's" : "Witch's"} turn ends.`);

    if (this.activePlayer === Player.HERO) {
      // Switch to witch
      this.activePlayer = Player.WITCH;
      this.actionsLeft  = ACTIONS[this.phase].witch;
      this.bonusActions = 0;
      this.addLog(`The witch stirs…`);
    } else {
      // End of round
      this.activePlayer = Player.HERO;
      this.round++;

      // Check phase change
      const phaseRound = ((this.round - 1) % (ROUNDS_PER_PHASE * 2));
      if (phaseRound < ROUNDS_PER_PHASE) {
        this.phase = Phase.DAY;
      } else {
        this.phase = Phase.NIGHT;
      }

      this.actionsLeft  = ACTIONS[this.phase].hero;
      this.bonusActions = 0;

      this.addLog(
        `Round ${this.round} — ${this.phase === Phase.DAY ? '☀ Day' : '🌙 Night'}` +
        ` (Hero: ${this.actionsLeft} actions, Witch: ${ACTIONS[this.phase].witch} actions)`
      );
    }

    // Reset all entities' per-turn state
    this.entities.forEach(e => e.resetTurn());

    this.checkVictory();
  }

  // ── Victory conditions ─────────────────────────────────────────────────

  checkVictory() {
    if (!this.witch.alive) {
      this.winner = 'hero';
      this.addLog('☀ The witch has been defeated! The hero has saved Salem!');
      return;
    }
    if (!this.hero.alive) {
      this.winner = 'witch';
      this.addLog('🌙 The hero has fallen. Darkness descends on Salem forever…');
      return;
    }

    // Witch wins if all 3 objectives are held by witch-side entities
    const allHeld = this.witchObjectives.every(obj =>
      this.entities.some(
        e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row
      )
    );
    if (allHeld) {
      this.winner = 'witch';
      this.addLog(
        '🌙 The witch has claimed all three Power Nodes! Salem is lost to darkness…'
      );
    }
  }

  get gameOver() { return this.winner !== null; }

  // ── Helpers ─────────────────────────────────────────────────────────────

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }

  // Return all entities owned by a player (including hero/witch themselves)
  playerEntities(player) {
    return this.entities.filter(e => e.owner === player && e.alive);
  }

  // Serialise for save/load (future)
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
