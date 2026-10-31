import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  // Kept ONLY for Firebase/GoogleUtilities' app-delegate swizzler, which calls
  // `-[AppDelegate window]`. It is unused under the UIScene lifecycle (the real
  // window lives in SceneDelegate), but it MUST exist or the swizzler crashes at
  // launch with "unrecognized selector sent to instance ... window".
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Initialise Firebase BEFORE React Native starts. @react-native-firebase v22+
    // requires this call by hand — without it the app crashes on launch
    // ("No Firebase App '[DEFAULT]' has been created") and push messaging never
    // works. It reads GoogleService-Info.plist from the app bundle, so that file
    // must be a member of the AmulApp target.
    FirebaseApp.configure()

    // Build the RN factory once. The SceneDelegate uses it to mount RN into the
    // scene's window (see SceneDelegate.swift).
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
