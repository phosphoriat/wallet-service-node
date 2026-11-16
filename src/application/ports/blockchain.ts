import type {Gate} from "../../domain/models.js";
import type {RpcBlock, RpcReceipt, RpcLog} from "../../domain/chain-data.js";

export type {RpcTransaction, RpcBlock, RpcReceipt, RpcLog} from "../../domain/chain-data.js";

/** RPC failure carrying an optional remote error code for broadcast classification. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number | null = null
  ) {
    super(message);
  }

  /** Reports whether the node recognizes a previously submitted transaction. */
  get alreadyKnown(): boolean {
    return /already known|known transaction/i.test(this.message);
  }
}

/** Blockchain access required by application scenarios, independent of HTTP transport. */
export interface Blockchain {
  /** Invokes a chain RPC method and returns its decoded result. */
  call<T>(method: string, params?: unknown[]): Promise<T>;

  /** Returns the node's current block height as a safe integer. */
  blockNumber(): Promise<number>;

  /** Loads a block by height or tag; missing blocks are represented by null. */
  block(number: number | string, full?: boolean): Promise<RpcBlock | null>;

  /** Loads full blocks in the same order as the requested heights. */
  blocks(numbers: number[]): Promise<(RpcBlock | null)[]>;

  /** Loads receipts in transaction-hash order, retaining null for missing receipts. */
  receipts(hashes: string[]): Promise<(RpcReceipt | null)[]>;

  /** Loads logs matching the supplied block, contract and topic filter. */
  logs(filter: object): Promise<RpcLog[]>;
}

/** Resolves a base gate's blockchain adapter without exposing connection settings. */
export interface BlockchainFactory {
  /** Creates a client using infrastructure settings for the supplied gate. */
  create(base: Gate): Promise<Blockchain>;
}
