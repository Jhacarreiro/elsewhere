import { mkdtemp, writeFile, rm, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const examples = [
  ['private IP', 'PRIVATE_ENDPOINT=192.' + '168.55.44'],
  ['operator path', 'DO_NOT_USE=/data/' + 'workspace/internal-only'],
  ['credential', 'TEST_CREDENTIAL=gh' + 'p_abcdefghijklmnopqrstuvwxyzABCDEF012345'],
  ['operator path in JSON Lines', '{"text":"/data/' + 'workspace/internal-only"}', 'fixture.jsonl'],
];
for (const [label, sample, file = 'fixture.md'] of examples) {
  const root = await mkdtemp(join(tmpdir(), 'elsewhere-audit-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, file), sample);
    await mkdir(join(root, 'scripts'));
    await copyFile(new URL('./audit-public.mjs', import.meta.url), join(root, 'scripts', 'audit-public.mjs'));
    execFileSync('git', ['add', file], { cwd: root });
    // Run the real checker against the fixture, via its script-dir-based root.
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'audit-public.mjs')], {cwd: root, encoding:'utf8'});
    if (result.status === 0 || !result.stderr.includes('Public repository audit failed')) throw new Error(`Audit did not reject ${label}`);
  } finally { await rm(root, {recursive:true, force:true}); }
}
console.log('Public audit negative fixtures passed.');
