# auditing-plugin-public

Public files of Senvio's **iauditing** plugin for Claude Desktop (Cowork),
which lets an auditor work on engagements in iAuditing (iauditing.cz) by
chatting with Claude.

- `helpers/<version>/*.js`: the in-page helpers. The plugin loads them into
  the user's own iAuditing tab with a `<script>` tag that carries the file's
  SHA-384 hash (Subresource Integrity), so the browser runs a file only if it
  is byte-for-byte the one the plugin was built with. They are served from
  jsDelivr pinned to a commit
  (`https://cdn.jsdelivr.net/gh/senviocom/auditing-plugin-public@<commit>/helpers/<version>/<file>`)
  and from GitHub Pages.
- The helpers call iAuditing's web API in the user's logged-in session, at a
  human pace, and send nothing anywhere else.

These files are published by the plugin's build (`scripts/publish-helpers.sh`
in the private source repo); don't edit them here. A plugin marketplace may
be added to this repo later.
