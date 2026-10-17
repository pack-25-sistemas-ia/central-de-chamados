// Responsividade e acessibilidade básica: nenhuma tela estoura a largura, tem título, um h1, landmark principal e campos com nome acessível.
import { expect, test, type Page } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY } from './helpers';
import { DEMO, demoPassword, loginAs } from './tk-helpers';

test.describe.configure({ mode: 'serial' });

const STAFF = ['/dashboard', '/chamados', '/chamados?layout=board', '/chamados?view=overdue', '/chamados/novo', '/equipes', '/categorias', '/respostas-prontas', '/relatorios', '/configuracoes', '/notificacoes'];
const REQUESTER = ['/dashboard', '/chamados', '/chamados/novo', '/notificacoes'];

async function ticketPath(email: string, subject: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: demoPassword() }) });
  const tk = ((await res.json()) as { access_token: string }).access_token;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets?select=id&subject=ilike.*${encodeURIComponent(subject)}*&limit=1`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${tk}` } });
  return `/chamados/${((await r.json()) as Array<{ id: string }>)[0]!.id}`;
}

async function audit(page: Page, route: string) {
  const res = await page.goto(route);
  expect(res?.status(), route).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 1 }).first(), route).toBeVisible();
  const r = await page.evaluate(() => {
    const unnamed = [...document.querySelectorAll<HTMLInputElement>('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')].filter((el) => {
      const labelled = (el.labels && el.labels.length > 0) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      return !labelled;
    }).map((el) => `${el.tagName.toLowerCase()}#${el.id || el.getAttribute('name') || '?'}`);
    const unlabeledButtons = [...document.querySelectorAll<HTMLElement>('button, a[href]')].filter((el) => !(el.textContent ?? '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.querySelector('img[alt]:not([alt=""])')).length;
    const noAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length;
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      title: document.title.trim(),
      h1: document.querySelectorAll('h1').length,
      main: document.querySelectorAll('main, [role=main]').length,
      lang: document.documentElement.lang,
      unnamed, unlabeledButtons, noAlt,
    };
  });
  expect(r.overflow, `${route}: rolagem horizontal`).toBeLessThanOrEqual(1);
  expect(r.title.length, `${route}: título da página`).toBeGreaterThan(2);
  expect(r.h1, `${route}: exatamente um h1`).toBe(1);
  expect(r.main, `${route}: landmark principal`).toBeGreaterThanOrEqual(1);
  expect(r.lang, `${route}: idioma`).toMatch(/^pt/i);
  expect(r.unnamed, `${route}: campos sem nome acessível`).toEqual([]);
  expect(r.unlabeledButtons, `${route}: botões/links sem nome`).toBe(0);
  expect(r.noAlt, `${route}: imagens sem alt`).toBe(0);
}

test('celular (375 px): gestor percorre as telas sem rolagem horizontal e com estrutura acessível', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, DEMO.gestor);
  for (const r of STAFF.filter((x) => x !== '/configuracoes')) await audit(page, r);
  await audit(page, await ticketPath(DEMO.gestor, 'Sistema de pedidos'));
});

test('celular (375 px): proprietário abre as configurações (formulário de SLA) sem estourar a largura', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, DEMO.dono);
  await audit(page, '/configuracoes');
});

test('celular (375 px): atendente e solicitante percorrem o fluxo sem estourar a largura', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, DEMO.at1);
  for (const r of ['/dashboard', '/chamados', '/chamados?view=mine', '/notificacoes']) await audit(page, r);
  await audit(page, await ticketPath(DEMO.at1, 'Planilha de custos'));
  await loginAs(page, DEMO.sol4);
  for (const r of REQUESTER) await audit(page, r);
  await audit(page, await ticketPath(DEMO.sol4, 'Sistema de pedidos'));
});

test('tablet (768 px) e desktop largo (1440 px): painel, fila, quadro e chamado', async ({ page }) => {
  await loginAs(page, DEMO.gestor);
  const detail = await ticketPath(DEMO.gestor, 'Sistema de pedidos');
  for (const w of [768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const r of ['/dashboard', '/chamados', '/chamados?layout=board', '/equipes', detail]) await audit(page, r);
  }
});

test('teclado: o primeiro Tab leva a um controle visível', async ({ page }) => {
  await loginAs(page, DEMO.dono);
  await page.goto('/dashboard');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    return { visible: box.width > 0 && box.height > 0 };
  });
  expect(focused).not.toBeNull();
  expect(focused!.visible).toBe(true);
});
