"""The entry point that makes composition happen.

Everything in this package was reachable only from its own tests: `compose()` had no caller outside
them, no console script named it, and nothing imported it on start-up. The tools registered, the
dashboard rebound and the seams held — in the test suite. Installed alongside Serena and run the
normal way, none of it ever ran.

So JUNON is its own command. ``junon`` composes, then hands the process to Serena's own CLI
unchanged, which means every Serena argument, subcommand and flag keeps working and nothing here has
to track them. Running ``serena`` directly still gets plain Serena — that is the point of a separate
command rather than an import hook: what you type says which one you get, and a machine with this
package installed does not silently behave differently.
"""

from __future__ import annotations

import logging
import sys

log = logging.getLogger("junon")


def main() -> None:
    """Composes JUNON onto Serena, then runs Serena.

    The order is not negotiable. ``ToolRegistry`` is a cached singleton and Serena's agent resolves
    its dashboard class at construction time, so both are decided by whatever was true the first
    time they were touched. Composing after that point changes nothing and reports no error.
    """
    from junon.compose import compose

    result = compose()
    if not result.complete:
        # Reported, never fatal. A JUNON that could not attach is a Serena that still works, and
        # refusing to start would turn a cosmetic failure into an outage. What must not happen is
        # this passing unnoticed, which is exactly what happened before there was an entry point.
        logging.basicConfig(level=logging.INFO)
        log.warning(
            "JUNON attached incompletely: tools=%s dashboard=%s. Serena is running without the "
            "missing part; run the seam tests to see what upstream moved.",
            result.tools_package_added,
            result.dashboard_rebound,
        )

    from serena.cli import top_level

    top_level()


if __name__ == "__main__":
    sys.exit(main())
