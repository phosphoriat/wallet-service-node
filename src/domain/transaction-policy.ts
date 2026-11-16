import {decimal, safeInt} from "./amount.js";

/** Chooses a safe nonce using the node's pending nonce and persisted reservations. */
export function nextNonce(nodeNonce: number, reserved: number | string | null): number {
  return safeInt(Math.max(nodeNonce, reserved == null ? 0 : safeInt(reserved) + 1));
}

/**
 * Calculates gas margin and EIP-1559 fees using exact integer arithmetic.
 *
 * @param priority Suggested priority fee as a decimal integer string.
 */
export function transactionFees(
  estimate: string,
  baseFee: string,
  priority: string,
  policy: {gasPercent: number; multiplier: number; minPriority: string}
) {
  const minimum = BigInt(policy.minPriority);
  const suggested = BigInt(priority);
  const tip = suggested < minimum ? minimum : suggested;

  return {
    gas_limit: safeInt((BigInt(decimal(estimate)) * BigInt(policy.gasPercent)) / 100n),
    max_fee_per_gas_wei: (BigInt(decimal(baseFee)) * BigInt(policy.multiplier) + tip).toString(),
    max_priority_fee_per_gas_wei: tip.toString()
  };
}
