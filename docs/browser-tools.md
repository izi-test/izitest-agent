# Driving the browser with the MCP tools 🕹️

*The whole path, from a requirement to a campaign, is in [usage.md](usage.md). This page details how an agent drives the browser with the basic tools.*

Once IziTest Agent is set up, you can interact with your browser through Claude, in natural language or with the MCP tools directly.

---

## Element discovery protocol

To interact reliably with the elements of a page, always follow this protocol:

### Step 1: Snapshot (always start here)

The snapshot lists the elements of the page as a tree, each with its reference (`@e1`, `@e2`, `@e3`...). It is fast and cheap. Give it a `purposeFilter` matching what you are about to do, and a `searchText` to narrow further:

```
"Take a snapshot with purposeFilter='fill' and searchText='email'"
```

Useful options for `snapshot`:
- `purposeFilter="fill"` → input fields only
- `purposeFilter="click"` → buttons/links only  
- `purposeFilter="read"` → all the elements (to understand the structure of the page, never as a first call)
- `searchText="keyword"` → filters by text (case-insensitive)
- `includeHidden=true` → includes hidden elements (only when the element was not found without it)

### Step 2: Use the `@eX` references

If you see the element you want in the snapshot:
```
"Click @e5"
"Fill @e12 with 'my text'"
```

### Step 3: Screenshot (last resort)

If the element is not in the snapshot, take another snapshot first, with broader filters: without `purposeFilter`, with another `searchText`, or with `includeHidden=true` if the element may be in a hidden container.

Take a screenshot only after `snapshot` has failed twice or more to find the element: it is expensive (a large base64 image).

```
"Take a screenshot of the page"
```

The result contains:
- An image with a box drawn around each element
- A list `@e1`, `@e2`, `@e3`... matching the interactive elements

---

## Basic navigation

```
"Go to youtube.com"
"Open twitter.com with the profile work-account"
"List the open tabs"
"Close the window you opened"
```

### With a specific profile

```
"On the profile youtube-work, go to youtube.com/studio"
"Use the profile personal-account to click 'Sign in'"
```

---

## Advanced interactions

### Forms

```
"Fill the email field with 'test@example.com'"
"Check the 'I accept the terms' box"
"Select 'France' in the dropdown"
"Press Enter"
"Press Tab to move to the next field"
```

### Scroll

```
"Scroll down 500 pixels"
"Scroll to the element #results"
"Scroll up"
```

### Waiting

```
"Wait 2 seconds"
"Wait for #results to appear (the project's wait for an element, 10 s by default)"
"Wait for #export-ready to appear, up to 2 minutes"
```

---

## Data extraction

```
"Extract the text of every h1 on the page"
"Get the href of every link in .nav"
"How many elements have the class 'video-title'?"
"Run this JavaScript: [...document.querySelectorAll('.price')].map(e => e.textContent)"
```

---

## Arbitrary JavaScript

For complex interactions:

```
"Run this JavaScript code:"
```

```javascript
// Usage examples
window.scrollTo(0, document.body.scrollHeight);  // Scroll to the bottom
document.querySelector('#accept-cookies').click(); // Accept cookies
localStorage.getItem('user_id');                   // Read localStorage
```

---

## Cookies and authentication

```
"Get the cookies for youtube.com"
"Check whether the cookie 'session_id' exists"
"List all the cookies of the domain .google.com"
```

> **Note**: For security reasons, cookie values are truncated to 50 characters in the answers.

---

## Complete workflows

### Example: YouTube search

```
1. "Go to youtube.com"
2. "Take a snapshot with purposeFilter='fill' and searchText='search'"
3. "Fill @e2 (the search field) with 'python tutorial'"
4. "Click @e3 (the search button)"
5. "Wait for #results to appear"
6. "Extract the video titles: .video-title"
```

### Example: Logging in to a site

```
1. "Go to example.com/login"
2. "Take a snapshot with purposeFilter='fill'"
3. "Fill @e1 with 'myemail@example.com'"
4. "Fill @e2 with 'mypassword'"
5. "Click @e3 (Sign in)"
6. "Wait for .dashboard to appear"
7. "Take a screenshot to check"
```

---

## Useful shortcuts

| Action | Equivalent command |
|--------|---------------------|
| Screenshot + mapping | `screenshot(annotate=true)` |
| See the full structure of the page | `snapshot(purposeFilter="read")` |
| Find a specific field | `snapshot(purposeFilter="fill", searchText="email")` |
| Find a button | `snapshot(purposeFilter="click", searchText="connexion")` |
| Full page info | `get_page_info()` |

---

## Tips and good practices

1. **Always start with a snapshot** before interacting with an unknown page, never with a screenshot
2. **Use the `@eX` references** rather than CSS selectors when possible (more stable)
3. **Name the profile** if you use several accounts
4. **Wait for loading**: modern pages load content dynamically
5. **Read the result of an action** before reaching for a screenshot: a click lists what it did in `changes`. Keep screenshots for what must be checked visually (layout, images)

---
[< Previous: Troubleshooting](troubleshooting.md) | [Next: MCP Tools Reference >](mcp-tools.md)
