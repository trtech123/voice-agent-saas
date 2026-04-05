"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Megaphone, Settings, Phone } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  {
    label: "דשבורד ראשי",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    label: "קמפיינים",
    href: "/campaigns",
    icon: Megaphone,
  },
  {
    label: "הגדרות",
    href: "/settings",
    icon: Settings,
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed top-0 right-0 h-screen w-64 glass-sidebar flex flex-col z-40">
      {/* Logo area with gradient */}
      <div
        className="px-6 py-5"
        style={{ background: "linear-gradient(135deg, #6366F1, #818CF8)" }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/20">
            <Phone className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Voice Agent</h1>
            <p className="text-xs text-indigo-100">ניהול קמפיינים קוליים</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="ניווט ראשי">
        {navItems.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium
                transition-all duration-200 cursor-pointer
                ${isActive
                  ? "bg-indigo-50 text-indigo-700 shadow-sm"
                  : "text-slate-600 hover:bg-indigo-50/50 hover:text-indigo-600"
                }
              `}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="w-5 h-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t" style={{ borderColor: "#E2E8F0" }}>
        <p className="text-xs text-center" style={{ color: "#64748B" }}>
          v1.0.0
        </p>
      </div>
    </aside>
  );
}
