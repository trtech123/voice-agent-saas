"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface TelephonyFormProps {
  hasCredentials: boolean;
}

export function TelephonyForm({ hasCredentials }: TelephonyFormProps) {
  const [callerId, setCallerId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/settings/telephony", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caller_id: callerId, api_key: apiKey }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה");
      }

      setSuccess(true);
      setCallerId("");
      setApiKey("");
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
          <p className="text-sm text-green-700">פרטי Voicenter מוגדרים. עדכן כדי להחליף.</p>
        </div>
      )}

      <Input
        id="voicenter-caller-id"
        label="Caller ID"
        value={callerId}
        onChange={(e) => setCallerId(e.target.value)}
        placeholder="972-50-123-4567"
        dir="ltr"
      />

      <Input
        id="voicenter-api-key"
        label="מפתח API"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="vc_..."
        dir="ltr"
        hint="המפתח יוצפן ויישמר בצורה מאובטחת"
      />

      {error && <p className="text-red-600 text-sm" role="alert">{error}</p>}
      {success && <p className="text-green-600 text-sm">נשמר בהצלחה</p>}

      <Button onClick={handleSave} loading={saving}>
        שמור פרטי Voicenter
      </Button>
    </div>
  );
}
