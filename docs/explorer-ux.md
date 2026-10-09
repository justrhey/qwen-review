# Explorer navigation decisions

The user frequently locates source files while reviewing a repository in a desktop
browser. The previous Explorer listed full folder paths as unrelated groups, which
hid parent-child relationships. The goal is to identify the right file and verify
its location, including when two folders contain the same filename. Faster task
completion is an expectation to test, not an established result.

Routine flow: open a project → expand a folder or search a relative path → choose
a file → confirm the breadcrumb and full path → inspect or edit Source. First use
opens the selected file's ancestors. Search preserves matching ancestor folders.
No matches shows recovery guidance. Reveal clears search and locates the selected
file. Collapse closes branches without changing the selected file. Failed reads or
saves show a message and retain drafts where available.

## Evidence ledger

| Evidence | Task and finding | Confidence and limits | Decision and falsification |
| --- | --- | --- | --- |
| [Cowan, 2010](https://pmc.ncbi.nlm.nih.gov/articles/PMC2864034/) | Synthesis of storage and recall studies; capacity depends on task, strategies, and meaningful grouping. | Strong for constrained memory tasks; analogy-only for repository navigation. No fixed maximum number of files follows. | Keep location visible instead of requiring path recall. Reconsider if developers still confuse identical filenames across folders. |
| [Scheibehenne et al., 2010](https://scheibehenne.de/ScheibehenneGreifenederTodd2010.pdf) | Meta-analysis of 50 experiments, 63 conditions, 5,036 participants; average choice-overload effect was near zero with substantial variation. | Strong corrective evidence; file navigation differs from consumer-choice tasks. | Keep all scanned files accessible. Group and search rather than impose a numerical limit. Reconsider defaults if measured search success declines. |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [W3C tree pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) | Standards and implementation guidance, not participant experiments: text contrast, target size, visible focus, explicit hierarchy, and keyboard operation. | Strong normative constraints; automated checks do not establish full conformance. | Use 28-pixel rows, readable neutral text, an independent focus indicator, expanded/selected semantics and arrow navigation. Fail verification if a branch or file cannot be reached by keyboard. |

The `ui-design-index` route is `ui-design-systems`. Selected patterns are grouped
sidebar navigation, a content breadcrumb, and persistent state feedback. The
primary structural reference is the [VS Code interface](https://code.visualstudio.com/docs/editing/getting-started/userinterface).
Forge fonts, charcoal surfaces and motion remain the visual system. Folder names
use the existing body font at 1rem; file-type labels are secondary. Full paths wrap
below the tree and have a Copy path action. Breadcrumb parents reveal their folder.

Validation checks cover duplicate filenames, remembered collapse state, search,
breadcrumbs, path copying, arrow/Home/End/Enter navigation, visible focus, 390-pixel
layout, 200% text sizing, contrast and reduced motion. No screen-reader session or
developer timing study has been performed. A focused usability check would ask a
developer to open one of two identically named files, switch through a source
citation, and copy its path; record errors and completion time.

## Changed files and verification

- `workspace/app.js`, `workspace/index.html`, `workspace/forge.css`: nested Explorer,
  paths, editor controls, image previews, chronological chat, model selection and
  account refresh/isolation.
- `workspace/code-ui-src.js` and its locally bundled `workspace/code-ui.js`:
  CodeMirror, sanitized Markdown, highlighted code and copy actions.
- `editor_tools.py`, `codex_agent.py`, `workspace.py`: whole-file saves with version
  checks, image/model CLI inputs, account status and explicit login/logout actions.
- `package.json`, `package-lock.json`, `README.md`: bundled dependencies and usage.
- `test_editor_tools.py`, `test_codex_agent.py`, `test_workspace_features.py`: file
  conflict, path boundaries, CLI arguments, account identity and HTTP checks.

Verified on 2026-10-08:

- `python3 -m unittest test_workspace_features test_editor_tools test_codex_agent test_agent test_repository_tools test_sidebar_layout -q`: **50 passed**.
- `node --test tests/diff.test.cjs`: **5 passed**.
- `npm run build:ui` and `node --check workspace/app.js`: **passed**.
- `/tmp/check-qwen-workspace-features.js`, headless Brave via Playwright: **passed**
  whole-file editing, Ctrl+S, CRLF preservation, refusal of a stale save, retained
  drafts, nested paths, duplicate filenames, breadcrumbs/copy/reveal, tree keyboard
  navigation, native clipboard Ctrl+V, actual image/model request payloads, source
  citations, chronological Markdown, HTML sanitizing, and account/model/history
  switching. Account changes and assistant responses used controlled fixtures;
  no real account was logged out. The expected stale-save HTTP 400 was the only
  console resource error.
- `/tmp/check-qwen-forge-ui.js`: **passed** Forge palette/fonts, busy feedback,
  tool completion, view motion, mode switching, reduced motion and mobile fit.
- Large-project browser check: **379 files, 476 tree items**, dependency-map nodes
  present, row height **31.5 CSS pixels**, Explorer text contrast **9.67:1** and full
  path contrast **9.24:1**. Selected file remained reachable at 200% text sizing;
  the page had no horizontal overflow at 390 pixels. These are targeted checks,
  not a full WCAG conformance audit.
