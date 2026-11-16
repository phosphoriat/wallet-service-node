import type {IndexerState} from "./models.js";
import type {RpcBlock, RpcReceipt, RpcLog} from "./chain-data.js";
import {decimal, safeInt} from "./amount.js";
import type {DepositAggregate} from "./deposit.js";
import type {WithdrawalAggregate} from "./withdrawal.js";

/** Retained canonical header associated with a base gate. */
export interface StoredBlock {
  gate_id: number;
  number: number;
  hash: string;
  parent_hash: string;
}

/** Signals that fetched chain data conflicts with the expected canonical chain. */
export class ReorgDetected extends Error {}

/** Signals unavailable chain data that must not advance the stored cursor. */
export class NodeBehind extends Error {}

/** Canonical-chain consistency boundary: cursor movement, range linkage and reorg effects. */
export class ChainIndexAggregate {
  #state: IndexerState;

  constructor(state: IndexerState) {
    this.#state = {
      ...state,
      last_block_number: safeInt(state.last_block_number)
    };
    Object.freeze(this);
  }

  /** Returns an immutable copy of the indexing checkpoint. */
  get state(): Readonly<IndexerState> {
    return Object.freeze({...this.#state});
  }

  /** Validates a requested anchor and converts it to a retained header. */
  static anchor(gateId: number, number: number, anchor: RpcBlock | null): StoredBlock {
    if (!anchor || safeInt(anchor.number) !== number) throw new Error(`Anchor block ${number} unavailable`);

    return {
      gate_id: gateId,
      number,
      hash: anchor.hash.toLowerCase(),
      parent_hash: anchor.parentHash.toLowerCase()
    };
  }

  /** Checks node availability and reports whether its tip matches the stored hash. */
  assertTip(tip: RpcBlock | null, latest: number): boolean {
    if (!tip || latest < this.#state.last_block_number) throw new NodeBehind("Node is behind the stored tip");

    return tip.hash.toLowerCase() === this.#state.last_block_hash;
  }

  /** Validates ordered RPC blocks and keeps a contiguous available prefix. */
  scan(raw: (RpcBlock | null)[], numbers: number[]): Map<number, RpcBlock> {
    const blocks = new Map<number, RpcBlock>();
    let parent = this.#state.last_block_hash;

    for (const [i, block] of raw.entries()) {
      if (!block) {
        if (!blocks.size) throw new NodeBehind(`Block ${numbers[i]} unavailable`);

        break;
      }

      if (safeInt(block.number) !== numbers[i]) throw new Error("RPC returned unexpected block number");

      if (block.parentHash.toLowerCase() !== parent) throw new ReorgDetected("Parent hash mismatch");

      parent = block.hash.toLowerCase();
      blocks.set(numbers[i], block);
    }

    return blocks;
  }

  /** Advances only through consecutive blocks linked to the current checkpoint. */
  advance(blocks: StoredBlock[]): void {
    if (!blocks.length) throw new Error("Empty block range");

    for (const block of blocks) {
      if (block.gate_id !== this.#state.gate_id || block.number !== this.#state.last_block_number + 1)
        throw new Error("Non-contiguous block range");

      if (block.parent_hash.toLowerCase() !== this.#state.last_block_hash)
        throw new ReorgDetected("Parent hash mismatch");

      this.#state = {
        ...this.#state,
        last_block_number: block.number,
        last_block_hash: block.hash.toLowerCase()
      };
    }
  }

  /** Rejects a checkpoint that differs from the validated canonical state. */
  assertCheckpoint(expected: IndexerState): void {
    if (
      expected.gate_id !== this.#state.gate_id ||
      expected.last_block_number !== this.#state.last_block_number ||
      expected.last_block_hash !== this.#state.last_block_hash
    )
      throw new Error("Checkpoint does not match canonical blocks");
  }

  /** Checks that a deposit belongs to the scanned network and block. */
  assertObservation(deposit: DepositAggregate, blocks: StoredBlock[], gateIds: number[]): void {
    const row = deposit.state;

    if (!gateIds.includes(row.asset_gate_id)) throw new Error("Deposit belongs to another chain");

    const block = blocks.find((block) => block.number === row.block_number);

    if (!block || block.hash.toLowerCase() !== row.block_hash)
      throw new ReorgDetected("Deposit does not match scanned block");
  }

  /** Rewinds to a retained ancestor and applies deposit and withdrawal reorg transitions. */
  rewind(
    anchor: StoredBlock | null,
    deposits: DepositAggregate[],
    withdrawals: WithdrawalAggregate[]
  ): {id: number; tx_hash: string}[] {
    if (!anchor || anchor.gate_id !== this.#state.gate_id || anchor.number >= this.#state.last_block_number)
      throw new Error("Invalid canonical ancestor");

    const lost: {id: number; tx_hash: string}[] = [];

    for (const deposit of deposits) {
      const before = deposit.state;

      deposit.orphanAbove(anchor.number);

      if (before.status === "CONFIRMED" && deposit.state.status === "ORPHANED")
        lost.push({id: before.id, tx_hash: before.tx_hash});
    }

    for (const withdrawal of withdrawals) withdrawal.orphanAbove(anchor.number);

    this.#state = {
      ...this.#state,
      last_block_number: anchor.number,
      last_block_hash: anchor.hash.toLowerCase()
    };

    return lost;
  }

  /** Validates canonical receipt inclusion and reports successful execution. */
  static nativeReceipt(receipt: RpcReceipt | null | undefined, number: number, hash: string): boolean {
    if (!receipt || receipt.blockHash.toLowerCase() !== hash || safeInt(receipt.blockNumber) !== number)
      throw new ReorgDetected("Native receipt does not match block");

    if (receipt.status === undefined) throw new Error("Receipt status is missing");

    return decimal(receipt.status) === "1";
  }

  /** Rejects a token log whose block hash is outside the scanned canonical range. */
  static assertLogBlock(log: RpcLog, blocks: Map<number, RpcBlock>): number {
    const number = safeInt(log.blockNumber);

    if (blocks.get(number)?.hash.toLowerCase() !== log.blockHash.toLowerCase())
      throw new ReorgDetected("ERC20 log does not match scanned block");

    return number;
  }
}

const reorganizationToken = Symbol("reorganization");

/** Validated reorg intent, bound to the cursor observed during canonical-chain lookup. */
export class ChainReorganization {
  readonly #source: IndexerState;
  readonly #target: IndexerState;

  private constructor(source: IndexerState, target: IndexerState, token: symbol) {
    if (token !== reorganizationToken) throw new Error("Use reorganization planning");

    this.#source = {...source};
    this.#target = {...target};
    Object.freeze(this);
  }

  /**
   * Creates a reorg intent only for a matching ancestor within the allowed depth.
   *
   * @throws When the target is not a matching ancestor within the allowed depth.
   */
  static plan(
    source: IndexerState,
    target: IndexerState,
    canonicalHash: string,
    maxDepth: number
  ): ChainReorganization {
    safeInt(target.last_block_number);
    safeInt(maxDepth);

    if (
      target.gate_id !== source.gate_id ||
      target.last_block_number >= source.last_block_number ||
      target.last_block_hash !== canonicalHash.toLowerCase()
    )
      throw new Error("Invalid canonical ancestor");

    if (target.last_block_number < Math.max(0, source.last_block_number - maxDepth))
      throw new Error("Reorg deeper than stored window: manual intervention required");

    return new ChainReorganization(source, target, reorganizationToken);
  }

  /** Returns an immutable copy of the planned canonical checkpoint. */
  target(): Readonly<IndexerState> {
    return Object.freeze({...this.#target});
  }

  /** Rejects execution if the cursor has changed since the reorganization was planned. */
  assertCurrent(current: IndexerState): void {
    new ChainIndexAggregate(current).assertCheckpoint(this.#source);
  }
}
