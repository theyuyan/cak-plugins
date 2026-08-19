#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { SkillsProvider } from "./provider.js";
servePlugin(new SkillsProvider(), { pluginId: "skills", version: "0.1.0", kernelCompat: "^0.3.0" });
