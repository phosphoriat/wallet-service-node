import {expect, test} from "@jest/globals";
import {WithdrawalAggregate, type Signature} from "../src/domain/withdrawal.js";
import {DepositAggregate} from "../src/domain/deposit.js";
import type {Gate, Withdrawal} from "../src/domain/models.js";
import {hash, recipient, sender} from "./doubles.js";

const gate: Gate = {
  id: 1,
  name: "eth",
  chain_id: 1,
  confirmations_required: 2,
  parent_gate_id: null,
  asset_type: "NATIVE",
  token_contract: null,
  token_decimals: null
};

const signature: Signature = {
  nonce: 0,
  gas_limit: 21000,
  max_fee_per_gas_wei: "20",
  max_priority_fee_per_gas_wei: "1",
  signed_tx: "0x01",
  tx_hash: hash(100)
};

function snapshot(): Withdrawal {
  return {
    ...WithdrawalAggregate.create(gate, sender, recipient, "1", "key").newRecord(),
    id: 1
  };
}

test.each(["SIGNED", "BROADCASTED", "CONFIRMED", "FAILED"] as const)("signing is forbidden after %s", (status) => {
  const aggregate = WithdrawalAggregate.rehydrate({
    ...snapshot(),
    status,
    signed_tx: "0x01",
    tx_hash: hash(100)
  });

  expect(() => aggregate.sign(sender, signature)).toThrow("Only CREATED");
  expect(aggregate.state.status).toBe(status);
});

test("snapshots cannot mutate aggregate identity or state, including mutable Date values", () => {
  const at = new Date("2026-01-01T00:00:00Z");
  const original = {...snapshot(), broadcasted_at: at};
  const aggregate = WithdrawalAggregate.rehydrate(original);

  original.status = "CONFIRMED";
  at.setUTCFullYear(2000);
  expect(aggregate.state.status).toBe("CREATED");
  expect(() => Object.assign(aggregate.state, {status: "CONFIRMED"})).toThrow();
  (aggregate.state.broadcasted_at as Date).setUTCFullYear(2001);
  expect((aggregate.state.broadcasted_at as Date).getUTCFullYear()).toBe(2026);
  expect(() =>
    Object.defineProperty(aggregate, "state", {
      value: {status: "CONFIRMED"}
    })
  ).toThrow();
  expect(() => Reflect.construct(WithdrawalAggregate, [snapshot(), true, Symbol()])).toThrow("Use aggregate factories");
});

test("signature input cannot smuggle identity or unrelated state changes", () => {
  const aggregate = WithdrawalAggregate.rehydrate(snapshot());

  aggregate.sign(sender, {
    ...signature,
    id: 999,
    asset_gate_id: 999,
    status: "CONFIRMED",
    amount: "0"
  } as Signature);
  expect(aggregate.state).toMatchObject({
    id: 1,
    asset_gate_id: 1,
    amount: "1",
    status: "SIGNED"
  });
});

test.each([
  [{message: "timeout", code: null}, "SIGNED"],
  [{message: "nonce too low", code: -32000}, "SIGNED"],
  [{message: "already known", code: -32000}, "BROADCASTED"],
  [{message: "insufficient funds", code: -32000}, "FAILED"],
  [{hash: hash(999)}, "SIGNED"],
  [{hash: hash(100)}, "BROADCASTED"]
] as const)("broadcast outcome %j retains its previous semantics", (result, status) => {
  const aggregate = WithdrawalAggregate.rehydrate(snapshot());

  aggregate.sign(sender, signature);
  aggregate.recordBroadcast(result, "now");
  expect(aggregate.state.status).toBe(status);
  expect(aggregate.state.signed_tx).toBe("0x01");
});

test("only canonical receipts affect signed withdrawals; terminal outcomes ignore late receipts", () => {
  const aggregate = WithdrawalAggregate.rehydrate(snapshot());

  aggregate.sign(sender, signature);
  aggregate.applyReceipt({number: 1, hash: hash(1), canonicalHash: hash(2), status: "0x1"}, 2, 2, "now");
  expect(aggregate.state.status).toBe("SIGNED");
  aggregate.applyReceipt({number: 3, hash: hash(3), canonicalHash: hash(3), status: "0x1"}, 2, 2, "now");
  expect(aggregate.state.status).toBe("SIGNED");
  aggregate.applyReceipt({number: 1, hash: hash(1), canonicalHash: hash(1), status: "0x1"}, 2, 2, "now");
  expect(aggregate.state.status).toBe("CONFIRMED");
  aggregate.applyReceipt({number: 1, hash: hash(1), canonicalHash: hash(1), status: "0x0"}, 2, 2, "later");
  expect(aggregate.state.status).toBe("CONFIRMED");
  aggregate.orphanAbove(1);
  expect(aggregate.state.status).toBe("CONFIRMED");
  aggregate.orphanAbove(0);
  expect(aggregate.state).toMatchObject({
    status: "BROADCASTED",
    block_number: null,
    confirmed_at: null,
    error: null
  });
});

test("orphaned deposits cannot confirm until reobserved, and identity survives revival", () => {
  const observation = DepositAggregate.observe(gate, 7, hash(10), -1, sender, recipient, "1", 1, hash(1), 2, "now");
  const deposit = DepositAggregate.rehydrate({
    ...observation.newRecord(),
    id: 8
  });

  deposit.orphanAbove(0);
  deposit.confirm(100, 2, "later");
  expect(deposit.state).toMatchObject({
    id: 8,
    status: "ORPHANED",
    confirmations: 0,
    confirmed_at: null
  });

  const other = DepositAggregate.observe(gate, 7, hash(11), -1, sender, recipient, "1", 3, hash(3), 3, "later");

  expect(() => deposit.reobserve(other)).toThrow("identity cannot change");
  deposit.reobserve(DepositAggregate.observe(gate, 7, hash(10), -1, sender, recipient, "1", 3, hash(3), 3, "later"));
  expect(deposit.state).toMatchObject({
    id: 8,
    status: "PENDING",
    block_number: 3
  });
  deposit.confirm(4, 2, "confirmed");
  expect(deposit.state).toMatchObject({
    id: 8,
    status: "CONFIRMED",
    confirmed_at: "confirmed"
  });
  expect(() => deposit.newRecord()).toThrow();
});

test("reorganization intent rejects excessive depth and a stale or fabricated checkpoint", async () => {
  const {ChainReorganization} = await import("../src/domain/chain-index.js");
  const source = {
    gate_id: 1,
    last_block_number: 10,
    last_block_hash: hash(10)
  };
  const target = {gate_id: 1, last_block_number: 5, last_block_hash: hash(5)};

  expect(() => ChainReorganization.plan(source, target, hash(5), 4)).toThrow("manual intervention");
  expect(() => ChainReorganization.plan(source, target, hash(6), 10)).toThrow("Invalid canonical ancestor");

  const command = ChainReorganization.plan(source, target, hash(5), 10);

  expect(() => command.assertCurrent({...source, last_block_number: 11})).toThrow("Checkpoint");
  expect(() => Object.assign(command.target(), {last_block_number: 0})).toThrow();
});
