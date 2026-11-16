import type {StoredBlock, ChainReorganization} from "../../domain/chain-index.js";

export type {StoredBlock} from "../../domain/chain-index.js";

import type {Address, Gate, Withdrawal, IndexerState} from "../../domain/models.js";
import type {DepositAggregate} from "../../domain/deposit.js";
import type {WithdrawalAggregate} from "../../domain/withdrawal.js";
import type {AddressBook} from "../../domain/address-book.js";

/** Read access to domain gate definitions and their network relationships. */
export interface Gates {
  /** Finds a gate by its public name, including the supported legacy alias. */
  gate(name: string): Promise<Gate | undefined>;

  /** Finds a gate by its persistent identity. */
  byId(id: number): Promise<Gate | undefined>;

  /** Resolves and validates the base network associated with an asset gate. */
  base(gate: Gate): Promise<Gate>;

  /** Lists child assets of a base gate in identity order. */
  children(id: number): Promise<Gate[]>;
}

/** Persistence boundary for address allocation and network address lookup. */
export interface Addresses {
  /** Serializes allocation on the base gate; the wallet-address callback runs inside the transaction. */
  allocate(
    book: AddressBook,
    create: (index: number) => Promise<string>
  ): Promise<{address: Address; created: boolean}>;

  /** Lists addresses belonging to a base gate. */
  forGate(id: number): Promise<Address[]>;
}

/** Persists new withdrawals and executes domain operations on locked current state. */
export interface Withdrawals {
  /** Reads a withdrawal snapshot by identity without granting mutation access. */
  find(id: number): Promise<Withdrawal | undefined>;

  /** Reads the withdrawal associated with an idempotency key. */
  byKey(key: string): Promise<Withdrawal | undefined>;

  /** Inserts only a fresh aggregate created through its domain factory. */
  create(aggregate: WithdrawalAggregate): Promise<Withdrawal>;

  /** Loads current state under a row lock; replacement records are never accepted. */
  change(id: number, operation: (aggregate: WithdrawalAggregate) => void): Promise<Withdrawal>;

  /** Finds the highest reserved nonce across native and token assets of one account. */
  highestReservedNonce(baseId: number, address: string): Promise<number | string | null>;

  /** Lists withdrawals eligible for receipt tracking, ordered and bounded by the limit. */
  pending(gateIds: number[], limit: number): Promise<Withdrawal[]>;
}

/** Transactional persistence for canonical blocks, index cursors and deposit aggregates. */
export interface IndexStore {
  /** Reads the last committed indexing position for a base gate. */
  state(gateId: number): Promise<IndexerState | undefined>;

  /** Atomically inserts the initial cursor and its matching anchor block. */
  initialize(state: IndexerState, block: StoredBlock): Promise<void>;

  /** Validates and atomically persists contiguous blocks, deposits and their cursor. */
  commitRange(state: IndexerState, blocks: StoredBlock[], deposits: DepositAggregate[]): Promise<void>;

  /** Loads retained blocks in the inclusive height window. */
  blocks(gateId: number, low: number, high: number): Promise<StoredBlock[]>;

  /** Finds a retained block by network and height. */
  block(gateId: number, number: number): Promise<StoredBlock | undefined>;

  /** Applies a validated reorganization atomically and reports orphaned confirmed deposits. */
  rollback(command: ChainReorganization): Promise<{id: number; tx_hash: string}[]>;

  /** Executes synchronous domain operations on pending deposits under row locks. */
  changePendingDeposits(gateIds: number[], operation: (deposit: DepositAggregate) => void): Promise<void>;

  /** Deletes retained block headers strictly below the supplied height. */
  prune(gateId: number, before: number): Promise<void>;
}

/** Optional filters for public wallet read projections. */
export interface QueryFilter {
  status?: string;
  gate?: string;
  address?: string;
}

/** Public deposit projection with the asset name and confirmation information. */
export interface DepositView {
  id: number;
  asset_gate: string;
  tx_hash: string;
  log_index: number;
  from_address: string;
  to_address: string;
  amount: string;
  amount_base_units: string;
  block_number: number;
  block_hash: string;
  confirmations: number;
  status: string;
  confirmed_at: Date | string | null;
}

/** Read projections for HTTP responses, separate from aggregate write operations. */
export interface WalletQueries {
  /** Lists the public address projection with gate names. */
  addresses(): Promise<(Address & {gate_name: string})[]>;

  /** Lists withdrawal projections matching the requested filters. */
  withdrawals(filter: QueryFilter): Promise<(Withdrawal & {gate_name: string})[]>;

  /** Lists deposit projections matching the requested filters. */
  deposits(filter: QueryFilter): Promise<DepositView[]>;
}
