<?php

declare(strict_types=1);

/**
 * IDE Bridge — PHP fixture: Domain namespace.
 *
 * Contains a class, an interface, a PHP attribute, and a trait.
 * The class `User` exists in both `Domain` and `Support` namespaces
 * to test same-named symbol disambiguation.
 */

namespace IDEBridge\Domain;

/**
 * PHP attribute marking a method as "audited".
 *
 * Demonstrates PHP 8.0+ attributes for IDEBP symbol resolution.
 */
#[\Attribute(\Attribute::TARGET_METHOD)]
class Audited
{
    public function __construct(
        public readonly string $reason = '',
    ) {
    }
}

/**
 * Contract for entities that have a repository.
 */
interface RepositoryAware
{
    /**
     * @return string the repository name.
     */
    public function getRepositoryName(): string;
}

/**
 * Shared behaviour for timestamped entities.
 *
 * Demonstrates a PHP trait for IDEBP trait symbol resolution.
 */
trait Timestamped
{
    private ?string $createdAt = null;
    private ?string $updatedAt = null;

    public function setCreatedAt(string $timestamp): void
    {
        $this->createdAt = $timestamp;
    }

    public function getCreatedAt(): ?string
    {
        return $this->createdAt;
    }

    public function setUpdatedAt(string $timestamp): void
    {
        $this->updatedAt = $timestamp;
    }

    public function getUpdatedAt(): ?string
    {
        return $this->updatedAt;
    }
}

/**
 * Domain user entity.
 *
 * Rename target: renaming `User` in the Domain namespace should update
 * references in `Domain/UserRepository.php` and `tests/UserTest.php`
 * but NOT the `Support\User` class.
 */
class User implements RepositoryAware
{
    use Timestamped;

    public function __construct(
        private readonly string $id,
        private readonly string $name,
    ) {
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getName(): string
    {
        return $this->name;
    }

    #[Audited(reason: 'security-relevant')]
    public function getRepositoryName(): string
    {
        return 'users';
    }

    /**
     * Return a display label combining id and name.
     */
    public function getDisplayName(): string
    {
        return "{$this->id}: {$this->name}";
    }
}
