"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dayLabels } from "@/lib/utils/format";
import type { WizardState } from "./types";

interface StepReviewProps {
  state: WizardState;
  onUpdate: (partial: Partial<WizardState>) => void;
}

export function StepReview({ state, onUpdate }: StepReviewProps) {
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);

  async function handleTestCall() {
    if (!state.testCallPhone.trim()) return;
    setTestLoading(true);
    setTestError(null);
    setTestSuccess(false);

    try {
      const res = await fetch("/api/campaigns/test-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: state.testCallPhone,
          script: state.script,
          questions: state.questions,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה בשליחת שיחת בדיקה");
      }

      setTestSuccess(true);
      onUpdate({ testCallSent: true });
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setTestLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-2">בדיקה והפעלה</h2>
        <p className="text-sm text-gray-500 mb-6">בדוק את הקמפיין עם שיחת בדיקה לטלפון שלך לפני ההפעלה.</p>
      </div>

      {/* Test call */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-blue-800 mb-3">שיחת בדיקה</h3>
        <p className="text-xs text-blue-600 mb-3">
          שלח שיחת בדיקה לטלפון שלך כדי לשמוע את הסוכן לפני הפעלת הקמפיין.
        </p>
        <div className="flex gap-3 items-end">
          <Input
            id="test-phone"
            label="מספר טלפון לבדיקה"
            value={state.testCallPhone}
            onChange={(e) => onUpdate({ testCallPhone: e.target.value })}
            placeholder="050-123-4567"
            dir="ltr"
          />
          <Button
            onClick={handleTestCall}
            loading={testLoading}
            disabled={!state.testCallPhone.trim()}
            variant="secondary"
          >
            שלח שיחת בדיקה
          </Button>
        </div>
        {testError && <p className="text-red-600 text-xs mt-2">{testError}</p>}
        {testSuccess && <p className="text-green-600 text-xs mt-2">שיחת בדיקה נשלחה! בדוק את הטלפון שלך.</p>}
      </div>

      {/* Review summary */}
      <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">שם הקמפיין</h3>
          <p className="text-sm font-semibold">{state.name || "--"}</p>
        </div>

        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">סקריפט</h3>
          <p className="text-sm text-gray-700 whitespace-pre-wrap line-clamp-4">{state.script || "--"}</p>
        </div>

        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">שאלות הסמכה</h3>
          {state.questions.length === 0 ? (
            <p className="text-sm text-gray-400">ללא שאלות</p>
          ) : (
            <ol className="list-decimal list-inside space-y-1">
              {state.questions.map((q, i) => (
                <li key={i} className="text-sm text-gray-700">{q.question}</li>
              ))}
            </ol>
          )}
        </div>

        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">אנשי קשר</h3>
          <p className="text-sm font-semibold">
            {state.uploadResult?.contactCount ?? 0} אנשי קשר
          </p>
        </div>

        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">תזמון</h3>
          <p className="text-sm text-gray-700">
            {state.scheduleDays.map((d) => dayLabels[d]).join(", ")}
          </p>
          <p className="text-sm text-gray-500 mt-1" dir="ltr">
            {state.scheduleWindows.map((w) => `${w.start}\u2013${w.end}`).join(", ")}
          </p>
        </div>

        <div className="p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">הגדרות</h3>
          <div className="flex gap-4 text-sm text-gray-700">
            <span>{state.maxConcurrentCalls} שיחות במקביל</span>
            <span>{state.maxRetryAttempts} ניסיונות חוזרים</span>
            <span>{state.retryDelayMinutes} דקות בין ניסיונות</span>
          </div>
        </div>

        {state.whatsappFollowupTemplate && (
          <div className="p-4">
            <h3 className="text-sm font-medium text-gray-500 mb-1">הודעת וואטסאפ</h3>
            <p className="text-sm text-gray-700">{state.whatsappFollowupTemplate}</p>
          </div>
        )}
      </div>
    </div>
  );
}
