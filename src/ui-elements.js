// Centralized DOM element registry.
// Pass the result to UIController as the `els` parameter to make the class
// testable without a real browser document — tests inject fake elements keyed
// by the same IDs used here.
//
// Dynamic elements (score-toast, speed-toast) that are created and removed at
// runtime are NOT included; those are still queried inline via
// document.getElementById each time they are needed.

export function collectUIElements(doc = document) {
  const g = id => doc.getElementById(id);
  return {
    // ── Zoom / speed ──────────────────────────────────────────────────────
    'zoom-in':                 g('zoom-in'),
    'zoom-out':                g('zoom-out'),
    'zoom-fit':                g('zoom-fit'),
    'zoom-me':                 g('zoom-me'),
    'speed-toggle':            g('speed-toggle'),
    'speed-popup':             g('speed-popup'),
    'step-continue-bar':       g('step-continue-bar'),
    'canvas-wrapper':          g('canvas-wrapper'),

    // ── Header / menu ─────────────────────────────────────────────────────
    'menu-btn':                g('menu-btn'),
    'menu-quit-btn':           g('menu-quit-btn'),
    'game-menu-popup':         g('game-menu-popup'),
    'game-screen':             g('game-screen'),
    'end-turn-btn':            g('end-turn-btn'),
    'turn-info':               g('turn-info'),
    'cycle-bar':               g('cycle-bar'),
    'node-status':             g('node-status'),
    'node-status-bar':         g('node-status-bar'),
    'online-status':           g('online-status'),

    // ── Plan panel ────────────────────────────────────────────────────────
    'plan-panel':              g('plan-panel'),
    'plan-tab':                g('plan-tab'),
    'plan-tab-count':          g('plan-tab-count'),
    'plan-toggle-btn':         g('plan-toggle-btn'),
    'plan-steps':              g('plan-steps'),
    'plan-budget-badge':       g('plan-budget-badge'),
    'plan-status':             g('plan-status'),
    'plan-players':            g('plan-players'),
    'plan-food-row':           g('plan-food-row'),
    'plan-countdown':          g('plan-countdown'),
    'plan-submit-btn':         g('plan-submit-btn'),
    'plan-clear-btn':          g('plan-clear-btn'),
    'plan-inventory':          g('plan-inventory'),

    // ── Unit stats / targeting ────────────────────────────────────────────
    'unit-stats-bar':          g('unit-stats-bar'),
    'action-popup':            g('action-popup'),
    'cancel-action-btn':       g('cancel-action-btn'),
    'cancel-wrap':             g('cancel-wrap'),
    'target-hint':             g('target-hint'),

    // ── Chronicle ─────────────────────────────────────────────────────────
    'chronicle-close':         g('chronicle-close'),
    'chronicle-overlay':       g('chronicle-overlay'),
    'chronicle-sidebar-close': g('chronicle-sidebar-close'),
    'chronicle-sidebar':       g('chronicle-sidebar'),
    'chronicle-sidebar-log':   g('chronicle-sidebar-log'),
    'chronicle-mini':          g('chronicle-mini'),
    'event-log':               g('event-log'),

    // ── Tile zoom ─────────────────────────────────────────────────────────
    'tile-zoom-close':         g('tile-zoom-close'),
    'tile-zoom-overlay':       g('tile-zoom-overlay'),
    'tile-zoom-poly':          g('tile-zoom-poly'),
    'tile-zoom-fort':          g('tile-zoom-fort'),
    'tile-zoom-icon':          g('tile-zoom-icon'),
    'tile-zoom-tile-name':     g('tile-zoom-tile-name'),
    'tile-zoom-info-lines':    g('tile-zoom-info-lines'),
    'tile-zoom-units':         g('tile-zoom-units'),

    // ── Dialogs ───────────────────────────────────────────────────────────
    'encounter-dialog':        g('encounter-dialog'),
    'encounter-card':          g('encounter-card'),
    'result-dialog':           g('result-dialog'),
    'result-messages':         g('result-messages'),
    'result-dismiss-hint':     g('result-dismiss-hint'),
    'result-buttons':          g('result-buttons'),
    'result-portrait':         g('result-portrait'),
    'battle-dialog':           g('battle-dialog'),
    'battle-footer':           g('battle-footer'),
    'battle-summary':          g('battle-summary'),
    'battle-attacker':         g('battle-attacker'),
    'battle-defender':         g('battle-defender'),
    'battle-atk-die':          g('battle-atk-die'),
    'battle-def-die':          g('battle-def-die'),
    'battle-outcome':          g('battle-outcome'),
    'battle-atk-breakdown':    g('battle-atk-breakdown'),
    'battle-def-breakdown':    g('battle-def-breakdown'),
    'battle-toast-container':  g('battle-toast-container'),

    // ── Phase modal / round summary ───────────────────────────────────────
    'phase-modal':             g('phase-modal'),
    'phase-modal-continue':    g('phase-modal-continue'),
    'round-summary':           g('round-summary'),
    'round-summary-events':    g('round-summary-events'),
    'round-summary-speed-row': g('round-summary-speed-row'),
    'round-summary-next':      g('round-summary-next'),
    'round-summary-replay':    g('round-summary-replay'),
  };
}
