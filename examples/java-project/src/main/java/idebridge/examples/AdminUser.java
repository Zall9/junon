/**
 * IDE Bridge — Java fixture: second concrete implementation.
 *
 * Demonstrates that renaming `User` does not accidentally touch this
 * class, and that `getImplementations` on `AbstractNamed` returns both
 * `User` and `AdminUser`.
 */
package idebridge.examples;

/**
 * An administrator entity.
 */
public class AdminUser extends AbstractNamed {

    private final String permissionLevel;

    public AdminUser(String id, String displayName, String permissionLevel) {
        super(id, displayName);
        this.permissionLevel = permissionLevel;
    }

    @Override
    public String getRole() {
        return "admin:" + permissionLevel;
    }
}
