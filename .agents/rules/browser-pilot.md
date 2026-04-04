---
trigger: always_on
---

# Browser Pilot - Workflow Recording

When the user asks to "enregistrer", "record", or "sauvegarder" a workflow/parcours for browser automation, use the **browser-pilot** MCP tools in this order:

1. `start_recording({ name, description })` - Start recording
2. Perform browser actions (`navigate`, `click`, `fill`, etc.)
3. After EACH successful action, call `record_step({ command, params, intent })` with the exact command and params that worked
4. When the task is complete, call `stop_recording()` to save the workflow

When the user asks to "rejouer", "replay", or "relancer" a workflow:
- Call `replay_workflow({ name })` — this single tool call executes ALL steps automatically
- If the user wants to change values (e.g. different city, different price), use the `substitutions` parameter:
  Example: `replay_workflow({ name: "recherche_seloger_antony", substitutions: { "Antony": "Marseille", "400000": "500000" } })`
- Do NOT manually replay steps one by one
- Do NOT take snapshots or screenshots during replay
- Do NOT use click/fill/navigate individually — `replay_workflow` handles everything
- The replay tool sends commands directly to the browser without LLM reasoning
- NEVER read the workflow JSON file to execute steps yourself — always use `replay_workflow`

Do NOT use memory files or notes to store workflows. Always use the browser-pilot recording tools.
