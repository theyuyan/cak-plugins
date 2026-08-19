#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { PkgInfoProvider } from "./provider.js";
servePlugin(new PkgInfoProvider(), { pluginId: "pkg-info", version: "0.1.0", kernelCompat: "^0.3.0" });
