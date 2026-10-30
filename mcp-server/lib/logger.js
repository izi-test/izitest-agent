// Logging utility — writes to stderr so it doesn't interfere with stdio MCP transport

export function log(msg) {
  process.stderr.write(`[IziTest] ${msg}\n`);
}
