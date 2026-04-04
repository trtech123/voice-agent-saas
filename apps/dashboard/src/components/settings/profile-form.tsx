"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase-browser";
import type { Tenant } from "@vam/database";

interface ProfileFormProps {
  tenant: Tenant;
}

const businessTypes = [
  { value: "real_estate", label: 'נדל"ן' },
  { value: "insurance", label: "ביטוח" },
  { value: "services", label: "שירותי בית" },
  { value: "general", label: "כללי" },
];

export function ProfileForm({ tenant }: ProfileFormProps) {
  const [name, setName] = useState(tenant.name);
  const [email, setEmail] = useState(tenant.email);
  const [phone, setPhone] = useState(tenant.phone ?? "");
  const [businessType, setBusinessType] = useState(tenant.business_type);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("tenants")
      .update({
        name,
        email,
        phone: phone || null,
        business_type: businessType,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tenant.id);

    if (updateError) {
      setError("שגיאה בשמירת הפרופיל");
    } else {
      setSuccess(true);
    }
    setSaving(false);
  }

  return (
    <div className="space-y-4 max-w-lg">
      <Input
        id="business-name"
        label="שם העסק"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <Input
        id="business-email"
        label="אימייל"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        dir="ltr"
        required
      />

      <Input
        id="business-phone"
        label="טלפון"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        dir="ltr"
      />

      <div>
        <label htmlFor="business-type" className="block text-sm font-medium text-gray-700 mb-1">
          סוג עסק
        </label>
        <select
          id="business-type"
          value={businessType}
          onChange={(e) => setBusinessType(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {businessTypes.map((bt) => (
            <option key={bt.value} value={bt.value}>{bt.label}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-600 text-sm" role="alert">{error}</p>}
      {success && <p className="text-green-600 text-sm">נשמר בהצלחה</p>}

      <Button onClick={handleSave} loading={saving}>
        שמור
      </Button>
    </div>
  );
}
