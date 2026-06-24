// Per-tile river-channel geometry — pure, Babylon/DOM-free so it unit-tests
// directly and the renderer just uploads the buffers it returns.
//
// A river hex is ONE solid mesh: a flat, coplanar grass top with a channel cut
// straight INTO the geometry (added verts; the hex perimeter corners stay at
// Y=0 so the tile still tiles seamlessly with its neighbours). The mesh carries
// three submeshes, each meant for its own material:
//   • GRASS  — the flat top around the channel (Y=0)
//   • BANK   — the dirt walls sloping from the grass rim down to the water line
//   • RIVER  — the flat bed at the bottom (the flowing-water texture)
//
// Rivers never turn sharply (the map lays one tile per row/col, drifting ±1
// column), so every river tile is one of three shapes — STRAIGHT, LEFT, RIGHT —
// distinguished only by the angular separation of its two water-edges. The
// caller picks the shape from the tile's water neighbours and ROTATES the hex
// (k·60°) to orient it; this module always generates in a canonical frame and
// is cached per (entryEdge, exitEdge) so the topology is effectively baked.
//
// Geometry: pointy-top hex, radius 1, centred at the origin. Corner k sits at
// angle 30°+60°k; edge e runs between corner e and corner (e+1)%6.

export const CHANNEL_BED_Y      = -0.18;  // water-bed depth (matches RIVER_BED_Y)
export const CHANNEL_WATER_HALF = 0.30;   // half-width of the flat bed (water line)
export const CHANNEL_RIM_HALF   = 0.46;   // half-width where grass meets the bank top.
                                          // < 0.5 (the edge half-length) so the channel
                                          // mouth fits inside the hex edge with a sliver
                                          // of grass left at each corner.

const DEG = Math.PI / 180;
const hexCorner = (k) => [Math.cos((30 + 60 * k) * DEG), Math.sin((30 + 60 * k) * DEG)];
const HEX = [0, 1, 2, 3, 4, 5].map(hexCorner);

const edgeMid = (e) => {
  const a = HEX[e], b = HEX[(e + 1) % 6];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};
/** Unit vector along edge e, from corner e toward corner e+1. */
const edgeDir = (e) => {
  const a = HEX[e], b = HEX[(e + 1) % 6];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const m = Math.hypot(dx, dz) || 1;
  return [dx / m, dz / m];
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (a) => { const m = Math.hypot(a[0], a[1]) || 1; return [a[0] / m, a[1] / m]; };
const perpOf = (d) => [-d[1], d[0]];          // rotate +90° in XZ (left of travel)
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];

/** Signed area of a closed XZ polygon (>0 ⇒ CCW). */
function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Ear-clipping triangulation of a SIMPLE polygon of [x,z] points. Returns flat
 *  triangle index triples into `poly`. Input is normalised to CCW first. */
function earClip(poly) {
  if (poly.length < 3) return [];
  const idx = [...Array(poly.length).keys()];
  if (signedArea(poly) < 0) idx.reverse(); // ensure CCW
  const COLL = 1e-7;
  // Pre-simplify: drop collinear vertices (e.g. the interior points of a
  // straight rim) up front, so the clip loop only ever sees real corners.
  for (let pass = 0; pass < poly.length; pass++) {
    let removed = false;
    for (let i = 0; i < idx.length && idx.length > 3; i++) {
      const a = poly[idx[(i - 1 + idx.length) % idx.length]];
      const b = poly[idx[i]];
      const c = poly[idx[(i + 1) % idx.length]];
      if (Math.abs(cross2(sub(b, a), sub(c, b))) < COLL) { idx.splice(i, 1); removed = true; i--; }
    }
    if (!removed) break;
  }
  const out = [];
  const isConvex = (a, b, c) => cross2(sub(b, a), sub(c, b)) > 0;
  const inTri = (p, a, b, c) => {
    const d1 = cross2(sub(b, a), sub(p, a));
    const d2 = cross2(sub(c, b), sub(p, b));
    const d3 = cross2(sub(a, c), sub(p, c));
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < poly.length * poly.length) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ip = (i - 1 + idx.length) % idx.length;
      const inx = (i + 1) % idx.length;
      const a = poly[idx[ip]], b = poly[idx[i]], c = poly[idx[inx]];
      if (!isConvex(a, b, c)) continue;
      let ear = true;
      for (let j = 0; j < idx.length; j++) {
        if (j === ip || j === i || j === inx) continue;
        if (inTri(poly[idx[j]], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(idx[ip], idx[i], idx[inx]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate — bail rather than loop forever
  }
  if (idx.length === 3 &&
      Math.abs(cross2(sub(poly[idx[1]], poly[idx[0]]), sub(poly[idx[2]], poly[idx[1]]))) >= COLL) {
    out.push(idx[0], idx[1], idx[2]);
  }
  return out;
}

/**
 * Build the canonical channel geometry for a hex whose river enters `entryEdge`
 * and exits `exitEdge` (edge indices 0..5). Pure — returns plain arrays in the
 * hex's local XZ frame (radius 1), ready for the renderer to scale/rotate/place.
 *
 * @returns {{
 *   positions: number[],            // flat [x,y,z, …]
 *   grass: number[], bank: number[], river: number[],  // triangle index lists
 *   bedY: number,
 * }}
 */
export function buildRiverChannelGeometry(entryEdge, exitEdge, opts = {}) {
  const SEG = Math.max(2, opts.segments ?? 12);
  const RIM = opts.rimHalf ?? CHANNEL_RIM_HALF;
  const WAT = opts.waterHalf ?? CHANNEL_WATER_HALF;
  const BED = opts.bedY ?? CHANNEL_BED_Y;
  const A = edgeMid(entryEdge), B = edgeMid(exitEdge), C = [0, 0];

  // Centreline: a quadratic bezier A → (control = centre) → B sampled at SEG
  // segments, so a bend curves SMOOTHLY through the tile instead of kinking at
  // the centre. (A straight tile stays straight: with B = −A and control 0 the
  // bezier collapses to the A→B line.) Higher SEG = smoother corners.
  const line = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG, mt = 1 - t, wa = mt * mt, wb = 2 * mt * t, wc = t * t;
    line.push([wa * A[0] + wb * C[0] + wc * B[0], wa * A[1] + wb * C[1] + wc * B[1]]);
  }
  const N = line.length - 1; // last index; line[0]=entry mid, line[N]=exit mid

  // Per-sample left-perpendicular. Interior samples use the central-difference
  // tangent; the endpoints use the EDGE direction so the channel mouth lands
  // squarely on the hex edge (oriented to agree with the interior's left side).
  const perp = new Array(N + 1);
  for (let i = 1; i < N; i++) perp[i] = perpOf(norm(sub(line[i + 1], line[i - 1])));
  // At the endpoints the cross-section lies ALONG the hex edge (so the channel
  // mouth sits on the edge), oriented to agree with the interior's left side.
  const orient = (e, ref) => { const d = edgeDir(e); return (d[0] * ref[0] + d[1] * ref[1]) < 0 ? scale(d, -1) : d; };
  perp[0] = orient(entryEdge, perp[1]);
  perp[N] = orient(exitEdge,  perp[N - 1]);

  // Cross-section vertices per sample: rimL, waterL, bedC, waterR, rimR.
  // UVs run U = arc-length ALONG the channel (so the flowing water/dirt texture
  // streams down-river) and V ACROSS the cross-section, with the water art in
  // the middle V band (rim 0/1, water 0.3..0.7) — same V layout the old ribbon
  // used. Grass verts (added later) get local-XZ UVs; the splat material derives
  // its own world-space UV in-shader, so those are only placeholders.
  const positions = [];
  const uvs = [];
  const push = (x, y, z, u, v) => { const i = positions.length / 3; positions.push(x, y, z); uvs.push(u, v); return i; };
  // The bank WALL gets its OWN duplicate rim/water-edge verts (suffixed `w`) so
  // it flat-shades as a sideways slope: shared with the flat grass top / flat
  // bed, ComputeNormals would smooth the wall toward +Y and it would light like
  // a flat (bright, formless) surface. The grass keeps rimL/rimR, the bed keeps
  // watL/watR; only the wall uses the duplicates.
  // The water SURFACE is a translucent layer raised above the (now dirt) bed,
  // filling the basin to SURF_Y so you see the muddy floor faintly through it
  // (depth). SURF_H = the wall's half-width at that height, so the surface meets
  // the banks with only a thin dry dirt rim above the waterline.
  const SURF_Y = BED * 0.62; // water sits low in the channel so a dry dirt bank
                             // (the grass→dirt transition) shows above the waterline
  const SURF_H = RIM + (WAT - RIM) * (SURF_Y / BED);
  const rimL = [], watL = [], bedI = [], watR = [], rimR = [];
  const rimLw = [], watLw = [], watRw = [], rimRw = [];
  const surfL = [], surfC = [], surfR = [];
  const rimLpt = [], rimRpt = []; // XZ for the grass loops
  let arc = 0;
  for (let i = 0; i <= N; i++) {
    if (i > 0) { const d = sub(line[i], line[i - 1]); arc += Math.hypot(d[0], d[1]); }
    const p = line[i], q = perp[i];
    const rl = add(p, scale(q, RIM)), wl = add(p, scale(q, WAT));
    const wr = sub(p, scale(q, WAT)), rr = sub(p, scale(q, RIM));
    const sl = add(p, scale(q, SURF_H)), sr = sub(p, scale(q, SURF_H));
    rimL.push(push(rl[0], 0,   rl[1], arc, 0.0));  rimLpt.push(rl);
    watL.push(push(wl[0], BED, wl[1], arc, 0.3));
    bedI.push(push(p[0],  BED, p[1], arc, 0.5));
    watR.push(push(wr[0], BED, wr[1], arc, 0.7));
    rimR.push(push(rr[0], 0,   rr[1], arc, 1.0));  rimRpt.push(rr);
    rimLw.push(push(rl[0], 0,   rl[1], arc, 0.0));
    watLw.push(push(wl[0], BED, wl[1], arc, 0.3));
    watRw.push(push(wr[0], BED, wr[1], arc, 0.7));
    rimRw.push(push(rr[0], 0,   rr[1], arc, 1.0));
    surfL.push(push(sl[0], SURF_Y, sl[1], arc, 0.25));
    surfC.push(push(p[0],  SURF_Y, p[1],  arc, 0.5));
    surfR.push(push(sr[0], SURF_Y, sr[1], arc, 0.75));
  }

  // Channel strips between consecutive samples.
  const bank = [], river = [], surface = [];
  const quad = (out, a, b, c, d) => { out.push(a, b, c, a, c, d); };
  for (let i = 0; i < N; i++) {
    // Left + right bank walls (rim at Y=0 down to the water line at Y=BED) —
    // their OWN verts so they flat-shade as a slope. Wound so the face normal
    // points UP-and-inward (toward the sky/channel), not down — otherwise the
    // slope can't catch the sun and reads as a flat, formless band.
    quad(bank, watLw[i], watLw[i + 1], rimLw[i + 1], rimLw[i]);
    quad(bank, rimRw[i], rimRw[i + 1], watRw[i + 1], watRw[i]);
    // Flat DIRT bed (two strips, via the centre line so a bend doesn't pinch).
    quad(river, watL[i], bedI[i], bedI[i + 1], watL[i + 1]);
    quad(river, bedI[i], watR[i], watR[i + 1], bedI[i + 1]);
    // Translucent water surface, raised above the bed (same winding as the bed).
    quad(surface, surfL[i], surfC[i], surfC[i + 1], surfL[i + 1]);
    quad(surface, surfC[i], surfR[i], surfR[i + 1], surfC[i + 1]);
  }

  // GRASS — the hex minus the channel band, split into two pieces by the band.
  // Each piece's boundary = one rim polyline + the hex-perimeter arc on that
  // side; ear-clip each. Corners are assigned to a side by which way they fall
  // off the overall flow axis (channel is far from the corners, so the sign is
  // robust even on a bend).
  const flow = norm(sub(B, A));
  const cornerSide = HEX.map((c) => cross2(flow, sub(c, C))); // >0 ⇒ left
  // Walk the perimeter the short way between the two edges to collect each
  // side's corners in boundary order.
  const arcCorners = (fromEdge, toEdge, dir) => {
    const out = [];
    let e = fromEdge;
    for (let s = 0; s < 6; s++) {
      const cornerIdx = dir > 0 ? (e + 1) % 6 : e;       // leading corner of edge e in dir
      if (e === toEdge) break;
      out.push(cornerIdx);
      e = (e + dir + 6) % 6;
    }
    return out;
  };
  // Left grass loop: rimL[0..N] (entry→exit), then perimeter exit→entry on the
  // left. Right loop mirrors it with rimR. Side membership is checked against a
  // representative corner so we pick the correct walk direction.
  const buildSide = (rimPts, rimIdx, wantLeft) => {
    // Pick perimeter walk direction whose collected corners are on `wantLeft`.
    let arc = arcCorners(exitEdge, entryEdge, +1);
    const onLeft = arc.length ? cornerSide[arc[0]] > 0 : wantLeft;
    if (onLeft !== wantLeft) arc = arcCorners(exitEdge, entryEdge, -1);
    const loopXZ = [];
    const loopIdx = [];
    for (let i = 0; i <= N; i++) { loopXZ.push(rimPts[i]); loopIdx.push(rimIdx[i]); }
    for (const ck of arc) {
      const c = HEX[ck];
      loopXZ.push(c);
      loopIdx.push(push(c[0], 0, c[1], c[0], c[1])); // grass UV = local XZ (splat overrides in-shader)
    }
    return earClip(loopXZ).map((li) => loopIdx[li]);
  };
  const grass = [
    ...buildSide(rimLpt, rimL, true),
    ...buildSide(rimRpt, rimR, false),
  ];

  // `flowDir` (canonical entry→exit unit vector) + `flowLen` (channel arc length)
  // let the caller flip the U axis so every tile's water flows the SAME world
  // direction — without this, rotating templates to fit makes some tiles run
  // backwards. Flip by U → flowLen − U when the tile's world flow opposes the
  // river's canonical direction.
  const flowDir = norm(sub(B, A));
  return {
    positions, uvs, grass, bank, river, surface, bedY: BED, surfaceY: SURF_Y, flowDir, flowLen: arc,
    // The two bank-edge polylines (local XZ) with the OUTWARD normal at each
    // point (away from the water, onto the grass) — the renderer scatters rocks
    // in a band from the rim outward so they dissolve into the terrain. Each
    // entry: [x, z, outNx, outNz]. Left rim faces +perp, right rim faces −perp.
    rim: {
      left:  rimLpt.map((p, i) => [p[0], p[1],  perp[i][0],  perp[i][1]]),
      right: rimRpt.map((p, i) => [p[0], p[1], -perp[i][0], -perp[i][1]]),
    },
  };
}

/** The baked shapes as (entryEdge, exitEdge) in the canonical frame. Only TWO
 *  are needed: a "left" bend rotated 240° IS a "right" bend, so one `bend`
 *  template + the 6 hex rotations covers every gentle turn in either direction.
 *  The caller rotates by k·60° to align with a tile's real water-edges. */
export const RIVER_SHAPES = Object.freeze({
  straight: { entryEdge: 0, exitEdge: 3 }, // opposite edges
  bend:     { entryEdge: 0, exitEdge: 2 }, // ±120° turn (rotation gives both directions)
});

/** Classify two water-edge indices into a shape + the rotation (in 60° steps)
 *  that maps the canonical shape's entry edge onto the tile. Rotating template
 *  edge e by `rot` lands on edge (e+rot)%6. Returns null for sharp (adjacent)
 *  or degenerate configs the river never produces. */
export function classifyRiverEdges(edgeA, edgeB) {
  const sep = (((edgeB - edgeA) % 6) + 6) % 6;
  if (sep === 3) return { shape: 'straight', rot: edgeA };           // (a, a+3)
  if (sep === 2) return { shape: 'bend',     rot: edgeA };           // (a, a+2)
  if (sep === 4) return { shape: 'bend',     rot: (edgeA + 4) % 6 }; // (a, a−2) ⇒ canonical from a+4
  return null;                                                       // sharp / same edge
}
