# Firebase Push Notifications — Implementation Plan
### Amul Common App — Admin Announcements

**Written for:** someone who has never worked with push notifications before.
**Date:** September 2026
**Scope:** admin sends an announcement → it appears on staff phones, even when the app is closed.

---

## PART 1 — UNDERSTANDING THE SYSTEM

### 1.1 What is actually happening

Think of push notification as **courier delivery**.

| Real world | Push notification |
|---|---|
| Your house address | The **FCM token** — a unique address for one app on one phone |
| The courier company | **Firebase Cloud Messaging (FCM)** — run by Google |
| You writing a letter | Your **PHP server** deciding to send a message |
| The postman ringing the bell | The **phone's operating system** showing the notification |

The key point: **your PHP server cannot reach a phone directly.** A phone in someone's pocket has no fixed internet address, is often on mobile data behind a carrier, and may be asleep. Only Google (for Android) and Apple (for iOS) maintain a permanent connection to every phone. Firebase is the service that lets you use those connections.

So the flow is always:

```
Your PHP  →  Firebase  →  Google/Apple network  →  The phone  →  Notification appears
```

### 1.2 The single most important concept: the token

When the app starts, it asks Firebase: *"give me my delivery address."* Firebase returns a long random string — the **token**:

```
fH9kL2mNpQ:APA91bF7xY3vB8nR2wK...
```

Four things you must know about it:

1. **It belongs to the app installation, not the person.** One employee with two phones has two tokens. Two employees sharing a phone have one token.
2. **It changes.** Reinstall the app, clear app data, restore from backup, or occasionally for no visible reason — a new token is issued and the old one is dead.
3. **Your server must store it**, because your server is what decides who gets a message.
4. **Your app must send the current token on every launch**, not just at first registration.

> ### Why point 4 matters — the Milk Indent lesson
>
> In `milkindent/login.php`, line 105 saves the token with an `INSERT` at first registration. The line that would refresh it, line 53, is **commented out**.
>
> The result over four years: every reinstall created another row with a new token, but the send code (`milkindent.php:178`) reads only the *first* row it finds — often a dead token from an old install. Notifications silently stopped for those users.
>
> **We will not repeat this.** Our design uses an UPDATE on every app launch.

### 1.3 Two ways to address a message

This matters for announcements specifically.

**Option A — send to each token individually.** You look up 500 employees' tokens and send 500 messages. Full personalisation ("Dear Mr. Patel..."), but slow and you must manage every token.

**Option B — send to a "topic".** Every phone *subscribes* to a named channel, for example `all_staff`. Your server sends **one** message to that topic and Firebase delivers it to every subscriber. No token list needed for that message at all.

**For admin announcements, Option B is correct.** An announcement is the same text for everyone, so there is nothing to personalise. One HTTP request instead of five hundred.

Suggested topics for this app:

| Topic | Who subscribes |
|---|---|
| `all_staff` | every logged-in user |
| `employees` | users with `user_type = 'e'` |
| `students` | users with `user_type = 's'` |
| `dept_<code>` | optional, per department, later |

**We still store tokens** (Option A), because later features — "a visitor is waiting for *you*", "your attendance was recorded" — need to reach one specific person. Topics for announcements, tokens for personal messages.

### 1.4 What the user sees, in three situations

| App state | What happens | Who draws it |
|---|---|---|
| Closed / background | Notification appears in the tray automatically | The phone's OS |
| Open on screen | **Nothing happens unless we write code for it** | Our app |
| User taps it | App opens — we choose which screen | Our app |

That middle row surprises people. Firebase does not draw anything while your app is in the foreground; you receive the data and must display it yourself.

### 1.5 Why the Milk Indent sending code cannot be copied

`milkindent.php` line 169 sends to:

```
https://fcm.googleapis.com/fcm/send        ← the LEGACY API
Authorization: key=AAAAoOdIRag...          ← a static "server key"
```

**Google shut this down on 22 July 2024.** It no longer works, for anyone.

Worse, the failure is invisible. Line 218 checks:

```php
$result = curl_exec($ch);
if ($result === FALSE) { die('FCM Send Error: ...'); }
```

`curl_exec()` returns `FALSE` only when the connection itself fails. An HTTP 404 from Google comes back as a normal response string, so this check passes and the code continues happily. The SMS and WhatsApp messages still go out, so from the outside everything looks fine.

The replacement is the **HTTP v1 API**, which uses a *service account* and short-lived OAuth tokens instead of a static key. Part 3 covers it.

---

## PART 2 — SETUP (accounts and keys)

These steps need company accounts, so they are yours to do. Nothing here touches code.

### Step 2.1 — Create the Firebase project

1. Go to **console.firebase.google.com**, sign in with a company Google account (not a personal one — this becomes company infrastructure).
2. **Add project** → name it `Amul Common App` → Continue.
3. Google Analytics: **not required**. Turn it off to keep things simple.

### Step 2.2 — Register the Android app

1. In the project, click the **Android** icon.
2. **Android package name:** `com.amulapp` — must match exactly, or nothing will work.
3. App nickname: `Amul Common App Android`.
4. SHA-1: **skip it** — only needed for Google Sign-In, which we are not using.
5. **Download `google-services.json`.**

### Step 2.3 — Register the iOS app

1. Click **Add app** → **iOS**.
2. **Bundle ID:** must exactly match the value in Xcode (`PRODUCT_BUNDLE_IDENTIFIER`).
3. **Download `GoogleService-Info.plist`.**

### Step 2.4 — The Apple APNs key *(iOS only — do not skip)*

Apple runs its own delivery network (APNs). Firebase needs written permission to hand your messages to Apple.

1. Sign in to **developer.apple.com** → Certificates, Identifiers & Profiles → **Keys**.
2. **+** to create a key → name it `Firebase APNs` → tick **Apple Push Notifications service (APNs)** → Continue → Register.
3. **Download the `.p8` file.** ⚠️ **Apple lets you download it exactly once.** Save it somewhere safe and backed up.
4. Note the **Key ID** (shown on that page) and your **Team ID** (top right of the developer portal).
5. Back in Firebase: **Project Settings → Cloud Messaging → Apple app configuration → APNs Authentication Key → Upload.** Provide the `.p8`, the Key ID and the Team ID.

**Without this step, iOS notifications will not work at all** — and there will be no error message telling you why. The messages will simply never arrive.

### Step 2.5 — The service account key (for PHP)

This is how your server proves to Firebase that it is really you.

1. **Project Settings → Service Accounts → Generate new private key** → a `.json` file downloads.
2. Note your **Project ID** (Project Settings → General), e.g. `amul-common-app`.

> ### 🔒 Protect this file
>
> This JSON is a full credential — anyone holding it can send notifications as Amul Dairy to every user of the app.
>
> - Store it **outside the webroot**, e.g. `D:\secure\amul-fcm.json`, not inside `ios_api/`.
> - If it must live in the webroot, add it to the `hiddenSegments` list in `ios_api/web.config` as we did for `config_aml.php`.
> - **Never commit it to git.** Add it to `.gitignore` immediately.

### Setup checklist

- [ ] Firebase project created
- [ ] `google-services.json` downloaded (Android)
- [ ] `GoogleService-Info.plist` downloaded (iOS)
- [ ] APNs `.p8` key created, downloaded and uploaded into Firebase
- [ ] Service account JSON downloaded and stored outside the webroot
- [ ] Project ID noted

---

## PART 3 — SERVER WORK (database + PHP)

This can all be built and tested **before** any app changes.

### Step 3.1 — Database changes

**A. Store the token on the existing device table.**

`soc_mst_api_device` already holds one row per employee device (`vc_emp_no`, `vc_device_id`, `nu_status`, `dt_register_date`). The token belongs with it:

```sql
ALTER TABLE soc_mst_api_device ADD vc_fcm_token VARCHAR(255) NULL;
ALTER TABLE soc_mst_api_device ADD dt_token_update DATETIME NULL;
```

`dt_token_update` tells you how fresh a token is — useful when diagnosing why someone is not receiving messages.

**B. A table for the announcements themselves.**

Store every announcement, so there is a history and an in-app list — not only a notification that vanishes when dismissed.

```sql
CREATE TABLE soc_mst_announcement (
    nu_id           INT IDENTITY(1,1) PRIMARY KEY,
    vc_title        VARCHAR(100)  NOT NULL,
    vc_body         VARCHAR(500)  NOT NULL,
    vc_audience     VARCHAR(50)   NOT NULL,   -- all_staff | employees | students
    nu_sent_count   INT           NULL,
    vc_create_user  VARCHAR(20)   NULL,
    vc_create_ip    VARCHAR(50)   NULL,
    dt_create_date  DATETIME      DEFAULT GETDATE(),
    nu_status       INT           DEFAULT 1   -- 1 active, 0 withdrawn
);
```

**C. Read tracking** (optional, but it answers "who has seen this?"):

```sql
CREATE TABLE soc_dtl_announcement_read (
    nu_announcement_no INT         NOT NULL,
    vc_emp_no          VARCHAR(20) NOT NULL,
    dt_read_date       DATETIME    DEFAULT GETDATE(),
    PRIMARY KEY (nu_announcement_no, vc_emp_no)
);
```

### Step 3.2 — `save_fcm_token.php`

Called by the app on every launch. Rules:

- Guarded by `require_token.php`, exactly like the other endpoints.
- **UPDATE, never INSERT** — matched on `(vc_emp_no, vc_device_id)`, which is the Milk Indent fix.
- Parameterised query.
- Returns `{ statusCode, message }`, the same shape the app already understands.

### Step 3.3 — `fcm_send.php` — the shared sender

One file, used by this app and later by Milk Indent. Two jobs:

**Job 1 — get an access token.** Read the service account JSON, build and sign a JWT with the private key (`openssl_sign`, `RS256`), exchange it at `https://oauth2.googleapis.com/token` for a bearer token valid one hour. **Cache it** — do not repeat this on every send.

**Job 2 — send.** POST to:

```
https://fcm.googleapis.com/v1/projects/<PROJECT-ID>/messages:send
Authorization: Bearer <access token>
```

Body, for a topic:

```json
{
  "message": {
    "topic": "all_staff",
    "notification": { "title": "Holiday Notice", "body": "Office closed on 2 Oct." },
    "data":         { "type": "announcement", "id": "42" },
    "android":      { "priority": "high" },
    "apns": { "payload": { "aps": { "sound": "default" } } }
  }
}
```

Two things Milk Indent got wrong that we fix here:

- Include a **`notification`** block. Milk Indent sent `data` only, which the OS will not display by itself.
- **Check the response properly** — inspect the HTTP status code via `CURLINFO_HTTP_CODE`, not just `curl_exec() === FALSE`.

For a single person, replace `"topic"` with `"token"` and the stored token value. If FCM replies `UNREGISTERED` or `INVALID_ARGUMENT`, that token is dead — clear it from the row so you stop sending to it.

### Step 3.4 — The admin page

A simple internal page: title, body, audience dropdown (All Staff / Employees / Students), Send.

On submit: insert into `soc_mst_announcement`, call `fcm_send.php` with the matching topic, store the result.

**Protect it properly.** This page can message every employee at once. It needs real login and a restriction to authorised staff — please do *not* copy the `?uid=<base64>` pattern from Milk Indent, where anyone can base64-encode a different employee number and act as them.

### Step 3.5 — `get_announcements.php`

Returns the recent announcements for the logged-in user, so the app can show a list with unread counts. Guarded by `require_token.php`. This is what makes the feature useful even when a notification is missed or dismissed.

---

## PART 4 — APP WORK (React Native)

### Step 4.1 — Install

```bash
npm install @react-native-firebase/app @react-native-firebase/messaging
cd ios && pod install && cd ..
```

Place the config files:

- `google-services.json` → `android/app/`
- `GoogleService-Info.plist` → add **through Xcode** (drag into the project tree — copying into the folder alone does not register it in the build)

**Android** — `android/build.gradle`:

```gradle
classpath 'com.google.gms:google-services:4.4.2'
```

`android/app/build.gradle`, at the bottom:

```gradle
apply plugin: 'com.google.gms.google-services'
```

**iOS, in Xcode** — Signing & Capabilities → **+ Capability**:
- Push Notifications
- Background Modes → tick **Remote notifications**

### Step 4.2 — Permission and token

Android 13+ and all iOS versions require the user to agree first — the same kind of prompt as your location permission.

Flow on app start, after login:

1. `messaging().requestPermission()`
2. `messaging().getToken()`
3. Send the token to `save_fcm_token.php`
4. Subscribe to topics: `all_staff`, plus `employees` or `students` by user type
5. Listen to `messaging().onTokenRefresh()` and re-send when it fires

On logout, `unsubscribeFromTopic()` — otherwise a shared phone keeps receiving messages meant for the previous user.

### Step 4.3 — Receiving

| Handler | When | What we do |
|---|---|---|
| `onMessage` | App open | Show an in-app banner and bump the unread badge |
| `setBackgroundMessageHandler` | App closed | Usually nothing — the OS shows it |
| `onNotificationOpenedApp` | Tapped, app in background | Open the announcement screen |
| `getInitialNotification` | Tapped, app was killed | Same, on cold start |

Suggested UI: a **bell icon in the top bar with an unread count**, opening an Announcements list fed by `get_announcements.php`. The push notification is the alert; the list is the record.

### Step 4.4 — Testing

Test on a **real device**. Push notifications do not work on the iOS Simulator.

1. Firebase Console → Messaging → **Send test message**, paste a token — proves the app side works.
2. Send to the `all_staff` topic from the console — proves topics work.
3. Send from your own `fcm_send.php` — proves the PHP works.
4. Test all three app states: open, background, killed.
5. Test on iOS **and** Android — they behave differently.

---

## PART 5 — ORDER OF WORK

| # | Task | Who | Blocked by |
|---|---|---|---|
| 1 | Firebase project + both app registrations | You | — |
| 2 | APNs key from Apple, uploaded to Firebase | You | Apple account access |
| 3 | Service account JSON, stored securely | You | 1 |
| 4 | Database changes | Dev | — |
| 5 | `save_fcm_token.php` | Dev | 4 |
| 6 | `fcm_send.php` (HTTP v1) | Dev | 3 |
| 7 | Test send from Firebase Console | You | 1 |
| 8 | App: install, permission, token, topics | Dev | 1, 5 |
| 9 | App: receive handlers + bell icon + list | Dev | 8 |
| 10 | Admin page | Dev | 6 |
| 11 | End-to-end test on real devices | Both | all |
| 12 | Release 1.0.4 | You | 11 |

Steps 4–6 can proceed while you are still waiting on the Apple key.

### Realistic timing

- Server side (4, 5, 6, 10): 2–3 days
- App side (8, 9): 2–3 days
- Firebase/Apple setup: depends entirely on account access
- Testing across both platforms: 1–2 days

### Important constraints

- **This needs a new app release.** Firebase is native code, so unlike your location-accuracy settings it cannot be switched on from the server.
- **Ship it after 1.0.3.** The token-guard enforcement rollout should finish first; do not mix the two.
- **iOS will not work without the APNs key**, and gives no error when it is missing.
- Users can **refuse** the permission. The app must work normally for them — announcements simply arrive in the in-app list instead.

---

## PART 6 — MISTAKES TO AVOID

Each of these is a real defect found in the Milk Indent code.

| Mistake | Consequence | Our approach |
|---|---|---|
| Save the token only at registration | Notifications die after any reinstall | UPDATE on every app launch |
| INSERT instead of UPDATE | Duplicate rows, sends go to a dead token | Matched on `(emp_no, device_id)` |
| Only check `curl_exec() === FALSE` | Failures are invisible for years | Check `CURLINFO_HTTP_CODE` and the response body |
| Hardcode the credential in the PHP file | Anyone reading the file can message all staff | Service account JSON outside the webroot |
| Send `data` only, no `notification` | Nothing appears when the app is closed | Always include `notification` |
| `?uid=<base64>` as identity | Anyone can impersonate anyone | Real auth via `require_token.php` |
| String-interpolated SQL | SQL injection | Parameterised queries |
| Never remove dead tokens | The table fills with addresses that will never deliver | Clear on `UNREGISTERED` |

---

## PART 7 — GLOSSARY

| Term | Meaning |
|---|---|
| **FCM** | Firebase Cloud Messaging — Google's notification delivery service |
| **APNs** | Apple Push Notification service — Apple's equivalent; Firebase forwards to it |
| **Token** | The unique delivery address of one app install on one phone |
| **Topic** | A named channel; send once, everyone subscribed receives it |
| **Service account** | A credential file that lets your server authenticate to Google |
| **OAuth access token** | A short-lived (1 hour) pass generated from the service account |
| **HTTP v1** | The current FCM sending API; replaced the legacy one shut down in July 2024 |
| **Legacy API** | The old `/fcm/send` method used by Milk Indent — no longer functional |
| **Notifee** | An optional library for better-looking in-app notification banners |

---

## SOURCES

- [Firebase — Cloud Messaging documentation](https://firebase.google.com/docs/cloud-messaging)
- [Firebase — Best practices for FCM registration token management](https://firebase.google.com/docs/cloud-messaging/manage-tokens)
- [React Native Firebase — Cloud Messaging usage](https://rnfirebase.io/messaging/usage)
- [React Native Firebase — Android installation](https://rnfirebase.io/messaging/usage/installation/android)
- [Migrating to FCM HTTP v1](https://developers.intercom.com/installing-intercom/android/fcm-migration-guide)
- [Upgrading FCM from Legacy API to HTTP v1 using PHP](https://intertoons.com/upgrading-fcm-from-legacy-api-to-http-v1-api.html)
