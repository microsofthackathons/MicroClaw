# Contributing to MicroClaw

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the
instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](https://github.com/yuxwei_microsoft/microclaw/issues) to report bugs or request features.
- Before creating a new issue, please search existing issues to avoid duplicates.
- Include as much detail as possible: steps to reproduce, expected behavior, actual behavior, and system information.

### Pull Requests

1. Fork the repository and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. Ensure the test suite passes:
   ```bash
   npm test          # runs tests across desktop, renderer, studio-backend
   ```
4. Make sure your code builds:
   ```bash
   cd desktop && npm run build
   ```
5. Run lint and format checks locally — CI will reject PRs that fail either:
   ```bash
   npm run lint            # ESLint across all four JS/TS packages
   npm run format:check    # Prettier formatting check
   npm run format          # auto-fix formatting issues
   ```
   To lint a single package, use one of `npm run lint:main`,
   `lint:renderer`, `lint:studio-backend`, `lint:weixin`.
6. Update documentation if your changes affect it.
7. Submit a pull request.

### Development Setup

1. Clone the repository
2. Install Node.js 22+
3. Install dependencies:
   ```bash
   cd desktop && npm install
   ```
4. Start the dev server:
   ```bash
   cd desktop && npm run dev
   ```

See the [README](README.md) for full architecture details and project structure.

### Coding Guidelines

- TypeScript strict mode is enabled across all modules.
- Follow existing code patterns and naming conventions.
- Use the `namespace:action` pattern for IPC handlers.
- Place test files alongside source files with `.test.ts` suffix.

### Linting & Formatting

- **ESLint** catches code-quality issues (unused vars, unsafe `any`, etc.).
  Enforced on every PR via `.github/workflows/pr-build.yml`; a failing lint
  check blocks merge. Four packages are checked: `desktop/`,
  `desktop/renderer/`, `desktop/studio-backend/`, and `plugins/openclaw-weixin/`.
  From the repo root run `npm run lint`.
- **Prettier** enforces consistent code formatting (indentation, quotes,
  line breaks). Configuration lives in `.prettierrc.json` at the repo root.
  CI runs `npm run format:check`; run `npm run format` locally to auto-fix.
- **VS Code** is configured (via `.vscode/settings.json`) to format on save
  with Prettier and run `eslint --fix` on save. Install the recommended
  extensions (Prettier, ESLint, Vue, EditorConfig) on first open and you
  generally never need to think about formatting again.
- The two tools are coordinated via `eslint-config-prettier`, which disables
  ESLint rules that would fight with Prettier output.
- **Ruff** lints and formats Python sources (`deploy.py`, `deployer/`).
  Configuration lives in `pyproject.toml` at the repo root. CI runs
  `ruff check` and `ruff format --check`; locally:
  ```bash
  python -m pip install "ruff>=0.14.0"   # one-time
  ruff check .              # lint
  ruff format .             # auto-fix formatting
  ruff format --check .     # CI parity
  ```
  Ruff replaces Black, isort, and most of flake8 in one fast tool.
- A repo-wide `.editorconfig` defines indentation, line endings, and
  trailing-whitespace rules; install the EditorConfig extension if your
  editor doesn't support it natively.
- Line endings are normalized via `.gitattributes` — do not commit CRLF
  files unless they are Windows-only scripts (`.ps1`, `.cmd`, `.bat`).

## Legal

By contributing to this project, you agree that your contributions will be licensed under the [MIT License](LICENSE).
