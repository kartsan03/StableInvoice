import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import "@solana/wallet-adapter-react-ui/styles.css";
import { MINT, PROGRAM_ID, RPC_URL, explorerAddr, explorerTx } from "./lib/config";
import { formatStable, toRaw, truncateAddress } from "./lib/format";
import { invoicePda, settlementPda, vaultAta } from "./lib/pda";
import { useProgram } from "./lib/useProgram";

type StatusKey = "draft" | "funded" | "settled";

type InvoiceRow = {
  publicKey: PublicKey;
  index: BN;
  freelancer: PublicKey;
  client: PublicKey;
  amountUsdc: BN;
  milestoneCount: number;
  milestonesAccepted: number;
  status: StatusKey;
};

function statusOf(s: unknown): StatusKey {
  if (s && typeof s === "object") {
    if ("funded" in s) return "funded";
    if ("settled" in s) return "settled";
  }
  return "draft";
}

function Amount({ raw }: { raw: bigint | number }) {
  const f = formatStable(raw);
  return (
    <span className="mono" style={{ fontVariantNumeric: "tabular-nums" }} aria-label={`${f.aria} demo USDC`}>
      {f.text}
    </span>
  );
}

function copy(text: string) {
  void navigator.clipboard.writeText(text);
}

function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function Desk() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const program = useProgram();
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [amount, setAmount] = useState("1.00");
  const [milestones, setMilestones] = useState("2");
  const [index, setIndex] = useState(() => String(Date.now() % 1_000_000_000));
  const [balance, setBalance] = useState<bigint | null>(null);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setErr(null);
    try {
      const sig = await fn();
      if (sig) setLastTx(sig);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshBalance = useCallback(async () => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    const ata = getAssociatedTokenAddressSync(MINT, publicKey);
    const info = await connection.getTokenAccountBalance(ata).catch(() => null);
    setBalance(info ? BigInt(info.value.amount) : 0n);
  }, [connection, publicKey]);

  const refresh = useCallback(async () => {
    if (!program) return;
    const ns = program.account as unknown as {
      invoice: { all: () => Promise<Array<{ publicKey: PublicKey; account: Record<string, unknown> }>> };
    };
    const all = await ns.invoice.all();
    const mapped: InvoiceRow[] = all
      .map((a: { publicKey: PublicKey; account: Record<string, unknown> }) => {
        const acc = a.account;
        return {
          publicKey: a.publicKey,
          index: acc.index as BN,
          freelancer: acc.freelancer as PublicKey,
          client: acc.client as PublicKey,
          amountUsdc: acc.amountUsdc as BN,
          milestoneCount: acc.milestoneCount as number,
          milestonesAccepted: acc.milestonesAccepted as number,
          status: statusOf(acc.status),
        };
      })
      .sort((a: InvoiceRow, b: InvoiceRow) => b.index.toNumber() - a.index.toNumber());
    setRows(mapped);
    await refreshBalance();
  }, [program, refreshBalance]);

  const faucet = () =>
    run("faucet", async () => {
      if (!publicKey) throw new Error("Connect a wallet first");
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey: publicKey.toBase58() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `faucet ${res.status}`);
      await refreshBalance();
      return body.signature as string;
    });

  const createInvoice = () =>
    run("create", async () => {
      if (!program || !publicKey) throw new Error("Connect as the freelancer");
      const amt = toRaw(amount);
      const count = Number(milestones);
      const idx = Number(index);
      if (!Number.isInteger(count) || count < 1 || count > 32) {
        throw new Error("milestone count must be 1–32");
      }
      const invoice = invoicePda(publicKey, idx);
      const sig = await program.methods
        .initializeInvoice(new BN(amt.toString()), count, new BN(idx))
        .accounts({
          freelancer: publicKey,
          invoice,
          usdcMint: MINT,
        })
        .rpc();
      await refresh();
      return sig;
    });

  const fund = (row: InvoiceRow) =>
    run("fund", async () => {
      if (!program || !publicKey) throw new Error("Connect as the client");
      const vault = vaultAta(row.publicKey, MINT);
      const clientUsdc = getAssociatedTokenAddressSync(MINT, publicKey);
      const sig = await program.methods
        .fundEscrow()
        .accounts({
          client: publicKey,
          invoice: row.publicKey,
          vault,
          usdcMint: MINT,
          clientUsdc,
        })
        .rpc();
      await refresh();
      return sig;
    });

  const accept = (row: InvoiceRow) =>
    run("accept", async () => {
      if (!program || !publicKey) throw new Error("Connect as the client");
      const sig = await program.methods
        .acceptMilestone()
        .accounts({
          invoice: row.publicKey,
          client: publicKey,
        })
        .rpc();
      await refresh();
      return sig;
    });

  const settle = (row: InvoiceRow) =>
    run("settle", async () => {
      if (!program || !publicKey) throw new Error("Connect as client or freelancer");
      const vault = vaultAta(row.publicKey, MINT);
      const freelancerUsdc = getAssociatedTokenAddressSync(MINT, row.freelancer);
      const sig = await program.methods
        .settle()
        .accounts({
          authority: publicKey,
          invoice: row.publicKey,
          freelancer: row.freelancer,
          settlement: settlementPda(row.publicKey),
          usdcMint: MINT,
          vault,
          freelancerUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await refresh();
      return sig;
    });

  return (
    <>
      <header className="mast">
        <div>
          <h1>StableInvoice</h1>
          <span className="badge">devnet</span>
        </div>
        <WalletMultiButton />
      </header>
      <main className="wrap">
        <p className="lede">
          Client locks demo USDC in a program vault. Freelancer is paid when every
          milestone is accepted. This page talks to Solana <strong>devnet</strong> only.
        </p>

        <p className="muted">
          Demo mint (6 decimals, not Circle USDC):{" "}
          <button className="ghost" type="button" onClick={() => copy(MINT.toBase58())}>
            {truncateAddress(MINT.toBase58(), 6)}
          </button>{" "}
          <a href={explorerAddr(MINT.toBase58())} target="_blank" rel="noreferrer">
            explorer
          </a>
          . Program{" "}
          <a href={explorerAddr(PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
            {truncateAddress(PROGRAM_ID.toBase58(), 4)}
          </a>
          .
        </p>

        <div className="row">
          <button type="button" onClick={faucet} disabled={!connected || busy !== null}>
            Get demo tokens
          </button>
          <button className="ghost" type="button" onClick={() => refresh()} disabled={!program || busy !== null}>
            Refresh invoices
          </button>
          {balance !== null && (
            <span className="meta">
              wallet: <Amount raw={balance} /> demo USDC
            </span>
          )}
        </div>
        <p className="muted">
          Use two wallets: freelancer creates the invoice, client funds and accepts.
          Same wallet can play both roles if you want a solo dry run.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createInvoice();
          }}
        >
          <h2>Create invoice</h2>
          <p className="muted">Signed by the connected wallet as freelancer.</p>
          <label htmlFor="amount">Amount per milestone (demo USDC)</label>
          <input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <label htmlFor="count">Milestone count</label>
          <input
            id="count"
            inputMode="numeric"
            value={milestones}
            onChange={(e) => setMilestones(e.target.value)}
          />
          <label htmlFor="index">Invoice index</label>
          <input
            id="index"
            inputMode="numeric"
            value={index}
            onChange={(e) => setIndex(e.target.value)}
          />
          <div className="row">
            <button type="submit" disabled={!connected || busy !== null}>
              Create
            </button>
          </div>
        </form>

        {busy && <p className="muted">Working: {busy}…</p>}
        {err && <p className="err">{err}</p>}
        {lastTx && (
          <p className="ok">
            Last tx:{" "}
            <a href={explorerTx(lastTx)} target="_blank" rel="noreferrer">
              {truncateAddress(lastTx, 8)}
            </a>
          </p>
        )}

        <section>
          <h2>Invoices</h2>
          {rows.length === 0 && (
            <p className="muted">None loaded. Create one, or refresh after connecting.</p>
          )}
          {rows.map((row) => {
            const total = BigInt(row.amountUsdc.toString()) * BigInt(row.milestoneCount);
            const mineFreelancer = publicKey?.equals(row.freelancer);
            const mineClient = publicKey?.equals(row.client) || (row.status === "draft" && connected);
            return (
              <article className="invoice" key={row.publicKey.toBase58()}>
                <h2>
                  #{row.index.toString()} · <span className="status">{row.status}</span>
                </h2>
                <p className="meta">
                  <Amount raw={row.amountUsdc.toNumber()} /> × {row.milestoneCount} ={" "}
                  <Amount raw={Number(total)} /> · accepted {row.milestonesAccepted}/
                  {row.milestoneCount}
                </p>
                <p className="meta muted">
                  freelancer{" "}
                  <button className="ghost" type="button" onClick={() => copy(row.freelancer.toBase58())}>
                    {truncateAddress(row.freelancer.toBase58())}
                  </button>
                  {" · "}client{" "}
                  <button className="ghost" type="button" onClick={() => copy(row.client.toBase58())}>
                    {row.client.equals(PublicKey.default)
                      ? "unset until fund"
                      : truncateAddress(row.client.toBase58())}
                  </button>
                </p>
                <div className="row">
                  <button
                    type="button"
                    disabled={!mineClient || row.status !== "draft" || busy !== null}
                    onClick={() => void fund(row)}
                  >
                    Fund
                  </button>
                  <button
                    type="button"
                    disabled={
                      !publicKey ||
                      row.status !== "funded" ||
                      busy !== null ||
                      row.milestonesAccepted >= row.milestoneCount
                    }
                    onClick={() => void accept(row)}
                  >
                    Accept milestone
                  </button>
                  <button
                    type="button"
                    disabled={
                      !publicKey ||
                      row.status !== "funded" ||
                      row.milestonesAccepted !== row.milestoneCount ||
                      busy !== null
                    }
                    onClick={() => void settle(row)}
                  >
                    Settle
                  </button>
                </div>
                {mineFreelancer && <p className="muted">You are the freelancer on this invoice.</p>}
              </article>
            );
          })}
        </section>
      </main>
    </>
  );
}

export default function App() {
  return (
    <Providers>
      <Desk />
    </Providers>
  );
}
