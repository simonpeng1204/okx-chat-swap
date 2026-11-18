import { inspectPreview, reviewedTransactionBytes } from './confirmation.mjs';
import { findPublicIcon } from './hosting.mjs';
import { createWalletController, SOLANA_MAINNET } from './wallet.mjs';
import { deployment } from './deployment.mjs';

const labels = {
  dry_run: '离线预览已核验。等待有效的 OKX 报价和未签名交易。',
  fixture: '测试夹具已核验。报价和交易材料均为合成数据。',
  fixture_material: '发现测试材料，钱包操作已锁定。',
  quote_only: '报价预览哈希已核验。等待绑定的未签名交易。',
  unsigned_unreviewed: '预览哈希与绑定字段已核验。未签名交易仍需指令语义审查。',
  unsigned_rejected: '未签名交易未通过指令审查，钱包操作已锁定。',
  unsigned_reviewed: '未签名交易已通过离线指令审查。区块哈希新鲜度未链上验证。',
  expired: '预览已过期。请向父代理获取新预览和新哈希。',
  hash_required: '请输入父代理独立提供的 64 位 SHA-256 哈希。',
  hash_mismatch: '哈希不匹配。请向父代理重新核对预览和原始哈希。',
  clock: '本机时间早于预览生成时间。请核对系统时钟。',
  invalid: '预览结构或绑定字段无效。请导入父代理生成的完整 JSON。',
};

const $ = id => document.getElementById(id);
const connectButton = $('connect');
const signButton = $('sign');
const launch = $('launch');
let selection = null;
let icon = null;
let inputRevision = 0;
let walletMessage = '';

const wallet = createWalletController({
  getPreview: () => selection,
  getIcon: () => icon,
  loadSdk: () => import('./wallet-sdk.mjs'),
  reviewTransaction: (_payload, reviewed) => reviewedTransactionBytes(reviewed),
  onLaunchLink(url) {
    launch.href = url;
    launch.hidden = false;
  },
});

function text(id, value) {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
}

function closeLaunchLink() {
  if (!launch.hidden) {
    launch.hidden = true;
    launch.removeAttribute('href');
  }
}

function refresh() {
  const state = wallet.availability();
  const now = Date.now();
  const expired = now >= selection?.expiresAt;
  const tooEarly = now < selection?.createdAt;
  if (!state.busy || !selection || expired || tooEarly) closeLaunchLink();

  connectButton.disabled = !state.connect;
  signButton.disabled = !state.sign;
  if (selection) {
    const label = labels[expired ? 'expired' : tooEarly ? 'clock' : selection.status];
    const reason = !expired && !tooEarly && selection.semantics?.reasons[0];
    text('review-status', reason ? label + ' ' + reason : label);
  }
  if (selection?.expiresAt) {
    const seconds = Math.max(0, Math.ceil((selection.expiresAt - now) / 1000));
    text('countdown', tooEarly ? '' : seconds ? '剩余 ' + seconds + ' 秒' : '已过期');
  }
  let status = '尚不可连接。需要已配置的公网 HTTPS 页面和可访问的 PNG 图标。';
  if (icon) {
    status = '公网源站和图标可用。等待有效的未签名预览。';
    if (expired) status = '预览已过期，钱包操作已锁定。';
    else if (tooEarly) status = '请核对系统时钟。';
    else if (state.busy) status = '等待 OKX 钱包响应。';
    else if (walletMessage) status = walletMessage;
    else if (state.connected) status = '钱包地址已匹配。可手动请求签名。';
    else if (state.connect) status = '可手动连接 OKX 钱包。';
  }
  text('wallet-status', status);
}

function showBinding(result) {
  const details = $('details');
  details.hidden = !result?.payload;
  $('empty-details').hidden = !details.hidden;
  if (details.hidden) return;

  const { binding, source, quote, unsigned } = result.payload;
  const route = unsigned?.routerResult ?? quote;
  const fieldValues = {
    source: { dry_run: '离线 dry-run', fixture: '测试夹具', okx_dex_api: 'OKX DEX API' }[source] ?? '未知来源',
    network: 'Solana 主网 / ' + binding.chainIndex,
    'chain-id': SOLANA_MAINNET,
    mode: binding.swapMode,
    'from-mint': binding.fromMint,
    'to-mint': binding.toMint,
    amount: binding.amountHuman,
    'amount-raw': binding.amountRaw,
    decimals: String(binding.fromDecimals),
    recipient: binding.recipient,
    slippage: binding.slippagePercent + '%',
    'to-amount': route?.toTokenAmount ? route.toTokenAmount + '（最小单位）' : '未提供',
    'min-amount': unsigned?.tx?.minReceiveAmount ? unsigned.tx.minReceiveAmount + '（最小单位）' : '未提供',
    impact: route?.priceImpactPercent != null ? route.priceImpactPercent + '%' : '未提供',
    'created-at': binding.createdAt,
    'expires-at': binding.expiresAt,
    digest: result.sha256,
  };
  for (const [id, value] of Object.entries(fieldValues)) text(id, value);
}

function clearSelection() {
  inputRevision++;
  selection = null;
  walletMessage = '';
  closeLaunchLink();
  showBinding(null);
  text('countdown', '');
  text('review-status', '等待预览 JSON 和独立 SHA-256 哈希。');
  refresh();
}

$('preview-json').addEventListener('input', clearSelection);
$('pinned-hash').addEventListener('input', clearSelection);
$('preview-file').addEventListener('change', async event => {
  clearSelection();
  const revision = inputRevision;
  const file = event.currentTarget.files[0];
  event.currentTarget.value = '';
  if (!file) return;
  try {
    if (file.size > 250_000) throw new Error('Invalid size');
    const contents = await file.text();
    if (revision === inputRevision) {
      $('preview-json').value = contents;
      text('review-status', '文件已导入。请核验预览。');
    }
  } catch {
    if (revision === inputRevision) text('review-status', '无法读取 JSON 文件。请检查文件大小和格式。');
  }
});

$('review-form').addEventListener('submit', async event => {
  event.preventDefault();
  clearSelection();
  const revision = inputRevision;
  const inspected = await inspectPreview($('preview-json').value, $('pinned-hash').value.trim());
  if (revision !== inputRevision) return;
  selection = inspected;
  showBinding(inspected);
  refresh();
});

async function requestWallet(event, action, success, failure) {
  if (!event.isTrusted || event.currentTarget.disabled) return;
  const revision = inputRevision;
  walletMessage = '';
  try {
    const pending = action();
    refresh();
    await pending;
    if (revision === inputRevision) walletMessage = success;
  } catch {
    if (revision === inputRevision) walletMessage = failure;
  } finally {
    refresh();
  }
}

connectButton.addEventListener('click', event => requestWallet(event, wallet.connect,
  '',
  '连接未完成。请检查 OKX App、钱包地址和预览有效期。'));
signButton.addEventListener('click', event => requestWallet(event, wallet.sign,
  '钱包已返回签名结果。页面未发送链上交易。',
  '签名未完成。请重新核对预览、交易审查和钱包账户。'));
launch.addEventListener('click', event => {
  const now = Date.now();
  if (!event.isTrusted || !selection || now < selection.createdAt || now >= selection.expiresAt
      || !wallet.availability().busy) event.preventDefault();
});

refresh();
setInterval(refresh, 1000);
findPublicIcon(location.href, deployment).then(url => {
  icon = url;
  refresh();
});
