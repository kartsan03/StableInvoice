import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const DECIMALS = 6;
const DROP = 10n * 10n ** BigInt(DECIMALS); // 10 demo USDC
const CAP = 50n * 10n ** BigInt(DECIMALS); // refuse if ATA already at/above 50
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, number>();

function loadAuthority(): Keypair {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) throw new Error("FAUCET_SECRET_KEY missing");
  const parsed = JSON.parse(raw) as number[];
  if (!Array.isArray(parsed) || parsed.length < 32) {
    throw new Error("FAUCET_SECRET_KEY must be a JSON byte array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const rpc = process.env.RPC_URL || clusterApiUrl("devnet");
  if (!/devnet/i.test(rpc)) {
    return res.status(400).json({ error: "faucet is devnet only" });
  }

  try {
    const pubkeyStr = (req.body && req.body.pubkey) as string | undefined;
    if (!pubkeyStr) return res.status(400).json({ error: "pubkey required" });
    const dest = new PublicKey(pubkeyStr);

    const now = Date.now();
    const last = hits.get(dest.toBase58()) ?? 0;
    if (now - last < WINDOW_MS) {
      return res.status(429).json({ error: "wait before requesting again" });
    }

    const mint = new PublicKey(process.env.MINT || process.env.VITE_MINT || "");
    const authority = loadAuthority();
    const connection = new Connection(rpc, "confirmed");

    const ata = getAssociatedTokenAddressSync(mint, dest);
    const existing = await connection.getTokenAccountBalance(ata).catch(() => null);
    if (existing && BigInt(existing.value.amount) >= CAP) {
      return res.status(400).json({ error: "wallet already at faucet cap" });
    }

    const account = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      mint,
      dest,
    );
    const sig = await mintTo(
      connection,
      authority,
      mint,
      account.address,
      authority,
      DROP,
    );
    hits.set(dest.toBase58(), now);
    return res.status(200).json({ signature: sig, amount: DROP.toString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
}
