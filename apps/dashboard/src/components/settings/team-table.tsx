"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { createClient } from "@/lib/supabase-browser";
import type { User as AppUser } from "@vam/database";

interface TeamTableProps {
  users: AppUser[];
  currentUserId: string;
  isOwner: boolean;
  tenantId: string;
}

const roleLabels: Record<string, string> = {
  owner: "בעלים",
  admin: "מנהל",
  viewer: "צופה",
};

export function TeamTable({ users: initialUsers, currentUserId, isOwner, tenantId }: TeamTableProps) {
  const [users, setUsers] = useState(initialUsers);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRoleChange(userId: string, newRole: string) {
    if (!isOwner) return;
    const supabase = createClient();
    const { error } = await supabase
      .from("users")
      .update({ role: newRole })
      .eq("id", userId);

    if (!error) {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole as any } : u))
      );
    }
  }

  async function handleInvite() {
    setInviting(true);
    setError(null);

    try {
      // For MVP, invite creates a Supabase Auth user with a temp password
      // In production, this would send an invite email
      const supabase = createClient();
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: inviteEmail,
        password: Math.random().toString(36).slice(2) + "Aa1!",
        email_confirm: true,
        user_metadata: { invited_by: currentUserId },
        app_metadata: { tenant_id: tenantId, role: inviteRole },
      });

      if (authError) throw authError;

      // Create users row
      if (authData.user) {
        const { data: newUser } = await supabase
          .from("users")
          .insert({
            id: authData.user.id,
            tenant_id: tenantId,
            email: inviteEmail,
            role: inviteRole,
          })
          .select()
          .single();

        if (newUser) {
          setUsers((prev) => [...prev, newUser]);
        }
      }

      setShowInvite(false);
      setInviteEmail("");
      setInviteRole("viewer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בהזמנה");
    } finally {
      setInviting(false);
    }
  }

  return (
    <div>
      {isOwner && (
        <div className="flex justify-end mb-4">
          <Button onClick={() => setShowInvite(true)}>
            + הזמן חבר צוות
          </Button>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-gray-500">
              <th className="text-right py-3 px-4 font-medium">אימייל</th>
              <th className="text-right py-3 px-4 font-medium">תפקיד</th>
              <th className="text-right py-3 px-4 font-medium">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-gray-100">
                <td className="py-3 px-4" dir="ltr">
                  {user.email}
                  {user.id === currentUserId && (
                    <span className="text-xs text-gray-400 me-2">(אתה)</span>
                  )}
                </td>
                <td className="py-3 px-4">
                  {isOwner && user.id !== currentUserId ? (
                    <select
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.id, e.target.value)}
                      className="border border-gray-300 rounded px-2 py-1 text-xs"
                    >
                      <option value="admin">מנהל</option>
                      <option value="viewer">צופה</option>
                    </select>
                  ) : (
                    <Badge
                      status={user.role === "owner" ? "active" : user.role === "admin" ? "blue" : "gray"}
                      label={roleLabels[user.role]}
                    />
                  )}
                </td>
                <td className="py-3 px-4">
                  {user.id === currentUserId ? (
                    <span className="text-xs text-gray-400">--</span>
                  ) : isOwner ? (
                    <button className="text-xs text-red-600 hover:underline">הסר</button>
                  ) : (
                    <span className="text-xs text-gray-400">--</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Invite modal */}
      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="הזמן חבר צוות"
        size="sm"
      >
        <div className="space-y-4">
          <Input
            id="invite-email"
            label="אימייל"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            dir="ltr"
            required
          />
          <div>
            <label htmlFor="invite-role" className="block text-sm font-medium text-gray-700 mb-1">תפקיד</label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="admin">מנהל</option>
              <option value="viewer">צופה</option>
            </select>
          </div>
          {error && <p className="text-red-600 text-sm" role="alert">{error}</p>}
          <div className="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setShowInvite(false)}>ביטול</Button>
            <Button onClick={handleInvite} loading={inviting} disabled={!inviteEmail.trim()}>
              הזמן
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
