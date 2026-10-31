import React, { useState, useCallback, useEffect } from 'react';
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
  Alert,
  Image,
} from 'react-native';
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import {
  ensureLocationPermission,
  getPositionForSubmission,
  describeLocationError,
  openLocationSettings,
  LOC_ERR,
} from '../services/location';
import { getConfig } from '../services/remoteConfig';
import { COLORS } from '../theme';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

const keepDigitsOnly = value => (value || '').replace(/[^0-9]/g, '');

// Endpoints live in src/config.js. Expected responses:
//   employeeName       -> { status: 'success', name: 'Full Name' }
//   meetingAttendance  -> { statusCode, message }
//   meetingPresentList -> { status: 'success', meetings: [...] }
const NAME_LOOKUP_ENDPOINT = ENDPOINTS.employeeName;
const ATTENDANCE_URL = ENDPOINTS.meetingAttendance;
const PRESENT_LIST_URL = ENDPOINTS.meetingPresentList;

const QR_ICON = require('../assets/qr_scan.png');

const MeetingAttendanceScreen = () => {
  const [employeeId, setEmployeeId] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  // nameStatus: 'idle' | 'loading' | 'found' | 'notfound' | 'error'
  const [nameStatus, setNameStatus] = useState('idle');
  const [meetingCode, setMeetingCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [presentList, setPresentList] = useState([]);
  const [isPresentLoading, setIsPresentLoading] = useState(false);
  // The app-logged-in user's ID. The present list is ALWAYS for this user,
  // regardless of what Employee ID is typed above (which may be someone else).
  const [loginUserId, setLoginUserId] = useState('');

  // A meeting QR code was scanned. Meeting QR codes are STRICTLY numeric, so
  // the value is validated as a whole rather than silently stripped: a QR
  // containing any letter/symbol (someone scanned the wrong code — a URL, a
  // product barcode, a location QR) is rejected with a clear alert and the
  // Meeting Code field is left empty. Previously keepDigitsOnly() would
  // quietly extract the digits from such a scan (e.g. "ABC123" -> "123"),
  // planting a wrong-but-plausible code in the field.
  const onQrScanned = scannedValue => {
    setIsScannerOpen(false);
    const raw = String(scannedValue || '').trim();
    if (!raw || !/^[0-9]+$/.test(raw)) {
      setMeetingCode('');
      Alert.alert(
        'Invalid Meeting QR Code',
        'This QR code is not a meeting code. Please scan the correct meeting QR code.',
      );
      return;
    }
    setMeetingCode(raw);
  };

  // Look up the employee name for a given 8-digit id.
  const fetchEmployeeName = useCallback(async id => {
    setNameStatus('loading');
    setEmployeeName('');
    try {
      const response = await apiPost(NAME_LOOKUP_ENDPOINT, { emp_id: id });
      if (response && response.status === 'success' && response.name) {
        setEmployeeName(response.name);
        setNameStatus('found');
      } else {
        setNameStatus('notfound');
      }
    } catch (error) {
      setNameStatus('error');
    }
  }, []);

  // Load today's meetings this employee is marked present for.
  const fetchPresentList = useCallback(async id => {
    if (!id) return;
    setIsPresentLoading(true);
    try {
      const response = await apiPost(PRESENT_LIST_URL, { employee_id: id });
      if (response && response.status === 'success' && Array.isArray(response.meetings)) {
        setPresentList(response.meetings);
      } else {
        setPresentList([]);
      }
    } catch (error) {
      setPresentList([]);
    } finally {
      setIsPresentLoading(false);
    }
  }, []);

  // Pre-fill the logged-in employee's ID, auto-load their name and present list.
  useEffect(() => {
    let isMounted = true;
    (async () => {
      const storedId = keepDigitsOnly((await getItem(KEYS.userId)) || '').slice(0, 8);
      if (isMounted && storedId.length === 8) {
        setLoginUserId(storedId); // present list is locked to this logged-in user
        setEmployeeId(storedId);
        fetchEmployeeName(storedId);
        fetchPresentList(storedId);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [fetchEmployeeName, fetchPresentList]);

  const onEmployeeIdChange = text => {
    const digits = keepDigitsOnly(text).slice(0, 8);
    setEmployeeId(digits);
    if (digits.length === 8) {
      fetchEmployeeName(digits);
    } else {
      setEmployeeName('');
      setNameStatus('idle');
    }
  };

  const submitAttendance = async () => {
    if (employeeId.length !== 8) {
      return Alert.alert('Invalid', 'Employee ID must be exactly 8 digits.');
    }
    if (nameStatus !== 'found') {
      return Alert.alert('Invalid', 'Enter a valid Employee ID so the name loads.');
    }
    if (!meetingCode) {
      return Alert.alert('Invalid', 'Enter the Meeting Code.');
    }

    // 1) Permission — checked BEFORE the submitting state is set. The OS
    //    permission dialog promise can be dropped if the Activity is recreated
    //    while it is showing (rotation/low memory); if that happened after
    //    setIsSubmitting(true), the finally below would never run and the
    //    Submit button would be stuck on a spinner forever. In this order, a
    //    lost dialog simply leaves the button enabled to tap again.
    //    `precise` matters as much as `granted`: an Android user who picked
    //    "Approximate" gets coordinates fuzzed to ~1-3km, which cannot confirm
    //    meeting presence.
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
      // 2) A submission-grade fix: fresh (never cached), GPS-first, accuracy
      //    checked, and rejected outright if a mock-location app supplied it.
      let position;
      try {
        position = await getPositionForSubmission({
          // Same posture as QR Visit: the meeting code is the primary proof of
          // participation, so a weak indoor fix must not block the submission.
          // The strict target is tried first (a good fix wins immediately);
          // when the window expires, the best real fix within the cap is
          // accepted — still mock-rejected, accuracy still honest in the fix.
          // Cap of 0 (server-set) disables best-effort -> fully strict.
          timeout: 12000,
          accuracyLimit: getConfig().meetingAccuracyM,
          bestEffort: getConfig().meetingBestEffortCapM > 0,
          bestEffortCap: getConfig().meetingBestEffortCapM,
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

      const response = await apiPost(ATTENDANCE_URL, {
        // employee_id must be the LOGGED-IN user — it is the identity the
        // server's token guard validates (the token is bound to this user +
        // device). Sending the entered id here made the guard reject any
        // attendance marked for a COLLEAGUE as "session expired".
        employee_id: loginUserId,
        // The employee whose attendance is actually being marked (may be the
        // logged-in user, or a colleague). The backend records the visit
        // against this id and logs employee_id above as who submitted it.
        attendance_emp_id: employeeId,
        meeting_code: meetingCode,
        device_id: deviceId,
        latitude: position.lat,
        longitude: position.long,
      });

      const isSuccess = response && String(response.statusCode) === '200';
      Alert.alert(
        isSuccess ? 'Success' : 'Attendance',
        (response && response.message) || 'Done.',
      );
      if (isSuccess) {
        setMeetingCode('');
        // Refresh the table for the LOGGED-IN user only, never the entered ID.
        fetchPresentList(loginUserId);
      }
    } catch (error) {
      if (!(error && error.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderEmployeeName = () => {
    if (nameStatus === 'loading') {
      return (
        <View style={styles.nameRow}>
          <ActivityIndicator size="small" color={COLORS.primaryRed} />
          <Text style={styles.nameFetching}>Fetching name…</Text>
        </View>
      );
    }
    if (nameStatus === 'found') {
      return <Text style={styles.nameFound}>{employeeName}</Text>;
    }
    if (nameStatus === 'notfound') {
      return <Text style={styles.nameError}>No employee found for this ID</Text>;
    }
    if (nameStatus === 'error') {
      return <Text style={styles.nameError}>Couldn't fetch name. Check connection.</Text>;
    }
    return <Text style={styles.namePlaceholder}>Auto-filled from Employee ID</Text>;
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
        <View style={styles.card}>
          {/* Employee ID */}
          <Text style={styles.label}>Employee ID</Text>
          <TextInput
            style={styles.input}
            value={employeeId}
            onChangeText={onEmployeeIdChange}
            keyboardType="number-pad"
            maxLength={8}
            placeholder="Enter 8-digit Employee ID"
            placeholderTextColor="#9AA0AA"
            returnKeyType="done"
          />
          <Text style={styles.hint}>{employeeId.length}/8 digits</Text>

          {/* Employee Name (read-only, auto-filled) */}
          <Text style={styles.label}>Employee Name</Text>
          <View style={[styles.input, styles.readonly]}>{renderEmployeeName()}</View>

          {/* Meeting Code (digits only) + QR scan */}
          <Text style={styles.label}>Meeting Code</Text>
          <View style={styles.codeRow}>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={meetingCode}
              onChangeText={text => setMeetingCode(keepDigitsOnly(text))}
              keyboardType="number-pad"
              placeholder="Enter meeting code"
              placeholderTextColor="#9AA0AA"
              returnKeyType="done"
            />
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
              <Text style={styles.buttonText}>Submit</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Today's present meetings */}
        <View style={styles.tableCard}>
          <Text style={styles.tableTitle}>Today's Meetings Present</Text>
          {!!loginUserId && (
            <Text style={styles.tableSubtitle}>Employee No: {loginUserId}</Text>
          )}

          {isPresentLoading ? (
            <ActivityIndicator color={COLORS.primaryRed} style={{ marginVertical: 18 }} />
          ) : presentList.length === 0 ? (
            <Text style={styles.tableEmpty}>No present meetings today.</Text>
          ) : (
            <View style={styles.table}>
              <View style={[styles.tableRow, styles.tableHeaderRow]}>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colDesc]}>
                  Meeting
                </Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colTime]}>
                  Meeting Time
                </Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colTime]}>
                  Present Time
                </Text>
              </View>
              {presentList.map((item, index) => (
                <View key={index} style={styles.tableRow}>
                  <Text style={[styles.tableCell, styles.colDesc]}>
                    {item.meeting_desc}
                  </Text>
                  <Text style={[styles.tableCell, styles.colTime]}>
                    {item.meeting_datetime}
                  </Text>
                  <Text style={[styles.tableCell, styles.colTime]}>
                    {item.present_time}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Mounted only while scanning; wrapped so a camera failure can't crash the app */}
      {isScannerOpen && (
        <ScannerBoundary
          onClose={() => setIsScannerOpen(false)}
          message="The QR scanner couldn't start on this device. Please enter the Meeting Code manually."
        >
          <QrScanner
            visible
            hint="Align the meeting QR code within the frame"
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
  },
  label: {
    fontWeight: '600',
    color: COLORS.darkText,
    marginTop: 14,
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
  hint: { fontSize: 11, color: COLORS.muted, marginTop: 6, marginLeft: 4 },
  readonly: { backgroundColor: '#F3F4F6' },
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
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  nameFetching: { marginLeft: 10, color: COLORS.muted, fontSize: 15 },
  nameFound: { color: COLORS.darkText, fontSize: 15, fontWeight: '700' },
  nameError: { color: COLORS.primaryRed, fontSize: 14, fontWeight: '600' },
  namePlaceholder: { color: '#9AA0AA', fontSize: 15 },
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

  // Present-meetings table
  tableCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
  },
  tableTitle: { fontSize: 15, fontWeight: '800', color: COLORS.darkText, marginBottom: 2 },
  tableSubtitle: { fontSize: 12, color: COLORS.muted, fontWeight: '600', marginBottom: 12 },
  // top+left on the wrapper, right+bottom on each cell -> single clean grid lines
  table: {
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 10,
    overflow: 'hidden',
  },
  tableRow: { flexDirection: 'row' },
  tableHeaderRow: { backgroundColor: COLORS.redTint },
  tableHeaderText: { fontWeight: '700', color: COLORS.primaryRed, fontSize: 11.5 },
  tableCell: {
    fontSize: 11.5,
    color: COLORS.darkText,
    paddingHorizontal: 6,
    paddingVertical: 9,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.inputBorder,
  },
  colDesc: { flex: 1.5 },
  colTime: { flex: 1 },
  tableEmpty: {
    fontSize: 13,
    color: COLORS.muted,
    textAlign: 'center',
    paddingVertical: 18,
  },
});

export default MeetingAttendanceScreen;
