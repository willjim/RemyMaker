---
name: remymaker-local
description: 在本地启动内置的 RemyMaker（也称 Remy）网页应用，无需安装软件包，并向用户返回可点击的本地网站地址。当用户要求在本地运行、启动或打开 remy、remymaker 或 RemyMaker 时使用，包括“帮我运行remy”“帮我运行remymaker”等表达。
---

# Run RemyMaker locally

Start the bundled site immediately. Do not ask the user to clone a repository, install npm packages, or choose a port.

## Start

1. Run `python3 scripts/serve.py` from this skill directory as a long-running/background process. Use the agent's persistent process mechanism so the server remains alive after the command returns.
2. Read the single startup line in the form `RemyMaker: http://127.0.0.1:<port>/`.
3. Verify the address responds successfully. If the process tool already confirms a successful request, do not repeat the check.
4. Reply in the user's language with a clickable Markdown link to that exact address. Keep the response short and state that closing/stopping the running process stops the site.

The launcher chooses a free loopback port, serves the bundled site from `assets/remymaker-site`, and implements the `/resolve` endpoint. It needs only Python 3's standard library. Internet access is still required in the browser for Remy/Kiri models and the app's CDN libraries.

## Troubleshoot

- If `python3` is unavailable, try `python scripts/serve.py`.
- If startup fails, report the actual error; do not install unrelated services or replace the launcher with Wrangler.
- If the page opens but external libraries or models fail, explain that the browser must be online and able to reach the referenced CDN or model host.
- Never expose the server beyond `127.0.0.1` unless the user explicitly requests LAN access.
