# shipmill Release Decisions for Jira and Bitbucket

Two Forge apps that bring [shipmill](https://github.com/shipmill/shipmill)'s release decisions
to Atlassian: the Jira app finds the decisions blocking a release and prepares each one, the
Bitbucket app holds pull requests on the same decisions. Built for Codegeist 2026.

Work in progress: the apps pair with each other, and the Jira app reads a release and finds
its decisions; nothing shows them to anyone yet.

## Layout

| Path | What |
|---|---|
| `jira/` | The Jira app: the bridge web trigger, the admin page, the release reader and the decision finder |
| `jira/evals/` | The decision finder's eval set and its runner |
| `bitbucket/` | The Bitbucket app: pull request events and the workspace settings page |
| `shared/` | Code both apps use: the signed bridge protocol, Jira keys, comment bodies |

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
