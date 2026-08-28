# StableInvoice

Escrowed USDC invoicing for freelancers on Solana. A client funds a program-controlled
escrow (PDA) upfront; the freelancer gets paid as milestones are accepted, and every
settlement leaves an on-chain record.

**Status:** M1–M3 shipped on **devnet** (`v0.3.0-demo`). Bankrun **19/19**.

Demo: https://temporary-sonic-hazel-08suny1.vercel.app  
(devnet only. Phantom or Solflare. Two wallets: freelancer creates, client funds and accepts.)

Program id: `36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU`  
https://explorer.solana.com/address/36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU?cluster=devnet

Demo mint (6 decimals, not Circle USDC): `84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq`  
https://explorer.solana.com/address/84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq?cluster=devnet

Settle tx: https://explorer.solana.com/tx/7nAnUUVj9NTm4qME8mpT1NHz2W1jn8F6wNpNi772Gy51BY9spCQaAVrDqde44kERMHzV1y9VaJ5MEfxVkmpWkw2?cluster=devnet

## Instructions

- **initialize_invoice** — freelancer creates an invoice: N milestones × fixed USDC amount, tied to a mint. PDA seeds: `[b"invoice", freelancer, index_le]`. Status → `Draft`.
- **fund_escrow** — client deposits the full invoice value (`amount × milestones`) into an invoice-owned escrow ATA. The vault ATA is created idempotently. Status → `Funded`; the payer is recorded as client.
- **accept_milestone** — client signs off on completed milestones one at a time. No token movement. Status stays `Funded`.
- **settle** — invoice `client` **or** `freelancer` drains the vault (`amount_usdc × milestone_count`) into the freelancer ATA via a PDA-signed `transfer_checked`. Allowed only when `status == Funded` **and** `milestones_accepted == milestone_count`. Writes a settlement PDA (seeds `[b"settlement", invoice.key()]`: invoice, amount, timestamp, milestone_count, bump) and sets `status → Settled`. Second settle is rejected (settlement account already exists / status is no longer Funded). If the freelancer ATA is missing it is created idempotently (same pattern as the vault in `fund_escrow`); the settler pays the ATA rent.

Whoever funds becomes the invoice's client (not fixed at create time).

## Scope

| Slice | What | State |
|---|---|---|
| M1 | `fund_escrow` + `accept_milestone` + bankrun tests | Done |
| M2 | `settle` + settlement PDA + Draft→Funded→Accepted→Settled tests | Done |
| M3 | Devnet deploy + web (create / fund / accept / settle) + public demo | Done |

Not in this slice: dispute/refund UI, CSV export, mainnet-beta, multi-token, the 25-invoice KPI batch.
`cancel_refund` / `expire_refund` are not implemented.

## Demo tokens

The page mints **demo USDC** (the mint above), 10 per request, cap 50 per wallet, 10 minute cooldown, **devnet only**. Mint authority is a server env on Vercel, not a `VITE_` variable.

## Development environment

Work on a native Linux filesystem. On Linux and macOS that is the host checkout. On
Windows use WSL2 (or another Linux FS) — do not check the repo out under
`/mnt/<windows-drive>` (9p/drvfs); Anchor/SBF builds are miserable there.

Toolchain:

- Rust stable 1.98+ (`rustup`)
- Agave CLI 4.2.x — provides `solana`, `cargo-build-sbf`
- Anchor CLI 1.1.2
- anchor-lang / anchor-spl pinned to 1.1.2 in `programs/stable_invoice/Cargo.toml`

Build / test:

```bash
anchor build
anchor keys sync
npx ts-mocha -p ./tests/tsconfig.json tests/stable-invoice.ts --timeout 100000
```

`anchor test` uses `[provider].cluster` from `Anchor.toml` (currently `devnet`).
Bankrun does not need a deployed program.

Web:

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

`VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_MINT` are public. Production builds reject localhost RPC.
See `web/README.md` and `docs/devnet.md`.

## Layout

```
Anchor.toml
Cargo.toml
programs/stable_invoice/src/lib.rs
tests/stable-invoice.ts
scripts/devnet-smoke.ts
docs/devnet.md
web/
```
