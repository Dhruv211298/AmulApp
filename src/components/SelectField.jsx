import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Pressable,
  TextInput,
  ScrollView,
} from 'react-native';
import { COLORS } from '../theme';

// ---------------------------------------------------------------------------
// SelectField — the app's standard dropdown, styled like the DIL Entry page:
// a tappable field that opens a CENTERED modal card with an optional search box
// and a scrollable list of option rows (code in red + name), plus a
// "Clear Selection" row at the bottom once something is chosen.
//
// Props:
//   data        = [{ value, code?, name?, label? }]
//   value       currently selected value
//   placeholder shown on the field when nothing is selected
//   onChange(item)  item.value is null when cleared
//   search      show the search box (default false)
//   title       modal heading (default "Select")
//   searchPlaceholder   (default "Search…")
//   clearable   show the clear row (default true)
// ---------------------------------------------------------------------------
const SelectField = ({
  data = [],
  value,
  placeholder,
  onChange,
  search = false,
  title = 'Select',
  searchPlaceholder = 'Search…',
  clearable = true,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(
    () => data.find(d => String(d.value) === String(value)),
    [data, value],
  );
  const selLabel = selected
    ? selected.label ||
      (selected.code
        ? `${selected.code}${selected.name ? ' - ' + selected.name : ''}`
        : String(selected.value))
    : '';

  const filtered = useMemo(() => {
    if (!search || !query.trim()) return data;
    const q = query.trim().toLowerCase();
    return data.filter(d =>
      `${d.code || ''} ${d.name || ''} ${d.label || ''}`.toLowerCase().includes(q),
    );
  }, [data, search, query]);

  const openList = () => {
    setQuery('');
    setOpen(true);
  };

  return (
    <>
      <TouchableOpacity
        style={styles.dropdown}
        onPress={openList}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={placeholder}
      >
        <Text
          style={selected ? styles.dropdownSelected : styles.dropdownPlaceholder}
          numberOfLines={1}
        >
          {selected ? selLabel : placeholder}
        </Text>
        <View style={styles.caret} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.pickerBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.pickerPanel} onPress={() => {}}>
            <Text style={styles.pickerTitle}>{title}</Text>

            {search && (
              <TextInput
                style={styles.pickerSearch}
                value={query}
                onChangeText={setQuery}
                placeholder={searchPlaceholder}
                placeholderTextColor="#9AA0AA"
                autoCorrect={false}
                returnKeyType="search"
              />
            )}

            <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
              {data.length === 0 ? (
                <Text style={styles.pickerEmpty}>No options available.</Text>
              ) : filtered.length === 0 ? (
                <Text style={styles.pickerEmpty}>No match found.</Text>
              ) : (
                filtered.map((item, i) => {
                  const active = String(item.value) === String(value);
                  return (
                    <TouchableOpacity
                      key={String(item.value) + i}
                      style={[styles.optionRow, active && styles.optionRowActive]}
                      onPress={() => {
                        onChange(item);
                        setOpen(false);
                      }}
                      activeOpacity={0.7}
                    >
                      {item.code ? <Text style={styles.optionCode}>{String(item.code)}</Text> : null}
                      <Text
                        style={item.code ? styles.optionName : styles.optionNameSolo}
                        numberOfLines={2}
                      >
                        {String(item.name || item.label || '')}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}

              {clearable && selected ? (
                <TouchableOpacity
                  style={styles.optionClear}
                  onPress={() => {
                    onChange({ label: '', value: null });
                    setOpen(false);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Clear ${placeholder}`}
                >
                  <Text style={styles.optionClearIcon}>✕</Text>
                  <Text style={styles.optionClearText}>Clear Selection</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 13,
    minHeight: 48,
  },
  dropdownSelected: { flex: 1, fontSize: 15, color: COLORS.darkText, fontWeight: '600' },
  dropdownPlaceholder: { flex: 1, fontSize: 15, color: '#9AA0AA' },
  // "v" triangle chevron pointing down (same as DIL Entry).
  caret: {
    width: 0,
    height: 0,
    marginLeft: 10,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: COLORS.muted,
  },

  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  pickerPanel: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: 16,
    maxHeight: '70%',
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.darkText,
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  pickerSearch: {
    marginHorizontal: 14,
    marginBottom: 10,
    height: 44,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: COLORS.darkText,
    backgroundColor: '#FAFAFA',
  },
  pickerList: { paddingHorizontal: 8 },
  pickerEmpty: {
    fontSize: 13,
    color: COLORS.muted,
    textAlign: 'center',
    paddingVertical: 18,
    paddingHorizontal: 12,
    lineHeight: 18,
  },
  optionRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F0F0F0',
  },
  optionRowActive: { backgroundColor: COLORS.redTint },
  optionCode: { fontSize: 13, fontWeight: '800', color: COLORS.primaryRed },
  optionName: { fontSize: 14, color: COLORS.darkText, marginTop: 2, lineHeight: 19 },
  optionNameSolo: { fontSize: 15, color: COLORS.darkText, lineHeight: 20, fontWeight: '500' },
  optionClear: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 12,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: COLORS.inputBorder,
  },
  optionClearIcon: { color: COLORS.primaryRed, fontSize: 15, fontWeight: '800', marginRight: 8 },
  optionClearText: { color: COLORS.primaryRed, fontSize: 14, fontWeight: '700' },
});

export default SelectField;
