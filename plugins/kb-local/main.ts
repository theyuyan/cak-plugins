#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { KbLocalProvider } from "./provider.js";
servePlugin(new KbLocalProvider(), { pluginId: "kb-local", version: "0.1.0", kernelCompat: "^0.3.0" });
