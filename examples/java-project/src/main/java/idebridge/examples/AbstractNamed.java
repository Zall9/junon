/**
 * IDE Bridge — Java fixture: abstract class implementing Named.
 *
 * Provides shared behaviour and declares an abstract method for
 * subclasses to implement (override).
 */
package idebridge.examples;

/**
 * Common base for named entities.
 *
 * Rename target: renaming `AbstractNamed` should update references in
 * `User.java`, `AdminUser.java`, and `NamedTest.java`.
 */
public abstract class AbstractNamed implements Named {

    private final String id;
    private final String displayName;

    protected AbstractNamed(String id, String displayName) {
        this.id = id;
        this.displayName = displayName;
    }

    @Override
    public String getId() {
        return id;
    }

    @Override
    public String getDisplayName() {
        return displayName;
    }

    /**
     * Subclasses must provide a role label.
     *
     * @return the role of this entity.
     */
    public abstract String getRole();
}
