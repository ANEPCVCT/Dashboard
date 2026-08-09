import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const projectName = process.argv[2];
const file = process.argv[3];
assert.ok(projectName, 'Nome do projeto Pages em falta.');
assert.ok(file, 'Ficheiro da lista de projetos em falta.');

const payload = JSON.parse(await readFile(file, 'utf8'));
const projects = Array.isArray(payload) ? payload : (payload.result || []);
const project = projects.find((item) => (
  item?.name === projectName || item?.['Project Name'] === projectName
));
assert.ok(project, `Projeto Pages ${projectName} não encontrado.`);

const domains = [
  project.subdomain,
  ...(Array.isArray(project.domains) ? project.domains : []),
  project['Project Domains']
]
  .flatMap((value) => typeof value === 'string' ? value.split(',') : [])
  .map((value) => value.trim())
  .filter(Boolean);
const pagesDomain = domains.find((domain) => /^[a-z0-9-]+\.pages\.dev$/i.test(domain));
assert.ok(pagesDomain, `Domínio pages.dev do projeto ${projectName} não encontrado.`);
process.stdout.write(`https://${pagesDomain}`);
