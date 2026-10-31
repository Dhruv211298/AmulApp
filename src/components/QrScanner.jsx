import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Animated,
  Easing,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Path } from 'react-native-svg';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { COLORS } from '../theme';

// Crisp vector "switch camera" icon (a camera with two circular arrows), drawn
// with SVG so it scales cleanly — the old Unicode glyph rendered as a broken
// little ring on the device.
// Clean two circular-arrows "switch" icon (Feather refresh-cw geometry) — a
// simple, well-proven shape that renders crisply at small sizes, unlike the
// Unicode glyph and the fiddly camera outline it replaces.
const FlipCameraIcon = ({ size = 16, color = '#FFFFFF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M23 4v6h-6M1 20v-6h6"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);
import useSafeTopInset from '../hooks/useSafeTopInset';
import useResponsive from '../hooks/useResponsive';
// Opens the app's system settings page (despite the location-flavoured name).
import { openLocationSettings } from '../services/location';

const SCAN_TIMEOUT_MS = 60000; // auto-close after 60s of no scan (time, not layout)

// Full-screen QR scanner modal.
// Which code formats to read. Default is QR only, so existing callers are
// unchanged; pass a wider list (e.g. barcodes) via the codeTypes prop.
// Module-level constant => stable identity, so the frame processor isn't
// reconfigured on every render.
const DEFAULT_CODE_TYPES = ['qr'];

// Props: visible, onClose(), onScanned(value), hint (optional prompt text),
//        onTimeout (optional — called if nothing scanned in timeoutMs), timeoutMs,
//        codeTypes (optional array of vision-camera code types; default QR only)
const QrScanner = ({
  visible,
  onClose,
  onScanned,
  hint,
  onTimeout,
  timeoutMs = SCAN_TIMEOUT_MS,
  codeTypes = DEFAULT_CODE_TYPES,
}) => {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Back camera by default; the user can flip to the front camera when the back
  // one misbehaves (dirty/blocked lens, autofocus stuck). Both device handles
  // are resolved up front (hooks can't be conditional) and the active one is
  // picked from `position`; the flip control only appears when both exist.
  const [position, setPosition] = useState('back');
  const backDevice = useCameraDevice('back');
  const frontDevice = useCameraDevice('front');
  const device = position === 'front' ? frontDevice : backDevice;
  const canFlip = !!backDevice && !!frontDevice;
  // StatusBar.currentHeight is Android-only — on iOS it is undefined, so the old
  // constant silently fell back to 24 and pushed the scanner hint under the
  // notch / Dynamic Island. The shared hook resolves the real inset on both.
  const topInset = useSafeTopInset();
  const lockRef = useRef(false);
  const timerRef = useRef(null);
  const scanAnim = useRef(new Animated.Value(0)).current;

  // FULLY DYNAMIC LAYOUT — no fixed layout constants anywhere in this
  // component (codebase rule; see hooks/useResponsive.js). The frame sizes
  // off the shorter window edge so the square + hint + Cancel button always
  // fit, in any orientation, on any device; every other dimension derives
  // from the frame or from scale(), so the whole overlay re-proportions
  // itself the instant the window changes.
  const { shortEdge, isLandscape, scale } = useResponsive();
  const frame = Math.round(Math.min(scale(260), shortEdge * (isLandscape ? 0.52 : 0.65)));
  const corner = Math.round(frame * 0.14); // bracket arms ~14% of frame
  const bar = Math.round(frame * 0.11); // scan glow height ~11% of frame

  useEffect(() => {
    if (visible) {
      lockRef.current = false;
      // Always start a fresh open on the back camera, even if the user flipped
      // to the front on the previous scan.
      setPosition('back');
      if (!hasPermission) {
        requestPermission().catch(() => {});
      }
    }
  }, [visible, hasPermission, requestPermission]);

  const flipCamera = () => setPosition(p => (p === 'front' ? 'back' : 'front'));

  const ready = hasPermission && device;

  // Sweep the scan line up and down while the camera is active.
  useEffect(() => {
    if (ready && visible) {
      scanAnim.setValue(0);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scanAnim, {
            toValue: 1,
            duration: 2000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(scanAnim, {
            toValue: 0,
            duration: 2000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
  }, [ready, visible, scanAnim]);

  // Travel distance follows the live frame size, so the sweep stays inside the
  // frame at any orientation.
  const translateY = scanAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, frame - bar],
  });

  // Latest callbacks, held in refs so the timeout effect below does NOT depend
  // on their identity.
  //
  // This is the fix for a real bug. Callers pass onTimeout/onClose as inline
  // arrow functions, so a NEW function object is created on every render. When
  // those were in the effect's dependency array, every re-render tore the
  // effect down — clearing the pending timer — and started a fresh countdown.
  //
  // On Meeting Attendance nothing re-renders while the scanner is open, so the
  // timer survived and the timeout worked. But QR Attendance and QR Code Visit
  // run a LIVE GPS watch: setCoords fires every second or two, the screen
  // re-renders, and the 60s timer was restarted from zero each time. It could
  // therefore never elapse, and the scanner stayed open indefinitely.
  //
  // Reading through refs means the effect runs exactly once per scanner
  // opening, while the callbacks it invokes are always the current ones.
  const onTimeoutRef = useRef(onTimeout);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
    onCloseRef.current = onClose;
  });

  // Auto-timeout: if nothing is scanned within `timeoutMs`, stop and notify.
  // Deps are only the values that should genuinely restart the countdown —
  // the camera becoming ready, the modal opening, or a changed limit.
  useEffect(() => {
    if (ready && visible) {
      timerRef.current = setTimeout(() => {
        if (!lockRef.current) {
          lockRef.current = true; // block any late scan
          if (onTimeoutRef.current) onTimeoutRef.current();
          else if (onCloseRef.current) onCloseRef.current();
        }
      }, timeoutMs);
      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }
  }, [ready, visible, timeoutMs]);

  const codeScanner = useCodeScanner({
    codeTypes,
    onCodeScanned: codes => {
      if (lockRef.current) return; // fire only once per open
      const value = codes && codes[0] ? codes[0].value : null;
      if (value) {
        lockRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current); // cancel timeout on success
        onScanned(value);
      }
    },
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {ready && (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={visible}
            codeScanner={codeScanner}
          />
        )}

        {ready ? (
          <View
            style={[
              styles.overlay,
              {
                paddingTop: topInset + (isLandscape ? scale(8) : scale(24)),
                paddingBottom: isLandscape ? scale(16) : scale(50),
                paddingHorizontal: scale(24),
              },
            ]}
            pointerEvents="box-none"
          >
            <View style={styles.topBar}>
              <Text style={[styles.hint, { fontSize: scale(16) }]}>
                {hint || 'Align the QR code within the frame'}
              </Text>

              {canFlip && (
                <TouchableOpacity
                  style={[
                    styles.flipBtn,
                    { marginTop: scale(14), paddingHorizontal: scale(18), paddingVertical: scale(9) },
                  ]}
                  onPress={flipCamera}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={position === 'front' ? 'Switch to back camera' : 'Switch to front camera'}
                >
                  <View style={{ marginRight: 7 }}>
                    <FlipCameraIcon size={scale(18)} color="#FFFFFF" />
                  </View>
                  <Text style={[styles.flipText, { fontSize: scale(13) }]}>
                    {position === 'front' ? 'Back Camera' : 'Front Camera'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={[styles.frame, { width: frame, height: frame }]}>
              {/* Moving scan line — NOT clipped (its travel is bounded by the
                  animation range). Promoted to a hardware texture so it paints
                  reliably over the native camera on Android. */}
              <Animated.View
                renderToHardwareTextureAndroid
                style={[styles.scanBar, { height: bar, transform: [{ translateY }] }]}
                pointerEvents="none"
              >
                <LinearGradient
                  colors={['rgba(255,31,48,0)', 'rgba(255,31,48,0.6)', 'rgba(255,31,48,0)']}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.scanLine} />
              </Animated.View>

              {/* Corner brackets — sized from the live frame */}
              <View style={[styles.corner, styles.tl, { width: corner, height: corner }]} />
              <View style={[styles.corner, styles.tr, { width: corner, height: corner }]} />
              <View style={[styles.corner, styles.bl, { width: corner, height: corner }]} />
              <View style={[styles.corner, styles.br, { width: corner, height: corner }]} />
            </View>

            <TouchableOpacity
              style={[
                styles.cancelBtn,
                { paddingHorizontal: scale(46), paddingVertical: scale(13) },
              ]}
              onPress={onClose}
              activeOpacity={0.85}
            >
              <Text style={[styles.cancelText, { fontSize: scale(15) }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.permWrap}>
            <Text style={styles.msg}>
              {!device
                ? 'No camera available on this device.'
                : 'Camera permission is required to scan the QR code.'}
            </Text>
            {!hasPermission && (
              <>
                <TouchableOpacity
                  style={styles.permBtn}
                  onPress={() => requestPermission().catch(() => {})}
                >
                  <Text style={styles.permText}>Grant Permission</Text>
                </TouchableOpacity>
                {/* Escape hatch for "Don't ask again": the OS silently ignores
                    further requests, so without this link the button appears
                    dead and the user has no path forward. */}
                <TouchableOpacity onPress={openLocationSettings} style={styles.permCancel}>
                  <Text style={styles.permCancelText}>Open Settings to allow camera</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity style={styles.permCancel} onPress={onClose}>
              <Text style={styles.permCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  // All paddings/sizes are applied inline from useResponsive (codebase rule:
  // no fixed layout dimensions). Only colors, weights and flex live here.
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBar: {
    alignItems: 'center',
  },
  hint: {
    color: '#FFFFFF',
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  flipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 50,
  },
  flipText: { color: '#FFFFFF', fontWeight: '700' },

  // width/height applied inline from the responsive `frame` value.
  frame: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    borderRadius: 18,
    overflow: 'visible',
  },
  scanBar: {
    position: 'absolute',
    top: 0,
    left: 6,
    right: 6,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  scanLine: {
    height: 5,
    borderRadius: 3,
    backgroundColor: '#FF1F30', // bright solid red — clearly visible
  },

  corner: {
    position: 'absolute',
    borderColor: COLORS.primaryRed,
  },
  tl: { top: -2, left: -2, borderTopWidth: 5, borderLeftWidth: 5, borderTopLeftRadius: 18 },
  tr: { top: -2, right: -2, borderTopWidth: 5, borderRightWidth: 5, borderTopRightRadius: 18 },
  bl: { bottom: -2, left: -2, borderBottomWidth: 5, borderLeftWidth: 5, borderBottomLeftRadius: 18 },
  br: { bottom: -2, right: -2, borderBottomWidth: 5, borderRightWidth: 5, borderBottomRightRadius: 18 },

  cancelBtn: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 50,
  },
  cancelText: { color: '#FFFFFF', fontWeight: '700' },

  permWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#000',
  },
  msg: { color: '#FFF', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  permBtn: {
    marginTop: 22,
    backgroundColor: COLORS.primaryRed,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 50,
  },
  permText: { color: '#FFF', fontWeight: '700' },
  permCancel: { marginTop: 18 },
  permCancelText: { color: 'rgba(255,255,255,0.8)', fontSize: 14, fontWeight: '600' },
});

export default QrScanner;
