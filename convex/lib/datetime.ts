/**
 * Dates and times as a Nigerian reader expects them.
 *
 * ORBIT runs on one clock: West Africa Time, UTC+1, no daylight saving. Every
 * deadline, log date and attendance record in the platform is a moment in that
 * timezone, and a reminder that says "due within 48 hours" without naming the
 * time is the reminder people ask a supervisor to clarify.
 *
 * The offset is applied ARITHMETICALLY rather than through `Intl` with a
 * timeZone. Convex functions run on a runtime whose ICU data is not guaranteed
 * to carry the full timezone database, and a formatter that silently falls back
 * to UTC would shift every stated deadline by an hour — wrong in a way nobody
 * would notice until someone missed one. WAT has had no DST transitions, so the
 * arithmetic is exact.
 */

/** UTC+1, no daylight saving. Exported so cadence.ts uses one definition. */
export const WAT_OFFSET_MS = 60 * 60 * 1000;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `Friday 12 September 2026, 5:00 PM WAT`. */
export function formatWat(ms: number): string {
  const d = new Date(ms + WAT_OFFSET_MS);

  const day = DAYS[d.getUTCDay()];
  const month = MONTHS[d.getUTCMonth()];

  let hours = d.getUTCHours();
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  // 0 and 12 both display as 12, not as 0.
  hours = hours % 12 === 0 ? 12 : hours % 12;

  const minutes = String(d.getUTCMinutes()).padStart(2, '0');

  return `${day} ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hours}:${minutes} ${meridiem} WAT`;
}

/** `12 September 2026` — for a date with no meaningful time of day. */
export function formatWatDate(ms: number): string {
  const d = new Date(ms + WAT_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `2026-08-18` — the WAT calendar date for an instant, sortable and comparable. */
export function watISODate(ms: number): string {
  return new Date(ms + WAT_OFFSET_MS).toISOString().slice(0, 10);
}
