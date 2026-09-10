import { createDeliveryRuntime } from "../application/delivery-runtime";
import { createAppFetch } from "./app";

const runtime = createDeliveryRuntime();

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch: createAppFetch(runtime),
});
