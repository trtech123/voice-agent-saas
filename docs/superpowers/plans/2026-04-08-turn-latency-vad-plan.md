# Turn Latency VAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `user_transcript isFinal:true` turn-latency anchor with a client-side RMS VAD on inbound audio, cross-checked against EL partial transcripts as a fallback, with echo-gating to prevent agent TTS bleed-back from blinding the detector.

**Architecture:** New `vad-config.js` loads 5 env-var-tunable constants with a numEnv helper. New `vad.js` implements a stateful `createSilenceDetector` factory with a consecutive-silent-frames guard and `setMuted` API. `CallBridge` constructs one detector per call, feeds it from `handleCallerAudio` after audio forwarding, mutes it during outbound agent audio + 200ms tail, and picks the turn-latency anchor via a sanity-gap hybrid in `_recordAgentAudioLatency`. One new nullable `vad_fallback_count int` column on `call_metrics`.

**Tech Stack:** Node.js (plain JS on droplet, no build), vitest, Supabase Postgres, pino logging.

**Spec:** [docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md](../specs/2026-04-08-turn-latency-vad-design.md) — supersedes §3.2 of the original 2026-04-08 call latency spec.

---

## Prerequisites

- Original call latency spec (Tasks 1-10 from `2026-04-08-call-latency-instrumentation-plan.md`) is already shipped on main. Commits: e105d4b (migration), 7e390c0 (scaffold), 94989be (helpers), 33a8fe3 (customerAnsweredAt), 9fd3c9b (greeting latency), 754ae4e (turn latency via isFinal — **this is the bit this plan replaces**), 817b5a9 (barge), 760f8ef (finalize), 4a343c0 (janitor lock).
- Live verification call proved the `isFinal:true` anchor never fires on the current agent config.
- Full test suite (3 files, 52 tests) is green on main.

---

## File Map

**Create:**
- `supabase/migrations/2026-04-08b_call_metrics_vad_fallback.sql`
- `voiceagent-saas/vad-config.js` — numEnv helper, 5 exported constants, boot-time log
- `voiceagent-saas/vad.js` — `createSilenceDetector` factory with state machine
- `voiceagent-saas/tests/vad.test.js` — unit tests for detector in isolation

**Modify:**
- `voiceagent-saas/call-bridge.js` — see detailed edit plan below
- `voiceagent-saas/tests/call-bridge-latency.test.js` — update 4 tests that depend on removed `pendingUserFinalAt`, append 16 new tests

**Leave alone:**
- `voiceagent-saas/janitor.js` — unchanged, still locked by regression test from Task 10
- `voiceagent-saas/elevenlabs-session.js` — already emits `user_transcript`, `interruption`, `agent_audio` events we use

---

## Task 1: Apply schema migration for vad_fallback_count

**Files:**
- Create: `supabase/migrations/2026-04-08b_call_metrics_vad_fallback.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 2026-04-08b_call_metrics_vad_fallback.sql
-- Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md
-- Plan: docs/superpowers/plans/2026-04-08-turn-latency-vad-plan.md (Task 1)
--
-- Adds a single aggregate column tracking how many turns in a call fell
-- back to EL's partial-transcript anchor because the local RMS VAD
-- was unreliable. Primary signal for "is the hybrid working?" — if this
-- is >50% of turns across many calls, the RMS threshold needs tuning.
--
-- Canonical fallback-rate query:
--   select call_id,
--          vad_fallback_count::float
--            / nullif(array_length(turn_latencies_ms, 1), 0) as fallback_rate
--   from call_metrics
--   where vad_fallback_count is not null;
--
-- The denominator is array_length(turn_latencies_ms, 1) — that's the
-- exact set of turns where an anchor resolved (not transcript_turn_count,
-- which includes skipped null-anchor turns). DO NOT persist a separate
-- denominator column; turn_latencies_ms is the canonical source.
--
-- NULL semantics:
--   - Pre-migration rows: NULL (correctly represents "not instrumented")
--   - Janitor-finalized rows (bridge crashed): NULL
--   - Bridge-finalized rows: 0 or positive
-- Dashboards must filter `vad_fallback_count IS NOT NULL` for averages.
--
-- Non-destructive, idempotent, inherits tenant_id RLS.

begin;

alter table public.call_metrics
  add column if not exists vad_fallback_count int;

alter table public.call_metrics
  add constraint call_metrics_vad_fallback_nonneg
    check (vad_fallback_count is null or vad_fallback_count >= 0);

commit;
```

- [ ] **Step 2: Apply via Supabase MCP**

Use `mcp__supabase__apply_migration`:
- `project_id`: `uwintyhbdslivrvttfzp`
- `name`: `2026_04_08b_call_metrics_vad_fallback`
- `query`: the body of the SQL file (the two `alter table` statements; strip the `begin;/commit;` wrapper if the MCP tool rejects them — the tool wraps its own transaction).

Expected: `{"success":true}`.

- [ ] **Step 3: Verify column exists**

Use `mcp__supabase__execute_sql` with `project_id: uwintyhbdslivrvttfzp`:
```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='call_metrics'
  and column_name = 'vad_fallback_count';
```
Expected: 1 row, `data_type=integer`, `is_nullable=YES`.

- [ ] **Step 4: Verify CHECK constraint exists**

```sql
select conname from pg_constraint
where conrelid = 'public.call_metrics'::regclass
  and conname = 'call_metrics_vad_fallback_nonneg';
```
Expected: 1 row.

- [ ] **Step 5: Commit**

From repo root (NOT inside `voiceagent-saas/`):
```bash
git add -f supabase/migrations/2026-04-08b_call_metrics_vad_fallback.sql
git commit -m "feat(db): add vad_fallback_count to call_metrics

Single aggregate column tracking how many turns fell back to the EL
partial-transcript anchor because the local RMS VAD failed to provide
one. Non-destructive, idempotent. See spec for canonical query shape.

Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md"
```

---

## Task 2: Create vad-config.js (numEnv helper + 5 constants + boot log)

**Files:**
- Create: `voiceagent-saas/vad-config.js`

- [ ] **Step 1: Write the module**

```js
// voiceagent-saas/vad-config.js
// Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md §4.3
//
// Loads 5 env-var-tunable VAD constants at module init. Uses a guarded
// helper so a typo'd .env value (e.g., "60o") falls back to the default
// instead of silently becoming NaN. Emits a single boot-time log line
// so the resolved values are visible in journalctl.

function numEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[vad-config] ${name}=${raw} is not a finite number, falling back to ${defaultValue}`,
    );
    return defaultValue;
  }
  return n;
}

export const VAD_RMS_THRESHOLD             = numEnv("VAD_RMS_THRESHOLD",             800);
export const VAD_SILENCE_DEBOUNCE_MS       = numEnv("VAD_SILENCE_DEBOUNCE_MS",       700);
export const VAD_SANITY_GAP_MS             = numEnv("VAD_SANITY_GAP_MS",             2000);
export const VAD_CONSECUTIVE_SILENT_FRAMES = numEnv("VAD_CONSECUTIVE_SILENT_FRAMES", 3);
export const VAD_AGENT_AUDIO_TAIL_MS       = numEnv("VAD_AGENT_AUDIO_TAIL_MS",       200);

// Boot-time log so /etc/voiceagent-saas.env typos are visible at startup.
// eslint-disable-next-line no-console
console.info(
  JSON.stringify({
    event: "vad_config_resolved",
    VAD_RMS_THRESHOLD,
    VAD_SILENCE_DEBOUNCE_MS,
    VAD_SANITY_GAP_MS,
    VAD_CONSECUTIVE_SILENT_FRAMES,
    VAD_AGENT_AUDIO_TAIL_MS,
  }),
);
```

- [ ] **Step 2: Import-smoke-test the module**

Run from repo root:
```bash
cd voiceagent-saas && node -e "import('./vad-config.js').then(m => console.log(JSON.stringify(m, null, 2)))"
```

Expected output: first a `{"event":"vad_config_resolved",...}` line with all five default values, then a JSON dump of the module's exports showing the same five numbers.

- [ ] **Step 3: Commit**

```bash
git add voiceagent-saas/vad-config.js
git commit -m "feat(vad): add vad-config.js with numEnv helper and boot log

Five tunable VAD constants loaded from env vars with safe fallbacks.
numEnv guards against typo'd .env values. Boot-time log emits the
resolved values so typos are visible in journalctl at startup.

Spec §4.3."
```

---

## Task 3: Scaffold vad.test.js with constructor injection

**Files:**
- Create: `voiceagent-saas/tests/vad.test.js`

- [ ] **Step 1: Write the initial test file with a failing harness-sanity test**

```js
// voiceagent-saas/tests/vad.test.js
// Unit tests for the createSilenceDetector factory.
// Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md §4.4
import { describe, it, expect, beforeEach } from "vitest";
import { createSilenceDetector } from "../vad.js";

// Build a slin16 PCM16 LE buffer of N samples, all set to `value`.
// Sample count 320 = one 20ms frame at 16 kHz.
function makeBuffer(value, sampleCount = 320) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

function makeDetector(overrides = {}) {
  return createSilenceDetector({
    threshold: 800,
    debounceMs: 700,
    consecutiveSilentFrames: 3,
    ...overrides,
  });
}

describe("createSilenceDetector — harness sanity", () => {
  it("can construct a detector and call its methods without throwing", () => {
    const vad = makeDetector();
    expect(vad).toBeDefined();
    expect(typeof vad.pushChunk).toBe("function");
    expect(typeof vad.setMuted).toBe("function");
    expect(typeof vad.resolvePending).toBe("function");
    expect(typeof vad.getUserStoppedAt).toBe("function");
    expect(typeof vad.reset).toBe("function");
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});
```

- [ ] **Step 2: Run test — expect failure because vad.js does not exist**

```bash
cd voiceagent-saas && npx vitest run tests/vad.test.js
```

Expected: FAIL with `Failed to load url ../vad.js` or `Cannot find module`.

- [ ] **Step 3: No commit yet** — this file will ship together with vad.js in Task 4.

---

## Task 4: Implement vad.js (factory + state machine)

**Files:**
- Create: `voiceagent-saas/vad.js`
- Modify: `voiceagent-saas/tests/vad.test.js` (append all the behavioral tests)

- [ ] **Step 1: Append the full behavioral test suite to tests/vad.test.js**

Append to the END of `voiceagent-saas/tests/vad.test.js`:

```js
describe("RMS calculation", () => {
  it("all-zero buffer → RMS is 0 → silent (getUserStoppedAt stays null alone)", () => {
    const vad = makeDetector();
    // Without ever being speaking, a silent chunk is a no-op.
    vad.pushChunk(makeBuffer(0), 1000);
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("constant 1000 square wave → RMS 1000 → speaking (above 800)", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(1000), 1000);
    // isSpeaking is now true but we have no public getter;
    // verify indirectly by feeding silence afterwards.
    // 3 silent frames @ 20ms each → silence transition.
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    // Debounce not fulfilled yet (need 700ms), getUserStoppedAt is still null.
    expect(vad.getUserStoppedAt()).toBe(null);
    // Fast-forward: a silent chunk beyond debounce should trigger resolution.
    vad.pushChunk(makeBuffer(0), 1760);
    expect(vad.getUserStoppedAt()).not.toBe(null);
  });

  it("constant 700 square wave → RMS 700 → silent (below 800)", () => {
    const vad = makeDetector();
    // Start speaking first so subsequent silent chunks can trigger a transition.
    vad.pushChunk(makeBuffer(2000), 1000);
    // Now push "silent" chunks of value 700 (below threshold).
    vad.pushChunk(makeBuffer(700), 1020);
    vad.pushChunk(makeBuffer(700), 1040);
    vad.pushChunk(makeBuffer(700), 1060);
    // Debounce isn't fulfilled yet; still null.
    expect(vad.getUserStoppedAt()).toBe(null);
    vad.pushChunk(makeBuffer(700), 1760);
    expect(vad.getUserStoppedAt()).not.toBe(null);
  });

  it("threshold boundary: RMS exactly 799 is silent, 800 is speech", () => {
    // Speaking baseline.
    let vad = makeDetector();
    vad.pushChunk(makeBuffer(800), 1000);
    // 3x 799 frames + beyond debounce → resolves to silence-start.
    vad.pushChunk(makeBuffer(799), 1020);
    vad.pushChunk(makeBuffer(799), 1040);
    vad.pushChunk(makeBuffer(799), 1060);
    vad.pushChunk(makeBuffer(799), 1760);
    expect(vad.getUserStoppedAt()).not.toBe(null);

    // Now prove 800 is treated as speech by preventing the transition.
    vad = makeDetector();
    vad.pushChunk(makeBuffer(2000), 1000); // establish speaking
    vad.pushChunk(makeBuffer(800), 1020);  // not silent
    vad.pushChunk(makeBuffer(800), 1040);
    vad.pushChunk(makeBuffer(800), 1060);
    vad.pushChunk(makeBuffer(800), 1760);
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("sign extension: sample -10000 reads as -10000 (not 55536)", () => {
    // A naive (buffer[i]*256+buffer[i+1]) would read 0xD8F0 as 55536
    // and compute RMS ≈ 55536, wildly above any threshold.
    // With correct readInt16LE, -10000 squared = 100_000_000,
    // RMS = 10000, still above threshold but the point is the sign.
    const vad = makeDetector({ threshold: 20000 });
    vad.pushChunk(makeBuffer(-10000), 1000);
    // Establish speaking with a louder chunk first to let the above be silent.
    const vad2 = makeDetector({ threshold: 20000 });
    vad2.pushChunk(makeBuffer(25000), 1000); // above 20000 → speaking
    vad2.pushChunk(makeBuffer(-10000), 1020); // |-10000|=10000 < 20000 → silent
    vad2.pushChunk(makeBuffer(-10000), 1040);
    vad2.pushChunk(makeBuffer(-10000), 1060);
    vad2.pushChunk(makeBuffer(-10000), 1760);
    expect(vad2.getUserStoppedAt()).not.toBe(null);
  });
});

describe("state machine — silence transitions", () => {
  it("pure silence from start → getUserStoppedAt stays null (never was speaking)", () => {
    const vad = makeDetector();
    for (let t = 1000; t < 3000; t += 20) {
      vad.pushChunk(makeBuffer(0), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("continuous speech → getUserStoppedAt stays null", () => {
    const vad = makeDetector();
    for (let t = 1000; t < 3000; t += 20) {
      vad.pushChunk(makeBuffer(5000), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("speech → 1 quiet frame → speech → no transition", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);    // 1 quiet, counter=1
    vad.pushChunk(makeBuffer(5000), 1040); // speech resets counter
    // Continue with speech for a long time to rule out a late transition.
    for (let t = 1060; t < 2500; t += 20) {
      vad.pushChunk(makeBuffer(5000), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("speech → 2 quiet frames → speech → no transition", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(5000), 1060);
    for (let t = 1080; t < 2500; t += 20) {
      vad.pushChunk(makeBuffer(5000), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("speech → 3 quiet frames → silence transition; silenceStartAt backdated 40ms", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020); // counter=1
    vad.pushChunk(makeBuffer(0), 1040); // counter=2
    vad.pushChunk(makeBuffer(0), 1060); // counter=3 → transition, silenceStartAt = 1060 - 40 = 1020
    // Debounce not yet fulfilled. Drive clock forward with more silence.
    vad.pushChunk(makeBuffer(0), 1720); // 1720 - 1020 = 700ms → exactly at debounce
    expect(vad.getUserStoppedAt()).toBe(1020);
  });

  it("once resolved, getUserStoppedAt is idempotent", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    const first = vad.getUserStoppedAt();
    vad.pushChunk(makeBuffer(0), 1740);
    vad.pushChunk(makeBuffer(0), 1760);
    expect(vad.getUserStoppedAt()).toBe(first);
  });

  it("speech resumes after resolved silence → userStoppedAt cleared", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    expect(vad.getUserStoppedAt()).not.toBe(null);
    vad.pushChunk(makeBuffer(5000), 1740); // speech again
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("resolvePending", () => {
  it("force-resolves mid-debounce", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    // silenceStartAt = 1020, debounce not fulfilled yet.
    expect(vad.getUserStoppedAt()).toBe(null);
    vad.resolvePending(1200);
    expect(vad.getUserStoppedAt()).toBe(1020);
  });

  it("no-op when already resolved", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    const first = vad.getUserStoppedAt();
    vad.resolvePending(9999);
    expect(vad.getUserStoppedAt()).toBe(first);
  });

  it("no-op when no silence ever seen (still speaking)", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.resolvePending(1200);
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("reset", () => {
  it("clears isSpeaking, silence state, and userStoppedAt", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    expect(vad.getUserStoppedAt()).not.toBe(null);
    vad.reset();
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("reset does NOT clear muted state", () => {
    const vad = makeDetector();
    vad.setMuted(true);
    vad.reset();
    // Prove muted is still true: a chunk that would normally establish
    // speaking does not, because pushChunk is a no-op while muted.
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    // Because all chunks were dropped, nothing ever went to speaking,
    // so no silence transition.
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("setMuted", () => {
  it("muted → pushChunk is a no-op", () => {
    const vad = makeDetector();
    vad.setMuted(true);
    // Even loud audio should not flip isSpeaking.
    vad.pushChunk(makeBuffer(30000), 1000);
    vad.setMuted(false);
    // Now push silence — since isSpeaking is still false, nothing happens.
    for (let t = 1020; t < 3000; t += 20) {
      vad.pushChunk(makeBuffer(0), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("unmute re-enables pushChunk", () => {
    const vad = makeDetector();
    vad.setMuted(true);
    vad.pushChunk(makeBuffer(5000), 1000); // dropped
    vad.setMuted(false);
    vad.pushChunk(makeBuffer(5000), 1020); // establishes speaking
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1080);
    vad.pushChunk(makeBuffer(0), 1780);
    expect(vad.getUserStoppedAt()).toBe(1040);
  });
});

describe("defensive buffer guards", () => {
  it("zero-length buffer → no throw, no state change", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(Buffer.alloc(0), 1020);
    // State unchanged: still speaking.
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1080);
    vad.pushChunk(makeBuffer(0), 1780);
    expect(vad.getUserStoppedAt()).toBe(1040);
  });

  it("odd-length buffer (not multiple of 2) → no throw, no state change", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(Buffer.alloc(641), 1020); // odd → skipped
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1080);
    vad.pushChunk(makeBuffer(0), 1780);
    expect(vad.getUserStoppedAt()).toBe(1040);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd voiceagent-saas && npx vitest run tests/vad.test.js
```

Expected: failure on import (module not found) — all tests red.

- [ ] **Step 3: Write `voiceagent-saas/vad.js`**

Create `voiceagent-saas/vad.js` with EXACTLY this content:

```js
// voiceagent-saas/vad.js
// Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md §4.4
//
// Stateful RMS-based silence detector. Fed 20ms slin16 (PCM16 LE, 16 kHz
// mono, 320 samples / 640 bytes) frames. Detects silence transitions
// with a consecutive-silent-frames guard, backdates silenceStartAt to
// the start of the silent run, and fulfills a debounce before locking
// in userStoppedAt. Provides setMuted() so CallBridge can blind the
// detector during agent audio playback (echo gating).
//
// All methods are synchronous and single-instance. No I/O.

const FRAME_DURATION_MS = 20;

export function createSilenceDetector({
  threshold,
  debounceMs,
  consecutiveSilentFrames,
}) {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`createSilenceDetector: invalid threshold ${threshold}`);
  }
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new Error(`createSilenceDetector: invalid debounceMs ${debounceMs}`);
  }
  if (!Number.isInteger(consecutiveSilentFrames) || consecutiveSilentFrames < 1) {
    throw new Error(
      `createSilenceDetector: invalid consecutiveSilentFrames ${consecutiveSilentFrames}`,
    );
  }

  let muted = false;
  let isSpeaking = false;
  let consecutiveSilent = 0;
  let silenceStartAt = null;
  let userStoppedAt = null;

  function computeRms(buffer) {
    const sampleCount = buffer.length / 2;
    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = buffer.readInt16LE(i * 2); // signed — critical
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / sampleCount);
  }

  function pushChunk(buffer, now) {
    if (muted) return;
    if (!buffer || buffer.length === 0) return;
    if (buffer.length % 2 !== 0) return;

    const rms = computeRms(buffer);

    if (rms >= threshold) {
      // Speaking.
      isSpeaking = true;
      consecutiveSilent = 0;
      silenceStartAt = null;
      userStoppedAt = null;
      return;
    }

    // Below threshold: silent frame.
    consecutiveSilent += 1;
    if (isSpeaking) {
      if (consecutiveSilent >= consecutiveSilentFrames) {
        // Speech → silence transition. Backdate silenceStartAt to the
        // first frame of the silent run: now - (N-1) * 20ms.
        silenceStartAt = now - (consecutiveSilentFrames - 1) * FRAME_DURATION_MS;
        isSpeaking = false;
      }
      // else: not enough consecutive quiet frames yet; waiting.
      return;
    }

    // Already in silence. Check debounce.
    if (silenceStartAt != null && userStoppedAt == null) {
      if (now - silenceStartAt >= debounceMs) {
        userStoppedAt = silenceStartAt;
      }
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
  }

  function resolvePending(/* now */) {
    if (userStoppedAt == null && silenceStartAt != null) {
      userStoppedAt = silenceStartAt;
    }
  }

  function getUserStoppedAt() {
    return userStoppedAt;
  }

  function reset() {
    isSpeaking = false;
    consecutiveSilent = 0;
    silenceStartAt = null;
    userStoppedAt = null;
    // muted deliberately NOT reset — CallBridge owns that.
  }

  return { pushChunk, setMuted, resolvePending, getUserStoppedAt, reset };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd voiceagent-saas && npx vitest run tests/vad.test.js
```

Expected: all tests green (roughly 22 tests across the 6 describe blocks). If any fail, read the failure carefully — most likely sources:
- Off-by-one in backdating math (check `(N-1) * 20ms`)
- Silent-frame counter not reset on speech (verify the `rms >= threshold` branch clears it)
- Debounce boundary uses `>=` not `>` (the test at 700ms exact expects resolution)

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
cd voiceagent-saas && npx vitest run
```

Expected: all 3 existing test files plus the new `tests/vad.test.js` pass. The existing lifecycle/latency tests are NOT affected because nothing else imports vad.js yet.

- [ ] **Step 6: Commit**

```bash
git add voiceagent-saas/vad.js voiceagent-saas/tests/vad.test.js
git commit -m "feat(vad): add createSilenceDetector factory with state machine

Stateful RMS-based silence detector fed 20ms slin16 PCM16 LE frames.
Consecutive-silent-frames guard eliminates single-frame mid-word
false transitions. Backdates silenceStartAt to the start of the
silent run, fulfills a debounce, and locks in userStoppedAt.
setMuted() API for echo gating.

Spec §4.4."
```

---

## Task 5: Update failing tests in call-bridge-latency.test.js

**Context:** 4 existing tests reference the `pendingUserFinalAt` field that we will remove from `this.latency` in Task 6. Before touching call-bridge.js, update or remove these tests so the suite can still build.

**Files:**
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Find the existing tests that reference `pendingUserFinalAt`**

```bash
cd voiceagent-saas && grep -n "pendingUserFinalAt\|pendingUserFinalIsBarge" tests/call-bridge-latency.test.js
```

Expected: several matches across the `turn_latency_ms` describe block and the `barge-in handling` describe block.

- [ ] **Step 2: Edit the test file to replace `pendingUserFinalAt` assertions**

In `voiceagent-saas/tests/call-bridge-latency.test.js`, find the test **`"user_transcript isFinal sets pendingUserFinalAt"`** inside the `describe("turn_latency_ms", ...)` block. Replace it entirely with:

```js
  it("user_transcript isFinal=true updates lastPartialTranscriptAt", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    const before = Date.now();
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "שלום",
      isFinal: true,
      ts: Date.now(),
    });
    const after = Date.now();

    expect(bridge.latency.lastPartialTranscriptAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.lastPartialTranscriptAt).toBeLessThanOrEqual(after);
  });
```

Find the test **`"user_transcript isFinal=false does NOT set pendingUserFinalAt"`**. Replace it entirely with:

```js
  it("user_transcript isFinal=false ALSO updates lastPartialTranscriptAt (no gating)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    const before = Date.now();
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "שלו...",
      isFinal: false,
      ts: Date.now(),
    });
    const after = Date.now();

    expect(bridge.latency.lastPartialTranscriptAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.lastPartialTranscriptAt).toBeLessThanOrEqual(after);
  });
```

Find the test **`"multiple isFinal before one agent_audio → only the most recent counted"`**. Rewrite its assertions to use `lastPartialTranscriptAt` instead of `pendingUserFinalAt`, replacing the whole test with:

```js
  it("multiple user_transcript events → lastPartialTranscriptAt is the most recent", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "first",
      isFinal: false,
      ts: Date.now(),
    });
    const firstAt = bridge.latency.lastPartialTranscriptAt;

    await new Promise((r) => setTimeout(r, 15));
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "second",
      isFinal: true,
      ts: Date.now(),
    });
    const secondAt = bridge.latency.lastPartialTranscriptAt;

    expect(secondAt).toBeGreaterThan(firstAt);
  });
```

Find the test **`"subsequent agent_audio chunks in the same turn do NOT create extra samples"`**. Keep it — this test will pass unchanged once the new turn path is in place, because the turn resolution still happens once per turn. No edit needed.

Find the tests **`"computes turn_latency_ms on next agent_audio after isFinal"`** and anything else in `describe("turn_latency_ms", ...)` that references `pendingUserFinalAt`. Delete the test body (but keep an empty `it.skip(...)` placeholder with a note), OR delete the entire test and let the new hybrid tests in Task 9 cover turn latency. The cleanest path: **delete the "computes turn_latency_ms on next agent_audio after isFinal" test entirely** — it's obsolete because the trigger is no longer `isFinal`. The hybrid tests in Task 9 will replace it.

Now the `describe("barge-in handling (interruption event)", ...)` block — find the test **`"interruption with pendingUserFinalAt set → next agent_audio discards the sample"`**. Its body depends on manually setting `pendingUserFinalAt` via `user_transcript isFinal:true`. Replace the entire test body with a version that uses `lastPartialTranscriptAt`:

```js
  it("interruption with lastPartialTranscriptAt set → flag is raised", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", Buffer.alloc(320)); // greeting

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "test",
      isFinal: false,
      ts: Date.now(),
    });
    expect(bridge.latency.lastPartialTranscriptAt).not.toBe(null);

    MockElevenLabsSession.last.emit("interruption", {});
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(true);
  });
```

Find the test **`"interruption with no pending isFinal → no-op (no leak across turns)"`**. Replace with:

```js
  it("interruption with no anchors → no-op", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", Buffer.alloc(320)); // greeting

    // No user_transcript and no VAD activity yet (no inbound audio).
    MockElevenLabsSession.last.emit("interruption", {});
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(false);
  });
```

- [ ] **Step 3: Run tests to see where we stand**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```

Expected: several failures. The updated tests assert on `bridge.latency.lastPartialTranscriptAt`, which doesn't exist yet. Also the Task 8 `_persistFinalState` tests from the original plan may reference the turn latency shape. Note which tests fail; Task 6 will bring them back to green.

- [ ] **Step 4: No commit yet** — this file changes again in the next few tasks. Will commit together with call-bridge.js.

---

## Task 6: Wire vad-config into call-bridge.js + swap tracker fields

**Files:**
- Modify: `voiceagent-saas/call-bridge.js`

- [ ] **Step 1: Add the imports at the top of call-bridge.js**

Find the existing imports near the top of `voiceagent-saas/call-bridge.js` (around lines 24-27):

```js
import { ElevenLabsSession } from "./elevenlabs-session.js";
import { enqueueTurn, flushAndClose } from "./live-turn-writer.js";
import { executeToolCall } from "./tools.js";
```

Add these after them:

```js
import { createSilenceDetector } from "./vad.js";
import {
  VAD_RMS_THRESHOLD,
  VAD_SILENCE_DEBOUNCE_MS,
  VAD_SANITY_GAP_MS,
  VAD_CONSECUTIVE_SILENT_FRAMES,
  VAD_AGENT_AUDIO_TAIL_MS,
} from "./vad-config.js";
```

- [ ] **Step 2: Replace the `this.latency` block in the constructor**

In `voiceagent-saas/call-bridge.js`, find the tracker block at lines 157-165:

```js
    // Latency tracker (spec §4.1)
    this.latency = {
      customerAnsweredAt: null,
      greetingLatencyMs: null,
      pendingUserFinalAt: null,
      pendingUserFinalIsBarge: false,
      turnLatenciesMs: [],
      audioPlumbingSamplesMs: [],
    };
```

Replace it with:

```js
    // Latency tracker (spec §4.1 + VAD spec §4.5)
    this.latency = {
      customerAnsweredAt: null,
      greetingLatencyMs: null,
      lastPartialTranscriptAt: null,
      pendingUserFinalIsBarge: false,
      turnLatenciesMs: [],
      audioPlumbingSamplesMs: [],
      vadFallbackCount: 0,
    };

    // VAD detector (one per call). Echo-gated via setMuted during agent playback.
    this.vad = createSilenceDetector({
      threshold: VAD_RMS_THRESHOLD,
      debounceMs: VAD_SILENCE_DEBOUNCE_MS,
      consecutiveSilentFrames: VAD_CONSECUTIVE_SILENT_FRAMES,
    });
    this._vadUnmuteTimer = null;
```

- [ ] **Step 3: Run the full suite to see the cascade of failures**

```bash
cd voiceagent-saas && npx vitest run
```

Expected: many failures because `pendingUserFinalAt` is now undefined. In particular, the existing `_recordAgentAudioLatency` method still references it. That's Task 7.

- [ ] **Step 4: No commit yet** — continue to Task 7.

---

## Task 7: Rewrite user_transcript, interruption, and _recordAgentAudioLatency handlers

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (lines 396-413, 440-449, 508-577)

- [ ] **Step 1: Rewrite the user_transcript handler**

In `voiceagent-saas/call-bridge.js`, find the handler at line 396:

```js
    session.on("user_transcript", ({ text, isFinal, ts }) => {
      // Latency tracking (spec §3.2, §4.2): only the most recent isFinal
      // counts — overwriting is intentional.
      if (isFinal === true) {
        this.latency.pendingUserFinalAt = Date.now();
        this.latency.pendingUserFinalIsBarge = false;
      }

      this.turnCount += 1;
      enqueueTurn({
        callId: this.callId,
        tenantId: this.tenantId,
        role: "user",
        text,
        isFinal,
        ts,
      });
    });
```

Replace the entire handler with:

```js
    session.on("user_transcript", ({ text, isFinal, ts }) => {
      // VAD spec §4.5: every partial updates the fallback anchor.
      // No gating on isFinal — the current agent config never sets it.
      this.latency.lastPartialTranscriptAt = Date.now();

      this.turnCount += 1;
      enqueueTurn({
        callId: this.callId,
        tenantId: this.tenantId,
        role: "user",
        text,
        isFinal,
        ts,
      });
    });
```

- [ ] **Step 2: Rewrite the interruption handler**

Find the handler at line 440:

```js
    session.on("interruption", () => {
      // Spec §6: if a user isFinal is pending, flag it as a barge so the
      // next agent_audio (which is the continuation of the interrupted
      // agent speech, not a fresh response) is discarded as a sample.
      // If nothing is pending, this is a pure agent-turn barge and is a
      // no-op — the flag only matters relative to a live pending isFinal.
      if (this.latency.pendingUserFinalAt != null) {
        this.latency.pendingUserFinalIsBarge = true;
      }
    });
```

Replace it with:

```js
    session.on("interruption", () => {
      // VAD spec §4.5: set barge flag only if at least one anchor
      // is available (RMS VAD finalized a stop, OR EL sent a partial).
      // Otherwise this is a pure agent-turn barge with nothing to
      // poison, so we no-op to prevent cross-turn flag leaks.
      if (
        this.vad.getUserStoppedAt() != null ||
        this.latency.lastPartialTranscriptAt != null
      ) {
        this.latency.pendingUserFinalIsBarge = true;
      }
    });
```

- [ ] **Step 3: Rewrite the turn path inside `_recordAgentAudioLatency`**

Find the method at line 508. The greeting path (lines 510-540) stays unchanged. Replace the **turn path only** (lines 541-576, starting at `// Turn path` and ending with the closing `}` of the `if (this.latency.pendingUserFinalAt != null) {` block) with:

```js
    // Turn path — VAD spec §4.5
    this.vad.resolvePending(receivedAt);
    const userStoppedAtRms = this.vad.getUserStoppedAt();
    const lastPartial = this.latency.lastPartialTranscriptAt;

    let userStoppedAt = null;
    let source = null;
    if (userStoppedAtRms != null && lastPartial != null) {
      if (userStoppedAtRms - lastPartial > VAD_SANITY_GAP_MS) {
        // RMS said the user stopped much later than EL's last partial —
        // noise held the RMS above threshold after real speech ended.
        // Trust EL's partial.
        userStoppedAt = lastPartial;
        source = "el_partial_fallback";
        this.latency.vadFallbackCount += 1;
      } else {
        userStoppedAt = userStoppedAtRms;
        source = "rms_vad";
      }
    } else if (userStoppedAtRms != null) {
      userStoppedAt = userStoppedAtRms;
      source = "rms_vad";
    } else if (lastPartial != null) {
      userStoppedAt = lastPartial;
      source = "el_partial_fallback";
      this.latency.vadFallbackCount += 1;
    }

    if (userStoppedAt == null) {
      // No anchor — skip the sample entirely.
      this.vad.reset();
      this.latency.pendingUserFinalIsBarge = false;
      return;
    }

    if (this.latency.pendingUserFinalIsBarge) {
      this.log.info(
        {
          event: "turn_latency_skipped_barge",
          call_id: this.callId,
        },
        "turn latency discarded (barge)",
      );
      this.vad.reset();
      this.latency.pendingUserFinalIsBarge = false;
      return;
    }

    const tl = clampNonNegative(receivedAt - userStoppedAt);
    this.latency.turnLatenciesMs.push(tl);
    if (sentAt != null) {
      this.latency.audioPlumbingSamplesMs.push(
        clampNonNegative(sentAt - receivedAt),
      );
    }
    this.log.info(
      {
        event: "turn_latency",
        call_id: this.callId,
        turn_index: this.latency.turnLatenciesMs.length,
        user_stopped_at: userStoppedAt,
        agent_audio_at: receivedAt,
        turn_latency_ms: tl,
        source,
      },
      "turn latency measured",
    );
    this.vad.reset();
    this.latency.pendingUserFinalIsBarge = false;
```

Also update the method's docstring (lines 493-507) — replace the references to `pendingUserFinalAt` in the comment. The new docstring:

```js
  /**
   * Record latency for one agent_audio chunk. Called AFTER sendToAsterisk
   * from inside the agent_audio handler. Best-effort — caller wraps in
   * try/catch so throws cannot impact audio dispatch.
   *
   * Handles two sample paths:
   *   1. Greeting first chunk: computes greeting_latency_ms (once per call).
   *   2. Turn first chunk: computes turn_latency_ms via VAD + EL-partial
   *      hybrid anchor selection (VAD spec §4.2, §4.5). The sanity-gap
   *      rule rejects RMS VAD output that is far later than EL's last
   *      partial (indicating noise held RMS above threshold after the
   *      user actually stopped).
   *   3. Barge-in case: discards the turn sample if pendingUserFinalIsBarge.
   *
   * audio_plumbing_ms samples (sentAt - receivedAt) are pushed on the
   * greeting first chunk AND on non-barge turn first chunks. The VAD
   * reset at the end of the turn path ensures subsequent chunks within
   * the same agent response do not double-count.
   *
   * Spec §3.1, §3.3, §4.2; VAD spec §4.5, §4.2.
   */
```

- [ ] **Step 4: Run the suite — expect the existing tests to mostly come back green**

```bash
cd voiceagent-saas && npx vitest run
```

Expected: `vad.test.js` still green. Latency tests: the stamping tests from Task 4 of the original plan (customerAnsweredAt) still pass. The greeting latency tests from Task 5 of the original plan still pass. The turn latency tests from Task 6 of the original plan — the ones we rewrote in Task 5 of THIS plan to use `lastPartialTranscriptAt` — should now pass. The barge tests should pass. `_persistFinalState` test may still fail because of the `vad_fallback_count` field expectation; that's fixed in Task 8.

- [ ] **Step 5: No commit yet** — continue to Task 8.

---

## Task 8: Feed VAD from handleCallerAudio + finalize changes + cleanup timer

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (lines 644-656, 664-691, 709-onward)

- [ ] **Step 1: Add vad.pushChunk call in handleCallerAudio**

Find `handleCallerAudio` at line 644. The current body:

```js
  handleCallerAudio(audioBuffer) {
    if (this._state !== "live") {
      // Drop ringback / early-media frames (CREATED / PRE_WARMING /
      // PRE_WARMED states) and any frames that arrive after FINALIZED.
      return;
    }
    this.inboundAudioChunks += 1;
    try {
      this.session.sendAudio(audioBuffer);
    } catch (err) {
      this.log.error({ err }, "session.sendAudio threw");
    }
  }
```

Replace with:

```js
  handleCallerAudio(audioBuffer) {
    if (this._state !== "live") {
      // Drop ringback / early-media frames (CREATED / PRE_WARMING /
      // PRE_WARMED states) and any frames that arrive after FINALIZED.
      // Invariant preserved: VAD only sees post-live audio (VAD spec §5).
      return;
    }
    this.inboundAudioChunks += 1;
    try {
      this.session.sendAudio(audioBuffer);
    } catch (err) {
      this.log.error({ err }, "session.sendAudio threw");
    }

    // VAD fed AFTER sendAudio so a VAD throw cannot delay forwarding.
    try {
      this.vad.pushChunk(audioBuffer, Date.now());
    } catch (err) {
      this.log.error({ err }, "vad.pushChunk threw");
    }
  }
```

- [ ] **Step 2: Add echo-gating mute renewal in the agent_audio handler**

Find the `agent_audio` handler at line 369. The current body runs `sendToAsterisk` then calls `_recordAgentAudioLatency` inside a try/catch. We need to add the mute+tail AFTER the latency recording. Replace the entire handler body (lines 369-394) with:

```js
    session.on("agent_audio", (buffer) => {
      const receivedAt = Date.now();
      this.outboundAudioChunks += 1;
      if (!this.firstAudioReceivedAt) {
        this.firstAudioReceivedAt = receivedAt;
        this.ttsFirstByteMs = receivedAt - this.elWsOpenedAt;
      }

      // Hot path: dispatch audio FIRST. Instrumentation MUST NOT delay this.
      let sentAt = null;
      if (this.sendToAsterisk) {
        try {
          this.sendToAsterisk(buffer.toString("base64"));
          sentAt = Date.now();
        } catch (err) {
          this.log.error({ err }, "sendToAsterisk threw");
        }
      }

      // Observability (best-effort, wrapped so a throw cannot impact audio).
      try {
        this._recordAgentAudioLatency(receivedAt, sentAt);
      } catch (err) {
        this.log.error({ err }, "latency recording threw");
      }

      // Echo gating (VAD spec §4.5): mute VAD while agent is speaking and
      // for VAD_AGENT_AUDIO_TAIL_MS after. Renewed on every outbound chunk.
      // Must run AFTER _recordAgentAudioLatency so the first chunk's turn
      // latency uses the pre-mute VAD state from the user's last turn.
      try {
        this.vad.setMuted(true);
        if (this._vadUnmuteTimer) clearTimeout(this._vadUnmuteTimer);
        this._vadUnmuteTimer = setTimeout(() => {
          this._vadUnmuteTimer = null;
          try {
            this.vad.setMuted(false);
          } catch (err) {
            this.log.error({ err }, "vad.setMuted(false) threw");
          }
        }, VAD_AGENT_AUDIO_TAIL_MS);
      } catch (err) {
        this.log.error({ err }, "echo gating threw");
      }
    });
```

- [ ] **Step 3: Clear the unmute timer in _finalizeAndResolve**

Find `_finalizeAndResolve` at line 664. The current body has these lines around 681-683:

```js
      } catch (err) {
        this.log.error({ err }, "session.close threw during finalize");
      }
    }

    activeBridges.delete(this.callId);
```

Insert the timer cleanup BEFORE `activeBridges.delete(this.callId)`:

```js
      } catch (err) {
        this.log.error({ err }, "session.close threw during finalize");
      }
    }

    // Clear the VAD unmute timer so a stale timer cannot fire after
    // the bridge ends (VAD spec §5).
    if (this._vadUnmuteTimer) {
      clearTimeout(this._vadUnmuteTimer);
      this._vadUnmuteTimer = null;
    }

    activeBridges.delete(this.callId);
```

- [ ] **Step 4: Add vad_fallback_count to the latency aggregation in _persistFinalState**

Find `_persistFinalState` at line 709. Inside it, find the `latencyFields` assignment. The current code builds the object like:

```js
      latencyFields = {
        greeting_latency_ms: this.latency.greetingLatencyMs,
        avg_turn_latency_ms: avgTurn != null ? Math.round(avgTurn) : null,
        p95_turn_latency_ms: percentile(turns, 0.95),
        audio_plumbing_ms: avgPlumbing != null ? Math.round(avgPlumbing) : null,
        turn_latencies_ms: turns && turns.length ? turns : null,
      };
```

Replace with:

```js
      latencyFields = {
        greeting_latency_ms: this.latency.greetingLatencyMs,
        avg_turn_latency_ms: avgTurn != null ? Math.round(avgTurn) : null,
        p95_turn_latency_ms: percentile(turns, 0.95),
        audio_plumbing_ms: avgPlumbing != null ? Math.round(avgPlumbing) : null,
        turn_latencies_ms: turns && turns.length ? turns : null,
        vad_fallback_count: this.latency.vadFallbackCount || 0,
      };
```

- [ ] **Step 5: Add vad_fallback_count to the call_latency_summary log**

Still in `_persistFinalState`, find the summary log block (around line 750-765). The current structured fields:

```js
        {
          event: "call_latency_summary",
          call_id: this.callId,
          greeting_latency_ms: latencyFields.greeting_latency_ms ?? null,
          turn_count: Array.isArray(this.latency.turnLatenciesMs)
            ? this.latency.turnLatenciesMs.length
            : 0,
          avg_turn_latency_ms: latencyFields.avg_turn_latency_ms ?? null,
          p95_turn_latency_ms: latencyFields.p95_turn_latency_ms ?? null,
          audio_plumbing_ms: latencyFields.audio_plumbing_ms ?? null,
        },
```

Add `vad_fallback_count` at the end:

```js
        {
          event: "call_latency_summary",
          call_id: this.callId,
          greeting_latency_ms: latencyFields.greeting_latency_ms ?? null,
          turn_count: Array.isArray(this.latency.turnLatenciesMs)
            ? this.latency.turnLatenciesMs.length
            : 0,
          avg_turn_latency_ms: latencyFields.avg_turn_latency_ms ?? null,
          p95_turn_latency_ms: latencyFields.p95_turn_latency_ms ?? null,
          audio_plumbing_ms: latencyFields.audio_plumbing_ms ?? null,
          vad_fallback_count: latencyFields.vad_fallback_count ?? null,
        },
```

- [ ] **Step 6: Run the full suite**

```bash
cd voiceagent-saas && npx vitest run
```

Expected: all tests green. The Task 8 tests from the original plan check `upsert.row.greeting_latency_ms` etc. — they should still pass because `latencyFields` is still spread into `metricsRow`. The existing assertions for `avg_turn_latency_ms`, `p95_turn_latency_ms`, and `turn_latencies_ms` use the same shapes; because no user_transcript is emitted in those tests, `turn_count` is still 0, `turnLatenciesMs` is still empty → avg/p95/array still null. Not a behavior change.

If tests fail, read the failure carefully. Most likely: a test that expected `pendingUserFinalAt` or similar to exist on the tracker. Those should all have been fixed in Task 5 of this plan — if one slipped through, update it now.

- [ ] **Step 7: Commit Tasks 5+6+7+8 together**

This is a single logical change — the code is only correct when all of Tasks 5-8 land together.

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): wire VAD hybrid turn-latency measurement

Replaces the broken user_transcript isFinal:true anchor with a
hybrid:

- Client-side RMS VAD on inbound audio as the primary anchor
- EL partial transcripts as a sanity-gap-guarded fallback
- Echo gating: mute VAD during agent audio + 200ms tail to prevent
  TTS bleed-back from the PSTN loop blinding silence detection

Changes in call-bridge.js:
- Import vad.js and vad-config.js
- this.latency tracker: remove pendingUserFinalAt, add
  lastPartialTranscriptAt + vadFallbackCount
- Construct this.vad per call + _vadUnmuteTimer tracker
- handleCallerAudio feeds vad.pushChunk after sendAudio
- agent_audio handler: mute+renew timer after _recordAgentAudioLatency
- user_transcript: always updates lastPartialTranscriptAt (no isFinal gate)
- interruption: set barge flag when any anchor exists
- _recordAgentAudioLatency turn path: VAD + fallback selection with
  sanity-gap rule; barge flag cleared on all exit paths (success,
  skip-barge, skip-no-anchor)
- _finalizeAndResolve: clear unmute timer
- _persistFinalState: add vad_fallback_count to metrics + summary log

Existing tests updated to match the new tracker field names.

Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md
Plan: docs/superpowers/plans/2026-04-08-turn-latency-vad-plan.md"
```

---

## Task 9: New tests for hybrid anchor selection

**Files:**
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Append the new hybrid tests**

Append to the end of `voiceagent-saas/tests/call-bridge-latency.test.js`:

```js
describe("VAD + hybrid turn latency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  const audioChunk = (value = 5000) => {
    const buf = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) buf.writeInt16LE(value, i * 2);
    return buf;
  };
  const silentChunk = () => Buffer.alloc(640); // all zeros

  it("uses rms_vad source when VAD resolves normally", async () => {
    const { bridge, log } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    // Greeting first so subsequent agent_audio takes the turn path.
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    // Simulate: user speaks → stops (3 silent + debounce) → EL responds.
    bridge.handleCallerAudio(audioChunk());       // speech
    await new Promise((r) => setTimeout(r, 5));
    bridge.handleCallerAudio(silentChunk());      // quiet 1
    bridge.handleCallerAudio(silentChunk());      // quiet 2
    bridge.handleCallerAudio(silentChunk());      // quiet 3 → silenceStartAt set
    // Wait past debounce (700ms default) — use resolvePending path via agent_audio.
    await new Promise((r) => setTimeout(r, 20));
    // Partial transcript also fires (EL saw speech).
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "כן",
      isFinal: false,
      ts: Date.now(),
    });

    // Now EL responds — this drives resolvePending.
    await new Promise((r) => setTimeout(r, 20));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    // A sample was recorded with source rms_vad (not fallback).
    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
    expect(bridge.latency.vadFallbackCount).toBe(0);
    const logEntry = log.calls.info.find((e) =>
      JSON.stringify(e).includes('"event":"turn_latency"'),
    );
    expect(logEntry).toBeTruthy();
    expect(JSON.stringify(logEntry)).toContain('"source":"rms_vad"');
  });

  it("falls back to el_partial when VAD has no anchor (continuous speech)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    // User audio is continuously loud — VAD never detects silence.
    for (let i = 0; i < 5; i++) {
      bridge.handleCallerAudio(audioChunk());
    }
    // But EL sent a partial transcript.
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "hi",
      isFinal: false,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));

    // EL responds.
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
    expect(bridge.latency.vadFallbackCount).toBe(1);
  });

  it("skips the sample entirely when both anchors are null", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    // No inbound audio, no partials — then another agent_audio arrives.
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.turnLatenciesMs.length).toBe(0);
    expect(bridge.latency.vadFallbackCount).toBe(0);
  });

  it("vad_fallback_count persisted to call_metrics at finalize", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    // Force one fallback turn.
    for (let i = 0; i < 5; i++) bridge.handleCallerAudio(audioChunk());
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "test",
      isFinal: false,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = supabase._upsertCalls.find(
      (c) => c.row && c.row.call_id === "cid-1",
    );
    expect(upsert).toBeTruthy();
    expect(upsert.row.vad_fallback_count).toBe(1);
  });

  it("vad_fallback_count is 0 when no turns happened", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting only

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = supabase._upsertCalls.find(
      (c) => c.row && c.row.call_id === "cid-1",
    );
    expect(upsert.row.vad_fallback_count).toBe(0);
  });

  it("echo gating: agent_audio mutes the VAD", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    // Spy on setMuted.
    const setMutedSpy = vi.spyOn(bridge.vad, "setMuted");
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(setMutedSpy).toHaveBeenCalledWith(true);
    expect(bridge._vadUnmuteTimer).not.toBe(null);
  });

  it("echo gating: timer is cleared on _finalizeAndResolve", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    expect(bridge._vadUnmuteTimer).not.toBe(null);

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 5));
    expect(bridge._vadUnmuteTimer).toBe(null);
  });

  it("barge flag is cleared on success path (not just skip paths)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    // Simulate a user turn that produces a partial anchor, then a successful
    // non-barge turn measurement.
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "yes",
      isFinal: false,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    // Barge flag should be false after a normal success.
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(false);
    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the full suite**

```bash
cd voiceagent-saas && npx vitest run
```

Expected: all tests green including the 8 new hybrid tests. If a test fails, the most likely cause is timing sensitivity — the `setTimeout` waits may be too short on slower machines. Bump `await new Promise((r) => setTimeout(r, 20))` to `setTimeout(r, 50)` if flaky.

- [ ] **Step 3: Commit**

```bash
git add voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "test(call-bridge): add VAD hybrid turn-latency tests

Covers rms_vad source, el_partial_fallback source, null-anchor skip,
vad_fallback_count persistence, echo gating (mute on agent audio + timer
cleanup on finalize), and barge flag cleared on success path.

Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md"
```

---

## Task 10: Full suite sanity check

**Files:** none

- [ ] **Step 1: Run the full vitest suite from voiceagent-saas**

```bash
cd voiceagent-saas && npx vitest run
```

Expected: four test files green — `tests/elevenlabs-session-split.test.js`, `tests/call-bridge-state.test.js`, `tests/call-bridge-latency.test.js`, `tests/vad.test.js`. Total should be roughly 75+ tests passing. No failures.

- [ ] **Step 2: No commit** — sanity check only.

---

## Task 11: Deploy to droplet

**Files:** none

- [ ] **Step 1: scp the three source files to the droplet**

From the repo root:
```bash
scp voiceagent-saas/vad-config.js voiceagent-saas/vad.js voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/
```

Expected: three files transferred, no errors.

- [ ] **Step 2: Add the env vars to /opt/voiceagent-saas/.env**

```bash
ssh root@188.166.166.234 "grep -q VAD_RMS_THRESHOLD /opt/voiceagent-saas/.env || cat >> /opt/voiceagent-saas/.env <<'EOF'

# VAD tuning (2026-04-08 turn latency VAD spec)
VAD_RMS_THRESHOLD=800
VAD_SILENCE_DEBOUNCE_MS=700
VAD_SANITY_GAP_MS=2000
VAD_CONSECUTIVE_SILENT_FRAMES=3
VAD_AGENT_AUDIO_TAIL_MS=200
EOF"
```

Expected: no output (successful heredoc append, or grep short-circuit if already present).

Verify:
```bash
ssh root@188.166.166.234 "grep VAD /opt/voiceagent-saas/.env"
```

Expected: the 5 VAD_ lines visible.

- [ ] **Step 3: Restart the service**

```bash
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"
```

Expected: no output, exit 0.

- [ ] **Step 4: Verify clean boot AND verify vad_config_resolved log line**

```bash
ssh root@188.166.166.234 "systemctl status voiceagent-saas --no-pager | head -20"
```

Expected: `active (running)`, no errors.

```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '1 minute ago' --no-pager | grep vad_config_resolved"
```

Expected: one log line showing `VAD_RMS_THRESHOLD:800, VAD_SILENCE_DEBOUNCE_MS:700, VAD_SANITY_GAP_MS:2000, VAD_CONSECUTIVE_SILENT_FRAMES:3, VAD_AGENT_AUDIO_TAIL_MS:200`. If the log shows fallback values (500, 600, 1500 — the old defaults from the previous spec) or NaN warnings, the .env was not loaded correctly. Re-check Step 2.

- [ ] **Step 5: No commit** — deployment only.

---

## Task 12: Live verification call

**Files:** none — this is a manual verification task.

- [ ] **Step 1: Enqueue a test call**

```bash
ssh root@188.166.166.234 "cd /opt/voiceagent-saas && node --input-type=module -e \"
import { Queue } from 'bullmq';
import 'dotenv/config';
const q = new Queue('call-jobs', { connection: { url: process.env.REDIS_URL } });
const job = await q.add('call', {
  tenantId: 'fd278f50-4e2e-4de3-872d-015c1bd7ee95',
  campaignId: '22222222-2222-2222-2222-222222222222',
  contactId: '33333333-3333-3333-3333-333333333333',
  campaignContactId: '44444444-4444-4444-4444-444444444444'
});
console.log('enqueued', job.id);
await q.close();
process.exit(0);
\""
```

The phone dials +972558867506. Tom answers. Have a ≥3-turn Hebrew exchange, interrupt Dani mid-sentence once, then hang up cleanly.

- [ ] **Step 2: Grep the structured log events for this call**

```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '5 minutes ago' --no-pager | grep -E 'greeting_latency|turn_latency|call_latency_summary|turn_latency_skipped_barge|vad_config_resolved' | tail -30"
```

Expected:
- One `greeting_latency` line
- ≥3 `turn_latency` lines, each with a `source` field that is either `"rms_vad"` or `"el_partial_fallback"`
- At least one `turn_latency_skipped_barge` line (from the interruption)
- One `call_latency_summary` line including `vad_fallback_count`

- [ ] **Step 3: Query call_metrics for persisted values**

Use `mcp__supabase__execute_sql`:
```sql
select call_id, greeting_latency_ms, avg_turn_latency_ms, p95_turn_latency_ms,
       audio_plumbing_ms, turn_latencies_ms, vad_fallback_count, ended_at
from call_metrics
where call_id = (
  select id from calls
  where contact_id = '33333333-3333-3333-3333-333333333333'
  order by started_at desc limit 1
);
```

Expected: 1 row. `vad_fallback_count` is an integer ≥0 (not null). `turn_latencies_ms` is an int[] with at least as many entries as non-barge turns. `avg_turn_latency_ms` is populated (no longer null).

- [ ] **Step 4: Interpret the numbers**

Report:
- `greeting_latency_ms`: ___
- Per-turn `turn_latency_ms` values and sources: [___]
- `avg_turn_latency_ms`: ___
- `p95_turn_latency_ms`: ___
- `audio_plumbing_ms`: ___
- `vad_fallback_count`: ___
- Fallback rate (`vad_fallback_count / array_length(turn_latencies_ms, 1)`): ___ %

Interpretation:
- Fallback rate <25% → hybrid is healthy, RMS VAD carrying the signal
- Fallback rate 25–50% → borderline, consider tuning VAD_RMS_THRESHOLD downward (try 600)
- Fallback rate >50% → RMS threshold wrong for this call's audio profile; tune via env var and restart; no code change
- `avg_turn_latency_ms` populated and reasonable (say <2000ms) → hybrid succeeded overall
- `audio_plumbing_ms` < 5ms → our code is not the bottleneck; remaining latency lives in EL or network

- [ ] **Step 5: No commit** — verification task.

---

## Rollback

If the deployed change breaks something on the droplet:

```bash
git revert <commit-hash-of-task-8>  # the big call-bridge commit
git revert <commit-hash-of-task-4>  # vad.js
git revert <commit-hash-of-task-2>  # vad-config.js
# Task 1 migration is additive — do NOT revert the migration
scp voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/
ssh root@188.166.166.234 "rm /opt/voiceagent-saas/vad.js /opt/voiceagent-saas/vad-config.js"
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"
```

After revert, the call_metrics `vad_fallback_count` column stays in place but is ignored by the old code (Postgres silently ignores missing fields on insert). Existing rows from before the revert remain valid.
