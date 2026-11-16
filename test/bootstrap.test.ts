import "reflect-metadata";
import {expect, test} from "@jest/globals";
import {NestFactory} from "@nestjs/core";
import {AppModule} from "../src/app.module.js";

test("production module starts and exposes health without external service calls", async () => {
  const app = await NestFactory.create(AppModule, {logger: false});

  try {
    await app.listen(0, "127.0.0.1");

    const response = await fetch((await app.getUrl()) + "/up");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({status: "ok"});
  } finally {
    await app.close();
  }
});
