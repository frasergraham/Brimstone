// Hex coordinate utilities — odd-r offset grid, pointy-top hexagons
// Storage uses (col, row); math uses axial (q, r)

export let MAP_COLS = 13;
export let MAP_ROWS = 11;
export const HEX_SIZE = 30; // pixels from center to vertex

export function setMapDimensions(cols, rows) {
  MAP_COLS = cols;
  MAP_ROWS = rows;
}
export const SQRT3 = Math.sqrt(3);

// Neighbor direction deltas in offset coords (odd-r)
const DIRS_EVEN = [[-1,0],[-1,-1],[0,-1],[1,0],[0,1],[-1,1]];
const DIRS_ODD  = [[-1,0],[0,-1],[1,-1],[1,0],[1,1],[0,1]];

export function getNeighbors(col, row) {
  const dirs = row % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
  // Only filter negative coords (which are never valid in any map size).
  // Callers check tile existence for upper-bound validity, so we don't
  // need the global MAP_COLS/MAP_ROWS bounds here — those globals are
  // shared across all games on the server and can't be trusted.
  return dirs
    .map(([dc, dr]) => ({ col: col + dc, row: row + dr }))
    .filter(({ col: c, row: r }) => c >= 0 && r >= 0);
}

// Direction index (0..5, matching getNeighbors order: 0=W,1=NW,2=NE,3=E,4=SE,
// 5=SW — stable across even/odd rows) of the neighbour at (nCol,nRow) relative
// to (col,row). Returns -1 when the two hexes are not adjacent. Pure.
export function neighborDirIndex(col, row, nCol, nRow) {
  const dirs = row % 2 === 0 ? DIRS_EVEN : DIRS_ODD;
  const dc = nCol - col, dr = nRow - row;
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i][0] === dc && dirs[i][1] === dr) return i;
  }
  return -1;
}

export function offsetToAxial(col, row) {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function axialToOffset(q, r) {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

export function hexDistance(col1, row1, col2, row2) {
  const a = offsetToAxial(col1, row1);
  const b = offsetToAxial(col2, row2);
  return (
    Math.abs(a.q - b.q) +
    Math.abs(a.q + a.r - b.q - b.r) +
    Math.abs(a.r - b.r)
  ) / 2;
}

// Pixel position of the CENTER of a hex (origin = top-left of grid)
export function hexToPixel(col, row, size = HEX_SIZE) {
  return {
    x: size * SQRT3 * (col + 0.5 * (row & 1)),
    y: size * 1.5 * row,
  };
}

function axialRound(q, r) {
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

// Convert a pixel position (relative to the top-left of the grid) to (col, row)
export function pixelToHex(px, py, size = HEX_SIZE) {
  const q = (SQRT3 / 3 * px - 1 / 3 * py) / size;
  const r = (2 / 3 * py) / size;
  const { q: rq, r: rr } = axialRound(q, r);
  return axialToOffset(rq, rr);
}

export function hexKey(col, row) {
  return `${col},${row}`;
}

// Hex linedraw — returns offset hexes along the line from (c1,r1) to (c2,r2),
// inclusive of both endpoints. Uses cube linear interpolation with rounding
// (the standard "Red Blob Games" algorithm). Used for line-of-sight checks
// where intermediate hexes block vision.
export function hexLine(c1, r1, c2, r2) {
  const N = hexDistance(c1, r1, c2, r2);
  if (N === 0) return [{ col: c1, row: r1 }];
  const a = offsetToAxial(c1, r1);
  const b = offsetToAxial(c2, r2);
  const ax = a.q, az = a.r, ay = -ax - az;
  const bx = b.q, bz = b.r, by = -bx - bz;
  const out = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz)       ry = -rx - rz;
    else                    rz = -rx - ry;
    out.push(axialToOffset(rx, rz));
  }
  return out;
}

// All hexes within `radius` steps (offset coords), filtered to map bounds
export function hexRange(col, row, radius) {
  const a = offsetToAxial(col, row);
  const results = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const rMin = Math.max(-radius, -dq - radius);
    const rMax = Math.min(radius, -dq + radius);
    for (let dr = rMin; dr <= rMax; dr++) {
      const off = axialToOffset(a.q + dq, a.r + dr);
      if (off.col >= 0 && off.col < MAP_COLS && off.row >= 0 && off.row < MAP_ROWS) {
        results.push(off);
      }
    }
  }
  return results;
}
