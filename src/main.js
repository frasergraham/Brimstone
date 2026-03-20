// Entry point: wires everything together
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController }      from './ui.js';
import { WitchAI }           from './ai.js';

let state, renderer, ui, ai;

function init(witchIsAI) {
  const canvas = document.getElementById('game-canvas');

  state    = new GameState(witchIsAI);
  renderer = new Renderer(canvas, state);
  ai       = new WitchAI(state, redraw);
  ui       = new UIController(canvas, state, renderer, ai, redraw);

  // Initial render
  redraw();
  ui.refresh();

  // Hide setup, show game
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';
}

function redraw() {
  renderer.draw();
  // Also keep sidebar up to date on every redraw
  if (ui) ui.refresh && ui._updateSidebar?.();
  if (state?.gameOver) showGameOver();
}

function showGameOver() {
  const el = document.getElementById('game-over');
  if (!el || el.dataset.shown) return;
  el.dataset.shown = '1';
  el.style.display = 'flex';
  el.querySelector('.winner-text').textContent =
    state.winner === 'hero'
      ? '☀ The Hero has vanquished the witch! Salem is saved!'
      : '🌙 The witch has won. Darkness falls over Salem forever…';
}

// ── Setup screen ────────────────────────────────────────────────────────────

document.getElementById('btn-vs-ai').addEventListener('click', () => init(true));
document.getElementById('btn-vs-human').addEventListener('click', () => init(false));
document.getElementById('btn-restart').addEventListener('click', () => {
  const el = document.getElementById('game-over');
  if (el) { el.style.display = 'none'; delete el.dataset.shown; }
  document.getElementById('setup-screen').style.display = 'flex';
  document.getElementById('game-screen').style.display  = 'none';
});
