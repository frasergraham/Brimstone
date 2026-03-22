// Canvas renderer for the hex map
import {
  MAP_COLS, MAP_ROWS, SQRT3,
  getNeighbors,
  hexToPixel, pixelToHex as _pixelToHex, hexKey, hexDistance,
} from './hex.js';
import {
  TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL, BUILDING_ICON,
} from './tiles.js';
import { ENTITY_COLOR, EntityType, SurvivorAbility } from './entities.js';
import { getVisibleEnemyHexes, getVisibleHeroHexes, sightRange } from './actions.js';

export const PAD_X = 40;
export const PAD_Y = 30;
const BG_COLOR = '#0d1117';
const MIN_HEX_SIZE = 10;

function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

export class Renderer {
  constructor(canvas, state) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.state   = state;
    this.hexSize = 30; // will be updated by _resize()

    this.selectedHex    = null;
    this.highlightHexes = [];
    this.hoveredHex     = null;

    // Zoom & pan
    this.zoomLevel = 1.0;
    this._panX     = 0;
    this._panY     = 0;

    // Damage flash overlays: [{col, row, text, color, endTime}]
    this._flashes = [];

    this._resize();
  }

  // Add a brief flash overlay on a hex (e.g. damage numbers)
  addFlash(col, row, text, color = 'rgba(220,40,40,0.7)', durationMs = 1800) {
    this._flashes.push({ col, row, text, color, startTime: Date.now(), endTime: Date.now() + durationMs });
  }

  _resize() {
    const wrapper = this.canvas.parentElement;
    if (wrapper && wrapper.clientWidth > 0 && wrapper.clientHeight > 0) {
      const availW = wrapper.clientWidth  - PAD_X * 2;
      const availH = wrapper.clientHeight - PAD_Y * 2;
      const sizeByW = availW  / (SQRT3 * (MAP_COLS + 0.5));
      const sizeByH = availH  / (1.5 * MAP_ROWS + 0.5);
      // Portrait: fill height so the map uses the full screen; user pans horizontally.
      // Landscape / desktop: fit both dimensions so no overflow.
      const portrait = wrapper.clientHeight > wrapper.clientWidth;
      this.hexSize = Math.max(MIN_HEX_SIZE, Math.floor(portrait ? sizeByH : Math.min(sizeByW, sizeByH)));
    }

    const w = Math.ceil(SQRT3 * this.hexSize * (MAP_COLS + 0.5)) + PAD_X * 2;
    const h = Math.ceil(1.5  * this.hexSize * MAP_ROWS + this.hexSize * 0.5) + PAD_Y * 2;
    this.canvas.width  = w;
    this.canvas.height = h;
    this._clampPan();
  }

  resize() {
    this._resize();
  }

  _toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row, this.hexSize);
    return { x: x + PAD_X, y: y + PAD_Y };
  }

  // Convert canvas pixel coordinates back to hex grid coordinates (accounts for zoom/pan)
  canvasToHex(canvasX, canvasY) {
    const x = (canvasX - this._panX) / this.zoomLevel;
    const y = (canvasY - this._panY) / this.zoomLevel;
    return _pixelToHex(x - PAD_X, y - PAD_Y, this.hexSize);
  }

  // Return the canvas-pixel centre of a hex (for overlay positioning, accounts for zoom/pan)
  hexToCanvasPos(col, row) {
    const { x, y } = this._toCanvas(col, row);
    return {
      x: x * this.zoomLevel + this._panX,
      y: y * this.zoomLevel + this._panY,
    };
  }

  // Zoom toward a focal point (canvas pixel coordinates)
  setZoom(newZoom, focalX, focalY) {
    newZoom = Math.max(0.5, Math.min(4.0, newZoom));
    const ratio  = newZoom / this.zoomLevel;
    this._panX   = focalX - ratio * (focalX - this._panX);
    this._panY   = focalY - ratio * (focalY - this._panY);
    this.zoomLevel = newZoom;
    this._clampPan();
  }

  resetView() {
    this.zoomLevel = 1.0;
    this._panX = 0;
    this._panY = 0;
  }

  _clampPan() {
    const wrapper = this.canvas.parentElement;
    const wrapW = wrapper?.clientWidth  ?? this.canvas.width;
    const wrapH = wrapper?.clientHeight ?? this.canvas.height;
    // Content dimensions at current zoom
    const contentW = this.canvas.width  * this.zoomLevel;
    const contentH = this.canvas.height * this.zoomLevel;
    // Allow pan up to the overflow in each axis; clamp to [overflow, 0]
    const minX = Math.min(0, wrapW - contentW);
    const minY = Math.min(0, wrapH - contentH);
    this._panX = Math.max(minX, Math.min(0, this._panX));
    this._panY = Math.max(minY, Math.min(0, this._panY));
  }

  draw() {
    const ctx   = this.ctx;
    const state = this.state;

    // Background covers the full canvas regardless of zoom/pan
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply zoom and pan transform for all map content
    ctx.save();
    ctx.translate(this._panX, this._panY);
    ctx.scale(this.zoomLevel, this.zoomLevel);

    // Pass 1: terrain tiles (grass, forest, dirt, road bg, river bg, bridges)
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const t = state.tiles.get(hexKey(col, row));
        if (t && t.type !== TileType.BUILDING) this._drawTile(col, row);
      }
    }

    // Road strips and river flow (on top of terrain backgrounds)
    this._drawRoadLayer();
    this._drawRiverLayer();

    // Pass 2: building tiles drawn over roads/rivers so no bleed-through
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const t = state.tiles.get(hexKey(col, row));
        if (t && t.type === TileType.BUILDING) this._drawTile(col, row);
      }
    }

    // Visibility: compute once for fog layer + entity pass + outlines.
    // Fog is shown from the human player's perspective only (not AI vs AI).
    const humanIsHero  = state.witchIsAI && !state.heroIsAI;
    const humanIsWitch = state.heroIsAI  && !state.witchIsAI;
    let revealedHexes = null;
    if (state.fogOfWar) {
      if (humanIsHero)  revealedHexes = getVisibleEnemyHexes(state); // hero sees witch
      if (humanIsWitch) revealedHexes = getVisibleHeroHexes(state);  // witch sees hero
    }

    // Fog of war: grey overlay on all hexes outside the human player's vision
    if (humanIsHero)  this._drawFogLayer('hero');
    if (humanIsWitch) this._drawFogLayer('witch');

    // Objective glows and symbols always drawn on top of fog — always visible
    for (const obj of state.witchObjectives) {
      this._drawObjectiveGlow(obj.col, obj.row);
    }
    for (const obj of state.witchObjectives) {
      this._drawObjectiveSymbol(obj.col, obj.row, obj.label, state);
    }

    // Thick outlines on hexes occupied by units
    this._drawUnitPresenceOutlines(revealedHexes);

    // Highlights
    for (const h of this.highlightHexes) {
      this._drawHighlight(h.col, h.row, h.color || 'rgba(100,200,100,0.25)');
    }

    if (this.selectedHex) {
      this._drawOutline(this.selectedHex.col, this.selectedHex.row, '#f5c842', 2.5);
    }
    if (this.hoveredHex) {
      this._drawOutline(this.hoveredHex.col, this.hoveredHex.row, 'rgba(255,255,255,0.3)', 1);
    }

    // Entities
    const drawn = new Set();
    for (const entity of state.entities) {
      if (!entity.alive) continue;

      if (revealedHexes !== null) {
        const hiddenOwner = humanIsHero ? 'witch' : 'hero';
        if (entity.owner === hiddenOwner && !revealedHexes.has(hexKey(entity.col, entity.row))) continue;
      }

      const key = hexKey(entity.col, entity.row);
      if (drawn.has(key)) continue;

      const stack = state.entities.filter(e => {
        if (!e.alive || e.col !== entity.col || e.row !== entity.row) return false;
        if (revealedHexes !== null) {
          const hiddenOwner = humanIsHero ? 'witch' : 'hero';
          if (e.owner === hiddenOwner) return revealedHexes.has(hexKey(e.col, e.row));
        }
        return true;
      });

      drawn.add(key);
      this._drawEntityStack(entity.col, entity.row, stack);
    }

    // Damage flash overlays (night/day hazard animations)
    this._drawFlashes();

    ctx.restore(); // end zoom/pan transform

    // Decorative map border (outside zoom/pan transform — always in canvas space)
    this._drawMapBorder();
  }

  _drawFlashes() {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const now = Date.now();
    this._flashes = this._flashes.filter(f => now < f.endTime);

    for (const f of this._flashes) {
      const total = f.endTime - f.startTime;
      const remaining = f.endTime - now;
      const t = remaining / total; // 1.0 = just started, 0.0 = expired

      const { x, y } = this._toCanvas(f.col, f.row);
      const corners   = hexCorners(x, y, hs - 1);

      // Red hex overlay (fades out)
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = f.color.replace(/[\d.]+\)$/, `${(t * 0.55).toFixed(2)})`);
      ctx.fill();

      // Floating damage text (rises upward as it fades)
      const rise = (1 - t) * hs * 1.2;
      ctx.fillStyle = `rgba(255,80,80,${t.toFixed(2)})`;
      ctx.font      = `bold ${Math.floor(hs * 0.85)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.text, x, y - rise);
    }
  }

  _drawTile(col, row) {
    const ctx  = this.ctx;
    const hs   = this.hexSize;
    const tile = this.state.tiles.get(hexKey(col, row));
    if (!tile) return;

    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1);

    // Road and river tiles use a grass background — the actual road strips and
    // water ribbons are drawn in dedicated layers on top.
    const color = tile.type === TileType.BUILDING
      ? BUILDING_COLOR
      : (tile.type === TileType.ROAD || tile.type === TileType.RIVER || tile.type === TileType.BRIDGE)
        ? TILE_COLOR[TileType.GRASS]
        : (TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS]);

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = '#111418';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // Bridge tiles: only the water background is drawn here.
    // The water bezier and road strip are layered on top in _drawRiverLayer / _drawRoadLayer.
    if (tile.type === TileType.BRIDGE) return;

    // ── Fortification outline — grey, thickness scales with fortifyLevel ──
    if (tile.fortifyLevel > 0) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      const alpha = Math.min(0.9, 0.4 + tile.fortifyLevel * 0.12);
      ctx.strokeStyle = `rgba(190,190,190,${alpha})`;
      ctx.lineWidth   = tile.fortifyLevel * 2; // level 1: 2px, level 4: 8px
      ctx.stroke();
    }

    // ── Explored dot (all tile types, including buildings) ────────────────
    if (tile.explored) {
      ctx.fillStyle = 'rgba(245,200,66,0.70)';
      ctx.beginPath();
      ctx.arc(x + hs * 0.42, y + hs * 0.48, Math.max(2, hs * 0.11), 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Building: icon + name ─────────────────────────────────────────────
    if (tile.type === TileType.BUILDING && tile.building) {

      ctx.font         = `${Math.floor(hs * 0.55)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_ICON[tile.building] || '?', x, y - hs * 0.10);

      ctx.fillStyle    = 'rgba(255,248,230,0.92)';
      ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.25))}px "Georgia", serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_LABEL[tile.building] || tile.building, x, y + hs * 0.58);
    }
  }

  // Fog of war: draw a dark grey overlay on every hex NOT within the observer's
  // sight range. observerOwner is 'hero' or 'witch'.
  _drawFogLayer(observerOwner) {
    const ctx   = this.ctx;
    const state = this.state;
    const hs    = this.hexSize;

    // Build the visible hex set from observerOwner's units
    const visibleSet = new Set();
    for (const e of state.entities) {
      if (!e.alive || e.owner !== observerOwner) continue;
      const range = sightRange(state.phase, e.ability === SurvivorAbility.SCOUT);
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          if (hexDistance(col, row, e.col, e.row) <= range) {
            visibleSet.add(hexKey(col, row));
          }
        }
      }
    }

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const k = hexKey(col, row);
        if (visibleSet.has(k)) continue; // visible — no fog

        const { x, y } = this._toCanvas(col, row);
        const corners = hexCorners(x, y, hs);

        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.70)';
        ctx.fill();
      }
    }
  }

  // Thick coloured outlines on hexes occupied by units so they read clearly
  // even on a busy map. Orange for hero-side, purple for witch-side.
  _drawUnitPresenceOutlines(revealedHexes) {
    const state = this.state;
    const heroHexes  = new Set();
    const witchHexes = new Set();

    const humanIsHero  = state.witchIsAI && !state.heroIsAI;
    const humanIsWitch = state.heroIsAI  && !state.witchIsAI;

    for (const e of state.entities) {
      if (!e.alive) continue;
      if (e.owner === 'hero') {
        // Hide hero outlines when human is playing witch and hero is in fog
        if (humanIsWitch && revealedHexes && !revealedHexes.has(hexKey(e.col, e.row))) continue;
        heroHexes.add(hexKey(e.col, e.row));
      } else if (e.owner === 'witch') {
        // Hide witch outlines when human is playing hero and witch is in fog
        if (humanIsHero && revealedHexes && !revealedHexes.has(hexKey(e.col, e.row))) continue;
        witchHexes.add(hexKey(e.col, e.row));
      }
    }

    for (const k of heroHexes) {
      const [col, row] = k.split(',').map(Number);
      this._drawOutline(col, row, 'rgba(255,140,0,0.85)', 3);
    }
    for (const k of witchHexes) {
      const [col, row] = k.split(',').map(Number);
      this._drawOutline(col, row, 'rgba(160,80,220,0.85)', 3);
    }
  }

  // Draw the river as smooth bezier flows through each RIVER and BRIDGE tile.
  // Endpoints (row 0 / row MAP_ROWS-1) extend their bezier off-screen so the
  // river appears to flow in from and out to the edge of the map.
  _drawRiverLayer() {
    const ctx     = this.ctx;
    const tiles   = this.state.tiles;
    const hs      = this.hexSize;
    const apothem = hs * SQRT3 / 2;

    const isWater = t => t && (t.type === TileType.RIVER || t.type === TileType.BRIDGE);

    ctx.strokeStyle = TILE_COLOR[TileType.RIVER];
    ctx.lineWidth   = hs * 0.52;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const tile = tiles.get(hexKey(col, row));
        if (!isWater(tile)) continue;

        const { x, y } = this._toCanvas(col, row);
        const riverNbrs = getNeighbors(col, row).filter(n => isWater(tiles.get(hexKey(n.col, n.row))));

        // Build edge midpoints toward each river/bridge neighbour
        const edgeMids = riverNbrs.map(n => {
          const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
          const dx = nx - x, dy = ny - y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          return { x: x + dx / d * apothem, y: y + dy / d * apothem };
        });

        ctx.beginPath();
        if (riverNbrs.length >= 2) {
          // Two river neighbours: smooth bezier entry → center → exit
          ctx.moveTo(edgeMids[0].x, edgeMids[0].y);
          ctx.quadraticCurveTo(x, y, edgeMids[1].x, edgeMids[1].y);
        } else if (riverNbrs.length === 1) {
          // Endpoint tile: extend bezier off-screen in the upstream/downstream direction
          const { x: nx, y: ny } = this._toCanvas(riverNbrs[0].col, riverNbrs[0].row);
          const dx = nx - x, dy = ny - y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          // Point beyond this hex in the opposite direction (off the map edge)
          const offX = x - (dx / d) * apothem * 2;
          const offY = y - (dy / d) * apothem * 2;
          ctx.moveTo(offX, offY);
          ctx.quadraticCurveTo(x, y, edgeMids[0].x, edgeMids[0].y);
        } else {
          continue; // isolated water tile — skip
        }
        ctx.stroke();
      }
    }

    ctx.lineCap  = 'butt';
    ctx.lineJoin = 'miter';
  }

  // Draw road strips as directional paths on ROAD and BRIDGE tiles.
  // Roads connect to road/bridge/building neighbours, capped at 3 connections
  // (T-junction max).  Bridges additionally draw railing lines over the water.
  _drawRoadLayer() {
    const ctx     = this.ctx;
    const tiles   = this.state.tiles;
    const hs      = this.hexSize;
    const apothem = hs * SQRT3 / 2;

    const isRoadLike = t => t && (
      t.type === TileType.ROAD || t.type === TileType.BRIDGE || t.type === TileType.BUILDING
    );

    // Helper: pick up to `max` road neighbours, preferring the pair that forms the
    // straightest through-road (most opposing directions) then adding the best branch.
    const pickConnections = (center, nbrs, max) => {
      if (nbrs.length <= max) return nbrs;
      const dirs = nbrs.map(n => {
        const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
        const dx = nx - center.x, dy = ny - center.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        return { n, dx: dx / d, dy: dy / d };
      });
      // Find the most opposing pair
      let pairA = 0, pairB = 1, minDot = Infinity;
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          const dot = dirs[i].dx * dirs[j].dx + dirs[i].dy * dirs[j].dy;
          if (dot < minDot) { minDot = dot; pairA = i; pairB = j; }
        }
      }
      const chosen = new Set([pairA, pairB]);
      // Add the best remaining branch (closest to 90° from the axis midpoint)
      if (max >= 3) {
        let bestIdx = -1, bestScore = -Infinity;
        for (let i = 0; i < dirs.length; i++) {
          if (chosen.has(i)) continue;
          // Prefer directions that differ from both chosen by ~90°
          const dotA = Math.abs(dirs[i].dx * dirs[pairA].dx + dirs[i].dy * dirs[pairA].dy);
          const dotB = Math.abs(dirs[i].dx * dirs[pairB].dx + dirs[i].dy * dirs[pairB].dy);
          const score = -(dotA + dotB);
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        if (bestIdx >= 0) chosen.add(bestIdx);
      }
      return [...chosen].map(i => dirs[i].n);
    };

    ctx.lineWidth = hs * 0.42;
    ctx.lineCap   = 'round';

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const tile = tiles.get(hexKey(col, row));
        if (!tile || (tile.type !== TileType.ROAD && tile.type !== TileType.BRIDGE)) continue;

        const { x, y } = this._toCanvas(col, row);
        const allNbrs  = getNeighbors(col, row).filter(n => isRoadLike(tiles.get(hexKey(n.col, n.row))));
        const roadNbrs = pickConnections({ x, y }, allNbrs, 3);
        if (roadNbrs.length === 0) continue;

        const edgeMids = roadNbrs.map(n => {
          const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
          const dx = nx - x, dy = ny - y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          return { x: x + dx / d * apothem, y: y + dy / d * apothem };
        });

        ctx.strokeStyle = TILE_COLOR[TileType.ROAD];

        if (roadNbrs.length === 2) {
          ctx.beginPath();
          ctx.moveTo(edgeMids[0].x, edgeMids[0].y);
          ctx.quadraticCurveTo(x, y, edgeMids[1].x, edgeMids[1].y);
          ctx.stroke();
        } else {
          // T-junction or dead-end: spokes + filled centre dot
          for (const em of edgeMids) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(em.x, em.y);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(x, y, hs * 0.21, 0, Math.PI * 2);
          ctx.fillStyle = TILE_COLOR[TileType.ROAD];
          ctx.fill();
        }

        // ── Bridge railings on top of the road strip ──────────────────────
        if (tile.type === TileType.BRIDGE && roadNbrs.length === 2) {
          const [em0, em1] = edgeMids;
          const dx = em1.x - em0.x, dy = em1.y - em0.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const perpX = (-dy / len) * hs * 0.18;
          const perpY = ( dx / len) * hs * 0.18;

          ctx.strokeStyle = '#8a7a5a';
          ctx.lineWidth   = Math.max(1, hs * 0.06);
          for (const sign of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(em0.x + perpX * sign, em0.y + perpY * sign);
            ctx.lineTo(em1.x + perpX * sign, em1.y + perpY * sign);
            ctx.stroke();
          }
        }
      }
    }

    ctx.lineCap = 'butt';
  }

  // Decorative border frame drawn in canvas coordinates (outside the zoom transform).
  _drawMapBorder() {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const z   = this.zoomLevel;
    const px  = this._panX;
    const py  = this._panY;

    // Compute the map content bounding box in canvas space
    const gridW = SQRT3 * hs * (MAP_COLS + 0.5);
    const gridH = 1.5   * hs * MAP_ROWS + hs * 0.5;
    const pad   = hs * 0.6;

    const x0 = (PAD_X - pad) * z + px;
    const y0 = (PAD_Y - pad) * z + py;
    const bw  = (gridW + pad * 2) * z;
    const bh  = (gridH + pad * 2) * z;

    // Outer dark frame
    ctx.strokeStyle = '#1a110a';
    ctx.lineWidth   = 5 * z;
    ctx.strokeRect(x0 - 4 * z, y0 - 4 * z, bw + 8 * z, bh + 8 * z);

    // Aged wood inner frame
    ctx.strokeStyle = '#5a3f20';
    ctx.lineWidth   = 3 * z;
    ctx.strokeRect(x0, y0, bw, bh);

    // Thin inner highlight
    ctx.strokeStyle = 'rgba(160,120,60,0.5)';
    ctx.lineWidth   = 1.5 * z;
    ctx.strokeRect(x0 + 4 * z, y0 + 4 * z, bw - 8 * z, bh - 8 * z);

    // Corner rivets
    const corners = [
      [x0, y0], [x0 + bw, y0], [x0, y0 + bh], [x0 + bw, y0 + bh],
    ];
    ctx.fillStyle = '#7a5530';
    for (const [cx, cy] of corners) {
      ctx.beginPath();
      ctx.arc(cx, cy, 5 * z, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#2a1a08';
      ctx.lineWidth   = 1 * z;
      ctx.stroke();
    }
  }

  _drawObjectiveGlow(col, row) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, hs * 1.5);
    gradient.addColorStop(0, 'rgba(160,0,220,0.25)');
    gradient.addColorStop(1, 'rgba(160,0,220,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, hs * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawObjectiveSymbol(col, row, label, state) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);

    const witchHeld = state.entities.some(
      e => e.alive && e.owner === 'witch' && e.col === col && e.row === row
    );

    ctx.fillStyle    = witchHeld ? '#ff4444' : 'rgba(180,0,255,0.7)';
    ctx.font         = `bold ${Math.floor(hs * 0.5)}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⛧', x, y - hs * 0.15);

    ctx.fillStyle = witchHeld ? '#ff8888' : 'rgba(220,160,255,0.85)';
    ctx.font      = `${Math.max(6, Math.floor(hs * 0.2))}px sans-serif`;
    ctx.fillText(label, x, y + hs * 0.35);
  }

  _drawHighlight(col, row, color) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = color.replace(/,\s*[\d.]+\)$/, ', 0.9)');
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  _drawOutline(col, row, color, lineWidth = 2) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1.5);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineWidth;
    ctx.stroke();
  }

  _drawEntityStack(col, row, stack) {
    const ctx    = this.ctx;
    const hs     = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const r      = hs * 0.32;
    const max    = Math.min(stack.length, 3);

    for (let i = 0; i < max; i++) {
      const entity  = stack[i];
      const offsets = stackOffset(i, max);
      const ex = x + offsets.x * (hs / 30);
      const ey = y + offsets.y * (hs / 30);

      ctx.beginPath();
      ctx.arc(ex + 1, ey + 1, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fillStyle = ENTITY_COLOR[entity.type];
      ctx.fill();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth   = 1;
      ctx.stroke();

      ctx.fillStyle    = '#ffffffdd';
      ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(entityGlyph(entity.type), ex, ey + 1);

      if (entity.type === EntityType.HERO || entity.type === EntityType.WITCH ||
          entity.type === EntityType.SURVIVOR || entity.type === EntityType.WOOD_GOLEM ||
          entity.type === EntityType.IRON_GOLEM) {
        const barW = r * 2;
        const barH = Math.max(2, hs * 0.08);
        const bx   = ex - r;
        const by   = ey + r + 2;
        ctx.fillStyle = '#333';
        ctx.fillRect(bx, by, barW, barH);
        const pct = entity.hp / entity.maxHp;
        ctx.fillStyle = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';
        ctx.fillRect(bx, by, barW * pct, barH);
      }

      if (entity.weapon && entity.owner === 'hero') {
        ctx.fillStyle = '#f5c842';
        ctx.beginPath();
        ctx.arc(ex + r - 2, ey - r + 2, Math.max(2, hs * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }

      if (entity.type === EntityType.SURVIVOR && entity.ability) {
        ctx.fillStyle = '#88eeff';
        ctx.beginPath();
        ctx.arc(ex - r + 2, ey - r + 2, Math.max(2, hs * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (stack.length > 3) {
      const bx = x + 8 * (hs / 30);
      const by = y - r - 8 * (hs / 30);
      ctx.fillStyle    = '#333c';
      ctx.fillRect(bx, by, 14, 10);
      ctx.fillStyle    = '#fff';
      ctx.font         = `${Math.max(7, Math.floor(hs * 0.25))}px monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${stack.length - 3}`, bx + 7, by + 5);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function entityGlyph(type) {
  switch (type) {
    case EntityType.HERO:       return '⚔';
    case EntityType.WITCH:      return '✦';
    case EntityType.SURVIVOR:   return '☺';
    case EntityType.ZOMBIE:     return '†';
    case EntityType.MINION:     return '☠';
    case EntityType.WOOD_GOLEM: return '🪵';
    case EntityType.IRON_GOLEM: return '⚙';
    default: return '?';
  }
}

function stackOffset(index, total) {
  if (total === 1) return { x: 0, y: 0 };
  if (total === 2) return index === 0 ? { x: -6, y: 0 } : { x: 6, y: 0 };
  const offsets = [{ x: -6, y: -4 }, { x: 6, y: -4 }, { x: 0, y: 6 }];
  return offsets[index] || { x: 0, y: 0 };
}
