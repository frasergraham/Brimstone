#!/usr/bin/env node
/**
 * Builds the iOS app with xcodebuild using DerivedData in /tmp
 * (avoids iCloud Drive extended-attribute codesign failures),
 * then installs and launches in the iOS Simulator.
 */
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIR = resolve(ROOT, 'ios/App');
const DERIVED_DATA = '/tmp/BrimstoneDerivedData';

// Pick target from argv or auto-select first available iPhone simulator
const targetArg = process.argv[2];

function getTarget() {
  if (targetArg) return targetArg;
  const json = execSync('xcrun simctl list devices available -j', { encoding: 'utf8' });
  const devices = JSON.parse(json).devices;
  for (const [runtime, list] of Object.entries(devices)) {
    if (!runtime.includes('iOS')) continue;
    const iphone = list.find(d => d.name.includes('iPhone'));
    if (iphone) return iphone.udid;
  }
  console.error('No available iPhone simulator found. Pass a target UDID as argument.');
  process.exit(1);
}

const target = getTarget();
console.log(`Target simulator: ${target}`);

// Build
console.log('Building iOS app...');
execSync(
  `xcodebuild -scheme App -configuration Debug ` +
  `-destination "id=${target}" ` +
  `-derivedDataPath "${DERIVED_DATA}" ` +
  `build`,
  { cwd: PROJECT_DIR, stdio: 'inherit' }
);

const appPath = `${DERIVED_DATA}/Build/Products/Debug-iphonesimulator/App.app`;

// Boot simulator (ignore error if already booted)
try { execSync(`xcrun simctl boot ${target}`, { stdio: 'ignore' }); } catch {}

// Install and launch
console.log('Installing and launching...');
execSync(`xcrun simctl install ${target} "${appPath}"`, { stdio: 'inherit' });
execSync(`xcrun simctl launch ${target} com.brimstone.game`, { stdio: 'inherit' });
execSync('open -a Simulator', { stdio: 'ignore' });

console.log('✔ App launched in simulator');
