# test/…/service/

## Responsibility

Tests for the seam where the protocol meets IntelliJ: linking a project, preparing and applying
edits, and refusing when the IDE cannot be trusted to answer.

## Design

**Each file pins a failure that actually happened.** `ProjectLinkTest` exists because a link could
fail silently and the readiness state disagreed with reality; `RenameAcrossFilesTest` because every
earlier rename test renamed within one file and four defects lived in the cross-file path;
`UnindexedProjectTest` because an unindexed search answered emptily instead of saying so.

**The fixture names its own daemon.** An earlier version used the real default discovery path and
passed or failed depending on whether a daemon happened to be running on the machine. Naming the path
is what makes an outcome this code's rather than the machine's.

**Some rules cannot be tested here, and say so rather than pretending.** `BasePlatformTestCase` runs
on an in-memory file system, so a rule about edits made on disk outside the IDE is verified against a
real IDE and recorded in `docs/DEMO.md` — a test that cannot exercise its rule while looking like
proof is worse than none.

## Flow

```
ProjectLinkTest              refusal is typed and repeatable; a dead session releases its link;
                             an empty discovery override configures nothing
RenameAcrossFilesTest        a precondition per changed document; every changed document reported;
                             a stale plan refused before anything is written; changes announced
QuickFixPlanTest             preparing writes nothing; applying refuses an offer that has gone
UnindexedProjectTest         an index that cannot answer says so
DocumentChangeAnnouncerTest  a burst of typing announces once, and only after it stops
```

## Integration

`ProjectLinkTest` and `RenameAcrossFilesTest` need Node and a built CLI for their real-daemon halves;
without them the test says it skipped rather than passing quietly.
