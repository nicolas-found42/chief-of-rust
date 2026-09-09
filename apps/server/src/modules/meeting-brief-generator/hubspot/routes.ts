import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "../../../config.js";
import { HubSpotConnection } from "./connection.js";

export interface HubSpotRouteOptions {
  configStore: ConfigStore;
  connection?: HubSpotConnection;
}

export function registerMeetingBriefHubSpotRoutes(
  app: FastifyInstance,
  options: HubSpotRouteOptions,
): void {
  const { configStore } = options;
  const connection = options.connection ?? new HubSpotConnection(configStore);

  app.get("/api/meeting-brief/hubspot/status", async () => {
    return connection.status();
  });

  app.post("/api/meeting-brief/hubspot/connect", async (request, reply) => {
    const token = (request.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.trim() === "") {
      reply.code(400).send({ error: "A HubSpot private-app token is required." });
      return;
    }
    try {
      const status = await connection.connect(token);
      return status;
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });

  app.post("/api/meeting-brief/hubspot/disconnect", async () => {
    return connection.disconnect();
  });

  app.post("/api/meeting-brief/hubspot/check", async () => {
    return connection.verifySetup();
  });
}
