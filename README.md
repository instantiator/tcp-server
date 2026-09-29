# Tiny Computer People

TCP manages one or more companies of AI agents that collaborate to complete tasks.

[![CI](https://github.com/instantiator/tcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/instantiator/tcp-server/actions/workflows/ci.yml)

![Isometric view](docs/screenshots/000.browser.company.isometric-view.png)

## Quick start

Get started by cloning this repository and launching the setup wizard.

```bash
git clone https://github.com/instantiator/tcp-server.git
cd tcp-server ./scripts/setup-wizard.sh
```

The wizard checks your prerequisites, installs dependencies, asks a few configuration questions, and starts the stack — then prints the service URLs and sign-in credentials. See **[Your first company](docs/your-first-company.md)** for what to do next.

> [!TIP]
> To clear down your database and use pre-existing test data, use:
> 
> ```bash
> ./scripts/start-dev.sh --reset
> ```

## Key concepts

| Entity     | Definition                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| Company    | A collection Roles, with shared resources, that can be tasked.                 |
| Role       | A dataset giving an Agent a set of expertise to draw from.                     |
| Agent      | An instance of an LLM, given a Role, and an Assignment.                        |
| Task       | A high level task for a company to achieve.                                    |
| Plan       | A series of Assignments designed to complete a task.                           |
| Assignment | A smaller piece of a Task, given to an Agent with a specific Role to complete. |

### How it fits together

Create a company, and add some roles. Give each role an identity and some knowledge. When ready, create a new Task. The planning Agent will pick it up, create a Plan, and agents will start taking assignments. When all Assignments in the Plan are complete, a finalisation Agent runs - checking and preparing the final Task outputs. When this is done, they'll store the result in the company's shared document store, ready for you to retrieve.

## Documentation

Good starting points...

* [Documentation index](docs/index.md)
* [Development](docs/development.md)
