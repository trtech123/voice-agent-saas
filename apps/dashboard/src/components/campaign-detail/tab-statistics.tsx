"use client";

import { ProgressBar } from "@/components/ui/progress-bar";
import { formatNumber } from "@/lib/utils/format";

interface TabStatisticsProps {
  stats: {
    total: number;
    called: number;
    answered: number;
    qualified: number;
    hot: number;
    warm: number;
    cold: number;
    notInterested: number;
    noAnswer: number;
    failed: number;
  };
}

export function TabStatistics({ stats }: TabStatisticsProps) {
  const funnelSteps = [
    { label: 'סה"כ אנשי קשר', value: stats.total, color: "blue" as const },
    { label: "התקשרו", value: stats.called, color: "blue" as const },
    { label: "ענו", value: stats.answered, color: "green" as const },
    { label: "הוסמכו", value: stats.qualified, color: "green" as const },
    { label: "לידים חמים", value: stats.hot, color: "red" as const },
  ];

  return (
    <div className="space-y-8">
      {/* Conversion funnel */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-4">משפך המרה</h3>
        <div className="space-y-3">
          {funnelSteps.map((step) => (
            <div key={step.label}>
              <ProgressBar
                value={step.value}
                max={stats.total}
                label={`${step.label}: ${formatNumber(step.value)}`}
                color={step.color}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Lead breakdown */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-4">פילוח לידים</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {[
            { label: "חמים", value: stats.hot, bg: "bg-red-50 text-red-700" },
            { label: "חמימים", value: stats.warm, bg: "bg-yellow-50 text-yellow-700" },
            { label: "קרים", value: stats.cold, bg: "bg-blue-50 text-blue-700" },
            { label: "לא מעוניינים", value: stats.notInterested, bg: "bg-gray-50 text-gray-700" },
            { label: "לא ענו", value: stats.noAnswer, bg: "bg-yellow-50 text-yellow-700" },
          ].map((item) => (
            <div key={item.label} className={`rounded-lg p-3 text-center ${item.bg}`}>
              <p className="text-2xl font-bold">{formatNumber(item.value)}</p>
              <p className="text-xs mt-1">{item.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Answer rate */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">שיעורים</h3>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <p className="text-xl font-bold">
              {stats.called > 0 ? Math.round((stats.answered / stats.called) * 100) : 0}%
            </p>
            <p className="text-xs text-gray-500 mt-1">שיעור מענה</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <p className="text-xl font-bold">
              {stats.answered > 0 ? Math.round((stats.qualified / stats.answered) * 100) : 0}%
            </p>
            <p className="text-xs text-gray-500 mt-1">שיעור הסמכה</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <p className="text-xl font-bold">
              {stats.answered > 0 ? Math.round((stats.hot / stats.answered) * 100) : 0}%
            </p>
            <p className="text-xs text-gray-500 mt-1">שיעור לידים חמים</p>
          </div>
        </div>
      </div>
    </div>
  );
}
