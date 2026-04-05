import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && (
        <div className="w-20 h-20 rounded-2xl bg-indigo-100/60 backdrop-blur-sm flex items-center justify-center text-indigo-400 mb-5">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-[#1E1B4B] mb-1.5">{title}</h3>
      {description && <p className="text-sm text-[#1E1B4B]/50 mb-5 max-w-sm">{description}</p>}
      {action}
    </div>
  );
}
