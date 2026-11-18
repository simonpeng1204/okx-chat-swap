export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

function launchUrl(uri) {
  try {
    const url = new URL(uri);
    if (['https://www.okx.com', 'https://web3.okx.com', 'https://app.okx.com'].includes(url.origin)
        && !url.username && !url.password) return url.href;
  } catch {
    return null;
  }
  return null;
}

export function createWalletController({
  getPreview, getIcon, loadSdk, now = Date.now,
  reviewTransaction = () => null, onLaunchLink = () => {},
}) {
  let session = null;
  let busy = false;

  function target() {
    const preview = getPreview();
    const icon = getIcon();
    const time = now();
    if (!preview?.canConnect || !icon || !(preview.createdAt <= time && time < preview.expiresAt)) return null;
    return { preview, icon, recipient: preview.payload.binding.recipient };
  }

  function current({ preview, icon }) {
    const latest = target();
    return latest?.preview === preview && latest.icon === icon;
  }

  function account(solana) {
    try {
      return solana.getAccount(SOLANA_MAINNET)?.address;
    } catch {
      return null;
    }
  }

  function connected(selection) {
    return Boolean(session && session.preview === selection.preview
      && account(session.solana) === selection.recipient);
  }

  function reviewed(preview) {
    try {
      // The trusted reviewer must deserialize these exact bound bytes and check their instructions.
      const tx = reviewTransaction(preview.payload);
      return tx && typeof tx === 'object' && typeof tx.then !== 'function' ? tx : null;
    } catch {
      return null;
    }
  }

  function availability() {
    const selection = target();
    const matchingAccount = Boolean(selection && connected(selection));
    return {
      connect: Boolean(selection && !busy && !matchingAccount),
      sign: Boolean(!busy && matchingAccount && reviewed(selection.preview)),
      connected: matchingAccount,
      busy,
    };
  }

  async function connect() {
    const selection = target();
    if (busy || !selection || connected(selection)) throw new Error('Connection unavailable');
    busy = true;
    let universal;
    const showLink = uri => {
      const link = launchUrl(uri);
      if (link && current(selection)) onLaunchLink(link);
    };
    try {
      const { OKXUniversalProvider, OKXSolanaProvider } = await loadSdk();
      if (!current(selection)) throw new Error('Preview changed or expired');
      universal = await OKXUniversalProvider.init({
        dappMetaData: { name: 'Solana Swap Review', icon: selection.icon },
      });
      if (!current(selection)) throw new Error('Preview changed or expired');
      universal.on?.('display_uri', showLink);
      const walletSession = await universal.connect({
        namespaces: { solana: { chains: [SOLANA_MAINNET] } },
      });
      const solana = new OKXSolanaProvider(universal);
      const authorized = walletSession?.namespaces?.solana?.accounts;
      if (!current(selection) || !Array.isArray(authorized)
          || !authorized.includes(SOLANA_MAINNET + ':' + selection.recipient)
          || account(solana) !== selection.recipient) throw new Error('Wallet or preview mismatch');
      session = { preview: selection.preview, solana };
      return selection.recipient;
    } finally {
      universal?.off?.('display_uri', showLink);
      busy = false;
    }
  }

  async function sign() {
    const selection = target();
    if (busy || !selection || !connected(selection)) throw new Error('Signature unavailable');
    const tx = reviewed(selection.preview);
    if (!tx || !current(selection) || !connected(selection)) throw new Error('Transaction review required');
    busy = true;
    try {
      await session.solana.signTransaction(tx, SOLANA_MAINNET);
    } finally {
      busy = false;
    }
  }

  return { availability, connect, sign };
}
