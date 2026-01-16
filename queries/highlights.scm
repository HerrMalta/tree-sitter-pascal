; -- Keywords
[
	(kProgram)
	(kLibrary)
	(kUnit)
	(kUses)

	(kBegin)
	(kEnd)
	(kAsm)

	(kVar)
	(kThreadvar)
	(kConst)
	(kResourcestring)
	(kConstref)
	(kOut)
	(kType)
	(kLabel)
	(kExports)

	(kAbsolute)

	(kProperty)
	(kRead)
	(kWrite)
	(kImplements)
	(kDefault)
	(kNodefault)
	(kStored)
	(kIndex)
	(kDispId)

	(kClass)
	(kInterface)
	(kDispInterface)
	(kObject)
	(kRecord)
	; ObjC keywords (only available when objc=true in grammar.js)
	; (kObjcclass)
	; (kObjccategory)
	; (kObjcprotocol)
	(kArray)
	(kFile)
	(kString)
	(kSet)
	(kOf)
	(kHelper)
	(kPacked)

	; FPC generic keywords (only available when fpc=true in grammar.js)
	; (kGeneric)
	; (kSpecialize)

	(kFunction)
	(kProcedure)
	(kConstructor)
	(kDestructor)
	(kOperator)
	(kReference)

	(kInterface)
	(kImplementation)
	(kInitialization)
	(kFinalization)

	(kPublished)
	(kPublic)
	(kProtected)
	(kPrivate)
	(kStrict)
	; ObjC protocol modifiers (only available when objc=true in grammar.js)
	; (kRequired)
	; (kOptional)

	(kForward)

	(kStatic)
	(kVirtual)
	(kAbstract)
	(kSealed)
	(kDynamic)
	(kOverride)
	(kOverload)
	(kReintroduce)
	(kInherited)
	(kInline)

	(kStdcall)
	(kCdecl)
	; (kCppdecl)  ; FPC only
	(kPascal)
	(kRegister)
	; (kMwpascal)  ; FPC only
	(kExternal)
	(kName)
	(kMessage)
	(kDeprecated)
	(kExperimental)
	(kPlatform)
	; (kUnimplemented)  ; FPC only
	; (kCvar)  ; FPC only
	; (kExport)  ; FPC only
	(kFar)
	(kNear)
	(kSafecall)
	(kAssembler)
	; (kNostackframe)  ; FPC only
	; (kInterrupt)  ; FPC only
	(kNoreturn)
	; (kIocheck)  ; FPC only
	(kLocal)
	; (kHardfloat)  ; FPC only
	; (kSoftfloat)  ; FPC only
	; (kMs_abi_default)  ; FPC only
	; (kMs_abi_cdecl)  ; FPC only
	; (kSaveregisters)  ; FPC only
	; (kSysv_abi_default)  ; FPC only
	; (kSysv_abi_cdecl)  ; FPC only
	; (kVectorcall)  ; FPC only
	; (kVarargs)  ; FPC only
	; (kWinapi)  ; FPC only
	; (kAlias)  ; FPC only
	(kDelayed)

	(kFor)
	(kTo)
	(kDownto)
	(kIf)
	(kThen)
	(kElse)
	(kDo)
	(kWhile)
	(kRepeat)
	(kUntil)
	(kTry)
	(kExcept)
	(kFinally)
	(kRaise)
	(kOn)
	(kCase)
	(kWith)
	(kGoto)
] @keyword

; -- Punctuation & operators

[
	"("
	")"
	"["
	"]"
] @punctuation.bracket

[
	";"
	","
	":"
	".."
	(kEndDot)
] @punctuation.delimiter

[
	(kDot)
	(kAdd)
	(kSub)
	(kMul)
	(kFdiv)
	(kAssign)
	; FPC compound assignment operators (only available when fpc=true in grammar.js)
	; (kAssignAdd)
	; (kAssignSub)
	; (kAssignMul)
	; (kAssignDiv)
	(kEq)
	(kLt)
	(kLte)
	(kGt)
	(kGte)
	(kNeq)
	(kAt)
	(kHat)
] @operator

; technically operators, but better to render as reserved words
[
	(kOr)
	(kXor)
	(kDiv)
	(kMod)
	(kAnd)
	(kShl)
	(kShr)
	(kNot)
	(kIs)
	(kAs)
	(kIn)
] @keyword

; -- Builtin constants

[
	(kTrue)
	(kFalse)
] @constant;

; arguably a constant, but we highlight it as a keyword
[
	(kNil)
] @keyword

; -- Literals

(literalNumber)   @number
(literalString)   @string

; -- Comments
(comment)         @comment
(pp)              @keyword

; -- Type declaration

(declType name: (identifier) @type)
(declType name: (genericTpl entity: (identifier) @type))

; -- Procedure & function declarations

; foobar
(declProc name: (identifier) @function)
; foobar<t>
(declProc name: (genericTpl entity: (identifier) @function))
; foo.bar
(declProc name: (genericDot rhs: (identifier) @function))
; foo.bar<t>
(declProc name: (genericDot rhs: (genericTpl entity: (identifier) @function)))

; Treat property declarations like functions

(declProp name: (identifier) @function)

; -- Function parameters

(declArg name: (identifier) @variable.parameter)

; -- Template parameters

(genericArg	name: (identifier) @type.parameter)
(genericArg	type: (typeref) @type)

(genericDot (identifier) @type)
(genericDot (genericTpl entity: (identifier) @type))

; -- Exception parameters
(exceptionHandler variable: (identifier) @variable.parameter)

; -- Type usage

(typeref) @type

; -- Constant usage

[
	(caseLabel)
	(label)
] @constant;


;;; ---------------------------------------------- ;;;
;;; EVERYTHING BELOW THIS IS OF QUESTIONABLE VALUE ;;;
;;; ---------------------------------------------- ;;;

; -- Break, Continue & Exit
; (Not ideal: ideally, there would be a way to check if these special
; identifiers are shadowed by a local variable)
(statement ((identifier) @keyword
 (#match? @keyword "^[eE][xX][iI][tT]$")))
(statement (exprCall entity: ((identifier) @keyword
 (#match? @keyword "^[eE][xX][iI][tT]$"))))
(statement ((identifier) @keyword
 (#match? @keyword "^[bB][rR][eE][aA][kK]$")))
(statement ((identifier) @keyword
 (#match? @keyword "^[cC][oO][nN][tT][iI][nN][uU][eE]$")))

; -- Procedure name in calls with parentheses
; (Pascal doesn't require parentheses for procedure calls, so this will not
; detect all calls)

; foobar
(exprCall entity: (identifier) @function)
; foobar<t>
(exprCall entity: (exprTpl entity: (identifier) @function))
; foo.bar
(exprCall entity: (exprDot rhs: (identifier) @function))
; foo.bar<t>
(exprCall entity: (exprDot rhs: (exprTpl entity: (identifier) @function)))

; -- Heuristic for procedure/function calls without parentheses
; (If a statement consists only of an identifier, assume it's a procedure)
; (This will still not match all procedure calls, and also may produce false
; positives in rare cases, but only for nonsensical code)

(statement (identifier) @function)
(statement (exprDot rhs: (identifier) @function))
(statement (exprTpl entity: (identifier) @function))
(statement (exprDot rhs: (exprTpl entity: (identifier) @function)))

; -- Variable & constant declarations
; (This is only questionable because we cannot detect types of identifiers
; declared in other units, so the results will be inconsistent)

(declVar name: (identifier) @variable)
(declField name: (identifier) @variable)
(declConst name: (identifier) @constant)
(declEnumValue name: (identifier) @constant)

; -- Identifier type inferrence

; vERY QUESTIONABLE: Highlighting of identifiers based on spelling
(exprBinary ((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))
(exprUnary ((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))
(assignment rhs: ((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))
(exprBrackets ((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))
(exprParens ((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))
; Template arguments contain exprTplArg nodes, not direct identifiers
(exprTpl (exprTplArg (identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))
(exprArgs ((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$|^[a-z]{2}[A-Z].+$")))

; -- Use scoping information for additional highlighting. THIS NEED TO BE LAST.
; FIXME: Right now this is buggy, because in case of something like this:
;   procedure (x: integer);
;   begin
;     a.x;
;   end;
; The x in a.x would be highlighted as a parameter. Not what we want! We have to
; come up with a more specific rule. Only the left-most identifier should be
; matched.
(identifier)      @identifier
