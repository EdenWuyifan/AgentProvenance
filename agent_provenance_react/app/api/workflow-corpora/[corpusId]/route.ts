import { workflowProxy } from '../../workflow_proxy';
export const dynamic = 'force-dynamic';
export async function GET(_: Request, context: { params: Promise<{ corpusId: string }> }) {
  const { corpusId } = await context.params;
  return workflowProxy(`api/workflow-corpora/${encodeURIComponent(corpusId)}`);
}
