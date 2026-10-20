// fork: Jarvis's reflexes. Plain browser and app commands ("open Gmail",
// "switch to the launch doc", "close the YouTube tab", "search for flights to
// Lisbon") are worked out here, with no model call, so they happen as fast
// as they're said. Anything that isn't one of these, or that doesn't find
// its tab, goes to the chief as before.

const SITES = {
  gmail: 'https://mail.google.com', email: 'https://mail.google.com', 'my email': 'https://mail.google.com', mail: 'https://mail.google.com',
  calendar: 'https://calendar.google.com', 'google calendar': 'https://calendar.google.com',
  drive: 'https://drive.google.com', 'google drive': 'https://drive.google.com',
  docs: 'https://docs.google.com', 'google docs': 'https://docs.google.com', sheets: 'https://sheets.google.com', 'google sheets': 'https://sheets.google.com',
  youtube: 'https://www.youtube.com', github: 'https://github.com', notion: 'https://www.notion.so', chatgpt: 'https://chatgpt.com',
  twitter: 'https://x.com', x: 'https://x.com', instagram: 'https://www.instagram.com', facebook: 'https://www.facebook.com',
  linkedin: 'https://www.linkedin.com', reddit: 'https://www.reddit.com', pinterest: 'https://www.pinterest.com',
  'ads manager': 'https://adsmanager.facebook.com', 'meta ads': 'https://adsmanager.facebook.com', 'business manager': 'https://business.facebook.com',
  figma: 'https://www.figma.com', vercel: 'https://vercel.com', stripe: 'https://dashboard.stripe.com', shopify: 'https://admin.shopify.com',
  amazon: 'https://www.amazon.com', netflix: 'https://www.netflix.com', google: 'https://www.google.com', maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com',
};
const TLD = /^([a-z0-9-]+(?:\s*(?:\.|dot)\s*[a-z0-9-]+)*)\s*(?:\.|dot)\s*(com|io|ai|org|net|co|app|dev|so|me|tv|br|info|space)$/;

function tidy(text) {
  return String(text || '').toLowerCase()
    .replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:hey|ok|okay|yo)\s+)?(?:jarvis|chief)\b[\s,.:;!-]*/, '')
    .replace(/^(?:(?:please|can you|could you|would you|hey|ok|okay|now|and)\s+)+/, '')
    .replace(/\s+(?:please|for me|sir|now|real quick)$/g, '').trim();
}
const target = (s) => s.replace(/^(?:the|my|a|an|our)\s+/, '').replace(/\s+(?:tab|page|website|site|window)$/, '').trim();
const pretty = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function siteFor(t) {
  if (SITES[t]) return SITES[t];
  const m = TLD.exec(t);
  if (m) return `https://${m[1].replace(/\s*(?:\.|dot)\s*/g, '.')}.${m[2]}`;
  return null;
}

// What a sentence asks for, or null if it isn't a plain browser/app command.
export function parse(text) {
  const t = tidy(text);
  let m;
  if ((m = /^(?:open|launch|pull up|bring up|start)\s+(.+)$/.exec(t))) return { verb: 'open', what: target(m[1]) };
  if ((m = /^(?:switch|go|jump|flip|take me|bring me)\s+(?:back\s+)?(?:over\s+)?to\s+(.+)$/.exec(t))) return { verb: 'focus', what: target(m[1]) };
  if ((m = /^show me\s+(.+)$/.exec(t))) return { verb: 'focus', what: target(m[1]) };
  if ((m = /^close\s+(.+)$/.exec(t))) return { verb: 'close', what: target(m[1]) };
  if ((m = /^(?:reload|refresh)\s+(.+)$/.exec(t))) return { verb: 'reload', what: target(m[1]) };
  if ((m = /^(?:search|google|look up)\s+(?:the web\s+)?(?:for\s+)?(.+)$/.exec(t))) return { verb: 'search', what: m[1] };
  return null;
}

// Carries it out with Jarvis's hands. Returns the line to say, or null to
// leave it to the chief (an app or tab it couldn't place).
export async function fastPath(text, hands, apps) {
  const p = parse(text);
  if (!p || !p.what || p.what.split(' ').length > 8) return null;
  const tabs = (op, body) => hands.call('/tabs', { op, ...body });
  if (p.verb === 'search') { await tabs('search', { query: p.what }); return `Searching for ${p.what}.`; }
  if (p.verb === 'open') {
    const app = (await apps()).find((a) => a.toLowerCase() === p.what || a.toLowerCase() === `${p.what}.app`);
    const site = siteFor(p.what);
    // A named app wins over its website ("open Spotify"), a site over a guess.
    if (app && !TLD.test(p.what)) { await hands.call('/app', { name: app }); return `Opening ${app}.`; }
    if (site) { await tabs('open', { url: site }); return `Opening ${TLD.test(p.what) ? new URL(site).hostname : pretty(p.what)}.`; }
    return null;
  }
  try {
    const r = await tabs(p.verb, { query: p.what });
    const t = r.focused || r.closed || r.reloaded;
    // "(56) Pinterest" is a page's unread count, not its name.
    const name = t?.title ? t.title.replace(/^\(\d+\+?\)\s*/, '').split(/ [-–|·] /)[0].slice(0, 60) : pretty(p.what);
    return p.verb === 'focus' ? `Here's ${name}.` : p.verb === 'close' ? `Closed ${name}.` : `Reloading ${name}.`;
  } catch (err) {
    // "Switch to Gmail" with no Gmail tab open: open it instead.
    const site = p.verb === 'focus' && siteFor(p.what);
    if (site && /no tab matches/i.test(err.message)) { await tabs('open', { url: site }); return `Opening ${pretty(p.what)}.`; }
    if (/no tab matches/i.test(err.message)) return null;
    throw err;
  }
}
