import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Image,
  TextInput,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import { COLORS } from '../theme';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

const QR_ICON = require('../assets/qr_scan.png');

const SCAN_CODE_TYPES = ['qr', 'ean-13', 'ean-8', 'code-128', 'code-39', 'code-93'];

// ---------------------------------------------------------------------------
// CVCC Medicine Stock — native replacement for the CVCC branch of the old
// hybrid store page.
//
//   Shows the current medicine stock held by a doctor. Usually reached from the
//   Material Stock screen after a CVCC QR is scanned (the doctor code is passed
//   as route param `matno`), but it can also scan on its own: a CVCC QR is
//   resolved to its doctor code and fetched; any non-CVCC QR is rejected here.
// ---------------------------------------------------------------------------
const CvccMedicineScreen = ({ route }) => {
  const paramMatno = (route && route.params && route.params.matno) ? String(route.params.matno) : '';

  const [loginUserId, setLoginUserId] = useState('');
  const [userPlant, setUserPlant] = useState('');

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [matno, setMatno] = useState(paramMatno);
  const [period, setPeriod] = useState(null); // { from, to }
  const [rows, setRows] = useState(null); // array | null
  const [query, setQuery] = useState(''); // free-text filter over the medicine rows

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [id, plant] = await Promise.all([
        getItem(KEYS.userId),
        getItem(KEYS.plantCode),
      ]);
      if (!mounted) return;
      if (id) setLoginUserId(String(id).trim());
      if (plant) setUserPlant(String(plant).trim().toUpperCase());
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const fetchMedicine = useCallback(async doctorCode => {
    const code = String(doctorCode || '').trim();
    if (!code) return;
    setQuery('');
    setIsLoading(true);
    try {
      const resp = await apiPost(
        ENDPOINTS.cvccMedicineStock,
        { rtype: 1, matno: code },
        { timeoutMs: 45000 },
      );
      if (!(resp && String(resp.statusCode) === '200')) {
        Alert.alert('Medicine Stock', (resp && resp.message) || 'Could not load medicine stock.');
        setRows([]);
        return;
      }
      setMatno(code);
      setPeriod({ from: String(resp.from_date || ''), to: String(resp.to_date || '') });
      setRows(Array.isArray(resp.rows) ? resp.rows : []);
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Auto-load when a doctor code was handed in from the Material Stock screen.
  useEffect(() => {
    if (paramMatno) {
      fetchMedicine(paramMatno);
    }
  }, [paramMatno, fetchMedicine]);

  // Scan on this screen: resolve the QR; only a CVCC code is valid here.
  const resolveScan = async raw => {
    setIsResolving(true);
    try {
      const resp = await apiPost(ENDPOINTS.storeMaterialStock, {
        rtype: 1,
        qrcode_id: raw,
        plant_name: userPlant,
      });
      if (!(resp && String(resp.statusCode) === '200')) {
        Alert.alert('Invalid QR', (resp && resp.message) || 'This QR could not be resolved.');
        return;
      }
      if (Number(resp.is_cvcc) !== 1) {
        Alert.alert('Not a CVCC Code', 'This is not a CVCC medicine QR. Use the Material Stock screen for store materials.');
        return;
      }
      await fetchMedicine(String(resp.material || ''));
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsResolving(false);
    }
  };

  const onQrScanned = useCallback(
    async scannedValue => {
      setIsScannerOpen(false);
      const raw = String(scannedValue || '').trim();
      if (!raw) {
        Alert.alert(MSG.QR_UNREADABLE.title, MSG.QR_UNREADABLE.message);
        return;
      }
      if (!loginUserId) {
        Alert.alert(MSG.SESSION_MISSING.title, MSG.SESSION_MISSING.message);
        return;
      }
      setRows(null);
      setPeriod(null);
      await resolveScan(raw);
    },
    [loginUserId, userPlant],
  );

  const busy = isResolving || isLoading;

  // Free-text filter over the medicine rows (code / name / centre).
  const q = query.trim().toLowerCase();
  const visibleRows = rows
    ? (q
        ? rows.filter(r =>
            [r.medicine_code, r.medicine_name, r.center]
              .some(x => String(x || '').toLowerCase().includes(q)))
        : rows)
    : null;

  return (
    <LinearGradient colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']} style={{ flex: 1 }}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---------- Scan ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>CVCC Medicine Stock</Text>
          <Text style={styles.help}>
            Scan a CVCC medicine QR to view the doctor's current medicine stock.
          </Text>
          <TouchableOpacity
            style={[styles.scanBtn, busy && { opacity: 0.6 }]}
            onPress={() => setIsScannerOpen(true)}
            disabled={busy}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Scan CVCC medicine QR"
          >
            {isResolving ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Checking…</Text>
              </View>
            ) : (
              <>
                <Image source={QR_ICON} style={styles.qrImg} />
                <Text style={styles.scanBtnText}>Scan Medicine QR</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ---------- Loading ---------- */}
        {isLoading && (
          <View style={styles.card}>
            <View style={styles.centerRow}>
              <ActivityIndicator size="small" color={COLORS.primaryRed} />
              <Text style={styles.centerText}>Loading medicine stock…</Text>
            </View>
          </View>
        )}

        {/* ---------- Summary ---------- */}
        {!isLoading && rows && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Summary</Text>
            <View style={styles.kvRow}>
              <Text style={styles.kvLabel}>Doctor Code</Text>
              <Text style={[styles.kvValue, styles.kvValueStrong]}>{matno || '-'}</Text>
            </View>
            {period && (period.from || period.to) ? (
              <>
                <View style={styles.kvDivider} />
                <View style={styles.kvRow}>
                  <Text style={styles.kvLabel}>Period</Text>
                  <Text style={styles.kvValue}>{period.from} → {period.to}</Text>
                </View>
              </>
            ) : null}
            <View style={styles.kvDivider} />
            <View style={styles.kvRow}>
              <Text style={styles.kvLabel}>Items</Text>
              <Text style={styles.kvValue}>{rows.length}</Text>
            </View>
          </View>
        )}

        {/* ---------- Search ---------- */}
        {!isLoading && rows && rows.length > 0 && (
          <>
            <View style={styles.searchCard}>
              <Text style={styles.searchIcon}>⌕</Text>
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search medicine, code, centre…"
                placeholderTextColor="#9AA0AA"
                autoCorrect={false}
                returnKeyType="search"
              />
              {query ? (
                <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.searchClear}>✕</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.countText}>
              Showing {visibleRows.length} of {rows.length} item{rows.length === 1 ? '' : 's'}
            </Text>
          </>
        )}

        {/* ---------- Rows ---------- */}
        {!isLoading && rows && rows.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.emptyText}>No medicine stock found.</Text>
          </View>
        )}

        {!isLoading && rows && rows.length > 0 && visibleRows.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.emptyText}>No medicine matches “{query}”.</Text>
          </View>
        )}

        {!isLoading &&
          visibleRows &&
          visibleRows.length > 0 &&
          visibleRows.map((r, i) => (
            <View style={styles.card} key={`${r.medicine_code}-${i}`}>
              <View style={styles.rowHeader}>
                <Text style={styles.rowHeaderName} numberOfLines={2}>
                  {r.medicine_name || r.medicine_code}
                </Text>
                {r.center ? <Text style={styles.rowHeaderBadge}>{r.center}</Text> : null}
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.kvLabel}>Medicine Code</Text>
                <Text style={[styles.kvValue, styles.kvValueStrong]}>{r.medicine_code || '-'}</Text>
              </View>
              <View style={styles.kvDivider} />
              <View style={styles.kvRow}>
                <Text style={styles.kvLabel}>Close Qty</Text>
                <Text style={[styles.kvValue, styles.grandValue]}>
                  {r.close_qty}{r.close_unit ? ` ${r.close_unit}` : ''}
                </Text>
              </View>
            </View>
          ))}
      </ScrollView>

      {isScannerOpen && (
        <ScannerBoundary
          onClose={() => setIsScannerOpen(false)}
          message="The scanner couldn't start on this device. Please try again."
        >
          <QrScanner
            visible
            hint="Align the CVCC medicine QR code within the frame"
            codeTypes={SCAN_CODE_TYPES}
            onClose={() => setIsScannerOpen(false)}
            onScanned={onQrScanned}
            onTimeout={() => {
              setIsScannerOpen(false);
              Alert.alert(MSG.SCAN_TIMEOUT.title, MSG.SCAN_TIMEOUT.message);
            }}
          />
        </ScannerBoundary>
      )}
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
    marginBottom: 12,
  },
  help: { color: COLORS.mediumText, fontSize: 13, lineHeight: 19, marginBottom: 16 },

  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 14,
  },
  scanBtnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15, marginLeft: 9 },
  qrImg: { width: 20, height: 20, tintColor: '#FFFFFF' },
  btnBusyRow: { flexDirection: 'row', alignItems: 'center' },
  btnBusyText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, marginLeft: 10 },

  centerRow: { flexDirection: 'row', alignItems: 'center' },
  centerText: { marginLeft: 8, color: COLORS.muted, fontSize: 14 },

  searchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  searchIcon: { fontSize: 18, color: COLORS.muted, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: COLORS.darkText, paddingVertical: 12 },
  searchClear: { fontSize: 15, color: COLORS.muted, fontWeight: '800', paddingHorizontal: 4 },
  countText: { color: COLORS.muted, fontSize: 12, fontWeight: '700', marginBottom: 12, marginLeft: 4 },

  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
  },
  kvLabel: { fontSize: 14, color: COLORS.mediumText, fontWeight: '600', flexShrink: 0, marginRight: 12 },
  kvValue: { fontSize: 15, color: COLORS.darkText, fontWeight: '700', flex: 1, textAlign: 'right' },
  kvValueStrong: { color: COLORS.primaryRed },
  kvDivider: { height: 1, backgroundColor: COLORS.line },
  grandValue: { fontSize: 18, fontWeight: '900', color: COLORS.primaryRed },

  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  rowHeaderName: { flex: 1, fontSize: 15, fontWeight: '800', color: COLORS.darkText, marginRight: 10 },
  rowHeaderBadge: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryRed,
    backgroundColor: COLORS.redTint,
    borderRadius: 50,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  emptyText: { color: COLORS.mediumText, fontSize: 14, textAlign: 'center', paddingVertical: 8 },
});

export default CvccMedicineScreen;
