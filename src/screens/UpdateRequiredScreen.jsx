import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Linking,
  BackHandler,
  Platform,
  Alert,
} from 'react-native';
import { COLORS } from '../theme';

const LOGO = require('../assets/Amul_Logo.png');

// Hard-coded store fallbacks. This screen is a non-dismissible gate (back is
// blocked, no back stack), so its ONE button must always do something — even
// when the server's version response omitted the update URL.
const STORE_FALLBACK_URL = Platform.select({
  ios: 'https://apps.apple.com/app/id6795424483',
  android: 'https://play.google.com/store/apps/details?id=com.amulapp',
});

// Full-screen, non-dismissible "update required" gate. Reached from Splash when
// the installed version is below the server's min_version.
const UpdateRequiredScreen = ({ route }) => {
  const { message, updateUrl, current } = (route && route.params) || {};

  // Block Android hardware back so the gate can't be bypassed.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const openStore = () => {
    const target = updateUrl || STORE_FALLBACK_URL;
    Linking.openURL(target).catch(() => {
      Alert.alert(
        'Could not open the store',
        'Please update Amul Common App from the App Store / Play Store manually.',
      );
    });
  };

  return (
    <View style={styles.container}>
      <Image source={LOGO} style={styles.logo} resizeMode="contain" />

      <View style={styles.badge}>
        <Text style={styles.badgeText}>NEW VERSION AVAILABLE</Text>
      </View>

      <Text style={styles.title}>Update Required</Text>
      <Text style={styles.message}>
        {message || 'Please update to the latest version to continue using the app.'}
      </Text>

      <TouchableOpacity style={styles.btn} onPress={openStore} activeOpacity={0.85}>
        <Text style={styles.btnText}>Update Now</Text>
      </TouchableOpacity>

      {!!current && <Text style={styles.current}>Installed version {current}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  logo: { width: 150, height: 150, marginBottom: 26 },
  badge: {
    backgroundColor: COLORS.redTint,
    borderRadius: 50,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 16,
  },
  badgeText: {
    color: COLORS.primaryRed,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    fontSize: 15,
    color: COLORS.mediumText,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  btn: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 15,
    paddingHorizontal: 48,
  },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  current: { marginTop: 22, fontSize: 12, color: COLORS.muted },
});

export default UpdateRequiredScreen;
