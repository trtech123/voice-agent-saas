"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import { useUser } from "@/lib/hooks/use-user";
import { useTenant } from "@/lib/hooks/use-tenant";
import { useState } from "react";

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
    <header className="sticky top-0 z-30 bg-white border-b border-gray-200 h-16 flex items-center justify-between px-6 mr-64">
      {/* Business name */}
      <div>
        <h2 className="text-sm font-semibold text-gray-800">
          {tenant?.name ?? "טוען..."}
        </h2>
      </div>

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          aria-expanded={menuOpen}
          aria-haspopup="true"
        >
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-medium text-sm">
            {authUser?.email?.[0]?.toUpperCase() ?? "?"}
          </div>
          <span className="hidden sm:inline">{authUser?.email}</span>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute left-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
            <div className="px-4 py-2 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-800">{authUser?.email}</p>
              <p className="text-xs text-gray-500">{appUser?.role === "owner" ? "בעלים" : appUser?.role === "admin" ? "מנהל" : "צופה"}</p>
            </div>
            <button
              onClick={handleLogout}
              className="w-full text-right px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              התנתק
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
