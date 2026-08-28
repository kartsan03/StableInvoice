/**
 * One-shot create → fund → accept-all → settle against the deployed program.
 * Uses ~/.config/solana/id.json. Does not print secrets.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BN, Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU");
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const AMOUNT = new BN(1_000_000); // 1.00 (6 decimals)
const MILESTONES = 2;

function loadIdl(): Idl {
  const p = path.join(__dirname, "..", "target", "idl", "stable_invoice.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadPayer(): Keypair {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const payer = loadPayer();
  const connection = new Connection(RPC, "confirmed");
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program(loadIdl(), provider);

  const freelancer = Keypair.generate();
  const client = Keypair.generate();

  for (const kp of [freelancer, client]) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.round(0.05 * LAMPORTS_PER_SOL),
      }),
    );
    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  const clientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    client.publicKey,
  );
  await mintTo(connection, payer, mint, clientAta.address, payer, 10_000_000);

  const index = Date.now() % 1_000_000_000;
  const [invoice] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("invoice"),
      freelancer.publicKey.toBuffer(),
      new BN(index).toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
  const [settlement] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), invoice.toBuffer()],
    PROGRAM_ID,
  );
  const vault = getAssociatedTokenAddressSync(mint, invoice, true);
  const freelancerAta = getAssociatedTokenAddressSync(mint, freelancer.publicKey);

  const initSig = await program.methods
    .initializeInvoice(AMOUNT, MILESTONES, new BN(index))
    .accounts({
      freelancer: freelancer.publicKey,
      invoice,
      usdcMint: mint,
    })
    .signers([freelancer])
    .rpc();

  const fundSig = await program.methods
    .fundEscrow()
    .accounts({
      client: client.publicKey,
      invoice,
      vault,
      usdcMint: mint,
      clientUsdc: clientAta.address,
    })
    .signers([client])
    .rpc();

  const acceptSigs: string[] = [];
  for (let i = 0; i < MILESTONES; i++) {
    const s = await program.methods
      .acceptMilestone()
      .accounts({
        invoice,
        client: client.publicKey,
      })
      .signers([client])
      .rpc();
    acceptSigs.push(s);
  }

  const settleSig = await program.methods
    .settle()
    .accounts({
      authority: freelancer.publicKey,
      invoice,
      freelancer: freelancer.publicKey,
      settlement,
      usdcMint: mint,
      vault,
      freelancerUsdc: freelancerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([freelancer])
    .rpc();

  const rec = await (program.account as any).settlement.fetch(settlement);
  const inv = await (program.account as any).invoice.fetch(invoice);

  const out = {
    cluster: "devnet",
    programId: PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    mintAuthority: payer.publicKey.toBase58(),
    invoice: invoice.toBase58(),
    settlement: settlement.toBase58(),
    freelancer: freelancer.publicKey.toBase58(),
    client: client.publicKey.toBase58(),
    index,
    amountUsdc: AMOUNT.toString(),
    milestoneCount: MILESTONES,
    status: inv.status,
    settlementAmount: rec.amount.toString(),
    signatures: { init: initSig, fund: fundSig, accept: acceptSigs, settle: settleSig },
    explorer: {
      settle: `https://explorer.solana.com/tx/${settleSig}?cluster=devnet`,
      program: `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`,
      mint: `https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`,
    },
  };

  const dest = path.join(__dirname, "..", "docs", "devnet-smoke.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
