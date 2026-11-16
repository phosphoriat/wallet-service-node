import {services} from "./helpers.js";
import "reflect-metadata";
import {expect, test} from "@jest/globals";
import {addressToTopic, TRANSFER_TOPIC, hex} from "../src/domain/amount.js";
import {database, config, FakeRpc, recipient, sender, hash} from "./helpers.js";

test("indexer collects native/ERC20, rejects reverted/nonstandard logs, confirms, reorgs and revives deposits", async () => {
  const db = await database();

  try {
    const base = (await services(db).gates.gate("eth_sepolia"))!,
      token = (await services(db).gates.gate("usdc_sepolia"))!;

    await (await db.repository("gates")).updateAll({confirmations_required: 2});
    base.confirmations_required = 2;
    await (
      await db.repository("addresses")
    ).insert({
      gate_id: base.id,
      account: 0,
      change: 0,
      address_index: 0,
      address: recipient
    });

    const cfg = config(),
      rpc = new FakeRpc();

    rpc.add(0);

    const one = rpc.add(1);

    rpc.add(2);
    one.transactions.push(
      {
        hash: hash(100),
        from: sender,
        to: recipient,
        value: hex(400000000000000n)
      },
      {hash: hash(101), from: sender, to: recipient, value: hex(1)}
    );
    rpc.receiptMap.set(hash(100), {
      blockNumber: hex(1),
      blockHash: one.hash,
      status: "0x1"
    });
    rpc.receiptMap.set(hash(101), {
      blockNumber: hex(1),
      blockHash: one.hash,
      status: "0x0"
    });

    const log = {
      address: token.token_contract!,
      topics: [TRANSFER_TOPIC, addressToTopic(sender), addressToTopic(recipient)],
      blockNumber: hex(1),
      blockHash: one.hash,
      transactionHash: hash(102),
      logIndex: "0x0",
      data: "0x" + 100000000n.toString(16).padStart(64, "0")
    };

    rpc.events = [
      log,
      {...log, logIndex: "0x1", removed: true},
      {...log, logIndex: "0x2", topics: [...log.topics, hash(1)]}
    ];

    const service = services(db, undefined, rpc, cfg).indexer;
    const first = await service.run(base);

    expect(first.blocks).toBe(2);
    expect(first.deposits).toBe(2);

    let rows = await (await db.repository("deposits")).find({order: {id: "ASC"}});

    expect(rows[0].amount).toBe("0.0004");
    expect(rows[1].amount).toBe("100");
    expect(rows.every((d) => d.status === "CONFIRMED")).toBeTruthy();
    await service.run(base);
    expect((await (await db.repository("deposits")).find()).length).toBe(2);
    rpc.add(1, 1000);
    rpc.add(2, 1000);
    rpc.events = [];

    const rollback = await service.run(base);

    expect(rollback.reorgs).toBe(1);
    rows = await (await db.repository("deposits")).find();
    expect(rows.every((d) => d.status === "ORPHANED" && d.confirmations === 0)).toBeTruthy();

    const three = rpc.add(3, 1000);

    three.transactions.push({
      hash: hash(100),
      from: sender,
      to: recipient,
      value: hex(400000000000000n)
    });
    rpc.receiptMap.set(hash(100), {
      blockNumber: hex(3),
      blockHash: three.hash,
      status: "0x1"
    });
    await service.run(base);

    const revived = await (await db.repository("deposits")).findOneByOrFail({tx_hash: hash(100)});

    expect(revived.id).toBe(rows[0].id);
    expect(revived.status).toBe("PENDING");
    expect(revived.block_number).toBe(3);
    rpc.add(4, 1000);
    await service.run(base);
    expect((await (await db.repository("deposits")).findOneByOrFail({id: revived.id})).status).toBe("CONFIRMED");
  } finally {
    await db.onModuleDestroy();
  }
});

test("missing blocks do not advance cursor; deep reorg leaves database unchanged", async () => {
  const db = await database();

  try {
    const base = (await services(db).gates.gate("eth_sepolia"))!,
      cfg = config(),
      rpc = new FakeRpc();

    rpc.add(0);
    rpc.add(1);
    rpc.add(2);

    const service = services(db, undefined, rpc, cfg).indexer;

    await service.run(base);
    rpc.chain.delete(2);
    await expect(service.run(base)).rejects.toThrow(/behind/);
    expect((await (await db.repository("indexer_states")).findOneByOrFail({})).last_block_number).toBe(2);
    rpc.add(0, 100);
    rpc.add(1, 100);
    rpc.add(2, 100);
    await expect(service.run(base)).rejects.toThrow(/manual intervention/);
    expect((await (await db.repository("indexer_states")).findOneByOrFail({})).last_block_hash).toBe(hash(2));
  } finally {
    await db.onModuleDestroy();
  }
});

test("withdrawal tracking checks canonical receipts and returns confirmed withdrawal after reorg", async () => {
  const db = await database();

  try {
    const base = (await services(db).gates.gate("eth_sepolia"))!;

    base.confirmations_required = 2;
    await (await db.repository("gates")).update({id: base.id}, {confirmations_required: 2});

    const rpc = new FakeRpc();

    rpc.add(0);

    const one = rpc.add(1);

    rpc.add(2);
    await (
      await db.repository("withdrawals")
    ).insert({
      idempotency_key: "key",
      asset_gate_id: base.id,
      from_address: sender,
      to_address: recipient,
      amount: "1",
      amount_base_units: "1000000000000000000",
      status: "SIGNED",
      signed_tx: "0x01",
      tx_hash: hash(100)
    });
    rpc.receiptMap.set(hash(100), {
      blockNumber: hex(1),
      blockHash: hash(900),
      status: "0x1"
    });

    const service = services(db, undefined, rpc).indexer;

    await service.run(base);
    expect((await (await db.repository("withdrawals")).findOneByOrFail({})).status).toBe("SIGNED");
    rpc.receiptMap.set(hash(100), {
      blockNumber: hex(1),
      blockHash: one.hash,
      status: "0x1"
    });
    await service.run(base);
    expect((await (await db.repository("withdrawals")).findOneByOrFail({})).status).toBe("CONFIRMED");
    rpc.add(1, 1000);
    rpc.add(2, 1000);
    await service.run(base);

    const row = await (await db.repository("withdrawals")).findOneByOrFail({});

    expect(row.status).toBe("BROADCASTED");
    expect(row.block_number).toBe(null);
  } finally {
    await db.onModuleDestroy();
  }
});
