import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Image,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  FlatList,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import { getItem, KEYS } from '../services/storage';
import { getDeviceId } from '../services/device';
import {
  fetchTextWithTimeout,
  looksUnauthorized,
  refreshToken,
} from '../services/api';
import { notifySessionExpired } from '../services/session';
import { ENDPOINTS } from '../config';
import { COLORS } from '../theme';
import { MSG } from '../constants/messages';
import useResponsive from '../hooks/useResponsive';

const YES_NO = [
  { label: 'Yes', value: 'Yes' },
  { label: 'No', value: 'No' },
];

// The fields a visit cannot be recorded without: who the visitor is, how to
// reach them, who they are meeting and why they are here. Everything else
// (company, address, city, vehicle, material, remarks) is useful but optional
// — a gate operator under time pressure shouldn't be blocked over them.
//
// This ONE list drives both the red * on the labels and the submit check, so
// the two can never drift apart. Add or remove a line to change both.
// Only what the APP checks. Everything else (first/last name, company,
// address, city, total person, contact person, visit type, health answers) is
// validated by insert_visitor_details.php and its error message is shown to
// the user — so the rules live in one place on the server rather than being
// duplicated, and half-maintained, here too.
//
// Contact Number stays app-side because it is the lookup key: it must be 10
// digits before the pre-fill request is even worth sending.
//
// This one list drives BOTH the red * and the submit check, so trimming it
// removes the markers everywhere automatically.
const REQUIRED_FIELDS = [
  ['contactNo', 'Contact Number'],
];

const isRequired = key => REQUIRED_FIELDS.some(([k]) => k === key);

// ---------------------------------------------------------------------------
// Remarks input rules.
//
// IMPORTANT — this is for DATA HYGIENE, not security. Stripping characters in
// the app does NOT protect the database: anyone can post to the endpoint
// directly and bypass this entirely. SQL injection is prevented by using
// parameterised queries in Add_VisitRecord_Visit_p.php (? placeholders with a
// params array), the same way the other endpoints do it. What this DOES buy:
// no newlines breaking report layouts, and no odd characters in exports.
//
// The allowed set is a whitelist rather than a blacklist of "bad" characters,
// because a blacklist always misses something. It deliberately keeps the
// punctuation real remarks need — "Meeting w/ Mr. Patel (2nd floor), 4:30" is
// still typeable — while excluding quotes, angle brackets, backslashes and
// semicolons.
// ---------------------------------------------------------------------------
const REMARK_MAX = 150;
const REMARK_ALLOWED = /[^A-Za-z0-9 .,\-/()&:#@]/g;

const sanitizeRemark = text =>
  String(text || '')
    .replace(/[\r\n]+/g, ' ')      // Enter / pasted line breaks -> single space
    .replace(REMARK_ALLOWED, '')   // drop anything outside the whitelist
    .slice(0, REMARK_MAX);

// ---------------------------------------------------------------------------
// Photo compression, per purpose.
//
// True LOSSLESS compression isn't available for photos — JPEG is lossy by
// definition and PNG (which is lossless) makes photos bigger, not smaller.
// What we can do is "visually lossless": downscale sensibly and keep quality
// high enough that the eye can't tell, which is where nearly all the saving
// comes from. Resolution matters far more than the quality slider.
//
// The two photos have OPPOSITE needs, so they no longer share one setting:
//
//   ID proof  — must stay READABLE. An ID number is fine text, and JPEG
//               artifacts cluster exactly on sharp edges like text. It gets a
//               bigger box and higher quality; a document that can't be read
//               is a functional failure, not a cosmetic one.
//   Visitor   — a face at thumbnail size. Small box, moderate quality is
//               indistinguishable and keeps the upload light.
//
// onlyScaleDown: never ENLARGE a photo that's already smaller than the box —
// upscaling adds bytes and invents no detail.
// ---------------------------------------------------------------------------
// Sizes chosen from how each photo is USED, not from one blanket setting:
//
//   id      1600 @ 85 — must survive zooming in to read a number/name. Text
//                       edges are exactly where JPEG artifacts appear, so
//                       quality stays high. ~250-450KB. Deliberately the
//                       largest item in the payload: an ID that can't be read
//                       is a failed record, and it can't be re-taken later.
//   general  1024 @ 82 — a face. Sized for IDENTIFICATION, not for the 180pt
//                        tile it happens to be shown in: this is a one-shot
//                        security record, and if it's ever reviewed after an
//                        incident nobody can go back and re-take it. 82 keeps
//                        eyes, glasses and hair edges clean (skin is forgiving
//                        at low quality, those details are not). ~110-180KB —
//                        a small price for a photo that has to remain usable.
const PHOTO_SPECS = {
  id:      { maxW: 1600, maxH: 1600, quality: 85 },
  general: { maxW: 1024, maxH: 1024, quality: 82 },
};

const EMPTY_FORM = {
  contactNo: '',
  firstName: '',
  lastName: '',
  companyName: '',
  visitorAddress: '',
  city: '',
  vehicleNo: '',
  totalPerson: '',
  contactPerson: null,
  visitType: null,
  material: '',
  purpose: '',
  remarks: '',
  // Default to 'No'. The backend maps anything that isn't "Yes" to No anyway,
  // so leaving these blank would submit "No" WITHOUT showing it — better that
  // the operator can see the answer that is going to be sent, and change it.
  diarrhoea: 'No',
  vomiting: 'No',
  skinInfection: 'No',
  otherIllness: 'No',
  fever: 'No',
  imageid: '',
};

// Attach the session token + device id to a JSON payload. The visitor screen
// posts JSON (not the app's FormData apiPost), so it doesn't get the automatic
// auth fields apiPost adds — this puts them in explicitly, so require_token.php
// can authenticate these endpoints exactly like the FormData ones. Read fresh
// each call so a token refreshed mid-session is always the current one.
async function withAuth(payload) {
  const [token, username, userType, deviceId] = await Promise.all([
    getItem(KEYS.apiToken),
    getItem(KEYS.username),
    getItem(KEYS.userType),
    getDeviceId(),
  ]);
  return {
    ...payload,
    token: token || '',
    username: username || '',
    user_type: userType || '',
    device_id: payload.device_id || deviceId || '',
  };
}

// POST a JSON body through the app's BOUNDED fetch (never raw fetch — an
// unbounded request that hangs is the exact App Store 2.1(a) "infinite spinner"
// failure). Auth fields (token/device) are injected automatically.
//
// Mirrors apiPost's self-heal so the JSON visitor endpoints behave EXACTLY like
// the FormData ones when require_token.php rejects a request: a 401 triggers one
// silent token refresh + retry (routine daily expiry — user notices nothing),
// and only if that refresh fails is the session reported as over, which the
// navigator turns into the clean "Signed Out -> Login" flow. Without this, an
// expired session on the visitor screen would surface as empty dropdowns or a
// raw error object instead of the proper redirect.
//
// Returns parsed JSON, or throws on timeout/parse error.
async function postJson(url, payload, timeoutMs) {
  const authed = await withAuth(payload);
  const doSend = () =>
    fetchTextWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authed),
      },
      timeoutMs,
    );

  let { text, status } = await doSend();

  if (looksUnauthorized(status, text)) {
    const fresh = await refreshToken();
    if (fresh) {
      authed.token = fresh;
      ({ text } = await doSend());
    } else {
      // Unrecoverable: navigator shows ONE "Signed Out" alert + resets to
      // Login. Throw a tagged error so the caller swallows it instead of
      // parsing the 401 body and raising a second alert on top.
      notifySessionExpired('refresh-failed');
      const err = new Error('session-expired');
      err.sessionExpired = true;
      throw err;
    }
  }
  return JSON.parse(text);
}

// Camera icon (black line-art, transparent PNG). Rendered as-is on light tiles;
// tinted white on the red capture button.
const CAMERA_ICON = require('../assets/camera.png');

// ---------------------------------------------------------------------------
// SelectField — anchored dropdown, written here rather than using
// react-native-element-dropdown.
//
// The library measured the field's position but rendered its list in a Modal
// whose origin uses a DIFFERENT coordinate system (translucent status bar +
// nested ScrollView/KeyboardAvoidingView), so the list consistently appeared
// about a field-height too low. No combination of its props fixed it.
//
// This version removes the guesswork: measureInWindow() gives true window
// coordinates, and the Modal is statusBarTranslucent so it covers the whole
// window — the two coordinate systems are then identical, and the list lands
// exactly under the field. Flips above automatically when space below is tight.
// ---------------------------------------------------------------------------

// `clearable` (default true) adds a "De-select / Clear Selection" row at the
// bottom of the OPENED list once a value is chosen, so a selection can be
// undone from inside the dropdown — without it a mis-tap was permanent.
const SelectField = ({
  data = [],
  value,
  placeholder,
  onChange,
  search = false,
  clearable = true,
}) => {
  const anchorRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [query, setQuery] = useState('');

  // Codebase rule (hooks/useResponsive.js): no layout-critical dimension may be
  // a bare constant. Everything below derives from the live window, so the list
  // adapts to small phones, tablets, landscape and split-screen.
  const { width: winW, height: winH, clamp, scale } = useResponsive();

  const optionH = scale(46);                          // row height
  const listMaxH = clamp(winH * 0.45, 150, 340);      // never dominate the screen
  const GAP = scale(6);
  const EDGE = scale(8);                              // min gap from screen edges

  // A measurement taken before rotation/resize is meaningless afterwards — the
  // panel would be pinned to where the field USED to be. Close on any window
  // change and let the user reopen against fresh coordinates.
  useEffect(() => {
    setOpen(false);
  }, [winW, winH]);

  const openList = () => {
    if (!anchorRef.current) return;
    anchorRef.current.measureInWindow((x, y, w, h) => {
      setRect({ x, y, w, h });
      setQuery('');
      setOpen(true);
    });
  };

  const selected = useMemo(
    () => data.find(d => String(d.value) === String(value)),
    [data, value],
  );

  // Memoised so typing in the search box doesn't re-filter a long contact list
  // on every unrelated re-render.
  const filtered = useMemo(() => {
    if (!search || !query) return data;
    const q = query.toLowerCase();
    return data.filter(d => String(d.label).toLowerCase().includes(q));
  }, [data, search, query]);

  // Placement. Open BELOW the field whenever it fits; otherwise use whichever
  // side has more room.
  //
  // The height is clamped to the space ACTUALLY available on the chosen side —
  // there is deliberately no minimum height, because forcing one (the old
  // Math.max(120, …)) pushed the list off-screen on short screens and in
  // landscape, where a field can sit only ~60px from an edge.
  const spaceBelow = winH - (rect.y + rect.h) - GAP - EDGE;
  const spaceAbove = rect.y - GAP - EDGE;
  const showAbove = spaceBelow < Math.min(listMaxH, scale(160)) && spaceAbove > spaceBelow;
  const listH = Math.max(0, Math.min(listMaxH, showAbove ? spaceAbove : spaceBelow));

  // Horizontal: match the field, but never let the panel spill past an edge
  // (matters on narrow phones and in split-screen).
  const panelW = Math.min(rect.w, winW - EDGE * 2);
  const panelX = clamp(rect.x, EDGE, Math.max(EDGE, winW - panelW - EDGE));

  return (
    <>
      <View ref={anchorRef} collapsable={false} style={styles.dropdownAnchor}>
        <TouchableOpacity
          style={styles.dropdown}
          onPress={openList}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={placeholder}
        >
          <Text
            style={selected ? styles.dropdownSelected : styles.dropdownPlaceholder}
            numberOfLines={1}
          >
            {selected ? selected.label : placeholder}
          </Text>

          {/* Always the caret. The clear / de-select action now lives INSIDE
              the opened list (see the FlatList footer below), not on the field,
              so there is only ever one clear control. */}
          <View style={styles.caret} />
        </TouchableOpacity>
      </View>

      <Modal
        visible={open}
        transparent
        statusBarTranslucent
        // "none", not "fade": the fade added ~300ms before the list was even
        // visible, which read as lag on every open.
        animationType="none"
        hardwareAccelerated
        onRequestClose={() => setOpen(false)}
      >
        {/* The BACKDROP is the flex container (not an absolutely-positioned
            sibling). This guarantees it fills the modal and actually receives
            touches — the previous version relied on absoluteFill inside a
            container that had no height, so outside taps hit nothing and the
            list could never be dismissed.
            The panel is nested INSIDE it with its own onPress, which absorbs
            taps on the list so they don't bubble up and close it. */}
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            onPress={() => {}}
            style={[
              styles.listPanel,
              {
                left: panelX,
                width: panelW,
                height: listH,
                top: showAbove ? rect.y - listH - GAP : rect.y + rect.h + GAP,
              },
            ]}
          >
          {search && (
            <TextInput
              style={styles.searchBox}
              placeholder="Search…"
              placeholderTextColor="#9AA0AA"
              value={query}
              onChangeText={setQuery}
            />
          )}
          {/* FlatList, not ScrollView+map: the contact list is hundreds of
              rows and mapping them all built every row before the list could
              appear — the main cause of the slow open. FlatList renders only
              what fits and adds the rest as you scroll.
              getItemLayout skips measurement (rows are a fixed height), which
              removes another chunk of the open cost. */}
          <FlatList
            data={filtered}
            keyExtractor={item => String(item.value)}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            getItemLayout={(d, index) => ({
              length: optionH,
              offset: optionH * index,
              index,
            })}
            renderItem={({ item }) => {
              const isActive = String(item.value) === String(value);
              return (
                <TouchableOpacity
                  style={[
                    styles.option,
                    { height: optionH },   // must match getItemLayout exactly
                    isActive && styles.optionActive,
                  ]}
                  onPress={() => {
                    onChange(item);
                    setOpen(false);
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.optionText, isActive && styles.optionTextActive]}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={<Text style={styles.noResult}>No matches</Text>}
            ListFooterComponent={
              // De-select / Clear Selection — appears INSIDE the opened list, at
              // the bottom, ONLY once a value is already selected. Clearing
              // returns this dropdown to its placeholder state and closes it.
              clearable && selected ? (
                <TouchableOpacity
                  style={styles.clearOption}
                  onPress={() => {
                    onChange({ label: '', value: null });
                    setOpen(false);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Clear ${placeholder}`}
                >
                  <Text style={styles.clearOptionIcon}>✕</Text>
                  <Text style={styles.clearOptionText}>
                    De-select / Clear Selection
                  </Text>
                </TouchableOpacity>
              ) : null
            }
          />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

// Yes/No radio pair for the health declaration.
//
// A dropdown for a two-option answer costs three taps (open, scroll, pick);
// this is one. Both options are always visible, which also makes the current
// answer readable at a glance when reviewing the form.
const YesNoRadio = ({ value, onChange }) => (
  <View style={styles.radioRow}>
    {YES_NO.map((opt, i) => {
      const isActive = value === opt.value;
      const isLast = i === YES_NO.length - 1;
      return (
        <TouchableOpacity
          key={opt.value}
          style={[
            styles.radioOption,
            isLast && { marginRight: 0 },
            isActive && styles.radioOptionActive,
          ]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.8}
          accessibilityRole="radio"
          accessibilityState={{ selected: isActive }}
          accessibilityLabel={opt.label}
        >
          <View style={[styles.radioOuter, isActive && styles.radioOuterActive]}>
            {isActive && <View style={styles.radioInner} />}
          </View>
          <Text style={[styles.radioLabel, isActive && styles.radioLabelActive]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      );
    })}
  </View>
);

// Labelled text input.
//
// Defined at MODULE level on purpose. When this lived inside VisitorEntry it
// was a new component type on every render, so React unmounted and remounted
// the TextInput on each keystroke — which drops focus and closes the keyboard
// after every character typed.
// Field label with an optional red * for required fields. Shared by the text
// inputs and the dropdowns so the marker looks identical everywhere.
const Label = ({ children, required }) => (
  <Text style={styles.label}>
    {children}
    {required ? <Text style={styles.requiredMark}> *</Text> : null}
  </Text>
);

const Field = ({
  label,
  value,
  onChangeText,
  required,
  maxLength,
  showCounter,
  ...rest
}) => {
  const len = String(value || '').length;
  return (
    <>
      <Label required={required}>{label}</Label>
      <TextInput
        style={[styles.input, showCounter && styles.inputWithCounter]}
        placeholderTextColor="#9AA0AA"
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        {...rest}
      />
      {showCounter && maxLength ? (
        <Text style={[styles.counter, len >= maxLength && styles.counterAtMax]}>
          {len}/{maxLength}
        </Text>
      ) : null}
    </>
  );
};

// One photo slot — shows the captured image with a "Retake" strip, or an empty
// dashed tile with the camera icon + label prompting a capture.
const PhotoTile = ({ label, image, onPress, required }) => {
  // Square-ish tile derived from the window rather than a fixed 140px, so it
  // stays proportionate from small phones to tablets.
  const { shortEdge, clamp, scale } = useResponsive();
  const tileH = clamp(shortEdge * 0.36, 110, 210);

  return (
  <TouchableOpacity
    style={[styles.tile, { height: tileH }, !image && styles.tileEmptyBorder]}
    onPress={onPress}
    activeOpacity={0.85}
    accessibilityRole="button"
    accessibilityLabel={image ? `Retake ${label}` : `Capture ${label}`}
  >
    {image ? (
      <>
        <Image source={{ uri: image }} style={styles.tileImg} />
        <View style={styles.tileRetake}>
          <Text style={styles.tileRetakeText}>Retake</Text>
        </View>
      </>
    ) : (
      <View style={styles.tileEmpty}>
        <Image
          source={CAMERA_ICON}
          style={[styles.tileIcon, { width: scale(46), height: scale(46) }]}
          resizeMode="contain"
        />
        <Text style={styles.tileLabel}>
          {label}
          {required ? <Text style={styles.requiredMark}> *</Text> : null}
        </Text>
      </View>
    )}
  </TouchableOpacity>
  );
};

const VisitorEntry = () => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [ticketNo, setTicketNo] = useState('');

  const [contactPersons, setContactPersons] = useState([]);
  const [visitTypes, setVisitTypes] = useState([]);

  // Photos: base64 data URIs. `changed` flags tell submit whether to send a NEW
  // image (image_Base64*) or echo back the stored one (vc_image_*).
  const [idProofImage, setIdProofImage] = useState(null);
  const [generalPhoto, setGeneralPhoto] = useState(null);
  const [isIdChanged, setIsIdChanged] = useState(false);
  const [isFaceChanged, setIsFaceChanged] = useState(false);

  // Camera
  const [hasPermission, setHasPermission] = useState(false);
  const [cameraFor, setCameraFor] = useState(null); // 'id' | 'general' | null
  const [isFrontCamera, setIsFrontCamera] = useState(false);
  const device = useCameraDevice(isFrontCamera ? 'front' : 'back');
  const cameraRef = useRef(null);

  const [deviceId, setDeviceIdState] = useState('');

  const handleChange = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  // ---- Load lookups + identity on mount -----------------------------------
  useEffect(() => {
    let mounted = true;
    (async () => {
      // Camera permission (vision-camera v4 returns 'granted'; v3 'authorized').
      try {
        const status = await Camera.requestCameraPermission();
        if (mounted) setHasPermission(status === 'granted' || status === 'authorized');
      } catch (e) {}

      const id = await getDeviceId();
      if (mounted) setDeviceIdState(id || '');

      // The contact-person list depends on WHO is logged in, so resolve the
      // employee number before requesting it.
      const employeeId = ((await getItem(KEYS.userId)) || '').trim();

      fetchVisitTypes(mounted);
      fetchContactPersons(mounted, employeeId);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const fetchVisitTypes = async (mounted = true) => {
    try {
      // GET has no body, so token + device go as query params (never anything
      // secret beyond the session token, which is short-lived and device-bound).
      // This lets require_token.php guard the visit-type list too.
      const [tok0, deviceId, empId, userType] = await Promise.all([
        getItem(KEYS.apiToken),
        getDeviceId(),
        getItem(KEYS.userId),
        getItem(KEYS.userType),
      ]);
      const employeeId = (empId || '').trim();
      // user_type lets require_token.php check the RIGHT master (employee
      // nu_enable vs student training dates) rather than falling back to
      // "active in either" — same field every other request already sends.
      const buildUrl = t =>
        ENDPOINTS.visitorTypes +
        `?token=${encodeURIComponent(t || '')}` +
        `&device_id=${encodeURIComponent(deviceId || '')}` +
        `&employee_id=${encodeURIComponent(employeeId)}` +
        `&user_type=${encodeURIComponent(userType || '')}`;

      let { text, status } = await fetchTextWithTimeout(buildUrl(tok0), { method: 'GET' });
      // Same 401 self-heal as every other authenticated call: refresh once and
      // retry; if the refresh fails, report the session over (clean redirect)
      // rather than silently showing an empty dropdown.
      if (looksUnauthorized(status, text)) {
        const fresh = await refreshToken();
        if (fresh) {
          ({ text } = await fetchTextWithTimeout(buildUrl(fresh), { method: 'GET' }));
        } else {
          notifySessionExpired('refresh-failed');
        }
      }
      const data = JSON.parse(text);
      const formatted = (Array.isArray(data) ? data : []).map(item => ({
        label: item.visit_type,
        value: item.visit_type,
      }));
      if (mounted) setVisitTypes(formatted);
    } catch (e) {
      // Non-fatal: the dropdown stays empty; the user can retry by reopening.
    }
  };

  // Contact persons are resolved from the LOGGED-IN EMPLOYEE (the endpoint
  // maps them to that employee's plant), replacing the old hard-coded section.
  const fetchContactPersons = async (mounted = true, employeeId = '') => {
    if (!employeeId) return;
    try {
      const data = await postJson(ENDPOINTS.visitorContactPersons, {
        employee_id: employeeId,
      });
      const formatted = (Array.isArray(data) ? data : []).map(item => ({
        label: `${item.vc_first_name} ${item.vc_second_name} ${item.vc_last_name} (${item.vc_section_name})`,
        value: item.nu_person_no,
      }));
      if (mounted) setContactPersons(formatted);
    } catch (e) {}
  };

  // ---- Phone lookup: auto-fill the form from a previous visit --------------
  const handleLookup = async phoneNumber => {
    try {
      const result = await postJson(ENDPOINTS.visitorLookup, { Mobileno: phoneNumber });

      if (result && result.error) {
        // Not an error state for the user — just no prior record. Leave fields.
        return;
      }
      const data = result && result.data && result.data[0];
      if (!data) return;

      // Only the six identity fields are pre-filled. Everything else belongs
      // to THIS visit and must be entered fresh: the health declaration has to
      // be answered now (not inherited from a past visit), the photos are
      // taken now, and purpose / visit type / contact person are specific to
      // this arrival.
      setForm(prev => ({
        ...prev,
        firstName: data.vc_first_name || '',
        lastName: data.vc_last_name || '',
        companyName: data.vc_company_name || '',
        visitorAddress: data.vc_address_line1 || '',
        city: data.vc_city || '',
        vehicleNo: data.vc_vehicle_no || '',
      }));
    } catch (e) {
      // Lookup is a convenience; a failure shouldn't block manual entry.
    }
  };

  const onContactNoChange = text => {
    handleChange('contactNo', text);
    if (text.length === 10) {
      handleLookup(text);
    } else {
      // Typing a new number clears the previously looked-up visitor.
      setForm({ ...EMPTY_FORM, contactNo: text });
      setGeneralPhoto(null);
      setIdProofImage(null);
      setTicketNo('');
    }
  };

  // ---- Camera --------------------------------------------------------------
  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || !cameraFor) return;
    try {
      // 'quality' captures the best source frame the sensor can give; all the
      // size reduction then happens in the resize step below, where we control
      // it explicitly. Compressing at capture time as well would compress
      // twice and lose detail for nothing.
      const photo = await cameraRef.current.takePhoto({ qualityPrioritization: 'quality' });
      const originalPath = photo.path.replace('file://', '');

      const spec = PHOTO_SPECS[cameraFor] || PHOTO_SPECS.general;
      const resized = await ImageResizer.createResizedImage(
        originalPath,
        spec.maxW,
        spec.maxH,
        'JPEG',
        spec.quality,
        0,            // rotation — EXIF orientation is already applied
        undefined,    // outputPath — let the library pick a temp file
        false,        // keepMeta: strip EXIF (GPS/device tags) — smaller AND
                      // avoids shipping the visitor's location in the payload
        { mode: 'contain', onlyScaleDown: true },
      );

      const base64 = await RNFS.readFile(resized.uri, 'base64');
      const dataUri = `data:image/jpeg;base64,${base64}`;

      if (cameraFor === 'id') {
        setIdProofImage(dataUri);
        setIsIdChanged(true);
      } else {
        setGeneralPhoto(dataUri);
        setIsFaceChanged(true);
      }
      // Delete BOTH temp files. The camera writes a full-sensor JPEG (often
      // 3-6MB) and the resizer writes a second, smaller one; once the base64
      // is in memory neither is needed. Only the resized file was being
      // removed, so every capture leaked a multi-megabyte original into the
      // app's cache — invisible until a device fills up.
      try { await RNFS.unlink(resized.uri); } catch (e) {}
      try { await RNFS.unlink(originalPath); } catch (e) {}
      setCameraFor(null);
    } catch (e) {
      Alert.alert('Camera', 'Could not capture the photo. Please try again.');
    }
  }, [cameraFor]);

  // ---- Submit --------------------------------------------------------------
  const resetForm = () => {
    setForm(EMPTY_FORM);
    setGeneralPhoto(null);
    setIdProofImage(null);
    setTicketNo('');
    setIsIdChanged(false);
    setIsFaceChanged(false);
  };

  const handleSubmit = async () => {
    // Driven by REQUIRED_FIELDS, the same list that puts the * on the labels,
    // so a field can never be marked required without being enforced (or the
    // reverse). Reports the FIRST missing one, in form order, so the user is
    // pointed at the earliest thing to fix rather than a list of complaints.
    const missing = REQUIRED_FIELDS.find(([key]) => {
      const v = form[key];
      return v === null || v === undefined || String(v).trim() === '';
    });
    if (missing) {
      return Alert.alert('Required', `Please enter ${missing[1]}.`);
    }

    // The contact number is also the lookup key, so a partial number is worse
    // than none — it would create a record that can never be matched again.
    if (form.contactNo.trim().length !== 10) {
      return Alert.alert('Required', 'Contact Number must be 10 digits.');
    }

    // Both photos are mandatory. Checked after the fields so the user fills the
    // form first and is sent to the camera last, rather than being bounced to
    // the camera and back while still typing.
    if (!idProofImage) {
      return Alert.alert('Required', 'Please capture the ID Proof photo.');
    }
    if (!generalPhoto) {
      return Alert.alert('Required', 'Please capture the Visitor Photo.');
    }

    setLoading(true);
    try {
      const employeeId = ((await getItem(KEYS.userId)) || '').trim();

      // New capture -> image_Base64*; unchanged stored image -> vc_image_*.
      const image_Base64    = isFaceChanged ? generalPhoto?.split(',')[1] || '' : '';
      const vc_image_ticket = isFaceChanged ? '' : generalPhoto?.split(',')[1] || '';
      const image_Base64_id = isIdChanged ? idProofImage?.split(',')[1] || '' : '';
      const vc_image_id     = isIdChanged ? '' : idProofImage?.split(',')[1] || '';

      const payload = {
        vc_ticket_no: ticketNo || '',
        vc_first_name: form.firstName,
        vc_last_name: form.lastName,
        vc_company_name: form.companyName,
        vc_address_line1: form.visitorAddress,
        vc_city: form.city,
        vc_contact_no: form.contactNo,
        vc_id_proof: '',
        nu_person_no: form.contactPerson,
        nu_total_person: form.totalPerson,
        vc_purpose: form.purpose,
        vc_vehicle_no: form.vehicleNo,
        nu_visit_type: form.visitType,
        vc_material: form.material,
        vc_remark: form.remarks,
        vc_create_user: employeeId,
        vc_create_ip: deviceId,
        image_Base64,
        image_Base64_id,
        vc_image_ticket,
        vc_image_id,
        nu_diarrhoea_no: form.diarrhoea,
        nu_vomiting_no: form.vomiting,
        nu_skin_wounds_no: form.skinInfection,
        nu_contagious_no: form.otherIllness,
        nu_fever_no: form.fever,
      };

      // Photos make this a large POST — allow a longer bound than the 15s
      // default. Routed through postJson so it gets the same 401 self-heal
      // (refresh + retry, or clean session-expired redirect) as every other
      // authenticated call. postJson returns parsed JSON; re-stringify only for
      // the buffered-response parsing the existing code below expects.
      const parsed = await postJson(ENDPOINTS.visitorAdd, payload, 45000);
      const text = JSON.stringify(parsed);

      // insert_visitor_details.php buffers its output and emits exactly one
      // JSON object, so this is a plain parse. (The old endpoint echoed the
      // ticket number, the SQL, and the SMS gateway's reply around its JSON,
      // which is why this used to scan the body with a regex for the last
      // object containing a statusCode.)
      let resJson = null;
      try {
        resJson = JSON.parse(text);
      } catch (e) {
        throw new Error('bad-response');
      }
      if (!resJson || !resJson.statusCode) throw new Error('bad-response');

      if (String(resJson.statusCode) === '200') {
        resetForm();
        Alert.alert('Success', 'Visitor added successfully.');
      } else {
        // The server owns the field rules now, so its message IS the
        // validation feedback the user sees (e.g. "Last name is required.").
        // Shown verbatim rather than replaced with a generic error.
        Alert.alert('Required', resJson.message || 'Something went wrong.');
      }
    } catch (e) {
      // Session ended: navigator already showed "Signed Out" and is resetting
      // to Login — don't stack a second alert on top.
      if (!(e && e.sessionExpired)) {
        Alert.alert(MSG.NETWORK.title, MSG.NETWORK.message);
      }
    } finally {
      setLoading(false);
    }
  };

  // ---- Full-screen camera --------------------------------------------------
  if (cameraFor) {
    if (!device || !hasPermission) {
      return (
        <View style={styles.camFallback}>
          <Text style={styles.camFallbackText}>
            {hasPermission ? 'No camera available on this device.' : 'Camera permission is required.'}
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
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
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
          <TouchableOpacity onPress={() => setIsFrontCamera(p => !p)} style={styles.camSideBtn}>
            <Text style={styles.camSideText}>Flip</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <LinearGradient
        colors={['#FFEEEE', '#FFFFFF', '#FFFFFF']} // same soft Amul-red tint as Dashboard
        style={{ flex: 1 }}
      >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Tells the user what the red * means, once, before the first one. */}
        <Text style={styles.legend}>
          Fields marked <Text style={styles.requiredMark}>*</Text> are required
        </Text>

        {/* Visitor details */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>VISITOR DETAILS</Text>

          <Label required={isRequired('contactNo')}>Contact Number</Label>
          <TextInput
            style={styles.input}
            placeholder="Contact No."
            placeholderTextColor="#9AA0AA"
            keyboardType="numeric"
            maxLength={10}
            value={form.contactNo}
            onChangeText={onContactNoChange}
          />

          <Field label="First Name" placeholder="First Name"
            required={isRequired('firstName')}
            value={form.firstName} onChangeText={t => handleChange('firstName', t)} />
          <Field label="Last Name" placeholder="Last Name"
            required={isRequired('lastName')}
            value={form.lastName} onChangeText={t => handleChange('lastName', t)} />
          <Field label="Company Name" placeholder="Company Name"
            required={isRequired('companyName')}
            value={form.companyName} onChangeText={t => handleChange('companyName', t)} />
          <Field label="Visitor Address" placeholder="Visitor Address"
            required={isRequired('visitorAddress')}
            value={form.visitorAddress} onChangeText={t => handleChange('visitorAddress', t)} />
          <Field label="City" placeholder="City"
            required={isRequired('city')}
            value={form.city} onChangeText={t => handleChange('city', t)} />
          <Field label="Vehicle No." placeholder="Vehicle No."
            value={form.vehicleNo} onChangeText={t => handleChange('vehicleNo', t)} />
          <Field label="Total Person" placeholder="Total Person" keyboardType="numeric"
            required={isRequired('totalPerson')}
            value={form.totalPerson} onChangeText={t => handleChange('totalPerson', t)} />
        </View>

        {/* Visit */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>VISIT</Text>

          <Label required={isRequired('contactPerson')}>Contact Person</Label>
          <SelectField
            data={contactPersons}
            placeholder="Select Contact Person"
            search
            clearable={false}
            value={form.contactPerson}
            onChange={item => handleChange('contactPerson', item.value)}
          />

          <Label required={isRequired('visitType')}>Visit Type</Label>
          <SelectField
            data={visitTypes}
            placeholder="Select Visit Type"
            search
            clearable={false}
            value={form.visitType}
            onChange={item => handleChange('visitType', item.value)}
          />

          <Field label="Material" placeholder="Material"
            value={form.material} onChangeText={t => handleChange('material', t)} />
          <Field label="Purpose" placeholder="Purpose"
            value={form.purpose} onChangeText={t => handleChange('purpose', t)} />
          {/* sanitizeRemark strips line breaks and anything outside the safe
              whitelist as it's typed OR pasted; maxLength caps it at the
              keyboard, and the slice() in sanitizeRemark catches a paste that
              exceeds it. multiline is left off so Enter closes the keyboard
              instead of inserting a newline. */}
          <Field
            label="Remarks"
            placeholder="Remarks"
            value={form.remarks}
            onChangeText={t => handleChange('remarks', sanitizeRemark(t))}
            maxLength={REMARK_MAX}
            showCounter
            multiline={false}
            returnKeyType="done"
            blurOnSubmit
          />
        </View>

        {/* Health declaration */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>HEALTH DECLARATION</Text>
          {[
            ['Suffering from Diarrhoea?', 'diarrhoea'],
            ['Suffering from Vomiting?', 'vomiting'],
            ['Skin infections or open wounds?', 'skinInfection'],
            ['Other contagious illnesses?', 'otherIllness'],
            ['Do you have a fever?', 'fever'],
          ].map(([label, key]) => (
            <View key={key} style={styles.healthRow}>
              <Label required={isRequired(key)}>{label}</Label>
              <YesNoRadio
                value={form[key]}
                onChange={v => handleChange(key, v)}
              />
            </View>
          ))}
        </View>

        {/* Photos — ID proof + visitor photo together */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>PHOTOS</Text>
          <View style={styles.tileRow}>
            <PhotoTile label="ID Proof" required image={idProofImage} onPress={() => setCameraFor('id')} />
            <PhotoTile label="Visitor Photo" required image={generalPhoto} onPress={() => setCameraFor('general')} />
          </View>
        </View>

        <TouchableOpacity
          style={[styles.submit, loading && { opacity: 0.6 }]}
          onPress={handleSubmit}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitText}>Submit Details</Text>}
        </TouchableOpacity>
      </ScrollView>
      </LinearGradient>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  // Transparent so the LinearGradient behind shows through.
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: 16, paddingBottom: 40 },

  card: {
    backgroundColor: 'transparent',
    borderRadius: 16,
    padding: 18,
    // Stronger, tinted border so each transparent card is clearly separated
    // against the soft-red gradient (the old #F0F0F0 hairline was invisible
    // once the white fill was removed).
    borderWidth: 1.5,
    borderColor: '#F0B8BF',
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

  label: { fontWeight: '600', color: COLORS.darkText, marginBottom: 8, fontSize: 14 },
  requiredMark: { color: COLORS.primaryRed, fontWeight: '800' },
  // Counter sits tight under its input, replacing the input's own bottom gap.
  inputWithCounter: { marginBottom: 2 },
  counter: {
    alignSelf: 'flex-end',
    fontSize: 12,
    color: COLORS.muted,
    marginBottom: 12,
    marginRight: 2,
  },
  counterAtMax: { color: COLORS.primaryRed, fontWeight: '700' },
  legend: {
    color: COLORS.muted,
    fontSize: 12,
    marginBottom: 12,
    marginLeft: 2,
  },
  input: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    fontSize: 15,
    color: COLORS.darkText,
    marginBottom: 12,
    minHeight: 48,
    justifyContent: 'center',
  },
  // --- SelectField ---------------------------------------------------------
  dropdownAnchor: { marginBottom: 12 },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 50,
    backgroundColor: '#FFFFFF',
  },
  dropdownPlaceholder: { color: '#9AA0AA', fontSize: 15, flex: 1 },
  dropdownSelected: { color: COLORS.darkText, fontSize: 15, fontWeight: '600', flex: 1 },
  // "v" chevron drawn from a rotated square's bottom+right borders.
  caret: {
    width: 8,
    height: 8,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#9AA0AA',
    transform: [{ rotate: '45deg' }],
    marginLeft: 8,
    marginTop: -3,
  },

  clearBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.redTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  clearIcon: {
    color: COLORS.primaryRed,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 18,
  },

  // flex:1 (NOT absoluteFill) so it always fills the Modal and can be tapped.
  // --- Health declaration radios -------------------------------------------
  healthRow: { marginBottom: 14 },
  radioRow: { flexDirection: 'row' },
  radioOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    backgroundColor: '#FFFFFF',
    marginRight: 10,
  },
  radioOptionActive: {
    borderColor: COLORS.primaryRed,
    backgroundColor: COLORS.redTint,
  },
  radioOuter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#C3C8D0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  radioOuterActive: { borderColor: COLORS.primaryRed },
  radioInner: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: COLORS.primaryRed,
  },
  radioLabel: { fontSize: 15, color: COLORS.mediumText, fontWeight: '600' },
  radioLabelActive: { color: COLORS.primaryRed, fontWeight: '700' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.18)' },
  // Positioned absolutely from the measured anchor (see SelectField).
  listPanel: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 10,
  },
  searchBox: {
    margin: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    borderRadius: 10,
    fontSize: 15,
    color: COLORS.darkText,
  },
  // Height is applied INLINE from optionH (responsive) — getItemLayout depends
  // on every row being exactly that tall, so it must not be hard-coded here.
  option: { paddingHorizontal: 14, justifyContent: 'center' },
  optionActive: { backgroundColor: COLORS.redTint },
  optionText: { fontSize: 15, color: COLORS.darkText, fontWeight: '500' },
  optionTextActive: { color: COLORS.primaryRed, fontWeight: '700' },
  noResult: { padding: 16, textAlign: 'center', color: COLORS.muted, fontSize: 14 },

  // De-select / Clear Selection row, at the bottom of the opened list.
  clearOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: COLORS.inputBorder,
    backgroundColor: '#FFFFFF',
  },
  clearOptionIcon: {
    color: COLORS.primaryRed,
    fontSize: 15,
    fontWeight: '700',
    marginRight: 8,
  },
  clearOptionText: {
    color: COLORS.primaryRed,
    fontSize: 15,
    fontWeight: '600',
  },

  // Photo tiles (ID Proof + Visitor Photo, side by side in one card)
  tileRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tile: {
    // width stays proportional; height comes in inline from useResponsive.
    width: '48%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.inputBorder,
    backgroundColor: '#FAFAFB',
    overflow: 'hidden',
  },
  tileEmptyBorder: { borderStyle: 'dashed', borderColor: '#D8B4BA' },
  tileEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // width/height applied inline (responsive); only the tint lives here.
  tileIcon: { tintColor: COLORS.primaryRed },
  tileLabel: { marginTop: 10, color: COLORS.mediumText, fontWeight: '700', fontSize: 13 },
  tileImg: { width: '100%', height: '100%' },
  tileRetake: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 6,
    alignItems: 'center',
  },
  tileRetakeText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12, letterSpacing: 0.3 },

  submit: {
    backgroundColor: COLORS.primaryRed,
    borderRadius: 50,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  submitText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },

  // Camera
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
});

export default VisitorEntry;
