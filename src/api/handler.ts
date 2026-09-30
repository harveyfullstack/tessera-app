import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { JobRecordService } from "../application/job-record-service";

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

export function createHttpHandler(jobRecords: JobRecordService, delivery = new DeliveryOrchestrator(jobRecords)) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.startsWith("/briefs/")) {
      const [, briefs, briefId, jobs] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && jobs === "jobs") {
        const rows = (await jobRecords.listByBrief(briefId)).filter((job) => job.accountId === accountId);
        const jobs = await Promise.all(rows.map(async (job) => ({
          ...job, status: await jobRecords.displayStatus(job), dlq: await jobRecords.dlqSummary(job),
        })));
        return Response.json({ jobs: url.searchParams.has("status")
          ? jobs.filter((job) => job.status === url.searchParams.get("status")) : jobs });
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

      return Response.json({ job: { ...result, status: await jobRecords.displayStatus(result) } });
    }

    return new Response("Not found", { status: 404 });
  };
}
