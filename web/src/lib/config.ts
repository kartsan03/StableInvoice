import { PublicKey } from "@solana/web3.js";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM = "36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU";
const DEFAULT_MINT = "84rKt5u5YR33eeyGbYTYErckG9aj1yNpK1aVzqhR2WRq";

function requiredPublic(name: string, fallback: string): string {
  const v = import.meta.env[name] as string | undefined;
  if (import.meta.env.PROD) {
    if (!v) throw new Error(`${name} is missing`);
    if (/localhost|127\.0\.0\.1/i.test(v)) {
      throw new Error(`${name} must not be localhost in production`);
    }
    return v;
  }
  return v || fallback;
}

export const RPC_URL = requiredPublic("VITE_RPC_URL", DEFAULT_RPC);
export const PROGRAM_ID = new PublicKey(
  requiredPublic("VITE_PROGRAM_ID", DEFAULT_PROGRAM),
);
export const MINT = new PublicKey(requiredPublic("VITE_MINT", DEFAULT_MINT));
export const DECIMALS = 6;
export const EXPLORER_CLUSTER = "devnet";

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${EXPLORER_CLUSTER}`;
}

export function explorerAddr(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=${EXPLORER_CLUSTER}`;
}
