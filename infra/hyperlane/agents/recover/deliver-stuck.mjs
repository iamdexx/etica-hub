// Deliver one stuck Ethereum -> Etica warp transfer by hand.
// Signs the missing message-id checkpoint with the validator key (only when the
// on-chain merkle tree hook confirms root + index at the dispatch block), then
// calls Mailbox.process on Etica from the relayer key. Every step is gated:
// message id match, signer == ISM validator, ISM.verify, simulate.
//   TX=<ethereum dispatch tx> [DRY=1] node deliver-stuck.mjs
// Run on the droplet (see docs/HYPERLANE_USDC_RUNBOOK.md, Operations).
import { createPublicClient, createWalletClient, http, defineChain, concatHex, toHex, stringToHex, keccak256, parseAbi, parseSignature, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

const ETH_RPC = process.env.ETH_RPC || 'https://gateway.tenderly.co/public/mainnet';
const ETI_RPC = process.env.ETI_RPC || 'https://rpc.eticahub.com';
const SIG_DIR = process.env.SIG_DIR || '/sig';
const ETH_MAILBOX = '0xc005dc82818d67af737725bd4bf75435d065d239';
const HOOK = '0x48e6c30b97748d1e2e03bf3e9fbe3890ca5f8cca';
const HOOK32 = `0x${HOOK.slice(2).padStart(64, '0')}`;
const DISPATCH = '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814';
const INSERTED = '0x253a3a04cab70d47c1504809242d9350cd81627b4f1d50753e159cf8cd76ed33';
const MAILBOX = '0x9E0aFCF74FF2B0E9F7b6318ad6Ab0DC929Ef22ec';
const ROUTER = '0x0BA5C0BFd034639330d2CF9DBAD354d8DBc2d335';

const etica = defineChain({ id: 61803, name: 'Etica', nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 }, rpcUrls: { default: { http: [ETI_RPC] } } });
const eth = createPublicClient({ transport: http(ETH_RPC) });
const pub = createPublicClient({ chain: etica, transport: http() });
const abi = parseAbi([
  'function process(bytes metadata, bytes message)',
  'function delivered(bytes32) view returns (bool)',
  'function verify(bytes metadata, bytes message) view returns (bool)',
  'function interchainSecurityModule() view returns (address)',
  'function modulesAndThreshold(bytes) view returns (address[], uint8)',
  'function validatorsAndThreshold(bytes) view returns (address[], uint8)',
  'function latestCheckpoint() view returns (bytes32, uint32)',
]);
const key = (k) => privateKeyToAccount(k.startsWith('0x') ? k : `0x${k}`);
const die = (m) => { console.error(m); process.exit(1); };

const rc = await eth.getTransactionReceipt({ hash: process.env.TX });
const disp = rc.logs.find((l) => l.address.toLowerCase() === ETH_MAILBOX && l.topics[0] === DISPATCH);
const ins = rc.logs.find((l) => l.address.toLowerCase() === HOOK && l.topics[0] === INSERTED);
if (!disp || !ins) die('no Dispatch / InsertedIntoTree in this tx');
const len = parseInt(disp.data.slice(66, 130), 16);
const message = `0x${disp.data.slice(130, 130 + len * 2)}`;
const id = keccak256(message);
const index = parseInt(ins.data.slice(66), 16);
if (`0x${ins.data.slice(2, 66)}` !== id) die('insertion id != message id');
console.log('message', id, 'leaf index', index);
if (await pub.readContract({ address: MAILBOX, abi, functionName: 'delivered', args: [id] })) { console.log('already delivered'); process.exit(0); }

const ism = await pub.readContract({ address: ROUTER, abi, functionName: 'interchainSecurityModule' });
const [modules] = await pub.readContract({ address: ism, abi, functionName: 'modulesAndThreshold', args: ['0x'] });
if (modules.length !== 2) die(`expected multisig + pausable, got ${modules.length} modules`);
const [validators] = await pub.readContract({ address: modules[0], abi, functionName: 'validatorsAndThreshold', args: ['0x'] });
const validator = validators[0].toLowerCase();

const file = `${SIG_DIR}/${index}_with_id.json`;
let cp = fs.existsSync(file) && fs.statSync(file).size > 0 ? JSON.parse(fs.readFileSync(file)) : null;
if (!cp) {
  const [root, latest] = await eth.readContract({ address: HOOK, abi, functionName: 'latestCheckpoint', blockNumber: rc.blockNumber });
  if (latest !== index) die(`hook index at block ${rc.blockNumber} is ${latest}, not ${index}: another insertion followed in the same block, rebuild the root by hand`);
  if (!process.env.VALIDATOR_KEY) die('missing checkpoint and no VALIDATOR_KEY');
  const v = key(process.env.VALIDATOR_KEY);
  if (v.address.toLowerCase() !== validator) die(`VALIDATOR_KEY is ${v.address}, ISM wants ${validator}`);
  const domain = keccak256(concatHex([toHex(1, { size: 4 }), HOOK32, stringToHex('HYPERLANE')]));
  const digest = keccak256(concatHex([domain, root, toHex(index, { size: 4 }), id]));
  const sig = await v.signMessage({ message: { raw: digest } });
  if ((await recoverMessageAddress({ message: { raw: digest }, signature: sig })).toLowerCase() !== validator) die('signature does not recover');
  const p = parseSignature(sig);
  cp = { value: { checkpoint: { merkle_tree_hook_address: HOOK32, mailbox_domain: 1, root, index }, message_id: id }, signature: { r: p.r, s: p.s, v: Number(p.v) }, serialized_signature: sig };
  if (!process.env.DRY) { fs.writeFileSync(`${file}.tmp`, JSON.stringify(cp, null, 2)); fs.renameSync(`${file}.tmp`, file); console.log('wrote', file); }
}
if (cp.value.message_id !== id) die('checkpoint file is for another message');

// Aggregation metadata: [start0,end0,start1,end1] then multisig metadata; pausable gets an empty range.
const m0 = concatHex([HOOK32, cp.value.checkpoint.root, toHex(cp.value.checkpoint.index, { size: 4 }), cp.serialized_signature]);
const e0 = 16 + (m0.length - 2) / 2;
const metadata = concatHex([toHex(16, { size: 4 }), toHex(e0, { size: 4 }), toHex(e0, { size: 4 }), toHex(e0, { size: 4 }), m0]);
if (!(await pub.readContract({ address: ism, abi, functionName: 'verify', args: [metadata, message] }))) die('ISM rejects metadata');

if (!process.env.RELAYER_KEY) die('no RELAYER_KEY');
const acct = key(process.env.RELAYER_KEY);
const args = [metadata, message];
const { request } = await pub.simulateContract({ account: acct, address: MAILBOX, abi, functionName: 'process', args });
const gas = (await pub.estimateContractGas({ account: acct, address: MAILBOX, abi, functionName: 'process', args })) * 2n;
let gasPrice = await pub.getGasPrice();
const cap = (9n * 10n ** 17n) / gas; // Etica nodes reject a fee over 1 EGAZ
if (gasPrice > cap) gasPrice = cap;
console.log('simulation ok, gas', gas, 'gasPrice', gasPrice);
if (process.env.DRY) process.exit(0);
const hash = await createWalletClient({ account: acct, chain: etica, transport: http() }).writeContract({ ...request, type: 'legacy', gas, gasPrice });
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
console.log('tx', hash, r.status, 'delivered', await pub.readContract({ address: MAILBOX, abi, functionName: 'delivered', args: [id] }));
