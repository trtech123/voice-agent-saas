"use client";

import type { Template } from "@vam/database";
import type { WizardState } from "./types";

interface StepTemplateProps {
  templates: Template[];
  state: WizardState;
  onUpdate: (partial: Partial<WizardState>) => void;
}

const businessTypeLabels: Record<string, string> = {
  real_estate: 'נדל"ן',
  insurance: "ביטוח",
  services: "שירותי בית",
  general: "כללי",
};

export function StepTemplate({ templates, state, onUpdate }: StepTemplateProps) {
  function selectTemplate(template: Template | null) {
    if (!template) {
      onUpdate({
        templateId: null,
        script: "",
        questions: [],
        whatsappFollowupTemplate: "",
        name: "",
      });
      return;
    }

    onUpdate({
      templateId: template.id,
      script: template.script,
      questions: template.questions,
      whatsappFollowupTemplate: template.whatsapp_template ?? "",
      name: template.name,
    });
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-2">בחירת תבנית</h2>
      <p className="text-sm text-gray-500 mb-6">בחר תבנית מוכנה לפי סוג העסק שלך, או התחל מאפס.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Blank option */}
        <button
          onClick={() => selectTemplate(null)}
          className={`
            text-right p-4 rounded-lg border-2 transition-colors
            ${state.templateId === null
              ? "border-blue-600 bg-blue-50"
              : "border-gray-200 hover:border-gray-300"
            }
          `}
        >
          <div className="text-2xl mb-2">📝</div>
          <h3 className="font-medium text-sm">התחל מאפס</h3>
          <p className="text-xs text-gray-500 mt-1">כתוב סקריפט משלך ושאלות מותאמות</p>
        </button>

        {/* Template options */}
        {templates.map((template) => (
          <button
            key={template.id}
            onClick={() => selectTemplate(template)}
            className={`
              text-right p-4 rounded-lg border-2 transition-colors
              ${state.templateId === template.id
                ? "border-blue-600 bg-blue-50"
                : "border-gray-200 hover:border-gray-300"
              }
            `}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs bg-gray-100 text-gray-600 rounded px-2 py-0.5">
                {businessTypeLabels[template.business_type] ?? template.business_type}
              </span>
              {template.is_system && (
                <span className="text-xs text-blue-600">מערכת</span>
              )}
            </div>
            <h3 className="font-medium text-sm">{template.name}</h3>
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{template.script.slice(0, 80)}...</p>
            <p className="text-xs text-gray-400 mt-2">{template.questions.length} שאלות</p>
          </button>
        ))}
      </div>
    </div>
  );
}
