import { DeadLetterQueue } from "../application/dead-letter-queue";
import { DeliveryAttemptRpc } from "../application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { isDisplayStatus, JobRecordService } from "../application/job-record-service";
import { InMemoryDeliveryAttemptStore } from "../infrastructure/repositories/in-memory-delivery-attempt-store";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const attemptStore = new InMemoryDeliveryAttemptStore();
const executionWrites = new DeliveryAttemptRpc(jobRepository, attemptStore);
const jobRecords = new JobRecordService(jobRepository, executionWrites, attemptStore);
const delivery = new DeliveryOrchestrator(jobRecords);
const deadLetterQueue = new DeadLetterQueue(jobRecords, attemptStore);

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
        if (status !== null && !isDisplayStatus(status)) {
          return Response.json({ error: `Unknown status: ${status}` }, { status: 400 });
        }

        const [rows, dlq] = await Promise.all([
          status === null
            ? jobRecords.listByBrief(briefId)
            : jobRecords.listByBriefWithDisplayStatus(briefId, status),
          deadLetterQueue.summarizeBrief(briefId),
        ]);
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
