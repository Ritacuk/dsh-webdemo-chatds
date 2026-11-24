# dsh-webdemo-chatds

WebChat for DeepSeek Harness — the Main chat surface, Agent Side Chat and optional Data Sharing.

Version `0.12.1` introduces device sync passwords and lets ChatDS apply its Windows LAN rules while DSH is running.

## Install

Recommended: open the DSH plugin manager, find **WebChat / ChatDS**, and install `0.12.1`.

Command line:

```bash
dsh plugin --profile web add dsh-webdemo-chatds@0.12.1
```

## Data Sharing (optional, off by default)

Data Sharing is a separate plugin row. It moves selected chat text between devices you own:

- Ed25519 device identity authenticates pairing and handshakes.
- LAN sessions use fresh ephemeral X25519 keys and directional AES-256-GCM keys.
- WebDAV objects use one-time recipient prekeys and a fresh per-message key, so exporting the current device key does not decrypt historical objects.
- LAN discovery finds nearby devices. The sync password authenticates enrollment.
- On Windows, the LAN switch manages ChatDS rules for the current TCP port and mDNS on the Private profile.

To start sharing, enable Data Sharing in the DSH plugin manager. In ChatDS settings, allow LAN connections on each device, set the device sync password on the first device, then use **Join existing devices** on the second. Keep the devices on the same LAN for enrollment.

The project repository contains the full security design, changelog and acceptance reports. [ChatDS repository](https://github.com/Ritacuk/dsh-webdemo-chatds)

## License

MIT. See [LICENSE](LICENSE).
