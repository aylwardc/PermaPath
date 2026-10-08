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

## Sponsored uploads via Turbo credit sharing (2026-10-07)

Tested for a possible paid feature: the user's key signs (and owns) the data, and a
sponsor key with Turbo credits pays. Payer: the deploy key. Total cost ~$0.01.

- **Approve:** the sponsor uploads a data item tagged `x-approve-payment: <user address>`,
  `x-amount: <winc>`, optional `x-expires-seconds`. Turbo's response includes
  `createdApproval`; the amount is reserved from the sponsor's balance at once.
  Revoke with `x-delete-payment-approval: <user address>`; unused credit returns
  immediately. Tag names from `@ardrive/turbo-sdk` 2.1.0 (`creditSharingTagNames`).
- **Use:** the user uploads normally with header `x-paid-by: <sponsor address>`. A
  ~120 KB item (over the free-tier size) was accepted in under a second and charged
  to the approval (`usedWincAmount`), not to the user. Owner in GraphQL = the user.
- **Addresses** for type-4 (Ed25519) keys are the base58 public key, as Turbo's
  payment API reports them.
- **Encrypted bodies work:** AES-GCM body with a key derived (HKDF) from the user's
  seed; found via GraphQL `owners` + `App-Name`, downloaded from `turbo-gateway.com/raw`,
  decrypted, and two records replayed by `Seq`.
- **Visibility:** all four of arweave.net, Goldsky, frostor.xyz and turbo-gateway.com
  had both records when checked ~20 min after upload (first confirmed on Goldsky
  at ~8 min; the others weren't timed because of a query bug).
- **GraphQL gotcha:** declare tag values as `[String!]!`. With `[String!]`, arweave.net,
  frostor.xyz and turbo-gateway.com return HTTP 400; Goldsky accepts it.
- **Price (2026-10-07):** Turbo sells credits at ~$90/GiB vs ~$58/GiB network cost
  (same winc, ~35% markup in the fiat→winc rate). A 100 KB item is under 1¢ either way.
