<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Existing Supabase system

This project continues the pinned chat "Build a solar company system". The live Supabase project already has public.leads, public.messages and public.appointments, with WhatsApp/n8n follow-up fields. Inspect the live schema before database changes. Use additive, rerunnable upgrades; never suggest rerunning the fresh-install 202610240001_helios.sql, dropping/recreating leads, or resetting existing conversation/opt-out/follow-up records. New collector support is in 202610300002_backend_api.sql. Backend auth uses Supabase URL, anon key and server-only secret. Public form removal was paused by the user; do not resume it without a new instruction.

District discovery uses 202610300003_district_rotation.sql: target 20 new prospects per Africa/Lagos day, at least 10 Google ratings and a 4.0 average, individual district windows, persisted rotation, and the existing request budget. Legacy prospects remain stored but are excluded from the default quality-filtered list until checked. WhatsApp verification was explicitly cancelled; do not add it.
