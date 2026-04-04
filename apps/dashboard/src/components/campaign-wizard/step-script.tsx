"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { WizardState, WizardQuestion } from "./types";

interface StepScriptProps {
  state: WizardState;
  onUpdate: (partial: Partial<WizardState>) => void;
}

export function StepScript({ state, onUpdate }: StepScriptProps) {
  function addQuestion() {
    onUpdate({
      questions: [...state.questions, { question: "", key: `q${state.questions.length + 1}` }],
    });
  }

  function updateQuestion(index: number, updates: Partial<WizardQuestion>) {
    const newQuestions = [...state.questions];
    newQuestions[index] = { ...newQuestions[index], ...updates };
    onUpdate({ questions: newQuestions });
  }

  function removeQuestion(index: number) {
    onUpdate({
      questions: state.questions.filter((_, i) => i !== index),
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-2">סקריפט ושאלות</h2>
        <p className="text-sm text-gray-500 mb-6">ערוך את הסקריפט ושאלות ההסמכה של הסוכן.</p>
      </div>

      <Input
        id="campaign-name"
        label="שם הקמפיין"
        value={state.name}
        onChange={(e) => onUpdate({ name: e.target.value })}
        placeholder={'לדוגמה: קמפיין נדל"ן חודש אפריל'}
        required
      />

      <div>
        <label htmlFor="script" className="block text-sm font-medium text-gray-700 mb-1">
          סקריפט הסוכן
        </label>
        <textarea
          id="script"
          value={state.script}
          onChange={(e) => onUpdate({ script: e.target.value })}
          rows={6}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="כתוב כאן את ההנחיות לסוכן. השתמש ב[שם העסק] כמשתנה."
        />
        <p className="text-xs text-gray-400 mt-1">
          הסוכן ישתמש בטקסט הזה כהנחיה. כתוב בגוף שני (אתה/את).
        </p>
      </div>

      {/* Questions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-sm font-medium text-gray-700">שאלות הסמכה</label>
          <Button variant="ghost" size="sm" onClick={addQuestion}>
            + הוסף שאלה
          </Button>
        </div>

        {state.questions.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-300 rounded-lg">
            אין שאלות עדיין. הוסף שאלת הסמכה.
          </p>
        ) : (
          <div className="space-y-3">
            {state.questions.map((q, idx) => (
              <div key={idx} className="flex gap-3 items-start bg-gray-50 rounded-lg p-3">
                <span className="text-xs font-bold text-gray-400 mt-2.5">{idx + 1}</span>
                <div className="flex-1 space-y-2">
                  <Input
                    id={`question-${idx}`}
                    value={q.question}
                    onChange={(e) => updateQuestion(idx, { question: e.target.value })}
                    placeholder="שאלת ההסמכה"
                  />
                  <div className="flex gap-2">
                    <Input
                      id={`question-key-${idx}`}
                      value={q.key}
                      onChange={(e) => updateQuestion(idx, { key: e.target.value })}
                      placeholder="מפתח (באנגלית)"
                      className="w-40"
                      dir="ltr"
                    />
                    <Input
                      id={`question-options-${idx}`}
                      value={q.options?.join(", ") ?? ""}
                      onChange={(e) =>
                        updateQuestion(idx, {
                          options: e.target.value ? e.target.value.split(",").map((s) => s.trim()) : undefined,
                        })
                      }
                      placeholder="אפשרויות (מופרדות בפסיק, אופציונלי)"
                    />
                  </div>
                </div>
                <button
                  onClick={() => removeQuestion(idx)}
                  className="text-gray-400 hover:text-red-500 mt-2"
                  aria-label="הסר שאלה"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* WhatsApp follow-up */}
      <div className="border-t border-gray-200 pt-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-700">הודעת וואטסאפ (אופציונלי)</h3>
        <Input
          id="whatsapp-template"
          label="תבנית הודעה"
          value={state.whatsappFollowupTemplate}
          onChange={(e) => onUpdate({ whatsappFollowupTemplate: e.target.value })}
          placeholder="הנה הפרטים שביקשת: [link]"
        />
        <Input
          id="whatsapp-link"
          label="קישור"
          value={state.whatsappFollowupLink}
          onChange={(e) => onUpdate({ whatsappFollowupLink: e.target.value })}
          placeholder="https://..."
          dir="ltr"
        />
      </div>
    </div>
  );
}
