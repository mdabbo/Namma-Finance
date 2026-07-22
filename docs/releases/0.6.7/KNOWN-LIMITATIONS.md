# Known limitations - 0.6.7 Beta

- This remains a Beta release and is not approved for production financial records.
- The application lock protects access through the app; it does not encrypt the SQLite database or backup files.
- Cloud synchronization requires the documented Supabase migrations and preflight checks to be complete.
- Financial conflicts are intentionally preserved for explicit review instead of being resolved silently.
- Existing legacy cloud data created before immutable contract revisions may require an explicit audited migration or a confirmed test-data reset.
- A second PC containing old local test records can upload those records again unless its local database is reset before reconnecting to a cleaned cloud.
- Public Windows installers require external Authenticode signing to avoid publisher and SmartScreen warnings.
- The production web bundle may emit a non-blocking large-chunk warning.
