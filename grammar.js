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
    $.doctypedecl,
  ],

  conflicts: $ => [
    // Django templates frequently place an opening tag inside {% if %}...{% else %}
    // with the closing tag outside (tag pair crosses a block boundary). GLR tracks
    // both paths: full element and bare STag/ETag. prec.dynamic(-1) on bare tags
    // ensures the full element wins when both paths succeed (well-formed XML).
    // Example :
    // {% if has_dynamic_product %}
    //     <blockTable colWidths="3.2cm,3.0cm,0.3cm,2.7cm,0.3cm,2.1cm,1.9cm,1.8cm">
    // {% else %}
    //     <blockTable colWidths="2.4cm,3.0cm,0.3cm,3.5cm,0.3cm,2.1cm,1.9cm,1.8cm">
    // {% endif %}
    //     ...
    // </blockTable>
    [$._body_node, $.element],
  ],

  rules: {
    // At the document level we do NOT include CharData so that whitespace-only
    // lines (e.g. trailing newlines in test files) are consumed by extras
    // instead of generating spurious nodes.
    document: $ => seq(
      optional($.XMLDecl),
      repeat($._top_level_node),
    ),

    _top_level_node: $ => choice(
      $.element,
      $.PI,
      $.Comment,
      $._django_node,
    ),

    // =========================================================================
    // XML Declaration
    // =========================================================================

    XMLDecl: $ => seq(
      '<?', 'xml',
      seq('version', '=', $.VersionNum),
      optional(seq('encoding', '=', $.EncName)),
      optional(seq('standalone', '=', $.Standalone)),
      '?>',
    ),

    VersionNum: _ => token(choice(
      seq('"', /1\.[0-9]+/, '"'),
      seq("'", /1\.[0-9]+/, "'"),
    )),

    EncName: _ => token(choice(
      seq('"', /[A-Za-z][A-Za-z0-9._-]*/, '"'),
      seq("'", /[A-Za-z][A-Za-z0-9._-]*/, "'"),
    )),

    Standalone: _ => token(choice(
      seq('"', choice('yes', 'no'), '"'),
      seq("'", choice('yes', 'no'), "'"),
    )),

    // =========================================================================
    // DOCTYPE declaration
    // =========================================================================

    doctypedecl: $ => seq(
      '<!DOCTYPE',
      field('name', $.Name),
      optional($.ExternalID),
      '>',
    ),

    ExternalID: $ => choice(
      seq('SYSTEM', $.SystemLiteral),
      seq('PUBLIC', $.PubidLiteral, $.SystemLiteral),
    ),

    SystemLiteral: _ => token(choice(
      seq('"', /[^"]*/, '"'),
      seq("'", /[^']*/, "'"),
    )),

    PubidLiteral: _ => token(choice(
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
      $.CharData,
      $._Reference,
      $.CDSect,
      $.PI,
      $.Comment,
      $._django_node,
    ),

    // Used inside Django statement bodies (if/for/paired). Bare STag/ETag allow
    // tag pairs that cross Django block boundaries to parse without error.
    // prec.dynamic(-1) ensures full element wins when both paths succeed; bare
    // tags only win when the element path fails (no matching close tag).
    _body_node: $ => choice(
      $.element,
      $.CharData,
      $._Reference,
      $.CDSect,
      $.PI,
      $.Comment,
      $._django_node,
      prec.dynamic(-1, $.STag),
      prec.dynamic(-1, $.ETag),
    ),

    // =========================================================================
    // XML Elements
    // =========================================================================

    element: $ => choice(
      $.EmptyElemTag,
      seq($.STag, optional($.content), $.ETag),
    ),

    STag: $ => seq(
      '<',
      field('name', $.Name),
      repeat(choice($.Attribute, $._django_node)),
      '>',
    ),

    ETag: $ => seq(
      '</',
      field('name', $.Name),
      '>',
    ),

    EmptyElemTag: $ => seq(
      '<',
      field('name', $.Name),
      repeat(choice($.Attribute, $._django_node)),
      '/>',
    ),

    Attribute: $ => seq(
      field('name', $.Name),
      '=',
      field('value', $.AttValue),
    ),

    // Attribute values may contain Django statements/comments. The plain-text
    // portions are hidden nodes so they don't clutter the tree when there is
    // no Django content. Django variable expressions ({{ ... }}) are treated
    // as literal text here (see CharData below) so they merge into the
    // surrounding text instead of appearing as separate nodes.
    AttValue: $ => choice(
      seq('"', repeat(choice($._att_content_double, $._Reference, $._django_node)), '"'),
      seq("'", repeat(choice($._att_content_single, $._Reference, $._django_node)), "'"),
    ),

    _att_content_double: _ => token(prec(-1, /([^"<&{]|\{[^%#])+/)),
    _att_content_single: _ => token(prec(-1, /([^'<&{]|\{[^%#])+/)),

    content: $ => prec.left(repeat1($._node)),

    // =========================================================================
    // XML character data and special sections
    // =========================================================================

    // Django variable expressions ({{ ... }}) are treated as literal text:
    // only {% ... %} (statements) and {# ... #} (comments) break CharData.
    CharData: _ => token(prec(-1, /([^<&{]|\{[^%#])+/)),

    CDSect: $ => seq($.CDStart, optional($.CData), ']]>'),

    CDStart: _ => '<![CDATA[',

    CData: _ => /([^\]]|\][^\]]|\]\][^>])+/,

    PI: $ => seq('<?', $.PITarget, optional($.PIContent), '?>'),

    PITarget: _ => /[a-zA-Z_][a-zA-Z0-9._-]*/,

    PIContent: _ => /[^?]+(\?[^>][^?]*)*/,

    Comment: _ => seq('<!--', /([^-]|-[^-])*/, '-->'),

    _Reference: $ => choice($.EntityRef, $.CharRef),

    EntityRef: $ => seq('&', $.Name, ';'),

    CharRef: _ => choice(
      seq('&#', /[0-9]+/, ';'),
      seq('&#x', /[0-9a-fA-F]+/, ';'),
    ),

    Name: _ => /[a-zA-Z_:][a-zA-Z0-9._:-]*/,

    // =========================================================================
    // Django nodes
    // =========================================================================

    // Note: Django variable expressions ({{ ... }}) are intentionally not a
    // choice here. They are swallowed as literal text by CharData / attribute
    // text (see above) instead of being parsed into their own nodes. The
    // `variable` and `dj_string` rules below remain in use for {% ... %}
    // statement attributes (e.g. {% if some_var %}, {% with x=value %}).
    _django_node: $ => choice(
      $._django_statement,
      $._django_comment,
    ),

    // -------------------------------------------------------------------------
    // Variables and string literals, used within {% ... %} statement tags.
    // -------------------------------------------------------------------------

    variable: $ => seq(
      $.variable_name,
      repeat(seq('|', $.filter)),
    ),

    variable_name: _ => /[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*/,

    filter: $ => seq(
      $.filter_name,
      optional(seq(':', choice($.filter_argument, $._quoted_filter_argument, $.number))),
    ),

    filter_name: _ => /[a-zA-Z_][a-zA-Z0-9_]*/,

    filter_argument: _ => /[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*/,

    // Hidden rule: a plain quoted string used as a filter argument.  We keep
    // it separate from dj_string so it does NOT greedily consume subsequent
    // pipe-filters that belong to the outer variable.
    _quoted_filter_argument: $ => choice(
      seq("'", alias(/[^']*/, $.filter_argument), "'"),
      seq('"', alias(/[^"]*/, $.filter_argument), '"'),
    ),

    // A quoted string literal, optionally followed by filters.  Used in
    // {% ... %} statement tag attributes.
    dj_string: $ => seq(
      choice(
        seq("'", /[^']*/, "'"),
        seq('"', /[^"]*/, '"'),
      ),
      repeat(seq('|', $.filter)),
    ),

    // -------------------------------------------------------------------------
    // Statements
    // -------------------------------------------------------------------------

    _django_statement: $ => choice(
      $.paired_statement,
      alias($.if_statement, $.paired_statement),
      alias($.for_statement, $.paired_statement),
      $.unpaired_statement,
    ),

    paired_statement: $ => {
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
        '{%', alias(tag, $.tag_name), repeat($._dj_attribute), '%}',
        repeat($._body_node),
        '{%', alias('end' + tag, $.tag_name), repeat($._dj_attribute), alias('%}', $.end_paired_statement),
      )));
    },

    if_statement: $ => seq(
      '{%', alias('if', $.tag_name), repeat($._dj_attribute), '%}',
      repeat($._body_node),
      repeat(prec.left(seq(
        alias($.elif_clause, $.branch_statement),
        repeat($._body_node),
      ))),
      optional(seq(
        alias($.else_clause, $.branch_statement),
        repeat($._body_node),
      )),
      '{%', alias('endif', $.tag_name), alias('%}', $.end_paired_statement),
    ),

    elif_clause: $ => seq('{%', alias('elif', $.tag_name), repeat($._dj_attribute), '%}'),
    else_clause: $ => seq('{%', alias('else', $.tag_name), '%}'),

    for_statement: $ => seq(
      '{%', alias('for', $.tag_name), repeat($._dj_attribute), '%}',
      repeat($._body_node),
      optional(seq(
        alias($.empty_clause, $.branch_statement),
        repeat($._body_node),
      )),
      '{%', alias('endfor', $.tag_name), alias('%}', $.end_paired_statement),
    ),

    empty_clause: $ => seq('{%', alias('empty', $.tag_name), '%}'),

    unpaired_statement: $ => seq(
      '{%', alias($._identifier, $.tag_name), repeat($._dj_attribute), '%}',
    ),

    _dj_attribute: $ => seq(
      choice(
        $.keyword,
        $.keyword_operator,
        $.operator,
        $.number,
        $.boolean,
        $.dj_string,
        $.variable,
      ),
      optional(choice(',', '=')),
    ),

    // -------------------------------------------------------------------------
    // Comments
    // -------------------------------------------------------------------------

    _django_comment: $ => $.unpaired_dj_comment,

    unpaired_dj_comment: _ => seq('{#', /([^#]|#[^}])*/, '#}'),

    // -------------------------------------------------------------------------
    // Django keywords and operators
    // -------------------------------------------------------------------------

    keyword: _ => token(seq(
      choice('on', 'off', 'with', 'as', 'silent', 'only', 'from', 'random', 'by'),
      /\s/,
    )),

    keyword_operator: _ => token(seq(
      choice('and', 'or', 'not', 'in', 'not in', 'is', 'is not'),
      /\s/,
    )),

    operator: _ => choice('==', '!=', '<', '>', '<=', '>='),

    number: _ => /[0-9]+(\.[0-9]+)?/,

    boolean: _ => token(seq(choice('True', 'False'), /\s/)),

    _identifier: _ => /[a-zA-Z_]\w*/,
  },
});
