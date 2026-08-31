use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use sqlx::Row;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use tauri_plugin_sql::{Migration, MigrationKind};

const DATABASE_KEY: &str = "sqlite:mep-finance.db";

#[derive(Default)]
struct LockThrottle {
    state: std::sync::Mutex<LockThrottleState>,
}

#[derive(Default)]
struct LockThrottleState {
    failures: u32,
    retry_at: Option<std::time::Instant>,
}

async fn application_database_pool(db_instances: &DbInstances) -> Result<sqlx::SqlitePool, String> {
    let instances = db_instances.0.read().await;
    match instances.get(DATABASE_KEY) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("APP_DATABASE_UNAVAILABLE: database is not loaded".into()),
    }
}

async fn read_lock_credentials(
    pool: &sqlx::SqlitePool,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    sqlx::query_as(
        "SELECT (SELECT NULLIF(value,'') FROM settings WHERE key='app_lock_credential'),
                (SELECT NULLIF(value,'') FROM settings WHERE key='app_lock_hash'),
                (SELECT NULLIF(value,'') FROM settings WHERE key='app_lock_salt')",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| format!("LOCK_STATE_CORRUPT: {e}"))
}

fn make_argon2_credential(password: &str) -> Result<String, String> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "LOCK_KDF_FAILED".into())
}

fn verify_argon2(password: &str, encoded: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    PasswordHash::new(encoded).ok().is_some_and(|hash| {
        argon2::Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

fn verify_legacy_pbkdf2(password: &str, hash_hex: &str, salt_hex: &str) -> bool {
    use subtle::ConstantTimeEq;
    let Some(expected) = decode_hex(hash_hex) else {
        return false;
    };
    let Some(salt) = decode_hex(salt_hex) else {
        return false;
    };
    if expected.len() != 32 || salt.len() != 16 {
        return false;
    }
    let mut actual = [0_u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, 100_000, &mut actual);
    actual.as_slice().ct_eq(expected.as_slice()).into()
}

async fn record_lock_failure(pool: &sqlx::SqlitePool) {
    let _ = sqlx::query(
        "INSERT INTO audit_logs(user_id,device_id,action,entity_type,reason,source,application_version)
         VALUES((SELECT value FROM settings WHERE key='sync_user_id'),
                (SELECT value FROM settings WHERE key='device_id'),
                'LOCK_FAILURE','security','Invalid local unlock attempt','SECURITY',?)",
    )
    .bind(CURRENT_APP_VERSION)
    .execute(pool)
    .await;
}

fn enforce_lock_throttle(throttle: &LockThrottle) -> Result<(), String> {
    let state = throttle.state.lock().map_err(|_| "LOCK_THROTTLE_FAILED")?;
    if let Some(retry_at) = state.retry_at {
        if retry_at > std::time::Instant::now() {
            return Err(format!(
                "LOCK_RETRY_AFTER:{}",
                retry_at.duration_since(std::time::Instant::now()).as_secs() + 1
            ));
        }
    }
    Ok(())
}

fn note_lock_result(throttle: &LockThrottle, success: bool) -> Result<(), String> {
    let mut state = throttle.state.lock().map_err(|_| "LOCK_THROTTLE_FAILED")?;
    if success {
        *state = LockThrottleState::default();
    } else {
        state.failures = state.failures.saturating_add(1);
        let delay = 2_u64.pow(state.failures.min(5) - 1);
        state.retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(delay));
    }
    Ok(())
}

async fn app_lock_enabled_inner(pool: &sqlx::SqlitePool) -> Result<bool, String> {
    let (credential, legacy_hash, legacy_salt) = read_lock_credentials(pool).await?;
    match (credential, legacy_hash, legacy_salt) {
        (None, None, None) => Ok(false),
        (Some(value), _, _) if value.starts_with("$argon2id$") => Ok(true),
        (None, Some(_), Some(_)) => Ok(true),
        _ => Err("LOCK_STATE_CORRUPT".into()),
    }
}

#[tauri::command]
async fn app_lock_enabled(db_instances: State<'_, DbInstances>) -> Result<bool, String> {
    let pool = application_database_pool(&db_instances).await?;
    app_lock_enabled_inner(&pool).await
}

async fn verify_app_lock_inner(
    pool: &sqlx::SqlitePool,
    throttle: &LockThrottle,
    password: &str,
) -> Result<bool, String> {
    enforce_lock_throttle(throttle)?;
    let (credential, legacy_hash, legacy_salt) = read_lock_credentials(pool).await?;
    let legacy = credential.is_none() && legacy_hash.is_some() && legacy_salt.is_some();
    let valid = if let Some(encoded) = credential {
        verify_argon2(password, &encoded)
    } else if let (Some(hash), Some(salt)) = (legacy_hash, legacy_salt) {
        verify_legacy_pbkdf2(password, &hash, &salt)
    } else {
        false
    };
    note_lock_result(throttle, valid)?;
    if valid && legacy {
        let upgraded = make_argon2_credential(password)?;
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO settings(key,value) VALUES('app_lock_credential',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(upgraded).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        sqlx::query("UPDATE settings SET value='' WHERE key IN ('app_lock_hash','app_lock_salt')")
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO audit_logs(user_id,device_id,action,entity_type,reason,source,application_version)
             VALUES((SELECT value FROM settings WHERE key='sync_user_id'),
                    (SELECT value FROM settings WHERE key='device_id'),
                    'LOCK_MIGRATED','security','Legacy lock credential upgraded to Argon2id','SECURITY',?)",
        )
        .bind(CURRENT_APP_VERSION)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
    }
    if !valid {
        record_lock_failure(pool).await;
    }
    Ok(valid)
}

#[tauri::command]
async fn verify_app_lock(
    db_instances: State<'_, DbInstances>,
    throttle: State<'_, LockThrottle>,
    password: String,
) -> Result<bool, String> {
    let pool = application_database_pool(&db_instances).await?;
    verify_app_lock_inner(&pool, &throttle, &password).await
}

#[tauri::command]
async fn set_app_lock(
    db_instances: State<'_, DbInstances>,
    throttle: State<'_, LockThrottle>,
    password: String,
    current_password: Option<String>,
) -> Result<(), String> {
    if password.len() < 8 || password.len() > 1024 {
        return Err("LOCK_PASSWORD_LENGTH_INVALID".into());
    }
    let pool = application_database_pool(&db_instances).await?;
    let was_enabled = app_lock_enabled_inner(&pool).await?;
    if was_enabled {
        let current = current_password.ok_or("CURRENT_PASSWORD_REQUIRED")?;
        if !verify_app_lock_inner(&pool, &throttle, &current).await? {
            return Err("LOCK_PASSWORD_INVALID".into());
        }
    }
    let credential = make_argon2_credential(&password)?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO settings(key,value) VALUES('app_lock_credential',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(credential).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE settings SET value='' WHERE key IN ('app_lock_hash','app_lock_salt')")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO audit_logs(user_id,device_id,action,entity_type,reason,source,application_version)
         VALUES((SELECT value FROM settings WHERE key='sync_user_id'),
                (SELECT value FROM settings WHERE key='device_id'),?,'security',?,'SECURITY',?)",
    )
    .bind(if was_enabled { "LOCK_CHANGED" } else { "LOCK_ENABLED" })
    .bind(if was_enabled {
        "Local application lock credential changed"
    } else {
        "Local application lock enabled"
    })
    .bind(CURRENT_APP_VERSION)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn disable_app_lock(
    db_instances: State<'_, DbInstances>,
    throttle: State<'_, LockThrottle>,
    password: String,
) -> Result<(), String> {
    let pool = application_database_pool(&db_instances).await?;
    if !verify_app_lock_inner(&pool, &throttle, &password).await? {
        return Err("LOCK_PASSWORD_INVALID".into());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE settings SET value='' WHERE key IN ('app_lock_credential','app_lock_hash','app_lock_salt')")
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO audit_logs(user_id,device_id,action,entity_type,reason,source,application_version)
         VALUES((SELECT value FROM settings WHERE key='sync_user_id'),
                (SELECT value FROM settings WHERE key='device_id'),
                'LOCK_DISABLED','security','Local application lock disabled','SECURITY',?)",
    )
    .bind(CURRENT_APP_VERSION)
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaymentCommandInput {
    contract_id: i64,
    kind: String,
    number: String,
    date: String,
    amount_minor: i64,
    method: String,
    bank: Option<String>,
    reference: Option<String>,
    notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AllocationCommandInput {
    certificate_id: i64,
    amount_minor: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonPaymentCommandInput {
    assignment_id: i64,
    date: String,
    amount_minor: i64,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MilestoneDraftCommandInput {
    milestone_index: usize,
    number: String,
    date: String,
    description: String,
    gross_minor: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCommandInput {
    name: String,
    client_id: i64,
    country: Option<String>,
    city: Option<String>,
    manager: Option<String>,
    discipline: String,
    project_type: Option<String>,
    status: String,
    currency: String,
    fx_rate_micro: i64,
    start_date: Option<String>,
    end_date: Option<String>,
    progress_bp: i64,
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractCommandInput {
    project_id: i64,
    number: String,
    title: Option<String>,
    value_minor: i64,
    vat_bp: i64,
    retention_bp: i64,
    withholding_bp: i64,
    advance_minor: i64,
    advance_recovery_method: String,
    performance_bond_bp: i64,
    performance_bond_bank: Option<String>,
    performance_bond_expiry: Option<String>,
    payment_terms_days: i64,
    payment_terms_notes: Option<String>,
    valuation_mode: String,
    milestones: Option<String>,
    drawings: Option<String>,
    attachments: Option<String>,
    signed_date: Option<String>,
    notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionMetadataCommandInput {
    effective_date: String,
    reason: String,
}

fn validate_contract_input(input: &ContractCommandInput) -> Result<(), String> {
    if input.number.trim().is_empty()
        || input.value_minor < 0
        || input.advance_minor < 0
        || input.advance_minor > input.value_minor
        || !(0..=10_000).contains(&input.vat_bp)
        || !(0..=10_000).contains(&input.retention_bp)
        || !(0..=10_000).contains(&input.withholding_bp)
        || !(0..=3_650).contains(&input.payment_terms_days)
    {
        return Err("invalid contract terms".into());
    }
    Ok(())
}

async fn begin_immediate(
    pool: &sqlx::SqlitePool,
) -> Result<sqlx::Transaction<'_, sqlx::Sqlite>, String> {
    pool.begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SyncTableRisk {
    SimpleMasterData,
    FinanciallyProtectedData,
    ImmutableOrEventEvidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SyncTablePolicy {
    table: &'static str,
    risk: SyncTableRisk,
}

const SYNC_TABLE_POLICIES: &[SyncTablePolicy] = &[
    SyncTablePolicy {
        table: "clients",
        risk: SyncTableRisk::SimpleMasterData,
    },
    SyncTablePolicy {
        table: "people",
        risk: SyncTableRisk::FinanciallyProtectedData,
    },
    SyncTablePolicy {
        table: "expense_categories",
        risk: SyncTableRisk::SimpleMasterData,
    },
    SyncTablePolicy {
        table: "projects",
        risk: SyncTableRisk::FinanciallyProtectedData,
    },
    SyncTablePolicy {
        table: "contracts",
        risk: SyncTableRisk::FinanciallyProtectedData,
    },
    SyncTablePolicy {
        table: "project_stages",
        risk: SyncTableRisk::SimpleMasterData,
    },
    SyncTablePolicy {
        table: "contract_revisions",
        risk: SyncTableRisk::ImmutableOrEventEvidence,
    },
    SyncTablePolicy {
        table: "variation_orders",
        risk: SyncTableRisk::ImmutableOrEventEvidence,
    },
    SyncTablePolicy {
        table: "documents",
        risk: SyncTableRisk::SimpleMasterData,
    },
    SyncTablePolicy {
        table: "time_entries",
        risk: SyncTableRisk::SimpleMasterData,
    },
    SyncTablePolicy {
        table: "project_assignments",
        risk: SyncTableRisk::FinanciallyProtectedData,
    },
    SyncTablePolicy {
        table: "payment_certificates",
        risk: SyncTableRisk::ImmutableOrEventEvidence,
    },
    SyncTablePolicy {
        table: "payments",
        risk: SyncTableRisk::ImmutableOrEventEvidence,
    },
    SyncTablePolicy {
        table: "payment_certificate_allocations",
        risk: SyncTableRisk::ImmutableOrEventEvidence,
    },
    SyncTablePolicy {
        table: "person_payments",
        risk: SyncTableRisk::ImmutableOrEventEvidence,
    },
    SyncTablePolicy {
        table: "expenses",
        risk: SyncTableRisk::FinanciallyProtectedData,
    },
    SyncTablePolicy {
        table: "recurring_expenses",
        risk: SyncTableRisk::FinanciallyProtectedData,
    },
];

fn sync_table_policy(table: &str) -> Option<&'static SyncTablePolicy> {
    SYNC_TABLE_POLICIES
        .iter()
        .find(|policy| policy.table == table)
}

fn validate_sync_mutation_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty()
        || trimmed.contains(';')
        || trimmed.contains("--")
        || trimmed.contains("/*")
    {
        return Err("SYNC_MUTATION_SQL_DENIED".into());
    }
    let tokens = trimmed.split_whitespace().collect::<Vec<_>>();
    let table = match tokens.as_slice() {
        [verb, table, ..] if verb.eq_ignore_ascii_case("UPDATE") => *table,
        [verb, into, table, ..]
            if verb.eq_ignore_ascii_case("INSERT") && into.eq_ignore_ascii_case("INTO") =>
        {
            *table
        }
        [verb, from, table, ..]
            if verb.eq_ignore_ascii_case("DELETE") && from.eq_ignore_ascii_case("FROM") =>
        {
            *table
        }
        _ => return Err("SYNC_MUTATION_SQL_DENIED".into()),
    };
    let table = table.split('(').next().unwrap_or(table);
    if !table
        .chars()
        .all(|character| character.is_ascii_lowercase() || character == '_')
        || sync_table_policy(table).is_none()
    {
        return Err("SYNC_MUTATION_TABLE_DENIED".into());
    }
    Ok(())
}

fn bind_json_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: JsonValue,
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, String> {
    match value {
        JsonValue::Null => Ok(query.bind(Option::<String>::None)),
        JsonValue::Bool(value) => Ok(query.bind(i64::from(value))),
        JsonValue::String(value) => Ok(query.bind(value)),
        JsonValue::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(query.bind(value))
            } else if let Some(value) = value.as_u64() {
                let value = i64::try_from(value).map_err(|_| "SYNC_INTEGER_OVERFLOW")?;
                Ok(query.bind(value))
            } else {
                // Every numeric field in the sync schema is an integer
                // (money minor units, basis points, ids, counts, or flags).
                // Reject decimal JSON instead of ever routing money through
                // floating point.
                Err("SYNC_NON_INTEGER_NUMBER_DENIED".into())
            }
        }
        JsonValue::Array(_) | JsonValue::Object(_) => Err("SYNC_PARAMETER_TYPE_DENIED".into()),
    }
}

async fn execute_sync_mutation_transaction(
    pool: &sqlx::SqlitePool,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<(), String> {
    validate_sync_mutation_sql(sql)?;
    let mut tx = begin_immediate(pool).await?;
    sqlx::query("UPDATE audit_context SET source='SYNC' WHERE id=1")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let mut query = sqlx::query(sql);
    for value in params {
        query = bind_json_value(query, value)?;
    }
    query.execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE audit_context SET source='DESKTOP' WHERE id=1")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

/// Apply one pulled row and its audit source marker on the same SQLx
/// connection. This prevents both writer-lock leaks and SYNC attribution from
/// bleeding into a concurrent local edit.
#[tauri::command]
async fn execute_sync_mutation_atomic(
    db_instances: State<'_, DbInstances>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<(), String> {
    let pool = application_database_pool(&db_instances).await?;
    execute_sync_mutation_transaction(&pool, &sql, params).await
}

fn validate_payment_input(
    input: &PaymentCommandInput,
    allocations: &[AllocationCommandInput],
) -> Result<(), String> {
    if input.amount_minor <= 0 || input.number.trim().is_empty() || input.date.trim().is_empty() {
        return Err("invalid payment evidence".into());
    }
    if !matches!(
        input.kind.as_str(),
        "CERTIFICATE" | "ADVANCE" | "RETENTION_RELEASE"
    ) || !matches!(input.method.as_str(), "BANK_TRANSFER" | "CHEQUE" | "CASH")
    {
        return Err("invalid payment type".into());
    }
    if input.kind != "CERTIFICATE" && !allocations.is_empty() {
        return Err("only certificate payments can have allocations".into());
    }
    let mut ids = std::collections::HashSet::new();
    let allocated = allocations.iter().try_fold(0_i64, |total, item| {
        if item.amount_minor <= 0 {
            return Err("allocation must be positive".to_string());
        }
        if !ids.insert(item.certificate_id) {
            return Err("duplicate certificate allocation".to_string());
        }
        total
            .checked_add(item.amount_minor)
            .ok_or_else(|| "allocation overflow".to_string())
    })?;
    if allocated > input.amount_minor {
        return Err("allocations exceed payment amount".into());
    }
    Ok(())
}

/// Rounded `amount x numerator / denominator`, half away from zero.
///
/// The sign is stripped before rounding and reapplied afterwards, which is what
/// `mulDivRound` in @mep/core does. Rounding the SIGNED value instead is not the
/// same operation: Rust's integer division truncates toward zero, so
/// `(p*2 + d) / (d*2)` rounds negatives the wrong way and lands one minor unit
/// high — −1400 became −1399 for a 14% VAT line. Nothing reaches this with a
/// negative amount today (a certificate's base cannot go below zero: SQLite
/// CHECKs keep `discount_minor <= gross_minor` and every rate in `0..=10000`),
/// so the divergence was latent — but the two engines are meant to be the same
/// function, and a future credit note or reversal would have split them
/// silently.
fn mul_div_round_i64(amount: i64, numerator: i64, denominator: i64) -> Result<i64, String> {
    if denominator <= 0 {
        return Err("invalid financial calculation denominator".into());
    }
    let product = i128::from(amount)
        .checked_mul(i128::from(numerator))
        .ok_or_else(|| "financial calculation overflow".to_string())?;
    let negative = product < 0;
    let magnitude = product
        .checked_abs()
        .ok_or("financial calculation overflow")?;
    let doubled = magnitude
        .checked_mul(2)
        .and_then(|value| value.checked_add(i128::from(denominator)))
        .ok_or_else(|| "financial calculation overflow".to_string())?;
    let divisor = i128::from(denominator)
        .checked_mul(2)
        .ok_or_else(|| "financial calculation overflow".to_string())?;
    let rounded = doubled / divisor;
    let signed = if negative { -rounded } else { rounded };
    i64::try_from(signed).map_err(|_| "financial calculation overflow".to_string())
}

/// One certificate's derived payable position, computed from source records
/// only. `net_payable_minor` mirrors `computeCertificate` in @mep/core: base
/// (gross − discount), VAT, retention and withholding applied to that base,
/// less advance recovery capped at the un-recovered remainder.
struct CertificatePayable {
    id: i64,
    status: String,
    net_payable_minor: i64,
    /// Gross less discount: what this certificate actually claims. Decides
    /// whether a zero net payable means "nothing certified" or "fully offset".
    certified_base_minor: i64,
}

/// Net payable for one certificate, and the advance it recovers.
///
/// Pure counterpart of `computeCertificate` in @mep/core:
///   base        = gross - discount
///   VAT         = base x vatBp
///   retention   = base x retentionBp
///   withholding = base x withholdingBp
///   advance     = PROPORTIONAL: base x advance / contractValue, else the
///                 manual figure, both capped at the un-recovered remainder
///   net payable = base + VAT - retention - advance - withholding
///
/// Returns (net payable, advance recovered, certified base). The base is
/// returned rather than recomputed by callers so the settlement rule and the
/// payable cannot disagree about what was certified.
///
/// Kept free of I/O so `fixtures/certificate-financials.json` can assert it
/// against the TypeScript engine.
#[allow(clippy::too_many_arguments)]
fn certificate_net_payable(
    gross_minor: i64,
    discount_minor: i64,
    vat_bp: i64,
    retention_bp: i64,
    withholding_bp: i64,
    advance_minor: i64,
    advance_method: &str,
    manual_recovery_minor: Option<i64>,
    contract_value_minor: i64,
    recovered_before_minor: i64,
) -> Result<(i64, i64, i64), String> {
    let base = gross_minor
        .checked_sub(discount_minor)
        .ok_or_else(|| "invalid certificate base".to_string())?;
    let vat = mul_div_round_i64(base, vat_bp, 10_000)?;
    let retention = mul_div_round_i64(base, retention_bp, 10_000)?;
    let withholding = mul_div_round_i64(base, withholding_bp, 10_000)?;
    let remaining_advance = advance_minor.saturating_sub(recovered_before_minor).max(0);
    let calculated_recovery = if advance_method == "MANUAL" {
        manual_recovery_minor.unwrap_or(0)
    } else if contract_value_minor <= 0 {
        0
    } else {
        mul_div_round_i64(base, advance_minor, contract_value_minor)?
    };
    let recovery = calculated_recovery.min(remaining_advance);
    let net_payable = base
        .checked_add(vat)
        .and_then(|v| v.checked_sub(retention))
        .and_then(|v| v.checked_sub(recovery))
        .and_then(|v| v.checked_sub(withholding))
        .ok_or_else(|| "certificate payable overflow".to_string())?;
    Ok((net_payable, recovery, base))
}

/// Load every live certificate of a contract with its net payable, in the
/// order the advance is recovered (`seq`, then `id`).
///
/// Advance recovery is cumulative across *billable* certificates, so a single
/// certificate's payable cannot be computed in isolation — the whole contract
/// is walked in sequence. Drafts are carried in the result (callers need to
/// reject allocations against them) but never consume advance, matching
/// `isBillable` on the TypeScript side.
///
/// The selection matches the TypeScript read model exactly, including the
/// archived contract and project joins. It used to filter only the
/// certificate's own flags, so the two engines could disagree about which
/// certificates belong to a contract — the read model dropped an archived
/// project's certificates while reconciliation still walked them, and any
/// figure derived from both would have been computed over different rows.
async fn load_contract_payables(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    contract_id: i64,
) -> Result<Vec<CertificatePayable>, String> {
    let rows = sqlx::query(
        "SELECT pc.id,pc.status,pc.gross_minor,pc.discount_minor,pc.manual_advance_recovery_minor,
                COALESCE(pc.contract_value_minor_snapshot,c.value_minor) contract_value_minor,
                COALESCE(pc.vat_bp_snapshot,c.vat_bp) vat_bp,
                COALESCE(pc.retention_bp_snapshot,c.retention_bp) retention_bp,
                COALESCE(pc.withholding_bp_snapshot,c.withholding_bp) withholding_bp,
                COALESCE(pc.advance_minor_snapshot,c.advance_minor) advance_minor,
                COALESCE(pc.advance_method_snapshot,c.advance_recovery_method) advance_method
         FROM payment_certificates pc JOIN contracts c ON c.id=pc.contract_id
                                      JOIN projects p ON p.id=c.project_id
         WHERE pc.contract_id=? AND pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
           AND c.archived_at IS NULL AND p.archived_at IS NULL
         ORDER BY pc.seq,pc.id",
    )
    .bind(contract_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    let mut payables = Vec::with_capacity(rows.len());
    let mut recovered_advance = 0_i64;
    for row in rows {
        let id: i64 = row.try_get("id").map_err(|e| e.to_string())?;
        let status: String = row.try_get("status").map_err(|e| e.to_string())?;
        if status == "DRAFT" {
            // A draft owes nothing and consumes no advance, but it still HAS a
            // certified base: `computeTeamPayout` weights a payout stage by
            // every certificate's base, drafts included. Zeroing it here would
            // give the two engines different stage weights on any contract
            // holding a draft.
            let gross: i64 = row.try_get("gross_minor").map_err(|e| e.to_string())?;
            let discount: i64 = row.try_get("discount_minor").map_err(|e| e.to_string())?;
            payables.push(CertificatePayable {
                id,
                status,
                net_payable_minor: 0,
                certified_base_minor: gross.saturating_sub(discount),
            });
            continue;
        }
        let method: String = row.try_get("advance_method").map_err(|e| e.to_string())?;
        let (net_payable_minor, recovery, certified_base_minor) = certificate_net_payable(
            row.try_get("gross_minor").map_err(|e| e.to_string())?,
            row.try_get("discount_minor").map_err(|e| e.to_string())?,
            row.try_get("vat_bp").map_err(|e| e.to_string())?,
            row.try_get("retention_bp").map_err(|e| e.to_string())?,
            row.try_get("withholding_bp").map_err(|e| e.to_string())?,
            row.try_get("advance_minor").map_err(|e| e.to_string())?,
            &method,
            row.try_get("manual_advance_recovery_minor")
                .map_err(|e| e.to_string())?,
            row.try_get("contract_value_minor")
                .map_err(|e| e.to_string())?,
            recovered_advance,
        )?;
        recovered_advance = recovered_advance
            .checked_add(recovery)
            .ok_or_else(|| "advance recovery overflow".to_string())?;
        payables.push(CertificatePayable {
            id,
            status,
            net_payable_minor,
            certified_base_minor,
        });
    }
    Ok(payables)
}

/// Allocations against a certificate that count as collected: rows belonging to
/// payments that are still live. A voided or soft-deleted payment is not
/// evidence, so its allocations never hold a certificate at PAID.
async fn valid_allocated_minor(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    certificate_id: i64,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(a.amount_minor),0) FROM payment_certificate_allocations a
         JOIN payments p ON p.id=a.payment_id
         WHERE a.certificate_id=? AND p.kind='CERTIFICATE'
           AND p.deleted_at IS NULL AND p.voided_at IS NULL",
    )
    .bind(certificate_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())
}

/// The collection-status rule, identical to `desiredCertificateStatus` in
/// @mep/core. Collection settles an approved claim; it never advances the
/// approval workflow, so SUBMITTED is returned untouched however much cash has
/// arrived. Drafts are never reconciliation targets.
fn derive_certificate_status(
    current: &str,
    net_payable_minor: i64,
    allocated_minor: i64,
    certified_base_minor: i64,
) -> String {
    if current == "DRAFT" || current == "SUBMITTED" {
        return current.to_string();
    }
    if is_fully_collected(net_payable_minor, allocated_minor, certified_base_minor) {
        return "PAID".to_string();
    }
    if current == "PAID" {
        return "APPROVED".to_string();
    }
    current.to_string()
}

/// Whether there is nothing left for the client to pay on this certificate.
///
/// The obvious half is `allocated >= net_payable`. The subtle half is what a
/// net payable of zero means, and it depends on whether anything was certified:
///
///  - Base zero. Nothing has been claimed — an empty or placeholder
///    certificate. There is nothing to settle, so it is left where it is.
///  - Base positive, net payable zero. Real certified work whose payable has
///    been fully consumed by advance recovery, retention and withholding. The
///    client owes nothing and never will, so the claim is closed. Ordinary on a
///    contract with a large or full advance, where every certificate can net to
///    zero; requiring `net_payable > 0` left those permanently APPROVED.
///
/// A negative net payable is treated the same as zero: nothing is collectible.
fn is_fully_collected(
    net_payable_minor: i64,
    allocated_minor: i64,
    certified_base_minor: i64,
) -> bool {
    if net_payable_minor > 0 {
        return allocated_minor >= net_payable_minor;
    }
    certified_base_minor > 0
}

/// Recalculate collection status for the given certificates from payment
/// evidence, inside the caller's transaction.
///
/// This is the only path that writes a payment-driven certificate status. The
/// frontend supplies certificate *identities* to reconcile — never a status —
/// so a stale or manipulated client cannot assert that a certificate is paid.
/// An empty list reconciles every live certificate, which is what a sync pull
/// or bulk import needs.
async fn reconcile_certificates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    certificate_ids: &[i64],
) -> Result<usize, String> {
    let contract_rows = if certificate_ids.is_empty() {
        sqlx::query(
            "SELECT DISTINCT pc.contract_id FROM payment_certificates pc
             JOIN contracts c ON c.id=pc.contract_id
             JOIN projects p ON p.id=c.project_id
             WHERE pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
               AND c.archived_at IS NULL AND p.archived_at IS NULL",
        )
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
    } else {
        let placeholders = vec!["?"; certificate_ids.len()].join(",");
        let sql = format!(
            "SELECT DISTINCT pc.contract_id FROM payment_certificates pc
             JOIN contracts c ON c.id=pc.contract_id
             JOIN projects p ON p.id=c.project_id
             WHERE pc.id IN ({placeholders}) AND pc.deleted_at IS NULL AND pc.voided_at IS NULL
               AND pc.archived_at IS NULL AND c.archived_at IS NULL AND p.archived_at IS NULL"
        );
        let mut query = sqlx::query(&sql);
        for id in certificate_ids {
            query = query.bind(id);
        }
        query
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
    };

    let targeted: Option<std::collections::HashSet<i64>> = if certificate_ids.is_empty() {
        None
    } else {
        Some(certificate_ids.iter().copied().collect())
    };

    let mut changed = 0_usize;
    for contract_row in contract_rows {
        let contract_id: i64 = contract_row
            .try_get("contract_id")
            .map_err(|e| e.to_string())?;
        // Walking the whole contract keeps advance recovery cumulative even
        // when only one of its certificates was targeted.
        for payable in load_contract_payables(tx, contract_id).await? {
            if payable.status == "DRAFT" {
                continue;
            }
            if let Some(wanted) = &targeted {
                if !wanted.contains(&payable.id) {
                    continue;
                }
            }
            let allocated = valid_allocated_minor(tx, payable.id).await?;
            let desired = derive_certificate_status(
                &payable.status,
                payable.net_payable_minor,
                allocated,
                payable.certified_base_minor,
            );
            if desired == payable.status {
                continue;
            }
            sqlx::query(
                "UPDATE payment_certificates SET status=? WHERE id=? AND deleted_at IS NULL",
            )
            .bind(&desired)
            .bind(payable.id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Certificate ids an existing payment currently allocates to.
async fn allocated_certificate_ids(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    payment_id: i64,
) -> Result<Vec<i64>, String> {
    let rows = sqlx::query(
        "SELECT DISTINCT certificate_id FROM payment_certificate_allocations WHERE payment_id=?",
    )
    .bind(payment_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| row.try_get("certificate_id").map_err(|e| e.to_string()))
        .collect()
}

async fn validate_allocation_capacities(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    contract_id: i64,
    allocations: &[AllocationCommandInput],
    excluding_payment_id: Option<i64>,
) -> Result<(), String> {
    if allocations.is_empty() {
        return Ok(());
    }
    let requested: std::collections::HashMap<i64, i64> = allocations
        .iter()
        .map(|allocation| (allocation.certificate_id, allocation.amount_minor))
        .collect();
    let payables = load_contract_payables(tx, contract_id).await?;
    let mut found = std::collections::HashSet::new();
    for payable in payables {
        if payable.status == "DRAFT" {
            if requested.contains_key(&payable.id) {
                return Err("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE".into());
            }
            continue;
        }
        if let Some(requested_amount) = requested.get(&payable.id) {
            found.insert(payable.id);
            let allocated: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(a.amount_minor),0) FROM payment_certificate_allocations a
                 JOIN payments p ON p.id=a.payment_id
                 WHERE a.certificate_id=? AND p.kind='CERTIFICATE'
                   AND p.deleted_at IS NULL AND p.voided_at IS NULL
                   AND (? IS NULL OR p.id<>?)",
            )
            .bind(payable.id)
            .bind(excluding_payment_id)
            .bind(excluding_payment_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            let capacity = payable.net_payable_minor.saturating_sub(allocated).max(0);
            if *requested_amount > capacity {
                return Err("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID".into());
            }
        }
    }
    if found.len() != requested.len() {
        return Err("CERTIFICATE_NOT_FOUND_OR_CONTRACT_MISMATCH".into());
    }
    Ok(())
}

async fn insert_payment_transaction(
    pool: &sqlx::SqlitePool,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
) -> Result<i64, String> {
    let mut tx = begin_immediate(pool).await?;
    validate_allocation_capacities(&mut tx, input.contract_id, &allocations, None).await?;
    let result = sqlx::query(
        "INSERT INTO payments (contract_id, kind, number, date, amount_minor, method, bank, reference, notes) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(input.contract_id).bind(input.kind).bind(input.number).bind(input.date)
    .bind(input.amount_minor).bind(input.method).bind(input.bank).bind(input.reference).bind(input.notes)
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    let payment_id = result.last_insert_rowid();
    let mut touched: Vec<i64> = Vec::new();
    for allocation in allocations {
        let certificate = sqlx::query(
            "SELECT contract_id FROM payment_certificates WHERE id=? AND deleted_at IS NULL",
        )
        .bind(allocation.certificate_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let contract_id: i64 = certificate
            .ok_or_else(|| "certificate not found".to_string())?
            .try_get("contract_id")
            .map_err(|e| e.to_string())?;
        if contract_id != input.contract_id {
            return Err("allocation certificate belongs to another contract".into());
        }
        sqlx::query("INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES (?,?,?)")
            .bind(payment_id).bind(allocation.certificate_id).bind(allocation.amount_minor)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        touched.push(allocation.certificate_id);
    }
    // Status follows the evidence just written, derived here inside the same
    // transaction rather than accepted from the caller.
    reconcile_certificates(&mut tx, &touched).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(payment_id)
}

async fn replace_payment_transaction(
    pool: &sqlx::SqlitePool,
    payment_id: i64,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
) -> Result<(), String> {
    let mut tx = begin_immediate(pool).await?;
    let legacy_duplicates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payment_certificate_allocations WHERE payment_id=? AND integrity_exception=1",
    )
    .bind(payment_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if legacy_duplicates > 0 {
        return Err("LEGACY_DUPLICATE_ALLOCATIONS_REQUIRE_REVIEW".into());
    }
    validate_allocation_capacities(&mut tx, input.contract_id, &allocations, Some(payment_id))
        .await?;
    // Captured before the rows are deleted: a certificate dropped from this
    // payment must still be reconciled so it reopens.
    let mut touched = allocated_certificate_ids(&mut tx, payment_id).await?;
    let mut new_ids: Vec<i64> = Vec::new();
    sqlx::query("DELETE FROM payment_certificate_allocations WHERE payment_id=?")
        .bind(payment_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let updated = sqlx::query(
        "UPDATE payments SET kind=?, number=?, date=?, amount_minor=?, method=?, bank=?, reference=?, notes=? WHERE id=? AND contract_id=? AND deleted_at IS NULL",
    )
    .bind(&input.kind).bind(&input.number).bind(&input.date).bind(input.amount_minor)
    .bind(&input.method).bind(&input.bank).bind(&input.reference).bind(&input.notes).bind(payment_id).bind(input.contract_id)
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("payment not found".into());
    }
    for allocation in allocations {
        let certificate = sqlx::query(
            "SELECT contract_id FROM payment_certificates WHERE id=? AND deleted_at IS NULL",
        )
        .bind(allocation.certificate_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let contract_id: i64 = certificate
            .ok_or_else(|| "certificate not found".to_string())?
            .try_get("contract_id")
            .map_err(|e| e.to_string())?;
        if contract_id != input.contract_id {
            return Err("allocation certificate belongs to another contract".into());
        }
        sqlx::query("INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES (?,?,?)")
            .bind(payment_id).bind(allocation.certificate_id).bind(allocation.amount_minor)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        new_ids.push(allocation.certificate_id);
    }
    // Reconcile the union of the certificates this payment used to settle and
    // the ones it settles now, so a reallocation reopens the old certificate.
    touched.extend(new_ids);
    touched.sort_unstable();
    touched.dedup();
    reconcile_certificates(&mut tx, &touched).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert a payment and every allocation as one all-or-nothing operation.
#[tauri::command]
async fn create_payment_atomic(
    db_instances: State<'_, DbInstances>,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
) -> Result<i64, String> {
    validate_payment_input(&input, &allocations)?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    insert_payment_transaction(pool, input, allocations).await
}

/// Replace payment evidence and allocations as one all-or-nothing operation.
#[tauri::command]
async fn update_payment_atomic(
    db_instances: State<'_, DbInstances>,
    payment_id: i64,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
) -> Result<(), String> {
    validate_payment_input(&input, &allocations)?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    replace_payment_transaction(pool, payment_id, input, allocations).await
}

#[tauri::command]
async fn void_payment_atomic(
    db_instances: State<'_, DbInstances>,
    payment_id: i64,
    reason: Option<String>,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let void_reason = reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| "Voided by user".to_string());
    let mut tx = begin_immediate(pool).await?;
    // Captured before voiding: once the payment is not live its allocations no
    // longer count as evidence, and the certificates it settled must reopen.
    let touched = allocated_certificate_ids(&mut tx, payment_id).await?;
    let result = sqlx::query(
        // `deleted_at IS NULL` as well as `voided_at IS NULL`: a payment that
        // is already out of the ledger is not evidence, so voiding it would
        // stamp a void reason and a fresh void date onto a record that was
        // retired earlier — rewriting when the money left the books.
        "UPDATE payments SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason=? WHERE id=? AND voided_at IS NULL AND deleted_at IS NULL",
    )
    .bind(&void_reason)
    .bind(payment_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("payment not found or already voided".into());
    }
    reconcile_certificates(&mut tx, &touched).await?;
    tx.commit().await.map_err(|e| e.to_string())
}

/// Recalculate payment-driven certificate statuses from stored evidence.
///
/// Takes certificate *identities* only — never a status — so a bulk import or
/// sync pull can ask for reconciliation without being able to assert an
/// outcome. An empty list reconciles every live certificate.
#[tauri::command]
async fn reconcile_certificates_atomic(
    db_instances: State<'_, DbInstances>,
    certificate_ids: Vec<i64>,
) -> Result<usize, String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let changed = reconcile_certificates(&mut tx, &certificate_ids).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(changed)
}

/// Financial and administrative fields of a certificate mutation. Money stays
/// in integer minor units; the derived contract-revision snapshot is bound
/// inside the transaction from the applicable approved revision, never trusted
/// from the caller.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertificateCommandInput {
    contract_id: i64,
    date: String,
    submission_date: Option<String>,
    due_date_override: Option<String>,
    #[serde(default)]
    due_date_confirmed: bool,
    description: Option<String>,
    gross_minor: i64,
    discount_minor: i64,
    manual_advance_recovery_minor: Option<i64>,
    status: String,
}

/// The stored lifecycle-relevant columns of one certificate.
struct CertificateLifecycleRow {
    contract_id: i64,
    status: String,
    number: String,
    date: String,
    gross_minor: i64,
    discount_minor: i64,
    manual_advance_recovery_minor: Option<i64>,
}

async fn load_certificate_lifecycle(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    certificate_id: i64,
) -> Result<CertificateLifecycleRow, String> {
    let row = sqlx::query(
        "SELECT contract_id,status,number,date,gross_minor,discount_minor,manual_advance_recovery_minor
         FROM payment_certificates WHERE id=? AND deleted_at IS NULL AND voided_at IS NULL",
    )
    .bind(certificate_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "CERTIFICATE_NOT_FOUND".to_string())?;
    Ok(CertificateLifecycleRow {
        contract_id: row.try_get("contract_id").map_err(|e| e.to_string())?,
        status: row.try_get("status").map_err(|e| e.to_string())?,
        number: row.try_get("number").map_err(|e| e.to_string())?,
        date: row.try_get("date").map_err(|e| e.to_string())?,
        gross_minor: row.try_get("gross_minor").map_err(|e| e.to_string())?,
        discount_minor: row.try_get("discount_minor").map_err(|e| e.to_string())?,
        manual_advance_recovery_minor: row
            .try_get("manual_advance_recovery_minor")
            .map_err(|e| e.to_string())?,
    })
}

/// Reject any write to a certificate whose contract — or whose contract's
/// project — is archived.
///
/// Every certificate read path (the listing, `load_contract_payables`,
/// `assert_contract_allocation_integrity`, reconciliation) excludes archived
/// contracts and projects, so a certificate written against one is invisible:
/// never listed, never reconciled, never covered by the allocation check.
/// Archived therefore has to mean read-only here, exactly as it already does
/// for payments; correcting an archived contract means restoring it first,
/// which is itself audited.
async fn assert_contract_writable(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    contract_id: i64,
) -> Result<(), String> {
    let row = sqlx::query(
        "SELECT c.archived_at AS contract_archived_at, p.archived_at AS project_archived_at
         FROM contracts c JOIN projects p ON p.id=c.project_id WHERE c.id=?",
    )
    .bind(contract_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "CONTRACT_NOT_FOUND".to_string())?;
    let contract_archived: Option<String> = row
        .try_get("contract_archived_at")
        .map_err(|e| e.to_string())?;
    let project_archived: Option<String> = row
        .try_get("project_archived_at")
        .map_err(|e| e.to_string())?;
    if contract_archived.is_some() || project_archived.is_some() {
        return Err("ARCHIVED_CONTRACT_IS_READ_ONLY".into());
    }
    Ok(())
}

/// The financial terms of a certificate, off which lifecycle immutability is
/// judged. The revision snapshot is a function of `date`, so `date` is a
/// financial field: changing it can rebind VAT/retention/advance.
fn certificate_financials_changed(
    stored: &CertificateLifecycleRow,
    input: &CertificateCommandInput,
    input_number: &str,
) -> bool {
    stored.gross_minor != input.gross_minor
        || stored.discount_minor != input.discount_minor
        || stored.manual_advance_recovery_minor != input.manual_advance_recovery_minor
        || stored.date != input.date
        || stored.number != input_number
}

/// The live certificate ids of a contract, for a whole-contract reconcile.
///
/// Advance recovery is cumulative, so any certificate mutation can shift a
/// later certificate's payable; reconciling the entire contract — not only the
/// edited row — is what keeps statuses honest.
async fn contract_certificate_ids(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    contract_id: i64,
) -> Result<Vec<i64>, String> {
    let rows = sqlx::query(
        "SELECT id FROM payment_certificates
         WHERE contract_id=? AND deleted_at IS NULL AND voided_at IS NULL AND archived_at IS NULL
         ORDER BY seq,id",
    )
    .bind(contract_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| row.try_get("id").map_err(|e| e.to_string()))
        .collect()
}

/// Reject any state where a certificate's live allocations exceed its
/// recalculated payable capacity, or where a draft carries allocations.
///
/// Runs after a certificate mutation is applied but before commit, so reducing
/// an earlier certificate's payable — which lowers a later certificate's
/// cumulative advance-recovered payable — is rolled back atomically if it would
/// strand cash against a certificate that can no longer receive it.
async fn assert_contract_allocation_integrity(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    contract_id: i64,
) -> Result<(), String> {
    for payable in load_contract_payables(tx, contract_id).await? {
        let allocated = valid_allocated_minor(tx, payable.id).await?;
        if payable.status == "DRAFT" {
            if allocated > 0 {
                return Err("ALLOCATED_CERTIFICATE_CANNOT_BE_DRAFT".into());
            }
            continue;
        }
        let capacity = payable.net_payable_minor.max(0);
        if allocated > capacity {
            return Err("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID".into());
        }
    }
    Ok(())
}

/// Create a certificate, its contract-revision snapshot and its collection
/// status in one transaction. `seq` is reserved inside the transaction so
/// concurrent creation cannot duplicate it; the number is reserved beforehand
/// through `reserve_next_number_atomic`.
#[tauri::command]
async fn create_certificate_atomic(
    db_instances: State<'_, DbInstances>,
    number: String,
    input: CertificateCommandInput,
) -> Result<i64, String> {
    if input.status == "PAID" {
        return Err("PAID_REQUIRES_PAYMENT".into());
    }
    if input.discount_minor < 0 || input.gross_minor < 0 || input.discount_minor > input.gross_minor
    {
        return Err("INVALID_CERTIFICATE_AMOUNTS".into());
    }
    if number.trim().is_empty() {
        return Err("CERTIFICATE_NUMBER_REQUIRED".into());
    }
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    assert_contract_writable(&mut tx, input.contract_id).await?;
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq),0)+1 FROM payment_certificates WHERE contract_id=? AND deleted_at IS NULL",
    )
    .bind(input.contract_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let inserted = sqlx::query(
        "INSERT INTO payment_certificates (contract_id, seq, number, date, submission_date, due_date_override, due_date_confirmed_at,
            description, gross_minor, discount_minor, manual_advance_recovery_minor, status,
            contract_revision_id, contract_value_minor_snapshot, vat_bp_snapshot, retention_bp_snapshot,
            withholding_bp_snapshot, advance_minor_snapshot, advance_method_snapshot, payment_terms_days_snapshot,
            currency_snapshot, fx_rate_micro_snapshot)
         SELECT ?,?,?,?,?,?,CASE WHEN ?=1 THEN datetime('now') END,?,?,?,?,?,
            r.id,r.contract_value_minor,r.vat_bp,r.retention_bp,r.withholding_bp,r.advance_minor,
            r.advance_recovery_method,r.payment_terms_days,r.currency,r.fx_rate_micro
         FROM contract_revisions r WHERE r.contract_id=? AND r.approved_at IS NOT NULL
           AND (r.effective_date <= ? OR r.revision_number=1)
         ORDER BY CASE WHEN r.effective_date <= ? THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1",
    )
    .bind(input.contract_id).bind(seq).bind(&number).bind(&input.date).bind(&input.submission_date)
    .bind(&input.due_date_override).bind(i64::from(input.due_date_confirmed)).bind(&input.description)
    .bind(input.gross_minor).bind(input.discount_minor).bind(input.manual_advance_recovery_minor).bind(&input.status)
    .bind(input.contract_id).bind(&input.date).bind(&input.date)
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if inserted.rows_affected() != 1 {
        return Err("NO_APPROVED_CONTRACT_REVISION".into());
    }
    let certificate_id = inserted.last_insert_rowid();
    assert_contract_allocation_integrity(&mut tx, input.contract_id).await?;
    let ids = contract_certificate_ids(&mut tx, input.contract_id).await?;
    reconcile_certificates(&mut tx, &ids).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(certificate_id)
}

/// Edit a certificate. DRAFT certificates may have every field edited and their
/// snapshot refreshed; SUBMITTED and APPROVED certificates accept only
/// non-financial administrative corrections; PAID certificates are immutable.
/// Status is never changed here — transitions go through
/// `transition_certificate_atomic` — so a caller cannot assert PAID.
#[tauri::command]
async fn update_certificate_atomic(
    db_instances: State<'_, DbInstances>,
    certificate_id: i64,
    number: String,
    input: CertificateCommandInput,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    update_certificate_transaction(pool, certificate_id, number, input).await
}

/// The edit itself, so the contract-identity and archived rules can be asserted
/// directly by `cargo test` rather than only through the command wrapper.
async fn update_certificate_transaction(
    pool: &sqlx::SqlitePool,
    certificate_id: i64,
    number: String,
    input: CertificateCommandInput,
) -> Result<(), String> {
    if input.status == "PAID" {
        return Err("PAID_REQUIRES_PAYMENT".into());
    }
    if input.discount_minor < 0 || input.gross_minor < 0 || input.discount_minor > input.gross_minor
    {
        return Err("INVALID_CERTIFICATE_AMOUNTS".into());
    }
    let mut tx = begin_immediate(pool).await?;
    let stored = load_certificate_lifecycle(&mut tx, certificate_id).await?;
    // The certificate is located by id, so a caller-supplied contract id that
    // disagrees with the stored one would otherwise bind a *foreign* contract's
    // approved revision — its VAT, retention, withholding, advance, payment
    // terms, currency and historical FX — onto this certificate while leaving
    // it filed under its own contract. The stored contract is the only truth.
    if input.contract_id != stored.contract_id {
        return Err("CERTIFICATE_CONTRACT_MISMATCH".into());
    }
    assert_contract_writable(&mut tx, stored.contract_id).await?;
    if stored.status == "PAID" {
        return Err("PAID_CERTIFICATE_IMMUTABLE".into());
    }
    if stored.status == "DRAFT" {
        // Full edit with a refreshed (or, on advance to SUBMITTED, frozen)
        // revision snapshot. A draft edit may carry the certificate forward to
        // SUBMITTED; APPROVED is reached only through a transition.
        if input.status != "DRAFT" && input.status != "SUBMITTED" {
            return Err("USE_TRANSITION_FOR_APPROVAL".into());
        }
        let updated = sqlx::query(
            "WITH chosen AS (
               SELECT r.* FROM contract_revisions r
               WHERE r.contract_id=? AND r.approved_at IS NOT NULL
                 AND (r.effective_date <= ? OR r.revision_number=1)
               ORDER BY CASE WHEN r.effective_date <= ? THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1
             )
             UPDATE payment_certificates SET number=?, date=?, submission_date=?, due_date_override=?,
               due_date_confirmed_at=CASE WHEN ?=1 THEN datetime('now') END,
               description=?, gross_minor=?, discount_minor=?, manual_advance_recovery_minor=?, status=?,
               contract_revision_id=(SELECT id FROM chosen), contract_value_minor_snapshot=(SELECT contract_value_minor FROM chosen),
               vat_bp_snapshot=(SELECT vat_bp FROM chosen), retention_bp_snapshot=(SELECT retention_bp FROM chosen),
               withholding_bp_snapshot=(SELECT withholding_bp FROM chosen), advance_minor_snapshot=(SELECT advance_minor FROM chosen),
               advance_method_snapshot=(SELECT advance_recovery_method FROM chosen), payment_terms_days_snapshot=(SELECT payment_terms_days FROM chosen),
               currency_snapshot=(SELECT currency FROM chosen), fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM chosen)
             WHERE id=? AND status='DRAFT' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM chosen)",
        )
        .bind(stored.contract_id).bind(&input.date).bind(&input.date)
        .bind(&number).bind(&input.date).bind(&input.submission_date).bind(&input.due_date_override)
        .bind(i64::from(input.due_date_confirmed)).bind(&input.description)
        .bind(input.gross_minor).bind(input.discount_minor).bind(input.manual_advance_recovery_minor).bind(&input.status)
        .bind(certificate_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("CERTIFICATE_REVISION_BIND_FAILED".into());
        }
    } else {
        // SUBMITTED or APPROVED: financial terms are frozen; only non-financial
        // administrative metadata may be corrected.
        if certificate_financials_changed(&stored, &input, &number) {
            return Err("CERTIFICATE_FINANCIALS_IMMUTABLE".into());
        }
        let updated = sqlx::query(
            "UPDATE payment_certificates SET submission_date=?, due_date_override=?,
               due_date_confirmed_at=CASE WHEN ?=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END,
               description=?
             WHERE id=? AND deleted_at IS NULL AND voided_at IS NULL",
        )
        .bind(&input.submission_date).bind(&input.due_date_override)
        .bind(i64::from(input.due_date_confirmed)).bind(&input.description).bind(certificate_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("CERTIFICATE_NOT_FOUND".into());
        }
    }
    assert_contract_allocation_integrity(&mut tx, stored.contract_id).await?;
    let ids = contract_certificate_ids(&mut tx, stored.contract_id).await?;
    reconcile_certificates(&mut tx, &ids).await?;
    tx.commit().await.map_err(|e| e.to_string())
}

/// Move a certificate between workflow states. PAID is never a target — it is
/// reached only by payment evidence through reconciliation — and a PAID
/// certificate cannot be manually downgraded. Advancing DRAFT→SUBMITTED freezes
/// the financial snapshot from the applicable approved revision.
#[tauri::command]
async fn transition_certificate_atomic(
    db_instances: State<'_, DbInstances>,
    certificate_id: i64,
    target_status: String,
    submission_date: Option<String>,
    due_date_confirmed: Option<bool>,
) -> Result<(), String> {
    if target_status == "PAID" {
        return Err("PAID_REQUIRES_PAYMENT".into());
    }
    if !["DRAFT", "SUBMITTED", "APPROVED"].contains(&target_status.as_str()) {
        return Err("INVALID_CERTIFICATE_STATUS".into());
    }
    let due_date_confirmed = due_date_confirmed.unwrap_or(false);
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let stored = load_certificate_lifecycle(&mut tx, certificate_id).await?;
    assert_contract_writable(&mut tx, stored.contract_id).await?;
    if stored.status == "PAID" {
        return Err("PAID_NO_MANUAL_DOWNGRADE".into());
    }
    if target_status == "DRAFT" {
        let allocated = valid_allocated_minor(&mut tx, certificate_id).await?;
        if allocated > 0 {
            return Err("ALLOCATED_CERTIFICATE_CANNOT_BE_DRAFT".into());
        }
    }
    if target_status == "SUBMITTED" && stored.status == "DRAFT" {
        // Freeze the financial snapshot as the certificate leaves DRAFT.
        let updated = sqlx::query(
            "WITH chosen AS (
               SELECT r.* FROM contract_revisions r JOIN payment_certificates pc ON pc.contract_id=r.contract_id
               WHERE pc.id=? AND r.approved_at IS NOT NULL AND (r.effective_date <= pc.date OR r.revision_number=1)
               ORDER BY CASE WHEN r.effective_date <= pc.date THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1
             )
             UPDATE payment_certificates SET status='SUBMITTED', submission_date=COALESCE(submission_date,?),
               due_date_confirmed_at=CASE WHEN ?=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END,
               contract_revision_id=(SELECT id FROM chosen), contract_value_minor_snapshot=(SELECT contract_value_minor FROM chosen),
               vat_bp_snapshot=(SELECT vat_bp FROM chosen), retention_bp_snapshot=(SELECT retention_bp FROM chosen),
               withholding_bp_snapshot=(SELECT withholding_bp FROM chosen), advance_minor_snapshot=(SELECT advance_minor FROM chosen),
               advance_method_snapshot=(SELECT advance_recovery_method FROM chosen), payment_terms_days_snapshot=(SELECT payment_terms_days FROM chosen),
               currency_snapshot=(SELECT currency FROM chosen), fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM chosen)
             WHERE id=? AND status='DRAFT' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM chosen)",
        )
        .bind(certificate_id).bind(&submission_date).bind(i64::from(due_date_confirmed)).bind(certificate_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("CERTIFICATE_REVISION_BIND_FAILED".into());
        }
    } else {
        let updated = sqlx::query(
            "UPDATE payment_certificates SET status=?, submission_date=COALESCE(submission_date,?),
               due_date_confirmed_at=CASE WHEN ?=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END
             WHERE id=? AND deleted_at IS NULL AND voided_at IS NULL",
        )
        .bind(&target_status).bind(&submission_date).bind(i64::from(due_date_confirmed)).bind(certificate_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("CERTIFICATE_NOT_FOUND".into());
        }
    }
    assert_contract_allocation_integrity(&mut tx, stored.contract_id).await?;
    let ids = contract_certificate_ids(&mut tx, stored.contract_id).await?;
    reconcile_certificates(&mut tx, &ids).await?;
    tx.commit().await.map_err(|e| e.to_string())
}

/// Void a certificate. A reason is required; a certificate that still carries
/// live allocations cannot be voided (void the payment first). Voiding removes
/// its advance consumption, so the whole contract is reconciled afterwards.
#[tauri::command]
async fn void_certificate_atomic(
    db_instances: State<'_, DbInstances>,
    certificate_id: i64,
    reason: Option<String>,
) -> Result<(), String> {
    let void_reason = reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .ok_or_else(|| "VOID_REASON_REQUIRED".to_string())?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let stored = load_certificate_lifecycle(&mut tx, certificate_id).await?;
    assert_contract_writable(&mut tx, stored.contract_id).await?;
    let allocated = valid_allocated_minor(&mut tx, certificate_id).await?;
    if allocated > 0 {
        return Err("ALLOCATED_CERTIFICATE_CANNOT_BE_VOIDED".into());
    }
    let updated = sqlx::query(
        "UPDATE payment_certificates SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason=?
         WHERE id=? AND voided_at IS NULL",
    )
    .bind(&void_reason)
    .bind(certificate_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("CERTIFICATE_NOT_FOUND_OR_VOIDED".into());
    }
    // Voiding removes this certificate's advance consumption, which can raise a
    // later certificate's recovered payable; if that would strand cash already
    // collected against one, the void is rejected atomically.
    assert_contract_allocation_integrity(&mut tx, stored.contract_id).await?;
    let ids = contract_certificate_ids(&mut tx, stored.contract_id).await?;
    reconcile_certificates(&mut tx, &ids).await?;
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_person_payment_atomic(
    db_instances: State<'_, DbInstances>,
    input: PersonPaymentCommandInput,
) -> Result<i64, String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    create_person_payment_transaction(pool, input).await
}

/// The payment itself, so the lifecycle and due-limit rules can be asserted
/// directly by `cargo test` rather than only through the command wrapper.
async fn create_person_payment_transaction(
    pool: &sqlx::SqlitePool,
    input: PersonPaymentCommandInput,
) -> Result<i64, String> {
    if input.amount_minor <= 0 || input.date.trim().is_empty() {
        return Err("invalid person payment".into());
    }
    let mut tx = begin_immediate(pool).await?;
    let twin: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM person_payments WHERE assignment_id=? AND date=? AND amount_minor=? AND note IS ? AND voided_at IS NULL LIMIT 1",
    ).bind(input.assignment_id).bind(&input.date).bind(input.amount_minor).bind(&input.note)
        .fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
    if twin.is_some() {
        return Err("DUPLICATE_PERSON_PAYMENT".into());
    }
    let context = sqlx::query(
        "SELECT a.project_id, a.currency, a.fx_rate_micro, a.agreed_minor, a.lifecycle_status,
                a.earned_minor_at_cancellation, a.archived_at, p.archived_at AS project_archived_at,
                pe.name AS person_name, pe.type AS person_type, pe.archived_at AS person_archived_at
         FROM project_assignments a
         JOIN people pe ON pe.id=a.person_id
         JOIN projects p ON p.id=a.project_id
         WHERE a.id=?",
    )
    .bind(input.assignment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "assignment not found".to_string())?;
    let project_id: i64 = context.try_get("project_id").map_err(|e| e.to_string())?;
    let currency: String = context.try_get("currency").map_err(|e| e.to_string())?;
    let fx_rate_micro: i64 = context
        .try_get("fx_rate_micro")
        .map_err(|e| e.to_string())?;
    let person_name: String = context.try_get("person_name").map_err(|e| e.to_string())?;
    let person_type: String = context.try_get("person_type").map_err(|e| e.to_string())?;

    // The payable ceiling is DERIVED here, never taken from the caller: the
    // WebView's figure is a display of the same rule, not evidence for it.
    // Mirrors `assignmentCostPosition` in @mep/core — a cancelled assignment
    // earns the frozen figure, so certificates the client pays afterwards can
    // no longer accrue to work that was called off.
    let assignment_archived_at: Option<String> =
        context.try_get("archived_at").map_err(|e| e.to_string())?;
    let project_archived_at: Option<String> = context
        .try_get("project_archived_at")
        .map_err(|e| e.to_string())?;
    let person_archived_at: Option<String> = context
        .try_get("person_archived_at")
        .map_err(|e| e.to_string())?;
    if assignment_archived_at.is_some()
        || project_archived_at.is_some()
        || person_archived_at.is_some()
    {
        // Archiving is visibility, but it also means the office has stopped
        // operating this record; a new payment is a new operational action.
        return Err("ARCHIVED_ASSIGNMENT_CANNOT_BE_PAID".into());
    }
    let agreed_minor: i64 = context.try_get("agreed_minor").map_err(|e| e.to_string())?;
    let lifecycle: String = context
        .try_get("lifecycle_status")
        .map_err(|e| e.to_string())?;
    let frozen_earned: Option<i64> = context
        .try_get("earned_minor_at_cancellation")
        .map_err(|e| e.to_string())?;
    let earned_minor = if lifecycle == "CANCELLED" {
        frozen_earned.unwrap_or(0).max(0)
    } else {
        assignment_released_minor(&mut tx, project_id, agreed_minor)
            .await?
            .max(0)
    };
    let paid_minor: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_minor),0) FROM person_payments WHERE assignment_id=? AND voided_at IS NULL",
    )
    .bind(input.assignment_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    // Floored at zero: an assignment already overpaid owes nothing further, and
    // must not turn a negative balance into fresh headroom.
    let due_minor = (earned_minor - paid_minor).max(0);
    if input.amount_minor > due_minor {
        return Err("PERSON_PAYMENT_EXCEEDS_DUE".into());
    }
    let category_name = if person_type == "EMPLOYEE" {
        "Salaries"
    } else {
        "Freelancers"
    };
    let category_id: i64 = sqlx::query_scalar(
        "SELECT id FROM expense_categories ORDER BY CASE WHEN name_en=? THEN 0 ELSE 1 END, sort_order, id LIMIT 1",
    ).bind(category_name).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "no expense category configured".to_string())?;
    let payment = sqlx::query(
        "INSERT INTO person_payments (assignment_id,date,amount_minor,note) VALUES (?,?,?,?)",
    )
    .bind(input.assignment_id)
    .bind(&input.date)
    .bind(input.amount_minor)
    .bind(&input.note)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let payment_id = payment.last_insert_rowid();
    let description = input
        .note
        .as_ref()
        .map(|n| format!("{person_name} — {n}"))
        .unwrap_or_else(|| person_name.clone());
    sqlx::query("INSERT INTO expenses (date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,person_payment_id) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&input.date).bind(category_id).bind(description).bind(project_id).bind(&person_name)
        .bind(input.amount_minor).bind(currency).bind(fx_rate_micro).bind(payment_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(payment_id)
}

/// Largest-remainder allocation, the counterpart of `allocate` in @mep/core.
///
/// Splits `total_minor` across `weights` so the parts sum to the total exactly.
/// Shares are floored, then the leftover units go to the largest remainders,
/// ties broken by index — the same order the TypeScript sort produces, which is
/// what makes the two engines agree unit for unit rather than approximately.
/// All-zero weights split evenly, matching `allocate`'s own fallback.
fn allocate_largest_remainder(total_minor: i64, weights: &[i64]) -> Result<Vec<i64>, String> {
    if weights.is_empty() {
        return Ok(Vec::new());
    }
    if weights.iter().any(|weight| *weight < 0) {
        return Err("allocation weights must be non-negative".into());
    }
    let mut weight_sum: i128 = weights.iter().map(|weight| i128::from(*weight)).sum();
    let effective: Vec<i128> = if weight_sum == 0 {
        weight_sum = weights.len() as i128;
        vec![1; weights.len()]
    } else {
        weights.iter().map(|weight| i128::from(*weight)).collect()
    };

    let total = i128::from(total_minor);
    let negative = total < 0;
    let magnitude = total.checked_abs().ok_or("allocation overflow")?;

    let mut shares: Vec<i128> = Vec::with_capacity(weights.len());
    let mut remainders: Vec<(usize, i128)> = Vec::with_capacity(weights.len());
    let mut allocated: i128 = 0;
    for (index, weight) in effective.iter().enumerate() {
        let exact = magnitude
            .checked_mul(*weight)
            .ok_or_else(|| "allocation overflow".to_string())?;
        let share = exact / weight_sum;
        shares.push(share);
        allocated += share;
        remainders.push((index, exact % weight_sum));
    }

    // Descending remainder, ascending index on a tie.
    remainders.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let mut leftover = magnitude - allocated;
    let mut cursor = 0usize;
    while leftover > 0 {
        shares[remainders[cursor].0] += 1;
        leftover -= 1;
        cursor = (cursor + 1) % remainders.len();
    }

    shares
        .into_iter()
        .map(|share| {
            i64::try_from(if negative { -share } else { share })
                .map_err(|_| "allocation overflow".to_string())
        })
        .collect()
}

/// Milestone amounts from a contract value, matching `milestoneAmounts`.
///
/// A plan totalling exactly 100% is allocated by largest remainder so the parts
/// sum to the contract value; a partial plan is a preview, each line taken
/// independently.
fn milestone_amounts(value_minor: i64, percents_bp: &[i64]) -> Result<Vec<i64>, String> {
    if percents_bp.is_empty() {
        return Ok(Vec::new());
    }
    let total: i128 = percents_bp.iter().map(|value| i128::from(*value)).sum();
    if total == 10_000 {
        return allocate_largest_remainder(value_minor, percents_bp);
    }
    percents_bp
        .iter()
        .map(|percent| mul_div_round_i64(value_minor, *percent, 10_000))
        .collect()
}

/// One stage of a person's payout schedule: how much of the contract it
/// represents, and the status of the certificate that releases it.
struct PayoutStage {
    weight_minor: i64,
    certificate_status: Option<String>,
}

/// Fee released to an assignment by client certificates paid so far.
///
/// The Rust counterpart of `computeTeamPayout(...).releasedMinor` in @mep/core.
/// Every person on a project follows the same payment stages as the project's
/// contracts: the agreed fee is split across those stages by the same value
/// shares, and a stage is released the moment its certificate is PAID.
///
/// This exists so `cancel_assignment_atomic` can DERIVE the figure it freezes
/// instead of trusting one computed in the WebView. The frozen figure decides
/// the assignment's committed cost and what is still owed, and migration 0004
/// makes it final once written — a caller-supplied value could bound-check as
/// plausible and still be wrong forever.
///
/// `fixtures/team-payout.json` is asserted by this and by the TypeScript engine,
/// because the two must not drift.
async fn assignment_released_minor(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    project_id: i64,
    agreed_minor: i64,
) -> Result<i64, String> {
    // Same boundary and order as the read model: live contracts of a live
    // project, ascending id.
    let contracts = sqlx::query(
        "SELECT c.id, c.value_minor, c.valuation_mode, c.milestones
         FROM contracts c JOIN projects p ON p.id=c.project_id
         WHERE c.project_id=? AND c.archived_at IS NULL AND p.archived_at IS NULL
         ORDER BY c.id",
    )
    .bind(project_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    let mut stages: Vec<PayoutStage> = Vec::new();
    for contract in contracts {
        let contract_id: i64 = contract.try_get("id").map_err(|e| e.to_string())?;
        let value_minor: i64 = contract.try_get("value_minor").map_err(|e| e.to_string())?;
        let valuation_mode: String = contract
            .try_get("valuation_mode")
            .map_err(|e| e.to_string())?;
        let milestones_json: Option<String> =
            contract.try_get("milestones").map_err(|e| e.to_string())?;

        let payables = load_contract_payables(tx, contract_id).await?;
        let status_by_id: std::collections::HashMap<i64, String> = payables
            .iter()
            .map(|payable| (payable.id, payable.status.clone()))
            .collect();

        let milestones = if valuation_mode == "MILESTONES" {
            parse_milestones(milestones_json.as_deref())?
        } else {
            Vec::new()
        };

        if !milestones.is_empty() {
            let percents: Vec<i64> = milestones.iter().map(|(percent, _)| *percent).collect();
            let amounts = milestone_amounts(value_minor, &percents)?;
            for (index, (_, certificate_id)) in milestones.iter().enumerate() {
                stages.push(PayoutStage {
                    weight_minor: amounts.get(index).copied().unwrap_or(0),
                    certificate_status: certificate_id
                        .and_then(|id| status_by_id.get(&id).cloned()),
                });
            }
        } else {
            let mut scheduled = 0_i64;
            for payable in &payables {
                stages.push(PayoutStage {
                    weight_minor: payable.certified_base_minor,
                    certificate_status: Some(payable.status.clone()),
                });
                scheduled = scheduled.saturating_add(payable.certified_base_minor);
            }
            // Contract value not yet certified is a single pending remainder.
            if value_minor > scheduled {
                stages.push(PayoutStage {
                    weight_minor: value_minor - scheduled,
                    certificate_status: None,
                });
            }
        }
    }

    let weights: Vec<i64> = stages.iter().map(|stage| stage.weight_minor).collect();
    let amounts = allocate_largest_remainder(agreed_minor, &weights)?;
    let mut released = 0_i64;
    for (index, stage) in stages.iter().enumerate() {
        if stage.certificate_status.as_deref() == Some("PAID") {
            released = released.saturating_add(amounts.get(index).copied().unwrap_or(0));
        }
    }
    Ok(released)
}

/// Milestones as (percentBp, certificateId), matching `parseMilestones`.
///
/// Malformed JSON is an error rather than an empty plan: silently treating a
/// corrupt milestone list as "no milestones" would fall through to the
/// certificate schedule and freeze a figure computed from the wrong stages.
fn parse_milestones(raw: Option<&str>) -> Result<Vec<(i64, Option<i64>)>, String> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Err("MILESTONES_INVALID_JSON".into());
    }
    let parsed: JsonValue =
        serde_json::from_str(raw).map_err(|_| "MILESTONES_INVALID_JSON".to_string())?;
    let items = parsed
        .as_array()
        .ok_or_else(|| "MILESTONES_INVALID_SHAPE".to_string())?;
    let mut milestones = Vec::with_capacity(items.len());
    for item in items {
        let object = item
            .as_object()
            .ok_or_else(|| "MILESTONES_INVALID_SHAPE".to_string())?;
        if !object.get("title").is_some_and(JsonValue::is_string) {
            return Err("MILESTONES_INVALID_SHAPE".into());
        }
        let percent = item
            .get("percentBp")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| "MILESTONES_INVALID_SHAPE".to_string())?;
        if !(0..=MAX_SAFE_INTEGER).contains(&percent) {
            return Err("MILESTONES_INVALID_SHAPE".into());
        }
        if let Some(stage_id) = object.get("stageId") {
            if !stage_id.is_null()
                && !stage_id
                    .as_i64()
                    .is_some_and(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER as u64)
            {
                return Err("MILESTONES_INVALID_SHAPE".into());
            }
        }
        if object.get("done").is_some_and(|done| !done.is_boolean()) {
            return Err("MILESTONES_INVALID_SHAPE".into());
        }
        let certificate_id = match object.get("certificateId") {
            None | Some(JsonValue::Null) => None,
            Some(value) => Some(
                value
                    .as_i64()
                    .filter(|id| id.unsigned_abs() <= MAX_SAFE_INTEGER as u64)
                    .ok_or_else(|| "MILESTONES_INVALID_SHAPE".to_string())?,
            ),
        };
        milestones.push((percent, certificate_id));
    }
    Ok(milestones)
}

/// Cancel an assignment and freeze its earned value as one operation.
///
/// The frozen figure decides the assignment's committed cost AND what is still
/// owed to the person, and migration 0004 makes it final once written — so the
/// write must not be separable from the check that it is allowed.
///
/// The figure is DERIVED here, not accepted from the caller. It used to arrive
/// as a command argument that Rust could only bound-check — a wrong value could
/// look plausible and still be frozen forever. `assignment_released_minor`
/// recomputes it from stored evidence inside this transaction, so the read that
/// decides it and the write that freezes it cannot be separated by a concurrent
/// payment or collection.
#[tauri::command]
async fn cancel_assignment_atomic(
    db_instances: State<'_, DbInstances>,
    assignment_id: i64,
    reason: String,
) -> Result<(), String> {
    let pool = application_database_pool(&db_instances).await?;
    cancel_assignment_transaction(&pool, assignment_id, &reason).await
}

async fn cancel_assignment_transaction(
    pool: &sqlx::SqlitePool,
    assignment_id: i64,
    reason: &str,
) -> Result<(), String> {
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        return Err("CANCELLATION_REASON_REQUIRED".into());
    }
    let mut tx = begin_immediate(pool).await?;
    let row = sqlx::query(
        "SELECT a.agreed_minor, a.lifecycle_status, a.project_id, p.archived_at AS project_archived_at
         FROM project_assignments a JOIN projects p ON p.id=a.project_id WHERE a.id=?",
    )
    .bind(assignment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "ASSIGNMENT_NOT_FOUND".to_string())?;
    let agreed_minor: i64 = row.try_get("agreed_minor").map_err(|e| e.to_string())?;
    let lifecycle: String = row.try_get("lifecycle_status").map_err(|e| e.to_string())?;
    let project_id: i64 = row.try_get("project_id").map_err(|e| e.to_string())?;
    let project_archived_at: Option<String> = row
        .try_get("project_archived_at")
        .map_err(|e| e.to_string())?;
    if lifecycle == "CANCELLED" {
        return Err("ASSIGNMENT_ALREADY_CANCELLED".into());
    }
    if project_archived_at.is_some() {
        return Err("PROJECT_ARCHIVED".into());
    }

    let earned_minor = assignment_released_minor(&mut tx, project_id, agreed_minor).await?;
    // Released value is a subset of an allocation of the agreed fee, so this
    // cannot fail — it is kept as a assertion on the derivation itself rather
    // than a check on an untrusted input.
    if earned_minor < 0 || earned_minor > agreed_minor {
        return Err("FROZEN_EARNED_OUT_OF_RANGE".into());
    }

    let result = sqlx::query(
        "UPDATE project_assignments
         SET lifecycle_status='CANCELLED', cancelled_at=datetime('now'),
             cancellation_reason=?, earned_minor_at_cancellation=?
         WHERE id=? AND lifecycle_status<>'CANCELLED'",
    )
    .bind(trimmed)
    .bind(earned_minor)
    .bind(assignment_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("ASSIGNMENT_ALREADY_CANCELLED".into());
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_person_payment_atomic(
    db_instances: State<'_, DbInstances>,
    payment_id: i64,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let result = sqlx::query("UPDATE person_payments SET voided_at=datetime('now'), void_reason='Reversed by user' WHERE id=? AND voided_at IS NULL")
        .bind(payment_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("person payment not found".into());
    }
    let reversal = sqlx::query("INSERT INTO person_payments (assignment_id,date,amount_minor,note,voided_at,void_reason,reversal_of_id) SELECT assignment_id,date,amount_minor,note,datetime('now'),'Reversal record',id FROM person_payments WHERE id=?")
        .bind(payment_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let reversal_id = reversal.last_insert_rowid();
    let expense_id: i64 = sqlx::query_scalar(
        "SELECT id FROM expenses WHERE person_payment_id=? AND voided_at IS NULL",
    )
    .bind(payment_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "linked expense reversal failed".to_string())?;
    let linked = sqlx::query("UPDATE expenses SET voided_at=datetime('now'), void_reason='Reversed with person payment' WHERE id=? AND voided_at IS NULL")
        .bind(expense_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if linked.rows_affected() != 1 {
        return Err("linked expense reversal failed".into());
    }
    sqlx::query("INSERT INTO expenses (date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,attachment_path,person_payment_id,voided_at,void_reason,reversal_of_id) SELECT date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,attachment_path,?,datetime('now'),'Reversal record',id FROM expenses WHERE id=?")
        .bind(reversal_id)
        .bind(expense_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_milestone_certificates_atomic(
    db_instances: State<'_, DbInstances>,
    contract_id: i64,
    drafts: Vec<MilestoneDraftCommandInput>,
) -> Result<i64, String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let current_json: Option<String> =
        sqlx::query_scalar("SELECT milestones FROM contracts WHERE id=?")
            .bind(contract_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    let mut milestones: serde_json::Value = serde_json::from_str(
        &current_json.ok_or_else(|| "contract not found or milestones missing".to_string())?,
    )
    .map_err(|_| "invalid milestone JSON".to_string())?;
    let items = milestones
        .as_array_mut()
        .ok_or_else(|| "milestones must be an array".to_string())?;
    let mut created = 0_i64;
    for draft in drafts {
        if draft.gross_minor <= 0 || draft.number.trim().is_empty() {
            return Err("invalid milestone certificate".into());
        }
        let item = items
            .get_mut(draft.milestone_index)
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| "milestone index not found".to_string())?;
        if item.get("title").and_then(|v| v.as_str()) != Some(draft.description.as_str()) {
            return Err("milestone changed while certificate was being prepared; retry".into());
        }
        if item
            .get("certificateId")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            > 0
        {
            continue;
        }
        let duplicate: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM payment_certificates WHERE contract_id=? AND number=? AND deleted_at IS NULL",
        ).bind(contract_id).bind(&draft.number).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
        let certificate_id = if let Some(id) = duplicate {
            id
        } else {
            let seq: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(seq),0)+1 FROM payment_certificates WHERE contract_id=? AND deleted_at IS NULL",
            ).bind(contract_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
            let result = sqlx::query("INSERT INTO payment_certificates (contract_id,seq,number,date,description,gross_minor,discount_minor,status) VALUES (?,?,?,?,?,?,0,'DRAFT')")
                .bind(contract_id).bind(seq).bind(&draft.number).bind(&draft.date).bind(&draft.description).bind(draft.gross_minor)
                .execute(&mut *tx).await.map_err(|e| e.to_string())?;
            created += 1;
            result.last_insert_rowid()
        };
        item.insert(
            "certificateId".into(),
            serde_json::Value::from(certificate_id),
        );
    }
    sqlx::query("UPDATE contracts SET milestones=? WHERE id=?")
        .bind(serde_json::to_string(&milestones).map_err(|e| e.to_string())?)
        .bind(contract_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(created)
}

#[tauri::command]
async fn create_project_atomic(
    db_instances: State<'_, DbInstances>,
    requested_code: String,
    input: ProjectCommandInput,
) -> Result<i64, String> {
    if requested_code.trim().is_empty() || input.name.trim().is_empty() {
        return Err("project code and name are required".into());
    }
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let mut code = requested_code;
    if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects WHERE code=?")
        .bind(&code)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        > 0
    {
        let (base, sequence) = code
            .rsplit_once('-')
            .ok_or_else(|| "duplicate project code".to_string())?;
        let mut next = sequence
            .parse::<i64>()
            .map_err(|_| "duplicate project code".to_string())?
            + 1;
        loop {
            let candidate = format!("{base}-{next:03}");
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE code=?")
                .bind(&candidate)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            if count == 0 {
                code = candidate;
                break;
            }
            next += 1;
        }
    }
    let result = sqlx::query("INSERT INTO projects (code,name,client_id,country,city,manager,discipline,project_type,status,currency,fx_rate_micro,start_date,end_date,progress_bp,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(code).bind(input.name).bind(input.client_id).bind(input.country).bind(input.city).bind(input.manager)
        .bind(input.discipline).bind(input.project_type).bind(input.status).bind(input.currency).bind(input.fx_rate_micro)
        .bind(input.start_date).bind(input.end_date).bind(input.progress_bp).bind(input.description)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    let id = result.last_insert_rowid();
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
async fn update_project_atomic(
    db_instances: State<'_, DbInstances>,
    project_id: i64,
    input: ProjectCommandInput,
    revision: Option<RevisionMetadataCommandInput>,
) -> Result<(), String> {
    if input.name.trim().is_empty() || input.fx_rate_micro <= 0 {
        return Err("project name and a positive exchange rate are required".into());
    }
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let old = sqlx::query(
        "SELECT currency,fx_rate_micro FROM projects WHERE id=? AND archived_at IS NULL",
    )
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "PROJECT_NOT_FOUND".to_string())?;
    let currency_changed = old
        .try_get::<String, _>("currency")
        .map_err(|e| e.to_string())?
        != input.currency
        || old
            .try_get::<i64, _>("fx_rate_micro")
            .map_err(|e| e.to_string())?
            != input.fx_rate_micro;
    if currency_changed
        && revision.as_ref().is_none_or(|meta| {
            meta.effective_date.trim().is_empty() || meta.reason.trim().is_empty()
        })
    {
        return Err("CONTRACT_REVISION_REQUIRED".into());
    }
    sqlx::query("UPDATE projects SET name=?,client_id=?,country=?,city=?,manager=?,discipline=?,project_type=?,status=?,currency=?,fx_rate_micro=?,start_date=?,end_date=?,progress_bp=?,description=? WHERE id=? AND archived_at IS NULL")
        .bind(&input.name).bind(input.client_id).bind(&input.country).bind(&input.city).bind(&input.manager)
        .bind(&input.discipline).bind(&input.project_type).bind(&input.status).bind(&input.currency)
        .bind(input.fx_rate_micro).bind(&input.start_date).bind(&input.end_date).bind(input.progress_bp)
        .bind(&input.description).bind(project_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if currency_changed {
        let meta = revision.as_ref().expect("validated revision metadata");
        let contract_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM contracts WHERE project_id=? AND archived_at IS NULL",
        )
        .bind(project_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        for contract_id in contract_ids {
            sqlx::query("INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at) SELECT c.id,COALESCE(MAX(r.revision_number),0)+1,?,c.value_minor,c.vat_bp,c.retention_bp,c.withholding_bp,c.advance_minor,c.advance_recovery_method,c.payment_terms_days,?,?,?,datetime('now') FROM contracts c LEFT JOIN contract_revisions r ON r.contract_id=c.id WHERE c.id=? GROUP BY c.id")
                .bind(&meta.effective_date).bind(&input.currency).bind(input.fx_rate_micro)
                .bind(meta.reason.trim()).bind(contract_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        }
    }
    tx.commit().await.map_err(|e| e.to_string())
}

fn json_text(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn json_i64(row: &serde_json::Value, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| v.as_i64())
}

#[tauri::command]
async fn create_contract_atomic(
    db_instances: State<'_, DbInstances>,
    input: ContractCommandInput,
) -> Result<i64, String> {
    validate_contract_input(&input)?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let project = sqlx::query(
        "SELECT currency,fx_rate_micro FROM projects WHERE id=? AND archived_at IS NULL",
    )
    .bind(input.project_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "project not found".to_string())?;
    let currency: String = project.try_get("currency").map_err(|e| e.to_string())?;
    let fx_rate_micro: i64 = project
        .try_get("fx_rate_micro")
        .map_err(|e| e.to_string())?;
    let inserted = sqlx::query("INSERT INTO contracts (project_id,number,title,value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,performance_bond_bp,performance_bond_bank,performance_bond_expiry,payment_terms_days,payment_terms_notes,valuation_mode,milestones,drawings,attachments,signed_date,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(input.project_id).bind(&input.number).bind(&input.title).bind(input.value_minor)
        .bind(input.vat_bp).bind(input.retention_bp).bind(input.withholding_bp).bind(input.advance_minor)
        .bind(&input.advance_recovery_method).bind(input.performance_bond_bp).bind(&input.performance_bond_bank)
        .bind(&input.performance_bond_expiry).bind(input.payment_terms_days).bind(&input.payment_terms_notes)
        .bind(&input.valuation_mode).bind(&input.milestones).bind(&input.drawings).bind(&input.attachments)
        .bind(&input.signed_date).bind(&input.notes).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    let contract_id = inserted.last_insert_rowid();
    sqlx::query("INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at) VALUES (?,1,COALESCE(?,date('now')),?,?,?,?,?,?,?,?,?,'Initial contract terms',datetime('now'))")
        .bind(contract_id).bind(&input.signed_date).bind(input.value_minor).bind(input.vat_bp)
        .bind(input.retention_bp).bind(input.withholding_bp).bind(input.advance_minor)
        .bind(&input.advance_recovery_method).bind(input.payment_terms_days).bind(currency).bind(fx_rate_micro)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(contract_id)
}

#[tauri::command]
async fn update_contract_atomic(
    db_instances: State<'_, DbInstances>,
    contract_id: i64,
    input: ContractCommandInput,
    revision: Option<RevisionMetadataCommandInput>,
) -> Result<(), String> {
    validate_contract_input(&input)?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let old = sqlx::query("SELECT value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days FROM contracts WHERE id=? AND archived_at IS NULL")
        .bind(contract_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "contract not found".to_string())?;
    let old_value: i64 = old.try_get("value_minor").map_err(|e| e.to_string())?;
    let changed = old_value != input.value_minor
        || old.try_get::<i64, _>("vat_bp").map_err(|e| e.to_string())? != input.vat_bp
        || old
            .try_get::<i64, _>("retention_bp")
            .map_err(|e| e.to_string())?
            != input.retention_bp
        || old
            .try_get::<i64, _>("withholding_bp")
            .map_err(|e| e.to_string())?
            != input.withholding_bp
        || old
            .try_get::<i64, _>("advance_minor")
            .map_err(|e| e.to_string())?
            != input.advance_minor
        || old
            .try_get::<String, _>("advance_recovery_method")
            .map_err(|e| e.to_string())?
            != input.advance_recovery_method
        || old
            .try_get::<i64, _>("payment_terms_days")
            .map_err(|e| e.to_string())?
            != input.payment_terms_days;
    let history: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payment_certificates WHERE contract_id=? AND status IN ('SUBMITTED','APPROVED','PAID') AND deleted_at IS NULL")
        .bind(contract_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    if changed
        && history > 0
        && revision
            .as_ref()
            .is_none_or(|r| r.reason.trim().is_empty() || r.effective_date.trim().is_empty())
    {
        return Err("CONTRACT_REVISION_REQUIRED".into());
    }
    let project = sqlx::query("SELECT currency,fx_rate_micro FROM projects WHERE id=?")
        .bind(input.project_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let currency: String = project.try_get("currency").map_err(|e| e.to_string())?;
    let fx_rate_micro: i64 = project
        .try_get("fx_rate_micro")
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE contracts SET number=?,title=?,value_minor=?,vat_bp=?,retention_bp=?,withholding_bp=?,advance_minor=?,advance_recovery_method=?,performance_bond_bp=?,performance_bond_bank=?,performance_bond_expiry=?,payment_terms_days=?,payment_terms_notes=?,valuation_mode=?,milestones=?,drawings=?,attachments=?,signed_date=?,notes=? WHERE id=? AND archived_at IS NULL")
        .bind(&input.number).bind(&input.title).bind(input.value_minor).bind(input.vat_bp).bind(input.retention_bp)
        .bind(input.withholding_bp).bind(input.advance_minor).bind(&input.advance_recovery_method)
        .bind(input.performance_bond_bp).bind(&input.performance_bond_bank).bind(&input.performance_bond_expiry)
        .bind(input.payment_terms_days).bind(&input.payment_terms_notes).bind(&input.valuation_mode)
        .bind(&input.milestones).bind(&input.drawings).bind(&input.attachments).bind(&input.signed_date)
        .bind(&input.notes).bind(contract_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if changed {
        let effective_date = match revision.as_ref() {
            Some(meta) => meta.effective_date.clone(),
            None => match input.signed_date.clone() {
                Some(date) => date,
                None => sqlx::query_scalar("SELECT date('now')")
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?,
            },
        };
        let reason = revision
            .as_ref()
            .map(|meta| meta.reason.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Commercial terms corrected before financial history".to_string());
        let next: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(revision_number),0)+1 FROM contract_revisions WHERE contract_id=?",
        )
        .bind(contract_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let row = sqlx::query("INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))")
            .bind(contract_id).bind(next).bind(effective_date).bind(input.value_minor).bind(input.vat_bp)
            .bind(input.retention_bp).bind(input.withholding_bp).bind(input.advance_minor)
            .bind(&input.advance_recovery_method).bind(input.payment_terms_days).bind(&currency).bind(fx_rate_micro)
            .bind(&reason).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        if old_value != input.value_minor {
            sqlx::query("INSERT INTO variation_orders (contract_id,revision_id,number,description,value_delta_minor,approved_at) VALUES (?,?,?,?,?,datetime('now'))")
                .bind(contract_id).bind(row.last_insert_rowid()).bind(format!("VO-{next}"))
                .bind(reason).bind(input.value_minor-old_value).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        }
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_rows_atomic(
    db_instances: State<'_, DbInstances>,
    entity: String,
    rows: Vec<serde_json::Value>,
    project_code_prefix: String,
) -> Result<i64, String> {
    let pool = application_database_pool(&db_instances).await?;
    import_rows_transaction(&pool, &entity, &rows, &project_code_prefix).await
}

async fn import_rows_transaction(
    pool: &sqlx::SqlitePool,
    entity: &str,
    rows: &[serde_json::Value],
    project_code_prefix: &str,
) -> Result<i64, String> {
    let mut tx = begin_immediate(pool).await?;
    // Certificates created by this import, so their collection status can be
    // derived from evidence inside the same transaction that inserts them.
    let mut imported_certificates: Vec<i64> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let fail = |message: &str| format!("row {}: {message}", index + 2);
        match entity {
            "clients" => {
                let name = json_text(row, "name").ok_or_else(|| fail("client name is required"))?;
                sqlx::query("INSERT INTO clients (name,company,phone,email,tax_number,address,notes) VALUES (?,?,?,?,?,?,?)")
                    .bind(name).bind(json_text(row,"company")).bind(json_text(row,"phone")).bind(json_text(row,"email"))
                    .bind(json_text(row,"taxNumber")).bind(json_text(row,"address")).bind(json_text(row,"notes"))
                    .execute(&mut *tx).await.map_err(|e| fail(&e.to_string()))?;
            }
            "projects" => {
                let client_name =
                    json_text(row, "clientName").ok_or_else(|| fail("client name is required"))?;
                let client_id: i64 = if let Some(id) =
                    sqlx::query_scalar("SELECT id FROM clients WHERE name=? ORDER BY id LIMIT 1")
                        .bind(&client_name)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| fail(&e.to_string()))?
                {
                    id
                } else {
                    sqlx::query("INSERT INTO clients (name) VALUES (?)")
                        .bind(&client_name)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| fail(&e.to_string()))?
                        .last_insert_rowid()
                };
                let code = if let Some(code) = json_text(row, "code") {
                    code
                } else {
                    let year = chrono_year_utc();
                    let base = format!("{}-{}", project_code_prefix, year);
                    let like = format!("{}-%", base);
                    let max: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(CAST(substr(code,length(?)+2) AS INTEGER)),0) FROM projects WHERE code LIKE ?")
                        .bind(&base).bind(like).fetch_one(&mut *tx).await.map_err(|e| fail(&e.to_string()))?;
                    format!("{}-{:03}", base, max + 1)
                };
                let discipline = json_text(row, "discipline")
                    .map(|v| v.to_uppercase())
                    .filter(|v| {
                        matches!(
                            v.as_str(),
                            "HVAC"
                                | "PLUMBING"
                                | "FF"
                                | "ELECTRICAL"
                                | "BIM"
                                | "MULTI"
                                | "ARCHITECTURE"
                                | "STRUCTURAL"
                                | "ID"
                        )
                    })
                    .unwrap_or_else(|| "MULTI".into());
                let status = json_text(row, "status")
                    .map(|v| v.to_uppercase())
                    .filter(|v| {
                        matches!(v.as_str(), "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED")
                    })
                    .unwrap_or_else(|| "ACTIVE".into());
                let requested_currency = json_text(row, "currency")
                    .unwrap_or_else(|| "EGP".into())
                    .to_uppercase();
                let rate: Option<i64> =
                    sqlx::query_scalar("SELECT fx_rate_micro FROM currencies WHERE code=?")
                        .bind(&requested_currency)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| fail(&e.to_string()))?;
                sqlx::query("INSERT INTO projects (code,name,client_id,discipline,status,currency,fx_rate_micro,city,country) VALUES (?,?,?,?,?,?,?,?,?)")
                    .bind(code).bind(json_text(row,"name").ok_or_else(||fail("project name is required"))?).bind(client_id)
                    .bind(discipline).bind(status).bind(if rate.is_some(){requested_currency}else{"EGP".into()}).bind(rate.unwrap_or(1_000_000))
                    .bind(json_text(row,"city")).bind(json_text(row,"country")).execute(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
            }
            "contracts" => {
                let project_code = json_text(row, "projectCode")
                    .ok_or_else(|| fail("project code is required"))?;
                let project_id: i64 = sqlx::query_scalar("SELECT id FROM projects WHERE code=?")
                    .bind(project_code)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| fail(&e.to_string()))?
                    .ok_or_else(|| fail("project not found"))?;
                let value_minor =
                    json_i64(row, "value").ok_or_else(|| fail("contract value is required"))?;
                let vat_bp = json_i64(row, "vat").unwrap_or(1400);
                let retention_bp = json_i64(row, "retention").unwrap_or(0);
                let advance_minor = json_i64(row, "advance").unwrap_or(0);
                let payment_terms_days = json_i64(row, "paymentTermsDays").unwrap_or(30);
                let inserted = sqlx::query("INSERT INTO contracts (project_id,number,title,value_minor,vat_bp,retention_bp,advance_minor,payment_terms_days) VALUES (?,?,?,?,?,?,?,?)")
                    .bind(project_id).bind(json_text(row,"number").ok_or_else(||fail("contract number is required"))?).bind(json_text(row,"title"))
                    .bind(value_minor).bind(vat_bp).bind(retention_bp).bind(advance_minor).bind(payment_terms_days)
                    .execute(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
                let project = sqlx::query("SELECT currency,fx_rate_micro FROM projects WHERE id=?")
                    .bind(project_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| fail(&e.to_string()))?;
                sqlx::query("INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at) VALUES (?,1,date('now'),?,?,?,0,?,'PROPORTIONAL',?,?,?,'Initial imported contract terms',datetime('now'))")
                    .bind(inserted.last_insert_rowid()).bind(value_minor).bind(vat_bp).bind(retention_bp)
                    .bind(advance_minor).bind(payment_terms_days)
                    .bind(project.try_get::<String, _>("currency").map_err(|e|fail(&e.to_string()))?)
                    .bind(project.try_get::<i64, _>("fx_rate_micro").map_err(|e|fail(&e.to_string()))?)
                    .execute(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
            }
            "certificates" => {
                let contract_number = json_text(row, "contractNumber")
                    .ok_or_else(|| fail("contract number is required"))?;
                let contract_id: i64 =
                    sqlx::query_scalar("SELECT id FROM contracts WHERE number=?")
                        .bind(contract_number)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| fail(&e.to_string()))?
                        .ok_or_else(|| fail("contract not found"))?;
                let status = json_text(row, "status")
                    .unwrap_or_else(|| "APPROVED".into())
                    .to_uppercase();
                if status == "PAID" {
                    return Err(fail("PAID requires an explicit payment"));
                }
                let status = if matches!(status.as_str(), "DRAFT" | "SUBMITTED" | "APPROVED") {
                    status
                } else {
                    "APPROVED".into()
                };
                let seq: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq),0)+1 FROM payment_certificates WHERE contract_id=? AND deleted_at IS NULL")
                    .bind(contract_id).fetch_one(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
                let date =
                    json_text(row, "date").ok_or_else(|| fail("certificate date is required"))?;
                let inserted = sqlx::query("INSERT INTO payment_certificates (contract_id,seq,number,date,submission_date,gross_minor,discount_minor,status) VALUES (?,?,?,?,?,?,?,?)")
                    .bind(contract_id).bind(seq).bind(json_text(row,"number").ok_or_else(||fail("certificate number is required"))?).bind(&date)
                    .bind(json_text(row,"submissionDate").unwrap_or_else(|| date.clone())).bind(json_i64(row,"gross").ok_or_else(||fail("gross amount is required"))?)
                    .bind(json_i64(row,"discount").unwrap_or(0)).bind(status).execute(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
                imported_certificates.push(inserted.last_insert_rowid());
            }
            "payments" => {
                let contract_number = json_text(row, "contractNumber")
                    .ok_or_else(|| fail("contract number is required"))?;
                let contract_id: i64 =
                    sqlx::query_scalar("SELECT id FROM contracts WHERE number=?")
                        .bind(contract_number)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| fail(&e.to_string()))?
                        .ok_or_else(|| fail("contract not found"))?;
                let method = json_text(row, "method")
                    .unwrap_or_else(|| "BANK_TRANSFER".into())
                    .to_uppercase()
                    .replace(' ', "_");
                let method = if matches!(method.as_str(), "BANK_TRANSFER" | "CHEQUE" | "CASH") {
                    method
                } else {
                    "BANK_TRANSFER".into()
                };
                sqlx::query("INSERT INTO payments (contract_id,kind,number,date,amount_minor,method,reference) VALUES (?,'CERTIFICATE',?,?,?,?,?)")
                    .bind(contract_id).bind(json_text(row,"number").ok_or_else(||fail("payment number is required"))?)
                    .bind(json_text(row,"date").ok_or_else(||fail("payment date is required"))?).bind(json_i64(row,"amount").ok_or_else(||fail("payment amount is required"))?)
                    .bind(method).bind(json_text(row,"reference")).execute(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
            }
            _ => return Err("unsupported import entity".into()),
        }
    }
    // Status follows the evidence just written, for the certificates this
    // import created and nothing else.
    //
    // An import never creates an allocation — imported cash stays explicitly
    // unallocated until someone links it — so the only status this can settle is
    // a certificate whose payable is already fully consumed by advance recovery,
    // retention and withholding. Leaving it out would import that certificate as
    // an open claim while every identical one elsewhere reads as settled.
    //
    // Scoped rather than global: importing clients or projects must not sweep
    // every certificate in the database, which would attribute unrelated
    // corrections to an import that did not cause them.
    if !imported_certificates.is_empty() {
        reconcile_certificates(&mut tx, &imported_certificates).await?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(rows.len() as i64)
}

/// The four write batches that used to open their transaction from the
/// WebView.
///
/// `tauri-plugin-sql` executes each statement against the pool and releases the
/// connection between calls, so a WebView `BEGIN IMMEDIATE` left an open
/// transaction sitting on a pooled connection. With the runtime pool serialized
/// to one connection that is worse, not better: the next statement from ANY
/// caller — a list refetch, the auto-sync tick, a Rust command's own
/// `begin_immediate` — lands inside that stranded transaction and commits or
/// rolls back with it. Owning the boundary in Rust is the only way the
/// connection cannot be shared mid-transaction.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentCommandInput {
    project_id: i64,
    category: String,
    title: String,
    document_uuid: String,
    original_filename: String,
    extension: Option<String>,
    mime_type: String,
    size_bytes: Option<i64>,
    sha256: Option<String>,
    storage_provider: String,
    cloud_storage_key: Option<String>,
    version_number: i64,
    uploaded_at: Option<String>,
    uploaded_by: Option<String>,
    local_cache_path: Option<String>,
    is_available_offline: bool,
    /// Legacy local references carry the original on-disk path; managed
    /// imports leave it null and are addressed by their cache row.
    path: Option<String>,
}

const NUMBERING_SEQUENCE_TYPES: &[(&str, &str, &str, usize)] = &[
    ("PROJECT", "projects", "code", 3),
    ("CONTRACT", "contracts", "number", 4),
    ("CERTIFICATE", "payment_certificates", "number", 4),
    ("PAYMENT", "payments", "number", 4),
    ("EXPENSE", "expenses", "number", 4),
];

/// Reserve the next number in a sequence as one all-or-nothing operation.
///
/// The reservation reads the highest number already issued and bumps the
/// counter past it, so the read and the write must not be separable: two
/// concurrent reservations that both read the same maximum would hand out the
/// same number. The scan is folded into the UPDATE rather than round-tripped
/// through the caller, so the whole reservation is a single statement pair
/// inside one transaction.
#[tauri::command]
async fn reserve_next_number_atomic(
    db_instances: State<'_, DbInstances>,
    sequence_type: String,
    prefix: String,
    year: i64,
) -> Result<String, String> {
    let pool = application_database_pool(&db_instances).await?;
    reserve_next_number_transaction(&pool, &sequence_type, &prefix, year).await
}

async fn reserve_next_number_transaction(
    pool: &sqlx::SqlitePool,
    sequence_type: &str,
    prefix: &str,
    year: i64,
) -> Result<String, String> {
    let mut tx = begin_immediate(pool).await?;
    let reserved = reserve_next_number_in_tx(&mut tx, sequence_type, prefix, year).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(reserved)
}

/// The reservation itself, inside a transaction the caller already owns.
///
/// Sync conflict resolution renumbers a colliding record as part of a larger
/// resolution, so it cannot afford its own transaction — the renumber, its audit
/// row and the conflict's status have to land together or not at all.
async fn reserve_next_number_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    sequence_type: &str,
    prefix: &str,
    year: i64,
) -> Result<String, String> {
    let clean = prefix.trim().to_uppercase();
    if clean.is_empty()
        || clean.len() > 12
        || !clean
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Err("INVALID_NUMBER_PREFIX".into());
    }
    if !(2000..=9999).contains(&year) {
        return Err("INVALID_NUMBER_YEAR".into());
    }
    let (_, table, column, width) = NUMBERING_SEQUENCE_TYPES
        .iter()
        .find(|(name, _, _, _)| *name == sequence_type)
        .ok_or_else(|| "INVALID_SEQUENCE_TYPE".to_string())?;

    sqlx::query(
        "INSERT OR IGNORE INTO numbering_sequences(sequence_type,year,prefix,last_number) VALUES(?,?,?,0)",
    )
    .bind(sequence_type)
    .bind(year)
    .bind(&clean)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    let stem = format!("{clean}-{year}-");
    // Table and column are chosen from the constant table above, never from the
    // caller, so this format! can only ever produce one of five fixed queries.
    let bump = format!(
        "UPDATE numbering_sequences
         SET last_number = MAX(
               last_number,
               COALESCE((SELECT MAX(CAST(substr({column},length(?)+1) AS INTEGER))
                         FROM {table} WHERE {column} LIKE ?), 0)
             ) + 1
         WHERE sequence_type=? AND year=? AND prefix=?"
    );
    sqlx::query(&bump)
        .bind(&stem)
        .bind(format!("{stem}%"))
        .bind(sequence_type)
        .bind(year)
        .bind(&clean)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let reserved: i64 = sqlx::query_scalar(
        "SELECT last_number FROM numbering_sequences WHERE sequence_type=? AND year=? AND prefix=?",
    )
    .bind(sequence_type)
    .bind(year)
    .bind(&clean)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "NUMBER_RESERVATION_FAILED".to_string())?;

    Ok(format!("{clean}-{year}-{reserved:0width$}", width = *width))
}

/// Tables a sync conflict may be resolved against.
///
/// Every dynamic table name below is looked up here first, so the `format!`d
/// statements can only ever produce one of eight fixed shapes — a conflict row
/// naming anything else is refused before a statement is built.
const CONFLICT_TABLES: &[&str] = &[
    "contracts",
    "contract_revisions",
    "payment_certificates",
    "payments",
    "payment_certificate_allocations",
    "expenses",
    "person_payments",
    "projects",
];

/// Number-collision renumbering: sequence, settings key for the prefix, the
/// human-number column, and the expression giving the record's business date.
/// Mirrors the same table in `syncConflicts.ts`.
const COLLISION_CONFIG: &[(&str, &str, &str, &str, &str)] = &[
    (
        "projects",
        "PROJECT",
        "project_code_prefix",
        "code",
        "created_at",
    ),
    (
        "contracts",
        "CONTRACT",
        "contract_number_prefix",
        "number",
        "COALESCE(signed_date,created_at)",
    ),
    (
        "payment_certificates",
        "CERTIFICATE",
        "certificate_number_prefix",
        "number",
        "date",
    ),
    (
        "payments",
        "PAYMENT",
        "payment_number_prefix",
        "number",
        "date",
    ),
    (
        "expenses",
        "EXPENSE",
        "expense_number_prefix",
        "number",
        "date",
    ),
];

fn conflict_table(name: &str) -> Result<&'static str, String> {
    CONFLICT_TABLES
        .iter()
        .find(|candidate| **candidate == name)
        .copied()
        .ok_or_else(|| "SYNC_CONFLICT_NOT_FOUND".to_string())
}

/// Resolve one sync conflict as a single all-or-nothing operation.
///
/// This was the last write still opening its transaction from the WebView,
/// which does not work: `tauri-plugin-sql` releases the pooled connection
/// between statements, so the boundary was stranded on a shared connection
/// where any other statement could join it. It is the worst place for that to
/// be true — resolution renumbers records, deletes allocations, writes audit
/// rows and rewinds pull cursors, and a partial application leaves the local
/// database disagreeing with the cloud about which row won.
///
/// The choice is still the user's: nothing here decides an outcome, it applies
/// the one that was chosen and records why.
#[tauri::command]
async fn resolve_sync_conflict_atomic(
    db_instances: State<'_, DbInstances>,
    conflict_id: i64,
    resolution: String,
    note: String,
) -> Result<(), String> {
    let pool = application_database_pool(&db_instances).await?;
    resolve_sync_conflict_transaction(&pool, conflict_id, &resolution, &note).await
}

async fn resolve_sync_conflict_transaction(
    pool: &sqlx::SqlitePool,
    conflict_id: i64,
    resolution: &str,
    note: &str,
) -> Result<(), String> {
    if !matches!(resolution, "KEEP_LOCAL" | "KEEP_REMOTE") {
        return Err("SYNC_CONFLICT_RESOLUTION_INVALID".into());
    }
    let trimmed_note = note.trim().to_string();
    if trimmed_note.is_empty() {
        return Err("SYNC_CONFLICT_REASON_REQUIRED".into());
    }
    let keep_local = resolution == "KEEP_LOCAL";

    let mut tx = begin_immediate(pool).await?;
    let conflict = sqlx::query(
        "SELECT table_name,row_uuid,conflict_kind,local_json,remote_json,remote_updated_at
         FROM sync_conflicts WHERE id=? AND status='OPEN'",
    )
    .bind(conflict_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "SYNC_CONFLICT_NOT_FOUND".to_string())?;

    let table: String = conflict.try_get("table_name").map_err(|e| e.to_string())?;
    let table = conflict_table(&table)?;
    let row_uuid: String = conflict.try_get("row_uuid").map_err(|e| e.to_string())?;
    let kind: String = conflict
        .try_get("conflict_kind")
        .map_err(|e| e.to_string())?;
    let local_json: String = conflict.try_get("local_json").map_err(|e| e.to_string())?;
    let remote_json: String = conflict.try_get("remote_json").map_err(|e| e.to_string())?;
    let remote_updated_at: Option<String> = conflict
        .try_get("remote_updated_at")
        .map_err(|e| e.to_string())?;

    // The baseline the next pull compares against is the snapshot that LOST:
    // keeping local means the remote snapshot is now the known-seen state.
    let chosen_baseline = if keep_local {
        &remote_json
    } else {
        &local_json
    };
    sqlx::query(
        "INSERT INTO sync_record_state(table_name,row_uuid,payload_json,remote_updated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(table_name,row_uuid) DO UPDATE SET payload_json=excluded.payload_json,
                                                        remote_updated_at=excluded.remote_updated_at",
    )
    .bind(table)
    .bind(&row_uuid)
    .bind(chosen_baseline)
    .bind(&remote_updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let target: Option<i64> =
        sqlx::query_scalar(&format!("SELECT id FROM {table} WHERE sync_uuid=?"))
            .bind(&row_uuid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

    let duplicate_record = kind == "DUPLICATE_RECORD";
    let allocation_duplicate = duplicate_record && table == "payment_certificate_allocations";

    if allocation_duplicate {
        let local: JsonValue = serde_json::from_str(&local_json)
            .map_err(|e| format!("SYNC_CONFLICT_PAYLOAD_INVALID: {e}"))?;
        let duplicate_id: Option<i64> = sqlx::query_scalar(
            "SELECT a.id FROM payment_certificate_allocations a
             JOIN payments p ON p.id=a.payment_id
             JOIN payment_certificates c ON c.id=a.certificate_id
             WHERE p.sync_uuid=? AND c.sync_uuid=? AND a.sync_uuid<>?",
        )
        .bind(json_text(&local, "payment_id"))
        .bind(json_text(&local, "certificate_id"))
        .bind(&row_uuid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let duplicate_id =
            duplicate_id.ok_or_else(|| "SYNC_DUPLICATE_SOURCE_NOT_FOUND".to_string())?;

        if keep_local {
            sqlx::query(
                "INSERT INTO sync_tombstones(tbl,row_uuid,deleted_at)
                 VALUES('payment_certificate_allocations',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            )
            .bind(&row_uuid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            // An explicit, audited replacement. The allocation delete trigger
            // records the removed financial relationship and its tombstone.
            sqlx::query("DELETE FROM payment_certificate_allocations WHERE id=?")
                .bind(duplicate_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    } else if duplicate_record {
        let local: JsonValue = serde_json::from_str(&local_json)
            .map_err(|e| format!("SYNC_CONFLICT_PAYLOAD_INVALID: {e}"))?;
        let remote: JsonValue = serde_json::from_str(&remote_json)
            .map_err(|e| format!("SYNC_CONFLICT_PAYLOAD_INVALID: {e}"))?;
        let local_uuid = json_text(&local, "_localSyncUuid")
            .ok_or_else(|| "SYNC_DUPLICATE_SOURCE_NOT_FOUND".to_string())?;
        let (_, sequence, prefix_key, number_column, date_column) = COLLISION_CONFIG
            .iter()
            .find(|(name, _, _, _, _)| *name == table)
            .ok_or_else(|| "SYNC_CONFLICT_NOT_FOUND".to_string())?;
        let remote_number = json_text(
            &remote,
            if table == "projects" {
                "code"
            } else {
                "number"
            },
        );

        if keep_local {
            // A number collision never deletes either business record. The local
            // one is renumbered and the pull replayed, so both uuids and every
            // descendant row survive.
            let business_date: Option<String> = sqlx::query_scalar(&format!(
                "SELECT {date_column} FROM {table} WHERE sync_uuid=?"
            ))
            .bind(&local_uuid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "SYNC_DUPLICATE_SOURCE_NOT_FOUND".to_string())?;

            let stored_prefix: Option<String> =
                sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
                    .bind(prefix_key)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            let prefix = stored_prefix
                .unwrap_or_else(|| sequence.chars().take(3).collect())
                .trim()
                .to_uppercase();

            let year = business_date
                .as_deref()
                .and_then(|value| value.get(0..4))
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|year| (2000..=9999).contains(year))
                .unwrap_or_else(|| i64::from(chrono_year_utc()));

            let new_number = reserve_next_number_in_tx(&mut tx, sequence, &prefix, year).await?;

            sqlx::query(&format!(
                "UPDATE {table} SET {number_column}=? WHERE sync_uuid=?"
            ))
            .bind(&new_number)
            .bind(&local_uuid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

            sqlx::query(
                "INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,
                    before_json,after_json,reason,source,application_version)
                 VALUES((SELECT value FROM settings WHERE key='sync_email'),
                        (SELECT value FROM settings WHERE key='device_id'),
                        'NUMBER_COLLISION_RENUMBER',?,?,
                        json_object('number',?),json_object('number',?),?,'SYNC',?)",
            )
            .bind(table)
            .bind(&local_uuid)
            .bind(&remote_number)
            .bind(&new_number)
            .bind(&trimmed_note)
            .bind(CURRENT_APP_VERSION)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            // Accepting the remote number requires the local record to have been
            // renumbered first; otherwise the pull would collide all over again.
            // Double option: the row may be absent, and expenses.number is
            // nullable, so a present row can still carry NULL here.
            let current: Option<Option<String>> = sqlx::query_scalar(&format!(
                "SELECT {number_column} FROM {table} WHERE sync_uuid=?"
            ))
            .bind(&local_uuid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            let current = current.flatten();
            if current.is_some() && current == remote_number {
                return Err("RENUMBER_LOCAL_BEFORE_KEEP_REMOTE".into());
            }
        }
    } else if target.is_some() && keep_local {
        // Win the next pull by timestamp: later than now AND later than the
        // remote row, so the local edit is the one that propagates.
        sqlx::query(&format!(
            "UPDATE {table}
             SET updated_at = MAX(
                   strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                   COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+0.001 seconds'), '0')
                 )
             WHERE sync_uuid=?"
        ))
        .bind(&remote_updated_at)
        .bind(&row_uuid)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    } else if target.is_some() {
        // Force the next pull to apply the preserved remote snapshot even when
        // the rejected local edit carried a later wall-clock timestamp.
        sqlx::query(&format!(
            "UPDATE {table} SET updated_at='1970-01-01T00:00:00.000Z' WHERE sync_uuid=?"
        ))
        .bind(&row_uuid)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    } else if !keep_local {
        // KEEP_REMOTE for a locally deleted row must cancel its tombstone, or
        // the chosen cloud row would simply be deleted again after the pull.
        sqlx::query("DELETE FROM sync_tombstones WHERE tbl=? AND row_uuid=?")
            .bind(table)
            .bind(&row_uuid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    let resolved = sqlx::query(
        "UPDATE sync_conflicts
         SET status='RESOLVED', resolution=?, resolution_note=?,
             resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             resolved_by=(SELECT value FROM settings WHERE key='sync_email')
         WHERE id=? AND status='OPEN'",
    )
    .bind(resolution)
    .bind(&trimmed_note)
    .bind(conflict_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if resolved.rows_affected() != 1 {
        return Err("SYNC_CONFLICT_NOT_FOUND".into());
    }

    // Replay the pull so the resolution's consequences are fetched again.
    if !keep_local || (duplicate_record && !allocation_duplicate) {
        sqlx::query("DELETE FROM sync_state WHERE key LIKE 'pull:%'")
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())
}

/// Convert the compatibility marker left when a pre-audit backup was restored.
///
/// The audit row and the marker's removal are the same fact: a marker cleared
/// without its audit row loses the evidence that a restore happened, and an
/// audit row written without clearing the marker re-records the restore on
/// every launch.
#[tauri::command]
async fn finalize_pending_restore_audit_atomic(
    db_instances: State<'_, DbInstances>,
) -> Result<bool, String> {
    let pool = application_database_pool(&db_instances).await?;
    finalize_pending_restore_audit_transaction(&pool).await
}

async fn finalize_pending_restore_audit_transaction(
    pool: &sqlx::SqlitePool,
) -> Result<bool, String> {
    let mut tx = begin_immediate(pool).await?;
    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key='pending_restore_audit'")
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    if pending == 0 {
        tx.commit().await.map_err(|e| e.to_string())?;
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO audit_logs(user_id,device_id,action,entity_type,after_json,reason,source)
         VALUES((SELECT value FROM settings WHERE key='sync_email'),
                (SELECT value FROM settings WHERE key='device_id'),
                'RESTORE','backup',json_object('path','[REDACTED]'),
                'Pre-audit database restored by user','RESTORE')",
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM settings WHERE key='pending_restore_audit'")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(true)
}

/// Register the safety copy taken before a restore, and clear its marker.
///
/// Same pairing as the restore audit: the backups_log row is the record that
/// the safety copy exists, so leaving the marker behind would duplicate it and
/// clearing the marker alone would lose it.
#[tauri::command]
async fn finalize_pending_backup_metadata_atomic(
    db_instances: State<'_, DbInstances>,
) -> Result<bool, String> {
    let pool = application_database_pool(&db_instances).await?;
    finalize_pending_backup_metadata_transaction(&pool).await
}

async fn finalize_pending_backup_metadata_transaction(
    pool: &sqlx::SqlitePool,
) -> Result<bool, String> {
    let mut tx = begin_immediate(pool).await?;
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='pending_restore_safety'")
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    let Some(raw) = raw else {
        tx.commit().await.map_err(|e| e.to_string())?;
        return Ok(false);
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("PENDING_BACKUP_METADATA_INVALID: {e}"))?;
    sqlx::query(
        "INSERT INTO backups_log(path,kind,filename,database_version,application_version,sha256_checksum,backup_type,source_device)
         VALUES(?,'AUTO',?,?,?,?,'SAFETY',?)",
    )
    .bind(json_text(&value, "path").ok_or_else(|| "PENDING_BACKUP_METADATA_INVALID".to_string())?)
    .bind(json_text(&value, "filename"))
    .bind(json_i64(&value, "databaseVersion"))
    .bind(json_text(&value, "applicationVersion"))
    .bind(json_text(&value, "sha256Checksum"))
    .bind(json_text(&value, "sourceDevice"))
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM settings WHERE key='pending_restore_safety'")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(true)
}

/// Insert a document and its device-cache row as one all-or-nothing operation.
///
/// A documents row without its cache row points at a file the app cannot find;
/// a cache row without its document is an orphaned file on disk. The duplicate
/// check runs inside the same transaction so two imports of identical content
/// cannot both pass it.
#[tauri::command]
async fn create_document_atomic(
    db_instances: State<'_, DbInstances>,
    input: DocumentCommandInput,
) -> Result<i64, String> {
    let pool = application_database_pool(&db_instances).await?;
    create_document_transaction(&pool, input).await
}

async fn create_document_transaction(
    pool: &sqlx::SqlitePool,
    input: DocumentCommandInput,
) -> Result<i64, String> {
    if input.title.trim().is_empty() || input.document_uuid.trim().is_empty() {
        return Err("invalid document metadata".into());
    }
    if input.version_number <= 0 {
        return Err("invalid document version".into());
    }
    if input.size_bytes.is_some_and(|size| size < 0) {
        return Err("invalid document size".into());
    }
    let mut tx = begin_immediate(pool).await?;
    if let Some(sha256) = input.sha256.as_deref() {
        let duplicate: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM documents WHERE project_id=? AND sha256=? AND archived_at IS NULL",
        )
        .bind(input.project_id)
        .bind(sha256)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if duplicate > 0 {
            return Err("DUPLICATE_DOCUMENT_CONTENT".into());
        }
    }
    let result = sqlx::query(
        "INSERT INTO documents(project_id,category,title,document_uuid,original_filename,extension,mime_type,size_bytes,sha256,
           storage_provider,cloud_storage_key,version_number,uploaded_at,uploaded_by,path)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(input.project_id).bind(&input.category).bind(&input.title).bind(&input.document_uuid)
    .bind(&input.original_filename).bind(&input.extension).bind(&input.mime_type)
    .bind(input.size_bytes).bind(&input.sha256).bind(&input.storage_provider)
    .bind(&input.cloud_storage_key).bind(input.version_number)
    .bind(&input.uploaded_at).bind(&input.uploaded_by).bind(&input.path)
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    let document_id = result.last_insert_rowid();
    if let Some(path) = input.local_cache_path.as_deref() {
        sqlx::query(
            "INSERT INTO document_cache(document_id,local_cache_path,is_available_offline,verified_at)
             VALUES(?,?,?,datetime('now'))",
        )
        .bind(document_id)
        .bind(path)
        .bind(i64::from(input.is_available_offline))
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(document_id)
}

fn chrono_year_utc() -> i32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Civil-date conversion from Unix days; avoids adding a date dependency.
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        / 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    if mp >= 10 {
        year += 1;
    }
    year as i32
}

const CURRENT_SCHEMA_VERSION: i64 = 27;
const CURRENT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const APPLICATION_ID: &str = "com.mepfinance.app";
/// Migration lineage after the v0.7.0 rebase. The schema version stays 24
/// because the baseline recreates that exact schema, so these describe the
/// FILE sequence and are what distinguishes a rebased database from one built
/// by the retired 0001..0024 development chain.
const CURRENT_MIGRATION_VERSION: i64 = 5;
const BASELINE_MIGRATION_DESCRIPTION: &str = "baseline_schema";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReleaseInfo {
    app_version: String,
    schema_version: i64,
}

async fn verified_schema_version(pool: &sqlx::SqlitePool) -> Result<i64, String> {
    let pragma_schema: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("SCHEMA_VERSION_UNAVAILABLE: {e}"))?;
    let metadata_schema: String =
        sqlx::query_scalar("SELECT value FROM app_metadata WHERE key='schema_version'")
            .fetch_one(pool)
            .await
            .map_err(|e| format!("SCHEMA_VERSION_UNAVAILABLE: {e}"))?;
    if pragma_schema != CURRENT_SCHEMA_VERSION
        || metadata_schema.parse::<i64>().ok() != Some(CURRENT_SCHEMA_VERSION)
    {
        return Err(format!(
            "SCHEMA_VERSION_MISMATCH: expected {CURRENT_SCHEMA_VERSION}, pragma {pragma_schema}, metadata {metadata_schema}"
        ));
    }
    Ok(pragma_schema)
}

async fn stamp_runtime_release(pool: &sqlx::SqlitePool) -> Result<RuntimeReleaseInfo, String> {
    let schema_version = verified_schema_version(pool).await?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO app_metadata(key,value) VALUES('application_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(CURRENT_APP_VERSION)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE audit_context SET application_version=? WHERE id=1")
        .bind(CURRENT_APP_VERSION)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(RuntimeReleaseInfo {
        app_version: CURRENT_APP_VERSION.to_string(),
        schema_version,
    })
}

#[tauri::command]
async fn initialize_runtime_release(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
) -> Result<RuntimeReleaseInfo, String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use tauri::Manager;

    // tauri-plugin-sql uses SQLx's default multi-connection pool. The WebView
    // API executes each statement independently, so legacy BEGIN/COMMIT
    // sequences can otherwise land on different connections and strand a
    // SQLite writer lock. After the plugin has completed forward migrations,
    // replace its pool with one serialized connection for this offline desktop
    // database. Rust atomic commands and WebView queries then share the same
    // writer queue and SQLite's transaction boundary cannot change connection.
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("RUNTIME_DATABASE_UNAVAILABLE: {e}"))?
        .join("mep-finance.db");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false)
                .journal_mode(SqliteJournalMode::Wal)
                .foreign_keys(true)
                .busy_timeout(std::time::Duration::from_secs(15)),
        )
        .await
        .map_err(|e| format!("RUNTIME_DATABASE_UNAVAILABLE: {e}"))?;
    let info = stamp_runtime_release(&pool).await?;

    let previous = {
        let mut instances = db_instances.0.write().await;
        instances.insert(DATABASE_KEY.to_string(), DbPool::Sqlite(pool))
    };
    if let Some(DbPool::Sqlite(previous)) = previous {
        previous.close().await;
    }
    Ok(info)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInspection {
    filename: String,
    database_version: i64,
    application_version: String,
    sha256_checksum: String,
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("BACKUP_NOT_READABLE: {e}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("BACKUP_NOT_READABLE: {e}"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDocumentFile {
    original_filename: String,
    extension: Option<String>,
    mime_type: String,
    size_bytes: u64,
    sha256: String,
    local_cache_path: String,
}

fn safe_document_component(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("INVALID_DOCUMENT_ID".into());
    }
    Ok(value)
}

fn document_mime(extension: Option<&str>) -> &'static str {
    match extension.unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "application/pdf",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "dwg" => "image/vnd.dwg",
        "rvt" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn managed_document_destination(
    root: &std::path::Path,
    document_uuid: &str,
    version_number: u32,
    filename: &str,
) -> Result<std::path::PathBuf, String> {
    let document_uuid = safe_document_component(document_uuid)?;
    if version_number == 0 {
        return Err("INVALID_DOCUMENT_VERSION".into());
    }
    let filename = std::path::Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or("INVALID_DOCUMENT_FILENAME")?;
    Ok(root
        .join("documents")
        .join(document_uuid)
        .join(format!("v{version_number}"))
        .join(filename))
}

fn write_managed_document(
    destination: &std::path::Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<ManagedDocumentFile, String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if expected_sha256.is_some_and(|expected| !expected.eq_ignore_ascii_case(&actual)) {
        return Err("DOCUMENT_CHECKSUM_MISMATCH".into());
    }
    let parent = destination.parent().ok_or("INVALID_DOCUMENT_DESTINATION")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("DOCUMENT_CACHE_CREATE_FAILED: {e}"))?;
    let temporary = destination.with_extension("namaa-part");
    let backup = destination.with_extension("namaa-old");
    if backup.exists() && !destination.exists() {
        std::fs::rename(&backup, destination)
            .map_err(|e| format!("DOCUMENT_CACHE_RECOVERY_FAILED: {e}"))?;
    } else if backup.exists() {
        std::fs::remove_file(&backup)
            .map_err(|e| format!("DOCUMENT_CACHE_RECOVERY_FAILED: {e}"))?;
    }
    if temporary.exists() {
        std::fs::remove_file(&temporary)
            .map_err(|e| format!("DOCUMENT_CACHE_RECOVERY_FAILED: {e}"))?;
    }
    if let Err(error) = std::fs::write(&temporary, bytes) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("DOCUMENT_CACHE_WRITE_FAILED: {error}"));
    }
    if destination.exists() {
        std::fs::rename(destination, &backup)
            .map_err(|e| format!("DOCUMENT_CACHE_REPLACE_FAILED: {e}"))?;
    }
    if let Err(error) = std::fs::rename(&temporary, destination) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, destination);
        }
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("DOCUMENT_CACHE_COMMIT_FAILED: {error}"));
    }
    if backup.exists() {
        std::fs::remove_file(backup).map_err(|e| format!("DOCUMENT_CACHE_CLEANUP_FAILED: {e}"))?;
    }
    let original_filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("INVALID_DOCUMENT_FILENAME")?
        .to_owned();
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    Ok(ManagedDocumentFile {
        original_filename,
        mime_type: document_mime(extension.as_deref()).into(),
        extension,
        size_bytes: bytes.len() as u64,
        sha256: actual,
        local_cache_path: destination.to_string_lossy().to_string(),
    })
}

fn copy_managed_document(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<ManagedDocumentFile, String> {
    use std::io::{Read, Write};
    let parent = destination.parent().ok_or("INVALID_DOCUMENT_DESTINATION")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("DOCUMENT_CACHE_CREATE_FAILED: {e}"))?;
    let temporary = destination.with_extension("namaa-part");
    let result = (|| {
        let mut input =
            std::fs::File::open(source).map_err(|e| format!("DOCUMENT_SOURCE_READ_FAILED: {e}"))?;
        let mut output = std::fs::File::create(&temporary)
            .map_err(|e| format!("DOCUMENT_CACHE_WRITE_FAILED: {e}"))?;
        let mut digest = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|e| format!("DOCUMENT_SOURCE_READ_FAILED: {e}"))?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| format!("DOCUMENT_CACHE_WRITE_FAILED: {e}"))?;
            digest.update(&buffer[..count]);
            size_bytes = size_bytes
                .checked_add(count as u64)
                .ok_or("DOCUMENT_SIZE_OVERFLOW")?;
        }
        output
            .sync_all()
            .map_err(|e| format!("DOCUMENT_CACHE_WRITE_FAILED: {e}"))?;
        std::fs::rename(&temporary, destination)
            .map_err(|e| format!("DOCUMENT_CACHE_COMMIT_FAILED: {e}"))?;
        let original_filename = destination
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("INVALID_DOCUMENT_FILENAME")?
            .to_owned();
        let extension = destination
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        Ok(ManagedDocumentFile {
            original_filename,
            mime_type: document_mime(extension.as_deref()).into(),
            extension,
            size_bytes,
            sha256: format!("{:x}", digest.finalize()),
            local_cache_path: destination.to_string_lossy().to_string(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[tauri::command]
fn import_project_document(
    app: tauri::AppHandle,
    source_path: String,
    document_uuid: String,
    version_number: u32,
) -> Result<ManagedDocumentFile, String> {
    use tauri::Manager;
    let source = std::path::Path::new(&source_path);
    let filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("INVALID_DOCUMENT_FILENAME")?;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let destination =
        managed_document_destination(&root, &document_uuid, version_number, filename)?;
    if destination.exists() {
        return Err("DOCUMENT_VERSION_CACHE_EXISTS".into());
    }
    copy_managed_document(source, &destination)
}

#[tauri::command]
fn cache_project_document(
    app: tauri::AppHandle,
    document_uuid: String,
    version_number: u32,
    filename: String,
    bytes: Vec<u8>,
    expected_sha256: String,
) -> Result<ManagedDocumentFile, String> {
    use tauri::Manager;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let destination =
        managed_document_destination(&root, &document_uuid, version_number, &filename)?;
    write_managed_document(&destination, &bytes, Some(&expected_sha256))
}

#[tauri::command]
fn document_file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

#[tauri::command]
fn remove_managed_document_cache(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("documents");
    let candidate = std::path::PathBuf::from(path);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "DOCUMENT_CACHE_ROOT_NOT_FOUND")?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| "DOCUMENT_CACHE_NOT_FOUND")?;
    if !canonical_candidate.starts_with(canonical_root) || !canonical_candidate.is_file() {
        return Err("DOCUMENT_CACHE_OUTSIDE_MANAGED_ROOT".into());
    }
    std::fs::remove_file(canonical_candidate)
        .map_err(|e| format!("DOCUMENT_CACHE_REMOVE_FAILED: {e}"))
}

async fn validate_backup_path(path: &std::path::Path) -> Result<BackupInspection, String> {
    if !path.is_file() {
        return Err("BACKUP_FILE_NOT_FOUND".into());
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("BACKUP_NOT_SQLITE: {e}"))?;
    let result = async {
        let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("BACKUP_INTEGRITY_CHECK_FAILED: {e}"))?;
        if integrity.len() != 1 || integrity[0] != "ok" {
            return Err(format!("BACKUP_CORRUPT: {}", integrity.join(", ")));
        }
        if !sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("BACKUP_FOREIGN_KEY_CHECK_FAILED: {e}"))?
            .is_empty()
        {
            return Err("BACKUP_FOREIGN_KEY_VIOLATIONS".into());
        }
        let required = [
            "clients",
            "projects",
            "contracts",
            "payment_certificates",
            "payments",
            "payment_certificate_allocations",
            "expenses",
            "people",
            "settings",
            "currencies",
        ];
        for table in required {
            let found: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
            if found != 1 {
                return Err(format!("BACKUP_WRONG_APPLICATION: missing table {table}"));
            }
        }
        // The v0.7.0 rebase replaced the migration chain, so the schema
        // version number can no longer separate a compatible database from an
        // incompatible one — both report 24. The recorded migration lineage
        // can. Restoring a pre-rebase backup would swap the live database for
        // one the migration plugin then refuses to open, leaving an app that
        // will not start, so it is rejected before anything is touched.
        let has_migrations_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
        )
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
        if has_migrations_table == 1 {
            let first: Option<String> =
                sqlx::query_scalar("SELECT description FROM _sqlx_migrations WHERE version=1")
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| e.to_string())?;
            let highest: i64 =
                sqlx::query_scalar("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations")
                    .fetch_one(&pool)
                    .await
                    .map_err(|e| e.to_string())?;
            let lineage_matches = first
                .as_deref()
                .map(|description| description == BASELINE_MIGRATION_DESCRIPTION)
                .unwrap_or(true);
            if !lineage_matches || highest > CURRENT_MIGRATION_VERSION {
                return Err("BACKUP_PREDATES_DATABASE_REBASE".into());
            }
        }
        let mut schema: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        let has_metadata: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_metadata'",
        )
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
        let mut app_version = "legacy".to_string();
        if has_metadata == 1 {
            let app_id: Option<String> =
                sqlx::query_scalar("SELECT value FROM app_metadata WHERE key='application_id'")
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| e.to_string())?;
            if app_id.as_deref() != Some(APPLICATION_ID) {
                return Err("BACKUP_WRONG_APPLICATION".into());
            }
            app_version = sqlx::query_scalar(
                "SELECT value FROM app_metadata WHERE key='application_version'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "unknown".into());
            schema = sqlx::query_scalar::<_, String>(
                "SELECT value FROM app_metadata WHERE key='schema_version'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|v| v.parse().ok())
            .unwrap_or(schema);
        } else {
            let has_migrations: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
            if has_migrations != 1 {
                return Err("BACKUP_APPLICATION_COMPATIBILITY_UNKNOWN".into());
            }
            schema = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1",
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        if !(1..=CURRENT_SCHEMA_VERSION).contains(&schema) {
            return Err(format!("BACKUP_SCHEMA_INCOMPATIBLE: {schema}"));
        }
        Ok((schema, app_version))
    }
    .await;
    pool.close().await;
    let (database_version, application_version) = result?;
    Ok(BackupInspection {
        filename: path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("backup.db")
            .to_string(),
        database_version,
        application_version,
        sha256_checksum: sha256_file(path)?,
    })
}

#[tauri::command]
async fn validate_backup(backup_path: String) -> Result<BackupInspection, String> {
    validate_backup_path(std::path::Path::new(&backup_path)).await
}

async fn create_sqlite_backup(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<BackupInspection, String> {
    if destination.exists() {
        std::fs::remove_file(destination).map_err(|e| e.to_string())?;
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(source)
                .create_if_missing(false),
        )
        .await
        .map_err(|e| format!("CURRENT_DATABASE_NOT_READABLE: {e}"))?;
    let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("WAL_CHECKPOINT_FAILED: {e}"))?;
    if checkpoint.0 != 0 {
        pool.close().await;
        return Err(format!("WAL_CHECKPOINT_BUSY: {}", checkpoint.0));
    }
    let escaped = destination.to_string_lossy().replace('\'', "''");
    let backup_result = sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(&pool)
        .await;
    pool.close().await;
    backup_result.map_err(|e| format!("SAFETY_BACKUP_FAILED: {e}"))?;
    validate_backup_path(destination).await
}

fn atomic_replace(
    active: &std::path::Path,
    staged: &std::path::Path,
    previous: &std::path::Path,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};
        let wide = |p: &std::path::Path| {
            p.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        let a = wide(active);
        let s = wide(staged);
        let p = wide(previous);
        let mut last_error = None;
        for attempt in 0..5 {
            let ok = unsafe {
                ReplaceFileW(
                    a.as_ptr(),
                    s.as_ptr(),
                    p.as_ptr(),
                    REPLACEFILE_WRITE_THROUGH,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if ok != 0 {
                return Ok(());
            }
            last_error = Some(std::io::Error::last_os_error());
            if attempt < 4 {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        Err(format!(
            "ATOMIC_REPLACE_FAILED: {}",
            last_error.map_or_else(|| "unknown error".into(), |error| error.to_string())
        ))
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(active, previous).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(staged, active) {
            let _ = std::fs::rename(previous, active);
            return Err(e.to_string());
        }
        Ok(())
    }
}

fn rollback_backup_destination(
    destination: &std::path::Path,
    previous: &std::path::Path,
    replaced_existing: bool,
) -> Result<(), String> {
    if replaced_existing {
        let failed = destination.with_extension("namaa-failed");
        let result = atomic_replace(destination, previous, &failed);
        let _ = std::fs::remove_file(failed);
        result
    } else {
        std::fs::remove_file(destination).map_err(|e| e.to_string())
    }
}

fn verify_known_backup_checksum(known: Option<&str>, actual: &str) -> Result<(), String> {
    if known.is_some_and(|checksum| checksum != actual) {
        Err("BACKUP_CHECKSUM_MISMATCH".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn create_backup_file(
    app: tauri::AppHandle,
    destination_path: String,
    backup_type: String,
) -> Result<BackupInspection, String> {
    use tauri::Manager;
    let source = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("mep-finance.db");
    let destination = std::path::PathBuf::from(destination_path);
    if backup_type != "AUTO" && backup_type != "MANUAL" {
        return Err("INVALID_BACKUP_TYPE".into());
    }
    let staged = destination.with_extension("namaa-staged");
    let previous = destination.with_extension("namaa-previous");
    for path in [&staged, &previous] {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    create_sqlite_backup(&source, &staged).await?;
    let replaced_existing = destination.exists();
    if replaced_existing {
        atomic_replace(&destination, &staged, &previous)?;
    } else {
        std::fs::rename(&staged, &destination)
            .map_err(|e| format!("BACKUP_ACTIVATION_FAILED: {e}"))?;
    }
    let info = match validate_backup_path(&destination).await {
        Ok(info) => info,
        Err(error) => {
            rollback_backup_destination(&destination, &previous, replaced_existing)
                .map_err(|r| format!("BACKUP_VALIDATION_FAILED: {error}; ROLLBACK_FAILED: {r}"))?;
            return Err(format!("BACKUP_VALIDATION_FAILED_ROLLED_BACK: {error}"));
        }
    };
    let pool = match sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&source))
        .await
    {
        Ok(pool) => pool,
        Err(error) => {
            rollback_backup_destination(&destination, &previous, replaced_existing).map_err(
                |r| format!("BACKUP_METADATA_DATABASE_FAILED: {error}; ROLLBACK_FAILED: {r}"),
            )?;
            return Err(format!(
                "BACKUP_METADATA_DATABASE_FAILED_ROLLED_BACK: {error}"
            ));
        }
    };
    let metadata_result: Result<(), String> = async {
        let source_device: String = sqlx::query_scalar(
            "SELECT COALESCE((SELECT value FROM settings WHERE key='device_id'),'unknown')",
        )
        .fetch_one(&pool).await.unwrap_or_else(|_| "unknown".into());
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM backups_log WHERE path=?")
            .bind(destination.to_string_lossy().to_string()).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO backups_log(path,kind,filename,database_version,application_version,sha256_checksum,backup_type,source_device) VALUES(?,?,?,?,?,?,?,?)")
            .bind(destination.to_string_lossy().to_string()).bind(&backup_type).bind(&info.filename)
            .bind(info.database_version).bind(&info.application_version).bind(&info.sha256_checksum)
            .bind(&backup_type).bind(source_device).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }.await;
    pool.close().await;
    if let Err(error) = metadata_result {
        if replaced_existing {
            let rollback = rollback_backup_destination(&destination, &previous, true);
            if let Err(rollback_error) = rollback {
                return Err(format!(
                    "BACKUP_METADATA_FAILED: {error}; ROLLBACK_FAILED: {rollback_error}"
                ));
            }
        } else {
            let _ = std::fs::remove_file(&destination);
        }
        return Err(format!("BACKUP_METADATA_FAILED_ROLLED_BACK: {error}"));
    }
    let _ = std::fs::remove_file(&previous);
    Ok(info)
}

/// The frontend closes its SQL pool before invoking this command.
#[tauri::command]
async fn restore_database(app: tauri::AppHandle, backup_path: String) -> Result<(), String> {
    use tauri::Manager;
    let backup = std::path::PathBuf::from(&backup_path);
    let candidate = validate_backup_path(&backup).await?; // no live-file mutation before this succeeds
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let active = dir.join("mep-finance.db");
    let current_pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&active))
        .await
        .map_err(|e| format!("CURRENT_DATABASE_NOT_READABLE: {e}"))?;
    let known_checksum: Option<String> = sqlx::query_scalar(
        "SELECT sha256_checksum FROM backups_log WHERE path=? AND sha256_checksum IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).bind(&backup_path).fetch_optional(&current_pool).await.map_err(|e| e.to_string())?;
    let source_device: String = sqlx::query_scalar(
        "SELECT COALESCE((SELECT value FROM settings WHERE key='device_id'),'unknown')",
    )
    .fetch_one(&current_pool)
    .await
    .unwrap_or_else(|_| "unknown".into());
    current_pool.close().await;
    verify_known_backup_checksum(known_checksum.as_deref(), &candidate.sha256_checksum)?;
    let backup_dir = dir.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let safety = backup_dir.join(format!("mep-finance-pre-restore-{stamp}.db"));
    let safety_info = create_sqlite_backup(&active, &safety).await?;
    let staged = dir.join("mep-finance.restore.staged");
    let previous = dir.join("mep-finance.restore.previous");
    let failed = dir.join("mep-finance.restore.failed");
    for path in [&staged, &previous, &failed] {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    std::fs::copy(&backup, &staged).map_err(|e| format!("RESTORE_STAGE_FAILED: {e}"))?;
    let staged_info = validate_backup_path(&staged).await?;
    if staged_info.sha256_checksum != candidate.sha256_checksum {
        let _ = std::fs::remove_file(&staged);
        return Err("RESTORE_STAGE_CHECKSUM_MISMATCH".into());
    }
    for suffix in ["-wal", "-shm"] {
        let side = dir.join(format!("mep-finance.db{suffix}"));
        if side.exists() {
            std::fs::remove_file(side).map_err(|e| format!("WAL_CLEANUP_FAILED: {e}"))?;
        }
    }
    atomic_replace(&active, &staged, &previous)?;
    let post_restore: Result<(),String> = async {
    validate_backup_path(&active).await?;
    let pool=sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&active)).await.map_err(|e|e.to_string())?;
    let result: Result<(),String> = async {
    let mut tx=pool.begin().await.map_err(|e|e.to_string())?;
    if candidate.database_version >= 14 {
        sqlx::query("INSERT INTO backups_log(path,kind,filename,database_version,application_version,sha256_checksum,backup_type,source_device) VALUES(?,'AUTO',?,?,?,?, 'SAFETY',?)")
            .bind(safety.to_string_lossy().to_string()).bind(&safety_info.filename).bind(safety_info.database_version).bind(CURRENT_APP_VERSION).bind(&safety_info.sha256_checksum).bind(&source_device).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO audit_logs(user_id,device_id,action,entity_type,after_json,reason,source,application_version) VALUES((SELECT value FROM settings WHERE key='sync_user_id'),?,'RESTORE','backup',json_object('checksum',?),'Validated database restore','RESTORE',?)")
            .bind(&source_device).bind(&candidate.sha256_checksum).bind(CURRENT_APP_VERSION).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    } else {
        let pending=serde_json::json!({"path":safety.to_string_lossy(),"filename":safety_info.filename,"databaseVersion":safety_info.database_version,"applicationVersion":CURRENT_APP_VERSION,"sha256Checksum":safety_info.sha256_checksum,"sourceDevice":source_device});
        sqlx::query("INSERT INTO settings(key,value) VALUES('pending_restore_safety',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(pending.to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO settings(key,value) VALUES('pending_restore_audit','1') ON CONFLICT(key) DO UPDATE SET value='1'").execute(&mut *tx).await.map_err(|e|e.to_string())?;
    }
    tx.commit().await.map_err(|e|e.to_string())?;
    Ok(())
    }.await;
    pool.close().await;
    result
    }.await;
    if let Err(error) = post_restore {
        let rollback = atomic_replace(&active, &previous, &failed);
        let _ = std::fs::remove_file(&failed);
        return match rollback {
            Ok(()) => Err(format!("RESTORE_VALIDATION_FAILED_ROLLED_BACK: {error}")),
            Err(r) => Err(format!(
                "RESTORE_VALIDATION_FAILED: {error}; ROLLBACK_FAILED: {r}"
            )),
        };
    }
    let _ = std::fs::remove_file(&previous);
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

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod financial_transaction_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// The certificate calculation exists in Rust (for the payment transaction
    /// that owns status) and in TypeScript (for the read model). Both assert
    /// this one fixture file so the two engines cannot drift; the TypeScript
    /// side is packages/core/tests/sharedFixtures.test.ts.
    #[test]
    fn certificate_fixtures_match_typescript() {
        let raw = include_str!("../../../../fixtures/certificate-financials.json");
        let fixtures: serde_json::Value = serde_json::from_str(raw).expect("fixture json");

        let net_cases = fixtures["netPayable"].as_array().expect("netPayable array");
        assert!(net_cases.len() >= 15, "net payable fixtures too thin");
        for case in net_cases {
            let name = case["name"].as_str().unwrap_or("unnamed");
            let manual = if case["manualRecoveryMinor"].is_null() {
                None
            } else {
                Some(case["manualRecoveryMinor"].as_i64().unwrap())
            };
            let (net, recovery, _base) = certificate_net_payable(
                case["grossMinor"].as_i64().unwrap(),
                case["discountMinor"].as_i64().unwrap(),
                case["vatBp"].as_i64().unwrap(),
                case["retentionBp"].as_i64().unwrap(),
                case["withholdingBp"].as_i64().unwrap(),
                case["advanceMinor"].as_i64().unwrap(),
                case["advanceMethod"].as_str().unwrap(),
                manual,
                case["contractValueMinor"].as_i64().unwrap(),
                case["recoveredBeforeMinor"].as_i64().unwrap(),
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(
                net,
                case["expectedNetPayableMinor"].as_i64().unwrap(),
                "net payable mismatch: {name}"
            );
            assert_eq!(
                recovery,
                case["expectedRecoveryMinor"].as_i64().unwrap(),
                "advance recovery mismatch: {name}"
            );
        }

        // The rounding rule underneath every figure above. Rust rounded the
        // signed value and truncated toward zero, so negatives landed one minor
        // unit away from what TypeScript produced; these cases pin the two
        // engines to the same function.
        let rounding_cases = fixtures["rounding"]["cases"]
            .as_array()
            .expect("rounding array");
        assert!(rounding_cases.len() >= 10, "rounding fixtures too thin");
        for case in rounding_cases {
            let name = case["name"].as_str().unwrap_or("unnamed");
            let actual = mul_div_round_i64(
                case["amount"].as_i64().unwrap(),
                case["numerator"].as_i64().unwrap(),
                case["denominator"].as_i64().unwrap(),
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(
                actual,
                case["expected"].as_i64().unwrap(),
                "rounding mismatch: {name}"
            );
        }

        let status_cases = fixtures["status"].as_array().expect("status array");
        assert!(status_cases.len() >= 19, "status fixtures too thin");
        for case in status_cases {
            let name = case["name"].as_str().unwrap_or("unnamed");
            let derived = derive_certificate_status(
                case["current"].as_str().unwrap(),
                case["netPayableMinor"].as_i64().unwrap(),
                case["allocatedMinor"].as_i64().unwrap(),
                case["baseMinor"].as_i64().unwrap(),
            );
            assert_eq!(
                derived,
                case["expected"].as_str().unwrap(),
                "status mismatch: {name}"
            );
        }
    }

    /// A migrated in-memory database with one certificate, so the PRODUCTION
    /// reconciliation path runs against the real schema and its triggers rather
    /// than the stub tables the rollback tests use.
    async fn reconciliation_fixture(
        gross_minor: i64,
        status: &str,
    ) -> (sqlx::SqlitePool, i64, i64) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&pool)
            .await
            .unwrap();
        for migration in [
            include_str!("../migrations/0001_baseline.sql"),
            include_str!("../migrations/0002_seed_reference_data.sql"),
            include_str!("../migrations/0003_assignment_lifecycle.sql"),
            include_str!("../migrations/0004_cancellation_evidence_integrity.sql"),
            include_str!("../migrations/0005_audit_version_baseline.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        sqlx::raw_sql(
            "INSERT INTO clients(name) VALUES('Reconcile Co');
             INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
               VALUES('REC-1','Reconcile',1,'EGP',1000000);
             INSERT INTO contracts(project_id,number,value_minor,signed_date)
               VALUES(1,'C-REC',1000000,'2026-01-01');
             INSERT INTO contract_revisions(contract_id,revision_number,effective_date,contract_value_minor,
               vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,
               currency,fx_rate_micro,reason,approved_at)
               VALUES(1,1,'2026-01-01',1000000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor,status,
               contract_revision_id,contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,
               withholding_bp_snapshot,advance_minor_snapshot,advance_method_snapshot,
               payment_terms_days_snapshot,currency_snapshot,fx_rate_micro_snapshot)
             VALUES(1,1,'PC-REC','2026-01-02',?,?,1,1000000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000)",
        )
        .bind(gross_minor)
        .bind(status)
        .execute(&pool)
        .await
        .unwrap();
        let certificate_id: i64 = sqlx::query_scalar("SELECT id FROM payment_certificates")
            .fetch_one(&pool)
            .await
            .unwrap();
        (pool, 1, certificate_id)
    }

    fn cash_payment(contract_id: i64, number: &str, amount_minor: i64) -> PaymentCommandInput {
        PaymentCommandInput {
            contract_id,
            kind: "CERTIFICATE".into(),
            number: number.into(),
            date: "2026-01-03".into(),
            amount_minor,
            method: "CASH".into(),
            bank: None,
            reference: None,
            notes: None,
        }
    }

    async fn status_of(pool: &sqlx::SqlitePool, certificate_id: i64) -> String {
        sqlx::query_scalar("SELECT status FROM payment_certificates WHERE id=?")
            .bind(certificate_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The production path end to end: Rust derives status from the evidence it
    /// just wrote, for settlement, reduction, reallocation and voiding.
    #[test]
    fn rust_settles_reopens_and_reallocates_certificates() {
        tauri::async_runtime::block_on(async {
            let (pool, contract, certificate) = reconciliation_fixture(10_000, "APPROVED").await;
            insert_payment_transaction(
                &pool,
                cash_payment(contract, "FULL", 10_000),
                vec![AllocationCommandInput {
                    certificate_id: certificate,
                    amount_minor: 10_000,
                }],
            )
            .await
            .unwrap();
            assert_eq!(status_of(&pool, certificate).await, "PAID");

            let payment_id: i64 = sqlx::query_scalar("SELECT id FROM payments")
                .fetch_one(&pool)
                .await
                .unwrap();

            // Editing the payment down reopens the certificate.
            replace_payment_transaction(
                &pool,
                payment_id,
                cash_payment(contract, "FULL", 6_000),
                vec![AllocationCommandInput {
                    certificate_id: certificate,
                    amount_minor: 6_000,
                }],
            )
            .await
            .unwrap();
            assert_eq!(status_of(&pool, certificate).await, "APPROVED");

            // Restoring full cover settles it again.
            replace_payment_transaction(
                &pool,
                payment_id,
                cash_payment(contract, "FULL", 10_000),
                vec![AllocationCommandInput {
                    certificate_id: certificate,
                    amount_minor: 10_000,
                }],
            )
            .await
            .unwrap();
            assert_eq!(status_of(&pool, certificate).await, "PAID");

            // Moving the payment to a second certificate must reopen the first.
            sqlx::query(
                "INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor,status,
                   contract_revision_id,contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,
                   withholding_bp_snapshot,advance_minor_snapshot,advance_method_snapshot,
                   payment_terms_days_snapshot,currency_snapshot,fx_rate_micro_snapshot)
                 VALUES(1,2,'PC-REC-2','2026-01-04',10000,'APPROVED',1,1000000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000)",
            )
            .execute(&pool)
            .await
            .unwrap();
            let second: i64 = sqlx::query_scalar("SELECT id FROM payment_certificates WHERE seq=2")
                .fetch_one(&pool)
                .await
                .unwrap();
            replace_payment_transaction(
                &pool,
                payment_id,
                cash_payment(contract, "FULL", 10_000),
                vec![AllocationCommandInput {
                    certificate_id: second,
                    amount_minor: 10_000,
                }],
            )
            .await
            .unwrap();
            assert_eq!(status_of(&pool, certificate).await, "APPROVED");
            assert_eq!(status_of(&pool, second).await, "PAID");

            // Voiding stops the evidence counting; history is kept.
            let mut tx = begin_immediate(&pool).await.unwrap();
            let touched = allocated_certificate_ids(&mut tx, payment_id)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE payments SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason='audit' WHERE id=?",
            )
            .bind(payment_id)
            .execute(&mut *tx)
            .await
            .unwrap();
            reconcile_certificates(&mut tx, &touched).await.unwrap();
            tx.commit().await.unwrap();
            assert_eq!(status_of(&pool, second).await, "APPROVED");
            let kept: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM payment_certificate_allocations")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(kept, 1);
        });
    }

    /// Partial cover must not settle, and collection must not bypass approval.
    #[test]
    fn rust_requires_full_cover_and_never_bypasses_approval() {
        tauri::async_runtime::block_on(async {
            let (pool, contract, certificate) = reconciliation_fixture(10_000, "APPROVED").await;
            insert_payment_transaction(
                &pool,
                cash_payment(contract, "PART", 9_999),
                vec![AllocationCommandInput {
                    certificate_id: certificate,
                    amount_minor: 9_999,
                }],
            )
            .await
            .unwrap();
            assert_eq!(status_of(&pool, certificate).await, "APPROVED");

            let (pool, contract, submitted) = reconciliation_fixture(10_000, "SUBMITTED").await;
            insert_payment_transaction(
                &pool,
                cash_payment(contract, "EARLY", 10_000),
                vec![AllocationCommandInput {
                    certificate_id: submitted,
                    amount_minor: 10_000,
                }],
            )
            .await
            .unwrap();
            // Fully collected, but nobody approved the claim.
            assert_eq!(status_of(&pool, submitted).await, "SUBMITTED");
        });
    }

    /// A draft holds no payable, so it can never receive an allocation.
    #[test]
    fn rust_refuses_allocations_against_a_draft_certificate() {
        tauri::async_runtime::block_on(async {
            let (pool, contract, draft) = reconciliation_fixture(10_000, "DRAFT").await;
            let result = insert_payment_transaction(
                &pool,
                cash_payment(contract, "DRAFT-PAY", 10_000),
                vec![AllocationCommandInput {
                    certificate_id: draft,
                    amount_minor: 10_000,
                }],
            )
            .await;
            assert_eq!(
                result.unwrap_err(),
                "ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE"
            );
            assert_eq!(status_of(&pool, draft).await, "DRAFT");
            let payments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payments")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(payments, 0);
        });
    }

    /// The schema — not only the command layer — keeps allocations bound to
    /// certificate payments in BOTH directions. That invariant is what makes
    /// the Rust reconciliation equivalent to the TypeScript read model, which
    /// additionally filters allocations on payment kind.
    #[test]
    fn schema_binds_allocations_to_certificate_payments() {
        tauri::async_runtime::block_on(async {
            let (pool, contract, certificate) = reconciliation_fixture(10_000, "APPROVED").await;

            // An advance payment cannot carry an allocation.
            sqlx::query(
                "INSERT INTO payments(contract_id,kind,number,date,amount_minor,method)
                 VALUES(?,'ADVANCE','ADV-1','2026-01-03',10000,'CASH')",
            )
            .bind(contract)
            .execute(&pool)
            .await
            .unwrap();
            let advance_id: i64 =
                sqlx::query_scalar("SELECT id FROM payments WHERE kind='ADVANCE'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let inserted = sqlx::query(
                "INSERT INTO payment_certificate_allocations(payment_id,certificate_id,amount_minor) VALUES(?,?,?)",
            )
            .bind(advance_id)
            .bind(certificate)
            .bind(10_000_i64)
            .execute(&pool)
            .await;
            assert!(
                inserted.is_err(),
                "an advance payment must not be able to carry an allocation"
            );

            // Nor can a payment that already carries one become an advance.
            insert_payment_transaction(
                &pool,
                cash_payment(contract, "CERT-1", 10_000),
                vec![AllocationCommandInput {
                    certificate_id: certificate,
                    amount_minor: 10_000,
                }],
            )
            .await
            .unwrap();
            let settled: i64 = sqlx::query_scalar("SELECT id FROM payments WHERE number='CERT-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
            let changed = sqlx::query("UPDATE payments SET kind='ADVANCE' WHERE id=?")
                .bind(settled)
                .execute(&pool)
                .await;
            assert!(
                changed.is_err(),
                "a payment carrying allocations must stay a certificate payment"
            );
        });
    }

    #[test]
    fn failed_allocation_rolls_back_inserted_payment() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("PRAGMA foreign_keys=ON")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE payments (id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL, kind TEXT NOT NULL, number TEXT NOT NULL, date TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT NOT NULL, bank TEXT, reference TEXT, notes TEXT, deleted_at TEXT)").execute(&pool).await.unwrap();
            sqlx::query("CREATE TABLE payment_certificates (id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL, deleted_at TEXT)").execute(&pool).await.unwrap();
            sqlx::query("CREATE TABLE payment_certificate_allocations (id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id), certificate_id INTEGER NOT NULL REFERENCES payment_certificates(id), amount_minor INTEGER NOT NULL)").execute(&pool).await.unwrap();

            let result = insert_payment_transaction(
                &pool,
                PaymentCommandInput {
                    contract_id: 7,
                    kind: "CERTIFICATE".into(),
                    number: "P-1".into(),
                    date: "2026-07-21".into(),
                    amount_minor: 10_000,
                    method: "CASH".into(),
                    bank: None,
                    reference: Some("receipt".into()),
                    notes: None,
                },
                vec![AllocationCommandInput {
                    certificate_id: 999,
                    amount_minor: 10_000,
                }],
            )
            .await;

            assert!(result.is_err());
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payments")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn failed_reallocation_restores_original_payment_and_allocation() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("PRAGMA foreign_keys=ON")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE payments (id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL, kind TEXT NOT NULL, number TEXT NOT NULL, date TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT NOT NULL, bank TEXT, reference TEXT, notes TEXT, deleted_at TEXT)").execute(&pool).await.unwrap();
            sqlx::query("CREATE TABLE payment_certificates (id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL, deleted_at TEXT)").execute(&pool).await.unwrap();
            sqlx::query("CREATE TABLE payment_certificate_allocations (id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id), certificate_id INTEGER NOT NULL REFERENCES payment_certificates(id), amount_minor INTEGER NOT NULL)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO payment_certificates (id,contract_id) VALUES (1,7)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO payments (id,contract_id,kind,number,date,amount_minor,method) VALUES (1,7,'CERTIFICATE','ORIGINAL','2026-07-20',10000,'CASH')").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (1,1,10000)").execute(&pool).await.unwrap();

            let result = replace_payment_transaction(
                &pool,
                1,
                PaymentCommandInput {
                    contract_id: 7,
                    kind: "CERTIFICATE".into(),
                    number: "CHANGED".into(),
                    date: "2026-07-21".into(),
                    amount_minor: 10_000,
                    method: "CASH".into(),
                    bank: None,
                    reference: None,
                    notes: None,
                },
                vec![AllocationCommandInput {
                    certificate_id: 999,
                    amount_minor: 10_000,
                }],
            )
            .await;

            assert!(result.is_err());
            let number: String = sqlx::query_scalar("SELECT number FROM payments WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
            let certificate_id: i64 = sqlx::query_scalar(
                "SELECT certificate_id FROM payment_certificate_allocations WHERE payment_id=1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(number, "ORIGINAL");
            assert_eq!(certificate_id, 1);
        });
    }

    async fn migrated_file(path: &std::path::Path) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        for migration in [
            include_str!("../migrations/0001_baseline.sql"),
            include_str!("../migrations/0002_seed_reference_data.sql"),
            include_str!("../migrations/0003_assignment_lifecycle.sql"),
            include_str!("../migrations/0004_cancellation_evidence_integrity.sql"),
            include_str!("../migrations/0005_audit_version_baseline.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        stamp_runtime_release(&pool).await.unwrap();
        pool.close().await;
    }

    /// v0.7.0 rebase regression: a backup taken from the retired 0001..0024
    /// development chain reports schema_version 24 exactly like a rebased
    /// database, so the version number cannot separate them. Restoring one
    /// would replace the live database with a file the migration plugin then
    /// refuses to open, leaving an app that will not start. Validation must
    /// reject it on lineage, before any file is touched.
    #[test]
    fn backup_validation_rejects_pre_rebase_migration_lineage() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let live = dir.path().join("live.db");
            std::fs::write(&live, b"CURRENT-DATA").unwrap();

            let legacy = dir.path().join("legacy.db");
            migrated_file(&legacy).await;
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&legacy))
                .await
                .unwrap();
            // Same schema and metadata a real pre-rebase backup carries, but
            // stamped with the retired chain's migration lineage.
            sqlx::raw_sql(
                "CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL,\
                 installed_on TEXT, success BOOLEAN NOT NULL, checksum BLOB, execution_time BIGINT);",
            )
            .execute(&pool)
            .await
            .unwrap();
            for (version, description) in [
                (1_i64, "initial_schema"),
                (24_i64, "dashboard_snapshot_audit"),
            ] {
                sqlx::query(
                    "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) \
                     VALUES(?,?,datetime('now'),1,X'00',0)",
                )
                .bind(version)
                .bind(description)
                .execute(&pool)
                .await
                .unwrap();
            }
            pool.close().await;

            assert_eq!(
                validate_backup_path(&legacy).await.unwrap_err(),
                "BACKUP_PREDATES_DATABASE_REBASE",
            );
            assert_eq!(std::fs::read(&live).unwrap(), b"CURRENT-DATA");

            // A rebased database with the current lineage still validates.
            let current = dir.path().join("current.db");
            migrated_file(&current).await;
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&current))
                .await
                .unwrap();
            sqlx::raw_sql(
                "CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL,\
                 installed_on TEXT, success BOOLEAN NOT NULL, checksum BLOB, execution_time BIGINT);",
            )
            .execute(&pool)
            .await
            .unwrap();
            for (version, description) in
                [(1_i64, "baseline_schema"), (2_i64, "seed_reference_data")]
            {
                sqlx::query(
                    "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) \
                     VALUES(?,?,datetime('now'),1,X'00',0)",
                )
                .bind(version)
                .bind(description)
                .execute(&pool)
                .await
                .unwrap();
            }
            pool.close().await;
            assert!(validate_backup_path(&current).await.is_ok());
        });
    }

    #[test]
    fn backup_validation_rejects_corrupt_and_wrong_databases_without_touching_live_file() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let live = dir.path().join("live.db");
            std::fs::write(&live, b"CURRENT-DATA").unwrap();
            let corrupt = dir.path().join("corrupt.db");
            std::fs::write(&corrupt, b"not sqlite").unwrap();
            assert!(validate_backup_path(&corrupt).await.is_err());
            assert_eq!(std::fs::read(&live).unwrap(), b"CURRENT-DATA");

            let wrong = dir.path().join("wrong.db");
            let pool = SqlitePoolOptions::new()
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&wrong)
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::query("CREATE TABLE unrelated(id INTEGER)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
            assert!(validate_backup_path(&wrong)
                .await
                .unwrap_err()
                .contains("BACKUP_WRONG_APPLICATION"));
            assert_eq!(std::fs::read(&live).unwrap(), b"CURRENT-DATA");
        });
    }

    #[test]
    fn runtime_release_rejects_schema_disagreement_without_stamping_version() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("schema-mismatch.db");
            migrated_file(&path).await;
            let pool = SqlitePoolOptions::new()
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
                .await
                .unwrap();

            sqlx::query("UPDATE app_metadata SET value='sentinel' WHERE key='application_version'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("UPDATE app_metadata SET value='22' WHERE key='schema_version'")
                .execute(&pool)
                .await
                .unwrap();
            assert!(stamp_runtime_release(&pool)
                .await
                .unwrap_err()
                .contains("SCHEMA_VERSION_MISMATCH"));
            let version: String = sqlx::query_scalar(
                "SELECT value FROM app_metadata WHERE key='application_version'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(version, "sentinel");

            sqlx::query("UPDATE app_metadata SET value='24' WHERE key='schema_version'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("PRAGMA user_version=22")
                .execute(&pool)
                .await
                .unwrap();
            assert!(stamp_runtime_release(&pool)
                .await
                .unwrap_err()
                .contains("SCHEMA_VERSION_MISMATCH"));
            let version: String = sqlx::query_scalar(
                "SELECT value FROM app_metadata WHERE key='application_version'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(version, "sentinel");
            pool.close().await;
        });
    }

    #[test]
    fn validated_backup_has_schema_and_checksum_and_atomic_replace_keeps_previous() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let active = dir.path().join("active.db");
            migrated_file(&active).await;
            let info = validate_backup_path(&active).await.unwrap();
            assert_eq!(info.database_version, CURRENT_SCHEMA_VERSION);
            assert_eq!(info.application_version, CURRENT_APP_VERSION);
            assert_eq!(info.sha256_checksum.len(), 64);

            let staged = dir.path().join("staged.db");
            std::fs::copy(&active, &staged).unwrap();
            let pool = SqlitePoolOptions::new()
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&staged))
                .await
                .unwrap();
            sqlx::query("INSERT INTO clients(name) VALUES('RESTORED')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
            let previous = dir.path().join("previous.db");
            atomic_replace(&active, &staged, &previous).unwrap();
            assert!(previous.exists());
            let restored = SqlitePoolOptions::new()
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&active))
                .await
                .unwrap();
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM clients WHERE name='RESTORED'")
                    .fetch_one(&restored)
                    .await
                    .unwrap();
            restored.close().await;
            assert_eq!(count, 1);
            assert!(validate_backup_path(&previous).await.is_ok());
        });
    }

    #[test]
    fn known_backup_checksum_rejects_tampering_but_allows_untracked_imports() {
        assert!(verify_known_backup_checksum(Some("recorded"), "changed").is_err());
        assert!(verify_known_backup_checksum(Some("same"), "same").is_ok());
        assert!(verify_known_backup_checksum(None, "external-valid-backup").is_ok());
    }

    #[test]
    fn failed_backup_metadata_can_restore_the_previous_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("backup.db");
        let staged = dir.path().join("staged.db");
        let previous = dir.path().join("previous.db");
        std::fs::write(&destination, b"old-known-good").unwrap();
        std::fs::write(&staged, b"new-uncommitted").unwrap();
        atomic_replace(&destination, &staged, &previous).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"new-uncommitted");
        rollback_backup_destination(&destination, &previous, true).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"old-known-good");
    }

    #[test]
    fn argon2_lock_credentials_verify_without_storing_passwords() {
        let credential = make_argon2_credential("correct horse battery staple").unwrap();
        assert!(credential.starts_with("$argon2id$"));
        assert!(!credential.contains("correct horse battery staple"));
        assert!(verify_argon2("correct horse battery staple", &credential));
        assert!(!verify_argon2("wrong", &credential));
        assert!(!verify_argon2("anything", "corrupt-credential"));
    }

    #[test]
    fn legacy_pbkdf2_requires_complete_well_formed_state() {
        let salt = [7_u8; 16];
        let mut output = [0_u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"legacy-password", &salt, 100_000, &mut output);
        let hash = output
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let salt_hex = salt
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert!(verify_legacy_pbkdf2("legacy-password", &hash, &salt_hex));
        assert!(!verify_legacy_pbkdf2("wrong", &hash, &salt_hex));
        assert!(!verify_legacy_pbkdf2(
            "legacy-password",
            "broken",
            &salt_hex
        ));
        assert!(!verify_legacy_pbkdf2("legacy-password", &hash, ""));
    }

    #[test]
    fn failed_lock_attempts_enforce_increasing_delays() {
        let throttle = LockThrottle::default();
        assert!(enforce_lock_throttle(&throttle).is_ok());
        note_lock_result(&throttle, false).unwrap();
        assert!(enforce_lock_throttle(&throttle)
            .unwrap_err()
            .starts_with("LOCK_RETRY_AFTER:"));
        note_lock_result(&throttle, true).unwrap();
        assert!(enforce_lock_throttle(&throttle).is_ok());
    }

    #[test]
    fn sync_mutation_sql_is_restricted_to_one_registered_business_table() {
        assert!(validate_sync_mutation_sql("UPDATE clients SET name=$1 WHERE id=$2").is_ok());
        assert!(
            validate_sync_mutation_sql("INSERT INTO expenses(amount_minor) VALUES($1)").is_ok()
        );
        assert!(validate_sync_mutation_sql("DELETE FROM time_entries WHERE id=$1").is_ok());
        assert!(validate_sync_mutation_sql("UPDATE audit_context SET source='SYNC'").is_err());
        assert!(
            validate_sync_mutation_sql("UPDATE clients SET name='x'; DELETE FROM clients").is_err()
        );
        assert!(validate_sync_mutation_sql("PRAGMA foreign_keys=OFF").is_err());
        let query = sqlx::query("UPDATE clients SET name=$1");
        assert!(bind_json_value(query, JsonValue::from(1.25)).is_err());
    }

    #[test]
    fn sync_table_risk_mapping_classifies_every_mutable_table() {
        assert_eq!(SYNC_TABLE_POLICIES.len(), 17);

        let simple = [
            "clients",
            "expense_categories",
            "project_stages",
            "documents",
            "time_entries",
        ];
        for table in simple {
            assert_eq!(
                sync_table_policy(table).map(|policy| policy.risk),
                Some(SyncTableRisk::SimpleMasterData)
            );
        }

        let protected = [
            "people",
            "projects",
            "contracts",
            "project_assignments",
            "expenses",
            "recurring_expenses",
        ];
        for table in protected {
            assert_eq!(
                sync_table_policy(table).map(|policy| policy.risk),
                Some(SyncTableRisk::FinanciallyProtectedData)
            );
        }

        let evidence = [
            "contract_revisions",
            "variation_orders",
            "payment_certificates",
            "payments",
            "payment_certificate_allocations",
            "person_payments",
        ];
        for table in evidence {
            assert_eq!(
                sync_table_policy(table).map(|policy| policy.risk),
                Some(SyncTableRisk::ImmutableOrEventEvidence)
            );
        }
    }

    #[test]
    fn sync_table_risk_mapping_is_the_mutation_allowlist() {
        assert!(sync_table_policy("audit_logs").is_none());
        assert!(validate_sync_mutation_sql("UPDATE audit_logs SET action=$1").is_err());
        assert!(validate_sync_mutation_sql(
            "UPDATE payment_certificates SET status=$1 WHERE id=$2"
        )
        .is_ok());
    }

    #[test]
    fn sync_mutation_and_audit_source_commit_or_roll_back_together() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("CREATE TABLE audit_context(id INTEGER PRIMARY KEY,source TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO audit_context(id,source) VALUES(1,'DESKTOP')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO clients(id,name) VALUES(1,'Before')")
                .execute(&pool)
                .await
                .unwrap();

            execute_sync_mutation_transaction(
                &pool,
                "UPDATE clients SET name=$1 WHERE id=$2",
                vec![JsonValue::String("After".into()), JsonValue::from(1)],
            )
            .await
            .unwrap();
            let name: String = sqlx::query_scalar("SELECT name FROM clients WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
            let source: String = sqlx::query_scalar("SELECT source FROM audit_context WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(name, "After");
            assert_eq!(source, "DESKTOP");

            sqlx::query(
                "CREATE TRIGGER reject_client BEFORE UPDATE ON clients WHEN NEW.name='Rejected' BEGIN SELECT RAISE(ABORT,'test rejection'); END",
            )
            .execute(&pool)
            .await
            .unwrap();
            let failed = execute_sync_mutation_transaction(
                &pool,
                "UPDATE clients SET name=$1 WHERE id=$2",
                vec![JsonValue::String("Rejected".into()), JsonValue::from(1)],
            )
            .await;
            assert!(failed.is_err());
            let name: String = sqlx::query_scalar("SELECT name FROM clients WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
            let source: String = sqlx::query_scalar("SELECT source FROM audit_context WHERE id=1")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(name, "After");
            assert_eq!(source, "DESKTOP");
        });
    }

    #[test]
    fn managed_document_cache_is_hashed_versioned_and_path_safe() {
        let root = tempfile::tempdir().unwrap();
        let destination = managed_document_destination(
            root.path(),
            "11111111-1111-4111-8111-111111111111",
            2,
            "design.pdf",
        )
        .unwrap();
        let result = write_managed_document(&destination, b"approved drawing", None).unwrap();
        assert_eq!(result.original_filename, "design.pdf");
        assert_eq!(result.extension.as_deref(), Some("pdf"));
        assert_eq!(result.mime_type, "application/pdf");
        assert_eq!(result.size_bytes, 16);
        assert_eq!(result.sha256.len(), 64);
        assert_eq!(std::fs::read(&destination).unwrap(), b"approved drawing");
        let replacement = write_managed_document(&destination, b"revised drawing", None).unwrap();
        assert_ne!(replacement.sha256, result.sha256);
        assert_eq!(std::fs::read(&destination).unwrap(), b"revised drawing");
        assert!(!destination.with_extension("namaa-old").exists());
        assert!(managed_document_destination(root.path(), "../escape", 1, "x.pdf").is_err());
        assert!(managed_document_destination(root.path(), "safe", 0, "x.pdf").is_err());
    }

    #[test]
    fn cloud_cache_rejects_checksum_mismatch_without_writing_a_file() {
        let root = tempfile::tempdir().unwrap();
        let destination = managed_document_destination(root.path(), "safe-id", 1, "x.dwg").unwrap();
        let result = write_managed_document(&destination, b"tampered", Some(&"0".repeat(64)));
        assert_eq!(result.unwrap_err(), "DOCUMENT_CHECKSUM_MISMATCH");
        assert!(!destination.exists());
    }

    /// The four write batches moved out of the WebView.
    ///
    /// These used to open their transaction from JavaScript, which does not
    /// work: `tauri-plugin-sql` releases the pooled connection between
    /// statements, so the boundary was stranded on a shared connection instead
    /// of belonging to the caller. They live here now, and so does their
    /// coverage — the browser suite cannot execute any of this.
    async fn migrated_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&pool)
            .await
            .unwrap();
        for migration in [
            include_str!("../migrations/0001_baseline.sql"),
            include_str!("../migrations/0002_seed_reference_data.sql"),
            include_str!("../migrations/0003_assignment_lifecycle.sql"),
            include_str!("../migrations/0004_cancellation_evidence_integrity.sql"),
            include_str!("../migrations/0005_audit_version_baseline.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        pool
    }

    /// Milestone 2 regression, in the engine that actually runs the migrations.
    ///
    /// The schema-27 migration once rewrote historical audit rows. Because
    /// `prevent_audit_update` allows only finalising a fresh row and binding a
    /// NULL entity_uuid, that statement raised AUDIT_LOG_IMMUTABLE on any
    /// database holding a finalized 0.6.x-stamped row: the migration aborted
    /// and user_version stayed at 26, leaving a database that could never be
    /// opened. The migration must upgrade such a database, keep the historical
    /// stamp (it is true for the binary that wrote it), and stamp everything
    /// afterwards with the shipping version.
    #[test]
    fn schema_27_upgrades_a_database_holding_finalized_legacy_audit_rows() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("PRAGMA foreign_keys=ON")
                .execute(&pool)
                .await
                .unwrap();
            for migration in [
                include_str!("../migrations/0001_baseline.sql"),
                include_str!("../migrations/0002_seed_reference_data.sql"),
                include_str!("../migrations/0003_assignment_lifecycle.sql"),
                include_str!("../migrations/0004_cancellation_evidence_integrity.sql"),
            ] {
                sqlx::raw_sql(migration).execute(&pool).await.unwrap();
            }
            let schema: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(schema, 26, "fixture must start at schema 26");

            // A real, finalized audit row carrying the retired default.
            sqlx::query("INSERT INTO clients(name) VALUES('Legacy Audit Row')")
                .execute(&pool)
                .await
                .unwrap();
            let (legacy_version, finalized): (String, i64) = sqlx::query_as(
                "SELECT application_version, finalized FROM audit_logs ORDER BY id LIMIT 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(finalized, 1, "the row must be finalized to reproduce");
            assert!(
                legacy_version.starts_with("0.6."),
                "expected a retired 0.6.x stamp, got {legacy_version}"
            );

            // The migration must apply rather than abort.
            sqlx::raw_sql(include_str!(
                "../migrations/0005_audit_version_baseline.sql"
            ))
            .execute(&pool)
            .await
            .expect("schema 27 migration must apply over finalized legacy audit rows");

            let schema: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(schema, CURRENT_SCHEMA_VERSION);

            // The historical row keeps the version that wrote it.
            let preserved: String = sqlx::query_scalar(
                "SELECT application_version FROM audit_logs ORDER BY id LIMIT 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(preserved, legacy_version);

            // Everything written afterwards carries the shipping version.
            let context: String =
                sqlx::query_scalar("SELECT application_version FROM audit_context WHERE id=1")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(context, CURRENT_APP_VERSION);
            sqlx::query("INSERT INTO clients(name) VALUES('After Upgrade')")
                .execute(&pool)
                .await
                .unwrap();
            let newest: String = sqlx::query_scalar(
                "SELECT application_version FROM audit_logs ORDER BY id DESC LIMIT 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(newest, CURRENT_APP_VERSION);

            // Immutability is intact: the migration bought nothing by weakening it.
            let update =
                sqlx::query("UPDATE audit_logs SET application_version='9.9.9' WHERE id=1")
                    .execute(&pool)
                    .await;
            assert!(update
                .unwrap_err()
                .to_string()
                .contains("AUDIT_LOG_IMMUTABLE"));
            let delete = sqlx::query("DELETE FROM audit_logs WHERE id=1")
                .execute(&pool)
                .await;
            assert!(delete
                .unwrap_err()
                .to_string()
                .contains("AUDIT_LOG_IMMUTABLE"));
        });
    }

    /// A fresh database starts with no fabricated audit activity: reference-data
    /// seeding runs before the audit triggers exist.
    #[test]
    fn fresh_schema_27_database_starts_with_an_empty_audit_log() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let schema: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(schema, CURRENT_SCHEMA_VERSION);
            let audit_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(audit_rows, 0);
            let categories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM expense_categories")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert!(categories > 0, "reference data must still be seeded");
            let context: String =
                sqlx::query_scalar("SELECT application_version FROM audit_context WHERE id=1")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(context, CURRENT_APP_VERSION);
        });
    }

    async fn assignment_row(pool: &sqlx::SqlitePool, id: i64) -> (String, Option<i64>) {
        sqlx::query_as(
            "SELECT lifecycle_status, earned_minor_at_cancellation FROM project_assignments WHERE id=?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// A project whose single certificate can be paid, so a real released
    /// figure exists to derive.
    async fn payout_fixture(pool: &sqlx::SqlitePool, agreed_minor: i64) -> (i64, i64) {
        sqlx::raw_sql(
            "INSERT INTO clients(name) VALUES('Payout Co');
             INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
             VALUES('PRJ-2026-500','Payout',1,'EGP',1000000);
             INSERT INTO contracts(project_id,number,value_minor,signed_date,vat_bp,retention_bp,
                 withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,valuation_mode)
             VALUES(1,'C-PAY',100000,'2026-01-01',0,0,0,0,'PROPORTIONAL',30,'LUMP_SUM');
             INSERT INTO contract_revisions(contract_id,revision_number,effective_date,
                 contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,
                 advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
             VALUES(1,1,'2026-01-01',100000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
             INSERT INTO people(type,name,currency) VALUES('FREELANCER','Someone','EGP');",
        )
        .execute(pool)
        .await
        .unwrap();
        let assignment = sqlx::query(
            "INSERT INTO project_assignments(person_id,project_id,agreed_minor,currency,fx_rate_micro)
             VALUES(1,1,?,'EGP',1000000)",
        )
        .bind(agreed_minor)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid();
        (assignment, 1)
    }

    async fn add_certificate(
        pool: &sqlx::SqlitePool,
        seq: i64,
        number: &str,
        gross: i64,
        status: &str,
    ) -> i64 {
        sqlx::query(
            "INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor,status)
             VALUES(1,?,?,'2026-02-01',?,?)",
        )
        .bind(seq)
        .bind(number)
        .bind(gross)
        .bind(status)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    /// The figure is derived from evidence, not supplied.
    ///
    /// It used to arrive as a command argument that Rust could only bound-check,
    /// so a wrong value could look plausible and be frozen forever — and
    /// migration 0004 makes it final. The payout schedule is now ported, and
    /// fixtures/team-payout.json holds both engines to the same arithmetic.
    #[test]
    fn cancellation_derives_the_frozen_figure_from_paid_certificates() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let (assignment, _) = payout_fixture(&pool, 40_000).await;

            // Nothing certified yet: the whole contract value is one pending
            // remainder stage, so nothing is released.
            let mut tx = begin_immediate(&pool).await.unwrap();
            assert_eq!(
                assignment_released_minor(&mut tx, 1, 40_000).await.unwrap(),
                0
            );
            tx.commit().await.unwrap();

            // Half the contract certified and PAID releases half the fee.
            add_certificate(&pool, 1, "PC-1", 50_000, "PAID").await;
            let mut tx = begin_immediate(&pool).await.unwrap();
            assert_eq!(
                assignment_released_minor(&mut tx, 1, 40_000).await.unwrap(),
                20_000
            );
            tx.commit().await.unwrap();

            // An APPROVED certificate is not collected, so it releases nothing.
            add_certificate(&pool, 2, "PC-2", 50_000, "APPROVED").await;
            let mut tx = begin_immediate(&pool).await.unwrap();
            assert_eq!(
                assignment_released_minor(&mut tx, 1, 40_000).await.unwrap(),
                20_000
            );
            tx.commit().await.unwrap();

            cancel_assignment_transaction(&pool, assignment, "  Client withdrew  ")
                .await
                .unwrap();
            let (lifecycle, frozen) = assignment_row(&pool, assignment).await;
            assert_eq!(lifecycle, "CANCELLED");
            assert_eq!(
                frozen,
                Some(20_000),
                "frozen at what the client had paid for"
            );

            let reason: String = sqlx::query_scalar(
                "SELECT cancellation_reason FROM project_assignments WHERE id=?",
            )
            .bind(assignment)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                reason, "Client withdrew",
                "reason is trimmed before storing"
            );
        });
    }

    /// A draft certificate owes nothing, but it still occupies a payout stage —
    /// its base is part of the split. Zeroing it in Rust while the TypeScript
    /// engine weights by it would hand the two engines different stage weights.
    #[test]
    fn a_draft_certificate_still_carries_its_stage_weight() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            payout_fixture(&pool, 40_000).await;
            add_certificate(&pool, 1, "PC-PAID", 50_000, "PAID").await;
            add_certificate(&pool, 2, "PC-DRAFT", 50_000, "DRAFT").await;

            let mut tx = begin_immediate(&pool).await.unwrap();
            let released = assignment_released_minor(&mut tx, 1, 40_000).await.unwrap();
            tx.commit().await.unwrap();
            // Two stages of equal base: the paid one releases exactly half. If
            // the draft's base were dropped, the paid stage would absorb the
            // remainder and release the whole fee.
            assert_eq!(released, 20_000);
        });
    }

    /// A second contract, on its own project, with commercial terms that differ
    /// from `payout_fixture`'s in every snapshot column.
    async fn foreign_contract(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::raw_sql(
            "INSERT INTO clients(name) VALUES('Other Co');
             INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
             VALUES('PRJ-2026-900','Other',2,'USD',48000000);
             INSERT INTO contracts(project_id,number,value_minor,signed_date,vat_bp,retention_bp,
                 withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,valuation_mode)
             VALUES(2,'C-OTHER',500000,'2026-01-01',1400,500,300,50000,'PROPORTIONAL',90,'LUMP_SUM');
             INSERT INTO contract_revisions(contract_id,revision_number,effective_date,
                 contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,
                 advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
             VALUES(2,1,'2026-01-01',500000,1400,500,300,50000,'PROPORTIONAL',90,'USD',48000000,'Initial',datetime('now'));",
        )
        .execute(pool)
        .await
        .unwrap();
        2
    }

    fn edit_input(contract_id: i64, gross_minor: i64) -> CertificateCommandInput {
        CertificateCommandInput {
            contract_id,
            date: "2026-02-01".into(),
            submission_date: None,
            due_date_override: None,
            due_date_confirmed: false,
            description: None,
            gross_minor,
            discount_minor: 0,
            manual_advance_recovery_minor: None,
            status: "DRAFT".into(),
        }
    }

    /// Audit regression: a certificate is located by id, so a caller-supplied
    /// contract id that disagrees with the stored one would bind a *foreign*
    /// contract's approved revision — VAT, retention, withholding, advance,
    /// payment terms, currency and historical FX — onto it, while the row stayed
    /// filed under its own contract. Terms and FX would silently become another
    /// contract's.
    #[test]
    fn a_certificate_cannot_be_bound_to_another_contracts_revision() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            payout_fixture(&pool, 40_000).await;
            let foreign = foreign_contract(&pool).await;
            let certificate = add_certificate(&pool, 1, "PC-1", 50_000, "DRAFT").await;

            let snapshot = |pool: sqlx::SqlitePool| async move {
                sqlx::query_as::<_, (i64, i64, i64, i64, i64, String, i64)>(
                    "SELECT contract_id,vat_bp_snapshot,retention_bp_snapshot,withholding_bp_snapshot,
                            advance_minor_snapshot,currency_snapshot,fx_rate_micro_snapshot
                     FROM payment_certificates WHERE id=?",
                )
                .bind(certificate)
                .fetch_one(&pool)
                .await
                .unwrap()
            };
            let before = snapshot(pool.clone()).await;

            let rejected = update_certificate_transaction(
                &pool,
                certificate,
                "PC-1".into(),
                edit_input(foreign, 60_000),
            )
            .await;
            assert_eq!(rejected.unwrap_err(), "CERTIFICATE_CONTRACT_MISMATCH");

            // Nothing moved: not the terms, not the FX, not the amount.
            assert_eq!(snapshot(pool.clone()).await, before);
            let gross: i64 =
                sqlx::query_scalar("SELECT gross_minor FROM payment_certificates WHERE id=?")
                    .bind(certificate)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(gross, 50_000);
        });
    }

    /// Audit regression: every certificate read path excludes archived
    /// contracts and projects, so a certificate written against one is
    /// invisible — never listed, never reconciled, never covered by the
    /// allocation-integrity check. Archived has to mean read-only.
    #[test]
    fn an_archived_contract_or_project_is_read_only_for_certificates() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            payout_fixture(&pool, 40_000).await;
            let certificate = add_certificate(&pool, 1, "PC-1", 50_000, "DRAFT").await;

            let writable = |pool: sqlx::SqlitePool| async move {
                let mut tx = begin_immediate(&pool).await.unwrap();
                let result = assert_contract_writable(&mut tx, 1).await;
                tx.commit().await.unwrap();
                result
            };

            // A live contract on a live project is writable.
            assert!(writable(pool.clone()).await.is_ok());

            sqlx::query("UPDATE contracts SET archived_at=datetime('now') WHERE id=1")
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                writable(pool.clone()).await.unwrap_err(),
                "ARCHIVED_CONTRACT_IS_READ_ONLY"
            );
            assert_eq!(
                update_certificate_transaction(
                    &pool,
                    certificate,
                    "PC-1".into(),
                    edit_input(1, 60_000)
                )
                .await
                .unwrap_err(),
                "ARCHIVED_CONTRACT_IS_READ_ONLY",
            );

            // The project alone being archived is equally read-only.
            sqlx::query("UPDATE contracts SET archived_at=NULL WHERE id=1")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("UPDATE projects SET archived_at=datetime('now') WHERE id=1")
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                writable(pool.clone()).await.unwrap_err(),
                "ARCHIVED_CONTRACT_IS_READ_ONLY"
            );

            // The rejected edit left the certificate exactly as it was.
            let gross: i64 =
                sqlx::query_scalar("SELECT gross_minor FROM payment_certificates WHERE id=?")
                    .bind(certificate)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(gross, 50_000);

            // A contract that does not exist is not silently writable either.
            let mut tx = begin_immediate(&pool).await.unwrap();
            let missing = assert_contract_writable(&mut tx, 9_999).await;
            tx.commit().await.unwrap();
            assert_eq!(missing.unwrap_err(), "CONTRACT_NOT_FOUND");
        });
    }

    /// Milestone 3: the payable ceiling is derived in Rust, never trusted from
    /// the caller. A rejected payment must leave neither a person payment nor
    /// its linked expense behind.
    #[test]
    fn person_payment_is_capped_at_the_lifecycle_aware_amount_due() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let (assignment, _) = payout_fixture(&pool, 100_000).await;
            // Half the contract is collected, so half the agreed fee is earned.
            add_certificate(&pool, 1, "PC-EARN", 50_000, "PAID").await;
            add_certificate(&pool, 2, "PC-OPEN", 50_000, "APPROVED").await;

            let over = create_person_payment_transaction(
                &pool,
                PersonPaymentCommandInput {
                    assignment_id: assignment,
                    date: "2026-07-10".into(),
                    amount_minor: 50_001,
                    note: Some("too much".into()),
                },
            )
            .await;
            assert_eq!(over.unwrap_err(), "PERSON_PAYMENT_EXCEEDS_DUE");
            let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM person_payments")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(rows, 0, "a rejected payment must not be recorded");
            let expenses: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM expenses WHERE person_payment_id IS NOT NULL",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(expenses, 0, "a rejected payment must not create an expense");

            // Exactly the due amount is accepted.
            create_person_payment_transaction(
                &pool,
                PersonPaymentCommandInput {
                    assignment_id: assignment,
                    date: "2026-07-10".into(),
                    amount_minor: 50_000,
                    note: Some("in full".into()),
                },
            )
            .await
            .unwrap();

            // Nothing further is payable while nothing is due.
            let again = create_person_payment_transaction(
                &pool,
                PersonPaymentCommandInput {
                    assignment_id: assignment,
                    date: "2026-07-11".into(),
                    amount_minor: 1,
                    note: Some("more".into()),
                },
            )
            .await;
            assert_eq!(again.unwrap_err(), "PERSON_PAYMENT_EXCEEDS_DUE");
        });
    }

    /// A cancelled assignment earns the frozen figure, so certificates the
    /// client pays afterwards cannot fund further payment; an archived one
    /// takes no new payment at all.
    #[test]
    fn cancelled_and_archived_assignments_bound_further_payment() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let (assignment, _) = payout_fixture(&pool, 100_000).await;
            add_certificate(&pool, 1, "PC-EARN", 40_000, "PAID").await;
            add_certificate(&pool, 2, "PC-LATER", 60_000, "APPROVED").await;
            cancel_assignment_transaction(&pool, assignment, "Called off")
                .await
                .unwrap();

            // The rest of the contract is collected AFTER cancellation.
            sqlx::query("UPDATE payment_certificates SET status='PAID' WHERE number='PC-LATER'")
                .execute(&pool)
                .await
                .unwrap();

            // Still capped at the frozen 40_000.
            let over = create_person_payment_transaction(
                &pool,
                PersonPaymentCommandInput {
                    assignment_id: assignment,
                    date: "2026-07-12".into(),
                    amount_minor: 40_001,
                    note: None,
                },
            )
            .await;
            assert_eq!(over.unwrap_err(), "PERSON_PAYMENT_EXCEEDS_DUE");

            create_person_payment_transaction(
                &pool,
                PersonPaymentCommandInput {
                    assignment_id: assignment,
                    date: "2026-07-12".into(),
                    amount_minor: 40_000,
                    note: None,
                },
            )
            .await
            .unwrap();

            // Archiving stops new operational actions.
            sqlx::query("UPDATE project_assignments SET archived_at=datetime('now') WHERE id=?")
                .bind(assignment)
                .execute(&pool)
                .await
                .unwrap();
            let archived = create_person_payment_transaction(
                &pool,
                PersonPaymentCommandInput {
                    assignment_id: assignment,
                    date: "2026-07-13".into(),
                    amount_minor: 1,
                    note: None,
                },
            )
            .await;
            assert_eq!(archived.unwrap_err(), "ARCHIVED_ASSIGNMENT_CANNOT_BE_PAID");
        });
    }

    #[test]
    fn cancellation_is_refused_twice_and_needs_a_reason() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let (assignment, _) = payout_fixture(&pool, 40_000).await;

            assert_eq!(
                cancel_assignment_transaction(&pool, assignment, "   ")
                    .await
                    .unwrap_err(),
                "CANCELLATION_REASON_REQUIRED"
            );
            assert_eq!(
                cancel_assignment_transaction(&pool, 9_999, "Called off")
                    .await
                    .unwrap_err(),
                "ASSIGNMENT_NOT_FOUND"
            );
            assert_eq!(assignment_row(&pool, assignment).await.0, "ACTIVE");

            cancel_assignment_transaction(&pool, assignment, "Called off")
                .await
                .unwrap();
            assert_eq!(
                cancel_assignment_transaction(&pool, assignment, "again")
                    .await
                    .unwrap_err(),
                "ASSIGNMENT_ALREADY_CANCELLED"
            );
            // The refused second attempt rewrote nothing.
            assert_eq!(assignment_row(&pool, assignment).await.1, Some(0));
        });
    }

    /// The allocation arithmetic the payout schedule stands on, asserted
    /// against the same file the TypeScript engine asserts.
    ///
    /// `computeTeamPayout` now exists twice, because cancellation derives the
    /// figure it freezes. Allocation is where a port drifts: flooring, then
    /// giving leftover units to the largest remainders with ties broken by
    /// index, is easy to get almost right — and "almost" freezes a figure a
    /// piastre off that migration 0004 then makes permanent.
    #[test]
    fn team_payout_fixtures_match_typescript() {
        let raw = include_str!("../../../../fixtures/team-payout.json");
        let fixtures: serde_json::Value = serde_json::from_str(raw).expect("fixture json");

        let allocate_cases = fixtures["allocate"].as_array().expect("allocate array");
        assert!(allocate_cases.len() >= 12, "allocate fixtures too thin");
        for case in allocate_cases {
            let name = case["name"].as_str().unwrap_or("unnamed");
            let total = case["total"].as_i64().unwrap();
            let weights: Vec<i64> = case["weights"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap())
                .collect();
            let expected: Vec<i64> = case["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap())
                .collect();
            let actual = allocate_largest_remainder(total, &weights)
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(actual, expected, "allocation mismatch: {name}");
            // The property the schedule depends on: nothing is left behind.
            assert_eq!(
                actual.iter().sum::<i64>(),
                total,
                "allocation lost or invented units: {name}"
            );
        }

        let milestone_cases = fixtures["milestoneAmounts"]
            .as_array()
            .expect("milestoneAmounts array");
        assert!(milestone_cases.len() >= 5, "milestone fixtures too thin");
        for case in milestone_cases {
            let name = case["name"].as_str().unwrap_or("unnamed");
            let value = case["valueMinor"].as_i64().unwrap();
            let percents: Vec<i64> = case["percentsBp"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item.as_i64().unwrap())
                .collect();
            let expected: Vec<i64> = case["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item.as_i64().unwrap())
                .collect();
            let actual = milestone_amounts(value, &percents)
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(actual, expected, "milestone amount mismatch: {name}");
        }

        let payout_cases = fixtures["payoutSchedules"]
            .as_array()
            .expect("payoutSchedules array");
        assert!(payout_cases.len() >= 3, "payout schedule fixtures too thin");
        for case in payout_cases {
            let name = case["name"].as_str().unwrap_or("unnamed");
            let agreed = case["agreedMinor"].as_i64().unwrap();
            let paid_out = case["personPaidMinor"].as_i64().unwrap();
            let stages = case["expectedStages"].as_array().unwrap();
            let weights: Vec<i64> = stages
                .iter()
                .map(|stage| stage["weightMinor"].as_i64().unwrap())
                .collect();
            let amounts = allocate_largest_remainder(agreed, &weights).unwrap();
            let released: i64 = stages
                .iter()
                .enumerate()
                .filter(|(_, stage)| {
                    matches!(stage["status"].as_str(), Some("PAYABLE" | "PAID_OUT"))
                })
                .map(|(index, _)| amounts[index])
                .sum();
            assert_eq!(
                released,
                case["expectedReleasedMinor"].as_i64().unwrap(),
                "released mismatch: {name}"
            );
            assert_eq!(
                released.saturating_sub(paid_out).max(0),
                case["expectedDueMinor"].as_i64().unwrap(),
                "due mismatch: {name}"
            );
        }
    }

    /// A milestone contract splits the fee by the milestone plan, and a stage is
    /// released only when the certificate that milestone generated is PAID.
    #[test]
    fn milestone_contracts_release_by_milestone_not_by_certificate_order() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            payout_fixture(&pool, 40_000).await;
            let paid = add_certificate(&pool, 1, "MS-1", 50_000, "PAID").await;
            let approved = add_certificate(&pool, 2, "MS-2", 50_000, "APPROVED").await;
            // A 50/50 plan whose first milestone is linked to the paid
            // certificate.
            let milestones = format!(
                r#"[{{"title":"A","percentBp":5000,"certificateId":{paid}}},
                    {{"title":"B","percentBp":5000,"certificateId":{approved}}}]"#
            );
            sqlx::query(
                "UPDATE contracts SET valuation_mode='MILESTONES', milestones=? WHERE id=1",
            )
            .bind(&milestones)
            .execute(&pool)
            .await
            .unwrap();

            let mut tx = begin_immediate(&pool).await.unwrap();
            let released = assignment_released_minor(&mut tx, 1, 40_000).await.unwrap();
            tx.commit().await.unwrap();
            assert_eq!(released, 20_000, "only the paid milestone releases");
        });
    }

    /// A corrupt milestone list must not silently fall through to the
    /// certificate schedule: that would freeze a figure computed from entirely
    /// different stages.
    #[test]
    fn a_corrupt_milestone_plan_is_refused_rather_than_ignored() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let (assignment, _) = payout_fixture(&pool, 40_000).await;
            add_certificate(&pool, 1, "PC-1", 50_000, "PAID").await;
            sqlx::query(
                "UPDATE contracts SET valuation_mode='MILESTONES', milestones='{oops' WHERE id=1",
            )
            .execute(&pool)
            .await
            .unwrap();

            let error = cancel_assignment_transaction(&pool, assignment, "Called off")
                .await
                .unwrap_err();
            assert_eq!(error, "MILESTONES_INVALID_JSON");
            // Nothing frozen, assignment still live.
            let (lifecycle, frozen) = assignment_row(&pool, assignment).await;
            assert_eq!(lifecycle, "ACTIVE");
            assert_eq!(frozen, None);
        });
    }

    #[test]
    fn milestone_shape_validation_matches_the_typescript_schema() {
        for invalid in [
            r#"[{"percentBp":10000}]"#,
            r#"[{"title":"A","percentBp":10000,"done":"yes"}]"#,
            r#"[{"title":"A","percentBp":10000,"stageId":1.5}]"#,
            r#"[{"title":"A","percentBp":9007199254740992}]"#,
            r#"[{"title":"A","percentBp":10000,"certificateId":1.5}]"#,
        ] {
            assert_eq!(
                parse_milestones(Some(invalid)).unwrap_err(),
                "MILESTONES_INVALID_SHAPE",
                "accepted {invalid}"
            );
        }
        assert_eq!(
            parse_milestones(Some(
                r#"[{"title":"A","percentBp":10000,"done":false,"stageId":null,"certificateId":null}]"#
            ))
            .unwrap(),
            vec![(10_000, None)]
        );
    }

    #[test]
    fn cancellation_refuses_an_archived_project_without_freezing_zero() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let (assignment, _) = payout_fixture(&pool, 40_000).await;
            sqlx::query("UPDATE projects SET archived_at=datetime('now') WHERE id=1")
                .execute(&pool)
                .await
                .unwrap();

            assert_eq!(
                cancel_assignment_transaction(&pool, assignment, "Called off")
                    .await
                    .unwrap_err(),
                "PROJECT_ARCHIVED"
            );
            assert_eq!(
                assignment_row(&pool, assignment).await,
                ("ACTIVE".into(), None)
            );
        });
    }

    /// A project, contract and open conflict row, for the resolver.
    async fn conflict_fixture(
        pool: &sqlx::SqlitePool,
        table: &str,
        kind: &str,
        row_uuid: &str,
        local_json: &str,
        remote_json: &str,
    ) -> i64 {
        sqlx::query(
            "INSERT INTO sync_conflicts(table_name,row_uuid,conflict_kind,local_json,remote_json,
                remote_updated_at,detected_at,status)
             VALUES(?,?,?,?,?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','OPEN')",
        )
        .bind(table)
        .bind(row_uuid)
        .bind(kind)
        .bind(local_json)
        .bind(remote_json)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn seed_project(pool: &sqlx::SqlitePool, code: &str, uuid: &str) {
        sqlx::query(
            "INSERT INTO clients(name) VALUES('Sync Co');
             INSERT INTO projects(code,name,client_id,currency,fx_rate_micro,sync_uuid)
             VALUES(?,'Synced',1,'EGP',1000000,?)",
        )
        .bind(code)
        .bind(uuid)
        .execute(pool)
        .await
        .ok();
        // The two-statement form above only runs the first on some drivers;
        // insert explicitly so the fixture is deterministic.
        sqlx::query("INSERT OR IGNORE INTO clients(id,name) VALUES(1,'Sync Co')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT OR IGNORE INTO projects(code,name,client_id,currency,fx_rate_micro,sync_uuid)
             VALUES(?,'Synced',1,'EGP',1000000,?)",
        )
        .bind(code)
        .bind(uuid)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn conflict_status(pool: &sqlx::SqlitePool, id: i64) -> (String, Option<String>) {
        sqlx::query_as("SELECT status, resolution FROM sync_conflicts WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Every dynamic table name is looked up in a fixed allowlist first, so a
    /// conflict row naming something else cannot reach a built statement.
    #[test]
    fn conflict_resolution_refuses_an_unlisted_table_and_a_bad_resolution() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let id = conflict_fixture(&pool, "settings", "CONCURRENT_EDIT", "u1", "{}", "{}").await;
            assert_eq!(
                resolve_sync_conflict_transaction(&pool, id, "KEEP_LOCAL", "note")
                    .await
                    .unwrap_err(),
                "SYNC_CONFLICT_NOT_FOUND"
            );

            let ok = conflict_fixture(&pool, "payments", "CONCURRENT_EDIT", "u2", "{}", "{}").await;
            assert_eq!(
                resolve_sync_conflict_transaction(&pool, ok, "KEEP_EVERYTHING", "note")
                    .await
                    .unwrap_err(),
                "SYNC_CONFLICT_RESOLUTION_INVALID"
            );
            assert_eq!(
                resolve_sync_conflict_transaction(&pool, ok, "KEEP_LOCAL", "   ")
                    .await
                    .unwrap_err(),
                "SYNC_CONFLICT_REASON_REQUIRED"
            );
            // None of the refusals resolved anything.
            assert_eq!(conflict_status(&pool, ok).await.0, "OPEN");
        });
    }

    /// KEEP_LOCAL on an edit conflict must make the local row win the next pull,
    /// which means an updated_at strictly later than the remote one.
    #[test]
    fn keep_local_pushes_the_local_row_past_the_remote_timestamp() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            seed_project(&pool, "PRJ-2026-001", "uuid-local").await;
            sqlx::query("UPDATE projects SET updated_at='2020-01-01T00:00:00.000Z' WHERE sync_uuid='uuid-local'")
                .execute(&pool)
                .await
                .unwrap();
            let id = conflict_fixture(
                &pool,
                "projects",
                "CONCURRENT_EDIT",
                "uuid-local",
                r#"{"code":"PRJ-2026-001"}"#,
                r#"{"code":"PRJ-2026-001"}"#,
            )
            .await;

            resolve_sync_conflict_transaction(&pool, id, "KEEP_LOCAL", "  reviewed locally  ")
                .await
                .unwrap();

            let updated: String =
                sqlx::query_scalar("SELECT updated_at FROM projects WHERE sync_uuid='uuid-local'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert!(
                updated.as_str() > "2026-01-01T00:00:00.000Z",
                "local row must outrank the remote timestamp, got {updated}"
            );

            let (status, resolution) = conflict_status(&pool, id).await;
            assert_eq!(status, "RESOLVED");
            assert_eq!(resolution.as_deref(), Some("KEEP_LOCAL"));
            let note: String =
                sqlx::query_scalar("SELECT resolution_note FROM sync_conflicts WHERE id=?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                note, "reviewed locally",
                "the note is trimmed before storing"
            );

            // The baseline recorded for the next pull is the snapshot that LOST.
            let baseline: String = sqlx::query_scalar(
                "SELECT payload_json FROM sync_record_state WHERE table_name='projects' AND row_uuid='uuid-local'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(baseline.contains("PRJ-2026-001"));

            // KEEP_LOCAL on an edit conflict does not need the pull replayed.
            sqlx::query("INSERT INTO sync_state(key,value) VALUES('pull:projects','x')")
                .execute(&pool)
                .await
                .unwrap();
            let cursors: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_state WHERE key LIKE 'pull:%'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(cursors, 1);
        });
    }

    /// KEEP_REMOTE rewinds the local row so the preserved remote snapshot is
    /// applied even though the rejected local edit is newer by wall clock, and
    /// replays the pull that will deliver it.
    #[test]
    fn keep_remote_rewinds_the_local_row_and_replays_the_pull() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            seed_project(&pool, "PRJ-2026-002", "uuid-remote").await;
            sqlx::query("INSERT INTO sync_state(key,value) VALUES('pull:projects','cursor')")
                .execute(&pool)
                .await
                .unwrap();
            let id = conflict_fixture(
                &pool,
                "projects",
                "CONCURRENT_EDIT",
                "uuid-remote",
                r#"{"code":"PRJ-2026-002"}"#,
                r#"{"code":"PRJ-2026-002"}"#,
            )
            .await;

            resolve_sync_conflict_transaction(&pool, id, "KEEP_REMOTE", "server version chosen")
                .await
                .unwrap();

            let updated: String =
                sqlx::query_scalar("SELECT updated_at FROM projects WHERE sync_uuid='uuid-remote'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(updated, "1970-01-01T00:00:00.000Z");
            let cursors: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_state WHERE key LIKE 'pull:%'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(cursors, 0, "pull must be replayed");
        });
    }

    /// KEEP_REMOTE for a row deleted locally has to cancel the tombstone, or the
    /// chosen cloud row is simply deleted again on the next pull.
    #[test]
    fn keep_remote_cancels_a_local_tombstone() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            sqlx::query(
                "INSERT INTO sync_tombstones(tbl,row_uuid,deleted_at)
                 VALUES('payments','gone-uuid','2026-01-01T00:00:00.000Z')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let id = conflict_fixture(&pool, "payments", "DELETE_VS_EDIT", "gone-uuid", "{}", "{}")
                .await;

            resolve_sync_conflict_transaction(&pool, id, "KEEP_REMOTE", "restore from cloud")
                .await
                .unwrap();

            let tombstones: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sync_tombstones WHERE tbl='payments' AND row_uuid='gone-uuid'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(tombstones, 0);
        });
    }

    /// A number collision never deletes a business record. KEEP_LOCAL renumbers
    /// the local one past everything already issued and audits the change.
    #[test]
    fn number_collision_renumbers_locally_and_records_why() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            seed_project(&pool, "PRJ-2026-004", "uuid-dup").await;
            sqlx::query(
                "UPDATE projects SET created_at='2026-05-05T00:00:00Z' WHERE sync_uuid='uuid-dup'",
            )
            .execute(&pool)
            .await
            .unwrap();
            let id = conflict_fixture(
                &pool,
                "projects",
                "DUPLICATE_RECORD",
                "uuid-remote-dup",
                r#"{"_localSyncUuid":"uuid-dup"}"#,
                r#"{"code":"PRJ-2026-004"}"#,
            )
            .await;

            resolve_sync_conflict_transaction(&pool, id, "KEEP_LOCAL", "kept our numbering")
                .await
                .unwrap();

            let code: String =
                sqlx::query_scalar("SELECT code FROM projects WHERE sync_uuid='uuid-dup'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_ne!(code, "PRJ-2026-004", "the collision must be resolved");
            assert!(
                code.starts_with("PRJ-2026-"),
                "year comes from the record, got {code}"
            );
            // Past the number already present, and three digits wide for projects.
            assert_eq!(code, "PRJ-2026-005");

            // Scoped to the renumber: creating the fixture row already wrote a
            // CREATE entry against the same uuid.
            let (reason, before, after): (String, String, String) = sqlx::query_as(
                "SELECT reason, before_json, after_json FROM audit_logs
                 WHERE entity_uuid='uuid-dup' AND action='NUMBER_COLLISION_RENUMBER'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(reason, "kept our numbering");
            // Both sides of the rename are recorded, so the collision is legible
            // after the fact.
            assert!(before.contains("PRJ-2026-004"), "before: {before}");
            assert!(after.contains("PRJ-2026-005"), "after: {after}");
        });
    }

    /// Accepting a remote number before renumbering locally would collide again
    /// on the very next pull, so it is refused — and refused without leaving the
    /// conflict half-resolved.
    #[test]
    fn keep_remote_number_is_refused_until_the_local_record_is_renumbered() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            seed_project(&pool, "PRJ-2026-007", "uuid-same").await;
            let id = conflict_fixture(
                &pool,
                "projects",
                "DUPLICATE_RECORD",
                "uuid-remote-same",
                r#"{"_localSyncUuid":"uuid-same"}"#,
                r#"{"code":"PRJ-2026-007"}"#,
            )
            .await;

            assert_eq!(
                resolve_sync_conflict_transaction(&pool, id, "KEEP_REMOTE", "take the server code")
                    .await
                    .unwrap_err(),
                "RENUMBER_LOCAL_BEFORE_KEEP_REMOTE"
            );
            assert_eq!(conflict_status(&pool, id).await.0, "OPEN");
            // The rolled-back attempt left no baseline behind either.
            let baselines: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sync_record_state WHERE row_uuid='uuid-remote-same'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(baselines, 0, "a refused resolution writes nothing");
        });
    }

    /// The whole resolution is one transaction: a failure anywhere leaves the
    /// conflict open and every earlier write undone.
    #[test]
    fn a_failed_resolution_rolls_back_everything_it_had_written() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            seed_project(&pool, "PRJ-2026-009", "uuid-fail").await;
            let id = conflict_fixture(
                &pool,
                "projects",
                "CONCURRENT_EDIT",
                "uuid-fail",
                "{}",
                "{}",
            )
            .await;
            // Fail at the last step, after the baseline and the row update.
            sqlx::raw_sql(
                "CREATE TRIGGER fail_resolution BEFORE UPDATE ON sync_conflicts
                 BEGIN SELECT RAISE(ABORT,'injected'); END",
            )
            .execute(&pool)
            .await
            .unwrap();

            assert!(
                resolve_sync_conflict_transaction(&pool, id, "KEEP_LOCAL", "note")
                    .await
                    .is_err()
            );

            assert_eq!(conflict_status(&pool, id).await.0, "OPEN");
            let baselines: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sync_record_state WHERE row_uuid='uuid-fail'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(baselines, 0, "the baseline write must roll back too");
        });
    }

    /// An import derives the status of the certificates it creates, inside the
    /// transaction that creates them — and touches nothing else.
    ///
    /// Previously the wizard called a whole-database reconciliation after the
    /// import had already committed. That was wrong twice over: unscoped, so
    /// importing clients swept every certificate in the file and attributed any
    /// correction to an import that did not cause it; and outside the boundary,
    /// so a crash between the two left imported rows with a status that had
    /// never been derived.
    #[test]
    fn importing_certificates_settles_only_what_it_created() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            sqlx::raw_sql(
                "INSERT INTO clients(name) VALUES('Import Co');
                 INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
                 VALUES('PRJ-2026-001','Imported',1,'EGP',1000000);
                 -- Advance equals the contract value, so proportional recovery
                 -- consumes the whole base: an imported certificate has nothing
                 -- collectible and is settled on arrival.
                 INSERT INTO contracts(project_id,number,value_minor,signed_date,vat_bp,retention_bp,
                     withholding_bp,advance_minor,advance_recovery_method,payment_terms_days)
                 VALUES(1,'C-ADV',100000,'2026-01-01',0,0,0,100000,'PROPORTIONAL',30);
                 INSERT INTO contracts(project_id,number,value_minor,signed_date,vat_bp,retention_bp,
                     withholding_bp,advance_minor,advance_recovery_method,payment_terms_days)
                 VALUES(1,'C-PLAIN',100000,'2026-01-01',0,0,0,0,'PROPORTIONAL',30);
                 INSERT INTO contract_revisions(contract_id,revision_number,effective_date,
                     contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,
                     advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
                 VALUES(1,1,'2026-01-01',100000,0,0,0,100000,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
                 INSERT INTO contract_revisions(contract_id,revision_number,effective_date,
                     contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,
                     advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
                 VALUES(2,1,'2026-01-01',100000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
                 -- A pre-existing certificate on the plain contract, deliberately
                 -- left in a state reconciliation WOULD change if it were swept.
                 INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor,status)
                 VALUES(2,1,'PRE-1','2026-01-01',40000,'PAID');",
            )
            .execute(&pool)
            .await
            .unwrap();

            let rows = vec![serde_json::json!({
                "contractNumber": "C-ADV",
                "number": "IMP-1",
                "date": "2026-02-01",
                "gross": 40000,
                "status": "APPROVED"
            })];
            let imported = import_rows_transaction(&pool, "certificates", &rows, "PRJ")
                .await
                .unwrap();
            assert_eq!(imported, 1);

            let status: String =
                sqlx::query_scalar("SELECT status FROM payment_certificates WHERE number='IMP-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                status, "PAID",
                "nothing is collectible on a fully-advanced contract, so the claim is closed"
            );

            let untouched: String =
                sqlx::query_scalar("SELECT status FROM payment_certificates WHERE number='PRE-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            // Left PAID with no allocations backing it. A global sweep would
            // reopen it to APPROVED; surviving untouched is the proof that
            // reconciliation is scoped to the rows this import created.
            assert_eq!(
                untouched, "PAID",
                "an unrelated certificate must not be corrected by someone else's import"
            );
        });
    }

    #[test]
    fn importing_clients_reconciles_nothing() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            sqlx::raw_sql(
                "INSERT INTO clients(name) VALUES('Existing');
                 INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
                 VALUES('PRJ-2026-002','P',1,'EGP',1000000);
                 INSERT INTO contracts(project_id,number,value_minor,signed_date,vat_bp,retention_bp,
                     withholding_bp,advance_minor,advance_recovery_method,payment_terms_days)
                 VALUES(1,'C-1',100000,'2026-01-01',0,0,0,0,'PROPORTIONAL',30);
                 INSERT INTO contract_revisions(contract_id,revision_number,effective_date,
                     contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,
                     advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
                 VALUES(1,1,'2026-01-01',100000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
                 -- Status disagrees with its evidence. A global sweep would
                 -- silently correct it and report the change as part of an
                 -- unrelated client import.
                 INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor,status)
                 VALUES(1,1,'STALE','2026-01-01',40000,'PAID');",
            )
            .execute(&pool)
            .await
            .unwrap();

            let rows = vec![serde_json::json!({ "name": "Imported Client" })];
            import_rows_transaction(&pool, "clients", &rows, "PRJ")
                .await
                .unwrap();

            let status: String =
                sqlx::query_scalar("SELECT status FROM payment_certificates WHERE number='STALE'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                status, "PAID",
                "an import of clients must not touch certificate status at all"
            );
        });
    }

    /// Imported cash stays explicitly unallocated, so importing payments cannot
    /// settle anything — the reconciliation it triggers has nothing to act on.
    #[test]
    fn importing_payments_creates_no_allocations_and_settles_nothing() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            sqlx::raw_sql(
                "INSERT INTO clients(name) VALUES('Cash Co');
                 INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
                 VALUES('PRJ-2026-003','P',1,'EGP',1000000);
                 INSERT INTO contracts(project_id,number,value_minor,signed_date,vat_bp,retention_bp,
                     withholding_bp,advance_minor,advance_recovery_method,payment_terms_days)
                 VALUES(1,'C-1',100000,'2026-01-01',0,0,0,0,'PROPORTIONAL',30);
                 INSERT INTO contract_revisions(contract_id,revision_number,effective_date,
                     contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,
                     advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
                 VALUES(1,1,'2026-01-01',100000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
                 INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor,status)
                 VALUES(1,1,'OPEN-1','2026-01-01',40000,'APPROVED');",
            )
            .execute(&pool)
            .await
            .unwrap();

            let rows = vec![serde_json::json!({
                "contractNumber": "C-1",
                "number": "PAY-1",
                "date": "2026-02-01",
                "amount": 40000,
                "method": "CASH"
            })];
            import_rows_transaction(&pool, "payments", &rows, "PRJ")
                .await
                .unwrap();

            let allocations: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM payment_certificate_allocations")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                allocations, 0,
                "imported cash is not linked to a certificate"
            );

            let status: String =
                sqlx::query_scalar("SELECT status FROM payment_certificates WHERE number='OPEN-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                status, "APPROVED",
                "cash that settles nothing must not close a claim"
            );
        });
    }

    #[test]
    fn number_reservation_never_hands_out_the_same_number_twice() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;

            let first = reserve_next_number_transaction(&pool, "PAYMENT", "pay", 2026)
                .await
                .unwrap();
            let second = reserve_next_number_transaction(&pool, "PAYMENT", "PAY", 2026)
                .await
                .unwrap();
            assert_eq!(first, "PAY-2026-0001");
            assert_eq!(second, "PAY-2026-0002");

            // Projects use a three-digit width and their own counter.
            let project = reserve_next_number_transaction(&pool, "PROJECT", "PRJ", 2026)
                .await
                .unwrap();
            assert_eq!(project, "PRJ-2026-001");

            // The scan must clear numbers already present in the business
            // table, not just the counter — an imported record would otherwise
            // collide with the next reservation.
            sqlx::query("INSERT INTO clients(name) VALUES('N')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
                 VALUES('PRJ-2026-044','Imported',1,'EGP',1000000)",
            )
            .execute(&pool)
            .await
            .unwrap();
            let after_import = reserve_next_number_transaction(&pool, "PROJECT", "PRJ", 2026)
                .await
                .unwrap();
            assert_eq!(after_import, "PRJ-2026-045");
        });
    }

    #[test]
    fn number_reservation_refuses_untrusted_sequence_and_prefix() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            for (sequence, prefix, year, expected) in [
                (
                    "PAYMENT",
                    "pay; DROP TABLE payments",
                    2026,
                    "INVALID_NUMBER_PREFIX",
                ),
                ("PAYMENT", "", 2026, "INVALID_NUMBER_PREFIX"),
                ("PAYMENT", "THIRTEENCHARS", 2026, "INVALID_NUMBER_PREFIX"),
                ("payments", "PAY", 2026, "INVALID_SEQUENCE_TYPE"),
                ("PAYMENT", "PAY", 1999, "INVALID_NUMBER_YEAR"),
            ] {
                let error = reserve_next_number_transaction(&pool, sequence, prefix, year)
                    .await
                    .unwrap_err();
                assert_eq!(error, expected, "{sequence}/{prefix}/{year}");
            }
        });
    }

    #[test]
    fn restore_audit_writes_its_evidence_and_clears_its_marker_together() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            assert!(
                !finalize_pending_restore_audit_transaction(&pool)
                    .await
                    .unwrap(),
                "no marker means nothing to finalize"
            );

            sqlx::query("INSERT INTO settings(key,value) VALUES('pending_restore_audit','1')")
                .execute(&pool)
                .await
                .unwrap();
            assert!(finalize_pending_restore_audit_transaction(&pool)
                .await
                .unwrap());

            let logged: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM audit_logs WHERE action='RESTORE' AND entity_type='backup'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(logged, 1);

            // Re-running must not record the restore a second time.
            assert!(!finalize_pending_restore_audit_transaction(&pool)
                .await
                .unwrap());
            let logged_again: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs WHERE action='RESTORE'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(logged_again, 1);
        });
    }

    #[test]
    fn safety_backup_metadata_is_registered_once_and_survives_a_bad_marker() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            sqlx::query("INSERT INTO settings(key,value) VALUES('pending_restore_safety',?)")
                .bind(
                    r#"{"path":"C:/safety.db","filename":"safety.db","databaseVersion":27,
                        "applicationVersion":"0.7.0","sha256Checksum":"abc","sourceDevice":"dev"}"#,
                )
                .execute(&pool)
                .await
                .unwrap();

            assert!(finalize_pending_backup_metadata_transaction(&pool)
                .await
                .unwrap());
            let (count, backup_type): (i64, String) = sqlx::query_as(
                "SELECT COUNT(*), MAX(backup_type) FROM backups_log WHERE path='C:/safety.db'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!((count, backup_type.as_str()), (1, "SAFETY"));
            assert!(!finalize_pending_backup_metadata_transaction(&pool)
                .await
                .unwrap());

            // A corrupt marker must fail loudly, leaving the marker in place to
            // be inspected rather than silently dropping the safety copy.
            sqlx::query("INSERT INTO settings(key,value) VALUES('pending_restore_safety','{')")
                .execute(&pool)
                .await
                .unwrap();
            assert!(finalize_pending_backup_metadata_transaction(&pool)
                .await
                .unwrap_err()
                .starts_with("PENDING_BACKUP_METADATA_INVALID"));
            let marker: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings WHERE key='pending_restore_safety'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(marker, 1);
        });
    }

    fn document_input(sha256: Option<&str>, cache: Option<&str>) -> DocumentCommandInput {
        DocumentCommandInput {
            project_id: 1,
            category: "OTHER".into(),
            title: "plan.pdf".into(),
            document_uuid: uuid_like(),
            original_filename: "plan.pdf".into(),
            extension: Some("pdf".into()),
            mime_type: "application/pdf".into(),
            size_bytes: Some(10),
            sha256: sha256.map(str::to_string),
            storage_provider: "LOCAL_ONLY".into(),
            cloud_storage_key: None,
            version_number: 1,
            uploaded_at: None,
            uploaded_by: None,
            local_cache_path: cache.map(str::to_string),
            is_available_offline: true,
            path: None,
        }
    }

    fn uuid_like() -> String {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        format!("doc-{}", NEXT.fetch_add(1, Ordering::Relaxed))
    }

    #[test]
    fn document_and_its_cache_row_commit_or_roll_back_together() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            sqlx::raw_sql(
                "INSERT INTO clients(name) VALUES('Doc Co');
                 INSERT INTO projects(code,name,client_id,currency,fx_rate_micro)
                 VALUES('PRJ-2026-001','Docs',1,'EGP',1000000);",
            )
            .execute(&pool)
            .await
            .unwrap();

            let id = create_document_transaction(
                &pool,
                document_input(Some(&"a".repeat(64)), Some("C:/a.pdf")),
            )
            .await
            .unwrap();
            let cached: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM document_cache WHERE document_id=?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(cached, 1);

            // Identical content in the same project is refused, and the
            // refusal leaves nothing behind.
            let duplicate = create_document_transaction(
                &pool,
                document_input(Some(&"a".repeat(64)), Some("C:/b.pdf")),
            )
            .await
            .unwrap_err();
            assert_eq!(duplicate, "DUPLICATE_DOCUMENT_CONTENT");
            let documents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(documents, 1);

            // A failure registering the cache row must take the document row
            // with it, or the app points at a file it cannot find.
            sqlx::raw_sql(
                "CREATE TRIGGER fail_cache BEFORE INSERT ON document_cache
                 BEGIN SELECT RAISE(ABORT,'injected'); END",
            )
            .execute(&pool)
            .await
            .unwrap();
            assert!(create_document_transaction(
                &pool,
                document_input(Some(&"c".repeat(64)), Some("C:/c.pdf"))
            )
            .await
            .is_err());
            let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(after, 1, "rolled back with its cache row");
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v0.7.0 database rebase (Milestone 7): the development chain
    // 0001..0024 is consolidated into one baseline. Schema identity stays
    // 24 — this baseline recreates exactly that schema — so no database
    // can claim a version whose shape differs. Development databases from
    // before the rebase fail the plugin checksum check and must be deleted.
    let migrations = vec![
        Migration {
            version: 1,
            description: "baseline_schema",
            sql: include_str!("../migrations/0001_baseline.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "seed_reference_data",
            sql: include_str!("../migrations/0002_seed_reference_data.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "assignment_lifecycle",
            sql: include_str!("../migrations/0003_assignment_lifecycle.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "cancellation_evidence_integrity",
            sql: include_str!("../migrations/0004_cancellation_evidence_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "audit_version_baseline",
            sql: include_str!("../migrations/0005_audit_version_baseline.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .manage(LockThrottle::default())
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
        .invoke_handler(tauri::generate_handler![
            app_lock_enabled,
            initialize_runtime_release,
            execute_sync_mutation_atomic,
            verify_app_lock,
            set_app_lock,
            disable_app_lock,
            validate_backup,
            create_backup_file,
            restore_database,
            fetch_cbe_rates,
            create_payment_atomic,
            update_payment_atomic,
            void_payment_atomic,
            reconcile_certificates_atomic,
            create_certificate_atomic,
            update_certificate_atomic,
            transition_certificate_atomic,
            void_certificate_atomic,
            create_person_payment_atomic,
            delete_person_payment_atomic,
            cancel_assignment_atomic,
            create_milestone_certificates_atomic,
            create_project_atomic,
            update_project_atomic,
            create_contract_atomic,
            update_contract_atomic,
            import_rows_atomic,
            reserve_next_number_atomic,
            resolve_sync_conflict_atomic,
            finalize_pending_restore_audit_atomic,
            finalize_pending_backup_metadata_atomic,
            create_document_atomic,
            import_project_document,
            cache_project_document,
            document_file_exists,
            remove_managed_document_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
