import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, ActivityIndicator } from 'react-native';
import { checkAppVersion } from '../services/version';
import { loadRemoteConfig } from '../services/remoteConfig';
import { getItem, KEYS } from '../services/storage';

const SplashScreen = ({ navigation }) => {
  const scaleValue = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(scaleValue, { toValue: 1.2, duration: 1000, useNativeDriver: true }),
        Animated.timing(scaleValue, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    ).start();

    // Check the app version (server-controlled) alongside a short splash delay.
    //
    // HARDENED: the splash must be INCAPABLE of hanging. Every await is inside
    // a try/catch, the version call is time-bounded in services/version.js,
    // and any failure falls through to the Login screen. An unreachable server
    // may cost a few seconds — never an infinite spinner (this exact hang was
    // App Store rejection 2.1(a): "App loaded indefinitely during login").
    const checkUserAndNavigate = async () => {
      let version = null;
      try {
        // Hydrate cached server tunables first (fast local read, never throws)
        // so location policy uses the last approved values even offline.
        await loadRemoteConfig();
        [version] = await Promise.all([
          checkAppVersion(), // fail-open + 10s timeout internally
          new Promise(resolve => setTimeout(resolve, 2500)),
        ]);
      } catch (e) {
        version = null; // treat any unexpected failure as "not blocked"
      }

      // Below the server's minimum version -> force update, block everything else.
      if (version && version.blocked) {
        navigation.replace('UpdateRequired', {
          message: version.message,
          updateUrl: version.updateUrl,
          current: version.current,
        });
        return;
      }

      let mode = 'register';
      try {
        const hasPin = await getItem(KEYS.userPin);
        mode = hasPin ? 'login' : 'register';
      } catch (e) {
        // Storage failure — register mode is the safe landing.
      }
      navigation.replace('Login', { mode });
    };

    checkUserAndNavigate();
  }, []);

  return (
    <View style={styles.container}>
      {/* Ensure you have this image in src/assets/ */}
      <Animated.Image
        source={require('../assets/Amul_Logo.png')} 
        style={[styles.logo, { transform: [{ scale: scaleValue }] }]}
        resizeMode="contain"
      />
      <ActivityIndicator size="large" color="#E3001B" />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  logo: { width: 200, height: 120, marginBottom: 30 },
});

export default SplashScreen;