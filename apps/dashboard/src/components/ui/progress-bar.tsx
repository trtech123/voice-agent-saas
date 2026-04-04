interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  showPercentage?: boolean;
  color?: "blue" | "green" | "yellow" | "red";
}

const barColors = {
  blue: "bg-blue-600",
  green: "bg-green-600",
  yellow: "bg-yellow-500",
  red: "bg-red-600",
};

export function ProgressBar({ value, max, label, showPercentage = true, color = "blue" }: ProgressBarProps) {
  const percentage = max > 0 ? Math.round((value / max) * 100) : 0;
  const clampedPercentage = Math.min(100, Math.max(0, percentage));

  return (
    <div className="w-full">
      {(label || showPercentage) && (
        <div className="flex justify-between items-center mb-1">
          {label && <span className="text-sm text-gray-600">{label}</span>}
          {showPercentage && (
            <span className="text-sm font-medium text-gray-700">{clampedPercentage}%</span>
          )}
        </div>
      )}
      <div
        className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColors[color]}`}
          style={{ width: `${clampedPercentage}%` }}
        />
      </div>
    </div>
  );
}
