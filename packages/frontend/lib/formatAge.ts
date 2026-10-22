/** "4 s", "3 min", "2 h": an age a person reads at a glance. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}
