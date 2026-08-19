#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { BrowserProvider } from "./provider.js";
const p = new BrowserProvider();
process.on("SIGTERM", () => { p.close().finally(() => process.exit(0)); });
servePlugin(p, { pluginId: "browser", version: "0.1.0", kernelCompat: "^0.3.0" });
