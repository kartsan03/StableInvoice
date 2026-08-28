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

describe("stable_invoice — M1 + M2 (fund, accept, settle)", () => {
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
  const freelancerB = Keypair.generate();
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
    for (const kp of [freelancer, freelancerB, client, intruder]) {
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
  const settlementPda = (invoice: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), invoice.toBytes()],
      program.programId,
    )[0];
  const vaultFor = (invoice: PublicKey) =>
    getAssociatedTokenAddressSync(mint, invoice, true);
  const ataFor = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner);

  const accountInfo = async (pk: PublicKey) => {
    try {
      return await provider.connection.getAccountInfo(pk);
    } catch {
      return null;
    }
  };
  const tokenAmount = async (pk: PublicKey) => {
    const acc = await accountInfo(pk);
    if (!acc) return 0;
    return Number(acc.data.readBigUInt64LE(64));
  };

  const initInvoice = (
    index: number,
    amount = AMOUNT,
    count = MILESTONES,
    owner: Keypair = freelancer,
  ) => {
    nextSlot();
    return program.methods
      .initializeInvoice(amount, count, new BN(index))
      .accounts({
        freelancer: owner.publicKey,
        invoice: invoicePda(owner.publicKey, index),
        usdcMint: mint,
      })
      .preInstructions([uniqueCu()])
      .signers([owner])
      .rpc();
  };

  const fundEscrow = (index: number, signer: Keypair = client, owner: PublicKey = freelancer.publicKey) => {
    nextSlot();
    const invoice = invoicePda(owner, index);
    return program.methods
      .fundEscrow()
      .accounts({
        client: signer.publicKey,
        invoice,
        vault: vaultFor(invoice),
        usdcMint: mint,
        clientUsdc: getAssociatedTokenAddressSync(mint, signer.publicKey),
      })
      .preInstructions([uniqueCu()])
      .signers([signer])
      .rpc();
  };

  const acceptMilestone = (
    index: number,
    signer: Keypair = client,
    owner: PublicKey = freelancer.publicKey,
  ) => {
    nextSlot();
    return program.methods
      .acceptMilestone()
      .accounts({
        invoice: invoicePda(owner, index),
        client: signer.publicKey,
      })
      .preInstructions([uniqueCu()])
      .signers([signer])
      .rpc();
  };

  const acceptAll = async (
    index: number,
    count = MILESTONES,
    owner: PublicKey = freelancer.publicKey,
  ) => {
    for (let i = 0; i < count; i++) {
      await acceptMilestone(index, client, owner);
    }
  };

  const settleAccounts = (
    index: number,
    authority: Keypair,
    owner: PublicKey = freelancer.publicKey,
  ) => {
    const invoice = invoicePda(owner, index);
    return {
      authority: authority.publicKey,
      invoice,
      freelancer: owner,
      settlement: settlementPda(invoice),
      usdcMint: mint,
      vault: vaultFor(invoice),
      freelancerUsdc: ataFor(owner),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  };

  const settle = (
    index: number,
    authority: Keypair,
    owner: PublicKey = freelancer.publicKey,
  ) => {
    nextSlot();
    return program.methods
      .settle()
      .accounts(settleAccounts(index, authority, owner))
      .preInstructions([uniqueCu()])
      .signers([authority])
      .rpc();
  };

  const expectFail = async (p: Promise<any>, msg: string | string[]) => {
    try {
      await p;
      expect.fail(`expected failure: ${msg}`);
    } catch (e: any) {
      const s = String(e);
      const needles = Array.isArray(msg) ? msg : [msg];
      const hit = needles.some((n) => s.includes(n));
      expect(hit, `expected [${needles.join(" | ")}] in:\n${s}`).to.equal(true);
    }
  };

  // bankrun's blockhash is static — identical txs would collide on signature.
  // A unique compute-budget ix per call keeps every transaction distinct.
  let slot = 0;
  let cuNonce = 0;
  const nextSlot = () => testCtx.warpToSlot(BigInt(++slot));
  const uniqueCu = () =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + (++cuNonce) });

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
    expect(await tokenAmount(vaultFor(invoice))).to.equal(AMOUNT.toNumber() * MILESTONES);
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

  it("settle: freelancer signer — vault drained, ATA credited for amount×milestones, settlement PDA written", async () => {
    const invoice = invoicePda(freelancer.publicKey, 0);
    const total = AMOUNT.toNumber() * MILESTONES;
    const freelancerAta = ataFor(freelancer.publicKey);

    // ATA exists before this call (explicit create — documents the non-empty path).
    await sendTx(
      [createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        freelancerAta,
        freelancer.publicKey,
        mint,
      )],
      [],
    );
    const before = await tokenAmount(freelancerAta);

    await settle(0, freelancer);

    const inv = await program.account.invoice.fetch(invoice);
    expect(inv.status).to.deep.equal({ settled: {} });
    expect(await tokenAmount(vaultFor(invoice))).to.equal(0);
    expect(await tokenAmount(freelancerAta)).to.equal(before + total);

    const rec = await program.account.settlement.fetch(settlementPda(invoice));
    expect(rec.invoice.equals(invoice)).to.be.true;
    expect(rec.amount.toNumber()).to.equal(total);
    expect(rec.milestoneCount).to.equal(MILESTONES);
    expect(Number(rec.timestamp)).to.be.a("number");
  });

  it("settle: double-settle rejected", async () => {
    const invoice = invoicePda(freelancer.publicKey, 0);
    await expectFail(
      settle(0, freelancer),
      ["NotFunded", "already in use", "AlreadyInUse", "AccountAlreadyInitialized"],
    );
    const inv = await program.account.invoice.fetch(invoice);
    expect(inv.status).to.deep.equal({ settled: {} });
    expect(await tokenAmount(vaultFor(invoice))).to.equal(0);
  });

  it("settle: while Draft / before fund rejected", async () => {
    await initInvoice(4);
    await expectFail(settle(4, freelancer), "NotFunded");
  });

  it("settle: before all milestones rejected (2/3 accepted)", async () => {
    await initInvoice(3);
    await fundEscrow(3);
    await acceptMilestone(3);
    await acceptMilestone(3);
    const inv = await program.account.invoice.fetch(invoicePda(freelancer.publicKey, 3));
    expect(inv.milestonesAccepted).to.equal(2);
    await expectFail(settle(3, freelancer), "MilestonesIncomplete");
    expect(await tokenAmount(vaultFor(invoicePda(freelancer.publicKey, 3)))).to.equal(
      AMOUNT.toNumber() * MILESTONES,
    );
  });

  it("settle: wrong signer rejected", async () => {
    await initInvoice(6);
    await fundEscrow(6);
    await acceptAll(6);
    await expectFail(settle(6, intruder), "Unauthorized");
    const inv = await program.account.invoice.fetch(invoicePda(freelancer.publicKey, 6));
    expect(inv.status).to.deep.equal({ funded: {} });
  });

  it("settle: client signer happy path — vault 0, freelancer ATA += total", async () => {
    const index = 2;
    const total = AMOUNT.toNumber() * MILESTONES;
    const invoice = invoicePda(freelancer.publicKey, index);
    const before = await tokenAmount(ataFor(freelancer.publicKey));

    await initInvoice(index);
    await fundEscrow(index);
    await acceptAll(index);
    await settle(index, client);

    const inv = await program.account.invoice.fetch(invoice);
    expect(inv.status).to.deep.equal({ settled: {} });
    expect(await tokenAmount(vaultFor(invoice))).to.equal(0);
    expect(await tokenAmount(ataFor(freelancer.publicKey))).to.equal(before + total);

    const rec = await program.account.settlement.fetch(settlementPda(invoice));
    expect(rec.invoice.equals(invoice)).to.be.true;
    expect(rec.amount.toNumber()).to.equal(total);
    expect(rec.milestoneCount).to.equal(MILESTONES);
  });

  it("after Settled: accept_milestone and fund_escrow still rejected", async () => {
    await expectFail(acceptMilestone(0), "NotFunded");
    await expectFail(fundEscrow(0), "AlreadyFunded");
  });

  it("settle: missing freelancer ATA is created idempotently", async () => {
    const owner = freelancerB;
    const index = 0;
    const total = AMOUNT.toNumber() * MILESTONES;
    const invoice = invoicePda(owner.publicKey, index);
    const ata = ataFor(owner.publicKey);

    expect(await accountInfo(ata)).to.equal(null);

    await initInvoice(index, AMOUNT, MILESTONES, owner);
    await fundEscrow(index, client, owner.publicKey);
    await acceptAll(index, MILESTONES, owner.publicKey);
    await settle(index, owner, owner.publicKey);

    expect(await tokenAmount(vaultFor(invoice))).to.equal(0);
    expect(await tokenAmount(ata)).to.equal(total);
    const rec = await program.account.settlement.fetch(settlementPda(invoice));
    expect(rec.invoice.equals(invoice)).to.be.true;
    expect(rec.amount.toNumber()).to.equal(total);
  });

  it("settle: wrong vault ATA rejected", async () => {
    const index = 7;
    await initInvoice(index);
    await fundEscrow(index);
    await acceptAll(index);
    nextSlot();
    const accounts = settleAccounts(index, freelancer);
    accounts.vault = clientAta;
    await expectFail(
      program.methods.settle().accounts(accounts).preInstructions([uniqueCu()]).signers([freelancer]).rpc(),
      "InvalidVault",
    );
  });

  it("settle: settlement PDA for a different invoice rejected", async () => {
    const index = 8;
    await initInvoice(index);
    await fundEscrow(index);
    await acceptAll(index);
    nextSlot();
    const accounts = settleAccounts(index, freelancer);
    // PDA seeded with invoice 0, not invoice 8
    accounts.settlement = settlementPda(invoicePda(freelancer.publicKey, 0));
    await expectFail(
      program.methods.settle().accounts(accounts).preInstructions([uniqueCu()]).signers([freelancer]).rpc(),
      "ConstraintSeeds",
    );
  });

  it("settle: wrong freelancer ATA rejected", async () => {
    const index = 10;
    await initInvoice(index);
    await fundEscrow(index);
    await acceptAll(index);
    nextSlot();
    const accounts = settleAccounts(index, freelancer);
    accounts.freelancerUsdc = clientAta;
    await expectFail(
      program.methods.settle().accounts(accounts).preInstructions([uniqueCu()]).signers([freelancer]).rpc(),
      "InvalidFreelancerAta",
    );
  });
});
