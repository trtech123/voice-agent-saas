# Implementation Plan — Spec B: ElevenLabs Dashboard UI v1

**Date:** 2026-04-07
**Spec:** `docs/superpowers/specs/2026-04-07-elevenlabs-dashboard-ui-design.md`
**Hard prerequisite:** Spec A in production for ≥72h, metrics green. `tenants.feature_flags jsonb` already shipped via Spec A T1.

Pure UI on top of Spec A's backend. No migrations, no webhook changes, no voice-engine work. Voice picker → server actions → reusable hooks/components → page features → polish `tab-failed.tsx` → tests → DB-backed feature-flag rollout.

## Conventions (apply to every task)

- All server actions return `{ ok: true, data } | { ok: false, error: { code, message } }`. Error codes namespaced (`ELEVENLABS_FETCH_FAILED`, `LLM_KEY_INVALID`, `RATE_LIMITED`, `IDEMPOTENT_REPLAY`, `RECORDING_URL_EXPIRED`, etc). Components surface `error.message` directly.
- Every Hebrew string lives in `apps/dashboard/src/i18n/he.ts`, namespaced per feature; **strings added BEFORE the component is implemented**. ICU `{placeholder}` interpolation; mixed-direction values wrapped at render in `<span dir="auto">`.
- Tenant-scoped via existing auth middleware. No service-role key reaches client.
- All new UI gated behind `tenants.feature_flags->>'elevenlabs_ui' = 'true'` (DB-backed, not env). Default off.
- Hebrew RTL, mobile-first; touch targets ≥44px; tested at 360 / 414 / 768 / 1024.

---

## Phase 1 — i18n + feature-flag scaffolding

### T1 — i18n keys + flag helper
**New:** add namespaces to `apps/dashboard/src/i18n/he.ts` (`campaigns.voicePicker`, `campaigns.statusPill`, `campaigns.quickCall`, `settings.llm`, `liveCall`, `postCall`, `failedCalls`, `tools`).
**New:** `apps/dashboard/src/lib/feature-flags.ts` — `isElevenLabsUiEnabled(tenant)` reads `tenant.feature_flags?.elevenlabs_ui === true`. Server-only.
**Acceptance:** every string referenced by tasks T2–T18 exists in `he.ts` before its component is built. ICU placeholder contract documented in a header comment. Helper unit-tested for null/missing key/false/true.

---

## Phase 2 — Server actions (no UI yet)

Each action: tenant-scoped, returns the discriminated-union contract above, has unit tests against a mocked Supabase client.

### T2 — `getElevenLabsVoices()`
**New:** `apps/dashboard/app/actions/elevenlabs-voices.ts`
**Acceptance:** `GET https://api.elevenlabs.io/v1/voices` with `xi-api-key`. Server-side in-memory cache, 5-min TTL keyed by `'voices:multilingual'`. Filters to Hebrew-supporting / multilingual voices. Returns `{ voice_id, name, language, gender, accent, preview_url, description }[]`. No client exposure of API key. Cache hit/miss logged.

### T3 — `selectVoiceForCampaign(campaignId, voiceId)`
**New:** `apps/dashboard/app/actions/select-voice.ts`
**Acceptance:** updates `campaigns.voice_id`, bumps `sync_version` (Spec A's agent-sync flow handles the rest). Tenant ownership check on campaign. Returns updated row. No direct EL call.

### T4 — `validateLlmKey(provider, key)` + rate limit
**New:** `apps/dashboard/app/actions/llm-key.ts`
**Acceptance:**
- Provider switch: `gpt-4o` → 1-token OpenAI completion; `claude-sonnet-4.5` → 1-token Anthropic message.
- **Rate-limited 1 call/min/tenant** (Redis key `llm-validate:{tenantId}`, TTL 60s; on hit return `RATE_LIMITED` with `retry_after_seconds`).
- Validation roundtrip happens BEFORE any encrypt/persist call; on failure return `LLM_KEY_INVALID` with provider-supplied message (sanitized, Hebrew-wrapped).
- No persistence in this action.
- Unit test: throttled second call returns RATE_LIMITED; bad key never touches DB.

### T5 — `saveLlmKey` / `removeLlmKey`
**Acceptance:** `saveLlmKey` re-runs validation (defense in depth), then encrypts via `packages/database` encryption helper, writes `tenants.llm_provider`, `llm_api_key_encrypted`, `llm_api_key_last4`, `llm_api_key_validated_at`. `removeLlmKey` sets provider back to `bundled` and nulls fields. Both gated to tenant admins.

### T6 — `retryAgentSync(campaignId)`
**Acceptance:** enqueues an `agent-sync-jobs` BullMQ job (debounced jobId per Spec A). Returns the job id. No state mutation beyond enqueue.

### T7 — `cancelLiveCall(callId)`
**Acceptance:** idempotent — if BullMQ job pending, remove it; if Asterisk channel originated, send ARI hangup; if already ended, no-op success. Two clicks safe.

### T8 — `getCallRecordingUrl(callId)`
**Acceptance:** generates signed URL for `call-recordings/{tenant_id}/{call_id}.mp3` with **1-hour expiry**. Tenant ownership enforced. On missing object returns `RECORDING_NOT_READY`.

### T9 — `retryFailedCall(contactId, idempotencyKey)` + `bulkRetryFailedCalls`
**New:** `apps/dashboard/app/actions/retry-failed-call.ts`
**Acceptance:**
- Server-side **60s idempotency window**: Redis key `retry:{tenantId}:{idempotencyKey}` with TTL 60s storing the original job id; replay returns `{ ok: true, data: { jobId, replayed: true } }` with code `IDEMPOTENT_REPLAY`.
- Resets `campaign_contacts.daily_retry_count = 0`, `last_retry_day = null`, re-enqueues `call-jobs`.
- `bulkRetryFailedCalls` accepts up to 50 contacts, single shared idempotency key, processed sequentially with progress events suitable for `X / Y נשלחו` UI; aborts cleanly on stop signal (server checkpoints per item).

---

## Phase 3 — Reusable hooks + primitives

### T10 — `useExclusiveAudio()` hook
**New:** `apps/dashboard/src/hooks/use-exclusive-audio.ts`
**Acceptance:** module-level registry of `HTMLAudioElement` refs; `register(el)` on mount, `unregister` on unmount; when any element fires `play`, all others are paused. Used by **both** voice-picker preview rows AND the post-call `audio-player.tsx`. Unit-tested with two virtual audio elements.

### T11 — `useRealtimeWithFallback(channel, opts)` hook
**New:** `apps/dashboard/src/hooks/use-realtime-with-fallback.ts`
**Acceptance:** wraps Supabase Realtime subscription with the §3.3/§3.4 health rules:
- "Unhealthy" = no server message (data, presence, heartbeat) for **15s**.
- On unhealthy → start **5s polling fallback** (caller supplies poll fn).
- Reconnect Realtime with exponential backoff **1s, 2s, 4s, 8s, 16s, capped 30s**.
- On successful reconnect, drop the poll.
- Returns `{ data, status: 'live'|'reconnecting'|'polling', lastError }`.
- Cleanup on unmount: explicit `removeChannel`, clear timers.
- Unit-tested with fake timers for the 15s detection, backoff sequence, and poll-stop on recovery.

### T12 — Audio player extensions (modify `audio-player.tsx`)
**Modified:** `apps/dashboard/src/components/ui/audio-player.tsx`
**Acceptance:**
- Add `preload="none"` to `<audio>` (currently `"metadata"`).
- New `onRequestUrl?: () => Promise<string>` prop: when provided, the player starts in skeleton state until first user click triggers `onRequestUrl()`, then sets `src`.
- Listen for `error` events on `<audio>`; on `MEDIA_ERR_NETWORK` / 403 / decode error show inline Hebrew banner "השמעת ההקלטה נכשלה, נסה שוב" + retry button that re-invokes `onRequestUrl()` and reloads.
- Loading skeleton placeholder rendered in place of controls while URL is being fetched.
- Register with `useExclusiveAudio()` so the picker preview pauses it and vice versa.
- Existing API stays backward-compatible (legacy `src` prop still works).

---

## Phase 4 — Page-level features

### T13 — Voice picker modal
**New:** `apps/dashboard/src/components/voice-picker/voice-picker-modal.tsx`, `voice-row.tsx`, `voice-filters.tsx`
**Modified:** `apps/dashboard/src/components/campaign-wizard/step-script.tsx` (add "בחר קול" button + selected indicator), campaign settings tab (same trigger).
**Dependencies:** T2, T10, T1.
**Acceptance:**
- Full-screen on mobile, `max-w-2xl` modal on desktop, built on existing `ui/modal.tsx`.
- Search input debounced **200ms** over name + description.
- Filter chips: language / gender / accent.
- **Virtualized list using `react-window`** (`FixedSizeList`); add `react-window` to `apps/dashboard/package.json`. Handles 1000+ rows.
- Each row: name, language, gender, "השמע" preview, "בחר", currently-selected indicator. `role="option"`, list `role="listbox"`.
- Preview uses a single shared `<audio>` element registered via `useExclusiveAudio()` so clicking another preview pauses the previous one AND any post-call player on the page.
- "Last previewed voice" persisted in `localStorage` under `last-previewed-voice:{tenantId}`.
- "שמור בחירה" → optimistic local form-state update; the actual `selectVoiceForCampaign` server action call happens when the parent campaign form saves.
- Focus trap, ESC closes, all ARIA labels in Hebrew, 44px touch targets.

### T14 — LLM provider settings page
**New:** `apps/dashboard/app/(dashboard)/settings/llm/page.tsx`, `apps/dashboard/src/components/settings/llm-provider-cards.tsx`
**Dependencies:** T4, T5, T1.
**Acceptance:**
- Three radio cards (`bundled` / `gpt-4o` / `claude-sonnet-4.5`) per spec table; "מומלץ" badge on bundled.
- Non-bundled card expands inline: masked password input, "איך להשיג מפתח?" external link, "אמת מפתח" button → calls `validateLlmKey` first, then `saveLlmKey` only on success.
- After save: shows `****<last4>`, `validated_at` timestamp, "החלף מפתח" / "הסר מפתח".
- On `RATE_LIMITED`: shows "נסה שוב בעוד X שניות" with countdown.
- On validation failure: red inline banner with `error.message`.
- Bad keys never persisted (validation BEFORE encrypt is a unit-tested invariant — mock `saveLlmKey` to throw if validation step skipped).
- Campaign wizard reference: read-only summary card with "ערוך הגדרות חשבון" deep link to this page.

### T15 — Agent status pill + Quick Call disable
**New:** `apps/dashboard/src/components/campaign/agent-status-pill.tsx`, `agent-status-banner.tsx`
**Modified:** campaign card on dashboard list, campaign detail header, `apps/dashboard/src/components/quick-call-modal.tsx`.
**Dependencies:** T6, T11, T1.
**Acceptance:**
- Four states (`pending` / `provisioning` / `ready` / `failed`) with exact Hebrew copy + colors per §3.3 table.
- Subscribes to `campaigns` row via `useRealtimeWithFallback`.
- **Failure state renders inline full-width banner below pill, NEVER a hover tooltip.** Banner shows `agent_sync_error`, "נסה שוב" button (calls `retryAgentSync`), "ערוך הגדרות" link, non-dismissible until status changes.
- Quick Call button text/disabled state mirrors pill: `ready` enabled, `provisioning` disabled with spinner, `pending` triggers `retryAgentSync` on click, `failed` scrolls to inline banner.
- **Quick Call also blocked when `campaigns.voice_id IS NULL`** with copy "בחר קול תחילה" linking to voice picker (intentional friction).
- Component test: every state renders correct copy + button behavior; failure path renders banner not tooltip.

### T16 — Live transcript page
**New:** `apps/dashboard/app/(dashboard)/campaigns/[id]/calls/[callId]/live/page.tsx`, `src/components/live-call/live-state-machine.ts`, `transcript-bubble.tsx`, `live-header.tsx`
**Dependencies:** T7, T9 (for `failed_to_connect` retry), T11, T1.
**Acceptance:**
- Implements **all 8 explicit states** from §3.4 table (`dialing`, `ringing`, `connected`, `in_conversation`, `ended_awaiting_analysis`, `analysis_ready`, `failed_to_connect`, `disconnected_mid_call`) with derivation rules from `calls` row + `call_turns` count. State machine is a pure function unit-tested with fixtures for every transition.
- Subscribes via `useRealtimeWithFallback` to `call_turns` INSERT and `calls` UPDATE filtered by `call_id`.
- "החיבור אבד, מנסה שוב…" banner shown while hook reports `reconnecting`/`polling`.
- **RTL bubbles:** container `dir="rtl"`; user bubbles aligned RIGHT (self side), agent bubbles aligned LEFT; bubble text element `dir="auto"` so mixed Hebrew/English doesn't bidi-flip punctuation.
- Auto-scroll to latest UNLESS user scrolled up; floating "scroll to latest" button when not at bottom.
- `dialing`/`ringing` cancel button → `cancelLiveCall` (idempotent, double-click safe).
- `failed_to_connect` retry button calls **the same `retryFailedCall(contactId, idempotencyKey)` flow** as the Failed Calls tab — same confirm dialog, same 5s optimistic disable, **no bypass**.
- `analysis_ready` shows link to post-call view.
- Empty state via existing `EmptyState` for missing call.
- Unmount cleans up Realtime channel.

### T17 — Post-call view upgrade
**Modified:** existing call detail page; **new:** `src/components/post-call/summary-card.tsx`, `tool-call-timeline.tsx`, `audio-archive-status.tsx`
**Dependencies:** T8, T11, T12, T1.
**Acceptance:**
- Sections: summary card (sentiment + success badges + duration + contact), audio player (uses T12 with `onRequestUrl={() => getCallRecordingUrl(callId)}`), transcript (canonical `transcript_full`; if `webhook_processed_at IS NULL` shows "מנתחים…" banner + reads `call_turns` with `<aside>` "תמלול ראשוני, ייתכנו שינויים"), tool-call timeline (collapsed by default, reads `call_tool_invocations`, latency badge per row, Hebrew tool labels from `he.ts` `tools.{toolName}.label`), audio archive status indicator with admin retry.
- Realtime subscription on `calls` row picks up `webhook_processed_at` flip → page upgrades without manual refresh.
- Skeletons in every section.
- Mobile stacked, desktop side-by-side audio + transcript.

### T18 — Polish `tab-failed.tsx`
**Modified:** `apps/dashboard/src/components/campaign-detail/tab-failed.tsx` (currently uses `/api/calls/retry` fetch — replace with server action).
**Dependencies:** T9, T1.
**Acceptance:**
- Filters: multi-select `failure_reason`, date range (default last 7 days), contact name search.
- Server-side cursor pagination, 25/page (new server action `listFailedCalls(campaignId, filters, cursor)` — add to T9 file).
- Bulk actions: select-all checkbox + "נסה שוב את הנבחרים" (cap 50). Inline progress `X / Y נשלחו` non-blocking, with stop button that aborts remaining enqueues (uses `bulkRetryFailedCalls` checkpointed loop). Page stays usable.
- Per-row retry: confirm dialog ("לנסות שוב לחייג ל-{name}? פעולה זו תאפס את מונה הניסיונות היומי."), client generates `idempotencyKey` per click (UUID), calls `retryFailedCall`. Button **optimistically disabled for 5s** after click. Server-side 60s idempotency window (T9) protects against spam.
- Empty state: existing `EmptyState` with "אין שיחות שדורשות תשומת לב".
- Loading skeleton rows during fetch.
- Replaces existing inline `handleRetry` and `handleRetryAll` (which currently has no debounce, no idempotency, and uses a now-deprecated REST endpoint).

---

## Phase 5 — Tests

### T19 — Component tests (Vitest + RTL)
**Acceptance:** voice picker (search filter, preview play/pause, exclusive playback, selection updates parent); LLM cards (success/failure/last4/throttled); agent pill (every state + inline banner — assert no `title=` tooltip on failed); failed calls retry (confirm dialog renders, idempotency key generated per click, 5s debounce); live bubbles (RTL alignment, mixed-direction text, scroll-position preservation); `useExclusiveAudio` two-element pause; `useRealtimeWithFallback` 15s detection + backoff sequence with fake timers.

### T20 — Playwright E2E
**New:** `apps/dashboard/e2e/elevenlabs-ui.spec.ts`
**Acceptance:** the 5 flows from §6 (campaign → voice → status pill cycle; quick-call → live → post-call; LLM key bad/good; failed retry spam-click → exactly one enqueue; mobile 414px voice picker + transcript + post-call layouts). axe-core run on every page. All run with feature flag enabled on a test tenant.

---

## Phase 6 — Rollout

### T21 — Gating
**Acceptance:** every new entry point (voice picker trigger, LLM settings page, status pill, live page route, polished tab-failed bulk/filter UI) gated server-side via `isElevenLabsUiEnabled(tenant)`. Unauthorized tenants see the prior surface (or 404 for the live route). The flag is read from `tenants.feature_flags->>'elevenlabs_ui'` — **never** an env var.

### T22 — Staged rollout (manual)
1. Spec A green for ≥72h (verify metrics).
2. Deploy to Railway, flag default off → no visible change.
3. Toggle for 1 internal test tenant via Supabase row update; run Playwright E2E in production; manual mobile pass on real iPhone.
4. 10% → 24h watch → 50% → 24h → 100%.
5. After 1 week at 100%, delete flag-gating code (follow-up cleanup task).

**Rollback:** `update tenants set feature_flags = feature_flags - 'elevenlabs_ui' where id = …`. Code stays deployed.

---

## Dependencies graph (high-level)

```
T1 ─┬─> T2..T9 (server actions) ─┬─> T13 (picker, needs T2)
    │                              ├─> T14 (LLM, needs T4/T5)
    │                              ├─> T15 (pill, needs T6 + T11)
    │                              ├─> T16 (live, needs T7+T9+T11)
    │                              ├─> T17 (post-call, needs T8+T11+T12)
    │                              └─> T18 (polished failed, needs T9)
    │
    └─> T10, T11, T12 (hooks/primitives) ──> T13/T16/T17
                                                          └─> T19, T20 (tests) ─> T21, T22 (rollout)
```

## Open questions

None. All Spec B decisions are pinned in the spec and the resolved-decisions list. Spec A's `tenants.feature_flags` column is already in T1 of the Spec A plan, so no migration coordination remains.

## Critical files for implementation

- `apps/dashboard/src/i18n/he.ts` (modified — namespaces added)
- `apps/dashboard/src/lib/feature-flags.ts` (new)
- `apps/dashboard/src/hooks/use-exclusive-audio.ts` (new)
- `apps/dashboard/src/hooks/use-realtime-with-fallback.ts` (new)
- `apps/dashboard/src/components/ui/audio-player.tsx` (modified)
- `apps/dashboard/src/components/voice-picker/voice-picker-modal.tsx` (new)
- `apps/dashboard/src/components/settings/llm-provider-cards.tsx` (new)
- `apps/dashboard/src/components/campaign/agent-status-pill.tsx` (new)
- `apps/dashboard/src/components/live-call/live-state-machine.ts` (new)
- `apps/dashboard/src/components/post-call/summary-card.tsx` (new)
- `apps/dashboard/src/components/campaign-detail/tab-failed.tsx` (modified)
- `apps/dashboard/app/actions/elevenlabs-voices.ts` (new)
- `apps/dashboard/app/actions/select-voice.ts` (new)
- `apps/dashboard/app/actions/llm-key.ts` (new)
- `apps/dashboard/app/actions/retry-failed-call.ts` (new)
- `apps/dashboard/app/(dashboard)/settings/llm/page.tsx` (new)
- `apps/dashboard/app/(dashboard)/campaigns/[id]/calls/[callId]/live/page.tsx` (new)
- `apps/dashboard/e2e/elevenlabs-ui.spec.ts` (new)
