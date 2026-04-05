"use client";

import { Badge } from "@/components/ui/badge";
import type { DashboardConversation } from "@/lib/dashboard";
import { formatDateTime, formatDuration } from "@/lib/utils/format";
import { formatPhoneDisplay } from "@/lib/utils/phone-validator";

interface LiveCallFeedProps {
  calls: DashboardConversation[];
}

const statusDot: Record<string, string> = {
  initiated: "bg-gray-400",
  ringing: "bg-yellow-400 animate-pulse",
  connected: "bg-green-400 animate-pulse",
  completed: "bg-blue-400",
  failed: "bg-red-400",
  no_answer: "bg-yellow-400",
  dead_letter: "bg-red-600",
};

export function LiveCallFeed({ calls }: LiveCallFeedProps) {
  const activeCalls = calls.filter((call) => call.isLive).length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">שיחות אחרונות</h3>
          <p className="mt-1 text-xs text-gray-400">סטטוס, תוצאה, זמן וסיכום לכל שיחה.</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              activeCalls > 0 ? "bg-green-500 animate-pulse" : "bg-gray-300"
            }`}
          />
          <span className="text-xs text-gray-500">
            {activeCalls > 0 ? `${activeCalls} פעילות עכשיו` : "אין שיחות פעילות"}
          </span>
        </div>
      </div>

      {calls.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">אין שיחות אחרונות להצגה</p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {calls.map((call) => (
            <div
              key={call.conversationId}
              className={`rounded-lg border px-3 py-3 ${
                call.isLive
                  ? "border-emerald-200 bg-emerald-50/60"
                  : "border-gray-100 bg-gray-50"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    className={`mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                      statusDot[call.status] ?? "bg-gray-400"
                    }`}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">
                        {call.contact.name ?? "ללא שם"}
                      </p>
                      <Badge status={call.status} label={call.statusLabel} />
                      <Badge status={call.outcomeStatus} label={call.outcomeLabel} />
                    </div>

                    <p className="mt-1 text-xs text-gray-400" dir="ltr">
                      {formatPhoneDisplay(call.contact.phone)}
                    </p>

                    <p className="mt-2 text-xs text-gray-600">{call.summary}</p>

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                      <span>{formatDateTime(call.timestamp)}</span>
                      {call.startedAt && !call.isLive ? (
                        <span>התחילה {formatDateTime(call.startedAt)}</span>
                      ) : null}
                      {call.endedAt ? <span>נסגרה {formatDateTime(call.endedAt)}</span> : null}
                    </div>
                  </div>
                </div>

                <div className="flex-shrink-0 text-left">
                  {call.durationSeconds != null ? (
                    <span className="block text-xs text-gray-500" dir="ltr">
                      {formatDuration(call.durationSeconds)}
                    </span>
                  ) : (
                    <span className="block text-xs text-gray-400">--</span>
                  )}

                  {call.leadScore != null ? (
                    <span className="mt-1 inline-block text-xs font-bold text-blue-600">
                      {call.leadScore}/5
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
