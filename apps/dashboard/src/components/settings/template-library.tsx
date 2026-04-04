"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { TemplateEditor } from "./template-editor";
import { createClient } from "@/lib/supabase-browser";
import type { Template } from "@vam/database";

interface TemplateLibraryProps {
  templates: Template[];
  tenantId: string;
}

export function TemplateLibrary({ templates: initialTemplates, tenantId }: TemplateLibraryProps) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleClone(template: Template) {
    const supabase = createClient();
    const { data } = await supabase
      .from("templates")
      .insert({
        tenant_id: tenantId,
        name: `${template.name} (עותק)`,
        business_type: template.business_type,
        script: template.script,
        questions: template.questions,
        whatsapp_template: template.whatsapp_template,
        is_system: false,
      })
      .select()
      .single();

    if (data) {
      setTemplates((prev) => [data, ...prev]);
    }
  }

  async function handleDelete(templateId: string) {
    const supabase = createClient();
    await supabase.from("templates").delete().eq("id", templateId);
    setTemplates((prev) => prev.filter((t) => t.id !== templateId));
  }

  async function handleSave(template: any) {
    const supabase = createClient();

    if (template.id) {
      // Update existing
      const { data } = await supabase
        .from("templates")
        .update({
          name: template.name,
          script: template.script,
          questions: template.questions,
          whatsapp_template: template.whatsapp_template,
          business_type: template.business_type,
        })
        .eq("id", template.id)
        .select()
        .single();

      if (data) {
        setTemplates((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      }
    } else {
      // Create new
      const { data } = await supabase
        .from("templates")
        .insert({
          tenant_id: tenantId,
          name: template.name,
          script: template.script,
          questions: template.questions,
          whatsapp_template: template.whatsapp_template,
          business_type: template.business_type,
          is_system: false,
        })
        .select()
        .single();

      if (data) {
        setTemplates((prev) => [data, ...prev]);
      }
    }

    setEditingTemplate(null);
    setCreating(false);
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Button onClick={() => setCreating(true)}>
          + תבנית חדשה
        </Button>
      </div>

      <div className="space-y-3">
        {templates.map((template) => (
          <div
            key={template.id}
            className="bg-white border border-gray-200 rounded-lg p-4 flex items-start justify-between"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-semibold">{template.name}</h3>
                {template.is_system && <Badge status="active" label="מערכת" />}
              </div>
              <p className="text-xs text-gray-500 line-clamp-1">{template.script.slice(0, 120)}...</p>
              <p className="text-xs text-gray-400 mt-1">{template.questions.length} שאלות</p>
            </div>
            <div className="flex gap-2">
              {template.is_system ? (
                <Button variant="ghost" size="sm" onClick={() => handleClone(template)}>
                  שכפל
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(template)}>
                    ערוך
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(template.id)}>
                    מחק
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Edit/Create modal */}
      <Modal
        open={editingTemplate !== null || creating}
        onClose={() => { setEditingTemplate(null); setCreating(false); }}
        title={editingTemplate ? "עריכת תבנית" : "תבנית חדשה"}
        size="xl"
      >
        <TemplateEditor
          template={editingTemplate}
          onSave={handleSave}
          onCancel={() => { setEditingTemplate(null); setCreating(false); }}
        />
      </Modal>
    </div>
  );
}
