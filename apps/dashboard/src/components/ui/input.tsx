"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={id} className="block text-sm font-medium text-[#1E1B4B]/80 mb-1.5">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={`
            w-full border rounded-xl px-3.5 py-2.5 text-sm text-[#1E1B4B]
            bg-white/60 backdrop-blur-sm
            transition-all duration-200 ease-out
            focus:outline-none focus:ring-2 focus:ring-indigo-400/50 focus:border-indigo-400
            disabled:bg-slate-50 disabled:text-slate-400
            placeholder:text-slate-400
            ${error ? "border-red-400 focus:ring-red-400/50 focus:border-red-400" : "border-white/40 hover:border-indigo-300"}
            ${className}
          `}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          {...props}
        />
        {error && (
          <p id={`${id}-error`} className="mt-1.5 text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={`${id}-hint`} className="mt-1.5 text-sm text-[#1E1B4B]/50">
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
