/**
 * External scanner for tree-sitter-xml-django.
 * Entirely LLM-generated.
 *
 * External tokens (must match the order in grammar.js `externals`):
 *   0  _error_recovery_sentinel  — never valid in normal parsing; used to
 *                                   detect tree-sitter error-recovery mode.
 *   1  _comment_body_text        — the raw body of a {% comment %}…{% endcomment %}.
 *   2  _elif_tag_open            — `{% elif` opening sequence inside an if_statement.
 *   3  _endcomment_tag           — the full `{% endcomment %}` closing sequence.
 *
 * --- _comment_body_text ---
 * Consumes every character between {% comment %} and the FIRST occurrence of
 * {% endcomment %}, treating the body as a single opaque blob.  Inner {%…%}
 * sequences (e.g. stale Django tags left inside a comment) are swallowed whole.
 *
 * Why an external scanner instead of a grammar rule?
 * A grammar-level rule such as
 *     repeat1(choice(plain_text, seq('{%', any_body, '%}')))
 * cannot distinguish {% endcomment %} from other tags without consuming the
 * '{%' token first.  In GLR mode this means the "shift" path (treating
 * {% endcomment %} as just another inner tag) succeeds whenever a second
 * {% endcomment %} exists later in the file, so multi-block comment files
 * are incorrectly parsed.  The external scanner reads character by character
 * and can stop reliably at the first occurrence.
 *
 * --- _elif_tag_open ---
 * Establishes the elif_clause parse path by scanning from `{` through `{% elif`
 * as a single token.  The `{%`, optional trim dash, and leading whitespace are
 * consumed with skip=true so they are excluded from the emitted token; only the
 * four characters of `elif` are included.  This makes the resulting tag_name
 * node span just `elif`, consistent with every other tag_name node in the tree.
 * Emitted only when valid_symbols indicates the parser is inside an if_statement
 * body (i.e. an elif_clause can start here).  By consuming `{%` inside the
 * scanner rather than relying on the grammar's anonymous `{%` token, the
 * elif_clause parse path is established at the `{` character — before the GLR
 * state for unpaired_statement can compete.  This fixes ERROR nodes caused by
 * the parser losing the elif_clause path after a Django-only body node
 * ({% include %} etc.).
 *
 * --- _endcomment_tag ---
 * Consumes the entire `{% endcomment %}` closing sequence (including `%}`) as
 * one opaque token.  This prevents the `%}` from being ambiguous with the
 * closing `%}` of enclosing `{% if %}` blocks at deep nesting levels (gap 6).
 * Must be tried BEFORE _comment_body_text when both are valid so that an empty
 * comment body (`{% comment %}{% endcomment %}`) emits this token rather than
 * an empty (invalid) comment_body_text.
 *
 * Error-recovery mode:
 * During tree-sitter error recovery ALL external tokens are marked valid.
 * The scanner detects this by checking valid_symbols[ERROR_RECOVERY_SENTINEL]
 * and immediately returns false, preventing it from accidentally consuming
 * content that isn't actually a comment body or elif keyword.
 */

#include "tree_sitter/parser.h"
#include <stdbool.h>

/* Must match the order of tokens in grammar.js `externals`. */
enum TokenType {
    ERROR_RECOVERY_SENTINEL = 0,
    COMMENT_BODY_TEXT       = 1,
    ELIF_TAG_OPEN           = 2,
    ENDCOMMENT_TAG          = 3,
};

/* No heap state needed. */
void *tree_sitter_xml_django_external_scanner_create(void) { return NULL; }
void  tree_sitter_xml_django_external_scanner_destroy(void *p) { (void)p; }
unsigned tree_sitter_xml_django_external_scanner_serialize(void *p, char *buf) {
    (void)p; (void)buf; return 0;
}
void tree_sitter_xml_django_external_scanner_deserialize(
    void *p, const char *buf, unsigned len
) { (void)p; (void)buf; (void)len; }

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

static bool is_space(int32_t c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static bool is_word_char(int32_t c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c == '_';
}

/* ---------------------------------------------------------------------------
 * try_scan_endcomment_tag
 *
 * Attempts to consume the full `{% endcomment %}` sequence from the current
 * lexer position (which must be sitting on '{').  Handles optional whitespace-
 * trimming dashes and arbitrary whitespace around the keyword.
 *
 * Returns true (setting result_symbol) if the full sequence is matched.
 * Returns false without advancing if the input does not match — the caller
 * must NOT have called mark_end before this point since we advance speculatively.
 *
 * NOTE: On a successful match, all characters including the final '}' are
 * consumed.  mark_end() is called once at the end to commit the token.
 * --------------------------------------------------------------------------- */

static bool try_scan_endcomment_tag(TSLexer *lexer) {
    /* Must start with '{' */
    if (lexer->lookahead != '{') return false;
    lexer->advance(lexer, false);

    if (lexer->lookahead != '%') return false;
    lexer->advance(lexer, false);

    /* Optional trim dash */
    if (lexer->lookahead == '-') lexer->advance(lexer, false);

    /* Skip whitespace */
    while (is_space(lexer->lookahead)) lexer->advance(lexer, false);

    /* Match "endcomment" */
    static const char kw[] = "endcomment";
    for (int i = 0; kw[i] != '\0'; i++) {
        if (lexer->lookahead != (int32_t)(unsigned char)kw[i]) return false;
        lexer->advance(lexer, false);
    }

    /* Word boundary — must not be followed by another word character */
    if (is_word_char(lexer->lookahead)) return false;

    /* Skip whitespace before closing %} */
    while (is_space(lexer->lookahead)) lexer->advance(lexer, false);

    /* Optional trim dash before %} */
    if (lexer->lookahead == '-') lexer->advance(lexer, false);

    /* Must close with '%}' */
    if (lexer->lookahead != '%') return false;
    lexer->advance(lexer, false);
    if (lexer->lookahead != '}') return false;
    lexer->advance(lexer, false);

    lexer->mark_end(lexer);
    lexer->result_symbol = ENDCOMMENT_TAG;
    return true;
}

/* ---------------------------------------------------------------------------
 * try_scan_elif_tag_open
 *
 * Attempts to consume the full `{% elif` opening sequence from the current
 * lexer position.  The scanner is called here at the `{` character, BEFORE
 * the grammar's anonymous `{%` token is consumed.  By capturing `{%` inside
 * the scanner we establish the elif_clause path at the earliest possible
 * point, preventing the GLR parser from losing it after a Django-only body
 * node ({% include %}, etc.) was the previous token.
 *
 * Handles optional whitespace-trimming dashes and arbitrary whitespace
 * between `{%` and `elif`.
 *
 * Returns true (setting result_symbol) on a full match; false otherwise.
 * Tree-sitter resets the lexer position on false, so partial advances are safe.
 * --------------------------------------------------------------------------- */

static bool try_scan_elif_tag_open(TSLexer *lexer) {
    /* Must start with '{' — consume but exclude from token (skip=true) */
    if (lexer->lookahead != '{') return false;
    lexer->advance(lexer, true);

    /* Must be followed by '%' — also excluded from token */
    if (lexer->lookahead != '%') return false;
    lexer->advance(lexer, true);

    /* Optional trim dash — excluded from token */
    if (lexer->lookahead == '-') lexer->advance(lexer, true);

    /* Skip whitespace — excluded from token */
    while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

    /* Match "elif" — included in token (skip=false) so tag_name spans only "elif",
     * consistent with every other tag_name node in the tree. */
    static const char kw[] = "elif";
    for (int i = 0; kw[i] != '\0'; i++) {
        if (lexer->lookahead != (int32_t)(unsigned char)kw[i]) return false;
        lexer->advance(lexer, false);
    }

    /* Word boundary — must not be followed by another word character */
    if (is_word_char(lexer->lookahead)) return false;

    lexer->result_symbol = ELIF_TAG_OPEN;
    return true;
}

/* ---------------------------------------------------------------------------
 * scan_comment_body
 *
 * Strategy using mark_end:
 *
 *   - Advance normal characters freely; `mark_end` is called only before
 *     speculative lookahead around '{%'.
 *   - When we see '{', call mark_end() to fix the confirmed token end BEFORE
 *     that '{', then peek ahead.
 *   - If the '{' is NOT followed by '%': call mark_end() again to include
 *     the '{', then continue.
 *   - If the '{%' starts {% endcomment %} (optionally with '-' trim markers
 *     and leading whitespace): return with the token ending before '{'.
 *   - If the '{%' is any other tag: consume it to its closing '%}', call
 *     mark_end() to include the whole tag, then continue.
 *   - At EOF: call mark_end() once more to capture any trailing normal chars
 *     that followed the last mark_end call.
 *
 * NOTE: mark_end() FIXES the token end at the current lookahead position.
 * Subsequent advance() calls move the lexer but do NOT extend the token.
 * Calling mark_end() again at a later position DOES extend it.  Normal chars
 * between two '{' checks are implicitly included when mark_end() is called
 * at the NEXT '{' (or at EOF).
 * --------------------------------------------------------------------------- */

static bool scan_comment_body(TSLexer *lexer) {
    bool has_content = false;

    while (lexer->lookahead != 0) {

        if (lexer->lookahead != '{') {
            lexer->advance(lexer, false);
            has_content = true;
            continue;
        }

        /* ---- '{' found ---- */

        /* Fix the confirmed token end BEFORE this '{'. */
        lexer->mark_end(lexer);

        /* Consume '{' speculatively. */
        lexer->advance(lexer, false);

        if (lexer->lookahead != '%') {
            /* Plain '{' — include it and carry on. */
            lexer->mark_end(lexer);
            has_content = true;
            continue;
        }

        /* ---- '{%' found — is it {% endcomment %}? ---- */

        lexer->advance(lexer, false); /* consume '%' */

        /* Optional whitespace-trimming dash. */
        if (lexer->lookahead == '-') {
            lexer->advance(lexer, false);
        }

        /* Skip leading whitespace. */
        while (is_space(lexer->lookahead)) {
            lexer->advance(lexer, false);
        }

        /* Try to match the keyword "endcomment". */
        static const char kw[] = "endcomment";
        bool matched = true;
        for (int i = 0; kw[i] != '\0'; i++) {
            if (lexer->lookahead != (int32_t)(unsigned char)kw[i]) {
                matched = false;
                break;
            }
            lexer->advance(lexer, false);
        }

        if (matched) {
            /* Ensure it's a word boundary (not "endcommentfoo"). */
            int32_t c = lexer->lookahead;
            bool boundary = !is_word_char(c);
            if (boundary) {
                /* This IS {% endcomment %} — stop here. */
                if (!has_content) return false;
                lexer->result_symbol = COMMENT_BODY_TEXT;
                return true;
            }
        }

        /* ---- Not {% endcomment %} — consume to closing '%}' ---- */

        while (lexer->lookahead != 0) {
            if (lexer->lookahead == '%') {
                lexer->advance(lexer, false);
                if (lexer->lookahead == '}') {
                    lexer->advance(lexer, false);
                    /* Include the whole {%…%} tag in the confirmed token. */
                    lexer->mark_end(lexer);
                    has_content = true;
                    goto next_outer;
                }
                continue;
            }
            lexer->advance(lexer, false);
        }

        next_outer:;
    }

    /* EOF — capture any trailing normal chars since the last mark_end call. */
    if (!has_content) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = COMMENT_BODY_TEXT;
    return true;
}

/* ---------------------------------------------------------------------------
 * Main scan entry point
 * --------------------------------------------------------------------------- */

bool tree_sitter_xml_django_external_scanner_scan(
    void *payload,
    TSLexer *lexer,
    const bool *valid_symbols
) {
    (void)payload;

    /* Detect tree-sitter error-recovery mode: during error recovery all
       external tokens are marked valid, including the sentinel which is
       never valid during normal parsing. */
    if (valid_symbols[ERROR_RECOVERY_SENTINEL]) return false;

    /* ELIF_TAG_OPEN must be tried first.  During error recovery or in ambiguous
       GLR states, COMMENT_BODY_TEXT can be spuriously present in valid_symbols
       at the same time as ELIF_TAG_OPEN.  If we checked COMMENT_BODY_TEXT first,
       scan_comment_body would consume the {% elif … %} sequence as raw comment
       content before ELIF_TAG_OPEN gets a chance. */
    if (valid_symbols[ELIF_TAG_OPEN]) {
        if (try_scan_elif_tag_open(lexer)) return true;
    }

    /* ENDCOMMENT_TAG must be tried before COMMENT_BODY_TEXT.  When an empty
       comment body is present both tokens are in valid_symbols; we must emit
       ENDCOMMENT_TAG rather than an empty (invalid) COMMENT_BODY_TEXT. */
    if (valid_symbols[ENDCOMMENT_TAG]) {
        if (try_scan_endcomment_tag(lexer)) return true;
    }

    if (valid_symbols[COMMENT_BODY_TEXT]) {
        return scan_comment_body(lexer);
    }

    return false;
}
