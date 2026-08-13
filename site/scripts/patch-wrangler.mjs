// vinext regenerates dist/server/wrangler.json on every build, and the
// generated config serves static assets before the worker runs — which
// would strip the CORS headers off /cop/*. Route the feeds through the
// worker; run after `npm run build`, before `wrangler deploy`.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../dist/server/wrangler.json", import.meta.url);
const config = JSON.parse(readFileSync(path, "utf8"));
config.assets = { ...config.assets, binding: "ASSETS", run_worker_first: ["/cop/*"] };
writeFileSync(path, JSON.stringify(config));
console.log("wrangler.json: assets.run_worker_first =", config.assets.run_worker_first);
