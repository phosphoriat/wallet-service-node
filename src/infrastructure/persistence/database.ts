import {InitialWalletSchema1794787200000} from "./schema.js";
import {Injectable, type OnModuleDestroy} from "@nestjs/common";
import {DataSource, type Repository} from "typeorm";
import {createHash} from "node:crypto";
import type {Lock} from "../../application/ports/runtime.js";
import {entities, type Tables} from "./entities.js";

/** Creates a lazy MySQL data source with schema synchronization disabled. */
export function mysqlSource(poolSize = 12): DataSource {
  return new DataSource({
    type: "mysql",
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_DATABASE || "gates",
    username: process.env.DB_USERNAME || "gates",
    password: process.env.DB_PASSWORD || "",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: false,
    poolSize,
    connectTimeout: 30000,
    entities: entities(),
    migrations: [InitialWalletSchema1794787200000],
    synchronize: false,
    migrationsRun: false
  });
}

/** Owns lazy data-source initialization and connection-scoped advisory locks. */
@Injectable()
export class Database implements OnModuleDestroy, Lock {
  readonly source: DataSource;
  private readonly lockSource: DataSource;
  private initialization?: Promise<DataSource>;
  private lockInitialization?: Promise<DataSource>;

  constructor() {
    this.source = mysqlSource();

    // Waiting for advisory locks must not consume the query pool.
    this.lockSource = mysqlSource(4);
  }

  /** Initializes the query data source once, permitting retries after connection failure. */
  async connection(): Promise<DataSource> {
    if (this.source.isInitialized) return this.source;

    return (this.initialization ??= this.source.initialize().catch((error) => {
      this.initialization = undefined;
      throw error;
    }));
  }

  /** Resolves a typed TypeORM repository after ensuring the data source is ready. */
  async repository<K extends keyof Tables>(name: K): Promise<Repository<Tables[K]>> {
    return (await this.connection()).getRepository<Tables[K]>(name);
  }

  /** Waits for pending initialization and closes all initialized connection pools. */
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.initialization, this.lockInitialization]);
    await Promise.all(
      [this.source, this.lockSource].filter((source) => source?.isInitialized).map((source) => source.destroy())
    );
  }

  /**
   * Uses one dedicated connection for lock acquisition, ownership checks and release.
   *
   * @param name Logical lock identity, namespaced by the configured database.
   * @param timeout Maximum lock-acquisition wait, in seconds.
   * @param work Operation receiving a function that checks ownership before persistence or broadcast.
   */
  async lock<T>(name: string, timeout: number, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
    const source = this.lockSource.isInitialized
      ? this.lockSource
      : await (this.lockInitialization ??= this.lockSource.initialize().catch((error) => {
          this.lockInitialization = undefined;
          throw error;
        }));
    const runner = source.createQueryRunner();

    await runner.connect();

    const key = createHash("sha256")
      .update(`${process.env.DB_DATABASE || "gates"}:${name}`)
      .digest("hex");
    let acquired = false;

    try {
      const rows = await runner.query("SELECT GET_LOCK(?, ?) AS acquired", [key, timeout]);

      acquired = Number(rows[0].acquired) === 1;

      if (!acquired) throw new Error(`Could not acquire lock: ${name}`);

      return await work(async () => {
        const owners = await runner.query("SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned", [key]);

        if (Number(owners[0].owned) !== 1) throw new Error(`Lost lock: ${name}`);
      });
    } finally {
      try {
        if (acquired) {
          const rows = await runner.query("SELECT RELEASE_LOCK(?) AS released", [key]);

          if (Number(rows[0].released) !== 1) throw new Error(`Could not release lock: ${name}`);
        }
      } catch (error) {
        // Never return a connection that may still own a named lock to the pool.
        const connection = await runner.connect();

        connection.destroy();
        throw error;
      } finally {
        await runner.release();
      }
    }
  }
}
