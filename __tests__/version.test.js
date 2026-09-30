import { compareVersions } from '../src/services/version';

// compareVersions decides whether a user is force-updated out of the app, so a
// bug here either locks everyone out or lets an unsupported build keep running.
describe('compareVersions', () => {
  it('treats equal versions as equal', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('compares numerically, not lexicographically', () => {
    // The whole reason this function exists: '1.10.0' > '1.9.0' is FALSE as a
    // string comparison, which would wrongly force-update every user on 1.10.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('handles differing segment counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
    expect(compareVersions('2', '1.9.9')).toBe(1);
  });

  it('treats missing or malformed input as 0', () => {
    expect(compareVersions(undefined, '0.0.0')).toBe(0);
    expect(compareVersions('', '0')).toBe(0);
    expect(compareVersions('abc', '0.0.0')).toBe(0);
  });

  it('orders real release sequences correctly', () => {
    const sorted = ['1.0.0', '1.0.10', '1.0.2', '1.2.0'].sort(compareVersions);
    expect(sorted).toEqual(['1.0.0', '1.0.2', '1.0.10', '1.2.0']);
  });
});
