import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { getItem, setItem, removeItem, KEYS } from './storage';

// ---------------------------------------------------------------------------
// Face ID / Touch ID / fingerprint unlock.
//
// WHAT THIS ACTUALLY DOES, because the usual implementation of this feature is
// insecure and it is worth being explicit about the difference:
//
//   The common (bad) pattern is to store a boolean "biometrics_enabled", run
//   the scanner, and — if it succeeds — read the PIN out of AsyncStorage and
//   log the user in. That is theatre. AsyncStorage is an unencrypted SQLite
//   file; on a rooted/jailbroken device (or any device with a debug build and
//   `adb run-as`) an attacker flips the boolean, skips the scanner entirely,
//   and reads the PIN in plaintext while they are in there.
//
//   What this module does instead: the PIN is written into the iOS Keychain /
//   Android Keystore under an access-control policy, and the ONLY way to read
//   it back is for the operating system to first verify a live biometric. The
//   secret is held by the Secure Enclave / TEE, not by our JavaScript. There is
//   no code path in this app that can produce the PIN without a real face or
//   finger, because the decryption key never leaves hardware.
//
//   Consequence worth understanding: a successful unlock RETURNS THE PIN, and
//   that PIN then goes down the exact same handleLogin() path as a typed one —
//   including the server-side app_token_checker call. Biometrics are a faster
//   way to produce the PIN, not a way to bypass the checks after it.
//
// This also closes finding H1 (the PIN sitting in AsyncStorage) for every user
// who turns the feature on. The AsyncStorage copy is still the fallback for
// users who don't, so H1 is reduced, not yet eliminated.
//
// ACCESS_CONTROL.BIOMETRY_CURRENT_SET is deliberate. BIOMETRY_ANY would keep
// working after someone adds a new fingerprint to the device — so an attacker
// who learns the device passcode could enrol their own finger and inherit the
// victim's app login. CURRENT_SET binds the stored PIN to the exact set of
// biometrics enrolled at the time it was saved: enrol a new face or finger and
// the OS destroys the key. The user is then dropped back to the PIN, which is
// precisely the behaviour that was asked for.
// ---------------------------------------------------------------------------

// Keychain "service" this app's secret lives under. Constant, so a rename of
// the bundle id can never orphan an existing entry.
const SERVICE = 'com.amulapp.loginpin';

// Written into the keychain alongside the PIN. Never used for auth — it just
// makes the entry identifiable if anyone inspects the keychain.
const ACCOUNT_LABEL = 'amulapp-pin';

// Storage/access policy for the secret.
//
// iOS: WHEN_PASSCODE_SET_THIS_DEVICE_ONLY means the item cannot exist on a
// device with no passcode, never syncs to iCloud, and never restores onto a
// different device from a backup.
//
// Android: STORAGE_TYPE.AES_GCM is the biometry-gated Keystore mode. Note this
// makes WRITES require a scan too, which is why enable() shows a prompt.
const WRITE_OPTIONS = {
  service: SERVICE,
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
  accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  storage: Platform.OS === 'android' ? Keychain.STORAGE_TYPE.AES_GCM : undefined,
};

const READ_OPTIONS = {
  service: SERVICE,
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
};

// --- Naming ----------------------------------------------------------------
// Never say "Face ID" on an Android phone or "fingerprint" on an iPhone X —
// users read that as the app being broken. Ask the OS what it actually has.

const LABELS = {
  [Keychain.BIOMETRY_TYPE.FACE_ID]: 'Face ID',
  [Keychain.BIOMETRY_TYPE.TOUCH_ID]: 'Touch ID',
  [Keychain.BIOMETRY_TYPE.OPTIC_ID]: 'Optic ID',
  [Keychain.BIOMETRY_TYPE.FINGERPRINT]: 'Fingerprint',
  [Keychain.BIOMETRY_TYPE.FACE]: 'Face Unlock',
  [Keychain.BIOMETRY_TYPE.IRIS]: 'Iris Unlock',
};

// Which glyph the login screen should draw. 'face' | 'finger'.
const SHAPES = {
  [Keychain.BIOMETRY_TYPE.FACE_ID]: 'face',
  [Keychain.BIOMETRY_TYPE.OPTIC_ID]: 'face',
  [Keychain.BIOMETRY_TYPE.FACE]: 'face',
  [Keychain.BIOMETRY_TYPE.IRIS]: 'face',
  [Keychain.BIOMETRY_TYPE.TOUCH_ID]: 'finger',
  [Keychain.BIOMETRY_TYPE.FINGERPRINT]: 'finger',
};

// Shown when the OS won't tell us the sensor type — which, per the note in
// getCapability(), is also what happens when nothing has been enrolled yet, so
// we can't name the sensor and have to stay generic.
const GENERIC_LABEL =
  Platform.OS === 'ios' ? 'Face ID / Touch ID' : 'Fingerprint or face unlock';

/**
 * What this device can do, right now.
 *
 * Returns { ready, type, label, shape, blocker }:
 *
 *   ready   — usable this second. The login screen needs this and nothing else.
 *   blocker — why not, when ready is false:
 *               'no-screen-lock' — no PIN/pattern/passcode on the phone at all.
 *                                  Biometrics cannot exist without one.
 *               'not-enrolled'   — screen lock is set, but no face or finger
 *                                  has been registered (or the phone has no
 *                                  sensor — see below).
 *
 * IMPORTANT, and the reason the Settings screen behaves the way it does:
 * getSupportedBiometryType() returns null for BOTH "no sensor" and "sensor,
 * nothing enrolled". On iOS canEvaluatePolicy() fails when nothing is enrolled;
 * on Android the library gates on BiometricManager.canAuthenticate(
 * BIOMETRIC_STRONG) == SUCCESS, which also requires an enrolment. So a brand
 * new phone whose owner has not registered a fingerprint yet is indistinguishable
 * from a phone with no reader, without writing a native module.
 *
 * Given that, 'not-enrolled' is treated as "probably enrollable" and Settings
 * shows the row with instructions rather than hiding it — a user who has simply
 * not set up their fingerprint yet is far more common than a user with no
 * sensor, and hiding the row leaves the first group with no way to discover the
 * feature exists.
 *
 * Never throws: on any failure the caller gets ready:false and the app behaves
 * exactly as it did before this feature existed.
 */
export async function getCapability() {
  let type = null;
  let hasScreenLock = true;

  try {
    type = await Keychain.getSupportedBiometryType();
  } catch (e) {
    type = null;
  }

  if (type) {
    return {
      ready: true,
      type,
      label: LABELS[type] || 'Biometric unlock',
      shape: SHAPES[type] || 'finger',
      blocker: null,
    };
  }

  // Not usable. Work out which of the two messages to give the user.
  try {
    hasScreenLock = await Keychain.isPasscodeAuthAvailable();
  } catch (e) {
    hasScreenLock = true; // the less alarming assumption
  }

  return {
    ready: false,
    type: null,
    label: GENERIC_LABEL,
    shape: Platform.OS === 'ios' ? 'face' : 'finger',
    blocker: hasScreenLock ? 'not-enrolled' : 'no-screen-lock',
  };
}

/**
 * Has the user turned this on, and is the secret still actually there?
 *
 * Both halves matter. The flag alone lies after the OS destroys the key (new
 * fingerprint enrolled, passcode removed, app data restored to another
 * device), and hasGenericPassword alone can't tell opt-in from leftovers. If
 * they disagree, the keychain wins and the stale flag is cleaned up here.
 */
export async function isEnabled() {
  try {
    if ((await getItem(KEYS.biometricEnabled)) !== 'true') return false;
    const present = await Keychain.hasGenericPassword({ service: SERVICE });
    if (!present) {
      await removeItem(KEYS.biometricEnabled);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Turn the feature on: seal `pin` into the Keychain/Keystore behind biometrics.
 *
 * Only call this with a PIN the user has JUST proved they know. Enrolling a
 * PIN the current holder of the phone never entered would let someone bind
 * their own face to an account they only borrowed.
 *
 * On Android this shows a scanner prompt (AES_GCM requires auth to encrypt as
 * well as decrypt); on iOS the write is silent. Returns { ok, reason }.
 */
export async function enable(pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) {
    return { ok: false, reason: 'invalid-pin' };
  }
  const cap = await getCapability();
  if (!cap.ready) return { ok: false, reason: 'unavailable' };

  try {
    // Clear any previous entry first. Overwriting an item whose key the OS has
    // already invalidated fails on some Android builds; deleting is reliable.
    await Keychain.resetGenericPassword({ service: SERVICE }).catch(() => {});

    const saved = await Keychain.setGenericPassword(ACCOUNT_LABEL, String(pin), {
      ...WRITE_OPTIONS,
      authenticationPrompt: {
        title: `Confirm your ${cap.label}`,
        subtitle: 'This links your login PIN to this device',
        description: '',
        cancel: 'Cancel',
      },
    });

    if (!saved) {
      // The entry was already deleted above, so leaving the flag on would
      // advertise a scanner with nothing behind it until isEnabled() next
      // self-heals. Clear it now.
      await removeItem(KEYS.biometricEnabled).catch(() => {});
      return { ok: false, reason: 'failed' };
    }
    await setItem(KEYS.biometricEnabled, 'true');
    return { ok: true, reason: null };
  } catch (e) {
    // Leave the flag off — a half-enrolled state where the app promises a
    // scanner it can't deliver is worse than not enrolling at all.
    await removeItem(KEYS.biometricEnabled).catch(() => {});
    return { ok: false, reason: classify(e) };
  }
}

/**
 * Run the scanner and, on success, hand back the stored PIN.
 *
 * Returns { ok: true, pin } or { ok: false, reason } where reason is one of:
 *   'cancelled'   — user dismissed the prompt. Not an error; say nothing.
 *   'invalidated' — biometrics changed on the device, or the passcode was
 *                   removed. The secret is gone; the flag has been cleared and
 *                   the user must re-enable after a PIN login.
 *   'unavailable' — no usable biometric hardware/enrolment.
 *   'no-secret'   — nothing stored (shouldn't happen; treated as not enabled).
 *   'failed'      — scan didn't match, or the OS refused for another reason.
 */
export async function unlock(promptTitle) {
  const cap = await getCapability();
  if (!cap.ready) return { ok: false, reason: 'unavailable' };

  try {
    const creds = await Keychain.getGenericPassword({
      ...READ_OPTIONS,
      authenticationPrompt: {
        title: promptTitle || `Unlock with ${cap.label}`,
        subtitle: '',
        description: '',
        cancel: 'Use PIN instead',
      },
    });

    if (!creds || !creds.password) {
      // iOS does NOT throw when the enrolled set changes — it deletes the item
      // outright, so SecItemCopyMatching returns errSecItemNotFound and the
      // library resolves `false` instead of rejecting. Without this check the
      // most important case on iOS (someone re-enrolled Face ID) would be
      // reported as a vague "unavailable" and the flag would stay on.
      // If the item is genuinely gone, that IS the invalidation.
      let present = false;
      try {
        present = await Keychain.hasGenericPassword({ service: SERVICE });
      } catch (e) {}
      if (!present) {
        await disable().catch(() => {});
        return { ok: false, reason: 'invalidated' };
      }
      return { ok: false, reason: 'no-secret' };
    }
    return { ok: true, pin: creds.password, reason: null };
  } catch (e) {
    const reason = classify(e);
    if (reason === 'invalidated') {
      // The OS threw the key away. Tidy up so the login screen stops offering
      // a scanner that can no longer work, and so isEnabled() tells the truth.
      await disable().catch(() => {});
    }
    return { ok: false, reason };
  }
}

/**
 * Should we offer to switch this on after a successful PIN login?
 *
 * True only when the device can do it AND the user has neither enabled it nor
 * already said no. The flag carries three states rather than two — unset,
 * 'true', 'declined' — so declining is remembered without a second storage key.
 * Asking on every single login is how a helpful prompt becomes an annoyance.
 */
export async function shouldOffer() {
  try {
    const flag = await getItem(KEYS.biometricEnabled);
    if (flag === 'true' || flag === 'declined') return false;
    const cap = await getCapability();
    return cap.ready ? cap : false;
  } catch (e) {
    return false;
  }
}

/** Remember "not now" so the offer isn't repeated at every login. */
export async function declineOffer() {
  try {
    await setItem(KEYS.biometricEnabled, 'declined');
  } catch (e) {}
}

/**
 * Turn the feature off and destroy the stored PIN.
 * Also the correct call when switching user or wiping the account.
 */
export async function disable() {
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch (e) {
    // Fall through: the flag must come off even if the delete failed, so the
    // app stops offering biometrics. A stale keychain entry is inert — nothing
    // reads it once the flag is gone, and enable() deletes before it writes.
  }
  try {
    await removeItem(KEYS.biometricEnabled);
  } catch (e) {}
  return true;
}

/**
 * Keep the sealed copy in step with a PIN the user just changed.
 * No-op when biometrics were never enabled.
 *
 * Deliberately does NOT gate on isEnabled(): that function swallows storage
 * errors and returns false, and a false negative here is the worst possible
 * outcome — the keychain would keep the OLD PIN while the flag still says
 * enabled, so the user's own fingerprint would start feeding a stale PIN into
 * handleLogin and counting against the brute-force lockout. Instead it asks
 * the keychain directly whether a secret exists, and on ANY doubt it tears the
 * enrolment down. Losing biometrics and being told so is recoverable in two
 * taps; silently locking someone out with their own finger is not.
 */
export async function syncPin(newPin) {
  let present;
  try {
    present = await Keychain.hasGenericPassword({ service: SERVICE });
  } catch (e) {
    // Couldn't even ask. Assume something is sealed and destroy it.
    await disable();
    return { ok: false, changed: true, reason: 'failed' };
  }

  if (!present) {
    // Nothing sealed. Make sure the flag agrees, then there is nothing to do.
    try {
      if ((await getItem(KEYS.biometricEnabled)) === 'true') {
        await removeItem(KEYS.biometricEnabled);
      }
    } catch (e) {}
    return { ok: true, changed: false, reason: null };
  }

  const res = await enable(newPin);
  if (!res.ok) await disable();
  return { ok: res.ok, changed: true, reason: res.reason };
}

// --- Error classification --------------------------------------------------
// react-native-keychain surfaces platform errors as Error objects whose shape
// differs per OS and per Android vendor, so this matches on text. Matching on
// strings is fragile by nature; the fallback is 'failed', which is always safe
// because every caller's response to 'failed' is "fall back to the PIN".

function classify(e) {
  const msg = `${(e && (e.message || e.code)) || ''}`.toLowerCase();

  // User dismissed the sheet, or the system withdrew it. iOS: -128 / "user
  // canceled". Android BiometricPrompt: ERROR_NEGATIVE_BUTTON (13),
  // ERROR_USER_CANCELED (10), ERROR_CANCELED (5 — fired when the app is
  // backgrounded mid-prompt, e.g. an incoming call). 5 must land here and not
  // in the default branch, or answering the phone would burn a retry.
  if (
    msg.includes('cancel') ||
    msg.includes('-128') ||
    msg.includes('code: 13') ||
    msg.includes('code: 10') ||
    msg.includes('code: 5')
  ) {
    return 'cancelled';
  }

  // Enrolment changed, or the passcode was removed, so the key was destroyed.
  // Android throws KeyPermanentlyInvalidatedException; iOS reports an auth
  // failure against the now-unusable BIOMETRY_CURRENT_SET item.
  if (
    msg.includes('keypermanentlyinvalidated') ||
    msg.includes('permanently invalidated') ||
    msg.includes('key invalidated') ||
    msg.includes('unable to decrypt')
  ) {
    return 'invalidated';
  }

  // The device can't do it right now, for a reason retrying won't change:
  // nothing enrolled, no sensor, sensor busy, or the OS has locked biometrics
  // out after too many failed scans. Android codes covered here —
  //   1  HW_UNAVAILABLE            9  LOCKOUT_PERMANENT
  //   7  LOCKOUT                  11  NO_BIOMETRICS
  //  12  HW_NOT_PRESENT           14  NO_DEVICE_CREDENTIAL
  //  15  SECURITY_UPDATE_REQUIRED
  // — all of which would otherwise fall through to 'failed' and burn one of
  // the user's three retries for something they didn't do.
  //
  // Codes run 1..15, so these prefixes can't collide: nothing contains
  // "code: 5" but code 5 itself (there is no code 50-59), and so on.
  if (
    msg.includes('no fingerprints') ||
    msg.includes('not enrolled') ||
    msg.includes('no biometric') ||
    msg.includes('lockout') ||
    msg.includes('code: 1,') ||
    msg.includes('code: 7') ||
    msg.includes('code: 9') ||
    msg.includes('code: 11') ||
    msg.includes('code: 12') ||
    msg.includes('code: 14') ||
    msg.includes('code: 15')
  ) {
    return 'unavailable';
  }

  return 'failed';
}
