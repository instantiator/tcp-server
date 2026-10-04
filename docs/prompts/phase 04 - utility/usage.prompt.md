I'd like to delve into cottage industries so that companies can help people run a second income stream. I think we're missing a few pieces of the puzzle, and It'd be nice to be able to offer those and a "cottage industry" template company.

Gaps I can see:

- To interact with online sales sites: No easy way to define or template MCP services and no web browing / interaction capability for agents could hold this back (there are some nice browser interaction MCP services we could explore), and perhaps we could run a headless browser with playwright in a container for this
- To manage orders: No easy way to do reliable calculations (eg. a basic utilities MCP service that includes a calculator)
- To manage orders: No easy way to keep records (eg. an MCP service that uses the storage service but for structured records - stored as JSON or CSV or other) - to enforce typing, required fields, to maintain an index of tables, and to explain to the agent which tables are available and what they're for (or even a simple shared table service like DynamoDB running in a container?)
- To manage company state: a common document storage location for stateful resources (eg. invoices should really be stored centrally, rather than as the outputs from a task) - and a way for tasks to specify a task output as a specific change to the company resources, rather than just task resources
- To manage orders: No templated MCP service for email connections yet - it'd be good to be able to connect to common services, or specify the SMTP/POP details so that the agents can check
- To manage orders: No cron / repeating task service (so that the company can check for new orders, and manage enquiries, etc.)
- To visualise data: No current 'state of the company' report system, that can highlight what's important to the user (and maybe some templates for various reports)

Expertises that might also be needed:

- Regional laws governing cottage industries and income
- Order responses and enquiry handling skills
- A strict "no unauthorised promises" enforcer role that checks with the user before offering any kind of discount, freebie, concession, or promise
- Regional postage information and costs
- Tools and materials catalogues to suport ordering

The other big gaps I can see are:

- no easy way to create a company through the web UI
- no templated companies or MCP services (as you already noted, and mentioned above)
- no skills and hooks, ie. no way to enforce specific behaviours for roles - we just rely on the agent and its reviewing agent for checks right now

Please assess the above, and think about what I may have missed. Build a list of all the gaps (these and any you think should be added to the list).

Please also sift through what the web UI offers today, and what the feature gap is between this and the TUI. Eventually, I hope to deprecate the TUI in favour of being able to do everything through the web interface or individual CLI commands.

Store the full list as: `prompts/phase 04 - utility/usage.gaps.md`

Sections to include:

```md
## Overview

| Title | Gap summary | Recommendation summary |
| ----- | ----------- | ---------------------- |

_Aim for very brief summaries here - detail can go into subsections._

### Gap title

_describe the gap in more detail, and your recommendation to address it_

### Gap title

_etc._
```
