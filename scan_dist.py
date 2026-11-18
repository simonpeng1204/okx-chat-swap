"""Check the static publication manifest and look for credential material."""
import argparse
from pathlib import Path
import re
import struct

EXPECTED_FILES = {
    '.nojekyll', 'index.html', 'styles.css', 'icon.png', 'app.mjs', 'confirmation.mjs',
    'hosting.mjs', 'wallet.mjs', 'wallet-sdk.mjs', 'deployment.mjs', 'semantics.mjs', 'solana-wire.mjs',
}
FIRST_PARTY_PATTERNS = {
    'OKX authentication labels': rb'OK-ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP|PROJECT)|OKX_(?:API_KEY|SECRET_KEY|API_PASSPHRASE|PROJECT_ID)',
    'private key PEM': rb'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----',
    'hex signing key literal': rb"""['"`](?:0x)?[a-f0-9]{64}['"`]""",
    'Base58 or Base64 secret-key literal': rb"""['"`](?:[1-9A-HJ-NP-Za-km-z]{85,90}|[A-Za-z0-9+/]{86}==)['"`]""",
    '64-byte key array': rb'\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]',
    'seed phrase literal': rb"""['"`](?:[a-z]{2,14} ){11}(?:(?:[a-z]{2,14} ){3}){0,4}[a-z]{2,14}['"`]""",
    'literal secret assignment': rb"""\b(?:api[ _-]?secret|secret[ _-]?key|api[ _-]?key|private[ _-]?key|secret[ _-]?phrase|seed[ _-]?phrase|mnemonic|passphrase)['"]?\s*[:=]\s*['"`][^'"`\r\n]{8,}['"`]""",
    'fixture or embedded wallet marker': rb'FIXTURE_(?:UNSIGNED|SECRET|INPUT|OUTPUT)|22222222222222222222222222222222222222222222',
}
# Official OKX Connect bundle includes public Ed25519 curve constants and English
# error sentences that trip naive hex/seed patterns. Still reject real secrets.
VENDOR_PATTERNS = {
    'OKX authentication labels': FIRST_PARTY_PATTERNS['OKX authentication labels'],
    'private key PEM': FIRST_PARTY_PATTERNS['private key PEM'],
    'Base58 or Base64 secret-key literal': FIRST_PARTY_PATTERNS['Base58 or Base64 secret-key literal'],
    '64-byte key array': FIRST_PARTY_PATTERNS['64-byte key array'],
    'literal secret assignment': FIRST_PARTY_PATTERNS['literal secret assignment'],
    'fixture or embedded wallet marker': FIRST_PARTY_PATTERNS['fixture or embedded wallet marker'],
    'github token': rb'\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{10,}',
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    folder = args.directory
    if folder.is_symlink() or not folder.is_dir():
        parser.error('provide a built static directory')
    entries = sorted(folder.iterdir())
    if {path.name for path in entries} != EXPECTED_FILES or any(
        path.is_symlink() or not path.is_file() for path in entries
    ):
        parser.error('unexpected publication contents; only the static manifest is allowed')
    failed = False
    for path in entries:
        data = path.read_bytes()
        print(f'Scanned {path.name} ({len(data)} bytes)')
        if path.name == 'icon.png' and (data[:16] != b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
                                       or data[16:24] != struct.pack('>II', 180, 180)):
            print('FAIL icon.png: expected 180x180 PNG')
            failed = True
        patterns = VENDOR_PATTERNS if path.name == 'wallet-sdk.mjs' else FIRST_PARTY_PATTERNS
        for name, pattern in patterns.items():
            if re.search(pattern, data, flags=re.IGNORECASE):
                print(f'FAIL {path.name}: {name}')
                failed = True
    if not failed:
        print('No credential, key, mnemonic, or embedded fixture wallet signatures detected.')
        print('Official SDK bundle reviewed: public curve constants and English error sentences are not treated as secrets.')
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
