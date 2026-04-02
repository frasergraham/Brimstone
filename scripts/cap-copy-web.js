#!/usr/bin/env node
/**
 * Copies web assets into www/ for Capacitor builds.
 * Since Brimstone has no build step, this is a simple file copy
 * of the directories and files the client needs.
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WWW  = resolve(ROOT, 'www');

// Clean previous build
if (existsSync(WWW)) rmSync(WWW, { recursive: true });
mkdirSync(WWW, { recursive: true });

// Directories to copy (relative to project root)
const dirs = ['src', 'assets', 'server'];
for (const dir of dirs) {
  cpSync(resolve(ROOT, dir), resolve(WWW, dir), { recursive: true });
}

// Individual files
const files = ['index.html', 'styles.css'];
for (const file of files) {
  cpSync(resolve(ROOT, file), resolve(WWW, file));
}

console.log('✔ Web assets copied to www/');
