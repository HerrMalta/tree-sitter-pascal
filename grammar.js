// Feature flags

// Support fpc's "public name" declaration hint, e.g.
//     procedure foo; public name '_FOO';
const public_name = true;
// Support extended RTTI attributes, e.g.
//     [MyAttr(42)]
//     procedure Foo;
const rtti        = true;
// Support Delphi's anonymous procedures & functions.
const lambda      = true;
// Support fpc-specific features.
const fpc         = false;
// Support delphi-specific features.
const delphi      = true;
// Support FPC PasCocoa extensions (for objective c interopability)
const objc        = false;
// Support generic types.
const templates   = delphi || fpc;
// Try to support preprocessor better.
const use_pp      = true;
// Support DPR program files (with 'in' clause for unit paths).
const dpr_file    = true;
// Support DPK package files.
const dpk_file    = true;
// Support INC include files (code fragments).
const inc_file    = true;

// Helpers

const op = {
	infix:   (prio, lhs, op, rhs)      => prec.left(prio, seq(
		field('lhs',      lhs),
		field('operator', op),
		field('rhs',      rhs)
	)),
	prefix:  (prio, operator, operand) => prec.left(prio, seq(
		field('operator', operator),
		field('operand',  operand)
	)),
	postfix: (prio, operand, operator) => prec.left(prio, seq(
		field('operand',  operand),
		field('operator', operator)
	)),

	args: (prio, entity, open, args, close) => prec.left(prio, seq(
		field('entity', entity), open, field('args', args), close
	))
}

function delimited1(rule, delimiter = ',', precedence=0) {
	return seq(
		optional(repeat1(prec(precedence,seq(rule, delimiter)))),
		rule
	);
}

function delimited(rule, delimiter = ',') {
	return optional(delimited1(rule, delimiter));
}

// Preprocessor wrapper.
// This just supports a single `if[def] ... [else[if] ...]* endif` right now.
// It is inteded for code like this:
//
//   procedure foo;
//   {$ifdef bla}
//   var i: integer;
//   begin
//     inc(i);
//   end;
//   {$else}
//   var j: integer;
//   begin
//     dec(j);
//   end;
//   {$endif}
//
// If we don't handle this case explicitly, tree-sitter produces a completely
// broken AST, which severely messes up the syntax highlighting.
//
// Ideally, we would want to support nested ifdefs as well, but that will be
// more complex.
//
// A word of caution: It is tempting to sprinkle this macro in many more
// places, but unfortunately tihs results in a significant performance penalty.
// Use it sparingly! A general rule of thumb is to use it only in situations
// where otherwise a severly broken parse tree would be generated. For small
// errors that TreeSitter can recover from automatically, it is better not to
// use it.
function pp($, ...rule) {
	if (!use_pp)
		return seq(...rule);
	const ruleSeq = rule.length === 1 ? rule[0] : seq(...rule);
	return (
		choice(
			seq(...rule),
			seq(
				alias(/\{\$(?:ifdef|ifndef|ifopt|if\s)[^}]*\}/i, $.pp),
				optional(ruleSeq),
				repeat(seq(
					alias(/\{\$else[^}]*\}/i, $.pp),
					optional(ruleSeq)
				)),
				alias(/\{\$(?:end|ifend)[^}]*\}/i, $.pp)
			),
		)
	);
}

// Recursive preprocessor wrapper for nested IFDEF support.
// Unlike pp(), this creates a self-referencing rule that can handle
// arbitrarily nested {$IFDEF}...{$ENDIF} blocks while preserving
// full AST structure inside the blocks.
//
// Usage: ppRecursive($, 'ruleName', ...baseChoices)
// - ruleName: The name of the rule being defined (for self-reference)
// - baseChoices: The actual grammar choices (non-preprocessor paths)
function ppRecursive($, ruleName, ...baseChoices) {
	if (!use_pp)
		return choice(...baseChoices);
	return choice(
		...baseChoices,
		seq(
			alias(/\{\$(?:ifdef|ifndef|ifopt|if\s)[^}]*\}/i, $.pp),
			repeat($[ruleName]),  // Allow multiple items in IF branch (including nested IFDEFs)
			repeat(seq(
				alias(/\{\$else[^}]*\}/i, $.pp),
				repeat($[ruleName])  // Allow multiple items in ELSE/ELIF branches
			)),
			alias(/\{\$(?:end|ifend)[^}]*\}/i, $.pp)
		)
	);
}

// tr = Trailing
// Return the trailing equivalent of a rule, aliased to the non-trailing version.
const tr = ($,rule) =>
	rule[0] == '_' ? $[rule+'Tr'] : alias($[rule+'Tr'], $[rule])


function enable_if(cond, ...args) {
	return cond ? args : [];
}

// Generate rules for trailing & non-trailing statements
function statements(trailing) {
	let rn            = x => trailing ? x + 'Tr' : x
	let lastStatement = $ => trailing ? optional(tr($,'_statement')) : $._statement;
	let lastStatement1= $ => trailing ? tr($,'_statement') : $._statement;
	let semicolon     = trailing ? [] : [';'];

	return Object.fromEntries([
		[rn('if'),          $ => seq(
			$.kIf, field('condition', $._expr), $.kThen,
			field('then', lastStatement($))
		)],

		[rn('nestedIf'),    $ => prec(1,$.if)],

		[rn('ifElse'),      $ => prec.right(1, seq(
			$.kIf, field('condition', $._expr), $.kThen,
			field('then', optional(choice(tr($,'_statement'), $.if))),
			$.kElse,
			field('else', lastStatement($))
		))],

		[rn('while'),       $ => seq(
			$.kWhile, field('condition', $._expr), $.kDo,
			field('body', lastStatement($))
		)],

		[rn('repeat'),      $ => prec(2,seq(
			$.kRepeat,
			field('body', optional(tr($,'statements'))),
			$.kUntil, field('condition', $._expr),
			...semicolon
		))],

		[rn('for'),         $ => seq(
			$.kFor,
			field('start', $.assignment),
			choice($.kTo, $.kDownto),
			field('end', $._expr), $.kDo,
			field('body', lastStatement($))
		)],

		[rn('foreach'),     $ => seq(
			$.kFor,
			field('iterator', choice($.varAssignDef, $._expr)), $.kIn,
			field('iterable', $._expr), $.kDo,
			field('body', lastStatement($))
		)],

		[rn('exceptionHandler'), $ => seq(
			$.kOn,
			field('variable', optional(seq($.identifier, ':'))),
			field('exception', $.typeref), $.kDo,
			field('body', lastStatement($))
		)],

		[rn('exceptionElse'), $ => seq(
			$.kElse, repeat($._statement), lastStatement($)
		)],

		[rn('_exceptionHandlers'), $ => seq(
			repeat($.exceptionHandler),
			choice($.exceptionHandler, tr($,'exceptionHandler')),
			optional($.exceptionElse)
		)],

		[rn('try'),         $ => prec(2,seq(
			$.kTry,
			field('try', optional(tr($,'statements'))),
			choice(
				field('except', seq(
					$.kExcept,
					optional(
						choice(tr($,'statements'),
						tr($,'_exceptionHandlers'))
					)
				)),
				field('finally', seq(
					$.kFinally,
					optional(tr($,'statements'))
				))
			),
			$.kEnd, ...semicolon
		))],

		[rn('caseCase'),    $ => seq(
			field('label', $.caseLabel),
			field('body', lastStatement($))
		)],

		// Recursive rule for case branches with nested IFDEF support
		// Handles: {$IF} caseCase {$ENDIF} within case statement
		[rn('_caseBranch'), $ => ppRecursive($, '_caseBranch',
			$.caseCase
		)],

		[rn('case'),        $ => prec(2,seq(
			$.kCase, $._expr, $.kOf,
			repeat($._caseBranch),
			optional(tr($,'caseCase')),
			// Handle optional else, potentially split by preprocessor directives
			// Pattern: {$IF} else... {$ELSE} moreCases... else... {$ENDIF}
			optional(choice(
				// Normal case: just else section
				seq(
					$.kElse,
					optional(':'),
					optional(tr($,'_statements'))
				),
				// Preprocessor split: {$IF} else {$ELSE} cases+else {$ENDIF}
				seq(
					alias(/\{\$(?:ifdef|ifndef|ifopt|if\s)[^}]*\}/i, $.pp),
					$.kElse,
					optional(':'),
					optional(tr($,'_statements')),
					alias(/\{\$else[^}]*\}/i, $.pp),
					repeat($._caseBranch),
					optional(tr($,'caseCase')),
					optional(seq(
						$.kElse,
						optional(':'),
						optional(tr($,'_statements'))
					)),
					alias(/\{\$(?:end|ifend)[^}]*\}/i, $.pp)
				)
			)),
			$.kEnd, ...semicolon
		))],

		[rn('block'),       $ => seq(
			$.kBegin,
			optional(tr($,'_statements')),
			$.kEnd, ...semicolon
		)],

		[rn('asm'),         $ => seq(
			$.kAsm,
			optional($.asmBody),
			$.kEnd, ...semicolon
		)],

		[rn('with'),        $ => seq(
			$.kWith, delimited1(field('entity', $._expr)), $.kDo,
			field('body', lastStatement($))
		)],

		[rn('raise'),       $ => seq(
			$.kRaise,
			field('exception', optional($._expr)),
			optional(seq($.kAtAddress, field('address', $._expr))),
			...semicolon
		)],

		[rn('statement'),   $ => choice(
			trailing ? seq($._expr, ...semicolon) : seq($._expr, $._semicolon),
		)],

		[rn('goto'),        $ => seq($.kGoto, $.identifier, ...semicolon)],

		[rn('_statement'),   $ => choice(
			...semicolon,
			trailing ? seq($.assignment, ...semicolon) : seq($.assignment, $._semicolon),
			trailing ? seq($.varDef, ...semicolon) : seq($.varDef, $._semicolon),
			trailing ? seq($.constDef, ...semicolon) : seq($.constDef, $._semicolon),
			alias($[rn('statement')], $.statement),
			alias($[rn('if')],        $.if),
			alias($[rn('ifElse')],    $.ifElse),
			alias($[rn('while')],     $.while),
			alias($[rn('repeat')],    $.repeat),
			alias($[rn('for')],       $.for),
			alias($[rn('foreach')],   $.foreach),
			alias($[rn('try')],       $.try),
			alias($[rn('case')],      $.case),
			alias($[rn('block')],     $.block),
			alias($[rn('with')],      $.with),
			alias($[rn('raise')],     $.raise),
			alias($[rn('goto')],      $.goto),
			alias($[rn('asm')],       $.asm),
		)],

	]);
}

module.exports = grammar({
	name: "pascal",

	extras: $ => [$._space, $.comment, $.pp],

	// External tokens for ASI (Automatic Semicolon Insertion) and class body disambiguation.
	// See src/scanner.c for the implementation.
	// Note: automatic_semicolon is named (no underscore) so it appears in the tree output.
	externals: $ => [
		$.automatic_semicolon,
		$._class_body_start,
		$._dot_marker,  // Prevents ASI after dot operators (for method chaining across lines)
	],

	word: $ => $.identifier,

	conflicts: $ => [
		// The following conflict rules are only needed because "public" can be
		// a visibility or an attribute. *sigh*
		// TODO: We would probably avoid this by having separate decl* clauses
		// for use inside classes and at unit scope, since the "public"
		// attribute seems to only be valid for standalone routines.
		...enable_if(public_name,
			[$._declProc ], [ $._declOperator], [$.declConst], [$.declVar],
			[$.declType], [$.declProp]
		),
		// RTTI attributes clash with fpc declaration hints syntax since both
		// are surrounded by brackets.
		...enable_if(rtti,
			[ $.declProcFwd ], [ $.declVars], [ $.declConsts ], [ $.declTypes]
		),
		// `procedure (` could be a declaration of an anonymous procedure or
		// the call of a function named "procedure" (which doesn't actually
		// make sense, but for Treesitter it does), so we need another conflict
		// here.
		//...enable_if(lambda, [ $.lambda ]),

		// Conflict for _definition and _defProc_body: both use ppRecursive,
		// creating ambiguity when IFDEF blocks appear in procedure bodies.
		[ $._definition, $._defProc_body ],
		[ $._definition, $._defProc_body, $._defProc_bodySplit ],

		// Conflict for declTypes and declTypesSplit: when type keyword follows
		// a preprocessor directive, both rules can match.
		[ $.declTypes, $.declTypesSplit ],
		[ $._declTypeItem, $.declTypesSplit ],
		[ $.declTypesSplit ],

		// Conflict between _definition and _defProc_local: when parsing local
		// definitions in a procedure, both rules can consume _definitions.
		[ $._definition, $._defProc_local ],

		// Conflict between _classDeclaration and _declField: with optional content
		// in ppRecursive, both rules can match empty IFDEF blocks in class bodies.
		[ $._classDeclaration, $._declField ],

		// Conflict for _sectionMember: combines fields and class declarations,
		// creating potential ambiguity with other similar rules.
		[ $._sectionMember, $._declField ],
		[ $._sectionMember, $._classDeclaration ],

		// Conflict for declSection: with ppRecursive wrapper, empty visibility sections
		// can be ambiguous with subsequent sections or variant parts.
		[ $.declSection ],

		// Conflict for _declSectionItem: with ppRecursive, empty IFDEF blocks can be
		// ambiguous with class declarations and fields.
		[ $._classDeclaration, $._declSectionItem, $._declField ],
		[ $._classDeclaration, $._declSectionItem ],
		[ $._declSectionItem, $._declField ],

		// Conflict for subrange types: when parsing `TEnum.Val1..TEnum.Val2` as a type,
		// the parser sees `identifier.` which could be either _ref (expression for range)
		// or _typeref (type reference). We need both to be valid.
		[ $._ref, $._typeref ],

		// Conflict for enum type vs range expression: when parsing `(identifier)` in type
		// context, it could be an enum declaration `(val1, val2)` or a parenthesized expression
		// for a range bound.
		[ $._ref, $.declEnumValue ],

		// Conflict for literalString: string concatenation like 'A''B' can be parsed
		// as one multi-part string or two separate strings.
		[ $.literalString ],

		// Conflict between _typeref and exprTplArg when parsing nested generics inside
		// RTTI attributes, e.g. [Foo<Bar,Baz>]. Both rules can consume typerefTpl.
		[ $.exprTplArg, $._typeref ],

		// Conflict for inline var declarations: `var a : type` could be varAssignDef
		// (for `var a : type := value`) or varDef (for `var a, b : type`).
		[ $.varAssignDef, $._ident ],

		// Conflict for exprDot RHS: after `_ref kDot`, the next identifier could be
		// parsed as _ref (through exprDot recursion) or _exprDotRhs (for keyword support).
		[ $._ref, $._exprDotRhs ],

		// Conflict for True/False as enum members: these keywords can be used as
		// identifiers in enum declarations (e.g., TUseBoolStrs = (False, True))
		[ $._literal, $._ident ],
		[ $._ref, $._ident ],
		// Conflict for True/False in dot expressions (e.g., TUseBoolStrs.False)
		[ $._exprDotRhs, $._literal ],
	],

	rules: {
		root:               $ => optional(choice(
			$.program,
			$.library,
			$.unit,
			$.package,
			$.codeFragment // For include files (.inc)
		)),

		// INC Include file support - allows any sequence of valid Pascal constructs
		// Accepts declarations, type definitions, variable definitions, constant definitions
		// For statement-level includes, the statements would typically be inside a procedure body
		// Uses _definition (which has ppRecursive) to support IFDEFs wrapping multiple sections.
		codeFragment:    $ => $._definitions,

		// Automatic Semicolon Insertion (ASI)
		// Accepts either a real semicolon or an automatically inserted one (zero-width token).
		// Used in declaration rules to enable error recovery for missing semicolons.
		// The literal ';' is listed first to ensure it's preferred when present.
		_semicolon: $ => choice(';', $.automatic_semicolon),

		// HIGH LEVEL ----------------------------------------------------------

		program:            $ => seq(
			$.kProgram, $.moduleName, ';',
			optional($._definitions),
			tr($,'block'),
			$.kEndDot
		),

		library:            $ => seq(
			$.kLibrary, $.moduleName, ';',
			optional($._definitions),
			choice(tr($,'block'), $.kEnd),
			$.kEndDot
		),

		unit:               $ => seq(
			$.kUnit, $.moduleName, ';',
			repeat(choice(
				$.interface,
				$.implementation,
				$.initialization,
				$.finalization,
			)),
			$.kEnd, $.kEndDot
		),

		// DPK Package file support
		// E.g.: package MyPackage; requires rtl; contains Unit1 in 'Unit1.pas'; end.
		package:         $ => seq(
			$.kPackage, $.moduleName, ';',
			repeat($.pp),  // Package directives like {$R *.res}
			optional($.declRequires),
			optional($.declContains),
			$.kEnd, $.kEndDot
		),
		declRequires:    $ => seq($.kRequires, delimited1($.moduleName), ';'),
		declContains:    $ => seq($.kContains, delimited1($.unitReference), ';'),

		interface:       $ => seq($.kInterface, optional($._declarations)),
		implementation:  $ => seq($.kImplementation, optional($._definitions)),
		initialization:  $ => seq($.kInitialization, optional(tr($,'_statements'))),
		finalization:    $ => seq($.kFinalization, optional(tr($,'_statements'))),

		moduleName:      $ => delimited1($.identifier, $.kDot),

		// Unit reference with optional 'in' clause for DPR/DPK files
		// E.g.: Unit1, System.SysUtils in 'path\SysUtils.pas'
		// Note: IFDEFs in uses clauses span across commas, so we cannot use
		// ppRecursive here. Individual {$IFDEF} and {$ENDIF} directives are
		// captured via $.pp in extras. The directives appear as siblings to
		// unitReference nodes, not wrapped around them.
		unitReference:  $ => seq(
			field('name', $.moduleName),
			...enable_if(dpr_file || dpk_file,
				field('path', optional(seq($.kIn, $.literalString)))
			)
		),

		// STATEMENTS ---------------------------------------------------------

		...statements(false),
		...statements(true),

		// Assignment with required RHS. The RHS is required because making it optional
		// would cause ASI (Automatic Semicolon Insertion) to incorrectly break
		// assignments with lambda expressions on the next line:
		//   a :=
		//     procedure begin end;  // This is a lambda, not a new procedure!
		// Tree-sitter's built-in error recovery will handle incomplete assignments
		// like "myVar := " during typing.
		assignment:      $ => prec.left(1, seq(
			field('lhs', choice($._expr, $.varAssignDef)),
			field('operator', choice(
				$.kAssign,
				...enable_if(fpc,
					$.kAssignAdd, $.kAssignSub, $.kAssignMul, $.kAssignDiv
				)
			)),
			field('rhs', $._expr)
		)),
		varAssignDef:          $ => seq($.kVar, $.identifier,
			optional(seq(
				':',
				field('type', $.typeref)
			))),
		varDef:          $ => seq($.kVar, delimited1($._ident), ':', field('type', $.typeref)),
		constDef:        $ => seq($.kConst, $.identifier,
			optional(seq(':', field('type', $.type))),
			'=', $._expr),
		label:           $ => seq($.identifier, ':'),
		caseLabel:       $ => seq(delimited1(choice($._expr, $.range)), ':'),

		_statements:     $ => repeat1(choice($.varDef, $.constDef, $._statement,  $.label)),
		_statementsTr:   $ => seq(
			repeat(choice($._statement, $.label)),
			choice(tr($,'_statement'), $._statement, $.label)
		),

		statements:      $ => $._statements,
		statementsTr:    $ => $._statementsTr,

		asmBody: $ => repeat1(choice(
			$.identifier,              // Identifiers (registers, instructions, labels)
			/'[^']*'/,                 // Single-quoted literals ('a', 'test')
			/"[^"]*"/,                 // Double-quoted literals ("'", "text")
			/\$[0-9a-fA-F]+/,          // Hex numbers with $ prefix ($0000FFFF)
			/[0-9]+/,                  // Decimal numbers (123)
			/[.,:;+\-*\[\]<>&%@()]/    // Punctuation including parentheses
		)),

		// EXPRESSIONS ---------------------------------------------------------

		_expr:           $ => choice(
			$._ref, $.exprBinary, $.exprUnary
		),

		_ref:            $ => choice(
			...enable_if(templates && fpc,
				// TODO: Ideally, the kSpecialize should be part of exprTpl,
				// but for some reason this leads to a rule conflict, so for
				// now we just put it here.
				//
				// Also, we have to write the rule in this weird weird way,
				// because if we just do
				//
				//   seq(optional($.kSpecialize), $.identifier)
				//
				// then we can't have a standalone identifier named
				// "specialize". (Bug in tree-sitter?)
				prec.left(choice(
					seq($.kSpecialize, $.identifier),
					seq(alias($.kSpecialize, $.identifier)),
				))
			),
			$.identifier,
			$._literal,  $.inherited, $.exprDot,
			$.exprBrackets, $.exprParens, $.exprSubscript, $.exprCall,
			alias($.exprDeref, $.exprUnary),
			alias($.exprAs, $.exprBinary),
			...enable_if(templates, $.exprTpl),
			...enable_if(lambda, $.lambda)
		),

		lambda:          $ => seq(
			choice($.kProcedure, $.kFunction),
			field('args', optional($.declArgs)),
			optional(seq(
				':',
				field('type', $.typeref),
			)),
			field('local', optional($._definitions)),
			field('body', choice(tr($, 'block'), tr($, 'asm'))),
		),

		inherited:       $ => prec.right(seq($.kInherited, optional($.identifier))),

		// Member access expression with optional RHS for error recovery.
		// When typing "obj." for IntelliSense, the RHS is missing - we allow this
		// to prevent cascading errors. The LSP detects missing RHS and reports it.
		// RHS uses _exprDotRhs to allow context-sensitive keywords as method/property names.
		// _dot_marker is an optional zero-width token that prevents ASI after dots,
		// allowing method chaining to span multiple lines.
		exprDot:         $ => prec.left(5, seq(
			field('lhs', $._ref),
			field('operator', $.kDot),
			optional($._dot_marker),
			field('rhs', optional($._exprDotRhs))
		)),

		// RHS of dot expression - identifiers plus context-sensitive keywords.
		// This enables obj.Register(), obj.Read(), obj.Write(), etc.
		// Note: Only includes identifier-like tokens. Call/subscript operations are
		// handled by _ref wrapping the complete exprDot.
		_exprDotRhs:     $ => choice(
			$.identifier,
			// Context-sensitive keywords allowed as member names
			$.kRegister, $.kRead, $.kWrite, $.kDefault, $.kMessage,
			// Boolean keywords for qualified enum access (e.g., TUseBoolStrs.False)
			$.kTrue, $.kFalse,
			// Hint directive keywords that can appear in unit/namespace names
			$.kPlatform, $.kExperimental,
			...enable_if(fpc, $.kWinapi),
			// Allow chaining (a.b.c) and template specialization (a.b<T>)
			$.exprDot,
			...enable_if(templates, $.exprTpl),
		),
		exprDeref:       $ => op.postfix(4, $._expr, $.kHat),

		exprAs:          $ => op.infix(3, $._expr, $.kAs,  $._expr),

		// Template arguments in *expression* context (Delphi generics).
		//
		// We intentionally do NOT allow arbitrary expressions as template arguments,
		// because that makes comparisons like `A < 0` ambiguous and leads to spurious
		// "missing >" errors.
		//
		// However, Delphi generic specializations can include nested specializations
		// in expression context (e.g. `e<f,g>`), so we need a recursive, type-ish
		// argument rule.
		exprTplArg:      $ => choice(
			$._typeref,
			// Allow nested generic specialization inside template args: Foo<Bar<Baz>>
			...enable_if(templates, $.typerefTpl),
		),

		// Unfortunately, we can't use $.exprArgs for $.exprTpl because the
		// parser cannot handle it.
		//
		// There are two conflicting rules:
		//
		//   0. Binary comparison: a < b
		//   1. Template use:      a < b >
		//                         ^^^^^
		//                         prefix
		//
		// In order for this to work, the prefix must produce the same nodes in
		// both cases. This is not the case when we introduce a wrapper node.
		//
		// Example:
		//
		//   exprBinary
		//     identifier
		//     <
		//     identifier
		//
		//   vs.
		//
		//   exprTpl
		//     exprArgs <-- extra node
		//       identifier
		//       <
		//       identifier
		//       >
		//
		// Basically the way this works is that there is a tentative node like
		// "exprTplOrBinary", which looks like this:
		//
		//   exprTplOrBinary
		//     identifier
		//     <
		//     identifier
		//
		// At this point we don't yet know what we are dealing with.  The next
		// token will determine whether we are dealing with a comparison or a
		// template. Then the existing node is simply "renamed". Because of
		// this, we can't have an extra node in only one of the branches.
		//
		// Generic specialization in expression context.
		//
		// IMPORTANT: We must avoid mis-parsing comparisons like:
		//   IfThen(AData < 0, 0, AData)
		// as a template instantiation `AData<0,0,AData>` (which then causes
		// a spurious "missing >" error).
		//
		// Therefore we restrict template arguments to *type-ish* references rather
		// than arbitrary expressions.
		exprTpl:         $ => op.args(5, $._ref, $.kLt, delimited1($.exprTplArg, ',', 5),  $.kGt),
		exprSubscript:   $ => op.args(5, $._ref, '[',   $.exprArgs,  ']'  ),
		exprCall:        $ => op.args(5, $._ref, '(',   optional($.exprArgs), ')'  ),

		// Pascal legacy string formatting for WriteLn(foo:4:3) etc.
		legacyFormat:    $ => repeat1(seq(':', $._expr)),

		exprArgs:        $ => delimited1(seq($._expr, optional($.legacyFormat))),

		exprBinary:      $ => choice(
			op.infix(1, $._expr, $.kLt,  $._expr),
			op.infix(1, $._ref,  $.kLt,  $._expr),
			op.infix(1, $._expr, $.kEq,  $._expr),
			op.infix(1, $._expr, $.kNeq, $._expr),
			op.infix(1, $._expr, $.kGt,  $._expr),
			op.infix(1, $._expr, $.kLte, $._expr),
			op.infix(1, $._expr, $.kGte, $._expr),
			op.infix(1, $._expr, $.kIn,  $._expr),
			op.infix(1, $._expr, $.kIs,  $._expr),

			op.infix(2, $._expr, $.kAdd, $._expr),
			op.infix(2, $._expr, $.kSub, $._expr),
			op.infix(2, $._expr, $.kOr,  $._expr),
			op.infix(2, $._expr, $.kXor, $._expr),

			op.infix(3, $._expr, $.kMul, $._expr),
			op.infix(3, $._expr, $.kFdiv,$._expr),
			op.infix(3, $._expr, $.kDiv, $._expr),
			op.infix(3, $._expr, $.kMod, $._expr),
			op.infix(3, $._expr, $.kAnd, $._expr),
			op.infix(3, $._expr, $.kShl, $._expr),
			op.infix(3, $._expr, $.kShr, $._expr),
		),

		exprUnary:       $ => choice(
			op.prefix(4,  $.kNot,  $._expr),
			op.prefix(4,  $.kAdd,  $._expr),
			op.prefix(4,  $.kSub,  $._expr),
			op.prefix(4,  $.kAt,   $._expr),
		),

		exprParens:      $ => prec.left(5,seq('(', $._expr, ')')),

		// Set or array literal
		exprBrackets:       $ => seq(
			'[', delimited(choice($._expr, $.range)), ']'
		),

		// TYPES ---------------------------------------------------------------

		type:            $ => ppRecursive($, 'type',
			$.typeref,
			$.declMetaClass,
			$.declEnum,
			$.declSet,
			$.declArray,
			$.declFile,
			$.declString,
			$.declProcRef,
			$.range,  // Subrange type: 0..255, 'A'..'Z', TEnum.Val1..TEnum.Val2
		),

		typeref:         $ => seq(
			...enable_if(fpc, field('_dummy', optional($.kSpecialize))),
			$._typeref,
			// Note: deprecated/platform/experimental hints are now handled at the
			// declaration level (declVar, declConst, declField, declProp) via hintDirective,
			// not in typeref, to avoid ambiguity.
		),

		_typeref:        $ => choice(
			$.identifier, $.typerefDot,
			...enable_if(templates, $.typerefTpl),
			$.typerefPtr,
			prec(1, $.kString),  // Allow 'string' keyword as a type reference (higher precedence than declString)
		),

		typerefDot:      $ => op.infix(1,$._typeref, $.kDot, $._typeref),
		typerefTpl:      $ => op.args(1, $._typeref, $.kLt, $.typerefArgs, $.kGt),
		typerefPtr:      $ => op.prefix(1,$.kHat, $._typeref),
		typerefArgs:     $ => delimited1($._typeref),

		// GENERIC TYPE DECLARATION --------------------------------------------
		//
		// E.g. Foo<A: B, C: D<E>>.XYZ<T>
		//           ^     ^
		//     Note the optional constraints, which makes this different from a
		//     specialization
		//
		// We treat regular names as a special case of generic names. I.e. if
		// you see $._genericName somewhere, it doesn't mean that the name HAS
		// to be generic, it could just be a regular name like "TFoobar" or
		// "MyUnit.Foo".

		genericDot:      $ => op.infix(1,$._genericName, $.kDot, $._genericName),
		genericTpl:      $ => op.args(2,$._genericName, $.kLt, $.genericArgs, $.kGt),

		_genericName:    $ => choice(
			$.identifier, $.genericDot, ...enable_if(templates, $.genericTpl)
		),
		genericArgs:     $ => delimited1($.genericArg, ';'),
		genericArg:      $ => seq(
			field('name', delimited1($.identifier)),
			field('type', optional(seq(':', $.typeref))),
			field('defaultValue', optional($.defaultValue))
		),

		// LITERALS -----------------------------------------------------------

		_literal:        $ => choice(
			$.literalString,
			$.literalNumber,
			$.kNil, $.kTrue, $.kFalse
		),
		literalString:   $ => repeat1($._literalString),
		_literalString:  $ => choice(/'[^']*'/, $.literalChar),
		literalChar:     $ => seq('#', $._literalInt),
		literalNumber:   $ => choice($._literalInt, $._literalFloat),
		_literalInt:     $ => choice(
			token.immediate(/[-+]?[0-9]+/),
			token.immediate(/\$[a-fA-F0-9]+/)
		),
		_literalFloat:   $ => prec(10, /[-+]?[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/),

		range:           $ => seq(
			$._expr, '..', $._expr
		),

		// DEFINITIONS --------------------------------------------------------

		_definitions:    $ => repeat1($._definition),
		// Definition in implementation section.
		// Uses ppRecursive to support IFDEFs wrapping multiple definitions (e.g., type + var together).
		_definition:     $ => ppRecursive($, '_definition',
			$.declTypes, $.declVars, $.declConsts, $.defProc,
			alias($.declProcFwd, $.declProc),
			$.declLabels, $.declUses, $.declExports,
			$.declTypesSplit,  // Handle type keyword inside conditional branch

			// Not actually valid syntax, but helps the parser recover:
			prec(-1,$.blockTr)
		),

		// Local definitions rule for procedure bodies.
		// Uses the same definitions as unit-level, which now includes ppRecursive
		// support for IFDEF blocks.
		_defProc_local:  $ => prec.left($._definitions),

		// Recursive body rule for nested IFDEF support in procedure bodies
		_defProc_body:   $ => ppRecursive($, '_defProc_body',
			seq(
				field('local', optional($._defProc_local)),
				field('body', choice(tr($, 'block'), tr($, 'asm'))),
				$._semicolon
			)
		),

		// Procedure body where `begin` keyword is inside a conditional IFNDEF/ELSE branch
		// Handles: {$IFNDEF} var...; begin {$ELSE} begin {$ENDIF} ... end;
		// This is needed for "transformed" files where one branch is blanked out
		_defProc_bodySplit: $ => seq(
			alias(/\{\$(?:ifdef|ifndef|ifopt|if\s)[^}]*\}/i, $.pp),
			// IFNDEF branch: may have local vars and 'begin'
			optional($._defProc_local),
			optional($.kBegin),
			alias(/\{\$else[^}]*\}/i, $.pp),
			// ELSE branch: may be blanked (originally had 'begin')
			optional($.kBegin),
			alias(/\{\$(?:end|ifend)[^}]*\}/i, $.pp),
			// Statements continue after ENDIF
			optional(tr($,'_statements')),
			$.kEnd,
			$._semicolon
		),

		defProc:         $ => seq(
			field('header', $.declProc),
			choice($._defProc_body, $._defProc_bodySplit)
		),

		declProcFwd:     $ => seq(
			$._declProc,
			choice(seq($.kForward, ';'), $.procExternal),
			repeat($._procAttribute)
		),

		// DECLARATIONS -------------------------------------------------------

		_visibility:     $ => choice(
			$.kPublished, $.kPublic, $.kProtected, $.kPrivate
		),

		// Declaration in interface section.
		// Uses ppRecursive to support IFDEFs wrapping multiple declarations (e.g., type + var together).
		_declaration:    $ => ppRecursive($, '_declaration',
			$.declTypes, $.declVars, $.declConsts, $.declProc, $.declProp,
			alias($.declProcFwd, $.declProc),
			$.declUses, $.declLabels, $.declExports,
			$.declTypesSplit  // Handle type keyword inside conditional branch
		),
		_declarations:   $ => repeat1($._declaration),

		// Recursive class declaration rule for nested IFDEF support in class bodies
		_classDeclaration: $ => ppRecursive($, '_classDeclaration',
			$.declTypes, $.declVars, $.declConsts, $.declProc, $.declProp
		),
		_classDeclarations: $ => repeat1($._classDeclaration),

		defaultValue:    $ => seq($.kEq, $._initializer),

		// Declaration sections

		declUses:        $ => seq($.kUses, delimited($.unitReference), ';'),
		declExports:     $ => seq($.kExports, delimited($.declExport), ';'),

		// Note: IFDEFs in type/var/const sections span multiple declarations.
		// We explicitly allow $.pp as an alternative in the repeat to ensure
		// IFDEFs can appear between declaration items within unit structures
		// where extras alone don't work correctly.

		// Recursive rule for type declarations with nested IFDEF support
		// Handles: type T1 = ...; {$IFDEF X} T2 = ...; {$ENDIF}
		_declTypeItem:   $ => ppRecursive($, '_declTypeItem', $.declType),

		declTypes:       $ => seq(
			$.kType,
			repeat($._declTypeItem)
		),

		// Type section where `type` keyword is inside a conditional ELSE branch
		// Handles: {$IF} [empty] {$ELSE} type T1; {$ENDIF} T2;
		// This is needed for "transformed" files where the IF branch is blanked out
		declTypesSplit: $ => seq(
			alias(/\{\$(?:ifdef|ifndef|ifopt|if\s)[^}]*\}/i, $.pp),
			// IF branch is empty (whitespace only) - no content
			alias(/\{\$else[^}]*\}/i, $.pp),
			// ELSE branch contains type keyword and declarations
			$.kType,
			repeat($.declType),
			alias(/\{\$(?:end|ifend)[^}]*\}/i, $.pp),
			// Continuation after endif - type items WITHOUT type keyword
			repeat1($.declType)
		),

		// Recursive rule for variable declarations with nested IFDEF support
		// Handles: var x: int; {$IFDEF X} y: int; {$ENDIF}
		_declVarItem:    $ => ppRecursive($, '_declVarItem', $.declVar),

		declVars:        $ => seq(
			optional($.kClass),
			choice($.kVar, $.kThreadvar),
			repeat($._declVarItem)
		),

		// Recursive rule for constant declarations with nested IFDEF support
		// Handles: const x = 1; {$IFDEF X} y = 2; {$ENDIF}
		_declConstItem:  $ => ppRecursive($, '_declConstItem', $.declConst),

		declConsts:      $ => seq(
			optional($.kClass),
			choice($.kConst, $.kResourcestring),
			repeat($._declConstItem),
		),

		// Declarations

		declType:        $ => seq(
			...enable_if(rtti, optional($.rttiAttributes)),
			...enable_if(fpc, optional($.kGeneric)),
			field('name', $._genericName), $.kEq,
			field('type',
				choice(
					seq(optional($.kType), $.type),
					choice($.type),
					$.declClass,
					$.declIntf,
					$.declHelper,
				)
			),
			optional($.hintDirective),
			$._semicolon,
			repeat($._procAttribute)
		),

		declProc:        $ => seq(
			...enable_if(rtti, optional($.rttiAttributes)),
			choice($._declProc, $._declOperator),
		),

		declVar:         $ => seq(
			...enable_if(rtti, optional($.rttiAttributes)),
			field('name', delimited1($._ident)),
			':',
			field('type', $.type),
			optional(choice(
				seq($.kAbsolute, $._ref),
				field('defaultValue', $.defaultValue)
			)),
			optional($.hintDirective),
			$._semicolon,
			repeat(choice($._procAttribute, $.procExternal))
		),

		declConst:       $ => seq(
			...enable_if(rtti, optional($.rttiAttributes)),
			field('name', $._ident),
			optional(seq(':', field('type', $.type))),
			field('defaultValue', $.defaultValue),
			optional($.hintDirective),
			$._semicolon,
			repeat($._procAttribute)
		),

		declLabels:      $ => seq($.kLabel, delimited1($.declLabel), ';'),
		declLabel:       $ => field('name', $.identifier),

		declExport:      $ => seq($._genericName, repeat(seq(choice($.kName, $.kIndex), $._expr))),

		// Type declarations

		declEnum:        $ => seq('(', delimited1($.declEnumValue), ')'),
		declEnumValue:   $ => seq(field('name', $._ident), field('value', optional($.defaultValue))),
		declSet:         $ => seq($.kSet, $.kOf, $.type),
		declArray:       $ => seq(
			optional($.kPacked),
			$.kArray,
			optional(seq('[', delimited(choice($.range, $._expr)), ']')),
			$.kOf, $.type
		),
		declFile:        $ => seq($.kFile, optional(seq($.kOf, $.type))),
		declString:      $ => prec.left(seq(
			$.kString,
			optional(seq('[', choice($._expr), ']'))
		)),

		declProcRef:     $ => prec.right(1,seq(
			optional(seq($.kReference, $.kTo)),
			choice($.kProcedure, $.kFunction),
			field('args', optional($.declArgs)),
			optional(seq(
				':',
				field('type', $.typeref),
			)),
			optional(seq($.kOf, $.kObject)),
			// Calling convention for anonymous procedure/function types
			optional(field('convention', $.callingConvention))
		)),

		// Calling conventions for procedure/function types
		callingConvention: $ => choice(
			$.kCdecl, $.kStdcall, $.kPascal, $.kRegister, $.kSafecall
		),

		declMetaClass:   $ => seq($.kClass, $.kOf, $.typeref),

		declClass:       $ => seq(
			optional($.kPacked),
			choice(
				$.kClass, $.kRecord, $.kObject,
				...enable_if(objc,
					$.kObjcclass, $.kObjccategory, $.kObjcprotocol
				)
			),
			optional(choice(
				$.kAbstract, $.kSealed,
				...enable_if(objc,
					seq($.kExternal, optional(seq($.kName, $._expr)))
				)
			)),
			field('parent', optional(seq('(',delimited($.typeref),')'))),
			optional($._declClass)
		),

		declIntf:        $ => seq(
			optional($.kPacked),
			choice(
				$.kInterface,
				...enable_if(delphi, $.kDispInterface)
			),
			field('parent', optional(seq('(',delimited($.typeref),')'))),
			field('guid', optional($.guid)),
			optional($._declClass)
		),

		declHelper:      $ => seq(
			choice($.kClass, $.kRecord, $.kType), $.kHelper,
			field('parent', optional(seq('(',delimited($.typeref),')'))),
			$.kFor, $.typeref,
			$._declClass
		),

		// Stuff for class/record/interface declarations

		guid:            $ => prec(1,seq('[', $._ref, ']')),

		_declClass:      $ => seq(
			$._class_body_start, // Zero-width sentinel to disambiguate class bodies from forward declarations
			repeat(choice($._declSectionItem, $._classDeclaration, $._declField)),
			optional($.declVariant),
			$.kEnd,
			optional(seq($.kAlign, $.literalNumber))
		),

		declSection:     $ => seq(
			optional($.kStrict),
			choice($._visibility, ...enable_if(objc, $.kRequired, $.kOptional)),
			optional($._sectionMembers)
		),

		// Wrapper for declSection to support IFDEF blocks containing visibility sections
		_declSectionItem: $ => ppRecursive($, '_declSectionItem', $.declSection),

		// Unified section member rule for nested IFDEF support in class bodies.
		// This handles both fields and methods together, allowing them to be
		// intermixed and wrapped in preprocessor blocks.
		_sectionMember:  $ => ppRecursive($, '_sectionMember',
			$.declField,
			$.declTypes, $.declVars, $.declConsts, $.declProc, $.declProp
		),
		_sectionMembers: $ => repeat1($._sectionMember),

		// Keep _declFields for backward compatibility with _declClass structure
		_declField:      $ => ppRecursive($, '_declField', $.declField),
		_declFields:     $ => repeat1($._declField),

		declField:       $ =>  choice(
			// Standard field with optional RTTI attributes
			seq(
				...enable_if(rtti, optional($.rttiAttributes)),
				field('name', delimited1($._ident)),
				':',
				field('type', $.type),
				field('defaultValue', optional($.defaultValue)),
				optional($.hintDirective),
				$._semicolon
			),
			// Field with RTTI attribute wrapped in preprocessor block
			// Handles: {$IFDEF X} [Attr] {$ENDIF} fieldName: Type;
			...enable_if(rtti, seq(
				alias(/\{\$(?:ifdef|ifndef|ifopt|if\s)[^}]*\}/i, $.pp),
				$.rttiAttributes,
				alias(/\{\$(?:end|ifend)[^}]*\}/i, $.pp),
				field('name', delimited1($._ident)),
				':',
				field('type', $.type),
				field('defaultValue', optional($.defaultValue)),
				optional($.hintDirective),
				$._semicolon
			))
		),

		// Property declaration - supports both full declarations and redeclarations.
		// Full: property Foo: Integer read FFoo write FFoo;
		// Redeclaration (visibility promotion): property Foo;
		declProp:        $ => seq(
			...enable_if(rtti, optional($.rttiAttributes)),
			optional($.kClass),
			$.kProperty,
			field('name', $.identifier),
			field('args', optional($.declPropArgs)),
			optional(seq(
				':',
				field('type', $.type),
				repeat(choice(
					seq($.kIndex, field('index', $._expr)),
					...enable_if(delphi, seq($.kDispId, field('dispid', $._expr))),
					seq($.kRead, field('getter', $._ref)),
					seq($.kWrite, field('setter', $._ref)),
					seq($.kImplements, field('implements', delimited($._expr))),
					seq($.kDefault, field('defaultValue', $._expr)),
					seq($.kStored, field('stored', $._expr)),
					$.kNodefault,
				)),
			)),
			// Allow default/nodefault/stored for property redeclarations (no type required)
			optional(choice(
				seq($.kDefault, field('defaultValue', $._expr)),
				seq($.kStored, field('stored', $._expr)),
				$.kNodefault,
			)),
			optional($.hintDirective),
			$._semicolon,
			repeat($._procAttribute)
		),

		declPropArgs:    $ => seq('[', delimited($.declArg, ';'), ']'),

		// Variant records

		declVariant:     $ => prec.right(seq(
			$.kCase,
			field('name', optional(seq($.identifier, ':'))),
			field('type', $.typeref), $.kOf,
			delimited1($.declVariantClause, ';'),
			optional(';'),
		)),

		declVariantClause: $ => seq(
			$.caseLabel,
			'(',
			choice(
				seq(delimited(alias($.declVariantField, $.declField), ';'), optional(seq(';', $.declVariant))),
				seq($.declVariant),
			),
			optional(';'),
			')',
		),

		declVariantField: $ => seq(
			field('name', delimited1($.identifier)),
			':',
			field('type', $.type),
			field('defaultValue', optional($.defaultValue))
		),

		// Stuff for procedure / function / operator declarations

		_declProc:       $ => seq(
			...enable_if(fpc, optional($.kGeneric)),
			optional($.kClass),
			choice($.kProcedure, $.kFunction, $.kConstructor, $.kDestructor),
			field('name', $._genericName),
			field('args', optional($.declArgs)),
			optional(seq(
				':',
				field('type', $.typeref),
			)),
			field('assign', optional($.defaultValue)),
			optional(field('convention', $.callingConvention)),
			optional($.hintDirective),
			$._semicolon,
			repeat($._procAttributeNoExt)
		),

		_declOperator:   $ => seq(
			optional($.kClass),
			$.kOperator,
			field('name', $._operatorName),
			field('args', optional($.declArgs)),
			...enable_if(fpc, field('resultName', optional($.identifier))),
			// Return type is optional for managed record operators (Initialize, Finalize, Assign)
			optional(seq(
				':',
				field('type', $.type),
			)),
			field('assign', optional($.defaultValue)),
			optional(field('convention', $.callingConvention)),
			optional($.hintDirective),
			$._semicolon,
			repeat($._procAttributeNoExt)
		),

		operatorDot:     $ => op.infix(0, $._genericName, $.kDot, $.operatorName),
		_operatorName:   $ => seq(
			choice(
				$._genericName,
				// FPC and Delphi both support operator names and TypeName.OperatorName syntax
				...enable_if(fpc || delphi,
					$.operatorName,
					alias($.operatorDot, $.genericDot)
				)
			)
		),
		operatorName:    $ => choice(
			// FPC symbol operators
			$.kDot, $.kLt, $.kEq, $.kNeq, $.kGt, $.kLte, $.kGte,
			$.kAdd, $.kSub, $.kMul, $.kFdiv, $.kDiv, $.kMod,
			$.kAssign,
			$.kOr, $.kXor, $.kAnd, $.kShl, $.kShr, $.kNot,
			$.kIn,
			// Delphi named operators (for operator overloading)
			...enable_if(delphi,
				// Conversion operators
				$.kOpImplicit, $.kOpExplicit,
				// Unary operators
				$.kOpNegative, $.kOpPositive, $.kOpInc, $.kOpDec,
				$.kOpLogicalNot, $.kOpTrunc, $.kOpRound,
				// Comparison operators
				$.kOpEqual, $.kOpNotEqual, $.kOpGreaterThan, $.kOpGreaterThanOrEqual,
				$.kOpLessThan, $.kOpLessThanOrEqual,
				// Binary operators
				$.kOpAdd, $.kOpSubtract, $.kOpMultiply, $.kOpDivide, $.kOpIntDivide,
				$.kOpModulus, $.kOpLeftShift, $.kOpRightShift,
				$.kOpLogicalAnd, $.kOpLogicalOr, $.kOpLogicalXor,
				$.kOpBitwiseAnd, $.kOpBitwiseOr, $.kOpBitwiseXor,
				// Managed record lifecycle operators (Delphi 10.4+)
				$.kOpInitialize, $.kOpFinalize, $.kOpAssign
				// Note: kIn already included in FPC symbol operators above, works for Delphi too
			),
		),

		declArgs:        $ => seq('(', delimited($.declArg, ';'), ')'),

		declArg:         $ => choice(
			seq(
				choice($.kVar, $.kConst, $.kOut, $.kConstref),
				// RTTI attributes like [ref] can appear between modifier and name
				...enable_if(rtti, optional($.rttiAttributes)),
				field('name', delimited1($.identifier)),
				optional(seq(
					':', field('type', $.type),
					field('defaultValue', optional($.defaultValue))
				))
			),
			seq(
				field('name', delimited1($.identifier)), ':',
				field('type', $.type),
				field('defaultValue', optional($.defaultValue))
			)
		),

		// Hint directives for deprecated/platform/experimental that appear inline (before semicolon)
		// Used for constants, variables, fields, properties
		// Supports chained directives like: platform deprecated, deprecated 'message' platform
		hintDirective:   $ => repeat1(choice(
			$.kPlatform,
			$.kExperimental,
			seq($.kDeprecated, optional($._expr)),  // deprecated or deprecated 'message'
		)),

		// Attributes & declaration hints

		_procAttribute:  $ => /*pp($,*/choice(
			seq(field('attribute', $.procAttribute), ';'),
			// FPC-specific syntax, e.g. procedure myproc; [public; alias:'bla'; cdecl];
			...enable_if(fpc, seq(
				'[',
				delimited(field('attribute', choice($.procAttribute, $.procExternal))),
				']', ';'
			))
		)/*)*/,
		// Procedure attributes with IFDEF support for cases like:
		// constructor CreateRes(...); {$IFNDEF NEXTGEN} overload; {$ENDIF}
		// Delphi allows chaining attributes without semicolons: stdcall deprecated 'msg';
		_procAttributeNoExt: $ => ppRecursive($, '_procAttributeNoExt',
			seq(repeat1(field('attribute', $.procAttribute)), ';'),
			// FPC-specific syntax, e.g. procedure myproc; [public; alias:'bla'; cdecl];
			...enable_if(fpc, seq('[', delimited(field('attribute', choice($.procAttribute)), ';'), ']', ';'))
		),

		procAttribute:   $ => choice(
			$.kStatic, $.kVirtual, $.kDynamic, $.kAbstract, $.kOverride, $.kFinal,
			$.kOverload, $.kReintroduce, $.kInline, $.kStdcall,
			$.kCdecl, $.kPascal, $.kRegister, $.kSafecall, $.kAssembler,
			$.kNoreturn, $.kLocal,  $.kFar, $.kNear,
			$.kDefault, $.kNodefault, $.kDeprecated, $.kExperimental, $.kPlatform,

			seq(
				choice(
					seq($.kMessage, optional($.kName)),
					$.kDeprecated
				),
				$._expr
			),

			...enable_if(fpc,
				$.kPlatform, $.kUnimplemented,
				$.kCppdecl, $.kCvar, $.kMwpascal, $.kNostackframe,
				$.kInterrupt, $.kIocheck, $.kHardfloat,
				$.kSoftfloat, $.kMs_abi_default, $.kMs_abi_cdecl,
				$.kSaveregisters, $.kSysv_abi_default, $.kSysv_abi_cdecl,
				$.kVectorcall, $.kVarargs, $.kWinapi,
				...enable_if(public_name, $.kPublic),
				seq(
					choice(
						$.kExport,
						seq($.kAlias, ':'),
						...enable_if(public_name, seq($.kPublic, $.kName)),
					),
					$._expr
				)
			),

			...enable_if(delphi, field('dispid', seq($.kDispId, $._expr))),
		),

		rttiAttributes:  $ => repeat1(seq(
			// Note: "Identifier:" is for tagging parameters of procedures (Delphi)
			'[', optional(seq($.identifier, ':')), delimited($._ref), ']'
		)),

		procExternal:    $ => seq(
			$.kExternal,
			optional($._expr),
			optional(seq(choice($.kName, $.kIndex), $._expr)),
			...enable_if(delphi, optional($.kDelayed)),
			';'
		),

		// INITIALIZERS --------------------------------------------------------

		_initializer:    $ => prec(2,seq(
			choice($._expr, $.recInitializer, $.arrInitializer)
		)),

		// record initializer
		recInitializer:  $ => seq(
			'(',
			delimited1( $.recInitializerField, ';'),
			')'
		),

		recInitializerField: $ => choice(
			seq(field('name',$.identifier), ':', field('value', $._initializer)),
			field('value', $._initializer)
		),

		// array initializer
		arrInitializer:  $ => prec(1,seq('(', delimited1($._initializer), ')')),

		// TERMINAL SYMBOLS ----------------------------------------------------

		kProgram:          $ => /program/i,
		kLibrary:          $ => /library/i,
		kUnit:             $ => /unit/i,
		kPackage:          $ => /package/i,
		kRequires:         $ => /requires/i,
		kContains:         $ => /contains/i,
		kUses:             $ => /uses/i,
		kInterface:        $ => /interface/i,
		kDispInterface:    $ => /dispinterface/i,
		kImplementation:   $ => /implementation/i,
		kInitialization:   $ => /initialization/i,
		kFinalization:     $ => /finalization/i,
		kEndDot:           $ => '.',

		kBegin:            $ => /begin/i,
		kEnd:              $ => /end/i,
		kAsm:              $ => /asm/i,

		kVar:              $ => /var/i,
		kThreadvar:        $ => /threadvar/i,
		kConst:            $ => /const/i,
		kConstref:         $ => /constref/i,
		kResourcestring:   $ => /resourcestring/i,
		kOut:              $ => /out/i,
		kType:             $ => /type/i,
		kLabel:            $ => /label/i,
		kExports:          $ => /exports/i,

		kAbsolute:         $ => /absolute/i,

		kProperty:         $ => /property/i,
		kRead:             $ => /read/i,
		kWrite:            $ => /write/i,
		kImplements:       $ => /implements/i,
		kDefault:          $ => /default/i,
		kNodefault:        $ => /nodefault/i,
		kStored:           $ => /stored/i,
		kIndex:            $ => /index/i,
		kDispId:           $ => /dispid/i,

		kClass:            $ => /class/i,
		kInterface:        $ => /interface/i,
		kObject:           $ => /object/i,
		kRecord:           $ => /record/i,
		kObjcclass:        $ => /objcclass/i,
		kObjccategory:     $ => /objccategory/i,
		kObjcprotocol:     $ => /objcprotocol/i,
		kArray:            $ => /array/i,
		kFile:             $ => /file/i,
		kString:           $ => /string/i,
		kSet:              $ => /set/i,
		kOf:               $ => /of/i,
		kHelper:           $ => /helper/i,
		kPacked:           $ => /packed/i,
		kAlign:            $ => /align/i,

		kGeneric:          $ => /generic/i,
		kSpecialize:       $ => /specialize/i,

		kDot:              $ => '.',
		kLt:               $ => '<',
		kEq:               $ => '=',
		kNeq:              $ => '<>',
		kGt:               $ => '>',
		kLte:              $ => '<=',
		kGte:              $ => '>=',
		kAdd:              $ => '+',
		kSub:              $ => '-',
		kMul:              $ => '*',
		kFdiv:             $ => '/',
		kAt:               $ => '@',
		kHat:              $ => '^',
		kAssign:           $ => ':=',
		kAssignAdd:        $ => '+=', // Freepascal
		kAssignSub:        $ => '-=', // Freepascal
		kAssignMul:        $ => '*=', // Freepascal
		kAssignDiv:        $ => '/=', // Freepascal
		kOr:               $ => /or/i,
		kXor:              $ => /xor/i,
		kDiv:              $ => /div/i,
		kMod:              $ => /mod/i,
		kAnd:              $ => /and/i,
		kShl:              $ => /shl/i,
		kShr:              $ => /shr/i,
		kNot:              $ => /not/i,
		kIs:               $ => /is/i,
		kAs:               $ => /as/i,
		kIn:               $ => /in/i,

		kFor:              $ => /for/i,
		kTo:               $ => /to/i,
		kDownto:           $ => /downto/i,
		kIf:               $ => /if/i,
		kThen:             $ => /then/i,
		kElse:             $ => /else/i,
		kDo:               $ => /do/i,
		kWhile:            $ => /while/i,
		kRepeat:           $ => /repeat/i,
		kUntil:            $ => /until/i,
		kTry:              $ => /try/i,
		kExcept:           $ => /except/i,
		kFinally:          $ => /finally/i,
		kRaise:            $ => /raise/i,
		kAtAddress:        $ => /at/i,  // 'at' keyword for raise statements: raise E at Address
		kOn:               $ => /on/i,
		kCase:             $ => /case/i,
		kWith:             $ => /with/i,
		kGoto:             $ => /goto/i,

		kFunction:         $ => /function/i,
		kProcedure:        $ => /procedure/i,
		kConstructor:      $ => /constructor/i,
		kDestructor:       $ => /destructor/i,
		kOperator:         $ => /operator/i,
		kReference:        $ => /reference/i,

		kPublished:        $ => /published/i,
		kPublic:           $ => /public/i,
		kProtected:        $ => /protected/i,
		kPrivate:          $ => /private/i,
		kStrict:           $ => /strict/i,
		kRequired:         $ => /required/i,
		kOptional:         $ => /optional/i,

		kForward:          $ => /forward/i,

		kStatic:           $ => /static/i,
		kVirtual:          $ => /virtual/i,
		kAbstract:         $ => /abstract/i,
		kSealed:           $ => /sealed/i,
		kDynamic:          $ => /dynamic/i,
		kOverride:         $ => /override/i,
		kFinal:            $ => /final/i,
		kOverload:         $ => /overload/i,
		kReintroduce:      $ => /reintroduce/i,
		kInherited:        $ => /inherited/i,
		kInline:           $ => /inline/i,

		kStdcall:          $ => /stdcall/i,
		kCdecl:            $ => /cdecl/i,
		kCppdecl:          $ => /cppdecl/i,
		kPascal:           $ => /pascal/i,
		kRegister:         $ => /register/i,
		kMwpascal:         $ => /mwpascal/i,
		kExternal:         $ => /external/i,
		kName:             $ => /name/i,
		kMessage:          $ => /message/i,
		kDeprecated:       $ => /deprecated/i,
		kExperimental:     $ => /experimental/i,
		kPlatform:         $ => /platform/i,
		kUnimplemented:    $ => /unimplemented/i,
		kCvar:             $ => /cvar/i,
		kExport:           $ => /export/i,
		kFar:              $ => /far/i,
		kNear:             $ => /near/i,
		kSafecall:         $ => /safecall/i,
		kAssembler:        $ => /assembler/i,
		kNostackframe:     $ => /nostackframe/i,
		kInterrupt:        $ => /interrupt/i,
		kNoreturn:         $ => /noreturn/i,
		kIocheck:          $ => /iocheck/i,
		kLocal:            $ => /local/i,
		kHardfloat:        $ => /hardfloat/i,
		kSoftfloat:        $ => /softfloat/i,
		kMs_abi_default:   $ => /ms_abi_default/i,
		kMs_abi_cdecl:     $ => /ms_abi_cdecl/i,
		kSaveregisters:    $ => /saveregisters/i,
		kSysv_abi_default: $ => /sysv_abi_default/i,
		kSysv_abi_cdecl:   $ => /sysv_abi_cdecl/i,
		kVectorcall:       $ => /vectorcall/i,
		kVarargs:          $ => /varargs/i,
		kWinapi:           $ => /winapi/i,
		kAlias:            $ => /alias/i,
		// Delphi
		kDelayed:          $ => /delayed/i,

		// Delphi named operators (for operator overloading in records)
		// Conversion operators
		kOpImplicit:       $ => /implicit/i,
		kOpExplicit:       $ => /explicit/i,
		// Unary operators
		kOpNegative:       $ => /negative/i,
		kOpPositive:       $ => /positive/i,
		kOpInc:            $ => /inc/i,
		kOpDec:            $ => /dec/i,
		kOpLogicalNot:     $ => /logicalnot/i,
		kOpTrunc:          $ => /trunc/i,
		kOpRound:          $ => /round/i,
		// Comparison operators
		kOpEqual:          $ => /equal/i,
		kOpNotEqual:       $ => /notequal/i,
		kOpGreaterThan:    $ => /greaterthan/i,
		kOpGreaterThanOrEqual: $ => /greaterthanorequal/i,
		kOpLessThan:       $ => /lessthan/i,
		kOpLessThanOrEqual: $ => /lessthanorequal/i,
		// Binary operators
		kOpAdd:            $ => /add/i,
		kOpSubtract:       $ => /subtract/i,
		kOpMultiply:       $ => /multiply/i,
		kOpDivide:         $ => /divide/i,
		kOpIntDivide:      $ => /intdivide/i,
		kOpModulus:        $ => /modulus/i,
		kOpLeftShift:      $ => /leftshift/i,
		kOpRightShift:     $ => /rightshift/i,
		kOpLogicalAnd:     $ => /logicaland/i,
		kOpLogicalOr:      $ => /logicalor/i,
		kOpLogicalXor:     $ => /logicalxor/i,
		kOpBitwiseAnd:     $ => /bitwiseand/i,
		kOpBitwiseOr:      $ => /bitwiseor/i,
		kOpBitwiseXor:     $ => /bitwisexor/i,
		// Managed record lifecycle operators (Delphi 10.4+)
		kOpInitialize:     $ => /initialize/i,
		kOpFinalize:       $ => /finalize/i,
		kOpAssign:         $ => /assign/i,
		// Note: Delphi's In operator uses the existing kIn keyword, no separate kOpIn needed

		kNil:              $ => /nil/i,
		kTrue:             $ => /true/i,
		kFalse:            $ => /false/i,

		kIfdef:            $ => /ifdef/i,
		kIfndef:           $ => /ifndef/i,
		kEndif:            $ => /(?:endif|ifend)/i,

		// Identifier rule - supports optional & prefix for escaping keywords
		// e.g., &end, &begin, &type are valid identifiers
		identifier:        $ => /[&]?[a-zA-Z_\u00C0-\u024F][0-9_a-zA-Z\u00C0-\u024F]*/,

		// Extended identifier that also allows directive keywords to be used as identifiers
		// In Delphi/Pascal, directives like 'default' are context-sensitive keywords,
		// not reserved words. They can be used as variable/field/const names.
		_ident:            $ => choice($.identifier, $.kDefault, $.kMessage, $.kTrue, $.kFalse),

	  	_space:            $ => /[\s\r\n\t]+/,
		pp:                $ => /\{\$[^}]*\}/,
		comment:           $ => token(choice(
			seq('//', /.*/),
			seq('{', /([^$}][^}]*)?/, '}'),
			/[(][*]([^*]*[*]+[^)*])*[^*]*[*]+[)]/
		)),
	}
});
