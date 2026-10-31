import React from 'react';
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';

// SafeAreaProvider MUST wrap the app so every SafeAreaView / useSafeAreaInsets
// (sidebar header, top bar, etc.) gets the real device insets. Without it, iOS
// resolves the notch/Dynamic Island inset to zero and headers render too high.
//
// `initialMetrics` matters just as much. Without it the provider reports zero
// insets until it has measured its own layout, so anything rendered on the very
// first frame — the Dashboard header, reached via navigation.replace right after
// login — paints underneath the status bar and only corrects itself a frame
// later (or not at all, if it never re-renders). initialWindowMetrics is read
// synchronously from the native side at startup, so the correct insets are
// available immediately.
const App = () => {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppNavigator />
    </SafeAreaProvider>
  );
};

export default App;
