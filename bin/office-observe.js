#!/usr/bin/env node
// A Claude Code hook: passes the hook's input on to the office, which turns
// it into "this session needs you" or "this session is done". Installed by
// scripts/install-hooks.mjs. Prints nothing (a UserPromptSubmit hook's output
// would land in the session's context) and always exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { target, post, dataDir } from './observe-client.js';

const dataArg = process.argv.indexOf('--data');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; if (raw.length > 200_000) process.exit(0); });
process.stdin.on('end', async () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  // Only what the office needs: never the prompt or a tool's full input.
  const body = {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    cwd: input.cwd,
    message: input.message,
    notification_type: input.notification_type,
    tool_name: input.tool_name,
    tool_input: input.tool_input && pick(input.tool_input),
  };
  // fork: a laptop reporting to an office on another machine says so, and
  // where the session lives, so Jarvis can reach it there.
  const host = hostOf(dataArg > 0 ? process.argv[dataArg + 1] : undefined);
  if (host) Object.assign(body, { host, cwd: input.cwd });
  await post(target(dataArg > 0 ? process.argv[dataArg + 1] : undefined), '/api/observe/claude-hook', body);
  process.exit(0);
});
setTimeout(() => process.exit(0), 3000).unref();

// The fields tools.js captions from, cut short.
function pick(i) {
  const out = {};
  for (const k of ['file_path', 'notebook_path', 'pattern', 'path', 'description', 'command', 'query', 'url', 'skill']) {
    if (typeof i[k] === 'string') out[k] = i[k].slice(0, 200);
  }
  return out;
}

function hostOf(explicit) {
  const d = dataDir(explicit);
  try { return d ? fs.readFileSync(path.join(d, 'host'), 'utf8').trim().slice(0, 40) : ''; } catch { return ''; }
}
