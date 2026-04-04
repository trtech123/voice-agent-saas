// apps/dashboard/src/app/api/contacts/[id]/delete/route.ts

/**
 * Data Subject Deletion API
 *
 * DELETE /api/contacts/:id/delete
 *
 * Deletes a contact and ALL associated data:
 *   - Call recordings from Supabase Storage
 *   - Call transcripts
 *   - Calls
 *   - Campaign contacts (join table entries)
 *   - The contact record itself
 *
 * Requires owner or admin role. Logged to audit_log before deletion.
 *
 * Per Israeli Privacy Protection Act (data subject rights).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { createSupabaseAdmin, AuditLogDAL } from "@vam/database";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const contactId = params.id;

    // 1. Verify authentication and authorization
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get user's role and tenant_id from the users table
    const { data: appUser, error: userError } = await supabase
      .from("users")
      .select("tenant_id, role")
      .eq("id", user.id)
      .single();

    if (userError || !appUser) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    // Only owner and admin can delete contacts
    if (!["owner", "admin"].includes(appUser.role)) {
      return NextResponse.json(
        { error: "Insufficient permissions. Owner or admin role required." },
        { status: 403 }
      );
    }

    const tenantId = appUser.tenant_id;

    // 2. Use admin client for cascade deletion (bypasses RLS)
    const adminClient = createSupabaseAdmin(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // 3. Verify the contact belongs to this tenant
    const { data: contact, error: contactError } = await adminClient
      .from("contacts")
      .select("id, tenant_id, phone, name")
      .eq("id", contactId)
      .eq("tenant_id", tenantId)
      .single();

    if (contactError || !contact) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 }
      );
    }

    // 4. Log the deletion request to audit BEFORE deleting
    //    This ensures we have a record even if deletion partially fails.
    const auditDAL = new AuditLogDAL(adminClient, tenantId);
    await auditDAL.log("data_subject_deletion", "contact", contactId, {
      contact_phone_suffix: contact.phone.slice(-4),
      contact_name: contact.name,
      requested_by: user.id,
      requested_at: new Date().toISOString(),
    });

    // 5. Find all calls for this contact (to delete recordings)
    const { data: calls } = await adminClient
      .from("calls")
      .select("id, recording_path")
      .eq("contact_id", contactId)
      .eq("tenant_id", tenantId);

    // 6. Delete recordings from Supabase Storage
    if (calls && calls.length > 0) {
      const recordingPaths = calls
        .map((c) => c.recording_path)
        .filter(Boolean) as string[];

      if (recordingPaths.length > 0) {
        const { error: storageError } = await adminClient.storage
          .from("recordings")
          .remove(recordingPaths);

        if (storageError) {
          console.error(
            `Warning: Failed to delete some recordings for contact ${contactId}:`,
            storageError.message
          );
          // Continue with database deletion even if storage fails
        }
      }

      // 7. Delete call transcripts
      const callIds = calls.map((c) => c.id);
      await adminClient
        .from("call_transcripts")
        .delete()
        .eq("tenant_id", tenantId)
        .in("call_id", callIds);

      // 8. Delete calls
      await adminClient
        .from("calls")
        .delete()
        .eq("contact_id", contactId)
        .eq("tenant_id", tenantId);
    }

    // 9. Delete campaign_contacts entries
    await adminClient
      .from("campaign_contacts")
      .delete()
      .eq("contact_id", contactId)
      .eq("tenant_id", tenantId);

    // 10. Delete the contact record itself
    const { error: deleteError } = await adminClient
      .from("contacts")
      .delete()
      .eq("id", contactId)
      .eq("tenant_id", tenantId);

    if (deleteError) {
      return NextResponse.json(
        { error: `Failed to delete contact: ${deleteError.message}` },
        { status: 500 }
      );
    }

    // 11. Log completion
    await auditDAL.log("data_subject_deletion_complete", "contact", contactId, {
      calls_deleted: calls?.length ?? 0,
      recordings_deleted: calls?.filter((c) => c.recording_path).length ?? 0,
      completed_at: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      deleted: {
        contact: contactId,
        calls: calls?.length ?? 0,
        recordings: calls?.filter((c) => c.recording_path).length ?? 0,
      },
    });
  } catch (err) {
    console.error("Data subject deletion error:", err);
    return NextResponse.json(
      {
        error: "Internal server error during data deletion",
      },
      { status: 500 }
    );
  }
}
