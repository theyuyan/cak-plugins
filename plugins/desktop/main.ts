#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { DesktopProvider } from "./provider.js";
servePlugin(new DesktopProvider(), { pluginId: "desktop", version: "0.1.0", kernelCompat: "^0.3.0" });
