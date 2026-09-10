import { createApp } from "./app";

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch: createApp().fetch,
});
