import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { getSession, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import { COLORS } from '../theme';

// Profile is built entirely from locally-stored session data — no network needed.
const ProfileScreen = () => {
  const [session, setSession] = useState(null);
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    let mounted = true;
    // HARDENED: a storage failure must render the profile with "—" values,
    // never strand the user on a spinner (this screen's data is 100% local,
    // so there is nothing to wait for).
    getSession()
      .then(s => mounted && setSession(s || {}))
      .catch(() => mounted && setSession({}));
    getDeviceId()
      .then(id => mounted && setDeviceId(id))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  if (!session) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primaryRed} />
      </View>
    );
  }

  const name = session[KEYS.userName] || 'User';
  const initials = name.trim().charAt(0).toUpperCase() || 'U';
  const typeLabel =
    session[KEYS.userType] === 'e'
      ? 'Employee'
      : session[KEYS.userType] === 's'
      ? 'Student'
      : '—';

  // A session is "active" whenever the account is registered/authorised on this
  // device. Students are issued an EMPTY api_token by design, so this must NOT be
  // keyed on the token (that always showed "No" for students) — use the
  // registration flag, which is set for every logged-in user.
  const isActive =
    session[KEYS.isRegistered] === 'true' || !!session[KEYS.userId];

  const infoRows = [
    { label: 'User ID', value: session[KEYS.userId] || '—' },
    { label: 'Name', value: name },
    { label: 'Account type', value: typeLabel },
  ];

  const deviceRows = [
    {
      label: 'Device ID',
      value: deviceId || session[KEYS.deviceId] || '—',
      selectable: true,
    },
    { label: 'Session active', value: isActive ? 'Yes' : 'No' },
  ];

  const renderCard = rows => (
    <View style={styles.card}>
      {rows.map((r, i) => (
        <View
          key={r.label}
          style={[styles.row, i === rows.length - 1 && styles.rowLast]}
        >
          <Text style={styles.rowLabel}>{r.label}</Text>
          <Text style={styles.rowValue} selectable={!!r.selectable}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.hero}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.sub}>{typeLabel}</Text>
      </View>

      {renderCard(infoRows)}

      <Text style={styles.sectionTitle}>DEVICE & SESSION</Text>
      {renderCard(deviceRows)}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F7F9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F6F7F9' },
  hero: { alignItems: 'center', paddingVertical: 32, backgroundColor: '#FFFFFF' },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: COLORS.primaryRed,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  avatarText: { color: '#FFF', fontSize: 36, fontWeight: 'bold' },
  name: { fontSize: 22, fontWeight: '700', color: COLORS.darkText },
  sub: { fontSize: 14, color: COLORS.muted, marginTop: 4 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 22,
    marginBottom: 8,
    marginHorizontal: 20,
  },
  card: {
    backgroundColor: '#FFFFFF',
    marginTop: 14,
    marginHorizontal: 16,
    borderRadius: 14,
    paddingHorizontal: 18,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { fontSize: 15, color: COLORS.muted },
  rowValue: { fontSize: 15, color: COLORS.darkText, fontWeight: '600', maxWidth: '60%', textAlign: 'right' },
});

export default ProfileScreen;
