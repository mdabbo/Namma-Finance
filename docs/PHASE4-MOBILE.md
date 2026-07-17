# Phase 4 — NAMAA Finance mobile companion (Expo)

A **read-only** phone app that shows the office's live financials from the
same Supabase backend the desktop syncs to. All figures are computed on the
phone by the **same `@mep/core` engine** as the desktop — the two can never
disagree. Arabic + English.

Screens: **Home** (consolidated KPIs in EGP, per-currency face values,
ready-to-collect, team payments due, overdue count) · **Projects** (list with
certified/collected bars) · **Project detail** (totals + certificates) ·
**Settings** (language, sign out). Pull down anywhere to refresh.

## Try it on your phone (development — no app store needed)

1. Install **Expo Go** from the Play Store / App Store on your phone.
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

- **Read-only** by design: recording payments/certificates stays on the
  desktop, so there are no write conflicts.
- Consolidated KPIs are in **EGP** (each project's stored rate); the
  per-currency section shows face values. The desktop's display-currency
  setting is local to the desktop.
- Layout is LTR even in Arabic (RTL layout needs an app restart per switch —
  planned with Phase 5 polish).
- A standalone installable APK (no Expo Go) can be produced later with
  `eas build` — say the word when you want one.
