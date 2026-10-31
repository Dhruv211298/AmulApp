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
import SelectField from '../components/SelectField';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

const QR_ICON = require('../assets/qr_scan.png');

const SCAN_CODE_TYPES = ['qr', 'ean-13', 'ean-8', 'code-128', 'code-39', 'code-93'];

const TRIP_TYPES = [
  { value: '1', label: 'Regular Dispatch' },
  { value: '2', label: 'Repair / Maintenance' },
];

const REMARK_MAX = 500;
// Tanker no: alphanumeric only, uppercased (matches the web form).
const sanitizeTanker = t => String(t || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20);
// Tare weight: digits + a single decimal point.
const sanitizeWeight = t => {
  let s = String(t || '').replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
  return s.slice(0, 12);
};
// Remarks: strip new lines (no Enter), and keep a safe whitelist — drops quotes,
// angle brackets, backslashes, semicolons and other characters that could break
// a query or a report. Then cap the length.
const REMARK_ALLOWED = /[^A-Za-z0-9 .,\-/()&:#@]/g;
const sanitizeRemark = t =>
  String(t || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(REMARK_ALLOWED, '')
    .slice(0, REMARK_MAX);

// VCU Empty-Tanker Tracking — Tanker OUT (dispatch).
//   Source plant is the logged-in user's plant (shown read-only). Scan/enter the
//   tanker, Fetch pulls its ticket + tare from SAP, then choose trip type /
//   destination / remarks and Save. Repair-Maintenance returns to the source.
const VcuEmptyTankerOutScreen = () => {
  const [loginUserId, setLoginUserId] = useState('');
  const [plantCode, setPlantCode] = useState('');
  const [sourcePlant, setSourcePlant] = useState({ code: '', name: '' });
  const [destPlants, setDestPlants] = useState([]);
  const [initLoading, setInitLoading] = useState(true);

  const [tankerNo, setTankerNo] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  const [showDetails, setShowDetails] = useState(false);
  const [ticketNo, setTicketNo] = useState('');
  const [tareWeight, setTareWeight] = useState('');
  const [tripType, setTripType] = useState('1');
  const [destination, setDestination] = useState('');
  const [remarks, setRemarks] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Load the user id + source plant + destination list on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const id = ((await getItem(KEYS.userId)) || '').trim();
      if (mounted && id) setLoginUserId(id);
      // The user's plant is resolved at login — show it immediately, then let
      // init enrich it with the plant name (and load the destination list).
      const pc = ((await getItem(KEYS.plantCode)) || '').trim();
      if (mounted && pc) {
        setPlantCode(pc);
        setSourcePlant({ code: pc, name: '' });
      }
      try {
        const resp = await apiPost(ENDPOINTS.vcuTankerTrack, { rtype: 'init', employee_id: id, plant_code: pc });
        if (mounted && resp && String(resp.statusCode) === '200') {
          if (resp.source_plant && resp.source_plant.code) setSourcePlant(resp.source_plant);
          if (Array.isArray(resp.dest_plants)) setDestPlants(resp.dest_plants);
        }
      } catch (e) {
        // Non-fatal — the screen still works; Fetch/Save re-resolve server-side.
      } finally {
        if (mounted) setInitLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const resetDetails = () => {
    setShowDetails(false);
    setTicketNo('');
    setTareWeight('');
    setTripType('1');
    setDestination('');
    setRemarks('');
  };

  const resetAll = () => {
    setTankerNo('');
    resetDetails();
  };

  const onTripTypeChange = v => {
    setTripType(v);
    // Repair / Maintenance returns to the source plant (locked).
    if (v === '2') setDestination(sourcePlant.code || '');
    else if (destination === sourcePlant.code) setDestination('');
  };

  const onQrScanned = scannedValue => {
    setIsScannerOpen(false);
    const raw = sanitizeTanker(scannedValue);
    if (!raw) {
      Alert.alert(MSG.QR_UNREADABLE.title, MSG.QR_UNREADABLE.message);
      return;
    }
    setTankerNo(raw);
    resetDetails();
  };

  const fetchDetails = async () => {
    if (!loginUserId) {
      return Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
    }
    if (!tankerNo.trim()) {
      return Alert.alert('Invalid', 'Scan or enter the Tanker Number.');
    }
    setIsFetching(true);
    try {
      const resp = await apiPost(
        ENDPOINTS.vcuTankerTrack,
        {
          rtype: 'fetch',
          employee_id: loginUserId,
          plant_code: plantCode,
          tanker_no: tankerNo.trim(),
        },
        { timeoutMs: 35000 }, // SAP weight lookup can be slow — don't time out early
      );
      if (resp && Number(resp.allocated) === 1) {
        resetDetails();
        return Alert.alert('Already Allocated', resp.message || 'This tanker is already allocated.');
      }
      if (resp && String(resp.statusCode) === '200') {
        setTicketNo(String(resp.ticket_no || ''));
        setTareWeight(String(resp.tare_weight || ''));
        setTripType('1');
        setDestination('');
        setRemarks('');
        setShowDetails(true);
      } else {
        resetDetails();
        Alert.alert('Not Found', (resp && resp.message) || 'No details found for this tanker.');
      }
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsFetching(false);
    }
  };

  const doSave = async () => {
    setIsSaving(true);
    try {
      const resp = await apiPost(ENDPOINTS.vcuTankerTrack, {
        rtype: 'save',
        employee_id: loginUserId,
        plant_code: plantCode,
        tanker_no: tankerNo.trim(),
        ticket_no: ticketNo,
        tare_weight: tareWeight,
        destination: tripType === '2' ? sourcePlant.code || '' : destination,
        trip_type: tripType,
        remarks: remarks.trim(),
      });
      if (resp && Number(resp.allocated) === 1) {
        Alert.alert('Already Allocated', resp.message || 'This tanker is already allocated.');
        resetAll();
        return;
      }
      const ok = resp && String(resp.statusCode) === '200';
      Alert.alert(ok ? 'Success' : 'VCU Tanker Out', (resp && resp.message) || 'Done.');
      if (ok) resetAll();
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const save = () => {
    if (!tareWeight.trim() || Number(tareWeight) === 0) {
      return Alert.alert('Invalid', 'Tare weight cannot be 0.');
    }
    if (tripType !== '2' && !destination) {
      return Alert.alert('Invalid', 'Select a Destination.');
    }
    Alert.alert(
      'Confirm Save',
      'Save these details? Once saved, this action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: doSave },
      ],
    );
  };

  const destName = code => {
    const p = destPlants.find(x => x.code === code);
    return p ? `${p.code} - ${p.name}` : code || '';
  };

  // Source plant display. If the init response didn't carry the plant name,
  // fall back to the name from the destination list (it includes KM/KL plants),
  // so we always show "CODE - Name" when the name is known anywhere.
  const srcDisplay = () => {
    if (!sourcePlant.code) return 'Plant not found';
    let nm = sourcePlant.name;
    if (!nm) {
      const p = destPlants.find(x => x.code === sourcePlant.code);
      if (p) nm = p.name;
    }
    return nm ? `${sourcePlant.code} - ${nm}` : sourcePlant.code;
  };

  const Segmented = ({ value, onChange, options }) => (
    <View style={styles.segRow}>
      {options.map((opt, i) => {
        const active = value === opt.value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segBtn, i === options.length - 1 && styles.segBtnLast, active && styles.segBtnActive]}
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
        {/* ---------- Search: plant + tanker ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>VCU Tanker Out</Text>

          <Text style={styles.label}>Plant</Text>
          <View style={[styles.input, styles.readonly]}>
            {initLoading ? (
              <View style={styles.resolvingRow}>
                <ActivityIndicator size="small" color={COLORS.primaryRed} />
                <Text style={styles.resolvingText}>Loading…</Text>
              </View>
            ) : (
              <Text style={styles.readonlyText} numberOfLines={1}>
                {srcDisplay()}
              </Text>
            )}
          </View>

          <Text style={[styles.label, styles.fieldGap]}>Tanker No <Text style={styles.req}>*</Text></Text>
          <View style={styles.codeRow}>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={tankerNo}
              onChangeText={t => {
                setTankerNo(sanitizeTanker(t));
                if (showDetails) resetDetails();
              }}
              placeholder="Enter or scan tanker no"
              placeholderTextColor="#9AA0AA"
              autoCapitalize="characters"
              autoCorrect={false}
            />
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

          <TouchableOpacity
            style={[styles.button, isFetching && { opacity: 0.6 }]}
            onPress={fetchDetails}
            disabled={isFetching}
            activeOpacity={0.85}
          >
            {isFetching ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Fetching…</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>Fetch Details</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* ---------- Details (after fetch) ---------- */}
        {showDetails && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Tanker Information</Text>

            <Text style={styles.label}>Ticket No</Text>
            <View style={[styles.input, styles.readonly]}>
              <Text style={styles.readonlyText} numberOfLines={1}>{ticketNo || '-'}</Text>
            </View>

            <Text style={[styles.label, styles.fieldGap]}>Last Tare Weight <Text style={styles.req}>*</Text></Text>
            <TextInput
              style={styles.input}
              value={tareWeight}
              onChangeText={t => setTareWeight(sanitizeWeight(t))}
              placeholder="0"
              placeholderTextColor="#9AA0AA"
              keyboardType="decimal-pad"
            />

            <Text style={[styles.label, styles.fieldGap]}>Trip Type <Text style={styles.req}>*</Text></Text>
            <Segmented value={tripType} onChange={onTripTypeChange} options={TRIP_TYPES} />

            <Text style={[styles.label, styles.fieldGap]}>Destination <Text style={styles.req}>*</Text></Text>
            {tripType === '2' ? (
              <>
                <View style={[styles.input, styles.readonly]}>
                  <Text style={styles.readonlyText} numberOfLines={1}>
                    {sourcePlant.code ? destName(sourcePlant.code) : '-'}
                  </Text>
                </View>
                <Text style={styles.hint}>Repair / Maintenance returns to the source plant.</Text>
              </>
            ) : (
              <SelectField
                data={destPlants.map(p => ({ value: p.code, code: p.code, name: p.name, label: `${p.code} - ${p.name}` }))}
                value={destination}
                placeholder="Select destination"
                title="Select Destination"
                searchPlaceholder="Search plant code or name…"
                search
                onChange={item => setDestination(item.value || '')}
              />
            )}

            <Text style={[styles.label, styles.fieldGap]}>Remarks</Text>
            <TextInput
              style={styles.input}
              value={remarks}
              onChangeText={t => setRemarks(sanitizeRemark(t))}
              placeholder="Add remarks (optional)"
              placeholderTextColor="#9AA0AA"
              maxLength={REMARK_MAX}
              autoCorrect={false}
              blurOnSubmit
              returnKeyType="done"
            />

            <TouchableOpacity
              style={[styles.button, styles.saveBtn, isSaving && { opacity: 0.6 }]}
              onPress={save}
              disabled={isSaving}
              activeOpacity={0.85}
            >
              {isSaving ? (
                <View style={styles.btnBusyRow}>
                  <ActivityIndicator color="#FFF" />
                  <Text style={styles.btnBusyText}>Saving…</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {isScannerOpen && (
        <ScannerBoundary
          onClose={() => setIsScannerOpen(false)}
          message="The scanner couldn't start on this device. Please try again or enter the tanker number manually."
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
  hint: { marginTop: 6, color: COLORS.muted, fontSize: 12 },
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
  resolvingRow: { flexDirection: 'row', alignItems: 'center' },
  resolvingText: { marginLeft: 8, color: COLORS.muted, fontSize: 14 },
  codeRow: { flexDirection: 'row', alignItems: 'center' },
  codeInput: { flex: 1 },
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

  // Trip type segmented
  segRow: { flexDirection: 'row' },
  segBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    alignItems: 'center',
    marginRight: 10,
    backgroundColor: '#FFFFFF',
  },
  segBtnLast: { marginRight: 0 },
  segBtnActive: { backgroundColor: COLORS.redTint, borderColor: COLORS.primaryRed },
  segText: { fontSize: 13, fontWeight: '700', color: COLORS.mediumText, textAlign: 'center' },
  segTextActive: { color: COLORS.primaryRed },

  // Destination picker field
  pickerField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickerValue: { color: COLORS.darkText, fontSize: 15, fontWeight: '600', flex: 1 },
  pickerPlaceholder: { color: '#9AA0AA', fontSize: 15, flex: 1 },
  pickerChevron: { color: COLORS.muted, fontSize: 14, marginLeft: 8 },

  remarksInput: { minHeight: 80, paddingTop: 12, textAlignVertical: 'top' },

  button: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  saveBtn: { backgroundColor: COLORS.primaryRed },
  buttonText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  btnBusyRow: { flexDirection: 'row', alignItems: 'center' },
  btnBusyText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 10 },

  // Destination modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 10,
    textAlign: 'center',
  },
  modalRow: {
    paddingVertical: 14,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  modalRowText: { fontSize: 15, color: COLORS.darkText, fontWeight: '600' },
  modalEmpty: { textAlign: 'center', color: COLORS.muted, paddingVertical: 20 },
  modalCancel: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 50,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  modalCancelText: { color: COLORS.darkText, fontWeight: '700', fontSize: 14 },
});

export default VcuEmptyTankerOutScreen;
