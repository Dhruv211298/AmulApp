import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Platform,
  Alert,
} from 'react-native';
import { setItem, getItem, clearSession, KEYS } from '../services/storage';
import { clearAttempts } from '../services/pin';
import { COLORS } from '../theme';
import PinInput from '../components/PinInput';
import EyeToggle from '../components/EyeToggle';
import DeviceInfo from 'react-native-device-info';
import {
  getCapability as getBiometricCapability,
  isEnabled as isBiometricEnabled,
  enable as enableBiometric,
  disable as disableBiometric,
  declineOffer as declineBiometric,
  syncPin as syncBiometricPin,
} from '../services/biometrics';

// Real version from the native build (synced from package.json). Single source.
const APP_VERSION = DeviceInfo.getVersion();

const SettingsScreen = ({ navigation }) => {
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  // Biometric row: hidden entirely unless the device can actually do it, so
  // users on older handsets never see a switch that does nothing.
  // `ready` = usable right now. `blocker` explains why not, so the row can tell
  // the user what to fix instead of silently disappearing — see getCapability().
  const [bio, setBio] = useState({
    ready: false,
    label: '',
    enabled: false,
    blocker: null,
    loaded: false,
  });
  const [bioBusy, setBioBusy] = useState(false);
  // Turning biometrics ON opens an inline PIN challenge rather than enrolling
  // straight away — see handleToggleBiometric.
  const [bioConfirmOpen, setBioConfirmOpen] = useState(false);
  const [bioConfirmPin, setBioConfirmPin] = useState('');
  const [bioConfirmError, setBioConfirmError] = useState('');

  const refreshBio = useCallback(async () => {
    try {
      const cap = await getBiometricCapability();
      const enabled = cap.ready ? await isBiometricEnabled() : false;
      setBio({
        ready: cap.ready,
        label: cap.label,
        blocker: cap.blocker,
        enabled,
        loaded: true,
      });
    } catch (e) {
      setBio({ ready: false, label: '', blocker: null, enabled: false, loaded: true });
    }
  }, []);

  useEffect(() => {
    refreshBio();
  }, [refreshBio]);

  // Re-check every time the screen regains focus. The user very often leaves to
  // register a fingerprint in the phone's own Settings and comes straight back;
  // without this they'd return to the same "not set up" message and conclude
  // the app is broken.
  useEffect(() => {
    const unsub = navigation.addListener('focus', refreshBio);
    return unsub;
  }, [navigation, refreshBio]);

  const handleToggleBiometric = async next => {
    if (bioBusy) return;

    if (next) {
      // Turning it ON asks for the PIN first, and does NOT simply read the
      // stored one. Enrolment binds a face or finger to this account
      // permanently, so it must be done by someone who can prove they own the
      // account — not by whoever happens to be holding an already-unlocked
      // phone. This mirrors the login screen, which only ever offers enrolment
      // against a PIN the user has just typed correctly.
      setBioConfirmError('');
      setBioConfirmPin('');
      setBioConfirmOpen(true);
      return;
    }

    // Backing out of the PIN challenge by tapping the Switch again. The Switch
    // reads ON while the panel is open, so this lands in the "off" branch —
    // but nothing was ever enabled, so treat it as Cancel. Running the disable
    // path here would record a 'declined' marker and permanently stop the
    // login screen from ever offering biometrics, on the strength of a toggle
    // the user only half-flipped.
    if (bioConfirmOpen && !bio.enabled) {
      setBioConfirmOpen(false);
      setBioConfirmPin('');
      setBioConfirmError('');
      return;
    }

    setBioBusy(true);
    try {
      setBioConfirmOpen(false);
      await disableBiometric();
      // Remember the choice so the login screen doesn't immediately offer it
      // again the next time they sign in — turning it off in Settings is a
      // clear "no", and re-asking would read as the app ignoring them.
      await declineBiometric();
      await refreshBio();
    } finally {
      setBioBusy(false);
    }
  };

  // Verifies the typed PIN, then seals it. Called by PinInput's onComplete, so
  // the user never has to press an extra button.
  const handleConfirmBiometricPin = async typed => {
    if (bioBusy) return;
    setBioBusy(true);
    try {
      let stored = null;
      try {
        stored = await getItem(KEYS.userPin);
      } catch (e) {}

      if (!stored) {
        setBioConfirmOpen(false);
        Alert.alert('PIN required', 'Set a login PIN first, then turn this on.');
        return;
      }
      if (typed !== stored) {
        // No lockout counter here on purpose: this is not the app's front
        // door, the user is already inside an authenticated session, and a
        // wrong PIN grants nothing. Adding a lock would only let someone
        // sabotage the owner's next login from inside Settings.
        setBioConfirmPin('');
        setBioConfirmError('That PIN is not correct.');
        return;
      }

      const res = await enableBiometric(typed);
      if (res.ok) {
        setBioConfirmOpen(false);
        setBioConfirmPin('');
        setBioConfirmError('');
      } else if (res.reason === 'cancelled') {
        // Backed out of the Android confirm scan. Clear the boxes as well as
        // reopening them — PinInput fires onComplete on a CHANGE to full
        // length, so leaving the four digits in place would make the field
        // inert until the user deleted and retyped one.
        setBioConfirmPin('');
        setBioConfirmError('');
      } else {
        setBioConfirmOpen(false);
        Alert.alert(
          'Not set up',
          `${bio.label} could not be set up on this device. Check that a screen lock and at least one ${bio.label.toLowerCase()} are enrolled in your phone's settings.`,
        );
      }
      await refreshBio();
    } finally {
      setBioBusy(false);
    }
  };

  const handleChangePin = async () => {
    if (!/^\d{4}$/.test(newPin)) {
      return Alert.alert('Invalid PIN', 'PIN must be exactly 4 digits.');
    }
    if (newPin !== confirmPin) {
      return Alert.alert('Mismatch', 'The two PINs do not match.');
    }
    setSaving(true);
    try {
      await setItem(KEYS.userPin, newPin);
      // Deliberately clear any lockout: the user proved they are authorised by
      // getting into Settings, and leaving a lock in place would punish them for
      // a PIN that no longer exists.
      await clearAttempts();

      // Re-seal the new PIN behind biometrics. Without this the keychain would
      // still hold the OLD PIN, and the next Face ID login would hand
      // handleLogin a value that no longer matches — the user's own fingerprint
      // would start counting against the brute-force lockout. No-op when
      // biometrics were never turned on.
      let bioWarning = '';
      try {
        const synced = await syncBiometricPin(newPin);
        if (synced.changed && !synced.ok) {
          bioWarning = ` ${bio.label || 'Biometric'} unlock was switched off — turn it back on below.`;
        }
      } catch (e) {
        // Make the message true before showing it: if the re-seal blew up we
        // don't know what the keychain holds, and a stale sealed PIN would
        // make the user's own finger fail login. Tear it down for real.
        try {
          await disableBiometric();
        } catch (e2) {}
        bioWarning = ' Biometric unlock was switched off — turn it back on below.';
      }
      await refreshBio();

      setNewPin('');
      setConfirmPin('');
      setShowNew(false);
      setShowConfirm(false);
      Alert.alert('Done', `Your login PIN has been updated.${bioWarning}`);
    } catch (e) {
      Alert.alert('Error', 'Could not update PIN. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          // Navigate to Login even if storage clearing fails — a rejected
          // clearSession must not turn the Logout button into a silent no-op.
          try {
            await clearSession();
          } catch (e) {}
          const root = navigation.getParent() || navigation;
          // suppressAutoBiometric — see performLogout() in MainNavigator: the
          // enrolment survives logout, so auto-scanning here would sign the
          // user straight back in.
          root.reset({
            index: 0,
            routes: [
              { name: 'Login', params: { mode: 'login', suppressAutoBiometric: true } },
            ],
          });
        },
      },
    ]);
  };

  // Same 4-cell PIN design as the login screen, with an eye Show/Hide toggle.
  const renderPinField = (value, onChange, isVisible, toggleVisible) => (
    <View style={styles.pinRow}>
      <PinInput
        value={value}
        onChange={onChange}
        length={4}
        secure={!isVisible}
        cellSize={48}
        gap={5}
      />
      <EyeToggle
        visible={isVisible}
        onPress={toggleVisible}
        size={22}
        style={styles.eyeBtn}
      />
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Rendered as soon as the capability check has answered — including when
          the phone CAN do biometrics but the user hasn't registered a face or
          finger yet. Hiding the row in that case is the common mistake: the
          people who most need to be told "set this up in your phone settings"
          are exactly the ones who'd never see it. `loaded` keeps the row from
          flashing in before the async check returns. */}
      {bio.loaded ? (
        <>
          <Text style={styles.sectionTitle}>Quick sign-in</Text>
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <View style={styles.bioTextCol}>
                <Text style={[styles.rowLabel, !bio.ready && styles.rowLabelDim]}>
                  Unlock with {bio.label}
                </Text>
                <Text style={styles.rowSub}>
                  {bio.ready
                    ? `Skip typing your PIN when you sign in. Your PIN still works as a backup, and you'll be asked for it again if the ${bio.label.toLowerCase()} saved on this phone changes.`
                    : bio.blocker === 'no-screen-lock'
                    ? Platform.OS === 'ios'
                      ? 'Set a passcode in iPhone Settings, then set up Face ID or Touch ID, to use this.'
                      : 'Set a screen lock (PIN, pattern or password) in your phone settings, then add a fingerprint, to use this.'
                    : Platform.OS === 'ios'
                    ? 'No Face ID or Touch ID is set up on this iPhone yet. Add one in iPhone Settings and come back — this option will switch on.'
                    : 'No fingerprint or face is registered on this phone yet. Add one in your phone settings and come back — this option will switch on.'}
                </Text>
              </View>
              <Switch
                value={bio.ready && (bio.enabled || bioConfirmOpen)}
                onValueChange={handleToggleBiometric}
                // Off and untouchable until the phone can actually do it. A
                // switch that flips and then silently does nothing is worse
                // than one that plainly can't be moved.
                disabled={bioBusy || !bio.ready}
                trackColor={{ false: '#D8DBE0', true: COLORS.primaryRed }}
                thumbColor={Platform.OS === 'android' ? '#FFFFFF' : undefined}
                ios_backgroundColor="#D8DBE0"
              />
            </View>

            {/* PIN challenge. Appears only while switching ON, and is what
                stops a borrowed unlocked phone from enrolling a stranger. */}
            {bioConfirmOpen && bio.ready && !bio.enabled ? (
              <View style={styles.bioConfirm}>
                <Text style={styles.label}>
                  Enter your login PIN to turn on {bio.label}
                </Text>
                <View style={styles.pinRow}>
                  <PinInput
                    value={bioConfirmPin}
                    onChange={v => {
                      setBioConfirmPin(v);
                      if (bioConfirmError) setBioConfirmError('');
                    }}
                    onComplete={handleConfirmBiometricPin}
                    length={4}
                    secure
                    autoFocus
                    cellSize={48}
                    gap={5}
                  />
                </View>
                {bioConfirmError ? (
                  <Text style={styles.bioConfirmError}>{bioConfirmError}</Text>
                ) : null}
                <TouchableOpacity
                  onPress={() => {
                    setBioConfirmOpen(false);
                    setBioConfirmPin('');
                    setBioConfirmError('');
                  }}
                  style={styles.bioCancel}
                >
                  <Text style={styles.bioCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Security</Text>
      <View style={styles.card}>
        <Text style={styles.label}>New 4-digit PIN</Text>
        {renderPinField(newPin, setNewPin, showNew, () => setShowNew(v => !v))}

        <Text style={styles.label}>Confirm PIN</Text>
        {renderPinField(confirmPin, setConfirmPin, showConfirm, () =>
          setShowConfirm(v => !v),
        )}
        <TouchableOpacity
          style={[styles.button, saving && { opacity: 0.6 }]}
          onPress={handleChangePin}
          disabled={saving}
        >
          <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Update PIN'}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>About</Text>
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.rowLabel}>App version</Text>
          <Text style={styles.rowValue}>{APP_VERSION}</Text>
        </View>
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F7F9' },
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
  card: { backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 14, padding: 18 },
  label: { fontWeight: '600', marginBottom: 10, marginTop: 8, color: '#333' },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  eyeBtn: { marginLeft: 8, paddingHorizontal: 6, paddingVertical: 6 },
  button: {
    backgroundColor: COLORS.primaryRed,
    paddingVertical: 12,
    borderRadius: 50,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonText: { color: '#FFF', fontWeight: 'bold' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { fontSize: 15, color: COLORS.darkText },
  rowLabelDim: { color: COLORS.muted },
  // Let the explanatory text wrap instead of shoving the Switch off-screen on
  // narrow phones or at large system font sizes.
  bioTextCol: { flex: 1, paddingRight: 14 },
  rowSub: { fontSize: 12.5, lineHeight: 18, color: COLORS.muted, marginTop: 5 },
  bioConfirm: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
  },
  bioConfirmError: {
    color: COLORS.primaryRed,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
  },
  bioCancel: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  bioCancelText: { color: COLORS.muted, fontWeight: '600', fontSize: 14 },
  rowValue: { fontSize: 15, color: COLORS.muted, fontWeight: '600' },
  logoutBtn: {
    marginTop: 28,
    marginHorizontal: 16,
    backgroundColor: COLORS.redTint,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  logoutText: { color: COLORS.primaryRed, fontWeight: '700', fontSize: 15 },
});

export default SettingsScreen;
