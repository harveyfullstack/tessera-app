import { DeadLetterQueueInspector } from "../application/dead-letter-queue-inspector";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { JobRecordService } from "../application/job-record-service";
import { DeliveryAttemptRpc } from "../application/delivery-attempt-rpc";
import { RetryBudgetPolicy } from "../application/retry-budget-policy";
import { StaticDeliveryRollbackFlag } from "../infrastructure/flags/static-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const attemptRepository = new InMemoryDeliveryAttemptRepository();
const deliveryAttempts = new DeliveryAttemptRpc(
  jobRepository,
  attemptRepository,
  new StaticDeliveryRollbackFlag(),
);
const jobRecords = new JobRecordService(jobRepository, deliveryAttempts, attemptRepository);
const delivery = new DeliveryOrchestrator(jobRecords);
const dlqInspector = new DeadLetterQueueInspector(attemptRepository, new RetryBudgetPolicy());

const DLQ_STATUS_FILTER = "dlq";

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
      const [, briefs, briefId, jobsSegment] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && jobsSegment === "jobs") {
        const rows = await jobRecords.listByBrief(briefId);
        const dlq = await dlqInspector.summarize(rows);
        const dlqJobIds = new Set(dlq.endpoints.map((endpoint) => endpoint.jobId));
        const jobs =
          url.searchParams.get("status") === DLQ_STATUS_FILTER
            ? rows.filter((row) => dlqJobIds.has(row.id))
            : rows;
        return Response.json({ jobs, dlq });
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
