// Shared by the observer's little clients (office-observe, office-run): find
// the office on this machine and post one report to it. Never throws and never
// waits long: a hook or a cron job must not hang because the office is down.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The office's data folder: OFFICE_DATA, else a clone's data/, else the
// installed CLI's ~/.agent-office.
export function dataDir(explicit) {
  const tries = [explicit, process.env.OFFICE_DATA, path.join(HERE, '..', 'data'), path.join(os.homedir(), '.agent-office')];
  for (const d of tries) if (d && fs.existsSync(path.join(d, 'observe-key'))) return d;
  return null;
}

export function target(explicitData) {
  const url = process.env.OFFICE_OBSERVE_URL;
  const key = process.env.OFFICE_OBSERVE_KEY;
  if (url && key) return { url: url.replace(/\/$/, ''), key };
  const data = dataDir(explicitData);
  if (!data) return null;
  try {
    const k = fs.readFileSync(path.join(data, 'observe-key'), 'utf8').trim();
    const port = fs.readFileSync(path.join(data, 'office-port'), 'utf8').trim();
    return { url: `http://127.0.0.1:${port}`, key: key || k };
  } catch { return null; }
}

export async function post(where, route, body, ms = 1500) {
  if (!where) return false;
  try {
    const res = await fetch(where.url + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-observe-key': where.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    return res.ok;
  } catch { return false; }
}
