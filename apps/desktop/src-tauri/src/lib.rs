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
struct CertificateStatusCommandInput {
    certificate_id: i64,
    status: String,
}

async fn apply_certificate_statuses(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    updates: Vec<CertificateStatusCommandInput>,
) -> Result<(), String> {
    for update in updates {
        if !matches!(
            update.status.as_str(),
            "DRAFT" | "SUBMITTED" | "APPROVED" | "PAID"
        ) {
            return Err("invalid certificate status".into());
        }
        let result = sqlx::query(
            "UPDATE payment_certificates SET status=? WHERE id=? AND deleted_at IS NULL",
        )
        .bind(update.status)
        .bind(update.certificate_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if result.rows_affected() != 1 {
            return Err("certificate status target not found".into());
        }
    }
    Ok(())
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

const SYNC_MUTATION_TABLES: &[&str] = &[
    "clients",
    "people",
    "expense_categories",
    "projects",
    "contracts",
    "project_stages",
    "contract_revisions",
    "variation_orders",
    "documents",
    "time_entries",
    "project_assignments",
    "payment_certificates",
    "payments",
    "payment_certificate_allocations",
    "person_payments",
    "expenses",
    "recurring_expenses",
];

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
        || !SYNC_MUTATION_TABLES.contains(&table)
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

fn mul_div_round_i64(amount: i64, numerator: i64, denominator: i64) -> Result<i64, String> {
    if denominator <= 0 {
        return Err("invalid financial calculation denominator".into());
    }
    let product = i128::from(amount)
        .checked_mul(i128::from(numerator))
        .ok_or_else(|| "financial calculation overflow".to_string())?;
    let doubled = product
        .checked_mul(2)
        .and_then(|value| value.checked_add(i128::from(denominator)))
        .ok_or_else(|| "financial calculation overflow".to_string())?;
    let divisor = i128::from(denominator)
        .checked_mul(2)
        .ok_or_else(|| "financial calculation overflow".to_string())?;
    let rounded = doubled / divisor;
    i64::try_from(rounded).map_err(|_| "financial calculation overflow".to_string())
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
    let rows = sqlx::query(
        "SELECT pc.id,pc.status,pc.gross_minor,pc.discount_minor,pc.manual_advance_recovery_minor,
                COALESCE(pc.contract_value_minor_snapshot,c.value_minor) contract_value_minor,
                COALESCE(pc.vat_bp_snapshot,c.vat_bp) vat_bp,
                COALESCE(pc.retention_bp_snapshot,c.retention_bp) retention_bp,
                COALESCE(pc.withholding_bp_snapshot,c.withholding_bp) withholding_bp,
                COALESCE(pc.advance_minor_snapshot,c.advance_minor) advance_minor,
                COALESCE(pc.advance_method_snapshot,c.advance_recovery_method) advance_method
         FROM payment_certificates pc JOIN contracts c ON c.id=pc.contract_id
         WHERE pc.contract_id=? AND pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
         ORDER BY pc.seq,pc.id",
    )
    .bind(contract_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let mut recovered_advance = 0_i64;
    let mut found = std::collections::HashSet::new();
    for row in rows {
        let certificate_id: i64 = row.try_get("id").map_err(|e| e.to_string())?;
        let status: String = row.try_get("status").map_err(|e| e.to_string())?;
        if status == "DRAFT" {
            if requested.contains_key(&certificate_id) {
                return Err("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE".into());
            }
            continue;
        }
        let gross: i64 = row.try_get("gross_minor").map_err(|e| e.to_string())?;
        let discount: i64 = row.try_get("discount_minor").map_err(|e| e.to_string())?;
        let base = gross
            .checked_sub(discount)
            .ok_or_else(|| "invalid certificate base".to_string())?;
        let vat = mul_div_round_i64(
            base,
            row.try_get("vat_bp").map_err(|e| e.to_string())?,
            10_000,
        )?;
        let retention = mul_div_round_i64(
            base,
            row.try_get("retention_bp").map_err(|e| e.to_string())?,
            10_000,
        )?;
        let withholding = mul_div_round_i64(
            base,
            row.try_get("withholding_bp").map_err(|e| e.to_string())?,
            10_000,
        )?;
        let advance_minor: i64 = row.try_get("advance_minor").map_err(|e| e.to_string())?;
        let remaining_advance = advance_minor.saturating_sub(recovered_advance).max(0);
        let method: String = row.try_get("advance_method").map_err(|e| e.to_string())?;
        let calculated_recovery = if method == "MANUAL" {
            row.try_get::<Option<i64>, _>("manual_advance_recovery_minor")
                .map_err(|e| e.to_string())?
                .unwrap_or(0)
        } else {
            let contract_value: i64 = row
                .try_get("contract_value_minor")
                .map_err(|e| e.to_string())?;
            if contract_value <= 0 {
                0
            } else {
                mul_div_round_i64(base, advance_minor, contract_value)?
            }
        };
        let recovery = calculated_recovery.min(remaining_advance);
        recovered_advance = recovered_advance
            .checked_add(recovery)
            .ok_or_else(|| "advance recovery overflow".to_string())?;
        let net_payable = base
            .checked_add(vat)
            .and_then(|v| v.checked_sub(retention))
            .and_then(|v| v.checked_sub(recovery))
            .and_then(|v| v.checked_sub(withholding))
            .ok_or_else(|| "certificate payable overflow".to_string())?;
        if let Some(requested_amount) = requested.get(&certificate_id) {
            found.insert(certificate_id);
            let allocated: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(a.amount_minor),0) FROM payment_certificate_allocations a
                 JOIN payments p ON p.id=a.payment_id
                 WHERE a.certificate_id=? AND p.deleted_at IS NULL AND p.voided_at IS NULL
                   AND (? IS NULL OR p.id<>?)",
            )
            .bind(certificate_id)
            .bind(excluding_payment_id)
            .bind(excluding_payment_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            let capacity = net_payable.saturating_sub(allocated).max(0);
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
    status_updates: Vec<CertificateStatusCommandInput>,
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
    }
    apply_certificate_statuses(&mut tx, status_updates).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(payment_id)
}

async fn replace_payment_transaction(
    pool: &sqlx::SqlitePool,
    payment_id: i64,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
    status_updates: Vec<CertificateStatusCommandInput>,
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
    }
    apply_certificate_statuses(&mut tx, status_updates).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert a payment and every allocation as one all-or-nothing operation.
#[tauri::command]
async fn create_payment_atomic(
    db_instances: State<'_, DbInstances>,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
    status_updates: Vec<CertificateStatusCommandInput>,
) -> Result<i64, String> {
    validate_payment_input(&input, &allocations)?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    insert_payment_transaction(pool, input, allocations, status_updates).await
}

/// Replace payment evidence and allocations as one all-or-nothing operation.
#[tauri::command]
async fn update_payment_atomic(
    db_instances: State<'_, DbInstances>,
    payment_id: i64,
    input: PaymentCommandInput,
    allocations: Vec<AllocationCommandInput>,
    status_updates: Vec<CertificateStatusCommandInput>,
) -> Result<(), String> {
    validate_payment_input(&input, &allocations)?;
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    replace_payment_transaction(pool, payment_id, input, allocations, status_updates).await
}

#[tauri::command]
async fn void_payment_atomic(
    db_instances: State<'_, DbInstances>,
    payment_id: i64,
    status_updates: Vec<CertificateStatusCommandInput>,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let result = sqlx::query(
        "UPDATE payments SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason='Voided by user' WHERE id=? AND voided_at IS NULL",
    )
    .bind(payment_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("payment not found or already voided".into());
    }
    apply_certificate_statuses(&mut tx, status_updates).await?;
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_certificate_statuses_atomic(
    db_instances: State<'_, DbInstances>,
    status_updates: Vec<CertificateStatusCommandInput>,
) -> Result<(), String> {
    if status_updates.is_empty() {
        return Ok(());
    }
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    apply_certificate_statuses(&mut tx, status_updates).await?;
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_person_payment_atomic(
    db_instances: State<'_, DbInstances>,
    input: PersonPaymentCommandInput,
) -> Result<i64, String> {
    if input.amount_minor <= 0 || input.date.trim().is_empty() {
        return Err("invalid person payment".into());
    }
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    let twin: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM person_payments WHERE assignment_id=? AND date=? AND amount_minor=? AND note IS ? AND voided_at IS NULL LIMIT 1",
    ).bind(input.assignment_id).bind(&input.date).bind(input.amount_minor).bind(&input.note)
        .fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
    if twin.is_some() {
        return Err("DUPLICATE_PERSON_PAYMENT".into());
    }
    let context = sqlx::query(
        "SELECT a.project_id, a.currency, a.fx_rate_micro, pe.name AS person_name, pe.type AS person_type FROM project_assignments a JOIN people pe ON pe.id=a.person_id WHERE a.id=?",
    ).bind(input.assignment_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "assignment not found".to_string())?;
    let project_id: i64 = context.try_get("project_id").map_err(|e| e.to_string())?;
    let currency: String = context.try_get("currency").map_err(|e| e.to_string())?;
    let fx_rate_micro: i64 = context
        .try_get("fx_rate_micro")
        .map_err(|e| e.to_string())?;
    let person_name: String = context.try_get("person_name").map_err(|e| e.to_string())?;
    let person_type: String = context.try_get("person_type").map_err(|e| e.to_string())?;
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
    let instances = db_instances.0.read().await;
    let pool = match instances.get("sqlite:mep-finance.db") {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("database is not loaded".into()),
    };
    let mut tx = begin_immediate(pool).await?;
    for (index, row) in rows.iter().enumerate() {
        let fail = |message: &str| format!("row {}: {message}", index + 2);
        match entity.as_str() {
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
                sqlx::query("INSERT INTO payment_certificates (contract_id,seq,number,date,submission_date,gross_minor,discount_minor,status) VALUES (?,?,?,?,?,?,?,?)")
                    .bind(contract_id).bind(seq).bind(json_text(row,"number").ok_or_else(||fail("certificate number is required"))?).bind(&date)
                    .bind(json_text(row,"submissionDate").unwrap_or_else(|| date.clone())).bind(json_i64(row,"gross").ok_or_else(||fail("gross amount is required"))?)
                    .bind(json_i64(row,"discount").unwrap_or(0)).bind(status).execute(&mut *tx).await.map_err(|e|fail(&e.to_string()))?;
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
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(rows.len() as i64)
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

const CURRENT_SCHEMA_VERSION: i64 = 23;
const CURRENT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const APPLICATION_ID: &str = "com.mepfinance.app";

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
                vec![],
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
                vec![],
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
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_seed.sql"),
            include_str!("../migrations/0003_feedback_round1.sql"),
            include_str!("../migrations/0004_phase2.sql"),
            include_str!("../migrations/0005_backfill_team_expenses.sql"),
            include_str!("../migrations/0006_sync_tracking.sql"),
            include_str!("../migrations/0007_time_tracking.sql"),
            include_str!("../migrations/0008_financial_record_lifecycle.sql"),
            include_str!("../migrations/0009_contract_revisions.sql"),
            include_str!("../migrations/0010_contract_revision_integrity.sql"),
            include_str!("../migrations/0011_payment_allocation_integrity.sql"),
            include_str!("../migrations/0012_audit_log.sql"),
            include_str!("../migrations/0013_audit_remediation.sql"),
            include_str!("../migrations/0014_backup_hardening.sql"),
            include_str!("../migrations/0015_backup_audit_hardening.sql"),
            include_str!("../migrations/0016_domain_validation.sql"),
            include_str!("../migrations/0017_domain_validation_audit.sql"),
            include_str!("../migrations/0018_managed_documents.sql"),
            include_str!("../migrations/0019_document_cache_isolation.sql"),
            include_str!("../migrations/0020_sync_conflict_safety.sql"),
            include_str!("../migrations/0021_sync_conflict_remediation.sql"),
            include_str!("../migrations/0022_numbering_safety.sql"),
            include_str!("../migrations/0023_numbering_remediation.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        stamp_runtime_release(&pool).await.unwrap();
        pool.close().await;
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

            sqlx::query("UPDATE app_metadata SET value='23' WHERE key='schema_version'")
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
        Migration {
            version: 8,
            description: "financial_record_lifecycle",
            sql: include_str!("../migrations/0008_financial_record_lifecycle.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "contract_revisions",
            sql: include_str!("../migrations/0009_contract_revisions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "contract_revision_integrity",
            sql: include_str!("../migrations/0010_contract_revision_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "payment_allocation_integrity",
            sql: include_str!("../migrations/0011_payment_allocation_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "immutable_financial_audit_log",
            sql: include_str!("../migrations/0012_audit_log.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "audit_log_remediation",
            sql: include_str!("../migrations/0013_audit_remediation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "backup_restore_hardening",
            sql: include_str!("../migrations/0014_backup_hardening.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "backup_audit_hardening",
            sql: include_str!("../migrations/0015_backup_audit_hardening.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "domain_validation",
            sql: include_str!("../migrations/0016_domain_validation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "domain_validation_audit",
            sql: include_str!("../migrations/0017_domain_validation_audit.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "managed_documents",
            sql: include_str!("../migrations/0018_managed_documents.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "document_cache_isolation",
            sql: include_str!("../migrations/0019_document_cache_isolation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "sync_conflict_safety",
            sql: include_str!("../migrations/0020_sync_conflict_safety.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "sync_conflict_remediation",
            sql: include_str!("../migrations/0021_sync_conflict_remediation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "numbering_safety",
            sql: include_str!("../migrations/0022_numbering_safety.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "numbering_remediation",
            sql: include_str!("../migrations/0023_numbering_remediation.sql"),
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
            update_certificate_statuses_atomic,
            create_person_payment_atomic,
            delete_person_payment_atomic,
            create_milestone_certificates_atomic,
            create_project_atomic,
            update_project_atomic,
            create_contract_atomic,
            update_contract_atomic,
            import_rows_atomic,
            import_project_document,
            cache_project_document,
            document_file_exists,
            remove_managed_document_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
