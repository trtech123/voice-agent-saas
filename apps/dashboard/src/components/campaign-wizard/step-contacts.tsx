"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { WizardState } from "./types";

interface StepContactsProps {
  state: WizardState;
  onUpdate: (partial: Partial<WizardState>) => void;
  tenantId: string;
}

export function StepContacts({ state, onUpdate, tenantId }: StepContactsProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);

    // Client-side size check
    if (file.size > 10 * 1024 * 1024) {
      setError("הקובץ גדול מדי. מקסימום 10MB.");
      setUploading(false);
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("tenantId", tenantId);

    try {
      const res = await fetch("/api/contacts/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "שגיאה בהעלאת הקובץ");
      }

      const result = await res.json();
      onUpdate({
        uploadResult: {
          contactCount: result.contactCount,
          errors: result.errors,
          duplicatesRemoved: result.duplicatesRemoved,
          contactIds: result.contactIds,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-2">העלאת אנשי קשר</h2>
      <p className="text-sm text-gray-500 mb-6">
        העלה קובץ CSV או Excel עם אנשי הקשר. נדרשת עמודת טלפון (phone / טלפון).
      </p>

      {/* Upload area */}
      <div
        className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors cursor-pointer"
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="העלה קובץ"
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={handleFileChange}
          className="hidden"
        />
        <svg className="w-10 h-10 text-gray-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        {uploading ? (
          <p className="text-sm text-blue-600">מעלה ומעבד...</p>
        ) : (
          <>
            <p className="text-sm text-gray-600">גרור קובץ לכאן או לחץ לבחירה</p>
            <p className="text-xs text-gray-400 mt-1">CSV, XLSX, XLS -- עד 10MB</p>
          </>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-red-600 text-sm mt-4" role="alert">{error}</p>
      )}

      {/* Upload result */}
      {state.uploadResult && (
        <div className="mt-6 bg-green-50 border border-green-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-green-800 mb-2">הועלו בהצלחה</h3>
          <div className="space-y-1 text-sm text-green-700">
            <p>{state.uploadResult.contactCount} אנשי קשר נטענו</p>
            {state.uploadResult.duplicatesRemoved > 0 && (
              <p>{state.uploadResult.duplicatesRemoved} כפולים הוסרו</p>
            )}
            {state.uploadResult.errors.length > 0 && (
              <details className="mt-2">
                <summary className="text-yellow-700 cursor-pointer">
                  {state.uploadResult.errors.length} שגיאות
                </summary>
                <ul className="mt-1 space-y-0.5 text-xs text-yellow-600 list-disc list-inside max-h-32 overflow-y-auto">
                  {state.uploadResult.errors.map((err, i) => (
                    <li key={i}>שורה {err.row}: {err.reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {/* Re-upload button */}
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              onUpdate({ uploadResult: null });
              fileInputRef.current?.click();
            }}
          >
            העלה קובץ אחר
          </Button>
        </div>
      )}

      {/* File format help */}
      <div className="mt-6 bg-gray-50 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-700 mb-2">פורמט הקובץ</h3>
        <p className="text-xs text-gray-500 mb-2">
          הקובץ חייב לכלול שורת כותרת עם לפחות עמודת טלפון. עמודות מזוהות:
        </p>
        <div className="flex gap-2 flex-wrap">
          {["phone / טלפון", "name / שם", "email / אימייל"].map((col) => (
            <span key={col} className="text-xs bg-white border border-gray-200 rounded px-2 py-1">
              {col}
            </span>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-2">עמודות נוספות יישמרו כשדות מותאמים אישית.</p>
      </div>
    </div>
  );
}
