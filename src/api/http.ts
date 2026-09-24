import { DeliveryAttemptRpc } from "../application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DlqInspector } from "../application/dlq-inspector";
import { JobRecordService } from "../application/job-record-service";
import { RetryBudgetPolicy } from "../application/retry-budget-policy";
import type { DeliveryAttemptReader } from "../domain/delivery-attempt-reader";
import { InMemoryDeliveryRollbackFlag } from "../infrastructure/flags/in-memory-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
// One attempts store backs both the RPC write boundary and the DLQ reads.
const attemptStore = new InMemoryDeliveryAttemptRepository();
const jobRecords = new JobRecordService(
  jobRepository,
  new DeliveryAttemptRpc(jobRepository, attemptStore, new InMemoryDeliveryRollbackFlag()),
);
const delivery = new DeliveryOrchestrator(jobRecords);

const deliveryAttempts: DeliveryAttemptReader = {
  countByDeliveryJob: async (deliveryJobId) => (await attemptStore.listByJob(deliveryJobId)).length,
  listLatestByDeliveryJob: async (deliveryJobId, limit) =>
    (await attemptStore.listByJob(deliveryJobId)).reverse().slice(0, limit),
};
const dlqInspector = new DlqInspector(deliveryAttempts, new RetryBudgetPolicy());

async function listBriefJobs(briefId: string, statusFilter: string | null): Promise<Response> {
  const rows = await jobRecords.listByBrief(briefId);
  const dlq = await dlqInspector.summarize(rows);
  if (statusFilter === "dlq") {
    const dlqJobIds = new Set(dlq.endpoints.map((endpoint) => endpoint.deliveryJobId));
    return Response.json({ jobs: rows.filter((job) => dlqJobIds.has(job.id)), dlq });
  }

  return Response.json({ jobs: rows, dlq });
}

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
        return listBriefJobs(briefId, url.searchParams.get("status"));
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
