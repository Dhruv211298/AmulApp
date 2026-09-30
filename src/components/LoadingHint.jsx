import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

// ---------------------------------------------------------------------------
// LoadingHint — a spinner with STAGED status messages.
//
// Design decision: staged messages, not a countdown timer. A visible timer
// makes users anxious and promises a deadline the network can't guarantee;
// messages that progress ("Loading…" -> "Still working…") reassure the user
// that the app is alive and the wait is expected. This is the pattern large
// consumer apps use for long operations.
//
// Props:
//   visible    bool       show/hide (resets to the first message when shown)
//   messages   string[]   shown in order; the last one persists
//   stepMs     number     how long each message shows (default 6000)
//
// Usage:
//   <LoadingHint
//     visible={loading}
//     messages={['Loading your report…', 'Still working…', 'Large report — almost there…']}
//   />
// ---------------------------------------------------------------------------
const LoadingHint = ({ visible, messages = ['Loading…'], stepMs = 6000 }) => {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!visible) {
      setStep(0); // reset for the next time the loader shows
      return undefined;
    }
    if (step >= messages.length - 1) return undefined; // last message persists
    const timer = setTimeout(() => setStep(s => s + 1), stepMs);
    return () => clearTimeout(timer);
  }, [visible, step, messages.length, stepMs]);

  if (!visible) return null;

  return (
    <View style={styles.wrap}>
      <ActivityIndicator size="large" color={COLORS.primaryRed} />
      <Text style={styles.text}>{messages[Math.min(step, messages.length - 1)]}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', marginTop: 30, paddingHorizontal: 24 },
  text: {
    marginTop: 12,
    fontSize: 13,
    color: COLORS.muted,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 19,
  },
});

export default LoadingHint;
