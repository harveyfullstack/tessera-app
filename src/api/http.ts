import { DeliveryAttemptRpc } from "../application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DeliveryRetryBudget } from "../application/delivery-retry-budget";
import { DeliverySplitFlags } from "../application/delivery-split-flags";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const deliveryAttemptRpc = new DeliveryAttemptRpc(
  jobRepository,
  new InMemoryDeliveryAttemptRepository(),
  DeliverySplitFlags.fromEnv(process.env),
);
const jobRecords = new JobRecordService(
  jobRepository,
  deliveryAttemptRpc,
  DeliveryRetryBudget.fromEnv(process.env),
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

// ?status=dlq narrows the listing to DLQ-bound jobs; other values leave it unfiltered.
const DLQ_STATUS_FILTER = "dlq";

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.startsWith("/briefs/")) {
      const [, briefs, briefId, jobs] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && jobs === "jobs") {
        const rows = await jobRecords.listByBrief(briefId);
        const dlq = await jobRecords.dlqSummary(rows);
        if (url.searchParams.get("status") === DLQ_STATUS_FILTER) {
          const dlqJobIds = new Set(dlq.entries.map((entry) => entry.jobId));
          return Response.json({ jobs: rows.filter((row) => dlqJobIds.has(row.id)), dlq });
        }
        return Response.json({ jobs: rows, dlq });
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
