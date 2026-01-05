/**
 * External Scanner for Tree-sitter Pascal Grammar
 *
 * This scanner handles two external tokens:
 *
 * 1. AUTOMATIC_SEMICOLON: Implements ASI (Automatic Semicolon Insertion) for error recovery.
 *    When a semicolon is expected but missing, and a newline followed by a new declaration
 *    is detected, a zero-width _automatic_semicolon token is emitted.
 *
 * 2. CLASS_BODY_START: Zero-width sentinel token that disambiguates class/record bodies
 *    from forward declarations. Emitted when we detect class body content ahead.
 *
 * Priority order in scan():
 * 1. CLASS_BODY_START (highest) - must be checked before ASI to avoid false positives
 * 2. AUTOMATIC_SEMICOLON - ASI for missing semicolons in declarations
 */

#include "tree_sitter/parser.h"
#include <string.h>
#include <ctype.h>
#include <stdbool.h>

// Token types must match the order in grammar.js externals array:
// externals: $ => [ $._automatic_semicolon, $._class_body_start ]
enum TokenType {
    AUTOMATIC_SEMICOLON = 0, // Index 0: matches $._automatic_semicolon
    CLASS_BODY_START = 1,    // Index 1: matches $._class_body_start
};

/**
 * Keywords that are valid class/record member starters.
 * When we see one of these after 'class' or 'record', we emit CLASS_BODY_START.
 */
static const char* class_member_keywords[] = {
    // Section starters
    "var", "const", "type", "class",
    // Methods
    "procedure", "function", "constructor", "destructor", "operator",
    // Visibility
    "private", "public", "protected", "published", "strict",
    // Other class members
    "property", "case", "end",
    NULL
};

/**
 * Keywords that should prevent ASI (Automatic Semicolon Insertion).
 * These are "soft" keywords that validly continue a construct across a newline.
 * If we see one of these after a newline, we do NOT insert a semicolon.
 */
static const char* no_insert_keywords[] = {
    // Block terminators (trailing statements don't need semicolons before these)
    "end",
    // Control flow continuations
    "else", "then", "do", "of", "to", "downto", "until",
    // Exception handling
    "except", "finally",
    // Property specifiers
    "read", "write", "implements", "stored", "default", "nodefault", "index", "dispid",
    // Other modifiers
    "absolute", "helper", "forward", "external", "name",
    NULL
};

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

/**
 * Check if character is whitespace (space, tab, carriage return).
 */
static inline bool is_whitespace(int32_t c) {
    return c == ' ' || c == '\t' || c == '\r';
}

/**
 * Check if character is a newline.
 */
static inline bool is_newline(int32_t c) {
    return c == '\n';
}

/**
 * Convert character to lowercase.
 */
static inline char to_lower(char c) {
    if (c >= 'A' && c <= 'Z') {
        return c - 'A' + 'a';
    }
    return c;
}

/**
 * Case-insensitive comparison of a word against a keyword list.
 * @param word The word to check (not null-terminated, use len)
 * @param len Length of the word
 * @param keyword_list Null-terminated array of lowercase keywords
 * @return true if the word matches any keyword in the list
 */
static bool is_in_keyword_list(const char* word, size_t len, const char** keyword_list) {
    for (int i = 0; keyword_list[i] != NULL; i++) {
        size_t kw_len = strlen(keyword_list[i]);
        if (kw_len == len) {
            bool match = true;
            for (size_t j = 0; j < len; j++) {
                if (to_lower(word[j]) != keyword_list[i][j]) {
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
 * Skip whitespace (spaces, tabs) without consuming newlines.
 * @param lexer The tree-sitter lexer
 */
static void skip_whitespace_not_newline(TSLexer* lexer) {
    while (is_whitespace(lexer->lookahead)) {
        lexer->advance(lexer, true);  // true = skip (don't include in token)
    }
}

/**
 * Skip all whitespace including newlines.
 * @param lexer The tree-sitter lexer
 * @param saw_newline Output parameter - set to true if we saw a newline
 */
static void skip_whitespace_and_newlines(TSLexer* lexer, bool* saw_newline) {
    while (is_whitespace(lexer->lookahead) || is_newline(lexer->lookahead)) {
        if (is_newline(lexer->lookahead)) {
            *saw_newline = true;
        }
        lexer->advance(lexer, true);
    }
}

/**
 * Check if the lookahead indicates a class member start.
 * This is used to emit CLASS_BODY_START token.
 *
 * Class member starters:
 * - Identifier followed by ':' (field declaration)
 * - Keywords: var, const, type, class, procedure, function, etc.
 * - '[' (RTTI attributes)
 * - 'end' (empty body)
 * - 'case' (variant part)
 *
 * NOT class member starters:
 * - ';' (forward declaration: `type T = class;`)
 * - '(' (class heritage: `type T = class(TBase)`)
 */
static bool is_class_member_start(TSLexer* lexer) {
    // Skip whitespace and newlines for lookahead
    bool saw_newline = false;
    skip_whitespace_and_newlines(lexer, &saw_newline);

    int32_t c = lexer->lookahead;

    // '[' could be RTTI attributes or GUID
    // GUID format: ['string'] - starts with string literal after [
    // RTTI format: [Identifier] or [Identifier(args)]
    // If it's a GUID (string literal), it's NOT a class body start
    if (c == '[') {
        lexer->advance(lexer, true);  // Skip [
        skip_whitespace_not_newline(lexer);
        // Check if next char is a string delimiter (GUID)
        if (lexer->lookahead == '\'' || lexer->lookahead == '#') {
            // It's a GUID like ['{...}'] or ['...'] - NOT a class body start
            return false;
        }
        // It's an RTTI attribute - IS a class body start
        return true;
    }

    // ';' means forward declaration - NOT a class body
    if (c == ';') {
        return false;
    }

    // '(' means class heritage - NOT directly a class body start
    if (c == '(') {
        return false;
    }

    // Check for identifier or keyword
    if (is_identifier_start(c)) {
        char buffer[256];
        size_t len = 0;

        // Collect the word
        while (is_identifier_char(lexer->lookahead) && len < 255) {
            buffer[len++] = (char)lexer->lookahead;
            lexer->advance(lexer, true);
        }
        buffer[len] = '\0';

        // Check if it's a class member keyword
        if (is_in_keyword_list(buffer, len, class_member_keywords)) {
            return true;
        }

        // Skip whitespace after the identifier
        skip_whitespace_not_newline(lexer);

        // If followed by ':', it's a field declaration
        if (lexer->lookahead == ':') {
            return true;
        }

        // If followed by ',', it's also a field (multiple fields: a, b: Type)
        if (lexer->lookahead == ',') {
            return true;
        }

        // Otherwise, it's not clearly a class member start
        return false;
    }

    return false;
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
 *
 * Priority order:
 * 1. CLASS_BODY_START - Zero-width sentinel for class/record body disambiguation
 * 2. AUTOMATIC_SEMICOLON - ASI for missing semicolons
 */
bool tree_sitter_pascal_external_scanner_scan(
    void* payload,
    TSLexer* lexer,
    const bool* valid_symbols
) {
    // =========================================================================
    // 1. Check for CLASS_BODY_START (highest priority)
    // =========================================================================
    // This is a zero-width sentinel token that disambiguates class/record bodies
    // from forward declarations. We check this BEFORE ASI to ensure class bodies
    // are properly recognized.
    if (valid_symbols[CLASS_BODY_START]) {
        // Save the current position - we need to peek without consuming
        lexer->mark_end(lexer);

        if (is_class_member_start(lexer)) {
            // Don't consume anything - this is a zero-width token
            lexer->result_symbol = CLASS_BODY_START;
            return true;
        }
        // If not a class body start, fall through to check other tokens
    }

    // =========================================================================
    // 2. Check for AUTOMATIC_SEMICOLON (ASI)
    // =========================================================================
    // Implements Automatic Semicolon Insertion:
    // - This is a ZERO-WIDTH token - we never consume any characters
    // - If we see a newline followed by a non-continuation token, insert virtual semicolon
    // - Real semicolons are handled by the literal ';' in the grammar, not here
    //
    // Note: CLASS_BODY_START is checked first (above) with higher priority.
    // ASI can safely run even when CLASS_BODY_START is valid because:
    // 1. CLASS_BODY_START will be handled first if applicable
    // 2. Inside class bodies, ASI is needed for missing semicolons between fields
    if (valid_symbols[AUTOMATIC_SEMICOLON]) {
        lexer->mark_end(lexer);  // Mark the insertion point (zero-width)
        bool saw_newline = false;

        // Skip whitespace and track newlines (for lookahead only)
        while (is_whitespace(lexer->lookahead) || is_newline(lexer->lookahead)) {
            if (is_newline(lexer->lookahead)) {
                saw_newline = true;
            }
            lexer->advance(lexer, true);  // skip = true, don't include in token
        }

        // If there's a real semicolon, let the grammar's literal ';' handle it
        // We only insert virtual semicolons when the semicolon is missing
        if (lexer->lookahead == ';') {
            return false;
        }

        // Insert virtual semicolon if we saw a newline
        // and the next token is NOT a continuation keyword
        if (saw_newline) {
            // Check what's next
            if (is_identifier_start(lexer->lookahead)) {
                // Peek at the word to check if it's a continuation keyword
                char word[256];
                size_t len = 0;
                int32_t c = lexer->lookahead;

                // Collect the word characters (lookahead only, already skipping)
                while (is_identifier_char(c) && len < sizeof(word) - 1) {
                    word[len++] = (char)c;
                    lexer->advance(lexer, true);
                    c = lexer->lookahead;
                }
                word[len] = '\0';

                // Check if it's a continuation keyword
                if (!is_in_keyword_list(word, len, no_insert_keywords)) {
                    // Not a continuation keyword - insert virtual semicolon
                    // The token is zero-width at the mark_end position
                    lexer->result_symbol = AUTOMATIC_SEMICOLON;
                    return true;
                }
            } else if (lexer->lookahead != 0) {
                // Not an identifier - check for symbols that start new statements
                // We should insert semicolon before these
                if (lexer->lookahead == '[' ||   // RTTI attributes
                    lexer->lookahead == '{') {   // Comment/preprocessor start
                    lexer->result_symbol = AUTOMATIC_SEMICOLON;
                    return true;
                }
            } else {
                // EOF - insert semicolon at end of file
                lexer->result_symbol = AUTOMATIC_SEMICOLON;
                return true;
            }
        }

        // No ASI possible
        return false;
    }

    return false;
}
