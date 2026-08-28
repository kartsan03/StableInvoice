# StableInvoice

Escrowed USDC invoicing for freelancers on Solana. A client funds a program-controlled
escrow (PDA) upfront; the freelancer gets paid as milestones are accepted, and every
settlement leaves an on-chain record.

**Status:** M1 + M2 implemented. Program deployed to **devnet**. Bankrun **19/19**.
Web demo is next.

Program id (devnet): `36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU`

Explorer: https://explorer.solana.com/address/36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU?cluster=devnet

Demo mint (6 decimals, not Circle USDC): `84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq`

Settle tx: https://explorer.solana.com/tx/7nAnUUVj9NTm4qME8mpT1NHz2W1jn8F6wNpNi772Gy51BY9spCQaAVrDqde44kERMHzV1y9VaJ5MEfxVkmpWkw2?cluster=devnet

## Instructions

- **initialize_invoice** — freelancer creates an invoice: N milestones × fixed USDC amount, tied to a mint. PDA seeds: `[b"invoice", freelancer, index_le]`. Status → `Draft`.
- **fund_escrow** — client deposits the full invoice value (`amount × milestones`) into an invoice-owned escrow ATA. The vault ATA is created idempotently. Status → `Funded`; the payer is recorded as client.
- **accept_milestone** — client signs off on completed milestones one at a time. No token movement. Status stays `Funded`.
- **settle** — invoice `client` **or** `freelancer` drains the vault (`amount_usdc × milestone_count`) into the freelancer ATA via a PDA-signed `transfer_checked`. Allowed only when `status == Funded` **and** `milestones_accepted == milestone_count`. Writes a settlement PDA (seeds `[b"settlement", invoice.key()]`: invoice, amount, timestamp, milestone_count, bump) and sets `status → Settled`. Second settle is rejected (settlement account already exists / status is no longer Funded). If the freelancer ATA is missing it is created idempotently (same pattern as the vault in `fund_escrow`); the settler pays the ATA rent.

MVP note: whoever funds becomes the invoice's client (not fixed at create time).

## Scope

| Slice | What | State |
|---|---|---|
| M1 | `fund_escrow` + `accept_milestone` + bankrun tests | Done |
| M2 | `settle` + settlement PDA + Draft→Funded→Accepted→Settled tests | Done |
| M3 | Devnet deploy + minimal web (create / fund / accept / settle) + public demo | Deploy done; web in repo, public URL next |

Non-goals for this slice: dispute/refund UI, CSV export, mainnet-beta, multi-token.
`cancel_refund` / `expire_refund` are not implemented.

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
anchor build          # requires cargo-build-sbf on PATH
anchor keys sync      # keep declare_id! and Anchor.toml in sync with the keypair
# in-process bankrun, no local validator:
npx ts-mocha -p ./tests/tsconfig.json tests/stable-invoice.ts --timeout 100000
```

`anchor test` uses `[provider].cluster` from `Anchor.toml` (currently `devnet`).
The current workflow is ts-mocha + bankrun, which does not need a deployed program.

## Layout

```
Anchor.toml                          # cluster config + program ids + test script
Cargo.toml                           # workspace (overflow-checks = true required by Anchor)
programs/stable_invoice/Cargo.toml   # program crate (anchor-lang 1.1.2, idl-build feature)
programs/stable_invoice/src/lib.rs   # instructions, Invoice + Settlement accounts, errors
tests/stable-invoice.ts              # M1+M2 bankrun suite (19 cases)
scripts/devnet-smoke.ts              # live create/fund/accept/settle on devnet
web/                                 # Vite + React demo (Phantom / Solflare)
```

## Web (local)

```bash
cd web
cp .env.example .env.local   # public RPC + program id + mint; no secrets
npm install
npm run dev
```

Set `VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_MINT`. Production builds reject localhost RPC.
Mint authority is a server env (`FAUCET_SECRET_KEY`) for `/api/faucet`, not a `VITE_` var.
See `web/README.md`.
