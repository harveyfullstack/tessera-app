import { createDeliveryAppContext } from "../application/delivery-app-context";
import type { DisplayStatus } from "../application/job-record-service";
import type { JobRecord } from "../domain/job";

const { jobRecords, delivery, drainDlq } = createDeliveryAppContext();

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

interface JobListItem extends JobRecord {
  displayStatus: DisplayStatus;
}

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.startsWith("/briefs/")) {
      const [, briefs, briefId, jobs] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && jobs === "jobs") {
        const statusFilter = url.searchParams.get("status");
        const rows = await jobRecords.listByBrief(briefId);
        const enriched: JobListItem[] = [];

        for (const job of rows) {
          const displayStatus = await jobRecords.displayStatus(job);
          if (statusFilter === "dlq" && displayStatus !== "dlq") {
            continue;
          }
          enriched.push({ ...job, displayStatus });
        }

        const dlq = await drainDlq.buildDlqSummaries(briefId, accountId);
        return Response.json({ jobs: enriched, dlq });
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

    if (req.method === "POST" && url.pathname === "/dlq/drain") {
      const body = (await req.json()) as { briefId: string };
      const result = await drainDlq.drain({
        accountId,
        briefId: body.briefId,
      });
      return Response.json({ job: result });
    }

    return new Response("Not found", { status: 404 });
  },
});
