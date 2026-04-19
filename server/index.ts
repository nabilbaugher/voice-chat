import { createServer } from "node:http";

import { getConfig } from "./config.js";
import { createApp } from "./create-app.js";
import { attachLiveTranscriptionServer } from "./live-transcribe.js";
import { createBackendServices } from "./services.js";
import { SessionStore } from "./session-store.js";

const config = getConfig();
const services = createBackendServices(config);
const sessionStore = new SessionStore();
const app = createApp({ config, services, sessionStore });
const server = createServer(app);

attachLiveTranscriptionServer({
  server,
  config,
  sessionStore,
});

server.listen(config.port, () => {
  console.log(`Voice Claude server listening on http://localhost:${config.port}`);
});
