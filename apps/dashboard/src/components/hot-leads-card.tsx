"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatPhoneDisplay } from "@/lib/utils/phone-validator";
import { leadStatusLabels } from "@/lib/utils/format";
import type { Call, Contact } from "@vam/database";

interface HotLead {
  call: Call;
  contact: Contact;
}

interface HotLeadsCardProps {
  leads: HotLead[];
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
      <h3 className="text-sm font-semibold text-gray-700 mb-3">לידים חמים</h3>
      <div className="space-y-3">
        {leads.map(({ call, contact }) => (
          <Link
            key={call.id}
            href={`/campaigns/${call.campaign_id}?tab=contacts&contact=${contact.id}`}
            className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-sm font-bold">
                {call.lead_score}
              </div>
              <div>
                <p className="text-sm font-medium">{contact.name ?? "ללא שם"}</p>
                <p className="text-xs text-gray-400" dir="ltr">{formatPhoneDisplay(contact.phone)}</p>
              </div>
            </div>
            <Badge
              status={call.lead_status ?? "cold"}
              label={leadStatusLabels[call.lead_status ?? "cold"]}
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
