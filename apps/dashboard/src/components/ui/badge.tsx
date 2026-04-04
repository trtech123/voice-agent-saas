const colorMap = {
  green: "bg-green-100 text-green-800",
  yellow: "bg-yellow-100 text-yellow-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  gray: "bg-gray-100 text-gray-800",
  purple: "bg-purple-100 text-purple-800",
} as const;

const statusColors: Record<string, keyof typeof colorMap> = {
  active: "green",
  completed: "blue",
  paused: "yellow",
  draft: "gray",
  hot: "red",
  warm: "yellow",
  cold: "blue",
  not_interested: "gray",
  callback: "purple",
  pending: "gray",
  queued: "blue",
  calling: "yellow",
  failed: "red",
  no_answer: "yellow",
  dead_letter: "red",
  dnc: "red",
  connected: "green",
  initiated: "gray",
  ringing: "yellow",
};

interface BadgeProps {
  status: string;
  label?: string;
}

export function Badge({ status, label }: BadgeProps) {
  const color = statusColors[status] ?? "gray";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colorMap[color]}`}
    >
      {label ?? status}
    </span>
  );
}
