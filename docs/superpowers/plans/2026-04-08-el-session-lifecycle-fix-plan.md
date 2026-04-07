# EL Session Lifecycle Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the pre-answer conversation bug in the ElevenLabs call bridge so the agent does not start speaking until the customer has picked up the phone, while still pre-warming the WebSocket during ring for snappy pickup latency.

**Architecture:** Add a 5-state machine to `CallBridge` (CREATED → PRE_WARMING → PRE_WARMED → LIVE → FINALIZED). Split `ElevenLabsSession.connect()` into two steps — the second step (`startConversation()`) is only called when `handleCustomerAnswered()` fires, driven by `server.js` observing the customer channel `ChannelStateChange → Up` ARI event.

**Tech Stack:** Node.js 22 ESM, `ws` library for WebSocket, Vitest for tests, Fastify for the Asterisk ARI event loop. The running code is `voiceagent-saas/` (plain JS, no build). Tests will live in a new `voiceagent-saas/tests/` directory using Vitest. The parallel `apps/voice-engine/` TypeScript codebase is stale and out of scope.

**Spec:** `docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md`

---

## File Structure

### Files created

- `voiceagent-saas/tests/call-bridge-state.test.js` — unit tests for the `CallBridge` state machine and `handleCustomerAnswered()` path
- `voiceagent-saas/tests/elevenlabs-session-split.test.js` — unit tests for `ElevenLabsSession.connect()` / `startConversation()` split
- `voiceagent-saas/tests/setup.js` — minimal Vitest setup (env var stubs so constructors don't throw)
- `voiceagent-saas/vitest.config.js` — Vitest config pointing at `tests/`

### Files modified

- `voiceagent-saas/package.json` — add `vitest` devDependency and `test` script
- `voiceagent-saas/elevenlabs-session.js` — split `connect()` into WS-open-only; add `startConversation()`; emit `ws_open` event; `sendAudio()` guard
- `voiceagent-saas/call-bridge.js` — add `_state` field, `_transition()` helper, `handleCustomerAnswered()` method; guard `handleCallerAudio()`
- `voiceagent-saas/server.js` — wire one new branch in the ARI `ChannelStateChange` handler to call `bridge.handleCustomerAnswered()`

### Files NOT touched

- `voiceagent-saas/media-bridge.js`
- `voiceagent-saas/agent-sync-processor.js`
- `voiceagent-saas/live-turn-writer.js`
- `voiceagent-saas/janitor.js`
- `voiceagent-saas/tools.js`, `elevenlabs-tools-adapter.js`
- `apps/dashboard/src/app/api/webhooks/elevenlabs/conversation-ended/route.ts`
- The database migration file (no schema change)
- The parallel `apps/voice-engine/` TypeScript codebase

---

## Task 1: Scaffold Vitest for voiceagent-saas/

**Files:**
- Create: `voiceagent-saas/tests/setup.js`
- Create: `voiceagent-saas/vitest.config.js`
- Modify: `voiceagent-saas/package.json`

- [ ] **Step 1.1: Add vitest devDependency and test script to package.json**

Read `voiceagent-saas/package.json`. It currently has:
```json
{
  "name": "voiceagent-saas",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": { ... }
}
```

Change to add `test` script and `devDependencies`:
```json
{
  "name": "voiceagent-saas",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": { /* unchanged */ },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

Do not touch the `dependencies` block. Only add the two scripts and the `devDependencies` block.

- [ ] **Step 1.2: Create vitest.config.js**

Write `voiceagent-saas/vitest.config.js`:
```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
    environment: "node",
  },
});
```

- [ ] **Step 1.3: Create tests/setup.js**

Write `voiceagent-saas/tests/setup.js`:
```js
// Vitest global setup for voiceagent-saas
// Sets environment variables that module-level code expects so that
// imports in test files do not throw during construction.

process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-key-xi";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SUPABASE_DIRECT_DB_URL =
  process.env.SUPABASE_DIRECT_DB_URL ||
  "postgresql://postgres:test@localhost:5432/postgres";
```

- [ ] **Step 1.4: Install the devDependency**

Run:
```bash
cd voiceagent-saas && npm install
```

Expected: `vitest` installed, `package-lock.json` updated. No errors.

- [ ] **Step 1.5: Verify Vitest can run with zero tests**

Create an empty placeholder test to prove the runner wires up:
```bash
mkdir -p voiceagent-saas/tests
cat > voiceagent-saas/tests/smoke.test.js <<'EOF'
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
EOF
cd voiceagent-saas && npm test
```

Expected: 1 test passes. If it fails, diagnose before moving on. Delete `tests/smoke.test.js` after it passes:
```bash
rm voiceagent-saas/tests/smoke.test.js
```

- [ ] **Step 1.6: Commit**

```bash
git add voiceagent-saas/package.json voiceagent-saas/package-lock.json voiceagent-saas/vitest.config.js voiceagent-saas/tests/setup.js
git commit -m "chore(voice-engine): scaffold vitest for voiceagent-saas tests"
```

---

## Task 2: Failing test — ElevenLabsSession.connect() does NOT send initiation

**Files:**
- Create: `voiceagent-saas/tests/elevenlabs-session-split.test.js`
- Reference (do not modify yet): `voiceagent-saas/elevenlabs-session.js`

**Context:** We're going to test `ElevenLabsSession.connect()` without hitting the real EL WebSocket. We mock the `ws` library's `WebSocket` constructor so that it never touches the network. The mock records every `.send()` call so we can assert what messages the session tried to send. For this task we assert that after `connect()` resolves and the mock emits its `open` event, no message has been sent yet (i.e., `conversation_initiation_client_data` is deferred to `startConversation()`).

- [ ] **Step 2.1: Write the failing test file**

Write `voiceagent-saas/tests/elevenlabs-session-split.test.js`:
```js
// Tests for the connect() / startConversation() split in ElevenLabsSession.
// Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §3.1
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ─── ws mock ────────────────────────────────────────────────────────
// Replace the `ws` module with a fake WebSocket that never touches the
// network. Tests emit 'open'/'message'/'close' events manually to drive
// the session through its state transitions.
class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.last = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
    // emit close asynchronously like the real ws lib
    setImmediate(() => this.emit("close", code, Buffer.from(reason || "")));
  }
  // test helpers
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }
  fireMessage(obj) {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }
  fireError(err) {
    this.emit("error", err);
  }
}

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

// Import AFTER the mock is set up.
const { ElevenLabsSession } = await import("../elevenlabs-session.js");

// ─── test logger ────────────────────────────────────────────────────
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

describe("ElevenLabsSession connect/startConversation split", () => {
  let logger;
  beforeEach(() => {
    logger = makeLogger();
    FakeWebSocket.last = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connect() opens the WS but does NOT send conversation_initiation_client_data", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: { dynamicVariables: { foo: "bar" } },
      logger,
    });

    await s.connect();
    const ws = FakeWebSocket.last;
    expect(ws).toBeDefined();

    // Fire the 'open' event — this is what the real ws lib would do
    // after the TCP/TLS/HTTP handshake completes.
    ws.fireOpen();

    // After 'open' fires, NO messages should have been sent yet.
    // In the old code, _sendInitiation() was called here.
    expect(ws.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2.2: Run the test and verify it fails**

Run:
```bash
cd voiceagent-saas && npm test -- elevenlabs-session-split
```

Expected: FAIL. The assertion `expect(ws.sent).toHaveLength(0)` will fail because the current `connect()` implementation calls `_sendInitiation()` on `ws.on('open')`, so `ws.sent.length === 1` at this point.

Verify the failure is the one we expect (initiation message sent during connect), not some other error like "module not found" or "cannot mock ws."

---

## Task 3: Implement the ElevenLabsSession split to make Task 2 pass

**Files:**
- Modify: `voiceagent-saas/elevenlabs-session.js`

- [ ] **Step 3.1: Remove the `_sendInitiation()` call from the `ws.on('open')` handler**

In `voiceagent-saas/elevenlabs-session.js`, locate the `connect()` method around line 67. Find this block:
```js
ws.on("open", () => {
  this.log.info({ agentId: this.agentId }, "ElevenLabs WS open");
  this._startMaxDurationTimer();
  this._resetHeartbeat();
  this._sendInitiation();
});
```

Replace with:
```js
ws.on("open", () => {
  this.log.info({ agentId: this.agentId }, "ElevenLabs WS open");
  this._startMaxDurationTimer();
  this._resetHeartbeat();
  this._wsOpen = true;
  this.emit("ws_open");
  // Do NOT send conversation_initiation_client_data here.
  // Caller must invoke startConversation() to start the agent turn.
});
```

- [ ] **Step 3.2: Add `_wsOpen` and `_conversationStarted` fields in the constructor**

In the `constructor()` method, locate the block that initializes fields around line 54:
```js
this.ws = null;
this.conversationId = null;
this._closed = false;
this._maxDurationTimer = null;
this._heartbeatTimer = null;
this._lastPingAt = null;          // used by downstream tts_first_byte_ms metric
/** @type {Map<string, {replied: boolean}>} */
this._pendingToolCalls = new Map();
```

Add two new fields immediately after `this._pendingToolCalls = new Map();`:
```js
this._wsOpen = false;
this._conversationStarted = false;
```

- [ ] **Step 3.3: Add the `startConversation()` public method**

Immediately after the `sendAudio()` method (around line 131), add:
```js
/**
 * Begin the EL conversation by sending conversation_initiation_client_data.
 * MUST be called only after the 'ws_open' event has fired.
 * Idempotent: a second call logs a warning and no-ops.
 */
startConversation() {
  if (this._conversationStarted) {
    this.log.warn("startConversation called twice — ignoring");
    return;
  }
  if (!this._wsOpen) {
    throw new ElevenLabsSessionError(
      "startConversation called before ws_open",
      "el_ws_protocol_error"
    );
  }
  this._conversationStarted = true;
  this._sendInitiation();
}
```

- [ ] **Step 3.4: Guard `sendAudio()` so it drops frames before startConversation()**

Locate the `sendAudio()` method around line 121:
```js
sendAudio(pcm16kBuffer) {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    this.log.warn("sendAudio called while EL WS not open — dropping frame");
    return;
  }
  const b64 = pcm16kBuffer.toString("base64");
  this._safeSend({
    type: "user_audio_chunk",
    user_audio_chunk: b64,
  });
}
```

Change to:
```js
sendAudio(pcm16kBuffer) {
  if (!this._conversationStarted) {
    // Pre-conversation (ring window) — silently drop. Expected path.
    return;
  }
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    this.log.warn("sendAudio called while EL WS not open — dropping frame");
    return;
  }
  const b64 = pcm16kBuffer.toString("base64");
  this._safeSend({
    type: "user_audio_chunk",
    user_audio_chunk: b64,
  });
}
```

- [ ] **Step 3.5: Run the test and verify it passes**

Run:
```bash
cd voiceagent-saas && npm test -- elevenlabs-session-split
```

Expected: PASS.

---

## Task 4: More tests for the ElevenLabsSession split (positive + idempotency + audio drop)

**Files:**
- Modify: `voiceagent-saas/tests/elevenlabs-session-split.test.js`

- [ ] **Step 4.1: Add a test for `startConversation()` sending the initiation payload**

Append to the `describe` block in `voiceagent-saas/tests/elevenlabs-session-split.test.js`:
```js
  it("startConversation() sends conversation_initiation_client_data", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: { dynamicVariables: { contact_name: "Tom" } },
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    s.startConversation();

    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe("conversation_initiation_client_data");
    expect(msg.conversation_config_override.agent.language).toBe("he");
    expect(msg.dynamic_variables.contact_name).toBe("Tom");
  });
```

- [ ] **Step 4.2: Add a test for idempotency (second call logs warn and no-ops)**

Append:
```js
  it("startConversation() called twice logs warn and does not double-send", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    s.startConversation();
    s.startConversation();

    expect(ws.sent).toHaveLength(1);
    expect(
      logger.calls.warn.some((entry) =>
        String(entry[0] || entry[1] || "").includes("startConversation called twice")
      )
    ).toBe(true);
  });
```

- [ ] **Step 4.3: Add a test for startConversation() before ws_open throwing**

Append:
```js
  it("startConversation() before ws_open throws with el_ws_protocol_error code", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    // Do NOT fire 'open' — WS is still handshaking.

    let caught;
    try {
      s.startConversation();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("el_ws_protocol_error");
  });
```

- [ ] **Step 4.4: Add a test for sendAudio() dropping frames before startConversation()**

Append:
```js
  it("sendAudio() before startConversation() silently drops frames", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    // Call sendAudio before startConversation — should be a silent no-op.
    s.sendAudio(Buffer.from(new Uint8Array(640)));
    s.sendAudio(Buffer.from(new Uint8Array(640)));

    // No messages sent, no warnings logged.
    expect(ws.sent).toHaveLength(0);
    expect(logger.calls.warn).toHaveLength(0);
  });
```

- [ ] **Step 4.5: Add a test for sendAudio() working after startConversation()**

Append:
```js
  it("sendAudio() after startConversation() sends user_audio_chunk", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();
    s.startConversation();
    // Clear the initiation message so we isolate the audio frame.
    ws.sent.length = 0;

    s.sendAudio(Buffer.from(new Uint8Array(640)));

    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe("user_audio_chunk");
    expect(typeof msg.user_audio_chunk).toBe("string");
  });
```

- [ ] **Step 4.6: Run all the session tests and verify they pass**

Run:
```bash
cd voiceagent-saas && npm test -- elevenlabs-session-split
```

Expected: 5 tests pass. If any fail, read the error carefully and fix either the test or the implementation to match the spec.

- [ ] **Step 4.7: Commit**

```bash
git add voiceagent-saas/elevenlabs-session.js voiceagent-saas/tests/elevenlabs-session-split.test.js
git commit -m "feat(el-session): split connect() from startConversation() for pre-warm lifecycle

Defers sending conversation_initiation_client_data until explicitly
requested via startConversation(). Caller must invoke startConversation()
after the 'ws_open' event has fired, otherwise the method throws.
sendAudio() silently drops frames until startConversation() has been
called (pre-conversation ringback drop path).

Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §3.1"
```

---

## Task 5: Failing test — CallBridge state machine transitions

**Files:**
- Create: `voiceagent-saas/tests/call-bridge-state.test.js`

**Context:** The `CallBridge` class has a lot of dependencies (`ElevenLabsSession`, `supabase`, `live-turn-writer`, `executeToolCall`). For these state machine tests we want to avoid all that and test the `_state` + `_transition()` logic in isolation. We do this by constructing a `CallBridge` with mock collaborators and exercising only the state transitions we care about.

- [ ] **Step 5.1: Write the failing test file**

Write `voiceagent-saas/tests/call-bridge-state.test.js`:
```js
// Unit tests for the CallBridge state machine.
// Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §2 + §3.2
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// ─── Mock ElevenLabsSession ─────────────────────────────────────────
// We control connect() / startConversation() / close() / sendAudio()
// and let tests emit 'ws_open', 'error', 'closed', etc.
class MockElevenLabsSession extends EventEmitter {
  constructor() {
    super();
    this.connectCalled = false;
    this.startConversationCalls = 0;
    this.closeCalled = false;
    this.sendAudioCalls = [];
  }
  async connect() {
    this.connectCalled = true;
    // The real session opens a WS and emits 'ws_open' on its own.
    // Tests drive this manually via session.emit("ws_open").
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

// Stub live-turn-writer so CallBridge can import it.
vi.mock("../live-turn-writer.js", () => ({
  enqueueTurn: vi.fn(),
  flushAndClose: vi.fn().mockResolvedValue(undefined),
}));

// Stub tools executor.
vi.mock("../tools.js", () => ({
  executeToolCall: vi.fn().mockResolvedValue({ ok: true }),
}));

// Import AFTER mocks are set up.
const { CallBridge } = await import("../call-bridge.js");

// ─── Test helpers ───────────────────────────────────────────────────
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
  // Minimal chainable mock for .from().select().eq().single() and .update().eq()
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
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  };
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

describe("CallBridge state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  it("starts in CREATED state", () => {
    const { bridge } = makeBridge();
    expect(bridge._state).toBe("created");
  });

  it("transitions CREATED → PRE_WARMING on start()", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    // After start() returns, we should be in PRE_WARMING (WS connect called,
    // but the mock hasn't fired ws_open yet).
    expect(bridge._state).toBe("pre_warming");
    expect(MockElevenLabsSession.last.connectCalled).toBe(true);
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);
  });
});
```

- [ ] **Step 5.2: Run the test and verify it fails**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: FAIL. The current `CallBridge` class has no `_state` field, so the first assertion `expect(bridge._state).toBe("created")` will fail with `undefined`.

---

## Task 6: Add state machine scaffolding to CallBridge (CREATED + PRE_WARMING)

**Files:**
- Modify: `voiceagent-saas/call-bridge.js`

- [ ] **Step 6.1: Add `_state` and `_pendingCustomerAnswered` fields in the constructor**

In `voiceagent-saas/call-bridge.js`, locate the `constructor(cfg)` method near the top of the `CallBridge` class (around line 97). Find the section that initializes instance fields (after `this.cfg = cfg;` and `this.log = ...`). Look for fields like `this.finalized`, `this.session`, `this.inboundAudioChunks`.

Add these two fields alongside:
```js
this._state = "created";
this._pendingCustomerAnswered = false;
```

Place them near the other `this._*` private fields (e.g. next to `this.finalized` if present, otherwise near the top of the field init block).

- [ ] **Step 6.2: Add the `_transition()` helper method**

Add a new private method to the `CallBridge` class. A good spot is right after the constructor, before the existing `start()` method. Insert:
```js
/**
 * Internal state transition helper. Logs every transition and rejects
 * invalid transitions (logs an error and stays in the source state).
 * Never throws — defensive.
 */
_transition(target, reason) {
  const from = this._state;
  const valid = {
    created: ["pre_warming"],
    pre_warming: ["pre_warmed", "finalized"],
    pre_warmed: ["live", "finalized"],
    live: ["finalized"],
    finalized: [],
  };
  if (!valid[from] || !valid[from].includes(target)) {
    this.log.error(
      { from, to: target, reason },
      "call-bridge: invalid state transition — staying in source state"
    );
    return;
  }
  const now = Date.now();
  const elapsedMs = this._stateEnteredAt ? now - this._stateEnteredAt : 0;
  this._stateEnteredAt = now;
  this._state = target;
  this.log.info(
    {
      event: "call_bridge_state_transition",
      call_id: this.cfg.callId,
      from,
      to: target,
      reason,
      elapsed_ms_since_start: elapsedMs,
    },
    "call-bridge state transition"
  );
}
```

Also initialize `this._stateEnteredAt = Date.now();` in the constructor, alongside `this._state = "created";`.

- [ ] **Step 6.3: Transition to PRE_WARMING at the start of start()**

Locate the `start()` method. At the beginning of the method body, AFTER the CAS assertion and session construction (i.e., just before `await session.connect()`), add:
```js
this._transition("pre_warming", "start_called");
```

Exact placement: find the block that ends with `await session.connect();`. Insert the `_transition` call on the line immediately before `this.elWsOpenedAt = Date.now();`.

- [ ] **Step 6.4: Run the Task 5 test and verify it passes**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: PASS. All 3 tests from Task 5 should now pass.

If it fails: check that the mock supabase chain is returning the campaign row correctly and that the CAS check in `start()` is passing. The CAS assertion requires `campaign.elevenlabs_agent_id === agentIdUsed && campaign.sync_version === syncVersionUsed && campaign.agent_status === 'ready'`. The test mock builds a matching row.

---

## Task 7: Add PRE_WARMING → PRE_WARMED transition on ws_open

**Files:**
- Modify: `voiceagent-saas/tests/call-bridge-state.test.js` (add tests)
- Modify: `voiceagent-saas/call-bridge.js` (wire ws_open event)

- [ ] **Step 7.1: Add the failing test**

Append to the `describe("CallBridge state machine", ...)` block in `voiceagent-saas/tests/call-bridge-state.test.js`:
```js
  it("transitions PRE_WARMING → PRE_WARMED when session emits ws_open", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    expect(bridge._state).toBe("pre_warming");

    // Simulate the real ElevenLabsSession emitting ws_open after WS handshake.
    MockElevenLabsSession.last.emit("ws_open");

    expect(bridge._state).toBe("pre_warmed");
    // Still no startConversation yet — we haven't been told the customer answered.
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);
  });
```

- [ ] **Step 7.2: Run the test and verify it fails**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: FAIL on the new test — `bridge._state` is still `'pre_warming'` because nothing in call-bridge is listening for `ws_open` yet.

- [ ] **Step 7.3: Wire the ws_open handler in call-bridge.js**

Locate the `_wireSessionEvents(session)` method in `voiceagent-saas/call-bridge.js`. This is where session events like `conversation_id`, `user_transcript`, `tool_call`, etc. get hooked up. Add a new listener at the top of the method, BEFORE the existing `session.on("conversation_id", ...)`:
```js
session.on("ws_open", () => {
  this._transition("pre_warmed", "ws_open");
  if (this._pendingCustomerAnswered) {
    this._pendingCustomerAnswered = false;
    this._transition("live", "customer_answered_early");
    try {
      this.session.startConversation();
    } catch (err) {
      this.log.error({ err }, "startConversation threw during pending-customer flush");
    }
  }
});
```

- [ ] **Step 7.4: Run the test and verify it passes**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: PASS on all 4 tests.

---

## Task 8: Add `handleCustomerAnswered()` method with full test coverage

**Files:**
- Modify: `voiceagent-saas/tests/call-bridge-state.test.js`
- Modify: `voiceagent-saas/call-bridge.js`

- [ ] **Step 8.1: Write the failing tests**

Append to `voiceagent-saas/tests/call-bridge-state.test.js`:
```js
  it("handleCustomerAnswered() from PRE_WARMED transitions to LIVE and calls startConversation", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge._state).toBe("pre_warmed");

    bridge.handleCustomerAnswered();

    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
  });

  it("handleCustomerAnswered() called twice is idempotent", async () => {
    const { bridge, log } = makeBridge();
    await bridge.start();
    MockElevenLabsSession.last.emit("ws_open");

    bridge.handleCustomerAnswered();
    bridge.handleCustomerAnswered();

    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
    expect(
      log.calls.warn.some((entry) =>
        JSON.stringify(entry).includes("handleCustomerAnswered called twice")
      )
    ).toBe(true);
  });

  it("handleCustomerAnswered() during PRE_WARMING queues and fires on ws_open", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    expect(bridge._state).toBe("pre_warming");

    // Customer answered faster than WS handshake.
    bridge.handleCustomerAnswered();
    expect(bridge._state).toBe("pre_warming"); // still pending
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);

    // WS finally opens.
    MockElevenLabsSession.last.emit("ws_open");

    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
  });

  it("handleCustomerAnswered() from FINALIZED logs warn and is a no-op", async () => {
    const { bridge, log } = makeBridge();
    await bridge.start();
    MockElevenLabsSession.last.emit("ws_open");
    // Force finalize by calling the internal finalizer.
    await bridge._finalizeAndResolve("test_forced_end", null);
    expect(bridge._state).toBe("finalized");

    bridge.handleCustomerAnswered();

    // Still finalized, startConversation never called.
    expect(bridge._state).toBe("finalized");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);
    expect(
      log.calls.warn.some((entry) =>
        JSON.stringify(entry).includes("handleCustomerAnswered after finalize")
      )
    ).toBe(true);
  });
```

- [ ] **Step 8.2: Run the tests and verify they fail**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: FAIL on the 4 new tests — `handleCustomerAnswered` doesn't exist on `CallBridge` yet (will throw `TypeError: bridge.handleCustomerAnswered is not a function`).

- [ ] **Step 8.3: Implement `handleCustomerAnswered()`**

Add a new public method to the `CallBridge` class in `voiceagent-saas/call-bridge.js`. Place it immediately before the existing `handleCallerAudio()` method:
```js
/**
 * Signal from server.js that the customer has picked up the phone
 * (ARI ChannelStateChange → Up on the customer channel). Transitions
 * the bridge from PRE_WARMED → LIVE and tells the EL session to
 * begin the conversation.
 *
 * Idempotent: a second call logs a warning and no-ops.
 * If called during PRE_WARMING (race where the customer answered
 * faster than the WS handshake), the transition is queued and
 * the ws_open handler will complete it.
 * If called after FINALIZED, the call logs a warning and is a no-op.
 */
handleCustomerAnswered() {
  if (this._state === "live") {
    this.log.warn("handleCustomerAnswered called twice — ignoring");
    return;
  }
  if (this._state === "finalized") {
    this.log.warn("handleCustomerAnswered after finalize — ignoring");
    return;
  }
  if (this._state === "pre_warming") {
    // Race: customer answered before WS handshake finished.
    // Queue the transition; the ws_open handler will pick it up.
    this._pendingCustomerAnswered = true;
    return;
  }
  if (this._state !== "pre_warmed") {
    this.log.error(
      { state: this._state },
      "handleCustomerAnswered in unexpected state"
    );
    return;
  }
  this._transition("live", "customer_answered");
  try {
    this.session.startConversation();
  } catch (err) {
    this.log.error({ err }, "startConversation threw in handleCustomerAnswered");
    // Fall through to fail-fast finalize.
    this._finalizeAndResolve("start_conversation_failed", "el_ws_protocol_error");
  }
}
```

- [ ] **Step 8.4: Run the tests and verify they pass**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: PASS on all 8 tests (3 from Task 5 + 1 from Task 7 + 4 from Task 8).

---

## Task 9: Guard `handleCallerAudio()` by state + test

**Files:**
- Modify: `voiceagent-saas/tests/call-bridge-state.test.js`
- Modify: `voiceagent-saas/call-bridge.js`

- [ ] **Step 9.1: Write the failing tests**

Append to `voiceagent-saas/tests/call-bridge-state.test.js`:
```js
  it("handleCallerAudio drops audio in PRE_WARMING state", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    expect(bridge._state).toBe("pre_warming");

    bridge.handleCallerAudio(Buffer.from(new Uint8Array(640)));

    expect(MockElevenLabsSession.last.sendAudioCalls).toHaveLength(0);
  });

  it("handleCallerAudio drops audio in PRE_WARMED state (before customer answers)", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge._state).toBe("pre_warmed");

    bridge.handleCallerAudio(Buffer.from(new Uint8Array(640)));

    expect(MockElevenLabsSession.last.sendAudioCalls).toHaveLength(0);
  });

  it("handleCallerAudio forwards audio in LIVE state", async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    MockElevenLabsSession.last.emit("ws_open");
    bridge.handleCustomerAnswered();
    expect(bridge._state).toBe("live");

    bridge.handleCallerAudio(Buffer.from(new Uint8Array(640)));

    expect(MockElevenLabsSession.last.sendAudioCalls).toHaveLength(1);
  });
```

- [ ] **Step 9.2: Run the tests and verify they fail**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: FAIL on the first two tests — `handleCallerAudio` currently forwards audio whenever `this.session` exists, regardless of state.

- [ ] **Step 9.3: Modify `handleCallerAudio()` to check state**

Locate the current `handleCallerAudio(audioBuffer)` method (around line 361):
```js
handleCallerAudio(audioBuffer) {
  if (!this.session) return;
  if (this.finalized) return;
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
    // Drop ringback / early-media frames (PRE_WARMING / PRE_WARMED states)
    // and any frames that arrive after FINALIZED.
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

Note: the old `if (this.finalized)` check is subsumed by `this._state !== "live"` because FINALIZED is not LIVE. The old `if (!this.session)` check is also subsumed — CREATED state has no session, and any state that has a session will either be LIVE (audio forwarded) or non-LIVE (dropped).

- [ ] **Step 9.4: Run the tests and verify they pass**

Run:
```bash
cd voiceagent-saas && npm test -- call-bridge-state
```

Expected: PASS on all 11 tests.

---

## Task 10: Transition to FINALIZED in `_finalizeAndResolve()` + commit

**Files:**
- Modify: `voiceagent-saas/call-bridge.js`

- [ ] **Step 10.1: Add the transition to FINALIZED**

Locate the `_finalizeAndResolve(endReason, failureReason)` method. Find the existing idempotency guard at the top:
```js
async _finalizeAndResolve(endReason, failureReason) {
  if (this.finalized) return;
  this.finalized = true;
  this.endReason = endReason;
  this.failureReason = failureReason || null;
  this.endedAt = new Date();
  // ... rest of method
}
```

Change the top to also drive the state machine:
```js
async _finalizeAndResolve(endReason, failureReason) {
  if (this._state === "finalized") return;
  this._transition("finalized", endReason || "finalize");
  this.finalized = true;
  this.endReason = endReason;
  this.failureReason = failureReason || null;
  this.endedAt = new Date();
  // ... rest of method
}
```

Rationale: `this._state === "finalized"` is the new canonical check; `this.finalized` stays as a backward-compat boolean for any external reader (e.g. `handleCallerAudio` old path, anything in media-bridge that might still check it).

- [ ] **Step 10.2: Run all voiceagent-saas tests and verify all still pass**

Run:
```bash
cd voiceagent-saas && npm test
```

Expected: all tests pass (Tasks 2+4 elevenlabs-session-split tests + Tasks 5+7+8+9 call-bridge-state tests = at least 16 tests total).

- [ ] **Step 10.3: Commit**

```bash
git add voiceagent-saas/call-bridge.js voiceagent-saas/tests/call-bridge-state.test.js
git commit -m "feat(call-bridge): add state machine with handleCustomerAnswered()

Introduces a 5-state machine (CREATED → PRE_WARMING → PRE_WARMED →
LIVE → FINALIZED) on CallBridge. The EL conversation does not start
until handleCustomerAnswered() fires, which is driven by server.js
on the customer channel ChannelStateChange → Up event (wired in the
next task). Inbound audio is dropped until LIVE.

Covers the race where the customer answers before the WS handshake
completes via a _pendingCustomerAnswered flag consumed by the
ws_open event handler.

Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §2, §3.2"
```

---

## Task 11: Wire `handleCustomerAnswered()` from server.js

**Files:**
- Modify: `voiceagent-saas/server.js`

**Context:** The ARI `ChannelStateChange` event handler in `server.js` already processes state transitions for both media and customer channels. We're adding ONE new branch that fires `bridge.handleCustomerAnswered()` when the customer channel goes `Up`.

There is no test for this task because it involves wiring into the ARI event loop, which is integration-level, not unit-level. The manual regression tests in Task 13 cover this path.

- [ ] **Step 11.1: Locate the ARI ChannelStateChange handler**

Open `voiceagent-saas/server.js`. Search for `ChannelStateChange` (case-sensitive). You should find a handler that logs each event with `msg: "Received ARI ChannelStateChange event"`. Read the surrounding code to understand how the customer channel is identified (look for `channelRole === "customer"` or similar, or how the customer channel name is matched against the bridge's `customerChannelId`).

- [ ] **Step 11.2: Add the handleCustomerAnswered branch**

At the end of the existing ChannelStateChange handler (or in the closest appropriate place), add a new branch that fires when the customer channel transitions to `Up`:

```js
// When the customer leg transitions to 'Up', signal the bridge that the
// customer has picked up so it can start the EL conversation.
// Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §3.3
if (event.channel && event.channel.state === "Up") {
  const channelId = event.channel.id;
  // Customer channels have IDs shaped like "customer-<sipCallId>"
  if (typeof channelId === "string" && channelId.startsWith("customer-")) {
    const sipCallId = channelId.slice("customer-".length);
    const bridge = getBridgeBySipCallId(sipCallId);
    if (bridge && typeof bridge.handleCustomerAnswered === "function") {
      fastify.log.info(
        { sipCallId, channelId },
        "Customer answered — signaling bridge"
      );
      bridge.handleCustomerAnswered();
    }
  }
}
```

**Important:** the helper `getBridgeBySipCallId(sipCallId)` may not exist yet. Look in the existing server.js code for how it already looks up bridges by sipCallId. There should be an `activeBridges` Map keyed by `callId` and some mechanism to map `sipCallId → callId → bridge`. If the lookup is already inline elsewhere in the file (e.g. in the StasisStart handler), replicate that pattern here. Do NOT introduce a new lookup mechanism — reuse what exists.

If server.js has no sipCallId → bridge lookup at all, look for how the existing code routes audio from the media WebSocket to the right bridge — that's the pattern you need.

- [ ] **Step 11.3: Manually verify the change compiles and the service boots**

Deploy the change to the droplet and restart:
```bash
scp voiceagent-saas/server.js root@188.166.166.234:/opt/voiceagent-saas/
ssh root@188.166.166.234 "systemctl restart voiceagent-saas"
sleep 3
ssh root@188.166.166.234 "systemctl is-active voiceagent-saas"
```

Expected: `active`. If not, tail the logs:
```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas -n 50 --no-pager"
```

Fix any syntax errors before moving on.

- [ ] **Step 11.4: Commit**

```bash
git add voiceagent-saas/server.js
git commit -m "feat(server): wire customer-answered event to CallBridge

On ARI ChannelStateChange where the customer channel transitions
to 'Up', locate the bridge by sipCallId and invoke
handleCustomerAnswered(). This is the trigger that moves the bridge
from PRE_WARMED to LIVE and starts the EL conversation.

Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §3.3"
```

---

## Task 12: Full deploy + sanity boot log check

**Files:** none (deployment + verification only)

- [ ] **Step 12.1: Deploy the full change set to the droplet**

Run:
```bash
scp voiceagent-saas/elevenlabs-session.js voiceagent-saas/call-bridge.js voiceagent-saas/server.js root@188.166.166.234:/opt/voiceagent-saas/
```

Expected: three files transferred without errors.

- [ ] **Step 12.2: Restart the service**

Run:
```bash
ssh root@188.166.166.234 "systemctl restart voiceagent-saas && sleep 3 && systemctl is-active voiceagent-saas"
```

Expected: `active`. If `failed`, go to Step 12.3 for log inspection.

- [ ] **Step 12.3: Verify the boot sequence**

Run:
```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '30 seconds ago' --no-pager | tail -30"
```

Expected lines:
- `"live-turn-writer started"` with `"poolSize":10`
- `"agent-sync worker started"`
- `"janitor started"`
- `"Call worker started"`
- `"BullMQ call worker, agent-sync worker, janitor, and monthly reset scheduler started"`
- `"Server listening at http://127.0.0.1:8091"`
- `"Connected to Asterisk ARI events"`

If any are missing, diagnose. The most likely failure mode is a JS syntax error in one of the modified files — fix locally, re-deploy, retry.

- [ ] **Step 12.4: Commit a no-op touch only if something needed fixing**

If deploy was clean, no commit needed — proceed to Task 13. If you had to fix something, stage + commit the fix before moving on.

---

## Task 13: Manual regression tests on a real phone

**Files:** none (human verification only)

**Context:** Every manual test uses the existing test campaign `22222222-2222-2222-2222-222222222222` which has `voice_id='9i2kmIrFwyBhu8sTYm07'` and `agent_status='ready'`. Use the contact for phone `+972587739815` (contact_id `bc788f33-fc43-4e9f-8b19-e3329c21d366`, campaign_contact_id `1c0ab67a-1ccd-420e-891f-ccf0a5f082d6`) or create a new contact for a different phone per the existing pattern in `voiceagent-saas/server.js` helpers.

- [ ] **Step 13.1: Test a normal answered call (happy path)**

Enqueue a call job manually via the droplet:
```bash
ssh root@188.166.166.234 "cd /opt/voiceagent-saas && node --input-type=module -e \"
import { Queue } from 'bullmq';
import 'dotenv/config';
const q = new Queue('call-jobs', { connection: { url: process.env.REDIS_URL } });
const job = await q.add('call', {
  tenantId: 'fd278f50-4e2e-4de3-872d-015c1bd7ee95',
  campaignId: '22222222-2222-2222-2222-222222222222',
  contactId: 'bc788f33-fc43-4e9f-8b19-e3329c21d366',
  campaignContactId: '1c0ab67a-1ccd-420e-891f-ccf0a5f082d6'
});
console.log('enqueued', job.id);
await q.close();
process.exit(0);
\""
```

Answer the phone when it rings. Speak Hebrew in full sentences. Verify:
1. You hear the greeting within ~1-2 seconds of pickup (not during ring)
2. The agent responds to your speech
3. The conversation runs at least 30 seconds without the agent asking "are you still there"
4. Hang up cleanly

- [ ] **Step 13.2: Verify the state transitions appear in logs**

Pull the logs for the call:
```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '3 minutes ago' --no-pager | grep call_bridge_state_transition"
```

Expected: you should see at least 3 transition lines:
- `from: created, to: pre_warming`
- `from: pre_warming, to: pre_warmed, reason: ws_open`
- `from: pre_warmed, to: live, reason: customer_answered`
- (plus a final `to: finalized` when the call ends)

If `to: live` happens BEFORE `reason: customer_answered` — the wiring in Task 11 is wrong.

- [ ] **Step 13.3: Verify call_turns has real user transcripts**

Run via Supabase MCP SQL:
```sql
select turn_index, role, text
from public.call_turns
where call_id in (
  select id from public.calls
  where contact_id = 'bc788f33-fc43-4e9f-8b19-e3329c21d366'
  order by started_at desc limit 1
)
order by turn_index;
```

Expected: both `agent` and `user` turns, with real Hebrew text in the user turns (not empty strings). This validates the empty-transcript bug is resolved.

- [ ] **Step 13.4: Test a no-answer path**

Enqueue another job with the same payload. **Do not answer the phone.** Let it ring until Voicenter times out.

Verify:
```sql
select id, failure_reason_t, started_at, ended_at
from public.calls
where contact_id = 'bc788f33-fc43-4e9f-8b19-e3329c21d366'
order by started_at desc limit 1;
```

Expected: `failure_reason_t` is `no_answer` (if Voicenter reports that) OR `null` with a duration matching the ring timeout. Either is acceptable as long as the call didn't crash the worker.

- [ ] **Step 13.5: Test hanging up during the greeting**

Enqueue another job. Answer the phone, then hang up as SOON as you hear the first word of the greeting (within ~1 second).

Verify:
```bash
ssh root@188.166.166.234 "journalctl -u voiceagent-saas --since '1 minute ago' --no-pager | grep -E 'state_transition|Call job processing complete'"
```

Expected: you see the full transition chain pre_warming → pre_warmed → live → finalized, AND the call completes cleanly with no stuck state. The call duration in the logs should be ~2-5 seconds.

---

## Task 14: Tag pre-rollout and final commit message

**Files:** none (git tagging only)

- [ ] **Step 14.1: Tag the pre-fix commit for rollback safety**

The most recent commit before this fix started is `576a4eb` ("fix: align implementation with real ElevenLabs API + review fixes"). Tag it:
```bash
git tag pre-lifecycle-fix 576a4eb
git push origin pre-lifecycle-fix
```

- [ ] **Step 14.2: Push the fix to main**

Run:
```bash
git push origin main
```

Expected: push succeeds, Railway auto-deploys the dashboard (which is unchanged in this fix, so no impact).

- [ ] **Step 14.3: Capture the current working state**

Run:
```bash
git log --oneline -5
```

Expected: the top commits are the ones from Tasks 1, 4, 10, 11. Sanity-check the commit messages look right.

---

## Self-Review Notes

**Spec coverage check:**
- Spec §1 Goals (zero wasted EL state, snappy latency, explicit lifecycle, 5 failure modes) — covered by Tasks 6-11 and manual tests 13.1-13.5
- Spec §2 State machine — covered by Task 6 (transition helper), Task 7 (ws_open), Task 8 (handleCustomerAnswered), Task 9 (audio guard), Task 10 (finalize transition)
- Spec §3.1 elevenlabs-session split — Tasks 2-4
- Spec §3.2 call-bridge changes — Tasks 5-10
- Spec §3.3 server.js wiring — Task 11
- Spec §4.1 failure mode matrix — covered by the `_transition()` validator (rejects invalid edges) and the existing `_finalizeAndResolve()` paths (unchanged)
- Spec §4.3 logs-only metrics — covered by the `call_bridge_state_transition` log line in `_transition()`
- Spec §5.1 unit tests — Tasks 2, 4, 5, 7, 8, 9
- Spec §5.2 integration tests — deferred to manual tests in Task 13 (noted in spec §5.6 as acceptable trade-off for production urgency)
- Spec §5.3 manual tests — Task 13
- Spec §5.4 rollout — Tasks 11.3 and 12
- Spec §5.5 rollback plan — Task 14 tag

**Type consistency check:**
- `_state` values used consistently: `"created"`, `"pre_warming"`, `"pre_warmed"`, `"live"`, `"finalized"` (all lowercase with underscores, never dashes)
- `_pendingCustomerAnswered` name used consistently across Tasks 6, 7, 8
- `handleCustomerAnswered` (not `handleAnswered` or `onCustomerAnswered`) used consistently
- `ws_open` event name used consistently between elevenlabs-session.js and call-bridge.js
- `startConversation` (not `start_conversation` or `beginConversation`) used consistently

**Placeholder scan:** No TODOs, no "add appropriate error handling", no "similar to task N", no vague language. Every code block is complete.

**Scope:** Single focused fix, all within voiceagent-saas/ plus new tests. No migrations, no dashboard changes, no schema changes.
