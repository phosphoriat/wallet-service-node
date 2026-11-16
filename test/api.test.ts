import {WalletQueriesService} from "../src/application/wallet-queries.service.js";
import {services} from "./helpers.js";
import "reflect-metadata";
import {expect, test} from "@jest/globals";
import {randomUUID} from "node:crypto";
import {Module} from "@nestjs/common";
import {NestFactory} from "@nestjs/core";
import {Config} from "../src/infrastructure/config.js";
import {Database} from "../src/infrastructure/persistence/database.js";
import {AddressesService} from "../src/application/addresses.service.js";
import {WithdrawalsService} from "../src/application/withdrawals.service.js";
import {ApiController, HealthController} from "../src/presentation/http/api.controller.js";
import {API_KEY, ApiKeyGuard} from "../src/presentation/http/api-key.guard.js";
import {database, config, FakeWallet, FakeRpc, recipient, sender, hash} from "./helpers.js";

test("HTTP contract: auth, validation, resources, status codes, filters and hidden signed bytes", async () => {
  const db = await database(),
    cfg = config(),
    wallet = new FakeWallet(),
    rpc = new FakeRpc();

  rpc.add(0);
  Object.defineProperty(cfg, "apiKey", {value: "test-secret"});

  const {addresses, withdrawals, queries} = services(db, wallet, rpc, cfg);

  @Module({
    controllers: [ApiController, HealthController],
    providers: [
      ApiKeyGuard,
      {provide: API_KEY, useValue: cfg.apiKey},
      {provide: Config, useValue: cfg},
      {provide: Database, useValue: db},
      {provide: WalletQueriesService, useValue: queries},
      {provide: AddressesService, useValue: addresses},
      {provide: WithdrawalsService, useValue: withdrawals}
    ]
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, {logger: false});

  try {
    await app.listen(0, "127.0.0.1");

    const url = await app.getUrl();
    const get = (path: string) => fetch(url + path, {headers: {"X-Api-Key": "test-secret"}});
    const post = (path: string, body: object, key?: string) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": "test-secret",
          ...(key ? {"Idempotency-Key": key} : {})
        },
        body: JSON.stringify(body)
      });

    expect((await fetch(url + "/up")).status).toBe(200);
    expect((await fetch(url + "/api/addresses")).status).toBe(401);
    expect((await post("/api/addresses", {account: -1})).status).toBe(422);

    const first = await post("/api/addresses", {address_index: 0});

    expect(first.status).toBe(201);

    const data = (await first.json()) as {
      address: {id: number; path: string};
    };

    expect(data.address.path).toBe("m/44'/60'/0'/0/0");
    expect((await post("/api/addresses", {address_index: 0})).status).toBe(200);
    expect(
      (await post("/api/withdrawals", {asset_gate: "eth_sepolia", amount: 1, to_address: recipient}, randomUUID()))
        .status
    ).toBe(422);
    expect(
      (
        await post("/api/withdrawals", {
          asset_gate: "eth_sepolia",
          amount: "1",
          to_address: recipient
        })
      ).status
    ).toBe(422);

    const key = randomUUID(),
      payload = {
        asset_gate: "eth_sepolia",
        amount: "1",
        to_address: recipient
      };
    const created = await post("/api/withdrawals", payload, key);

    expect(created.status).toBe(201);

    const result = (await created.json()) as {withdrawal: {id: number}};

    expect("signed_tx" in result.withdrawal).toBe(false);
    expect((await post("/api/withdrawals", payload, key)).status).toBe(200);

    const conflict = await post("/api/withdrawals", {...payload, amount: "2"}, key);

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      message: "Idempotency-Key was already used for another request",
      error: "Conflict",
      statusCode: 409
    });

    const invalidAmount = await post("/api/withdrawals", {...payload, amount: "0"}, randomUUID());

    expect(invalidAmount.status).toBe(422);
    expect(await invalidAmount.json()).toEqual({
      message: "Amount must be greater than zero",
      errors: {amount: ["Amount must be greater than zero"]}
    });

    const wrongGate = await post("/api/addresses", {
      base_gate: "usdc_sepolia"
    });

    expect(wrongGate.status).toBe(422);
    expect(await wrongGate.json()).toEqual({
      message: "Addresses are created for BASE gate only",
      error: "Unprocessable Entity",
      statusCode: 422
    });
    wallet.valid = false;

    const invalidRecipient = await post("/api/withdrawals", payload, randomUUID());

    expect(invalidRecipient.status).toBe(422);
    expect(await invalidRecipient.json()).toEqual({
      message: "Invalid address",
      errors: {to_address: ["Invalid address"]}
    });
    wallet.valid = true;
    expect((await get(`/api/withdrawals/${result.withdrawal.id}`)).status).toBe(200);

    const missingWithdrawal = await get("/api/withdrawals/9999");

    expect(missingWithdrawal.status).toBe(404);
    expect(await missingWithdrawal.json()).toEqual({
      message: "Withdrawal not found",
      error: "Not Found",
      statusCode: 404
    });

    const listed = (await (await get("/api/withdrawals?asset_gate=ethereum_sepolia&status=BROADCASTED")).json()) as {
      withdrawals: unknown[];
    };

    expect(listed.withdrawals).toHaveLength(1);
    expect(listed.withdrawals[0]).not.toHaveProperty("signed_tx");
    expect(await (await get("/api/withdrawals?status=FAILED")).json()).toEqual({
      withdrawals: []
    });

    const addressList = (await (await get("/api/addresses")).json()) as {
      addresses: {id: number}[];
    };

    expect(addressList.addresses[0].id).toBe(data.address.id);

    const base = (await services(db).gates.gate("eth_sepolia"))!;

    await (
      await db.repository("deposits")
    ).insert({
      asset_gate_id: base.id,
      address_id: data.address.id,
      tx_hash: hash(90),
      log_index: -1,
      from_address: sender,
      to_address: recipient,
      amount: "1",
      amount_base_units: "1000000000000000000",
      block_number: 1,
      block_hash: hash(1),
      status: "CONFIRMED"
    });

    for (const field of ["address", "to_address"]) {
      const matching = (await (await get(`/api/deposits?${field}=${recipient}`)).json()) as {
        deposits: unknown[];
      };

      expect(matching.deposits.length).toBe(1);

      const missing = (await (await get(`/api/deposits?${field}=${sender}`)).json()) as {
        deposits: unknown[];
      };

      expect(missing.deposits.length).toBe(0);
    }
  } finally {
    await app.close();
  }
});
