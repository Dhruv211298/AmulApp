import { getItem, setItem, KEYS } from './storage';

// ---------------------------------------------------------------------------
// Server-tunable configuration — PER FEATURE.
//
// Each location-verified flow has its own accuracy policy, controlled from the
// backend, because their requirements genuinely differ: QR Attendance is
// geofenced and payroll-adjacent (strict), Meeting Attendance is strict, and
// QR Visit is QR-verified and happens in basements (strict first, best-effort
// fallback). One global knob would force the loosest requirement onto the
// strictest flow.
//
// The server carries these in the app_version_check.php response (fetched on
// every launch, bounded, fail-open); this module validates, caches, and
// persists them. Change a value on the server and every app applies it at its
// next launch — no app release.
//
// Layered defence so a backend problem can never break the app:
//   1. DEFAULTS below are compiled in — the app works with no server contact.
//   2. Values are VALIDATED against sane bounds before being accepted; a typo
//      on the server cannot lock every user out or switch a geofence off.
//      Out-of-bounds values are IGNORED (not clamped) so mistakes surface in
//      testing instead of being silently rounded.
//   3. The last good values are persisted, so an offline launch uses the most
//      recent server-approved policy rather than reverting.
//
// getConfig() is synchronous on purpose: screens need values mid-flow without
// awaiting storage. loadRemoteConfig() hydrates once at startup (Splash);
// until then DEFAULTS apply — the pre-remote-config behaviour.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // QR Code Attendance — geofenced by the server; the limit here must stay at
  // least as tight as the server-side geofence radius or the fence is
  // meaningless.
  qrAttendanceAccuracyM: 100,

  // Meeting Attendance — strict target tried first; if unreachable, best-effort
  // applies up to the cap below (the meeting code is the primary proof of
  // participation; coordinates are supporting evidence).
  meetingAccuracyM: 100,

  // Widest fix a best-effort meeting submission may carry (metres).
  // 0 DISABLES best-effort, making meetings as strict as QR attendance.
  meetingBestEffortCapM: 3000,

  // QR Code Visit — strict target tried first; if unreachable (indoor /
  // basement), best-effort applies up to the cap below.
  visitAccuracyM: 100,

  // Widest fix a best-effort visit may carry (metres). 0 DISABLES best-effort
  // entirely, making visits as strict as attendance.
  visitBestEffortCapM: 3000,
};

// Server field -> { key, min, max }.
const FIELDS = {
  loc_qr_attendance_accuracy_m: { key: 'qrAttendanceAccuracyM', min: 25, max: 1000 },
  loc_meeting_accuracy_m: { key: 'meetingAccuracyM', min: 25, max: 1000 },
  loc_meeting_best_effort_cap_m: { key: 'meetingBestEffortCapM', min: 0, max: 10000 },
  loc_visit_accuracy_m: { key: 'visitAccuracyM', min: 25, max: 1000 },
  // min 0 so the server can turn best-effort OFF; otherwise 500-10000 applies.
  loc_visit_best_effort_cap_m: { key: 'visitBestEffortCapM', min: 0, max: 10000 },
};

const validForField = (field, v) => {
  const { min, max } = FIELDS[field];
  if (!Number.isFinite(v)) return false;
  if (field === 'loc_visit_best_effort_cap_m' || field === 'loc_meeting_best_effort_cap_m') {
    // 0 = disabled is legal; anything else must be a sane cap.
    return v === 0 || (v >= 500 && v <= max);
  }
  return v >= min && v <= max;
};

let current = { ...DEFAULTS };

export function getConfig() {
  return current;
}

// Hydrate from the last persisted copy. Called once at app start (Splash).
export async function loadRemoteConfig() {
  try {
    const raw = await getItem(KEYS.remoteConfig);
    if (!raw) return current;
    const saved = JSON.parse(raw);
    Object.entries(FIELDS).forEach(([field, { key }]) => {
      const v = Number(saved[key]);
      if (validForField(field, v)) current[key] = v;
    });
  } catch (e) {
    // Corrupt cache -> defaults. Never fatal.
  }
  return current;
}

// Accept fresh values from the version-check response and persist the result.
// Unknown fields are ignored; missing fields keep their current values, so the
// server only has to send what it wants to change.
export async function applyRemoteConfig(data) {
  if (!data || typeof data !== 'object') return current;
  let changed = false;
  Object.entries(FIELDS).forEach(([field, { key }]) => {
    const v = Number(data[field]);
    if (validForField(field, v) && current[key] !== v) {
      current[key] = v;
      changed = true;
    }
  });
  if (changed) {
    try {
      await setItem(KEYS.remoteConfig, JSON.stringify(current));
    } catch (e) {}
  }
  return current;
}
