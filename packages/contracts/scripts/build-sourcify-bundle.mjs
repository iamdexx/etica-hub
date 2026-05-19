#!/usr/bin/env node
// Build the canonical Sourcify standard-input.json for a Foundry-built
// contract by walking its imports from disk + resolving foundry.toml
// remappings. Writes
//   sourcify-bundles/<ContractName>/standard-input.json
// plus a sibling info.json with compiler settings.
//
// Usage:
//   node scripts/build-sourcify-bundle.mjs <relative/path/Source.sol> <ContractName>
//
// Run from packages/contracts/.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FOUNDRY_TOML = path.join(ROOT, 'foundry.toml');

function parseFoundry() {
  const toml = fs.readFileSync(FOUNDRY_TOML, 'utf8');
  const remap = [];
  const mRemap = toml.match(/remappings\s*=\s*\[([\s\S]*?)\]/);
  if (mRemap) {
    const inner = mRemap[1];
    for (const line of inner.split('\n')) {
      const m = line.match(/"([^"]+)"/);
      if (m) {
        const [from, to] = m[1].split('=');
        if (to) remap.push({ from, to: to.replace(/\/$/, '/') });
      }
    }
  }
  const get = (key) => {
    const re = new RegExp(`^${key}\\s*=\\s*"?([^"\n]+)"?`, 'm');
    const m = toml.match(re);
    return m ? m[1].trim() : null;
  };
  const getBool = (key) => {
    const v = get(key);
    if (v === null) return null;
    return v === 'true';
  };
  const getNum = (key) => {
    const v = get(key);
    if (v === null) return null;
    return Number(v);
  };
  return {
    remappings: remap,
    solcVersion: get('solc_version') || '0.8.26',
    evmVersion: get('evm_version') || 'paris',
    optimizer: getBool('optimizer') !== false,
    optimizerRuns: getNum('optimizer_runs') ?? 200,
    viaIR: getBool('via_ir') === true,
    bytecodeHash: get('bytecode_hash') || 'ipfs',
    cborMetadata: getBool('cbor_metadata'),
  };
}

// Sourcify's verify endpoint requires the long-form solc version
// (e.g. `0.8.26+commit.8a97fa7a`). Extend this table when bumping
// foundry.toml's `solc_version`. Source: binaries.soliditylang.org/bin/list.json.
const SOLC_LONG_VERSIONS = {
  '0.8.20': '0.8.20+commit.a1b79de6',
  '0.8.21': '0.8.21+commit.d9974bed',
  '0.8.22': '0.8.22+commit.4fc1097e',
  '0.8.23': '0.8.23+commit.f704f362',
  '0.8.24': '0.8.24+commit.e11b9ed9',
  '0.8.25': '0.8.25+commit.b61c2a91',
  '0.8.26': '0.8.26+commit.8a97fa7a',
  '0.8.27': '0.8.27+commit.40a35a09',
  '0.8.28': '0.8.28+commit.7893614a',
  '0.8.29': '0.8.29+commit.ab55807c',
};

function resolveImport(spec, importerPath, remappings) {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = path.dirname(importerPath);
    return path.normalize(path.join(base, spec)).split(path.sep).join('/');
  }
  for (const { from, to } of remappings) {
    if (spec.startsWith(from)) return (to + spec.slice(from.length)).split(path.sep).join('/');
  }
  // assume project-relative
  return spec.split(path.sep).join('/');
}

function walk(start, remappings) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    const abs = path.join(ROOT, cur);
    if (!fs.existsSync(abs)) {
      console.error(`! missing source ${cur} (skipping)`);
      continue;
    }
    seen.add(cur);
    let src = fs.readFileSync(abs, 'utf8');
    // Strip block + line comments so import-matching doesn't get fooled by
    // the word "import" inside NatSpec.
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Match `import "X";` and `import ... from "X";`
    const re = /(?:^|;|\n|\s)import[^'"]*?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const resolved = resolveImport(m[1], cur, remappings);
      stack.push(resolved);
    }
  }
  return [...seen].sort();
}

function buildStandardInput(sources, cfg) {
  const sourcesObj = {};
  for (const p of sources) {
    sourcesObj[p] = { content: fs.readFileSync(path.join(ROOT, p), 'utf8') };
  }
  const settings = {
    optimizer: { enabled: cfg.optimizer, runs: cfg.optimizerRuns },
    evmVersion: cfg.evmVersion,
    viaIR: cfg.viaIR,
    metadata: {
      bytecodeHash: cfg.bytecodeHash === 'none' ? 'none' : cfg.bytecodeHash,
      appendCBOR: cfg.cborMetadata !== false,
    },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'],
      },
    },
  };
  return { language: 'Solidity', sources: sourcesObj, settings };
}

function main() {
  const [, , entry, contractName] = process.argv;
  if (!entry || !contractName) {
    console.error('Usage: node scripts/build-sourcify-bundle.mjs <path/Source.sol> <ContractName>');
    process.exit(1);
  }
  const cfg = parseFoundry();
  console.error(`solc ${cfg.solcVersion}, evm=${cfg.evmVersion}, optimizer=${cfg.optimizer}(${cfg.optimizerRuns}), bytecodeHash=${cfg.bytecodeHash}`);
  const sources = walk(entry, cfg.remappings);
  console.error(`resolved ${sources.length} sources for ${entry}`);
  const stdInput = buildStandardInput(sources, cfg);

  const outDir = path.join(ROOT, 'sourcify-bundles', contractName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'standard-input.json'),
    JSON.stringify(stdInput, null, 2) + '\n',
  );
  const longVersion = SOLC_LONG_VERSIONS[cfg.solcVersion] || cfg.solcVersion;
  const info = {
    contractIdentifier: `${entry}:${contractName}`,
    compilerVersion: longVersion,
    compilerShortVersion: cfg.solcVersion,
    evmVersion: cfg.evmVersion,
    optimizer: { enabled: cfg.optimizer, runs: cfg.optimizerRuns },
    sourceCount: sources.length,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'info.json'), JSON.stringify(info, null, 2) + '\n');
  console.error(`wrote ${path.relative(ROOT, outDir)}/{standard-input.json,info.json}`);
}

main();
