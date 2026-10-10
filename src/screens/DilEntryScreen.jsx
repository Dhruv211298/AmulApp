import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Alert,
  Modal,
  Pressable,
  Image,
  ActivityIndicator,
  AppState,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import CalendarModal from '../components/CalendarModal';
import BrandLoader from '../components/BrandLoader';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { MSG } from '../constants/messages';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import Svg, { Rect, Line, Path } from 'react-native-svg';

// Small calendar glyph (drawn with SVG, no asset) for the date-time fields so
// they read as "pick a date", not a dropdown.
const CalendarIcon = ({ size = 18, color = COLORS.muted }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x="3" y="4.5" width="18" height="16" rx="2.5" stroke={color} strokeWidth="1.8" />
    <Line x1="3" y1="9" x2="21" y2="9" stroke={color} strokeWidth="1.8" />
    <Line x1="8" y1="2.5" x2="8" y2="6" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    <Line x1="16" y1="2.5" x2="16" y2="6" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
  </Svg>
);

// Chevron for the collapsible section headers — points down when open, right
// when collapsed.
const Chevron = ({ open, size = 18, color = COLORS.primaryRed }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'}
      stroke={color}
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

// Tappable section header (the red bar) that collapses/expands its section. Same
// bar as before, with a chevron added on the right.
const CollapsibleHeader = ({ title, open, onPress }) => (
  <TouchableOpacity
    style={[styles.sectionHeader, styles.sectionHeaderToggle]}
    onPress={onPress}
    activeOpacity={0.7}
    accessibilityRole="button"
    accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${title}`}
  >
    <Text style={[styles.sectionHeaderText, styles.sectionHeaderTextFlex]} numberOfLines={2}>
      {title}
    </Text>
    <Chevron open={open} />
  </TouchableOpacity>
);

const QR_ICON = require('../assets/qr_scan.png');
const CAMERA_ICON = require('../assets/camera.png');

// Load photos: downscale to keep BOTH the upload and the in-memory base64 light
// while a number plate stays readable. 1280 @ 72 is roughly half the bytes of
// 1600 @ 80 and still clearly legible for a plate that fills much of the frame.
const LOAD_PHOTO_SPEC = { maxW: 1280, maxH: 1280, quality: 72 };

// The three dispatch photos, in display order. key -> tile label.
const LOAD_PHOTOS = [
  { key: 'vehicle_front', label: 'Vehicle Front With Number Plate' },
  { key: 'before_loading', label: 'Before Loading' },
  { key: 'after_loading', label: 'After Loading' },
];

// Tile key -> the slot name the image-serve endpoint expects.
const SLOT_API = {
  vehicle_front: 'vehicle',
  before_loading: 'before',
  after_loading: 'after',
};

// Loading date-times are shown to the user as "DD-MM-YYYY HH:MM" and chosen via
// a date-then-time picker (no free typing). These helpers convert between that
// display string and a Date.
const pad2 = n => String(n).padStart(2, '0');
const fmtDateTime = d =>
  `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const parseDateTime = s => {
  const m = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], 0, 0);
  return isNaN(d.getTime()) ? null : d;
};
// A "DD-MM-YYYY HH:MM" display value -> ISO 8601 "YYYY-MM-DDTHH:MM:00" for SQL
// (parsed the same regardless of the server's DATEFORMAT). '' when unset.
const toSqlDateTime = s => {
  const d = parseDateTime(s);
  if (!d) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:00`;
};
// Strip the "data:image/...;base64," prefix off a data URI (keep the payload).
const base64Only = uri => {
  const s = String(uri || '');
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
};
// SQL "YYYY-MM-DD HH:MM" (what rtype 1 returns for the loading times) back to
// the on-screen "DD-MM-YYYY HH:MM". '' when not a match.
const sqlToDisplayDt = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : '';
};

// Product / batch labels may be QR or 1D barcodes, so accept both.
const SCAN_CODE_TYPES = [
  'qr',
  'ean-13',
  'ean-8',
  'code-128',
  'code-39',
  'code-93',
  'upc-a',
  'upc-e',
  'itf',
  'codabar',
];
import { getItem, setItem, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import { fetchTextWithTimeout, apiPost } from '../services/api';
import { ENDPOINTS } from '../config';
import { COLORS } from '../theme';

// Validation patterns.
//   Mobile  : Indian 10-digit number, first digit 6-9.
//   Vehicle : state(2 letters) + RTO(1-2 digits) + series(1-3 letters) +
//             number(1-4 digits), e.g. GJ01AB1234.
const MOBILE_RE = /^[6-9]\d{9}$/;
const VEHICLE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{1,4}$/;

// Date helpers — same shapes the report screens use with CalendarModal.
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const pad = n => String(n).padStart(2, '0');
// For the RFC's `dildt` param.
const toApi = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// For the tappable field the user reads.
const toDisplay = d =>
  `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
// Parse an API date string (YYYY-MM-DD) back to a local Date; null on bad input.
const fromApi = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

// SAP sends quantities like "20.000" / "4.000". Drop the meaningless trailing
// zeros for display, but never crash on an unexpected value.
const fmtQty = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(n) : String(v == null ? '' : v);
};

// Reasons offered when a DIL is submitted with LESS than the planned quantity.
// Picking a reason is mandatory; "Other" additionally requires a typed note.
const SHORT_REASONS = [
  'Stock shortage',
  'Vehicle full / no space',
  'Quality hold',
  'Customer reduced order',
  'Other',
];

// SAP dates are "YYYYMMDD". Render as "01 Sep 2026"; pass anything else through.
const fmtSapDate = v => {
  const s = String(v == null ? '' : v);
  if (!/^\d{8}$/.test(s)) return s;
  const y = s.slice(0, 4);
  const m = Number(s.slice(4, 6));
  const d = s.slice(6, 8);
  return `${d} ${MONTHS_SHORT[m - 1] || '?'} ${y}`;
};

// ===========================================================================
// DIL Entry
// ---------------------------------------------------------------------------
// Header fields only so far: Plant Code (read-only) and DIL No (typed).
// The remaining fields are still to be specified — add them under the marked
// section and they will inherit the same Label/Field styling.
//
// PLANT IS NOT A TEXT BOX, ON PURPOSE.
// It comes from the logged-in user, delivered by app_token_checker.php at
// every login and cached under KEYS.plantCode / KEYS.plantNo. Rendering it
// read-only means:
//   * an entry can never be filed against the wrong plant by mistyping
//   * the user cannot file against a plant they do not belong to
//   * a plant transfer is picked up automatically at the next login
// The numeric plant key is held in state too, because that is what the insert
// will need — the visible short code is for the human, not the database.
// ===========================================================================

const Label = ({ children, required }) => (
  <Text style={styles.label}>
    {children}
    {required ? <Text style={styles.requiredMark}> *</Text> : null}
  </Text>
);

// One dispatch-photo slot.
//  * Empty  -> dashed tile with the camera icon + label; tapping captures.
//  * Filled -> a freshly captured preview OR an "Uploaded" state (re-opened
//    DIL), each with a two-button action bar: "View" (opens the photo) and
//    "Replace" (re-captures). `image` = a freshly captured data URI;
//    `uploaded` = a photo for this slot is already stored on the server.
const PhotoTile = ({ label, image, uploaded, onPress, onView, required }) => {
  if (image || uploaded) {
    return (
      <View style={styles.photoTile}>
        <View style={styles.photoTileBody}>
          {image ? (
            <Image source={{ uri: image }} style={styles.photoTileImgFill} resizeMode="cover" />
          ) : (
            <View style={styles.photoTileEmpty}>
              <Text style={styles.photoTileUploaded}>✓ Uploaded</Text>
              <Text style={styles.photoTileLabel}>{label}</Text>
            </View>
          )}
        </View>
        <View style={styles.photoTileActions}>
          <TouchableOpacity
            style={styles.photoTileActionBtn}
            onPress={onView}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`View ${label}`}
          >
            <Text style={styles.photoTileActionText}>View</Text>
          </TouchableOpacity>
          <View style={styles.photoTileActionDivider} />
          <TouchableOpacity
            style={styles.photoTileActionBtn}
            onPress={onPress}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Replace ${label}`}
          >
            <Text style={[styles.photoTileActionText, styles.photoTileActionReplace]}>Replace</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={[styles.photoTile, styles.photoTileEmptyBorder]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`Capture ${label}`}
    >
      <View style={styles.photoTileEmpty}>
        <Image source={CAMERA_ICON} style={styles.photoTileIcon} resizeMode="contain" />
        <Text style={styles.photoTileLabel}>
          {label}
          {required ? <Text style={styles.requiredMark}> *</Text> : null}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

const DilEntryScreen = () => {
  // From the session, not from the form.
  const [plantCode, setPlantCode] = useState('');
  const [plantNo, setPlantNo] = useState('');
  // Logged-in employee's section (view_hr_mst_emp.nu_section_no), cached at
  // login under KEYS.sectionNo and sent with the DIL on save/submit.
  const [sectionNo, setSectionNo] = useState('');
  const [plantLoaded, setPlantLoaded] = useState(false);

  // Typed by the user.
  const [dilNo, setDilNo] = useState('');
  // DIL Date — a Date object, defaulting to today (picked via CalendarModal).
  const [dilDate, setDilDate] = useState(new Date());
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Revealed only after the RFC returns product rows.
  const [showEntry, setShowEntry] = useState(false);

  // Dispatch inputs (shown after the button is pressed).
  const [driverName, setDriverName] = useState('');
  const [mobileNo, setMobileNo] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [lrNumber, setLrNumber] = useState(''); // LR (lorry receipt) number — mandatory
  const [sealNo, setSealNo] = useState(''); // seal number 1 — optional, alphanumeric (max 30)
  const [sealNo2, setSealNo2] = useState(''); // seal number 2 — optional (a 2nd seal is sometimes used)
  const [vehicleTemp, setVehicleTemp] = useState(''); // vehicle temperature — optional, numeric, +/- allowed

  // Dispatch photos (base64 data URIs) — vehicle front, before- and after-
  // loading. All three are mandatory to SUBMIT. Held in state; upload wiring is
  // added with the backend step.
  const [loadPhotos, setLoadPhotos] = useState({
    vehicle_front: null,
    before_loading: null,
    after_loading: null,
  });
  // Photos already stored on the server for a re-opened DIL (file names per
  // slot) + whether a dispatch (form-1170) row already exists. A slot counts as
  // "has a photo" if it has a freshly captured one OR an existing uploaded one.
  const [existingPhotos, setExistingPhotos] = useState({
    vehicle_front: null,
    before_loading: null,
    after_loading: null,
  });
  const [dispatchExists, setDispatchExists] = useState(false);
  // Full-screen photo viewer (the tiles' "View" button). uri is a data URI:
  // a freshly captured photo is shown straight away; an already-uploaded one
  // is fetched from the server (by slot) as base64 on demand.
  const [photoViewer, setPhotoViewer] = useState({
    open: false,
    uri: null,
    loading: false,
    label: '',
  });
  // True while the background SAP reconcile runs after a draft is opened. The
  // form is already usable; this just shows a small "Syncing…" note so the user
  // knows saved products may still update.
  const [syncingSaved, setSyncingSaved] = useState(false);
  // Loading date-times ("DD-MM-YYYY HH:MM") — chosen via the date-then-time
  // picker below. Optional.
  const [loadStartTime, setLoadStartTime] = useState('');
  const [loadEndTime, setLoadEndTime] = useState('');
  // Date-time picker: which field it's editing, which step, and the draft being
  // assembled (date picked first, then hour/minute).
  const [dtPickerFor, setDtPickerFor] = useState(null); // 'start' | 'end' | null (iOS modal)
  const [dtDraft, setDtDraft] = useState(new Date());

  // Camera (vision-camera, same pattern as VisitorEntry).
  const [hasCamPermission, setHasCamPermission] = useState(false);
  const [cameraFor, setCameraFor] = useState(null); // one of LOAD_PHOTOS keys | null
  const [isFrontCamera, setIsFrontCamera] = useState(false);
  const camDevice = useCameraDevice(isFrontCamera ? 'front' : 'back');
  const camRef = useRef(null);

  // Collapsible sections — all expanded by default. collapsed[key] === true
  // hides that section's body (header stays, with the chevron, so it can reopen).
  const [collapsed, setCollapsed] = useState({});
  const toggleSection = useCallback(
    k => setCollapsed(p => ({ ...p, [k]: !p[k] })),
    [],
  );

  // App foreground/background — used to pause the Live Stock polling while the
  // app is in the background (no point hitting the network when unseen).
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s =>
      setAppActive(s === 'active'),
    );
    return () => sub.remove();
  }, []);

  // Vehicle Number type-ahead. The suggestion list is today's vehicles for the
  // selected (top-dropdown) plant, fetched once per plant and filtered on the
  // client as the user types. Selecting one fills the vehicle AND driver name.
  // Free typing is always allowed — suggestions are assistance, not a gate.
  const [vehicleSuggest, setVehicleSuggest] = useState([]); // [{vehicle_no, driver_nm}]
  const [vehicleSuggestOpen, setVehicleSuggestOpen] = useState(false);

  // Product list, fetched from the RFC on the same button press.
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);

  // Product picker — the RFC rows loaded into a dropdown (Material Code -
  // Material Name). Selection is keyed on EBELP (the DIL line item, unique per
  // row) and carries quantity, unit and net weight.
  const [selectedEbelp, setSelectedEbelp] = useState(null);
  const [productPickerOpen, setProductPickerOpen] = useState(false);

  // Standalone plant dropdown at the top of the screen (all active plants from
  // get_dil_plant_list.php). NOT tied to Get DIL Details — it just holds the
  // user's selection for now.
  const [dilPlants, setDilPlants] = useState([]); // [{plant_code, plant_name}]
  const [dilPlant, setDilPlant] = useState(null); // selected {plant_code, plant_name} | null
  const [plantPickerOpen, setPlantPickerOpen] = useState(false);
  const [plantQuery, setPlantQuery] = useState(''); // search text in the plant picker

  // Dock Selection — active docks for the chosen plant (get_dil_dock_list.php),
  // reloaded whenever the top Plant dropdown changes. Selection = nu_doc_no id.
  const [docks, setDocks] = useState([]); // [{dock_no, dock_name}]
  const [dockNo, setDockNo] = useState(''); // selected nu_doc_no (string) | ''
  const [docksLoading, setDocksLoading] = useState(false);
  const [dockPickerOpen, setDockPickerOpen] = useState(false);
  const [dockQuery, setDockQuery] = useState(''); // search text in the dock picker
  const [scannerOpen, setScannerOpen] = useState(false);
  // What a scan should fill: 'product' (pick from dropdown) or
  // { ebelp, index } (a batch row's number). Null when the scanner is closed.
  const [scanTarget, setScanTarget] = useState(null);

  // Batches entered per product line: { [EBELP]: [{ batchNo, qty }, ...] }.
  const [batchesByEbelp, setBatchesByEbelp] = useState({});

  // Live batch stock (SAP − reserved) for the selected product:
  // [{ batch_no, available, uom, mfg_date, sap_stock, reserved }].
  const [batchStock, setBatchStock] = useState([]);
  const [batchStockLoading, setBatchStockLoading] = useState(false);
  // Material-level live stock for the selected product: { total, reserved, available, uom }.
  const [materialStock, setMaterialStock] = useState(null);
  // Live stock for EVERY product in the DIL: { [MATNR]: {total,reserved,available} }.
  const [stockByMat, setStockByMat] = useState({});
  const [stockRefreshing, setStockRefreshing] = useState(false);
  const [stockUpdatedAt, setStockUpdatedAt] = useState('');
  // Which batch row a batch-picker modal is filling: { ebelp, index } or null.
  const [batchPicker, setBatchPicker] = useState(null);

  // Products the user has committed (with balanced batches). These drop OUT of
  // the dropdown and show in the list below; removing one returns it. Stored as
  // EBELP strings.
  const [addedEbelps, setAddedEbelps] = useState([]);

  // Guard against double-submit of a batch. savingBatchRef blocks re-entry
  // SYNCHRONOUSLY (a ref updates immediately, so rapid taps can't slip a second
  // save through before a re-render); savingBatchIdx just drives the button's
  // disabled / "saving" look.
  const savingBatchRef = useRef(false);
  const [savingBatchIdx, setSavingBatchIdx] = useState(null);

  // Optional pallet detail (whole DIL): number of pallets + weight per pallet.
  const [palletQty, setPalletQty] = useState('');
  const [palletWeight, setPalletWeight] = useState('');

  // Save / submit in flight (+ loader caption for the branded overlay).
  const [saving, setSaving] = useState(false);
  const [saveCaption, setSaveCaption] = useState('Saving');

  // Short-submit reason modal. When Submit is tapped with any product below its
  // planned quantity, this opens to capture WHY (mandatory) before submitting.
  const [shortModalOpen, setShortModalOpen] = useState(false);
  const [shortLinesText, setShortLinesText] = useState(''); // the shortfall list
  const [shortReason, setShortReason] = useState(null);     // chosen reason
  const [shortNote, setShortNote] = useState('');           // optional / "Other" note

  const loadPlant = useCallback(async () => {
    let [code, no, sect] = await Promise.all([
      getItem(KEYS.plantCode),
      getItem(KEYS.plantNo),
      getItem(KEYS.sectionNo),
    ]);

    code = (code || '').trim();
    no = (no || '').trim();
    sect = (sect || '').trim();

    // Self-heal: if plant is missing from storage (e.g. session predates plantCode caching
    // or token checker was refreshed on the server), query tokenCheck to fetch the latest plant.
    if (!code && !no) {
      try {
        const [userId, deviceId] = await Promise.all([
          getItem(KEYS.userId),
          getDeviceId(),
        ]);
        if (userId && deviceId) {
          const body = new FormData();
          body.append('employee_id', userId);
          body.append('device_id', deviceId);
          const { text } = await fetchTextWithTimeout(ENDPOINTS.tokenCheck, {
            method: 'POST',
            body,
          });
          const data = JSON.parse(text);
          if (data && String(data.emp_status) === '1') {
            if (data.vc_plant_code) {
              code = String(data.vc_plant_code).trim();
              await setItem(KEYS.plantCode, code);
            }
            if (data.nu_plant_code) {
              no = String(data.nu_plant_code).trim();
              await setItem(KEYS.plantNo, no);
            }
            if (data.nu_section_no != null) {
              sect = String(data.nu_section_no).trim();
              await setItem(KEYS.sectionNo, sect);
            }
          }
        }
      } catch (e) {
        // Fall back gracefully to storage values
      }
    }

    setPlantCode(code);
    setPlantNo(no);
    setSectionNo(sect);
    setPlantLoaded(true);

    if (__DEV__) {
      console.log('[DIL] plant resolved — code:', JSON.stringify(code), 'no:', JSON.stringify(no));
    }
  }, []);

  useEffect(() => {
    loadPlant();
  }, [loadPlant]);

  // Re-read on every focus, not just on mount. The screen stays mounted in the
  // stack, so a value refreshed by a later login would otherwise keep showing
  // the plant this screen happened to read the first time it opened.
  useFocusEffect(
    useCallback(() => {
      loadPlant();
    }, [loadPlant]),
  );

  // Load the standalone plant dropdown (all active plants) once on mount.
  // Best-effort — if it fails the dropdown just stays empty.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiPost(ENDPOINTS.dilPlantList, {});
        const list = Array.isArray(res) ? res : (res && res.data) || [];
        if (alive && Array.isArray(list)) setDilPlants(list);
      } catch (e) {
        // ignore — dropdown stays empty / retriable next open
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Default the dropdown to the logged-in user's plant, once, as soon as both
  // the plant list and the user's plant code are available. Matched on the
  // short code (vc_plant_code). Runs only once so it never fights a manual
  // change or a cleared selection later.
  const plantDefaultedRef = useRef(false);
  useEffect(() => {
    if (plantDefaultedRef.current) return;
    if (!dilPlants.length) return;
    const code = String(plantCode || '').trim().toUpperCase();
    if (!code) return;
    const match = dilPlants.find(
      pl => String(pl.plant_code || '').trim().toUpperCase() === code,
    );
    if (match) {
      setDilPlant(match);
      plantDefaultedRef.current = true;
    }
  }, [dilPlants, plantCode]);

  // Load today's vehicle suggestions for the selected (top-dropdown) plant.
  // Re-runs whenever the chosen plant changes, so the Vehicle Number type-ahead
  // always reflects the plant currently selected. Non-fatal: on any failure the
  // list is simply empty and the field behaves as a plain input.
  useEffect(() => {
    const code = (dilPlant && dilPlant.plant_code) || '';
    if (!code) {
      setVehicleSuggest([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await apiPost(ENDPOINTS.dilVehicleList, { plant_code: code });
        const list = Array.isArray(res) ? res : (res && res.data) || [];
        if (alive && Array.isArray(list)) setVehicleSuggest(list);
      } catch (e) {
        if (alive) setVehicleSuggest([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dilPlant]);

  // Load the dispatch docks for the selected (top-dropdown) plant. Re-runs when
  // the chosen plant changes so the Dock Selection dropdown always matches the
  // current plant. The previously chosen dock is NOT cleared here (so reopening
  // a saved DIL keeps its dock); a MANUAL plant change clears it at the picker.
  useEffect(() => {
    const code = (dilPlant && dilPlant.plant_code) || '';
    if (!code) {
      setDocks([]);
      return;
    }
    let alive = true;
    setDocksLoading(true);
    (async () => {
      try {
        const res = await apiPost(ENDPOINTS.dilDockList, { plant_code: code });
        const list = Array.isArray(res) ? res : (res && res.data) || [];
        if (alive && Array.isArray(list)) setDocks(list);
      } catch (e) {
        if (alive) setDocks([]);
      } finally {
        if (alive) setDocksLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [dilPlant]);

  // Ask for camera permission once on mount (v4 returns 'granted', v3
  // 'authorized'). Non-fatal — the camera screen shows a prompt if denied.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const status = await Camera.requestCameraPermission();
        if (mounted) {
          setHasCamPermission(status === 'granted' || status === 'authorized');
        }
      } catch (e) {}
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Capture a dispatch photo: grab the best frame, downscale + strip EXIF, read
  // it as base64, store under the active key, then delete both temp files.
  const takePhoto = useCallback(async () => {
    if (!camRef.current || !cameraFor) return;
    try {
      const photo = await camRef.current.takePhoto({
        qualityPrioritization: 'quality',
      });
      const originalPath = photo.path.replace('file://', '');
      const resized = await ImageResizer.createResizedImage(
        originalPath,
        LOAD_PHOTO_SPEC.maxW,
        LOAD_PHOTO_SPEC.maxH,
        'JPEG',
        LOAD_PHOTO_SPEC.quality,
        0, // rotation — EXIF orientation already applied
        undefined, // outputPath — library picks a temp file
        false, // keepMeta: strip EXIF (drops GPS/device tags, smaller)
        { mode: 'contain', onlyScaleDown: true },
      );
      const base64 = await RNFS.readFile(resized.uri, 'base64');
      const dataUri = `data:image/jpeg;base64,${base64}`;
      const key = cameraFor;
      setLoadPhotos(prev => ({ ...prev, [key]: dataUri }));
      try { await RNFS.unlink(resized.uri); } catch (e) {}
      try { await RNFS.unlink(originalPath); } catch (e) {}
      setCameraFor(null);
    } catch (e) {
      Alert.alert('Camera', 'Could not capture the photo. Please try again.');
    }
  }, [cameraFor]);

  // ---- Loading date-time picker (native OS picker) -------------------------
  const applyDt = useCallback((which, dateObj) => {
    const s = fmtDateTime(dateObj);
    if (which === 'start') setLoadStartTime(s);
    else setLoadEndTime(s);
  }, []);

  // Open the native picker on the chosen field, seeded with its current value.
  // Android has no combined datetime dialog, so chain date -> time. iOS shows a
  // single inline datetime picker in a small modal (state below).
  const openDtPicker = useCallback(
    (which, currentStr) => {
      const base = parseDateTime(currentStr) || new Date();
      if (Platform.OS === 'android') {
        DateTimePickerAndroid.open({
          value: base,
          mode: 'date',
          is24Hour: true,
          onChange: (ev, pickedDate) => {
            if (ev.type !== 'set' || !pickedDate) return;
            DateTimePickerAndroid.open({
              value: pickedDate,
              mode: 'time',
              is24Hour: true,
              onChange: (ev2, pickedTime) => {
                if (ev2.type !== 'set' || !pickedTime) return;
                const final = new Date(pickedDate);
                final.setHours(pickedTime.getHours(), pickedTime.getMinutes(), 0, 0);
                applyDt(which, final);
              },
            });
          },
        });
      } else {
        setDtDraft(base);
        setDtPickerFor(which);
      }
    },
    [applyDt],
  );

  // iOS modal confirm.
  const commitDt = useCallback(() => {
    applyDt(dtPickerFor, dtDraft);
    setDtPickerFor(null);
  }, [applyDt, dtPickerFor, dtDraft]);

  // The suggestions actually shown under the Vehicle Number field: filtered by
  // whatever is typed (vehicle number OR driver name), de-duplicated by vehicle
  // number, and capped so the inline list never grows unwieldy. An empty field
  // (just focused) shows the most recent vehicles.
  const vehicleSuggestFiltered = useMemo(() => {
    const q = String(vehicleNo || '').trim().toUpperCase();
    const seen = {};
    const out = [];
    for (let i = 0; i < vehicleSuggest.length; i++) {
      const v = vehicleSuggest[i] || {};
      const veh = String(v.vehicle_no || '').toUpperCase();
      if (!veh) continue;
      // While typing, match against vehicle number or driver name. When the
      // typed text already equals a vehicle exactly, don't bother suggesting it.
      if (q) {
        if (veh === q) continue;
        const drv = String(v.driver_nm || '').toUpperCase();
        if (veh.indexOf(q) === -1 && drv.indexOf(q) === -1) continue;
      }
      const key = veh + '|' + String(v.driver_nm || '').toUpperCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(v);
      if (out.length >= 8) break;
    }
    return out;
  }, [vehicleSuggest, vehicleNo]);

  // What to SHOW. Prefer the readable short code, but fall back to the numeric
  // plant when the short code is missing.
  //
  // Those two come from different places: the number is on the employee's own
  // HR record, the short code is resolved through mst_plant. So an employee
  // can legitimately have a plant NUMBER while the lookup finds no matching
  // mst_plant row — and warning "no plant linked to your account" in that case
  // would be wrong and unactionable. Showing the number is honest and lets the
  // entry proceed; only a genuinely plant-less account gets the warning.
  const plantDisplay = plantCode || plantNo;

  // No plant at all. Shown in place of the value rather than as an alert: it is
  // a data problem for IT to fix, not something the user can act on by tapping
  // OK, and it must stay visible while they look at the screen. Students land
  // here too — they have no plant by definition.
  const plantMissing = plantLoaded && plantDisplay === '';

  // Get DIL Details. Sends the typed DIL No plus the session's numeric plant
  // (token / device / username are attached by apiPost automatically). The
  // response's `data` object is shown as-is, so new server fields appear with
  // no app change.
  // Once details are loaded (locked), the button is inactive until Reset.
  const canFetch =
    dilNo.trim() !== '' && !plantMissing && !productsLoading && !showEntry;

  // Fetch the product list (K-type -> digi DB, else SAP RFC) via
  // app_api/dil_product_list.php. Pure loader: returns the array, no state
  // changes — the orchestrator below manages loading / reveal / hydration.
  const loadProductList = useCallback(
    async (dil, date) => {
      const employeeId = (await getItem(KEYS.userId)) || '';
      // Get DIL Details carries the full USER context (DIL no, date, user plant
      // no + code). The backend resolves from/to plant from the DIL itself and
      // captures the whole draft server-side here, so header/plant logic can
      // change backend-only without an app release.
      // Longer bound: the backend may probe the RFC across a 7-day window
      // (selected date + prior days) when the DIL isn't on the exact date, so
      // this call can take longer than a normal request.
      const res = await apiPost(
        ENDPOINTS.dilApi,
        {
          rtype: '2',
          employee_id: employeeId,
          plant_no: plantNo, // numeric plant (HR record)
          plant_code: plantCode, // short/vc plant code
          wb_plant_code: (dilPlant && dilPlant.plant_code) || '', // top dropdown
          dil_no: dil,
          dil_date: date, // RFC's dildt (YYYY-MM-DD string) — window end date
        },
        { timeoutMs: 60000 },
      );
      const list = Array.isArray(res)
        ? res
        : (res && (res.data || res.products || res.items)) || [];
      return Array.isArray(list) ? list : [];
    },
    [plantNo, plantCode, dilPlant],
  );

  // Prefill driver / mobile / vehicle from the product header (K-DB source
  // carries DRIVER_* fields). Still editable; missing fields stay blank.
  const prefillDriverFromHead = useCallback(head => {
    if (!head) return;
    if (head.DRIVER_NAME) {
      setDriverName(
        String(head.DRIVER_NAME).toUpperCase().replace(/[^A-Z .]/g, ''),
      );
    }
    if (head.DRIVER_MOBILE) {
      setMobileNo(
        String(head.DRIVER_MOBILE).replace(/[^0-9]/g, '').slice(0, 10),
      );
    }
    if (head.DRIVER_VEHICLE) {
      setVehicleNo(
        String(head.DRIVER_VEHICLE).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      );
    }
  }, []);

  // Claim the DIL in our master table (status 1) as soon as details load, so the
  // entry exists in the DB from Get DIL Details onward. Non-blocking.
  const ensureDraft = useCallback(
    async (head, dil, dateStr) => {
      if (!head) return;
      try {
        const employeeId = (await getItem(KEYS.userId)) || '';
        await apiPost(ENDPOINTS.dilApi, {
          rtype: '5',
          employee_id: employeeId,
          dil_no: dil,
          dil_date: dateStr,
          plant_no: plantNo,
          plant_code: plantCode,
          wb_plant_code: (dilPlant && dilPlant.plant_code) || '', // top dropdown
          from_plant_code: head.RESWK || '',
          from_location: head.NAME1 || '',
          to_plant_code: head.WERKS || '',
          to_location: head.NAME2 || '',
          transporter: head.TNAME || '',
          transporter_code: head.TLIFNR || '',
          vehicle_type: head.VEHTP || '',
          loading_date: head.LDAT || '',
        });
      } catch (e) {
        // Non-blocking — the row is also upserted at Save/Submit.
      }
    },
    [plantNo, plantCode, dilPlant],
  );

  // Live batch stock (SAP − reserved) for a product, from rtype 4. Also captures
  // the material-level totals for the Live Stock table.
  //
  // The app forwards the DIL's RAW plant facts — the supplying (FROM / RESWK)
  // and destination (TO / WERKS) plant codes — and the BACKEND decides which
  // one the stock is read for (dil_stock_plant). So the "which plant" rule can
  // change server-side with no app release. A legacy plant_code is still sent
  // for older server builds.
  const fetchBatchStock = useCallback(async (matnr, fromPlant, toPlant, uom) => {
    setBatchStock([]);
    setMaterialStock(null);
    if (!matnr || (!fromPlant && !toPlant)) return;
    setBatchStockLoading(true);
    try {
      const employeeId = (await getItem(KEYS.userId)) || '';
      const res = await apiPost(ENDPOINTS.dilApi, {
        rtype: '4',
        employee_id: employeeId,
        material_code: matnr,
        from_plant_code: fromPlant || '',
        to_plant_code: toPlant || '',
        plant_code: fromPlant || toPlant || '', // legacy fallback
      });
      const list = res && res.data ? res.data : [];
      setBatchStock(Array.isArray(list) ? list : []);
      if (res && (res.material_total !== undefined)) {
        const total = parseFloat(res.material_total) || 0;
        const avail = parseFloat(res.material_available) || 0;
        setMaterialStock({
          total,
          available: avail,
          reserved: Math.max(total - avail, 0),
          uom: uom || '',
        });
      }
    } catch (e) {
      // Silent — the table/dropdown just won't populate; manual/scan still works.
    } finally {
      setBatchStockLoading(false);
    }
  }, []);

  // Live stock for ALL products in the DIL (rtype 8) — powers the summary table.
  const fetchAllStock = useCallback(
    async prods => {
      const list = prods || products;
      const mats = [];
      list.forEach(p => {
        const m = String(p.MATNR || '').trim();
        if (m && !mats.includes(m)) mats.push(m);
      });
      if (mats.length === 0) {
        setStockByMat({});
        return;
      }
      setStockRefreshing(true);
      try {
        const employeeId = (await getItem(KEYS.userId)) || '';
        // Forward the DIL's raw plant facts (FROM / RESWK and TO / WERKS). The
        // backend (dil_stock_plant) decides which one the stock is read for, so
        // that rule can change server-side with no app release.
        const head0 = list[0] || {};
        const fromPlant =
          String(head0.RESWK || '').trim() || plantCode || plantNo || '';
        const toPlant = String(head0.WERKS || '').trim();
        const res = await apiPost(ENDPOINTS.dilApi, {
          rtype: '8',
          employee_id: employeeId,
          dil_no: dilNo.trim(), // so the backend excludes THIS DIL from "reserved"
          from_plant_code: fromPlant,
          to_plant_code: toPlant,
          plant_code: fromPlant || toPlant, // legacy fallback
          materials: mats.join(','),
        });
        const data = res && res.data ? res.data : [];
        const map = {};
        data.forEach(r => {
          map[String(r.material_code).toUpperCase()] = r;
        });
        setStockByMat(map);
        const now = new Date();
        const pad2 = n => String(n).padStart(2, '0');
        setStockUpdatedAt(
          `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
        );
      } catch (e) {
        // Silent — table just won't populate.
      } finally {
        setStockRefreshing(false);
      }
    },
    [products, plantCode, plantNo, dilNo],
  );

  const fetchDilDetails = useCallback(async () => {
    const dil = dilNo.trim();
    if (dil === '' || plantMissing) return;
    const dateStr = toApi(dilDate);

    setProductsLoading(true);
    // Clear any previous entry state before loading.
    setProducts([]);
    setSelectedEbelp(null);
    setBatchesByEbelp({});
    setAddedEbelps([]);
    setDriverName('');
    setMobileNo('');
    setVehicleNo('');
    setLrNumber('');
    setSealNo('');
    setSealNo2('');
    setVehicleTemp('');
    setLoadPhotos({ vehicle_front: null, before_loading: null, after_loading: null });
    setExistingPhotos({ vehicle_front: null, before_loading: null, after_loading: null });
    setDispatchExists(false);
    setLoadStartTime('');
    setLoadEndTime('');
    setDockNo('');
    setPalletQty('');
    setPalletWeight('');
    setShowEntry(false);

    try {
      const employeeId = (await getItem(KEYS.userId)) || '';

      // Steps 1 and 2 run IN PARALLEL to cut the wait on slow networks:
      //   rtype 1 — is this DIL already in our system? (fast DB lookup; a draft
      //             is remembered so we can resume it, a submitted one blocks).
      //   rtype 2 — the product list (the slow call: the backend may probe the
      //             RFC / SAP across a date window).
      // They are independent, so firing both at once makes the total wait the
      // slower of the two (the product list) instead of their sum.
      const existingPromise = apiPost(
        ENDPOINTS.dilApi,
        { rtype: '1', employee_id: employeeId, dil_no: dil },
        { timeoutMs: 30000 },
      )
        .then(ex => (ex && ex.data ? ex.data : null))
        .catch(e => {
          if (e && e.sessionExpired) throw e; // real auth failure -> surface it
          return null; // status check failed -> treat as a fresh entry
        });
      const listPromise = loadProductList(dil, dateStr);

      // A rejection from Promise.all here means a request FAILED (timeout /
      // dropped connection / server error) — NOT that the DIL is missing. A
      // genuinely empty product list resolves to [] and is handled just below.
      const [existingResult, list] = await Promise.all([
        existingPromise,
        listPromise,
      ]);
      let existing = existingResult;

      // Already submitted (2) or weighbridge-complete (4) -> cannot re-enter.
      if (
        existing &&
        (String(existing.status) === '2' || String(existing.status) === '4')
      ) {
        Alert.alert(
          'Already Processed',
          'This DIL has already been submitted and cannot be entered again.',
        );
        return;
      }

      // 2. Product list (fetched above). An EMPTY list is the only real
      // "not found": the DIL/date genuinely has no products in SAP.
      if (!list.length) {
        Alert.alert('No Data Found...!', 'Please verify DIL No & Date.');
        return;
      }
      setProducts(list);

      // The DIL may have been found on a date within the window (RFC walk-back
      // or the K-type BETWEEN) rather than the exact selected date. The backend
      // returns that ACTUAL date as DIL_DATE on the header row. Use it for the
      // draft refresh and show it, so the DB record and the screen both reflect
      // the real DIL date instead of the selected one.
      const actualApiDate = String(
        (list[0] && list[0].DIL_DATE) || dateStr,
      ).trim();
      if (actualApiDate !== dateStr) {
        const ad = fromApi(actualApiDate);
        if (ad) setDilDate(ad);
      }

      // Reusable: apply a resolved draft (header + dispatch + saved batches) to
      // the UI. Used for the initial paint AND after the background reconcile.
      const applyExistingDraft = ex => {
        setDriverName(String(ex.driver_name || '').toUpperCase());
        setMobileNo(
          String(ex.mobile_no || '').replace(/[^0-9]/g, '').slice(0, 10),
        );
        setVehicleNo(
          String(ex.vehicle_no || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        );
        setLrNumber(
          String(ex.lr_number || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 20),
        );
        setSealNo(
          String(ex.seal_no || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 30),
        );
        setSealNo2(
          String(ex.seal_no2 || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 30),
        );
        setVehicleTemp(String(ex.vehicle_temp == null ? '' : ex.vehicle_temp));
        setDockNo(String(ex.dock_no || ''));
        setPalletQty(String(ex.pallet_qty || ''));
        setPalletWeight(String(ex.pallet_weight || ''));

        // Dispatch record (prod_dtl_data form 1170): re-populate seals, temp,
        // loading times, dock and mark already-uploaded photos.
        const disp = ex.dispatch;
        if (disp) {
          if (disp.seal_1) {
            setSealNo(
              String(disp.seal_1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30),
            );
          }
          setSealNo2(
            String(disp.seal_2 || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30),
          );
          setVehicleTemp(String(disp.vehicle_temp == null ? '' : disp.vehicle_temp));
          if (disp.dock_id) setDockNo(String(disp.dock_id));
          setLoadStartTime(sqlToDisplayDt(disp.start_loading_dt));
          setLoadEndTime(sqlToDisplayDt(disp.end_loading_dt));
          setExistingPhotos({
            vehicle_front: disp.img_vehicle || null,
            before_loading: disp.img_before || null,
            after_loading: disp.img_after || null,
          });
          setDispatchExists(true);
        } else {
          setExistingPhotos({
            vehicle_front: null,
            before_loading: null,
            after_loading: null,
          });
          setDispatchExists(false);
        }

        const added = [];
        const batchMap = {};
        (ex.products || []).forEach(sp => {
          const match = list.find(
            p => String(p.EBELP) === String(sp.line_item),
          );
          const key = match ? String(match.EBELP) : String(sp.line_item);
          // Persisted batches come back saved (with their batch id) so they show
          // locked with a Delete, matching the per-batch save flow.
          batchMap[key] = (sp.batches || []).map(b => ({
            batchNo: String(b.batch_no || ''),
            qty: String(b.qty || ''),
            saved: true,
            batchId: b.batch_id || null,
          }));
          // Any product with saved batches belongs on the list card (Pending
          // until its qty is met, then Complete).
          if ((sp.batches || []).length > 0) {
            added.push(key);
          }
        });
        setBatchesByEbelp(batchMap);
        setAddedEbelps(added);
      };

      const isDraft = existing && String(existing.status) === '1';

      // ---- PROGRESSIVE PAINT -------------------------------------------
      // Claim the draft and kick off live stock (both non-blocking), prefill
      // the header + products from the saved state, then reveal the usable form
      // IMMEDIATELY. The slower SAP reconcile runs afterwards in the background,
      // so the user never stares at a blank loader waiting for it. The Live
      // Stock table already shows "…" placeholders until its data arrives.
      ensureDraft(list[0], dil, actualApiDate);
      fetchAllStock(list);
      if (isDraft) {
        applyExistingDraft(existing);
      } else {
        // Fresh entry: prefill driver from the product header (K-DB only).
        prefillDriverFromHead(list[0]);
      }
      setShowEntry(true);
      setProductsLoading(false); // form is interactive now

      // ---- BACKGROUND RECONCILE ----------------------------------------
      // Only for drafts that already have saved products. If the DIL changed in
      // SAP since we saved (a line dropped, a qty cut/updated), the server
      // releases stale reservations; we re-apply the cleaned state and tell the
      // user. Never blocks the form — a small "Syncing…" note shows meanwhile.
      if (isDraft && existing.products && existing.products.length) {
        setSyncingSaved(true);
        (async () => {
          try {
            const empId = (await getItem(KEYS.userId)) || '';
            const rec = await apiPost(ENDPOINTS.dilApi, {
              rtype: '9',
              employee_id: empId,
              dil_no: dil,
              products: JSON.stringify(
                list.map(p => ({
                  li: String(p.EBELP),
                  mc: String(p.MATNR || ''),
                  qty: String(p.MENGE || ''),
                })),
              ),
            });
            const removed = (rec && rec.removed) || [];
            const reduced = (rec && rec.reduced) || [];
            const changed = (rec && rec.changed) || [];
            if (removed.length || reduced.length || changed.length) {
              // Re-apply the corrected saved state so the cards reflect cleanup.
              try {
                const ex2 = await apiPost(ENDPOINTS.dilApi, {
                  rtype: '1',
                  employee_id: empId,
                  dil_no: dil,
                });
                if (ex2 && ex2.data) applyExistingDraft(ex2.data);
              } catch (e2) {
                // reload failed: keep the pre-reconcile view
              }
              const msg = [];
              removed.forEach(c =>
                msg.push(`• ${c}: removed in SAP — its saved batches were cleared.`),
              );
              reduced.forEach(x =>
                msg.push(
                  `• ${x.code}: quantity changed ${x.old} → ${x.new}. Saved batches exceeded the new quantity, so they were cleared — please re-enter.`,
                ),
              );
              changed.forEach(x =>
                msg.push(`• ${x.code}: quantity updated ${x.old} → ${x.new}.`),
              );
              Alert.alert(
                'DIL updated in SAP',
                `Some products changed since you last saved:\n\n${msg.join('\n')}`,
              );
              fetchAllStock(list); // reservations changed -> refresh stock
            }
          } catch (e) {
            // Best effort; the form already works with the saved state.
          } finally {
            setSyncingSaved(false);
          }
        })();
      }
    } catch (e) {
      // Reaching here means a request FAILED (timeout / dropped connection /
      // server error) — NOT that the DIL is missing (a missing DIL is handled
      // above as an empty list). So we never show "verify DIL No & Date" here,
      // which used to wrongly blame the user's input when the network was slow.
      if (e && e.sessionExpired) {
        // Handled by the session layer (it shows its own re-login prompt).
      } else {
        const m = String((e && e.message) || '');
        const network =
          /time|timed out|connection|network|failed to fetch|empty server response/i.test(
            m,
          );
        Alert.alert(
          network ? 'Connection problem' : 'Something went wrong',
          network
            ? 'The server took too long to respond or the connection dropped. Please check your internet and tap Get DIL Details again.'
            : 'Could not load the DIL right now. Please try again in a moment.',
        );
      }
    } finally {
      setProductsLoading(false);
    }
  }, [
    dilNo,
    dilDate,
    plantMissing,
    loadProductList,
    prefillDriverFromHead,
    ensureDraft,
    fetchAllStock,
  ]);

  // Reset everything back to a fresh entry: clears the DIL inputs, the fetched
  // products, and the dispatch fields, and re-enables DIL No / DIL Date.
  const resetAll = useCallback(() => {
    setDilNo('');
    setDilDate(new Date());
    setDriverName('');
    setMobileNo('');
    setVehicleNo('');
    setLrNumber('');
    setSealNo('');
    setSealNo2('');
    setVehicleTemp('');
    setLoadPhotos({ vehicle_front: null, before_loading: null, after_loading: null });
    setExistingPhotos({ vehicle_front: null, before_loading: null, after_loading: null });
    setDispatchExists(false);
    setLoadStartTime('');
    setLoadEndTime('');
    setDockNo('');
    setProducts([]);
    setProductsLoading(false);
    setSelectedEbelp(null);
    setProductPickerOpen(false);
    setScannerOpen(false);
    setScanTarget(null);
    setBatchesByEbelp({});
    setAddedEbelps([]);
    setBatchStock([]);
    setMaterialStock(null);
    setStockByMat({});
    setStockUpdatedAt('');
    setStockRefreshing(false);
    setBatchPicker(null);
    setPalletQty('');
    setPalletWeight('');
    setShowEntry(false);
  }, []);

  // ---- Batch helpers (operate on the selected product's line) -------------
  const currentBatches =
    selectedEbelp != null ? batchesByEbelp[selectedEbelp] || [] : [];

  const addBatch = useCallback(() => {
    if (selectedEbelp == null) return;
    setBatchesByEbelp(m => ({
      ...m,
      [selectedEbelp]: [
        ...(m[selectedEbelp] || []),
        { batchNo: '', qty: '', saved: false, batchId: null },
      ],
    }));
  }, [selectedEbelp]);

  const updateBatch = useCallback(
    (index, field, value) => {
      if (selectedEbelp == null) return;
      setBatchesByEbelp(m => {
        const arr = [...(m[selectedEbelp] || [])];
        if (!arr[index]) return m;
        if (arr[index].saved) return m; // locked once saved
        arr[index] = { ...arr[index], [field]: value };
        return { ...m, [selectedEbelp]: arr };
      });
    },
    [selectedEbelp],
  );

  const openScanner = useCallback(target => {
    setScanTarget(target);
    setScannerOpen(true);
  }, []);

  // Remove a committed product entirely: delete its persisted batches from the
  // DB (releasing their reservations), then drop it from the list.
  const removeAddedProduct = useCallback(
    async ebelp => {
      const rows = batchesByEbelp[ebelp] || [];
      try {
        const employeeId = (await getItem(KEYS.userId)) || '';
        for (let i = 0; i < rows.length; i++) {
          const b = rows[i];
          if (b && b.saved && b.batchId) {
            // eslint-disable-next-line no-await-in-loop
            await apiPost(ENDPOINTS.dilApi, {
              rtype: '7',
              employee_id: employeeId,
              batch_id: b.batchId,
            });
          }
        }
      } catch (e) {
        if (e && e.sessionExpired) return;
        // otherwise fall through and clear the UI anyway
      }
      setBatchesByEbelp(m => {
        const c = { ...m };
        delete c[ebelp];
        return c;
      });
      setAddedEbelps(a => a.filter(e => e !== String(ebelp)));
    },
    [batchesByEbelp],
  );

  // Edit a committed product: pull it out of the added list and back into the
  // working area with its existing (saved) batches, ready to adjust.
  const editAddedProduct = useCallback(ebelp => {
    // Keep it in the card list; just open it in the working area. The card render
    // hides whichever product is currently selected to avoid showing it twice.
    setSelectedEbelp(ebelp);
  }, []);

  // A scan either selects a product (matched on MATNR) or fills a batch number,
  // depending on what opened the scanner.
  const onScanned = useCallback(
    raw => {
      setScannerOpen(false);
      const value = String(raw || '').trim();
      const target = scanTarget;
      setScanTarget(null);
      if (!value) return;

      if (target && typeof target === 'object' && target.type === 'batch') {
        // Fill that batch row's number (the row belongs to the product that
        // was selected when the scanner was opened).
        setBatchesByEbelp(m => {
          const arr = [...(m[target.ebelp] || [])];
          if (!arr[target.index]) return m;
          arr[target.index] = {
            ...arr[target.index],
            batchNo: value.toUpperCase(),
          };
          return { ...m, [target.ebelp]: arr };
        });
        return;
      }

      // Product select: exact MATNR first, then a contains match.
      const code = value.toUpperCase();
      let match = products.find(
        p => String(p.MATNR || '').toUpperCase() === code,
      );
      if (!match) {
        match = products.find(
          p => p.MATNR && code.includes(String(p.MATNR).toUpperCase()),
        );
      }
      if (!match) {
        Alert.alert(
          'Product Not Found',
          'The scanned code does not match any product in this DIL.',
        );
      } else if (addedEbelps.includes(String(match.EBELP))) {
        Alert.alert(
          'Already Added',
          'This product is already in the added list below.',
        );
      } else {
        chooseProduct(match);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [products, scanTarget, addedEbelps, stockByMat, batchesByEbelp],
  );


  // Once details are loaded, DIL No + DIL Date are locked — changing them would
  // desync the shown products from the entry. Use Reset to start a new DIL.
  const locked = showEntry;

  // DIL header — every RFC row repeats the document-level fields, so read them
  // off the first row.
  const head = products.length > 0 ? products[0] : null;

  // The product currently chosen in the dropdown.
  const selectedProduct =
    products.find(p => String(p.EBELP) === String(selectedEbelp)) || null;

  // Label shown for a product: "MATNR - Material Name (Line N · Qty)". The line
  // item + qty distinguish two DIL lines that carry the SAME material, so they
  // never look like accidental duplicates.
  const productLabel = p => {
    const base = `${String(p.MATNR || '')}${p.TXZ01 ? ' - ' + p.TXZ01 : ''}`;
    const li =
      p.EBELP !== undefined && p.EBELP !== null && String(p.EBELP) !== ''
        ? 'Line ' + String(p.EBELP)
        : '';
    const qty = p.MENGE ? fmtQty(p.MENGE) + (p.MEINS ? ' ' + p.MEINS : '') : '';
    const meta = [li, qty].filter(Boolean).join(' · ');
    return meta ? `${base} (${meta})` : base;
  };

  // Refetch batch stock whenever the selected product changes.
  // Plant: the DIL's supplying / FROM plant (RESWK) — the plant that holds the
  // goods being dispatched; fall back to the logged-in user's plant only when
  // the row carries no from-plant.
  useEffect(() => {
    const sp = products.find(p => String(p.EBELP) === String(selectedEbelp));
    if (sp) {
      fetchBatchStock(
        sp.MATNR,
        sp.RESWK || plantCode || plantNo || '',
        sp.WERKS || '',
        sp.MEINS || '',
      );
    } else {
      setBatchStock([]);
      setMaterialStock(null);
    }
  }, [selectedEbelp, products, plantCode, plantNo, fetchBatchStock]);

  // AUTO-REFRESH: while the entry module is open, re-pull live stock every 20s
  // so figures stay accurate against other users' reservations — reducing the
  // chance of a wrong entry. Also refreshes the open batch dropdown.
  // Paused when the app is backgrounded or the Live Stock section is collapsed,
  // so no network/CPU is spent on data the user can't see.
  useEffect(() => {
    if (!showEntry || !appActive || collapsed.stock) return undefined;
    const id = setInterval(() => {
      fetchAllStock();
      const sp = products.find(p => String(p.EBELP) === String(selectedEbelp));
      if (sp) {
        fetchBatchStock(
          sp.MATNR,
          sp.RESWK || plantCode || plantNo || '',
          sp.WERKS || '',
          sp.MEINS || '',
        );
      }
    }, 20000);
    return () => clearInterval(id);
  }, [
    showEntry,
    appActive,
    collapsed.stock,
    selectedEbelp,
    products,
    plantCode,
    plantNo,
    fetchAllStock,
    fetchBatchStock,
  ]);

  // Stock row for a given batch number (null when the batch isn't in SAP list,
  // e.g. a manually-typed batch — no stock check applies then).
  const batchInfoFor = batchNo => {
    const key = String(batchNo || '').trim().toUpperCase();
    if (!key) return null;
    return (
      batchStock.find(x => String(x.batch_no).toUpperCase() === key) || null
    );
  };

  // Quantity tally for the selected product: entered vs required (MENGE).
  const enteredQty = currentBatches.reduce(
    (s, b) => s + (parseFloat(b.qty) || 0),
    0,
  );
  const requiredQty = selectedProduct
    ? parseFloat(selectedProduct.MENGE) || 0
    : 0;
  const qtyMatches =
    selectedProduct && Math.abs(enteredQty - requiredQty) < 0.0001;
  const qtyOver = enteredQty - requiredQty > 0.0001;

  // Products still available to pick (not already added).
  const availableProducts = products.filter(
    p => !addedEbelps.includes(String(p.EBELP)),
  );

  // Material-level available stock for a product (from the Live Stock table).
  // Returns null when there is no figure yet — we don't block on an unknown.
  const availForProduct = p => {
    const s = p && stockByMat[String(p.MATNR || '').toUpperCase()];
    return s ? parseFloat(s.available) || 0 : null;
  };

  // Select a product, but HARD-BLOCK a fresh pick whose available stock is less
  // than the quantity the DIL requires — it can't be dispatched, so it can't be
  // entered. A product the user has already saved batches for stays selectable
  // so they can finish or edit it (its own reservation is what lowers its
  // "available"). When we have no stock figure yet, we don't block.
  const chooseProduct = p => {
    if (!p) return;
    const rows = batchesByEbelp[p.EBELP] || batchesByEbelp[String(p.EBELP)] || [];
    const alreadyStarted = rows.some(r => r.saved);
    const required = parseFloat(p.MENGE) || 0;
    const avail = availForProduct(p); // null when not loaded yet
    if (!alreadyStarted && avail !== null && avail + 0.0001 < required) {
      const uom = p.MEINS ? ' ' + p.MEINS : '';
      Alert.alert(
        'Not enough stock',
        `${String(p.MATNR || '')}${p.TXZ01 ? ' - ' + p.TXZ01 : ''} needs ${fmtQty(
          required,
        )}${uom}, but only ${fmtQty(
          avail,
        )}${uom} is available right now. It can't be entered until enough stock is available.`,
      );
      return;
    }
    setSelectedEbelp(p.EBELP);
  };

  // Products shown in the list card = every product that currently has at least
  // one saved batch — including the one open in the working area, which appears
  // here as "Pending" and updates live as its batches are saved.
  const cardEbelps = addedEbelps.filter(e => {
    const rows = batchesByEbelp[e] || batchesByEbelp[String(e)] || [];
    return rows.some(b => b.saved);
  });

  // Remove a batch row. If persisted (batchId), delete it in the DB first
  // (releases its reservation), then remove locally and refresh stock.
  const removeBatch = useCallback(
    async index => {
      if (selectedEbelp == null) return;
      const arr = batchesByEbelp[selectedEbelp] || [];
      const b = arr[index];
      if (b && b.saved && b.batchId) {
        try {
          const employeeId = (await getItem(KEYS.userId)) || '';
          await apiPost(ENDPOINTS.dilApi, {
            rtype: '7',
            employee_id: employeeId,
            batch_id: b.batchId,
          });
        } catch (e) {
          if (!e || !e.sessionExpired) {
            Alert.alert('Could not remove', 'Please try again.');
            return;
          }
        }
      }
      setBatchesByEbelp(m => {
        const cur = [...(m[selectedEbelp] || [])];
        cur.splice(index, 1);
        return { ...m, [selectedEbelp]: cur };
      });
      if (selectedProduct) {
        fetchBatchStock(
          selectedProduct.MATNR,
          selectedProduct.RESWK || plantCode || plantNo || '',
          selectedProduct.WERKS || '',
          selectedProduct.MEINS || '',
        );
      }
      fetchAllStock();
    },
    [
      selectedEbelp,
      batchesByEbelp,
      selectedProduct,
      plantCode,
      plantNo,
      fetchBatchStock,
      fetchAllStock,
    ],
  );

  // Persist one batch row (rtype 6). Locks + reserves on success; when the
  // product's saved batches reach its planned qty, it moves to the card.
  const saveBatchRow = useCallback(
    async index => {
      const sp = selectedProduct;
      if (!sp) return;
      const arr = batchesByEbelp[selectedEbelp] || [];
      const b = arr[index];
      if (!b || b.saved) return;

      const batchNo = String(b.batchNo || '').trim().toUpperCase();
      const qty = parseFloat(b.qty) || 0;
      if (batchNo === '') {
        Alert.alert('Batch required', 'Select or enter a batch number.');
        return;
      }
      if (qty <= 0) {
        Alert.alert('Quantity required', 'Enter a quantity greater than zero.');
        return;
      }
      const info = batchInfoFor(batchNo);
      if (info && qty - (parseFloat(info.available) || 0) > 0.0001) {
        Alert.alert(
          'Batch quantity too high',
          `Batch ${batchNo} has only ${info.available}${info.uom ? ' ' + info.uom : ''} available in stock. Please enter that much or less.`,
        );
        return;
      }
      const otherSum = arr.reduce(
        (s, x, j) => (j === index ? s : s + (parseFloat(x.qty) || 0)),
        0,
      );
      if (otherSum + qty - requiredQty > 0.0001) {
        Alert.alert(
          'Quantity too high',
          `The batches for this product add up to more than the required ${fmtQty(
            requiredQty,
          )}${sp.MEINS ? ' ' + sp.MEINS : ''}. Please reduce the quantity.`,
        );
        return;
      }

      // Double-submit guard: if a save is already running, ignore this tap. The
      // ref is set BEFORE the first await below, so a rapid second tap is
      // blocked here instead of firing a duplicate rtype 6 insert.
      if (savingBatchRef.current) return;
      savingBatchRef.current = true;
      setSavingBatchIdx(index);

      try {
        const employeeId = (await getItem(KEYS.userId)) || '';
        const res = await apiPost(ENDPOINTS.dilApi, {
          rtype: '6',
          employee_id: employeeId,
          dil_no: dilNo.trim(),
          material_code: sp.MATNR,
          material_name: sp.TXZ01 || '',
          line_item: sp.EBELP,
          planned_qty: sp.MENGE,
          uom: sp.MEINS || '',
          net_weight: sp.NTGEW || '',
          gross_weight: sp.BRGEW || '',
          weight_uom: sp.GEWEI || '',
          batch_no: batchNo,
          qty: String(qty),
          // Forward the DIL's raw plant facts; the backend decides the plant to
          // reserve against (dil_stock_plant), matching the stock shown above.
          from_plant_code: sp.RESWK || plantCode || plantNo || '',
          to_plant_code: sp.WERKS || '',
          plant_code: sp.RESWK || plantCode || plantNo || '', // legacy fallback
        });

        if (res && String(res.statusCode) === '200' && res.batch_id) {
          // Mark the row saved. Keep the other (unsaved) working rows so the user
          // can keep adding batches without leaving; leftovers are pruned only
          // once the product is complete (below).
          setBatchesByEbelp(m => {
            const cur = [...(m[selectedEbelp] || [])];
            if (!cur[index]) return m;
            cur[index] = { ...cur[index], batchNo, saved: true, batchId: res.batch_id };
            return { ...m, [selectedEbelp]: cur };
          });

          // Show the product in the list card straight away — as "Pending" until
          // its saved batches reach the required qty, then "Complete". It stays
          // open in the working area so the next batch can be added right away.
          setAddedEbelps(a =>
            a.includes(String(selectedEbelp)) ? a : [...a, String(selectedEbelp)],
          );

          // New saved total for this product. When it meets the requirement, drop
          // any leftover unsaved row and close the working area (Complete);
          // otherwise stay put so the user can add the next batch.
          const savedTotal = arr.reduce((s, x, j) => {
            const q = j === index ? qty : parseFloat(x.qty) || 0;
            const isSaved = j === index ? true : x.saved;
            return s + (isSaved ? q : 0);
          }, 0);
          if (Math.abs(savedTotal - requiredQty) < 0.0001) {
            setBatchesByEbelp(m => ({
              ...m,
              [selectedEbelp]: (m[selectedEbelp] || []).filter(b => b.saved),
            }));
            setSelectedEbelp(null);
          } else {
            fetchBatchStock(
              sp.MATNR,
              sp.RESWK || plantCode || plantNo || '',
              sp.WERKS || '',
              sp.MEINS || '',
            );
          }
          fetchAllStock();
        } else {
          Alert.alert('Could not save', (res && res.message) || 'Please try again.');
          fetchBatchStock(
            sp.MATNR,
            sp.RESWK || plantCode || plantNo || '',
            sp.WERKS || '',
            sp.MEINS || '',
          );
        }
      } catch (e) {
        if (!e || !e.sessionExpired) {
          Alert.alert('Could not save', 'Please try again.');
        }
      } finally {
        // Always release the guard so the next (real) save can proceed.
        savingBatchRef.current = false;
        setSavingBatchIdx(null);
      }
    },
    [
      selectedProduct,
      batchesByEbelp,
      selectedEbelp,
      dilNo,
      plantCode,
      plantNo,
      requiredQty,
      batchInfoFor,
      fetchBatchStock,
      fetchAllStock,
    ],
  );

  // Save (status 1) or Submit (status 2). Both need the header fields valid.
  // A plain SAVE (draft) may be stored with NO products yet — so the driver /
  // mobile / vehicle / LR already entered are never lost. Only SUBMIT requires
  // at least one added product (and every one fully batched).
  // The actual persist (header + status). Products & batches are already saved
  // via rtype 6/7, so this only writes the header and the status. allowPartial
  // is forwarded so a CONFIRMED short submit is accepted by the backend (which
  // otherwise requires every product fully batched); shortRemark carries the
  // reason captured in the short-submit modal (empty for a full submit / save).
  // Write the dispatch record (prod_dtl_data form 1170) + the 3 photos via the
  // dedicated endpoint. Called from the save flow only when a dock is chosen and
  // at least one photo exists. Backend inserts first time / updates after and
  // links nu_data_no on the master. Heavy POST (base64) -> longer timeout.
  const saveDispatch = useCallback(async () => {
    let loaded = 0;
    products.forEach(p => {
      const rows =
        batchesByEbelp[p.EBELP] || batchesByEbelp[String(p.EBELP)] || [];
      loaded += rows.reduce(
        (s, b) => s + (b.saved ? parseFloat(b.qty) || 0 : 0),
        0,
      );
    });
    const employeeId = (await getItem(KEYS.userId)) || '';
    return apiPost(
      ENDPOINTS.dilDispatchSave,
      {
        employee_id: employeeId,
        dil_no: dilNo.trim(),
        section_no: String(sectionNo || '').trim(),
        start_loading_dt: toSqlDateTime(loadStartTime),
        end_loading_dt: toSqlDateTime(loadEndTime),
        dock_id: String(dockNo || '').trim(),
        loaded_qty: String(loaded),
        vehicle_no: vehicleNo.trim(),
        vehicle_temp: String(vehicleTemp || '').trim(),
        seal_1: sealNo.trim(),
        seal_2: sealNo2.trim(),
        img_vehicle: loadPhotos.vehicle_front
          ? base64Only(loadPhotos.vehicle_front)
          : '',
        img_before: loadPhotos.before_loading
          ? base64Only(loadPhotos.before_loading)
          : '',
        img_after: loadPhotos.after_loading
          ? base64Only(loadPhotos.after_loading)
          : '',
      },
      { timeoutMs: 60000 },
    );
  }, [
    products,
    batchesByEbelp,
    dilNo,
    sectionNo,
    loadStartTime,
    loadEndTime,
    dockNo,
    vehicleNo,
    vehicleTemp,
    sealNo,
    sealNo2,
    loadPhotos,
  ]);

  // "View" on a photo tile. A freshly captured photo is shown immediately from
  // its in-memory data URI; an already-uploaded one is fetched from the server
  // (by slot) as base64. Errors are surfaced and the viewer is closed.
  const openPhotoViewer = useCallback(
    async (slotKey, label) => {
      const fresh = loadPhotos[slotKey];
      if (fresh) {
        setPhotoViewer({ open: true, uri: fresh, loading: false, label });
        return;
      }
      if (!existingPhotos[slotKey]) {
        return;
      }
      setPhotoViewer({ open: true, uri: null, loading: true, label });
      try {
        const res = await apiPost(
          ENDPOINTS.dilDispatchImage,
          { dil_no: dilNo.trim(), slot: SLOT_API[slotKey] },
          { timeoutMs: 30000 },
        );
        if (res && String(res.statusCode) === '200' && res.image) {
          setPhotoViewer({ open: true, uri: res.image, loading: false, label });
        } else {
          setPhotoViewer({ open: false, uri: null, loading: false, label: '' });
          Alert.alert('View photo', (res && res.message) || 'Could not load the photo.');
        }
      } catch (e) {
        setPhotoViewer({ open: false, uri: null, loading: false, label: '' });
        Alert.alert('View photo', 'Could not load the photo. Please try again.');
      }
    },
    [loadPhotos, existingPhotos, dilNo],
  );

  const persistEntry = useCallback(
    async (submitStatus, allowPartial, shortRemark) => {
      setSaveCaption(submitStatus === 2 ? 'Submitting' : 'Saving');
      setSaving(true);
      try {
        const employeeId = (await getItem(KEYS.userId)) || '';
        const res = await apiPost(ENDPOINTS.dilApi, {
          rtype: '3',
          employee_id: employeeId,
          section_no: String(sectionNo || '').trim(),
          dil_no: dilNo.trim(),
          driver_name: driverName.trim(),
          mobile_no: mobileNo,
          vehicle_no: vehicleNo,
          lr_number: lrNumber.trim(),
          seal_number: sealNo.trim(),
          seal_number2: sealNo2.trim(),
          vehicle_temp: String(vehicleTemp || '').trim(),
          dock_no: String(dockNo || '').trim(),
          pallet_qty: palletQty,
          pallet_weight: palletWeight,
          wb_plant_code: (dilPlant && dilPlant.plant_code) || '', // top dropdown
          allow_partial: allowPartial ? '1' : '0',
          short_remark: shortRemark || '',
          status: String(submitStatus),
        });

        if (res && String(res.statusCode) === '200') {
          // Dispatch record (form 1170) + photos — only when a dock is chosen
          // and at least one photo is taken. Non-fatal: the DIL itself is
          // already saved, so a failure here just asks the user to save again.
          let dispatchWarn = '';
          // Write/refresh the dispatch row when there is a dock and at least one
          // photo (freshly captured OR already uploaded), or a dispatch row
          // already exists (so edits to seals/temp/times are saved on re-save).
          const anyPhoto = !!(
            loadPhotos.vehicle_front ||
            loadPhotos.before_loading ||
            loadPhotos.after_loading ||
            existingPhotos.vehicle_front ||
            existingPhotos.before_loading ||
            existingPhotos.after_loading ||
            dispatchExists
          );
          if (String(dockNo || '').trim() !== '' && anyPhoto) {
            setSaveCaption('Uploading photos');
            try {
              const dres = await saveDispatch();
              if (!dres || dres.status !== 'success') {
                dispatchWarn =
                  '\n\nNote: the dispatch photos/details could not be saved — please Save again.';
              }
            } catch (e) {
              if (e && e.sessionExpired) throw e;
              dispatchWarn =
                '\n\nNote: the dispatch photos/details could not be saved — please Save again.';
            }
          }
          Alert.alert(
            submitStatus === 2 ? 'Submitted' : 'Saved',
            (submitStatus === 2
              ? 'Data Submitted Successfully...!'
              : 'Data Save Successfully...!') + dispatchWarn,
            // Submit finishes the DIL -> reset for the next one. Save keeps the
            // current DIL loaded so the user can carry on editing.
            [{ text: 'OK', onPress: () => { if (submitStatus === 2) resetAll(); } }],
          );
        } else {
          Alert.alert(
            'Could not save',
            (res && res.message) || 'Please try again.',
          );
        }
      } catch (e) {
        if (!e || !e.sessionExpired) {
          Alert.alert('Could not save', 'Please try again.');
        }
      } finally {
        setSaving(false);
      }
    },
    [dilNo, driverName, mobileNo, vehicleNo, lrNumber, sealNo, sealNo2, vehicleTemp, dockNo, palletQty, palletWeight, dilPlant, sectionNo, loadPhotos, existingPhotos, dispatchExists, saveDispatch, resetAll],
  );

  const saveEntry = useCallback(
    async submitStatus => {
      if (submitStatus === 2 && addedEbelps.length === 0) {
        Alert.alert(
          'Nothing to submit',
          'Add at least one product before submitting.',
        );
        return;
      }
      // Header fields are required for BOTH Save and Submit.
      if (driverName.trim() === '') {
        Alert.alert('Driver required', 'Please enter the driver name.');
        return;
      }
      if (!MOBILE_RE.test(mobileNo)) {
        Alert.alert('Invalid mobile', 'Enter a valid 10-digit mobile number.');
        return;
      }
      if (!VEHICLE_RE.test(vehicleNo)) {
        Alert.alert('Invalid vehicle', 'Enter a valid vehicle number.');
        return;
      }
      if (lrNumber.trim() === '') {
        Alert.alert('LR Number required', 'Please enter the LR number.');
        return;
      }
      // Dock is mandatory to SUBMIT (a draft can be saved without it).
      if (submitStatus === 2 && String(dockNo || '').trim() === '') {
        Alert.alert('Dock required', 'Please select a dock before submitting.');
        return;
      }
      // All three dispatch photos are mandatory to SUBMIT.
      if (submitStatus === 2) {
        const missing = LOAD_PHOTOS.filter(
          ph => !loadPhotos[ph.key] && !existingPhotos[ph.key],
        );
        if (missing.length > 0) {
          Alert.alert(
            'Photos required',
            'Please capture these photos before submitting:\n\n' +
              missing.map(m => '• ' + m.label).join('\n'),
          );
          return;
        }
      }

      // On SUBMIT: any product short of its full planned qty no longer BLOCKS —
      // instead we open the reason modal, and submit the reduced quantity only
      // after the user picks a reason and confirms.
      if (submitStatus === 2) {
        const short = products
          .map(p => {
            const required = parseFloat(p.MENGE) || 0;
            const rows =
              batchesByEbelp[p.EBELP] || batchesByEbelp[String(p.EBELP)] || [];
            const total = rows.reduce(
              (s, b) => s + (b.saved ? parseFloat(b.qty) || 0 : 0),
              0,
            );
            return { p, required, total };
          })
          .filter(x => x.required > 0 && x.total < x.required - 0.0001);
        if (short.length > 0) {
          const lines = short
            .map(x => {
              const uom = x.p.MEINS ? ' ' + x.p.MEINS : '';
              const left = x.required - x.total;
              return `• ${String(x.p.MATNR || '')} — ${fmtQty(
                x.total,
              )} of ${fmtQty(x.required)}${uom} added, ${fmtQty(
                left,
              )}${uom} short`;
            })
            .join('\n');
          setShortLinesText(lines);
          setShortReason(null);
          setShortNote('');
          setShortModalOpen(true);
          return;
        }
      }

      // Fully batched submit, or a plain Save -> proceed directly.
      persistEntry(submitStatus, false, '');
    },
    [
      addedEbelps,
      products,
      batchesByEbelp,
      driverName,
      mobileNo,
      vehicleNo,
      lrNumber,
      persistEntry,
    ],
  );

  // Confirm handler for the short-submit modal: validate the reason (and note
  // when "Other"), build the stored remark, then submit with allow_partial.
  const confirmShortSubmit = useCallback(() => {
    if (!shortReason) {
      Alert.alert('Reason required', 'Please choose a reason for the short quantity.');
      return;
    }
    const note = shortNote.trim();
    if (shortReason === 'Other' && note === '') {
      Alert.alert('Note required', 'Please describe the reason for the short quantity.');
      return;
    }
    const remark =
      shortReason === 'Other'
        ? note
        : note
        ? `${shortReason} — ${note}`
        : shortReason;
    setShortModalOpen(false);
    persistEntry(2, true, remark);
  }, [shortReason, shortNote, persistEntry]);

  // Inline validation — only flag once the user has typed something, so an
  // untouched field never shows red.
  const mobileInvalid = mobileNo.length > 0 && !MOBILE_RE.test(mobileNo);
  const vehicleInvalid = vehicleNo.length > 0 && !VEHICLE_RE.test(vehicleNo);

  // Full-screen camera — replaces the form while a photo is being captured.
  if (cameraFor) {
    if (!camDevice || !hasCamPermission) {
      return (
        <View style={styles.camFallback}>
          <Text style={styles.camFallbackText}>
            {hasCamPermission
              ? 'No camera available on this device.'
              : 'Camera permission is required.'}
          </Text>
          <TouchableOpacity style={styles.camClose} onPress={() => setCameraFor(null)}>
            <Text style={styles.camCloseText}>Close</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <Camera
          ref={camRef}
          style={StyleSheet.absoluteFill}
          device={camDevice}
          isActive
          photo
        />
        <View style={styles.camBar}>
          <TouchableOpacity onPress={() => setCameraFor(null)} style={styles.camSideBtn}>
            <Text style={styles.camSideText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={takePhoto} style={styles.shutter} activeOpacity={0.8}>
            <Image source={CAMERA_ICON} style={styles.shutterIcon} resizeMode="contain" />
            <Text style={styles.shutterText}>Capture</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setIsFrontCamera(p => !p)}
            style={styles.camSideBtn}
          >
            <Text style={styles.camSideText}>Flip</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    // Same soft Amul red-tint-to-white wash as the Home (Dashboard) screen, so
    // DIL Entry sits on the identical background. The ScrollView / card below
    // are transparent, so the gradient shows through.
    <LinearGradient
      colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']}
      style={{ flex: 1 }}
    >
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={true}
      >
        <View style={styles.card}>
          {/* ---- Plant dropdown (standalone; NOT tied to Get DIL Details) ---
              Shown FIRST. Lists all active plants from get_dil_plant_list.php;
              the selection is just held for now. */}
          <Label>Plant</Label>
          <View style={styles.dropdownRow}>
            <TouchableOpacity
              style={[styles.dropdown, styles.dropdownFlex]}
              onPress={() => {
                if (dilPlants.length > 0) {
                  setPlantQuery('');
                  setPlantPickerOpen(true);
                }
              }}
              activeOpacity={0.8}
            >
              <Text
                style={
                  dilPlant ? styles.dropdownSelected : styles.dropdownPlaceholder
                }
                numberOfLines={1}
              >
                {dilPlant
                  ? `${dilPlant.plant_code}${
                      dilPlant.plant_name ? ' - ' + dilPlant.plant_name : ''
                    }`
                  : dilPlants.length
                  ? 'Select plant'
                  : 'Loading plants…'}
              </Text>
              <View style={styles.caret} />
            </TouchableOpacity>

            {/* Inline clear (✕) — shown only when a plant is selected, so the
                field can be cleared without opening the picker. */}
            {dilPlant ? (
              <TouchableOpacity
                style={styles.plantClearBtn}
                onPress={() => {
                  setDilPlant(null);
                  setDockNo(''); // plant changed -> drop any chosen dock
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Clear selected plant"
              >
                <Text style={styles.plantClearIcon}>✕</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Plant Code is NOT shown. It is resolved from the logged-in user's
              account and passed to the backend internally (products / stock).
              Only a warning appears if the account has no plant linked, so the
              disabled "Get DIL Details" button has an explanation. */}
          {plantMissing ? (
            <Text style={styles.hintWarn}>
              No plant is linked to your account. DIL entries are filed against
              your plant — please contact the IT department to link one.
            </Text>
          ) : null}

          {/* ---- DIL No -------------------------------------------------- */}
          <Label required>DIL Number</Label>
          <TextInput
            style={[styles.input, locked && styles.inputLocked]}
            value={dilNo}
            onChangeText={text =>
              setDilNo(text.toUpperCase().replace(/[^A-Z0-9]/g, ''))
            }
            placeholder="Enter DIL number"
            placeholderTextColor="#9AA0AA"
            maxLength={30}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
            editable={!locked}
          />

          {/* ---- DIL Date (calendar picker, defaults to today) ---------- */}
          <Label required>DIL Date</Label>
          <TouchableOpacity
            style={[styles.dateBtn, locked && styles.inputLocked]}
            activeOpacity={0.8}
            onPress={() => setDatePickerOpen(true)}
            disabled={locked}
          >
            <Text style={styles.dateBtnText}>{toDisplay(dilDate)}</Text>
            <CalendarIcon />
          </TouchableOpacity>

          {/* ---- Get DIL Details + Reset ------------------------------- */}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[
                styles.button,
                styles.buttonPrimary,
                !canFetch && !productsLoading && styles.buttonDisabled,
              ]}
              onPress={fetchDilDetails}
              disabled={!canFetch}
              activeOpacity={0.85}
            >
              <Text style={styles.buttonText}>Get DIL Details</Text>
            </TouchableOpacity>

            {locked ? (
              <TouchableOpacity
                style={[styles.button, styles.buttonReset]}
                onPress={resetAll}
                disabled={productsLoading}
                activeOpacity={0.85}
              >
                <Text style={styles.buttonResetText}>Reset</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* ---- Entry module — ONLY when the RFC returned products ------ */}
          {showEntry && products.length > 0 ? (
            <View style={styles.entrySection}>
              {/* Background reconcile indicator — the form is already usable; a
                  saved draft's products may still be re-synced with SAP. */}
              {syncingSaved ? (
                <View style={styles.syncBanner}>
                  <ActivityIndicator size="small" color={COLORS.primaryRed} />
                  <Text style={styles.syncBannerText}>
                    Syncing saved entries with SAP…
                  </Text>
                </View>
              ) : null}

              {/* DIL header — document-level fields from the first RFC row. */}
              {head ? (
                <View style={styles.headerBox}>
                  <View style={styles.headerRow}>
                    <Text style={styles.headerLabel}>DIL No</Text>
                    <Text style={styles.headerValue}>{String(head.EBELN || dilNo)}</Text>
                  </View>
                  <View style={styles.headerRow}>
                    <Text style={styles.headerLabel}>From Location</Text>
                    <Text style={styles.headerValue}>
                      {[head.RESWK, head.NAME1]
                        .filter(v => v && String(v).trim() !== '')
                        .join(' - ')}
                    </Text>
                  </View>
                  <View style={styles.headerRow}>
                    <Text style={styles.headerLabel}>To Location</Text>
                    <Text style={styles.headerValue}>
                      {[head.WERKS, head.NAME2]
                        .filter(v => v && String(v).trim() !== '')
                        .join(' - ')}
                    </Text>
                  </View>
                  <View style={styles.headerRow}>
                    <Text style={styles.headerLabel}>Transporter</Text>
                    <Text style={styles.headerValue}>{String(head.TNAME || '')}</Text>
                  </View>
                  <View style={styles.headerRow}>
                    <Text style={styles.headerLabel}>Vehicle Type</Text>
                    <Text style={styles.headerValue}>{String(head.VEHTP || '')}</Text>
                  </View>
                  <View style={styles.headerRow}>
                    <Text style={styles.headerLabel}>Loading Date</Text>
                    <Text style={styles.headerValue}>{fmtSapDate(head.LDAT)}</Text>
                  </View>
                </View>
              ) : null}

              {/* Driver & Vehicle details — captured first, before products. */}
              <CollapsibleHeader
                title="Driver & Vehicle Details"
                open={!collapsed.driver}
                onPress={() => toggleSection('driver')}
              />
              {collapsed.driver ? null : (
                <>

              {/* Vehicle Number FIRST — captured before driver/mobile, with a
                  type-ahead of today's vehicles for the selected plant. Picking
                  one fills the vehicle AND the driver name. Typing freely is
                  always allowed; the list is only a shortcut. */}
              <Label required>Vehicle Number</Label>
              <TextInput
                style={[styles.input, vehicleInvalid && styles.inputError]}
                value={vehicleNo}
                onChangeText={text => {
                  setVehicleNo(text.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                  setVehicleSuggestOpen(true);
                }}
                onFocus={() => setVehicleSuggestOpen(true)}
                // Close the suggestions when the field loses focus (typed and
                // cleared, or tapped away). The short delay lets a tap ON a
                // suggestion register first — its onPress also closes the list.
                onBlur={() =>
                  setTimeout(() => setVehicleSuggestOpen(false), 150)
                }
                placeholder="e.g. GJ01AB1234"
                placeholderTextColor="#9AA0AA"
                maxLength={15}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="next"
              />
              {vehicleSuggestOpen && vehicleSuggestFiltered.length > 0 ? (
                <View style={styles.suggestBox}>
                  <ScrollView
                    style={styles.suggestList}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                  >
                    {vehicleSuggestFiltered.map((v, i) => (
                      <TouchableOpacity
                        key={String(v.vehicle_no || '') + '|' + i}
                        style={[
                          styles.suggestRow,
                          i === vehicleSuggestFiltered.length - 1 &&
                            styles.suggestRowLast,
                        ]}
                        activeOpacity={0.7}
                        onPress={() => {
                          setVehicleNo(
                            String(v.vehicle_no || '')
                              .toUpperCase()
                              .replace(/[^A-Z0-9]/g, '')
                              .slice(0, 15),
                          );
                          if (v.driver_nm) {
                            setDriverName(
                              String(v.driver_nm)
                                .toUpperCase()
                                .replace(/[^A-Z .]/g, '')
                                .slice(0, 60),
                            );
                          }
                          setVehicleSuggestOpen(false);
                        }}
                      >
                        <Text style={styles.suggestVeh}>
                          {String(v.vehicle_no || '')}
                        </Text>
                        {v.driver_nm ? (
                          <Text style={styles.suggestSub} numberOfLines={1}>
                            {String(v.driver_nm || '')}
                          </Text>
                        ) : null}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
              {vehicleInvalid ? (
                <Text style={styles.fieldError}>
                  Enter a valid vehicle number, e.g. GJ01AB1234.
                </Text>
              ) : null}

              <Label required>Driver Name</Label>
              <TextInput
                style={styles.input}
                value={driverName}
                onChangeText={text =>
                  setDriverName(text.toUpperCase().replace(/[^A-Z .]/g, ''))
                }
                onFocus={() => setVehicleSuggestOpen(false)}
                placeholder="ENTER DRIVER NAME"
                placeholderTextColor="#9AA0AA"
                maxLength={60}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="next"
              />

              <Label required>Mobile Number</Label>
              <TextInput
                style={[styles.input, mobileInvalid && styles.inputError]}
                value={mobileNo}
                onChangeText={text =>
                  setMobileNo(text.replace(/[^0-9]/g, '').slice(0, 10))
                }
                onFocus={() => setVehicleSuggestOpen(false)}
                placeholder="10-digit mobile number"
                placeholderTextColor="#9AA0AA"
                keyboardType="number-pad"
                maxLength={10}
                returnKeyType="done"
              />
              {mobileInvalid ? (
                <Text style={styles.fieldError}>
                  Enter a valid 10-digit mobile number starting 6-9.
                </Text>
              ) : null}

              <Label required>LR Number</Label>
              <TextInput
                style={styles.input}
                value={lrNumber}
                onChangeText={text =>
                  setLrNumber(text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20))
                }
                onFocus={() => setVehicleSuggestOpen(false)}
                placeholder="ENTER LR NUMBER"
                placeholderTextColor="#9AA0AA"
                maxLength={20}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
              />

              {/* ---- Dock Selection (mandatory on Submit) ---------------
                  Same behaviour as the Plant dropdown: a searchable picker +
                  an inline clear. Docks are listed for the plant chosen in the
                  top dropdown. */}
              <Label required>Dock Selection</Label>
              <View style={styles.dropdownRow}>
                <TouchableOpacity
                  style={[styles.dropdown, styles.dropdownFlex]}
                  onPress={() => {
                    if (dilPlant && dilPlant.plant_code) {
                      setVehicleSuggestOpen(false);
                      setDockQuery('');
                      setDockPickerOpen(true);
                    } else {
                      Alert.alert('Select a plant', 'Choose a plant first to list its docks.');
                    }
                  }}
                  activeOpacity={0.8}
                >
                  <Text
                    style={dockNo ? styles.dropdownSelected : styles.dropdownPlaceholder}
                    numberOfLines={1}
                  >
                    {!dilPlant || !dilPlant.plant_code
                      ? 'Select a plant first'
                      : dockNo
                      ? (() => {
                          const d = docks.find(
                            x => String(x.dock_no) === String(dockNo),
                          );
                          return d && d.dock_name
                            ? String(d.dock_name)
                            : 'Dock ' + dockNo;
                        })()
                      : docksLoading
                      ? 'Loading docks…'
                      : docks.length
                      ? 'Select dock'
                      : 'No docks for this plant'}
                  </Text>
                  <View style={styles.caret} />
                </TouchableOpacity>

                {/* Inline clear (✕) — shown only when a dock is selected. */}
                {dockNo ? (
                  <TouchableOpacity
                    style={styles.plantClearBtn}
                    onPress={() => setDockNo('')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Clear selected dock"
                  >
                    <Text style={styles.plantClearIcon}>✕</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

                </>
              )}

              {/* ---- Loading Photos & Time ------------------------------
                  Three mandatory photos + the loading start/end times
                  (auto-stamped on tap, editable). Placed right after Dock. */}
              <CollapsibleHeader
                title="Loading Photos & Time"
                open={!collapsed.photos}
                onPress={() => toggleSection('photos')}
              />
              {collapsed.photos ? null : (
                <>

              {LOAD_PHOTOS.map(ph => (
                <PhotoTile
                  key={ph.key}
                  label={ph.label}
                  required
                  image={loadPhotos[ph.key]}
                  uploaded={!!existingPhotos[ph.key]}
                  onView={() => openPhotoViewer(ph.key, ph.label)}
                  onPress={() => {
                    if (hasCamPermission) {
                      setCameraFor(ph.key);
                    } else {
                      Camera.requestCameraPermission()
                        .then(s => {
                          const ok = s === 'granted' || s === 'authorized';
                          setHasCamPermission(ok);
                          if (ok) setCameraFor(ph.key);
                          else
                            Alert.alert(
                              'Camera permission',
                              'Please allow camera access to capture the photo.',
                            );
                        })
                        .catch(() => {});
                    }
                  }}
                />
              ))}

              <Label>Loading Start Date-Time</Label>
              <View style={styles.dropdownRow}>
                <TouchableOpacity
                  style={[styles.dropdown, styles.dropdownFlex]}
                  onPress={() => openDtPicker('start', loadStartTime)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={loadStartTime ? styles.dropdownSelected : styles.dropdownPlaceholder}
                    numberOfLines={1}
                  >
                    {loadStartTime || 'DD-MM-YYYY HH:MM'}
                  </Text>
                  <CalendarIcon />
                </TouchableOpacity>
                {loadStartTime ? (
                  <TouchableOpacity
                    style={styles.plantClearBtn}
                    onPress={() => setLoadStartTime('')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Clear loading start date-time"
                  >
                    <Text style={styles.plantClearIcon}>✕</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <Label>Loading End Date-Time</Label>
              <View style={styles.dropdownRow}>
                <TouchableOpacity
                  style={[styles.dropdown, styles.dropdownFlex]}
                  onPress={() => openDtPicker('end', loadEndTime)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={loadEndTime ? styles.dropdownSelected : styles.dropdownPlaceholder}
                    numberOfLines={1}
                  >
                    {loadEndTime || 'DD-MM-YYYY HH:MM'}
                  </Text>
                  <CalendarIcon />
                </TouchableOpacity>
                {loadEndTime ? (
                  <TouchableOpacity
                    style={styles.plantClearBtn}
                    onPress={() => setLoadEndTime('')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Clear loading end date-time"
                  >
                    <Text style={styles.plantClearIcon}>✕</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

                </>
              )}

              {/* ---- Live Stock table for ALL DIL products --------------- */}
              <CollapsibleHeader
                title="Live Stock"
                open={!collapsed.stock}
                onPress={() => toggleSection('stock')}
              />
              {collapsed.stock ? null : (
                <>
              <View style={styles.lsTable}>
                <View style={[styles.lsRow, styles.lsHeadRow]}>
                  <Text style={[styles.lsCellName, styles.lsHeadText]}>Product</Text>
                  <Text style={[styles.lsCellNum, styles.lsHeadText]}>Total</Text>
                  <Text style={[styles.lsCellNum, styles.lsHeadText]}>Resv</Text>
                  <Text style={[styles.lsCellNum, styles.lsHeadText]}>Avail</Text>
                </View>
                {(() => {
                  // Live Stock is a MATERIAL-level summary: stock (total / reserved
                  // / available) is held per material, not per DIL line. A DIL can
                  // carry the same material on more than one line, so collapse the
                  // product lines to ONE row per material here — otherwise the same
                  // stock shows twice and the reserved figure looks doubled. The
                  // required quantity is SUMMED across all lines of the material, so
                  // the shortage check reflects the DIL's total need for it.
                  var byMat = [];
                  var idxByMat = {};
                  products.forEach(function (p) {
                    var code = String(p.MATNR || '').toUpperCase();
                    if (idxByMat[code] === undefined) {
                      idxByMat[code] = byMat.length;
                      byMat.push({
                        MATNR: p.MATNR,
                        TXZ01: p.TXZ01,
                        MEINS: p.MEINS,
                        required: parseFloat(p.MENGE) || 0,
                      });
                    } else {
                      byMat[idxByMat[code]].required += parseFloat(p.MENGE) || 0;
                    }
                  });
                  return byMat.map(function (p, i) {
                    var s = stockByMat[String(p.MATNR || '').toUpperCase()];
                    // SHORT when the stock FREE FOR THIS DIL can't cover the
                    // material's TOTAL required qty across all its lines. We use
                    // avail_for_dil (total − reserved by OTHER DILs) so this
                    // DIL's own reservation is never counted against its own
                    // need — otherwise reopening a saved DIL falsely shows short.
                    // Falls back to "available" for older backends. Judged only
                    // once stock has loaded (s present) and a required qty known.
                    var required = p.required;
                    var shortBase =
                      s && s.avail_for_dil !== undefined && s.avail_for_dil !== null
                        ? s.avail_for_dil
                        : s
                        ? s.available
                        : null;
                    var availNum = shortBase !== null ? parseFloat(shortBase) || 0 : null;
                    var short =
                      availNum !== null &&
                      required > 0 &&
                      availNum + 0.0001 < required;
                    return (
                      <View
                        style={[
                          styles.lsRow,
                          short && styles.lsRowShort,
                          i === byMat.length - 1 && styles.lsRowLast,
                        ]}
                        key={String(p.MATNR || '') + '|' + i}
                      >
                        <View style={styles.lsCellName}>
                          <Text style={styles.lsName} numberOfLines={2}>
                            {String(p.TXZ01 || p.MATNR || '')}
                          </Text>
                          <Text style={styles.lsCode}>{String(p.MATNR || '')}</Text>
                          {short ? (
                            <Text style={styles.lsShortTag}>
                              Short by {fmtQty(required - availNum)}
                              {p.MEINS ? ' ' + p.MEINS : ''}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.lsCellNum}>
                          {s ? fmtQty(s.total) : '…'}
                        </Text>
                        <Text style={[styles.lsCellNum, styles.lsResv]}>
                          {s ? fmtQty(s.reserved) : '…'}
                        </Text>
                        <Text
                          style={[
                            styles.lsCellNum,
                            short ? styles.lsAvailShort : styles.lsAvail,
                          ]}
                        >
                          {s ? fmtQty(s.available) : '…'}
                        </Text>
                      </View>
                    );
                  });
                })()}
              </View>
              <View style={styles.lsRefreshRow}>
                <Text style={styles.lsUpdatedText}>
                  {stockRefreshing
                    ? 'Refreshing…'
                    : stockUpdatedAt
                    ? 'Updated ' + stockUpdatedAt
                    : ''}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.lsRefreshBtn,
                    stockRefreshing && styles.lsRefreshBtnDisabled,
                  ]}
                  onPress={() => fetchAllStock()}
                  disabled={stockRefreshing}
                  activeOpacity={0.85}
                >
                  <Text style={styles.lsRefreshText}>
                    {stockRefreshing ? '↻ Refreshing…' : '↻ Refresh stock'}
                  </Text>
                </TouchableOpacity>
              </View>

                </>
              )}

              {/* Products loaded from the RFC into a dropdown. */}
              <CollapsibleHeader
                title="Product Details"
                open={!collapsed.product}
                onPress={() => toggleSection('product')}
              />
              {collapsed.product ? null : (
                <>

              <Label required>Product</Label>
              <View style={styles.dropdownRow}>
                <TouchableOpacity
                  style={[styles.dropdown, styles.dropdownFlex]}
                  onPress={() =>
                    availableProducts.length > 0 && setProductPickerOpen(true)
                  }
                  activeOpacity={0.8}
                >
                  <Text
                    style={
                      selectedProduct
                        ? styles.dropdownSelected
                        : styles.dropdownPlaceholder
                    }
                    numberOfLines={1}
                  >
                    {selectedProduct
                      ? productLabel(selectedProduct)
                      : availableProducts.length === 0
                      ? 'All products added'
                      : `Select product (${availableProducts.length})`}
                  </Text>
                  <View style={styles.caret} />
                </TouchableOpacity>

                {/* Scan a product QR to pick it from the same list. */}
                <TouchableOpacity
                  style={styles.scanBtn}
                  onPress={() => openScanner('product')}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Scan product QR code"
                >
                  <Image source={QR_ICON} style={styles.qrImg} />
                </TouchableOpacity>
              </View>

              {/* Selected product's held values. */}
              {selectedProduct ? (
                <View style={styles.detailsBox}>
                  <View style={styles.pRow}>
                    <Text style={styles.pLabel}>Material Code</Text>
                    <Text style={styles.pValue}>
                      {String(selectedProduct.MATNR || '—')}
                    </Text>
                  </View>
                  <View style={styles.pRow}>
                    <Text style={styles.pLabel}>Material Name</Text>
                    <Text style={styles.pValue}>
                      {String(selectedProduct.TXZ01 || '—')}
                    </Text>
                  </View>
                  <View style={styles.pRow}>
                    <Text style={styles.pLabel}>Quantity</Text>
                    <Text style={styles.pValue}>
                      {fmtQty(selectedProduct.MENGE)}
                      {selectedProduct.MEINS ? ' ' + selectedProduct.MEINS : ''}
                    </Text>
                  </View>
                  <View style={[styles.pRow, styles.pRowLast]}>
                    <Text style={styles.pLabel}>Net Weight</Text>
                    <Text style={styles.pValue}>
                      {fmtQty(selectedProduct.NTGEW)}
                      {selectedProduct.GEWEI ? ' ' + selectedProduct.GEWEI : ''}
                    </Text>
                  </View>
                </View>
              ) : null}

              {/* Batches for the selected product — batch no (type or scan) + qty.
                  Total must equal the product's planned quantity. */}
              {selectedProduct ? (
                <View style={styles.batchWrap}>
                  <View style={styles.batchTitleRow}>
                    <Text style={styles.batchTitle}>Batches</Text>
                    <Text
                      style={[
                        styles.batchTally,
                        qtyMatches
                          ? styles.batchTallyOk
                          : qtyOver
                          ? styles.batchTallyOver
                          : styles.batchTallyPend,
                      ]}
                    >
                      {fmtQty(enteredQty)} / {fmtQty(requiredQty)}
                      {selectedProduct.MEINS ? ' ' + selectedProduct.MEINS : ''}
                    </Text>
                  </View>

                  {currentBatches.map((b, idx) => {
                    // Availability/over-stock only matters for a row still being
                    // entered. A saved row already holds its reservation, so the
                    // recomputed 'available' (which excludes its own qty) must not
                    // be compared against it.
                    const info = b.saved ? null : batchInfoFor(b.batchNo);
                    const over =
                      !b.saved &&
                      info &&
                      (parseFloat(b.qty) || 0) -
                        (parseFloat(info.available) || 0) >
                        0.0001;
                    return (
                      <View style={styles.batchItem} key={idx}>
                        <View style={styles.batchRow}>
                          <View
                            style={[
                              styles.batchNoWrap,
                              b.saved && styles.batchLocked,
                            ]}
                          >
                            <TextInput
                              style={styles.batchNoInput}
                              value={b.batchNo}
                              editable={!b.saved}
                              onChangeText={t =>
                                updateBatch(
                                  idx,
                                  'batchNo',
                                  t.toUpperCase().replace(/[^A-Z0-9\-/]/g, ''),
                                )
                              }
                              placeholder="Batch No"
                              placeholderTextColor="#9AA0AA"
                              autoCapitalize="characters"
                              autoCorrect={false}
                              maxLength={30}
                            />
                            {!b.saved ? (
                              <TouchableOpacity
                                style={styles.batchListBtn}
                                onPress={() =>
                                  setBatchPicker({
                                    ebelp: selectedEbelp,
                                    index: idx,
                                  })
                                }
                                activeOpacity={0.85}
                                accessibilityLabel="Choose batch from stock"
                              >
                                <View style={styles.caretSm} />
                              </TouchableOpacity>
                            ) : null}
                            {!b.saved ? (
                              <TouchableOpacity
                                style={styles.batchScanBtn}
                                onPress={() =>
                                  openScanner({
                                    type: 'batch',
                                    ebelp: selectedEbelp,
                                    index: idx,
                                  })
                                }
                                activeOpacity={0.85}
                                accessibilityLabel="Scan batch QR code"
                              >
                                <Image source={QR_ICON} style={styles.qrImgSmall} />
                              </TouchableOpacity>
                            ) : null}
                          </View>

                          <TextInput
                            style={[
                              styles.batchQtyInput,
                              over && styles.inputError,
                              b.saved && styles.batchLocked,
                            ]}
                            value={b.saved ? fmtQty(b.qty) : b.qty}
                            editable={!b.saved}
                            onChangeText={t =>
                              updateBatch(
                                idx,
                                'qty',
                                t
                                  .replace(/[^0-9.]/g, '')
                                  .replace(/(\..*)\./g, '$1'),
                              )
                            }
                            placeholder="Qty"
                            placeholderTextColor="#9AA0AA"
                            keyboardType="decimal-pad"
                            maxLength={12}
                          />

                          {!b.saved ? (
                            <TouchableOpacity
                              style={[
                                styles.batchSaveBtn,
                                savingBatchIdx !== null &&
                                  styles.batchSaveBtnDisabled,
                              ]}
                              onPress={() => saveBatchRow(idx)}
                              // Disable every save button while any save is in
                              // flight, so a slow response can't be double-tapped
                              // into duplicate batches.
                              disabled={savingBatchIdx !== null}
                              activeOpacity={0.85}
                              accessibilityLabel="Save batch"
                            >
                              <Text style={styles.batchSaveText}>
                                {savingBatchIdx === idx ? '…' : '+'}
                              </Text>
                            </TouchableOpacity>
                          ) : (
                            <View style={styles.batchSavedChip}>
                              <Text style={styles.batchSavedChipText}>✓</Text>
                            </View>
                          )}

                          <TouchableOpacity
                            style={styles.batchRemove}
                            onPress={() => removeBatch(idx)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Remove batch"
                          >
                            <Text style={styles.batchRemoveText}>×</Text>
                          </TouchableOpacity>
                        </View>

                        {/* Per-batch hint. Saved rows just confirm; unsaved rows
                            show live availability / over-stock / manual. */}
                        {b.saved ? (
                          <Text style={styles.batchStockHint}>Saved</Text>
                        ) : b.batchNo ? (
                          info ? (
                            <Text
                              style={[
                                styles.batchStockHint,
                                over && styles.batchWarn,
                              ]}
                            >
                              Available: {fmtQty(info.available)}
                              {info.uom ? ' ' + info.uom : ''}
                              {info.mfg_date ? ' · Mfg ' + info.mfg_date : ''}
                              {over ? ' — exceeds available stock' : ''}
                            </Text>
                          ) : (
                            <Text style={styles.batchStockHintMuted}>
                              Manual batch — not in SAP stock list.
                            </Text>
                          )
                        ) : null}
                      </View>
                    );
                  })}

                  <View style={styles.batchActionsRow}>
                    <TouchableOpacity
                      style={styles.addBatchBtn}
                      onPress={addBatch}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.addBatchText}>+ Add Batch</Text>
                    </TouchableOpacity>

                    {/* Return to the list. Shows once at least one batch is
                        saved: "✓ Done" when the product is fully batched
                        (Complete), otherwise "Close" so editing a Pending
                        product without adding more still has an exit. */}
                    {currentBatches.some(b => b.saved) ? (
                      <TouchableOpacity
                        style={styles.doneBtn}
                        onPress={() => {
                          // Drop any unsaved row before leaving so the card shows
                          // only persisted batches.
                          setBatchesByEbelp(m => ({
                            ...m,
                            [selectedEbelp]: (m[selectedEbelp] || []).filter(
                              b => b.saved,
                            ),
                          }));
                          setAddedEbelps(a =>
                            a.includes(String(selectedEbelp))
                              ? a
                              : [...a, String(selectedEbelp)],
                          );
                          setSelectedEbelp(null);
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.doneBtnText}>
                          {qtyMatches ? '✓ Done' : 'Close'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  {qtyOver ? (
                    <Text style={styles.batchWarn}>
                      Total batch quantity exceeds the product quantity.
                    </Text>
                  ) : !qtyMatches ? (
                    <Text style={styles.batchHint}>
                      Save batches totalling {fmtQty(requiredQty)}
                      {selectedProduct.MEINS ? ' ' + selectedProduct.MEINS : ''}.
                      It appears in the list below as Pending, and turns Complete
                      once the full quantity is entered.
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {/* ---- Added products (with their batches) ----------------- */}
              {cardEbelps.length > 0 ? (
                <View style={styles.addedWrap}>
                  <Text style={styles.addedHeading}>
                    Added Products ({cardEbelps.length})
                  </Text>
                  {cardEbelps.map(ebelp => {
                    const p = products.find(
                      x => String(x.EBELP) === String(ebelp),
                    );
                    if (!p) return null;
                    const rows = (batchesByEbelp[ebelp] || []).filter(
                      b => b.saved,
                    );
                    const total = rows.reduce(
                      (s, b) => s + (parseFloat(b.qty) || 0),
                      0,
                    );
                    const required = parseFloat(p.MENGE) || 0;
                    const complete =
                      required > 0 && Math.abs(total - required) < 0.0001;
                    return (
                      <View style={styles.addedCard} key={ebelp}>
                        <View style={styles.addedCardTop}>
                          <View style={styles.addedCardTitle}>
                            <View
                              style={{
                                alignSelf: 'flex-start',
                                paddingHorizontal: 8,
                                paddingVertical: 2,
                                borderRadius: 4,
                                marginBottom: 4,
                                backgroundColor: complete
                                  ? '#E7F6EC'
                                  : '#FDECEC',
                              }}
                            >
                              <Text
                                style={{
                                  fontSize: 11,
                                  fontWeight: '700',
                                  letterSpacing: 0.3,
                                  color: complete ? '#1E8E3E' : '#C62828',
                                }}
                              >
                                {complete
                                  ? 'COMPLETE'
                                  : `PENDING · ${fmtQty(total)}/${fmtQty(
                                      required,
                                    )}${p.MEINS ? ' ' + p.MEINS : ''}`}
                              </Text>
                            </View>
                            <Text style={styles.addedName} numberOfLines={2}>
                              {String(p.TXZ01 || p.MATNR || '')}
                            </Text>
                            <Text style={styles.addedCode}>
                              {String(p.MATNR || '')}
                            </Text>
                          </View>
                          <View style={styles.addedActions}>
                            <TouchableOpacity
                              style={styles.addedEdit}
                              onPress={() => editAddedProduct(ebelp)}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              accessibilityLabel="Edit product"
                            >
                              <Text style={styles.addedEditText}>Edit</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.addedRemove}
                              onPress={() => removeAddedProduct(ebelp)}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              accessibilityLabel="Remove product"
                            >
                              <Text style={styles.addedRemoveText}>Remove</Text>
                            </TouchableOpacity>
                          </View>
                        </View>

                        {rows.map((b, i) => (
                          <View style={styles.addedBatchRow} key={i}>
                            <Text style={styles.addedBatchNo}>
                              {String(b.batchNo || '—')}
                            </Text>
                            <Text style={styles.addedBatchQty}>
                              {fmtQty(b.qty)}
                              {p.MEINS ? ' ' + p.MEINS : ''}
                            </Text>
                          </View>
                        ))}

                        <View style={styles.addedTotalRow}>
                          <Text style={styles.addedTotalLabel}>Total</Text>
                          <Text style={styles.addedTotalValue}>
                            {fmtQty(total)}
                            {p.MEINS ? ' ' + p.MEINS : ''}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : null}

                </>
              )}

              {/* ---- Pallet Detail (optional) --------------------------- */}
              <CollapsibleHeader
                title="Pallet Detail (If Used)"
                open={!collapsed.pallet}
                onPress={() => toggleSection('pallet')}
              />
              {collapsed.pallet ? null : (
                <>

              <View style={styles.palletRow}>
                <View style={styles.palletCol}>
                  <Label>Pallet Qty</Label>
                  <TextInput
                    style={styles.input}
                    value={palletQty}
                    onChangeText={t =>
                      setPalletQty(t.replace(/[^0-9]/g, '').slice(0, 6))
                    }
                    placeholder="No. of pallets"
                    placeholderTextColor="#9AA0AA"
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                </View>
                <View style={styles.palletColRight}>
                  <Label>
                    Per Pallet Weight{' '}
                    <Text style={styles.labelUnit}>(In KG)</Text>
                  </Label>
                  <TextInput
                    style={styles.input}
                    value={palletWeight}
                    onChangeText={t =>
                      setPalletWeight(
                        t.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'),
                      )
                    }
                    placeholder="Weight / pallet"
                    placeholderTextColor="#9AA0AA"
                    keyboardType="decimal-pad"
                    maxLength={12}
                  />
                </View>
              </View>

              {/* Total pallet weight = Pallet Qty x Per Pallet Weight. Shown only
                  once both are entered. */}
              {(parseFloat(palletQty) || 0) > 0 &&
              (parseFloat(palletWeight) || 0) > 0 ? (
                <View style={styles.palletTotalRow}>
                  <Text style={styles.palletTotalLabel}>Total Pallet Weight</Text>
                  <Text style={styles.palletTotalValue}>
                    {fmtQty(
                      (parseFloat(palletQty) || 0) *
                        (parseFloat(palletWeight) || 0),
                    )}{' '}
                    KG
                  </Text>
                </View>
              ) : null}

                </>
              )}

              {/* ---- Seal + Vehicle Temperature (optional) -------------- */}
              <CollapsibleHeader
                title="Seal (If Used) & Vehicle Temperature Details"
                open={!collapsed.seal}
                onPress={() => toggleSection('seal')}
              />
              {collapsed.seal ? null : (
                <>

              <Label>Seal Number 1</Label>
              <TextInput
                style={styles.input}
                value={sealNo}
                onChangeText={text =>
                  setSealNo(text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30))
                }
                placeholder="ENTER SEAL NUMBER 1"
                placeholderTextColor="#9AA0AA"
                maxLength={30}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
              />

              {/* Second seal — used only when two seals are applied. Optional. */}
              <Label>Seal Number 2</Label>
              <TextInput
                style={styles.input}
                value={sealNo2}
                onChangeText={text =>
                  setSealNo2(text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30))
                }
                placeholder="ENTER SEAL NUMBER 2 (IF USED)"
                placeholderTextColor="#9AA0AA"
                maxLength={30}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
              />

              {/* Vehicle temperature — numeric, may be negative (e.g. frozen
                  loads). Optional. One leading '-' and one decimal point only. */}
              <Label>
                Vehicle Temperature{' '}
                <Text style={styles.labelUnit}>(+/-)</Text>
              </Label>
              <TextInput
                style={styles.input}
                value={vehicleTemp}
                onChangeText={t => {
                  let s = t.replace(/[^0-9.\-]/g, ''); // digits, dot, minus only
                  s = s.replace(/(?!^)-/g, ''); // keep '-' only at the very start
                  s = s.replace(/(\..*)\./g, '$1'); // at most one decimal point
                  setVehicleTemp(s.slice(0, 8));
                }}
                placeholder="e.g. -18.5"
                placeholderTextColor="#9AA0AA"
                keyboardType="numbers-and-punctuation"
                maxLength={8}
                autoCorrect={false}
                returnKeyType="done"
              />

                </>
              )}

              {/* ---- Total Load Qty (read-only) --------------------------
                  Sum of every product's SAVED batch quantity — i.e. the qty
                  actually loaded. Computed, never typed. Unit shown only when
                  all products share one UoM. */}
              <View style={styles.divider} />
              <Label>Total Load Qty</Label>
              <View style={styles.readonlyBox}>
                <Text style={styles.readonlyText}>
                  {(() => {
                    let total = 0;
                    products.forEach(p => {
                      const rows =
                        batchesByEbelp[p.EBELP] ||
                        batchesByEbelp[String(p.EBELP)] ||
                        [];
                      total += rows.reduce(
                        (s, b) => s + (b.saved ? parseFloat(b.qty) || 0 : 0),
                        0,
                      );
                    });
                    return fmtQty(total);
                  })()}
                </Text>
              </View>

              {/* ---- Save / Submit -------------------------------------- */}
              <View style={styles.saveRow}>
                <TouchableOpacity
                  style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
                  onPress={() => saveEntry(1)}
                  disabled={saving}
                  activeOpacity={0.85}
                >
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    saving && styles.submitBtnDisabled,
                  ]}
                  onPress={() =>
                    Alert.alert(
                      'Submit DIL',
                      'Are you sure you want to submit this DIL? Once submitted it cannot be edited.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Submit', onPress: () => saveEntry(2) },
                      ],
                    )
                  }
                  disabled={saving}
                  activeOpacity={0.85}
                >
                  <Text style={styles.submitBtnText}>Submit</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <CalendarModal
        visible={datePickerOpen}
        value={dilDate}
        title="DIL Date"
        onConfirm={d => {
          setDilDate(d);
          setDatePickerOpen(false);
        }}
        onClose={() => setDatePickerOpen(false)}
      />

      {/* Loading date-time — iOS inline native picker (Android uses the system
          date/time dialogs directly, no modal). */}
      {Platform.OS === 'ios' ? (
        <Modal
          visible={dtPickerFor !== null}
          transparent
          statusBarTranslucent
          animationType="fade"
          onRequestClose={() => setDtPickerFor(null)}
        >
          <Pressable style={styles.pickerBackdrop} onPress={() => setDtPickerFor(null)}>
            <Pressable style={styles.pickerPanel} onPress={() => {}}>
              <Text style={styles.pickerTitle}>
                {dtPickerFor === 'end'
                  ? 'Loading End Date-Time'
                  : 'Loading Start Date-Time'}
              </Text>
              <DateTimePicker
                value={dtDraft}
                mode="datetime"
                display="spinner"
                is24Hour
                accentColor={COLORS.primaryRed}
                themeVariant="light"
                onChange={(e, d) => {
                  if (d) setDtDraft(d);
                }}
                style={{ alignSelf: 'stretch' }}
              />
              <View style={styles.dtBtnRow}>
                <TouchableOpacity
                  style={[styles.dtBtn, styles.dtBtnBack]}
                  onPress={() => setDtPickerFor(null)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.dtBtnBackText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.dtBtn, styles.dtBtnOk]}
                  onPress={commitDt}
                  activeOpacity={0.8}
                >
                  <Text style={styles.dtBtnOkText}>Done</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {/* Product picker — centered modal list of the RFC products. */}
      <Modal
        visible={productPickerOpen}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setProductPickerOpen(false)}
      >
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => setProductPickerOpen(false)}
        >
          <Pressable style={styles.pickerPanel} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Select Product</Text>
            <ScrollView
              style={styles.pickerList}
              keyboardShouldPersistTaps="handled"
            >
              {availableProducts.map((p, i) => {
                const active = String(p.EBELP) === String(selectedEbelp);
                return (
                  <TouchableOpacity
                    key={p.EBELP || i}
                    style={[styles.optionRow, active && styles.optionRowActive]}
                    onPress={() => {
                      setProductPickerOpen(false);
                      chooseProduct(p);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.optionCode}>{String(p.MATNR || '')}</Text>
                    <Text style={styles.optionName} numberOfLines={2}>
                      {String(p.TXZ01 || '—')}
                    </Text>
                    {/* Line item + planned qty — tells two lines of the SAME
                        material apart so they aren't mistaken for duplicates. */}
                    <Text style={styles.optionSub}>
                      Line {String(p.EBELP != null ? p.EBELP : '—')}
                      {p.MENGE
                        ? '  ·  Qty ' +
                          fmtQty(p.MENGE) +
                          (p.MEINS ? ' ' + String(p.MEINS) : '')
                        : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}

              {/* De-select / Clear Selection — inside the opened list, at the
                  bottom, shown ONLY when a product is currently selected.
                  Clearing returns the Product field to its placeholder; any
                  batches already entered for that product are kept. */}
              {selectedEbelp != null ? (
                <TouchableOpacity
                  style={styles.optionClear}
                  onPress={() => {
                    setProductPickerOpen(false);
                    setSelectedEbelp(null);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Clear product selection"
                >
                  <Text style={styles.optionClearIcon}>✕</Text>
                  <Text style={styles.optionClearText}>
                    De-select / Clear Selection
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Plant picker — standalone list of all active plants (top dropdown). */}
      <Modal
        visible={plantPickerOpen}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setPlantPickerOpen(false)}
      >
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => setPlantPickerOpen(false)}
        >
          <Pressable style={styles.pickerPanel} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Select Plant</Text>
            {/* Search box — filters by plant code or name as you type. */}
            <TextInput
              style={styles.pickerSearch}
              value={plantQuery}
              onChangeText={setPlantQuery}
              placeholder="Search plant code or name…"
              placeholderTextColor="#9AA0AA"
              autoCorrect={false}
              autoCapitalize="characters"
              returnKeyType="search"
            />
            <ScrollView
              style={styles.pickerList}
              keyboardShouldPersistTaps="handled"
            >
              {(() => {
                const q = plantQuery.trim().toLowerCase();
                const filtered = q
                  ? dilPlants.filter(pl =>
                      `${pl.plant_code || ''} ${pl.plant_name || ''}`
                        .toLowerCase()
                        .includes(q),
                    )
                  : dilPlants;
                if (dilPlants.length === 0) {
                  return <Text style={styles.pickerEmpty}>No plants found.</Text>;
                }
                if (filtered.length === 0) {
                  return (
                    <Text style={styles.pickerEmpty}>
                      No plant matches “{plantQuery.trim()}”.
                    </Text>
                  );
                }
                return filtered.map((pl, i) => {
                  const active =
                    dilPlant &&
                    String(dilPlant.plant_code) === String(pl.plant_code);
                  return (
                    <TouchableOpacity
                      key={(pl.plant_code || '') + i}
                      style={[styles.optionRow, active && styles.optionRowActive]}
                      onPress={() => {
                        const changed =
                          !dilPlant ||
                          String(dilPlant.plant_code) !== String(pl.plant_code);
                        setDilPlant(pl);
                        if (changed) setDockNo(''); // new plant -> drop chosen dock
                        setPlantPickerOpen(false);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.optionCode}>
                        {String(pl.plant_code || '')}
                      </Text>
                      <Text style={styles.optionName} numberOfLines={2}>
                        {String(pl.plant_name || '—')}
                      </Text>
                    </TouchableOpacity>
                  );
                });
              })()}

              {dilPlant ? (
                <TouchableOpacity
                  style={styles.optionClear}
                  onPress={() => {
                    setPlantPickerOpen(false);
                    setDilPlant(null);
                    setDockNo(''); // plant cleared -> drop any chosen dock
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Clear plant selection"
                >
                  <Text style={styles.optionClearIcon}>✕</Text>
                  <Text style={styles.optionClearText}>Clear Selection</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Dock picker — active docks for the selected plant (get_dil_dock_list). */}
      <Modal
        visible={dockPickerOpen}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setDockPickerOpen(false)}
      >
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => setDockPickerOpen(false)}
        >
          <Pressable style={styles.pickerPanel} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Select Dock</Text>
            {/* Search box — filters by dock name or number as you type. */}
            <TextInput
              style={styles.pickerSearch}
              value={dockQuery}
              onChangeText={setDockQuery}
              placeholder="Search dock name or number…"
              placeholderTextColor="#9AA0AA"
              autoCorrect={false}
              returnKeyType="search"
            />
            <ScrollView
              style={styles.pickerList}
              keyboardShouldPersistTaps="handled"
            >
              {(() => {
                if (docksLoading) {
                  return <Text style={styles.pickerEmpty}>Loading docks…</Text>;
                }
                if (docks.length === 0) {
                  return (
                    <Text style={styles.pickerEmpty}>
                      No docks found for this plant.
                    </Text>
                  );
                }
                const q = dockQuery.trim().toLowerCase();
                const filtered = q
                  ? docks.filter(dk =>
                      `${dk.dock_no || ''} ${dk.dock_name || ''}`
                        .toLowerCase()
                        .includes(q),
                    )
                  : docks;
                if (filtered.length === 0) {
                  return (
                    <Text style={styles.pickerEmpty}>
                      No dock matches “{dockQuery.trim()}”.
                    </Text>
                  );
                }
                return filtered.map((dk, i) => {
                  const active = String(dockNo) === String(dk.dock_no);
                  return (
                    <TouchableOpacity
                      key={String(dk.dock_no || '') + '|' + i}
                      style={[styles.optionRow, active && styles.optionRowActive]}
                      onPress={() => {
                        setDockNo(String(dk.dock_no || ''));
                        setDockPickerOpen(false);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.optionName} numberOfLines={2}>
                        {String(dk.dock_name || dk.dock_no || '—')}
                      </Text>
                    </TouchableOpacity>
                  );
                });
              })()}

              {dockNo ? (
                <TouchableOpacity
                  style={styles.optionClear}
                  onPress={() => {
                    setDockPickerOpen(false);
                    setDockNo('');
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Clear dock selection"
                >
                  <Text style={styles.optionClearIcon}>✕</Text>
                  <Text style={styles.optionClearText}>Clear Selection</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Batch picker — live SAP batches (available stock) for the selected product. */}
      <Modal
        visible={!!batchPicker}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setBatchPicker(null)}
      >
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => setBatchPicker(null)}
        >
          <Pressable style={styles.pickerPanel} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Select Batch (Available Stock)</Text>
            <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
              {batchStockLoading ? (
                <Text style={styles.pickerEmpty}>Loading batches…</Text>
              ) : batchStock.length === 0 ? (
                <Text style={styles.pickerEmpty}>
                  No live batches found. You can type the batch number manually.
                </Text>
              ) : (
                batchStock.map((bs, i) => {
                  const avail = parseFloat(bs.available) || 0;
                  const disabled = avail <= 0;
                  return (
                    <TouchableOpacity
                      key={(bs.batch_no || '') + i}
                      style={[styles.optionRow, disabled && { opacity: 0.45 }]}
                      disabled={disabled}
                      onPress={() => {
                        if (batchPicker) {
                          const idx = batchPicker.index;
                          updateBatch(
                            idx,
                            'batchNo',
                            String(bs.batch_no || '').toUpperCase(),
                          );
                          // Auto-fill Qty = min(available, remaining needed).
                          // Remaining = product planned qty − qty already in the
                          // OTHER batch rows.
                          const otherSum = currentBatches.reduce(
                            (s, x, j) =>
                              j === idx ? s : s + (parseFloat(x.qty) || 0),
                            0,
                          );
                          const remaining = requiredQty - otherSum;
                          const fill =
                            remaining > 0 ? Math.min(avail, remaining) : 0;
                          updateBatch(idx, 'qty', fill > 0 ? String(fill) : '');
                        }
                        setBatchPicker(null);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.optionCode}>{String(bs.batch_no || '')}</Text>
                      <Text style={styles.optionName}>
                        Available: {fmtQty(bs.available)}{bs.uom ? ' ' + bs.uom : ''}
                        {bs.mfg_date ? ' · Mfg ' + bs.mfg_date : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Product QR scanner — mounted only while scanning; wrapped so a camera
          failure can't crash the app. */}
      {scannerOpen ? (
        <ScannerBoundary
          onClose={() => setScannerOpen(false)}
          message="The QR scanner couldn't start on this device. Please try again or pick the product from the list."
        >
          <QrScanner
            visible
            codeTypes={SCAN_CODE_TYPES}
            hint={
              scanTarget && scanTarget.type === 'batch'
                ? 'Align the batch QR code or barcode within the frame'
                : 'Align the product QR code or barcode within the frame'
            }
            onClose={() => {
              setScannerOpen(false);
              setScanTarget(null);
            }}
            onScanned={onScanned}
            onTimeout={() => {
              setScannerOpen(false);
              setScanTarget(null);
              Alert.alert(MSG.SCAN_TIMEOUT.title, MSG.SCAN_TIMEOUT.message);
            }}
          />
        </ScannerBoundary>
      ) : null}

      {/* Short-submit reason — opens when Submit is tapped with any product
          below its planned quantity. A reason is mandatory; "Other" needs a
          note. The chosen reason is stored on the DIL (vc_short_remark). */}
      <Modal
        visible={shortModalOpen}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setShortModalOpen(false)}
      >
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => setShortModalOpen(false)}
        >
          <Pressable style={styles.pickerPanel} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Submit with less quantity?</Text>
            <ScrollView
              style={styles.pickerList}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.shortIntro}>
                These products are not fully batched:
              </Text>
              <Text style={styles.shortList}>{shortLinesText}</Text>
              <Text style={styles.shortReasonLabel}>
                Reason <Text style={styles.requiredMark}>*</Text>
              </Text>
              {SHORT_REASONS.map(r => {
                const active = shortReason === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.reasonRow, active && styles.reasonRowActive]}
                    onPress={() => setShortReason(r)}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.reasonRadio,
                        active && styles.reasonRadioActive,
                      ]}
                    >
                      {active ? <View style={styles.reasonRadioDot} /> : null}
                    </View>
                    <Text style={styles.reasonText}>{r}</Text>
                  </TouchableOpacity>
                );
              })}
              <Text style={styles.shortReasonLabel}>
                Note{' '}
                {shortReason === 'Other' ? (
                  <Text style={styles.requiredMark}>*</Text>
                ) : (
                  <Text style={styles.labelUnit}>(optional)</Text>
                )}
              </Text>
              <TextInput
                style={styles.shortNote}
                value={shortNote}
                onChangeText={setShortNote}
                placeholder={
                  shortReason === 'Other'
                    ? 'Describe the reason…'
                    : 'Add any detail (optional)…'
                }
                placeholderTextColor="#9AA0AA"
                multiline
                maxLength={255}
              />
            </ScrollView>
            <View style={styles.shortBtnRow}>
              <TouchableOpacity
                style={[styles.shortBtn, styles.shortBtnCancel]}
                onPress={() => setShortModalOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.shortBtnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.shortBtn, styles.shortBtnConfirm]}
                onPress={confirmShortSubmit}
                activeOpacity={0.8}
              >
                <Text style={styles.shortBtnConfirmText}>Submit anyway</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full-screen photo viewer — the tiles' "View" button. */}
      <Modal
        visible={photoViewer.open}
        transparent
        animationType="fade"
        onRequestClose={() =>
          setPhotoViewer({ open: false, uri: null, loading: false, label: '' })
        }
      >
        <View style={styles.photoViewerBackdrop}>
          <View style={styles.photoViewerBar}>
            <Text style={styles.photoViewerTitle} numberOfLines={1}>
              {photoViewer.label}
            </Text>
            <TouchableOpacity
              onPress={() =>
                setPhotoViewer({ open: false, uri: null, loading: false, label: '' })
              }
              style={styles.photoViewerClose}
              accessibilityRole="button"
              accessibilityLabel="Close photo"
            >
              <Text style={styles.photoViewerCloseText}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.photoViewerBody}>
            {photoViewer.loading ? (
              <ActivityIndicator size="large" color="#FFFFFF" />
            ) : photoViewer.uri ? (
              <Image
                source={{ uri: photoViewer.uri }}
                style={styles.photoViewerImg}
                resizeMode="contain"
              />
            ) : (
              <Text style={styles.photoViewerEmpty}>No image to show.</Text>
            )}
          </View>
        </View>
      </Modal>

      {/* Standard branded logo loader while fetching or saving. */}
      {productsLoading ? (
        <BrandLoader title="DIL Entry" caption="Fetching Data" />
      ) : null}
      {saving ? (
        <BrandLoader title="DIL Entry" caption={saveCaption} />
      ) : null}
    </KeyboardAvoidingView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  // Large bottom padding so the last fields (pallet detail, Save/Submit) can
  // scroll clear of the on-screen keyboard on Android.
  content: { padding: 16, paddingBottom: 320 },

  // Transparent card — the pink page wash shows through. Border is a soft but
  // clearly visible red (redTint was too close to the page colour to see).
  card: {
    backgroundColor: 'transparent',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(227,0,27,0.40)',
  },

  label: {
    fontWeight: '600',
    color: COLORS.darkText,
    marginBottom: 8,
    fontSize: 14,
  },
  requiredMark: { color: COLORS.primaryRed, fontWeight: '800' },
  // Smaller, lighter unit hint inside a label (e.g. "(In KG)") so long labels
  // don't wrap to a second line on narrow screens.
  labelUnit: { fontSize: 11, fontWeight: '500', color: COLORS.muted },

  // ---- Dispatch photo tiles ----
  photoTile: {
    width: '100%',
    height: 150,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    backgroundColor: '#FAFAFB',
    overflow: 'hidden',
    marginBottom: 12,
  },
  photoTileEmptyBorder: { borderStyle: 'dashed', borderColor: '#D8B4BA' },
  photoTileEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  photoTileIcon: { width: 42, height: 42, tintColor: COLORS.primaryRed },
  photoTileLabel: {
    marginTop: 10,
    color: COLORS.mediumText,
    fontWeight: '700',
    fontSize: 13,
    textAlign: 'center',
  },
  photoTileUploaded: { color: '#1E9E57', fontWeight: '800', fontSize: 15 },
  photoTileReplace: { marginTop: 4, color: COLORS.muted, fontSize: 11, fontWeight: '600' },
  photoTileImg: { width: '100%', height: '100%' },
  photoTileRetake: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 6,
    alignItems: 'center',
  },
  photoTileRetakeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12, letterSpacing: 0.3 },

  // Filled tile (preview or "Uploaded") with a two-button action bar.
  photoTileBody: { flex: 1, width: '100%', overflow: 'hidden' },
  photoTileImgFill: { flex: 1, width: '100%' },
  photoTileActions: {
    flexDirection: 'row',
    height: 40,
    borderTopWidth: 1,
    borderTopColor: COLORS.inputBorder,
    backgroundColor: '#FFFFFF',
  },
  photoTileActionBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  photoTileActionDivider: { width: 1, backgroundColor: COLORS.inputBorder },
  photoTileActionText: { color: COLORS.mediumText, fontWeight: '700', fontSize: 13 },
  photoTileActionReplace: { color: COLORS.primaryRed },

  // ---- Full-screen photo viewer ----
  photoViewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  photoViewerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 44,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  photoViewerTitle: { flex: 1, color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  photoViewerClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  photoViewerCloseText: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  photoViewerBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  photoViewerImg: { width: '100%', height: '100%' },
  photoViewerEmpty: { color: '#FFFFFF', fontSize: 14 },

  // ---- Loading time row ----
  timeRow: { flexDirection: 'row', marginTop: 2 },
  timeCol: { flex: 1, marginRight: 8 },
  timeColRight: { flex: 1, marginLeft: 8 },
  timeInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  timeInput: { flex: 1, marginBottom: 0 },
  timeNowBtn: {
    marginLeft: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: COLORS.primaryRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeNowText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },

  // ---- Loading date-time TIME picker ----
  dtChosenDate: {
    paddingHorizontal: 18,
    paddingBottom: 10,
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primaryRed,
  },
  dtTimeRow: { flexDirection: 'row', paddingHorizontal: 12 },
  dtTimeCol: { flex: 1, paddingHorizontal: 6 },
  dtTimeColHead: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.muted,
    marginBottom: 6,
  },
  dtTimeScroll: { height: 200 },
  dtTimeItem: { paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  dtTimeItemActive: { backgroundColor: COLORS.redTint },
  dtTimeItemText: { fontSize: 16, color: COLORS.darkText, fontWeight: '600' },
  dtTimeItemTextActive: { color: COLORS.primaryRed, fontWeight: '800' },
  dtBtnRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 12,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EDEDED',
  },
  dtBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  dtBtnBack: {
    borderWidth: 1.5,
    borderColor: COLORS.inputBorder,
    marginRight: 8,
    backgroundColor: '#FFFFFF',
  },
  dtBtnBackText: { color: COLORS.darkText, fontSize: 15, fontWeight: '700' },
  dtBtnOk: { backgroundColor: COLORS.primaryRed, marginLeft: 8 },
  dtBtnOkText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  // ---- Full-screen camera ----
  camBar: {
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
  },
  shutter: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primaryRed,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 50,
  },
  shutterIcon: { width: 20, height: 20, tintColor: '#FFFFFF' },
  shutterText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15, marginLeft: 9 },
  camSideBtn: { padding: 12 },
  camSideText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  camFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#000' },
  camFallbackText: { color: '#FFFFFF', fontSize: 15, textAlign: 'center', marginBottom: 20 },
  camClose: { backgroundColor: COLORS.primaryRed, borderRadius: 50, paddingVertical: 12, paddingHorizontal: 30 },
  camCloseText: { color: '#FFFFFF', fontWeight: '700' },

  // Tappable date field — same look as the report screens' date buttons.
  dateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#FFFFFF',
    marginBottom: 16,
  },
  dateBtnText: { fontSize: 15, color: COLORS.darkText, fontWeight: '600' },

  input: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    fontSize: 15,
    color: COLORS.darkText,
    marginBottom: 16,
  },

  // Read-only value: same size and radius as an input, but greyed and without
  // a white fill, so it reads as "shown to you" rather than "type here".
  readonlyBox: {
    backgroundColor: '#F4F5F7',
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    marginBottom: 6,
  },
  readonlyBoxWarn: {
    backgroundColor: '#FDEEF0',
    borderColor: COLORS.primaryRed,
  },
  readonlyText: { fontSize: 15, color: COLORS.darkText, fontWeight: '700' },
  readonlyPlaceholder: { fontSize: 15, color: '#9AA0AA' },
  readonlyWarnText: { fontSize: 15, color: COLORS.primaryRed, fontWeight: '700' },

  hint: { fontSize: 12, color: COLORS.muted, marginBottom: 16 },
  hintWarn: {
    fontSize: 12,
    color: COLORS.primaryRed,
    marginBottom: 16,
    lineHeight: 17,
  },

  buttonRow: { flexDirection: 'row', marginTop: 4 },
  button: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { flex: 1, backgroundColor: COLORS.primaryRed },
  buttonDisabled: { backgroundColor: '#E7A9B1' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  buttonReset: {
    marginLeft: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: COLORS.primaryRed,
    minWidth: 88,
  },
  buttonResetText: { color: COLORS.primaryRed, fontSize: 15, fontWeight: '700' },

  // Locked look for DIL No / DIL Date after details are loaded.
  inputLocked: { backgroundColor: '#F4F5F7', color: COLORS.muted },

  // Invalid input outline + message.
  inputError: { borderColor: COLORS.primaryRed, borderWidth: 1.5 },
  fieldError: {
    fontSize: 12,
    color: COLORS.primaryRed,
    marginTop: -8,
    marginBottom: 14,
    lineHeight: 16,
  },

  // Vehicle Number type-ahead suggestion dropdown. Rendered inline, tucked just
  // under the input (negative margin bridges the input's 16px bottom gap), and
  // height-capped so a long list scrolls instead of pushing the form down.
  suggestBox: {
    marginTop: -12,
    marginBottom: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  suggestList: { maxHeight: 220 },
  suggestRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EEF0F3',
  },
  suggestRowLast: { borderBottomWidth: 0 },
  suggestVeh: { fontSize: 15, fontWeight: '700', color: COLORS.darkText },
  suggestSub: { fontSize: 12, color: COLORS.muted, marginTop: 2 },

  detailsBox: {
    marginTop: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  entrySection: { marginTop: 22 },

  // Background-reconcile strip shown at the top of the form while a reopened
  // draft is being re-synced with SAP.
  syncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF6E6',
    borderWidth: 1,
    borderColor: '#F3D08A',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 14,
  },
  syncBannerText: {
    marginLeft: 8,
    color: '#8A5A00',
    fontSize: 13,
    fontWeight: '700',
  },

  // Live Stock table (all DIL products).
  lsTable: {
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 10,
    overflow: 'hidden',
  },
  lsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ECECEC',
  },
  lsRowLast: { borderBottomWidth: 0 },
  // Header in the app's classic red theme.
  lsHeadRow: { backgroundColor: COLORS.primaryRed, paddingVertical: 10 },
  lsHeadText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.3,
    textAlign: 'center',
    borderLeftColor: 'rgba(255,255,255,0.35)',
  },
  // All cells centered (both header and body).
  lsCellName: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  // Vertical grid line between columns (numeric cells carry the left border).
  lsCellNum: {
    width: 66,
    textAlign: 'center',
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '700',
    borderLeftWidth: 1,
    borderLeftColor: '#ECECEC',
    paddingHorizontal: 4,
  },
  lsName: {
    fontSize: 13,
    color: COLORS.darkText,
    fontWeight: '600',
    lineHeight: 17,
    textAlign: 'center',
  },
  lsCode: {
    fontSize: 10,
    color: COLORS.muted,
    marginTop: 2,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  lsResv: { color: COLORS.primaryRed },
  lsAvail: { color: '#137a3f' },
  // Short product: whole row tinted red with a left accent bar; the Available
  // figure turns red and a "Short by …" tag appears under the code.
  lsRowShort: {
    backgroundColor: '#FFF0F0',
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primaryRed,
  },
  lsAvailShort: { color: COLORS.primaryRed, fontWeight: '800' },
  lsShortTag: {
    fontSize: 9,
    fontWeight: '800',
    color: COLORS.primaryRed,
    marginTop: 2,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  lsRefreshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    marginBottom: 4,
  },
  lsUpdatedText: { fontSize: 11, color: COLORS.muted, fontStyle: 'italic' },
  lsRefreshBtn: {
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  lsRefreshBtnDisabled: { opacity: 0.5 },
  lsRefreshText: { color: COLORS.primaryRed, fontSize: 12, fontWeight: '700' },

  // Pallet detail — two side-by-side inputs.
  palletRow: { flexDirection: 'row' },
  palletCol: { flex: 1, marginRight: 8 },
  palletColRight: { flex: 1, marginLeft: 8 },
  palletTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FDECEC',
    borderRadius: 6,
  },
  palletTotalLabel: { fontSize: 14, fontWeight: '600', color: '#333' },
  palletTotalValue: { fontSize: 15, fontWeight: '700', color: '#C62828' },

  // Save / Submit.
  saveRow: { flexDirection: 'row', marginTop: 22 },
  saveBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: COLORS.primaryRed,
    marginRight: 8,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: COLORS.primaryRed, fontSize: 15, fontWeight: '700' },
  submitBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: COLORS.primaryRed,
    marginLeft: 8,
  },
  submitBtnDisabled: { backgroundColor: '#E7A9B1' },
  submitBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  // Highlighted section heading (e.g. "Driver & Vehicle Details").
  sectionHeader: {
    backgroundColor: COLORS.redTint,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primaryRed,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  sectionHeaderText: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.primaryRed,
    letterSpacing: 0.3,
  },
  // Collapsible header: same bar, laid out as a row so the chevron sits right.
  sectionHeaderToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionHeaderTextFlex: { flex: 1, paddingRight: 10 },

  // DIL document header — a white card lifted off the pink page with a soft
  // shadow and a red border on all sides, so it reads as a distinct,
  // highlighted block.
  headerBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.primaryRed,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 18,
    marginHorizontal: 2,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 7,
  },
  headerLabel: { fontSize: 13, color: COLORS.muted, paddingRight: 12 },
  headerValue: {
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },

  // Product dropdown + scan button row.
  dropdownRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginBottom: 16,
  },
  dropdownFlex: { flex: 1, marginBottom: 0 },
  scanBtn: {
    marginLeft: 10,
    width: 52,
    borderRadius: 12,
    backgroundColor: COLORS.primaryRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrImg: { width: 22, height: 22, tintColor: '#FFFFFF' },

  // Product dropdown field.
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
    marginBottom: 16,
  },
  dropdownSelected: { flex: 1, fontSize: 15, color: COLORS.darkText, fontWeight: '600' },
  dropdownPlaceholder: { flex: 1, fontSize: 15, color: '#9AA0AA' },
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

  // Selected-product detail rows.
  pRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ECECEC',
  },
  pRowLast: { borderBottomWidth: 0 },
  pLabel: { fontSize: 13, color: COLORS.muted, paddingRight: 12 },
  pValue: {
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },

  // Batches for a product.
  // marginBottom separates the batch section (its "+ Add Batch" button / hint)
  // from the next section header below it (e.g. "Pallet Detail"), which has no
  // top margin of its own — without it the two touch/overlap.
  batchWrap: { marginTop: 16, marginBottom: 18 },
  batchTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  batchTitle: { fontSize: 14, fontWeight: '700', color: COLORS.darkText },
  batchTally: { fontSize: 14, fontWeight: '800' },
  batchTallyOk: { color: '#137a3f' },
  batchTallyOver: { color: COLORS.primaryRed },
  batchTallyPend: { color: COLORS.muted },
  batchItem: { marginBottom: 10 },
  batchRow: { flexDirection: 'row', alignItems: 'center' },
  batchNoWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    paddingRight: 6,
  },
  // Dropdown (pick from SAP stock) button — a small caret chip.
  batchListBtn: {
    width: 30,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#F0F1F4',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  caretSm: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: COLORS.mediumText,
  },
  batchStockHint: {
    fontSize: 11,
    color: '#137a3f',
    marginTop: 4,
    marginLeft: 2,
  },
  batchStockHintMuted: {
    fontSize: 11,
    color: COLORS.muted,
    marginTop: 4,
    marginLeft: 2,
  },
  pickerEmpty: {
    fontSize: 13,
    color: COLORS.muted,
    textAlign: 'center',
    paddingVertical: 18,
    paddingHorizontal: 12,
    lineHeight: 18,
  },
  batchNoInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: COLORS.darkText,
  },
  batchScanBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: COLORS.primaryRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrImgSmall: { width: 18, height: 18, tintColor: '#FFFFFF' },
  batchQtyInput: {
    width: 62,
    marginLeft: 8,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: COLORS.darkText,
    textAlign: 'right',
  },
  batchRemove: {
    width: 30,
    height: 30,
    marginLeft: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  batchRemoveText: { fontSize: 24, color: COLORS.muted, lineHeight: 26 },

  // Per-batch Save ("+") button + saved state — compact square to save width.
  batchSaveBtn: {
    marginLeft: 8,
    width: 38,
    height: 42,
    borderRadius: 10,
    backgroundColor: COLORS.primaryRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  batchSaveBtnDisabled: { backgroundColor: '#E7A9B1' },
  batchSaveText: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', lineHeight: 26 },
  batchSavedChip: {
    marginLeft: 8,
    width: 38,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#E7F6EC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  batchSavedChipText: { color: '#137a3f', fontSize: 18, fontWeight: '800' },
  // Locked (saved) input look.
  batchLocked: { backgroundColor: '#F4F5F7' },
  addBatchBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1.5,
    borderColor: COLORS.primaryRed,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginTop: 2,
  },
  addBatchText: { color: COLORS.primaryRed, fontWeight: '700', fontSize: 14 },
  batchActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // Same outlined-pill treatment as "+ Add Batch", in green (vs red) to keep
  // the two buttons visually consistent.
  doneBtn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: '#137a3f',
    borderRadius: 10,
    paddingHorizontal: 22,
    paddingVertical: 9,
    alignItems: 'center',
  },
  doneBtnText: { color: '#137a3f', fontSize: 14, fontWeight: '700' },
  batchHint: { fontSize: 12, color: COLORS.muted, marginTop: 10, lineHeight: 16 },
  batchWarn: {
    fontSize: 12,
    color: COLORS.primaryRed,
    marginTop: 10,
    lineHeight: 16,
  },

  addProductBtn: {
    marginTop: 16,
    backgroundColor: COLORS.primaryRed,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  addProductBtnDisabled: { backgroundColor: '#E7A9B1' },
  addProductText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  // Added products list.
  addedWrap: { marginTop: 22, marginBottom: 18 },
  addedHeading: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.darkText,
    marginBottom: 12,
  },
  addedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    padding: 12,
    marginBottom: 12,
  },
  addedCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  addedCardTitle: { flex: 1, paddingRight: 10 },
  addedName: { fontSize: 14, fontWeight: '700', color: COLORS.darkText, lineHeight: 19 },
  addedCode: { fontSize: 11, color: COLORS.muted, marginTop: 2 },
  addedActions: { flexDirection: 'row', alignItems: 'center' },
  addedEdit: {
    borderWidth: 1,
    borderColor: COLORS.mediumText,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginRight: 8,
  },
  addedEditText: { color: COLORS.mediumText, fontSize: 12, fontWeight: '700' },
  addedRemove: {
    borderWidth: 1,
    borderColor: COLORS.primaryRed,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  addedRemoveText: { color: COLORS.primaryRed, fontSize: 12, fontWeight: '700' },
  addedBatchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#F0F0F0',
  },
  addedBatchNo: { fontSize: 13, color: COLORS.mediumText },
  addedBatchQty: { fontSize: 13, color: COLORS.darkText, fontWeight: '600' },
  addedTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.inputBorder,
  },
  addedTotalLabel: { fontSize: 13, fontWeight: '700', color: COLORS.muted },
  addedTotalValue: { fontSize: 14, fontWeight: '800', color: '#137a3f' },

  // Product picker modal.
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
  pickerList: { paddingHorizontal: 8 },
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
  // Inline clear (✕) button on the plant dropdown field.
  plantClearBtn: {
    width: 40,
    height: 44,
    marginLeft: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(227,0,27,0.40)',
    backgroundColor: '#FFF0F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  plantClearIcon: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.primaryRed,
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
  optionSub: { fontSize: 12, color: COLORS.muted, marginTop: 3, fontWeight: '600' },

  // ---- Short-submit reason modal ----
  shortIntro: {
    fontSize: 13,
    color: COLORS.muted,
    paddingHorizontal: 10,
    marginBottom: 6,
    fontWeight: '600',
  },
  shortList: {
    fontSize: 13,
    color: COLORS.darkText,
    paddingHorizontal: 10,
    lineHeight: 20,
    marginBottom: 14,
  },
  shortReasonLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.darkText,
    paddingHorizontal: 10,
    marginBottom: 8,
    marginTop: 4,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  reasonRowActive: { backgroundColor: COLORS.redTint },
  reasonRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  reasonRadioActive: { borderColor: COLORS.primaryRed },
  reasonRadioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.primaryRed,
  },
  reasonText: { fontSize: 15, color: COLORS.darkText, fontWeight: '600' },
  shortNote: {
    marginHorizontal: 10,
    marginBottom: 6,
    minHeight: 64,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: COLORS.darkText,
    textAlignVertical: 'top',
  },
  shortBtnRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EDEDED',
  },
  shortBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortBtnCancel: {
    borderWidth: 1.5,
    borderColor: COLORS.inputBorder,
    marginRight: 8,
    backgroundColor: '#FFFFFF',
  },
  shortBtnCancelText: { color: COLORS.darkText, fontSize: 15, fontWeight: '700' },
  shortBtnConfirm: {
    backgroundColor: COLORS.primaryRed,
    marginLeft: 8,
  },
  shortBtnConfirmText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  // De-select / Clear Selection row at the bottom of the Select Product list.
  optionClear: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 12,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: COLORS.inputBorder,
  },
  optionClearIcon: {
    color: COLORS.primaryRed,
    fontSize: 15,
    fontWeight: '800',
    marginRight: 8,
  },
  optionClearText: {
    color: COLORS.primaryRed,
    fontSize: 14,
    fontWeight: '700',
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.inputBorder,
    marginVertical: 18,
  },
});

export default DilEntryScreen;
