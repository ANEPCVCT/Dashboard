import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const projectName = process.argv[2];
const file = process.argv[3];
assert.ok(projectName, 'Nome do projeto Pages em falta.');
assert.ok(file, 'Ficheiro da lista de projetos em falta.');

const payload = JSON.parse(await readFile(file, 'utf8'));
const projects = Array.isArray(payload) ? payload : (payload.result || []);
const project = projects.find((item) => item?.name === projectName);
assert.ok(project, `Projeto Pages ${projectName} não encontrado.`);
assert.match(project.subdomain || '', /^[a-z0-9-]+\.pages\.dev$/i);
process.stdout.write(`https://${project.subdomain}`);
