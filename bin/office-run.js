#!/usr/bin/env node
// Runs a command and shows it in the office while it runs, for cron jobs and
// launchd tasks:
//
//   office-run nightly-backup -- /usr/local/bin/backup.sh --full
//   office-run "Lead scraper" --source bots -- python3 scrape.py
//
// Output passes through untouched and the exit code is the command's own, so
// it can wrap anything already in a crontab. If the office is down the
// command still runs.

import { spawn } from 'node:child_process';
import { target, post } from './observe-client.js';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
if (dash < 1 || dash === argv.length - 1) {
  console.error('usage: office-run <name> [--source cron] [--station servers] -- <command> [args…]');
  process.exit(64);
}
const opts = argv.slice(0, dash);
const cmd = argv.slice(dash + 1);
const flag = (f, d) => { const i = opts.indexOf(f); return i >= 0 && opts[i + 1] ? opts.splice(i, 2)[1] : d; };
const source = flag('--source', 'cron');
const station = flag('--station', 'servers');
const name = opts.join(' ').slice(0, 40);
const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';

const where = target();
const report = (state, activity) => post(where, '/api/observe', { source, id, name, state, station: state === 'working' ? station : 'lounge', activity });
const started = Date.now();
const took = () => {
  const s = Math.round((Date.now() - started) / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

await report('working', `Running ${cmd.map((c) => c.split('/').pop()).join(' ').slice(0, 80)}`);
const beat = setInterval(() => report('working', `Still running (${took()})`), 60_000);

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', async (err) => {
  clearInterval(beat);
  await report('error', `Couldn't start: ${err.message}`);
  process.exit(127);
});
child.on('exit', async (code, signal) => {
  clearInterval(beat);
  if (code === 0) await report('idle', `Done in ${took()}`);
  else await report('error', signal ? `Killed by ${signal} after ${took()}` : `Failed with exit ${code} after ${took()}`);
  process.exit(code ?? 1);
});
