import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  useWindowDimensions,
  Image,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Animated,
  TouchableWithoutFeedback,
  Alert,
  ActivityIndicator,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Path } from 'react-native-svg';
import GlassCard from '../components/GlassCard';
import PinInput from '../components/PinInput';
import EyeToggle from '../components/EyeToggle';
import useSafeTopInset from '../hooks/useSafeTopInset';
import { COLORS, SPACING } from '../theme';
import { ENDPOINTS } from '../config';
import { refreshSidebarMenu } from '../services/menu';
import { fetchTextWithTimeout } from '../services/api';
import { MSG } from '../constants/messages';
import { getItem, setItems, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import {
  getLockRemainingMs,
  registerFailedAttempt,
  clearAttempts,
  formatDuration,
} from '../services/pin';
import { resetSessionExpiredLatch } from '../services/session';
import { registerForPush } from '../services/notifications';
import {
  getCapability as getBiometricCapability,
  isEnabled as isBiometricEnabled,
  unlock as biometricUnlock,
  enable as enableBiometric,
  disable as disableBiometric,
  shouldOffer as shouldOfferBiometric,
  declineOffer as declineBiometric,
} from '../services/biometrics';

// How many non-matching scans before the screen gives up and insists on the
// PIN. The OS prompt already retries internally, so this counts whole failed
// prompts, not individual finger touches — three is generous.
const MAX_BIO_FAILURES = 3;

const LOGO_URL = require('../assets/Amul_Logo.png');

// Registration: validates username + password and registers this device.
const API_URL = ENDPOINTS.register;
// Login: after the local PIN check, confirm this user + device is still active.
// Returns emp_status ('1' = active) and (for employees) a token.
const TOKEN_CHECK_URL = ENDPOINTS.tokenCheck;

// ===========================================================================
// DESIGN DIRECTION — "Editorial canvas"
//
// This is a deliberate break from the previous layout language, not a polish
// pass on it. Everything that defined the old screen is gone:
//
//   • the coloured header block with big corner radii   -> removed
//   • the centred pill toggle floating over it          -> removed
//   • the floating white form card                      -> removed
//   • centre-aligned everything                         -> removed
//
// What replaces it is the layout modern product teams (Linear, Stripe, Vercel,
// Revolut) converged on for auth screens: one uninterrupted canvas, content
// pinned to a single left baseline, a large display headline carrying the
// hierarchy, and a very quiet ambient gradient instead of a solid colour band.
// Nothing is boxed. The eye travels straight down one column: brand -> promise
// -> input -> action. That single-column discipline is what reads as
// "enterprise-grade" rather than "app template".
//
// Colour is used sparingly and only from theme.js — the brand red appears on
// exactly three things (the active tab underline, the focused field, the
// primary button) so each one means something.
// ===========================================================================

// --- Dependency-free icon set ---------------------------------------------
// The brief named react-native-vector-icons / lucide-react-native but also
// ruled out unnecessary dependencies. Both need native linking (fonts or
// react-native-svg) for a handful of glyphs, so these are drawn with plain
// Views — the same call LogoutIcon.jsx already made in this codebase. They
// tint from the theme and stay crisp at any size.

const UserIcon = ({ size = 20, color = COLORS.muted }) => (
  <View style={[iconStyles.box, { width: size, height: size }]}>
    <View
      style={{
        width: size * 0.38,
        height: size * 0.38,
        borderRadius: size * 0.19,
        borderWidth: 1.7,
        borderColor: color,
      }}
    />
    <View
      style={{
        width: size * 0.74,
        height: size * 0.32,
        borderTopLeftRadius: size * 0.37,
        borderTopRightRadius: size * 0.37,
        borderWidth: 1.7,
        borderBottomWidth: 0,
        borderColor: color,
        marginTop: size * 0.09,
      }}
    />
  </View>
);

const LockIcon = ({ size = 20, color = COLORS.muted }) => (
  <View style={[iconStyles.box, { width: size, height: size }]}>
    <View
      style={{
        width: size * 0.44,
        height: size * 0.26,
        borderWidth: 1.7,
        borderBottomWidth: 0,
        borderColor: color,
        borderTopLeftRadius: size * 0.22,
        borderTopRightRadius: size * 0.22,
        marginBottom: -1,
      }}
    />
    <View
      style={{
        width: size * 0.68,
        height: size * 0.44,
        borderRadius: size * 0.11,
        borderWidth: 1.7,
        borderColor: color,
      }}
    />
  </View>
);

// Arrow used inside the primary button — signals forward motion, a small
// detail that separates a considered button from a plain coloured rectangle.
const ArrowRight = ({ size = 9, color = '#FFFFFF' }) => (
  <View
    style={{
      width: size,
      height: size,
      borderTopWidth: 2,
      borderRightWidth: 2,
      borderColor: color,
      transform: [{ rotate: '45deg' }],
    }}
  />
);

// Biometric icons — real SVG paths (react-native-svg), replacing the earlier
// View-drawn approximations. Views can only fake arcs with circle borders,
// which made the fingerprint read as a "target"; these are the actual curved
// ridge lines a fingerprint has, and the Apple-style bracket face for Face ID
// devices. Both use round line caps and derive every dimension from the 64pt
// design grid, so they stay crisp at any rendered size.
const FingerprintIcon = ({ size = 26, color = COLORS.primaryRed }) => (
  <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <Path
      d="M17 20 C22 13, 30 10, 38 12 C43 13.5, 47 16, 49 19"
      stroke={color} strokeWidth={3.6} strokeLinecap="round"
    />
    <Path
      d="M12 32 C13 24, 19 17.5, 27 16 C38 14, 49 21, 51 32 C52 38, 51 45, 49 50"
      stroke={color} strokeWidth={3.6} strokeLinecap="round"
    />
    <Path
      d="M19 47 C18 42, 17.5 36, 19 31 C21 24.5, 28 21.5, 34 23.5 C41 26, 44 32, 44 38 C44 43, 43.5 48, 42 52"
      stroke={color} strokeWidth={3.6} strokeLinecap="round"
    />
    <Path
      d="M26 52 C25.5 48, 25 42, 26 37 C27 32.5, 31 30, 34.5 31.5 C37.5 33, 38.5 36, 38.5 40 C38.5 44.5, 38 49, 37 52"
      stroke={color} strokeWidth={3.6} strokeLinecap="round"
    />
    <Path
      d="M32 52 C32 48.5, 32 44, 32 40"
      stroke={color} strokeWidth={3.6} strokeLinecap="round"
    />
  </Svg>
);

const FaceScanIcon = ({ size = 26, color = COLORS.primaryRed }) => (
  <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <Path d="M10 20 L10 14 Q10 10 14 10 L20 10" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M44 10 L50 10 Q54 10 54 14 L54 20" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M10 44 L10 50 Q10 54 14 54 L20 54" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M44 54 L50 54 Q54 54 54 50 L54 44" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M24 25 L24 32" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M40 25 L40 32" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M33 26 L33 35 Q33 38 30 38" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
    <Path d="M24 44 Q32 50 40 44" stroke={color} strokeWidth={3.6} strokeLinecap="round" />
  </Svg>
);

// Picks the mark that matches what the device actually has, so an Android phone
// never shows a Face ID glyph and vice versa.
const BiometricIcon = ({ shape, size, color }) =>
  shape === 'face' ? (
    <FaceScanIcon size={size} color={color} />
  ) : (
    <FingerprintIcon size={size} color={color} />
  );

const iconStyles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
});

const LoginScreen = ({ navigation, route }) => {
  // Read dimensions from the hook, NOT from a module-level Dimensions.get().
  // A module-level read is captured once when the file is first imported, so it
  // never updates — the layout would stay frozen at the launch orientation
  // through any rotation, split-view resize or foldable unfold.
  const { width, height } = useWindowDimensions();

  // The canvas is now full-bleed, so the screen owns its own status-bar
  // clearance. This is the project's existing hook, which already solves
  // Android edge-to-edge under-reporting and the iOS first-frame zero-inset.
  const topInset = useSafeTopInset();

  // Proportional styles have to be rebuilt whenever the window changes, so they
  // can't live in the module-scope StyleSheet with the static rules.
  //
  // Font scale is CLAMPED (0.92–1.14). An unclamped width/375 ratio makes the
  // display headline enormous on a tablet and cramped on an iPhone SE; clamping
  // keeps the type hierarchy intact at every size.
  const dyn = useMemo(() => {
    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
    const fs = clamp(width / 375, 0.92, 1.14);
    const scaleFont = size => Math.round(size * fs);
    const isShort = height < 700;

    // One column, one max width, centred on large screens. On a tablet the form
    // becomes a considered column rather than a stretched full-bleed row.
    const columnWidth = Math.min(width - SPACING.lg * 2, 440);

    return {
      // Hero-scale PIN cells. PinInput already exposes cellSize, so the PIN can
      // become the focal point of the screen without touching that component.
      // Kept OUTSIDE StyleSheet.create — it is a plain number passed as a prop,
      // not a style object.
      pinCell: clamp(width * 0.155, 54, 66),
      ...StyleSheet.create({
        column: { width: columnWidth },
          // Hero logo — the brand mark IS the header now (the chip and the
        // "Welcome back" headline were removed in its favour), so it gets
        // real size. resizeMode="contain" keeps the aspect ratio correct.
        logo: {
          width: clamp(width * 0.52, 170, 240),
          height: clamp(width * 0.3, 96, 136),
        },
        tabText: { fontSize: scaleFont(15) },
        label: { fontSize: scaleFont(13) },
        inputText: { fontSize: scaleFont(16) },
        buttonText: { fontSize: scaleFont(16) },
        // Ambient gradient orbs, sized off the viewport so they never crop oddly.
        orbA: {
          width: width * 1.05,
          height: width * 1.05,
          borderRadius: width * 0.525,
          top: -width * 0.6,
          right: -width * 0.35,
        },
        orbB: {
          width: width * 0.8,
          height: width * 0.8,
          borderRadius: width * 0.4,
          top: height * 0.28,
          left: -width * 0.45,
        },
        orbC: {
          width: width * 0.9,
          height: width * 0.9,
          borderRadius: width * 0.45,
          bottom: -width * 0.55,
          right: -width * 0.3,
        },
      }),
    };
  }, [width, height]);

  const initialMode = route.params?.mode === 'register' ? false : true;
  const [isLogin, setIsLogin] = useState(initialMode);
  const [isLoading, setIsLoading] = useState(false);
  const [deviceId, setDeviceId] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [showLoginPin, setShowLoginPin] = useState(false);
  const [showRegisterPin, setShowRegisterPin] = useState(false);

  const [loginPin, setLoginPin] = useState('');
  const [registerPin, setRegisterPin] = useState('');

  const scaleValue = useRef(new Animated.Value(1)).current;

  // UI-ONLY state — drives the focused-field treatment. Touches no logic.
  const [focusedField, setFocusedField] = useState(null);

  // Warning shown under the PIN boxes. Empty until the user actually gets the
  // PIN wrong (or is locked out) — no scary text on a clean first visit.
  const [pinWarning, setPinWarning] = useState('');

  // --- Biometric unlock state ----------------------------------------------
  // `available` = this device has usable hardware. `enabled` = the user opted
  // in AND the sealed PIN is still readable. Both are needed before the app
  // offers a scanner; `label`/`shape` come from the OS so the wording and the
  // glyph match the real sensor (Face ID vs Fingerprint vs Iris).
  const [bio, setBio] = useState({
    available: false,
    enabled: false,
    label: '',
    shape: 'finger',
  });
  const [bioBusy, setBioBusy] = useState(false);
  // Message under the PIN boxes for biometric outcomes specifically, kept
  // separate from pinWarning so a failed scan never overwrites a live lockout
  // notice (and vice versa).
  const [bioNote, setBioNote] = useState('');
  // Refs, not state: changing these must never re-render, and the auto-prompt
  // guard has to survive the re-render that starting the prompt causes —
  // a state flag would let a second prompt fire before the first committed.
  const bioFailures = useRef(0);
  const bioAutoRan = useRef(false);
  // Pulse halo behind the scanner button — a ring that expands and fades every
  // 2s, matching the approved design. Runs only while the button is visible
  // and idle: motion during a scan would compete with the OS sheet, and a loop
  // left running after unmount leaks a timer.
  const bioPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!bio.enabled || bioBusy) {
      bioPulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bioPulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        // hold invisible briefly so the pulses read as beats, not a strobe
        Animated.timing(bioPulse, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(600),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bio.enabled, bioBusy, bioPulse]);
  // Always points at the CURRENT runBiometric. The auto-prompt timer would
  // otherwise capture the closure from the render in which bio.enabled first
  // became true, where isLoading was still false — so a scan finishing after
  // the user had already tapped LOGIN would sail past the `if (isLoading)`
  // guard and fire a second concurrent app_token_checker request.
  const runBiometricRef = useRef(null);
  // Lets the screen open the keypad the moment it stops offering a scanner.
  const loginPinRef = useRef(null);
  // Guards every setState that happens after an await. The biometric sheet can
  // stay up indefinitely, and handleLogin's finally{} runs after
  // navigation.replace() has already unmounted this screen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Explicit logout must actually log the user out.
  //
  // clearSession() deliberately keeps the PIN and the biometric enrolment, so
  // without this the Login screen would mount, auto-prompt, succeed, and put
  // the user straight back into the app before they could touch anything —
  // making Logout a no-op and making it impossible to hand the phone over.
  // The scanner BUTTON stays on screen; only the automatic firing is skipped.
  const suppressAutoBio = route.params?.suppressAutoBiometric === true;

  // --- Continuous ambient animations (background orbs only) -----------------
  // The loops are held in variables and stopped on unmount so they don't keep
  // running after the screen is gone.
  const floatAnim1 = useRef(new Animated.Value(0)).current;
  const floatAnim2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop1 = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim1, { toValue: 1, duration: 4000, useNativeDriver: true }),
        Animated.timing(floatAnim1, { toValue: 0, duration: 4000, useNativeDriver: true }),
      ]),
    );
    const loop2 = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim2, { toValue: 1, duration: 5500, useNativeDriver: true }),
        Animated.timing(floatAnim2, { toValue: 0, duration: 5500, useNativeDriver: true }),
      ]),
    );
    loop1.start();
    loop2.start();
    return () => {
      loop1.stop();
      loop2.stop();
    };
  }, [floatAnim1, floatAnim2]);

  // --- Entrance choreography ---------------------------------------------
  // ONE Animated.Value drives the whole screen. Each block reads it through a
  // different interpolation window, which produces a staggered cascade from a
  // single native-driver animation instead of five competing timers. Cheap,
  // and it cannot desynchronise.
  const enter = useRef(new Animated.Value(0)).current;

  // Focus rings: separate native-driver opacity per field, so focusing a field
  // animates a ring in rather than hard-swapping a border colour.
  const userFocusAnim = useRef(new Animated.Value(0)).current;
  const passFocusAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(enter, {
      toValue: 1,
      duration: 900,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop(); // stop if the screen unmounts mid-flight
  }, [enter]);

  // Animate whichever field just gained/lost focus.
  useEffect(() => {
    Animated.parallel([
      Animated.timing(userFocusAnim, {
        toValue: focusedField === 'username' ? 1 : 0,
        duration: 170,
        useNativeDriver: true,
      }),
      Animated.timing(passFocusAnim, {
        toValue: focusedField === 'password' ? 1 : 0,
        duration: 170,
        useNativeDriver: true,
      }),
    ]).start();
  }, [focusedField, userFocusAnim, passFocusAnim]);

  useEffect(() => {
    const initialize = async () => {
      // Use the shared, PERSISTED device id — never DeviceInfo.getUniqueId()
      // directly. Registration, token minting and the portal WebViews must all
      // send the identical value or login_app.php rejects the mismatch.
      const id = await getDeviceId();
      if (!mountedRef.current) return;
      setDeviceId(id);
      const registered = await getItem(KEYS.isRegistered);
      if (!mountedRef.current) return;
      if (registered === 'true') {
        setIsLogin(true);
      }

      // Ask the OS what it has, and the keychain whether we're actually
      // enrolled. Wrapped because neither answer is worth breaking login over:
      // if this throws, `bio` stays all-false and the screen is exactly the
      // PIN-only screen it was before this feature existed.
      try {
        const cap = await getBiometricCapability();
        const enabled = cap.ready ? await isBiometricEnabled() : false;
        if (!mountedRef.current) return;
        setBio({
          available: cap.ready,
          enabled,
          label: cap.label,
          shape: cap.shape,
        });
      } catch (e) {}
    };
    initialize();
  }, []);

  // Auto-prompt: fire the scanner as soon as the screen is ready.
  //
  // Gated on `deviceId` as well as `bio.enabled` — a scan that succeeds before
  // the device id has loaded would post an empty device_id to
  // app_token_checker and be rejected as an unknown device.
  //
  // The short delay matters on iOS: presenting LAContext during the same frame
  // as mount races the navigation transition and the prompt can be silently
  // dropped. It also lets the entrance animation start, so the sheet slides
  // over a drawn screen rather than a blank one.
  useEffect(() => {
    if (suppressAutoBio) return;
    if (!isLogin || !deviceId || !bio.enabled || bioAutoRan.current) return;
    bioAutoRan.current = true;
    let fired = false;
    const t = setTimeout(() => {
      fired = true;
      // Through the ref, so the call uses the latest state, not a snapshot
      // taken 350ms ago.
      if (runBiometricRef.current) runBiometricRef.current();
    }, 350);
    return () => {
      clearTimeout(t);
      // If the effect was torn down before the timer fired — switching to the
      // Register tab within that window, say — release the guard. Otherwise
      // the scanner would be permanently suppressed for this visit despite
      // nothing having failed.
      if (!fired) bioAutoRan.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLogin, deviceId, bio.enabled, suppressAutoBio]);

  const handleDifferentUser = () => {
    switchMode(false);
  };

  // Open the keypad. Called whenever the screen stops offering a scanner, so
  // the user is never left staring at PIN boxes with no keyboard — `autoFocus`
  // can't cover this because it only applies at mount. Deferred a tick so the
  // focus lands after the biometric sheet has finished dismissing; iOS drops a
  // focus() issued while its own sheet is still animating away.
  const focusPin = () => {
    setTimeout(() => {
      if (mountedRef.current && loginPinRef.current) loginPinRef.current.focus();
    }, 250);
  };

  // Run the scanner and, on success, feed the recovered PIN into the SAME
  // handleLogin() a typed PIN goes through.
  //
  // That is the important part of the design: biometrics do not get their own
  // shortcut into the app. They produce a PIN, which is still compared, still
  // subject to the lockout, and still followed by the server-side
  // app_token_checker call that decides whether this user + device is allowed
  // in. A device whose account was disabled at head office cannot Face-ID past
  // that, because the face never touches the authorisation decision.
  const runBiometric = async () => {
    if (bioBusy || isLoading) return;
    if (bioFailures.current >= MAX_BIO_FAILURES) return;

    // A scan must not be a way around the PIN lockout — otherwise the whole
    // brute-force throttle in services/pin.js is bypassable by tapping a
    // different button.
    let lockedForMs = 0;
    try {
      lockedForMs = await getLockRemainingMs();
    } catch (e) {}
    if (lockedForMs > 0) {
      setBioNote('');
      setPinWarning(`Login locked. Try again in ${formatDuration(lockedForMs)}.`);
      return;
    }

    setBioBusy(true);
    let res;
    try {
      res = await biometricUnlock(`Unlock Amul Dairy with ${bio.label}`);
    } catch (e) {
      res = { ok: false, reason: 'failed' };
    }
    // The sheet can sit open for minutes; the user may have navigated away.
    if (!mountedRef.current) return;
    setBioBusy(false);

    if (res.ok) {
      bioFailures.current = 0;
      setBioNote('');
      handleLogin(res.pin);
      return;
    }

    switch (res.reason) {
      case 'cancelled':
        // The user chose to type instead. That is a normal choice, not a
        // failure — say nothing and don't count it against them.
        setBioNote('');
        break;

      case 'invalidated':
        // Someone added a fingerprint / re-enrolled a face, or removed the
        // device passcode, so the OS destroyed the key. This is the protection
        // working, so explain it rather than showing a generic error.
        setBio(b => ({ ...b, enabled: false }));
        setBioNote(
          `${bio.label} was turned off because the biometrics on this device changed. Sign in with your PIN to set it up again.`,
        );
        focusPin();
        break;

      case 'unavailable':
      case 'no-secret':
        setBio(b => ({ ...b, enabled: false }));
        setBioNote('Biometric unlock isn’t available right now. Please use your PIN.');
        focusPin();
        break;

      default: {
        bioFailures.current += 1;
        const left = MAX_BIO_FAILURES - bioFailures.current;
        if (left <= 0) {
          // Hide the scanner for THIS visit only. The sealed PIN is untouched,
          // so the next launch offers biometrics again — a bad-light Face ID
          // day shouldn't permanently switch the feature off.
          setBio(b => ({ ...b, enabled: false }));
          setBioNote(`${bio.label} didn’t match. Please enter your PIN.`);
          focusPin();
        } else {
          setBioNote(
            `${bio.label} didn’t match — ${left} attempt${left === 1 ? '' : 's'} left.`,
          );
        }
      }
    }
  };

  // Refreshed on every render so the auto-prompt timer always calls the newest
  // version. Assigned during render on purpose: an effect would run one commit
  // late, which is exactly the window the timer fires in.
  runBiometricRef.current = runBiometric;

  // After a correct PIN login, offer to switch biometrics on. Resolves only
  // once the user has answered, so the caller can await it before navigating —
  // firing an Alert and immediately replacing the screen loses the dialog on
  // Android.
  const offerBiometricEnrolment = async pin => {
    let offer;
    try {
      offer = await shouldOfferBiometric();
    } catch (e) {
      return;
    }
    if (!offer) return;

    await new Promise(resolve => {
      Alert.alert(
        `Use ${offer.label} next time?`,
        `Sign in with ${offer.label} instead of typing your PIN. Your PIN keeps working, so you can still use it whenever you want.`,
        [
          {
            text: 'Not now',
            style: 'cancel',
            onPress: async () => {
              await declineBiometric();
              resolve();
            },
          },
          {
            text: 'Turn on',
            onPress: async () => {
              const r = await enableBiometric(pin);
              // 'cancelled' means they backed out of the confirm scan — no
              // need to report that back to them, they know they did it.
              if (!r.ok && r.reason !== 'cancelled') {
                Alert.alert(
                  'Not set up',
                  `${offer.label} could not be set up on this device. You can try again from Settings.`,
                );
              }
              resolve();
            },
          },
        ],
        // Android's tap-outside dismiss would leave this promise pending
        // forever and the user stuck on the login screen.
        { cancelable: false },
      );
    });
  };

  const handleRegister = async () => {
    // Guard against a second tap while the first request is still in flight, so
    // the user can't fire concurrent registrations for the same device. The
    // button is also `disabled` while loading; this is the belt to that braces,
    // and it additionally covers PinInput's onComplete auto-submit path.
    if (isLoading) return;

    const enteredPin = registerPin;
    if (!username || !password)
      return Alert.alert('Missing Input', 'Enter Username/Password');
    if (enteredPin.length !== 4)
      return Alert.alert('Invalid PIN', 'Set a 4-digit PIN.');

    setIsLoading(true);
    try {
      // app_user_registration.php expects: username, password, device_id.
      // The PIN is validated on the device and intentionally not sent/stored.
      const formData = new FormData();
      formData.append('username', username);
      formData.append('password', password);
      formData.append('device_id', deviceId);
      // 'android' | 'ios' — stored on the device row. Sent HERE as well as from
      // notifications.js because a user who declines the notification
      // permission never calls save_fcm_token.php, and those are precisely the
      // devices worth being able to identify later.
      formData.append('platform', Platform.OS);

      // Bounded request (headers AND body) — a hanging connection must surface
      // as an error, not an infinite spinner (App Store rejection 2.1(a)).
      const { text } = await fetchTextWithTimeout(API_URL, { method: 'POST', body: formData });
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // Never surface the raw body: when the endpoint returns an HTML error
        // page this would leak PHP stack traces, server paths and SQL errors to
        // the end user. Log it in development only.
        if (__DEV__) {
          console.warn('[register] non-JSON response:', text.substring(0, 500));
        }
        Alert.alert(MSG.SERVER.title, MSG.SERVER.message);
        setIsLoading(false);
        return;
      }

      if (data.status === 'success') {
        await setItems({
          [KEYS.userPin]: enteredPin,
          [KEYS.userId]: data.user_id,
          [KEYS.userName]: data.user_name || '', // backend returns "user_name"
          [KEYS.username]: username,
          [KEYS.userType]: data.user_type || '', // 'e' (employee) or 's' (student)
          [KEYS.isRegistered]: 'true',
        });
        // A fresh registration starts from a clean slate — drop any lockout the
        // previous account left behind.
        await clearAttempts();
        // …and destroy any biometric secret belonging to the PREVIOUS user.
        // Without this, the face enrolled by whoever registered this device
        // last would still unseal their old PIN, and the new account would
        // inherit an unlock it never consented to. This also resets the
        // "declined" marker, so the new user gets asked in their own right.
        try {
          await disableBiometric();
        } catch (e) {}
        setBio(b => ({ ...b, enabled: false }));
        bioAutoRan.current = false;
        Alert.alert('Success', data.message || 'Registered & Authorized!');
        switchMode(true);
      } else {
        // The server sends a machine-readable `code` alongside `message`, so
        // each failure gets its own title and wording instead of one generic
        // "Failed". The device-blocked case matters most: the user has typed a
        // CORRECT password and must not walk away thinking it was wrong —
        // they need to know the account is locked to another phone and that
        // only IT can release it. Falls back to data.message for any code this
        // app version doesn't know yet.
        switch (data.code) {
          case 'device-blocked':
            Alert.alert(
              'Registered on Another Device',
              `This account is already registered on a different device${
                data.bound_since ? ` (since ${data.bound_since})` : ''
              }. For security reasons, an account works on only one device.\n\nTo use this device, please contact the IT department to unlock new device registration, then register again.`,
            );
            break;
          case 'bad-credentials':
            Alert.alert(
              'Incorrect Details',
              'The username or password you entered is not correct. Please check both and try again.',
            );
            break;
          case 'inactive':
            Alert.alert(
              'Account Inactive',
              data.message ||
                'Your account is not active. Please contact the administrator.',
            );
            break;
          case 'no-device-id':
            Alert.alert(
              'Device Not Recognised',
              'The app could not identify this phone. Please close the app completely, reopen it, and try again.',
            );
            break;
          case 'unavailable':
            Alert.alert(
              'Please Try Again',
              'Registration is temporarily unavailable. Please wait a moment and try again. If this continues, contact IT support.',
            );
            break;
          default:
            Alert.alert(
              'Registration Failed',
              data.message || 'Invalid Credentials / User Disabled',
            );
        }
      }
    } catch (error) {
      Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async pinArg => {
    // Guard against a second tap while a token check is already in flight.
    if (isLoading) return;

    // pinArg is the completed PIN string when auto-submitted from PinInput's
    // onComplete; the LOGIN button passes a press event, so fall back to state.
    const enteredPin = typeof pinArg === 'string' ? pinArg : loginPin;

    // Reject an incomplete PIN BEFORE the attempt counter sees it. Without
    // this, tapping LOGIN on an empty form counts as a wrong PIN, so five taps
    // by anyone who briefly holds the phone locks the real owner out — and,
    // now that a lockout also blocks the scanner, locks them out of biometrics
    // too. An unfinished entry is not a guess.
    if (!/^\d{4}$/.test(enteredPin || '')) {
      setPinWarning('Enter your 4-digit PIN.');
      return;
    }

    // Step 0 — refuse to even compare the PIN while a lockout is active.
    // Fail-open on a storage error: a broken lock counter must not make the
    // Login button silently dead.
    let lockedForMs = 0;
    try {
      lockedForMs = await getLockRemainingMs();
    } catch (e) {}
    if (lockedForMs > 0) {
      setLoginPin('');
      setPinWarning(`Login locked. Try again in ${formatDuration(lockedForMs)}.`);
      Alert.alert(
        'Too many attempts',
        `Login is locked. Try again in ${formatDuration(lockedForMs)}.`,
      );
      return;
    }

    // Guarded like every other storage read on this screen: an AsyncStorage
    // rejection here would reject handleLogin unhandled and turn the LOGIN
    // button into a silent no-op.
    let storedPin = null;
    let storedUsername = null;
    let storedUserId = null;
    try {
      [storedPin, storedUsername, storedUserId] = await Promise.all([
        getItem(KEYS.userPin),
        getItem(KEYS.username),
        getItem(KEYS.userId),
      ]);
    } catch (e) {
      Alert.alert(MSG.SESSION_MISSING.title, 'Your login data could not be read. Please try again.');
      return;
    }

    if (!storedUsername) {
      // Same family as MSG.SESSION_MISSING, but the remedy here is
      // re-registration (this device has no stored account), so the body says
      // register rather than login.
      Alert.alert(MSG.SESSION_MISSING.title, 'Your login data could not be read. Please register again.');
      navigation.replace('Login', { mode: 'register' });
      return;
    }

    // Step 1 — verify the 4-digit PIN locally. No network needed.
    if (storedPin !== enteredPin) {
      setLoginPin('');
      // If the attempt counter can't be persisted, still tell the user the
      // PIN was wrong — never fail silently.
      let result = null;
      try {
        result = await registerFailedAttempt();
      } catch (e) {}
      if (!result) {
        setPinWarning('Wrong PIN — try again.');
        Alert.alert('Wrong PIN', 'Try again.');
        return;
      }
      if (result.lockedForMs > 0) {
        setPinWarning(`Login locked for ${formatDuration(result.lockedForMs)}.`);
        Alert.alert(
          'Too many attempts',
          `Login is locked for ${formatDuration(result.lockedForMs)}.`,
        );
      } else {
        const left = result.remainingBeforeLock;
        setPinWarning(
          `Wrong PIN — ${left} attempt${left === 1 ? '' : 's'} left before login is temporarily locked.`,
        );
        Alert.alert(
          'Wrong PIN',
          `Try again. ${left} attempt${left === 1 ? '' : 's'} left before login is temporarily locked.`,
        );
      }
      return;
    }

    // PIN correct — reset the counter so a later mistake starts from zero.
    // (Best-effort: a storage failure here must not block a correct login.)
    try {
      await clearAttempts();
    } catch (e) {}
    setPinWarning('');

    // Step 2 — PIN correct. Ask app_token_checker whether this user + device is
    // still active (not disabled / not registered on another device).
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append('employee_id', storedUserId || '');
      formData.append('device_id', deviceId);

      const { text } = await fetchTextWithTimeout(TOKEN_CHECK_URL, {
        method: 'POST',
        body: formData,
      });
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        if (__DEV__) {
          console.warn('[login] non-JSON response:', text.substring(0, 500));
        }
        Alert.alert(MSG.SERVER.title, MSG.SERVER.message);
        setIsLoading(false);
        return;
      }

      if (String(data.emp_status) === '1') {
        // Active. Persist any fresh token (students get an empty one), then enter.
        if (data.token) {
          await setItems({
            [KEYS.apiToken]: data.token,
            [KEYS.tokenDate]: data.token_date || '',
          });
        }
        // Plant, refreshed on every login. Written OUTSIDE the token block
        // above on purpose: students get an empty token, and their plant
        // (correctly blank) must still overwrite whatever was stored before —
        // otherwise a shared phone could leave the previous employee's plant
        // behind for the next person.
        await setItems({
          [KEYS.plantNo]: data.nu_plant_code || '',
          [KEYS.plantCode]: data.vc_plant_code || '',
        });
        // Load THIS user's sidebar menu (app_menu.php filters by user_type) so the
        // drawer shows the correct items. Non-fatal: falls back to cache on error.
        try {
          await refreshSidebarMenu();
        } catch (e) {}
        // Offer biometrics here, and only here: this is the one moment we know
        // the PIN is correct AND that the person holding the phone just proved
        // they know it. Enrolling a face against a PIN the current holder never
        // entered would be handing them someone else's account.
        // No-ops if already enabled, already declined, or unsupported.
        await offerBiometricEnrolment(enteredPin);
        // Fresh session: allow a future expiry to be reported again.
        resetSessionExpiredLatch();

        // Push notifications: ask permission, upload this install's FCM token,
        // subscribe to the announcement topics.
        //
        // NOT awaited. It shows an OS permission dialog on first run and makes
        // a network call — making the user stare at the login spinner through
        // both would be a poor trade for a feature that is not needed to use
        // the app. It runs in the background and re-runs at every launch, so a
        // failure now costs nothing.
        //
        // Fires AFTER login because it needs the employee id and a live session
        // token; the endpoint is behind require_token.php like every other one.
        registerForPush().catch(() => {});

        navigation.replace('MainApp');
      } else {
        // The server no longer recognises this user + device pairing. Under the
        // bind-once policy that means one of: the account was disabled, or IT
        // released this device on the portal (e.g. to move the account to a new
        // phone). "Register Again" is still offered because on a released
        // account, re-registering from this same phone is exactly the right
        // next step — and if the account is disabled or bound elsewhere, the
        // registration screen will explain that specifically.
        Alert.alert(
          'Login Not Allowed',
          data.message ||
            'This phone is no longer registered to your account. This can happen if your account was disabled, or if the IT department reset your device registration.\n\nIf you still use this phone, tap "Register Again" and sign in with your username and password. If you cannot register, please contact the IT department.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Register Again', onPress: () => switchMode(false) },
          ],
        );
      }
    } catch (error) {
      Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
    } finally {
      // Skipped on the success path, where navigation.replace('MainApp') has
      // already unmounted this screen.
      if (mountedRef.current) setIsLoading(false);
    }
  };

  const switchMode = targetModeIsLogin => {
    setIsLogin(targetModeIsLogin);
    setUsername('');
    setPassword('');
    setLoginPin('');
    setRegisterPin('');
    setShowPassword(false);
    setShowLoginPin(false);
    setShowRegisterPin(false);
    // UI-only: drop any focus treatment / warning left from the previous mode.
    setFocusedField(null);
    setPinWarning('');
    setBioNote('');
  };

  const onPressIn = () =>
    Animated.spring(scaleValue, {
      toValue: 0.95,
      useNativeDriver: true,
    }).start();
  const onPressOut = () =>
    Animated.spring(scaleValue, { toValue: 1, useNativeDriver: true }).start();

  // Staggered entrance style for block `i` — later blocks start later and
  // travel slightly further, which reads as depth rather than a uniform slide.
  const rise = i => {
    const start = Math.min(i * 0.1, 0.45);
    return {
      opacity: enter.interpolate({
        inputRange: [start, start + 0.5],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      transform: [
        {
          translateY: enter.interpolate({
            inputRange: [start, start + 0.5],
            outputRange: [18 + i * 3, 0],
            extrapolate: 'clamp',
          }),
        },
      ],
    };
  };

  return (
    <View style={styles.mainContainer}>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />

      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Animated.View style={[
          styles.orbContainer, dyn.orbA,
          { transform: [{ translateY: floatAnim1.interpolate({ inputRange: [0, 1], outputRange: [0, 40] }) }] }
        ]}>
          <LinearGradient colors={['rgba(227,0,27,0.28)', 'rgba(227,0,27,0)']} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[
          styles.orbContainer, dyn.orbB,
          { transform: [{ translateX: floatAnim2.interpolate({ inputRange: [0, 1], outputRange: [0, -30] }) }, { translateY: floatAnim2.interpolate({ inputRange: [0, 1], outputRange: [0, 30] }) }] }
        ]}>
          {/* Same red family as the other orbs — the previous navy grey read
              as a smudge against the warm background instead of atmosphere.
              This one sits partly BEHIND the card, which is now the point:
              the real blur turns it into soft colour moving inside the glass. */}
          <LinearGradient colors={['rgba(227,0,27,0.16)', 'rgba(227,0,27,0)']} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[
          styles.orbContainer, dyn.orbC,
          { transform: [{ translateY: floatAnim1.interpolate({ inputRange: [0, 1], outputRange: [0, -40] }) }] }
        ]}>
          <LinearGradient colors={['rgba(227,0,27,0.22)', 'rgba(227,0,27,0)']} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingTop: topInset + SPACING.lg }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View style={dyn.column}>
            {/* Frosted glass card. GlassCard owns the blur, the platform-tuned
                tint, the edge treatment, AND the automatic fallback to a
                near-opaque card if the native blur ever fails. The entrance
                animation stays on this outer wrapper so the blur surface is
                never transformed while animating. */}
            <Animated.View style={rise(0)}>
              <GlassCard contentStyle={styles.cardContent}>

              <View style={styles.brandContainer}>
                <Image
                  source={LOGO_URL}
                  style={dyn.logo}
                  resizeMode="contain"
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel="Amul"
                />
              </View>

              <View style={styles.tabsContainer}>
                <View style={styles.tabs}>
                  <TouchableOpacity onPress={() => switchMode(true)} activeOpacity={0.7} style={styles.tab}>
                    <Text style={[styles.tabText, dyn.tabText, isLogin && styles.tabTextActive]}>Login</Text>
                    <View style={[styles.tabRule, isLogin && styles.tabRuleActive]} />
                  </TouchableOpacity>
                  {!isLogin && (
                    <TouchableOpacity onPress={() => switchMode(false)} activeOpacity={0.7} style={styles.tab}>
                      <Text style={[styles.tabText, dyn.tabText, !isLogin && styles.tabTextActive]}>Register</Text>
                      <View style={[styles.tabRule, !isLogin && styles.tabRuleActive]} />
                    </TouchableOpacity>
                  )}
                </View>
                <View style={styles.tabsRule} />
              </View>

              <View style={styles.formArea}>
                {isLogin ? (
                  <Animated.View style={[styles.pinSection, rise(1)]}>
                    <View style={styles.pinLabelRow}>
                      <Text style={[styles.label, dyn.label]}>LOGIN PIN</Text>
                      <EyeToggle visible={showLoginPin} onPress={() => setShowLoginPin(!showLoginPin)} size={19} style={styles.pinEye} />
                    </View>
                    <PinInput
                      ref={loginPinRef}
                      value={loginPin}
                      onChange={setLoginPin}
                      onComplete={handleLogin}
                      length={4}
                      secure={!showLoginPin}
                      // Don't raise the keyboard when the scanner is about to
                      // appear — the keyboard animating up behind the Face ID
                      // sheet is what makes this feature feel janky.
                      autoFocus={!bio.enabled}
                      cellSize={dyn.pinCell}
                      gap={8}
                    />
                    {/* Shown only after a wrong PIN or during a lockout —
                        a clean first visit sees no warning text at all. */}
                    {pinWarning ? (
                      <Text style={[styles.hint, styles.hintWarning]}>{pinWarning}</Text>
                    ) : null}

                    {/* Manual re-trigger. The scanner already fired on open;
                        this is for the user who dismissed it, or whose first
                        scan missed. Hidden entirely on devices with no
                        biometrics, and after the failure budget is spent. */}
                    {bio.enabled ? (
                      <>
                        <View style={styles.bioDivider}>
                          <View style={styles.bioDividerLine} />
                          <Text style={styles.bioDividerText}>OR</Text>
                          <View style={styles.bioDividerLine} />
                        </View>
                        <View style={styles.bioButtonWrap}>
                          <Animated.View
                            pointerEvents="none"
                            style={[
                              styles.bioHalo,
                              {
                                opacity: bioPulse.interpolate({
                                  inputRange: [0, 0.15, 1],
                                  outputRange: [0, 0.5, 0],
                                }),
                                transform: [
                                  {
                                    scale: bioPulse.interpolate({
                                      inputRange: [0, 1],
                                      outputRange: [0.85, 1.45],
                                    }),
                                  },
                                ],
                              },
                            ]}
                          />
                          <TouchableOpacity
                            style={styles.bioButton}
                            onPress={runBiometric}
                            disabled={bioBusy || isLoading}
                            activeOpacity={0.75}
                            accessibilityRole="button"
                            accessibilityLabel={`Sign in with ${bio.label}`}
                          >
                            {bioBusy ? (
                              <ActivityIndicator color={COLORS.primaryRed} />
                            ) : (
                              <BiometricIcon shape={bio.shape} size={34} color={COLORS.primaryRed} />
                            )}
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.bioButtonLabel}>
                          {bioBusy ? 'Waiting for scan…' : `Sign in with ${bio.label}`}
                        </Text>
                      </>
                    ) : null}

                    {bioNote ? <Text style={styles.bioNote}>{bioNote}</Text> : null}
                  </Animated.View>
                ) : (
                  <Animated.View style={rise(1)}>
                    <Text style={[styles.label, dyn.label]}>USERNAME / ID</Text>
                    <View style={styles.field}>
                      <Animated.View pointerEvents="none" style={[styles.focusRing, { opacity: userFocusAnim }]} />
                      <View style={styles.fieldIcon}>
                        <UserIcon size={19} color={focusedField === 'username' ? COLORS.primaryRed : COLORS.muted} />
                      </View>
                      <TextInput
                        style={[styles.input, dyn.inputText]}
                        placeholder="Enter your ID"
                        placeholderTextColor="#A8AEB8"
                        value={username}
                        onChangeText={setUsername}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="next"
                        onFocus={() => setFocusedField('username')}
                        onBlur={() => setFocusedField(null)}
                      />
                    </View>

                    <Text style={[styles.label, dyn.label, styles.labelSpaced]}>PASSWORD</Text>
                    <View style={styles.field}>
                      <Animated.View pointerEvents="none" style={[styles.focusRing, { opacity: passFocusAnim }]} />
                      <View style={styles.fieldIcon}>
                        <LockIcon size={19} color={focusedField === 'password' ? COLORS.primaryRed : COLORS.muted} />
                      </View>
                      <TextInput
                        style={[styles.input, dyn.inputText]}
                        placeholder="Enter your password"
                        placeholderTextColor="#A8AEB8"
                        secureTextEntry={!showPassword}
                        value={password}
                        onChangeText={setPassword}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        onFocus={() => setFocusedField('password')}
                        onBlur={() => setFocusedField(null)}
                      />
                      <EyeToggle visible={showPassword} onPress={() => setShowPassword(!showPassword)} size={19} style={styles.fieldTrailing} />
                    </View>

                    <View style={styles.stepRule} />

                    <View style={styles.pinLabelRow}>
                      <Text style={[styles.label, dyn.label]}>CHOOSE A 4-DIGIT PIN</Text>
                      <EyeToggle visible={showRegisterPin} onPress={() => setShowRegisterPin(!showRegisterPin)} size={19} style={styles.pinEye} />
                    </View>
                    <View style={styles.pinSectionCompact}>
                      <PinInput
                        value={registerPin}
                        onChange={setRegisterPin}
                        length={4}
                        secure={!showRegisterPin}
                        cellSize={dyn.pinCell}
                        gap={8}
                      />
                    </View>
                    <Text style={styles.hint}>You'll use this PIN to sign in from now on</Text>
                  </Animated.View>
                )}
              </View>

              <Animated.View style={rise(2)}>
                <TouchableWithoutFeedback
                  onPressIn={onPressIn}
                  onPressOut={onPressOut}
                  onPress={isLogin ? handleLogin : handleRegister}
                  disabled={isLoading}
                >
                  <Animated.View style={[styles.ctaShadow, isLoading && styles.ctaDisabled, { transform: [{ scale: scaleValue }] }]}>
                    <LinearGradient
                      colors={[COLORS.primaryRed, COLORS.redDark]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.cta}
                    >
                      {isLoading ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <View style={styles.ctaInner}>
                          <Text style={[styles.ctaText, dyn.buttonText]}>{isLogin ? 'Login' : 'Register'}</Text>
                          <ArrowRight />
                        </View>
                      )}
                    </LinearGradient>
                  </Animated.View>
                </TouchableWithoutFeedback>

                {isLogin && (
                  <TouchableOpacity style={styles.altAction} onPress={handleDifferentUser} activeOpacity={0.7}>
                    <Text style={styles.altActionText}>Sign in as a different user</Text>
                  </TouchableOpacity>
                )}
              </Animated.View>
              </GlassCard>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
};

const styles = StyleSheet.create({
  mainContainer: { flex: 1, backgroundColor: '#F8F9FA' },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingBottom: SPACING.xl,
    justifyContent: 'center',
  },
  orbContainer: { position: 'absolute', overflow: 'hidden' },
  // Inner padding of the GlassCard content layer (the card surface itself —
  // blur, tint, border, shadow, fallback — lives in components/GlassCard.jsx).
  cardContent: {
    padding: SPACING.lg,
    paddingTop: SPACING.xl,
  },
  brandContainer: { alignItems: 'center', marginBottom: SPACING.lg },
  tabsContainer: { position: 'relative', marginBottom: SPACING.lg, alignItems: 'center' },
  tabs: { flexDirection: 'row', justifyContent: 'center' },
  tab: { paddingHorizontal: SPACING.md, paddingBottom: 12 },
  tabText: { fontWeight: '600', color: COLORS.muted, letterSpacing: 0 },
  tabTextActive: { color: COLORS.darkText, fontWeight: '700' },
  tabRule: { position: 'absolute', left: 16, right: 16, bottom: 0, height: 3, borderRadius: 3, backgroundColor: 'transparent', zIndex: 2 },
  tabRuleActive: { backgroundColor: COLORS.primaryRed },
  tabsRule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, backgroundColor: COLORS.line },
  formArea: { width: '100%' },
  label: { fontWeight: '700', color: COLORS.mediumText, letterSpacing: 0.7, marginBottom: SPACING.xs + 2, fontSize: 12 },
  labelSpaced: { marginTop: SPACING.md + 4 },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 16,
    borderWidth: 1.5, borderColor: 'transparent', paddingHorizontal: SPACING.md, minHeight: 56,
  },
  focusRing: {
    ...StyleSheet.absoluteFillObject, borderRadius: 16, borderWidth: 1.5, borderColor: COLORS.primaryRed,
    backgroundColor: '#FFFFFF',
  },
  fieldIcon: { marginRight: SPACING.sm + 2 },
  fieldTrailing: { paddingLeft: SPACING.sm },
  input: { flex: 1, paddingVertical: Platform.OS === 'ios' ? 16 : 12, fontWeight: '600', color: COLORS.darkText },
  stepRule: { height: 1, backgroundColor: COLORS.line, marginVertical: SPACING.lg },
  pinSection: { alignItems: 'center', width: '100%' },
  pinSectionCompact: { alignItems: 'center', marginTop: SPACING.xs },
  pinLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', marginBottom: SPACING.xs },
  pinEye: { padding: SPACING.xs },
  hint: { fontSize: 13, color: COLORS.muted, marginTop: SPACING.md, textAlign: 'center', fontWeight: '500' },
  hintWarning: { color: COLORS.primaryRed, fontWeight: '600' },
  // --- Biometric block ------------------------------------------------------
  // "OR" rule, then the scanner target. The divider is what stops the round
  // button reading as a fifth PIN cell.
  bioDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: SPACING.lg,
    marginBottom: SPACING.md,
  },
  bioDividerLine: { flex: 1, height: 1, backgroundColor: COLORS.line },
  bioDividerText: {
    marginHorizontal: SPACING.md,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: COLORS.muted,
  },
  // Wrapper reserves the halo's maximum reach so the pulse never shifts layout.
  bioButtonWrap: {
    width: 96,
    height: 96,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bioHalo: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: COLORS.primaryRed,
  },
  bioButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1.5,
    borderColor: COLORS.primaryRed,
    backgroundColor: COLORS.redTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bioButtonLabel: {
    marginTop: SPACING.sm,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.primaryRed,
    textAlign: 'center',
  },
  bioNote: {
    marginTop: SPACING.md,
    fontSize: 12.5,
    lineHeight: 18,
    color: COLORS.mediumText,
    textAlign: 'center',
    fontWeight: '500',
  },
  // Flat, crisp button container — the previous red glow (shadow + elevation)
  // hazed the button's edges and competed with the logo.
  ctaShadow: { marginTop: SPACING.xl, borderRadius: 16 },
  cta: { height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  ctaInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#FFFFFF', fontWeight: '700', letterSpacing: 0.2, fontSize: 16 },
  altAction: { alignSelf: 'center', marginTop: SPACING.lg, paddingVertical: SPACING.sm },
  altActionText: { color: COLORS.primaryRed, fontWeight: '700', fontSize: 14 },
});

export default LoginScreen;
