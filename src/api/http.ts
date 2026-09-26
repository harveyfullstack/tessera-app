import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DeliveryAttemptRpc } from "../application/delivery-attempt-rpc";
import { JobRecordService } from "../application/job-record-service";
import { DrainDlqProcessor } from "../application/drain-dlq-processor";
import { createRetryBudgetResolver } from "../application/retry-budget";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";
import type { JobStatus } from "../domain/job";

const jobs = new InMemoryJobRepository();
const attempts = new InMemoryDeliveryAttemptRepository();
const deliveryAttemptRpc = new DeliveryAttemptRpc(
  jobs,
  attempts,
  (accountId) =>
    (process.env.WEBHOOK_DELIVERY_ROLLBACK_ACCOUNT_IDS ?? "")
      .split(",")
      .some((configuredAccountId) => configuredAccountId.trim() === accountId),
);
const jobRecords = new JobRecordService(jobs, deliveryAttemptRpc);
const drainDlq = new DrainDlqProcessor(
  jobs,
  attempts,
  deliveryAttemptRpc,
  createRetryBudgetResolver(
    process.env.WEBHOOK_DELIVERY_RETRY_BUDGETS ?? "",
  ),
);
const delivery = new DeliveryOrchestrator(jobRecords);

interface DeliverBody {
  briefId: string;
  customerId: string;
  subscriptionId: string;
  endpointUrl: string;
  eventType: string;
  payloadHash: string;
  workerId: string;
  simulateFailure?: boolean;
}

const accountId = "tessera-demo-account";

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.startsWith("/briefs/")) {
      const [, briefs, briefId, jobs] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && jobs === "jobs") {
        const status = url.searchParams.get("status");
        const validStatuses = new Set<JobStatus | "stuck" | "dlq">([
          "queued",
          "running",
          "completed",
          "failed",
          "cancelled",
          "stuck",
          "dlq",
        ]);
        if (
          status &&
          !validStatuses.has(status as JobStatus | "stuck" | "dlq")
        ) {
          return Response.json(
            { error: "Unsupported job status filter" },
            { status: 400 },
          );
        }

        const [rows, dlqResult] = await Promise.all([
          jobRecords.listByBrief(briefId),
          drainDlq.process({ type: "drain_dlq", briefId }),
        ]);
        const filteredRows =
          status === "dlq"
            ? dlqResult.jobs
            : status
              ? (
                  await Promise.all(
                    rows.map(async (job) => ({
                      job,
                      status: await jobRecords.displayStatus(job),
                    })),
                  )
                )
                  .filter((row) => row.status === status)
                  .map((row) => row.job)
            : rows;

        return Response.json({ jobs: filteredRows, dlq: dlqResult.dlq });
      }
    }

    if (req.method === "POST" && url.pathname === "/deliver") {
      const body = (await req.json()) as DeliverBody;
      const result = await delivery.deliver({
        accountId,
        briefId: body.briefId,
        customerId: body.customerId,
        subscriptionId: body.subscriptionId,
        endpointUrl: body.endpointUrl,
        eventType: body.eventType,
        payloadHash: body.payloadHash,
        workerId: body.workerId,
        simulateFailure: body.simulateFailure ?? false,
      });

      return Response.json({ job: result });
    }

    return new Response("Not found", { status: 404 });
  },
});
