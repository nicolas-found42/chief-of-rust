import { createRelayApp } from "./app.js";

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? "0.0.0.0";

const { app } = createRelayApp();

await app.listen({ port, host });
console.log(`relay listening on http://${host}:${port}`);
