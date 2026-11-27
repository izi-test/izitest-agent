# Iframes 🪟

IziTest Agent sees and drives the content of iframes, including those of another site
(third-party cookie banners, payment fields, embedded widgets).

## What works

| | Same origin | Cross-origin |
|---|---|---|
| `snapshot` | ✅ content under the `[iframe]` line | ✅ same, nested iframes included |
| `click` / `fill` by ref, selector or text | ✅ | ✅ |
| `select` by ref or selector | ✅ | ✅ |
| `extract`, `wait` | ✅ | ✅ |
| "covered by …" refusal | ✅ in the page and in the iframe | ✅ same |
| `changes` of the click (a dialog that appeared, etc.) | ✅ | ✅ prefixed with `in iframe <address>:` |
| annotated `screenshot` | ✅ boxes placed on the iframe | ✅ same |
| `execute_js` with `frame` | ✅ | ✅ (unless the iframe's CSP forbids `eval`) |

Nothing to do on the agent's side: the `@eN` refs of an iframe are used like the others, and a
selector or a text is looked for in the page, then in its iframes.

The `[iframe]` line of the snapshot shows the iframe's address (`src="…"`). `execute_js` targets
an iframe with `frame`: its ref (`frame: "@e4"`) or a piece of its address
(`frame: "account.idealo"`).

## How

- **Same origin**: the page's content script reads the iframe's document and adds its
  offset (position, border, padding, nesting) to click at the right place.
- **Cross-origin**: the page cannot read the iframe. The content script is injected into it;
  the iframe takes its own snapshot, numbered after the page's, merged under its `[iframe]`
  line. As an iframe does not know its own position, it asks its parent for it through
  `postMessage`; the parent also answers whether a click at the wanted point would really reach
  the iframe (if not: "covered by …" refusal). And so on, up to the page.
- The click and the typing are always sent **at the level of the page**: the browser is what
  routes them into the iframe, exactly as for a user (`isTrusted: true`).

## Limits

- **Replaying a test recorded in an iframe** is not supported: the step keeps a
  selector that is valid in the iframe, and the replay engine looks in the page.
- **Invisible** iframes (tracking pixels, 1×1) are ignored in the snapshot.
- An iframe the extension cannot be injected into (sandbox without scripts, Chrome's
  internal pages) stays invisible.
- The locating message goes through `postMessage` to the parent page: the page's own
  scripts can see it go by (with no effect, as for the other extensions that use it).
- reCAPTCHA is technically reachable, but it is designed to detect automation:
  it is not a use case, and nothing here tries to get around it.
