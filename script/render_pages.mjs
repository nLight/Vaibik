import { readFileSync, writeFileSync } from 'node:fs';

const [releasesPath, indexPath] = process.argv.slice(2);
const releasesUrl = 'https://github.com/nLight/Vaibik/releases';
const assetSuffixes = new Map([
  ['mac-arm64', 'arm64.dmg'],
  ['mac-x64', 'x64.dmg'],
  ['linux-deb', 'linux-x64.deb'],
  ['linux-appimage', 'linux-x64.AppImage'],
]);

const releases = JSON.parse(readFileSync(releasesPath, 'utf8')).flat()
  .filter(release => !release.draft && release.published_at && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
  .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
const latest = releases[0];

let html = readFileSync(indexPath, 'utf8');
if (latest) {
  html = html
    .replace('<span data-release-version></span>', `<span data-release-version> · ${latest.tag_name}</span>`)
    .replace(`id="release-link" href="${releasesUrl}"`, `id="release-link" href="${releasesUrl}/tag/${latest.tag_name}"`);
}

html = html.replace(/<a\b[^>]*\bdata-release-asset="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (link, key) => {
  const suffix = assetSuffixes.get(key);
  if (!suffix) throw new Error(`Unknown download slot: ${key}`);

  const release = releases.find(candidate => candidate.assets.some(asset =>
    asset.state === 'uploaded' && asset.name === `VibeMic-${candidate.tag_name.slice(1)}-${suffix}`));
  if (!release) return '';

  const version = release.tag_name;
  const url = `${releasesUrl}/download/${version}/VibeMic-${version.slice(1)}-${suffix}`;
  const versionLabel = version === latest.tag_name ? '' : version;
  return link
    .replace(/href="[^"]*"/, `href="${url}"`)
    .replace('<span data-asset-version></span>', `<span data-asset-version>${versionLabel}</span>`);
});

writeFileSync(indexPath, html);
