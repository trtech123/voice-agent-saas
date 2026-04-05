const colorMap = {
  green: "bg-emerald-100 text-emerald-700 border border-emerald-200/60",
  amber: "bg-amber-100 text-amber-700 border border-amber-200/60",
  red: "bg-red-100 text-red-700 border border-red-200/60",
  blue: "bg-sky-100 text-sky-700 border border-sky-200/60",
  gray: "bg-slate-100 text-slate-600 border border-slate-200/60",
  purple: "bg-purple-100 text-purple-700 border border-purple-200/60",
  indigo: "bg-indigo-100 text-indigo-700 border border-indigo-200/60",
} as const;

const statusColors: Record<string, keyof typeof colorMap> = {
  active: "green",
  completed: "blue",
  paused: "amber",
  draft: "gray",
  hot: "red",
  warm: "amber",
  cold: "blue",
  not_interested: "gray",
  callback: "purple",
  pending: "gray",
  queued: "indigo",
  calling: "amber",
  failed: "red",
  no_answer: "amber",
  dead_letter: "red",
  dnc: "red",
  connected: "green",
  initiated: "gray",
  ringing: "amber",
};

interface BadgeProps {
  status: string;
  label?: string;
}

export function Badge({ status, label }: BadgeProps) {
  const color = statusColors[status] ?? "gray";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors duration-200 ${colorMap[color]}`}
    >
      {label ?? status}
    </span>
  );
}
