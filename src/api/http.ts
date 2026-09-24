import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DlqProcessor } from "../application/dlq-processor";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

export const jobRepository = new InMemoryJobRepository();
export const jobRecords = new JobRecordService(jobRepository);
export const dlqProcessor = new DlqProcessor(jobRepository, jobRecords);
export const delivery = new DeliveryOrchestrator(jobRecords);

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
        const statusFilter = url.searchParams.get("status");
        let rows = await jobRecords.listByBrief(briefId);
        const dlq = await dlqProcessor.getDlqSummary(briefId);

        if (statusFilter === "dlq") {
          rows = await dlqProcessor.filterDlqJobs(rows);
        } else if (statusFilter) {
          rows = rows.filter((r) => r.status === statusFilter);
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
