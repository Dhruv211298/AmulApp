import AsyncStorage from '@react-native-async-storage/async-storage';

// Single source of truth for every AsyncStorage key used in the app.
export const KEYS = {
  userPin: 'user_pin',
  userId: 'user_id',
  userName: 'user_nm',
  username: 'username',
  userType: 'user_type',
  // Plant of the logged-in employee, refreshed at EVERY login by
  // app_token_checker.php (not captured once at registration), so a transfer
  // reaches the app on the user's next login rather than being frozen forever.
  //   plantNo   numeric key  — for joins and inserts
  //   plantCode short code   — what people read, e.g. in a ticket number
  // Both are '' for students, who have no plant.
  plantNo: 'plant_no',
  plantCode: 'plant_code',
  isRegistered: 'is_registered',
  apiToken: 'api_token',
  tokenDate: 'token_date',
  pinAttempts: 'pin_attempts',
  pinLockUntil: 'pin_lock_until',
  sidebarMenu: 'sidebar_menu',
  // Grouped sidebar (categories + their items) from /app_api/app_menu.php.
  // Cached alongside sidebarMenu rather than replacing it, so a server that
  // returns only the flat menu simply leaves this empty.
  sidebarTree: 'sidebar_tree',
  deviceId: 'device_id',
  // 'true' once the user has opted in to Face ID / fingerprint unlock.
  // This is a HINT ONLY — it says "offer the scanner", never "this user is
  // authenticated". The real gate is the Keychain/Keystore item, which the OS
  // will not release without a matching biometric. Flipping this flag by hand
  // gains an attacker nothing: services/biometrics.js still has to get the PIN
  // back out of hardware-backed storage, and that needs a real face or finger.
  biometricEnabled: 'biometric_enabled',
  // Last server-approved tunables (JSON) — see services/remoteConfig.js.
  remoteConfig: 'remote_config',
};

// Cleared on a normal "logout" (lock): keep the PIN so the user can log back in.
const SESSION_KEYS = [KEYS.apiToken, KEYS.tokenDate, KEYS.pinAttempts, KEYS.pinLockUntil];

// Cleared on a full "switch user" / reset: wipe everything, including the cached menu.
// NOTE: this removes the FLAG, not the Keychain item that actually holds the
// PIN. Callers switching user must also call disableBiometrics() from
// services/biometrics.js — that is what wipes the hardware-backed secret.
// storage.js deliberately does not import biometrics.js (biometrics.js imports
// this file, and a cycle between them would leave one of the two half-loaded).
const ACCOUNT_KEYS = [
  KEYS.userPin, KEYS.userId, KEYS.userName, KEYS.username,
  KEYS.userType, KEYS.plantNo, KEYS.plantCode, KEYS.isRegistered, KEYS.sidebarMenu, KEYS.sidebarTree, KEYS.biometricEnabled,
  ...SESSION_KEYS,
];

export const getItem = key => AsyncStorage.getItem(key);
export const setItem = (key, val) => AsyncStorage.setItem(key, val == null ? '' : String(val));
// Genuinely remove a key. Prefer this over setItem(key, '') when the absence of
// a value is meaningful — e.g. the PIN lockout, where '' and "not locked" must
// not be confused with a stored timestamp.
export const removeItem = key => AsyncStorage.removeItem(key);
export const removeItems = keys => AsyncStorage.multiRemove(keys);

// Write several keys at once. Takes a plain object so callers use the KEYS
// constants as keys and never hand-write storage key strings:
//   setItems({ [KEYS.userId]: id, [KEYS.username]: name })
export const setItems = obj =>
  AsyncStorage.multiSet(
    Object.entries(obj).map(([k, v]) => [k, v == null ? '' : String(v)]),
  );

export const getSession = async () => {
  const entries = await AsyncStorage.multiGet(Object.values(KEYS));
  return Object.fromEntries(entries);
};

// Lock logout — keeps PIN + registration + cached menu, clears the live session token.
export const clearSession = () => AsyncStorage.multiRemove(SESSION_KEYS);

// Full logout / switch user — removes stored credentials and the cached menu.
export const clearAccount = () => AsyncStorage.multiRemove(ACCOUNT_KEYS);
