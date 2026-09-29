export function formatDistanceToNow(date: Date): string {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return 'just now';
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m ago`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}h ago`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) {
    return `${diffInDays}d ago`;
  }

  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 4) {
    return `${diffInWeeks}w ago`;
  }

  return date.toLocaleDateString();
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  // `toLocaleDateString` on an unparseable string renders the literal string
  // "Invalid Date" into the page. A dash is what an absent date looks like
  // everywhere else in the UI.
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Today's date as the user's calendar shows it, `YYYY-MM-DD`.
 *
 * NOT `new Date().toISOString().slice(0, 10)`, which is the date in UTC. Nigeria
 * is WAT (UTC+1), so between 00:00 and 01:00 local every night that expression
 * returns YESTERDAY — an intern checking in or writing "today's" log in that
 * hour had it filed and displayed under the previous calendar day. The logbook
 * is a legal record a university receives, so the day it names has to be the day
 * the member was actually there.
 */
export function todayLocalISO(): string {
  return localISODate(new Date());
}

/** A Date as its LOCAL calendar date, `YYYY-MM-DD`. */
export function localISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
