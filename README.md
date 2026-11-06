# shipmill Release Decisions for Jira and Bitbucket

Two Forge apps that bring [shipmill](https://github.com/shipmill/shipmill)'s release decisions
to Atlassian: the Jira app finds the decisions blocking a release and prepares each one, the
Bitbucket app holds pull requests on the same decisions. Built for Codegeist 2026.

Work in progress: the apps pair with each other, the Jira app reads a release, finds its
decisions, asks each one on its work item and relays the answer, and the Bitbucket app asks
the same decisions on pull requests and checks pull requests against them; there is no
release panel yet.

## Layout

| Path | What |
|---|---|
| `jira/` | The Jira app: the bridge web trigger, the admin page, the release reader, the decision finder, the preparer and the relay |
| `jira/evals/` | The decision finder's eval set and its runner |
| `bitbucket/` | The Bitbucket app: pull request events, decisions on pull requests, the merge check, the pull request card and the workspace settings page |
| `shared/` | Code both apps use: the signed bridge protocol, Jira keys, comment bodies |
| `seed/` | A script that makes the demo release on a Jira site and a Bitbucket workspace |

## Connect the two apps

1. In Jira, open the app settings, then shipmill Release Decisions, and generate a secret
2. In Bitbucket, open the workspace settings, then shipmill Release Decisions, paste the Jira
   address and the secret, and choose Test and save

The Bitbucket app stores the pairing only after a signed test message reaches the Jira app.
Generating a new secret in Jira breaks the pairing until it is pasted into Bitbucket again.

## The merge check and the pull request card

The Bitbucket app's merge check, shipmill Release Decisions, fails a pull request while any
of these holds:

- **An open decision:** the Jira work item named in the title is labelled `needs-decision`,
  or the pull request has an unresolved task that starts with `Decision needed:`
- **A build that is not green on the head commit:** a build status on the source branch's
  head commit is failed, stopped or still running, or no build has reported on it
- **An undecided breaking change:** the pull request adds an entry under `### Breaking` in
  the changelog's Unreleased section, and the work item's decider (its assignee, else its
  reporter) has not approved the pull request

It reads everything fresh on each run, so rerunning it after a hold is lifted passes. The
check asks the paired Jira app about the work item over the signed bridge and counts only
labelled decisions there, never the LLM, so a check costs nothing. `shipmill.toml` and the
changelog are read at the destination branch's commit, so a pull request can't change the
policy it is judged by.

The pull request card shows the work item's release (its fix versions), the lanes a merge
releases in (from `shipmill.toml`: the policy's branch feeds every lane but `hotfix`, a
`release/X.Y` branch feeds `hotfix`), and who the pull request waits on.

**On a free workspace the check is advice.** Bitbucket blocks a merge on a failed check only
where an admin marks the check Required, which needs Bitbucket Premium. Elsewhere the check
and the card show the holds as advice, and their wording says so; neither claims a block.

To turn it on, a workspace admin enables custom merge checks in the workspace settings, then
adds shipmill Release Decisions to a repository, project or the workspace with a branch
pattern (for example `main`).

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

## Decisions on pull requests

When the work item a pull request names waits on a question the Jira app asked, the
Bitbucket app asks it on the pull request too, in the same frame:

```text
@Dana Okafor Decision needed: retire v1 tokens in 2.4, or keep them for one more release?

1. Move HRB-2 out of 2.4 (recommended): 2.4 ships without waiting on this; the decision moves to the next version with the work item
2. Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way
3. Keep them for one more release: decided now, and 2.4 ships with HRB-2 done this way

Evidence: asked on HRB-2 in Jira, the work item this pull request names; the answer is recorded there.

Reply here with a number; shipmill takes this up as soon as you reply.
```

and opens a task on that comment, `Decision needed: <question>`, which the merge check holds
the pull request on. It asks when the pull request is opened or edited, and whenever the
merge check or the card runs, so a pull request opened before the question was asked gets it
the next time someone looks at it. A pull request is asked each question once; the app keeps
which comment and task asked it, which stands in for the protocol's hidden marker line.

A newer comment on the pull request by the person asked goes to the Jira app over the
bridge, which reads it exactly as a reply on the work item (by number, or by Claude while the
LLM switch is on and the question was asked with it on) and checks again that it comes from
the person asked. Once Jira records the answer, removes the label and posts the relay there,
the pull request gets "Decision by `@Dana Okafor`, relayed by shipmill" with the answer and
the task resolves, so the merge check passes. A reply without a number, with the LLM off,
gets a note on the pull request asking for one. An answer given in Jira instead resolves the
task the next time the pull request is opened, edited or checked. Anyone else's comment never
counts.

## Evidence from the Teamwork Graph

The preparer also asks the [Teamwork Graph](https://developer.atlassian.com/platform/teamwork-graph/)
what is linked to the work item: its pull requests, its deployments and the teams it is
assigned to. What it finds is added to the question's evidence line, and the teams are named
as who may decide besides the person asked:

```text
Evidence: asked in the description of HRB-2: "..."; in the Teamwork Graph, pull request "HRB-2 Rejects API v1 tokens ..." (open, https://bitbucket.org/...); assigned to team Harbor API, who may decide too
```

Jira REST stays the source of everything else, so without the graph the comment is exactly
as above. The graph answers only as a user: a prepare that runs for nobody, such as one the
`dev` web trigger starts, reads Jira alone and logs that it did.

The Jira app asks for four read-only graph scopes, only the object types its queries cross:
`read:graph:issue:jira`, `read:graph:pull-request:external`,
`read:graph:deployment:external` and `read:graph:team:atlassian`. **Installing the Jira app
needs an organization admin**, who approves these graph scopes on install (and on an upgrade
that adds them); a site admin alone cannot. An admin can also turn single scopes off in
Atlassian Administration. A scope that is not granted does not fail a query, it empties it,
so the app logs every empty list with the scopes it needed, and says so plainly when
Bitbucket links a pull request the graph does not return. The Teamwork Graph is in Forge
Preview: its schema may change before general availability.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Licence

MIT, see [LICENSE](LICENSE).
