// Runs inside the eti-pool-app container (web3 1.x). Reads the payments key from stdin so it never
// appears in process arguments. argv: rpc batchedPayments token dest amountWei
const Web3 = require('web3');
const [rpc, batched, token, dest, amount] = process.argv.slice(2);
let key = '';
process.stdin.on('data', (d) => (key += d));
process.stdin.on('end', async () => {
  const web3 = new Web3(rpc);
  const acct = web3.eth.accounts.privateKeyToAccount(key.trim().startsWith('0x') ? key.trim() : '0x' + key.trim());
  const data = web3.eth.abi.encodeFunctionCall(
    { name: 'send', type: 'function', inputs: [{ type: 'address', name: '_tokenAddr' }, { type: 'address', name: 'dest' }, { type: 'uint256', name: 'value' }] },
    [token, dest, amount],
  );
  const tx = { from: acct.address, to: batched, data, gas: 120000, gasPrice: web3.utils.toWei('20', 'gwei'), nonce: await web3.eth.getTransactionCount(acct.address, 'pending') };
  const signed = await acct.signTransaction(tx);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
  console.log(receipt.transactionHash, 'status', receipt.status);
  process.exit(receipt.status ? 0 : 1);
});
