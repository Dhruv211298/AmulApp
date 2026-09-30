// ---------------------------------------------------------------------------
// Session expiry — one place that decides "this session is over, sign in again".
//
// WHY A SEPARATE MODULE
// services/api.js discovers the dead session (a token refresh that fails), but
// it is a plain module with no access to navigation. The navigator can perform
// the redirect but has no idea a request just failed. This is the wire between
// them: api.js reports, the navigator listens.
//
// WHAT COUNTS AS "OVER" — and what does not
// A token EXPIRING is normal: keys last one day, so every user's token dies
// overnight. api.js already handles that silently — it refreshes and retries,
// and the user never notices. Redirecting on a mere 401 would throw the entire
// workforce back to the login screen every single morning.
//
// This fires only when the REFRESH ITSELF FAILS, which means the server has
// actually refused the account:
//   * the employee/student was disabled
//   * an admin released the device binding on the portal
//   * the account was registered on a different device
// In those cases the stored token can never work again, so returning to Login
// is the only honest outcome.
//
// The guard below matters: one dead session usually produces SEVERAL failing
// requests at once (a screen firing three calls). Without it the user would be
// bounced, and alerted, three times.
// ---------------------------------------------------------------------------

let handler = null;
let notifying = false;

/** Register the app-wide handler. Called once by the navigator. */
export function setSessionExpiredHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

/**
 * Report that the session is unrecoverable. Safe to call from anywhere and as
 * often as it happens — only the first call in a burst is acted on.
 */
export function notifySessionExpired(reason = 'unauthorized') {
  if (notifying || !handler) return;
  notifying = true;
  try {
    handler(reason);
  } catch (e) {
    // A failing handler must never break the request that reported the problem.
  }
  // Release the latch shortly after, so a genuinely new expiry later in the
  // session can still be reported.
  setTimeout(() => {
    notifying = false;
  }, 5000);
}

/** Clear the latch immediately — called after a successful login. */
export function resetSessionExpiredLatch() {
  notifying = false;
}
