"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { WizardState, INITIAL_WIZARD_STATE } from "./types";
import { StepTemplate } from "./step-template";
import { StepScript } from "./step-script";
import { StepContacts } from "./step-contacts";
import { StepSchedule } from "./step-schedule";
import { StepReview } from "./step-review";
import type { Template } from "@vam/database";

const STEP_LABELS = [
  "בחירת תבנית",
  "סקריפט ושאלות",
  "העלאת אנשי קשר",
  "תזמון והגדרות",
  "בדיקה והפעלה",
];

interface WizardShellProps {
  templates: Template[];
  tenantId: string;
}

export function WizardShell({ templates, tenantId }: WizardShellProps) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL_WIZARD_STATE);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateState(partial: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...partial }));
  }

  function canProceed(): boolean {
    switch (step) {
      case 0: return true; // Template is optional (can start blank)
      case 1: return state.name.trim().length > 0 && state.script.trim().length > 0;
      case 2: return state.uploadResult !== null && state.uploadResult.contactCount > 0;
      case 3: return state.scheduleDays.length > 0 && state.scheduleWindows.length > 0;
      case 4: return true;
      default: return false;
    }
  }

  async function handleLaunch() {
    setLaunching(true);
    setError(null);

    try {
      const res = await fetch("/api/campaigns/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: state.name,
          script: state.script,
          questions: state.questions,
          whatsapp_followup_template: state.whatsappFollowupTemplate || null,
          whatsapp_followup_link: state.whatsappFollowupLink || null,
          template_id: state.templateId,
          schedule_days: state.scheduleDays,
          schedule_windows: state.scheduleWindows,
          max_concurrent_calls: state.maxConcurrentCalls,
          max_retry_attempts: state.maxRetryAttempts,
          retry_delay_minutes: state.retryDelayMinutes,
          contact_ids: state.uploadResult?.contactIds ?? [],
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה בהפעלת הקמפיין");
      }

      const { campaignId } = await res.json();
      window.location.href = `/campaigns/${campaignId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
      setLaunching(false);
    }
  }

  return (
    <div>
      {/* Step indicator */}
      <nav className="flex items-center gap-2 mb-8" aria-label="שלבי האשף">
        {STEP_LABELS.map((label, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <button
              onClick={() => idx < step && setStep(idx)}
              disabled={idx > step}
              className={`
                flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-full transition-colors
                ${idx === step
                  ? "bg-blue-600 text-white"
                  : idx < step
                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200 cursor-pointer"
                    : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }
              `}
              aria-current={idx === step ? "step" : undefined}
            >
              <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-xs">
                {idx < step ? "\u2713" : idx + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </button>
            {idx < STEP_LABELS.length - 1 && (
              <div className={`w-8 h-0.5 ${idx < step ? "bg-blue-300" : "bg-gray-200"}`} />
            )}
          </div>
        ))}
      </nav>

      {/* Step content */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        {step === 0 && (
          <StepTemplate
            templates={templates}
            state={state}
            onUpdate={updateState}
          />
        )}
        {step === 1 && (
          <StepScript state={state} onUpdate={updateState} />
        )}
        {step === 2 && (
          <StepContacts state={state} onUpdate={updateState} tenantId={tenantId} />
        )}
        {step === 3 && (
          <StepSchedule state={state} onUpdate={updateState} />
        )}
        {step === 4 && (
          <StepReview state={state} onUpdate={updateState} />
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-red-600 text-sm mt-4" role="alert">{error}</p>
      )}

      {/* Navigation buttons */}
      <div className="flex items-center justify-between mt-6">
        <Button
          variant="secondary"
          onClick={() => setStep((s) => s - 1)}
          disabled={step === 0}
        >
          הקודם
        </Button>

        {step < STEP_LABELS.length - 1 ? (
          <Button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canProceed()}
          >
            הבא
          </Button>
        ) : (
          <Button
            onClick={handleLaunch}
            loading={launching}
            disabled={!canProceed()}
          >
            הפעל קמפיין
          </Button>
        )}
      </div>
    </div>
  );
}
