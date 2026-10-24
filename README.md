# Helios Solar

A complete first-version client concept for a fictional residential solar company in Austin, Texas. Built with **Next.js, Supabase and n8n**. All sample customers and opportunity values are fictional. The published preview is private and runs in demo mode until live services are configured.

## What works now

- Responsive public website with solution sections, interactive bill input, FAQs and a validated consultation form.
- Staff dashboard: searchable/filterable lead list, pipeline board, editable stages, staff-entered opportunity values, Central Time survey scheduling, proposal tracking and won-customer project handoffs.
- CSV customer export with spreadsheet formula escaping. Downloadable preliminary proposal drafts.
- Demo qualification briefs and follow-up drafts; all demo edits persist in the current browser. Reset in Settings.
- Production integration code: staff authentication, RLS policies, public lead-intake Edge Function, bot verification, atomic database job queue, and two importable n8n workflows.

The demo brief button uses a local template, **not an AI call**. Live AI runs in n8n after configuration. No customer messages, calendar invitations, payment requests or signed contracts are sent or created. Project execution beyond the won-customer handoff is a later phase.

## Local development

Use Node 22+.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000 and http://127.0.0.1:3000/dashboard/.

```sh
npm run typecheck
npm test
npm run build
```

`next build` creates `out/`. This is a real Next.js static export; server-side data processing lives in Supabase Edge Functions and n8n. It can be hosted on any static host. If using Vercel, import this repository and retain the static export configuration. The Sites manifest is included for the private preview deployment.

## Architecture

```mermaid
flowchart LR
  A[Next.js public website] -->|Verified enquiry| B[Supabase lead-intake function]
  B -->|Atomic transaction| C[(Leads + automation queue)]
  D[n8n schedule] -->|Claim with lease| C
  D --> E[OpenAI structured brief]
  E -->|Validate and save| C
  C --> F[Authenticated staff dashboard]
  F --> G[Human review and customer follow-up]
```

Demo mode stays in browser local storage. Live mode has no browser-local customer fallback: service failures are reported rather than silently saving to a local demo.

## Connect Supabase

1. Create a Supabase project in your preferred region. This package does not create an account or incur a subscription.
2. Apply `supabase/migrations/202610240001_helios.sql` through the SQL editor, or link the project with the Supabase CLI and run `supabase db push`.
3. Create a staff user through **Authentication → Users**. Public sign-up is not part of this app. Add the user's UUID to the staff table with the SQL editor:

```sql
insert into public.staff_members(user_id,display_name)
values ('REPLACE_WITH_AUTH_USER_UUID','Alex Morgan');
```

4. Copy `.env.example` to `.env.local`. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. These two values are safe for the browser when RLS is enabled. Never put a secret or service-role key in a `NEXT_PUBLIC_` variable.
5. Configure your Supabase Auth site URL and allowed redirect URLs for the deployed origin. Disable public self-sign-up if staff onboarding is administrator-only. Staff without a `staff_members` entry cannot read leads, even if they can authenticate.
6. Set up Cloudflare Turnstile for the actual website hostname and add `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. In Supabase Edge Function secrets, add `TURNSTILE_SECRET_KEY`, `IP_HASH_SALT` (random private value), and `ALLOWED_ORIGINS` (comma-separated exact origins, no trailing slash). Do not use Turnstile test keys for a public production site.
7. Deploy the function:

```sh
supabase functions deploy lead-intake --no-verify-jwt
```

The function deliberately accepts public requests, verifies Turnstile server-side, checks the exact origin and challenge hostname, validates a capped request body, and calls a service-only RPC. The RPC atomically inserts the lead and job. RLS denies direct public reads and writes. A per-minute hashed-IP limit allows five enquiries per minute; hashes expire after one day. IP throttling is an abuse control, not an identity check. Add provider-level rate limiting for a high-volume launch.

8. Rebuild and redeploy with all public environment values set. Without both Supabase values, the application stays in demo mode. Next.js substitutes public environment variables **at build time**; changing them requires a rebuild. Turnstile is required for live submission. Staff login appears automatically in live mode.

## Import n8n workflows

Both files are inactive on import; the setup notes are also inside the workflows.

- `n8n/01-enquiry-qualification.json`: every minute, claim one eligible job, call the OpenAI Responses API, validate structured output, and save a draft brief and follow-up.
- `n8n/02-operations-snapshot.json`: weekdays at 08:00 America/Chicago, fetch aggregate operations counts. It returns data inside the workflow; no delivery destination is connected.

### Credentials

1. In each workflow's **Configuration** Code node, replace `https://YOUR-PROJECT.supabase.co` with your Supabase URL. No secrets belong in this node.
2. Create an **HTTP Custom Auth** credential in n8n containing:

```json
{
  "headers": {
    "apikey": "YOUR_SUPABASE_SERVICE_ROLE_JWT",
    "Authorization": "Bearer YOUR_SUPABASE_SERVICE_ROLE_JWT"
  }
}
```

Use the legacy Supabase **service_role JWT** from Project Settings → API for this credential, not a browser publishable key. It must remain server-side. Choose this credential on **Claim next enquiry**, **Finish job**, and **Snapshot**. These functions are service-role-only. A project secret key can also be used with the appropriate gateway authentication configuration, but the documented two-header setup uses the service-role JWT.

3. Create an **OpenAI** credential with your API key and choose it on **Generate brief**. `gpt-4.1-mini` is configured as the starting model; replace it if unavailable in your account with a Responses model supporting structured outputs. Keep provider spending limits enabled.
4. Test with a real enquiry submitted through your configured website, manually execute workflow 01, and confirm the dashboard shows a brief and the job status is `completed`. Then activate the workflow. There is one claim per run, so default throughput is one enquiry per minute. Raise scheduling frequency if needed.

### Recovery and review

- Claims use `FOR UPDATE SKIP LOCKED`, a fresh lease token and a ten-minute lease. Multiple workers cannot claim the same active lease.
- Failed AI requests or invalid results become `retry`, delayed five minutes, up to three attempts. A final failure is visible in the dashboard. A crash before completion is recovered after lease expiry. If Finish itself fails, the lease recovery path applies.
- Stale workers cannot commit over a newer lease. Intake has a unique request UUID to prevent duplicate insertions for the same submission.
- The AI has no tools, never changes the pipeline stage and never sends messages. Submitted notes are treated as untrusted data. Only name, city, bill, interest and notes go to the AI; email, phone and street address are excluded. Staff notes are still potentially sensitive: review your data handling policy.
- Staff approve technical design and final prices. The follow-up is a draft to copy and review, not an automated email.
- Successful and failed execution payload persistence is disabled in the exported workflows. Protect manual runs, disable pinning customer data and configure execution pruning in n8n. No notification integration has been activated.

To retry a permanently failed job after fixing configuration, an administrator can run:

```sql
update public.automation_jobs
set status='retry',attempts=0,next_attempt_at=now(),lease_token=null,last_error=null
where id='REPLACE_WITH_JOB_UUID' and status='failed';
```

## Launch preparation and limits

This is a working demonstration and a deployable foundation, not an assertion that external services have been provisioned. Supabase, n8n, OpenAI and Turnstile require your own accounts and credentials. Live end-to-end execution cannot be verified without them.

Before taking real enquiries, replace the fictional company identity and privacy notice, configure a real service area, create staff accounts, run the acceptance checklist in `ACCEPTANCE.md`, set backup and retention policies, and verify domain configuration. Do not use the sample proposal as a binding contract. No invented testimonials, installation counts or guaranteed financial savings are represented.

The monthly-bill slider is an input aid, not a savings calculator. Opportunity values are manually entered, not generated installation prices. Proposals are text drafts rather than signed documents. Payments, document uploads, lender integrations, messaging delivery, full installation task management and live inverter monitoring are not implemented in this first version.

## References and assets

- [Next.js static exports](https://nextjs.org/docs/app/guides/single-page-applications#static-export-optional)
- [Supabase Next.js guide and RLS](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs)
- [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets)
- [n8n HTTP Request credentials](https://docs.n8n.io/integrations/builtin/credentials/httprequest/)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- Hero solar photograph: [Unsplash image](https://unsplash.com/photos/2e959784a276); the file is supplied locally for the demo. It is illustrative and is not represented as a Helios installation.
