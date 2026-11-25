import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EGP_VALUATION } from "@mep/core";
import { loadMobileWorkspace } from "../lib/workspace";
import { useReportingCurrency } from "./useReportingCurrency";

/** The signed-in Supabase client, provided by App once setup completes. */
export const SupabaseContext = createContext<SupabaseClient | null>(null);

export function useSupabase(): SupabaseClient {
  const client = useContext(SupabaseContext);
  if (!client) throw new Error("SupabaseContext missing");
  return client;
}

/**
 * The workspace, with consolidated totals in the phone's reporting currency.
 * A foreign currency without a rate yet falls back to EGP — never to a guessed
 * rate — and `data.currency` says which one the totals are in.
 */
export function useWorkspace() {
  const client = useSupabase();
  const { valuation, fxRateMicro, loaded } = useReportingCurrency();
  const effective = valuation ?? EGP_VALUATION;
  return useQuery({
    queryKey: ["workspace", effective.currency, valuation ? fxRateMicro : null],
    queryFn: () => loadMobileWorkspace(client, effective),
    staleTime: 60_000,
    enabled: loaded,
  });
}
