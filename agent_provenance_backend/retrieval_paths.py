"""Recover literal event paths from evidence-unit sources to recorded inputs."""

from evidence_context import is_transport

def input_path(prepared, source, target):
    """Return (ordered original event IDs, original link rows), or None."""
    owner = prepared['contextRetriever'].owner
    root = owner[source]
    direct = [link for link in prepared['incoming'][target] if not link['inferred']]
    direct.sort(key=lambda link: link['source'] != source)

    for input_link in direct:
        endpoint = input_link['source']
        if endpoint not in owner or owner[endpoint] != root:
            continue
        chain = []
        while endpoint != root:
            parents = [link for link in prepared['incoming'][endpoint]
                       if is_transport(link) and not link['inferred'] and owner[link['source']] == root
                       and prepared['callById'][link['source']].get('round') is not None
                       and prepared['callById'][link['source']].get('round')
                       == prepared['callById'][endpoint].get('round')]
            if len(parents) != 1:
                break
            link = parents[0]
            chain.insert(0, link)
            endpoint = link['source']
        if endpoint == root:
            event_ids = [root, *(link['target'] for link in chain), target]
            return event_ids, [*chain, input_link]

    literal = next((link for link in direct if link['source'] == source), None)
    if literal:
        return [source, target], [literal]
    return None
