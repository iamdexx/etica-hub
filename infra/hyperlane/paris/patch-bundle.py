#!/usr/bin/env python3
"""Replace the creation bytecode constants embedded in a Hyperlane CLI bundle
with artifacts from a forge build (used to target a pre-Cancun EVM).

usage: patch-bundle.py <forge-out-dir> <bundle/index.js>
         [--allow-missing=a,b] [--require=c,d]

Every `const <Name>_factory_bytecode = "0x..."` in the bundle is replaced by
the forge artifact of the same contract name. Exits non-zero when a constant
has no artifact (unless allow-listed) or when a required contract was not
patched, so a CLI/core version drift fails the build instead of the deploy.
"""
import json, os, re, sys, glob

out_dir, bundle_path = sys.argv[1], sys.argv[2]
allow_missing, require = set(), set()
for arg in sys.argv[3:]:
    key, _, val = arg.partition('=')
    names = set(filter(None, val.split(',')))
    if key == '--allow-missing':
        allow_missing |= names
    elif key == '--require':
        require |= names
    else:
        sys.exit(f'unknown argument {arg}')
only = None

arts = {}
for f in glob.glob(os.path.join(out_dir, '**', '*.json'), recursive=True):
    name = os.path.splitext(os.path.basename(f))[0]
    sol = os.path.basename(os.path.dirname(f))
    if not sol.endswith('.sol'):
        continue
    try:
        d = json.load(open(f))
    except Exception:
        continue
    bc = d.get('bytecode', {})
    obj = bc.get('object')
    if not obj or obj == '0x':
        continue
    arts.setdefault(name, []).append((sol, obj, bc.get('linkReferences') or {}))

src = open(bundle_path, encoding='utf-8').read()
pat = re.compile(r'const (\w+)_factory_bytecode = "(0x[0-9a-fA-F]+)"')
patched, skipped, missing, ambiguous, linked = [], [], [], [], []

def repl(m):
    name, old = m.group(1), m.group(2)
    if only is not None and name not in only:
        skipped.append(name); return m.group(0)
    cands = arts.get(name)
    if not cands:
        missing.append(name); return m.group(0)
    if len(cands) > 1:
        # prefer the artifact whose file is named after the contract
        exact = [c for c in cands if c[0] == name + '.sol']
        if len(exact) != 1:
            ambiguous.append((name, [c[0] for c in cands])); return m.group(0)
        cands = exact
    sol, new, links = cands[0]
    if links:
        linked.append(name); return m.group(0)
    patched.append((name, len(old) // 2, len(new) // 2))
    return f'const {name}_factory_bytecode = "{new}"'

new_src = pat.sub(repl, src)
open(bundle_path, 'w', encoding='utf-8').write(new_src)
print(f'patched {len(patched)} bytecode constants; skipped {len(skipped)}; no artifact {len(missing)}; ambiguous {len(ambiguous)}; needs linking {len(linked)}')
for n, a, b in patched[:400]:
    print(f'  {n}: {a} -> {b} bytes')
if missing: print('MISSING:', ','.join(missing))
if ambiguous: print('AMBIGUOUS:', ambiguous)
if linked: print('LINKED:', linked)
patched_names = {n for n, _, _ in patched}
unexpected_missing = set(missing) - allow_missing
unmet = require - patched_names
if unexpected_missing or ambiguous or linked or unmet:
    print(f'FAILED: unexpected missing={sorted(unexpected_missing)} unmet required={sorted(unmet)}')
    sys.exit(1)
