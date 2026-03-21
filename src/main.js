// Entry point: wires everything together
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController }      from './ui.js';
import { WitchAI, HeroAI }   from './ai.js';
import { hexToPixel }        from './hex.js';
import { PAD_X, PAD_Y }      from './renderer.js';

let state, renderer, ui, witchAI, heroAI;

function init(witchIsAI, heroIsAI) {
  const canvas = document.getElementById('game-canvas');

  // Show game screen before constructing renderer so the wrapper has real dimensions
  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display   = 'flex';

  state    = new GameState(witchIsAI, heroIsAI);
  renderer = new Renderer(canvas, state);
  renderer.resize();

  witchAI = witchIsAI ? new WitchAI(state, redraw) : null;
  heroAI  = heroIsAI  ? new HeroAI(state, redraw)  : null;

  ui = new UIController(canvas, state, renderer, witchAI, redraw, heroAI);

  // Show battle dialog for AI-initiated attacks
  const battleCallback = (actorSnap, targetSnap, result) =>
    new Promise(resolve => ui._showBattleDialog(actorSnap, targetSnap, result, resolve));

  if (witchAI) witchAI.onBattleResult = battleCallback;
  if (heroAI)  heroAI.onBattleResult  = battleCallback;

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

// ── Setup screen ─────────────────────────────────────────────────────────────

const stepMode = document.getElementById('setup-step-mode');
const stepSide = document.getElementById('setup-step-side');

function showStep(step) {
  stepMode.style.display = step === 'mode' ? '' : 'none';
  stepSide.style.display = step === 'side' ? '' : 'none';
}

document.getElementById('btn-vs-ai').addEventListener('click',    () => showStep('side'));
document.getElementById('btn-vs-human').addEventListener('click', () => init(false, false));
document.getElementById('btn-back').addEventListener('click',     () => showStep('mode'));

document.getElementById('btn-play-hero').addEventListener('click',  () => init(true,  false));
document.getElementById('btn-play-witch').addEventListener('click', () => init(false, true));

document.getElementById('btn-restart').addEventListener('click', () => {
  const el = document.getElementById('game-over');
  if (el) { el.style.display = 'none'; delete el.dataset.shown; }
  showStep('mode');
  document.getElementById('setup-screen').style.display = 'flex';
  document.getElementById('game-screen').style.display  = 'none';
});
