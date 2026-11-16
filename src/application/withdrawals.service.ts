import {nextNonce, transactionFees} from "../domain/transaction-policy.js";
import type {Gate, Withdrawal} from "../domain/models.js";
import {WithdrawalAggregate} from "../domain/withdrawal.js";
import {NotFoundError} from "../domain/errors.js";
import {AddressesService} from "./addresses.service.js";
import {RpcError, type Blockchain, type BlockchainFactory} from "./ports/blockchain.js";
import type {Wallet} from "./ports/wallet.js";
import type {Gates, Withdrawals} from "./ports/repositories.js";
import type {ApplicationOptions, Lock, Clock} from "./ports/runtime.js";
import {decimal, hex, safeInt} from "../domain/amount.js";

/** Coordinates idempotent withdrawal creation, signing and safe broadcast retries. */
export class WithdrawalsService {
  constructor(
    private readonly withdrawals: Withdrawals,
    private readonly gates: Gates,
    private readonly locks: Lock,
    private readonly addresses: AddressesService,
    private readonly wallet: Wallet,
    private readonly rpcFactory: BlockchainFactory,
    private readonly config: ApplicationOptions,
    private readonly clock: Clock
  ) {}

  /** Returns a withdrawal or raises a domain not-found error. */
  async find(id: number): Promise<Withdrawal> {
    const row = await this.withdrawals.find(id);

    if (!row) throw new NotFoundError("Withdrawal not found");

    return row;
  }

  /** Reserves an idempotent request and nonce, persists the signature, then broadcasts. */
  async create(
    gate: Gate,
    to: string,
    amount: string,
    key: string
  ): Promise<{withdrawal: Withdrawal; created: boolean}> {
    const units = WithdrawalAggregate.amount(gate, amount).baseUnits;
    const existing = await this.withdrawals.byKey(key);

    if (existing) {
      WithdrawalAggregate.rehydrate(existing).assertSameRequest(gate, to, units);

      return {withdrawal: existing, created: false};
    }

    const base = await this.gates.base(gate);
    const wallet = await this.wallet.forGate(base);
    const reservation = await this.locks.lock(`idempotency:${key}`, 30, async () => {
      const previous = await this.withdrawals.byKey(key);

      if (previous) {
        WithdrawalAggregate.rehydrate(previous).assertSameRequest(gate, to, units);

        return {withdrawal: previous, created: false};
      }

      WithdrawalAggregate.assertRecipient(await wallet.validateAddress(to));
      to = to.toLowerCase();

      const hot = await this.addresses.hot(base);
      const withdrawal = await this.withdrawals.create(WithdrawalAggregate.create(gate, hot.address, to, amount, key));

      return {withdrawal, created: true};
    });

    if (!reservation.created) return reservation;

    const w = reservation.withdrawal;

    try {
      await this.locks.lock(`nonce:${base.id}:${w.from_address}`, 30, async (assertOwned) => {
        const rpc = await this.rpcFactory.create(base);
        const hot = await this.addresses.hot(base);
        const nodeNonce = safeInt(await rpc.call<string>("eth_getTransactionCount", [hot.address, "pending"]));

        // Reserve across native and token assets sharing this signing account.
        const reserved = await this.withdrawals.highestReservedNonce(base.id, hot.address);
        const nonce = nextNonce(nodeNonce, reserved);
        const estimate = await rpc.call<string>("eth_estimateGas", [
          {
            from: hot.address,
            to: w.tx_to,
            value: hex(w.tx_value_wei),
            data: w.tx_data
          }
        ]);
        const latest = await rpc.block("latest");

        if (!latest || latest.baseFeePerGas === undefined) throw new Error("EIP-1559 latest block is unavailable");

        let priority = this.config.fees.minPriority;

        try {
          priority = decimal(await rpc.call<string>("eth_maxPriorityFeePerGas"));
        } catch (error) {
          if (!(error instanceof RpcError)) throw error;
        }

        const fees = transactionFees(estimate, latest.baseFeePerGas, priority, this.config.fees);
        const signed = await wallet.sign(hot.account, hot.change, hot.address_index, {
          to: w.tx_to,
          value_wei: w.tx_value_wei,
          data: w.tx_data,
          nonce,
          chain_id: safeInt(base.chain_id),
          ...fees
        });

        await assertOwned();

        // Persist a legal transition on the latest state before any broadcast.
        await this.withdrawals.change(w.id, (aggregate) =>
          aggregate.sign(signed.from, {
            nonce,
            ...fees,
            signed_tx: signed.signed_tx,
            tx_hash: signed.tx_hash
          })
        );
        await assertOwned();
        await this.broadcast(await this.find(w.id), rpc);
      });
    } catch (error) {
      // Never label a persisted signature as safely failed after an ambiguous error.
      await this.withdrawals.change(w.id, (aggregate) => aggregate.failBeforeSigning((error as Error).message));
      throw error;
    }

    return {withdrawal: await this.find(w.id), created: true};
  }

  /** Resends persisted signed bytes under the account's nonce lock. */
  async rebroadcast(id: number): Promise<Withdrawal> {
    const w = await this.find(id);
    const gate = await this.gates.byId(w.asset_gate_id);

    if (!gate) throw new Error("Asset gate not found");

    const base = await this.gates.base(gate);

    return this.locks.lock(`nonce:${base.id}:${w.from_address}`, 30, async (assertOwned) => {
      const fresh = await this.find(id);

      WithdrawalAggregate.rehydrate(fresh).assertRebroadcastable();
      await assertOwned();
      await this.broadcast(fresh, await this.rpcFactory.create(base));

      return this.find(id);
    });
  }

  /** Submits signed bytes and applies the outcome to locked current aggregate state. */
  private async broadcast(w: Withdrawal, rpc: Blockchain): Promise<void> {
    let result: import("../domain/withdrawal.js").BroadcastResult;

    try {
      result = {
        hash: await rpc.call<string>("eth_sendRawTransaction", [w.signed_tx])
      };
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;

      result = {message: error.message, code: error.rpcCode};
    }

    await this.withdrawals.change(w.id, (aggregate) => aggregate.recordBroadcast(result, this.clock.now()));
  }
}
