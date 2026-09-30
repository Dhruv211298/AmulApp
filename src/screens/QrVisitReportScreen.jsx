import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
} from 'react-native';
import { apiPost } from '../services/api';
import { getItem, KEYS } from '../services/storage';
import CalendarModal from '../components/CalendarModal';
import LoadingHint from '../components/LoadingHint';
import { COLORS } from '../theme';
import { ENDPOINTS } from '../config';
import { MSG } from '../constants/messages';

// QR Visit Report — the visit-side twin of QrAttendanceReportScreen. Same
// filter card, date pickers, count line and card list; only the card body
// differs (a visit is a single moment, not a check-in/check-out pair).
const REPORT_URL = ENDPOINTS.qrVisitReport;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const pad = n => String(n).padStart(2, '0');
const toApi = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = d => `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;

// "10:31:51" -> "10:31 AM". Falls back to the raw value for anything that
// doesn't parse, so a backend format change can never blank the column.
const fmtTime = t => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return t || '—';
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
};

const QrVisitReportScreen = () => {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate] = useState(today);
  const [picker, setPicker] = useState(null); // 'from' | 'to' | null

  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const fetchReport = async () => {
    if (fromDate > toDate) {
      Alert.alert('Invalid range', 'The "From" date must be on or before the "To" date.');
      return;
    }
    setLoading(true);
    try {
      const employeeId = await getItem(KEYS.userId);
      // Same generous-but-bounded 60s limit as the attendance report — a long
      // range takes time to build server-side, but never an infinite wait.
      const res = await apiPost(
        REPORT_URL,
        {
          employee_id: employeeId,
          from_date: toApi(fromDate),
          to_date: toApi(toDate),
        },
        { timeoutMs: 60000 },
      );
      if (res && String(res.statusCode) === '200') {
        setRecords(Array.isArray(res.records) ? res.records : []);
      } else {
        setRecords([]);
        Alert.alert('Report', (res && res.message) || 'Could not load the report.');
      }
    } catch (e) {
      setRecords([]);
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setSearched(true);
      setLoading(false);
    }
  };

  // Table layout — three columns per visit: Location | Date | Time.
  // The location column wraps to as many lines as the full name needs (no
  // truncation), while the date and time columns stay fixed-width so every
  // row's columns line up like a real table. Remark, when present, spans the
  // full row width underneath.
  // Cells are Views (not bare Text) because the column separators are drawn
  // with borderRight, and RN renders borders reliably on Views only. The
  // border sits on the CELL, stretching the full row height even when the
  // location wraps to several lines — a border on the text itself would stop
  // at the text's own height and the grid lines would look broken.
  const renderItem = ({ item, index }) => (
    <View style={[styles.row, index % 2 === 1 && styles.rowAlt]}>
      <View style={styles.rowMain}>
        <View style={[styles.cell, styles.cellLocation]}>
          <Text style={styles.colLocation}>{item.location_name || 'Location'}</Text>
        </View>
        <View style={[styles.cell, styles.cellDate]}>
          <Text style={styles.colDate}>{item.date}</Text>
        </View>
        <View style={[styles.cellLast, styles.cellTime]}>
          <Text style={styles.colTime}>{fmtTime(item.time)}</Text>
        </View>
      </View>
      {!!item.remark && (
        <Text style={styles.rowRemark}>Remark: {item.remark}</Text>
      )}
    </View>
  );

  // Column headers — rendered once above the rows, only when there are rows.
  const TableHead = (
    <View style={styles.headRow}>
      <View style={[styles.headCellWrap, styles.cellLocation, styles.headDivider]}>
        <Text style={styles.headCell}>Location</Text>
      </View>
      <View style={[styles.headCellWrap, styles.cellDate, styles.headDivider]}>
        <Text style={styles.headCell}>Date</Text>
      </View>
      <View style={[styles.headCellWrap, styles.cellTime]}>
        <Text style={styles.headCell}>Time</Text>
      </View>
    </View>
  );

  const Header = (
    <View>
      <View style={styles.filterCard}>
        <View style={styles.dateRow}>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>From</Text>
            <TouchableOpacity
              style={styles.dateBtn}
              activeOpacity={0.8}
              onPress={() => setPicker('from')}
            >
              <Text style={styles.dateBtnText}>{toDisplay(fromDate)}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>To</Text>
            <TouchableOpacity
              style={styles.dateBtn}
              activeOpacity={0.8}
              onPress={() => setPicker('to')}
            >
              <Text style={styles.dateBtnText}>{toDisplay(toDate)}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={styles.viewBtn}
          activeOpacity={0.85}
          onPress={fetchReport}
          disabled={loading}
        >
          <Text style={styles.viewBtnText}>
            {loading ? 'Loading…' : 'View Report'}
          </Text>
        </TouchableOpacity>
      </View>

      {searched && !loading && (
        <Text style={styles.countText}>
          {records.length} {records.length === 1 ? 'visit' : 'visits'}
        </Text>
      )}
      {searched && !loading && records.length > 0 && TableHead}
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={records}
        keyExtractor={(item, i) => `${item.location_no}-${item.date}-${item.time}-${i}`}
        renderItem={renderItem}
        ListHeaderComponent={Header}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        ListEmptyComponent={
          loading ? (
            <LoadingHint
              visible={loading}
              messages={[
                'Loading your report…',
                'Fetching your visit records…',
                'Still working — large reports can take a little longer…',
                'Almost there, thank you for waiting…',
              ]}
            />
          ) : searched ? (
            <Text style={styles.empty}>No visits found for this range.</Text>
          ) : (
            <Text style={styles.empty}>
              Pick a date range and tap “View Report”.
            </Text>
          )
        }
      />

      <CalendarModal
        visible={picker === 'from'}
        value={fromDate}
        title="From date"
        maximumDate={toDate}
        onConfirm={d => {
          setFromDate(d);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <CalendarModal
        visible={picker === 'to'}
        value={toDate}
        title="To date"
        maximumDate={today}
        onConfirm={d => {
          setToDate(d);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F7F9' },

  filterCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
  },
  dateRow: { flexDirection: 'row', marginBottom: 14 },
  dateField: { flex: 1, marginHorizontal: 4 },
  dateLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.muted,
    marginBottom: 6,
    letterSpacing: 0.3,
  },
  dateBtn: {
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#FFFFFF',
  },
  dateBtnText: { fontSize: 15, color: COLORS.darkText, fontWeight: '600' },
  viewBtn: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  viewBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },

  countText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.5,
  },

  // ---- Table ----
  // Fixed widths for Date/Time keep every row's columns aligned; the location
  // column takes the remaining width and WRAPS — full names, never truncated.
  headRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.primaryRed,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    overflow: 'hidden',
  },
  headCellWrap: {
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Lighter divider inside the red header so the grid reads on the dark band.
  headDivider: {
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.45)',
  },
  headCell: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    textAlign: 'center',
  },

  // Shared column sizing — used by BOTH the header and the data rows, so the
  // vertical grid lines land in exactly the same place in every row.
  // Widths are sized to their WORST-CASE content at the cell font: date
  // "29-08-2026" and time "12:59 PM" must each fit on ONE line after the
  // cell's horizontal padding is subtracted — a wrapped date reads as broken.
  cellLocation: { flex: 1 },
  cellDate: { width: 94 },
  cellTime: { width: 78 },

  row: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    borderLeftWidth: 1,
    borderLeftColor: COLORS.line,
    borderRightWidth: 1,
    borderRightColor: COLORS.line,
  },
  rowAlt: { backgroundColor: '#FAFAFC' },
  // stretch (default) makes every cell full row height, so the column
  // borders run edge-to-edge even when the location wraps to 3 lines.
  rowMain: { flexDirection: 'row' },
  cell: {
    paddingVertical: 11,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: COLORS.line,
    justifyContent: 'center',
  },
  // Last column: same padding as `cell`, no right border (the row's own
  // right edge closes the grid).
  cellLast: {
    paddingVertical: 11,
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  colLocation: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.darkText,
    lineHeight: 19,
  },
  colDate: {
    fontSize: 12.5,
    fontWeight: '600',
    color: COLORS.mediumText,
    lineHeight: 19,
    textAlign: 'center',
  },
  colTime: {
    fontSize: 12.5,
    fontWeight: '600',
    color: COLORS.mediumText,
    lineHeight: 19,
    textAlign: 'center',
  },
  rowRemark: {
    marginTop: -4,
    paddingHorizontal: 10,
    paddingBottom: 9,
    fontSize: 12,
    color: COLORS.muted,
    lineHeight: 16,
  },

  empty: {
    textAlign: 'center',
    color: COLORS.muted,
    fontSize: 14,
    marginTop: 30,
    paddingHorizontal: 20,
    lineHeight: 20,
  },
});

export default QrVisitReportScreen;
