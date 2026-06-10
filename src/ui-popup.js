// Action popup and arc menu positioning — extracted from ui.js.
//
// These functions manage the radial "arc" action menu and standard dropdown
// popup, including animation, pan/zoom tracking, and close behavior.
// All functions take a `ui` (UIController) parameter explicitly.

/** Hide the action popup with optional arc close animation. */
export function hideActionPopup(ui) {
  const p = document.getElementById('action-popup');
  if (!p) return;
  if (ui && ui._arcCloseTimer) { clearTimeout(ui._arcCloseTimer); ui._arcCloseTimer = null; }
  if (ui && ui._arcTrackingRaf) { cancelAnimationFrame(ui._arcTrackingRaf); ui._arcTrackingRaf = null; }
  if (ui?.renderer) { ui.renderer.arcMenuLines = null; }
  const hadDisambigOrigins = ui?._disambigOrigins?.length > 0;
  if (ui) { ui._arcItems = null; ui._arcEntityCol = null; ui._arcEntityRow = null; }
  if (p.classList.contains('arc-open') && !p.classList.contains('popup-list-mode')) {
    p.classList.remove('arc-open');
    p.classList.add('arc-closing');
    const itemCount = p.querySelectorAll('.arc-item').length;
    const closeTime = hadDisambigOrigins ? 320 : 150 + itemCount * 20;
    const timer = setTimeout(() => {
      p.style.display = 'none';
      p.classList.remove('arc-closing');
      if (ui) {
        ui._arcCloseTimer = null;
        if (ui.renderer?.disambigHiddenIds) {
          ui.renderer.disambigHiddenIds = null;
          ui.onRedraw?.();
        }
        ui._disambigOrigins = null;
      }
    }, closeTime);
    if (ui) ui._arcCloseTimer = timer;
    ui?.onRedraw?.();
    return;
  }
  p.style.display = 'none';
  p.classList.remove('arc-open', 'arc-closing', 'popup-list-mode');
  if (ui) {
    if (ui.renderer?.disambigHiddenIds) {
      ui.renderer.disambigHiddenIds = null;
    }
    ui._disambigOrigins = null;
  }
  ui?.onRedraw?.();
}

/** Get the screen position (viewport px) of a selected entity, accounting for planning ghosts. */
export function getEntityScreenPos(ui, entity) {
  if (!entity) {
    const target = ui._pendingUnitPick?.units[0]
      || ui._pendingDefenderPick?.defenders[0]
      || ui._pendingEnemyPick?.units[0];
    if (!target) return null;
    entity = target;
  }
  let displayCol = entity.col;
  let displayRow = entity.row;
  if (ui._pendingDisambig) {
    displayCol = ui._pendingDisambig.hex.col;
    displayRow = ui._pendingDisambig.hex.row;
  } else if (ui._planMode && ui._selectedEntity) {
    const proj = ui._getProjectedPos(ui._selectedEntity.id);
    if (proj) { displayCol = proj.col; displayRow = proj.row; }
  }
  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(displayCol, displayRow);
  const scale       = canvasRect.width / ui.canvas.width;
  return {
    x: canvasRect.left + x * scale,
    y: canvasRect.top  + y * scale,
  };
}

/**
 * Compute arc positions: stack items vertically with a consistent gap,
 * then push each one out horizontally so nothing overlaps the origin hex.
 */
export function computeArcPositions(popup, ui, hexScreenPx) {
  const items = ui._arcItems;
  if (!items?.length) return;
  // Zoom-triggered recomputes start from a clean, un-expanded layout —
  // otherwise the hover expansion's offsets would be baked into the new grid.
  ui._collapseArcExpansion?.();
  const btns = popup.querySelectorAll('.arc-item');
  if (!btns.length) return;
  const openRight = ui._arcOpenRight;

  const sizes = [];
  for (let i = 0; i < btns.length; i++) {
    const rect = btns[i].getBoundingClientRect();
    sizes.push({ w: rect.width, h: rect.height });
  }

  const V_GAP = 6;
  const totalHeight = sizes.reduce((s, sz) => s + sz.h, 0) + V_GAP * (sizes.length - 1);
  let cy = -totalHeight / 2;
  const hexClear = hexScreenPx * 0.6 + 8;

  for (let i = 0; i < items.length && i < btns.length; i++) {
    const itemCy = cy + sizes[i].h / 2;
    const vertDist = Math.abs(itemCy);
    const halfW = sizes[i].w / 2;
    const halfH = sizes[i].h / 2;
    const innerClear = Math.max(0, hexClear * hexClear - (Math.max(0, vertDist - halfH)) ** 2);
    const minX = Math.sqrt(innerClear) + halfW;

    const fx = openRight ? minX : -minX;
    const fy = itemCy;

    items[i]._x = fx;
    items[i]._y = fy;
    btns[i].style.setProperty('--arc-x', fx.toFixed(1) + 'px');
    btns[i].style.setProperty('--arc-y', fy.toFixed(1) + 'px');

    cy += sizes[i].h + V_GAP;
  }

  ui._arcRadius = hexClear + 20;
}

/** Position the arc popup centered on the entity's screen position and set up canvas lines. */
export function positionArcPopup(popup, ui) {
  const col = ui._arcEntityCol;
  const row = ui._arcEntityRow;
  if (col == null || row == null) return;

  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(col, row);
  const scale       = canvasRect.width / ui.canvas.width;
  const sx = canvasRect.left + x * scale;
  const sy = canvasRect.top  + y * scale;

  popup.style.left = sx + 'px';
  popup.style.top  = sy + 'px';
  popup.style.transform = 'none';

  if (ui._arcItems?.length) {
    const hexPx = ui.renderer.hexSize * (canvasRect.width / ui.canvas.width) * ui.renderer.zoomLevel;
    if (Math.abs(hexPx - (ui._arcHexPx || 0)) > 2) {
      ui._arcHexPx = hexPx;
      computeArcPositions(popup, ui, hexPx);
    }
    ui.renderer.arcMenuLines = {
      col, row,
      items: ui._arcItems.map(item => ({
        x: item._x ?? 0,
        y: item._y ?? 0,
        color: item.color,
      })),
    };
  }

  if (ui._disambigOrigins?.length && ui.renderer?.disambigHiddenIds) {
    const state = ui.state || ui.renderer._lastState;
    const units = [];
    if (state?.entities) {
      for (const o of ui._disambigOrigins) {
        const e = state.entities.find(en => en.id === o.entityId);
        if (e) units.push(e);
      }
    }
    if (units.length) {
      const positions = ui.renderer.getEntityScreenPositions(col, row, units, canvasRect);
      const posMap = new Map(positions.map(p => [p.entityId, p]));
      const btns = popup.querySelectorAll('.arc-item.arc-from-canvas');
      for (const btn of btns) {
        const uid = parseInt(btn.dataset.unitId);
        const pos = posMap.get(uid);
        if (pos) {
          const relX = pos.screenX - sx;
          const relY = pos.screenY - sy;
          btn.style.setProperty('--start-x', relX.toFixed(1) + 'px');
          btn.style.setProperty('--start-y', relY.toFixed(1) + 'px');
        }
      }
      for (const o of ui._disambigOrigins) {
        const pos = posMap.get(o.entityId);
        if (pos) { o.startX = pos.screenX - sx; o.startY = pos.screenY - sy; o.startR = pos.screenR; }
      }
    }
  }
}

/** Start a rAF loop that repositions the arc popup on every frame (tracks pan/zoom). */
export function startArcTracking(ui) {
  if (ui._arcTrackingRaf) return;
  const popup = document.getElementById('action-popup');
  function tick() {
    if (!popup || popup.style.display === 'none' || popup.classList.contains('popup-list-mode')) {
      ui._arcTrackingRaf = null;
      return;
    }
    positionArcPopup(popup, ui);
    ui._arcTrackingRaf = requestAnimationFrame(tick);
  }
  ui._arcTrackingRaf = requestAnimationFrame(tick);
}

/** Position a standard (non-arc) popup above or below the selected entity. */
export function positionPopup(popup, ui) {
  if (!ui._selectedEntity && !ui._pendingUnitPick && !ui._pendingDefenderPick && !ui._pendingEnemyPick) return;
  const target = ui._selectedEntity
    || ui._pendingUnitPick?.units[0]
    || ui._pendingDefenderPick?.defenders[0]
    || ui._pendingEnemyPick?.units[0];
  if (!target) return;

  popup.style.visibility = 'hidden';
  popup.style.display    = 'block';
  const popupH = popup.offsetHeight || 180;
  popup.style.display    = 'none';
  popup.style.visibility = '';

  const POPUP_W = 210;
  const GAP     = 10;

  let displayCol = target.col;
  let displayRow = target.row;
  if (ui._pendingDisambig) {
    displayCol = ui._pendingDisambig.hex.col;
    displayRow = ui._pendingDisambig.hex.row;
  } else if (ui._planMode && ui._selectedEntity) {
    const proj = ui._getProjectedPos(ui._selectedEntity.id);
    if (proj) { displayCol = proj.col; displayRow = proj.row; }
  }

  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(displayCol, displayRow);
  const scale       = canvasRect.width / ui.canvas.width;
  const screenX     = canvasRect.left + x * scale;
  const screenY     = canvasRect.top  + y * scale;
  const hs          = ui.renderer.hexSize * scale;

  popup.style.left      = Math.max(8, Math.min(screenX - POPUP_W / 2, window.innerWidth  - POPUP_W - 8)) + 'px';
  popup.style.transform = 'none';

  const hexTop     = screenY - hs * 0.55;
  const hexBot     = screenY + hs * 0.55;
  const spaceAbove = hexTop - GAP;
  const showBelow  = spaceAbove < popupH + 8;

  if (showBelow) {
    popup.classList.add('flipped');
    popup.style.top = Math.min(hexBot + GAP, window.innerHeight - popupH - 8) + 'px';
  } else {
    popup.classList.remove('flipped');
    popup.style.top = Math.max(8, hexTop - GAP - popupH) + 'px';
  }
}

/** Bind click/touchend handlers to action buttons in the popup. */
export function attachPopupListeners(popup, ui) {
  popup.querySelectorAll('button[data-action]').forEach(b => {
    b.addEventListener('click', () => ui._handleActionButton(b));
    b.addEventListener('touchend', e => {
      e.preventDefault();
      ui._handleActionButton(b);
    }, { passive: false });
  });
}

/** Calculate distance between two touch points for pinch detection. */
export function touchDist(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}
