const [major, minor] = process.versions.node.split(".").map((value) => Number.parseInt(value, 10));

const isSupported = major > 20 && major < 23 || (major === 20 && minor >= 9);

if (isSupported) {
  process.exit(0);
}

const target = process.argv[2] ?? "this workspace";

console.error(
  [
    `${target} requires Node.js 20.9 through 22.x.`,
    `Detected ${process.versions.node}.`,
    "Use a supported runtime before starting dev/build tasks.",
    "Suggested options:",
    "- if you use nvm: nvm use",
    "- otherwise install/use Node 22 LTS explicitly",
  ].join("\n"),
);

process.exit(1);
