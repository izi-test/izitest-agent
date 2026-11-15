// The model a CLI agent the dashboard starts works with (Settings → AI agent → Model): a test
// recorded by the agent, Chat with AI, a requirement's test design. It goes as --model, which the
// four CLIs take: Claude Code an alias (fable, opus, sonnet, haiku: the latest of that family) or
// a full name (claude-opus-5-5), Copilot a name or "auto", opencode provider/model. Left empty,
// the CLI picks: for Claude Code the model /model, settings.json or ANTHROPIC_MODEL sets on this
// machine, else the account's default.

// A model's name, as the CLIs take it: letters, digits, . _ - : / @ and the [1m] of a context
// size. Never starting with "-", which the CLI would read as an option of its own.
const MODEL_NAME = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

export function isModelName(value) {
  return MODEL_NAME.test(String(value ?? '').trim());
}

/** The model set for the CLI agent `cli` ({ provider, command, model }), or null: the CLI's own. */
export function cliModel(cli) {
  const model = String(cli?.model ?? '').trim();
  return model && isModelName(model) ? model : null;
}

/** The arguments that start `cli` with its model: none when the CLI picks it. */
export function cliModelArgs(cli) {
  const model = cliModel(cli);
  return model ? ['--model', model] : [];
}

/**
 * What a Claude Code run said of its model (`--output-format stream-json --verbose`): the model it
 * started with (its init event, an alias resolved: "opus" → "claude-opus-5-5"), and why it did
 * not answer if it did not (a model that does not exist, or the account cannot use).
 */
export function readModelCheck(stdout) {
  let model = null;
  let result = null;
  for (const line of String(stdout ?? '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init') model = event.model ?? model;
    if (event?.type === 'result') result = event;
  }
  if (!result) return { model, error: 'Claude Code gave no answer' };
  return { model, error: result.is_error ? String(result.result ?? result.subtype ?? 'failed').slice(0, 300) : null };
}
