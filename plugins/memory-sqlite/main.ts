#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { MemorySqliteProvider } from "./provider.js";
servePlugin(new MemorySqliteProvider(), { pluginId: "memory-sqlite", version: "0.1.0", kernelCompat: "^0.3.0" });
