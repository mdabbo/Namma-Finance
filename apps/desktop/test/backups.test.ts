import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db",async()=>await import("./db-harness"));

import { execute,raw,resetDb } from "./db-harness";
import { finalizePendingBackupMetadata } from "../src/repositories/backups";
import { loadSettings,saveSetting } from "../src/lib/settings";

beforeEach(()=>resetDb());

describe("Milestone 9 backup metadata",()=>{
  it("finalizes pre-v14 restore safety metadata atomically",async()=>{
    const pending={path:"C:/safe/pre-restore.db",filename:"pre-restore.db",databaseVersion:13,applicationVersion:"0.6.3",sha256Checksum:"a".repeat(64),sourceDevice:"device-a"};
    await execute("INSERT INTO settings(key,value) VALUES('pending_restore_safety',$1)",[JSON.stringify(pending)]);
    await finalizePendingBackupMetadata();
    expect(raw("SELECT key FROM settings WHERE key='pending_restore_safety'")).toHaveLength(0);
    expect(raw("SELECT filename,database_version,application_version,sha256_checksum,backup_type,source_device FROM backups_log")).toEqual([{filename:"pre-restore.db",database_version:13,application_version:"0.6.3",sha256_checksum:"a".repeat(64),backup_type:"SAFETY",source_device:"device-a"}]);
  });

  it("persists and bounds configurable automatic-backup retention",async()=>{
    expect((await loadSettings()).backupRetentionCount).toBe(14);
    await saveSetting("backupRetentionCount",30);
    expect((await loadSettings()).backupRetentionCount).toBe(30);
    await saveSetting("backupRetentionCount",999);
    expect((await loadSettings()).backupRetentionCount).toBe(365);
  });
});
