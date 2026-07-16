import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { execute, select } from "../lib/db";

export interface CurrencyRate {
  code: string;
  fxRateMicro: number;
  updatedAt: string;
}

export async function listCurrencyRates(): Promise<CurrencyRate[]> {
  const rows = await select<{ code: string; fx_rate_micro: number; updated_at: string }>(
    "SELECT * FROM currencies ORDER BY CASE code WHEN 'EGP' THEN 0 ELSE 1 END, code",
  );
  return rows.map((r) => ({ code: r.code, fxRateMicro: r.fx_rate_micro, updatedAt: r.updated_at }));
}

export async function updateCurrencyRate(code: string, fxRateMicro: number): Promise<void> {
  await execute(
    "UPDATE currencies SET fx_rate_micro = $1, updated_at = datetime('now') WHERE code = $2",
    [fxRateMicro, code],
  );
}

/**
 * Fetch CBE buy rates via the hidden-WebView Rust command and update the
 * currencies table. Returns the list of currency codes that were updated.
 */
export async function syncRatesFromCbe(): Promise<string[]> {
  const json = await invoke<string>("fetch_cbe_rates");
  const rates = JSON.parse(json) as Record<string, number>;
  const updated: string[] = [];
  for (const [code, egpPerUnit] of Object.entries(rates)) {
    if (!Number.isFinite(egpPerUnit) || egpPerUnit <= 0) continue;
    const micro = Math.round(egpPerUnit * 1_000_000);
    const r = await execute(
      "UPDATE currencies SET fx_rate_micro = $1, updated_at = datetime('now') WHERE code = $2",
      [micro, code],
    );
    if (r.rowsAffected > 0) updated.push(code);
  }
  if (updated.length === 0) throw new Error("no rates updated");
  return updated;
}

export function useCurrencyRates() {
  return useQuery({ queryKey: ["currencies"], queryFn: listCurrencyRates });
}

export function useCurrencyMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["currencies"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    updateRate: useMutation({
      mutationFn: (v: { code: string; fxRateMicro: number }) => updateCurrencyRate(v.code, v.fxRateMicro),
      onSuccess: invalidate,
    }),
    syncFromCbe: useMutation({ mutationFn: syncRatesFromCbe, onSuccess: invalidate }),
  };
}
