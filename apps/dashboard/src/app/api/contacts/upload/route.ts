import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { parseCsvText, sanitizeContacts, MAX_FILE_SIZE } from "@/lib/utils/csv-sanitizer";

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

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "לא נבחר קובץ" }, { status: 400 });
    }

    // Server-side size check
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "הקובץ גדול מדי. מקסימום 10MB." }, { status: 400 });
    }

    // Read file content
    const text = await file.text();

    // Parse CSV
    const allRows = parseCsvText(text);
    if (allRows.length < 2) {
      return NextResponse.json({ error: "הקובץ ריק או חסרה שורת כותרת" }, { status: 400 });
    }

    const headerRow = allRows[0];
    const dataRows = allRows.slice(1);

    // Sanitize
    const result = sanitizeContacts(dataRows, headerRow);

    if (result.contacts.length === 0) {
      return NextResponse.json({
        error: "לא נמצאו אנשי קשר תקינים בקובץ",
        errors: result.errors,
      }, { status: 400 });
    }

    // Upsert contacts into database
    const contactRows = result.contacts.map((c) => ({
      tenant_id: tenantId,
      phone: c.phone,
      name: c.name,
      email: c.email,
      custom_fields: c.custom_fields,
    }));

    const { data: upserted, error: dbError } = await supabase
      .from("contacts")
      .upsert(contactRows, { onConflict: "tenant_id,phone" })
      .select("id");

    if (dbError) {
      console.error("Contact upsert error:", dbError);
      return NextResponse.json({ error: "שגיאה בשמירת אנשי הקשר" }, { status: 500 });
    }

    const contactIds = (upserted ?? []).map((c) => c.id);

    return NextResponse.json({
      contactCount: contactIds.length,
      errors: result.errors,
      duplicatesRemoved: result.duplicatesRemoved,
      contactIds,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json({ error: "שגיאה בעיבוד הקובץ" }, { status: 500 });
  }
}
