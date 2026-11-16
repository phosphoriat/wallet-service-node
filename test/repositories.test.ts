import {expect, test} from "@jest/globals";
import {database, services, recipient, sender, hash} from "./helpers.js";
import {TypeOrmIndexStore, TypeOrmWithdrawals} from "../src/infrastructure/persistence/repositories.js";
import {WithdrawalAggregate} from "../src/domain/withdrawal.js";
import {DepositAggregate} from "../src/domain/deposit.js";

test("a failed range write rolls back blocks, deposits and indexer cursor together", async () => {
  const db = await database();

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;
    const store = new TypeOrmIndexStore(db);
    const state = {
      gate_id: gate.id,
      last_block_number: 0,
      last_block_hash: hash(0)
    };

    await store.initialize(state, {
      gate_id: gate.id,
      number: 0,
      hash: hash(0),
      parent_hash: hash(999)
    });

    const inserted = await (
      await db.repository("addresses")
    ).insert({
      gate_id: gate.id,
      account: 0,
      change: 0,
      address_index: 0,
      address: recipient
    });
    const deposit = DepositAggregate.observe(
      gate,
      Number(inserted.identifiers[0].id),
      hash(10),
      -1,
      sender,
      recipient,
      "1",
      1,
      hash(1),
      1,
      "now"
    );

    await expect(
      store.commitRange(
        {...state, last_block_number: 1, last_block_hash: hash(1)},
        [{gate_id: gate.id, number: 1, hash: hash(1), parent_hash: hash(0)}],
        [deposit, DepositAggregate.observe(gate, 99999, hash(11), -1, sender, recipient, "1", 1, hash(1), 1, "now")]
      )
    ).rejects.toThrow();
    expect(await store.state(gate.id)).toMatchObject(state);
    expect(await store.block(gate.id, 1)).toBeUndefined();
    expect(await (await db.repository("deposits")).find()).toHaveLength(0);
  } finally {
    await db.onModuleDestroy();
  }
});

test("conditional persistence cannot demote a concurrently confirmed withdrawal", async () => {
  const db = await database();

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;
    const repository = new TypeOrmWithdrawals(db);
    const row = await repository.create(WithdrawalAggregate.create(gate, sender, recipient, "1", "key"));

    await repository.change(row.id, (aggregate) =>
      aggregate.sign(sender, {
        nonce: 0,
        gas_limit: 21000,
        max_fee_per_gas_wei: "20",
        max_priority_fee_per_gas_wei: "1",
        signed_tx: "0x01",
        tx_hash: hash(100)
      })
    );
    await repository.change(row.id, (aggregate) =>
      aggregate.applyReceipt({number: 1, hash: hash(1), canonicalHash: hash(1), status: "0x1"}, 2, 2, "now")
    );
    await repository.change(row.id, (aggregate) => aggregate.recordBroadcast({hash: hash(100)}, "later"));
    expect((await repository.find(row.id))?.status).toBe("CONFIRMED");
    await repository.change(row.id, (aggregate) =>
      aggregate.recordBroadcast({message: "rejected", code: -32000}, "later")
    );
    expect((await repository.find(row.id))?.status).toBe("CONFIRMED");
  } finally {
    await db.onModuleDestroy();
  }
});
