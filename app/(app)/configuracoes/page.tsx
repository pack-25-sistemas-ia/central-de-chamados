import type { Metadata } from 'next';
import { AreaF, ActionButton, FieldError, SelectF, TextF, TkForm } from '@/components/tk/fields';
import { LogoForm } from '@/components/tk/logo-form';
import { Section } from '@/components/tk/bits';
import { Card, PageHeader } from '@/components/ui/primitives';
import { cleanupOrphans, publishSla, saveBrand, saveRules } from '@/lib/tickets/actions/settings';
import { loadSlaPolicy } from '@/lib/tickets/data';
import { pageCtx } from '@/lib/tickets/page';
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/tickets/status';
import { formatDateBR } from '@/lib/sla/time';

export const metadata: Metadata = { title: 'Configurações' };

const DAYS = [['1', 'Segunda-feira'], ['2', 'Terça-feira'], ['3', 'Quarta-feira'], ['4', 'Quinta-feira'], ['5', 'Sexta-feira'], ['6', 'Sábado'], ['0', 'Domingo']] as const;
const ZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Fortaleza', 'America/Cuiaba', 'America/Belem', 'America/Rio_Branco', 'America/Noronha', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/Lisbon', 'Europe/London', 'Europe/Madrid', 'UTC'];

export default async function SettingsPage() {
  const c = await pageCtx(['owner']);
  const s = c.settings;
  const pol = await loadSlaPolicy(c.ctx, c.org);
  const { data: org } = await c.ctx.supabase.from('organization_settings').select('display_name').eq('organization_id', c.org).maybeSingle();
  const zone = pol?.calendar.timezone ?? s.timezone;
  const zones = ZONES.includes(zone) ? ZONES : [zone, ...ZONES];
  const weekly = pol?.calendar.definition.weekly ?? {};
  const closed = (pol?.calendar.definition.closed_dates ?? []).join('\n');
  const mb = String(Math.round((s.attachment_max_size_bytes / 1024 / 1024) * 100) / 100).replace('.', ',');

  return (
    <>
      <PageHeader title="Configurações" description="Marca, regras de reabertura e anexos, expediente e metas de SLA. Mudanças de SLA valem para os PRÓXIMOS ciclos de atendimento." />

      <Section title="Marca">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Nome e cor">
            <TkForm action={saveBrand} submit="Salvar marca" reset={false} className="grid gap-4">
              <>
                <TextF name="display_name" label="Nome exibido" def={s.public_display_name ?? (org as { display_name?: string } | null)?.display_name ?? c.ctx.membership.name} required max={80} />
                <label className="flex flex-col gap-1 text-sm font-medium">Cor principal
                  <input type="color" name="primary_color" defaultValue={s.primary_color} className="h-10 w-24 rounded-md border border-border bg-card p-1" />
                </label>
                <FieldError name="primary_color" />
              </>
            </TkForm>
          </Card>
          <Card title="Logotipo" description="PNG, JPG ou WebP de até 512 KB. SVG não é aceito (pode carregar scripts).">
            <LogoForm hasLogo={!!s.logo_path} />
          </Card>
        </div>
      </Section>

      <Section title="Regras de atendimento">
        <Card>
          <TkForm action={saveRules} submit="Salvar regras" reset={false}>
            <>
              <TextF name="reopen_window_hours" label="Janela de reabertura (horas)" def={String(s.reopen_window_hours)} type="number" inputMode="numeric" required hint="Contada a partir da resolução. 0 = nunca reabre; fora da janela, o solicitante abre um novo chamado." />
              <TextF name="attachment_max_mb" label="Tamanho máximo por anexo (MB)" def={mb} inputMode="decimal" required hint="Até 10 MB (limite de segurança)." />
              <AreaF name="retention_policy_text" label="Política de retenção e exclusão (texto exibido à equipe)" def={s.retention_policy_text} max={1000} hint="Este sistema não exclui chamados pela interface. Descreva por quanto tempo guarda os dados e como atende pedidos de exclusão/anonimização (veja docs/SECURITY.md)." />
            </>
          </TkForm>
        </Card>
      </Section>

      <Section title="Expediente e metas de SLA" description={pol ? `Versão vigente publicada em ${formatDateBR(pol.created_at.slice(0, 10))} (${pol.versions} versão(ões) no histórico, todas preservadas). Valores iniciais são DEMONSTRATIVOS e editáveis: não são compromisso universal.` : undefined}>
        <Card>
          <TkForm action={publishSla} submit="Publicar nova versão" pending="Publicando…" reset={false}>
            <>
              <SelectF name="timezone" label="Fuso horário do expediente" def={zone} opts={zones.map((z) => ({ value: z, label: z }))} span hint="O expediente é interpretado neste fuso; instantes são guardados em UTC." />
              <fieldset className="min-w-0 sm:col-span-4">
                <legend className="mb-2 text-sm font-medium">Expediente semanal (até 3 intervalos por dia; deixe em branco o que não existe)</legend>
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <caption className="sr-only">Expediente semanal</caption>
                    <tbody>
                      {DAYS.map(([d, label]) => {
                        const rows = weekly[d] ?? [];
                        return (
                          <tr key={d} className="border-t border-border">
                            <th scope="row" className="py-2 pr-3 text-left font-normal">{label}</th>
                            {[1, 2, 3].map((i) => (
                              <td key={i} className="px-1 py-1">
                                <span className="flex items-center gap-1">
                                  <label className="sr-only" htmlFor={`d${d}_s${i}`}>{label}, intervalo {i}, início</label>
                                  <input id={`d${d}_s${i}`} name={`d${d}_s${i}`} defaultValue={rows[i - 1]?.[0] ?? ''} placeholder="09:00" maxLength={5} className="min-h-10 w-20 rounded-md border border-border bg-card px-2" />
                                  <span aria-hidden>–</span>
                                  <label className="sr-only" htmlFor={`d${d}_e${i}`}>{label}, intervalo {i}, fim</label>
                                  <input id={`d${d}_e${i}`} name={`d${d}_e${i}`} defaultValue={rows[i - 1]?.[1] ?? ''} placeholder="12:00" maxLength={5} className="min-h-10 w-20 rounded-md border border-border bg-card px-2" />
                                </span>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <FieldError name="d1_s1" />
              </fieldset>
              <div className="sm:col-span-4"><AreaF name="closed_dates" label="Dias sem expediente (feriados)" def={closed} max={8000} hint="Uma data por linha, AAAA-MM-DD. Não há integração automática de feriados no MVP." /></div>
              <fieldset className="min-w-0 sm:col-span-4">
                <legend className="mb-2 text-sm font-medium">Metas por prioridade (minutos ÚTEIS)</legend>
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-sm">
                    <caption className="sr-only">Metas de SLA por prioridade</caption>
                    <thead><tr><th scope="col" className="py-1 text-left text-xs font-medium text-muted">Prioridade</th><th scope="col" className="text-left text-xs font-medium text-muted">Primeira resposta</th><th scope="col" className="text-left text-xs font-medium text-muted">Resolução</th></tr></thead>
                    <tbody>
                      {PRIORITIES.map((p) => (
                        <tr key={p} className="border-t border-border">
                          <th scope="row" className="py-2 pr-3 text-left font-normal">{PRIORITY_LABEL[p]}</th>
                          <td className="px-1 py-1"><label className="sr-only" htmlFor={`t_${p}_first_response`}>{PRIORITY_LABEL[p]}: primeira resposta (min úteis)</label><input id={`t_${p}_first_response`} name={`t_${p}_first_response`} type="number" min={1} defaultValue={pol?.targets[p]?.first_response ?? ''} className="min-h-10 w-28 rounded-md border border-border bg-card px-2" /></td>
                          <td className="px-1 py-1"><label className="sr-only" htmlFor={`t_${p}_resolution`}>{PRIORITY_LABEL[p]}: resolução (min úteis)</label><input id={`t_${p}_resolution`} name={`t_${p}_resolution`} type="number" min={1} defaultValue={pol?.targets[p]?.resolution ?? ''} className="min-h-10 w-28 rounded-md border border-border bg-card px-2" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <FieldError name="t_normal_first_response" />
                <p className="mt-2 text-xs text-muted">Primeira resposta = primeira mensagem PÚBLICA da equipe (nota interna, mensagem automática e abertura administrativa não contam). A pausa acontece enquanto o chamado aguarda o solicitante.</p>
              </fieldset>
            </>
          </TkForm>
        </Card>
      </Section>

      <Section title="Manutenção">
        <Card title="Uploads órfãos" description="Arquivos enviados que nunca foram vinculados a uma mensagem (ex.: o envio falhou no meio). Só são removidos órfãos com mais de 2 horas; anexos vinculados nunca são tocados.">
          <ActionButton action={cleanupOrphans} fields={{}} label="Limpar uploads órfãos" confirm="Remover os uploads órfãos agora?" pending="Limpando…" />
        </Card>
      </Section>
    </>
  );
}
