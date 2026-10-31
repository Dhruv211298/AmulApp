import {
  parseQrLocationResponse,
  QR_RESULT,
} from '../src/services/qrResponse';

// This parser decides whether someone may mark attendance at a site.
describe('parseQrLocationResponse', () => {
  it('reports not-found for "000" and for an empty body', () => {
    expect(parseQrLocationResponse('000', '123').status).toBe(
      QR_RESULT.NOT_FOUND,
    );
    expect(parseQrLocationResponse('', '123').status).toBe(QR_RESULT.NOT_FOUND);
    expect(parseQrLocationResponse('   ', '123').status).toBe(
      QR_RESULT.NOT_FOUND,
    );
    expect(parseQrLocationResponse(null, '123').status).toBe(
      QR_RESULT.NOT_FOUND,
    );
  });

  it('parses an out-of-range response into its parts', () => {
    const r = parseQrLocationResponse('Err:250:22.5645:72.9289', '123');
    expect(r.status).toBe(QR_RESULT.TOO_FAR);
    expect(r.distance).toBe('250');
    expect(r.lat).toBe('22.5645');
    expect(r.lon).toBe('72.9289');
  });

  it('strips the trailing QR code from the location name', () => {
    const r = parseQrLocationResponse('Anand Plant-123', '123');
    expect(r.status).toBe(QR_RESULT.FOUND);
    expect(r.name).toBe('Anand Plant');
  });

  it('accepts a bare name when the location has no stored coordinates', () => {
    const r = parseQrLocationResponse('Anand Plant', '123');
    expect(r.status).toBe(QR_RESULT.FOUND);
    expect(r.name).toBe('Anand Plant');
  });

  it('keeps hyphens that are part of the location name', () => {
    // Only the exact trailing "-<qr>" is removed.
    expect(parseQrLocationResponse('Anand-Plant-123', '123').name).toBe(
      'Anand-Plant',
    );
    expect(parseQrLocationResponse('Anand-Plant', '999').name).toBe(
      'Anand-Plant',
    );
  });

  it('does not strip a code that only appears mid-name', () => {
    expect(parseQrLocationResponse('Plant-123-North', '123').name).toBe(
      'Plant-123-North',
    );
  });
});
