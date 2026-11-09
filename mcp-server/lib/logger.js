// Logging utility — writes to stderr so it doesn't interfere with stdio MCP transport

// What every line goes through before it is written: lib/secrets.js puts a secret's reference
// back in place of its value.
let filter = (text) => text;

export function setLogFilter(fn) {
  filter = fn;
}

export function log(msg) {
  let text;
  try {
    text = filter(String(msg));
  } catch (err) {
    // Not written as it is: it may hold a secret the filter could not put back.
    text = `(a line not written: ${err.message})`;
  }
  process.stderr.write(`[IziTest] ${text}\n`);
}
