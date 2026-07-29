# Windows installer code signing — 0.7.0

Public Windows installers must be Authenticode-signed with a certificate issued
to the publisher. Keep private keys in a hardware token, HSM, or protected CI
secret. Never commit PFX files, passwords, certificates, or signing tokens, and
never paste them into a terminal that is being recorded.

Sign every executable and installer the selected Tauri v2 bundle produces, using
an RFC 3161 timestamp server so signatures remain valid after the certificate
expires.

Verify on a clean Windows machine before distribution:

```powershell
Get-AuthenticodeSignature .\NAMAA-Finance_0.7.0_x64-setup.exe | Format-List
Get-FileHash -Algorithm SHA256 .\NAMAA-Finance_0.7.0_x64-setup.exe
```

Confirm the subject, timestamp, and product version, then record the SHA-256
checksum in the release checklist alongside the commit it was built from.

The installer produced by this release is **unsigned** unless signing is
performed as a separate, deliberate step. Unsigned builds must remain clearly
labelled Beta and must not be represented as trusted production releases. Users
will see a SmartScreen warning; that warning is accurate and must not be worked
around by disabling SmartScreen or instructing users to bypass it.
