#!/usr/bin/env node
// Release promotion script: bumps version on dev, generates customer-friendly
// release notes, commits, tags, and fast-forward merges to the prod branch.
//
// Usage:
//   node scripts/release.js patch            # 1.0.4 → 1.0.5
//   node scripts/release.js minor            # 1.0.4 → 1.1.0
//   node scripts/release.js major            # 1.0.4 → 2.0.0
//   node scripts/release.js --dry-run patch  # preview without writing or committing
//
// Flow:
//   1. Verifies you are on the dev branch with a clean working tree
//   2. Reads the current version from src/version.js
//   3. Bumps it according to the semver level
//   4. Collects git commits since the last version tag (or all if no tag)
//   5. Generates customer-friendly release notes (groups by feat/fix/chore)
//   6. Prepends the new release to CHANGELOG.json
//   7. Writes the bumped version to src/version.js
//   8. Commits the release on dev and tags it
//   9. Fast-forward merges dev into the prod branch
//  10. Returns to dev
//
// The version bump originates on dev and flows forward — no back-merge needed.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DEV_BRANCH  = 'dev';
const PROD_BRANCH = 'prod';

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(cmd, opts = {}) {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const level = args.find(a => ['patch', 'minor', 'major'].includes(a));

if (!level) {
  console.error('Usage: node scripts/release.js [--dry-run] <patch|minor|major>');
  process.exit(1);
}

// ── Pre-flight checks ────────────────────────────────────────────────────────

if (!dryRun) {
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (branch !== DEV_BRANCH) {
    die(`Must be on '${DEV_BRANCH}' branch to release (currently on '${branch}').\n` +
        `  Run: git checkout ${DEV_BRANCH}`);
  }

  const status = git('status --porcelain');
  if (status) {
    die('Working tree is not clean. Commit or stash your changes first.\n' +
        git('status --short'));
  }
}

// ── Read current version ──────────────────────────────────────────────────────

const VERSION_FILE = resolve(ROOT, 'src/version.js');
const versionSrc = readFileSync(VERSION_FILE, 'utf8');
const versionMatch = versionSrc.match(/VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
if (!versionMatch) {
  die('Could not parse version from src/version.js');
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
  let range;
  try {
    const lastTag = git('describe --tags --abbrev=0 2>/dev/null');
    range = `${lastTag}..HEAD`;
    console.log(`Collecting commits since tag: ${lastTag}`);
  } catch {
    range = 'HEAD';
    console.log('No previous version tag found — using full history');
  }

  const raw = git(`log ${range} --pretty=format:"%s" --no-merges`);
  return raw ? raw.split('\n') : [];
}

const commits = getCommitsSinceLastTag();

if (commits.length === 0) {
  console.log('No new commits found since last tag. Nothing to release.');
  process.exit(0);
}

console.log(`Found ${commits.length} commit(s) to summarize.\n`);

// ── Categorize commits ────────────────────────────────────────────────────────

const CATEGORIES = [
  { prefix: /^feat[:(]/i,     label: 'New Features' },
  { prefix: /^fix[:(]/i,      label: 'Bug Fixes' },
  { prefix: /^perf[:(]/i,     label: 'Performance' },
  { prefix: /^refactor[:(]/i, label: 'Improvements' },
  { prefix: /^chore[:(]/i,    label: 'Maintenance' },
  { prefix: /^docs[:(]/i,     label: 'Documentation' },
  { prefix: /^test[:(]/i,     label: 'Testing' },
  { prefix: /^style[:(]/i,    label: 'Visual' },
];

function categorize(commitMessages) {
  const groups = new Map();
  const uncategorized = [];

  for (const msg of commitMessages) {
    let matched = false;
    for (const cat of CATEGORIES) {
      if (cat.prefix.test(msg)) {
        if (!groups.has(cat.label)) groups.set(cat.label, []);
        groups.get(cat.label).push(cleanMessage(msg));
        matched = true;
        break;
      }
    }
    if (!matched) {
      uncategorized.push(cleanMessage(msg));
    }
  }

  if (uncategorized.length > 0) {
    groups.set('Other Changes', uncategorized);
  }

  return groups;
}

function cleanMessage(msg) {
  let cleaned = msg.replace(/^\w+(\([^)]*\))?[:\s]+/, '');
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return cleaned;
}

const grouped = categorize(commits);

// ── Generate customer-friendly notes ──────────────────────────────────────────

function generateNotes(groups) {
  const notes = [];
  const order = [
    'New Features', 'Bug Fixes', 'Performance', 'Improvements',
    'Visual', 'Other Changes', 'Maintenance', 'Documentation', 'Testing',
  ];

  for (const label of order) {
    if (groups.has(label)) {
      for (const note of groups.get(label)) notes.push(note);
    }
  }

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

// ── Write files ──────────────────────────────────────────────────────────────

const CHANGELOG_FILE = resolve(ROOT, 'CHANGELOG.json');
let changelog;
try {
  changelog = JSON.parse(readFileSync(CHANGELOG_FILE, 'utf8'));
} catch {
  changelog = [];
}

const today = new Date().toISOString().slice(0, 10);
changelog.unshift({ version: newVersion, date: today, summary, notes });
writeFileSync(CHANGELOG_FILE, JSON.stringify(changelog, null, 2) + '\n');
console.log('Updated CHANGELOG.json');

const newVersionSrc = versionSrc.replace(
  /VERSION\s*=\s*'[^']+'/,
  `VERSION = '${newVersion}'`,
);
writeFileSync(VERSION_FILE, newVersionSrc);
console.log(`Updated src/version.js → ${newVersion}`);

// Also bump package.json version so electron-updater stays in sync
const PKG_FILE = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(PKG_FILE, 'utf8'));
pkg.version = newVersion;
writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Updated package.json → ${newVersion}`);

// ── Commit, tag, and promote ─────────────────────────────────────────────────

const tag = `v${newVersion}`;

console.log(`\nCommitting release on ${DEV_BRANCH}...`);
git('add src/version.js CHANGELOG.json package.json');
git(`commit -m "release: ${tag}"`);
git(`tag ${tag}`);
console.log(`Created commit and tag ${tag} on ${DEV_BRANCH}`);

console.log(`\nFast-forward merging ${DEV_BRANCH} → ${PROD_BRANCH}...`);
git(`checkout ${PROD_BRANCH}`);
try {
  git(`merge --ff-only ${DEV_BRANCH}`);
  console.log(`${PROD_BRANCH} is now at ${tag}`);
} catch (err) {
  // Return to dev before dying
  git(`checkout ${DEV_BRANCH}`);
  die(
    `Fast-forward merge failed — ${PROD_BRANCH} has diverged from ${DEV_BRANCH}.\n` +
    `Resolve manually:\n` +
    `  git checkout ${PROD_BRANCH}\n` +
    `  git merge ${DEV_BRANCH}\n` +
    `  git checkout ${DEV_BRANCH}`
  );
}

git(`checkout ${DEV_BRANCH}`);
console.log(`Returned to ${DEV_BRANCH}`);

// ── Push ─────────────────────────────────────────────────────────────────────

console.log(`\nRelease ${tag} ready. Push with:`);
console.log(`  git push origin ${DEV_BRANCH} ${PROD_BRANCH} --tags`);
