import {WithdrawalAggregate} from "../src/domain/withdrawal.js";
import {RpcError} from "../src/application/ports/blockchain.js";
import {expect, jest, test} from "@jest/globals";
import type {Gate, Withdrawal} from "../src/domain/models.js";
import type {Gates, Withdrawals, Addresses} from "../src/application/ports/repositories.js";
import type {ApplicationOptions, Lock} from "../src/application/ports/runtime.js";
import {AddressesService} from "../src/application/addresses.service.js";
import {WithdrawalsService} from "../src/application/withdrawals.service.js";
import {FakeWallet, FakeRpc, factory, recipient} from "./doubles.js";

// This fixture has no NestJS container, database, environment variables or HTTP clients.
function fixture() {
  const gate: Gate = {
    id: 1,
    name: "eth",
    parent_gate_id: null,
    asset_type: "NATIVE",
    chain_id: 1,
    confirmations_required: 2,
    token_contract: null,
    token_decimals: null
  };
  const options: ApplicationOptions = {
    hot: {account: 1, change: 0, address_index: 0},
    fees: {gasPercent: 120, multiplier: 2, minPriority: "1000000000"},
    indexer: {
      start: 1,
      batchSize: 2,
      maxBlocks: 500,
      keepBlocks: 256,
      maxReorgDepth: 128,
      addressChunk: 200,
      withdrawalsPerRun: 100
    }
  };
  const wallet = new FakeWallet(),
    rpc = new FakeRpc();

  rpc.add(0);

  const rows = new Map<number, Withdrawal>();
  const withdrawals: Withdrawals = {
    find: async (id) => rows.get(id),
    byKey: async (key) => [...rows.values()].find((row) => row.idempotency_key === key),
    create: async (aggregate) => {
      const row = {...aggregate.newRecord(), id: rows.size + 1};

      rows.set(row.id, row);

      return row;
    },
    change: async (id, operation) => {
      const aggregate = WithdrawalAggregate.rehydrate(rows.get(id)!);

      operation(aggregate);

      const row = {...aggregate.state};

      rows.set(id, row);

      return row;
    },
    highestReservedNonce: async () => null,
    pending: async () => []
  };
  const gates: Gates = {
    gate: async () => gate,
    byId: async () => gate,
    base: async () => gate,
    children: async () => []
  };
  const addressRepo: Addresses = {
    forGate: async () => [],
    allocate: async (book, create) => ({
      created: true,
      address: {
        id: 1,
        gate_id: book.gate.id,
        account: book.path.account,
        change: book.path.change,
        address_index: 0,
        address: await create(0)
      }
    })
  };
  const locks: Lock = {
    lock: async (_name, _timeout, work) => work(async () => {})
  };
  const service = new WithdrawalsService(
    withdrawals,
    gates,
    locks,
    new AddressesService(addressRepo, wallet, options),
    wallet,
    factory(rpc),
    options,
    {now: () => "2026-01-01 00:00:00.000"}
  );

  return {gate, wallet, rpc, rows, withdrawals, locks, service};
}

test("application persists a signature before broadcast and never overwrites concurrent confirmation", async () => {
  const {service, gate, rpc, rows} = fixture();
  const call = rpc.call.bind(rpc);

  jest.spyOn(rpc, "call").mockImplementation(async <T>(method: string, params: unknown[] = []): Promise<T> => {
    if (method === "eth_sendRawTransaction") {
      const saved = rows.get(1)!;

      expect(saved.status).toBe("SIGNED");
      expect(saved.signed_tx).toBe(params[0]);
      rows.set(1, {...saved, status: "CONFIRMED"});
    }

    return call<T>(method, params);
  });

  const result = await service.create(gate, recipient, "1", "key");

  expect(result.withdrawal.status).toBe("CONFIRMED");
});

test("loss of lock after persistence keeps SIGNED bytes and prevents broadcast", async () => {
  const {service, gate, locks, rows, rpc} = fixture();

  locks.lock = async (name, _timeout, work) => {
    let checks = 0;

    return work(async () => {
      if (name.startsWith("nonce:") && ++checks === 2) throw new Error("Lost lock");
    });
  };
  await expect(service.create(gate, recipient, "1", "key")).rejects.toThrow("Lost lock");
  expect(rows.get(1)).toMatchObject({status: "SIGNED", signed_tx: "0x01"});
  expect(rpc.broadcasts).toHaveLength(0);
});

test("invalid amount fails before persistence or signing", async () => {
  const {service, gate, rows, wallet} = fixture();

  await expect(service.create(gate, recipient, "-1", "key")).rejects.toMatchObject({
    kind: "validation",
    errors: {amount: expect.any(Array)}
  });
  expect(rows.size).toBe(0);
  expect(wallet.signatures).toHaveLength(0);
});

test.each([
  ["suggested priority", "0x77359400", "2000000000"],
  ["unavailable suggestion", null, "1000000000"]
])("fee policy preserves decimal precision with %s", async (_name, suggestion, expected) => {
  const {service, gate, rpc, wallet} = fixture();
  const call = rpc.call.bind(rpc);

  jest.spyOn(rpc, "call").mockImplementation(async <T>(method: string, params: unknown[] = []): Promise<T> => {
    if (method === "eth_maxPriorityFeePerGas") {
      if (suggestion === null) throw new RpcError("not supported", -32601);

      return suggestion as T;
    }

    return call<T>(method, params);
  });
  await service.create(gate, recipient, "1", "key");
  expect(wallet.signatures[0].max_priority_fee_per_gas_wei).toBe(expected);
  expect(wallet.signatures[0].max_fee_per_gas_wei).toBe((BigInt(expected) + 20n).toString());
});
