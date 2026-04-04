"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { campaignStatusLabels, dayLabels } from "@/lib/utils/format";
import { createClient } from "@/lib/supabase-browser";
import type { Campaign } from "@vam/database";

interface TabSettingsProps {
  campaign: Campaign;
  onUpdate: (campaign: Campaign) => void;
}

export function TabSettings({ campaign, onUpdate }: TabSettingsProps) {
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(campaign.name);
  const [script, setScript] = useState(campaign.script);

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
      })
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

    const endpoint = campaign.status === "active"
      ? "/api/campaigns/pause"
      : "/api/campaigns/resume";

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

  return (
    <div className="space-y-6">
      {/* Status + actions */}
      <div className="flex items-center justify-between bg-gray-50 rounded-lg p-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">סטטוס:</span>
          <Badge
            status={campaign.status}
            label={campaignStatusLabels[campaign.status]}
          />
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
        <p className="text-red-600 text-sm" role="alert">{error}</p>
      )}

      {/* Edit fields */}
      <div className="space-y-4">
        <Input
          id="edit-name"
          label="שם הקמפיין"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div>
          <label htmlFor="edit-script" className="block text-sm font-medium text-gray-700 mb-1">
            סקריפט
          </label>
          <textarea
            id="edit-script"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={6}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <Button onClick={handleSave} loading={saving}>
          שמור שינויים
        </Button>
      </div>

      {/* Current schedule display */}
      <div className="border-t border-gray-200 pt-4">
        <h3 className="text-sm font-medium text-gray-700 mb-2">תזמון נוכחי</h3>
        <p className="text-sm text-gray-600">
          ימים: {campaign.schedule_days.map((d) => dayLabels[d] ?? d).join(", ")}
        </p>
        <p className="text-sm text-gray-600" dir="ltr">
          חלונות: {campaign.schedule_windows.map((w: any) => `${w.start}\u2013${w.end}`).join(", ")}
        </p>
        <p className="text-sm text-gray-600 mt-1">
          {campaign.max_concurrent_calls} שיחות במקביל | {campaign.max_retry_attempts} ניסיונות חוזרים | {campaign.retry_delay_minutes} דקות המתנה
        </p>
      </div>
    </div>
  );
}
