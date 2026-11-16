import {ChainIndexAggregate, ChainReorganization, ReorgDetected, NodeBehind} from "../domain/chain-index.js";
import {GateAggregate} from "../domain/gate.js";
import type {Gate, IndexerState} from "../domain/models.js";
import {DepositAggregate} from "../domain/deposit.js";
import type {BlockchainFactory, Blockchain} from "./ports/blockchain.js";
import type {Gates, Addresses, Withdrawals, IndexStore} from "./ports/repositories.js";
import type {ApplicationOptions, Lock, Clock, Log} from "./ports/runtime.js";
import {addressToTopic, hex, safeInt, TRANSFER_TOPIC} from "../domain/amount.js";

/** Coordinates canonical-chain scanning, deposit confirmation and withdrawal tracking. */
export class IndexerService {
  constructor(
    private readonly store: IndexStore,
    private readonly gates: Gates,
    private readonly addresses: Addresses,
    private readonly withdrawals: Withdrawals,
    private readonly locks: Lock,
    private readonly config: ApplicationOptions,
    private readonly factory: BlockchainFactory,
    private readonly clock: Clock,
    private readonly logger: Log
  ) {}

  /** Processes a bounded range while holding the network's indexing lock. */
  async run(base: Gate, maxBlocks = this.config.indexer.maxBlocks) {
    new GateAggregate(base).assertIndexable(maxBlocks);

    return this.locks.lock(`blockchain-index:${base.id}`, 0, async (assertOwned) => {
      const rpc = await this.factory.create(base);
      const gates = GateAggregate.assets(base, await this.gates.children(base.id));
      const addresses = new Map((await this.addresses.forGate(base.id)).map((a) => [a.address.toLowerCase(), a.id]));
      let state = await this.initialize(base, rpc);
      const latest = await rpc.blockNumber();
      const startedAt = state.last_block_number;
      let reorgs = 0,
        blocks = 0,
        deposits = 0;
      const tip = await rpc.block(state.last_block_number);

      if (!new ChainIndexAggregate(state).assertTip(tip, latest)) {
        state = await this.rollback(base, gates, state, rpc, assertOwned);
        reorgs++;
      }

      const target = Math.min(latest, state.last_block_number + maxBlocks);

      while (state.last_block_number < target) {
        try {
          const result = await this.range(
            base,
            gates,
            addresses,
            state,
            Math.min(target, state.last_block_number + this.config.indexer.batchSize),
            rpc,
            assertOwned
          );

          state = result.state;
          blocks += result.blocks;
          deposits += result.deposits;
        } catch (error) {
          if (error instanceof NodeBehind) break;

          if (!(error instanceof ReorgDetected)) throw error;

          if (++reorgs > 5) throw new Error("Too many reorgs in one run");

          state = await this.rollback(base, gates, state, rpc, assertOwned);
        }
      }

      await assertOwned();

      let confirmed = 0;

      await this.store.changePendingDeposits(
        gates.map((g) => g.id),
        (aggregate) => {
          const before = aggregate.state.status;

          aggregate.confirm(
            state.last_block_number,
            gates.find((g) => g.id === aggregate.state.asset_gate_id)!.confirmations_required,
            this.clock.now()
          );

          if (before !== aggregate.state.status) confirmed++;
        }
      );

      const withdrawals_updated = await this.track(base, gates, state.last_block_number, rpc);

      await this.store.prune(base.id, state.last_block_number - this.config.indexer.keepBlocks);

      return {
        from: startedAt + 1,
        to: state.last_block_number,
        latest,
        blocks,
        deposits,
        reorgs,
        confirmed,
        withdrawals_updated
      };
    });
  }

  /** Loads the stored cursor or persists an explicit canonical anchor. */
  private async initialize(base: Gate, rpc: Blockchain): Promise<IndexerState> {
    const existing = await this.store.state(base.id);

    if (existing)
      return {
        ...existing,
        last_block_number: safeInt(existing.last_block_number)
      };

    const start = this.config.indexer.start ?? Math.max(0, (await rpc.blockNumber()) - base.confirmations_required);
    const number = Math.max(0, start - 1);
    const anchor = await rpc.block(number);
    const block = ChainIndexAggregate.anchor(base.id, number, anchor);
    const state = {
      gate_id: base.id,
      last_block_number: number,
      last_block_hash: block.hash
    };

    await this.store.initialize(state, block);

    return state;
  }

  /** Fetches and validates a block range, then atomically persists its observations. */
  private async range(
    base: Gate,
    gates: Gate[],
    addresses: Map<string, number>,
    state: IndexerState,
    end: number,
    rpc: Blockchain,
    assertOwned: () => Promise<void>
  ) {
    const from = state.last_block_number + 1;
    const numbers = Array.from({length: end - from + 1}, (_, i) => from + i);
    const raw = await rpc.blocks(numbers);
    const blocks = new ChainIndexAggregate(state).scan(raw, numbers);
    const tip = [...blocks.keys()].at(-1)!;
    const rows: DepositAggregate[] = [];
    const native = gates.find((g) => g.asset_type === "NATIVE");

    if (addresses.size && native) {
      const candidates = [...blocks.entries()].flatMap(([number, block]) =>
        block.transactions
          .filter((tx) => DepositAggregate.nativeCandidate(tx, addresses))
          .map((tx) => ({tx, number, hash: block.hash.toLowerCase()}))
      );
      const receipts = await rpc.receipts(candidates.map((c) => c.tx.hash));

      for (const [i, c] of candidates.entries()) {
        const deposit = DepositAggregate.fromNative(
          native,
          addresses,
          c.tx,
          receipts[i],
          c.number,
          c.hash,
          tip,
          this.clock.now()
        );

        if (deposit) rows.push(deposit);
      }
    }

    const allAddresses = [...addresses.keys()];

    for (const gate of gates.filter((g) => g.asset_type === "ERC20" && g.token_contract)) {
      const token = gate.token_contract!.toLowerCase();

      for (let offset = 0; offset < allAddresses.length; offset += this.config.indexer.addressChunk) {
        const logs = await rpc.logs({
          fromBlock: hex(from),
          toBlock: hex(tip),
          address: token,
          topics: [
            TRANSFER_TOPIC,
            null,
            allAddresses.slice(offset, offset + this.config.indexer.addressChunk).map(addressToTopic)
          ]
        });

        for (const log of logs) {
          const deposit = DepositAggregate.fromLog(gate, addresses, log, blocks, tip, this.clock.now());

          if (deposit) rows.push(deposit);
        }
      }
    }

    await assertOwned();

    const nextState = {
      ...state,
      last_block_number: tip,
      last_block_hash: blocks.get(tip)!.hash.toLowerCase()
    };

    await this.store.commitRange(
      nextState,
      [...blocks].map(([number, block]) => ({
        gate_id: base.id,
        number,
        hash: block.hash.toLowerCase(),
        parent_hash: block.parentHash.toLowerCase()
      })),
      rows
    );

    return {state: nextState, blocks: blocks.size, deposits: rows.length};
  }

  /** Finds a retained canonical ancestor and applies a validated reorganization. */
  private async rollback(
    base: Gate,
    gates: Gate[],
    state: IndexerState,
    rpc: Blockchain,
    assertOwned: () => Promise<void>
  ): Promise<IndexerState> {
    const lowest = Math.max(0, state.last_block_number - this.config.indexer.maxReorgDepth);
    const stored = new Map(
      (await this.store.blocks(base.id, lowest, state.last_block_number)).map((row) => [
        safeInt(row.number),
        String(row.hash)
      ])
    );
    let ancestor: number | null = null;

    for (let number = state.last_block_number; number >= lowest; number--) {
      if (!stored.has(number)) break;

      const header = await rpc.block(number);

      if (!header) throw new NodeBehind("Canonical block unavailable during reorg check");

      if (header.hash.toLowerCase() === stored.get(number)) {
        ancestor = number;
        break;
      }
    }

    if (ancestor === null) throw new Error("Reorg deeper than stored window: manual intervention required");

    if (ancestor === state.last_block_number) return state;

    await assertOwned();

    const nextState = {
      ...state,
      last_block_number: ancestor,
      last_block_hash: stored.get(ancestor)!
    };
    const lost = await this.store.rollback(
      ChainReorganization.plan(state, nextState, stored.get(ancestor)!, this.config.indexer.maxReorgDepth)
    );

    for (const deposit of lost)
      this.logger.error(`CONFIRMED deposit orphaned by reorg: ${deposit.id} ${deposit.tx_hash}`);

    this.logger.warn(`Reorg ${base.name}: ${state.last_block_number} -> ${ancestor}`);

    return nextState;
  }

  /** Applies canonical receipts to the latest persisted withdrawal states. */
  private async track(base: Gate, gates: Gate[], tip: number, rpc: Blockchain): Promise<number> {
    const items = await this.withdrawals.pending(
      gates.map((g) => g.id),
      this.config.indexer.withdrawalsPerRun
    );
    const receipts = await rpc.receipts(items.map((w) => w.tx_hash!));
    let updated = 0;

    for (const [i, w] of items.entries()) {
      const receipt = receipts[i];

      if (!receipt?.blockNumber) continue;

      const number = safeInt(receipt.blockNumber);

      if (number > tip) continue;

      const stored = await this.store.block(base.id, number);

      // Receipts outside the retained window need an explicit canonical lookup.
      const hash = stored?.hash ?? (await rpc.block(number))?.hash ?? null;
      const result = await this.withdrawals.change(w.id, (aggregate) =>
        aggregate.applyReceipt(
          {
            number,
            hash: receipt.blockHash,
            canonicalHash: hash,
            status: receipt.status
          },
          tip,
          gates.find((g) => g.id === w.asset_gate_id)!.confirmations_required,
          this.clock.now()
        )
      );

      if (w.status !== result.status) updated++;
    }

    return updated;
  }
}
