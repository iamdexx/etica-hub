// Patch the deployed Etica addresses into configs/agent-config.json.
//
// Called by deploy-core.sh after `hyperlane core deploy` succeeds.
// Reads the YAML addresses.yaml file written by Hyperlane CLI, parses
// it, and overwrites `chains.etica.addresses.*` in agent-config.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import yaml from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentConfigPath = resolve(__dirname, '..', 'configs', 'agent-config.json');
const addressesYamlPath = process.argv[2];

if (!addressesYamlPath) {
  console.error('usage: _patch-agent-config.mjs <addresses.yaml>');
  process.exit(1);
}

const addresses = yaml.parse(readFileSync(addressesYamlPath, 'utf8'));
const config = JSON.parse(readFileSync(agentConfigPath, 'utf8'));

config.chains.etica.addresses = {
  mailbox: addresses.mailbox,
  interchainGasPaymaster: addresses.interchainGasPaymaster ?? addresses.igp ?? null,
  validatorAnnounce: addresses.validatorAnnounce,
  merkleTreeHook: addresses.merkleTreeHook,
};

writeFileSync(agentConfigPath, JSON.stringify(config, null, 2) + '\n');
console.log(`patched ${agentConfigPath}`);
