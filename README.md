# shipmill Release Decisions for Jira and Bitbucket

Two Forge apps that bring [shipmill](https://github.com/shipmill/shipmill)'s release decisions
to Atlassian: the Jira app finds the decisions blocking a release and prepares each one, the
Bitbucket app holds pull requests on the same decisions. Built for Codegeist 2026.

Work in progress: the apps pair with each other, and the Jira app reads a release, finds its
decisions, asks each one on its work item and relays the answer; there is no release panel
yet.

## Layout

| Path | What |
|---|---|
| `jira/` | The Jira app: the bridge web trigger, the admin page, the release reader, the decision finder, the preparer and the relay |
| `jira/evals/` | The decision finder's eval set and its runner |
| `bitbucket/` | The Bitbucket app: pull request events and the workspace settings page |
| `shared/` | Code both apps use: the signed bridge protocol, Jira keys, comment bodies |
| `seed/` | A script that makes the demo release on a Jira site and a Bitbucket workspace |

## Connect the two apps

1. In Jira, open the app settings, then shipmill Release Decisions, and generate a secret
2. In Bitbucket, open the workspace settings, then shipmill Release Decisions, paste the Jira
   address and the secret, and choose Test and save

The Bitbucket app stores the pairing only after a signed test message reaches the Jira app.
Generating a new secret in Jira breaks the pairing until it is pasted into Bitbucket again.

## Develop

Node 24 and the [Forge CLI](https://developer.atlassian.com/platform/forge/cli-reference/).

```bash
npm install
npm run typecheck
npm test
```

Deploy each app from its folder with `forge deploy`.

## Seed a demo release

`seed/` makes the release every stage is tested on, on a Jira site and a Bitbucket workspace
you name:

- Jira project `HRB` (Harbor) with fix version `2.4` and 20 work items in it
- three blocking decisions: two work items labelled `needs-decision`, and one with a comment
  that asks a question nobody answered
- Bitbucket repository `harbor` with `shipmill.toml` and a README on the main branch, and
  eight pull requests whose titles start with the work item key (`HRB-2 Retire API v1 tokens`)

It reads what exists first and makes only what is missing, so a second run changes nothing. A
file on the main branch is written only while it is missing, never overwritten.

Credentials come from the environment, never from arguments or files in the repo:

| Variable | What |
|---|---|
| `ATLASSIAN_EMAIL` | The Atlassian account email both tokens belong to |
| `JIRA_API_TOKEN` | An API token without scopes from id.atlassian.com, for an account that may create projects (Jira admin) |
| `BITBUCKET_API_TOKEN` | A Bitbucket API token with scopes `read:repository:bitbucket`, `write:repository:bitbucket`, `admin:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` |

```bash
npm run seed -- --jira-site example.atlassian.net --bitbucket-workspace example --dry-run
npm run seed -- --jira-site example.atlassian.net --bitbucket-workspace example
```

`--dry-run` only reads and prints the plan. Branch names and pull request titles carry the
work item keys, so before the Jira work items exist a dry run plans Jira only and leaves out
the Bitbucket changes. `--project-key` and `--repository` change the
names. The seed finds its own work items through a project property, `shipmill-seed`, that
maps each seed item to the work item made for it; a work item deleted by hand is made again.

## Decisions and the LLM switch

The Jira app finds two kinds of decision in a fix version's work items:

- **Labelled:** every item labelled `needs-decision`, always, by code
- **Implicit:** a question asked in a comment or a description that nobody answered, found by
  Claude through Forge LLM, only while the LLM switch on the admin page is on

With the switch off the app makes no LLM call. Forge bills LLM tokens to the app's
developer, so the eval set says whether the switch earns its cost:

```bash
npm run evals
```

runs the 15 cases in `jira/evals/cases` with the LLM off, locally and free. With
`-- --live` it sends them to the app deployed in development, which runs each through Forge
LLM (billed); set `SHIPMILL_DEV_TRIGGER_URL` to the `dev` web trigger's URL and
`SHIPMILL_BRIDGE_SECRET` to the secret on the admin page. The `dev` trigger answers only in
the development environment.

## Asking a decision and relaying the answer

For each decision the app posts one comment on its work item, in the frame of shipmill's
[needs-decision protocol](https://github.com/shipmill/shipmill/blob/main/skills/github-issue-triage/references/needs-decision.md):

```text
@Dana Okafor Decision needed: retire v1 tokens in 2.4, or keep them for one more release?

1. Move HRB-2 out of 2.4 (recommended): 2.4 ships without waiting on this; the decision moves to the next version with the work item
2. Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way
3. Keep them for one more release: decided now, and 2.4 ships with HRB-2 done this way

Evidence: asked in the description of HRB-2: "Decision needed: retire v1 tokens in 2.4, ..."

Reply here with a number; shipmill takes this up as soon as you reply.
```

It mentions the person who decides (the item's assignee, else its reporter, else the
project lead), adds the `needs-decision` label when the item lacks it, and records the
question in the item's `shipmill-decision` property, which stands in for the protocol's
hidden marker line: Jira comments have no hidden text. An item already waiting is not asked
again.

- **LLM on:** Claude writes the question, the options and their reasons, and reads a
  free-text reply
- **LLM off:** the options come from a template: moving the item out of the version, then
  the alternatives an "A, or B?" question names; a reply is read as an option number

A newer comment by the person asked ends the wait: the app posts "Decision by `@Dana Okafor`,
relayed by shipmill" with the answer, removes the label, and records the answer in the
property. Anyone else's comment never counts. A reply starting with an option number is read
by code; with the LLM off, any other reply gets a note asking for a number, and with it on,
a reply Claude reads as no decision yet (a question back, "let me check") keeps the wait
without a note. A question asked with the LLM off is answered by number even if the switch
is turned on later.

In development the `dev` web trigger starts it: a signed
`{"action":"prepare","project":"HRB","version":"2.4","llm":false}` asks the release's
decisions, and `{"action":"decision","key":"HRB-2"}` shows what the item waits on.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Licence

MIT, see [LICENSE](LICENSE).
