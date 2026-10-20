#!/usr/bin/env node
// Adds the office's observer hooks to Claude Code's user settings, so every
// Claude Code session on this machine tells the office when it needs you,
// when it's done, and when it closes.
//
//   node scripts/install-hooks.mjs              # install (or refresh)
//   node scripts/install-hooks.mjs --uninstall  # take them out again
//   node scripts/install-hooks.mjs --data DIR   # the office's data folder, if not the usual
//
// Other hooks in the file are left alone, and the old file is kept as
// settings.json.bak-<time>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'bin', 'office-observe.js');
const EVENTS = ['UserPromptSubmit', 'Notification', 'PermissionRequest', 'Stop', 'SessionEnd'];
const MARK = 'office-observe.js';

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const dataAt = args.indexOf('--data');
const data = dataAt >= 0 ? path.resolve(args[dataAt + 1]) : null;
const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

let settings = {};
if (fs.existsSync(file)) {
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { console.error(`${file} isn't valid JSON (${err.message}); fix it first.`); process.exit(1); }
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
}

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const command = `${q(process.execPath)} ${q(SCRIPT)}${data ? ` --data ${q(data)}` : ''}`;
const hooks = settings.hooks || {};
for (const ev of Object.keys(hooks)) {
  // Take ours out of every event, keeping everyone else's.
  hooks[ev] = (hooks[ev] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) })).filter((m) => m.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (!uninstall) {
  for (const ev of EVENTS) (hooks[ev] ||= []).push({ hooks: [{ type: 'command', command, timeout: 5 }] });
}
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? `Removed the office hooks from ${file}.` : `Office hooks installed in ${file} for: ${EVENTS.join(', ')}.\nNew Claude Code sessions pick them up; running ones after a restart.`);
