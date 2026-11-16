import {expect, test} from "@jest/globals";
import {DataSource} from "typeorm";
import {entities} from "../src/infrastructure/persistence/entities.js";
import {InitialWalletSchema1794787200000, migrate, seed, verify} from "../src/infrastructure/persistence/schema.js";

async function source() {
  return new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: entities(true),
    migrations: [InitialWalletSchema1794787200000],
    synchronize: false
  }).initialize();
}

test("explicit migration creates required columns, foreign keys and unique indexes; seeds preserve IDs", async () => {
  const db = await source();

  try {
    await migrate(db);
    await verify(db);
    await seed(db);

    const gates = db.getRepository("gates");
    const before = await gates.find({order: {id: "ASC"}});

    await seed(db);

    const after = await gates.find({order: {id: "ASC"}});

    expect(after.map((g) => [g.id, g.name, g.parent_gate_id])).toEqual(
      before.map((g) => [g.id, g.name, g.parent_gate_id])
    );
    expect(after).toHaveLength(2);
    expect(await db.query("SELECT COUNT(*) AS count FROM migrations")).toEqual([{count: 1}]);
    await expect(gates.insert({...before[0], id: undefined})).rejects.toThrow();
    await expect(
      db.getRepository("addresses").insert({
        gate_id: 9999,
        account: 0,
        change: 0,
        address_index: 0,
        address: "0x" + "ab".repeat(20)
      })
    ).rejects.toThrow();
  } finally {
    await db.destroy();
  }
});

test("migration refuses existing tables before writing any schema or migration history", async () => {
  const db = await source();

  try {
    await db.query("CREATE TABLE gates (id integer PRIMARY KEY)");
    await db.query("INSERT INTO gates (id) VALUES (42)");
    await expect(migrate(db)).rejects.toThrow(/Use db:verify/);
    expect(await db.query("SELECT id FROM gates")).toEqual([{id: 42}]);

    const tables = await db.query("SELECT name FROM sqlite_master WHERE type='table'");

    expect(tables).toEqual([{name: "gates"}]);
  } finally {
    await db.destroy();
  }
});

test("verification rejects a missing unique index without changing the database", async () => {
  const db = await source();
  const runner = db.createQueryRunner();

  try {
    await migrate(db);

    const table = (await runner.getTable("addresses"))!;
    const unique = table.indices.find((index) => index.isUnique && index.columnNames.join() === "gate_id,address")!;

    await runner.dropIndex(table, unique);
    await expect(verify(db)).rejects.toThrow("Missing unique index addresses(gate_id,address)");
  } finally {
    await runner.release();
    await db.destroy();
  }
});

test("MySQL mappings produce native enums, unsigned IDs, foreign keys and row locks without schema synchronization", async () => {
  const {Table, TableForeignKey} = await import("typeorm");
  const {mysqlSource} = await import("../src/infrastructure/persistence/database.js");

  class MetadataSource extends DataSource {
    async prepare() {
      await this.buildMetadatas();
    }
  }

  const db = new MetadataSource(mysqlSource().options);

  await db.prepare();
  expect(db.options.synchronize).toBe(false);
  expect(db.options.migrationsRun).toBe(false);

  const runner = db.createQueryRunner();

  runner.enableSqlMemory();

  try {
    for (const metadata of db.entityMetadatas) {
      const table = Table.create(metadata, db.driver);

      table.foreignKeys = metadata.foreignKeys.map((key) => TableForeignKey.create(key, db.driver));
      await runner.createTable(table);
    }

    const sql = runner
      .getMemorySql()
      .upQueries.map((query) => query.query)
      .join("\n");

    expect(sql).toContain("bigint UNSIGNED NOT NULL AUTO_INCREMENT");
    expect(sql).toContain("enum ('CREATED', 'SIGNED', 'BROADCASTED', 'CONFIRMED', 'FAILED')");
    expect(sql).toContain("FOREIGN KEY (`asset_gate_id`) REFERENCES `gates` (`id`)");

    const lock = db
      .getRepository("gates")
      .createQueryBuilder("gate")
      .where("gate.id = :id", {id: 1})
      .setLock("pessimistic_write")
      .getQueryAndParameters();

    expect(lock[0]).toContain("FOR UPDATE");
    expect(lock[1]).toEqual([1]);
  } finally {
    await runner.release();
  }
});
