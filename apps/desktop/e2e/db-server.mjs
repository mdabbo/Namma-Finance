import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * End-to-end database bridge.
 *
 * Playwright drives the app in a browser, where the Tauri SQL plugin does not
 * exist. This test-only server backs the browser with the SAME engine and the
 * SAME migration files the unit harness and the shipped app use, so the specs
 * exercise real repository SQL, real triggers, and real financial constraints
 * rather than a mock.
 *
 * Test-only: it is started by playwright.config.ts, binds to localhost, and is
 * never part of a production build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "src-tauri", "migrations");
const MIGRATIONS = ["0001_baseline.sql", "0002_seed_reference_data.sql"];

let db = null;

function resetDatabase() {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
}

/**
 * The app speaks Postgres-style `$1..$N`; node:sqlite wants positional `?`.
 * Values are repeated in encounter order so a placeholder used twice binds
 * correctly — identical to the unit harness translation.
 */
function translate(sql, params) {
  const values = [];
  const out = sql.replace(/\$(\d+)/g, (_match, index) => {
    const value = params[Number(index) - 1];
    values.push(value === undefined ? null : value);
    return "?";
  });
  return { sql: out, values };
}

function normalize(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  return value;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

// Only the app under test may reach this endpoint. It executes arbitrary SQL,
// so even though it binds to loopback and holds a throwaway in-memory
// database, it does not advertise itself to every origin on the machine.
const ALLOWED_ORIGIN = process.env.E2E_APP_ORIGIN ?? "http://localhost:1420";

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) {
    response.writeHead(403).end();
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const send = (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  try {
    if (request.url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (request.url === "/reset") {
      resetDatabase();
      send(200, { ok: true });
      return;
    }

    const body = await readBody(request);
    const params = (body.params ?? []).map(normalize);
    const { sql, values } = translate(body.sql ?? "", params);

    if (request.url === "/select") {
      send(200, { rows: db.prepare(sql).all(...values) });
      return;
    }
    if (request.url === "/execute") {
      const result = db.prepare(sql).run(...values);
      send(200, {
        lastInsertId: Number(result.lastInsertRowid),
        rowsAffected: Number(result.changes),
      });
      return;
    }
    send(404, { error: "unknown endpoint" });
  } catch (error) {
    // Domain errors raised by triggers (RAISE(ABORT,...)) must reach the UI
    // exactly as the Tauri plugin would surface them.
    send(400, { error: error instanceof Error ? error.message : String(error) });
  }
});

resetDatabase();
const port = Number(process.env.E2E_DB_PORT ?? 1425);
server.listen(port, "127.0.0.1", () => {
  console.log(`e2e db bridge listening on http://127.0.0.1:${port}`);
});
