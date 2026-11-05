# shipmill Release Decisions for Jira and Bitbucket

Two Forge apps that bring [shipmill](https://github.com/shipmill/shipmill)'s release decisions
to Atlassian: the Jira app finds the decisions blocking a release and prepares each one, the
Bitbucket app holds pull requests on the same decisions. Built for Codegeist 2026.

Work in progress: the apps pair with each other and nothing more yet.

## Layout

| Path | What |
|---|---|
| `jira/` | The Jira app: the bridge web trigger and the admin page |
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

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Licence

MIT, see [LICENSE](LICENSE).
