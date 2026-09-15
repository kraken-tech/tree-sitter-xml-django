/**
 * @file Django-XML template language grammar for tree-sitter
 * @author Laurent Putz <laurent.putz@kraken.tech>
 * @license UNLICENSED
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

export default grammar({
  name: "xml_django",

  word: $ => $._identifier,

  // Tokens emitted by src/scanner.c
  externals: $ => [
    // Dummy token that is never referenced in any grammar rule, so the parser
    // never asks the external scanner to produce it during normal parsing.
    // When the parser hits a syntax error it enters a recovery mode where it
    // speculatively tries every external token — including this one.  The
    // scanner detects that by checking whether this token is being requested
    // and immediately returns false, which prevents it from accidentally
    // consuming content that isn't actually a comment body.
    $._error_recovery_sentinel,
    // Consumes everything between {% comment %} and
    // the first {% endcomment %}, treating the body as opaque raw text.
    // Using an external scanner guarantees the first occurrence of
    // {% endcomment %} stops the token regardless of other {%...%} sequences
    // that may appear in the body.
    $._dj_comment_body_text,
    // Emitted only when the parser is inside an if_statement context.
    $._dj_elif_tag_open,
    // Consumes the entire `{% endcomment %}` closing
    // sequence (including `%}`) as a single opaque token.
    $._dj_endcomment_tag,
    // Consumed at the opening `{% tagname %}` of any paired Django statement
    // not handled by a dedicated grammar rule (if/for/block/comment).
    $._dj_generic_open_tag,
    // Consumed at the closing `{% endtagname %}` when the tag name (minus the
    // "end" prefix) matches the top of the scanner's stack.
    $._dj_generic_close_tag,
  ],

  extras: $ => [
    /\s/,
  ],

  conflicts: $ => [
    // Django templates frequently place an opening tag inside {% if %}...{% else %}
    // with the closing tag outside — the tag pair crosses a block boundary.
    // The parser explores two interpretations simultaneously: a full element
    // (start_tag + content + end_tag) and unpaired start_tag/end_tag nodes.
    // So in the example below, the parser won't be able to pair the element start
    // and end tags and will just fall back to unpaired.
    // Example:
    // {% if has_dynamic_product %}
    //     <blockTable colWidths="3.2cm,3.0cm,0.3cm,2.7cm,0.3cm,2.1cm,1.9cm,1.8cm">
    // {% else %}
    //     <blockTable colWidths="2.4cm,3.0cm,0.3cm,3.5cm,0.3cm,2.1cm,1.9cm,1.8cm">
    // {% endif %}
    //     ...
    // </blockTable>
    [$._body_node, $.element],
    // _prolog_node is a subset of _top_level_node (it excludes elements and
    // DOCTYPE).  The parser can't tell which it's looking at until it sees an
    // element or <!DOCTYPE token (confirmed _top_level_node), so both interpretations
    // are tracked until one of those disambiguates.
    [$._prolog_node, $._top_level_node],
  ],

  rules: {
    // At the document level we do NOT include char_data so that whitespace-only
    // lines (e.g. trailing newlines in test files) are not counted as nodes.
    document: $ => seq(
      optional($.xml_decl),
      repeat($._prolog_node),
      optional($.doctype_decl),
      repeat($._top_level_node),
    ),

    // Miscellaneous nodes that may appear in the prolog (before the first element).
    _prolog_node: $ => choice(
      $.processing_instruction,
      $.comment,
      $._dj_node,
    ),

    _top_level_node: $ => choice(
      $.element,
      $.processing_instruction,
      $.comment,
      $._dj_node,
      // Bare end_tag at the document root: handles the case where a Django block
      // or paired statement opens an XML element in its body but the matching
      // close tag falls outside the statement (at the document root level).
      // Kept at dynamic priority -1 so it only wins when no element is open.
      // This results in a wrong parse tree, but saves us from an error node.
      prec.dynamic(-1, $.end_tag),
    ),

    // =========================================================================
    // XML Declaration
    // =========================================================================

    xml_decl: $ => seq(
      '<?', 'xml',
      seq('version', '=', $.version_num),
      optional(seq('encoding', '=', $.enc_name)),
      optional(seq('standalone', '=', $.standalone_value)),
      '?>',
    ),

    version_num: _ => token(choice(
      seq('"', /1\.[0-9]+/, '"'),
      seq("'", /1\.[0-9]+/, "'"),
    )),

    enc_name: _ => token(choice(
      seq('"', /[A-Za-z][A-Za-z0-9._-]*/, '"'),
      seq("'", /[A-Za-z][A-Za-z0-9._-]*/, "'"),
    )),

    standalone_value: _ => token(choice(
      seq('"', choice('yes', 'no'), '"'),
      seq("'", choice('yes', 'no'), "'"),
    )),

    // =========================================================================
    // DOCTYPE declaration
    // =========================================================================

    doctype_decl: $ => seq(
      '<!DOCTYPE',
      field('name', $.name),
      optional($.external_id),
      '>',
    ),

    external_id: $ => choice(
      seq('SYSTEM', $.system_literal),
      seq('PUBLIC', $.pubid_literal, $.system_literal),
    ),

    system_literal: _ => token(choice(
      seq('"', /[^"]*/, '"'),
      seq("'", /[^']*/, "'"),
    )),

    pubid_literal: _ => token(choice(
      seq('"', /[a-zA-Z0-9 \r\n\-()+,./:=?;!*#@$_%]*/, '"'),
      seq("'", /[a-zA-Z0-9 \r\n\-()+,./:=?;!*#@$_%]*/, "'"),
    )),

    // =========================================================================
    // Content nodes (inside elements or Django block bodies)
    // =========================================================================

    // Used inside XML element content.
    _node: $ => choice(
      $.element,
      $.char_data,
      $._reference,
      $.cdata_section,
      $.processing_instruction,
      $.comment,
      $._dj_node,
    ),

    // Used inside Django statement bodies (if/for/paired).
    _body_node: $ => choice(
      $.element,
      $.char_data,
      $._reference,
      $.cdata_section,
      $.processing_instruction,
      $.comment,
      $._dj_node,
      $.doctype_decl,
      // Unpaired start_tag/end_tag are included here so that tag pairs crossing
      // Django block boundaries can parse without error. Unpaired tags are only
      // kept when there is no matching close tag in scope, but it still results
      // in a wrong parse tree.
      prec.dynamic(-1, $.start_tag),
      prec.dynamic(-1, $.end_tag),
    ),

    // =========================================================================
    // XML Elements
    // =========================================================================

    element: $ => choice(
      $.self_closing_tag,
      seq($.start_tag, optional($.content), $.end_tag),
    ),

    start_tag: $ => seq(
      '<',
      field('name', $.name),
      repeat(choice($.attribute, $._dj_node)),
      '>',
    ),

    end_tag: $ => seq(
      '</',
      field('name', $.name),
      '>',
    ),

    self_closing_tag: $ => seq(
      '<',
      field('name', $.name),
      repeat(choice($.attribute, $._dj_node)),
      '/>',
    ),

    attribute: $ => seq(
      field('name', $.name),
      '=',
      field('value', choice($.att_value, $._dj_node)),
    ),

    // Attribute values may contain Django statements/comments. The plain-text
    // portions are hidden nodes so they don't clutter the tree when there is
    // no Django content. Django variable expressions ({{ ... }}) on the other hand
    // are parsed as full nodes.
    att_value: $ => choice(
      seq('"', repeat(choice($._att_content_double, $._reference, $._dj_node)), '"'),
      seq("'", repeat(choice($._att_content_single, $._reference, $._dj_node)), "'"),
    ),

    _att_content_double: _ => token(prec(-1, /([^"<&{]|\{[^{%#])+/)),
    _att_content_single: _ => token(prec(-1, /([^'<&{]|\{[^{%#])+/)),

    content: $ => prec.left(repeat1($._node)),

    // =========================================================================
    // XML character data and special sections
    // =========================================================================

    // Only {% ... %} (statements), {# ... #} (comments), and {{ ... }}
    // (expressions) break char_data. prec(1) outbids the /\s/ extra so that
    // whitespace-only text (e.g. the space between </b> and </para>) is kept
    // as a char_data node instead of being silently consumed.
    char_data: _ => token(prec(1, /([^<&{]|\{[^{%#])+/)),

    cdata_section: $ => seq($.cdata_start, optional($.cdata), ']]>'),

    cdata_start: _ => '<![CDATA[',

    cdata: _ => /([^\]]|\][^\]]|\]\][^>])+/,

    processing_instruction: $ => seq('<?', $.pi_target, optional($.pi_content), '?>'),

    pi_target: _ => /[a-zA-Z_][a-zA-Z0-9._-]*/,

    pi_content: _ => /[^?]+(\?[^>][^?]*)*/,

    comment: _ => seq('<!--', /([^-]|-[^-])*/, '-->'),

    _reference: $ => choice($.entity_ref, $.char_ref),

    entity_ref: $ => seq('&', $.name, ';'),

    char_ref: _ => choice(
      seq('&#', /[0-9]+/, ';'),
      seq('&#x', /[0-9a-fA-F]+/, ';'),
    ),

    name: _ => /[a-zA-Z_:][a-zA-Z0-9._:-]*/,

    // =========================================================================
    // Django nodes
    // =========================================================================

    _dj_node: $ => choice(
      $.dj_variable_expr,
      $._dj_statement,
      $._dj_comment,
    ),

    // -------------------------------------------------------------------------
    // Expressions: {{ variable }}, {{ "string" }}, or {{ 0 }}, optionally
    // with filters.
    // -------------------------------------------------------------------------

    dj_variable_expr: $ => seq(
      '{{',
      choice($.dj_variable, $.dj_string, $.dj_number_expr),
      '}}',
    ),

    // -------------------------------------------------------------------------
    // Variables and string literals, used within {% ... %} statement tags
    // and dj_variable_expr above.
    // -------------------------------------------------------------------------

    dj_variable: $ => seq(
      $.dj_variable_name,
      repeat(seq('|', $.dj_filter)),
    ),

    // A number literal optionally followed by filters.  Mirrors `variable` and
    // `dj_string` so that {{ 0|filter:arg }} is valid.
    dj_number_expr: $ => seq(
      $.dj_number,
      repeat(seq('|', $.dj_filter)),
    ),

    dj_variable_name: _ => /[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*/,

    dj_block_name: _ => /[a-zA-Z_][a-zA-Z0-9_.+-]*/,

    dj_filter: $ => seq(
      $.dj_filter_name,
      optional(seq(':', choice($.dj_filter_argument, $._dj_quoted_filter_argument, $.dj_number))),
    ),

    dj_filter_name: _ => /[a-zA-Z_][a-zA-Z0-9_]*/,

    dj_filter_argument: _ => /[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*/,

    // Hidden rule: a plain quoted string used as a filter argument.  We keep
    // it separate from dj_string so it does NOT greedily consume subsequent
    // pipe-filters that belong to the outer variable.
    _dj_quoted_filter_argument: $ => choice(
      seq("'", alias(/[^']*/, $.dj_filter_argument), "'"),
      seq('"', alias(/[^"]*/, $.dj_filter_argument), '"'),
    ),

    // A quoted string literal, optionally followed by filters.  Used in
    // {% ... %} statement tag attributes.
    dj_string: $ => seq(
      choice(
        seq("'", /[^']*/, "'"),
        seq('"', /[^"]*/, '"'),
      ),
      repeat(seq('|', $.dj_filter)),
    ),

    // -------------------------------------------------------------------------
    // Statements
    // -------------------------------------------------------------------------

    _dj_statement: $ => choice(
      $.dj_paired_statement,
      alias($.dj_if_statement, $.dj_paired_statement),
      alias($.dj_for_statement, $.dj_paired_statement),
      alias($.dj_block_statement, $.dj_paired_statement),
      $.dj_comment_statement,
      $.dj_unpaired_statement,
    ),

    // Generic paired statement: handles any {% tag %}...{% endtag %} pair
    // whose tag name is not claimed by a dedicated rule (if/for/block/comment).
    dj_paired_statement: $ => seq(
      alias($._dj_generic_open_tag, $.dj_tag_name), repeat($._dj_attribute), '%}',
      repeat($._body_node),
      alias($._dj_generic_close_tag, $.dj_tag_name), repeat($._dj_attribute), alias('%}', $.dj_end_paired_statement),
    ),

    dj_if_statement: $ => seq(
      '{%', alias('if', $.dj_tag_name), repeat($._dj_attribute), '%}',
      repeat(choice(
        $._body_node,
        alias($.dj_elif_clause, $.dj_branch_statement),
      )),
      optional(seq(
        alias($.dj_else_clause, $.dj_branch_statement),
        repeat($._body_node),
      )),
      '{%', alias('endif', $.dj_tag_name), alias('%}', $.dj_end_paired_statement),
    ),

    dj_elif_clause: $ => seq(alias($._dj_elif_tag_open, $.dj_tag_name), repeat($._dj_attribute), '%}'),
    dj_else_clause: $ => seq('{%', alias('else', $.dj_tag_name), '%}'),

    dj_for_statement: $ => seq(
      '{%', alias('for', $.dj_tag_name), repeat($._dj_attribute), '%}',
      repeat($._body_node),
      optional(seq(
        alias($.dj_empty_clause, $.dj_branch_statement),
        repeat($._body_node),
      )),
      '{%', alias('endfor', $.dj_tag_name), alias('%}', $.dj_end_paired_statement),
    ),

    dj_empty_clause: $ => seq('{%', alias('empty', $.dj_tag_name), '%}'),

    // Block tags require their own rule because block names allow symbols like hyphens
    // (e.g. `{% block price-sheet-header %}`), which the generic variable_name
    // regex does not accept.
    dj_block_statement: $ => seq(
      '{%', alias('block', $.dj_tag_name), $.dj_block_name, '%}',
      repeat($._body_node),
      '{%', alias('endblock', $.dj_tag_name), optional($.dj_block_name), alias('%}', $.dj_end_paired_statement),
    ),

    dj_unpaired_statement: $ => seq(
      '{%', alias($._identifier, $.dj_tag_name), repeat($._dj_attribute), '%}',
    ),

    // Treats the body as opaque raw text so that comments containing `<` characters
    // (e.g. XML element names used in documentation) does not produce ERROR nodes.
    dj_comment_statement: $ => seq(
      '{%', alias('comment', $.dj_tag_name), repeat($._dj_attribute), '%}',
      optional($.dj_comment_content),
      alias($._dj_endcomment_tag, $.dj_end_paired_statement),
    ),

    // dj_comment_content is produced by the external scanner in src/scanner.c.
    // The scanner consumes the entire comment body — including any inner {%…%}
    // sequences — as a single opaque token, stopping just before the first
    // {% endcomment %} it encounters.
    dj_comment_content: $ => $._dj_comment_body_text,

    // A key=value pair used in {% with key=value %}, {% include ... with key=val %},
    // custom tags with keyword arguments, etc. The LHS is an assignment_target —
    // a name being bound, distinct from a variable being read.
    dj_assignment: $ => seq(
      field('name', alias($.dj_variable_name, $.dj_assignment_target)),
      '=',
      field('value', choice($.dj_variable, $.dj_string, $.dj_number_expr, $.dj_boolean)),
    ),

    _dj_attribute: $ => seq(
      choice(
        $.dj_keyword,
        $.dj_keyword_operator,
        $.dj_operator,
        $.dj_number_expr,
        $.dj_boolean,
        $.dj_string,
        $.dj_variable,
        $.dj_assignment,
      ),
      optional(','),
    ),

    // -------------------------------------------------------------------------
    // Comments
    // -------------------------------------------------------------------------

    _dj_comment: $ => $.dj_unpaired_comment,

    dj_unpaired_comment: _ => seq('{#', /([^#]|#[^}])*/, '#}'),

    // -------------------------------------------------------------------------
    // Django keywords and operators
    // -------------------------------------------------------------------------

    // Bare string literals take priority over the dj_variable_name regex at equal length.
    // Combined with word: $ => $._identifier, they are never matched
    // as a keyword prefix inside a longer identifier (e.g. 'and' won't split 'android'
    // into dj_keyword_operator + dj_variable_name).
    dj_keyword: _ => choice('on', 'off', 'with', 'as', 'silent', 'only', 'from', 'random', 'by'),

    dj_keyword_operator: _ => choice(
      'and', 'or', 'not', 'in', 'is',
      token(choice('not in', 'is not')),
    ),

    dj_operator: _ => choice('==', '!=', '<', '>', '<=', '>='),

    dj_number: _ => /-?[0-9]+(_[0-9]+)*(\.[0-9]+(_[0-9]+)*)?/,
    dj_boolean: _ => choice('True', 'False'),

    _identifier: _ => /[a-zA-Z_]\w*/,
  },
});
