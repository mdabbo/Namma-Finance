import { APP_VERSION, EXPECTED_SCHEMA_VERSION, RELEASE_CHANNEL } from "../generated/release";
import { getRuntimeReleaseInfo } from "./db";

export interface ReleaseInfo {
  appVersion: string;
  channel: typeof RELEASE_CHANNEL;
  schemaVersion: number;
  expectedSchemaVersion: number;
}

export async function loadReleaseInfo(): Promise<ReleaseInfo> {
  const runtime = await getRuntimeReleaseInfo();
  if (runtime.appVersion !== APP_VERSION) throw new Error("APPLICATION_VERSION_MISMATCH");
  if (!Number.isSafeInteger(runtime.schemaVersion) || runtime.schemaVersion < 1) throw new Error("SCHEMA_VERSION_UNAVAILABLE");
  return {
    appVersion: APP_VERSION,
    channel: RELEASE_CHANNEL,
    schemaVersion: runtime.schemaVersion,
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
  };
}
