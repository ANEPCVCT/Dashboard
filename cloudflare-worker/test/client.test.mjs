import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboard = await readFile(new URL('../assets/dashboard.html', import.meta.url), 'utf8');
const publicDashboard = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const login = await readFile(new URL('../../login.html', import.meta.url), 'utf8');

test('Dashboard público antigo', () => {
  assert.doesNotMatch(publicDashboard, /\/api\/session|window\.location\.replace\('\/login\.html/);
  assert.match(publicDashboard, /Dashboard Operacional — Alto Minho/);
});

test('Cliente protegido', async (suite) => {
  await suite.test('remove completamente a chave de operador', () => {
    assert.doesNotMatch(dashboard, /epe-chave-operador|chaveOperadorEpeSessao|Bearer \$\{chave\}/);
    assert.match(dashboard, /const urlServicoEpe = '\/api\/epe';/);
  });

  await suite.test('envia EPE com sessão e proteção CSRF', () => {
    assert.match(dashboard, /'X-Dashboard-Request': '1'/);
    assert.match(dashboard, /'X-CSRF-Token': csrfTokenSessao/);
    assert.match(dashboard, /credentials: 'same-origin'/);
  });

  await suite.test('oferece os três piscos de permissão', () => {
    assert.match(dashboard, /Ver Dashboard/);
    assert.match(dashboard, /Gerir EPE/);
    assert.match(dashboard, /Gerir utilizadores/);
  });

  await suite.test('cria contas apenas com email institucional visível', () => {
    assert.match(dashboard, /placeholder="nome@prociv\.pt"/);
    assert.match(dashboard, /Palavra-passe provisória/);
    assert.match(dashboard, /reset-password/);
  });

  await suite.test('bloqueia a primeira entrada até alterar a password', () => {
    assert.match(login, /Alterar palavra-passe provisória/);
    assert.match(login, /current_password: currentPassword/);
    assert.match(login, /new_password: newPassword/);
    assert.match(login, /data\.user\.must_change_password/);
  });
});
