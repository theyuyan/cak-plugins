#!/usr/bin/env node
import { servePlugin } from "@cak/sdk";
import { GithubProvider } from "./provider.js";
servePlugin(new GithubProvider(), { pluginId: "github", version: "0.1.0", kernelCompat: "^0.3.0" });
