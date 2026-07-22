# Windows installer code signing - 0.6.7

Public Windows installers must be Authenticode-signed using a certificate issued to the publisher. Keep private keys in a hardware token, HSM, or protected CI secret; never commit PFX files, passwords, certificates, or signing tokens.

Use an RFC 3161 timestamp server and sign every executable and installer required by the selected Tauri v2 workflow. On a clean Windows machine, verify the subject, timestamp, product version, and signature with `Get-AuthenticodeSignature`, then record the installer SHA-256 checksum with `Get-FileHash -Algorithm SHA256`.

Unsigned development installers must remain clearly labelled Beta/development builds and must not be represented as trusted production releases.
