#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { OpenSourcesProvider } from "./provider.js";
servePlugin(new OpenSourcesProvider(), { pluginId: "open-sources", version: "0.1.0", kernelCompat: "^0.3.0" });
