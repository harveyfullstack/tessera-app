import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";
import { createHttpHandler } from "./handler";

const jobRecords = new JobRecordService(new InMemoryJobRepository());
const budgets: unknown = JSON.parse(process.env.DELIVERY_RETRY_BUDGETS ?? "{}");
if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
  throw new Error("DELIVERY_RETRY_BUDGETS must be an account-to-budget JSON object");
}
for (const [accountId, budget] of Object.entries(budgets)) {
  if (typeof budget !== "number") throw new Error("Retry budgets must be numbers");
  await jobRecords.setRetryBudget(accountId, budget);
}
for (const accountId of (process.env.DELIVERY_SPLIT_ACCOUNTS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
  await jobRecords.execution.setEnabled(accountId, true);
}

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch: createHttpHandler(jobRecords, "tessera-demo-account"),
});
