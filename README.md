# tree-sitter-xmldjango

Django-XML template language grammar for [tree-sitter](https://tree-sitter.github.io/tree-sitter/).

Supports `.xml` and `.rml` files using Django template syntax embedded in XML.

## Requirements

- Node.js (for grammar generation)
- Python 3.x (for Python bindings)
- [tree-sitter CLI](https://github.com/tree-sitter/tree-sitter)

## Usage

### Python

```python
import tree_sitter_xmldjango as ts_xmldjango
from tree_sitter import Language, Parser

language = Language(ts_xmldjango.language())
parser = Parser(language)

tree = parser.parse(b"<root>{% if condition %}<child/>{% endif %}</root>")
```

## Contributing

### First-time setup

Requires Node.js, [uv](https://docs.astral.sh/uv/), and Python 3.10+.

```bash
# Install Node.js and Python dependencies
make dev

# Install pre-commit hooks
uvx pre-commit install --install-hooks
```

`make dev` runs `npm install` (tree-sitter CLI) and `uv sync` (Python dev dependencies) in one step.

#### Common tasks

| Command | Description |
|---|---|
| `make generate` | Re-generate `src/parser.c` from `grammar.js` |
| `make test` | Run tree-sitter corpus tests and Python tests |
| `make package` | Build the Python distribution package |

### Releasing a new version

To publish a new version of the package to Nexus:

1. Bump the `version` field in `pyproject.toml` (follows [semver](https://semver.org/))
2. Merge the change to `main`

CI will detect that the version has no corresponding git tag, publish the package to Nexus, and then push a `vX.Y.Z` tag to GitHub automatically. No manual tagging or release steps are needed.

If a merge to `main` does not include a version bump, the publish step is skipped silently.

### Troubleshooting

#### Publish failures after token expiry

The GitHub fine-grained token used to push release tags (stored as `GITHUB_TOKEN` in the CircleCI `BILLING_TEAM_GITHUB_TOKEN` context) expires after one year. When it does, merges to `main` that include a version bump will fail at the **"Tag release on GitHub"** step with an error along the lines of:

```
remote: Invalid username or password.
fatal: Authentication failed for 'https://github.com/octoenergy/tree-sitter-xmldjango.git'
```

To fix it, generate a new token and update the CircleCI context:

1. Go to GitHub → your profile → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. Set the resource owner to `octoenergy`, repository access to `tree-sitter-xmldjango` only, and **Contents** permission to `Read and write`
3. Copy the new token
4. Go to [circleci.com](https://app.circleci.com) → `octoenergy` → **Organization Settings** → **Contexts** → `BILLING_TEAM_GITHUB_TOKEN`
5. Find `GITHUB_TOKEN`, click the edit/replace option, and paste the new token

The next pipeline run will pick it up automatically — no other changes needed.

### Not (yet) implemented

Query files (typically found at `/queries/*.scm`) are not implemented in this grammar.
The only use case for this library at the time of writing is programmatic
tree manipulation, not editor integration. Implement these if the grammar is ever adopted
for editor use (syntax highlighting, language injection, symbol navigation), or if we
ever open-source this grammar parser.

## License

UNLICENSED
