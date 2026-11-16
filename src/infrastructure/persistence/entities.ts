import {EntitySchema, type EntitySchemaColumnOptions} from "typeorm";
import type {Address, Gate, IndexerState, Withdrawal} from "../../domain/models.js";
import type {StoredBlock} from "../../application/ports/repositories.js";
import type {Deposit} from "../../domain/deposit.js";

type Timestamps = {created_at: Date | string; updated_at: Date | string};

export type GateRecord = Gate & Timestamps & {rpc_url: string | null; wallet_gate: string | null};

export type AddressRecord = Address & Timestamps;

export type BlockRecord = StoredBlock & Timestamps & {id: number};

export type IndexStateRecord = IndexerState & Timestamps & {id: number};

export type DepositRecord = Omit<Deposit, "status" | "confirmed_at"> &
  Timestamps & {
    id: number;
    status: "PENDING" | "CONFIRMED" | "ORPHANED";
    confirmed_at: Date | string | null;
  };

export type WithdrawalRecord = Withdrawal & Timestamps;

/** Maps persistent table names to their infrastructure record types. */
export interface Tables {
  gates: GateRecord;
  addresses: AddressRecord;
  blocks: BlockRecord;
  indexer_states: IndexStateRecord;
  deposits: DepositRecord;
  withdrawals: WithdrawalRecord;
}

/** Database mappings stay outside the domain. synchronize is disabled in every environment. */
export function entities(sqlite = false) {
  const integer = (nullable = false): EntitySchemaColumnOptions => ({
    type: sqlite ? "integer" : "bigint",
    unsigned: true,
    nullable
  });
  const text = (length: number, nullable = false, fixed = false): EntitySchemaColumnOptions => ({
    type: fixed && !sqlite ? "char" : "varchar",
    length,
    nullable
  });
  const timestamp = (nullable = false): EntitySchemaColumnOptions => ({
    type: sqlite ? "datetime" : "timestamp",
    nullable
  });
  const common = () => ({
    id: {...integer(), primary: true, generated: "increment" as const},
    created_at: {...timestamp(), default: () => "CURRENT_TIMESTAMP"},
    updated_at: {...timestamp(), default: () => "CURRENT_TIMESTAMP"}
  });
  const status = (values: string[], initial?: string): EntitySchemaColumnOptions => ({
    type: sqlite ? "varchar" : "enum",
    ...(sqlite ? {} : {enum: values}),
    ...(initial ? {default: initial} : {})
  });
  const gateForeignKey = (column = "gate_id") => ({
    target: "gates",
    columnNames: [column],
    referencedColumnNames: ["id"],
    onDelete: "RESTRICT" as const
  });

  return [
    new EntitySchema<GateRecord>({
      name: "gates",
      tableName: "gates",
      columns: {
        ...common(),
        name: {...text(64), unique: true},
        rpc_url: text(255, true),
        chain_id: integer(),
        confirmations_required: {
          type: "integer",
          unsigned: true,
          default: 12
        },
        parent_gate_id: integer(true),
        asset_type: status(["NATIVE", "ERC20"]),
        token_contract: text(42, true),
        token_decimals: {
          type: sqlite ? "integer" : "tinyint",
          unsigned: true,
          nullable: true
        },
        wallet_gate: text(64, true)
      },
      foreignKeys: [gateForeignKey("parent_gate_id")]
    }),
    new EntitySchema<AddressRecord>({
      name: "addresses",
      tableName: "addresses",
      columns: {
        ...common(),
        gate_id: integer(),
        account: {type: "integer", unsigned: true},
        change: {type: "integer", unsigned: true},
        address_index: {type: "integer", unsigned: true},
        address: text(42, false, true)
      },
      foreignKeys: [gateForeignKey()],
      indices: [
        {
          unique: true,
          columns: ["gate_id", "account", "change", "address_index"]
        },
        {unique: true, columns: ["gate_id", "address"]}
      ]
    }),
    new EntitySchema<BlockRecord>({
      name: "blocks",
      tableName: "blocks",
      columns: {
        ...common(),
        gate_id: integer(),
        number: integer(),
        hash: text(66, false, true),
        parent_hash: text(66, false, true)
      },
      foreignKeys: [gateForeignKey()],
      indices: [{unique: true, columns: ["gate_id", "number"]}]
    }),
    new EntitySchema<IndexStateRecord>({
      name: "indexer_states",
      tableName: "indexer_states",
      columns: {
        ...common(),
        gate_id: {...integer(), unique: true},
        last_block_number: integer(),
        last_block_hash: text(66, false, true)
      },
      foreignKeys: [gateForeignKey()]
    }),
    new EntitySchema<DepositRecord>({
      name: "deposits",
      tableName: "deposits",
      columns: {
        ...common(),
        asset_gate_id: integer(),
        address_id: integer(),
        tx_hash: text(66, false, true),
        log_index: {type: "integer"},
        from_address: text(42, false, true),
        to_address: text(42, false, true),
        amount_base_units: text(78),
        amount: text(100),
        block_number: integer(),
        block_hash: text(66, false, true),
        confirmations: {type: "integer", unsigned: true, default: 0},
        status: status(["PENDING", "CONFIRMED", "ORPHANED"], "PENDING"),
        confirmed_at: timestamp(true)
      },
      foreignKeys: [
        gateForeignKey("asset_gate_id"),
        {
          target: "addresses",
          columnNames: ["address_id"],
          referencedColumnNames: ["id"]
        }
      ],
      indices: [
        {unique: true, columns: ["asset_gate_id", "tx_hash", "log_index"]},
        {columns: ["asset_gate_id", "status", "block_number"]}
      ]
    }),
    new EntitySchema<WithdrawalRecord>({
      name: "withdrawals",
      tableName: "withdrawals",
      columns: {
        ...common(),
        idempotency_key: {...text(36, false, true), unique: true},
        asset_gate_id: integer(),
        from_address: text(42, true, true),
        to_address: text(42, false, true),
        amount: text(100),
        amount_base_units: text(78),
        status: status(["CREATED", "SIGNED", "BROADCASTED", "CONFIRMED", "FAILED"], "CREATED"),
        tx_to: text(42, true, true),
        tx_value_wei: text(78, true),
        tx_data: {type: "text", nullable: true},
        nonce: integer(true),
        gas_limit: integer(true),
        max_fee_per_gas_wei: text(78, true),
        max_priority_fee_per_gas_wei: text(78, true),
        signed_tx: {type: "text", nullable: true},
        tx_hash: {...text(66, true, true), unique: true},
        block_number: integer(true),
        error: {type: "text", nullable: true},
        broadcasted_at: timestamp(true),
        confirmed_at: timestamp(true)
      },
      foreignKeys: [gateForeignKey("asset_gate_id")],
      indices: [{columns: ["asset_gate_id", "status"]}]
    })
  ];
}
