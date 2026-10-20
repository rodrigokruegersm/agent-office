// fork: the building. Floors are the boss's areas of work; each lists its
// projects by name or by prefix ("bridge-x-*"). Kept in <data>/departments.json,
// so the boss (or Jarvis) can change them without touching code; this is the
// first version written there.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_FLOORS = {
  floors: [
    { id: 'bridge', name: 'Bridge', color: '#3b82f6', about: 'The agency and its product: partners, client accounts, the portal, shortform, mail and the affiliate model.', projects: ['bridge', 'bridge-*', 'bridged-*'] },
    { id: 'brez', name: 'Brez', color: '#e5484d', about: 'The Brez account: dashboards, the B44 launch, ads and their watchdogs.', projects: ['brez-*', 'b44*'] },
    { id: 'rodrigo', name: 'Rodrigo', color: '#f59e0b', about: "Rodrigo's own projects: AI Advertiser, the agent office and personal work.", projects: ['ai-advertiser', 'ai-advertiser-*', 'agent-office', 'squared-away-check', 'ascension-platform', 'sales-command-center'] },
    { id: 'mega-brain', name: 'Mega Brain', color: '#8b5cf6', about: 'Research, SOPs and the knowledge base.', projects: ['mega-brain', 'mega-brain-*'] },
  ],
  // Never shown on a floor.
  hidden: ['clickmax-*', 'cm-pace', 'jarvis-sandbox', 'office-sandbox', 'voice-sandbox'],
};

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

export function loadDepartments(dataDir) {
  const file = path.join(dataDir, 'departments.json');
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    d = DEFAULT_FLOORS;
    try { fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n'); } catch {}
  }
  const floors = (Array.isArray(d.floors) ? d.floors : []).filter((f) => f && f.id && f.name).map((f) => ({
    id: String(f.id).slice(0, 40), name: String(f.name).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#8a8f9c',
    about: String(f.about || '').slice(0, 300), projects: (f.projects || []).map(String).slice(0, 80),
  }));
  const hidden = (d.hidden || []).map(String).map(glob);
  return {
    floors,
    isHidden: (name) => hidden.some((r) => r.test(name)),
    // The floor a project belongs on: the first whose list names it.
    floorOf(name) {
      if (!name || hidden.some((r) => r.test(name))) return null;
      return floors.find((f) => f.projects.some((p) => glob(p).test(name)))?.id || null;
    },
  };
}
