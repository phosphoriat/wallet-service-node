export const MAX_UINT256 = (1n << 256n) - 1n;

/** Rejects decimal precision outside the supported token range. */
function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid decimals");
}

/**
 * Converts a positive decimal amount to exact uint256 base units without floating point.
 *
 * @throws When the amount is nonpositive, exceeds uint256 or has excess precision.
 */
export function toBaseUnits(amount: string, decimals: number): string {
  checkDecimals(decimals);

  if (typeof amount !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(amount))
    throw new Error("Amount must be a positive decimal string");

  const [whole, fraction = ""] = amount.split(".");

  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);

  const base = BigInt(whole + fraction.padEnd(decimals, "0"));

  if (base <= 0n) throw new Error("Amount must be greater than zero");

  if (base > MAX_UINT256) throw new Error("Amount is too large");

  return base.toString();
}

/** Formats unsigned base units as a normalized decimal amount. */
export function fromBaseUnits(value: string, decimals: number): string {
  checkDecimals(decimals);

  if (!/^\d+$/.test(value)) throw new Error("Invalid base units");

  const normalized = BigInt(value).toString();

  if (decimals === 0) return normalized;

  const padded = normalized.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");

  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

/** Encodes a nonnegative integer as an Ethereum hexadecimal quantity. */
export function hex(value: string | number | bigint): string {
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid decimal value");

  return "0x" + BigInt(value).toString(16);
}

/** Decodes a hexadecimal quantity to an exact decimal integer string. */
export function decimal(value: string): string {
  const digits = value.replace(/^0x/i, "");

  if (digits === "") return "0";

  if (!/^[a-f\d]+$/i.test(digits)) throw new Error("Invalid hex value");

  return BigInt("0x" + digits).toString();
}

/** Rejects negative or unsafe integers before converting them to a JavaScript number. */
export function safeInt(value: string | number | bigint): number {
  const result = Number(value);

  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Integer outside safe range");

  return result;
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Validates and pads an Ethereum address to a 32-byte event topic. */
export function addressToTopic(address: string): string {
  if (!/^0x[a-f\d]{40}$/i.test(address)) throw new Error("Invalid Ethereum address");

  return "0x" + address.slice(2).toLowerCase().padStart(64, "0");
}

/** Decodes a canonical padded address topic to a lowercase address. */
export function topicToAddress(topic: string): string {
  if (!/^0x0{24}[a-f\d]{40}$/i.test(topic)) throw new Error("Invalid address topic");

  return "0x" + topic.slice(-40).toLowerCase();
}

/** Encodes ERC20 transfer arguments using an exact uint256 amount. */
export function transferCalldata(address: string, amount: string): string {
  if (!/^\d+$/.test(amount) || BigInt(amount) > MAX_UINT256) throw new Error("Invalid uint256");

  return "0xa9059cbb" + addressToTopic(address).slice(2) + BigInt(amount).toString(16).padStart(64, "0");
}

/** Exact, immutable amount; decimal text is never converted through a JS number. */
export class Amount {
  readonly baseUnits: string;

  constructor(
    readonly value: string,
    readonly decimals: number
  ) {
    this.baseUnits = toBaseUnits(value, decimals);
    Object.freeze(this);
  }
}
