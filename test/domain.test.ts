import {expect, test} from "@jest/globals";
import {Amount} from "../src/domain/amount.js";
import {DerivationPath} from "../src/domain/derivation-path.js";
import {WithdrawalAggregate} from "../src/domain/withdrawal.js";
import {DepositAggregate} from "../src/domain/deposit.js";
import type {Gate, Withdrawal} from "../src/domain/models.js";
import {ValidationError} from "../src/domain/errors.js";

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

const withdrawal: Withdrawal = {
  ...WithdrawalAggregate.create(gate, "sender", "recipient", "1", "key").newRecord(),
  id: 1,
  nonce: null,
  gas_limit: null,
  max_fee_per_gas_wei: null,
  max_priority_fee_per_gas_wei: null,
  signed_tx: null,
  tx_hash: null,
  block_number: null,
  error: null,
  broadcasted_at: null,
  confirmed_at: null
};

test("amounts retain precision and equivalent decimal strings have the same units", () => {
  expect(new Amount("0.000400", 18).baseUnits).toBe(new Amount("0.0004", 18).baseUnits);
  expect(() => new Amount("0.0000000000000000001", 18)).toThrow(/decimal places/);
  expect(Object.isFrozen(new Amount("1", 18))).toBe(true);
  expect(() => WithdrawalAggregate.amount(gate, "0")).toThrow(ValidationError);
});

test("derivation allocation respects explicit indexes and exhaustion", () => {
  expect(new DerivationPath(0, 0).allocate(null)).toBe(0);
  expect(new DerivationPath(0, 0).allocate(4)).toBe(5);
  expect(new DerivationPath(0, 0, 2).allocate(4)).toBe(2);
  expect(() => new DerivationPath(0, 0).allocate(0x7fffffff)).toThrow(/exhausted/);
  expect(() => new DerivationPath(-1, 0)).toThrow(ValidationError);
});

test("withdrawal identity includes gate, normalized recipient and exact base units", () => {
  const aggregate = WithdrawalAggregate.rehydrate(withdrawal);

  expect(() => aggregate.assertSameRequest(gate, "RECIPIENT", withdrawal.amount_base_units)).not.toThrow();
  expect(() => aggregate.assertSameRequest({...gate, id: 2}, "recipient", withdrawal.amount_base_units)).toThrow(
    /Idempotency/
  );
  expect(() => aggregate.assertSameRequest(gate, "another", withdrawal.amount_base_units)).toThrow(/Idempotency/);
  expect(() => aggregate.assertSameRequest(gate, "recipient", "1")).toThrow(/Idempotency/);
});

test("a persisted signature cannot be marked safely failed or recreated for retry", () => {
  const created = WithdrawalAggregate.rehydrate(withdrawal);

  created.failBeforeSigning("signer down");
  expect(created.state).toMatchObject({
    status: "FAILED",
    error: "signer down"
  });
  expect(() => created.assertRebroadcastable()).toThrow(/Only SIGNED/);

  const signed = WithdrawalAggregate.rehydrate({
    ...withdrawal,
    status: "SIGNED",
    signed_tx: "0x01"
  });

  signed.failBeforeSigning("network unknown");
  expect(signed.state.status).toBe("SIGNED");
  expect(() => signed.assertRebroadcastable()).not.toThrow();
  expect(() =>
    WithdrawalAggregate.rehydrate({
      ...withdrawal,
      status: "CONFIRMED",
      signed_tx: "0x01"
    }).assertRebroadcastable()
  ).toThrow();
});

test("receipt outcomes preserve broadcast time, confirmation threshold and reverted error", () => {
  const aggregate = WithdrawalAggregate.rehydrate({
    ...withdrawal,
    status: "SIGNED",
    broadcasted_at: "earlier"
  });
  const receipt = {
    number: 10,
    hash: "block",
    canonicalHash: "block",
    status: "0x1"
  };

  aggregate.applyReceipt(receipt, 10, 2, "now");
  expect(aggregate.state).toMatchObject({
    status: "BROADCASTED",
    confirmed_at: null,
    broadcasted_at: "earlier"
  });
  aggregate.applyReceipt(receipt, 11, 2, "now");
  expect(aggregate.state).toMatchObject({
    status: "CONFIRMED",
    confirmed_at: "now"
  });

  const failed = WithdrawalAggregate.rehydrate({
    ...withdrawal,
    status: "SIGNED"
  });

  failed.applyReceipt({...receipt, status: "0x0"}, 11, 2, "now");
  expect(failed.state).toMatchObject({
    status: "FAILED",
    error: "Transaction reverted on-chain",
    confirmed_at: null
  });
});

test("observed deposits normalize identity and apply asset decimals and confirmations", () => {
  const token = {...gate, asset_type: "ERC20" as const, token_decimals: 6};
  const pending = DepositAggregate.observe(token, 7, "TX", 0, "FROM", "TO", "100000000", 10, "HASH", 10, "now");

  expect(pending.state).toMatchObject({
    amount: "100",
    tx_hash: "tx",
    from_address: "from",
    to_address: "to",
    block_hash: "hash",
    status: "PENDING",
    confirmations: 1,
    confirmed_at: null
  });
  expect(
    DepositAggregate.observe(token, 7, "TX", 0, "FROM", "TO", "100000000", 10, "HASH", 11, "now").state
  ).toMatchObject({status: "CONFIRMED", confirmed_at: "now"});
});

test("fee and nonce policies use exact arithmetic and reserve ambiguous broadcasts", async () => {
  const {nextNonce, transactionFees} = await import("../src/domain/transaction-policy.js");

  expect(nextNonce(1, 4)).toBe(5);
  expect(nextNonce(10, 4)).toBe(10);
  expect(() => nextNonce(0, Number.MAX_SAFE_INTEGER)).toThrow();
  expect(
    transactionFees("0x5208", "0xa", "1", {
      gasPercent: 120,
      multiplier: 2,
      minPriority: "1000000000"
    })
  ).toEqual({
    gas_limit: 25200,
    max_fee_per_gas_wei: "1000000020",
    max_priority_fee_per_gas_wei: "1000000000"
  });
});
