# Privacy policy

For the shipmill Release Decisions apps for Jira and Bitbucket, as of 2026-11-04.

## What the apps read

The Jira app reads the work items, comments, labels and development information of the site
it is installed on. The Bitbucket app reads the pull requests of the workspace it is installed
on. Both read only through Atlassian's own APIs, with the scopes the install screen shows.

## What the apps store

Per install, in Atlassian's Forge storage: the secret that pairs the two apps, the Jira app's
web trigger address (in the Bitbucket app), whether Claude is switched on, and, in the
Bitbucket app, which comment and task asked each decision on a pull request and who was
asked. What the apps
write back, comments, labels, pull request tasks, and the `shipmill-decision` property on a
work item (the question asked, its options, who decides and their answer), lives in your Jira
and Bitbucket like any other comment.

## Where data goes

Nowhere outside Atlassian. The apps run on Atlassian's Forge platform. When Claude is on, the
Jira app sends work item text and replies to its questions to Forge LLMs, which Atlassian hosts; switch it off on the app's
settings page and nothing is sent. The Bitbucket app sends pull request titles and links, and
the replies the person asked makes to a decision on a pull request, to the Jira app it is
paired with, through that app's Forge web trigger. The authors of the apps
receive no data from your site: no analytics, no tracking, no copies.

## Removing data

Uninstalling an app deletes its Forge storage. Comments, labels and properties the apps wrote stay in Jira
and Bitbucket until you delete them.

## Contact

Questions go to the issues of [shipmill/shipmill-atlassian](https://github.com/shipmill/shipmill-atlassian/issues).
