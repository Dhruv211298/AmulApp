import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  StatusBar,
} from 'react-native';
import { COLORS } from '../theme';
import useSafeTopInset from '../hooks/useSafeTopInset';
import LogoutIcon from './LogoutIcon';

const LOGO = require('../assets/Amul_Logo.png');

// Simple user icon drawn with views (head + shoulders).
const UserIcon = ({ color }) => (
  <View style={styles.userIconWrap}>
    <View style={[styles.userHead, { backgroundColor: color }]} />
    <View style={[styles.userBody, { backgroundColor: color }]} />
  </View>
);

// "<" chevron, mirrored from the menu one.
const BackChevron = ({ color }) => (
  <View style={[styles.backMark, { borderColor: color }]} />
);

// `onBack` is optional. When provided (portal pages that have in-page history)
// a Back arrow appears to the left of the title. iOS has no hardware back
// button, so without this control there is no way out of a second page.
const Topbar = ({ title, onMenuPress, onProfile, onLogout, onBack }) => {
  // Explicit padding rather than <SafeAreaView edges={['top']}>: the bar is
  // white and sits at the very top of an edge-to-edge window, so if the inset
  // ever resolves to 0 the logo lands under the punch hole / Dynamic Island.
  // See src/hooks/useSafeTopInset.js for why that happens.
  const topInset = useSafeTopInset();

  return (
    <View style={[styles.safeArea, { paddingTop: topInset }]}>
      {/* Dark icons — the bar behind them is white on every screen. */}
      <StatusBar
        barStyle="dark-content"
        backgroundColor="transparent"
        translucent
      />
      <View style={styles.container}>
        <View style={styles.leftContainer}>
          {/* Menu opener: standalone logo + a bigger arrow inside a small pill */}
          <TouchableOpacity
            onPress={onMenuPress}
            style={styles.menuBtn}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Open menu"
          >
            <Image source={LOGO} style={styles.logo} resizeMode="contain" />
            <View style={styles.chevronPill}>
              <View style={styles.chevronMark} />
            </View>
          </TouchableOpacity>

          <View style={styles.divider} />

          {onBack && (
            <TouchableOpacity
              onPress={onBack}
              style={styles.backBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <BackChevron color={COLORS.primaryRed} />
            </TouchableOpacity>
          )}

          <Text style={styles.title} numberOfLines={1}>
            {title || 'Amul App'}
          </Text>
        </View>

        <View style={styles.rightContainer}>
          <TouchableOpacity
            onPress={onProfile}
            style={styles.profileBtn}
            accessibilityRole="button"
            accessibilityLabel="Profile"
          >
            <UserIcon color={COLORS.primaryRed} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onLogout}
            style={styles.logoutBtn}
            accessibilityRole="button"
            accessibilityLabel="Logout"
          >
            <LogoutIcon size={20} color={COLORS.primaryRed} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#FFFFFF',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 100,
  },
  container: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    backgroundColor: '#FFFFFF',
  },
  leftContainer: { flexDirection: 'row', alignItems: 'center', flex: 1 },

  // Whole thing is tappable; logo is standalone, only the arrow is in a pill.
  menuBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  logo: { width: 48, height: 48 },
  chevronPill: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.primaryRed,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  // ">" chevron drawn from a rotated square's top+right borders (perfectly crisp/centered)
  chevronMark: {
    width: 9,
    height: 9,
    borderTopWidth: 2.5,
    borderRightWidth: 2.5,
    borderColor: '#FFFFFF',
    transform: [{ rotate: '45deg' }],
    marginLeft: -2,
  },

  divider: {
    width: 1,
    height: 24,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 12,
  },

  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.redTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  // "<" drawn from a rotated square's top+left borders.
  backMark: {
    width: 9,
    height: 9,
    borderTopWidth: 2.5,
    borderLeftWidth: 2.5,
    transform: [{ rotate: '-45deg' }],
    marginLeft: 3,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.primaryRed,
    letterSpacing: 0.5,
    flexShrink: 1,
  },

  rightContainer: { flexDirection: 'row', alignItems: 'center' },
  profileBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.redTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  userIconWrap: { alignItems: 'center', justifyContent: 'center' },
  userHead: { width: 9, height: 9, borderRadius: 4.5, marginBottom: 2 },
  userBody: {
    width: 16,
    height: 9,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  logoutBtn: { padding: 8, backgroundColor: COLORS.redTint, borderRadius: 8 },
});

export default Topbar;
