import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  TextInput,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import { COLORS } from '../theme';
import SelectField from '../components/SelectField';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

// ---------------------------------------------------------------------------
// Material Ack — native replacement for the old WebView store page
// (digi.amuldairy.com/store/material_ack.php + StoreMaterialAck.java).
//
//   A single flat form, same fields and order as the old web page:
//     Inward No. (dropdown)  ->  Supplier Name auto-fills
//     Material Desc (dropdown of that inward's pending lines)
//       -> Qty Received / Packing Details / Remarks auto-fill (read-only)
//     Qty Verified, Godown No., Sampling Details, Receiver Name,
//     Receiver Remarks  ->  Submit.
//   Submitting acknowledges that one line; it drops out of the Material Desc
//   dropdown and the form resets for the next line. When the last line is
//   done the inward clears and the pending-inward list refreshes.
//
//   One endpoint, action chosen by `rtype` (material_ack.php):
//     inwards -> pending inwards   lines -> pending lines   save -> ack a line
// ---------------------------------------------------------------------------

const BLANK_FORM = {
  qty_verified: '',
  godown_no: '',
  sampling_dtl: '',
  receiver_name: '',
  receiver_remarks: '',
};

const MaterialAckScreen = () => {
  const [loginUserId, setLoginUserId] = useState('');

  const [inwards, setInwards] = useState([]); // [{inward_id, inward_no}]
  const [selectedInward, setSelectedInward] = useState(null);

  const [lines, setLines] = useState([]); // pending lines for the chosen inward
  const [supplierName, setSupplierName] = useState('');
  const [selectedLineId, setSelectedLineId] = useState(null);

  const [form, setForm] = useState({ ...BLANK_FORM });

  const [isLoadingInwards, setIsLoadingInwards] = useState(false);
  const [isLoadingLines, setIsLoadingLines] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // ---- load the logged-in employee, then the pending inwards ----
  useEffect(() => {
    let mounted = true;
    (async () => {
      const id = await getItem(KEYS.userId);
      if (!mounted) return;
      if (id) setLoginUserId(String(id).trim());
      loadInwards();
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadInwards = useCallback(async () => {
    setIsLoadingInwards(true);
    try {
      const resp = await apiPost(ENDPOINTS.materialAck, { rtype: 'inwards' });
      if (!(resp && String(resp.statusCode) === '200')) {
        Alert.alert('Material Ack', (resp && resp.message) || 'Could not load pending inwards.');
        return;
      }
      setInwards(Array.isArray(resp.rows) ? resp.rows : []);
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsLoadingInwards(false);
    }
  }, []);

  const loadLines = useCallback(async inwardId => {
    setIsLoadingLines(true);
    setLines([]);
    setSupplierName('');
    setSelectedLineId(null);
    setForm({ ...BLANK_FORM });
    try {
      const resp = await apiPost(ENDPOINTS.materialAck, {
        rtype: 'lines',
        inward_id: inwardId,
      });
      if (!(resp && String(resp.statusCode) === '200')) {
        Alert.alert('Material Ack', (resp && resp.message) || 'Could not load material lines.');
        return;
      }
      const rows = Array.isArray(resp.rows) ? resp.rows : [];
      setLines(rows);
      // Supplier is the inward's (same across its lines) — fill it like the
      // old page did on inward change.
      setSupplierName(rows.length ? String(rows[0].supplier_name || '') : '');
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsLoadingLines(false);
    }
  }, []);

  const onInwardChange = item => {
    const id = item && item.value != null ? String(item.value) : null;
    setSelectedInward(id);
    setSelectedLineId(null);
    setForm({ ...BLANK_FORM });
    if (id) {
      loadLines(id);
    } else {
      setLines([]);
      setSupplierName('');
    }
  };

  const onMaterialChange = item => {
    const id = item && item.value != null ? String(item.value) : null;
    setSelectedLineId(id);
    // Switching material clears only the user-entered verify fields; the
    // read-only Qty/Packing/Remarks come from the selected line itself.
    setForm({ ...BLANK_FORM });
  };

  const setField = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const selectedLine = lines.find(l => String(l.line_id) === String(selectedLineId)) || null;

  const submit = () => {
    if (!selectedInward) {
      Alert.alert('Material Ack', 'Please select an Inward No.');
      return;
    }
    if (!selectedLine) {
      Alert.alert('Material Ack', 'Please select a Material Desc.');
      return;
    }
    if (form.qty_verified.trim() === '' || isNaN(Number(form.qty_verified))) {
      Alert.alert('Material Ack', 'Enter a valid Qty Verified.');
      return;
    }
    if (Number(form.qty_verified) < 0) {
      Alert.alert('Material Ack', 'Qty Verified cannot be negative.');
      return;
    }
    const required = [
      ['Godown No.', form.godown_no],
      ['Sampling Details', form.sampling_dtl],
      ['Receiver Name', form.receiver_name],
      ['Receiver Remarks', form.receiver_remarks],
    ];
    for (const [label, val] of required) {
      if (String(val).trim() === '') {
        Alert.alert('Material Ack', `Please enter ${label}.`);
        return;
      }
    }

    Alert.alert(
      'Confirm Acknowledgement',
      `Acknowledge "${selectedLine.material_code} - ${selectedLine.material_desc}" with verified qty ${form.qty_verified}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Acknowledge', style: 'default', onPress: doSave },
      ],
    );
  };

  const doSave = async () => {
    const line = selectedLine;
    if (!line) return;
    setIsSaving(true);
    try {
      const resp = await apiPost(ENDPOINTS.materialAck, {
        rtype: 'save',
        line_id: line.line_id,
        qty_verified: String(form.qty_verified).trim(),
        godown_no: form.godown_no.trim(),
        sampling_dtl: form.sampling_dtl.trim(),
        receiver_name: form.receiver_name.trim(),
        receiver_remarks: form.receiver_remarks.trim(),
      });
      if (!(resp && String(resp.statusCode) === '200')) {
        Alert.alert('Material Ack', (resp && resp.message) || 'Could not save the acknowledgement.');
        return;
      }
      // Drop the acknowledged line and reset the form for the next one.
      const next = lines.filter(l => l.line_id !== line.line_id);
      setLines(next);
      setSelectedLineId(null);
      setForm({ ...BLANK_FORM });
      if (next.length === 0) {
        // Inward fully acknowledged — clear it and refresh the inward list.
        setSelectedInward(null);
        setSupplierName('');
        loadInwards();
      }
      Alert.alert('Material Ack', resp.message || 'Saved.');
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const inwardOptions = inwards.map(i => ({
    value: String(i.inward_id),
    label: String(i.inward_no),
  }));

  // Material Desc dropdown — code in red + "desc [unit]" as the name, same
  // text the old page's <option> showed.
  const materialOptions = lines.map(l => ({
    value: String(l.line_id),
    code: l.material_code,
    name: `${l.material_desc}${l.unit ? ` [${l.unit}]` : ''}`,
  }));

  // Read-only field (grey) — Supplier / Qty Received / Packing / Remarks.
  const readField = (label, value) => (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.readBox}>
        <Text style={styles.readText} numberOfLines={2}>
          {value === '' || value === null || value === undefined ? '' : String(value)}
        </Text>
      </View>
    </View>
  );

  // Editable field — the receiver-entered values.
  const editField = (key, label, placeholder, opts = {}) => (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>
        {label} <Text style={styles.req}>*</Text>
      </Text>
      <TextInput
        style={styles.input}
        value={form[key]}
        onChangeText={t => setField(key, t)}
        placeholder={placeholder}
        placeholderTextColor="#9AA0AA"
        keyboardType={opts.numeric ? 'numeric' : 'default'}
        autoCapitalize={opts.caps || 'sentences'}
        autoCorrect={false}
        multiline={!!opts.multiline}
      />
    </View>
  );

  return (
    // Standard app background: soft red-to-white gradient, transparent card.
    <LinearGradient colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']} style={{ flex: 1 }}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Material Acknowledgement</Text>

          {/* Inward No. */}
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Inward No.</Text>
            {isLoadingInwards ? (
              <View style={styles.centerRow}>
                <ActivityIndicator size="small" color={COLORS.primaryRed} />
                <Text style={styles.centerText}>Loading pending inwards…</Text>
              </View>
            ) : (
              <SelectField
                data={inwardOptions}
                value={selectedInward}
                placeholder="Select Inward No."
                onChange={onInwardChange}
                search
                title="Select Inward No."
                searchPlaceholder="Search inward no…"
              />
            )}
            {!isLoadingInwards && inwardOptions.length === 0 && (
              <Text style={styles.emptyText}>No pending inwards in the last 2 days.</Text>
            )}
          </View>

          {/* Supplier Name (auto-filled, read-only) */}
          {readField('Supplier Name', supplierName)}

          {/* Material Desc */}
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Material Desc</Text>
            {isLoadingLines ? (
              <View style={styles.centerRow}>
                <ActivityIndicator size="small" color={COLORS.primaryRed} />
                <Text style={styles.centerText}>Loading material lines…</Text>
              </View>
            ) : (
              <SelectField
                data={materialOptions}
                value={selectedLineId}
                placeholder="Select Material Desc"
                onChange={onMaterialChange}
                search
                title="Select Material Desc"
                searchPlaceholder="Search material…"
              />
            )}
            {!isLoadingLines && selectedInward && lines.length === 0 && (
              <Text style={styles.emptyText}>No pending material lines for this inward.</Text>
            )}
          </View>

          {/* Read-only details of the selected line */}
          {readField('Qty Received', selectedLine ? selectedLine.qty : '')}
          {readField('Packing Details', selectedLine ? selectedLine.pack_dtl : '')}
          {readField('Remarks', selectedLine ? selectedLine.remarks : '')}

          {/* Receiver-entered fields */}
          {editField('qty_verified', 'Qty Verified', 'Qty Verified', { numeric: true })}
          {editField('godown_no', 'Godown No.', 'Godown No.', { caps: 'characters' })}
          {editField('sampling_dtl', 'Sampling Details', 'Sampling Details')}
          {editField('receiver_name', 'Receiver Name', 'Receiver Name', { caps: 'words' })}
          {editField('receiver_remarks', 'Receiver Remarks', 'Receiver Remarks', { multiline: true })}

          <TouchableOpacity
            style={[styles.submitBtn, isSaving && { opacity: 0.6 }]}
            onPress={submit}
            disabled={isSaving}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Submit material acknowledgement"
          >
            {isSaving ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Saving…</Text>
              </View>
            ) : (
              <Text style={styles.submitBtnText}>Submit</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: 'transparent',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(227,0,27,0.40)',
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 16,
  },

  centerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  centerText: { marginLeft: 8, color: COLORS.muted, fontSize: 14 },
  emptyText: { color: COLORS.mediumText, fontSize: 13, paddingTop: 8 },

  fieldBlock: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, color: COLORS.mediumText, fontWeight: '700', marginBottom: 7 },
  req: { color: COLORS.primaryRed },

  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: COLORS.darkText,
    minHeight: 48,
  },
  // Read-only fields: greyed, same footprint as an input.
  readBox: {
    backgroundColor: '#EEF0F3',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    justifyContent: 'center',
    minHeight: 48,
  },
  readText: { fontSize: 15, color: COLORS.darkText, fontWeight: '600' },

  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
    marginTop: 6,
  },
  submitBtnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  btnBusyRow: { flexDirection: 'row', alignItems: 'center' },
  btnBusyText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 10 },
});

export default MaterialAckScreen;
