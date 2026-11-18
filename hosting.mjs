const GITHUB_PAGES_HOST = 'https://simonpeng1204.github.io';
const REPOSITORY = /^(?!\.\.?$)[a-zA-Z0-9_.-]{1,100}$/;
const PNG_HEADER = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];

export function pagesBase(repository) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    throw new Error('Supply the approved GitHub Pages repository name');
  }
  return GITHUB_PAGES_HOST + '/' + repository + '/';
}

export async function findPublicIcon(pageUrl, config, fetchIcon = globalThis.fetch) {
  if (!config.publicBase) return null;
  try {
    const base = new URL(config.publicBase);
    const page = new URL(pageUrl);
    if (base.href !== pagesBase(base.pathname.slice(1, -1)) || page.origin !== base.origin
        || ![base.pathname, base.pathname + 'index.html'].includes(page.pathname)) return null;

    const icon = new URL('icon.png', base).href;
    const response = await fetchIcon(icon, {
      credentials: 'omit', redirect: 'error', cache: 'no-cache',
      referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || response.url !== icon
        || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/png') return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 24 || !PNG_HEADER.every((byte, index) => bytes[index] === byte)) return null;
    const dimensions = new DataView(bytes.buffer, 16);
    return dimensions.getUint32(0) === 180 && dimensions.getUint32(4) === 180 ? icon : null;
  } catch {
    return null;
  }
}
