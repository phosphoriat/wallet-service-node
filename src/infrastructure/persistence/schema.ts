import {DataSource, Table, TableForeignKey, type MigrationInterface, type QueryRunner} from "typeorm";
import type {GateRecord} from "./entities.js";

const tables = ["gates", "addresses", "blocks", "indexer_states", "deposits", "withdrawals"];

/** Refuses initial migration when any application table already exists. */
async function requireEmpty(runner: QueryRunner): Promise<void> {
  for (const name of tables)
    if (await runner.hasTable(name))
      throw new Error(
        `Table ${name} already exists. Use db:verify for an existing Laravel database; no automatic schema changes were made.`
      );
}

/** Explicit initial migration, never run on application startup. */
export class InitialWalletSchema1794787200000 implements MigrationInterface {
  /** Creates the explicit initial tables, foreign keys and indexes. */
  async up(runner: QueryRunner): Promise<void> {
    await requireEmpty(runner);

    for (const name of tables) {
      const metadata = runner.connection.getMetadata(name);
      const table = Table.create(metadata, runner.connection.driver);

      table.foreignKeys = metadata.foreignKeys.map((key) => TableForeignKey.create(key, runner.connection.driver));
      await runner.createTable(table, false, true, true);
    }
  }

  /** Refuses destructive rollback of wallet persistence. */
  async down(): Promise<void> {
    throw new Error("Destructive rollback is not supported; restore a database backup explicitly.");
  }
}

/** Runs the initial migration only after checking that application tables are absent. */
export async function migrate(db: DataSource): Promise<void> {
  const runner = db.createQueryRunner();

  try {
    await requireEmpty(runner);
  } finally {
    await runner.release();
  }

  await db.runMigrations({transaction: "none"});
}

/** Checks required columns and unique indexes without modifying existing tables. */
export async function verify(db: DataSource): Promise<void> {
  const runner = db.createQueryRunner();

  try {
    for (const name of tables) {
      const table = await runner.getTable(name);

      if (!table) throw new Error(`Missing table ${name}`);

      const metadata = db.getMetadata(name);

      for (const column of metadata.columns)
        if (!table.findColumnByName(column.databaseName)) throw new Error(`Missing ${name}.${column.databaseName}`);

      const required = [
        ...metadata.uniques.map((index) => index.columns.map((c) => c.databaseName)),
        ...metadata.indices.filter((index) => index.isUnique).map((index) => index.columns.map((c) => c.databaseName))
      ];
      const actual = [
        ...table.uniques.map((index) => index.columnNames),
        ...table.indices.filter((index) => index.isUnique).map((index) => index.columnNames),
        ...table.columns.filter((column) => column.isUnique).map((column) => [column.name])
      ];

      for (const key of required)
        if (!actual.some((columns) => columns.join() === key.join()))
          throw new Error(`Missing unique index ${name}(${key})`);
    }
  } finally {
    await runner.release();
  }
}

/** Upserts network and token definitions while preserving their persistent identities. */
export async function seed(db: DataSource): Promise<void> {
  await db.transaction(async (manager) => {
    const gates = manager.getRepository<GateRecord>("gates");
    const common = {
      rpc_url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chain_id: 11155111,
      confirmations_required: 12,
      updated_at: () => "CURRENT_TIMESTAMP"
    };

    await gates.upsert(
      {
        ...common,
        name: "eth_sepolia",
        parent_gate_id: null,
        asset_type: "NATIVE",
        token_contract: null,
        token_decimals: null,
        wallet_gate: "ethereum"
      },
      ["name"]
    );

    const eth = await gates.findOneByOrFail({name: "eth_sepolia"});

    await gates.upsert(
      {
        ...common,
        name: "usdc_sepolia",
        parent_gate_id: eth.id,
        asset_type: "ERC20",
        token_contract: (
          process.env.USDC_SEPOLIA_CONTRACT || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
        ).toLowerCase(),
        token_decimals: Number(process.env.USDC_SEPOLIA_DECIMALS || 6),
        wallet_gate: null
      },
      ["name"]
    );
  });
}
