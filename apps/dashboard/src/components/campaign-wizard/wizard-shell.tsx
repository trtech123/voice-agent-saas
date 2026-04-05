"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { WizardState, INITIAL_WIZARD_STATE } from "./types";
import { StepTemplate } from "./step-template";
import { StepScript } from "./step-script";
import { StepContacts } from "./step-contacts";
import { StepSchedule } from "./step-schedule";
import { StepReview } from "./step-review";
import { Check, ChevronLeft, ChevronRight, Rocket } from "lucide-react";
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
      case 0: return true;
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
      <nav className="flex items-center justify-center gap-0 mb-8" aria-label="שלבי האשף">
        {STEP_LABELS.map((label, idx) => {
          const isActive = idx === step;
          const isCompleted = idx < step;
          return (
            <div key={idx} className="flex items-center">
              <button
                onClick={() => idx < step && setStep(idx)}
                disabled={idx > step}
                className={`
                  flex items-center gap-2.5 transition-all duration-200
                  ${idx <= step ? "cursor-pointer" : "cursor-not-allowed"}
                  focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:ring-offset-2 rounded-full
                `}
                aria-current={isActive ? "step" : undefined}
              >
                <span
                  className={`
                    w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold
                    transition-all duration-200 shrink-0
                    ${isActive
                      ? "bg-indigo-500 text-white shadow-md shadow-indigo-200"
                      : isCompleted
                        ? "bg-emerald-500 text-white"
                        : "bg-white/60 text-[#1E1B4B]/30 border border-white/40"
                    }
                  `}
                >
                  {isCompleted ? <Check className="w-4 h-4" /> : idx + 1}
                </span>
                <span
                  className={`
                    hidden md:inline text-sm font-medium transition-colors duration-200
                    ${isActive ? "text-[#1E1B4B]" : isCompleted ? "text-emerald-600" : "text-[#1E1B4B]/30"}
                  `}
                >
                  {label}
                </span>
              </button>
              {idx < STEP_LABELS.length - 1 && (
                <div
                  className={`
                    w-8 lg:w-12 h-0.5 mx-2 rounded-full transition-colors duration-200
                    ${isCompleted ? "bg-emerald-400" : "bg-white/40"}
                  `}
                />
              )}
            </div>
          );
        })}
      </nav>

      {/* Step content in glassmorphism card */}
      <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-6">
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
        <div className="mt-4 bg-red-50/80 backdrop-blur-sm border border-red-200/40 rounded-xl p-3">
          <p className="text-red-600 text-sm" role="alert">{error}</p>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex items-center justify-between mt-6">
        <Button
          variant="secondary"
          onClick={() => setStep((s) => s - 1)}
          disabled={step === 0}
        >
          <ChevronRight className="w-4 h-4" />
          הקודם
        </Button>

        {step < STEP_LABELS.length - 1 ? (
          <Button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canProceed()}
          >
            הבא
            <ChevronLeft className="w-4 h-4" />
          </Button>
        ) : (
          <Button
            onClick={handleLaunch}
            loading={launching}
            disabled={!canProceed()}
          >
            <Rocket className="w-4 h-4" />
            הפעל קמפיין
          </Button>
        )}
      </div>
    </div>
  );
}
