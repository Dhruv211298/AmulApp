package com.amulapp

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "AmulApp"

  /**
   * Passing `null` here (instead of `savedInstanceState`) stops Android from restoring the saved
   * fragment hierarchy when the Activity is re-created — e.g. after a background kill + relaunch,
   * with "Don't keep activities" enabled, or on a configuration change. react-native-screens can
   * NOT be restored from fragment state; it throws
   * "IllegalStateException: Screen fragments should never be restored", which crashes the app on
   * launch. Rebuilding the React UI from scratch avoids that. This is the fix recommended by
   * react-native-screens.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
