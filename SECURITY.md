# Security Policy

## Reporting

Please report suspected vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the Security tab) rather than public issues. Include the plugin version, DSH version, and a minimal description — do not include real credentials or private session data.

## Scope

- The WebChat host (`packages/chat-main/lib`), its HTTP routes, and its client page.
- The local directory authorization engine (path traversal, symlink escapes) and the import/export pipeline.

## Out of scope

- Vulnerabilities in DeepSeek Harness itself — report those upstream to https://github.com/deepseek-ai/deepseek-harness.
- Issues requiring an attacker to already hold the DSH web auth token (the DSH web listener is loopback-only and token-gated by DSH).

## Design notes

- The browser never receives credentials; the Host resolves them per request from DSH's credential store.
- Local directory grants are read-only and validated Host-side (absolute path, realpath, existence, readability); the search engine re-validates every path it touches against the authorized roots.
- Session data lives exclusively in DSH's official persistence layer.
- Data Sharing (optional, off by default) uses an Ed25519 device identity for authentication and one-time/ephemeral X25519 keys for content. LAN sessions derive directional AES-256-GCM keys from an authenticated ephemeral transcript; WebDAV objects use a one-time prekey per message and delete it after receipt. The long-term key is not a content-encryption key. See [docs/sharing-security.md](docs/sharing-security.md).

- Device enrollment uses OPAQUE with Argon2id stretching. The device sync password is separate from content and backup encryption. Only the enrolling host stores its OPAQUE setup and record. Changing the password discards that registration and pauses other devices until verified again. See [the protocol and threat model](docs/sharing-security.md).
