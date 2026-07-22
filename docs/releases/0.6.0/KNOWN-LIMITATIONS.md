# Known limitations — 0.6.0 Beta

- This is a Beta release and has not been declared production-ready.
- The local application lock is an access gate, not database encryption. SQLite files and backups are not encrypted by default.
- Windows code signing requires an externally purchased and securely managed certificate; unsigned development builds will show Windows trust warnings.
- Financial exchange rates depend on the stored project rate. CBE retrieval requires internet access and should be reviewed before posting cross-currency transactions.
- Sync conflicts affecting financial records require explicit user review; the system intentionally does not silently choose a winner.
- Cloud document availability depends on configured Supabase storage. Local-only documents do not become portable automatically.
- The desktop bundle currently emits a non-blocking large JavaScript chunk warning.
- Mobile remains a companion application and does not expose every desktop workflow.
- The repository previously contained an unsynchronized internal Tauri version of 0.6.7. If that development build was installed outside the development team, 0.6.0 must not be deployed over it until the Windows downgrade/upgrade behavior has been explicitly tested.
