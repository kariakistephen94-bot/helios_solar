## District rotation and review quality upgrade

Apply **only** `supabase/migrations/202610300003_district_rotation.sql` to the existing Supabase project after the backend API upgrade. Do not rerun the fresh-install schema. This additive upgrade retains all existing leads, conversations, appointments, prospects and staff edits. It adds private search checkpoints and a daily discovery ledger, plus rating/review-count/district fields on private prospects. First application pauses collection and cancels old whole-city jobs; rerunning it preserves new progress.

Defaults:

- DAILY_NEW_TARGET=20 previously unseen qualifying businesses, counted by **Africa/Lagos** calendar day. This is a target, not a guarantee.
- MIN_REVIEW_COUNT=10 aggregate Google ratings; MIN_RATING=4.0 average stars. Missing ratings/counts fail the quality filter. This does not mean every individual review is positive, nor establish buying intent.
- Ten configured Abuja district windows: Wuse II, Maitama, Asokoro, Garki, Jabi, Utako, Gwarinpa, Wuye, Guzape and Kado. These are approximate search windows, not official administrative boundaries or a ranking of every district.
- One district/category per request, interleaved across districts. There is no Abuja-wide query. Each request uses a district-specific text query, hard rectangle and Google minRating; results are checked again server-side and in SQL.
- Cursor, page state and buffered surplus results persist in Supabase. A completed/exhausted search is rested for REVISIT_HOURS=168 before a revisit. Old page tokens expire locally after 15 minutes; rejected tokens are reset safely instead of triggering anti-detection measures.
- New results stop exactly at the daily target. Duplicate matches only update existing prospects, never increase the daily count. Surplus qualifying results from the final page are buffered for later. A repeated page commit is idempotent and an expired worker cannot overwrite a newer lease.
- DAILY_REQUEST_LIMIT remains the existing Google-attempt cap (100 by default), with request spacing, retries and cooldowns. It is independent of the 20-new-prospect target; request counters reset at UTC midnight. Manual runs cannot bypass the daily discovery target.
- `GET /v1/collector` reports `new_today`, `daily_target`, `remaining_target`, `active_district`, ratings thresholds, requests used and search slots remaining. `GET /v1/scans` reports `outcome` such as `daily_target_reached` or `search_plan_exhausted`; a shortfall is never reported as success at the target.
- Existing unreviewed prospects remain in Supabase but are excluded from the default quality-filtered list until rediscovered and checked. Use `GET /v1/prospects?qualified_only=false` to inspect retained legacy records; their staff fields are unchanged.
- WhatsApp verification is intentionally not added, as requested. No messages are sent.

After applying the SQL, restart the API and worker if they are not already running. Check `/health/ready` returns 200, then enable collection through `PATCH /v1/collector` with `{"enabled":true}`. Enabling may start the scheduled job immediately. The dashboard's Abuja prospects view shows daily progress, district, stars and rating count.

The Google Places field mask now includes `rating` and `userRatingCount`; rate limits and the source agreement still apply. Sources: [Google Text Search reference](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText), [Places field masks](https://developers.google.com/maps/documentation/places/web-service/text-search).

# Helios FastAPI API — Supabase keys

The backend uses Supabase's HTTPS Data API and database RPCs. It requires **only a project URL, anon key and backend secret key** for Supabase connectivity. No DATABASE_URL, PostgreSQL password, SQLAlchemy, Alembic or PostgreSQL client driver is used. There is no local data fallback.

```
Dashboard -> FastAPI API -> Supabase HTTPS API / RPC -> Supabase database
Google Places -> collector worker -> Supabase HTTPS RPC
Dashboard sign-in -> Supabase Auth
```

## Configuration

In `backend/.env`:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_ANON_KEY
SUPABASE_SECRET_KEY=YOUR_SECRET_KEY
GOOGLE_PLACES_API_KEY=YOUR_GOOGLE_KEY
```

SUPABASE_ANON_KEY accepts the legacy anon JWT or a modern `sb_publishable_...` key. SUPABASE_SECRET_KEY accepts a modern `sb_secret_...` key or a legacy service_role JWT. The old environment names SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY are also supported as aliases. Use one variable per key; remove empty canonical variables if you intend to use their aliases. Secret keys are sent only to your configured Supabase server and never returned to the dashboard or logged. Modern secret keys use the `apikey` header; legacy service_role JWTs use the required bearer header too.

The frontend root `.env.local` needs NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY remains an alias). Only the anon/publishable key belongs in frontend configuration. Staff still sign in through Supabase Auth and must have a `public.staff_members` row. The anon key and secret key themselves cannot be used to sign into staff API routes.

## One-time schema setup

This is an **upgrade of your existing system** from the pinned chat **Build a solar company system**. Your Supabase project already has `public.leads`, `public.messages` and `public.appointments`, including WhatsApp follow-up data. **Do not rerun `202610240001_helios.sql` or the old fresh-install download. Do not drop or rename existing tables.**

Run only `supabase/migrations/202610300002_backend_api.sql` in the SQL Editor of that existing project. It adds private collector/support tables and the service-only RPC without recreating or altering your existing leads/messages/appointments tables or changing their rows. If `staff_members` is missing, it adds the membership table and self-read policy; an existing membership table and its policies are preserved. The file is safe to rerun.

The API adapts the existing WhatsApp lead schema instead of expecting the prototype's different schema or an `automation_jobs` table. Value, survey and other extra dashboard fields live in private `helios.lead_details`. Missing bill/value information is returned as null. Existing n8n follow-up statuses appear in the job log. Saving a record changes its existing stage/notes and private dashboard details; it does not reset follow-up status, opt-out flags or conversation history. Public form requests, when enabled, use an idempotent intake RPC compatible with the existing lead table, without activating WhatsApp follow-ups.

Use your existing Supabase Auth account when adding staff membership. The UUID must be an **Auth user UUID**, not an existing lead's ID:

```sql
insert into public.staff_members(user_id, display_name)
values ('YOUR_EXISTING_AUTH_USER_UUID', 'Steve')
on conflict (user_id) do update set display_name = excluded.display_name;
```

The backend API key cannot create schemas or database functions through the Data API; schema setup remains a separate one-time SQL Editor/deployment operation. No database connection string is required at runtime. Don't add the `helios` schema to Supabase's exposed schemas. Only a narrow RPC in `public` is exposed, with EXECUTE granted exclusively to `service_role`; anon and authenticated roles cannot call it or access private tables. Keep the Supabase Data API enabled with `public` available, then wait for schema-cache reload if the RPC is initially unavailable.

## Run

From `backend/`:

```sh
uv sync --frozen
uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
# Separate terminal:
uv run python -m app.worker
```

API docs: http://127.0.0.1:8000/docs. Authorize with a **staff user's access token**, never a project key. Dashboard: http://127.0.0.1:3002/dashboard/. It calls FastAPI for all lead/prospect reads and edits. For Docker, configure `.env` then `docker compose up --build -d`; both services connect to external Supabase. Schema SQL must already be applied. API readiness calls the RPC and reports failure if setup or connectivity is missing.

## Data and security

The anon key plus the user's JWT is used for Auth and staff-membership checks. After verifying staff membership, FastAPI uses the backend secret for staff-authorized lead, prospect and collector RPC operations. The existing lead policies are preserved; the service-only RPC is protected by FastAPI staff membership checks. A secret key never authenticates an incoming API request as staff. All users belong to the existing single-company workspace.

Prospects, Google-ID aliases, scan jobs, page receipts, control settings, request budgets and audit events persist in Supabase. The worker uses atomic row locking and expiring fencing tokens inside RPC transactions. Only one live collector is admitted across replicas. Stale workers cannot reserve requests, commit a page or finish a replacement lease. Page receipts prevent duplicate page commits after ambiguous network failures. Request budgets count every Google attempt and reset at UTC midnight. Staff pipeline fields survive rediscovery; new prospects do not claim consent. Fingerprint matching covers normalized name/address and Google ID aliases; renamed/moved businesses with new IDs may require review.

Google collection defaults to disabled. Configure the key, restart the API and worker, then enable collection and request a scan in **Abuja prospects**. The pilot uses a configured urban Abuja rectangle, not an official FCT boundary or exhaustive directory. Nigerian country components, in-bounds coordinates, operational status and public contact details are required. The connector respects request spacing, bounded retries, cooldowns and daily budgets. Access denial disables collection; it does not evade restrictions. Use the data as permitted by your source agreement. No automated outreach is sent.

Public enquiries use POST /v1/inquiries. Configure TURNSTILE_SECRET_KEY, a private IP_HASH_SALT of at least 32 characters, and the frontend's NEXT_PUBLIC_TURNSTILE_SITE_KEY. FastAPI validates the challenge, exact origin, input and consent, then calls the atomic existing-system intake action with its secret key. No customer record is written to browser storage.

## Deployment

Deploy the Next.js frontend and `backend/` independently. Set NEXT_PUBLIC_API_URL to the backend HTTPS origin and rebuild the frontend. Set ENVIRONMENT=production and explicit HTTPS CORS_ORIGINS on the backend. Supabase secrets/database content must not appear in public environment variables.

Use a trusted TLS reverse proxy with request body limits, per-IP/auth rate limits, and safe logs. Trust forwarded client IPs only from that proxy. Protect backend secrets in your deployment secret store, set source quotas and billing limits, and configure Supabase backups/PITR and source-agreement retention. Monitor readiness, worker process health, failed scans and time since the last completed scan. Real multi-instance/network failure and live Google checks are required in credentialed staging before production.

## Tests

`uv run pytest` in backend tests key configuration/aliases, header separation, staff verification, errors without secret leakage, territory checks, request budgets, and worker RPC fencing arguments using mocked HTTP services.

`npm test` in the frontend root additionally tests the actual Supabase SQL with embedded PostgreSQL: role permissions, duplicate identities, idempotent page commits, optimistic concurrency, budget limits, expired-lease recovery, stale-worker rejection and access-denial pausing. These isolated tests are not runtime storage.


## Website Sol chat

Sol calls OpenAI directly through POST /v1/chat, independently of n8n. Add
OPENAI_API_KEY to backend/.env and optionally change OPENAI_CHAT_MODEL
(default gpt-4.1-mini), then restart the API. Never use a NEXT_PUBLIC_ variable
for this key. GET /v1/chat/status reports configuration presence, not key validity.

Chat history is held in the current browser tab's React state only; a reload clears it.
The backend forwards bounded history with store:false and does not save chat into
Supabase or create appointments. The consultation action opens the existing form.
Only text is supported. Provider failures are shown honestly with retry/edit controls.

The API checks allowed origins and enforces local in-memory request/concurrency
limits. Before public or multi-worker deployment, add shared gateway abuse controls
and verification. CORS/origin checks are not authentication. An API key is required
for a live model test; mocked tests do not spend credit.


## Dashboard calendar and staff login

The website reads its Supabase URL and public anon key from root .env.local. Never place
a backend secret or OpenAI key in NEXT_PUBLIC_ variables. Provision staff in Supabase
Authentication, then add the Auth user UUID to public.staff_members. There is no
default password or public admin registration. Sign in at /dashboard/.

Apply supabase/migrations/202610300004_dashboard_calendar.sql once in the existing
Supabase project's SQL Editor. It is additive and rerunnable. It creates private
helios.calendar_events plus a service-only helios_calendar RPC. It does not change
existing public leads, messages, appointments, opt-out fields, or Google events.
Existing appointments are shown read-only; manage those through their original workflow.
New dashboard appointments are stored locally in Supabase and never sent to Google Calendar.

Staff API: GET/POST /v1/calendar, PATCH /v1/calendar/{id}, POST /v1/calendar/{id}/cancel.
All routes require an authenticated staff user. The server resolves America/Chicago
local times, rejects ambiguous/nonexistent DST times, enforces positive durations,
and uses version checks for edits. Dashboard writes are serialized by an advisory lock,
with overlap checks against local scheduled events and current confirmed appointments.
Existing n8n writes do not participate in that lock; unified cross-channel scheduling
requires routing all booking writers through the same transaction.

Month, week and agenda views use actual records, with event-type colors, customer links,
search, type filters and a 30-second refresh. Cancellation keeps history. Missing
calendar storage produces a read-only view with a setup notice instead of fake data.
The dashboard's customer drawer loads the latest 100 saved messages. Workspace summaries
reflect the newest 1,000 leads and latest 50 follow-up records supplied by the existing RPC.
Sol chat does not yet have an automatic booking tool for this calendar.


## Sol consultation booking

Apply 202610300005_website_booking.sql after the calendar upgrade. Website Sol uses
OpenAI function calls to check a specific slot or prepare a signed review card.
Preparation does not save a lead or appointment. Confirm booking posts the signed
card to /v1/chat/booking/confirm, which validates the signature, expiry and client
binding, then runs a service-only transaction that rechecks conflicts and saves
the website lead and local calendar event together. Repeating the same confirmation
returns the same event without creating another lead. A new website lead is used
instead of merging by an unverified email. No n8n, Google Calendar or invitations
are involved. Dashboard staff can edit/cancel website-created events.

Consultations are 30 minutes, weekdays 9–5 America/Chicago on the hour or half hour,
at least 15 minutes ahead and up to 90 days ahead. Tokens expire after 15 minutes.
IP_HASH_SALT must contain at least 32 characters and remain stable across backend
instances. The public booking RPC is executable only by service_role, never anon
or authenticated. At most three bookings per client hash per 24 hours are admitted.
Public deployment still needs shared rate limits and anti-abuse verification at
the gateway; the current chat rate guard is process-local. Existing n8n writers
are outside the local calendar's transaction lock. Website chat rescheduling and
cancellation remain unsupported. Chat transcripts are not persisted as customer
messages; the confirmed booking captures contact details and the reviewed need summary.


## Dashboard Sol overview

Dashboard Sol is separate from website Sol. It uses /v1/staff/chat and requires a
valid Supabase staff session; public chat has no access to staff statistics. Its
conversation is remounted when switching between public and staff roles and when
the staff identity changes. It disappears from the dashboard on sign-out.

Each response fetches exact aggregate counts for enquiries, pipeline stages,
incoming/outgoing messages, channels, follow-up states, appointments and prospects.
Only the aggregate snapshot is sent to OpenAI, not customer names, contact details,
message bodies, notes or individual appointment details. Staff-entered chat messages
are sent normally. Counters use Supabase HEAD requests with count=exact; missing
counts are null, never a fabricated zero. Local calendar counts cover 60 days.

Incoming messages are not unique customers or campaign-attributed replies.
Outbound campaign reply tracking is not connected. Dashboard Sol is read-only and
has no website booking tools or record-modification tools.


### Fixed outreach draft preview

Staff can POST `/v1/outreach/preview` with `business_name`, optional known
`owner_name`, and optional curated `short_business_name`. This creates only a
preview: no AI calls, persistence, dispatch, or WhatsApp messages. The greeting
uses Africa/Lagos (before noon: morning; noon to 5 pm: afternoon; after: evening).
Legal suffixes and explicitly labelled branch suffixes are removed. Ambiguous
names over 40 characters require a reviewed short name instead of arbitrary
truncation. Owner names must be known, never inferred from a business name.
This preview does not establish sending eligibility or an approved Meta template.
