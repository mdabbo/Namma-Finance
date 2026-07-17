import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMobileWorkspace } from "../lib/workspace";

/** The signed-in Supabase client, provided by App once setup completes. */
export const SupabaseContext = createContext<SupabaseClient | null>(null);

export function useSupabase(): SupabaseClient {
  const client = useContext(SupabaseContext);
  if (!client) throw new Error("SupabaseContext missing");
  return client;
}

export function useWorkspace() {
  const client = useSupabase();
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => loadMobileWorkspace(client),
    staleTime: 60_000,
  });
}
