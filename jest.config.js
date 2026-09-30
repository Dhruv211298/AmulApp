module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // react-native ships untranspiled ES modules, as do several of the community
  // packages, so they must not be ignored by the transform.
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|@react-navigation|react-native-.*)/)',
  ],
};
