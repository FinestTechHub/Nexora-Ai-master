import { randomUUID } from 'node:crypto';

const GENERATION_TYPES = new Set(['image', 'video', 'seo']);

export function ensureGenerationJobsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('image','video','seo')),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed','interrupted')),
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_message TEXT,
      credit_cost INTEGER NOT NULL CHECK(credit_cost > 0),
      credit_reference TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS generation_jobs_queue_idx
      ON generation_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS generation_jobs_user_created_idx
      ON generation_jobs(user_id, created_at DESC);
  `);
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function publicJob(row, includeOutput = false) {
  if (!row) return null;
  const job = {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    error: row.error_message,
    creditCost: row.credit_cost,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    projectId: row.project_id
  };
  if (includeOutput && row.output_json) {
    try { job.output = JSON.parse(row.output_json); } catch { job.output = null; }
  }
  return job;
}

export function findGenerationJobByKey(db, userId, idempotencyKey) {
  return db.prepare('SELECT * FROM generation_jobs WHERE user_id = ? AND idempotency_key = ?')
    .get(userId, idempotencyKey) || null;
}

export function enqueueGenerationJob(db, {
  userId, type, title, input, cost, idempotencyKey, maxPerHour = 20, now = new Date().toISOString()
}) {
  if (!GENERATION_TYPES.has(type)) throw new Error('Unsupported generation job type.');
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error('Generation cost must be a positive integer.');
  const inputJson = JSON.stringify(input);

  return transaction(db, () => {
    const existing = findGenerationJobByKey(db, userId, idempotencyKey);
    if (existing) {
      const sameRequest = existing.type === type && existing.title === title && existing.input_json === inputJson;
      return {
        kind: sameRequest ? 'existing' : 'conflict',
        job: publicJob(existing, true),
        balance: db.prepare('SELECT credits FROM users WHERE id = ?').get(userId)?.credits ?? 0
      };
    }

    const cutoff = new Date(new Date(now).getTime() - 60 * 60 * 1000).toISOString();
    const recentCount = db.prepare(`SELECT COUNT(*) AS n FROM credit_transactions
      WHERE user_id = ? AND amount < 0 AND created_at >= ?`).get(userId, cutoff)?.n ?? 0;
    if (recentCount >= maxPerHour) {
      return { kind: 'rate_limited', balance: db.prepare('SELECT credits FROM users WHERE id = ?').get(userId)?.credits ?? 0 };
    }

    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!user) return { kind: 'missing_user', balance: 0 };
    if (user.credits < cost) return { kind: 'insufficient_credits', balance: user.credits };

    const id = randomUUID();
    const creditReference = randomUUID();
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(cost, userId);
    db.prepare(`INSERT INTO credit_transactions(id,user_id,amount,reason,reference,created_at)
      VALUES(?,?,?,?,?,?)`).run(randomUUID(), userId, -cost, `${type} generation`, creditReference, now);
    db.prepare(`INSERT INTO generation_jobs(
      id,user_id,type,title,status,input_json,credit_cost,credit_reference,idempotency_key,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, type, String(title).slice(0, 160), 'queued', inputJson, cost, creditReference, idempotencyKey, now, now
    );

    const row = db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id);
    return { kind: 'created', job: publicJob(row), balance: user.credits - cost };
  });
}

export function claimNextGenerationJob(db, workerId, now = new Date().toISOString()) {
  return transaction(db, () => {
    const row = db.prepare(`SELECT * FROM generation_jobs
      WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get();
    if (!row) return null;
    const result = db.prepare(`UPDATE generation_jobs
      SET status='processing', attempts=attempts+1, worker_id=?, started_at=?, updated_at=?
      WHERE id=? AND status='queued'`).run(workerId, now, now, row.id);
    if (result.changes !== 1) return null;
    return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(row.id);
  });
}

export function completeGenerationJob(db, jobId, { output, now = new Date().toISOString() }) {
  return transaction(db, () => {
    const job = db.prepare(`SELECT * FROM generation_jobs WHERE id = ? AND status = 'processing'`).get(jobId);
    if (!job) throw new Error('Generation job is no longer processing.');
    const projectId = randomUUID();
    db.prepare(`INSERT INTO projects(id,user_id,type,title,input_json,output_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(
      projectId, job.user_id, job.type, job.title, job.input_json, JSON.stringify(output), now
    );
    const updated = db.prepare(`UPDATE generation_jobs SET status='completed', output_json=?, project_id=?,
      error_message=NULL, updated_at=?, finished_at=? WHERE id=? AND status='processing'`)
      .run(JSON.stringify(output), projectId, now, now, jobId);
    if (updated.changes !== 1) throw new Error('Could not mark generation job complete.');
    return projectId;
  });
}

export function failGenerationJobAndRefund(db, jobId, safeMessage, now = new Date().toISOString()) {
  return transaction(db, () => {
    const job = db.prepare(`SELECT * FROM generation_jobs WHERE id = ? AND status = 'processing'`).get(jobId);
    if (!job) return false;
    const refundReference = `refund:${job.credit_reference}`;
    const alreadyRefunded = db.prepare('SELECT id FROM credit_transactions WHERE reference = ?').get(refundReference);
    if (!alreadyRefunded) {
      db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(job.credit_cost, job.user_id);
      db.prepare(`INSERT INTO credit_transactions(id,user_id,amount,reason,reference,created_at)
        VALUES(?,?,?,?,?,?)`).run(
        randomUUID(), job.user_id, job.credit_cost, `${job.type} generation failed — refund`, refundReference, now
      );
    }
    db.prepare(`UPDATE generation_jobs SET status='failed', error_message=?, updated_at=?, finished_at=?
      WHERE id=? AND status='processing'`).run(safeMessage, now, now, jobId);
    return true;
  });
}

export function interruptProcessingGenerationJobs(db, now = new Date().toISOString()) {
  const message = 'The server restarted while this job was processing. The provider outcome is unknown; contact support before retrying.';
  return db.prepare(`UPDATE generation_jobs SET status='interrupted', error_message=?, updated_at=?, finished_at=?
    WHERE status='processing'`).run(message, now, now).changes;
}

export function getGenerationJobForUser(db, jobId, userId) {
  const row = db.prepare('SELECT * FROM generation_jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
  return publicJob(row, true);
}

export function listGenerationJobsForUser(db, userId, limit = 10) {
  const safeLimit = Math.min(30, Math.max(1, Number.isInteger(limit) ? limit : 10));
  return db.prepare(`SELECT * FROM generation_jobs WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?`).all(userId, safeLimit).map(row => publicJob(row));
}
