# Multi-Account Management 👥

IziTest Agent can drive several Chrome profiles at once — one per user role an application has (an administrator, a customer). Each profile is completely isolated, with its own:
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

### Example: an administrator and a customer
1.  **Launch Profile 1**: `./scripts/launch-profile.sh admin`
2.  **Launch Profile 2**: `./scripts/launch-profile.sh customer`
3.  In **each** window that opens:
    - Go to `chrome://extensions`.
    - Enable **Developer Mode**.
    - Click **Load unpacked** and select the `extension/dist` folder.
    - Click the extension icon in the toolbar.
    - Set the `Profile ID` to match your launch name (e.g., `admin`).

---

## Targeting Profiles in Claude

Once your profiles are connected, you can tell Claude exactly which one to use.

### List Profiles
Ask Claude: `"Quelle est la liste des profils connectés ?"` (or in English: `"List connected profiles"`).

### Target a Profile
Claude will automatically include the `profile` parameter in MCP tool calls if you specify it in your request:
- `"On the admin profile, open the orders back office"`
- `"On the customer profile, place an order"`

If you don't specify a profile, IziTest Agent will default to the first one that connected to the bridge — never the
`headless` one, the Chrome without windows the server starts to replay tests out of sight (see
[MCP Tools Reference → Rejouer sans fenêtre](mcp-tools.md)): it is used only when named.

---

## Why Profiles over Tabs?

While you can open many tabs in a single profile, those tabs **share cookies and sessions**: logged in as the administrator in one tab, you are the administrator in the other too.

**Use separate profiles when:**
- A test needs two users at once (a customer orders, an administrator validates the order).
- You want to check what each role can and cannot see.
- You want the tests' sessions kept apart from your own browsing.

---
[< Previous: MCP Tools Reference](mcp-tools.md) | [Next: Architecture Details >](architecture-details.md)
