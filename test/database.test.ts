import {expect, jest, test} from "@jest/globals";
import {Database} from "../src/infrastructure/persistence/database.js";

function fixture({acquired = 1, owned = 1, released = 1} = {}) {
  const connection = {destroy: jest.fn()};
  const runner = {
    connect: jest.fn(async () => connection),
    release: jest.fn(async () => {}),
    query: jest.fn(async (sql: string, _parameters: unknown[]) => {
      if (sql.includes("GET_LOCK")) return [{acquired}];

      if (sql.includes("IS_USED_LOCK")) return [{owned}];

      if (sql.includes("RELEASE_LOCK")) return [{released}];

      throw new Error("Unexpected query");
    })
  };
  const db = Object.create(Database.prototype) as Database;

  Object.defineProperty(db, "lockSource", {
    value: {isInitialized: true, createQueryRunner: () => runner}
  });

  return {db, runner, connection};
}

test("advisory lock acquisition, ownership check and release share one connection and key", async () => {
  const {db, runner, connection} = fixture();

  expect(
    await db.lock("nonce:1:address", 30, async (assertOwned) => {
      await assertOwned();

      return 42;
    })
  ).toBe(42);

  const queries = runner.query.mock.calls;

  expect(queries.map(([sql]) => sql)).toEqual([
    "SELECT GET_LOCK(?, ?) AS acquired",
    "SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned",
    "SELECT RELEASE_LOCK(?) AS released"
  ]);
  expect(queries.map(([, parameters]) => parameters[0])).toEqual(Array(3).fill(queries[0][1][0]));
  expect(queries[0][1][1]).toBe(30);
  expect(runner.release).toHaveBeenCalledTimes(1);
  expect(connection.destroy).not.toHaveBeenCalled();
});

test("lock timeout prevents work and returns the connection", async () => {
  const {db, runner} = fixture({acquired: 0});
  const work = jest.fn(async () => {});

  await expect(db.lock("busy", 1, work)).rejects.toThrow("Could not acquire lock");
  expect(work).not.toHaveBeenCalled();
  expect(runner.query).toHaveBeenCalledTimes(1);
  expect(runner.release).toHaveBeenCalledTimes(1);
});

test("lost ownership aborts work and release failure destroys the connection", async () => {
  const {db, runner, connection} = fixture({owned: 0, released: 0});
  let proceeded = false;

  await expect(
    db.lock("lost", 1, async (assertOwned) => {
      await assertOwned();
      proceeded = true;
    })
  ).rejects.toThrow();
  expect(proceeded).toBe(false);
  expect(connection.destroy).toHaveBeenCalledTimes(1);
  expect(runner.release).toHaveBeenCalledTimes(1);
});

test("callback failure still releases an acquired lock", async () => {
  const {db, runner, connection} = fixture();

  await expect(
    db.lock("failure", 1, async () => {
      throw new Error("work failed");
    })
  ).rejects.toThrow("work failed");
  expect(runner.query.mock.calls.at(-1)?.[0]).toContain("RELEASE_LOCK");
  expect(runner.release).toHaveBeenCalledTimes(1);
  expect(connection.destroy).not.toHaveBeenCalled();
});
