# JSON Schema Reference

This document covers two related but distinct topics:

- **`schemas/schema.json`** — generated from the TypeORM entity models; describes database/response shapes; used for CLI pre-flight validation and VS Code schema inference.
- **DTO classes** — TypeScript classes in `apps/lcp-server/src/api/dto/`; define the exact fields accepted by each REST endpoint; validated at runtime by the server's `ValidationPipe`.

---

## Request body validation (DTOs)

Every endpoint that accepts a request body uses a dedicated DTO (Data Transfer Object) class annotated with [`class-validator`](https://github.com/typestack/class-validator) decorators. The server applies `ValidationPipe` globally (registered in `AppModule` via `APP_PIPE`), so any request with missing required fields or wrong types is rejected with **HTTP 400** before reaching the business logic. The response body includes a human-readable `message` array listing each failing constraint.

### DTO source files

| File                                              | DTOs                                              |
| ------------------------------------------------- | ------------------------------------------------- |
| `apps/lcp-server/src/api/dto/llm-config.dto.ts`   | `LlmConfigDto`                                    |
| `apps/lcp-server/src/api/dto/company.dto.ts`      | `CreateCompanyDto`, `UpdateCompanyDto`            |
| `apps/lcp-server/src/api/dto/role.dto.ts`         | `CreateRoleDto`, `UpdateRoleDto`                  |
| `apps/lcp-server/src/api/dto/company-user.dto.ts` | `CreateCompanyUserDto`, `UpdateCompanyUserDto`    |
| `apps/lcp-server/src/api/dto/agent.dto.ts`        | `StartAgentDto`, `StartChatDto`, `SendMessageDto` |
| `apps/lcp-server/src/api/dto/conversation.dto.ts` | `ConversationReplyDto`                            |
| `apps/lcp-server/src/api/dto/internal.dto.ts`     | `PauseDto`, `CompleteDto`                         |

### DTO field reference

#### `CreateCompanyDto` — `POST /api/company`

| Field                  | Type           | Required | Constraints                                                           |
| ---------------------- | -------------- | -------- | --------------------------------------------------------------------- |
| `slug`                 | `string`       | Yes      | Non-empty                                                             |
| `name`                 | `string`       | Yes      | Non-empty                                                             |
| `description`          | `string`       | Yes      | Non-empty                                                             |
| `llmConfig`            | `LlmConfigDto` | No       | Nested object                                                         |
| `embeddingConfig`      | `LlmConfigDto` | No       | Nested object                                                         |
| `companyContext`       | `string`       | No       |                                                                       |
| `systemPromptTemplate` | `string`       | No       | Default fallback for roles that leave theirs blank                    |
| `mcpServerList`        | `string[]`     | No       | Additive — combined with the system registry and each role's own list |
| `timezone`             | `string`       | No       | IANA name; display/prompt-localization only, never storage            |

#### `UpdateCompanyDto` — `PUT /api/company/:id`

All fields optional. Non-null strings must be non-empty. Omitted fields are not changed; pass `null` to clear a nullable field (e.g. `llmConfig`).

#### `CreateRoleDto` — `POST /api/role`

| Field                  | Type           | Required | Constraints                                                          |
| ---------------------- | -------------- | -------- | -------------------------------------------------------------------- |
| `companyId`            | UUID string    | Yes      | Must be a valid UUID                                                 |
| `name`                 | `string`       | Yes      | Non-empty                                                            |
| `description`          | `string`       | Yes      | Non-empty                                                            |
| `systemPromptTemplate` | `string`       | No       | Blank/omitted falls back to the company's, then the baked-in default |
| `knowledgeDomains`     | `string[]`     | Yes      | Array of strings                                                     |
| `mcpServerList`        | `string[]`     | Yes      | Array of strings                                                     |
| `llmConfig`            | `LlmConfigDto` | No       | Nested object                                                        |
| `rolePrompt`           | `string`       | No       |                                                                      |

#### `LlmConfigDto` — nested in company and role DTOs

| Field           | Type     | Required | Constraints                      |
| --------------- | -------- | -------- | -------------------------------- |
| `provider`      | `string` | Yes      |                                  |
| `model`         | `string` | Yes      |                                  |
| `baseUrl`       | `string` | No       |                                  |
| `apiKey`        | `string` | No       | Stored masked; returned as `***` |
| `contextWindow` | `number` | No       |                                  |

#### `CreateCompanyUserDto` — `POST /api/company/:id/users`

| Field              | Type                               | Required | Constraints                   |
| ------------------ | ---------------------------------- | -------- | ----------------------------- |
| `identifier`       | `string`                           | Yes      | Non-empty (OIDC sub or email) |
| `memberType`       | `"creator" \| "owner" \| "member"` | Yes      | Exact string match            |
| `name`             | `string`                           | No       |                               |
| `roles`            | `string[]`                         | No       |                               |
| `knowledgeDomains` | `string[]`                         | No       |                               |

#### `PauseDto` — `POST /internal/pause`

| Field       | Type                                   | Required    | Constraints                                   |
| ----------- | -------------------------------------- | ----------- | --------------------------------------------- |
| `type`      | `"user_input" \| "agent_consultation"` | Yes         |                                               |
| `agentId`   | UUID string                            | Yes         |                                               |
| `question`  | `string`                               | Yes         | Non-empty                                     |
| `context`   | `string`                               | No          |                                               |
| `companyId` | UUID string                            | Conditional | Required when `type === "agent_consultation"` |
| `roleName`  | `string`                               | Conditional | Required when `type === "agent_consultation"` |

### Do we need a generated DTO schema?

The DTO classes use [`class-validator`](https://github.com/typestack/class-validator) decorators, which are TypeScript decorator metadata — they are not reflected in `ts-json-schema-generator` output. A generated DTO schema would capture field names and types but would miss constraints like `@IsNotEmpty()`, `@IsUUID()`, and `@ValidateIf()`.

The authoritative source for DTO validation rules is the DTO source files listed above. When the server returns `400 Bad Request`, the `message` array in the response body explains exactly which fields failed and why — this is the practical validation feedback loop for API clients.

For static tooling (e.g. Postman schemas, OpenAPI), the DTO tables above cover the required/optional split. If a machine-readable request schema becomes a priority, the recommended approach is to add an `@ApiProperty()` annotation (NestJS Swagger) and generate an OpenAPI spec — that approach captures decorator constraints in a standard format.

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

| Field                  | Type                      | Required | Notes                                                                                                                                      |
| ---------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `slug`                 | `string`                  | Yes      | URL-safe identifier; globally unique                                                                                                       |
| `name`                 | `string`                  | Yes      | Display name                                                                                                                               |
| `description`          | `string`                  | Yes      | One-sentence description                                                                                                                   |
| `companyContext`       | `string`                  | No       | Injected into every agent prompt as part 2                                                                                                 |
| `llmConfig`            | [`LlmConfig`](#llmconfig) | No       | Default LLM for all roles that don't override; company/role both implement `WithLlmConfig`                                                 |
| `embeddingConfig`      | [`LlmConfig`](#llmconfig) | No       | Embedding model (can differ from the chat LLM)                                                                                             |
| `systemPromptTemplate` | `string`                  | No       | Default fallback for roles that leave theirs blank; falls back to a baked-in default if also blank                                         |
| `mcpServerList`        | `string[]`                | No       | Additive extra servers, unioned with the system registry and each role's own list                                                          |
| `timezone`             | `string`                  | No       | IANA name (e.g. `Europe/London`); CLI/UI display and prompt localization only — storage and the LLM's `{{datetime}}` anchor are always UTC |

### `LcpRole`

Represents an agent role within a company. Used by `set-role`.

| Field                  | Type                      | Required | Notes                                                                                                                                                                                                |
| ---------------------- | ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companyId`            | UUID string               | Yes      | Must match an existing company                                                                                                                                                                       |
| `name`                 | `string`                  | Yes      | Human-readable role name                                                                                                                                                                             |
| `description`          | `string`                  | Yes      | Shown to other agents via `list_available_contacts`                                                                                                                                                  |
| `systemPromptTemplate` | `string`                  | No       | Blank/omitted resolves via role → company → baked-in default. Supports `{{name}}`, `{{description}}`, `{{date}}`, `{{datetime}}`, `{{timezone}}`, `{{localDatetime}}`, `{{companyId}}`, `{{roleId}}` |
| `knowledgeDomains`     | `string[]`                | Yes      | Tags for query routing (e.g. `["finance","legal"]`)                                                                                                                                                  |
| `mcpServerList`        | `string[]`                | Yes      | MCP server names the role can use, additive with the company's and system's                                                                                                                          |
| `llmConfig`            | [`LlmConfig`](#llmconfig) | No       | Per-role LLM override; falls back to company, then environment                                                                                                                                       |
| `rolePrompt`           | `string`                  | No       | Additional context injected at the start of each run                                                                                                                                                 |

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
  "llmConfig": {
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
./lcp-cli.sh -u alice set-company -i "$(cat acme.json)"
```

## Example: minimal role JSON

```json
{
  "companyId": "00000000-0000-0000-0000-000000000001",
  "slug": "analyst",
  "name": "analyst",
  "description": "Performs financial analysis and produces written reports.",
  "systemPromptTemplate": "You are {{name}}, a financial analyst at {{companyName}}.",
  "knowledgeDomains": ["finance", "reporting"],
  "mcpServerList": ["lcp-mcp-storage", "lcp-mcp-memory"]
}
```

```bash
ajv validate -s schemas/schema.json --ref '#/definitions/LcpRole' -d analyst-role.json
./lcp-cli.sh -u alice set-role -c 00000000-0000-0000-0000-000000000001 -i "$(cat analyst-role.json)"
```

---

## Keeping the schema current

The pre-push git hook regenerates the schema automatically before each push and will block the push if the output differs from what is already committed. To regenerate manually at any time:

```bash
npm run schema:generate
```

If you add or change a field on any entity in `libs/lcp-shared/src/models/`, regenerate the schema and commit the updated `schemas/schema.json` alongside the entity change.
