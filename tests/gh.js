// Shared test helpers: a tar writer and a fake GitHub.
import http from 'node:http';
import zlib from 'node:zlib';

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512); h.write(name.slice(0, 100), 0, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
export function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    if (e.name.length > 100) { const rec = `path=${e.name}\n`; let len = rec.length + 3; while (`${len} ${rec}`.length !== len) len = `${len} ${rec}`.length; const px = Buffer.from(`${len} ${rec}`); parts.push(tarHeader('pax', px.length, 'x'), pad(px)); }
    parts.push(tarHeader(e.name, data.length, e.type || '0'), pad(data));
  }
  parts.push(Buffer.alloc(1024)); return zlib.gzipSync(Buffer.concat(parts));
}
export const skillMd = (name, desc, body = `# ${name} title\n\nSome real playbook text for ${name}.\n`) => `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  version: 1.0.0\n---\n\n${body}`;

export const MARINE = skillMd('marine-logistics', 'When the user wants marketing for shipping, ports, vessels and marine logistics companies, charterers and port agents.', '# Marine Logistics Marketing\n\n## Know the buyer\nCharterers and port agents buy on schedule reliability.\n\n## Proof that works\nVoyage on-time performance.\n');
export const upstreamArchive = (root = 'marketingskills-abc') => makeTar([
  { name: `${root}/skills/marine-logistics/SKILL.md`, data: MARINE },
  { name: `${root}/skills/seo-audit/SKILL.md`, data: skillMd('seo-audit', 'When the user wants an SEO audit.', '# SEO Audit\n\nUPSTREAM-UPDATED guidance.\n') },
]);

/** A fake GitHub: serves one commit and one archive. `state` can be changed between calls. */
export async function fakeGithub(state = {}) {
  state.sha ||= 'a'.repeat(40); state.archive ||= upstreamArchive(); state.hits = []; state.down = false;
  const srv = http.createServer((req, res) => {
    state.hits.push(req.url);
    if (state.down) { res.writeHead(503); return res.end('down'); }
    if (req.url.startsWith('/repos/o/r/commits/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ sha: state.sha })); }
    if (req.url.startsWith('/o/r/tar.gz/')) { res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(state.archive); }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  state.base = `http://127.0.0.1:${srv.address().port}`; state.close = () => srv.close();
  return state;
}
