import {
  registerFailedAttempt,
  getLockRemainingMs,
  clearAttempts,
  formatDuration,
  MAX_ATTEMPTS,
} from '../src/services/pin';
import { getItem, KEYS } from '../src/services/storage';

// AsyncStorage is native; back it with a plain in-memory map for these tests.
jest.mock('@react-native-async-storage/async-storage', () => {
  let store = {};
  return {
    getItem: jest.fn(k => Promise.resolve(k in store ? store[k] : null)),
    setItem: jest.fn((k, v) => {
      store[k] = v;
      return Promise.resolve();
    }),
    removeItem: jest.fn(k => {
      delete store[k];
      return Promise.resolve();
    }),
    multiRemove: jest.fn(keys => {
      keys.forEach(k => delete store[k]);
      return Promise.resolve();
    }),
    multiSet: jest.fn(pairs => {
      pairs.forEach(([k, v]) => {
        store[k] = v;
      });
      return Promise.resolve();
    }),
    multiGet: jest.fn(keys =>
      Promise.resolve(keys.map(k => [k, k in store ? store[k] : null])),
    ),
    __reset: () => {
      store = {};
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AsyncStorage = require('@react-native-async-storage/async-storage');

beforeEach(() => {
  AsyncStorage.__reset();
});

describe('PIN lockout', () => {
  it('warns without locking for the first few failures', async () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = await registerFailedAttempt();
      expect(r.attempts).toBe(i);
      expect(r.lockedForMs).toBe(0);
      expect(r.remainingBeforeLock).toBe(MAX_ATTEMPTS - i);
    }
    expect(await getLockRemainingMs()).toBe(0);
  });

  it('locks once the threshold is reached', async () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) await registerFailedAttempt();
    const r = await registerFailedAttempt();
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(r.lockedForMs).toBeGreaterThan(0);
    expect(await getLockRemainingMs()).toBeGreaterThan(0);
  });

  it('escalates the lock on each further failure', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) await registerFailedAttempt();
    const first = await getLockRemainingMs();
    const second = await registerFailedAttempt();
    const third = await registerFailedAttempt();
    expect(second.lockedForMs).toBeGreaterThan(first);
    expect(third.lockedForMs).toBeGreaterThan(second.lockedForMs);
  });

  it('clears the counter and the lock on success', async () => {
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await registerFailedAttempt();
    expect(await getLockRemainingMs()).toBeGreaterThan(0);

    await clearAttempts();

    expect(await getLockRemainingMs()).toBe(0);
    expect(await getItem(KEYS.pinAttempts)).toBeNull();
    expect(await getItem(KEYS.pinLockUntil)).toBeNull();
  });

  it('ignores a lock timestamp beyond the longest possible lock', async () => {
    // Guards against a device clock moved backwards leaving a far-future value
    // that would otherwise lock the user out effectively forever.
    await AsyncStorage.setItem(
      KEYS.pinLockUntil,
      String(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    expect(await getLockRemainingMs()).toBe(0);
  });

  it('treats an expired lock as unlocked', async () => {
    await AsyncStorage.setItem(KEYS.pinLockUntil, String(Date.now() - 1000));
    expect(await getLockRemainingMs()).toBe(0);
  });
});

describe('formatDuration', () => {
  it('renders seconds, minutes and hours with correct pluralisation', () => {
    expect(formatDuration(1000)).toBe('1 second');
    expect(formatDuration(30000)).toBe('30 seconds');
    expect(formatDuration(60000)).toBe('1 minute');
    expect(formatDuration(5 * 60000)).toBe('5 minutes');
    expect(formatDuration(60 * 60000)).toBe('1 hour');
  });

  it('never reports zero', () => {
    expect(formatDuration(0)).toBe('1 second');
    expect(formatDuration(10)).toBe('1 second');
  });
});
