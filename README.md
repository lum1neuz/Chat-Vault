# ChatVault

A small Windows desktop app that finds every Claude Code chat stored on your PC, across all the accounts you have used, and lets you read, search and export them.

Claude only shows the chats of the account that is signed in. The full transcripts stay on disk, so ChatVault reads them directly.

## Features

- Lists chats from every account on this computer, newest first, loading 20 at a time as you scroll.
- Filters by account with a dropdown, and by title or project as you type.
- Searches inside the text of all chats (press Enter in the search box).
- Reads a chat as message bubbles, with local times, collapsible long messages and optional tool steps.
- A round button jumps to the bottom of a long chat.
- A three-dots menu on every chat with quick actions, and the same actions in the chat header.
- **Continue in Claude:** opens a terminal in the project folder and runs `claude --resume <id>`. Claude Code finds the transcript on disk, so it works for chats from another account and uses the account signed in to the CLI. "Continue in Claude (copy)" adds `--fork-session`, so the original chat file is not changed.
- **Continue in Codex:** saves a handoff file (the whole chat, or the first and last messages plus a list of requests for very long chats) to `Documents\ChatVault Handoffs`, then starts `codex` in the project folder with a prompt that tells it to read that file and carry on.
- Open in the Claude app, show the transcript file, copy the Claude or Codex command, copy as Markdown, or save a `.md` file.
- Light and dark themes.

ChatVault only reads files and never changes them.

## Where it looks

| What | Folder |
| --- | --- |
| Transcripts | `%USERPROFILE%\.claude\projects\*\*.jsonl` |
| Titles, times, accounts | `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_*.json` |

Chats without title information are still listed, under "No account info".

## Download

Installers (`.msi` and `.exe`) are on the [Releases](../../releases) page.

## Develop

Needs Node 20+, Rust and the Tauri prerequisites for Windows (WebView2 and the Visual Studio C++ build tools).

```bash
npm install
npm run tauri dev
```

Build installers:

```bash
npm run tauri build
```

The installers are written to `src-tauri/target/release/bundle/`.

## Releases

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`, which builds the installers and attaches them to a GitHub release.

## Stack

Tauri 2, React 19, TypeScript, Tailwind CSS 4 and shadcn/ui. The scanning and parsing is written in Rust.

## License

MIT
