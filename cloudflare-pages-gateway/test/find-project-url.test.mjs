import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/find-project-url.mjs', import.meta.url));
const projectName = 'portal-anepc-alto-minho';

async function runParser(payload) {
  const directory = await mkdtemp(join(tmpdir(), 'pages-projects-'));
  const file = join(directory, 'projects.json');

  try {
    await writeFile(file, JSON.stringify(payload), 'utf8');
    return await execFileAsync(process.execPath, [script, projectName, file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('encontra o projeto no formato atual do Wrangler', async () => {
  const { stdout } = await runParser([{
    'Project Name': projectName,
    'Project Domains': `portal-interno.example.pt, ${projectName}.pages.dev`,
    'Git Provider': 'No'
  }]);

  assert.equal(stdout, `https://${projectName}.pages.dev`);
});

test('mantém compatibilidade com o formato antigo da API', async () => {
  const { stdout } = await runParser({
    result: [{ name: projectName, subdomain: `${projectName}.pages.dev` }]
  });

  assert.equal(stdout, `https://${projectName}.pages.dev`);
});

test('recusa um projeto sem domínio pages.dev válido', async () => {
  await assert.rejects(
    runParser([{
      'Project Name': projectName,
      'Project Domains': 'portal-interno.example.pt'
    }]),
    /Domínio pages\.dev do projeto portal-anepc-alto-minho não encontrado/
  );
});
