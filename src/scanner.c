/**
 * External scanner for tree-sitter-xmldjango.
 *
 * External tokens (must match the order in grammar.js `externals`):
 *   0  _error_recovery_sentinel  — never valid in normal parsing; used to
 *                                   detect tree-sitter error-recovery mode.
 *   1  _comment_body_text        — the raw body of a {% comment %}…{% endcomment %}.
 *
 * The scanner consumes every character between {% comment %} and the FIRST
 * occurrence of {% endcomment %} (with optional whitespace-trimming dashes),
 * treating it as a single opaque blob.  Inner {%…%} sequences (e.g. stale
 * Django tags left inside a comment) are swallowed whole.
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
 * Error-recovery mode:
 * During tree-sitter error recovery ALL external tokens are marked valid.
 * The scanner detects this by checking valid_symbols[ERROR_RECOVERY_SENTINEL]
 * and immediately returns false, preventing it from accidentally consuming
 * content that isn't actually a comment body.
 */

#include "tree_sitter/parser.h"
#include <stdbool.h>

/* Must match the order of tokens in grammar.js `externals`. */
enum TokenType {
    ERROR_RECOVERY_SENTINEL = 0,
    COMMENT_BODY_TEXT       = 1,
};

/* No heap state needed. */
void *tree_sitter_xmldjango_external_scanner_create(void) { return NULL; }
void  tree_sitter_xmldjango_external_scanner_destroy(void *p) { (void)p; }
unsigned tree_sitter_xmldjango_external_scanner_serialize(void *p, char *buf) {
    (void)p; (void)buf; return 0;
}
void tree_sitter_xmldjango_external_scanner_deserialize(
    void *p, const char *buf, unsigned len
) { (void)p; (void)buf; (void)len; }

/* ---------------------------------------------------------------------------
 * scan
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

static bool is_space(int32_t c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

bool tree_sitter_xmldjango_external_scanner_scan(
    void *payload,
    TSLexer *lexer,
    const bool *valid_symbols
) {
    (void)payload;

    /* Detect tree-sitter error-recovery mode: during error recovery all
       external tokens are marked valid, including the sentinel which is
       never valid during normal parsing. */
    if (valid_symbols[ERROR_RECOVERY_SENTINEL]) return false;

    if (!valid_symbols[COMMENT_BODY_TEXT]) return false;

    bool has_content = false;

    while (lexer->lookahead != 0) {

        if (lexer->lookahead != '{') {
            /* Normal character — advance; token end auto-extends until mark_end
               is called.  (Once mark_end has been called, normal chars do NOT
               extend the token; the next '{' check will catch them up.) */
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
            bool boundary = (c == ' ' || c == '\t' || c == '\n' || c == '\r' ||
                              c == '-' || c == '%' || c == 0);
            if (boundary) {
                /* This IS {% endcomment %} — stop here. */
                /* Token ends at the mark set before '{'.  Return only if we
                   actually have content; an empty body means no token. */
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
                    goto next_outer; /* continue outer loop */
                }
                /* '%' not followed by '}': keep consuming inside the tag. */
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
