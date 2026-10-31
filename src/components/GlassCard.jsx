import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from '@react-native-community/blur';

// ---------------------------------------------------------------------------
// GlassCard — a frosted-glass surface that is SAFE and looks correct on both
// platforms, built from four stacked layers inside one clipped shell:
//
//   1. BlurView   real native backdrop blur (UIVisualEffectView on iOS, a
//                 snapshot-based blur on Android)
//   2. tint       white wash over the blur. PLATFORM-TUNED: iOS blur is
//                 strong, so a light 0.50 tint keeps the glass lively;
//                 Android blur is weaker (especially on emulators), so a
//                 milkier 0.68 tint carries the frosted look even when the
//                 blur underneath contributes little.
//   3. topEdge    1.5pt white highlight along the top rim — the classic
//                 "light catching the edge of the glass" cue.
//   4. children   the actual content, above everything.
//
// FAILURE SAFETY: the BlurView renders inside an error boundary. If the
// native module is missing or throws on some device, the boundary swaps in a
// near-opaque white layer — the card silently becomes the crisp solid version
// instead of crashing the screen or rendering see-through. Same recovery
// pattern as ScannerBoundary.jsx.
//
// Shadow note: the drop shadow lives on the OUTER wrapper because a clipped
// view (overflow:'hidden') swallows its own shadow. No Android elevation —
// elevation paints its shadow BEHIND the view, which muddies translucent
// glass; on Android the dark hairline border provides the separation.
// ---------------------------------------------------------------------------

class BlurBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (__DEV__) {
      console.warn('[GlassCard] BlurView failed, using solid fallback:', error?.message);
    }
  }

  render() {
    if (this.state.failed) {
      // Near-opaque card — the design's non-blur variant.
      return <View style={[StyleSheet.absoluteFill, styles.solidFallback]} />;
    }
    return this.props.children;
  }
}

const TINT = Platform.select({
  ios: 'rgba(255,255,255,0.50)',
  android: 'rgba(255,255,255,0.78)',
});

const BLUR_AMOUNT = 12;

// ANDROID: no BlurView at all. Its Android implementation snapshots the whole
// window — INCLUDING the card's own text and logo — so every element gets a
// blurred ghost of itself painted behind it (the "shadow on all text" bug).
// Tint-only glass has no snapshot, no ghosting, and the background orbs show
// through cleanly. iOS keeps the real thing: UIVisualEffectView is a true
// backdrop blur and never touches foreground content.
const GlassCard = ({ style, contentStyle, children }) => (
  <View style={[styles.shadow, style]}>
    <View style={styles.shell}>
      {Platform.OS === 'ios' && (
        <BlurBoundary>
          <BlurView
            style={StyleSheet.absoluteFill}
            blurType="light"
            blurAmount={BLUR_AMOUNT}
            overlayColor="transparent"
            reducedTransparencyFallbackColor="#FFFFFF"
          />
        </BlurBoundary>
      )}
      <View style={styles.tint} pointerEvents="none" />
      <View style={styles.topEdge} pointerEvents="none" />
      <View style={contentStyle}>{children}</View>
    </View>
  </View>
);

const styles = StyleSheet.create({
  // Shadow removed by request — the card is fully flat; definition comes from
  // the hairline border and the tint alone.
  shadow: {
    width: '100%',
    borderRadius: 28,
  },
  shell: {
    borderRadius: 28,
    overflow: 'hidden',
    // Dark hairline, not white: on a light canvas a white border vanishes and
    // the card loses its boundary (the exact problem this replaces).
    borderWidth: 1,
    borderColor: 'rgba(16,24,40,0.08)',
    width: '100%',
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: TINT,
  },
  topEdge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  solidFallback: {
    backgroundColor: 'rgba(255,255,255,0.96)',
  },
});

export default GlassCard;
