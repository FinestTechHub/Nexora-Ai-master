# Nexora AI — durable generation jobs (v1.2.1)

Nexora AI combines three creator tools in one workspace:

- AI image generation through fal.ai (`fal-ai/flux/dev`)
- AI text-to-video generation through fal.ai (`blackforestlabs/flux-3-max/text-to-video`)
- YouTube SEO pack generation through the OpenAI Responses API
- Optional public competitor research through YouTube Data API v3

This increment keeps the existing multi-user foundation and adds a persistent generation-job queue for image, video and SEO requests. Generation requests now reserve credits and create a queued job in one database transaction, return a job ID, and are processed by a background worker. Job status and results are stored, the browser polls status, and successful jobs save their project and result atomically. Client idempotency keys prevent duplicate submissions from charging twice.

## Requirements

- Node.js 22.16 or newer (uses the built-in `node:sqlite` module)
- npm
- Provider keys for the tools you want to use

> `node:sqlite` is still marked experimental by Node.js in this runtime line. Pin and test your Node runtime before deployment. For a multi-instance public SaaS, migrate persistence to managed PostgreSQL before launch.

## Run locally

1. Extract the project and open the `creatorforge` directory in a terminal.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Add your provider keys to `.env` (leave optional keys blank if not configured).
5. Run `npm test` to execute the automated account/session/credit-safety checks.
6. Run `npm start`.
7. Open `http://localhost:3000` and create an account.

The default SQLite database is created at `data/creatorforge.sqlite`. The `data/` directory and `.env` are excluded by `.gitignore`.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `FAL_KEY` | fal.ai image/video API key | unset |
| `OPENAI_API_KEY` | OpenAI SEO API key | unset |
| `YOUTUBE_API_KEY` | Optional public YouTube research | unset |
| `OPENAI_MODEL` | OpenAI model used for SEO | `gpt-4.1-mini` |
| `DATABASE_PATH` | SQLite file path | `./data/creatorforge.sqlite` |
| `STARTER_CREDITS` | New-account starting balance | `100` |
| `IMAGE_CREDIT_COST` | Internal image-generation charge | `10` |
| `VIDEO_CREDIT_COST` | Internal video-generation charge | `60` |
| `SEO_CREDIT_COST` | Internal SEO-generation charge | `5` |
| `MAX_GENERATIONS_PER_HOUR` | Per-account generation cap | `20` |
| `GENERATION_WORKER_POLL_MS` | Background worker polling interval | `750` |
| `TRUST_PROXY_HOPS` | Number of trusted reverse-proxy hops in production; keep `0` unless your hosting topology requires it | `0` |
| `NODE_ENV` | Set to `production` for secure cookies/proxy behavior | `development` |
| `PORT` | HTTP port | `3000` |

Credit amounts are application units, not Naira or a claim about actual provider costs. The defaults are development placeholders. Before selling subscriptions, measure each provider/model's real cost (including failed jobs, retries, output duration/resolution, taxes and FX), then set credit prices with a margin and hard spending limits.

## API routes added

- `POST /api/auth/register` — create an account and start a session
- `POST /api/auth/login` — verify credentials and start a session
- `POST /api/auth/logout` — revoke the current session
- `GET /api/auth/me` — return the current account
- `GET /api/projects` — list the signed-in account's latest projects
- `GET /api/credits` — return current balance and recent ledger entries
- `GET /api/jobs` — list the signed-in user's recent generation jobs
- `GET /api/jobs/:id` — read one job and its output, scoped to its owner

Image, video and SEO generation require a signed-in account. The API now creates a durable queued job and reserves credits in one SQLite transaction, then returns `202` with a `jobId`. The background worker processes jobs one at a time. The browser polls `GET /api/jobs/:id` until the job is completed or failed. Successful results and project-history records are committed together. Definite provider failures are marked failed and refunded exactly once. If the process restarts while a provider request is in flight, the job becomes `interrupted` and is not automatically refunded or retried because the provider may already have completed and charged for it.

Clients should send an `Idempotency-Key` header (8–128 safe characters) for each new generation request and reuse that same key only when retrying the exact same request after a network interruption. Reusing a key with different input returns `409`. The web app creates a fresh UUID for each new action. `GET /api/jobs` returns the signed-in user's latest job history; `GET /api/jobs/:id` is owner-scoped.

## Provider credential handling

The `.env.example` contains blank provider credentials. Put real values only in your local `.env` or your hosting provider's secret manager. Never commit `.env`, paste credentials into source code, or add provider keys to `public/index.html`. If a key was ever committed or exposed, revoke/rotate it at the provider before continuing. The browser calls only CreatorForge API routes; the provider credentials remain server-side.

## Security work in this increment

- Passwords use Node's scrypt password hashing with a per-account random salt.
- Session tokens are random, stored only as SHA-256 hashes, and sent in HttpOnly, SameSite=Lax cookies.
- Cookies use `Secure` in production mode.
- Mutating API requests reject cross-origin browser requests.
- JSON request size is capped at 100 KB.
- Input length and option allowlists are checked server-side.
- Generation endpoints require authentication, enforce a per-account hourly cap, and check credit balances on the server.
- API responses are not cached; browser security headers are set. Production uses a `__Host-` session cookie and HSTS.
- Provider error logs record only safe metadata, not raw provider error messages or request URLs.
- Admin privilege is never assigned during public registration; a server-side interactive CLI is required for promotion.
- Unknown `/api/*` routes return JSON 404 responses rather than the frontend HTML.

## PostgreSQL migration preparation (v1.2.1 work-in-progress)

The master project now includes `migrations/0001_postgres_baseline.sql`, a PostgreSQL schema matching the existing SQLite tables: users, sessions, projects, credit transactions and generation jobs. It preserves the current identifiers, ISO timestamp text fields, ownership constraints, unique payment/credit references and idempotency constraints.

**Important:** this SQL is a schema baseline, not a completed database migration. The running application still uses Node.js `node:sqlite`; do not point `DATABASE_PATH` at a PostgreSQL URL or run multiple app instances. The next implementation step is a PostgreSQL repository/transaction adapter plus a one-time SQLite export/import utility, followed by parity tests before changing the runtime database. The SQL migration should be applied to a new empty PostgreSQL database only, after reviewing the target environment and taking a backup.

## Important limitations — not production-ready yet

This is a stronger local MVP, not a fully launch-ready commercial SaaS. The following remain unfinished:

- Email verification, password reset, account recovery, MFA and account deletion.
- PostgreSQL runtime adapter and SQLite-to-PostgreSQL data migration (baseline schema prepared; runtime still SQLite), backups, restore drills and multi-instance-safe sessions/queues.
- Paystack checkout, verified webhooks, subscription lifecycle, refunds and reconciliation.
- Paid credit top-ups, subscription entitlements, tax/invoice handling and financial reporting.
- A real admin dashboard and audited admin permissions.
- Persistent distributed rate limiting, provider timeout/cancellation handling and safe retry policies. The current queue is a single-process SQLite worker, not a distributed queue.
- Moderation/abuse review, observability, alerting, privacy/retention controls and security review.
- Automated tests with real fal.ai/OpenAI/YouTube credentials; no live provider request is made by the current test suite.
- Generated media is stored as provider URLs, not copied into durable object storage. Provider retention and URL expiry policies may apply.
- Rate limiting is process-local and will reset on restart; use a shared limiter before horizontal scaling.
- A provider request interrupted by a server restart is marked `interrupted` and requires manual reconciliation. It is deliberately not retried or refunded automatically because the provider may already have charged for it.
- The current SQLite queue is designed for one application process/instance. Do not run multiple app replicas against this database; migrate to managed PostgreSQL and a shared worker/queue before horizontal scaling.

Public registration always creates a normal `user` account. Do not grant admin privileges based only on an email address: until email verification exists, an attacker could register someone else's email first. To promote an account, first create that account, then run `npm run promote-admin -- user@example.com` on the server with database access and type the exact email when prompted. This is an out-of-band administrative action; never expose it as a public endpoint. Admin API/dashboard controls are still unfinished.

## Production deployment guidance

Do not invite paying customers yet. Before public launch:

1. Complete the PostgreSQL runtime adapter and SQLite data import using the prepared `migrations/0001_postgres_baseline.sql`; validate row counts and foreign keys, then move queue claiming to a shared worker system before running multiple app replicas.
2. Add email verification and secure password reset.
3. Add Redis or another shared rate-limit/session/job backend if deploying multiple instances.
4. Implement Paystack using server-created transactions, signature-verified webhooks, idempotency and reconciliation. Never trust a browser redirect as proof of payment.
5. Recalculate credit costs from current provider pricing and enforce a provider-side monthly spend ceiling.
6. Add a durable worker queue for long-running video jobs and store media in controlled object storage.
7. Add monitoring, backups, restore testing, abuse controls, privacy policy/terms and a security review.
8. Deploy behind HTTPS and set all secrets in the host's secret manager, not in source control.

## Provider references

- fal image endpoint: https://fal.ai/models/fal-ai/flux/dev/api
- fal video models: https://fal.ai/flux-video
- OpenAI Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create
- YouTube search.list: https://developers.google.com/youtube/v3/docs/search/list
- YouTube videos.list: https://developers.google.com/youtube/v3/docs/videos/list
