import React, { useState, useEffect } from 'react';
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
import { COLORS } from '../theme';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

const QR_ICON = require('../assets/qr_scan.png');

// A tanker QR may be a QR or a 1D barcode, so accept both (same set as DIL).
const SCAN_CODE_TYPES = ['qr', 'ean-13', 'ean-8', 'code-128', 'code-39', 'code-93'];

// OK / Not OK choices, shared by Pump Health and Initialization Status.
const OKNOK = [
  { value: '1', label: 'OK' },
  { value: '2', label: 'Not OK' },
];

// Route number: digits only, capped so a bad scan/paste can't overflow the column.
const sanitizeDigits = (t, max = 6) => String(t || '').replace(/[^0-9]/g, '').slice(0, max);

// VCU Tanker OUT Check — Stage 1 of the Auto Sampler flow.
//   Scan the tanker QR -> it resolves to the vehicle number (read-only) ->
//   enter Route No, Pump Health, Init Status -> save. Creates the open OUT
//   record that the Tanker IN screen later completes.
const VcuTankerOutScreen = () => {
  const [tankerNo, setTankerNo] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [routeNo, setRouteNo] = useState('');
  const [pumpHealth, setPumpHealth] = useState('');
  const [iniStatus, setIniStatus] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginUserId, setLoginUserId] = useState('');
  const [sectionNo, setSectionNo] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const id = ((await getItem(KEYS.userId)) || '').trim();
      if (mounted && id) setLoginUserId(id);
      // Section resolved for this user at login — stored for nu_create_section_1.
      const sec = ((await getItem(KEYS.sectionNo)) || '').trim();
      if (mounted && sec) setSectionNo(sec);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const resetForm = () => {
    setTankerNo('');
    setRouteNo('');
    setPumpHealth('');
    setIniStatus('');
  };

  // Resolve a scanned tanker QR to its vehicle number via the backend.
  const resolveTanker = async rawCode => {
    setIsResolving(true);
    try {
      const resp = await apiPost(ENDPOINTS.vcuQrLookup, {
        qrcode_id: rawCode,
        employee_id: loginUserId,
      });
      if (resp && String(resp.statusCode) === '200' && resp.vehicle_no) {
        setTankerNo(String(resp.vehicle_no));
      } else {
        resetForm();
        Alert.alert(
          'Invalid QR',
          (resp && resp.message) || 'This tanker QR could not be verified. Please scan again.',
        );
      }
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsResolving(false);
    }
  };

  const onQrScanned = async scannedValue => {
    setIsScannerOpen(false);
    const raw = String(scannedValue || '').trim();
    if (!raw) {
      Alert.alert(MSG.QR_UNREADABLE.title, MSG.QR_UNREADABLE.message);
      return;
    }
    resetForm();
    await resolveTanker(raw);
  };

  const submit = async () => {
    if (!loginUserId) {
      return Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
    }
    if (!tankerNo.trim()) {
      return Alert.alert('Invalid', 'Scan the tanker QR first.');
    }
    if (!routeNo.trim()) {
      return Alert.alert('Invalid', 'Enter the Route Number.');
    }
    if (!pumpHealth) {
      return Alert.alert('Invalid', 'Select the Pump Health.');
    }
    if (!iniStatus) {
      return Alert.alert('Invalid', 'Select the Initialization Status.');
    }

    setIsSubmitting(true);
    try {
      const resp = await apiPost(ENDPOINTS.vcuSampler, {
        rtype: 'stage1_save',
        employee_id: loginUserId,
        section_no: sectionNo, // -> nu_create_section_1
        tanker_no: tankerNo.trim(),
        route_no: routeNo.trim(),
        pump_health: pumpHealth,
        ini_status: iniStatus,
      });
      const ok = resp && String(resp.statusCode) === '200';
      Alert.alert(ok ? 'Success' : 'VCU Tanker Out', (resp && resp.message) || 'Done.');
      if (ok) resetForm();
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const Segmented = ({ value, onChange }) => (
    <View style={styles.segRow}>
      {OKNOK.map((opt, i) => {
        const active = value === opt.value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segBtn, i === OKNOK.length - 1 && styles.segBtnLast, active && styles.segBtnActive]}
            onPress={() => onChange(opt.value)}
            activeOpacity={0.85}
          >
            <Text style={[styles.segText, active && styles.segTextActive]}>{opt.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

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
        {/* ---------- Tanker (scan) ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Tanker <Text style={styles.req}>*</Text></Text>
          <View style={styles.codeRow}>
            <View style={[styles.input, styles.codeInput, styles.readonly]}>
              {isResolving ? (
                <View style={styles.resolvingRow}>
                  <ActivityIndicator size="small" color={COLORS.primaryRed} />
                  <Text style={styles.resolvingText}>Checking tanker…</Text>
                </View>
              ) : tankerNo ? (
                <Text style={styles.readonlyDone} numberOfLines={1}>
                  {tankerNo}
                </Text>
              ) : (
                <Text style={styles.readonlyPlaceholder}>Scan a tanker QR to fill</Text>
              )}
            </View>
            <TouchableOpacity
              style={styles.scanBtn}
              onPress={() => setIsScannerOpen(true)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Scan tanker QR"
            >
              <Image source={QR_ICON} style={styles.qrImg} />
              <Text style={styles.scanBtnText}>Scan</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ---------- OUT details ---------- */}
        <View style={styles.card}>
          <Text style={styles.label}>Route No <Text style={styles.req}>*</Text></Text>
          <TextInput
            style={styles.input}
            value={routeNo}
            onChangeText={t => setRouteNo(sanitizeDigits(t))}
            placeholder="Enter route number"
            placeholderTextColor="#9AA0AA"
            keyboardType="number-pad"
            maxLength={6}
          />

          <Text style={[styles.label, styles.fieldGap]}>Pump Health <Text style={styles.req}>*</Text></Text>
          <Segmented value={pumpHealth} onChange={setPumpHealth} />

          <Text style={[styles.label, styles.fieldGap]}>Initialization Status <Text style={styles.req}>*</Text></Text>
          <Segmented value={iniStatus} onChange={setIniStatus} />

          <TouchableOpacity
            style={[styles.button, isSubmitting && { opacity: 0.6 }]}
            onPress={submit}
            disabled={isSubmitting}
            activeOpacity={0.85}
          >
            {isSubmitting ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Saving…</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Save Tanker OUT</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {isScannerOpen && (
        <ScannerBoundary
          onClose={() => setIsScannerOpen(false)}
          message="The scanner couldn't start on this device. Please try again or contact IT support."
        >
          <QrScanner
            visible
            hint="Align the tanker QR code within the frame"
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
  cardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  label: { fontWeight: '600', color: COLORS.darkText, marginBottom: 8, fontSize: 14 },
  req: { color: COLORS.primaryRed, fontWeight: '800' },
  fieldGap: { marginTop: 18 },
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
  readonly: { backgroundColor: '#F3F4F6' },
  readonlyDone: { color: COLORS.darkText, fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },
  readonlyPlaceholder: { color: '#9AA0AA', fontSize: 15 },
  resolvingRow: { flexDirection: 'row', alignItems: 'center' },
  resolvingText: { marginLeft: 8, color: COLORS.muted, fontSize: 14 },
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

  // OK / Not OK segmented control
  segRow: { flexDirection: 'row' },
  segBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    alignItems: 'center',
    marginRight: 10,
    backgroundColor: '#FFFFFF',
  },
  segBtnLast: { marginRight: 0 },
  segBtnActive: { backgroundColor: COLORS.redTint, borderColor: COLORS.primaryRed },
  segText: { fontSize: 15, fontWeight: '700', color: COLORS.mediumText },
  segTextActive: { color: COLORS.primaryRed },

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

export default VcuTankerOutScreen;
