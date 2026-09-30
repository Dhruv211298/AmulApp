/**
 * Mocks for the native modules this app depends on.
 *
 * Jest runs in Node, where none of these have a native side. Without stubs any
 * test that imports a module touching them fails at import time — which is why
 * the original App smoke test could never have passed.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  multiGet: jest.fn(keys => Promise.resolve(keys.map(k => [k, null]))),
  multiSet: jest.fn(() => Promise.resolve()),
  multiRemove: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native-device-info', () => ({
  getUniqueId: jest.fn(() => Promise.resolve('test-device-id')),
  getVersion: jest.fn(() => '1.0.0'),
}));

jest.mock('@react-native-community/geolocation', () => ({
  setRNConfiguration: jest.fn(),
  requestAuthorization: jest.fn(),
  getCurrentPosition: jest.fn(),
  watchPosition: jest.fn(() => 1),
  clearWatch: jest.fn(),
}));

jest.mock('react-native-vision-camera', () => ({
  Camera: () => null,
  useCameraDevice: jest.fn(() => null),
  useCameraPermission: jest.fn(() => ({
    hasPermission: false,
    requestPermission: jest.fn(),
  })),
  useCodeScanner: jest.fn(() => ({})),
}));

jest.mock('react-native-webview', () => ({ WebView: () => null }));

// Biometric unlock. Defaults to "this device has no biometrics", which is the
// state the login screen must degrade to cleanly — so the smoke test exercises
// the PIN-only path unless a test deliberately overrides these.
// `virtual: true` so the suite still runs before `npm install` has pulled the
// native package down — Jest resolves the real path even when a factory is
// given, and would otherwise fail every suite with "Cannot find module".
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly' },
  ACCESS_CONTROL: { BIOMETRY_CURRENT_SET: 'BiometryCurrentSet' },
  STORAGE_TYPE: { AES_GCM: 'KeystoreAESGCM' },
  BIOMETRY_TYPE: {
    TOUCH_ID: 'TouchID',
    FACE_ID: 'FaceID',
    OPTIC_ID: 'OpticID',
    FINGERPRINT: 'Fingerprint',
    FACE: 'Face',
    IRIS: 'Iris',
  },
  getSupportedBiometryType: jest.fn(() => Promise.resolve(null)),
  isPasscodeAuthAvailable: jest.fn(() => Promise.resolve(false)),
  hasGenericPassword: jest.fn(() => Promise.resolve(false)),
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  setGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
}), { virtual: true });

jest.mock('react-native-linear-gradient', () => 'LinearGradient');

jest.mock('react-native-svg', () => {
  const mock = { __esModule: true, default: 'Svg', Svg: 'Svg', Path: 'Path' };
  return mock;
}, { virtual: true });

jest.mock('react-native-safe-area-context', () => {
  const inset = { top: 47, right: 0, bottom: 34, left: 0 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children }) => children,
    useSafeAreaInsets: () => inset,
    initialWindowMetrics: {
      insets: inset,
      frame: { x: 0, y: 0, width: 390, height: 844 },
    },
  };
});
