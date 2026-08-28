/** Display-only. Math stays in raw mint units. */

export function formatStable(raw: bigint | number | null | undefined, decimals = 6): {
  text: string;
  raw: string;
  aria: string;
} {
  if (raw === null || raw === undefined) {
    return { text: "--", raw: "", aria: "unavailable" };
  }
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isFinite(n)) return { text: "--", raw: "", aria: "unavailable" };
  const human = n / 10 ** decimals;
  if (Object.is(human, -0) || human === 0) {
    return { text: "0.00", raw: "0", aria: "0.00" };
  }
  const abs = Math.abs(human);
  const text = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  const signed = human < 0 ? `-${text}` : text;
  return { text: signed, raw: String(human), aria: signed };
}

export function toRaw(human: string, decimals = 6): bigint {
  const t = human.trim();
  if (!t) throw new Error("amount required");
  const [whole, frac = ""] = t.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const s = `${whole.replace(/,/g, "")}${fracPadded}`;
  return BigInt(s);
}

export function truncateAddress(addr: string, chars = 4): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}
