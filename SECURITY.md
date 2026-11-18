# Security

An adapter runs code on your machine with your permissions. Most adapters here also run the original plugin's own code (claude-hud's `hud.mjs`, for example) from wherever you installed that plugin: install only originals you trust, and treat any environment variable that names an original's folder (such as `CLAUDE_HUD_ROOT`) as choosing code to execute. Adapters are not sandboxed by DSH beyond what your DSH profile enforces.

Report a vulnerability privately through GitHub's "Report a vulnerability" (Security tab of this repository) rather than in a public issue.