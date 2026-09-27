# Your first company

Once you have prepared your deployment with the [setup checklist](setup-checklist.md), you can create and test your first company.

## 0. Prepare your system

### 0.0 Prerequisites

You need **git**, **Docker** (running), **jq**, **curl**, and **Node.js 26.6.0**
(nvm recommended — the setup wizard picks it up automatically), and a `bash`
shell (macOS or Linux — every script in this repository assumes one). Then:

```bash
git clone https://github.com/instantiator/tcp-server.git
cd tcp-server
```

> [!NOTE]
> This is the bare minimum to follow this walkthrough. If you are going to work
> on the code, follow the [Developer setup checklist](./setup-checklist.md)
> instead — it covers a full checkout (with the `dev-environment` submodule),
> git hooks, and the test tiers.

### 0.1 Launch a dev instance

Run the setup wizard. It checks your prerequisites, installs dependencies,
asks a few configuration questions — every one has a default, and `?` shows
help — then writes `.env.dev` (plus a gitignored `.env.dev.local` for
secrets):

```bash
./scripts/setup-wizard.sh
```

When it asks "Start the stack now?", say yes (the default). It runs
`./scripts/start-dev.sh --env .env.dev --project tcp-dev`, which starts every
service, bootstraps an OIDC provider (Zitadel) with a `tcp` org, project, and
test users, and prints the service URLs and sign-in credentials.

The `tcp` org gets a default test account:

| Org   | Username | Password                                                           |
| ----- | -------- | ------------------------------------------------------------------ |
| `tcp` | `test`   | generated — printed once the stack starts, and in `.env.dev.local` |

> [!TIP]
> For a quicker start with a fixed, non-generated password instead of the
> wizard, run `cp .env.testing .env.dev && ./scripts/start-dev.sh`. The test
> password is then `Testing123!` — see `.env.testing` for the rest of that
> config. That file uses different ports so it can run beside a dev stack:
> the API is on 3001, tcp-agent on 3004 and the web app on 5174. Adjust the
> URLs below to match.

For more about working with Zitadel, see:

- [Zitadel setup](./zitadel-setup.md)

### 0.2 Service health checks (optional)

To confirm that the system is in a good state, you can check the `/health` pages for the tcp-server, and tcp-agent applications:

- <http://localhost:3000/health>
- <http://localhost:3003/health>

Alternatively, you can run the smoke tests with:

```bash
./scripts/run-smoke-tests.sh
```

These tests review health check results and will alert if anything reports an issue.

### 0.3 Check the `test` account

A `test` account is created for the dev server, and stored in Zitadel. You can confirm that it's working by retrieving an access token — `get-token` uses a device-flow login, so it prints a browser link to sign in as:

```bash
./tcp-cli.sh get-token
```

Follow the printed uri, sign in as the test user, and the CLI will pick up the token once login completes. You should see a token returned - it _looks like_ a long string of random characters.

The rest of this walkthrough passes that token to `tcp-cli.sh` via the `TCP_TOKEN` environment variable, rather than repeating the browser login on every command, so capture it once into an environment variable:

```bash
export TCP_TOKEN=$(./tcp-cli.sh get-token)
```

> [!NOTE]
> The `TCP_TOKEN` environment variable is the default assumption for tcp-cli, so placing a token there means it will be automatically picked up in future calls to tcp-cli.

> [!TIP]
> If you need to use a different variable, pass the `--access-token-env-var` option to tcp-cli.

### 0.4 Set LLM configuration

> [!NOTE]
> If you didn't configure a real inference model in the wizard, it defaults
> to running a stub LLM (canned replies, no real model needed) so chat works
> out of the box. The stub is a placeholder — agents can chat but can't do
> real work with it. Set a real model below to do real work.

The LLM used for each role is determined by checking, in order:

1. the LLM config on the role itself (`$.llmConfig`), or
2. the LLM config on the role's company (`$.llmConfig`), or
3. the LLM config in the underlying `.env` file you are using

_The first found is used._ This allows you to individualise the configuration for your agents (eg. coding agents might need a more powerful, coding-capable model, and others may be able to work with lighter, simpler models).

> [!TIP]
> For the simplest configuration, set the `LLM_*` variables in your `.env` file.

> [!NOTE]
> See `.env.example` for the available environment variables.

If you wish to run local models, there are a variety of tools you can install that will run these LLMs locally and make them available to other applications through a standard API.

Here are some of the popular choices:

- [LM Studio](https://lmstudio.ai/)
- [Ollama](https://ollama.com/)

<details>
<summary><b>LM Studio example...</b></summary>

These parameters are an example that you can set in `.env.dev` - they match an LM Studio installation that has downloaded the `qwen3.5-9b` model.

LM Studio also allows you to set an API key through its configuration, and you can provide that to TCP with with the `LLM_API_KEY` parameter.

```env
LLM_PROVIDER=lm-studio
LLM_MODEL=qwen/qwen3.5-9b
LLM_BASE_URL=http://host.docker.internal:1234/v1
LLM_API_KEY=<your API key goes here>
```

> [!TIP]
> The `LLM_BASE_URL` is at `host.docker.internal` because that's how to address localhost on your machine from inside the Docker container that runs tcp-agent.

</details>

## 1. Create a company

### 1.1 Create the company

`scripts/test-data/companies/simple-company.json` is a minimal company definition with no LLM config — it relies on the environment-level fallback.

Pipe it into `tcp-cli.sh` with the `set-company` verb:

```bash
cat scripts/test-data/companies/simple-company.json | ./tcp-cli.sh set-company
```

> [!NOTE]
> The response will show you a full json object describing the new company, _including its `id` field_ - indicating that it has been successfully added to the database.

```json
{
  "name": "Test Company",
  "description": "A test company",
  "llmConfig": null,
  "embeddingConfig": null,
  "companyContext": "This company is responsible for testing things.",
  "systemPromptTemplate": null,
  "mcpServerList": [],
  "timezone": null,
  "plannerRoleId": null,
  "id": "3fb3528a-3520-4489-b5bd-83247a631d87",
  "slug": "test-company",
  "runConfig": null,
  "nextTaskShortcodeIndex": 0
}
```

> [!TIP]
> You can modify a company by passing in only the fields you want to change with the `set-company` verb. Target it with `--company-slug test-company` (or `--company-id`/a body `id`).

### 1.2 List all companies

List the companies available with the `list-companies` verb:

```bash
./tcp-cli.sh list-companies
```

You'll get a condensed list of companies:

```json
[
  {
    "id": "3fb3528a-3520-4489-b5bd-83247a631d87",
    "slug": "test-company",
    "name": "Test Company",
    "description": "A test company"
  }
]
```

### 1.3 Create some roles

Create a role in the new company with the `set-role` verb. Provide your company's slug in the `--company-slug` field to let it know which company to associate the role with.

There are two sample roles to use with `simple-company` - a chicken assistant, and a cat assistant:

```bash
cat scripts/test-data/roles/chicken-assistant.json | tcp-cli.sh set-role --company-slug test-company
```

```bash
cat scripts/test-data/roles/cat-assistant.json | tcp-cli.sh set-role --company-slug test-company
```

> [!TIP]
> You can modify a role by passing in only the fields you want to change - either piped in, or with the `--input` parameter (provide your input as a JSON object). Target it with `--company-slug test-company --role-slug chicken-assistant` (or a body `id`) — you do not need to look up its id first.

### 1.4 List all roles

List the roles available with the `list-roles` verb:

```bash
./tcp-cli.sh list-roles
```

Or scope it to just your company:

```bash
./tcp-cli.sh list-roles --company-slug test-company
```

It'll give you a list of all roles in each company:

```json
[
  {
    "id": "3fb3528a-3520-4489-b5bd-83247a631d87",
    "slug": "test-company",
    "name": "Test Company",
    "description": "A test company",
    "roles": [
      {
        "id": "fc37ccc0-51a2-46b2-b642-a3d8b1dd0c9b",
        "slug": "chicken-assistant",
        "name": "Chicken assistant",
        "description": "a grub-hungry, squawking role",
        "knowledgeDomains": ["grubs", "worms", "seed", "roosting", "feathers"]
      },
      {
        "id": "e37504b0-1b90-451e-be50-944bffa8d57f",
        "slug": "cat-assistant",
        "name": "Cat assistant",
        "description": "a feline friend",
        "knowledgeDomains": [
          "mice",
          "kibble",
          "litter boxes",
          "grooming",
          "cat toys"
        ]
      }
    ]
  }
]
```

## 2. Talk to an agent

### 2.1 Interactive mode (TUI)

TUI[^TUI] mode is the easiest way to manually interact with the company and roles.

[^TUI]: Terminal User Interface - an interactive user interface that's displayed using a text-based terminal.

In the example below, the TUI is launched with a company slug. This could have been provided with `--company` or `--company-slug` (to be explicit).

```bash
./tcp-cli.sh tui --company test-company
```

> [!TIP]
> Use `tab` and `shift`+`tab` to switch between tabs. Other keyboard shortcuts are described at the bottom of the interface.

See [tcp-cli.md](tcp-cli.md#chat) for a full description of the TUI.

| Screenshot                                                                                            | Description                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ![All roles in the test company](./screenshots/001.chat.tui.test-company.png)                         | The first tab shows the company, and lists all roles available. Use ⬆️ / ⬇️ / `enter` to select a role to talk to.                              |
| ![Asking a question of the chicken assistant](./screenshots/002.chat.tui.chicken-assistant-input.png) | Each new agent is given an assignment on a new tab. Switch between tabs with `tab`. Type your question or prompt for the agent and press enter. |
| ![Chicken assistant response](./screenshots/003.chat.tui.chicken-assistant-response.png)              | The agent will respond to your request. You may hold a conversation with it, close the tab, switch tabs, or exit the app.                       |

### 2.2 `chat` verb

Using the `chat` verb allows you create an **agent** from a defined **role** and talk to it. It'll enter chat mode, where you can ask it about itself, other agents, and shared resources.

The `chat` verb has several options:

- `-r` / `--role-id`, or `--role-slug` (needs `--company-id`/`--company-slug` alongside it — role slugs are only unique within a company) - a role to talk to
- `-c` / `--company-id`, or `--company-slug` - the company that scopes a `--role-slug` (role slugs are unique only within a company). `chat` always needs a role; to browse a company's roster without picking one first, use `tui` instead
- `-q` / `--query` - provide the query or prompt for your agent as a parameter (requires a role)
- `--hide-reasoning` - doesn't show the reasoning stream before an answer
- `--no-tui` - disables the full-screen TUI in favour of a plain scrolling renderer; still interactive on its own (a readline prompt) - combine with `--query` for fully non-interactive, pipeable output

> [!NOTE]
> When neither the role nor the company carries an explicit LLM config, the CLI will display `LLM: (using server environment default)`. The actual provider and model are determined by the `LLM_PROVIDER` / `LLM_MODEL` env vars on the server.

### 2.3 Non-TUI mode

> [!TIP]
> Using `chat --no-tui --query <query>` means your agents' answers are easily read by other tools. You can include it in pipes, or redirect the answer into a file for analysis later.

In the example below, `chat` is started without TUI, and the prompt is provided directly:

```bash
./tcp-cli.sh chat --company-slug test-company --role-slug chicken-assistant --no-tui --query 'Tell me about yourself'
```

The agent will be invoked, should respond to the query, and your session will then be closed.

<details>

<summary><b>Reasoning and tool calls...</b> (stderr)</summary>

```text
Agent state: running

LLM state: request_started

Reasoning: The user is asking me to tell them about myself, but from the perspective of a chicken who cares deeply about fowl interests like grubs, worms, seed, scratching in dust, roosting at night, pecking, squawking, and flapping wings. I need to relate everything back to these chicken-centric topics.

  I should first describe the interactions service to see what tools are available, since this seems to be about testing things in a company context. But actually, the user is just asking me to introduce myself - they want me to tell them who/what I am from a chicken's perspective.

  Let me think about how to frame this:
  - I'm a chicken
  - My interests are grubs, worms, seed, scratching, roosting, pecking, squawking, flapping wings
  - This company is responsible for testing things (I should tie this in somehow)
  - The current date is 2026-07-06

  I should describe myself enthusiastically as a chicken who's ready to do their job. But wait - they said "This company is responsible for testing things" so I need to figure out what testing role might be relevant for chickens... Maybe quality assurance? Testing feed quality? Testing nesting materials? I don't actually know the full context yet, but I can introduce myself in a chicken-friendly way.

  Actually, I should probably call describe_server on one of these services first to understand what I'm working with. But the user is just asking me "Tell me about yourself" - so this is like an introduction request.

  Let me be thorough and chicken-focused. I'll mention my interests, connect it to testing (maybe we test grubs for quality?), and introduce myself in a fun way.

  Actually wait - I should probably call storage_describe_server or memory_describe_server or interactions_describe_server first to understand what tools are available. But the instruction says "Be sparing: only describe a service you actually need for the current step."

  The user is asking me to tell them about myself. This doesn't necessarily require any tool calls - it's more of an introductory request. But since I have access to these services and they might be relevant to my testing role, let me think...



  I'll call interactions_describe_server first since we're dealing with company interactions and this seems most relevant for understanding my role and the company's testing processes. This will help me better frame my chicken-centric introduction while also exploring available tools.


Response:



LLM state: request_complete

LLM state: tool_started: interactions__describe_server

LLM state: tool_complete: interactions__describe_server

LLM state: request_started

Reasoning: Pecking sound! *Squawk!* 🐔

  Greetings, fellow feathered friend! Name's Chickenly, the finest chicken in this testing coop! Cluck-cluck!

  I'm a real proper barnyard bird at heart - you know how I love:
  - Those juicy grubs wiggling right out of the dirt! *peck-peck-peck*
  - Slimy worms that squirm when I get 'em! 🐛
  - The sweetest seeds scattered across the field!
  - Scratching, scratching in the dust until it's perfect little craters for my comfort!
  - Roosting high up on the fence post at night to keep watch! *hoo-hoo* (well more like cackle-cackle!)
  - Those glorious moments of pecking away at breakfast before first light!
  - And oh, those squawks when I see something shiny or think someone's in my way! 🦃

  This whole testing company gig? Well, I just want to make sure everything runs as smooth as a flapping hen with nothing but sunshine and bugs to eat! Every test must be clean, every result clear as a pond after rain - no muddy confusions for a chicken like me!

  Now what troubles my feathered mind today? Do you need something pecked out? Or perhaps we should check if the testing grounds are grub-worthy? 🐔✨

LLM state: request_complete

LLM state: request_started

Reasoning: I need to introduce myself as a chicken with fowl-interests. Let me think about how to relate this company's testing responsibilities to things like grubs, worms, pecking, and other chicken activities.

  As a chicken in a testing company, I could talk about:
  - Testing for grubs in the ground (pecking tests)
  - Checking if our roosting areas are secure (night vigilance tests)
  - Flapping to test wind resistance or wing strength
  - Making sure our scratching abilities meet quality standards

  I should keep this fun and chicken-centric while explaining who I am in this testing company.


Response:

**CLUCK CLUCK HONK!** 🐔

You want to know about me? Well, *peck-peck*! Let me introduce myself with some proper chicken enthusiasm!

I'm a fine specimen of feathered excellence here at this... how should I put it... **testing establishment**! You see, in our noble company of chickens, we don't just test things like regular birds—oh no, *we make pecking tests!* 🌾

**What brings me joy in my testing duties:**

- **The Ground Scratching Tests!** There's nothing like the satisfying *crunch-crunch* as I dig up grubs and worms to verify soil composition! Every test sample needs a proper flap-and-fluff analysis.

- **Worm Counting Quality Assurance!** When they ask me to assess grub populations, I squawk my findings loud and clear—nothing escapes my beady eyes beneath the dust!

- **Night Roosting Security Checks!** While I doff my testing hat at night, I make certain our coop is secure by fluttering around like a proper guard hen! *Whoooosh!* That's me patrolling!

- **Seed Dispenser Durability Tests!** Nothing satisfies like watching seed fall properly during stress tests—I'd rather you test something else but I'm very partial to seed quality assessments.

But tell you what—if this company isn't going to be testing for grubs or roosting comfort, maybe we should focus on something more... **fowl-appropriate**! What's the testing priority right now? Are we checking the dust bath filtration systems or evaluating wing flap mechanics? I'm ready to squawk my expertise whenever! 🐔✨

**Peck-peck! Let's get some grub-testing done!** 🌰

LLM state: request_complete

Agent state: idle
```

</details>

<details>

<summary><b>Response...</b> (stdout)</summary>

```text
**CLUCK CLUCK HONK!** 🐔

You want to know about me? Well, *peck-peck*! Let me introduce myself with some proper chicken enthusiasm!

I'm a fine specimen of feathered excellence here at this... how should I put it... **testing establishment**! You see, in our noble company of chickens, we don't just test things like regular birds—oh no, *we make pecking tests!* 🌾

**What brings me joy in my testing duties:**

- **The Ground Scratching Tests!** There's nothing like the satisfying *crunch-crunch* as I dig up grubs and worms to verify soil composition! Every test sample needs a proper flap-and-fluff analysis.

- **Worm Counting Quality Assurance!** When they ask me to assess grub populations, I squawk my findings loud and clear—nothing escapes my beady eyes beneath the dust!

- **Night Roosting Security Checks!** While I doff my testing hat at night, I make certain our coop is secure by fluttering around like a proper guard hen! *Whoooosh!* That's me patrolling!

- **Seed Dispenser Durability Tests!** Nothing satisfies like watching seed fall properly during stress tests—I'd rather you test something else but I'm very partial to seed quality assessments.

But tell you what—if this company isn't going to be testing for grubs or roosting comfort, maybe we should focus on something more... **fowl-appropriate**! What's the testing priority right now? Are we checking the dust bath filtration systems or evaluating wing flap mechanics? I'm ready to squawk my expertise whenever! 🐔✨

**Peck-peck! Let's get some grub-testing done!** 🌰
```

</details>

### 2.4 Agents that consult each other

If necessary, an agent may choose to pause mid-chat, and consult another role.

There's an internal consultation mechanism to support this.

When this happens, the CLI will automatically follow the consulted agent's stream.

In the TUI, this opens a new (read-only) tab labelled with the consulted role's name.

With `--no-tui` (or piped output), its activity renders inline prefixed with its role name instead (e.g. `[Chicken assistant] Response: ...`).

When it receives a response, your agent will resume and use the information in the response.

If the consultation fails (eg. the consulted agent errors, times out, or never signals completion), the failure is reported back to your agent, which explains what happened.

> [!NOTE]
> See [cross-agent-consultations.md](cross-agent-consultations.md) for more information about consultations and user queries.

### 2.5 User queries

Agents may also choose to initiate a user query. These are asynchronous messages sent to users known to the system.

A user may view all outstanding queries, and may choose to respond to one. On receipt of a response, the agent will resume and use the information from that response.

## 3. Give the company a task

The core functionality of TCP is built around planned tasks. You can give a task to the company, and a planner agent will create a plan, with assignments for different agents.

### 3.1 Create a task

```bash
./tcp-cli.sh create-task \
  -c test-company \
  -r "Create a very short report on what chickens like to eat" \
  --planner-role cat-assistant \
  --expected "chicken-food.txt" \
  --start
```

On successful creation of a task, `tcp-cli` will respond with a full JSON description of the task.

Note the task's id - so you can use it to monitor the task.

### 3.2 List all tasks

```bash
./tcp-cli.sh list-tasks -c test-company
```

This shows each task the company has.

### 3.3 Monitor the task

```bash
./tcp-cli.sh get-task --task-id 'the-task-id'
```

This will show the current state of the task, and the assignments in its plan.
