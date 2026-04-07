# Spec B — ElevenLabs Dashboard UI v1

**Status:** Draft for review
**Date:** 2026-04-07
**Companion spec:** `2026-04-07-elevenlabs-runtime-swap-design.md` (Spec A — backend cutover, ships first)
**Supersedes:** `2026-04-07-elevenlabs-migration-design.md` (split into A + B)

This spec covers the **dashboard UI v1** that exposes ElevenLabs configuration, live transcripts, and post-call review to Israeli SMB users (Hebrew RTL, mobile-first). Spec A owns the entire database schema; Spec B is **purely additive UI** on top of an already-complete backend.

**Hard prerequisite:** Spec A must be deployed and stable in production for ≥72 hours before Spec B ships.

## 1. Goals & Non-Goals

### Goals
- Expose ElevenLabs voice selection per campaign with mobile-friendly search/filter/preview.
- Expose tenant-level LLM provider choice (Bundled / GPT-4o / Claude) with safe API key handling, validation, and discoverable error states.
- Show per-campaign agent provisioning state with discoverable failure recovery (no hover-only tooltips).
- Live transcript view during active calls, RTL-correct, with explicit pre/connected/post states.
- Upgraded post-call view with audio playback, transcript, summary, sentiment, tool-call timeline.
- Polish the existing `tab-failed.tsx` failed-calls view with safe manual retry, filters, pagination.
- Frontend test coverage (Playwright) for the critical paths.
- Hebrew copy throughout. Mobile-first responsive layouts.

### Non-Goals
- Schema changes — Spec A owns them all.
- Backend logic changes — webhook handler, agent-sync processor, audio archive are all from Spec A.
- A/B testing of prompts, voice cloning, multi-language support, English agents.
- Real-time waveform visualization beyond what `audio-player.tsx` already supports.
- Drift reconcile UI, Grafana embeds, alerting UI.

## 2. Existing dashboard surface area

Reused without modification:
- `apps/dashboard/src/components/ui/modal.tsx` — base modal
- `apps/dashboard/src/components/ui/empty-state.tsx` — empty state convention
- `apps/dashboard/src/components/ui/audio-player.tsx` — **existing audio player; we extend it instead of pulling in wavesurfer.js**
- `apps/dashboard/src/components/ui/badge.tsx`, `button.tsx`, `input.tsx`, `progress-bar.tsx`, `tabs.tsx`
- `apps/dashboard/src/components/quick-call-modal.tsx` — disable logic patched here
- `apps/dashboard/src/components/campaign-detail/tab-failed.tsx` — **already exists; polished, not rewritten**
- `apps/dashboard/src/components/campaign-detail/tab-transcripts.tsx`, `tab-statistics.tsx`, etc.
- `apps/dashboard/src/components/campaign-wizard/step-script.tsx` — voice/LLM pickers slot here

> **wavesurfer.js dropped from this spec** (frontend reviewer flagged: 90 KB gz, no native RTL, a11y-poor, ignores existing component). We extend `audio-player.tsx` with a basic time scrubber and that's enough for v1.

## 3. UI Components

### 3.1 Voice picker modal

**Trigger:** "בחר קול" button in `step-script.tsx` (campaign wizard) and on the campaign settings tab.

**Layout (mobile-first):**
- Full-screen modal on mobile, centered modal (max-w-2xl) on desktop
- Header: title "בחירת קול" + close button
- Search input (debounced 200ms, searches voice name + description)
- Filter chips: language (`עברית` / `אנגלית` / `הכל`), gender (`גבר` / `אישה` / `הכל`), accent (when present in EL metadata)
- Virtualized list (react-window) — assume 1000+ voices possible
- Each row: voice name, language, gender, "השמע" preview button, "בחר" select button, currently-selected indicator
- Footer (sticky on mobile): "ביטול" + "שמור בחירה"

**Preview behavior:**
- Click "השמע" → fetch EL sample URL → play in shared `<audio>` element
- **Stop-others-on-play:** clicking any preview pauses all others (single playback context held in modal state)
- Preview button shows playing/paused/loading states
- Preview never blocks list scrolling

**Data fetch:**
- Server action `apps/dashboard/app/actions/elevenlabs-voices.ts` → `GET https://api.elevenlabs.io/v1/voices` with `xi-api-key`
- Server-side cache (in-memory + 5-minute TTL) so repeated modal opens don't hammer EL
- Filter to voices that support Hebrew or are tagged multilingual
- Returns `{ voice_id, name, language, gender, accent, preview_url, description }[]`

**Selection:**
- On "שמור בחירה": optimistic update of campaign form state, modal closes
- The actual save (write to `campaigns.voice_id`) happens when the parent form is saved → triggers Spec A's `agent-sync-jobs` flow

**Persisted UX state:**
- "Last previewed voice" stored in localStorage so the user can A/B quickly across modal sessions

**Accessibility:**
- Modal traps focus, ESC closes
- All buttons keyboard-reachable
- ARIA labels in Hebrew
- Voice rows have `role="option"`, list has `role="listbox"`

### 3.2 LLM provider dropdown (tenant settings + campaign wizard reference)

> **Storage is tenant-level** per Spec A. The picker lives on a new tenant settings page; the campaign wizard shows the current tenant choice as read-only with a "ערוך הגדרות חשבון" link.

**Tenant settings page:** `apps/dashboard/app/(dashboard)/settings/llm/page.tsx`

**Three radio cards (not a dropdown — clearer for non-technical users):**

| Card | Title | Helper copy (Hebrew) | Badge |
|---|---|---|---|
| `bundled` | מודל מובנה (ברירת מחדל) | "המודל של ElevenLabs. ללא הגדרות נוספות. מחיר לדקה גבוה במעט." | "מומלץ" |
| `gpt-4o` | OpenAI GPT-4o | "המודל המומלץ לטיפול בכלים בעברית. דורש מפתח API משלך מ-OpenAI." | — |
| `claude-sonnet-4.5` | Anthropic Claude Sonnet 4.5 | "חשיבה טובה במיוחד. דורש מפתח API משלך מ-Anthropic." | — |

Each non-bundled card expands to show:
- API key input (`<input type="password">`, masked)
- "איך להשיג מפתח?" link → external (OpenAI/Anthropic console)
- "אמת מפתח" button
- After successful save: "מפתח שמור: ****<last4>" + "מאומת ב-<timestamp>" + "החלף מפתח" + "הסר מפתח" buttons
- After failed validation: red banner with the error from the validation roundtrip

**Validation roundtrip flow:**
1. User pastes key, clicks "אמת מפתח"
2. Server action `validateLlmKey(provider, key)` → makes a minimal test call to the provider (e.g., 1-token completion)
3. On success: encrypt via `packages/database` helper (verified real per Spec A §3.1), store as `tenants.llm_api_key_encrypted`, set `last4` and `validated_at`, return success
4. On failure: do NOT store; return error message; surface in red banner

> **Why validate before encrypting:** the original spec encrypted bad keys silently → support nightmare. Now an invalid key never reaches the database.

**Default state:** every tenant starts on `bundled`. They can opt out.

### 3.3 Agent status pill + Quick Call disable (campaign card / detail)

**Pill placement:** top-right of campaign card on the dashboard list, and in the campaign detail page header.

**Pill states (Hebrew copy):**

| `agent_status` | Pill copy | Color | Behavior |
|---|---|---|---|
| `pending` | "ממתין לסנכרון" | gray | No action; auto-transitions when agent-sync job runs |
| `provisioning` | "מסנכרן…" | blue, with spinner | No action; polls or Realtime-subscribes |
| `ready` | "מוכן" | green | Quick Call enabled |
| `failed` | "סנכרון נכשל" | red | **Inline error banner appears below pill, NOT a hover tooltip** |

**Failure inline banner (not a tooltip):**
- Spans the full card width
- Shows `agent_sync_error` text
- Has a "נסה שוב" button → fires a new agent-sync job
- Has "ערוך הגדרות" link → campaign settings
- Dismissible? No — stays until status is no longer `failed`

**Quick Call button states:**
- `ready`: enabled, normal styling
- `provisioning`: disabled, button text changes to "מסנכרן את הסוכן…", small inline spinner; **no tooltip required because the state is shown in the button itself**
- `pending`: disabled, button text "ממתין לסנכרון", clicking it triggers an agent-sync enqueue
- `failed`: disabled, button text "תקן הגדרות", clicking it scrolls to the inline error banner

> **Why no hover tooltips:** Israeli SMB users are mobile-first. Hover tooltips don't work on touch. All status info is inline.

**Realtime subscription:** the pill subscribes to Supabase Realtime on `campaigns` row updates filtered by `campaign_id` so transitions are instant. Fallback: 5-second poll if Realtime channel is unhealthy.

### 3.4 Live transcript page

**Route:** `apps/dashboard/app/(dashboard)/campaigns/[id]/calls/[callId]/live/page.tsx`

**Page states (enumerated, with Hebrew copy):**

| State | When | UI |
|---|---|---|
| `dialing` | Call enqueued, no `started_at` yet | Centered spinner + "מחייג…" + cancel button (hangs up the call) |
| `ringing` | `calls.status='ringing'` | "מצלצל…" + cancel button |
| `connected` | `started_at` set, no turns yet | "מחובר. ממתין לדיבור…" + a thin "live" indicator pulse |
| `in_conversation` | At least one turn in `call_turns` | Transcript bubbles, auto-scroll, "live" pulse |
| `ended_awaiting_analysis` | `ended_at` set, `webhook_processed_at` null | Transcript frozen + banner: "השיחה הסתיימה. מנתחים…" with skeleton for summary |
| `analysis_ready` | `webhook_processed_at` set | Banner replaced with link "צפה בסיכום השיחה" → post-call view (§3.5) |
| `failed_to_connect` | `failure_reason` set before any turn | Error card with reason + retry button |
| `disconnected_mid_call` | `failure_reason='el_ws_dropped'` after turns exist | Transcript preserved + warning banner "השיחה התנתקה" |

**Transcript bubbles (RTL-correct):**
- Container has `dir="rtl"` (Hebrew is the document direction)
- **User bubbles align RIGHT** (the dominant side in RTL = the "self" side)
- **Agent bubbles align LEFT**
- Bubble text uses `dir="auto"` so mixed Hebrew + English brand names don't bidi-flip punctuation
- Role-color: user = primary brand color; agent = neutral
- Each bubble shows: text, timestamp (small, faded), role icon
- Auto-scroll to latest turn UNLESS the user has scrolled up (preserve their scroll position)
- "scroll to latest" floating button when not at bottom

**Realtime subscription:**
- Supabase Realtime channel filtered by `call_id`
- Listens to `INSERT` on `call_turns` and `UPDATE` on `calls` (for state transitions)
- Reconnect with exponential backoff on disconnect
- "החיבור אבד, מנסה שוב…" banner shown during reconnect attempts
- On unmount: explicit channel cleanup

**Mobile layout:**
- Full-width bubbles
- Sticky header with state pill + cancel button
- Sticky footer hidden during transcript scroll for max space

**Empty state (call doesn't exist):**
- Use existing `EmptyState` component
- "השיחה לא נמצאה" + back link

### 3.5 Post-call review (upgraded)

**Route:** existing call detail page, extended.

**Sections (top to bottom on mobile, side-by-side on desktop):**

1. **Summary card** — `calls.summary`, sentiment badge, success_evaluation badge, call duration, contact name
2. **Audio player** — extended `audio-player.tsx` with time scrubber, play/pause, current time / duration. Source = signed URL fetched on-demand from Supabase Storage via server action `getCallRecordingUrl(callId)`. Lazy-loaded.
3. **Transcript** — read from `transcript_full` (canonical). If `webhook_processed_at IS NULL`, show "מנתחים את השיחה…" banner and read from `call_turns` as a temporary preview, with a clear `<aside>` note: "תמלול ראשוני, ייתכנו שינויים".
4. **Tool call timeline** — collapsed by default. Reads from `call_tool_invocations`. Each entry: tool name (Hebrew label from a `toolLabels` map), args (collapsible JSON), result/error, latency_ms badge.
5. **Audio archive status** — small indicator: "ההקלטה נשמרה" / "שומרים את ההקלטה…" / "שמירת הקלטה נכשלה" with admin retry button.

**Audio player extensions to `audio-player.tsx` (minimal):**
- Add a `<input type="range">` time scrubber
- Add play/pause toggle
- Add current time / duration display
- Keep the existing API; new props are additive
- No waveform visualization in v1 (deferred)

**Realtime subscription on `calls` row:** picks up `webhook_processed_at` flipping from null → timestamp so the page upgrades from "analyzing" to "ready" without a manual refresh.

**Loading skeletons:** every section uses skeleton components while data is fetching.

### 3.6 Failed Calls tab (polish existing `tab-failed.tsx`)

**Already exists.** This spec polishes it. Do not rewrite.

**Additions:**
- **Filters:** by `failure_reason` (multi-select), by date range (default last 7 days), by contact name search
- **Pagination:** 25 per page, server-side cursor pagination
- **Bulk actions:** select-all checkbox + "נסה שוב את הנבחרים" button (max 50 at a time)
- **Per-row retry safety:**
  - Confirm dialog: "לנסות שוב לחייג ל-<contact>? פעולה זו תאפס את מונה הניסיונות היומי."
  - On confirm: server action `retryFailedCall(contactId, idempotencyKey)` where `idempotencyKey` is generated client-side per click
  - Server action checks for an in-flight retry with the same key in the last 60s and returns the existing job ID instead of enqueuing a duplicate
  - Button is optimistically disabled for 5 seconds after click (debounce + visual feedback)
- **Empty state:** existing `EmptyState` component with "אין שיחות שדורשות תשומת לב" copy
- **Loading skeleton:** rows skeleton during fetch

## 4. Server actions / API surface

| Server action | Purpose | Auth |
|---|---|---|
| `getElevenLabsVoices()` | Fetch + cache EL voice library, filter to multilingual | Tenant-scoped |
| `selectVoiceForCampaign(campaignId, voiceId)` | Update `campaigns.voice_id`, bump `sync_version` (Spec A flow handles the rest) | Tenant-scoped |
| `validateLlmKey(provider, key)` | Test the key against provider, do NOT persist on failure | Tenant-scoped |
| `saveLlmKey(provider, key)` | Validate, encrypt, store on `tenants` | Tenant-scoped |
| `removeLlmKey()` | Set `tenants.llm_provider='bundled'`, null out key fields | Tenant-scoped |
| `retryAgentSync(campaignId)` | Enqueue an agent-sync job manually (for failed states) | Tenant-scoped |
| `cancelLiveCall(callId)` | Hang up via Asterisk ARI | Tenant-scoped |
| `getCallRecordingUrl(callId)` | Generate signed URL for `call-recordings/{tenant}/{call}.mp3` (1-hour expiry) | Tenant-scoped |
| `retryFailedCall(contactId, idempotencyKey)` | Reset `daily_retry_count` to 0, re-enqueue. Idempotency window 60s. | Tenant-scoped |
| `bulkRetryFailedCalls(contactIds[], idempotencyKey)` | Up to 50 contacts | Tenant-scoped |

All server actions enforce tenant scoping via the existing auth middleware. None expose service-role credentials to the client.

## 5. RTL, i18n, mobile

- All new components use `dir="rtl"` at the appropriate container level
- Mixed-direction text (Hebrew + English brand names): `dir="auto"` on text spans
- All copy stored in a Hebrew strings file `apps/dashboard/src/i18n/he.ts` — no inline English strings in components
- Mobile breakpoints: tested at 360px, 414px, 768px, 1024px
- Touch targets ≥44px
- Voice picker modal is full-screen on mobile, centered on desktop
- Live transcript page is mobile-primary (sticky header, full-width bubbles)
- Post-call view stacks vertically on mobile, side-by-side audio + transcript on desktop

## 6. Frontend test strategy

**Component tests (Vitest + React Testing Library):**
- Voice picker: search filters list, preview play/pause, stop-others-on-play, selection updates parent state
- LLM provider cards: validation success path, validation failure shows error, last4 displays after save
- Agent status pill: every state renders correct copy + color + button behavior
- Failed calls retry: confirm dialog, idempotency-key generated per click, debounce works
- Live transcript bubbles: RTL alignment, mixed-direction text, auto-scroll preserve user position

**Playwright E2E (`apps/dashboard/e2e/`):**
1. **Create campaign → pick voice → save → see status pill cycle to ready** (mocked agent-sync via Supabase fixture)
2. **Start Quick Call → live transcript page renders → bubbles appear → call ends → post-call view shows summary** (mocked Realtime events)
3. **LLM key validation:** paste bad key → see error, paste good key → see success + last4
4. **Failed calls retry:** click retry → confirm → button disabled → spam-click test (verify only one enqueue)
5. **Mobile viewport (414px):** voice picker modal full-screen, live transcript readable, post-call sections stack

**Accessibility tests:**
- axe-core run on every Playwright test
- All new modals trap focus correctly
- All buttons have accessible names

**Visual regression (deferred to follow-up):** Chromatic or Playwright screenshot diff for the polished pages.

## 7. Rollout

**Hard prerequisite:** Spec A in production for ≥72 hours, metrics green.

**Step 1 — Feature flag**
- New env var `NEXT_PUBLIC_FEATURE_ELEVENLABS_UI=true`
- All new UI gated behind the flag
- Default `false` until ready for staged rollout

**Step 2 — Deploy to Railway**
- Push to main → Railway auto-deploys
- Flag still false → no user visible change

**Step 3 — Smoke test on a single tenant**
- Toggle flag for one internal test tenant via Supabase row
- Run Playwright E2E in production (it's idempotent)
- Manually click through every state on a real iPhone

**Step 4 — Staged rollout**
- Enable for 10% of tenants → watch error logs, support inbox for 24h
- Enable for 50% → 24h
- Enable for 100%

**Step 5 — Remove the flag**
- After 1 week at 100%, delete the flag and the gating code

**Rollback:** flip the flag to false. Code stays deployed. Zero database changes (Spec A owns the schema).

## 8. Out of scope (explicit follow-up specs)

- Waveform visualization in audio player
- Voice cloning per tenant
- A/B prompt testing UI
- LLM key rotation reminders / scheduled rotation
- Drift reconcile UI ("EL agent missing in their dashboard, fix?")
- Analytics dashboards / Grafana embeds
- English-language UI (Spec B is Hebrew-only)
- Bulk voice change across many campaigns at once

## 9. Open Questions

None at time of writing. All design decisions confirmed in brainstorming and reviewer feedback addressed.
