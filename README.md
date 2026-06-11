# Little Computer People (LCP) server

LCP manages one or more companies of agents.

## Companies

A company consists of several specialists or generalists, each provided with:

- overview of the organisation
- identity prompt
- reference material
- personal knowledge database
- access to tools
- membership of a group where they can initiate conversations with other agents

## Tasks

Tasks are given to the company, who then work collaboratively to resolve them.

An agent creates a plan incorporating knowledge of agents in the company and their skills.

Each plan contains a number of tasks, arranged into a graph, and each plan has an agent responsible for:

- plan requirements gathering
- plan delivery
- plan quality control

Each task is a part of a plan, and each task has agents responsible for:

- task delivery
- task quality control

## Technologies

- [NestJS](https://nestjs.com/) (server framework)
- [TypeORM](https://typeorm.io/) (database ORM)
- [sqlite3](https://sqlite.org/) (default database)
- [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator) (schema generation)
- [License Report](https://github.com/bepo65/license-report) (dependency documentation)
- [DeepAgents](https://github.com/langchain-ai/deepagentsjs) (agent controls)

## Invocations

| Invocation                  | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `npm run build`             | Compiles the server to `dist/`                         |
| `npm run format`            | Formats the code with `prettier`                       |
| `npm run start`             | Starts a server on port `3000`                         |
| `npm run start:dev`         | Starts a server                                        |
| `npm run start:debug`       | Starts a server with debug options (and monitors)      |
| `npm run start:prod`        | Starts the last compiled server                        |
| `npm run lint`              | Runs a linter against the project                      |
| `npm run test`              | Runs all tests                                         |
| `npm run test:watch`        | Runs all tests (and monitors for changes)              |
| `npm run test:cov`          | Runs all tests and measures code coverage              |
| `npm run test:debug`        | Runs all tests with additional debug information       |
| `npm run test:e2e`          | Runs the end-to-end tests                              |
| `npm run schema:generate`   | Regenerates [schemas/schema.json](schemas/schema.json) |
| `npm run licenses:generate` | Regenerates [docs/licenses.md](docs/licenses.md)       |
