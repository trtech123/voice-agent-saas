# Handoff — ElevenLabs Migration Implementation

**For:** Claude Code Cloud session
**Date:** 2026-04-07
**Repo:** `trtech123/voice-agent-saas` (main branch)
**Latest commit:** `6d51419 docs: amend EL specs with all reviewer-flagged fixes (round 2)`

## What this is

A two-spec migration from Google Gemini Live → ElevenLabs Conversational AI for the Hebrew voice-agent SaaS. The specs are reviewer-clean (architect + backend + frontend reviewed twice) and ready to implement. **Do not redesign anything in the specs — implement them as written.**

## The two specs (read both before starting)

1. **`docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md`** — Spec A
   Backend cutover. Owns the entire database migration. Ships first. Hebrew voice agents stop using Gemini Live, start using ElevenLabs Conversational AI via WebSocket on the existing Asterisk + Voicenter pipeline.

2. **`docs/superpowers/specs/2026-04-07-elevenlabs-dashboard-ui-design.md`** — Spec B
   Dashboard UI v1. Voice picker, LLM provider settings, agent status pill, live transcript page, post-call review, polished failed-calls tab. **Hard prerequisite: Spec A must be in production for ≥72 hours, metrics green, before Spec B ships.**

Also read `CLAUDE.md` at the repo root for stack context (Asterisk + Voicenter on a DO droplet, Next.js dashboard on Railway, Supabase, BullMQ, plain-JS voice engine in `voiceagent-saas/`).

## Workflow to run in Claude Code Cloud

### Phase 0 — Pre-flight (BLOCKING gate)

Spec A §3.1 has a hard gate: **verify the encryption helper is real before writing any code.** The placeholder path is `packages/database/src/encryption.ts`. Find the actual file and verify it uses pgsodium / Supabase Vault / KMS envelope encryption — NOT app-layer AES with a static env secret. If it does not exist or is insufficient, the implementation plan must include building it first (likely pgsodium-based) as a prerequisite phase.

**Owner:** backend lead (you, in Cloud).
**Output:** a one-paragraph note in the implementation plan stating "encryption gate passed via X" or "blocked, building encryption helper first."

### Phase 1 — Plan Spec A

Use the writing-plans skill (or `/gsd:plan-phase` if you have GSD installed) to produce an implementation plan from Spec A. The plan should:
- Decompose Spec A into discrete tasks with clear acceptance criteria
- Identify file-level changes (new files, deleted files, modified files)
- Sequence the work so the SQL migration is first, then the new files, then the deletions
- Include all 13 manual end-to-end test steps from §6.1 as named verification gates
- Honor the 9-step rollout sequence in §6.2 exactly (do not reorder)

**Critical things the plan must NOT skip:**
- The `sync_version` CAS pattern in `agent-sync-processor.js` (§4.2 step 4) — this is the race-safety foundation
- The TOCTOU snapshot of `agent_id_used` + `sync_version_used` in the call job payload (§4.4 step 2)
- The webhook pre-check at §4.6 step 0 (256 KB cap + timestamp header presence) BEFORE the raw insert
- The `webhook_processed_at IS NULL` idempotency gate in the atomic UPDATE (§4.6 step 5)
- The async audio archive via separate `audio-archive-jobs` queue (§4.7) — NOT inline in the webhook
- The `live-turn-writer.js` as a process-wide singleton with cross-call batching at 500ms (§4.3)
- Live writer ONLY writes `call_turns`, NEVER `call_tool_invocations` (§4.3) — webhook is canonical
- DST-correct retry policy via `(now() at time zone 'Asia/Jerusalem')::date` (§5.2)
- Janitor with `FOR UPDATE SKIP LOCKED` (§4.8) AND audio-archive orphan sweep
- `BEFORE INSERT` trigger for `platform_settings` defaults — NOT app-layer fetch (§3 / §3.2)
- Migration SQL must do `ADD COLUMN nullable → backfill → SET NOT NULL` for `voice_id` and `tts_model` in one transaction (§3.2)

### Phase 2 — Execute Spec A

Once the plan is approved, execute it. The workflow:
1. Create a feature branch: `git checkout -b feat/elevenlabs-runtime-swap`
2. Apply the SQL migration via Supabase MCP (or `npx supabase db push --project-ref uwintyhbdslivrvttfzp`)
3. Implement files in dependency order (types → adapters → workers → bridge rewrite → webhook handler)
4. Tests as you go (unit + integration per §6.1)
5. Push the branch, open a draft PR
6. **Manual end-to-end test on a real Hebrew phone call** (the 13 steps in §6.1 are the canonical acceptance gate)
7. Once green, mark PR ready
8. Follow the §6.2 rollout sequence to deploy. **Do not skip the rehearsed-rollback step (Step 3).**

### Phase 3 — 72-hour watch

After Spec A cutover, watch metrics for 72 hours:
- `tts_first_byte_ms` p95
- `el_ws_open_ms` p95
- Webhook success rate
- `audio_archive_status='failed'` rate
- `call_failure_reason_t` distribution

If any metric is unhealthy, follow the rollback plan in §6.3. Do NOT proceed to Spec B until metrics are stable.

### Phase 4 — Plan & execute Spec B

Same workflow as Phase 1–2 but for Spec B. Spec B is purely additive UI on top of Spec A's schema — no new migrations except the `tenants.feature_flags jsonb` column noted in §7 (which is a coordination point — the plan should add it to Spec A's migration if Spec A hasn't shipped yet, or as a small follow-up migration if Spec A is already deployed).

Spec B ships behind a DB-backed feature flag (`tenants.feature_flags`), staged rollout: 1 internal tenant → 10% → 50% → 100% → remove flag.

## Essential context for Claude Code Cloud

### Stack quick facts
- **Dashboard:** Next.js 14, Tailwind, Hebrew RTL, deployed on Railway via GitHub auto-deploy from main
- **Voice engine:** plain JavaScript (no build step), deployed manually to DigitalOcean droplet 188.166.166.234 at `/opt/voiceagent-saas/`
- **Database:** Supabase project `uwintyhbdslivrvttfzp` (eu-central-1)
- **Queue:** BullMQ on Railway Redis
- **SIP:** Voicenter trunk via Asterisk PJSIP endpoint `voicenter_trunk`
- **Audio format:** slin16 (16 kHz signed linear PCM) — already correct for ElevenLabs `pcm_16000`, no resampling needed

### Files that will be deleted in Spec A
- `voiceagent-saas/gemini-session.js`
- `voiceagent-saas/audio-utils.js`
- `GEMINI_API_KEY` env var on droplet (after 72-hour rollback window per §6.2 Step 9)

### Files that will be created in Spec A
- `voiceagent-saas/elevenlabs-session.js`
- `voiceagent-saas/elevenlabs-tools-adapter.js`
- `voiceagent-saas/agent-sync-processor.js`
- `voiceagent-saas/audio-archive-processor.js`
- `voiceagent-saas/live-turn-writer.js`
- `voiceagent-saas/janitor.js`
- `apps/dashboard/app/api/webhooks/elevenlabs/conversation-ended/route.ts`
- `supabase/migrations/2026-04-07_elevenlabs_runtime_swap.sql`

### Files that will be modified in Spec A
- `voiceagent-saas/call-bridge.js` (rewritten, slimmer)
- `voiceagent-saas/call-processor.js` (snapshot agent_id + sync_version into job payload, DST-correct retry policy, sole writer of `daily_retry_count`)
- `voiceagent-saas/tools.js` (vendor-clean — only the schema export changes location)
- `voiceagent-saas/server.js` (wire new workers + janitor)

### New environment variables

**Droplet (`/opt/voiceagent-saas/.env`):**
```
ELEVENLABS_API_KEY=<from EL dashboard>
ELEVENLABS_WORKSPACE_ID=<if EL requires>
SUPABASE_DIRECT_DB_URL=<Supavisor transaction-mode connection string for postgres-js pool>
```

**Dashboard (Railway env vars):**
```
ELEVENLABS_WEBHOOK_SECRET=<from EL dashboard>
```

**NOT needed on dashboard:** `ELEVENLABS_API_KEY` is droplet-only (agent-sync REST runs on the droplet per §4.2).

### Supabase Storage

Create a private bucket `call-recordings` with:
- Max file size: 50 MB
- Allowed mime types: `audio/mpeg, audio/mp4`
- Path pattern: `{tenant_id}/{call_id}.mp3`
- No public access

### ElevenLabs setup (do BEFORE droplet cutover per §6.2 Step 5)

1. Create an ElevenLabs account if not already done
2. Get the API key
3. Configure conversation-ended webhook URL in EL dashboard:
   `https://dashboard-production-5c3b.up.railway.app/api/webhooks/elevenlabs/conversation-ended`
4. Copy the webhook secret into Railway env vars
5. Pick a vetted Hebrew-friendly default voice — note its `voice_id` and put it in the `platform_settings` migration seed (replace the `<VETTED_HEBREW_VOICE_ID>` placeholder in §3)
6. Send a test webhook from the EL dashboard → verify a row appears in `webhook_events`

## Things the plan should NOT do

- Do NOT add provider abstraction or fallback to Gemini at runtime — this is a hard swap (§1 Non-Goals)
- Do NOT implement mid-call WebSocket reconnection — fail fast (§1 Non-Goals)
- Do NOT touch the dashboard UI in Spec A's PR (no voice picker, no live transcript page, no LLM dropdown — that's all Spec B)
- Do NOT defer the encryption gate, the migration ordering, or the rehearsed rollback — these are non-negotiable
- Do NOT change the 500ms live-turn-writer flush interval to be smaller (it's deliberately 500ms for connection-pool safety per §4.3)
- Do NOT make `live-turn-writer` write `call_tool_invocations` (webhook is canonical per §4.3 / §4.6)
- Do NOT use a `BEFORE INSERT` trigger AND app-layer fetch — pick the trigger only (§3)

## Sanity-check questions to answer before implementation

The plan-phase agent should answer these before code starts:
1. Does `packages/database/src/encryption.ts` (or wherever the helper lives) actually use pgsodium / Vault / KMS? If not, what does the prerequisite phase look like?
2. Does the current `calls` table already have `started_at` and `ended_at`, or does the migration need to add them? (Use `mcp__supabase__list_tables` or query `information_schema.columns`.)
3. Does Supabase allow direct postgres-js connections via Supavisor? What's the connection string format for transaction mode?
4. What's the actual ElevenLabs Conversational AI WebSocket protocol latest version (events shape, audio chunk format, tool_call/tool_result payloads)? The spec describes the protocol at a level that's correct as of design time, but the implementer should pull live docs from ElevenLabs before writing `elevenlabs-session.js`.
5. What's the current `tools.js` shape? Does it already have a clean separation between definitions and implementations, or does the adapter need to do more work?

## Suggested first message to Claude Code Cloud

> I'm implementing a migration from Google Gemini Live to ElevenLabs Conversational AI for a Hebrew voice-agent SaaS. The full design is in `docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md` (Spec A — backend cutover, ships first) and `docs/superpowers/specs/2026-04-07-elevenlabs-dashboard-ui-design.md` (Spec B — UI v1, ships after Spec A is stable for 72h). The handoff doc is `docs/superpowers/specs/HANDOFF-elevenlabs-migration.md` — read it first.
>
> Read both spec files and the handoff. Then:
> 1. Execute the Phase 0 encryption gate from the handoff (verify `packages/database/src/encryption.ts` or equivalent is real).
> 2. Use the writing-plans skill (or `/gsd:plan-phase`) to produce an implementation plan for Spec A.
> 3. Stop and let me review the plan before any code is written.
>
> Do NOT redesign anything in the specs. Do NOT implement Spec B until Spec A is shipped and stable.

## Useful commands

```bash
# Apply a migration via Supabase CLI
npx supabase db push --project-ref uwintyhbdslivrvttfzp

# Deploy voice engine to droplet
scp -r voiceagent-saas/* root@188.166.166.234:/opt/voiceagent-saas/
ssh root@188.166.166.234 "cd /opt/voiceagent-saas && npm install"
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"
ssh root@188.166.166.234 "journalctl -u voiceagent-saas -f"

# Dashboard deploys automatically on push to main via Railway

# Tag the pre-cutover commit (Spec A §6.2 Step 3)
git tag pre-elevenlabs <commit-sha>
git push origin pre-elevenlabs
```

## Where to ask if you're stuck

If a spec section is ambiguous or contradicts something in the codebase, **stop and surface it** rather than guessing. The specs went through two review rounds and are intentionally precise — ambiguity is a bug, not a creative opportunity.
