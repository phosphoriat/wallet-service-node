import {expect, jest, test} from "@jest/globals";
import {database, config, services, recipient} from "./helpers.js";
import {WalletClient} from "../src/infrastructure/wallet/wallet.client.js";
import {RpcFactory} from "../src/infrastructure/blockchain/rpc.client.js";

test("gateway settings stay in infrastructure and are resolved before wallet work", async () => {
  const db = await database();
  const fetch = jest.spyOn(globalThis, "fetch");

  try {
    const gate = (await services(db).gates.gate("eth_sepolia"))!;

    expect(gate).not.toHaveProperty("rpc_url");
    expect(gate).not.toHaveProperty("wallet_gate");
    await (
      await db.repository("gates")
    ).update(
      {id: gate.id},
      {
        wallet_gate: "configured-wallet",
        rpc_url: "http://configured-rpc.invalid"
      }
    );

    const wallet = await new WalletClient(config(), db).forGate(gate);
    const lookup = jest.spyOn(db, "repository");

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({address: recipient}), {status: 200}));
    expect(await wallet.createAddress(0, 0, 1)).toBe(recipient);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      gate: "configured-wallet",
      account: 0,
      change: 0,
      address_index: 1
    });
    expect(lookup).not.toHaveBeenCalled(); // No second DB connection while address allocation holds a transaction.
    lookup.mockRestore();

    const rpc = await new RpcFactory(config(), db).create(gate);

    fetch.mockImplementationOnce(async (_url, options) => {
      const request = JSON.parse(options!.body as string);

      return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: "0x1"}), {status: 200});
    });
    expect(await rpc.blockNumber()).toBe(1);
    expect(fetch.mock.calls[1][0]).toBe("http://configured-rpc.invalid");
  } finally {
    fetch.mockRestore();
    await db.onModuleDestroy();
  }
});
