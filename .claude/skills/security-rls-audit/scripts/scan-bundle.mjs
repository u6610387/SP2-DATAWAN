#!/usr/bin/env node
/**
 * Secret / key leak scan for client bundles. No dependencies.
 *   node .claude/skills/security-rls-audit/scripts/scan-bundle.mjs <dir>... [--url https://site]
 * Exit 1 if anything that must never reach a browser is found:
 *   - a JWT whose payload role is not 'anon' (e.g. service_role)
 *   - a Supabase secret key value (sb_secret_<value>); the bare prefix inside supabase-js is fine
 *   - private keys, Google API keys, Stripe live keys, LINE channel secret/token assignments
 * Allowed and reported as info: anon JWTs, sb_publishable_ keys.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const base = urlIdx >= 0 ? args[urlIdx + 1] : null;
const dirs = args.filter((_, i) => urlIdx < 0 || (i !== urlIdx && i !== urlIdx + 1));

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BAD = [
  ['supabase secret key', /sb_secret_[A-Za-z0-9_-]{16,}/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/g],
  ['Stripe live key', /sk_live_[0-9A-Za-z]{16,}/g],
  ['LINE secret assignment', /LINE_CHANNEL_(SECRET|ACCESS_TOKEN)["']?\s*[:=]\s*["'][^"']{10,}/g],
  ['service-role env name with value', /SUPABASE_SERVICE_ROLE_KEY["']?\s*[:=]\s*["'][^"']{10,}/g],
];
const findings = [];
const info = new Set();

function scan(text, where) {
  for (const m of text.match(JWT) ?? []) {
    let role = '?';
    try {
      role = JSON.parse(Buffer.from(m.split('.')[1], 'base64url').toString()).role ?? '?';
    } catch {}
    if (role === 'anon') info.add(`anon JWT in ${where}`);
    else findings.push(`JWT with role=${role} in ${where}`);
  }
  for (const [name, re] of BAD) for (const m of text.match(re) ?? []) findings.push(`${name} (${m.slice(0, 14)}…) in ${where}`);
  if (/sb_publishable_[A-Za-z0-9_-]{8,}/.test(text)) info.add(`publishable key in ${where}`);
}

function walk(dir) {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) n += walk(p);
    else if (/\.(js|mjs|html|json|map|css|txt|webmanifest)$/.test(f)) {
      scan(readFileSync(p, 'utf8'), p);
      n++;
    }
  }
  return n;
}

let scanned = 0;
for (const d of dirs) scanned += walk(d);
if (base) {
  const get = async (p) => (await fetch(base + p, { headers: { 'User-Agent': 'Mozilla/5.0 security-scan' } })).text();
  const pages = ['/', '/login', '/dashboard', '/dashboard/inventory', '/dashboard/orders/x', '/liff', '/liff/orders/x', '/sw.js'];
  const chunks = new Set();
  for (const p of pages) {
    const html = await get(p);
    scan(html, `${base}${p}`);
    scanned++;
    for (const c of html.match(/\/_next\/static\/[^"']+\.js/g) ?? []) chunks.add(c);
  }
  for (const c of chunks) {
    scan(await get(c), `${base}${c}`);
    scanned++;
  }
}
console.log(`scanned ${scanned} files`);
for (const i of info) console.log(`info: ${i}`);
if (findings.length) {
  for (const f of findings) console.log(`LEAK: ${f}`);
  process.exit(1);
}
console.log('no secrets found');
