"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, callStatusLabels } from "@/lib/utils/format";
import { formatPhoneDisplay } from "@/lib/utils/phone-validator";
import type { Call, Contact } from "@vam/database";

interface FailedCallRow {
  call: Call;
  contact: Contact;
}

interface TabFailedProps {
  failedCalls: FailedCallRow[];
  campaignId: string;
}

export function TabFailed({ failedCalls, campaignId }: TabFailedProps) {
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [retried, setRetried] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function handleRetry(call: Call) {
    setRetrying((prev) => new Set(prev).add(call.id));
    setError(null);

    try {
      const res = await fetch("/api/calls/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callId: call.id,
          campaignId,
          contactId: call.contact_id,
          campaignContactId: call.campaign_contact_id,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה בניסיון חוזר");
      }

      setRetried((prev) => new Set(prev).add(call.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(call.id);
        return next;
      });
    }
  }

  async function handleRetryAll() {
    for (const { call } of failedCalls) {
      if (!retried.has(call.id)) {
        await handleRetry(call);
      }
    }
  }

  return (
    <div>
      {failedCalls.length > 0 && (
        <div className="flex justify-end mb-4">
          <Button variant="secondary" size="sm" onClick={handleRetryAll}>
            נסה שוב הכל ({failedCalls.length - retried.size})
          </Button>
        </div>
      )}

      {error && (
        <p className="text-red-600 text-sm mb-4" role="alert">{error}</p>
      )}

      {failedCalls.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">אין שיחות שנכשלו</p>
      ) : (
        <div className="space-y-2">
          {failedCalls.map(({ call, contact }) => (
            <div
              key={call.id}
              className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3"
            >
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-sm font-medium">{contact.name ?? "ללא שם"}</p>
                  <p className="text-xs text-gray-400" dir="ltr">{formatPhoneDisplay(contact.phone)}</p>
                </div>
                <Badge
                  status={call.status}
                  label={callStatusLabels[call.status] ?? call.status}
                />
                <span className="text-xs text-gray-500">
                  {call.failure_reason ?? "סיבה לא ידועה"}
                </span>
                <span className="text-xs text-gray-400">
                  {formatDateTime(call.created_at)}
                </span>
              </div>

              <div>
                {retried.has(call.id) ? (
                  <span className="text-xs text-green-600 font-medium">נשלח מחדש</span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRetry(call)}
                    loading={retrying.has(call.id)}
                  >
                    נסה שוב
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
