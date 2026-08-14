.PHONY: dev generate test package

dev:
	npm install
	uv sync

generate:
	npx tree-sitter generate

test:
	npx tree-sitter test
	uv run pytest bindings/python/tests/

package:
	pyproject-build
