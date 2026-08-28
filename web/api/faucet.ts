import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const DECIMALS = 6;
const DROP = 10 * 10 ** DECIMALS;
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

function loadSecret(): Uint8Array {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) throw new Error("FAUCET_SECRET_KEY missing");
  const parsed = JSON.parse(raw) as number[];
  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error("FAUCET_SECRET_KEY must be a JSON byte array");
  }
  return Uint8Array.from(parsed);
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

function compactU16(n: number): Uint8Array {
  const out: number[] = [];
  let remaining = n;
  while (true) {
    let elem = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(elem);
      break;
    }
    out.push(elem | 0x80);
  }
  return Uint8Array.from(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array {
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const preimage = concat(...seeds, Uint8Array.of(bump), programId, marker);
    const hash = new Uint8Array(createHash("sha256").update(preimage).digest());
    if (!isOnCurve(hash)) return hash;
  }
  throw new Error("failed to derive PDA");
}

function associatedToken(owner: Uint8Array, mint: Uint8Array): Uint8Array {
  return findProgramAddress(
    [owner, bs58.decode(TOKEN_PROGRAM), mint],
    bs58.decode(ASSOCIATED_TOKEN_PROGRAM),
  );
}

function instruction(programIndex: number, accounts: number[], data: Uint8Array): Uint8Array {
  return concat(
    Uint8Array.of(programIndex),
    compactU16(accounts.length),
    Uint8Array.from(accounts),
    compactU16(data.length),
    data,
  );
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

    const secret = loadSecret();
    const authorityPk = ed25519.getPublicKey(secret.slice(0, 32));
    const dest = bs58.decode(pubkeyStr);
    const mint = bs58.decode(mintStr);
    const ata = associatedToken(dest, mint);
    const ataStr = bs58.encode(ata);

    let existing = 0;
    try {
      const info = (await rpc("getTokenAccountBalance", [
        ataStr,
        { commitment: "confirmed" },
      ])) as { value?: { amount?: string } };
      existing = info?.value?.amount ? Number(info.value.amount) : 0;
    } catch {
      existing = 0;
    }
    if (existing >= CAP) {
      return res.status(400).json({ error: "wallet already at faucet cap" });
    }

    const latest = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
      value?: { blockhash: string };
      blockhash?: string;
    };
    const blockhashStr = latest.value?.blockhash || latest.blockhash;
    if (!blockhashStr) throw new Error("no blockhash");

    const sameOwner = Buffer.compare(authorityPk, dest) === 0;
    const sys = bs58.decode(SYSTEM_PROGRAM);
    const token = bs58.decode(TOKEN_PROGRAM);
    const ataProg = bs58.decode(ASSOCIATED_TOKEN_PROGRAM);
    const keys = sameOwner
      ? [authorityPk, ata, mint, sys, token, ataProg]
      : [authorityPk, ata, mint, dest, sys, token, ataProg];
    const ownerIdx = sameOwner ? 0 : 3;
    const sysIdx = sameOwner ? 3 : 4;
    const tokenIdx = sameOwner ? 4 : 5;
    const ataProgIdx = sameOwner ? 5 : 6;
    const header = Uint8Array.of(1, 0, sameOwner ? 3 : 4);
    const amount = new Uint8Array(8);
    new DataView(amount.buffer).setBigUint64(0, BigInt(DROP), true);
    const createAta = instruction(ataProgIdx, [0, 1, ownerIdx, 2, sysIdx, tokenIdx], Uint8Array.of(1));
    const mintTo = instruction(tokenIdx, [2, 1, 0], concat(Uint8Array.of(7), amount));
    const message = concat(
      header,
      compactU16(keys.length),
      concat(...keys),
      bs58.decode(blockhashStr),
      compactU16(2),
      createAta,
      mintTo,
    );
    const signature = ed25519.sign(message, secret.slice(0, 32));
    const tx = concat(compactU16(1), signature, message);
    const sig = (await rpc("sendTransaction", [
      Buffer.from(tx).toString("base64"),
      { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
    ])) as string;

    hits.set(pubkeyStr, now);
    return res.status(200).json({ signature: sig, amount: String(DROP) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
}
