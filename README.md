# OKX Solana swap review page

Static confirmation page for reviewing a Solana swap preview. You connect and confirm only in your own OKX Web3 wallet. This repository does not contain API keys, private keys, seed phrases, or personal wallet data.

Live site (GitHub Pages): https://simonpeng1204.github.io/okx-chat-swap/

## What this page does

- You paste or import a swap preview JSON and an independently provided SHA-256.
- The page checks chain, mints, amount, slippage, recipient, expiry, and the hash.
- Fixture, dry-run, expired, or mismatched previews cannot request a wallet signature.
- Signing stays locked until transaction-instruction review is enabled. The page has no broadcast or spend endpoint and does not perform quotes itself.

## What this page does not do

- It is not a live trading bot and does not place orders.
- Official DEX quotes, if used at all, are prepared separately on a controlled machine. Credentials never belong in this repository or on the page.
- A previous connection to the official OKX DEX website is not reused here. You must choose to connect.

## Build

Node 22+. Dependencies are pinned in `package-lock.json`.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build:pages -- okx-chat-swap
python3 scan_dist.py dist-pages
```

The `docs/` directory is the verified static publication used by GitHub Pages.
