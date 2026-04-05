"use client";

import { useState, useCallback } from "react";
import { Modal } from "@/components/ui/modal";
import { Phone, User, Loader2, CheckCircle2 } from "lucide-react";

interface QuickCallModalProps {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName: string;
}

export function QuickCallModal({
  open,
  onClose,
  campaignId,
  campaignName,
}: QuickCallModalProps) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [contactName, setContactName] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!phoneNumber.trim()) {
      setError("יש להזין מספר טלפון");
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
        onClose();
      }, 1500);
    } catch {
      setError("שגיאת רשת — נסה שוב");
    } finally {
      setLoading(false);
    }
  }, [phoneNumber, contactName, campaignId, onClose]);

  const handleClose = useCallback(() => {
    if (loading) return;
    setError(null);
    setSuccess(false);
    onClose();
  }, [loading, onClose]);

  return (
    <Modal open={open} onClose={handleClose} title="שיחה מהירה" size="sm">
      <div className="space-y-4">
        {/* Campaign name display */}
        <div className="bg-indigo-50/60 rounded-lg px-4 py-3 border border-indigo-100/50">
          <p className="text-xs text-[#1E1B4B]/50 mb-0.5">קמפיין</p>
          <p className="text-sm font-semibold text-[#1E1B4B]">{campaignName}</p>
        </div>

        {/* Phone number input */}
        <div>
          <label
            htmlFor="quick-call-phone"
            className="block text-sm font-medium text-[#1E1B4B]/70 mb-1.5"
          >
            מספר טלפון
          </label>
          <div className="relative">
            <Phone className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E1B4B]/30" />
            <input
              id="quick-call-phone"
              type="tel"
              dir="ltr"
              placeholder="050-1234567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              disabled={loading || success}
              className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-white/40 bg-white/60 text-[#1E1B4B] placeholder:text-[#1E1B4B]/30 focus:outline-none focus:ring-2 focus:ring-indigo-300/50 focus:border-indigo-300 transition-all duration-200 disabled:opacity-50 text-left"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
            />
          </div>
        </div>

        {/* Contact name input */}
        <div>
          <label
            htmlFor="quick-call-name"
            className="block text-sm font-medium text-[#1E1B4B]/70 mb-1.5"
          >
            שם איש קשר
            <span className="text-[#1E1B4B]/30 me-1">(אופציונלי)</span>
          </label>
          <div className="relative">
            <User className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E1B4B]/30" />
            <input
              id="quick-call-name"
              type="text"
              placeholder="ישראל ישראלי"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              disabled={loading || success}
              className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-white/40 bg-white/60 text-[#1E1B4B] placeholder:text-[#1E1B4B]/30 focus:outline-none focus:ring-2 focus:ring-indigo-300/50 focus:border-indigo-300 transition-all duration-200 disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
            />
          </div>
        </div>

        {/* Error message */}
        {error && (
          <p className="text-sm text-red-600 bg-red-50/60 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {/* CTA button */}
        <button
          onClick={handleSubmit}
          disabled={loading || success || !phoneNumber.trim()}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white transition-all duration-200 cursor-pointer disabled:cursor-not-allowed bg-[#10B981] hover:bg-[#059669] active:scale-[0.98] disabled:opacity-60 disabled:hover:bg-[#10B981]"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>מתקשר...</span>
            </>
          ) : success ? (
            <>
              <CheckCircle2 className="w-5 h-5" />
              <span>השיחה נשלחה!</span>
            </>
          ) : (
            <>
              <Phone className="w-5 h-5" />
              <span>התקשר</span>
            </>
          )}
        </button>
      </div>
    </Modal>
  );
}
