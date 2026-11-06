import { normalizeWidth, scanAmount } from "@/lib/parseAdd";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "@/lib/zod";

export type McpAmount =
  { ok: true; amount: number; currency: SupportedCurrency | null } | { ok: false; message: string };

const isSupported = (c: string): c is SupportedCurrency =>
  (SUPPORTED_CURRENCIES as readonly string[]).includes(c);

/**
 * An agent's `amount`: a number, or text in the forgiving grammar of the bot's `/add`
 * (`1,200`, `$300`, `3k`, `150+200`). A currency written into the text is returned so the
 * caller can compare it with the `currency` argument. Anything left over is refused.
 */
export function parseMcpAmount(raw: number | string): McpAmount {
  if (typeof raw === "number") {
    const rounded = Math.round(raw * 100) / 100;
    return Number.isFinite(rounded) && rounded > 0
      ? { ok: true, amount: rounded, currency: null }
      : { ok: false, message: "amount must be a positive number" };
  }
  const norm = normalizeWidth(raw).trim();
  const scan = norm ? scanAmount(norm, 0) : null;
  if (!scan || norm.slice(scan.end).trim() !== "") {
    return { ok: false, message: `can't read "${raw.slice(0, 40)}" as an amount` };
  }
  if (!(scan.value > 0)) return { ok: false, message: "amount must be positive" };
  if (scan.currency !== null && !isSupported(scan.currency)) {
    return { ok: false, message: `unsupported currency ${scan.currency}` };
  }
  return { ok: true, amount: scan.value, currency: scan.currency };
}
