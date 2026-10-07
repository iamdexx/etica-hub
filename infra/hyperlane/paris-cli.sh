#!/usr/bin/env bash
# Prints the path of a Hyperlane CLI bundle whose embedded contract bytecode
# targets the Paris EVM, building it on first use.
#
# Etica runs CoreGeth without the Cancun fork: MCOPY, TSTORE/TLOAD and BASEFEE
# are invalid opcodes there. The stock @hyperlane-xyz/cli embeds creation
# bytecode compiled with `evm_version = cancun`, so `core deploy --chain etica`
# dies at the first contract creation (`invalid opcode: MCOPY`).
#
# This rebuilds the exact @hyperlane-xyz/core sources the CLI bundle was built
# from (version read out of the embedded Mailbox bytecode) with solc 0.8.33 /
# optimizer 10k / evm_version paris and swaps every `<Name>_factory_bytecode`
# constant in the bundle for the Paris artifact. Only the EVM target changes:
# same sources, same ABIs, same CLI logic.
#
# One source edit is needed for Paris: contracts/libs/TransientStorage.sol
# wraps tstore/tload. It is rewritten to sstore/sload. The only user in the
# contracts we deploy is ReentrancyGuardTransient (TokenRouter), whose guard
# sets and clears the slot inside the same call, so a persistent slot behaves
# identically (just costs more gas). The other users (OffchainQuoted*,
# AtomicLocalRebalancingBridge, Predicate wrappers) are not part of this route.
#
# Requires node >= 22 (npm), forge, python3, curl. Output is cached under
# $HYPERLANE_PARIS_DIR (default ~/.cache/eticahub-hyperlane-paris).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_VERSION="${HYPERLANE_CLI_VERSION:-44.0.2}"
CORE_VERSION="${HYPERLANE_CORE_VERSION:-12.1.0}"
SOLC_VERSION=0.8.33
EVM_VERSION=paris
DIR="${HYPERLANE_PARIS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/eticahub-hyperlane-paris}"
BUNDLE="$DIR/node_modules/@hyperlane-xyz/cli/bundle/index.js"
STAMP="$DIR/.built-cli$CLI_VERSION-core$CORE_VERSION-$EVM_VERSION"

# Contracts the core + warp deploy actually create on Etica; the build fails
# if any of them did not get a Paris artifact.
REQUIRED=Mailbox,TransparentUpgradeableProxy,ProxyAdmin,ValidatorAnnounce,MerkleTreeHook,ProtocolFee,TestRecipient
REQUIRED+=,StaticMerkleRootMultisigIsmFactory,StaticMessageIdMultisigIsmFactory,StaticAggregationIsmFactory,StaticAggregationHookFactory,DomainRoutingIsmFactory
REQUIRED+=,StaticMerkleRootWeightedMultisigIsmFactory,StaticMessageIdWeightedMultisigIsmFactory,InterchainAccountRouter
REQUIRED+=,HypERC20,HypERC20Collateral,PausableIsm,RateLimitedIsm,LinearFee
# CCIP hook/ISM need chainlink sources the core package does not ship; not used here.
ALLOW_MISSING=CCIPHook,CCIPIsm,test_TestLpCollateralRouter

log() { echo ">> paris-cli: $*" >&2; }

if [[ -f "$STAMP" && -f "$BUNDLE" ]]; then
  echo "$BUNDLE"; exit 0
fi

for bin in node npm forge python3 curl; do
  command -v "$bin" >/dev/null || { echo "paris-cli.sh: $bin is required" >&2; exit 1; }
done

rm -rf "$DIR"; mkdir -p "$DIR/core"
log "installing @hyperlane-xyz/cli@$CLI_VERSION into $DIR"
(cd "$DIR" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "@hyperlane-xyz/cli@$CLI_VERSION" >&2)
[[ -f "$BUNDLE" ]] || { echo "paris-cli.sh: CLI bundle not found at $BUNDLE" >&2; exit 1; }

embedded="$(python3 - "$BUNDLE" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'const Mailbox_factory_bytecode = "0x([0-9a-fA-F]+)"', src)
code = bytes.fromhex(m.group(1)) if m else b''
versions = set(re.findall(rb'\d{1,2}\.\d{1,2}\.\d{1,2}', code))
print(versions.pop().decode() if len(versions) == 1 else '')
PY
)"
[[ "$embedded" == "$CORE_VERSION" ]] || {
  echo "paris-cli.sh: CLI $CLI_VERSION embeds @hyperlane-xyz/core '$embedded', expected $CORE_VERSION (set HYPERLANE_CORE_VERSION)" >&2; exit 1; }

log "fetching @hyperlane-xyz/core@$CORE_VERSION sources"
curl -fsSL "https://registry.npmjs.org/@hyperlane-xyz/core/-/core-$CORE_VERSION.tgz" | tar xz -C "$DIR/core" --strip-components=1
[[ -d "$DIR/core/contracts" && -d "$DIR/core/dependencies" ]] || { echo "paris-cli.sh: core package layout changed" >&2; exit 1; }

# tstore/tload -> sstore/sload (see header).
sed -i -E 's/\btstore\(/sstore(/g; s/\btload\(/sload(/g' "$DIR/core/contracts/libs/TransientStorage.sol"
if grep -qE '\b(tstore|tload)\(' "$DIR/core/contracts/libs/TransientStorage.sol"; then
  echo "paris-cli.sh: transient-storage opcodes survived the rewrite" >&2; exit 1
fi
rm -f "$DIR/core/contracts/hooks/CCIPHook.sol" "$DIR/core/contracts/isms/hook/CCIPIsm.sol"

# Same remappings as hyperlane-monorepo/solidity/remappings.txt.
cat > "$DIR/core/foundry.toml" <<TOML
[profile.default]
src = 'contracts'
out = 'out'
libs = ['dependencies']
cache_path = 'forge-cache'
solc_version = '$SOLC_VERSION'
evm_version = '$EVM_VERSION'
optimizer = true
optimizer_runs = 10_000
remappings = [
  '@openzeppelin/contracts/=dependencies/@openzeppelin-contracts-4.9.3/contracts/',
  '@openzeppelin/contracts-upgradeable/=dependencies/@openzeppelin-contracts-upgradeable-4.9.3/contracts/',
  '@arbitrum/nitro-contracts/src/=dependencies/@arbitrum-nitro-contracts-1.2.1/src/',
  '@chainlink/contracts-ccip/src/v0.8/=dependencies/@chainlink-contracts-ccip-1.5.0/contracts/src/v0.8/',
  '@eth-optimism/contracts/=dependencies/@eth-optimism-contracts-0.6.0/packages/contracts/contracts/',
  '@predicate/=dependencies/@predicate-contracts-2.2.2/src/',
  'forge-std/=dependencies/forge-std-1.9.2/src/',
  'ds-test/=dependencies/forge-std-1.9.2/lib/ds-test/src/',
  'permit2/=dependencies/permit2-1.0.0/src/',
]
TOML

log "forge build (solc $SOLC_VERSION, evm $EVM_VERSION)"
(cd "$DIR/core" && forge build --quiet >&2) || (cd "$DIR/core" && forge build 2>&1 | grep -E '^Error|-->' >&2; exit 1)

log "patching bundle bytecode constants"
python3 "$HERE/paris/patch-bundle.py" "$DIR/core/out" "$BUNDLE" \
  "--allow-missing=$ALLOW_MISSING" "--require=$REQUIRED" | grep -v '^  ' >&2

touch "$STAMP"
echo "$BUNDLE"
