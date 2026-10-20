#!/usr/bin/env node
// Installs the office's adapters for agents that need one, so they show up as
// contractors:
//
//   node scripts/install-adapters.mjs hermes            # ~/.hermes/hooks/agent-office
//   node scripts/install-adapters.mjs hermes --name Jarvis
//   node scripts/install-adapters.mjs hermes --uninstall
//
// OpenClaw and Claude Code need nothing here: the office reads their session
// transcripts itself (Claude Code's waiting state comes from install-hooks.mjs).
// Run this after the office has started once, so its observe key exists.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { target } from '../bin/observe-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const which = args[0];
const uninstall = args.includes('--uninstall');
const nameAt = args.indexOf('--name');
const name = nameAt >= 0 ? String(args[nameAt + 1] || '').slice(0, 40) : '';

if (which !== 'hermes') {
  console.error('usage: install-adapters.mjs hermes [--name <shown name>] [--uninstall]');
  process.exit(64);
}

const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const dest = path.join(home, 'hooks', 'agent-office');
if (uninstall) {
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`Removed ${dest}. Restart the Hermes gateway to drop it.`);
  process.exit(0);
}

const where = target();
if (!where) {
  console.error('Start the office once first (it makes the observe key), or set OFFICE_DATA to its data folder.');
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });
for (const f of ['HOOK.yaml', 'handler.py']) fs.copyFileSync(path.join(HERE, '..', 'adapters', 'hermes', 'agent-office', f), path.join(dest, f));
fs.writeFileSync(path.join(dest, 'office.json'), JSON.stringify({ url: where.url, key: where.key, ...(name && { name }) }, null, 2) + '\n', { mode: 0o600 });
console.log(`Hermes adapter installed in ${dest}. Restart the Hermes gateway to load it.`);
