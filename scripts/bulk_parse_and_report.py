"""
Parse template files through tree-sitter-xml-django and report parse errors.

Usage:
    python scripts/bulk_parse_and_report.py /path/to/templates
    python scripts/bulk_parse_and_report.py /path/to/templates --glob "**/*.html"
    python scripts/bulk_parse_and_report.py /path/to/templates --max-errors 20
    python scripts/bulk_parse_and_report.py /path/to/templates --summarize
"""
import argparse
import re
from pathlib import Path

import tree_sitter_xml_django
from tree_sitter import Language, Node, Parser

language = Language(tree_sitter_xml_django.language())
parser = Parser(language)


def collect_errors(node: Node, out: list[Node]) -> None:
    if node.type in ("ERROR", "MISSING"):
        out.append(node)
        return  # don't descend into ERROR subtrees
    for child in node.children:
        collect_errors(child, out)


def error_text(node: Node, source: bytes, max_len: int = 80) -> str:
    raw = source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
    raw = re.sub(r"\s+", " ", raw).strip()
    if len(raw) > max_len:
        raw = raw[:max_len] + "…"
    return raw


def main() -> None:
    arg_parser = argparse.ArgumentParser(
        description="Parse template files through tree-sitter-xml-django and report parse errors."
    )
    arg_parser.add_argument(
        "directory",
        type=Path,
        help="Root directory to search for template files.",
    )
    arg_parser.add_argument(
        "--glob",
        default="**/*.rml",
        help="Glob pattern to match files (default: '**/*.rml').",
    )
    arg_parser.add_argument(
        "--max-errors",
        type=int,
        default=None,
        metavar="N",
        help="Stop after encountering this many error files (default: no limit).",
    )
    args = arg_parser.parse_args()

    root: Path = args.directory
    if not root.is_dir():
        arg_parser.error(f"Directory not found: {root}")

    template_files = sorted(root.glob(args.glob))
    print(f"Found {len(template_files)} files matching '{args.glob}' under {root}\n")

    n_error_files = 0

    for path in template_files:
        source = path.read_bytes()
        tree = parser.parse(source)
        if not tree.root_node.has_error:
            continue
        n_error_files += 1

        errors: list[Node] = []
        collect_errors(tree.root_node, errors)
        rel = path.relative_to(root)
        for err in errors:
            row = err.start_point[0] + 1
            print(f"{rel}:{row} [{err.type}] {error_text(err, source)!r}")

        if args.max_errors is not None and n_error_files >= args.max_errors:
            print(f"\n[Stopping after {args.max_errors} error files]")
            break

    print()
    ok = len(template_files) - n_error_files
    print(f"  OK (no errors):    {ok:4d} / {len(template_files)}")
    print(f"  Has parse errors:  {n_error_files:4d} / {len(template_files)}")


if __name__ == "__main__":
    main()
