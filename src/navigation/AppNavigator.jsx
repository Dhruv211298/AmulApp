import React, { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';
import { NavigationContainer } from '@react-navigation/native';

import SplashScreen from '../screens/SplashScreen';
import LoginScreen from '../screens/LoginScreen';
import UpdateRequiredScreen from '../screens/UpdateRequiredScreen';
import MainNavigator from './MainNavigator';
import { setSessionExpiredHandler } from '../services/session';
import { clearSession } from '../services/storage';
import {
  watchTokenRefresh,
  onForegroundMessage,
  onNotificationOpened,
} from '../services/notifications';

// Show a foreground push as a NORMAL alert dialog (the standard system alert).
//
// The reason this isn't a bare Alert.alert() call: on Android bridgeless
// (RN 0.86) a message can land in the instant the Activity isn't attached,
// which throws "Tried to show an alert while not attached to an Activity" and
// nothing shows. So we (a) only show while the app is active, and (b) defer to
// the next tick / to when it becomes active, by which point the Activity is
// attached — giving a reliable, normal alert every time.
function showForegroundAlert(title, body) {
  const fire = () => {
    try {
      Alert.alert(title || 'Notification', body || '', [{ text: 'OK' }], {
        cancelable: true,
      });
    } catch (e) {
      // Never let a notification crash the app.
    }
  };

  if (AppState.currentState === 'active') {
    setTimeout(fire, 0); // next tick — Activity is attached
    return;
  }

  // App not fully active yet — show it the moment it becomes active.
  const sub = AppState.addEventListener('change', state => {
    if (state === 'active') {
      sub.remove();
      setTimeout(fire, 300);
    }
  });
}

const Stack = createStackNavigator();

// Splash is always the entry point; it reads the stored PIN and routes to Login
// with the correct mode. (The old duplicate check here has been removed.)
const AppNavigator = () => {
  // Held here rather than passed down, because the expiry can arrive from any
  // screen — or from a background token refresh with no screen involved at all.
  const navRef = useRef(null);

  useEffect(() => {
    // Fires ONLY when a token refresh has failed, i.e. the server has refused
    // the account: disabled in HR, student training ended, or THIS device
    // released by an admin. (Registering on another phone no longer affects
    // this one — accounts are multi-device.) A routine overnight expiry never
    // reaches here — api.js refreshes and retries silently.
    setSessionExpiredHandler(async () => {
      // Drop the dead token first, so nothing retries with it while the alert
      // is on screen. The PIN and registration are deliberately KEPT: if the
      // cause was an admin device release, the user can register again from
      // the Login screen without help.
      try {
        await clearSession();
      } catch (e) {}

      const nav = navRef.current;
      if (!nav || !nav.isReady()) return;

      // suppressAutoBiometric: the PIN survives clearSession, so biometric
      // unlock would otherwise fire on arrival and log the user straight back
      // in — the same trap that made Logout a no-op.
      nav.reset({
        index: 0,
        routes: [{ name: 'Login', params: { mode: 'login', suppressAutoBiometric: true } }],
      });

      Alert.alert(
        'Signed Out',
        'Your session is no longer valid. This can happen if your account was ' +
          'disabled, or if the IT department reset your device registration.\n\n' +
          'Please sign in again, or contact the IT department if the problem continues.',
      );
    });

    return () => setSessionExpiredHandler(null);
  }, []);

  // ---- Push notifications --------------------------------------------------
  // Mounted once, for the whole app lifetime. Registration itself (permission +
  // token upload + topic subscribe) happens after LOGIN — see LoginScreen —
  // because it needs an employee id and a live session token. These three
  // listeners only RECEIVE, so they are safe to attach immediately.
  useEffect(() => {
    // Firebase can rotate the token at any moment. Without this the server
    // would keep the old, dead address until the user next restarts the app.
    const unsubRefresh = watchTokenRefresh();

    // A message that arrives while the app is OPEN draws nothing by itself —
    // the OS only renders a banner when the app is backgrounded or closed. So
    // an announcement arriving mid-use would be invisible without this. Shown
    // as a normal alert dialog (see showForegroundAlert above).
    const unsubForeground = onForegroundMessage(({ title, body }) => {
      if (!title && !body) return;
      showForegroundAlert(title, body);
    });

    // User tapped a notification while the app sat in the background.
    // `data.type` is set by the server; for now every type lands on the same
    // place, but the hook is here for when the announcements screen exists.
    const unsubOpened = onNotificationOpened(() => {
      // Intentionally no navigation yet — jumping the user somewhere
      // unexpected is worse than doing nothing.
    });

    return () => {
      if (unsubRefresh) unsubRefresh();
      if (unsubForeground) unsubForeground();
      if (unsubOpened) unsubOpened();
    };
  }, []);

  return (
    <NavigationContainer ref={navRef}>
      <Stack.Navigator initialRouteName="Splash" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Splash" component={SplashScreen} />
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="UpdateRequired" component={UpdateRequiredScreen} />
        <Stack.Screen name="MainApp" component={MainNavigator} />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

export default AppNavigator;
