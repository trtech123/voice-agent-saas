"use client";

import { HotLeadsCard } from "@/components/hot-leads-card";
import { LiveCallFeed } from "@/components/live-call-feed";
import { PerformanceChart } from "@/components/performance-chart";
import type { DashboardHotLead } from "@/lib/dashboard";
import { useRealtimeCalls } from "@/lib/hooks/use-realtime-calls";

interface DashboardClientProps {
  tenantId: string;
  hotLeads: DashboardHotLead[];
  chartData: Array<{ label: string; answered: number; qualified: number; hot: number }>;
}

export function DashboardClient({ tenantId, hotLeads, chartData }: DashboardClientProps) {
  const recentCalls = useRealtimeCalls(tenantId);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <LiveCallFeed calls={recentCalls} />
      <HotLeadsCard leads={hotLeads} />
      <div className="lg:col-span-2">
        <PerformanceChart data={chartData} />
      </div>
    </div>
  );
}
