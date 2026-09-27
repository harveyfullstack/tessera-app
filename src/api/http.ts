import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";
import { DlqProcessor } from "../application/dlq-processor";

const jobRepository = new InMemoryJobRepository();
const jobRecords = new JobRecordService(jobRepository);
const delivery = new DeliveryOrchestrator(jobRecords);
const dlq = new DlqProcessor(jobRecords);

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
        const validStatuses = new Set(["queued", "running", "completed", "failed", "dlq", "cancelled"]);
        if (status !== null && !validStatuses.has(status)) {
          return Response.json({ error: "unsupported status filter" }, { status: 400 });
        }
        await dlq.drain(briefId);
        const rows = await jobRecords.listByBrief(briefId);
        const filtered = status !== null ? rows.filter((job) => job.status === status) : rows;
        const decorated = await Promise.all(
          filtered.map(async (job) => ({ ...job, dlq: await dlq.summary(job) })),
        );
        const endpoints = decorated.filter((job) => job.status === "dlq");
        return Response.json({
          jobs: decorated,
          dlq: {
            pastBudgetCount: endpoints.length,
            endpoints: endpoints.map((job) => ({
              endpointUrl: job.metadata.endpointUrl,
              ...job.dlq,
            })),
          },
        });
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
