import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiPost } from './api';
import { KEYS } from './storage';
import { ENDPOINTS } from '../config';

// Shown only if the menu has never been fetched (first launch / offline first login).
// These route names are all registered in MainNavigator, so they always work.
export const FALLBACK_MENU = [
  { id: 'dashboard', name: 'Dashboard', screen: 'Dashboard', url: null, icon: null },
  { id: 'settings', name: 'Settings', screen: 'Settings', url: null, icon: null },
];

// Normalize a row whether the backend returns friendly keys (name/screen…)
// or the raw DB column names (vc_menu_name/vc_screen…).
const normalize = m => ({
  id: String(m.id ?? m.nu_menu_id ?? m.screen ?? m.vc_screen ?? m.name ?? m.vc_menu_name),
  name: m.name ?? m.vc_menu_name ?? '',
  screen: m.screen ?? m.vc_screen ?? null,
  url: m.url ?? m.vc_url ?? null,
  icon: m.icon ?? m.vc_icon ?? null,
});

// Fetch the menu for the logged-in user and cache it. Called at login and on
// every drawer open (background refresh), so rights changes made in the
// backend's screen/group masters reach the user without re-login.
// Throws on failure so the caller can decide whether to ignore it.
export async function refreshSidebarMenu() {
  // The rights-aware app_menu_new.php resolves groups by employee id, so send
  // it explicitly (apiPost also auto-attaches username/user_type/token).
  const employeeId = (await AsyncStorage.getItem(KEYS.userId)) || '';

  // Dev diagnostics: when the sidebar shows only the fallback, this reveals
  // WHY — the endpoint hit, the employee id sent, and the raw server reply.
  // (Stripped from release builds; __DEV__ is false there.)
  if (__DEV__) {
    console.log('[menu] fetching', ENDPOINTS.menu, 'for employee_id=', employeeId);
  }

  let data;
  try {
    data = await apiPost(ENDPOINTS.menu, { employee_id: employeeId });
  } catch (e) {
    if (__DEV__) console.warn('[menu] request failed:', e && e.message);
    throw e; // caller ignores; cache/fallback stays
  }

  if (__DEV__) {
    console.log('[menu] server response:', JSON.stringify(data));
  }

  if (data && data.status === 'success' && Array.isArray(data.menu)) {
    const menu = data.menu.map(normalize).filter(m => m.name);
    // Grouped form, from /app_api/app_menu.php. An endpoint that returns only
    // `menu` (app_menu_new.php, or a server not yet upgraded) yields [], which
    // clears any previously cached tree rather than leaving a stale one — the
    // sidebar then falls back to the flat list, i.e. pre-categories behaviour.
    const tree = Array.isArray(data.menu_tree) ? normalizeTree(data.menu_tree) : [];

    if (__DEV__) {
      console.log('[menu] usable items after normalize:', menu.length);
      console.log('[menu] tree entries:', tree.length);
    }

    // BOTH KEYS IN ONE WRITE. Written separately, a failure on the second call
    // would leave the flat cache holding the NEW menu and the tree cache the
    // OLD one — and because the tree wins when non-empty, the user could keep
    // seeing a screen their rights no longer include. multiSet is a single
    // AsyncStorage operation, so the pair moves together or not at all.
    await AsyncStorage.multiSet([
      [KEYS.sidebarMenu, JSON.stringify(menu)],
      [KEYS.sidebarTree, JSON.stringify(tree)],
    ]);

    return menu;
  }
  if (__DEV__) {
    console.warn('[menu] response not usable — status/menu shape unexpected');
  }
  throw new Error('Invalid menu response');
}

// Normalize the grouped form. Entries are either a plain item or a category
// carrying its own items; both are passed through the SAME `normalize` used for
// the flat list, so the sidebar can treat a tree leaf and a flat row
// identically. Anything malformed is dropped rather than rendered as a blank
// row — a bad row must never produce an untappable gap in the menu.
const normalizeTree = tree =>
  (Array.isArray(tree) ? tree : [])
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;

      if (entry.type === 'category') {
        const items = (Array.isArray(entry.items) ? entry.items : [])
          .map(normalize)
          .filter(m => m.name);
        if (!items.length) return null;      // heading with nothing under it
        return {
          type: 'category',
          id: `cat-${entry.category_id ?? entry.name}`,
          name: entry.name ?? '',
          items,
        };
      }

      const item = normalize(entry);
      return item.name ? { type: 'item', ...item } : null;
    })
    .filter(Boolean);

// Read the cached GROUPED menu. Returns [] when there is none — the sidebar
// then renders the flat list, so an older server or a first launch degrades to
// exactly the previous behaviour rather than an empty drawer.
export async function getSidebarTree() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.sidebarTree);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    // ignore parse errors — flat menu is the fallback
  }
  return [];
}

// Read the cached menu. Falls back to FALLBACK_MENU if there is no cache yet
// or the stored value can't be parsed — so the sidebar is never empty.
export async function getSidebarMenu() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.sidebarMenu);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) {
    // ignore parse errors and fall through to the fallback
  }
  return FALLBACK_MENU;
}
