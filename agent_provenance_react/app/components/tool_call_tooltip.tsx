'use client';

import type { ToolCall, Tracing } from './types';

export type ToolCallTooltipDetail = {
  traceId: Tracing['id'];
  traceLabel?: string;
  step: number;
  color: string;
  toolCall: ToolCall;
};

const LONG_STRING_LENGTH = 72;
const SINGLE_TOOLTIP_SIZE = { width: '13rem', height: '9rem' };
const MULTI_TOOLTIP_SIZE = { width: '18rem', height: '10rem' };

function summarizeString(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > LONG_STRING_LENGTH
    ? `${compact.slice(0, LONG_STRING_LENGTH)}...`
    : compact;
}

function renderScalar(value: string | number | boolean | null) {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return `"${value}"`;
  }

  return String(value);
}

function JsonField({
  name,
  value,
}: {
  name: string;
  value: unknown;
}) {
  if (value === undefined) {
    return null;
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return (
      <div className="text-[9px] leading-tight text-zinc-700">
        <span className="text-zinc-500">{name}:</span>{' '}
        {renderScalar(value)}
      </div>
    );
  }

  if (typeof value === 'string') {
    if (value.length <= LONG_STRING_LENGTH && !value.includes('\n')) {
      return (
        <div className="text-[9px] leading-tight text-zinc-700 break-all">
          <span className="text-zinc-500">{name}:</span>{' '}
          {renderScalar(value)}
        </div>
      );
    }

    return (
      <details className="text-[9px] leading-tight text-zinc-700">
        <summary className="nodrag nopan cursor-pointer break-all text-zinc-700">
          <span className="text-zinc-500">{name}:</span>{' '}
          &quot;{summarizeString(value)}&quot;
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[9px] leading-tight text-zinc-700">
          {value}
        </pre>
      </details>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="text-[9px] leading-tight text-zinc-700">
          <span className="text-zinc-500">{name}:</span> []
        </div>
      );
    }

    return (
      <details className="text-[9px] leading-tight text-zinc-700">
        <summary className="nodrag nopan cursor-pointer text-zinc-700">
          <span className="text-zinc-500">{name}:</span> [{value.length}]
        </summary>
        <div className="mt-1 space-y-1 pl-2">
          {value.map((item, index) => (
            <JsonField key={`${name}:${index}`} name={String(index)} value={item} />
          ))}
        </div>
      </details>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);

    if (entries.length === 0) {
      return (
        <div className="text-[9px] leading-tight text-zinc-700">
          <span className="text-zinc-500">{name}:</span> {'{}'}
        </div>
      );
    }

    return (
      <details className="text-[9px] leading-tight text-zinc-700">
        <summary className="nodrag nopan cursor-pointer text-zinc-700">
          <span className="text-zinc-500">{name}:</span> {'{'}{entries.length} fields{'}'}
        </summary>
        <div className="mt-1 space-y-1 pl-2">
          {entries.map(([key, item]) => (
            <JsonField key={`${name}:${key}`} name={key} value={item} />
          ))}
        </div>
      </details>
    );
  }

  return (
    <div className="text-[9px] leading-tight text-zinc-700 break-all">
      <span className="text-zinc-500">{name}:</span>{' '}
      {String(value)}
    </div>
  );
}

function ToolCallJson({ toolCall }: { toolCall: ToolCall }) {
  const fields: Array<[string, unknown]> = [
    ['name', toolCall.name] as [string, unknown],
    ['id', toolCall.id] as [string, unknown],
    ['status', toolCall.status] as [string, unknown],
    ['args', toolCall.args] as [string, unknown],
    ['response', toolCall.response] as [string, unknown],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');

  return (
    <div className="mt-1 space-y-1">
      {fields.map(([name, value]) => (
        <JsonField key={name} name={name} value={value} />
      ))}
    </div>
  );
}

function ToolCallTooltip({
  details,
  onClose,
}: {
  details: ToolCallTooltipDetail[];
  onClose: () => void;
}) {
  const horizontal =
    new Set(
      details
        .map((detail) => detail.traceLabel)
        .filter((traceLabel): traceLabel is string => Boolean(traceLabel))
    ).size > 1;

  return (
    <div
      className="nodrag nopan relative flex min-h-[4rem] min-w-[11rem] resize flex-col overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm"
      style={horizontal ? MULTI_TOOLTIP_SIZE : SINGLE_TOOLTIP_SIZE}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="nodrag nopan flex h-5 shrink-0 items-center justify-end border-b border-zinc-200 bg-zinc-50 px-1">
        <button
          type="button"
          aria-label="Close details"
          className="nodrag nopan inline-flex h-3.5 w-3.5 items-center justify-center text-zinc-400 transition hover:text-zinc-950"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1">
        <div
          className={horizontal ? 'grid gap-1 pr-4' : 'space-y-1 pr-4'}
          style={horizontal ? { gridTemplateColumns: `repeat(${details.length}, minmax(0, 1fr))` } : undefined}
        >
          {details.map((detail) => {
            const status =
              typeof detail.toolCall.status === 'string' ? detail.toolCall.status : null;

            return (
              <div
                key={`${detail.traceLabel}:${detail.traceId}:${detail.step}`}
                className={
                  horizontal
                    ? 'min-w-0 border-l border-zinc-200 pl-1 first:border-l-0 first:pl-0'
                    : 'border-t border-zinc-200 pt-1 first:border-t-0 first:pt-0'
                }
              >
                <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[9px] leading-tight">
                  {detail.traceLabel ? (
                    <span className="font-semibold" style={{ color: detail.color }}>
                      Trace {detail.traceLabel}
                    </span>
                  ) : null}
                  <span className="text-zinc-500">run #{String(detail.traceId)}</span>
                  <span className="text-zinc-500">step {detail.step}</span>
                  {status ? <span className="text-zinc-500">status: {status}</span> : null}
                </div>
                <ToolCallJson toolCall={detail.toolCall} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { ToolCallTooltip };
