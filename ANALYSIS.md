# AmulApp — Whole-App Analysis

_Analysis date: 2026-09-18 · App version 1.0.3 · Reviewer: Claude (Cowork)_

This document reviews the AmulApp mobile client and its `/app_api` PHP backend across four dimensions: architecture, code quality & maintainability, security, and bugs & risks. Findings are prioritised, and the highest-impact items are collected at the end.

---

## 1. Overview & Technology Stack

AmulApp is the "Amul Common App" — an internal employee/student app for Amul Dairy that bundles attendance (QR + meeting), visitor/gate-pass entry, a DIL dispatch-entry workflow, and several web portals (Intranet, Digi, Dashboard, Milk Indent, DCS Hygiene) opened in an in-app WebView. Authentication is device-bound with a local 4-digit PIN and optional biometric unlock.

The stack is current and well chosen:

- **Client:** React Native 0.86, React 19.2, React Navigation 7 (stack + custom animated drawer). JSX (not TypeScript) for app code, though a `tsconfig`/`@types` are present.
- **Native modules:** `react-native-keychain` (Keychain/Keystore), `react-native-vision-camera`, `@react-native-community/geolocation`, `@react-native-firebase/messaging` v26 (push), `react-native-webview` v14, `react-native-device-info`.
- **Backend:** PHP on IIS (FastCGI), talking to **SQL Server** (`aml_society` via `sqlsrv`) and a secondary **MySQL** time-keeping DB (`webtom`/tomsys). SAP data via RFC HTTP wrappers. SMS/WhatsApp via an internal gateway.
- **Config discipline:** every server address is centralised in `src/config.js`; all endpoints are HTTPS (the Android network-security-config and iOS ATS exceptions were deliberately removed).

The codebase is unusually well documented. Almost every module carries a header explaining *why* it exists and what trade-offs were made, and several comments reference a prior security review (findings "H1" etc.). This is a real strength — the intent behind the code is legible.

---

## 2. Architecture

**Client structure** is clean and conventional:

- `navigation/` — `AppNavigator` (Splash → Login → MainApp/UpdateRequired) holds the app-wide session-expiry handler and the three push listeners. `MainNavigator` hosts the native screens plus a "kept-alive" portal WebView host (up to 3 live portals, LRU-evicted) and the drawer.
- `screens/` — one screen per feature. Thin wrapper screens (`AmulDigiScreen`, etc.) delegate to portals.
- `services/` — the backbone, and the best-factored part of the app: `api.js` (bounded fetch + token self-heal), `storage.js` (single source of truth for AsyncStorage keys), `device.js` (stable device id with iOS Keychain mirror), `biometrics.js`, `pin.js` (lockout), `session.js`, `menu.js`, `remoteConfig.js`, `version.js`, `notifications.js`, `location.js`.
- `components/`, `hooks/`, `constants/`, `utils/`.

**Data flow** is coherent: `apiPost()` attaches token + username + user_type + device_id to every FormData request, and on an auth-rejection response it refreshes the token once and retries — only surfacing "session expired" when the refresh itself fails. This single choke-point means auth behaviour cannot drift between screens.

**Backend** is a flat folder of single-purpose PHP endpoints under `/app_api`, each including `config_aml.php` for the DB handle and `require_token.php` for the shared auth guard. A parallel `/ios_api` folder still serves pre-1.0.3 installs; the config comments correctly warn that the two same-named files (e.g. `app_menu.php`) must never be copied over each other.

**Architectural observations:**

- The **DIL Entry** feature routes 9 distinct server operations through one endpoint (`dil_entry.php`) selected by a magic-string `rtype` (`'1'`…`'9'`), mirrored by one 2,700-line screen. This is the weakest architectural seam — see §3.
- **Two databases, two escaping regimes.** SQL Server access is parameterised throughout; the MySQL/tomsys mirror in `location_attendance.php` uses manual `mysqli_real_escape_string`. Consistent, but the split is a latent maintenance hazard.
- The **remote-config-over-version-check** pattern (server tunables piggy-backed on `app_version_check.php`, validated against bounds, fail-open) is a nicely designed piece of infrastructure.

---

## 3. Code Quality & Maintainability

**Strengths**

- Excellent separation of concerns in `services/`. `storage.js` centralises keys; nothing hand-writes a storage string.
- Consistent, defensive error handling: bounded requests (`fetchTextWithTimeout` keeps the abort timer armed until the body is fully read — closing a real infinite-spinner bug class), fail-open version checks, fail-closed auth.
- `location.js` is the standout: streaming `watchPosition` with convergence on accuracy, correct handling of iOS's `-1` invalid-accuracy sentinel, mock-location rejection, and rigorous listener/timer cleanup (including the synchronous-settle race guard).
- A Jest setup exists (`jest.config.js`, `jest.setup.js`, `__tests__/`), and some logic (e.g. the `looksUnauthorized` regex) is deliberately exported for testing.

**Weaknesses**

- **Monster components.** `DilEntryScreen.jsx` (2,695 lines, ~30 `useState`), `LoginScreen.jsx` (1,415), `VisitorEntry.jsx` (1,300). These mix UI, business logic, and API calls in one file. DIL Entry in particular should be decomposed (a batch-row component, a live-stock table, an added-products list) and its `rtype` operations wrapped in a named `dilApi` service so a reader doesn't have to cross-reference the PHP to know what `rtype: '9'` does.
- **Inconsistent unmount safety.** `LoginScreen` and `PortalWebView` correctly guard post-`await` `setState` with a `mountedRef`; `DilEntryScreen` has **no** unmount guard on any of its many async flows; `VisitorEntry`'s guard is **broken** (see §5).
- **Test coverage is thin** relative to the surface area — the auth/token, PIN-lockout, and location logic are the highest-value candidates for unit tests and are mostly untested.
- Minor: `__DEV__`-gated `console.log` diagnostics in `menu.js` are fine, but a couple of screens shadow state variables (`deviceId` in `VisitorEntry.fetchVisitTypes`) which invites future mis-edits.

---

## 4. Security Review

The **authentication and authorization model is genuinely strong** for an internal app, and clearly the product of a prior review:

- `require_token.php` is a single shared guard, now **enforcing** (`$TOKEN_ENFORCE = true`). It proves the token is active, unexpired, belongs to the requesting employee/student (**IDOR protection**), was issued to this device, and that the device binding is still active — plus a master-status check so an account disabled in HR loses API access immediately rather than at midnight.
- Tokens are 192-bit random (`random_bytes(24)`), 1-day, device-scoped, rotated on issue.
- **All SQL Server queries are parameterised.** The few string-interpolated values in `app_menu.php` (`$safeEmp`, `$blanketEmp`) are whitelist-sanitised to `[A-Za-z0-9_]` first, so they are not injectable.
- Biometrics are implemented correctly: the PIN is sealed in the Keychain/Keystore behind `BIOMETRY_CURRENT_SET`, so a successful scan *returns* the PIN into the normal login path rather than bypassing it — and re-enrolling a fingerprint destroys the key.
- Registration returns only the caller's own identity, sends no CORS header (deliberately, to avoid handing a username/state oracle to web pages), and requires POST so passwords never land in access logs.
- The FCM service-account JSON is referenced from **outside** the webroot (`D:/secure/…`), and `web.config` blocks direct HTTP access to `config_aml.php`, `require_token.php`, `fcm_send.php`, and `send_notification.php`, and refuses to serve `.log/.bak/.sql/.json`.

### Security findings (by severity)

**HIGH — Hardcoded credentials committed to source (and git history).**
- `config_aml.php`: SQL Server user `amlappit` / password `dCi%^3iuN`.
- `config_tomsys.php`: MySQL **`root`** / `AmulDairy@123` for the `webtom` database.
- `config_aml.php`: SMS/WhatsApp gateway `MSG_PASS = 'amuL1234'` (the code's own `TODO` admits it "has lived in source files (and git history) for years").

These live in the repository (`.git` is present) and this folder is connected to a developer workstation. Rotate all three now, move real secrets out of source into environment/`.env`-outside-webroot or IIS config, and treat the git history as compromised (the old values must be assumed known). Using the MySQL **`root`** account for an app connection is excessive privilege — create a least-privilege user scoped to the `punch_new` insert.

**MEDIUM — MilkIndent portal impersonation (documented, still live).**
`config.js` itself records that `milkindent.php` "accepts `?uid=<base64>` as identity, which lets anyone impersonate any employee," and today "trusts `android_id` alone." The app now sends a real session token (`api_token_id`) to enable proper auth, but until `login.php`/`milkindent.php` actually validate it against `soc_dtl_api_key`, the Milk Indent portal is an authorization gap reachable by anyone. This is backend work outside this repo, but it's the most serious *exploitable* auth weakness noted anywhere in the code.

**MEDIUM — Session token carried in WebView URL query string.**
`PortalWebView` passes the session (and FCM) token as percent-encoded query parameters because `login_app.php` reads them there. XSS/breakout is well defended (whitelist origins, `JSON.stringify`-escaped injection, `setSupportMultipleWindows={false}`), but tokens in URLs land in server access logs, any intermediary proxy, and WebView history. Given the token is short-lived and device-bound this is a considered trade-off; the durable fix is to pass it in a POST body or header to the login endpoint.

**MEDIUM — `send_notification.php` gated only by a shared passphrase.**
The admin broadcast page (`?key=amul2026`, in source) can message every employee at once. It is currently blocked at the web-server layer (`web.config` hiddenSegments) and the code loudly warns not to expose it before it sits behind the intranet login. Fine as-is *only* while that `web.config` entry remains; put it behind real authentication before enabling.

**LOW — PIN stored in plaintext in AsyncStorage.**
`KEYS.userPin` is written and compared locally in cleartext. The biometric path seals a copy in hardware, but the base credential is readable on a rooted/jailbroken device. `pin.js`'s own comment identifies the durable fix (Keychain-backed PIN + server-side attempt limiting). The client-side lockout is also defeatable by moving the device clock or editing storage — acceptable as defence against casual guessing, but not a determined attacker.

**LOW — Defence-in-depth / hygiene.**
- `app_menu.php` interpolates sanitised values into SQL rather than parameterising — not injectable today, but it should use `?` bind params to be robust against a future edit that widens the sanitiser.
- `insert_visitor_details.php` calls the SMS gateway with `CURLOPT_SSL_VERIFYPEER = false`, and several backend-to-backend calls (SAP RFC, short-link) use `http://`. Internal traffic, but worth tightening.
- Registration/token errors are uniform ("session expired") to avoid oracles — good; keep it that way.

Nothing in the reviewed code writes malware, and no client-side XSS or injection sink was found that survives the existing sanitisation.

---

## 5. Bugs & Risks

**HIGH — Likely crash on DIL Entry mount (temporal dead zone).**
In `DilEntryScreen.jsx`, `fetchDilDetails` is a `useCallback` defined at **line 330** whose dependency array (**line 514**) references `fetchAllStock` — but `fetchAllStock` is a `const useCallback` not declared until **line 723**. The component body runs top-to-bottom on every render, so evaluating the dependency array at line 514 reads `fetchAllStock` while it is still in its temporal dead zone, throwing `ReferenceError: Cannot access 'fetchAllStock' before initialization`. As written this should crash the screen on mount. **Recommended fix:** move the `fetchAllStock` / `fetchBatchStock` definitions above `fetchDilDetails` (or drop `fetchAllStock` from the dep array — it is called at runtime inside the body at line 452, which is unaffected). This one is worth confirming against a running build immediately; if the screen currently works, something in the build is masking it and it remains a latent trap.

**MEDIUM — `VisitorEntry` unmount guard doesn't work.**
The mount effect does `let mounted = true; fetchVisitTypes(mounted); … return () => { mounted = false; }`. The functions receive the boolean *value* `true`, not the closure variable, so the cleanup's `mounted = false` is never observed — a response arriving after unmount will `setState` on an unmounted component. Pass a ref (`mountedRef.current`) instead.

**MEDIUM — Editing the contact number wipes the whole VisitorEntry form.**
`onContactNoChange` resets to `{ ...EMPTY_FORM, contactNo: text }` for any length ≠ 10, clearing both captured photos and the ticket. Deleting one digit after filling the form discards everything the operator entered. Scope the reset to the looked-up identity fields only.

**LOW — DilEntry stock polling runs while the screen is blurred.**
The 20s interval is tied to `showEntry`, not focus; navigating away (screen kept mounted) leaves it polling. Gate it on `useFocusEffect`.

**LOW — Push token lifecycle on shared plant phones.**
`unregisterFromPush` unsubscribes topics but defers server-side token clearing to a separate call; if that logout call is ever skipped, the previous user's token stays addressable on a shared handset. Confirm the logout path clears it server-side. `subscribedTopics` is module-global and could go stale across a crash between login and logout (low severity).

**LOW — `onScanned` / manual dependency lists in DilEntry** rely on hand-maintained dep arrays with exhaustive-deps disabled; correct today, fragile under future edits.

---

## 6. Priority Recommendations

1. **Rotate the three hardcoded credentials now** (SQL Server app user, MySQL `root`, SMS gateway) and move secrets out of source; scrub/rotate given git history exposure. Replace MySQL `root` with a least-privilege account. *(High)*
2. **Fix the DIL Entry temporal-dead-zone crash** by reordering the `useCallback` definitions, and verify DIL Entry mounts on a device build. *(High)*
3. **Close the MilkIndent `?uid=` impersonation** by validating the session token server-side (backend work, but track it — the client already sends what's needed). *(Medium)*
4. **Fix `VisitorEntry`'s unmount guard and the form-wipe-on-edit** behaviour. *(Medium)*
5. **Move the WebView token out of the URL** into a POST/header to `login_app.php`; put `send_notification.php` behind real auth before enabling it. *(Medium)*
6. **Decompose `DilEntryScreen`** and introduce a named `dilApi` service; add unit tests for the auth/token, PIN-lockout, and location modules. *(Maintainability)*
7. **Migrate the PIN into the Keychain** for all users (not just biometric opt-ins), and add server-side attempt limiting. *(Low, durable)*

---

## Appendix — Files reviewed

Client: `App.jsx`, `index.js`, `config.js`, `theme.js`; navigation (`AppNavigator`, `MainNavigator`); services (`api`, `storage`, `session`, `pin`, `device`, `biometrics`, `remoteConfig`, `version`, `menu`, `notifications`, `location`); screens (`LoginScreen`, `DilEntryScreen`, `VisitorEntry`, `QrAttendanceScreen`, plus the rest by listing); components (`PortalWebView`, `Sidebar`, `QrScanner`, etc.).

Backend `/app_api`: `require_token.php`, `app_token_checker.php`, `app_user_registration.php`, `app_menu.php`, `save_fcm_token.php`, `send_notification.php`, `fcm_send.php`, `insert_visitor_details.php`, `location_attendance.php`, `dil_entry.php`, `config_aml.php`, `config_tomsys.php`, `web.config`.

_Not exhaustively read line-by-line: the remaining report/lookup PHP endpoints and several smaller UI components, though their patterns match those reviewed. Findings involving a running build (notably the DIL Entry crash) should be confirmed on-device._
