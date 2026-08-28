import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PROGRAM_ID } from "./config";

export function invoicePda(freelancer: PublicKey, index: number | BN): PublicKey {
  const i = BN.isBN(index) ? index : new BN(index);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("invoice"), freelancer.toBuffer(), i.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
}

export function settlementPda(invoice: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), invoice.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function vaultAta(invoice: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, invoice, true);
}
