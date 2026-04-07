// voiceagent-saas/live-turn-writer.js

/**
 * Process-wide singleton live turn writer.
 *
 * Spec: docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md §4.3 + §4.3.1
 * Plan: docs/superpowers/plans/2026-04-07-elevenlabs-runtime-swap-plan.md (task T5)
 *
 * Responsibilities:
 *  - Single shared postgres-js pool against SUPABASE_DIRECT_DB_URL (Supavisor txn mode).
 *  - Buffer call_turns rows in memory per call, flushed every 500ms or sooner.
 *  - Cross-call batching: ALL pending turns from ALL calls go in ONE multi-row insert.
 *  - Monotonic per-call turn_index assigned at enqueue time (NEVER from caller / EL ts).
 *  - Writes ONLY call_turns. NEVER writes call_tool_invocations (webhook is canonical).
 *  - Disk fallback on overflow; never blocks the call audio path.
 */

import postgres from 'postgres';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 500;
const FLUSH_TRIGGER_SIZE = 20;          // per-call immediate flush threshold
const OVERFLOW_THRESHOLD = 500;          // total turns across all calls → warn + sync flush
const CRITICAL_THRESHOLD = 2000;         // total turns → dump oldest 1000 to disk
const PER_CALL_DRAIN_MAX = 50;           // soft cap of turns drained from a single call per tick
const POOL_SIZE = 10;                    // per spec §4.3.1
const SHUTDOWN_DEADLINE_MS = 30_000;
const FALLBACK_DIR_PRIMARY = '/var/log/voiceagent-saas';
const FALLBACK_DIR_SECONDARY = './logs';
const FALLBACK_FILENAME = 'turn-fallback.jsonl';

// ─── Module-scoped singleton state ──────────────────────────────────

let sql = null;
let log = null;
let flushTimer = null;
let started = false;
let stopping = false;
let running = false;          // a flush is currently in flight
let retryPending = false;     // last flush failed; retry on next tick before draining new
let fallbackPath = null;

// Map<callId, { turns: Turn[], counter: number, tenantId: string }>
const callBuffers = new Map();

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Idempotent singleton init. Throws if SUPABASE_DIRECT_DB_URL is missing.
 * Errors here propagate so server.js fails fast at boot.
 */
export function startLiveTurnWriter({ logger } = {}) {
  if (started) return;

  const url = process.env.SUPABASE_DIRECT_DB_URL;
  if (!url) {
    throw new Error('SUPABASE_DIRECT_DB_URL is required for live-turn-writer');
  }

  log = (logger && typeof logger.child === 'function')
    ? logger.child({ component: 'live-turn-writer' })
    : (logger || console);

  // prepare:false is LOAD-BEARING — Supavisor transaction mode does not
  // support prepared statements, so postgres-js must skip the prepare phase.
  sql = postgres(url, {
    max: POOL_SIZE,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });

  // Resolve disk fallback path once at startup.
  fallbackPath = resolveFallbackPathSync();

  flushTimer = setInterval(() => {
    flushAll().catch((err) => {
      try { log.error?.({ err }, 'flushAll tick error'); } catch {}
    });
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive solely on this timer.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();

  started = true;
  stopping = false;
  try { log.info?.({ poolSize: POOL_SIZE }, 'live-turn-writer started'); } catch {}
}

/**
 * Synchronous, non-blocking. Adds a turn to the per-call buffer.
 * Assigns turn_index from a monotonic per-call counter — this guarantees
 * strict ordering regardless of caller event reordering or flush timing.
 *
 * NEVER throws to the caller. NEVER waits on I/O.
 */
export function enqueueTurn({ callId, tenantId, role, text, isFinal, ts } = {}) {
  try {
    if (!started || stopping) return;
    if (!callId || !tenantId || !role) return;

    let entry = callBuffers.get(callId);
    if (!entry) {
      entry = { turns: [], counter: 0, tenantId };
      callBuffers.set(callId, entry);
    }

    const turn = {
      call_id: callId,
      tenant_id: tenantId,
      turn_index: entry.counter++,   // monotonic, assigned at enqueue
      role,
      text: text ?? null,
      is_final: isFinal !== false,   // default true
      ts: ts ? new Date(ts).toISOString() : new Date().toISOString(),
    };
    entry.turns.push(turn);

    // Immediate-flush triggers — kick off flushAll without awaiting.
    const shouldImmediate =
      entry.turns.length >= FLUSH_TRIGGER_SIZE ||
      (turn.is_final === true && role === 'user');

    if (shouldImmediate) {
      flushAll().catch((err) => {
        try { log.error?.({ err }, 'immediate flush error'); } catch {}
      });
    }
  } catch (err) {
    // Bulletproof: never propagate to the audio path.
    try { log.error?.({ err }, 'enqueueTurn swallowed error'); } catch {}
  }
}

/**
 * Force an immediate flush of all pending turns for this call, then
 * remove its buffer + counter. Called by call-bridge on StasisEnd.
 */
export async function flushAndClose(callId) {
  if (!callId) return;
  try {
    await flushAll();
  } catch (err) {
    try { log.error?.({ err, callId }, 'flushAndClose flushAll error'); } catch {}
  }
  // Drop any residue (should be empty after a successful flush).
  callBuffers.delete(callId);
}

/**
 * Stop the writer:
 *  1. clear flush interval
 *  2. drain all buffers
 *  3. wait for in-flight flush (30s deadline)
 *  4. close postgres-js pool
 */
export async function stopLiveTurnWriter() {
  if (!started || stopping) return;
  stopping = true;

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Final drain.
  try {
    await flushAll();
  } catch (err) {
    try { log.error?.({ err }, 'shutdown drain error'); } catch {}
  }

  // Wait for any in-flight flush to finish, with a deadline.
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  while (running && Date.now() < deadline) {
    await sleep(50);
  }

  if (sql) {
    try {
      await sql.end({ timeout: 5 });
    } catch (err) {
      try { log.error?.({ err }, 'sql.end error'); } catch {}
    }
    sql = null;
  }

  started = false;
  try { log.info?.('live-turn-writer stopped'); } catch {}
}

// ─── Internals ──────────────────────────────────────────────────────

/**
 * Drain pending turns across ALL calls and write them in ONE multi-row insert.
 *
 * Overflow sweep order:
 *   1. If total > CRITICAL_THRESHOLD: dump oldest 1000 to disk first (drop them
 *      from in-memory buffers), log critical, then proceed.
 *   2. If total > OVERFLOW_THRESHOLD: log warning; flush ALL remaining synchronously
 *      (we already do one big insert per tick, so this is effectively the same path).
 *   3. Otherwise: drain up to PER_CALL_DRAIN_MAX from each call.
 */
async function flushAll() {
  if (!sql || (stopping && !running)) {
    // writer is stopping or shut down; drop this flush attempt
    return;
  }
  if (!sql) return;
  if (running) return; // serialize flushes
  running = true;

  try {
    // Step 1: count total pending turns.
    let total = 0;
    for (const entry of callBuffers.values()) total += entry.turns.length;
    if (total === 0) return;

    // Step 1a: critical overflow → spill oldest 1000 to disk and drop them.
    if (total > CRITICAL_THRESHOLD) {
      try {
        await spillOldestToDisk(1000);
      } catch (err) {
        try { log.error?.({ err }, 'disk spill error'); } catch {}
      }
      try { log.fatal?.({ total }, 'live-turn-writer critical overflow → spilled to disk'); } catch {
        try { log.error?.({ total }, 'live-turn-writer critical overflow → spilled to disk'); } catch {}
      }
      // recount
      total = 0;
      for (const entry of callBuffers.values()) total += entry.turns.length;
      if (total === 0) return;
    }

    // Step 1b: overflow warning + drain everything (no per-call cap).
    const drainEverything = total > OVERFLOW_THRESHOLD;
    if (drainEverything) {
      try { log.warn?.({ total, metric: 'queue_overflow' }, 'live-turn-writer queue_overflow'); } catch {}
    }

    // Step 2: collect rows. We slice from the front of each call's buffer
    // (FIFO) so monotonic turn_index ordering is preserved per call.
    const rows = [];
    const drained = []; // [{ entry, count }] so we can shift on success

    for (const [, entry] of callBuffers) {
      if (entry.turns.length === 0) continue;
      const take = drainEverything
        ? entry.turns.length
        : Math.min(PER_CALL_DRAIN_MAX, entry.turns.length);
      for (let i = 0; i < take; i++) rows.push(entry.turns[i]);
      drained.push({ entry, count: take });
    }

    if (rows.length === 0) return;

    // Step 3: single multi-row insert. ON CONFLICT DO NOTHING is
    // defense-in-depth — the monotonic counter should prevent collisions
    // in practice, but a double-enqueue across a restart boundary or a
    // bug elsewhere shouldn't break the writer.
    try {
      await sql`
        INSERT INTO call_turns ${sql(
          rows,
          'call_id',
          'tenant_id',
          'turn_index',
          'role',
          'text',
          'is_final',
          'ts'
        )}
        ON CONFLICT (call_id, turn_index) DO NOTHING
      `;
    } catch (err) {
      // Flush failed. Retry ONCE on next tick with the same buffer
      // (we have NOT removed rows yet, so they're still pending).
      if (!retryPending) {
        retryPending = true;
        try { log.warn?.({ err, rows: rows.length }, 'live-turn-writer flush failed, will retry once'); } catch {}
        return;
      }
      // Second consecutive failure → drop these rows to disk fallback.
      retryPending = false;
      try { log.error?.({ err, rows: rows.length }, 'live-turn-writer flush failed twice, dumping to disk'); } catch {}
      try {
        await appendRowsToDisk(rows);
      } catch (diskErr) {
        try { log.error?.({ err: diskErr }, 'live-turn-writer disk fallback also failed'); } catch {}
      }
      // Drop the drained rows from buffers anyway — we did our best.
      for (const { entry, count } of drained) entry.turns.splice(0, count);
      return;
    }

    // Success → drop the drained slice from each buffer.
    retryPending = false;
    for (const { entry, count } of drained) entry.turns.splice(0, count);
  } finally {
    running = false;
  }
}

/**
 * Spill the oldest N turns (across all calls) to disk and remove them
 * from in-memory buffers. Used as the §4.3 critical overflow safety valve.
 */
async function spillOldestToDisk(n) {
  // Build a flat list of [callId, idx-within-buffer, turn] then sort by ts.
  // For practical purposes, in-buffer order is already monotonic per call,
  // and across calls insertion order is approximate. We pick from the
  // longest buffers first to free the most memory.
  const lines = [];
  let remaining = n;
  // Sort buffers by descending size to pull from the worst offenders first.
  const entries = Array.from(callBuffers.entries()).sort(
    (a, b) => b[1].turns.length - a[1].turns.length
  );
  for (const [callId, entry] of entries) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, entry.turns.length);
    if (take === 0) continue;
    const slice = entry.turns.splice(0, take);
    for (const t of slice) {
      lines.push(JSON.stringify({
        event: 'turn_dropped_to_disk',
        call_id: callId,
        turn_index: t.turn_index,
        text: t.text,
      }));
    }
    remaining -= take;
  }
  if (lines.length === 0) return;
  await _appendFile(fallbackPath, lines.join('\n') + '\n');
}

/**
 * Append a batch of rows that failed to flush twice to disk.
 */
async function appendRowsToDisk(rows) {
  const lines = rows.map((t) => JSON.stringify({
    event: 'turn_flush_failed',
    call_id: t.call_id,
    turn_index: t.turn_index,
    role: t.role,
    text: t.text,
    is_final: t.is_final,
    ts: t.ts,
  }));
  await _appendFile(fallbackPath, lines.join('\n') + '\n');
}

/**
 * One-time resolve at startup: prefer /var/log/voiceagent-saas, fall back
 * to ./logs if the primary path isn't writable. Synchronous best-effort —
 * we don't actually create the file, just pick a directory.
 */
function resolveFallbackPathSync() {
  // We can't sync-test fs.promises; do an async test on first use instead.
  // For startup we just pick the path optimistically and switch on first
  // write failure. Use the primary by default.
  return path.join(FALLBACK_DIR_PRIMARY, FALLBACK_FILENAME);
}

// Module-local appendFile with one-shot fallback: on the first appendFile
// failure against the primary path, swap to ./logs and retry. This is
// intentionally a local binding — we MUST NOT mutate fs.promises.appendFile
// globally or we poison the built-in for every other module in the process.
async function _appendFile(file, data) {
  try {
    await fs.appendFile(file, data);
  } catch (err) {
    if (file === path.join(FALLBACK_DIR_PRIMARY, FALLBACK_FILENAME)) {
      const alt = path.join(FALLBACK_DIR_SECONDARY, FALLBACK_FILENAME);
      try { await fs.mkdir(FALLBACK_DIR_SECONDARY, { recursive: true }); } catch {}
      fallbackPath = alt;
      await fs.appendFile(alt, data);
    } else {
      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
