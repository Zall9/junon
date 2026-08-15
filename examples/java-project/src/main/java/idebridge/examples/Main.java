/**
 * IDE Bridge — Java fixture: usage site with multi-file references.
 *
 * `Main` references `User`, `AdminUser`, and `AbstractNamed` so that
 * rename operations must touch multiple files.
 */
package idebridge.examples;

/**
 * Entry point for the fixture. Not meant to be executed in production;
 * exists to create cross-file symbol references.
 */
public class Main {

    /**
     * @param args command-line arguments (unused).
     */
    public static void main(String[] args) {
        User user = new User("u1", "Alice", "editor");
        AdminUser admin = new AdminUser("a1", "Bob", "full");

        printNamed(user);
        printNamed(admin);
    }

    /**
     * Print any {@link Named} entity.
     *
     * @param named the entity to print.
     */
    public static void printNamed(Named named) {
        System.out.println(named.getId() + ": " + named.getDisplayName());
    }
}
