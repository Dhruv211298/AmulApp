const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // Don't let Metro crawl native BUILD OUTPUT folders (e.g. vision-camera's
    // Android codegen dirs under android/build/generated/...). They only exist
    // during a native Gradle/Xcode build, so Metro's watcher otherwise spams
    // harmless "ENOENT ... skipping" warnings for them. Matches both "/" and
    // "\" path separators so it works on macOS and Windows.
    blockList: /.*[\\/](android|ios)[\\/]build[\\/].*/,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
