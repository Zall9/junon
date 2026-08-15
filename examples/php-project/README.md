# PHP Fixture Project — IDE Bridge

> Deterministic fixture for Phase 1 protocol conformance testing.
> Exercise: namespace, class, trait, method, PHP attribute, references, same-named symbol in two namespaces.

## Structure

```
php-project/
├── src/
│   ├── Domain/
│   │   ├── User.php             # Class with trait + attribute + interface implementation
│   │   ├── UserRepository.php   # References Domain\User (cross-file reference)
│   │   ├── Audited.php          # (declared in User.php as a PHP attribute)
│   │   ├── Timestamped.php      # (declared in User.php as a trait)
│   │   └── RepositoryAware.php  # (declared in User.php as an interface)
│   └── Support/
│       └── User.php             # Different User class (same name, different namespace)
└── tests/
    └── UserTest.php              # References both Domain\User and Support\User
```

> **Note:** `Audited`, `Timestamped`, and `RepositoryAware` are all declared inside
> `Domain/User.php` to keep the fixture minimal. A real project might split them
> into separate files, but co-location is valid PHP and exercises multi-symbol
> document parsing.

## Symbols for IDEBP testing

| Symbol | Kind | Namespace | File | Purpose |
|--------|------|-----------|------|---------|
| `User` | Class | `IDEBridge\Domain` | `src/Domain/User.php` | Rename target (domain entity) |
| `User` | Class | `IDEBridge\Support` | `src/Support/User.php` | Same-named symbol in different namespace |
| `UserRepository` | Class | `IDEBridge\Domain` | `src/Domain/UserRepository.php` | References `Domain\User` |
| `Audited` | Attribute class | `IDEBridge\Domain` | `src/Domain/User.php` | PHP 8.0+ attribute |
| `Timestamped` | Trait | `IDEBridge\Domain` | `src/Domain/User.php` | Trait used by `Domain\User` |
| `RepositoryAware` | Interface | `IDEBridge\Domain` | `src/Domain/User.php` | Interface implemented by `Domain\User` |
| `getRepositoryName()` | Method | `IDEBridge\Domain\User` | `src/Domain/User.php` | Marked with `#[Audited]` attribute |
| `getDisplayName()` | Method | `IDEBridge\Domain\User` | `src/Domain/User.php` | Method reference target |

## Expected contract

### Symbol resolution
- `document/getSymbols` on `src/Domain/User.php` must return: `Audited` (class/attribute), `RepositoryAware` (interface), `Timestamped` (trait), `User` (class), and their methods.
- `symbol/getDefinition` on `User` in `src/Domain/UserRepository.php` must resolve to `src/Domain/User.php` (the Domain one, not Support).
- `symbol/getReferences` on `IDEBridge\Domain\User` must include: `src/Domain/User.php` (declaration), `src/Domain/UserRepository.php` (type hints), `tests/UserTest.php` (import + usage).
- `symbol/getReferences` on `IDEBridge\Support\User` must include: `src/Support/User.php` (declaration), `tests/UserTest.php` (import as `SupportUser` + usage).

### Same-named symbol disambiguation
- `User` exists in both `IDEBridge\Domain` and `IDEBridge\Support`.
- `symbol/resolveAt` at the `User` usage in `UserRepository.php` must resolve to `Domain\User`, not `Support\User`.
- Searching for `User` by simple name may return `AMBIGUOUS_SYMBOL` with both candidates; fully-qualified lookup must be unambiguous.

### PHP attribute
- `#[Audited(reason: 'security-relevant')]` decorates `getRepositoryName()`.
- `document/getSymbols` should report the attribute usage on the method.
- `symbol/getDefinition` on `Audited` in the attribute usage should resolve to the `Audited` class declaration.

### Trait
- `Domain\User` uses `Timestamped` trait.
- `symbol/getDefinition` on `Timestamped` in the `use` statement should resolve to the trait declaration.
- `symbol/getReferences` on `Timestamped` should include the `use` site in `Domain\User`.

### Rename
- Renaming `IDEBridge\Domain\User` → `Account` must update: `src/Domain/User.php` (declaration), `src/Domain/UserRepository.php` (type hints), `tests/UserTest.php` (import + usage). It must NOT touch `src/Support/User.php`.
- Renaming `IDEBridge\Support\User` must update `src/Support/User.php` and `tests/UserTest.php` only. It must NOT touch Domain files.
- Renaming `getRepositoryName` in Domain\User must update: `src/Domain/User.php` (declaration), `tests/UserTest.php` (call site).

## Validation

```bash
# Syntax check (no external dependencies needed)
php -l src/Domain/User.php
php -l src/Domain/UserRepository.php
php -l src/Support/User.php
php -l tests/UserTest.php

# Lint all files at once
find . -name '*.php' -exec php -l {} \;
```

## Notes
- PHP 8.0+ required for attributes, `readonly` properties, and `mixed` type.
- The fixture uses no Composer dependencies. Pure PHP language features only.
- `tests/UserTest.php` uses `assert()` instead of a test framework to avoid external dependencies. It can be executed with `php tests/UserTest.php` but is primarily a reference target for IDE symbol resolution.
