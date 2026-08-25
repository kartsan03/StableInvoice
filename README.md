# StableInvoice

Escrowed USDC invoicing for freelancers on Solana. A client funds a program-controlled
escrow (PDA) upfront; the freelancer gets paid as milestones are accepted, and every
settlement leaves an on-chain record.

## MVP scope

- **initialize_invoice** — freelancer creates an invoice: N milestones × fixed USDC amount, tied to a USDC mint (devnet).
- **fund_escrow** — client deposits the full invoice value into an invoice-owned escrow token account before work starts.
- **accept_milestone** — client signs off on completed milestones, one at a time.
- **settle** — releases payment for accepted milestones to the freelancer and marks the invoice settled on-chain (the settlement record).

Non-goals for MVP: partial/disputed refunds, multi-token support, recurring invoices, off-chain indexing.

Devnet-only. No deployment included in this skeleton — instruction bodies are stubs behind real account contexts.

## Layout

```
Anchor.toml                          # devnet config
Cargo.toml                           # workspace
programs/stable_invoice/Cargo.toml   # program crate (anchor-lang 0.30)
programs/stable_invoice/src/lib.rs   # instructions, Invoice account, errors
```
