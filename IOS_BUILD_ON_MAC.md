# Building AmulApp for iOS on a Mac

This project is a React Native app (bundle id **com.amulapp**, version **1.0.3**, build **11**).
The Android and backend (`app_api`, `ios_api`, `digi forms`) folders are **not** needed to
build the iOS app — only the React Native app + `ios/` folder are used by Xcode.

---

## 1. Transfer the code to the Mac

**Do NOT copy** these.

Regenerated on the Mac (OS-specific):
`node_modules/`, `ios/Pods/`, `ios/build/`, `android/build/`, `android/.gradle/`

Server-side backend — **not part of the iOS app build**, keep them off the Mac
(they live on the server, and they contain sensitive DB/RFC/tomsys credentials):
`app_api/`, `ios_api/`, `digi forms/`

### Option A — Git (recommended, cleanest)
On Windows (from the project folder):
```
git add .
git commit -m "Transfer for iOS build"
git push        # to GitHub / GitLab / Bitbucket
```
On the Mac:
```
git clone <your-repo-url> AmulApp
cd AmulApp
```
The existing `.gitignore` already excludes node_modules / Pods, so the clone stays clean.

### Option B — Zip (no Git)
Zip the project **excluding** the folders listed above, transfer it (AirDrop / USB / cloud),
and unzip on the Mac.

---

## 2. Prerequisites on the Mac (one-time)

- **Xcode** (from the App Store) + open it once to install components, then:
  `xcode-select --install` (Command Line Tools)
- **Node.js** — same major version you use on Windows (`node -v`)
- **Watchman**: `brew install watchman`
- **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`)
- (Optional) **Yarn**: `npm i -g yarn`

---

## 3. Install dependencies

From the project folder on the Mac:
```
npm install            # or: yarn
cd ios
pod install            # first run may take a while
cd ..
```

---

## 4. Firebase config (IMPORTANT)

The app uses `@react-native-firebase`. Android uses `google-services.json`; **iOS needs
`GoogleService-Info.plist`**, which is not in the repo.

1. In the Firebase console, open the project → add / select the **iOS app** with bundle id
   `com.amulapp`.
2. Download **GoogleService-Info.plist**.
3. In Xcode, drag it into the **AmulApp** target folder (`ios/AmulApp/`), ticking
   "Copy items if needed" and the **AmulApp** target.

Without this file the app builds but Firebase features fail at runtime (or the build fails,
depending on setup).

---

## 5. Open in Xcode and sign

Open the **workspace**, not the project:
```
open ios/AmulApp.xcworkspace
```
In Xcode:
1. Select the **AmulApp** target → **Signing & Capabilities**.
2. Choose your **Apple Developer Team**. Bundle id stays `com.amulapp`.
3. Let Xcode manage the provisioning profile (or select your own).

---

## 6. Run / build

- **Simulator / device test**: pick a target at the top and press ▶ (Run), or from terminal:
  `npx react-native run-ios`
- **Release archive (App Store / TestFlight)**:
  Xcode → set the scheme to **Release** → **Product > Archive** → in the Organizer,
  **Distribute App** → App Store Connect.

---

## Notes
- Version/build are in `ios/AmulApp.xcodeproj/project.pbxproj`
  (`MARKETING_VERSION = 1.0.3`, `CURRENT_PROJECT_VERSION = 11`). Keep these in sync with Android
  and bump `CURRENT_PROJECT_VERSION` for each new TestFlight/App Store upload.
- The API base URL the app talks to lives in `src/config.js` — no change needed for iOS.
- If pods fail after a dependency change: `cd ios && pod repo update && pod install`.
- If Metro caching causes odd errors: `npx react-native start --reset-cache`.
