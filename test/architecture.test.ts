import {expect, test} from "@jest/globals";
import {readdirSync, readFileSync} from "node:fs";
import {join, relative, resolve, dirname} from "node:path";

function sources(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("domain and application dependencies point inward and contain no infrastructure access", () => {
  const root = resolve("src");
  const violations: string[] = [];

  for (const layer of ["domain", "application"]) {
    for (const file of sources(join(root, layer))) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(/(?:from\s*|import\s*\(|import\s*)['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        const target = relative(root, resolve(dirname(file), specifier)).split("/")[0];
        const allowed = layer === "domain" ? ["domain"] : ["domain", "application"];

        if (!specifier.startsWith(".") || !allowed.includes(target))
          violations.push(`${relative(root, file)} -> ${specifier}`);
      }

      if (/\b(?:fetch|require)\s*\(|\bprocess\.env|\.sql\b/.test(source))
        violations.push(`${relative(root, file)} accesses infrastructure directly`);
    }
  }

  expect(violations).toEqual([]);
});

test("write ports expose aggregate operations and application code does not assign statuses", () => {
  const ports = readFileSync(resolve("src/application/ports/repositories.ts"), "utf8");

  expect(ports).not.toMatch(/Partial<Withdrawal>|NewWithdrawal|\bupdate\s*\(/);
  expect(ports).toContain("aggregate: WithdrawalAggregate");

  const application = sources(resolve("src/application"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  expect(application).not.toMatch(
    /status\s*:\s*['"](?:CREATED|SIGNED|BROADCASTED|CONFIRMED|FAILED|PENDING|ORPHANED)['"]/
  );

  const models = readFileSync(resolve("src/domain/models.ts"), "utf8");

  expect(models).not.toMatch(/rpc_url|wallet_gate/);
});
