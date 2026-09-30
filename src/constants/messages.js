// ---------------------------------------------------------------------------
// STANDARD ALERT MESSAGES — the single source of truth.
//
// Rule of the codebase: the SAME reason must always show the SAME message,
// no matter which screen it happens on. (Before this file existed, a network
// failure had six different wordings across the app — login said "Check your
// internet connection" while registration said "Unable to connect to
// server.") Screen-specific validation messages (wrong PIN, invalid date
// range…) stay local to their screens because their reasons are unique.
//
// Usage:
//   import { MSG } from '../constants/messages';
//   Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
// ---------------------------------------------------------------------------

export const MSG = {
  // Any request that failed to reach the server or timed out.
  NETWORK: {
    title: 'Network Error',
    message:
      'Could not reach the server. Please check your internet connection and try again.',
  },

  // The server answered, but not with valid data (HTML error page, etc.).
  SERVER: {
    title: 'Server Error',
    message:
      'The server sent an unexpected response. Please try again, or contact IT support if this continues.',
  },

  // Locally stored session/user data is missing or unreadable.
  SESSION_MISSING: {
    title: 'Session Error',
    message: 'Your login data could not be read. Please login again.',
  },

  // A scanned QR code was empty/unreadable (format-specific messages, like the
  // meeting code's numeric-only rule, stay on their own screens).
  QR_UNREADABLE: {
    title: 'Invalid QR',
    message: "Couldn't read this QR code. Please try scanning again.",
  },

  // The scanner auto-closed after its timeout without detecting a code.
  // Without this the camera would vanish on its own with no explanation,
  // which users read as a crash rather than a timeout.
  // Wording is deliberately plain: most users here are not native English
  // readers, so "detected"/"well-lit" are avoided, and no button name is
  // mentioned (the scan button reads "Scan QR Code" on one screen and "Scan"
  // on the others).
  SCAN_TIMEOUT: {
    title: 'Scanning Timed Out',
    message:
      'QR code not found. Please check there is enough light and hold the ' +
      'code inside the frame, then scan again.',
  },
};

export default MSG;
