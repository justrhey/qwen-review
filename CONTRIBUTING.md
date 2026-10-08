# Contributing

Install Python 3.11+, Node.js 20+, Git, and ripgrep, then run `npm ci` and `npm test`.
Start the workspace with `npm start`. Maps, source browsing, Git diffs, and project trees do not require a model server. Live AI checks need your own local llama.cpp instance; selected-file Archify checks need its optional CLI.

Keep changes focused and maintain the existing project boundary, path checks, read-only review tools, and offline operation. Test behavior at those boundaries, rather than duplicating implementation details.

For a pull request, explain the concrete problem, resulting behavior, and checks you ran. Include a screenshot for visible UI changes. For a bug report, include reproducible steps, platform details, and a small sanitized fixture.

Do not commit models, runtime binaries, personal configuration, chat logs, credential files, or private source examples.
