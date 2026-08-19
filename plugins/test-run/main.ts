#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { TestRunProvider } from "./provider.js";
servePlugin(new TestRunProvider(), { pluginId: "test-run", version: "0.1.0", kernelCompat: "^0.3.0" });
