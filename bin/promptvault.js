#!/usr/bin/env node
// Needs a Node whose built-in SQLite has full-text search (FTS5): 22.23+ or 24+.
// (22.13 and 23.x ship node:sqlite without FTS5.)
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 23) || major === 23) {
  console.error(`PromptVault needs Node.js 22.23+ or 24+ (you have ${process.versions.node}). Get it at nodejs.org.`);
  process.exit(1);
}

const { main } = await import('../src/cli.js');
main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
