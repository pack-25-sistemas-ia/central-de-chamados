'use client';

import { useId, useRef, useState } from 'react';
import { FormMessage, SubmitButton } from '@/components/ui/client';
import { postMessage } from '@/lib/tickets/actions/tickets';
import { cn } from '@/lib/utils';
import { ConflictNotice } from './fields';
import { useTkAction } from './use-tk-action';

type Canned = { id: string; title: string; body: string };

/**
 * Compositor com modos EXPLÍCITOS: «Resposta ao solicitante» (pública) e «Nota interna» (só equipe, aparência diferente).
 * Modelos prontos só preenchem o texto: nada é enviado sem revisão. O texto digitado é preservado se o envio falhar.
 */
export function Composer({ ticket, expected, staff, canned, canResolve, uploadLimitMb }: { ticket: string; expected: number; staff: boolean; canned: Canned[]; canResolve: boolean; uploadLimitMb: number }) {
  const [state, formAction, ref] = useTkAction(postMessage, { reset: true });
  const [mode, setMode] = useState<'public' | 'internal'>('public');
  const id = useId();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const internal = staff && mode === 'internal';
  const err = state.fieldErrors ?? {};

  return (
    <form ref={ref} action={formAction} noValidate aria-label="Responder ao chamado" className={cn('rounded-lg border p-4', internal ? 'border-warning bg-warning/10' : 'border-border bg-card')}>
      <input type="hidden" name="ticket" value={ticket} />
      <input type="hidden" name="expected" value={expected} />
      <input type="hidden" name="visibility" value={mode} />
      {staff ? (
        <div role="group" aria-label="Tipo de mensagem" className="mb-3 inline-flex rounded-md border border-border p-0.5 text-sm">
          <button type="button" aria-pressed={mode === 'public'} onClick={() => setMode('public')} className={cn('min-h-9 rounded px-3 font-medium', mode === 'public' ? 'bg-primary text-primary-foreground' : 'text-foreground')}>Resposta ao solicitante</button>
          <button type="button" aria-pressed={mode === 'internal'} onClick={() => setMode('internal')} className={cn('min-h-9 rounded px-3 font-medium', mode === 'internal' ? 'bg-warning text-white dark:text-black' : 'text-foreground')}>Nota interna</button>
        </div>
      ) : null}
      {internal ? <p className="mb-2 text-sm font-medium" role="note">🔒 Nota interna: visível somente para a equipe. O solicitante não a vê e ela não conta como resposta.</p> : null}
      {staff && !internal && canned.length > 0 ? (
        <div className="mb-3">
          <label htmlFor={`${id}c`} className="mb-1 block text-xs font-medium text-muted">Resposta pronta (preenche o texto; você revisa antes de enviar)</label>
          <select id={`${id}c`} className="min-h-10 w-full rounded-md border border-border bg-card px-2 text-sm" defaultValue="" onChange={(e) => {
            const c = canned.find((x) => x.id === e.target.value);
            if (c && area.current) { area.current.value = area.current.value ? `${area.current.value}\n\n${c.body}` : c.body; area.current.focus(); }
            e.target.value = '';
          }}>
            <option value="">— escolher modelo —</option>
            {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </div>
      ) : null}
      <label htmlFor={`${id}b`} className="sr-only">{internal ? 'Nota interna' : 'Mensagem'}</label>
      <textarea ref={area} id={`${id}b`} className="min-h-28 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted aria-[invalid=true]:border-danger" name="body" rows={5} maxLength={10000} required placeholder={internal ? 'Registre o que foi feito ou descoberto…' : staff ? 'Escreva a resposta para o solicitante…' : 'Escreva sua mensagem…'} aria-invalid={!!err.body} defaultValue={state.values?.body ?? ''} />
      {err.body?.[0] ? <p className="mt-1 text-xs text-danger" role="alert">{err.body[0]}</p> : null}
      <div className="mt-3">
        <label htmlFor={`${id}f`} className="mb-1 block text-xs font-medium text-muted">Anexos (até 3 · {uploadLimitMb} MB cada · imagem, PDF ou texto){internal ? ' — também ficam internos' : ''}</label>
        <input id={`${id}f`} name="file" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,.csv,.txt" className="block w-full text-sm" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {staff && !internal ? (
          <div>
            <label htmlFor={`${id}n`} className="sr-only">Ao enviar</label>
            <select id={`${id}n`} name="next" defaultValue="" className="min-h-10 rounded-md border border-border bg-card px-2 text-sm">
              <option value="">Somente responder</option>
              <option value="waiting_requester">Responder e pedir informação (pausa o SLA)</option>
              {canResolve ? <option value="resolved">Responder e resolver o chamado</option> : null}
            </select>
          </div>
        ) : null}
        <SubmitButton pendingText="Enviando…" variant={internal ? 'secondary' : 'primary'}>{internal ? 'Registrar nota interna' : staff ? 'Enviar resposta' : 'Enviar mensagem'}</SubmitButton>
        <FormMessage state={state} />
        <ConflictNotice state={state} />
      </div>
    </form>
  );
}
