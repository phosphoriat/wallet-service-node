import "reflect-metadata";
import {WalletQueriesService} from "./application/wallet-queries.service.js";
import {NestFactory} from "@nestjs/core";
import {parseArgs} from "node:util";
import {setTimeout} from "node:timers/promises";
import {AppModule} from "./app.module.js";
import {Database} from "./infrastructure/persistence/database.js";
import {migrate, seed, verify} from "./infrastructure/persistence/schema.js";
import {AddressesService} from "./application/addresses.service.js";
import {WithdrawalsService} from "./application/withdrawals.service.js";
import {IndexerService} from "./application/indexer.service.js";
import {addressResource, withdrawalResource} from "./presentation/http/resources.js";

/** Parses an unsigned safe integer argument or returns its default value. */
function number(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;

  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid integer: ${value}`);

  return Number(value);
}

/** Dispatches CLI commands and closes the application on completion or shutdown. */
async function main() {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {
      base_gate: {type: "string"},
      account: {type: "string"},
      change: {type: "string"},
      index: {type: "string"},
      hot: {type: "boolean"},
      max_blocks: {type: "string"},
      loop: {type: "boolean"},
      sleep: {type: "string"},
      help: {type: "boolean"}
    }
  });
  const command = positionals[0];

  if (values.help || !command) {
    console.log(
      "Commands: db:migrate, db:verify, db:seed, address:create [--base_gate=eth_sepolia --account=0 --change=0 --index=N | --hot], blockchain:index --base_gate=eth_sepolia [--max_blocks=500 --loop --sleep=12], blockchain:rebroadcast ID"
    );

    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"]
  });
  const stop = new AbortController();
  const shutdown = () => stop.abort();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const db = app.get(Database);
    const queries = app.get(WalletQueriesService);

    if (command === "db:migrate") {
      await migrate(await db.connection());
      console.log("Schema created");

      return;
    }

    if (command === "db:verify") {
      await verify(await db.connection());
      console.log("Required columns and unique indexes verified");

      return;
    }

    if (command === "db:seed") {
      await seed(await db.connection());
      console.log("Gates seeded");

      return;
    }

    if (command === "blockchain:rebroadcast") {
      const id = number(positionals[1], 0);

      if (!id) throw new Error("Withdrawal ID required");

      const w = await app.get(WithdrawalsService).rebroadcast(id);
      const gate = await queries.gateById(w.asset_gate_id);

      console.log(withdrawalResource(w, gate!.name));

      return;
    }

    if (!["address:create", "blockchain:index"].includes(command)) throw new Error(`Unknown command ${command}`);

    if (command === "blockchain:index" && !values.base_gate) throw new Error("--base_gate is required");

    const gate = await queries.gate(values.base_gate || "eth_sepolia");

    if (!gate) throw new Error("Gate not found");

    if (command === "address:create") {
      const addresses = app.get(AddressesService);
      const address = values.hot
        ? await addresses.hot(gate)
        : (
            await addresses.create(
              gate,
              number(values.account, 0),
              number(values.change, 0),
              values.index === undefined ? undefined : number(values.index, 0)
            )
          ).address;

      console.log(addressResource(address, gate.name));

      return;
    }

    do {
      try {
        console.log(
          await app
            .get(IndexerService)
            .run(gate, values.max_blocks === undefined ? undefined : number(values.max_blocks, 500))
        );
      } catch (error) {
        if (!values.loop) throw error;

        console.error((error as Error).message);
      }

      if (values.loop && !stop.signal.aborted)
        await setTimeout(Math.max(1, number(values.sleep, 12)) * 1000, undefined, {
          signal: stop.signal
        }).catch(() => {});
    } while (values.loop && !stop.signal.aborted);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await app.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
