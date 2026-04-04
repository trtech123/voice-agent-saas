"use client";

interface ChartData {
  label: string;
  answered: number;
  qualified: number;
  hot: number;
}

interface PerformanceChartProps {
  data: ChartData[];
}

export function PerformanceChart({ data }: PerformanceChartProps) {
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">ביצועים</h3>
        <p className="text-sm text-gray-400 text-center py-8">אין מספיק נתונים להצגה</p>
      </div>
    );
  }

  // Find max value for scaling
  const maxVal = Math.max(...data.flatMap((d) => [d.answered, d.qualified, d.hot]), 1);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">ביצועים</h3>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-blue-500" />
          <span className="text-xs text-gray-600">ענו</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-green-500" />
          <span className="text-xs text-gray-600">הוסמכו</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-red-500" />
          <span className="text-xs text-gray-600">חמים</span>
        </div>
      </div>

      {/* Simple bar chart using CSS */}
      <div className="space-y-3">
        {data.map((item) => (
          <div key={item.label} className="space-y-1">
            <p className="text-xs text-gray-500">{item.label}</p>
            <div className="flex items-center gap-2 h-5">
              <div className="flex gap-0.5 flex-1 h-full">
                <div
                  className="bg-blue-500 rounded-sm transition-all duration-300"
                  style={{ width: `${(item.answered / maxVal) * 100}%` }}
                  title={`ענו: ${item.answered}`}
                />
                <div
                  className="bg-green-500 rounded-sm transition-all duration-300"
                  style={{ width: `${(item.qualified / maxVal) * 100}%` }}
                  title={`הוסמכו: ${item.qualified}`}
                />
                <div
                  className="bg-red-500 rounded-sm transition-all duration-300"
                  style={{ width: `${(item.hot / maxVal) * 100}%` }}
                  title={`חמים: ${item.hot}`}
                />
              </div>
              <span className="text-xs text-gray-400 min-w-[3ch] text-left" dir="ltr">
                {item.answered}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
