# Phase 3 — Supabase sync setup (one-time, ~5 minutes)

The app syncs through a free Supabase project that **you** own. No keys are
stored in this repository — you paste them into the app's Settings once.

## 1. Create the project

1. Go to <https://supabase.com> → **Start your project** → sign up (GitHub login is easiest).
2. **New project** → name it `namaa-finance`, choose a strong database password
   (store it in your password manager — you rarely need it again), region:
   **Frankfurt (eu-central-1)** is closest to Egypt.
3. Wait ~1 minute for the project to provision.

## 2. Create the tables

1. In the left sidebar open **SQL Editor** → **New query**.
2. Paste the whole content of [`supabase-schema.sql`](./supabase-schema.sql) and press **Run**.
   It should end with "Success. No rows returned".

## 3. Create the office login

1. Sidebar → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter the office email + a password (this is what you'll type into the app).
3. Still under Authentication → **Sign In / Up → disable "Allow new users to sign up"**
   so nobody else can register into your project.

## 3b. (Phase 5) Enable roles

Run [`supabase-roles.sql`](./supabase-roles.sql) in the SQL Editor the same
way. The first account that signs into the app becomes **Admin**; add more
logins under Authentication → Users and assign their role (Admin /
Accountant / Engineer) from the app's Settings → Users & roles panel.

## 4. Get the two values the app needs

Sidebar → **Project Settings** → **API Keys**:

- **Project URL** — looks like `https://abcdefgh.supabase.co`
- **anon / public key** — the long `eyJ…` string (safe to use in the app;
  row-level security is what protects the data)

## 5. Connect the app

NAMAA Finance → **Settings → Cloud sync**: paste the URL and anon key, sign in
with the office email + password, then press **Sync now**. The first sync
uploads everything; from then on it's incremental both ways.

On your second PC (and later the mobile app), install the same app version,
enter the same URL/key/login, and press **Sync now** — both machines now share
the same data.

> **Conflict rule:** if the same record was edited on two devices while
> offline, the most recent edit wins (per record). Deletions replicate too.
