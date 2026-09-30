import { getItem, setItem, KEYS } from './storage';
import { getDeviceId } from './device';
import { notifySessionExpired } from './session';
import { BASE_URL, ENDPOINTS } from '../config';

// Re-exported for callers that build their own URLs.
export { BASE_URL };

// ---------------------------------------------------------------------------
// EVERY network request in this app must go through fetchTextWithTimeout
// (or, for callers that need the raw Response object, fetchWithTimeout).
//
// React Native's fetch has NO timeout: a connection that hangs (silently
// dropped by a firewall, dead Wi-Fi, WAF challenge) never resolves and never
// rejects — the caller's spinner runs forever. That exact failure produced an
// App Store rejection (Guideline 2.1(a): "App loaded indefinitely during
// login"). A bounded request turns an infinite hang into a normal, catchable
// error that the UI already knows how to show.
// ---------------------------------------------------------------------------
export const REQUEST_TIMEOUT_MS = 15000;

export function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { ...options, signal: controller.signal })
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(
          err && err.name === 'AbortError'
            ? new Error('Request timed out. Please check your connection and try again.')
            : err,
        );
      });
  });
}

// The COMPLETE request — headers AND body — inside one abort window.
//
// fetchWithTimeout alone has a subtle hole: it clears the timer when response
// HEADERS arrive, so a server (or middlebox) that sends "200 OK" and then
// stalls the body would hang `res.text()` forever — the same infinite-spinner
// bug class, one step later in the request. This helper keeps the abort timer
// armed until the body is fully read. All JSON/text API calls use THIS.
export async function fetchTextWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = (await res.text()) || '';
    return { text, status: res.status, ok: res.ok };
  } catch (err) {
    throw err && err.name === 'AbortError'
      ? new Error('Request timed out. Please check your connection and try again.')
      : err;
  } finally {
    clearTimeout(timer);
  }
}

// Token endpoint — app_token_checker reuses today's key (idempotent), so calling
// it to refresh is cheap and never mints duplicate keys within a day.
const TOKEN_URL = ENDPOINTS.tokenCheck;

// Does a response body look like the server REJECTED the token (expired / invalid
// / signed-in-elsewhere)? Kept deliberately narrow — matches auth phrases only —
// so a normal business error ("No Record Found") never triggers a needless
// refresh. Tune this regex to match whatever your endpoints emit on auth failure.
const AUTH_FAIL_RE =
  /(unauthor|invalid token|token (is )?(invalid|expired)|session (has )?expired|not authori[sz]ed|expired or invalid|disabled or (is )?invalid|please (re-?)?login|login again|register again)/i;

// Exported for unit testing — this regex decides whether the app silently
// refreshes the token or surfaces a business error, so it is worth pinning down
// with tests. A false positive causes a needless refresh; a false negative
// leaves the user stuck behind an expired token.
export function looksUnauthorized(status, text) {
  if (status === 401 || status === 403) return true;
  return !!text && AUTH_FAIL_RE.test(text);
}

// Refresh the API token via app_token_checker. Stores + returns the new token,
// or null if it couldn't be refreshed (offline, disabled, superseded device).
// Concurrent callers share a single in-flight refresh.
let refreshInFlight = null;
export function refreshToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const employeeId = await getItem(KEYS.userId);
      const deviceId = await getDeviceId();
      if (!employeeId || !deviceId) return null;

      const body = new FormData();
      body.append('employee_id', employeeId);
      body.append('device_id', deviceId);

      const { text } = await fetchTextWithTimeout(TOKEN_URL, { method: 'POST', body });
      const data = JSON.parse(text);
      if (data && String(data.emp_status) === '1' && data.token) {
        await setItem(KEYS.apiToken, String(data.token));
        if (data.token_date) await setItem(KEYS.tokenDate, String(data.token_date));
        if (data.nu_plant_code != null) await setItem(KEYS.plantNo, String(data.nu_plant_code));
        if (data.vc_plant_code != null) await setItem(KEYS.plantCode, String(data.vc_plant_code));
        return String(data.token);
      }
      return null;
    } catch (e) {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// Core request: attach the current token + identifiers, send, and — if the
// response looks like a token rejection — refresh the token ONCE and retry.
// Returns the raw response text.
async function requestRaw(endpoint, fields, timeoutMs) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}/${endpoint}`;

  const send = async token => {
    const [username, userType, deviceId] = await Promise.all([
      getItem(KEYS.username),
      getItem(KEYS.userType),
      getDeviceId(),
    ]);
    const body = new FormData();
    Object.entries(fields).forEach(([k, v]) => body.append(k, v));
    if (token) body.append('token', token);
    if (username) body.append('username', username);
    if (userType) body.append('user_type', userType);
    // device_id on EVERY request — require_token.php binds the token to this
    // device, so the guard needs it. Only appended when the caller hasn't
    // already supplied one (some screens send it explicitly), so an explicit
    // value is never overwritten.
    if (deviceId && !('device_id' in fields)) body.append('device_id', deviceId);

    const { text, status } = await fetchTextWithTimeout(
      url,
      { method: 'POST', body },
      timeoutMs, // undefined -> REQUEST_TIMEOUT_MS default
    );
    return { text, status };
  };

  const token = await getItem(KEYS.apiToken);
  let { text, status } = await send(token);

  // Self-heal: on an auth-rejection response, refresh the token once and retry.
  //
  // A 401 is USUALLY harmless — API keys expire daily, so every user hits this
  // each morning. refreshToken() mints a new one and the retry succeeds with
  // the user noticing nothing.
  //
  // If the refresh ITSELF fails, the server has refused the account outright
  // (disabled, device released by an admin, or registered on another device).
  // No stored credential can recover that, so the session is reported as over
  // and the navigator returns the user to Login. Reporting only on refresh
  // FAILURE is what stops a routine overnight expiry from bouncing everyone
  // out of the app.
  if (looksUnauthorized(status, text)) {
    const fresh = await refreshToken();
    if (fresh && fresh !== token) {
      ({ text } = await send(fresh));
    } else {
      // Session is unrecoverable. Report it (navigator shows ONE "Signed Out"
      // alert and resets to Login) and throw a TAGGED error so the calling
      // screen can swallow it instead of showing its own second alert on top.
      // Every caller already has a try/catch; they check err.sessionExpired and
      // return quietly. Screens that don't check it simply catch it like any
      // other error — still no raw body rendered.
      notifySessionExpired('refresh-failed');
      const err = new Error('session-expired');
      err.sessionExpired = true;
      throw err;
    }
  }
  return text;
}

// Generic POST helper. Sends FormData, attaches the saved session token + user
// identifiers, and self-heals a rejected token. Returns parsed JSON.
//
// `options.timeoutMs` overrides the default 15s bound for endpoints that
// legitimately take longer (e.g. a report over a large date range). The
// request is still ALWAYS bounded — just with a limit that fits the work.
export async function apiPost(endpoint, fields = {}, options = {}) {
  const text = await requestRaw(endpoint, fields, options.timeoutMs);
  try {
    return JSON.parse(text);
  } catch (e) {
    // Endpoint missing or returned HTML/error page — surface a clean error.
    throw new Error('Invalid or empty server response');
  }
}

// Same as apiPost but returns the raw response text (for endpoints that reply
// with plain text instead of JSON, e.g. get_location_name_qr.php).
export async function apiPostText(endpoint, fields = {}, options = {}) {
  const text = await requestRaw(endpoint, fields, options.timeoutMs);
  return (text || '').trim();
}
