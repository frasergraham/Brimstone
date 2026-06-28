// Generates hex-coords.svg — a pointy-top hex with its 6 neighbour directions.
// Direction indices match src/hex.js: 0=W 1=NW 2=NE 3=E 4=SE 5=SW.
import { writeFileSync } from 'node:fs';

const r = 58;                       // centre→vertex
const w = Math.sqrt(3) * r;         // same-row horizontal spacing
const vy = 1.5 * r;                 // row vertical spacing
const cx = 330, cy = 250;

// pointy-top vertices (y-down screen coords)
function hexPath(x, y) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (90 + 60 * i);
    pts.push([x + r * Math.cos(a), y - r * Math.sin(a)]);
  }
  return pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
}

const neighbours = [
  { name: 'W',  idx: 0, dx: -w,    dy: 0 },
  { name: 'NW', idx: 1, dx: -w / 2, dy: -vy },
  { name: 'NE', idx: 2, dx:  w / 2, dy: -vy },
  { name: 'E',  idx: 3, dx:  w,     dy: 0 },
  { name: 'SE', idx: 4, dx:  w / 2, dy:  vy },
  { name: 'SW', idx: 5, dx: -w / 2, dy:  vy },
];

let cells = '';
for (const n of neighbours) {
  const x = cx + n.dx, y = cy + n.dy;
  cells += `
    <polygon points="${hexPath(x, y)}" fill="#eef2f7" stroke="#5b6b7d" stroke-width="2"/>
    <text x="${x}" y="${y - 6}" font-size="22" font-weight="700" fill="#3f6f9f" text-anchor="middle" font-family="Helvetica">${n.idx}</text>
    <text x="${x}" y="${y + 18}" font-size="15" fill="#5b6b7d" text-anchor="middle" font-family="Helvetica">${n.name}</text>`;
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="660" height="520" viewBox="0 0 660 520">
  <rect width="660" height="520" fill="white"/>
  <text x="330" y="34" font-size="20" font-weight="700" fill="#222" text-anchor="middle" font-family="Helvetica">Hex Grid — pointy-top, odd-r offset coordinates</text>
  <text x="330" y="58" font-size="13" fill="#666" text-anchor="middle" font-family="Helvetica">Direction index is stable across rows · opposite of d is (d+3) mod 6 · key = "col,row"</text>
  ${cells}
  <polygon points="${hexPath(cx, cy)}" fill="#ffd75e" stroke="#d6a821" stroke-width="3"/>
  <text x="${cx}" y="${cy - 4}" font-size="18" font-weight="700" fill="#7a5a10" text-anchor="middle" font-family="Helvetica">(col,row)</text>
  <text x="${cx}" y="${cy + 18}" font-size="13" fill="#7a5a10" text-anchor="middle" font-family="Helvetica">self</text>
  <text x="330" y="498" font-size="13" fill="#888" text-anchor="middle" font-family="Helvetica">distance = cube distance on axial coords · sight uses hexLine() LOS (forest + building footprint block)</text>
</svg>`;

writeFileSync(new URL('./hex-coords.svg', import.meta.url), svg);
console.log('wrote hex-coords.svg');
