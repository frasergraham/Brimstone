// Entry point: wires all modules, setup screen flow, resize
import { GameState, Player } from './game.js';
import { Renderer }          from './renderer.js';
import { UIController, UIMode } from './ui.js';
import { WitchAI, HeroAI }   from './ai.js';
import { MultiplayerClient, MirrorState, loadSession, clearSession } from './multiplayer.js';
import { VERSION }           from './version.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType }    from './planner.js';
import { hexDistance }       from './hex.js';
import { compileTurnBattleSummary } from './battle-utils.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// Stamp version into badges
document.getElementById('version-badge').textContent = `v${VERSION}`;
document.getElementById('menu-version').textContent  = `v${VERSION}`;

let state, renderer, ui, witchAI, heroAI;
let _autoplay  = false;
let _resolving = false;           // true while _animateResolutionSteps is running
let _pendingPlanningPhase = null; // buffered onPlanningPhase payload received during animation

// ── Local game init ───────────────────────────────────────────────────────────

function _genSaveId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Shared setup for all local (single-player) game starts.
 * Creates the Renderer, UIController, and wires the callbacks that must be
 * present regardless of whether the game is new or resumed:
 *   - onQuitToMenu  → reload the page (returns to setup screen)
 *   - AI battle callbacks → show animated battle dialog
 *
 * Called by both init() and _startFromState() so neither can forget a callback.
 */
function _setupLocalUI(canvas, localWitchAI, localHeroAI, autoplay) {
  renderer = new Renderer(canvas, state);
  renderer.resize();
  renderer.loadImages();

  ui = new UIController(canvas, state, renderer, localWitchAI, redraw, localHeroAI, autoplay);
  ui.onQuitToMenu = () => location.reload();

  const battleCallback = (actorSnap, targetSnap, result) =>
    new Promise(resolve => ui._showBattleDialog(actorSnap, targetSnap, result, resolve));
  if (localWitchAI) localWitchAI.onBattleResult = battleCallback;
  if (localHeroAI)  localHeroAI.onBattleResult  = battleCallback;
}

function init(witchIsAI, heroIsAI, autoplay = false) {
  _autoplay = autoplay;
  // Assign a fresh save ID for this game (only used for single-player saves)
  _spSaveId = _genSaveId();
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display   = 'flex';

  const mapSize = document.getElementById('select-map-size')?.value ?? 'standard';
  state    = new GameState(witchIsAI, heroIsAI, mapSize);
  // Allow global fog-of-war override from the setup screen checkbox.
  const fogChk = document.getElementById('chk-fog-of-war');
  if (fogChk && !fogChk.checked) state.fogOfWar = false;

  const thinkDelay = autoplay ? 0 : undefined;
  witchAI = witchIsAI ? new WitchAI(state, redraw, thinkDelay) : null;
  heroAI  = heroIsAI  ? new HeroAI(state, redraw, thinkDelay)  : null;

  _setupLocalUI(canvas, witchAI, heroAI, autoplay);

  redraw();

  requestAnimationFrame(() => {
    // Resize now that game-screen layout is complete and the canvas has real dimensions.
    renderer.resize();
    // Re-frame starting units with correct dimensions (overrides the one queued in
    // enterPlanningMode which fired before layout was resolved).
    if (!_autoplay) {
      const humanFaction = !state.heroIsAI ? 'hero' : 'witch';
      const startUnits = state.entities.filter(e => e.alive && e.owner === humanFaction);
      if (startUnits.length > 0) {
        renderer.frameHexes(startUnits, { maxZoom: 1.8, paddingHexes: 2.5, duration: 550 });
      }
    }
    redraw();
  });

  _startLocalPlanningPhase();
}

function redraw() {
  renderer.draw();
  if (ui) ui._updateSidebar?.();
}

// ── Local planning lifecycle ──────────────────────────────────────────────────

function _startLocalPlanningPhase() {
  if (!state || state.gameOver) return;
  state.startPlanning();

  if (_autoplay) {
    // AI vs AI: generate both plans immediately then resolve
    setTimeout(() => _runLocalAutoResolution(), 0);
    return;
  }

  const humanFaction = !state.heroIsAI ? 'hero' : 'witch';
  const budget = humanFaction === 'hero' ? state.heroActionsLeft : state.witchActionsLeft;

  if (!state.heroIsAI && !state.witchIsAI) {
    // Human vs Human: hero plans first, then witch
    ui.enterPlanningMode('hero', state.heroActionsLeft);
    ui.onPlanSubmit = (heroPlan) => _onLocalHvHHeroPlan(heroPlan);
  } else {
    // One human vs AI
    ui.enterPlanningMode(humanFaction, budget);
    ui.onPlanSubmit = (plan) => _onLocalHumanPlanSubmit(humanFaction, plan);
  }
}

/** Human vs Human: hero submitted, now show witch planning. */
async function _onLocalHvHHeroPlan(heroPlan) {
  ui.exitPlanningMode();
  state.submitPlan('hero', heroPlan); // witchPlan not set yet → not both ready

  ui.enterPlanningMode('witch', state.witchActionsLeft);
  ui.onPlanSubmit = async (witchPlan) => {
    ui.exitPlanningMode();
    state.submitPlan('witch', witchPlan); // both ready → resolving = true
    await _runLocalResolution();
  };
}

/** Human submitted their plan; generate AI plan then resolve. */
async function _onLocalHumanPlanSubmit(faction, plan) {
  ui.exitPlanningMode();

  let bothReady = state.submitPlan(faction, plan);
  if (!bothReady) {
    const aiPlan = faction === 'hero'
      ? (witchAI ? witchAI.generatePlan() : [])
      : (heroAI  ? heroAI.generatePlan()  : []);
    const aiFaction = faction === 'hero' ? 'witch' : 'hero';
    bothReady = state.submitPlan(aiFaction, aiPlan);
  }

  if (bothReady) await _runLocalResolution();
}

async function _runLocalAutoResolution() {
  if (!state || state.gameOver) return;
  const heroPlan  = heroAI  ? heroAI.generatePlan()  : [];
  const witchPlan = witchAI ? witchAI.generatePlan() : [];
  state.submitPlan('hero',  heroPlan);
  state.submitPlan('witch', witchPlan);
  await _runLocalResolution();
}

async function _runLocalResolution() {
  if (!state || state.gameOver) return;

  // Cap shared food to the human player's enabled food count so the resolver
  // only auto-spends the rations the player actually chose to commit.
  const shared = state.inventory?.shared;
  if (shared && ui?._planFoodEnabled != null) {
    const foodKey = 'food';
    const orig = shared[foodKey] || 0;
    const cap  = Math.min(ui._planFoodEnabled, orig);
    shared[foodKey] = cap;
    // Restore any uncapped food after resolution completes (handled below).
    var _foodOverage = orig - cap;
  }

  let steps;
  try {
    steps = resolvePlans(state, state.heroPlan, state.witchPlan);
  } catch (err) {
    console.error('resolvePlans error:', err);
    steps = [];
  }

  // Restore food that wasn't committed.
  if (shared && _foodOverage > 0) {
    const foodKey = 'food';
    shared[foodKey] = (shared[foodKey] || 0) + _foodOverage;
  }

  // resolvePlans has fully mutated state to its final configuration.
  // Hold a reference to the final entity array so we can restore it after animation.
  const finalEntities = state.entities;

  const humanFaction = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : null;
  const preReplayEntities = steps[0]?.entitySnapshot ?? finalEntities;

  // Snapshot node control BEFORE resolution so we can detect changes from unit movement
  const preResEntities = steps[0]?.entitySnapshot ?? state.entities;
  const prevNodes = state.witchObjectives.map(obj => {
    const holder = preResEntities.find(e => e.alive && e.col === obj.col && e.row === obj.row);
    return { col: obj.col, row: obj.row, label: obj.label, owner: holder?.owner ?? null };
  });

  await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction, null);

  // Add aggregate battle summary to the log before endRound inserts phase entries
  const summaryLines = compileTurnBattleSummary(steps, state.entities, ResEventType, PlanActionType);
  for (const line of summaryLines) state.log.push(line);
  if (summaryLines.length && ui) ui._renderLog();

  // Snapshot score BEFORE endRound so we can detect scoring changes
  const prevScore = { hero: state.nodeScore.hero, witch: state.nodeScore.witch };

  state.endRound();
  if (ui) ui._triggerHazardFlashes();
  redraw();

  // Persist single-player progress to localStorage
  _saveSpGame();

  // Show post-resolution summary modal (skip in autoplay mode)
  if (!_autoplay && ui && humanFaction) {
    let action;
    do {
      action = await ui._showResolutionSummary(steps, state.round - 1, {
        prevScore, prevNodes, humanFaction, fogOfWar: state.fogOfWar,
        gameOver: state.gameOver, winner: state.winner, winReason: state.winReason,
      });
      if (action === 'replay') {
        state.entities = preReplayEntities;
        redraw();
        await _animateResolutionSteps(steps, finalEntities, redraw, humanFaction, null);
      }
    } while (action === 'replay');
    // Animate score bar changes after summary is dismissed
    ui._animateScoreBar(prevScore, prevNodes);

    if (state.gameOver) {
      if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
      if (action === 'viewmap') {
        // Lift fog so the player can inspect the final board
        state.fogOfWar = false;
        redraw();
      } else if (action === 'restart') {
        _doRestart();
      }
      return;
    }
  } else if (state.gameOver && ui) {
    // Autoplay game-over — still show the summary so the user sees the result
    if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
    let action;
    do {
      action = await ui._showResolutionSummary(steps, state.round - 1, {
        prevScore, prevNodes, humanFaction: null, fogOfWar: false,
        gameOver: true, winner: state.winner, winReason: state.winReason,
      });
      if (action === 'replay') {
        state.entities = preReplayEntities;
        redraw();
        await _animateResolutionSteps(steps, finalEntities, redraw, null, null);
      }
    } while (action === 'replay');
    if (action === 'viewmap') {
      state.fogOfWar = false;
      redraw();
    } else if (action === 'restart') {
      _doRestart();
    }
    return;
  } else if (state.gameOver) {
    // No UI (headless) — just clean up
    if (_spSaveId) { _deleteSpSave(_spSaveId); _spSaveId = null; }
    return;
  }

  if (_autoplay) {
    await _delay(300);
  }
  _startLocalPlanningPhase();
}

/**
 * Fire the visual result animations that follow a battle (HP floaters, death burst).
 * Uses result.damage / result.counterDmg directly so that simultaneous battles in
 * the same step each show only their own damage, not accumulated step damage.
 */
function _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn) {
  renderer.addAttackAnim(actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row);
  if (result?.damage)     renderer.addHpChangeFlash(targetSnap.col, targetSnap.row, -(result.damage));
  if (result?.counterDmg) renderer.addHpChangeFlash(actorSnap.col,  actorSnap.row,  -(result.counterDmg));
  if (result?.killed) {
    const deadColor = targetSnap.owner === 'hero' ? '#d4a72c' : '#9b59b6';
    renderer.addDeathAnim(targetSnap.col, targetSnap.row, deadColor);
  }
  redrawFn();
}

/**
 * Find entities adjacent to a battle that provide gang-up or ally-defence bonuses.
 * Returns the entities (with .col/.row) so the caller can build hex lists.
 */
function _getBattleAllyEntities(actorSnap, targetSnap, entities) {
  return entities.filter(e => {
    if (!e.alive) return false;
    if (e.id === actorSnap.id || e.id === targetSnap.id) return false;
    // Attacker-side ally adjacent to the target (gang-up)
    if (e.owner === actorSnap.owner &&
        hexDistance(e.col, e.row, targetSnap.col, targetSnap.row) <= 1) return true;
    // Defender-side ally adjacent to the attacker (defensive support)
    if (e.owner === targetSnap.owner &&
        hexDistance(e.col, e.row, actorSnap.col, actorSnap.row) <= 1) return true;
    return false;
  });
}

/**
 * Animate a resolution step array.
 *
 * Each step record carries an `entitySnapshot` taken before that step ran.
 * For each step we:
 *   1. Set state.entities to the POST-step snapshot (next step's pre-snapshot, or
 *      finalEntities for the last step).  This is the "landing" state.
 *   2. Fire addMoveAnim for every MOVE in this step, using the pre-step snapshot as
 *      the FROM position and the action target as the TO position.
 *      The entity is hidden from the static draw while animating; when the anim
 *      expires it falls back to state.entities which is already at the destination.
 *      → no more "flicker to final position" artefact.
 *   3. Await the slide duration, then process dialogs.
 *
 * finalEntities: real post-resolution entity array (restored after all steps).
 * humanFaction:  if set, suppress opponent-only battle/explore dialogs.
 */
async function _animateResolutionSteps(steps, finalEntities, redrawFn, humanFaction = null, myPlayerId = null) {
  _resolving = true;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // Post-step entities: what the world looks like AFTER this step resolves.
    const postEntities = i + 1 < steps.length ? steps[i + 1].entitySnapshot : finalEntities;

    // Support both legacy {heroEvents, witchEvents} (offline) and
    // new {playerEvents: [{playerId, faction, events}]} (online MP) step formats.
    const allStepEvents = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    const events = allStepEvents.filter(ev => ev.type === ResEventType.ACTION_OK);

    // ── Frame camera on this step's actors ──────────────────────────────────
    if (!_autoplay) {
      const _cspd = ui?.speedMode ?? 'cinematic';
      if (_cspd !== 'instant') {
        const frameTargets = [];
        for (const ev of events) {
          const snap = step.entitySnapshot?.find(e => e.id === ev.action?.entityId);
          const isOpponent = humanFaction && ev.faction !== humanFaction;
          if (snap && !(isOpponent && state.fogOfWar)) {
            // For moves, frame the destination; for others, frame the actor's current position
            if (ev.action.type === PlanActionType.MOVE) {
              frameTargets.push({ col: ev.action.toCol, row: ev.action.toRow });
            } else {
              frameTargets.push({ col: snap.col, row: snap.row });
            }
            // For battles, also frame the target
            if ((ev.action.type === PlanActionType.BATTLE_UNIT || ev.action.type === PlanActionType.BATTLE_HEX) && ev.battleSnaps?.targetSnap) {
              frameTargets.push({ col: ev.battleSnaps.targetSnap.col, row: ev.battleSnaps.targetSnap.row });
            }
          }
        }
        if (frameTargets.length) {
          renderer.frameHexes(frameTargets, { paddingHexes: 3.0, maxZoom: 2.0, duration: 250 });
          await _delay(_cspd === 'fast' ? 100 : 280);
        }
      }
    }

    // ── Phase 0: food consumed floaters ──────────────────────────────────────
    for (const ev of allStepEvents.filter(e => e.type === ResEventType.FOOD_CONSUMED)) {
      if (humanFaction && ev.faction !== humanFaction) continue;
      // Find the action that consumed the food — show the floater over the acting
      // unit, not the hero.
      const actionEv = allStepEvents.find(
        e => e.type === ResEventType.ACTION_OK && e.faction === ev.faction,
      );
      const actorSnap = actionEv
        ? step.entitySnapshot?.find(e => e.id === actionEv.action.entityId)
        : null;
      if (actorSnap) {
        renderer.addFlash(actorSnap.col, actorSnap.row, '-1\u00a0🍞', 'rgba(200,140,40,0.1)', 1600, 0.72, '#e8c84a');
        redrawFn();
      }
    }

    // ── Phase 1: animate moves for both factions simultaneously ──────────────
    // Multi-hex moves (horse or road chains) animate hop-by-hop using result.path.
    let hadMove = false;
    const pendingDialogs = [];

    // Collect pre-step snapshots and paths for all move events
    const moveAnims = [];
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.MOVE) continue;

      const preSnap = step.entitySnapshot?.find(e => e.id === action.entityId);
      const isOpponent = humanFaction && ev.faction !== humanFaction;
      const visible = preSnap && !(isOpponent && state.fogOfWar);

      // Use result.path if available (new path-following move); fall back to single hop
      const path = result?.path?.length > 0
        ? result.path
        : [{ col: action.toCol, row: action.toRow }];

      if (visible) moveAnims.push({ ev, preSnap, path });

      if ((!humanFaction || ev.faction === humanFaction) && result?.encounterLog?.length) {
        if (!myPlayerId || preSnap?.ownerId === myPlayerId) {
          pendingDialogs.push({ log: result.encounterLog, encounterUnit: result.encounterSurvivor ?? null });
        }
      }
    }

    // Build display entity array starting from the snapshot
    const displayEntities = step.entitySnapshot.map(e => ({ ...e }));

    if (moveAnims.length > 0) {
      hadMove = true;
      const _spd = ui?.speedMode ?? 'cinematic';
      const hopDelay = _spd === 'instant' ? 0 : _spd === 'fast' ? 120 : 320;

      // Determine max hops across all moving entities
      const maxHops = moveAnims.reduce((m, a) => Math.max(m, a.path.length), 0);

      for (let hop = 0; hop < maxHops; hop++) {
        // Start animations for all entities at this hop index
        for (const { ev, preSnap, path } of moveAnims) {
          if (hop >= path.length) continue;
          const fromPos = hop === 0 ? preSnap : path[hop - 1];
          const toPos   = path[hop];
          renderer.addMoveAnim(
            ev.action.entityId,
            fromPos.col, fromPos.row,
            toPos.col, toPos.row,
            preSnap.type, preSnap.owner,
            preSnap.title ?? null,
          );
          // Patch display entity to current hop destination
          const ent = displayEntities.find(e => e.id === ev.action.entityId);
          if (ent) { ent.col = toPos.col; ent.row = toPos.row; }
        }
        state.entities = displayEntities;
        redrawFn();
        if (!_autoplay && hopDelay > 0) await _delay(hopDelay);
      }
    } else {
      // No visible moves — still need to patch display entities to final positions
      for (const ev of events) {
        if (ev.action.type !== PlanActionType.MOVE) continue;
        const path = ev.result?.path;
        const finalPos = path?.length > 0 ? path[path.length - 1] : { col: ev.action.toCol, row: ev.action.toRow };
        const ent = displayEntities.find(e => e.id === ev.action.entityId);
        if (ent) { ent.col = finalPos.col; ent.row = finalPos.row; }
      }
      state.entities = displayEntities;
      redrawFn();
    }

    for (const entry of pendingDialogs) {
      redrawFn();
      if (entry.encounterUnit) {
        await new Promise(resolve => ui._showEncounterDialog(entry.encounterUnit, resolve));
      } else {
        await new Promise(resolve => ui._showResultDialog(entry.log, resolve));
      }
    }

    // ── Phase 2: battles and summons ──────────────────────────────────────────
    let hadBattle = false;
    for (const ev of events) {
      const { action, result, battleSnaps } = ev;
      if (action.type === PlanActionType.BATTLE_UNIT || action.type === PlanActionType.BATTLE_HEX) {
        // Show animation/dialog if one of my own units is involved (team MP), or falling
        // back to faction-level logic (offline / fog-off / standard 1v1).
        const myUnit = myPlayerId && battleSnaps && (
          battleSnaps.actorSnap?.ownerId  === myPlayerId ||
          battleSnaps.targetSnap?.ownerId === myPlayerId
        );
        const showForPlayer = myPlayerId
          ? myUnit
          : (!humanFaction || !state.fogOfWar || ev.faction === humanFaction
              || (battleSnaps && (
                   battleSnaps.targetSnap?.owner === humanFaction ||
                   battleSnaps.actorSnap?.owner  === humanFaction
                 )));
        if (battleSnaps && showForPlayer) {
          const { actorSnap, targetSnap } = battleSnaps;
          const isKill = !!result?.killed;

          if (!_autoplay) {
            const speed = ui?.speedMode ?? 'cinematic';

            // ── Step 1: Lunge — attacker slides toward target border ──────────
            // Cinematic and fast both lunge; instant skips the visual.
            // Use current display position for both ends: if the target (or
            // actor) also has a MOVE in this same step, displayEntities already
            // has it at the post-move hex, so the lunge must chase that position
            // rather than the pre-move battleSnap coordinates.
            const actorDisplay  = state.entities.find(e => e.id === actorSnap.id);
            const targetDisplay = state.entities.find(e => e.id === targetSnap.id);
            const lungeFromCol = actorDisplay?.col  ?? actorSnap.col;
            const lungeFromRow = actorDisplay?.row  ?? actorSnap.row;
            const lungeToCol   = targetDisplay?.col ?? targetSnap.col;
            const lungeToRow   = targetDisplay?.row ?? targetSnap.row;
            if (speed !== 'instant') {
              renderer.addLungeAnim(
                actorSnap.id,
                lungeFromCol, lungeFromRow,
                lungeToCol, lungeToRow,
                actorSnap.type, actorSnap.owner, actorSnap.title ?? null,
              );
              redrawFn();
              await _delay(speed === 'fast' ? 150 : 280);
            }

            // ── Step 2: Battle hex highlights ────────────────────────────────
            if (speed !== 'instant') {
              const allyEntities = _getBattleAllyEntities(actorSnap, targetSnap, state.entities);
              renderer.setBattleHighlights(
                [{ col: lungeFromCol, row: lungeFromRow }, { col: lungeToCol, row: lungeToRow }],
                allyEntities.map(e => ({ col: e.col, row: e.row })),
              );
              redrawFn();
            }

            // ── Step 3: Dialog (cinematic) or toast+floater (fast) ───────────
            if (speed === 'cinematic') {
              // Full dialog for every battle — no significance filter.
              // Offset camera so the map is visible beside the docked dialog.
              const prevInsetRight = renderer.insetRight ?? 0;
              renderer.insetRight = 500;
              renderer.frameHexes(
                [{ col: actorSnap.col, row: actorSnap.row }, { col: targetSnap.col, row: targetSnap.row }],
                { paddingHexes: 2.5, maxZoom: 2.0, duration: 200 },
              );
              // Wait for dialog dismiss, THEN play floaters so nothing overlaps.
              await new Promise(resolve => {
                ui._showBattleDialog(actorSnap, targetSnap, result, resolve);
              });
              renderer.insetRight = prevInsetRight;
              _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
              // Drain all floaters (HP text 1800ms, death burst 600ms) before next battle.
              await renderer.waitForAnimations();
            } else if (speed === 'fast') {
              // On a miss (no damage to target) show a randomised flavour word;
              // hits are already communicated by the red HP-change floater.
              if (!result.hit) {
                const _MISS_TEXT = ['miss', 'dodged', 'blocked', 'parried', 'deflected'];
                const missText = _MISS_TEXT[Math.floor(Math.random() * _MISS_TEXT.length)];
                renderer.addFlash(targetSnap.col, targetSnap.row, missText, 'rgba(100,100,100,0.1)', 1000, 0.65, '#888');
              }
              _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
              // Short fixed wait — floaters from different battles can overlap in fast mode.
              await _delay(400);
            } else {
              // Instant — result animations only, no wait.
              _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
            }

            // ── Step 4: Clear highlights, animate lunge return ───────────────
            renderer.clearBattleHighlights();
            renderer.returnAllLungeAnims(); // slide entity back rather than snap
            if (speed === 'cinematic') await renderer.waitForAnimations();
            redrawFn();

          } else {
            // Autoplay: fire all animations immediately without dialogs or lunge.
            _playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
          }
          hadBattle = true;
        }
      } else if (action.type === PlanActionType.SUMMON) {
        renderer.addSpawnAnim(action.toCol, action.toRow, '#b39ddb');
        hadBattle = true;
      }
    }

    // ── Phase 3: explore results — only this player's own entities ───────────
    // In team MP each player owns a subset of their faction's units via ownerId.
    // Only show dialogs for entities this player directly controls; other players'
    // units on the same team resolve silently.
    // In offline/solo mode myPlayerId is null so we fall back to faction filtering.
    for (const ev of events) {
      const { action, result } = ev;
      if (action.type !== PlanActionType.EXPLORE) continue;
      if (!result?.log?.length) continue;
      if (humanFaction && ev.faction !== humanFaction) continue;
      const actor = step.entitySnapshot?.find(e => e.id === action.entityId);
      if (myPlayerId && actor?.ownerId !== myPlayerId) continue;
      if (actor) ui._showLootFlashes(actor, result.lootItems ?? []);
      redrawFn();
    }

    // Apply the full post-step entity state now that all dialogs for this step
    // have been shown.  This reveals HP changes, deaths, and new encounter
    // entities only after the player has seen the relevant dialog/animation.
    // Snapshot node control BEFORE applying post-step entities so we can detect captures this step.
    const preStepNodeOwners = state.witchObjectives?.map(obj => {
      const holder = step.entitySnapshot?.find(e => e.alive && e.col === obj.col && e.row === obj.row);
      return holder?.owner ?? null;
    });

    state.entities = postEntities;
    redrawFn();

    // Animate node dot changes that happened this step (real-time capture feedback)
    if (ui && state.witchObjectives && preStepNodeOwners) {
      ui._renderObjectives();
      const barEl = document.getElementById('score-bar-content');
      if (barEl) {
        const dots = barEl.querySelectorAll('.node-dot');
        let hadNodeChange = false;
        preStepNodeOwners.forEach((prevOwner, idx) => {
          if (idx >= dots.length) return;
          const obj = state.witchObjectives[idx];
          const postHolder = postEntities.find(e => e.alive && e.col === obj.col && e.row === obj.row);
          const postOwner = postHolder?.owner ?? null;
          if (postOwner !== prevOwner) {
            dots[idx].classList.add('node-dot-glow');
            hadNodeChange = true;
          }
        });
        if (hadNodeChange) {
          setTimeout(() => {
            dots.forEach(d => d.classList.remove('node-dot-glow'));
          }, 2000);
        }
      }
    }

    if (hadMove || hadBattle) {
      if (!_autoplay) {
        const _spd2 = ui?.speedMode ?? 'cinematic';
        if (_spd2 !== 'instant') await _delay(_spd2 === 'fast' ? 80 : hadMove ? 300 : 250);
      }
    } else if (events.length > 0 && !_autoplay) {
      // Non-visual actions (fortify, use_item, etc.) — brief pause so resolution feels deliberate.
      const _spd3 = ui?.speedMode ?? 'cinematic';
      if (_spd3 !== 'instant') await _delay(_spd3 === 'fast' ? 50 : 150);
    }
  }

  // Restore the authoritative final state and do one last draw.
  state.entities = finalEntities;
  redrawFn();
  _resolving = false;
}

function _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }


// ── Online game init ──────────────────────────────────────────────────────────

let mp = null; // MultiplayerClient instance

function initOnline(mirrorState, myFaction, mpClient) {
  state    = mirrorState;
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  renderer = new Renderer(canvas, state);
  renderer.resize();
  renderer.loadImages();

  // No local AI — all turns handled server-side
  ui = new UIController(canvas, state, renderer, null, redrawOnline, null, false);
  ui.onQuitToMenu = () => location.reload();
  ui.mp         = mpClient;
  ui.myPlayerId = mpClient.myPlayerId ?? null;
  ui._players   = state.players ?? [];

  redrawOnline();

  requestAnimationFrame(() => {
    // Resize now that game-screen layout is complete and canvas has real dimensions.
    renderer.resize();
    // Frame the human player's starting units (matches local mode init behaviour).
    const myUnits = state.entities.filter(e => e.alive && e.owner === mp.myFaction);
    if (myUnits.length > 0) {
      renderer.frameHexes(myUnits, { maxZoom: 1.8, paddingHexes: 2.5, duration: 0 });
    }
    redrawOnline();
  });
}

function redrawOnline() {
  if (!renderer) return;
  renderer.draw();
  if (ui) ui._updateSidebar?.();
}

// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  if (!renderer) return;
  renderer.resize();
  redraw();
});

// ── Setup screen ──────────────────────────────────────────────────────────────

const stepMode         = document.getElementById('setup-step-mode');
const stepSinglePlayer = document.getElementById('setup-step-singleplayer');
const stepMultiplayer  = document.getElementById('setup-step-multiplayer');
const stepHowto        = document.getElementById('setup-step-howtoplay');
const stepOptions      = document.getElementById('setup-step-options');
const stepWaiting      = document.getElementById('setup-step-waiting');
const stepCreateGame   = document.getElementById('setup-step-create-game');
const stepJoinGame     = document.getElementById('setup-step-join-game');
const stepLobby        = document.getElementById('setup-step-lobby');

function showStep(step) {
  stepMode        .style.display = step === 'mode'          ? '' : 'none';
  stepSinglePlayer.style.display = step === 'singleplayer'  ? '' : 'none';
  stepMultiplayer .style.display = step === 'multiplayer'   ? '' : 'none';
  stepHowto       .style.display = step === 'howtoplay'     ? '' : 'none';
  stepOptions     .style.display = step === 'options'       ? '' : 'none';
  stepWaiting     .style.display = step === 'waiting'       ? '' : 'none';
  stepCreateGame  .style.display = step === 'create-game'   ? '' : 'none';
  stepJoinGame    .style.display = step === 'join-game'     ? '' : 'none';
  stepLobby       .style.display = step === 'lobby'         ? '' : 'none';
}

// Current lobby state (pre-game)
let _currentLobby = null;

// ── Welcome screen buttons ────────────────────────────────────────────────────

document.getElementById('btn-single-player').addEventListener('click', () => _showSinglePlayerScreen());
document.getElementById('btn-multiplayer')  .addEventListener('click', () => _showMultiplayerScreen());
document.getElementById('btn-how-to-play')  .addEventListener('click', () => showStep('howtoplay'));
document.getElementById('btn-options')      .addEventListener('click', () => showStep('options'));
document.getElementById('btn-howtoplay-back').addEventListener('click', () => showStep('mode'));
document.getElementById('btn-options-back') .addEventListener('click', () => showStep('mode'));

// ── Single Player screen ───────────────────────────────────────────────────────

function _showSinglePlayerScreen() {
  showStep('singleplayer');
  _renderSpSaves();
}

document.getElementById('btn-singleplayer-back').addEventListener('click', () => {
  renderer = null; ui = null; state = null;
  showStep('mode');
});

// Player mode radio changes (vs AI / Two Players / AI vs AI)
document.querySelectorAll('input[name="player-mode"]').forEach(r => {
  r.addEventListener('change', _onPlayerModeChange);
});
function _onPlayerModeChange() {
  const mode = document.querySelector('input[name="player-mode"]:checked')?.value;
  document.getElementById('side-selection') .style.display = mode === 'vs-ai' ? '' : 'none';
  document.getElementById('btn-start-wrap') .style.display = mode !== 'vs-ai' ? '' : 'none';
}

document.getElementById('btn-play-hero') .addEventListener('click', () => init(true,  false));
document.getElementById('btn-play-witch').addEventListener('click', () => init(false, true));

document.getElementById('btn-start-local').addEventListener('click', () => {
  const mode = document.querySelector('input[name="player-mode"]:checked')?.value;
  if (mode === 'two-players') init(false, false);
  else if (mode === 'autoplay') init(true, true, true);
});

function _doRestart() {
  // Disconnect from server if in online mode
  if (mp) { mp.disconnect(); mp = null; }

  // Reset game objects so initOnline / init start fresh
  renderer = null;
  ui       = null;
  state    = null;
  witchAI  = null;
  heroAI   = null;

  if (_autoplay) {
    init(true, true, true);
  } else {
    showStep('mode');
    document.getElementById('setup-screen').style.display = 'flex';
    document.getElementById('game-screen').style.display  = 'none';
  }
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Single-player localStorage saves ─────────────────────────────────────────

const _SP_SAVE_KEY = 'brimstone_sp_saves';

function _loadSpSaves() {
  try {
    return JSON.parse(localStorage.getItem(_SP_SAVE_KEY) || '[]');
  } catch { return []; }
}

function _saveSpSaves(saves) {
  try { localStorage.setItem(_SP_SAVE_KEY, JSON.stringify(saves)); } catch {}
}

/** Persist the current single-player game state to localStorage. */
function _saveSpGame() {
  if (!state || state.gameOver || _autoplay) return;
  const saves = _loadSpSaves();
  const existing = saves.findIndex(s => s.id === _spSaveId);
  const mode = !state.heroIsAI ? 'hero' : !state.witchIsAI ? 'witch' : 'two-players';
  const serialized = serializeState(state);
  const entry = {
    id:         _spSaveId,
    mode,
    mapSize:    document.getElementById('select-map-size')?.value ?? 'standard',
    fog:        state.fogOfWar,
    round:      state.round,
    phase:      state.phase,
    updatedAt:  Math.floor(Date.now() / 1000),
    startedAt:  existing >= 0 ? saves[existing].startedAt : Math.floor(Date.now() / 1000),
    state:      serialized,
  };
  if (existing >= 0) saves[existing] = entry;
  else saves.unshift(entry);
  // Keep at most 10 saves
  _saveSpSaves(saves.slice(0, 10));
}

/** Delete a single-player save. */
function _deleteSpSave(id) {
  const saves = _loadSpSaves().filter(s => s.id !== id);
  _saveSpSaves(saves);
}

/** Render the in-progress saves list on the Single Player screen. */
function _renderSpSaves() {
  const list = document.getElementById('sp-saves-list');
  if (!list) return;
  const saves = _loadSpSaves();
  if (!saves.length) {
    list.innerHTML = '<p class="saves-empty">No saved games.</p>';
    return;
  }
  list.innerHTML = '';
  const modeLabels = { hero: '⚔ vs AI (Hero)', witch: '✦ vs AI (Witch)', 'two-players': '👥 Two Players' };
  const phaseLabel = { dawn: '🌅 Dawn', day: '☀ Day', dusk: '🌇 Dusk', night: '🌙 Night' };
  for (const s of saves) {
    const ago = _timeAgo(s.updatedAt);
    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${modeLabels[s.mode] ?? s.mode}</div>
        <div class="save-entry-meta">Round ${s.round} · ${phaseLabel[s.phase] ?? s.phase} · ${_esc(s.mapSize)} · ${ago}</div>
      </div>
      <div style="display:flex;gap:0.4rem">
        <button class="setup-btn primary sp-resume-btn">Resume</button>
        <button class="setup-btn sp-delete-btn" title="Delete save">✕</button>
      </div>
    `;
    entry.querySelector('.sp-resume-btn').addEventListener('click', () => _resumeSpSave(s));
    entry.querySelector('.sp-delete-btn').addEventListener('click', () => {
      _deleteSpSave(s.id);
      _renderSpSaves();
    });
    list.appendChild(entry);
  }
}

let _spSaveId = null;

/** Resume a single-player game from localStorage. */
function _resumeSpSave(save) {
  _spSaveId = save.id;
  const deserialized = deserializeState(save.state);
  _startFromState(deserialized, save.mode);
}

/** Start a game from an existing deserialized state (used by SP resume). */
function _startFromState(existingState, mode) {
  _autoplay = false;
  const canvas = document.getElementById('game-canvas');

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  state   = existingState;
  witchAI = state.witchIsAI ? new WitchAI(state, redraw) : null;
  heroAI  = state.heroIsAI  ? new HeroAI(state, redraw)  : null;

  _setupLocalUI(canvas, witchAI, heroAI, false);

  redraw();

  requestAnimationFrame(() => {
    renderer.resize();
    redraw();
  });

  _startLocalPlanningPhase();
}

// ── Active games (inline in New Game screen) ──────────────────────────────────

function _fetchActiveSaves() {
  const list = document.getElementById('active-games-list');
  if (!list) return;
  list.innerHTML = '<p class="saves-empty">Loading…</p>';

  const session = loadSession();
  if (!session) {
    list.innerHTML = '<p class="saves-empty">Sign in to see your active games.</p>';
    return;
  }

  const base = window.BRIMSTONE_SERVER || '';
  fetch(`${base}/api/saves?token=${encodeURIComponent(session.token)}`)
    .then(r => r.json())
    .then(saves => _renderSaves(saves))
    .catch(() => {
      list.innerHTML = '<p class="saves-empty">Could not load saves (offline?).</p>';
    });
}

function _renderSaves(saves) {
  const list = document.getElementById('active-games-list');
  const session = loadSession();

  if (!saves.length) {
    list.innerHTML = '<p class="saves-empty">No games in progress.</p>';
    return;
  }

  list.innerHTML = '';
  for (const s of saves) {
    const myFaction  = s.hero_player_id  === session?.id ? 'hero' : 'witch';
    const oppName    = myFaction === 'hero' ? (s.witch_name || 'Witch') : (s.hero_name || 'Hero');
    const factionSymbol = myFaction === 'hero' ? '⚔' : '✦';
    const phaseLabel = { dawn: '🌅 Dawn', day: '☀ Day', dusk: '🌇 Dusk', night: '🌙 Night' }[s.phase] ?? s.phase;
    const ago        = _timeAgo(s.updated_at);

    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">${factionSymbol} vs ${_esc(oppName)}</div>
        <div class="save-entry-meta">Round ${s.round} · ${phaseLabel} · saved ${ago}</div>
      </div>
      <button class="setup-btn primary">Resume</button>
    `;
    entry.querySelector('button').addEventListener('click', () => _resumeSave(s.room_id));
    list.appendChild(entry);
  }
}

function _resumeSave(roomId) {
  _ensureAuthed(() => {
    showStep('waiting');
    document.getElementById('waiting-subtitle').textContent = 'Resuming game…';
    document.getElementById('waiting-message').textContent  = 'Restoring your saved game…';
    mp.resumeSave(roomId);
  });
}

function _timeAgo(unixSecs) {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Multiplayer screen ────────────────────────────────────────────────────────

function _showMultiplayerScreen() {
  showStep('multiplayer');
  _initMpStep();
  const session = loadSession();
  if (session) _fetchActiveSaves();
}

document.getElementById('btn-multiplayer-back').addEventListener('click', () => {
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
  showStep('mode');
});

// ── Online flow ───────────────────────────────────────────────────────────────

document.getElementById('btn-cancel-wait').addEventListener('click', () => {
  showStep('multiplayer');
  _initMpStep();
});

function _fogChecked() {
  return document.getElementById('chk-fog-of-war')?.checked ?? true;
}

// ── Create Game flow ──────────────────────────────────────────────────────────

document.getElementById('btn-create-game').addEventListener('click', () => {
  _ensureAuthed(() => showStep('create-game'));
});

document.getElementById('btn-create-game-back').addEventListener('click', () => {
  showStep('multiplayer');
});

document.getElementById('btn-create-game-confirm').addEventListener('click', () => {
  _ensureAuthed(() => {
    const config = {
      fog:           document.getElementById('cg-fog').checked,
      mapSize:       document.getElementById('cg-map-size').value,
      playersPerSide: parseInt(document.querySelector('input[name="cg-pps"]:checked')?.value ?? '1', 10),
      isPrivate:     document.getElementById('cg-private').checked,
    };
    mp.createLobby(config);
    // Transition to lobby card happens in onLobbyJoined callback
  });
});

// ── Join Game flow ────────────────────────────────────────────────────────────

document.getElementById('btn-join-game').addEventListener('click', () => {
  _ensureAuthed(() => {
    showStep('join-game');
    _loadPublicLobbies();
  });
});

document.getElementById('btn-join-game-back').addEventListener('click', () => {
  showStep('multiplayer');
});

document.getElementById('btn-join-private').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  const err  = document.getElementById('join-game-error');
  if (code.length !== 6) {
    err.textContent = 'Enter a 6-letter room code.';
    err.style.display = '';
    return;
  }
  err.style.display = 'none';
  _ensureAuthed(() => mp.joinLobby(code));
});

function _loadPublicLobbies() {
  if (!mp) return;
  document.getElementById('public-lobbies-list').innerHTML =
    '<p class="saves-empty">Loading…</p>';
  mp.browseLobby();
}

function _renderPublicLobbies(rooms) {
  const list = document.getElementById('public-lobbies-list');
  if (!list) return;
  if (!rooms?.length) {
    list.innerHTML = '<p class="saves-empty">No open games right now.</p>';
    return;
  }
  list.innerHTML = '';
  for (const lobby of rooms) {
    const pps    = lobby.config?.playersPerSide ?? 1;
    const size   = lobby.config?.mapSize ?? 'standard';
    const fog    = lobby.config?.fog !== false ? 'Fog' : 'No Fog';
    const open   = lobby.slots?.filter(s => s.status === 'empty').length ?? 0;
    const total  = lobby.slots?.length ?? pps * 2;
    const host   = lobby.slots?.find(s => s.playerId === lobby.hostPlayerId)?.name ?? 'Unknown';

    const entry = document.createElement('div');
    entry.className = 'save-entry';
    entry.innerHTML = `
      <div class="save-entry-info">
        <div class="save-entry-title">⚔ ${_esc(host)}'s game</div>
        <div class="save-entry-meta">${pps}v${pps} · ${_esc(size.charAt(0).toUpperCase() + size.slice(1))} · ${fog} · ${total - open}/${total} players</div>
      </div>
      <button class="setup-btn primary">Join</button>
    `;
    entry.querySelector('button').addEventListener('click', () => {
      _ensureAuthed(() => mp.joinLobby(lobby.id));
    });
    list.appendChild(entry);
  }
}

// ── Lobby card ────────────────────────────────────────────────────────────────

const _HERO_PERSONALITIES  = ['balanced', 'berserker', 'sentinel', 'scavenger'];
const _WITCH_PERSONALITIES = ['balanced', 'berserker', 'hoarder',  'swarm'];
const _PERSONALITY_LABELS  = {
  balanced: 'Balanced', berserker: 'Berserker', sentinel: 'Sentinel',
  scavenger: 'Scavenger', hoarder: 'Hoarder', swarm: 'Swarm',
};

function _renderLobby(lobby) {
  if (!lobby) return;
  _currentLobby = lobby;
  showStep('lobby');

  // Code display for private games
  const codeWrap = document.getElementById('lobby-code-wrap');
  const codeDisp = document.getElementById('lobby-code-display');
  if (lobby.isPrivate && lobby.code) {
    codeWrap.style.display = '';
    codeDisp.textContent   = lobby.code;
  } else {
    codeWrap.style.display = 'none';
  }

  // Config summary
  const pps  = lobby.config?.playersPerSide ?? 1;
  const size = lobby.config?.mapSize ?? 'standard';
  const fog  = lobby.config?.fog !== false ? 'Fog on' : 'No fog';
  document.getElementById('lobby-config-summary').textContent =
    `${pps}v${pps} · ${size.charAt(0).toUpperCase() + size.slice(1)} · ${fog}`;

  // Slots grid
  const myId    = mp?.player?.id;
  const isHost  = lobby.hostPlayerId === myId;
  const grid    = document.getElementById('lobby-slots-grid');
  grid.innerHTML = '';

  const heroSlots  = lobby.slots.filter(s => s.faction === 'hero');
  const witchSlots = lobby.slots.filter(s => s.faction === 'witch');

  const container = document.createElement('div');
  container.className = 'lobby-factions';

  for (const [label, icon, slots] of [['Hero Side', '⚔', heroSlots], ['Witch Side', '✦', witchSlots]]) {
    const col = document.createElement('div');
    col.className = 'lobby-faction-col';
    col.innerHTML = `<div class="lobby-faction-label">${icon} ${label}</div>`;

    for (const slot of slots) {
      const row = document.createElement('div');
      row.className = 'lobby-slot-row';

      if (slot.status === 'human') {
        const isMe = slot.playerId === myId;
        row.innerHTML = `<span class="lobby-slot-name">${_esc(slot.name)}${isMe ? ' <em>(you)</em>' : ''}</span>`;
      } else if (slot.status === 'ai') {
        const label = _PERSONALITY_LABELS[slot.personality] ?? 'Balanced';
        row.innerHTML = `<span class="lobby-slot-name ai-slot">🤖 ${_esc(slot.name ?? 'AI')}</span>`;
        if (isHost) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'setup-btn secondary lobby-slot-btn';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            mp.removeSlotAI(lobby.id, slot.seatIndex + (slot.faction === 'witch' ? pps : 0));
          });
          row.appendChild(removeBtn);
        }
      } else {
        // empty slot
        row.innerHTML = `<span class="lobby-slot-name empty-slot">Waiting…</span>`;
        if (isHost) {
          const personalities = slot.faction === 'witch' ? _WITCH_PERSONALITIES : _HERO_PERSONALITIES;
          const select = document.createElement('select');
          select.className = 'setup-select lobby-personality-select';
          select.innerHTML = '<option value="">— Assign AI —</option>' +
            ['random', ...personalities].map(p =>
              `<option value="${p}">${p === 'random' ? 'Random' : (_PERSONALITY_LABELS[p] ?? p)}</option>`
            ).join('');
          select.addEventListener('change', () => {
            if (!select.value) return;
            const idx = lobby.slots.indexOf(slot);
            mp.setSlotAI(lobby.id, idx, select.value);
            select.value = '';
          });
          row.appendChild(select);
        }
      }
      col.appendChild(row);
    }
    container.appendChild(col);
  }
  grid.appendChild(container);

  // Start button — enabled only for host when all slots filled
  const startBtn = document.getElementById('btn-lobby-start');
  const allFilled = lobby.slots.every(s => s.status !== 'empty');
  startBtn.disabled = !(isHost && allFilled);
}

document.getElementById('btn-lobby-populate-ai').addEventListener('click', () => {
  if (_currentLobby) mp.fillAllWithAI(_currentLobby.id, 'random');
});

document.getElementById('btn-lobby-start').addEventListener('click', () => {
  if (_currentLobby) mp.startGame(_currentLobby.id);
});

document.getElementById('btn-lobby-leave').addEventListener('click', () => {
  if (_currentLobby) {
    mp.leaveLobby(_currentLobby.id);
    _currentLobby = null;
  }
  showStep('multiplayer');
});

function _initMpStep() {
  const session     = loadSession();
  const sessionInfo = document.getElementById('mp-session-info');
  const nameForm    = document.getElementById('mp-name-form');
  const actionBtns  = document.getElementById('mp-action-buttons');

  if (session) {
    document.getElementById('mp-session-name').textContent = session.username;
    sessionInfo.style.display = '';
    nameForm.style.display    = 'none';
    actionBtns.style.display  = '';
  } else {
    sessionInfo.style.display = 'none';
    nameForm.style.display    = '';
    actionBtns.style.display  = 'none';
  }

  document.getElementById('mp-name-error').style.display = 'none';
}

document.getElementById('btn-mp-signin').addEventListener('click', () => {
  _ensureAuthed(() => {
    _initMpStep();
    _fetchActiveSaves();
  });
});

document.getElementById('btn-mp-change-name').addEventListener('click', () => {
  clearSession();
  document.getElementById('mp-session-info').style.display = 'none';
  document.getElementById('mp-name-form').style.display    = '';
  document.getElementById('mp-action-buttons').style.display = 'none';
  document.getElementById('active-games-list').innerHTML =
    '<p class="saves-empty">Sign in to see your active games.</p>';
  if (mp) { mp.disconnect(); mp = null; }
  renderer = null; ui = null; state = null;
});

function _onlineError(msg) {
  const el = document.getElementById('mp-name-error');
  el.textContent    = msg;
  el.style.display  = '';
}

/** Ensure we have an authenticated MultiplayerClient, then call cb(). */
function _ensureAuthed(cb) {
  const nameInput = document.getElementById('mp-username');
  const session   = loadSession();
  const wsUrl     = _serverWsUrl();

  // Create fresh client if needed, or reconnect a dropped one
  if (!mp) {
    mp = _createMpClient();
    mp.connect(wsUrl);
  } else if (!mp.connected) {
    // Stale connection — reconnect
    mp.connect(wsUrl);
  }

  if (session && mp.player?.id === session.id && mp.connected) {
    // Already authenticated on a live connection
    cb();
    return;
  }

  // Authenticate first, then run cb
  mp._opts._onAuthOk = cb;
  if (session) {
    mp.auth({ token: session.token });
  } else {
    const username = nameInput.value.trim();
    if (username.length < 2) { _onlineError('Enter a username (2+ characters).'); return; }
    mp.auth({ username });
  }
}

function _applyOnlinePlanningPhase(payload) {
  if (!ui || !mp) return;
  const { myActionsLeft, heroActionsLeft, witchActionsLeft, players, timeoutMs } = payload;
  // Prefer per-player budget; fall back to legacy faction budget for old servers.
  const budget = myActionsLeft ?? (mp.myFaction === 'hero' ? heroActionsLeft : witchActionsLeft);
  ui.exitPlanningMode();
  if (players) ui._players = players;
  ui.enterPlanningMode(mp.myFaction, budget, timeoutMs ?? 0);
  ui.onPlanSubmit = (plan) => mp.submitPlan(plan);
}

function _serverWsUrl() {
  // Allow override via global (set by server when serving the page, for production)
  if (window.BRIMSTONE_WS) return window.BRIMSTONE_WS;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

function _createMpClient() {
  return new MultiplayerClient({
    onState(mirrorState) {
      if (!renderer || !ui) {
        // Game not started yet — any state update while active should start it
        if (mp?.active) {
          try {
            mirrorState.myFaction = mp.myFaction; // used by renderer for per-player fog
            initOnline(mirrorState, mp.myFaction, mp);
          } catch (err) {
            console.error('initOnline failed:', err);
            _onlineError(`Failed to start game: ${err.message}`);
            showStep('multiplayer');
            _initMpStep();
          }
        }
        return;
      }

      // Suppress mid-resolution state pushes — the animation owns state.entities right now.
      if (_resolving) return;

      // Already in game — update in-place (keeps renderer pan/zoom)

      // Snapshot entity positions before update so we can animate moves
      const oldPos = new Map();
      for (const e of state.entities) oldPos.set(e.id, { col: e.col, row: e.row });

      Object.assign(state, mirrorState);
      state.hero      = mirrorState.hero;
      state.witch     = mirrorState.witch;
      state.myFaction = mp.myFaction; // persist faction for per-player fog of war

      // Animate entities that changed hex position (opponent moves)
      if (!state.gameOver && renderer) {
        for (const e of state.entities) {
          const old = oldPos.get(e.id);
          if (old && (old.col !== e.col || old.row !== e.row)) {
            renderer.addMoveAnim(e.id, old.col, old.row, e.col, e.row, e.type, e.owner, e.title ?? null);
          }
        }
      }

      ui._clearSelection();
      ui._triggerHazardFlashes();
      redrawOnline();
      if (!state.gameOver) ui._maybeShowNoActionsDialog();
    },

    onBattle(actorSnap, targetSnap, result, afterDismiss) {
      // Flash attacker + defender hexes before showing the dialog
      if (renderer && state) {
        const actor  = state.entities.find(e => e.id === actorSnap.id);
        const target = state.entities.find(e => e.id === targetSnap.id);
        if (actor && target) {
          renderer.addAttackAnim(actor.col, actor.row, target.col, target.row);
          // HP-change floaters from pre/post snapshot comparison
          renderer.addHpChangeFlash(actor.col,  actor.row,  actor.hp  - actorSnap.hp);
          renderer.addHpChangeFlash(target.col, target.row, target.hp - targetSnap.hp);
        }
      }

      // Show "Battle Again" when it's our battle, the target survived, and
      // we have enough actions remaining after spending 1 on this battle.
      let onRematch = null;
      if (actorSnap.owner === mp?.myFaction && !result.killed) {
        const actorHpAfter   = actorSnap.hp - (result.counterDmg || 0);
        const actionsAfter   = (state?.actionsLeft ?? 0) - (result.cost ?? 1);
        if (actorHpAfter > 0 && actionsAfter > 0) {
          onRematch = () => {
            afterDismiss?.();   // apply state update first
            mp.sendAction('battle', { entityId: actorSnap.id, targetId: targetSnap.id });
          };
        }
      }

      if (ui) {
        ui._showBattleDialog(actorSnap, targetSnap, result, afterDismiss, onRematch);
      } else {
        afterDismiss?.();
      }
    },

    onLobbyJoined(lobby) {
      _renderLobby(lobby);
    },

    onLobbyUpdate(lobby) {
      _renderLobby(lobby);
    },

    onLobbyList(rooms) {
      _renderPublicLobbies(rooms);
    },

    onMatchFound({ roomId, faction, opponentName, aiOpponent, resumed, myPlayerId, players }) {
      // Show waiting card briefly during game start (covers both resume and lobby→game transitions)
      showStep('waiting');
      if (resumed) {
        document.getElementById('waiting-subtitle').textContent =
          `Resuming as ${faction === 'hero' ? 'Hero ⚔' : 'Witch ✦'}`;
        document.getElementById('waiting-message').textContent =
          `Restored! Starting game…`;
      } else {
        document.getElementById('waiting-subtitle').textContent =
          `Game starting as ${faction === 'hero' ? 'Hero ⚔' : 'Witch ✦'}`;
        document.getElementById('waiting-message').textContent =
          `Starting game…`;
      }
      _currentLobby = null;
      // Store player context so initOnline / enterPlanningMode can use it.
      if (ui) {
        if (myPlayerId) ui.myPlayerId = myPlayerId;
        if (players)   ui._players   = players;
      }
      // Game starts when first stateUpdate arrives → onState handles initOnline
    },

    onPlayerSubmitted({ playerId, name, faction }) {
      if (ui) ui._onPlayerSubmitted(playerId, name, faction);
    },

    onLeaderboard(_entries) {
      // Leaderboard removed — no-op
    },

    onInQueue(_position) {
      // Queue removed — no-op
    },

    onOpponentJoined(name) {
      // Lobby update handles this now — no-op
    },

    onOpponentDisconnected(graceMs) {
      const secs = Math.round(graceMs / 1000);
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = `⚠ Opponent disconnected — waiting ${secs}s for reconnect…`;
    },

    onOpponentReconnected() {
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = '';
    },

    onPlanningPhase(payload) {
      if (!ui || !mp) return;
      // If the resolution animation is still running, defer until it finishes.
      if (_resolving) {
        _pendingPlanningPhase = payload;
        return;
      }
      _applyOnlinePlanningPhase(payload);
    },

    onOpponentReady() {
      const statusEl = document.getElementById('plan-status');
      if (statusEl) statusEl.textContent = 'Opponent ready — waiting for resolution…';
    },

    onResolutionComplete({ steps, finalState }) {
      if (!ui || !renderer) return;
      state.resolving = true;   // flag before exitPlanningMode fires its redraw
      ui.exitPlanningMode();

      // Use the server's final entity list as the landing state for the animation.
      // This ensures state.entities is already correct when the last slide lands.
      const finalEntities = finalState.entities ?? state.entities;

      const _preReplayEntitiesOnline = steps[0]?.entitySnapshot ?? finalEntities;

      // Snapshot node control BEFORE resolution using pre-step entities
      const preResEntities = steps[0]?.entitySnapshot ?? state.entities;
      const prevNodes = (state.witchObjectives ?? []).map(obj => {
        const holder = preResEntities.find(e => e.alive && e.col === obj.col && e.row === obj.row);
        return { col: obj.col, row: obj.row, label: obj.label, owner: holder?.owner ?? null };
      });
      const prevScore = { hero: state.nodeScore?.hero ?? 0, witch: state.nodeScore?.witch ?? 0 };

      _animateResolutionSteps(steps, finalEntities, redrawOnline, mp?.myFaction, mp?.myPlayerId ?? null).then(async () => {
        // Apply full final state (phase, round, score, tiles, etc.) BEFORE summary
        // so the reckoning section can show scoring results.
        Object.assign(state, finalState);
        state.hero      = finalState.hero;
        state.witch     = finalState.witch;
        state.myFaction = mp?.myFaction;

        // Mirror the same post-resolution side effects as the local path.
        ui._triggerHazardFlashes();
        redrawOnline();

        // Show post-resolution summary modal for human players.
        // Keep _resolving = true for the whole summary+replay block so that any
        // incoming onPlanningPhase messages are buffered, not immediately applied.
        if (ui && mp?.myFaction) {
          _resolving = true;
          let action;
          do {
            action = await ui._showResolutionSummary(steps, (finalState.round ?? state.round) - 1, {
              prevScore, prevNodes, humanFaction: mp.myFaction, fogOfWar: state.fogOfWar,
              gameOver: state.gameOver, winner: state.winner, winReason: state.winReason,
            });
            if (action === 'replay') {
              state.entities = _preReplayEntitiesOnline;
              redrawOnline();
              await _animateResolutionSteps(steps, finalEntities, redrawOnline, mp.myFaction, mp.myPlayerId ?? null);
              // _animateResolutionSteps sets _resolving = false at end; re-engage
              // the guard so onPlanningPhase stays buffered during the next summary show.
              _resolving = true;
            }
          } while (action === 'replay');
          _resolving = false;
          // Animate score bar changes after summary is dismissed
          ui._animateScoreBar(prevScore, prevNodes);

          if (state.gameOver) {
            if (action === 'viewmap') {
              state.fogOfWar = false;
              redrawOnline();
            } else if (action === 'restart') {
              _doRestart();
            }
            return;
          }
        } else if (state.gameOver) {
          return;
        }

        if (!state.gameOver) {
          // Planning mode: never show "no actions" dialog here — a new planning
          // phase is always imminent. Apply any buffered planning phase immediately.
          if (_pendingPlanningPhase) {
            const payload = _pendingPlanningPhase;
            _pendingPlanningPhase = null;
            _applyOnlinePlanningPhase(payload);
          }
        }
      });
    },

    onError(msg) {
      // During auth phase, show error in the lobby
      if (!state || document.getElementById('setup-screen').style.display !== 'none') {
        _onlineError(msg);
        showStep('multiplayer');
        _initMpStep();
      } else {
        // In-game error — show as modal dialog
        if (ui) ui._showResultDialog([`⚠ ${msg}`]);
      }
    },

    // Internal hook for post-auth callback
    _onAuthOk: null,
  });
}

// Patch MultiplayerClient to handle auth callbacks and surface auth errors
const _origRoute = MultiplayerClient.prototype._route;
MultiplayerClient.prototype._route = function(msg) {
  _origRoute.call(this, msg);

  if (msg.type === 'authOk' && this._opts._onAuthOk) {
    const cb = this._opts._onAuthOk;
    this._opts._onAuthOk = null;
    cb();
  }

  if (msg.type === 'authError') {
    // Token no longer valid (e.g. server restarted) — clear session and
    // show the name-entry form so the error label inside it is visible.
    const expiredSession = loadSession();
    clearSession();
    if (mp) mp._player = null;
    document.getElementById('mp-session-info').style.display    = 'none';
    document.getElementById('mp-name-form').style.display       = '';
    document.getElementById('mp-action-buttons').style.display  = 'none';
    if (expiredSession?.username) {
      document.getElementById('mp-username').value = expiredSession.username;
    }
    showStep('multiplayer');
  }
};

// ── Spectator mode ────────────────────────────────────────────────────────────

function initSpectator(roomId) {
  document.body.classList.add('spectator-mode');
  const statusEl = document.getElementById('spectate-status');
  statusEl.style.display = '';
  statusEl.textContent = 'Connecting...';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = window.BRIMSTONE_WS ?? `${protocol}//${location.host}`;
  const ws = new WebSocket(wsUrl);

  let planningPlayers = [];
  let submittedIds    = new Set();

  ws.addEventListener('open', () => {
    statusEl.textContent = 'Joining room...';
    ws.send(JSON.stringify({ type: 'adminSpectateRoom', roomId }));
  });

  ws.addEventListener('message', e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    _handleSpectatorMessage(msg);
  });

  ws.addEventListener('close', () => {
    statusEl.textContent = 'Disconnected.';
    statusEl.style.display = '';
  });

  ws.addEventListener('error', () => {
    statusEl.textContent = 'Connection error.';
    statusEl.style.display = '';
  });

  function _handleSpectatorMessage(msg) {
    switch (msg.type) {
      case 'adminSpectateInit': {
        statusEl.style.display = 'none';
        document.getElementById('spectator-info').style.display = '';
        document.getElementById('spectator-banner').style.display = '';
        const mirrorState = MirrorState.fromSnapshot(msg.state);
        mirrorState.fogOfWar = false;
        _initSpectatorUI(mirrorState);
        _updateSpectatorInfoBar(msg.players, mirrorState);
        break;
      }
      case 'stateUpdate': {
        const mirrorState = MirrorState.fromSnapshot(msg.state);
        mirrorState.fogOfWar = false;
        state = mirrorState;
        ui?.updateState(mirrorState);
        _updateSpectatorRoundLabel(mirrorState);
        _checkSpectatorGameOver(mirrorState);
        break;
      }
      case 'resolutionComplete': {
        const finalMirror = MirrorState.fromSnapshot(msg.finalState);
        finalMirror.fogOfWar = false;
        const finalEntities = finalMirror.entities;
        const redrawFn = () => renderer?.draw();
        // Animate the resolution steps before applying the final state.
        // Pass 'spectator' as humanFaction sentinel: fog is off so all units are
        // visible, battles are shown, but encounter dialogs are suppressed
        // (no faction matches 'spectator', so pendingDialogs stays empty).
        _animateResolutionSteps(
          msg.steps ?? [],
          finalEntities,
          redrawFn,
          'spectator',
          null,
        ).then(() => {
          state = finalMirror;
          ui?.updateState(finalMirror);
          _updateSpectatorRoundLabel(finalMirror);
          _checkSpectatorGameOver(finalMirror);
          planningPlayers = [];
          submittedIds = new Set();
          _renderSpectatorReadyList(planningPlayers, submittedIds);
        });
        break;
      }
      case 'adminPlanningPhase': {
        document.getElementById('sp-round').textContent = `Round ${msg.round} — ${msg.phase}`;
        if (msg.players) {
          planningPlayers = msg.players;
          submittedIds = new Set();
          _renderSpectatorReadyList(planningPlayers, submittedIds);
        }
        break;
      }
      case 'playerSubmitted': {
        submittedIds.add(msg.playerId);
        _renderSpectatorReadyList(planningPlayers, submittedIds);
        break;
      }
      case 'resolutionStart': {
        planningPlayers = [];
        submittedIds = new Set();
        _renderSpectatorReadyList(planningPlayers, submittedIds);
        break;
      }
      case 'adminRoomEnded':
        statusEl.textContent = 'Game ended.';
        statusEl.style.display = '';
        break;
      case 'error':
        statusEl.textContent = msg.message || 'Error';
        statusEl.style.display = '';
        break;
    }
  }

  function _initSpectatorUI(mirrorState) {
    const canvas = document.getElementById('game-canvas');
    renderer = new Renderer(canvas, mirrorState);
    renderer.resize();
    renderer.loadImages();
    ui = new UIController(canvas, mirrorState, renderer, null, () => renderer.draw(), null, false);
    ui.setMode(UIMode.SPECTATOR);
    ui.speedMode = 'fast';
    window.addEventListener('resize', () => { renderer.resize(); renderer.draw(); });
    renderer.draw();
  }
}

function _updateSpectatorInfoBar(players, st) {
  if (players) {
    const heroNames  = players.filter(p => p.faction === 'hero').map(p => p.name).join(', ');
    const witchNames = players.filter(p => p.faction === 'witch').map(p => p.name).join(', ');
    document.getElementById('sp-hero').textContent  = `⚔ ${heroNames  || 'Hero'}`;
    document.getElementById('sp-witch').textContent = `✦ ${witchNames || 'Witch'}`;
  }
  _updateSpectatorRoundLabel(st);
}

function _updateSpectatorRoundLabel(st) {
  document.getElementById('sp-round').textContent = `Round ${st.round} — ${st.phase}`;
}

function _checkSpectatorGameOver(st) {
  if (!st.gameOver) return;
  const goEl    = document.getElementById('spectate-game-over');
  const winText = document.getElementById('sp-winner-text');
  const reasonEl = document.getElementById('sp-win-reason');
  winText.textContent = st.winner === 'hero' ? 'Hero Wins!' : 'Witch Wins!';
  winText.style.color = st.winner === 'hero' ? 'var(--hero)' : 'var(--witch)';
  reasonEl.textContent = st.winReason || '';
  goEl.style.display = '';
}

function _renderSpectatorReadyList(players, submittedIds) {
  const panel = document.getElementById('sp-ready-panel');
  const list  = document.getElementById('sp-ready-list');
  if (!panel || !list) return;
  if (players.length === 0) { panel.style.display = 'none'; return; }
  panel.style.display = 'flex';
  list.innerHTML = players.map(p => {
    const submitted = submittedIds.has(p.playerId);
    const fCls      = `sp-ready-faction-${p.faction}`;
    const dotCls    = submitted ? 'sp-ready-dot submitted' : 'sp-ready-dot';
    const status    = submitted ? '✓' : '…';
    const safeName  = String(p.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="sp-ready-row">
      <span class="${dotCls}"></span>
      <span class="sp-ready-name ${fCls}" title="${safeName}">${safeName}</span>
      <span style="font-size:0.72rem;color:${submitted ? 'var(--green)' : 'var(--text-dim)'}">${status}</span>
    </div>`;
  }).join('');
}

// Auto-start spectator mode when ?spectate=<roomId> or ?room=<roomId> is in the URL.
// This allows /spectate?room=X (served as index.html) to work automatically.
const _spectateParam = new URLSearchParams(location.search).get('spectate')
                    ?? new URLSearchParams(location.search).get('room');
if (_spectateParam) initSpectator(_spectateParam);
