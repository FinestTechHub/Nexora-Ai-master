import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import {
  ensureGenerationJobsSchema, enqueueGenerationJob, claimNextGenerationJob,
  completeGenerationJob, failGenerationJobAndRefund, interruptProcessingGenerationJobs,
  getGenerationJobForUser, listGenerationJobsForUser
} from './lib/generation-jobs.js';

const scrypt = promisify(scryptCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const isProduction = process.env.NODE_ENV === 'production';
// The __Host- prefix is enforced by browsers in production: Secure, Path=/, no Domain.
const sessionCookie = isProduction ? '__Host-cf_session' : 'cf_session';
const sessionTtlMs = 14 * 24 * 60 * 60 * 1000;
const starterCredits = positiveInt(process.env.STARTER_CREDITS, 100);
const dummySalt = randomBytes(16).toString('hex');
const creditCosts = {
  image: positiveInt(process.env.IMAGE_CREDIT_COST, 10),
  video: positiveInt(process.env.VIDEO_CREDIT_COST, 60),
  seo: positiveInt(process.env.SEO_CREDIT_COST, 5)
};

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'creatorforge.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    credits INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('image','video','seo')),
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
`);
try { fs.chmodSync(dbPath, 0o600); } catch { /* Some filesystems do not support chmod. */ }
ensureGenerationJobsSchema(db);
const interruptedAtStartup = interruptProcessingGenerationJobs(db, nowIso());
if (interruptedAtStartup > 0) console.warn(`Marked ${interruptedAtStartup} previously running generation job(s) as interrupted for review.`);

if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 })
  : null;
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', positiveInt(process.env.TRUST_PROXY_HOPS, 0));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '100kb', strict: true }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: isProduction ? '1h' : 0 }));

function nowIso() { return new Date().toISOString(); }
function withTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ } throw error; }
}
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
  }
  return null;
}
function setSessionCookie(res, token) {
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`);
}
function clearSessionCookie(res) {
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
function safeUser(row) {
  return { id: row.id, email: row.email, role: row.role, credits: row.credits, createdAt: row.created_at };
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' });
    } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.' });
  next();
}
app.use('/api', sameOrigin);

const authAttempts = new Map();
function authRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = authAttempts.get(key) || { start: now, count: 0 };
  if (now - record.start > 15 * 60 * 1000) { record.start = now; record.count = 0; }
  record.count += 1;
  authAttempts.set(key, record);
  if (authAttempts.size > 5000) { for (const [k, v] of authAttempts) if (now - v.start > 15 * 60 * 1000) authAttempts.delete(k); }
  if (record.count > 20) return res.status(429).json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' });
  next();
}
function requireAuth(req, res, next) {
  const token = cookieValue(req, sessionCookie);
  if (!token || token.length > 200) return res.status(401).json({ error: 'Please sign in to continue.' });
  const tokenHash = hashToken(token);
  const row = db.prepare(`SELECT u.id, u.email, u.role, u.credits, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, Date.now());
  if (!row) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
  req.user = safeUser(row);
  req.sessionTokenHash = tokenHash;
  next();
}
function issueSession(userId, res) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + sessionTtlMs;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(hashToken(token), userId, expiresAt, nowIso());
  setSessionCookie(res, token);
}
function getBalance(userId) {
  return db.prepare('SELECT credits FROM users WHERE id = ?').get(userId)?.credits ?? 0;
}
function reserveCredits(userId, amount, reason) {
  const reference = randomUUID();
  const reserved = withTransaction(() => {
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!user || user.credits < amount) return false;
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(amount, userId);
    db.prepare(`INSERT INTO credit_transactions(id,user_id,amount,reason,reference,created_at)
      VALUES(?,?,?,?,?,?)`).run(randomUUID(), userId, -amount, reason, reference, nowIso());
    return true;
  });
  return reserved ? reference : null;
}
function refundCredits(userId, amount, reference, reason) {
  withTransaction(() => {
    const existing = db.prepare('SELECT id FROM credit_transactions WHERE reference = ?').get(`refund:${reference}`);
    if (existing) return;
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(amount, userId);
    db.prepare(`INSERT INTO credit_transactions(id,user_id,amount,reason,reference,created_at)
      VALUES(?,?,?,?,?,?)`).run(randomUUID(), userId, amount, reason, `refund:${reference}`, nowIso());
  });
}
function saveProject(userId, type, title, input, output) {
  const id = randomUUID();
  db.prepare(`INSERT INTO projects(id,user_id,type,title,input_json,output_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(id, userId, type, title.slice(0, 160), JSON.stringify(input), JSON.stringify(output), nowIso());
  return id;
}
function generationLimit(req, res, next) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM credit_transactions
    WHERE user_id = ? AND amount < 0 AND created_at >= ?`).get(req.user.id, new Date(cutoff).toISOString()).n;
  if (count >= positiveInt(process.env.MAX_GENERATIONS_PER_HOUR, 20)) {
    return res.status(429).json({ error: 'You have reached the hourly generation limit. Please try again later.' });
  }
  next();
}
function validateText(value, label, max, required = true) {
  if (value === undefined || value === null) return required ? `${label} is required.` : null;
  if (typeof value !== 'string') return `${label} must be text.`;
  if (required && !value.trim()) return `${label} is required.`;
  if (value.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}
function providerFailure(label) {
  return `${label} could not be completed right now. No credits were charged. Please try again later.`;
}
function logProviderFailure(provider, err) {
  // Do not log provider error messages or request URLs: SDK errors can contain sensitive request details.
  const details = {
    name: typeof err?.name === 'string' ? err.name.slice(0, 60) : 'Error',
    status: Number.isInteger(err?.status) ? err.status : undefined,
    code: typeof err?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(err.code) ? err.code : undefined
  };
  console.error(`${provider} provider request failed`, details);
}

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  providers: {
    imageVideo: Boolean(process.env.FAL_KEY),
    seoAssistant: Boolean(process.env.OPENAI_API_KEY),
    youtubeResearch: Boolean(process.env.YOUTUBE_API_KEY)
  },
  authentication: true,
  database: 'sqlite-single-instance',
  generationQueue: 'durable-single-worker',
  creditCosts
}));

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be between 10 and 128 characters.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  const salt = randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
  const id = randomUUID();
  // Never grant admin privileges during public registration. Promote admins out-of-band with the CLI script.
  const transaction = () => withTransaction(() => {
    db.prepare(`INSERT INTO users(id,email,password_hash,password_salt,role,credits,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, email, passwordHash, salt, 'user', starterCredits, nowIso());
    db.prepare(`INSERT INTO credit_transactions(id,user_id,amount,reason,reference,created_at)
      VALUES(?,?,?,?,?,?)`).run(randomUUID(), id, starterCredits, 'Welcome credits', `welcome:${id}`, nowIso());
  });
  try { transaction(); }
  catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with this email already exists.' });
    throw err;
  }
  issueSession(id, res);
  const user = db.prepare('SELECT id,email,role,credits,created_at FROM users WHERE id = ?').get(id);
  res.status(201).json({ user: safeUser(user) });
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 128) return res.status(400).json({ error: 'Enter your email and password.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Perform a password-hash operation even for unknown emails to reduce account-enumeration timing differences.
  const candidate = (await scrypt(password, user?.password_salt || dummySalt, 64)).toString('hex');
  if (!user) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(user.password_hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  issueSession(user.id, res);
  res.json({ user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = cookieValue(req, sessionCookie);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/projects', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id,type,title,created_at FROM projects
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).all(req.user.id);
  res.json({ projects: rows.map(x => ({ id: x.id, type: x.type, title: x.title, createdAt: x.created_at })) });
});

app.get('/api/credits', requireAuth, (req, res) => {
  const transactions = db.prepare(`SELECT amount,reason,created_at FROM credit_transactions
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).all(req.user.id);
  res.json({ balance: getBalance(req.user.id), costs: creditCosts, transactions });
});

function requestIdempotencyKey(req, res) {
  const supplied = req.get('Idempotency-Key');
  if (supplied && !/^[A-Za-z0-9._:-]{8,128}$/.test(supplied)) {
    res.status(400).json({ error: 'Idempotency-Key must contain 8–128 safe characters.' });
    return null;
  }
  return supplied || randomUUID();
}

function enqueueRequest(req, res, type, title, input, cost) {
  const idempotencyKey = requestIdempotencyKey(req, res);
  if (!idempotencyKey) return;
  const result = enqueueGenerationJob(db, {
    userId: req.user.id, type, title, input, cost, idempotencyKey,
    maxPerHour: positiveInt(process.env.MAX_GENERATIONS_PER_HOUR, 20), now: nowIso()
  });
  if (result.kind === 'rate_limited') {
    return res.status(429).json({ error: 'You have reached the hourly generation limit. Please try again later.' });
  }
  if (result.kind === 'insufficient_credits') {
    return res.status(402).json({ error: 'Not enough credits. Please add credits to continue.', balance: result.balance, required: cost });
  }
  if (result.kind === 'missing_user') return res.status(401).json({ error: 'Please sign in again.' });
  if (result.kind === 'conflict') {
    return res.status(409).json({ error: 'This Idempotency-Key was already used for a different request. Use a new key.' });
  }
  const job = result.job;
  return res.status(result.kind === 'existing' ? 200 : 202).json({
    jobId: job.id, status: job.status, credits: result.balance,
    charged: job.creditCost, reused: result.kind === 'existing'
  });
}

async function executeImageJob(input) {
  const result = await fal.subscribe('fal-ai/flux/dev', {
    input: { prompt: input.prompt, image_size: input.aspect, num_images: 1 }, logs: false
  });
  const image = result.data?.images?.[0];
  if (!image?.url) throw new Error('No image URL returned');
  return { url: image.url, prompt: result.data.prompt || input.prompt };
}

async function executeVideoJob(input) {
  const result = await fal.subscribe('blackforestlabs/flux-3-max/text-to-video', {
    input: { prompt: input.prompt, duration: input.duration, aspect_ratio: input.aspect, generate_audio: true }, logs: false
  });
  const url = result.data?.video?.url;
  if (!url) throw new Error('No video URL returned');
  return { url, prompt: input.prompt, duration: input.duration };
}

async function executeSeoJob(input) {
  let competitors = [];
  let researchNote = 'YouTube competitor research is off because YOUTUBE_API_KEY is not configured.';
  if (process.env.YOUTUBE_API_KEY) {
    try {
      competitors = await youtubeResearch(input.topic, input.region);
      researchNote = 'Live public YouTube search results were used as context; they are not a guarantee of ranking.';
    } catch {
      researchNote = 'YouTube competitor research was unavailable for this request.';
    }
  }
  const instructions = `You are a practical YouTube SEO strategist. Help creators improve discoverability without keyword stuffing or promising rankings. Use natural language. Return valid JSON only with keys: seo_score (integer 1-100), title_options (array of 5 strings), recommended_title (string), description (string), tags (array of strings), hashtags (array of 3-5 strings), primary_keyword (string), secondary_keywords (array of strings), thumbnail_ideas (array of 3 strings), hook (string), chapters (array of objects with time and title; only if long-form, otherwise []), improvement_tips (array of 5 strings), rationale (string). Make the output specific to the topic and audience. Never claim you know private YouTube ranking factors.`;
  const prompt = `Video topic/working title: ${input.topic}\nAudience: ${input.audience}\nFormat: ${input.format}\nCurrent description/context: ${input.description}\nTarget region: ${input.region}\nPublic competitor examples: ${JSON.stringify(competitors)}\nResearch note: ${researchNote}`;
  const response = await openai.responses.create({ model, instructions, input: prompt });
  const raw = response.output_text || '';
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const result = JSON.parse(clean);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid AI response');
  return { ...result, competitors, researchNote };
}

let generationWorkerBusy = false;
const generationWorkerId = randomUUID();
async function processNextGenerationJob() {
  if (generationWorkerBusy) return;
  let job;
  try { job = claimNextGenerationJob(db, generationWorkerId, nowIso()); }
  catch (err) { console.error('Generation queue claim failed:', { name: err?.name || 'Error' }); return; }
  if (!job) return;
  generationWorkerBusy = true;
  let output;
  const providerName = job.type === 'seo' ? 'SEO' : job.type === 'video' ? 'Video' : 'Image';
  try {
    const input = JSON.parse(job.input_json);
    if (job.type === 'image') output = await executeImageJob(input);
    else if (job.type === 'video') output = await executeVideoJob(input);
    else output = await executeSeoJob(input);
  } catch (err) {
    logProviderFailure(providerName, err);
    try {
      failGenerationJobAndRefund(db, job.id, providerFailure(`${providerName} generation`), nowIso());
    } catch (refundError) {
      console.error('Generation failure/refund persistence failed:', { name: refundError?.name || 'Error' });
    }
    generationWorkerBusy = false;
    return;
  }

  try {
    completeGenerationJob(db, job.id, { output, now: nowIso() });
  } catch (err) {
    // The provider may already have charged us. Do not automatically refund an output
    // that was generated but could not be persisted; mark it for manual reconciliation.
    console.error('Generation result persistence failed:', { name: err?.name || 'Error' });
    try {
      db.prepare(`UPDATE generation_jobs SET status='interrupted',
        error_message='The provider returned a result but saving it failed. Contact support before retrying.',
        updated_at=?, finished_at=? WHERE id=? AND status='processing'`).run(nowIso(), nowIso(), job.id);
    } catch { /* Leave the processing record for startup recovery if the database is unavailable. */ }
  } finally {
    generationWorkerBusy = false;
  }
}

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json({ jobs: listGenerationJobsForUser(db, req.user.id, 10) });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = getGenerationJobForUser(db, req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Generation job not found.' });
  res.json({ job, credits: getBalance(req.user.id) });
});

app.post('/api/generate-image', requireAuth, (req, res) => {
  if (!process.env.FAL_KEY) return res.status(503).json({ error: 'Image generation is not configured yet. Add FAL_KEY on the server.' });
  const { prompt, aspect = 'landscape_4_3' } = req.body || {};
  const error = validateText(prompt, 'Image prompt', 2000);
  const allowedAspects = ['landscape_4_3', 'landscape_16_9', 'square', 'portrait_4_3', 'portrait_16_9'];
  if (error) return res.status(400).json({ error });
  if (!allowedAspects.includes(aspect)) return res.status(400).json({ error: 'Choose a supported image aspect ratio.' });
  const normalized = { prompt: prompt.trim(), aspect };
  return enqueueRequest(req, res, 'image', normalized.prompt, normalized, creditCosts.image);
});

app.post('/api/generate-video', requireAuth, (req, res) => {
  if (!process.env.FAL_KEY) return res.status(503).json({ error: 'Video generation is not configured yet. Add FAL_KEY on the server.' });
  const { prompt, duration = 5, aspect = '16:9' } = req.body || {};
  const error = validateText(prompt, 'Video prompt', 2000);
  const seconds = Number(duration);
  const allowedAspects = ['16:9', '9:16', '1:1', '4:3'];
  if (error) return res.status(400).json({ error });
  if (![5, 8, 10, 15, 20].includes(seconds)) return res.status(400).json({ error: 'Choose a supported video duration.' });
  if (!allowedAspects.includes(aspect)) return res.status(400).json({ error: 'Choose a supported video aspect ratio.' });
  const normalized = { prompt: prompt.trim(), duration: seconds, aspect };
  return enqueueRequest(req, res, 'video', normalized.prompt, normalized, creditCosts.video);
});

async function youtubeResearch(keyword, region = 'NG') {
  if (!process.env.YOUTUBE_API_KEY) return [];
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.search = new URLSearchParams({ part: 'snippet', q: keyword, type: 'video', order: 'viewCount', maxResults: '5', regionCode: region, key: process.env.YOUTUBE_API_KEY });
  const search = await fetch(searchUrl, { signal: AbortSignal.timeout(12_000) });
  const searchData = await search.json();
  if (!search.ok) throw new Error(searchData.error?.message || 'YouTube search failed.');
  const ids = (searchData.items || []).map(x => x.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsUrl.search = new URLSearchParams({ part: 'snippet,statistics,contentDetails', id: ids.join(','), key: process.env.YOUTUBE_API_KEY });
  const details = await fetch(detailsUrl, { signal: AbortSignal.timeout(12_000) });
  const detailsData = await details.json();
  if (!details.ok) throw new Error(detailsData.error?.message || 'YouTube video details failed.');
  return (detailsData.items || []).map(v => ({
    title: v.snippet?.title, channel: v.snippet?.channelTitle,
    views: Number(v.statistics?.viewCount || 0), likes: Number(v.statistics?.likeCount || 0),
    publishedAt: v.snippet?.publishedAt, videoId: v.id
  }));
}

app.post('/api/seo/optimize', requireAuth, (req, res) => {
  if (!openai) return res.status(503).json({ error: 'AI SEO is not configured yet. Add OPENAI_API_KEY on the server.' });
  const { topic, audience = 'general YouTube viewers', description = '', format = 'Long-form video', region = 'NG' } = req.body || {};
  const error = validateText(topic, 'Video topic', 300);
  if (error) return res.status(400).json({ error });
  for (const [value, label, max] of [[audience, 'Audience', 200], [description, 'Description', 5000], [format, 'Format', 60]]) {
    const e = validateText(value, label, max, false);
    if (e) return res.status(400).json({ error: e });
  }
  const normalizedRegion = typeof region === 'string' && /^[A-Z]{2}$/.test(region) ? region : 'NG';
  const normalized = { topic: topic.trim(), audience, description, format, region: normalizedRegion };
  return enqueueRequest(req, res, 'seo', normalized.topic, normalized, creditCosts.seo);
});

// Unknown API paths must stay API 404s; do not return the SPA HTML with a misleading 200.
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid JSON request.' });
  console.error('Unhandled server error:', { name: typeof err?.name === 'string' ? err.name.slice(0, 60) : 'Error' });
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, () => console.log(`CreatorForge AI running at http://localhost:${server.address().port}`));
  const workerTimer = setInterval(() => { void processNextGenerationJob(); }, positiveInt(process.env.GENERATION_WORKER_POLL_MS, 750));
  workerTimer.unref();
  const shutdown = () => {
    clearInterval(workerTimer);
    server.close(() => { try { db.close(); } catch { /* Already closed. */ } });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export { app, db };
