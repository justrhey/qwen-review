# Arko Workspace (qwen-review)

Arko Workspace combines codebase maps, live code editing, persistent Codex/Qwen sessions,
a localhost frontend preview, and a native Electron desktop window.

## Install and run

Requires Python 3.11+, Node.js 22+, Git, and ripgrep.

```bash
npm ci
npm start
```

Open <http://127.0.0.1:8766>. Install and authenticate the Codex CLI to use
the Codex agent, or configure a local Qwen server for local inference.

To install the native desktop dependencies:

```bash
npm ci --prefix desktop-app
./run-desktop.sh
```

The Linux desktop launcher starts the `local-qwen-review.service` user service;
that service must be installed with this checkout’s `run-workspace.sh` as its
ExecStart before using the desktop launcher. Model downloads, service installation,
and private workspace state are separate from the source checkout.

Run `npm test` to check Python behavior and source diff handling.

## Local model setup

Qwen3.5-2B, compressed to Q4_K_M, served locally by llama.cpp with a browser chat and an OpenAI-compatible API. This runs an existing pretrained model; it does not train a new model.

Installed and verified on September 10, 2026. The model and runtime downloads passed SHA-256 verification. GPU inference, streamed desktop sidebar replies, and the browser interface were checked locally.

## Code-review workspace

Open **Arko Workspace** from your app launcher, or visit <http://127.0.0.1:8766>.
This is a local workspace inspired by [Cartograph's tutorial](https://www.youtube.com/watch?v=-AkIj8TG3Uc)
and the Forge-style layout in `recording_2026-10-07_21.52.36.mp4`.
It uses your existing Qwen server at port 8080. No cloud API keys are required.

1. Enter an absolute project folder and click **Open project**.
2. Select a file such as `src/App.jsx`. The map shows its imports and the files
   importing it. Click any node, file, or source citation to follow the evidence.
3. Use **Potential impact** for transitive import dependents and **Source** for
   numbered code with pagination. Use **Changes** to inspect staged and
   working-tree source changes against Git HEAD, then ask Qwen to review them.
4. Click **Archify → Generate with Archify**, or ask Qwen to create an import
   diagram. The diagram can be explored and downloaded as standalone HTML.

Use **Preview** to view a frontend served on localhost. Start the app's dev server
in the opened project, enter its URL (for example `http://localhost:3000`), and
click **Open**. The URL is remembered per project. Dev-server hot updates work
inside the preview. For static frontends, Arko adds a local development bridge
when the served HTML matches the open project's entry file. CSS updates apply
without navigating; JavaScript updates refresh the current route and restore scroll
and unfinished non-password form input. Framework HMR retains its normal behavior.
Completed assistant edits do not reset the iframe to its original URL. **Live**
controls the static frontend watcher, including changes saved outside the assistant.
Use **Mobile** for a narrow viewport, **↻** to reload, or **↗** for a separate tab.

The parser uses the TypeScript compiler API for JS/TS imports, re-exports,
literal dynamic imports and `require`, including project `tsconfig`/`jsconfig`
aliases. Python imports use the standard `ast` module. Connections are parsed
from current source; the model explains them and reads source through tools.
Computed imports and unresolved aliases are reported separately. Framework
routing conventions, runtime calls, dynamic Python imports, CSS imports, and
dependencies outside the opened folder are not inferred. Potential impact is
import reach, not a guarantee of runtime breakage. Qwen's 2B model can still
misinterpret evidence; verify review findings against source.

The workspace is scoped to the selected project. Its tools read source, inspect
connections/diffs, and generate new diagram artifacts; they cannot edit source
or execute model-proposed shell commands. The desktop sidebar also receives the
new repository tools and keeps its existing edit/command approval flow. This
integration supplies tools and context; it does not retrain model weights.

Scans respect `.gitignore` and exclude hidden files, common credential files,
symlinks, dependencies, builds and files over 1 MiB. Scans stop at 1,500 source
files with a warning. Diagrams show up to 24 direct neighbors; the complete
scanned connections remain in the list. Use **↻** after changing source files.
Diagram generation runs Archify's renderer; it does not run the full `finalize`
delivery/browser gate on every diagram. Standalone diagram artifacts and
candidate JSON live under `~/.local/state/local-qwen/diagrams/`. Chat history
is cached in browser storage and backed up privately under `~/.local/state/local-qwen/workspace/`; private request/tool traces are stored under
`~/.local/state/local-qwen/reviews/` for inspection. Nothing is uploaded.

The review workspace starts automatically at login. Manage it with:

```bash
systemctl --user status local-qwen-review
systemctl --user restart local-qwen-review
systemctl --user disable --now local-qwen-review
```

For foreground development, stop the service and run `./run-workspace.sh`.
`QWEN_WORKSPACE_PORT` overrides its default port 8766. The parser's only npm
dependency is pinned in `package.json`; run `npm install` if restoring this
project on another machine. Archify is loaded from `~/archify/archify/`.

## Desktop and browser chat

Open your desktop sidebar with **Super+A**, select **Intelligence**, and chat with **Qwen Local (3.5 2B)**. The server starts automatically when you log in.

The browser interface is at <http://127.0.0.1:8080>. To start the server manually:

```bash
systemctl --user start local-qwen
```

The first start loads the model from disk. Inference works offline after installation. This setup accepts text; the optional vision encoder is not installed. Chat history is stored by the browser UI in its local browser storage.

```bash
systemctl --user stop local-qwen
systemctl --user restart local-qwen
systemctl --user status local-qwen
journalctl --user -u local-qwen -n 50 --no-pager
```

To turn off automatic startup:

```bash
systemctl --user disable local-qwen
```

## Hardware and settings

Detected hardware: NVIDIA GeForce 940MX (2,004 MiB VRAM), driver 470.256.02, Intel i7-6700HQ (4 cores / 8 threads), and approximately 20 GiB RAM.

Inference uses the 940MX through llama.cpp's Vulkan backend, with the existing NVIDIA driver. The model used approximately 1,410 MiB VRAM with the 8,192-token context during checks. The CPU build is also installed as a fallback.

Short local checks measured **14–17 generated tokens/second on the GPU**, compared with **7.6–7.8 on the CPU**. These are small smoke checks, not a comprehensive benchmark. Prompt processing adds time before the first token; the first GPU request also has initialization overhead.

[run.sh](run.sh) sets 4 CPU threads, an 8,192-token context shared by the prompt/history and response, one simultaneous request, and a default maximum response of 1,024 tokens. Thinking is disabled for quicker replies. The model file is about 1.4 GB; runtime memory is additional. Larger Qwen models could use system RAM, with slower generation on this CPU.

After changing settings in `run.sh`, restart the service. For a foreground session, stop the service and run `./run.sh` from this directory; Ctrl+C stops it.

For CPU fallback, stop the service and run `./run.sh --device none --gpu-layers 0`.

## Desktop sidebar

The sidebar now opens in **Agent · Entire OS** mode. It can read text files, list directories, search file contents, propose file edits, create files, and run terminal commands across paths your Linux account can access. It uses the local model through [agent.py](agent.py); no cloud provider or API key is involved.

- **Edits and commands ask first.** Review the complete diff or command and working directory, then choose **Approve once** or **Reject**. Reject ends the current turn and prevents the model from retrying the action.
- Existing files edited through the file tool are backed up under `~/.local/state/local-qwen/backups/`. Each backup contains `original` and `metadata.json` with the source path and permissions. Shell commands do not receive automatic file backups.
- The square **Stop** button cancels generation or the active command. Commands have a 60-second timeout and execute as your user; the agent does not obtain root privileges automatically.
- Click **Agent · Entire OS** to switch to **Chat** without tools. The history icon opens saved chats; the new-chat icon or **Ctrl+Shift+O** saves the old conversation and starts a fresh one. **Enter** sends; **Shift+Enter** adds a line.
- Agent responses allow up to 1,024 generated tokens per model step and eight tool rounds per message. Older context is shortened when necessary to fit 8,192 tokens. Send “continue” for another round. Plain Chat mode uses its existing 512-token output cap.

Try “Read /etc/os-release and explain my system,” or “Find the config for my terminal.” Give precise file paths and small changes for the best results. This 2B model provides basic agent abilities; its reasoning and coding reliability are below large Claude/Codex models. It operates through files and commands, without a dedicated visual mouse/keyboard agent.

There is **no subscription or per-message quota** for local inference. Usage is limited by memory, processing speed, context and response lengths, and electricity. Network access is unnecessary for the model, although a command you approve may itself use the network. The browser page at port 8080 remains a separate text-chat interface; system actions are integrated into the desktop sidebar.

The sidebar uses a ChatGPT-inspired monochrome layout, user bubbles, selectable Markdown, a growing composer, history/new-chat controls, collapsible tool results, and inline approval cards. Sidebar conversations are stored in `~/.local/state/quickshell/user/ai/chats/`.

Settings are in `~/.config/illogical-impulse/config.json`, and the selected model is saved in `~/.local/state/quickshell/states.json`. The sidebar's custom model initialization was corrected in `~/.config/quickshell/ii/services/Ai.qml` so Qwen registers even when configuration loads before the AI service. Previous settings and the original QML file are in [backups/sidebar-before-qwen](backups/sidebar-before-qwen/). The earlier chat UI is in [backups/sidebar-before-chat-ui](backups/sidebar-before-chat-ui/).

## Obsidian second brain

Connected vault: `/mnt/storage/Obsidian Vault`. The drive must be mounted. Hermes is not installed as part of this connection.

In the sidebar's **Agent · Entire OS** mode, try:

- “Search my Obsidian notes for Kubernetes.”
- “Save a note titled Weekend Plan with these tasks: …”
- “Remember that I prefer short answers with examples.”
- Start a new chat, then ask “What preferences have I asked you to remember?”

The book button in the header opens `00-Inbox/Qwen/Start Here.md` in Obsidian. New notes are created in `00-Inbox/Qwen/`. Persistent facts are stored in `00-Inbox/Qwen/Memory.md`, loaded afresh on every agent request, and can be edited directly in Obsidian. Saving notes and facts uses the existing diff approval and backup flow. Reject leaves the file unchanged and ends the turn.

[obsidian.json](obsidian.json) selects the vault, inbox, and memory note. Set `enabled` to `false` to disconnect on the next request. If you relocate the vault, update this file and the sidebar's book-button URL in `AiChat.qml`.

Search reads Markdown files on demand and returns up to five ranked matches with excerpts and Obsidian links. It skips hidden directories, hidden files, symlinked notes, binary files, and files over 1 MiB. It is keyword search, with no embedding model, background index or cloud service. Notes remain searchable when Obsidian is closed. The agent adds source links when a search answer omits them.

The automatic memory note has a 4,000-character budget; separate notes hold longer reference material. `remember_fact` asks for consolidation when full; if the note is manually expanded beyond the budget, only its first 4,000 characters are loaded automatically. This is retrieval and saved context, not model training. Chat mode without tools does not load this memory.

## Local SSD knowledge

Agent mode has a private full-text index spanning useful UTF-8 text under
`/home/nami` and `/mnt/storage`. It covers project source, notes, and documents
from both SSDs. Dependencies, caches, hidden directories, model/runtime files,
binaries, databases, environment files, credentials, and likely secret files
are excluded. Qwen searches this index first and reads the selected source file
before answering; nothing is uploaded or added to the model weights.

The index refreshes daily. Rebuild or inspect it manually with:

```bash
python knowledge_base.py rebuild
python knowledge_base.py search "Huntly payment workflow"
python knowledge_base.py stats
```

Implementation: [obsidian_memory.py](obsidian_memory.py). Checks: [downloads/obsidian-qa.json](downloads/obsidian-qa.json). Pre-connection copies of the runtime and chat UI are in [backups/before-obsidian](backups/before-obsidian/).

## Validation

Run `python -m unittest discover -s . -p 'test_*.py' -v` from this directory.
The 37 tests cover the existing agent, memory and sidebar, plus AST imports,
aliases, re-exports, dynamic imports, Python imports, cyclic dependency reach,
source exclusions, project scope, Git changes/deletions, verified source links,
and the model's single-system-message template requirement. Workspace browser
checks exercised project loading, node/file navigation, source citations,
impact, Git diff, Archify rendering and desktop/mobile layouts. A live Qwen
check traced `src/App.jsx`, read `src/main.jsx`, and linked the verified import
at line 3. Earlier QML checks are recorded in
[downloads/agent-qa.json](downloads/agent-qa.json).

## API

Base URL: `http://127.0.0.1:8080/v1`
Model: `qwen-local`
API key: none required; use `local` if your client requires a nonempty key.

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-local","messages":[{"role":"user","content":"Hello!"}],"max_tokens":128}'
```

The server listens on the loopback address, so other devices cannot connect directly. Qwen mode needs no cloud account.

## Codex mode in the review workspace

Choose **Codex · Online** in the chat header to use the installed Codex CLI and its
existing login. Qwen remains the default local assistant. Each mode keeps a separate
conversation for each project. Codex can inspect source, review changes and perform
explicitly requested edits in a workspace-write sandbox. Commands and file changes
appear in the chat; Stop terminates the running process group. The project map and
Changes view refresh after a completed Codex run.

The **Model** selector uses the installed CLI's local model catalog and remembers
your choice for each account. **Sign in** opens Codex login in your terminal;
**Sign out** removes the CLI login. Account status refreshes when you return to the
window, every 15 seconds while visible, and before sending. You can also use the
refresh button after `codex login` or `codex logout` elsewhere. Conversations are
kept separately for each account and project. Unsaved editor changes stay in place
when accounts change.

**JEV assist** uses TypeSafe’s `typesafe/jev-1.13` through OpenRouter to
choose a supported reasoning effort and programming focus. Suggestions below
85% confidence use Codex defaults. Your selected model and account stay in use.

With Full access disabled and JEV enabled, Codex starts in a read-only sandbox. Proposed file edits and
commands requiring native approval are checked against the latest request before
execution. Ordinary reads remain automatic. Only individual actions with an
allow decision at 85% confidence or higher are accepted; ambiguous decisions,
unavailable checks, paths outside the project, and session-wide permission grants
are declined. This is a semantic scope check, not a replacement for sandbox rules;
approved commands use Codex’s native execution approval behavior.

A final JEV check compares the answer’s completion claims with recorded file
changes, commands, exit codes and output. Unsupported or uncertain claims get a
visible review notice. This check does not replace tests or establish correctness.

The helper sends the last four conversation texts (up to 8,000 characters),
selected file/model and image count, plus bounded proposed patches/commands and
completion evidence. It never sends image bytes or the API key. OpenRouter credits
and an internet connection are required. Turn JEV off to use normal Codex settings.
Action decisions, confidence and reported API cost appear in expandable rows.

The key stays outside the project in `~/.config/local-qwen/openrouter.key` with
permissions `0600`; it is never returned to the browser or passed to Codex. Run
`python3 jev_helper.py` in this directory to configure or replace it using a hidden
prompt, then reload the workspace. See the [Jev documentation](https://openrouter.ai/docs/guides/community/jev)
and [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).

The **Source** tab is a CodeMirror editor with syntax colors, line numbers,
search, undo and Tab indentation. **Expand** gives it the full center pane; save
with **Ctrl+S** (Cmd+S on macOS) or **Save**. Saves check the file's original version
and refuse to overwrite newer disk changes. **Reload** discards the current file's
unsaved edits. Drafts stay in memory while switching files; the browser warns before
closing a page with drafts.

The Explorer uses a nested folder tree with remembered expansion, file-type labels,
search that keeps matching parent folders, and a selected-file marker. **Reveal**
finds the current file; **Collapse** closes its folders. Use arrow keys to navigate
and expand, Enter to select, or type a filename prefix. Breadcrumbs reveal parent
folders, and the full selected path stays visible below the tree with **Copy path**.

Chat renders Markdown, highlighted code blocks with **Copy**, clickable source
citations and external links. Messages and commands appear in execution order.
Paste an image into the composer or use **+** to attach up to four PNG, JPEG or WebP
images, each up to 2 MiB. Codex receives the actual images; this local Qwen setup
supports text only. Images are kept for the current request and are not saved to
browser chat history or review logs. UI assets are bundled locally; after dependency
changes, run `npm run build:ui` to rebuild them.

Codex uses your account online and may send relevant project context to OpenAI.
It does not use the local Qwen model or its training job. If unavailable, install the
CLI and run `codex login`. See the official [non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Sources

- [Qwen3.5-2B model card](https://huggingface.co/Qwen/Qwen3.5-2B)
- [Bartowski's GGUF quantization](https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF)
- [llama.cpp release v0.4.0](https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.0), which points to build b10809
- [Server documentation for the installed build](https://github.com/ggml-org/llama.cpp/blob/b10809/tools/server/README.md)

Exact download revisions and SHA-256 checksums are recorded in [sources.json](sources.json).

Dependency maps color each neighboring file’s box and connecting arrow alike.
The corresponding local import paths are underlined in the same color in the source editor.


Arko Workspace runs as an Electron desktop app from the application menu. The
workspace service starts at login and restarts automatically if it exits. The app
keeps its own persistent profile and reloads after detecting a server restart.
Project sessions are backed up to disk, and run events are journaled as they arrive.
An interrupted task restores its output and offers **Continue**; a crashed process
cannot continue executing while it is stopped. Refresh an existing browser
workspace once to back up its older browser-only sessions before switching to the app.

**Full access** is enabled by default in the installed service, as requested.
Codex uses `danger-full-access` with approvals disabled, allowing localhost
listeners and normal host filesystem/network access. Disable **Full access** in
Settings to use the project sandbox. In full-access mode JEV still chooses
reasoning effort and checks completion evidence; native approval gating applies
to sandboxed mode. This setting affects new tasks and does not change this
assistant's own execution environment.
