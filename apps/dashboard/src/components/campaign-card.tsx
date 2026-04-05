import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { campaignStatusLabels, formatDate } from "@/lib/utils/format";
import { Users, Calendar } from "lucide-react";
import type { Campaign } from "@vam/database";

interface CampaignCardProps {
  campaign: Campaign;
  contactCounts: {
    total: number;
    completed: number;
    pending: number;
    failed: number;
  };
}

export function CampaignCard({ campaign, contactCounts }: CampaignCardProps) {
  const progressColor =
    campaign.status === "completed" ? "green" :
    campaign.status === "paused" ? "amber" : "indigo";

  return (
    <Link
      href={`/campaigns/${campaign.id}`}
      className="block bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5 cursor-pointer transition-all duration-200 hover:shadow-lg hover:scale-[1.01] focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:ring-offset-2"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-[#1E1B4B]">{campaign.name}</h3>
          <div className="flex items-center gap-1.5 mt-1 text-xs text-[#1E1B4B]/40">
            <Calendar className="w-3.5 h-3.5" />
            <span>{formatDate(campaign.created_at)}</span>
          </div>
        </div>
        <Badge
          status={campaign.status}
          label={campaignStatusLabels[campaign.status]}
        />
      </div>

      <ProgressBar
        value={contactCounts.completed}
        max={contactCounts.total}
        color={progressColor}
        showPercentage
      />

      <div className="flex items-center gap-4 mt-3 text-xs text-[#1E1B4B]/50">
        <span className="flex items-center gap-1">
          <Users className="w-3.5 h-3.5" />
          {contactCounts.total} אנשי קשר
        </span>
        <span>ממתינים: {contactCounts.pending}</span>
        <span>הושלמו: {contactCounts.completed}</span>
        <span>נכשלו: {contactCounts.failed}</span>
      </div>
    </Link>
  );
}
