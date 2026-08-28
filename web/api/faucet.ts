import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const DECIMALS = 6;
const DROP = BigInt(10) * BigInt(10 ** DECIMALS);
const CAP = BigInt(50) * BigInt(10 ** DECIMALS);
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, number>();

function rpcUrl(): string {
  const rpc = process.env.RPC_URL || "https://api.devnet.solana.com";
  if (!/devnet/i.test(rpc)) throw new Error("faucet is devnet only");
  return rpc;
}

function loadAuthority(): Keypair {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) throw new Error("FAUCET_SECRET_KEY missing");
  const parsed = JSON.parse(raw) as number[];
  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error("FAUCET_SECRET_KEY must be a JSON byte array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const pubkeyStr = req.body?.pubkey as string | undefined;
    if (!pubkeyStr) return res.status(400).json({ error: "pubkey required" });

    const now = Date.now();
    const last = hits.get(pubkeyStr) ?? 0;
    if (now - last < WINDOW_MS) {
      return res.status(429).json({ error: "wait before requesting again" });
    }

    const mintStr = process.env.MINT || process.env.VITE_MINT;
    if (!mintStr) return res.status(500).json({ error: "MINT missing" });

    const dest = new PublicKey(pubkeyStr);
    const mint = new PublicKey(mintStr);
    const authority = loadAuthority();
    const connection = new Connection(rpcUrl(), "confirmed");
    const ata = getAssociatedTokenAddressSync(mint, dest);

    try {
      const bal = await connection.getTokenAccountBalance(ata);
      if (BigInt(bal.value.amount) >= CAP) {
        return res.status(400).json({ error: "wallet already at faucet cap" });
      }
    } catch {
      /* no ATA yet */
    }

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: authority.publicKey,
      recentBlockhash: blockhash,
    });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        ata,
        dest,
        mint,
      ),
    );
    tx.add(createMintToInstruction(mint, ata, authority.publicKey, DROP));
    tx.sign(authority);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });

    hits.set(pubkeyStr, now);
    return res.status(200).json({ signature: sig, amount: DROP.toString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
}
