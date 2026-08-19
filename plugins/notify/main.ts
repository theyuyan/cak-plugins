#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { NotifyProvider } from "./provider.js";
servePlugin(new NotifyProvider(), { pluginId: "notify", version: "0.1.0", kernelCompat: "^0.3.0" });
