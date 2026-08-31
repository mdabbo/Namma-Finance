import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Release-manifest regression coverage.
 *
 * `sync-version.mjs --check` writes and verifies the version consumers, so it
 * cannot be the only thing asserting they agree — a bug in the writer is
 * invisible to a check that shares its code. These tests re-read every consumer
 * independently.
 *
 * The migration assertion covers a gap the script itself has: it syncs
 * `CURRENT_SCHEMA_VERSION` in lib.rs from `release/release.json` but never looks
 * at the migration that actually stamps `PRAGMA user_version`. Bumping
 * schemaVersion without adding the matching migration would leave `version:check`
 * green while the shipped application refused to open every database with
 * SCHEMA_VERSION_MISMATCH.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const release = JSON.parse(read("release/release.json"));

test("the release manifest is a valid, shippable descriptor", () => {
  assert.match(release.version, /^\d+\.\d+\.\d+$/, "version must be plain semver");
  assert.ok(
    ["Development", "Beta", "Stable"].includes(release.channel),
    `unknown release channel ${release.channel}`,
  );
  assert.ok(Number.isSafeInteger(release.schemaVersion) && release.schemaVersion >= 1);
});

test("every package version matches the release manifest", () => {
  for (const path of [
    "package.json",
    "apps/desktop/package.json",
    "apps/mobile/package.json",
    "packages/core/package.json",
  ]) {
    assert.equal(JSON.parse(read(path)).version, release.version, `${path} version`);
  }
});

test("the Tauri and Cargo versions match the release manifest", () => {
  assert.equal(JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version, release.version);
  const cargo = read("apps/desktop/src-tauri/Cargo.toml");
  const version = /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
  assert.equal(version, release.version, "Cargo.toml package version");
});

test("the generated release constants match the manifest in both apps", () => {
  for (const path of ["apps/desktop/src/generated/release.ts", "apps/mobile/src/generated/release.ts"]) {
    const generated = read(path);
    assert.match(generated, new RegExp(`APP_VERSION = "${release.version}"`), `${path} APP_VERSION`);
    assert.match(generated, new RegExp(`RELEASE_CHANNEL = "${release.channel}"`), `${path} channel`);
    assert.match(
      generated,
      new RegExp(`EXPECTED_SCHEMA_VERSION = ${release.schemaVersion}\\b`),
      `${path} schema version`,
    );
  }
});

test("the Rust schema constant matches the release manifest", () => {
  const stated = /const CURRENT_SCHEMA_VERSION: i64 = (\d+);/.exec(
    read("apps/desktop/src-tauri/src/lib.rs"),
  )?.[1];
  assert.equal(Number(stated), release.schemaVersion, "CURRENT_SCHEMA_VERSION in lib.rs");
});

test("the last migration stamps the schema version the manifest claims", () => {
  const dir = "apps/desktop/src-tauri/migrations";
  const migrations = readdirSync(resolve(root, dir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.length > 0, "no migrations found");

  // Only the newest migration may stamp the current identity; an older one
  // still stamping it would mean two migrations claim the same version.
  const last = migrations.at(-1);
  const stamped = [...read(`${dir}/${last}`).matchAll(/PRAGMA\s+user_version\s*=\s*(\d+)/gi)].map(
    (match) => Number(match[1]),
  );
  assert.deepEqual(
    stamped,
    [release.schemaVersion],
    `${last} must stamp user_version ${release.schemaVersion} exactly once`,
  );

  // app_metadata carries the same number, so the two agree on disk.
  assert.match(
    read(`${dir}/${last}`),
    new RegExp(`'schema_version'\\s*,\\s*'${release.schemaVersion}'`),
    `${last} app_metadata schema_version`,
  );
});

test("the changelog documents the version being released", () => {
  assert.ok(
    read("CHANGELOG.md").includes(`## [${release.version}]`),
    `CHANGELOG.md has no section for ${release.version}`,
  );
});
