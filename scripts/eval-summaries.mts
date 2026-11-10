/**
 * Live evals for the `summarize-link` task: runs the pages in test/fixtures/pages/ through the real model and checks
 * each against the spec's expectations. By hand, not in CI (CI runs the same cases against a stub in test/ai-evals.test.ts).
 *
 *   AI_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval:summaries
 *
 * Exits non-zero without a key (it never falls back to the demo fixture) and when any case fails.
 * Prints verdicts and short samples of the model's output; paste the verdict lines into the run log.
 */
const provider = process.env.AI_PROVIDER;
const keyName = provider === "gemini" ? "GEMINI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : null;

if (!keyName || !process.env[keyName]) {
  console.error("eval:summaries needs a live model: set AI_PROVIDER=gemini and GEMINI_API_KEY (or AI_PROVIDER=anthropic and ANTHROPIC_API_KEY).");
  process.exit(1);
}

// The gateway reads these even though the evals never touch the database or sign anyone in.
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.BETTER_AUTH_SECRET ??= "eval-only-secret-not-used-for-anything-0123456789";
process.env.AI_FALLBACK_TO_DEMO = "false"; // a failing model must fail the eval, not pass on the recorded answer
process.env.LOG_LEVEL ??= "warn";

const { PAGES, articleOf, qualityFailures, safetyFailures } = await import("../test/fixtures/pages/index");
const { summarizeArticle } = await import("../src/lib/summaries/task");

let failed = 0;
for (const p of PAGES) {
  try {
    const out = await summarizeArticle(articleOf(p), p.existingTags);
    const problems = [...safetyFailures(p, out), ...qualityFailures(p, out)];
    const verdict = problems.length === 0 ? "PASS" : "FAIL";
    if (problems.length > 0) failed += 1;
    console.log(`${verdict} ${p.id} mode=${out.mode}${out.mode === "skipped" ? "" : ` kind=${out.data.kind} lowQuality=${out.data.lowQuality} tags=${out.data.tags.join(",")} codes=${out.codes.join(",") || "-"}`}`);
    if (out.mode !== "skipped") console.log(`     summary: ${out.data.summary.slice(0, 200)}`);
    for (const problem of problems) console.log(`     - ${problem}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${p.id} error=${err instanceof Error ? err.name : "unknown"}`);
  }
}
console.log(failed === 0 ? `\nAll ${PAGES.length} eval pages passed.` : `\n${failed} of ${PAGES.length} eval pages failed.`);
process.exit(failed === 0 ? 0 : 1);
