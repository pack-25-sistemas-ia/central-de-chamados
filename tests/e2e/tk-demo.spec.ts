// Demonstração «Suporte Aurora TI» no navegador real: telas por perfil, permissões, fila (filtros, quadro, paginação), escopo por equipe,
// assumir com dois atendentes ao mesmo tempo, respostas prontas, equipes/desativação, notificações e portal.
// Pré-requisito: `supabase db reset` + `node scripts/seed-demo.mjs` (os testes dependem dos dados da demonstração).
import { expect, test } from '@playwright/test';
import { ANON_KEY, SUPABASE_URL } from './helpers';
import { DEMO, demoPassword, expectNoServerError, loginAs, SLUG, tag } from './tk-helpers';

test.describe.configure({ mode: 'serial' });
const T = tag();

async function token(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: demoPassword() }) });
  return ((await res.json()) as { access_token: string }).access_token;
}
async function rest<R>(email: string, path: string): Promise<R> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${await token(email)}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as R;
}

test('proprietário: todas as telas abrem e têm um título', async ({ page }) => {
  await loginAs(page, DEMO.dono);
  for (const r of ['/dashboard', '/chamados', '/chamados?layout=board', '/chamados/novo', '/equipes', '/categorias', '/respostas-prontas', '/relatorios', '/configuracoes', '/notificacoes', '/members', '/audit']) {
    const res = await page.goto(r);
    expect(res?.status(), r).toBeLessThan(400);
    await expect(page.getByRole('heading', { level: 1 }).first(), r).toBeVisible();
    await expectNoServerError(page, r);
  }
});

test('permissões por perfil: o menu e as rotas seguem o papel (e o servidor responde 404)', async ({ page }) => {
  // solicitante: portal enxuto
  await loginAs(page, DEMO.sol1);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Meus chamados');
  for (const label of ['Equipes', 'Categorias', 'Respostas prontas', 'Relatórios', 'Configurações', 'Não atribuídos']) await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: label })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Novo chamado' })).toBeVisible();
  for (const r of ['/equipes', '/categorias', '/respostas-prontas', '/relatorios', '/configuracoes']) expect((await page.goto(r))?.status(), `solicitante em ${r}`).toBe(404);
  const exp = await page.request.get('/api/exportar/chamados');
  expect(exp.status(), 'solicitante não exporta').toBe(403);
  // atendente: fila e atendimento, sem administração
  await loginAs(page, DEMO.at1);
  await page.goto('/dashboard');
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Chamados', exact: true })).toBeVisible();
  for (const r of ['/equipes', '/categorias', '/respostas-prontas', '/relatorios', '/configuracoes']) expect((await page.goto(r))?.status(), `atendente em ${r}`).toBe(404);
  // gestor: equipes e categorias, sem configurações da empresa
  await loginAs(page, DEMO.gestor);
  for (const r of ['/equipes', '/categorias', '/respostas-prontas', '/relatorios']) expect((await page.goto(r))?.status(), `gestor em ${r}`).toBe(200);
  expect((await page.goto('/configuracoes'))?.status(), 'gestor em /configuracoes').toBe(404);
});

test('fila: filtros, visões, SLA atrasado, quadro e paginação (no servidor)', async ({ page }) => {
  await loginAs(page, DEMO.gestor);
  await page.goto('/chamados');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chamados');
  const rows = page.locator('tbody tr');
  expect(await rows.count()).toBe(25); // página 1 de 32
  await page.getByRole('link', { name: 'Próxima' }).click();
  await expect(page).toHaveURL(/page=2/);
  expect(await rows.count()).toBe(7);
  // busca por assunto e por número
  await page.goto('/chamados?q=Sem+internet+no+escrit%C3%B3rio+inteiro');
  await expect(page.getByRole('link', { name: /Sem internet no escritório inteiro/ }).first()).toBeVisible();
  expect(await rows.count()).toBe(1);
  // visão «SLA atrasado»: todos mostram o selo «Atrasado»
  await page.goto('/chamados?view=overdue');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const r of await rows.all()) await expect(r.getByText('Atrasado')).toBeVisible();
  // visão «Sem responsável»
  await page.goto('/chamados?view=unassigned');
  for (const r of await rows.all()) await expect(r.getByText('Sem responsável')).toBeVisible();
  // aguardando solicitante: SLA pausado visível
  await page.goto('/chamados?view=waiting');
  expect(await rows.count()).toBe(2);
  // filtros combinados (status + prioridade)
  await page.goto('/chamados?status=in_progress&priority=high');
  for (const r of await rows.all()) { await expect(r.getByText('Em atendimento')).toBeVisible(); await expect(r.getByText('Alta')).toBeVisible(); }
  // quadro por status
  await page.goto('/chamados?layout=board');
  for (const s of ['Aberto', 'Em atendimento', 'Aguardando solicitante', 'Resolvido', 'Encerrado']) await expect(page.getByRole('region', { name: s })).toBeVisible();
  await expect(page.getByText(/nada depende de arrastar/)).toBeVisible();
  await page.getByRole('link', { name: /VPN não conecta/ }).first().click();
  await expect(page).toHaveURL(/\/chamados\/[0-9a-f-]{36}/);
});

test('escopo por equipe: o atendente só vê chamados da própria equipe ou atribuídos a ele', async ({ page }) => {
  await loginAs(page, DEMO.at3); // equipe Infraestrutura
  await page.goto('/chamados?q=Planilha');
  await expect(page.locator('p', { hasText: 'Nenhum chamado encontrado.' })).toBeVisible(); // «Planilha de custos» é da equipe Nível 1
  await page.goto('/chamados?q=VPN');
  await expect(page.getByRole('link', { name: /VPN não conecta/ }).first()).toBeVisible();
  // pela API (RLS): contagens diferentes por perfil
  const at3 = await rest<Array<{ team_id: string }>>(DEMO.at3, 'tickets?select=team_id');
  expect(new Set(at3.map((t) => t.team_id)).size).toBe(1);
  const gestor = await rest<Array<{ team_id: string }>>(DEMO.gestor, 'tickets?select=team_id');
  expect(gestor.length).toBeGreaterThan(at3.length);
  // abrir direto o chamado de outra equipe devolve 404
  const other = (await rest<Array<{ id: string }>>(DEMO.gestor, 'tickets?select=id,subject&subject=ilike.*Planilha*'))[0]!.id;
  expect((await page.goto(`/chamados/${other}`))?.status()).toBe(404);
});

test('assumir: dois atendentes ao mesmo tempo, só um vence e o outro é avisado', async ({ browser }) => {
  const mk = async (email: string) => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await loginAs(p, email); return { ctx, p }; };
  const a = await mk(DEMO.at1);
  const b = await mk(DEMO.at2);
  // chamado aberto, sem responsável, da equipe Nível 1 (ambos pertencem à equipe)
  await a.p.goto('/chamados?q=Instalar+programa+de+edi%C3%A7%C3%A3o');
  await a.p.getByRole('link', { name: /Instalar programa de edição de PDF/ }).first().click();
  await a.p.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  const url = a.p.url();
  await b.p.goto(url);
  await expect(a.p.getByRole('button', { name: 'Assumir chamado' })).toBeVisible();
  await expect(b.p.getByRole('button', { name: 'Assumir chamado' })).toBeVisible();
  await Promise.all([a.p.getByRole('button', { name: 'Assumir chamado' }).click(), b.p.getByRole('button', { name: 'Assumir chamado' }).click()]);
  await expect.poll(async () => (await a.p.getByText('Você assumiu o chamado.').count()) + (await b.p.getByText('Você assumiu o chamado.').count()) + (await a.p.getByText(/acabou de ser assumido/).count()) + (await b.p.getByText(/acabou de ser assumido/).count())).toBeGreaterThanOrEqual(2);
  const won = (await a.p.getByText('Você assumiu o chamado.').count()) + (await b.p.getByText('Você assumiu o chamado.').count());
  const lost = (await a.p.getByText(/acabou de ser assumido/).count()) + (await b.p.getByText(/acabou de ser assumido/).count());
  expect({ won, lost }).toEqual({ won: 1, lost: 1 });
  await a.ctx.close();
  await b.ctx.close();
});

test('respostas prontas só preenchem o texto (nada é enviado sem revisão)', async ({ page }) => {
  await loginAs(page, DEMO.at1);
  await page.goto('/chamados?q=Planilha+de+custos');
  await page.getByRole('link', { name: /Planilha de custos não abre/ }).first().click();
  await page.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  const before = await page.getByRole('article').count();
  await page.getByLabel(/Resposta pronta/).selectOption({ label: 'Pedir mais informações' });
  await expect(page.getByRole('textbox', { name: 'Mensagem' })).toHaveValue(/horário aproximado/);
  expect(await page.getByRole('article').count()).toBe(before);
  // modo nota interna esconde modelos e muda a aparência
  await page.getByRole('button', { name: 'Nota interna', exact: true }).click();
  await expect(page.getByText(/Nota interna: visível somente para a equipe/)).toBeVisible();
  await expect(page.getByLabel(/Resposta pronta/)).toHaveCount(0);
});

test('equipes: gestor ajusta membros e desativa atendente reatribuindo os chamados abertos', async ({ page }) => {
  await loginAs(page, DEMO.gestor);
  await page.goto('/equipes');
  await expect(page.getByRole('heading', { name: 'Suporte Nível 1' })).toBeVisible();
  const row = page.locator('tr', { hasText: 'atendente2@demo.exemplo' });
  await row.getByText('Desativar…').click();
  await row.getByLabel('Chamados abertos dele').selectOption('reassign');
  await row.getByLabel('Reatribuir a', { exact: true }).selectOption({ label: 'Bia Atendente' });
  await row.getByRole('button', { name: 'Desativar atendente' }).click();
  // Caio está em duas equipes: Bia só pertence a uma, então o banco recusa a reatribuição e nada é alterado
  await expect(page.getByText(/não pertence à equipe de todos os chamados/).first()).toBeVisible();
  await expect(page.locator('tr', { hasText: 'atendente2@demo.exemplo' }).getByText('Ativo', { exact: true })).toBeVisible();
  // decisão explícita: devolver os chamados à fila
  await row.getByLabel('Chamados abertos dele').selectOption('unassign');
  await row.getByRole('button', { name: 'Desativar atendente' }).click();
  await expect(page.getByText(/Atendente desativado/).first()).toBeVisible();
  await expect(page.locator('tr', { hasText: 'atendente2@demo.exemplo' }).getByText('Desativado')).toBeVisible();
  const assigned = await rest<Array<{ id: string }>>(DEMO.gestor, `tickets?select=id&assigned_user_id=eq.${(await rest<Array<{ user_id: string }>>(DEMO.gestor, 'agent_status?select=user_id&active=eq.false'))[0]!.user_id}&status=in.(open,in_progress,waiting_requester)`);
  expect(assigned).toHaveLength(0);
  // o atendente desativado perde o acesso (autoria histórica preservada)
  await loginAs(page, DEMO.at2);
  await page.goto('/dashboard');
  await expect(page.getByText(/ainda não tem acesso aos chamados/)).toBeVisible();
  expect((await page.goto('/chamados'))?.status()).toBe(404);
  // reativa
  await loginAs(page, DEMO.gestor);
  await page.goto('/equipes');
  await page.locator('tr', { hasText: 'atendente2@demo.exemplo' }).getByRole('button', { name: 'Reativar' }).click();
  await expect(page.getByText('Atendente reativado.').first()).toBeVisible();
});

test('notificações: aparecem para quem tem acesso, nunca expõem nota interna e marcam como lidas', async ({ page }) => {
  await loginAs(page, DEMO.sol4);
  await page.goto('/notificacoes');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notificações');
  await expect(page.getByText('Solicitação resolvida')).toBeVisible();
  await expect(page.getByText(/nota interna/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
  await expect(page.getByText('Notificações marcadas como lidas.').first()).toBeVisible();
  await expect(page.getByText('Tudo em dia')).toBeVisible();
});

test('portal: o slug identifica a empresa mas não dá acesso; solicitante cai na própria lista', async ({ page }) => {
  await loginAs(page, DEMO.sol1);
  await page.goto(`/portal/${SLUG}`);
  await expect(page).toHaveURL(/\/chamados$/);
  expect((await page.goto('/portal/outra-empresa-qualquer'))?.status()).toBe(404);
  expect((await page.goto('/portal/%3Cscript%3E'))?.status()).toBe(404);
  // chamado de outro solicitante pelo endereço do portal: não abre
  const other = (await rest<Array<{ id: string }>>(DEMO.gestor, `tickets?select=id,requester_user_id&subject=ilike.*Sistema%20de%20pedidos*`))[0]!.id;
  expect((await page.goto(`/portal/${SLUG}/chamados/${other}`))?.status()).toBe(404);
  void T;
});
