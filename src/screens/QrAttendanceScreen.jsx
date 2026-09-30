import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  Alert,
} from 'react-native';
import { apiPost, apiPostText } from '../services/api';
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
import { parseQrLocationResponse, QR_RESULT } from '../services/qrResponse';
import { MSG } from '../constants/messages';

// Resolves a scanned QR to a location AND geofences the user against it.
// Sends: qrcodeno, n_lat, n_lon. Returns PLAIN TEXT:
//   "<Name>-<qrcode>"          -> within range (valid)
//   "<Name>"                   -> location has no coords (name only, valid)
//   "Err:<distance>:<lat>:<lon>" -> too far from the location
//   "000"                      -> QR matched no location
// NOTE: confirm get_location_name_qr.php is deployed where config.js points.
// (Its `include('../config_aml.php')` implies it lives in a subfolder whose
// parent holds config_aml.php.)
const LOCATION_QR_URL = ENDPOINTS.locationFromQr;

// Location check-in endpoint. Response (JSON): { statusCode, message } —
// statusCode 200 means success.
const LOCATION_ATTENDANCE_URL = ENDPOINTS.locationAttendance;

const QR_ICON = require('../assets/qr_scan.png');

// Map the stored account type code to a friendly label. Works for both roles:
// 'e' = employee, 's' = student.
const accountTypeLabel = type => {
  if (type === 'e') return 'Employee';
  if (type === 's') return 'Student';
  return '';
};

const QrAttendanceScreen = () => {
  // Identity of the logged-in user (employee OR student), loaded from storage.
  const [userId, setUserId] = useState('');
  const [userName, setUserName] = useState('');
  const [userType, setUserType] = useState(''); // 'e' | 's'

  // Live GPS position (updated continuously while the device moves).
  const [coords, setCoords] = useState(null); // { lat, long, accuracy } | null
  // gpsStatus: 'loading' | 'ready' | 'denied' | 'approximate' | 'nofix' | 'error'
  const [gpsStatus, setGpsStatus] = useState('loading');
  const watchIdRef = useRef(null);
  const coordsRef = useRef(null); // latest fix, for use inside scan callbacks

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [locationCode, setLocationCode] = useState('');
  const [locationName, setLocationName] = useState('');
  // locationStatus: 'idle' | 'loading' | 'found' | 'notfound' | 'toofar' | 'error' | 'nogps'
  const [locationStatus, setLocationStatus] = useState('idle');
  const [distanceAway, setDistanceAway] = useState('');
  const [remarks, setRemarks] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);

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

    // Stop any existing watch BEFORE checking permission, not after. If the user
    // granted Precise, then revoked it in Settings and came back to tap Refresh,
    // an already-running watch would keep firing its success callback and
    // overwrite the 'denied'/'approximate' state with a LIVE pill and stale
    // coordinates — showing a confident readout the user is no longer entitled
    // to. Killing the watch first makes the permission check authoritative.
    stopWatching();

    // Discard the last known fix too. setCoords(null) only clears the display;
    // coordsRef is what onQrScanned reads when geofencing, and it has no
    // staleness check — leaving it populated would let a scan resolve against a
    // position from an arbitrarily long time ago.
    const forget = () => {
      coordsRef.current = null;
      setCoords(null);
    };

    const { granted, precise } = await ensureLocationPermission();
    if (!granted) {
      forget();
      setGpsStatus('denied');
      return;
    }
    if (!precise) {
      // Granted, but Android is fuzzing the coordinates to ~1-3km. Showing a
      // live readout would be actively misleading, and the geofence lookup
      // would fail against a position that isn't really the user's.
      forget();
      setGpsStatus('approximate');
      return;
    }

    watchIdRef.current = watchPosition(
      position => {
        coordsRef.current = position;
        setCoords(position);
        setGpsStatus('ready');
      },
      () => {
        // Keep showing the last good fix if we already had one; otherwise flag error.
        setGpsStatus(prev => (prev === 'ready' ? 'ready' : 'error'));
      },
    );
  }, [stopWatching]);

  // Resolve a scanned QR to a location name and geofence the user against it.
  // Parses the plain-text response from get_location_name_qr.php.
  const resolveLocation = useCallback(async (qr, lat, lon) => {
    setLocationStatus('loading');
    setLocationName('');
    setDistanceAway('');
    try {
      const text = await apiPostText(LOCATION_QR_URL, {
        qrcodeno: qr,
        n_lat: lat,
        n_lon: lon,
      });

      const result = parseQrLocationResponse(text, qr);

      if (result.status === QR_RESULT.NOT_FOUND) {
        setLocationStatus('notfound');
        Alert.alert('No Record Found', 'No location matched this QR code.');
        return;
      }
      if (result.status === QR_RESULT.TOO_FAR) {
        setDistanceAway(result.distance);
        setLocationStatus('toofar');
        Alert.alert(
          'Out of Range',
          'You are too far from the location to mark attendance.\n\n' +
            `Distance: ${result.distance} m\n` +
            `Latitude: ${result.lat}\n` +
            `Longitude: ${result.lon}`,
        );
        return;
      }

      setLocationName(result.name);
      setLocationStatus('found');
    } catch (error) {
      // Session ended: the navigator already showed "Signed Out" and is
      // resetting to Login — don't add a second alert or a misleading error.
      if (error && error.sessionExpired) return;
      setLocationStatus('error');
      Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
    }
  }, []);

  // Never spin forever. The fused provider normally answers in 1-3s; if nothing
  // has arrived after this long, something is actually wrong (location switched
  // off at the OS level, no provider available, or — on an emulator — no
  // location has been set at all). Say so and offer a retry instead of leaving
  // "Getting your location…" on screen indefinitely.
  //
  // Self-healing: if a fix does land later, the watch callback sets 'ready' and
  // this state is replaced.
  useEffect(() => {
    if (gpsStatus !== 'loading') return undefined;
    const timer = setTimeout(() => {
      setGpsStatus(prev => (prev === 'loading' ? 'nofix' : prev));
    }, 15000);
    return () => clearTimeout(timer);
  }, [gpsStatus]);

  // Load the logged-in user's identity + grab the current GPS position on open.
  useEffect(() => {
    let isMounted = true;
    (async () => {
      const [id, name, type] = await Promise.all([
        getItem(KEYS.userId),
        getItem(KEYS.userName),
        getItem(KEYS.userType),
      ]);
      if (isMounted) {
        setUserId((id || '').trim());
        setUserName((name || '').trim());
        setUserType((type || '').trim());
      }
    })();
    startWatching();
    return () => {
      isMounted = false;
      stopWatching(); // stop GPS updates when leaving the screen
    };
  }, [startWatching, stopWatching]);

  // A location QR was scanned — send it with the live GPS for lookup + geofence.
  const onQrScanned = scannedValue => {
    setIsScannerOpen(false);
    const qr = (scannedValue || '').trim();
    if (!qr) {
      Alert.alert(MSG.QR_UNREADABLE.title, MSG.QR_UNREADABLE.message);
      return;
    }
    setLocationCode(qr);

    const c = coordsRef.current;
    if (!c) {
      // The geofence needs the user's position; wait for the first GPS fix.
      setLocationName('');
      setLocationStatus('nogps');
      Alert.alert(
        'Location not ready',
        'Waiting for your GPS location. Once it appears above, tap Scan again.',
      );
      return;
    }
    resolveLocation(qr, c.lat, c.long);
  };

  const submitAttendance = async () => {
    if (!userId) {
      return Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
    }
    if (!locationCode || locationStatus !== 'found') {
      // Only allow submit for a QR that resolved to a location within range.
      return Alert.alert(
        'Valid location required',
        'Please scan a location QR while you are within range of it.',
      );
    }
    setIsSubmitting(true);
    try {
      // The live watch has been warming the GPS since the screen opened, so
      // its latest fix is passed in as a SEED: if it is fresh, real (not
      // mocked) and within the accuracy limit, submission resolves instantly —
      // no re-acquisition, no spinner. Otherwise the seed merely pre-loads the
      // convergence stream and a fresh fix is awaited as before. This replaces
      // the old "fresh first, live fix as fallback" ordering, which made every
      // submit pay the full acquisition wait even when a perfect fix was
      // already on screen.
      let position;
      try {
        position = await getPositionForSubmission({
          accuracyLimit: getConfig().qrAttendanceAccuracyM,
          seed: coordsRef.current || coords,
        });
      } catch (e) {
        setIsSubmitting(false);
        const info = describeLocationError(e);
        Alert.alert(
          info.title,
          info.message,
          info.canOpenSettings
            ? [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: openLocationSettings },
              ]
            : undefined,
        );
        if (e.reason === LOC_ERR.POSITION_UNAVAILABLE) startWatching();
        return;
      }

      const deviceId = await getDeviceId();

      // apiPost also attaches user_type automatically, so the backend can tell
      // whether this is an employee or a student.
      const response = await apiPost(LOCATION_ATTENDANCE_URL, {
        employee_id: userId, // employee code or student id — backend accepts both
        location_code: locationCode,
        remarks: remarks.trim(), // optional
        device_id: deviceId,
        latitude: position.lat,
        longitude: position.long,
      });

      const isSuccess = response && String(response.statusCode) === '200';
      Alert.alert(
        isSuccess ? 'Updated' : 'Attendance',
        (response && response.message) || 'Done.',
      );
      if (isSuccess) {
        // Clear for the next entry.
        setLocationCode('');
        setLocationName('');
        setLocationStatus('idle');
        setDistanceAway('');
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
    // approximate / denied / error
    if (gpsStatus === 'approximate') {
      return (
        <View>
          <Text style={styles.gpsError}>
            Amul Common App only has “Approximate” location access, which is not precise
            enough to confirm you are at the site.
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

  const typeLabel = accountTypeLabel(userType);

  // Read-only Location Name field content, driven by the lookup/geofence result.
  const renderLocationField = () => {
    if (locationStatus === 'loading') {
      return (
        <View style={styles.gpsRow}>
          <ActivityIndicator size="small" color={COLORS.primaryRed} />
          <Text style={styles.gpsFetching}>Verifying location…</Text>
        </View>
      );
    }
    // Show the location name ONLY when the scan is verified within range.
    if (locationStatus === 'found') {
      return <Text style={styles.readonlyText}>{locationName || locationCode}</Text>;
    }
    // Every other state (idle / too far / not found / error / no GPS) — stays
    // empty; the alert popups already explain what happened.
    return <Text style={styles.readonlyPlaceholder}>Scan a QR code to fill</Text>;
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
        {/* ---------- Combined: Your Details + Your Location ---------- */}
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>Your Details</Text>
            {!!typeLabel && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{typeLabel}</Text>
              </View>
            )}
          </View>
          <View style={styles.kvRow}>
            <Text style={styles.kvLabel}>User ID</Text>
            <Text style={styles.kvValue}>{userId || '—'}</Text>
          </View>
          <View style={styles.kvDivider} />
          <View style={styles.kvRow}>
            <Text style={styles.kvLabel}>Name</Text>
            <Text style={[styles.kvValue, styles.kvValueRight]} numberOfLines={2}>
              {userName || '—'}
            </Text>
          </View>

          <View style={styles.sectionSplit} />

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

        {/* ---------- Action: Scan → Location Name → Remarks → Update ---------- */}
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => setIsScannerOpen(true)}
            activeOpacity={0.85}
          >
            <Image source={QR_ICON} style={styles.btnIcon} />
            <Text style={styles.scanBtnText}>Scan QR Code</Text>
          </TouchableOpacity>

          <Text style={styles.label}>Location Name</Text>
          <View style={[styles.input, styles.readonly]}>{renderLocationField()}</View>

          <Text style={styles.label}>
            Remarks <Text style={styles.optional}>(optional)</Text>
          </Text>
          <TextInput
            style={[styles.input, styles.remarksInput]}
            value={remarks}
            onChangeText={setRemarks}
            placeholder="Add a remark (optional)"
            placeholderTextColor="#9AA0AA"
            multiline
            maxLength={250}
          />

          <TouchableOpacity
            style={[styles.button, isSubmitting && { opacity: 0.6 }]}
            onPress={submitAttendance}
            disabled={isSubmitting}
            activeOpacity={0.85}
          >
            {isSubmitting ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Getting your location…</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Update Attendance/Visit</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Mounted only while scanning; wrapped so a camera failure can't crash the app */}
      {isScannerOpen && (
        <ScannerBoundary onClose={() => setIsScannerOpen(false)}>
          <QrScanner
            visible
            hint="Align the location QR code within the frame"
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
  sectionSplit: {
    height: 1,
    backgroundColor: COLORS.inputBorder,
    marginVertical: 16,
  },
  badge: {
    backgroundColor: COLORS.redTint,
    borderRadius: 50,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: { color: COLORS.primaryRed, fontSize: 12, fontWeight: '800' },
  refreshLink: { color: COLORS.primaryRed, fontSize: 13, fontWeight: '800' },
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

  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  kvLabel: { fontSize: 14, color: COLORS.mediumText, fontWeight: '600' },
  kvValue: { fontSize: 15, color: COLORS.darkText, fontWeight: '700' },
  kvValueMuted: { fontSize: 14, color: COLORS.muted, fontWeight: '600' },
  kvValueRight: { flex: 1, textAlign: 'right', marginLeft: 16 },
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

  // Action card
  scanBtn: {
    flexDirection: 'row',
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanBtnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  btnIcon: { width: 18, height: 18, tintColor: '#FFFFFF', marginRight: 9 },

  label: {
    fontWeight: '600',
    color: COLORS.darkText,
    marginTop: 18,
    marginBottom: 8,
    fontSize: 14,
  },
  optional: { color: COLORS.muted, fontWeight: '500', fontSize: 12 },
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
  readonly: { backgroundColor: '#F3F4F6' },
  readonlyText: { fontSize: 15, color: COLORS.darkText, fontWeight: '700' },
  readonlyPlaceholder: { fontSize: 15, color: '#9AA0AA' },
  remarksInput: {
    minHeight: 76,
    textAlignVertical: 'top',
    paddingTop: 12,
  },

  button: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 24,
  },
  buttonText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  btnBusyRow: { flexDirection: 'row', alignItems: 'center' },
  btnBusyText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 10 },

});

export default QrAttendanceScreen;
