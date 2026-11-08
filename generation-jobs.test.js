import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureGenerationJobsSchema,
  enqueueGenerationJob,
  claimNextGenerationJob,
  completeGenerationJob,
  failGenerationJobAndRefund,
  interruptProcessingGenerationJobs,
  getGenerationJobForUser,
  listGenerationJobsForUser
} from '../lib/generation-jobs.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, credits INTEGER NOT NULL);
    CREATE TABLE credit_transactions(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL,
      reason TEXT NOT NULL, reference TEXT UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE projects(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO users(id,credits) VALUES('user-1',100),('user-2',100);
  `);
  ensureGenerationJobsSchema(db);
  return db;
}

const fixedNow = '2026-11-08T10:00:00.000Z';

test('enqueue deducts credits once and idempotent replay does not charge twice', () => {
  const db = fixture();
  try {
    const args = {
      userId: 'user-1', type: 'image', title: 'A blue robot',
      input: { prompt: 'A blue robot', aspect: 'square' }, cost: 10,
      idempotencyKey: 'request-key-0001', now: fixedNow
    };
    const first = enqueueGenerationJob(db, args);
    assert.equal(first.kind, 'created');
    assert.equal(first.balance, 90);
    const replay = enqueueGenerationJob(db, args);
    assert.equal(replay.kind, 'existing');
    assert.equal(replay.job.id, first.job.id);
    assert.equal(replay.balance, 90);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_transactions').get().n, 1);
  } finally { db.close(); }
});

test('reusing an idempotency key for different input is rejected without a second charge', () => {
  const db = fixture();
  try {
    const base = {
      userId: 'user-1', type: 'image', title: 'First', input: { prompt: 'First' },
      cost: 10, idempotencyKey: 'request-key-0002', now: fixedNow
    };
    assert.equal(enqueueGenerationJob(db, base).kind, 'created');
    const changed = enqueueGenerationJob(db, { ...base, title: 'Second', input: { prompt: 'Second' } });
    assert.equal(changed.kind, 'conflict');
    assert.equal(changed.balance, 90);
  } finally { db.close(); }
});

test('jobs are claimed once and completion atomically saves the project', () => {
  const db = fixture();
  try {
    const created = enqueueGenerationJob(db, {
      userId: 'user-1', type: 'image', title: 'A blue robot', input: { prompt: 'A blue robot' },
      cost: 10, idempotencyKey: 'request-key-0003', now: fixedNow
    });
    const claimed = claimNextGenerationJob(db, 'worker-1', fixedNow);
    assert.equal(claimed.id, created.job.id);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimNextGenerationJob(db, 'worker-2', fixedNow), null);
    const projectId = completeGenerationJob(db, claimed.id, { output: { url: 'https://example.test/image.png' }, now: fixedNow });
    const job = getGenerationJobForUser(db, claimed.id, 'user-1');
    assert.equal(job.status, 'completed');
    assert.equal(job.projectId, projectId);
    assert.deepEqual(job.output, { url: 'https://example.test/image.png' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
    assert.equal(getGenerationJobForUser(db, claimed.id, 'user-2'), null);
  } finally { db.close(); }
});

test('definite failure refunds once; interrupted jobs are not automatically refunded', () => {
  const db = fixture();
  try {
    const failed = enqueueGenerationJob(db, {
      userId: 'user-1', type: 'seo', title: 'SEO topic', input: { topic: 'SEO topic' },
      cost: 5, idempotencyKey: 'request-key-0004', now: fixedNow
    });
    claimNextGenerationJob(db, 'worker-1', fixedNow);
    assert.equal(failGenerationJobAndRefund(db, failed.job.id, 'SEO could not be completed.', fixedNow), true);
    assert.equal(failGenerationJobAndRefund(db, failed.job.id, 'SEO could not be completed.', fixedNow), false);
    assert.equal(db.prepare("SELECT credits FROM users WHERE id='user-1'").get().credits, 100);

    const interrupted = enqueueGenerationJob(db, {
      userId: 'user-1', type: 'video', title: 'Video topic', input: { prompt: 'Video topic' },
      cost: 20, idempotencyKey: 'request-key-0005', now: fixedNow
    });
    claimNextGenerationJob(db, 'worker-1', fixedNow);
    assert.equal(interruptProcessingGenerationJobs(db, fixedNow), 1);
    const job = getGenerationJobForUser(db, interrupted.job.id, 'user-1');
    assert.equal(job.status, 'interrupted');
    assert.equal(db.prepare("SELECT credits FROM users WHERE id='user-1'").get().credits, 80);
    assert.equal(listGenerationJobsForUser(db, 'user-1').length, 2);
  } finally { db.close(); }
});

test('insufficient credits and hourly limits reject jobs before creating a charge', () => {
  const db = fixture();
  try {
    db.prepare("UPDATE users SET credits=2 WHERE id='user-1'").run();
    const low = enqueueGenerationJob(db, {
      userId: 'user-1', type: 'image', title: 'Image', input: { prompt: 'Image' },
      cost: 10, idempotencyKey: 'request-key-0006', now: fixedNow
    });
    assert.equal(low.kind, 'insufficient_credits');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_transactions').get().n, 0);
  } finally { db.close(); }
});

test('hourly usage cap is checked inside the same transaction as credit reservation', () => {
  const db = fixture();
  try {
    db.prepare(`INSERT INTO credit_transactions(id,user_id,amount,reason,reference,created_at)
      VALUES('prior-use','user-1',-1,'Prior generation','prior-use-ref',?)`).run(fixedNow);
    const result = enqueueGenerationJob(db, {
      userId: 'user-1', type: 'image', title: 'New image', input: { prompt: 'New image' },
      cost: 10, idempotencyKey: 'request-key-0007', maxPerHour: 1, now: fixedNow
    });
    assert.equal(result.kind, 'rate_limited');
    assert.equal(result.balance, 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_transactions').get().n, 1);
  } finally { db.close(); }
});
