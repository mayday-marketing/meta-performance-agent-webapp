#!/usr/bin/env node
// Dependency-free prompt-eval runner. Node 18+ (global fetch).
// Logs in via /api/auth, then replays fixtures/ against /api/chat
// and prints PASS/WARN/FAIL per check. See README.md.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.CLIENT_ID;
const PASSWORD = process.env.PASSWORD;
const ONLY = process.argv[2]; // optional fixture-name filter

if (!BASE_URL || !CLIENT_ID || !PASSWORD) {
  console.error('Set BASE_URL, CLIENT_ID and PASSWORD env vars. See evals/README.md.');
  process.exit(2);
}

const CHAT_QUESTION = 'Wat waren de best presterende posts deze periode en waarom?';

let failures = 0;
const line = (icon, label, extra) => console.log(`  ${icon} ${label}${extra ? ` — ${extra}` : ''}`);
const pass = (l) => line('✅', l);
const warn = (l, e) => line('⚠️ ', l, e);
const fail = (l, e) => { failures++; line('❌', l, e); };
const check = (cond, l, e) => cond ? pass(l) : fail(l, e);

async function api(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (text.includes('Authentication Required') || text.includes('sso-api')) {
    throw new Error('Got Vercel SSO page — target production or `vercel dev`, not a preview URL.');
  }
  let json; try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, json };
}

async function login() {
  const { ok, json } = await api('/api/auth', { clientId: CLIENT_ID, password: PASSWORD });
  if (!ok || !json.token) throw new Error(`Login failed: ${json.error || json.__raw || 'no token'}`);
  return json.token;
}

function evalChat(input, resp) {
  console.log(' chat:');
  if (!resp.ok || !resp.json.text) {
    fail('endpoint returned text', resp.json.error || `status ${resp.status}`);
    return;
  }
  const t = resp.json.text;
  check(t.trim().length > 0, 'answer is non-empty');
  const markdown = /\*\*/.test(t) || /^#{1,6}\s/m.test(t) || /\]\(/.test(t);
  check(!markdown, 'plain text (no **/#/markdown-links)', markdown ? 'markdown syntax present' : '');
  (/\d/.test(t) ? pass : (l) => warn(l, 'no numbers cited')) ('cites at least one number');
}

const token = await login();
console.log(`Logged in as ${CLIENT_ID} @ ${BASE_URL}\n`);

const files = readdirSync(join(HERE, 'fixtures')).filter(f => f.endsWith('.json') && (!ONLY || f.includes(ONLY)));
if (!files.length) { console.error('No matching fixtures.'); process.exit(2); }

for (const file of files) {
  const fx = JSON.parse(readFileSync(join(HERE, 'fixtures', file), 'utf8'));
  console.log(`\n=== ${file} (${fx.brandName}, ${fx.period?.startDate}–${fx.period?.endDate}) ===`);

  const cResp = await api('/api/chat', {
    clientId: CLIENT_ID, token,
    messages: [{ role: 'user', content: CHAT_QUESTION }],
    dashboardData: fx.summary,
  });
  evalChat(fx, cResp);
}

console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all hard checks passed (review any ⚠️ warnings)'}`);
process.exit(failures ? 1 : 0);
