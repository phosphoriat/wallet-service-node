/** Domain network or asset definition, excluding transport connection settings. */
export interface Gate {
  id: number;
  name: string;
  chain_id: number;
  confirmations_required: number;
  parent_gate_id: number | null;
  asset_type: "NATIVE" | "ERC20";
  token_contract: string | null;
  token_decimals: number | null;
}

/** Persisted derivation identity and its resulting wallet address. */
export interface Address {
  id: number;
  gate_id: number;
  account: number;
  change: number;
  address_index: number;
  address: string;
}

export type WithdrawalStatus = "CREATED" | "SIGNED" | "BROADCASTED" | "CONFIRMED" | "FAILED";

/** Detached withdrawal snapshot exposed for reads and aggregate rehydration. */
export interface Withdrawal {
  id: number;
  idempotency_key: string;
  asset_gate_id: number;
  from_address: string;
  to_address: string;
  amount: string;
  amount_base_units: string;
  status: WithdrawalStatus;
  tx_to: string;
  tx_value_wei: string;
  tx_data: string;
  nonce: number | null;
  gas_limit: number | null;
  max_fee_per_gas_wei: string | null;
  max_priority_fee_per_gas_wei: string | null;
  signed_tx: string | null;
  tx_hash: string | null;
  block_number: number | null;
  error: string | null;
  broadcasted_at: Date | string | null;
  confirmed_at: Date | string | null;
}

/** Last committed canonical block for a base gate. */
export interface IndexerState {
  gate_id: number;
  last_block_number: number;
  last_block_hash: string;
}

/** Returns native-asset precision or the configured token precision. */
export function decimals(gate: Gate): number {
  if (gate.asset_type === "NATIVE") return 18;

  if (gate.token_decimals === null) throw new Error(`Gate ${gate.name}: token_decimals is not set`);

  return gate.token_decimals;
}
