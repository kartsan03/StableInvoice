import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
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
type Screen = "landing" | "app";
type FilterMode = "mine" | "all";

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

type SettlementReceipt =
  | {
      status: "ready";
      invoice: string;
      settlement: string;
      amount: bigint;
      milestoneCount: number;
      timestamp: number;
      tx: string;
    }
  | {
      status: "pending";
      invoice: string;
      settlement: string;
      tx: string;
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

function nextIndex(existing: InvoiceRow[], freelancer: PublicKey): number {
  const mine = existing.filter((r) => r.freelancer.equals(freelancer));
  if (mine.length === 0) return 1;
  return Math.max(...mine.map((r) => r.index.toNumber())) + 1;
}

function readInvoiceParam(): string | null {
  try {
    const v = new URLSearchParams(window.location.search).get("invoice");
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
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

function Header({
  screen,
  onHome,
  onApp,
}: {
  screen: Screen;
  onHome: () => void;
  onApp: () => void;
}) {
  return (
    <header className="mast">
      <button type="button" className="brand" onClick={onHome} aria-label="StableInvoice home">
        <span className="name">StableInvoice</span>
        <span className="badge">Devnet</span>
      </button>
      <div className="actions">
        {screen === "landing" && (
          <button className="ghost" type="button" onClick={onApp}>
            Open app
          </button>
        )}
        <WalletMultiButton />
      </div>
    </header>
  );
}

function Landing({ onApp }: { onApp: () => void }) {
  return (
    <main className="wrap">
      <section className="hero">
        <h1>The client locks the money. Settle pays once every milestone is accepted.</h1>
        <p className="lede">
          StableInvoice holds USDC in a Solana program. Accepting a milestone moves no
          tokens — settle drains the vault in one lump sum and writes a permanent
          on-chain record. This demo runs on Devnet.
        </p>
        <div className="row">
          <button type="button" onClick={onApp}>
            Open the invoice app
          </button>
        </div>
      </section>

      <section className="flow" aria-label="How payment moves">
        <article>
          <h2>1 · Lock</h2>
          <p>Client deposits the full invoice into a vault the program owns. Work starts with the money already there.</p>
        </article>
        <div className="arrow" aria-hidden>
          →
        </div>
        <article>
          <h2>2 · Accept</h2>
          <p>Each finished milestone gets a client signature. No tokens move yet; the counter just ticks up.</p>
        </article>
        <div className="arrow" aria-hidden>
          →
        </div>
        <article>
          <h2>3 · Settle</h2>
          <p>When every milestone is accepted, the vault drains to the freelancer. The settlement account stays on-chain.</p>
        </article>
      </section>

      <p className="note">
        Two wallets in the app: freelancer opens the invoice, client funds and accepts.
        Same wallet works for a solo dry run.
      </p>
    </main>
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
  const [balance, setBalance] = useState<bigint | null>(null);
  const [filter, setFilter] = useState<FilterMode>("mine");
  const [focusInvoice] = useState<string | null>(() => readInvoiceParam());
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null);
  const focusRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!focusInvoice || !focusRef.current) return;
    focusRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusInvoice, rows]);

  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    if (!publicKey) return [];
    return rows.filter(
      (r) =>
        r.freelancer.equals(publicKey) ||
        (!r.client.equals(PublicKey.default) && r.client.equals(publicKey)),
    );
  }, [filter, publicKey, rows]);

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
      if (!Number.isInteger(count) || count < 1 || count > 32) {
        throw new Error("milestone count must be 1–32");
      }
      const idx = nextIndex(rows, publicKey);
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
      if (!publicKey.equals(row.client)) {
        throw new Error("Switch wallet to the invoice client to accept");
      }
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
      const isParty =
        publicKey.equals(row.freelancer) || publicKey.equals(row.client);
      if (!isParty) {
        throw new Error("Switch wallet to the invoice client or freelancer to settle");
      }
      const vault = vaultAta(row.publicKey, MINT);
      const freelancerUsdc = getAssociatedTokenAddressSync(MINT, row.freelancer);
      const settlement = settlementPda(row.publicKey);
      const sig = await program.methods
        .settle()
        .accounts({
          authority: publicKey,
          invoice: row.publicKey,
          freelancer: row.freelancer,
          settlement,
          usdcMint: MINT,
          vault,
          freelancerUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await refresh();
      const ns = program.account as unknown as {
        settlement: {
          fetch: (k: PublicKey) => Promise<{
            amount: BN;
            milestoneCount: number;
            timestamp: BN;
          }>;
        };
      };
      const invoiceKey = row.publicKey.toBase58();
      const settlementKey = settlement.toBase58();
      const loadReceipt = async () => {
        const s = await ns.settlement.fetch(settlement);
        setReceipt({
          status: "ready",
          invoice: invoiceKey,
          settlement: settlementKey,
          amount: BigInt(s.amount.toString()),
          milestoneCount: s.milestoneCount,
          timestamp: Number(s.timestamp.toString()),
          tx: sig,
        });
      };
      try {
        await loadReceipt();
      } catch {
        setReceipt({
          status: "pending",
          invoice: invoiceKey,
          settlement: settlementKey,
          tx: sig,
        });
      }
      return sig;
    });

  return (
    <main className="wrap">
      <p className="lede">
        Freelancer creates. Client gets demo tokens, funds the vault, then accepts
        each milestone (no tokens move). Either party can settle when the counter is full —
        that is the lump-sum payout.
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void createInvoice();
        }}
      >
        <h2>Create invoice</h2>
        <p className="muted">Signed by the connected wallet as freelancer. Index is assigned automatically.</p>
        <label htmlFor="amount">Amount per milestone (demo USDC)</label>
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <label htmlFor="count">Milestone count</label>
        <input
          id="count"
          inputMode="numeric"
          autoComplete="off"
          value={milestones}
          onChange={(e) => setMilestones(e.target.value)}
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

      {receipt && (
        <section className="receipt" aria-label="Settlement receipt">
          <h2>Settlement receipt</h2>
          {receipt.status === "ready" ? (
            <p className="meta">
              <Amount raw={receipt.amount} /> · {receipt.milestoneCount} milestones ·{" "}
              {new Date(receipt.timestamp * 1000).toISOString()}
            </p>
          ) : (
            <p className="muted">
              Settlement tx landed; on-chain receipt not loaded yet.{" "}
              <button
                className="ghost"
                type="button"
                disabled={busy !== null || !program}
                onClick={() => {
                  if (!program) return;
                  void run("receipt", async () => {
                    const ns = program.account as unknown as {
                      settlement: {
                        fetch: (k: PublicKey) => Promise<{
                          amount: BN;
                          milestoneCount: number;
                          timestamp: BN;
                        }>;
                      };
                    };
                    const s = await ns.settlement.fetch(new PublicKey(receipt.settlement));
                    setReceipt({
                      status: "ready",
                      invoice: receipt.invoice,
                      settlement: receipt.settlement,
                      amount: BigInt(s.amount.toString()),
                      milestoneCount: s.milestoneCount,
                      timestamp: Number(s.timestamp.toString()),
                      tx: receipt.tx,
                    });
                  });
                }}
              >
                Retry load
              </button>
            </p>
          )}
          <p className="meta muted">
            <a href={explorerAddr(receipt.invoice)} target="_blank" rel="noreferrer">
              Invoice
            </a>
            {" · "}
            <a href={explorerAddr(receipt.settlement)} target="_blank" rel="noreferrer">
              Settlement
            </a>
            {" · "}
            <a href={explorerTx(receipt.tx)} target="_blank" rel="noreferrer">
              Tx
            </a>
          </p>
          <button className="ghost" type="button" onClick={() => setReceipt(null)}>
            Dismiss
          </button>
        </section>
      )}

      <section>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2>Invoices</h2>
          <div className="row">
            <button
              className={filter === "mine" ? undefined : "ghost"}
              type="button"
              onClick={() => setFilter("mine")}
              disabled={!connected}
            >
              My invoices
            </button>
            <button
              className={filter === "all" ? undefined : "ghost"}
              type="button"
              onClick={() => setFilter("all")}
            >
              Show all (devnet)
            </button>
          </div>
        </div>
        {!connected && filter === "mine" && (
          <p className="muted">Connect a wallet to see invoices where you are freelancer or client. Or show all.</p>
        )}
        {connected && filter === "mine" && visibleRows.length === 0 && rows.length > 0 && (
          <p className="muted">No invoices for this wallet. Switch wallet or show all.</p>
        )}
        {visibleRows.length === 0 && rows.length === 0 && (
          <p className="muted">None loaded. Create one, or refresh after connecting.</p>
        )}
        {visibleRows.map((row) => {
          const key = row.publicKey.toBase58();
          const total = BigInt(row.amountUsdc.toString()) * BigInt(row.milestoneCount);
          const isClient = !!publicKey && !row.client.equals(PublicKey.default) && publicKey.equals(row.client);
          const isFreelancer = !!publicKey && publicKey.equals(row.freelancer);
          const canFund = !!publicKey && row.status === "draft" && connected;
          const canAccept = isClient && row.status === "funded" && row.milestonesAccepted < row.milestoneCount;
          const canSettle =
            (isClient || isFreelancer) &&
            row.status === "funded" &&
            row.milestonesAccepted === row.milestoneCount;
          const vault = vaultAta(row.publicKey, MINT);
          const settlement = settlementPda(row.publicKey);
          const focused = focusInvoice === key;
          return (
            <article
              className={focused ? "invoice focus" : "invoice"}
              key={key}
              ref={focused ? focusRef : undefined}
            >
              <h2>
                Invoice · <span className="status">{row.status}</span>
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
              <p className="meta muted">
                <a href={explorerAddr(key)} target="_blank" rel="noreferrer">
                  Invoice PDA
                </a>
                {" · "}
                <a href={explorerAddr(vault.toBase58())} target="_blank" rel="noreferrer">
                  Vault ATA
                </a>
                {row.status === "settled" && (
                  <>
                    {" · "}
                    <a href={explorerAddr(settlement.toBase58())} target="_blank" rel="noreferrer">
                      Settlement
                    </a>
                  </>
                )}
              </p>
              <div className="row">
                <button
                  type="button"
                  disabled={!canFund || busy !== null}
                  onClick={() => void fund(row)}
                >
                  Fund
                </button>
                <button
                  type="button"
                  disabled={!canAccept || busy !== null}
                  onClick={() => void accept(row)}
                  title={
                    row.status === "funded" && publicKey && !isClient
                      ? "Switch wallet to the invoice client to accept"
                      : undefined
                  }
                >
                  Accept milestone
                </button>
                <button
                  type="button"
                  disabled={!canSettle || busy !== null}
                  onClick={() => void settle(row)}
                  title={
                    row.status === "funded" &&
                    row.milestonesAccepted === row.milestoneCount &&
                    publicKey &&
                    !isClient &&
                    !isFreelancer
                      ? "Switch wallet to the invoice client or freelancer to settle"
                      : undefined
                  }
                >
                  Settle
                </button>
              </div>
              {row.status === "funded" && publicKey && !isClient && row.milestonesAccepted < row.milestoneCount && (
                <p className="muted">Accept requires the invoice client wallet — switch wallet to accept.</p>
              )}
              {isFreelancer && <p className="muted">You are the freelancer on this invoice.</p>}
              {isClient && <p className="muted">You are the client on this invoice.</p>}
            </article>
          );
        })}
      </section>
    </main>
  );
}

function Shell() {
  const initialInvoice = useMemo(() => readInvoiceParam(), []);
  const [screen, setScreen] = useState<Screen>(initialInvoice ? "app" : "landing");
  return (
    <>
      <Header
        screen={screen}
        onHome={() => setScreen("landing")}
        onApp={() => setScreen("app")}
      />
      {screen === "landing" ? <Landing onApp={() => setScreen("app")} /> : <Desk />}
      <footer className="quiet wrap">
        Devnet demo.{" "}
        <a href={explorerAddr(PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
          Program
        </a>
        {" · "}
        <a href={explorerAddr(MINT.toBase58())} target="_blank" rel="noreferrer">
          Demo mint
        </a>
      </footer>
    </>
  );
}

export default function App() {
  return (
    <Providers>
      <Shell />
    </Providers>
  );
}
