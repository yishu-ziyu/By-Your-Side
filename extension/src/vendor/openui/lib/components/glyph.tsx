import { icons, type LucideIcon } from "lucide-react";

/** "map-pin", "MapPin", "map_pin" and "map pin" all mean the lucide icon MapPin. */
function iconOf(value: unknown): LucideIcon | null {
  if (typeof value !== "string") return null;
  const key = value.trim().replace(/[\s_-]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase()).replace(/^./, (c) => c.toUpperCase());
  return (icons as Record<string, LucideIcon>)[key] ?? null;
}

/** A lucide icon. Unknown names render nothing. */
export function Glyph({ name, size = 18, className }: { name: unknown; size?: number; className?: string }) {
  const Icon = iconOf(name);
  return Icon ? <Icon size={size} strokeWidth={1.8} aria-hidden className={className} /> : null;
}
