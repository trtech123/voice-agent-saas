"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { AudioPlayer } from "@/components/ui/audio-player";
import { contactStatusLabels, leadStatusLabels, formatDuration } from "@/lib/utils/format";
import { formatPhoneDisplay } from "@/lib/utils/phone-validator";
import { createClient } from "@/lib/supabase-browser";
import type { CampaignContact, Contact, Call } from "@vam/database";

interface ContactRow {
  campaignContact: CampaignContact;
  contact: Contact;
  call: Call | null;
}

interface TabContactsProps {
  contacts: ContactRow[];
}

export function TabContacts({ contacts }: TabContactsProps) {
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  async function getRecordingUrl(recordingPath: string, callId: string) {
    if (signedUrls[callId]) return;

    const supabase = createClient();
    const { data } = await supabase.storage
      .from("recordings")
      .createSignedUrl(recordingPath, 900); // 15-min expiry

    if (data?.signedUrl) {
      setSignedUrls((prev) => ({ ...prev, [callId]: data.signedUrl }));
    }
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="text-right py-3 px-4 font-medium">שם</th>
              <th className="text-right py-3 px-4 font-medium">טלפון</th>
              <th className="text-right py-3 px-4 font-medium">סטטוס</th>
              <th className="text-right py-3 px-4 font-medium">ציון</th>
              <th className="text-right py-3 px-4 font-medium">ניסיונות</th>
              <th className="text-right py-3 px-4 font-medium">משך</th>
              <th className="text-right py-3 px-4 font-medium">הקלטה</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map(({ campaignContact, contact, call }) => (
              <tr
                key={campaignContact.id}
                className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <td className="py-3 px-4 font-medium">{contact.name ?? "--"}</td>
                <td className="py-3 px-4" dir="ltr">{formatPhoneDisplay(contact.phone)}</td>
                <td className="py-3 px-4">
                  <Badge
                    status={campaignContact.status}
                    label={contactStatusLabels[campaignContact.status]}
                  />
                </td>
                <td className="py-3 px-4">
                  {call?.lead_score != null ? (
                    <div className="flex items-center gap-1">
                      <span className="font-bold">{call.lead_score}/5</span>
                      {call.lead_status && (
                        <Badge
                          status={call.lead_status}
                          label={leadStatusLabels[call.lead_status]}
                        />
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-400">--</span>
                  )}
                </td>
                <td className="py-3 px-4">{campaignContact.attempt_count}</td>
                <td className="py-3 px-4" dir="ltr">
                  {call?.duration_seconds != null ? formatDuration(call.duration_seconds) : "--"}
                </td>
                <td className="py-3 px-4">
                  {call?.recording_path ? (
                    <div>
                      {signedUrls[call.id] ? (
                        <AudioPlayer src={signedUrls[call.id]} label={`הקלטה של ${contact.name}`} />
                      ) : (
                        <button
                          onClick={() => getRecordingUrl(call.recording_path!, call.id)}
                          className="text-blue-600 hover:underline text-xs"
                        >
                          נגן הקלטה
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-400 text-xs">--</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {contacts.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-8">אין אנשי קשר בקמפיין</p>
      )}
    </div>
  );
}
