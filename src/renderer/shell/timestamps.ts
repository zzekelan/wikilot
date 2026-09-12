/** Timestamp dividers between Timeline messages (5-minute gap / day boundary). */

export const TIMESTAMP_VISIBLE_GAP_MS = 5 * 60 * 1000;

export function shouldShowTimestamp(
  previousAt: number | undefined,
  at: number,
): boolean {
  if (previousAt === undefined) return true;
  const previous = new Date(previousAt);
  const current = new Date(at);
  const sameDay =
    previous.getFullYear() === current.getFullYear() &&
    previous.getMonth() === current.getMonth() &&
    previous.getDate() === current.getDate();
  if (!sameDay) return true;
  return at - previousAt >= TIMESTAMP_VISIBLE_GAP_MS;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** HH:MM same day · MM/DD HH:MM same year · YYYY/MM/DD HH:MM otherwise. */
export function formatTimestampLabel(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const reference = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate();
  if (sameDay) return time;
  const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  if (date.getFullYear() === reference.getFullYear()) return `${day} ${time}`;
  return `${date.getFullYear()}/${day} ${time}`;
}

/** Session rail subline: "now" · "Nm/Nh/Nd ago" · MM/DD · YYYY/MM/DD. */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(at);
  const reference = new Date(now);
  const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  if (date.getFullYear() === reference.getFullYear()) return day;
  return `${date.getFullYear()}/${day}`;
}
