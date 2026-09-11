# tree-sitter-xml-django

Django-XML template language grammar for [tree-sitter](https://tree-sitter.github.io/tree-sitter/).

Supports `.xml` and `.rml` files using Django template syntax embedded in XML.

## Requirements

- Node.js (for grammar generation)
- Python 3.x (for Python bindings)
- [tree-sitter CLI](https://github.com/tree-sitter/tree-sitter)

## Usage

### Python

```python
import tree_sitter_xml_django as ts_xml_django
from tree_sitter import Language, Parser

language = Language(ts_xml_django.language())
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

To publish a new version of the package to PyPI:

1. Bump the `version` field in `pyproject.toml` (follows [semver](https://semver.org/))
2. Merge the change to `main`

CI will detect that the version has no corresponding git tag, publish the package to PyPI, and then push a `vX.Y.Z` tag to GitHub automatically. No manual tagging or release steps are needed.

If a merge to `main` does not include a version bump, the publish step is skipped silently.

### The external scanner at src/scanner.c

Using the parser requires a binding in your target language that calls the generated file `src/parser.c`.
For more complex "lookahead" rules, `src/scanner.c` provides a collection of methods that expose tokens
referenced in `parser.c`. It is worth noting that `parser.c` cannot be edited directly without breaking
the synchronisation between `grammar.js` and `parser.c`, but `scanner.c` _can_ be edited so long as the
method names don't change. The CI will only detect differences between the generated `parser.c` file and
its grammar rules in `grammar.js`, and from the perspective of the parser, a change to the method logic
doesn't change what it sees - only the method name that it calls.

### Paired vs unpaired Django statements

Django template tags fall into two categories, and the grammar treats them very differently.

**Unpaired statements** (e.g. `{% load %}`, `{% url %}`, `{% csrf_token %}`) stand alone — no
body, no closing tag.  Because they require no context about what came before or after, the
grammar handles them with a single catch-all rule (`dj_unpaired_statement`) that matches any
`{% identifier %}` not claimed by a more specific rule.  The tag name is deliberately not
enumerated; knowing it adds nothing to the parse.

**Paired statements** (e.g. `{% block %}...{% endblock %}`, `{% if %}...{% endif %}`) enclose a
body and require a matching closing tag.  The grammar must know the tag name at parse time in
order to look for the correct `{% endXXX %}` closing token — this is why paired tags are handled
by named rules or an explicit whitelist rather than a catch-all.

This distinction explains what happens with an **unknown paired tag**: because the parser has no
rule telling it to look for a closing `{% endcustom %}`, the opening tag falls through to the
catch-all and is recorded as a `dj_unpaired_statement`.  The closing `{% endcustom %}` is then
parsed as a second, separate `dj_unpaired_statement`.  See
[Unknown paired Django tags](#unknown-paired-django-tags) under Limitations for the planned fix.

N.B: It's important to note that the `{% [tag] %} ... {% end[tag] %}` convention is just that,
a convention not a rule of Django syntax. Any proposed fix would need to be lenient on paired
statements that do not follow this convention.

### Not (yet) implemented

Query files (typically found at `/queries/*.scm`) are not implemented in this grammar.
The only use case for this library at the time of writing is programmatic
tree manipulation, not editor integration. Implement these if the grammar is ever adopted
for editor use (syntax highlighting, language injection, symbol navigation).

## Limitations

### XML tags spanning Django conditional branches

Django templates sometimes use conditional blocks to select between variants of
an XML structure, relying on the template engine to produce valid XML at render
time even though the static source is not well-formed XML.  Any XML tag that
opens or closes across a Django branch boundary — in either direction — will
produce incorrect parse trees:

```django
{# open before block, close inside branch — ERROR nodes #}
<keepTogether>
    {% if necf_state %}
        </keepTogether>
    {% elif vic_state %}
        </keepTogether>
    {% endif %}

{# open inside branches, close after block — wrong tree, no ERROR nodes #}
{% if wide %}
    <keepTogether>
{% else %}
    <keepTogether>
{% endif %}
</keepTogether>
```

The second case appears to parse without `ERROR` nodes when the pattern sits at
the document root, but in practice these templates have a wrapping parent
element.  Inside XML element content (`_node`), bare `end_tag` is not allowed,
so the closing tag is silently consumed as the close of the parent element
instead, producing a structurally wrong tree.

Adding bare `start_tag`/`end_tag` alternatives to regular XML content causes
GLR ambiguity: the parser begins treating every ordinary opening tag as a bare
node and orphans its close tag, breaking large amounts of valid XML.

The one exception is when **both** the mismatched open and close tags land
inside Django statement bodies (e.g. inside a `{% for %}` or `{% block %}`
body), because that context already allows bare tags:

```django
{% for item in items %}
    {% if wide %}<keepTogether>{% else %}<keepTogether>{% endif %}
    <para>{{ item }}</para>
    </keepTogether>    {# inside the for body — parses without error #}
{% endfor %}
```

**If a fix becomes necessary:** the principled path is an **external scanner**
(C code in `src/scanner.c`) that maintains a stack of open XML element names.
When it encounters a `</tag>` whose name is not on the stack it emits a
distinct `_orphan_end_tag` token rather than a normal `end_tag`, allowing the
grammar to admit it in `_node` context without competing with legitimate close
tags.  This is non-trivial — the scanner needs to coordinate with Django block
boundaries — but it avoids the GLR ambiguity that makes the pure-grammar
approach unworkable.  The same scanner update would also be a natural place to
address [unknown paired Django tags](#unknown-paired-django-tags).

### Unknown paired Django tags

The grammar handles known built-in paired tags by name (`autoescape`, `block`,
`filter`, `for`, `if`, `comment`, etc.).  Any tag not in that list — including
third-party or project-specific paired tags — is parsed as two separate
`dj_unpaired_statement` nodes rather than a single `dj_paired_statement` with
a body.

**If a fix becomes necessary:** the same external scanner approach described
above for XML tags applies here.  The scanner would maintain a second stack of
open Django tag names; when it encounters `{% endXXX %}`, it checks whether
`XXX` is on the stack and, if so, emits a specialised close token that the
grammar uses to close the corresponding `dj_paired_statement`.  This removes
the need for a tag whitelist and handles arbitrary custom and third-party tags.
Both stacks could be implemented together in a single scanner update.

## License

[BSD 3-Clause](LICENSE)
