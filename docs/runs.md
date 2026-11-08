# Full runs on fresh seed data

Three runs of the whole flow on the development site `shipmill-dev.atlassian.net`, project
`DEMO` (fix version `2.4`) and Bitbucket repository `shipmill-dev/harbor-demo`, for
[#11](https://github.com/shipmill/shipmill-atlassian/issues/11). The LLM switch stays off in
every run.

Each run:

1. Reset with the seed: `npm run seed -- --jira-site shipmill-dev.atlassian.net --bitbucket-workspace shipmill-dev --project-key DEMO --project-name "Harbor demo" --repository harbor-demo`
2. Ask the 2.4 decisions through MCP (`uv run scripts/mcp-check.py ask DEMO-n 2.4`)
3. Answer each one in Jira with a reply comment by the person asked (an option number)
4. Resolve the `Decision needed:` task on `harbor-demo` #4
5. Check the panel state through MCP `list`, the merge check on the pull requests, and the
   rows on the Confluence page "Release decisions: DEMO" in space `SD`

## Run 1 (2026-11-07)

**Seed:** reset DEMO-2, DEMO-3 and DEMO-9 (their `shipmill-decision` record deleted, the
`needs-decision` label and fix version put back); Bitbucket unchanged, the decision task on #4
still open.

**Found before asking:** DEMO-9's question from the previous demo quoted shipmill's own
earlier question as its evidence ("asked by shipmill Release Decisions for Jira in a
comment"). The seed keeps comments, so after a reset the finder read the app's old question
comment, which repeats "Decision needed:", as the decision's source. Fixed: the release
reader leaves out comments whose author is an app (`accountType` `app`), with a regression
test in `jira/src/reader.test.ts`; deployed to development as Jira 4.4.0.

**Found on asking:** `scripts/mcp-check.py` asked for a new sign-in once the saved access
token was older than eight hours, because the MCP client forgets a stored token's expiry and
refreshes against the wrong endpoint. Fixed: the script keeps the expiry and refreshes
against the authorization server the MCP server names.

**Blocked:** every MCP tool then failed with:

> App ari:cloud:ecosystem::app/e68108c0-f2e4-427b-9417-b3878322c288 is not allowed to expose
> its tools over the external MCP endpoint on this site. An admin must enable external MCP
> access for this app.

The first guess was that the upgrade to 4.3.0 had reset **Expose tools to MCP-compatible
apps**. That is unproven: on 2026-11-08 the switch read Enabled on the Jira install and the
same error stayed, on two tries, while the switch read Disabled on the Confluence install. The
last working MCP call (2026-11-07 14:19 local) was before the app was installed in Confluence,
so the Confluence install's switch is the current suspect; not yet tested.

## Merge check holds (2026-11-08)

The Bitbucket app logs each merge check's verdict since 3.11.0, since Bitbucket has no API that
reads a Forge check's result back. Until the check was added to the repository it never ran:
a push on 2026-11-07 ran the pull request trigger only, and `on-merge-check` had no invocation
in 14 days of logs. It was then added at repository level on `harbor-demo`, branch "Main
branch", "Not required".

**The check runs.** It reported on all eight open pull requests at 08:11:59 UTC, and then on
every push.

Each commit below got its build status on a temporary branch first, so the check saw the status
when the push triggered it (a status arriving later does not run the check). Lines are from
`forge logs -e development`, all with trigger `on-code-pushed`:

| Hold | Pull request | Head | Verdict in the log |
|---|---|---|---|
| Build: none reported | #5 | `2a3bbb53ac5e` | `hold build; build: no build has reported on 2a3bbb53ac5e` |
| Build: failed | #5 | `20efe9db415e` | `hold build; build: build harbor CI is failed on 20efe9db415e` |
| Build: lifted (green) | #5 | `1128334ddb2c` | `pass; clear to merge` |
| Breaking change, green build | #6 | `f11e979c07f8` | `hold breaking; breaking: the breaking change "Invoice PDFs render due dates in the account time zone" is undecided: Roman Medvedev has not approved it` |

The test files were then removed from both branches again, so their content matches the seed;
their heads carry no build status, as seeded.

**Breaking-change hold:** block verified live; the lift needs a second account and is covered by
tests (`bitbucket/src/holds.test.ts`). It lifts when the work item's decider approves the pull
request, and Roman is both the decider and the author of every `harbor-demo` pull request.
Whether Bitbucket lets an author approve their own pull request was not tried: this session's
permission guard refused the attempt.

**What the pull request shows, and whether the merge is stopped:** not observed yet; no browser
here is signed in to Bitbucket. What the plan says, as seen in the Bitbucket settings by the
person who added the check: the Required box is disabled ("Upgrade to premium to allow failed
checks to prevent merges"), so on this workspace a failed check can't be Required. No merge was
attempted, since a merged pull request can't be seeded again.
