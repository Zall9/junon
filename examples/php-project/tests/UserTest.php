<?php

declare(strict_types=1);

/**
 * IDE Bridge — PHP fixture: test file for rename references.
 *
 * References `Domain\User`, `Domain\UserRepository`, and `Support\User`
 * so that rename operations must update this file. Also exercises the
 * `Audited` attribute and the `Timestamped` trait.
 */

namespace IDEBridge\Tests;

use IDEBridge\Domain\Audited;
use IDEBridge\Domain\Timestamped;
use IDEBridge\Domain\User;
use IDEBridge\Domain\UserRepository;
use IDEBridge\Support\User as SupportUser;

/**
 * Smoke test class for fixture validation.
 */
class UserTest
{
    public function testDomainUser(): void
    {
        $user = new User('u1', 'Alice');
        assert($user->getId() === 'u1');
        assert($user->getName() === 'Alice');
        assert($user->getRepositoryName() === 'users');
        assert($user->getDisplayName() === 'u1: Alice');
    }

    public function testTraitUsage(): void
    {
        $user = new User('u1', 'Alice');
        $user->setCreatedAt('2026-08-01T00:00:00Z');
        assert($user->getCreatedAt() === '2026-08-01T00:00:00Z');
    }

    public function testRepository(): void
    {
        $repo = new UserRepository();
        $user = new User('u1', 'Alice');
        $repo->add($user);
        assert($repo->findById('u1') !== null);
        assert($repo->findById('nonexistent') === null);
    }

    public function testSupportUserIsDistinct(): void
    {
        $supportUser = new SupportUser('sys-1', 'ci');
        assert($supportUser->getSystemId() === 'sys-1');
        assert($supportUser->getScope() === 'ci');
        assert($supportUser->toLogString() === '[ci] sys-1');
    }
}
