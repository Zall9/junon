<?php

declare(strict_types=1);

/**
 * IDE Bridge — PHP fixture: Support namespace.
 *
 * Contains a DIFFERENT `User` class in a separate namespace to test
 * that IDEBP can disambiguate same-named symbols across namespaces.
 *
 * `Support\User` should NOT be renamed when `Domain\User` is renamed,
 * and vice versa.
 */

namespace IDEBridge\Support;

/**
 * Support-layer user (e.g. a service account or system user).
 *
 * This class has the same simple name `User` as `IDEBridge\Domain\User`
 * but lives in a different namespace. IDEBP adapters must distinguish
 * them by fully-qualified name.
 */
class User
{
    public function __construct(
        private readonly string $systemId,
        private readonly string $scope,
    ) {
    }

    public function getSystemId(): string
    {
        return $this->systemId;
    }

    public function getScope(): string
    {
        return $this->scope;
    }

    /**
     * Return a log-friendly identifier.
     */
    public function toLogString(): string
    {
        return "[{$this->scope}] {$this->systemId}";
    }
}
