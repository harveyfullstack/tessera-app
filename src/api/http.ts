import { DEFAULT_RETRY_BUDGET_CONFIG } from "../application/dead-letter-queue";
import { DeliveryAttemptRpc, EMPTY_DELIVERY_SPLIT_FLAGS } from "../application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const deliveryAttemptRpc = new DeliveryAttemptRpc(
  jobRepository,
  new InMemoryDeliveryAttemptRepository(),
  EMPTY_DELIVERY_SPLIT_FLAGS,
);
const jobRecords = new JobRecordService(
  jobRepository,
  deliveryAttemptRpc,
  DEFAULT_RETRY_BUDGET_CONFIG,
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
        if (status !== null && status !== "dlq") {
          return Response.json({ error: `Unsupported status filter: ${status}` }, { status: 400 });
        }
        const rows = await jobRecords.listByBrief(briefId, status === "dlq" ? { status } : {});
        return Response.json({ jobs: rows });
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
