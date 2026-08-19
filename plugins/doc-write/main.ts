#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { DocWriteProvider } from "./provider.js";
servePlugin(new DocWriteProvider(), { pluginId: "doc-write", version: "0.1.0", kernelCompat: "^0.3.0" });
