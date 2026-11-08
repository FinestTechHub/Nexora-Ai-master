import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempDir = mkdtempSync(path.join(tmpdir(), 'creatorforge-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.STARTER_CREDITS = '100';
process.env.ADMIN_EMAIL = 'creator@example.com'; // Regression: public registration must never grant admin.
delete process.env.FAL_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.YOUTUBE_API_KEY;
const { app, db } = await import('../server.js');
const server = app.listen(0);
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';

async function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${route}`, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const body = await response.json();
  return { response, body };
}

test('account, session, ownership and credit safeguards', async () => {
  try {
    let result = await request('/api/auth/me');
    assert.equal(result.response.status, 401);

    result = await request('/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Creator@example.com', password: 'strong-password-123' })
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.user.email, 'creator@example.com');
    assert.equal(result.body.user.credits, 100);
    assert.equal(result.body.user.role, 'user');
    assert.ok(cookie.startsWith('cf_session='));
    assert.equal(result.response.headers.get('x-frame-options'), 'DENY');

    result = await request('/api/unknown-route');
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, 'API route not found.');

    result = await request('/api/auth/me');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.user.email, 'creator@example.com');

    result = await request('/api/credits');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.balance, 100);
    assert.equal(result.body.transactions[0].amount, 100);

    result = await request('/api/projects');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.projects, []);

    result = await request('/api/generate-image', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'A test image' })
    });
    assert.equal(result.response.status, 503); // Provider key is absent in the test environment.
    result = await request('/api/credits');
    assert.equal(result.body.balance, 100); // No charge when the provider is not configured.

    result = await request('/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'creator@example.com', password: 'strong-password-123' })
    });
    assert.equal(result.response.status, 409);

    result = await request('/api/auth/logout', { method: 'POST' });
    assert.equal(result.response.status, 200);
    result = await request('/api/auth/me');
    assert.equal(result.response.status, 401);

    result = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'CREATOR@example.com', password: 'wrong-password-123' })
    });
    assert.equal(result.response.status, 401);

    result = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'CREATOR@example.com', password: 'strong-password-123' })
    });
    assert.equal(result.response.status, 200);

    const crossOrigin = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { origin: 'https://attacker.example' }
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
