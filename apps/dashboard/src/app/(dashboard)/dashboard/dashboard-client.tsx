"use client";

import { HotLeadsCard } from "@/components/hot-leads-card";
import { LiveCallFeed } from "@/components/live-call-feed";
import { PerformanceChart } from "@/components/performance-chart";
import { useRealtimeCalls } from "@/lib/hooks/use-realtime-calls";
import type { Call, Contact } from "@vam/database";

interface DashboardClientProps {
  tenantId: string;
  hotLeads: Array<{ call: Call; contact: Contact }>;
  chartData: Array<{ label: string; answered: number; qualified: number; hot: number }>;
}

export function DashboardClient({ tenantId, hotLeads, chartData }: DashboardClientProps) {
  const liveCalls = useRealtimeCalls(tenantId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Live call feed */}
      <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5">
        <h2 className="text-lg font-semibold text-[#1E1B4B] mb-4">שיחות בזמן אמת</h2>
        <LiveCallFeed calls={liveCalls} />
      </div>

      {/* Hot leads */}
      <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5">
        <h2 className="text-lg font-semibold text-[#1E1B4B] mb-4">לידים חמים</h2>
        <HotLeadsCard leads={hotLeads} />
      </div>

      {/* Performance chart */}
      <div className="lg:col-span-2 bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5">
        <h2 className="text-lg font-semibold text-[#1E1B4B] mb-4">ביצועים</h2>
        <PerformanceChart data={chartData} />
      </div>
    </div>
  );
}
