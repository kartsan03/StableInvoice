# StableInvoice

Escrowed USDC invoicing for freelancers on Solana. A client funds a program-controlled
escrow (PDA) upfront; the freelancer gets paid as milestones are accepted, and every
settlement leaves an on-chain record.

**Status:** M1 + M2 are implemented (`v0.2.0-m2`). `initialize_invoice`, `fund_escrow`,
`accept_milestone`, and `settle` run with CPI `transfer_checked` and status guards.
Bankrun suite: **19/19 passing**. Not deployed to devnet yet.

Program id (localnet / planned devnet): `36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU`

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
| M3 | Devnet deploy + minimal web (create / fund / accept / settle) + public demo | Next |

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
```
