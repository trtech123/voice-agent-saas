import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Agent — דשבורד",
  description: "ניהול קמפיינים ולידים",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body
        className="antialiased min-h-screen"
        style={{
          fontFamily: "'Noto Sans Hebrew', sans-serif",
          color: "#1E1B4B",
          background: "linear-gradient(135deg, #F5F3FF 0%, #EDE9FE 50%, #E0E7FF 100%)",
        }}
      >
        {children}
      </body>
    </html>
  );
}
