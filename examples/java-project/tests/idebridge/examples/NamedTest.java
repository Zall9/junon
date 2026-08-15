/**
 * IDE Bridge — Java fixture: JUnit-style test for rename references.
 *
 * This test references `User`, `AdminUser`, and `AbstractNamed` so
 * that renaming any of those must update this file too.
 */
package idebridge.examples;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for the Named hierarchy.
 */
public class NamedTest {

    @Test
    void userHasExpectedRole() {
        User user = new User("u1", "Alice", "editor");
        assertEquals("u1", user.getId());
        assertEquals("Alice", user.getDisplayName());
        assertEquals("editor", user.getRole());
    }

    @Test
    void adminRoleIncludesPermissionLevel() {
        AdminUser admin = new AdminUser("a1", "Bob", "full");
        assertEquals("admin:full", admin.getRole());
    }

    @Test
    void abstractNamedIsUsedPolymorphically() {
        AbstractNamed[] entities = {
            new User("u1", "Alice", "editor"),
            new AdminUser("a1", "Bob", "full"),
        };
        for (AbstractNamed entity : entities) {
            assertNotNull(entity.getId());
            assertNotNull(entity.getDisplayName());
            assertNotNull(entity.getRole());
        }
    }
}
