import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { buildBriefJobsResponse } from "../application/job-list-query";
import type { DeliveryRuntime } from "../application/delivery-runtime";

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

const defaultAccountId = "tessera-demo-account";

export function createAppFetch(runtime: DeliveryRuntime, accountId = defaultAccountId) {
  const delivery = new DeliveryOrchestrator(runtime.jobRecords);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.startsWith("/briefs/")) {
      const [, briefs, briefId, jobs] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && jobs === "jobs") {
        const status = url.searchParams.get("status") ?? undefined;
        const payload = await buildBriefJobsResponse(
          briefId,
          runtime.jobs,
          runtime.deliveryAttempts,
          runtime.budgets,
          status,
        );
        return Response.json(payload);
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/briefs/")) {
      const [, briefs, briefId, drain] = url.pathname.split("/");
      if (briefs === "briefs" && briefId && drain === "drain-dlq") {
        const result = await runtime.drainDlq.process({
          accountId,
          briefId,
          workerId: "dlq-processor",
        });
        return Response.json(result);
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
  };
}
