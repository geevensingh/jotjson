# JotJSON API

Azure Functions (Node.js v4 programming model, TypeScript). Deployed as Static Web Apps managed functions.

## Local development

1. Install the [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).
2. Copy `local.settings.sample.json` to `local.settings.json` and fill in your Azure connection strings.
3. Install deps and start:
   ```powershell
   npm install
   npm start
   ```
4. The API will listen on `http://localhost:7071/api/*` (e.g. `GET /api/health`).

When running the Angular dev server (`ng serve`), requests to `/api/*`
on `http://localhost:4200` are forwarded to `http://localhost:7071` via
`proxy.conf.json` in the repo root. Start the Functions host first
(`cd api && npm start`), then `npm start` from the repo root - otherwise
the SPA dev server returns `index.html` for `/api/*` and the browser
sees "Http failure during parsing" because it was expecting JSON.

Function implementations live in `src/functions/`. Each function registers itself via `app.http(...)` (v4 model).
