# The dashboard

The web interface of IziTest Agent: React, TypeScript, Redux Toolkit, Vite.

- `npm run build` builds it into `../public`, where the server serves it on
  <http://127.0.0.1:3467> (the root `npm run setup` does it).
- `npm run dev` serves it with hot reload on <http://localhost:5175>; `/api` and `/live` go to the
  server on port 3467, with `IZITEST_TOKEN` when it is set.
- `npm run lint` checks it.
