import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    const tenantId = user.app_metadata?.tenant_id;
    if (!tenantId) {
      return NextResponse.json({ error: "חסר tenant" }, { status: 400 });
    }

    const { campaignId } = await request.json();

    const { data: campaign, error } = await supabase
      .from("campaigns")
      .update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "שגיאה בהשהיית הקמפיין" }, { status: 500 });
    }

    return NextResponse.json({ campaign });
  } catch (err) {
    console.error("Pause error:", err);
    return NextResponse.json({ error: "שגיאה" }, { status: 500 });
  }
}
