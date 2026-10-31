// ---------------------------------------------------------------------------
// Parser for get_location_name_qr.php, which replies in PLAIN TEXT:
//
//   "<Name>-<qrcode>"            -> in range, valid
//   "<Name>"                     -> location has no stored coords (name only)
//   "Err:<distance>:<lat>:<lon>" -> user is outside the allowed radius
//   "000"                        -> the QR matched no location
//   ""                           -> treated the same as "000"
//
// Extracted from QrAttendanceScreen so it can be unit tested. This is the code
// that decides whether someone is allowed to mark attendance, and an ad-hoc
// string split buried in a component is the wrong place for that logic to live
// untested.
// ---------------------------------------------------------------------------

export const QR_RESULT = {
  NOT_FOUND: 'notfound',
  TOO_FAR: 'toofar',
  FOUND: 'found',
};

export function parseQrLocationResponse(raw, qr) {
  const text = (raw || '').trim();

  if (!text || text === '000') {
    return { status: QR_RESULT.NOT_FOUND };
  }

  if (text.startsWith('Err:')) {
    const parts = text.split(':');
    return {
      status: QR_RESULT.TOO_FAR,
      distance: parts[1] || '',
      lat: parts[2] || '',
      lon: parts[3] || '',
    };
  }

  // Strip the "-<qrcode>" suffix when present. Only the exact trailing code is
  // removed, so a location whose NAME legitimately contains a hyphen (or even
  // the code as a substring) is left intact.
  const suffix = `-${qr}`;
  const name = text.endsWith(suffix)
    ? text.slice(0, text.length - suffix.length)
    : text;

  return { status: QR_RESULT.FOUND, name: name.trim() };
}
