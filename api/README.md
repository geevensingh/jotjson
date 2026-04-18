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

Function implementations live in `src/functions/`. Each function registers itself via `app.http(...)` (v4 model).
