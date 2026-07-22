# Windows installer code signing

Public Windows releases should be Authenticode-signed with a certificate issued to the publisher. An EV certificate generally builds reputation faster; standard organization-validation certificates are also supported but may initially trigger SmartScreen reputation warnings.

Operational requirements:

1. Keep the private key in a hardware token, HSM, or protected CI secret store. Never commit certificates, PFX files, passwords, or signing tokens.
2. Restrict signing permission to the release workflow and designated release maintainers.
3. Configure Tauri's Windows signing environment using the official Tauri v2 signing mechanism appropriate to the certificate provider.
4. Use an RFC 3161 timestamp server so signatures remain valid after certificate expiry.
5. Sign both the application executable and NSIS installer where the selected tooling requires it.
6. Verify on a clean Windows machine with `Get-AuthenticodeSignature` and record the installer SHA-256 checksum.
7. Publish only artifacts whose subject, timestamp, version 0.6.0, and checksum match the approved release record.

Development builds may remain unsigned, but they must be labelled as such and must not be distributed as trusted production releases.
