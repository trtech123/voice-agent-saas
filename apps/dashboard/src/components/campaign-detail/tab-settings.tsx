"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { campaignStatusLabels, dayLabels } from "@/lib/utils/format";
import { createClient } from "@/lib/supabase-browser";
import {
  DEFAULT_WEBHOOK_PAYLOAD_EXAMPLE,
  WEBHOOK_SECRET_HEADER,
} from "@/lib/webhooks/constants";
import type { Campaign } from "@vam/database";

interface TabSettingsProps {
  campaign: Campaign;
  onUpdate: (campaign: Campaign) => void;
}

export function TabSettings({ campaign, onUpdate }: TabSettingsProps) {
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [rotatingWebhook, setRotatingWebhook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(campaign.name);
  const [script, setScript] = useState(campaign.script);
  const [webhookEnabled, setWebhookEnabled] = useState(campaign.webhook_enabled);
  const [webhookSourceLabel, setWebhookSourceLabel] = useState(
    campaign.webhook_source_label ?? "Facebook Lead Ads"
  );
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setName(campaign.name);
    setScript(campaign.script);
    setWebhookEnabled(campaign.webhook_enabled);
    setWebhookSourceLabel(campaign.webhook_source_label ?? "Facebook Lead Ads");
  }, [campaign]);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const webhookEndpoint = useMemo(() => {
    const path = `/api/webhooks/campaigns/${campaign.id}/lead`;
    return origin ? `${origin}${path}` : path;
  }, [campaign.id, origin]);

  const webhookPayloadExample = useMemo(
    () =>
      JSON.stringify(
        campaign.webhook_payload_example ?? DEFAULT_WEBHOOK_PAYLOAD_EXAMPLE,
        null,
        2
      ),
    [campaign.webhook_payload_example]
  );

  async function handleSave() {
    setSaving(true);
    setError(null);

    const supabase = createClient();
    const { data, error: updateError } = await supabase
      .from("campaigns")
      .update({
        name,
        script,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", campaign.id)
      .select()
      .single();

    if (updateError) {
      setError("שגיאה בשמירה");
    } else if (data) {
      onUpdate(data);
    }
    setSaving(false);
  }

  async function handlePauseResume() {
    setPausing(true);
    setError(null);

    const endpoint = campaign.status === "active" ? "/api/campaigns/pause" : "/api/campaigns/resume";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: campaign.id }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה");
      }

      const { campaign: updated } = await res.json();
      onUpdate(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setPausing(false);
    }
  }

  async function handleWebhookSettingsSave() {
    setSavingWebhook(true);
    setError(null);

    try {
      const res = await fetch("/api/campaigns/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          campaignId: campaign.id,
          webhookEnabled,
          webhookSourceLabel,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה בשמירת הוובהוק");
      }

      const { campaign: updated } = await res.json();
      onUpdate(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setSavingWebhook(false);
    }
  }

  async function handleRotateWebhookSecret() {
    setRotatingWebhook(true);
    setError(null);
    setRevealedSecret(null);

    try {
      const res = await fetch("/api/campaigns/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rotate",
          campaignId: campaign.id,
          webhookSourceLabel,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה ביצירת Secret חדש");
      }

      const { campaign: updated, secret } = await res.json();
      onUpdate(updated);
      setWebhookEnabled(true);
      setRevealedSecret(secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setRotatingWebhook(false);
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("לא הצלחנו להעתיק ללוח");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">סטטוס:</span>
          <Badge status={campaign.status} label={campaignStatusLabels[campaign.status]} />
        </div>
        {(campaign.status === "active" || campaign.status === "paused") && (
          <Button
            variant={campaign.status === "active" ? "secondary" : "primary"}
            onClick={handlePauseResume}
            loading={pausing}
          >
            {campaign.status === "active" ? "השהה קמפיין" : "חדש קמפיין"}
          </Button>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="space-y-4">
        <Input
          id="edit-name"
          label="שם הקמפיין"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div>
          <label htmlFor="edit-script" className="mb-1 block text-sm font-medium text-gray-700">
            סקריפט
          </label>
          <textarea
            id="edit-script"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <Button onClick={handleSave} loading={saving}>
          שמור שינויים
        </Button>
      </div>

      <div className="border-t border-gray-200 pt-4">
        <h3 className="mb-2 text-sm font-medium text-gray-700">תזמון נוכחי</h3>
        <p className="text-sm text-gray-600">
          ימים: {campaign.schedule_days.map((day) => dayLabels[day] ?? day).join(", ")}
        </p>
        <p className="text-sm text-gray-600" dir="ltr">
          חלונות: {campaign.schedule_windows.map((window) => `${window.start}-${window.end}`).join(", ")}
        </p>
        <p className="mt-1 text-sm text-gray-600">
          {campaign.max_concurrent_calls} שיחות במקביל | {campaign.max_retry_attempts} ניסיונות חוזרים |{" "}
          {campaign.retry_delay_minutes} דקות המתנה
        </p>
      </div>

      <div className="space-y-4 border-t border-gray-200 pt-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-gray-700">Webhook / Facebook Leads</h3>
            <p className="mt-1 text-sm text-gray-500">
              Make.com יכול לשלוח לידים חדשים ישירות לקמפיין הזה ולהכניס אותם מייד לתור השיחות.
            </p>
          </div>
          <Badge
            status={campaign.webhook_enabled ? "active" : "draft"}
            label={campaign.webhook_enabled ? "פעיל" : "כבוי"}
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            id="webhook-enabled"
            type="checkbox"
            checked={webhookEnabled}
            onChange={(e) => setWebhookEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <label htmlFor="webhook-enabled" className="text-sm text-gray-700">
            לאפשר קבלת לידים חיצוניים לקמפיין הזה
          </label>
        </div>

        <Input
          id="webhook-source-label"
          label="תווית מקור"
          value={webhookSourceLabel}
          onChange={(e) => setWebhookSourceLabel(e.target.value)}
          hint="לדוגמה: Facebook Lead Ads, Make.com או שם משפך השיווק."
        />

        <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-end gap-3">
            <Input id="webhook-endpoint" label="Webhook URL" value={webhookEndpoint} readOnly />
            <Button type="button" variant="secondary" onClick={() => handleCopy(webhookEndpoint)}>
              העתק URL
            </Button>
          </div>

          <div className="flex items-end gap-3">
            <Input id="webhook-header" label="Header Required" value={WEBHOOK_SECRET_HEADER} readOnly />
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleCopy(WEBHOOK_SECRET_HEADER)}
            >
              העתק Header
            </Button>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={handleWebhookSettingsSave} loading={savingWebhook}>
              שמור הגדרות וובהוק
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleRotateWebhookSecret}
              loading={rotatingWebhook}
            >
              {campaign.webhook_secret_hash ? "סובב Secret" : "צור Secret"}
            </Button>
          </div>
        </div>

        {revealedSecret && (
          <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-amber-900">Secret חדש</p>
                <p className="text-sm text-amber-800">
                  הסוד מוצג רק עכשיו. העתיקו אותו ל-Make.com לפני שתעברו למסך אחר.
                </p>
              </div>
              <Button type="button" variant="secondary" onClick={() => handleCopy(revealedSecret)}>
                העתק Secret
              </Button>
            </div>
            <code className="block overflow-x-auto rounded bg-white px-3 py-2 text-xs text-gray-800" dir="ltr">
              {revealedSecret}
            </code>
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-gray-200 p-4">
          <div>
            <h4 className="text-sm font-medium text-gray-700">דוגמת Payload ל-Make.com</h4>
            <p className="mt-1 text-sm text-gray-500">
              יש למפות את שדות Facebook Lead Ads למבנה הבא לפני השליחה לוובהוק.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100" dir="ltr">
            {webhookPayloadExample}
          </pre>
        </div>
      </div>
    </div>
  );
}
