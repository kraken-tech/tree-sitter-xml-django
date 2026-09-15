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
 *   4  _generic_open_tag         -- `{% tagname` for any paired tag not handled by a
 *                                    dedicated grammar rule.
 *   5  _generic_close_tag        -- `{% endtagname` when tagname matches the top of the
 *                                    Django tag stack.
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
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Must match the order of tokens in grammar.js `externals`. */
enum TokenType {
    ERROR_RECOVERY_SENTINEL = 0,
    COMMENT_BODY_TEXT       = 1,
    ELIF_TAG_OPEN           = 2,
    ENDCOMMENT_TAG          = 3,
    GENERIC_OPEN_TAG        = 4,
    GENERIC_CLOSE_TAG       = 5,
};

/* ---------------------------------------------------------------------------
 * Scanner state -- Django tag name stack
 * --------------------------------------------------------------------------- */

/* Arbitrary stack size limits */
#define DJANGO_STACK_MAX_DEPTH  16
#define DJANGO_TAG_NAME_MAX_LEN 32

typedef struct {
    char     names[DJANGO_STACK_MAX_DEPTH][DJANGO_TAG_NAME_MAX_LEN + 1];
    uint8_t  depth;
} ScannerState;

void *tree_sitter_xml_django_external_scanner_create(void) {
    ScannerState *state = (ScannerState *)calloc(1, sizeof(ScannerState));
    return state;
}

void tree_sitter_xml_django_external_scanner_destroy(void *payload) {
    free(payload);
}

unsigned tree_sitter_xml_django_external_scanner_serialize(void *payload, char *buffer) {
    ScannerState *state = (ScannerState *)payload;
    unsigned size = 0;
    buffer[size++] = (char)state->depth;
    for (unsigned i = 0; i < state->depth; i++) {
        unsigned len = (unsigned)strlen(state->names[i]);
        memcpy(buffer + size, state->names[i], len + 1); /* include '\0' */
        size += len + 1;
    }
    return size;
}

void tree_sitter_xml_django_external_scanner_deserialize(
    void *payload, const char *buf, unsigned length
) {
    ScannerState *state = (ScannerState *)payload;
    state->depth = 0;
    if (length == 0) return;
    unsigned pos = 0;
    uint8_t raw_depth = (uint8_t)(unsigned char)buf[pos++];
    state->depth = raw_depth > DJANGO_STACK_MAX_DEPTH ? DJANGO_STACK_MAX_DEPTH : raw_depth;
    for (unsigned i = 0; i < state->depth && pos < length; i++) {
        unsigned name_len = 0;
        while (pos < length && buf[pos] != '\0' && name_len < DJANGO_TAG_NAME_MAX_LEN) {
            state->names[i][name_len++] = buf[pos++];
        }
        state->names[i][name_len] = '\0';
        if (pos < length) pos++; /* skip null terminator */
    }
}

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

/* Tags that have their own dedicated grammar rules and must NOT be captured
 * by the generic open-tag scanner. */
static const char *const EXCLUDED_OPEN_TAGS[] = {
    "if", "for", "block", "comment",
    "elif", "else", "empty",
    NULL
};

static bool is_excluded_open_tag(const char *name) {
    for (int i = 0; EXCLUDED_OPEN_TAGS[i] != NULL; i++) {
        if (strcmp(name, EXCLUDED_OPEN_TAGS[i]) == 0) return true;
    }
    return false;
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

    /* EOF -- capture any trailing normal chars since the last mark_end call. */
    if (!has_content) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = COMMENT_BODY_TEXT;
    return true;
}

/* ---------------------------------------------------------------------------
 * has_close_tag
 *
 * Scans forward from the current lexer position looking for `{% endXXX`
 * where XXX matches `tagname` exactly (case-sensitive, word boundary
 * required after `endXXX`), after encountering a `{%` opening tag.
 * Returns true if a matching close tag is found, false otherwise.
 *
 * Must be called AFTER `lexer->mark_end` has been set at the end of the
 * opening tag name.  All advances here are speculative -- because mark_end
 * was already called, the emitted token's extent is already fixed and these
 * characters will be re-presented to the lexer for the next token when the
 * scanner returns true.  When the scanner returns false, tree-sitter resets
 * the lexer to the position it was at before the scanner was called, so the
 * speculative advances are also discarded in that case.
 * --------------------------------------------------------------------------- */
static bool has_close_tag(TSLexer *lexer, const char *tagname,
                           unsigned tagname_len) {
    /* All advances here MUST use skip=false.
     * skip=false advances are purely speculative lookahead: they consume input
     * but do not extend the token beyond the mark_end position. */
    while (lexer->lookahead != 0) {
        /* Fast path: skip until we see '{' */
        if (lexer->lookahead != '{') {
            lexer->advance(lexer, false);
            continue;
        }
        lexer->advance(lexer, false); /* consume '{' */

        if (lexer->lookahead != '%') continue; /* not '{%', keep scanning */
        lexer->advance(lexer, false);           /* consume '%' */

        /* Optional trim dash */
        if (lexer->lookahead == '-') lexer->advance(lexer, false);

        /* Skip whitespace */
        while (is_space(lexer->lookahead)) lexer->advance(lexer, false);

        /* Must start with "end" */
        static const char end_pfx[] = "end";
        bool has_end = true;
        for (int i = 0; end_pfx[i] != '\0'; i++) {
            if (lexer->lookahead != (int32_t)(unsigned char)end_pfx[i]) {
                has_end = false;
                break;
            }
            lexer->advance(lexer, false);
        }
        if (!has_end) continue;

        /* Must be followed by tagname */
        bool name_ok = true;
        for (unsigned i = 0; i < tagname_len; i++) {
            if (lexer->lookahead != (int32_t)(unsigned char)tagname[i]) {
                name_ok = false;
                break;
            }
            lexer->advance(lexer, false);
        }
        if (!name_ok) continue;

        /* Word boundary -- next char must not be a word character */
        if (!is_word_char(lexer->lookahead)) return true;
        /* else: `endXXXlonger` -- not our close tag, keep scanning */
    }
    return false;
}

/* ---------------------------------------------------------------------------
 * try_scan_dj_tag
 *
 * Combined scanner for ELIF_TAG_OPEN, GENERIC_CLOSE_TAG, and GENERIC_OPEN_TAG.
 *
 * Searches for a `{% tagname` (incl. `elif`) sequence and dispatches to the
 * appropriate token type.
 * Input flags indicate which token types are valid at the current parse position.
 *
 * Dispatch order (preserves the original priority intent):
 *   1. ELIF_TAG_OPEN    -- exact keyword "elif", most specific
 *   2. GENERIC_CLOSE_TAG -- requires stack match, more specific than open
 *   3. GENERIC_OPEN_TAG  -- generic fallback, requires a forward-scan for close
 *
 * Token span: `{%[-][whitespace]` is consumed with skip=true and excluded from
 * the emitted node's source range.
 * --------------------------------------------------------------------------- */

static bool try_scan_dj_tag(TSLexer *lexer, ScannerState *state,
                              bool need_elif, bool need_close, bool need_open) {
    /* Skip leading whitespace */
    while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

    /* Must start with '{%' */
    if (lexer->lookahead != '{') return false;
    lexer->advance(lexer, true);
    if (lexer->lookahead != '%') return false;
    lexer->advance(lexer, true);

    /* Optional whitespace-trimming dash */
    if (lexer->lookahead == '-') lexer->advance(lexer, true);

    /* Skip whitespace between '%' and the keyword */
    while (is_space(lexer->lookahead)) lexer->advance(lexer, true);

    /* Read tag name -- skip=false so these characters appear in the token span */
    char name[DJANGO_TAG_NAME_MAX_LEN + 1];
    unsigned name_len = 0;
    while (is_word_char(lexer->lookahead) && name_len < DJANGO_TAG_NAME_MAX_LEN) {
        name[name_len++] = (char)lexer->lookahead;
        lexer->advance(lexer, false);
    }
    name[name_len] = '\0';

    if (name_len == 0) return false;

    /* Word boundary -- must not be followed by another word character */
    if (is_word_char(lexer->lookahead)) return false;

    /* 1. ELIF_TAG_OPEN */
    if (need_elif && strcmp(name, "elif") == 0) {
        lexer->result_symbol = ELIF_TAG_OPEN;
        return true;
    }

    /* 2. GENERIC_CLOSE_TAG */
    if (need_close && state->depth > 0 &&
        name_len > 3 && strncmp(name, "end", 3) == 0) {
        const char *suffix = name + 3;
        if (strcmp(suffix, state->names[state->depth - 1]) == 0) {
            state->depth--;
            lexer->result_symbol = GENERIC_CLOSE_TAG;
            return true;
        }
    }

    /* 3. GENERIC_OPEN_TAG */
    if (need_open) {
        /* Tags beginning with "end" are close tokens, not opens */
        if (name_len > 3 && strncmp(name, "end", 3) == 0) return false;
        /* Tags with dedicated grammar rules */
        if (is_excluded_open_tag(name)) return false;
        /* Stack full -- fall through to dj_unpaired_statement */
        if (state->depth >= DJANGO_STACK_MAX_DEPTH) return false;
        /* A close tag is "end" (3 chars) + this name; if the combined length
         * exceeds DJANGO_TAG_NAME_MAX_LEN the close tag's name would be
         * truncated in the read buffer and never matched -- fall through. */
        if (name_len > DJANGO_TAG_NAME_MAX_LEN - 3) return false;

        /* Fix the token end at the end of the tag name.  Subsequent advances
         * in has_close_tag are speculative and do not extend the emitted token. */
        lexer->mark_end(lexer);

        if (!has_close_tag(lexer, name, name_len)) return false;

        memcpy(state->names[state->depth], name, name_len + 1);
        state->depth++;
        lexer->result_symbol = GENERIC_OPEN_TAG;
        return true;
    }

    return false;
}

/* ---------------------------------------------------------------------------
 * Main scan entry point
 * --------------------------------------------------------------------------- */

bool tree_sitter_xml_django_external_scanner_scan(
    void *payload,
    TSLexer *lexer,
    const bool *valid_symbols
) {
    ScannerState *state = (ScannerState *)payload;

    /* Detect tree-sitter error-recovery mode: during error recovery all
       external tokens are marked valid, including the sentinel which is
       never valid during normal parsing. */
    if (valid_symbols[ERROR_RECOVERY_SENTINEL]) return false;

    /* ENDCOMMENT_TAG must be tried before COMMENT_BODY_TEXT.  When an empty
       comment body is present both tokens are in valid_symbols; we must emit
       ENDCOMMENT_TAG rather than an empty (invalid) COMMENT_BODY_TEXT. */
    if (valid_symbols[ENDCOMMENT_TAG]) {
        if (try_scan_endcomment_tag(lexer)) return true;
    }

    if (valid_symbols[COMMENT_BODY_TEXT]) {
        return scan_comment_body(lexer);
    }

    /* ELIF_TAG_OPEN, GENERIC_CLOSE_TAG, and GENERIC_OPEN_TAG all start with
       {%tagname, so use a combined scan */
    bool need_elif  = valid_symbols[ELIF_TAG_OPEN];
    bool need_close = valid_symbols[GENERIC_CLOSE_TAG];
    bool need_open  = valid_symbols[GENERIC_OPEN_TAG];

    if (need_elif || need_close || need_open) {
        return try_scan_dj_tag(lexer, state, need_elif, need_close, need_open);
    }

    return false;
}
