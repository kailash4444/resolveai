"""Build a compact, source-linked evidence graph for technician handoffs."""
from hashlib import sha256
import json
import re

from realapp.incident_time_machine import compare_history


_FAILED = re.compile(r"\b(failed|did not work|didn't work|unsuccessful|still (?:fails|broken|not working))\b", re.I)
_ASSIGNMENT = re.compile(r"(?im)^Assigned to\s*:\s*(.+?)\s+was\s+(.+?)\s*$")
_WORDS = re.compile(r"[a-z0-9]{3,}")
_STOP = {'about', 'after', 'again', 'also', 'and', 'are', 'been', 'before', 'but', 'can', 'could',
         'does', 'from', 'have', 'into', 'issue', 'just', 'more', 'not', 'that', 'the', 'their',
         'then', 'there', 'this', 'through', 'with', 'would', 'your'}


def _person_id(name: str, role: str) -> str:
    key = f"{role}:{name.strip().casefold()}"
    return f"person:{role}:{sha256(key.encode()).hexdigest()[:10]}"


def build_handoff_graph(case, candidates, knowledge_matches):
    nodes, edges, node_ids, edge_keys = [], [], set(), set()

    def node(identifier, kind, label, detail='', **extra):
        if identifier not in node_ids:
            nodes.append({'id': identifier, 'kind': kind, 'label': str(label)[:120],
                          'detail': str(detail)[:900], **extra})
            node_ids.add(identifier)
        return identifier

    def edge(source, target, relation, label):
        key = (source, target, relation)
        if source in node_ids and target in node_ids and key not in edge_keys:
            edges.append({'from': source, 'to': target, 'type': relation, 'label': label[:100]})
            edge_keys.add(key)

    ticket_id = f"ticket:{case.id}"
    node(ticket_id, 'ticket', case.ticket.id,
         f"{case.ticket.short_description}\n{case.ticket.service} · {case.ticket.state} · {case.ticket.priority}\n"
         f"{case.ticket.description[:420]}", service=case.ticket.service,
         state=case.ticket.state, priority=case.ticket.priority)

    customer_name = case.caller.strip() or 'Customer'
    customer_id = node(_person_id(customer_name, 'customer'), 'customer', customer_name,
                       'Customer who reported this incident.')
    edge(customer_id, ticket_id, 'reported', 'reported this issue')

    staff_by_name = {}

    def staff(name, detail=''):
        name = (name or '').strip()
        if not name or name.casefold() in {'empty', 'system', 'ticket history'}:
            return None
        key = name.casefold()
        if key not in staff_by_name:
            staff_by_name[key] = node(_person_id(name, 'staff'), 'technician', name,
                                      detail or 'Technician recorded in this incident.')
        return staff_by_name[key]

    assignee = staff(case.ticket.assigned_to, 'Current incident assignee.')
    if assignee:
        edge(assignee, ticket_id, 'assigned', 'currently assigned')

    failed_actions = []
    for index, attempt in enumerate(case.attempted_steps[:4]):
        identifier = node(f"attempt:{case.id}:{index}", 'action', f"Reported step {index + 1}", attempt,
                          outcome='failed' if _FAILED.search(attempt) else 'not recorded')
        edge(ticket_id, identifier, 'attempted', 'customer-reported troubleshooting')
        if _FAILED.search(attempt):
            failed_actions.append(attempt[:240])

    transcript = case.transcript[-4:]
    transcript_offset = max(0, len(case.transcript) - len(transcript))
    for index, turn in enumerate(transcript, start=transcript_offset):
        role = turn.speaker.casefold()
        speaker_name = turn.speaker_name.strip()
        identifier = node(f"transcript:{case.id}:{index}", 'transcript',
                          f"{turn.speaker}{f' · {speaker_name}' if speaker_name else ''}",
                          turn.text[:520], timestamp=turn.timestamp or '', source_label='Call transcript')
        if role == 'customer':
            edge(customer_id, identifier, 'said', 'customer statement')
        elif role == 'technician':
            person_id = staff(speaker_name or case.ticket.assigned_to)
            if person_id:
                edge(person_id, identifier, 'said', 'technician statement')
        edge(ticket_id, identifier, 'contains', 'conversation evidence')

    assignment_history = []
    for note in case.ticket.work_notes[-6:]:
        text = note.text.strip()
        if not text:
            continue
        failed = note.author_type in {'Technician', 'Customer'} and bool(_FAILED.search(text))
        identifier = node(f"note:{note.id}", 'failed_action' if failed else 'work_note',
                          f"{note.author_type} note · {note.author}", text[:600],
                          timestamp=note.created_at.isoformat(), outcome='explicit failure' if failed else 'outcome not stated',
                          source_label='Ticket work note')
        edge(ticket_id, identifier, 'records', 'work-note evidence')
        if note.author_type == 'Technician':
            person_id = staff(note.author)
            if person_id:
                edge(person_id, identifier, 'authored', 'recorded this action')
        elif note.author_type == 'Customer':
            edge(customer_id, identifier, 'commented', 'customer update')
        if failed:
            failed_actions.append(text[:240])
        assignment_match = _ASSIGNMENT.search(text)
        if assignment_match:
            new_owner, old_owner = (value.strip() for value in assignment_match.groups())
            if old_owner.casefold() != 'empty':
                prior_id = staff(old_owner, 'Previous assignee recorded in ticket history.')
                if prior_id:
                    edge(prior_id, ticket_id, 'previously_assigned', 'previously owned')
            if new_owner.casefold() != 'empty':
                new_id = staff(new_owner, 'Assignee recorded in ticket history.')
                if new_id:
                    edge(new_id, ticket_id, 'assigned_history', 'assignment history')
            assignment_history.append({'from': old_owner, 'to': new_owner,
                                       'evidence_id': identifier, 'timestamp': note.created_at.isoformat()})

    for index, match in enumerate(knowledge_matches[:4]):
        identifier = node(f"knowledge:{match.id}", 'knowledge', match.title, match.excerpt,
                          score=match.score, steps=match.steps[:8], source_label=match.id)
        edge(ticket_id, identifier, 'retrieved', f"retrieval match · {round(match.score * 100)}%")

    comparison = compare_history(case, candidates)
    case_by_id = {item.id: item for item in candidates}
    similar_ids = []
    query_terms = {word for word in _WORDS.findall(
        f"{case.issue_title} {case.ticket.short_description} {case.ticket.description[:500]}".casefold())
        if word not in _STOP}
    for match in comparison['matches'][:3]:
        similar = case_by_id.get(match['case_id'])
        if not similar:
            continue
        detail = f"Observed outcome: {match['outcome'].replace('_', ' ')}. Shared terms: {', '.join(match['similarity_terms'])}."
        if similar.ticket.resolution.strip():
            detail += f"\nRecorded resolution: {similar.ticket.resolution[:440]}"
        identifier = node(f"similar:{similar.id}", 'similar_case', match['ticket_id'], detail,
                          title=similar.ticket.short_description, state=match['state'], priority=match['priority'],
                          outcome=match['outcome'], similarity_terms=match['similarity_terms'],
                          created_at=match['created_at'], demo_dataset=match['demo_dataset'],
                          case_id=similar.id, source_label='Historical incident')
        edge(ticket_id, identifier, 'similar_to', f"same service · {', '.join(match['similarity_terms'][:4])}")
        similar_ids.append(identifier)
        transcript_hits = []
        for turn_index, turn in enumerate(similar.transcript):
            words = {word for word in _WORDS.findall(turn.text.casefold()) if word not in _STOP}
            overlap = len(query_terms & words)
            if overlap:
                transcript_hits.append((overlap, turn_index, turn))
        for _, turn_index, turn in sorted(transcript_hits, key=lambda item: (-item[0], item[1]))[:1]:
            transcript_id = node(f"related-transcript:{similar.id}:{turn_index}", 'transcript',
                f"{turn.speaker} · {match['ticket_id']}", turn.text[:420],
                timestamp=turn.timestamp or '', source_label='Transcript from comparable ticket',
                case_id=similar.id)
            edge(identifier, transcript_id, 'contains_conversation', 'related ticket transcript')

    return {
        'incident': {'id': case.id, 'ticket_id': case.ticket.id,
                     'title': case.ticket.short_description, 'service': case.ticket.service,
                     'state': case.ticket.state, 'priority': case.ticket.priority,
                     'assigned_to': case.ticket.assigned_to or 'Unassigned',
                     'assigned_user_id': case.ticket.assigned_user_id},
        'nodes': nodes,
        'edges': edges,
        'history': {'comparable_count': comparison['comparable_count'],
                    'status': comparison['status'], 'criteria': comparison['criteria'],
                    'limitations': comparison['limitations'], 'case_node_ids': similar_ids},
        'assignment_history': assignment_history,
        'failed_actions': list(dict.fromkeys(failed_actions))[:6],
        'counts': {'people': sum(item['kind'] in {'customer', 'technician'} for item in nodes),
                   'transcript_and_actions': sum(item['kind'] in {'transcript', 'action', 'work_note', 'failed_action'} for item in nodes),
                   'knowledge': sum(item['kind'] == 'knowledge' for item in nodes),
                   'similar_incidents': sum(item['kind'] == 'similar_case' for item in nodes)},
    }


def guidance_context(graph):
    return json.dumps({'incident': graph['incident'], 'nodes': graph['nodes'],
                       'failed_actions': graph['failed_actions'],
                       'comparison_limits': graph['history']['limitations']}, ensure_ascii=False)
