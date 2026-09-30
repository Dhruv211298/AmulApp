import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  BackHandler,
  Linking,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation } from '@react-navigation/native';
import { getItem, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import { getFcmToken } from '../services/notifications';
import { refreshToken } from '../services/api';
import { COLORS } from '../theme';
import BrandLoader from './BrandLoader';

// ---------------------------------------------------------------------------
// THE single in-app portal viewer.
//
// This replaces the two near-identical WebView implementations that previously
// lived in PortalView.jsx and WebViewScreen.jsx. They had drifted apart in ways
// that mattered: one encoded its query parameters and restricted navigation,
// the other did neither. Both call sites now share this hardened version.
//
// The portals authenticate through login_app.php, which expects three query
// params on the opening URL:
//   employee_key = the app's api_token      (KEYS.apiToken)
//   employee_id  = the logged-in user id    (KEYS.userId)
//   device_id    = this device's unique id  (services/device.js)
//
// Props:
//   url          full portal URL, e.g. https://digi.amuldairy.com/login_app.php
//   title        portal name, shown in the loader and error states
//   allowedHosts optional extra hostnames to treat as in-app (default: the
//                host of `url`)
// ---------------------------------------------------------------------------

// Viewport handling is declared PER PORTAL in config.js, not guessed at
// runtime. Two rounds of heuristics failed here because the two portals need
// opposite treatment and neither can be detected reliably:
//
//   * DCS Hygiene Audit ships its own responsive layout. Any interference
//     from us made it render tiny.
//   * The dashboard's main.php lays out with <table width=100%>, so at phone
//     width it COMPRESSES instead of overflowing — measuring its scrollWidth
//     reports "fits fine" while the cells are visibly clipped. Undetectable
//     by measurement, so it must be declared.
//
// Modes (config.js -> PORTALS[key].viewport):
//   undefined  : leave a page that has its own viewport meta alone; add
//                width=device-width only if it declares none. (Default —
//                what Intranet / Digi / Milk Indent have always had.)
//   { width:N }: force a viewport N CSS px wide, scaled down to fit the
//                screen. This is how Safari presents a desktop-width page:
//                whole width visible, pinch to zoom in.
const viewportJs = viewport => {
  if (viewport && viewport.width) {
    const w = parseInt(viewport.width, 10);
    return `
  (function() {
    try {
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) {
        m = document.createElement('meta');
        m.setAttribute('name', 'viewport');
        (document.head || document.documentElement).appendChild(m);
      }
      // Deliberately overrides any meta the page shipped: this portal is
      // declared desktop-width in config.js.
      function apply() {
        try {
          var sw = screen.width || window.innerWidth || 360;
          var scale = sw / ${w};
          m.setAttribute(
            'content',
            'width=${w}, initial-scale=' + scale + ', minimum-scale=' + scale
          );
        } catch (e) {}
      }
      apply();
      // Panels arrive by AJAX for several seconds; some frameworks reset the
      // viewport meta as they render, so re-assert it a few times.
      [600, 1500, 3000, 6000].forEach(function(ms) { setTimeout(apply, ms); });
      window.addEventListener('load', apply);
    } catch (e) {}
  })();
`;
  }

  return `
  (function() {
    try {
      // The page declares its own viewport -> it is mobile-aware, leave it be.
      if (document.querySelector('meta[name="viewport"]')) return;
      var m = document.createElement('meta');
      m.setAttribute('name', 'viewport');
      m.setAttribute('content', 'width=device-width, initial-scale=1.0');
      (document.head || document.documentElement).appendChild(m);
    } catch (e) {}
  })();
`;
};

// main.php sets window.onbeforeunload to return 'Sure?', which makes a confirm
// dialog pop on every navigation. Harmless in a desktop browser tab, but
// inside an app it looks like a malfunction. Suppressed for all portals.
const UNLOAD_PROMPT_JS = `
  (function() {
    try {
      window.onbeforeunload = null;
      window.addEventListener('beforeunload', function(e) {
        e.stopImmediatePropagation();
        delete e.returnValue;
      }, true);
    } catch (e) {}
  })();
`;

// Build the full injected script. If a portal asks to prefill an employee-id
// field (e.g. Milk Indent's first-time login form), we add a snippet that
// sets that input's value to the logged-in employee number. The value is
// hard-sanitized to alphanumerics and embedded via JSON.stringify, so it can
// never break out of the string or inject script. The `if (el)` guard makes
// it a harmless no-op on pages that don't have the field (e.g. the
// already-registered auto-login redirect).
const buildInjectedJs = (prefillFieldId, employeeId, viewport) => {
  let prefill = '';
  if (prefillFieldId && employeeId) {
    const safeEmp = String(employeeId).replace(/[^A-Za-z0-9_]/g, '');
    prefill = `
      (function() {
        var FIELD = ${JSON.stringify(prefillFieldId)};
        var VALUE = ${JSON.stringify(safeEmp)};
        function setIt() {
          try {
            var el = document.getElementById(FIELD);
            if (el && el.value !== VALUE) {
              el.value = VALUE;
              el.dispatchEvent(new Event('input',  { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {}
        }
        // Retry a few times: on iOS the form field can initialise a moment
        // AFTER load and wipe a value set too early, so one shot isn't
        // reliable. Idempotent — stops mattering once the value sticks.
        setIt();
        [150, 400, 800, 1500].forEach(function(ms) { setTimeout(setIt, ms); });
      })();
    `;
  }
  return `${viewportJs(viewport)}\n${UNLOAD_PROMPT_JS}\n${prefill}\ntrue;`;
};

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 13_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1 Mobile/15E148 Safari/604.1';

// Only amuldairy.com and its subdomains may load inside the app. Anything else
// is handed to the system browser, so a redirect or injected link can never
// render an off-domain page in a WebView that holds a live session token.
const ORIGIN_WHITELIST = ['https://*.amuldairy.com', 'https://amuldairy.com'];

export const hostOf = url => {
  const match = /^https?:\/\/([^/]+)/i.exec(url || '');
  return match ? match[1].toLowerCase() : '';
};

// Default query-param NAMES the portals' login_app.php expects.
const DEFAULT_PARAM_NAMES = {
  token: 'employee_key',
  employeeId: 'employee_id',
  deviceId: 'device_id',
};

// Append the portal auth params. Every value is percent-encoded: a token
// containing '&', '#', '+' or a space would otherwise silently truncate the
// query string and produce an intermittent, very hard to trace login failure.
//
// `names` lets a portal use DIFFERENT param names than the default. Milk
// Indent's login.php reads `android_id` + `token_id` rather than
// `device_id` + `employee_key`, so it passes { deviceId: 'android_id',
// token: 'api_token_id', fcmToken: 'token_id', employeeId: null }.
// A name set to null/'' is omitted.
//
// fcmToken is separate from token ON PURPOSE. They are different credentials
// that were previously conflated: `token` is this app's SESSION key from
// app_token_checker.php, while `fcmToken` is the Firebase delivery address.
// Milk Indent's login.php stores whatever arrives in `token_id` into
// milkindent_mst_user.mobile_token and later hands that value to Firebase as a
// destination — so sending the session key there produced a value Firebase can
// never deliver to, and the failure was invisible because the send code only
// tested for connection errors.
export const withAuthParams = (url, { token, employeeId, deviceId, fcmToken }, names) => {
  if (!url) return url;
  const n = { ...DEFAULT_PARAM_NAMES, ...(names || {}) };
  const parts = [];
  if (n.token) parts.push(`${n.token}=${encodeURIComponent(token || '')}`);
  if (n.employeeId) parts.push(`${n.employeeId}=${encodeURIComponent(employeeId || '')}`);
  if (n.deviceId) parts.push(`${n.deviceId}=${encodeURIComponent(deviceId || '')}`);
  if (n.fcmToken) parts.push(`${n.fcmToken}=${encodeURIComponent(fcmToken || '')}`);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${parts.join('&')}`;
};

// token_date is 'YYYY-MM-DD'. Returns true when it is older than today.
const isTokenDateExpired = tokenDate => {
  if (!tokenDate) return false;
  const exp = new Date(tokenDate);
  if (isNaN(exp.getTime())) return false;
  const today = new Date();
  exp.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return exp < today;
};

const PortalWebView = forwardRef(({
  url,
  title,
  allowedHosts,
  paramNames,
  prefillEmployeeField,
  // Per-portal viewport policy — see viewportJs() above. Omit for normal
  // responsive portals; pass { width: N } for desktop-width pages.
  viewport,
  // Told the parent whenever in-page history availability changes, so a host
  // (MainNavigator) can show a Back control and route the hardware button.
  onCanGoBackChange,
  // When this component is hosted by something that owns the back button
  // itself, set this false so we don't register a COMPETING handler.
  handleHardwareBack = true,
}, ref) => {
  const navigation = useNavigation();
  const webRef = useRef(null);

  const [sourceUrl, setSourceUrl] = useState(null);
  // Injected script; rebuilt with the employee number once it's resolved, so
  // the login form's employee field can be pre-filled.
  const [injectedJs, setInjectedJs] = useState(() =>
    buildInjectedJs(null, null, viewport),
  );
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  // Bumped by Retry — re-runs the session resolution AND remounts the WebView,
  // so a retry starts truly fresh (new token resolution, new load).
  const [reloadNonce, setReloadNonce] = useState(0);

  // LOAD WATCHDOG. A WebView pointed at a host whose packets are silently
  // dropped fires neither onLoadEnd nor onError — the loader would spin
  // forever (the exact bug class of App Store rejection 2.1(a), and this
  // component never unmounts, so it would never recover). If a load is still
  // "in flight" after 25s, declare it failed and show the Retry UI.
  useEffect(() => {
    if (!loading || failed) return undefined;
    const timer = setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, 25000);
    return () => clearTimeout(timer);
  }, [loading, failed]);

  const goToLogin = useCallback(() => {
    navigation.navigate('Login', { mode: 'login' });
  }, [navigation]);

  // Resolve the session and build the URL once, on mount.
  //
  // HARDENED against stranding: this component is kept ALIVE by MainNavigator
  // (hidden, never unmounted), so any state it gets stuck in persists for the
  // whole app session. Therefore: (1) the whole resolution is wrapped in
  // try/catch — a storage failure lands in the `failed` UI with a Retry button
  // instead of an eternal loader; (2) the session-expired alerts are
  // non-cancelable with onDismiss, so Android back-dismissing them can never
  // skip the navigation and orphan the screen.
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const [storedToken, employeeId, tokenDate, deviceId] = await Promise.all([
          getItem(KEYS.apiToken),
          getItem(KEYS.userId),
          getItem(KEYS.tokenDate),
          getDeviceId(),
        ]);

        if (isTokenDateExpired(tokenDate)) {
          if (mounted) {
            Alert.alert(
              'Session expired',
              'Your session has expired. Please login again.',
              [{ text: 'OK', onPress: goToLogin }],
              { cancelable: false, onDismiss: goToLogin },
            );
          }
          return;
        }

        // Refresh so the portal opens with the CURRENT active key. Falls back
        // to the stored token when offline or the endpoint errors.
        let token = storedToken || '';
        try {
          const fresh = await refreshToken();
          if (fresh) token = fresh;
        } catch (e) {
          // Non-fatal — the stored token may still be valid.
        }

        if (!token || !employeeId || !deviceId) {
          if (mounted) {
            Alert.alert('Session expired', 'Please login again.', [
              { text: 'OK', onPress: goToLogin },
            ], { cancelable: false, onDismiss: goToLogin });
          }
          return;
        }

        // Only ask Firebase when THIS portal actually wants the FCM token
        // (currently Milk Indent alone), so no other portal pays for a call it
        // has no use for. Never fatal: a portal must still open when
        // notifications are unavailable — the value is simply blank.
        let fcmToken = '';
        if (paramNames && paramNames.fcmToken) {
          fcmToken = await getFcmToken();
        }

        if (mounted) {
          // Build the injected script (with employee-field prefill if this
          // portal asked for it) BEFORE the WebView mounts via sourceUrl.
          setInjectedJs(
            buildInjectedJs(prefillEmployeeField, employeeId, viewport),
          );
          setSourceUrl(
            withAuthParams(url, { token, employeeId, deviceId, fcmToken }, paramNames),
          );
        }
      } catch (e) {
        // Storage/device-id failure — land in the failed UI (with Retry),
        // never in a permanent loader.
        if (mounted) {
          setLoading(false);
          setFailed(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [url, goToLogin, reloadNonce]);

  // Let a host component drive back navigation (see handleHardwareBack).
  useImperativeHandle(
    ref,
    () => ({
      canGoBack,
      goBack: () => {
        if (webRef.current) webRef.current.goBack();
      },
    }),
    [canGoBack],
  );

  // Android hardware back walks the WebView's history before popping the screen.
  //
  // Skipped when handleHardwareBack is false. That matters because
  // MainNavigator keeps several portals MOUNTED BUT HIDDEN — if each one
  // registered a handler, a hidden portal could swallow the back press and
  // navigate its own history instead of the visible one.
  useEffect(() => {
    if (!handleHardwareBack) return undefined;
    const onBack = () => {
      if (canGoBack && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [canGoBack, handleHardwareBack]);

  // Keep off-domain navigation out of the authenticated WebView.
  const onShouldStartLoadWithRequest = request => {
    const host = hostOf(request.url);
    if (!host) return true; // about:blank, data:, form posts to the same doc

    const initialHost = hostOf(url);
    const permitted =
      host === initialHost ||
      host.endsWith('.amuldairy.com') ||
      host === 'amuldairy.com' ||
      (allowedHosts || []).includes(host);

    if (!permitted) {
      Linking.openURL(request.url).catch(() => {});
      return false;
    }
    return true;
  };

  const reload = () => {
    // While `failed` is true the WebView is unmounted, so webRef is null and
    // calling reload() on it would be a no-op. Instead: reset the states and
    // bump the nonce — the mount effect re-resolves the session (fresh token)
    // and the WebView remounts and loads from scratch.
    setFailed(false);
    setLoading(true);
    setSourceUrl(null);
    setReloadNonce(n => n + 1);
  };

  if (!url) {
    return (
      <View style={styles.center}>
        <Text style={styles.errText}>No portal URL was provided.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {sourceUrl && !failed && (
        <WebView
          ref={webRef}
          source={{ uri: sourceUrl }}
          style={{ flex: 1 }}
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          pullToRefreshEnabled
          scalesPageToFit
          // The portal pages open almost every internal link with
          // target="_blank" (main.php does this for every report button).
          // On Android the WebView defaults to setSupportMultipleWindows=true,
          // which routes those links down the "open a new window" path — and
          // its default action is to hand the URL to the SYSTEM BROWSER. They
          // never reach onShouldStartLoadWithRequest, so the host whitelist
          // never gets a say and in-domain reports kicked the user out of the
          // app. Disabling multiple windows makes _blank links load in place,
          // through the normal (whitelisted) navigation path.
          setSupportMultipleWindows={false}
          // Belt and braces: if a new-window request still gets through on
          // some platform/version, navigate in place instead of leaving.
          onOpenWindow={syntheticEvent => {
            const targetUrl = syntheticEvent?.nativeEvent?.targetUrl;
            if (!targetUrl || !webRef.current) return;
            const host = hostOf(targetUrl);
            const permitted =
              host === hostOf(url) ||
              host.endsWith('.amuldairy.com') ||
              host === 'amuldairy.com' ||
              (allowedHosts || []).includes(host);
            if (permitted) {
              webRef.current.injectJavaScript(
                `window.location.href = ${JSON.stringify(targetUrl)}; true;`,
              );
            } else {
              Linking.openURL(targetUrl).catch(() => {});
            }
          }}
          userAgent={MOBILE_UA}
          injectedJavaScript={injectedJs}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => {
            setLoading(false);
            // RE-INJECT after every completed load. The injectedJavaScript
            // PROP re-runs on each Android navigation, but on iOS (WKWebView)
            // it is registered once and does NOT reliably re-run on the page
            // reached AFTER a server redirect (login_app.php -> the real
            // portal page). That is why, on iOS only, the DCS viewport fit and
            // the Milk Indent employee-number prefill silently stopped
            // working. Running it here via injectJavaScript() fires on BOTH
            // platforms on every finished load, so the viewport + prefill land
            // on the page the user actually sees. Every snippet is idempotent
            // and guarded, so re-running is harmless.
            if (webRef.current) {
              webRef.current.injectJavaScript(injectedJs);
            }
          }}
          onError={() => {
            setFailed(true);
            setLoading(false);
          }}
          onHttpError={syntheticEvent => {
            // 5xx / WAF-block pages are failures, not content.
            const code = syntheticEvent?.nativeEvent?.statusCode || 0;
            if (code >= 500) {
              setFailed(true);
              setLoading(false);
            }
          }}
          // iOS has no hardware back button, so without this there is NO way
          // to return from a second page. Enables the edge-swipe gesture.
          allowsBackForwardNavigationGestures
          onNavigationStateChange={state => {
            setCanGoBack(state.canGoBack);
            if (onCanGoBackChange) onCanGoBackChange(state.canGoBack);
          }}
        />
      )}

      {/* Branded loader, shown until the page first paints. */}
      {(!sourceUrl || loading) && !failed && <BrandLoader title={title} />}

      {failed && (
        <View style={styles.center}>
          <Text style={styles.errTitle}>Couldn't load the page</Text>
          <Text style={styles.errText}>
            Check your internet connection and try again.
          </Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={reload}
            activeOpacity={0.85}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#FFFFFF',
  },
  errTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 8,
  },
  errText: {
    fontSize: 14,
    color: COLORS.mediumText,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 20,
    backgroundColor: COLORS.primaryRed,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 50,
  },
  retryText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
});

export default PortalWebView;
