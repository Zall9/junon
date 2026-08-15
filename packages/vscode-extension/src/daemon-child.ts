import { runCli } from "@ide-bridge/cli";

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  process.exitCode = exitCode;
}

void main();
