"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { DashboardHotLead } from "@/lib/dashboard";
import { formatDateTime, leadStatusLabels } from "@/lib/utils/format";
import { formatPhoneDisplay } from "@/lib/utils/phone-validator";

interface HotLeadsCardProps {
  leads: DashboardHotLead[];
}

export function HotLeadsCard({ leads }: HotLeadsCardProps) {
  if (leads.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">לידים חמים</h3>
        <p className="text-sm text-gray-400 text-center py-6">אין לידים חמים עדיין</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-700">לידים חמים</h3>
        <p className="mt-1 text-xs text-gray-400">לקוחות ייחודיים עם עניין גבוה וההקשר האחרון שלהם.</p>
      </div>

      <div className="space-y-3">
        {leads.map((lead) => (
          <Link
            key={lead.leadId}
            href={`/campaigns/${lead.campaignId}?tab=contacts&contact=${lead.contact.id}`}
            className="block rounded-lg border border-transparent px-3 py-3 transition-colors hover:border-gray-200 hover:bg-gray-50"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-gray-900">{lead.contact.name ?? "ללא שם"}</p>
                  <Badge status={lead.leadStatus} label={leadStatusLabels[lead.leadStatus] ?? lead.leadStatus} />
                  <Badge status={lead.outcomeStatus} label={lead.outcomeLabel} />
                </div>

                <p className="mt-1 text-xs text-gray-400" dir="ltr">
                  {formatPhoneDisplay(lead.contact.phone)}
                </p>

                <p className="mt-2 text-xs leading-5 text-gray-600">{lead.summary}</p>

                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                  <span>{lead.attemptCount} ניסיונות</span>
                  <span>{formatDateTime(lead.latestCallAt)}</span>
                </div>
              </div>

              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-bold text-red-700">
                {lead.leadScore}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
