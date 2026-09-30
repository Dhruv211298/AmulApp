/**
 * @format
 */
import 'react-native-gesture-handler'; // <--- ADD THIS LINE FIRST!
// Global Roboto default on Android — cures last-character text clipping on
// OnePlus/Oppo/Realme OEM fonts. Must load before any screen renders.
import './src/utils/androidTextFix';

import {AppRegistry} from 'react-native';
import {
  getMessaging,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import App from './App';
import {name as appName} from './app.json';

// ---------------------------------------------------------------------------
// PUSH: background / quit-state message handler.
//
// MUST live here — at module scope in index.js, OUTSIDE the React tree and
// before registerComponent. When a message arrives with the app closed,
// Android spins up a HEADLESS JavaScript context: no components are mounted,
// AppNavigator does not exist, and anything registered inside a useEffect has
// never run. Firebase looks for this handler at that moment and warns
// ("No background message handler has been set") if it is missing.
//
// It deliberately does almost nothing. For a message carrying a `notification`
// block the OPERATING SYSTEM draws the notification by itself. This handler is
// not what makes the banner appear, and doing work here would run on a phone
// the user is not even looking at. It earns its place later, for DATA-ONLY
// messages (silent badge refresh, pre-fetching an announcement).
//
// Must return a Promise; Android kills the headless task when it settles.
//
// WRAPPED in try/catch: this line runs before ANY screen. If Firebase is not
// configured on the current platform (iOS before GoogleService-Info.plist is
// in the Xcode project and FirebaseApp.configure() is in AppDelegate),
// getMessaging() throws — and an uncaught throw HERE means the app never
// launches. A missing notification setup must cost notifications, never the
// app.
// ---------------------------------------------------------------------------
try {
  setBackgroundMessageHandler(getMessaging(), async () => {
    // Intentionally empty — see above.
  });
} catch (e) {
  // Notifications unavailable on this build/platform; everything else runs.
}

AppRegistry.registerComponent(appName, () => App);