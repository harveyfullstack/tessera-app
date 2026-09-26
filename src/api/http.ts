import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DlqService } from "../application/dlq-service";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const jobRecords = new JobRecordService(jobRepository);
const delivery = new DeliveryOrchestrator(jobRecords);
const configuredBudgets = JSON.parse(process.env.DLQ_RETRY_BUDGETS ?? "{}") as Record<string, number>;
const dlq = new DlqService(jobRepository, jobRecords, (accountId) => configuredBudgets[accountId] ?? 8);

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

    const [, briefs, briefId, jobs, action] = url.pathname.split("/");
    if (briefs === "briefs" && briefId && jobs === "jobs") {
      if (req.method === "GET" && !action) {
        const [rows, summary] = await Promise.all([
          jobRecords.listByBrief(briefId), dlq.summary(accountId, briefId),
        ]);
        const dlqIds = new Set(summary.endpoints.map((entry) => entry.jobId));
        const visible = rows.map((job) => dlqIds.has(job.id) ? { ...job, status: "dlq" } : job);
        const status = url.searchParams.get("status");
        const filtered = status ? visible.filter((job) => job.status === status) : visible;
        return Response.json({ jobs: filtered, dlq: summary });
      }
      if (req.method === "POST" && action === "drain-dlq") {
        const body = (await req.json()) as { workerId: string };
        const moved = await dlq.drain(accountId, briefId, body.workerId);
        return Response.json({ moved });
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
