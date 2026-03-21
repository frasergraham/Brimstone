// Entry point: wires everything together
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController }      from './ui.js';
import { WitchAI, HeroAI }   from './ai.js';
import { hexToPixel }        from './hex.js';
import { PAD_X, PAD_Y }      from './renderer.js';

let state, renderer, ui, witchAI, heroAI;
let _autoplay = false;

// autoplay: both AIs, fast timing, auto-restart on game over
function init(witchIsAI, heroIsAI, autoplay = false) {
  _autoplay = autoplay;
  const canvas = document.getElementById('game-canvas');

  // Show game screen before constructing renderer so the wrapper has real dimensions
  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display   = 'flex';

  state    = new GameState(witchIsAI, heroIsAI);
  renderer = new Renderer(canvas, state);
  renderer.resize();

  const thinkDelay = autoplay ? 0 : undefined;
  witchAI = witchIsAI ? new WitchAI(state, redraw, thinkDelay) : null;
  heroAI  = heroIsAI  ? new HeroAI(state, redraw, thinkDelay)  : null;

  ui = new UIController(canvas, state, renderer, witchAI, redraw, heroAI, autoplay);

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

  const banner = state.winner === 'hero'
    ? '☀ The Hero Triumphs!'
    : '🌙 The Witch Prevails!';
  const reason = state.winReason
    || (state.winner === 'hero'
        ? 'The hero has vanquished the witch! Salem is saved!'
        : 'The witch has won. Darkness falls over Salem forever…');

  if (_autoplay) {
    // In autoplay mode: show result briefly in the header, then restart
    document.getElementById('turn-info').textContent = `${banner} — restarting…`;
    setTimeout(() => {
      delete el.dataset.shown;
      init(true, true, true);
    }, 1500);
  } else {
    el.style.display = 'flex';
    el.querySelector('.winner-text').innerHTML =
      `<div class="winner-banner">${banner}</div><div class="winner-reason">${reason}</div>`;
  }
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

document.getElementById('btn-vs-ai').addEventListener('click',       () => showStep('side'));
document.getElementById('btn-vs-human').addEventListener('click',    () => init(false, false));
document.getElementById('btn-autoplay').addEventListener('click',    () => init(true, true, true));
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
