use tauri_plugin_sql::{Migration, MigrationKind};

/// Replace the live database file with a backup. The frontend must close the
/// SQL connection first (`db.close()`), then relaunch after this returns.
#[tauri::command]
fn restore_database(app: tauri::AppHandle, backup_path: String) -> Result<(), String> {
    use tauri::Manager;
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("mep-finance.db");
    if !std::path::Path::new(&backup_path).exists() {
        return Err(format!("backup not found: {backup_path}"));
    }
    // Remove WAL side files so the restored file is opened cleanly.
    for suffix in ["-wal", "-shm"] {
        let side = db_path.with_file_name(format!("mep-finance.db{suffix}"));
        let _ = std::fs::remove_file(side);
    }
    std::fs::copy(&backup_path, &db_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetch exchange rates from the Central Bank of Egypt.
///
/// CBE's WAF rejects plain HTTP clients, so the page is loaded in a hidden
/// real WebView (which passes the browser checks). An initialization script
/// scrapes the rates table and publishes the result through the URL fragment,
/// which this command polls. Returns a JSON object {"USD": buyRate, ...}.
#[tauri::command]
async fn fetch_cbe_rates(app: tauri::AppHandle) -> Result<String, String> {
    // The polling loop sleeps, so it must run OFF the main thread — a plain
    // (sync) command would execute on the main thread and freeze the whole UI
    // while also deadlocking the hidden-window creation it depends on.
    tauri::async_runtime::spawn_blocking(move || fetch_cbe_rates_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_cbe_rates_blocking(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const LABEL: &str = "cbe-rates-sync";
    const URL: &str = "https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates";

    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.close();
    }

    // Scrape any table row whose first cell is a known currency name and whose
    // following cells contain numbers; the FIRST number is the CBE buy rate.
    let script = r#"
      (function poll() {
        try {
          var map = {
            "US Dollar": "USD", "Euro": "EUR", "Pound Sterling": "GBP",
            "Saudi Riyal": "SAR", "Saudi Arabian Riyal": "SAR",
            "Kuwaiti Dinar": "KWD", "UAE Dirham": "AED", "Emirates Dirham": "AED",
            "Qatari Riyal": "QAR", "Bahraini Dinar": "BHD",
            "Omani Riyal": "OMR", "Jordanian Dinar": "JOD"
          };
          var out = {};
          document.querySelectorAll("table tr").forEach(function (row) {
            var cells = row.querySelectorAll("td, th");
            if (cells.length < 2) return;
            var code = map[cells[0].textContent.trim()];
            if (!code) return;
            for (var i = 1; i < cells.length; i++) {
              var v = parseFloat(cells[i].textContent.replace(/,/g, "").trim());
              if (isFinite(v) && v > 0) { out[code] = v; break; }
            }
          });
          if (Object.keys(out).length >= 3) {
            location.hash = "cberates=" + encodeURIComponent(JSON.stringify(out));
            return;
          }
        } catch (e) {}
        setTimeout(poll, 700);
      })();
    "#;

    let url: tauri::Url = URL.parse().map_err(|e| format!("bad url: {e}"))?;
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .visible(false)
        .title("CBE rates")
        .initialization_script(script)
        .build()
        .map_err(|e| e.to_string())?;

    // Poll the webview URL for up to 45 s; the WAF challenge can add a few
    // seconds of redirects before the real page (and our script) runs.
    eprintln!("[cbe] hidden window created, polling for rates…");
    for _ in 0..90 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(current) = window.url() {
            if let Some(fragment) = current.fragment() {
                if let Some(encoded) = fragment.strip_prefix("cberates=") {
                    let json = urlencoding_decode(encoded);
                    let _ = window.close();
                    eprintln!("[cbe] rates received: {json}");
                    return Ok(json);
                }
            }
        } else {
            break;
        }
    }
    let _ = window.close();
    eprintln!("[cbe] timeout — no rates within 45s");
    Err("timeout".into())
}

/// Minimal percent-decoding (the fragment is produced by encodeURIComponent).
fn urlencoding_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "seed_defaults",
            sql: include_str!("../migrations/0002_seed.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "feedback_round1",
            sql: include_str!("../migrations/0003_feedback_round1.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "phase2_stages_documents_recurring",
            sql: include_str!("../migrations/0004_phase2.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "backfill_team_payment_expenses",
            sql: include_str!("../migrations/0005_backfill_team_expenses.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "phase3_sync_tracking",
            sql: include_str!("../migrations/0006_sync_tracking.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "time_tracking",
            sql: include_str!("../migrations/0007_time_tracking.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:mep-finance.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![restore_database, fetch_cbe_rates])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
