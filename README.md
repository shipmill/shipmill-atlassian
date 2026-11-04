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

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Licence

MIT, see [LICENSE](LICENSE).
