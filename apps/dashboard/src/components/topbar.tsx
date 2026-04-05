"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import { useUser } from "@/lib/hooks/use-user";
import { useTenant } from "@/lib/hooks/use-tenant";
import { useState } from "react";
import { LogOut, ChevronDown, User } from "lucide-react";

export function Topbar() {
  const { authUser, appUser } = useUser();
  const { tenant } = useTenant();
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header
      className="sticky top-0 z-30 glass-strong h-16 flex items-center justify-between px-6"
      style={{ borderBottom: "1px solid #E2E8F0" }}
    >
      {/* Business name / breadcrumb */}
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "#1E1B4B" }}>
          {tenant?.name ?? "טוען..."}
        </h2>
      </div>

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex items-center gap-2 text-sm transition-all duration-200 cursor-pointer rounded-xl px-3 py-2 hover:bg-indigo-50/50"
          style={{ color: "#64748B" }}
          aria-expanded={menuOpen}
          aria-haspopup="true"
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white font-medium text-sm"
            style={{ background: "linear-gradient(135deg, #6366F1, #818CF8)" }}
          >
            {authUser?.email?.[0]?.toUpperCase() ?? <User className="w-4 h-4" />}
          </div>
          <span className="hidden sm:inline" style={{ color: "#1E1B4B" }}>
            {authUser?.email}
          </span>
          <ChevronDown className="w-4 h-4" />
        </button>

        {menuOpen && (
          <div className="absolute left-0 top-full mt-1 w-52 glass-strong rounded-xl shadow-lg py-1 z-50">
            <div className="px-4 py-3 border-b" style={{ borderColor: "#E2E8F0" }}>
              <p className="text-sm font-medium" style={{ color: "#1E1B4B" }}>
                {authUser?.email}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "#64748B" }}>
                {appUser?.role === "owner" ? "בעלים" : appUser?.role === "admin" ? "מנהל" : "צופה"}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 text-right px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors duration-200 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              התנתק
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
