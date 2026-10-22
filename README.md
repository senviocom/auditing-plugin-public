# Senvio plugins for Claude Desktop

This repository is a plugin marketplace for Claude Desktop (Cowork). It holds
**iauditing**, a plugin that lets an auditor work on engagements in
iAuditing (iauditing.cz) by chatting with Claude: overviews of engagements,
procedures and answers, saving answers after a confirmed preview, a client
questionnaire, and the engagement's files.

## Install (Claude Desktop)

1. Open Claude Desktop and the **Cowork** tab.
2. Go to **Customize → Plugins**, select **Add → Add marketplace** and enter
   `senviocom/auditing-plugin-public`.
3. Install **iauditing** from the list.
4. On the marketplace, turn on **Sync automatically**, so new versions arrive
   by themselves (or use **Check for updates**).

The plugin works in Cowork's built-in browser. Log in to iAuditing in
Chrome and import the login into the Browser pane; Claude never sees your
password.

## What's here

- `.claude-plugin/marketplace.json`: the marketplace.
- `plugins/iauditing/`: the released plugin. Each release is tagged
  `iauditing-v<version>`.
- The plugin's in-page helpers (`plugins/iauditing/skills/iauditing/references/*.js`)
  are loaded into the user's own iAuditing tab from jsDelivr at the release
  tag, with a script tag that carries each file's SHA-384 hash (Subresource
  Integrity). The browser runs a file only if it is byte-for-byte the one the
  plugin was released with. The helpers call iAuditing's web API in the
  user's logged-in session, at a human pace, and send nothing anywhere else.

Releases are made from Senvio's private source repository; don't edit the
files here.
