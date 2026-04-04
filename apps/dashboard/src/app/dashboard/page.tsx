import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <div className="min-h-screen p-8">
      <h1 className="text-3xl font-bold mb-4">דשבורד ראשי</h1>
      <p className="text-gray-600">ברוך הבא! הדשבורד בבנייה.</p>
      <p className="text-sm text-gray-400 mt-2">{user.email}</p>
    </div>
  );
}
