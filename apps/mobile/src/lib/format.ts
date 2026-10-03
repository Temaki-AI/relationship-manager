export function getGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function formatDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatRelativeDate(value: string | null, now = new Date()): string {
  if (!value) return 'No touch logged yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No touch logged yet';
  const days = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
