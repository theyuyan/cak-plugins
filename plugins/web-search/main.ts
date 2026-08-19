#!/usr/bin/env node
import { servePlugin } from "@cak/sdk";
import { WebSearchProvider } from "./provider.js";
servePlugin(new WebSearchProvider(), { pluginId: "web-search", version: "0.1.0", kernelCompat: "^0.3.0" });
