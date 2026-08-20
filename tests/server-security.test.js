'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'worker.js'), 'utf8');
const runnable = source.replace('export default {', 'globalThis.__worker = {');
const context = { console, Date, Math, JSON, Map, Set, String, Number, Array, Object,
  Promise, TextEncoder, Uint8Array, URL, Request, Response, Headers, FormData, crypto: webcrypto };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(runnable, context, { filename: 'worker.js' });
const worker = context.__worker;

function fakeKv() {
  const values = new Map(), metadata = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value, options = {}) { values.set(key, value); if (options.metadata) metadata.set(key, options.metadata); },
    async list({ prefix }) { return { keys: [...values.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: metadata.get(name) })) }; },
  };
}

const baseEnv = () => ({ ALLOW_ORIGIN: 'https://tensaikamo.github.io',
  INGEST_KEY: 'ingest-secret', ADMIN_KEY: 'admin-secret', REPORTS: fakeKv() });

test('report and preflight reject a different browser origin', async () => {
  const env = baseEnv();
  const post = new Request('https://reports.example/report', { method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: env.INGEST_KEY, report: 'test' }) });
  assert.equal((await worker.fetch(post, env)).status, 403);
  const preflight = new Request('https://reports.example/report', { method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' } });
  assert.equal((await worker.fetch(preflight, env)).status, 403);
});

test('allowed app origin can submit a report', async () => {
  const env = baseEnv();
  const request = new Request('https://reports.example/report', { method: 'POST',
    headers: { Origin: env.ALLOW_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify({ key: env.INGEST_KEY, report: '利用状況', version: '1.9.3', device: 'device_1' }) });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.ALLOW_ORIGIN);
  assert.equal((await response.json()).ok, true);
});

test('admin login stores an HttpOnly cookie and removes keys from links', async () => {
  const env = baseEnv();
  const login = new Request('https://reports.example/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=admin-secret' });
  const loggedIn = await worker.fetch(login, env);
  assert.equal(loggedIn.status, 303);
  const cookie = loggedIn.headers.get('Set-Cookie');
  assert.match(cookie, /invoice_admin=admin-secret/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const page = await worker.fetch(new Request('https://reports.example/admin', {
    headers: { Cookie: cookie.split(';')[0] } }), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.doesNotMatch(await page.text(), /[?&]key=/);
});

test('legacy query-key URL redirects to a clean URL', async () => {
  const env = baseEnv();
  const response = await worker.fetch(new Request('https://reports.example/admin/view?key=admin-secret&id=r1'), env);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/admin/view?id=r1');
  assert.doesNotMatch(response.headers.get('Location'), /key=/);
});

test('admin without a valid session receives the login form', async () => {
  const response = await worker.fetch(new Request('https://reports.example/admin'), baseEnv());
  assert.equal(response.status, 401);
  assert.match(await response.text(), /管理キー/);
});
