// mongo shell script: total ETI (wei) the pool still owes miners = sum(alltimeTokenBalance - tokensReceived)
// over per-address minerData docs (worker docs duplicate their address and are skipped).
var total = 0;
db.minerData.find({ workerName: { $exists: false } }).forEach(function (m) {
  total += Math.max(0, Number(m.alltimeTokenBalance || 0) - Number(m.tokensReceived || 0));
});
print(total.toLocaleString('fullwide', { useGrouping: false }));
