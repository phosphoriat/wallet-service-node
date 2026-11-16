import {ChainReorganization} from "../src/domain/chain-index.js";
import {expect, test} from "@jest/globals";
import {database, services, sender, recipient, hash} from "./helpers.js";
import {TypeOrmWithdrawals, TypeOrmIndexStore} from "../src/infrastructure/persistence/repositories.js";
import {WithdrawalAggregate} from "../src/domain/withdrawal.js";
import {DepositAggregate} from "../src/domain/deposit.js";

test("repository rejects forged inserts and cannot save a caller-supplied replacement snapshot", async () => {
  const db = await database();

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;
    const repository = new TypeOrmWithdrawals(db);
    const created = WithdrawalAggregate.create(gate, sender, recipient, "1", "key");
    const forged = {
      newRecord: () => ({...created.newRecord(), status: "CONFIRMED"})
    };

    await expect(repository.create(forged as unknown as WithdrawalAggregate)).rejects.toThrow();

    const row = await repository.create(created);

    await expect(
      repository.create(WithdrawalAggregate.rehydrate({...row, idempotency_key: "another"}))
    ).rejects.toThrow("Only a new");
    await repository.change(row.id, () => WithdrawalAggregate.rehydrate({...row, status: "CONFIRMED"}));
    expect((await repository.find(row.id))?.status).toBe("CREATED");
    await expect(
      repository.change(row.id, (aggregate) => {
        Object.assign(aggregate.state, {status: "CONFIRMED"});
      })
    ).rejects.toThrow();
    expect((await repository.find(row.id))?.status).toBe("CREATED");

    const fetched = (await repository.find(row.id))!;

    fetched.status = "CONFIRMED";
    await repository.change(row.id, (aggregate) => aggregate.failBeforeSigning("signer down"));
    expect((await repository.find(row.id))?.status).toBe("FAILED");
    expect("update" in repository).toBe(false);
  } finally {
    await db.onModuleDestroy();
  }
});

test("a rejected domain transition or asynchronous callback rolls back the transaction", async () => {
  const db = await database();

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;
    const repository = new TypeOrmWithdrawals(db);
    const row = await repository.create(WithdrawalAggregate.create(gate, sender, recipient, "1", "key"));

    await expect(
      repository.change(row.id, (aggregate) => {
        aggregate.failBeforeSigning("temporary");
        aggregate.sign(sender, {
          nonce: 0,
          gas_limit: 21000,
          max_fee_per_gas_wei: "20",
          max_priority_fee_per_gas_wei: "1",
          signed_tx: "0x01",
          tx_hash: hash(100)
        });
      })
    ).rejects.toThrow("Only CREATED");
    expect((await repository.find(row.id))?.status).toBe("CREATED");
    await expect(
      repository.change(row.id, async (aggregate) => {
        aggregate.failBeforeSigning("temporary");
      })
    ).rejects.toThrow("must be synchronous");
    expect((await repository.find(row.id))?.status).toBe("CREATED");
  } finally {
    await db.onModuleDestroy();
  }
});

test("repository rejects cursor jumps and fabricated deposit snapshots before committing", async () => {
  const db = await database();

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;
    const store = new TypeOrmIndexStore(db);
    const start = {
      gate_id: gate.id,
      last_block_number: 0,
      last_block_hash: hash(0)
    };

    await store.initialize(start, {
      gate_id: gate.id,
      number: 0,
      hash: hash(0),
      parent_hash: hash(999)
    });
    await expect(
      store.commitRange(
        {...start, last_block_number: 2, last_block_hash: hash(2)},
        [{gate_id: gate.id, number: 2, hash: hash(2), parent_hash: hash(0)}],
        []
      )
    ).rejects.toThrow("Non-contiguous");

    const observation = DepositAggregate.observe(gate, 1, hash(100), -1, sender, recipient, "1", 1, hash(1), 1, "now");

    await expect(
      store.commitRange(
        {...start, last_block_number: 1, last_block_hash: hash(1)},
        [{gate_id: gate.id, number: 1, hash: hash(1), parent_hash: hash(0)}],
        [
          {
            state: observation.state,
            newRecord: () => observation.newRecord()
          } as unknown as DepositAggregate
        ]
      )
    ).rejects.toThrow();
    expect(await store.state(gate.id)).toMatchObject(start);
    expect(await store.block(gate.id, 1)).toBeUndefined();
  } finally {
    await db.onModuleDestroy();
  }
});

test("reorg failure atomically restores deposits, withdrawals, blocks and cursor", async () => {
  const db = await database();

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;
    const store = new TypeOrmIndexStore(db),
      withdrawals = new TypeOrmWithdrawals(db);
    const start = {
      gate_id: gate.id,
      last_block_number: 0,
      last_block_hash: hash(0)
    };

    await store.initialize(start, {
      gate_id: gate.id,
      number: 0,
      hash: hash(0),
      parent_hash: hash(999)
    });

    const address = await (
      await db.repository("addresses")
    ).save({
      gate_id: gate.id,
      account: 0,
      change: 0,
      address_index: 0,
      address: recipient
    });
    const state = {...start, last_block_number: 1, last_block_hash: hash(1)};

    await store.commitRange(
      state,
      [{gate_id: gate.id, number: 1, hash: hash(1), parent_hash: hash(0)}],
      [
        DepositAggregate.observe(
          {...gate, confirmations_required: 1},
          address.id,
          hash(100),
          -1,
          sender,
          recipient,
          "1",
          1,
          hash(1),
          1,
          "2026-01-01 00:00:00"
        )
      ]
    );

    const row = await withdrawals.create(WithdrawalAggregate.create(gate, sender, recipient, "1", "key"));

    await withdrawals.change(row.id, (a) =>
      a.sign(sender, {
        nonce: 0,
        gas_limit: 21000,
        max_fee_per_gas_wei: "20",
        max_priority_fee_per_gas_wei: "1",
        signed_tx: "0x01",
        tx_hash: hash(101)
      })
    );
    await withdrawals.change(row.id, (a) =>
      a.applyReceipt({number: 1, hash: hash(1), canonicalHash: hash(1), status: "0x1"}, 1, 1, "2026-01-01 00:00:00")
    );
    await db.source.query(
      "CREATE TRIGGER fail_cursor BEFORE UPDATE ON indexer_states BEGIN SELECT RAISE(FAIL, 'cursor failure'); END"
    );
    await expect(store.rollback(ChainReorganization.plan(state, start, hash(0), 128))).rejects.toThrow(
      "cursor failure"
    );
    expect((await withdrawals.find(row.id))?.status).toBe("CONFIRMED");
    expect((await (await db.repository("deposits")).findOneByOrFail({tx_hash: hash(100)})).status).toBe("CONFIRMED");
    expect(await store.state(gate.id)).toMatchObject(state);
    expect(await store.block(gate.id, 1)).toBeDefined();
    await db.source.query("DROP TRIGGER fail_cursor");
    expect(await store.rollback(ChainReorganization.plan(state, start, hash(0), 128))).toEqual([
      {id: expect.any(Number), tx_hash: hash(100)}
    ]);
    expect((await withdrawals.find(row.id))?.status).toBe("BROADCASTED");
    expect((await (await db.repository("deposits")).findOneByOrFail({tx_hash: hash(100)})).status).toBe("ORPHANED");
  } finally {
    await db.onModuleDestroy();
  }
});
