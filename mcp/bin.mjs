#!/usr/bin/env node
// Entry point for `npx permapath-mcp` (see server.mjs).
import { main } from './server.mjs';

main().catch((err) => {
  process.stderr.write(`permapath-mcp: ${err.message}\n`);
  process.exit(1);
});
