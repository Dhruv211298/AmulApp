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

const REPORT_URL = ENDPOINTS.locationAttendanceReport;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const pad = n => String(n).padStart(2, '0');
const toApi = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = d => `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;

const QrAttendanceReportScreen = () => {
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
      // A report over a long date range can legitimately take a while to
      // build server-side, so this call gets a generous 60s bound instead of
      // the default 15s — still bounded (never an infinite wait), just sized
      // for the work. The staged LoadingHint below keeps the user informed.
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

  const renderItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.plantName} numberOfLines={1}>
          {item.plant_name || 'Location'}
        </Text>
        <View style={styles.dateBadge}>
          <Text style={styles.dateBadgeText}>{item.date}</Text>
        </View>
      </View>
      <Text style={styles.plantCode}>Plant Code: {item.plant_code}</Text>

      <View style={styles.timesRow}>
        <View style={styles.timeBox}>
          <Text style={styles.timeLabel}>Check In</Text>
          <Text style={styles.timeVal}>{item.check_in || '—'}</Text>
          {!!item.checkin_remark && (
            <View style={styles.remarkWrap}>
              <Text style={styles.remarkLabel}>IN REMARK</Text>
              <Text style={styles.colRemark}>{item.checkin_remark}</Text>
            </View>
          )}
        </View>
        <View style={styles.timeBox}>
          <Text style={styles.timeLabel}>Check Out</Text>
          <Text style={styles.timeVal}>{item.check_out || '—'}</Text>
          {!!item.checkout_remark && (
            <View style={styles.remarkWrap}>
              <Text style={styles.remarkLabel}>OUT REMARK</Text>
              <Text style={styles.colRemark}>{item.checkout_remark}</Text>
            </View>
          )}
        </View>
        <View style={styles.timeBox}>
          <Text style={styles.timeLabel}>Working</Text>
          <Text style={[styles.timeVal, styles.workVal]}>{item.working_time || '—'}</Text>
        </View>
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
          {records.length} {records.length === 1 ? 'record' : 'records'}
        </Text>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={records}
        keyExtractor={(item, i) => `${item.plant_code}-${item.date}-${i}`}
        renderItem={renderItem}
        ListHeaderComponent={Header}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        ListEmptyComponent={
          loading ? (
            <LoadingHint
              visible={loading}
              messages={[
                'Loading your report…',
                'Fetching your attendance records…',
                'Still working — large reports can take a little longer…',
                'Almost there, thank you for waiting…',
              ]}
            />
          ) : searched ? (
            <Text style={styles.empty}>No attendance found for this range.</Text>
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

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: COLORS.primaryRed,
    shadowOpacity: 0.07,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  plantName: { flex: 1, fontSize: 16, fontWeight: '800', color: COLORS.darkText, paddingRight: 8 },
  dateBadge: {
    backgroundColor: COLORS.redTint,
    borderRadius: 50,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dateBadgeText: { color: COLORS.primaryRed, fontSize: 12, fontWeight: '700' },
  plantCode: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 4,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },

  timesRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
    paddingTop: 12,
  },
  timeBox: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  timeLabel: {
    fontSize: 11,
    color: COLORS.muted,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  timeVal: { fontSize: 14, color: COLORS.darkText, fontWeight: '700', marginTop: 4 },
  workVal: { color: COLORS.primaryRed },
  remarkWrap: {
    marginTop: 8,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
    paddingTop: 6,
    alignSelf: 'stretch',
  },
  remarkLabel: {
    fontSize: 11,
    color: COLORS.muted,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  colRemark: {
    fontSize: 12,
    color: COLORS.mediumText,
    marginTop: 2,
    textAlign: 'center',
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

export default QrAttendanceReportScreen;
