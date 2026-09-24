import { briefIdFromJobsPath, loadBriefJobs } from "./brief-jobs";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DlqDrainProcessor } from "../application/dlq-drain-processor";
import { JobRecordService } from "../application/job-record-service";
import { NoRollbackFlags } from "../domain/delivery-rollback";
import { AccountRetryBudgets } from "../domain/retry-budget";
import { InMemoryDeliveryAttemptStore } from "../infrastructure/repositories/in-memory-delivery-attempt-store";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const deliveryAttempts = new InMemoryDeliveryAttemptStore();
const jobRecords = new JobRecordService(jobRepository, deliveryAttempts, new NoRollbackFlags());
const dlqDrain = new DlqDrainProcessor(jobRepository, deliveryAttempts, new AccountRetryBudgets());
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

    const briefId = briefIdFromJobsPath(url.pathname);
    if (req.method === "GET" && briefId) {
      const body = await loadBriefJobs(briefId, url.searchParams.get("status"), jobRecords, dlqDrain);
      return Response.json(body);
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
