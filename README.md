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

**Paired statements with unique rules** `block`, `if-elif-else`, `for` are unique Django tags
with specific sequences that are handled separately to regular paired statements.

For **all other paired tags** (e.g. `{% editable %}...{% endeditable %}`), the external
scanner maintains a stack of open Django tag names.  When it encounters `{% endXXX %}`, it checks
whether `XXX` is on the stack and, if so, emits a specialised close token that closes the
corresponding `dj_paired_statement`. This means arbitrary third-party and project-specific paired
tags are handled automatically without needing to enumerate them in the grammar.

N.B: The `{% [tag] %} ... {% end[tag] %}` convention is just that — a convention, not a rule of
Django syntax. The scanner is deliberately lenient: a tag that has no matching `{% endXXX %}` in
the remaining input is still treated as an unpaired statement rather than an error.

### Not (yet) implemented

Query files (typically found at `/queries/*.scm`) are not implemented in this grammar.
The only use case for this library at the time of writing is programmatic
tree manipulation, not editor integration. Implement these if the grammar is ever adopted
for editor use (syntax highlighting, language injection, symbol navigation).

## Limitations

### Whitespace or newlines before branch/close tags are not preserved as `char_data`

Leading whitespace (newlines, spaces) immediately before closing paired tags such as
`{% elif %}`, or `{% endXXX %}` is consumed by the external scanner with
`skip=true` as part of establishing the correct GLR parse path.  When the whitespace
immediately precedes one of these tags with nothing else on the same line, it does not
appear as a `char_data` node in the parse tree:

```django
{% if a %}
{% elif b %}...{% endif %}
{# the \n between if-body and {% elif %} is silently dropped #}

{% mytag %}
{% endmytag %}
{# the \n between open and close is silently dropped #}

<para>This is well{% if use_whitespace %} {% elif use_hyphen %}-{% endif %}known fact</para>
{# Resolves to "This is wellknown fact" when use_whitespace=True #}
```

When there is any other content on the same line before the branch/close tag, normal
`char_data` nodes are produced for the surrounding whitespace:

```django
{% if a %}
  <x/>
{% elif b %}...{% endif %}
{# \n after {% if a %} and \n after <x/> both become char_data nodes #}
```

This is a known limitation of the GLR path-resolution mechanism in the scanner.
Removing the `skip=true` whitespace advance causes GLR to commit to the wrong parse
path for certain body content (e.g. `<!DOCTYPE>` nodes), so the current approach
is retained.

### Generic paired tag whose close tag appears only inside a comment body

If the only occurrence of `{% endXXX %}` in the remaining input sits inside a
`{% comment %}…{% endcomment %}` block, the scanner will treat it as a valid
close tag, emit `_generic_open_tag` for `XXX`, and then never emit the matching
`_generic_close_tag` (because the comment body is opaque and consumes the
`{% endXXX %}`).  This produces an `ERROR` node:

```django
{# BUG: produces ERROR — {% endmytag %} inside comment is unreachable #}
{% mytag %}{% comment %}{% endmytag %}{% endcomment %}
```

The correct fix is to make the lookahead scanner skip `{% comment %}` blocks, but
this is an uncommon pattern in practice and the added scanner complexity is not
currently justified.

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
element.  Inside XML element content (`_node`), unpaired `end_tag` is not allowed,
so the closing tag is silently consumed as the close of the parent element
instead, producing a structurally wrong tree.

Adding unpaired `start_tag`/`end_tag` alternatives to regular XML content causes
GLR ambiguity: the parser begins treating every ordinary opening tag as an unpaired
node and orphans its close tag, breaking large amounts of valid XML.

The one exception is when **both** the mismatched open and close tags land
inside Django statement bodies (e.g. inside a `{% for %}` or `{% block %}`
body), because that context already allows unpaired tags:

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
tags.

## License

[BSD 3-Clause](LICENSE)
