# Acceptance checks

## Demo preview

- [ ] Website renders at desktop and mobile widths without horizontal page overflow.
- [ ] Consultation form validates required fields and consent. Demo submission appears in this browser's dashboard after refresh.
- [ ] Search and stage filtering show the correct customers.
- [ ] Customer record edits persist after reload.
- [ ] A survey scheduled in Central Time appears at the same Central Time in the schedule.
- [ ] Changing the stage updates dashboard counts, pipeline board, proposal list and won-customer handoff list.
- [ ] Demo brief button produces a labeled local-template brief, not an API claim.
- [ ] Proposal draft downloads and includes the non-binding draft notice.
- [ ] CSV export includes the filtered results.
- [ ] Settings reset restores sample data after confirmation.

## Connected deployment (requires accounts)

- [ ] Migration applied and public anon role cannot select, insert or update leads.
- [ ] Authenticated non-staff user cannot read leads or jobs and cannot call service RPCs.
- [ ] Staff user can read leads and change only stage, value, survey time and notes.
- [ ] Staff cannot grant themselves membership, modify automation leases or write AI summaries.
- [ ] Valid Turnstile form writes one lead and one queue job.
- [ ] Invalid / expired Turnstile, unapproved origins and malformed payloads are rejected.
- [ ] Repeating the same request UUID does not create a duplicate lead/job.
- [ ] More than five accepted submissions per IP per minute are rate limited.
- [ ] Configured n8n worker generates a brief and sets its job to completed.
- [ ] Two concurrent claim calls return distinct jobs or an empty result.
- [ ] Simulated AI refusal / quota failure moves the job to retry, then failed after three attempts.
- [ ] A worker with an old lease token cannot finish a re-leased job.
- [ ] Staff can review drafts. No customer message is sent by either workflow.
- [ ] Secrets are present only in provider secret stores and n8n credentials, never in the browser bundle.
