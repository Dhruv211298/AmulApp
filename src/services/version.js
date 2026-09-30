import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { ENDPOINTS } from '../config';
import { fetchTextWithTimeout } from './api';
import { applyRemoteConfig } from './remoteConfig';

const VERSION_URL = ENDPOINTS.versionCheck;

// Compare dotted version strings NUMERICALLY ("1.10.0" > "1.9.0").
// Returns 1 if a > b, -1 if a < b, 0 if equal.
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Ask the server for the version policy and compare it to THIS installed build.
// Fails OPEN (blocked = false) on any error, so a backend outage never locks
// everyone out of the app.
export async function checkAppVersion() {
  const current = DeviceInfo.getVersion();
  try {
    const form = new FormData();
    form.append('platform', Platform.OS);
    form.append('version', current);

    // Bounded (10s, headers AND body): the splash screen awaits this call, so
    // it must NEVER hang — a timeout falls through to the fail-open catch below.
    const { text } = await fetchTextWithTimeout(VERSION_URL, { method: 'POST', body: form }, 10000);
    const data = JSON.parse(text);

    // Same response doubles as the remote-config carrier — tunables like the
    // location accuracy limits update on every launch with no app release.
    // Fire-and-forget: config failures must never delay or break the splash.
    applyRemoteConfig(data).catch(() => {});

    const minV = data.min_version || '0.0.0';
    const latestV = data.latest_version || current;
    const updateUrl =
      Platform.OS === 'ios' ? data.update_url_ios : data.update_url_android;

    return {
      current,
      blocked: compareVersions(current, minV) < 0, // below the floor -> force update
      updateAvailable: compareVersions(current, latestV) < 0, // newer exists (soft)
      message: data.message || 'Please update to the latest version to continue.',
      updateUrl: updateUrl || '',
    };
  } catch (e) {
    return {
      current,
      blocked: false,
      updateAvailable: false,
      message: '',
      updateUrl: '',
    };
  }
}
