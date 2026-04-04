"use client";

import { Badge } from "@/components/ui/badge";
import { callStatusLabels, formatDuration, formatDateTime } from "@/lib/utils/format";
import type { Call } from "@vam/database";

interface LiveCallFeedProps {
  calls: Call[];
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
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">שיחות בזמן אמת</h3>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-gray-500">חי</span>
        </div>
      </div>

      {calls.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">אין שיחות פעילות</p>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {calls.map((call) => (
            <div
              key={call.id}
              className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusDot[call.status] ?? "bg-gray-400"}`} />
                <div>
                  <p className="text-sm font-medium">
                    <Badge
                      status={call.status}
                      label={callStatusLabels[call.status] ?? call.status}
                    />
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatDateTime(call.created_at)}
                  </p>
                </div>
              </div>
              <div className="text-left">
                {call.duration_seconds != null && (
                  <span className="text-xs text-gray-500" dir="ltr">
                    {formatDuration(call.duration_seconds)}
                  </span>
                )}
                {call.lead_score != null && (
                  <span className="text-xs font-bold text-blue-600 ms-2">
                    {call.lead_score}/5
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
