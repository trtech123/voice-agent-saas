import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F5F3FF]">
      <Sidebar />
      <div className="mr-64">
        <Topbar />
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
