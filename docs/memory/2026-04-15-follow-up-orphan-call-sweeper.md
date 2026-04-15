# 2026-04-15 Follow-up: Orphan Call Sweeper

## Context

Inbound call finalization now runs in a detached Node.js async finalizer. That fixes normal hangup/completion status writes, but it cannot protect against process crash or host restart while a call is in progress.

## Follow-up ticket

Implement a periodic reconciliation job that marks stale in-progress calls as failed.

## Proposed behavior

- Scan `calls` for rows with `status in ('initiated', 'ringing', 'connected')`.
- Limit to rows older than the maximum allowed call duration plus a safety margin.
- Mark stale rows as:
  - `status = 'failed'`
  - `failure_reason = 'timeout_orphan'`
  - `failure_reason_t = 'timeout_orphan'`
  - `ended_at = coalesce(ended_at, now())`
- Log/audit each reconciliation with enough identifiers for production debugging.

## Notes

- This was intentionally kept out of the tenant-routing/finalization fix to keep that change focused.
- Existing `janitor.js` may be the right place to add this behavior.
