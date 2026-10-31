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
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import { COLORS } from '../theme';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

const QR_ICON = require('../assets/qr_scan.png');
const CAMERA_ICON = require('../assets/camera.png');

const SCAN_CODE_TYPES = ['qr', 'ean-13', 'ean-8', 'code-128', 'code-39', 'code-93'];

// Sample photo: downscale + strip EXIF to keep the base64 upload light (same
// spec/pattern as the DIL dispatch photos).
const SAMPLE_PHOTO_SPEC = { maxW: 1280, maxH: 1280, quality: 72 };

// Base64 uploads are heavier than a normal POST — give them room.
const UPLOAD_TIMEOUT_MS = 60000;

const OKNOK_TEXT = { '1': 'OK', '2': 'Not OK' };
const sanitizeDigits = (t, max = 6) => String(t || '').replace(/[^0-9]/g, '').slice(0, max);
const base64Only = uri => {
  const s = String(uri || '');
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
};

// VCU Tanker IN Check — Stage 2 of the Auto Sampler flow.
//   Scan the tanker QR -> resolve to vehicle -> fetch its open OUT record ->
//   show the OUT details read-only, collect the sample counts + a sample photo
//   -> save, which completes the record (nu_status 2).
const VcuTankerInScreen = () => {
  const [tankerNo, setTankerNo] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [openId, setOpenId] = useState(null); // nu_id of the OUT record
  const [outInfo, setOutInfo] = useState(null); // { route_no, pump_health, ini_status }

  const [dcsNo, setDcsNo] = useState('');
  const [fullSample, setFullSample] = useState('');
  const [lessSample, setLessSample] = useState('');
  const [emptySample, setEmptySample] = useState('');
  const [photoUri, setPhotoUri] = useState(''); // data:image/jpeg;base64,...

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginUserId, setLoginUserId] = useState('');

  // Camera (vision-camera, same pattern as DIL Entry).
  const [cameraOpen, setCameraOpen] = useState(false);
  const [hasCamPermission, setHasCamPermission] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(false);
  const camRef = useRef(null);
  const camDevice = useCameraDevice(isFrontCamera ? 'front' : 'back');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const id = ((await getItem(KEYS.userId)) || '').trim();
      if (mounted && id) setLoginUserId(id);
      try {
        const status = await Camera.requestCameraPermission();
        if (mounted) setHasCamPermission(status === 'granted' || status === 'authorized');
      } catch (e) {}
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const resetAll = () => {
    setTankerNo('');
    setOpenId(null);
    setOutInfo(null);
    setDcsNo('');
    setFullSample('');
    setLessSample('');
    setEmptySample('');
    setPhotoUri('');
  };

  // Scan -> resolve vehicle -> fetch the open OUT record.
  const resolveAndFetch = async rawCode => {
    setIsResolving(true);
    try {
      const look = await apiPost(ENDPOINTS.vcuQrLookup, {
        qrcode_id: rawCode,
        employee_id: loginUserId,
      });
      if (!(look && String(look.statusCode) === '200' && look.vehicle_no)) {
        Alert.alert(
          'Invalid QR',
          (look && look.message) || 'This tanker QR could not be verified. Please scan again.',
        );
        return;
      }
      const vehicle = String(look.vehicle_no);
      setTankerNo(vehicle);

      const open = await apiPost(ENDPOINTS.vcuSampler, {
        rtype: 'fetch_open',
        tanker_no: vehicle,
        employee_id: loginUserId,
      });
      if (open && String(open.statusCode) === '200' && Number(open.found) === 1) {
        setOpenId(open.id);
        setOutInfo({
          route_no: open.route_no,
          pump_health: open.pump_health,
          ini_status: open.ini_status,
        });
      } else {
        setOpenId(null);
        setOutInfo(null);
        Alert.alert(
          'No OUT Record',
          (open && open.message) ||
            'No open OUT record found for this tanker. Please complete the Tanker OUT stage first.',
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
    resetAll();
    await resolveAndFetch(raw);
  };

  // Capture the sample photo: best frame -> downscale + strip EXIF -> base64.
  const takePhoto = useCallback(async () => {
    if (!camRef.current) return;
    try {
      const photo = await camRef.current.takePhoto({ qualityPrioritization: 'quality' });
      const originalPath = photo.path.replace('file://', '');
      const resized = await ImageResizer.createResizedImage(
        originalPath,
        SAMPLE_PHOTO_SPEC.maxW,
        SAMPLE_PHOTO_SPEC.maxH,
        'JPEG',
        SAMPLE_PHOTO_SPEC.quality,
        0,
        undefined,
        false,
        { mode: 'contain', onlyScaleDown: true },
      );
      const base64 = await RNFS.readFile(resized.uri, 'base64');
      setPhotoUri(`data:image/jpeg;base64,${base64}`);
      try { await RNFS.unlink(resized.uri); } catch (e) {}
      try { await RNFS.unlink(originalPath); } catch (e) {}
      setCameraOpen(false);
    } catch (e) {
      Alert.alert('Camera', 'Could not capture the photo. Please try again.');
    }
  }, []);

  const openCamera = () => {
    if (!hasCamPermission) {
      Camera.requestCameraPermission()
        .then(status => {
          const ok = status === 'granted' || status === 'authorized';
          setHasCamPermission(ok);
          if (ok) setCameraOpen(true);
          else Alert.alert('Camera permission', 'Camera permission is required to take the sample photo.');
        })
        .catch(() => {});
      return;
    }
    setCameraOpen(true);
  };

  const submit = async () => {
    if (!loginUserId) {
      return Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
    }
    if (!openId) {
      return Alert.alert('Invalid', 'Scan a tanker with an open OUT record first.');
    }
    for (const [label, val] of [
      ['No. of DCS', dcsNo],
      ['No. of Full Samples', fullSample],
      ['No. of Less Samples', lessSample],
      ['No. of Empty Samples', emptySample],
    ]) {
      if (!String(val).trim()) {
        return Alert.alert('Invalid', `Enter ${label}.`);
      }
    }
    if (!photoUri) {
      return Alert.alert('Invalid', 'Capture the sample photo before saving.');
    }

    setIsSubmitting(true);
    try {
      const resp = await apiPost(
        ENDPOINTS.vcuSampler,
        {
          rtype: 'stage2_save',
          employee_id: loginUserId,
          id: String(openId),
          tanker_no: tankerNo.trim(),
          dcs_no: dcsNo.trim(),
          full_sample: fullSample.trim(),
          less_sample: lessSample.trim(),
          empty_sample: emptySample.trim(),
          sample_image: base64Only(photoUri),
        },
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      );
      const ok = resp && String(resp.statusCode) === '200';
      Alert.alert(ok ? 'Success' : 'VCU Tanker In', (resp && resp.message) || 'Done.');
      if (ok) resetAll();
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---------- Full-screen camera (replaces the form while capturing) ----------
  if (cameraOpen) {
    if (!camDevice || !hasCamPermission) {
      return (
        <View style={styles.camFallback}>
          <Text style={styles.camFallbackText}>
            {hasCamPermission ? 'No camera available on this device.' : 'Camera permission is required.'}
          </Text>
          <TouchableOpacity style={styles.camClose} onPress={() => setCameraOpen(false)}>
            <Text style={styles.camCloseText}>Close</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <Camera ref={camRef} style={StyleSheet.absoluteFill} device={camDevice} isActive photo />
        <View style={styles.camBar}>
          <TouchableOpacity onPress={() => setCameraOpen(false)} style={styles.camSideBtn}>
            <Text style={styles.camSideText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={takePhoto} style={styles.shutter} activeOpacity={0.8}>
            <Image source={CAMERA_ICON} style={styles.shutterIcon} resizeMode="contain" />
            <Text style={styles.shutterText}>Capture</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setIsFrontCamera(p => !p)} style={styles.camSideBtn}>
            <Text style={styles.camSideText}>Flip</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const kv = (label, value) => (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
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

        {/* ---------- OUT details (read-only, fills in after scan) ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Tanker OUT Details</Text>
          {kv('Route No', outInfo && outInfo.route_no ? String(outInfo.route_no) : '-')}
          <View style={styles.kvDivider} />
          {kv('Pump Health', (outInfo && OKNOK_TEXT[outInfo.pump_health]) || '-')}
          <View style={styles.kvDivider} />
          {kv('Initialization Status', (outInfo && OKNOK_TEXT[outInfo.ini_status]) || '-')}
        </View>

        {/* ---------- Sample Details (IN) ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sample Details (IN)</Text>

              <Text style={styles.label}>No. of DCS <Text style={styles.req}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={dcsNo}
                onChangeText={t => setDcsNo(sanitizeDigits(t))}
                placeholder="0"
                placeholderTextColor="#9AA0AA"
                keyboardType="number-pad"
                maxLength={6}
              />

              <Text style={[styles.label, styles.fieldGap]}>No. of Full Samples <Text style={styles.req}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={fullSample}
                onChangeText={t => setFullSample(sanitizeDigits(t))}
                placeholder="0"
                placeholderTextColor="#9AA0AA"
                keyboardType="number-pad"
                maxLength={6}
              />

              <Text style={[styles.label, styles.fieldGap]}>No. of Less Samples <Text style={styles.req}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={lessSample}
                onChangeText={t => setLessSample(sanitizeDigits(t))}
                placeholder="0"
                placeholderTextColor="#9AA0AA"
                keyboardType="number-pad"
                maxLength={6}
              />

              <Text style={[styles.label, styles.fieldGap]}>No. of Empty Samples <Text style={styles.req}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={emptySample}
                onChangeText={t => setEmptySample(sanitizeDigits(t))}
                placeholder="0"
                placeholderTextColor="#9AA0AA"
                keyboardType="number-pad"
                maxLength={6}
              />

              {/* ---------- Sample photo ---------- */}
              <Text style={[styles.label, styles.fieldGap]}>Sample Photo <Text style={styles.req}>*</Text></Text>
              {photoUri ? (
                <View style={styles.photoWrap}>
                  <Image source={{ uri: photoUri }} style={styles.photo} resizeMode="cover" />
                  <TouchableOpacity style={styles.retakeBtn} onPress={openCamera} activeOpacity={0.85}>
                    <Image source={CAMERA_ICON} style={styles.retakeIcon} />
                    <Text style={styles.retakeText}>Retake</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.photoTile} onPress={openCamera} activeOpacity={0.85}>
                  <Image source={CAMERA_ICON} style={styles.photoTileIcon} />
                  <Text style={styles.photoTileText}>Tap to capture sample photo</Text>
                </TouchableOpacity>
              )}

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
                  <Text style={styles.buttonText}>Save Tanker IN</Text>
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

  // Read-only OUT details
  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  kvLabel: { fontSize: 14, color: COLORS.mediumText, fontWeight: '600' },
  kvValue: { fontSize: 15, color: COLORS.darkText, fontWeight: '700' },
  kvDivider: { height: 1, backgroundColor: COLORS.line },

  // Sample photo
  photoTile: {
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAFBFC',
  },
  photoTileIcon: { width: 34, height: 34, tintColor: COLORS.primaryRed, marginBottom: 8 },
  photoTileText: { color: COLORS.mediumText, fontSize: 14, fontWeight: '600' },
  photoWrap: { borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: COLORS.inputBorder },
  photo: { width: '100%', height: 220, backgroundColor: '#000' },
  retakeBtn: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 50,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  retakeIcon: { width: 16, height: 16, tintColor: '#FFFFFF', marginRight: 6 },
  retakeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },

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

  // Camera overlay (same look as DIL Entry)
  camBar: {
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
  },
  shutter: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primaryRed,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 50,
  },
  shutterIcon: { width: 20, height: 20, tintColor: '#FFFFFF' },
  shutterText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15, marginLeft: 9 },
  camSideBtn: { padding: 12 },
  camSideText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  camFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#000' },
  camFallbackText: { color: '#FFFFFF', fontSize: 15, textAlign: 'center', marginBottom: 20 },
  camClose: { backgroundColor: COLORS.primaryRed, borderRadius: 50, paddingVertical: 12, paddingHorizontal: 30 },
  camCloseText: { color: '#FFFFFF', fontWeight: '700' },
});

export default VcuTankerInScreen;
