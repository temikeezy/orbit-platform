/**
 * HTML escaping for outbound email bodies.
 *
 * Lives here rather than beside one caller because there are two independent
 * paths that build email HTML from text somebody typed, and only one of them
 * escaped it. `emailQueue.adminEnqueue` did; `notificationsInternal` — which
 * generates far more mail, on every new task, message and review — interpolated
 * raw content straight into `<p>${content}</p>`.
 *
 * That made any authenticated member able to put arbitrary markup into an email
 * sent from ORBIT's own domain: send a direct message whose body closes the
 * paragraph and opens an anchor, and the recipient gets a link of the sender's
 * choosing above ORBIT's genuine button. `bodyText` stayed clean, so nothing in
 * the queue row looked wrong.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validates an in-app link before it is stored or emailed.
 *
 * Notification `actionUrl`s are rendered as hrefs by the client and pasted into
 * emails here. Anything absolute lets a caller point an ORBIT-branded link at
 * their own host; `javascript:` and `data:` are worse. Only same-app paths are
 * accepted — `/tasks/abc`, not `//evil.example` (protocol-relative) and not
 * `/\evil.example`, both of which browsers resolve off-origin.
 */
export function isSafeActionUrl(url: string): boolean {
  return /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/.test(url);
}
