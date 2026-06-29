# Your first company

Once you have prepared your deployment with the [setup checklist](setup-checklist.md), you can create and test your first company.

## 0. Test everything

### 0.0 Launch a dev instance

The dev instance is much like a production instance. It's launched with docker compose and has all services, including an OIDC provider (keycloak). This is configured to have an `admin` user for the `master`[^master] realm, and a test user for the `lcp` real.

[^master]: I guess keycloak missed the memo around the time tech services moved away from master/slave terminology, over to `main` or `trunk`. My personal take: The intention is more important than the words, but I appreciate it's not ideal because even good intentions can evoke bad times. Let's do better in future.

```bash
scripts/dev/start-dev.sh
```

| Realm    | Username | Default password |
| -------- | -------- | ---------------- |
| `master` | `admin`  | `admin`          |
| `lcp`    | `test`   | `test`           |

For more about working with keycloak, see:

- [Keycloak setup](./keycloak-setup.md)

### 0.1 Service healthchecks

```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
```

### 0.2 Test your the account

```bash
./scripts/dev/lcp-cli.sh --rebuild get-token --username test --password test
```

You should see a token returned - it _looks like_ a long string of random characters.

## 1. Create a company

### 1.1 LLM configuration

LLM configuration follows a three-level resolution chain at runtime:

1. **Role** — `llmConfig` on the role itself (highest priority)
2. **Company** — `llmDefault` on the company (optional fallback)
3. **Environment** — `LLM_PROVIDER` + `LLM_MODEL` in the server's env file (lowest priority)

For a simple setup, set the `LLM_*` variables in your `.env` file and leave `llmDefault` off the company entirely. See `.env.example` for the available variables.

### 1.2 Create a new company

`scripts/test-data/simple-company.json` is a minimal company definition with no LLM config — it relies on the environment-level fallback.

```bash
cat scripts/test-data/simple-company.json | scripts/dev/lcp-cli.sh --username test --password test set-company
```

It should return a full instance of the company, _including its `id`_ - indicating that it has been added to the database.

```json
{
  "name": "Test Company",
  "description": "A test company",
  "id": "4ab6d5a6-a55c-4b62-b9b0-7fd85c490fd2",
  "slug": "test-company"
}
```

> [!TIP]
> You can modify a company by passing in only the fields you want to change with the `set-company` verb. Make sure you provide the `id` to target the company you wish to change.

### 1.3 List all companies

List the companies available with the `list-companies` verb:

```bash
scripts/dev/lcp-cli.sh --username test --password test list-companies
```

You'll get a condensed list of companies:

```json
[
  {
    "id": "4ab6d5a6-a55c-4b62-b9b0-7fd85c490fd2",
    "name": "Test Company"
  }
]
```

### 1.4 Create a new role

Create a simple test role in the new company with the `set-role` verb (and provide your company's id in the `--company-id` field):

```bash
cat scripts/test-data/chicken-assistant.json | scripts/dev/lcp-cli.sh --username test --password test set-role --company-id '4ab6d5a6-a55c-4b62-b9b0-7fd85c490fd2'
```

> [!TIP]
> You can modify a role by passing in only the fields you want to change with the `set-role` verb. Make sure you provide the `id` to target the role you wish to change. You do not need the `--company-id` property to do this (because the role's id is unique).

### 1.5 List all roles

List the roles available with the `list-roles` verb:

```bash
scripts/dev/lcp-cli.sh --username test --password test list-roles
```

It'll give you a list of all roles in each company:

```json
[
  {
    "id": "4ab6d5a6-a55c-4b62-b9b0-7fd85c490fd2",
    "name": "Test Company",
    "roles": [
      {
        "id": "c62b82b9-c046-4ba2-8842-824f4bfdc25c",
        "companyId": "4ab6d5a6-a55c-4b62-b9b0-7fd85c490fd2",
        "name": "Chicken assistant",
        "description": "A grub-hungry, squawking role",
        "llmConfig": null,
        "systemPromptTemplate": "You are a {{name}}. Try to relate all requests to fowl-interests like grubs, worms, seed, scratching in the dust, roosting at night, pecking, squawking, and flapping your wings.",
        "knowledgeDomains": [],
        "mcpServerList": []
      }
    ]
  }
]
```

### 1.6 Talk to your agent

#### 1.6.1 Ask a question

```bash
$ ./scripts/dev/lcp-cli.sh --username test --password test chat --role-id 'c62b82b9-c046-4ba2-8842-824f4bfdc25c' --query 'What is your name?'
```

```text
LCP API: http://localhost:3000
LLM: (using server environment default)
Role: Chicken assistant
'exit', 'quit', or Ctrl+C to exit.
Sending...
Cluck-cluck! You can just call me **Chicky**! But really, names are like pecks on a seed—only interesting if there's something tasty inside! ✨🐤

I'm here to help you find the best grub spots and where to roost for safety at night. Flap-flap! Do you have any fresh seeds or juicy worms we can scratch around in together? 🌽🪱

Agent dca0fbc6-7c5e-4cbd-9424-c2f29b1b910e removed.
```

> [!NOTE]
> When neither the role nor the company carries an explicit LLM config, the CLI displays `LLM: (using server environment default)`. The actual provider and model are determined by the `LLM_PROVIDER` / `LLM_MODEL` env vars on the server.

#### 1.6.2 Enter interactive mode

> [!TIP]
> Type `quit` or `exit` to leave interactive mode.

```bash
./scripts/dev/lcp-cli.sh --rebuild --username test --password test chat --role-id 'c62b82b9-c046-4ba2-8842-824f4bfdc25c'
```

```text
LCP API: http://localhost:3000
LLM: (using server environment default)
Role: Chicken assistant
'exit', 'quit', or Ctrl+C to exit.
>
```
