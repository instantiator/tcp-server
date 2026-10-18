# Company template

This folder is a blank TCP company template. Edit it, zip it, and import it to
create a company. This file explains every part of the format. It is not
imported.

## Contents

- [Quick start](#quick-start)
- [Layout](#layout)
- [company.json](#companyjson)
- [context.md](#contextmd)
- [Roles](#roles)
- [Knowledge](#knowledge)
- [Models](#models)
- [Packaging and limits](#packaging-and-limits)
- [Importing](#importing)
- [Exporting](#exporting)
- [Versions](#versions)

## Quick start

1. Edit `company.json`: give the company a `slug`, `name` and `description`.
2. Write `context.md`: what the company does, for whom, and how it should work.
3. Add a role: create `roles/<slug>/role.json` and `roles/<slug>/prompt.md`.
4. Add knowledge documents to `knowledge/` (for every role) or to
   `roles/<slug>/knowledge/` (for one role).
5. Zip the folder and import it: in the web app, **New company → Import a zip
   file**, or `tcp-cli import-company <folder or zip>`.

## Layout

```text
company.json                 required: the format version and company fields
context.md                   optional: the company context
README.md                    optional: for people; not imported
LICENSES.md                  optional: written on export; not imported
<any other>.md at the top    optional: for people; not imported
knowledge/                   optional: knowledge for every role
roles/<slug>/role.json       required for each role
roles/<slug>/prompt.md       optional: the role's prompt
roles/<slug>/knowledge/      optional: knowledge for that role only
```

Anything else is refused, so a misplaced file is reported instead of being
silently skipped. Empty `.gitkeep` files are ignored.

## company.json

```json
{
  "formatVersion": 1,
  "slug": "my-company",
  "name": "My company",
  "description": "What the company is for, in one sentence.",
  "timezone": "Europe/London",
  "plannerRole": "planner",
  "systemPromptTemplate": null,
  "llmConfig": null,
  "embeddingConfig": null,
  "mcpServerToggles": { "records": true, "utilities": true }
}
```

| Field                  | Required | Meaning                                                                                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`        | yes      | Always `1` for this format.                                                                                                                               |
| `slug`                 | yes      | The company's address. Lower-case letters and digits joined by hyphens, such as `cottage-industry`. The importer can change it.                           |
| `name`                 | yes      | The company's name.                                                                                                                                       |
| `description`          | yes      | One sentence about the company. The gallery shows it.                                                                                                     |
| `timezone`             | no       | An IANA time zone, such as `Europe/London` or `UTC`.                                                                                                      |
| `plannerRole`          | no       | The slug of the role that plans tasks by default. It must match a folder in `roles/`.                                                                     |
| `systemPromptTemplate` | no       | Replaces the built-in system prompt for every role. Leave it out unless you know you need it.                                                             |
| `llmConfig`            | no       | The company's default chat model. See [Models](#models).                                                                                                  |
| `embeddingConfig`      | no       | The model that indexes knowledge for search. See [Models](#models).                                                                                       |
| `mcpServerToggles`     | no       | Turns built-in services on or off for every role: `storage`, `memory`, `interactions`, `tasks`, `utilities`, `records`. Leave one out to use the default. |

Unknown fields are refused, so a typo is reported rather than ignored.

## context.md

Plain text or Markdown that every agent in the company reads. Say what the
company does, who it serves, what matters, and any rules everyone must follow.
Keep it short: it is part of every prompt.

## Roles

A role is a kind of worker, such as "bookkeeper" or "listing writer". Each role
is a folder in `roles/`. The folder's name is the role's slug: lower-case
letters and digits joined by hyphens. `shared` is reserved.

`roles/<slug>/role.json`:

```json
{
  "name": "Bookkeeper",
  "description": "Keeps income and expenses, and prepares tax-year summaries.",
  "llmConfig": null,
  "systemPromptTemplate": null,
  "mcpServerToggles": null
}
```

| Field                  | Required | Meaning                                                                     |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `name`                 | yes      | The role's name.                                                            |
| `description`          | yes      | One sentence. The planner reads it when choosing who does each step.        |
| `llmConfig`            | no       | A model for this role only. The importer can drop it and use the company's. |
| `systemPromptTemplate` | no       | Replaces the system prompt for this role. Rarely needed.                    |
| `mcpServerToggles`     | no       | Like the company's, for this role only.                                     |

`roles/<slug>/prompt.md` is the role's own prompt. Write it to the role, as
"you". Say what it does, what it must not do, what it should use (its knowledge,
records tables, company resources), and what good work looks like. The platform
already explains tasks, steps and tools, so don't repeat that.

### The planner

Tasks are split into steps by a planner role. Name it in `company.json` as
`plannerRole`. Its prompt should help it plan well: what done looks like, steps
whose outputs feed the next, and enough detail for each step to stand alone.
The **Basic** template has a planner prompt you can copy.

## Knowledge

Knowledge documents are searched and quoted by agents while they work.

- `knowledge/` is read by every role.
- `roles/<slug>/knowledge/` is read by that role only.
- Folders inside these are not allowed.

Accepted files: `.md`, `.txt`, `.html`, `.pdf`, `.docx`, `.csv`, `.json`,
`.yaml`. Everything except `.md` is converted to Markdown on import, and gets a
title from the document. A converted file keeps its name with `.md` instead, so
`guide.pdf` and `guide.md` in one folder clash.

A `.md` file must already start with front matter holding a `title`:

```markdown
---
title: Selling online
source: https://www.gov.uk/online-and-distance-selling-for-businesses
license: OGL-UK-3.0
attribution: Contains public sector information licensed under the Open Government Licence v3.0.
retrieved: 2026-10-17
---

The document text.
```

`source`, `license` and `attribution` are optional, but say them when you know
them. They are shown wherever knowledge is listed, and written to `LICENSES.md`
when the company is exported. Use an [SPDX](https://spdx.org/licenses/)
identifier for the licence where one exists, such as `CC-BY-4.0` or
`OGL-UK-3.0`. Only include documents you may share, and follow their licence's
terms.

To give a PDF or Word file a licence, convert it to Markdown first and add the
front matter, or add the licence after import (`tcp-cli store-knowledge
--license`).

## Models

`llmConfig` and `embeddingConfig` look like this:

```json
{
  "provider": "openai-compatible",
  "model": "qwen3-8b",
  "baseUrl": "http://localhost:1234/v1"
}
```

- **Never put an API key in a template.** Templates are shared. A key found on
  import is dropped, with a warning.
- The model may not exist where the template is imported. The importer chooses
  their own, or keeps yours. Leaving models out is often best.
- A local or custom `baseUrl` must be allowed by the importing server.

## Packaging and limits

Zip the folder. The zip may hold the files at its top level, or inside one
folder (as when you zip the folder itself).

- At most 50 MB zipped, 200 MB unzipped, and 2,000 files.
- No absolute paths, `..`, or backslashes.
- Text files must be UTF-8.

## Importing

- **Web:** **Companies → New company**, then choose a template from the gallery
  or **Import a zip file**. You can change the name, address, time zone,
  context and models before importing, and choose whether each role keeps its
  own model.
- **CLI:** `tcp-cli import-company <zip or folder>`. Add `--preview` to see what
  would be created. `tcp-cli new-template <folder>` writes a copy of this blank
  template to start from.
- **API:** `POST /api/company/import/preview` and `POST /api/company/import`,
  multipart with `file` (the zip) and `options` (JSON).

If a company already has the template's slug, choose another slug or replace it.
Replacing deletes that company and everything in it.

## Exporting

Any member can export a company as a template: **Admin → Company → Export as
template**, or `tcp-cli export-company <company>`. Exports never include API
keys. Leave out models with **Include model settings** off (`--no-models`).

## Versions

`formatVersion` says which version of this format a template uses. A server
refuses a template newer than it understands, with a message saying so. Later
versions will add more, such as services, record tables, schedules and skills,
and will keep reading version 1.
