# StableInvoice

Escrowed USDC invoicing for freelancers on Solana. A client funds a program-controlled
escrow (PDA) upfront; the freelancer gets paid as milestones are accepted, and every
settlement leaves an on-chain record.

**Status:** M1 is implemented. `initialize_invoice`, `fund_escrow`, and `accept_milestone`
run with CPI token transfers and status guards. `settle` is still a stub (M2). Bankrun
suite: **9/9 passing**. Not deployed to devnet yet.

Program id (localnet / planned devnet): `36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU`

## Instructions

- **initialize_invoice** — freelancer creates an invoice: N milestones × fixed USDC amount, tied to a mint. PDA seeds: `[b"invoice", freelancer, index_le]`. Status → `Draft`.
- **fund_escrow** — client deposits the full invoice value (`amount × milestones`) into an invoice-owned escrow ATA. The vault ATA is created idempotently. Status → `Funded`; the payer is recorded as client.
- **accept_milestone** — client signs off on completed milestones one at a time. No token movement. Status stays `Funded`.
- **settle** *(stub — M2)* — will drain vault → freelancer ATA and write a settlement PDA. Currently returns `NotImplemented`.

MVP note: whoever funds becomes the invoice's client (not fixed at create time).

## Scope

| Slice | What | State |
|---|---|---|
| M1 | `fund_escrow` + `accept_milestone` + bankrun tests | Done |
| M2 | `settle` + settlement PDA + Created→Funded→Accepted→Settled tests | Next |
| M3 | Devnet deploy + minimal web (create / fund / accept / settle) + public demo | After M2 |

Non-goals for this slice: dispute/refund UI, CSV export, mainnet-beta, multi-token.

## Development environment

Windows host → WSL2 Ubuntu 24.04. Repo must live inside the WSL filesystem
(`~/projects/StableInvoice`), not `/mnt/...`.

Toolchain:

- Rust stable 1.98+ (`rustup`)
- Agave CLI 4.2.x (`~/.local/share/solana/install/active_release/bin`) — provides `solana`, `cargo-build-sbf`
- Anchor CLI 1.1.2 (`~/.local/bin/anchor`, prebuilt binary from coral-xyz releases)
- anchor-lang / anchor-spl pinned to 1.1.2 in `programs/stable_invoice/Cargo.toml`

Build / test:

```bash
cd ~/projects/StableInvoice
anchor build          # requires cargo-build-sbf on PATH
anchor keys sync      # keep declare_id! and Anchor.toml in sync with the keypair
anchor test           # in-process bankrun, no local validator
```

Devnet deploy needs `~/.config/solana/id.json` funded via `solana airdrop` or a faucet.
That wallet is not created yet.

## Layout

```
Anchor.toml                          # cluster config + program ids + test script
Cargo.toml                           # workspace (overflow-checks = true required by Anchor)
programs/stable_invoice/Cargo.toml   # program crate (anchor-lang 1.1.2, idl-build feature)
programs/stable_invoice/src/lib.rs   # instructions, Invoice account, errors
tests/stable-invoice.ts              # M1 bankrun suite (9 cases)
```
