/**
 * IDE Bridge — Java fixture: concrete implementation.
 *
 * Extends {@link AbstractNamed} and overrides {@link #getRole()}.
 */
package idebridge.examples;

/**
 * A user entity with a role.
 *
 * Rename target: renaming `User` should update references in
 * `AdminUser.java`, `Main.java`, and `NamedTest.java`.
 */
public class User extends AbstractNamed {

    private final String role;

    public User(String id, String displayName, String role) {
        super(id, displayName);
        this.role = role;
    }

    @Override
    public String getRole() {
        return role;
    }
}
