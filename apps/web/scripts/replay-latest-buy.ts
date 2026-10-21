/**
 * One-off: replay the most recent Swap through the NEW buybot pipeline and
 * post to Telegram. Used to verify the market-cap fix (PR #115) end-to-end
 * without waiting for the cron + without merging.
 */

import { createPublicClient, http, parseAbiItem, type Address } from 'viem';
import { fetchUsdAnchors } from '../src/lib/buybot/oracle';
import { fetchAnchorEtxUsd, loadAllPairs, snapshotPool } from '../src/lib/buybot/scan';
import {
  computeBuyReport,
  decodeSwapAsBuy,
  type SwapEventArgs,
  type UsdPricing,
} from '../src/lib/buybot/prices';
import { formatBuy } from '../src/lib/buybot/format';
import { telegramClient } from '../src/lib/buybot/telegram';
import { loadBuyBotConfig } from '../src/lib/buybot/config';

const swapEvent = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

async function main() {
  process.env.BUYBOT_RPC_URL ??= 'https://eticamainnet.eticaprotocol.org';
  const config = loadBuyBotConfig();
  if (!config.enabled) {
    throw new Error(
      `Config disabled: token=${Boolean(config.telegramBotToken)} chat=${Boolean(config.telegramChatId)} rpc=${Boolean(config.rpcUrl)}`,
    );
  }

  const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 2 }) });

  const [latestBlock, anchors] = await Promise.all([
    client.getBlockNumber(),
    fetchUsdAnchors(config),
  ]);
  console.log('latestBlock=%s anchors=%o', latestBlock.toString(), anchors);

  const anchorEtxUsd = await fetchAnchorEtxUsd(client, {
    factory: config.factory,
    etx: config.etx,
    eti: config.eti,
    wegaz: config.wegaz,
    anchors,
  });
  console.log('anchorEtxUsd=%o', anchorEtxUsd);

  const pairs = await loadAllPairs(client, config.factory);
  console.log('loaded %d pairs', pairs.length);

  const fromBlock = latestBlock > 720n ? latestBlock - 720n : 0n;
  const logs = await client.getLogs({
    address: pairs,
    event: swapEvent,
    fromBlock,
    toBlock: latestBlock,
  });
  console.log(
    'found %d Swap logs in blocks %s..%s',
    logs.length,
    fromBlock.toString(),
    latestBlock.toString(),
  );

  if (logs.length === 0) {
    console.log('no recent swaps in the last ~1h window — make a /swap first and rerun');
    return;
  }

  const latest = logs[logs.length - 1];
  console.log(
    'replaying swap: tx=%s block=%s pair=%s',
    latest.transactionHash,
    latest.blockNumber,
    latest.address,
  );

  const pool = await snapshotPool(client, latest.address as Address, latest.blockNumber!);
  if (!pool) throw new Error('snapshotPool returned null');
  console.log(
    'pool snapshot: %s/%s reserves0After=%s reserves1After=%s',
    pool.token0.symbol,
    pool.token1.symbol,
    pool.reserve0After,
    pool.reserve1After,
  );

  const pricing: UsdPricing = {
    etxUsd: anchorEtxUsd,
    etiUsd: anchors.etiUsd,
    egazUsd: anchors.egazUsd,
  };
  console.log('pricing=%o', pricing);

  const args = latest.args as SwapEventArgs;
  const decoded = decodeSwapAsBuy(pool, args);
  if (!decoded) throw new Error('decodeSwapAsBuy returned null');

  const report = computeBuyReport(decoded, config.etx, config.eti, config.wegaz, pricing);
  console.log(
    'report: amountBought=%s amountSpent=%s notionalUsd=%o mcBoughtUsd=%o mcSpentUsd=%o',
    report.amountBought,
    report.amountSpent,
    report.notionalUsd,
    report.mcBoughtUsd,
    report.mcSpentUsd,
  );

  const message = formatBuy({
    decoded,
    report,
    txHash: latest.transactionHash!,
    blockNumber: latest.blockNumber!,
    explorerBaseUrl: config.explorerBaseUrl,
  });
  console.log('\n--- MESSAGE ---\n%s\n---------------\n', message.text);

  const tg = telegramClient(config.telegramBotToken, config.telegramChatId);
  const res = await tg.sendMessage(message);
  console.log('telegram res: %o', res);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
