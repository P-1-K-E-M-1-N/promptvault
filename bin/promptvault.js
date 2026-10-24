#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`PromptVault needs Node.js 22.13 or newer (you have ${process.versions.node}). Get it at nodejs.org.`);
  process.exit(1);
}

const { main } = await import('../src/cli.js');
main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
