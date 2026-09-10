.PHONY: dev generate test package

dev:
	npm install
	uv sync
	uv run pre-commit install --install-hooks

generate:
	npx tree-sitter generate

test:
	npx tree-sitter test
	uv run pytest bindings/python/tests/

package:
	pyproject-build
