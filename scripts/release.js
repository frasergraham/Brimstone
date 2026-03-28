#!/usr/bin/env node
// Release promotion script: bumps version, generates customer-friendly release
// notes from git history, and updates CHANGELOG.json.
//
// Usage:
//   node scripts/release.js patch          # 1.0.4 → 1.0.5
//   node scripts/release.js minor          # 1.0.4 → 1.1.0
//   node scripts/release.js major          # 1.0.4 → 2.0.0
//   node scripts/release.js --dry-run patch # preview without writing
//
// What it does:
//   1. Reads the current version from src/version.js
//   2. Bumps it according to the semver level
//   3. Collects git commits since the last version tag (or all commits if no tag)
//   4. Generates customer-friendly release notes (groups by feat/fix/chore)
//   5. Prepends the new release to CHANGELOG.json
//   6. Writes the bumped version to src/version.js
//   7. Prints a summary of changes

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const level = args.find(a => ['patch', 'minor', 'major'].includes(a));

if (!level) {
  console.error('Usage: node scripts/release.js [--dry-run] <patch|minor|major>');
  process.exit(1);
}

// ── Read current version ──────────────────────────────────────────────────────

const VERSION_FILE = resolve(ROOT, 'src/version.js');
const versionSrc = readFileSync(VERSION_FILE, 'utf8');
const versionMatch = versionSrc.match(/VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
if (!versionMatch) {
  console.error('Could not parse version from src/version.js');
  process.exit(1);
}
const currentVersion = versionMatch[1];

// ── Bump version ──────────────────────────────────────────────────────────────

function bumpVersion(ver, bumpLevel) {
  const [major, minor, patch] = ver.split('.').map(Number);
  switch (bumpLevel) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

const newVersion = bumpVersion(currentVersion, level);
console.log(`Version: ${currentVersion} → ${newVersion} (${level})`);

// ── Collect git commits since last tag ────────────────────────────────────────

function getCommitsSinceLastTag() {
  // Find the latest version tag (v1.0.4, v1.0.3, etc.)
  let range;
  try {
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null', {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    range = `${lastTag}..HEAD`;
    console.log(`Collecting commits since tag: ${lastTag}`);
  } catch {
    // No tags yet — use all commits
    range = 'HEAD';
    console.log('No previous version tag found — using full history');
  }

  const raw = execSync(
    `git log ${range} --pretty=format:"%s" --no-merges`,
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();

  return raw ? raw.split('\n') : [];
}

const commits = getCommitsSinceLastTag();

if (commits.length === 0) {
  console.log('No new commits found since last tag. Nothing to release.');
  process.exit(0);
}

console.log(`Found ${commits.length} commit(s) to summarize.\n`);

// ── Categorize commits ────────────────────────────────────────────────────────

// Conventional-commit prefix → customer-friendly category
const CATEGORIES = [
  { prefix: /^feat[:(]/i,    label: 'New Features',  icon: 'new' },
  { prefix: /^fix[:(]/i,     label: 'Bug Fixes',     icon: 'fix' },
  { prefix: /^perf[:(]/i,    label: 'Performance',   icon: 'perf' },
  { prefix: /^refactor[:(]/i, label: 'Improvements', icon: 'improve' },
  { prefix: /^chore[:(]/i,   label: 'Maintenance',   icon: 'chore' },
  { prefix: /^docs[:(]/i,    label: 'Documentation', icon: 'docs' },
  { prefix: /^test[:(]/i,    label: 'Testing',       icon: 'test' },
  { prefix: /^style[:(]/i,   label: 'Visual',        icon: 'style' },
];

function categorize(commits) {
  const groups = new Map();  // label → messages[]
  const uncategorized = [];

  for (const msg of commits) {
    let matched = false;
    for (const cat of CATEGORIES) {
      if (cat.prefix.test(msg)) {
        const cleaned = cleanMessage(msg);
        if (!groups.has(cat.label)) groups.set(cat.label, []);
        groups.get(cat.label).push(cleaned);
        matched = true;
        break;
      }
    }
    if (!matched) {
      uncategorized.push(cleanMessage(msg));
    }
  }

  // Put uncategorized commits under "Other Changes"
  if (uncategorized.length > 0) {
    groups.set('Other Changes', uncategorized);
  }

  return groups;
}

function cleanMessage(msg) {
  // Strip conventional-commit prefix: "feat: foo bar" → "Foo bar"
  // Also handle "feat(scope): msg" format
  let cleaned = msg.replace(/^\w+(\([^)]*\))?[:\s]+/, '');
  // Capitalize first letter
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return cleaned;
}

const grouped = categorize(commits);

// ── Generate customer-friendly notes ──────────────────────────────────────────

function generateNotes(groups) {
  const notes = [];
  // Preferred display order
  const order = [
    'New Features', 'Bug Fixes', 'Performance', 'Improvements',
    'Visual', 'Other Changes', 'Maintenance', 'Documentation', 'Testing',
  ];

  for (const label of order) {
    if (groups.has(label)) {
      for (const note of groups.get(label)) {
        notes.push(note);
      }
    }
  }

  // Catch any labels not in the order list
  for (const [label, items] of groups) {
    if (!order.includes(label)) {
      for (const note of items) notes.push(note);
    }
  }

  return notes;
}

function generateSummary(groups) {
  const parts = [];
  if (groups.has('New Features'))  parts.push('new features');
  if (groups.has('Bug Fixes'))     parts.push('bug fixes');
  if (groups.has('Performance'))   parts.push('performance improvements');
  if (groups.has('Improvements'))  parts.push('improvements');
  if (groups.has('Visual'))        parts.push('visual updates');

  if (parts.length === 0) return 'Maintenance and improvements';

  // "New features, bug fixes, and improvements"
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const last = parts.pop();
  return (parts.join(', ') + ', and ' + last).replace(/^./, c => c.toUpperCase());
}

const notes = generateNotes(grouped);
const summary = generateSummary(grouped);

// ── Print preview ─────────────────────────────────────────────────────────────

console.log(`── v${newVersion} Release Notes ──`);
console.log(`Summary: ${summary}\n`);
for (const note of notes) {
  console.log(`  - ${note}`);
}
console.log('');

if (dryRun) {
  console.log('(dry run — no files written)');
  process.exit(0);
}

// ── Update CHANGELOG.json ─────────────────────────────────────────────────────

const CHANGELOG_FILE = resolve(ROOT, 'CHANGELOG.json');
let changelog;
try {
  changelog = JSON.parse(readFileSync(CHANGELOG_FILE, 'utf8'));
} catch {
  changelog = [];
}

const today = new Date().toISOString().slice(0, 10);
const newEntry = {
  version: newVersion,
  date: today,
  summary,
  notes,
};

// Prepend new release at the top
changelog.unshift(newEntry);
writeFileSync(CHANGELOG_FILE, JSON.stringify(changelog, null, 2) + '\n');
console.log(`Updated CHANGELOG.json`);

// ── Update src/version.js ─────────────────────────────────────────────────────

const newVersionSrc = versionSrc.replace(
  /VERSION\s*=\s*'[^']+'/,
  `VERSION = '${newVersion}'`,
);
writeFileSync(VERSION_FILE, newVersionSrc);
console.log(`Updated src/version.js → ${newVersion}`);

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`\nRelease v${newVersion} prepared. Next steps:`);
console.log(`  1. Review changes:  git diff`);
console.log(`  2. Run tests:       npm test`);
console.log(`  3. Commit:          git add -A && git commit -m "release: v${newVersion}"`);
console.log(`  4. Tag:             git tag v${newVersion}`);
console.log(`  5. Push:            git push && git push --tags`);
