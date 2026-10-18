# Company templates

A company template is a company packaged as a zip: its details, its roles with
their prompts, and their knowledge. Import one to get a working company in a
minute. Export a company to share it, back up its setup, or start a new
template.

The format itself is documented in
[`templates/blank/README.md`](../templates/blank/README.md), which travels
inside every copy of the Blank template.

## Contents

- [The gallery](#the-gallery)
- [Sources](#sources)
- [Importing](#importing)
- [Exporting](#exporting)
- [Knowledge licences](#knowledge-licences)
- [Making your own](#making-your-own)
- [Settings](#settings)
- [Security](#security)

## The gallery

**Companies → New company** opens the gallery. From there you can:

- **Start from scratch**: the plain New company form.
- **Import a zip file**: a template you have.
- **Use this template**: any template from a source.
- **Download**: save a template as a zip, to read or change it.

The built-in templates are:

| Template         | Folder                        | What you get                                                                     |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Blank            | `templates/blank/`            | No roles. Its README is the format reference.                                    |
| Basic            | `templates/basic/`            | One planner role that plans each task and does the work.                         |
| Cottage industry | `templates/cottage-industry/` | Eight roles for a small UK home business, with 14 GOV.UK documents as knowledge. |

The CLI lists the same templates with `./tcp-cli.sh list-templates`.

## Sources

The gallery reads templates from three kinds of source:

- **Built in**: the `templates/` folder, copied into the tcp-server image.
- **A directory** on the server: each folder holding a `company.json`, and each
  `.zip` file, is a template. Set it in `TEMPLATE_SOURCES` (see
  [Settings](#settings)); the folder must be mounted into the tcp-server
  container.
- **A public GitHub repository**: templates are the folders holding a
  `company.json`, directly under a chosen path. Downloaded from
  `codeload.github.com` and kept for 10 minutes.

Administrators add and remove GitHub sources from the system menu (**Template
sources**) or with `./tcp-cli.sh template-source add|remove`. Sources set in
`TEMPLATE_SOURCES` are shown as set in server config, and can only be removed
there. A source that can't be read is named as a warning; the rest of the
gallery still shows.

## Importing

Choosing a template first shows what it will create. Then you can change:

- the name, address (slug), description, time zone and company context;
- the chat and embedding models (the template's, your own, or the app default);
- whether each role keeps its own model.

The preview also says which providers need an API key (templates never carry
one), lists any warnings (such as a key the template held, which was dropped),
and shows the licences of its knowledge.

If a company already uses the address, you are asked whether to replace it.
Replacing deletes that company and everything in it, and needs membership of it
or administrator access. Otherwise choose another address.

Everything in a template is checked before anything is created: its layout,
every field, every model's address, and every knowledge document. If a later
step still fails, the new company is deleted, so a failed import leaves
nothing behind.

From the CLI:

```bash
./tcp-cli.sh import-company ./my-template          # a folder or a .zip
./tcp-cli.sh import-company --template builtin/cottage-industry --slug my-shop
./tcp-cli.sh import-company ./my-template.zip --preview
./tcp-cli.sh new-template ./my-template             # a copy of Blank to edit
```

Through the API: `POST /api/company/import/preview` and
`POST /api/company/import`, multipart with `file` (the zip) or `template`
(`<sourceId>/<name>`), and `options` (JSON). See Swagger for the fields.

## Exporting

Any member can export a company: **Admin → Company → Export as template**, or
`./tcp-cli.sh export-company --company-slug <slug>`. The zip holds the company,
its roles and prompts, and their knowledge, with a `LICENSES.md` listing every
document's licence.

- API keys are never exported.
- Turn off **Include model settings** (`--no-models`) to leave out every model,
  so whoever imports it chooses their own.

## Knowledge licences

A knowledge document can record where it came from and its licence, in its
front matter: `source`, `license` (an SPDX id where one exists, such as
`OGL-UK-3.0` or `CC-BY-4.0`) and `attribution`. They are set:

- in a template's Markdown files;
- on upload, with the API's `license`, `source` and `attribution` fields, or
  `./tcp-cli.sh store-knowledge --license … --source-url … --attribution …`.

They are shown wherever knowledge is listed, and written to `LICENSES.md` on
export. Only include documents you may share, and follow their terms. The
Cottage industry template's sources and their licence checks are in
[`templates/cottage-industry/SOURCES.md`](../templates/cottage-industry/SOURCES.md).

## Making your own

1. Download **Blank** from the gallery, or run `./tcp-cli.sh new-template
./my-template`.
2. Follow its `README.md`.
3. Import the folder to try it: `./tcp-cli.sh import-company ./my-template`.
4. Share the zip, put it in a directory source, or publish it in a GitHub
   repository and add that as a source.

Or build a company in the app and export it.

## Settings

| Setting            | Default     | Meaning                                                                                                                            |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `TEMPLATES_DIR`    | `templates` | Where the built-in templates are. The image puts them in `/app/templates`.                                                         |
| `TEMPLATE_SOURCES` | empty       | Extra sources, comma-separated: `github:<owner>/<repo>[/<path>][#<ref>]` or `dir:<absolute path>`. Synced to the database at boot. |

## Security

- **A template is untrusted input.** Its zip is checked for unsafe paths, too
  many files and its unpacked size before anything is unpacked. Its role
  prompts are text written by someone else: read them before importing a
  template from a source you don't know.
- **No arbitrary downloads.** GitHub sources reach only `codeload.github.com`,
  with every part of the address checked, no redirects, a 30-second timeout
  and a 50 MB cap. Only administrators can add a source.
- **No keys travel.** Exports drop every API key; imports drop any they find.
- **Replacing is explicit.** A taken address is refused unless replacing is
  chosen, and only members of that company or administrators may replace it.
