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

**Blocked:** every MCP tool then failed with "not allowed to expose its tools over the
external MCP endpoint on this site". The switch **Expose tools to MCP-compatible apps** was
off after the app's upgrade to 4.3.0: an upgrade can reset it, so an admin has to check it
after every upgrade (now in the README). Waiting for it to be turned on again.

## Merge check holds (2026-11-07)

The Bitbucket app logs each merge check's verdict since 3.11.0 (`merge check harbor-demo #5
at <head> (<trigger>): pass|hold <kinds>; ...`), since Bitbucket has no API that reads a
Forge check's result back. The plan: drive each hold by pushing commits to a pull request's
branch. A commit gets its build status on a temporary branch before the pull request's branch
moves to it, so the check sees the status when the push triggers it.

**Blocked:** a push to `harbor-demo` #5's branch (head `8531a503dc1a`, 21:01 UTC) ran the
pull request trigger, but no merge check ran. `on-merge-check` has no invocation on the
development install at all. Custom merge checks must first be turned on by a workspace
admin and the check added to the repository (see "The merge check and the pull request
card"). Waiting for that.

**Breaking-change hold:** the block can be verified live; the lift needs the decider (the
work item's assignee) to approve the pull request. On `harbor-demo`, Roman is both the
author of every pull request and the only account, and Bitbucket does not let an author
approve their own pull request. So the lift needs a second account; until then it is covered
by tests (`bitbucket/src/holds.test.ts`).
