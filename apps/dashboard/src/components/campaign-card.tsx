import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { campaignStatusLabels, formatDate } from "@/lib/utils/format";
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
    campaign.status === "active" ? "blue" :
    campaign.status === "paused" ? "yellow" : "blue";

  return (
    <Link
      href={`/campaigns/${campaign.id}`}
      className="block bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold">{campaign.name}</h3>
          <p className="text-xs text-gray-400 mt-0.5">נוצר {formatDate(campaign.created_at)}</p>
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
        label={`${contactCounts.completed}/${contactCounts.total} אנשי קשר`}
      />

      <div className="flex gap-4 mt-3 text-xs text-gray-500">
        <span>ממתינים: {contactCounts.pending}</span>
        <span>הושלמו: {contactCounts.completed}</span>
        <span>נכשלו: {contactCounts.failed}</span>
      </div>
    </Link>
  );
}
