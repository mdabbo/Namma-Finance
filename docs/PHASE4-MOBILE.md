# Phase 4 — NAMAA Finance mobile companion (Expo)

A phone app that shows the office's live financials from the same Supabase
backend the desktop syncs to, and logs **time entries** — the one thing it
writes. All figures are computed on the
phone by the **same `@mep/core` engine** as the desktop — the two can never
disagree. Arabic + English.

Screens: **Home** (consolidated KPIs in EGP, per-currency face values,
ready-to-collect, team payments due, overdue count) · **Projects** (list with
certified/collected bars) · **Project detail** (totals + certificates) ·
**Time** (log, change or delete time entries from the last 14 days) ·
**Settings** (language, sign out). Pull down anywhere to refresh.

## Try it on your phone (development — no app store needed)

1. Install **Expo Go** from the Play Store / App Store on your phone. **The
   current Expo Go (SDK 58) will not open this app, which is on SDK 54** — it
   shows "Project is incompatible with this version of Expo Go". Install the APK
   below instead, or an older Expo Go built for SDK 54 (<https://expo.dev/go>).
2. On the PC (phone and PC on the same Wi-Fi):
   ```sh
   cd C:\Dev\Namaa-finance\apps\mobile
   pnpm start
   ```
3. Scan the QR code that appears (Expo Go on Android; the Camera app on iOS).
4. First run: enter the same **Project URL**, **anon key**, and office
   email/password you used in the desktop's Settings → Cloud sync, and sign in.
   They're saved on the phone; next launches go straight to the dashboard.

> The phone reads whatever the desktop last synced — press **Sync now** on the
> desktop (or enable auto-sync) to keep the mobile view fresh.

## Notes / current limits (v0.1)

- **Time entries are the only write.** Certificates, payments and every other
  financial record stay on the desktop (a test holds every cloud write to
  `time_entries`). An entry is saved on the phone first and sent when the
  cloud answers, so a dropped signal never loses it; its uuid is the cloud key,
  so a resend never makes a second entry. `updated_at` comes from the cloud's
  clock (the `Date` header of `/auth/v1/health`), so a phone with a slow clock
  cannot write rows the desktops' pull would skip.
- The phone keeps the **14-day window** itself: an office login is not bound by
  the cloud guard in `supabase-0021`, which only binds an engineer's own login.
  Older entries are changed on the desktop.
- Consolidated KPIs are in **EGP** (each project's stored rate); the
  per-currency section shows face values. The desktop's display-currency
  setting is local to the desktop.
- **Arabic is right-to-left on every screen**, and English left-to-right. The
  switch in Settings re-lays-out the whole app at once, with no restart: the
  layout direction is an explicit style on the root view (`App.tsx`), not the
  phone's own setting. Arabic text uses Tajawal. Headers are drawn by the app
  (`ScreenHeader`) so the back button is on the right side in Arabic.
  The phone's own direction is kept in step for the next time the app is
  opened (`nativeDirection.ts`); it only affects system pieces such as the
  pull-to-refresh spinner. **Not yet checked on a real phone** — see the
  checklist in the F2 pull request.

## Install it as a real app (APK, no Expo Go)

The APK is built in Expo's cloud (EAS), because this PC has no Java or
Android SDK. It is free on Expo's Free plan. You need an Expo account
(sign up at <https://expo.dev>).

**One time only**, in a terminal:

```sh
npm install -g eas-cli
eas login
```

The app is already linked to the Expo project `@dabworks/namaa-finance`
(`eas init` wrote its `projectId` and `owner` into `app.json`). On the first build EAS also offers to create
an Android signing key — accept; it stays on your Expo account. **Do not lose
that account**: an APK signed with a different key cannot install over this
one, and you would have to uninstall (losing the saved sign-in) first.

**Each build:**

```sh
cd C:DevNamaa-financeappsmobile
eas build --platform android --profile apk
```

It takes about 10–20 minutes. When it finishes, open the link it prints on
your phone, download the `.apk` and open it. Android asks once to allow
installs from your browser. A later build installs over the earlier one and
keeps your sign-in: EAS raises the build number each time.

- The Supabase URL, anon key and password are typed into the app on first
  run and stay on the phone. They are never part of the build.
- The application id is `com.mepfinance.mobile`. Never change it — Android
  would treat the next APK as a different app.
- The app still targets Expo SDK 54. Upgrading the SDK is a separate step,
  done after the APK works.
