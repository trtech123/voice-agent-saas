"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  Phone,
  MessageCircle,
  FileText,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

const settingsNav = [
  { href: "/settings", label: "פרופיל עסקי", icon: Building2 },
  { href: "/settings/telephony", label: "טלפוניה (Voicenter)", icon: Phone },
  { href: "/settings/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { href: "/settings/templates", label: "תבניות", icon: FileText },
  { href: "/settings/team", label: "צוות", icon: Users },
];

interface SettingsLayoutProps {
  title: string;
  children: ReactNode;
}

export function SettingsLayout({ title, children }: SettingsLayoutProps) {
  const pathname = usePathname();

  return (
    <div>
      <h1 className="text-2xl font-bold text-[#1E1B4B] mb-8">הגדרות</h1>

      <div className="flex gap-8">
        {/* Settings pill nav */}
        <nav className="w-52 flex-shrink-0" aria-label="הגדרות">
          <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-2 space-y-0.5">
            {settingsNav.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`
                    flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-lg
                    transition-all duration-200 cursor-pointer
                    focus:outline-none focus:ring-2 focus:ring-indigo-400/50
                    ${isActive
                      ? "bg-indigo-500 text-white font-medium shadow-sm"
                      : "text-[#1E1B4B]/60 hover:bg-white/80 hover:text-[#1E1B4B]"
                    }
                  `}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Content */}
        <div className="flex-1">
          <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-6">
            <h2 className="text-lg font-semibold text-[#1E1B4B] mb-5">{title}</h2>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
