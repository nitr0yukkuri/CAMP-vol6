import { createServer } from "node:http";
import { MOCK_GUIDE, MOCK_MODEL_STATUS, MOCK_OBSERVATION } from "@orewosabake/contracts";

const port = Number(process.env.PORT ?? 3001);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "GET") {
    response.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  switch (pathname) {
    case "/api/guide":
      response.writeHead(200).end(JSON.stringify(MOCK_GUIDE));
      return;
    case "/api/model/status":
      response.writeHead(200).end(JSON.stringify(MOCK_MODEL_STATUS));
      return;
    case "/api/model/mock-observation":
      response.writeHead(200).end(JSON.stringify(MOCK_OBSERVATION));
      return;
    default:
      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`orewosabake mock API listening at http://127.0.0.1:${port}`);
});
