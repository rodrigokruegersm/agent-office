#!/usr/bin/env node
// fork: a PreToolUse hook on office jobs. Agents have full autonomy, except
// for spending money and messaging real people: those tool calls are held
// until the boss approves (the office asks them, and Jarvis says so). It
// asks the office whether this job has been approved; if the office can't be
// reached, the answer is no.

const ADS = /meta|ads|facebook|google_?ads|tiktok|adwords/;
const MESSAGING = /gmail|mail|twilio|boosend|whatsapp|kapso|kit|slack|telegram|sms|discord|outlook|messenger/;

export function risky(name) {
  const t = String(name || '').toLowerCase();
  const [, server = '', ...rest] = t.split('__');
  const tool = rest.join('__');
  if (ADS.test(server) && /(post|batch|delete|create|update|budget|publish|activate|pause|launch|duplicate|upload)/.test(tool)) return true;
  if (MESSAGING.test(server) && /(send|createmessage|create_message|createcall|create_call|broadcast|reply|post|publish)/.test(tool)) return true;
  return /(purchase|payment|transfer|charge|refund|payout)/.test(tool);
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  if (!risky(input.tool_name)) return;
  let allowed = false;
  try {
    const res = await fetch(`${process.env.OFFICE_URL}/api/agent/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-office-job': process.env.OFFICE_JOB || '', 'x-office-token': process.env.OFFICE_TOKEN || '' },
      body: JSON.stringify({ tool: input.tool_name, input: JSON.stringify(input.tool_input || {}).slice(0, 600) }),
      signal: AbortSignal.timeout(5000),
    });
    allowed = res.ok && (await res.json()).allowed === true;
  } catch {}
  if (allowed) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'This spends money or messages real people, so it needs the boss\'s approval first. The office has asked them. Say exactly what you want to do and why, then end your turn and wait; once they approve, try again.',
    },
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0), () => process.exit(0));
