import {DataSource} from "typeorm";
import {entities} from "../src/infrastructure/persistence/entities.js";
import {Database} from "../src/infrastructure/persistence/database.js";
import {migrate, seed, InitialWalletSchema1794787200000} from "../src/infrastructure/persistence/schema.js";
import {Config} from "../src/infrastructure/config.js";
import {
  TypeOrmAddresses,
  TypeOrmGates,
  TypeOrmWithdrawals,
  TypeOrmIndexStore,
  TypeOrmWalletQueries
} from "../src/infrastructure/persistence/repositories.js";
import {AddressesService} from "../src/application/addresses.service.js";
import {WithdrawalsService} from "../src/application/withdrawals.service.js";
import {IndexerService} from "../src/application/indexer.service.js";
import {WalletQueriesService} from "../src/application/wallet-queries.service.js";
import {SystemClock} from "../src/infrastructure/clock.js";
import {FakeWallet, FakeRpc, factory} from "./doubles.js";

export {FakeWallet, FakeRpc, factory, recipient, sender, hash} from "./doubles.js";

export function config(): Config {
  const result = new Config();

  Object.assign(result.indexer, {start: 1, batchSize: 2, maxBlocks: 500});

  return result;
}

export async function database(): Promise<Database> {
  const source = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: entities(true),
    migrations: [InitialWalletSchema1794787200000],
    synchronize: false
  });

  await source.initialize();
  await source.query("PRAGMA foreign_keys = ON");
  await migrate(source);
  await seed(source);

  const db = Object.create(Database.prototype) as Database;

  Object.defineProperty(db, "source", {value: source});

  const locks = new Map<string, Promise<void>>();

  db.lock = async <T>(
    name: string,
    _timeout: number,
    work: (assertOwned: () => Promise<void>) => Promise<T>
  ): Promise<T> => {
    const before = locks.get(name) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    locks.set(name, current);
    await before;

    try {
      return await work(async () => {});
    } finally {
      release();

      if (locks.get(name) === current) locks.delete(name);
    }
  };

  return db;
}

export function services(db: Database, wallet = new FakeWallet(), rpc = new FakeRpc(), cfg = config()) {
  const gates = new TypeOrmGates(db),
    addressesRepo = new TypeOrmAddresses(db),
    withdrawalsRepo = new TypeOrmWithdrawals(db);
  const addresses = new AddressesService(addressesRepo, wallet, cfg);
  const clock = new SystemClock();

  return {
    gates,
    addresses,
    withdrawals: new WithdrawalsService(withdrawalsRepo, gates, db, addresses, wallet, factory(rpc), cfg, clock),
    indexer: new IndexerService(
      new TypeOrmIndexStore(db),
      gates,
      addressesRepo,
      withdrawalsRepo,
      db,
      cfg,
      factory(rpc),
      clock,
      {error() {}, warn() {}}
    ),
    queries: new WalletQueriesService(gates, new TypeOrmWalletQueries(db))
  };
}
