import { DeliveryAttemptRpc } from "../application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { InMemoryDeliverySplitFlags } from "../application/delivery-split-flags";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const attemptRepository = new InMemoryDeliveryAttemptRepository();
const splitFlags = new InMemoryDeliverySplitFlags();
const attemptRpc = new DeliveryAttemptRpc(jobRepository, attemptRepository, splitFlags);
const jobRecords = new JobRecordService(jobRepository, attemptRpc);
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
        const rows = await jobRecords.listByBrief(briefId);
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
