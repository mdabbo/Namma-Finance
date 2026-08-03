import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSyncClient, getSyncSession } from "./sync/client";
import { loadSettings } from "./settings";
import { canOpenSettingsSection } from "../app/navigation";

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
export type SearchScope = "FULL" | "PROJECTS_ONLY";
export const ROLE_REFRESH_INTERVAL_MS = 60_000;

export function allowedPath(role: Role, pathname: string): boolean {
  if (role !== "ENGINEER") return true;
  if (pathname === "/settings") return true;
  // Settings is now one section per route, so the engineer's own preferences
  // live at /settings/general rather than /settings. Each section is checked
  // against the same list that builds the menu, so a section they may not open
  // stays closed whether it is clicked or typed into the address bar.
  const section = /^\/settings\/([^/]+)$/.exec(pathname)?.[1];
  if (section) return canOpenSettingsSection(role, section);
  if (pathname === "/projects") return true;
  // Project workspaces use a single numeric-id segment. Keep clients, which
  // now live under /projects/clients, outside the engineer role just as they
  // were before the navigation redesign.
  return /^\/projects\/\d+$/.test(pathname);
}

export function homePath(role: Role): string {
  return role === "ENGINEER" ? "/projects" : "/overview";
}

export function searchScopeForRole(role: Role): SearchScope {
  return role === "ENGINEER" ? "PROJECTS_ONLY" : "FULL";
}

export function canMountRoute(role: Role, pathname: string, rolePending: boolean): boolean {
  return !rolePending && allowedPath(role, pathname);
}

export function roleRedirectTarget(role: Role, pathname: string, rolePending: boolean): string | null {
  if (rolePending || canMountRoute(role, pathname, rolePending)) return null;
  return homePath(role);
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

function useRoleQuery() {
  return useQuery({
    queryKey: ["role"],
    queryFn: async () => {
      const settings = await loadSettings();
      if (!settings.syncUrl || !settings.syncAnonKey) return "ADMIN" as Role;
      return (await refreshRole()) ?? ("ENGINEER" as Role);
    },
    staleTime: 0,
    refetchInterval: ROLE_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Effective role and loading state for fail-closed route gating. */
export function useRoleAccess(): { role: Role; rolePending: boolean } {
  const { data, isPending } = useRoleQuery();
  return { role: data ?? "ENGINEER", rolePending: isPending };
}

/** Effective role for UI gating. Backend RLS remains the authority. */
export function useRole(): Role {
  return useRoleAccess().role;
}

export function useInvalidateRole() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["role"] });
}
