import type {RpcTransaction, RpcReceipt, RpcLog, RpcBlock} from "./chain-data.js";
import {ChainIndexAggregate} from "./chain-index.js";
import {decimal, safeInt, topicToAddress, TRANSFER_TOPIC, fromBaseUnits} from "./amount.js";
import {decimals, type Gate} from "./models.js";

/** Persistent deposit snapshot; mutations are owned by DepositAggregate. */
export interface Deposit {
  id: number;
  asset_gate_id: number;
  address_id: number;
  tx_hash: string;
  log_index: number;
  from_address: string;
  to_address: string;
  amount_base_units: string;
  amount: string;
  block_number: number;
  block_hash: string;
  confirmations: number;
  status: "PENDING" | "CONFIRMED" | "ORPHANED";
  confirmed_at: string | Date | null;
}

const fields = [
  "id",
  "asset_gate_id",
  "address_id",
  "tx_hash",
  "log_index",
  "from_address",
  "to_address",
  "amount_base_units",
  "amount",
  "block_number",
  "block_hash",
  "confirmations",
  "status",
  "confirmed_at"
] as const;

/** Copies whitelisted snapshot fields and clones dates to prevent shared mutable state. */
function copy(state: Readonly<Deposit>): Deposit {
  return Object.fromEntries(
    fields.map((key) => [key, state[key] instanceof Date ? new Date(state[key] as Date) : state[key]])
  ) as unknown as Deposit;
}

const construction = Symbol("aggregate construction");

/** Owns deposit observation, confirmation, orphaning and revival without changing identity. */
export class DepositAggregate {
  #state: Deposit;
  readonly #new: boolean;

  private constructor(state: Deposit, isNew: boolean, token: symbol) {
    if (token !== construction) throw new Error("Use aggregate factories");

    this.#state = copy(state);
    this.#new = isNew;
    Object.freeze(this);
  }

  /** Returns an immutable detached deposit snapshot. */
  get state(): Readonly<Deposit> {
    return Object.freeze(copy(this.#state));
  }

  /** Restores an existing deposit without granting permission to insert it as new. */
  static rehydrate(state: Deposit): DepositAggregate {
    if (!Number.isSafeInteger(state.id) || state.id < 1) throw new Error("Persisted deposit identity required");

    return new DepositAggregate(state, false, construction);
  }

  /** Creates a normalized deposit observation with its initial confirmation state. */
  static observe(
    gate: Gate,
    addressId: number,
    tx: string,
    log: number,
    from: string,
    to: string,
    units: string,
    number: number,
    hash: string,
    tip: number,
    now: string
  ): DepositAggregate {
    const confirmations = tip - number + 1;

    if (confirmations < 1) throw new Error("Deposit is beyond the scanned tip");

    const confirmed = confirmations >= gate.confirmations_required;

    return new DepositAggregate(
      {
        id: 0,
        asset_gate_id: gate.id,
        address_id: addressId,
        tx_hash: tx.toLowerCase(),
        log_index: log,
        from_address: from.toLowerCase(),
        to_address: to.toLowerCase(),
        amount_base_units: units,
        amount: fromBaseUnits(units, decimals(gate)),
        block_number: number,
        block_hash: hash.toLowerCase(),
        confirmations,
        status: confirmed ? "CONFIRMED" : "PENDING",
        confirmed_at: confirmed ? now : null
      },
      true,
      construction
    );
  }

  /** Recognizes nonzero native transfers to tracked recipient addresses. */
  static nativeCandidate(tx: RpcTransaction, addresses: Map<string, number>): boolean {
    return Boolean(tx.to && addresses.has(tx.to.toLowerCase()) && decimal(tx.value) !== "0");
  }

  /** Builds a deposit only for a tracked transfer with a successful canonical receipt. */
  static fromNative(
    gate: Gate,
    addresses: Map<string, number>,
    tx: RpcTransaction,
    receipt: RpcReceipt | null | undefined,
    number: number,
    hash: string,
    tip: number,
    now: string
  ): DepositAggregate | null {
    if (!this.nativeCandidate(tx, addresses) || !ChainIndexAggregate.nativeReceipt(receipt, number, hash)) return null;

    return this.observe(
      gate,
      addresses.get(tx.to!.toLowerCase())!,
      tx.hash,
      -1,
      tx.from,
      tx.to!,
      decimal(tx.value),
      number,
      hash,
      tip,
      now
    );
  }

  /** Builds a deposit from a standard canonical ERC20 transfer, ignoring unsupported logs. */
  static fromLog(
    gate: Gate,
    addresses: Map<string, number>,
    log: RpcLog,
    blocks: Map<number, RpcBlock>,
    tip: number,
    now: string
  ): DepositAggregate | null {
    if (
      log.removed ||
      log.topics?.length !== 3 ||
      log.topics[0].toLowerCase() !== TRANSFER_TOPIC ||
      log.address.toLowerCase() !== gate.token_contract?.toLowerCase()
    )
      return null;

    const number = ChainIndexAggregate.assertLogBlock(log, blocks);

    if (!/^0x[a-f\d]{64}$/i.test(log.data) || !log.topics.slice(1).every((t) => /^0x0{24}[a-f\d]{40}$/i.test(t)))
      return null;

    const to = topicToAddress(log.topics[2]);

    if (!addresses.has(to) || decimal(log.data) === "0") return null;

    return this.observe(
      gate,
      addresses.get(to)!,
      log.transactionHash,
      safeInt(log.logIndex),
      topicToAddress(log.topics[1]),
      to,
      decimal(log.data),
      number,
      log.blockHash,
      tip,
      now
    );
  }

  /** Exports insertion fields only for a fresh, non-orphaned observation. */
  newRecord(): Omit<Deposit, "id"> {
    if (!this.#new || this.#state.status === "ORPHANED") throw new Error("Only a new observation can be inserted");

    const {id, ...record} = copy(this.#state);

    return record;
  }

  /** Applies a repeated canonical observation while preserving the persistent identity. */
  reobserve(observation: DepositAggregate): void {
    const record = observation.newRecord();
    const row = this.#state;

    if (
      row.asset_gate_id !== record.asset_gate_id ||
      row.tx_hash !== record.tx_hash ||
      row.log_index !== record.log_index
    )
      throw new Error("Deposit identity cannot change");

    this.#state = {id: row.id, ...record};
  }

  /**
   * Updates pending confirmations and applies the asset's confirmation threshold.
   *
   * @param tip Last scanned canonical block height.
   * @param required Confirmation threshold for the asset.
   */
  confirm(tip: number, required: number, now: string): void {
    const row = this.#state;

    if (row.status !== "PENDING") return;

    const confirmations = row.block_number <= tip ? tip - row.block_number + 1 : row.confirmations;
    const confirmed = confirmations >= required;

    this.#state = {
      ...row,
      confirmations,
      status: confirmed ? "CONFIRMED" : "PENDING",
      confirmed_at: confirmed ? now : row.confirmed_at
    };
  }

  /** Orphans a deposit above the canonical ancestor and clears its confirmations. */
  orphanAbove(ancestor: number): void {
    if (this.#state.block_number <= ancestor || this.#state.status === "ORPHANED") return;

    this.#state = {
      ...this.#state,
      status: "ORPHANED",
      confirmations: 0,
      confirmed_at: null
    };
  }
}
