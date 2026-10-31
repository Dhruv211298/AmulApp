import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
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

// A store QR is either a numeric location code or a delimited
// "<plant>;<x>;<material>" string, so allow the common 1D/2D symbologies the
// old Store app accepted (not QR only).
const SCAN_CODE_TYPES = ['qr', 'ean-13', 'ean-8', 'code-128', 'code-39', 'code-93'];

// ---------------------------------------------------------------------------
// Material Stock (SAP) — native replacement for the old hybrid store page.
//
//   Scan a material/location QR -> the server RESOLVES it to plant / material /
//   SAP section (or flags a CVCC code). A CVCC code hands off to the CVCC
//   Medicine screen; anything else fetches live SAP batch stock for that
//   material, already filtered to what this user's section is allowed to see,
//   and shows it batch-by-batch with U/Q/B totals.
// ---------------------------------------------------------------------------
const MaterialStockScreen = ({ navigation }) => {
  const [loginUserId, setLoginUserId] = useState('');
  const [userPlant, setUserPlant] = useState(''); // used to resolve a NUMERIC QR

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [info, setInfo] = useState(null); // { plant, material, section }
  const [rows, setRows] = useState(null); // array | null (null = nothing scanned yet)
  const [totals, setTotals] = useState(null);
  const [query, setQuery] = useState(''); // free-text filter over the batch rows

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

  const resetResult = () => {
    setInfo(null);
    setRows(null);
    setTotals(null);
    setQuery('');
  };

  // Fetch the live material stock for a resolved (plant, material, section).
  const fetchStock = async resolved => {
    setIsLoading(true);
    try {
      const resp = await apiPost(
        ENDPOINTS.storeMaterialStock,
        {
          rtype: 2,
          plant: resolved.plant,
          matno: resolved.material,
          sapsection: resolved.section || '',
          userid: loginUserId,
        },
        { timeoutMs: 45000 }, // SAP RFC round-trip can be slow
      );
      if (!(resp && String(resp.statusCode) === '200')) {
        Alert.alert('Material Stock', (resp && resp.message) || 'Could not load stock.');
        return;
      }
      setInfo({ plant: resolved.plant, material: resolved.material, section: resolved.section || '' });
      setRows(Array.isArray(resp.rows) ? resp.rows : []);
      setTotals(resp.totals || null);
    } catch (e) {
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Resolve a scanned QR, then branch: CVCC -> medicine screen; else -> stock.
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
      if (Number(resp.is_cvcc) === 1) {
        // Hand the doctor code to the CVCC medicine screen.
        navigation.navigate('CvccMedicine', { matno: String(resp.material || '') });
        return;
      }
      await fetchStock({
        plant: String(resp.plant || ''),
        material: String(resp.material || ''),
        section: String(resp.section || ''),
      });
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
      resetResult();
      await resolveScan(raw);
    },
    [loginUserId, userPlant],
  );

  const busy = isResolving || isLoading;

  // Free-text filter over the batch rows (material / name / batch / location / UoM).
  const q = query.trim().toLowerCase();
  const visibleRows = rows
    ? (q
        ? rows.filter(r =>
            [r.material, r.name, r.batch, r.location, r.uom]
              .some(x => String(x || '').toLowerCase().includes(q)))
        : rows)
    : null;

  const kv = (label, value, strong) => (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, strong && styles.kvValueStrong]} numberOfLines={2}>
        {value === '' || value === null || value === undefined ? '-' : String(value)}
      </Text>
    </View>
  );

  return (
    // Standard app background: soft red-to-white gradient, transparent cards.
    <LinearGradient colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']} style={{ flex: 1 }}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---------- Scan ---------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Material Stock</Text>
          <TouchableOpacity
            style={[styles.scanBtn, busy && { opacity: 0.6 }]}
            onPress={() => setIsScannerOpen(true)}
            disabled={busy}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Scan material QR"
          >
            {isResolving ? (
              <View style={styles.btnBusyRow}>
                <ActivityIndicator color="#FFF" />
                <Text style={styles.btnBusyText}>Checking…</Text>
              </View>
            ) : (
              <>
                <Image source={QR_ICON} style={styles.qrImg} />
                <Text style={styles.scanBtnText}>Scan Material QR</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ---------- Loading ---------- */}
        {isLoading && (
          <View style={styles.card}>
            <View style={styles.centerRow}>
              <ActivityIndicator size="small" color={COLORS.primaryRed} />
              <Text style={styles.centerText}>Loading live stock from SAP…</Text>
            </View>
          </View>
        )}

        {/* ---------- Result header + totals ---------- */}
        {!isLoading && info && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Stock Summary</Text>
            {kv('Plant', info.plant)}
            <View style={styles.kvDivider} />
            {kv('Material', info.material, true)}
            <View style={styles.kvDivider} />
            {kv('Section', info.section || 'All')}
            {totals && (
              <>
                <View style={styles.totalsDivider} />
                {kv('Total Stock (U)', totals.stock_u, true)}
                {kv('Total Stock (Q)', totals.stock_q, true)}
                {kv('Total Stock (B)', totals.stock_b, true)}
                <View style={styles.kvDivider} />
                <View style={styles.kvRow}>
                  <Text style={[styles.kvLabel, styles.grandLabel]}>Total Stock</Text>
                  <Text style={[styles.kvValue, styles.grandValue]}>{totals.total}</Text>
                </View>
              </>
            )}
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
                placeholder="Search material, batch, location…"
                placeholderTextColor="#9AA0AA"
                autoCorrect={false}
                autoCapitalize="characters"
                returnKeyType="search"
              />
              {query ? (
                <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.searchClear}>✕</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.countText}>
              Showing {visibleRows.length} of {rows.length} batch{rows.length === 1 ? '' : 'es'}
            </Text>
          </>
        )}

        {/* ---------- Batch rows ---------- */}
        {!isLoading && rows && rows.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.emptyText}>No stock found for this material.</Text>
          </View>
        )}

        {!isLoading && rows && rows.length > 0 && visibleRows.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.emptyText}>No batch matches “{query}”.</Text>
          </View>
        )}

        {!isLoading &&
          visibleRows &&
          visibleRows.length > 0 &&
          visibleRows.map((r, i) => (
            <View style={styles.card} key={`${r.material}-${r.batch}-${r.location}-${i}`}>
              <View style={styles.rowHeader}>
                <Text style={styles.rowHeaderName} numberOfLines={2}>
                  {r.name || r.material}
                </Text>
                <Text style={styles.rowHeaderBadge}>{r.location || '-'}</Text>
              </View>
              {kv('Material', r.material, true)}
              <View style={styles.kvDivider} />
              {kv('Batch', r.batch)}
              <View style={styles.kvDivider} />
              {kv('UoM', r.uom)}
              <View style={styles.kvDivider} />
              {kv('Stock (U)', r.stock_u, true)}
              {kv('Stock (Q)', r.stock_q)}
              {kv('Stock (B)', r.stock_b)}
              <View style={styles.kvDivider} />
              {kv('Stock Age', r.age)}
              {kv('Received Date', r.rec_date)}
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
            hint="Align the material / location QR code within the frame"
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
  totalsDivider: { height: 1, backgroundColor: 'rgba(227,0,27,0.25)', marginVertical: 6 },
  grandLabel: { fontSize: 15, fontWeight: '800', color: COLORS.darkText },
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

export default MaterialStockScreen;
