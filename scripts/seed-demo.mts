import { demoSeedConfig } from "../src/lib/demo-seed-config";

try {
  // Refuse before importing any database or auth code.
  demoSeedConfig();
  const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");
  const result = await loadDemoWorkspace({ id: "demo-seed-cli", role: "admin" }, { mode: "cli" });
  console.log(`Loaded ${result.users} demo user and ${result.links} articles.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Demo seed failed.");
  process.exitCode = 1;
} finally {
  const connection = globalThis as unknown as { sql?: { end(): Promise<void> } };
  await connection.sql?.end();
}
