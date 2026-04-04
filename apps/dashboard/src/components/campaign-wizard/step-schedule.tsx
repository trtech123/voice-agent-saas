"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { dayLabels } from "@/lib/utils/format";
import type { WizardState, ScheduleWindow } from "./types";

interface StepScheduleProps {
  state: WizardState;
  onUpdate: (partial: Partial<WizardState>) => void;
}

const ALL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri"] as const;

export function StepSchedule({ state, onUpdate }: StepScheduleProps) {
  function toggleDay(day: string) {
    const current = state.scheduleDays;
    if (current.includes(day)) {
      onUpdate({ scheduleDays: current.filter((d) => d !== day) });
    } else {
      onUpdate({ scheduleDays: [...current, day] });
    }
  }

  function updateWindow(index: number, field: keyof ScheduleWindow, value: string) {
    const newWindows = [...state.scheduleWindows];
    newWindows[index] = { ...newWindows[index], [field]: value };
    onUpdate({ scheduleWindows: newWindows });
  }

  function addWindow() {
    onUpdate({
      scheduleWindows: [...state.scheduleWindows, { start: "09:00", end: "12:00" }],
    });
  }

  function removeWindow(index: number) {
    onUpdate({
      scheduleWindows: state.scheduleWindows.filter((_, i) => i !== index),
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-2">תזמון והגדרות</h2>
        <p className="text-sm text-gray-500 mb-6">בחר מתי הסוכן יתקשר והגדר ניסיונות חוזרים.</p>
      </div>

      {/* Days */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">ימי פעילות</label>
        <div className="flex gap-2 flex-wrap">
          {ALL_DAYS.map((day) => (
            <button
              key={day}
              onClick={() => toggleDay(day)}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium transition-colors border
                ${state.scheduleDays.includes(day)
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
                }
              `}
            >
              {dayLabels[day]}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1">שבת חסומה בהתאם לתיקון 40.</p>
      </div>

      {/* Time windows */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700">חלונות זמן</label>
          <Button variant="ghost" size="sm" onClick={addWindow}>
            + הוסף חלון
          </Button>
        </div>
        <div className="space-y-2">
          {state.scheduleWindows.map((window, idx) => (
            <div key={idx} className="flex items-center gap-3">
              <Input
                id={`window-start-${idx}`}
                type="time"
                value={window.start}
                onChange={(e) => updateWindow(idx, "start", e.target.value)}
                className="w-32"
                dir="ltr"
              />
              <span className="text-sm text-gray-500">עד</span>
              <Input
                id={`window-end-${idx}`}
                type="time"
                value={window.end}
                onChange={(e) => updateWindow(idx, "end", e.target.value)}
                className="w-32"
                dir="ltr"
              />
              {state.scheduleWindows.length > 1 && (
                <button
                  onClick={() => removeWindow(idx)}
                  className="text-gray-400 hover:text-red-500"
                  aria-label="הסר חלון זמן"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Concurrency + Retry settings */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-gray-200 pt-4">
        <Input
          id="max-concurrent"
          label="שיחות במקביל"
          type="number"
          min={1}
          max={20}
          value={state.maxConcurrentCalls}
          onChange={(e) => onUpdate({ maxConcurrentCalls: Number(e.target.value) })}
          dir="ltr"
        />
        <Input
          id="max-retries"
          label="ניסיונות חוזרים"
          type="number"
          min={0}
          max={5}
          value={state.maxRetryAttempts}
          onChange={(e) => onUpdate({ maxRetryAttempts: Number(e.target.value) })}
          dir="ltr"
          hint="למי שלא ענה"
        />
        <Input
          id="retry-delay"
          label="השהיה בין ניסיונות (דקות)"
          type="number"
          min={30}
          max={1440}
          step={30}
          value={state.retryDelayMinutes}
          onChange={(e) => onUpdate({ retryDelayMinutes: Number(e.target.value) })}
          dir="ltr"
        />
      </div>
    </div>
  );
}
