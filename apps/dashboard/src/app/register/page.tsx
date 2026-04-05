"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import { Phone, Mail, Lock, Building2, Smartphone } from "lucide-react";

export default function RegisterPage() {
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // 1. Sign up via Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { business_name: businessName, phone },
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // Tenant + user row creation is handled by a Supabase database trigger
    // (on auth.users insert -> create tenant + public.users row)
    // For now, redirect to dashboard -- the trigger handles the rest.

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden px-4">
      {/* Animated background shapes */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div
          className="absolute top-16 left-16 w-80 h-80 rounded-full opacity-20 animate-float"
          style={{ background: "linear-gradient(135deg, #6366F1, #818CF8)" }}
        />
        <div
          className="absolute bottom-16 right-16 w-64 h-64 rounded-full opacity-15 animate-float-reverse"
          style={{ background: "linear-gradient(135deg, #818CF8, #A5B4FC)" }}
        />
        <div
          className="absolute top-1/3 right-1/4 w-40 h-40 rounded-full opacity-10 animate-float"
          style={{ background: "linear-gradient(135deg, #10B981, #6366F1)", animationDelay: "3s" }}
        />
      </div>

      {/* Register card */}
      <div className="glass-strong w-full max-w-md rounded-2xl shadow-xl p-8 relative z-10">
        {/* Brand area */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
            style={{ background: "linear-gradient(135deg, #6366F1, #818CF8)" }}
          >
            <Phone className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold" style={{ color: "#1E1B4B" }}>
            Voice Agent
          </h1>
          <p className="text-sm mt-1" style={{ color: "#64748B" }}>
            סוכן קולי חכם לעסקים
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="businessName" className="block text-sm font-medium mb-1.5" style={{ color: "#1E1B4B" }}>
              שם העסק
            </label>
            <div className="relative">
              <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "#64748B" }} />
              <input
                id="businessName"
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
                className="input-glass pl-10"
                placeholder="העסק שלי"
              />
            </div>
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1.5" style={{ color: "#1E1B4B" }}>
              אימייל
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "#64748B" }} />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input-glass pl-10"
                dir="ltr"
                placeholder="you@example.com"
              />
            </div>
          </div>
          <div>
            <label htmlFor="phone" className="block text-sm font-medium mb-1.5" style={{ color: "#1E1B4B" }}>
              טלפון
            </label>
            <div className="relative">
              <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "#64748B" }} />
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="input-glass pl-10"
                dir="ltr"
                placeholder="050-1234567"
              />
            </div>
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5" style={{ color: "#1E1B4B" }}>
              סיסמה
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "#64748B" }} />
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="input-glass pl-10"
                dir="ltr"
                placeholder="********"
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading} className="btn-cta">
            {loading ? "נרשם..." : "הרשמה"}
          </button>
        </form>

        <p className="text-center text-sm mt-6" style={{ color: "#64748B" }}>
          כבר יש לך חשבון?{" "}
          <a
            href="/login"
            className="font-medium cursor-pointer transition-colors duration-200 hover:underline"
            style={{ color: "#6366F1" }}
          >
            התחברות
          </a>
        </p>
      </div>
    </div>
  );
}
