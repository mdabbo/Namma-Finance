import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSyncClient, getSyncSession } from "./sync/client";
import { loadSettings } from "./settings";

/**
 * Phase 5 roles (confirmed):
 *  ADMIN      — everything, including the Users panel
 *  ACCOUNTANT — every screen except managing users
 *  ENGINEER   — projects / stages / documents only, no money screens
 *
 * The role lives in the cloud (user_roles table, keyed by the auth user)
 * and is fetched from the backend for authorization decisions. A cached role
 * is never trusted. With no cloud configured at all, the app stays the
 * single-user tool it always was → full access.
 *
 * v1 enforcement is in the app UI; the database still trusts any office
 * login (see docs/supabase-roles.sql).
 */

export type Role = "ADMIN" | "ACCOUNTANT" | "ENGINEER";

const ENGINEER_PREFIXES = ["/projects", "/settings"];

export function allowedPath(role: Role, pathname: string): boolean {
  if (role !== "ENGINEER") return true;
  return ENGINEER_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function homePath(role: Role): string {
  return role === "ENGINEER" ? "/projects" : "/";
}

/**
 * Fetch the signed-in user's role and cache it. The very first user of the
 * office bootstraps as ADMIN (the SQL policy only permits this while
 * user_roles is empty). Unknown users fall back to ENGINEER — the most
 * restricted view — until an admin assigns them a role.
 */
export async function refreshRole(): Promise<Role | null> {
  const session = await getSyncSession();
  if (!session) return null; // offline / not configured → keep cached / full access
  const client = await getSyncClient();
  const { data, error } = await client.from("user_roles").select("role").eq("user_id", session.user.id).maybeSingle();
  if (error) {
    // table missing (roles SQL not run yet) → behave like before roles existed
    console.warn("role fetch failed:", error.message);
    return null;
  }
  let role = (data?.role as Role | undefined) ?? null;
  if (!role) {
    const { error: bootError } = await client.from("user_roles").insert({
      user_id: session.user.id,
      email: session.user.email ?? "",
      role: "ADMIN",
    });
    role = bootError ? "ENGINEER" : "ADMIN";
  }
  return role;
}

/** Effective role for UI gating. Backend RLS remains the authority. */
export function useRole(): Role {
  const { data } = useQuery({
    queryKey: ["role"],
    queryFn: async () => {
      const settings = await loadSettings();
      if (!settings.syncUrl || !settings.syncAnonKey) return "ADMIN" as Role;
      return (await refreshRole()) ?? ("ENGINEER" as Role);
    },
    staleTime: 0,
  });
  return data ?? "ENGINEER";
}

export function useInvalidateRole() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["role"] });
}
