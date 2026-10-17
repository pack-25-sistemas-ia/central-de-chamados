// Segurança da Central de Chamados contra o Supabase real: este sistema não tem porta pública (anon nada acessa); o solicitante só alcança o que é dele;
// a escrita só entra por funções tk_*; XSS, CSP, idempotência e versão otimista também pela API.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ANON_KEY, BASE_URL, SUPABASE_URL } from './helpers';
import { DEMO, demoPassword, loginAs, tag } from './tk-helpers';

test.describe.configure({ mode: 'serial' });
const T = tag();

async function token(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: demoPassword() }) });
  return ((await res.json()) as { access_token: string }).access_token;
}
const H = (tk: string | null) => ({ apikey: ANON_KEY, authorization: `Bearer ${tk ?? ANON_KEY}`, 'content-type': 'application/json' });
async function rpc(tk: string | null, fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H(tk), body: JSON.stringify(args) });
  const text = await r.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* vazio */ }
  return { status: r.status, body: body as Record<string, unknown> | unknown[] | null, text };
}
async function table<R>(tk: string | null, path: string): Promise<{ status: number; rows: R[] }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H(tk) });
  const body = await r.json().catch(() => []);
  return { status: r.status, rows: Array.isArray(body) ? (body as R[]) : [] };
}
const orgId = async () => (await table<{ id: string }>(await token(DEMO.sol1), 'organizations?select=id&slug=eq.suporte-aurora')).rows[0]!.id;

test('anon: nenhuma função tk_* e nenhuma tabela do sistema', async () => {
  const org = await orgId();
  const fns: Array<[string, Record<string, unknown>]> = [
    ['tk_queue', { p_org: org, p_filters: {}, p_page: 1, p_size: 10 }], ['tk_my_context', { p_org: org }], ['tk_open_ticket', { p_org: org, p_id: randomUUID(), p_idem: randomUUID(), p_subject: 'anon', p_category: null, p_description: 'x', p_priority: null, p_requester: null, p_team: null, p_assignee: null, p_attachments: [] }],
    ['tk_dashboard', { p_org: org, p_from: '2026-01-01', p_to: '2026-01-31', p_team: null }], ['tk_export_rows', { p_org: org, p_filters: {} }], ['tk_people', { p_org: org }],
    ['tk_publish_sla', { p_org: org, p_timezone: 'UTC', p_calendar: {}, p_targets: {} }], ['tk_claim', { p_org: org, p_ticket: randomUUID() }],
  ];
  for (const [fn, args] of fns) {
    const r = await rpc(null, fn, args);
    expect(r.status, `${fn} não pode ser executável pelo anon`).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toMatch(/Suporte Aurora|VPN/);
  }
  for (const t of ['tickets', 'ticket_messages', 'ticket_attachments', 'ticket_events', 'teams', 'canned_responses', 'ticket_service_cycles', 'sla_policy_versions', 'notifications', 'mutation_requests', 'ticket_counters']) {
    const r = await table(null, `${t}?select=*&limit=3`);
    expect(r.rows, `${t} não pode devolver linhas ao anon (status ${r.status})`).toHaveLength(0);
    const w = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H(null), prefer: 'return=minimal' }, body: '{}' });
    expect(w.status).toBeGreaterThanOrEqual(400);
  }
  // Storage: o bucket é privado
  const s = await fetch(`${SUPABASE_URL}/storage/v1/object/public/tk-attachments/${org}/x/y.png`);
  expect(s.status).not.toBe(200);
});

test('solicitante pela API: só o que é dele; sem notas, eventos, SLA, equipes, exportação nem escrita direta', async () => {
  const tk = await token(DEMO.sol1);
  const org = await orgId();
  const own = await table<{ id: string; requester_user_id: string }>(tk, 'tickets?select=id,requester_user_id');
  expect(own.rows.length).toBeGreaterThan(0);
  expect(new Set(own.rows.map((r) => r.requester_user_id)).size).toBe(1);
  const all = await table<{ id: string }>(await token(DEMO.gestor), 'tickets?select=id');
  expect(all.rows.length).toBeGreaterThan(own.rows.length);
  for (const t of ['ticket_events', 'ticket_service_cycles', 'ticket_sla_pauses', 'teams', 'team_members', 'canned_responses', 'business_calendar_versions', 'sla_policy_versions', 'agent_status']) {
    expect((await table(tk, `${t}?select=*&limit=3`)).rows, `solicitante não lê ${t}`).toHaveLength(0);
  }
  const msgs = await table<{ visibility: string; author_kind: string }>(tk, 'ticket_messages?select=visibility,author_kind');
  expect(msgs.rows.length).toBeGreaterThan(0);
  expect(msgs.rows.every((m) => m.visibility === 'public')).toBe(true);
  // funções de equipe são negadas pelo perfil
  expect((await rpc(tk, 'tk_export_rows', { p_org: org, p_filters: {} })).status).toBeGreaterThanOrEqual(400);
  expect((await rpc(tk, 'tk_dashboard', { p_org: org, p_from: '2026-01-01', p_to: '2026-01-31', p_team: null })).status).toBeGreaterThanOrEqual(400);
  expect((await rpc(tk, 'tk_people', { p_org: org })).status).toBeGreaterThanOrEqual(400);
  expect((await rpc(tk, 'tk_claim', { p_org: org, p_ticket: own.rows[0]!.id })).status).toBeGreaterThanOrEqual(400);
  expect((await rpc(tk, 'tk_set_priority', { p_org: org, p_ticket: own.rows[0]!.id, p_priority: 'urgent', p_expected: null })).status).toBeGreaterThanOrEqual(400);
  expect((await rpc(tk, 'tk_post_message', { p_org: org, p_ticket: own.rows[0]!.id, p_idem: randomUUID(), p_visibility: 'internal', p_body: 'tentando nota', p_attachments: [], p_next_status: null, p_expected: null })).status).toBeGreaterThanOrEqual(400);
  // escrita direta nas tabelas: negada
  for (const [method, path, body] of [['PATCH', `tickets?id=eq.${own.rows[0]!.id}`, { status: 'resolved' }], ['DELETE', `tickets?id=eq.${own.rows[0]!.id}`, null], ['PATCH', 'ticket_messages?visibility=eq.public', { body: 'alterada' }], ['DELETE', 'ticket_messages?id=not.is.null', null], ['POST', 'notifications', { organization_id: org }]] as const) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(tk), prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    expect(r.status === 401 || r.status === 403 || text === '[]' || r.status === 404, `${method} ${path} → ${r.status} ${text.slice(0, 80)}`).toBe(true);
  }
  expect((await table<{ status: string }>(tk, `tickets?select=status&id=eq.${own.rows[0]!.id}`)).rows[0]!.status).not.toBe('resolved');
});

test('idempotência e versão otimista pela API (as mesmas regras do banco)', async () => {
  const tk = await token(DEMO.sol3);
  const org = await orgId();
  const id = randomUUID();
  const idem = randomUUID();
  const args = { p_org: org, p_id: id, p_idem: idem, p_subject: `E2E idempotência ${T}`, p_category: null, p_description: 'enviado duas vezes', p_priority: null, p_requester: null, p_team: null, p_assignee: null, p_attachments: [] };
  const a = await rpc(tk, 'tk_open_ticket', args);
  expect(a.status).toBe(200);
  const b = await rpc(tk, 'tk_open_ticket', args);
  expect(b.status).toBe(200);
  expect((b.body as { replayed: boolean; ticket_number: number }).replayed).toBe(true);
  expect((b.body as { ticket_number: number }).ticket_number).toBe((a.body as { ticket_number: number }).ticket_number);
  expect((await table<{ id: string }>(tk, `tickets?select=id&subject=eq.${encodeURIComponent(`E2E idempotência ${T}`)}`)).rows).toHaveLength(1);
  const c = await rpc(tk, 'tk_open_ticket', { ...args, p_description: 'outro conteúdo, mesma chave' });
  expect(c.status).toBeGreaterThanOrEqual(400);
  expect(c.text).toMatch(/outros dados/);
  // versão antiga: o gestor muda a prioridade com a versão correta e depois com a antiga
  const gt = await token(DEMO.gestor);
  const t = (await table<{ id: string; version: number }>(gt, `tickets?select=id,version&id=eq.${id}`)).rows[0]!;
  expect((await rpc(gt, 'tk_set_priority', { p_org: org, p_ticket: id, p_priority: 'high', p_expected: t.version })).status).toBeLessThan(300);
  const stale = await rpc(gt, 'tk_set_priority', { p_org: org, p_ticket: id, p_priority: 'urgent', p_expected: t.version });
  expect(stale.status).toBeGreaterThanOrEqual(400);
  expect(stale.text).toMatch(/alterado por outra pessoa/);
  expect((await table<{ priority: string }>(gt, `tickets?select=priority&id=eq.${id}`)).rows[0]!.priority).toBe('high');
});

test('números sequenciais sem repetição sob abertura concorrente', async () => {
  const org = await orgId();
  const tk = await token(DEMO.sol4);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc(tk, 'tk_open_ticket', { p_org: org, p_id: randomUUID(), p_idem: randomUUID(), p_subject: `E2E concorrente ${T} ${i}`, p_category: null, p_description: 'concorrente', p_priority: null, p_requester: null, p_team: null, p_assignee: null, p_attachments: [] })));
  expect(results.every((r) => r.status === 200)).toBe(true);
  const nums = results.map((r) => (r.body as { ticket_number: number }).ticket_number);
  expect(new Set(nums).size).toBe(10);
  expect(Math.max(...nums) - Math.min(...nums)).toBe(9);
});

test('XSS: HTML no assunto e na mensagem aparece como texto e nunca executa (tela, fila e CSV)', async ({ page, browser }) => {
  const evil = `<img src=x onerror="window.__xss=1"> ${T}`;
  const ctx = await browser.newContext();
  const sol = await ctx.newPage();
  await loginAs(sol, DEMO.sol1);
  await sol.goto('/chamados/novo');
  await sol.getByLabel('Assunto').fill(evil);
  await sol.getByLabel('Categoria').selectOption({ label: 'Dúvidas gerais' });
  await sol.getByLabel('Descrição').fill('<script>window.__xss=2</script> **negrito** [link](javascript:alert(1))');
  await sol.getByRole('button', { name: 'Abrir chamado' }).click();
  await sol.waitForURL(/\/chamados\/[0-9a-f-]{36}/);
  await ctx.close();
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await loginAs(page, DEMO.at1);
  for (const url of [`/chamados?q=${encodeURIComponent(T)}`, `/chamados?q=${encodeURIComponent(T)}&layout=board`]) {
    await page.goto(url);
    await expect(page.locator('a', { hasText: '<img src=x' }).locator('visible=true').first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  }
  await page.getByRole('link', { name: /<img src=x/ }).first().click();
  await expect(page.getByText('<script>window.__xss=2</script>')).toBeVisible();
  await expect(page.getByText('**negrito**')).toBeVisible(); // texto simples: Markdown não é interpretado
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('main img[src="x"]').count()).toBe(0);
  expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
  expect(dialogs).toEqual([]);
});

test('CSP estrita e cabeçalhos nas telas do sistema (sem estilo/script em linha)', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => violations.push(e.message));
  await loginAs(page, DEMO.gestor);
  for (const r of ['/dashboard', '/chamados', '/chamados?layout=board', '/chamados/novo', '/equipes', '/categorias', '/respostas-prontas', '/relatorios', '/notificacoes']) {
    const res = await page.goto(r);
    const h = res!.headers();
    expect(h['content-security-policy'], r).toMatch(/script-src 'self' 'nonce-/);
    expect(h['content-security-policy'], r).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(await page.locator('[style]:not(next-route-announcer):not(#__next-route-announcer__)').evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 160))), `${r}: sem atributo style em linha`).toEqual([]);
  }
  const first = (await table<{ id: string }>(await token(DEMO.gestor), 'tickets?select=id&limit=1')).rows[0]!.id;
  await page.goto(`/chamados/${first}`);
  expect(await page.locator('[style]:not(next-route-announcer):not(#__next-route-announcer__)').count(), 'detalhe do chamado sem style em linha').toBe(0);
  expect(violations, violations.join('\n')).toEqual([]);
  const dl = await fetch(`${BASE_URL}/api/anexos/${randomUUID()}`, { redirect: 'manual' });
  expect(dl.headers.get('cache-control') ?? '').toMatch(/no-store/);
});
