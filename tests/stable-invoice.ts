import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { StableInvoice } from "../target/types/stable_invoice";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { expect } from "chai";

describe("stable_invoice — M1 (fund_escrow + accept_milestone)", () => {
  let provider: BankrunProvider;
  let program: Program<StableInvoice>;
  let banksClient: any;
  let payer: Keypair;
  let testCtx: any;

  const sendTx = async (ixs: any[], signers: Keypair[]) => {
    const latest = await banksClient.getLatestBlockhash();
    const blockhash = Array.isArray(latest) ? latest[0] : latest?.blockhash;
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    await banksClient.processTransaction(tx);
  };

  const freelancer = Keypair.generate();
  const client = Keypair.generate();
  const intruder = Keypair.generate();

  const AMOUNT = new BN(1_000_000); // 1.00 token (6 decimals)
  const MILESTONES = 3;
  const MINT_RENT = 1_461_600; // rent-exempt for a plain SPL mint
  let mint: PublicKey;
  let clientAta: PublicKey;

  before(async () => {
    const installed = await startAnchor("", [], []);
    testCtx = installed;
    banksClient = installed.banksClient;
    slot = Number(await banksClient.getSlot());
    provider = new BankrunProvider(installed);
    anchor.setProvider(provider);
    // @ts-expect-error bankrun wallet.payer is a Keypair
    payer = provider.wallet.payer;
    program = anchor.workspace.StableInvoice as Program<StableInvoice>;

    // --- low-level token setup (spl-token action helpers need a real
    // connection.sendTransaction, which bankrun does not provide) ---

    const mintKp = Keypair.generate();
    const mintPk = mintKp.publicKey;
    await sendTx(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mintPk,
          space: MINT_SIZE,
          lamports: MINT_RENT,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mintPk, 6, payer.publicKey, null),
      ],
      [mintKp],
    );
    mint = mintPk;

    clientAta = getAssociatedTokenAddressSync(mintPk, client.publicKey);
    await sendTx(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          clientAta,
          client.publicKey,
          mintPk,
        ),
        createMintToInstruction(mintPk, clientAta, payer.publicKey, 100_000_000),
      ],
      [],
    );

    // fund wallets via plain transfers (bankrun has no airdrop)
    for (const kp of [freelancer, client, intruder]) {
      await sendTx([anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: LAMPORTS_PER_SOL,
      })], []);
    }
  });

  const invoicePda = (owner: PublicKey, index: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), owner.toBytes(), new BN(index).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  const vaultFor = (invoice: PublicKey) =>
    getAssociatedTokenAddressSync(mint, invoice, true);

  const initInvoice = (index: number, amount = AMOUNT, count = MILESTONES) => {
    nextSlot();
    return program.methods
      .initializeInvoice(amount, count, new BN(index))
      .accounts({
        freelancer: freelancer.publicKey,
        invoice: invoicePda(freelancer.publicKey, index),
        usdcMint: mint,
      })
      .signers([freelancer])
      .rpc();
  };

  const fundEscrow = (index: number, signer: Keypair = client) => {
    nextSlot();
    const invoice = invoicePda(freelancer.publicKey, index);
    return program.methods
      .fundEscrow()
      .accounts({
        client: signer.publicKey,
        invoice,
        vault: vaultFor(invoice),
        usdcMint: mint,
        clientUsdc: getAssociatedTokenAddressSync(mint, signer.publicKey),
      })
      .signers([signer])
      .rpc();
  };

  const acceptMilestone = (index: number, signer: Keypair = client) => {
    nextSlot();
    return program.methods
      .acceptMilestone()
      .accounts({
        invoice: invoicePda(freelancer.publicKey, index),
        client: signer.publicKey,
      })
      .signers([signer])
      .rpc();
  };

  const expectFail = async (p: Promise<any>, msg: string) => {
    try {
      await p;
      expect.fail(`expected failure: ${msg}`);
    } catch (e: any) {
      expect(String(e)).to.include(msg);
    }
  };

  // bankrun's blockhash is static — identical txs would collide on signature.
  // A unique compute-budget ix per call keeps every transaction distinct.
  let slot = 0;
  const nextSlot = () => testCtx.warpToSlot(BigInt(++slot));

  it("initialize_invoice: happy path — account fields match", async () => {
    await initInvoice(0);
    const inv = await program.account.invoice.fetch(invoicePda(freelancer.publicKey, 0));
    expect(inv.freelancer.equals(freelancer.publicKey)).to.be.true;
    expect(inv.usdcMint.equals(mint)).to.be.true;
    expect(inv.amountUsdc.eq(AMOUNT)).to.be.true;
    expect(inv.milestoneCount).to.equal(MILESTONES);
    expect(inv.milestonesAccepted).to.equal(0);
    expect(inv.status).to.deep.equal({ draft: {} });
    expect(PublicKey.default.equals(inv.client)).to.be.true;
  });

  it("initialize_invoice: zero amount rejected", async () => {
    await expectFail(initInvoice(9, new BN(0)), "InvalidInvoiceParams");
  });

  it("fund_escrow: happy path — vault holds total, status -> Funded, client recorded", async () => {
    await fundEscrow(0);
    const invoice = invoicePda(freelancer.publicKey, 0);
    const inv = await program.account.invoice.fetch(invoice);
    expect(inv.status).to.deep.equal({ funded: {} });
    expect(inv.client.equals(client.publicKey)).to.be.true;
    const vault = await provider.connection.getAccountInfo(vaultFor(invoice));
    const vaultBalance = Number(vault.data.readBigUInt64LE(64));
    expect(vaultBalance).to.equal(AMOUNT.toNumber() * MILESTONES);
  });

  it("fund_escrow: double-fund rejected", async () => {
    await expectFail(fundEscrow(0), "AlreadyFunded");
  });

  it("accept_milestone: increments counter while Funded", async () => {
    await acceptMilestone(0);
    const inv = await program.account.invoice.fetch(invoicePda(freelancer.publicKey, 0));
    expect(inv.milestonesAccepted).to.equal(1);
  });

  it("accept_milestone: before fund rejected", async () => {
    await initInvoice(1);
    await expectFail(acceptMilestone(1), "NotFunded");
  });

  it("accept_milestone: non-client signature rejected", async () => {
    await expectFail(acceptMilestone(0, intruder), "Unauthorized");
  });

  it("accept_milestone: beyond milestone_count rejected", async () => {
    await acceptMilestone(0); // 2/3
    await acceptMilestone(0); // 3/3
    await expectFail(acceptMilestone(0), "AllMilestonesAccepted");
    const inv = await program.account.invoice.fetch(invoicePda(freelancer.publicKey, 0));
    expect(inv.milestonesAccepted).to.equal(MILESTONES);
  });

  it("settle: still an M2 stub (NotImplemented)", async () => {
    const invoice = invoicePda(freelancer.publicKey, 0);
    // freelancer ATA must exist for settle's account constraints to pass
    await sendTx(
      [createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        getAssociatedTokenAddressSync(mint, freelancer.publicKey),
        freelancer.publicKey,
        mint,
      )],
      [],
    );
    await expectFail(
      program.methods
        .settle()
        .accounts({
          freelancer: freelancer.publicKey,
          invoice,
          vault: vaultFor(invoice),
          usdcMint: mint,
          freelancerUsdc: getAssociatedTokenAddressSync(mint, freelancer.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([freelancer])
        .rpc(),
      "NotImplemented",
    );
  });
});
