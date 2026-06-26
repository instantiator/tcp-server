# JSON Schema Reference

`schemas/schema.json` is a JSON Schema (draft-07) file generated automatically from the TypeScript entity models in `libs/lcp-shared/src/models/`. It documents the shape of every entity in the system and is used to validate JSON input before passing it to the CLI or API.

---

## How the schema is generated

```bash
npm run schema:generate
```

This runs `ts-json-schema-generator` over every `*.model.ts` in `libs/lcp-shared/src/models/` and writes the result to `schemas/schema.json`. The schema is also regenerated as part of `npm run build`.

The schema is a **generated artefact** — do not edit it by hand. If it is out of date, run `npm run schema:generate` and commit the updated file.

---

## Key definitions

These are the definitions you are most likely to reference when preparing CLI input.

### `LcpCompany`

Represents a company (tenant). Used by `set-company`.

| Field             | Type                      | Required | Notes                                          |
| ----------------- | ------------------------- | -------- | ---------------------------------------------- |
| `slug`            | `string`                  | Yes      | URL-safe identifier; must be unique            |
| `name`            | `string`                  | Yes      | Display name                                   |
| `description`     | `string`                  | Yes      | One-sentence description                       |
| `companyContext`  | `string`                  | No       | Injected into every agent prompt as part 2     |
| `llmDefault`      | [`LlmConfig`](#llmconfig) | No       | Default LLM for all roles that don't override  |
| `embeddingConfig` | [`LlmConfig`](#llmconfig) | No       | Embedding model (can differ from the chat LLM) |

### `LcpRole`

Represents an agent role within a company. Used by `set-role`.

| Field                  | Type                      | Required | Notes                                                |
| ---------------------- | ------------------------- | -------- | ---------------------------------------------------- |
| `companyId`            | UUID string               | Yes      | Must match an existing company                       |
| `name`                 | `string`                  | Yes      | Human-readable role name                             |
| `description`          | `string`                  | Yes      | Shown to other agents via `list_available_roles`     |
| `systemPromptTemplate` | `string`                  | Yes      | Supports `{{name}}`, `{{companyName}}` placeholders  |
| `knowledgeDomains`     | `string[]`                | Yes      | Tags for query routing (e.g. `["finance","legal"]`)  |
| `mcpServerList`        | `string[]`                | Yes      | MCP server names the role can use                    |
| `llmConfig`            | [`LlmConfig`](#llmconfig) | No       | Per-role LLM override; falls back to company default |
| `rolePrompt`           | `string`                  | No       | Additional context injected at the start of each run |

### `LlmConfig`

Embedded object describing an LLM endpoint.

| Field           | Type     | Required | Notes                                                         |
| --------------- | -------- | -------- | ------------------------------------------------------------- |
| `provider`      | `string` | Yes      | `"lm-studio"` or `"openai"`                                   |
| `model`         | `string` | Yes      | Model name as recognised by the provider                      |
| `baseUrl`       | `string` | No       | Override the default API URL (required for LM Studio)         |
| `apiKey`        | `string` | No       | API key — stored encrypted; masked as `***` in read responses |
| `contextWindow` | `number` | No       | Token budget for this model (default: 8192)                   |

### `CompanyUser`

Represents a human user associated with a company. Used for query routing.

| Field              | Type                               | Required | Notes                                           |
| ------------------ | ---------------------------------- | -------- | ----------------------------------------------- |
| `companyId`        | UUID string                        | Yes      | Parent company                                  |
| `identifier`       | `string`                           | Yes      | OIDC subject claim or email address             |
| `name`             | `string`                           | No       | Display name                                    |
| `memberType`       | `"creator" \| "owner" \| "member"` | Yes      |                                                 |
| `roles`            | `string[]`                         | Yes      | Role names this user covers (for query routing) |
| `knowledgeDomains` | `string[]`                         | Yes      | Domain tags (for query routing)                 |

---

## Validating JSON before using the CLI

The `set-company` and `set-role` commands accept arbitrary JSON and forward it to the server. Validating locally before sending avoids a round-trip on malformed input.

### Option 1 — VS Code (recommended for interactive editing)

Install the [Even Better TOML / YAML / JSON](https://marketplace.visualstudio.com/items?itemName=tamasfe.even-better-toml) extension or use the built-in JSON language server. Add a `$schema` property pointing at a small wrapper schema (see below), or configure a workspace JSON schema association:

Add to `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/companies/*.json"],
      "url": "./schemas/schema.json",
      "schema": { "$ref": "#/definitions/LcpCompany" }
    },
    {
      "fileMatch": ["**/roles/*.json"],
      "url": "./schemas/schema.json",
      "schema": { "$ref": "#/definitions/LcpRole" }
    }
  ]
}
```

VS Code will then highlight missing required fields and type mismatches inline as you edit.

### Option 2 — CLI validation with `ajv-cli`

```bash
# Install once (not in this repo's devDependencies — run globally)
npm install -g ajv-cli ajv-formats

# Validate a company file
ajv validate \
  -s schemas/schema.json \
  --ref '#/definitions/LcpCompany' \
  -d my-company.json

# Validate a role file
ajv validate \
  -s schemas/schema.json \
  --ref '#/definitions/LcpRole' \
  -d my-role.json
```

`ajv-cli` prints a list of validation errors with JSON Pointer paths if the file is invalid, or exits 0 with no output if it is valid.

### Option 3 — inline Node.js (no extra install)

AJV is a transitive dependency of this repo. You can validate without installing anything extra:

```bash
node -e "
const Ajv = require('ajv');
const schema = require('./schemas/schema.json');
const data = require('./' + process.argv[1]);
const typeName = process.argv[2] ?? 'LcpCompany';
const ajv = new Ajv({ strict: false });
const valid = ajv.validate(schema.definitions[typeName], data);
if (valid) { console.log('Valid'); process.exit(0); }
else { console.error(ajv.errorsText()); process.exit(1); }
" my-company.json LcpCompany
```

---

## Example: minimal company JSON

```json
{
  "slug": "acme",
  "name": "Acme Corp",
  "description": "Builds widgets for everyone.",
  "llmDefault": {
    "provider": "lm-studio",
    "model": "qwen3-8b",
    "baseUrl": "http://localhost:1234/v1",
    "contextWindow": 8192
  }
}
```

```bash
# Validate
ajv validate -s schemas/schema.json --ref '#/definitions/LcpCompany' -d acme.json

# Apply
./scripts/dev/lcp-cli.sh -u alice set-company -i "$(cat acme.json)"
```

## Example: minimal role JSON

```json
{
  "companyId": "00000000-0000-0000-0000-000000000001",
  "name": "analyst",
  "description": "Performs financial analysis and produces written reports.",
  "systemPromptTemplate": "You are {{name}}, a financial analyst at {{companyName}}.",
  "knowledgeDomains": ["finance", "reporting"],
  "mcpServerList": ["lcp-mcp-storage", "lcp-mcp-memory"]
}
```

```bash
ajv validate -s schemas/schema.json --ref '#/definitions/LcpRole' -d analyst-role.json
./scripts/dev/lcp-cli.sh -u alice set-role -c 00000000-0000-0000-0000-000000000001 -i "$(cat analyst-role.json)"
```

---

## Keeping the schema current

The pre-push git hook regenerates the schema automatically before each push and will block the push if the output differs from what is already committed. To regenerate manually at any time:

```bash
npm run schema:generate
```

If you add or change a field on any entity in `libs/lcp-shared/src/models/`, regenerate the schema and commit the updated `schemas/schema.json` alongside the entity change.
