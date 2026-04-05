"use client";

import { useState, useCallback, useEffect } from "react";
import { Phone, User, Megaphone, Loader2, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase-browser";

interface Campaign {
  id: string;
  name: string;
  status: string;
}

export function QuickCallCard() {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [contactName, setContactName] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch active campaigns on mount
  useEffect(() => {
    async function fetchCampaigns() {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("campaigns")
          .select("id, name, status")
          .in("status", ["active", "draft"])
          .order("created_at", { ascending: false });

        const list = data ?? [];
        setCampaigns(list);
        if (list.length > 0) {
          setCampaignId(list[0].id);
        }
      } catch {
        // Silently fail — card just won't show campaigns
      } finally {
        setLoadingCampaigns(false);
      }
    }
    fetchCampaigns();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!phoneNumber.trim()) {
      setError("יש להזין מספר טלפון");
      return;
    }
    if (!campaignId) {
      setError("יש לבחור קמפיין");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/calls/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phoneNumber.trim(),
          contactName: contactName.trim() || undefined,
          campaignId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "שגיאה לא צפויה");
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        setPhoneNumber("");
        setContactName("");
      }, 2000);
    } catch {
      setError("שגיאת רשת — נסה שוב");
    } finally {
      setLoading(false);
    }
  }, [phoneNumber, contactName, campaignId]);

  if (loadingCampaigns) {
    return (
      <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-10 h-10 rounded-xl bg-emerald-100/80 flex items-center justify-center">
            <Phone className="w-5 h-5 text-emerald-500" />
          </div>
          <h2 className="text-lg font-semibold text-[#1E1B4B]">שיחה מהירה</h2>
        </div>
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-[#1E1B4B]/30" />
        </div>
      </div>
    );
  }

  if (campaigns.length === 0) return null;

  return (
    <div className="bg-white/80 backdrop-blur-sm border border-emerald-200/40 rounded-xl shadow-md p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-10 h-10 rounded-xl bg-emerald-100/80 flex items-center justify-center">
          <Phone className="w-5 h-5 text-emerald-500" />
        </div>
        <h2 className="text-lg font-semibold text-[#1E1B4B]">שיחה מהירה</h2>
      </div>

      <div className="space-y-3">
        {/* Campaign selector */}
        <div className="relative">
          <Megaphone className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E1B4B]/30 pointer-events-none" />
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            disabled={loading || success}
            className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-white/40 bg-white/60 text-[#1E1B4B] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300/50 focus:border-indigo-300 transition-all duration-200 disabled:opacity-50 appearance-none cursor-pointer"
            aria-label="בחירת קמפיין"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Phone number */}
        <div className="relative">
          <Phone className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E1B4B]/30" />
          <input
            type="tel"
            dir="ltr"
            placeholder="050-1234567"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            disabled={loading || success}
            className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-white/40 bg-white/60 text-[#1E1B4B] text-sm placeholder:text-[#1E1B4B]/30 focus:outline-none focus:ring-2 focus:ring-indigo-300/50 focus:border-indigo-300 transition-all duration-200 disabled:opacity-50 text-left"
            aria-label="מספר טלפון"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
        </div>

        {/* Contact name */}
        <div className="relative">
          <User className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E1B4B]/30" />
          <input
            type="text"
            placeholder="שם (אופציונלי)"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            disabled={loading || success}
            className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-white/40 bg-white/60 text-[#1E1B4B] text-sm placeholder:text-[#1E1B4B]/30 focus:outline-none focus:ring-2 focus:ring-indigo-300/50 focus:border-indigo-300 transition-all duration-200 disabled:opacity-50"
            aria-label="שם איש קשר"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
        </div>

        {/* Error */}
        {error && (
          <p className="text-xs text-red-600 bg-red-50/60 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {/* CTA */}
        <button
          onClick={handleSubmit}
          disabled={loading || success || !phoneNumber.trim() || !campaignId}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-white text-sm transition-all duration-200 cursor-pointer disabled:cursor-not-allowed bg-[#10B981] hover:bg-[#059669] active:scale-[0.98] disabled:opacity-60 disabled:hover:bg-[#10B981]"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>מתקשר...</span>
            </>
          ) : success ? (
            <>
              <CheckCircle2 className="w-4 h-4" />
              <span>השיחה נשלחה!</span>
            </>
          ) : (
            <>
              <Phone className="w-4 h-4" />
              <span>התקשר עכשיו</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
