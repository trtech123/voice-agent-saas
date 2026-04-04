"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils/format";
import { formatPhoneDisplay } from "@/lib/utils/phone-validator";
import type { CallTranscript, Call, Contact } from "@vam/database";

interface TranscriptRow {
  transcript: CallTranscript;
  call: Call;
  contact: Contact;
}

interface TabTranscriptsProps {
  transcripts: TranscriptRow[];
}

export function TabTranscripts({ transcripts }: TabTranscriptsProps) {
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return transcripts;
    const q = search.toLowerCase();
    return transcripts.filter(({ transcript, contact }) => {
      // Search in transcript text
      const hasMatch = transcript.transcript.some(
        (entry) => entry.text.toLowerCase().includes(q)
      );
      // Search by contact name or phone
      const nameMatch = contact.name?.toLowerCase().includes(q);
      const phoneMatch = contact.phone.includes(q);
      return hasMatch || nameMatch || phoneMatch;
    });
  }, [transcripts, search]);

  return (
    <div>
      <div className="mb-4">
        <Input
          id="transcript-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חפש בתמלולים, שמות או מספרי טלפון..."
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">
          {search ? "לא נמצאו תוצאות" : "אין תמלולים עדיין"}
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map(({ transcript, call, contact }) => (
            <div
              key={transcript.id}
              className="border border-gray-200 rounded-lg overflow-hidden"
            >
              <button
                onClick={() => setExpandedId(expandedId === transcript.id ? null : transcript.id)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-right"
              >
                <div className="flex items-center gap-3">
                  <div>
                    <span className="text-sm font-medium">{contact.name ?? "ללא שם"}</span>
                    <span className="text-xs text-gray-400 me-2" dir="ltr">
                      {formatPhoneDisplay(contact.phone)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{formatDateTime(call.created_at)}</span>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${expandedId === transcript.id ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {expandedId === transcript.id && (
                <div className="px-4 py-3 space-y-2 max-h-96 overflow-y-auto">
                  {transcript.transcript.map((entry, idx) => (
                    <div
                      key={idx}
                      className={`flex gap-2 ${entry.role === "agent" ? "" : "flex-row-reverse"}`}
                    >
                      <span className={`
                        text-xs font-medium px-2 py-0.5 rounded
                        ${entry.role === "agent"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-700"
                        }
                      `}>
                        {entry.role === "agent" ? "סוכן" : "לקוח"}
                      </span>
                      <p className="text-sm text-gray-700 flex-1">{entry.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
