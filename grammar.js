/**
 * @file Django-XML template language grammar for tree-sitter
 * @author Laurent Putz <laurent.putz@kraken.tech>
 * @license UNLICENSED
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

export default grammar({
  name: "xmldjango",

  word: $ => $._identifier,

  extras: $ => [
    /\s/,
  ],

  conflicts: $ => [
    // Django templates frequently place an opening tag inside {% if %}...{% else %}
    // with the closing tag outside (tag pair crosses a block boundary). GLR tracks
    // both paths: full element and bare start_tag/end_tag. prec.dynamic(-1) on bare
    // tags ensures the full element wins when both paths succeed (well-formed XML).
    // Example :
    // {% if has_dynamic_product %}
    //     <blockTable colWidths="3.2cm,3.0cm,0.3cm,2.7cm,0.3cm,2.1cm,1.9cm,1.8cm">
    // {% else %}
    //     <blockTable colWidths="2.4cm,3.0cm,0.3cm,3.5cm,0.3cm,2.1cm,1.9cm,1.8cm">
    // {% endif %}
    //     ...
    // </blockTable>
    [$._body_node, $.element],
    // _prolog_node is a subset of _top_level_node. GLR tracks both until an
    // element or <!DOCTYPE token resolves which repeat we're in.
    [$._prolog_node, $._top_level_node],
  ],

  rules: {
    // At the document level we do NOT include char_data so that whitespace-only
    // lines (e.g. trailing newlines in test files) are consumed by extras
    // instead of generating spurious nodes.
    //
    // The prolog follows the XML spec: xml_decl?, misc*, doctype_decl?, misc*
    // where misc = comment | processing_instruction | django_node.
    // _prolog_node captures those misc nodes so that DOCTYPE remains restricted
    // to the prolog without barring valid comments/PIs/Django statements around it.
    document: $ => seq(
      optional($.xml_decl),
      repeat($._prolog_node),
      optional($.doctype_decl),
      repeat($._top_level_node),
    ),

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

    // Used inside XML element content. No bare tags — ambiguity is confined to
    // Django statement bodies where tag pairs may cross block boundaries.
    _node: $ => choice(
      $.element,
      $.char_data,
      $._reference,
      $.cdata_section,
      $.processing_instruction,
      $.comment,
      $._dj_node,
    ),

    // Used inside Django statement bodies (if/for/paired). Bare start_tag/end_tag
    // allow tag pairs that cross Django block boundaries to parse without error.
    // prec.dynamic(-1) ensures full element wins when both paths succeed; bare
    // tags only win when the element path fails (no matching close tag).
    _body_node: $ => choice(
      $.element,
      $.char_data,
      $._reference,
      $.cdata_section,
      $.processing_instruction,
      $.comment,
      $._dj_node,
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
      field('value', $.att_value),
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
    // (expressions) break char_data.
    char_data: _ => token(prec(-1, /([^<&{]|\{[^{%#])+/)),

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
    // Expressions: {{ variable }} or {{ "string" }}, optionally with filters.
    // -------------------------------------------------------------------------

    dj_variable_expr: $ => seq(
      '{{',
      choice($.dj_variable, $.dj_string),
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

    dj_variable_name: _ => /[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*/,

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
      $.dj_unpaired_statement,
    ),

    dj_paired_statement: $ => {
      const tags = [
        'autoescape',
        'block',
        'blocktrans',
        'blocktranslate',
        'ifchanged',
        'spaceless',
        'verbatim',
        'with',
      ];
      return choice(...tags.map(tag => seq(
        '{%', alias(tag, $.dj_tag_name), repeat($._dj_attribute), '%}',
        repeat($._body_node),
        '{%', alias('end' + tag, $.dj_tag_name), repeat($._dj_attribute), alias('%}', $.dj_end_paired_statement),
      )));
    },

    dj_if_statement: $ => seq(
      '{%', alias('if', $.dj_tag_name), repeat($._dj_attribute), '%}',
      repeat($._body_node),
      repeat(prec.left(seq(
        alias($.dj_elif_clause, $.dj_branch_statement),
        repeat($._body_node),
      ))),
      optional(seq(
        alias($.dj_else_clause, $.dj_branch_statement),
        repeat($._body_node),
      )),
      '{%', alias('endif', $.dj_tag_name), alias('%}', $.dj_end_paired_statement),
    ),

    dj_elif_clause: $ => seq('{%', alias('elif', $.dj_tag_name), repeat($._dj_attribute), '%}'),
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

    dj_unpaired_statement: $ => seq(
      '{%', alias($._identifier, $.dj_tag_name), repeat($._dj_attribute), '%}',
    ),

    // A key=value pair used in {% with key=value %}, {% include ... with key=val %},
    // custom tags with keyword arguments, etc.  The LHS is an assignment_target —
    // a name being bound, distinct from a variable being read.
    dj_assignment: $ => seq(
      field('name', alias($.dj_variable_name, $.dj_assignment_target)),
      '=',
      field('value', choice($.dj_variable, $.dj_string, $.dj_number, $.dj_boolean)),
    ),

    _dj_attribute: $ => seq(
      choice(
        $.dj_keyword,
        $.dj_keyword_operator,
        $.dj_operator,
        $.dj_number,
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
    // into dj_keyword_operator + dj_variable_name). Multi-word operators still use token() so
    // they are matched as an atomic unit including the embedded space.
    dj_keyword: _ => choice('on', 'off', 'with', 'as', 'silent', 'only', 'from', 'random', 'by'),

    dj_keyword_operator: _ => choice(
      'and', 'or', 'not', 'in', 'is',
      token(choice('not in', 'is not')),
    ),

    dj_operator: _ => choice('==', '!=', '<', '>', '<=', '>='),

    dj_number: _ => /[0-9]+(\.[0-9]+)?/,

    dj_boolean: _ => choice('True', 'False'),

    _identifier: _ => /[a-zA-Z_]\w*/,
  },
});