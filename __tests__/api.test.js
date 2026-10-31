import { looksUnauthorized } from '../src/services/api';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
}));
jest.mock('react-native-device-info', () => ({
  getUniqueId: jest.fn(() => Promise.resolve('test-device')),
  getVersion: jest.fn(() => '1.0.0'),
}));

// This predicate decides whether a failed request triggers a silent token
// refresh. Too eager and every business error causes a needless refresh; too
// narrow and users sit behind an expired token seeing confusing failures.
describe('looksUnauthorized', () => {
  it('treats 401 and 403 as unauthorised regardless of body', () => {
    expect(looksUnauthorized(401, '')).toBe(true);
    expect(looksUnauthorized(403, 'anything')).toBe(true);
  });

  it('matches the auth-failure phrases the backend emits', () => {
    const phrases = [
      'Unauthorized access',
      'invalid token',
      'Token is expired',
      'token invalid',
      'Your session has expired',
      'Not authorised',
      'not authorized',
      'expired or invalid',
      'Account disabled or invalid',
      'Please re-login',
      'please login again',
      'Please register again',
    ];
    phrases.forEach(p => {
      expect(looksUnauthorized(200, p)).toBe(true);
    });
  });

  it('does NOT treat ordinary business errors as auth failures', () => {
    // The regression this guards: "No Record Found" must not trigger a token
    // refresh — it is a perfectly normal empty-result response.
    const benign = [
      'No Record Found',
      'Attendance already marked',
      'Meeting not found',
      'You are too far from the location',
      'Err:250:22.5:72.9',
      '{"statusCode":200,"message":"Updated"}',
      '000',
    ];
    benign.forEach(t => {
      expect(looksUnauthorized(200, t)).toBe(false);
    });
  });

  it('handles an empty or missing body', () => {
    expect(looksUnauthorized(200, '')).toBe(false);
    expect(looksUnauthorized(200, null)).toBe(false);
    expect(looksUnauthorized(200, undefined)).toBe(false);
  });
});
