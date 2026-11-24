# Data Sharing security design

The v2 content protocol was introduced in `0.12.0-rc.1` and is retained in 0.12.1. It replaces the v1 static-X25519 design used by the unpublished `0.11.9-rc.1` candidate.

## 1. Identity

A device identity has three long-term values:

| Value | Algorithm | Purpose |
| --- | --- | --- |
| `card.id` | UUID | Stable device identifier across key rotation |
| `privateKey` / `card.key` | X25519 (SPKI/PKCS#8) | Legacy pairing key material and future key agreement; **never a content-encryption key** |
| `signPrivateKey` / `card.signKey` | Ed25519 (SPKI/PKCS#8) | Device authentication, handshake signatures, envelope signatures |

The Ed25519 public key is part of the device card and the safety number. Pairing compares the full safety number `SHA-256("2" || id || x25519_pub || ed25519_pub)` (displayed in eight groups) out of band. A short check code is displayed only as a visual aid; trust is established with the full fingerprint.

## 2. LAN transport

Every connection performs a fresh handshake:

1. Initiator generates ephemeral X25519 `eA` and a 128-bit nonce `nA`, then sends `hello` with its device id, target id, `eA` and `nA`.
2. Responder checks that the sender is paired and the target is itself, generates ephemeral `eB` and `nB`, and signs the complete transcript:
   `SHA-256(["chatds-lan-v2", 2, A, B, eA, eB, nA, nB])`.
3. Initiator verifies the responder's Ed25519 signature, derives keys from `X25519(eA, eB)` and the transcript, and sends its own signature plus an AEAD confirmation proof.
4. Responder verifies the initiator's signature and proof, marks the session established, and returns an AEAD confirmation.
5. Data messages carry a strictly increasing sequence number. AEAD associated data binds protocol version, session transcript, sequence, sender and recipient.
6. Sessions expire after five minutes or 256 messages. Ephemeral private keys and session keys are dropped/wiped; they are never persisted.

Properties:

- **Mutual authentication**: both directions verify a signature over the same transcript using the Ed25519 key learned at pairing.
- **Forward secrecy**: the session secret comes from ephemeral keys that do not exist after the session. A later leak of both long-term identities cannot reconstruct it.
- **Replay resistance**: the responder contributes a fresh ephemeral key and nonce, so an old `hello`/`confirm` transcript is not accepted again. Message sequence numbers are strict.
- **Downgrade resistance**: version and algorithm are literals in the transcript and envelope schemas; v1 objects are rejected.
- **No public exposure**: the listener binds only private IPv4 / IPv6 ULA addresses selected by the user, excludes loopback, link-local, Docker/WSL/Hyper-V and VPN interfaces by default, and rejects non-private remote sockets. A user can explicitly select an excluded interface.

## 3. Asynchronous WebDAV objects

Persisted objects use one-time recipient prekeys:

1. Each device generates a pool of 32 X25519 prekeys. It stores the private halves locally and publishes a signed public bundle (`bundle.json`) to its own cloud folder. The bundle is signed by the device's Ed25519 key.
2. A sender fetches the recipient bundle, verifies the signature against the paired card, and claims one prekey with a create-only `claim-<prekeyId>.json` object. A lost claim race selects another prekey.
3. For each event the sender generates a fresh ephemeral X25519 key `e`, computes `S = X25519(e, prekey_pub)`, derives a wrapping key and an acknowledgement key with HKDF-SHA-256 over a salt that binds protocol, sender, recipient, event id, ephemeral public key and prekey id.
4. A random 256-bit message key encrypts the payload with AES-256-GCM. The message key is wrapped with the derived wrapping key. The complete header and both ciphertexts are signed with the sender's Ed25519 key.
5. The recipient verifies the signature, finds the prekey private half, unwraps the message key, decrypts, validates the event, then deletes the prekey private half and records its id as consumed in the same state commit.

Properties:

- **Forward secrecy against either side's long-term key**: the message key is random and the prekey private half is deleted after use. Leaking the sender or recipient identity after receipt does not decrypt the stored object. The prekey is not derived from either identity.
- **Offline delivery**: the recipient can decrypt a queued object while offline as long as it still holds the corresponding prekey.
- **Replay resistance**: consumed prekeys are deleted; a replayed object fails with an unknown-prekey error. Event ids are also deduplicated.
- **Per-event isolation**: each event uses an independent prekey and message key; a damaged key state for one pair does not affect other pairs.
- **Multi-sender**: claims are create-only per prekey, so concurrent senders cannot reuse the same one-time key.
- **Device revocation**: revocation removes the peer and stops new sends. Objects already downloaded cannot be recalled.

Limits:

- A message that is still queued (prekey not yet consumed) is decryptable by a compromise of the recipient's *current* state, by definition of asynchronous delivery.
- An old backup can contain private prekeys for messages received after the backup was taken. Restore removes prekeys listed as consumed in the backup itself; for full forward secrecy, keep backups at least as new as the current consumed set and protect them.
- The cloud provider still sees object sizes, timing and device folder identifiers.

## 4. Discovery and firewall

Discovery advertises only `_chatds-sync._tcp` metadata (device id, display name, short check code, protocol version, port), never keys or chat content. It uses one mDNS socket per selected IPv4 interface with a wildcard bind and an explicit multicast interface, because multi-homed hosts otherwise send from the default route. A scoped ChatDS multicast fallback (`239.255.46.61:46832`) covers hosts where another application owns UDP 5353. Discovery never implies trust.

On Windows, the inbound listener may require a Defender Firewall rule. The app offers a scoped rule: the DSH executable only, TCP sync port, UDP 5353 and 46832, Private profile, local subnet. It never disables the firewall and never allows all networks.

## 5. Migration

The unpublished v1 state is migrated to a v2 identity with the same Device ID. The plaintext inbox, exclusions, audit and revocation list are preserved. Peers and policies are cleared because v1 cards have no Ed25519 signing key; both devices must pair again. Code and audit text mark the migration.


## 0.12.1 password enrollment

- Enrollment uses the pinned `@serenity-kit/opaque@1.1.0` implementation with its Argon2id memory-constrained setting (64 MiB, three passes, four lanes). The authority stores its own OPAQUE setup and registration envelope in the DSH profile. The joining host stores the authorized public identity and endpoint. Neither setup nor registration record is exported in a ChatDS sharing backup.
- OPAQUE binds the exchange to the target device ID. The session secret derives distinct keys for the exchange of Ed25519-signed device cards. A short-lived request ID binds both cards to the handshake. A known peer must present its pinned Ed25519 and X25519 public keys. The join listener limits authentication starts per source and across all sources. Each finish token is consumed once.
- Password input on the authenticated DSH local web route is wrapped with RSA-OAEP and AES-GCM using a one-time form ticket. The host accepts the route over loopback or TLS. Device-to-device requests carry OPAQUE messages. The password does not enter localStorage, the sync status, backup archives, or chat encryption.
- A currently authorized member can initiate a reset on the original host when it is reachable. Their existing pinned identities sign the blinded registration and result. The host commits the new registration atomically and marks the other members for re-verification. A member that is temporarily offline receives an identity-signed re-verification response when it reconnects to the host on the LAN.
- Compromise of the DSH profile exposes identity secrets and the host OPAQUE record and setup, which can enable password guessing against the stolen profile. Argon2id increases that cost. Protect the device and use a long, unique passphrase. Compromise of a running trusted device can expose data available to that device.
- Existing content encryption, selective sharing, one-time cloud keys, key expiry and replay checks stay independent of the password. The optional encrypted backup uses its own scrypt-based passphrase and includes the sharing identity and received records.
