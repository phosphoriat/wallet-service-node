import type {Gate, Withdrawal} from "./models.js";
import {decimals} from "./models.js";
import {Amount, decimal, safeInt, transferCalldata} from "./amount.js";
import {ConflictError, ValidationError} from "./errors.js";

/** Validated signer output and fee parameters required for the SIGNED transition. */
export interface Signature {
  nonce: number;
  gas_limit: number;
  max_fee_per_gas_wei: string;
  max_priority_fee_per_gas_wei: string;
  signed_tx: string;
  tx_hash: string;
}

export type BroadcastResult = {hash: string} | {message: string; code: number | null};

/** Receipt inclusion evidence together with the independently resolved canonical hash. */
export interface CanonicalReceipt {
  number: number;
  hash: string;
  canonicalHash: string | null;
  status?: string;
}

const fields = [
  "id",
  "idempotency_key",
  "asset_gate_id",
  "from_address",
  "to_address",
  "amount",
  "amount_base_units",
  "status",
  "tx_to",
  "tx_value_wei",
  "tx_data",
  "nonce",
  "gas_limit",
  "max_fee_per_gas_wei",
  "max_priority_fee_per_gas_wei",
  "signed_tx",
  "tx_hash",
  "block_number",
  "error",
  "broadcasted_at",
  "confirmed_at"
] as const;

/** Copies whitelisted snapshot fields and clones dates to prevent shared mutable state. */
function copy(state: Readonly<Withdrawal>): Withdrawal {
  return Object.fromEntries(
    fields.map((key) => [key, state[key] instanceof Date ? new Date(state[key] as Date) : state[key]])
  ) as unknown as Withdrawal;
}

/** Module-private token preventing direct aggregate construction at runtime. */
const construction = Symbol("aggregate construction");

/** Owns withdrawal identity and lifecycle transitions through private state. */
export class WithdrawalAggregate {
  #state: Withdrawal;
  readonly #new: boolean;

  private constructor(state: Withdrawal, isNew: boolean, token: symbol) {
    if (token !== construction) throw new Error("Use aggregate factories");

    this.#state = copy(state);
    this.#new = isNew;
    Object.freeze(this);
  }

  static readonly reservedStatuses = Object.freeze(["SIGNED", "BROADCASTED", "CONFIRMED"] as const);
  static readonly trackedStatuses = Object.freeze(["SIGNED", "BROADCASTED"] as const);
  static readonly reorgStatuses = Object.freeze(["BROADCASTED", "CONFIRMED", "FAILED"] as const);

  /** Restores an existing withdrawal without allowing it to be inserted as new. */
  static rehydrate(state: Withdrawal): WithdrawalAggregate {
    if (!Number.isSafeInteger(state.id) || state.id < 1) throw new Error("Persisted withdrawal identity required");

    return new WithdrawalAggregate(state, false, construction);
  }

  /** Returns a detached immutable snapshot, including copies of mutable date values. */
  get state(): Readonly<Withdrawal> {
    return Object.freeze(copy(this.#state));
  }

  /** Validates asset precision and converts amount failures to field-level domain errors. */
  static amount(gate: Gate, value: string): Amount {
    try {
      return new Amount(value, decimals(gate));
    } catch (error) {
      throw new ValidationError((error as Error).message, "amount");
    }
  }

  /** Converts a wallet validation result into the recipient-validation contract. */
  static assertRecipient(valid: boolean): void {
    if (!valid) throw new ValidationError("Invalid address", "to_address");
  }

  /** Creates a fresh CREATED withdrawal with exact amounts and transfer parameters. */
  static create(gate: Gate, from: string, to: string, value: string, key: string): WithdrawalAggregate {
    const amount = this.amount(gate, value);

    to = to.toLowerCase();

    const txTo = gate.asset_type === "NATIVE" ? to : gate.token_contract?.toLowerCase();

    if (!txTo) throw new Error("Token contract is not configured");

    return new WithdrawalAggregate(
      {
        id: 0,
        idempotency_key: key,
        asset_gate_id: gate.id,
        from_address: from,
        to_address: to,
        amount: value,
        amount_base_units: amount.baseUnits,
        status: "CREATED",
        tx_to: txTo,
        tx_value_wei: gate.asset_type === "NATIVE" ? amount.baseUnits : "0",
        tx_data: gate.asset_type === "NATIVE" ? "0x" : transferCalldata(to, amount.baseUnits),
        nonce: null,
        gas_limit: null,
        max_fee_per_gas_wei: null,
        max_priority_fee_per_gas_wei: null,
        signed_tx: null,
        tx_hash: null,
        block_number: null,
        error: null,
        broadcasted_at: null,
        confirmed_at: null
      },
      true,
      construction
    );
  }

  /** Insert is permitted only for a fresh aggregate produced by create(). */
  newRecord(): Omit<Withdrawal, "id"> {
    if (!this.#new || this.#state.status !== "CREATED")
      throw new Error("Only a new CREATED withdrawal can be inserted");

    const {id, ...record} = copy(this.#state);

    return record;
  }

  /** Rejects idempotency-key reuse with another asset, recipient or amount. */
  assertSameRequest(gate: Gate, to: string, units: string): void {
    const row = this.#state;

    if (
      row.asset_gate_id !== gate.id ||
      row.to_address.toLowerCase() !== to.toLowerCase() ||
      row.amount_base_units !== units
    )
      throw new ConflictError("Idempotency-Key was already used for another request");
  }

  /**
   * Allows signing only from CREATED and verifies the signer and signed transaction.
   *
   * @throws When the withdrawal is no longer CREATED or the signer/output is invalid.
   */
  sign(signer: string | null, values: Signature): void {
    if (this.#state.status !== "CREATED") throw new Error("Only CREATED withdrawals can be signed");

    if (signer !== null && signer.toLowerCase() !== this.#state.from_address)
      throw new Error("Signer address mismatch");

    safeInt(values.nonce);
    safeInt(values.gas_limit);

    if (!/^0x(?:[a-f\d]{2})+$/i.test(values.signed_tx) || !/^0x[a-f\d]{64}$/i.test(values.tx_hash))
      throw new Error("Invalid signed transaction");

    this.#state = {
      ...this.#state,
      nonce: values.nonce,
      gas_limit: values.gas_limit,
      max_fee_per_gas_wei: values.max_fee_per_gas_wei,
      max_priority_fee_per_gas_wei: values.max_priority_fee_per_gas_wei,
      signed_tx: values.signed_tx,
      status: "SIGNED",
      tx_hash: values.tx_hash.toLowerCase()
    };
  }

  /** Allows retries only for SIGNED withdrawals with persisted transaction bytes. */
  assertRebroadcastable(): void {
    if (this.#state.status !== "SIGNED" || !this.#state.signed_tx)
      throw new ValidationError("Only SIGNED withdrawals can be rebroadcast");
  }

  /** Marks only an unsigned CREATED request as safely failed. */
  failBeforeSigning(message: string): void {
    if (this.#state.status === "CREATED")
      this.#state = {
        ...this.#state,
        status: "FAILED",
        error: message.slice(0, 2000)
      };
  }

  /** Classifies broadcast outcomes without demoting a concurrently confirmed withdrawal. */
  recordBroadcast(result: BroadcastResult, now: string): void {
    const row = this.#state;

    if (!row.signed_tx) throw new Error("A persisted signature is required for broadcast");

    if ("hash" in result) {
      if (result.hash.toLowerCase() !== row.tx_hash?.toLowerCase()) {
        this.#state = {
          ...row,
          error: "Broadcast returned unexpected hash; verify expected transaction before retrying"
        };

        return;
      }
    } else if (!/already known|known transaction/i.test(result.message)) {
      if (result.code !== null && !/nonce too low/i.test(result.message)) {
        if (row.status === "SIGNED")
          this.#state = {
            ...row,
            status: "FAILED",
            error: result.message.slice(0, 2000)
          };
      } else
        this.#state = {
          ...row,
          error: `Broadcast result unknown: ${result.message}`.slice(0, 2000)
        };

      return;
    }

    // A late success must not demote a receipt confirmed concurrently.
    if (row.status === "SIGNED")
      this.#state = {
        ...row,
        status: "BROADCASTED",
        broadcasted_at: now,
        error: null
      };
  }

  /** Applies only canonical receipts to withdrawals still eligible for tracking. */
  applyReceipt(receipt: CanonicalReceipt, tip: number, required: number, now: string): void {
    const row = this.#state;

    if (row.status !== "SIGNED" && row.status !== "BROADCASTED") return;

    if (
      receipt.number > tip ||
      !receipt.canonicalHash ||
      receipt.hash.toLowerCase() !== receipt.canonicalHash.toLowerCase()
    )
      return;

    if (receipt.status === undefined) throw new Error("Withdrawal receipt status is missing");

    const failed = decimal(receipt.status) !== "1";
    const confirmed = !failed && tip - receipt.number + 1 >= required;

    this.#state = {
      ...row,
      status: failed ? "FAILED" : confirmed ? "CONFIRMED" : "BROADCASTED",
      block_number: receipt.number,
      confirmed_at: confirmed ? now : null,
      broadcasted_at: row.broadcasted_at || now,
      error: failed ? "Transaction reverted on-chain" : null
    };
  }

  /** Clears mined confirmation state above an ancestor while retaining signed bytes. */
  orphanAbove(ancestor: number): void {
    const row = this.#state;

    if (
      row.block_number === null ||
      row.block_number <= ancestor ||
      !WithdrawalAggregate.reorgStatuses.some((status) => status === row.status)
    )
      return;

    this.#state = {
      ...row,
      status: "BROADCASTED",
      block_number: null,
      confirmed_at: null,
      error: null
    };
  }
}
