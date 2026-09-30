import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ---------------------------------------------------------------------------
// The top padding a full-bleed header needs to clear the status bar, notch,
// punch-hole camera or Dynamic Island.
//
// Why this isn't just <SafeAreaView edges={['top']}> or insets.top:
//
//   1. FIRST FRAME. SafeAreaProvider reports zero insets until it has measured
//      its own layout, so a header on the very first frame paints under the
//      status bar. App.jsx passes `initialMetrics` to cover the common case.
//
//   2. ANDROID EDGE-TO-EDGE. This project targets SDK 36, and from API 35
//      Android forces apps to draw edge-to-edge. The window extends under the
//      status bar and cutout, so the header MUST apply the inset itself.
//
//   3. ANDROID UNDER-REPORTING. This is the one that actually bit us.
//      react-native-safe-area-context can report a small top inset (or 0) while
//      the window is still settling into edge-to-edge, and a bare 24dp status
//      bar fallback is roughly HALF what a punch-hole device needs — the camera
//      sits inside a status bar that is typically 48dp or taller. The result is
//      a logo rendered straight through the punch hole.
//
//      StatusBar.currentHeight is the reliable number here: Android sizes the
//      status bar to clear the display cutout, so it already accounts for the
//      camera. We therefore take the LARGEST of every signal we have rather
//      than trusting any single one.
// ---------------------------------------------------------------------------

// iOS: 44 on notch devices, 59 with Dynamic Island. Only used if the real inset
// is unavailable, which on iOS is rare once initialMetrics is set.
const IOS_FALLBACK = 47;

// Absolute floor for Android. Deliberately generous: on a device with no cutout
// this is a touch roomy, which reads as breathing room. On a device WITH one it
// stops the header colliding with the camera if every other signal fails.
const ANDROID_FLOOR = 44;

// Ceiling so a misreported cutout can never push the header off-screen. Large
// enough for tall Android cutouts and the Dynamic Island (59).
const MAX_INSET = 80;

export default function useSafeTopInset() {
  const insets = useSafeAreaInsets();
  const measured = (insets && insets.top) || 0;

  if (Platform.OS === 'android') {
    // Largest wins. StatusBar.currentHeight already clears the cutout, and the
    // floor covers the case where both signals come back small or undefined.
    const statusBarHeight = StatusBar.currentHeight || 0;
    const top = Math.max(measured, statusBarHeight, ANDROID_FLOOR);
    return Math.min(top, MAX_INSET);
  }

  // iOS reports notch / Dynamic Island insets accurately once measured.
  if (measured > 0) return Math.min(measured, MAX_INSET);
  return IOS_FALLBACK;
}
