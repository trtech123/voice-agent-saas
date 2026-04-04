import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { ProfileForm } from "@/components/settings/profile-form";
import Link from "next/link";

const settingsNav = [
  { href: "/settings", label: "פרופיל עסקי" },
  { href: "/settings/telephony", label: "טלפוניה (Voicenter)" },
  { href: "/settings/whatsapp", label: "WhatsApp" },
  { href: "/settings/templates", label: "תבניות" },
  { href: "/settings/team", label: "צוות" },
];

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .single();

  if (!tenant) redirect("/dashboard");

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">הגדרות</h1>

      <div className="flex gap-8">
        {/* Settings sub-nav */}
        <nav className="w-48 flex-shrink-0 space-y-1" aria-label="הגדרות">
          {settingsNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block px-3 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1">
          <h2 className="text-lg font-semibold mb-4">פרופיל עסקי</h2>
          <ProfileForm tenant={tenant} />
        </div>
      </div>
    </div>
  );
}
