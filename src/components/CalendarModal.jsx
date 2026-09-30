import React, { useEffect, useState, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { COLORS } from '../theme';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const YEARS_PER_PAGE = 12;
const DISABLED_COLOR = '#CBD0D8';

// The width this layout was originally drawn at. Everything scales relative to
// it, so the proportions hold on a 4" phone and a tablet alike.
const DESIGN_WIDTH = 360;

// Text scaling is allowed for accessibility but BOUNDED. Unbounded Dynamic Type
// is what broke the iOS header: at 200% text the date line was taller than the
// gradient band and got cut in half. 1.2 keeps it legible without letting the
// layout explode.
const MAX_FONT_SCALE = 1.2;

const sameDay = (a, b) =>
  a && b &&
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const stripTime = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// Professional, dependency-free date picker. Flow: title -> pick YEAR -> MONTH ->
// DAY. Every cell computes explicit colors each render (no toggled style-array
// entries) so deselected cells never keep a stale color and vanish.
//
// SIZING: nothing here is a fixed pixel value. Card width, cell size, font sizes
// and paddings are all derived from the live window size, and every Text carries
// an explicit lineHeight. That last part is the actual fix for the clipped iOS
// header — without lineHeight, a Text's height comes from platform font metrics,
// which differ between iOS and Android, so a container sized implicitly around
// it renders correctly on one platform and clips on the other.
const CalendarModal = ({ visible, value, onConfirm, onClose, title, maximumDate }) => {
  const { width: winWidth, height: winHeight } = useWindowDimensions();

  const M = useMemo(() => {
    const cardWidth = Math.min(winWidth - 32, 400);
    // Clamped so text stays readable on very small screens and doesn't balloon
    // on tablets.
    const scale = Math.min(Math.max(cardWidth / DESIGN_WIDTH, 0.85), 1.15);
    const f = size => Math.round(size * scale);
    // Explicit line height for every text size — see the note above.
    const lh = size => Math.round(size * scale * 1.3);
    const bodyPad = f(14);
    const cellWidth = (cardWidth - bodyPad * 2) / 7;
    const circle = Math.min(Math.floor(cellWidth) - 4, f(42));

    return {
      cardWidth,
      // Leave the card room to breathe, and never let it exceed the screen.
      maxHeight: Math.round(winHeight * 0.86),
      f,
      lh,
      bodyPad,
      circle,
    };
  }, [winWidth, winHeight]);

  const [viewY, setViewY] = useState(new Date().getFullYear());
  const [viewM, setViewM] = useState(new Date().getMonth());
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('days'); // 'days' | 'months' | 'years'
  const [yearBase, setYearBase] = useState(new Date().getFullYear() - 6);

  useEffect(() => {
    if (visible) {
      const base = value ? new Date(value) : new Date();
      setViewY(base.getFullYear());
      setViewM(base.getMonth());
      setSelected(value ? stripTime(new Date(value)) : null);
      setMode('days');
      setYearBase(base.getFullYear() - 6);
    }
  }, [visible, value]);

  const today = stripTime(new Date());
  const max = maximumDate ? stripTime(new Date(maximumDate)) : null;
  const maxYear = max ? max.getFullYear() : null;
  const maxMonth = max ? max.getMonth() : null;


  const goPrevMonth = () => {
    if (viewM === 0) { setViewM(11); setViewY(viewY - 1); }
    else setViewM(viewM - 1);
  };
  const goNextMonth = () => {
    if (viewM === 11) { setViewM(0); setViewY(viewY + 1); }
    else setViewM(viewM + 1);
  };
  const jumpToToday = () => {
    setViewY(today.getFullYear());
    setViewM(today.getMonth());
    setSelected(max && today > max ? max : today);
    setMode('days');
  };

  const onLeft = () => {
    if (mode === 'days') goPrevMonth();
    else if (mode === 'months') setViewY(viewY - 1);
    else setYearBase(yearBase - YEARS_PER_PAGE);
  };
  const onRight = () => {
    if (mode === 'days') goNextMonth();
    else if (mode === 'months') { if (maxYear === null || viewY < maxYear) setViewY(viewY + 1); }
    else setYearBase(yearBase + YEARS_PER_PAGE);
  };

  const firstWeekday = new Date(viewY, viewM, 1).getDay();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const years = [];
  for (let i = 0; i < YEARS_PER_PAGE; i++) years.push(yearBase + i);

  const centerLabel =
    mode === 'days' ? `${MONTHS[viewM]} ${viewY}`
    : mode === 'months' ? `${viewY}`
    : `${years[0]} – ${years[years.length - 1]}`;

  const circleStyle = (isSel, isToday) => ({
    backgroundColor: isSel ? COLORS.primaryRed : 'transparent',
    borderColor: isSel || isToday ? COLORS.primaryRed : 'transparent',
  });
  const dayTextColor = (isSel, isToday, disabled) =>
    disabled ? DISABLED_COLOR
    : isSel ? '#FFFFFF'
    : isToday ? COLORS.primaryRed
    : COLORS.darkText;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          style={[styles.cardShadow, { width: M.cardWidth, maxHeight: M.maxHeight }]}
        >
          <View style={styles.cardContainer}>
            {/* Header — the red gradient band is GONE (it rendered differently
                between iOS and Android and kept clipping). Now just the picker
                title ("From Date" / "To Date", whichever field was tapped) on a
                plain white row with a hairline underneath. Nothing to measure,
                nothing to clip. */}
            {!!title && (
              <View
                style={[
                  styles.headerPlain,
                  { paddingHorizontal: M.f(22), paddingVertical: M.f(14) },
                ]}
              >
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={MAX_FONT_SCALE}
                  style={[styles.headerPlainText, { fontSize: M.f(16) }]}
                >
                  {title}
                </Text>
              </View>
            )}

          {/* Body scrolls only if it genuinely doesn't fit — a small screen in
              landscape, or a large accessibility text size. */}
          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator={false}
            // flexShrink:1 is REQUIRED, not cosmetic. Yoga defaults flexShrink
            // to 0 (CSS defaults it to 1), so without this the ScrollView
            // measures to its full content height and refuses to shrink inside
            // the maxHeight-capped card — pushing the footer past the card edge
            // where overflow:'hidden' clips it. `flex: 1` alone is not enough
            // here, because the parent has no fixed height, only a maximum.
            style={{ flexShrink: 1 }}
            contentContainerStyle={{
              paddingHorizontal: M.bodyPad,
              paddingTop: M.f(12),
              paddingBottom: M.f(8),
            }}
          >
            <View style={[styles.navRow, { marginBottom: M.f(8) }]}>
              <TouchableOpacity
                onPress={onLeft}
                style={{ width: M.f(40), height: M.f(40), alignItems: 'center', justifyContent: 'center' }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text
                  maxFontSizeMultiplier={MAX_FONT_SCALE}
                  style={[styles.navArrow, { fontSize: M.f(28), lineHeight: M.lh(28) }]}
                >
                  ‹
                </Text>
              </TouchableOpacity>

              {mode === 'years' ? (
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={MAX_FONT_SCALE}
                  style={[styles.monthLabel, { fontSize: M.f(16), lineHeight: M.lh(16) }]}
                >
                  {centerLabel}
                </Text>
              ) : (
                <TouchableOpacity
                  onPress={() => {
                    if (mode === 'days') setMode('months');
                    else { setMode('years'); setYearBase(viewY - 6); }
                  }}
                  style={styles.monthPill}
                  activeOpacity={0.7}
                >
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={MAX_FONT_SCALE}
                    style={[styles.monthLabel, { fontSize: M.f(16), lineHeight: M.lh(16) }]}
                  >
                    {centerLabel}
                  </Text>
                  <Text style={[styles.caret, { fontSize: M.f(12) }]}> ▾</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                onPress={onRight}
                style={{ width: M.f(40), height: M.f(40), alignItems: 'center', justifyContent: 'center' }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text
                  maxFontSizeMultiplier={MAX_FONT_SCALE}
                  style={[styles.navArrow, { fontSize: M.f(28), lineHeight: M.lh(28) }]}
                >
                  ›
                </Text>
              </TouchableOpacity>
            </View>

            {/* ---- DAYS ---- */}
            {mode === 'days' && (
              <>
                <View style={styles.weekRow}>
                  {WEEKDAYS.map(w => (
                    <Text
                      key={w}
                      maxFontSizeMultiplier={MAX_FONT_SCALE}
                      style={[
                        styles.weekday,
                        { fontSize: M.f(12), lineHeight: M.lh(12), paddingVertical: M.f(6) },
                      ]}
                    >
                      {w}
                    </Text>
                  ))}
                </View>
                {rows.map((row, ri) => (
                  <View key={ri} style={styles.weekRow}>
                    {row.map((day, ci) => {
                      if (day === null) {
                        return <View key={ci} style={[styles.dayCell, { height: M.circle + 6 }]} />;
                      }
                      const thisDate = new Date(viewY, viewM, day);
                      const disabled = !!(max && thisDate > max);
                      const isSel = sameDay(selected, thisDate);
                      const isToday = sameDay(today, thisDate);
                      return (
                        <TouchableOpacity
                          key={ci}
                          style={[styles.dayCell, { height: M.circle + 6 }]}
                          disabled={disabled}
                          onPress={() => setSelected(thisDate)}
                          activeOpacity={0.7}
                        >
                          <View
                            style={[
                              styles.circle,
                              {
                                width: M.circle,
                                height: M.circle,
                                borderRadius: M.circle / 2,
                              },
                              circleStyle(isSel, isToday),
                            ]}
                          >
                            <Text
                              maxFontSizeMultiplier={MAX_FONT_SCALE}
                              style={{
                                fontSize: M.f(14),
                                lineHeight: M.lh(14),
                                fontWeight: isSel ? '800' : isToday ? '700' : '500',
                                color: dayTextColor(isSel, isToday, disabled),
                              }}
                            >
                              {day}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </>
            )}

            {/* ---- MONTHS ---- */}
            {mode === 'months' && (
              <View style={styles.gridWrap}>
                {MONTHS_SHORT.map((mLabel, mi) => {
                  const disabled = !!(maxYear !== null && (viewY > maxYear || (viewY === maxYear && mi > maxMonth)));
                  const isCur = mi === viewM;
                  return (
                    <TouchableOpacity
                      key={mLabel}
                      style={[styles.monthCell, { paddingVertical: M.f(4) }]}
                      disabled={disabled}
                      activeOpacity={0.7}
                      onPress={() => { setViewM(mi); setMode('days'); }}
                    >
                      <View
                        style={[
                          styles.pill,
                          {
                            paddingHorizontal: M.f(16),
                            paddingVertical: M.f(10),
                            borderRadius: M.f(20),
                            backgroundColor: isCur ? COLORS.primaryRed : 'transparent',
                          },
                        ]}
                      >
                        <Text
                          maxFontSizeMultiplier={MAX_FONT_SCALE}
                          style={{
                            fontSize: M.f(15),
                            lineHeight: M.lh(15),
                            fontWeight: isCur ? '800' : '600',
                            color: disabled ? DISABLED_COLOR : isCur ? '#FFFFFF' : COLORS.darkText,
                          }}
                        >
                          {mLabel}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* ---- YEARS ---- */}
            {mode === 'years' && (
              <View style={styles.gridWrap}>
                {years.map(y => {
                  const disabled = !!(maxYear !== null && y > maxYear);
                  const isCur = y === viewY;
                  return (
                    <TouchableOpacity
                      key={y}
                      style={[styles.yearCell, { paddingVertical: M.f(4) }]}
                      disabled={disabled}
                      activeOpacity={0.7}
                      onPress={() => { setViewY(y); setMode('months'); }}
                    >
                      <View
                        style={[
                          styles.pill,
                          {
                            paddingHorizontal: M.f(12),
                            paddingVertical: M.f(10),
                            borderRadius: M.f(20),
                            backgroundColor: isCur ? COLORS.primaryRed : 'transparent',
                          },
                        ]}
                      >
                        <Text
                          maxFontSizeMultiplier={MAX_FONT_SCALE}
                          style={{
                            fontSize: M.f(15),
                            lineHeight: M.lh(15),
                            fontWeight: isCur ? '800' : '600',
                            color: disabled ? DISABLED_COLOR : isCur ? '#FFFFFF' : COLORS.darkText,
                          }}
                        >
                          {y}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>

          {/* Footer sits OUTSIDE the ScrollView so the actions stay reachable
              even when the month grid has to scroll. */}
          <View
            style={[
              styles.footer,
              { paddingHorizontal: M.bodyPad, paddingTop: M.f(6), paddingBottom: M.f(6) },
            ]}
          >
            <TouchableOpacity onPress={jumpToToday} style={{ paddingHorizontal: M.f(14), paddingVertical: M.f(12) }}>
              <Text
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[styles.todayText, { fontSize: M.f(14), lineHeight: M.lh(14) }]}
              >
                Today
              </Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} style={{ paddingHorizontal: M.f(14), paddingVertical: M.f(12) }}>
              <Text
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[styles.cancelText, { fontSize: M.f(14), lineHeight: M.lh(14) }]}
              >
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => selected && onConfirm(selected)}
              disabled={!selected}
              style={{ paddingHorizontal: M.f(14), paddingVertical: M.f(12) }}
            >
              <Text
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[
                  styles.okText,
                  { fontSize: M.f(15), lineHeight: M.lh(15) },
                  !selected && styles.okDisabled,
                ]}
              >
                OK
              </Text>
            </TouchableOpacity>
          </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

// Only layout rules that do NOT depend on screen size live here. Anything
// sized in points is applied inline from the `M` object above.
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  cardShadow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  cardContainer: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    overflow: 'hidden',
    flexShrink: 1,
  },

  // Plain header row — white background, hairline divider, dark title.
  headerPlain: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    backgroundColor: '#FFFFFF',
  },
  headerPlainText: {
    color: COLORS.darkText,
    fontWeight: '800',
    letterSpacing: 0.2,
  },

  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  navArrow: { color: COLORS.darkText, fontWeight: '600' },
  monthPill: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  monthLabel: { fontWeight: '700', color: COLORS.darkText, flexShrink: 1 },
  caret: { color: COLORS.primaryRed, fontWeight: '700' },

  weekRow: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '700',
    color: COLORS.muted,
  },
  dayCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Border is always present (transparent when inactive) so the size never
  // shifts; colors are applied inline per render.
  circle: {
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },

  gridWrap: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 8 },
  monthCell: { width: '33.333%', alignItems: 'center' },
  yearCell: { width: '25%', alignItems: 'center' },
  pill: { alignItems: 'center', justifyContent: 'center' },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
  },
  todayText: { color: COLORS.mediumText, fontWeight: '700' },
  cancelText: { color: COLORS.muted, fontWeight: '700' },
  okText: { color: COLORS.primaryRed, fontWeight: '800' },
  okDisabled: { opacity: 0.4 },
});

export default CalendarModal;
