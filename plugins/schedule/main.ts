#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { ScheduleProvider } from "./provider.js";
servePlugin(new ScheduleProvider({ log: m => process.stderr.write(`[schedule] ${m}\n`) }), { pluginId: "schedule", version: "0.1.0", kernelCompat: "^0.3.0" });
