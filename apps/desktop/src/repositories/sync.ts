import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSyncSession, resetSyncClient, syncSignIn, syncSignOut } from "../lib/sync/client";
import { getLastSyncReport, runSync } from "../lib/sync/engine";
import { useSettings } from "../lib/settings";

const AUTO_SYNC_MINUTES = 15;

export function useSyncSession() {
  return useQuery({ queryKey: ["sync", "session"], queryFn: getSyncSession });
}

export function useLastSyncReport() {
  return useQuery({ queryKey: ["sync", "last"], queryFn: getLastSyncReport });
}

export function useSyncMutations() {
  const qc = useQueryClient();
  const afterSync = () => {
    void qc.invalidateQueries(); // pulled rows can touch every list in the app
  };
  return {
    signIn: useMutation({
      mutationFn: (v: { email: string; password: string }) => syncSignIn(v.email, v.password),
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["sync"] }),
    }),
    signOut: useMutation({
      mutationFn: syncSignOut,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["sync"] }),
    }),
    run: useMutation({ mutationFn: runSync, onSuccess: afterSync }),
  };
}

/** Call after the user edits the URL/anon key so the client is rebuilt. */
export function invalidateSyncClient(): void {
  resetSyncClient();
}

/**
 * Auto-sync: once shortly after launch, then every 15 minutes — only when
 * enabled in Settings and a session exists. Mounted once in the app Layout.
 */
export function useAutoSync(): void {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const enabled = settings?.syncAuto === true && !!settings?.syncUrl && !!settings?.syncAnonKey;
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const session = await getSyncSession();
        if (session) {
          const report = await runSync();
          if (report.ok && (report.pulled > 0 || report.deletedLocal > 0)) void qc.invalidateQueries();
          void qc.invalidateQueries({ queryKey: ["sync", "last"] });
        }
      } catch {
        // stay quiet — the Settings page shows the last report
      } finally {
        busy.current = false;
      }
    };
    const initial = window.setTimeout(() => void tick(), 5_000);
    const interval = window.setInterval(() => void tick(), AUTO_SYNC_MINUTES * 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [enabled, qc]);
}
