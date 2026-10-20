# The building

With Jarvis on (`OFFICE_CHIEF_NAME`), the office opens on **the building**: one
floor per area of your work, with every project and whoever is working on it
right now. The 3D office is the other side of the switch at the top.

- **Floors** come from `~/.agent-office/departments.json` on the office machine.
  Each floor lists its projects by name or prefix (`bridge-*`); `hidden` keeps
  projects off every floor. Edit it and restart the office. The first version:
  Bridge, Brez, Rodrigo and Mega Brain.
- **Rooms.** A project with something going on gets a card. It shows office
  agents on jobs and your own Claude sessions in that folder, each with what
  they're doing now, and otherwise the last thing finished there (kept for 6
  hours). Quiet projects are chips underneath. Click anything to open its job
  or session.
- **Lights.** Green: working. Red: waiting on you. Amber: queued. Grey-blue:
  a session there, resting.
- **The lobby** is Jarvis, with what's waiting on you. **The basement** is Ops:
  the cron watchdogs.

## Projects on either machine

A project can live on the office machine or on the laptop (in
`~/workspaces`). Work for a laptop project is still an office job: an agent
takes it to their desk, its log streams into the office, and its result comes
back to the chat. It runs on the laptop through Jarvis's hands (`/run` in
`bin/jarvis-hands.js`), with the laptop's own tools, connectors and Claude
login. While the laptop is away, its jobs wait in the queue.

## Agents: Opus, full autonomy, and approvals

Jarvis's agents run on `OFFICE_AGENT_MODEL` (Opus 5.5) with full autonomy,
with no smaller models and no climbing up the ladder. The whole roster is in.
Jarvis himself routes on Haiku, for speed.

The one limit is `bin/approval-guard.js`, a hook on every tool call. Changing
ads (create, update, delete, budgets, pausing), sending messages (email,
WhatsApp, SMS, Kit broadcasts) and payments are held. The agent is told to
wait, Jarvis says "Ada wants to use … Say approve", and the details go in the
job's log. Say "approve" (to Jarvis, or as a reply to the job) and that job
may use them from then on. Reading, reporting, analysis, code and files are
never held.
