import {expect, test} from "@jest/globals";
import {createServer} from "node:http";
import {once} from "node:events";
import {RpcClient} from "../src/infrastructure/blockchain/rpc.client.js";

test("RPC batch orders IDs and rejects missing/malformed responses; sequential fallback works", async () => {
  let mode = "reverse";
  const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) body += chunk;

    const input = JSON.parse(body);
    const reply = (item: {id: number; params: unknown[]}) => ({
      jsonrpc: "2.0",
      id: item.id,
      result: item.params[0]
    });
    let result = Array.isArray(input) ? input.map(reply).reverse() : reply(input);

    if (mode === "missing" && Array.isArray(result)) result.pop();

    if (mode === "malformed" && Array.isArray(result)) delete (result[0] as {result?: unknown}).result;

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;

  try {
    const rpc = new RpcClient(url);
    const calls: [string, unknown[]][] = [
      ["echo", [1]],
      ["echo", [2]]
    ];

    expect(await rpc.batch(calls)).toStrictEqual([1, 2]);
    mode = "missing";
    await expect(rpc.batch(calls)).rejects.toThrow(/Incomplete/);
    mode = "malformed";
    await expect(rpc.batch(calls)).rejects.toThrow(/Missing/);
    mode = "reverse";
    expect(await new RpcClient(url, 1000, false).batch(calls)).toStrictEqual([1, 2]);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
