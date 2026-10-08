// In-app alerts (C8), without React: an alert is a synced record (entity 'alert') made by the
// server when an automation set to "alert" creates something. Both people get every alert; each
// marks it read on their own field (read_by_owner / read_by_partner — booleans, so two devices of
// one person marking it read offline agree and never clash). Tested in client/test/automations.test.js.

/** The field holding `me`'s read flag. */
export function readField(me) {
  return `read_by_${me}`;
}

export function isUnread(alert, me) {
  return Boolean(alert) && !alert[readField(me)];
}

/** Unread alerts for `me`, newest first. */
export function unreadAlerts(alerts, me) {
  return alerts.filter((a) => isUnread(a, me)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** The change that marks an alert read for `me`: { read_by_owner: true }. (There is no "unread": read is final.) */
export function readChange(me) {
  return { [readField(me)]: true };
}

/** "3 new alerts" / "1 new alert". */
export function unreadText(n) {
  return `${n} new alert${n === 1 ? '' : 's'}`;
}

/** An alert's link if it is an in-app path (never an outside address). */
export function safeLink(link) {
  return typeof link === 'string' && /^\/(?!\/)/.test(link) ? link : null;
}
