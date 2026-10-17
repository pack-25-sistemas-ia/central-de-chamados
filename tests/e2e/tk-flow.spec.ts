// Fluxo principal da Central de Chamados contra o Supabase real (app compilado): os 12 passos do prompt, mais reabertura e conflito de versão.
import { expect, test, type Page } from '@playwright/test';
import { ANON_KEY, SUPABASE_URL } from './helpers';
import { DEMO, demoPassword, loginAs, tag } from './tk-helpers';

test.describe.configure({ mode: 'serial' });
const T = tag();
const SUBJECT = `E2E impressora sem toner ${T}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==', 'base64');
let ticketUrl = '';

const idOf = (url: string) => /\/chamados\/([0-9a-f-]{36})/.exec(url)![1]!;

async function token(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: demoPassword() }) });
  return ((await res.json()) as { access_token: string }).access_token;
}
async function rest<R>(email: string, path: string): Promise<R> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(email)}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as R;
}
async function send(page: Page, text: string, opts: { button: string; next?: string; note?: boolean }) {
  if (opts.note) await page.getByRole('button', { name: 'Nota interna', exact: true }).click();
  await page.getByRole('textbox', { name: opts.note ? 'Nota interna' : 'Mensagem' }).fill(text);
  if (opts.next) await page.getByLabel('Ao enviar').selectOption({ label: opts.next });
  await page.getByRole('button', { name: opts.button }).click();
}

test('1. solicitante abre o chamado com anexo (descrição = primeira mensagem pública)', async ({ page }) => {
  await loginAs(page, DEMO.sol1);
  await page.goto('/chamados/novo');
  await page.getByLabel('Assunto').fill(SUBJECT);
  await page.getByLabel('Categoria').selectOption({ label: 'Impressoras e periféricos' });
  await page.getByLabel('Descrição').fill('A impressora do financeiro mostra "toner vazio" e não imprime mais.');
  await page.locator('input[name="file"]').setInputFiles({ name: 'captura.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Abrir chamado' }).click();
  await page.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  ticketUrl = page.url();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(SUBJECT);
  await expect(page.getByText('Aberto', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('A impressora do financeiro mostra')).toBeVisible();
  await expect(page.getByRole('link', { name: /captura\.png/ })).toBeVisible();
  // o solicitante não vê equipe, responsável nem SLA
  await expect(page.getByText('Responsável', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'SLA' })).toHaveCount(0);
});

test('2–3. equipe localiza o chamado na fila e o atendente assume', async ({ page }) => {
  await loginAs(page, DEMO.at1);
  await page.goto(`/chamados?q=${encodeURIComponent(T)}`);
  const link = page.getByRole('link', { name: new RegExp(SUBJECT) }).first();
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(ticketUrl);
  await page.getByRole('button', { name: 'Assumir chamado' }).click();
  await expect(page.getByText('Você assumiu o chamado.').first()).toBeVisible();
  await expect(page.getByText('Em atendimento', { exact: true }).first()).toBeVisible();
  await expect(page.locator('dd', { hasText: 'Bia Atendente' }).first()).toBeVisible();
});

test('4–5. nota interna: a equipe vê, o solicitante NÃO (tela e API)', async ({ page, browser }) => {
  await loginAs(page, DEMO.at1);
  await page.goto(ticketUrl);
  await send(page, 'NOTA-SECRETA verificar toner e contrato de suprimentos.', { button: 'Registrar nota interna', note: true });
  await expect(page.getByText('Nota interna registrada.').first()).toBeVisible();
  await expect(page.getByText('NOTA-SECRETA').first()).toBeVisible();
  await expect(page.getByText(/só a equipe vê/).first()).toBeVisible();
  const ctx = await browser.newContext();
  const req = await ctx.newPage();
  await loginAs(req, DEMO.sol1);
  await req.goto(ticketUrl);
  await expect(req.getByText('A impressora do financeiro mostra')).toBeVisible();
  await expect(req.getByText('NOTA-SECRETA')).toHaveCount(0);
  expect(await req.content()).not.toContain('NOTA-SECRETA');
  // pela API: a RLS não entrega a nota ao solicitante (e entrega à equipe)
  const mine = await rest<Array<{ body: string; visibility: string }>>(DEMO.sol1, `ticket_messages?ticket_id=eq.${idOf(ticketUrl)}&select=body,visibility`);
  expect(mine.every((m) => m.visibility === 'public')).toBe(true);
  expect(JSON.stringify(mine)).not.toContain('NOTA-SECRETA');
  const staff = await rest<Array<{ body: string }>>(DEMO.at1, `ticket_messages?ticket_id=eq.${idOf(ticketUrl)}&select=body`);
  expect(JSON.stringify(staff)).toContain('NOTA-SECRETA');
  await ctx.close();
});

test('6. atendente pede informação: o chamado aguarda o solicitante e o SLA pausa', async ({ page }) => {
  await loginAs(page, DEMO.at1);
  await page.goto(ticketUrl);
  await send(page, 'Pode informar o modelo da impressora e a etiqueta do patrimônio?', { button: 'Enviar resposta', next: 'Responder e pedir informação (pausa o SLA)' });
  await expect(page.getByText(/SLA está pausado/).first()).toBeVisible();
  await expect(page.getByText('Aguardando solicitante', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Relógio pausado')).toBeVisible();
});

test('7–8. solicitante responde e o SLA retoma', async ({ page, browser }) => {
  await loginAs(page, DEMO.sol1);
  await page.goto(ticketUrl);
  await expect(page.getByText('Pode informar o modelo da impressora')).toBeVisible();
  await send(page, 'É uma HP LaserJet 400, patrimônio 12345.', { button: 'Enviar mensagem' });
  await expect(page.getByText('Resposta enviada.').first()).toBeVisible();
  await expect(page.getByText('Em atendimento', { exact: true }).first()).toBeVisible();
  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  await loginAs(staff, DEMO.at1);
  await staff.goto(ticketUrl);
  await expect(staff.getByText('Relógio pausado')).toHaveCount(0);
  await expect(staff.getByText('Em atendimento', { exact: true }).first()).toBeVisible();
  await staff.getByText(/Histórico de eventos/).click();
  await expect(staff.getByText('SLA pausado (aguardando solicitante)')).toBeVisible();
  await expect(staff.getByText('SLA retomado')).toBeVisible();
  await ctx.close();
});

test('9–10. atendente resolve e o solicitante confirma (encerrado)', async ({ page, browser }) => {
  await loginAs(page, DEMO.at1);
  await page.goto(ticketUrl);
  await send(page, 'Substituímos o toner e a impressão foi normalizada.', { button: 'Enviar resposta', next: 'Responder e resolver o chamado' });
  await expect(page.getByText('Chamado resolvido.').first()).toBeVisible();
  const ctx = await browser.newContext();
  const req = await ctx.newPage();
  await loginAs(req, DEMO.sol1);
  await req.goto(ticketUrl);
  await expect(req.getByText('Resolvido', { exact: true }).first()).toBeVisible();
  await req.getByRole('button', { name: 'Confirmar que foi resolvido' }).click();
  await expect(req.getByText('Obrigado! O chamado foi encerrado.').first()).toBeVisible();
  await expect(req.getByText('Encerrado', { exact: true }).first()).toBeVisible();
  await ctx.close();
});

test('10b. reabrir dentro da janela cria novo ciclo e preserva o anterior', async ({ page, browser }) => {
  // chamado resolvido da demonstração (solicitante 4): «Acesso à pasta de projetos»
  await loginAs(page, DEMO.sol4);
  await page.goto('/chamados?q=Acesso+%C3%A0+pasta+de+projetos');
  await page.getByRole('link', { name: /Acesso à pasta de projetos/ }).first().click();
  await page.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  const url = page.url();
  await expect(page.getByText('Resolvido', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Motivo da reabertura').fill('Ainda não consigo abrir as subpastas do projeto.');
  await page.getByRole('button', { name: 'Reabrir chamado' }).click();
  await expect(page.getByText(/Chamado reaberto/).first()).toBeVisible();
  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  await loginAs(staff, DEMO.gestor);
  await staff.goto(url);
  await expect(staff.getByText('Ciclo 2', { exact: false }).first()).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Ciclos de atendimento' })).toBeVisible();
  await expect(staff.getByText('Ciclo 1').first()).toBeVisible();
  await expect(staff.getByText('Reabertura: Ainda não consigo').first()).toBeVisible();
  await ctx.close();
});

test('11. o painel reflete dados reais (contagem independente pela API)', async ({ page }) => {
  await loginAs(page, DEMO.gestor);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Painel de chamados');
  const kpi = async (label: string) => Number((await page.getByText(label, { exact: true }).first().locator('xpath=following-sibling::p[1]').innerText()).replace(/\D/g, ''));
  const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10);
  const rows = await rest<Array<{ id: string }>>(DEMO.gestor, `tickets?select=id&created_at=gte.${from}T00:00:00-03:00`);
  expect(await kpi('Chamados criados')).toBe(rows.length);
  const backlog = await rest<Array<{ id: string }>>(DEMO.gestor, 'tickets?select=id&status=in.(open,in_progress,waiting_requester)');
  expect(await kpi('Backlog atual')).toBe(backlog.length);
  await expect(page.getByText('Sem dados').or(page.getByText(/%/)).first()).toBeVisible();
});

test('12. fluxo do solicitante funciona no celular (375 px)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, DEMO.sol2);
  await page.goto('/chamados');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Meus chamados');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.goto('/chamados/novo');
  await page.getByLabel('Assunto').fill(`E2E celular ${T}`);
  await page.getByLabel('Descrição').fill('Teste de abertura pelo celular.');
  await page.getByRole('button', { name: 'Abrir chamado' }).click();
  await page.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`E2E celular ${T}`);
  await page.getByRole('textbox', { name: 'Mensagem' }).fill('Mais um detalhe enviado do celular.');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.getByText('Resposta enviada.').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('duplo clique no envio não cria dois chamados (idempotência) e versão antiga é recusada', async ({ page, browser }) => {
  await loginAs(page, DEMO.sol3);
  await page.goto('/chamados/novo');
  const subject = `E2E duplo clique ${T}`;
  await page.getByLabel('Assunto').fill(subject);
  await page.getByLabel('Descrição').fill('Enviado duas vezes rapidamente.');
  const btn = page.getByRole('button', { name: 'Abrir chamado' });
  await btn.dblclick().catch(() => undefined);
  await page.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  const rows = await rest<Array<{ id: string }>>(DEMO.sol3, `tickets?select=id&subject=eq.${encodeURIComponent(subject)}`);
  expect(rows).toHaveLength(1);
  // conflito: duas abas do gestor alteram a prioridade a partir da mesma versão
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await loginAs(a, DEMO.gestor);
  await a.goto(page.url());
  await b.goto(page.url());
  await a.getByLabel('Prioridade').selectOption('high');
  await a.getByRole('button', { name: 'Alterar' }).first().click();
  await expect(a.getByText(/Prioridade alterada/).first()).toBeVisible();
  await b.getByLabel('Prioridade').selectOption('urgent');
  await b.getByRole('button', { name: 'Alterar' }).first().click();
  await expect(b.getByText(/alterado por outra pessoa/).first()).toBeVisible();
  await expect(b.getByRole('button', { name: 'Atualizar e ver a versão mais recente' })).toBeVisible();
  await ctx.close();
});
