import { hasValidBearerToken } from "./bearer-auth";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import {
  DrainDlqProcessor,
  parseAccountRetryBudgets,
} from "../application/drain-dlq-processor";
import { JobRecordService } from "../application/job-record-service";
import { JobDeadLetteredError } from "../domain/errors";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";
import type { JobRecord } from "../domain/job";

const jobRepository = new InMemoryJobRepository();
const jobRecords = new JobRecordService(jobRepository);
const dlqProcessor = new DrainDlqProcessor(jobRecords, {
  perAccount: parseAccountRetryBudgets(process.env.WEBHOOK_RETRY_BUDGETS),
});
const delivery = new DeliveryOrchestrator(jobRecords, dlqProcessor);

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
        const adminToken = process.env.WEBHOOK_ADMIN_TOKEN;
        if (!adminToken) {
          return Response.json(
            { error: "DLQ endpoint authentication is not configured" },
            { status: 503 },
          );
        }
        if (!hasValidBearerToken(req, adminToken)) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          });
        }

        const rows = await dlqProcessor.listByBrief(
          accountId,
          briefId,
          url.searchParams.get("status"),
        );
        return Response.json(rows);
      }
    }

    if (req.method === "POST" && url.pathname === "/deliver") {
      const body = (await req.json()) as DeliverBody;
      let result: JobRecord;
      try {
        result = await delivery.deliver({
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
      } catch (error) {
        if (error instanceof JobDeadLetteredError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }

      return Response.json({ job: result });
    }

    return new Response("Not found", { status: 404 });
  },
});
