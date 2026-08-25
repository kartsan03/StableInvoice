# StableInvoice

Escrowed USDC invoicing for freelancers on Solana. A client funds a program-controlled
escrow (PDA) upfront; the freelancer gets paid as milestones are accepted, and every
settlement leaves an on-chain record.

**Status:** devnet MVP skeleton — instruction contexts are real, bodies are stubs.
Toolchain verified: compiles clean on Rust 1.98 / Agave CLI 4.2.1 / Anchor 1.1.2.

## Instructions

- **initialize_invoice** — freelancer creates an invoice: N milestones × fixed USDC amount, tied to a USDC mint. PDA seeds: `[b"invoice", freelancer, index_le]`.
- **fund_escrow** *(stub)* — client deposits the full invoice value into an invoice-owned escrow ATA before work starts. Status → `Funded`.
- **accept_milestone** *(stub)* — client signs off on completed milestones one at a time.
- **settle** *(stub)* — releases payment for accepted milestones to the freelancer and writes the on-chain settlement record. Status → `Settled`.

## Roadmap to mainnet-beta

| Milestone | What | Where in code |
|---|---|---|
| M1 | Fill `fund_escrow`, `accept_milestone`, `settle` bodies (CPI transfers, status guards); devnet deploy; integration tests | `programs/stable_invoice/src/lib.rs` |
| M2 | Dispute path end-to-end: `cancel_refund` (client-side, pre-settle, accepted=0), permissionless `expire_refund` after deadline; partial refund semantics; tests | same + new accounts (`[b"settlement", invoice]`) |
| M3 | Freelancer settlement dashboard (Vite+React + wallet-adapter), CSV export, docs | new `app/` workspace |

Non-goals for MVP: multi-token support, recurring invoices, off-chain indexing.

## Development environment

Windows host → WSL2 Ubuntu 24.04. Repo must live inside the WSL filesystem
(`~/projects/StableInvoice`), not `/mnt/...`.

Toolchain:

- Rust stable 1.98+ (`rustup`)
- Agave CLI 4.2.x (`~/.local/share/solana/install/active_release/bin`) — provides `solana`, `cargo-build-sbf`
- Anchor CLI 1.1.2 (`~/.local/bin/anchor`, prebuilt binary from coral-xyz releases)
- anchor-lang / anchor-spl pinned to 1.1.2 in `programs/stable_invoice/Cargo.toml`

Build:

```bash
cd ~/projects/StableInvoice
anchor build          # requires cargo-build-sbf on PATH
anchor keys sync      # keep declare_id! and Anchor.toml in sync with the keypair
anchor test           # bankrun/litesvm-based once tests exist
```

Devnet deploy needs `~/.config/solana/id.json` funded via `solana airdrop` or a faucet.

## Layout

```
Anchor.toml                          # devnet config + program ids
Cargo.toml                           # workspace (overflow-checks = true required by Anchor)
programs/stable_invoice/Cargo.toml   # program crate (anchor-lang 1.1.2, idl-build feature)
programs/stable_invoice/src/lib.rs   # instructions, Invoice account, errors
```
