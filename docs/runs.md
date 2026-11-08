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

## Results

All on 2026-11-08 UTC, LLM off, replies posted as the person asked. Run 1 used Jira 4.6.0 and
Bitbucket 3.11.0; runs 2 and 3 used Jira 4.6.0 and Bitbucket 3.12.0.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Started | 08:24 | 08:32 | 08:35 |
| Seed reset | ok | ok, task on #4 reopened | ok, task on #4 reopened |
| `ask` on DEMO-2, -3, -9; a second ask of DEMO-2 is not asked again | ok | ok | ok |
| Question cites the item's own description | ok | ok | ok |
| Merge check while waiting, #2, #3, #4 | `hold decision,build` | `hold decision,build` | `hold decision,build` |
| Question and task mirrored on #2, #3 | ok | ok | ok |
| DEMO-2 / DEMO-3 / DEMO-9 answered with | 2 / 3 / 2 | 3 / 2 **on PR #3** / 3 | 1 / 2 / 1 |
| All decided, label removed, relayed in Jira | ok | ok | ok |
| Task on #4 resolved; merge check with a green build, #2, #3, #4 | `pass` | `pass` | `pass` |
| Relay comments on #2 | **2, a bug** | 1 | 1 |
| `list` after: no decisions left | ok | ok | ok |
| New rows on "Release decisions: DEMO" (space `SD`) | 3 | 3 | 3 |

**Reply on a pull request (run 2):** the comment `2` on #3 was relayed to Jira as "Answered on
Bitbucket pull request #3 ...: option 2", removed DEMO-3's label, added its row to the log, and
#3 got "Answered on this pull request" with its task resolved.

**Found in the runs:**

- **Duplicate relay comment (run 1).** A push fires the pull request event and the merge check
  together, and both posted the relay. Fixed with an atomic claim and tests; Bitbucket 3.12.0.
  Runs 2 and 3 posted one
- **Option 1 does not move the work item (run 3).** "Move DEMO-2 out of 2.4" was recorded and
  relayed, but the item stayed in fix version 2.4: the relay removes the label and records
  the answer, and changes no fix version. Not changed; the README says so
- **The log keeps its rows across seeds.** The seed leaves the Confluence page alone, so it grew
  by three rows a run, on top of the two from 2026-11-07

**State left:** DEMO is reseeded, each decision labelled and not asked. `harbor-demo` #2, #3 and
#4 carry empty commits from these runs and a green build status on their heads, so they differ
from a fresh seed there; the seed never touches a pull request's commits.

## Findings before the runs (2026-11-07)

**Seen before asking:** DEMO-9's question from the previous demo quoted shipmill's own
earlier question as its evidence ("asked by shipmill Release Decisions for Jira in a
comment"). The seed keeps comments, so after a reset the finder read the app's old question
comment, which repeats "Decision needed:", as the decision's source. Fixed: the release
reader leaves out comments whose author is an app (`accountType` `app`), with a regression
test in `jira/src/reader.test.ts`; deployed to development as Jira 4.4.0.

**Seen on asking:** `scripts/mcp-check.py` asked for a new sign-in once the saved access
token was older than eight hours, because the MCP client forgets a stored token's expiry and
refreshes against the wrong endpoint. Fixed: the script keeps the expiry and refreshes
against the authorization server the MCP server names.

Every MCP tool then failed with:

> App ari:cloud:ecosystem::app/e68108c0-f2e4-427b-9417-b3878322c288 is not allowed to expose
> its tools over the external MCP endpoint on this site. An admin must enable external MCP
> access for this app.

The first guess was that the upgrade to 4.3.0 had reset **Expose tools to MCP-compatible
apps**; that was wrong. On 2026-11-08 the error stayed with the switch Enabled on the Jira
install and Disabled on the Confluence install, and went away at once when the Confluence
install was Enabled too. The last working call before that (2026-11-07 14:19 local) predates
the app's Confluence install.

**Found once MCP answered:** with the app installed in Jira and in Confluence, the calls run on
the Confluence install (log line since Jira 4.5.0: `mcp list by ... on
ari:cloud:confluence::site/...`). Two effects:

- `ask-decision` failed before asking anything, since the site id parser took only Jira contexts.
  Fixed, with a test; deployed as Jira 4.6.0
- `list-release-decisions` reads no pull request links or pull request decisions, since those
  live in the Jira install's Forge storage: `pullRequests` is empty and `ready` ignores open
  pull request decisions, and `ready` ignored open pull request decisions. The false `ready:
  true` is fixed: since Jira 4.7.0 such a call reports `pullRequestData: unavailable` and
  `ready: unknown` when no work item blocks, seen live on 2026-11-08. The missing data is
  [#35](https://github.com/shipmill/shipmill-atlassian/issues/35)

Whether a site with the app in Jira only serves MCP from the Jira install was not observed
directly (the install context was not logged then, and no Jira-only site is at hand). Indirect
evidence: the `list` of 2026-11-07 14:19, before the Confluence install, returned HRB's linked
pull requests, which only the Jira install's storage holds.

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

**What the pull request shows, and whether the merge is stopped** (`harbor-demo` #2, seen
read-only by the coordinating session on 2026-11-08; nothing clicked):

- The merge check area reads "0 of 2 checks passed". shipmill Release Decisions shows "Did not
  pass", with "shipmill advises waiting: DEMO-2 waits on a decision: ...", then that no build
  has reported, and that this blocks the merge only where the check is Required (Bitbucket
  Premium). "These will run on merge" lists the same check
- **The merge is not stopped.** The Merge buttons stay enabled, and the top banner reads "This
  pull request is ready to merge. All of the required pre-merge checks have passed", next to
  the failed check. On this free plan a judge sees both
- The Required box is disabled in the repository's settings ("Upgrade to premium to allow
  failed checks to prevent merges"). No merge was attempted, so the on-merge run is untested

## Not run live

- The release panel's page and its Ask decisions button: no browser here is signed in, so the
  panel's data was read through MCP `list`, whose pull request data is limited as above
- The pull request card, and the pairing and settings pages
- A merge, and so the check's on-merge run
- The breaking-change lift (second account), the LLM switch on, a production deploy
- The clean install from the README: needs a new site and workspace
