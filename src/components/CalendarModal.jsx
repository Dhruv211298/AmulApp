import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import { COLORS } from '../theme';

// -----------------------------------------------------------------------------
// CalendarModal — a DATE picker backed by the native OS picker
// (@react-native-community/datetimepicker). Same prop contract the app already
// used with the previous custom calendar, so every screen keeps working:
//
//   visible      bool    — when it turns true the picker opens
//   value        Date    — the currently selected date (defaults to today)
//   onConfirm    (Date)  — called with the chosen date (time stripped to 00:00)
//   onClose      ()      — called on cancel / dismiss
//   title        string  — shown above the iOS picker (Android uses its own UI)
//   maximumDate  Date    — latest selectable date (optional)
//   minimumDate  Date    — earliest selectable date (optional)
//
// Android has no inline picker, so it opens the system date dialog imperatively
// as soon as `visible` becomes true. iOS shows the native inline calendar in a
// small sheet with Cancel / Done.
// -----------------------------------------------------------------------------

const stripTime = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const CalendarModal = ({
  visible,
  value,
  onConfirm,
  onClose,
  title,
  maximumDate,
  minimumDate,
}) => {
  const base = value ? new Date(value) : new Date();
  const [draft, setDraft] = useState(base);

  // Re-seed the draft each time the picker is (re)opened.
  useEffect(() => {
    if (visible) setDraft(value ? new Date(value) : new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ---- Android: open the system dialog imperatively on `visible` ----
  const androidOpenRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!visible) {
      androidOpenRef.current = false;
      return;
    }
    if (androidOpenRef.current) return; // guard against double-open
    androidOpenRef.current = true;
    DateTimePickerAndroid.open({
      value: value ? new Date(value) : new Date(),
      mode: 'date',
      is24Hour: true,
      maximumDate: maximumDate ? new Date(maximumDate) : undefined,
      minimumDate: minimumDate ? new Date(minimumDate) : undefined,
      onChange: (event, picked) => {
        androidOpenRef.current = false;
        if (event.type === 'set' && picked) {
          onConfirm(stripTime(picked));
        } else {
          onClose && onClose();
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Android renders no UI of its own — the native dialog is the whole picker.
  if (Platform.OS === 'android') return null;

  // ---- iOS: native inline calendar inside a small sheet ----
  return (
    <Modal
      visible={!!visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={() => onClose && onClose()}
    >
      <Pressable style={styles.backdrop} onPress={() => onClose && onClose()}>
        <Pressable style={styles.card} onPress={() => {}}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          <DateTimePicker
            value={draft}
            mode="date"
            display="inline"
            accentColor={COLORS.primaryRed}
            themeVariant="light"
            maximumDate={maximumDate ? new Date(maximumDate) : undefined}
            minimumDate={minimumDate ? new Date(minimumDate) : undefined}
            onChange={(e, d) => {
              if (d) setDraft(d);
            }}
            style={styles.picker}
          />
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.btn, styles.btnCancel]}
              onPress={() => onClose && onClose()}
              activeOpacity={0.8}
            >
              <Text style={styles.btnCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnOk]}
              onPress={() => onConfirm(stripTime(draft))}
              activeOpacity={0.8}
            >
              <Text style={styles.btnOkText}>Done</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.darkText,
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  // iOS inline/graphical picker needs an explicit height or it collapses to
  // zero and the modal shows an empty gap between the title and the buttons.
  picker: { alignSelf: 'stretch', height: 350 },
  btnRow: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingTop: 10,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EDEDED',
  },
  btn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  btnCancel: {
    borderWidth: 1.5,
    borderColor: COLORS.inputBorder,
    marginRight: 8,
    backgroundColor: '#FFFFFF',
  },
  btnCancelText: { color: COLORS.darkText, fontSize: 15, fontWeight: '700' },
  btnOk: { backgroundColor: COLORS.primaryRed, marginLeft: 8 },
  btnOkText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});

export default CalendarModal;
