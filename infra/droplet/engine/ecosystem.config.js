const script = (name) => ({ name, script: `./${name}.js`, autorestart: true, max_memory_restart: '400M' });
module.exports = {
  apps: [
    script('SynchronizeBlocks'),
    script('SynchronizeMissedTxs'),
    script('SynchronizeTxsFailures'),
    script('DataTablesEngine'),
    script('OptimisersCrons'),
    script('api-server'),
  ],
};
