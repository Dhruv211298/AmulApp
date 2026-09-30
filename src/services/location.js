import { PermissionsAndroid, Platform, Linking } from 'react-native';
import Geolocation from '@react-native-community/geolocation';

// Configure the underlying provider ONCE, at module load.
//
// locationProvider: 'auto' -> on Android this uses Google Play Services' FUSED
// provider when available. The fused provider blends GPS + Wi-Fi + cell, so it
// returns a usable fix within a couple of seconds — even INSIDE a building,
// where a pure-GPS satellite lock can take 30s+ or never fix at all.
Geolocation.setRNConfiguration({
  skipPermissionRequests: false,
  authorizationLevel: 'whenInUse',
  locationProvider: 'auto',
});

// ---------------------------------------------------------------------------
// Accuracy policy
//
// Attendance is GEOFENCED: the server compares the coordinates we send against
// the stored site location and rejects anything out of range. That check is only
// as trustworthy as the fix behind it — if a position is accurate to ±500m, then
// someone 400m from the plant can land inside a 100m geofence purely through
// measurement error. The accuracy limit must therefore be at least as tight as
// the geofence radius, or the geofence stops meaning anything.
//
// 100m is the limit. It is NOT enforced by taking one reading and rejecting it —
// see getPositionForSubmission, which waits for the fix to converge. A fused
// position typically starts coarse (cell tower, ~1000m) and tightens to Wi-Fi
// accuracy (~10-50m) within a few seconds, indoors included. We give it that
// time rather than failing on the first coarse sample.
// ---------------------------------------------------------------------------
// Compiled-in fallback. The LIVE limits are PER-FEATURE and server-tunable —
// each screen passes its own limit from services/remoteConfig.js, so this
// module stays policy-neutral and the constant only backs callers that pass
// nothing.
export const ACCURACY_LIMIT_M = 100;

// Why a position request failed. Screens switch on these to show an accurate
// message — "turn on GPS" and "permission denied" need different fixes from the
// user, and telling them the wrong one wastes their time.
export const LOC_ERR = {
  PERMISSION_DENIED: 'permission_denied',
  PERMISSION_APPROXIMATE: 'permission_approximate',
  POSITION_UNAVAILABLE: 'position_unavailable',
  TIMEOUT: 'timeout',
  INACCURATE: 'inaccurate',
  MOCKED: 'mocked',
  UNKNOWN: 'unknown',
};

// At or above this reported accuracy on iOS, the fix is almost certainly the
// OS's fuzzed "Precise Location off" position rather than a weak signal.
// iOS reduced accuracy lands around 1-3km (classically ~1414m); a real GPS or
// Wi-Fi fix, even a poor indoor one, is well under a kilometre.
const REDUCED_ACCURACY_HINT_M = 900;

// Widest fix a best-effort submission may carry. Covers a basement cell-tower
// fix (~1-3km) while still rejecting garbage (no fix at all, or a fix so wide
// it says nothing about which town the user is in).
export const BEST_EFFORT_CAP_M = 3000;

// Accuracy mode per platform — the permanent fix for iPhones stuck at ~1414m.
//
// enableHighAccuracy means DIFFERENT things per platform:
//   Android: false selects the fused provider (GPS+Wi-Fi+cell) — fast and
//            accurate indoors. true forces satellite-only GPS, which indoors
//            takes 30s+ or never locks. false is correct on Android.
//   iOS:     false maps to kCLLocationAccuracyHundredMeters, which licenses
//            iOS to answer from the CHEAPEST source and never power up GPS.
//            With Wi-Fi off, that source is cell trilateration (~1-3km,
//            classically ~1414m) — and it stays there forever, because
//            nothing asked for better. true = kCLLocationAccuracyBest: iOS
//            blends GPS/Wi-Fi/cell itself and engages GPS when needed.
//
// So the correct request is platform-dependent, and hardcoding false (the old
// behaviour) silently broke iPhones without Wi-Fi. Battery impact on iOS is
// negligible: high accuracy runs only while these screens are open, minutes
// at most.
const HIGH_ACCURACY = Platform.OS === 'ios';

const makeError = (reason, message, extra = {}) => {
  const err = new Error(message);
  err.reason = reason;
  Object.assign(err, extra);
  return err;
};

// Open the OS settings page for this app, so a user who denied permission (or
// granted only "Approximate") can correct it without hunting through menus.
export const openLocationSettings = () =>
  Linking.openSettings().catch(() => {});

// ---------------------------------------------------------------------------
// Permission
//
// Returns { granted, precise }.
//
// The `precise` flag is the important one and the reason this isn't a plain
// boolean. On Android 12+ the permission dialog offers "Precise" and
// "Approximate". Choosing Approximate grants ACCESS_COARSE_LOCATION but NOT
// ACCESS_FINE_LOCATION, and the OS then returns coordinates deliberately fuzzed
// to roughly 1-3 km. The app is still "granted" location — it just receives
// useless numbers. Treating that as success is how a geofenced attendance
// system quietly starts recording people at the wrong site.
// ---------------------------------------------------------------------------
export async function ensureLocationPermission() {
  if (Platform.OS === 'ios') {
    try {
      // Prompt explicitly rather than relying on the implicit prompt from the
      // first getCurrentPosition call, so the user sees the dialog before we
      // start asking for fixes.
      Geolocation.requestAuthorization();
    } catch (e) {
      // Older versions throw if called twice — harmless.
    }
    // iOS reports the real authorisation state through the position callbacks
    // (a denial surfaces as a PERMISSION_DENIED error), and it has no
    // approximate/precise split we can read from here.
    return { granted: true, precise: true };
  }

  if (Platform.OS !== 'android') return { granted: true, precise: true };

  try {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);

    const fine =
      res[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED;
    const coarse =
      res[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED;

    return { granted: fine || coarse, precise: fine };
  } catch (e) {
    return { granted: false, precise: false };
  }
}

// ---------------------------------------------------------------------------
// Raw position helper — maps the platform error codes onto LOC_ERR.
// ---------------------------------------------------------------------------
const POSITION_ERROR_REASON = {
  1: LOC_ERR.PERMISSION_DENIED,
  2: LOC_ERR.POSITION_UNAVAILABLE, // location services off, or no provider
  3: LOC_ERR.TIMEOUT,
};

// Is a reported accuracy value one we can actually trust?
//
// Two traps, both of which silently defeat a geofence if you just write
// `accuracy <= limit`:
//
//   * iOS sets CLLocation.horizontalAccuracy NEGATIVE (-1) when the horizontal
//     fix is INVALID, and the RN module passes that through untouched. `-1 <= 100`
//     is true, so a naive check treats a position the OS has explicitly declared
//     meaningless as if it were sub-metre precise.
//   * A NaN accuracy passes `typeof acc === 'number'` but fails every comparison,
//     so it can never be improved upon and never satisfies the limit.
//
// Anything not finite and non-negative is therefore treated as UNKNOWN accuracy,
// and an unknown-accuracy fix is never good enough to submit against a geofence.
const hasUsableAccuracy = acc => Number.isFinite(acc) && acc >= 0;

const shapePosition = pos => ({
  lat: pos.coords.latitude,
  long: pos.coords.longitude,
  accuracy: pos.coords.accuracy,
  // Android exposes this when a "fake GPS" app supplied the fix. Not present on
  // every platform/version, hence the defensive read.
  mocked: pos.mocked === true || pos.coords.mocked === true,
  // Timestamp of the fix itself, NOT of when we received it — this is what makes
  // a staleness check possible.
  at: pos.timestamp || Date.now(),
});

function rawPosition(options) {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      pos => resolve(shapePosition(pos)),
      err =>
        reject(
          makeError(
            POSITION_ERROR_REASON[err && err.code] || LOC_ERR.UNKNOWN,
            (err && err.message) || 'Could not read the device location.',
          ),
        ),
      options,
    );
  });
}

// ---------------------------------------------------------------------------
// FAST fix — for live on-screen display only.
//
// Tuned for responsiveness, not for the record: low power, short timeout, and a
// recent cached fix is acceptable. Do NOT use this for anything that gets
// posted to the server.
// ---------------------------------------------------------------------------
export function getCurrentPosition(options = {}) {
  const { highAccuracy = false, timeout = 10000, maximumAge = 30000 } = options;
  return rawPosition({
    enableHighAccuracy: highAccuracy,
    timeout,
    maximumAge,
  });
}

// ---------------------------------------------------------------------------
// SUBMISSION-GRADE fix — for anything written to an attendance record.
//
// Accuracy mode is PLATFORM-DEPENDENT (see HIGH_ACCURACY above). On Android
// we stay on the fused provider (GPS + Wi-Fi + cell blended), which returns in
// 1-3s inside a building — forcing satellite GPS there means 30s+ indoor locks.
// On iOS we request best accuracy, because anything less licenses iOS to sit
// on a ~1414m cell fix forever when Wi-Fi is off. iOS blends sources itself,
// so this stays fast where a good fix is cheaply available.
//
// It CONVERGES rather than taking a single sample. A fused fix arrives fast but
// often starts coarse — the first sample may be a ~1000m cell-tower estimate,
// tightening to Wi-Fi accuracy (~10-50m) a second or two later. Taking one
// reading and rejecting it would fail constantly indoors; instead we stream
// fixes and resolve the moment one meets the accuracy bar. In practice this
// returns in 1-3s, the same as before, but with a fix good enough to geofence.
//
// What this adds over the plain display fix:
//
//   1. Accuracy convergence — resolve on the first fix within ACCURACY_LIMIT_M,
//      and if the deadline passes, fail with the BEST accuracy actually seen so
//      the user is told how close it got.
//   2. Freshness — a live stream, so the recorded position can't be a cached
//      reading from another building.
//   3. Mock rejection — refuse a fix flagged as coming from a fake-GPS app.
//
// Android keeps enableHighAccuracy:false throughout (fused provider — what
// makes this work inside a building); iOS runs at best accuracy per the
// HIGH_ACCURACY rationale above.
//
// Throws an Error carrying `.reason` (a LOC_ERR value) so the caller can render
// the right guidance. On INACCURATE the error also carries `.accuracy`.
// ---------------------------------------------------------------------------
export function getPositionForSubmission(options = {}) {
  // 15s on BOTH platforms. iOS GPS from cold can want longer, but past ~15s a
  // spinner reads as a hang and users abandon or force-quit — a fast, honest
  // failure ("try again" — the second attempt hits a warm GPS and converges in
  // seconds) beats a long silent wait. Visit flows pass a shorter window still,
  // because their best-effort tier accepts the interim fix anyway.
  //
  // bestEffort: for QR-verified flows (site visits). The QR code is physically
  // mounted at the location, so scanning it is itself proof of presence — the
  // coordinates are supporting evidence, not the gate. Indoors or in a
  // basement, NO device can reach the strict limit without Wi-Fi; insisting on
  // it there just blocks legitimate staff. With bestEffort, the strict limit
  // is still tried first (a good fix wins immediately and nothing changes for
  // outdoor scans); only when the window expires does the best real fix get
  // accepted, capped at BEST_EFFORT_CAP_M and still mock-rejected, with its
  // accuracy submitted alongside so the record is honest about its precision.
  const {
    accuracyLimit: accuracyLimitOpt = ACCURACY_LIMIT_M,
    timeout = 15000,
    bestEffort = false,
    bestEffortCap = BEST_EFFORT_CAP_M,
    // The latest fix from the screen's LIVE watch (already shaped). The watch
    // has been warming the GPS since the screen opened, so by the time the
    // user has scanned a QR and pressed submit this fix is usually already
    // good enough — evaluating it FIRST makes the common case instant instead
    // of re-acquiring from zero. It goes through the same gates as any
    // streamed fix (mock rejection, usable accuracy, the limit), plus a
    // freshness check below, so nothing about trust changes.
    seed = null,
    seedMaxAgeMs = 30000,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let watchId = null;
    let hiWatchId = null;   // high-accuracy escalation watch (see below)
    let timer = null;
    let escalateTimer = null;
    let best = null; // most accurate fix seen so far
    let lastError = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (escalateTimer) {
        clearTimeout(escalateTimer);
        escalateTimer = null;
      }
      if (watchId != null) {
        Geolocation.clearWatch(watchId);
        watchId = null;
      }
      if (hiWatchId != null) {
        Geolocation.clearWatch(hiWatchId);
        hiWatchId = null;
      }
    };

    const succeed = pos => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(pos);
    };

    const fail = err => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // Evaluate each incoming fix: reject outright if mocked, remember it if it
    // is the best so far, and finish as soon as one is accurate enough.
    // Split into shaped/raw so the seed (already shaped) can be fed through
    // the SAME gates as streamed fixes — one evaluation path, no special cases.
    const considerShaped = pos => {
      if (settled) return;

      if (pos.mocked) {
        fail(
          makeError(
            LOC_ERR.MOCKED,
            'This location was reported by a mock-location app.',
          ),
        );
        return;
      }

      const acc = pos.accuracy;

      // Ignore fixes whose accuracy we cannot trust (see hasUsableAccuracy).
      // They must not become `best`, or a single NaN/-1 sample would pin it and
      // block every genuinely better fix that follows.
      if (!hasUsableAccuracy(acc)) return;

      if (!best || acc < best.accuracy) {
        best = pos;
      }

      if (acc <= accuracyLimitOpt) {
        succeed(pos);
      }
    };
    const consider = raw => considerShaped(shapePosition(raw));

    // Feed the live-watch seed FIRST, before any hardware is asked for a new
    // fix. Outcomes:
    //   * fresh + within the limit -> succeed() right here; the early-return
    //     below then skips starting the watch and timers entirely, and the
    //     caller gets an instant resolve. This is the normal case once the
    //     screen has been open a few seconds.
    //   * fresh but coarser than the limit -> it becomes the initial `best`,
    //     so a best-effort flow can never end up WORSE than what the user is
    //     already looking at on the live card.
    //   * stale, mocked, or unusable accuracy -> the same gates that police
    //     streamed fixes reject it, and acquisition proceeds from zero
    //     exactly as before.
    if (seed && seed.at && Date.now() - seed.at <= seedMaxAgeMs) {
      considerShaped(seed);
      if (settled) return;
    }

    const onError = err => {
      lastError = makeError(
        POSITION_ERROR_REASON[err && err.code] || LOC_ERR.UNKNOWN,
        (err && err.message) || 'Could not read the device location.',
      );
      // A permission failure will never resolve by waiting.
      if (lastError.reason === LOC_ERR.PERMISSION_DENIED) fail(lastError);
    };

    // Seed with the current fix so a already-accurate position returns instantly.
    Geolocation.getCurrentPosition(consider, onError, {
      enableHighAccuracy: HIGH_ACCURACY,
      timeout,
      maximumAge: 5000,
    });

    // Then stream until the accuracy converges.
    watchId = Geolocation.watchPosition(consider, onError, {
      enableHighAccuracy: HIGH_ACCURACY,
      distanceFilter: 0,
      interval: 1000,
      fastestInterval: 500,
    });

    // The seed above can settle before this point if its callback runs
    // synchronously (a mocked/shimmed Geolocation, or a replayed cached fix).
    // cleanup() would then have run while watchId was still null, leaking the
    // watch we just created. Catch that here.
    if (settled) {
      cleanup();
      return;
    }

    // ESCALATION — Android-only safety net. iOS's primary watch already runs
    // at best accuracy (HIGH_ACCURACY), so this is a no-op there. On Android,
    // if the fused provider is somehow stuck coarse (Wi-Fi scanning off, cell
    // only), a true-GPS watch is added after 3.5s rather than waiting out the
    // timeout. Both watches feed the same `consider`; first to converge wins.
    escalateTimer = setTimeout(() => {
      if (settled || hiWatchId != null || HIGH_ACCURACY) return;
      hiWatchId = Geolocation.watchPosition(consider, onError, {
        enableHighAccuracy: true,
        distanceFilter: 0,
        interval: 1000,
        fastestInterval: 500,
      });
    }, 3500);

    timer = setTimeout(() => {
      // Prefer a hard provider error over an accuracy complaint: if Location is
      // switched off, telling the user to "move near a window" sends them to fix
      // the wrong thing.
      if (lastError && lastError.reason === LOC_ERR.POSITION_UNAVAILABLE) {
        fail(lastError);
        return;
      }
      if (best) {
        if (bestEffort && best.accuracy <= bestEffortCap) {
          // QR-verified flow: the strict limit wasn't reachable here (indoor /
          // basement), so record the best real fix WITH its accuracy. The
          // mock check already ran on every sample in consider().
          succeed(best);
          return;
        }
        fail(
          makeError(
            LOC_ERR.INACCURATE,
            `Location is only accurate to about ${Math.round(
              best.accuracy,
            )}m.`,
            { accuracy: best.accuracy, limit: accuracyLimitOpt },
          ),
        );
        return;
      }
      fail(lastError || makeError(LOC_ERR.TIMEOUT, 'Location timed out.'));
    }, timeout);
  });
}

// True when a fix looks like iOS's fuzzed "Precise Location off" position
// rather than a genuinely weak signal. Screens use this to warn the user in
// the live location card, BEFORE they fill in a form and press submit.
export function isReducedAccuracyFix(pos) {
  if (!pos || Platform.OS !== 'ios') return false;
  return typeof pos.accuracy === 'number' && pos.accuracy >= REDUCED_ACCURACY_HINT_M;
}

// A fix from the live watch is usable for submission only if it is recent AND
// accurate enough. Used as a last resort when a fresh request times out, so a
// user with a good current fix isn't blocked by a slow GPS re-read.
export function isUsableForSubmission(pos, maxAgeMs = 30000, accuracyLimit = ACCURACY_LIMIT_M) {
  if (!pos) return false;
  if (pos.mocked) return false;
  // Same trap as in getPositionForSubmission: an unknown or negative accuracy
  // (iOS reports -1 for an invalid fix) must NOT be treated as good enough.
  if (!hasUsableAccuracy(pos.accuracy)) return false;
  if (pos.accuracy > accuracyLimit) return false;
  if (pos.at && Date.now() - pos.at > maxAgeMs) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Continuous watch — powers the live coordinate readout.
//
// 1) Fire a fast one-shot so coordinates appear within ~2s even indoors,
//    instead of leaving the screen on "loading".
// 2) Then stream from the fused provider, which stays responsive indoors while
//    upgrading toward GPS precision outdoors.
// ---------------------------------------------------------------------------
export function watchPosition(onUpdate, onError) {
  const emit = pos => onUpdate(shapePosition(pos));

  // Fire-and-forget seed; a failure here is non-fatal because the watch below
  // still delivers fixes.
  //
  // maximumAge is SHORT on purpose. This seed also runs on the Refresh button,
  // and with a 60s allowance Refresh would simply replay the same stale coarse
  // fix the user is refreshing to get rid of — the card re-shows identical
  // numbers and looks "stuck". 3s means Refresh always demands a new reading;
  // the watch stream below still fills the card within a couple of seconds if
  // the seed misses.
  Geolocation.getCurrentPosition(emit, () => {}, {
    enableHighAccuracy: HIGH_ACCURACY,
    timeout: 8000,
    maximumAge: 3000,
  });

  return Geolocation.watchPosition(
    emit,
    err => {
      if (onError) {
        onError(
          makeError(
            POSITION_ERROR_REASON[err && err.code] || LOC_ERR.UNKNOWN,
            (err && err.message) || 'Lost the device location.',
          ),
        );
      }
    },
    {
      enableHighAccuracy: HIGH_ACCURACY,
      distanceFilter: 0,
      interval: 2000,
      fastestInterval: 1000,
    },
  );
}

// Stop a position watch started with watchPosition().
export function clearWatch(watchId) {
  if (watchId != null) {
    Geolocation.clearWatch(watchId);
  }
}

// Turn a thrown location error into { title, message } for an Alert. Keeps the
// wording consistent across both attendance screens.
export function describeLocationError(err) {
  switch (err && err.reason) {
    case LOC_ERR.PERMISSION_DENIED:
      return {
        title: 'Location permission needed',
        message:
          'Attendance cannot be recorded without your location. Please allow location access for Amul Common App in Settings.',
        canOpenSettings: true,
      };
    case LOC_ERR.PERMISSION_APPROXIMATE:
      return {
        title: 'Precise location needed',
        message:
          'Amul Common App currently has "Approximate" location access, which is not accurate enough to confirm you are at the site. Please switch it to "Precise" in Settings.',
        canOpenSettings: true,
      };
    case LOC_ERR.POSITION_UNAVAILABLE:
      return {
        title: 'Location is turned off',
        message:
          'Please turn on Location / GPS on your device and try again.',
      };
    case LOC_ERR.TIMEOUT:
      return {
        title: 'Could not get a location',
        message:
          'Getting your position took too long. Move near a window or step outside, then try again.',
      };
    case LOC_ERR.INACCURATE: {
      const acc = Math.round(err.accuracy || 0);

      // iOS "Precise Location" OFF is NOT a weak signal — it is a privacy
      // setting. iOS then returns a deliberately fuzzed position with an
      // accuracy of roughly 1-3km (classically ~1414m, which is 1000 x sqrt2:
      // the diagonal of the 1km fuzzing square). No amount of walking outside
      // improves it, so the generic "move near a window" advice sends the user
      // on a pointless errand while the real fix is one toggle in Settings.
      //
      // We can only infer this: react-native-geolocation exposes no
      // accuracyAuthorization flag, so ensureLocationPermission() has to
      // report precise:true on iOS and the truth only shows up in the fix
      // itself. A genuine indoor GPS fix is tens to a few hundred metres;
      // anything at or beyond a kilometre on iOS is reduced accuracy.
      // A kilometre-scale fix on iOS has two possible causes, and the user
      // can't tell them apart — so name both, cheapest check first:
      //   1. Wi-Fi switched off. iOS then locates by cell tower (~1-3km) and
      //      only engages GPS if something asks for better accuracy.
      //   2. "Precise Location" turned off for this app, which caps accuracy
      //      at roughly 1km no matter how good the signal is.
      if (Platform.OS === 'ios' && (err.accuracy || 0) >= REDUCED_ACCURACY_HINT_M) {
        return {
          title: 'Location is only approximate',
          message:
            `Your iPhone is reporting a position accurate to about ${acc}m, ` +
            'which cannot confirm you are at the site.\n\n' +
            '1. Switch Wi-Fi ON (it does not need to be connected) — this alone ' +
            'usually fixes it.\n' +
            '2. If it persists, open Settings > Amul Common App > Location and ' +
            'make sure "Precise Location" is ON.\n\n' +
            'Then try again.',
          canOpenSettings: true,
        };
      }

      return {
        title: 'Location not accurate enough',
        message: `Your position is only accurate to about ${acc}m — this needs ${err.limit || ACCURACY_LIMIT_M}m or better to confirm you are at the site. Make sure Wi-Fi is switched on (it sharpens the fix indoors), move near a window or step outside, then try again.`,
      };
    }
    case LOC_ERR.MOCKED:
      return {
        title: 'Mock location detected',
        message:
          'Your device is reporting a simulated location. Please disable any fake-GPS app and try again.',
      };
    default:
      return {
        title: 'Location error',
        message:
          'Could not read your location. Please check that Location is on and try again.',
      };
  }
}
