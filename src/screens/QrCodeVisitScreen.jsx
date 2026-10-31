import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
  TextInput,
} from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import {
  ensureLocationPermission,
  watchPosition,
  clearWatch,
  getPositionForSubmission,
  describeLocationError,
  openLocationSettings,
  isReducedAccuracyFix,
  LOC_ERR,
} from '../services/location';
import { getConfig } from '../services/remoteConfig';
import { COLORS } from '../theme';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

// Visit endpoint — PLACEHOLDER in src/config.js awaiting the real visit API.
// Expected response (mirroring the meeting endpoint): { statusCode, message }.
const VISIT_URL = ENDPOINTS.qrVisit;

const QR_ICON = require('../assets/qr_scan.png');

// Remarks input — same whitelist + cap as VisitorEntry, so a remark can't break
// report layouts or the notification the backend sends to the location owner.
// The allowed set keeps normal punctuation but drops quotes, angle brackets,
// backslashes and semicolons; line breaks collapse to a space.
const REMARK_MAX = 150;
const REMARK_ALLOWED = /[^A-Za-z0-9 .,\-/()&:#@]/g;
const sanitizeRemark = text =>
  String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(REMARK_ALLOWED, '')
    .slice(0, REMARK_MAX);

// QR Code Visit — records a visit for the LOGGED-IN employee only.
//   • Live latitude/longitude card on top, identical to QR Code Attendance.
//   • Visit QR / Visit Code accepts ANY value (no format validation).
//   • No employee fields, no history table — just locate, scan, submit.
const QrCodeVisitScreen = () => {
  // The RAW scanned code (nu_location_no). Held in state ONLY to build the
  // submit payload — it is never shown on screen, so it can't be read off the
  // field by a bystander or a screenshot.
  const [visitCode, setVisitCode] = useState('');
  // What the field actually DISPLAYS: the human-readable location name resolved
  // from the code by the backend. This is the only visit value the user sees.
  const [visitLocationName, setVisitLocationName] = useState('');
  // True while the scan -> location-name lookup is in flight.
  const [isResolving, setIsResolving] = useState(false);
  // Optional free-text remark for this visit (sent to the backend, which can
  // forward it to the location owner).
  const [remarks, setRemarks] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  // The logged-in employee — the only person a visit can be recorded for.
  const [loginUserId, setLoginUserId] = useState('');

  // Live GPS readout (same behaviour as QrAttendanceScreen).
  const [coords, setCoords] = useState(null); // { lat, long, accuracy } | null
  // gpsStatus: 'loading' | 'ready' | 'denied' | 'approximate' | 'nofix' | 'error'
  const [gpsStatus, setGpsStatus] = useState('loading');
  const watchIdRef = useRef(null);

  // Stop any active position watch.
  const stopWatching = useCallback(() => {
    if (watchIdRef.current != null) {
      clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  // Start streaming the GPS position (asks for permission first). Each movement
  // updates the coordinates live until stopWatching() is called.
  const startWatching = useCallback(async () => {
    setGpsStatus('loading');

    // Kill any running watch BEFORE the permission check so a revoked
    // permission can't be papered over by a stale watch still firing.
    stopWatching();
    setCoords(null);

    const { granted, precise } = await ensureLocationPermission();
    if (!granted) {
      setGpsStatus('denied');
      return;
    }
    if (!precise) {
      // Granted, but Android is fuzzing coordinates to ~1-3km — a live readout
      // would be actively misleading.
      setGpsStatus('approximate');
      return;
    }

    watchIdRef.current = watchPosition(
      position => {
        setCoords(position);
        setGpsStatus('ready');
      },
      () => {
        // Keep showing the last good fix if we already had one; otherwise flag error.
        setGpsStatus(prev => (prev === 'ready' ? 'ready' : 'error'));
      },
    );
  }, [stopWatching]);

  // Never spin forever: if no fix lands within 15s, say so and offer a retry.
  // Self-healing — a later fix sets 'ready' and replaces this state.
  useEffect(() => {
    if (gpsStatus !== 'loading') return undefined;
    const timer = setTimeout(() => {
      setGpsStatus(prev => (prev === 'loading' ? 'nofix' : prev));
    }, 15000);
    return () => clearTimeout(timer);
  }, [gpsStatus]);

  // Resolve the logged-in employee's id and start the live location stream.
  useEffect(() => {
    let isMounted = true;
    (async () => {
      const storedId = ((await getItem(KEYS.userId)) || '').trim();
      if (isMounted && storedId) {
        setLoginUserId(storedId);
      }
    })();
    startWatching();
    return () => {
      isMounted = false;
      stopWatching(); // stop GPS updates when leaving the screen
    };
  }, [startWatching, stopWatching]);

  // Resolve a scanned code to its LOCATION NAME via the backend, so the field
  // shows the name and never the raw code. Returns true if the code is usable
  // (name shown, or shown behind a neutral label when the lookup is offline);
  // false if the backend rejected it (invalid / no access), in which case the
  // code is cleared so a bad scan can't be submitted.
  const resolveVisitLocation = useCallback(
    async rawCode => {
      setIsResolving(true);
      try {
        // Same endpoint as the submit — mode=lookup returns just the location
        // NAME and records nothing.
        const resp = await apiPost(VISIT_URL, {
          mode: 'lookup',
          employee_id: loginUserId,
          visit_code: rawCode,
        });
        const ok = resp && String(resp.statusCode) === '200';
        if (ok && resp.location_name) {
          setVisitLocationName(String(resp.location_name));
          return true;
        }
        // Backend rejected the code (not a known location, or no access). Clear
        // everything so nothing can be submitted, and say why.
        setVisitCode('');
        setVisitLocationName('');
        Alert.alert(
          'Invalid QR',
          (resp && resp.message) ||
            'This QR code could not be verified. Please scan the correct location QR.',
        );
        return false;
      } catch (e) {
        // Network / server unreachable. Do NOT expose the raw code and do NOT
        // block the user — keep the code hidden behind a neutral label and let
        // the submit endpoint be the final check. (A session-expiry error is
        // handled globally; don't relabel the field in that case.)
        if (!(e && e.sessionExpired)) {
          setVisitLocationName('Visit location scanned');
        }
        return true;
      } finally {
        setIsResolving(false);
      }
    },
    [loginUserId],
  );

  // A visit QR was scanned. Keep the RAW code only in state (for the submit
  // payload), then resolve it to a location NAME for display — the raw code is
  // never rendered.
  const onQrScanned = async scannedValue => {
    setIsScannerOpen(false);
    const raw = String(scannedValue || '').trim();
    if (!raw) {
      Alert.alert(MSG.QR_UNREADABLE.title, MSG.QR_UNREADABLE.message);
      return;
    }
    setVisitCode(raw);
    setVisitLocationName('');
    await resolveVisitLocation(raw);
  };

  const submitVisit = async () => {
    if (!loginUserId) {
      return Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
    }
    if (!visitCode.trim()) {
      return Alert.alert('Invalid', 'Scan the visit QR code first.');
    }

    // 1) Permission — checked BEFORE the submitting state is set, so a lost
    //    OS permission-dialog promise (Activity recreated while it's showing)
    //    can never strand the Submit button on a spinner; the button simply
    //    stays enabled. `precise` matters as much as `granted`.
    const { granted, precise } = await ensureLocationPermission();
    if (!granted || !precise) {
      const info = describeLocationError({
        reason: granted
          ? LOC_ERR.PERMISSION_APPROXIMATE
          : LOC_ERR.PERMISSION_DENIED,
      });
      return Alert.alert(info.title, info.message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: openLocationSettings },
      ]);
    }

    setIsSubmitting(true);
    try {
      // 2) A fresh, mock-rejected fix. bestEffort: the visit QR is physically
      //    mounted at the site, so the scan itself proves presence — visits
      //    happen inside buildings and basements where no phone can reach the
      //    strict 100m limit. A good fix is still preferred and wins
      //    immediately; when it isn't achievable, the best real fix within
      //    3km is submitted WITH its accuracy value, so the server record is
      //    honest about precision (and the backend already stores nu_accuracy
      //    for exactly this judgement).
      let position;
      try {
        position = await getPositionForSubmission({
          // Shorter window than attendance: best-effort accepts the interim
          // fix when 100m isn't reachable, so waiting longer buys little and
          // costs perceived responsiveness.
          timeout: 12000,
          // Latest live-card fix: fresh + within limit -> instant submit;
          // coarser -> pre-loads best-effort so the result can never be worse
          // than what the user is already looking at.
          seed: coords,
          accuracyLimit: getConfig().visitAccuracyM,
          // Server can set the cap to 0 to switch best-effort OFF, making
          // visits as strict as attendance — no app update needed either way.
          bestEffort: getConfig().visitBestEffortCapM > 0,
          bestEffortCap: getConfig().visitBestEffortCapM,
        });
      } catch (e) {
        setIsSubmitting(false);
        const info = describeLocationError(e);
        return Alert.alert(
          info.title,
          info.message,
          info.canOpenSettings
            ? [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: openLocationSettings },
              ]
            : undefined,
        );
      }

      const deviceId = await getDeviceId();

      const response = await apiPost(VISIT_URL, {
        mode: 'submit', // record the visit (default on the server too)
        employee_id: loginUserId, // always the logged-in employee
        visit_code: visitCode.trim(),
        remarks: remarks.trim(), // optional; backend notifies the owner if set
        device_id: deviceId,
        latitude: position.lat,
        longitude: position.long,
        // GPS accuracy of THIS fix in metres — lets the backend judge how much
        // to trust the coordinates (e.g. flag visits recorded at ±500m).
        accuracy: String(position.accuracy ?? ''),
        // Build + hardware context for support and auditing. All synchronous
        // DeviceInfo getters — no await needed, no permissions involved.
        app_version: DeviceInfo.getVersion(),
        device_make: DeviceInfo.getBrand(),
        device_model: DeviceInfo.getModel(),
        device_os: `${Platform.OS} ${Platform.Version}`,
      });

      const isSuccess = response && String(response.statusCode) === '200';
      Alert.alert(
        isSuccess ? 'Success' : 'Visit',
        (response && response.message) || 'Done.',
      );
      if (isSuccess) {
        setVisitCode('');
        setVisitLocationName('');
        setRemarks('');
      }
    } catch (error) {
      if (!(error && error.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Live location readout — same states and layout as QR Code Attendance.
  const renderGps = () => {
    if (gpsStatus === 'loading') {
      return (
        <View style={styles.gpsRow}>
          <ActivityIndicator size="small" color={COLORS.primaryRed} />
          <Text style={styles.gpsFetching}>Getting your location…</Text>
        </View>
      );
    }
    if (gpsStatus === 'ready' && coords) {
      return (
        <View>
          <View style={styles.kvRow}>
            <Text style={styles.kvLabel}>Latitude</Text>
            <Text style={[styles.kvValue, styles.codeValue]}>{coords.lat.toFixed(6)}</Text>
          </View>
          <View style={styles.kvDivider} />
          <View style={styles.kvRow}>
            <Text style={styles.kvLabel}>Longitude</Text>
            <Text style={[styles.kvValue, styles.codeValue]}>{coords.long.toFixed(6)}</Text>
          </View>
          {typeof coords.accuracy === 'number' && (
            <>
              <View style={styles.kvDivider} />
              <View style={styles.kvRow}>
                <Text style={styles.kvLabel}>Accuracy</Text>
                <Text style={styles.kvValueMuted}>± {Math.round(coords.accuracy)} m</Text>
              </View>
            </>
          )}

          {/* iOS "Precise Location" off returns a fuzzed ~1-3km position that
              looks like a healthy live fix. Warn HERE, before the user fills
              anything in — otherwise they only discover it at submit time and
              are told to "move near a window", which cannot help. */}
          {isReducedAccuracyFix(coords) && (
            <View style={styles.preciseWarn}>
              <Text style={styles.gpsError}>
                This position is only approximate and cannot confirm you are at
                the site. Switch Wi-Fi ON (it need not be connected), or check
                that Precise Location is enabled for this app.
              </Text>
              <TouchableOpacity onPress={openLocationSettings} hitSlop={8}>
                <Text style={styles.gpsSettingsLink}>Open Settings</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      );
    }
    if (gpsStatus === 'nofix') {
      return (
        <View>
          <Text style={styles.gpsError}>
            Still can't read your location. Check that Location/GPS is switched
            on for your device, then tap Refresh.
          </Text>
          <TouchableOpacity onPress={startWatching} hitSlop={8}>
            <Text style={styles.gpsSettingsLink}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (gpsStatus === 'approximate') {
      return (
        <View>
          <Text style={styles.gpsError}>
            Amul Common App only has “Approximate” location access, which is not precise
            enough to confirm your visit location.
          </Text>
          <TouchableOpacity onPress={openLocationSettings} hitSlop={8}>
            <Text style={styles.gpsSettingsLink}>
              Open Settings to allow Precise location
            </Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (gpsStatus === 'denied') {
      return (
        <View>
          <Text style={styles.gpsError}>
            Location permission denied. Please allow location access.
          </Text>
          <TouchableOpacity onPress={openLocationSettings} hitSlop={8}>
            <Text style={styles.gpsSettingsLink}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <Text style={styles.gpsError}>
        Couldn't get your location. Make sure GPS is on.
      </Text>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---------- Your Location (live) ---------- */}
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <View style={styles.titleWithLive}>
              <Text style={styles.cardTitle}>Your Location</Text>
              {gpsStatus === 'ready' && (
                <View style={styles.livePill}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveText}>LIVE</Text>
                </View>
              )}
            </View>
            <TouchableOpacity
              onPress={startWatching}
              disabled={gpsStatus === 'loading'}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.refreshLink}>
                {gpsStatus === 'loading' ? '…' : 'Refresh'}
              </Text>
            </TouchableOpacity>
          </View>
          {renderGps()}
        </View>

        {/* ---------- Visit Code + Submit ---------- */}
        <View style={styles.card}>
          <Text style={styles.label}>Visit Code</Text>
          <View style={styles.codeRow}>
            {/* READ-ONLY by design: set only by scanning — no manual typing (a
                View, not a TextInput, so no keyboard can open). It shows the
                resolved LOCATION NAME, never the raw code — the code is kept in
                state purely for the submit payload so it can't be read off the
                screen. */}
            <View style={[styles.input, styles.codeInput, styles.readonly]}>
              {isResolving ? (
                <View style={styles.resolvingRow}>
                  <ActivityIndicator size="small" color={COLORS.primaryRed} />
                  <Text style={styles.resolvingText}>Checking location…</Text>
                </View>
              ) : visitLocationName ? (
                <Text style={styles.readonlyDone} numberOfLines={1}>
                  ✓ Scanned
                </Text>
              ) : (
                <Text style={styles.readonlyPlaceholder}>
                  Scan a QR code to fill
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={styles.scanBtn}
              onPress={() => setIsScannerOpen(true)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Scan QR code"
            >
              <Image source={QR_ICON} style={styles.qrImg} />
              <Text style={styles.scanBtnText}>Scan</Text>
            </TouchableOpacity>
          </View>

          {/* Full-width, wrapping display of the resolved location name — the
              narrow field above can't fit a long name, so the readable copy
              lives here where it has the whole card width. */}
          {!!visitLocationName && (
            <View style={styles.locationBox}>
              <Text style={styles.locationBoxLabel}>Visit Location</Text>
              <Text style={styles.locationBoxName} numberOfLines={3}>
                {visitLocationName}
              </Text>
            </View>
          )}

          {/* Optional remarks. sanitizeRemark strips line breaks and anything
              outside the safe whitelist as it's typed or pasted; maxLength caps
              it. The backend forwards a non-empty remark to the location owner. */}
          <Text style={[styles.label, styles.remarksLabel]}>Remarks (optional)</Text>
          <TextInput
            style={[styles.input, styles.remarksInput]}
            value={remarks}
            onChangeText={t => setRemarks(sanitizeRemark(t))}
            placeholder="Add a remark for this visit"
            placeholderTextColor="#9AA0AA"
            maxLength={REMARK_MAX}
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.remarksCounter}>
            {remarks.length}/{REMARK_MAX}
          </Text>

          <TouchableOpacity
            style={[styles.button, isSubmitting && { opacity: 0.6 }]}
            onPress={submitVisit}
            disabled={isSubmitting}
            activeOpacity={0.85}
          >
            {isSubmitting ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Getting your location…</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Update Visit</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Mounted only while scanning; wrapped so a camera failure can't crash the app */}
      {isScannerOpen && (
        <ScannerBoundary
          onClose={() => setIsScannerOpen(false)}
          message="The QR scanner couldn't start on this device. Visit codes can only be entered by scanning, so please try again or contact IT support."
        >
          <QrScanner
            visible
            hint="Align the visit QR code within the frame"
            onClose={() => setIsScannerOpen(false)}
            onScanned={onQrScanned}
            // Nothing detected within the scanner's 60s window. Close the
            // camera AND say why — a silent disappearance reads as a crash.
            onTimeout={() => {
              setIsScannerOpen(false);
              Alert.alert(MSG.SCAN_TIMEOUT.title, MSG.SCAN_TIMEOUT.message);
            }}
          />
        </ScannerBoundary>
      )}
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F7F9' },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 16,
  },

  // Card title row + LIVE pill + Refresh (matches QrAttendanceScreen)
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  titleWithLive: { flexDirection: 'row', alignItems: 'center' },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E7F7EC',
    borderRadius: 50,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#1FA750', marginRight: 5 },
  liveText: { color: '#1FA750', fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  refreshLink: { color: COLORS.primaryRed, fontSize: 13, fontWeight: '800' },

  // Key/value rows for the coordinates
  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  kvLabel: { fontSize: 14, color: COLORS.mediumText, fontWeight: '600' },
  kvValue: { fontSize: 15, color: COLORS.darkText, fontWeight: '700' },
  kvValueMuted: { fontSize: 14, color: COLORS.muted, fontWeight: '600' },
  codeValue: { letterSpacing: 0.5 },
  kvDivider: { height: 1, backgroundColor: COLORS.line, marginVertical: 4 },

  gpsRow: { flexDirection: 'row', alignItems: 'center' },
  gpsFetching: { marginLeft: 8, color: COLORS.muted, fontSize: 14 },
  preciseWarn: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
  },
  gpsError: { color: COLORS.primaryRed, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  gpsSettingsLink: {
    color: COLORS.primaryRed,
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
    marginTop: 8,
  },

  // Visit code + scan
  label: {
    fontWeight: '600',
    color: COLORS.darkText,
    marginBottom: 8,
    fontSize: 14,
  },
  input: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    fontSize: 15,
    color: COLORS.darkText,
    minHeight: 48,
    justifyContent: 'center',
  },
  codeRow: { flexDirection: 'row', alignItems: 'center' },
  codeInput: { flex: 1 },
  // Read-only display treatment for the scan-filled visit code.
  readonly: { backgroundColor: '#F3F4F6' },
  readonlyText: { color: COLORS.darkText, fontSize: 15, fontWeight: '700' },
  // Short "✓ Scanned" confirmation shown in the narrow field once a location
  // has resolved (the full, readable name lives in locationBox below).
  readonlyDone: { color: '#1FA750', fontSize: 15, fontWeight: '800' },
  readonlyPlaceholder: { color: '#9AA0AA', fontSize: 15 },
  resolvingRow: { flexDirection: 'row', alignItems: 'center' },
  resolvingText: { marginLeft: 8, color: COLORS.muted, fontSize: 14 },
  // Full-width block that shows the resolved location name so a long name is
  // fully readable (wraps up to 3 lines) instead of being clipped in the field.
  locationBox: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#F5FAF6',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DCEEE1',
  },
  locationBoxLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  locationBoxName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.darkText,
    lineHeight: 22,
  },
  remarksLabel: { marginTop: 16 },
  remarksInput: {
    minHeight: 80,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  remarksCounter: {
    alignSelf: 'flex-end',
    marginTop: 4,
    fontSize: 12,
    color: COLORS.muted,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primaryRed,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 48,
    marginLeft: 10,
  },
  scanBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 7 },
  qrImg: { width: 19, height: 19, tintColor: '#FFFFFF' },
  button: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 26,
  },
  buttonText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  btnBusyRow: { flexDirection: 'row', alignItems: 'center' },
  btnBusyText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 10 },
});

export default QrCodeVisitScreen;
