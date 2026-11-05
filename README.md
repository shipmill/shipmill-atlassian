# shipmill Release Decisions for Jira and Bitbucket

Two Forge apps that bring [shipmill](https://github.com/shipmill/shipmill)'s release decisions
to Atlassian: the Jira app finds the decisions blocking a release and prepares each one, the
Bitbucket app holds pull requests on the same decisions. Built for Codegeist 2026.

Work in progress: the apps pair with each other, the Jira app reads a release and finds its
decisions, and the Bitbucket app checks pull requests against them.

## Layout

| Path | What |
|---|---|
| `jira/` | The Jira app: the bridge web trigger, the admin page, the release reader and the decision finder |
| `jira/evals/` | The decision finder's eval set and its runner |
| `bitbucket/` | The Bitbucket app: pull request events, the merge check, the pull request card and the workspace settings page |
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

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Licence

MIT, see [LICENSE](LICENSE).
