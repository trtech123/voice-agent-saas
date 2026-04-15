export function startInboundBridgeFinalizer({ bridge, call, db, cleanupAsteriskResources, log }) {
  void finalizeInboundBridge({ bridge, call, db, cleanupAsteriskResources, log });
}

export async function finalizeInboundBridge({ bridge, call, db, cleanupAsteriskResources, log }) {
  try {
    const result = await bridge.start();
    const failed = Boolean(result?.failureReason);
    const update = {
      status: failed ? "failed" : "completed",
      duration_seconds: result?.duration_seconds ?? null,
      updated_at: new Date().toISOString(),
    };
    if (failed) {
      update.failure_reason = result.failureReason;
      update.failure_reason_t = result.failureReason;
    }
    await db.from("calls").update(update).eq("id", call.callId);
    log.info(
      {
        callId: call.callId,
        sipCallId: call.sipCallId,
        status: update.status,
        durationSeconds: update.duration_seconds,
        failureReason: result?.failureReason || null,
      },
      "Inbound call finalized",
    );
  } catch (err) {
    log.error(
      { err, callId: call.callId, sipCallId: call.sipCallId },
      "Inbound bridge finalizer failed",
    );
    try {
      await db
        .from("calls")
        .update({
          status: "failed",
          failure_reason: "network_error",
          failure_reason_t: "network_error",
          updated_at: new Date().toISOString(),
        })
        .eq("id", call.callId);
    } catch (updateErr) {
      log.error(
        { err: updateErr, callId: call.callId, sipCallId: call.sipCallId },
        "Inbound failure status update failed; manual reconciliation required",
      );
    }
    try {
      await cleanupAsteriskResources(call);
    } catch (cleanupErr) {
      log.error(
        { err: cleanupErr, callId: call.callId, sipCallId: call.sipCallId },
        "Inbound Asterisk cleanup failed after bridge finalizer error",
      );
    }
  }
}
