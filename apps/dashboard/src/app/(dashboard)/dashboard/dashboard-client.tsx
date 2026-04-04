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
      <LiveCallFeed calls={liveCalls} />
      <HotLeadsCard leads={hotLeads} />
      <div className="lg:col-span-2">
        <PerformanceChart data={chartData} />
      </div>
    </div>
  );
}
