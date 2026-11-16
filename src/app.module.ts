import {Logger, Module} from "@nestjs/common";
import {Config} from "./infrastructure/config.js";
import {Database} from "./infrastructure/persistence/database.js";
import {
  TypeOrmAddresses,
  TypeOrmGates,
  TypeOrmWithdrawals,
  TypeOrmIndexStore,
  TypeOrmWalletQueries
} from "./infrastructure/persistence/repositories.js";
import {WalletClient} from "./infrastructure/wallet/wallet.client.js";
import {RpcFactory} from "./infrastructure/blockchain/rpc.client.js";
import {SystemClock} from "./infrastructure/clock.js";
import {AddressesService} from "./application/addresses.service.js";
import {WithdrawalsService} from "./application/withdrawals.service.js";
import {IndexerService} from "./application/indexer.service.js";
import {WalletQueriesService} from "./application/wallet-queries.service.js";
import {API_KEY, ApiKeyGuard} from "./presentation/http/api-key.guard.js";
import {ApiController, HealthController} from "./presentation/http/api.controller.js";

/** Composition root: only here are application ports bound to concrete adapters. */
@Module({
  providers: [
    Config,
    Database,
    WalletClient,
    RpcFactory,
    SystemClock,
    ApiKeyGuard,
    {
      provide: API_KEY,
      inject: [Config],
      useFactory: (config: Config) => config.apiKey
    },
    ...[TypeOrmAddresses, TypeOrmGates, TypeOrmWithdrawals, TypeOrmIndexStore, TypeOrmWalletQueries].map(
      (repository) => ({
        provide: repository,
        inject: [Database],
        useFactory: (db: Database) => new repository(db)
      })
    ),
    {
      provide: AddressesService,
      inject: [TypeOrmAddresses, WalletClient, Config],
      useFactory: (addresses: TypeOrmAddresses, wallet: WalletClient, config: Config) =>
        new AddressesService(addresses, wallet, config)
    },
    {
      provide: WithdrawalsService,
      inject: [
        TypeOrmWithdrawals,
        TypeOrmGates,
        Database,
        AddressesService,
        WalletClient,
        RpcFactory,
        Config,
        SystemClock
      ],
      useFactory: (
        withdrawals: TypeOrmWithdrawals,
        gates: TypeOrmGates,
        locks: Database,
        addresses: AddressesService,
        wallet: WalletClient,
        rpc: RpcFactory,
        config: Config,
        clock: SystemClock
      ) => new WithdrawalsService(withdrawals, gates, locks, addresses, wallet, rpc, config, clock)
    },
    {
      provide: IndexerService,
      inject: [
        TypeOrmIndexStore,
        TypeOrmGates,
        TypeOrmAddresses,
        TypeOrmWithdrawals,
        Database,
        Config,
        RpcFactory,
        SystemClock
      ],
      useFactory: (
        store: TypeOrmIndexStore,
        gates: TypeOrmGates,
        addresses: TypeOrmAddresses,
        withdrawals: TypeOrmWithdrawals,
        locks: Database,
        config: Config,
        rpc: RpcFactory,
        clock: SystemClock
      ) =>
        new IndexerService(
          store,
          gates,
          addresses,
          withdrawals,
          locks,
          config,
          rpc,
          clock,
          new Logger(IndexerService.name)
        )
    },
    {
      provide: WalletQueriesService,
      inject: [TypeOrmGates, TypeOrmWalletQueries],
      useFactory: (gates: TypeOrmGates, queries: TypeOrmWalletQueries) => new WalletQueriesService(gates, queries)
    }
  ],
  controllers: [ApiController, HealthController]
})
export class AppModule {}
