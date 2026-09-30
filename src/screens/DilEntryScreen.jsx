import React, { useState, useEffect, useCallback, useRef } from 'react';
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
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import CalendarModal from '../components/CalendarModal';
import BrandLoader from '../components/BrandLoader';
import QrScanner from '../components/QrScanner';
import ScannerBoundary from '../components/ScannerBoundary';
import { MSG } from '../constants/messages';

const QR_ICON = require('../assets/qr_scan.png');

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

const DilEntryScreen = () => {
  // From the session, not from the form.
  const [plantCode, setPlantCode] = useState('');
  const [plantNo, setPlantNo] = useState('');
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

  // Optional pallet detail (whole DIL): number of pallets + weight per pallet.
  const [palletQty, setPalletQty] = useState('');
  const [palletWeight, setPalletWeight] = useState('');

  // Save / submit in flight (+ loader caption for the branded overlay).
  const [saving, setSaving] = useState(false);
  const [saveCaption, setSaveCaption] = useState('Saving');

  const loadPlant = useCallback(async () => {
    let [code, no] = await Promise.all([
      getItem(KEYS.plantCode),
      getItem(KEYS.plantNo),
    ]);

    code = (code || '').trim();
    no = (no || '').trim();

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
          }
        }
      } catch (e) {
        // Fall back gracefully to storage values
      }
    }

    setPlantCode(code);
    setPlantNo(no);
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
    [products, plantCode, plantNo],
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
    setPalletQty('');
    setPalletWeight('');
    setShowEntry(false);

    try {
      const employeeId = (await getItem(KEYS.userId)) || '';

      // 1. Is this DIL already in our system? Block if submitted; remember a
      //    draft so we can resume it.
      let existing = null;
      try {
        const ex = await apiPost(ENDPOINTS.dilApi, {
          rtype: '1',
          employee_id: employeeId,
          dil_no: dil,
        });
        existing = ex && ex.data ? ex.data : null;
      } catch (e) {
        if (e && e.sessionExpired) throw e;
        // Status check failed — proceed as a fresh entry.
      }
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

      // 2. Load the product list.
      const list = await loadProductList(dil, dateStr);
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

      // 2b. Reconcile our saved data against the CURRENT SAP list. Products can
      // change in SAP after we first saved batches (dropped, or qty cut because
      // stock wasn't available). This releases stale reservations / re-syncs
      // quantities on the server, then we reload the cleaned state and tell the
      // user what changed. Best effort — never blocks opening the DIL.
      if (
        existing &&
        String(existing.status) === '1' &&
        existing.products &&
        existing.products.length
      ) {
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
            // Reload the corrected saved state so the card reflects the cleanup.
            try {
              const ex2 = await apiPost(ENDPOINTS.dilApi, {
                rtype: '1',
                employee_id: empId,
                dil_no: dil,
              });
              if (ex2 && ex2.data) existing = ex2.data;
            } catch (e2) {
              if (e2 && e2.sessionExpired) throw e2;
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
          }
        } catch (e) {
          if (e && e.sessionExpired) throw e;
          // Reconcile is best-effort; carry on with what we have.
        }
      }

      // Claim the DIL in our master table now (status 1) with the ACTUAL DIL
      // date, so this refresh doesn't overwrite it back to the selected date.
      ensureDraft(list[0], dil, actualApiDate);

      // Live stock for every product in the DIL (summary table).
      fetchAllStock(list);

      // 3a. Resume a saved draft — prefill header + rebuild added products.
      if (existing && String(existing.status) === '1') {
        setDriverName(String(existing.driver_name || '').toUpperCase());
        setMobileNo(
          String(existing.mobile_no || '').replace(/[^0-9]/g, '').slice(0, 10),
        );
        setVehicleNo(
          String(existing.vehicle_no || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, ''),
        );
        setPalletQty(String(existing.pallet_qty || ''));
        setPalletWeight(String(existing.pallet_weight || ''));

        const added = [];
        const batchMap = {};
        (existing.products || []).forEach(sp => {
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
          // Any product that already has saved batches belongs in the list card
          // (shown as Pending until its qty is met, then Complete). Previously
          // only fully-batched products were restored, so a partially-entered
          // product vanished from the card on reload until it was re-opened and
          // closed again.
          if ((sp.batches || []).length > 0) {
            added.push(key);
          }
        });
        setBatchesByEbelp(batchMap);
        setAddedEbelps(added);
      } else {
        // 3b. Fresh entry: prefill driver from the product header (K-DB only).
        prefillDriverFromHead(list[0]);
      }

      setShowEntry(true);
    } catch (e) {
      if (!e || !e.sessionExpired) {
        Alert.alert('No Data Found...!', 'Please verify DIL No & Date.');
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

  // Label shown for a product: "MATNR - Material Name".
  const productLabel = p =>
    `${String(p.MATNR || '')}${p.TXZ01 ? ' - ' + p.TXZ01 : ''}`;

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
  useEffect(() => {
    if (!showEntry) return undefined;
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

  // Save (status 1) or Submit (status 2). Both need the header fields valid and
  // at least one added product; added products already have balanced batches.
  const saveEntry = useCallback(
    async submitStatus => {
      if (addedEbelps.length === 0) {
        Alert.alert('Nothing to save', 'Add at least one product first.');
        return;
      }
      // Final submit requires EVERY product line to be fully batched (Complete),
      // not merely present in the card. A product shown as "Pending" (saved
      // batches below its required qty) blocks the submit.
      if (submitStatus === 2) {
        const incomplete = products
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
          .filter(
            x => !(x.required > 0 && Math.abs(x.total - x.required) < 0.0001),
          );
        if (incomplete.length > 0) {
          const lines = incomplete
            .map(x => {
              const uom = x.p.MEINS ? ' ' + x.p.MEINS : '';
              const left = x.required - x.total;
              return `• ${String(x.p.MATNR || '')} — ${fmtQty(
                x.total,
              )} of ${fmtQty(x.required)}${uom} added, ${fmtQty(
                left,
              )}${uom} left`;
            })
            .join('\n');
          Alert.alert(
            'Finish all products first',
            `You can submit only after every product has its full quantity added.\n\nStill pending:\n${lines}`,
          );
          return;
        }
      }
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

      // Products & batches are already persisted (rtype 6/7); this only saves
      // the header/driver/pallet and the status.
      setSaveCaption(submitStatus === 2 ? 'Submitting' : 'Saving');
      setSaving(true);
      try {
        const employeeId = (await getItem(KEYS.userId)) || '';
        const res = await apiPost(ENDPOINTS.dilApi, {
          rtype: '3',
          employee_id: employeeId,
          dil_no: dilNo.trim(),
          driver_name: driverName.trim(),
          mobile_no: mobileNo,
          vehicle_no: vehicleNo,
          pallet_qty: palletQty,
          pallet_weight: palletWeight,
          wb_plant_code: (dilPlant && dilPlant.plant_code) || '', // top dropdown
          status: String(submitStatus),
        });

        if (res && String(res.statusCode) === '200') {
          Alert.alert(
            submitStatus === 2 ? 'Submitted' : 'Saved',
            submitStatus === 2
              ? 'Data Submitted Successfully...!'
              : 'Data Save Successfully...!',
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
    [
      addedEbelps,
      products,
      batchesByEbelp,
      driverName,
      mobileNo,
      vehicleNo,
      palletQty,
      palletWeight,
      dilNo,
      dilPlant,
      resetAll,
    ],
  );

  // Inline validation — only flag once the user has typed something, so an
  // untouched field never shows red.
  const mobileInvalid = mobileNo.length > 0 && !MOBILE_RE.test(mobileNo);
  const vehicleInvalid = vehicleNo.length > 0 && !VEHICLE_RE.test(vehicleNo);

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
                onPress={() => setDilPlant(null)}
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
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>
                  Driver &amp; Vehicle Details
                </Text>
              </View>

              <Label required>Driver Name</Label>
              <TextInput
                style={styles.input}
                value={driverName}
                onChangeText={text =>
                  setDriverName(text.toUpperCase().replace(/[^A-Z .]/g, ''))
                }
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
                placeholder="10-digit mobile number"
                placeholderTextColor="#9AA0AA"
                keyboardType="number-pad"
                maxLength={10}
                returnKeyType="next"
              />
              {mobileInvalid ? (
                <Text style={styles.fieldError}>
                  Enter a valid 10-digit mobile number starting 6-9.
                </Text>
              ) : null}

              <Label required>Vehicle Number</Label>
              <TextInput
                style={[styles.input, vehicleInvalid && styles.inputError]}
                value={vehicleNo}
                onChangeText={text =>
                  setVehicleNo(text.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                }
                placeholder="e.g. GJ01AB1234"
                placeholderTextColor="#9AA0AA"
                maxLength={15}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
              />
              {vehicleInvalid ? (
                <Text style={styles.fieldError}>
                  Enter a valid vehicle number, e.g. GJ01AB1234.
                </Text>
              ) : null}

              <View style={styles.divider} />

              {/* ---- Live Stock table for ALL DIL products --------------- */}
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>Live Stock</Text>
              </View>
              <View style={styles.lsTable}>
                <View style={[styles.lsRow, styles.lsHeadRow]}>
                  <Text style={[styles.lsCellName, styles.lsHeadText]}>Product</Text>
                  <Text style={[styles.lsCellNum, styles.lsHeadText]}>Total</Text>
                  <Text style={[styles.lsCellNum, styles.lsHeadText]}>Resv</Text>
                  <Text style={[styles.lsCellNum, styles.lsHeadText]}>Avail</Text>
                </View>
                {products.map((p, i) => {
                  const s = stockByMat[String(p.MATNR || '').toUpperCase()];
                  // A product is SHORT when its live available stock can't cover
                  // the quantity this DIL requires (MENGE). Only judged once stock
                  // has loaded (s present) and a required qty is known.
                  const required = parseFloat(p.MENGE) || 0;
                  const availNum = s ? parseFloat(s.available) || 0 : null;
                  const short =
                    availNum !== null &&
                    required > 0 &&
                    availNum + 0.0001 < required;
                  return (
                    <View
                      style={[
                        styles.lsRow,
                        short && styles.lsRowShort,
                        i === products.length - 1 && styles.lsRowLast,
                      ]}
                      key={p.EBELP || i}
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
                })}
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

              {/* Products loaded from the RFC into a dropdown. */}
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>Product Details</Text>
              </View>

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
                              style={styles.batchSaveBtn}
                              onPress={() => saveBatchRow(idx)}
                              activeOpacity={0.85}
                              accessibilityLabel="Save batch"
                            >
                              <Text style={styles.batchSaveText}>+</Text>
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

              {/* ---- Pallet Detail (optional) --------------------------- */}
              <View style={styles.divider} />
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>
                  Pallet Detail (If Used)
                </Text>
              </View>

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
                        setDilPlant(pl);
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

  // Tappable date field — same look as the report screens' date buttons.
  dateBtn: {
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
    marginTop: 10,
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
  batchWrap: { marginTop: 16 },
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
  addedWrap: { marginTop: 22 },
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
