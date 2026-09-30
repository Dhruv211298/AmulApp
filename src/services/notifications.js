import { Platform, PermissionsAndroid } from 'react-native';
// MODULAR API (@react-native-firebase v22+, required from v26).
//
// The old namespaced style — `import messaging from '...'` then
// `messaging().getToken()` — was REMOVED in v26. Calling it there fails at
// runtime with "undefined is not a function", because the default export no
// longer returns an object carrying those methods.
//
// The modular form imports each function by name and passes the messaging
// instance as the first argument: getToken(msg), onTokenRefresh(msg, cb), and
// so on. Most online tutorials still show the old style — this is the current
// one, verified against the installed package.
import {
  getMessaging,
  getToken,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  requestPermission,
  getInitialNotification,
  subscribeToTopic,
  unsubscribeFromTopic,
  AuthorizationStatus,
} from '@react-native-firebase/messaging';
import { getItem, KEYS } from './storage';
import { apiPost } from './api';
import { ENDPOINTS } from '../config';

// ---------------------------------------------------------------------------
// PUSH NOTIFICATIONS (Firebase Cloud Messaging)
//
// Two delivery routes, and the difference matters:
//
//   TOPIC   — a named channel every phone subscribes to ('all_staff'). The
//             server sends ONE message and Firebase fans it out. Used for
//             admin announcements, where the text is identical for everyone.
//
//   TOKEN   — the delivery address of one app install on one phone. Used for
//             personal messages ("a visitor is waiting for you"). The server
//             needs the token stored against the employee to do this.
//
// We do both: subscribe to topics AND upload the token.
//
// ---------------------------------------------------------------------------
// THE TOKEN RULE — the bug this file exists to avoid
//
// A token belongs to the APP INSTALL, not the person. Reinstalling the app,
// clearing its data, or restoring from a backup issues a NEW token and kills
// the old one. Firebase also rotates them on its own occasionally.
//
// The legacy Milk Indent app saved the token once, at first registration
// (milkindent/login.php:105 INSERT, with the refresh UPDATE commented out on
// line 53). Over the years users reinstalled, the stored token went stale, and
// notifications quietly stopped arriving — with nothing in any log to say so.
//
// So: registerForPush() runs on EVERY app start after login, not once at
// registration, and the server-side endpoint UPDATEs the row rather than
// inserting a new one.
// ---------------------------------------------------------------------------

// Topics. Names must be [a-zA-Z0-9-_.~%]+ — no spaces, or subscribe() throws.
export const TOPICS = {
  ALL: 'all_staff',
  EMPLOYEES: 'employees',
  STUDENTS: 'students',
};

// Remembers which topics this install is subscribed to, so logout can undo
// exactly those. Firebase has no "list my subscriptions" API to ask.
let subscribedTopics = [];

/**
 * Ask the OS for permission to show notifications.
 *
 * iOS: always required; shows the system prompt the first time.
 * Android 13+: required, prompts via POST_NOTIFICATIONS.
 * Android 12 and below: granted at install, resolves true immediately.
 *
 * Returns true/false. NEVER throws — a refused permission is a normal outcome,
 * not an error, and must not break login.
 */
export async function requestNotificationPermission() {
  try {
    // ANDROID: ask through React Native's own PermissionsAndroid.
    //
    // Firebase's requestPermission() is iOS-only in practice. Its Android
    // implementation (NativeRNFBTurboMessaging.java) is literally
    //     promise.resolve(1);
    // — it reports "authorized" without showing anything. The library even
    // marks it deprecated for this reason. On Android 13+ that means the
    // POST_NOTIFICATIONS prompt never appears, the permission is never granted,
    // and the OS silently suppresses every tray notification — while
    // onMessage() keeps firing in the foreground, because that is just data
    // reaching JS. The symptom is "works with the app open, nothing when it's
    // closed", which looks like a delivery problem and isn't.
    //
    // Below API 33 the permission does not exist as a runtime prompt; it is
    // granted at install, and request() resolves GRANTED immediately.
    if (Platform.OS === 'android') {
      if (Platform.Version < 33) return true;
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }

    // iOS: Firebase's call is the real one here — it shows the system prompt
    // and registers with APNs.
    const status = await requestPermission(getMessaging());
    return (
      status === AuthorizationStatus.AUTHORIZED ||
      status === AuthorizationStatus.PROVISIONAL
    );
  } catch (e) {
    return false;
  }
}

/**
 * Send the current token to the backend.
 *
 * Goes through apiPost, so it inherits the whole security path already built
 * for this app: the session token, device_id, the 401 refresh-and-retry, and
 * the "Signed Out" redirect when a session is genuinely dead.
 *
 * Failure is deliberately SILENT. If this call fails the user still gets a
 * working app; they just miss personal push messages until the next launch,
 * when it is attempted again. An alert here would be noise the user can do
 * nothing about.
 */
async function uploadToken(token) {
  try {
    const employeeId = await getItem(KEYS.userId);
    if (!employeeId || !token) return false;

    const res = await apiPost(ENDPOINTS.saveFcmToken, {
      employee_id: employeeId,
      fcm_token: token,
      platform: Platform.OS,
    });
    return !!res && String(res.statusCode) === '200';
  } catch (e) {
    return false;
  }
}

/** Subscribe to a topic, remembering it so logout can reverse it. */
async function subscribe(topic) {
  try {
    await subscribeToTopic(getMessaging(), topic);
    if (!subscribedTopics.includes(topic)) subscribedTopics.push(topic);
  } catch (e) {
    // A failed subscribe is not fatal — the in-app announcement list still
    // shows the message; only the push banner is missed.
  }
}

/**
 * Full registration. Call AFTER login, on every app start.
 *
 * Order matters: permission first (no permission means iOS will not even
 * issue a token), then the token, then topics.
 */
export async function registerForPush() {
  const allowed = await requestNotificationPermission();
  if (!allowed) return { ok: false, reason: 'permission-denied' };

  let token = null;
  try {
    token = await getToken(getMessaging());
  } catch (e) {
    return { ok: false, reason: 'token-failed' };
  }
  if (!token) return { ok: false, reason: 'token-empty' };

  // DEV ONLY. __DEV__ is false in release builds, so this never ships — but it
  // makes the token copyable from the Metro console, which is how you send a
  // test message from the Firebase Console before any server code exists.
  // Never log this in production: a token is a delivery address, and anyone
  // holding it plus the project credentials could push to that phone.
  if (__DEV__) {
    console.log('[FCM] token:', token);
  }

  await uploadToken(token);

  // Everyone gets announcements; the second topic splits employees from
  // students so the admin page can address either group alone.
  await subscribe(TOPICS.ALL);
  const userType = (await getItem(KEYS.userType)) || '';
  if (userType === 'e') await subscribe(TOPICS.EMPLOYEES);
  else if (userType === 's') await subscribe(TOPICS.STUDENTS);

  return { ok: true, token };
}

/**
 * The current FCM token for this install, or '' if unavailable.
 *
 * Cheap to call: getToken() returns the value Firebase already holds and only
 * goes to the network when there is no token yet. Returns '' rather than
 * throwing, because callers embed it in a URL — a portal must still open when
 * notifications are unavailable (permission refused, Play Services missing).
 *
 * Used by PortalWebView to hand the token to the Milk Indent portal, whose
 * login.php stores whatever arrives in `token_id` as the FCM address.
 */
export async function getFcmToken() {
  try {
    const t = await getToken(getMessaging());
    return t || '';
  } catch (e) {
    return '';
  }
}

/**
 * Watch for Firebase rotating the token mid-session and push the new one up.
 * Returns an unsubscribe function.
 *
 * Without this, a rotation between two app launches leaves the server holding
 * a dead address until the user next restarts the app.
 */
export function watchTokenRefresh() {
  try {
    return onTokenRefresh(getMessaging(), newToken => {
      uploadToken(newToken);
    });
  } catch (e) {
    // Firebase not configured on this platform (e.g. iOS before the plist /
    // FirebaseApp.configure() are in place). Notifications are simply
    // unavailable — the app must still run. Return a no-op unsubscribe so the
    // caller's cleanup stays uniform.
    return () => {};
  }
}

/**
 * Undo everything on logout.
 *
 * These phones are shared on the plant floor. Without unsubscribing, the next
 * person to log in would keep receiving messages addressed to the previous
 * user's group — a real privacy problem, not a cosmetic one.
 */
export async function unregisterFromPush() {
  for (const topic of subscribedTopics) {
    try {
      await unsubscribeFromTopic(getMessaging(), topic);
    } catch (e) {
      // Best effort; the server-side token clear is the real guarantee.
    }
  }
  subscribedTopics = [];
}

/**
 * Foreground messages.
 *
 * IMPORTANT: Firebase draws NOTHING while the app is open. The OS only renders
 * the banner when the app is backgrounded or closed. Whatever the user should
 * see while looking at the app, this handler has to produce.
 *
 * `handler` receives { title, body, data }.
 * Returns an unsubscribe function.
 */
export function onForegroundMessage(handler) {
  try {
    return onMessage(getMessaging(), async remoteMessage => {
      const n = (remoteMessage && remoteMessage.notification) || {};
      handler({
        title: n.title || '',
        body: n.body || '',
        data: (remoteMessage && remoteMessage.data) || {},
      });
    });
  } catch (e) {
    return () => {};   // Firebase unavailable — see watchTokenRefresh
  }
}

/**
 * The user TAPPED a notification and the app was in the background.
 * Returns an unsubscribe function.
 */
export function onNotificationOpened(handler) {
  try {
    return onNotificationOpenedApp(getMessaging(), remoteMessage => {
      if (remoteMessage) handler(remoteMessage.data || {});
    });
  } catch (e) {
    return () => {};   // Firebase unavailable — see watchTokenRefresh
  }
}

/**
 * The user tapped a notification while the app was fully CLOSED — this is what
 * cold-started it. Call once at startup.
 *
 * Returns the data payload, or null if the app was opened normally.
 */
export async function getOpeningNotification() {
  try {
    const remoteMessage = await getInitialNotification(getMessaging());
    return remoteMessage ? remoteMessage.data || {} : null;
  } catch (e) {
    return null;
  }
}
