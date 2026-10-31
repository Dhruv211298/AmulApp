import React, { useEffect, useRef } from 'react';
import { View, Text, Image, Animated, Easing, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

const LOGO = require('../assets/Amul_Logo.png');
const RING = 96;

// Branded full-screen loader: a red ring spinning around the Amul logo, with the
// portal/title and a "LOADING" caption. Solid white background so it fully hides
// whatever is behind it while the page loads.
const BrandLoader = ({ title = 'Amul Portal', caption = 'Loading' }) => {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.overlay}>
      <View style={styles.ringWrap}>
        <Animated.View style={[styles.ring, { transform: [{ rotate }] }]} />
        <View style={styles.logoBadge}>
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
        </View>
      </View>

      <Text style={styles.title}>{title}</Text>
      <View style={styles.dotRow}>
        <View style={styles.dot} />
        <Text style={styles.sub}>{caption}</Text>
        <View style={styles.dot} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    zIndex: 10,
    elevation: 10,
  },
  ringWrap: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  ring: {
    position: 'absolute',
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 4,
    borderColor: '#FBE1E4',
    borderTopColor: COLORS.primaryRed,
  },
  logoBadge: {
    width: RING - 24,
    height: RING - 24,
    borderRadius: (RING - 24) / 2,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primaryRed,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  logo: { width: 50, height: 50 },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.darkText,
    letterSpacing: 0.3,
  },
  dotRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: COLORS.primaryRed,
    marginHorizontal: 7,
  },
  sub: {
    fontSize: 13,
    color: COLORS.muted,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
});

export default BrandLoader;
