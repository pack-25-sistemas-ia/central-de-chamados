// Operação: exportação CSV segura, publicação de SLA (versões), marca/logotipo e anexos privados (validação, visibilidade e download autorizado).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ANON_KEY, BASE_URL, SUPABASE_URL, apiAal2Token } from './helpers';
import { DEMO, SLUG, demoPassword, loginAs, tag } from './tk-helpers';

test.describe.configure({ mode: 'serial' });
const T = tag();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==', 'base64');

async function token(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: demoPassword() }) });
  return ((await res.json()) as { access_token: string }).access_token;
}
async function rest<R>(email: string, path: string): Promise<R> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(email)}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as R;
}
async function openTicket(page: Page, subject: string, description = 'Descrição do chamado de teste.') {
  await page.goto('/chamados/novo');
  await page.getByLabel('Assunto').fill(subject);
  await page.getByLabel('Categoria').selectOption({ label: 'Impressoras e periféricos' });
  await page.getByLabel('Descrição').fill(description);
  await page.getByRole('button', { name: 'Abrir chamado' }).click();
  await page.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  return page.url();
}

test('exportação CSV: escopo, BOM, fórmulas neutralizadas e auditoria', async ({ page, browser }) => {
  const ctx = await browser.newContext();
  const sol = await ctx.newPage();
  await loginAs(sol, DEMO.sol1);
  await openTicket(sol, `=HYPERLINK("http://exemplo.invalid","x") ${T}`);
  await ctx.close();
  await loginAs(page, DEMO.gestor);
  const res = await page.request.get(`/api/exportar/chamados?q=${encodeURIComponent('HYPERLINK')}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/text\/csv/);
  expect(res.headers()['cache-control']).toMatch(/no-store/);
  expect(res.headers()['content-disposition']).toMatch(/chamados-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await res.text();
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv.split('\r\n')[0]).toContain('Número;Assunto;Status;Prioridade');
  expect(csv).toContain(`"'=HYPERLINK(""http://exemplo.invalid"",""x"") ${T}"`); // apóstrofo na frente: o Excel não executa
  expect(csv).not.toMatch(/(^|;)=HYPERLINK/m);
  // sem corpo de mensagem nem e-mail
  expect(csv).not.toMatch(/@demo\.exemplo/);
  // exporta tudo que o gestor vê: linhas = chamados visíveis pela API
  const all = await (await page.request.get('/api/exportar/chamados')).text();
  const count = (await rest<Array<{ id: string }>>(DEMO.gestor, 'tickets?select=id')).length;
  expect(all.trim().split('\r\n').length - 1).toBe(count);
  // atendente exporta só o que enxerga
  await loginAs(page, DEMO.at3);
  const mine = (await (await page.request.get('/api/exportar/chamados')).text()).trim().split('\r\n').length - 1;
  expect(mine).toBe((await rest<Array<{ id: string }>>(DEMO.at3, 'tickets?select=id')).length);
  expect(mine).toBeLessThan(count);
  // a exportação ficou na auditoria (só metadados)
  await loginAs(page, DEMO.dono); // garante o 2º fator do proprietário (segredo guardado em node_modules/.cache)
  const aal2 = await apiAal2Token(await token(DEMO.dono), readFileSync('node_modules/.cache/tk-e2e-owner-secret.txt', 'utf8').trim());
  const ar = await fetch(`${SUPABASE_URL}/rest/v1/audit_log?select=action,entity,changes&action=eq.export&entity=eq.tickets`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${aal2}` } });
  const audit = (await ar.json()) as Array<{ action: string; entity: string; changes: { rows?: number } }>;
  expect(audit.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(audit)).not.toContain('HYPERLINK');
});

test('SLA: publicar nova versão vale para novos ciclos e preserva as anteriores; calendário inválido é recusado', async ({ page, browser }) => {
  await loginAs(page, DEMO.dono);
  await page.goto('/configuracoes');
  await expect(page.getByRole('heading', { name: 'Expediente e metas de SLA' })).toBeVisible();
  await page.getByLabel('Normal: primeira resposta (min úteis)').fill('200');
  await page.getByRole('button', { name: 'Publicar nova versão' }).click();
  await expect(page.getByText(/Nova versão de expediente e SLA publicada/).first()).toBeVisible();
  const ctx = await browser.newContext();
  const sol = await ctx.newPage();
  await loginAs(sol, DEMO.sol2);
  const url = await openTicket(sol, `E2E nova política ${T}`);
  await ctx.close();
  const id = /\/chamados\/([0-9a-f-]{36})/.exec(url)![1]!;
  const novo = await rest<Array<{ first_response_target_minutes: number }>>(DEMO.gestor, `ticket_service_cycles?select=first_response_target_minutes&ticket_id=eq.${id}`);
  expect(novo[0]!.first_response_target_minutes).toBe(200);
  const todos = await rest<Array<{ first_response_target_minutes: number; priority_snapshot: string }>>(DEMO.gestor, 'ticket_service_cycles?select=first_response_target_minutes,priority_snapshot&priority_snapshot=eq.normal');
  expect(todos.some((c) => c.first_response_target_minutes === 240)).toBe(true); // ciclos antigos intactos
  const versions = await rest<Array<{ id: string }>>(DEMO.gestor, 'sla_policy_versions?select=id');
  expect(versions.length).toBeGreaterThanOrEqual(2);
  // calendário inválido: nada é publicado e a mensagem explica
  await page.goto('/configuracoes');
  await page.getByLabel('Segunda-feira, intervalo 1, início').fill('12:00');
  await page.getByLabel('Segunda-feira, intervalo 1, fim').fill('09:00');
  await page.getByRole('button', { name: 'Publicar nova versão' }).click();
  await expect(page.getByText(/fim deve ser depois do início/i).first()).toBeVisible();
  expect((await rest<Array<{ id: string }>>(DEMO.gestor, 'sla_policy_versions?select=id')).length).toBe(versions.length);
  // detalhe do chamado mostra que a meta do ciclo foi fixada
  await loginAs(page, DEMO.gestor);
  await page.goto(url);
  await expect(page.getByText(/metas foram fixadas no início deste ciclo/)).toBeVisible();
  await expect(page.getByText(/de 3 h 20 min/).first()).toBeVisible();
});

test('marca: nome, cor e logotipo (só imagem raster conferida pelos bytes)', async ({ page }) => {
  await loginAs(page, DEMO.dono);
  await page.goto('/configuracoes');
  await page.getByLabel('Nome exibido').fill(`Suporte Aurora ${T}`);
  await page.getByRole('button', { name: 'Salvar marca' }).click();
  await expect(page.getByText('Marca salva.').first()).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.getByRole('complementary').getByText(`Suporte Aurora ${T}`)).toBeVisible();
  // logotipo: arquivo falso com extensão .png é recusado; PNG real é aceito e servido pelo próprio domínio
  await page.goto('/configuracoes');
  await page.locator('input[name="logo"]').setInputFiles({ name: 'falso.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"></svg>') });
  await page.getByRole('button', { name: 'Enviar logotipo' }).click();
  await expect(page.getByText(/Formato não aceito/).first()).toBeVisible();
  await page.locator('input[name="logo"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Enviar logotipo' }).click();
  await expect(page.getByText('Logotipo atualizado.').first()).toBeVisible();
  const logo = await page.request.get('/marca/logo');
  expect(logo.status()).toBe(200);
  expect(logo.headers()['content-type']).toBe('image/png');
  expect(logo.headers()['x-content-type-options']).toBe('nosniff');
  expect(logo.headers()['content-security-policy']).toContain("object-src 'none'");
  // sem sessão, o logotipo não é servido
  const anon = await fetch(`${BASE_URL}/marca/logo`, { redirect: 'manual' });
  expect(anon.status).not.toBe(200);
});

test('anexos: tipos e tamanho validados no servidor; nota interna com anexo fica interna; download só com autorização', async ({ page, browser }) => {
  const ctx = await browser.newContext();
  const sol = await ctx.newPage();
  await loginAs(sol, DEMO.sol1);
  const url = await openTicket(sol, `E2E anexos ${T}`);
  const id = /\/chamados\/([0-9a-f-]{36})/.exec(url)![1]!;
  // recusas (nada é gravado)
  const tryFile = async (name: string, mimeType: string, buffer: Buffer) => {
    await sol.goto(url);
    await sol.getByRole('textbox', { name: 'Mensagem' }).fill('Segue o arquivo.');
    await sol.locator('input[name="file"]').setInputFiles({ name, mimeType, buffer });
    await sol.getByRole('button', { name: 'Enviar mensagem' }).click();
  };
  await tryFile('script.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'));
  await expect(sol.getByText(/tipo de arquivo não permitido/).first()).toBeVisible();
  await tryFile('pagina.html', 'text/html', Buffer.from('<html><script>alert(1)</script></html>'));
  await expect(sol.getByText(/tipo de arquivo não permitido/).first()).toBeVisible();
  await tryFile('programa.exe', 'application/octet-stream', Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000\u0004\u0000\u0000\u0000'));
  await expect(sol.getByText(/tipo de arquivo não permitido/).first()).toBeVisible();
  await tryFile('grande.pdf', 'application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6 * 1024 * 1024, 0x20)]));
  await expect(sol.getByText(/passa do tamanho máximo/).first()).toBeVisible();
  expect(await rest<Array<{ id: string }>>(DEMO.sol1, `ticket_attachments?select=id&ticket_id=eq.${id}`)).toHaveLength(0);
  // anexo público do solicitante (PDF mínimo)
  await tryFile('relato.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'));
  await expect(sol.getByText('Resposta enviada.').first()).toBeVisible();
  // equipe: nota interna COM anexo (texto)
  await loginAs(page, DEMO.at1);
  await page.goto(url);
  await page.getByRole('button', { name: 'Assumir chamado' }).click();
  await expect(page.getByText('Você assumiu o chamado.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Nota interna', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nota interna' }).fill('Log do servidor em anexo (interno).');
  await page.locator('input[name="file"]').setInputFiles({ name: 'log-interno.txt', mimeType: 'text/plain', buffer: Buffer.from('linha 1\nlinha 2\nsegredo-interno\n') });
  await page.getByRole('button', { name: 'Registrar nota interna' }).click();
  await expect(page.getByText('Nota interna registrada.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /log-interno\.txt/ })).toBeVisible();
  const atts = await rest<Array<{ id: string; original_filename: string; storage_path: string; mime_type: string }>>(DEMO.at1, `ticket_attachments?select=id,original_filename,storage_path,mime_type&ticket_id=eq.${id}`);
  const internal = atts.find((a) => a.original_filename === 'log-interno.txt')!;
  const publicAtt = atts.find((a) => a.original_filename === 'relato.pdf')!;
  expect(internal.mime_type).toBe('text/plain');
  // equipe baixa: redireciona para URL assinada de curta duração com download forçado
  const dl = await page.request.get(`/api/anexos/${internal.id}`, { maxRedirects: 0 });
  expect(dl.status()).toBe(302);
  const loc = dl.headers()['location']!;
  expect(loc).toMatch(/\/storage\/v1\/object\/sign\/tk-attachments\//);
  const file = await fetch(loc.replace('http://127.0.0.1:58921', SUPABASE_URL));
  expect(file.status).toBe(200);
  expect(await file.text()).toContain('segredo-interno');
  expect(file.headers.get('content-disposition')).toMatch(/attachment/i);
  // solicitante NÃO baixa o anexo interno (aplicação, API REST e Storage direto)
  const denied = await sol.request.get(`/api/anexos/${internal.id}`, { maxRedirects: 0 });
  expect(denied.status()).toBe(404);
  expect(await rest<Array<{ id: string }>>(DEMO.sol1, `ticket_attachments?select=id&ticket_id=eq.${id}`)).toHaveLength(1);
  const stor = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/tk-attachments/${internal.storage_path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(DEMO.sol1)}` } });
  expect(stor.status).not.toBe(200);
  const storStaff = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/tk-attachments/${internal.storage_path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(DEMO.at1)}` } });
  expect(storStaff.status).toBe(200);
  // o anexo público é do solicitante (e da equipe), mas não de OUTRO solicitante
  expect((await sol.request.get(`/api/anexos/${publicAtt.id}`, { maxRedirects: 0 })).status()).toBe(302);
  const ctx2 = await browser.newContext();
  const outro = await ctx2.newPage();
  await loginAs(outro, DEMO.sol3);
  expect((await outro.request.get(`/api/anexos/${publicAtt.id}`, { maxRedirects: 0 })).status()).toBe(404);
  const outroStor = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/tk-attachments/${publicAtt.storage_path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(DEMO.sol3)}` } });
  expect(outroStor.status).not.toBe(200);
  // sem sessão: nada
  const anon = await fetch(`${BASE_URL}/api/anexos/${internal.id}`, { redirect: 'manual' });
  expect([401, 403, 404, 307, 302]).toContain(anon.status);
  expect(anon.headers.get('location') ?? '').not.toContain('/storage/v1/object/sign');
  await ctx.close();
  await ctx2.close();
  void SLUG;
});

test('uploads órfãos: a gestão limpa e arquivos vinculados nunca são tocados', async ({ page }) => {
  await loginAs(page, DEMO.dono);
  const org = (await rest<Array<{ id: string }>>(DEMO.dono, `organizations?select=id&slug=eq.${SLUG}`))[0]!.id;
  const att = (await rest<Array<{ storage_path: string }>>(DEMO.dono, 'ticket_attachments?select=storage_path&limit=1'))[0]!;
  await page.goto('/configuracoes');
  await page.getByRole('button', { name: 'Limpar uploads órfãos' }).click();
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText(/upload\(s\) órfão|Nenhum upload órfão/).first()).toBeVisible();
  const still = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/tk-attachments/${att.storage_path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(DEMO.dono)}` } });
  expect(still.status).toBe(200);
  expect(att.storage_path.startsWith(org)).toBe(true);
});
