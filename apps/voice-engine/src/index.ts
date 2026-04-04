// apps/voice-engine/src/index.ts
import Fastify from "fastify";
import { config } from "./config.js";
import { createCallWorker, createMonthlyResetScheduler, createCallQueue } from "./worker.js";
import { getActiveBridgeCount } from "./call-bridge.js";

const app = Fastify({ logger: true });

// Health check endpoint — includes active bridge count for monitoring
app.get("/health", async () => {
  return {
    status: "ok",
    service: "voice-engine",
    activeBridges: getActiveBridgeCount(),
    uptime: process.uptime(),
  };
});

async function start() {
  // Start BullMQ workers
  const callWorker = createCallWorker(app.log);
  const callQueue = createCallQueue();
  const { worker: resetWorker } = createMonthlyResetScheduler();

  app.log.info("[voice-engine] BullMQ call worker started");
  app.log.info("[voice-engine] Monthly reset scheduler started");

  // Graceful shutdown — close bridges, drain workers
  const shutdown = async () => {
    app.log.info("[voice-engine] Shutting down...");
    await callWorker.close();
    await resetWorker.close();
    await callQueue.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start HTTP server
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`[voice-engine] Listening on port ${config.port}`);
}

start().catch((err) => {
  console.error("[voice-engine] Failed to start:", err);
  process.exit(1);
});
