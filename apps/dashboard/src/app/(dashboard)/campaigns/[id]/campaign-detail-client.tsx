"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabList, TabTrigger, TabContent } from "@/components/ui/tabs";
import { TabStatistics } from "@/components/campaign-detail/tab-statistics";
import { TabContacts } from "@/components/campaign-detail/tab-contacts";
import { TabTranscripts } from "@/components/campaign-detail/tab-transcripts";
import { TabFailed } from "@/components/campaign-detail/tab-failed";
import { TabSettings } from "@/components/campaign-detail/tab-settings";
import { campaignStatusLabels } from "@/lib/utils/format";
import type { Campaign, CampaignContact, Contact, Call, CallTranscript } from "@vam/database";

interface CampaignDetailClientProps {
  campaign: Campaign;
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
  contacts: Array<{
    campaignContact: CampaignContact;
    contact: Contact;
    call: Call | null;
  }>;
  failedCalls: Array<{
    call: Call;
    contact: Contact;
  }>;
  transcripts: Array<{
    transcript: CallTranscript;
    call: Call;
    contact: Contact;
  }>;
}

export function CampaignDetailClient({
  campaign: initialCampaign,
  stats,
  contacts,
  failedCalls,
  transcripts,
}: CampaignDetailClientProps) {
  const [campaign, setCampaign] = useState(initialCampaign);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
        <Link href="/campaigns" className="hover:text-gray-700">קמפיינים</Link>
        <span>/</span>
        <span>{campaign.name}</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{campaign.name}</h1>
          <Badge
            status={campaign.status}
            label={campaignStatusLabels[campaign.status]}
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultTab="statistics">
        <TabList>
          <TabTrigger value="statistics">סטטיסטיקות</TabTrigger>
          <TabTrigger value="contacts">אנשי קשר ({stats.total})</TabTrigger>
          <TabTrigger value="transcripts">תמלולים</TabTrigger>
          <TabTrigger value="failed">
            נכשלו
            {stats.failed > 0 && (
              <span className="bg-red-100 text-red-700 rounded-full px-1.5 py-0.5 text-xs font-bold ms-1">
                {stats.failed}
              </span>
            )}
          </TabTrigger>
          <TabTrigger value="settings">הגדרות</TabTrigger>
        </TabList>

        <TabContent value="statistics">
          <TabStatistics stats={stats} />
        </TabContent>

        <TabContent value="contacts">
          <TabContacts contacts={contacts} />
        </TabContent>

        <TabContent value="transcripts">
          <TabTranscripts transcripts={transcripts} />
        </TabContent>

        <TabContent value="failed">
          <TabFailed failedCalls={failedCalls} campaignId={campaign.id} />
        </TabContent>

        <TabContent value="settings">
          <TabSettings campaign={campaign} onUpdate={setCampaign} />
        </TabContent>
      </Tabs>
    </div>
  );
}
