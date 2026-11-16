import type {Gate} from "../../domain/models.js";

/** Exact transaction fields passed to the external signer. */
export interface SignParams {
  to: string;
  value_wei: string;
  data: string;
  nonce: number;
  chain_id: number;
  gas_limit: number;
  max_fee_per_gas_wei: string;
  max_priority_fee_per_gas_wei: string;
}

/** Signed transaction bytes, expected hash and optional reported signer. */
export interface SignedTransaction {
  signed_tx: string;
  tx_hash: string;
  from: string | null;
}

/** Resolves a wallet session before entering address-allocation transactions. */
export interface Wallet {
  /** Resolves infrastructure settings and returns a session for a base gate. */
  forGate(gate: Gate): Promise<WalletSession>;
}

/** Wallet operations bound to one gate with settings already resolved. */
export interface WalletSession {
  /** Derives an address for the requested account, change and index. */
  createAddress(account: number, change: number, index: number): Promise<string>;

  /** Asks the wallet service whether the recipient address is valid. */
  validateAddress(address: string): Promise<boolean>;

  /** Signs exact transaction parameters without broadcasting them. */
  sign(account: number, change: number, index: number, params: SignParams): Promise<SignedTransaction>;
}
