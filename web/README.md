# StableInvoice web

Vite + React client for the **devnet** program. Phantom and Solflare only.

## Env

Copy `.env.example` to `.env.local` for local work.

```
VITE_RPC_URL=https://api.devnet.solana.com
VITE_PROGRAM_ID=36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU
VITE_MINT=84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq
```

Production builds refuse a localhost RPC. Mint authority is **not** a `VITE_` var.

Server faucet (`/api/faucet`) needs, on the host, never in the browser:

```
FAUCET_SECRET_KEY=[...json byte array of the mint authority...]
RPC_URL=https://api.devnet.solana.com
MINT=84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq
```

Cap: 10 demo USDC per call, refused if the ATA already holds 50+, 10 minute cooldown, devnet RPC only.

## Local

```bash
cd web
npm install
npm run dev
```

Faucet will 404 until the Vercel function is deployed. You can still create invoices if the wallet already has demo mint tokens.

## Roles

Connect wallet A as freelancer → Create. Connect wallet B as client → Get demo tokens → Fund → Accept until the counter is full → Settle. Either party may settle.
