import {services} from "./helpers.js";
import "reflect-metadata";
import {expect, test} from "@jest/globals";
import {randomUUID} from "node:crypto";
import {RpcError} from "../src/application/ports/blockchain.js";
import {database, config, FakeWallet, FakeRpc, recipient} from "./helpers.js";

test("addresses allocate sequentially, exact paths are idempotent, asset gate rejected", async () => {
  const db = await database();

  try {
    const wallet = new FakeWallet(),
      service = services(db, wallet).addresses,
      gate = (await services(db).gates.gate("eth_sepolia"))!;
    const first = await service.create(gate);

    expect(first.address.address_index).toBe(0);
    expect(first.created).toBe(true);

    const same = await service.create(gate, 0, 0, 0);

    expect(same.address.id).toBe(first.address.id);
    expect(same.created).toBe(false);
    expect(wallet.calls).toBe(1);
    expect((await service.create(gate)).address.address_index).toBe(1);
    expect((await service.hot(gate)).account).toBe(1);
    await expect(service.create((await services(db).gates.gate("usdc_sepolia"))!)).rejects.toThrow();
    await expect(service.create(gate, -1)).rejects.toThrow();
  } finally {
    await db.onModuleDestroy();
  }
});

test("withdrawal idempotency, conflicts, EIP1559 params, shared native/token nonce", async () => {
  const db = await database();

  try {
    const cfg = config(),
      wallet = new FakeWallet(),
      rpc = new FakeRpc();

    rpc.add(0);

    const service = services(db, wallet, rpc, cfg).withdrawals;
    const gate = (await services(db).gates.gate("eth_sepolia"))!,
      key = randomUUID();
    const first = await service.create(gate, recipient, "0.0004", key);

    expect(first.withdrawal.status).toBe("BROADCASTED");
    expect(first.created).toBe(true);
    expect(first.withdrawal.nonce).toBe(0);
    expect(wallet.signatures[0].value_wei).toBe("400000000000000");
    expect(wallet.signatures[0].gas_limit).toBe(25200);
    expect(wallet.signatures[0].max_fee_per_gas_wei).toBe("1000000020");

    const replay = await service.create(gate, recipient, "0.000400", key);

    expect(replay.withdrawal.id).toBe(first.withdrawal.id);
    expect(replay.created).toBe(false);
    expect(wallet.signatures.length).toBe(1);
    await expect(service.create(gate, recipient, "1", key)).rejects.toThrow(/Idempotency/);

    const token = await service.create(
      (await services(db).gates.gate("usdc_sepolia"))!,
      recipient,
      "100",
      randomUUID()
    );

    expect(token.withdrawal.nonce).toBe(1);
    expect(wallet.signatures[1].value_wei).toBe("0");
    expect(wallet.signatures[1].data).toMatch(/^0xa9059cbb/);
  } finally {
    await db.onModuleDestroy();
  }
});

test("unknown broadcast persists signature, reserves nonce, rebroadcasts identical bytes", async () => {
  const db = await database();

  try {
    const cfg = config(),
      wallet = new FakeWallet(),
      rpc = new FakeRpc();

    rpc.add(0);
    rpc.broadcastError = new RpcError("timeout");

    const service = services(db, wallet, rpc, cfg).withdrawals,
      gate = (await services(db).gates.gate("eth_sepolia"))!;
    const first = await service.create(gate, recipient, "1", randomUUID());

    expect(first.withdrawal.status).toBe("SIGNED");
    expect(first.withdrawal.signed_tx).toBeTruthy();

    const second = await service.create(gate, recipient, "2", randomUUID());

    expect(second.withdrawal.nonce).toBe(1);
    rpc.broadcastError = new RpcError("already known", -32000);
    expect((await service.rebroadcast(first.withdrawal.id)).status).toBe("BROADCASTED");
    expect(rpc.broadcasts[0]).toBe(rpc.broadcasts[2]);
    expect(wallet.signatures.length).toBe(2);
  } finally {
    await db.onModuleDestroy();
  }
});

test("signer failures and signer mismatch never broadcast", async () => {
  const db = await database();

  try {
    const cfg = config(),
      wallet = new FakeWallet(),
      rpc = new FakeRpc();

    rpc.add(0);
    wallet.failSign = true;

    const service = services(db, wallet, rpc, cfg).withdrawals,
      gate = (await services(db).gates.gate("eth_sepolia"))!;

    await expect(service.create(gate, recipient, "1", randomUUID())).rejects.toThrow(/Signer unavailable/);
    wallet.failSign = false;
    wallet.signer = recipient;
    await expect(service.create(gate, recipient, "2", randomUUID())).rejects.toThrow(/Signer address mismatch/);

    const rows = await (await db.repository("withdrawals")).find();

    expect(rows.every((w) => w.status === "FAILED")).toBeTruthy();
    expect(rpc.broadcasts.length).toBe(0);
  } finally {
    await db.onModuleDestroy();
  }
});

test("concurrent identical idempotency key signs once", async () => {
  const db = await database();

  try {
    const cfg = config(),
      wallet = new FakeWallet(),
      rpc = new FakeRpc();

    rpc.add(0);

    const service = services(db, wallet, rpc, cfg).withdrawals,
      gate = (await services(db).gates.gate("eth_sepolia"))!,
      key = randomUUID();
    const results = await Promise.all([
      service.create(gate, recipient, "1", key),
      service.create(gate, recipient, "1", key)
    ]);

    expect(results[0].withdrawal.id).toBe(results[1].withdrawal.id);
    expect(wallet.signatures.length).toBe(1);
  } finally {
    await db.onModuleDestroy();
  }
});
