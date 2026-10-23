// Popup dismissal helpers.
//
// Chrome normally closes an action popup when it loses focus, but the fallback
// is useful in environments where that native dismissal does not fire. A
// download needs a short grace period because closing the popup immediately
// after creating the blob URL can prevent Chrome from committing the file.

export const DOWNLOAD_DISMISS_GRACE_MS = 2000;

// Return the remaining number of milliseconds before the popup may close.
// A zero value means it can close immediately.
export function getPopupDismissDelay(dismissHoldUntil, now = Date.now()) {
  if (!dismissHoldUntil) return 0;

  const remaining = dismissHoldUntil - now;
  return remaining > 0 ? remaining : 0;
}
