#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { WebhookProvider } from "./provider.js";
servePlugin(new WebhookProvider({ log: m => process.stderr.write(`[webhook] ${m}\n`) }), { pluginId: "webhook", version: "0.1.0", kernelCompat: "^0.3.0" });
