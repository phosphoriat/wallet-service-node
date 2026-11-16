import "reflect-metadata";
import {NestFactory} from "@nestjs/core";
import {AppModule} from "./app.module.js";
import {Config} from "./infrastructure/config.js";

/** Starts the HTTP application with configured binding and shutdown hooks. */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();
  await app.listen(app.get(Config).port, process.env.HOST || "127.0.0.1");
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
