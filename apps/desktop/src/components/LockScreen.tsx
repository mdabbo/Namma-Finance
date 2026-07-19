import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { verifyLockPassword } from "../lib/lock";
import { syncSignIn } from "../lib/sync/client";
import { loadSettings } from "../lib/settings";
import { Button, Input } from "./ui";
import logoUrl from "../assets/namaa-logo.png";

/** Launch gate: local password, with the cloud login as the recovery key. */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    if (busy) return;
    setBusy(true);
    try {
      if (await verifyLockPassword(password)) onUnlock();
      else {
        setError(true);
        setPassword("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function unlockViaCloud() {
    if (busy) return;
    setBusy(true);
    setRecoveryError(null);
    try {
      const settings = await loadSettings();
      await syncSignIn(recoveryEmail || settings.syncEmail, password);
      onUnlock(); // correct cloud credentials prove it's the office user
    } catch (e) {
      setRecoveryError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-slate-100 dark:bg-slate-950">
      <img src={logoUrl} alt="NAMAA" className="h-16 w-16" />
      <div className="w-80 rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-center justify-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          <Lock size={15} /> {recovery ? t("lock.recoveryTitle") : t("lock.title")}
        </div>
        {recovery && (
          <Input
            dir="ltr"
            type="email"
            className="mb-2"
            placeholder={t("settings.syncEmail")}
            value={recoveryEmail}
            onChange={(e) => setRecoveryEmail(e.target.value)}
          />
        )}
        <Input
          dir="ltr"
          type="password"
          autoFocus
          placeholder={recovery ? t("settings.syncPassword") : t("lock.password")}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void (recovery ? unlockViaCloud() : unlock());
          }}
        />
        {error && <p className="mt-2 text-xs text-red-600">{t("lock.wrong")}</p>}
        {recoveryError && <p className="mt-2 text-xs text-red-600">{recoveryError}</p>}
        <Button
          variant="primary"
          className="mt-4 w-full justify-center"
          disabled={busy || password === ""}
          onClick={() => void (recovery ? unlockViaCloud() : unlock())}
        >
          {t("lock.unlock")}
        </Button>
        <button
          className="mt-3 w-full text-center text-xs text-slate-400 hover:text-brand-600"
          onClick={() => {
            setRecovery((r) => !r);
            setPassword("");
            setError(false);
            setRecoveryError(null);
          }}
        >
          {recovery ? t("lock.backToPassword") : t("lock.forgot")}
        </button>
      </div>
    </div>
  );
}
