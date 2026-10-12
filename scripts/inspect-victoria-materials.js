// Read-only source inventory. No production, Disk, or database mutations.
const fs = require('node:fs');
const SOURCE = 'https://disk.yandex.ru/d/Pf1bqSQkEG62sw';
const ROOT = '/Версия ИИ';
async function inventory(folder = ROOT, result = { source: SOURCE, root: ROOT, directories: [], files: [] }) {
  if (folder !== ROOT && !folder.startsWith(ROOT + '/')) throw new Error('Outside source');
  for (let offset = 0; ;) {
    const url = new URL('https://cloud-api.yandex.net/v1/disk/public/resources');
    for (const [key, value] of Object.entries({ public_key: SOURCE, path: folder, limit: 1000, offset })) url.searchParams.set(key, String(value));
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Source HTTP ' + response.status);
    const data = await response.json();
    if (data.type !== 'dir' || !Array.isArray(data._embedded?.items) || !Number.isInteger(data._embedded.total)) throw new Error('Incomplete source');
    for (const item of data._embedded.items) {
      const expected = folder + '/' + item.name;
      if (item.path !== expected || item.name.includes('/') || item.name === '..' || item.name === '.') throw new Error('Invalid source path');
      if (item.type === 'dir') { result.directories.push(item.path); await inventory(item.path, result); }
      else if (item.type === 'file') {
        if (!Number.isSafeInteger(item.size) || item.size < 0 || !item.sha256 && !item.md5) throw new Error('Incomplete file metadata');
        result.files.push({ path: item.path, name: item.name, size: item.size, sha256: item.sha256, md5: item.md5, mimeType: item.mime_type });
      } else throw new Error('Unknown source item');
    }
    offset += data._embedded.items.length;
    if (offset >= data._embedded.total) break;
    if (!data._embedded.items.length) throw new Error('Incomplete pagination');
  }
  return result;
}
if (require.main === module) inventory().then(result => {
  fs.writeFileSync('victoria-materials-source.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root: ROOT, files: result.files.length, directories: result.directories.length, bytes: result.files.reduce((sum, f) => sum + f.size, 0) }));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { inventory };
