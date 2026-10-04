# Spike results (2026-10-02)

Scripts: `upload.mjs` (create + update + forged update, RSA and Ed25519),
`resolve.mjs` (resolver algorithm vs. GraphQL endpoints), `latency.mjs` (timing).
Test data uses `App-Name: PermaPath-Spike`.

- **Concept works.** On arweave.net and Goldsky, both key types resolved to the
  owner's latest `Seq`. A forged update (other key, `Seq: 99`) was visible but
  ignored by the `owners` filter.
- **Uploads:** free via Turbo, ~0.3–0.7 s each, no funded wallet needed.
- **Ed25519 key** as a 32-byte seed = 44 base58 chars → fits a password field.
  RSA JWK = ~3,150 chars.
- **Latency (arweave.net GraphQL):** lookup by ID ~67 s; tag queries (how updates
  are found) ~10 min, one took >10 min. Goldsky caught up at ~12.5 min.
- **Owner address format differs by endpoint for Ed25519:** arweave.net returns
  the base58 public key, Goldsky returns base64url(sha256(pubkey)). Resolver must
  take the owner from the same endpoint it queries for updates.

## Later (same day)

- **frostor.xyz** (ar.io gateway) indexed Turbo uploads, including tag queries,
  within ~30 s, well ahead of arweave.net and Goldsky. permagate.io had our data
  but was not faster. ar-io.dev and vilenarios.com lacked it or errored.
- arweave.net latency varies: one run showed links and updates within ~3 min,
  another took 9–10 min, and one update took 19 min.

## Signature verification from GraphQL alone

`spike/empty-body.mjs`: Turbo accepts a 0-byte body. All four endpoints return
`signature`, `owner { key }` and tags in original order, so an empty-body record
verifies from GraphQL fields alone (`verifyDataItem` in `editor/arweave.js`),
no body download needed. Visible and verified: frostor.xyz 1 s, arweave.net
284 s, Goldsky and permagate.io 499 s. Records with a body (all current v1
records) need the body downloaded to verify.
- Live, with signature-checked resolver + editor deployed: new link scannable in
  1 s, and an edit reached scans 1 s after saving (via frostor.xyz, verified).
