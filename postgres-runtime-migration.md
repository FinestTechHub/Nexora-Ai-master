# PostgreSQL runtime migration — next engineering milestone

Status: baseline SQL exists; runtime still uses Node's built-in SQLite API.

## Why this is next
The master server currently relies on synchronous `node:sqlite` calls (`db.prepare().get/all/run`, `db.exec`) in authentication, credits, projects, admin operations and generation-job helpers. A PostgreSQL driver is asynchronous, so adding `pg` and changing the connection string alone would break request handlers and worker behavior.

## Safe migration sequence
1. Add `pg` and a PostgreSQL connection pool configured from `DATABASE_URL` (TLS required in production).
2. Create a repository layer with explicit async methods for users, sessions, projects, credit ledger and jobs. Do not emulate a synchronous SQLite interface over network I/O.
3. Convert Express handlers and the generation worker to await repository methods.
4. Implement atomic credit reservation + job insertion with SQL transactions and `SELECT ... FOR UPDATE` (or a conditional balance update).
5. Implement worker claiming with `FOR UPDATE SKIP LOCKED`, leases/heartbeats and stale-job recovery. Keep one worker until this is tested.
6. Add a one-time SQLite export/import command. Import into a fresh PostgreSQL database; never overwrite the source SQLite file.
7. Verify row counts, unique references, foreign keys, balances and job ownership; run parity tests against both adapters.
8. Switch runtime only after tests pass; keep a verified SQLite backup and rollback instructions.

## Required safety rules
- Never log `DATABASE_URL` or provider credentials.
- Fail startup if production has no `DATABASE_URL`; do not silently fall back to SQLite in production.
- Keep SQL parameterized.
- Use least-privilege database credentials.
- Add connection-pool limits and statement/query timeouts.
- Back up before migration and perform a restore drill.
- Do not scale app replicas until sessions, rate limits and worker claiming are shared/durable.

## Existing baseline
Apply `migrations/0001_postgres_baseline.sql` only to a new empty PostgreSQL database after review. It is a schema baseline, not proof that the application supports PostgreSQL.
