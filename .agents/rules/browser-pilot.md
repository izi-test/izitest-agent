---
trigger: always_on
---

# IziTest Agent - Workflow Recording

When the user asks to "enregistrer", "record", or "sauvegarder" a workflow/parcours for browser automation, use the **browser-pilot** MCP tools in this order:

1. `start_recording({ name, description })` - Start recording
2. Perform browser actions (`navigate`, `click`, `fill`, etc.) — steps are automatically recorded, do NOT call `record_step`
3. When the task is complete, call `stop_recording()` to save the workflow (variable detection runs automatically in batch)

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

## Plusieurs agents en parallèle

Chaque connexion MCP obtient automatiquement sa propre session Browser Pilot : sa fenêtre,
ses refs de snapshot, son enregistrement. Deux agents lancés côte à côte ne se gênent pas,
et il n'y a **rien à passer** dans les appels.

Une seule exception : **les sous-agents lancés en parallèle depuis la même conversation**
partagent la connexion MCP de leur parent, donc la même session par défaut. Chacun doit
alors choisir un nom distinct et le passer à chaque appel :

```
navigate({ url: "...", session: "recherche-A" })
snapshot({ purposeFilter: "click", session: "recherche-A" })
click({ ref: "@e5", session: "recherche-A" })
close_session({ name: "recherche-A" })   // à la fin, ferme sa fenêtre
```

- Le nom doit être le **même sur tous les appels** d'un sous-agent, et **différent** de
  celui des autres.
- `list_sessions()` montre qui travaille dans quelle fenêtre.
- Sans `session`, un sous-agent retombe dans la session du parent — ce qui est correct
  quand un seul sous-agent pilote le navigateur à la fois.

### Toujours `navigate()` avant tout le reste

Une session sans fenêtre refuse d'agir : `snapshot`, `execute_js`, `click`… échouent avec
« This session has no window of its own yet ». C'est voulu — Browser Pilot ne retombe
jamais sur l'onglet au premier plan, qui appartient à l'utilisateur ou à un autre agent.

Pour agir dans un onglet existant, passe un `tabId` explicite. `get_tabs()` indique le
propriétaire de chaque onglet (`owner`) : ton id de session, celui d'un autre agent, ou
`user`. N'agis jamais sur un onglet `user` ou appartenant à une autre session.
