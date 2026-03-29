// Tests for the release script helpers and CHANGELOG/version integration.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, BUILD_VERSION } from '../src/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Version file ──────────────────────────────────────────────────────────────

describe('Version file', () => {
  test('src/version.js exports a valid semver string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/,
      `VERSION "${VERSION}" is not a valid semver string`);
  });

  test('version string is non-empty', () => {
    assert.ok(VERSION.length > 0);
  });

  test('BUILD_VERSION equals VERSION when RAILWAY_GIT_COMMIT_SHA is unset', () => {
    if (!process.env.RAILWAY_GIT_COMMIT_SHA) {
      assert.equal(BUILD_VERSION, VERSION,
        'BUILD_VERSION should equal VERSION in local dev');
    }
  });

  test('BUILD_VERSION starts with VERSION', () => {
    assert.ok(BUILD_VERSION.startsWith(VERSION),
      `BUILD_VERSION "${BUILD_VERSION}" must start with VERSION "${VERSION}"`);
  });

  test('BUILD_VERSION matches semver or semver+hash format', () => {
    assert.match(BUILD_VERSION, /^\d+\.\d+\.\d+(\+[a-f0-9]{8})?$/,
      `BUILD_VERSION "${BUILD_VERSION}" must be semver or semver+shortsha`);
  });
});

// ── CHANGELOG.json ────────────────────────────────────────────────────────────

describe('CHANGELOG.json', () => {
  let changelog;

  test('CHANGELOG.json exists and is valid JSON', () => {
    const raw = readFileSync(resolve(ROOT, 'CHANGELOG.json'), 'utf8');
    changelog = JSON.parse(raw);
    assert.ok(Array.isArray(changelog), 'CHANGELOG.json must be an array');
  });

  test('has at least one release entry', () => {
    const raw = readFileSync(resolve(ROOT, 'CHANGELOG.json'), 'utf8');
    changelog = JSON.parse(raw);
    assert.ok(changelog.length >= 1, 'Must have at least one release entry');
  });

  test('each entry has required fields', () => {
    const raw = readFileSync(resolve(ROOT, 'CHANGELOG.json'), 'utf8');
    changelog = JSON.parse(raw);
    for (const entry of changelog) {
      assert.ok(typeof entry.version === 'string', `Missing version: ${JSON.stringify(entry)}`);
      assert.match(entry.version, /^\d+\.\d+\.\d+$/, `Invalid version: ${entry.version}`);
      assert.ok(typeof entry.date === 'string', `Missing date: ${entry.version}`);
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `Invalid date format: ${entry.date}`);
      assert.ok(typeof entry.summary === 'string', `Missing summary: ${entry.version}`);
      assert.ok(Array.isArray(entry.notes), `Missing notes array: ${entry.version}`);
      assert.ok(entry.notes.length > 0, `Empty notes: ${entry.version}`);
    }
  });

  test('most recent entry version matches src/version.js', () => {
    const raw = readFileSync(resolve(ROOT, 'CHANGELOG.json'), 'utf8');
    changelog = JSON.parse(raw);
    assert.equal(changelog[0].version, VERSION,
      `CHANGELOG first entry (${changelog[0].version}) must match VERSION (${VERSION})`);
  });
});

// ── Release script ────────────────────────────────────────────────────────────

describe('Release script', () => {
  test('--dry-run patch shows version bump without writing', () => {
    const output = execSync(
      'node scripts/release.js --dry-run patch',
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.match(output, /Version:.*→/, 'Should display version bump');
    assert.match(output, /dry run/, 'Should indicate dry run');

    // Verify files were NOT modified
    const versionAfter = readFileSync(resolve(ROOT, 'src/version.js'), 'utf8');
    assert.ok(versionAfter.includes(`'${VERSION}'`),
      'Version file should not change on dry run');
  });

  test('--dry-run minor bumps minor version correctly', () => {
    const output = execSync(
      'node scripts/release.js --dry-run minor',
      { cwd: ROOT, encoding: 'utf8' },
    );
    const [major, minor] = VERSION.split('.').map(Number);
    const expected = `${major}.${minor + 1}.0`;
    assert.ok(output.includes(expected),
      `Should bump to ${expected}, got: ${output.split('\n')[0]}`);
  });

  test('--dry-run major bumps major version correctly', () => {
    const output = execSync(
      'node scripts/release.js --dry-run major',
      { cwd: ROOT, encoding: 'utf8' },
    );
    const [major] = VERSION.split('.').map(Number);
    const expected = `${major + 1}.0.0`;
    assert.ok(output.includes(expected),
      `Should bump to ${expected}, got: ${output.split('\n')[0]}`);
  });

  test('exits with error when no level argument is given', () => {
    assert.throws(() => {
      execSync('node scripts/release.js 2>&1', { cwd: ROOT, encoding: 'utf8' });
    }, /./);
  });

  test('generates release notes with bullet points', () => {
    const output = execSync(
      'node scripts/release.js --dry-run patch',
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.match(output, /- .+/, 'Should contain at least one release note bullet');
  });

  test('non-dry-run rejects when not on dev branch', () => {
    // We are running tests on a feature branch, not dev, so this should fail
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT, encoding: 'utf8',
    }).trim();

    if (branch !== 'dev') {
      assert.throws(() => {
        execSync('node scripts/release.js patch 2>&1', {
          cwd: ROOT, encoding: 'utf8',
        });
      }, /./,
      'Should reject release when not on dev branch');
    }
  });

  test('--dry-run skips branch check', () => {
    // dry-run should work on any branch
    const output = execSync(
      'node scripts/release.js --dry-run patch',
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.match(output, /dry run/);
  });
});

// ── HTML structure ────────────────────────────────────────────────────────────

describe('Revision history HTML', () => {
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

  test('version badge element exists and is a link', () => {
    assert.match(html, /<a[^>]+id="version-badge"/, 'Version badge should be an <a> element');
    assert.match(html, /version-link/, 'Version badge should have version-link class');
  });

  test('changelog card exists with required elements', () => {
    assert.match(html, /id="setup-step-changelog"/, 'Changelog card must exist');
    assert.match(html, /id="changelog-body"/, 'Changelog body container must exist');
    assert.match(html, /id="btn-changelog-back"/, 'Changelog back button must exist');
  });
});
