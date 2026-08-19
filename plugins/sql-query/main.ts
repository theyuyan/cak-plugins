#!/usr/bin/env node
import { servePlugin } from '@cak-dev/sdk';
import { SqlQueryProvider } from './provider.js';
servePlugin(new SqlQueryProvider(), { pluginId: 'sql-query', version: '0.1.0', kernelCompat: '^0.3.0' });
