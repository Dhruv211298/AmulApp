import UIKit
import React
import React_RCTAppDelegate

// UIScene lifecycle adoption — REQUIRED on iOS 26+/iOS 27. Without it the app is
// terminated at launch with a "NoSceneLifecycleAdoption" runtime issue
// (EXC_BREAKPOINT). This creates the window from the connecting scene and mounts
// React Native into it, using the factory the AppDelegate created.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = (scene as? UIWindowScene) else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window

    guard
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    // Mounts the RN root view controller into this window and makes it visible.
    factory.startReactNative(
      withModuleName: "AmulApp",
      in: window,
      launchOptions: nil
    )
  }
}
