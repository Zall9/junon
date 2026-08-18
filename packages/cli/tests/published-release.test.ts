import { describe, expect, it } from "vitest";

import { DAEMON_VERSION } from "@ide-bridge/bridge-daemon";

import { parseCliArguments } from "../src/arguments.js";
import { publishedCheck } from "../src/doctor.js";

/**
 * The one check in this product that leaves the machine.
 *
 * Every other comparison is between things already installed here, which is why none of them can see
 * a release nobody has fetched: a daemon, a CLI and three plugins all at 0.2.1 agree with each other,
 * and agreement is what they report, however long 0.2.4 has been published.
 *
 * So these tests are as much about restraint as about the fetch. It happens when the flag is passed
 * and at no other time; it never turns a doctor run red because the wifi is down; and it never claims
 * to be current when it could not ask.
 */

const repository = (version: string): string =>
  `<plugins><plugin id="com.idebridge.jetbrains" version="${version}"/></plugins>`;

const answering = (body: string, ok = true, status = 200): typeof fetch =>
  (async () =>
    ({
      ok,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;

describe("the published release check", () => {
  it("names the newer release and what to do about it", async () => {
    const check = await publishedCheck("https://example.invalid", answering(repository("99.0.0")));

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("99.0.0");
    // The remedy starts with the reader's own step: nothing in this product downloads a release, so
    // a message that implied otherwise would send someone to press Install and wonder why the
    // version did not move.
    expect(check.detail).toContain("git pull");
  });

  it("passes when this build is the published one", async () => {
    const check = await publishedCheck(
      "https://example.invalid",
      answering(repository(DAEMON_VERSION)),
    );

    expect(check.status).toBe("pass");
  });

  it("says nothing when this build is ahead of the repository", async () => {
    // A checkout mid-release is newer than what is published. Normal, and not a finding.
    const check = await publishedCheck("https://example.invalid", answering(repository("0.0.1")));

    expect(check.status).toBe("pass");
  });

  it("skips rather than fails when the repository cannot be reached", async () => {
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const check = await publishedCheck("https://example.invalid", offline);

    // A laptop on a train has nothing wrong with its installation. A doctor that goes red when the
    // network is down is a doctor people learn to ignore.
    expect(check.status).toBe("skip");
    expect(check.detail).toBe("repository-unreachable");
  });

  it("does not read a captive portal as a release", async () => {
    const check = await publishedCheck(
      "https://example.invalid",
      answering("<html>Sign in to the hotel wifi</html>"),
    );

    expect(check.status).toBe("skip");
    expect(check.detail).toBe("no-release-advertised");
  });

  it("does not read an error page as a release", async () => {
    const check = await publishedCheck("https://example.invalid", answering("nope", false, 404));

    expect(check.status).toBe("skip");
    expect(check.detail).toContain("404");
  });
});

describe("--check-updates", () => {
  it("is off unless it is typed", () => {
    expect(parseCliArguments(["doctor"]).checkUpdates).toBe(false);
  });

  it("is on when it is typed", () => {
    expect(parseCliArguments(["doctor", "--check-updates"]).checkUpdates).toBe(true);
  });

  it("is refused on a command that would ignore it", () => {
    // Accepting it on `status` would leave someone believing they had checked for updates.
    expect(() => parseCliArguments(["status", "--check-updates"])).toThrow();
  });
});
