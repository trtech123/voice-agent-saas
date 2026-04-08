# Call Latency Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-call latency instrumentation to CallBridge so a single test call reveals where latency lives (EL server vs. our audio plumbing) and regressions are tracked automatically on every call.

**Architecture:** All measurement happens in `voiceagent-saas/call-bridge.js` using events `ElevenLabsSession` already emits. Five new nullable columns on `call_metrics` persist per-call aggregates plus raw per-turn samples. The existing bridge-path upsert is switched to `ignoreDuplicates: false` (janitor stays `true`) so bridge writes always land even if the janitor raced first.

**Tech Stack:** Node.js (plain JS on droplet, no build step), vitest (JS), Supabase Postgres, pino logging.

**Spec:** [docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md](../specs/2026-04-08-call-latency-instrumentation-design.md)

---

## Spec Errata (confirmed during plan writing)

The spec §8 refers to `apps/voice-engine/test/call-bridge.test.ts`. That file does not exist. The real lifecycle test is at **`voiceagent-saas/tests/call-bridge-state.test.js`** (plain JS, vitest, colocated with the droplet code). This plan uses the correct location: new test file is **`voiceagent-saas/tests/call-bridge-latency.test.js`**. The harness pattern (EventEmitter-based `MockElevenLabsSession`, `vi.mock` of sibling modules, `await import("../call-bridge.js")` after mocks) is copied from the lifecycle test.

---

## File Map

**Create:**
- `supabase/migrations/2026-04-08_call_metrics_latency_columns.sql` — DDL for five new columns + non-negative CHECKs
- `voiceagent-saas/tests/call-bridge-latency.test.js` — vitest suite for all latency behavior

**Modify:**
- `voiceagent-saas/call-bridge.js`:
  - Add `this.latency` tracker in constructor
  - Stamp `customerAnsweredAt` at the top of `handleCustomerAnswered()`
  - Add `interruption` event listener in `_wireSessionEvents`
  - Rewrite `agent_audio` handler for hot-path-first ordering
  - Add `_recordAgentAudioLatency()` private method
  - Add `clampNonNegative`, `mean`, `percentile` module-level helpers
  - Rewrite `_persistFinalState` to include aggregated latency fields, wrapped in try/catch
  - Flip the bridge upsert to `{ ignoreDuplicates: false }`

**Leave alone:**
- `voiceagent-saas/janitor.js` — stays at `ignoreDuplicates: true`. A test in Task 10 locks this behavior.
- `voiceagent-saas/elevenlabs-session.js` — already emits `agent_audio`, `user_transcript` with `isFinal`, and `interruption`.

---

## Task 1: Apply schema migration

**Files:**
- Create: `supabase/migrations/2026-04-08_call_metrics_latency_columns.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 2026-04-08_call_metrics_latency_columns.sql
-- Spec: docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md
-- Plan: docs/superpowers/plans/2026-04-08-call-latency-instrumentation-plan.md (Task 1)
--
-- Adds per-call latency metrics to call_metrics. Non-destructive, idempotent.
-- Columns nullable so existing rows remain valid. New columns inherit the
-- existing tenant_id RLS policy on call_metrics automatically.
--
-- Note: tts_first_byte_ms remains in place but its semantics ("from WS open")
-- are now misleading post-lifecycle-fix. greeting_latency_ms is the correct
-- user-perspective metric going forward. Not renamed to avoid touching
-- existing query paths.

begin;

alter table public.call_metrics
  add column if not exists greeting_latency_ms int,
  add column if not exists avg_turn_latency_ms int,
  add column if not exists p95_turn_latency_ms int,
  add column if not exists audio_plumbing_ms  int,
  add column if not exists turn_latencies_ms  int[];

-- Non-negative guards. Plain inline CHECK — all existing rows have NULL in
-- the new columns so validation is instant.
alter table public.call_metrics
  add constraint call_metrics_greeting_latency_nonneg
    check (greeting_latency_ms is null or greeting_latency_ms >= 0);
alter table public.call_metrics
  add constraint call_metrics_avg_turn_latency_nonneg
    check (avg_turn_latency_ms is null or avg_turn_latency_ms >= 0);
alter table public.call_metrics
  add constraint call_metrics_p95_turn_latency_nonneg
    check (p95_turn_latency_ms is null or p95_turn_latency_ms >= 0);
alter table public.call_metrics
  add constraint call_metrics_audio_plumbing_nonneg
    check (audio_plumbing_ms is null or audio_plumbing_ms >= 0);

commit;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use `mcp__supabase__apply_migration`:
- `project_id`: `uwintyhbdslivrvttfzp`
- `name`: `2026-04-08_call_metrics_latency_columns`
- `query`: the body of the SQL file above (everything between `begin;` and `commit;` inclusive; the MCP tool wraps its own transaction, so the `begin;/commit;` are tolerated — if the tool rejects them, strip both lines and rerun).

Expected: success response, no rows affected on `alter table`.

- [ ] **Step 3: Verify columns exist**

Use `mcp__supabase__execute_sql`:
```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='call_metrics'
  and column_name in ('greeting_latency_ms','avg_turn_latency_ms','p95_turn_latency_ms','audio_plumbing_ms','turn_latencies_ms')
order by column_name;
```
Expected: 5 rows, all `is_nullable=YES`, types: `integer` (×4) and `ARRAY` (for `turn_latencies_ms`).

- [ ] **Step 4: Verify CHECK constraints exist**

```sql
select conname from pg_constraint
where conrelid = 'public.call_metrics'::regclass
  and conname like 'call_metrics_%_nonneg'
order by conname;
```
Expected: 4 rows — `call_metrics_audio_plumbing_nonneg`, `call_metrics_avg_turn_latency_nonneg`, `call_metrics_greeting_latency_nonneg`, `call_metrics_p95_turn_latency_nonneg`.

- [ ] **Step 5: Commit**

```bash
git add -f supabase/migrations/2026-04-08_call_metrics_latency_columns.sql
git commit -m "feat(db): add latency columns to call_metrics

Adds greeting_latency_ms, avg_turn_latency_ms, p95_turn_latency_ms,
audio_plumbing_ms, and turn_latencies_ms[] with non-negative CHECKs.

Spec: docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md"
```

---

## Task 2: Scaffold latency test file and confirm harness

**Files:**
- Create: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Write a scaffolded test file that reuses the lifecycle-test harness pattern**

```js
// voiceagent-saas/tests/call-bridge-latency.test.js
// Unit tests for CallBridge latency instrumentation.
// Spec: docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md
// Plan: docs/superpowers/plans/2026-04-08-call-latency-instrumentation-plan.md
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

class MockElevenLabsSession extends EventEmitter {
  constructor() {
    super();
    this.connectCalled = false;
    this.startConversationCalls = 0;
    this.closeCalled = false;
    this.closeReason = null;
    this.sendAudioCalls = [];
  }
  async connect() {
    this.connectCalled = true;
  }
  startConversation() {
    this.startConversationCalls += 1;
  }
  async close(reason) {
    this.closeCalled = true;
    this.closeReason = reason;
    this.emit("closed", { reason });
  }
  sendAudio(buf) {
    this.sendAudioCalls.push(buf);
  }
}

vi.mock("../elevenlabs-session.js", () => ({
  ElevenLabsSession: vi.fn(() => {
    const m = new MockElevenLabsSession();
    MockElevenLabsSession.last = m;
    return m;
  }),
}));

vi.mock("../live-turn-writer.js", () => ({
  enqueueTurn: vi.fn(),
  flushAndClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tools.js", () => ({
  executeToolCall: vi.fn().mockResolvedValue({ ok: true }),
}));

const { CallBridge } = await import("../call-bridge.js");

function makeLogger() {
  const calls = { info: [], warn: [], error: [], debug: [] };
  const log = {
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
    debug: (...a) => calls.debug.push(a),
    child: () => log,
  };
  log.calls = calls;
  return log;
}

function makeSupabase(campaignRow) {
  const upsertCalls = [];
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: campaignRow, error: null }),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
      upsert: vi.fn((row, opts) => {
        upsertCalls.push({ row, opts });
        return Promise.resolve({ data: null, error: null });
      }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  };
  supabase._upsertCalls = upsertCalls;
  return supabase;
}

function makeBridge({ campaignRow, agentIdUsed = "agent_x", syncVersionUsed = 1 } = {}) {
  const log = makeLogger();
  const defaultCampaignRow = {
    id: "22222222-2222-2222-2222-222222222222",
    elevenlabs_agent_id: agentIdUsed,
    sync_version: syncVersionUsed,
    agent_status: "ready",
    voice_id: "v1",
  };
  const supabase = makeSupabase(campaignRow || defaultCampaignRow);
  const bridge = new CallBridge({
    callId: "cid-1",
    tenantId: "tid-1",
    campaignId: "22222222-2222-2222-2222-222222222222",
    contactId: "contact-1",
    campaignContactId: "cc-1",
    agentIdUsed,
    syncVersionUsed,
    campaign: { id: "22222222-2222-2222-2222-222222222222", name: "test" },
    tenant: { id: "tid-1", name: "test-tenant" },
    contact: { id: "contact-1", name: "Tom", phone: "+972501234567", custom_fields: {} },
    supabase,
    toolContext: {},
    log,
  });
  return { bridge, log, supabase };
}

// Helper: advance the bridge to LIVE state via the happy-path choreography.
async function driveToLive(bridge) {
  bridge.start();
  await new Promise((r) => setTimeout(r, 10));
  MockElevenLabsSession.last.emit("ws_open");
  bridge.handleCustomerAnswered();
}

describe("CallBridge latency — harness sanity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  it("can construct a bridge and drive it to LIVE", async () => {
    const { bridge } = makeBridge();
    await driveToLive(bridge);
    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the scaffold test to confirm the harness works**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: 1 passing (`CallBridge latency — harness sanity > can construct a bridge and drive it to LIVE`).

If it fails with an import error, confirm `voiceagent-saas/package.json` has `vitest` as a devDependency (the lifecycle test suite proves this). Do not proceed to Task 3 until this passes.

- [ ] **Step 3: Commit**

```bash
git add voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "test: scaffold call-bridge latency test harness"
```

---

## Task 3: Add latency helpers + tracker object (TDD: helpers first)

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (add helpers near top of file, add tracker init in constructor)
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js` (add helper tests)

- [ ] **Step 1: Write failing tests for the helpers**

Append to `voiceagent-saas/tests/call-bridge-latency.test.js`:

```js
// Re-import helpers. We expose them on the module for testability.
const callBridgeModule = await import("../call-bridge.js");
const { clampNonNegative, mean, percentile } = callBridgeModule;

describe("latency helpers", () => {
  describe("clampNonNegative", () => {
    it("returns the number when positive", () => {
      expect(clampNonNegative(42)).toBe(42);
    });
    it("returns the number when zero", () => {
      expect(clampNonNegative(0)).toBe(0);
    });
    it("returns 0 when negative (clock went backward)", () => {
      expect(clampNonNegative(-5)).toBe(0);
    });
    it("returns 0 for non-numbers", () => {
      expect(clampNonNegative(null)).toBe(0);
      expect(clampNonNegative(undefined)).toBe(0);
      expect(clampNonNegative("5")).toBe(0);
    });
  });

  describe("mean", () => {
    it("returns null on empty", () => {
      expect(mean([])).toBe(null);
    });
    it("returns null on null/undefined", () => {
      expect(mean(null)).toBe(null);
      expect(mean(undefined)).toBe(null);
    });
    it("returns the single value on n=1", () => {
      expect(mean([7])).toBe(7);
    });
    it("computes arithmetic mean", () => {
      expect(mean([1, 2, 3, 4, 5])).toBe(3);
    });
  });

  describe("percentile", () => {
    it("returns null on empty", () => {
      expect(percentile([], 0.95)).toBe(null);
    });
    it("returns the single value on n=1", () => {
      expect(percentile([100], 0.95)).toBe(100);
    });
    it("degenerates to max at small n (n=2, p=0.95) — locked behavior", () => {
      // floor(0.95 * 2) = 1 → sorted[1] = max. Do NOT "fix" this.
      expect(percentile([10, 20], 0.95)).toBe(20);
    });
    it("n=5: floor(4.75)=4 → max", () => {
      expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    });
    it("n=20: floor(19)=19 → max", () => {
      const arr = Array.from({ length: 20 }, (_, i) => i + 1);
      expect(percentile(arr, 0.95)).toBe(20);
    });
    it("is order-independent (sorts internally)", () => {
      expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    });
  });
});
```

- [ ] **Step 2: Run the tests — expect failures**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: harness-sanity test still passes, helper tests all FAIL with something like `TypeError: clampNonNegative is not a function`.

- [ ] **Step 3: Add the helpers and export them at the top of `call-bridge.js`**

In `voiceagent-saas/call-bridge.js`, insert directly after the `mapErrorCodeToFailureReason` function (around line 76, before `// ─── Call Bridge Class ──────────────────────────────────────────────`):

```js
// ─── Latency Helpers (spec §4.4) ────────────────────────────────────

export function clampNonNegative(n) {
  return typeof n === "number" && n >= 0 ? n : 0;
}

export function mean(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
```

- [ ] **Step 4: Initialize `this.latency` in the CallBridge constructor**

In `voiceagent-saas/call-bridge.js`, find the constructor block around line 131 (right after `this.outboundAudioChunks = 0;`) and insert:

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

- [ ] **Step 5: Run helper tests to verify they pass**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: all helper tests PASS. Harness test still passes.

- [ ] **Step 6: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): add latency helpers and tracker state

clampNonNegative, mean, percentile exported from call-bridge.js for
testability. this.latency tracker initialized in constructor.

Spec §4.1, §4.4."
```

---

## Task 4: Stamp `customerAnsweredAt` in `handleCustomerAnswered()`

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (top of `handleCustomerAnswered`, around line 450)
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Write failing tests for the stamping behavior**

Append to the test file:

```js
describe("customerAnsweredAt stamping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  it("stamps customerAnsweredAt on handleCustomerAnswered() from PRE_WARMED", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge.latency.customerAnsweredAt).toBe(null);

    const before = Date.now();
    bridge.handleCustomerAnswered();
    const after = Date.now();

    expect(bridge.latency.customerAnsweredAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.customerAnsweredAt).toBeLessThanOrEqual(after);
  });

  it("stamps customerAnsweredAt when called during PRE_WARMING (queued race)", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge._state).toBe("pre_warming");
    expect(bridge.latency.customerAnsweredAt).toBe(null);

    // Customer answered before ws_open.
    bridge.handleCustomerAnswered();
    expect(bridge.latency.customerAnsweredAt).not.toBe(null);
    // State is still pre_warming (queued).
    expect(bridge._state).toBe("pre_warming");

    // Subsequent ws_open drains the queue into LIVE.
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge._state).toBe("live");
  });

  it("does not re-stamp customerAnsweredAt on a second call", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");

    bridge.handleCustomerAnswered();
    const first = bridge.latency.customerAnsweredAt;
    await new Promise((r) => setTimeout(r, 5));
    bridge.handleCustomerAnswered(); // second call — idempotent, should warn

    expect(bridge.latency.customerAnsweredAt).toBe(first);
  });
});
```

- [ ] **Step 2: Run the tests — expect failures**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: new tests FAIL because `bridge.latency.customerAnsweredAt` stays null.

- [ ] **Step 3: Edit `handleCustomerAnswered` in `call-bridge.js`**

Find the method starting at `call-bridge.js:450`. Insert the stamp as the very first executable statement inside the method body (before the `if (this._state === "live")` check):

```js
  handleCustomerAnswered() {
    // Spec §3.1, §4.2: stamp unconditionally at method entry so that a
    // call during PRE_WARMING (queued via _pendingCustomerAnswered) still
    // captures the user's subjective "I answered the phone" moment.
    // Guarded to not re-stamp on idempotent second calls.
    if (this.latency.customerAnsweredAt == null) {
      this.latency.customerAnsweredAt = Date.now();
    }

    if (this._state === "live") {
      this.log.warn("handleCustomerAnswered called twice — ignoring");
      return;
    }
    // ... rest of method unchanged ...
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: all new stamping tests PASS. All prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): stamp customerAnsweredAt at handleCustomerAnswered entry

Captures the user-subjective 'I answered' moment even when the pickup
is queued during PRE_WARMING. Guarded so idempotent second calls do
not re-stamp.

Spec §3.1, §4.2."
```

---

## Task 5: Hot-path-first `agent_audio` handler + greeting latency

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (`_wireSessionEvents` method, `agent_audio` handler at lines 339-354; add new private method `_recordAgentAudioLatency`)
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Write failing tests for greeting latency**

Append to the test file:

```js
describe("greeting_latency_ms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  // Helper: a tiny PCM16 buffer. Content doesn't matter for these tests.
  const audioChunk = () => Buffer.alloc(320);

  it("computes greeting_latency_ms on first agent_audio after customer_answered", async () => {
    const { bridge } = makeBridge();
    // Install a fake sendToAsterisk so the hot path runs without throwing.
    bridge.sendToAsterisk = vi.fn();

    await driveToLive(bridge);
    // Wait ~20ms, then emit the first agent_audio.
    await new Promise((r) => setTimeout(r, 20));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.greetingLatencyMs).not.toBe(null);
    expect(bridge.latency.greetingLatencyMs).toBeGreaterThanOrEqual(15);
    expect(bridge.latency.greetingLatencyMs).toBeLessThan(500);
  });

  it("only computes greeting_latency_ms once (second chunk is a no-op for greeting)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    await new Promise((r) => setTimeout(r, 10));

    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    const first = bridge.latency.greetingLatencyMs;
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.greetingLatencyMs).toBe(first);
  });

  it("greeting_latency_ms stays null if customer never answered", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    // Never call handleCustomerAnswered.
    // Simulate a rogue agent_audio arriving anyway (defensive path).
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.greetingLatencyMs).toBe(null);
  });

  it("sendToAsterisk is called BEFORE greeting latency is computed (hot path first)", async () => {
    const { bridge } = makeBridge();
    const order = [];
    bridge.sendToAsterisk = vi.fn(() => order.push("send"));
    // Monkey-patch _recordAgentAudioLatency after construction to observe ordering.
    const origRecord = bridge._recordAgentAudioLatency.bind(bridge);
    bridge._recordAgentAudioLatency = (receivedAt, sentAt) => {
      order.push("record");
      return origRecord(receivedAt, sentAt);
    };

    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(order).toEqual(["send", "record"]);
  });

  it("audio_plumbing sample is recorded for the greeting first chunk", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.audioPlumbingSamplesMs.length).toBe(1);
    expect(bridge.latency.audioPlumbingSamplesMs[0]).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: new greeting_latency tests FAIL. Some will fail on missing `_recordAgentAudioLatency` method.

- [ ] **Step 3: Rewrite the `agent_audio` handler and add `_recordAgentAudioLatency`**

In `voiceagent-saas/call-bridge.js`, replace the existing `agent_audio` handler block (lines 339-354) with this exact code:

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
    });
```

Then add the private method `_recordAgentAudioLatency` to the `CallBridge` class. Insert it AFTER `_wireSessionEvents` and BEFORE `handleCustomerAnswered` (somewhere around the existing line 434 comment `// ─── Asterisk -> Bridge ────────────────────────────────────────`):

```js
  /**
   * Record latency for one agent_audio chunk. Called AFTER sendToAsterisk
   * from inside the agent_audio handler. Best-effort — caller wraps in
   * try/catch so throws cannot impact audio dispatch.
   *
   * Handles three sample paths:
   *   1. Greeting first chunk: computes greeting_latency_ms (once per call).
   *   2. Turn first chunk: computes turn_latency_ms from pendingUserFinalAt.
   *   3. Barge-in case: discards the turn sample if pendingUserFinalIsBarge.
   *
   * audio_plumbing_ms samples (sentAt - receivedAt) are pushed on the
   * greeting first chunk AND on non-barge turn first chunks. No sample
   * on subsequent chunks in the same turn (pendingUserFinalAt is cleared).
   *
   * Spec §3.1, §3.2, §3.3, §4.2, §6.
   */
  _recordAgentAudioLatency(receivedAt, sentAt) {
    // Greeting path
    if (this.latency.greetingLatencyMs == null) {
      if (this.latency.customerAnsweredAt != null) {
        const gl = clampNonNegative(receivedAt - this.latency.customerAnsweredAt);
        this.latency.greetingLatencyMs = gl;
        if (sentAt != null) {
          this.latency.audioPlumbingSamplesMs.push(
            clampNonNegative(sentAt - receivedAt),
          );
        }
        this.log.info(
          {
            event: "greeting_latency",
            call_id: this.callId,
            greeting_latency_ms: gl,
          },
          "greeting latency measured",
        );
        return;
      }
      // Defensive: agent_audio arrived but we never got customer_answered.
      // Only warn if state is live (to skip expected early-media / ringback
      // frames during pre_warmed). Should not happen post-lifecycle-fix.
      if (this._state === "live") {
        this.log.warn(
          { event: "greeting_latency_skipped_no_answer", call_id: this.callId },
          "agent_audio before customer_answered — greeting_latency not computed",
        );
      }
      return;
    }

    // Turn path
    if (this.latency.pendingUserFinalAt != null) {
      if (this.latency.pendingUserFinalIsBarge) {
        this.log.info(
          {
            event: "turn_latency_skipped_barge",
            call_id: this.callId,
          },
          "turn latency sample discarded due to interruption",
        );
        this.latency.pendingUserFinalAt = null;
        this.latency.pendingUserFinalIsBarge = false;
        return;
      }
      const userFinalAt = this.latency.pendingUserFinalAt;
      const tl = clampNonNegative(receivedAt - userFinalAt);
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
          user_final_at: userFinalAt,
          agent_audio_at: receivedAt,
          turn_latency_ms: tl,
        },
        "turn latency measured",
      );
      this.latency.pendingUserFinalAt = null;
      this.latency.pendingUserFinalIsBarge = false;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: all greeting tests PASS. All prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): greeting_latency_ms + hot-path-first agent_audio

- agent_audio handler runs sendToAsterisk BEFORE instrumentation
- _recordAgentAudioLatency private method handles greeting path
- audio_plumbing sample recorded on greeting first chunk

Spec §3.1, §3.3, §4.2."
```

---

## Task 6: Turn latency tracking via `user_transcript`

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (`user_transcript` handler inside `_wireSessionEvents`, around line 356)
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Write failing tests for turn latency**

Append to the test file:

```js
describe("turn_latency_ms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });
  const audioChunk = () => Buffer.alloc(320);

  it("user_transcript isFinal sets pendingUserFinalAt", async () => {
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

    expect(bridge.latency.pendingUserFinalAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.pendingUserFinalAt).toBeLessThanOrEqual(after);
  });

  it("user_transcript isFinal=false does NOT set pendingUserFinalAt", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "שלו...",
      isFinal: false,
      ts: Date.now(),
    });

    expect(bridge.latency.pendingUserFinalAt).toBe(null);
  });

  it("computes turn_latency_ms on next agent_audio after isFinal", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    // Consume the greeting first.
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    expect(bridge.latency.greetingLatencyMs).not.toBe(null);

    // User speaks, finalizes.
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "כן",
      isFinal: true,
      ts: Date.now(),
    });

    // Wait, then agent responds.
    await new Promise((r) => setTimeout(r, 25));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
    expect(bridge.latency.turnLatenciesMs[0]).toBeGreaterThanOrEqual(20);
    expect(bridge.latency.pendingUserFinalAt).toBe(null);
  });

  it("multiple isFinal before one agent_audio → only the most recent counted", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "first",
      isFinal: true,
      ts: Date.now(),
    });
    const firstFinalAt = bridge.latency.pendingUserFinalAt;

    await new Promise((r) => setTimeout(r, 15));
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "second",
      isFinal: true,
      ts: Date.now(),
    });
    const secondFinalAt = bridge.latency.pendingUserFinalAt;
    expect(secondFinalAt).toBeGreaterThan(firstFinalAt);

    await new Promise((r) => setTimeout(r, 15));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    // The measured latency should be from the SECOND isFinal, so ~15ms
    // not ~30ms.
    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
    expect(bridge.latency.turnLatenciesMs[0]).toBeLessThan(30);
  });

  it("subsequent agent_audio chunks in the same turn do NOT create extra samples", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "test",
      isFinal: true,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));

    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
    // audio_plumbing samples: 1 from greeting + 1 from turn first chunk = 2
    expect(bridge.latency.audioPlumbingSamplesMs.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: new turn_latency tests FAIL. The current `user_transcript` handler at line 356 only enqueues the turn — it does not touch `this.latency`.

- [ ] **Step 3: Modify the `user_transcript` handler in `_wireSessionEvents`**

In `voiceagent-saas/call-bridge.js`, find the handler starting at `session.on("user_transcript", ...)` around line 356. Keep the existing `enqueueTurn` call; add latency tracking BEFORE it:

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

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: all turn_latency tests PASS.

- [ ] **Step 5: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): turn_latency_ms tracking via user_transcript isFinal

user_transcript isFinal=true sets pendingUserFinalAt; the next agent_audio
computes turn_latency_ms. Only the most recent isFinal counts.

Spec §3.2, §4.2."
```

---

## Task 7: Barge-in handling via `interruption`

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (add new `interruption` listener inside `_wireSessionEvents`)
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Write failing tests**

Append:

```js
describe("barge-in handling (interruption event)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });
  const audioChunk = () => Buffer.alloc(320);

  it("interruption with pendingUserFinalAt set → next agent_audio discards the sample", async () => {
    const { bridge, log } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "test",
      isFinal: true,
      ts: Date.now(),
    });
    MockElevenLabsSession.last.emit("interruption", {});
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(true);

    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    // Sample should be discarded.
    expect(bridge.latency.turnLatenciesMs.length).toBe(0);
    expect(bridge.latency.pendingUserFinalAt).toBe(null);
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(false);
    expect(
      log.calls.info.some((entry) =>
        JSON.stringify(entry).includes("turn_latency_skipped_barge"),
      ),
    ).toBe(true);
  });

  it("interruption with no pending isFinal → no-op (no leak across turns)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    // No isFinal first — interruption fires alone.
    MockElevenLabsSession.last.emit("interruption", {});
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(false);

    // Now a normal turn proceeds.
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "hi",
      isFinal: true,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 15));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    // Sample NOT discarded because the barge flag was never set on THIS isFinal.
    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Expected: FAIL because no `interruption` listener exists yet.

- [ ] **Step 3: Add the `interruption` handler inside `_wireSessionEvents`**

In `voiceagent-saas/call-bridge.js`, add this new listener inside `_wireSessionEvents`, right after the `agent_response_correction` handler and before the `tool_call` handler:

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

- [ ] **Step 4: Run tests**

Expected: both barge tests PASS.

- [ ] **Step 5: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): discard turn latency samples on interruption

Wire interruption event to mark any pending user isFinal as a barge; the
subsequent agent_audio chunk's sample is discarded because it measures
the continuation of interrupted speech, not a fresh response.

Spec §6."
```

---

## Task 8: Finalize aggregation + flip bridge upsert

**Files:**
- Modify: `voiceagent-saas/call-bridge.js` (`_persistFinalState` around lines 572-592)
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js`

- [ ] **Step 1: Write failing tests for the finalize path**

Append:

```js
describe("_persistFinalState latency aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });
  const audioChunk = () => Buffer.alloc(320);

  // Extract the call_metrics upsert row from the recorded calls.
  function findCallMetricsUpsert(supabase) {
    return supabase._upsertCalls.find(
      (c) => c.row && c.row.call_id && c.row.tenant_id,
    );
  }

  it("persists latency fields with turns present", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    for (let i = 0; i < 3; i++) {
      MockElevenLabsSession.last.emit("user_transcript", {
        text: `t${i}`,
        isFinal: true,
        ts: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 10));
      MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    }

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert).toBeTruthy();
    expect(upsert.row.greeting_latency_ms).not.toBe(null);
    expect(upsert.row.greeting_latency_ms).toBeGreaterThanOrEqual(0);
    expect(upsert.row.avg_turn_latency_ms).not.toBe(null);
    expect(upsert.row.p95_turn_latency_ms).not.toBe(null);
    expect(upsert.row.audio_plumbing_ms).not.toBe(null);
    expect(upsert.row.turn_latencies_ms).toHaveLength(3);
  });

  it("persists NULLs when no turns happened", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting only

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert.row.greeting_latency_ms).not.toBe(null);
    expect(upsert.row.avg_turn_latency_ms).toBe(null);
    expect(upsert.row.p95_turn_latency_ms).toBe(null);
    expect(upsert.row.turn_latencies_ms).toBe(null);
  });

  it("bridge upsert uses ignoreDuplicates: false (last-writer-wins)", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert.opts).toEqual({
      onConflict: "call_id",
      ignoreDuplicates: false,
    });
  });

  it("aggregation failure is caught and does not break the upsert", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    // Poison the tracker to force a throw during aggregation.
    bridge.latency.turnLatenciesMs = {
      get length() {
        throw new Error("boom");
      },
    };

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    // call_metrics upsert should STILL happen with the non-latency fields.
    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert).toBeTruthy();
    expect(upsert.row.call_id).toBe("cid-1");
    // Latency fields omitted (undefined in the row literal), which Supabase
    // serializes as absent keys — the point is the upsert doesn't throw.
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

The "ignoreDuplicates: false" test will fail because the current code has `true`. The aggregation tests will fail because the new fields aren't in the upsert row yet.

- [ ] **Step 3: Replace `_persistFinalState`'s `metricsRow` build + upsert block**

In `voiceagent-saas/call-bridge.js`, find the block starting around line 572 (the `// call_metrics: PRIMARY KEY insert ...` comment) and replace through the upsert call (lines 572-592) with:

```js
    // call_metrics: primary-key upsert. Bridge path is last-writer-wins
    // (ignoreDuplicates: false) so bridge writes always land even when
    // the janitor raced first with a sparse row. The janitor path at
    // janitor.js:112 stays ignoreDuplicates: true so it no-ops when a
    // row already exists — preventing the inverse race. See spec §4.6.
    let latencyFields = {};
    try {
      const turns = this.latency.turnLatenciesMs;
      const plumbing = this.latency.audioPlumbingSamplesMs;
      const avgTurn = mean(turns);
      const avgPlumbing = mean(plumbing);
      latencyFields = {
        greeting_latency_ms: this.latency.greetingLatencyMs,
        avg_turn_latency_ms: avgTurn != null ? Math.round(avgTurn) : null,
        p95_turn_latency_ms: percentile(turns, 0.95),
        audio_plumbing_ms: avgPlumbing != null ? Math.round(avgPlumbing) : null,
        turn_latencies_ms: turns && turns.length ? turns : null,
      };
    } catch (err) {
      this.log.error({ err }, "latency aggregation threw");
      latencyFields = {};
    }

    // End-of-call latency summary log (spec §4.3).
    try {
      this.log.info(
        {
          event: "call_latency_summary",
          call_id: this.callId,
          greeting_latency_ms: latencyFields.greeting_latency_ms ?? null,
          turn_count: this.latency.turnLatenciesMs?.length ?? 0,
          avg_turn_latency_ms: latencyFields.avg_turn_latency_ms ?? null,
          p95_turn_latency_ms: latencyFields.p95_turn_latency_ms ?? null,
          audio_plumbing_ms: latencyFields.audio_plumbing_ms ?? null,
        },
        "call latency summary",
      );
    } catch (err) {
      this.log.error({ err }, "call_latency_summary log failed");
    }

    const metricsRow = {
      call_id: this.callId,
      tenant_id: this.tenantId,
      call_duration_seconds: Math.max(
        0,
        Math.floor((this.endedAt - this.callStartedAt) / 1000),
      ),
      transcript_turn_count: this.turnCount,
      tool_call_count: this.toolCallCount,
      tts_first_byte_ms: this.ttsFirstByteMs,
      el_ws_open_ms: this.elWsOpenMs,
      ...latencyFields,
    };
    try {
      await this.supabase
        .from("call_metrics")
        .upsert(metricsRow, { onConflict: "call_id", ignoreDuplicates: false });
    } catch (err) {
      this.log.error({ err }, "call_metrics upsert failed");
    }
```

- [ ] **Step 4: Run tests**

Expected: all finalize tests PASS. All prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "feat(call-bridge): aggregate latency in finalize + flip bridge upsert

- _persistFinalState computes avg/p95 turn latency, avg audio plumbing,
  persists raw turn_latencies_ms[] array
- Aggregation wrapped in try/catch so it can't break the metrics write
- Emits call_latency_summary log line at end of call
- Bridge upsert now ignoreDuplicates: false (last-writer-wins). Janitor
  path unchanged — its ignoreDuplicates: true still no-ops when a row
  exists, so all four write orderings yield the richest row.

Spec §4.3, §4.6."
```

---

## Task 9: Harness test — full run + all prior lifecycle tests still pass

**Files:**
- None to modify; this is a verification task only.

- [ ] **Step 1: Run the entire vitest suite in voiceagent-saas**

```bash
cd voiceagent-saas && npx vitest run
```
Expected: all tests pass, including the original `tests/call-bridge-state.test.js` and the new `tests/call-bridge-latency.test.js`.

If any state-machine test regresses, the most likely cause is the `user_transcript` handler edit in Task 6 or the `_persistFinalState` rewrite in Task 8. Read the failure, compare against the instructions above, fix, re-run. Do NOT proceed to Task 10 until the full suite is green.

- [ ] **Step 2: No commit** (verification-only task)

---

## Task 10: Lock janitor upsert behavior (regression guard)

**Files:**
- Modify: `voiceagent-saas/tests/call-bridge-latency.test.js` (append a string-level assertion on the janitor file)

This is a cheap, grep-based regression guard. We do not want to exercise the janitor runtime in this test (it would require mocking the janitor's sweep logic); we just want to fail fast if someone later flips `ignoreDuplicates` on the janitor upsert and reintroduces the NULL-overwrite risk described in spec §4.6.

- [ ] **Step 1: Write the lock test**

Append to `voiceagent-saas/tests/call-bridge-latency.test.js`:

```js
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("janitor upsert behavior lock (spec §4.6)", () => {
  it("janitor.js call_metrics upsert uses ignoreDuplicates: true", () => {
    const janitorPath = resolve(__dirname, "../janitor.js");
    const src = readFileSync(janitorPath, "utf8");
    // Find the call_metrics upsert options literal and assert it contains
    // ignoreDuplicates: true. If someone flips this, the test fails loudly.
    const metricsUpsertIdx = src.indexOf('from("call_metrics")');
    expect(metricsUpsertIdx).toBeGreaterThan(-1);
    // Look at the ~400 chars following the from() call.
    const slice = src.slice(metricsUpsertIdx, metricsUpsertIdx + 500);
    expect(slice).toContain("ignoreDuplicates: true");
    expect(slice).not.toContain("ignoreDuplicates: false");
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd voiceagent-saas && npx vitest run tests/call-bridge-latency.test.js
```
Expected: the new test PASSES against the current janitor source. All prior tests still pass.

- [ ] **Step 3: Commit**

```bash
git add voiceagent-saas/tests/call-bridge-latency.test.js
git commit -m "test(call-bridge): lock janitor call_metrics upsert to ignoreDuplicates: true

Regression guard — if someone flips the janitor upsert, the bridge's
ignoreDuplicates: false becomes a NULL-overwrite risk per spec §4.6.
Grep-based assertion against janitor.js source."
```

---

## Task 11: Deploy to droplet

**Files:**
- None modified; this task copies files and restarts the service.

- [ ] **Step 1: scp the updated call-bridge.js**

```bash
scp voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/
```
Expected: one file transferred, no errors.

- [ ] **Step 2: Restart the service**

```bash
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"
```
Expected: no output, exit 0.

- [ ] **Step 3: Verify clean boot**

```bash
ssh root@188.166.166.234 "systemctl status voiceagent-saas --no-pager | head -30"
```
Expected: `active (running)`, no errors in the last few log lines.

```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '1 minute ago' --no-pager | tail -30"
```
Expected: normal startup lines, no ReferenceError / ImportError / unhandled promise rejection.

- [ ] **Step 4: No commit** (deployment task)

---

## Task 12: Live verification call

**Files:**
- None modified; this task places a real call and reads the numbers.

- [ ] **Step 1: Place a test call**

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

Phone rings. Answer. Have a short Hebrew exchange of **at least 3 turns**, and **interrupt Dani mid-sentence at least once** to exercise the barge path. Hang up.

- [ ] **Step 2: Read the diagnostic log lines**

```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '3 minutes ago' --no-pager | grep -E 'greeting_latency|turn_latency|call_latency_summary|turn_latency_skipped_barge'"
```
Expected:
- One `greeting_latency` line with `greeting_latency_ms` value
- ≥3 `turn_latency` lines with `turn_index` = 1, 2, 3 and `turn_latency_ms` values
- At least one `turn_latency_skipped_barge` line (from the interruption)
- One `call_latency_summary` line with all aggregates

Write down: `greeting_latency_ms`, each `turn_latency_ms`, `avg_turn_latency_ms`, `p95_turn_latency_ms`, `audio_plumbing_ms`.

- [ ] **Step 3: Verify persistence in call_metrics**

Use `mcp__supabase__execute_sql`:
```sql
select call_id, greeting_latency_ms, avg_turn_latency_ms, p95_turn_latency_ms,
       audio_plumbing_ms, turn_latencies_ms, ended_at
from call_metrics
where call_id = (
  select id from calls
  where contact_id = '33333333-3333-3333-3333-333333333333'
  order by started_at desc limit 1
);
```
Expected: 1 row. All five latency columns populated (except `turn_latencies_ms` which is an int[] — should have entries matching the number of non-barge turns). Values should roughly match the log lines from Step 2.

- [ ] **Step 4: Report the numbers**

Summarize:
- `greeting_latency_ms`: ___
- per-turn `turn_latency_ms` values: [___, ___, ___]
- `avg_turn_latency_ms`: ___
- `p95_turn_latency_ms`: ___
- `audio_plumbing_ms`: ___

If `audio_plumbing_ms` is <5ms: our code is not the bottleneck; latency lives in EL or network.
If `audio_plumbing_ms` is >50ms: investigate `sendToAsterisk` / the media-bridge WS write path.
If `turn_latency_ms` is >1500ms consistently: EL server-side is the bottleneck; look at agent prompt length, model, or tool call overhead.

- [ ] **Step 5: No commit** (verification)

---

## Rollback

If the deployed change breaks something:

```bash
git revert <commit-hash-of-task-8>
git revert <commit-hash-of-task-7>
git revert <commit-hash-of-task-6>
git revert <commit-hash-of-task-5>
git revert <commit-hash-of-task-4>
git revert <commit-hash-of-task-3>
scp voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"
```

The schema migration (Task 1) is additive and does NOT need rollback. Existing rows remain NULL for the new columns.
