-- Nexora AI / CreatorForge master project: PostgreSQL baseline schema.
-- This migration mirrors the current SQLite MVP data model. It is a preparation
-- artifact only: server.js still runs SQLite until the PostgreSQL adapter and
-- data-migration command are implemented and tested.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image', 'video', 'seo')),
  title TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_user_created_idx ON projects(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_user_created_idx ON credit_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image', 'video', 'seo')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'interrupted')),
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_message TEXT,
  credit_cost INTEGER NOT NULL CHECK (credit_cost > 0),
  credit_reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS generation_jobs_queue_idx ON generation_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS generation_jobs_user_created_idx ON generation_jobs(user_id, created_at DESC);

COMMIT;
