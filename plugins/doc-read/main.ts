#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { DocReadProvider } from "./provider.js";
servePlugin(new DocReadProvider(), { pluginId: "doc-read", version: "0.1.0", kernelCompat: "^0.3.0" });
