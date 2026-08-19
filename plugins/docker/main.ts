#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { DockerProvider } from "./provider.js";
servePlugin(new DockerProvider(), { pluginId: "docker", version: "0.1.0", kernelCompat: "^0.3.0" });
