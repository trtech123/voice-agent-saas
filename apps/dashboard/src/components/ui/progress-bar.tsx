interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  showPercentage?: boolean;
  color?: "indigo" | "green" | "amber" | "red";
}

const barColors = {
  indigo: "bg-gradient-to-l from-indigo-500 to-indigo-400",
  green: "bg-gradient-to-l from-emerald-500 to-emerald-400",
  amber: "bg-gradient-to-l from-amber-500 to-amber-400",
  red: "bg-gradient-to-l from-red-500 to-red-400",
};

export function ProgressBar({ value, max, label, showPercentage = true, color = "indigo" }: ProgressBarProps) {
  const percentage = max > 0 ? Math.round((value / max) * 100) : 0;
  const clampedPercentage = Math.min(100, Math.max(0, percentage));

  return (
    <div className="w-full">
      {(label || showPercentage) && (
        <div className="flex justify-between items-center mb-1.5">
          {label && <span className="text-sm text-[#1E1B4B]/60">{label}</span>}
          {showPercentage && (
            <span className="text-sm font-medium text-[#1E1B4B]/80">{clampedPercentage}%</span>
          )}
        </div>
      )}
      <div
        className="w-full bg-indigo-100/50 rounded-full h-2.5 overflow-hidden"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${barColors[color]}`}
          style={{ width: `${clampedPercentage}%` }}
        />
      </div>
    </div>
  );
}
