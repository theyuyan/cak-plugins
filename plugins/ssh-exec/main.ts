#!/usr/bin/env node
import { servePlugin } from "@cak-dev/sdk";
import { SshExecProvider } from "./provider.js";
servePlugin(new SshExecProvider(), { pluginId: "ssh-exec", version: "0.1.0", kernelCompat: "^0.3.0" });
