"use client";

import {
  startTransition,
  useEffect,
  useRef,
  type ReactNode,
  useState,
} from "react";

import { SAMPLE_TOOL_SETS } from "./lib/sample-tool-sets";
import { renderUpsetPlot } from "./components/upset_plot";
import { parseTracingPayload } from "./components/visualization_shared";

type Tracing = {
  id: string | number;
  score?: number | null;
  [key: string]: unknown;
};

function useTracingData(path: string) {
  const [data, setData] = useState<Tracing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(path);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const text = await response.text();
        if (cancelled) {
          return;
        }

        const parsed = parseTracingPayload(text) as Tracing[];
        startTransition(() => {
          setData(parsed);
          setError(null);
          setLoading(false);
        });
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        const message =
          loadError instanceof Error
            ? loadError.message
            : "Unable to load traces";

        startTransition(() => {
          setData([]);
          setError(message);
          setLoading(false);
        });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, loading, error };
}

function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-950">
            {title}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-600">{description}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function StatusMessage({ message }: { message: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-6 py-10 text-sm text-zinc-600">
      {message}
    </div>
  );
}

export default function Home() {
  const upsetRef = useRef<HTMLDivElement | null>(null);

  const { data, loading, error } = useTracingData("/tracings.jsonl");

  useEffect(() => {
    const element = upsetRef.current;
    if (!element || loading || error || data.length === 0) {
      return;
    }

    const render = () => {
      renderUpsetPlot(element, data, SAMPLE_TOOL_SETS, {
        width: Math.max(element.clientWidth, 720),
      });
    };

    render();

    const observer = new ResizeObserver(render);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [data, error, loading]);

  return (
    <div className="min-h-screen bg-stone-100 px-4 py-10 text-zinc-950">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="px-1">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">
            AgentProvenance
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950">
            Trace explorer
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-600">
            Inspect tool provenance across runs in a single view.
          </p>
        </header>

        <Card
          title="Tool provenance"
          description="The matrix shows which tools appear in each trace."
        >
          {loading && <StatusMessage message="Loading traces…" />}
          {!loading && error && <StatusMessage message={error} />}
          {!loading && !error && data.length === 0 && (
            <StatusMessage message="No traces available." />
          )}
          {!loading && !error && data.length > 0 && (
            <div ref={upsetRef} className="w-full overflow-x-auto" />
          )}
        </Card>
      </main>
    </div>
  );
}
