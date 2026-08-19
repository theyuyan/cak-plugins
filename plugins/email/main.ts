#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { EmailProvider } from "./provider.js";
servePlugin(new EmailProvider(), { pluginId: "email", version: "0.1.0", kernelCompat: "^0.3.0" });
