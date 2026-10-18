"""Import a cooperative batch into local storage with a small browser manifest."""

import argparse
import json
from pathlib import Path
import sys

from .workflow_import import iter_batch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--label', default='Cooperative workflows')
    args = parser.parse_args()
    if args.manifest.resolve() in {p.resolve() for p in args.source.iterdir()}:
        raise ValueError('The manifest must not overwrite a source file.')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
    from workflow_store import save_corpus
    manifest = save_corpus(iter_batch(args.source, args.cache), args.label)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'corpusId': manifest['corpusId'], 'runs': len(manifest['traces']),
                      'events': sum(trace['eventCount'] for trace in manifest['traces']),
                      'manifest': str(args.manifest), 'newModelRequests': 0}))


if __name__ == '__main__':
    main()
