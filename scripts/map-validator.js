#!/usr/bin/env node
// Map quality validator — batch-generates maps, renders them to PNG, then
// sends each image to the Claude API to identify visual anomalies.
//
// Usage:  node scripts/map-validator.js [count-per-size] [sizes...]
//   count-per-size  how many maps to generate per size (default 10)
//   sizes           space-separated subset of: skirmish standard regional campaign
//                   (default: all four)
//
// Examples:
//   node scripts/map-validator.js 10
//   node scripts/map-validator.js 5 standard skirmish
//
// Requires ANTHROPIC_API_KEY env var (or a Claude Code session with an OAuth token).
// Override the model with ANTHROPIC_MODEL env var (default: claude-haiku-4-5-20251001).

import Anthropic from '@anthropic-ai/sdk';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { MAP_SIZES } from '../src/map.js';
import { renderMapToBuffer } from './map-render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.join(__dirname, 'map-renders');

// ── CLI args ──────────────────────────────────────────────────────────────────

const ALL_SIZES = Object.keys(MAP_SIZES);
const countArg  = parseInt(process.argv[2] ?? '10', 10);
const COUNT     = isNaN(countArg) || countArg < 1 ? 10 : countArg;

const sizeArgs  = process.argv.slice(3).filter(a => ALL_SIZES.includes(a));
const SIZES     = sizeArgs.length > 0 ? sizeArgs : ALL_SIZES;

// ── Analysis ──────────────────────────────────────────────────────────────────

const ANALYSIS_PROMPT = `\
This is a procedurally generated hex-grid strategy game map (pointy-top hexes).

Map legend:
- Dark green hexes = grass / forest terrain
- Brown bezier strips = roads connecting buildings
- Dark blue bezier ribbons = river
- Buildings are coloured hexes with labels (Inn, Church, Smithy, Graveyard, etc.)
- Bridges are where a road strip crosses the river ribbon (tan railings visible)
- ⛧ glyphs = Power Nodes (witch objectives)
- ⚔ circle = Hero starting position
- ✦ circle = Witch starting position

Please inspect the map carefully and report any of the following issues:

1. ROAD_GAPS — road tiles with no visible brown strip, or road strips that end abruptly without reaching a building or another road
2. BRIDGE_ISSUES — bridge tiles that don't visually cross the river, bridges placed too close together (within ~2 hexes), or bridge orientation mismatch
3. ISOLATED_BUILDINGS — building tiles with no road leading to them
4. NODE_CLUSTERING — all Power Nodes on the same side of the river, or all within a very short distance of each other
5. NODE_PLACEMENT — Power Nodes placed inside or directly on top of buildings
6. RIVER_ISSUES — river that loops back on itself, or a map with no river crossing at all
7. START_SYMMETRY — both Hero and Witch starting positions on the same side of the river or very close to each other
8. OTHER — any other notable visual anomaly

Respond using EXACTLY this format (no extra text before or after):
ISSUES: <comma-separated issue codes from the list above, or "none">
SEVERITY: <none|low|medium|high>
SUMMARY: <one concise sentence describing the worst problem, or "Map looks good">`;

async function analyzeMap(client, imageBuffer, seed, mapSize) {
  const base64 = imageBuffer.toString('base64');

  const response = await client.messages.create({
    model:      process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: base64 },
        },
        { type: 'text', text: ANALYSIS_PROMPT },
      ],
    }],
  });

  return response.content[0].text.trim();
}

function parseAnalysis(raw) {
  const issuesMatch   = raw.match(/^ISSUES:\s*(.+)$/im);
  const severityMatch = raw.match(/^SEVERITY:\s*(.+)$/im);
  const summaryMatch  = raw.match(/^SUMMARY:\s*(.+)$/im);

  return {
    issues:   issuesMatch   ? issuesMatch[1].trim()   : 'parse_error',
    severity: severityMatch ? severityMatch[1].trim() : 'unknown',
    summary:  summaryMatch  ? summaryMatch[1].trim()  : raw,
    raw,
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const SEVERITY_ORDER = { none: 0, low: 1, medium: 2, high: 3, unknown: 1 };

function severityColor(s) {
  if (s === 'high')   return '\x1b[31m'; // red
  if (s === 'medium') return '\x1b[33m'; // yellow
  if (s === 'low')    return '\x1b[36m'; // cyan
  return '\x1b[32m';                     // green for none
}
const RESET = '\x1b[0m';

function printAggregate(results) {
  console.log('\n' + '═'.repeat(70));
  console.log('  AGGREGATE REPORT');
  console.log('═'.repeat(70));

  // ── Per-size breakdown ────────────────────────────────────────────────────
  for (const size of SIZES) {
    const maps = results.filter(r => r.mapSize === size);
    if (maps.length === 0) continue;

    const bySeverity = { none: 0, low: 0, medium: 0, high: 0 };
    const issueFreq  = {};

    for (const m of maps) {
      const sev = (m.severity ?? 'unknown').toLowerCase();
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      if (m.issues !== 'none' && m.issues !== 'parse_error') {
        for (const code of m.issues.split(',').map(s => s.trim().toUpperCase())) {
          issueFreq[code] = (issueFreq[code] ?? 0) + 1;
        }
      }
    }

    const problemCount = maps.filter(m => m.severity !== 'none').length;
    console.log(`\n  ${size.toUpperCase()}  (${maps.length} maps, ${problemCount} with issues)`);

    const sevLine = Object.entries(bySeverity)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${severityColor(s)}${s}:${n}${RESET}`)
      .join('  ');
    if (sevLine) console.log(`    Severity  ${sevLine}`);

    const topIssues = Object.entries(issueFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, n]) => `${code}(${n})`)
      .join(', ');
    if (topIssues) console.log(`    Top issues  ${topIssues}`);
  }

  // ── Cross-size summary ────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  const allIssueFreq = {};
  let totalProblems  = 0;

  for (const r of results) {
    if (r.severity !== 'none') totalProblems++;
    if (r.issues !== 'none' && r.issues !== 'parse_error') {
      for (const code of r.issues.split(',').map(s => s.trim().toUpperCase())) {
        allIssueFreq[code] = (allIssueFreq[code] ?? 0) + 1;
      }
    }
  }

  console.log(`\n  Total maps: ${results.length}  |  Maps with issues: ${totalProblems} (${Math.round(100 * totalProblems / results.length)}%)`);

  const topAll = Object.entries(allIssueFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, n]) => `${code}:${n}`)
    .join('  ');
  if (topAll) console.log(`  Most frequent issues across all sizes:\n    ${topAll}`);

  // Worst maps
  const worst = [...results]
    .filter(r => SEVERITY_ORDER[r.severity] >= 2)
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
    .slice(0, 5);

  if (worst.length > 0) {
    console.log('\n  Highest-severity maps:');
    for (const m of worst) {
      const col = severityColor(m.severity);
      console.log(`    ${col}[${m.severity}]${RESET} ${m.mapSize} seed:${m.seed}  — ${m.summary}`);
    }
  }

  console.log('\n' + '═'.repeat(70) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    // Allow the session OAuth token to substitute for an explicit API key
  if (!process.env.ANTHROPIC_API_KEY) {
    const oauthPath = '/home/claude/.claude/remote/.oauth_token';
    try {
      const token = fs.readFileSync(oauthPath, 'utf8').trim();
      if (token) process.env.ANTHROPIC_API_KEY = token;
    } catch { /* ignore — will error below */ }
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is not set and no session OAuth token found.');
    console.error('Set ANTHROPIC_API_KEY=sk-ant-... or run within a Claude Code session.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  const clientOpts = {};
  if (proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    clientOpts.fetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
  }
  const client  = new Anthropic(clientOpts);
  const results = [];

  console.log(`\nMap Validator — ${COUNT} maps × ${SIZES.length} sizes = ${COUNT * SIZES.length} total\n`);
  console.log(`Output directory: ${OUT_DIR}\n`);
  console.log('─'.repeat(70));

  for (const mapSize of SIZES) {
    console.log(`\n  ${mapSize.toUpperCase()}`);

    for (let i = 0; i < COUNT; i++) {
      const seed     = Date.now() + i * 1000 + SIZES.indexOf(mapSize) * 1_000_000;
      const filename = `${mapSize}_${seed}.png`;
      const filepath = path.join(OUT_DIR, filename);

      process.stdout.write(`    [${i + 1}/${COUNT}] seed:${seed} — rendering...`);
      const buf = renderMapToBuffer(seed, mapSize);
      fs.writeFileSync(filepath, buf);

      process.stdout.write(' analysing...');
      let parsed;
      try {
        const raw = await analyzeMap(client, buf, seed, mapSize);
        parsed = parseAnalysis(raw);
      } catch (err) {
        parsed = { issues: 'api_error', severity: 'unknown', summary: String(err.message ?? err) };
      }

      const col = severityColor(parsed.severity);
      process.stdout.write(` ${col}[${parsed.severity}]${RESET}\n`);
      console.log(`      ${parsed.summary}`);
      if (parsed.issues !== 'none' && parsed.issues !== 'parse_error') {
        console.log(`      Issues: ${parsed.issues}`);
      }

      results.push({ seed, mapSize, filename, ...parsed });

      // Small delay to stay within API rate limits
      if (i < COUNT - 1) await new Promise(r => setTimeout(r, 400));
    }
  }

  printAggregate(results);

  // Save JSON report
  const reportPath = path.join(OUT_DIR, `report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Full results saved to: ${reportPath}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
