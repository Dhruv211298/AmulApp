import React, { useState, useRef, useEffect } from 'react';
import {
  Animated,
  PanResponder,
  TouchableOpacity,
  View,
  StyleSheet,
  Alert,
  BackHandler,
} from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';

import DashboardScreen from '../screens/DashboardScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import MeetingAttendanceScreen from '../screens/MeetingAttendanceScreen';
import QrCodeVisitScreen from '../screens/QrCodeVisitScreen';
import QrVisitReportScreen from '../screens/QrVisitReportScreen';
import QrAttendanceScreen from '../screens/QrAttendanceScreen';
import QrAttendanceReportScreen from '../screens/QrAttendanceReportScreen';
import VisitorEntry from '../screens/VisitorEntry';
import DilEntryScreen from '../screens/DilEntryScreen';
import WebViewScreen from '../components/WebViewScreen';
import PortalView from '../components/PortalView';
import Topbar from '../components/Topbar';
import Sidebar from '../components/Sidebar';
import { clearSession } from '../services/storage';
import { unregisterFromPush } from '../services/notifications';
import { PORTALS } from '../config';

const Stack = createStackNavigator();
const SIDEBAR_WIDTH = 280;

// Every route name this app version can actually open. The backend menu is
// rights-managed (screen/group masters), so it may one day contain a screen
// added for a NEWER app version — tapping it must show a friendly message,
// not silently do nothing. Keep in sync with the Stack.Screen list below and
// the PORTALS in config.js.
const KNOWN_SCREENS = new Set([
  'Dashboard',
  'Profile',
  'Settings',
  'MeetingAttendance',
  'QrAttendance',
  'QrAttendanceReport',
  'QrCodeVisit',
  'QrVisitReport',
  'VisitorEntry',
  'DilEntry',
  'WebView',
]);

// How many portal WebViews may stay mounted at once.
//
// Keeping a portal alive is what makes switching away and back resume the exact
// page instead of reloading it. But each one holds a full WKWebView/WebView with
// its own JS heap, so they cannot accumulate without bound — if the backend menu
// grows to a dozen portals, a user who opens them all would carry a dozen live
// browsers. We keep the most recently used few and unmount the rest; an
// unmounted portal simply reloads next time it is opened.
const MAX_LIVE_PORTALS = 3;

// Portals are kept ALIVE (not stack screens) so switching to Dashboard and back
// resumes the exact page instead of reloading. The backend menu points here with
// { screen: 'AmulIntranet' } / { screen: 'AmulDigi' }; the URLs live in config.

const MainNavigator = ({ navigation }) => {
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const slideAnim = useRef(new Animated.Value(-SIDEBAR_WIDTH)).current;

  // Persistent portal host state. `livePortals` is ordered least- to
  // most-recently used, so the head is the first to be evicted.
  const [livePortals, setLivePortals] = useState([]);
  const [activePortal, setActivePortal] = useState(null); // currently visible key

  // One imperative handle per live portal ({ canGoBack, goBack }), so back
  // navigation is driven from HERE rather than from each portal registering
  // its own hardware-back listener. Several portals stay mounted (hidden) at
  // once; with per-portal listeners a HIDDEN one could win the back press and
  // navigate its own history, or this component's listener could fire first
  // and close the portal outright — which is why "back" appeared broken.
  const portalRefs = useRef({});
  // Whether the VISIBLE portal currently has in-page history, mirrored into
  // state so the Back button in the top bar can appear/disappear.
  const [portalCanGoBack, setPortalCanGoBack] = useState(false);

  // Walk the visible portal's page history. Returns true if it handled it.
  const portalGoBack = () => {
    const handle = activePortal ? portalRefs.current[activePortal] : null;
    if (handle && handle.canGoBack) {
      handle.goBack();
      return true;
    }
    return false;
  };

  const closeSidebar = () => {
    Animated.timing(slideAnim, {
      toValue: -SIDEBAR_WIDTH,
      duration: 300,
      useNativeDriver: true,
    }).start(() => setSidebarVisible(false));
  };

  // Bumped every time the drawer opens — Sidebar reloads the menu on each
  // bump, so a rights change on the backend (screen/group masters) shows up
  // the next time the user opens the menu, without re-login.
  const [menuRefreshTick, setMenuRefreshTick] = useState(0);

  const openSidebar = () => {
    setSidebarVisible(true);
    setMenuRefreshTick(t => t + 1);
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  };

  const toggleSidebar = () => (sidebarVisible ? closeSidebar() : openSidebar());

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => sidebarVisible,
      onMoveShouldSetPanResponder: () => sidebarVisible,
      onPanResponderMove: (evt, gestureState) => {
        if (gestureState.dx <= 0) {
          slideAnim.setValue(gestureState.dx);
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dx < -100 || gestureState.vx < -0.5) {
          closeSidebar();
        } else {
          Animated.spring(slideAnim, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  // Re-sync the Back button when the visible portal changes. Each portal has
  // its OWN page history, so switching from one that was three pages deep to
  // one sitting on its landing page must drop the arrow (and vice versa).
  useEffect(() => {
    const handle = activePortal ? portalRefs.current[activePortal] : null;
    setPortalCanGoBack(!!(handle && handle.canGoBack));
  }, [activePortal]);

  // Android hardware back, in priority order:
  //   1. drawer open            -> close it
  //   2. portal has page history -> go back INSIDE the portal
  //   3. portal open             -> leave it (back to the app)
  //   4. otherwise               -> let navigation handle it
  //
  // Step 2 is the one that was missing: this handler used to jump straight to
  // step 3, so opening a report and pressing back dropped you out of the
  // portal entirely instead of returning to the dashboard page.
  useEffect(() => {
    const onBack = () => {
      if (sidebarVisible) {
        closeSidebar();
        return true;
      }
      if (activePortal) {
        if (portalGoBack()) return true;
        setActivePortal(null);
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [sidebarVisible, activePortal, portalCanGoBack]);

  // Handle a menu tap:
  //   - a portal screen -> show its kept-alive WebView (mount once, then resume)
  //   - has a URL        -> open the generic in-app WebView
  //   - native screen    -> navigate to it (and hide any active portal)
  const handleSelect = item => {
    closeSidebar();
    if (item.screen && PORTALS[item.screen]) {
      // Move this portal to the most-recently-used end, then trim the oldest
      // entries beyond the cap so at most MAX_LIVE_PORTALS stay mounted.
      setLivePortals(prev => {
        const withoutThis = prev.filter(key => key !== item.screen);
        return [...withoutThis, item.screen].slice(-MAX_LIVE_PORTALS);
      });
      setActivePortal(item.screen);
    } else if (item.url) {
      setActivePortal(null);
      navigation.navigate('MainApp', {
        screen: 'WebView',
        params: { url: item.url, title: item.name },
      });
    } else if (item.screen) {
      // Forward-compatibility guard: the rights-managed backend menu may
      // reference a screen this installed version doesn't have yet.
      if (!KNOWN_SCREENS.has(item.screen)) {
        Alert.alert(
          'Update Required',
          `"${item.name}" requires the latest version of the app. Please update Amul Common App to use this feature.`,
        );
        return;
      }
      setActivePortal(null);
      navigation.navigate('MainApp', { screen: item.screen });
    }
  };

  // Open the Profile screen from the top bar avatar (leaves any active portal).
  const handleProfile = () => {
    setActivePortal(null);
    navigation.navigate('MainApp', { screen: 'Profile' });
  };

  // Logout = clear the live session (keep the PIN) and return to the PIN screen.
  const performLogout = async () => {
    // Stop this phone receiving announcements meant for the user who is
    // leaving. These handsets are shared on the plant floor, so without this
    // the next person to log in would keep getting the previous user's group
    // messages. Best-effort and never blocking: a failure here must not stop
    // the logout itself.
    try {
      await unregisterFromPush();
    } catch (e) {}

    // Navigate to Login even if storage clearing fails — logout must never be
    // a silent no-op.
    try {
      await clearSession();
    } catch (e) {}
    navigation.reset({
      index: 0,
      // suppressAutoBiometric: logout keeps the PIN and the biometric
      // enrolment, so without this the Login screen would auto-scan on mount
      // and put the user straight back in — Logout would be impossible to
      // complete. The scanner button is still there to tap deliberately.
      routes: [
        { name: 'Login', params: { mode: 'login', suppressAutoBiometric: true } },
      ],
    });
  };

  // Single confirm-then-logout handler shared by the top bar and the sidebar.
  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: performLogout },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <Stack.Navigator
        screenOptions={{
          header: ({ route, options }) => (
            <Topbar
              title={options?.title || route.name}
              onMenuPress={toggleSidebar}
              onProfile={handleProfile}
              onLogout={handleLogout}
            />
          ),
        }}
      >
        {/* Title "Home" to match the sidebar menu item of the same name —
            the route stays "Dashboard" because the cached menu and
            KNOWN_SCREENS reference it by that key. */}
        <Stack.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{ title: 'Home' }}
        />
        <Stack.Screen name="Profile" component={ProfileScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen
          name="MeetingAttendance"
          component={MeetingAttendanceScreen}
          options={{ title: 'Meeting Attendance' }}
        />
        <Stack.Screen
          name="QrCodeVisit"
          component={QrCodeVisitScreen}
          options={{ title: 'QR Code Visit' }}
        />
        <Stack.Screen
          name="QrVisitReport"
          component={QrVisitReportScreen}
          options={{ title: 'QR Visit Report' }}
        />
        <Stack.Screen
          name="QrAttendance"
          component={QrAttendanceScreen}
          options={{ title: 'QR Code Attendance' }}
        />
        <Stack.Screen
          name="QrAttendanceReport"
          component={QrAttendanceReportScreen}
          options={{ title: 'QR Attendance Report' }}
        />
        <Stack.Screen
          name="VisitorEntry"
          component={VisitorEntry}
          options={{ title: 'Visitor Entry' }}
        />
        <Stack.Screen
          name="DilEntry"
          component={DilEntryScreen}
          options={{ title: 'DIL Entry' }}
        />
        <Stack.Screen
          name="WebView"
          component={WebViewScreen}
          options={({ route }) => ({ title: route.params?.title || 'Portal' })}
        />
      </Stack.Navigator>

      {/* Kept-alive portal hosts — mounted on first open, then just shown/hidden
          so returning resumes the same page (no reload) while the app runs. */}
      {livePortals.map(key => {
        const portal = PORTALS[key];
        const visible = activePortal === key;
        return (
          <View
            key={key}
            style={[styles.portalHost, { display: visible ? 'flex' : 'none' }]}
            pointerEvents={visible ? 'auto' : 'none'}
          >
            <Topbar
              title={portal.title}
              onMenuPress={toggleSidebar}
              onProfile={handleProfile}
              onLogout={handleLogout}
              // Back arrow only while this portal is visible AND has history.
              // iOS has no hardware back button, so this is the only way out
              // of a second page there.
              onBack={visible && portalCanGoBack ? portalGoBack : undefined}
            />
            <PortalView
              ref={el => {
                portalRefs.current[key] = el;
              }}
              baseUrl={portal.baseUrl}
              title={portal.title}
              paramNames={portal.paramNames}
              prefillEmployeeField={portal.prefillEmployeeField}
              viewport={portal.viewport}
              // This component owns the hardware back button for portals —
              // see the comment on portalRefs.
              handleHardwareBack={false}
              onCanGoBackChange={can => {
                if (activePortal === key) setPortalCanGoBack(can);
              }}
            />
          </View>
        );
      })}

      {/* Tap anywhere outside the drawer to close (transparent — no dim). */}
      {sidebarVisible && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={closeSidebar}
          style={styles.overlay}
        />
      )}

      {/* Single animated drawer — owns all positioning + animation. */}
      <Animated.View
        style={[styles.drawer, { transform: [{ translateX: slideAnim }] }]}
        pointerEvents={sidebarVisible ? 'auto' : 'none'}
        {...panResponder.panHandlers}
      >
        <Sidebar
          onSelect={handleSelect}
          onClose={closeSidebar}
          onLogout={handleLogout}
          refreshSignal={menuRefreshTick}
        />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  // Portal host sits above the app stack but below the sidebar drawer/overlay.
  portalHost: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF',
    zIndex: 500,
    elevation: 12,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    zIndex: 998,
    elevation: 15,
  },
  drawer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SIDEBAR_WIDTH,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    zIndex: 999,
    elevation: 20,
  },
});

export default MainNavigator;
