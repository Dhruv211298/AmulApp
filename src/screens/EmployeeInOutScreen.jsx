import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import {
  ensureLocationPermission,
  watchPosition,
  clearWatch,
  openLocationSettings,
  isReducedAccuracyFix,
} from '../services/location';
import LinearGradient from 'react-native-linear-gradient';
import { COLORS } from '../theme';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

const QR_ICON = require('../assets/qr_scan.png');

const REMARK_MAX = 500;
// Remarks: strip new lines (no Enter), keep a safe whitelist — drops quotes,
// angle brackets, backslashes, semicolons and anything else that could break a
// query or a report — then cap. (The backend parameterizes AND re-sanitizes;
// this is the first line of defence.)
const REMARK_ALLOWED = /[^A-Za-z0-9 .,\-/()&:#@]/g;
const sanitizeRemark = t =>
  String(t || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(REMARK_ALLOWED, '')
    .slice(0, REMARK_MAX);

// The gate-pass QR encodes the going-out request. Its content is base64 and may
// be long; the server decodes + validates it, so the app sends the raw scanned
// string and never parses it itself.
const SCAN_CODE_TYPES = ['qr'];

// ---------------------------------------------------------------------------
// Employee In / Out — gate-pass movement.
//
// A gate officer scans an employee's going-out QR pass. The SERVER decides the
// next movement from the pass's current status (Plant Out -> Gate Out -> Gate
// In -> Plant In) — the app only shows it and confirms. On confirm it records
// the punch with a best-effort GPS fix. Role rights (gate vs plant) are enforced
// server-side against the officer's login.
// ---------------------------------------------------------------------------
const EmployeeInOutScreen = () => {
  const [loginUserId, setLoginUserId] = useState('');

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false); // validating a scanned code

  // The validated pass (null until a good scan).
  const [pass, setPass] = useState(null); // { going_out_no, emp_name, req_date, action_code, action_label }
  const [remarks, setRemarks] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Live GPS readout (same behaviour as QR Code Visit).
  const [coords, setCoords] = useState(null); // { lat, long, accuracy } | null
  // gpsStatus: 'loading' | 'ready' | 'denied' | 'approximate' | 'nofix' | 'error'
  const [gpsStatus, setGpsStatus] = useState('loading');
  const watchIdRef = useRef(null);
  const coordsRef = useRef(null); // latest fix, read when punching

  // Stop any active position watch.
  const stopWatching = useCallback(() => {
    if (watchIdRef.current != null) {
      clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  // Start streaming the GPS position (asks permission first). Each movement
  // updates the coordinates live until stopWatching() is called.
  const startWatching = useCallback(async () => {
    setGpsStatus('loading');
    stopWatching();
    setCoords(null);
    coordsRef.current = null;

    const { granted, precise } = await ensureLocationPermission();
    if (!granted) {
      setGpsStatus('denied');
      return;
    }
    if (!precise) {
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
        setGpsStatus(prev => (prev === 'ready' ? 'ready' : 'error'));
      },
    );
  }, [stopWatching]);

  // Never spin forever: if no fix lands within 15s, say so and offer a retry.
  useEffect(() => {
    if (gpsStatus !== 'loading') return undefined;
    const timer = setTimeout(() => {
      setGpsStatus(prev => (prev === 'loading' ? 'nofix' : prev));
    }, 15000);
    return () => clearTimeout(timer);
  }, [gpsStatus]);

  // Resolve the logged-in employee's id and start the live location stream.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const id = ((await getItem(KEYS.userId)) || '').trim();
      if (mounted && id) setLoginUserId(id);
    })();
    startWatching();
    return () => {
      mounted = false;
      stopWatching(); // stop GPS updates when leaving the screen
    };
  }, [startWatching, stopWatching]);

  const resetPass = () => {
    setPass(null);
    setRemarks('');
  };

  // A scanned gate-pass QR -> server validates and returns the next action.
  const onQrScanned = async scannedValue => {
    setIsScannerOpen(false);
    const raw = String(scannedValue || '').trim();
    if (!raw) {
      Alert.alert(MSG.QR_UNREADABLE.title, MSG.QR_UNREADABLE.message);
      return;
    }
    if (!loginUserId) {
      Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
      return;
    }
    setIsScanning(true);
    resetPass();
    try {
      const resp = await apiPost(ENDPOINTS.employeeInOut, {
        rtype: 'scan',
        employee_id: loginUserId,
        qr_raw: raw,
      });
      if (resp && String(resp.statusCode) === '200' && resp.action_code) {
        setPass({
          going_out_no: String(resp.going_out_no || ''),
          emp_name: String(resp.emp_name || ''),
          req_date: String(resp.req_date || ''),
          action_code: Number(resp.action_code),
          action_label: String(resp.action_label || ''),
        });
      } else {
        Alert.alert('Not Allowed', (resp && resp.message) || 'This gate pass cannot be processed.');
      }
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsScanning(false);
    }
  };

  const doPunch = async () => {
    if (!pass) return;
    setIsSaving(true);
    try {
      // Best-effort: send the latest live fix if we have one, else empty. A
      // missing location never blocks the punch (the backend stores it only when
      // numeric).
      const c = coordsRef.current;
      const lat = c && typeof c.lat === 'number' ? String(c.lat) : '';
      const lon = c && typeof c.long === 'number' ? String(c.long) : '';
      const resp = await apiPost(ENDPOINTS.employeeInOut, {
        rtype: 'punch',
        employee_id: loginUserId,
        going_out_no: pass.going_out_no,
        remarks: remarks.trim(),
        lat,
        lon,
      });
      const ok = resp && String(resp.statusCode) === '200';
      Alert.alert(ok ? 'Success' : 'Employee In / Out', (resp && resp.message) || 'Done.');
      if (ok) resetPass();
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const confirmPunch = () => {
    if (!pass) return;
    Alert.alert(
      'Confirm ' + pass.action_label,
      `Record "${pass.action_label}" for ${pass.emp_name || 'this employee'}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: pass.action_label, onPress: doPunch },
      ],
    );
  };

  // Live location readout — same states/layout as QR Code Visit.
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
          {isReducedAccuracyFix(coords) && (
            <View style={styles.preciseWarn}>
              <Text style={styles.gpsError}>
                This position is only approximate. Switch Wi-Fi ON (it need not be
                connected), or check that Precise Location is enabled for this app.
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
            Still can't read your location. Check that Location/GPS is switched on
            for your device, then tap Refresh.
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
            Amul Common App only has “Approximate” location access.
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
      <Text style={styles.gpsError}>Couldn't get your location. Make sure GPS is on.</Text>
    );
  };

  return (
    // Standard app background: a soft red-to-white gradient (same as DIL Entry),
    // with the scroll area transparent so the gradient shows through.
    <LinearGradient colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']} style={{ flex: 1 }}>
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
              <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Your Location</Text>
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

        {/* ---------- Scan ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Employee Gate Pass</Text>
          <Text style={styles.help}>
            Scan the employee's going-out gate pass QR.
          </Text>

          <TouchableOpacity
            style={[styles.scanBtn, isScanning && { opacity: 0.6 }]}
            onPress={() => setIsScannerOpen(true)}
            disabled={isScanning}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Scan gate pass QR"
          >
            {isScanning ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Checking…</Text>
              </View>
            ) : (
              <>
                <Image source={QR_ICON} style={styles.qrImg} />
                <Text style={styles.scanBtnText}>Scan Employee Gate Pass</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ---------- Movement details (always visible; filled after a scan) ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Movement</Text>

          <View style={[styles.actionBanner, !pass && styles.actionBannerEmpty]}>
            <Text style={[styles.actionBannerLabel, !pass && styles.actionBannerLabelEmpty]}>Next Action</Text>
            <Text style={[styles.actionBannerValue, !pass && styles.actionBannerValueEmpty]}>
              {pass ? pass.action_label : 'Scan a gate pass'}
            </Text>
          </View>

          <Text style={styles.label}>Employee</Text>
          <View style={[styles.input, styles.readonly]}>
            <Text style={styles.readonlyText} numberOfLines={2}>{(pass && pass.emp_name) || '-'}</Text>
          </View>

          <Text style={[styles.label, styles.fieldGap]}>Requested Date</Text>
          <View style={[styles.input, styles.readonly]}>
            <Text style={styles.readonlyText} numberOfLines={1}>{(pass && pass.req_date) || '-'}</Text>
          </View>

          <Text style={[styles.label, styles.fieldGap]}>Remarks</Text>
          <TextInput
            style={[styles.input, !pass && styles.inputDisabled]}
            value={remarks}
            onChangeText={t => setRemarks(sanitizeRemark(t))}
            placeholder="Add remarks (optional)"
            placeholderTextColor="#9AA0AA"
            maxLength={REMARK_MAX}
            editable={!!pass}
            autoCorrect={false}
            blurOnSubmit
            returnKeyType="done"
          />

          <TouchableOpacity
            style={[styles.button, styles.saveBtn, (!pass || isSaving) && styles.buttonDisabled]}
            onPress={confirmPunch}
            disabled={!pass || isSaving}
            activeOpacity={0.85}
          >
            {isSaving ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Saving…</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>{pass ? `Confirm ${pass.action_label}` : 'Confirm Movement'}</Text>
            )}
          </TouchableOpacity>

          {pass && (
            <TouchableOpacity style={styles.cancelBtn} onPress={resetPass} activeOpacity={0.7}>
              <Text style={styles.cancelBtnText}>Cancel / Scan another</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {isScannerOpen && (
        <ScannerBoundary
          onClose={() => setIsScannerOpen(false)}
          message="The scanner couldn't start on this device. Please try again."
        >
          <QrScanner
            visible
            hint="Align the employee gate pass QR code within the frame"
            codeTypes={SCAN_CODE_TYPES}
            onClose={() => setIsScannerOpen(false)}
            onScanned={onQrScanned}
            onTimeout={() => {
              setIsScannerOpen(false);
              Alert.alert(MSG.SCAN_TIMEOUT.title, MSG.SCAN_TIMEOUT.message);
            }}
          />
        </ScannerBoundary>
      )}
    </KeyboardAvoidingView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    // Transparent card with a red-tinted border — same as DIL Entry, so the
    // screen's gradient background shows through.
    backgroundColor: 'transparent',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(227,0,27,0.40)',
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },

  // ---- Live location card (same look as QR Code Visit) ----
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
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
  preciseWarn: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: COLORS.line },
  gpsError: { color: COLORS.primaryRed, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  gpsSettingsLink: {
    color: COLORS.primaryRed,
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
    marginTop: 8,
  },
  help: { color: COLORS.mediumText, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  label: { fontWeight: '600', color: COLORS.darkText, marginBottom: 8, fontSize: 14 },
  fieldGap: { marginTop: 18 },

  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
  },
  scanBtnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15, marginLeft: 9 },
  qrImg: { width: 20, height: 20, tintColor: '#FFFFFF' },

  actionBanner: {
    backgroundColor: COLORS.redTint,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.primaryRed,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 18,
    alignItems: 'center',
  },
  actionBannerLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryRed,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  actionBannerValue: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.primaryRed,
    marginTop: 4,
  },
  // Muted look before a pass is scanned.
  actionBannerEmpty: { backgroundColor: '#F3F4F6', borderColor: COLORS.inputBorder },
  actionBannerLabelEmpty: { color: COLORS.muted },
  actionBannerValueEmpty: { color: COLORS.muted, fontSize: 16, fontWeight: '700' },

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
  readonlyText: { color: COLORS.darkText, fontSize: 15, fontWeight: '700' },
  inputDisabled: { backgroundColor: '#F3F4F6' },

  button: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  saveBtn: { backgroundColor: COLORS.primaryRed },
  buttonDisabled: { backgroundColor: '#C9CDD3' },
  buttonText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  btnBusyRow: { flexDirection: 'row', alignItems: 'center' },
  btnBusyText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 10 },

  cancelBtn: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  cancelBtnText: { color: COLORS.mediumText, fontWeight: '700', fontSize: 14 },
});

export default EmployeeInOutScreen;
