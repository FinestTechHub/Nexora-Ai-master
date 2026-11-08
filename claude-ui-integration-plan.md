# Nexora AI — Claude UI integration plan

Status: inspection complete; no UI files have been merged yet.

## Source-of-truth decision

- Master project: this Express + static HTML application. It remains the only application runtime and owns authentication, sessions, SQLite data, credits, generation jobs, provider integrations, and API routes.
- Claude reference project: `nexora-ai.zip`, a Next.js 15 / React 19 / TypeScript / Tailwind presentation prototype. Use it only as the design and component reference.
- Standalone dashboard preview: `Nexora Ai – Dashboard Preview (1).html`, an additional visual reference for the blue/sky palette, light/dark theme, responsive sidebar, sticky top bar, search, prompt panel, tool cards, studio layouts and responsive breakpoints.

## Findings from the supplied Claude project

1. The project is a separate Next.js application with its own `app/`, `components/`, `lib/`, `public/` and `package.json`.
2. Its dashboard is explicitly demo-only: hard-coded balance (420 credits), sample projects, demo notifications and demo user details. The dashboard page itself warns that AI generation and payments are not connected.
3. It contains useful page concepts beyond the current master UI: image, video, image-to-video, voice, script, ideas, thumbnails and YouTube SEO.
4. Its shared `DashboardShell` has responsive navigation, tool search, credit pill, notifications and profile menu. These are visual patterns, not production account data.
5. It depends on Next.js/React/Tailwind and does not include the master project's Express API, SQLite persistence, generation worker, provider credentials or credit transaction implementation.

## Integration plan (no rewrite)

### Phase A — design tokens and shared shell
- Extract Nexora logo asset and confirm its wordmark treatment.
- Port CSS variables and typography into the master project's existing `public/index.html` stylesheet.
- Implement light/dark theme using the same tokens; preserve accessible focus states and reduced-motion behavior.
- Port the responsive sidebar/topbar patterns into the existing SPA shell, retaining its current route/view mechanism.

### Phase B — page-by-page UI adaptation
- Map Claude's overview to the existing dashboard view.
- Map Image Studio and Video Studio to existing generation forms and API routes.
- Map YouTube SEO to the existing `/api/seo/optimize` workflow.
- Treat image-to-video, voice, script, ideas and thumbnails as future/placeholder modules unless a working backend exists; do not present them as operational features.
- Reuse one shared card, form, prompt, result, empty-state and toast system. Do not duplicate components or add a second router.

### Phase C — connect real data
- Replace demo user, demo credits, sample usage, fake recent creations and demo notifications with authenticated API responses.
- Keep ownership checks and server-side credit charging authoritative.
- Ensure every generated job is polled using the existing job endpoints and persisted result history.
- Hide or label any feature whose provider integration is not implemented.

### Phase D — responsive/accessibility QA
- Verify narrow mobile (320–390px), tablet (768px) and desktop (≥1024px).
- Check sidebar open/close, keyboard focus, search dropdown, long prompts, loading/error states, dark mode and safe-area insets.
- Run API regression tests to ensure UI work does not change server behavior.

## Important implementation boundary

Do not copy Claude's `app/` or `components/` wholesale into the master project. Do not replace the master `server.js`, `lib/generation-jobs.js`, auth, database or provider integration. The Next.js prototype is not a backend replacement and currently displays demo data.

## Acceptance criteria

- One deployable app and one source of truth.
- Nexora branding consistently applied.
- Existing image/video/SEO endpoints still work.
- Existing auth, projects, credit and job behavior preserved.
- No fake balance or fake successful generation in production.
- Mobile, tablet and desktop layouts pass manual QA.
