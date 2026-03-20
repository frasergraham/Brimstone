// Entry point: wires everything together
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController }      from './ui.js';
import { WitchAI }           from './ai.js';
import { hexToPixel }        from './hex.js';
import { PAD_X, PAD_Y }      from './renderer.js';

let state, renderer, ui, ai;

function init(witchIsAI) {
  const canvas = document.getElementById('game-canvas');

  // Show game screen before constructing renderer so the wrapper has real dimensions
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  state    = new GameState(witchIsAI);
  renderer = new Renderer(canvas, state);
  renderer.resize(); // fit to now-visible container
  ai       = new WitchAI(state, redraw);
  ui       = new UIController(canvas, state, renderer, ai, redraw);

  redraw();
  ui.refresh();

  // Scroll canvas wrapper to centre on the hero
  requestAnimationFrame(() => {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;
    const hero = state.hero;
    const { x, y } = hexToPixel(hero.col, hero.row, renderer.hexSize);
    const cx = x + PAD_X;
    const cy = y + PAD_Y;
    wrapper.scrollLeft = cx - wrapper.clientWidth  / 2;
    wrapper.scrollTop  = cy - wrapper.clientHeight / 2;
  });
}

function redraw() {
  renderer.draw();
  if (ui) ui._updateSidebar?.();
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

// ── Window resize ────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  if (!renderer) return;
  renderer.resize();
  redraw();
});

// ── Setup screen ────────────────────────────────────────────────────────────

document.getElementById('btn-vs-ai').addEventListener('click', () => init(true));
document.getElementById('btn-vs-human').addEventListener('click', () => init(false));
document.getElementById('btn-restart').addEventListener('click', () => {
  const el = document.getElementById('game-over');
  if (el) { el.style.display = 'none'; delete el.dataset.shown; }
  document.getElementById('setup-screen').style.display = 'flex';
  document.getElementById('game-screen').style.display  = 'none';
});
