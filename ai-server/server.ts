import "./node-env";
import { loadEnvConfig } from "@next/env";
import { createServer } from "node:http";
import next from "next";

const dev = process.argv.includes("--dev");
loadEnvConfig(process.cwd(), dev);

const port = Number(process.env.PORT || 3000);
const hostname = "0.0.0.0";

async function main() {
  const httpServer = createServer();
  const app = next({ dev, hostname, port, httpServer });
  await app.prepare();

  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  // Imported after loadEnvConfig so the gateway sees the env.
  const { attachGateway } = await import("./src/gateway");
  attachGateway(httpServer, (req, socket, head) => upgrade(req, socket, head));

  httpServer.on("request", (req, res) => handle(req, res));
  httpServer.listen(port, hostname, () => {
    console.log(`> ai-server on http://localhost:${port} (${dev ? "dev" : "production"}), devices → ws://…:${port}/ws`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
