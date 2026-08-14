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



## License

UNLICENSED