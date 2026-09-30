import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, ScrollView } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { getItem, KEYS } from '../services/storage';
import useResponsive from '../hooks/useResponsive';

// Welcome image on the dashboard. Referenced with a lowercase .png extension:
// Metro's asset resolver only recognises lowercase image extensions, so an
// uppercase ".PNG" in require() fails to resolve. Make sure the file on disk is
// also named amul_welcome_icon.png (lowercase) for case-sensitive release builds.
const LOGO = require('../assets/amul_welcome_icon.png');

const greetingForHour = hour => {
  if (hour >= 5 && hour < 12) return 'Good Morning';
  if (hour >= 12 && hour < 17) return 'Good Afternoon';
  return 'Good Evening';
};

const DashboardScreen = () => {
  const [userName, setUserName] = useState('User');
  const [greeting, setGreeting] = useState('');

  // FULLY DYNAMIC LAYOUT (codebase rule: no fixed layout dimensions — see
  // hooks/useResponsive.js). Everything derives from the live window: the
  // mascot and type scale off the SHORTER edge (stable through rotation),
  // landscape switches to a side-by-side layout, and the ScrollView is the
  // final safety net so nothing can ever clip.
  const { shortEdge, isLandscape, clamp, scale } = useResponsive();
  // The welcome image is a WIDE BANNER (native 1678x937), not a square. Size it
  // by width and derive height from its native aspect ratio, so it fills the
  // space and scales the same on every device instead of sitting small inside a
  // square box. clamp keeps it sensible from tiny phones to large tablets.
  const LOGO_ASPECT = 1678 / 937; // native width / height (~1.79)
  const logoWidth = clamp(shortEdge * (isLandscape ? 0.62 : 0.86), 240, 560);
  const logoHeight = logoWidth / LOGO_ASPECT;
  const greetingSize = clamp(shortEdge * 0.075, 24, 32);
  const nameSize = clamp(shortEdge * 0.1, 30, 42);

  useEffect(() => {
    (async () => {
      const name = await getItem(KEYS.userName);
      setUserName(name || 'User');
    })();
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  return (
    <LinearGradient
      colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']} // Soft Amul red tint at top
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: scale(32), paddingVertical: scale(24) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.content, isLandscape && styles.contentLandscape]}>
          <Image
            source={LOGO}
            style={{ width: logoWidth, height: logoHeight }}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel="Amul mascot"
          />

          <View
            style={[
              styles.textBlock,
              { marginTop: isLandscape ? 0 : scale(24) },
              isLandscape && [styles.textBlockLandscape, { marginLeft: scale(40) }],
            ]}
          >
            <Text style={[styles.greeting, { fontSize: greetingSize }]}>
              {greeting},
            </Text>
            <Text style={[styles.userName, { fontSize: nameSize, marginTop: scale(8) }]}>
              {userName}
            </Text>
            <View
              style={[
                styles.accent,
                { width: scale(48), height: scale(4), marginTop: scale(18) },
              ]}
            />
          </View>
        </View>
      </ScrollView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Dimensions are applied inline from useResponsive (codebase rule: no fixed
  // layout dimensions). Only colors, weights, alignment and flex live here.
  // flexGrow + center = vertically centred when there's room, scrollable when
  // there isn't. No percentage paddings anywhere.
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  content: {
    alignItems: 'center',
  },
  // Landscape: mascot beside the text instead of above it, so the pair uses
  // the wide screen instead of overflowing the short one.
  contentLandscape: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  textBlock: {
    alignItems: 'center',
  },
  // Landscape keeps the side-by-side layout but the text stays CENTRED within
  // its block — the name is centre-aligned in every orientation.
  textBlockLandscape: {
    alignItems: 'center',
  },
  // textAlign:'center' on the Text itself matters, not just the container's
  // alignItems: a long name that wraps to two lines would otherwise have its
  // lines left-aligned inside a centred box.
  greeting: {
    color: '#3A3A3A',
    fontWeight: '500',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  userName: {
    fontWeight: 'bold',
    color: '#E3001B',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  accent: {
    borderRadius: 2,
    backgroundColor: '#E3001B',
  },
});

export default DashboardScreen;
