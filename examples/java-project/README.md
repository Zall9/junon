# Java Fixture Project — IDE Bridge

> Deterministic fixture for Phase 1 protocol conformance testing.
> Exercise: interface, abstract class, implementation, override, references, multi-file rename target.

## Structure

```
java-project/
├── src/main/java/idebridge/examples/
│   ├── Named.java          # Interface
│   ├── AbstractNamed.java  # Abstract class implementing Named (rename target)
│   ├── User.java           # Concrete class extending AbstractNamed (rename target)
│   ├── AdminUser.java      # Second concrete class extending AbstractNamed
│   └── Main.java           # Usage site with multi-file references
└── tests/idebridge/examples/
    └── NamedTest.java       # JUnit 5 test referencing User, AdminUser, AbstractNamed
```

## Symbols for IDEBP testing

| Symbol | Kind | File | Purpose |
|--------|------|------|---------|
| `Named` | Interface | `Named.java` | Public contract |
| `AbstractNamed` | Abstract class | `AbstractNamed.java` | Implements `Named`; rename target |
| `User` | Class | `User.java` | Extends `AbstractNamed`; override `getRole()`; rename target |
| `AdminUser` | Class | `AdminUser.java` | Extends `AbstractNamed`; override `getRole()` |
| `getRole()` | Abstract method | `AbstractNamed.java` | Overridden by `User` and `AdminUser` |
| `getId()` | Method | `Named.java` | Implemented by `AbstractNamed` |
| `getDisplayName()` | Method | `Named.java` | Implemented by `AbstractNamed` |
| `Main` | Class | `Main.java` | Usage site referencing `User`, `AdminUser`, `Named` |
| `printNamed` | Method | `Main.java` | Takes `Named` parameter (polymorphic reference) |

## Expected contract

### Symbol resolution
- `document/getSymbols` on `AbstractNamed.java` must return: `AbstractNamed` (class), `getId()`, `getDisplayName()`, `getRole()` (abstract method).
- `symbol/getDefinition` on `User` in `Main.java` must resolve to `User.java`.
- `symbol/getReferences` on `User` must include: `User.java` (declaration), `Main.java` (usage), `NamedTest.java` (usage).
- `symbol/getImplementations` on `Named` must return `AbstractNamed` (abstract) and transitively `User`, `AdminUser`.
- `symbol/getImplementations` on `AbstractNamed` must return `User` and `AdminUser`.
- `symbol/getReferences` on `getRole()` declared in `AbstractNamed` must include the overrides in `User` and `AdminUser`.

### Override
- `User.getRole()` and `AdminUser.getRole()` override the abstract method in `AbstractNamed`.
- IDEBP `symbol/getReferences` on the abstract `getRole()` should include override sites when the adapter supports it.

### Rename (multi-file)
- Renaming `User` → `User2` must update: `User.java` (declaration), `Main.java` (usage), `NamedTest.java` (usage).
- Renaming `AbstractNamed` → `BaseNamed` must update: `AbstractNamed.java`, `User.java` (`extends`), `AdminUser.java` (`extends`), `NamedTest.java` (type usage).
- Renaming `getRole` → `getRoleLabel` must update: `AbstractNamed.java` (declaration), `User.java` (override), `AdminUser.java` (override), `NamedTest.java` (call sites).

## Validation

```bash
# Compile source files (no external dependencies needed for source compilation)
javac -d out src/main/java/idebridge/examples/*.java

# The test file requires JUnit 5 on the classpath; if unavailable:
# javac -d out tests/idebridge/examples/NamedTest.java \
#   -cp out:junit-platform-console-standalone.jar
```

## Notes
- Source files compile with plain `javac` — no external dependencies.
- The test file uses JUnit 5 (`org.junit.jupiter.api.Test`). It is part of the rename reference surface but requires JUnit on the classpath to compile. If JUnit is unavailable, the test file still serves as a reference target for IDE symbol resolution.
