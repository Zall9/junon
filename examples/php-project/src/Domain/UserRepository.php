<?php

declare(strict_types=1);

/**
 * IDE Bridge — PHP fixture: Domain namespace — repository referencing User.
 *
 * Creates a cross-file reference to `Domain\User` for IDEBP
 * multi-file reference and rename tests.
 */

namespace IDEBridge\Domain;

/**
 * Repository for {@see User} entities.
 *
 * References `User` in type hints so that renaming `User` in the
 * Domain namespace must update this file.
 */
class UserRepository
{
    /** @var array<string, User> */
    private array $entities = [];

    public function add(User $user): void
    {
        $this->entities[$user->getId()] = $user;
    }

    public function findById(string $id): ?User
    {
        return $this->entities[$id] ?? null;
    }

    /**
     * @return array<string, User>
     */
    public function all(): array
    {
        return $this->entities;
    }
}
