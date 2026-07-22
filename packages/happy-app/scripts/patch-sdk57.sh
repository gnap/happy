#!/bin/bash
set -e
HAPPY_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Copy sqlite3 vendor files to ios/ (required by podspec)
cp "$HAPPY_DIR/node_modules/expo-sqlite/vendor/sqlite3/sqlite3.h" "$HAPPY_DIR/node_modules/expo-sqlite/ios/sqlite3.h"
cp "$HAPPY_DIR/node_modules/expo-sqlite/vendor/sqlite3/sqlite3.c" "$HAPPY_DIR/node_modules/expo-sqlite/ios/sqlite3.c"

# 2. Create bridge file for exsqlite3_* functions (Swift can't see macros)
cat > "$HAPPY_DIR/node_modules/expo-sqlite/ios/exsqlite_bridge.c" << 'EOF'
#include "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/usr/include/sqlite3.h"
int exsqlite3_open(const char *f, sqlite3 **db) { return sqlite3_open(f, db); }
int exsqlite3_open_v2(const char *f, sqlite3 **db, int fl, const char *v) { return sqlite3_open_v2(f, db, fl, v); }
int exsqlite3_close(sqlite3 *d) { return sqlite3_close(d); }
int exsqlite3_close_v2(sqlite3 *d) { return sqlite3_close_v2(d); }
int exsqlite3_exec(sqlite3 *d, const char *s, int (*c)(void*,int,char**,char**), void *a, char **e) { return sqlite3_exec(d, s, c, a, e); }
int exsqlite3_get_autocommit(sqlite3 *d) { return sqlite3_get_autocommit(d); }
void *exsqlite3_malloc(int n) { return sqlite3_malloc(n); }
void *exsqlite3_malloc64(sqlite3_uint64 n) { return sqlite3_malloc64(n); }
void exsqlite3_free(void *p) { sqlite3_free(p); }
int exsqlite3_deserialize(sqlite3 *d, const char *z, unsigned char *p, sqlite3_int64 sd, sqlite3_int64 sb, unsigned m) { return sqlite3_deserialize(d, z, p, sd, sb, m); }
int exsqlite3_initialize(void) { return sqlite3_initialize(); }
unsigned char *exsqlite3_serialize(sqlite3 *d, const char *z, sqlite3_int64 *sz, unsigned m) { return sqlite3_serialize(d, z, sz, m); }
int exsqlite3_prepare_v2(sqlite3 *d, const char *s, int n, sqlite3_stmt **st, const char **t) { return sqlite3_prepare_v2(d, s, n, st, t); }
int exsqlite3_reset(sqlite3_stmt *st) { return sqlite3_reset(st); }
int exsqlite3_clear_bindings(sqlite3_stmt *st) { return sqlite3_clear_bindings(st); }
int exsqlite3_step(sqlite3_stmt *st) { return sqlite3_step(st); }
sqlite3_int64 exsqlite3_last_insert_rowid(sqlite3 *d) { return sqlite3_last_insert_rowid(d); }
int exsqlite3_changes(sqlite3 *d) { return sqlite3_changes(d); }
const char *exsqlite3_errmsg(sqlite3 *d) { return sqlite3_errmsg(d); }
int exsqlite3_finalize(sqlite3_stmt *st) { return sqlite3_finalize(st); }
int exsqlite3_bind_text(sqlite3_stmt *st, int i, const char *t, int n, void(*f)(void*)) { return sqlite3_bind_text(st, i, t, n, f); }
int exsqlite3_bind_int(sqlite3_stmt *st, int i, int v) { return sqlite3_bind_int(st, i, v); }
int exsqlite3_bind_int64(sqlite3_stmt *st, int i, sqlite3_int64 v) { return sqlite3_bind_int64(st, i, v); }
int exsqlite3_bind_double(sqlite3_stmt *st, int i, double v) { return sqlite3_bind_double(st, i, v); }
int exsqlite3_bind_null(sqlite3_stmt *st, int i) { return sqlite3_bind_null(st, i); }
int exsqlite3_bind_blob(sqlite3_stmt *st, int i, const void *d, int n, void(*f)(void*)) { return sqlite3_bind_blob(st, i, d, n, f); }
int exsqlite3_column_count(sqlite3_stmt *st) { return sqlite3_column_count(st); }
int exsqlite3_column_type(sqlite3_stmt *st, int i) { return sqlite3_column_type(st, i); }
const char *exsqlite3_column_name(sqlite3_stmt *st, int i) { return sqlite3_column_name(st, i); }
const char *exsqlite3_column_decltype(sqlite3_stmt *st, int i) { return sqlite3_column_decltype(st, i); }
const char *exsqlite3_column_text(sqlite3_stmt *st, int i) { return (const char*)sqlite3_column_text(st, i); }
int exsqlite3_column_int(sqlite3_stmt *st, int i) { return sqlite3_column_int(st, i); }
sqlite3_int64 exsqlite3_column_int64(sqlite3_stmt *st, int i) { return sqlite3_column_int64(st, i); }
double exsqlite3_column_double(sqlite3_stmt *st, int i) { return sqlite3_column_double(st, i); }
const void *exsqlite3_column_blob(sqlite3_stmt *st, int i) { return sqlite3_column_blob(st, i); }
int exsqlite3_column_bytes(sqlite3_stmt *st, int i) { return sqlite3_column_bytes(st, i); }
const char *exsqlite3_libversion(void) { return sqlite3_libversion(); }
int exsqlite3_libversion_number(void) { return sqlite3_libversion_number(); }
EOF

# 3. Fix SQLiteModule.swift function calls (Swift sees exsqlite3_* bridge)
SWIFT="$HAPPY_DIR/node_modules/expo-sqlite/ios/SQLiteModule.swift"
sed -i '' -E 's/\bsqlite3_open\b/exsqlite3_open/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_open_v2\b/exsqlite3_open_v2/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_close\b/exsqlite3_close/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_close_v2\b/exsqlite3_close_v2/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_exec\b/exsqlite3_exec/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_get_autocommit\b/exsqlite3_get_autocommit/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_malloc\b/exsqlite3_malloc/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_malloc64\b/exsqlite3_malloc64/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_free\b/exsqlite3_free/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_deserialize\b/exsqlite3_deserialize/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_initialize\b/exsqlite3_initialize/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_serialize\b/exsqlite3_serialize/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_prepare_v2\b/exsqlite3_prepare_v2/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_reset\b/exsqlite3_reset/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_clear_bindings\b/exsqlite3_clear_bindings/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_step\b/exsqlite3_step/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_last_insert_rowid\b/exsqlite3_last_insert_rowid/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_changes\b/exsqlite3_changes/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_errmsg\b/exsqlite3_errmsg/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_finalize\b/exsqlite3_finalize/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_bind_text\b/exsqlite3_bind_text/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_bind_int\b/exsqlite3_bind_int/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_bind_int64\b/exsqlite3_bind_int64/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_bind_double\b/exsqlite3_bind_double/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_bind_null\b/exsqlite3_bind_null/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_bind_blob\b/exsqlite3_bind_blob/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_count\b/exsqlite3_column_count/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_type\b/exsqlite3_column_type/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_name\b/exsqlite3_column_name/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_decltype\b/exsqlite3_column_decltype/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_text\b/exsqlite3_column_text/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_int\b/exsqlite3_column_int/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_int64\b/exsqlite3_column_int64/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_double\b/exsqlite3_column_double/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_blob\b/exsqlite3_column_blob/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_column_bytes\b/exsqlite3_column_bytes/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_libversion\b/exsqlite3_libversion/g' "$SWIFT"
sed -i '' -E 's/\bsqlite3_libversion_number\b/exsqlite3_libversion_number/g' "$SWIFT"

# 4. Fix expo-updates missing with-node.sh
cp "$HAPPY_DIR/node_modules/expo-constants/scripts/with-node.sh" "$HAPPY_DIR/node_modules/expo-updates/scripts/with-node.sh" 2>/dev/null || true

# 5. Ensure podfile paths and root symlinks
ln -sf "$HAPPY_DIR/node_modules/react-native" "$HAPPY_DIR/../../node_modules/react-native" 2>/dev/null || true
ln -sf "$HAPPY_DIR/node_modules/expo" "$HAPPY_DIR/../../node_modules/expo" 2>/dev/null || true

echo "SDK57 patches applied"
