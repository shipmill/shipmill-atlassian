# Privacy policy

For the shipmill Release Decisions apps for Jira and Bitbucket, as of 2026-11-04.

## What the apps read

The Jira app reads the work items, comments, labels and development information of the site
it is installed on, and from the Teamwork Graph the pull requests and deployments linked to
a work item it asks a decision on, read as the person who presses Ask decisions on the
release panel. It asks for the graph's team scope but reads no teams yet. The Bitbucket app reads the pull requests of the workspace it is installed
on. Both read only through Atlassian's own APIs, with the scopes the install screen shows.

## What the apps store

Per install, in Atlassian's Forge storage: the secret that pairs the two apps, the Jira app's
web trigger address (in the Bitbucket app), whether Claude is switched on, the Confluence space of the decision log, and, in the
Bitbucket app, which comment and task asked each decision on a pull request and who was
asked. What the apps
write back, comments, labels, pull request tasks, and the `shipmill-decision` property on a
work item (the question asked, its options, who decides and their answer), lives in your Jira
and Bitbucket like any other comment. With a decision log space set, the Jira app also writes
a page per project in that Confluence space, with a row per decision: the work item, the
question, the answer, who decided and when.

## Where data goes

Nowhere outside Atlassian. The apps run on Atlassian's Forge platform. When Claude is on, the
Jira app sends work item text and replies to its questions to Forge LLMs, which Atlassian hosts; switch it off on the app's
settings page and nothing is sent. The Bitbucket app sends pull request titles and links, and
the replies the person asked makes to a decision on a pull request, to the Jira app it is
paired with, through that app's Forge web trigger. If a site admin exposes the Jira app's
tools to MCP-compatible apps, an MCP client a person signs in to through Atlassian receives the
release decisions that person may see in Jira, and nothing else. The authors of the apps
receive no data from your site: no analytics, no tracking, no copies.

## Removing data

Uninstalling an app deletes its Forge storage. Comments, labels and properties the apps wrote stay in Jira
and Bitbucket until you delete them.

## Contact

Questions go to the issues of [shipmill/shipmill-atlassian](https://github.com/shipmill/shipmill-atlassian/issues).
