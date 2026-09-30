import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import * as Keychain from 'react-native-keychain';
import { getItem, setItem, KEYS } from './storage';

// ---------------------------------------------------------------------------
// Return a STABLE device id for this install.
//
// The value is computed ONCE and then persisted, so every caller —
// registration, login/token requests, token refresh, and the portal WebView —
// sends the *same* id. This matters because the token is minted and the device
// is registered against whatever id we send; if different call sites got
// different ids, the portal's login_app.php would reject the mismatch.
//
// WHY THE KEYCHAIN IS INVOLVED (iOS only)
//
// getUniqueId() is ANDROID_ID on Android and identifierForVendor on iOS. Those
// are not equally durable:
//
//   Android — ANDROID_ID survives an app reinstall. AsyncStorage is wiped on
//             uninstall, but the next getUniqueId() returns the same value, so
//             the id comes back by itself. Nothing extra is needed.
//
//   iOS     — identifierForVendor is DESTROYED when the user deletes the last
//             app from this vendor. Reinstall and you get a brand new id.
//
// That difference is what makes iOS a problem now that the server binds an
// account to one device: an employee who simply reinstalls the app would come
// back looking like a stranger on an unknown phone and get blocked, needing an
// admin reset for something that isn't a security event at all.
//
// iOS Keychain items outlive app deletion, so the id is mirrored there and
// survives a reinstall. ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY is
// deliberate on both halves:
//
//   AFTER_FIRST_UNLOCK — readable in the background after the first unlock
//                        following a reboot. WHEN_UNLOCKED would fail for any
//                        request made while the phone is locked.
//   THIS_DEVICE_ONLY   — never leaves this handset. Without it the id would
//                        ride an iCloud/encrypted backup onto a NEW phone, and
//                        the restored app would present the old phone's id —
//                        silently defeating the device binding this exists to
//                        support. The whole point is that a different physical
//                        device looks different to the server.
//
// No accessControl, so reading it never prompts for Face ID. This is an
// identifier, not a secret — it authenticates nothing on its own.
// ---------------------------------------------------------------------------

const DEVICE_ID_SERVICE = 'com.amulapp.deviceid';
const DEVICE_ID_ACCOUNT = 'amulapp-device';

const useKeychainMirror = Platform.OS === 'ios';

async function readKeychainId() {
  if (!useKeychainMirror) return '';
  try {
    const creds = await Keychain.getGenericPassword({ service: DEVICE_ID_SERVICE });
    return creds && creds.password ? creds.password : '';
  } catch (e) {
    return '';
  }
}

async function writeKeychainId(id) {
  if (!useKeychainMirror || !id) return;
  try {
    await Keychain.setGenericPassword(DEVICE_ID_ACCOUNT, id, {
      service: DEVICE_ID_SERVICE,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  } catch (e) {
    // Non-fatal: the id still works for this install via AsyncStorage. Only the
    // survive-a-reinstall property is lost.
  }
}

export async function getDeviceId() {
  // 1. AsyncStorage FIRST, and this order is not arbitrary.
  //
  // Every user already registered is bound on the server to the id currently
  // sitting in AsyncStorage. If the Keychain were consulted first and happened
  // to hold anything different, the whole existing user base would present a
  // new id on their next login and be locked out en masse. The value already on
  // the device always wins; the Keychain is only ever a backup of it.
  let id = await getItem(KEYS.deviceId);
  if (id) {
    // Back it up for the next reinstall. Cheap, and idempotent.
    await writeKeychainId(id);
    return id;
  }

  // 2. Nothing local. On iOS this is the reinstall case — recover the id the
  // previous install registered with, so the server still recognises the phone.
  id = await readKeychainId();
  if (id) {
    await setItem(KEYS.deviceId, id);
    return id;
  }

  // 3. Genuinely first run on this device. Mint one and store it in both places.
  try {
    id = await DeviceInfo.getUniqueId();
  } catch (e) {
    id = '';
  }

  if (id) {
    await setItem(KEYS.deviceId, id);
    await writeKeychainId(id);
  }
  return id || '';
}
