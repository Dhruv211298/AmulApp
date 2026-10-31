// ---------------------------------------------------------------------------
// Every server address the app talks to, in one place.
//
// These used to be six literals spread across five files, which meant pointing
// the app at a test server required editing source in five places and hoping
// none were missed. Change API_HOST here and the whole app follows.
//
// Everything is https:// — there is no cleartext endpoint, which is why the
// Android network-security-config and the iOS ATS exception were both removed.
// If you ever add an http:// address here, those exceptions have to come back,
// so don't.
// ---------------------------------------------------------------------------

export const API_HOST = 'https://digi.amuldairy.com';

// Folder holding the mobile API endpoints.
// API folder. Renamed from /ios_api to /app_api in 1.0.3 — the old name dated
// from when this was an iOS-only app and was misleading now that Android uses
// the same endpoints.
//
// BOTH FOLDERS RUN IN PARALLEL during the transition. Every already-installed
// build (1.0.2 and earlier) has "/ios_api" compiled into it and cannot be
// changed remotely, so /ios_api must stay live on the server — including its
// app_version_check.php, which is the ONLY thing that can tell those older
// builds to update. Remove /ios_api only once nobody is on a pre-1.0.3 build.
//
// While both exist they are copies of the same code, so any backend fix must
// be deployed to BOTH folders until /ios_api is retired.
export const BASE_URL = `${API_HOST}/app_api`;

// Named endpoints. Relative names are resolved against BASE_URL by apiPost();
// full URLs are given where the caller passes them straight through.
export const ENDPOINTS = {
  // Auth
  register: `${BASE_URL}/app_user_registration.php`,
  tokenCheck: `${BASE_URL}/app_token_checker.php`,
  versionCheck: `${BASE_URL}/app_version_check.php`,

  // Navigation
  // Resolved against BASE_URL, so this is /app_api/app_menu.php — the
  // rights-aware AND category-aware menu. Returns the flat `menu` plus a
  // `menu_tree` that groups the same items under the category headings managed
  // on the portal's Menu Setup page.
  //
  // NOT the same file as /ios_api/app_menu.php, which is the original
  // pre-rights menu still serving very old installed builds. Same name, two
  // folders, two different files — never copy one over the other.
  //
  // Older endpoints stay live until nobody is on a build that calls them:
  //   /ios_api/app_menu.php      pre-rights builds
  //   /ios_api/app_menu_new.php  1.0.2 builds
  menu: 'app_menu.php',

  // Meeting attendance
  employeeName: 'get_emp_name.php',
  meetingAttendance: `${BASE_URL}/meeting_attendance.php`,
  meetingPresentList: `${BASE_URL}/meeting_present_list.php`,

  // QR / location attendance
  locationFromQr: `${BASE_URL}/get_location_name_qr.php`,
  locationAttendance: `${BASE_URL}/location_attendance.php`,
  locationAttendanceReport: `${BASE_URL}/location_attendance_report.php`,

  // QR code visit + its report. qr_code_visit.php serves BOTH jobs, chosen by
  // the `mode` field the app sends: mode=lookup resolves the scanned code to a
  // location NAME (no record written), mode=submit (or absent) records the
  // visit. One endpoint, so older app builds are unaffected.
  qrVisit: `${BASE_URL}/qr_code_visit.php`,
  qrVisitReport: `${BASE_URL}/qr_code_visit_report.php`,

  // DIL Entry — a single endpoint, action chosen by the `rtype` field:
  //   rtype 1  check/load existing entry -> {data:{status,...,products[]}|null}
  //   rtype 2  get products (K: digi DB else K-RFC; G: G-RFC) -> {data:[...]}
  //   rtype 3  save/submit (header + products + batches) -> {entry_id}
  dilApi: `${BASE_URL}/dil_entry.php`,

  // DIL Entry — active plant list for the standalone plant dropdown at the top
  // of the screen. Not tied to Get DIL Details. Returns {data:[{plant_code,
  // plant_name}]}. Resolved against BASE_URL by apiPost().
  dilPlantList: 'get_dil_plant_list.php',

  // DIL Entry — today's vehicles for the Vehicle Number type-ahead. Takes
  // {plant_code} (the top dropdown's selected plant) and returns {data:[{
  // vehicle_no, driver_nm, dil_no}]} for vehicles that reported today at that
  // plant. Selecting a suggestion fills the vehicle number + driver name.
  dilVehicleList: 'get_dil_vehicle_list.php',

  // DIL Entry — today's SAVED DRAFT DIL numbers (amul_app_dil_entry_mst,
  // nu_status = 1, created today), for the DIL Number type-ahead so a user can
  // resume a draft without re-typing the number. Returns {data:[{dil_no,
  // dil_date, driver_nm, vehicle_no}]}. Resolved against BASE_URL by apiPost().
  dilNumberList: 'get_dil_number_list.php',

  // DIL Entry — active dispatch docks for the "Dock Selection" dropdown (shown
  // after the LR Number field). Takes {plant_code} (the top dropdown's selected
  // plant) and returns {data:[{dock_no, dock_name}]}. Resolved against BASE_URL.
  dilDockList: 'get_dil_dock_list.php',

  // DIL Entry — dispatch record (prod_dtl_data form 1170) + the 3 photos.
  // Called on Save/Submit when a dock is selected and at least one photo is
  // taken. Inserts first time / updates after, and stores nu_data_no back on
  // the DIL master. Heavy (base64 images) — call with a longer timeout.
  dilDispatchSave: 'dil_dispatch_save.php',

  // DIL Entry — serve ONE saved dispatch photo (form 1170) as a base64 data
  // URI, for the "View" button on a re-opened DIL's Loading Photos tiles.
  // Takes {dil_no, slot} where slot is vehicle | before | after.
  dilDispatchImage: 'dil_dispatch_image.php',

  // VCU Auto Sampler — scanned tanker QR -> vehicle number. Its own secure
  // endpoint (token-guarded, parameterized), called right after a scan.
  // POST {qrcode_id} -> {statusCode, message, vehicle_no}.
  vcuQrLookup: 'qr_get_vcu_tanker_dtl.php',

  // VCU Auto Sampler — the capture endpoint, action chosen by the `rtype` field:
  //   rtype fetch_open   open Stage-1 (OUT) row for a tanker -> {found,id,route_no,pump_health,ini_status}
  //   rtype stage1_save  insert Tanker-OUT record (nu_status 1)
  //   rtype stage2_save  update to Tanker-IN + sample photo (nu_status 2)
  // Resolved against BASE_URL by apiPost() -> /app_api/vcu_sampler.php.
  vcuSampler: 'vcu_sampler.php',

  // VCU Empty-Tanker Tracking — Tanker OUT (dispatch). action chosen by `rtype`:
  //   rtype init   -> {source_plant:{code,name}, dest_plants:[{code,name}]}
  //   rtype fetch  -> {ticket_no, tare_weight} (or {allocated:1})
  //   rtype save   -> insert dispatch row + flag tanker unavailable
  // Resolved against BASE_URL by apiPost() -> /app_api/vcu_tanker_tracking.php.
  vcuTankerTrack: 'vcu_tanker_tracking.php',

  // Employee In / Out — going-out gate-pass movement. action chosen by `rtype`:
  //   rtype scan   -> decode QR, validate -> {going_out_no, emp_name, req_date,
  //                   action_code (1..4), action_label}
  //   rtype punch  -> record the server-derived action (+ best-effort GPS) ->
  //                   {statusCode, message, action_code, completed}
  // The SERVER decides which movement to record from the pass status — the app
  // never sends the action. Resolved against BASE_URL by apiPost().
  employeeInOut: 'employee_in_out.php',

  // Store Material Stock (SAP) — native replacement for the old hybrid page.
  // action chosen by the `rtype` field:
  //   rtype 1  resolve a scanned QR -> {is_cvcc, plant, material, section}
  //   rtype 2  live stock for (plant, matno, sapsection, userid) ->
  //            {rows:[...], totals:{stock_u,stock_q,stock_b,total}}
  // Resolved against BASE_URL by apiPost() -> /app_api/store_material_stock.php.
  storeMaterialStock: 'store_material_stock.php',

  // CVCC Medicine Stock — native replacement for the CVCC branch of the old
  // hybrid page. rtype 1 -> current medicine stock for a doctor (matno) ->
  // {rows:[{medicine_code,medicine_name,close_qty,close_unit,center}], from_date, to_date}.
  // Resolved against BASE_URL by apiPost() -> /app_api/cvcc_medicine_stock.php.
  cvccMedicineStock: 'cvcc_medicine_stock.php',

  // Material Ack — native replacement for the old WebView store page
  // (store/material_ack.php). ONE endpoint, action chosen by the `rtype` field:
  //   rtype inwards -> pending store inwards (last 2 days, open lines) ->
  //                    {rows:[{inward_id, inward_no}]}
  //   rtype lines   -> pending content lines for an inward ->
  //                    {rows:[{line_id, material_code, material_desc, unit, qty,
  //                            pack_dtl, remarks, supplier_name}]}
  //   rtype save    -> acknowledge ONE line (verified qty + receiver details)
  // The acknowledging employee is taken from the token, not the client.
  // Resolved against BASE_URL by apiPost() -> /app_api/material_ack.php.
  materialAck: 'material_ack.php',

  // Visitor Entry. These live under /api_s (NOT /app_api), so they are given as
  // full URLs. They take/return JSON (not the app's usual FormData), so the
  // screen posts JSON through the bounded fetch helpers rather than apiPost.
  // Deployed to /app_api (not /api_s like the other three visitor endpoints).
  visitorTypes:          `${BASE_URL}/get_visit_type.php`,                // GET  -> [{visit_type}]
  visitorLookup:         `${BASE_URL}/fetch_previous_visit.php`,          // POST {Mobileno} -> {data:[...]}
  visitorContactPersons: `${BASE_URL}/get_contact_person.php`,           // POST {employee_id} -> [{...}]
  visitorAdd:            `${BASE_URL}/insert_visitor_details.php`,        // POST payload -> {statusCode,message}

  // Push notifications. Called on every app start after login — the endpoint
  // UPDATEs the device row rather than inserting, so a reinstall replaces the
  // dead token instead of leaving a stale one behind.
  saveFcmToken: `${BASE_URL}/save_fcm_token.php`,                         // POST {employee_id,fcm_token,platform} -> {statusCode,message}
};

// In-app portals. These are NOT under /app_api — they are the full web portals,
// opened in a WebView and authenticated via login_app.php.
export const PORTALS = {
  AmulIntranet: {
    title: 'Amul Intranet',
    baseUrl: 'https://intranet.amuldairy.com/login_app.php',
  },
  AmulDigi: {
    title: 'Amul Digi',
    baseUrl: `${API_HOST}/login_app.php`,
  },
  // Amul Dashboard — standard login_app.php scheme, same as Amul Intranet.
  //
  // viewport: main.php builds its layout from <table width=100%>, which at
  // phone width COMPRESSES the cells instead of overflowing — so the page
  // reports that it "fits" while the columns are visibly clipped. That makes
  // it undetectable by measurement, so the desktop width is declared here.
  // 980 is the width mobile Safari assumes for pages with no viewport meta,
  // which is exactly the rendering we're matching.
  AmulDashboard: {
    title: 'Amul Dashboard',
    baseUrl: 'https://dashboard.amuldairy.com/login_app.php',
    viewport: { width: 980 },
  },
  // Amul Dashboard (Section Wise) — its OWN token-login endpoint, and a
  // responsive page, so NO `viewport` key (leave the layout to the page).
  // Standard param scheme (employee_key / employee_id / device_id).
  //
  AmulDashboardSection: {
    title: 'Amul Dashboard (New)',
    baseUrl: 'https://dashboard_new.amuldairy.com/login_app.php',
  },
  // Milk Indent portal. Its login.php reads `android_id` + `token_id` rather
  // than the standard `device_id` + `employee_key`, so we map to those names.
  // employeeId is not sent (login.php doesn't read it).
  //
  // token_id = the FIREBASE token, not the session token.
  //   login.php stores whatever arrives in token_id into
  //   milkindent_mst_user.mobile_token, and milkindent.php later hands that
  //   value to Firebase as the delivery address. It was previously fed this
  //   app's SESSION key — a value Firebase can never deliver to. The mistake
  //   was invisible because the portal's send code only tests for connection
  //   errors, so a rejected message still looks like success.
  //
  // api_token_id = the session token, kept separate.
  //   Not yet read by login.php. It is sent so the portal CAN start
  //   authenticating properly against soc_dtl_api_key — today it trusts
  //   android_id alone, and milkindent.php accepts ?uid=<base64> as identity,
  //   which lets anyone impersonate any employee.
  MilkIndent: {
    title: 'Milk Indent',
    baseUrl: `${API_HOST}/milkindent/login.php`,
    paramNames: {
      deviceId: 'android_id',
      fcmToken: 'token_id',
      token: 'api_token_id',
      employeeId: null,
    },
    // First-time login form: auto-fill the Emp. No field (id="txtUserName")
    // with the logged-in employee number so the user doesn't type it.
    prefillEmployeeField: 'txtUserName',
  },
  // DCS Hygiene Audit portal — its own subdomain (still under amuldairy.com,
  // so it passes PortalWebView's *.amuldairy.com host whitelist).
  //
  // No `viewport` key on purpose: this site ships its own responsive layout
  // and its own viewport meta. Any interference from us made it render tiny.
  //
  // Points at login_app.php (token login) so the app skips the manual
  // user/password form. Standard param scheme (employee_key / employee_id /
  // device_id), same as Intranet / Digi / Dashboard. login_app.php validates
  // the token in SQL Server, loads the DCS user from MySQL, then redirects to
  // audit_entry.php.
  DcsHygiene: {
    title: 'DCS Hygiene Audit',
    baseUrl: 'https://dcsauditm.amuldairy.com/login_app.php',
  },
};
