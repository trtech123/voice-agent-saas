"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Template } from "@vam/database";

interface TemplateEditorProps {
  template: Template | null;
  onSave: (template: any) => void;
  onCancel: () => void;
}

export function TemplateEditor({ template, onSave, onCancel }: TemplateEditorProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [script, setScript] = useState(template?.script ?? "");
  const [businessType, setBusinessType] = useState(template?.business_type ?? "general");
  const [whatsappTemplate, setWhatsappTemplate] = useState(template?.whatsapp_template ?? "");
  const [questions, setQuestions] = useState<Array<{ question: string; key: string; options?: string[] }>>(
    template?.questions ?? []
  );

  function addQuestion() {
    setQuestions([...questions, { question: "", key: `q${questions.length + 1}` }]);
  }

  function updateQuestion(index: number, updates: any) {
    const updated = [...questions];
    updated[index] = { ...updated[index], ...updates };
    setQuestions(updated);
  }

  function removeQuestion(index: number) {
    setQuestions(questions.filter((_, i) => i !== index));
  }

  function handleSubmit() {
    onSave({
      id: template?.id,
      name,
      script,
      business_type: businessType,
      whatsapp_template: whatsappTemplate || null,
      questions,
    });
  }

  return (
    <div className="space-y-4">
      <Input
        id="template-name"
        label="שם התבנית"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <div>
        <label htmlFor="template-type" className="block text-sm font-medium text-gray-700 mb-1">סוג עסק</label>
        <select
          id="template-type"
          value={businessType}
          onChange={(e) => setBusinessType(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="real_estate">נדל&quot;ן</option>
          <option value="insurance">ביטוח</option>
          <option value="services">שירותי בית</option>
          <option value="general">כללי</option>
        </select>
      </div>

      <div>
        <label htmlFor="template-script" className="block text-sm font-medium text-gray-700 mb-1">סקריפט</label>
        <textarea
          id="template-script"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={5}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700">שאלות</label>
          <Button variant="ghost" size="sm" onClick={addQuestion}>+ הוסף שאלה</Button>
        </div>
        <div className="space-y-2">
          {questions.map((q, idx) => (
            <div key={idx} className="flex gap-2 items-center">
              <Input
                id={`tpl-q-${idx}`}
                value={q.question}
                onChange={(e) => updateQuestion(idx, { question: e.target.value })}
                placeholder="שאלה"
                className="flex-1"
              />
              <Input
                id={`tpl-qk-${idx}`}
                value={q.key}
                onChange={(e) => updateQuestion(idx, { key: e.target.value })}
                placeholder="מפתח"
                className="w-28"
                dir="ltr"
              />
              <button onClick={() => removeQuestion(idx)} className="text-gray-400 hover:text-red-500">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      <Input
        id="template-whatsapp"
        label="תבנית וואטסאפ"
        value={whatsappTemplate}
        onChange={(e) => setWhatsappTemplate(e.target.value)}
        placeholder="הנה הפרטים שביקשת: [link]"
      />

      <div className="flex gap-3 justify-end pt-2">
        <Button variant="secondary" onClick={onCancel}>ביטול</Button>
        <Button onClick={handleSubmit} disabled={!name.trim() || !script.trim()}>שמור</Button>
      </div>
    </div>
  );
}
