#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { CalendarProvider } from "./provider.js";
servePlugin(new CalendarProvider(), { pluginId: "calendar", version: "0.1.0", kernelCompat: "^0.3.0" });
