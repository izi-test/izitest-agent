# Multi-Account Management 👥

One of the core strengths of IziTest Agent is its ability to handle multiple Chrome profiles simultaneously. Each profile is completely isolated, with its own:
- **Cookies & Sessions** (stay logged into different accounts)
- **Browser History**
- **Extensions** (must be installed in each profile)
- **Local Storage / IndexedDB**

## Using `launch-profile.sh`

The project includes a utility script to launch Chrome instances with dedicated user data directories.

### Usage
```bash
chmod +x scripts/launch-profile.sh
./scripts/launch-profile.sh <profile-name>
```

### Example: Managing Two YouTube Accounts
1.  **Launch Profile 1**: `./scripts/launch-profile.sh youtube-work`
2.  **Launch Profile 2**: `./scripts/launch-profile.sh youtube-personal`
3.  In **each** window that opens:
    - Go to `chrome://extensions`.
    - Enable **Developer Mode**.
    - Click **Load unpacked** and select the `extension/` folder.
    - Click the extension icon in the toolbar.
    - Set the `Profile ID` to match your launch name (e.g., `youtube-work`).

---

## Targeting Profiles in Claude

Once your profiles are connected, you can tell Claude exactly which one to use.

### List Profiles
Ask Claude: `"Quelle est la liste des profils connectés ?"` (or in English: `"List connected profiles"`).

### Target a Profile
Claude will automatically include the `profile` parameter in MCP tool calls if you specify it in your request:
- `"Sur le profil youtube-work, va sur youtube.com/studio"`
- `"Remplis le formulaire sur le profil youtube-personal"`

If you don't specify a profile, IziTest Agent will default to the first one that connected to the bridge — never the
`headless` one, the Chrome without windows the server starts to replay tests out of sight (see
[MCP Tools Reference → Rejouer sans fenêtre](mcp-tools.md)): it is used only when named.

---

## Why Profiles over Tabs?

While you can open many tabs in a single profile, those tabs **share cookies and sessions**. If you log into Gmail in Tab 1, you'll be logged into the same account in Tab 2.

**Use separate profiles when:**
- You need to manage multiple social media accounts (Twitter, LinkedIn, YouTube).
- You want to keep your work and personal browsing contexts separate.
- You want to avoid cross-site tracking or session leakage between different automation tasks.

---
[< Previous: MCP Tools Reference](mcp-tools.md) | [Next: Architecture Details >](architecture-details.md)
