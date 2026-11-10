/**
 * Runs once when a server instance starts. With MIGRATE_ON_START=true it applies
 * pending database migrations before the server takes traffic. A Postgres advisory
 * lock makes it safe when several instances start at once.
 *
 * The job worker starts after that, on the timer (Azure Container Apps keeps CPU
 * between requests). `next build` sets NEXT_PHASE and must not open a database pool.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.MIGRATE_ON_START === "true") {
    const { migrateOnStart } = await import("./lib/db/migrate-on-start");
    await migrateOnStart();
  }
  const { migrationState } = await import("./lib/db/migrate-on-start");
  const { startJobs } = await import("./lib/jobs/start");
  const state = migrationState();
  // Migrations still retrying in the background: don't block startup (health stays 503). The worker
  // starts once they succeed. Otherwise start now.
  if (state === "running" || state === "retrying") {
    void startJobs();
    return;
  }
  await startJobs();
}
