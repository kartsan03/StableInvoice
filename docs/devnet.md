# Devnet

Cluster: `https://api.devnet.solana.com`

Program id: `36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU`

Matches `declare_id!` in `programs/stable_invoice/src/lib.rs` and `[programs.devnet]` in `Anchor.toml`. `anchor keys sync` did not change the id.

Upgrade authority (pubkey only): `CmYSWALfhFSw4CKPpJpbH19Q7NQn2N72DNnU34PDP85Q`

Explorer: https://explorer.solana.com/address/36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU?cluster=devnet

## Demo mint

Own SPL mint, 6 decimals, used as demo-USDC. Not Circle USDC.

Mint: `84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq`

https://explorer.solana.com/address/84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq?cluster=devnet

Mint authority stays on the deploy wallet and is **not** in the frontend. The demo faucet mints from a server env var.

## Smoke lifecycle

`npx ts-node --compiler-options '{"module":"commonjs","esModuleInterop":true,"resolveJsonModule":true}' scripts/devnet-smoke.ts`

Creates an invoice, funds it, accepts every milestone, settles. Writes `docs/devnet-smoke.json`.

First settle tx: `7nAnUUVj9NTm4qME8mpT1NHz2W1jn8F6wNpNi772Gy51BY9spCQaAVrDqde44kERMHzV1y9VaJ5MEfxVkmpWkw2`

https://explorer.solana.com/tx/7nAnUUVj9NTm4qME8mpT1NHz2W1jn8F6wNpNi772Gy51BY9spCQaAVrDqde44kERMHzV1y9VaJ5MEfxVkmpWkw2?cluster=devnet
