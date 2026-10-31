import { getItem, setItem, removeItems, KEYS } from './storage';

// ---------------------------------------------------------------------------
// PIN brute-force protection.
//
// The login PIN is 4 digits — only 10,000 combinations — and it is verified on
// the device, so without a throttle an attacker holding the phone can simply
// try every one. This module implements the lockout that KEYS.pinAttempts and
// KEYS.pinLockUntil were always meant to drive.
//
// Policy: the first few wrong PINs just warn. From MAX_ATTEMPTS onward every
// further wrong PIN locks the screen, and the lock grows each time, CAPPED at
// five minutes (product decision: users should never be locked out for hours):
//
//   attempt 5 -> 30s     attempt 6 -> 1m     attempt 7+ -> 5m
//
// Security trade-off, recorded honestly: at 5 minutes per try the 10,000-PIN
// keyspace takes ~35 days of continuous manual guessing instead of >1 year
// under the old 1-hour cap. Still far beyond casual guessing, and the
// server-side device/status check remains the authoritative gate after the
// PIN — but if abuse is ever observed, raise the cap here.
//
// LIMITATION worth knowing: this is a client-side control keyed on Date.now(),
// so someone who can move the device clock forward can shorten a lock, and
// someone who can edit AsyncStorage directly can clear the counter entirely.
// It defeats casual guessing, not a determined attacker with a rooted device.
// The durable fix is server-side attempt limiting on app_token_checker.php,
// plus moving the PIN into the Keychain (finding H1).
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS = 5;

const LOCK_STEPS_MS = [
  30 * 1000,
  60 * 1000,
  5 * 60 * 1000, // hard cap — repeats for every further wrong attempt
];

const toInt = raw => {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) ? n : 0;
};

// Milliseconds remaining on the current lock, or 0 if the user may try now.
export async function getLockRemainingMs() {
  const until = toInt(await getItem(KEYS.pinLockUntil));
  if (!until) return 0;
  const remaining = until - Date.now();
  // A lock far in the future means the clock was moved backwards; treat any
  // value beyond the longest possible lock as corrupt and ignore it.
  if (remaining > LOCK_STEPS_MS[LOCK_STEPS_MS.length - 1]) return 0;
  return remaining > 0 ? remaining : 0;
}

// Record one wrong PIN. Returns what the caller should tell the user:
//   { attempts, remainingBeforeLock, lockedForMs }
// lockedForMs > 0 means the screen is now locked for that long.
export async function registerFailedAttempt() {
  const attempts = toInt(await getItem(KEYS.pinAttempts)) + 1;
  await setItem(KEYS.pinAttempts, attempts);

  if (attempts < MAX_ATTEMPTS) {
    return {
      attempts,
      remainingBeforeLock: MAX_ATTEMPTS - attempts,
      lockedForMs: 0,
    };
  }

  const step = Math.min(attempts - MAX_ATTEMPTS, LOCK_STEPS_MS.length - 1);
  const lockedForMs = LOCK_STEPS_MS[step];
  await setItem(KEYS.pinLockUntil, Date.now() + lockedForMs);

  return { attempts, remainingBeforeLock: 0, lockedForMs };
}

// Wipe the counter and any lock. Call on every successful PIN entry, and after
// the PIN is changed in Settings.
export async function clearAttempts() {
  await removeItems([KEYS.pinAttempts, KEYS.pinLockUntil]);
}

// "30 seconds" / "5 minutes" / "1 hour" — for user-facing lock messages.
export function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
