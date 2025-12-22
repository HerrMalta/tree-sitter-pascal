/**
 * External Scanner for Tree-sitter Pascal Grammar
 *
 * This scanner handles identifier lexing with keyword priority.
 * It prevents keywords from being consumed as identifiers during error recovery.
 *
 * Problem solved:
 * When parsing incomplete code like "myVar := \n end;", tree-sitter's context-aware
 * lexing would consume 'end' as an identifier (the RHS of assignment) because
 * identifier is valid for expressions but kEnd is not. This breaks file structure.
 *
 * Solution:
 * The external scanner matches identifier-like text and checks if it's a keyword.
 * If it's a keyword, it returns false to let tree-sitter's internal lexer handle it.
 * If it's not a keyword, it returns true with the identifier token.
 *
 * The & prefix is handled specially - &keyword is always an identifier (escaped keyword).
 */

#include "tree_sitter/parser.h"
#include <string.h>
#include <ctype.h>

enum TokenType {
    IDENTIFIER,
};

/**
 * List of "structural" Pascal keywords that should NEVER be consumed as identifiers.
 *
 * These are the keywords that, if consumed as identifiers during error recovery,
 * would completely break the file structure and make the parser produce unusable
 * parse trees.
 *
 * We intentionally do NOT include all keywords here. Many Pascal keywords can
 * legitimately be used as identifiers in certain contexts:
 * - `string` - keyword for declString but also a type name in typerefs
 * - `specialize` - keyword for generics but can be a procedure name
 * - Many declaration hints like `deprecated`, `inline`, etc.
 *
 * The keywords listed here are the "truly reserved" structural keywords that
 * delimit major syntactic blocks and control flow.
 */
static const char* keywords[] = {
    // High-level structure - these delimit major file sections
    "program", "library", "unit", "package",
    "interface", "dispinterface", "implementation",
    "initialization", "finalization",

    // Block delimiters - critical for structure
    "begin", "end", "asm",

    // Declaration section keywords - start major sections
    "var", "threadvar", "const", "resourcestring", "type", "label",
    "uses", "exports", "requires", "contains",
    "out",  // Parameter modifier
    "property", "external", "name", "index",  // Declaration modifiers

    // Class/record/type structure
    "class", "object", "record",
    "published", "public", "protected", "private", "strict",
    "set", "array", "file", "packed", "string",  // Type keywords
    "inherited",

    // Control flow - these must not be consumed as expression identifiers
    "if", "then", "else",
    "for", "to", "downto", "do",
    "while", "repeat", "until",
    "case", "of",
    "try", "except", "finally", "on",
    "with", "goto", "raise",

    // Routine declarations
    "function", "procedure", "constructor", "destructor",
    "operator", "reference",
    "forward",

    // Operator keywords - these are operators, not identifiers
    "and", "or", "xor", "not",
    "div", "mod", "shl", "shr",
    "in", "is", "as",

    // Literals
    "nil", "true", "false",

    NULL  // Sentinel
};

/**
 * Check if a word is a Pascal keyword (case-insensitive comparison).
 *
 * @param word The word to check
 * @param len Length of the word
 * @return true if it's a keyword, false otherwise
 */
static bool is_keyword(const char* word, size_t len) {
    for (int i = 0; keywords[i] != NULL; i++) {
        size_t kw_len = strlen(keywords[i]);
        if (kw_len == len) {
            bool match = true;
            for (size_t j = 0; j < len; j++) {
                // Case-insensitive comparison (keywords array is lowercase)
                char c = word[j];
                if (c >= 'A' && c <= 'Z') {
                    c = c - 'A' + 'a';
                }
                if (c != keywords[i][j]) {
                    match = false;
                    break;
                }
            }
            if (match) return true;
        }
    }
    return false;
}

/**
 * Check if character is alphanumeric or underscore.
 */
static inline bool is_identifier_char(int32_t c) {
    return (c >= 'a' && c <= 'z') ||
           (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') ||
           c == '_';
}

/**
 * Check if character can start an identifier (letter or underscore).
 */
static inline bool is_identifier_start(int32_t c) {
    return (c >= 'a' && c <= 'z') ||
           (c >= 'A' && c <= 'Z') ||
           c == '_';
}

// Required external scanner functions

void* tree_sitter_pascal_external_scanner_create() {
    return NULL;  // No state needed
}

void tree_sitter_pascal_external_scanner_destroy(void* payload) {
    // Nothing to free
}

unsigned tree_sitter_pascal_external_scanner_serialize(void* payload, char* buffer) {
    return 0;  // No state to serialize
}

void tree_sitter_pascal_external_scanner_deserialize(void* payload, const char* buffer, unsigned length) {
    // No state to deserialize
}

/**
 * Main scanning function.
 *
 * Called by tree-sitter to scan for external tokens.
 * We only handle IDENTIFIER tokens.
 *
 * Logic:
 * 1. Skip leading whitespace (handled by tree-sitter, but we need to be safe)
 * 2. Check for & prefix (escaped identifier)
 * 3. Match identifier characters
 * 4. If & prefix present, always return as identifier
 * 5. Otherwise, check if it's a keyword - if so, return false to let internal lexer handle it
 * 6. If not a keyword, return true with IDENTIFIER token
 *
 * @param payload External scanner state (unused)
 * @param lexer Tree-sitter lexer
 * @param valid_symbols Array indicating which tokens are valid in current context
 * @return true if we produced a token, false otherwise
 */
bool tree_sitter_pascal_external_scanner_scan(
    void* payload,
    TSLexer* lexer,
    const bool* valid_symbols
) {
    // Only proceed if IDENTIFIER is a valid token in current context
    if (!valid_symbols[IDENTIFIER]) {
        return false;
    }

    // Check for & prefix (escaped identifier, e.g., &end, &begin)
    bool has_ampersand = false;
    if (lexer->lookahead == '&') {
        has_ampersand = true;
        lexer->advance(lexer, false);
    }

    // Must start with letter or underscore
    if (!is_identifier_start(lexer->lookahead)) {
        return false;
    }

    // Buffer to collect the identifier (for keyword checking)
    // 256 chars should be more than enough for any reasonable identifier
    char buffer[256];
    size_t len = 0;

    // Collect identifier characters
    while (is_identifier_char(lexer->lookahead)) {
        if (len < sizeof(buffer) - 1) {
            buffer[len++] = (char)lexer->lookahead;
        }
        lexer->advance(lexer, false);
    }
    buffer[len] = '\0';

    // If no characters were collected (shouldn't happen given is_identifier_start check)
    if (len == 0) {
        return false;
    }

    // If it starts with &, it's always an identifier (escaped keyword syntax)
    // e.g., &end, &begin, &type are valid identifiers
    if (has_ampersand) {
        lexer->result_symbol = IDENTIFIER;
        return true;
    }

    // Check if it's a keyword
    if (is_keyword(buffer, len)) {
        // Return false - let the internal lexer handle it as a keyword
        // This ensures keywords are never consumed as identifiers during error recovery
        return false;
    }

    // It's a regular identifier
    lexer->result_symbol = IDENTIFIER;
    return true;
}
