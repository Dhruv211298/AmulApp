import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { COLORS } from '../theme';

// Error boundary for the camera scanner.
//
// react-native-vision-camera throws during render if the native module isn't
// ready (permission revoked mid-session, camera held by another app, emulator
// with no camera). Without a boundary that takes down the whole screen, so any
// screen mounting <QrScanner> should wrap it in this.
//
// Props:
//   onClose   () => void     dismiss the fallback (required)
//   message   string         optional override for the body copy, so a screen
//                            can offer its own recovery hint (e.g. "enter the
//                            code manually" where a manual field exists)
const DEFAULT_MESSAGE =
  "The QR scanner couldn't start on this device. Please try again, or check the camera permission in Settings.";

class ScannerBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (__DEV__) {
      console.warn('[ScannerBoundary] camera failed to start:', error);
    }
  }

  render() {
    const { failed } = this.state;
    const { onClose, message, children } = this.props;

    if (!failed) return children;

    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.backdrop}>
          <View style={styles.box}>
            <Text style={styles.title}>Camera unavailable</Text>
            <Text style={styles.msg}>{message || DEFAULT_MESSAGE}</Text>
            <TouchableOpacity style={styles.btn} onPress={onClose}>
              <Text style={styles.btnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  box: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 22,
    width: '100%',
    maxWidth: 340,
  },
  title: { fontSize: 18, fontWeight: '800', color: COLORS.darkText },
  msg: {
    fontSize: 14,
    color: COLORS.mediumText,
    marginTop: 10,
    lineHeight: 20,
  },
  btn: {
    alignSelf: 'flex-end',
    marginTop: 18,
    backgroundColor: COLORS.primaryRed,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 50,
  },
  btnText: { color: '#FFFFFF', fontWeight: '700' },
});

export default ScannerBoundary;
