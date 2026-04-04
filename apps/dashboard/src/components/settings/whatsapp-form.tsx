"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface WhatsAppFormProps {
  hasCredentials: boolean;
}

export function WhatsAppForm({ hasCredentials }: WhatsAppFormProps) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/settings/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: phoneNumberId, access_token: accessToken }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה");
      }

      setSuccess(true);
      setPhoneNumberId("");
      setAccessToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-lg">
      {hasCredentials && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-sm text-green-700">חשבון WhatsApp Business מוגדר. עדכן כדי להחליף.</p>
        </div>
      )}

      <Input
        id="whatsapp-phone-id"
        label="Phone Number ID"
        value={phoneNumberId}
        onChange={(e) => setPhoneNumberId(e.target.value)}
        placeholder="1234567890"
        dir="ltr"
      />

      <Input
        id="whatsapp-access-token"
        label="Access Token"
        type="password"
        value={accessToken}
        onChange={(e) => setAccessToken(e.target.value)}
        placeholder="EAAx..."
        dir="ltr"
        hint="הטוקן יוצפן ויישמר בצורה מאובטחת"
      />

      {error && <p className="text-red-600 text-sm" role="alert">{error}</p>}
      {success && <p className="text-green-600 text-sm">נשמר בהצלחה</p>}

      <Button onClick={handleSave} loading={saving}>
        שמור פרטי WhatsApp
      </Button>
    </div>
  );
}
