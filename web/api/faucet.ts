import type { VercelRequest, VercelResponse } from "@vercel/node";

const DECIMALS = 6;
const DROP = 10 * 10 ** DECIMALS; // 10 demo USDC
const CAP = 50 * 10 ** DECIMALS;
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, number>();

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function rpcUrl(): string {
  const rpc = process.env.RPC_URL || "https://api.devnet.solana.com";
  if (!/devnet/i.test(rpc)) throw new Error("faucet is devnet only");
  return rpc;
}

function loadSecret(): number[] {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) throw new Error("FAUCET_SECRET_KEY missing");
  const parsed = JSON.parse(raw) as number[];
  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error("FAUCET_SECRET_KEY must be a JSON byte array");
  }
  return parsed;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
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

    const mint = process.env.MINT || process.env.VITE_MINT;
    if (!mint) return res.status(500).json({ error: "MINT missing" });
    const secret = loadSecret();

    // Dynamic import keeps web3.js off the CJS function bootstrap path.
    const web3 = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const dest = new web3.PublicKey(pubkeyStr);
    const mintPk = new web3.PublicKey(mint);
    const authority = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
    const ata = spl.getAssociatedTokenAddressSync(mintPk, dest);

    const info = (await rpc("getTokenAccountBalance", [ata.toBase58(), { commitment: "confirmed" }])) as
      | { value?: { amount?: string } }
      | null;
    const existing = info?.value?.amount ? Number(info.value.amount) : 0;
    if (existing >= CAP) {
      return res.status(400).json({ error: "wallet already at faucet cap" });
    }

    const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
      blockhash: string;
    };

    const tx = new web3.Transaction({
      feePayer: authority.publicKey,
      recentBlockhash: blockhash,
    });
    tx.add(
      spl.createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        ata,
        dest,
        mintPk,
        new web3.PublicKey(TOKEN_PROGRAM),
        new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
      ),
    );
    tx.add(
      spl.createMintToInstruction(
        mintPk,
        ata,
        authority.publicKey,
        BigInt(DROP),
        [],
        new web3.PublicKey(TOKEN_PROGRAM),
      ),
    );
    // silence unused SYSTEM_PROGRAM if tree-shaken
    void SYSTEM_PROGRAM;

    tx.sign(authority);
    const raw = tx.serialize();
    const sig = (await rpc("sendTransaction", [
      Buffer.from(raw).toString("base64"),
      { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
    ])) as string;

    hits.set(pubkeyStr, now);
    return res.status(200).json({ signature: sig, amount: String(DROP) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
}
