# SQLite 3.46.1 (Expo-symbol layout)

Why this exists: expo-sqlite 57 bundles SQLite **3.50.3**, which has a documented
slow-query regression (expo/expo#40977; last fast version 3.46.1). On a device this
showed up as single statements taking seconds to minutes — a 4-row INSERT measured at
120s — with the database healthy (64MB, empty WAL, ~1.3k free pages). Both iOS build
scripts pin this copy over whatever `yarn install`/`prebuild` re-materialises.

## Provenance

- Source: `sqlite3.c` / `sqlite3.h` from the `better-sqlite3@11.3.0` npm tarball
  (`deps/sqlite3/`), which vendors the unmodified SQLite 3.46.1 amalgamation.
- expo-sqlite compiles against **prefixed symbols** (`exsqlite3_*`) so it can coexist
  with the system SQLite. Stock 3.46.1 uses plain names, so the amalgamation here was
  renamed with the same convention before being vendored.

## Regenerating (when changing versions)

From an unmodified amalgamation:

```
sed-based rule: every token matching /\bsqlite3[A-Za-z0-9_]*/ becomes exsqlite3…
EXCEPT these four, which expo-sqlite's Swift code references unprefixed:
  sqlite3_destructor_type
  sqlite3_int64
  sqlite3_uint64
  sqlite3_vec_init
```

The exception list was derived from the symbol references in
`node_modules/expo-sqlite/ios/*.swift`; re-derive it the same way after an expo-sqlite
upgrade (`grep -o '\bsqlite3[A-Za-z0-9_]*' ios/*.swift`).

Verify afterwards: `grep -c exsqlite3changeset_apply sqlite3.h` > 0,
`grep -m1 'define SQLITE_VERSION ' sqlite3.h` reports the intended version, and the
archive compiles the `ExpoSQLite` target without `cannot find 'exsqlite3_*'` errors.
