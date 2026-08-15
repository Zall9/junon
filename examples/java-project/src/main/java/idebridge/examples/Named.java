/**
 * IDE Bridge — Java fixture: public interface.
 *
 * Defines a contract that abstract and concrete classes implement.
 */
package idebridge.examples;

/**
 * Contract for a named entity that can report a display name.
 */
public interface Named {

    /**
     * @return the stable identifier.
     */
    String getId();

    /**
     * @return a human-readable display name.
     */
    String getDisplayName();
}
